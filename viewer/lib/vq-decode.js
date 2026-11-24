// Decodes the bitstream: entropy-coded VQ indices, codebook lookup, wavelet inverse, delta-rotation composition.

import { readNpz } from "./npy-zip.js";
import { decodeSymbols } from "./rans-decoder.js";

const SH_C0 = 0.28209479177387814;
const INV_SQRT2 = 1 / Math.sqrt(2);
const ATTR_KEYS = ["scale", "rot", "dc", "sh1", "sh2", "sh3", "opa", "opa_motion", "opa_center", "opa_var", "wv"];
const KEEP = new Set(["scale", "rot", "dc", "opa", "opa_motion", "opa_center", "wv"]);

function readHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let pos = 8 * 4;
  const keys = ["static", "motion", "center"];
  const params = {};
  for (const key of keys) {
    params[`stepSize_${key}`] = view.getFloat32(pos, false); pos += 4;
    params[`minOpacity_${key}`] = view.getFloat32(pos, false); pos += 4;
  }
  return params;
}

function readUint32BE(view, pos) {
  return view.getUint32(pos, false);
}

function decodeIndexBitstream(indexBytes, logits, cdfTables, counts) {
  const view = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.length);
  let pos = 0;
  const out = {};
  for (const key of ATTR_KEYS) {
    if (!(key in logits)) continue;
    const len = readUint32BE(view, pos);
    pos += 4;
    if (KEEP.has(key)) {
      const blob = indexBytes.subarray(pos, pos + len);
      const cdf = cdfTables[`${key}_cdf`].data;
      const maxValue = cdf.length - 2;
      out[key] = decodeSymbols(blob, cdf, maxValue, counts[key]);
    }
    pos += len;
  }
  return out;
}

const f32 = Math.fround;

function expandVector3(comp, mu, count) {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = comp[i * 3], y = comp[i * 3 + 1], z = comp[i * 3 + 2];
    const magComp = f32(Math.hypot(x, y, z));
    const d = Math.max(magComp, 1e-8);
    const mag = f32(mu * f32(Math.expm1(magComp)));
    out[i * 3] = f32(f32(mag * x) / d);
    out[i * 3 + 1] = f32(f32(mag * y) / d);
    out[i * 3 + 2] = f32(f32(mag * z) / d);
  }
  return out;
}

function quatExpand(comp, mu, count) {
  const out = new Float32Array(count * 4);
  const mMax = f32(Math.log1p(f32(1 / mu)));
  for (let i = 0; i < count; i++) {
    const w = comp[i * 4];
    const x = comp[i * 4 + 1], y = comp[i * 4 + 2], z = comp[i * 4 + 3];
    let magComp = f32(Math.hypot(x, y, z));
    if (magComp > 1 - 1e-8) magComp = f32(1 - 1e-8);
    const d = Math.max(magComp, 1e-8);
    const mag = f32(mu * f32(Math.expm1(f32(magComp * mMax))));
    const ex = f32(f32(mag * x) / d), ey = f32(f32(mag * y) / d), ez = f32(f32(mag * z) / d);
    let wReal = f32(Math.sqrt(Math.max(f32(1 - f32(mag * mag)), 1e-8)));
    if (w < 0) wReal = -wReal;
    const n = Math.hypot(wReal, ex, ey, ez) || 1;
    out[i * 4] = wReal / n;
    out[i * 4 + 1] = ex / n;
    out[i * 4 + 2] = ey / n;
    out[i * 4 + 3] = ez / n;
  }
  return out;
}

function haarInverseFromApprox(approx, dynamicNum, halfKf) {
  const T = halfKf * 2;
  const out = new Float32Array(dynamicNum * T * 3);
  for (let i = 0; i < dynamicNum; i++) {
    for (let k = 0; k < halfKf; k++) {
      const a = ((i * halfKf + k) * 3);
      const ax = approx[a] * INV_SQRT2, ay = approx[a + 1] * INV_SQRT2, az = approx[a + 2] * INV_SQRT2;
      const p0 = (i * T + 2 * k) * 3;
      const p1 = (i * T + 2 * k + 1) * 3;
      out[p0] = ax; out[p0 + 1] = ay; out[p0 + 2] = az;
      out[p1] = ax; out[p1 + 1] = ay; out[p1 + 2] = az;
    }
  }
  return { points: out, T };
}

function dequantOpacity(indices, minOpacity, stepSize) {
  const out = new Float32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = indices[i] * stepSize + minOpacity;
  return out;
}
function sigmoidInPlace(arr) {
  for (let i = 0; i < arr.length; i++) arr[i] = 1 / (1 + Math.exp(-arr[i]));
  return arr;
}

function gather(codebook, dim, indices, start, count) {
  const out = new Float32Array(count * dim);
  for (let i = 0; i < count; i++) {
    const src = indices[start + i] * dim;
    for (let d = 0; d < dim; d++) out[i * dim + d] = codebook[src + d];
  }
  return out;
}

function dcToColor(dc, count) {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    out[i] = Math.min(1, Math.max(0, SH_C0 * dc[i] + 0.5));
  }
  return out;
}

function composeDeltaRotations(deltas, ref, dynamicNum, nDeltaFrames) {
  const K = nDeltaFrames + 1;
  const out = new Float32Array(dynamicNum * K * 4);
  for (let i = 0; i < dynamicNum; i++) {
    out[i * K * 4 + 0] = ref[i * 4 + 0];
    out[i * K * 4 + 1] = ref[i * 4 + 1];
    out[i * K * 4 + 2] = ref[i * 4 + 2];
    out[i * K * 4 + 3] = ref[i * 4 + 3];
    for (let k = 1; k < K; k++) {
      const pBase = i * K * 4 + (k - 1) * 4;
      const w1 = out[pBase], x1 = out[pBase + 1], y1 = out[pBase + 2], z1 = out[pBase + 3];
      const dBase = i * nDeltaFrames * 4 + (k - 1) * 4;
      const w2 = deltas[dBase], x2 = deltas[dBase + 1], y2 = deltas[dBase + 2], z2 = deltas[dBase + 3];
      let qw = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2;
      let qx = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2;
      let qy = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2;
      let qz = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2;
      const n = Math.max(Math.hypot(qw, qx, qy, qz), 1e-8);
      const oBase = i * K * 4 + k * 4;
      out[oBase] = qw / n; out[oBase + 1] = qx / n; out[oBase + 2] = qy / n; out[oBase + 3] = qz / n;
    }
  }
  return out;
}

export function decodeBitstream(raw, manifest) {
  const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

  const header = readHeader(raw["header.bin"]);
  const logits = readNpz(toAB(raw["logits.npz"]));
  const cdfTables = readNpz(toAB(raw["cdf_tables.npz"]));
  const codebooks = readNpz(toAB(raw["codebook.npz"]));
  const positionStatic = readNpz(toAB(raw["position_static.npz"])).position;
  const positionDisp = readNpz(toAB(raw["position_disp.npz"])).position;
  const opacityVar = readNpz(toAB(raw["opacity_var.npz"])).opacity;
  const isEven = raw["is_even.bin"][0] !== 0;

  const staticNum = positionStatic.shape[0];
  const useWaveletVq = "use_wavelet_vq.bin" in raw;
  const useDeltaRot = "use_delta_rot.bin" in raw && raw["use_delta_rot.bin"][0] !== 0;

  let dynamicNum, keyframeNum, nDeltaFrames = null, halfKf = null;
  if (useDeltaRot) {
    const rotRef = readNpz(toAB(raw["rotation_ref.npz"])).ref;
    dynamicNum = rotRef.shape[0];
    const ndfView = new DataView(raw["n_delta_frames.bin"].buffer, raw["n_delta_frames.bin"].byteOffset, 4);
    nDeltaFrames = ndfView.getInt32(0, true);
    keyframeNum = nDeltaFrames + 1;
    if (useWaveletVq) halfKf = isEven ? keyframeNum >> 1 : (keyframeNum + 1) >> 1;
  } else {
    const approx = readNpz(toAB(raw["motion_wavelet_approx.npz"])).position;
    halfKf = approx.shape[1];
    dynamicNum = approx.shape[0];
    keyframeNum = isEven ? halfKf * 2 : halfKf * 2 - 1;
  }

  const counts = {
    scale: staticNum + dynamicNum,
    dc: staticNum + dynamicNum,
    opa: staticNum,
    opa_motion: dynamicNum,
    opa_center: dynamicNum * 2,
    rot: staticNum + (useDeltaRot ? nDeltaFrames : keyframeNum) * dynamicNum,
    wv: useWaveletVq ? dynamicNum * halfKf : 0,
  };
  const idx = decodeIndexBitstream(raw["index_bitstream.bin"], logits, cdfTables, counts);

  const scaleAll = gather(codebooks.scale.data, 3, idx.scale, 0, counts.scale);
  const dcAll = gather(codebooks.dc.data, 3, idx.dc, 0, counts.dc);

  const staticOpacity = sigmoidInPlace(dequantOpacity(idx.opa, header.minOpacity_static, header.stepSize_static));
  const motionOpacity = sigmoidInPlace(dequantOpacity(idx.opa_motion, header.minOpacity_motion, header.stepSize_motion));
  const opacityCenter = dequantOpacity(idx.opa_center, header.minOpacity_center, header.stepSize_center);

  let rotAll = gather(codebooks.rot.data, 4, idx.rot, 0, counts.rot);
  if ("compand_mu.bin" in raw) {
    const muView = new DataView(raw["compand_mu.bin"].buffer, raw["compand_mu.bin"].byteOffset, 16);
    const muRot = muView.getFloat64(0, true);
    rotAll = quatExpand(rotAll, muRot, counts.rot);
  }
  const staticRot = rotAll.subarray(0, staticNum * 4);
  let dynamicRot;
  if (useDeltaRot) {
    const deltas = rotAll.subarray(staticNum * 4);
    const rotRef = readNpz(toAB(raw["rotation_ref.npz"])).ref;
    dynamicRot = composeDeltaRotations(deltas, rotRef.data, dynamicNum, nDeltaFrames);
  } else {
    dynamicRot = rotAll.subarray(staticNum * 4);
  }

  let xyzMotion;
  if (useWaveletVq) {
    let coeffsApprox = gather(codebooks.wv.data, 3, idx.wv, 0, counts.wv);
    if ("compand_mu.bin" in raw) {
      const muView = new DataView(raw["compand_mu.bin"].buffer, raw["compand_mu.bin"].byteOffset, 16);
      const muWv = muView.getFloat64(8, true);
      coeffsApprox = expandVector3(coeffsApprox, muWv, counts.wv);
    }
    const { points, T } = haarInverseFromApprox(coeffsApprox, dynamicNum, halfKf);
    xyzMotion = isEven ? points : trimLastFrame(points, dynamicNum, T);
    if ("position_motion_ref.npz" in raw) {
      const ref = readNpz(toAB(raw["position_motion_ref.npz"])).position;
      addRefBroadcast(xyzMotion, ref.data, dynamicNum, keyframeNum);
    }
  } else {
    const approx = readNpz(toAB(raw["motion_wavelet_approx.npz"])).position;
    const { points, T } = haarInverseFromApprox(approx.data, dynamicNum, halfKf);
    xyzMotion = isEven ? points : trimLastFrame(points, dynamicNum, T);
  }

  const dynamicScale = scaleAll.subarray(staticNum * 3);
  const staticScale = scaleAll.subarray(0, staticNum * 3);
  const dynamicColor = dcToColor(dcAll.subarray(staticNum * 3), dynamicNum);
  const staticColor = dcToColor(dcAll.subarray(0, staticNum * 3), staticNum);

  const config = {
    n_static: staticNum,
    n_dynamic: dynamicNum,
    K_padded: keyframeNum,
    duration: manifest.duration,
    interval: manifest.interval,
    time_shift: manifest.time_shift,
    var_pad: manifest.var_pad,
    interp_type: manifest.interp_type,
    verify_frames: manifest.verify_frames,
  };

  const arrays = {
    static_xyz: positionStatic.data,
    static_xyz_disp: positionDisp.data,
    static_scale: staticScale,
    static_opacity: staticOpacity,
    static_color: staticColor,
    dynamic_xyz_motion: xyzMotion,
    dynamic_rotation_motion: dynamicRot,
    dynamic_scale: dynamicScale,
    dynamic_color: dynamicColor,
    dynamic_opacity_duration_center: opacityCenter,
    dynamic_opacity_duration_var: flattenOpacityVar(opacityVar, dynamicNum),
    dynamic_motion_opacity: motionOpacity,
  };

  return { config, arrays };
}

function trimLastFrame(points, dynamicNum, T) {
  const out = new Float32Array(dynamicNum * (T - 1) * 3);
  for (let i = 0; i < dynamicNum; i++) {
    out.set(points.subarray(i * T * 3, (i * T + (T - 1)) * 3), i * (T - 1) * 3);
  }
  return out;
}

function addRefBroadcast(xyzMotion, ref, dynamicNum, K) {
  for (let i = 0; i < dynamicNum; i++) {
    const rx = ref[i * 3], ry = ref[i * 3 + 1], rz = ref[i * 3 + 2];
    for (let k = 0; k < K; k++) {
      const base = (i * K + k) * 3;
      xyzMotion[base] += rx; xyzMotion[base + 1] += ry; xyzMotion[base + 2] += rz;
    }
  }
}

function flattenOpacityVar(opacityVarEntry, dynamicNum) {
  return opacityVarEntry.data.subarray(0, dynamicNum * 2);
}
