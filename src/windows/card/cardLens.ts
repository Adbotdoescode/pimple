// Liquid glass for the card: a WebGL layer that refracts the live desktop under the card.
//
// Pixels come from Rust (`lens_grab_below`, the screen BELOW the card window) as raw BGRA frames,
// pulled a few times a second while the card is up and at once when it moves or resizes. The
// shader bends the frame through a rounded slab of glass: a mildly magnified, softly frosted body
// under a readability tint, and a rim that compresses the view hard and splits it into colour
// fringes, like the bubble's drop. It only draws when a new frame, size or theme arrives.
// If the command is missing or fails (older build, no Screen Recording permission) nothing is
// drawn and the card keeps its frosted look.
import { useEffect, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const PULL_MS = 170;       // steady refresh while the card is up
const MOVE_PULL_MS = 45;   // while the card is being dragged
const MAX_FAILS = 3;
/** Set once the command proved unavailable, so later mounts do not keep asking. */
let unsupported = false;

const VERT = `
attribute vec2 a;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5);
  gl_Position = vec4(a, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_size;     // panel size, points
uniform float u_radius;  // corner radius, points
uniform vec4 u_tint;     // readability tint rgb + strength

float box(vec2 p) {
  vec2 q = abs(p) - u_size * 0.5 + u_radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
}

vec3 tap(vec2 q) {
  return texture2D(u_tex, clamp(q / u_size + 0.5, 0.003, 0.997)).bgr;
}

void main() {
  vec2 p = (v_uv - 0.5) * u_size;
  float sd = box(p);
  float d = -sd;                                   // points inside the edge
  vec2 e = vec2(1.0, 0.0);
  vec2 n = vec2(box(p + e.xy) - box(p - e.xy), box(p + e.yx) - box(p - e.yx));
  n = n / max(length(n), 1e-4);                    // outward normal of the nearest edge

  float band = min(30.0, min(u_size.x, u_size.y) * 0.42);
  float rim = 1.0 - smoothstep(0.0, band, d);      // 1 at the edge, 0 in the body
  float bend = rim * rim;

  // Body: a touch of magnification. Rim: the view is pulled in from further inside and squeezed.
  vec2 q = p * 0.955 - n * bend * band * 0.85;
  float split = bend * 7.0 + 0.6;                  // colour separation, points
  float soft = mix(6.5, 1.2, rim);                 // frost radius: soft body, clear rim

  vec3 col = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    vec2 o = vec2(cos(a), sin(a)) * soft * (mod(float(i), 2.0) < 0.5 ? 1.0 : 0.55);
    col.r += tap(q - n * split + o).r;
    col.g += tap(q + o).g;
    col.b += tap(q + n * split + o).b;
  }
  col.r += tap(q - n * split).r;
  col.g += tap(q).g;
  col.b += tap(q + n * split).b;
  col /= 9.0;

  // A little more life in the refracted colours, then the readability tint (thinner at the rim).
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, 1.18);
  col = mix(col, u_tint.rgb, u_tint.a * (1.0 - 0.62 * rim));

  // Inner light just inside the edge, and a faint darker line where the glass ends.
  col += vec3(1.0) * smoothstep(5.0, 0.5, d) * 0.22;
  col *= 1.0 - 0.1 * smoothstep(band * 0.55, band, d) * (1.0 - smoothstep(band, band * 1.3, d));

  float alpha = smoothstep(0.0, 1.2, d);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
}`;

function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("card lens: shader", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * Drives the lens canvas inside the card panel. `active` is false while the card is hidden, so no
 * frames are pulled then. `layoutKey` changes when the panel element is swapped (pill / full card).
 */
export function useCardLens(
  panelRef: RefObject<HTMLElement>,
  canvasRef: RefObject<HTMLCanvasElement>,
  active: boolean,
  layoutKey: unknown,
): void {
  useEffect(() => {
    const panel = panelRef.current;
    const canvas = canvasRef.current;
    if (!panel || !canvas || !active) return;
    if (unsupported || !("__TAURI_INTERNALS__" in window)) return; // browser preview or old build: frosted look

    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("card lens: link", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);
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
    const uSize = gl.getUniformLocation(prog, "u_size");
    const uRadius = gl.getUniformLocation(prog, "u_radius");
    const uTint = gl.getUniformLocation(prog, "u_tint");
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);

    let dead = false;
    let hasFrame = false;
    let fails = 0;
    let busy = false;
    let timer: number | null = null;
    let lastMove = 0;
    let scale = window.devicePixelRatio || 2;
    let winPos: { x: number; y: number } | null = null; // window top-left, global points

    const draw = () => {
      if (dead || !hasFrame) return;
      const w = panel.clientWidth, h = panel.clientHeight;
      if (w < 4 || h < 4) return;
      const dpr = Math.min(2, window.devicePixelRatio || 2);
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      gl.viewport(0, 0, bw, bh);
      const radius = parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 18;
      gl.uniform2f(uSize, w, h);
      gl.uniform1f(uRadius, Math.min(radius, w / 2, h / 2));
      if (isDark()) gl.uniform4f(uTint, 0.105, 0.115, 0.14, 0.7);
      else gl.uniform4f(uTint, 0.972, 0.976, 0.988, 0.74);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      canvas.dataset.live = "1";
    };

    const schedule = (ms: number) => {
      if (dead) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(pull, ms);
    };

    const pull = async () => {
      timer = null;
      if (dead) return;
      if (busy || !winPos || document.visibilityState === "hidden") {
        schedule(PULL_MS);
        return;
      }
      busy = true;
      try {
        const r = panel.getBoundingClientRect();
        if (r.width >= 4 && r.height >= 4) {
          const raw = await invoke<ArrayBuffer>("lens_grab_below", {
            label: "card",
            x: winPos.x + r.left,
            y: winPos.y + r.top,
            w: r.width,
            h: r.height,
          });
          if (dead) return;
          const bytes = new Uint8Array(raw as ArrayBuffer);
          if (bytes.byteLength > 8) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
            const fw = view.getUint32(0, true), fh = view.getUint32(4, true);
            if (fw > 0 && fh > 0 && bytes.byteLength >= 8 + fw * fh * 4) {
              gl.bindTexture(gl.TEXTURE_2D, tex);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                bytes.subarray(8, 8 + fw * fh * 4));
              hasFrame = true;
              fails = 0;
              draw();
            }
          }
        }
      } catch (err) {
        fails += 1;
        if (fails >= MAX_FAILS) {
          // No such command in this build, or no Screen Recording permission: keep the frosted look.
          console.warn("card lens: off,", err instanceof Error ? err.message : err);
          unsupported = true;
          dead = true;
          delete canvas.dataset.live;
          return;
        }
      } finally {
        busy = false;
      }
      schedule(Date.now() - lastMove < 400 ? MOVE_PULL_MS : PULL_MS);
    };

    const win = getCurrentWindow();
    let unMoved: (() => void) | null = null;
    win.scaleFactor().then((f) => { scale = f; }).catch(() => {});
    win.outerPosition()
      .then((p) => {
        winPos = { x: p.x / scale, y: p.y / scale };
        schedule(0);
      })
      .catch(() => {});
    win.onMoved((e) => {
      winPos = { x: e.payload.x / scale, y: e.payload.y / scale };
      lastMove = Date.now();
      if (!busy) schedule(0);
    })
      .then((un) => {
        if (dead) un();
        else unMoved = un;
      })
      .catch(() => {});

    const ro = new ResizeObserver(() => {
      draw();
      if (!busy) schedule(0);
    });
    ro.observe(panel);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onTheme = () => draw();
    mq?.addEventListener?.("change", onTheme);

    return () => {
      dead = true;
      if (timer !== null) window.clearTimeout(timer);
      unMoved?.();
      ro.disconnect();
      mq?.removeEventListener?.("change", onTheme);
      delete canvas.dataset.live;
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
    // panelRef and canvasRef are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, layoutKey]);
}
