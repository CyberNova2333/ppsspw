import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/touch-controls.js';

const { BUTTONS, createState, dpadButtons } = globalThis.PpssppTouchControls;

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
