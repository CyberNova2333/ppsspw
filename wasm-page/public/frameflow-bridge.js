// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of PPSSPW and is licensed under GNU AGPLv3 with Additional Terms (see LICENSE and LICENSE-ADDITIONAL_TERMS-zh-CN.md; ref: LICENSE-ADDITIONAL_TERMS-en.md).
/**
 * PPSSPW FrameFlow Bridge (GameFI Interpolation + GameSR 2x SR, Auto WebGPU Compute / WebGL2 Fragment Shader).
 *
 * Passively observes `#canvas`'s WebGL2 draw calls via WebGL2RenderingContext.prototype
 * (zero Emscripten GL state mutation) and captures each newly rendered PSP game frame
 * at the end of the synchronous draw turn (`queueMicrotask`, before browser composite):
 *  - Distinguishes real PSP game frames (offscreen FBO draws) from duplicate 60 Hz
 *    host ticks on 20/30 FPS PSP games.
 *  - Caps processing/output resolution for HiDPI viewports (using single-pass GPU
 *    downscaling) so high-DPR screens never trigger 100 ms shader stalls.
 *  - Blocks CPU software renderers (SwiftShader/llvmpipe) and enforces a 2-tier
 *    adaptive GPU/RAF performance guard so page refresh never collapses.
 */
(function installPpssppFrameFlowBridge() {
  'use strict';

  const PRESETS = {
    'lite-2x': { model: 'lite', factor: 2, label: '2× · Lite' },
    'std-2x': { model: 'std', factor: 2, label: '2× · Std' },
    'lite-3x': { model: 'lite', factor: 3, label: '3× · Lite' },
    'std-3x': { model: 'std', factor: 3, label: '3× · Std' },
  };
  const SR_PRESETS = {
    'sr-lite': { model: 'sr_lite', scale: 2, label: '2× · Lite' },
    'sr-std': { model: 'sr_std', scale: 2, label: '2× · Std' },
  };

  const SOFTWARE_RENDERER_RE = /\b(swiftshader|llvmpipe|softpipe|lavapipe|swrast|mesa\s+offscreen)\b|microsoft\s+basic\s+render|d3d11\s+warp/i;
  const SOFTWARE_BLOCKED_ERR = '__FRAMEFLOW_SOFTWARE_BLOCKED__';

  const urlParams = new URLSearchParams(location.search);
  const forcedBackend = ['webgpu', 'webgl2'].includes(urlParams.get('ffBackend'))
    ? urlParams.get('ffBackend')
    : 'auto';
  const allowSoftware = urlParams.get('ffAllowSoftware') === '1';

  let requestedPreset = 'off';
  let requestedSrPreset = 'off';
  let powerPreference = 'high-performance';
  let runtimeMod = null;
  let engine = null;
  let engineBackend = null;
  let overlayCanvas = null;
  let overlayGpuCtx = null;
  let overlayGpuFmt = 'bgra8unorm';
  const modelCache = new Map();
  let activeModelName = null;
  let effectiveModelName = null;
  let activeFactor = 2;
  let downgrading = false;
  let session = null;
  let loadingTicket = 0;
  let loading = false;
  let lastError = null;
  let softwareBlocked = false;
  let active = false;
  let activeSrModelName = null;
  let srSessionModelName = null;
  let srSession = null;
  let srLoadingTicket = 0;
  let srLoading = false;
  let srLastError = null;
  let srActive = false;
  let avgSrMs = 0;

  function isBridgeActive() {
    return active || srActive;
  }

  // WebGL2 observation on PPSSPP's #canvas (zero GL state mutation!)
  let gameCanvas = null;
  let gameGlRenderer = '';
  let currentFbo = null;
  let pendingOffscreenDraws = 0;
  let pendingScreenDraws = 0;
  let captureMicrotaskPending = false;
  let lastOffscreenFrameTime = 0;
  let lastTickOffscreen = 0;
  let lastTickScreen = 0;
  let lastSrcW = 0;
  let lastSrcH = 0;

  // Pacing, ring, & GPU/RAF adaptive performance guard state
  let captureSlot = 0;
  let prevSlot = -1;
  let currSlot = -1;
  let lastSourceTime = 0;
  let emaIntervalMs = 33.33;
  let highFpsStreak = 0;
  let bypassing = false;
  let menuPassthrough = false;
  let perfTier = 0;
  let thermalBypass = false;
  let overloadStreak = 0;
  let lastPerfCheckMs = 0;
  let checkMidCount = 0;
  let emaRafMs = 16.67;
  let rafMonitorId = 0;
  let lastRafTs = 0;
  let presentQueue = [];
  let subFrameTimer = null;
  let gpuBusy = false;
  let glFence = null;
  let glFenceStartMs = 0;
  let resizeObserver = null;
  let statusListeners = new Set();

  // Rolling stats
  let winStart = performance.now();
  let winSources = 0;
  let winPresented = 0;
  let winMid = 0;
  let totalSources = 0;
  let totalPresented = 0;
  let totalMid = 0;
  let totalDropped = 0;
  let avgGpuMs = 0;
  let lastStatsNotify = 0;
  let lastSourceFps = 0;
  let lastOutputFps = 0;

  // ── 1. Hook WebGL2RenderingContext.prototype passively for #canvas ──────
  if (typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype) {
    const glProto = WebGL2RenderingContext.prototype;

    const origBindFbo = glProto.bindFramebuffer;
    glProto.bindFramebuffer = function patchedBindFramebuffer(target, fbo) {
      if (this.canvas && this.canvas.id === 'canvas') {
        gameCanvas = this.canvas;
        if (!gameGlRenderer) {
          try {
            const dbg = this.getExtension('WEBGL_debug_renderer_info');
            gameGlRenderer = String(dbg ? this.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : this.getParameter(this.RENDERER) || '').toLowerCase();
          } catch (_) {}
        }
        if (target === this.FRAMEBUFFER || target === this.DRAW_FRAMEBUFFER) {
          currentFbo = fbo || null;
        }
      }
      return origBindFbo.call(this, target, fbo);
    };

    const noteDraw = (gl) => {
      if (!gl.canvas || gl.canvas.id !== 'canvas') return;
      gameCanvas = gl.canvas;
      if (currentFbo !== null) {
        pendingOffscreenDraws++;
      } else {
        pendingScreenDraws++;
        if (!captureMicrotaskPending) {
          captureMicrotaskPending = true;
          queueMicrotask(onEndOfDrawTurn);
        }
      }
    };

    for (const name of [
      'drawArrays',
      'drawElements',
      'drawRangeElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
      'blitFramebuffer',
    ]) {
      if (typeof glProto[name] === 'function') {
        const orig = glProto[name];
        glProto[name] = function (...args) {
          if (isBridgeActive()) noteDraw(this);
          return orig.apply(this, args);
        };
      }
    }
  }

  function onEndOfDrawTurn() {
    captureMicrotaskPending = false;
    const off = pendingOffscreenDraws;
    const scr = pendingScreenDraws;
    pendingOffscreenDraws = 0;
    pendingScreenDraws = 0;
    if (!isBridgeActive() || !gameCanvas || (off === 0 && scr === 0)) return;
    lastTickOffscreen = off;
    lastTickScreen = scr;
    onGameFrameRendered(performance.now(), off, scr);
  }

  // ── 2. Overlay Layout & Canvas Visibility ───────────────────────────────
  function getOverlayCanvas() {
    if (!overlayCanvas) {
      overlayCanvas = document.getElementById('frameflowCanvas');
    }
    return overlayCanvas;
  }

  function syncOverlayRect() {
    const src = gameCanvas || document.getElementById('canvas');
    const dst = getOverlayCanvas();
    if (!src || !dst) return;
    const stage = src.parentElement;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const srcRect = src.getBoundingClientRect();
    if (srcRect.width <= 0 || srcRect.height <= 0) return;
    dst.style.left = (srcRect.left - stageRect.left) + 'px';
    dst.style.top = (srcRect.top - stageRect.top) + 'px';
    dst.style.width = srcRect.width + 'px';
    dst.style.height = srcRect.height + 'px';
  }

  function setOverlayVisible(visible) {
    const src = gameCanvas || document.getElementById('canvas');
    const dst = getOverlayCanvas();
    if (dst) {
      dst.hidden = !visible;
      if (visible) syncOverlayRect();
    }
    if (src) {
      src.classList.toggle('frameflow-hidden', visible);
    }
    if (visible && src && !resizeObserver && typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(syncOverlayRect);
      resizeObserver.observe(src);
      if (src.parentElement) resizeObserver.observe(src.parentElement);
      window.addEventListener('resize', syncOverlayRect, { passive: true });
    }
  }

  // ── 3. Host RAF Monitor & Session Pacing ────────────────────────────────
  function startRafMonitor() {
    if (rafMonitorId || typeof requestAnimationFrame !== 'function') return;
    lastRafTs = 0;
    const step = (ts) => {
      rafMonitorId = 0;
      if (!isBridgeActive()) return;
      if (!document.hidden) {
        if (lastRafTs > 0) {
          const dt = ts - lastRafTs;
          if (dt > 2 && dt < 250) {
            emaRafMs = emaRafMs * 0.88 + dt * 0.12;
          }
        }
        lastRafTs = ts;
      } else {
        lastRafTs = 0;
      }
      rafMonitorId = requestAnimationFrame(step);
    };
    rafMonitorId = requestAnimationFrame(step);
  }

  function stopRafMonitor() {
    if (rafMonitorId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafMonitorId);
    }
    rafMonitorId = 0;
    lastRafTs = 0;
  }

  function clearSubFrameTimer() {
    if (subFrameTimer !== null) {
      clearTimeout(subFrameTimer);
      subFrameTimer = null;
    }
  }

  function pollGlFence() {
    if (!glFence || engineBackend !== 'webgl2' || !engine?.gl) return;
    const gl = engine.gl;
    const status = gl.clientWaitSync(glFence, 0, 0);
    if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED || status === gl.WAIT_FAILED) {
      const elapsed = performance.now() - glFenceStartMs;
      if (status !== gl.WAIT_FAILED && elapsed > 0 && elapsed < 500) {
        if (active && session) {
          avgGpuMs = avgGpuMs ? avgGpuMs * 0.8 + elapsed * 0.2 : elapsed;
        } else if (srActive && srSession) {
          avgSrMs = avgSrMs ? avgSrMs * 0.8 + elapsed * 0.2 : elapsed;
        }
      }
      gl.deleteSync(glFence);
      glFence = null;
      gpuBusy = false;
    }
  }

  function clearGlFence() {
    if (glFence && engine?.gl) {
      try { engine.gl.deleteSync(glFence); } catch (_) {}
    }
    glFence = null;
  }

  function resetPacing() {
    clearSubFrameTimer();
    clearGlFence();
    captureSlot = 0;
    prevSlot = -1;
    currSlot = -1;
    lastSourceTime = 0;
    emaIntervalMs = activeFactor === 3 ? 50.0 : 33.33;
    highFpsStreak = 0;
    bypassing = false;
    menuPassthrough = false;
    presentQueue = [];
    gpuBusy = false;
  }

  function destroySession() {
    if (session) {
      session.destroy();
      session = null;
    }
    resetPacing();
  }

  function destroySrSession() {
    if (srSession) {
      srSession.destroy();
      srSession = null;
    }
    srSessionModelName = null;
    avgSrMs = 0;
  }

  function computeSessionSize(srcW, srcH) {
    const resVal = Number(document.getElementById('player-render-resolution')?.value || 2);
    const pspScale = Number.isFinite(resVal) ? resVal : 2;
    const steppedDownToLite = perfTier === 1 && activeModelName === 'std' && effectiveModelName === 'lite';
    let maxW = 960;
    let maxH = 544;
    if (srActive) {
      const boxW = Math.round((gameCanvas?.getBoundingClientRect().width || srcW) * (window.devicePixelRatio || 1));
      if (pspScale <= 1) {
        maxW = 480;
        maxH = 272;
      } else if (engineBackend === 'webgl2') {
        maxW = (active || activeSrModelName === 'sr_std') ? 480 : 640;
        maxH = Math.round((maxW * 272) / 480);
      } else {
        maxW = (!active && activeSrModelName === 'sr_lite' && boxW >= 1600 && perfTier === 0) ? 960 : (active ? 480 : 640);
        maxH = Math.round((maxW * 272) / 480);
      }
    } else if (perfTier >= 1 && !steppedDownToLite) {
      maxW = 768;
      maxH = 432;
    } else if (engineBackend === 'webgpu' && pspScale >= 3 && perfTier === 0) {
      maxW = 1280;
      maxH = 720;
    }
    const scale = Math.min(1, maxW / srcW, maxH / srcH);
    return {
      width: Math.max(32, Math.round((srcW * scale) / 2) * 2),
      height: Math.max(32, Math.round((srcH * scale) / 2) * 2),
    };
  }

  function ensureSession(srcW, srcH) {
    const needInterp = active && effectiveModelName && modelCache.has(effectiveModelName);
    const needSr = srActive && activeSrModelName && modelCache.has(activeSrModelName);
    if (!engine || (!needInterp && !needSr)) return false;
    if (srcW < 32 || srcH < 32) return false;
    const dst = getOverlayCanvas();
    if (!dst) return false;

    const { width, height } = computeSessionSize(srcW, srcH);
    const outW = needSr ? width * 2 : width;
    const outH = needSr ? height * 2 : height;
    const srcChanged = srcW !== lastSrcW || srcH !== lastSrcH;
    lastSrcW = srcW;
    lastSrcH = srcH;

    if (dst.width !== outW || dst.height !== outH) {
      dst.width = outW;
      dst.height = outH;
      if (engineBackend === 'webgpu' && overlayGpuCtx) {
        overlayGpuCtx.configure({
          device: engine.device,
          format: overlayGpuFmt,
          alphaMode: 'opaque',
        });
      }
      syncOverlayRect();
    } else if (srcChanged) {
      syncOverlayRect();
    }

    const interpOk = !needInterp || (session && session.width === width && session.height === height);
    const srOk = !needSr || (srSession && srSession.width === width && srSession.height === height && srSessionModelName === activeSrModelName);
    if (interpOk && srOk) return true;

    const isWebGL2 = engineBackend === 'webgl2';
    const lowPower = perfTier >= 1;
    let createdAny = false;

    if (!needInterp) {
      if (session) destroySession();
    } else if (!interpOk) {
      destroySession();
      const model = modelCache.get(effectiveModelName);
      const nextSession = engine.createSession(model, {
        width,
        height,
        k: (isWebGL2 && effectiveModelName === 'std') ? 1 : undefined,
        internal: isWebGL2
          ? ((lowPower && activeModelName === 'lite') ? [256, 160] : [320, 192])
          : (lowPower ? [256, 160] : (effectiveModelName === 'lite' ? [384, 224] : [480, 288])),
        sampling: (isWebGL2 || lowPower) ? 'bilinear' : 'model',
        stillGuard: !isWebGL2 && !lowPower && (width * height <= 960 * 544),
      });
      nextSession.addInput();  // 3rd ring slot
      nextSession.addOutput(); // 2nd output slot for 3x
      session = nextSession;
      lastPerfCheckMs = performance.now();
      checkMidCount = 0;
      createdAny = true;
    }

    if (!needSr) {
      if (srSession) destroySrSession();
    } else if (!srOk) {
      destroySrSession();
      const srModel = modelCache.get(activeSrModelName);
      srSession = engine.createSession(srModel, { width, height });
      srSessionModelName = activeSrModelName;
      createdAny = true;
    }

    if (createdAny) emitStats(true);
    return true;
  }

  async function fallbackStdToLite(ticket) {
    if (downgrading || !engine || !runtimeMod) return;
    downgrading = true;
    try {
      if (!modelCache.has('lite')) {
        const model = await runtimeMod.loadModelFromUrl(engine, './frameflow/models/lite');
        if (ticket !== loadingTicket || !active) {
          model.destroy();
          return;
        }
        modelCache.set('lite', model);
      }
      if (ticket !== loadingTicket || !active) return;
      effectiveModelName = 'lite';
      perfTier = 1;
      overloadStreak = 0;
      avgGpuMs = 0;
      emaRafMs = 16.67;
      checkMidCount = 0;
      destroySession();
      emitStats(true);
    } catch (_) {
    } finally {
      downgrading = false;
    }
  }

  function evaluatePerfGuard(now) {
    if (menuPassthrough || bypassing || thermalBypass || downgrading) return;
    if (now - lastPerfCheckMs < 1000 || checkMidCount < 6) return;
    lastPerfCheckMs = now;
    checkMidCount = 0;

    const gpuOverloaded = (engineBackend === 'webgpu' && avgGpuMs > 26.0) || (emaRafMs > 25.0);
    if (gpuOverloaded) {
      overloadStreak++;
    } else {
      overloadStreak = 0;
    }

    if (overloadStreak >= 2) {
      if (perfTier === 0) {
        if (effectiveModelName === 'std') {
          void fallbackStdToLite(loadingTicket);
        } else {
          perfTier = 1;
          overloadStreak = 0;
          avgGpuMs = 0;
          emaRafMs = 16.67;
          destroySession();
          emitStats(true);
        }
      } else if (perfTier === 1) {
        perfTier = 2;
        thermalBypass = true;
        overloadStreak = 0;
        clearSubFrameTimer();
        presentQueue.length = 0;
        emitStats(true);
      }
    }
  }

  function presentNow(frame, isMid) {
    if (!isBridgeActive()) return;
    try {
      if (srActive && srSession) {
        const tSr = performance.now();
        if (active && session) {
          const baseTex = 'source' in frame ? session.inputTexture(frame.source) : session.outputTexture(frame.output ?? 0);
          srSession.setExternalInputTexture(0, baseTex);
        }
        srSession.upscale(0, 0);
        if (!active && engineBackend === 'webgpu' && engine?.device?.queue?.onSubmittedWorkDone) {
          gpuBusy = true;
          engine.device.queue.onSubmittedWorkDone().then(() => {
            const dt = performance.now() - tSr;
            avgSrMs = avgSrMs ? avgSrMs * 0.8 + dt * 0.2 : dt;
            gpuBusy = false;
          }, () => {
            gpuBusy = false;
          });
        } else if (!active && engineBackend === 'webgl2' && engine?.gl) {
          const gl = engine.gl;
          clearGlFence();
          glFenceStartMs = tSr;
          glFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          gl.flush();
          gpuBusy = true;
        } else {
          const dtSr = performance.now() - tSr;
          avgSrMs = avgSrMs ? avgSrMs * 0.8 + dtSr * 0.2 : dtSr;
        }
        if (engineBackend === 'webgpu') {
          srSession.presentToContext(overlayGpuCtx, overlayGpuFmt, { output: 0 });
        } else {
          srSession.present({ output: 0 });
        }
      } else if (session && active) {
        if (engineBackend === 'webgpu') {
          session.presentToContext(overlayGpuCtx, overlayGpuFmt, frame);
        } else {
          session.present(frame);
        }
      } else {
        return;
      }
      winPresented++;
      totalPresented++;
      if (isMid) {
        winMid++;
        totalMid++;
      }
    } catch (err) {
      lastError = String(err?.message || err);
    }
  }

  function drainPresentQueue(forceNext = false) {
    clearSubFrameTimer();
    if (!session || !active) return;
    const now = performance.now();
    while (presentQueue.length > 1 && presentQueue[1].dueMs <= now) {
      presentQueue.shift();
      totalDropped++;
    }
    if (presentQueue.length > 0 && (forceNext || presentQueue[0].dueMs <= now + 4.0)) {
      const item = presentQueue.shift();
      presentNow(
        item.kind === 'source' ? { source: item.slot } : { output: item.outSlot },
        item.kind === 'mid',
      );
    }
    if (presentQueue.length > 0) {
      const delay = Math.max(1, Math.round(presentQueue[0].dueMs - performance.now()));
      subFrameTimer = setTimeout(() => drainPresentQueue(false), delay);
    }
    if (now - lastStatsNotify >= 500) emitStats(false);
  }

  function onGameFrameRendered(now, offscreenDraws, screenDraws) {
    if (!gameCanvas || gameCanvas.width < 32 || gameCanvas.height < 32) return;
    if (!ensureSession(gameCanvas.width, gameCanvas.height)) return;

    if (!active && srActive && srSession) {
      const isGameFrame = offscreenDraws > 0;
      if (isGameFrame) {
        lastOffscreenFrameTime = now;
      } else if (!(screenDraws > 0 && now - lastOffscreenFrameTime > 200)) {
        return;
      }
      pollGlFence();
      if (gpuBusy) {
        if (now - lastStatsNotify >= 500) emitStats(false);
        return;
      }
      try {
        srSession.pushFrame(0, gameCanvas);
        winSources++;
        totalSources++;
        presentNow({ output: 0 }, false);
      } catch (err) {
        srLastError = String(err?.message || err);
      }
      if (now - lastStatsNotify >= 500) emitStats(false);
      return;
    }

    const isGameFrame = offscreenDraws > 0;
    if (isGameFrame) {
      lastOffscreenFrameTime = now;
      menuPassthrough = false;
    } else if (screenDraws > 0 && now - lastOffscreenFrameTime > 200) {
      // PPSSPP menu / pause screen (no offscreen 3D draws) -> crisp passthrough.
      menuPassthrough = true;
    } else {
      // Duplicate 60 Hz host tick between 20/30 FPS game frames:
      // present the next scheduled sub-frame right on this host VSync!
      drainPresentQueue(true);
      return;
    }

    const slot = captureSlot;
    try {
      session.pushFrame(slot, gameCanvas);
    } catch (err) {
      lastError = String(err?.message || err);
      return;
    }

    winSources++;
    totalSources++;
    const nextSlot = [0, 1, 2].find((s) => s !== slot && s !== currSlot);
    captureSlot = nextSlot !== undefined ? nextSlot : (slot + 1) % 3;

    if (menuPassthrough) {
      clearSubFrameTimer();
      presentQueue.length = 0;
      prevSlot = -1;
      currSlot = slot;
      lastSourceTime = now;
      presentNow({ source: slot }, false);
      if (now - lastStatsNotify >= 500) emitStats(false);
      return;
    }

    if (currSlot < 0) {
      currSlot = slot;
      lastSourceTime = now;
      presentNow({ source: slot }, false);
      if (now - lastStatsNotify >= 500) emitStats(false);
      return;
    }

    const dt = now - lastSourceTime;
    if (dt > 4 && dt < 200) {
      emaIntervalMs = emaIntervalMs * 0.85 + dt * 0.15;
    }
    const interval = Math.min(120, Math.max(12, emaIntervalMs));
    prevSlot = currSlot;
    currSlot = slot;
    lastSourceTime = now;

    if (activeFactor === 2 && emaIntervalMs < 21.0) {
      highFpsStreak++;
      if (highFpsStreak >= 6) bypassing = true;
    } else if (emaIntervalMs >= 24.0 || activeFactor === 3) {
      highFpsStreak = 0;
      bypassing = false;
    }

    if (presentQueue.length > 0) {
      totalDropped += presentQueue.length;
      presentQueue.length = 0;
    }
    clearSubFrameTimer();
    pollGlFence();

    if (bypassing || thermalBypass || gpuBusy) {
      presentNow({ source: slot }, false);
      if (now - lastStatsNotify >= 500) emitStats(false);
      return;
    }

    try {
      const t0 = performance.now();
      session.pair(prevSlot, currSlot);
      for (let i = 1; i < activeFactor; i++) {
        const t = i / activeFactor;
        const outSlot = i - 1;
        session.mid(t, outSlot);
        checkMidCount++;
        if (i === 1) {
          presentNow({ output: outSlot }, true);
        } else {
          presentQueue.push({
            kind: 'mid',
            outSlot,
            t,
            dueMs: now + interval * ((i - 1) / activeFactor),
          });
        }
      }
      presentQueue.push({
        kind: 'source',
        slot,
        dueMs: now + interval * ((activeFactor - 1) / activeFactor),
      });
      const firstDelay = Math.max(1, Math.round(presentQueue[0].dueMs - performance.now()));
      subFrameTimer = setTimeout(drainPresentQueue, firstDelay);

      if (engineBackend === 'webgpu' && engine.device?.queue?.onSubmittedWorkDone) {
        gpuBusy = true;
        engine.device.queue.onSubmittedWorkDone().then(() => {
          const elapsed = performance.now() - t0;
          avgGpuMs = avgGpuMs ? avgGpuMs * 0.8 + elapsed * 0.2 : elapsed;
          gpuBusy = false;
        }, () => {
          gpuBusy = false;
        });
      } else {
        avgGpuMs = 0;
      }
      evaluatePerfGuard(now);
    } catch (err) {
      lastError = String(err?.message || err);
      presentNow({ source: slot }, false);
    }
    if (now - lastStatsNotify >= 500) emitStats(false);
  }

  function getStats() {
    const now = performance.now();
    const elapsed = Math.max(1, now - winStart);
    if (elapsed >= 450) {
      lastSourceFps = Number(((winSources * 1000) / elapsed).toFixed(1));
      lastOutputFps = Number(((winPresented * 1000) / elapsed).toFixed(1));
      if (elapsed >= 900) {
        winStart = now;
        winSources = 0;
        winPresented = 0;
        winMid = 0;
      }
    }
    const cfg = PRESETS[requestedPreset];
    const srCfg = SR_PRESETS[requestedSrPreset];
    return {
      preset: requestedPreset,
      label: cfg?.label || '关闭',
      effectiveModel: effectiveModelName,
      modelDowngraded: activeModelName === 'std' && effectiveModelName === 'lite',
      active,
      loading,
      srPreset: requestedSrPreset,
      srLabel: srCfg?.label || '关闭',
      srActive,
      srLoading,
      srOutW: srSession?.outW || 0,
      srOutH: srSession?.outH || 0,
      avgSrMs: Number(avgSrMs.toFixed(2)),
      srError: srLastError,
      bypassing,
      menuPassthrough,
      softwareBlocked,
      perfTier,
      thermalBypass,
      pageRafMs: Number(emaRafMs.toFixed(1)),
      backend: engineBackend,
      precision: engine ? engine.info().precision : null,
      factor: activeFactor,
      width: srSession?.width || session?.width || 0,
      height: srSession?.height || session?.height || 0,
      workW: session?.workW || 0,
      workH: session?.workH || 0,
      sourceFps: lastSourceFps,
      outputFps: lastOutputFps,
      avgGpuMs: Number(avgGpuMs.toFixed(2)),
      totalSources,
      totalPresented,
      totalMid,
      totalDropped,
      lastTickOffscreen,
      lastTickScreen,
      error: lastError,
    };
  }

  function emitStats(force) {
    lastStatsNotify = performance.now();
    const stats = getStats();
    for (const fn of statusListeners) {
      try { fn(stats, force); } catch (_) {}
    }
  }

  function isSoftwareRendererText(text) {
    return SOFTWARE_RENDERER_RE.test(String(text || ''));
  }

  function detectCanvasSoftwareRenderer() {
    if (gameGlRenderer) return gameGlRenderer;
    const infoRenderer = document.getElementById('iRenderer')?.textContent?.trim();
    if (infoRenderer) {
      gameGlRenderer = infoRenderer.toLowerCase();
      return gameGlRenderer;
    }
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2', { powerPreference });
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
        if (renderer) gameGlRenderer = renderer.toLowerCase();
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return renderer;
      }
    } catch (_) {}
    return '';
  }

  function detectVendorTag(str) {
    const s = String(str || '').toLowerCase();
    if (s.includes('nvidia')) return 'nvidia';
    if (s.includes('intel')) return 'intel';
    if (s.includes('amd') || s.includes('radeon') || s.includes('ati')) return 'amd';
    if (s.includes('apple')) return 'apple';
    if (s.includes('qualcomm') || s.includes('adreno')) return 'qualcomm';
    if (s.includes('arm') || s.includes('mali')) return 'arm';
    return '';
  }

  async function pickMatchingWebGPUAdapter() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    const glVendor = detectVendorTag(gameGlRenderer);
    const prefs = powerPreference === 'low-power'
      ? ['low-power', 'high-performance']
      : ['high-performance', 'low-power'];

    let fallbackAdapter = null;
    for (const pref of prefs) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: pref });
      if (!adapter) continue;
      const adapterDesc = [adapter.info?.description, adapter.info?.device, adapter.info?.vendor].filter(Boolean).join(' ');
      if (!allowSoftware && (adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter || isSoftwareRendererText(adapterDesc))) {
        continue;
      }
      if (!fallbackAdapter) fallbackAdapter = adapter;
      const gpuVendor = detectVendorTag(adapterDesc);
      // Require same physical GPU vendor as PPSSPP's WebGL2 #canvas to prevent
      // cross-GPU copyExternalImageToTexture black screens on hybrid laptops.
      if (!glVendor || !gpuVendor || glVendor === gpuVendor) {
        return adapter;
      }
    }
    return forcedBackend === 'webgpu' ? fallbackAdapter : null;
  }

  async function initEngineIfNeeded() {
    if (!allowSoftware && isSoftwareRendererText(detectCanvasSoftwareRenderer())) {
      throw new Error(SOFTWARE_BLOCKED_ERR);
    }
    if (engine) return engine;
    runtimeMod = runtimeMod || await import('./frameflow/index.js');
    const dst = getOverlayCanvas();
    if (!dst) throw new Error('未找到插帧画布');

    // Prefer same-API WebGL2 on PPSSPP (#canvas is WebGL2, avoiding ~46 ms
    // cross-API copyExternalImageToTexture stalls into WebGPU), falling back to
    // WebGPU when WebGL2 float targets are unavailable or ?ffBackend=webgpu is set.
    if (forcedBackend !== 'webgpu') {
      try {
        const glEngine = await runtimeMod.createFrameFlow({ backend: 'webgl2', canvas: dst, powerPreference });
        if (!allowSoftware && isSoftwareRendererText(glEngine.info().renderer)) {
          glEngine.destroy();
          throw new Error(SOFTWARE_BLOCKED_ERR);
        }
        engine = glEngine;
        engineBackend = 'webgl2';
        overlayGpuCtx = null;
        return engine;
      } catch (err) {
        if (err?.message === SOFTWARE_BLOCKED_ERR || forcedBackend === 'webgl2') throw err;
      }
    }

    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await pickMatchingWebGPUAdapter();
      if (!adapter) throw new Error('No same-GPU WebGPU adapter matched #canvas');
      const useF16 = adapter.features.has('shader-f16');
      const device = await adapter.requestDevice({ requiredFeatures: useF16 ? ['shader-f16'] : [] });
      const gpuEngine = await runtimeMod.createFrameFlow({ backend: 'webgpu', device });
      const ctx = dst.getContext('webgpu');
      if (!ctx) {
        gpuEngine.destroy();
        device.destroy();
        throw new Error('WebGPU canvas context unavailable');
      }
      const fmt = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device: gpuEngine.device, format: fmt, alphaMode: 'opaque' });
      engine = gpuEngine;
      engineBackend = 'webgpu';
      overlayGpuCtx = ctx;
      overlayGpuFmt = fmt;
      return engine;
    }

    throw new Error('当前浏览器不支持可用的 GPU 加速后端');
  }

  async function ensureModelCached(modelName, isCurrentTicket) {
    const eng = await initEngineIfNeeded();
    if (!isCurrentTicket()) return null;
    if (!modelCache.has(modelName)) {
      const model = await runtimeMod.loadModelFromUrl(eng, `./frameflow/models/${modelName}`);
      if (!isCurrentTicket()) {
        model.destroy();
        return null;
      }
      modelCache.set(modelName, model);
    }
    return eng;
  }

  function syncActiveOverlay() {
    if (isBridgeActive()) {
      startRafMonitor();
      setOverlayVisible(true);
      if (gameCanvas && gameCanvas.width >= 32 && gameCanvas.height >= 32) {
        ensureSession(gameCanvas.width, gameCanvas.height);
      }
    } else {
      stopRafMonitor();
      setOverlayVisible(false);
    }
  }

  async function setPreset(preset, options) {
    const normalized = PRESETS[preset] ? preset : 'off';
    if (options?.powerPreference && options.powerPreference !== 'default') {
      powerPreference = options.powerPreference;
    }
    requestedPreset = normalized;
    lastError = null;
    softwareBlocked = false;
    perfTier = 0;
    thermalBypass = false;
    overloadStreak = 0;
    checkMidCount = 0;
    avgGpuMs = 0;
    emaRafMs = 16.67;
    downgrading = false;
    const ticket = ++loadingTicket;

    if (normalized === 'off') {
      active = false;
      loading = false;
      effectiveModelName = null;
      destroySession();
      syncActiveOverlay();
      emitStats(true);
      return getStats();
    }

    const cfg = PRESETS[normalized];
    loading = true;
    emitStats(true);
    try {
      const eng = await ensureModelCached(cfg.model, () => ticket === loadingTicket);
      if (!eng || ticket !== loadingTicket) return getStats();

      const modelChanged = activeModelName !== cfg.model || effectiveModelName !== cfg.model;
      activeModelName = cfg.model;
      effectiveModelName = cfg.model;
      activeFactor = cfg.factor;
      if (modelChanged) destroySession();
      loading = false;
      active = true;
      syncActiveOverlay();
      emitStats(true);
      return getStats();
    } catch (err) {
      if (ticket !== loadingTicket) return getStats();
      loading = false;
      active = false;
      effectiveModelName = null;
      requestedPreset = 'off';
      if (err?.message === SOFTWARE_BLOCKED_ERR) {
        softwareBlocked = true;
        lastError = null;
      } else {
        lastError = String(err?.message || err);
      }
      destroySession();
      syncActiveOverlay();
      emitStats(true);
      return getStats();
    }
  }

  async function setSrPreset(preset, options) {
    const normalized = SR_PRESETS[preset] ? preset : 'off';
    if (options?.powerPreference && options.powerPreference !== 'default') {
      powerPreference = options.powerPreference;
    }
    requestedSrPreset = normalized;
    srLastError = null;
    softwareBlocked = false;
    const ticket = ++srLoadingTicket;

    if (normalized === 'off') {
      srActive = false;
      srLoading = false;
      activeSrModelName = null;
      destroySrSession();
      syncActiveOverlay();
      emitStats(true);
      return getStats();
    }

    const cfg = SR_PRESETS[normalized];
    srLoading = true;
    emitStats(true);
    try {
      const eng = await ensureModelCached(cfg.model, () => ticket === srLoadingTicket);
      if (!eng || ticket !== srLoadingTicket) return getStats();

      const modelChanged = activeSrModelName !== cfg.model;
      activeSrModelName = cfg.model;
      if (modelChanged) destroySrSession();
      srLoading = false;
      srActive = true;
      syncActiveOverlay();
      emitStats(true);
      return getStats();
    } catch (err) {
      if (ticket !== srLoadingTicket) return getStats();
      srLoading = false;
      srActive = false;
      activeSrModelName = null;
      requestedSrPreset = 'off';
      if (err?.message === SOFTWARE_BLOCKED_ERR) {
        softwareBlocked = true;
        srLastError = null;
      } else {
        srLastError = String(err?.message || err);
      }
      destroySrSession();
      syncActiveOverlay();
      emitStats(true);
      return getStats();
    }
  }

  globalThis.PpssppFrameFlow = {
    PRESETS,
    SR_PRESETS,
    setPreset,
    setSrPreset,
    getStats,
    syncOverlayRect,
    subscribe(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
  };
})();
