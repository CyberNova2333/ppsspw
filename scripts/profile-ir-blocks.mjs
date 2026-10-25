#!/usr/bin/env node
// Local diagnostic builds only. Raw IR can contain game code: keep reports private.
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectCdp, selectPage, pageSnapshot, startPageSampling, stopPageSampling, summarize } from './profile-browser.mjs';

const ROW_BASE = 288, ROW_STRIDE = 262, METRIC_COUNT = ROW_BASE + 32 * ROW_STRIDE;
const REASONS = ['none', 'cache_cleared', 'not_emulating', 'emulated_time_reversed', 'registration_budget',
  'unknown_offset', 'counter_overflow', 'invalid_registration', 'no_active_capture'];

export function parseOptions(args) {
  const values = {};
  for (let i = 0; i < args.length; ++i) {
    const key = args[i], value = args[++i];
    if (!['--port', '--seconds', '--out', '--target'].includes(key) || Object.hasOwn(values, key) || !value || value.startsWith('--'))
      throw new Error('Usage: node scripts/profile-ir-blocks.mjs --target <exact URL> --out <private report.json> [--port 9222] [--seconds 20]');
    values[key] = value;
  }
  const port = Number(values['--port'] ?? 9222), seconds = Number(values['--seconds'] ?? 20);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(seconds) || seconds < 1 || seconds > 120)
    throw new Error('Invalid port or duration (1–120 seconds).');
  if (!values['--target'] || !values['--out']) throw new Error('An exact target URL and private output file are required.');
  const url = new URL(values['--target']);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid target URL.');
  return { port, seconds, target: values['--target'], output: resolve(values['--out']) };
}

// Executed in the page. Atomic payloads and an equal even sequence guard the
// snapshot. Recording counts are intentionally not republished every frame.
export function readIRSnapshot(full = false) {
  const read = globalThis.Module?._ppssppGetIRBlockProfileMetric;
  if (typeof read !== 'function') throw new Error('IR diagnostics are absent from this build.');
  for (let attempt = 0; attempt < 4; ++attempt) {
    const sequence = read(1);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence % 2) continue;
    const values = Array.from({ length: full ? 8672 : 21 }, (_, slot) => read(slot));
    if (read(1) === sequence && values[1] === sequence) return values;
  }
  return null;
}

export function decodeSnapshot(values) {
  if (!Array.isArray(values) || values.length !== METRIC_COUNT || values.some(v => !Number.isSafeInteger(v) || v < 0) ||
      values[0] !== 1 || values[1] % 2 || values[2] > 3 || !REASONS[values[3]] || values[13] > 32 || values[15] !== 128 || values[16] !== 32 ||
      values[20] > 1 || values[10] > values[11] || values[10] > values[9] || values[13] > values[10])
    throw new Error('Invalid IR diagnostic snapshot.');
  const rows = [];
  for (let row = 0; row < values[13]; ++row) {
    const base = ROW_BASE + row * ROW_STRIDE;
    const [offset, address, entries, fullIRLength, storedOps, truncated] = values.slice(base, base + 6);
    if (offset > 0xffffffff || address > 0xffffffff || !entries || entries > values[9] || !fullIRLength || storedOps !== Math.min(fullIRLength, 128) ||
        truncated !== Number(storedOps < fullIRLength)) throw new Error('Invalid IR block row.');
    const previous = rows.at(-1);
    if (rows.some(item => item.offset === offset) || previous && (previous.entries < entries || previous.entries === entries && previous.offset >= offset))
      throw new Error('IR block rows are not uniquely ordered.');
    const instructions = [];
    for (let index = 0; index < storedOps; ++index) {
      const word = values[base + 6 + 2 * index], constant = values[base + 7 + 2 * index];
      if (word > 0xffffffff || constant > 0xffffffff) throw new Error('Invalid packed IR instruction.');
      instructions.push({ opcode: word & 255, dest: (word >>> 8) & 255, src1: (word >>> 16) & 255, src2: word >>> 24, constant });
    }
    rows.push({ offset, address, entries, fullIRLength, truncated: !!truncated, instructions });
  }
  const histogram = values.slice(32, 288), sum = histogram.reduce((a, b) => a + b, 0);
  if (values[17] !== rows.filter(row => row.truncated).length) throw new Error('IR truncation count mismatch.');
  // Overflow reports remain useful invalid evidence; saturated counters need not sum.
  if (!values[20] && (!Number.isSafeInteger(sum) || sum !== values[14])) throw new Error('IR histogram total mismatch.');
  return { schemaVersion: 1, sequence: values[1], state: ['idle', 'recording', 'completed', 'invalid'][values[2]], reason: REASONS[values[3]],
    acknowledgedRequestId: values[4], captureId: values[5], cacheEpoch: values[6], startEmulatedUs: values[7], endEmulatedUs: values[8],
    totalBlockEntries: values[9], touchedBlocks: values[10], registeredBlocks: values[11], droppedBlocks: values[12],
    weightedStaticOps: values[14], truncatedRows: values[17], startCacheEpoch: values[18], unknownBlockEntries: values[19],
    overflow: !!values[20], weightedStaticOpcodeOccurrences: histogram, rows };
}

// These leases coordinate this collector's instances. They do not prevent a
// user or another tool from directly invoking the diagnostic ABI.
export function acquireIRProfileLease(id, milliseconds) {
  const current = globalThis.__ppssppIRProfileOwner, now = Date.now();
  if (current && current.expiresAt > now) return false;
  globalThis.__ppssppIRProfileOwner = { id, expiresAt: now + milliseconds };
  return true;
}

export function releaseIRProfileLease(id) {
  if (globalThis.__ppssppIRProfileOwner?.id === id) delete globalThis.__ppssppIRProfileOwner;
}

// Check ownership and submit in one page task. The lease prevents another
// cooperating collector from replacing this capture between those operations.
export function requestOwnedIRStop(owner, captureId) {
  if (globalThis.__ppssppIRProfileOwner?.id !== owner) return { error: 'lease_lost' };
  const read = globalThis.Module?._ppssppGetIRBlockProfileMetric;
  if (typeof read !== 'function') return { error: 'diagnostics_absent' };
  for (let attempt = 0; attempt < 4; ++attempt) {
    const sequence = read(1);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence % 2) continue;
    const id = read(5), state = read(2);
    if (read(1) !== sequence) continue;
    if (id !== captureId) return { error: 'capture_replaced' };
    if (state !== 1) return { requestId: 0, state };
    return { requestId: Module._ppssppRequestIRBlockProfile(2), state };
  }
  return { error: 'snapshot_unavailable' };
}

export async function run(options, dependencies = {}) {
  const fetchPages = dependencies.fetch ?? fetch, connect = dependencies.connectCdp ?? connectCdp;
  const now = dependencies.now ?? Date.now;
  const delay = dependencies.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  await mkdir(dirname(options.output), { recursive: true });
  const output = await open(options.output, 'wx');
  let client, started = false, sampling = false, leased = false, captureId = 0;
  const key = '__ppssppIRProfile_' + randomUUID().replaceAll('-', '');
  const report = { schemaVersion: 1, date: new Date().toISOString(), requestedSeconds: options.seconds, diagnostic: true,
    meaning: 'Block entry counts and weighted static IR, not CPU time or exact executed opcode counts. Conditional exits can skip later instructions. Diagnostic timing is not a performance baseline.',
    status: 'failed' };
  let evaluate;
  async function awaitAck(id) {
    const deadline = now() + 10000;
    do {
      const values = await evaluate(readIRSnapshot);
      if (values?.[4] === id) return values;
      await delay(50);
    } while (now() < deadline);
    throw new Error('Diagnostic frame acknowledgement timed out.');
  }
  try {
    const response = await fetchPages(`http://127.0.0.1:${options.port}/json`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('DevTools discovery failed.');
    const page = selectPage(await response.json(), options.target);
    client = await connect(page.webSocketDebuggerUrl, { timeoutMs: 10000 });
    evaluate = async (fn, ...args) => {
      const result = await client.command('Runtime.evaluate', { returnByValue: true, expression: `(${fn.toString()})(${args.map(x => JSON.stringify(x)).join(',')})` }, undefined, { timeoutMs: 5000 });
      if (result.exceptionDetails) throw new Error('Page diagnostic evaluation failed.');
      return result.result.value;
    };
    leased = await evaluate(acquireIRProfileLease, key, options.seconds * 1000 + 60000);
    if (!leased) throw new Error('Another IR collector owns this page.');
    const initial = await evaluate(readIRSnapshot);
    if (!initial || initial[0] !== 1 || initial[2] === 1) throw new Error('Diagnostics unavailable or another capture is active.');
    report.before = await evaluate(pageSnapshot);
    if (report.before.visibility !== 'visible' || report.before.core?.emulating !== 1) throw new Error('Keep an emulating game visible before capture.');
    captureId = await evaluate(() => Module._ppssppRequestIRBlockProfile(1));
    if (!captureId) throw new Error('Diagnostic request queue is busy.');
    started = true;
    report.captureId = captureId;
    const ack = await awaitAck(captureId);
    if (ack[2] !== 1 || ack[5] !== captureId) throw new Error('Core rejected diagnostic start: ' + (REASONS[ack[3]] ?? 'unknown'));
    await evaluate(startPageSampling, key, options.seconds);
    sampling = true;
    const start = now();
    while (now() - start < options.seconds * 1000) {
      await delay(Math.min(250, options.seconds * 1000 - (now() - start)));
      const progress = await evaluate(readIRSnapshot);
      if (!progress) continue;  // A publication in progress is retried on the next poll.
      if (progress[5] !== captureId) throw new Error('Capture was replaced.');
      if (progress[2] !== 1) break;
    }
    const stop = await evaluate(requestOwnedIRStop, key, captureId);
    if (stop.error || stop.state === 1 && !stop.requestId) throw new Error('Diagnostic stop request was rejected: ' + (stop.error ?? 'queue_busy'));
    if (stop.requestId) await awaitAck(stop.requestId);
    const blocks = decodeSnapshot(await evaluate(readIRSnapshot, true));
    if (blocks.captureId !== captureId) throw new Error('Stopped snapshot belongs to a different capture.');
    report.blocks = blocks;
    started = false;
    const sample = await evaluate(stopPageSampling, key); sampling = false;
    report.after = await evaluate(pageSnapshot);
    if (!sample) throw new Error('Page sampler disappeared.');
    report.summary = summarize(report.before, report.after, sample);
    report.status = report.blocks.state === 'completed' && report.blocks.endEmulatedUs > report.blocks.startEmulatedUs &&
      report.blocks.cacheEpoch === report.blocks.startCacheEpoch && report.blocks.totalBlockEntries > 0 &&
      !report.blocks.droppedBlocks && !report.blocks.unknownBlockEntries && !report.blocks.overflow &&
      report.summary.foregroundThroughout ? 'captured' : 'invalid';
    return report;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    if (started && evaluate) {
      // Stop only the capture this invocation requested; never another collector's.
      const stop = await evaluate(requestOwnedIRStop, key, captureId).catch(() => null);
      if (stop?.requestId) await awaitAck(stop.requestId).catch(() => {});
      const raw = await evaluate(readIRSnapshot, true).catch(() => null);
      if (raw) {
        try {
          const blocks = decodeSnapshot(raw);
          if (blocks.captureId === captureId) report.blocks = blocks;
        } catch {}
      }
    }
    if (sampling) await evaluate(stopPageSampling, key).catch(() => {});
    if (leased) await evaluate(releaseIRProfileLease, key).catch(() => {});
    client?.close();
    try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); } finally { await output.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => run(parseOptions(process.argv.slice(2)))).then(report => {
    console.log(`IR capture ${report.status}; ${report.blocks?.totalBlockEntries ?? 0} block entries.`);
    if (report.status !== 'captured') process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
