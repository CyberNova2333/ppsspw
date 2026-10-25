#!/usr/bin/env node
// Summarize one local CDP profile; each worker must be analyzed separately.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const percent = (part, total) => total ? Math.round(part / total * 100000) / 1000 : 0;
const WASM_FUNCTION = /^wasm-function\[(\d+)\]$/;
const WAIT_CANDIDATE = /futex|atomic(?:s)?[._ ]?wait|pthread_cond|nanosleep|emscripten_thread_sleep|emscripten_proxy_sync|(?:^|::)(?:wait|wait_for|wait_until)(?:\(|$)/i;

export function parseOptions(args) {
  const options = {};
  const names = new Set(['profile', 'wasm', 'symbols', 'metadata', 'out']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!names.has(name) || options[name] || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Expected unique --profile, --wasm, --symbols, --metadata and --out paths.');
    }
    options[name] = args[++i];
  }
  if ([...names].some(name => !options[name])) throw new Error('All five input/output paths are required.');
  if (['profile', 'wasm', 'symbols', 'metadata'].some(name => resolve(options[name]) === resolve(options.out))) {
    throw new Error('Output must not replace an input.');
  }
  return options;
}

export function verifySymbolArtifacts(wasmBytes, symbolBytes, metadata) {
  if (!SHA256.test(metadata?.wasmSha256 ?? '') || !SHA256.test(metadata?.symbolsSha256 ?? '')) {
    throw new Error('Symbol metadata requires wasmSha256 and symbolsSha256 SHA-256 digests.');
  }
  const wasmSha256 = hash(wasmBytes), symbolsSha256 = hash(symbolBytes);
  if (wasmSha256 !== metadata.wasmSha256 || symbolsSha256 !== metadata.symbolsSha256) {
    throw new Error('WASM or symbol-map digest does not match its metadata.');
  }
  return { wasmSha256, symbolsSha256 };
}

export function parseSymbolMap(text) {
  if (typeof text !== 'string') throw new Error('Symbol map must be UTF-8 text.');
  const symbols = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(0|[1-9]\d*):([^\r\n\x00-\x1f]+)$/.exec(line);
    const index = match ? Number(match[1]) : NaN;
    if (!integer(index) || !match[2].trim() || symbols.has(index)) {
      throw new Error('Invalid or duplicate function index in Emscripten symbol map.');
    }
    symbols.set(index, match[2]);
  }
  if (!symbols.size) throw new Error('Symbol map is empty.');
  return symbols;
}

function validateProfile(profile) {
  if (!Array.isArray(profile?.nodes) || !profile.nodes.length || !Array.isArray(profile.samples)
      || !Array.isArray(profile.timeDeltas) || !profile.samples.length || profile.samples.length !== profile.timeDeltas.length
      || !integer(profile.startTime) || !integer(profile.endTime) || profile.endTime < profile.startTime) {
    throw new Error('Profile requires nodes, equal nonempty samples/timeDeltas and ordered microsecond timestamps.');
  }
  if (profile.endTimeSource !== undefined && !['recorded', 'last-sample'].includes(profile.endTimeSource)) {
    throw new Error('Unknown profile endTimeSource.');
  }
  const nodes = new Map(), parents = new Map();
  for (const node of profile.nodes) {
    if (!integer(node?.id) || nodes.has(node.id) || typeof node.callFrame?.functionName !== 'string'
        || (node.children !== undefined && !Array.isArray(node.children))) {
      throw new Error('Profile nodes require unique integer ids, function names and valid child lists.');
    }
    nodes.set(node.id, node);
  }
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      if (!integer(child) || !nodes.has(child) || parents.has(child)) throw new Error('Profile contains unknown or multiply parented child nodes.');
      parents.set(child, node.id);
    }
  }
  const roots = [...nodes.keys()].filter(id => !parents.has(id));
  if (roots.length !== 1) throw new Error('Profile must have exactly one tree root.');
  const visited = new Set(), pending = [roots[0]];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) throw new Error('Profile contains a node cycle.');
    visited.add(id);
    pending.push(...(nodes.get(id).children ?? []));
  }
  if (visited.size !== nodes.size) throw new Error('Profile contains disconnected or cyclic nodes.');
  let attributedUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    if (!integer(profile.samples[i]) || !nodes.has(profile.samples[i]) || !integer(profile.timeDeltas[i])) {
      throw new Error('Profile samples must reference existing nodes with nonnegative integer time deltas.');
    }
    attributedUs += profile.timeDeltas[i];
    if (!integer(attributedUs)) throw new Error('Profile time-delta total exceeds safe integer precision.');
  }
  if (attributedUs > profile.endTime - profile.startTime) throw new Error('Profile time deltas exceed its elapsed interval.');
  if (profile.endTimeSource === 'last-sample' && attributedUs !== profile.endTime - profile.startTime) {
    throw new Error('A last-sample boundary must equal startTime plus all sample deltas.');
  }
  return { nodes, parents, attributedUs };
}

export function summarizeProfile(profile, symbols, verifiedArtifacts) {
  if (!(symbols instanceof Map) || !symbols.size || !SHA256.test(verifiedArtifacts?.wasmSha256 ?? '')
      || !SHA256.test(verifiedArtifacts?.symbolsSha256 ?? '')) throw new Error('Verified artifact digests and a parsed symbol map are required.');
  const { nodes, parents, attributedUs } = validateProfile(profile);
  const functions = new Map(), nodeFunctions = new Map();
  let wasmScriptId = null;
  for (const node of nodes.values()) {
    const rawName = node.callFrame.functionName;
    const match = WASM_FUNCTION.exec(rawName);
    const index = match ? Number(match[1]) : null;
    if (match && (!integer(index) || !symbols.has(index))) throw new Error('Profile references a WASM function missing from the verified symbol map.');
    if (match) {
      const scriptId = node.callFrame.scriptId;
      if (typeof scriptId !== 'string' || !scriptId.trim()) throw new Error('Every WASM frame requires a nonempty scriptId to identify its module.');
      if (wasmScriptId !== null && wasmScriptId !== scriptId) throw new Error('Multiple WASM modules in one profile are not supported by a single symbol map.');
      wasmScriptId = scriptId;
    }
    // Script id and source position disambiguate same-named JS functions internally;
    // neither source paths nor URLs are copied into the resulting report.
    const key = match ? `wasm:${wasmScriptId}:${index}` : JSON.stringify([rawName, node.callFrame.scriptId, node.callFrame.lineNumber, node.callFrame.columnNumber]);
    const functionName = match ? symbols.get(index) : rawName;
    if (!functions.has(key)) functions.set(key, { kind: match ? 'wasm' : 'javascript-or-runtime',
      functionName, rawFunctionName: rawName, wasmFunctionIndex: index, nodeIds: [],
      possibleWait: WAIT_CANDIDATE.test(functionName), selfSamples: 0, selfAttributedUs: 0,
      inclusiveSamples: 0, inclusiveAttributedUs: 0 });
    functions.get(key).nodeIds.push(node.id);
    nodeFunctions.set(node.id, key);
  }
  for (let i = 0; i < profile.samples.length; i++) {
    let id = profile.samples[i];
    const delta = profile.timeDeltas[i];
    const leaf = functions.get(nodeFunctions.get(id));
    leaf.selfSamples++;
    leaf.selfAttributedUs += delta;
    // A recursive function is counted only once per sample in its inclusive total.
    const seen = new Set();
    while (id !== undefined) {
      const key = nodeFunctions.get(id);
      if (!seen.has(key)) {
        const entry = functions.get(key);
        entry.inclusiveSamples++;
        entry.inclusiveAttributedUs += delta;
        seen.add(key);
      }
      id = parents.get(id);
    }
  }
  const hotspots = [...functions.values()].filter(entry => entry.inclusiveSamples).map(entry => ({ ...entry,
    nodeIds: entry.nodeIds.sort((a, b) => a - b), selfSharePercent: percent(entry.selfAttributedUs, attributedUs),
    inclusiveSharePercent: percent(entry.inclusiveAttributedUs, attributedUs),
  })).sort((a, b) => b.selfAttributedUs - a.selfAttributedUs || b.inclusiveAttributedUs - a.inclusiveAttributedUs || a.functionName.localeCompare(b.functionName));
  return {
    schemaVersion: 1, measurement: 'sample-attributed-elapsed-time', threadCount: 1,
    artifacts: { wasmSha256: verifiedArtifacts.wasmSha256, symbolsSha256: verifiedArtifacts.symbolsSha256 },
    elapsedUs: profile.endTime - profile.startTime, sampleCount: profile.samples.length,
    endTimeSource: profile.endTimeSource ?? 'recorded',
    attributedUs, unassignedTailUs: profile.endTimeSource === 'last-sample' ? null : profile.endTime - profile.startTime - attributedUs, hotspots,
    notes: [
      'Each timeDelta is attributed to its corresponding sample, including the first interval from profile start. The final unsampled tail is not attributed.',
      profile.endTimeSource === 'last-sample'
        ? 'elapsedUs ends at the last recorded sample, not at profiler stop. The unsampled tail length is unknown; unassignedTailUs is null.'
        : 'elapsedUs uses the recorded profile start and end timestamps; the final unsampled tail is reported separately.',
      'These are sample-attributed elapsed intervals, not measured CPU execution time or CPU utilization. Waits, scheduling delays and profiler overhead can be included.',
      'One report describes one thread. Do not add elapsed attribution across threads or sum overlapping inclusive rows.',
      'possibleWait is a function-name hint, not proof of blocking. Original function names remain available; wait attribution is not evidence of removable execution cost.',
      'Only one WebAssembly module per profile is supported. Multiple module identities or missing WASM frame identities are rejected.',
      'Digests verify the supplied WASM and symbol-map pair against the supplied metadata. The capture operator must separately establish that this WASM was loaded by this profile.',
    ],
  };
}

export async function run(options) {
  const [profileBytes, wasmBytes, symbolBytes, metadataBytes] = await Promise.all([
    readFile(options.profile), readFile(options.wasm), readFile(options.symbols), readFile(options.metadata),
  ]);
  const artifacts = verifySymbolArtifacts(wasmBytes, symbolBytes, JSON.parse(metadataBytes));
  const report = summarizeProfile(JSON.parse(profileBytes), parseSymbolMap(symbolBytes.toString('utf8')), artifacts);
  report.profileSha256 = hash(profileBytes);
  try {
    await writeFile(options.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Output already exists; choose a new --out path.', { cause: error });
    throw error;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await run(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify({ sampleCount: report.sampleCount, attributedUs: report.attributedUs, functions: report.hotspots.length }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
