import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeRun, compareReports, parseOptions, run, validateManifest } from './compare-browser-performance.mjs';

const MiB = 1024 * 1024;
function manifest(overrides = {}) {
  return { schemaVersion: 1, dimension: 'initialMemoryBytes', environment: { id: 'local-device', kind: 'desktop' },
    scene: { id: 'video-segment', alignment: 'emulated-time', startEmulatedUs: 30000000 }, minValidDurationMs: 1000,
    runs: [{ id: 'small-a', pair: 'a', report: 'small.json', value: 256 * MiB },
      { id: 'large-a', pair: 'a', report: 'large.json', value: 512 * MiB }], ...overrides };
}
function report(initialMemoryBytes = 256 * MiB, times = [0, 1000, 3000], flips = [0, 20, 80]) {
  const resources = { initialMemoryBytes, maximumMemoryBytes: 4 * 1024 * MiB, configuredComputeThreads: 2, configuredPthreadPoolSize: 0,
    actualComputeThreads: 2, actualThreadManagerThreads: 6, cpuBackend: 2, completedHeapResizeRequests: 0,
    heapResizeSuccesses: 0, heapResizeFailures: 0, heapResizeTotalMs: 0, heapResizeMaxMs: 0, currentWasmCapacityBytes: initialMemoryBytes };
  return { schemaVersion: 2, webVersion: 'ppsspp-player-v6', active: false, samplingErrors: 0, visibilityChanges: 0, totalSamples: times.length, durationMs: times.at(-1),
    coreRevision: (initialMemoryBytes === 256 * MiB ? 'a' : 'b').repeat(64),
    build: { initialMemoryBytes, maximumMemoryBytes: 4 * 1024 * MiB, computeThreads: 2, pthreadPoolSize: 0, sourceFingerprint: 'c'.repeat(64) },
    environment: { hardwareConcurrency: 8, deviceMemoryGB: 8, crossOriginIsolated: true, sharedArrayBuffer: true,
      viewportWidth: 844, viewportHeight: 390, devicePixelRatio: 1 },
    settings: { resolution: 1, touch: false, showFps: false, appliedAtLaunch: true },
    startup: { runtimeReadyMs: 800, gameBootedMs: 1600 },
    samples: times.map((elapsedMs, index) => ({ elapsedMs, visible: true, wasmMemoryBytes: initialMemoryBytes,
      core: { initialized: true, emulating: true, intervalValid: index > 0, sampleAgeMs: 2, sequence: (index + 1) * 2,
        flips: flips[index], vblanks: elapsedMs * 0.06, emulatedUs: 30000000 + elapsedMs * 1000,
        actualFps: 999, speedPercent: 999 }, resources: { ...resources }, audioCounters: { underruns: index } })) };
}

test('paired comparison recomputes rates from counters with duration weighting, ignoring supplied rates', () => {
  const result = compareReports(manifest(), [report(), report(512 * MiB)]);
  assert.equal(result.status, 'comparable');
  assert.equal(result.runs[0].metrics.weightedFps, 26.667); // (20 + 60) / (1 + 2), not (20 + 30) / 2.
  assert.equal(result.runs[0].metrics.weightedSpeedPercent, 100);
  assert.equal(result.runs[0].metrics.audioUnderruns, 2);
  assert.equal(result.pairs[0].comparisons[0].fpsDifference, 0);
  assert.equal(result.pairs[0].comparisons[0].wasmCapacityMaxDifferenceBytes, 256 * MiB);
  assert.match(result.notes.join(' '), /not game FPS/);
  assert.equal(result.environment.kind, 'desktop');
});

test('three variants and repeated pairs aggregate over valid duration rather than means of runs', () => {
  const config = manifest();
  config.runs = [];
  const reports = [];
  for (const pair of ['a', 'b']) for (const size of [256, 384, 512]) {
    config.runs.push({ id: `m${size}-${pair}`, pair, report: 'unused.json', value: size * MiB });
    reports.push(pair === 'a' ? report(size * MiB, [0, 1000], [0, 10]) : report(size * MiB, [0, 2000], [0, 60]));
  }
  const result = compareReports(config, reports);
  assert.equal(result.status, 'comparable');
  assert.equal(result.variants.length, 3); assert.equal(result.pairs.length, 2);
  for (const variant of result.variants) { assert.equal(variant.runCount, 2); assert.equal(variant.weightedFps, 23.333); }
});

test('legacy snapshots, running captures, truncated samples and source-less builds cannot establish a baseline', () => {
  for (const [mutate, reason] of [
    [r => { r.schemaVersion = 1; }, 'raw_counter_schema_required'],
    [r => { r.active = true; }, 'recording_not_stopped'],
    [r => { r.samplingErrors = 1; }, 'sampling_errors_or_missing'],
    [r => { r.totalSamples++; }, 'samples_missing_or_truncated'],
    [r => { r.build.sourceFingerprint = null; }, 'build_configuration_missing_or_invalid'],
    [r => { r.settings.appliedAtLaunch = false; }, 'launch_settings_missing'],
    [r => { r.durationMs = 100; }, 'duration_inconsistent_with_samples'],
  ]) {
    const bad = report(); mutate(bad);
    const result = compareReports(manifest(), [bad, report(512 * MiB)]);
    assert.equal(result.status, 'invalid'); assert(result.runs[0].reasons.includes(reason), reason);
    assert.equal(result.runs[0].metrics, null); assert.deepEqual(result.variants, []); assert.deepEqual(result.pairs, []);
  }
});

test('background intervals, pauses, stale reads, frozen counters and counter resets are rejected', () => {
  for (const [mutate, reason] of [
    [r => { r.samples[1].visible = false; }, 'background_sample'],
    [r => { r.samples[1].core.emulating = false; }, 'insufficient_valid_duration'],
    [r => { r.samples[1].core.sampleAgeMs = 2501; }, 'insufficient_valid_duration'],
    [r => { r.samples[1].core.sequence = 2; r.samples[2].core.sequence = 2; }, 'insufficient_valid_duration'],
    [r => { r.samples[2].core.flips = 1; }, 'core_counter_reset'],
    [r => { r.samples[1].core.sequence = 3; }, 'insufficient_valid_duration'],
    [r => { r.samples[1].core.intervalValid = false; }, 'insufficient_valid_coverage'],
    [r => { r.visibilityChanges = 2; }, 'visibility_changes_or_missing'],
  ]) {
    const bad = report(); mutate(bad);
    const result = compareReports(manifest(), [bad, report(512 * MiB)]);
    assert.equal(result.status, 'invalid'); assert(result.runs[0].reasons.includes(reason), reason);
    assert.equal(result.runs[0].metrics, null);
  }
});

test('short unmeasured tail is excluded and does not corrupt duration-weighted rates', () => {
  const first = report(), second = report(512 * MiB);
  for (const item of [first, second]) {
    const last = item.samples.at(-1);
    item.samples.push({ ...last, elapsedMs: 3005 }, { ...last, elapsedMs: 3005 });
    item.durationMs = 3005; item.totalSamples += 2;
  }
  const result = compareReports(manifest(), [first, second]);
  assert.equal(result.status, 'comparable');
  assert.equal(result.runs[0].observed.invalidDurationMs, 5);
  assert.equal(result.runs[0].observed.zeroLengthIntervals, 1);
  assert.equal(result.runs[0].metrics.validDurationMs, 3000);
  assert.equal(result.runs[0].metrics.weightedFps, 26.667);
});

test('minimum valid duration and coverage both apply', () => {
  const config = manifest({ minValidDurationMs: 3001 });
  assert(compareReports(config, [report(), report(512 * MiB)]).runs[0].reasons.includes('insufficient_valid_duration'));
  const bad = report();
  bad.samples.push({ ...bad.samples.at(-1), elapsedMs: 4000 }); bad.totalSamples++; bad.durationMs = 4000;
  const result = compareReports(manifest(), [bad, report(512 * MiB)]);
  assert.equal(result.runs[0].observed.validDurationMs, 3000);
  assert(result.runs[0].reasons.includes('insufficient_valid_coverage'));
});

test('changes outside the intended dimension are incomparable even when individual runs are valid', () => {
  for (const [mutate, reason] of [
    [r => { r.build.sourceFingerprint = 'd'.repeat(64); }, 'build_or_source_changed_outside_dimension'],
    [r => { r.settings.resolution = 2; }, 'launch_settings_changed'],
    [r => { r.environment.hardwareConcurrency = 4; }, 'environment_changed'],
    [r => { r.webVersion = 'ppsspp-player-v7'; }, 'web_metric_version_changed'],
    [r => { r.samples.forEach(s => { s.resources.cpuBackend = 4; }); }, 'native_configuration_changed_outside_dimension'],
  ]) {
    const second = report(512 * MiB); mutate(second);
    const result = compareReports(manifest(), [report(), second]);
    assert.equal(result.status, 'incomparable'); assert(result.runs.every(run => run.valid)); assert(result.reasons.includes(reason));
    assert.deepEqual(result.variants, []); assert.deepEqual(result.pairs, []);
  }
});

test('declared build configuration must match native configuration and manifest value', () => {
  const cases = [
    r => { r.build.initialMemoryBytes = 384 * MiB; },
    r => { r.samples[0].resources.configuredComputeThreads = 3; },
    r => { delete r.samples[1].resources; },
    r => { r.samples[2].resources.completedHeapResizeRequests = 1; },
  ];
  for (const mutate of cases) {
    const bad = report(); mutate(bad);
    assert.equal(compareReports(manifest(), [bad, report(512 * MiB)]).status, 'invalid');
  }
});

test('compute workers and preallocated pthread pool are separate dimensions', () => {
  for (const dimension of ['computeThreads', 'pthreadPoolSize']) {
    const config = manifest({ dimension }); config.runs[0].value = dimension === 'computeThreads' ? 2 : 0; config.runs[1].value = dimension === 'computeThreads' ? 4 : 12;
    const before = report(), after = report(); after.coreRevision = 'b'.repeat(64); after.build[dimension] = config.runs[1].value;
    if (dimension === 'computeThreads') for (const item of [before, after]) {
      item.build.pthreadPoolSize = 16; item.samples.forEach(sample => { sample.resources.configuredPthreadPoolSize = 16; });
    }
    for (const sample of after.samples) {
      if (dimension === 'computeThreads') {
        sample.resources.configuredComputeThreads = 4; sample.resources.actualComputeThreads = 4; sample.resources.actualThreadManagerThreads = 8;
      } else sample.resources.configuredPthreadPoolSize = 12;
    }
    assert.equal(compareReports(config, [before, after]).status, 'comparable');
  }
});

test('invalid report metadata cannot echo arbitrary strings, arrays or nested objects into comparison output', () => {
  const privateValue = 'private/path.iso';
  for (const badValue of [privateValue, [privateValue], { content: privateValue }]) {
    const bad = report();
    for (const key of Object.keys(bad.build)) bad.build[key] = badValue;
    for (const key of Object.keys(bad.environment)) bad.environment[key] = badValue;
    for (const key of Object.keys(bad.settings)) bad.settings[key] = badValue;
    for (const sample of bad.samples) for (const key of Object.keys(sample.resources)) sample.resources[key] = badValue;
    bad.coreRevision = badValue; bad.webVersion = badValue;
    const result = compareReports(manifest(), [bad, report(512 * MiB)]);
    assert.equal(result.status, 'invalid'); assert(!JSON.stringify(result).includes(privateValue));
    assert(Object.values(result.runs[0].build).every(value => value === null));
    assert(Object.values(result.runs[0].environment).every(value => value === null));
    assert(Object.values(result.runs[0].settings).every(value => value === null));
    assert(Object.values(result.runs[0].nativeConfiguration).every(value => value === null));
  }
  const bad = report(); bad.build.sourceFingerprint = ['c'.repeat(64)]; bad.coreRevision = ['a'.repeat(64)];
  const result = compareReports(manifest(), [bad, report(512 * MiB)]);
  assert.equal(result.status, 'invalid'); assert.equal(result.runs[0].build.sourceFingerprint, null); assert.equal(result.runs[0].coreRevision, null);
});

test('build metadata obeys the CMake memory, compute and safe preallocation limits', () => {
  const overrides = [
    { initialMemoryBytes: 0 }, { initialMemoryBytes: 65537 }, { initialMemoryBytes: 4295032832 },
    { maximumMemoryBytes: 4295032832 }, { maximumMemoryBytes: 134217728 },
    { computeThreads: 0 }, { computeThreads: 33 }, { computeThreads: 4, pthreadPoolSize: 0 },
    { pthreadPoolSize: 11 }, { pthreadPoolSize: 129 }, { computeThreads: 4, pthreadPoolSize: 13 },
  ];
  for (const override of overrides) {
    const bad = report(); Object.assign(bad.build, override);
    const result = compareReports(manifest(), [bad, report(512 * MiB)]);
    assert(result.runs[0].reasons.includes('build_configuration_missing_or_invalid'), JSON.stringify(override));
  }
});

test('scene counter alignment rejects a different interval and manual alignment remains explicit', () => {
  const second = report(512 * MiB);
  second.samples.forEach(sample => { sample.core.emulatedUs += 300000; });
  let result = compareReports(manifest(), [report(), second]);
  assert(result.runs[1].reasons.includes('scene_start_outside_tolerance'));
  result = compareReports(manifest({ scene: { id: 'video-segment', alignment: 'manual' } }), [report(), second]);
  assert.equal(result.status, 'comparable'); assert.equal(result.scene.startEmulatedUs, null);
  assert.match(result.notes.join(' '), /manual alignment is not deterministic/);
});

test('resize metrics distinguish interval request differences from cumulative maximum', () => {
  const first = report();
  Object.assign(first.samples[0].resources, { completedHeapResizeRequests: 2, heapResizeSuccesses: 2, heapResizeTotalMs: 8, heapResizeMaxMs: 6 });
  for (const sample of first.samples.slice(1)) Object.assign(sample.resources,
    { completedHeapResizeRequests: 3, heapResizeSuccesses: 3, heapResizeTotalMs: 10, heapResizeMaxMs: 6 });
  const result = compareReports(manifest(), [first, report(512 * MiB)]);
  assert.equal(result.status, 'comparable');
  assert.equal(result.runs[0].metrics.heapResizeDelta.completedHeapResizeRequests, 1);
  assert.equal(result.runs[0].metrics.heapResizeDelta.heapResizeTotalMs, 2);
  assert.equal(result.runs[0].metrics.heapResizeMaxMsSinceLaunch, 6);
});

test('malformed raw reports are invalid rather than throwing or generating metrics', () => {
  for (const input of [null, {}, { ...report(), samples: [null, {}] }, { ...report(), samples: [] }]) {
    const result = analyzeRun(input, manifest().runs[0], validateManifest(manifest()));
    assert.equal(result.valid, false); assert.equal(result.metrics, null);
  }
});

test('manifest enforces complete pairs and independent dimensions', () => {
  for (const edit of [
    m => { m.dimension = 'all'; }, m => { m.environment.kind = 'mobile'; },
    m => { m.runs.push({ ...m.runs[0] }); }, m => { m.runs[1].pair = 'b'; },
    m => { m.runs[1].value = m.runs[0].value; }, m => { m.scene.maxStartSkewUs = 1000001; },
    m => { m.minValidCoverage = 0.1; }, m => { delete m.scene.startEmulatedUs; },
  ]) {
    const input = manifest(); edit(input); assert.throws(() => validateManifest(input));
  }
  for (const args of [[], ['--manifest'], ['--manifest', 'a', '--manifest', 'b'], ['--unknown', 'a']]) assert.throws(() => parseOptions(args));
});

test('CLI reads relative report files and writes an anonymous comparison without local paths', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'browser-comparison-')); t.after(() => rm(folder, { recursive: true, force: true }));
  await Promise.all([writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest())),
    writeFile(join(folder, 'small.json'), JSON.stringify(report())), writeFile(join(folder, 'large.json'), JSON.stringify(report(512 * MiB)))]);
  const output = join(folder, 'comparison.json');
  const result = await run(parseOptions(['--manifest', join(folder, 'manifest.json'), '--out', output]));
  const serialized = await readFile(output, 'utf8');
  assert.equal(result.status, 'comparable'); assert(!serialized.includes(folder)); assert(!serialized.includes('small.json'));
});
