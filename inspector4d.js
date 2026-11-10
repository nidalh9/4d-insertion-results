/* Inspector4D — an interactive 4D view of a Studio insertion result: the placed object's real Gaussians in every frame,
   its appearance versions (placed / SDS refined), the scene, the exact TTM camera and the recorded scene orbit.

   Usage (no dependencies):
     <script src="inspector4d.js"></script>
     const view = Inspector4D.create(containerElement, {
       manifest: 'path/to/manifest.json',      // URL, or the parsed manifest object (then give `resolve`)
       resolve: name => url,                   // optional: file name in the manifest -> URL (default: next to the manifest)
       encoding: 'binary' | 'base64',          // optional: base64 when the host serves the .bin files as base64 text
       title: 'Yellow tang · Underwater reef', // optional
       version: 'refined', camera: 'free',     // optional initial version id and camera ('free' | 'ttm' | 'orbit')
     });
     view.destroy();
   Data: viewer_export.py (schema studio_4d_inspector v1). Rendering: depth-sorted alpha blending of 2D-projected
   Gaussians (EWA, 0.3 px low-pass as in gsplat), premultiplied "over", HDR accumulation, clamped display. */
(function (global) {
'use strict';

const CSS = `
.i4d { position: relative; width: 100%; height: 100%; min-height: 320px; overflow: hidden; container-type: inline-size; display: flex; flex-direction: column; background: #0b1114; color: #dfe8ea;
  font: 13px/1.35 "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; outline: none; user-select: none; -webkit-user-select: none; }
.i4d *, .i4d *::before, .i4d *::after { box-sizing: border-box; }
.i4d [hidden] { display: none !important; }
.i4d-stage { position: relative; flex: 1 1 auto; min-height: 200px; overflow: hidden; }
.i4d-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.i4d-canvas.i4d-drag { cursor: grabbing; }
.i4d-frame { position: absolute; border: 1px dashed rgba(230, 190, 110, 0.6); pointer-events: none; }
.i4d-top { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #22404a; }
.i4d-title { font-weight: 600; font-size: 14px; letter-spacing: 0.01em; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
.i4d-title small { font-weight: 400; color: #9fb4b9; margin-left: 8px; font-size: 12px; }
.i4d-chips { display: flex; gap: 6px; flex-wrap: wrap; pointer-events: auto; }
.i4d-btn { border: 1px solid #27434c; background: rgba(13, 30, 36, 0.88); color: #dfe8ea; font: 500 12px/1 inherit; font-family: inherit;
  padding: 6px 9px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.i4d-btn:hover { border-color: #7f9aa1; }
.i4d-btn[aria-pressed="true"] { border-color: #e6be6e; background: rgba(28, 52, 60, 0.95); }
.i4d-btn .i4d-key { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 10.5px; color: #8fa7ad; margin-right: 5px; }
.i4d-btn:focus-visible { outline: 2px solid #e6be6e; outline-offset: 1px; }
.i4d-panel { flex: none; background: #09161b; border-top: 1px solid #22404a; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.i4d-panel h3 { margin: 0; font-size: 13px; font-weight: 600; }
.i4d-panel p { margin: 0; color: #a7bbc0; font-size: 12px; }
.i4d-panel dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12px; max-width: 520px; }
.i4d-panel dt { color: #8fa7ad; } .i4d-panel dd { margin: 0; text-align: right; font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
.i4d-panel[data-collapsed="true"] { display: none; }
.i4d-panel-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.i4d-bottom { flex: none; display: flex; flex-direction: column; gap: 6px; background: #09161b; border-top: 1px solid #22404a; padding: 8px 12px; }
.i4d-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.i4d-time { flex: 1 1 200px; min-width: 120px; }
.i4d-time input { width: 100%; accent-color: #e6be6e; margin: 0; }
.i4d-flabel { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 12px; font-variant-numeric: tabular-nums; min-width: 128px; }
.i4d-sep { width: 1px; align-self: stretch; background: #22404a; }
.i4d-status { margin-left: auto; color: #8fa7ad; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.i4d-loading { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.i4d-loading div { background: rgba(9, 22, 27, 0.92); border: 1px solid #22404a; padding: 10px 14px; border-radius: 8px; }
@container (max-width: 640px) { .i4d-flabel { min-width: 0; } .i4d-sep { display: none; } .i4d-title small { display: none; } }
`;

// ------------------------------------------------------------------ helpers
const F16 = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h >> 15, e = (h >> 10) & 31, m = h & 1023;
    const v = e === 0 ? m * 5.960464477539063e-8 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * Math.pow(2, e - 15);
    t[h] = s ? -v : v;
  }
  return t;
})();
const SQ2 = Math.SQRT2;
const OTHERS = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];
function unpackQuat(u, out) {      // smallest-three u32 -> wxyz (viewer_export.pack_quat)
  const i = u >>> 30;
  const a = (((u >>> 20) & 1023) / 1022 - 0.5) * SQ2, b = (((u >>> 10) & 1023) / 1022 - 0.5) * SQ2, c = ((u & 1023) / 1022 - 0.5) * SQ2;
  const big = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
  const o = OTHERS[i];
  out[i] = big; out[o[0]] = a; out[o[1]] = b; out[o[2]] = c;
  const n = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  out[0] /= n; out[1] /= n; out[2] /= n; out[3] /= n;
}
function quatRows(w, x, y, z, R) { // row-major rotation, the Studio's quat_to_R
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - w * z); R[2] = 2 * (x * z + w * y);
  R[3] = 2 * (x * y + w * z); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - w * x);
  R[6] = 2 * (x * z - w * y); R[7] = 2 * (y * z + w * x); R[8] = 1 - 2 * (x * x + y * y);
}
function covariance(R, s0, s1, s2, out, o) {  // Σ = R diag(s²) Rᵀ -> xx xy xz yy yz zz
  const a0 = s0 * s0, a1 = s1 * s1, a2 = s2 * s2;
  out[o] = R[0] * R[0] * a0 + R[1] * R[1] * a1 + R[2] * R[2] * a2;
  out[o + 1] = R[0] * R[3] * a0 + R[1] * R[4] * a1 + R[2] * R[5] * a2;
  out[o + 2] = R[0] * R[6] * a0 + R[1] * R[7] * a1 + R[2] * R[8] * a2;
  out[o + 3] = R[3] * R[3] * a0 + R[4] * R[4] * a1 + R[5] * R[5] * a2;
  out[o + 4] = R[3] * R[6] * a0 + R[4] * R[7] * a1 + R[5] * R[8] * a2;
  out[o + 5] = R[6] * R[6] * a0 + R[7] * R[7] * a1 + R[8] * R[8] * a2;
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = a => mul3(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function b64ToBuffer(text) {
  text = text.trim();
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text).buffer;
  const bin = atob(text), n = bin.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ------------------------------------------------------------------ sorting (far -> near; scene order cached per view, merged with the object)
function makeSorter() {
  // the same code runs in the worker (via toString) and, as a fallback, on the main thread
  let pos = null, sceneKey = '', sIdx = null, sDep = null;
  function depthSort(first, count, a, b, c, d) {
    const dep = new Float32Array(count), idx = new Uint32Array(count);
    let n = 0, zmin = Infinity, zmax = -Infinity;
    for (let i = first, e = first + count; i < e; i++) {
      const z = a * pos[3 * i] + b * pos[3 * i + 1] + c * pos[3 * i + 2] + d;
      if (z > 0.01) { dep[n] = z; idx[n++] = i; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
    }
    // 16-bit keys on log depth: resolution where it matters (near the camera) in scenes that reach 1000 units
    const B = 65536, counts = new Uint32Array(B), keys = new Uint16Array(n);
    const lmax = Math.log(zmax), s = (B - 1) / Math.max(lmax - Math.log(zmin), 1e-9);
    for (let j = 0; j < n; j++) { const k = ((lmax - Math.log(dep[j])) * s) | 0; keys[j] = k; counts[k]++; }
    for (let q = 1; q < B; q++) counts[q] += counts[q - 1];
    const oIdx = new Uint32Array(n), oDep = new Float32Array(n);
    for (let j = n - 1; j >= 0; j--) { const p = --counts[keys[j]]; oIdx[p] = idx[j]; oDep[p] = dep[j]; }
    return [oIdx, oDep];
  }
  return {
    init(n) { pos = new Float32Array(n * 3); sceneKey = ''; },
    attach(arr) { pos = arr; sceneKey = ''; },
    set(offset, objCap, arr) { pos.set(arr, offset * 3); if (offset >= objCap) sceneKey = ''; },
    invalidate() { sceneKey = ''; },
    sort(view, objCount, sceneFirst, sceneCount) {
      const [a, b, c, d] = view;
      const [oIdx, oDep] = depthSort(0, objCount, a, b, c, d);
      if (!(sceneCount > 0)) return oIdx;
      const key = view.map(v => v.toFixed(6)).join(',') + ':' + sceneFirst + ':' + sceneCount;
      if (key !== sceneKey) { [sIdx, sDep] = depthSort(sceneFirst, sceneCount, a, b, c, d); sceneKey = key; }
      const out = new Uint32Array(oIdx.length + sIdx.length);
      let i = 0, j = 0, k = 0;
      while (i < oIdx.length && j < sIdx.length) out[k++] = oDep[i] >= sDep[j] ? oIdx[i++] : sIdx[j++];
      while (i < oIdx.length) out[k++] = oIdx[i++];
      while (j < sIdx.length) out[k++] = sIdx[j++];
      return out;
    },
  };
}
const WORKER_SRC = `const makeSorter = ${makeSorter.toString()};
const S = makeSorter();
self.onmessage = (e) => {
  const m = e.data;
  if (m.kind === 'init') S.init(m.n);
  else if (m.kind === 'set') S.set(m.offset, m.objCap, new Float32Array(m.buf));
  else if (m.kind === 'sort') { const out = S.sort(m.view, m.objCount, m.sceneFirst, m.sceneCount); self.postMessage({ id: m.id, buf: out.buffer, n: out.length }, [out.buffer]); }
};`;

// ------------------------------------------------------------------ shaders
const SH_GLSL = `uvec4 W0, W1, W2;
float cf(int j) {   // signed byte j of the splat's 48-byte SH record
  int w = j >> 2; uint word = w < 4 ? W0[w] : (w < 8 ? W1[w - 4] : W2[w - 8]);
  uint v = (word >> uint((j & 3) * 8)) & 255u;
  return float(v) - (v > 127u ? 256.0 : 0.0);
}
vec3 cv(int k) { int j = 3 * (k - 1); return vec3(cf(j), cf(j + 1), cf(j + 2)); }
vec3 shRest(int i, vec3 centre) {   // bands 1-3 of the Studio's SH colour (gsplat convention), DC is in the base colour
  ivec2 sb = ivec2((i & 511) * 3, i >> 9);
  W0 = texelFetch(u_sh, sb, 0); W1 = texelFetch(u_sh, sb + ivec2(1, 0), 0); W2 = texelFetch(u_sh, sb + ivec2(2, 0), 0);
  float sc = unpackHalf2x16((W2.w >> 8u) & 65535u).x / 127.0;
  vec3 d = normalize(centre - u_campos);
  float x = d.x, y = d.y, z = d.z, xx = x * x, yy = y * y, zz = z * z;
  vec3 r = -0.4886025119029199 * y * cv(1) + 0.4886025119029199 * z * cv(2) - 0.4886025119029199 * x * cv(3);
  r += 1.0925484305920792 * x * y * cv(4) - 1.0925484305920792 * y * z * cv(5) + 0.31539156525252005 * (2.0 * zz - xx - yy) * cv(6)
     - 1.0925484305920792 * x * z * cv(7) + 0.5462742152960396 * (xx - yy) * cv(8);
  r += -0.5900435899266435 * y * (3.0 * xx - yy) * cv(9) + 2.890611442640554 * x * y * z * cv(10)
     - 0.4570457994644658 * y * (4.0 * zz - xx - yy) * cv(11) + 0.3731763325901154 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * cv(12)
     - 0.4570457994644658 * x * (4.0 * zz - xx - yy) * cv(13) + 1.445305721320277 * z * (xx - yy) * cv(14)
     - 0.5900435899266435 * x * (xx - 3.0 * yy) * cv(15);
  return r * sc;
}
`;
const SPLAT_VS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_data; uniform sampler2D u_objPos; uniform int u_objCount; uniform mat3 u_objG; uniform float u_objS2;
uniform highp usampler2D u_sh; uniform int u_shOn; uniform vec3 u_campos; uniform sampler2D u_col;
uniform mat4 u_view; uniform vec4 u_intr; uniform vec2 u_size; uniform vec2 u_clip;
in vec2 a_pos; in uint a_index;
out vec4 v_col; out vec2 v_pos;
${SH_GLSL}
void main() {
  int i = int(a_index);
  ivec2 b = ivec2((i & 511) << 2, i >> 9);
  vec4 t0 = texelFetch(u_data, b, 0);
  bool obj = i < u_objCount;
  vec3 centre = obj ? texelFetch(u_objPos, ivec2(i & 2047, i >> 11), 0).xyz : t0.xyz;
  vec4 cam = u_view * vec4(centre, 1.0);
  if (cam.z < u_clip.x || cam.z > u_clip.y) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }   // the camera's near / far
  vec4 t1 = texelFetch(u_data, b + ivec2(1, 0), 0);
  vec4 t2 = texelFetch(u_data, b + ivec2(2, 0), 0);
  vec4 t3 = texelFetch(u_data, b + ivec2(3, 0), 0);
  mat3 V = mat3(t1.w, t2.x, t2.y, t2.x, t2.z, t2.w, t2.y, t2.w, t3.x);
  if (obj) V = u_objS2 * (u_objG * V * transpose(u_objG));
  float iz = 1.0 / cam.z;
  vec2 pix = vec2(u_intr.x * cam.x * iz + u_intr.z, u_intr.y * cam.y * iz + u_intr.w);
  // gsplat's persp_proj: the Jacobian is taken at the mean clamped to 1.3x the field of view
  float tfx = 0.5 * u_size.x / u_intr.x, tfy = 0.5 * u_size.y / u_intr.y;
  float tx = cam.z * clamp(cam.x * iz, -(u_intr.z / u_intr.x + 0.3 * tfx), (u_size.x - u_intr.z) / u_intr.x + 0.3 * tfx);
  float ty = cam.z * clamp(cam.y * iz, -(u_intr.w / u_intr.y + 0.3 * tfy), (u_size.y - u_intr.w) / u_intr.y + 0.3 * tfy);
  mat3 J = mat3(u_intr.x * iz, 0.0, 0.0, 0.0, u_intr.y * iz, 0.0, -u_intr.x * tx * iz * iz, -u_intr.y * ty * iz * iz, 0.0);
  mat3 T = J * mat3(u_view);
  mat3 C = T * V * transpose(T);
  float a = C[0][0] + 0.3, c = C[0][1], d = C[1][1] + 0.3;
  float mid = 0.5 * (a + d), rad = length(vec2(0.5 * (a - d), c));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  vec2 ev = vec2(c, l1 - a);
  ev = dot(ev, ev) > 1e-20 ? normalize(ev) : vec2(1.0, 0.0);
  float r1 = sqrt(2.0 * l1), r2 = sqrt(2.0 * l2);
  float reach = 2.4 * r1;
  if (pix.x + reach < 0.0 || pix.x - reach > u_size.x || pix.y + reach < 0.0 || pix.y - reach > u_size.y) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  // no small cap on the footprint: a Gaussian just in front of the camera can cover the view from far outside it
  vec2 p = pix + a_pos.x * min(r1, 262144.0) * ev + a_pos.y * min(r2, 262144.0) * vec2(ev.y, -ev.x);   // a_pos in [-2.4, 2.4]
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
  vec3 rgb = vec3(t0.w, t1.x, t1.y);
  if (!obj && u_shOn == 2) rgb = texelFetch(u_col, ivec2(i & 2047, i >> 11), 0).rgb;
  else if (!obj && u_shOn == 1) rgb = max(rgb + shRest(i, centre), 0.0);
  v_col = vec4(rgb, t1.z);
  v_pos = a_pos;
}`;
const SPLAT_FS = `#version 300 es
precision highp float;
in vec4 v_col; in vec2 v_pos; out vec4 o;
void main() {
  float A = -dot(v_pos, v_pos);
  if (A < -5.76) discard;
  float alpha = min(0.999, exp(A) * v_col.a);   // gsplat's cap
  if (alpha < 1.0 / 255.0) discard;
  o = vec4(v_col.rgb * alpha, alpha);
}`;
const COLOUR_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_data; uniform highp usampler2D u_sh; uniform vec3 u_campos; uniform int u_first; uniform int u_end;
out vec4 o;
${SH_GLSL}
void main() {   // one fragment per scene splat: its SH colour seen from the current camera centre (the Studio's rule)
  int i = int(gl_FragCoord.y) * 2048 + int(gl_FragCoord.x);
  if (i < u_first || i >= u_end) { o = vec4(0.0); return; }
  ivec2 b = ivec2((i & 511) << 2, i >> 9);
  vec4 t0 = texelFetch(u_data, b, 0), t1 = texelFetch(u_data, b + ivec2(1, 0), 0);
  o = vec4(max(vec3(t0.w, t1.x, t1.y) + shRest(i, t0.xyz), 0.0), 1.0);
}`;
const BLIT_VS = `#version 300 es
out vec2 uv; void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const BLIT_FS = `#version 300 es
precision highp float; uniform sampler2D u_img; in vec2 uv; out vec4 o;
void main() { o = vec4(clamp(texture(u_img, uv).rgb, 0.0, 1.0), 1.0); }`;

let cssInstalled = false;
function installCSS() {
  if (cssInstalled) return;
  const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); cssInstalled = true;
}

// ------------------------------------------------------------------ the inspector
function create(container, opts) {
  opts = opts || {};
  installCSS();
  const root = document.createElement('div');
  root.className = 'i4d'; root.tabIndex = 0;
  root.innerHTML = `
    <div class="i4d-top"><div class="i4d-title"></div><div class="i4d-chips" role="group" aria-label="Version"></div></div>
    <div class="i4d-stage">
      <canvas class="i4d-canvas" aria-label="Interactive 4D view. Drag to orbit, scroll or pinch to zoom, right-drag or two fingers to pan."></canvas>
      <div class="i4d-frame" hidden></div>
      <div class="i4d-loading"><div class="i4d-ltext">Loading…</div></div>
    </div>
    <div class="i4d-bottom">
      <div class="i4d-row">
        <button class="i4d-btn i4d-play" type="button" aria-pressed="false">Play</button>
        <div class="i4d-time"><input type="range" min="0" max="0" step="1" value="0" aria-label="Frame"></div>
        <span class="i4d-flabel">Frame –</span>
      </div>
      <div class="i4d-row">
        <button class="i4d-btn" data-cam="ttm" type="button" aria-pressed="false" title="The fixed camera of the TTM video (T)">TTM camera</button>
        <button class="i4d-btn" data-cam="orbit" type="button" aria-pressed="false" title="The recorded scene-centre orbit, one camera per frame, as in the orbit video (O)">Scene orbit</button>
        <button class="i4d-btn" data-cam="free" type="button" aria-pressed="false" title="Free camera around the object (F)">Free</button>
        <button class="i4d-btn i4d-close" type="button" title="Free camera close to the object">Close-up</button>
        <span class="i4d-sep"></span>
        <button class="i4d-btn i4d-scene" type="button" aria-pressed="true" title="Show the scene (S)">Scene</button>
        <button class="i4d-btn i4d-follow" type="button" aria-pressed="true" title="Free camera keeps aiming at the object and stays where you put it">Aim at object</button>
        <button class="i4d-btn i4d-bg" type="button" hidden>Background: grey</button>
        <span class="i4d-status">Loading…</span>
        <button class="i4d-btn i4d-ptoggle" type="button" aria-expanded="true">Hide info</button>
      </div>
    </div>
    <aside class="i4d-panel" data-collapsed="false">
      <div class="i4d-panel-head"><h3 class="i4d-vname">…</h3></div>
      <div class="i4d-body"><p class="i4d-vdesc"></p><dl class="i4d-facts"></dl></div>
    </aside>`;
  container.appendChild(root);
  const q = sel => root.querySelector(sel);
  const canvas = q('.i4d-canvas'), statusEl = q('.i4d-status'), slider = q('.i4d-time input');
  const setStatus = t => { statusEl.textContent = t; if (opts.onStatus) opts.onStatus(t); };
  const fail = msg => { q('.i4d-ltext').textContent = msg; q('.i4d-loading').hidden = false; setStatus(msg); };
  let destroyed = false;
  const abort = new AbortController();
  const assertAlive = () => { if (destroyed) throw new DOMException("Viewer closed", "AbortError"); };

  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  const api = { destroy, ready: null, renderExact: null, setVersion: null, setFrame: null, setCamera: null, state: null };
  if (!gl) { fail('This view needs WebGL 2, which this browser does not offer.'); api.ready = Promise.reject(new Error('no webgl2')); api.destroy = () => { destroyed = true; abort.abort(); root.remove(); }; return api; }
  const hdr = !!gl.getExtension('EXT_color_buffer_float');
  const MAXTEX = gl.getParameter(gl.MAX_TEXTURE_SIZE);

  // ---------------- data
  let M = null, OBJ = null, SCN = null, SM = null; // job manifest, decoded object, scene state, scene manifest entry
  let sceneResolve = null, shData = null, DYN = null;
  const VER = {};                                 // decoded versions
  let OBJCAP = 0, SCENE0 = 0, ROWS = 0, texData = null, posAll = null, objPos4 = null;
  const manifestURL = typeof opts.manifest === 'string' ? new URL(opts.manifest, document.baseURI).href : null;
  const resolve = opts.resolve || (name => new URL(name, manifestURL).href);
  async function fetchOne(url, onProgress) {
    assertAlive();
    const r = await fetch(url, { signal: abort.signal });
    if (!r.ok) throw new Error(`could not load ${url.split('/').pop()} (${r.status})`);
    const total = +r.headers.get('content-length') || 0;
    if (!(r.body && onProgress)) return new Uint8Array(await r.arrayBuffer());
    const reader = r.body.getReader(), chunks = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (total) onProgress(Math.min(1, got / total)); }
    const bytes = new Uint8Array(got); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    onProgress(1);
    return bytes;
  }
  // binary file by name; base64 hosting ships <name>.b64.txt, and large files may ship as <name>.p<k>[.b64.txt] parts
  async function fetchBuffer(name, onProgress, via) {
    const res = via || resolve, b64 = opts.encoding === 'base64', n = (opts.parts && opts.parts[name]) || 0;
    const decode = bytes => b64 ? new Uint8Array(b64ToBuffer(new TextDecoder('ascii').decode(bytes))) : bytes;
    if (!n) return decode(await fetchOne(res(b64 ? name + '.b64.txt' : name), onProgress)).buffer;
    const pieces = [];
    for (let k = 0; k < n; k++) pieces.push(decode(await fetchOne(res(`${name}.p${k}` + (b64 ? '.b64.txt' : '')), onProgress && (p => onProgress((k + p) / n)))));
    const out = new Uint8Array(pieces.reduce((s, x) => s + x.length, 0)); let o = 0;
    for (const x of pieces) { out.set(x, o); o += x.length; }
    return out.buffer;
  }
  const view = (buf, layout, name, Type) => {
    const L = layout[name];
    return new Type(buf, L.offset, L.bytes / Type.BYTES_PER_ELEMENT);
  };

  function decodeObject(buf) {
    const o = M.object, T = M.T, N = o.N, L = o.layout;
    const pos = view(buf, L, 'position', Uint16Array);
    const rot = view(buf, L, 'rotation', Uint32Array);
    const lsc = view(buf, L, 'log_scale', Uint16Array);
    const opRaw = o.opacity.mode === 'static' ? view(buf, L, 'opacity', Uint16Array) : new Uint8Array(buf, L.opacity.offset, L.opacity.bytes);
    const lmin = o.scale.log_min, lsp = (o.scale.log_max - o.scale.log_min) / 65535;
    const rotGlobal = o.rotation.mode === 'global', scGlobal = o.scale.mode === 'global';
    let iso = scGlobal;
    if (scGlobal) for (const f of o.scale.frame_factor) if (Math.abs(f[1] / f[0] - 1) > 1e-4 || Math.abs(f[2] / f[0] - 1) > 1e-4) iso = false;
    const gpuPath = rotGlobal && iso && o.opacity.mode === 'static';
    // static per-Gaussian parts
    const sc0 = scGlobal ? new Float32Array(3 * N) : null;
    if (sc0) for (let i = 0; i < 3 * N; i++) sc0[i] = Math.exp(lmin + lsp * lsc[i]);
    const q0 = rotGlobal ? new Float32Array(4 * N) : null;
    if (q0) { const t = [0, 0, 0, 0]; for (let i = 0; i < N; i++) { unpackQuat(rot[i], t); q0.set(t, 4 * i); } }
    const opStatic = o.opacity.mode === 'static' ? new Float32Array(N) : null;
    if (opStatic) for (let i = 0; i < N; i++) opStatic[i] = opRaw[i] / 65535;
    const lo = o.position.lo, hi = o.position.hi;
    return { T, N, pos, rot, lsc, opRaw, lmin, lsp, rotGlobal, scGlobal, iso, gpuPath, sc0, q0, opStatic, lo, hi };
  }
  function decodeVersion(buf, meta) {
    const N = meta.N, L = meta.layout;
    const rgb16 = view(buf, L, 'rgb', Uint16Array), d16 = view(buf, L, 'opacity_logit_delta', Uint16Array);
    const rgb = new Float32Array(3 * N), e = new Float32Array(N);
    for (let i = 0; i < 3 * N; i++) rgb[i] = F16[rgb16[i]];
    for (let i = 0; i < N; i++) e[i] = Math.exp(F16[d16[i]]);
    return { rgb, e };
  }

  // per-frame object positions (and covariance on the CPU path) into objPos4 / texData
  const Rm = new Float32Array(9), qt = [0, 0, 0, 0], cov = new Float32Array(6);
  let objG = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), objS2 = 1;
  function framePositions(t) {
    const O = OBJ, N = O.N, lo = O.lo[t], hi = O.hi[t], base = 3 * N * t;
    const sx = (hi[0] - lo[0]) / 65535, sy = (hi[1] - lo[1]) / 65535, sz = (hi[2] - lo[2]) / 65535;
    for (let i = 0; i < N; i++) {
      const k = base + 3 * i;
      const x = lo[0] + O.pos[k] * sx, y = lo[1] + O.pos[k + 1] * sy, z = lo[2] + O.pos[k + 2] * sz;
      objPos4[4 * i] = x; objPos4[4 * i + 1] = y; objPos4[4 * i + 2] = z;
      posAll[3 * i] = x; posAll[3 * i + 1] = y; posAll[3 * i + 2] = z;
    }
  }
  function writeObjectRows(t, v) {   // colour, opacity and covariance of every object splat (frame t; v = version)
    const O = OBJ, N = O.N, d = texData;
    for (let i = 0; i < N; i++) {
      let s0, s1, s2;
      if (O.rotGlobal) { qt[0] = O.q0[4 * i]; qt[1] = O.q0[4 * i + 1]; qt[2] = O.q0[4 * i + 2]; qt[3] = O.q0[4 * i + 3]; }
      else unpackQuat(O.rot[t * N + i], qt);
      if (O.gpuPath) { s0 = O.sc0[3 * i]; s1 = O.sc0[3 * i + 1]; s2 = O.sc0[3 * i + 2]; }
      else if (O.scGlobal) { const f = M.object.scale.frame_factor[t]; s0 = O.sc0[3 * i] * f[0]; s1 = O.sc0[3 * i + 1] * f[1]; s2 = O.sc0[3 * i + 2] * f[2]; }
      else { const k = 3 * (t * N + i); s0 = Math.exp(O.lmin + O.lsp * O.lsc[k]); s1 = Math.exp(O.lmin + O.lsp * O.lsc[k + 1]); s2 = Math.exp(O.lmin + O.lsp * O.lsc[k + 2]); }
      if (!O.gpuPath && O.rotGlobal) {   // rotation = G[t] (x) q0
        const G = M.object.rotation.frame_quat_wxyz[t];
        const w1 = G[0], x1 = G[1], y1 = G[2], z1 = G[3], w2 = qt[0], x2 = qt[1], y2 = qt[2], z2 = qt[3];
        qt[0] = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2; qt[1] = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2;
        qt[2] = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2; qt[3] = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2;
      }
      quatRows(qt[0], qt[1], qt[2], qt[3], Rm);
      covariance(Rm, s0, s1, s2, cov, 0);
      const Op = O.opStatic ? O.opStatic[i] : O.opRaw[t * N + i] / 255, e = v.e[i];
      const a = Op * e / (1 - Op + Op * e);
      const b = ((i >> 9) * 2048 + ((i & 511) << 2)) * 4;
      d[b + 3] = v.rgb[3 * i]; d[b + 4] = v.rgb[3 * i + 1]; d[b + 5] = v.rgb[3 * i + 2]; d[b + 6] = a;
      d[b + 7] = cov[0]; d[b + 8] = cov[1]; d[b + 9] = cov[2]; d[b + 10] = cov[3]; d[b + 11] = cov[4]; d[b + 12] = cov[5];
    }
  }
  function frameUniforms(t) {
    if (!OBJ.gpuPath) { objG = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); objS2 = 1; return; }
    const G = M.object.rotation.frame_quat_wxyz[t], f = M.object.scale.frame_factor[t][0];
    quatRows(G[0], G[1], G[2], G[3], Rm);
    objG = new Float32Array([Rm[0], Rm[3], Rm[6], Rm[1], Rm[4], Rm[7], Rm[2], Rm[5], Rm[8]]);   // column major
    objS2 = f * f;
  }

  function buildScene(parts) {
    const S = SM, lmin = S.log_min, lsp = (S.log_max - S.log_min) / 1023, block = S.block, d = texData, sh3 = S.colour_mode === 'sh3';
    const C0 = 0.28209479177387814;
    let k = SCENE0;
    for (const { buf, info } of parts) {
      const L = info.layout, n = info.count;
      const bb = view(buf, L, 'block_bounds', Float32Array), pq = view(buf, L, 'position', Uint16Array);
      const rot = view(buf, L, 'rotation', Uint32Array), ls = view(buf, L, 'log_scale', Uint32Array);
      const rgb = sh3 ? null : view(buf, L, 'rgb9e5', Uint32Array);
      const dc = sh3 ? view(buf, L, 'sh_dc', Uint16Array) : null, rest = sh3 ? view(buf, L, 'sh_rest', Uint32Array) : null;
      const op = new Uint8Array(buf, L.opacity.offset, L.opacity.bytes);
      for (let i = 0; i < n; i++, k++) {
        const bi = 6 * ((i / block) | 0);
        const x = bb[bi] + pq[3 * i] / 65535 * (bb[bi + 3] - bb[bi]);
        const y = bb[bi + 1] + pq[3 * i + 1] / 65535 * (bb[bi + 4] - bb[bi + 1]);
        const z = bb[bi + 2] + pq[3 * i + 2] / 65535 * (bb[bi + 5] - bb[bi + 2]);
        unpackQuat(rot[i], qt); quatRows(qt[0], qt[1], qt[2], qt[3], Rm);
        const u = ls[i];
        covariance(Rm, Math.exp(lmin + lsp * ((u >>> 20) & 1023)), Math.exp(lmin + lsp * ((u >>> 10) & 1023)), Math.exp(lmin + lsp * (u & 1023)), cov, 0);
        const b = ((k >> 9) * 2048 + ((k & 511) << 2)) * 4;
        let r, g, bl;
        if (sh3) {
          r = C0 * F16[dc[3 * i]] + 0.5; g = C0 * F16[dc[3 * i + 1]] + 0.5; bl = C0 * F16[dc[3 * i + 2]] + 0.5;
          const sb = ((k >> 9) * 1536 + (k & 511) * 3) * 4;
          for (let w = 0; w < 12; w++) shData[sb + w] = rest[12 * i + w];
        } else {
          const c = rgb[i], es = Math.pow(2, (c >>> 27) - 24);
          r = (c & 511) * es; g = ((c >>> 9) & 511) * es; bl = ((c >>> 18) & 511) * es;
        }
        d[b] = x; d[b + 1] = y; d[b + 2] = z; d[b + 3] = r;
        d[b + 4] = g; d[b + 5] = bl; d[b + 6] = op[i] / 255; d[b + 7] = cov[0];
        d[b + 8] = cov[1]; d[b + 9] = cov[2]; d[b + 10] = cov[3]; d[b + 11] = cov[4]; d[b + 12] = cov[5];
        posAll[3 * k] = x; posAll[3 * k + 1] = y; posAll[3 * k + 2] = z;
      }
    }
    return k - SCENE0;
  }

  // animated scene (Mango node cache): base Gaussians skinned to node tracks at the object's frame time
  function buildDynamicScene(buf, tbuf) {
    const S = SM, n = S.files[0].count, L = S.files[0].layout, TL = S.dynamic.tracks.layout, d = texData;
    const C0 = 0.28209479177387814;
    const D = { n, k: S.dynamic.k, nodes: S.dynamic.nodes, times: S.dynamic.time_s,
      xyz: view(buf, L, 'xyz', Float32Array), rot: view(buf, L, 'rotation_raw', Float32Array), sc: view(buf, L, 'scales', Float32Array),
      idx: view(buf, L, 'node_index', L.node_index.dtype === 'uint32' ? Uint32Array : Uint16Array), w: view(buf, L, 'node_weight', Float32Array), mask: view(buf, L, 'motion_mask', Float32Array),
      Txyz: view(tbuf, TL, 'd_xyz', Float32Array), Trot: view(tbuf, TL, 'd_rotation', Float32Array), Tsc: view(tbuf, TL, 'd_scaling', Float32Array),
      node: new Float32Array(S.dynamic.nodes * 10), key: '' };
    const op = view(buf, L, 'opacity', Float32Array), dc = view(buf, L, 'sh_dc', Uint16Array), rest = view(buf, L, 'sh_rest', Uint32Array);
    for (let i = 0, k = SCENE0; i < n; i++, k++) {   // static parts: base colour (SH DC), opacity, SH bands 1-3
      const b = ((k >> 9) * 2048 + ((k & 511) << 2)) * 4;
      d[b + 3] = C0 * F16[dc[3 * i]] + 0.5; d[b + 4] = C0 * F16[dc[3 * i + 1]] + 0.5; d[b + 5] = C0 * F16[dc[3 * i + 2]] + 0.5; d[b + 6] = op[i];
      const sb = ((k >> 9) * 1536 + (k & 511) * 3) * 4;
      for (let w = 0; w < 12; w++) shData[sb + w] = rest[12 * i + w];
    }
    DYN = D;
    dynamicFrame(state.frame, true);
    return n;
  }
  function sampleClock(times, sec) {   // dynamic_scene.sample_clock: clamp at the ends ('hold'), linear between samples
    const t = Math.max(times[0], Math.min(times[times.length - 1], sec));
    let hi = 0; while (hi < times.length && times[hi] <= t) hi++;
    hi = Math.min(times.length - 1, hi); const lo = Math.max(0, hi - 1);
    return [lo, hi, times[hi] === times[lo] ? 0 : (t - times[lo]) / (times[hi] - times[lo])];
  }
  function dynamicFrame(t, force) {
    const D = DYN; if (!D) return false;
    const [lo, hi, a] = sampleClock(D.times, t / M.fps);
    const key = lo + ':' + hi + ':' + a.toFixed(6);
    if (key === D.key && !force) return false;
    D.key = key;
    const NN = D.nodes, nd = D.node, b0 = 1 - a;
    for (let q = 0; q < NN; q++) {
      const x0 = 3 * (lo * NN + q), x1 = 3 * (hi * NN + q), r0 = 4 * (lo * NN + q), r1 = 4 * (hi * NN + q), o = 10 * q;
      nd[o] = b0 * D.Txyz[x0] + a * D.Txyz[x1]; nd[o + 1] = b0 * D.Txyz[x0 + 1] + a * D.Txyz[x1 + 1]; nd[o + 2] = b0 * D.Txyz[x0 + 2] + a * D.Txyz[x1 + 2];
      nd[o + 3] = b0 * D.Trot[r0] + a * D.Trot[r1]; nd[o + 4] = b0 * D.Trot[r0 + 1] + a * D.Trot[r1 + 1];
      nd[o + 5] = b0 * D.Trot[r0 + 2] + a * D.Trot[r1 + 2]; nd[o + 6] = b0 * D.Trot[r0 + 3] + a * D.Trot[r1 + 3];
      nd[o + 7] = b0 * D.Tsc[x0] + a * D.Tsc[x1]; nd[o + 8] = b0 * D.Tsc[x0 + 1] + a * D.Tsc[x1 + 1]; nd[o + 9] = b0 * D.Tsc[x0 + 2] + a * D.Tsc[x1 + 2];
    }
    const d = texData, K = D.k;
    const acc = new Float64Array(10);
    for (let i = 0, k = SCENE0; i < D.n; i++, k++) {
      acc.fill(0);
      for (let j = 0; j < K; j++) {
        const q = D.idx[K * i + j], w = D.w[K * i + j], o = 10 * q;
        for (let c = 0; c < 10; c++) acc[c] += w * nd[o + c];
      }
      const m = D.mask[i];
      const x = D.xyz[3 * i] + acc[0] * m, y = D.xyz[3 * i + 1] + acc[1] * m, z = D.xyz[3 * i + 2] + acc[2] * m;
      let qw = D.rot[4 * i] + acc[3] * m, qx = D.rot[4 * i + 1] + acc[4] * m, qy = D.rot[4 * i + 2] + acc[5] * m, qz = D.rot[4 * i + 3] + acc[6] * m;
      const qn = Math.hypot(qw, qx, qy, qz) || 1; qw /= qn; qx /= qn; qy /= qn; qz /= qn;
      quatRows(qw, qx, qy, qz, Rm);
      covariance(Rm, Math.max(Math.abs(D.sc[3 * i] + acc[7] * m), 1e-12), Math.max(Math.abs(D.sc[3 * i + 1] + acc[8] * m), 1e-12),
                 Math.max(Math.abs(D.sc[3 * i + 2] + acc[9] * m), 1e-12), cov, 0);
      const b = ((k >> 9) * 2048 + ((k & 511) << 2)) * 4;
      d[b] = x; d[b + 1] = y; d[b + 2] = z;
      d[b + 7] = cov[0]; d[b + 8] = cov[1]; d[b + 9] = cov[2]; d[b + 10] = cov[3]; d[b + 11] = cov[4]; d[b + 12] = cov[5];
      posAll[3 * k] = x; posAll[3 * k + 1] = y; posAll[3 * k + 2] = z;
    }
    if (SCN || force) {
      uploadRows(SCENE0 / 512, ROWS);
      sendPositions(SCENE0, D.n);
      colKey = '';
    }
    return true;
  }

  // ---------------- gl
  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  let splatProg, blitProg, colourProg, dataTex, objTex, shTex, colTex = null, colFbo = null, colRows = 1, colKey = '', idxBuf, vao, fbo = null, fboTex = null, fboW = 0, fboH = 0, objRows = 1;
  const U = {};
  function texParams() {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  function initGL() {
    splatProg = program(SPLAT_VS, SPLAT_FS); blitProg = program(BLIT_VS, BLIT_FS);
    for (const n of ['u_data', 'u_objPos', 'u_objCount', 'u_objG', 'u_objS2', 'u_sh', 'u_shOn', 'u_campos', 'u_view', 'u_intr', 'u_size', 'u_clip']) U[n] = gl.getUniformLocation(splatProg, n);
    U.u_img = gl.getUniformLocation(blitProg, 'u_img');
    U.u_col = gl.getUniformLocation(splatProg, 'u_col');
    if (shData && hdr) {   // per-view SH colours computed once per splat in a separate pass
      colourProg = program(BLIT_VS, COLOUR_FS);
      for (const n of ['u_data', 'u_sh', 'u_campos', 'u_first', 'u_end']) U['c_' + n] = gl.getUniformLocation(colourProg, n);
      colRows = Math.max(1, Math.ceil(ROWS * 512 / 2048));
      colTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, colTex); texParams();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2048, colRows, 0, gl.RGBA, gl.HALF_FLOAT, null);
      colFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, colFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { colFbo = null; colTex = null; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    dataTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, dataTex); texParams();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2048, ROWS, 0, gl.RGBA, gl.FLOAT, texData);
    objRows = Math.max(1, Math.ceil(OBJCAP / 2048));
    objTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, objTex); texParams();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2048, objRows, 0, gl.RGBA, gl.FLOAT, objPos4);
    shTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, shTex); texParams();
    const shRows = shData ? ROWS : 1;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 1536, shRows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, shData || new Uint32Array(1536 * 4));
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2.4, -2.4, 2.4, -2.4, -2.4, 2.4, 2.4, 2.4]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(splatProg, 'a_pos'); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    idxBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf);
    const aIdx = gl.getAttribLocation(splatProg, 'a_index'); gl.enableVertexAttribArray(aIdx);
    gl.vertexAttribIPointer(aIdx, 1, gl.UNSIGNED_INT, 0, 0); gl.vertexAttribDivisor(aIdx, 1);
    gl.bindVertexArray(null);
  }
  function uploadRows(r0, r1) {
    if (r1 <= r0) return;
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, 2048, r1 - r0, gl.RGBA, gl.FLOAT, texData.subarray(r0 * 2048 * 4, r1 * 2048 * 4));
  }
  function uploadSH(r0, r1) {
    if (!shData || r1 <= r0) return;
    gl.bindTexture(gl.TEXTURE_2D, shTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, 1536, r1 - r0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, shData.subarray(r0 * 1536 * 4, r1 * 1536 * 4));
  }
  function uploadObjPos() {
    gl.bindTexture(gl.TEXTURE_2D, objTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2048, objRows, gl.RGBA, gl.FLOAT, objPos4);
  }
  function ensureFBO(w, h) {
    if (!hdr) return null;
    if (fbo && fboW === w && fboH === h) return fbo;
    if (!fbo) { fbo = gl.createFramebuffer(); fboTex = gl.createTexture(); }
    gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null); texParams();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fboW = w; fboH = h;
    return ok ? fbo : null;
  }

  // ---------------- sorting
  let worker = null, workerURL = null, sortBusy = false, sortWanted = false, sortId = 0, drawCount = 0;
  const local = makeSorter();
  function startWorker(nTotal) {
    try {
      workerURL = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(workerURL);
      worker.postMessage({ kind: 'init', n: nTotal });
      worker.onmessage = (e) => {
        if (destroyed) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf); gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array(e.data.buf), gl.DYNAMIC_DRAW);
        drawCount = e.data.n; sortBusy = false; dirty = true;
        if (sortWanted) requestSort();
      };
      worker.onerror = () => { if (worker) worker.terminate(); worker = null; sortBusy = false; if (workerURL) URL.revokeObjectURL(workerURL); workerURL = null; if (!destroyed) requestSort(); };
    } catch (err) { worker = null; if (workerURL) URL.revokeObjectURL(workerURL); workerURL = null; }
  }
  function sendPositions(start, count) {
    if (start >= OBJCAP) local.invalidate();
    if (!worker || !count) return;
    const copy = posAll.slice(3 * start, 3 * (start + count));
    worker.postMessage({ kind: 'set', offset: start, objCap: OBJCAP, buf: copy.buffer }, [copy.buffer]);
  }
  function requestSort(sync_) {
    if (!M || !OBJ) return;
    const v = currentView();
    const row = [v.R[6], v.R[7], v.R[8], v.t[2]];
    const sc = state.scene && SCN ? SCN.count : 0;
    if (!worker || sync_) {   // main thread: same algorithm, reading posAll directly
      local.attach(posAll);
      const out = local.sort(row, OBJ.N, SCENE0, sc);
      gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf); gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
      drawCount = out.length; dirty = true; return;
    }
    if (sortBusy) { sortWanted = true; return; }
    sortBusy = true; sortWanted = false;
    worker.postMessage({ kind: 'sort', id: ++sortId, view: row, objCount: OBJ.N, sceneFirst: SCENE0, sceneCount: sc });
  }

  // ---------------- camera
  const state = { version: null, frame: 0, playing: false, scene: true, follow: true, mode: opts.camera || 'free',
                  az: 0.35, el: 0.18, dist: 3, bg: 0, fixed: null, eye: null };
  api.state = state;
  const BGS = [{ name: 'grey', c: [0.5, 0.5, 0.5] }, { name: 'black', c: [0, 0, 0] }, { name: 'white', c: [1, 1, 1] }];
  let UP = [0, -1, 0], H0 = [1, 0, 0], H1 = [0, 0, 1], turnDist = 3, override = null, TRACK = null;
  function setupCamera() {
    const ttm = M.cameras.ttm, w = ttm.w2c;
    UP = norm3(M.cameras.up || [-w[1][0], -w[1][1], -w[1][2]]);
    const mid = M.object_track.centroid[Math.floor(M.T / 2)];
    let h = sub3(ttm.centre, mid); h = sub3(h, mul3(UP, dot3(h, UP)));
    H0 = norm3(h); H1 = cross3(UP, H0);
    const fx = ttm.K[0][0];
    turnDist = fx * 2 * M.object_track.radius99 / (0.6 * ttm.W);
    // The aim point: the object's centroid track, smoothed so the camera does not shake with the body's own motion
    // (horizontal Gaussian sigma 4 frames, vertical sigma 8 frames, which removes hop bounce).
    const C0 = M.object_track.centroid, n = C0.length, hz = C0.map(c => [dot3(c, H0), dot3(c, H1), dot3(c, UP)]);
    const gs = (k, sigma) => { const r = Math.ceil(3 * sigma), w = []; let s = 0;
      for (let i = -r; i <= r; i++) { const x = Math.exp(-0.5 * (i / sigma) ** 2); w.push(x); s += x; }
      return hz.map((_, i) => { let a = 0; for (let j = -r; j <= r; j++) a += w[j + r] * hz[Math.min(n - 1, Math.max(0, i + j))][k]; return a / s; }); };
    const a = gs(0, 4), b = gs(1, 4), u = gs(2, 8);
    TRACK = a.map((_, i) => add3(add3(mul3(H0, a[i]), mul3(H1, b[i])), mul3(UP, u[i])));
    // Start beside the middle of the path, far enough back to see the whole run (at least the old close distance).
    let ext = 0;
    for (const p of TRACK) { const d = sub3(p, TRACK[0]); ext = Math.max(ext, Math.hypot(d[0], d[1], d[2])); }
    state.dist = Math.max(1.3 * turnDist, 0.8 * ext); state.az = 0.35; state.el = 0.18;
    state.eye = add3(TRACK[Math.floor(n / 2)], mul3(dirOf(state.az, state.el), state.dist));
  }
  // Free camera: it stays where it is put in the scene (state.eye) and aims at the smoothed object track (Aim on),
  // or at a fixed point (Aim off). Dragging orbits the camera around the aim point; the wheel moves it closer or
  // farther; right-drag / shift-drag slides it sideways.
  function target() { return state.follow || !state.fixed ? TRACK[state.frame] : state.fixed; }
  function dirOf(az, el) { const ce = Math.cos(el); return add3(add3(mul3(H0, ce * Math.cos(az)), mul3(H1, ce * Math.sin(az))), mul3(UP, Math.sin(el))); }
  function orbitFromEye() {
    const off = sub3(state.eye, target()), d = Math.max(1e-6, Math.hypot(off[0], off[1], off[2])), u = mul3(off, 1 / d);
    state.dist = d; state.el = Math.asin(Math.max(-1, Math.min(1, dot3(u, UP)))); state.az = Math.atan2(dot3(u, H1), dot3(u, H0));
  }
  function eyeFromOrbit() { state.eye = add3(target(), mul3(dirOf(state.az, state.el), state.dist)); }
  function lookAt(C, Tg) {   // OpenCV rows: right, down, forward (the Studio's moving_camera.look_at_R)
    const f = norm3(sub3(Tg, C)), r = norm3(cross3(f, UP)), d = cross3(f, r);
    const R = [r[0], r[1], r[2], d[0], d[1], d[2], f[0], f[1], f[2]];
    return { R, t: [-(R[0] * C[0] + R[1] * C[1] + R[2] * C[2]), -(R[3] * C[0] + R[4] * C[1] + R[5] * C[2]), -(R[6] * C[0] + R[7] * C[1] + R[8] * C[2])] };
  }
  const planes = () => [M.cameras.ttm.near || 0.01, M.cameras.ttm.far || 1000];
  function fixedCam(w, K, w0, h0) {   // letterboxed fixed camera (TTM or a recorded orbit pose), the job's near / far
    const W = canvas.width, H = canvas.height, s = Math.min(W / w0, H / h0), [near, far] = planes();
    return { R: [w[0][0], w[0][1], w[0][2], w[1][0], w[1][1], w[1][2], w[2][0], w[2][1], w[2][2]], t: [w[0][3], w[1][3], w[2][3]],
             intr: [K[0][0] * s, K[1][1] * s, W / 2 + (K[0][2] - w0 / 2) * s, H / 2 + (K[1][2] - h0 / 2) * s], box: [w0 * s, h0 * s], near, far };
  }
  function currentView() {
    if (override) return override;
    const W = canvas.width, H = canvas.height, ttm = M.cameras.ttm;
    if (state.mode === 'ttm') return fixedCam(ttm.w2c, ttm.K, ttm.W, ttm.H);
    if (state.mode === 'orbit' && M.cameras.orbit) { const o = M.cameras.orbit; return fixedCam(o.w2c[state.frame], o.K, o.size[0], o.size[1]); }
    const Tg = target();
    if (!state.eye) eyeFromOrbit();
    const v = lookAt(state.eye, Tg), off = sub3(state.eye, Tg), d = Math.hypot(off[0], off[1], off[2]);
    const f = ttm.K[1][1] * Math.min(W / ttm.W, H / ttm.H);
    v.intr = [f, f, W / 2, H / 2];
    const [near, far] = planes();
    v.near = Math.max(0.01, Math.min(near, 0.5 * d)); v.far = far;   // the job's near plane hides close floaters, but never the object
    return v;
  }
  function toFree() {   // continue from the current fixed camera: the free camera starts where that camera stands
    if (state.mode === 'free') return;
    const v = currentView();
    const C = [-(v.R[0] * v.t[0] + v.R[3] * v.t[1] + v.R[6] * v.t[2]), -(v.R[1] * v.t[0] + v.R[4] * v.t[1] + v.R[7] * v.t[2]), -(v.R[2] * v.t[0] + v.R[5] * v.t[1] + v.R[8] * v.t[2])];
    state.eye = C;
    if (!state.follow) {   // Aim off: keep looking where that camera looked, at the object's distance
      const off = sub3(TRACK[state.frame], C);
      state.fixed = add3(C, mul3([v.R[6], v.R[7], v.R[8]], Math.hypot(off[0], off[1], off[2])));
    }
    state.mode = 'free'; sync();
  }
  function viewMat4(v) { const R = v.R, t = v.t; return new Float32Array([R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1]); }

  // ---------------- render
  let dirty = true;
  function render() {
    const W = canvas.width, H = canvas.height, v = currentView();
    const bg = state.scene && SCN ? (SM.background || [0, 0, 0]) : BGS[state.bg].c;
    const tgt = ensureFBO(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt); gl.viewport(0, 0, W, H);
    gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const cR = v.R, ct = v.t;
    const cpos = [-(cR[0] * ct[0] + cR[3] * ct[1] + cR[6] * ct[2]), -(cR[1] * ct[0] + cR[4] * ct[1] + cR[7] * ct[2]), -(cR[2] * ct[0] + cR[5] * ct[1] + cR[8] * ct[2])];
    const shMode = SCN && SM && SM.colour_mode === 'sh3' ? (colFbo ? 2 : 1) : 0;
    if (shMode === 2) {
      const key = cpos.map(x => x.toFixed(6)).join(',') + ':' + SCN.count + ':' + (DYN ? DYN.key : '');
      if (key !== colKey) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, colFbo); gl.viewport(0, 0, 2048, colRows);
        gl.useProgram(colourProg);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dataTex); gl.uniform1i(U.c_u_data, 0);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, shTex); gl.uniform1i(U.c_u_sh, 2);
        gl.uniform3f(U.c_u_campos, cpos[0], cpos[1], cpos[2]); gl.uniform1i(U.c_u_first, SCENE0); gl.uniform1i(U.c_u_end, SCENE0 + SCN.count);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        colKey = key;
        gl.bindFramebuffer(gl.FRAMEBUFFER, tgt); gl.viewport(0, 0, W, H);
      }
    }
    gl.useProgram(splatProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dataTex); gl.uniform1i(U.u_data, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, objTex); gl.uniform1i(U.u_objPos, 1);
    gl.uniform1i(U.u_objCount, OBJ ? OBJ.N : 0);
    gl.uniformMatrix3fv(U.u_objG, false, objG); gl.uniform1f(U.u_objS2, objS2);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, shTex); gl.uniform1i(U.u_sh, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, colTex || objTex); gl.uniform1i(U.u_col, 3);
    gl.uniform1i(U.u_shOn, shMode);
    gl.uniform3f(U.u_campos, cpos[0], cpos[1], cpos[2]);
    gl.uniformMatrix4fv(U.u_view, false, viewMat4(v));
    gl.uniform4f(U.u_intr, v.intr[0], v.intr[1], v.intr[2], v.intr[3]);
    gl.uniform2f(U.u_size, W, H);
    gl.uniform2f(U.u_clip, v.near, v.far);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(vao);
    if (drawCount) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, drawCount);
    gl.bindVertexArray(null); gl.disable(gl.BLEND);
    if (tgt) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
      gl.useProgram(blitProg); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fboTex); gl.uniform1i(U.u_img, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const fr = q('.i4d-frame');
    if ((state.mode === 'ttm' || state.mode === 'orbit') && !override) {
      const r = canvas.getBoundingClientRect(), k = r.width / W;
      fr.style.width = v.box[0] * k + 'px'; fr.style.height = v.box[1] * k + 'px';
      fr.style.left = (r.width - v.box[0] * k) / 2 + 'px'; fr.style.top = (r.height - v.box[1] * k) / 2 + 'px'; fr.hidden = false;
    } else fr.hidden = true;
  }
  function resize() {
    const dpr = Math.min(global.devicePixelRatio || 1, 2), r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; requestSort(); }
  }

  // ---------------- object updates
  let builtFrame = -1, builtVersion = null, rowsFrame = -1;
  function updateObject() {
    if (!OBJ || !VER[state.version]) return;
    const t = state.frame, v = VER[state.version];
    const verChanged = builtVersion !== state.version;
    if (t !== builtFrame || verChanged) {
      if (t !== builtFrame) { framePositions(t); uploadObjPos(); sendPositions(0, OBJ.N); if (DYN && SCN) dynamicFrame(t); }
      if (verChanged || (!OBJ.gpuPath && rowsFrame !== t)) {
        writeObjectRows(OBJ.gpuPath ? 0 : t, v); uploadRows(0, Math.ceil(OBJ.N / 512)); rowsFrame = t;
      }
      frameUniforms(t);
      builtFrame = t; builtVersion = state.version;
      requestSort(); dirty = true;
    }
  }

  // ---------------- ui
  function sync() {
    for (const b of root.querySelectorAll('.i4d-chips .i4d-btn')) b.setAttribute('aria-pressed', String(b.dataset.v === state.version));
    for (const b of root.querySelectorAll('[data-cam]')) b.setAttribute('aria-pressed', String(b.dataset.cam === state.mode));
    q('[data-cam="orbit"]').hidden = !(M && M.cameras.orbit);
    const play = q('.i4d-play'); play.textContent = state.playing ? 'Pause' : 'Play'; play.setAttribute('aria-pressed', String(state.playing));
    q('.i4d-scene').setAttribute('aria-pressed', String(state.scene)); q('.i4d-scene').hidden = !SM;
    q('.i4d-follow').setAttribute('aria-pressed', String(state.follow));
    const bg = q('.i4d-bg'); bg.hidden = state.scene && !!SCN; bg.textContent = 'Background: ' + BGS[state.bg].name;
    if (M) {
      slider.max = M.T - 1; slider.value = state.frame;
      q('.i4d-flabel').textContent = `Frame ${state.frame} / ${M.T - 1} · ${(state.frame / M.fps).toFixed(2)} s`;
    }
  }
  function showVersion() {
    const v = M.versions.find(x => x.id === state.version);
    q('.i4d-vname').textContent = v ? v.label : '';
    q('.i4d-vdesc').textContent = v ? (v.description || '') : '';
    const src = M.source || {}, o = M.object;
    const rows = [['Gaussians', o.N.toLocaleString('en-US')], ['Frames', `${M.T} at ${M.fps} fps`],
                  ['Motion', `${o.rotation.mode === 'global' ? 'positions per frame, one rotation' : 'full per-frame'}`],
                  ['Method', src.method || '–'], ['Scene', SM ? `${(SM.name || SM.id || 'scene')} · ${SM.kept.toLocaleString('en-US')}${SM.dynamic ? ' · animated' : ''}${SM.colour_mode === 'sh3' ? ' · SH' : ''}` : 'none']];
    if (v && v.updates) rows.push(['SDS updates', String(v.updates)]);
    if (v && v.source) rows.push(['Job', String(v.source).slice(0, 8)]);
    q('.i4d-facts').innerHTML = rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('');
  }
  function setVersion(id) { if (!M.versions.find(x => x.id === id)) return; state.version = id; sync(); showVersion(); updateObject(); }
  function setFrame(f) { state.frame = ((f % M.T) + M.T) % M.T; sync(); updateObject(); dirty = true; }
  function setCamera(mode) {
    if (mode === 'free') { if (state.mode !== 'free') toFree(); }
    else state.mode = mode;
    sync(); requestSort(); dirty = true;
  }
  api.setVersion = id => setVersion(id); api.setFrame = f => setFrame(f); api.setCamera = m => setCamera(m);
  api.play = on => { state.playing = on == null ? !state.playing : !!on; sync(); };
  function buildChips() {
    const box = q('.i4d-chips'); box.innerHTML = '';
    M.versions.forEach((v, k) => {
      const b = document.createElement('button'); b.className = 'i4d-btn'; b.type = 'button'; b.dataset.v = v.id;
      b.innerHTML = `<span class="i4d-key">${k + 1}</span>${esc(v.label)}`;
      b.title = v.description || '';
      b.addEventListener('click', () => setVersion(v.id));
      box.appendChild(b);
    });
  }
  const listeners = [];
  const on = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); listeners.push([el, ev, fn, o]); };
  function wire() {
    on(q('.i4d-play'), 'click', () => { state.playing = !state.playing; sync(); });
    on(slider, 'input', e => { state.playing = false; setFrame(+e.target.value); });
    for (const b of root.querySelectorAll('[data-cam]')) on(b, 'click', () => setCamera(b.dataset.cam));
    on(q('.i4d-close'), 'click', () => { toFree(); state.follow = true; orbitFromEye(); state.dist = 0.45 * turnDist; eyeFromOrbit(); sync(); requestSort(); dirty = true; });
    on(q('.i4d-scene'), 'click', () => { state.scene = !state.scene; sync(); requestSort(); dirty = true; });
    on(q('.i4d-follow'), 'click', () => { if (state.follow) state.fixed = TRACK[state.frame]; state.follow = !state.follow; sync(); requestSort(); dirty = true; });
    on(q('.i4d-bg'), 'click', () => { state.bg = (state.bg + 1) % BGS.length; sync(); dirty = true; });
    let panelByHand = false;
    const setPanel = c => { const p = q('.i4d-panel'); p.dataset.collapsed = String(c); q('.i4d-ptoggle').textContent = c ? 'Info' : 'Hide info'; q('.i4d-ptoggle').setAttribute('aria-expanded', String(!c)); dirty = true; requestSort(); };
    on(q('.i4d-ptoggle'), 'click', () => { panelByHand = true; setPanel(q('.i4d-panel').dataset.collapsed !== 'true'); });
    const narrow = () => root.getBoundingClientRect().width < 900;
    setPanel(narrow());
    const ro2 = new ResizeObserver(() => { if (!panelByHand) setPanel(narrow()); }); ro2.observe(root); listeners.push([null, null, () => ro2.disconnect()]);
    on(root, 'keydown', e => {
      if (e.target.tagName === 'INPUT' && e.key !== ' ') return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= M.versions.length) { setVersion(M.versions[n - 1].id); e.preventDefault(); return; }
      if (e.key === ' ') { state.playing = !state.playing; sync(); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { state.playing = false; setFrame(state.frame + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { state.playing = false; setFrame(state.frame - 1); e.preventDefault(); }
      else if (e.key === 't' || e.key === 'T') setCamera('ttm');
      else if ((e.key === 'o' || e.key === 'O') && M.cameras.orbit) setCamera('orbit');
      else if (e.key === 'f' || e.key === 'F') setCamera('free');
      else if ((e.key === 's' || e.key === 'S') && SM) q('.i4d-scene').click();
    });
    const ptrs = new Map(); let last = null, pinch0 = 0, mid0 = null;
    const panBy = (dx, dy) => {   // slide the camera sideways; with Aim off the aim point slides with it
      const v = currentView(), off = sub3(state.eye, target()), k = Math.hypot(off[0], off[1], off[2]) * 0.0016;
      const delta = add3(mul3([v.R[0], v.R[1], v.R[2]], -dx * k), mul3([v.R[3], v.R[4], v.R[5]], -dy * k));
      state.eye = add3(state.eye, delta);
      if (!state.follow && state.fixed) state.fixed = add3(state.fixed, delta);
    };
    on(canvas, 'contextmenu', e => e.preventDefault());
    on(canvas, 'pointerdown', e => {
      root.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); canvas.classList.add('i4d-drag');
      last = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey || e.ctrlKey };
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); mid0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    });
    on(canvas, 'pointermove', e => {
      if (!ptrs.has(e.pointerId) || !last) return;
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      toFree();
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pinch0 > 0) { orbitFromEye(); state.dist = Math.max(0.02, Math.min(200, state.dist * pinch0 / d)); eyeFromOrbit(); }
        if (mid0) panBy(mid[0] - mid0[0], mid[1] - mid0[1]);
        pinch0 = d; mid0 = mid; requestSort(); return;
      }
      const dx = e.clientX - last.x, dy = e.clientY - last.y; last.x = e.clientX; last.y = e.clientY;
      if (last.pan) panBy(dx, dy);
      else { orbitFromEye(); state.az -= dx * 0.006; state.el = Math.max(-1.45, Math.min(1.45, state.el + dy * 0.006)); eyeFromOrbit(); }
      requestSort();
    });
    const up = e => { ptrs.delete(e.pointerId); if (!ptrs.size) { last = null; canvas.classList.remove('i4d-drag'); } pinch0 = 0; mid0 = null;
      if (ptrs.size === 1 && last) { const [p] = [...ptrs.values()]; last.x = p[0]; last.y = p[1]; } };
    on(canvas, 'pointerup', up); on(canvas, 'pointercancel', up);
    on(canvas, 'wheel', e => { e.preventDefault(); toFree(); orbitFromEye(); state.dist = Math.max(0.02, Math.min(200, state.dist * Math.exp(e.deltaY * 0.0012))); eyeFromOrbit(); requestSort(); }, { passive: false });
    const ro = new ResizeObserver(resize); ro.observe(canvas); listeners.push([null, null, () => ro.disconnect()]);
  }

  // ---------------- loop
  let lastT = performance.now(), acc = 0, raf = 0;
  function loop(now) {
    if (destroyed) return;
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    if (M && OBJ && !override) {
      if (state.playing) { acc += dt * M.fps; if (acc >= 1) { const step = Math.floor(acc); acc -= step; setFrame(state.frame + step); } }
      if (dirty) { dirty = false; render(); }
    }
    raf = requestAnimationFrame(loop);
  }

  // ---------------- boot
  async function boot() {
    M = typeof opts.manifest === 'string' ? await (await fetch(manifestURL, { signal: abort.signal })).json() : opts.manifest;
    assertAlive();
    if (M.schema !== 'studio_4d_inspector') throw new Error('not an inspector manifest');
    if (M.scene) { SM = M.scene; sceneResolve = resolve; }
    else if (opts.scene !== false && (opts.sceneManifest || M.scene_ref)) {
      const surl = opts.sceneManifest ? new URL(opts.sceneManifest, document.baseURI).href : new URL(M.scene_ref.manifest, manifestURL || document.baseURI).href;
      try {
        const sm = await (await fetch(surl, { signal: abort.signal })).json();
        assertAlive();
        SM = sm.scene; sceneResolve = opts.resolveScene || (name => new URL(name, surl).href);
      } catch (err) { assertAlive(); SM = null; console.warn('scene not available', err); }
    }
    assertAlive();
    q('.i4d-title').innerHTML = esc(opts.title || [M.source && M.source.object_prompt, SM && (SM.name || SM.id)].filter(Boolean).join(' · ') || '4D insertion')
      + `<small>${M.T} frames · ${M.fps} fps · real Gaussians</small>`;
    state.version = (opts.version && M.versions.find(v => v.id === opts.version)) ? opts.version : M.versions[M.versions.length - 1].id;
    state.frame = Math.min(M.T - 1, opts.frame != null ? opts.frame : 0);
    OBJCAP = M.object.N;
    SCENE0 = Math.ceil(OBJCAP / 512) * 512;
    const sceneTotal = SM ? SM.files.reduce((s, f) => s + f.count, 0) : 0;
    ROWS = Math.max(1, Math.ceil((SCENE0 + sceneTotal) / 512));
    if (ROWS > MAXTEX) throw new Error('this GPU’s texture limit is too small for this scene');
    texData = new Float32Array(2048 * ROWS * 4);
    posAll = new Float32Array((SCENE0 + sceneTotal) * 3);
    objPos4 = new Float32Array(2048 * Math.max(1, Math.ceil(OBJCAP / 2048)) * 4);
    if (SM && SM.colour_mode === 'sh3') shData = new Uint32Array(1536 * ROWS * 4);   // static and animated scenes
    setupCamera(); buildChips(); wire(); sync(); showVersion();
    initGL();
    startWorker(SCENE0 + sceneTotal);
    q('.i4d-ltext').textContent = 'Loading the object…';
    const objectBuffer = await fetchBuffer(M.object.file, p => setStatus(`object ${Math.round(100 * p)} %`));
    assertAlive(); OBJ = decodeObject(objectBuffer);
    const order = [state.version, ...M.versions.map(v => v.id).filter(id => id !== state.version)];
    const meta = id => M.versions.find(v => v.id === id);
    const firstVersionBuffer = await fetchBuffer(meta(order[0]).file);
    assertAlive(); VER[order[0]] = decodeVersion(firstVersionBuffer, meta(order[0]));
    resize(); updateObject(); showVersion(); sync();
    q('.i4d-loading').hidden = true;
    for (const id of order.slice(1)) { const versionBuffer = await fetchBuffer(meta(id).file); assertAlive(); VER[id] = decodeVersion(versionBuffer, meta(id)); }
    let sceneNote = '';
    if (SM) {
      try {
        let n;
        if (SM.dynamic) {
          const buf = await fetchBuffer(SM.files[0].file, p => setStatus(`animated scene ${Math.round(50 * p)} %`), sceneResolve);
          const tbuf = await fetchBuffer(SM.dynamic.tracks.file, p => setStatus(`animated scene ${50 + Math.round(50 * p)} %`), sceneResolve);
          if (destroyed) return;
          n = buildDynamicScene(buf, tbuf);
        } else {
          const parts = [];
          for (const [k, info] of SM.files.entries()) {
            parts.push({ info, buf: await fetchBuffer(info.file, p => setStatus(`scene ${Math.round(100 * (k + p) / SM.files.length)} %`), sceneResolve) });
            if (destroyed) return;
          }
          n = buildScene(parts);
        }
        uploadRows(SCENE0 / 512, ROWS);
        uploadSH(SCENE0 / 512, ROWS);
        sendPositions(SCENE0, n);
        SCN = { count: n };
      } catch (err) { console.warn(err); sceneNote = ' · scene not available'; SM = null; }
    }
    setStatus(`${(OBJ.N + (SCN ? SCN.count : 0)).toLocaleString('en-US')} Gaussians · ${hdr ? 'HDR' : '8-bit'} blend${sceneNote}`);
    sync(); requestSort(); dirty = true;
  }
  api.ready = boot().catch(err => { if (destroyed) return; fail('The 4D view stopped: ' + err.message); console.error(err); throw err; });
  raf = requestAnimationFrame(loop);

  // exact render for automated checks: OpenCV w2c and K at W x H
  api.renderExact = function (o) {
    canvas.style.width = o.W + 'px'; canvas.style.height = o.H + 'px'; canvas.width = o.W; canvas.height = o.H;
    if (o.version) state.version = o.version;
    state.frame = o.frame; state.scene = !!o.scene; state.bg = o.bg || 0; updateObject();
    const w = o.w2c, K = o.K;
    const [pn, pf] = planes();
    override = { R: [w[0][0], w[0][1], w[0][2], w[1][0], w[1][1], w[1][2], w[2][0], w[2][1], w[2][2]], t: [w[0][3], w[1][3], w[2][3]], intr: [K[0][0], K[1][1], K[0][2], K[1][2]],
                 near: o.near != null ? o.near : pn, far: o.far != null ? o.far : pf };
    requestSort(true); render(); return true;
  };
  api.releaseExact = () => { override = null; canvas.style.width = ''; canvas.style.height = ''; resize(); requestSort(); dirty = true; };

  function destroy() {
    if (destroyed) return;
    destroyed = true; abort.abort(); cancelAnimationFrame(raf);
    for (const [el, ev, fn, o] of listeners) { if (el) el.removeEventListener(ev, fn, o); else fn(); }
    if (worker) worker.terminate();
    if (workerURL) URL.revokeObjectURL(workerURL); workerURL = null;
    const ext = gl && gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
    root.remove();
  }
  return api;
}

global.Inspector4D = { create, version: '1.0.0' };
})(typeof window !== 'undefined' ? window : globalThis);
