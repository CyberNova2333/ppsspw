// SPDX-License-Identifier: AGPL-3.0-only
// Additional Terms: see LICENSE-ADDITIONAL_TERMS-zh-CN.md (v1.6.7-r4)
/**
 * FrameFlow WebGL2 Fragment-Shader Backend (zero dependencies, ~99% browser support).
 *
 * Executes the exact FrameFlow graph.json + model.json + model.bin format using:
 *   - RGBA16F TEXTURE_2D_ARRAY tensors (4 channels packed per layer, hardware CLAMP_TO_EDGE)
 *   - MRT drawBuffers (4 output layers = 16 channels per conv pass, 4x input texture reuse)
 *   - Top-down texel coordinate convention (y=0 at top, matching PyTorch & WebGPU 1:1)
 *   - Optional shared WebGL2RenderingContext for zero-copy PPSSPW integration
 */
import { align32, compilePlan, evalFilmMlp, parseModel } from './loader.js';

const VS_QUAD = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

// Ingest RGBA source texture into workW x workH BGR tensor:
// - If workSize < srcSize (internal downscale), antialiased triangle downsample
// - Otherwise 1:1 replicate-pad to multiple of 32
const FS_TEX_IN = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
uniform ivec2 uWorkSize;
uniform int uFlipSrcY;
out vec4 o0;
vec3 fetchSrc(int x, int y) {
  int sx = clamp(x, 0, uSrcSize.x - 1);
  int sy = clamp(y, 0, uSrcSize.y - 1);
  if (uFlipSrcY != 0) sy = (uSrcSize.y - 1) - sy;
  return texelFetch(uSrc, ivec2(sx, sy), 0).rgb;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uWorkSize.x >= uSrcSize.x && uWorkSize.y >= uSrcSize.y) {
    vec3 c = fetchSrc(p.x, p.y);
    o0 = vec4(c.b, c.g, c.r, 0.0);
    return;
  }
  float sh = float(uSrcSize.y) / float(uWorkSize.y);
  float sw = float(uSrcSize.x) / float(uWorkSize.x);
  float fsh = max(sh, 1.0);
  float fsw = max(sw, 1.0);
  float cy = (float(p.y) + 0.5) * sh;
  float cx = (float(p.x) + 0.5) * sw;
  int ymin = max(0, int(floor(cy - fsh + 0.5)));
  int ymax = min(uSrcSize.y, int(floor(cy + fsh + 0.5)));
  int xmin = max(0, int(floor(cx - fsw + 0.5)));
  int xmax = min(uSrcSize.x, int(floor(cx + fsw + 0.5)));
  vec3 acc = vec3(0.0);
  float norm = 0.0;
  for (int y = ymin; y < ymax; y++) {
    float wy = max(0.0, 1.0 - abs((float(y) + 0.5 - cy) / fsh));
    for (int x = xmin; x < xmax; x++) {
      float wx = max(0.0, 1.0 - abs((float(x) + 0.5 - cx) / fsw));
      float w = wx * wy;
      acc += fetchSrc(x, y) * w;
      norm += w;
    }
  }
  vec3 c = acc / max(norm, 1e-8);
  o0 = vec4(c.b, c.g, c.r, 0.0);
}
`;

// Antialiased or plain bilinear resize (align_corners=False) matching interp.wgsl
const FS_INTERP = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uIn;
uniform ivec2 uInSize;
uniform ivec2 uOutSize;
uniform int uAA;
uniform int uLayer;
out vec4 o0;
void main() {
  ivec2 op = ivec2(gl_FragCoord.xy);
  float sh = float(uInSize.y) / float(uOutSize.y);
  float sw = float(uInSize.x) / float(uOutSize.x);
  if (uAA == 0) {
    float iy = (float(op.y) + 0.5) * sh - 0.5;
    float ix = (float(op.x) + 0.5) * sw - 0.5;
    int y0 = int(floor(iy));
    int x0 = int(floor(ix));
    float fy = iy - float(y0);
    float fx = ix - float(x0);
    int y0c = clamp(y0, 0, uInSize.y - 1);
    int y1c = clamp(y0 + 1, 0, uInSize.y - 1);
    int x0c = clamp(x0, 0, uInSize.x - 1);
    int x1c = clamp(x0 + 1, 0, uInSize.x - 1);
    vec4 v00 = texelFetch(uIn, ivec3(x0c, y0c, uLayer), 0);
    vec4 v01 = texelFetch(uIn, ivec3(x1c, y0c, uLayer), 0);
    vec4 v10 = texelFetch(uIn, ivec3(x0c, y1c, uLayer), 0);
    vec4 v11 = texelFetch(uIn, ivec3(x1c, y1c, uLayer), 0);
    o0 = mix(mix(v00, v01, fx), mix(v10, v11, fx), fy);
  } else {
    float fsh = max(sh, 1.0);
    float fsw = max(sw, 1.0);
    float cy = (float(op.y) + 0.5) * sh;
    float cx = (float(op.x) + 0.5) * sw;
    int ymin = max(0, int(floor(cy - fsh + 0.5)));
    int ymax = min(uInSize.y, int(floor(cy + fsh + 0.5)));
    int xmin = max(0, int(floor(cx - fsw + 0.5)));
    int xmax = min(uInSize.x, int(floor(cx + fsw + 0.5)));
    vec4 acc = vec4(0.0);
    float norm = 0.0;
    for (int y = ymin; y < ymax; y++) {
      float wy = max(0.0, 1.0 - abs((float(y) + 0.5 - cy) / fsh));
      for (int x = xmin; x < xmax; x++) {
        float wx = max(0.0, 1.0 - abs((float(x) + 0.5 - cx) / fsw));
        float w = wx * wy;
        acc += texelFetch(uIn, ivec3(x, y, uLayer), 0) * w;
        norm += w;
      }
    }
    o0 = acc / max(norm, 1e-8);
  }
}
`;

// 3x3 Conv2D (+ optional PReLU) with MRT outputting up to 4 vec4 layers (16 channels) per pass
function buildConvFS(mrtCount) {
  const outs = [];
  const accs = [];
  const inits = [];
  const inner = [];
  const epilogue = [];
  for (let m = 0; m < mrtCount; m++) {
    outs.push(`layout(location = ${m}) out vec4 o${m};`);
    accs.push(`vec4 acc${m} = texelFetch(uBiasPrelu, ivec2(uOutBase + ${m}, 0), 0);`);
    inner.push(`
      int wy${m} = (uOutBase + ${m}) * 9 + tap;
      vec4 w${m}_0 = texelFetch(uWeight, ivec2(gi4 + 0, wy${m}), 0);
      vec4 w${m}_1 = texelFetch(uWeight, ivec2(gi4 + 1, wy${m}), 0);
      vec4 w${m}_2 = texelFetch(uWeight, ivec2(gi4 + 2, wy${m}), 0);
      vec4 w${m}_3 = texelFetch(uWeight, ivec2(gi4 + 3, wy${m}), 0);
      acc${m} += vec4(dot(w${m}_0, xv), dot(w${m}_1, xv), dot(w${m}_2, xv), dot(w${m}_3, xv));
    `);
    epilogue.push(`
      vec4 sl${m} = texelFetch(uBiasPrelu, ivec2(uOutBase + ${m}, 1), 0);
      o${m} = max(acc${m}, vec4(0.0)) + min(acc${m}, vec4(0.0)) * sl${m};
    `);
  }
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
uniform sampler2DArray uIn;
uniform sampler2D uWeight;
uniform sampler2D uBiasPrelu;
uniform ivec2 uInSize;
uniform int uInGroups;
uniform int uStride;
uniform int uOutBase;
${outs.join('\n')}
void main() {
  ivec2 op = ivec2(gl_FragCoord.xy);
  int iy0 = op.y * uStride - 1;
  int ix0 = op.x * uStride - 1;
  ${accs.join('\n  ')}
  for (int ky = 0; ky < 3; ky++) {
    int sy = iy0 + ky;
    if (sy < 0 || sy >= uInSize.y) continue;
    for (int kx = 0; kx < 3; kx++) {
      int sx = ix0 + kx;
      if (sx < 0 || sx >= uInSize.x) continue;
      int tap = ky * 3 + kx;
      for (int gi = 0; gi < uInGroups; gi++) {
        vec4 xv = texelFetch(uIn, ivec3(sx, sy, gi), 0);
        int gi4 = gi * 4;
        ${inner.join('\n')}
      }
    }
  }
  ${epilogue.join('\n  ')}
}
`;
}

const FS_AVGPOOL = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uIn;
uniform int uK;
uniform int uLayer;
out vec4 o0;
void main() {
  ivec2 op = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  for (int ky = 0; ky < 4; ky++) {
    if (ky >= uK) break;
    for (int kx = 0; kx < 4; kx++) {
      if (kx >= uK) break;
      acc += texelFetch(uIn, ivec3(op.x * uK + kx, op.y * uK + ky, uLayer), 0);
    }
  }
  o0 = acc / float(uK * uK);
}
`;

// General channel gather for concat / slice (up to 8 input tensors, handles arbitrary unaligned channel offsets)
const FS_GATHER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uT0;
uniform sampler2DArray uT1;
uniform sampler2DArray uT2;
uniform sampler2DArray uT3;
uniform sampler2DArray uT4;
uniform sampler2DArray uT5;
uniform sampler2DArray uT6;
uniform sampler2DArray uT7;
uniform ivec4 uSpec0; // (srcIdx, layer, comp, valid)
uniform ivec4 uSpec1;
uniform ivec4 uSpec2;
uniform ivec4 uSpec3;
out vec4 o0;
float pick(ivec2 p, ivec4 sp) {
  if (sp.w == 0) return 0.0;
  vec4 v = vec4(0.0);
  int idx = sp.x;
  ivec3 c = ivec3(p, sp.y);
  if (idx == 0) v = texelFetch(uT0, c, 0);
  else if (idx == 1) v = texelFetch(uT1, c, 0);
  else if (idx == 2) v = texelFetch(uT2, c, 0);
  else if (idx == 3) v = texelFetch(uT3, c, 0);
  else if (idx == 4) v = texelFetch(uT4, c, 0);
  else if (idx == 5) v = texelFetch(uT5, c, 0);
  else if (idx == 6) v = texelFetch(uT6, c, 0);
  else v = texelFetch(uT7, c, 0);
  return v[sp.z];
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o0 = vec4(pick(p, uSpec0), pick(p, uSpec1), pick(p, uSpec2), pick(p, uSpec3));
}
`;

const FS_UNARY = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uIn;
uniform int uLayer;
uniform int uOp; // 0=scale(*uA), 1=clamp(uA,uB), 2=affine_out(2*sigmoid-1), 3=neg
uniform float uA;
uniform float uB;
uniform vec4 uMask; // 1.0 for active channels, 0.0 for padded lanes
out vec4 o0;
void main() {
  vec4 v = texelFetch(uIn, ivec3(ivec2(gl_FragCoord.xy), uLayer), 0);
  vec4 r;
  if (uOp == 0) r = v * uA;
  else if (uOp == 1) r = clamp(v, uA, uB);
  else if (uOp == 2) r = 2.0 / (1.0 + exp(-v)) - 1.0;
  else r = -v;
  o0 = r * uMask;
}
`;

const FS_BINARY = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uA;
uniform sampler2DArray uB;
uniform int uLayer;
uniform int uOp;        // 0=add, 1=mul
uniform int uBroadcast; // 1 if uB is 1-channel broadcast
out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uA, ivec3(p, uLayer), 0);
  vec4 b = uBroadcast != 0
    ? vec4(texelFetch(uB, ivec3(p, 0), 0).x)
    : texelFetch(uB, ivec3(p, uLayer), 0);
  o0 = (uOp == 0) ? (a + b) : (a * b);
}
`;

const FS_LUMA = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uIn; // BGR in layer 0
uniform ivec2 uSize;
uniform int uGrad;
out vec4 o0;
float lum(ivec2 p) {
  vec3 bgr = texelFetch(uIn, ivec3(p, 0), 0).rgb;
  return 0.114 * bgr.x + 0.587 * bgr.y + 0.299 * bgr.z;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float c = lum(p);
  if (uGrad == 0) {
    o0 = vec4(c, 0.0, 0.0, 0.0);
  } else {
    float gx = (p.x + 1 < uSize.x) ? (lum(ivec2(p.x + 1, p.y)) - c) : 0.0;
    float gy = (p.y + 1 < uSize.y) ? (lum(ivec2(p.x, p.y + 1)) - c) : 0.0;
    o0 = vec4(abs(gx) + abs(gy), 0.0, 0.0, 0.0);
  }
}
`;

// Exact luma SAD volume matching sad.wgsl (packs 4 displacement channels per layer)
const FS_SAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uLa;
uniform sampler2DArray uLb;
uniform ivec2 uSize;
uniform int uRadius;
uniform int uSpan;
uniform int uChanBase;
uniform int uTotalCh;
out vec4 o0;
float calcSad(ivec2 p, int c) {
  if (c >= uTotalCh) return 0.0;
  int dy = (c / uSpan) - uRadius;
  int dx = (c % uSpan) - uRadius;
  float acc = 0.0;
  for (int wy = -1; wy <= 1; wy++) {
    int yy = p.y + wy;
    if (yy < 0 || yy >= uSize.y) continue;
    int syy = clamp(yy + dy, 0, uSize.y - 1);
    for (int wx = -1; wx <= 1; wx++) {
      int xx = p.x + wx;
      if (xx < 0 || xx >= uSize.x) continue;
      int sxx = clamp(xx + dx, 0, uSize.x - 1);
      float la = texelFetch(uLa, ivec3(xx, yy, 0), 0).x;
      float lb = texelFetch(uLb, ivec3(sxx, syy, 0), 0).x;
      acc += abs(la - lb);
    }
  }
  return acc / 9.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o0 = vec4(
    calcSad(p, uChanBase + 0),
    calcSad(p, uChanBase + 1),
    calcSad(p, uChanBase + 2),
    calcSad(p, uChanBase + 3)
  );
}
`;

// Bilinear backward warp matching warp.wgsl exactly
const FS_WARP = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uImg;
uniform sampler2DArray uFlow;
uniform ivec2 uSize;
uniform int uLayer;
out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 fl = texelFetch(uFlow, ivec3(p, 0), 0).xy;
  float gx = float(p.x) + fl.x;
  float gy = float(p.y) + fl.y;
  int x0 = int(floor(gx));
  int y0 = int(floor(gy));
  float ax = gx - float(x0);
  float ay = gy - float(y0);
  int x0c = clamp(x0, 0, uSize.x - 1);
  int x1c = clamp(x0 + 1, 0, uSize.x - 1);
  int y0c = clamp(y0, 0, uSize.y - 1);
  int y1c = clamp(y0 + 1, 0, uSize.y - 1);
  vec4 v00 = texelFetch(uImg, ivec3(x0c, y0c, uLayer), 0);
  vec4 v01 = texelFetch(uImg, ivec3(x1c, y0c, uLayer), 0);
  vec4 v10 = texelFetch(uImg, ivec3(x0c, y1c, uLayer), 0);
  vec4 v11 = texelFetch(uImg, ivec3(x1c, y1c, uLayer), 0);
  o0 = mix(mix(v00, v01, ax), mix(v10, v11, ax), ay);
}
`;

// FiLM modulation: out = h * (1 + sc) + bi
const FS_FILM_MOD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uH;
uniform int uLayer;
uniform vec4 uScale;
uniform vec4 uBias;
out vec4 o0;
void main() {
  vec4 h = texelFetch(uH, ivec3(ivec2(gl_FragCoord.xy), uLayer), 0);
  o0 = h * (vec4(1.0) + uScale) + uBias;
}
`;

// Convex 2x upsample matching convex.wgsl exactly
const FS_CONVEX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uWt; // 36 channels = 9 layers, ch = k9*4 + sy*2 + sx
uniform sampler2DArray uX;
uniform ivec2 uInSize;
uniform int uLayer;
out vec4 o0;
void main() {
  ivec2 op = ivec2(gl_FragCoord.xy);
  int ih = op.y / 2;
  int iw = op.x / 2;
  int sub = (op.y % 2) * 2 + (op.x % 2);
  float ws[9];
  float m = -1e30;
  for (int k = 0; k < 9; k++) {
    // Since ch = k*4 + sub, layer == k and component == sub!
    float v = texelFetch(uWt, ivec3(iw, ih, k), 0)[sub];
    ws[k] = v;
    m = max(m, v);
  }
  float denom = 0.0;
  for (int k = 0; k < 9; k++) {
    ws[k] = exp(ws[k] - m);
    denom += ws[k];
  }
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 9; k++) {
    int ky = k / 3;
    int kx = k % 3;
    int ny = ih - 1 + ky;
    int nx = iw - 1 + kx;
    if (ny >= 0 && ny < uInSize.y && nx >= 0 && nx < uInSize.x) {
      acc += (ws[k] / denom) * texelFetch(uX, ivec3(nx, ny, uLayer), 0);
    }
  }
  o0 = acc;
}
`;

// Visibility blend weights matching blend.wgsl
const FS_BLEND_W = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uVis; // 3 logits in layer 0 (.xyz)
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  vec3 v = texelFetch(uVis, ivec3(ivec2(gl_FragCoord.xy), 0), 0).xyz;
  float m = max(v.x, max(v.y, v.z));
  vec3 e = exp(v - vec3(m));
  vec3 p = e / (e.x + e.y + e.z);
  oA = vec4(p.x + 0.5 * p.z, 0.0, 0.0, 0.0);
  oB = vec4(p.y + 0.5 * p.z, 0.0, 0.0, 0.0);
}
`;

// Full-resolution fused render_pix matching render.wgsl (bicubic / bilinear + still HUD guard, outputs RGB RGBA8/F16)
const FS_RENDER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
uniform sampler2D uSrcA;     // Original full-res RGBA8/F16 input texture A (RGB)
uniform sampler2D uSrcB;     // Original full-res RGBA8/F16 input texture B (RGB)
uniform sampler2DArray uFlow; // flow_tq [4, hq, wq]
uniform sampler2DArray uVis;  // vis_tq  [3, hq, wq]
uniform sampler2DArray uRes;  // R_t     [3, hq, wq] (BGR!)
uniform ivec2 uOutSize;      // Full output (W, H)
uniform ivec2 uSrcSize;      // Full source (W, H)
uniform ivec2 uQSize;        // Quarter-res (wq, hq)
uniform vec2 uFlowScale;     // (outW / workW, outH / workH)
uniform int uCubic;
uniform int uStillGuard;
uniform int uFlipSrcY;
out vec4 o0;

vec3 fetchSrcA(int x, int y) {
  int cx = clamp(x, 0, uSrcSize.x - 1);
  int cy = clamp(y, 0, uSrcSize.y - 1);
  if (uFlipSrcY != 0) cy = (uSrcSize.y - 1) - cy;
  return texelFetch(uSrcA, ivec2(cx, cy), 0).rgb;
}
vec3 fetchSrcB(int x, int y) {
  int cx = clamp(x, 0, uSrcSize.x - 1);
  int cy = clamp(y, 0, uSrcSize.y - 1);
  if (uFlipSrcY != 0) cy = (uSrcSize.y - 1) - cy;
  return texelFetch(uSrcB, ivec2(cx, cy), 0).rgb;
}

float cub1(float x) { float a = -0.75; return ((a + 2.0) * x - (a + 3.0)) * x * x + 1.0; }
float cub2(float x) { float a = -0.75; return ((a * x - 5.0 * a) * x + 8.0 * a) * x - 4.0 * a; }
vec4 cubw(float t) { return vec4(cub2(t + 1.0), cub1(t), cub1(1.0 - t), cub2(2.0 - t)); }

vec3 sampleA(float gx, float gy) {
  int px = int(floor(gx));
  int py = int(floor(gy));
  float fx = gx - float(px);
  float fy = gy - float(py);
  if (uCubic == 0) {
    vec3 v00 = fetchSrcA(px, py);
    vec3 v01 = fetchSrcA(px + 1, py);
    vec3 v10 = fetchSrcA(px, py + 1);
    vec3 v11 = fetchSrcA(px + 1, py + 1);
    return mix(mix(v00, v01, fx), mix(v10, v11, fx), fy);
  }
  vec4 cx = cubw(fx);
  vec4 cy = cubw(fy);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    int yy = py - 1 + j;
    vec3 row = fetchSrcA(px - 1, yy) * cx.x + fetchSrcA(px, yy) * cx.y
             + fetchSrcA(px + 1, yy) * cx.z + fetchSrcA(px + 2, yy) * cx.w;
    acc += row * cy[j];
  }
  return acc;
}

vec3 sampleB(float gx, float gy) {
  int px = int(floor(gx));
  int py = int(floor(gy));
  float fx = gx - float(px);
  float fy = gy - float(py);
  if (uCubic == 0) {
    vec3 v00 = fetchSrcB(px, py);
    vec3 v01 = fetchSrcB(px + 1, py);
    vec3 v10 = fetchSrcB(px, py + 1);
    vec3 v11 = fetchSrcB(px + 1, py + 1);
    return mix(mix(v00, v01, fx), mix(v10, v11, fx), fy);
  }
  vec4 cx = cubw(fx);
  vec4 cy = cubw(fy);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    int yy = py - 1 + j;
    vec3 row = fetchSrcB(px - 1, yy) * cx.x + fetchSrcB(px, yy) * cx.y
             + fetchSrcB(px + 1, yy) * cx.z + fetchSrcB(px + 2, yy) * cx.w;
    acc += row * cy[j];
  }
  return acc;
}

vec4 sampleQ(sampler2DArray tex, int x0, int x1, int y0, int y1, float fx, float fy) {
  vec4 v00 = texelFetch(tex, ivec3(x0, y0, 0), 0);
  vec4 v01 = texelFetch(tex, ivec3(x1, y0, 0), 0);
  vec4 v10 = texelFetch(tex, ivec3(x0, y1, 0), 0);
  vec4 v11 = texelFetch(tex, ivec3(x1, y1, 0), 0);
  return mix(mix(v00, v01, fx), mix(v10, v11, fx), fy);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float sh = float(uQSize.y) / float(uOutSize.y);
  float sw = float(uQSize.x) / float(uOutSize.x);
  float iy = (float(p.y) + 0.5) * sh - 0.5;
  float ix = (float(p.x) + 0.5) * sw - 0.5;
  int qy0 = int(floor(iy));
  int qx0 = int(floor(ix));
  float qfy = iy - float(qy0);
  float qfx = ix - float(qx0);
  int qy0c = clamp(qy0, 0, uQSize.y - 1);
  int qy1c = clamp(qy0 + 1, 0, uQSize.y - 1);
  int qx0c = clamp(qx0, 0, uQSize.x - 1);
  int qx1c = clamp(qx0 + 1, 0, uQSize.x - 1);

  vec4 fl = sampleQ(uFlow, qx0c, qx1c, qy0c, qy1c, qfx, qfy);
  fl.xz *= uFlowScale.x;
  fl.yw *= uFlowScale.y;

  vec3 vis = sampleQ(uVis, qx0c, qx1c, qy0c, qy1c, qfx, qfy).xyz;
  float vm = max(vis.x, max(vis.y, vis.z));
  vec3 ve = exp(vis - vec3(vm));
  float vs = ve.x + ve.y + ve.z;
  float bwa = (ve.x + 0.5 * ve.z) / vs;
  float bwb = (ve.y + 0.5 * ve.z) / vs;

  // R_t is stored in BGR order; swizzle .zyx -> RGB!
  vec3 cr = sampleQ(uRes, qx0c, qx1c, qy0c, qy1c, qfx, qfy).zyx;

  vec3 ca = sampleA(float(p.x) + fl.x, float(p.y) + fl.y);
  vec3 cb = sampleB(float(p.x) + fl.z, float(p.y) + fl.w);
  vec3 col = ca * bwa + cb * bwb + cr;

  if (uStillGuard != 0) {
    float es = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec3 da = fetchSrcA(p.x + dx, p.y + dy);
        vec3 db = fetchSrcB(p.x + dx, p.y + dy);
        es += dot(abs(da - db), vec3(1.0));
      }
    }
    es /= 27.0;
    vec3 own = 0.5 * (fetchSrcA(p.x, p.y) + fetchSrcB(p.x, p.y));
    float ef = dot(abs(ca - cb), vec3(1.0 / 3.0));
    float stillw = clamp((ef - es) / 0.04, 0.0, 1.0) * (es < 0.03 ? 1.0 : 0.0);
    col = mix(col, own, stillw);
  }

  o0 = vec4(clamp(col, vec3(0.0), vec3(1.0)), 1.0);
}
`;

// Full-resolution 2x Super-Resolution fused render pass (bilinear baseline + PixelShuffle delta)
const FS_RENDER_SR = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
uniform sampler2D uSrc;
uniform sampler2DArray uDelta;
uniform ivec2 uSrcSize;
uniform ivec2 uOutSize;
uniform int uFlipSrcY;
out vec4 o0;

vec3 fetchSrc(int x, int y) {
  int cx = clamp(x, 0, uSrcSize.x - 1);
  int cy = clamp(y, 0, uSrcSize.y - 1);
  if (uFlipSrcY != 0) cy = (uSrcSize.y - 1) - cy;
  return texelFetch(uSrc, ivec2(cx, cy), 0).rgb;
}

float pickSub(vec4 v, int sub) {
  if (sub == 0) return v.x;
  if (sub == 1) return v.y;
  if (sub == 2) return v.z;
  return v.w;
}

void main() {
  ivec2 op = ivec2(gl_FragCoord.xy);
  float fx = (float(op.x) + 0.5) * (float(uSrcSize.x) / float(uOutSize.x)) - 0.5;
  float fy = (float(op.y) + 0.5) * (float(uSrcSize.y) / float(uOutSize.y)) - 0.5;
  int x0 = int(floor(fx));
  int y0 = int(floor(fy));
  float wx = fx - float(x0);
  float wy = fy - float(y0);
  vec3 base = mix(
    mix(fetchSrc(x0, y0), fetchSrc(x0 + 1, y0), wx),
    mix(fetchSrc(x0, y0 + 1), fetchSrc(x0 + 1, y0 + 1), wx),
    wy
  );
  ivec2 lrp = ivec2(min(op.x >> 1, uSrcSize.x - 1), min(op.y >> 1, uSrcSize.y - 1));
  int sub = (op.y & 1) * 2 + (op.x & 1);
  float db = pickSub(texelFetch(uDelta, ivec3(lrp, 0), 0), sub);
  float dg = pickSub(texelFetch(uDelta, ivec3(lrp, 1), 0), sub);
  float dr = pickSub(texelFetch(uDelta, ivec3(lrp, 2), 0), sub);
  o0 = vec4(clamp(base + vec3(dr, dg, db), vec3(0.0), vec3(1.0)), 1.0);
}
`;

// Blit top-down RGB texture to screen canvas (flips Y for display)
const FS_BLIT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 o0;
void main() {
  vec3 c = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)).rgb;
  o0 = vec4(c, 1.0);
}
`;

// Resample top-down RGB texture into an FBO target preserving top-down memory layout
const FS_COPY = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 o0;
void main() {
  o0 = vec4(texture(uTex, vUv).rgb, 1.0);
}
`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`WebGL2 shader compile error:\n${log}\n---\n${src.slice(0, 400)}`);
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`WebGL2 program link error:\n${log}`);
  }
  const uCache = new Map();
  return {
    prog,
    u(name) {
      if (!uCache.has(name)) uCache.set(name, gl.getUniformLocation(prog, name));
      return uCache.get(name);
    },
  };
}

function createTex2DArray(gl, w, h, layers, internalFmt = gl.RGBA16F) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internalFmt, w, h, layers);
  return { tex, w, h, layers, internalFmt };
}

function createTex2D(gl, w, h, internalFmt = gl.RGBA8, filter = gl.LINEAR) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFmt, w, h);
  return { tex, w, h, internalFmt };
}

/** Pack Conv2D weights [cout, cin, 3, 3] into RGBA16F TEXTURE_2D of size (G_in*4, G_out*9). */
function uploadConvWeights(gl, wF32, bF32, preluF32, shape) {
  const [cout, cin] = shape;
  const gIn = Math.ceil(cin / 4);
  const gOut = Math.ceil(cout / 4);
  const tw = gIn * 4;
  const th = gOut * 9;
  const packed = new Float32Array(tw * th * 4);

  for (let oc = 0; oc < cout; oc++) {
    const go = oc >> 2;
    const laneO = oc & 3;
    for (let ic = 0; ic < cin; ic++) {
      const gi = ic >> 2;
      const laneI = ic & 3;
      const baseSrc = (oc * cin + ic) * 9;
      for (let tap = 0; tap < 9; tap++) {
        const wy = go * 9 + tap;
        const wx = gi * 4 + laneO;
        packed[(wy * tw + wx) * 4 + laneI] = wF32[baseSrc + tap];
      }
    }
  }

  const wTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, wTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.FLOAT, packed);

  // Bias (row 0) + PReLU slope (row 1; 1.0 when no activation)
  const bp = new Float32Array(gOut * 2 * 4);
  for (let oc = 0; oc < cout; oc++) {
    const go = oc >> 2;
    const lane = oc & 3;
    bp[go * 4 + lane] = bF32[oc];
    bp[(gOut + go) * 4 + lane] = preluF32 ? preluF32[oc] : 1.0;
  }
  const bpTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, bpTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gOut, 2, 0, gl.RGBA, gl.FLOAT, bp);

  return { wTex, bpTex, gIn, gOut, cin, cout };
}

export function probeWebGL2(canvasOrGl = null) {
  let gl = canvasOrGl && typeof canvasOrGl.createTexture === 'function' ? canvasOrGl : null;
  let owned = false;
  if (!gl) {
    const cv = canvasOrGl || (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas'));
    gl = cv.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    owned = true;
  }
  if (!gl) return { supported: false, reason: 'WebGL2 unavailable' };
  const extFloat = gl.getExtension('EXT_color_buffer_float');
  const extHalf = gl.getExtension('EXT_color_buffer_half_float');
  const ok = !!(extFloat || extHalf);
  const maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
  const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  if (owned) gl.getExtension('WEBGL_lose_context')?.loseContext();
  return {
    supported: ok,
    reason: ok ? null : 'Missing EXT_color_buffer_float / EXT_color_buffer_half_float',
    colorBufferFloat: !!extFloat,
    colorBufferHalfFloat: !!extHalf,
    maxDrawBuffers,
    maxTexSize,
    maxArrayLayers,
    renderer,
  };
}

export class WebGL2Engine {
  constructor(gl, canvas, ownsContext, caps) {
    this.backend = 'webgl2';
    this.gl = gl;
    this.canvas = canvas;
    this.ownsContext = ownsContext;
    this.caps = caps;
    this.fbo = gl.createFramebuffer();
    this.vao = gl.createVertexArray();
    this.programs = {
      texIn: createProgram(gl, VS_QUAD, FS_TEX_IN),
      interp: createProgram(gl, VS_QUAD, FS_INTERP),
      conv1: createProgram(gl, VS_QUAD, buildConvFS(1)),
      conv2: createProgram(gl, VS_QUAD, buildConvFS(2)),
      conv3: createProgram(gl, VS_QUAD, buildConvFS(3)),
      conv4: createProgram(gl, VS_QUAD, buildConvFS(4)),
      avgpool: createProgram(gl, VS_QUAD, FS_AVGPOOL),
      gather: createProgram(gl, VS_QUAD, FS_GATHER),
      unary: createProgram(gl, VS_QUAD, FS_UNARY),
      binary: createProgram(gl, VS_QUAD, FS_BINARY),
      luma: createProgram(gl, VS_QUAD, FS_LUMA),
      sad: createProgram(gl, VS_QUAD, FS_SAD),
      warp: createProgram(gl, VS_QUAD, FS_WARP),
      filmMod: createProgram(gl, VS_QUAD, FS_FILM_MOD),
      convex: createProgram(gl, VS_QUAD, FS_CONVEX),
      blendW: createProgram(gl, VS_QUAD, FS_BLEND_W),
      render: createProgram(gl, VS_QUAD, FS_RENDER),
      renderSr: createProgram(gl, VS_QUAD, FS_RENDER_SR),
      blit: createProgram(gl, VS_QUAD, FS_BLIT),
      copy: createProgram(gl, VS_QUAD, FS_COPY),
    };
    this.models = new Set();
  }

  static async create(options = {}) {
    let gl = options.gl || null;
    let canvas = options.canvas || null;
    let ownsContext = false;
    if (!gl) {
      if (!canvas) {
        canvas = typeof document !== 'undefined'
          ? document.createElement('canvas')
          : new OffscreenCanvas(16, 16);
      }
      gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: options.powerPreference || 'high-performance',
      });
      ownsContext = true;
    }
    if (!gl) throw new Error('WebGL2 context creation failed');
    const extFloat = gl.getExtension('EXT_color_buffer_float');
    const extHalf = gl.getExtension('EXT_color_buffer_half_float');
    if (!extFloat && !extHalf) {
      throw new Error('WebGL2 float/half-float render targets not supported on this GPU/browser');
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const caps = {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      maxDrawBuffers: Math.min(4, gl.getParameter(gl.MAX_DRAW_BUFFERS)),
      colorBufferFloat: !!extFloat,
      colorBufferHalfFloat: !!extHalf,
      precision: 'f16',
    };
    return new WebGL2Engine(gl, canvas, ownsContext, caps);
  }

  info() {
    return {
      backend: 'webgl2',
      renderer: this.caps.renderer,
      precision: this.caps.precision,
      mrtWidth: this.caps.maxDrawBuffers,
      timestamps: false,
    };
  }

  loadModel(graph, manifest, bin) {
    const data = parseModel(graph, manifest, bin);
    const gl = this.gl;
    const convWeights = new Map();

    // Pre-upload every conv weight set once on the GPU
    const visit = (ops) => {
      for (const op of ops) {
        if ((op.op === 'conv' || op.op === 'conv2d' || op.op === 'convex_upsample') && Array.isArray(op.w)) {
          const key = op.w.join('|');
          if (!convWeights.has(key)) {
            const w = data.weightsF32.get(op.w[0]);
            const b = data.weightsF32.get(op.w[1]);
            const p = op.w[2] ? data.weightsF32.get(op.w[2]) : null;
            convWeights.set(key, uploadConvWeights(gl, w, b, p, data.shapes.get(op.w[0])));
          }
        } else if (op.op === 'repeat') {
          visit(op.body);
        }
      }
    };
    visit(data.graph.ops);

    const modelObj = {
      data,
      convWeights,
      info: () => data.info(),
      destroy: () => {
        for (const cw of convWeights.values()) {
          gl.deleteTexture(cw.wTex);
          gl.deleteTexture(cw.bpTex);
        }
        convWeights.clear();
        this.models.delete(modelObj);
      },
    };
    this.models.add(modelObj);
    return modelObj;
  }

  createSession(model, options) {
    return new WebGL2Session(this, model, options);
  }

  destroy() {
    for (const m of [...this.models]) m.destroy();
    const gl = this.gl;
    for (const p of Object.values(this.programs)) gl.deleteProgram(p.prog);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteVertexArray(this.vao);
    if (this.ownsContext) gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

class WebGL2Session {
  constructor(engine, model, options) {
    this.engine = engine;
    this.gl = engine.gl;
    this.model = model;
    this.width = options.width;
    this.height = options.height;
    this.isSr = model.data.meta.task === 'sr';
    this.scale = this.isSr ? (model.data.meta.scale || 2) : 1;
    const internal = options.internal;
    let iw = this.width;
    let ih = this.height;
    if (Array.isArray(internal)) {
      [iw, ih] = internal;
    } else if (!this.isSr && internal === 'auto' && Math.max(this.width, this.height) > 640) {
      const s = 288 / this.height;
      iw = align32(Math.round(this.width * s));
      ih = align32(Math.round(this.height * s));
    }
    this.workW = this.isSr ? iw : align32(iw);
    this.workH = this.isSr ? ih : align32(ih);
    this.outW = this.width * this.scale;
    this.outH = this.height * this.scale;
    this.k = options.k ?? model.data.meta.default_K ?? 1;
    this.stillGuard = options.stillGuard !== false;
    const samp = options.sampling || 'model';
    this.cubic = samp === 'bicubic' || (samp === 'model' && model.data.meta.render_sampling === 'bicubic');
    this.flipSrcY = !!options.flipSrcY;

    this.plan = compilePlan(model.data, this.workW, this.workH, this.k, {
      useFilm: options.useFilm !== false,
      useRefine: options.useRefine !== false,
    });

    // Allocate GPU textures for all intermediate tensors in plan
    this.tensors = new Map();
    for (const [id, meta] of this.plan.tensorMeta.entries()) {
      if (id === 't' || id === this.plan.finalIds.render) continue;
      if (meta.h === 1 && meta.w === 1 && id.startsWith('g#')) continue; // FiLM MLP vector stays on CPU
      const layers = Math.ceil(meta.c / 4);
      this.tensors.set(id, { ...createTex2DArray(this.gl, meta.w, meta.h, layers, this.gl.RGBA16F), c: meta.c });
    }
    // Convex upsample weight scratch (36 ch = 9 layers at E8 size)
    const upStep = this.plan.midSteps.find((s) => s.op === 'convex_upsample');
    if (upStep) {
      const hMeta = this.plan.tensorMeta.get(upStep.inIds[0]);
      this.convexWtTex = { ...createTex2DArray(this.gl, hMeta.w, hMeta.h, 9, this.gl.RGBA16F), c: 36 };
    }

    // Input source textures (full resolution RGBA8) and output texture (full resolution RGBA8)
    this.inputs = [];
    this.outputs = [];
    this.lastPairSlots = [0, 0];
    this.filmVec = null;
    this.filmMap = new Map();

    // Pre-allocate default 2 inputs & 1 output for simple callers
    this.addInput();
    this.addInput();
    this.addOutput();
  }

  addInput() {
    const slot = this.inputs.length;
    this.inputs.push({ texObj: createTex2D(this.gl, this.width, this.height, this.gl.RGBA8, this.gl.NEAREST), externalTex: null });
    return slot;
  }

  addOutput() {
    const slot = this.outputs.length;
    this.outputs.push(createTex2D(this.gl, this.outW, this.outH, this.gl.RGBA8, this.gl.LINEAR));
    return slot;
  }

  inputTexture(slot) {
    return this.inputs[slot].externalTex || this.inputs[slot].texObj.tex;
  }

  outputTexture(slot = 0) {
    return this.outputs[slot].tex;
  }

  /** Bind an external WebGL2 texture directly (zero-copy for same-context PPSSPW!). */
  setExternalInputTexture(slot, webglTexture) {
    this.inputs[slot].externalTex = webglTexture;
  }

  /** Upload RGBA8 Uint8Array or HTMLCanvasElement / OffscreenCanvas / ImageBitmap / HTMLVideoElement. */
  pushFrame(slot, source) {
    const gl = this.gl;
    const entry = this.inputs[slot];
    entry.externalTex = null;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) {
      gl.bindTexture(gl.TEXTURE_2D, entry.texObj.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return;
    }
    const srcW = source.videoWidth || source.width || this.width;
    const srcH = source.videoHeight || source.height || this.height;
    if (srcW === this.width && srcH === this.height) {
      gl.bindTexture(gl.TEXTURE_2D, entry.texObj.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return;
    }
    if (!entry.srcTexObj || entry.srcTexObj.w !== srcW || entry.srcTexObj.h !== srcH) {
      if (entry.srcTexObj) gl.deleteTexture(entry.srcTexObj.tex);
      entry.srcTexObj = createTex2D(gl, srcW, srcH, gl.RGBA8, gl.LINEAR);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.srcTexObj.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);

    const P = this.engine.programs.copy;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.engine.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.texObj.tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(P.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.srcTexObj.tex);
    gl.uniform1i(P.u('uTex'), 0);
    this._drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _bindLayer(texObj, layer) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.engine.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texObj.tex, 0, layer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, texObj.w, texObj.h);
  }

  _bindLayers(texObj, baseLayer, count) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.engine.fbo);
    const bufs = [];
    for (let i = 0; i < count; i++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, texObj.tex, 0, baseLayer + i);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
    gl.viewport(0, 0, texObj.w, texObj.h);
  }

  _unbindExtraAttachments(count) {
    const gl = this.gl;
    for (let i = 1; i < count; i++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, null, 0, 0);
    }
  }

  _drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.engine.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _runConv(inTex, outTex, weightKey, stride) {
    const gl = this.gl;
    const cw = this.model.convWeights.get(weightKey);
    const maxMrt = this.engine.caps.maxDrawBuffers;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, inTex.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, cw.wTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, cw.bpTex);

    for (let base = 0; base < cw.gOut; ) {
      const cnt = Math.min(maxMrt, cw.gOut - base);
      const p = this.engine.programs[`conv${cnt}`];
      gl.useProgram(p.prog);
      gl.uniform1i(p.u('uIn'), 0);
      gl.uniform1i(p.u('uWeight'), 1);
      gl.uniform1i(p.u('uBiasPrelu'), 2);
      gl.uniform2i(p.u('uInSize'), inTex.w, inTex.h);
      gl.uniform1i(p.u('uInGroups'), cw.gIn);
      gl.uniform1i(p.u('uStride'), stride);
      gl.uniform1i(p.u('uOutBase'), base);
      this._bindLayers(outTex, base, cnt);
      this._drawQuad();
      this._unbindExtraAttachments(cnt);
      base += cnt;
    }
  }

  _execStep(step, tVal) {
    const gl = this.gl;
    const P = this.engine.programs;
    const op = step.op;

    if (op === 'conv' || op === 'conv2d') {
      const inTex = this.tensors.get(step.inIds[0]);
      const outTex = this.tensors.get(step.outIds[0]);
      this._runConv(inTex, outTex, step.w.join('|'), step.stride || 1);
      return;
    }

    if (op === 'interpolate') {
      const inTex = this.tensors.get(step.inIds[0]);
      const outTex = this.tensors.get(step.outIds[0]);
      gl.useProgram(P.interp.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, inTex.tex);
      gl.uniform1i(P.interp.u('uIn'), 0);
      gl.uniform2i(P.interp.u('uInSize'), inTex.w, inTex.h);
      gl.uniform2i(P.interp.u('uOutSize'), outTex.w, outTex.h);
      gl.uniform1i(P.interp.u('uAA'), step.antialias ? 1 : 0);
      for (let l = 0; l < outTex.layers; l++) {
        gl.uniform1i(P.interp.u('uLayer'), l);
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'avgpool') {
      const inTex = this.tensors.get(step.inIds[0]);
      const outTex = this.tensors.get(step.outIds[0]);
      gl.useProgram(P.avgpool.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, inTex.tex);
      gl.uniform1i(P.avgpool.u('uIn'), 0);
      gl.uniform1i(P.avgpool.u('uK'), step.k);
      for (let l = 0; l < outTex.layers; l++) {
        gl.uniform1i(P.avgpool.u('uLayer'), l);
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'zeros' || op === 'zeros_like') {
      const outTex = this.tensors.get(step.outIds[0]);
      for (let l = 0; l < outTex.layers; l++) {
        this._bindLayer(outTex, l);
        gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      }
      return;
    }

    if (op === 'concat' || op === 'slice') {
      const outTex = this.tensors.get(step.outIds[0]);
      const inTexList = step.inIds.map((id) => this.tensors.get(id));
      // Build flat channel source map: each output ch -> [srcIdx, layer, comp]
      const map = [];
      if (op === 'concat') {
        for (let si = 0; si < inTexList.length; si++) {
          const tc = inTexList[si].c;
          for (let ch = 0; ch < tc; ch++) map.push([si, ch >> 2, ch & 3, 1]);
        }
      } else {
        for (let ch = step.a; ch < step.b; ch++) map.push([0, ch >> 2, ch & 3, 1]);
      }
      gl.useProgram(P.gather.prog);
      for (let si = 0; si < 8; si++) {
        gl.activeTexture(gl.TEXTURE0 + si);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, inTexList[Math.min(si, inTexList.length - 1)].tex);
        gl.uniform1i(P.gather.u(`uT${si}`), si);
      }
      for (let l = 0; l < outTex.layers; l++) {
        for (let k = 0; k < 4; k++) {
          const sp = map[l * 4 + k] || [0, 0, 0, 0];
          gl.uniform4i(P.gather.u(`uSpec${k}`), sp[0], sp[1], sp[2], sp[3]);
        }
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'scale' || op === 'neg' || op === 'mul_t' || op === 'affine_out' || op === 'clamp') {
      const inTex = this.tensors.get(step.inIds[0]);
      const outTex = this.tensors.get(step.outIds[0]);
      let uOp = 0;
      let uA = 1.0;
      let uB = 0.0;
      if (op === 'scale') { uOp = 0; uA = step.factor; }
      else if (op === 'mul_t') { uOp = 0; uA = step.mode === 'fwd' ? 2.0 * tVal : 2.0 * (1.0 - tVal); }
      else if (op === 'clamp') { uOp = 1; uA = step.lo; uB = step.hi; }
      else if (op === 'affine_out') { uOp = 2; }
      else { uOp = 3; }

      gl.useProgram(P.unary.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, inTex.tex);
      gl.uniform1i(P.unary.u('uIn'), 0);
      gl.uniform1i(P.unary.u('uOp'), uOp);
      gl.uniform1f(P.unary.u('uA'), uA);
      gl.uniform1f(P.unary.u('uB'), uB);
      for (let l = 0; l < outTex.layers; l++) {
        const rem = outTex.c - l * 4;
        gl.uniform4f(P.unary.u('uMask'), rem > 0 ? 1 : 0, rem > 1 ? 1 : 0, rem > 2 ? 1 : 0, rem > 3 ? 1 : 0);
        gl.uniform1i(P.unary.u('uLayer'), l);
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'add' || op === 'mul') {
      const aTex = this.tensors.get(step.inIds[0]);
      const bTex = this.tensors.get(step.inIds[1]);
      const outTex = this.tensors.get(step.outIds[0]);
      gl.useProgram(P.binary.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, aTex.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, bTex.tex);
      gl.uniform1i(P.binary.u('uA'), 0);
      gl.uniform1i(P.binary.u('uB'), 1);
      gl.uniform1i(P.binary.u('uOp'), op === 'add' ? 0 : 1);
      gl.uniform1i(P.binary.u('uBroadcast'), bTex.c === 1 && aTex.c > 1 ? 1 : 0);
      for (let l = 0; l < outTex.layers; l++) {
        gl.uniform1i(P.binary.u('uLayer'), l);
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'luma' || op === 'luma_grad') {
      const inTex = this.tensors.get(step.inIds[0]);
      const outTex = this.tensors.get(step.outIds[0]);
      gl.useProgram(P.luma.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, inTex.tex);
      gl.uniform1i(P.luma.u('uIn'), 0);
      gl.uniform2i(P.luma.u('uSize'), inTex.w, inTex.h);
      gl.uniform1i(P.luma.u('uGrad'), op === 'luma_grad' ? 1 : 0);
      this._bindLayer(outTex, 0);
      this._drawQuad();
      return;
    }

    if (op === 'sad_volume') {
      const la = this.tensors.get(step.inIds[0]);
      const lb = this.tensors.get(step.inIds[1]);
      const outTex = this.tensors.get(step.outIds[0]);
      const span = 2 * step.radius + 1;
      gl.useProgram(P.sad.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, la.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, lb.tex);
      gl.uniform1i(P.sad.u('uLa'), 0);
      gl.uniform1i(P.sad.u('uLb'), 1);
      gl.uniform2i(P.sad.u('uSize'), la.w, la.h);
      gl.uniform1i(P.sad.u('uRadius'), step.radius);
      gl.uniform1i(P.sad.u('uSpan'), span);
      gl.uniform1i(P.sad.u('uTotalCh'), outTex.c);
      for (let l = 0; l < outTex.layers; l++) {
        gl.uniform1i(P.sad.u('uChanBase'), l * 4);
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'warp') {
      const imgTex = this.tensors.get(step.inIds[0]);
      const flTex = this.tensors.get(step.inIds[1]);
      const outTex = this.tensors.get(step.outIds[0]);
      gl.useProgram(P.warp.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, imgTex.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, flTex.tex);
      gl.uniform1i(P.warp.u('uImg'), 0);
      gl.uniform1i(P.warp.u('uFlow'), 1);
      gl.uniform2i(P.warp.u('uSize'), imgTex.w, imgTex.h);
      for (let l = 0; l < outTex.layers; l++) {
        gl.uniform1i(P.warp.u('uLayer'), l);
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'film_mlp') {
      this.filmMap.set(step.outIds[0], evalFilmMlp(this.model.data, step.w, tVal));
      return;
    }

    if (op === 'film_modulate') {
      const hTex = this.tensors.get(step.inIds[0]);
      const gVec = this.filmMap.get(step.inIds[1]);
      const outTex = this.tensors.get(step.outIds[0]);
      const cr = hTex.c;
      gl.useProgram(P.filmMod.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, hTex.tex);
      gl.uniform1i(P.filmMod.u('uH'), 0);
      for (let l = 0; l < outTex.layers; l++) {
        const b = l * 4;
        gl.uniform4f(P.filmMod.u('uScale'), gVec[b] || 0, gVec[b + 1] || 0, gVec[b + 2] || 0, gVec[b + 3] || 0);
        gl.uniform4f(P.filmMod.u('uBias'), gVec[cr + b] || 0, gVec[cr + b + 1] || 0, gVec[cr + b + 2] || 0, gVec[cr + b + 3] || 0);
        gl.uniform1i(P.filmMod.u('uLayer'), l);
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'convex_upsample') {
      const hTex = this.tensors.get(step.inIds[0]);
      const xTex = this.tensors.get(step.inIds[1]);
      const outTex = this.tensors.get(step.outIds[0]);
      this._runConv(hTex, this.convexWtTex, step.w.join('|'), 1);
      gl.useProgram(P.convex.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.convexWtTex.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, xTex.tex);
      gl.uniform1i(P.convex.u('uWt'), 0);
      gl.uniform1i(P.convex.u('uX'), 1);
      gl.uniform2i(P.convex.u('uInSize'), xTex.w, xTex.h);
      for (let l = 0; l < outTex.layers; l++) {
        gl.uniform1i(P.convex.u('uLayer'), l);
        this._bindLayer(outTex, l);
        this._drawQuad();
      }
      return;
    }

    if (op === 'blend_weights') {
      const visTex = this.tensors.get(step.inIds[0]);
      const outA = this.tensors.get(step.outIds[0]);
      const outB = this.tensors.get(step.outIds[1]);
      gl.useProgram(P.blendW.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, visTex.tex);
      gl.uniform1i(P.blendW.u('uVis'), 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.engine.fbo);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, outA.tex, 0, 0);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, outB.tex, 0, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.viewport(0, 0, outA.w, outA.h);
      this._drawQuad();
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, null, 0, 0);
      return;
    }
  }

  _ingestInput(srcSlot, dstId) {
    const gl = this.gl;
    const dst = this.tensors.get(dstId);
    const P = this.engine.programs.texIn;
    gl.useProgram(P.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture(srcSlot));
    gl.uniform1i(P.u('uSrc'), 0);
    gl.uniform2i(P.u('uSrcSize'), this.width, this.height);
    gl.uniform2i(P.u('uWorkSize'), this.workW, this.workH);
    gl.uniform1i(P.u('uFlipSrcY'), this.flipSrcY ? 1 : 0);
    this._bindLayer(dst, 0);
    this._drawQuad();
  }

  pair(slotA, slotB) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    this.lastPairSlots = [slotA, slotB];
    this._ingestInput(slotA, 'A');
    this._ingestInput(slotB, 'B');
    for (const step of this.plan.pairSteps) {
      this._execStep(step, 0.5);
    }
  }

  mid(t = 0.5, outSlot = 0) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    for (const step of this.plan.midSteps) {
      if (step.op === 'render_pix') continue;
      this._execStep(step, t);
    }

    // Final full-res render_pix directly from original full-res source textures A & B!
    const [slotA, slotB] = this.lastPairSlots;
    const flowTex = this.tensors.get(this.plan.finalIds.flow_tq);
    const visTex = this.tensors.get(this.plan.finalIds.vis_tq);
    const resTex = this.tensors.get(this.plan.finalIds.R_t);
    const outTex = this.outputs[outSlot];

    const P = this.engine.programs.render;
    gl.useProgram(P.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture(slotA));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture(slotB));
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, flowTex.tex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, visTex.tex);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, resTex.tex);

    gl.uniform1i(P.u('uSrcA'), 0);
    gl.uniform1i(P.u('uSrcB'), 1);
    gl.uniform1i(P.u('uFlow'), 2);
    gl.uniform1i(P.u('uVis'), 3);
    gl.uniform1i(P.u('uRes'), 4);
    gl.uniform2i(P.u('uOutSize'), this.width, this.height);
    gl.uniform2i(P.u('uSrcSize'), this.width, this.height);
    gl.uniform2i(P.u('uQSize'), flowTex.w, flowTex.h);
    gl.uniform2f(P.u('uFlowScale'), this.width / this.workW, this.height / this.workH);
    gl.uniform1i(P.u('uCubic'), this.cubic ? 1 : 0);
    gl.uniform1i(P.u('uStillGuard'), this.stillGuard ? 1 : 0);
    gl.uniform1i(P.u('uFlipSrcY'), this.flipSrcY ? 1 : 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.engine.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex.tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.width, this.height);
    this._drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Run 2x super-resolution on `srcSlot` and store result into `outputs[outSlot]`. */
  upscale(srcSlot = 0, outSlot = 0) {
    if (!this.isSr) throw new Error('upscale() requires a super-resolution model');
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    this._ingestInput(srcSlot, 'A');
    for (const step of this.plan.pairSteps) {
      if (step.op === 'render_sr') continue;
      this._execStep(step, 0.5);
    }
    const deltaTex = this.tensors.get(this.plan.finalIds.delta_lr);
    const outTex = this.outputs[outSlot];
    const P = this.engine.programs.renderSr;
    gl.useProgram(P.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture(srcSlot));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, deltaTex.tex);
    gl.uniform1i(P.u('uSrc'), 0);
    gl.uniform1i(P.u('uDelta'), 1);
    gl.uniform2i(P.u('uSrcSize'), this.width, this.height);
    gl.uniform2i(P.u('uOutSize'), this.outW, this.outH);
    gl.uniform1i(P.u('uFlipSrcY'), this.flipSrcY ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.engine.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex.tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.outW, this.outH);
    this._drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Present an input slot or output slot onto the engine's WebGL2 display canvas. */
  present(frame) {
    const gl = this.gl;
    const tex = 'source' in frame ? this.inputTexture(frame.source) : this.outputTexture(frame.output ?? 0);
    const P = this.engine.programs.blit;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(P.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(P.u('uTex'), 0);
    this._drawQuad();
  }

  /** Read output RGBA8 pixels (testing/parity only — never call in live gameplay loop). */
  async readRgba(outSlot = 0) {
    const gl = this.gl;
    const outTex = this.outputs[outSlot];
    const pixels = new Uint8Array(this.outW * this.outH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.engine.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex.tex, 0);
    gl.readPixels(0, 0, this.outW, this.outH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixels;
  }

  finish() {
    this.gl.finish();
  }

  destroy() {
    const gl = this.gl;
    for (const t of this.tensors.values()) gl.deleteTexture(t.tex);
    this.tensors.clear();
    if (this.convexWtTex) gl.deleteTexture(this.convexWtTex.tex);
    for (const inp of this.inputs) {
      gl.deleteTexture(inp.texObj.tex);
      if (inp.srcTexObj) gl.deleteTexture(inp.srcTexObj.tex);
    }
    for (const out of this.outputs) gl.deleteTexture(out.tex);
    this.inputs = [];
    this.outputs = [];
  }
}
