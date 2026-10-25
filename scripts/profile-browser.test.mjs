import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parseOptions, selectPage, counterDelta, distribution, pageSnapshot, startPageSampling,
  stopPageSampling, summarize, connectCdp, startWorkerProfilers, run } from './profile-browser.mjs';

const page = (overrides = {}) => ({ type: 'page', title: 'An arbitrary running title', url: 'http://localhost:8080/',
  webSocketDebuggerUrl: 'ws://localhost/devtools/page/1', isPpsspp: true, ...overrides });

test('CLI rejects ambiguous options and accepts explicit low-disturbance capture', () => {
  const args = parseOptions(['--seconds', '1.5', '--target', 'https://example.test/player?a=1', '--no-profile', '--no-screenshot']);
  assert.equal(args.seconds, 1.5); assert.equal(args.profile, false); assert.equal(args.screenshot, false);
  assert.equal(args.target, 'https://example.test/player?a=1');
  assert.equal(parseOptions(['--trace-cpu']).traceCpu, true);
  assert.equal(parseOptions([]).traceCpu, false);
  for (const bad of [['--seconds'], ['--seconds', '--no-profile'], ['--seconds', 'NaN'], ['--seconds', '121'],
    ['--port', '0'], ['--port', '2.5'], ['--unknown'], ['--no-profile', '--no-profile'],
    ['--trace-cpu', '--no-profile'], ['--trace-cpu', '--trace-cpu'],
    ['--target', 'file:///player'], ['--target', 'https://name:secret@example.test/']]) assert.throws(() => parseOptions(bad));
});

test('runtime probe selects renamed game pages and never falls back to unrelated tabs', () => {
  const player = page();
  assert.equal(selectPage([page({ title: 'PPSSPP documentation', isPpsspp: false }), player]), player);
  assert.throws(() => selectPage([page({ isPpsspp: false })]), /No matching/);
  assert.throws(() => selectPage([player, page({ url: 'https://example.test/' })]), /2 matching/);
  assert.equal(selectPage([player, page({ url: 'https://example.test/' })], player.url), player);
  assert.throws(() => selectPage([player], player.url + '?a=1'), /No matching/);
  assert.throws(() => selectPage([player, page()], player.url), /2 matching/);
});

test('counter resets, unavailable readings and empty distributions remain unknown', () => {
  assert.equal(counterDelta(null, {}, ['n']), null);
  assert.deepEqual(counterDelta({ n: 8, x: 0, reset: 20 }, { n: 12, x: NaN, reset: 1 }, ['n', 'x', 'reset', 'missing']), { n: 4, x: null, reset: null, missing: null });
  assert.equal(distribution([]), null);
  assert.deepEqual(distribution([1, 4, 2, 3, NaN, -1]), { samples: 4, minMs: 1, p50Ms: 2, p95Ms: 4, p99Ms: 4, maxMs: 4 });
});

function environment() {
  let time = 100, frame, timer, observer, disconnected = false;
  const handlers = new Map();
  const context = vm.createContext({
    document: { visibilityState: 'visible', querySelector: () => null,
      addEventListener: (event, fn) => handlers.set(event, fn), removeEventListener: event => handlers.delete(event) },
    navigator: { userAgent: 'test browser', platform: 'test', hardwareConcurrency: 4 },
    screen: { width: 400, height: 800 }, innerWidth: 400, innerHeight: 780, devicePixelRatio: 2,
    performance: { now: () => time, timeOrigin: 1234 }, runtimeReady: true, runtimeFailed: false,
    requestAnimationFrame: fn => { frame = fn; return 1; }, cancelAnimationFrame: () => { frame = null; },
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
    PerformanceObserver: class {
      static supportedEntryTypes = ['longtask'];
      constructor(fn) { this.callback = fn; this.queued = []; observer = this; }
      observe() {} takeRecords() { const values = this.queued; this.queued = []; return values; }
      disconnect() { disconnected = true; }
    }, TextDecoder,
  });
  return { context, call: (fn, ...args) => vm.runInContext(`(${fn.toString()})(${args.map(x => JSON.stringify(x)).join(',')})`, context),
    tick: timestamp => { time = timestamp; frame(timestamp); }, advance: timestamp => { time = timestamp; },
    tasks: values => observer.callback({ getEntries: () => values }), queue: values => { observer.queued = values; },
    hide: () => { context.document.visibilityState = 'hidden'; handlers.get('visibilitychange')(); },
    show: () => { context.document.visibilityState = 'visible'; handlers.get('visibilitychange')(); },
    expire: () => timer(), cleaned: () => frame === null && timer === null && handlers.size === 0 && disconnected };
}

test('snapshots separate capacity from heap and reject absent or torn core snapshots', () => {
  const env = environment();
  let snapshot = env.call(pageSnapshot);
  assert.equal(snapshot.core, null); assert.equal(snapshot.memory.jsHeap, null);
  assert.equal(snapshot.hardware.deviceMemoryGB, null); assert.equal(snapshot.coreRevision, null);
  env.context.Module = { HEAPU8: new Uint8Array(1024), _ppssppGetPerformanceMetric: () => 1 };
  env.context.performance.memory = { usedJSHeapSize: 10, totalJSHeapSize: 20, jsHeapSizeLimit: 40 };
  snapshot = env.call(pageSnapshot);
  assert.equal(snapshot.core, null); assert.equal(snapshot.memory.wasmLinearMemoryCapacityBytes, 1024);
  assert.equal(snapshot.memory.jsHeap.usedBytes, 10); assert.equal(snapshot.memory.jsHeap.capacityBytes, 20);
  const slots = [1, 1, 30, 30, 100, 60, 600, 300, 10000000, 16, 2, 60, 1, 8];
  env.context.Module._ppssppGetPerformanceMetric = slot => slots[slot];
  env.context.BUILD_STAMP = 'a'.repeat(64);
  snapshot = env.call(pageSnapshot);
  assert.equal(snapshot.core.actualFps, 30); assert.equal(snapshot.core.actualFlipCount, 300);
  assert.equal(snapshot.coreRevision, 'a'.repeat(64)); assert.match(snapshot.core.lastFrameMeaning, /including waits/);
  let sequence = 0;
  env.context.Module._ppssppGetPerformanceMetric = slot => slot === 13 ? sequence += 2 : slots[slot];
  assert.equal(env.call(pageSnapshot).core, null);
});

test('snapshot settings keep only known numeric/boolean performance values', () => {
  const env = environment();
  const ini = '[General]\nForceLagSync2 = True\n[CPU]\nCPUCore=3\nFastMemory=False\n[Graphics]\nInternalResolution=2\nFrameSkip=2<script>\nDisplayRefreshRate=59.94\nCustomShader=private/path\n[PostShaderList]\n0=private/shader\n[Sound]\nEnable=True\nAudioLatency=Infinity\n[Network]\nAddress=private-host';
  env.context.Module = { FS: { stat: () => ({ size: ini.length }), readFile: () => new TextEncoder().encode(ini) } };
  env.context.PERSIST_ROOTS = ['/config']; env.context.BUILD_STAMP = 'unverified-string';
  env.context.PpssppBrowserFiles = { stats: () => ({ readCount: 2, lastError: { path: 'private-file', message: 'private-detail' } }) };
  const snapshot = env.call(pageSnapshot), serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /private|unverified|<script>|Infinity/);
  assert.equal(snapshot.settings.persistedIni[0].General.ForceLagSync2, true);
  assert.equal(snapshot.settings.persistedIni[0].CPU.FastMemory, false);
  assert.equal(snapshot.settings.persistedIni[0].Graphics.DisplayRefreshRate, 59.94);
  assert.equal(snapshot.settings.persistedIni[0].Graphics.FrameSkip, undefined);
  assert.equal(snapshot.buildStamp, undefined); assert.equal(snapshot.gameReads.hasReadError, true);
});

test('schema 2 snapshots read one consistent native resource payload and allowlist build metadata', () => {
  const env = environment();
  const MiB = 1024 * 1024;
  const slots = [2, 1, 30, 30, 100, 60, 600, 300, 10000000, 16, 2, 60, 1, 8,
    256 * MiB, 4096 * MiB, 2, 0, 2, 6, 2, 3, 2, 1, 14, 9, 384 * MiB];
  env.context.Module = { _ppssppGetPerformanceMetric: slot => slots[slot] };
  env.context.performanceBuildInfo = { initialMemoryBytes: 256 * MiB, maximumMemoryBytes: 4096 * MiB,
    computeThreads: 2, pthreadPoolSize: 0, sourceFingerprint: 'a'.repeat(64), secret: 'private-build-detail' };
  env.context.PpssppPerformance = { snapshot: () => ({ capacityObservations: { firstBytes: 256 * MiB,
    peakBytes: 384 * MiB, increases: 1, increaseBytes: 128 * MiB, detail: 'private-file' }, secret: 'private-report-detail' }) };
  const snapshot = env.call(pageSnapshot);
  assert.equal(snapshot.core.schemaVersion, 2); assert.equal(snapshot.resources.cpuBackend, 2);
  assert.equal(snapshot.resources.configuredPthreadPoolSize, 0); assert.equal(snapshot.resources.actualThreadManagerThreads, 6);
  assert.equal(snapshot.resources.completedHeapResizeRequests, 3); assert.equal(snapshot.resources.heapResizeFailures, 1);
  assert.equal(snapshot.resources.currentWasmCapacityBytes, 384 * MiB); assert.equal(snapshot.build.sourceFingerprint, 'a'.repeat(64));
  assert.equal(snapshot.capacityObservations.increases, 1); assert.doesNotMatch(JSON.stringify(snapshot), /private/);
  let sequence = 8;
  env.context.Module._ppssppGetPerformanceMetric = slot => slot === 13 ? sequence += 2 : slots[slot];
  const torn = env.call(pageSnapshot); assert.equal(torn.core, null); assert.equal(torn.resources, null);
});

test('optional exported build metadata is safe when sampling is absent or throws', () => {
  const env = environment();
  env.context.PpssppPerformance = { snapshot: () => ({ build: { initialMemoryBytes: 1, maximumMemoryBytes: 2,
    pthreadPoolSize: 0, computeThreads: 2, sourceFingerprint: 'private-unverified-fingerprint', sourcePath: 'private-path' } }) };
  const snapshot = env.call(pageSnapshot);
  assert.equal(snapshot.build.sourceFingerprint, null); assert.equal(snapshot.build.sourcePath, undefined);
  env.context.PpssppPerformance.snapshot = () => { throw new Error('not available'); };
  assert.equal(env.call(pageSnapshot).build, null);
});

test('page sampling flushes queued tasks and cleans up RAF, observer, watchdog and visibility listeners', () => {
  const env = environment();
  env.call(startPageSampling, '__test', 1);
  env.tick(110); env.tick(126); env.tick(159);
  env.tasks([{ startTime: 90, duration: 100 }, { startTime: 120, duration: 55 }]);
  env.queue([{ startTime: 180, duration: 60 }]);
  env.advance(200); env.hide(); env.advance(300);
  const result = env.call(stopPageSampling, '__test');
  assert.deepEqual(Array.from(result.raf.intervals), [16, 33]); assert.equal(result.longTasks.count, 2);
  assert.equal(result.longTasks.totalMs, 115); assert.equal(result.hiddenMs, 100);
  assert.equal(env.cleaned(), true); assert.equal(env.context.__test, undefined);
  assert.equal(env.call(stopPageSampling, '__test'), null);
});

test('sampling has bounded storage and auto-cleans a disconnected client', () => {
  const env = environment(); env.call(startPageSampling, '__test', 1);
  for (let i = 0; i < 20005; i++) env.tick(101 + i);
  const result = env.call(stopPageSampling, '__test');
  assert.equal(result.raf.intervals.length, 20000); assert.equal(result.raf.droppedSamples, 4);
  const second = environment(); second.call(startPageSampling, '__test', 1); second.expire();
  assert.equal(second.cleaned(), true); assert.equal(second.context.__test, undefined);
});

test('background transitions do not create fake RAF stalls or valid page rates', () => {
  const env = environment(); env.call(startPageSampling, '__test', 1);
  env.tick(110); env.tick(126); env.hide(); env.tick(1000); env.show(); env.tick(1010); env.tick(1026);
  const sample = env.call(stopPageSampling, '__test');
  assert.deepEqual(Array.from(sample.raf.intervals), [16, 16]);
  const endpoint = { timeOriginMs: 1, timestampMs: 1, visibility: 'visible' };
  const summary = summarize(endpoint, endpoint, sample);
  assert.equal(summary.foregroundThroughout, false); assert.equal(summary.pageRaf.observedRateHz, null);
  assert.equal(summary.pageRaf.intervalDistribution, null);
});

test('summary distinguishes core flips from page RAF and invalidates navigation/reset deltas', () => {
  const env = environment(); env.call(startPageSampling, '__test', 1); env.tick(110); env.tick(126); env.advance(1100);
  const sample = env.call(stopPageSampling, '__test');
  const before = { timeOriginMs: 1, timestampMs: 100, visibility: 'visible', core: { initialized: 1, emulating: 1, actualFlipCount: 10, sampleAgeMs: 0, sequence: 2 }, audio: { underruns: 4 }, gameReads: { readCount: 2 } };
  const after = { ...before, timestampMs: 1100, core: { ...before.core, actualFlipCount: 40, sequence: 4 }, audio: { underruns: 7 }, gameReads: { readCount: 10 } };
  let summary = summarize(before, after, sample);
  assert.equal(summary.coreAverageActualFps, 30); assert.equal(summary.pageRaf.observedRateHz, 62.5);
  assert.equal(summary.gameReadsDelta.readCount, 8); assert.equal(summary.audioDelta.underruns, 3);
  assert.match(summary.pageRaf.meaning, /NOT emulator/);
  assert.equal(summarize(before, { ...after, core: null }, sample).coreAverageActualFps, null);
  summary = summarize(before, { ...after, timeOriginMs: 2 }, sample);
  assert.equal(summary.coreDelta, null); assert.equal(summary.audioDelta, null); assert.equal(summary.foregroundThroughout, false);
  sample.raf.droppedSamples = 1; assert.equal(summarize(before, after, sample).pageRaf.intervalDistribution, null);
});

test('core FPS rejects stale, frozen, paused and background windows while preserving diagnostic deltas', () => {
  const env = environment(); env.call(startPageSampling, '__test', 1); env.advance(1100);
  const sample = env.call(stopPageSampling, '__test');
  const before = { timeOriginMs: 1, timestampMs: 100, visibility: 'visible', core: { initialized: 1, emulating: 1, actualFlipCount: 10, sampleAgeMs: 0, sequence: 2 } };
  const after = { ...before, timestampMs: 1100, core: { ...before.core, actualFlipCount: 40, sampleAgeMs: 2500, sequence: 4 } };
  assert.equal(summarize(before, after, sample).coreAverageActualFps, 30);
  for (const patch of [{ sampleAgeMs: 2500.01 }, { sampleAgeMs: -1 }, { sampleAgeMs: null }, { sampleAgeMs: NaN }, { sequence: 2 }, { sequence: 0 }, { sequence: undefined }, { emulating: 0 }]) {
    const result = summarize(before, { ...after, core: { ...after.core, ...patch } }, sample);
    assert.equal(result.coreAverageActualFps, null);
    assert.equal(result.coreDelta.actualFlipCount, 30);
  }
  assert.equal(summarize({ ...before, core: { ...before.core, sampleAgeMs: 2501 } }, after, sample).coreAverageActualFps, null);
  const frozen = summarize(before, { ...after, core: before.core }, sample);
  assert.equal(frozen.coreAverageActualFps, null); assert.equal(frozen.coreDelta.actualFlipCount, 0);
  for (const background of [{ ...sample, hiddenMs: 1 }, { ...sample, visibilityChanges: 2 }]) {
    const result = summarize(before, after, background);
    assert.equal(result.coreAverageActualFps, null); assert.equal(result.coreDelta.actualFlipCount, 30);
  }
});

test('resource summary counts completed resize requests and leaves reset deltas unknown', () => {
  const env = environment(); env.call(startPageSampling, '__test', 1); env.advance(1100);
  const sample = env.call(stopPageSampling, '__test');
  const before = { timeOriginMs: 1, timestampMs: 100, visibility: 'visible', resources: {
    completedHeapResizeRequests: 2, heapResizeSuccesses: 2, heapResizeFailures: 0, heapResizeTotalMs: 6 } };
  const after = { ...before, timestampMs: 1100, resources: {
    completedHeapResizeRequests: 5, heapResizeSuccesses: 4, heapResizeFailures: 1, heapResizeTotalMs: 16 } };
  const summary = summarize(before, after, sample);
  assert.deepEqual(summary.heapResizeDelta, { completedHeapResizeRequests: 3, heapResizeSuccesses: 2, heapResizeFailures: 1, heapResizeTotalMs: 10 });
  assert.match(summary.heapResizeMeaning, /not individual memory.grow/);
  assert.equal(summarize(before, { ...after, resources: { ...after.resources, completedHeapResizeRequests: 1 } }, sample).heapResizeDelta.completedHeapResizeRequests, null);
});

class FakeSocket extends EventTarget {
  static instances = [];
  constructor() { super(); this.sent = []; FakeSocket.instances.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(text) { this.sent.push(JSON.parse(text)); this.onSend?.(JSON.parse(text)); }
  reply(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  close() { this.dispatchEvent(new Event('close')); }
}

test('native CDP routes worker sessions and rejects outstanding calls on disconnect', async () => {
  const client = await connectCdp('ws://unused', { WebSocketImpl: FakeSocket, timeoutMs: 100 });
  const socket = FakeSocket.instances.at(-1);
  const first = client.command('one', {}, 'worker-session');
  const second = client.command('two');
  assert.equal(socket.sent[0].sessionId, 'worker-session');
  socket.reply({ id: socket.sent[1].id, result: { value: 2 }, sessionId: 'worker-session' });
  socket.reply({ id: socket.sent[0].id, result: { value: 1 } });
  assert.deepEqual(await first, { value: 1 }); assert.deepEqual(await second, { value: 2 });
  const pending = client.command('waiting'); socket.close();
  await assert.rejects(pending, /closed/); await assert.rejects(client.command('late'), /closed/);
});

test('CDP command deadlines can be shortened without closing other commands', async () => {
  const client = await connectCdp('ws://unused', { WebSocketImpl: FakeSocket, timeoutMs: 1000 });
  const socket = FakeSocket.instances.at(-1);
  try {
    const late = client.command('short', {}, 'worker', { timeoutMs: 10 });
    const normal = client.command('normal');
    await assert.rejects(late, /timeout: short/);
    socket.reply({ id: socket.sent[0].id, result: { ignoredLateReply: true } });
    socket.reply({ id: socket.sent[1].id, result: { ok: true } });
    assert.deepEqual(await normal, { ok: true });
    await assert.rejects(client.command('invalid', {}, undefined, { timeoutMs: 0 }), /positive integer/);
  } finally { client.close(); }
});

test('worker profiler keeps unavailable workers explicit and stops/detaches every observed worker', async () => {
  let listener; const calls = [];
  const client = { onEvent: fn => { listener = fn; return () => { listener = null; }; },
    async command(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.setAutoAttach' && params.autoAttach) for (const id of ['good', 'closed']) listener({ method: 'Target.attachedToTarget', params: { sessionId: id, targetInfo: { type: 'worker', targetId: 'target-' + id, url: 'https://private.invalid/worker' } } });
      if (sessionId === 'closed') throw new Error('worker closed');
      return method === 'Profiler.stop' ? { profile: { startTime: 1, endTime: 1001 } } : {};
    } };
  const capture = await startWorkerProfilers(client), report = await capture.finish();
  assert.deepEqual(report.workers.map(w => w.status), ['captured', 'unavailable']);
  assert.match(report.warning, /unmeasured, not idle/);
  assert.deepEqual(report.workers.map(w => w.targetId), ['target-good', 'target-closed']);
  assert.equal(JSON.stringify(report).includes('private.invalid'), false);
  assert.match(report.warning, /not CPU utilization/);
  assert.equal(listener, null); assert.equal(calls.at(-1).params.autoAttach, false);
  assert(calls.some(c => c.sessionId === 'closed' && c.method === 'Profiler.disable'));
  assert.equal(report.workers[1].failureStage, 'enable');
  assert.equal(report.workers[1].cleanupFailed, true);
});

test('worker finish stops independent targets concurrently, preserves per-target order and is idempotent', async () => {
  let listener; const calls = [], pending = new Map();
  const ids = ['slow', 'fast', 'lost'];
  const client = { onEvent: fn => { listener = fn; return () => { listener = null; }; },
    command(method, params, sessionId, options) {
      calls.push({ method, params, sessionId, options });
      if (method === 'Target.setAutoAttach' && params.autoAttach) for (const id of ids) listener({ method: 'Target.attachedToTarget',
        params: { sessionId: id, targetInfo: { type: 'worker', targetId: 'target-' + id } } });
      if (sessionId && ['Profiler.stop', 'Profiler.disable'].includes(method)) return new Promise((resolve, reject) => {
        pending.set(`${sessionId}:${method}`, { resolve, reject });
      });
      return Promise.resolve({});
    } };
  const capture = await startWorkerProfilers(client, { commandTimeoutMs: 25 });
  const first = capture.finish(), second = capture.finish();
  assert.equal(first, second, 'concurrent cleanup callers reuse one promise');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => call.method === 'Profiler.stop').map(call => call.sessionId), ids);
  assert.equal(calls.some(call => call.method === 'Profiler.disable'), false);
  pending.get('fast:Profiler.stop').resolve({ profile: { startTime: 1, endTime: 1001 } });
  pending.get('lost:Profiler.stop').reject(new Error('target detached'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pending.has('fast:Profiler.disable'), 'a slow target cannot delay another target cleanup');
  assert.ok(pending.has('lost:Profiler.disable'), 'failed stops still attempt cleanup');
  assert.equal(pending.has('slow:Profiler.disable'), false, 'disable follows stop on its own target');
  pending.get('fast:Profiler.disable').resolve({});
  pending.get('lost:Profiler.disable').reject(new Error('target detached'));
  pending.get('slow:Profiler.stop').resolve({ profile: { startTime: 1, endTime: 1002 } });
  await new Promise(resolve => setImmediate(resolve));
  pending.get('slow:Profiler.disable').resolve({});
  const report = await first;
  assert.deepEqual(report.workers.map(worker => worker.targetId), ids.map(id => 'target-' + id));
  assert.deepEqual(report.workers.map(worker => worker.status), ['captured', 'captured', 'unavailable']);
  assert.equal(report.workers[2].failureStage, 'stop'); assert.equal(report.workers[2].cleanupFailed, true);
  assert.equal(capture.finish(), first, 'completed cleanup is also idempotent');
  assert.equal(calls.filter(call => call.method === 'Profiler.stop').length, 3);
  assert.equal(calls.filter(call => call.method === 'Profiler.disable').length, 3);
  assert.ok(calls.every(call => call.options.timeoutMs === 25));
  assert.equal(listener, null); assert.equal(calls.at(-1).params.autoAttach, false);
});

test('lost CDP connection settles all worker stops without serial timeout retries', async () => {
  const client = await connectCdp('ws://unused', { WebSocketImpl: FakeSocket, timeoutMs: 1000 });
  const socket = FakeSocket.instances.at(-1);
  socket.onSend = message => {
    if (message.method === 'Target.setAutoAttach' && message.params.autoAttach) for (const id of ['one', 'two']) {
      socket.reply({ method: 'Target.attachedToTarget', params: { sessionId: id, targetInfo: { type: 'worker', targetId: id } } });
    }
    if (message.method !== 'Profiler.stop') socket.reply({ id: message.id, result: {} });
  };
  try {
    const capture = await startWorkerProfilers(client, { commandTimeoutMs: 100 });
    const finishing = capture.finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(socket.sent.filter(message => message.method === 'Profiler.stop').length, 2);
    socket.close();
    const report = await finishing;
    assert.ok(report.workers.every(worker => worker.status === 'unavailable' && worker.failureStage === 'stop' && worker.cleanupFailed));
    assert.equal(await capture.finish(), report);
    assert.equal(socket.sent.filter(message => message.method === 'Profiler.stop').length, 2);
  } finally { client.close(); }
});

test('no-profile run emits anonymous metrics without any Profiler or Target commands', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'ppsspp-profile-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const env = environment(), calls = [];
  class PageSocket extends FakeSocket {
    constructor() {
      super(); this.onSend = message => {
        calls.push(message.method);
        const value = vm.runInContext(message.params.expression, env.context);
        this.reply({ id: message.id, result: { result: { value } } });
      };
    }
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [page()] }));
  const previousSocket = globalThis.WebSocket;
  globalThis.WebSocket = PageSocket;
  t.after(() => { globalThis.WebSocket = previousSocket; });
  await run({ seconds: 1, port: 9222, output: join(folder, 'sample'), target: page().url, profile: false, screenshot: false });
  assert(calls.every(method => method === 'Runtime.evaluate'));
  assert.deepEqual(await readdir(folder), ['sample.json']);
  const report = JSON.parse(await readFile(join(folder, 'sample.json'), 'utf8'));
  assert.equal(report.cpuProfiler.enabled, false); assert.equal(report.cpuProfiler.workers, null);
  assert.equal(report.before.core, null); assert.equal(report.summary.coreAverageActualFps, null);
  assert.equal(report.title, undefined); assert.equal(report.page, undefined);
});

test('run stops workers while main stop is pending and does not retry a failed main stop', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'ppsspp-profile-stop-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const env = environment(), calls = []; let mainStop;
  class PageSocket extends FakeSocket {
    constructor() {
      super(); this.onSend = message => {
        calls.push(message);
        if (message.method === 'Runtime.evaluate') {
          const value = vm.runInContext(message.params.expression, env.context);
          this.reply({ id: message.id, result: { result: { value } } });
        } else if (message.method === 'Target.setAutoAttach' && message.params.autoAttach) {
          this.reply({ method: 'Target.attachedToTarget', params: { sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'worker-id' } } });
          this.reply({ id: message.id, result: {} });
        } else if (message.method === 'Profiler.stop' && !message.sessionId) {
          mainStop = message;
        } else if (message.method === 'Profiler.stop') {
          assert.ok(mainStop, 'worker stop is issued before the pending main stop completes');
          this.reply({ id: mainStop.id, error: { message: 'main target gone' } });
          this.reply({ id: message.id, result: { profile: { startTime: 1, endTime: 1001 } } });
        } else this.reply({ id: message.id, result: {} });
      };
    }
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => [page()] }));
  const previousSocket = globalThis.WebSocket; globalThis.WebSocket = PageSocket;
  t.after(() => { globalThis.WebSocket = previousSocket; });
  await assert.rejects(run({ seconds: 1, port: 9222, output: join(folder, 'sample'), target: page().url, profile: true, screenshot: false }), /main target gone/);
  assert.equal(calls.filter(call => call.method === 'Profiler.stop' && !call.sessionId).length, 1);
  assert.equal(calls.filter(call => call.method === 'Profiler.stop' && call.sessionId === 'worker').length, 1);
  assert.equal(calls.filter(call => call.method === 'Profiler.disable' && call.sessionId === 'worker').length, 1);
  assert.equal(calls.filter(call => call.method === 'Target.setAutoAttach' && !call.params.autoAttach).length, 1);
});

test('an unavailable debugging browser fails before any page or profiler connection', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('connection refused'); });
  await assert.rejects(run({ port: 9222 }), /Cannot reach browser DevTools.*check the debugging browser/);
});

test('trace mode uses the browser stream, records its identity and never starts per-worker profilers', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'ppsspp-browser-trace-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const env = environment(), calls = [];
  class TraceSocket extends FakeSocket {
    constructor(url) {
      super(); this.onSend = message => {
        calls.push({ url, ...message });
        let result = {};
        if (message.method === 'Runtime.evaluate') {
          result = { result: { value: vm.runInContext(message.params.expression, env.context) } };
        } else if (message.method === 'Target.getTargets') {
          result = { targetInfos: [{ type: 'page', targetId: 'player' }, { type: 'worker', targetId: 'worker' }] };
        } else if (message.method === 'Tracing.end') {
          this.reply({ method: 'Tracing.tracingComplete', params: { stream: 'trace', dataLossOccurred: false } });
        } else if (message.method === 'IO.read') {
          result = { data: '{"traceEvents":[]}', eof: true };
        }
        this.reply({ id: message.id, result });
      };
    }
  }
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => url.endsWith('/json/version')
    ? { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' } : [page({ id: 'player' })] }));
  const previousSocket = globalThis.WebSocket; globalThis.WebSocket = TraceSocket;
  t.after(() => { globalThis.WebSocket = previousSocket; });
  const output = join(folder, 'capture');
  await run({ seconds: 1, port: 9222, output, target: page().url, profile: true, traceCpu: true, screenshot: false });
  const report = JSON.parse(await readFile(output + '.json', 'utf8'));
  assert.equal(report.cpuProfiler.mode, 'trace'); assert.equal(report.cpuProfiler.intervalUs, null);
  assert.equal(report.cpuProfiler.workers, null); assert.equal(report.cpuProfiler.traceMetadata.status, 'captured');
  assert.equal(report.cpuProfiler.traceMetadata.dataLossOccurred, false);
  assert.ok(calls.filter(call => call.method.startsWith('Tracing.') || call.method.startsWith('IO.')).every(call => call.url.includes('/browser/')));
  assert.equal(calls.some(call => call.method.startsWith('Profiler.') || call.method === 'Target.setAutoAttach'), false);
  assert.deepEqual((await readdir(folder)).sort(), ['capture.json', 'capture.trace-meta.json', 'capture.trace.json']);
});

test('failed page capture starts trace cleanup before waiting for unresponsive page cleanup', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'ppsspp-trace-cleanup-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const env = environment(), calls = []; let traceEndedBeforeCleanup = false, cleanupRequested = false, cleanupTimer;
  t.after(() => clearTimeout(cleanupTimer));
  class CleanupSocket extends FakeSocket {
    constructor() {
      super(); this.onSend = message => {
        calls.push(message.method);
        let result = {};
        if (message.method === 'Runtime.evaluate') {
          const expression = message.params.expression;
          if (expression.includes('function startPageSampling')) {
            this.reply({ id: message.id, error: { message: 'page sampler startup failed' } }); return;
          }
          if (expression.includes('function stopPageSampling')) {
            cleanupRequested = true; traceEndedBeforeCleanup = calls.includes('Tracing.end');
            // Hold this cleanup request briefly, then fail it, without waiting
            // for the production 30-second command timeout.
            cleanupTimer = setTimeout(() => this.reply({ id: message.id, error: { message: 'page cleanup unavailable' } }), 20);
            return;
          }
          result = { result: { value: vm.runInContext(expression, env.context) } };
        } else if (message.method === 'Target.getTargets') {
          result = { targetInfos: [{ type: 'page', targetId: 'player' }] };
        } else if (message.method === 'Tracing.end') {
          this.reply({ method: 'Tracing.tracingComplete', params: { stream: 'trace', dataLossOccurred: false } });
        }
        this.reply({ id: message.id, result });
      };
    }
  }
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => url.endsWith('/json/version')
    ? { webSocketDebuggerUrl: 'ws://localhost/devtools/browser/test' } : [page({ id: 'player' })] }));
  const previousSocket = globalThis.WebSocket; globalThis.WebSocket = CleanupSocket;
  t.after(() => { globalThis.WebSocket = previousSocket; });
  const output = join(folder, 'capture');
  await assert.rejects(run({ seconds: 1, port: 9222, output, target: page().url, profile: true, traceCpu: true, screenshot: false }), /page sampler startup failed/);
  assert.equal(cleanupRequested, true); assert.equal(traceEndedBeforeCleanup, true);
  assert.equal(calls.filter(method => method === 'Tracing.end').length, 1);
  assert.equal(calls.filter(method => method === 'IO.close').length, 1);
  assert.equal(JSON.parse(await readFile(output + '.trace-meta.json', 'utf8')).status, 'failed');
  assert.equal((await readdir(folder)).includes('capture.json'), false);
});
