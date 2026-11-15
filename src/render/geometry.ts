import type { Pt } from "@shared/contracts";

export const isFiniteNum = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

export const isFinitePt = (p: unknown): p is Pt =>
  Array.isArray(p) && p.length >= 2 && isFiniteNum(p[0]) && isFiniteNum(p[1]);

export const isRect = (r: unknown): r is [number, number, number, number] =>
  Array.isArray(r) && r.length === 4 && r.every(isFiniteNum);

/** Compact number formatting for SVG path data and attributes. */
export function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function linePath(a: Pt, b: Pt): string {
  return `M${fmt(a[0])} ${fmt(a[1])} L${fmt(b[0])} ${fmt(b[1])}`;
}

/** Catmull-Rom through the points, converted to cubic Beziers (tension 0.5). */
export function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d;
}

/** Full circle starting at the top, drawn clockwise. */
export function circlePath(cx: number, cy: number, r: number): string {
  return `M${fmt(cx)} ${fmt(cy - r)} A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx)} ${fmt(cy + r)} A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx)} ${fmt(cy - r)}`;
}

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  const x2 = x + w, y2 = y + h;
  return [
    `M${fmt(x + rr)} ${fmt(y)}`,
    `L${fmt(x2 - rr)} ${fmt(y)}`,
    `Q${fmt(x2)} ${fmt(y)} ${fmt(x2)} ${fmt(y + rr)}`,
    `L${fmt(x2)} ${fmt(y2 - rr)}`,
    `Q${fmt(x2)} ${fmt(y2)} ${fmt(x2 - rr)} ${fmt(y2)}`,
    `L${fmt(x + rr)} ${fmt(y2)}`,
    `Q${fmt(x)} ${fmt(y2)} ${fmt(x)} ${fmt(y2 - rr)}`,
    `L${fmt(x)} ${fmt(y + rr)}`,
    `Q${fmt(x)} ${fmt(y)} ${fmt(x + rr)} ${fmt(y)}`,
    "Z",
  ].join(" ");
}

/**
 * Filled triangular arrowhead with its tip at `to`, oriented along from→to.
 * `shaftEnd` is where the shaft should stop (inside the head, so it never pokes through the tip).
 */
export function arrowHead(
  from: Pt,
  to: Pt,
  length: number,
  width: number,
): { d: string; shaftEnd: Pt } | null {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const L = Math.hypot(dx, dy);
  if (!(L >= 1)) return null;
  const ux = dx / L, uy = dy / L;
  const nx = -uy, ny = ux;
  const bx = to[0] - ux * length, by = to[1] - uy * length;
  const lx = bx + nx * (width / 2), ly = by + ny * (width / 2);
  const rx = bx - nx * (width / 2), ry = by - ny * (width / 2);
  const d = `M${fmt(to[0])} ${fmt(to[1])} L${fmt(lx)} ${fmt(ly)} L${fmt(rx)} ${fmt(ry)} Z`;
  const shaftEnd: Pt = [to[0] - ux * length * 0.55, to[1] - uy * length * 0.55];
  return { d, shaftEnd };
}

/** Unit vector and a normal chosen to point up (or left when horizontal-ish). */
export function unitAndUpNormal(a: Pt, b: Pt): { u: [number, number]; n: [number, number] } | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (!(L >= 1)) return null;
  const u: [number, number] = [dx / L, dy / L];
  const n1: [number, number] = [-u[1], u[0]];
  const n2: [number, number] = [u[1], -u[0]];
  const score = (n: [number, number]) => -n[1] - 0.01 * n[0];
  return { u, n: score(n1) >= score(n2) ? n1 : n2 };
}

/** Maps graph data coordinates into view coordinates for a plot rectangle. */
export function graphMapper(
  range: { x_min: number; x_max: number; y_min: number; y_max: number },
  plot: { left: number; right: number; top: number; bottom: number },
): { X: (v: number) => number; Y: (v: number) => number } {
  const kx = (plot.right - plot.left) / (range.x_max - range.x_min);
  const ky = (plot.bottom - plot.top) / (range.y_max - range.y_min);
  return {
    X: (v) => plot.left + (v - range.x_min) * kx,
    Y: (v) => plot.bottom - (v - range.y_min) * ky,
  };
}
