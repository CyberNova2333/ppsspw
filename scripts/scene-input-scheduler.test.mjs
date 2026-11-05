import assert from 'node:assert/strict';
import test from 'node:test';
import { createSceneInputScheduler } from './scene-input-scheduler.mjs';

const action = (atUs = 1000, durationUs = 200, buttons = ['circle']) => ({ atUs, durationUs, buttons });
const sample = (emulatedUs, sequence = 2, overrides = {}) => ({ emulatedUs, sequence, sampleAgeMs: 0, initialized: true, emulating: true, ...overrides });
const create = (options = {}) => createSceneInputScheduler({ startEmulatedUs: 10000, actions: [action()], maxLatenessUs: 50, ...options });

test('slow emulation dispatches at emulated boundaries, not wall deadlines', () => {
  const s = create();
  assert.equal(s.step(sample(9000), 0).phase, 'waiting');
  assert.equal(s.step(sample(10000, 4), 1000).phase, 'running');
  assert.deepEqual(s.step(sample(10500, 6), 2000).edges, []);
  const down = s.step(sample(11000, 8), 3000);
  assert.deepEqual(down.edges, [{ index: 0, phase: 'down', buttons: ['circle'], scheduledEmulatedUs: 11000,
    observedEmulatedUs: 11000, latenessUs: 0, wallMs: 3000, sequence: 8 }]);
  assert.equal(down.needsRelease, false);
  const up = s.step(sample(11200, 10), 4000);
  assert.equal(up.phase, 'completed'); assert.equal(up.needsRelease, true);
  assert.equal(up.edges[0].phase, 'up'); assert.equal(s.snapshot().completedActions, 1);
});

test('same sequence returns no duplicate edges and eventually stalls', () => {
  const s = create({ maxStallMs: 100 });
  s.step(sample(10000), 0);
  assert.equal(s.step(sample(11000, 4), 10).edges.length, 1);
  assert.deepEqual(s.step(sample(11000, 4), 20).edges, []);
  assert.deepEqual(s.step(sample(11000, 6), 100).edges, []);
  const stalled = s.step(sample(11000, 8), 111);
  assert.equal(stalled.reason, 'core_stalled'); assert.equal(stalled.needsRelease, true);
});

test('adjacent actions release then press at a shared boundary', () => {
  const s = create({ actions: [action(0, 100, ['up', 'l']), action(100, 100, ['cross'])] });
  assert.equal(s.step(sample(10000), 0).edges[0].phase, 'down');
  assert.deepEqual(s.step(sample(10100, 4), 1).edges.map(e => [e.index, e.phase]), [[0, 'up'], [1, 'down']]);
  assert.equal(s.step(sample(10200, 6), 2).phase, 'completed');
  assert.equal(s.snapshot().edges.length, 4);
});

test('late edges are bounded and missed pulses are never compressed', () => {
  let s = create(); s.step(sample(10000), 0);
  assert.equal(s.step(sample(11050, 4), 1).edges[0].latenessUs, 50);
  assert.equal(s.step(sample(11251, 6), 2).reason, 'action_late');
  s = create(); s.step(sample(10000), 0);
  const skipped = s.step(sample(11200, 4), 1);
  assert.equal(skipped.reason, 'missed_pulse'); assert.deepEqual(skipped.edges, []);
  assert.deepEqual(s.snapshot().edges, []);
  s = create(); s.step(sample(10000), 0);
  assert.equal(s.step(sample(11051, 4), 1).reason, 'action_late');
});

test('invalid pending batch returns no partial edges and requests release', () => {
  const s = create({ maxLatenessUs: 1000, actions: [action(0, 100), action(100, 10)] });
  s.step(sample(10000), 0);
  const result = s.step(sample(10110, 4), 1);
  assert.equal(result.reason, 'missed_pulse'); assert.equal(result.needsRelease, true);
  assert.deepEqual(result.edges, []); assert.equal(s.snapshot().edges.length, 1);
});

test('initial samples reject late starts, invalid counters and unsafe timestamps', () => {
  for (const [core, wallMs, expected] of [
    [sample(10051), 0, 'start_late'], [sample(-1), 0, 'invalid_core_sample'],
    [sample(10000, 3), 0, 'invalid_core_sample'], [sample(10000, Infinity), 0, 'invalid_core_sample'],
    [sample(Number.MAX_SAFE_INTEGER + 1), 0, 'invalid_core_sample'],
    [sample(10000, 2, { sampleAgeMs: NaN }), 0, 'invalid_core_sample'],
    [sample(10000), -1, 'invalid_wall_time'], [sample(10000), Infinity, 'invalid_wall_time'],
    [sample(10000), Number.MAX_SAFE_INTEGER + 1, 'invalid_wall_time'],
  ]) assert.equal(create().step(core, wallMs).reason, expected);
  assert.equal(create().step(sample(10050), 0).phase, 'running');
  const waiting = create(); waiting.step(sample(9900), 0);
  assert.equal(waiting.step(sample(10051, 4), 1).reason, 'start_late');
});

test('hidden, paused, uninitialized and stale snapshots fail initially and while running', () => {
  for (const [overrides, visibility, reason] of [
    [{}, { visible: false }, 'page_hidden'], [{ initialized: false }, { visible: true }, 'core_uninitialized'],
    [{}, null, 'page_hidden'], [{}, {}, 'page_hidden'],
    [{ emulating: false }, { visible: true }, 'core_paused'], [{ sampleAgeMs: 2501 }, { visible: true }, 'stale_core_sample'],
  ]) {
    for (const running of [false, true]) {
      const s = create(); if (running) s.step(sample(10000), 0);
      const result = s.step(sample(10001, 4, overrides), 1, visibility);
      assert.equal(result.reason, reason); assert.equal(result.needsRelease, true); assert.deepEqual(result.edges, []);
    }
  }
});

test('counter and wall clock rollback, inconsistent sequence and deadlines fail', () => {
  for (const [core, wallMs, expected, options] of [
    [sample(9999, 4), 11, 'emulated_time_regressed'],
    [sample(10001, 0), 11, 'sequence_regressed'],
    [sample(10001, 2), 11, 'inconsistent_sequence'],
    [sample(10001, 4), 9, 'wall_time_regressed'],
    [sample(10001, 4), 111, 'run_timeout', { maxWallMs: 100 }],
    [sample(10000, 2), 111, 'core_stalled', { maxStallMs: 100 }],
  ]) {
    const s = create(options); s.step(sample(10000), 10);
    const result = s.step(core, wallMs);
    assert.equal(result.reason, expected); assert.equal(result.needsRelease, true);
  }
});

test('zero actions waits for start and completes without input', () => {
  const s = create({ actions: [] });
  assert.equal(s.step(sample(9000), 0).phase, 'waiting');
  assert.deepEqual(s.step(sample(10000, 4), 1), { phase: 'completed', reason: null, needsRelease: true, edges: [] });
});

test('cancel and terminal states are idempotent and always request own-input release', () => {
  for (const end of ['cancel', 'invalid', 'completed']) {
    const s = create({ actions: [action(0)] });
    s.step(sample(10000), 0);
    if (end === 'cancel') assert.equal(s.cancel().reason, 'canceled');
    else if (end === 'invalid') s.step(sample(9999, 4), 1);
    else s.step(sample(10200, 4), 1);
    const snapshot = s.snapshot();
    assert.equal(snapshot.needsRelease, true);
    assert.deepEqual(s.step(null, NaN), { phase: snapshot.phase, reason: snapshot.reason, needsRelease: true, edges: [] });
    s.cancel('another_reason'); assert.deepEqual(s.snapshot(), snapshot);
  }
  assert.equal(create().cancel('operator_stopped').reason, 'operator_stopped');
});

test('plans, incoming samples, returned edges and snapshots do not share mutable state', () => {
  const input = [action(0)], s = create({ actions: input });
  input[0].buttons[0] = 'cross'; input[0].atUs = 999;
  const core = Object.freeze(sample(10000));
  const down = s.step(core, 0.25);
  assert.deepEqual(down.edges[0].buttons, ['circle']);
  down.edges[0].buttons.push('up'); down.edges[0].phase = 'up';
  const copy = s.snapshot(); copy.edges[0].buttons.length = 0; copy.edges.length = 0;
  assert.deepEqual(s.snapshot().edges[0].buttons, ['circle']); assert.equal(s.snapshot().edges[0].phase, 'down');
});

test('plan validation rejects overlaps, unsupported buttons and unsafe arithmetic', () => {
  for (const options of [
    { startEmulatedUs: -1 }, { startEmulatedUs: 1.2 }, { maxLatenessUs: -1 }, { maxStallMs: 0 }, { maxWallMs: 0 },
    { maxSampleAgeMs: NaN }, { actions: null }, { actions: [action(-1)] }, { actions: [action(0, 0)] },
    { actions: Array(1) }, { actions: [action(0, 10, Array(1))] },
    { actions: [action(0, 0.5)] }, { actions: [action(10, 20), action(29)] },
    { actions: [action(0, 10, [])] }, { actions: [action(0, 10, ['circle', 'circle'])] },
    { actions: [action(0, 10, ['Circle'])] }, { actions: [action(Number.MAX_SAFE_INTEGER, 1)] },
    { actions: [action(Number.MAX_SAFE_INTEGER - 10000, 1)] },
    { actions: Array.from({ length: 257 }, (_, i) => action(i * 10, 1)) },
  ]) assert.throws(() => create(options), TypeError);
  const s = create({ startEmulatedUs: Number.MAX_SAFE_INTEGER - 100, actions: [action(0, 100)] });
  s.step(sample(Number.MAX_SAFE_INTEGER - 100), 0);
  assert.equal(s.step(sample(Number.MAX_SAFE_INTEGER, 4), 1).phase, 'completed');
});

test('maximum plan retains at most two edges per action', () => {
  const s = create({ actions: Array.from({ length: 256 }, (_, i) => action(i * 2, 1)), maxLatenessUs: 0 });
  for (let i = 0; i < 512; i++) {
    const result = s.step(sample(10000 + i, (i + 1) * 2), i);
    assert.equal(result.edges.length, 1);
  }
  assert.equal(s.snapshot().phase, 'completed'); assert.equal(s.snapshot().edges.length, 512);
});
