import * as SPLAT from "./vendor/gsplat/index.es.js";
import { decodeDynamicFrame, decodeStaticFrame } from "./live_decode.js";
import { loadBitstreamPayload } from "./bitstream_decode.js";

// TAC-4DGS interactive viewer: decodes a scene's compressed bitstream in the
// browser, reconstructs every frame on the fly and renders it with gsplat.js.

// ---- Scenes ---------------------------------------------------------------
// view: capture camera (centre of the camera rig): position, viewing
// direction, focal length and image size.
const SCENES = [
  { id: "Birthday", label: "Birthday", dataset: "Technicolor", frames: 50,
    view: { pos: [-2.606, -1.788, -6.933], fwd: [0.2149, 0.1049, 0.9710], fx: 2501.1, w: 2048, h: 1088 } },
];

// Bitstream size in MB (bytes / 1024²).
const SIZES_MB = {
  tac4dgs:  { Birthday: 6.67 },
  baseline: { Birthday: 9.96 },
};

const PLAYBACK_FPS = 30;

// ---- DOM ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const subtitleEl = $("subtitle");
const loadingEl = $("loading");
const loadingStatusEl = $("loadingStatus");
const playBtn = $("playBtn");
const playIcon = $("playIcon");
const scrub = $("scrub");
const frameLabel = $("frameLabel");
const statSplats = $("statSplats");
const statFps = $("statFps");
const hintEl = $("hint");
const scenePicker = $("scenePicker");
const methodPicker = $("methodPicker");

const params = new URLSearchParams(location.search);
if (params.get("embed") === "1") document.body.classList.add("embed");

function showError(text) {
  if (text) $("errorText").textContent = text;
  $("error").classList.add("visible");
  loadingEl.classList.add("hidden");
}

// ---- Scene picker ---------------------------------------------------------
if (SCENES.length < 2) scenePicker.style.display = "none";
{
  let lastDataset = null;
  for (const s of SCENES) {
    if (s.dataset !== lastDataset) {
      const label = document.createElement("span");
      label.className = "group-label";
      label.textContent = s.dataset;
      scenePicker.appendChild(label);
      lastDataset = s.dataset;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.scene = s.id;
    b.textContent = s.label;
    scenePicker.appendChild(b);
  }
}

// ---- Renderer + camera ---------------------------------------------------
let renderer;
try {
  renderer = new SPLAT.WebGLRenderer(canvas);
} catch (e) {
  showError();
  throw e;
}
const scene = new SPLAT.Scene();
const camera = new SPLAT.Camera();

// Bounded orbit camera: the scenes are captured from the front, so yaw, pitch,
// zoom and pan are clamped to a range around the capture view.
const cam = {
  home: null,                 // { target, yaw, pitch, radius }
  target: [0, 0, 0], yaw: 0, pitch: 0, radius: 5,      // desired
  s: { target: [0, 0, 0], yaw: 0, pitch: 0, radius: 5 }, // smoothed
  limits: { yaw: 0.45, pitch: 0.3, rMin: 1, rMax: 10, pan: 2 },
};

function setHome(target, radius, yaw, pitch) {
  cam.home = { target: [...target], yaw, pitch, radius };
  cam.limits = { yaw: 0.45, pitch: 0.3, rMin: radius * 0.35, rMax: radius * 1.35, pan: radius * 0.3 };
  resetCamera(true);
}

// Capture camera field of view, fitted so the canvas never shows more than the
// camera saw. setSize() re-uploads the projection after the focal length changes.
let fov = null; // { tanX, tanY } = half-extent / focal of the capture camera
function fitFov() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const f = fov ? Math.max((w / 2) / fov.tanX, (h / 2) / fov.tanY) : 1132;
  camera.data.fx = f;
  camera.data.fy = f;
  renderer.setSize(w, h);
}

function resetCamera(immediate = false) {
  const h = cam.home;
  if (!h) return;
  cam.target = [...h.target]; cam.yaw = h.yaw; cam.pitch = h.pitch; cam.radius = h.radius;
  if (immediate) cam.s = { target: [...h.target], yaw: h.yaw, pitch: h.pitch, radius: h.radius };
}

function clampCam() {
  const h = cam.home, L = cam.limits;
  cam.yaw = Math.min(h.yaw + L.yaw, Math.max(h.yaw - L.yaw, cam.yaw));
  cam.pitch = Math.min(h.pitch + L.pitch, Math.max(h.pitch - L.pitch, cam.pitch));
  cam.radius = Math.min(L.rMax, Math.max(L.rMin, cam.radius));
  for (let i = 0; i < 3; i++) {
    cam.target[i] = Math.min(h.target[i] + L.pan, Math.max(h.target[i] - L.pan, cam.target[i]));
  }
}

function updateCamera() {
  if (!cam.home) return;
  const k = 0.18;
  const s = cam.s;
  s.yaw += (cam.yaw - s.yaw) * k;
  s.pitch += (cam.pitch - s.pitch) * k;
  s.radius += (cam.radius - s.radius) * k;
  for (let i = 0; i < 3; i++) s.target[i] += (cam.target[i] - s.target[i]) * k;

  const cp = Math.cos(s.pitch);
  const px = s.target[0] + s.radius * Math.sin(s.yaw) * cp;
  const py = s.target[1] - s.radius * Math.sin(s.pitch);
  const pz = s.target[2] - s.radius * Math.cos(s.yaw) * cp;
  camera.position = new SPLAT.Vector3(px, py, pz);
  const dx = s.target[0] - px, dy = s.target[1] - py, dz = s.target[2] - pz;
  const len = Math.hypot(dx, dy, dz) || 1;
  camera.rotation = SPLAT.Quaternion.FromEuler(new SPLAT.Vector3(Math.asin(-dy / len), Math.atan2(dx / len, dz / len), 0));
}

function panBy(dxPx, dyPx) {
  const m = SPLAT.Matrix3.RotationFromQuaternion(camera.rotation).buffer;
  const right = [m[0], m[3], m[6]], up = [m[1], m[4], m[7]];
  const scale = cam.radius / camera.data.fx; // world units per pixel at the target
  for (let i = 0; i < 3; i++) cam.target[i] += (-dxPx * right[i] - dyPx * up[i]) * scale;
  clampCam();
}

// Pointer input: 1 pointer = orbit (or pan with right button / shift),
// 2 pointers = pinch zoom + pan.
const pointers = new Map();
let lastPinch = null;

function fadeHint() { hintEl.classList.add("faded"); }

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey });
  canvas.classList.add("dragging");
  lastPinch = null;
  fadeHint();
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 1) {
    if (p.pan) panBy(dx, dy);
    else { cam.yaw -= dx * 0.004; cam.pitch += dy * 0.004; clampCam(); }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (lastPinch) {
      cam.radius *= lastPinch.dist / dist;
      panBy(mid.x - lastPinch.mid.x, mid.y - lastPinch.mid.y);
    }
    lastPinch = { dist, mid };
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  lastPinch = null;
  if (!pointers.size) canvas.classList.remove("dragging");
};
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  cam.radius *= Math.exp(e.deltaY * 0.0012);
  clampCam();
  fadeHint();
}, { passive: false });
canvas.addEventListener("dblclick", () => resetCamera());
$("resetBtn").addEventListener("click", () => resetCamera());

// ---- Initial view ---------------------------------------------------------
// Start at the capture camera, orbiting around the point where its viewing
// ray reaches the scene's median depth.
function frameScene(splatData, view) {
  const pos = splatData.positions, n = splatData.vertexCount;
  const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n);
  for (let i = 0; i < n; i++) { xs[i] = pos[3 * i]; ys[i] = pos[3 * i + 1]; zs[i] = pos[3 * i + 2]; }
  xs.sort(); ys.sort(); zs.sort();
  const med = [xs[n >> 1], ys[n >> 1], zs[n >> 1]];
  const f = view.fwd, p = view.pos;
  const depth = Math.max(1, (med[0] - p[0]) * f[0] + (med[1] - p[1]) * f[1] + (med[2] - p[2]) * f[2]);
  const target = [p[0] + f[0] * depth, p[1] + f[1] * depth, p[2] + f[2] * depth];
  // Same spherical convention as updateCamera(): camera = target - depth * fwd
  setHome(target, depth, Math.atan2(-f[0], f[2]), Math.asin(f[1]));
  fov = { tanX: (view.w / 2) / view.fx, tanY: (view.h / 2) / view.fx };
  fitFov();
}

// ---- Loading + playback ----------------------------------------------------
let state = { scene: null, method: null };
let livePayload = null;
let staticSplat = null;
let dynamicSplat = null;
let frameCount = 130;
let currentFrame = 0;
let desiredFrame = 0;
let playing = true;
let loadToken = 0;

function setLoading(visible, status) {
  if (status) loadingStatusEl.textContent = status;
  loadingEl.classList.toggle("hidden", !visible);
}

function setPlaying(p) {
  playing = p;
  playBtn.setAttribute("aria-label", p ? "Pause" : "Play");
  playIcon.innerHTML = p
    ? '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'
    : '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/>';
}

// Splat buffers are owned by gsplat's worker until it replies.
const isBusy = () => (dynamicSplat ? dynamicSplat.data.detached : false);

function updatePickers() {
  scenePicker.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.scene === state.scene));
  methodPicker.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.method === state.method));
  for (const m of ["tac4dgs", "baseline"]) {
    const mb = SIZES_MB[m][state.scene];
    methodPicker.querySelector(`[data-size="${m}"]`).textContent = mb ? `${mb.toFixed(1)} MB` : "";
  }
}

async function load(sceneId, method) {
  const entry = SCENES.find((s) => s.id === sceneId) ?? SCENES[0];
  const sameScene = entry.id === state.scene;
  const keepFrame = sameScene ? currentFrame : 0;
  const token = ++loadToken;
  state = { scene: entry.id, method };
  updatePickers();
  history.replaceState(null, "", `?${new URLSearchParams({ ...(params.get("embed") ? { embed: "1" } : {}), scene: entry.id, method })}`);

  setLoading(true, `Loading ${entry.label}…`);
  const wasPlaying = playing;
  playing = false;

  let payload;
  try {
    payload = await loadBitstreamPayload(`./data/${method}_${entry.id}`, (loaded, of, status) => {
      if (token === loadToken) setLoading(true, status ?? `Decoding bitstream… ${loaded}/${of}`);
    });
  } catch (e) {
    console.error(e);
    if (token === loadToken) showError("The scene data could not be loaded. Please check your connection and reload the page.");
    return;
  }
  if (token !== loadToken) return; // a newer selection superseded this one

  scene.reset();
  dynamicSplat = null;
  livePayload = payload;
  frameCount = entry.frames;

  const st = decodeStaticFrame(livePayload, 0);
  staticSplat = new SPLAT.Splat(new SPLAT.SplatData(st.vertexCount, st.positions, st.rotations, st.scales, st.colors));
  scene.addObject(staticSplat);
  if (!sameScene) frameScene(staticSplat.data, entry.view);

  currentFrame = -1;
  applyFrame(Math.min(keepFrame, frameCount - 1));

  const total = livePayload.config.n_static + livePayload.config.n_dynamic;
  statSplats.textContent = total.toLocaleString("en-US");
  scrub.max = String(frameCount - 1);
  const methodName = method === "tac4dgs" ? "TAC-4DGS" : "RD4DGS";
  subtitleEl.textContent = `${entry.label} (${entry.dataset}) · ${methodName} · decoded live from the bitstream`;

  setLoading(false);
  setPlaying(sameScene ? wasPlaying : true);
}

function applyFrame(i) {
  const data = decodeDynamicFrame(livePayload, i);
  if (!data) return;
  if (!dynamicSplat) {
    dynamicSplat = new SPLAT.Splat(new SPLAT.SplatData(data.vertexCount, data.positions, data.rotations, data.scales, data.colors));
    scene.addObject(dynamicSplat);
  } else {
    dynamicSplat.data.reattach(
      data.positions.buffer, data.rotations.buffer, data.scales.buffer, data.colors.buffer,
      new Uint8Array(data.vertexCount).buffer,
    );
    dynamicSplat.data.changed = true;
    dynamicSplat.raiseChangeEvent();
  }
  currentFrame = i;
  desiredFrame = i;
  scrub.value = String(i);
  frameLabel.textContent = `${i} / ${frameCount - 1}`;
}

// ---- Render loop ------------------------------------------------------------
let tickCount = 0, lastT = 0, avgTickMs = 1000 / 60;
const advances = [];

function tick(t) {
  updateCamera();
  if (lastT) {
    const dt = t - lastT;
    if (dt > 0 && dt < 100) avgTickMs = avgTickMs * 0.9 + dt * 0.1;
  }
  lastT = t;
  tickCount++;

  if (livePayload) {
    const every = Math.max(1, Math.round(1000 / PLAYBACK_FPS / avgTickMs));
    if (playing && tickCount % every === 0 && !isBusy()) desiredFrame = (currentFrame + 1) % frameCount;
    if (!isBusy() && desiredFrame !== currentFrame) {
      applyFrame(desiredFrame);
      if (playing) {
        advances.push(t);
        if (advances.length > 30) advances.shift();
        if (advances.length > 1) statFps.textContent = (((advances.length - 1) * 1000) / (t - advances[0])).toFixed(0);
      }
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---- UI wiring ----------------------------------------------------------------
playBtn.addEventListener("click", () => setPlaying(!playing));
scrub.addEventListener("input", () => { setPlaying(false); desiredFrame = Number(scrub.value); });
scenePicker.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scene]");
  if (b && b.dataset.scene !== state.scene) load(b.dataset.scene, state.method);
});
methodPicker.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-method]");
  if (b && b.dataset.method !== state.method) load(state.scene, b.dataset.method);
});
$("fullscreenBtn").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
window.addEventListener("keydown", (e) => {
  if (e.target.closest("input, button")) return;
  if (e.code === "Space") { e.preventDefault(); setPlaying(!playing); }
  if (e.key === "r" || e.key === "R") resetCamera();
});
window.addEventListener("resize", fitFov);
setTimeout(fadeHint, 8000);

// ---- Boot ----------------------------------------------------------------------
const startScene = SCENES.some((s) => s.id === params.get("scene")) ? params.get("scene") : SCENES[0].id;
const startMethod = params.get("method") === "baseline" ? "baseline" : "tac4dgs";
load(startScene, startMethod);
