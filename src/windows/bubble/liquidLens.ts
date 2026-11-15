// The liquid lens: a WebGL drop that refracts the live pixels under the bubble.
//
// Pixels come from Rust (`lens_grab`, the screen BELOW the bubble window) as raw BGRA frames that
// this module pulls at ~30 fps while the drop moves and a few fps at rest. The fragment shader
// draws one signed-distance body (soft-body blob + edge meniscus + a tether that stretches when
// the drop leaves the screen edge) and bends the frame through it: magnified centre, strongly
// compressed rim, per-channel dispersion that blooms into rainbow fringes with speed.
// If no frame ever arrives (no Screen Recording permission), it renders a procedural clear glass.
import { invoke } from "@tauri-apps/api/core";

export interface LensState {
  /** Drop centre and radius, global points. */
  cx: number;
  cy: number;
  r: number;
  /** Spring target (where the drop is heading), global points. */
  tx: number;
  ty: number;
  /** Display frame, global points. */
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  /** rest | dragging | armed | parking | parked | returning */
  mode: string;
  hidden: boolean;
  ready: boolean;
  /** Phase tint (rgb 0..1) and strength 0..1; pulse 0..1 adds a breathing halo. */
  tint: [number, number, number, number];
  pulse: number;
}

/** Written by useBubbleMotion (geometry) and Bubble (tint); read here every frame. */
export const lensState: LensState = {
  cx: 0, cy: 0, r: 34, tx: 0, ty: 0, fx: 0, fy: 0, fw: 1728, fh: 1117,
  mode: "rest", hidden: false, ready: false, tint: [0.5, 0.8, 1, 0], pulse: 0,
};

const HALF = 252; // canvas half-size in points (the wrapper is 504 pt)

const VERT = `
attribute vec2 a;
varying vec2 v_p;
uniform float u_half;
void main() {
  v_p = vec2(a.x, -a.y) * u_half;
  gl_Position = vec4(a, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_p;
uniform sampler2D u_tex;
uniform float u_hasTex;
uniform vec2 u_center;
uniform vec4 u_rect;
uniform float u_r;
uniform vec3 u_def;     // stretch axis angle, stretch amount, wobble phase
uniform vec2 u_wall;    // local x of the left and right screen edges
uniform vec3 u_tether;  // local xy + radius of the edge tether
uniform float u_motion;
uniform vec4 u_tint;
uniform float u_pulse;
uniform float u_alpha;

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float blob(vec2 p) {
  float c = cos(u_def.x), s = sin(u_def.x);
  vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  float st = u_def.y;
  vec2 sc = vec2(1.0 + 0.9 * st, 1.0 - 0.42 * st);
  q /= sc;
  float len = length(q);
  float a = atan(q.y, q.x);
  float rr = u_r * (1.0 - 0.26 * st * cos(a)
    + (0.010 + 0.10 * st) * sin(3.0 * a + u_def.z)
    + (0.006 + 0.04 * st) * sin(5.0 * a - u_def.z * 1.7));
  return (len - rr) * min(sc.x, sc.y);
}

float drop(vec2 p) {
  float d = blob(p);
  if (u_tether.z > 0.5) d = smin(d, length(p - u_tether.xy) - u_tether.z, 28.0);
  return d;
}

float sdf(vec2 p) {
  float w = min(p.x - u_wall.x, u_wall.y - p.x);
  return smin(drop(p), w, 20.0);
}

vec3 sampleAt(vec2 g) {
  vec2 uv = (g - u_rect.xy) / u_rect.zw;
  return texture2D(u_tex, clamp(uv, 0.002, 0.998)).bgr;
}

void main() {
  vec2 p = v_p;
  float d = sdf(p);

  // Outside the body: contact shadow, soft drop shadow, phase halo.
  // The screen edge is part of the body but casts nothing: fade everything out away from the drop.
  float near = smoothstep(30.0, 6.0, drop(p));
  float sh = drop(p - vec2(0.0, 3.0));
  float aSh = (0.15 * exp(-max(sh, 0.0) / 5.0) + 0.16 * exp(-max(d, 0.0) / 1.1)) * near;
  float halo = u_tint.a * (0.55 + 0.45 * u_pulse) * exp(-max(d, 0.0) / (5.0 + 9.0 * u_pulse)) * near;
  vec3 outC = u_tint.rgb * halo;
  float outA = clamp(aSh + halo * 0.85, 0.0, 1.0);
  vec4 outside = vec4(outC, outA);

  vec4 inside = vec4(0.0);
  if (d < 0.75) {
    vec2 e = vec2(1.0, 0.0);
    vec2 g = vec2(sdf(p + e.xy) - sdf(p - e.xy), sdf(p + e.yx) - sdf(p - e.yx));
    vec2 n = g / max(length(g), 1e-4);
    float rho = clamp(1.0 + d / u_r, 0.0, 1.0);
    float rim = pow(rho, 7.0);
    float ca = 0.11 + 0.30 * u_motion;
    float mag = -0.22 * rho;
    vec2 base = u_center + p;
    vec3 col;
    if (u_hasTex > 0.5) {
      float dr = mag * (1.0 - 0.10 * ca) + 0.47 * rim * (1.0 - 2.4 * ca);
      float dg = mag + 0.47 * rim;
      float db = mag * (1.0 + 0.10 * ca) + 0.47 * rim * (1.0 + 2.4 * ca);
      col.r = sampleAt(base + n * dr * u_r).r;
      col.g = sampleAt(base + n * dg * u_r).g;
      col.b = sampleAt(base + n * db * u_r).b;
      // Rainbow bloom: saturate the dispersed fringe near the rim.
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = clamp(mix(vec3(l), col, 1.0 + 1.6 * rim), 0.0, 1.0);
    } else {
      col = mix(vec3(0.80, 0.88, 0.98), vec3(0.95, 0.98, 1.0), rho);
    }
    // Glass lighting: inner shadow, specular rim, counter light, gloss, hairline.
    vec2 L = normalize(vec2(-0.55, -0.83));
    float nl = dot(n, L);
    float bw = 0.8 + 0.02 * u_r;
    float band = smoothstep(-3.0 * bw, -bw, d) * smoothstep(0.0, -0.5 * bw, d);
    // Clear glass, not milk: the light-facing side of the interior carries a soft refracted
    // shade, the far side a caustic; a thin dark ring just inside the edge gives it thickness.
    float body = pow(rho, 2.2);
    col *= 1.0 - 0.17 * body * (0.5 + 0.5 * nl);
    col *= 1.0 - 0.10 * pow(rho, 10.0);
    col += vec3(0.12) * body * max(-nl, 0.0) * (1.0 - dot(col, vec3(0.333)));
    col *= vec3(0.972, 0.988, 1.0);
    col = mix(col, u_tint.rgb, u_tint.a * (0.06 + 0.42 * pow(rho, 3.0)));
    // Crisp specular rim: bright arc toward the light, a thinner counter-light arc opposite.
    col += vec3(1.0) * band * (1.0 * pow(max(nl, 0.0), 3.0) + 0.5 * pow(max(-nl, 0.0), 6.0));
    float z = sqrt(max(1.0 - rho * rho * 0.97, 0.0));
    vec3 N = normalize(vec3(n * rho, z));
    float hl = max(dot(N, normalize(vec3(-0.40, -0.60, 0.69))), 0.0);
    float gl = 0.95 * smoothstep(0.972, 0.99, hl) + 0.10 * pow(hl, 10.0);
    col += vec3(gl);
    col = mix(col, col * 0.42, smoothstep(-1.0, 0.0, d) * 0.6);
    float a = mix(0.42, 1.0, u_hasTex);
    a = mix(a, 1.0, clamp(band + gl + rim, 0.0, 1.0));
    inside = vec4(clamp(col, 0.0, 1.0) * a, a);
  }
  float k = smoothstep(0.5, -0.5, d);
  gl_FragColor = mix(outside, inside, k) * u_alpha;
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("lens shader:", gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

/** Start rendering into `canvas`. Returns a stop function. `log` reports one-off status lines. */
export function startLiquidLens(canvas: HTMLCanvasElement, log: (m: string) => void): () => void {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) {
    log("[bubble] lens: no WebGL, CSS glass stays");
    return () => {};
  }
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) {
    log("[bubble] lens: shader compile failed");
    return () => {};
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    log(`[bubble] lens: link failed ${gl.getProgramInfoLog(prog) ?? ""}`);
    return () => {};
  }
  gl.useProgram(prog);
  document.documentElement.classList.add("gt-lens-on");

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const U = (n: string) => gl.getUniformLocation(prog, n);
  const u = {
    half: U("u_half"), tex: U("u_tex"), hasTex: U("u_hasTex"), center: U("u_center"),
    rect: U("u_rect"), r: U("u_r"), def: U("u_def"), wall: U("u_wall"), tether: U("u_tether"),
    motion: U("u_motion"), tint: U("u_tint"), pulse: U("u_pulse"), alpha: U("u_alpha"),
  };
  gl.uniform1f(u.half, HALF);
  gl.uniform1i(u.tex, 0);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);

  let alive = true;
  let raf = 0;
  let hasTex = false;
  let rect = { x: 0, y: 0, w: 1, h: 1 };

  // ── frame pull ──
  let grabbing = false;
  let lastGrab = 0;
  let failures = 0;
  let frames = 0;
  let stalls = 0;
  const moving = () => lensState.mode !== "rest" && lensState.mode !== "parked";
  const pull = async (now: number) => {
    const s = lensState;
    if (grabbing || !s.ready || document.hidden) return;
    const every = failures > 3 ? 2000 : moving() ? 30 : 220;
    if (now - lastGrab < every) return;
    lastGrab = now;
    const half = Math.min(s.r * 1.62 + 40, 560);
    const x0 = Math.max(s.fx, Math.floor(s.cx - half));
    const y0 = Math.max(s.fy, Math.floor(s.cy - half));
    const x1 = Math.min(s.fx + s.fw, Math.ceil(s.cx + half));
    const y1 = Math.min(s.fy + s.fh, Math.ceil(s.cy + half));
    if (x1 - x0 < 4 || y1 - y0 < 4) return;
    grabbing = true;
    try {
      const data = await invoke<ArrayBuffer>("lens_grab", { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      if (!alive) return;
      const head = new DataView(data, 0, 8);
      const w = head.getUint32(0, true);
      const h = head.getUint32(4, true);
      if (w > 0 && h > 0 && data.byteLength >= 8 + w * h * 4) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data, 8, w * h * 4));
        rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        if (!hasTex) log(`[bubble] lens: live frames ok (${w}x${h} px for ${rect.w}x${rect.h} pt)`);
        hasTex = true;
        failures = 0;
        frames++;
      }
    } catch (e) {
      failures++;
      if (failures === 1 || failures === 4) log(`[bubble] lens: grab failed (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      grabbing = false;
    }
  };

  // ── soft body: a lazy, underdamped follower; the offset to it stretches the drop ──
  const J = { x: NaN, y: NaN, vx: 0, vy: 0 };
  let axis = 0;
  let phase = 0;
  let lastT = performance.now();
  let lastDraw = 0;
  let anchor = { x: NaN, y: NaN };
  let speedK = 0;
  let prev = { x: NaN, y: NaN };
  let sized = 0;
  let drawnHidden = false;

  const frame = (now: number) => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const s = lensState;
    const dt = Math.min(Math.max((now - lastT) / 1000, 0), 1 / 30);
    lastT = now;
    if (!s.ready) return;
    void pull(now);

    if (!Number.isFinite(J.x) || Math.hypot(s.cx - J.x, s.cy - J.y) > 420) {
      J.x = s.cx; J.y = s.cy; J.vx = 0; J.vy = 0;
    }
    const K = 300;
    const C = 2 * 0.33 * Math.sqrt(K);
    let left = dt;
    while (left > 1e-6) {
      const h = Math.min(1 / 240, left);
      J.vx += (-K * (J.x - s.cx) - C * J.vx) * h;
      J.vy += (-K * (J.y - s.cy) - C * J.vy) * h;
      J.x += J.vx * h;
      J.y += J.vy * h;
      left -= h;
    }
    const ox = s.cx - J.x;
    const oy = s.cy - J.y;
    const om = Math.hypot(ox, oy);
    if (om > 0.6) axis = Math.atan2(oy, ox);
    // Capped so a large lens never deforms past the canvas.
    const stretch = Math.min(om / (s.r * 1.5 + 40), 0.4, Math.max(0, (HALF - 16) / s.r - 1.04));
    phase += dt * (1.1 + 9 * stretch);

    // drag speed → dispersion
    const v = Number.isFinite(prev.x) && dt > 0 ? Math.hypot(s.cx - prev.x, s.cy - prev.y) / dt : 0;
    prev = { x: s.cx, y: s.cy };
    speedK += (Math.min(v / 1800, 1) - speedK) * Math.min(1, dt * 10);

    // edge tether: a bump on the screen edge that the drop stretches away from and re-merges into
    const atRest = s.mode === "rest" || s.mode === "parked";
    const homing = s.mode === "returning" || s.mode === "parking";
    const ax = atRest ? s.cx : homing ? s.tx : anchor.x;
    const ay = atRest ? s.cy : homing ? s.ty : anchor.y;
    if (Number.isFinite(ax)) {
      const wallX = ax > s.fx + s.fw / 2 ? s.fx + s.fw : s.fx;
      anchor = { x: wallX, y: ay };
    }
    let tr = 0;
    if (Number.isFinite(anchor.x)) {
      const dist = Math.hypot(s.cx - anchor.x, s.cy - anchor.y);
      tr = 20 * (1 - Math.min(Math.max((dist - 22) / 120, 0), 1));
    }

    const calm = atRest && om < 0.3 && speedK < 0.01 && s.hidden === drawnHidden;
    drawnHidden = s.hidden;
    if (calm && now - lastDraw < 66) return; // idle shimmer at ~15 fps
    lastDraw = now;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(HALF * 2 * dpr);
    if (sized !== px) {
      sized = px;
      canvas.width = px;
      canvas.height = px;
    }
    // Only shade the square the body and its shadow can reach.
    const reach = Math.min(HALF, s.r * (1.5 + stretch) + 44 + (tr > 0.5 ? 60 : 0));
    const lo = Math.floor((HALF - reach) * dpr);
    const span = Math.ceil(reach * 2 * dpr);
    gl.viewport(0, 0, px, px);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(lo, lo, span, span);

    gl.uniform1f(u.hasTex, hasTex ? 1 : 0);
    gl.uniform2f(u.center, s.cx, s.cy);
    gl.uniform4f(u.rect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform1f(u.r, s.r);
    gl.uniform3f(u.def, axis, stretch, phase);
    gl.uniform2f(u.wall, s.fx - s.cx, s.fx + s.fw - s.cx);
    gl.uniform3f(u.tether, anchor.x - s.cx || 0, anchor.y - s.cy || 0, tr);
    gl.uniform1f(u.motion, Math.min(1, speedK + stretch * 1.2));
    gl.uniform4f(u.tint, s.tint[0], s.tint[1], s.tint[2], s.tint[3]);
    gl.uniform1f(u.pulse, s.pulse);
    gl.uniform1f(u.alpha, s.hidden ? 0 : 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  raf = requestAnimationFrame(frame);
  // rAF can be throttled in a non-key panel; a slow timer keeps frames coming regardless.
  const timer = window.setInterval(() => {
    if (alive && performance.now() - lastT > 200) frame(performance.now());
  }, 250);
  const stat = window.setInterval(() => {
    if (frames > 0 && moving()) log(`[bubble] lens: ${frames} frames/2s`);
    else if (frames === 0 && lensState.ready && hasTex) {
      stalls++;
      if (stalls === 1 || stalls % 15 === 0) log(`[bubble] lens: no frame for 2s (grabbing=${grabbing} hidden=${document.hidden} raf-age=${(performance.now() - lastT).toFixed(0)}ms)`);
    } else stalls = 0;
    frames = 0;
  }, 2000);

  return () => {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    window.clearInterval(timer);
    window.clearInterval(stat);
    document.documentElement.classList.remove("gt-lens-on");
  };
}
