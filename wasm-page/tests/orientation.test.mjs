import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the shipped functions without starting the emulator or a browser.
const source = readFileSync(new URL('../public/ppsspp-runtime.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('runtime.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function load(names, globals = {}, declarations = '') {
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name.text));
  assert.equal(functions.length, names.length, 'all requested runtime functions must exist');
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(declarations + '\n' + functions.map(node => node.getText(ast)).join('\n'), context);
  return context;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ mobile = true, lock = () => Promise.resolve(), hasApi = true } = {}) {
  const canvas = {};
  const target = { contains: element => element === canvas };
  const document = { hidden: false, fullscreenElement: target };
  const calls = { locks: [], unlocks: 0, toasts: [], resizes: [], logs: [] };
  const orientation = {
    lock(value) { assert.equal(this, orientation); calls.locks.push(value); return lock(); },
    unlock() { assert.equal(this, orientation); calls.unlocks++; },
  };
  const window = { screen: hasApi ? { orientation } : {} };
  const state = { mobile };
  const context = load(['fullscreenElement', 'syncFullscreenOrientation', 'releaseFullscreenOrientation', 'unlockFullscreenOrientation'], {
    window, document, canvas,
    isMobileExperience: () => state.mobile,
    showToast: message => calls.toasts.push(message),
    scheduleRuntimeResize: reset => calls.resizes.push(reset),
    log: (...args) => calls.logs.push(args),
  }, 'let fullscreenOrientationSession = null;');
  return { context, canvas, target, document, window, orientation, calls, state };
}

test('landscape lock applies only to a visible mobile game fullscreen', async () => {
  for (const mode of ['desktop', 'hidden', 'windowed', 'other-fullscreen']) {
    const f = fixture({ mobile: mode !== 'desktop' });
    if (mode === 'hidden') f.document.hidden = true;
    if (mode === 'windowed') f.document.fullscreenElement = null;
    if (mode === 'other-fullscreen') f.document.fullscreenElement = { contains: () => false };
    assert.equal(await f.context.syncFullscreenOrientation(), false, mode);
    assert.deepEqual(f.calls.locks, [], mode);
    assert.equal(f.calls.unlocks, 0, mode);
    assert.deepEqual(f.calls.toasts, [], mode);
  }
});

test('duplicate fullscreen events share one landscape request and one resize', async () => {
  const pending = deferred();
  const f = fixture({ lock: () => pending.promise });
  const first = f.context.syncFullscreenOrientation();
  const duplicate = f.context.syncFullscreenOrientation();
  assert.deepEqual(f.calls.locks, ['landscape']);
  pending.resolve();
  assert.equal(await first, true);
  assert.equal(await duplicate, true);
  assert.equal(await f.context.syncFullscreenOrientation(), true);
  assert.deepEqual(f.calls.locks, ['landscape']);
  assert.deepEqual(f.calls.resizes, [true]);
  assert.deepEqual(f.calls.toasts, []);
});

test('successful fullscreen exit unlocks once and allows the next entry to lock again', async () => {
  const f = fixture();
  assert.equal(await f.context.syncFullscreenOrientation(), true);
  f.document.fullscreenElement = null;
  assert.equal(await f.context.syncFullscreenOrientation(), false);
  f.context.releaseFullscreenOrientation();
  assert.equal(f.calls.unlocks, 1, 'repeated exit cleanup is idempotent');
  f.document.fullscreenElement = f.target;
  assert.equal(await f.context.syncFullscreenOrientation(), true);
  assert.deepEqual(f.calls.locks, ['landscape', 'landscape']);
});

test('exiting while a request is pending unlocks immediately and again after its late success', async () => {
  const pending = deferred();
  const f = fixture({ lock: () => pending.promise });
  const first = f.context.syncFullscreenOrientation();
  f.document.fullscreenElement = null;
  assert.equal(await f.context.syncFullscreenOrientation(), false);
  assert.equal(f.calls.unlocks, 1);
  pending.resolve();
  assert.equal(await first, false);
  assert.equal(f.calls.unlocks, 2, 'a late completion must not leave the window locked');
  assert.deepEqual(f.calls.resizes, []);
  assert.deepEqual(f.calls.toasts, []);
});

test('old lock completion cannot unlock a newer fullscreen session', async () => {
  const old = deferred(), current = deferred();
  const requests = [old, current];
  const f = fixture({ lock: () => requests.shift().promise });
  const first = f.context.syncFullscreenOrientation();
  f.document.fullscreenElement = null;
  await f.context.syncFullscreenOrientation();
  f.document.fullscreenElement = f.target;
  const second = f.context.syncFullscreenOrientation();
  old.resolve();
  assert.equal(await first, false);
  assert.equal(f.calls.unlocks, 1, 'late success must preserve the new request');
  current.resolve();
  assert.equal(await second, true);
  assert.deepEqual(f.calls.resizes, [true]);
  assert.deepEqual(f.calls.toasts, []);
});

test('old rejection after re-entry does not show a stale failure or affect the new lock', async () => {
  const old = deferred(), current = deferred();
  const requests = [old, current];
  const f = fixture({ lock: () => requests.shift().promise });
  const first = f.context.syncFullscreenOrientation();
  f.context.releaseFullscreenOrientation();
  const second = f.context.syncFullscreenOrientation();
  old.reject(Object.assign(new Error('request superseded'), { name: 'AbortError' }));
  assert.equal(await first, false);
  assert.deepEqual(f.calls.toasts, []);
  current.resolve();
  assert.equal(await second, true);
  assert.equal(f.calls.unlocks, 1);
});

test('changing the game fullscreen target starts a new request and retires the old one', async () => {
  const old = deferred(), current = deferred();
  const requests = [old, current];
  const f = fixture({ lock: () => requests.shift().promise });
  const first = f.context.syncFullscreenOrientation();
  f.document.fullscreenElement = { contains: element => element === f.canvas };
  const second = f.context.syncFullscreenOrientation();
  assert.deepEqual(f.calls.locks, ['landscape', 'landscape']);
  assert.equal(f.calls.unlocks, 1);
  current.resolve();
  assert.equal(await second, true);
  old.resolve();
  assert.equal(await first, false);
  assert.equal(f.calls.unlocks, 1);
});

test('unsupported orientation API degrades once per fullscreen session without unlocking', async () => {
  const f = fixture({ hasApi: false });
  assert.equal(await f.context.syncFullscreenOrientation(), false);
  assert.equal(await f.context.syncFullscreenOrientation(), false);
  assert.equal(f.calls.toasts.length, 1);
  f.context.releaseFullscreenOrientation();
  assert.equal(f.calls.unlocks, 0);
  assert.equal(await f.context.syncFullscreenOrientation(), false);
  assert.equal(f.calls.toasts.length, 2, 'a later user entry can get a fresh explanation');
});

test('rejected and synchronously thrown lock failures keep fullscreen usable and avoid retry loops', async () => {
  for (const name of ['SecurityError', 'NotSupportedError']) {
    for (const synchronous of [false, true]) {
      const failure = Object.assign(new Error('unsupported in this browser'), { name });
      const f = fixture({ lock: () => { if (synchronous) throw failure; return Promise.reject(failure); } });
      assert.equal(await f.context.syncFullscreenOrientation(), false);
      assert.equal(await f.context.syncFullscreenOrientation(), false);
      assert.equal(f.document.fullscreenElement, f.target);
      assert.deepEqual(f.calls.locks, ['landscape']);
      assert.equal(f.calls.toasts.length, 1);
      assert.deepEqual(f.calls.resizes, []);
    }
  }
});

test('hidden-page cleanup unlocks and permits another request after becoming visible', async () => {
  const f = fixture();
  await f.context.syncFullscreenOrientation();
  f.document.hidden = true;
  assert.equal(await f.context.syncFullscreenOrientation(), false);
  assert.equal(f.calls.unlocks, 1);
  f.document.hidden = false;
  assert.equal(await f.context.syncFullscreenOrientation(), true);
  assert.deepEqual(f.calls.locks, ['landscape', 'landscape']);
});

test('an unlock failure does not prevent session cleanup and a subsequent lock attempt', async () => {
  const f = fixture();
  await f.context.syncFullscreenOrientation();
  f.orientation.unlock = () => { throw new Error('platform already unlocked'); };
  assert.doesNotThrow(() => f.context.releaseFullscreenOrientation());
  assert.equal(await f.context.syncFullscreenOrientation(), true);
  assert.deepEqual(f.calls.locks, ['landscape', 'landscape']);
});

test('shared fullscreenchange handler synchronizes orientation for SDL and browser paths', () => {
  for (const active of [false, true]) {
    let synchronizations = 0;
    const context = load(['handleFullscreenChange'], {
      fullscreenElement: () => active ? {} : null,
      syncFullscreenOrientation: () => { synchronizations++; return Promise.resolve(active); },
      setFullscreenMenuOpen() {}, syncFullscreenOverlays() {}, scheduleRuntimeResize() {},
      setTimeout: () => 1, clearTimeout() {}, _hideCursor() {}, _showCursor() {},
      document: { addEventListener() {}, removeEventListener() {}, body: { classList: { remove() {} } } },
    }, 'let _fsCursorTimer = null;');
    context.handleFullscreenChange();
    assert.equal(synchronizations, 1, active ? 'enter' : 'exit');
  }
});
