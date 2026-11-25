// SPDX-License-Identifier: AGPL-3.0-only
// Additional Terms: see LICENSE-ADDITIONAL_TERMS-zh-CN.md (v1.6.7-r4)
/**
 * Shared FrameFlow model loader & graph validator (used by both WebGPU and WebGL2 backends).
 * Parses (graph.json, model.json, model.bin) with little-endian IEEE-754 float16 weights.
 */

const _f32Buf = new ArrayBuffer(4);
const _f32View = new Float32Array(_f32Buf);
const _u32View = new Uint32Array(_f32Buf);

/** Convert IEEE-754 binary16 (uint16) to JS number (float32). */
export function f16ToF32(h) {
  const s = (h & 0x8000) << 16;
  let e = (h >> 10) & 0x1f;
  let m = h & 0x03ff;
  if (e === 0) {
    if (m === 0) {
      _u32View[0] = s;
      return _f32View[0];
    }
    // Subnormal
    while ((m & 0x0400) === 0) {
      m <<= 1;
      e -= 1;
    }
    e += 1;
    m &= ~0x0400;
  } else if (e === 31) {
    _u32View[0] = s | 0x7f800000 | (m << 13);
    return _f32View[0];
  }
  _u32View[0] = s | ((e + 112) << 23) | (m << 13);
  return _f32View[0];
}

/** Decode a Uint16Array of IEEE-754 f16 bits into a Float32Array. */
export function decodeF16Array(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    out[i] = f16ToF32(u16[i]);
  }
  return out;
}

/**
 * Validate and parse model artifacts into a normalized ModelData object.
 * @param {string|object} graphInput - graph.json text or parsed object
 * @param {string|object} manifestInput - model.json text or parsed object
 * @param {ArrayBuffer|Uint8Array} binInput - model.bin little-endian f16 bytes
 */
export function parseModel(graphInput, manifestInput, binInput) {
  const graph = typeof graphInput === 'string' ? JSON.parse(graphInput) : graphInput;
  const manifest = typeof manifestInput === 'string' ? JSON.parse(manifestInput) : manifestInput;

  if (!graph || !Array.isArray(graph.ops)) {
    throw new Error('Invalid graph.json: missing ops array');
  }
  if (!manifest || !manifest.meta || !manifest.tensors) {
    throw new Error('Invalid model.json: missing meta or tensors');
  }
  if (manifest.meta.format_version !== 1) {
    throw new Error(`Unsupported model format_version: ${manifest.meta.format_version}`);
  }

  const bytes = binInput instanceof Uint8Array
    ? binInput
    : new Uint8Array(binInput);
  if (bytes.byteLength % 2 !== 0) {
    throw new Error(`model.bin byte length (${bytes.byteLength}) must be even for f16`);
  }
  // Ensure 2-byte aligned Uint16Array view (little-endian)
  const u16 = bytes.byteOffset % 2 === 0
    ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
    : new Uint16Array(bytes.slice().buffer);

  const weightsF32 = new Map();
  const weightsU16 = new Map();
  const shapes = new Map();

  for (const [name, info] of Object.entries(manifest.tensors)) {
    const { shape, offset } = info;
    if (!Array.isArray(shape) || typeof offset !== 'number' || offset < 0) {
      throw new Error(`Invalid tensor entry ${name}`);
    }
    let count = 1;
    for (const d of shape) {
      if (!Number.isInteger(d) || d < 1) throw new Error(`Invalid dim ${d} in tensor ${name}`);
      count *= d;
    }
    if (offset + count > u16.length) {
      throw new Error(`Tensor ${name} out of bounds (${offset}+${count} > ${u16.length})`);
    }
    const sliceU16 = u16.subarray(offset, offset + count);
    weightsU16.set(name, sliceU16);
    weightsF32.set(name, decodeF16Array(sliceU16));
    shapes.set(name, shape);
  }

  // Validate every weight referenced in graph.json exists
  const checkOps = (ops) => {
    for (const op of ops) {
      if (Array.isArray(op.w)) {
        for (const wName of op.w) {
          if (!weightsF32.has(wName)) {
            throw new Error(`graph.json references missing weight: ${wName}`);
          }
        }
      }
      if (op.op === 'repeat' && Array.isArray(op.body)) {
        checkOps(op.body);
      }
    }
  };
  checkOps(graph.ops);

  return {
    meta: manifest.meta,
    graph,
    weightsF32,
    weightsU16,
    shapes,
    info() {
      return {
        name: manifest.meta.model,
        formatVersion: manifest.meta.format_version,
        trainStep: manifest.meta.train_step ?? 0,
        params: manifest.meta.n_params ?? u16.length,
        tensors: shapes.size,
        renderSampling: manifest.meta.render_sampling || 'bilinear',
        defaultK: manifest.meta.default_K ?? 1,
        task: manifest.meta.task || 'interp',
        scale: manifest.meta.scale || 1,
        cfg: manifest.meta.cfg || null,
      };
    },
  };
}

/**
 * Unroll `repeat` loops for a specific `K` and split ops into `pairOps` and `midOps`,
 * while tracking exact tensor shapes `[c, h, w]` for static buffer/texture planning.
 */
export function compilePlan(modelData, workW, workH, k, opts = {}) {
  const useFilm = opts.useFilm !== false;
  const useRefine = opts.useRefine !== false;
  const flatOps = [];

  const emitList = (ops) => {
    for (const op of ops) {
      if (op.cond === 'use_film' && !useFilm) {
        if (op.else_alias) {
          for (const [dst, src] of Object.entries(op.else_alias)) {
            flatOps.push({ op: 'copy', in: [src], out: [dst] });
          }
        }
        continue;
      }
      if (op.cond === 'use_refine' && !useRefine) {
        if (op.else_alias) {
          for (const [dst, src] of Object.entries(op.else_alias)) {
            flatOps.push({ op: 'copy', in: [src], out: [dst] });
          }
        }
        continue;
      }
      if (op.op === 'repeat') {
        const times = op.times === 'K' ? k : Number(op.times);
        for (let iter = 0; iter < times; iter++) {
          emitList(op.body);
        }
      } else {
        flatOps.push(op);
      }
    }
  };
  emitList(modelData.graph.ops);

  // Split index: SR runs single-stage; interpolation splits at first op reading `t` / `mul_t` / `film_mlp`
  const isSr = modelData.meta.task === 'sr' || flatOps.some((op) => op.op === 'render_sr');
  const splitIdx = isSr
    ? flatOps.length
    : flatOps.findIndex(
        (op) => op.op === 'mul_t' || op.op === 'film_mlp' || (Array.isArray(op.in) && op.in.includes('t')),
      );
  if (splitIdx < 0) throw new Error('Invalid graph: could not locate mid-stage split point');

  // Static shape inference & SSA renaming (so repeat-carried names get unique buffers cleanly)
  const nameToId = new Map([
    ['A', 'A'],
    ['B', 'B'],
    ['t', 't'],
  ]);
  const tensorMeta = new Map([
    ['A', { c: 3, h: workH, w: workW }],
    ['B', { c: 3, h: workH, w: workW }],
  ]);

  let nextVer = 0;
  const steps = [];

  for (let i = 0; i < flatOps.length; i++) {
    const raw = flatOps[i];
    const stage = i < splitIdx ? 'pair' : 'mid';
    const inIds = (raw.in || []).map((n) => (n === 't' ? 't' : nameToId.get(n)));
    for (let j = 0; j < inIds.length; j++) {
      if (!inIds[j]) throw new Error(`Unbound input ${raw.in[j]} at op #${i} (${raw.op})`);
    }

    if (raw.op === 'copy') {
      nameToId.set(raw.out[0], inIds[0]);
      continue;
    }

    const outIds = [];
    for (const outName of raw.out) {
      const uid = `${outName}#${nextVer++}`;
      nameToId.set(outName, uid);
      outIds.push(uid);
    }

    const s0 = inIds[0] !== 't' ? tensorMeta.get(inIds[0]) : null;
    const op = raw.op;

    if (op === 'interpolate') {
      const oh = raw.scale ? Math.round(s0.h * raw.scale) : workH;
      const ow = raw.scale ? Math.round(s0.w * raw.scale) : workW;
      tensorMeta.set(outIds[0], { c: s0.c, h: oh, w: ow });
    } else if (op === 'conv' || op === 'conv2d') {
      const wShape = modelData.shapes.get(raw.w[0]);
      const stride = raw.stride || 1;
      const oh = Math.floor((s0.h + 2 - 3) / stride) + 1;
      const ow = Math.floor((s0.w + 2 - 3) / stride) + 1;
      tensorMeta.set(outIds[0], { c: wShape[0], h: oh, w: ow });
    } else if (op === 'avgpool') {
      const kk = raw.k;
      tensorMeta.set(outIds[0], { c: s0.c, h: Math.floor(s0.h / kk), w: Math.floor(s0.w / kk) });
    } else if (op === 'concat') {
      let cSum = 0;
      for (const id of inIds) cSum += tensorMeta.get(id).c;
      tensorMeta.set(outIds[0], { c: cSum, h: s0.h, w: s0.w });
    } else if (op === 'slice') {
      tensorMeta.set(outIds[0], { c: raw.b - raw.a, h: s0.h, w: s0.w });
    } else if (op === 'zeros') {
      tensorMeta.set(outIds[0], { c: raw.ch, h: s0.h, w: s0.w });
    } else if (op === 'zeros_like' || op === 'scale' || op === 'neg' || op === 'mul_t' || op === 'affine_out' || op === 'clamp' || op === 'add' || op === 'mul' || op === 'warp' || op === 'film_modulate') {
      tensorMeta.set(outIds[0], { c: s0.c, h: s0.h, w: s0.w });
    } else if (op === 'luma' || op === 'luma_grad') {
      tensorMeta.set(outIds[0], { c: 1, h: s0.h, w: s0.w });
    } else if (op === 'sad_volume') {
      const span = 2 * raw.radius + 1;
      tensorMeta.set(outIds[0], { c: span * span, h: s0.h, w: s0.w });
    } else if (op === 'film_mlp') {
      const b2Shape = modelData.shapes.get(raw.w[3]);
      tensorMeta.set(outIds[0], { c: b2Shape[0], h: 1, w: 1 });
    } else if (op === 'convex_upsample') {
      const sx = tensorMeta.get(inIds[1]);
      tensorMeta.set(outIds[0], { c: sx.c, h: sx.h * 2, w: sx.w * 2 });
    } else if (op === 'blend_weights') {
      tensorMeta.set(outIds[0], { c: 1, h: s0.h, w: s0.w });
      tensorMeta.set(outIds[1], { c: 1, h: s0.h, w: s0.w });
    } else if (op === 'render_pix') {
      tensorMeta.set(outIds[0], { c: 3, h: workH, w: workW });
    } else if (op === 'render_sr') {
      const sc = raw.scale || modelData.meta.scale || 2;
      tensorMeta.set(outIds[0], { c: 3, h: workH * sc, w: workW * sc });
    } else {
      throw new Error(`Unsupported graph op: ${op}`);
    }

    steps.push({ ...raw, stage, inIds, outIds });
  }

  return {
    task: isSr ? 'sr' : 'interp',
    pairSteps: steps.filter((s) => s.stage === 'pair'),
    midSteps: steps.filter((s) => s.stage === 'mid'),
    tensorMeta,
    finalIds: {
      flow_tq: nameToId.get('flow_tq'),
      vis_tq: nameToId.get('vis_tq'),
      R_t: nameToId.get('R_t'),
      delta_lr: nameToId.get('delta_lr'),
      render: nameToId.get('render'),
    },
  };
}

/** Evaluate FiLM 2-layer ReLU MLP on CPU (64 hidden units, takes <2 microseconds). */
export function evalFilmMlp(modelData, wNames, t) {
  const w1 = modelData.weightsF32.get(wNames[0]); // [64, 1]
  const b1 = modelData.weightsF32.get(wNames[1]); // [64]
  const w2 = modelData.weightsF32.get(wNames[2]); // [2*cr, 64]
  const b2 = modelData.weightsF32.get(wNames[3]); // [2*cr]
  const hidden = b1.length;
  const h = new Float32Array(hidden);
  for (let i = 0; i < hidden; i++) {
    const v = w1[i] * t + b1[i];
    h[i] = v > 0 ? v : 0;
  }
  const outDim = b2.length;
  const out = new Float32Array(outDim);
  for (let o = 0; o < outDim; o++) {
    let acc = b2[o];
    const row = o * hidden;
    for (let i = 0; i < hidden; i++) acc += w2[row + i] * h[i];
    out[o] = acc;
  }
  return out;
}

/** Round up dimension to multiple of 32. */
export function align32(n) {
  return Math.ceil(n / 32) * 32;
}
