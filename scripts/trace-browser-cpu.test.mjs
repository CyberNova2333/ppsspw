import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { requireDedicatedBrowser, startBrowserCpuTrace } from './trace-browser-cpu.mjs';

const targets = [{ type: 'page', targetId: 'player' }, { type: 'worker', targetId: 'worker' }];
const body = '{"traceEvents":[]}';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function output(t) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-trace-'));
  assert.equal(dirname(directory), resolve(tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'capture');
}
function fake({ targetInfos = targets, completion = { stream: 'trace-stream', dataLossOccurred: false },
  chunks = [{ data: body, eof: true }], failStart = false, failRead = false, failEnd = false, failClose = false, readDelay = 0 } = {}) {
  const calls = []; let listener;
  const client = {
    onEvent(fn) { listener = fn; return () => { listener = null; }; },
    async command(method, params, sessionId, limits) {
      calls.push({ method, params, sessionId, limits });
      if (method === 'Target.getTargets') return { targetInfos };
      if (method === 'Tracing.start' && failStart) throw new Error('Another trace is already running.');
      if (method === 'Tracing.end') {
        if (failEnd) throw new Error('Browser connection closed.');
        if (completion) queueMicrotask(() => listener?.({ method: 'Tracing.tracingComplete', params: completion }));
      }
      if (method === 'IO.read') {
        if (readDelay) await new Promise(resolve => setTimeout(resolve, readDelay));
        if (failRead) throw new Error('Stream disconnected.');
        return chunks.shift();
      }
      if (method === 'IO.close' && failClose) throw new Error('Stream close unconfirmed.');
      return {};
    },
  };
  return { client, calls, listening: () => listener !== null };
}

test('browser-wide tracing refuses other tabs, shared workers and background targets', async t => {
  assert.doesNotThrow(() => requireDedicatedBrowser(targets, 'player'));
  for (const targetInfos of [[], [{ type: 'page', targetId: 'other' }], [...targets, { type: 'page', targetId: 'other' }],
    ...['service_worker', 'shared_worker', 'background_page', 'iframe'].map(type => [...targets, { type, targetId: 'other' }])]) {
    const f = fake({ targetInfos });
    await assert.rejects(startBrowserCpuTrace(f.client, { targetId: 'player', output: await output(t) }), /dedicated browser/);
    assert.deepEqual(f.calls.map(call => call.method), ['Target.getTargets']);
  }
});

test('stream capture hashes exact bytes, closes its handle and finishes only once', async t => {
  const prefix = await output(t), split = 6;
  const f = fake({ chunks: [{ data: body.slice(0, split), eof: false },
    { data: Buffer.from(body.slice(split)).toString('base64'), base64Encoded: true, eof: true }] });
  const capture = await startBrowserCpuTrace(f.client, { targetId: 'player', output: prefix });
  const first = capture.finish(), second = capture.finish(); assert.equal(first, second);
  const report = await first; await capture.abort();
  assert.equal(report.status, 'captured'); assert.equal(report.dataLossOccurred, false); assert.equal(report.intervalUs, null);
  assert.equal(report.traceSha256, hash(body)); assert.equal(report.bytes, Buffer.byteLength(body));
  assert.equal(await readFile(prefix + '.trace.json', 'utf8'), body);
  assert.deepEqual(JSON.parse(await readFile(prefix + '.trace-meta.json', 'utf8')), report);
  assert.equal(f.calls.filter(call => call.method === 'Tracing.end').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'IO.close').length, 1);
  assert.equal(f.listening(), false);
  const start = f.calls.find(call => call.method === 'Tracing.start').params;
  assert.equal(start.transferMode, 'ReturnAsStream'); assert.equal(start.streamFormat, 'json');
  assert.ok(f.calls.every(call => Number.isSafeInteger(call.limits.timeoutMs) && call.limits.timeoutMs > 0));
});

test('failed start never stops an existing trace or overwrites prior files', async t => {
  const prefix = await output(t), f = fake({ failStart: true });
  await assert.rejects(startBrowserCpuTrace(f.client, { targetId: 'player', output: prefix }), /already running/);
  assert.equal(f.calls.some(call => call.method === 'Tracing.end'), false);
  assert.equal(JSON.parse(await readFile(prefix + '.trace-meta.json', 'utf8')).status, 'failed');
  assert.equal(f.listening(), false);
  const existing = await output(t); await writeFile(existing + '.trace.json', 'keep');
  const other = fake();
  await assert.rejects(startBrowserCpuTrace(other.client, { targetId: 'player', output: existing }), /EEXIST/);
  assert.equal(await readFile(existing + '.trace.json', 'utf8'), 'keep');
  assert.equal(other.calls.some(call => call.method.startsWith('Tracing.')), false);
});

test('lost or unknown trace data is retained as failed and cannot produce valid metadata', async t => {
  for (const dataLossOccurred of [true, undefined]) {
    const prefix = await output(t), f = fake({ completion: { stream: 'trace-stream', dataLossOccurred } });
    const capture = await startBrowserCpuTrace(f.client, { targetId: 'player', output: prefix });
    await assert.rejects(capture.finish(), /data loss/);
    const report = JSON.parse(await readFile(prefix + '.trace-meta.json', 'utf8'));
    assert.equal(report.status, 'failed'); assert.notEqual(report.dataLossOccurred, false);
    assert.equal(report.traceSha256, hash(body));
    assert.equal(f.calls.filter(call => call.method === 'IO.close').length, 1);
  }
});

test('completed trace retains an explicit warning when stream cleanup is unconfirmed', async t => {
  const prefix = await output(t), f = fake({ failClose: true });
  const capture = await startBrowserCpuTrace(f.client, { targetId: 'player', output: prefix });
  const report = await capture.finish();
  assert.equal(report.status, 'captured'); assert.equal(report.cleanupFailed, true);
  assert.equal(report.traceSha256, hash(body));
  assert.equal(JSON.parse(await readFile(prefix + '.trace-meta.json', 'utf8')).cleanupFailed, true);
});

test('read failures, oversized output, stalled streams and deadlines fail with bounded cleanup', async t => {
  const cases = [
    [{ failRead: true }, {}, /disconnected/],
    [{}, { maxBytes: 3 }, /size limit/],
    [{ chunks: [{ data: '', eof: false }] }, {}, /no progress/],
    [{ chunks: [{ data: '', eof: true }] }, {}, /empty/],
    [{ chunks: [{ data: 'x', eof: false }], readDelay: 10 }, { streamDeadlineMs: 2 }, /deadline/],
    [{ completion: null }, { completeTimeoutMs: 5 }, /completion timeout/],
    [{ failEnd: true }, {}, /connection closed/],
  ];
  for (const [fakeOptions, limits, pattern] of cases) {
    const prefix = await output(t), f = fake(fakeOptions);
    const capture = await startBrowserCpuTrace(f.client, { targetId: 'player', output: prefix, ...limits });
    await assert.rejects(capture.finish(), pattern); await capture.abort();
    const report = JSON.parse(await readFile(prefix + '.trace-meta.json', 'utf8'));
    assert.equal(report.status, 'failed'); assert.equal(report.traceSha256, null);
    assert.equal(f.calls.filter(call => call.method === 'Tracing.end').length, 1);
    assert.equal(f.listening(), false);
  }
});

test('aborted page capture stops once, discards the stream and marks its artifacts failed', async t => {
  const prefix = await output(t), f = fake();
  const capture = await startBrowserCpuTrace(f.client, { targetId: 'player', output: prefix });
  await Promise.all([capture.abort(), capture.abort()]);
  assert.equal(f.calls.filter(call => call.method === 'Tracing.end').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'IO.close').length, 1);
  assert.equal(f.calls.some(call => call.method === 'IO.read'), false);
  assert.equal(JSON.parse(await readFile(prefix + '.trace-meta.json', 'utf8')).status, 'failed');
  assert.deepEqual((await readdir(dirname(prefix))).sort(), ['capture.trace-meta.json', 'capture.trace.json']);
});
