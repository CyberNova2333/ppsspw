/* Opt-in, bounded performance measurements with an explicit export allowlist. */
(function (root) {
  "use strict";
  const LIMITS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000];
  const IO_KEYS = ["readCount", "readBytes", "physicalReadCount", "physicalReadBytes", "cacheHits", "cacheBytes", "cacheLimit", "activeReads", "queuedReads", "failures"];
  const AUDIO_KEYS = ["underruns", "droppedFrames", "callbacks"];
  const WEB_VERSION = "ppsspp-player-v5";
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
      if (get(0) !== 1) return null;
      const sequence = get(13);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence % 2) continue;
      const snapshot = { sequence, initialized: get(1) === 1, vblanks: get(6), flips: get(7),
        emulatedUs: get(8), frameWallMs: get(9), sampleAgeMs: get(10), targetVps: get(11), emulating: get(12) === 1 };
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
    let active = false, session = 0, timer = null, frame = null, observer = null;
    let startedAt = null, stoppedAt = null, lastAt = null, previousCore = null, previousVisible = false;
    let samples = [], totalSamples = 0, samplingErrors = 0, rafCount = 0, lastRaf = null;
    let frameTimes = histogram(), longTasks = histogram(), io = {};
    let environment = {}, longTasksSupported = false;
    let coreRevision = null, settings = null;
    let stoppedMarks = null;
    let previousAudio = null, audioTotals = Object.fromEntries(AUDIO_KEYS.map(key => [key, 0]));
    const marks = {}, listeners = new Set();
    function resetIO() {
      io = { request: histogram(), queue: histogram(), physical: histogram(), requestBytes: 0, physicalBytes: 0, failures: 0 };
    }
    resetIO();
    function summary() {
      const last = samples.at(-1);
      return { active, durationMs: startedAt === null ? 0 : rounded((stoppedAt ?? now()) - startedAt),
        totalSamples, samplesRetained: samples.length, core: last?.core ? { ...last.core } : null,
        pageHz: last?.pageHz ?? null, wasmMemoryBytes: last?.wasmMemoryBytes ?? null };
    }
    function publish() {
      const state = summary();
      for (const listener of listeners) { try { listener(state); } catch (_) {} }
    }
    function sample() {
      if (!active) return;
      const at = now(), isVisible = !!visible();
      let data = {};
      try { data = source() || {}; } catch (_) { samplingErrors++; }
      coreRevision = typeof data.coreRevision === "string" && /^[a-f0-9]{64}$/.test(data.coreRevision) ? data.coreRevision : null;
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
          actualFps: null, speedPercent: null, vps: null, targetVps: finite(rawCore.targetVps),
          frameWallMs: finite(rawCore.frameWallMs), sampleAgeMs: finite(rawCore.sampleAgeMs) };
        const valid = isVisible && previousVisible && elapsed > 0 && rawCore.initialized && rawCore.emulating
          && previousCore?.initialized && previousCore.emulating && rawCore.sampleAgeMs <= 2500
          && previousCore.sampleAgeMs <= 2500
          && rawCore.sequence > previousCore.sequence
          && rawCore.vblanks >= previousCore.vblanks && rawCore.flips >= previousCore.flips && rawCore.emulatedUs >= previousCore.emulatedUs;
        if (valid) {
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
      const sample = { elapsedMs: rounded(at - startedAt), visible: isVisible, core,
        pageHz: elapsed > 0 && isVisible && previousVisible ? rounded(rafCount * 1000 / elapsed) : null,
        wasmMemoryBytes: finite(data.wasmMemoryBytes),
        canvasWidth: finite(data.canvasWidth), canvasHeight: finite(data.canvasHeight),
        io: numbers(data.io, IO_KEYS), audioCounters, audioDelta };
      samples.push(sample);
      if (samples.length > maxSamples) samples.shift();
      totalSamples++;
      previousCore = rawCore; previousVisible = isVisible; lastAt = at; rafCount = 0;
      publish();
    }
    function onFrame(at) {
      if (!active) return;
      if (visible()) {
        if (lastRaf !== null) add(frameTimes, at - lastRaf);
        lastRaf = at; rafCount++;
      } else lastRaf = null;
      frame = requestFrame(onFrame);
    }
    function collectLongTasks(entries) {
      if (active) for (const entry of entries) if (entry.startTime >= startedAt && visible()) add(longTasks, entry.duration);
    }
    function visibilityChanged() {
      lastRaf = null; rafCount = 0; previousCore = null; previousVisible = false;
    }
    function start() {
      if (active) return;
      active = true; session++; startedAt = now(); stoppedAt = null; lastAt = null;
      stoppedMarks = null;
      previousCore = null; previousVisible = false; samples = []; totalSamples = 0; samplingErrors = 0;
      rafCount = 0; lastRaf = null; frameTimes = histogram(); longTasks = histogram(); resetIO();
      previousAudio = null; audioTotals = Object.fromEntries(AUDIO_KEYS.map(key => [key, 0]));
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
      sample(); timer = interval(sample, 1000); frame = requestFrame(onFrame);
    }
    function stop() {
      if (!active) return;
      try { collectLongTasks(observer?.takeRecords?.() || []); } catch (_) {}
      sample();
      active = false; stoppedAt = now();
      stoppedMarks = { ...marks };
      clear(timer); timer = null; cancelFrame(frame); frame = null;
      document?.removeEventListener?.("visibilitychange", visibilityChanged);
      observer?.disconnect(); observer = null; lastRaf = null; publish();
    }
    return {
      start, stop, summary,
      setSource(fn) { if (typeof fn === "function") source = fn; },
      subscribe(fn) { listeners.add(fn); fn(summary()); return () => listeners.delete(fn); },
      token() { return active ? session : 0; },
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
        return { schemaVersion: 1, webVersion: WEB_VERSION, coreRevision, settings: settings ? { ...settings } : null,
          ...summary(), environment: { ...environment }, samplingErrors,
          sampleIntervalMs: 1000, maxSamples, longTasksSupported,
          notes: {
            core: "Rates use counter differences over wall time; unavailable, paused, hidden or stale intervals are null. frameWallMs includes waiting and is not CPU time.",
            pageHz: "Browser animation callback rate, not game FPS.",
            memory: "WASM linear-memory capacity, not used heap or process resident memory. Canvas dimensions are output pixels, not internal render resolution.",
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
          samples: samples.map(sample => ({ ...sample, core: sample.core ? { ...sample.core } : null, io: { ...sample.io },
            audioCounters: { ...sample.audioCounters }, audioDelta: { ...sample.audioDelta } })) };
      },
    };
  }
  root.createPpssppPerformance = createPerformance;
  root.readPpssppCorePerformance = readCoreSnapshot;
  root.PpssppPerformance = createPerformance();
})(globalThis);
