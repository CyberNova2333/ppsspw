#!/usr/bin/env node
// Local diagnostic builds only: swap submission completion is not GPU presentation.
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectCdp, selectPage, pageSnapshot, startPageSampling, stopPageSampling, summarize, distribution } from './profile-browser.mjs';

export function parseOptions(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--port', '--seconds', '--out', '--target'].includes(key) || Object.hasOwn(values, key) || !value || value.startsWith('--'))
      throw new Error('Expected unique --target, --out and optional --port/--seconds.');
    values[key] = value;
  }
  const port = Number(values['--port'] ?? 9222), seconds = Number(values['--seconds'] ?? 20);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(seconds) || seconds < 1 || seconds > 120)
    throw new Error('Invalid port or duration (1–120 seconds).');
  if (!values['--target'] || !values['--out']) throw new Error('Exact player URL and private output path are required.');
  const target = new URL(values['--target']);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid target URL.');
  return { port, seconds, target: values['--target'], output: resolve(values['--out']) };
}

export function summarizeSubmissions(timestampsUs) {
  if (!Array.isArray(timestampsUs) || timestampsUs.length < 2 || timestampsUs.some(t => !Number.isSafeInteger(t) || t < 0))
    throw new Error('At least two exact nonnegative submission timestamps are required.');
  const intervals = [];
  for (let i = 1; i < timestampsUs.length; i++) {
    if (timestampsUs[i] <= timestampsUs[i - 1]) throw new Error('Submission timestamps must strictly increase.');
    intervals.push((timestampsUs[i] - timestampsUs[i - 1]) / 1000);
  }
  const durationMs = (timestampsUs.at(-1) - timestampsUs[0]) / 1000;
  return { submissions: timestampsUs.length, completeIntervals: intervals.length, durationMs,
    observedIntervalRateHz: intervals.length * 1000 / durationMs, intervalDistribution: distribution(intervals),
    intervalsAboveMs: Object.fromEntries([25, 50, 100, 250].map(threshold => [threshold, intervals.filter(ms => ms > threshold).length])),
    meaning: 'CPU-side swap submission completion intervals, including scheduling, queueing and driver calls; not GPU duration, screen presentation, native-frame CPU cost, or a count of dropped game frames.' };
}

const REASONS = ['none', 'non_increasing_clock', 'capacity', 'context_changed', 'no_active_capture', 'timestamp_out_of_range', 'counter_exhausted'];

// Executed in the page. All native payloads are atomic; an equal even token
// also guards against replacement and context invalidation during the read.
export function readFrameSnapshot(full = false) {
  const read = globalThis.Module?._ppssppGetFrameTimingMetric;
  if (typeof read !== 'function') throw new Error('Frame timing diagnostics are absent from this build.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = read(1);
    if (!Number.isSafeInteger(token) || token < 0 || token % 2) continue;
    const header = Array.from({ length: 12 }, (_, slot) => read(slot));
    if (!Number.isSafeInteger(header[6]) || !Number.isSafeInteger(header[7]) || header[6] < 0 || header[7] < 1 || header[7] > 8192 || header[6] > header[7])
      throw new Error('Invalid frame timing buffer bounds.');
    const timestampsUs = full && header[2] === 2 ? Array.from({ length: header[6] }, (_, i) => read(32 + i)) : null;
    if (read(1) === token && header[1] === token) return { header, timestampsUs };
  }
  return null;
}

export function decodeFrameSnapshot(raw) {
  const h = raw?.header;
  if (!Array.isArray(h) || h.length !== 12 || h.some(x => !Number.isSafeInteger(x) || x < 0) || h[0] !== 1 || h[1] % 2 || h[2] > 3 || !REASONS[h[5]] || h[7] < 1 || h[7] > 8192 || h[6] > h[7])
    throw new Error('Invalid frame timing header.');
  const result = { schemaVersion: h[0], token: h[1], state: ['idle', 'recording', 'completed', 'invalid'][h[2]],
    captureId: h[3], acknowledgedRequestId: h[4], reason: REASONS[h[5]], count: h[6], capacity: h[7],
    startUs: h[8], endUs: h[9], captureContextEpoch: h[10], currentContextEpoch: h[11] };
  if (result.state === 'completed' && (result.reason !== 'none' || !result.captureId || result.acknowledgedRequestId <= result.captureId || result.count < 2 || result.endUs <= result.startUs || result.captureContextEpoch !== result.currentContextEpoch))
    throw new Error('Contradictory completed frame timing header.');
  if (raw.timestampsUs !== null && raw.timestampsUs !== undefined) {
    if (result.state !== 'completed' || !Array.isArray(raw.timestampsUs) || raw.timestampsUs.length !== result.count ||
        raw.timestampsUs[0] !== result.startUs || raw.timestampsUs.at(-1) !== result.endUs)
      throw new Error('Frame timing payload does not match its boundaries.');
    result.timestampsUs = raw.timestampsUs;
    result.intervals = summarizeSubmissions(raw.timestampsUs);
  }
  return result;
}

export function acquireFrameTimingLease(id, milliseconds) {
  const current = globalThis.__ppssppFrameTimingOwner, now = Date.now();
  if (current && current.expiresAt > now) return false;
  if (current?.canvas) {
    current.canvas.removeEventListener('webglcontextlost', current.onContext);
    current.canvas.removeEventListener('webglcontextrestored', current.onContext);
  }
  const owner = { id, expiresAt: now + milliseconds, contextLost: false };
  owner.canvas = globalThis.document?.querySelector('canvas');
  owner.onContext = () => { owner.contextLost = true; };
  owner.canvas?.addEventListener('webglcontextlost', owner.onContext);
  owner.canvas?.addEventListener('webglcontextrestored', owner.onContext);
  globalThis.__ppssppFrameTimingOwner = owner;
  return true;
}

export function releaseFrameTimingLease(id) {
  const owner = globalThis.__ppssppFrameTimingOwner;
  if (owner?.id === id) {
    owner.canvas?.removeEventListener('webglcontextlost', owner.onContext);
    owner.canvas?.removeEventListener('webglcontextrestored', owner.onContext);
    delete globalThis.__ppssppFrameTimingOwner;
  }
}

export function frameTimingPageState(id) {
  const owner = globalThis.__ppssppFrameTimingOwner;
  return { ownsLease: owner?.id === id, contextLost: !!owner?.contextLost };
}

export function requestFrameStart(owner) {
  if (globalThis.__ppssppFrameTimingOwner?.id !== owner) return { error: 'lease_lost' };
  const m = globalThis.Module;
  if (typeof m?._ppssppRequestFrameTiming !== 'function' || typeof m?._ppssppGetFrameTimingMetric !== 'function') return { error: 'diagnostics_absent' };
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = m._ppssppGetFrameTimingMetric(1), state = m._ppssppGetFrameTimingMetric(2);
    if (!Number.isSafeInteger(token) || token % 2 || m._ppssppGetFrameTimingMetric(1) !== token) continue;
    if (state === 1) return { error: 'capture_already_recording' };
    return { requestId: m._ppssppRequestFrameTiming(1) };
  }
  return { error: 'snapshot_unavailable' };
}

export function requestOwnedFrameStop(owner, captureId) {
  if (globalThis.__ppssppFrameTimingOwner?.id !== owner) return { error: 'lease_lost' };
  const m = globalThis.Module;
  if (typeof m?._ppssppGetFrameTimingMetric !== 'function') return { error: 'diagnostics_absent' };
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = m._ppssppGetFrameTimingMetric(1), id = m._ppssppGetFrameTimingMetric(3), state = m._ppssppGetFrameTimingMetric(2);
    if (!Number.isSafeInteger(token) || token % 2 || m._ppssppGetFrameTimingMetric(1) !== token) continue;
    if (id !== captureId) return { error: 'capture_replaced' };
    return { requestId: state === 1 ? m._ppssppRequestFrameTiming(2) : 0, state };
  }
  return { error: 'snapshot_unavailable' };
}

export async function run(options, dependencies = {}) {
  const getPages = dependencies.fetch ?? fetch, connect = dependencies.connectCdp ?? connectCdp;
  const now = dependencies.now ?? Date.now, delay = dependencies.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  await mkdir(dirname(options.output), { recursive: true });
  const file = await open(options.output, 'wx');
  const owner = '__ppssppFrameTiming_' + randomUUID().replaceAll('-', '');
  const report = { schemaVersion: 1, date: new Date().toISOString(), requestedSeconds: options.seconds, diagnostic: true,
    status: 'failed', meaning: 'CPU-side swap submission completion, not physical presentation or GPU execution. Diagnostic timing cannot establish release-build FPS or CPU gains.' };
  let client, evaluate, leased = false, sampling = false, captureId = 0, startAcknowledged = false, stopRequestId = 0, completedStop = false;
  async function ack(id) {
    const deadline = now() + 10000;
    do {
      const raw = await evaluate(readFrameSnapshot);
      if (raw?.header[4] === id) return decodeFrameSnapshot(raw);
      await delay(50);
    } while (now() < deadline);
    throw new Error('No swap boundary acknowledged the frame timing request.');
  }
  try {
    const response = await getPages(`http://127.0.0.1:${options.port}/json/list`);
    const page = selectPage(await response.json(), options.target);
    client = await connect(page.webSocketDebuggerUrl);
    evaluate = async (fn, ...args) => {
      const result = await client.command('Runtime.evaluate', { expression: `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Player evaluation failed.');
      return result.result?.value;
    };
    leased = await evaluate(acquireFrameTimingLease, owner, (options.seconds + 45) * 1000);
    if (!leased) throw new Error('Another frame timing collector holds this page.');
    report.before = await evaluate(pageSnapshot);
    if (report.before?.visibility !== 'visible' || report.before?.failed || !report.before?.core?.emulating) throw new Error('Player must be foreground and emulating.');
    // Observe before the first native submit, and keep the observer alive until
    // explicit cleanup so acknowledgement latency cannot leave visibility gaps.
    await evaluate(startPageSampling, owner, options.seconds + 25);
    sampling = true;
    const start = await evaluate(requestFrameStart, owner);
    if (start?.error || !start?.requestId) throw new Error('Cannot start frame timing: ' + (start?.error || 'request rejected'));
    captureId = start.requestId;
    const started = await ack(captureId);
    if (started.state !== 'recording' || started.captureId !== captureId) throw new Error('Frame timing start was not acknowledged as recording.');
    startAcknowledged = true;
    report.started = started;
    await delay(options.seconds * 1000);
    const stop = await evaluate(requestOwnedFrameStop, owner, captureId);
    if (stop?.error || !stop?.requestId) throw new Error('Cannot stop active frame timing: ' + (stop?.error || 'capture is no longer recording'));
    stopRequestId = stop.requestId;
    await ack(stopRequestId);
    completedStop = true;
    report.submits = decodeFrameSnapshot(await evaluate(readFrameSnapshot, true));
    report.after = await evaluate(pageSnapshot);
    const sample = await evaluate(stopPageSampling, owner);
    sampling = false;
    if (!sample) throw new Error('Page observation disappeared.');
    report.summary = summarize(report.before, report.after, sample);
    report.pageState = await evaluate(frameTimingPageState, owner);
    report.status = report.submits.state === 'completed' && report.submits.captureId === captureId &&
      report.submits.acknowledgedRequestId === stop.requestId && report.submits.captureContextEpoch === report.submits.currentContextEpoch &&
      report.submits.intervals?.durationMs >= options.seconds * 1000 - 100 && report.summary.foregroundThroughout &&
      report.summary.coreDelta?.emulatedTimeUs > 0 && Number.isFinite(report.summary.coreAverageActualFps) &&
      !report.after?.failed && report.pageState.ownsLease && !report.pageState.contextLost ? 'captured' : 'invalid';
    if (report.status !== 'captured') {
      report.invalidReason = 'Native capture, document visibility, runtime health, or page ownership did not cover a valid complete window.';
    }
    return report;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    if (captureId && !completedStop && evaluate) {
      try {
        if (!startAcknowledged) {
          const current = await evaluate(readFrameSnapshot);
          if (current?.header[3] !== captureId || current?.header[4] !== captureId)
            throw new Error('Unacknowledged native start cannot be canceled; reload the diagnostic player before another capture.');
        }
        if (stopRequestId) await ack(stopRequestId);
        else {
          const stop = await evaluate(requestOwnedFrameStop, owner, captureId);
          if (stop?.error) throw new Error(stop.error);
          if (stop?.requestId) await ack(stop.requestId);
          else if (stop?.state === 1) throw new Error('Frame timing stop request was not accepted.');
        }
        const raw = await evaluate(readFrameSnapshot, true);
        if (raw && raw.header[3] === captureId) report.submits = decodeFrameSnapshot(raw);
      } catch (error) { report.cleanupFailed = error.message; }
    }
    if (sampling) await evaluate(stopPageSampling, owner).catch(() => {});
    if (leased) await evaluate(releaseFrameTimingLease, owner).catch(() => {});
    client?.close();
    if (report.status !== 'captured' && report.submits) delete report.submits.intervals;
    try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); } finally { await file.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(parseOptions(process.argv.slice(2))).then(report => {
    console.log(`Frame timing ${report.status}; ${report.submits?.count ?? 0} submissions.`);
    if (report.status !== 'captured') process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
