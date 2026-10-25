import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractProfiles, parseOptions, run, verifyTrace } from './extract-trace-profiles.mjs';
import { summarizeProfile } from './summarize-cpu-profile.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cat = 'disabled-by-default-v8.cpu_profiler';
const frame = (functionName, scriptId = 4) => ({ functionName, scriptId });
const event = (name, data, ts, overrides = {}) => ({ name, cat, ph: 'P', pid: 5, tid: name === 'Profile' ? 7 : 99, id: '0x1', ts, args: { data }, ...overrides });
const fixture = () => ({ traceEvents: [
  { name: 'thread_name', pid: 5, tid: 7, args: { name: 'DedicatedWorker thread' } },
  event('Profile', { startTime: 100 }, 101),
  event('ProfileChunk', { cpuProfile: { nodes: [{ id: 1, callFrame: frame('(root)', 0) },
    { id: 2, parent: 1, callFrame: frame('wasm-function[7]') }], samples: [2] }, timeDeltas: [10] }, 120),
  event('ProfileChunk', { cpuProfile: { nodes: [{ id: 3, parent: 2, callFrame: frame('wait') }], samples: [3, 2] }, timeDeltas: [20, 30] }, 180),
] });

async function localFixture(directory, trace = fixture()) {
  const options = { trace: join(directory, 'trace.json'), metadata: join(directory, 'metadata.json'), outDir: join(directory, 'profiles') };
  const bytes = JSON.stringify(trace);
  await Promise.all([writeFile(options.trace, bytes), writeFile(options.metadata, JSON.stringify({ traceSha256: hash(bytes), dataLossOccurred: false }))]);
  return options;
}

test('requires explicit unique trace, metadata and output directory arguments', () => {
  const args = ['--trace', 'trace.json', '--metadata', 'metadata.json', '--out-dir', 'profiles'];
  assert.equal(parseOptions(args).outDir, 'profiles');
  for (const invalid of [[], args.slice(0, -1), [...args, '--trace', 'again'], [...args, '--bad', 'x']]) assert.throws(() => parseOptions(invalid));
});

test('requires confirmed no data loss and a matching trace digest', () => {
  const bytes = Buffer.from('{}'), metadata = { dataLossOccurred: false, traceSha256: hash(bytes) };
  assert.equal(verifyTrace(bytes, metadata), hash(bytes));
  assert.equal(verifyTrace(bytes, { ...metadata, status: 'captured' }), hash(bytes));
  for (const invalid of [{}, { ...metadata, dataLossOccurred: true }, { ...metadata, dataLossOccurred: null },
    { ...metadata, status: 'failed' }, { ...metadata, status: null }, { ...metadata, traceSha256: 'f'.repeat(64) }]) assert.throws(() => verifyTrace(bytes, invalid));
});

test('reconstructs parent trees and sample boundaries without relabeling writer threads', () => {
  const [{ profile, identity }] = extractProfiles(fixture());
  assert.equal(identity.tid, 7); assert.deepEqual(identity.writerTids, [99]);
  assert.deepEqual(identity.threadNames, ['DedicatedWorker thread']);
  assert.equal(profile.nodes[1].callFrame.scriptId, '4');
  assert.deepEqual(profile.nodes.map(node => node.children), [[2], [3], []]);
  assert.deepEqual(profile.samples, [2, 3, 2]); assert.deepEqual(profile.timeDeltas, [10, 20, 30]);
  assert.equal(profile.startTime, 100); assert.equal(profile.endTime, 160);
  assert.equal(profile.endTimeSource, 'last-sample'); assert.equal(identity.unsampledTailUs, null);
  const summary = summarizeProfile(profile, new Map([[7, 'IRInterpret']]), { wasmSha256: 'a'.repeat(64), symbolsSha256: 'b'.repeat(64) });
  assert.equal(summary.endTimeSource, 'last-sample'); assert.equal(summary.unassignedTailUs, null);
  assert.equal(summary.attributedUs, 60);
});

test('orders chunks by timestamp with stable ties even when the start appears later in the file', () => {
  const trace = fixture(), [metadata, start, first, last] = trace.traceEvents;
  last.ts = first.ts;
  const extra = event('ProfileChunk', { cpuProfile: { samples: [2] }, timeDeltas: [5] }, 119);
  trace.traceEvents = [metadata, extra, first, last, start];
  const [out] = extractProfiles(trace);
  assert.deepEqual(out.profile.timeDeltas, [5, 10, 20, 30]);
  assert.deepEqual(out.profile.samples, [2, 2, 3, 2]);
  trace.traceEvents = [last, start, metadata, extra, first]; last.ts = 180;
  assert.deepEqual(extractProfiles(trace)[0].profile.timeDeltas, [5, 10, 20, 30]);
});

test('groups the same profile id independently across processes', () => {
  const first = fixture(), second = fixture();
  for (const item of second.traceEvents) item.pid = 6;
  const profiles = extractProfiles([...first.traceEvents, ...second.traceEvents]);
  assert.equal(profiles.length, 2); assert.deepEqual(profiles.map(item => item.identity.pid), [5, 6]);
  assert.ok(profiles.every(item => item.profile.samples.length === 3));
});

test('preserves the V8 scriptless bridge sentinel without inventing a module identity', () => {
  const trace = fixture(); trace.traceEvents[3].args.data.cpuProfile.nodes[0].callFrame = frame('wasm-to-js', -1);
  const [out] = extractProfiles(trace);
  assert.equal(out.profile.nodes[2].callFrame.scriptId, '-1');
  assert.equal(out.profile.nodes[2].callFrame.functionName, 'wasm-to-js');
  trace.traceEvents[3].args.data.cpuProfile.nodes[0].callFrame.functionName = 'wasm-function[8]';
  assert.throws(() => extractProfiles(trace), /module identity/);
});

test('uses a recorded endpoint when present and rejects chunks after it', () => {
  const trace = fixture(); trace.traceEvents.push(event('ProfileChunk', { endTime: 200 }, 210));
  const [out] = extractProfiles(trace);
  assert.equal(out.profile.endTime, 200); assert.equal(out.profile.endTimeSource, 'recorded'); assert.equal(out.identity.unsampledTailUs, 40);
  trace.traceEvents.push(event('ProfileChunk', { cpuProfile: { samples: [2] }, timeDeltas: [1] }, 211));
  assert.throws(() => extractProfiles(trace), /continue after/);
});

test('rejects unknown, missing or repeated starts and malformed event identities', () => {
  const mutations = [
    t => t.traceEvents.splice(1, 1),
    t => delete t.traceEvents[1].args.data.startTime,
    t => t.traceEvents.push(structuredClone(t.traceEvents[1])),
    t => t.traceEvents[2].pid = -1,
    t => t.traceEvents[2].tid = '7',
    t => t.traceEvents[2].id = 1,
    t => t.traceEvents[2].ts = 1.5,
    t => t.traceEvents[2].ph = 'X',
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => extractProfiles(input)); }
  assert.throws(() => extractProfiles({}), /event array/);
  assert.throws(() => extractProfiles([]), /no supported/);
});

test('rejects duplicate ids, missing parents, roots, cycles and malformed call frames', () => {
  const mutations = [
    t => t.traceEvents[3].args.data.cpuProfile.nodes[0].id = 2,
    t => t.traceEvents[3].args.data.cpuProfile.nodes[0].parent = 88,
    t => delete t.traceEvents[3].args.data.cpuProfile.nodes[0].parent,
    t => { t.traceEvents[2].args.data.cpuProfile.nodes[1].parent = 3; },
    t => t.traceEvents[2].args.data.cpuProfile.nodes[0].parent = 3,
    t => t.traceEvents[2].args.data.cpuProfile.nodes[1].callFrame.scriptId = null,
    t => t.traceEvents[2].args.data.cpuProfile.nodes[1].callFrame.functionName = 2,
    t => t.traceEvents[2].args.data.cpuProfile.nodes[1].callFrame.lineNumber = -2,
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => extractProfiles(input)); }
});

test('rejects mismatched sample lengths, unknown samples and invalid timing', () => {
  const mutations = [
    t => t.traceEvents[2].args.data.timeDeltas = [],
    t => t.traceEvents[3].args.data.cpuProfile.samples[0] = 88,
    t => t.traceEvents[3].args.data.timeDeltas[0] = -1,
    t => t.traceEvents[3].args.data.timeDeltas[0] = 1.5,
    t => t.traceEvents[3].args.data.endTime = 120,
    t => t.traceEvents[3].args.data.endTime = null,
    t => t.traceEvents[3].args.data.timeDeltas[0] = Number.MAX_SAFE_INTEGER,
    t => t.traceEvents[1].args.data.startTime = Number.MAX_SAFE_INTEGER,
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => extractProfiles(input)); }
});

test('writes checkable output only to a new directory and never overwrites an input alias', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-profiles-'));
  try {
    const options = await localFixture(directory), original = hash(await readFile(options.trace));
    const manifest = await run(options);
    assert.equal(manifest.traceSha256, original); assert.equal(manifest.profiles.length, 1);
    const bytes = await readFile(join(options.outDir, manifest.profiles[0].file));
    assert.equal(hash(bytes), manifest.profiles[0].profileSha256);
    assert.deepEqual(JSON.parse(await readFile(join(options.outDir, 'manifest.json'), 'utf8')), manifest);
    await assert.rejects(run(options), /already exists/);
    await assert.rejects(run({ ...options, outDir: options.trace }), /already exists/);
    const alias = join(directory, 'trace-alias'); await link(options.trace, alias);
    await assert.rejects(run({ ...options, outDir: alias }), /already exists/);
    assert.equal(hash(await readFile(options.trace)), original);
    assert.equal((await readdir(options.outDir)).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('validation failures do not create an output directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-profiles-'));
  try {
    const options = await localFixture(directory), invalid = fixture(); invalid.traceEvents.splice(1, 1);
    await localFixture(directory, invalid);
    await assert.rejects(run(options), /startTime/);
    assert.equal((await readdir(directory)).includes('profiles'), false);
    await mkdir(options.outDir);
    await writeFile(options.metadata, JSON.stringify({ traceSha256: 'a'.repeat(64), dataLossOccurred: false }));
    await assert.rejects(run(options), /digest/);
    assert.deepEqual(await readdir(options.outDir), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
