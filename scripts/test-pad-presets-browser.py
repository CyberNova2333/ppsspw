#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
"""Exercise screen controller editing in a fresh browser context against a built player."""
import argparse

from playwright.sync_api import expect, sync_playwright


def exercise(page, url):
    page.goto(url)
    page.wait_for_function("typeof initializeTouchGamepad === 'function'")
    ui = page.locator

    def open_settings():
        if not page.locator("body.panel-open").count():
            ui("#panelToggleBtn").click()
        ui("#panelTabSettings").click()

    def saved():
        return page.evaluate("JSON.parse(localStorage.getItem('ppsspw.touch-presets.v1'))")

    open_settings()
    ui("#padEdit").click()
    original_count = ui("#padSelection option").count()
    ui("#padAdd").click()
    ui("#padBinding").select_option("key:KeyZ")
    ui("#padSize").fill("65")
    node = ui(".pad-edit-key[aria-pressed=true]")
    bounds = node.bounding_box()
    x, y = bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 30, y - 15, steps=4)
    page.mouse.up()
    ui("#padName").fill("测试布局")
    ui("#padSave").click()
    expect(ui("#padEditor")).not_to_be_visible()
    preset = saved()["presets"][0]
    button = preset["controls"][-1]
    assert button["binding"] == "key:KeyZ" and button["size"] == 65
    assert button["x"] > .5 and button["y"] < .5

    page.reload()
    open_settings()
    expect(ui("#padPreset")).to_have_value(preset["id"])
    ui("#padEdit").click()
    expect(ui("#padSelection option")).to_have_count(original_count + 1)
    ui("#padRemove").click()
    ui("#padCancel").click()
    assert saved()["presets"] == [preset]

    ui("#padEdit").click()
    ui("#padName").fill("测试副本")
    ui("#padCopy").click()
    expect(ui("#padEditor")).not_to_be_visible()
    assert len(saved()["presets"]) == 2
    ui("#padEdit").click()
    for _ in range(original_count + 1):
        ui("#padRemove").click()
    expect(ui("#padSelection")).to_be_disabled()
    ui("#padSave").click()
    expect(ui("#padEditor")).not_to_be_visible()
    expect(ui("#touchGamepad [data-pad-button]")).to_have_count(0)
    page.once("dialog", lambda dialog: dialog.accept())
    ui("#padDeletePreset").click()
    expect(ui("#padPreset")).to_have_value("")
    assert saved()["presets"] == [preset]
    assert ui("#touchGamepad [data-pad-stick]").count() == 1

    ui("#padPreset").select_option(preset["id"])
    ui("#padEdit").click()
    page.evaluate("""() => {
      Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
    }""")
    ui("#padName").fill("写入失败")
    ui("#padSave").click()
    expect(ui("#padEditorStatus")).to_contain_text("未保存")
    expect(ui("#padEditor")).to_be_visible()
    assert saved()["presets"] == [preset]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--chromium", help="path to an installed Chromium executable")
    args = parser.parse_args()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.chromium)
        exercise(browser.new_page(viewport={"width": 1100, "height": 720}), args.url)
        browser.close()
    print("Screen controller preset checks passed")
