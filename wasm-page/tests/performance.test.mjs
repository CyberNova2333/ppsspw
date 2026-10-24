import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/performance.js';
import '../public/browser-files.js';

function fixture(extra = {}) {
  let time = 0, hidden = false, next = 0;
  const timers = new Map(), frames = new Map();
  const core = { initialized: true, emulating: true, sequence: 2, vblanks: 0, flips: 0, emulatedUs: 0,
    frameWallMs: 16, sampleAgeMs: 1, targetVps: 59.94 };
  const perf = globalThis.createPpssppPerformance({
    now: () => time, visible: () => !hidden, coreSource: () => ({ ...core }),
    setInterval: fn => { const id = ++next; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id),
    requestFrame: fn => { const id = ++next; frames.set(id, fn); return id; },
    cancelFrame: id => frames.delete(id), ...extra,
  });
  return { perf, core, timers, frames,
    hide(value) { hidden = value; },
    advance(ms) { time += ms; },
    tick(ms = 1000) { time += ms; for (const fn of timers.values()) fn(); },
    frame(ms = 16) { time += ms; const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(time); },
  };
}

test('sampling is opt-in, start is idempotent and stop cancels all work', () => {
  let reads = 0;
  const f = fixture({ source: () => { reads++; return {}; } });
  assert.equal(reads, 0);
  assert.equal(f.perf.token(), 0);
  assert.equal(f.timers.size + f.frames.size, 0);
  f.perf.start(); f.perf.start();
  assert.equal(reads, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.frames.size, 1);
  f.tick(); f.perf.stop(); f.perf.stop(); f.tick();
  assert.equal(reads, 3);
  assert.equal(f.timers.size + f.frames.size, 0);
  assert.equal(f.perf.snapshot().totalSamples, 3);
});

test('core FPS and emulation speed use counter deltas, independent of page refresh', () => {
  const f = fixture(); f.perf.start();
  for (let i = 0; i < 120; i++) f.frame(1000 / 120);
  Object.assign(f.core, { sequence: 4, vblanks: 60, flips: 30, emulatedUs: 1_000_000 });
  f.tick(0);
  const sample = f.perf.snapshot().samples.at(-1);
  assert.equal(sample.pageHz, 120);
  assert.equal(sample.core.actualFps, 30);
  assert.equal(sample.core.speedPercent, 100);
  assert.equal(sample.core.vps, 60);
});

test('paused, hidden, stale and reset core samples do not report misleading rates', () => {
  const f = fixture(); f.perf.start();
  const check = () => { f.tick(); assert.equal(f.perf.snapshot().core.actualFps, null); };
  check(); // unchanged sequence
  f.core.sequence = 4; f.core.emulating = false; check();
  f.core.sequence = 6; f.core.emulating = true; check(); // resume establishes baseline
  f.core.sequence = 8; f.core.sampleAgeMs = 3000; check();
  f.core.sequence = 10; f.core.sampleAgeMs = 0; f.hide(true); check();
  f.core.sequence = 12; f.hide(false); check();
  f.core.sequence = 2; check(); // game reset
});

test('core reader rejects torn snapshots and does not expose other core fields', () => {
  const slots = [1, 1, 30, 30, 100, 60, 60, 30, 1_000_000, 16, 1, 59.94, 1, 2];
  const module = { _ppssppGetPerformanceMetric: slot => slots[slot] };
  assert.equal(globalThis.readPpssppCorePerformance(module).flips, 30);
  let sequence = 0;
  module._ppssppGetPerformanceMetric = slot => slot === 13 ? (sequence += 2) : slots[slot];
  assert.equal(globalThis.readPpssppCorePerformance(module), null);
  assert.equal(globalThis.readPpssppCorePerformance({}), null);
});

test('returning from a background tab resets frame and core interval baselines', () => {
  const document = new EventTarget();
  const f = fixture({ document }); f.perf.start(); f.frame(16); f.frame(16);
  document.dispatchEvent(new Event('visibilitychange')); // the browser may freeze timers entirely
  f.advance(30000);
  document.dispatchEvent(new Event('visibilitychange'));
  f.frame(16); f.frame(16);
  Object.assign(f.core, { sequence: 4, flips: 60, emulatedUs: 2_000_000 });
  f.tick(0);
  const report = f.perf.snapshot();
  assert.equal(report.pageFrameIntervals.count, 2);
  assert.equal(report.pageFrameIntervals.maxMs, 16);
  assert.equal(report.core.actualFps, null);
  f.perf.stop();
});

test('ISO timing has bounded aggregates and ignores operations crossing recording sessions', () => {
  const f = fixture(); f.perf.start();
  const old = f.perf.token();
  f.perf.recordIO('request', old, 12, 2048);
  f.perf.recordIO('queue', old, 2);
  f.perf.recordIO('physical', old, 7, 262144);
  let report = f.perf.snapshot();
  assert.equal(report.iso.requestLatency.p95UpperBoundMs, 16);
  assert.equal(report.iso.physicalBytes, 262144);
  assert.equal(report.iso.queueLatency.count, 1);
  f.perf.stop(); f.perf.start();
  f.perf.recordIO('request', old, 200, 2048, true);
  for (let i = 0; i < 10000; i++) f.perf.recordIO('request', f.perf.token(), 1500, 0, true);
  report = f.perf.snapshot();
  assert.equal(report.iso.requestLatency.count, 10000);
  assert.equal(report.iso.requestLatency.buckets.length, 12);
  assert.equal(report.iso.requestLatency.p95UpperBoundMs, null); // overflow is explicit, not a false upper bound
  assert.equal(report.iso.failures, 10000);
});

test('exports allowlist numeric samples, retain only bounded history and never claim first frame', () => {
  const privateValue = 'private-game.iso https://private.invalid/?key=secret';
  const f = fixture({ maxSamples: 3, source: () => ({
    filename: privateValue, logs: privateValue, config: privateValue,
    wasmMemoryBytes: 536870912, io: { readCount: 3, lastError: { path: privateValue }, readBytes: privateValue },
    audio: { callbacks: 7, path: privateValue },
  }) });
  f.perf.mark('launchClick'); f.advance(100); f.perf.mark('runtimeReady');
  f.advance(300); f.perf.mark('gameBooted'); f.perf.mark(privateValue);
  f.perf.start();
  for (let i = 0; i < 20; i++) f.tick();
  const report = f.perf.snapshot();
  assert.equal(report.samples.length, 3);
  assert.equal(report.totalSamples, 21);
  assert.equal(report.startup.runtimeReadyMs, 100);
  assert.equal(report.startup.gameBootedMs, 400);
  assert.equal(report.startup.firstFrameMs, null);
  assert.equal(report.samples[0].io.readBytes, null);
  assert.equal(JSON.stringify(report).includes(privateValue), false);
  report.samples[0].io.readCount = 999;
  report.core.available = false;
  assert.equal(f.perf.snapshot().samples[0].io.readCount, 3);
  assert.equal(f.perf.snapshot().core.available, true);
});

test('long-task observation exists only during recording and is disconnected on stop', () => {
  let callback, connected = 0, disconnected = 0;
  class Observer {
    static supportedEntryTypes = ['longtask'];
    constructor(fn) { callback = fn; }
    observe(options) { assert.equal(options.buffered, false); connected++; }
    disconnect() { disconnected++; }
  }
  const f = fixture({ PerformanceObserver: Observer });
  assert.equal(connected, 0);
  f.perf.start();
  callback({ getEntries: () => [{ startTime: 1, duration: 70, name: 'private' }] });
  f.perf.stop();
  callback({ getEntries: () => [{ startTime: 2, duration: 80 }] });
  assert.equal(disconnected, 1);
  assert.equal(f.perf.snapshot().longTasks.count, 1);
});

test('stop captures the subsecond tail and pending long tasks, then freezes duration', () => {
  class Observer {
    static supportedEntryTypes = ['longtask'];
    observe() {}
    disconnect() {}
    takeRecords() { return [{ startTime: 100, duration: 60 }]; }
  }
  const audio = { callbacks: 10 };
  const f = fixture({ PerformanceObserver: Observer, source: () => ({ audio }) });
  f.perf.mark('launchClick'); f.perf.start(); f.advance(300); audio.callbacks = 15; f.perf.stop();
  const report = f.perf.snapshot();
  assert.equal(report.durationMs, 300);
  assert.equal(report.samples.at(-1).elapsedMs, 300);
  assert.equal(report.audioTotals.callbacks, 5);
  assert.equal(report.longTasks.count, 1);
  f.advance(10000);
  f.perf.mark('runtimeReady'); f.perf.mark('gameBooted');
  assert.deepEqual(f.perf.snapshot(), report);
});

test('reproduction metadata only accepts artifact hashes and whitelisted preferences', () => {
  const data = { coreRevision: 'a'.repeat(64), settings: { resolution: 2, touch: true, showFps: false, private: 'secret' }, settingsApplied: true };
  const f = fixture({ source: () => data }); f.perf.start();
  assert.equal(f.perf.snapshot().coreRevision, 'a'.repeat(64));
  assert.equal(f.perf.snapshot().webVersion, 'ppsspp-player-v6');
  assert.deepEqual(f.perf.snapshot().settings, { resolution: 2, touch: true, showFps: false, appliedAtLaunch: true });
  data.coreRevision = 'https://private.invalid/?token=secret';
  data.settings.resolution = 999; f.tick();
  assert.equal(f.perf.snapshot().coreRevision, null);
  assert.equal(f.perf.snapshot().settings.resolution, null);
  assert.equal(JSON.stringify(f.perf.snapshot()).includes('secret'), false);
});

test('audio deltas exclude pre-recording counters and tolerate counter resets', () => {
  const audio = { underruns: 100, droppedFrames: 200, callbacks: 300 };
  const f = fixture({ source: () => ({ audio }) });
  f.perf.start();
  audio.underruns += 2; audio.droppedFrames += 4; audio.callbacks += 40;
  f.tick();
  assert.deepEqual(f.perf.snapshot().samples.at(-1).audioDelta, { underruns: 2, droppedFrames: 4, callbacks: 40 });
  audio.underruns = 0; audio.droppedFrames = 0; audio.callbacks = 0;
  f.tick();
  assert.deepEqual(f.perf.snapshot().samples.at(-1).audioDelta, { underruns: null, droppedFrames: null, callbacks: null });
  assert.deepEqual(f.perf.snapshot().audioTotals, { underruns: 2, droppedFrames: 4, callbacks: 40 });
});

test('browser file reads report request and physical latency without passing paths', async () => {
  const original = globalThis.PpssppPerformance;
  const f = fixture(); globalThis.PpssppPerformance = f.perf;
  try {
    const files = globalThis.createPpssppBrowserFiles({ blockBytes: 32, cacheBytes: 64 });
    files.register('/browser-games/private.iso', new Blob(['sample bytes']));
    await files.read('/browser-games/private.iso', 0, 3);
    assert.equal(f.perf.snapshot().iso.requestLatency.count, 0);
    f.perf.start();
    await files.read('/browser-games/private.iso', 0, 3); // cached
    files.register('/browser-games/other.iso', new Blob(['different bytes']));
    await files.read('/browser-games/other.iso', 0, 3);
    const report = f.perf.snapshot();
    assert.equal(report.iso.requestLatency.count, 2);
    assert.equal(report.iso.physicalLatency.count, 1);
    assert.equal(report.iso.requestBytes, 6);
    assert.equal(JSON.stringify(report).includes('.iso'), false);
  } finally { f.perf.stop(); globalThis.PpssppPerformance = original; }
});

test('schema 2 reads native resources with the same snapshot boundary', () => {
  const slots = [2, 1, 30, 30, 100, 60, 60, 30, 1_000_000, 16, 1, 59.94, 1, 2,
    268435456, 4294967296, 2, 12, 2, 6, 2, 3, 2, 1, 0.75, 0.5, 335544320];
  const module = { _ppssppGetPerformanceMetric: slot => slots[slot] };
  const core = globalThis.readPpssppCorePerformance(module);
  assert.equal(core.resources.currentWasmCapacityBytes, 335544320);
  assert.equal(core.resources.completedHeapResizeRequests, 3);
  assert.equal(core.resources.heapResizeTotalMs, 0.75);
  assert.equal(core.resources.actualThreadManagerThreads, 6);
  // Publication changing while reading the appended fields invalidates all fields.
  module._ppssppGetPerformanceMetric = slot => { if (slot === 26) slots[13] += 2; return slots[slot]; };
  assert.equal(globalThis.readPpssppCorePerformance(module), null);
});

test('capacity observations cannot claim exact growth counts or duration, and reset between recordings', () => {
  const f = fixture({ source: () => ({ wasmMemoryBytes: 1 }) });
  f.core.resources = { currentWasmCapacityBytes: 256, heapResizeTotalMs: 2, private: 'secret' };
  f.perf.start();
  f.core.resources.currentWasmCapacityBytes = 512;
  f.core.resources.heapResizeTotalMs = 7; f.tick();
  f.tick();
  f.core.resources.currentWasmCapacityBytes = 768; f.tick(); f.perf.stop();
  const report = f.perf.snapshot();
  assert.deepEqual(report.capacityObservations, { firstBytes: 256, peakBytes: 768, increases: 2, increaseBytes: 512 });
  assert.equal(report.resources.heapResizeTotalMs, 7);
  assert.equal(report.wasmMemoryBytes, 768); // native view wins over stale main-thread HEAPU8
  assert.equal(report.samples[0].core.emulatedUs, 0);
  assert.equal(JSON.stringify(report).includes('secret'), false);
  report.samples[0].resources.currentWasmCapacityBytes = 999;
  assert.equal(f.perf.snapshot().samples[0].resources.currentWasmCapacityBytes, 256);
  f.perf.start();
  assert.deepEqual(f.perf.snapshot().capacityObservations, { firstBytes: 768, peakBytes: 768, increases: 0, increaseBytes: 0 });
  f.perf.stop();
});

test('build provenance exports only numeric resource configuration and a SHA-256 fingerprint', () => {
  const data = { build: { initialMemoryBytes: 268435456, maximumMemoryBytes: 4294967296,
    pthreadPoolSize: 12, computeThreads: 2, sourceFingerprint: 'b'.repeat(64), privatePath: 'secret' } };
  const f = fixture({ source: () => data }); f.perf.start();
  assert.deepEqual(f.perf.snapshot().build, { initialMemoryBytes: 268435456, maximumMemoryBytes: 4294967296,
    pthreadPoolSize: 12, computeThreads: 2, sourceFingerprint: 'b'.repeat(64) });
  data.build.sourceFingerprint = 'secret'; data.build.initialMemoryBytes = 'secret'; f.tick();
  assert.equal(f.perf.snapshot().build.sourceFingerprint, null);
  assert.equal(f.perf.snapshot().build.initialMemoryBytes, null);
  assert.equal(JSON.stringify(f.perf.snapshot()).includes('secret'), false);
  f.perf.stop();
});
