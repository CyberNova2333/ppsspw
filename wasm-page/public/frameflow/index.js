// SPDX-License-Identifier: AGPL-3.0-only
// Additional Terms: see LICENSE-ADDITIONAL_TERMS-zh-CN.md (v1.6.7-r4)
/**
 * FrameFlow Unified Cross-Browser Runtime Entrypoint.
 *
 * Automatic backend fallback:
 *   1. WebGPU Compute (f16 when supported, else f32) — Chrome, Edge, Safari 26+, Win/Mac Firefox
 *   2. WebGL2 Fragment Shaders (RGBA16F TEXTURE_2D_ARRAY + MRT) — Firefox Linux/Android, iOS 15-18, WebViews, PPSSPW zero-copy
 *   3. Graceful unsupported report (no CPU WASM fallback that would starve emulators)
 */
import { probeWebGPU, WebGPUEngine } from './webgpu-backend.js';
import { probeWebGL2, WebGL2Engine } from './webgl2-backend.js';

export { parseModel, compilePlan, align32 } from './loader.js';
export { WebGPUEngine, probeWebGPU } from './webgpu-backend.js';
export { WebGL2Engine, probeWebGL2 } from './webgl2-backend.js';
export { FrameFlowPacer } from './pacer.js';

/** Probe available FrameFlow GPU backends on the current browser without allocating sessions. */
export async function probeCapabilities(options = {}) {
  const [webgpu, webgl2] = await Promise.all([
    probeWebGPU(options.powerPreference || 'high-performance'),
    Promise.resolve(probeWebGL2(options.gl || options.canvas || null)),
  ]);
  const recommended = webgpu.supported ? 'webgpu' : webgl2.supported ? 'webgl2' : null;
  return { supported: recommended !== null, recommended, webgpu, webgl2 };
}

/**
 * Create a FrameFlow engine with automatic WebGPU -> WebGL2 selection.
 *
 * @param {{
 *   backend?: 'auto' | 'webgpu' | 'webgl2',
 *   device?: GPUDevice,
 *   gl?: WebGL2RenderingContext,
 *   canvas?: HTMLCanvasElement | OffscreenCanvas,
 *   precision?: 'auto' | 'f16' | 'f32',
 *   powerPreference?: 'high-performance' | 'low-power',
 * }} [options]
 */
export async function createFrameFlow(options = {}) {
  const mode = options.backend || (options.device ? 'webgpu' : options.gl ? 'webgl2' : 'auto');

  if (mode === 'webgpu') {
    return WebGPUEngine.create(options);
  }
  if (mode === 'webgl2') {
    return WebGL2Engine.create(options);
  }
  // mode === 'auto': try WebGPU first, seamlessly fall back to WebGL2
  try {
    return await WebGPUEngine.create(options);
  } catch (gpuErr) {
    try {
      return await WebGL2Engine.create(options);
    } catch (glErr) {
      throw new Error(`FrameFlow unsupported on this browser (WebGPU: ${gpuErr.message}; WebGL2: ${glErr.message})`);
    }
  }
}

/** Convenience helper to fetch (graph.json, model.json, model.bin) from a directory URL. */
export async function loadModelFromUrl(engine, baseUrl, stem = 'model') {
  const prefix = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const [graph, manifest, bin] = await Promise.all([
    fetch(`${prefix}graph.json`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} graph.json`); return r.text(); }),
    fetch(`${prefix}${stem}.json`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} ${stem}.json`); return r.text(); }),
    fetch(`${prefix}${stem}.bin`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} ${stem}.bin`); return r.arrayBuffer(); }),
  ]);
  return engine.loadModel(graph, manifest, new Uint8Array(bin));
}
