// Lasso (mode C) detection: the user circles something while dragging the glass.
import type { Pt } from "@shared/contracts";

const DETECT_WINDOW_MS = 1500;
const TRAIL_MS = 2500;
const MIN_SEG = 3; // pt, shorter segments are ignored for turning
const TURN_DEG = 300;
const CLOSE_DIST = 80;
const DECIMATE = 4;
const MAX_POINTS = 200;

interface TPt {
  x: number;
  y: number;
  t: number;
}

export interface LassoLoop {
  points: Pt[];
  bbox: { x: number; y: number; w: number; h: number };
}

/** Keep newest points at >= `spacing` pt apart, capped at `cap` (oldest dropped). */
function decimate(pts: TPt[], spacing: number, cap: number): Pt[] {
  const out: Pt[] = [];
  let lx = NaN;
  let ly = NaN;
  for (const p of pts) {
    if (out.length === 0 || Math.hypot(p.x - lx, p.y - ly) >= spacing) {
      out.push([p.x, p.y]);
      lx = p.x;
      ly = p.y;
    }
  }
  const last = pts[pts.length - 1];
  if (last && out.length > 0) {
    const tail = out[out.length - 1];
    if (tail[0] !== last.x || tail[1] !== last.y) out.push([last.x, last.y]);
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
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

export class LassoTracker {
  private pts: TPt[] = [];
  /** Bumped whenever the trail changes, so callers can skip redundant emits. */
  version = 0;

  reset(): void {
    this.pts = [];
    this.version++;
  }

  push(x: number, y: number, t: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return;
    const last = this.pts[this.pts.length - 1];
    if (last && last.x === x && last.y === y) return;
    this.pts.push({ x, y, t });
    const cutoff = t - TRAIL_MS;
    let drop = 0;
    while (drop < this.pts.length - 1 && this.pts[drop].t < cutoff) drop++;
    if (drop) this.pts.splice(0, drop);
    this.version++;
  }

  /** Trail of the last ~2.5 s, decimated to >= 4 pt spacing, max 200 points. */
  trail(): Pt[] {
    return decimate(this.pts, DECIMATE, MAX_POINTS);
  }

  /**
   * Looks for a loop ending at the newest point within the last 1.5 s: walking back from the
   * newest point, sum the signed turning angle between movement vectors (segments < 3 pt merged);
   * the first start point where |sum| > 300° and that start is within 80 pt of the newest point
   * closes the loop.
   */
  detect(): LassoLoop | null {
    const n = this.pts.length;
    if (n < 4) return null;
    const now = this.pts[n - 1];
    const cutoff = now.t - DETECT_WINDOW_MS;

    // Spaced points, newest first.
    const sp: TPt[] = [now];
    for (let i = n - 2; i >= 0; i--) {
      const p = this.pts[i];
      if (p.t < cutoff) break;
      const q = sp[sp.length - 1];
      if (Math.hypot(p.x - q.x, p.y - q.y) >= MIN_SEG) sp.push(p);
    }
    if (sp.length < 4) return null;

    const limit = (TURN_DEG * Math.PI) / 180;
    let sum = 0;
    // Segment j runs from sp[j+1] (older) to sp[j] (newer).
    for (let j = 1; j < sp.length - 1; j++) {
      const ax = sp[j].x - sp[j + 1].x;
      const ay = sp[j].y - sp[j + 1].y;
      const bx = sp[j - 1].x - sp[j].x;
      const by = sp[j - 1].y - sp[j].y;
      sum += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      const start = sp[j + 1];
      if (Math.abs(sum) > limit && Math.hypot(start.x - now.x, start.y - now.y) <= CLOSE_DIST) {
        const loopRaw = this.pts.filter((p) => p.t >= start.t);
        const points = decimate(loopRaw, DECIMATE, MAX_POINTS);
        if (points.length < 3) return null;
        return { points, bbox: bboxOf(points) };
      }
    }
    return null;
  }
}
