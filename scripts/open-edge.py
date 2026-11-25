#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
"""Open local PPSSPW in an isolated Linux Chromium/Edge profile with a chosen GPU backend."""
import argparse
import http.client
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from edge_launcher import (
    BACKENDS,
    DEFAULT_BACKEND,
    build_launch_env,
    find_browser,
    validate_backend_ready,
)

HOST = "127.0.0.1"
DEFAULT_PORT = 17881


def player_ready(port):
    connection = http.client.HTTPConnection(HOST, port, timeout=2)
    try:
        connection.request("GET", "/")
        response = connection.getresponse()
        body = response.read()
        if response.status != 200 or (b"<app-root>" not in body and b'id="idleStartBtn"' not in body):
            raise SystemExit(f"{port} 端口上已有其他服务，请检查 PPSSPW 本地服务。")
        return True
    except ConnectionRefusedError:
        return False
    finally:
        connection.close()


def start_service(port):
    if player_ready(port):
        return
    dist_index = ROOT / "wasm-page/dist/ppsspp-web/index.html"
    if not dist_index.is_file():
        raise SystemExit("缺少构建产物 wasm-page/dist/ppsspp-web/index.html，请先运行 pnpm --dir wasm-page run build:pages")
    log = Path.home() / ".local/share/ppsspw/player-launcher.log"
    log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with log.open("ab") as output:
        service = subprocess.Popen(
            [sys.executable, "-u", str(ROOT / "server/serve-player.py"),
             "--bind", HOST, "--port", str(port), "--edge-launcher"],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True,
        )
    for _ in range(100):
        if player_ready(port):
            return
        if service.poll() is not None:
            break
        time.sleep(0.1)
    raise SystemExit(f"PPSSPW 本地服务启动失败，详情见 {log}")


def focus_game_window(profile):
    xdotool = shutil.which("xdotool")
    if not xdotool or not os.environ.get("DISPLAY"):
        return False
    try:
        hostname, _, pid = (profile / "SingletonLock").readlink().name.rpartition("-")
        if hostname != os.uname().nodename or not pid.isdigit():
            return False
        command = (Path("/proc") / pid / "cmdline").read_bytes()
        if os.fsencode(f"--user-data-dir={profile}") not in command:
            return False
        windows = subprocess.run(
            [xdotool, "search", "--all", "--pid", pid, "--name", "PPSSPW"],
            capture_output=True, text=True, timeout=2,
        ).stdout.splitlines()
        return bool(windows) and subprocess.run(
            [xdotool, "windowactivate", windows[-1]], capture_output=True, timeout=2,
        ).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--backend", "-b",
        choices=tuple(BACKENDS),
        default=DEFAULT_BACKEND,
        help="图形后端预设（默认 opengl）",
    )
    parser.add_argument(
        "--port", type=int, default=DEFAULT_PORT,
        help="本机播放器服务端口（默认 17881）",
    )
    parser.add_argument(
        "--browser",
        choices=("auto", "edge", "chrome", "chromium"),
        default="auto",
        help="使用的浏览器内核",
    )
    args = parser.parse_args()
    err = validate_backend_ready(args.backend)
    if err:
        raise SystemExit(err)
    browser = find_browser(args.browser)
    if not browser or sys.platform != "linux":
        raise SystemExit("此启动器需要 Linux 桌面环境下的 Edge / Chrome / Chromium。")
    start_service(args.port)

    spec = BACKENDS[args.backend]
    data = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    profile = data / "ppsspw" / spec["profile_dir"]
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    if focus_game_window(profile):
        return

    env = build_launch_env(args.backend)
    os.execve(browser, [
        browser, f"--user-data-dir={profile}",
        *spec["flags"],
        "--no-first-run", "--no-default-browser-check",
        f"--app=http://{HOST}:{args.port}/",
    ], env)


if __name__ == "__main__":
    main()
