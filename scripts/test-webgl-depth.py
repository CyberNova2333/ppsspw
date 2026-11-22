#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# /// script
# requires-python = ">=3.10"
# dependencies = ["selenium>=4.20,<5", "Pillow>=10"]
# ///
"""Check signed PSP depth on a dedicated Android emulator running Firefox."""
import argparse
from io import BytesIO
import json
from pathlib import Path
import shlex
import subprocess
import sys
from time import monotonic, sleep
from uuid import uuid4

from PIL import Image, ImageStat
from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.remote.file_detector import UselessFileDetector
from selenium.webdriver.support.ui import WebDriverWait


def sample_quads(png):
    image = Image.open(BytesIO(png)).convert("RGB")
    width, height = image.size
    # PPSSPP fits the 480 x 272 PSP display inside the canvas.
    display_width = min(width, height * 480 / 272)
    samples = {}
    for name, offset in (("front", -.22), ("overlap", 0), ("rear", .22)):
        x, y = round(width / 2 + display_width * offset), height // 2
        samples[name] = ImageStat.Stat(image.crop((x - 2, y - 2, x + 3, y + 3))).median
    return samples


def color_matches(rgb, expected):
    return all(abs(a - b) <= 35 for a, b in zip(rgb, expected))


def capture(driver, screenshot):
    red, green = (255, 0, 0), (0, 255, 0)
    WebDriverWait(driver, 90).until(lambda d: d.execute_script(
        "return window.readPpssppCorePerformance?.(window.Module)?.emulatedUs > 1e6"), "PSP core did not start")
    canvas = driver.find_element(By.ID, "canvas")
    deadline = monotonic() + 30
    while True:
        png = canvas.screenshot_as_png
        samples = sample_quads(png)
        if color_matches(samples["front"], green) and color_matches(samples["rear"], red):
            result = "pass" if color_matches(samples["overlap"], green) else "wrong-occlusion"
            break
        if monotonic() >= deadline:
            result = "fixture-controls-missing"
            break
        sleep(.25)
    if screenshot:
        screenshot.write_bytes(png)
    print(json.dumps({"result": result, "pixels": samples}))
    return {"pass": 0, "wrong-occlusion": 1, "fixture-controls-missing": 2}[result]


def run(args):
    adb = ["adb", "-s", args.android_serial]
    remote = f"/data/local/tmp/depth-{uuid4().hex}.iso"
    options = webdriver.FirefoxOptions()
    options.enable_mobile(android_package=args.package, device_serial=args.android_serial)
    service = Service(executable_path=args.geckodriver, service_args=["--android-storage", "internal"])
    subprocess.run([*adb, "push", args.fixture, remote], check=True, stdout=sys.stderr)
    try:
        with webdriver.Firefox(options=options, service=service) as driver:
            driver.file_detector = UselessFileDetector()
            # Firefox automation can start in a zero-sized about:blank tab.
            intent = ["am", "start", "-a", "android.intent.action.VIEW", "-d", args.url, "-p", args.package]
            subprocess.run([*adb, "shell", shlex.join(intent)], check=True, stdout=sys.stderr)

            def visible_player(d):
                for handle in d.window_handles:
                    d.switch_to.window(handle)
                    if d.current_url.rstrip("/") != args.url.rstrip("/"):
                        continue
                    if d.execute_script("return innerWidth > 0 && !document.hidden && typeof opfsRead === 'function'"):
                        return True
                return False

            WebDriverWait(driver, 45).until(visible_player, "No visible Firefox player tab")
            # Navigate the visible tab after Firefox finishes its initial Android intent.
            driver.get(args.url)
            wait = WebDriverWait(driver, 30)
            wait.until(lambda d: d.execute_script("return typeof opfsRead === 'function'"))
            driver.find_element(By.ID, "gameFile").send_keys(remote)
            wait.until(lambda d: d.execute_script(
                "return document.querySelector('#gameFile').files[0]?.name === arguments[0]",
                remote.rsplit("/", 1)[-1]))
            print("Starting the selected fixture", file=sys.stderr, flush=True)
            button = driver.find_element(By.ID, "idleStartBtn")
            driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", button)
            point = wait.until(lambda d: d.execute_script("""
                const e = arguments[0], r = e.getBoundingClientRect();
                const x = r.left + r.width / 2, y = r.top + r.height / 2;
                if (e.disabled || !e.contains(document.elementFromPoint(x, y))) return null;
                return [Math.round((mozInnerScreenX + x) * devicePixelRatio),
                        Math.round((mozInnerScreenY + y) * devicePixelRatio)];
            """, button), "Start control is not tappable")
            subprocess.run([*adb, "shell", "input", "tap", *map(str, point)], check=True)
            return capture(driver, args.screenshot)
    finally:
        subprocess.run([*adb, "shell", "rm", "-f", remote], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="packaged player URL reachable from the emulator")
    parser.add_argument("fixture", type=Path, help="homebrew reversed-depth.iso")
    parser.add_argument("--android-serial", required=True)
    parser.add_argument("--package", default="org.mozilla.firefox")
    parser.add_argument("--geckodriver", required=True, help="path to geckodriver on the host")
    parser.add_argument("--screenshot", type=Path)
    try:
        sys.exit(run(parser.parse_args()))
    except (WebDriverException, subprocess.SubprocessError, OSError) as error:
        print(f"Setup or capture failed: {error}", file=sys.stderr)
        sys.exit(2)
