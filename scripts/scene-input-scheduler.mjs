// Schedule input edges against observed emulated time, without sending input.
// These records prove scheduling only, not PSP acceptance or deterministic replay.
const BUTTONS = new Set(['circle', 'cross', 'square', 'triangle', 'up', 'down', 'left', 'right', 'l', 'r', 'start', 'select']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const cloneEdge = edge => ({ ...edge, buttons: [...edge.buttons] });

export function createSceneInputScheduler({ startEmulatedUs, actions, maxLatenessUs = 100000,
  maxStallMs = 3000, maxSampleAgeMs = 2500, maxWallMs = 120000 } = {}) {
  if (!integer(startEmulatedUs) || !integer(maxLatenessUs) || !integer(maxSampleAgeMs)
    || !integer(maxStallMs) || maxStallMs === 0 || !integer(maxWallMs) || maxWallMs === 0) {
    throw new TypeError('Scheduler times must be nonnegative safe integers; timeouts must be positive.');
  }
  if (!Array.isArray(actions) || actions.length > 256) throw new TypeError('Provide at most 256 actions.');
  let previousEnd = 0;
  const plan = Array.from(actions, (action, index) => {
    if (!action || !integer(action.atUs) || !integer(action.durationUs) || action.durationUs === 0
      || action.atUs < previousEnd || !integer(action.atUs + action.durationUs)
      || !integer(startEmulatedUs + action.atUs + action.durationUs)) {
      throw new TypeError('Actions must be ordered, nonoverlapping and have safe integer times and positive durations.');
    }
    if (!Array.isArray(action.buttons) || action.buttons.length === 0 || action.buttons.length > BUTTONS.size
      || Array.from(action.buttons).some(button => !BUTTONS.has(button)) || new Set(action.buttons).size !== action.buttons.length) {
      throw new TypeError('Actions require unique, supported buttons.');
    }
    previousEnd = action.atUs + action.durationUs;
    return { index, downUs: startEmulatedUs + action.atUs, upUs: startEmulatedUs + previousEnd, buttons: [...action.buttons] };
  });
  let phase = 'waiting', reason = null, needsRelease = false;
  let firstWallMs = null, lastWallMs = null, lastProgressWallMs = null;
  let lastEmulatedUs = null, lastSequence = null, actionIndex = 0, held = false;
  const history = [];
  const terminal = () => phase === 'completed' || phase === 'invalid';
  const result = (edges = []) => ({ phase, reason, needsRelease, edges: edges.map(cloneEdge) });
  function invalidate(value) {
    phase = 'invalid'; reason = value; needsRelease = true;
    return result();
  }
  function step(core, wallMs, visibility = { visible: true }) {
    if (terminal()) return result();
    if (!finite(wallMs)) return invalidate('invalid_wall_time');
    if (visibility?.visible !== true) return invalidate('page_hidden');
    if (!core || core.initialized !== true) return invalidate('core_uninitialized');
    if (core.emulating !== true) return invalidate('core_paused');
    if (!integer(core.emulatedUs) || !integer(core.sequence) || core.sequence % 2 || !finite(core.sampleAgeMs)) {
      return invalidate('invalid_core_sample');
    }
    if (core.sampleAgeMs > maxSampleAgeMs) return invalidate('stale_core_sample');
    if (lastWallMs !== null && wallMs < lastWallMs) return invalidate('wall_time_regressed');
    if (lastEmulatedUs !== null && core.emulatedUs < lastEmulatedUs) return invalidate('emulated_time_regressed');
    if (lastSequence !== null && core.sequence < lastSequence) return invalidate('sequence_regressed');
    if (lastSequence === core.sequence && lastEmulatedUs !== core.emulatedUs) return invalidate('inconsistent_sequence');
    if (firstWallMs !== null && wallMs - firstWallMs > maxWallMs) return invalidate('run_timeout');
    if (lastProgressWallMs !== null && wallMs - lastProgressWallMs > maxStallMs) return invalidate('core_stalled');
    // Enforce alignment when crossing the start as well as on a late first call.
    // Compare differences instead of adding tolerance to a near-limit timestamp.
    if (phase === 'waiting' && core.emulatedUs > startEmulatedUs && core.emulatedUs - startEmulatedUs > maxLatenessUs) return invalidate('start_late');
    if (firstWallMs === null) {
      firstWallMs = wallMs; lastProgressWallMs = wallMs;
    }
    lastWallMs = wallMs;
    if (lastSequence === core.sequence) return result();
    if (lastEmulatedUs === null || core.emulatedUs > lastEmulatedUs) lastProgressWallMs = wallMs;
    lastEmulatedUs = core.emulatedUs; lastSequence = core.sequence;
    if (core.emulatedUs < startEmulatedUs) return result();
    phase = 'running';

    // Validate the whole batch before returning any edges. Never catch up a lost
    // pulse by dispatching its down and up together in the same observation.
    const edges = [];
    let nextIndex = actionIndex, nextHeld = held;
    while (nextIndex < plan.length) {
      const action = plan[nextIndex];
      const scheduledEmulatedUs = nextHeld ? action.upUs : action.downUs;
      if (core.emulatedUs < scheduledEmulatedUs) break;
      if (!nextHeld && core.emulatedUs >= action.upUs) return invalidate('missed_pulse');
      const latenessUs = core.emulatedUs - scheduledEmulatedUs;
      if (latenessUs > maxLatenessUs) return invalidate('action_late');
      edges.push({ index: action.index, phase: nextHeld ? 'up' : 'down', buttons: [...action.buttons],
        scheduledEmulatedUs, observedEmulatedUs: core.emulatedUs, latenessUs, wallMs, sequence: core.sequence });
      if (nextHeld) nextIndex++;
      nextHeld = !nextHeld;
    }
    actionIndex = nextIndex; held = nextHeld;
    history.push(...edges);
    if (actionIndex === plan.length) { phase = 'completed'; needsRelease = true; }
    return result(edges);
  }
  return {
    step,
    cancel(value = 'canceled') {
      if (terminal()) return result();
      if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw new TypeError('Cancel reason must be a short nonempty string.');
      return invalidate(value);
    },
    snapshot() {
      return { phase, reason, needsRelease, startEmulatedUs, firstWallMs, lastWallMs,
        lastEmulatedUs, lastSequence, completedActions: actionIndex, edges: history.map(cloneEdge) };
    },
  };
}
