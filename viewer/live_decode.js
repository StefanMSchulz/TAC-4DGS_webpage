// Per-frame reconstruction of the dynamic Gaussians: cubic Hermite positions, slerp rotations, temporal opacity.

async function fetchF32(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return new Float32Array(await res.arrayBuffer());
}

export async function loadLiveDecodePayload(dir, onProgress) {
  const config = await (await fetch(`${dir}/config.json`)).json();
  const names = [
    "static_xyz", "static_xyz_disp", "static_scale", "static_opacity", "static_color",
    "dynamic_xyz_motion", "dynamic_rotation_motion", "dynamic_scale", "dynamic_color",
    "dynamic_opacity_duration_center", "dynamic_opacity_duration_var", "dynamic_motion_opacity",
  ];
  const arrays = {};
  let loaded = 0;
  await Promise.all(
    names.map(async (name) => {
      arrays[name] = await fetchF32(`${dir}/${name}.bin`);
      loaded++;
      onProgress?.(loaded, names.length);
    }),
  );
  return { config, arrays };
}

function cubeInterpolate3(y0, y1, y2, y3, t, out) {
  const h00 = 2 * t * t * t - 3 * t * t + 1;
  const h10 = t * t * t - 2 * t * t + t;
  const h01 = -2 * t * t * t + 3 * t * t;
  const h11 = t * t * t - t * t;
  for (let d = 0; d < 3; d++) {
    const mk = (y2[d] - y0[d]) / 2;
    const mk1 = (y3[d] - y1[d]) / 2;
    out[d] = h00 * y1[d] + h10 * mk + h01 * y2[d] + h11 * mk1;
  }
}

function quatSlerp4(v1, v2, t, out) {
  let n1 = Math.hypot(v1[0], v1[1], v1[2], v1[3]);
  let n2 = Math.hypot(v2[0], v2[1], v2[2], v2[3]);
  const a = [v1[0] / n1, v1[1] / n1, v1[2] / n1, v1[3] / n1];
  const b = [v2[0] / n2, v2[1] / n2, v2[2] / n2, v2[3] / n2];
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  d = Math.min(Math.max(d, -1 + 1e-4), 1 - 1e-4);
  const omega = Math.max(Math.acos(d), 1e-4);
  const sOmega = Math.max(Math.sin(omega), 1e-4);
  let p0 = Math.sin((1 - t) * omega) / sOmega;
  let p1 = Math.sin(t * omega) / sOmega;
  const pSum = Math.max(p0 + p1, 1e-4);
  p0 /= pSum;
  p1 /= pSum;
  let rx = a[0] * p0 + b[0] * p1;
  let ry = a[1] * p0 + b[1] * p1;
  let rz = a[2] * p0 + b[2] * p1;
  let rw = a[3] * p0 + b[3] * p1;
  if (Math.abs(rx) + Math.abs(ry) + Math.abs(rz) + Math.abs(rw) <= 1e-4) {
    rx = a[0]; ry = a[1]; rz = a[2]; rw = a[3];
  }
  const n = Math.hypot(rx, ry, rz, rw);
  out[0] = rx / n; out[1] = ry / n; out[2] = rz / n; out[3] = rw / n;
}

function timeBigaussian(mean0, mean1, var0, var1, t, varMin) {
  const m = Math.min(t - mean0, t - mean1);
  const v = t > mean0 || t > mean1 ? var1 : var0;
  const denom = Math.exp(v) + varMin / 2.36;
  const opac = Math.exp(-((m * m) / (denom * denom)));
  const inside = (mean0 - t) * (mean1 - t) < 0;
  return inside ? 1.0 : opac;
}

const SH_C0 = 0.28209479177387814;

export function decodeDynamicFrame(payload, t) {
  const { config, arrays } = payload;
  const N = config.n_dynamic;
  const K = config.K_padded;
  const { interval, time_shift, var_pad } = config;

  const xyzMotion = arrays.dynamic_xyz_motion;
  const rotMotion = arrays.dynamic_rotation_motion;
  const scale = arrays.dynamic_scale;
  const color = arrays.dynamic_color;
  const opaCenter = arrays.dynamic_opacity_duration_center;
  const opaVar = arrays.dynamic_opacity_duration_var;
  const motionOpacity = arrays.dynamic_motion_opacity;

  const tVal = t + time_shift;
  const tIdx = Math.floor(tVal / interval);
  const deltaT = (tVal % interval) / interval;
  const tNorm = tVal / interval;

  const positions = new Float32Array(N * 3);
  const rotations = new Float32Array(N * 4);
  const scales = new Float32Array(N * 3);
  const colors = new Uint8Array(N * 4);

  const y0 = [0, 0, 0], y1 = [0, 0, 0], y2 = [0, 0, 0], y3 = [0, 0, 0], pOut = [0, 0, 0];
  const q1 = [0, 0, 0, 0], q2 = [0, 0, 0, 0], qOut = [0, 0, 0, 0];

  for (let i = 0; i < N; i++) {
    const kBase = i * K * 3;
    const k0 = kBase + (tIdx - 1) * 3, k1 = kBase + tIdx * 3, k2 = kBase + (tIdx + 1) * 3, k3 = kBase + (tIdx + 2) * 3;
    y0[0] = xyzMotion[k0]; y0[1] = xyzMotion[k0 + 1]; y0[2] = xyzMotion[k0 + 2];
    y1[0] = xyzMotion[k1]; y1[1] = xyzMotion[k1 + 1]; y1[2] = xyzMotion[k1 + 2];
    y2[0] = xyzMotion[k2]; y2[1] = xyzMotion[k2 + 1]; y2[2] = xyzMotion[k2 + 2];
    y3[0] = xyzMotion[k3]; y3[1] = xyzMotion[k3 + 1]; y3[2] = xyzMotion[k3 + 2];
    cubeInterpolate3(y0, y1, y2, y3, deltaT, pOut);
    positions[i * 3] = pOut[0]; positions[i * 3 + 1] = pOut[1]; positions[i * 3 + 2] = pOut[2];

    const qBase = i * K * 4;
    const qk1 = qBase + tIdx * 4, qk2 = qBase + (tIdx + 1) * 4;
    q1[0] = rotMotion[qk1]; q1[1] = rotMotion[qk1 + 1]; q1[2] = rotMotion[qk1 + 2]; q1[3] = rotMotion[qk1 + 3];
    q2[0] = rotMotion[qk2]; q2[1] = rotMotion[qk2 + 1]; q2[2] = rotMotion[qk2 + 2]; q2[3] = rotMotion[qk2 + 3];
    quatSlerp4(q1, q2, deltaT, qOut);
    rotations[i * 4] = qOut[0]; rotations[i * 4 + 1] = qOut[1];
    rotations[i * 4 + 2] = qOut[2]; rotations[i * 4 + 3] = qOut[3];

    scales[i * 3] = scale[i * 3]; scales[i * 3 + 1] = scale[i * 3 + 1]; scales[i * 3 + 2] = scale[i * 3 + 2];

    const opa = timeBigaussian(opaCenter[i * 2], opaCenter[i * 2 + 1], opaVar[i * 2], opaVar[i * 2 + 1], tNorm, var_pad / interval) * motionOpacity[i];
    colors[i * 4] = Math.max(0, Math.min(255, Math.round(color[i * 3] * 255)));
    colors[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(color[i * 3 + 1] * 255)));
    colors[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(color[i * 3 + 2] * 255)));
    colors[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(opa * 255)));
  }

  return { positions, rotations, scales, colors, vertexCount: N };
}

export function decodeStaticFrame(payload, t) {
  const { config, arrays } = payload;
  const N = config.n_static;
  const xyz = arrays.static_xyz;
  const disp = arrays.static_xyz_disp;
  const scale = arrays.static_scale;
  const color = arrays.static_color;
  const opacity = arrays.static_opacity;
  const frac = t / config.duration;

  const positions = new Float32Array(N * 3);
  const rotations = new Float32Array(N * 4);
  const scales = new Float32Array(N * 3);
  const colors = new Uint8Array(N * 4);

  for (let i = 0; i < N; i++) {
    positions[i * 3] = xyz[i * 3] + disp[i * 3] * frac;
    positions[i * 3 + 1] = xyz[i * 3 + 1] + disp[i * 3 + 1] * frac;
    positions[i * 3 + 2] = xyz[i * 3 + 2] + disp[i * 3 + 2] * frac;
    rotations[i * 4] = 1;
    scales[i * 3] = scale[i * 3]; scales[i * 3 + 1] = scale[i * 3 + 1]; scales[i * 3 + 2] = scale[i * 3 + 2];
    colors[i * 4] = Math.max(0, Math.min(255, Math.round(color[i * 3] * 255)));
    colors[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(color[i * 3 + 1] * 255)));
    colors[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(color[i * 3 + 2] * 255)));
    colors[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(opacity[i] * 255)));
  }

  return { positions, rotations, scales, colors, vertexCount: N };
}
