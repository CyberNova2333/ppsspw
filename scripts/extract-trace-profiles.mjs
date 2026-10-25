#!/usr/bin/env node
// Convert V8 trace chunks locally; raw profiles can retain private source URLs.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA256 = /^[a-f0-9]{64}$/;
const identity = event => JSON.stringify([event.pid, event.id]);

export function parseOptions(args) {
  const options = {}, names = new Map([['--trace', 'trace'], ['--metadata', 'metadata'], ['--out-dir', 'outDir']]);
  for (let i = 0; i < args.length; i++) {
    const name = names.get(args[i]);
    if (!name || options[name] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected unique --trace, --metadata and --out-dir paths.');
    options[name] = args[++i];
  }
  if ([...names.values()].some(name => !options[name])) throw new Error('All three paths are required.');
  return options;
}

export function verifyTrace(traceBytes, metadata) {
  if (metadata?.dataLossOccurred !== false || !SHA256.test(metadata?.traceSha256 ?? '')
      || metadata.status !== undefined && metadata.status !== 'captured') {
    throw new Error('Trace metadata requires a successful capture, dataLossOccurred: false and a traceSha256 digest.');
  }
  const traceSha256 = hash(traceBytes);
  if (traceSha256 !== metadata.traceSha256) throw new Error('Trace digest does not match its capture metadata.');
  return traceSha256;
}

function normalizeNode(node) {
  const frame = node?.callFrame;
  if (!integer(node?.id) || (node.parent !== undefined && !integer(node.parent)) || typeof frame?.functionName !== 'string'
      || !(Number.isSafeInteger(frame.scriptId) && frame.scriptId >= -1 || typeof frame.scriptId === 'string' && frame.scriptId.trim())
      || (frame.url !== undefined && typeof frame.url !== 'string')
      || [frame.lineNumber, frame.columnNumber].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < -1))) {
    throw new Error('Trace node requires an id, valid parent and valid call frame.');
  }
  if (/^wasm-function\[\d+\]$/.test(frame.functionName) && String(frame.scriptId) === '-1') {
    throw new Error('A WASM function requires a module identity, not the scriptless sentinel.');
  }
  return { id: node.id, parent: node.parent, callFrame: { functionName: frame.functionName, scriptId: String(frame.scriptId),
    url: frame.url ?? '', lineNumber: frame.lineNumber ?? -1, columnNumber: frame.columnNumber ?? -1 }, children: [] };
}

function finishProfile(group, threadNames) {
  const start = group.start?.args?.data?.startTime;
  if (!integer(start)) throw new Error('Every trace profile requires one recorded startTime.');
  const nodes = new Map(), samples = [], timeDeltas = [], writerTids = new Set();
  let recordedEnd, total = 0;
  // Trace file order is not guaranteed across writer threads; ties retain file order.
  group.chunks.sort((a, b) => a.event.ts - b.event.ts || a.order - b.order);
  for (const { event } of group.chunks) {
    if (recordedEnd !== undefined) throw new Error('Profile chunks continue after a recorded endTime.');
    writerTids.add(event.tid);
    const data = event.args?.data, cpu = data?.cpuProfile;
    if (!data || (cpu !== undefined && (!cpu || typeof cpu !== 'object' || Array.isArray(cpu)))) throw new Error('Invalid ProfileChunk data.');
    const chunkNodes = cpu?.nodes ?? [], chunkSamples = cpu?.samples ?? [], chunkDeltas = data.timeDeltas ?? [];
    if (![chunkNodes, chunkSamples, chunkDeltas].every(Array.isArray) || chunkSamples.length !== chunkDeltas.length) {
      throw new Error('ProfileChunk samples and timeDeltas must have equal lengths.');
    }
    for (const raw of chunkNodes) {
      const node = normalizeNode(raw);
      if (nodes.has(node.id)) throw new Error('Trace profile contains a duplicate node id.');
      nodes.set(node.id, node);
    }
    for (let i = 0; i < chunkSamples.length; i++) {
      if (!integer(chunkSamples[i]) || !integer(chunkDeltas[i])) throw new Error('Trace samples and time deltas must be nonnegative integers.');
      total += chunkDeltas[i];
      if (!integer(total)) throw new Error('Trace time-delta total exceeds safe integer precision.');
      samples.push(chunkSamples[i]); timeDeltas.push(chunkDeltas[i]);
    }
    if (data.endTime !== undefined) {
      if (!integer(data.endTime)) throw new Error('Recorded endTime must be a nonnegative integer.');
      recordedEnd = data.endTime;
    }
  }
  if (!nodes.size || !samples.length) throw new Error('Trace profile has no nodes or samples.');
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parent === undefined) roots.push(node.id);
    else {
      if (!nodes.has(node.parent)) throw new Error('Trace node refers to a missing parent.');
      nodes.get(node.parent).children.push(node.id);
    }
  }
  if (roots.length !== 1) throw new Error('Trace profile must have exactly one tree root.');
  const pending = [roots[0]], visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) throw new Error('Trace profile contains a node cycle.');
    visited.add(id); pending.push(...nodes.get(id).children);
  }
  if (visited.size !== nodes.size) throw new Error('Trace profile contains disconnected or cyclic nodes.');
  if (samples.some(id => !nodes.has(id))) throw new Error('Trace sample refers to a missing node.');
  const lastSampleTime = start + total;
  if (!integer(lastSampleTime) || recordedEnd !== undefined && recordedEnd < lastSampleTime) throw new Error('Trace samples exceed the recorded interval or safe precision.');
  const endBoundary = recordedEnd === undefined ? 'last-sample' : 'recorded';
  return {
    identity: { pid: group.start.pid, tid: group.start.tid, id: group.start.id,
      threadNames: threadNames.get(JSON.stringify([group.start.pid, group.start.tid])) ?? [],
      writerTids: [...writerTids].sort((a, b) => a - b), chunkCount: group.chunks.length,
      endBoundary, unsampledTailUs: recordedEnd === undefined ? null : recordedEnd - lastSampleTime },
    profile: { nodes: [...nodes.values()].map(({ parent, ...node }) => node), startTime: start,
      endTime: recordedEnd ?? lastSampleTime, endTimeSource: endBoundary, samples, timeDeltas },
  };
}

export function extractProfiles(trace) {
  const events = Array.isArray(trace) ? trace : trace?.traceEvents;
  if (!Array.isArray(events)) throw new Error('Trace must be an event array or contain traceEvents.');
  const groups = new Map(), threadNames = new Map();
  for (const [order, event] of events.entries()) {
    if (event?.name === 'thread_name' && integer(event.pid) && integer(event.tid) && typeof event.args?.name === 'string') {
      const key = JSON.stringify([event.pid, event.tid]), names = threadNames.get(key) ?? [];
      if (!names.includes(event.args.name)) names.push(event.args.name);
      threadNames.set(key, names);
    }
    if (!['Profile', 'ProfileChunk'].includes(event?.name) || !event.cat?.split(',').some(category => category.trim() === 'disabled-by-default-v8.cpu_profiler')) continue;
    if (!integer(event.pid) || !integer(event.tid) || !integer(event.ts) || typeof event.id !== 'string' || !event.id || event.ph !== 'P') {
      throw new Error('V8 profile events require pid, tid, timestamp, id and phase P.');
    }
    const key = identity(event), group = groups.get(key) ?? { chunks: [] };
    if (event.name === 'Profile') {
      if (group.start) throw new Error('Duplicate Profile start for the same process and id.');
      group.start = event;
    } else group.chunks.push({ event, order });
    groups.set(key, group);
  }
  if (!groups.size) throw new Error('Trace contains no supported V8 CPU profiles.');
  return [...groups.values()].map(group => finishProfile(group, threadNames));
}

export async function run(options) {
  const [traceBytes, metadataBytes] = await Promise.all([readFile(options.trace), readFile(options.metadata)]);
  const traceSha256 = verifyTrace(traceBytes, JSON.parse(metadataBytes));
  const profiles = extractProfiles(JSON.parse(traceBytes));
  // Creating a new directory also rejects input aliases, links and existing output.
  try { await mkdir(options.outDir); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Output directory already exists; choose a new --out-dir path.', { cause: error });
    throw error;
  }
  const manifest = { schemaVersion: 1, traceSha256, dataLossOccurred: false, profiles: [], notes: [
    'Profile pid/id identify the stream; its tid identifies the sampled thread. ProfileChunk tid identifies a writer and is not a thread role.',
    'last-sample endTime is reconstructed as startTime plus the recorded sample deltas, not the profiler stop time. The unsampled tail length is unknown.',
    'No thread role or idle status is inferred from an absent stream. Profiles can retain private URLs and should remain local.',
  ] };
  for (const [index, { identity, profile }] of profiles.entries()) {
    const file = `thread-${index + 1}.cpuprofile`, bytes = JSON.stringify(profile) + '\n';
    await writeFile(join(options.outDir, file), bytes, { flag: 'wx' });
    manifest.profiles.push({ ...identity, file, profileSha256: hash(bytes), sampleCount: profile.samples.length,
      startTimeUs: profile.startTime, endTimeUs: profile.endTime });
  }
  await writeFile(join(options.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const manifest = await run(parseOptions(process.argv.slice(2))); console.log(`Extracted ${manifest.profiles.length} trace profiles.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
