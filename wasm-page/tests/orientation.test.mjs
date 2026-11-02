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

function viewportFixture() {
  const styles = new Map(), classes = new Map();
  const window = {
    innerWidth: 390, innerHeight: 844,
    visualViewport: { width: 390, height: 844, scale: 1, offsetTop: 0, offsetLeft: 0 },
    screen: { orientation: { type: 'portrait-primary' } },
  };
  const document = {
    activeElement: null,
    documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } },
    body: { classList: { toggle: (key, value) => classes.set(key, !!value) } },
  };
  const context = load(['syncViewportSize', 'fullscreenElement', 'viewportOrientation', 'isTextEntryActive', 'revealPanelInput'],
    { window, document }, 'let stableViewportWidth = 0, stableViewportHeight = 0, stableViewportOrientation = "";');
  context.syncViewportSize({ reset: true });
  return { context, window, document, styles, classes };
}

test('pinch zoom preserves layout width and is not mistaken for a keyboard', () => {
  const f = viewportFixture();
  f.document.activeElement = { tagName: 'INPUT', type: 'text' };
  Object.assign(f.window.visualViewport, { width: 195, height: 422, scale: 2, offsetLeft: 70, offsetTop: 90 });
  f.context.syncViewportSize();
  assert.equal(f.styles.get('--viewport-w'), '390px');
  assert.equal(f.styles.get('--app-h'), '844px');
  assert.equal(f.styles.get('--visual-h'), '422px');
  assert.equal(f.styles.get('--visual-left'), '70px');
  assert.equal(f.classes.get('keyboard-open'), false);
  f.window.visualViewport.height = 200;
  f.context.syncViewportSize();
  assert.equal(f.classes.get('keyboard-open'), true, 'a keyboard can still open while zoomed');
});

test('a fold or split-window width change resets the height baseline even below the old 80px threshold', () => {
  const f = viewportFixture();
  f.document.activeElement = { tagName: 'INPUT', type: 'text' };
  f.window.innerWidth = f.window.visualViewport.width = 450;
  f.window.innerHeight = f.window.visualViewport.height = 600;
  f.context.syncViewportSize();
  assert.equal(f.styles.get('--viewport-w'), '450px');
  assert.equal(f.styles.get('--app-h'), '600px');
  assert.equal(f.classes.get('keyboard-open'), false);
  f.window.innerWidth = f.window.visualViewport.width = 390;
  f.window.innerHeight = f.window.visualViewport.height = 844;
  f.context.syncViewportSize();
  assert.equal(f.styles.get('--app-h'), '844px');
  assert.equal(f.classes.get('keyboard-open'), false);
});

test('non-text controls do not preserve an obsolete height as a supposed software keyboard', () => {
  for (const activeElement of [{ tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'range' }, { tagName: 'SELECT' }]) {
    const f = viewportFixture();
    f.document.activeElement = activeElement;
    f.window.innerHeight = f.window.visualViewport.height = 500;
    f.context.syncViewportSize();
    assert.equal(f.styles.get('--app-h'), '500px');
    assert.equal(f.classes.get('keyboard-open'), false);
  }
});

test('short landscape windows use their real height instead of overflowing a 320px minimum', () => {
  for (const fullscreen of [false, true]) {
    const f = viewportFixture();
    f.window.innerWidth = f.window.visualViewport.width = 512;
    f.window.innerHeight = f.window.visualViewport.height = 256;
    f.window.screen.orientation.type = 'landscape-primary';
    f.document.fullscreenElement = fullscreen ? {} : null;
    f.context.syncViewportSize({ reset: true });
    assert.equal(f.styles.get('--app-h'), '256px');
    assert.equal(f.styles.get('--visual-h'), '256px');
  }
});

function canvasResizeFixture({ hidden = false } = {}) {
  const window = new EventTarget(), document = new EventTarget();
  window.visualViewport = new EventTarget();
  window.devicePixelRatio = 1;
  let resizeObserver, mutationObserver, disconnected = false, resizes = 0, layoutChanges = 0, frameSequence = 0;
  const observed = [], mutationsObserved = [], frames = new Map(), resolutionQueries = [];
  window.matchMedia = query => {
    const result = new EventTarget();
    result.media = query;
    resolutionQueries.push(result);
    return result;
  };
  const rect = { left: 12, top: 76, width: hidden ? 0 : 960, height: hidden ? 0 : 544 };
  const canvas = { getBoundingClientRect: () => ({ ...rect }), parentElement: {} };
  window.ResizeObserver = class {
    constructor(callback) { resizeObserver = callback; }
    observe(element) { observed.push(element); }
    disconnect() { disconnected = true; }
  };
  window.MutationObserver = class {
    constructor(callback) { mutationObserver = callback; }
    observe(element, options) { mutationsObserved.push({ element, options }); }
    disconnect() { mutationsObserved.length = 0; }
  };
  document.addEventListener('ppsspp-player-layout', () => layoutChanges++);
  const context = load(['canvasLayoutSnapshot', 'installCanvasResizeTracking'], {
    window, document, Event,
    requestAnimationFrame(callback) { const id = ++frameSequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    notifyRuntimeResize() { resizes++; window.dispatchEvent(new Event('resize')); },
  });
  const dispose = context.installCanvasResizeTracking(canvas);
  const frame = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
  return { window, document, rect, canvas, observed, mutationsObserved, frames, resolutionQueries, dispose, frame,
    observer: () => resizeObserver(), mutation: () => mutationObserver(),
    result: () => ({ resizes, layoutChanges, disconnected }) };
}

test('CSS-only canvas resize notifies SDL once after layout and coalesces duplicate browser events', () => {
  const f = canvasResizeFixture();
  assert.deepEqual(f.observed, [f.canvas, f.canvas.parentElement]);
  f.rect.width = 720; f.rect.height = 408;
  f.observer(); f.window.visualViewport.dispatchEvent(new Event('resize')); f.observer();
  assert.equal(f.frames.size, 1);
  assert.equal(f.result().resizes, 0);
  f.frame();
  assert.equal(f.result().resizes, 1);
  assert.equal(f.result().layoutChanges, 1);
  f.frame(); // The synthetic resize must not recurse indefinitely.
  assert.equal(f.frames.size, 0);
  assert.equal(f.result().resizes, 1);
  f.window.devicePixelRatio = 2;
  f.window.dispatchEvent(new Event('resize')); f.frame(); f.frame();
  assert.equal(f.result().resizes, 2, 'DPR changes need notification even at unchanged CSS dimensions');
});

test('canvas movement invalidates gestures without resizing SDL and disposal removes pending work', () => {
  const f = canvasResizeFixture();
  f.rect.left = 24;
  f.document.dispatchEvent(new Event('scroll')); f.frame();
  assert.equal(f.result().layoutChanges, 1);
  assert.equal(f.result().resizes, 0);
  f.rect.top = 120;
  f.window.visualViewport.dispatchEvent(new Event('scroll'));
  assert.equal(f.frames.size, 1);
  f.dispose(); f.frame();
  assert.equal(f.result().disconnected, true);
  f.window.dispatchEvent(new Event('resize')); f.observer();
  assert.equal(f.frames.size, 0);
  assert.equal(f.result().layoutChanges, 1);
});

test('DPR media-query changes synchronize a stable-size canvas and rearm at the new density', () => {
  const f = canvasResizeFixture();
  assert.equal(f.resolutionQueries[0].media, '(resolution: 1dppx)');
  f.window.devicePixelRatio = 2;
  f.resolutionQueries[0].dispatchEvent(new Event('change'));
  f.frame(); f.frame();
  assert.equal(f.result().resizes, 1);
  assert.equal(f.resolutionQueries[1].media, '(resolution: 2dppx)');
  f.dispose();
  f.resolutionQueries[1].dispatchEvent(new Event('change'));
  assert.equal(f.resolutionQueries.length, 2);
  assert.equal(f.frames.size, 0);
});

test('canvas first reveal and hide/reveal each synchronize visible dimensions without resizing zero-sized canvases', () => {
  const f = canvasResizeFixture({ hidden: true });
  f.observer(); f.frame();
  assert.equal(f.result().resizes, 0);
  f.rect.width = 960; f.rect.height = 544;
  f.observer(); f.frame(); f.frame();
  assert.equal(f.result().resizes, 1);
  f.rect.width = 0; f.rect.height = 0;
  f.observer(); f.frame();
  assert.equal(f.result().resizes, 1);
  assert.equal(f.result().layoutChanges, 2, 'hiding cancels gestures without delivering an invalid size to SDL');
  f.rect.width = 960; f.rect.height = 544;
  f.observer(); f.frame(); f.frame();
  assert.equal(f.result().resizes, 2, 'even revealing at the previous size must synchronize again');
});

test('targeted style/class mutations catch position-only layout changes without a resize-observer entry', () => {
  const f = canvasResizeFixture();
  assert.deepEqual(f.mutationsObserved.map(item => item.element), [f.canvas, f.canvas.parentElement]);
  f.rect.left += 100;
  f.mutation(); f.frame();
  assert.equal(f.result().layoutChanges, 1);
  assert.equal(f.result().resizes, 0);
  f.mutation(); f.frame();
  assert.equal(f.result().layoutChanges, 1, 'unrelated class churn must not cancel a new gesture');
  f.dispose();
  assert.equal(f.mutationsObserved.length, 0);
});

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
