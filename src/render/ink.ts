import type { Pt } from "@shared/contracts";
import { fmt } from "./geometry";

/**
 * Hand-drawn ink: organic centrelines (slightly bowed lines, circles that overshoot instead of closing,
 * boxes drawn in one pass) and a pressure-style variable-width outline cut into short chunks.
 * Chunks are plain filled polygons revealed one after another, so the draw-on needs no mask or filter
 * (WKWebView rasterises those at low resolution on retina).
 */

/** Deterministic random stream from a shape id, so geometry is stable across renders. */
export function seedOf(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Even arc-length resampling of a polyline. Always keeps both end points. */
export function resample(poly: Pt[], step: number): Pt[] {
  if (poly.length < 2) return poly.slice();
  const acc: number[] = [0];
  for (let i = 1; i < poly.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  }
  const total = acc[acc.length - 1];
  if (!(total > 0)) return [poly[0], poly[poly.length - 1]];
  const n = Math.max(2, Math.min(420, Math.ceil(total / step) + 1));
  const out: Pt[] = [];
  let j = 1;
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * total;
    while (j < poly.length - 1 && acc[j] < s) j++;
    const span = acc[j] - acc[j - 1] || 1;
    const k = Math.min(1, Math.max(0, (s - acc[j - 1]) / span));
    out.push([
      poly[j - 1][0] + (poly[j][0] - poly[j - 1][0]) * k,
      poly[j - 1][1] + (poly[j][1] - poly[j - 1][1]) * k,
    ]);
  }
  return out;
}

export function polyD(pts: Pt[]): string {
  if (pts.length === 0) return "";
  let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += ` L${fmt(pts[i][0])} ${fmt(pts[i][1])}`;
  return d;
}

/** A straight line drawn by hand: exact end points, a faint bow and an even fainter S-wobble. */
export function handLine(a: Pt, b: Pt, rnd: () => number): Pt[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (!(L > 0)) return [a, b];
  const nx = -dy / L, ny = dx / L;
  const bow = (rnd() - 0.5) * 2 * Math.min(2.6, L * 0.011);
  const wob = (rnd() - 0.5) * 2 * Math.min(1.1, L * 0.004);
  const n = Math.max(2, Math.min(80, Math.ceil(L / 8)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = bow * Math.sin(Math.PI * t) + wob * Math.sin(2 * Math.PI * t);
    out.push([a[0] + dx * t + nx * off, a[1] + dy * t + ny * off]);
  }
  return out;
}

/** A circle drawn in one sweep: starts near the top, breathes a little, and overshoots its own start. */
export function handCircle(cx: number, cy: number, R: number, rnd: () => number): Pt[] {
  const start = -Math.PI / 2 - 0.55 + rnd() * 0.5;
  const over = 0.3 + rnd() * 0.16;
  const sweep = Math.PI * 2 + over;
  const dev = Math.min(R * 0.03, 3.2);     // how far the spiral opens, px
  const oval = Math.min(R * 0.012, 1.4);
  const phase = rnd() * Math.PI * 2;
  const n = Math.max(24, Math.min(160, Math.ceil((R * sweep) / 5)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const th = start + sweep * t;
    const r = R - dev * 0.6 + dev * 1.5 * t + oval * Math.cos(2 * (th - phase));
    out.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]);
  }
  return out;
}

/** A box drawn in one pass from the top-left: soft corners, barely bowed edges, ends overshoot the start. */
export function handBox(L: number, T: number, W: number, H: number, rnd: () => number): Pt[] {
  const r = Math.min(7, W / 4, H / 4);
  const o = Math.min(5, W / 6, H / 6);     // overshoot at the open corner
  const bowOf = (len: number) => (rnd() - 0.5) * 2 * Math.min(1.4, len * 0.006);
  const x2 = L + W, y2 = T + H;
  const out: Pt[] = [];
  const edge = (a: Pt, b: Pt) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return;
    const nx = -dy / len, ny = dx / len;
    const bow = bowOf(len);
    const n = Math.max(2, Math.ceil(len / 10));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const off = bow * Math.sin(Math.PI * t);
      out.push([a[0] + dx * t + nx * off, a[1] + dy * t + ny * off]);
    }
  };
  const corner = (a: Pt, q: Pt, b: Pt) => {
    for (let i = 1; i < 5; i++) {
      const t = i / 5, u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * q[0] + t * t * b[0], u * u * a[1] + 2 * u * t * q[1] + t * t * b[1]]);
    }
  };
  edge([L - o * 0.6, T + 0.6], [x2 - r, T]);
  corner([x2 - r, T], [x2, T], [x2, T + r]);
  edge([x2, T + r], [x2, y2 - r]);
  corner([x2, y2 - r], [x2, y2], [x2 - r, y2]);
  edge([x2 - r, y2], [L + r, y2]);
  corner([L + r, y2], [L, y2], [L, y2 - r]);
  edge([L, y2 - r], [L + 0.6, T - o]);
  return out;
}

/** Catmull-Rom through the points, sampled densely (same curve as geometry.smoothPath). */
export function curvePts(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    const steps = Math.max(4, Math.min(24, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 6)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      out.push([
        b0 * p1[0] + b1 * c1[0] + b2 * c2[0] + b3 * p2[0],
        b0 * p1[1] + b1 * c1[1] + b2 * c2[1] + b3 * p2[1],
      ]);
    }
  }
  return out;
}

export interface InkChunk { d: string; t: number }
export interface InkCap { x: number; y: number; r: number; t: number }
export interface InkGeom {
  pts: Pt[];          // evenly spaced centreline
  d: string;          // centreline path (halo, shadow, glow, sidenote)
  sheen: string;      // middle part of the centreline, for the gloss streak
  chunks: InkChunk[]; // variable-width outline pieces; t is the 0..1 reveal position
  caps: InkCap[];
  total: number;
}

export interface InkOpts {
  /** Closed-looking sweep (circle, box): firmer start. */
  loop?: boolean;
  /** Taper the end like a pen lifting. Off when an arrowhead covers the end. */
  taperEnd?: boolean;
}

const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/** Pressure-style outline around a centreline polyline. */
export function inkGeom(poly: Pt[], width: number, rnd: () => number, opts: InkOpts = {}): InkGeom {
  const pts = resample(poly, 3);
  const n = pts.length;
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const d = polyD(pts);

  const inT = Math.min(0.2, 16 / Math.max(total, 1));
  const outT = Math.min(0.35, (opts.loop ? 34 : 30) / Math.max(total, 1));
  const taperEnd = opts.taperEnd !== false;
  const f = Math.max(0.8, total / 150);
  const p1 = rnd() * Math.PI * 2, p2 = rnd() * Math.PI * 2;
  const half: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    let p = 1 + 0.13 * Math.sin(f * 2 * Math.PI * t + p1) + 0.06 * Math.sin(f * 5.3 * Math.PI * t + p2);
    p *= (opts.loop ? 0.7 : 0.55) + (opts.loop ? 0.3 : 0.45) * smooth(t / inT);
    if (taperEnd) p *= 0.36 + 0.64 * smooth((1 - t) / outT);
    half.push(Math.max(0.6, (width * p) / 2));
  }

  const nrm: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    nrm.push([-dy / L, dx / L]);
  }

  const count = Math.max(3, Math.min(30, Math.round(total / 12)));
  const per = Math.max(1, Math.ceil((n - 1) / count));
  const chunks: InkChunk[] = [];
  for (let i0 = 0; i0 < n - 1; i0 += per) {
    const i1 = Math.min(n - 1, i0 + per + 1);   // one sample of overlap hides seams
    let left = "", right = "";
    for (let i = i0; i <= i1; i++) {
      const lx = pts[i][0] + nrm[i][0] * half[i], ly = pts[i][1] + nrm[i][1] * half[i];
      const rx = pts[i][0] - nrm[i][0] * half[i], ry = pts[i][1] - nrm[i][1] * half[i];
      left += `${i === i0 ? "M" : "L"}${fmt(lx)} ${fmt(ly)} `;
      right = `L${fmt(rx)} ${fmt(ry)} ${right}`;
    }
    chunks.push({ d: `${left}${right}Z`, t: i0 / (n - 1) });
  }
  const caps: InkCap[] = [
    { x: pts[0][0], y: pts[0][1], r: half[0], t: 0 },
    { x: pts[n - 1][0], y: pts[n - 1][1], r: half[n - 1], t: 1 },
  ];
  const s0 = Math.floor(n * 0.1), s1 = Math.max(s0 + 2, Math.ceil(n * 0.8));
  const sheen = total > 40 ? polyD(pts.slice(s0, s1)) : "";
  return { pts, d, sheen, chunks, caps, total };
}

/**
 * Arrowhead in the hand style: slightly uneven barbs, bowed edges and a notched back.
 * The tip is exactly at `tip`; `u` is the unit direction of travel.
 */
export function handHead(tip: Pt, u: [number, number], length: number, width: number, rnd: () => number): string {
  const [ux, uy] = u;
  const nx = -uy, ny = ux;
  const skew = (rnd() - 0.5) * 0.18;
  const lLen = length * (1 + skew), rLen = length * (1 - skew);
  const lW = (width / 2) * (1 + skew * 0.6), rW = (width / 2) * (1 - skew * 0.6);
  const l: Pt = [tip[0] - ux * lLen + nx * lW, tip[1] - uy * lLen + ny * lW];
  const r: Pt = [tip[0] - ux * rLen - nx * rW, tip[1] - uy * rLen - ny * rW];
  const notch: Pt = [tip[0] - ux * length * 0.7, tip[1] - uy * length * 0.7];
  const bulge = width * 0.09;
  const ql: Pt = [(tip[0] + l[0]) / 2 + nx * bulge, (tip[1] + l[1]) / 2 + ny * bulge];
  const qr: Pt = [(tip[0] + r[0]) / 2 - nx * bulge, (tip[1] + r[1]) / 2 - ny * bulge];
  const P = (p: Pt) => `${fmt(p[0])} ${fmt(p[1])}`;
  return `M${P(tip)} Q${P(ql)} ${P(l)} L${P(notch)} L${P(r)} Q${P(qr)} ${P(tip)} Z`;
}

/* ───────────── text measuring for label pills ───────────── */

let measureCtx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

/** Width of a label in px. Measured with a canvas when possible, estimated otherwise. */
export function textWidth(text: string, size = 16, weight = 700): number {
  const key = `${weight}/${size}/${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  let w = 0;
  try {
    if (measureCtx === undefined) {
      measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
    }
    if (measureCtx) {
      measureCtx.font = `${weight} ${size}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
      w = measureCtx.measureText(text).width;
    }
  } catch {
    w = 0;
  }
  if (!(w > 0)) w = text.length * size * 0.575;
  w += text.length * 0.1 + 1;
  if (widthCache.size > 600) widthCache.clear();
  widthCache.set(key, w);
  return w;
}
