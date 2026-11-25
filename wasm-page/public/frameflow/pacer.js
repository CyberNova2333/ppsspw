// SPDX-License-Identifier: AGPL-3.0-only
// Additional Terms: see LICENSE-ADDITIONAL_TERMS-zh-CN.md (v1.6.7-r4)
/**
 * Zero-readback realtime frame pacer for 2x (30->60 FPS) and 3x (20->60 FPS) interpolation.
 * Never stalls on GPU->CPU readback in the hot loop.
 */
export class FrameFlowPacer {
  /**
   * @param {{ factor?: 2 | 3, maxBufferMs?: number }} [options]
   */
  constructor(options = {}) {
    this.factor = options.factor === 3 ? 3 : 2;
    this.maxBufferMs = options.maxBufferMs ?? 120;
    this.reset();
  }

  reset() {
    this.prevSlot = -1;
    this.currSlot = -1;
    this.prevTime = 0;
    this.currTime = 0;
    this.emaIntervalMs = this.factor === 3 ? 50.0 : 33.33;
    this.queue = []; // [{ kind: 'source'|'mid', slot, t, dueMs, ready }]
    this.stats = { sources: 0, presentedSource: 0, presentedMid: 0, dropped: 0 };
  }

  /**
   * Notify pacer that a new native game frame arrived in `slot` at `nowMs`.
   * Returns a list of mid-frame generation tasks `{ t }` to schedule immediately.
   */
  onSourceFrame(slot, nowMs) {
    this.stats.sources++;
    if (this.currSlot < 0) {
      this.currSlot = slot;
      this.currTime = nowMs;
      this.queue.push({ kind: 'source', slot, dueMs: nowMs, ready: true });
      return [];
    }

    const dt = nowMs - this.currTime;
    if (dt > 4 && dt < 200) {
      this.emaIntervalMs = this.emaIntervalMs * 0.85 + dt * 0.15;
    }
    const interval = Math.min(this.maxBufferMs, Math.max(12, this.emaIntervalMs));

    this.prevSlot = this.currSlot;
    this.prevTime = this.currTime;
    this.currSlot = slot;
    this.currTime = nowMs;

    // Trim stale queued frames if host fell behind
    while (this.queue.length > this.factor + 2) {
      this.queue.shift();
      this.stats.dropped++;
    }

    // Schedule intermediate frames for (prevSlot -> currSlot), followed by real currSlot
    const genTasks = [];
    const baseTime = nowMs;
    for (let i = 1; i < this.factor; i++) {
      const t = i / this.factor;
      const item = { kind: 'mid', t, outSlot: i - 1, dueMs: baseTime + interval * (t - 0.5 / this.factor), ready: false };
      this.queue.push(item);
      genTasks.push(item);
    }
    this.queue.push({ kind: 'source', slot, dueMs: baseTime + interval * 0.9, ready: true });
    return genTasks;
  }

  /** Call once per display requestAnimationFrame(nowMs). Returns frame to present or null. */
  tick(nowMs) {
    if (!this.queue.length) return null;
    // Drop overdue items while keeping at least the newest ready frame
    while (this.queue.length > 1 && this.queue[1].ready && this.queue[1].dueMs <= nowMs) {
      this.queue.shift();
      this.stats.dropped++;
    }
    const head = this.queue[0];
    if (!head.ready || head.dueMs > nowMs + 4.0) return null;
    this.queue.shift();
    if (head.kind === 'source') {
      this.stats.presentedSource++;
      return { source: head.slot };
    }
    this.stats.presentedMid++;
    return { output: head.outSlot, mid: true, t: head.t };
  }

  report() {
    return {
      factor: this.factor,
      sourceIntervalMs: Number(this.emaIntervalMs.toFixed(2)),
      estimatedSourceFps: Number((1000 / this.emaIntervalMs).toFixed(2)),
      queued: this.queue.length,
      ...this.stats,
    };
  }
}
