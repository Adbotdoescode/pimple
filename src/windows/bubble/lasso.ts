// Lasso (mode C) detection: the user circles something while dragging the glass.
//
// The tracker keeps a stable, evenly spaced copy of the stroke (a point is stored once and never
// re-sampled, so the drawn ribbon cannot shimmer) with the running signed turning angle at each
// point. A loop is the pen coming back to (or crossing) its own stroke after turning 300° or more;
// it must enclose a real area, so hand jitter and U-turns never count.
import type { Pt } from "@shared/contracts";

const SPACING = 5; // pt between stored points
const WINDOW_MS = 6000; // a loop must be drawn within this long (a careful loop round a paragraph takes 3 to 5 s)
const TURN_LOOP = (300 * Math.PI) / 180;
const TURN_MAX = (470 * Math.PI) / 180; // beyond this the start is a previous lap
const TURN_HINT = (215 * Math.PI) / 180; // clearly circling (more than a U-turn): start showing the ribbon
const STEP_MAX = (150 * Math.PI) / 180; // a sharper step is a reversal, not curvature
const CLOSE_MAX = 80; // pt, the pen must come back this close to the loop's start
const CLOSE_MIN = 30;
const CLOSE_FRAC = 0.4; // ...and within this fraction of the loop's size
const MIN_SIDE = 40; // pt, smaller loops are jitter
const MIN_LEN = 170; // pt of path
const MIN_FILL = 0.22; // enclosed area / bounding-box area (a circle is 0.79, a scribble near 0)
const JUMP_PT = 260; // a move this long...
const JUMP_MS = 45; // ...within this time is a glitch, not the hand
const MAX_POINTS = 700;
const MAX_OUT = 240;

interface TPt {
  x: number;
  y: number;
  t: number;
  /** Signed turning (rad) accumulated along the stroke up to this point. */
  turn: number;
  /** Path length (pt) up to this point. */
  len: number;
  /** Heading (rad) of the segment arriving at this point. */
  dir: number;
}

export interface LassoLoop {
  points: Pt[];
  bbox: { x: number; y: number; w: number; h: number };
}

function bboxOf(points: Pt[]): LassoLoop["bbox"] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Shoelace area of the polygon (absolute). */
function areaOf(points: Pt[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/** Where segments a–b and c–d cross, or null. */
function crossing(a: TPt, b: TPt, c: TPt, d: TPt): Pt | null {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a.x + t * rx, a.y + t * ry];
}

/** At most `cap` points, evenly thinned, always keeping the first and the last. */
function thin(points: Pt[], cap: number): Pt[] {
  if (points.length <= cap) return points;
  const out: Pt[] = [];
  const step = (points.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) out.push(points[Math.round(i * step)]);
  return out;
}

export class LassoTracker {
  private pts: TPt[] = [];
  private head: { x: number; y: number } | null = null;
  /** Detection never looks back past this index (a restarted stroke). */
  private floor = 0;
  /** The loop currently locked in (its box and area), if any. */
  private lock: { bbox: LassoLoop["bbox"]; area: number } | null = null;
  /** Bumped whenever the trail changes, so callers can skip redundant emits. */
  version = 0;
  /** Which rule closed the latest loop (for the state log). */
  why = "";

  reset(): void {
    this.pts = [];
    this.head = null;
    this.floor = 0;
    this.lock = null;
    this.version++;
  }

  /** Start a fresh stroke at the pen's current position (the old loop was abandoned). */
  restart(): void {
    const last = this.pts[this.pts.length - 1];
    this.pts = last ? [{ ...last, turn: 0, len: 0, dir: NaN }] : [];
    this.floor = 0;
    this.lock = null;
    this.version++;
  }

  push(x: number, y: number, t: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return;
    if (this.head && this.head.x === x && this.head.y === y) return;
    this.head = { x, y };
    this.version++;
    const last = this.pts[this.pts.length - 1];
    if (!last) {
      this.pts.push({ x, y, t, turn: 0, len: 0, dir: NaN });
      return;
    }
    const d = Math.hypot(x - last.x, y - last.y);
    if (d < SPACING) return;
    // A jump no hand can make (the window's frame changing under the pointer as a drag starts
    // reports a few stale positions): not part of the stroke.
    if (d > JUMP_PT && t - last.t < JUMP_MS) return;
    const dir = Math.atan2(y - last.y, x - last.x);
    let step = 0;
    if (Number.isFinite(last.dir)) {
      step = dir - last.dir;
      while (step > Math.PI) step -= 2 * Math.PI;
      while (step < -Math.PI) step += 2 * Math.PI;
      if (Math.abs(step) > STEP_MAX) step = 0;
    }
    this.pts.push({ x, y, t, turn: last.turn + step, len: last.len + d, dir });
    if (this.pts.length > MAX_POINTS) {
      const drop = this.pts.length - MAX_POINTS;
      this.pts.splice(0, drop);
      this.floor = Math.max(0, this.floor - drop);
    }
  }

  /** Index where the arc the pen is on began: the furthest-back point in the window whose turning
   *  differs most from now (the latest such point, so a straight approach is left out). */
  private arcStart(): { i: number; turn: number } | null {
    const n = this.pts.length;
    if (n < 6) return null;
    const now = this.pts[n - 1];
    let best = -1;
    let bestTurn = 0;
    for (let i = n - 2; i >= this.floor; i--) {
      const p = this.pts[i];
      if (now.t - p.t > WINDOW_MS) break;
      const turn = Math.abs(now.turn - p.turn);
      if (turn > TURN_MAX) break;
      if (turn > bestTurn + 0.12) {
        bestTurn = turn;
        best = i;
      }
    }
    return best >= 0 ? { i: best, turn: bestTurn } : null;
  }

  /** True once the pen is clearly circling (well past a U-turn) but has not closed a loop yet. */
  curving(): boolean {
    const a = this.arcStart();
    return a !== null && a.turn >= TURN_HINT;
  }

  /** The live ribbon: from where the current arc began to the pen. Stable points, never re-sampled. */
  trail(): Pt[] {
    const a = this.arcStart();
    const from = a ? a.i : Math.max(this.floor, this.pts.length - 1);
    const out: Pt[] = [];
    for (let i = from; i < this.pts.length; i++) out.push([this.pts[i].x, this.pts[i].y]);
    if (this.head) {
      const tail = out[out.length - 1];
      if (!tail || tail[0] !== this.head.x || tail[1] !== this.head.y) out.push([this.head.x, this.head.y]);
    }
    return thin(out, MAX_OUT);
  }

  private accept(points: Pt[], closeGap: number): (LassoLoop & { area: number }) | null {
    if (points.length < 8) return null;
    const bbox = bboxOf(points);
    if (Math.min(bbox.w, bbox.h) < MIN_SIDE) return null;
    const size = Math.max(bbox.w, bbox.h);
    if (closeGap > Math.min(CLOSE_MAX, Math.max(CLOSE_MIN, CLOSE_FRAC * size))) return null;
    const area = areaOf(points);
    if (area < MIN_FILL * bbox.w * bbox.h) return null;
    return { points: thin(points, MAX_OUT), bbox, area };
  }

  /**
   * A loop ending at the newest stored point, or null. Candidates:
   *  (a) Self-crossing: the newest segment crosses an earlier part of the stroke; the loop is
   *      exactly the part between the two crossings.
   *  (b) Return: the pen is back near a point of the stroke (within 80 pt and 40% of the loop's size).
   * Either way the pen must have turned 300° to 470° on the way, and the loop must be at least 40 pt
   * across, 170 pt long and enclose a real area. Of all candidates the one enclosing the largest
   * area wins, so an approach that cuts through the circle never shrinks it to a sliver.
   * Once a loop is locked, only a clearly larger one, or one somewhere else, replaces it; the pen
   * lingering on the join does not make the loop flicker.
   */
  detect(): LassoLoop | null {
    const n = this.pts.length;
    if (n < 8) return null;
    const now = this.pts[n - 1];
    const prev = this.pts[n - 2];
    let best: (LassoLoop & { area: number }) | null = null;
    let why = "";

    for (let i = n - 6; i >= this.floor; i--) {
      const p = this.pts[i];
      if (now.t - p.t > WINDOW_MS) break;
      const turn = Math.abs(now.turn - p.turn);
      if (turn > TURN_MAX) break;
      if (turn < TURN_LOOP || now.len - p.len < MIN_LEN) continue;

      // (a) self-crossing with the segment that starts at p
      const x = crossing(prev, now, p, this.pts[i + 1]);
      if (x) {
        const points: Pt[] = [x];
        for (let k = i + 1; k <= n - 2; k++) points.push([this.pts[k].x, this.pts[k].y]);
        const loop = this.accept(points, 0);
        if (loop && (!best || loop.area > best.area)) {
          best = loop;
          why = `crossing, ${Math.round((turn * 180) / Math.PI)}°`;
        }
      }

      // (b) back near p (every other point is plenty at 5 pt spacing)
      if ((n - i) % 2 === 0) {
        const d = Math.hypot(p.x - now.x, p.y - now.y);
        if (d <= CLOSE_MAX) {
          const points: Pt[] = [];
          for (let k = i; k < n; k++) points.push([this.pts[k].x, this.pts[k].y]);
          const loop = this.accept(points, d);
          if (loop && (!best || loop.area > best.area)) {
            best = loop;
            why = `return, gap ${Math.round(d)} pt, ${Math.round((turn * 180) / Math.PI)}°`;
          }
        }
      }
    }
    if (!best) return null;

    const lock = this.lock;
    if (lock) {
      const cx = best.bbox.x + best.bbox.w / 2, cy = best.bbox.y + best.bbox.h / 2;
      const inside = cx >= lock.bbox.x && cx <= lock.bbox.x + lock.bbox.w && cy >= lock.bbox.y && cy <= lock.bbox.y + lock.bbox.h;
      if (inside && best.area < lock.area * 1.2) return null;
    }
    this.lock = { bbox: best.bbox, area: best.area };
    this.why = why;
    return { points: best.points, bbox: best.bbox };
  }
}
