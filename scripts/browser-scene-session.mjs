import { createSceneInputScheduler } from './scene-input-scheduler.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const copy = value => structuredClone(value);
const CANCEL_REASONS = new Set(['user_stopped', 'page_left', 'page_hidden', 'settings_changed', 'input_interference', 'harness_failed']);

// The caller owns the pump and its input source. This session never starts a
// browser/game, reads a save, or establishes visual scene identity.
export function createBrowserSceneSession({ sceneId, fixtureSha256, startEmulatedUs, actions, expectedRevision,
  durationMs = 60000, maxWaitMs = 30000, maxLatenessUs = 100000,
  performance: perf, readCore, clock, isVisible, setButtons, releaseButtons } = {}) {
  if (typeof sceneId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(sceneId) || !digest(fixtureSha256) || !digest(expectedRevision)
    || !integer(durationMs) || durationMs === 0 || !integer(maxWaitMs) || maxWaitMs === 0
    || !integer(durationMs + maxWaitMs + 3000)) throw new TypeError('Invalid scene identity or duration.');
  if (![readCore, clock, isVisible, setButtons, releaseButtons, ...['token', 'sessionToken', 'start', 'stop', 'summary', 'snapshot'].map(key => perf?.[key])]
    .every(fn => typeof fn === 'function')) throw new TypeError('Synchronous scene and performance adapters are required.');
  const scheduler = createSceneInputScheduler({ startEmulatedUs, actions, maxLatenessUs, maxWallMs: durationMs + maxWaitMs + 3000 });
  let phase = 'waiting', reason = null, ownedToken = null, finishing = false, pumping = false;
  let armedAtMs = null, startedAtMs = null, endedAtMs = null, lastWallMs = null, lastProgressMs = null;
  let previousCore = null, report = null, settings = null, lastSampleCount = null;
  const scene = { id: sceneId, fixtureSha256, startEmulatedUs, timeAligned: false, visualConfirmed: false };
  const cleanup = { inputReleased: false, recordingStopped: false };
  const dispatches = [];
  const terminal = () => phase === 'completed' || phase === 'invalid';
  // The animation-frame pump must not clone the growing sample report. Only an
  // explicit snapshot exports it; status is sufficient to detect completion.
  const status = () => ({ phase, reason });
  function snapshot() {
    return copy({ schemaVersion: 1, phase, reason, scene, requestedDurationMs: durationMs, startedAtMs, endedAtMs,
      elapsedMs: startedAtMs === null ? null : Math.max(0, (endedAtMs ?? lastWallMs) - startedAtMs),
      scheduler: scheduler.snapshot(), dispatches, performance: report, cleanup });
  }
  function fail(value) { phase = 'invalid'; reason ??= value; }
  function release() {
    cleanup.inputReleased = false;
    try { releaseButtons(); cleanup.inputReleased = true; }
    catch { /* The caller still stops its recording when input cleanup fails. */ }
  }
  function reportProblem(current) {
    if (current.coreRevision !== expectedRevision) return 'revision_mismatch';
    if (current.settings?.resolution !== 1 || current.settings?.appliedAtLaunch !== true
      || typeof current.settings?.showFps !== 'boolean' || typeof current.settings?.touch !== 'boolean') return 'settings_mismatch';
    if (settings && ['resolution', 'showFps', 'touch', 'appliedAtLaunch'].some(key => current.settings[key] !== settings[key])) return 'settings_changed';
    if (current.samplingErrors !== 0) return 'sampling_errors';
    if (current.visibilityChanges !== 0) return 'page_hidden';
    return null;
  }
  function readOwnedReport(stopped = false) {
    const activeToken = stopped ? 0 : ownedToken;
    if (perf.sessionToken() !== ownedToken || perf.token() !== activeToken) return 'recording_lost';
    const current = perf.snapshot();
    if (perf.sessionToken() !== ownedToken || perf.token() !== activeToken) return 'recording_lost';
    report = copy(current);
    lastSampleCount = current.totalSamples;
    return reportProblem(current);
  }
  function finish(value = null) {
    if (terminal() || finishing) return status();
    finishing = true;
    if (value) { phase = 'invalid'; reason = value; }
    else phase = 'completed';
    if (value) scheduler.cancel(value);
    release();
    if (!cleanup.inputReleased) fail('input_release_failed');
    if (ownedToken !== null) {
      try {
        if (perf.sessionToken() === ownedToken && perf.token() === ownedToken) {
          // Capture only our session. stop() publishes synchronously and a
          // listener may start another recording before it returns.
          // Report failures cannot prevent release of our active recorder.
          try { const reportError = readOwnedReport(); if (reportError) fail(reportError); }
          catch { fail('performance_read_failed'); }
          if (perf.sessionToken() === ownedToken && perf.token() === ownedToken) {
            try { perf.stop(); }
            catch { fail('recording_stop_failed'); }
            const activeToken = perf.token();
            if (activeToken !== ownedToken) cleanup.recordingStopped = true;
            if (perf.sessionToken() === ownedToken && activeToken === 0) {
              cleanup.recordingStopped = true;
              const reportError = readOwnedReport(true);
              if (reportError) fail(reportError);
            } else fail(activeToken === ownedToken ? 'recording_stop_failed' : 'recording_lost');
          } else fail('recording_lost');
        } else fail('recording_lost');
      } catch { fail('performance_read_failed'); }
    }
    if (phase === 'completed' && (report?.active !== false || !time(report?.durationMs) || report.durationMs < durationMs)) fail('recording_duration_short');
    endedAtMs = lastWallMs;
    finishing = false;
    return status();
  }
  function inspectCore(core, wallMs) {
    if (!core || core.initialized !== true) return 'core_uninitialized';
    if (core.emulating !== true) return 'core_paused';
    if (!integer(core.emulatedUs) || !integer(core.sequence) || core.sequence % 2 || !time(core.sampleAgeMs)) return 'invalid_core_sample';
    if (core.sampleAgeMs > 2500) return 'stale_core_sample';
    if (previousCore) {
      if (core.emulatedUs < previousCore.emulatedUs) return 'emulated_time_regressed';
      if (core.sequence < previousCore.sequence) return 'sequence_regressed';
      if (core.sequence === previousCore.sequence && core.emulatedUs !== previousCore.emulatedUs) return 'inconsistent_sequence';
    }
    if (lastProgressMs !== null && wallMs - lastProgressMs > 3000) return 'core_stalled';
    if (!previousCore || core.emulatedUs > previousCore.emulatedUs) lastProgressMs = wallMs;
    previousCore = { emulatedUs: core.emulatedUs, sequence: core.sequence };
    return null;
  }
  function pump() {
    if (terminal() || finishing || pumping) return status();
    pumping = true;
    try {
      let wallMs, core, visible, activeToken;
      try { wallMs = clock(); } catch { return finish('clock_failed'); }
      if (terminal()) return status();
      if (!time(wallMs)) return finish('invalid_wall_time');
      if (lastWallMs !== null && wallMs < lastWallMs) return finish('wall_time_regressed');
      lastWallMs = wallMs; armedAtMs ??= wallMs;
      try { visible = isVisible(); } catch { return finish('visibility_read_failed'); }
      if (terminal()) return status();
      if (visible !== true) return finish('page_hidden');
      try { core = readCore(); } catch { return finish('core_read_failed'); }
      if (terminal()) return status();
      const coreError = inspectCore(core, wallMs);
      if (coreError) return finish(coreError);
      try { activeToken = perf.token(); } catch { return finish('performance_read_failed'); }
      if (phase === 'waiting') {
        if (activeToken !== 0) return finish('existing_recording');
        if (wallMs - armedAtMs > maxWaitMs) return finish('wait_timeout');
      } else if (activeToken !== ownedToken || perf.sessionToken() !== ownedToken) return finish('recording_lost');

      const due = scheduler.step(core, wallMs, { visible });
      if (due.phase === 'invalid') return finish(due.reason);
      if (phase === 'waiting' && core.emulatedUs >= startEmulatedUs) {
        const previousToken = perf.sessionToken();
        if (!integer(previousToken) || !integer(previousToken + 1)) return finish('performance_read_failed');
        // This anticipated id is ours even if start throws after allocating it.
        // Never adopt the active id after callbacks may have opened another run.
        ownedToken = previousToken + 1;
        let startFailed = false, startedToken;
        try { startedToken = perf.start(); } catch { startFailed = true; }
        if (terminal()) return status();
        if (startFailed) return finish('performance_start_failed');
        if (startedToken !== ownedToken) return finish('performance_not_started');
        if (perf.sessionToken() !== ownedToken || perf.token() !== ownedToken) return finish('recording_lost');
        startedAtMs = wallMs; phase = 'recording';
        const reportError = readOwnedReport();
        if (reportError) return finish(reportError);
        const first = report.samples?.[0];
        if (report.active !== true || report.totalSamples !== 1 || first?.visible !== true
          || !integer(first.core?.emulatedUs) || Math.abs(first.core.emulatedUs - startEmulatedUs) > maxLatenessUs
          || !integer(first.core?.sequence) || first.core.sequence % 2 || !time(first.core.sampleAgeMs) || first.core.sampleAgeMs > 2500
          || first.core.initialized !== true || first.core.emulating !== true) return finish('start_sample_mismatch');
        settings = { ...report.settings }; scene.timeAligned = true;
      }
      if (phase === 'recording') {
        if (perf.summary().totalSamples !== lastSampleCount) {
          const reportError = readOwnedReport();
          if (reportError) return finish(reportError);
        }
        if (terminal()) return status();
        // A fixed wall-time window never catches up by sending overdue actions
        // after its endpoint. Incomplete plans remain explicitly invalid.
        if (wallMs - startedAtMs >= durationMs) {
          if (due.edges.length || due.phase !== 'completed') return finish('actions_incomplete');
          return finish();
        }
        for (const edge of due.edges) {
          try {
            if (edge.phase === 'down') { cleanup.inputReleased = false; setButtons([...edge.buttons]); }
            else { release(); if (!cleanup.inputReleased) return finish('input_release_failed'); }
          } catch { return finish('input_dispatch_failed'); }
          if (terminal()) return status();
          let dispatchedWallMs;
          try { dispatchedWallMs = clock(); } catch { return finish('clock_failed'); }
          if (terminal()) return status();
          if (!time(dispatchedWallMs) || dispatchedWallMs < wallMs) return finish('invalid_wall_time');
          dispatches.push({ ...edge, buttons: [...edge.buttons], dispatchedWallMs });
        }
      }
      return status();
    } catch { return finish('performance_read_failed'); }
    finally { pumping = false; }
  }
  return { pump, snapshot, cancel(value = 'user_stopped') { return finish(CANCEL_REASONS.has(value) ? value : 'user_stopped'); } };
}
