// SPDX-License-Identifier: AGPL-3.0-only
// Additional Terms: see LICENSE-ADDITIONAL_TERMS-zh-CN.md (v1.6.7-r4)
/**
 * FrameFlow Pure WebGPU Compute Backend (zero WASM, zero external dependencies).
 *
 * Features:
 *   - Automatically selects f16 (`shader-f16`) when supported, seamlessly falls back to f32
 *   - Accepts an existing `GPUDevice` (`{ device }`) for zero-copy sharing with PVSSPW/Vitaslop
 *   - Encodes entire `pair()` or `mid()` stage into a single GPUCommandBuffer submission
 *   - Exact 1:1 numerical parity with PyTorch GameFINet / FrameFlowNet & FrameFlow WebGL2 backend
 */
import { align32, compilePlan, evalFilmMlp, parseModel } from './loader.js';

function makeShaders(useF16) {
  const hdr = useF16 ? 'enable f16;\nalias F = f16;\n' : 'alias F = f32;\n';

  const texIn = `${hdr}
struct P { sw: u32, sh: u32, ww: u32, wh: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<F>;
@group(0) @binding(2) var<uniform> p: P;

fn fetchSrc(x: i32, y: i32) -> vec3<f32> {
  let sx = clamp(x, 0, i32(p.sw) - 1);
  let sy = clamp(y, 0, i32(p.sh) - 1);
  return textureLoad(src, vec2<i32>(sx, sy), 0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ox = gid.x; let oy = gid.y;
  if (ox >= p.ww || oy >= p.wh) { return; }
  var c: vec3<f32>;
  if (p.ww >= p.sw && p.wh >= p.sh) {
    c = fetchSrc(i32(ox), i32(oy));
  } else {
    let sh = f32(p.sh) / f32(p.wh);
    let sw = f32(p.sw) / f32(p.ww);
    let fsh = max(sh, 1.0);
    let fsw = max(sw, 1.0);
    let cy = (f32(oy) + 0.5) * sh;
    let cx = (f32(ox) + 0.5) * sw;
    let ymin = max(0, i32(floor(cy - fsh + 0.5)));
    let ymax = min(i32(p.sh), i32(floor(cy + fsh + 0.5)));
    let xmin = max(0, i32(floor(cx - fsw + 0.5)));
    let xmax = min(i32(p.sw), i32(floor(cx + fsw + 0.5)));
    var acc = vec3<f32>(0.0);
    var norm = 0.0;
    for (var y = ymin; y < ymax; y++) {
      let wy = max(0.0, 1.0 - abs((f32(y) + 0.5 - cy) / fsh));
      for (var x = xmin; x < xmax; x++) {
        let wx = max(0.0, 1.0 - abs((f32(x) + 0.5 - cx) / fsw));
        let w = wx * wy;
        acc += fetchSrc(x, y) * w;
        norm += w;
      }
    }
    c = acc / max(norm, 1e-8);
  }
  let plane = p.ww * p.wh;
  let idx = oy * p.ww + ox;
  outp[idx] = F(c.b);
  outp[plane + idx] = F(c.g);
  outp[2u * plane + idx] = F(c.r);
}
`;

  // 4-output-channel register-blocked 3x3 Conv2D (+ optional PReLU)
  const conv3x3 = `${hdr}
struct P { cin: u32, cout: u32, ih: u32, iw: u32, oh: u32, ow: u32, stride: u32, act: u32 };
@group(0) @binding(0) var<storage, read> inp: array<F>;
@group(0) @binding(1) var<storage, read> weight: array<F>;
@group(0) @binding(2) var<storage, read> bias: array<F>;
@group(0) @binding(3) var<storage, read> prelu: array<F>;
@group(0) @binding(4) var<storage, read_write> outp: array<F>;
@group(0) @binding(5) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ox = gid.x; let oy = gid.y; let oc0 = gid.z * 4u;
  if (ox >= p.ow || oy >= p.oh || oc0 >= p.cout) { return; }
  let oc1 = min(oc0 + 1u, p.cout - 1u);
  let oc2 = min(oc0 + 2u, p.cout - 1u);
  let oc3 = min(oc0 + 3u, p.cout - 1u);

  var a0 = f32(bias[oc0]);
  var a1 = f32(bias[oc1]);
  var a2 = f32(bias[oc2]);
  var a3 = f32(bias[oc3]);

  let inPlane = p.ih * p.iw;
  let wStride = p.cin * 9u;
  let wBase0 = oc0 * wStride;
  let wBase1 = oc1 * wStride;
  let wBase2 = oc2 * wStride;
  let wBase3 = oc3 * wStride;
  let iy0 = i32(oy * p.stride) - 1;
  let ix0 = i32(ox * p.stride) - 1;

  for (var ky: i32 = 0; ky < 3; ky++) {
    let sy = iy0 + ky;
    if (sy < 0 || sy >= i32(p.ih)) { continue; }
    for (var kx: i32 = 0; kx < 3; kx++) {
      let sx = ix0 + kx;
      if (sx < 0 || sx >= i32(p.iw)) { continue; }
      let tap = u32(ky * 3 + kx);
      let spIdx = u32(sy) * p.iw + u32(sx);
      for (var ic: u32 = 0u; ic < p.cin; ic++) {
        let xv = f32(inp[ic * inPlane + spIdx]);
        let off = ic * 9u + tap;
        a0 += xv * f32(weight[wBase0 + off]);
        a1 += xv * f32(weight[wBase1 + off]);
        a2 += xv * f32(weight[wBase2 + off]);
        a3 += xv * f32(weight[wBase3 + off]);
      }
    }
  }

  if (p.act != 0u) {
    if (a0 < 0.0) { a0 *= f32(prelu[oc0]); }
    if (a1 < 0.0) { a1 *= f32(prelu[oc1]); }
    if (a2 < 0.0) { a2 *= f32(prelu[oc2]); }
    if (a3 < 0.0) { a3 *= f32(prelu[oc3]); }
  }

  let outPlane = p.oh * p.ow;
  let outIdx = oy * p.ow + ox;
  outp[oc0 * outPlane + outIdx] = F(a0);
  if (oc0 + 1u < p.cout) { outp[(oc0 + 1u) * outPlane + outIdx] = F(a1); }
  if (oc0 + 2u < p.cout) { outp[(oc0 + 2u) * outPlane + outIdx] = F(a2); }
  if (oc0 + 3u < p.cout) { outp[(oc0 + 3u) * outPlane + outIdx] = F(a3); }
}
`;

  // Shared-memory tiled stride-1 Conv2D (+ optional PReLU) reducing DRAM reads by ~20x on high-res inputs
  const conv3x3Tiled = `${hdr}
struct P { cin: u32, cout: u32, ih: u32, iw: u32, oh: u32, ow: u32, stride: u32, act: u32 };
@group(0) @binding(0) var<storage, read> inp: array<F>;
@group(0) @binding(1) var<storage, read> weight: array<F>;
@group(0) @binding(2) var<storage, read> bias: array<F>;
@group(0) @binding(3) var<storage, read> prelu: array<F>;
@group(0) @binding(4) var<storage, read_write> outp: array<F>;
@group(0) @binding(5) var<uniform> p: P;

var<workgroup> inTile: array<vec4<f32>, 100>;
var<workgroup> wTile: array<vec4<f32>, 36>;

@compute @workgroup_size(8, 8, 1)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(global_invocation_id) gid: vec3<u32>,
) {
  let ox = gid.x; let oy = gid.y; let oc0 = wid.z * 4u;
  let bx = wid.x * 8u; let by = wid.y * 8u;
  let tid = lid.y * 8u + lid.x;

  let oc1 = min(oc0 + 1u, p.cout - 1u);
  let oc2 = min(oc0 + 2u, p.cout - 1u);
  let oc3 = min(oc0 + 3u, p.cout - 1u);

  var a0 = f32(bias[oc0]);
  var a1 = f32(bias[oc1]);
  var a2 = f32(bias[oc2]);
  var a3 = f32(bias[oc3]);

  let inPlane = p.ih * p.iw;
  let wStride = p.cin * 9u;
  let baseTile = lid.y * 10u + lid.x;

  for (var icBase: u32 = 0u; icBase < p.cin; icBase += 4u) {
    for (var idx: u32 = tid; idx < 100u; idx += 64u) {
      let ty = idx / 10u;
      let tx = idx % 10u;
      let sy = i32(by + ty) - 1;
      let sx = i32(bx + tx) - 1;
      var v = vec4<f32>(0.0);
      if (sy >= 0 && sy < i32(p.ih) && sx >= 0 && sx < i32(p.iw)) {
        let sp = u32(sy) * p.iw + u32(sx);
        if (icBase + 0u < p.cin) { v.x = f32(inp[(icBase + 0u) * inPlane + sp]); }
        if (icBase + 1u < p.cin) { v.y = f32(inp[(icBase + 1u) * inPlane + sp]); }
        if (icBase + 2u < p.cin) { v.z = f32(inp[(icBase + 2u) * inPlane + sp]); }
        if (icBase + 3u < p.cin) { v.w = f32(inp[(icBase + 3u) * inPlane + sp]); }
      }
      inTile[idx] = v;
    }
    if (tid < 36u) {
      let oSlot = tid / 9u;
      let tap = tid % 9u;
      let oc = min(oc0 + oSlot, p.cout - 1u);
      let wb = oc * wStride;
      var wv = vec4<f32>(0.0);
      if (icBase + 0u < p.cin) { wv.x = f32(weight[wb + (icBase + 0u) * 9u + tap]); }
      if (icBase + 1u < p.cin) { wv.y = f32(weight[wb + (icBase + 1u) * 9u + tap]); }
      if (icBase + 2u < p.cin) { wv.z = f32(weight[wb + (icBase + 2u) * 9u + tap]); }
      if (icBase + 3u < p.cin) { wv.w = f32(weight[wb + (icBase + 3u) * 9u + tap]); }
      wTile[tid] = wv;
    }
    workgroupBarrier();

    for (var ky: u32 = 0u; ky < 3u; ky++) {
      for (var kx: u32 = 0u; kx < 3u; kx++) {
        let tap = ky * 3u + kx;
        let xv = inTile[baseTile + ky * 10u + kx];
        a0 += dot(xv, wTile[tap]);
        a1 += dot(xv, wTile[9u + tap]);
        a2 += dot(xv, wTile[18u + tap]);
        a3 += dot(xv, wTile[27u + tap]);
      }
    }
    workgroupBarrier();
  }

  if (ox >= p.ow || oy >= p.oh || oc0 >= p.cout) { return; }
  if (p.act != 0u) {
    if (a0 < 0.0) { a0 *= f32(prelu[oc0]); }
    if (a1 < 0.0) { a1 *= f32(prelu[oc1]); }
    if (a2 < 0.0) { a2 *= f32(prelu[oc2]); }
    if (a3 < 0.0) { a3 *= f32(prelu[oc3]); }
  }
  let outPlane = p.oh * p.ow;
  let outIdx = oy * p.ow + ox;
  outp[oc0 * outPlane + outIdx] = F(a0);
  if (oc0 + 1u < p.cout) { outp[(oc0 + 1u) * outPlane + outIdx] = F(a1); }
  if (oc0 + 2u < p.cout) { outp[(oc0 + 2u) * outPlane + outIdx] = F(a2); }
  if (oc0 + 3u < p.cout) { outp[(oc0 + 3u) * outPlane + outIdx] = F(a3); }
}
`;

  const interp = `${hdr}
struct P { c: u32, ih: u32, iw: u32, oh: u32, ow: u32, aa: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var<storage, read> inp: array<F>;
@group(0) @binding(1) var<storage, read_write> outp: array<F>;
@group(0) @binding(2) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ox = gid.x; let oy = gid.y; let c = gid.z;
  if (ox >= p.ow || oy >= p.oh || c >= p.c) { return; }
  let sh = f32(p.ih) / f32(p.oh);
  let sw = f32(p.iw) / f32(p.ow);
  let base = c * p.ih * p.iw;
  var val: f32;
  if (p.aa == 0u) {
    let iy = (f32(oy) + 0.5) * sh - 0.5;
    let ix = (f32(ox) + 0.5) * sw - 0.5;
    let y0 = i32(floor(iy)); let x0 = i32(floor(ix));
    let fy = iy - f32(y0); let fx = ix - f32(x0);
    let y0c = u32(clamp(y0, 0, i32(p.ih) - 1));
    let y1c = u32(clamp(y0 + 1, 0, i32(p.ih) - 1));
    let x0c = u32(clamp(x0, 0, i32(p.iw) - 1));
    let x1c = u32(clamp(x0 + 1, 0, i32(p.iw) - 1));
    let v00 = f32(inp[base + y0c * p.iw + x0c]);
    let v01 = f32(inp[base + y0c * p.iw + x1c]);
    let v10 = f32(inp[base + y1c * p.iw + x0c]);
    let v11 = f32(inp[base + y1c * p.iw + x1c]);
    val = mix(mix(v00, v01, fx), mix(v10, v11, fx), fy);
  } else {
    let fsh = max(sh, 1.0); let fsw = max(sw, 1.0);
    let cy = (f32(oy) + 0.5) * sh; let cx = (f32(ox) + 0.5) * sw;
    let ymin = max(0, i32(floor(cy - fsh + 0.5)));
    let ymax = min(i32(p.ih), i32(floor(cy + fsh + 0.5)));
    let xmin = max(0, i32(floor(cx - fsw + 0.5)));
    let xmax = min(i32(p.iw), i32(floor(cx + fsw + 0.5)));
    var acc = 0.0; var norm = 0.0;
    for (var y = ymin; y < ymax; y++) {
      let wy = max(0.0, 1.0 - abs((f32(y) + 0.5 - cy) / fsh));
      for (var x = xmin; x < xmax; x++) {
        let wx = max(0.0, 1.0 - abs((f32(x) + 0.5 - cx) / fsw));
        let w = wx * wy;
        acc += f32(inp[base + u32(y) * p.iw + u32(x)]) * w;
        norm += w;
      }
    }
    val = acc / max(norm, 1e-8);
  }
  outp[(c * p.oh + oy) * p.ow + ox] = F(val);
}
`;

  const avgpool = `${hdr}
struct P { c: u32, h: u32, w: u32, oh: u32, ow: u32, k: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var<storage, read> inp: array<F>;
@group(0) @binding(1) var<storage, read_write> outp: array<F>;
@group(0) @binding(2) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ox = gid.x; let oy = gid.y; let c = gid.z;
  if (ox >= p.ow || oy >= p.oh || c >= p.c) { return; }
  var acc = 0.0;
  let base = c * p.h * p.w;
  for (var ky: u32 = 0u; ky < p.k; ky++) {
    for (var kx: u32 = 0u; kx < p.k; kx++) {
      acc += f32(inp[base + (oy * p.k + ky) * p.w + ox * p.k + kx]);
    }
  }
  outp[(c * p.oh + oy) * p.ow + ox] = F(acc / f32(p.k * p.k));
}
`;

  const copyCh = `${hdr}
struct P { c: u32, h: u32, w: u32, srcC0: u32, dstC0: u32, _a: u32, _b: u32, _c: u32 };
@group(0) @binding(0) var<storage, read> inp: array<F>;
@group(0) @binding(1) var<storage, read_write> outp: array<F>;
@group(0) @binding(2) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y; let c = gid.z;
  if (x >= p.w || y >= p.h || c >= p.c) { return; }
  let plane = p.h * p.w;
  outp[(p.dstC0 + c) * plane + y * p.w + x] = inp[(p.srcC0 + c) * plane + y * p.w + x];
}
`;

  const unary = `${hdr}
struct P { c: u32, h: u32, w: u32, op: u32, a: f32, b: f32, _a: u32, _b: u32 };
@group(0) @binding(0) var<storage, read> inp: array<F>;
@group(0) @binding(1) var<storage, read_write> outp: array<F>;
@group(0) @binding(2) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y; let c = gid.z;
  if (x >= p.w || y >= p.h || c >= p.c) { return; }
  let i = (c * p.h + y) * p.w + x;
  let v = f32(inp[i]);
  var r: f32;
  if (p.op == 0u) { r = v * p.a; }
  else if (p.op == 1u) { r = clamp(v, p.a, p.b); }
  else if (p.op == 2u) { r = 2.0 / (1.0 + exp(-v)) - 1.0; }
  else { r = -v; }
  outp[i] = F(r);
}
`;

  const binary = `${hdr}
struct P { c: u32, h: u32, w: u32, op: u32, bcast: u32, _a: u32, _b: u32, _c: u32 };
@group(0) @binding(0) var<storage, read> a: array<F>;
@group(0) @binding(1) var<storage, read> b: array<F>;
@group(0) @binding(2) var<storage, read_write> outp: array<F>;
@group(0) @binding(3) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y; let c = gid.z;
  if (x >= p.w || y >= p.h || c >= p.c) { return; }
  let i = (c * p.h + y) * p.w + x;
  let ib = select(i, y * p.w + x, p.bcast != 0u);
  let va = f32(a[i]); let vb = f32(b[ib]);
  outp[i] = F(select(va * vb, va + vb, p.op == 0u));
}
`;

  const luma = `${hdr}
struct P { h: u32, w: u32, grad: u32, _a: u32 };
@group(0) @binding(0) var<storage, read> inp: array<F>;
@group(0) @binding(1) var<storage, read_write> outp: array<F>;
@group(0) @binding(2) var<uniform> p: P;

fn lum(y: u32, x: u32) -> f32 {
  let plane = p.h * p.w;
  let i = y * p.w + x;
  return 0.114 * f32(inp[i]) + 0.587 * f32(inp[plane + i]) + 0.299 * f32(inp[2u * plane + i]);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y;
  if (x >= p.w || y >= p.h) { return; }
  let c = lum(y, x);
  if (p.grad == 0u) {
    outp[y * p.w + x] = F(c);
  } else {
    let gx = select(0.0, lum(y, x + 1u) - c, x + 1u < p.w);
    let gy = select(0.0, lum(y + 1u, x) - c, y + 1u < p.h);
    outp[y * p.w + x] = F(abs(gx) + abs(gy));
  }
}
`;

  const sad = `${hdr}
struct P { h: u32, w: u32, radius: u32, span: u32 };
@group(0) @binding(0) var<storage, read> la: array<F>;
@group(0) @binding(1) var<storage, read> lb: array<F>;
@group(0) @binding(2) var<storage, read_write> outp: array<F>;
@group(0) @binding(3) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y; let c = gid.z;
  if (x >= p.w || y >= p.h || c >= p.span * p.span) { return; }
  let dy = i32(c / p.span) - i32(p.radius);
  let dx = i32(c % p.span) - i32(p.radius);
  let hh = i32(p.h); let ww = i32(p.w);
  var acc = 0.0;
  for (var wy: i32 = -1; wy <= 1; wy++) {
    let yy = i32(y) + wy;
    if (yy < 0 || yy >= hh) { continue; }
    let syy = u32(clamp(yy + dy, 0, hh - 1));
    for (var wx: i32 = -1; wx <= 1; wx++) {
      let xx = i32(x) + wx;
      if (xx < 0 || xx >= ww) { continue; }
      let sxx = u32(clamp(xx + dx, 0, ww - 1));
      acc += abs(f32(la[u32(yy) * p.w + u32(xx)]) - f32(lb[syy * p.w + sxx]));
    }
  }
  outp[(c * p.h + y) * p.w + x] = F(acc / 9.0);
}
`;

  const warp = `${hdr}
struct P { c: u32, h: u32, w: u32, _a: u32 };
@group(0) @binding(0) var<storage, read> img: array<F>;
@group(0) @binding(1) var<storage, read> flow: array<F>;
@group(0) @binding(2) var<storage, read_write> outp: array<F>;
@group(0) @binding(3) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y; let c = gid.z;
  if (x >= p.w || y >= p.h || c >= p.c) { return; }
  let plane = p.h * p.w;
  let fx = f32(flow[y * p.w + x]);
  let fy = f32(flow[plane + y * p.w + x]);
  let gx = f32(x) + fx; let gy = f32(y) + fy;
  let x0 = i32(floor(gx)); let y0 = i32(floor(gy));
  let ax = gx - f32(x0); let ay = gy - f32(y0);
  let x0c = u32(clamp(x0, 0, i32(p.w) - 1));
  let x1c = u32(clamp(x0 + 1, 0, i32(p.w) - 1));
  let y0c = u32(clamp(y0, 0, i32(p.h) - 1));
  let y1c = u32(clamp(y0 + 1, 0, i32(p.h) - 1));
  let base = c * plane;
  let v00 = f32(img[base + y0c * p.w + x0c]);
  let v01 = f32(img[base + y0c * p.w + x1c]);
  let v10 = f32(img[base + y1c * p.w + x0c]);
  let v11 = f32(img[base + y1c * p.w + x1c]);
  outp[base + y * p.w + x] = F(mix(mix(v00, v01, ax), mix(v10, v11, ax), ay));
}
`;

  const filmMod = `${hdr}
struct P { c: u32, h: u32, w: u32, _a: u32 };
@group(0) @binding(0) var<storage, read> hh: array<F>;
@group(0) @binding(1) var<storage, read> g: array<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<F>;
@group(0) @binding(3) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y; let c = gid.z;
  if (x >= p.w || y >= p.h || c >= p.c) { return; }
  let i = (c * p.h + y) * p.w + x;
  outp[i] = F(f32(hh[i]) * (1.0 + g[c]) + g[c + p.c]);
}
`;

  const convex = `${hdr}
struct P { c: u32, h: u32, w: u32, _a: u32 };
@group(0) @binding(0) var<storage, read> wt: array<F>;
@group(0) @binding(1) var<storage, read> x: array<F>;
@group(0) @binding(2) var<storage, read_write> outp: array<F>;
@group(0) @binding(3) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ox = gid.x; let oy = gid.y; let co = gid.z;
  if (ox >= 2u * p.w || oy >= 2u * p.h || co >= p.c) { return; }
  let ih = oy / 2u; let iw = ox / 2u;
  let sy = oy % 2u; let sx = ox % 2u;
  let plane = p.h * p.w;
  var m = -3.0e38;
  var ws: array<f32, 9>;
  for (var k: u32 = 0u; k < 9u; k++) {
    let ch = k * 4u + sy * 2u + sx;
    let v = f32(wt[(ch * p.h + ih) * p.w + iw]);
    ws[k] = v;
    m = max(m, v);
  }
  var denom = 0.0;
  for (var k: u32 = 0u; k < 9u; k++) { ws[k] = exp(ws[k] - m); denom += ws[k]; }
  var acc = 0.0;
  for (var k: u32 = 0u; k < 9u; k++) {
    let ky = i32(k / 3u); let kx = i32(k % 3u);
    let ny = i32(ih) - 1 + ky; let nx = i32(iw) - 1 + kx;
    if (ny >= 0 && ny < i32(p.h) && nx >= 0 && nx < i32(p.w)) {
      acc += (ws[k] / denom) * f32(x[co * plane + u32(ny) * p.w + u32(nx)]);
    }
  }
  outp[(co * 2u * p.h + oy) * 2u * p.w + ox] = F(acc);
}
`;

  const blendW = `${hdr}
struct P { h: u32, w: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var<storage, read> vis: array<F>;
@group(0) @binding(1) var<storage, read_write> outA: array<F>;
@group(0) @binding(2) var<storage, read_write> outB: array<F>;
@group(0) @binding(3) var<uniform> p: P;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y;
  if (x >= p.w || y >= p.h) { return; }
  let plane = p.h * p.w;
  let i = y * p.w + x;
  let a = f32(vis[i]); let b = f32(vis[plane + i]); let c = f32(vis[2u * plane + i]);
  let m = max(a, max(b, c));
  let ea = exp(a - m); let eb = exp(b - m); let ec = exp(c - m);
  let s = ea + eb + ec;
  outA[i] = F((ea + 0.5 * ec) / s);
  outB[i] = F((eb + 0.5 * ec) / s);
}
`;

  const renderTex = `${hdr}
struct P { outW: u32, outH: u32, qW: u32, qH: u32, fsx: f32, fsy: f32, cubic: u32, stillGuard: u32 };
@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> flowQ: array<F>;
@group(0) @binding(3) var<storage, read> visQ: array<F>;
@group(0) @binding(4) var<storage, read> resQ: array<F>;
@group(0) @binding(5) var dstTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var<uniform> p: P;

fn bil4(v00: f32, v01: f32, v10: f32, v11: f32, fx: f32, fy: f32) -> f32 {
  return mix(mix(v00, v01, fx), mix(v10, v11, fx), fy);
}
fn qf(ch: u32, y0: u32, y1: u32, x0: u32, x1: u32, fx: f32, fy: f32) -> f32 {
  let b = ch * p.qH * p.qW; let w = p.qW;
  let v = bil4(f32(flowQ[b + y0 * w + x0]), f32(flowQ[b + y0 * w + x1]), f32(flowQ[b + y1 * w + x0]), f32(flowQ[b + y1 * w + x1]), fx, fy);
  return v * select(p.fsy, p.fsx, (ch & 1u) == 0u);
}
fn qv(ch: u32, y0: u32, y1: u32, x0: u32, x1: u32, fx: f32, fy: f32) -> f32 {
  let b = ch * p.qH * p.qW; let w = p.qW;
  return bil4(f32(visQ[b + y0 * w + x0]), f32(visQ[b + y0 * w + x1]), f32(visQ[b + y1 * w + x0]), f32(visQ[b + y1 * w + x1]), fx, fy);
}
fn qr(ch: u32, y0: u32, y1: u32, x0: u32, x1: u32, fx: f32, fy: f32) -> f32 {
  let b = ch * p.qH * p.qW; let w = p.qW;
  return bil4(f32(resQ[b + y0 * w + x0]), f32(resQ[b + y0 * w + x1]), f32(resQ[b + y1 * w + x0]), f32(resQ[b + y1 * w + x1]), fx, fy);
}
fn cub1(x: f32) -> f32 { let a = -0.75; return ((a + 2.0) * x - (a + 3.0)) * x * x + 1.0; }
fn cub2(x: f32) -> f32 { let a = -0.75; return ((a * x - 5.0 * a) * x + 8.0 * a) * x - 4.0 * a; }
fn cubw(t: f32) -> vec4<f32> { return vec4<f32>(cub2(t + 1.0), cub1(t), cub1(1.0 - t), cub2(2.0 - t)); }

fn fetchA(x: i32, y: i32) -> vec3<f32> {
  return textureLoad(srcA, vec2<i32>(clamp(x, 0, i32(p.outW) - 1), clamp(y, 0, i32(p.outH) - 1)), 0).rgb;
}
fn fetchB(x: i32, y: i32) -> vec3<f32> {
  return textureLoad(srcB, vec2<i32>(clamp(x, 0, i32(p.outW) - 1), clamp(y, 0, i32(p.outH) - 1)), 0).rgb;
}
fn sampleA(gx: f32, gy: f32) -> vec3<f32> {
  let px = i32(floor(gx)); let py = i32(floor(gy));
  let fx = gx - f32(px); let fy = gy - f32(py);
  if (p.cubic == 0u) {
    return mix(mix(fetchA(px, py), fetchA(px + 1, py), fx), mix(fetchA(px, py + 1), fetchA(px + 1, py + 1), fx), fy);
  }
  let cx = cubw(fx); let cy = cubw(fy);
  let r0 = fetchA(px - 1, py - 1) * cx.x + fetchA(px, py - 1) * cx.y + fetchA(px + 1, py - 1) * cx.z + fetchA(px + 2, py - 1) * cx.w;
  let r1 = fetchA(px - 1, py) * cx.x + fetchA(px, py) * cx.y + fetchA(px + 1, py) * cx.z + fetchA(px + 2, py) * cx.w;
  let r2 = fetchA(px - 1, py + 1) * cx.x + fetchA(px, py + 1) * cx.y + fetchA(px + 1, py + 1) * cx.z + fetchA(px + 2, py + 1) * cx.w;
  let r3 = fetchA(px - 1, py + 2) * cx.x + fetchA(px, py + 2) * cx.y + fetchA(px + 1, py + 2) * cx.z + fetchA(px + 2, py + 2) * cx.w;
  return r0 * cy.x + r1 * cy.y + r2 * cy.z + r3 * cy.w;
}
fn sampleB(gx: f32, gy: f32) -> vec3<f32> {
  let px = i32(floor(gx)); let py = i32(floor(gy));
  let fx = gx - f32(px); let fy = gy - f32(py);
  if (p.cubic == 0u) {
    return mix(mix(fetchB(px, py), fetchB(px + 1, py), fx), mix(fetchB(px, py + 1), fetchB(px + 1, py + 1), fx), fy);
  }
  let cx = cubw(fx); let cy = cubw(fy);
  let r0 = fetchB(px - 1, py - 1) * cx.x + fetchB(px, py - 1) * cx.y + fetchB(px + 1, py - 1) * cx.z + fetchB(px + 2, py - 1) * cx.w;
  let r1 = fetchB(px - 1, py) * cx.x + fetchB(px, py) * cx.y + fetchB(px + 1, py) * cx.z + fetchB(px + 2, py) * cx.w;
  let r2 = fetchB(px - 1, py + 1) * cx.x + fetchB(px, py + 1) * cx.y + fetchB(px + 1, py + 1) * cx.z + fetchB(px + 2, py + 1) * cx.w;
  let r3 = fetchB(px - 1, py + 2) * cx.x + fetchB(px, py + 2) * cx.y + fetchB(px + 1, py + 2) * cx.z + fetchB(px + 2, py + 2) * cx.w;
  return r0 * cy.x + r1 * cy.y + r2 * cy.z + r3 * cy.w;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x; let y = gid.y;
  if (x >= p.outW || y >= p.outH) { return; }
  let sh = f32(p.qH) / f32(p.outH); let sw = f32(p.qW) / f32(p.outW);
  let iy = (f32(y) + 0.5) * sh - 0.5; let ix = (f32(x) + 0.5) * sw - 0.5;
  let qy0 = i32(floor(iy)); let qx0 = i32(floor(ix));
  let qfy = iy - f32(qy0); let qfx = ix - f32(qx0);
  let qy0c = u32(clamp(qy0, 0, i32(p.qH) - 1));
  let qy1c = u32(clamp(qy0 + 1, 0, i32(p.qH) - 1));
  let qx0c = u32(clamp(qx0, 0, i32(p.qW) - 1));
  let qx1c = u32(clamp(qx0 + 1, 0, i32(p.qW) - 1));

  let f0 = qf(0u, qy0c, qy1c, qx0c, qx1c, qfx, qfy);
  let f1 = qf(1u, qy0c, qy1c, qx0c, qx1c, qfx, qfy);
  let f2 = qf(2u, qy0c, qy1c, qx0c, qx1c, qfx, qfy);
  let f3 = qf(3u, qy0c, qy1c, qx0c, qx1c, qfx, qfy);
  let v0 = qv(0u, qy0c, qy1c, qx0c, qx1c, qfx, qfy);
  let v1 = qv(1u, qy0c, qy1c, qx0c, qx1c, qfx, qfy);
  let v2 = qv(2u, qy0c, qy1c, qx0c, qx1c, qfx, qfy);
  let vm = max(v0, max(v1, v2));
  let e0 = exp(v0 - vm); let e1 = exp(v1 - vm); let e2 = exp(v2 - vm);
  let vs = e0 + e1 + e2;
  let bwa = (e0 + 0.5 * e2) / vs;
  let bwb = (e1 + 0.5 * e2) / vs;

  // R_t is BGR -> swizzle (2, 1, 0) for RGB
  let cr = vec3<f32>(
    qr(2u, qy0c, qy1c, qx0c, qx1c, qfx, qfy),
    qr(1u, qy0c, qy1c, qx0c, qx1c, qfx, qfy),
    qr(0u, qy0c, qy1c, qx0c, qx1c, qfx, qfy)
  );
  let ca = sampleA(f32(x) + f0, f32(y) + f1);
  let cb = sampleB(f32(x) + f2, f32(y) + f32(f3));
  var col = ca * bwa + cb * bwb + cr;

  if (p.stillGuard != 0u) {
    var es = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy++) {
      for (var dx: i32 = -1; dx <= 1; dx++) {
        es += dot(abs(fetchA(i32(x) + dx, i32(y) + dy) - fetchB(i32(x) + dx, i32(y) + dy)), vec3<f32>(1.0));
      }
    }
    es /= 27.0;
    let own = 0.5 * (fetchA(i32(x), i32(y)) + fetchB(i32(x), i32(y)));
    let ef = dot(abs(ca - cb), vec3<f32>(1.0 / 3.0));
    let stillw = clamp((ef - es) / 0.04, 0.0, 1.0) * select(0.0, 1.0, es < 0.03);
    col = mix(col, own, stillw);
  }

  textureStore(dstTex, vec2<i32>(i32(x), i32(y)), vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0));
}
`;

  const renderSr = `${hdr}
struct P { inW: u32, inH: u32, outW: u32, outH: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> delta: array<F>;
@group(0) @binding(2) var dstTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> p: P;

fn fetchSrc(x: i32, y: i32) -> vec3<f32> {
  return textureLoad(src, vec2<i32>(clamp(x, 0, i32(p.inW) - 1), clamp(y, 0, i32(p.inH) - 1)), 0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ox = gid.x; let oy = gid.y;
  if (ox >= p.outW || oy >= p.outH) { return; }
  let fx = (f32(ox) + 0.5) * (f32(p.inW) / f32(p.outW)) - 0.5;
  let fy = (f32(oy) + 0.5) * (f32(p.inH) / f32(p.outH)) - 0.5;
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy));
  let wx = fx - f32(x0); let wy = fy - f32(y0);
  let base = mix(
    mix(fetchSrc(x0, y0), fetchSrc(x0 + 1, y0), wx),
    mix(fetchSrc(x0, y0 + 1), fetchSrc(x0 + 1, y0 + 1), wx),
    wy
  );
  let lry = min(oy >> 1u, p.inH - 1u);
  let lrx = min(ox >> 1u, p.inW - 1u);
  let sub = (oy & 1u) * 2u + (ox & 1u);
  let plane = p.inH * p.inW;
  let off = lry * p.inW + lrx;
  let dr = f32(delta[(8u + sub) * plane + off]);
  let dg = f32(delta[(4u + sub) * plane + off]);
  let db = f32(delta[(0u + sub) * plane + off]);
  let col = clamp(base + vec3<f32>(dr, dg, db), vec3<f32>(0.0), vec3<f32>(1.0));
  textureStore(dstTex, vec2<i32>(i32(ox), i32(oy)), vec4<f32>(col, 1.0));
}
`;

  const blit = `
struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var pos = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let q = pos[i];
  return V(vec4<f32>(q, 0.0, 1.0), vec2<f32>(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5));
}
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment fn fs(i: V) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSampleLevel(t, s, i.uv, 0.0).rgb, 1.0);
}
`;

  return { texIn, conv3x3, conv3x3Tiled, interp, avgpool, copyCh, unary, binary, luma, sad, warp, filmMod, convex, blendW, renderTex, renderSr, blit };
}

export async function probeWebGPU(powerPreference = 'high-performance') {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { supported: false, reason: 'navigator.gpu unavailable' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (!adapter) return { supported: false, reason: 'No WebGPU adapter available' };
    return {
      supported: true,
      reason: null,
      vendor: adapter.info?.vendor || '',
      architecture: adapter.info?.architecture || '',
      f16: adapter.features.has('shader-f16'),
      timestamps: adapter.features.has('timestamp-query'),
    };
  } catch (e) {
    return { supported: false, reason: String(e) };
  }
}

export class WebGPUEngine {
  constructor(device, adapterInfo, useF16, ownsDevice) {
    this.backend = 'webgpu';
    this.device = device;
    this.adapterInfo = adapterInfo;
    this.useF16 = useF16;
    this.elemBytes = useF16 ? 2 : 4;
    this.ownsDevice = ownsDevice;

    const src = makeShaders(useF16);
    const makePipe = (code) => device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    this.pipes = {
      texIn: makePipe(src.texIn),
      conv3x3: makePipe(src.conv3x3),
      conv3x3Tiled: makePipe(src.conv3x3Tiled),
      interp: makePipe(src.interp),
      avgpool: makePipe(src.avgpool),
      copyCh: makePipe(src.copyCh),
      unary: makePipe(src.unary),
      binary: makePipe(src.binary),
      luma: makePipe(src.luma),
      sad: makePipe(src.sad),
      warp: makePipe(src.warp),
      filmMod: makePipe(src.filmMod),
      convex: makePipe(src.convex),
      blendW: makePipe(src.blendW),
      renderTex: makePipe(src.renderTex),
      renderSr: makePipe(src.renderSr),
    };
    this.blitSrc = src.blit;
    this.blitPipes = new Map();
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.dummyOneBuf = this._uploadWeights(new Float32Array([1.0]), new Uint16Array([0x3c00]));
    this.models = new Set();
  }

  static async create(options = {}) {
    let device = options.device || null;
    let adapterInfo = { vendor: '', architecture: '' };
    let useF16 = false;
    let ownsDevice = false;

    if (device) {
      useF16 = options.precision === 'f32' ? false : device.features.has('shader-f16');
    } else {
      if (typeof navigator === 'undefined' || !navigator.gpu) {
        throw new Error('WebGPU unavailable');
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: options.powerPreference || 'high-performance' });
      if (!adapter) throw new Error('No WebGPU adapter found');
      adapterInfo = {
        vendor: adapter.info?.vendor || '',
        architecture: adapter.info?.architecture || '',
      };
      useF16 = options.precision !== 'f32' && adapter.features.has('shader-f16');
      const requiredFeatures = [];
      if (useF16) requiredFeatures.push('shader-f16');
      device = await adapter.requestDevice({ requiredFeatures });
      ownsDevice = true;
    }
    return new WebGPUEngine(device, adapterInfo, useF16, ownsDevice);
  }

  info() {
    return {
      backend: 'webgpu',
      vendor: this.adapterInfo.vendor,
      architecture: this.adapterInfo.architecture,
      precision: this.useF16 ? 'f16' : 'f32',
      timestamps: this.device.features.has('timestamp-query'),
    };
  }

  _uploadWeights(f32Arr, u16Arr) {
    const src = this.useF16 ? u16Arr : f32Arr;
    const byteSize = Math.max(4, Math.ceil(src.byteLength / 4) * 4);
    const buf = this.device.createBuffer({
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const padded = new Uint8Array(byteSize);
    padded.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
    this.device.queue.writeBuffer(buf, 0, padded);
    return buf;
  }

  loadModel(graph, manifest, bin) {
    const data = parseModel(graph, manifest, bin);
    const weightBufs = new Map();
    const srConvWeights = new Map();
    if (data.meta.task === 'sr') {
      const visitSr = (ops) => {
        for (const op of ops) {
          if ((op.op === 'conv' || op.op === 'conv2d') && Array.isArray(op.w)) {
            const key = op.w.join('|');
            if (!srConvWeights.has(key)) {
              const wF32 = data.weightsF32.get(op.w[0]);
              const bF32 = data.weightsF32.get(op.w[1]);
              const pF32 = op.w[2] ? data.weightsF32.get(op.w[2]) : null;
              const [cout, cin] = data.shapes.get(op.w[0]);
              const gIn = Math.ceil(cin / 4);
              const gOut = Math.ceil(cout / 4);
              const packed = new Float32Array(gOut * 9 * gIn * 4 * 4);
              for (let oc = 0; oc < cout; oc++) {
                const go = oc >> 2;
                const laneO = oc & 3;
                for (let ic = 0; ic < cin; ic++) {
                  const gi = ic >> 2;
                  const laneI = ic & 3;
                  const baseSrc = (oc * cin + ic) * 9;
                  for (let tap = 0; tap < 9; tap++) {
                    const idx = (((go * 9 + tap) * gIn + gi) * 4 + laneO) * 4 + laneI;
                    packed[idx] = wF32[baseSrc + tap];
                  }
                }
              }
              const wBuf = this.device.createBuffer({
                size: Math.max(16, packed.byteLength),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              });
              this.device.queue.writeBuffer(wBuf, 0, packed);
              srConvWeights.set(key, { wBuf, bF32, pF32, gIn, gOut, cin, cout });
            }
          }
        }
      };
      visitSr(data.graph.ops);
    } else {
      for (const [name, f32] of data.weightsF32.entries()) {
        weightBufs.set(name, this._uploadWeights(f32, data.weightsU16.get(name)));
      }
    }
    const modelObj = {
      data,
      weightBufs,
      srConvWeights,
      info: () => data.info(),
      destroy: () => {
        for (const b of weightBufs.values()) b.destroy();
        weightBufs.clear();
        for (const cw of srConvWeights.values()) cw.wBuf.destroy();
        srConvWeights.clear();
        this.models.delete(modelObj);
      },
    };
    this.models.add(modelObj);
    return modelObj;
  }

  createSession(model, options) {
    if (model.data.meta.task === 'sr') {
      return new WebGPUSrSession(this, model, options);
    }
    return new WebGPUSession(this, model, options);
  }

  _getSrPipes() {
    if (this._srPipes) return this._srPipes;
    const dev = this.device;
    const vs = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(pos[i], 0.0, 1.0);
}`;
    const texInFs = `${vs}
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let c = textureLoad(srcTex, vec2<i32>(i32(pos.x), i32(pos.y)), 0).rgb;
  return vec4<f32>(c.b, c.g, c.r, 0.0);
}`;
    const makeConvFs = (mrt) => {
      const outs = [];
      const accs = [];
      const inner = [];
      const actLines = [];
      const retLines = [];
      for (let m = 0; m < mrt; m++) {
        outs.push(`@location(${m}) o${m}: vec4<f32>,`);
        accs.push(`var acc${m} = p.bias[${m}];`);
        inner.push(`
          let wb${m} = (((p.outBase + ${m}u) * 9u + tap) * p.gIn + gi) * 4u;
          acc${m} += vec4<f32>(dot(xv, w[wb${m}]), dot(xv, w[wb${m} + 1u]), dot(xv, w[wb${m} + 2u]), dot(xv, w[wb${m} + 3u]));
        `);
        actLines.push(`if (p.act != 0u) { acc${m} = max(acc${m}, vec4<f32>(0.0)) + min(acc${m}, vec4<f32>(0.0)) * p.prelu[${m}]; }`);
        retLines.push(`out.o${m} = acc${m};`);
      }
      return `${vs}
struct P {
  inW: u32, inH: u32, gIn: u32, outBase: u32,
  act: u32, _a: u32, _b: u32, _c: u32,
  bias: array<vec4<f32>, 4>,
  prelu: array<vec4<f32>, 4>,
};
struct Out { ${outs.join('\n  ')} };
@group(0) @binding(0) var inTex: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read> w: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> p: P;
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> Out {
  let op = vec2<i32>(i32(pos.x), i32(pos.y));
  ${accs.join('\n  ')}
  for (var ky: i32 = 0; ky < 3; ky++) {
    let sy = op.y + ky - 1;
    if (sy < 0 || sy >= i32(p.inH)) { continue; }
    for (var kx: i32 = 0; kx < 3; kx++) {
      let sx = op.x + kx - 1;
      if (sx < 0 || sx >= i32(p.inW)) { continue; }
      let tap = u32(ky * 3 + kx);
      for (var gi: u32 = 0u; gi < p.gIn; gi++) {
        let xv = textureLoad(inTex, vec2<i32>(sx, sy), i32(gi), 0);
        ${inner.join('\n')}
      }
    }
  }
  ${actLines.join('\n  ')}
  var out: Out;
  ${retLines.join('\n  ')}
  return out;
}`;
    };
    const makeAddFs = (mrt) => {
      const outs = [];
      const body = [];
      for (let m = 0; m < mrt; m++) {
        outs.push(`@location(${m}) o${m}: vec4<f32>,`);
        body.push(`out.o${m} = textureLoad(ta, p, i32(u.base + ${m}u), 0) + textureLoad(tb, p, i32(u.base + ${m}u), 0);`);
      }
      return `${vs}
struct U { base: u32, _a: u32, _b: u32, _c: u32 };
struct Out { ${outs.join('\n  ')} };
@group(0) @binding(0) var ta: texture_2d_array<f32>;
@group(0) @binding(1) var tb: texture_2d_array<f32>;
@group(0) @binding(2) var<uniform> u: U;
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> Out {
  let p = vec2<i32>(i32(pos.x), i32(pos.y));
  var out: Out;
  ${body.join('\n  ')}
  return out;
}`;
    };
    const renderSrFs = `${vs}
struct P { inW: u32, inH: u32, outW: u32, outH: u32 };
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var deltaTex: texture_2d_array<f32>;
@group(0) @binding(2) var<uniform> p: P;
fn fetchSrc(x: i32, y: i32) -> vec3<f32> {
  return textureLoad(srcTex, vec2<i32>(clamp(x, 0, i32(p.inW) - 1), clamp(y, 0, i32(p.inH) - 1)), 0).rgb;
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let ox = u32(pos.x); let oy = u32(pos.y);
  let fx = (f32(ox) + 0.5) * (f32(p.inW) / f32(p.outW)) - 0.5;
  let fy = (f32(oy) + 0.5) * (f32(p.inH) / f32(p.outH)) - 0.5;
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy));
  let wx = fx - f32(x0); let wy = fy - f32(y0);
  let base = mix(
    mix(fetchSrc(x0, y0), fetchSrc(x0 + 1, y0), wx),
    mix(fetchSrc(x0, y0 + 1), fetchSrc(x0 + 1, y0 + 1), wx),
    wy
  );
  let lrx = i32(min(ox >> 1u, p.inW - 1u));
  let lry = i32(min(oy >> 1u, p.inH - 1u));
  let sub = (oy & 1u) * 2u + (ox & 1u);
  let b4 = textureLoad(deltaTex, vec2<i32>(lrx, lry), 0, 0);
  let g4 = textureLoad(deltaTex, vec2<i32>(lrx, lry), 1, 0);
  let r4 = textureLoad(deltaTex, vec2<i32>(lrx, lry), 2, 0);
  let deltaRgb = vec3<f32>(r4[sub], g4[sub], b4[sub]);
  return vec4<f32>(clamp(base + deltaRgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`;
    const makePipe = (code, formats) => {
      const mod = dev.createShaderModule({ code });
      return dev.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: formats.map((format) => ({ format })) },
      });
    };
    this._srPipes = {
      texIn: makePipe(texInFs, ['rgba16float']),
      conv: [null, 1, 2, 3, 4].map((m) => (m ? makePipe(makeConvFs(m), Array(m).fill('rgba16float')) : null)),
      add: [null, 1, 2, 3, 4].map((m) => (m ? makePipe(makeAddFs(m), Array(m).fill('rgba16float')) : null)),
      renderSr: makePipe(renderSrFs, ['rgba8unorm']),
    };
    return this._srPipes;
  }

  _getBlitPipe(format) {
    if (!this.blitPipes.has(format)) {
      const mod = this.device.createShaderModule({ code: this.blitSrc });
      this.blitPipes.set(format, this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
      }));
    }
    return this.blitPipes.get(format);
  }

  destroy() {
    for (const m of [...this.models]) m.destroy();
    this.dummyOneBuf.destroy();
    if (this.ownsDevice) this.device.destroy();
  }
}

function makeU32Uniform(device, vals) {
  const bytes = new Uint8Array(Math.max(16, Math.ceil((vals.length * 4) / 16) * 16));
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (typeof v === 'object' && v.f32 !== undefined) dv.setFloat32(i * 4, v.f32, true);
    else dv.setUint32(i * 4, v >>> 0, true);
  }
  const buf = device.createBuffer({ size: bytes.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, bytes);
  return buf;
}

function _uploadWebGPUFrame(device, engine, entry, targetW, targetH, source) {
  entry.externalTex = null;
  if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) {
    device.queue.writeTexture(
      { texture: entry.tex },
      source,
      { bytesPerRow: targetW * 4, rowsPerImage: targetH },
      [targetW, targetH],
    );
    return;
  }
  const srcW = source.videoWidth || source.width || targetW;
  const srcH = source.videoHeight || source.height || targetH;
  if (srcW === targetW && srcH === targetH) {
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: entry.tex },
      [targetW, targetH],
    );
    return;
  }
  if (!entry.srcTex || entry.srcW !== srcW || entry.srcH !== srcH) {
    if (entry.srcTex) entry.srcTex.destroy();
    entry.srcTex = device.createTexture({
      size: [srcW, srcH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    entry.srcW = srcW;
    entry.srcH = srcH;
  }
  device.queue.copyExternalImageToTexture(
    { source },
    { texture: entry.srcTex },
    [srcW, srcH],
  );
  const pipe = engine._getBlitPipe('rgba8unorm');
  const bg = device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: entry.srcTex.createView() },
      { binding: 1, resource: engine.sampler },
    ],
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: entry.tex.createView(),
      loadOp: 'clear',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      storeOp: 'store',
    }],
  });
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bg);
  pass.draw(3);
  pass.end();
  device.queue.submit([enc.finish()]);
}

class WebGPUSession {
  constructor(engine, model, options) {
    this.engine = engine;
    this.device = engine.device;
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

    this.plan = compilePlan(model.data, this.workW, this.workH, this.k, {
      useFilm: options.useFilm !== false,
      useRefine: options.useRefine !== false,
    });

    this.ownedBufs = [];
    this.tensors = new Map();
    for (const [id, meta] of this.plan.tensorMeta.entries()) {
      if (id === 't' || id === this.plan.finalIds.render) continue;
      if (meta.h === 1 && meta.w === 1 && id.startsWith('g#')) {
        // FiLM MLP float32 vector buffer
        const buf = this.device.createBuffer({
          size: Math.max(16, meta.c * 4),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.ownedBufs.push(buf);
        this.tensors.set(id, { buf, c: meta.c, h: 1, w: 1 });
        continue;
      }
      const bytes = Math.max(4, Math.ceil((meta.c * meta.h * meta.w * this.engine.elemBytes) / 4) * 4);
      const buf = this.device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.ownedBufs.push(buf);
      this.tensors.set(id, { buf, c: meta.c, h: meta.h, w: meta.w, bytes });
    }

    const upStep = this.plan.midSteps.find((s) => s.op === 'convex_upsample');
    if (upStep) {
      const hMeta = this.plan.tensorMeta.get(upStep.inIds[0]);
      const bytes = Math.max(4, Math.ceil((36 * hMeta.h * hMeta.w * this.engine.elemBytes) / 4) * 4);
      const buf = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
      this.ownedBufs.push(buf);
      this.convexWt = { buf, c: 36, h: hMeta.h, w: hMeta.w, bytes };
    }

    // Pre-create reusable uniform buffers for static ops & dynamic `t`-dependent ops
    this.staticDispatches = { pair: [], mid: [] };
    this.tUpdates = [];
    this._buildDispatches();

    this.inputs = [];
    this.outputs = [];
    this.lastPairSlots = [0, 0];
    this.texInUni = makeU32Uniform(this.device, [this.width, this.height, this.workW, this.workH]);
    this.ownedBufs.push(this.texInUni);

    if (this.isSr) {
      this.srUni = makeU32Uniform(this.device, [this.width, this.height, this.outW, this.outH]);
      this.ownedBufs.push(this.srUni);
    } else {
      const flowMeta = this.plan.tensorMeta.get(this.plan.finalIds.flow_tq);
      this.renderUni = makeU32Uniform(this.device, [
        this.width,
        this.height,
        flowMeta.w,
        flowMeta.h,
        { f32: this.width / this.workW },
        { f32: this.height / this.workH },
        this.cubic ? 1 : 0,
        this.stillGuard ? 1 : 0,
      ]);
      this.ownedBufs.push(this.renderUni);
    }

    this.addInput();
    this.addInput();
    this.addOutput();
  }

  _buildDispatches() {
    const dev = this.device;
    const P = this.engine.pipes;
    const bg = (pipe, entries) => dev.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({ binding, resource })),
    });

    const addConv = (targetList, inT, outT, wNames, stride) => {
      const hasPrelu = wNames.length >= 3;
      const pipe = stride === 1 ? P.conv3x3Tiled : P.conv3x3;
      const uni = makeU32Uniform(dev, [inT.c, outT.c, inT.h, inT.w, outT.h, outT.w, stride, hasPrelu ? 1 : 0]);
      this.ownedBufs.push(uni);
      targetList.push({
        kind: 'dispatch',
        pipe,
        bg: bg(pipe, [
          { buffer: inT.buf },
          { buffer: this.model.weightBufs.get(wNames[0]) },
          { buffer: this.model.weightBufs.get(wNames[1]) },
          { buffer: hasPrelu ? this.model.weightBufs.get(wNames[2]) : this.engine.dummyOneBuf },
          { buffer: outT.buf },
          { buffer: uni },
        ]),
        wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), Math.ceil(outT.c / 4)],
      });
    };

    const compileSteps = (steps, targetList) => {
      for (const step of steps) {
        const op = step.op;
        if (op === 'render_pix' || op === 'render_sr') continue;

        if (op === 'conv' || op === 'conv2d') {
          addConv(targetList, this.tensors.get(step.inIds[0]), this.tensors.get(step.outIds[0]), step.w, step.stride || 1);
        } else if (op === 'interpolate') {
          const inT = this.tensors.get(step.inIds[0]);
          const outT = this.tensors.get(step.outIds[0]);
          const uni = makeU32Uniform(dev, [inT.c, inT.h, inT.w, outT.h, outT.w, step.antialias ? 1 : 0, 0, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.interp,
            bg: bg(P.interp, [{ buffer: inT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), outT.c],
          });
        } else if (op === 'avgpool') {
          const inT = this.tensors.get(step.inIds[0]);
          const outT = this.tensors.get(step.outIds[0]);
          const uni = makeU32Uniform(dev, [inT.c, inT.h, inT.w, outT.h, outT.w, step.k, 0, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.avgpool,
            bg: bg(P.avgpool, [{ buffer: inT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), outT.c],
          });
        } else if (op === 'zeros' || op === 'zeros_like') {
          const outT = this.tensors.get(step.outIds[0]);
          targetList.push({ kind: 'clear', buf: outT.buf, bytes: outT.bytes });
        } else if (op === 'concat') {
          const outT = this.tensors.get(step.outIds[0]);
          let dstC0 = 0;
          for (const id of step.inIds) {
            const inT = this.tensors.get(id);
            const uni = makeU32Uniform(dev, [inT.c, inT.h, inT.w, 0, dstC0, 0, 0, 0]);
            this.ownedBufs.push(uni);
            targetList.push({
              kind: 'dispatch', pipe: P.copyCh,
              bg: bg(P.copyCh, [{ buffer: inT.buf }, { buffer: outT.buf }, { buffer: uni }]),
              wg: [Math.ceil(inT.w / 8), Math.ceil(inT.h / 8), inT.c],
            });
            dstC0 += inT.c;
          }
        } else if (op === 'slice') {
          const inT = this.tensors.get(step.inIds[0]);
          const outT = this.tensors.get(step.outIds[0]);
          const uni = makeU32Uniform(dev, [outT.c, outT.h, outT.w, step.a, 0, 0, 0, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.copyCh,
            bg: bg(P.copyCh, [{ buffer: inT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), outT.c],
          });
        } else if (op === 'scale' || op === 'neg' || op === 'mul_t' || op === 'affine_out' || op === 'clamp') {
          const inT = this.tensors.get(step.inIds[0]);
          const outT = this.tensors.get(step.outIds[0]);
          let uOp = 0, uA = 1.0, uB = 0.0;
          if (op === 'scale') { uOp = 0; uA = step.factor; }
          else if (op === 'mul_t') { uOp = 0; uA = 1.0; }
          else if (op === 'clamp') { uOp = 1; uA = step.lo; uB = step.hi; }
          else if (op === 'affine_out') { uOp = 2; }
          else { uOp = 3; }
          const uni = makeU32Uniform(dev, [inT.c, inT.h, inT.w, uOp, { f32: uA }, { f32: uB }, 0, 0]);
          this.ownedBufs.push(uni);
          if (op === 'mul_t') {
            const isFwd = step.mode === 'fwd';
            const f32Tmp = new Float32Array(1);
            this.tUpdates.push((t) => {
              f32Tmp[0] = isFwd ? 2.0 * t : 2.0 * (1.0 - t);
              dev.queue.writeBuffer(uni, 16, f32Tmp);
            });
          }
          targetList.push({
            kind: 'dispatch', pipe: P.unary,
            bg: bg(P.unary, [{ buffer: inT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), outT.c],
          });
        } else if (op === 'add' || op === 'mul') {
          const aT = this.tensors.get(step.inIds[0]);
          const bT = this.tensors.get(step.inIds[1]);
          const outT = this.tensors.get(step.outIds[0]);
          const uni = makeU32Uniform(dev, [outT.c, outT.h, outT.w, op === 'add' ? 0 : 1, bT.c === 1 && aT.c > 1 ? 1 : 0, 0, 0, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.binary,
            bg: bg(P.binary, [{ buffer: aT.buf }, { buffer: bT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), outT.c],
          });
        } else if (op === 'luma' || op === 'luma_grad') {
          const inT = this.tensors.get(step.inIds[0]);
          const outT = this.tensors.get(step.outIds[0]);
          const uni = makeU32Uniform(dev, [inT.h, inT.w, op === 'luma_grad' ? 1 : 0, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.luma,
            bg: bg(P.luma, [{ buffer: inT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), 1],
          });
        } else if (op === 'sad_volume') {
          const la = this.tensors.get(step.inIds[0]);
          const lb = this.tensors.get(step.inIds[1]);
          const outT = this.tensors.get(step.outIds[0]);
          const span = 2 * step.radius + 1;
          const uni = makeU32Uniform(dev, [la.h, la.w, step.radius, span]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.sad,
            bg: bg(P.sad, [{ buffer: la.buf }, { buffer: lb.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), span * span],
          });
        } else if (op === 'warp') {
          const imgT = this.tensors.get(step.inIds[0]);
          const flT = this.tensors.get(step.inIds[1]);
          const outT = this.tensors.get(step.outIds[0]);
          const uni = makeU32Uniform(dev, [imgT.c, imgT.h, imgT.w, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.warp,
            bg: bg(P.warp, [{ buffer: imgT.buf }, { buffer: flT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), outT.c],
          });
        } else if (op === 'film_mlp') {
          const outT = this.tensors.get(step.outIds[0]);
          const wNames = step.w;
          this.tUpdates.push((t) => {
            const vec = evalFilmMlp(this.model.data, wNames, t);
            dev.queue.writeBuffer(outT.buf, 0, vec);
          });
        } else if (op === 'film_modulate') {
          const hT = this.tensors.get(step.inIds[0]);
          const gT = this.tensors.get(step.inIds[1]);
          const outT = this.tensors.get(step.outIds[0]);
          const uni = makeU32Uniform(dev, [hT.c, hT.h, hT.w, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.filmMod,
            bg: bg(P.filmMod, [{ buffer: hT.buf }, { buffer: gT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), outT.c],
          });
        } else if (op === 'convex_upsample') {
          const hT = this.tensors.get(step.inIds[0]);
          const xT = this.tensors.get(step.inIds[1]);
          const outT = this.tensors.get(step.outIds[0]);
          addConv(targetList, hT, this.convexWt, step.w, 1);
          const uni = makeU32Uniform(dev, [xT.c, xT.h, xT.w, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.convex,
            bg: bg(P.convex, [{ buffer: this.convexWt.buf }, { buffer: xT.buf }, { buffer: outT.buf }, { buffer: uni }]),
            wg: [Math.ceil(outT.w / 8), Math.ceil(outT.h / 8), outT.c],
          });
        } else if (op === 'blend_weights') {
          const vT = this.tensors.get(step.inIds[0]);
          const outA = this.tensors.get(step.outIds[0]);
          const outB = this.tensors.get(step.outIds[1]);
          const uni = makeU32Uniform(dev, [vT.h, vT.w, 0, 0]);
          this.ownedBufs.push(uni);
          targetList.push({
            kind: 'dispatch', pipe: P.blendW,
            bg: bg(P.blendW, [{ buffer: vT.buf }, { buffer: outA.buf }, { buffer: outB.buf }, { buffer: uni }]),
            wg: [Math.ceil(vT.w / 8), Math.ceil(vT.h / 8), 1],
          });
        }
      }
    };

    compileSteps(this.plan.pairSteps, this.staticDispatches.pair);
    compileSteps(this.plan.midSteps, this.staticDispatches.mid);
  }

  addInput() {
    const slot = this.inputs.length;
    const tex = this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.inputs.push({ tex, externalTex: null });
    return slot;
  }

  addOutput() {
    const slot = this.outputs.length;
    const tex = this.device.createTexture({
      size: [this.outW, this.outH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.outputs.push(tex);
    return slot;
  }

  inputTexture(slot) {
    return this.inputs[slot].externalTex || this.inputs[slot].tex;
  }

  outputTexture(slot = 0) {
    return this.outputs[slot];
  }

  /** Bind an external GPUTexture directly (zero-copy for same-device PVSSPW/Vitaslop!). */
  setExternalInputTexture(slot, gpuTexture) {
    this.inputs[slot].externalTex = gpuTexture;
  }

  pushFrame(slot, source) {
    _uploadWebGPUFrame(this.device, this.engine, this.inputs[slot], this.width, this.height, source);
  }

  _runList(enc, list) {
    for (const item of list) {
      if (item.kind === 'clear') {
        enc.clearBuffer(item.buf, 0, item.bytes);
      } else {
        const pass = enc.beginComputePass();
        pass.setPipeline(item.pipe);
        pass.setBindGroup(0, item.bg);
        pass.dispatchWorkgroups(item.wg[0], item.wg[1], item.wg[2]);
        pass.end();
      }
    }
  }

  pair(slotA, slotB) {
    this.lastPairSlots = [slotA, slotB];
    const dev = this.device;
    const P = this.engine.pipes;
    const enc = dev.createCommandEncoder();

    for (const [slot, id] of [[slotA, 'A'], [slotB, 'B']]) {
      const dst = this.tensors.get(id);
      const bg = dev.createBindGroup({
        layout: P.texIn.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.inputTexture(slot).createView() },
          { binding: 1, resource: { buffer: dst.buf } },
          { binding: 2, resource: { buffer: this.texInUni } },
        ],
      });
      const pass = enc.beginComputePass();
      pass.setPipeline(P.texIn);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(this.workW / 8), Math.ceil(this.workH / 8), 1);
      pass.end();
    }

    this._runList(enc, this.staticDispatches.pair);
    dev.queue.submit([enc.finish()]);
  }

  mid(t = 0.5, outSlot = 0) {
    for (const fn of this.tUpdates) fn(t);
    const dev = this.device;
    const P = this.engine.pipes;
    const enc = dev.createCommandEncoder();
    this._runList(enc, this.staticDispatches.mid);

    const [slotA, slotB] = this.lastPairSlots;
    const bg = dev.createBindGroup({
      layout: P.renderTex.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.inputTexture(slotA).createView() },
        { binding: 1, resource: this.inputTexture(slotB).createView() },
        { binding: 2, resource: { buffer: this.tensors.get(this.plan.finalIds.flow_tq).buf } },
        { binding: 3, resource: { buffer: this.tensors.get(this.plan.finalIds.vis_tq).buf } },
        { binding: 4, resource: { buffer: this.tensors.get(this.plan.finalIds.R_t).buf } },
        { binding: 5, resource: this.outputs[outSlot].createView() },
        { binding: 6, resource: { buffer: this.renderUni } },
      ],
    });
    const pass = enc.beginComputePass();
    pass.setPipeline(P.renderTex);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8), 1);
    pass.end();

    dev.queue.submit([enc.finish()]);
  }

  /** Run 2x super-resolution on `srcSlot` and store result into `outputs[outSlot]`. */
  upscale(srcSlot = 0, outSlot = 0) {
    if (!this.isSr) throw new Error('upscale() requires a super-resolution model');
    const dev = this.device;
    const P = this.engine.pipes;
    const enc = dev.createCommandEncoder();

    const srcView = this.inputTexture(srcSlot).createView();
    const dst = this.tensors.get('A');
    const texInBg = dev.createBindGroup({
      layout: P.texIn.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: { buffer: dst.buf } },
        { binding: 2, resource: { buffer: this.texInUni } },
      ],
    });
    const pIn = enc.beginComputePass();
    pIn.setPipeline(P.texIn);
    pIn.setBindGroup(0, texInBg);
    pIn.dispatchWorkgroups(Math.ceil(this.workW / 8), Math.ceil(this.workH / 8), 1);
    pIn.end();

    this._runList(enc, this.staticDispatches.pair);

    const srBg = dev.createBindGroup({
      layout: P.renderSr.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: { buffer: this.tensors.get(this.plan.finalIds.delta_lr).buf } },
        { binding: 2, resource: this.outputs[outSlot].createView() },
        { binding: 3, resource: { buffer: this.srUni } },
      ],
    });
    const pSr = enc.beginComputePass();
    pSr.setPipeline(P.renderSr);
    pSr.setBindGroup(0, srBg);
    pSr.dispatchWorkgroups(Math.ceil(this.outW / 8), Math.ceil(this.outH / 8), 1);
    pSr.end();

    dev.queue.submit([enc.finish()]);
  }

  /** Blit a source or output texture onto a configured GPUCanvasContext. */
  presentToContext(canvasCtx, format, frame) {
    const dev = this.device;
    const pipe = this.engine._getBlitPipe(format);
    const tex = 'source' in frame ? this.inputTexture(frame.source) : this.outputTexture(frame.output ?? 0);
    const bg = dev.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: this.engine.sampler },
      ],
    });
    const enc = dev.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: canvasCtx.getCurrentTexture().createView(),
        loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store',
      }],
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    dev.queue.submit([enc.finish()]);
  }

  async readRgba(outSlot = 0) {
    const dev = this.device;
    const w = this.outW;
    const h = this.outH;
    const stride = Math.ceil((w * 4) / 256) * 256;
    const buf = dev.createBuffer({
      size: stride * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.outputs[outSlot] }, { buffer: buf, bytesPerRow: stride }, [w, h]);
    dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      out.set(mapped.subarray(y * stride, y * stride + w * 4), y * w * 4);
    }
    buf.unmap();
    buf.destroy();
    return out;
  }

  async finish() {
    await this.device.queue.onSubmittedWorkDone();
  }

  destroy() {
    for (const b of this.ownedBufs) b.destroy();
    this.ownedBufs = [];
    this.tensors.clear();
    for (const inp of this.inputs) {
      inp.tex.destroy();
      if (inp.srcTex) inp.srcTex.destroy();
    }
    for (const out of this.outputs) out.destroy();
    this.inputs = [];
    this.outputs = [];
  }
}

class WebGPUSrSession {
  constructor(engine, model, options) {
    this.engine = engine;
    this.device = engine.device;
    this.model = model;
    this.isSr = true;
    this.scale = model.data.meta.scale || 2;
    this.width = options.width;
    this.height = options.height;
    this.workW = this.width;
    this.workH = this.height;
    this.outW = this.width * this.scale;
    this.outH = this.height * this.scale;
    this.pipes = engine._getSrPipes();

    this.plan = compilePlan(model.data, this.workW, this.workH, 1);
    this.ownedBufs = [];
    this.tensors = new Map();

    for (const [id, meta] of this.plan.tensorMeta.entries()) {
      if (id === 't' || id === this.plan.finalIds.render) continue;
      const layers = Math.ceil(meta.c / 4);
      const tex = this.device.createTexture({
        size: [meta.w, meta.h, layers],
        dimension: '2d',
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const arrayView = tex.createView({ dimension: '2d-array', baseArrayLayer: 0, arrayLayerCount: layers });
      const layerViews = [];
      for (let l = 0; l < layers; l++) {
        layerViews.push(tex.createView({ dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1 }));
      }
      this.tensors.set(id, { tex, arrayView, layerViews, layers, w: meta.w, h: meta.h, c: meta.c });
    }

    this.passes = [];
    const bg = (pipe, entries) => this.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({ binding, resource })),
    });

    for (const step of this.plan.pairSteps) {
      if (step.op === 'render_sr') continue;
      if (step.op === 'conv' || step.op === 'conv2d') {
        const inT = this.tensors.get(step.inIds[0]);
        const outT = this.tensors.get(step.outIds[0]);
        const cw = model.srConvWeights.get(step.w.join('|'));
        const act = step.w.length >= 3 ? 1 : 0;
        for (let base = 0; base < cw.gOut; base += 4) {
          const cnt = Math.min(4, cw.gOut - base);
          const pipe = this.pipes.conv[cnt];
          const uniBytes = new ArrayBuffer(160);
          const u32 = new Uint32Array(uniBytes);
          const f32 = new Float32Array(uniBytes);
          u32[0] = inT.w; u32[1] = inT.h; u32[2] = cw.gIn; u32[3] = base; u32[4] = act;
          for (let m = 0; m < cnt; m++) {
            const g = base + m;
            for (let lane = 0; lane < 4; lane++) {
              const oc = g * 4 + lane;
              f32[8 + m * 4 + lane] = oc < cw.cout ? cw.bF32[oc] : 0.0;
              f32[24 + m * 4 + lane] = (oc < cw.cout && cw.pF32) ? cw.pF32[oc] : 1.0;
            }
          }
          const uni = this.device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          this.device.queue.writeBuffer(uni, 0, uniBytes);
          this.ownedBufs.push(uni);
          this.passes.push({
            pipe,
            bindGroup: bg(pipe, [inT.arrayView, { buffer: cw.wBuf }, { buffer: uni }]),
            views: outT.layerViews.slice(base, base + cnt),
          });
        }
      } else if (step.op === 'add') {
        const aT = this.tensors.get(step.inIds[0]);
        const bT = this.tensors.get(step.inIds[1]);
        const outT = this.tensors.get(step.outIds[0]);
        for (let base = 0; base < outT.layers; base += 4) {
          const cnt = Math.min(4, outT.layers - base);
          const pipe = this.pipes.add[cnt];
          const uni = makeU32Uniform(this.device, [base, 0, 0, 0]);
          this.ownedBufs.push(uni);
          this.passes.push({
            pipe,
            bindGroup: bg(pipe, [aT.arrayView, bT.arrayView, { buffer: uni }]),
            views: outT.layerViews.slice(base, base + cnt),
          });
        }
      }
    }

    this.srUni = makeU32Uniform(this.device, [this.width, this.height, this.outW, this.outH]);
    this.ownedBufs.push(this.srUni);

    this.inputs = [];
    this.outputs = [];
    this.addInput();
    this.addOutput();
  }

  addInput() {
    const slot = this.inputs.length;
    const tex = this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.inputs.push({ tex, externalTex: null });
    return slot;
  }

  addOutput() {
    const slot = this.outputs.length;
    const tex = this.device.createTexture({
      size: [this.outW, this.outH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.outputs.push(tex);
    return slot;
  }

  inputTexture(slot) {
    return this.inputs[slot].externalTex || this.inputs[slot].tex;
  }

  outputTexture(slot = 0) {
    return this.outputs[slot];
  }

  setExternalInputTexture(slot, gpuTexture) {
    this.inputs[slot].externalTex = gpuTexture;
  }

  pushFrame(slot, source) {
    _uploadWebGPUFrame(this.device, this.engine, this.inputs[slot], this.width, this.height, source);
  }

  upscale(srcSlot = 0, outSlot = 0) {
    const dev = this.device;
    const P = this.pipes;
    const enc = dev.createCommandEncoder();
    const srcView = this.inputTexture(srcSlot).createView();

    const aT = this.tensors.get('A');
    const inBg = dev.createBindGroup({
      layout: P.texIn.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: srcView }],
    });
    const clearCol = { r: 0, g: 0, b: 0, a: 0 };
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: aT.layerViews[0], loadOp: 'clear', clearValue: clearCol, storeOp: 'store' }],
      });
      pass.setPipeline(P.texIn);
      pass.setBindGroup(0, inBg);
      pass.draw(3);
      pass.end();
    }

    for (const item of this.passes) {
      const pass = enc.beginRenderPass({
        colorAttachments: item.views.map((view) => ({ view, loadOp: 'clear', clearValue: clearCol, storeOp: 'store' })),
      });
      pass.setPipeline(item.pipe);
      pass.setBindGroup(0, item.bindGroup);
      pass.draw(3);
      pass.end();
    }

    const deltaT = this.tensors.get(this.plan.finalIds.delta_lr);
    const srBg = dev.createBindGroup({
      layout: P.renderSr.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: deltaT.arrayView },
        { binding: 2, resource: { buffer: this.srUni } },
      ],
    });
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.outputs[outSlot].createView(), loadOp: 'clear', clearValue: clearCol, storeOp: 'store' }],
      });
      pass.setPipeline(P.renderSr);
      pass.setBindGroup(0, srBg);
      pass.draw(3);
      pass.end();
    }

    dev.queue.submit([enc.finish()]);
  }

  presentToContext(canvasCtx, format, frame) {
    const dev = this.device;
    const pipe = this.engine._getBlitPipe(format);
    const tex = 'source' in frame ? this.inputTexture(frame.source) : this.outputTexture(frame.output ?? 0);
    const bg = dev.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: this.engine.sampler },
      ],
    });
    const enc = dev.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: canvasCtx.getCurrentTexture().createView(),
        loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store',
      }],
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    dev.queue.submit([enc.finish()]);
  }

  async readRgba(outSlot = 0) {
    const dev = this.device;
    const w = this.outW;
    const h = this.outH;
    const stride = Math.ceil((w * 4) / 256) * 256;
    const buf = dev.createBuffer({
      size: stride * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.outputs[outSlot] }, { buffer: buf, bytesPerRow: stride }, [w, h]);
    dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      out.set(mapped.subarray(y * stride, y * stride + w * 4), y * w * 4);
    }
    buf.unmap();
    buf.destroy();
    return out;
  }

  async finish() {
    await this.device.queue.onSubmittedWorkDone();
  }

  destroy() {
    for (const b of this.ownedBufs) b.destroy();
    this.ownedBufs = [];
    for (const t of this.tensors.values()) t.tex.destroy();
    this.tensors.clear();
    for (const inp of this.inputs) {
      inp.tex.destroy();
      if (inp.srcTex) inp.srcTex.destroy();
    }
    for (const out of this.outputs) out.destroy();
    this.inputs = [];
    this.outputs = [];
  }
}
