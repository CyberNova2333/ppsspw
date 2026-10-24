#!/usr/bin/env node
// Compare local performance exports. This script never opens a browser or reads game files.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIMENSIONS = ['initialMemoryBytes', 'pthreadPoolSize', 'computeThreads'];
const BUILD_KEYS = [...DIMENSIONS, 'maximumMemoryBytes', 'sourceFingerprint'];
const ENV_KEYS = ['hardwareConcurrency', 'deviceMemoryGB', 'crossOriginIsolated', 'sharedArrayBuffer',
  'viewportWidth', 'viewportHeight', 'devicePixelRatio'];
const SETTINGS_KEYS = ['resolution', 'showFps', 'touch', 'appliedAtLaunch'];
const RESOURCE_CONFIG_KEYS = ['initialMemoryBytes', 'maximumMemoryBytes', 'configuredComputeThreads', 'configuredPthreadPoolSize',
  'actualComputeThreads', 'actualThreadManagerThreads', 'cpuBackend'];
const RESIZE_KEYS = ['completedHeapResizeRequests', 'heapResizeSuccesses', 'heapResizeFailures', 'heapResizeTotalMs'];
const SHA256 = /^[a-f0-9]{64}$/;
const WEB_VERSION = /^ppsspp-player-v\d{1,8}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const rounded = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object?.[key] ?? null]));
const numbers = (object, keys) => Object.fromEntries(keys.map(key => [key, finite(object?.[key]) ? object[key] : null]));
const boolean = value => typeof value === 'boolean' ? value : null;
const digest = value => typeof value === 'string' && SHA256.test(value) ? value : null;
const webVersion = value => typeof value === 'string' && WEB_VERSION.test(value) ? value : null;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function validateManifest(input) {
  if (input?.schemaVersion !== 1 || !DIMENSIONS.includes(input.dimension)) throw new Error('Manifest requires schemaVersion 1 and a supported dimension.');
  if (!ID.test(input.environment?.id ?? '') || !['desktop', 'android-emulator', 'android-device'].includes(input.environment?.kind)) {
    throw new Error('Manifest requires an environment id and kind (desktop, android-emulator or android-device).');
  }
  const scene = input.scene;
  if (!ID.test(scene?.id ?? '') || !['manual', 'emulated-time'].includes(scene?.alignment)) throw new Error('Manifest requires a scene id and explicit alignment.');
  if (scene.alignment === 'emulated-time' && !count(scene.startEmulatedUs)) throw new Error('Emulated-time alignment requires startEmulatedUs.');
  const maxStartSkewUs = scene.maxStartSkewUs ?? 250000;
  if (!count(maxStartSkewUs) || maxStartSkewUs > 1000000) throw new Error('Scene start tolerance must be between 0 and 1000000 microseconds.');
  const minValidDurationMs = input.minValidDurationMs ?? 60000;
  const minValidCoverage = input.minValidCoverage ?? 0.95;
  if (!finite(minValidDurationMs) || minValidDurationMs < 1000 || minValidDurationMs > 300000) throw new Error('Minimum valid duration must be between 1000 and 300000 ms.');
  if (!finite(minValidCoverage) || minValidCoverage < 0.9 || minValidCoverage > 1) throw new Error('Minimum valid coverage must be between 0.9 and 1.');
  if (!Array.isArray(input.runs) || input.runs.length < 2 || input.runs.length > 100) throw new Error('Manifest requires 2 to 100 runs.');
  const ids = new Set();
  const runs = input.runs.map(run => {
    if (!ID.test(run.id ?? '') || ids.has(run.id) || !ID.test(run.pair ?? '')) throw new Error('Run ids must be unique and every run needs a pair id.');
    ids.add(run.id);
    if (typeof run.report !== 'string' || !run.report || run.report.length > 4096 || run.report.includes('\0')) throw new Error('Every run needs a local JSON report path.');
    if (!count(run.value) || (input.dimension === 'initialMemoryBytes' && (run.value < 65536 || run.value > 4294967296 || run.value % 65536))
      || (input.dimension === 'computeThreads' && (run.value < 1 || run.value > 32))
      || (input.dimension === 'pthreadPoolSize' && run.value > 128)) throw new Error('Run values must be valid configuration integers.');
    return { id: run.id, pair: run.pair, report: run.report, value: run.value };
  });
  const values = [...new Set(runs.map(run => run.value))];
  if (values.length < 2 || values.length > 16) throw new Error('Comparison requires 2 to 16 distinct values of one dimension.');
  const pairs = [...new Set(runs.map(run => run.pair))];
  for (const pair of pairs) {
    const members = runs.filter(run => run.pair === pair);
    if (members.length !== values.length || values.some(value => members.filter(run => run.value === value).length !== 1)) {
      throw new Error(`Pair ${pair} must contain each configuration value exactly once.`);
    }
  }
  return { schemaVersion: 1, dimension: input.dimension, minValidDurationMs, minValidCoverage,
    environment: { id: input.environment.id, kind: input.environment.kind },
    scene: { id: scene.id, alignment: scene.alignment, startEmulatedUs: scene.alignment === 'emulated-time' ? scene.startEmulatedUs : null, maxStartSkewUs },
    runs, values, pairs };
}

function buildValid(build) {
  return digest(build?.sourceFingerprint) !== null && count(build.initialMemoryBytes) && build.initialMemoryBytes >= 65536
    && build.initialMemoryBytes % 65536 === 0 && count(build.maximumMemoryBytes) && build.maximumMemoryBytes >= build.initialMemoryBytes
    && build.maximumMemoryBytes <= 4294967296 && build.maximumMemoryBytes % 65536 === 0
    && count(build.computeThreads) && build.computeThreads >= 1 && build.computeThreads <= 32
    && count(build.pthreadPoolSize) && (build.pthreadPoolSize === 0 ? build.computeThreads === 2
      : build.pthreadPoolSize >= build.computeThreads + Math.max(4, build.computeThreads) + 6 && build.pthreadPoolSize <= 128);
}
function coreValid(core) {
  return core?.initialized === true && core.emulating === true && count(core.sequence) && core.sequence % 2 === 0
    && ['vblanks', 'flips', 'emulatedUs'].every(key => count(core[key])) && finite(core.sampleAgeMs) && core.sampleAgeMs <= 2500;
}
function resourcesValid(resources, build) {
  return resources?.initialMemoryBytes === build.initialMemoryBytes && resources.maximumMemoryBytes === build.maximumMemoryBytes
    && resources.configuredComputeThreads === build.computeThreads && resources.configuredPthreadPoolSize === build.pthreadPoolSize
    && count(resources.actualComputeThreads) && resources.actualComputeThreads > 0
    && resources.actualComputeThreads === build.computeThreads
    && count(resources.actualThreadManagerThreads) && resources.actualThreadManagerThreads >= resources.actualComputeThreads
    && [0, 2, 4].includes(resources.cpuBackend)
    && RESIZE_KEYS.every(key => finite(resources[key]))
    && ['completedHeapResizeRequests', 'heapResizeSuccesses', 'heapResizeFailures'].every(key => count(resources[key]))
    && resources.completedHeapResizeRequests === resources.heapResizeSuccesses + resources.heapResizeFailures
    && finite(resources.heapResizeMaxMs) && resources.heapResizeMaxMs <= resources.heapResizeTotalMs
    && count(resources.currentWasmCapacityBytes) && resources.currentWasmCapacityBytes >= build.initialMemoryBytes
    && resources.currentWasmCapacityBytes <= build.maximumMemoryBytes;
}
function aggregateMetrics(totals) {
  return { validDurationMs: rounded(totals.validDurationMs), validIntervals: totals.validIntervals,
    flips: totals.flips, vblanks: totals.vblanks, emulatedUs: totals.emulatedUs,
    weightedFps: totals.validDurationMs > 0 ? rounded(totals.flips * 1000 / totals.validDurationMs) : null,
    weightedSpeedPercent: totals.validDurationMs > 0 ? rounded(totals.emulatedUs / (totals.validDurationMs * 10)) : null,
    weightedVps: totals.validDurationMs > 0 ? rounded(totals.vblanks * 1000 / totals.validDurationMs) : null };
}

export function analyzeRun(report, run, manifest) {
  const reasons = new Set();
  const add = reason => reasons.add(reason);
  const build = pick(report?.build, BUILD_KEYS), environment = pick(report?.environment, ENV_KEYS), settings = pick(report?.settings, SETTINGS_KEYS);
  if (report?.schemaVersion !== 2) add('raw_counter_schema_required');
  if (webVersion(report?.webVersion) === null) add('web_metric_version_missing');
  if (report?.active !== false) add('recording_not_stopped');
  if (report?.samplingErrors !== 0) add('sampling_errors_or_missing');
  if (report?.visibilityChanges !== 0) add('visibility_changes_or_missing');
  if (digest(report?.coreRevision) === null) add('artifact_revision_missing');
  if (!buildValid(build)) add('build_configuration_missing_or_invalid');
  if (build[manifest.dimension] !== run.value) add('declared_variant_does_not_match_build');
  if (settings.appliedAtLaunch !== true || ![1, 2, 3].includes(settings.resolution)
    || typeof settings.showFps !== 'boolean' || typeof settings.touch !== 'boolean') add('launch_settings_missing');
  if (environment.crossOriginIsolated !== true || environment.sharedArrayBuffer !== true
    || !count(environment.hardwareConcurrency) || environment.hardwareConcurrency < 1
    || ['viewportWidth', 'viewportHeight', 'devicePixelRatio'].some(key => !finite(environment[key]) || environment[key] <= 0)) add('environment_missing_or_invalid');
  const samples = Array.isArray(report?.samples) ? report.samples : [];
  if (samples.length < 2 || samples.length > 300 || report?.totalSamples !== samples.length) add('samples_missing_or_truncated');
  if (!finite(report?.durationMs)) add('duration_missing');
  const totals = { validDurationMs: 0, validIntervals: 0, flips: 0, vblanks: 0, emulatedUs: 0 };
  let measuredDurationMs = 0, invalidDurationMs = 0, invalidIntervals = 0, zeroLengthIntervals = 0;
  let audioUnderruns = 0, audioComplete = true, memoryMin = Infinity, memoryMax = 0;
  const firstResources = samples[0]?.resources, lastResources = samples.at(-1)?.resources;
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i], previous = samples[i - 1];
    if (!finite(current?.elapsedMs)) { add('invalid_sample_time'); continue; }
    if (current.visible !== true) add('background_sample');
    if (!resourcesValid(current.resources, build)) add('native_resources_missing_or_inconsistent');
    if (!equal(pick(current.resources, RESOURCE_CONFIG_KEYS), pick(firstResources, RESOURCE_CONFIG_KEYS))) add('native_resource_configuration_changed');
    if (count(current.wasmMemoryBytes) && current.wasmMemoryBytes === current.resources?.currentWasmCapacityBytes) {
      memoryMin = Math.min(memoryMin, current.wasmMemoryBytes); memoryMax = Math.max(memoryMax, current.wasmMemoryBytes);
    } else add('memory_capacity_missing_or_inconsistent');
    if (!previous || !finite(previous.elapsedMs)) continue;
    const duration = current.elapsedMs - previous.elapsedMs;
    if (duration < 0) { add('sample_time_went_backwards'); continue; }
    if (duration === 0) { zeroLengthIntervals++; continue; }
    measuredDurationMs += duration;
    if (RESIZE_KEYS.some(key => finite(previous.resources?.[key]) && finite(current.resources?.[key])
      && current.resources[key] < previous.resources[key])) add('heap_resize_counter_reset');
    const before = previous.core, after = current.core;
    const countersReset = before && after && ['vblanks', 'flips', 'emulatedUs', 'sequence'].some(key => count(before[key]) && count(after[key]) && after[key] < before[key]);
    if (countersReset) add('core_counter_reset');
    const valid = previous.visible === true && current.visible === true && after?.intervalValid === true && coreValid(before) && coreValid(after)
      && after.sequence > before.sequence && !countersReset;
    if (!valid) { invalidIntervals++; invalidDurationMs += duration; continue; }
    totals.validIntervals++; totals.validDurationMs += duration;
    for (const key of ['flips', 'vblanks', 'emulatedUs']) totals[key] += after[key] - before[key];
    const beforeAudio = previous.audioCounters?.underruns, afterAudio = current.audioCounters?.underruns;
    if (count(beforeAudio) && count(afterAudio) && afterAudio >= beforeAudio) audioUnderruns += afterAudio - beforeAudio;
    else audioComplete = false;
  }
  const coverage = measuredDurationMs > 0 ? totals.validDurationMs / measuredDurationMs : 0;
  if (totals.validDurationMs + 0.01 < manifest.minValidDurationMs) add('insufficient_valid_duration');
  if (coverage + 1e-9 < manifest.minValidCoverage) add('insufficient_valid_coverage');
  if (samples.length && finite(report?.durationMs) && (samples.at(-1)?.elapsedMs > report.durationMs + 1 || samples[0]?.elapsedMs > 1000)) add('duration_inconsistent_with_samples');
  const startEmulatedUs = samples[0]?.core?.emulatedUs;
  if (manifest.scene.alignment === 'emulated-time' && (!count(startEmulatedUs)
    || Math.abs(startEmulatedUs - manifest.scene.startEmulatedUs) > manifest.scene.maxStartSkewUs)) add('scene_start_outside_tolerance');
  return { id: run.id, pair: run.pair, value: run.value, valid: reasons.size === 0, reasons: [...reasons],
    coreRevision: digest(report?.coreRevision), webVersion: webVersion(report?.webVersion),
    build: { ...numbers(build, BUILD_KEYS.filter(key => key !== 'sourceFingerprint')), sourceFingerprint: digest(build.sourceFingerprint) },
    environment: { ...numbers(environment, ENV_KEYS.filter(key => !['crossOriginIsolated', 'sharedArrayBuffer'].includes(key))),
      crossOriginIsolated: boolean(environment.crossOriginIsolated), sharedArrayBuffer: boolean(environment.sharedArrayBuffer) },
    settings: { resolution: finite(settings.resolution) ? settings.resolution : null, showFps: boolean(settings.showFps),
      touch: boolean(settings.touch), appliedAtLaunch: boolean(settings.appliedAtLaunch) },
    nativeConfiguration: numbers(firstResources, RESOURCE_CONFIG_KEYS),
    observed: { startEmulatedUs: count(startEmulatedUs) ? startEmulatedUs : null, measuredDurationMs: rounded(measuredDurationMs),
      validDurationMs: rounded(totals.validDurationMs), invalidDurationMs: rounded(invalidDurationMs), coverage: rounded(coverage),
      invalidIntervals, zeroLengthIntervals },
    metrics: reasons.size ? null : { ...aggregateMetrics(totals), audioUnderruns: audioComplete ? audioUnderruns : null,
      wasmCapacityMinBytes: memoryMin === Infinity ? null : memoryMin, wasmCapacityMaxBytes: memoryMin === Infinity ? null : memoryMax,
      heapResizeDelta: Object.fromEntries(RESIZE_KEYS.map(key => [key, rounded(lastResources[key] - firstResources[key])])),
      heapResizeMaxMsSinceLaunch: lastResources.heapResizeMaxMs,
      runtimeReadyMs: finite(report?.startup?.runtimeReadyMs) ? report.startup.runtimeReadyMs : null,
      gameBootedMs: finite(report?.startup?.gameBootedMs) ? report.startup.gameBootedMs : null } };
}

export function compareReports(inputManifest, reports) {
  const manifest = validateManifest(inputManifest);
  if (reports.length !== manifest.runs.length) throw new Error('There must be one report for every manifest run.');
  const runs = reports.map((report, index) => analyzeRun(report, manifest.runs[index], manifest));
  const reasons = new Set(), base = runs[0];
  const invariantBuildKeys = BUILD_KEYS.filter(key => key !== manifest.dimension);
  const nativeChangedKeys = { initialMemoryBytes: ['initialMemoryBytes'], pthreadPoolSize: ['configuredPthreadPoolSize'],
    computeThreads: ['configuredComputeThreads', 'actualComputeThreads', 'actualThreadManagerThreads'] }[manifest.dimension];
  const nativeInvariantKeys = RESOURCE_CONFIG_KEYS.filter(key => !nativeChangedKeys.includes(key));
  for (const run of runs) {
    if (!equal(pick(run.build, invariantBuildKeys), pick(base.build, invariantBuildKeys))) reasons.add('build_or_source_changed_outside_dimension');
    if (!equal(run.environment, base.environment)) reasons.add('environment_changed');
    if (!equal(run.settings, base.settings)) reasons.add('launch_settings_changed');
    if (run.webVersion !== base.webVersion) reasons.add('web_metric_version_changed');
    if (!equal(pick(run.nativeConfiguration, nativeInvariantKeys), pick(base.nativeConfiguration, nativeInvariantKeys))) reasons.add('native_configuration_changed_outside_dimension');
  }
  for (const value of manifest.values) {
    if (new Set(runs.filter(run => run.value === value).map(run => run.coreRevision)).size > 1) reasons.add('artifact_changed_within_variant');
  }
  const status = runs.some(run => !run.valid) ? 'invalid' : reasons.size ? 'incomparable' : 'comparable';
  const variants = status !== 'comparable' ? [] : manifest.values.map(value => {
    const members = runs.filter(run => run.value === value);
    const totals = Object.fromEntries(['validDurationMs', 'validIntervals', 'flips', 'vblanks', 'emulatedUs'].map(key => [key, members.reduce((sum, run) => sum + run.metrics[key], 0)]));
    return { value, runCount: members.length, ...aggregateMetrics(totals),
      audioUnderruns: members.every(run => run.metrics.audioUnderruns !== null) ? members.reduce((sum, run) => sum + run.metrics.audioUnderruns, 0) : null,
      wasmCapacityMaxBytes: Math.max(...members.map(run => run.metrics.wasmCapacityMaxBytes ?? 0)) || null };
  });
  const pairs = status !== 'comparable' ? [] : manifest.pairs.map(pair => {
    const members = runs.filter(run => run.pair === pair), baseline = members.find(run => run.value === manifest.values[0]);
    return { id: pair, baselineValue: baseline.value, comparisons: manifest.values.slice(1).map(value => {
      const other = members.find(run => run.value === value);
      return { value, fpsDifference: rounded(other.metrics.weightedFps - baseline.metrics.weightedFps),
        speedPercentagePointDifference: rounded(other.metrics.weightedSpeedPercent - baseline.metrics.weightedSpeedPercent),
        wasmCapacityMaxDifferenceBytes: baseline.metrics.wasmCapacityMaxBytes === null || other.metrics.wasmCapacityMaxBytes === null
          ? null : other.metrics.wasmCapacityMaxBytes - baseline.metrics.wasmCapacityMaxBytes };
    }) };
  });
  return { schemaVersion: 1, status, reasons: [...reasons], dimension: manifest.dimension,
    environment: manifest.environment, scene: manifest.scene,
    thresholds: { minValidDurationMs: manifest.minValidDurationMs, minValidCoverage: manifest.minValidCoverage },
    notes: [
      'Rates are recomputed from raw core counter differences and weighted by valid interval duration. Page animation rate is not game FPS.',
      'Scene and device identity are operator declarations. Emulated-time alignment checks counters, not game state or image contents; manual alignment is not deterministic.',
      'Only exported launch preferences and numeric device capabilities are compared. Live native menu settings, browser version, power mode and cache preparation require controlled capture.',
      'Build checks cover the source fingerprint and exported resource configuration. Toolchain and other compiler options must be held constant by the build procedure.',
      'WASM capacity is not live allocation, resident memory, CPU usage or power consumption. Startup milestones do not identify the first visible frame.',
      'Heap resize deltas count completed allocator requests, including internal retries. The maximum is cumulative since launch, not a maximum confined to the recording.',
      'A comparable result does not establish a statistically significant improvement or justify changing defaults. Repeat paired runs and report the device category.',
    ], runs, variants, pairs };
}

export function parseOptions(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--manifest', '--out'].includes(key) || Object.hasOwn(values, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/compare-browser-performance.mjs --manifest <local.json> [--out <local-result.json>]');
    values[key] = args[++i];
  }
  if (!values['--manifest']) throw new Error('--manifest is required.');
  return { manifest: resolve(values['--manifest']), output: values['--out'] ? resolve(values['--out']) : null };
}

export async function run(options) {
  async function readJson(path, label) {
    const info = await stat(path);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error(`${label} must be a JSON file no larger than 4 MiB.`);
    const text = await readFile(path, 'utf8');
    try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error(`${label} is not valid JSON.`); }
  }
  const raw = await readJson(options.manifest, 'Manifest');
  const manifest = validateManifest(raw);
  const reports = await Promise.all(manifest.runs.map(entry => readJson(resolve(dirname(options.manifest), entry.report), `Report ${entry.id}`)));
  const comparison = compareReports(raw, reports);
  const text = JSON.stringify(comparison, null, 2) + '\n';
  if (options.output) await writeFile(options.output, text);
  else process.stdout.write(text);
  return comparison;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => run(parseOptions(process.argv.slice(2)))).then(result => { if (result.status !== 'comparable') process.exitCode = 2; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
