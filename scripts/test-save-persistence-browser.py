#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
"""Check durable saves in two fresh Chromium tabs using a bootable PSP test fixture."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def boot(page, url, fixture):
    page.bring_to_front()
    page.goto(url)
    page.wait_for_function("typeof refreshStateSlot === 'function'")
    page.locator("#gameFile").set_input_files(fixture)
    if page.locator("body.panel-open").count():
        page.locator("#panelCloseBtn").click()
    page.locator("#idleStartBtn").click()
    page.wait_for_function("window.Module && readPpssppCorePerformance(Module)?.emulatedUs > 1e6",
                           timeout=60000)


def open_slots(page):
    page.bring_to_front()
    if not page.locator("body.panel-open").count():
        page.locator("#panelToggleBtn").click()
    page.locator("#panelTabSaves").click()
    expect(page.locator("#stateSlotSelect")).to_be_enabled()


def slot_hash(page, path):
    return page.evaluate("""async path => Array.from(new Uint8Array(
      await crypto.subtle.digest('SHA-256', await opfsRead(path))
    ), byte => byte.toString(16).padStart(2, '0')).join('')""", path)


def concurrent_saves(context, url, fixture):
    first, second = context.new_page(), context.new_page()
    boot(first, url, fixture)
    boot(second, url, fixture)
    open_slots(first)
    expect(first.locator("#stateSlotLoad")).to_be_disabled()
    first.locator("#stateSlotSave").click()
    expect(first.locator("#stateSlotStatus")).to_contain_text("可以刷新", timeout=20000)
    path = first.evaluate("selectedStateSlot.path")
    original = slot_hash(first, path)

    open_slots(second)
    second.locator("#stateSlotSave").click()
    expect(second.locator("#stateSlotStatus")).to_contain_text("另一标签页", timeout=20000)
    assert slot_hash(second, path) == original
    blocked = second.evaluate("""async path => {
      const jpg = path.slice(0, -5) + '.jpg';
      FS.writeFile(jpg, Uint8Array.of(1, 2));
      try {
        const sync = await persistFiles(FS, 'stale auto');
        let deleted = false, imported = false;
        try { await withSaveStorage(() => removeSaveFiles([path])); deleted = true; } catch {}
        try { await importSavesBundle({files:[{path:jpg, data:btoa('stale')}]}, 'stale'); imported = true; } catch {}
        return {conflict: sync.conflict, deleted, imported};
      } finally { FS.unlink(jpg); }
    }""", path)
    assert blocked == {"conflict": True, "deleted": False, "imported": False}, blocked
    second.locator("#stateSlotSelect").select_option("1")
    second.locator("#stateSlotSave").click()
    expect(second.locator("#stateSlotStatus")).to_contain_text("第 2 槽已保存到本机，可以刷新", timeout=20000)
    assert slot_hash(second, path) == original
    # The stale tab still has its own empty live slot. Loading and previewing
    # it must identify the revision conflict before dispatching to the core.
    second.locator("#stateSlotSelect").select_option("0")
    second.wait_for_function("!slotBusy")
    expect(second.locator("#stateSlotPreview")).to_contain_text("另一标签页")
    second.evaluate("() => runStateSlotAction(false)")
    expect(second.locator("#stateSlotStatus")).to_contain_text("另一标签页")
    first.close()

    # Recreate the runtime with just the same image. Load the winner's actual slot.
    boot(second, url, fixture)
    open_slots(second)
    second.locator("#stateSlotSelect").select_option("0")
    expect(second.locator("#stateSlotLoad")).to_be_enabled()
    second.locator("#stateSlotLoad").click()
    expect(second.locator("#stateSlotStatus")).to_contain_text("已读取第 1 槽", timeout=20000)
    assert slot_hash(second, path) == original
    third = context.new_page()
    boot(third, url, fixture)
    open_slots(third)
    third.locator("#stateSlotSelect").select_option("0")
    third.wait_for_function("selectedStateSlot.slot === 0 && !slotBusy")
    open_slots(second)
    second.locator("#stateSlotSelect").select_option("0")
    second.wait_for_function("selectedStateSlot.slot === 0 && !slotBusy")
    second.once("dialog", lambda dialog: dialog.accept())
    second.locator("#stateSlotSave").click()
    expect(second.locator("#stateSlotStatus")).to_contain_text("可以刷新", timeout=20000)
    assert slot_hash(second, path) != original
    third.bring_to_front()
    third.evaluate("() => refreshStateSlot()")
    expect(third.locator("#stateSlotPreview")).to_contain_text("另一标签页")
    old_live = third.evaluate("""async path => Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256', FS.readFile(path))), b => b.toString(16).padStart(2, '0')).join('')""", path)
    assert old_live == original
    third.evaluate("""() => {
      const request = window.requestStateSlot;
      window.loadDispatched = false;
      window.requestStateSlot = (...args) => {
        if (args[0] === slotAction.load) window.loadDispatched = true;
        return request(...args);
      };
    }""")
    third.locator("#stateSlotLoad").click()
    expect(third.locator("#stateSlotStatus")).to_contain_text("另一标签页")
    assert not third.evaluate("window.loadDispatched")
    third.close()
    print("Concurrent saves: first slot preserved across refresh and native load; second slot writable")
    return second


NATIVE_DIR = "/home/web_user/.config/ppsspp/PSP/SAVEDATA/AUDIT_TEST"


def assert_group(page, expected):
    values = page.evaluate("""async root => {
      const result = [];
      for (const name of ['A.bin', 'B.bin']) {
        const path = root + '/' + name;
        result.push([new TextDecoder().decode(await opfsRead(path)),
                     new TextDecoder().decode(FS.readFile(path))]);
      }
      return result;
    }""", NATIVE_DIR)
    assert values == [[expected, expected], [expected, expected]], values


def import_group(page, contents):
    return page.evaluate("""async ([root, value]) => {
      const files = ['A.bin','B.bin'].map(name => ({path: root + '/' + name, data: btoa(value)}));
      try { await importSavesBundle({files}, 'regression'); return 'ok'; }
      catch (error) { return error.name; }
    }""", [NATIVE_DIR, contents])


def exercise_storage(page, url, fixture):
    assert import_group(page, "old") == "ok"
    result = page.evaluate("""async root => {
      const read = FS.readdir;
      FS.readdir = function(path, ...args) {
        if (path === root) throw Error('directory temporarily unreadable');
        return read.call(this, path, ...args);
      };
      try { return await persistFiles(FS, 'scan regression'); }
      finally { FS.readdir = read; }
    }""", NATIVE_DIR)
    assert result["failed"] and result["removed"] == 0, result
    boot(page, url, fixture)
    assert_group(page, "old")

    page.evaluate("""root => {
      const put = window.opfsPut;
      window.opfsPut = async (path, data) => {
        if (path === root + '/B.bin') throw new DOMException('test quota', 'QuotaExceededError');
        return put(path, data);
      };
    }""", NATIVE_DIR)
    assert import_group(page, "new") == "QuotaExceededError"
    assert_group(page, "old")
    boot(page, url, fixture)
    assert_group(page, "old")

    for fail_at in ('A.bin', 'B.bin'):
        result = page.evaluate("""async ([root, name]) => {
          for (const file of ['A.bin', 'B.bin', 'added.bin']) FS.writeFile(root + '/' + file, new TextEncoder().encode('updated'));
          const put = window.opfsPut;
          window.opfsPut = async (p, bytes) => {
            if (p === root + '/' + name) throw new Error('test storage failure');
            return put(p, bytes);
          };
          try { return await persistFiles(FS, 'group rollback'); }
          finally { window.opfsPut = put; }
        }""", [NATIVE_DIR, fail_at])
        assert result['failed'], result
        boot(page, url, fixture)
        assert_group(page, "old")
        assert page.evaluate("async p => (await existingSaveFile(p)) === null", NATIVE_DIR + "/added.bin")

    assert page.evaluate("""async root => {
      const read = FS.readdir;
      FS.readdir = function(path) {
        if (path === root) throw new FS.ErrnoError(29);
        return read.apply(this, arguments);
      };
      try { await withSaveStorage(buildSavesBundle); return false; }
      catch (e) { return e.errno === 29; }
      finally { FS.readdir = read; }
    }""", NATIVE_DIR)

    # Writes and deletions from the same generation share one rollback record.
    result = page.evaluate("""async root => {
      FS.writeFile(root + '/A.bin', new TextEncoder().encode('updated'));
      FS.unlink(root + '/B.bin');
      const del = window.opfsDelete;
      window.opfsDelete = p => { if (p === root + '/B.bin') throw Error('test delete'); return del(p); };
      try { return await persistFiles(FS, 'delete failure'); }
      finally { window.opfsDelete = del; }
    }""", NATIVE_DIR)
    assert result['failed']
    boot(page, url, fixture)
    assert_group(page, "old")

    # Suspend the *actual* second disk write and destroy the document. The new
    # document must recover using only durable journal data before loading MEMFS.
    page.evaluate("""root => {
      const put = window.opfsPut;
      window.opfsPut = async (path, bytes) => {
        if (path === root + '/B.bin') {
          window.secondWriteReached = true;
          return new Promise(() => {});
        }
        return put(path, bytes);
      };
      const files = ['extra.bin','A.bin','B.bin'].map(name => ({path: root + '/' + name, data: btoa('new')}));
      void importSavesBundle({files}, 'interrupted');
    }""", NATIVE_DIR)
    page.wait_for_function("window.secondWriteReached === true")
    assert page.evaluate("async path => new TextDecoder().decode(await opfsRead(path))", NATIVE_DIR + "/A.bin") == "new"
    boot(page, url, fixture)
    assert_group(page, "old")

    assert page.evaluate("async path => (await existingSaveFile(path)) === null", NATIVE_DIR + "/extra.bin")

    # A full disk may reject the temporary copy used to restore an existing file.
    page.evaluate("""root => {
      const put = window.opfsPut;
      let rollbackFull = true;
      window.opfsPut = async (path, bytes) => {
        if (path === root + '/B.bin' || (path === root + '/A.bin' && bytes instanceof Blob && rollbackFull)) {
          if (bytes instanceof Blob) rollbackFull = false;
          throw new DOMException('test quota', 'QuotaExceededError');
        }
        return put(path, bytes);
      };
    }""", NATIVE_DIR)
    assert import_group(page, "new") == "QuotaExceededError"
    assert_group(page, "old")
    boot(page, url, fixture)
    assert_group(page, "old")

    # Fail the live handoff after the first file reaches MEMFS and both reach OPFS.
    page.evaluate("""root => {
      const write = FS.writeFile;
      let pending = true;
      FS.writeFile = function(path, bytes, ...args) {
        if (path === root + '/B.bin' && pending) { pending = false; throw Error('test live write'); }
        return write.call(this, path, bytes, ...args);
      };
    }""", NATIVE_DIR)
    assert import_group(page, "new") == "Error"
    assert_group(page, "old")
    boot(page, url, fixture)
    assert_group(page, "old")

    # The native directory importer must use the same transaction as a backup bundle.
    page.evaluate("""async () => {
      const files = ['A.bin','B.bin'].map(name => {
        const f = new File(['complete'], name);
        Object.defineProperty(f, 'webkitRelativePath', {value: 'AUDIT_TEST/' + name});
        return f;
      });
      await importNativeSaveFolder(files);
    }""")
    boot(page, url, fixture)
    assert_group(page, "complete")
    print("Reload verified after incomplete scan, disk and rollback quota failures, interrupted import, live write failure and native import")


def exercise_native_slots(page, url, fixture):
    page.goto(url)
    page.wait_for_function("typeof opfsPut === 'function'")
    page.evaluate(r"""async () => {
      const dir = PERSIST_ROOTS[0] + '/PSP/SYSTEM/';
      await opfsPut(dir + 'ppsspp.ini', new TextEncoder().encode(
        '[General]\nStateSlot = 8\nSaveStateSlotCount = 5\nEnableStateUndo = True\n'));
      await opfsPut(dir + 'controls.ini', new TextEncoder().encode('[ControlMapping]\nCross = 1-54,10-189\n'));
    }""")
    boot(page, url, fixture)
    open_slots(page)
    slot = page.evaluate("selectedStateSlot")
    assert (slot["slot"], slot["count"]) == (4, 5)
    page.evaluate("path => FS.writeFile(path, new Uint8Array())", slot["path"])
    page.evaluate("() => refreshStateSlot()")
    expect(page.locator("#stateSlotPreview")).to_contain_text("0 字节")
    expect(page.locator("#stateSlotLoad")).to_be_disabled()

    def overwrite():
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#stateSlotSave").click()
        expect(page.locator("#stateSlotStatus")).to_contain_text("可以刷新", timeout=20000)
        page.wait_for_function(r"FS.analyzePath(selectedStateSlot.path.replace(/\.ppst$/, '.jpg')).exists")

    def hashes(undo=False):
        return page.evaluate(r"""async undo => {
          const base = selectedStateSlot.path.replace(/\.ppst$/, '') + (undo ? '.undo' : '');
          return Promise.all(['.ppst', '.jpg'].map(async ext =>
            Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', FS.readFile(base + ext)))).join(',')));
        }""", undo)

    overwrite()
    first = hashes()
    overwrite()
    second = hashes()
    assert first == hashes(undo=True)
    for target in ('.ppst', '.jpg', '.undo.ppst', '.undo.jpg'):
        page.evaluate(r"""suffix => {
          const target = selectedStateSlot.path.replace(/\.ppst$/, suffix);
          const rename = FS.rename;
          window.slotWriteFailed = false;
          FS.rename = function(from, to) {
            if (from.endsWith('.tmp') && to === target) {
              FS.rename = rename;
              window.slotWriteFailed = true;
              throw new FS.ErrnoError(29);
            }
            return rename.apply(this, arguments);
          };
        }""", target)
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#stateSlotSave").click()
        page.wait_for_function("window.slotWriteFailed && !slotBusy")
        expect(page.locator("#stateSlotStatus")).not_to_contain_text("可以刷新")
        assert second == hashes() and first == hashes(undo=True), target
    boot(page, url, fixture)
    open_slots(page)
    assert second == hashes() and first == hashes(undo=True)
    for suffix in ('.ppst', '.jpg', '.undo.ppst', '.undo.jpg'):
        page.evaluate(r"""suffix => {
          const put = window.opfsPut, target = selectedStateSlot.path.replace(/\.ppst$/, suffix);
          window.diskWriteFailed = false;
          window.opfsPut = (path, bytes) => {
            if (path === target) {
              window.opfsPut = put;
              window.diskWriteFailed = true;
              throw Error('test disk write');
            }
            return put(path, bytes);
          };
        }""", suffix)
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#stateSlotSave").click()
        page.wait_for_function("window.diskWriteFailed && !slotBusy")
        expect(page.locator("#stateSlotStatus")).not_to_contain_text("可以刷新")
        boot(page, url, fixture)
        open_slots(page)
        assert second == hashes() and first == hashes(undo=True), suffix
    # A capture error still permits a complete body, explicitly without a preview.
    page.evaluate(r"""() => {
      const open = FS.open;
      window.shotFailed = false;
      FS.open = function(path, ...args) {
        if (typeof path === 'string' && /\.jpg\.\d+\.tmp$/.test(path)) {
          FS.open = open;
          window.shotFailed = true;
          throw new FS.ErrnoError(29);
        }
        return open.call(this, path, ...args);
      };
    }""")
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#stateSlotSave").click()
    expect(page.locator("#stateSlotStatus")).to_contain_text("可以刷新", timeout=20000)
    expect(page.locator("#stateSlotStatus")).to_contain_text("预览图")
    assert page.evaluate(r"""async () => window.shotFailed && slotHasData(selectedStateSlot.path) &&
      !(await existingSaveFile(selectedStateSlot.path.replace(/\.ppst$/, '.jpg')))""")
    page.locator("#stateSlotLoad").click()
    expect(page.locator("#stateSlotStatus")).to_contain_text("已读取", timeout=20000)
    page.evaluate("() => openCoreMenu()")
    assert page.evaluate("async () => (await requestStateSlot(slotAction.inspectMenu, -1)).slot") == 1
    print("Verified legacy slot bounds, empty-file repair, body and preview rollback, undo pair, load and remapped menu")


def undo_failures(page, url, fixture):
    page.goto(url)
    page.wait_for_function("typeof opfsPut === 'function'")
    page.evaluate(r"""() => opfsPut(PERSIST_ROOTS[0] + '/PSP/SYSTEM/ppsspp.ini',
      new TextEncoder().encode('[General]\nEnableStateUndo = True\n'))""")
    boot(page, url, fixture)
    open_slots(page)
    page.evaluate("() => runStateSlotAction(true)")
    page.evaluate("() => runStateSlotAction(false)")
    result = page.evaluate(r"""async () => {
      const path = dirname(selectedStateSlot.path) + '/load_undo.ppst';
      const hash = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', FS.readFile(path)))).join(',');
      const before = await hash(), rename = FS.rename;
      let hit = false;
      FS.rename = function(from, to) {
        if (to === path && from.endsWith('.tmp')) { FS.rename = rename; hit = true; throw new FS.ErrnoError(29); }
        return rename.apply(this, arguments);
      };
      try {
        await runStateSlotAction(false);
        return {hit, preserved: before === await hash(), status: byId('stateSlotStatus').textContent,
          temporary: FS.readdir(dirname(path)).some(name => name.startsWith('load_undo.') && name.endsWith('.tmp'))};
      } finally { FS.rename = rename; }
    }""")
    assert result['hit'] and result['preserved'] and not result['temporary'], result
    assert '已读取' in result['status'] and '撤销点' in result['status'], result

    primary_failure = page.evaluate(r"""async () => {
      const target = selectedStateSlot.path, undo = dirname(target) + '/load_undo.ppst';
      const digest = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', FS.readFile(undo)))).join(',');
      const owner = () => FS.readFile(detectMemstickDir(FS) + '/PSP/SYSTEM/ppsspp.ini', {encoding:'utf8'})
        .match(/^StateLoadUndoGame\s*=\s*(.+)$/m)?.[1].trim();
      const prior = await digest(), game = owner(), open = FS.open;
      let hit = false;
      FS.open = function(path, ...args) {
        if (path === target) { hit = true; throw new FS.ErrnoError(29); }
        return open.call(this, path, ...args);
      };
      try {
        await runStateSlotAction(false);
        return { hit, ok: game && game === owner() && prior === await digest(), status: byId('stateSlotStatus').textContent };
      } finally { FS.open = open; }
    }""")
    assert primary_failure['hit'] and primary_failure['ok'] and '失败' in primary_failure['status'], primary_failure

    # Exercise the preserved file through the native Undo Load menu.
    page.evaluate(r"""() => {
      const read = FS.read;
      window.undoRead = 0;
      FS.read = function(stream, ...args) {
        const size = read.call(this, stream, ...args);
        if (stream.path.endsWith('/load_undo.ppst')) window.undoRead += size;
        return size;
      };
    }""")
    page.evaluate("() => openCoreMenu()")
    page.wait_for_timeout(450)
    page.locator('#canvas').click(position={'x': 312, 'y': 564})
    page.wait_for_function("window.undoRead > 0")
    page.wait_for_function("readPpssppCorePerformance(Module)?.emulatedUs > 1e6")
    open_slots(page)
    page.once("dialog", lambda dialog: dialog.accept())
    page.evaluate("() => runStateSlotAction(true)")
    # The fixture draws a static map. Distinguish its identical JPEG previews
    # with permitted trailing bytes so an accidental swap cannot pass unnoticed.
    page.evaluate(r"""async () => {
      for (const [i, ext] of ['.jpg', '.undo.jpg'].entries()) {
        const path = selectedStateSlot.path.replace(/\.ppst$/, ext), old = FS.readFile(path);
        const marked = new Uint8Array(old.length + 1); marked.set(old); marked[old.length] = i;
        FS.writeFile(path, marked);
      }
      await persistFiles(FS, 'distinguish thumbnails');
    }""")
    def hashes():
        return page.evaluate(r"""async () => {
          const base = selectedStateSlot.path.replace(/\.ppst$/, '');
          return Promise.all(['.ppst','.undo.ppst','.jpg','.undo.jpg'].map(async ext =>
            Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', FS.readFile(base + ext)))).join(',')));
        }""")
    expected = hashes()
    assert expected[0] != expected[1] and expected[2] != expected[3]
    for step in [1, 2, 3, 4, 5, 6, "rollback", 7]:
        if step == 7:
            # Force the two real preview nodes to share their entire old dirty
            # fingerprint. Only their identities distinguish the exchange.
            sizes = page.evaluate(r"""async () => {
              const sizes = ['.jpg', '.undo.jpg'].map(ext => {
                const path = selectedStateSlot.path.replace(/\.ppst$/, ext);
                FS.utime(path, 1000, 1000);
                return FS.stat(path).size;
              });
              await persistFiles(FS, 'equal timestamps');
              return sizes;
            }""")
            assert sizes[0] == sizes[1]
        page.evaluate("() => openCoreMenu()")
        page.wait_for_timeout(450)
        page.evaluate(r"""step => {
          let count = 0;
          const rename = FS.rename, base = selectedStateSlot.path.replace(/\.ppst$/, '');
          window.exchangeStep = 0;
          window.exchangeGaps = [];
          FS.rename = function(from, to) {
            if (!from.startsWith(base + '.') || !to.startsWith(base + '.')) return rename.apply(this, arguments);
            window.exchangeStep = ++count;
            const doubleFailure = step === 'rollback' && (count === 5 || count === 6);
            if (count === step || count === 6) FS.rename = rename;
            if (count === step || doubleFailure) throw new FS.ErrnoError(29);
            const result = rename.apply(this, arguments);
            if (count < 6) {
              const pending = new Set();
              fsStatDir(FS, dirname(base), true, false, pending);
              if (!pending.has(base)) window.exchangeGaps.push(count);
            }
            return result;
          };
        }""", step)
        # Pause screen at the suite's 1100 x 720 viewport.
        page.locator('#canvas').click(position={'x': 105, 'y': 564})
        page.wait_for_function(r"""step => window.exchangeStep === (step === 'rollback' ? 6 : Math.min(step, 6)) &&
          !FS.readdir(dirname(selectedStateSlot.path)).some(name => name.endsWith('.tmp'))""", arg=step)
        assert page.evaluate("window.exchangeGaps") == [], step
        if step == 7:
            expected = [expected[1], expected[0], expected[3], expected[2]]
        assert hashes() == expected, step
        assert not page.evaluate("() => persistFiles(FS, 'undo menu')")['failed']
        boot(page, url, fixture)
        open_slots(page)
        assert hashes() == expected, step
    print("Undo exchange: six interrupted renames, a rollback fault and a successful exchange preserved across reload; load undo warning and backup verified")


def first_visit_offline(browser, url, fixture):
    with browser.new_context(viewport={"width": 1100, "height": 720}) as context:
        page = context.new_page()
        boot(page, url, fixture)
        page.wait_for_function("readPpssppCorePerformance(Module)?.emulatedUs > 1e6")
        assert page.evaluate("!!navigator.serviceWorker.controller")
        context.set_offline(True)
        boot(page, url, fixture)
        page.wait_for_function("readPpssppCorePerformance(Module)?.emulatedUs > 1e6")
        assert page.evaluate("!navigator.onLine")
        print("First-visit offline reload booted the same game and advanced the PSP clock")


def benchmark_sync(page, url, fixture):
    """Measure disk-lock time and application writes for the 64-slot audit fixture."""
    boot(page, url, fixture)
    return page.evaluate(r"""() => withSaveStorage(async () => {
      const root = PERSIST_ROOTS[0] + '/PSP/PPSSPP_STATE/', files = [];
      for (let i = 0; i < 64; i++) {
        for (const suffix of ['.ppst', '.jpg']) files.push(root + 'fixture_' + i + suffix);
      }
      const setContents = byte => files.forEach(path => FS.writeFile(path, Uint8Array.of(byte)));
      setContents(1);
      const seed = await persistFilesNow(FS, 'benchmark seed');
      if (seed.failed) throw Error('benchmark seed failed');
      const scan = window.fsStatDir, write = window.writeOpfsHandle, encoder = new TextEncoder();
      const rounds = [];
      try {
        for (let i = 0; i < 3; i++) {
          setContents(2 + i);
          const row = { scans: 0, scanMs: 0, revisions: 0, manifest: 0, undo: 0, payload: 0 };
          window.fsStatDir = (...args) => {
            const start = performance.now();
            try { return scan(...args); }
            finally { row.scanMs += performance.now() - start; row.scans++; }
          };
          window.writeOpfsHandle = (handle, data) => {
            const bytes = typeof data === 'string' ? encoder.encode(data).length : data.size ?? data.byteLength;
            if (handle.name === 'save-revisions.json') row.revisions += bytes;
            else if (handle.name === 'pending.json') row.manifest += bytes;
            else if (/^\d+$/.test(handle.name)) row.undo += bytes;
            else if (handle.name.startsWith('fixture_')) row.payload += bytes;
            return write(handle, data);
          };
          const start = performance.now();
          const result = await persistFilesNow(FS, 'benchmark overwrite');
          row.ms = Math.round(performance.now() - start);
          if (result.failed || result.written !== files.length) throw Error('incomplete overwrite');
          row.scanMs = Number(row.scanMs.toFixed(1));
          rounds.push(row);
        }
      } finally { window.fsStatDir = scan; window.writeOpfsHandle = write; }
      return rounds;
    })""")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="packaged player URL")
    parser.add_argument("fixture", type=Path, help="bootable PSP image, e.g. the reversed-depth homebrew ISO")
    parser.add_argument("--chromium", help="path to an installed Chromium executable")
    parser.add_argument("--benchmark-sync", action="store_true", help="measure three 64-slot overwrites in a fresh browser profile")
    args = parser.parse_args()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.chromium)
        context = browser.new_context(viewport={"width": 1100, "height": 720})
        if args.benchmark_sync:
            print(json.dumps(benchmark_sync(context.new_page(), args.url, args.fixture)))
            context.close()
            browser.close()
            raise SystemExit(0)
        page = concurrent_saves(context, args.url, args.fixture)
        exercise_storage(page, args.url, args.fixture)
        context.close()
        context = browser.new_context(viewport={"width": 1100, "height": 720})
        exercise_native_slots(context.new_page(), args.url, args.fixture)
        context.close()
        with browser.new_context(viewport={"width": 1100, "height": 720}) as undo_context:
            undo_failures(undo_context.new_page(), args.url, args.fixture)
        first_visit_offline(browser, args.url, args.fixture)
        browser.close()
