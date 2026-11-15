/**
 * Pure layout for the whiteboard: fits a response's shapes into the virtual board.
 * Never mutates its input; every returned shape is a new object.
 */
import type { Pt, Shape } from "@shared/contracts";

export interface Box { x: number; y: number; w: number; h: number }
export interface BoardSize { w: number; h: number }
/** grow: scale small compositions up to fill the board (whiteboard answers; off for overlay backdrops). */
export interface FitOptions { grow?: boolean }

const DEFAULT_BOARD: BoardSize = { w: 1600, h: 1000 };
/** View px per board unit. Constant, so label placements never depend on the window size; the
 *  camera in Whiteboard.tsx does all the fitting. */
export const VIEW_SCALE = 0.7;
// A 16 px bold label on its 24 px pill, in board units.
const TEXT_CHAR_W = 9.4 / VIEW_SCALE;
const TEXT_H = 26 / VIEW_SCALE;
const LABEL_PAD = 30;
const TEXT_GAP = 8;
const MAX_PASSES = 40;
const GROW_MAX = 1.35;
const GROW_MAX_SMALL = 2.0; // for compositions narrower than SMALL_W
const SMALL_W = 500;
const NUDGE_STEPS = [14, -14, 28, -28];
// Room the axis labels need beside a graph's plot (board units).
const GRAPH_ZONE_LEFT = 64;
const GRAPH_ZONE_BOTTOM = 56;

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

function overlaps(a: Box, b: Box): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0
  );
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

/** Scale every shape uniformly by k about the centre of box. */
function scaleAbout(shapes: Shape[], box: Box, k: number): Shape[] {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const f = (p: Pt): Pt => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k];
  return shapes.map((s) => mapShape(s, f, k));
}

function translateAll(shapes: Shape[], dx: number, dy: number): Shape[] {
  if (!dx && !dy) return shapes;
  return shapes.map((s) => mapShape(s, (p): Pt => [p[0] + dx, p[1] + dy]));
}

/** Axis-label zone of a graph: the plot rect plus room for its axis labels. */
function graphZone(g: Shape): Box | null {
  if (!isRect(g.rect)) return null;
  const [x, y, w, h] = g.rect;
  return { x: x - GRAPH_ZONE_LEFT, y, w: w + GRAPH_ZONE_LEFT, h: h + GRAPH_ZONE_BOTTOM };
}

/** Smallest move that takes box b clear of zone z (with a gap). */
function escapeDelta(b: Box, z: Box): Pt {
  const opts: Pt[] = [
    [0, z.y - (b.y + b.h) - TEXT_GAP], // up
    [0, z.y + z.h - b.y + TEXT_GAP], // down
    [z.x - (b.x + b.w) - TEXT_GAP, 0], // left
    [z.x + z.w - b.x + TEXT_GAP, 0], // right
  ];
  return opts.reduce((best, d) => (Math.hypot(d[0], d[1]) < Math.hypot(best[0], best[1]) ? d : best));
}

/** Liang–Barsky: does segment a–b pass through box? */
function segHitsBox(a: Pt, b: Pt, box: Box): boolean {
  const xmin = box.x, xmax = box.x + box.w, ymin = box.y, ymax = box.y + box.h;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - xmin, xmax - a[0], a[1] - ymin, ymax - a[1]];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

/**
 * Perpendicular nudge for a text box that a segment runs through. Tries ±14 then ±28 units
 * off the segment and keeps the first position with fewer hits (zero preferred).
 */
function nudgeOffSegments(b: Box, segs: [Pt, Pt][]): Pt | null {
  const hitsAt = (box: Box) => segs.reduce((n, [p, q]) => n + (segHitsBox(p, q, box) ? 1 : 0), 0);
  const base = hitsAt(b);
  if (base === 0) return null;
  const hit = segs.find(([p, q]) => segHitsBox(p, q, b));
  if (!hit) return null;
  const [p, q] = hit;
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len === 0) return null;
  const nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len;
  let best: Pt | null = null;
  let bestHits = base;
  for (const d of NUDGE_STEPS) {
    const dx = nx * d, dy = ny * d;
    const h = hitsAt({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
    if (h < bestHits) {
      best = [dx, dy];
      bestHits = h;
    }
    if (bestHits === 0) break;
  }
  return best;
}

/**
 * Text de-overlap in place, up to 40 passes: push a text below an earlier overlapping text, move a
 * text clear of a graph's axis-label zone, and nudge a text perpendicular off a line/arrow/vector.
 * Only text shapes move, and only later ones give way, so a drawing that is still streaming in
 * does not reshuffle what is already on the board.
 */
function deOverlapText(work: Shape[]): void {
  const segs: [Pt, Pt][] = [];
  for (const s of work) {
    if ((s.kind === "line" || s.kind === "arrow" || s.kind === "vector") && isPt(s.from) && isPt(s.to)) {
      segs.push([s.from, s.to]);
    }
  }
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;

    // text vs text: push the later one down until clear
    for (let i = 0; i < work.length; i++) {
      const ba = work[i].kind === "text" ? shapeBBox(work[i]) : null;
      if (!ba) continue;
      for (let j = i + 1; j < work.length; j++) {
        const bb = work[j].kind === "text" ? shapeBBox(work[j]) : null;
        if (!bb || !overlaps(ba, bb)) continue;
        const oy = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
        const d = oy + TEXT_GAP;
        work[j] = mapShape(work[j], (p): Pt => [p[0], p[1] + d]);
        moved = true;
      }
    }

    // text vs graph axis-label zone: move it clear the shortest way
    for (let i = 0; i < work.length; i++) {
      if (work[i].kind !== "text") continue;
      const tb = shapeBBox(work[i]);
      if (!tb) continue;
      for (const g of work) {
        if (g.kind !== "graph") continue;
        const z = graphZone(g);
        if (!z || !overlaps(tb, z)) continue;
        const [dx, dy] = escapeDelta(tb, z);
        work[i] = mapShape(work[i], (p): Pt => [p[0] + dx, p[1] + dy]);
        moved = true;
        break;
      }
    }

    // text vs line/arrow/vector: nudge perpendicular off the segment
    for (let i = 0; i < work.length; i++) {
      if (work[i].kind !== "text") continue;
      const tb = shapeBBox(work[i]);
      if (!tb) continue;
      const d = nudgeOffSegments(tb, segs);
      if (d) {
        work[i] = mapShape(work[i], (p): Pt => [p[0] + d[0], p[1] + d[1]]);
        moved = true;
      }
    }

    if (!moved) break;
  }

}

/**
 * Fit shapes into the virtual board (default 1600 x 1000):
 *  (a) drop shapes without geometry (sliders without a rect are kept; the view stacks them);
 *  (b) if the union is larger than the safe area, scale it down about its centre, then slide it
 *      inside; if it is smaller and grow is on, scale up (capped at 1.35) and centre it;
 *  (c) text de-overlap, up to 40 passes: push a text below an earlier overlapping text, move a text
 *      clear of a graph's axis-label zone, and nudge a text perpendicular off a line/arrow/vector;
 *  (d) clamp every shape back inside the safe area.
 * Non-text shapes are never moved by (c).
 */
export function fitShapes(
  shapes: Shape[],
  board: BoardSize = DEFAULT_BOARD,
  margin = 48,
  opts: FitOptions = {},
): Shape[] {
  const grow = opts.grow ?? true;
  let work: Shape[] = [];
  for (const s of shapes) {
    if (s.kind === "slider" && !isRect(s.rect)) work.push({ ...s });
    else if (shapeBBox(s)) work.push({ ...s });
  }

  const x0 = margin, y0 = margin, x1 = board.w - margin, y1 = board.h - margin;
  const safeW = x1 - x0, safeH = y1 - y0;

  // (b) shrink to fit
  const u = unionOf(work);
  if (u && (u.w > safeW || u.h > safeH)) {
    work = scaleAbout(work, u, Math.min(safeW / u.w, safeH / u.h));
  }

  // (b) slide inside the safe area
  const u2 = unionOf(work);
  if (u2) {
    work = translateAll(
      work,
      shiftFor(u2.x, u2.x + u2.w, x0, x1),
      shiftFor(u2.y, u2.y + u2.h, y0, y1),
    );
  }

  // (b) grow to fill: scale up about the centre, capped, then centre in the safe area
  if (grow) {
    const g = unionOf(work);
    if (g && g.w > 0 && g.h > 0) {
      const cap = g.w < SMALL_W ? GROW_MAX_SMALL : GROW_MAX;
      const k = Math.min(cap, safeW / g.w, safeH / g.h);
      if (k > 1) {
        work = scaleAbout(work, g, k);
        const g2 = unionOf(work);
        if (g2) {
          work = translateAll(
            work,
            (x0 + x1) / 2 - (g2.x + g2.w / 2),
            (y0 + y1) / 2 - (g2.y + g2.h / 2),
          );
        }
      }
    }
  }

  // (c) text de-overlap. Segments and non-text shapes stay where they are.
  deOverlapText(work);

  // (d) clamp every shape back inside the safe area
  return work.map((s) => {
    const b = shapeBBox(s);
    if (!b) return s;
    return translateAll([s], shiftFor(b.x, b.x + b.w, x0, x1), shiftFor(b.y, b.y + b.h, y0, y1))[0];
  });
}

/**
 * Where a captured image (imgW × imgH px) sits on the board: contained, centred, with a margin.
 * Returns [x, y, w, h] in board units.
 */
export function imageRectOnBoard(
  imgW: number,
  imgH: number,
  board: BoardSize = DEFAULT_BOARD,
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

/**
 * Whiteboard answers: keep the model's geometry exactly where it drew it (so nothing jumps while the
 * answer streams in) and only tidy it: drop shapes without geometry, give tiny shapes a readable
 * minimum size, and move free text off other text, graph axes and lines. The camera does the fitting.
 */
export function composeBoard(shapes: Shape[]): Shape[] {
  const work: Shape[] = [];
  for (const s of shapes) {
    if (s.kind === "slider" && !isRect(s.rect)) { work.push({ ...s }); continue; }
    if (!shapeBBox(s)) continue;
    const c: Shape = { ...s };
    if (c.kind === "circle" && isNum(c.radius) && c.radius < MIN_RADIUS) c.radius = MIN_RADIUS;
    if (c.kind === "box" && isRect(c.rect)) {
      const [x, y, w, h] = c.rect;
      const w2 = Math.max(w, MIN_BOX), h2 = Math.max(h, MIN_BOX);
      c.rect = [x - (w2 - w) / 2, y - (h2 - h) / 2, w2, h2];
    }
    if (c.kind === "graph" && isRect(c.rect)) {
      const [x, y, w, h] = c.rect;
      const w2 = Math.max(w, MIN_GRAPH_W), h2 = Math.max(h, MIN_GRAPH_H);
      c.rect = [x - (w2 - w) / 2, y - (h2 - h) / 2, w2, h2];
    }
    work.push(c);
  }
  deOverlapText(work);
  return work;
}
const MIN_RADIUS = 14;
const MIN_BOX = 26;
const MIN_GRAPH_W = 360;
const MIN_GRAPH_H = 260;

/**
 * The area the camera should frame for these shapes, in board units: their union plus room for the
 * label pills the renderer hangs beside them. Null when nothing has geometry.
 */
export function contentBox(shapes: Shape[]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) {
    const b = shapeBBox(s);
    if (!b) continue;
    let px = 10, py = 10;
    if (s.kind === "graph") { px = GRAPH_ZONE_LEFT; py = GRAPH_ZONE_BOTTOM; }
    else if (s.kind !== "text" && (s.label || s.magnitude)) {
      const chars = (s.label ?? "").length + (s.magnitude ? s.magnitude.length + 3 : 0);
      px = Math.min(190, chars * TEXT_CHAR_W * 0.75 + 24);
      py = TEXT_H + 14;
    }
    x0 = Math.min(x0, b.x - px);
    y0 = Math.min(y0, b.y - py);
    x1 = Math.max(x1, b.x + b.w + px);
    y1 = Math.max(y1, b.y + b.h + py);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: Math.max(x1 - x0, 1), h: Math.max(y1 - y0, 1) };
}
