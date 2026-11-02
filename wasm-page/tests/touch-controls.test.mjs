import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/touch-controls.js';

const { BUTTONS, createState, dpadButtons, stickAxes, mount } = globalThis.PpssppTouchControls;

function fakeClock() {
  let time = 1000, nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, due: time + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    get pending() { return timers.size; },
    advance(duration) {
      const target = time + duration;
      let iterations = 0;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= target)
          .sort(([aId, a], [bId, b]) => a.due - b.due || aId - bId)[0];
        if (!next) break;
        assert.ok(++iterations < 1000, 'timer scheduling must make progress');
        const [id, timer] = next;
        timers.delete(id);
        time = timer.due;
        timer.callback();
      }
      time = target;
    },
  };
}

function fixture() {
  const clock = fakeClock();
  return { clock, state: createState({ ...clock, index: 3 }) };
}

function assertHeld(state, names) {
  const expected = new Set(names.map(name => BUTTONS[name]));
  state.gamepad.buttons.forEach((button, index) => {
    const down = expected.has(index);
    assert.equal(button.pressed, down, `button ${index} pressed`);
    assert.equal(button.touched, down, `button ${index} touched`);
    assert.equal(button.value, down ? 1 : 0, `button ${index} value`);
  });
}

function assertAxes(state, x, y) {
  assert.ok(Math.abs(state.gamepad.axes[0] - x) < 1e-12, `x: expected ${x}, got ${state.gamepad.axes[0]}`);
  assert.ok(Math.abs(state.gamepad.axes[1] - y) < 1e-12, `y: expected ${y}, got ${state.gamepad.axes[1]}`);
  assert.deepEqual(state.gamepad.axes.slice(2), [0, 0]);
}

test('virtual controller exposes the standard PSP button mapping and starts neutral', () => {
  assert.deepEqual(BUTTONS, {
    cross: 0, circle: 1, square: 2, triangle: 3, l: 4, r: 5,
    select: 8, start: 9, up: 12, down: 13, left: 14, right: 15,
  });
  const { state } = fixture();
  assert.equal(state.gamepad.index, 3);
  assert.equal(state.gamepad.mapping, 'standard');
  assert.equal(state.gamepad.connected, true);
  assert.equal(state.gamepad.buttons.length, 17);
  assertHeld(state, []);
  assertAxes(state, 0, 0);
});

test('two fingers holding the same button release it only after both sources leave', () => {
  const { clock, state } = fixture();
  state.setButtons(0, ['circle', 'circle']);
  state.setButtons(1, ['circle']);
  clock.advance(80);
  state.release(0);
  assertHeld(state, ['circle']);
  assert.equal(clock.pending, 0);
  state.release(1);
  assertHeld(state, []);
  state.release(1);
  assertHeld(state, []);
});

test('direction, face, shoulder and system buttons combine without replacing other fingers', () => {
  const { clock, state } = fixture();
  state.setButtons('direction', ['up', 'right']);
  state.setButtons('face', ['cross']);
  state.setButtons('shoulder', ['l', 'r']);
  state.setButtons('system', ['start']);
  assertHeld(state, ['up', 'right', 'cross', 'l', 'r', 'start']);
  clock.advance(80);
  state.release('face');
  assertHeld(state, ['up', 'right', 'l', 'r', 'start']);
  state.setButtons('direction', ['down', 'left', 'not-a-button']);
  assertHeld(state, ['down', 'left', 'l', 'r', 'start']);
  state.release('shoulder');
  assertHeld(state, ['down', 'left', 'start']);
});

test('a quick tap remains readable for a frame and releases at the hold deadline', () => {
  const { clock, state } = fixture();
  state.setButtons(1, ['cross']);
  clock.advance(8);
  state.release(1);
  assertHeld(state, ['cross']);
  assert.equal(clock.pending, 1);
  clock.advance(51);
  assertHeld(state, ['cross']);
  clock.advance(1);
  assertHeld(state, []);
  assert.equal(clock.pending, 0);
});

test('dragging across opposite directions replaces the old direction without a latched overlap', () => {
  const { clock, state } = fixture();
  state.setButtons('drag', ['up']);
  clock.advance(8);
  state.setButtons('drag', ['down'], { replaceImmediately: true });
  assertHeld(state, ['down']);
  assert.equal(clock.pending, 0);
  state.setButtons('drag', [], { replaceImmediately: true });
  assertHeld(state, []);
  state.setButtons('drag', ['right'], { replaceImmediately: true });
  clock.advance(8);
  state.release('drag');
  assertHeld(state, ['right'], 'lifting a quick tap still preserves the sampling window');
  clock.advance(52);
  assertHeld(state, []);
});

test('drag replacement preserves another finger and its pending quick tap on the old direction', () => {
  const { clock, state } = fixture();
  state.setButtons('drag', ['up']);
  state.setButtons('other', ['up']);
  clock.advance(8);
  state.setButtons('drag', ['right'], { replaceImmediately: true });
  assertHeld(state, ['up', 'right']);
  state.release('other');
  state.setButtons('drag', ['down'], { replaceImmediately: true });
  assertHeld(state, ['up', 'down']);
  clock.advance(52);
  assertHeld(state, ['down']);
  state.release('drag', { immediate: true });
  assertHeld(state, []);
});

test('re-pressing a pending button cancels its old release while another finger holds it', () => {
  const { clock, state } = fixture();
  state.setButtons(1, ['cross']);
  clock.advance(10);
  state.release(1);
  clock.advance(10);
  state.setButtons(2, ['cross']);
  assert.equal(clock.pending, 0);
  clock.advance(100);
  assertHeld(state, ['cross']);
  state.release(2);
  assertHeld(state, []);
});

test('reset immediately clears held keys, latched taps, axes and their scheduled releases', () => {
  const { clock, state } = fixture();
  state.setButtons('tap', ['cross', 'circle']);
  state.setButtons('held', ['up', 'l']);
  state.setAxes('stick', 0.4, -0.7);
  clock.advance(10);
  state.release('tap');
  assert.equal(clock.pending, 2);
  state.reset();
  assertHeld(state, []);
  assertAxes(state, 0, 0);
  assert.equal(clock.pending, 0);
  state.setButtons('after-reset', ['cross']);
  clock.advance(100);
  assertHeld(state, ['cross']);
  state.release('after-reset');
  assertHeld(state, []);
});

test('explicit immediate release clears a canceled gesture without waiting for tap retention', () => {
  const { clock, state } = fixture();
  state.setButtons('canceled', ['up', 'right']);
  state.setAxes('canceled', 1, 0);
  clock.advance(5);
  state.release('canceled', { immediate: true });
  assertHeld(state, []);
  assertAxes(state, 0, 0);
  assert.equal(clock.pending, 0);
});

test('canceling one finger does not truncate an unrelated pending tap', () => {
  const { clock, state } = fixture();
  state.setButtons('tap', ['cross']);
  clock.advance(10);
  state.release('tap');
  state.setButtons('canceled', ['up']);
  clock.advance(10);
  state.release('canceled', { immediate: true });
  assertHeld(state, ['cross']);
  clock.advance(40);
  assertHeld(state, []);
});

test('analog axes retain continuous values and clamp radially without changing direction', () => {
  const { state } = fixture();
  state.setAxes('stick', 0.12, -0.34);
  assertAxes(state, 0.12, -0.34);
  state.setAxes('stick', 3, 4);
  assertAxes(state, 0.6, 0.8);
  state.setAxes('stick', -9, 0);
  assertAxes(state, -1, 0);
  state.setAxes('stick', 0, -8);
  assertAxes(state, 0, -1);
  state.setAxes('stick', 0.3, 0.4);
  assertAxes(state, 0.3, 0.4);
  state.release('stick');
  assertAxes(state, 0, 0);
});

test('canceling a drag also releases its previous latched direction without clearing another source', () => {
  const { clock, state } = fixture();
  state.setButtons('drag', ['up']);
  state.setButtons('tap', ['cross']);
  clock.advance(10);
  state.setButtons('drag', []);
  state.release('tap');
  state.release('drag', { immediate: true });
  assertHeld(state, ['cross']);
  clock.advance(50);
  assertHeld(state, []);
});

test('canceling one source preserves a shared button latched by another source', () => {
  const { clock, state } = fixture();
  state.setButtons('drag', ['up']);
  state.setButtons('tap', ['up']);
  clock.advance(10);
  state.setButtons('drag', []);
  state.release('tap');
  state.release('drag', { immediate: true });
  assertHeld(state, ['up']);
  clock.advance(50);
  assertHeld(state, []);
});

test('releasing an inactive axis source keeps the latest source and releasing it restores the prior one', () => {
  const { state } = fixture();
  state.setAxes('a', 0.1, 0.2);
  state.setAxes('b', -0.3, -0.4);
  state.release('a');
  assertAxes(state, -0.3, -0.4);
  state.setAxes('a', 0.5, 0.6);
  assertAxes(state, 0.5, 0.6);
  state.release('a');
  assertAxes(state, -0.3, -0.4);
  state.release('b');
  assertAxes(state, 0, 0);
});

test('direction pad has a radial dead zone and recognizes all four diagonals', () => {
  for (const [x, y] of [[0, 0], [0.19, 0], [0.14, -0.14]]) assert.deepEqual(dpadButtons(x, y), []);
  for (const [x, y, expected] of [
    [0, -1, ['up']], [0, 1, ['down']], [-1, 0, ['left']], [1, 0, ['right']],
    [-1, -1, ['left', 'up']], [1, -1, ['right', 'up']],
    [-1, 1, ['down', 'left']], [1, 1, ['down', 'right']],
    [1, 0.4, ['right']], [1, 0.42, ['down', 'right']],
    [0.4, -1, ['up']], [0.42, -1, ['right', 'up']],
  ]) assert.deepEqual(dpadButtons(x, y).sort(), expected.sort(), `direction at ${x}, ${y}`);
});

test('a direction drag holds its sector across minor boundary jitter and switches on deliberate movement', () => {
  let held = ['right'];
  for (const y of [0.4, 0.43, 0.41, 0.48]) {
    held = dpadButtons(1, y, held);
    assert.deepEqual(held, ['right']);
  }
  held = dpadButtons(1, 0.6, held);
  assert.deepEqual(held, ['right', 'down']);
  for (const y of [0.43, 0.41, 0.36]) {
    held = dpadButtons(1, y, held);
    assert.deepEqual(held, ['right', 'down']);
  }
  assert.deepEqual(dpadButtons(1, 0.3, held), ['right']);
  assert.deepEqual(dpadButtons(0, 0, held), []);
  assert.deepEqual(dpadButtons(-1, 0, held), ['left']);
});

test('the stick has a small radial dead zone with continuous response and a circular maximum', () => {
  for (const [x, y] of [[0, 0], [0.1, 0], [-0.05, 0.08], [0, -0.12]]) {
    assert.deepEqual(stickAxes(x, y), [0, 0]);
  }
  assert.ok(stickAxes(0.120001, 0)[0] < 0.00001, 'leaving the dead zone must not jump');
  assert.ok(Math.abs(stickAxes(0.56, 0)[0] - 0.5) < 1e-12);
  assert.deepEqual(stickAxes(3, 4), [0.6, 0.8]);
  assert.deepEqual(stickAxes(-2, 0), [-1, 0]);
  const diagonal = stickAxes(0.4, -0.4);
  assert.equal(diagonal[0], -diagonal[1]);
  assert.ok(Math.hypot(...diagonal) < 1);
});

test('subscriptions report state changes with monotonic timestamps and can unsubscribe', () => {
  const { state } = fixture();
  const snapshots = [];
  const unsubscribe = state.subscribe(gamepad => snapshots.push({ timestamp: gamepad.timestamp, axes: [...gamepad.axes] }));
  state.setButtons(1, ['cross']);
  state.setButtons(1, ['cross']);
  state.setAxes(2, 0.1, 0.2);
  state.setAxes(2, 0.1, 0.2);
  state.release(1, { immediate: true });
  assert.equal(snapshots.length, 3, 'unchanged polling input should not trigger visual updates');
  assert.ok(snapshots[0].timestamp < snapshots[1].timestamp);
  assert.ok(snapshots[1].timestamp < snapshots[2].timestamp);
  assert.deepEqual(snapshots[1].axes, [0.1, 0.2, 0, 0]);
  unsubscribe();
  state.reset();
  assert.equal(snapshots.length, 3);
});

function mountedFixture({ withLayoutObservers = true } = {}) {
  const { clock, state } = fixture();
  function eventTarget() {
    const listeners = new Map();
    return {
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      fire(type, event = {}) {
        for (const listener of listeners.get(type) || []) listener({
          preventDefault() {}, stopPropagation() {}, ...event,
        });
      },
    };
  }
  const window = { ...eventTarget(), performance: { now: clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const resizeObservers = [];
  if (withLayoutObservers) {
    window.visualViewport = eventTarget();
    window.ResizeObserver = class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
      observe(target) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    };
  }
  const document = { ...eventTarget(), defaultView: window, hidden: false };
  const nodes = [];
  let geometryReads = 0;
  function node(attributes, rect, parent = null) {
    const captured = new Set();
    const classes = new Set();
    const style = new Map();
    const element = {
      ...eventTarget(), ownerDocument: document, parent, hidden: false,
      dataset: { padButton: attributes['data-pad-button'] },
      hasAttribute: name => Object.hasOwn(attributes, name),
      setAttribute: (name, value) => { attributes[name] = value; },
      getAttribute: name => attributes[name],
      getBoundingClientRect: () => { geometryReads++; return rect; },
      setRect: values => Object.assign(rect, values),
      style: { setProperty: (name, value) => style.set(name, value) },
      classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name) },
      hasPointerCapture: id => captured.has(id),
      setPointerCapture: id => captured.add(id),
      releasePointerCapture: id => captured.delete(id),
      contains(child) {
        for (let current = child; current; current = current.parent) if (current === this) return true;
        return false;
      },
      matches(selector) { return selector.split(',').some(part => this.hasAttribute(part.trim().slice(1, -1))); },
      closest(selector) {
        for (let current = this; current; current = current.parent) if (current.matches(selector)) return current;
        return null;
      },
      querySelectorAll(selector) { return nodes.filter(child => child !== this && this.contains(child) && child.matches(selector)); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    };
    nodes.push(element);
    return element;
  }
  const canvas = node({}, { left: 0, top: 0, width: 500, height: 400 });
  const element = node({}, { left: 0, top: 0, width: 500, height: 400 });
  const dpad = node({ 'data-pad-dpad': '' }, { left: 0, top: 0, width: 120, height: 120 }, element);
  const up = node({ 'data-pad-button': 'up' }, { left: 40, top: 0, width: 40, height: 40 }, dpad);
  const down = node({ 'data-pad-button': 'down' }, { left: 40, top: 80, width: 40, height: 40 }, dpad);
  const stick = node({ 'data-pad-stick': '' }, { left: 200, top: 200, width: 100, height: 100 }, element);
  const circle = node({ 'data-pad-button': 'circle' }, { left: 350, top: 0, width: 50, height: 50 }, element);
  const cross = node({ 'data-pad-button': 'cross' }, { left: 350, top: 60, width: 50, height: 50 }, element);
  document.elementFromPoint = (x, y) => [...nodes].reverse().find(candidate => {
    const rect = candidate.getBoundingClientRect();
    return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
  });
  let interactions = 0;
  const controller = mount({ element, canvas, state, onInteraction: () => { interactions++; } });
  controller.setEnabled(true);
  return {
    clock, state, element, canvas, stick, dpad, up, down, circle, cross, document, window, controller,
    resizeObservers,
    notifyResize() { resizeObservers.filter(observer => observer.targets.size).forEach(observer => observer.callback()); },
    get geometryReads() { return geometryReads; },
    get interactions() { return interactions; },
    pointer(type, target, id, x, y) {
      element.fire(type, { target, pointerId: id, pointerType: 'touch', clientX: x, clientY: y });
    },
  };
}

test('mounted stick anchors at the landing point, ignores jitter, supports another button and recentres on lift', () => {
  const f = mountedFixture();
  f.pointer('pointerdown', f.stick, 1, 280, 245);
  assertAxes(f.state, 0, 0);
  f.pointer('pointermove', f.stick, 1, 282, 246);
  assertAxes(f.state, 0, 0);
  f.pointer('pointerdown', f.circle, 2, 375, 25);
  f.pointer('pointermove', f.stick, 1, 296.8, 245);
  assertAxes(f.state, 0.5, 0);
  assertHeld(f.state, ['circle']);
  f.pointer('pointerdown', f.stick, 3, 215, 215);
  f.pointer('pointermove', f.stick, 3, 200, 215);
  assertAxes(f.state, 0.5, 0);
  assert.equal(f.stick.hasPointerCapture(3), false, 'a second finger must not take over the stick');
  f.pointer('pointerup', f.stick, 1, 296.8, 245);
  assertAxes(f.state, 0, 0);
  assertHeld(f.state, ['circle']);
  assert.equal(f.stick.hasPointerCapture(1), false);
  f.pointer('pointerdown', f.stick, 3, 215, 215);
  assertAxes(f.state, 0, 0);
  f.controller.destroy();
  assertHeld(f.state, []);
  assertAxes(f.state, 0, 0);
  assert.equal(f.clock.pending, 0);
});

test('mounted direction changes do not overlap opposite buttons and cancellation clears the gesture immediately', () => {
  const f = mountedFixture();
  f.pointer('pointerdown', f.up, 1, 60, 20);
  assertHeld(f.state, ['up']);
  f.clock.advance(8);
  f.pointer('pointermove', f.up, 1, 60, 100);
  assertHeld(f.state, ['down']);
  f.pointer('pointermove', f.up, 1, 60, 60);
  assertHeld(f.state, []);
  f.pointer('pointermove', f.up, 1, 100, 20);
  assertHeld(f.state, ['up', 'right']);
  f.pointer('pointercancel', f.up, 1, 100, 20);
  assertHeld(f.state, []);
  assert.equal(f.clock.pending, 0);
  assert.equal(f.dpad.hasPointerCapture(1), false);
  f.controller.destroy();
});

test('mounted controls release all pointers on blur, visibility loss, resize and disable', () => {
  for (const stop of [f => f.window.fire('blur'), f => { f.canvas.setRect({ width: 450 }); f.window.fire('resize'); },
    f => { f.document.hidden = true; f.document.fire('visibilitychange'); },
    f => f.controller.setEnabled(false)]) {
    const f = mountedFixture();
    f.pointer('pointerdown', f.stick, 1, 250, 250);
    f.pointer('pointermove', f.stick, 1, 280, 250);
    f.pointer('pointerdown', f.up, 2, 60, 20);
    f.pointer('pointerdown', f.circle, 3, 375, 25);
    stop(f);
    assertHeld(f.state, []);
    assertAxes(f.state, 0, 0);
    for (const [target, id] of [[f.stick, 1], [f.dpad, 2], [f.circle, 3]]) assert.equal(target.hasPointerCapture(id), false);
    assert.equal(f.clock.pending, 0);
    f.controller.destroy();
  }
});

test('sliding between face buttons replaces only this finger, including when another finger holds the old button', () => {
  const f = mountedFixture();
  f.pointer('pointerdown', f.circle, 1, 375, 25);
  f.clock.advance(8);
  f.pointer('pointermove', f.circle, 1, 375, 85);
  assertHeld(f.state, ['cross']);
  f.pointer('pointerdown', f.cross, 2, 375, 85);
  f.pointer('pointermove', f.circle, 1, 375, 25);
  assertHeld(f.state, ['circle', 'cross']);
  f.pointer('pointercancel', f.cross, 2, 375, 85);
  assertHeld(f.state, ['circle']);
  f.pointer('pointermove', f.circle, 1, 425, 150);
  assertHeld(f.state, []);
  assert.equal(f.clock.pending, 0);
  f.controller.destroy();
});

test('viewport panning, resizing, scrolling and explicit player layout changes cancel captured gestures', () => {
  for (const invalidate of [
    f => { f.stick.setRect({ width: 80 }); f.window.visualViewport.fire('resize'); },
    f => { f.window.visualViewport.offsetLeft = 40; f.window.visualViewport.fire('scroll'); },
    f => { f.element.setRect({ top: -80 }); f.document.fire('scroll'); },
    f => { f.canvas.setRect({ top: 0, width: 640 }); f.document.fire('fullscreenchange'); },
    f => { f.dpad.setRect({ left: 30 }); f.document.fire('ppsspp-player-layout'); },
    f => { f.element.setRect({ width: 400, height: 500 }); f.window.fire('orientationchange'); },
  ]) {
    const f = mountedFixture();
    f.pointer('pointerdown', f.stick, 1, 250, 250);
    f.pointer('pointermove', f.stick, 1, 280, 250);
    f.pointer('pointerdown', f.circle, 2, 375, 25);
    invalidate(f);
    assertHeld(f.state, []);
    assertAxes(f.state, 0, 0);
    assert.equal(f.stick.hasPointerCapture(1), false);
    assert.equal(f.circle.hasPointerCapture(2), false);
    f.pointer('pointermove', f.stick, 1, 150, 150);
    assertAxes(f.state, 0, 0, 'an old pointer must not resume after layout invalidation');
    f.controller.destroy();
  }
});

test('DPR and visual viewport transformations cancel gestures even when the CSS boxes have not moved', () => {
  for (const change of [
    f => { f.window.devicePixelRatio = 2; f.window.fire('resize'); },
    f => { f.window.visualViewport.scale = 2; f.window.visualViewport.fire('resize'); },
    f => { f.window.visualViewport.offsetTop = 70; f.window.visualViewport.fire('scroll'); },
  ]) {
    const f = mountedFixture();
    f.pointer('pointerdown', f.up, 1, 60, 20);
    f.pointer('pointerdown', f.stick, 2, 250, 250);
    f.pointer('pointermove', f.stick, 2, 280, 250);
    change(f);
    assertHeld(f.state, []);
    assertAxes(f.state, 0, 0);
    assert.equal(f.dpad.hasPointerCapture(1), false);
    assert.equal(f.stick.hasPointerCapture(2), false);
    f.controller.destroy();
  }
});

test('delayed runtime resize notifications do not swallow new touches after the geometry has settled', () => {
  const f = mountedFixture();
  f.pointer('pointerdown', f.up, 1, 60, 20);
  f.stick.setRect({ left: 100, top: 50, width: 80, height: 80 });
  f.window.fire('resize');
  assertHeld(f.state, []);
  // Re-touch immediately while the runtime still has delayed resize probes.
  f.pointer('pointerdown', f.up, 2, 60, 20);
  f.pointer('pointerdown', f.stick, 3, 130, 90);
  f.pointer('pointermove', f.stick, 3, 154, 90);
  for (const delay of [0, 60, 140, 300, 650]) f.clock.setTimeout(() => {
    f.window.fire('resize');
    f.document.fire('ppsspp-player-layout');
  }, delay);
  for (const interval of [0, 60, 80, 160, 350]) {
    f.clock.advance(interval);
    assertHeld(f.state, ['up']);
    assertAxes(f.state, 1, 0);
    assert.equal(f.dpad.hasPointerCapture(2), true);
    assert.equal(f.stick.hasPointerCapture(3), true);
  }
  f.controller.destroy();
  assert.equal(f.clock.pending, 0);
});

test('box changes cancel old geometry, while initial and unchanged observer notifications preserve input', () => {
  for (const target of ['element', 'canvas', 'dpad', 'stick', 'circle']) {
    const f = mountedFixture();
    f.pointer('pointerdown', f.up, 1, 60, 20);
    f.notifyResize();
    assertHeld(f.state, ['up'], 'the first observer callback must not cancel a fresh touch');
    f.notifyResize();
    assertHeld(f.state, ['up']);
    f[target].setRect({ width: 80 });
    f.notifyResize();
    assertHeld(f.state, []);
    assert.equal(f.dpad.hasPointerCapture(1), false);
    f.controller.destroy();
    assert.ok(f.resizeObservers.every(observer => observer.targets.size === 0));
  }
});

test('a new touch uses fresh folded-layout coordinates without measuring on each analog move', () => {
  const f = mountedFixture();
  f.pointer('pointerdown', f.stick, 1, 250, 250);
  f.pointer('pointermove', f.stick, 1, 280, 250);
  f.stick.setRect({ left: 100, top: 50, width: 80, height: 80 });
  f.notifyResize();
  assertAxes(f.state, 0, 0);
  f.pointer('pointerdown', f.stick, 2, 130, 90);
  assertAxes(f.state, 0, 0);
  const readsBeforeMoves = f.geometryReads;
  f.pointer('pointermove', f.stick, 2, 143.44, 90);
  assertAxes(f.state, 0.5, 0);
  f.pointer('pointermove', f.stick, 2, 154, 90);
  assertAxes(f.state, 1, 0);
  assert.equal(f.geometryReads, readsBeforeMoves, 'pointermove and visual feedback should use cached geometry');
  f.controller.destroy();
});

test('layout cancellation works without optional viewport/observer APIs and destroy removes its listeners', () => {
  const f = mountedFixture({ withLayoutObservers: false });
  f.pointer('pointerdown', f.up, 1, 60, 20);
  f.dpad.setRect({ left: 20 });
  f.document.fire('ppsspp-player-layout');
  assertHeld(f.state, []);
  f.controller.destroy();
  f.state.setButtons('external', ['cross']);
  f.document.fire('ppsspp-player-layout');
  f.document.fire('scroll');
  f.window.fire('resize');
  assertHeld(f.state, ['cross'], 'destroyed listeners must not modify shared state');
  f.state.reset();
});
