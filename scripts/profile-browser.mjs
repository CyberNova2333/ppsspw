#!/usr/bin/env node
// Measure an already running PPSSPP page with Node 22+ and native Chrome CDP.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'node scripts/profile-browser.mjs [--port 9222] [--seconds 20] [--out artifacts/browser-profile] [--target <exact URL>] [--no-profile] [--no-screenshot]';
export function parseOptions(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--port', '--seconds', '--out', '--target', '--no-profile', '--no-screenshot'].includes(key) || Object.hasOwn(values, key)) throw new Error(`Invalid or repeated option. Usage: ${USAGE}`);
    if (key.startsWith('--no-')) values[key] = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing option value. Usage: ${USAGE}`); values[key] = value; }
  }
  const seconds = Number(values['--seconds'] ?? 20), port = Number(values['--port'] ?? 9222);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Usage: ${USAGE}`);
  if (values['--target']) {
    const url = new URL(values['--target']);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('--target requires an HTTP(S) URL without credentials.');
  }
  return { seconds, port, output: resolve(values['--out'] ?? 'artifacts/browser-profile'), target: values['--target'] ?? null,
    profile: !values['--no-profile'], screenshot: !values['--no-screenshot'] };
}

export function selectPage(pages, target = null) {
  const matches = pages.filter(p => p.type === 'page' && /^https?:\/\//.test(p.url || '') && (target ? p.url === target : p.isPpsspp === true));
  if (matches.length !== 1) throw new Error(matches.length ? `Found ${matches.length} matching pages; use --target with one unique exact URL.` : 'No matching PPSSPP page. Open the player or specify --target.');
  if (!matches[0].webSocketDebuggerUrl) throw new Error('Selected page has no DevTools WebSocket.');
  return matches[0];
}

export function counterDelta(before, after, keys) {
  if (!before || !after) return null;
  return Object.fromEntries(keys.map(key => [key, Number.isFinite(before[key]) && Number.isFinite(after[key]) && before[key] >= 0 && after[key] >= before[key] ? after[key] - before[key] : null]));
}
export function distribution(samples) {
  const sorted = samples.filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { samples: sorted.length, minMs: sorted[0], p50Ms: rank(.5), p95Ms: rank(.95), p99Ms: rank(.99), maxMs: sorted.at(-1) };
}

// These functions run in the page. Only bounded statistics and configuration are read, never game file contents.
export function pageSnapshot() {
  const m = globalThis.Module, finite = x => Number.isFinite(x) ? x : null;
  const safe = fn => { try { return fn(); } catch { return null; } };
  let core = null;
  if (typeof m?._ppssppGetPerformanceMetric === 'function') safe(() => {
    const read = slot => m._ppssppGetPerformanceMetric(slot);
    for (let attempt = 0; attempt < 3; attempt++) {
      const sequence = read(13);
      if (!Number.isSafeInteger(sequence) || sequence % 2) continue;
      const values = Array.from({ length: 13 }, (_, slot) => read(slot));
      if (read(13) !== sequence || values[0] !== 1 || !values.every(Number.isFinite)) continue;
      const names = ['schemaVersion', 'initialized', 'actualFps', 'targetFps', 'speedPercent', 'vps', 'vblankCount', 'actualFlipCount', 'emulatedTimeUs', 'lastFrameMs', 'sampleAgeMs', 'targetVps', 'emulating'];
      core = { ...Object.fromEntries(names.map((key, i) => [key, values[i]])), sequence,
        lastFrameMeaning: 'NativeFrame wall time including waits; not CPU cost or a frame-time distribution' };
      break;
    }
  });
  const canvas = document.querySelector('canvas'), rect = canvas?.getBoundingClientRect(), heap = performance.memory;
  const context = m?.SDL2?.audioContext, configs = [], fs = m?.FS || globalThis.FS;
  const allowedSettings = {
    General: ['ForceLagSync2'],
    CPU: ['CPUCore', 'FastMemory', 'IgnoreBadMemAccess', 'SeparateSASThread'],
    Graphics: ['RenderingMode', 'InternalResolution', 'FrameSkip', 'FrameSkipType', 'AutoFrameSkip',
      'HardwareTransform', 'SoftwareSkinning', 'VertexCache', 'HardwareTessellation', 'TexScalingLevel',
      'TexScalingType', 'TextureFiltering', 'AnisotropyLevel', 'DisplayRefreshRate', 'FrameRate', 'FrameRate2',
      'VerticalSync', 'LowLatencyPresent', 'SkipGPUReadbacks', 'DisableSlowFramebufEffects'],
    Sound: ['Enable', 'EnableSound', 'AudioLatency', 'AudioResampler'],
  };
  function setting(result, section, key, raw) {
    if (!allowedSettings[section]?.includes(key)) return;
    const value = String(raw).trim();
    let parsed;
    if (/^(true|false)$/i.test(value)) parsed = value.toLowerCase() === 'true';
    else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value))
      && Math.abs(Number(value)) <= Number.MAX_SAFE_INTEGER) parsed = Number(value);
    else return;
    (result[section] ??= {})[key] = parsed;
  }
  if (fs && typeof PERSIST_ROOTS !== 'undefined') for (const root of PERSIST_ROOTS) safe(() => {
    const path = root + '/PSP/SYSTEM/ppsspp.ini';
    if (fs.stat(path).size > 512 * 1024) return;
    let section = '';
    const result = {};
    for (const line of new TextDecoder().decode(fs.readFile(path)).split(/\r?\n/)) {
      const match = line.match(/^\s*\[([^\]]+)\]/);
      if (match) section = match[1];
      else { const pair = line.match(/^\s*([^=\s]+)\s*=\s*(.*?)\s*$/); if (pair) setting(result, section, pair[1], pair[2]); }
    }
    configs.push(result);
  });
  const timingDefaults = typeof WEB_NATIVE_TIMING_CONFIG !== 'undefined' ? {} : null;
  if (timingDefaults) for (const [section, key, value] of WEB_NATIVE_TIMING_CONFIG) setting(timingDefaults, section, key, value);
  return {
    timestampMs: performance.now(), timeOriginMs: performance.timeOrigin,
    ready: typeof runtimeReady !== 'undefined' && runtimeReady, failed: typeof runtimeFailed !== 'undefined' && runtimeFailed,
    visibility: document.visibilityState,
    coreRevision: typeof BUILD_STAMP !== 'undefined' && /^[a-f0-9]{64}$/.test(String(BUILD_STAMP)) ? BUILD_STAMP : null,
    browser: { userAgent: navigator.userAgent, platform: navigator.platform, brands: safe(() => navigator.userAgentData.toJSON()) },
    hardware: { concurrency: finite(navigator.hardwareConcurrency), deviceMemoryGB: finite(navigator.deviceMemory), maxTouchPoints: finite(navigator.maxTouchPoints) },
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height,
      visual: globalThis.visualViewport ? { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale } : null,
      canvas: canvas ? { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height } : null },
    isolated: globalThis.crossOriginIsolated,
    graphics: Object.fromEntries(['iRenderer', 'iVendor', 'iVersion'].map(id => [id, document.querySelector('#' + id)?.textContent ?? null])),
    memory: { wasmLinearMemoryCapacityBytes: finite(m?.HEAPU8?.buffer?.byteLength ?? m?.wasmMemory?.buffer?.byteLength ?? globalThis.HEAPU8?.buffer?.byteLength),
      jsHeap: heap ? { usedBytes: finite(heap.usedJSHeapSize), capacityBytes: finite(heap.totalJSHeapSize), limitBytes: finite(heap.jsHeapSizeLimit) } : null,
      meaning: 'WASM capacity is addressable allocation, not live allocations or resident RAM. JS heap is the performance.memory estimate. Neither is whole-process memory.' },
    gameReads: safe(() => {
      const stats = globalThis.PpssppBrowserFiles?.stats();
      return stats ? { ...Object.fromEntries(Object.entries(stats).filter(([, value]) => Number.isFinite(value))),
        hasReadError: !!stats.lastError } : null;
    }),
    audio: typeof audioDebug !== 'undefined' ? { ...audioDebug } : null,
    audioContext: context ? { state: context.state, sampleRate: context.sampleRate, baseLatencySeconds: finite(context.baseLatency), outputLatencySeconds: finite(context.outputLatency) } : null,
    settings: { player: typeof loadPlayerSettings === 'function' ? safe(loadPlayerSettings) : null,
      persistedIni: configs.length ? configs : null, iniMeaning: 'Runtime FS configuration; live menu changes may not yet be persisted.',
      timingDefaults }, core,
  };
}

export function startPageSampling(key, seconds) {
  if (Object.hasOwn(globalThis, key)) throw new Error('Sampler key already exists.');
  const start = performance.now(), limit = 20000;
  const raf = { count: 0, intervalCount: 0, totalMs: 0, droppedSamples: 0, intervals: [] };
  const longTasks = { supported: false, count: 0, totalMs: 0, droppedSamples: 0, durations: [] };
  let previous = null, frame, observer, timer, finished = false;
  let hiddenSince = document.visibilityState === 'hidden' ? start : null, hiddenMs = 0, visibilityChanges = 0;
  function visibility() {
    visibilityChanges++; previous = null; const now = performance.now();
    if (hiddenSince !== null) hiddenMs += now - hiddenSince;
    hiddenSince = document.visibilityState === 'hidden' ? now : null;
  }
  function tasks(entries) {
    for (const entry of entries) {
      if (entry.startTime < start) continue;
      longTasks.count++; longTasks.totalMs += entry.duration;
      if (longTasks.durations.length < limit) longTasks.durations.push(entry.duration); else longTasks.droppedSamples++;
    }
  }
  function tick(now) {
    if (finished) return;
    if (document.visibilityState !== 'visible') { previous = null; frame = requestAnimationFrame(tick); return; }
    raf.count++;
    if (previous !== null) {
      const delta = now - previous; raf.intervalCount++; raf.totalMs += delta;
      if (raf.intervals.length < limit) raf.intervals.push(delta); else raf.droppedSamples++;
    }
    previous = now; frame = requestAnimationFrame(tick);
  }
  function finish() {
    if (finished) return null;
    finished = true; const end = performance.now();
    cancelAnimationFrame(frame); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility);
    if (observer) { tasks(observer.takeRecords()); observer.disconnect(); }
    if (hiddenSince !== null) hiddenMs += end - hiddenSince;
    delete globalThis[key];
    return { startMs: start, endMs: end, durationSeconds: (end - start) / 1000, hiddenMs, visibilityChanges, raf, longTasks };
  }
  try {
    if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver(list => tasks(list.getEntries()));
      observer.observe({ type: 'longtask', buffered: false }); longTasks.supported = true;
    }
  } catch { observer?.disconnect(); observer = null; }
  document.addEventListener('visibilitychange', visibility); frame = requestAnimationFrame(tick);
  timer = setTimeout(finish, (seconds + 10) * 1000); // Also clean up after a disconnected CDP client.
  globalThis[key] = { finish };
  return { startMs: start, longTasksSupported: longTasks.supported };
}
export function stopPageSampling(key) { return globalThis[key]?.finish() ?? null; }

export function summarize(before, after, sample) {
  const samePage = before.timeOriginMs === after.timeOriginMs, durationSeconds = samePage ? (after.timestampMs - before.timestampMs) / 1000 : null;
  const foregroundThroughout = samePage && sample.hiddenMs === 0 && sample.visibilityChanges === 0 && before.visibility === 'visible' && after.visibility === 'visible';
  const coreDelta = samePage && before.core?.initialized && after.core?.initialized ? counterDelta(before.core, after.core, ['vblankCount', 'actualFlipCount', 'emulatedTimeUs']) : null;
  const freshCoreWindow = foregroundThroughout && [before.core, after.core].every(core => core?.emulating === 1 &&
    Number.isFinite(core.sampleAgeMs) && core.sampleAgeMs >= 0 && core.sampleAgeMs <= 2500 &&
    Number.isSafeInteger(core.sequence) && core.sequence >= 0) && after.core.sequence > before.core.sequence;
  return {
    counterWindowSeconds: durationSeconds,
    gameReadsDelta: samePage ? counterDelta(before.gameReads, after.gameReads, ['readCount', 'readBytes', 'physicalReadCount', 'physicalReadBytes', 'cacheHits', 'failures']) : null,
    audioDelta: samePage ? counterDelta(before.audio, after.audio, ['callbacks', 'nonsilent', 'pushes', 'pushNonsilent', 'workletTotal', 'ringDropped', 'underruns', 'fallbackDropped']) : null,
    coreDelta, coreAverageActualFps: freshCoreWindow && durationSeconds > 0 && coreDelta?.actualFlipCount != null ? coreDelta.actualFlipCount / durationSeconds : null,
    coreAverageMeaning: 'Flip-count difference over wall time; only with fresh, advancing core snapshots, emulating endpoints and an uninterrupted foreground window.',
    countersMeaning: 'Counter differences over before/after snapshots; null means missing, reset, or another document. Endpoint core rates remain in before/after.',
    foregroundThroughout,
    pageRaf: { meaning: 'Page requestAnimationFrame cadence, NOT emulator/core FPS.', durationSeconds: sample.durationSeconds,
      callbacks: sample.raf.count, intervalCount: sample.raf.intervalCount,
      observedRateHz: foregroundThroughout && sample.raf.totalMs > 0 ? sample.raf.intervalCount * 1000 / sample.raf.totalMs : null,
      droppedSamples: sample.raf.droppedSamples, intervalDistribution: !foregroundThroughout || sample.raf.droppedSamples ? null : distribution(sample.raf.intervals) },
    longTasks: sample.longTasks.supported ? { count: sample.longTasks.count, totalMs: sample.longTasks.totalMs,
      droppedSamples: sample.longTasks.droppedSamples, durationDistribution: sample.longTasks.droppedSamples ? null : distribution(sample.longTasks.durations),
      meaning: 'Main-page long tasks only; workers and tasks shorter than the browser threshold are not covered.' } : null,
    visibility: { hiddenMs: sample.hiddenMs, changes: sample.visibilityChanges },
  };
}

export async function connectCdp(url, { WebSocketImpl = WebSocket, timeoutMs = 30000 } = {}) {
  const socket = new WebSocketImpl(url), pending = new Map(), listeners = new Set();
  let nextId = 0, closed = false;
  function fail(error) { closed = true; for (const r of pending.values()) { clearTimeout(r.timer); r.reject(error); } pending.clear(); }
  socket.addEventListener('close', () => fail(new Error('DevTools connection closed.')));
  socket.addEventListener('error', () => fail(new Error('DevTools connection failed.')));
  socket.addEventListener('message', event => {
    let message; try { message = JSON.parse(event.data); } catch { fail(new Error('Invalid DevTools response.')); socket.close(); return; }
    if (!message.id) { for (const listener of listeners) listener(message); return; }
    const r = pending.get(message.id); if (!r) return;
    pending.delete(message.id); clearTimeout(r.timer);
    if (message.error) r.reject(new Error(`DevTools ${r.method}: ${message.error.message}`)); else r.accept(message.result);
  });
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('DevTools connection timeout.')); }, timeoutMs);
    const finish = error => { clearTimeout(timer); error ? reject(error) : accept(); };
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener('error', () => finish(new Error('DevTools connection failed.')), { once: true });
    socket.addEventListener('close', () => finish(new Error('DevTools closed before connecting.')), { once: true });
  });
  return {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    command(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('DevTools connection is closed.'));
      return new Promise((accept, reject) => {
        const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, timeoutMs);
        pending.set(id, { accept, reject, timer, method });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    close() { fail(new Error('DevTools connection closed.')); socket.close(); },
  };
}

export async function startWorkerProfilers(client) {
  const workers = new Map(); let accepting = true, autoAttach = false;
  const unsubscribe = client.onEvent(message => {
    if (!accepting || message.method !== 'Target.attachedToTarget' || message.params.targetInfo.type !== 'worker') return;
    const { sessionId } = message.params;
    if (workers.has(sessionId)) return;
    const worker = { index: workers.size + 1, status: 'starting', started: false };
    workers.set(sessionId, worker);
    worker.ready = (async () => {
      try {
        await client.command('Profiler.enable', {}, sessionId);
        await client.command('Profiler.setSamplingInterval', { interval: 1000 }, sessionId);
        await client.command('Profiler.start', {}, sessionId); worker.started = true; worker.status = 'sampling';
      } catch { worker.status = 'unavailable'; }
    })();
  });
  try { await client.command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); autoAttach = true; }
  catch { /* Main-only measurements must not imply that worker CPU is idle. */ }
  await Promise.all([...workers.values()].map(worker => worker.ready));
  return {
    async finish() {
      accepting = false; unsubscribe();
      await Promise.all([...workers.values()].map(worker => worker.ready));
      const results = [];
      for (const [sessionId, worker] of workers) {
        let profile;
        if (worker.started) {
          try { ({ profile } = await client.command('Profiler.stop', {}, sessionId)); worker.status = 'captured'; }
          catch { worker.status = 'unavailable'; }
        }
        await client.command('Profiler.disable', {}, sessionId).catch(() => {});
        results.push({ index: worker.index, status: worker.status, profile });
      }
      if (autoAttach) await client.command('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      return { autoAttachSupported: autoAttach, workers: results,
        warning: 'Only related dedicated workers observed by CDP are covered. Missing/unavailable workers are unmeasured, not idle. Main-thread idle does not describe emulator CPU cost.' };
    },
  };
}

export async function run(options) {
  const response = await fetch(`http://127.0.0.1:${options.port}/json`, { signal: AbortSignal.timeout(10000) })
    .catch(() => { throw new Error(`Cannot reach browser DevTools on loopback port ${options.port}; check the debugging browser and --port.`); });
  if (!response.ok) throw new Error(`DevTools discovery failed: ${response.status}`);
  const pages = await response.json();
  if (!options.target) for (const page of pages.filter(p => p.type === 'page' && /^https?:\/\//.test(p.url || '') && p.webSocketDebuggerUrl)) {
    let probe;
    try {
      probe = await connectCdp(page.webSocketDebuggerUrl, { timeoutMs: 3000 });
      const result = await probe.command('Runtime.evaluate', { expression: "typeof globalThis.PpssppBrowserFiles?.stats === 'function' && typeof runtimeReady !== 'undefined'", returnByValue: true });
      page.isPpsspp = result.result.value === true;
    } catch { page.isPpsspp = false; } finally { probe?.close(); }
  }
  const page = selectPage(pages, options.target), client = await connectCdp(page.webSocketDebuggerUrl);
  const key = '__ppssppBenchmark_' + randomUUID().replaceAll('-', '');
  const evaluate = async (fn, ...args) => {
    const result = await client.command('Runtime.evaluate', { returnByValue: true, expression: `(${fn.toString()})(${args.map(x => JSON.stringify(x)).join(',')})` });
    if (result.exceptionDetails) throw new Error('Page evaluation failed: ' + (result.exceptionDetails.text || 'exception'));
    return result.result.value;
  };
  let profiling = false, profilerEnabled = false, sampling = false, workerProfilers;
  try {
    const initial = await evaluate(() => ({ ready: typeof runtimeReady !== 'undefined' && runtimeReady,
      failed: typeof runtimeFailed !== 'undefined' && runtimeFailed, visibility: document.visibilityState }));
    if (!initial.ready || initial.failed) throw new Error('Start PPSSPP and reach the desired scene before capturing.');
    if (initial.visibility !== 'visible') throw new Error('Keep the PPSSPP tab visible during measurement.');
    await mkdir(dirname(options.output), { recursive: true });
    if (options.profile) {
      await client.command('Profiler.enable'); profilerEnabled = true;
      await client.command('Profiler.setSamplingInterval', { interval: 1000 });
      await client.command('Profiler.start'); profiling = true;
      workerProfilers = await startWorkerProfilers(client);
    }
    const before = await evaluate(pageSnapshot);
    sampling = true; await evaluate(startPageSampling, key, options.seconds);
    console.log(`Measuring ${options.seconds}s; CPU sampling ${options.profile ? 'enabled' : 'disabled'}. Keep the tab visible.`);
    await new Promise(accept => setTimeout(accept, options.seconds * 1000));
    const sample = await evaluate(stopPageSampling, key); sampling = false;
    if (!sample) throw new Error('Page sampler disappeared or expired; the page may have navigated.');
    const after = await evaluate(pageSnapshot), summary = summarize(before, after, sample);
    let profile, workers = null;
    if (profiling) { ({ profile } = await client.command('Profiler.stop')); profiling = false; }
    if (workerProfilers) { workers = await workerProfilers.finish(); workerProfilers = null; }
    if (profile) await writeFile(options.output + '.cpuprofile', JSON.stringify(profile));
    if (workers) for (const worker of workers.workers) {
      if (worker.profile) {
        await writeFile(options.output + `.worker-${worker.index}.cpuprofile`, JSON.stringify(worker.profile));
        worker.durationSeconds = (worker.profile.endTime - worker.profile.startTime) / 1e6;
        delete worker.profile;
      }
    }
    await writeFile(options.output + '.json', JSON.stringify({ schemaVersion: 2, date: new Date().toISOString(), requestedSeconds: options.seconds,
      cpuProfiler: { enabled: options.profile, intervalUs: options.profile ? 1000 : null, mainDurationSeconds: profile ? (profile.endTime - profile.startTime) / 1e6 : null,
        meaning: 'CPU sampling can perturb timing. Main-page and worker profiles have independent time windows.', workers }, before, after, summary }, null, 2));
    if (options.screenshot) {
      const { data } = await client.command('Page.captureScreenshot', { format: 'png' });
      await writeFile(options.output + '.png', Buffer.from(data, 'base64'));
    }
    console.log(`Saved measurement to ${options.output}.json.`);
    return summary;
  } finally {
    if (sampling) await evaluate(stopPageSampling, key).catch(() => {});
    if (profiling) await client.command('Profiler.stop').catch(() => {});
    if (workerProfilers) await workerProfilers.finish().catch(() => {});
    if (profilerEnabled) await client.command('Profiler.disable').catch(() => {});
    client.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => run(parseOptions(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
