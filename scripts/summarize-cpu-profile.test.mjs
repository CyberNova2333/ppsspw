import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseOptions, parseSymbolMap, verifySymbolArtifacts, summarizeProfile, run } from './summarize-cpu-profile.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const symbolText = '0:__wasm_call_ctors\n7:IRInterpret\n9:emscripten_futex_wait\n';
const symbolBytes = Buffer.from(symbolText);
const metadata = { wasmSha256: hash(wasm), symbolsSha256: hash(symbolBytes) };
const symbols = () => parseSymbolMap(symbolText);
const node = (id, functionName, children = [], overrides = {}) => ({ id, children, callFrame: {
  functionName, scriptId: '1', url: 'file:///private/source.js', lineNumber: 10, columnNumber: 3, ...overrides,
} });
const fixture = () => ({ startTime: 100, endTime: 1120,
  nodes: [node(1, '(root)', [2, 5]), node(2, 'tick', [3]), node(3, 'wasm-function[7]', [4]),
    node(4, 'wasm-function[9]'), node(5, '(idle)')],
  samples: [3, 4, 5, 3], timeDeltas: [100, 400, 300, 200],
});
const summarize = profile => summarizeProfile(profile, symbols(), metadata);

async function writeFixture(directory) {
  const options = Object.fromEntries(['profile', 'wasm', 'symbols', 'metadata', 'out'].map(name => [name, join(directory, name)]));
  await Promise.all([writeFile(options.profile, JSON.stringify(fixture())), writeFile(options.wasm, wasm),
    writeFile(options.symbols, symbolBytes), writeFile(options.metadata, JSON.stringify(metadata))]);
  return options;
}

test('requires explicit paths, rejects duplicate flags and replacing inputs', () => {
  const args = ['--profile', 'capture.cpuprofile', '--wasm', 'core.wasm', '--symbols', 'core.symbols', '--metadata', 'symbols.json', '--out', 'summary.json'];
  assert.equal(parseOptions(args).out, 'summary.json');
  for (const bad of [[], args.slice(0, -1), [...args, '--profile', 'other'], [...args, '--unknown', 'x'],
    args.map(value => value === 'summary.json' ? 'core.wasm' : value)]) assert.throws(() => parseOptions(bad));
});

test('refuses missing or mismatched artifact digests', () => {
  assert.deepEqual(verifySymbolArtifacts(wasm, symbolBytes, metadata), metadata);
  for (const bad of [{}, { ...metadata, wasmSha256: 'a'.repeat(64) }, { ...metadata, symbolsSha256: 'b'.repeat(64) },
    { ...metadata, wasmSha256: '../private' }]) assert.throws(() => verifySymbolArtifacts(wasm, symbolBytes, bad));
  assert.throws(() => verifySymbolArtifacts(Buffer.from('different'), symbolBytes, metadata));
  assert.throws(() => verifySymbolArtifacts(wasm, Buffer.from(symbolText + '\n'), metadata));
});

test('parses function indices while preserving C++ symbol punctuation', () => {
  const result = parseSymbolMap('0:__wasm_call_ctors\r\n12:std::condition_variable::wait(std::unique_lock<std::mutex>&)\r\n');
  assert.equal(result.get(12), 'std::condition_variable::wait(std::unique_lock<std::mutex>&)');
  for (const bad of ['', 'x:name', '01:name', '-1:name', '1:', '1: \n', '1:name\n1:duplicate', '1:name\0', '9007199254740992:name']) {
    assert.throws(() => parseSymbolMap(bad));
  }
});

test('computes checkable self/inclusive attribution without relabeling wait time as CPU work', () => {
  const report = summarize(fixture());
  assert.equal(report.threadCount, 1);
  assert.equal(report.measurement, 'sample-attributed-elapsed-time');
  assert.equal(report.attributedUs, 1000);
  assert.equal(report.elapsedUs, 1020);
  assert.equal(report.unassignedTailUs, 20);
  const waiting = report.hotspots.find(row => row.wasmFunctionIndex === 9);
  assert.deepEqual(waiting, { kind: 'wasm', functionName: 'emscripten_futex_wait', rawFunctionName: 'wasm-function[9]',
    wasmFunctionIndex: 9, nodeIds: [4], possibleWait: true, selfSamples: 1, selfAttributedUs: 400,
    inclusiveSamples: 1, inclusiveAttributedUs: 400, selfSharePercent: 40, inclusiveSharePercent: 40 });
  const ir = report.hotspots.find(row => row.wasmFunctionIndex === 7);
  assert.equal(ir.selfAttributedUs, 300);
  assert.equal(ir.inclusiveAttributedUs, 700);
  assert.equal(ir.inclusiveSamples, 3);
  assert.equal(report.hotspots.reduce((sum, row) => sum + row.selfAttributedUs, 0), 1000);
  assert.ok(report.notes.some(note => note.includes('not measured CPU')));
  assert.ok(report.notes.some(note => note.includes('not evidence of removable execution cost')));
  assert.doesNotMatch(JSON.stringify(report), /private|source\.js|file:\/\//);
});

test('merges recursive frames without double-counting inclusive attribution', () => {
  const input = fixture();
  input.nodes[2].children = [6];
  input.nodes.push(node(6, 'wasm-function[7]', [4]));
  input.samples = [6]; input.timeDeltas = [1000];
  const ir = summarize(input).hotspots.find(row => row.wasmFunctionIndex === 7);
  assert.deepEqual(ir.nodeIds, [3, 6]);
  assert.equal(ir.selfAttributedUs, 1000); assert.equal(ir.inclusiveAttributedUs, 1000);
  assert.equal(ir.inclusiveSamples, 1);
});

test('keeps same-named JavaScript functions distinct by source identity without emitting source locations', () => {
  const input = fixture();
  input.nodes[0].children.push(6);
  input.nodes.push(node(6, 'tick', [], { scriptId: '2', url: 'https://private.test/secret.js' }));
  input.samples = [2, 6]; input.timeDeltas = [300, 700];
  const report = summarize(input), ticks = report.hotspots.filter(row => row.functionName === 'tick');
  assert.equal(ticks.length, 2);
  assert.deepEqual(ticks.map(row => row.selfAttributedUs), [700, 300]);
  assert.doesNotMatch(JSON.stringify(report), /private|secret|lineNumber|scriptId/);
});

test('rejects absent symbols and incomplete verified-artifact inputs', () => {
  const input = fixture(); input.nodes[2].callFrame.functionName = 'wasm-function[800]';
  assert.throws(() => summarize(input), /missing from/);
  assert.throws(() => summarizeProfile(fixture(), symbols(), {}), /Verified/);
  assert.throws(() => summarizeProfile(fixture(), new Map(), metadata), /Verified/);
});

test('rejects a second WASM module even when its function index exists in the symbol map', () => {
  for (const index of [7, 9]) {
    const input = fixture();
    input.nodes[0].children.push(6);
    input.nodes.push(node(6, `wasm-function[${index}]`, [], { scriptId: '2' }));
    input.samples = [3, 6]; input.timeDeltas = [300, 700];
    assert.throws(() => summarize(input), /Multiple WASM modules/);
  }
});

test('rejects WASM frames without an unambiguous module identity', () => {
  for (const scriptId of [undefined, null, '', ' ', 1, {}]) {
    const input = fixture(); input.nodes[2].callFrame.scriptId = scriptId;
    assert.throws(() => summarize(input), /nonempty scriptId/);
  }
});

test('rejects malformed trees, samples and elapsed intervals', () => {
  const mutations = [
    p => p.nodes.push(structuredClone(p.nodes[0])),
    p => p.nodes[1].children.push(99),
    p => p.nodes[0].children.push(4),
    p => p.nodes[0].children = [5],
    p => p.nodes[3].children = [1],
    p => p.nodes.push(node(6, 'cycle', [7]), node(7, 'cycle', [6])),
    p => p.nodes[0].children = 'bad',
    p => delete p.nodes[0].callFrame.functionName,
    p => p.samples[0] = 99,
    p => p.samples.pop(),
    p => p.timeDeltas[0] = -1,
    p => p.timeDeltas[0] = 1.5,
    p => p.timeDeltas[0] = NaN,
    p => p.timeDeltas[0] = 50000,
    p => p.startTime = -1,
    p => p.endTime = p.startTime - 1,
    p => { p.samples = []; p.timeDeltas = []; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input);
    assert.throws(() => summarize(input));
  }
});

test('allows zero-duration sample deltas without inventing attribution', () => {
  const input = fixture(); input.timeDeltas.fill(0);
  const report = summarize(input);
  assert.equal(report.attributedUs, 0);
  assert.ok(report.hotspots.every(row => row.selfSharePercent === 0 && row.inclusiveSharePercent === 0));
});

test('local runner verifies artifacts before writing a path-free summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-summary-'));
  try {
    const options = await writeFixture(directory);
    const profileBytes = await readFile(options.profile);
    const report = await run(options);
    assert.equal(report.profileSha256, hash(profileBytes));
    assert.deepEqual(JSON.parse(await readFile(options.out, 'utf8')), report);
    const outputHash = hash(await readFile(options.out));
    await assert.rejects(run(options), /Output already exists; choose a new --out path/);
    assert.equal(hash(await readFile(options.out)), outputHash);
    await writeFile(options.symbols, '0:wrong-map');
    await assert.rejects(run(options), /digest/);
    assert.deepEqual(JSON.parse(await readFile(options.out, 'utf8')), report);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('direct runner refuses input paths and hard-link aliases without changing input contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-summary-'));
  try {
    const options = await writeFixture(directory);
    const inputPaths = ['profile', 'wasm', 'symbols', 'metadata'].map(name => options[name]);
    const inputHashes = await Promise.all(inputPaths.map(async path => hash(await readFile(path))));
    const alias = join(directory, 'wasm-alias');
    await link(options.wasm, alias);
    for (const out of [...inputPaths, alias]) {
      await assert.rejects(run({ ...options, out }), /Output already exists; choose a new --out path/);
      assert.deepEqual(await Promise.all(inputPaths.map(async path => hash(await readFile(path)))), inputHashes);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows case aliases cannot replace an input', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-summary-'));
  try {
    const options = await writeFixture(directory);
    const originalHash = hash(await readFile(options.wasm));
    const args = ['--profile', options.profile, '--wasm', options.wasm, '--symbols', options.symbols,
      '--metadata', options.metadata, '--out', join(directory, 'WASM')];
    await assert.rejects(run(parseOptions(args)), /Output already exists; choose a new --out path/);
    assert.equal(hash(await readFile(options.wasm)), originalHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
