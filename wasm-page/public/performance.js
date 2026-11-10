/* Opt-in, bounded performance measurements with an explicit export allowlist. */
(function (root) {
  "use strict";
  const LIMITS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000];
  const IO_KEYS = ["readCount", "readBytes", "physicalReadCount", "physicalReadBytes", "cacheHits", "cacheBytes", "cacheLimit", "activeReads", "queuedReads", "failures"];
  const AUDIO_KEYS = ["underruns", "droppedFrames", "callbacks"];
  const WEB_VERSION = "ppsspp-player-v6";
  const RESOURCE_KEYS = ["initialMemoryBytes", "maximumMemoryBytes", "configuredComputeThreads", "configuredPthreadPoolSize",
    "actualComputeThreads", "actualThreadManagerThreads", "cpuBackend", "completedHeapResizeRequests",
    "heapResizeSuccesses", "heapResizeFailures", "heapResizeTotalMs", "heapResizeMaxMs", "currentWasmCapacityBytes"];
  const BUILD_KEYS = ["initialMemoryBytes", "maximumMemoryBytes", "pthreadPoolSize", "computeThreads"];
  const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const rounded = value => value === null ? null : Math.round(value * 1000) / 1000;
  function histogram() { return { count: 0, totalMs: 0, maxMs: 0, buckets: Array(LIMITS.length + 1).fill(0) }; }
  function add(hist, value) {
    if (finite(value) === null) return;
    hist.count++; hist.totalMs += value; hist.maxMs = Math.max(hist.maxMs, value);
    const index = LIMITS.findIndex(limit => value <= limit);
    hist.buckets[index < 0 ? LIMITS.length : index]++;
  }
  function distribution(hist) {
    const percentile = fraction => {
      let total = 0;
      for (let i = 0; i < hist.buckets.length; i++) {
        total += hist.buckets[i];
        if (hist.count && total >= Math.ceil(hist.count * fraction)) return LIMITS[i] ?? null;
      }
      return null;
    };
    return { count: hist.count, totalMs: rounded(hist.totalMs), maxMs: rounded(hist.maxMs),
      p50UpperBoundMs: percentile(0.5), p95UpperBoundMs: percentile(0.95),
      bucketUpperBoundsMs: [...LIMITS, null], buckets: [...hist.buckets] };
  }
  function numbers(source, keys) {
    return Object.fromEntries(keys.map(key => [key, finite(source?.[key])]));
  }

  // The core publishes atomic snapshots; never read live emulation-thread data.
  function readCoreSnapshot(module) {
    const get = module?._ppssppGetPerformanceMetric;
    if (typeof get !== "function") return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const version = get(0);
      if (version !== 1 && version !== 2) return null;
      const sequence = get(13);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence % 2) continue;
      const snapshot = { sequence, initialized: get(1) === 1, vblanks: get(6), flips: get(7),
        emulatedUs: get(8), frameWallMs: get(9), sampleAgeMs: get(10), targetVps: get(11), emulating: get(12) === 1 };
      if (version === 2) snapshot.resources = Object.fromEntries(RESOURCE_KEYS.map((key, index) => [key, finite(get(index + 14))]));
      if (sequence === get(13) && [snapshot.vblanks, snapshot.flips, snapshot.emulatedUs, snapshot.sampleAgeMs].every(v => finite(v) !== null)) return snapshot;
    }
    return null;
  }

  function createPerformance(options = {}) {
    const now = options.now || (() => root.performance.now());
    const interval = options.setInterval || ((fn, ms) => root.setInterval(fn, ms));
    const clear = options.clearInterval || (id => root.clearInterval(id));
    const requestFrame = options.requestFrame || (fn => root.requestAnimationFrame?.(fn));
    const cancelFrame = options.cancelFrame || (id => root.cancelAnimationFrame?.(id));
    const document = options.document || root.document;
    const visible = options.visible || (() => !document?.hidden);
    const maxSamples = Math.max(1, Math.min(300, options.maxSamples || 300));
    let source = options.source || (() => ({}));
    let active = false, session = 0, stoppingSession = 0, timer = null, frame = null, observer = null;
    let startedAt = null, stoppedAt = null, lastAt = null, previousCore = null, previousVisible = false;
    let samples = [], totalSamples = 0, samplingErrors = 0, rafCount = 0, lastRaf = null;
    let visibilityChanges = 0;
    let frameTimes = histogram(), longTasks = histogram(), io = {};
    let environment = {}, longTasksSupported = false;
    let coreRevision = null, settings = null, build = null;
    let capacityObservations = { firstBytes: null, peakBytes: null, increases: 0, increaseBytes: 0 };
    let stoppedMarks = null;
    let previousAudio = null, audioTotals = Object.fromEntries(AUDIO_KEYS.map(key => [key, 0]));
    const marks = {}, listeners = new Set();
    let publication = 0;
    function resetIO() {
      io = { request: histogram(), queue: histogram(), physical: histogram(), requestBytes: 0, physicalBytes: 0, failures: 0 };
    }
    resetIO();
    function summary() {
      const last = samples.at(-1);
      return { active, durationMs: startedAt === null ? 0 : rounded((stoppedAt ?? now()) - startedAt),
        totalSamples, samplesRetained: samples.length, core: last?.core ? { ...last.core } : null,
        pageHz: last?.pageHz ?? null, wasmMemoryBytes: last?.wasmMemoryBytes ?? null,
        resources: last?.resources ? { ...last.resources } : null };
    }
    function publish() {
      const generation = ++publication;
      const state = summary();
      for (const listener of listeners) {
        // Nested stop/start notifications supersede this captured summary.
        if (generation !== publication) break;
        try { listener(state); } catch (_) {}
      }
    }
    function sample() {
      if (!active) return;
      const at = now(), isVisible = !!visible();
      let data = {};
      try { data = source() || {}; } catch (_) { samplingErrors++; }
      coreRevision = typeof data.coreRevision === "string" && /^[a-f0-9]{64}$/.test(data.coreRevision) ? data.coreRevision : null;
      build = { ...numbers(data.build, BUILD_KEYS), sourceFingerprint: typeof data.build?.sourceFingerprint === "string"
        && /^[a-f0-9]{64}$/.test(data.build.sourceFingerprint) ? data.build.sourceFingerprint : null };
      settings = { resolution: [1, 2, 3].includes(data.settings?.resolution) ? data.settings.resolution : null,
        showFps: typeof data.settings?.showFps === "boolean" ? data.settings.showFps : null,
        touch: typeof data.settings?.touch === "boolean" ? data.settings.touch : null,
        appliedAtLaunch: data.settingsApplied === true };
      let rawCore = null;
      try { rawCore = options.coreSource ? options.coreSource() : readCoreSnapshot(root.Module); } catch (_) { samplingErrors++; }
      const elapsed = lastAt === null ? 0 : at - lastAt;
      let core = null;
      if (rawCore) {
        core = { available: true, initialized: !!rawCore.initialized, emulating: !!rawCore.emulating,
          sequence: finite(rawCore.sequence), vblanks: finite(rawCore.vblanks), flips: finite(rawCore.flips), emulatedUs: finite(rawCore.emulatedUs),
          intervalValid: false, actualFps: null, speedPercent: null, vps: null, targetVps: finite(rawCore.targetVps),
          frameWallMs: finite(rawCore.frameWallMs), sampleAgeMs: finite(rawCore.sampleAgeMs) };
        const valid = isVisible && previousVisible && elapsed > 0 && rawCore.initialized && rawCore.emulating
          && previousCore?.initialized && previousCore.emulating && rawCore.sampleAgeMs <= 2500
          && previousCore.sampleAgeMs <= 2500
          && rawCore.sequence > previousCore.sequence
          && rawCore.vblanks >= previousCore.vblanks && rawCore.flips >= previousCore.flips && rawCore.emulatedUs >= previousCore.emulatedUs;
        if (valid) {
          core.intervalValid = true;
          core.actualFps = rounded((rawCore.flips - previousCore.flips) * 1000 / elapsed);
          core.vps = rounded((rawCore.vblanks - previousCore.vblanks) * 1000 / elapsed);
          core.speedPercent = rounded((rawCore.emulatedUs - previousCore.emulatedUs) / (elapsed * 10));
        }
      }
      const audioCounters = numbers(data.audio, AUDIO_KEYS);
      const audioDelta = Object.fromEntries(AUDIO_KEYS.map(key => {
        const current = audioCounters[key], previous = previousAudio?.[key];
        const delta = current !== null && previous != null && current >= previous ? current - previous : null;
        if (delta !== null) audioTotals[key] += delta;
        return [key, delta];
      }));
      previousAudio = audioCounters;
      const resources = rawCore?.resources ? numbers(rawCore.resources, RESOURCE_KEYS) : null;
      const capacity = resources?.currentWasmCapacityBytes ?? finite(data.wasmMemoryBytes);
      if (capacity !== null) {
        if (capacityObservations.firstBytes === null) capacityObservations.firstBytes = capacity;
        if (capacityObservations.peakBytes !== null && capacity > capacityObservations.peakBytes) {
          capacityObservations.increases++;
          capacityObservations.increaseBytes += capacity - capacityObservations.peakBytes;
        }
        capacityObservations.peakBytes = Math.max(capacityObservations.peakBytes ?? 0, capacity);
      }
      const sample = { elapsedMs: rounded(at - startedAt), visible: isVisible, core,
        pageHz: elapsed > 0 && isVisible && previousVisible ? rounded(rafCount * 1000 / elapsed) : null,
        wasmMemoryBytes: capacity, resources,
        canvasWidth: finite(data.canvasWidth), canvasHeight: finite(data.canvasHeight),
        io: numbers(data.io, IO_KEYS), audioCounters, audioDelta };
      samples.push(sample);
      if (samples.length > maxSamples) samples.shift();
      totalSamples++;
      previousCore = rawCore; previousVisible = isVisible; lastAt = at; rafCount = 0;
      publish();
    }
    function onFrame(at, token) {
      if (!active || session !== token) return;
      if (visible()) {
        if (lastRaf !== null) add(frameTimes, at - lastRaf);
        lastRaf = at; rafCount++;
      } else lastRaf = null;
      frame = requestFrame(at => onFrame(at, token));
    }
    function collectLongTasks(entries) {
      if (active) for (const entry of entries) if (entry.startTime >= startedAt && visible()) add(longTasks, entry.duration);
    }
    function visibilityChanged() {
      visibilityChanges++;
      lastRaf = null; rafCount = 0; previousCore = null; previousVisible = false;
    }
    function start() {
      if (active) return 0;
      active = true; session++; startedAt = now(); stoppedAt = null; lastAt = null;
      const token = session;
      stoppedMarks = null;
      previousCore = null; previousVisible = false; samples = []; totalSamples = 0; samplingErrors = 0;
      visibilityChanges = 0;
      rafCount = 0; lastRaf = null; frameTimes = histogram(); longTasks = histogram(); resetIO();
      previousAudio = null; audioTotals = Object.fromEntries(AUDIO_KEYS.map(key => [key, 0]));
      capacityObservations = { firstBytes: null, peakBytes: null, increases: 0, increaseBytes: 0 };
      const nav = root.navigator;
      environment = { hardwareConcurrency: finite(nav?.hardwareConcurrency), deviceMemoryGB: finite(nav?.deviceMemory),
        crossOriginIsolated: !!root.crossOriginIsolated, sharedArrayBuffer: typeof root.SharedArrayBuffer === "function",
        viewportWidth: finite(root.innerWidth), viewportHeight: finite(root.innerHeight), devicePixelRatio: finite(root.devicePixelRatio) };
      longTasksSupported = false;
      document?.addEventListener?.("visibilitychange", visibilityChanged);
      const Observer = options.PerformanceObserver || root.PerformanceObserver;
      if (Observer?.supportedEntryTypes?.includes("longtask")) {
        try {
          observer = new Observer(list => collectLongTasks(list.getEntries()));
          observer.observe({ type: "longtask", buffered: false }); longTasksSupported = true;
        } catch (_) { observer?.disconnect(); observer = null; }
      }
      // Set up work before publishing: a subscriber may synchronously stop or
      // replace this recording from the first sample notification.
      timer = interval(() => { if (session === token) sample(); }, 1000);
      frame = requestFrame(at => onFrame(at, token));
      sample();
      return token;
    }
    function stop() {
      if (!active || stoppingSession === session) return;
      stoppingSession = session;
      try { collectLongTasks(observer?.takeRecords?.() || []); } catch (_) {}
      sample();
      active = false; stoppedAt = now();
      stoppedMarks = { ...marks };
      clear(timer); timer = null; cancelFrame(frame); frame = null;
      document?.removeEventListener?.("visibilitychange", visibilityChanged);
      observer?.disconnect(); observer = null; lastRaf = null;
      stoppingSession = 0;
      publish();
    }
    return {
      start, stop, summary,
      setSource(fn) { if (typeof fn === "function") source = fn; },
      subscribe(fn) { listeners.add(fn); fn(summary()); return () => listeners.delete(fn); },
      token() { return active ? session : 0; },
      // Unlike token(), this still identifies the retained report after stop.
      sessionToken() { return session; },
      recordIO(kind, token, durationMs, bytes = 0, failed = false) {
        if (!active || token !== session || !["request", "queue", "physical"].includes(kind)) return;
        add(io[kind], durationMs);
        if (kind !== "queue" && finite(bytes) !== null) io[kind + "Bytes"] += bytes;
        if (kind === "request" && failed) io.failures++;
      },
      mark(name) {
        if (!["launchClick", "runtimeReady", "gameBooted"].includes(name)) return;
        if (name === "launchClick") { delete marks.runtimeReady; delete marks.gameBooted; marks.launchClick = now(); }
        else if (marks.launchClick !== undefined && marks[name] === undefined) marks[name] = now();
      },
      snapshot() {
        const startupMarks = stoppedMarks || marks;
        const launch = startupMarks.launchClick;
        return { schemaVersion: 2, webVersion: WEB_VERSION, coreRevision, build: build ? { ...build } : null, settings: settings ? { ...settings } : null,
          ...summary(), environment: { ...environment }, samplingErrors, visibilityChanges,
          sampleIntervalMs: 1000, maxSamples, longTasksSupported,
          notes: {
            core: "Rates use counter differences over wall time; unavailable, paused, hidden or stale intervals are null. frameWallMs includes waiting and is not CPU time.",
            pageHz: "Browser animation callback rate, not game FPS.",
            memory: "WASM linear-memory capacity, not used heap or process resident memory. Canvas dimensions are output pixels, not internal render resolution.",
            resources: "Heap resize counters cover completed allocator requests on all native threads, including internal retries; not individual memory.grow instructions. Durations are summed request wall times, not application pauses. ThreadManager threads exclude other emulator and browser workers.",
            capacityObservations: "Capacity changes observed during this recording; multiple growth operations between samples count as one observation. No growth duration is inferred from polling.",
            build: "Build configuration and optional source fingerprint supplied with the packaged core. Native resource fields independently expose compiled settings; the fingerprint is build provenance, not a signature.",
            startup: "Runtime initialization and game boot are separate milestones; neither establishes the first visible frame.",
            settings: "Whitelisted player preferences captured at launch, or pending preferences before launch; changes inside the emulator are not observed.",
            audio: "audioCounters are cumulative runtime counters. audioDelta and audioTotals include only observed nonnegative changes during this recording; counter resets produce null deltas.",
            io: "Sample IO counters are cumulative. ISO latency aggregates cover operations started and completed during this recording. Null histogram bounds denote values over 1000 ms.",
          },
          startup: { runtimeReadyMs: launch === undefined || startupMarks.runtimeReady === undefined ? null : rounded(startupMarks.runtimeReady - launch),
            gameBootedMs: launch === undefined || startupMarks.gameBooted === undefined ? null : rounded(startupMarks.gameBooted - launch),
            firstFrameMs: null },
          pageFrameIntervals: distribution(frameTimes), longTasks: distribution(longTasks),
          iso: { requestLatency: distribution(io.request), queueLatency: distribution(io.queue), physicalLatency: distribution(io.physical),
            requestBytes: io.requestBytes, physicalBytes: io.physicalBytes, failures: io.failures },
          audioTotals: { ...audioTotals },
          capacityObservations: { ...capacityObservations },
          samples: samples.map(sample => ({ ...sample, core: sample.core ? { ...sample.core } : null, io: { ...sample.io },
            resources: sample.resources ? { ...sample.resources } : null,
            audioCounters: { ...sample.audioCounters }, audioDelta: { ...sample.audioDelta } })) };
      },
    };
  }
  root.createPpssppPerformance = createPerformance;
  root.readPpssppCorePerformance = readCoreSnapshot;
  root.PpssppPerformance = createPerformance();
})(globalThis);
