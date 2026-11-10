import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSceneSession } from './browser-scene-session.mjs';
import '../wasm-page/public/performance.js';

const REVISION = 'a'.repeat(64);
const FIXTURE = 'b'.repeat(64);
const core = (emulatedUs = 10000, sequence = 2, extra = {}) => ({
  initialized: true, emulating: true, emulatedUs, sequence, sampleAgeMs: 0, ...extra,
});
const action = (atUs = 1000, durationUs = 1000, buttons = ['circle']) => ({ atUs, durationUs, buttons });

// This adapter deliberately permits synchronous start/stop callbacks, partial
// failures, and external recorder replacement. A session must own its cleanup.
function harness(options = {}) {
  const h = { now: 0, core: core(), visible: true, activeToken: 0, lastToken: 0,
    report: null, startCalls: 0, stopCalls: 0, snapshotCalls: 0, summaryCalls: 0,
    buttons: [], held: [], releases: 0, hooks: {}, failures: {}, startedAt: 0 };
  const settings = { resolution: 1, showFps: true, touch: true, appliedAtLaunch: true };
  const fail = (operation, when) => { if (h.failures[operation] === when) throw new Error(operation); };
  function open() {
    h.activeToken = ++h.lastToken; h.startedAt = h.now;
    h.report = { coreRevision: REVISION, settings: { ...settings }, samplingErrors: 0,
      visibilityChanges: 0, active: true, durationMs: 0, totalSamples: 1,
      samples: [{ visible: h.visible, core: structuredClone(h.core) }] };
    return h.activeToken;
  }
  function close() {
    h.report.active = false; h.report.durationMs = h.now - h.startedAt; h.activeToken = 0;
  }
  h.externalStart = open; h.externalStop = close;
  h.sample = () => {
    h.report.totalSamples++; h.report.durationMs = h.now - h.startedAt;
    h.report.samples.push({ visible: h.visible, core: structuredClone(h.core) });
  };
  h.perf = {
    token() { fail('token', 'before'); return h.activeToken; },
    sessionToken() { fail('sessionToken', 'before'); return h.lastToken; },
    start() {
      h.startCalls++; fail('start', 'before');
      if (h.activeToken || h.startNoop) return 0;
      const token = open(); h.hooks.start?.(); fail('start', 'after'); return token;
    },
    stop() {
      h.stopCalls++; fail('stop', 'before');
      if (!h.activeToken || h.stopNoop) return;
      h.sample(); close(); h.hooks.stop?.(); fail('stop', 'after');
    },
    summary() { h.summaryCalls++; fail('summary', 'before'); h.hooks.summary?.(); return { totalSamples: h.report.totalSamples }; },
    snapshot() { h.snapshotCalls++; fail('snapshot', 'before'); h.hooks.snapshot?.(); return h.report; },
  };
  const spec = { sceneId: 'opening', fixtureSha256: FIXTURE, expectedRevision: REVISION,
    startEmulatedUs: 10000, actions: [action()], durationMs: 1000, maxWaitMs: 2000, maxLatenessUs: 100,
    performance: h.perf, readCore: () => { fail('core', 'before'); return h.core; },
    clock: () => { fail('clock', 'before'); return h.now; }, isVisible: () => { fail('visibility', 'before'); return h.visible; },
    setButtons(buttons) { h.buttons.push([...buttons]); h.held = [...buttons]; h.hooks.buttons?.(); fail('buttons', 'after'); },
    releaseButtons() { h.releases++; fail('release', 'before'); h.held = []; h.hooks.release?.(); },
    ...options };
  h.spec = spec;
  h.session = createBrowserSceneSession(spec);
  h.tick = (wallMs, emulatedUs, extra = {}) => {
    h.now = wallMs; h.core = core(emulatedUs, h.core.sequence + 2, extra); return h.session.pump();
  };
  h.runActions = () => {
    h.session.pump(); h.tick(100, 11000); h.tick(200, 12000);
  };
  return h;
}

function realHarness(options = {}) {
  const h = harness(options), timers = new Map(), frames = new Map();
  let next = 0;
  h.perf = globalThis.createPpssppPerformance({
    now: () => h.now, visible: () => h.visible, coreSource: () => ({ ...h.core, flips: h.core.sequence, vblanks: h.core.sequence }),
    source: () => ({ coreRevision: REVISION, settings: { resolution: 1, showFps: true, touch: true }, settingsApplied: true }),
    setInterval: fn => { const id = ++next; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
    requestFrame: fn => { const id = ++next; frames.set(id, fn); return id; }, cancelFrame: id => frames.delete(id),
  });
  h.session = createBrowserSceneSession({ ...h.spec, performance: h.perf });
  h.timers = timers; h.frames = frames;
  return h;
}

test('uses emulated time for actions and keeps the fixed recording window after actions finish', () => {
  const h = harness();
  assert.deepEqual(h.tick(0, 9000), { phase: 'waiting', reason: null });
  assert.equal(h.startCalls, 0);
  assert.equal(h.tick(50, 10000).phase, 'recording');
  assert.equal(h.tick(400, 10500).phase, 'recording');
  assert.deepEqual(h.buttons, []);
  h.tick(500, 11000); h.tick(600, 12000);
  assert.deepEqual(h.buttons, [['circle']]); assert.deepEqual(h.held, []);
  assert.equal(h.session.snapshot().scheduler.phase, 'completed');
  assert.equal(h.stopCalls, 0);
  assert.equal(h.tick(1050, 12500).phase, 'completed');
  const result = h.session.snapshot();
  assert.equal(result.reason, null); assert.equal(result.elapsedMs, 1000);
  assert.equal(result.performance.durationMs, 1000);
  assert.deepEqual(result.cleanup, { inputReleased: true, recordingStopped: true });
  assert.equal(result.scene.timeAligned, true); assert.equal(result.scene.visualConfirmed, false);
  assert.deepEqual(result.dispatches.map(edge => [edge.phase, edge.observedEmulatedUs]), [['down', 11000], ['up', 12000]]);
});

test('wait timeout and a late start never start a recorder or dispatch input', () => {
  const h = harness(); h.tick(0, 8000);
  assert.equal(h.tick(2001, 9000).reason, 'wait_timeout');
  assert.equal(h.startCalls, 0); assert.equal(h.stopCalls, 0);
  const late = harness();
  assert.equal(late.tick(0, 10101).reason, 'start_late');
  assert.equal(late.startCalls, 0); assert.deepEqual(late.buttons, []);
});

test('a recorder already active at arming is neither stopped nor exported', () => {
  const h = harness(); h.externalStart();
  assert.equal(h.session.pump().reason, 'existing_recording');
  assert.equal(h.startCalls, 0); assert.equal(h.stopCalls, 0); assert.equal(h.snapshotCalls, 0);
  assert.equal(h.activeToken, 1); assert.equal(h.session.snapshot().performance, null);
});

for (const stopped of [false, true]) {
  test(`start callback replacement stays unowned when replacement is ${stopped ? 'stopped' : 'active'}`, () => {
    const h = harness();
    h.hooks.start = () => { h.externalStop(); h.externalStart(); if (stopped) h.externalStop(); };
    assert.equal(h.session.pump().reason, 'recording_lost');
    assert.equal(h.stopCalls, 0); assert.equal(h.snapshotCalls, 0);
    assert.equal(h.session.snapshot().performance, null);
    assert.equal(h.activeToken, stopped ? 0 : 2);
  });
  test(`stop callback replacement is not exported when replacement is ${stopped ? 'stopped' : 'active'}`, () => {
    const h = harness({ actions: [] }); h.session.pump();
    h.hooks.stop = () => { h.externalStart(); h.report.coreRevision = 'c'.repeat(64); if (stopped) h.externalStop(); };
    assert.equal(h.tick(1000, 13000).reason, 'recording_lost');
    const result = h.session.snapshot();
    assert.equal(h.stopCalls, 1); assert.equal(result.performance.coreRevision, REVISION);
    assert.equal(result.performance.active, true);
    assert.equal(result.cleanup.recordingStopped, true);
    assert.equal(h.activeToken, stopped ? 0 : 2);
  });
}

test('external replacement during recording cannot be stopped or exported', () => {
  const h = harness(); h.session.pump();
  h.externalStop(); h.externalStart(); h.report.coreRevision = 'c'.repeat(64);
  assert.equal(h.tick(10, 10100).reason, 'recording_lost');
  assert.equal(h.stopCalls, 0); assert.equal(h.activeToken, 2);
  assert.equal(h.session.snapshot().performance.coreRevision, REVISION);
});

test('snapshot ownership is checked again after the adapter returns', () => {
  const h = harness(); h.hooks.snapshot = () => { h.externalStop(); h.externalStart(); };
  assert.equal(h.session.pump().reason, 'recording_lost');
  assert.equal(h.session.snapshot().performance, null); assert.equal(h.stopCalls, 0);
});

for (const when of ['before', 'after']) {
  test(`start throwing ${when} allocation cleans only a created owned recording`, () => {
    const h = harness(); h.failures.start = when;
    assert.equal(h.session.pump().reason, 'performance_start_failed');
    assert.equal(h.stopCalls, when === 'after' ? 1 : 0);
    assert.equal(h.activeToken, 0); assert.equal(h.session.snapshot().startedAtMs, null);
  });
  test(`stop throwing ${when} mutation reports actual recorder cleanup`, () => {
    const h = harness({ actions: [] }); h.session.pump(); h.failures.stop = when;
    assert.equal(h.tick(1000, 13000).reason, 'recording_stop_failed');
    assert.equal(h.session.snapshot().cleanup.recordingStopped, when === 'after');
    assert.equal(h.activeToken, when === 'after' ? 0 : 1);
  });
}

test('a no-op start and stop cannot appear successfully recorded or cleaned', () => {
  const h = harness(); h.startNoop = true;
  assert.equal(h.session.pump().reason, 'performance_not_started');
  assert.equal(h.stopCalls, 0);
  const stopping = harness({ actions: [] }); stopping.session.pump(); stopping.stopNoop = true;
  assert.equal(stopping.tick(1000, 13000).reason, 'recording_stop_failed');
  assert.equal(stopping.session.snapshot().cleanup.recordingStopped, false);
});

test('report read failure still stops an owned active recorder', () => {
  const h = harness(); h.session.pump(); h.failures.snapshot = 'before';
  assert.equal(h.session.cancel().reason, 'user_stopped');
  assert.equal(h.stopCalls, 1); assert.equal(h.activeToken, 0);
  assert.equal(h.session.snapshot().cleanup.recordingStopped, true);
});

test('report read failure on the initial sample does not leak the active recorder', () => {
  const h = harness(); h.failures.snapshot = 'before';
  assert.equal(h.session.pump().reason, 'performance_read_failed');
  assert.equal(h.stopCalls, 1); assert.equal(h.activeToken, 0);
});

test('failed input release still stops recording and preserves failure evidence', () => {
  const h = harness({ actions: [] }); h.session.pump(); h.failures.release = 'before';
  assert.equal(h.tick(1000, 13000).reason, 'input_release_failed');
  assert.deepEqual(h.session.snapshot().cleanup, { inputReleased: false, recordingStopped: true });
});

test('partial button dispatch is released on failure and not claimed as a successful dispatch', () => {
  const h = harness(); h.session.pump(); h.failures.buttons = 'after';
  assert.equal(h.tick(100, 11000).reason, 'input_dispatch_failed');
  assert.deepEqual(h.held, []); assert.deepEqual(h.session.snapshot().dispatches, []);
  assert.equal(h.activeToken, 0);
});

for (const [name, mutate, reason] of [
  ['pause', h => { h.core.emulating = false; }, 'core_paused'],
  ['uninitialized', h => { h.core.initialized = false; }, 'core_uninitialized'],
  ['time regression', h => { h.core.emulatedUs = 11999; }, 'emulated_time_regressed'],
  ['sequence regression', h => { h.core.sequence = 2; }, 'sequence_regressed'],
  ['inconsistent sequence', h => { h.core.emulatedUs++; }, 'inconsistent_sequence'],
  ['hidden page', h => { h.visible = false; }, 'page_hidden'],
  ['stale sample', h => { h.core.sampleAgeMs = 2501; }, 'stale_core_sample'],
  ['stalled core', h => { h.now = 3201; }, 'core_stalled'],
]) {
  test(`continues detecting ${name} after the final action`, () => {
    const h = harness({ durationMs: 10000 }); h.runActions(); h.now = 201; mutate(h);
    assert.equal(h.session.pump().reason, reason); assert.equal(h.stopCalls, 1);
    assert.equal(h.session.snapshot().scheduler.phase, 'completed');
  });
}

test('late and skipped pulses never generate catch-up input', () => {
  const late = harness(); late.session.pump();
  assert.equal(late.tick(100, 11101).reason, 'action_late'); assert.deepEqual(late.buttons, []);
  const skipped = harness(); skipped.session.pump();
  assert.equal(skipped.tick(100, 12000).reason, 'missed_pulse'); assert.deepEqual(skipped.buttons, []);
});

test('the fixed window rejects actions still pending and edges first observed at its endpoint', () => {
  for (const emulatedUs of [10500, 11000]) {
    const h = harness(); h.session.pump();
    assert.equal(h.tick(1000, emulatedUs).reason, 'actions_incomplete');
    assert.deepEqual(h.buttons, []); assert.equal(h.activeToken, 0);
  }
  const held = harness(); held.session.pump(); held.tick(100, 11000);
  assert.equal(held.tick(1000, 12000).reason, 'actions_incomplete');
  assert.deepEqual(held.held, []);
  assert.deepEqual(held.session.snapshot().dispatches.map(edge => edge.phase), ['down']);
});

for (const [name, mutate, reason] of [
  ['build identity', report => { report.coreRevision = 'c'.repeat(64); }, 'revision_mismatch'],
  ['resolution', report => { report.settings.resolution = 2; }, 'settings_mismatch'],
  ['launch settings', report => { report.settings.appliedAtLaunch = false; }, 'settings_mismatch'],
  ['sampling errors', report => { report.samplingErrors = 1; }, 'sampling_errors'],
  ['visibility changes', report => { report.visibilityChanges = 1; }, 'page_hidden'],
  ['first visibility', report => { report.samples[0].visible = false; }, 'start_sample_mismatch'],
  ['first alignment', report => { report.samples[0].core.emulatedUs = 10101; }, 'start_sample_mismatch'],
  ['first pause', report => { report.samples[0].core.emulating = false; }, 'start_sample_mismatch'],
  ['first freshness', report => { report.samples[0].core.sampleAgeMs = 2501; }, 'start_sample_mismatch'],
  ['first sequence', report => { report.samples[0].core.sequence = 3; }, 'start_sample_mismatch'],
  ['extra initial samples', report => { report.totalSamples = 2; }, 'start_sample_mismatch'],
]) {
  test(`validates ${name} before sending an action at the start boundary`, () => {
    const h = harness({ actions: [action(0)] }); h.hooks.start = () => mutate(h.report);
    assert.equal(h.session.pump().reason, reason); assert.deepEqual(h.buttons, []);
    assert.equal(h.stopCalls, 1); assert.equal(h.session.snapshot().scene.timeAligned, false);
  });
}

test('a later sample checks changed settings and visibility between animation frames', () => {
  for (const [mutate, reason] of [
    [report => { report.settings.touch = false; }, 'settings_changed'],
    [report => { report.visibilityChanges = 2; }, 'page_hidden'],
    [report => { report.samplingErrors++; }, 'sampling_errors'],
    [report => { report.coreRevision = 'c'.repeat(64); }, 'revision_mismatch'],
  ]) {
    const h = harness(); h.session.pump(); h.sample(); mutate(h.report);
    assert.equal(h.tick(10, 10100).reason, reason); assert.equal(h.activeToken, 0);
  }
});

test('unchanged sample counts keep the animation pump lightweight', () => {
  const h = harness({ actions: [] }); h.session.pump();
  const snapshots = h.snapshotCalls;
  for (let tick = 1; tick <= 20; tick++) assert.deepEqual(h.tick(tick, 10000 + tick), { phase: 'recording', reason: null });
  assert.equal(h.snapshotCalls, snapshots);
  h.sample(); h.tick(21, 10021);
  assert.equal(h.snapshotCalls, snapshots + 1);
});

test('input plans and adapter button arguments cannot mutate retained dispatch evidence', () => {
  const actions = [action()];
  const h = harness({ actions }); actions[0].buttons[0] = 'cross'; actions[0].atUs = 0;
  h.session.pump(); assert.deepEqual(h.buttons, []);
  h.tick(100, 11000); h.buttons[0].push('square');
  assert.deepEqual(h.session.snapshot().dispatches[0].buttons, ['circle']);
  assert.deepEqual(h.session.snapshot().scheduler.edges[0].buttons, ['circle']);
});

test('the final stop sample is validated and cannot hide a short recording', () => {
  const h = harness({ actions: [] }); h.session.pump();
  h.hooks.stop = () => { h.report.samplingErrors++; };
  assert.equal(h.tick(1000, 13000).reason, 'sampling_errors');
  const short = harness({ actions: [] }); short.session.pump();
  short.hooks.stop = () => { short.report.durationMs = 999; };
  assert.equal(short.tick(1000, 13000).reason, 'recording_duration_short');
});

test('snapshots detach nested reports and dispatches, and terminal calls cannot mutate the result', () => {
  const h = harness(); h.runActions();
  const running = h.session.snapshot(); running.performance.samples[0].core.emulatedUs = -1;
  running.dispatches[0].buttons.push('cross'); running.scheduler.edges[0].buttons.push('cross');
  assert.equal(h.session.snapshot().performance.samples[0].core.emulatedUs, 10000);
  assert.deepEqual(h.session.snapshot().dispatches[0].buttons, ['circle']);
  h.tick(1000, 13000);
  const final = h.session.snapshot(), stopCalls = h.stopCalls, releases = h.releases;
  h.report.samples[0].core.emulatedUs = 99; h.externalStart(); h.now = 2000; h.visible = false;
  h.session.pump(); h.session.cancel('page_left');
  assert.deepEqual(h.session.snapshot(), final); assert.equal(h.stopCalls, stopCalls); assert.equal(h.releases, releases);
});

test('cancellation reasons are bounded and a canceled waiting session does not touch a recorder', () => {
  const h = harness(); assert.equal(h.session.cancel('arbitrary-detail').reason, 'user_stopped');
  assert.equal(h.startCalls, 0); assert.equal(h.stopCalls, 0); assert.equal(h.session.snapshot().performance, null);
});

test('invalid contracts fail before adapters run', () => {
  for (const options of [{ durationMs: 0 }, { expectedRevision: 'bad' }, { sceneId: '../scene' },
    { fixtureSha256: 'bad' }, { actions: [action(-1)] }, { performance: {} }]) {
    assert.throws(() => harness(options), TypeError);
  }
});

test('synchronous cancellation from a start observer cannot revive a terminal session', () => {
  const h = harness(); h.hooks.start = () => h.session.cancel();
  assert.equal(h.session.pump().reason, 'user_stopped');
  assert.equal(h.session.snapshot().phase, 'invalid'); assert.equal(h.activeToken, 0);
  assert.equal(h.stopCalls, 1); assert.deepEqual(h.buttons, []);
});

test('synchronous cancellation while dispatching freezes the final report immediately', () => {
  const h = harness(); h.session.pump();
  let final;
  h.hooks.buttons = () => { h.session.cancel(); final = h.session.snapshot(); };
  assert.equal(h.tick(100, 11000).reason, 'user_stopped');
  assert.deepEqual(h.session.snapshot(), final); assert.deepEqual(h.held, []);
});

test('real sampler integration retains the final interval and stops all owned timer work', () => {
  const h = realHarness(); h.runActions();
  assert.equal(h.timers.size, 1); assert.equal(h.frames.size, 1);
  assert.equal(h.tick(1000, 13000).phase, 'completed');
  const result = h.session.snapshot();
  assert.equal(result.performance.active, false); assert.equal(result.performance.durationMs, 1000);
  assert.equal(result.performance.samples.at(-1).core.intervalValid, true);
  assert.equal(h.perf.token(), 0); assert.equal(h.perf.sessionToken(), 1);
  assert.equal(h.timers.size + h.frames.size, 0);
});

test('real sampler start subscribers cannot transfer another recording into the session', () => {
  const h = realHarness(); let replaced = false;
  const unsubscribe = h.perf.subscribe(state => {
    if (state.active && !replaced) { replaced = true; h.perf.stop(); h.perf.start(); }
  });
  assert.equal(h.session.pump().reason, 'recording_lost');
  assert.equal(h.session.snapshot().performance, null); assert.equal(h.perf.token(), 2);
  assert.equal(h.timers.size, 1); assert.equal(h.frames.size, 1);
  unsubscribe(); h.perf.stop();
});

test('real sampler stop subscribers cannot substitute another completed report', () => {
  const h = realHarness({ actions: [] }); h.session.pump(); let replaced = false;
  const unsubscribe = h.perf.subscribe(state => {
    if (!state.active && !replaced) { replaced = true; h.perf.start(); h.perf.stop(); }
  });
  assert.equal(h.tick(1000, 13000).reason, 'recording_lost');
  const result = h.session.snapshot();
  assert.equal(h.perf.sessionToken(), 2); assert.equal(h.perf.token(), 0);
  assert.equal(result.performance.active, true); assert.equal(result.cleanup.recordingStopped, true);
  assert.equal(h.timers.size + h.frames.size, 0); unsubscribe();
});

test('real sampler start observers can cancel the harness without leaked timers or input', () => {
  const h = realHarness({ actions: [action(0)] });
  const unsubscribe = h.perf.subscribe(state => { if (state.active) h.session.cancel(); });
  assert.equal(h.session.pump().reason, 'user_stopped');
  assert.equal(h.session.snapshot().phase, 'invalid'); assert.deepEqual(h.buttons, []);
  assert.equal(h.perf.token(), 0); assert.equal(h.timers.size + h.frames.size, 0); unsubscribe();
});
