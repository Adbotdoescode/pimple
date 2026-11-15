/**
 * Pure layout for the whiteboard: fits a response's shapes into the virtual board.
 * Never mutates its input; every returned shape is a new object.
 */
import type { Pt, Shape } from "@shared/contracts";

export interface Box { x: number; y: number; w: number; h: number }
export interface BoardSize { w: number; h: number }

const TEXT_CHAR_W = 11;
const TEXT_H = 28;
const LABEL_PAD = 30;
const TEXT_GAP = 8;
const MAX_TEXT_PASSES = 30;

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isPt = (p: unknown): p is Pt =>
  Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]);
const isRect = (r: unknown): r is [number, number, number, number] =>
  Array.isArray(r) && r.length >= 4 && isNum(r[0]) && isNum(r[1]) && isNum(r[2]) && isNum(r[3]);

function boxOf(pts: Pt[], pad = 0): Box | null {
  if (pts.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** Bounding box of a shape's geometry, or null when the shape lacks what its kind needs. */
export function shapeBBox(s: Shape): Box | null {
  switch (s.kind) {
    case "circle": {
      if (!isPt(s.center) || !isNum(s.radius)) return null;
      const r = Math.max(0, s.radius);
      return { x: s.center[0] - r, y: s.center[1] - r, w: 2 * r, h: 2 * r };
    }
    case "box":
    case "graph":
    case "slider": {
      if (!isRect(s.rect)) return null;
      const [x, y, w, h] = s.rect;
      return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
    }
    case "line":
    case "arrow":
    case "vector": {
      if (!isPt(s.from) || !isPt(s.to)) return null;
      return boxOf([s.from, s.to], s.label ? LABEL_PAD : 0);
    }
    case "stroke":
      return boxOf((s.points ?? []).filter(isPt));
    case "text": {
      if (!isPt(s.center)) return null;
      const w = (s.label ?? "").length * TEXT_CHAR_W;
      return { x: s.center[0] - w / 2, y: s.center[1] - TEXT_H / 2, w, h: TEXT_H };
    }
    default:
      return null;
  }
}

function unionOf(shapes: Shape[]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) {
    const b = shapeBBox(s);
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Shift needed to bring [a0, a1] inside [b0, b1]; 0 when it already fits. */
function shiftFor(a0: number, a1: number, b0: number, b1: number): number {
  if (a0 < b0) return b0 - a0;
  if (a1 > b1) return b1 - a1;
  return 0;
}

/**
 * Copy a shape with its geometry mapped through f. k scales radii and rect sizes;
 * text labels keep their size (only the anchor moves).
 */
function mapShape(s: Shape, f: (p: Pt) => Pt, k = 1): Shape {
  const out: Shape = { ...s };
  if (isPt(s.center)) out.center = f(s.center);
  if (isPt(s.from)) out.from = f(s.from);
  if (isPt(s.to)) out.to = f(s.to);
  if (Array.isArray(s.points)) out.points = s.points.filter(isPt).map((p) => f(p));
  if (isNum(s.radius)) out.radius = s.radius * k;
  if (isRect(s.rect)) {
    const [x, y] = f([s.rect[0], s.rect[1]]);
    out.rect = [x, y, s.rect[2] * k, s.rect[3] * k];
  }
  return out;
}

/**
 * Fit shapes into the virtual board (default 1600 x 1000):
 *  (a) drop shapes without geometry (sliders without a rect are kept; the view stacks them);
 *  (b) if the union is larger than the safe area, scale it uniformly about its centre, then
 *      slide it minimally inside the safe area;
 *  (c) push overlapping text labels down, then clamp every shape back inside the safe area.
 */
export function fitShapes(
  shapes: Shape[],
  board: BoardSize = { w: 1600, h: 1000 },
  margin = 32,
): Shape[] {
  let work: Shape[] = [];
  for (const s of shapes) {
    if (s.kind === "slider" && !isRect(s.rect)) work.push({ ...s });
    else if (shapeBBox(s)) work.push({ ...s });
  }

  const x0 = margin, y0 = margin, x1 = board.w - margin, y1 = board.h - margin;
  const safeW = x1 - x0, safeH = y1 - y0;

  // (b) scale down if needed
  const u = unionOf(work);
  if (u && (u.w > safeW || u.h > safeH)) {
    const k = Math.min(safeW / u.w, safeH / u.h);
    const cx = u.x + u.w / 2, cy = u.y + u.h / 2;
    const scaleP = (p: Pt): Pt => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k];
    work = work.map((s) => mapShape(s, scaleP, k));
  }

  // (b) slide inside the safe area
  const u2 = unionOf(work);
  if (u2) {
    const dx = shiftFor(u2.x, u2.x + u2.w, x0, x1);
    const dy = shiftFor(u2.y, u2.y + u2.h, y0, y1);
    if (dx || dy) work = work.map((s) => mapShape(s, (p): Pt => [p[0] + dx, p[1] + dy]));
  }

  // (c) text de-overlap: push the later label down until clear
  for (let pass = 0; pass < MAX_TEXT_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < work.length; i++) {
      const a = work[i];
      const ba = a.kind === "text" ? shapeBBox(a) : null;
      if (!ba) continue;
      for (let j = i + 1; j < work.length; j++) {
        const b = work[j];
        const bb = b.kind === "text" ? shapeBBox(b) : null;
        if (!bb) continue;
        const ox = Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x);
        const oy = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
        if (ox > 0 && oy > 0) {
          const d = oy + TEXT_GAP;
          work[j] = mapShape(b, (p): Pt => [p[0], p[1] + d]);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  // (c) clamp every shape individually back inside the safe area
  return work.map((s) => {
    const b = shapeBBox(s);
    if (!b) return s;
    const dx = shiftFor(b.x, b.x + b.w, x0, x1);
    const dy = shiftFor(b.y, b.y + b.h, y0, y1);
    return dx || dy ? mapShape(s, (p): Pt => [p[0] + dx, p[1] + dy]) : s;
  });
}

/**
 * Where a captured image (imgW × imgH px) sits on the board: contained, centred, with a margin.
 * Returns [x, y, w, h] in board units.
 */
export function imageRectOnBoard(
  imgW: number,
  imgH: number,
  board: BoardSize = { w: 1600, h: 1000 },
  margin = 24,
): [number, number, number, number] {
  if (!(imgW > 0) || !(imgH > 0)) return [0, 0, board.w, board.h];
  const k = Math.min((board.w - 2 * margin) / imgW, (board.h - 2 * margin) / imgH);
  const w = imgW * k, h = imgH * k;
  return [(board.w - w) / 2, (board.h - h) / 2, w, h];
}

/**
 * Overlay responses use pixels of the captured image. Map them into board units using the same
 * transform as imageRectOnBoard, so they line up with the drawn screenshot. Pure: returns new shapes.
 */
export function mapImageShapesToBoard(shapes: Shape[], imgW: number, imgH: number): Shape[] {
  if (!(imgW > 0) || !(imgH > 0)) return shapes.map((s) => ({ ...s }));
  const [x0, y0, w] = imageRectOnBoard(imgW, imgH);
  const k = w / imgW;
  const f = (p: Pt): Pt => [x0 + p[0] * k, y0 + p[1] * k];
  return shapes.map((s) => mapShape(s, f, k));
}
