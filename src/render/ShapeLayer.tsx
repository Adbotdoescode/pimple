import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Pt, Shape } from "@shared/contracts";
import { pillFor, type PillStyle, type ShapeStyle } from "./palette";
import {
  arrowHead,
  boxOverlapArea,
  fmt,
  graphMapper,
  inflate,
  isFiniteNum,
  isFinitePt,
  isRect,
  linePath,
  polySegs,
  rectSegs,
  segHitsBox,
  unitAndUpNormal,
  type Box,
  type Seg,
} from "./geometry";
import { curvePts, handBox, handCircle, handHead, handLine, inkGeom, polyD, seedOf, textWidth, type InkOpts } from "./ink";
import "./render.css";

export type { ShapeStyle } from "./palette";

export interface ShapeLayerProps {
  shapes: Shape[];
  visibleSegmentIds: string[];
  pulseShapeIds?: string[];
  variant?: "main" | "sidenote";
  toView: (p: Pt) => Pt;
  scale: number;
  styleFor: (shape: Shape) => ShapeStyle;
  /** Root opacity (0..1). Transitions over 400 ms. Used to dim main shapes behind a side note. */
  opacity?: number;
  /** Visible area in SVG user coordinates. When given, labels are kept inside it. */
  viewport?: { width: number; height: number };
}

const STEP_MS = 120;   // stagger between shapes that appear together
const DRAW_MS = 460;   // stroke-draw duration (keep in step with .gt-draw in render.css)
const TIP_LINGER_MS = 240; // the pen tip lifts and fades after the stroke
const STROKE_W = 3.8;
const LABEL_OFFSET = 8;  // clear gap between a stroke and the edge of its label pill
const PILL_PAD_X = 8;
const PILL_HALF_H = 12;
const LABEL_MID = 5.5;   // baseline to visual middle of 16 px bold text

interface LabelPlacement { x: number; y: number; anchor: "start" | "middle" | "end" }

/** Per-shape rendering context. `delay` is the stroke start time in ms. */
interface Ctx {
  toView: (p: Pt) => Pt;
  scale: number;
  style: ShapeStyle;
  side: boolean;
  delay: number;
  placements: Map<string, LabelPlacement>;
}

interface Built {
  main?: string;      // primary path, used for the pulse glow
  nodes: ReactNode[];
}

interface Item { shape: Shape; index: number }

export function ShapeLayer(props: ShapeLayerProps): ReactElement {
  const { shapes, visibleSegmentIds, pulseShapeIds, variant = "main", toView, scale, styleFor, opacity = 1, viewport } = props;
  const side = variant === "sidenote";
  const pulseSet = new Set(pulseShapeIds ?? []);

  // Only shapes in visible segments mount. Index within the segment drives the stagger.
  const items = useMemo<Item[]>(() => {
    const visibleSet = new Set(visibleSegmentIds);
    const counters = new Map<string, number>();
    const out: Item[] = [];
    for (const shape of shapes) {
      if (!visibleSet.has(shape.segment_id)) continue;
      const index = counters.get(shape.segment_id) ?? 0;
      counters.set(shape.segment_id, index + 1);
      out.push({ shape, index });
    }
    return out;
  }, [shapes, visibleSegmentIds]);

  // Label placements. Cached per shape id so labels already on screen do not jump when others appear.
  const cacheRef = useRef<Map<string, LabelPlacement>>(new Map());
  const vpW = viewport?.width;
  const vpH = viewport?.height;
  const placements = useMemo(() => {
    const vp = vpW !== undefined && vpH !== undefined ? { width: vpW, height: vpH } : undefined;
    try {
      return computePlacements(items, toView, scale, vp, cacheRef.current);
    } catch {
      return new Map<string, LabelPlacement>();
    }
  }, [items, toView, scale, vpW, vpH]);

  return (
    <g className={side ? "gt-root gt-sidenote" : "gt-root"} style={{ opacity }}>
      <defs>
        <linearGradient id="gt-pill-light" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#eef2f9" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id="gt-pill-dark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a4254" stopOpacity="0.84" />
          <stop offset="1" stopColor="#10141d" stopOpacity="0.8" />
        </linearGradient>
      </defs>
      {items.map(({ shape, index }) => (
        <ShapeNode
          key={shape.id}
          shape={shape}
          index={index}
          toView={toView}
          scale={scale}
          style={styleFor(shape)}
          side={side}
          pulsing={pulseSet.has(shape.id)}
          placements={placements}
        />
      ))}
    </g>
  );
}

interface ShapeNodeProps {
  shape: Shape;
  index: number;
  toView: (p: Pt) => Pt;
  scale: number;
  style: ShapeStyle;
  side: boolean;
  pulsing: boolean;
  placements: Map<string, LabelPlacement>;
}

function ShapeNode({ shape, index, toView, scale, style, side, pulsing, placements }: ShapeNodeProps): ReactElement | null {
  const ctx: Ctx = {
    toView,
    scale,
    style,
    side,
    delay: index * STEP_MS,
    placements,
  };
  let built: Built | null;
  try {
    built = build(shape, ctx);
  } catch {
    return null;
  }
  if (!built || built.nodes.length === 0) return null;
  const glow = pulsing && built.main ? (
    <path
      key="glow"
      d={built.main}
      fill="none"
      stroke={style.stroke}
      strokeWidth={STROKE_W + 8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="gt-glow"
    />
  ) : null;
  return (
    <g
      className={side ? "gt-side-shape" : undefined}
      style={side ? { animationDelay: `${ctx.delay}ms` } : undefined}
    >
      {glow}
      {built.nodes}
    </g>
  );
}

function build(shape: Shape, c: Ctx): Built | null {
  switch (shape.kind) {
    case "circle": return buildCircle(shape, c);
    case "box": return buildBox(shape, c);
    case "line": return buildSegment(shape, c, "line");
    case "arrow": return buildSegment(shape, c, "arrow");
    case "vector": return buildSegment(shape, c, "vector");
    case "stroke": return buildStroke(shape, c);
    case "text": return buildText(shape, c);
    case "graph": return buildGraph(shape, c);
    case "slider": return buildSlider(shape, c);
    default: return null;
  }
}

/* ───────────── view geometry shared by builders, candidates and obstacles ───────────── */

interface CircleG { cx: number; cy: number; R: number }
function circleGeom(s: Shape, toView: (p: Pt) => Pt, scale: number): CircleG | null {
  if (!isFinitePt(s.center) || !isFiniteNum(s.radius) || s.radius <= 0) return null;
  const [cx, cy] = toView(s.center);
  const R = s.radius * scale;
  if (!isFiniteNum(cx) || !isFiniteNum(cy) || !isFiniteNum(R) || R <= 0) return null;
  return { cx, cy, R };
}

interface RectG { L: number; T: number; W: number; H: number }
function rectGeom(rect: unknown, toView: (p: Pt) => Pt): RectG | null {
  if (!isRect(rect)) return null;
  const [x, y, w, h] = rect;
  const a = toView([x, y]);
  const b = toView([x + w, y + h]);
  if (!isFinitePt(a) || !isFinitePt(b)) return null;
  const W = Math.abs(b[0] - a[0]);
  const H = Math.abs(b[1] - a[1]);
  if (!(W > 0 && H > 0)) return null;
  return { L: Math.min(a[0], b[0]), T: Math.min(a[1], b[1]), W, H };
}

interface SegG { a: Pt; b: Pt; u: [number, number]; n: [number, number] }
function segGeom(s: Shape, toView: (p: Pt) => Pt): SegG | null {
  if (!isFinitePt(s.from) || !isFinitePt(s.to)) return null;
  const a = toView(s.from);
  const b = toView(s.to);
  if (!isFinitePt(a) || !isFinitePt(b)) return null;
  const frame = unitAndUpNormal(a, b);
  if (!frame) return null;
  return { a, b, u: frame.u, n: frame.n };
}

function strokePts(s: Shape, toView: (p: Pt) => Pt): Pt[] {
  if (!Array.isArray(s.points)) return [];
  return s.points.filter(isFinitePt).slice(0, 32).map((p) => toView(p)).filter(isFinitePt);
}

/* ───────────── label placement ───────────── */

function combineLabel(labelIn: string | undefined, magnitudeIn: string | undefined): string | undefined {
  const label = labelIn?.trim();
  const magnitude = magnitudeIn?.trim();
  // Never "T = T", and never repeat a magnitude the label already states.
  if (label && magnitude && label.toLowerCase().includes(magnitude.toLowerCase())) return label;
  if (label && magnitude) return label.includes("=") ? `${label} ${magnitude}` : `${label} = ${magnitude}`;
  return label || magnitude || undefined;
}

/** Text that the placer positions. Standalone text only moves to get off another pill; graphs never move. */
function placeableText(s: Shape): string | undefined {
  switch (s.kind) {
    case "text":
      return s.label || undefined;
    case "circle":
    case "box":
    case "line":
    case "arrow":
      return s.label || undefined;
    case "vector":
      return combineLabel(s.label, s.magnitude);
    default:
      return undefined;
  }
}

function anchorForNormal(n: [number, number]): "start" | "middle" | "end" {
  return Math.abs(n[0]) > 0.5 ? (n[0] < 0 ? "end" : "start") : "middle";
}

/** Label beside point p, pushed `dist` px along unit normal n, centred vertically on the offset point. */
function sideLabel(px: number, py: number, n: [number, number], gap: number): LabelPlacement {
  const dist = gap + Math.abs(n[0]) * PILL_PAD_X + Math.abs(n[1]) * PILL_HALF_H;
  return { x: px + n[0] * dist, y: py + n[1] * dist + LABEL_MID, anchor: anchorForNormal(n) };
}

/** Ordered candidate anchors per kind. The first is the default position. */
function labelCandidates(s: Shape, toView: (p: Pt) => Pt, scale: number): LabelPlacement[] {
  switch (s.kind) {
    case "circle": {
      const g = circleGeom(s, toView, scale);
      if (!g) return [];
      const { cx, cy, R } = g;
      const k = Math.SQRT1_2;
      return [
        { x: cx + R * k + 14, y: cy - R * k - 9, anchor: "start" },  // upper-right
        { x: cx - R * k - 14, y: cy - R * k - 9, anchor: "end" },    // upper-left
        { x: cx + R + 16, y: cy + LABEL_MID, anchor: "start" },      // right
        { x: cx + R * k + 14, y: cy + R * k + 20, anchor: "start" }, // lower-right
        { x: cx - R - 16, y: cy + LABEL_MID, anchor: "end" },        // left
        { x: cx, y: cy - R - 15, anchor: "middle" },                 // top
      ];
    }
    case "box": {
      const g = rectGeom(s.rect, toView);
      if (!g) return [];
      const { L, T, W, H } = g;
      return [
        { x: L + PILL_PAD_X, y: T - 14, anchor: "start" },       // above-left
        { x: L + W - PILL_PAD_X, y: T - 14, anchor: "end" },     // above-right
        { x: L + PILL_PAD_X, y: T + H + 25, anchor: "start" },   // below-left
        { x: L + W - PILL_PAD_X, y: T + H + 25, anchor: "end" }, // below-right
      ];
    }
    case "line":
    case "arrow": {
      const g = segGeom(s, toView);
      if (!g) return [];
      const out: LabelPlacement[] = [];
      for (const t of [0.5, 1 / 3, 2 / 3]) {
        const px = g.a[0] + (g.b[0] - g.a[0]) * t;
        const py = g.a[1] + (g.b[1] - g.a[1]) * t;
        out.push(sideLabel(px, py, g.n, LABEL_OFFSET));
        out.push(sideLabel(px, py, [-g.n[0], -g.n[1]], LABEL_OFFSET));
      }
      return out;
    }
    case "vector": {
      const g = segGeom(s, toView);
      if (!g) return [];
      const [ux, uy] = g.u;
      const [bx, by] = g.b;
      return [
        {                                                    // beyond the tip
          x: bx + ux * (20 + Math.abs(ux) * PILL_PAD_X),
          y: by + uy * 20 + (uy > 0.35 ? 18 : uy < -0.35 ? -8 : LABEL_MID),
          anchor: ux > 0.35 ? "start" : ux < -0.35 ? "end" : "middle",
        },
        sideLabel(bx, by, g.n, 10),                          // either side of the tip
        sideLabel(bx, by, [-g.n[0], -g.n[1]], 10),
      ];
    }
    case "text": {
      if (!isFinitePt(s.center)) return [];
      const [x, y] = toView(s.center);
      if (!isFiniteNum(x) || !isFiniteNum(y)) return [];
      const step = PILL_HALF_H * 2 + 4;
      return [0, step, -step, step * 2, -step * 2].map((dy) => ({ x, y: y + LABEL_MID + dy, anchor: "middle" as const }));
    }
    default:
      return [];
  }
}

/** Point the label belongs to; further candidates are pushed away from it. */
function labelRef(s: Shape, toView: (p: Pt) => Pt, scale: number): Pt | null {
  switch (s.kind) {
    case "circle": {
      const g = circleGeom(s, toView, scale);
      return g ? [g.cx, g.cy] : null;
    }
    case "box": {
      const g = rectGeom(s.rect, toView);
      return g ? [g.L + g.W / 2, g.T + g.H / 2] : null;
    }
    case "line":
    case "arrow": {
      const g = segGeom(s, toView);
      return g ? [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2] : null;
    }
    case "vector": {
      const g = segGeom(s, toView);
      return g ? g.b : null;
    }
    default:
      return null;
  }
}

/** The label's glass pill, in view coordinates. Collision tests use this, not the bare text. */
function labelBox(p: LabelPlacement, text: string): Box {
  const w = textWidth(text);
  const x0 = p.anchor === "start" ? p.x : p.anchor === "end" ? p.x - w : p.x - w / 2;
  const mid = p.y - LABEL_MID;
  return { x0: x0 - PILL_PAD_X, y0: mid - PILL_HALF_H, x1: x0 + w + PILL_PAD_X, y1: mid + PILL_HALF_H };
}

/** Segments a shape occupies, in view coordinates, for label collision tests. */
function obstaclesOf(s: Shape, toView: (p: Pt) => Pt, scale: number): Seg[] {
  switch (s.kind) {
    case "circle": {
      const g = circleGeom(s, toView, scale);
      if (!g) return [];
      const ring: Pt[] = [];
      for (let i = 0; i <= 24; i++) {
        const th = (i / 24) * Math.PI * 2;
        ring.push([g.cx + g.R * Math.cos(th), g.cy + g.R * Math.sin(th)]);
      }
      return polySegs(ring);
    }
    case "box":
    case "graph":
    case "slider": {
      const g = rectGeom(s.rect, toView);
      return g ? rectSegs({ x0: g.L, y0: g.T, x1: g.L + g.W, y1: g.T + g.H }) : [];
    }
    case "line":
    case "arrow":
    case "vector": {
      const g = segGeom(s, toView);
      if (!g) return [];
      const out: Seg[] = [[g.a[0], g.a[1], g.b[0], g.b[1]]];
      if (s.kind !== "line") {
        // The arrowhead triangle, so a label pill never sits on its own (or another) arrow tip.
        const len = s.kind === "vector" ? 17 : 15, half = s.kind === "vector" ? 8 : 7;
        const bx = g.b[0] - g.u[0] * len, by = g.b[1] - g.u[1] * len;
        const lx = bx - g.u[1] * half, ly = by + g.u[0] * half;
        const rx = bx + g.u[1] * half, ry = by - g.u[0] * half;
        out.push([g.b[0], g.b[1], lx, ly], [lx, ly, rx, ry], [rx, ry, g.b[0], g.b[1]]);
      }
      return out;
    }
    case "stroke":
      return polySegs(strokePts(s, toView));
    default:
      return [];   // text shapes are pills: the placer treats them as placed boxes, not strokes
  }
}

/** 0 means clean. Otherwise a rough cost: label overlap area, stroke hits, and leaving the viewport. */
function scoreCandidate(
  box: Box,
  segs: Seg[],
  placed: Box[],
  vp: { width: number; height: number } | undefined,
  interiors: Box[] = [],
): number {
  let score = 0;
  // A label inside a box or circle hides what the shape points at and reads as belonging to it.
  for (const r of interiors) if (boxOverlapArea(box, r) > 0) score += 400;
  const grown = inflate(box, 3);
  for (const p of placed) {
    const area = boxOverlapArea(grown, p);
    if (area > 0) score += 600 + area;   // a pill on a pill is nearly as bad as a pill on a stroke
  }
  for (const s of segs) if (segHitsBox(s, grown)) score += 1000;
  if (vp && (box.x0 < 0 || box.y0 < 0 || box.x1 > vp.width || box.y1 > vp.height)) score += 1e6;
  return score;
}

function computePlacements(
  items: Item[],
  toView: (p: Pt) => Pt,
  scale: number,
  vp: { width: number; height: number } | undefined,
  cache: Map<string, LabelPlacement>,
): Map<string, LabelPlacement> {
  const segs: Seg[] = [];
  // Insides of boxes and circles. A label keeps out of them, except when its own shape sits inside
  // one (an arrow drawn within a circle keeps its label next to the arrow).
  const interiors: { id: string; box: Box; holds: (p: Pt) => boolean }[] = [];
  for (const { shape } of items) {
    segs.push(...obstaclesOf(shape, toView, scale));
    if (shape.kind === "box") {
      const g = rectGeom(shape.rect, toView);
      if (!g) continue;
      const box: Box = { x0: g.L, y0: g.T, x1: g.L + g.W, y1: g.T + g.H };
      interiors.push({ id: shape.id, box, holds: (p) => p[0] >= box.x0 && p[0] <= box.x1 && p[1] >= box.y0 && p[1] <= box.y1 });
    } else if (shape.kind === "circle") {
      const g = circleGeom(shape, toView, scale);
      if (!g) continue;
      const k = g.R * Math.SQRT1_2;
      interiors.push({
        id: shape.id,
        box: { x0: g.cx - k, y0: g.cy - k, x1: g.cx + k, y1: g.cy + k },
        holds: (p) => Math.hypot(p[0] - g.cx, p[1] - g.cy) <= g.R,
      });
    }
  }

  const out = new Map<string, LabelPlacement>();
  const placed: Box[] = [];

  // Labels already placed keep their spot; they only constrain new ones.
  for (const { shape } of items) {
    const text = placeableText(shape);
    const cached = cache.get(shape.id);
    if (!text || !cached) continue;
    out.set(shape.id, cached);
    placed.push(labelBox(cached, text));
  }

  // New labels, greedily: standalone text first (it is where the author put it), then shape labels.
  // Each label tries its own candidates, then the same ones pushed 12, 24 and 36 px further out,
  // and only then settles for the least-bad spot.
  const fresh = items.filter(({ shape }) => placeableText(shape) && !out.has(shape.id));
  fresh.sort((p, q) => Number(q.shape.kind === "text") - Number(p.shape.kind === "text"));
  for (const { shape } of fresh) {
    const text = placeableText(shape)!;
    const base = labelCandidates(shape, toView, scale);
    if (base.length === 0) continue;
    const ref = shape.kind === "text" ? null : labelRef(shape, toView, scale);
    const avoid = ref ? interiors.filter((it) => it.id === shape.id || !it.holds(ref)).map((it) => it.box) : [];
    let pick = base[0];
    let best = Infinity;
    search:
    for (const push of ref ? [0, 6, 12, 18, 24, 30, 36] : [0]) {
      for (const cand0 of base) {
        let cand = cand0;
        if (push > 0 && ref) {
          const b0 = labelBox(cand0, text);
          const dx = (b0.x0 + b0.x1) / 2 - ref[0], dy = (b0.y0 + b0.y1) / 2 - ref[1];
          const L = Math.hypot(dx, dy) || 1;
          cand = { x: cand0.x + (dx / L) * push, y: cand0.y + (dy / L) * push, anchor: cand0.anchor };
        }
        const score = scoreCandidate(labelBox(cand, text), segs, placed, vp, avoid) + push * 0.5;
        if (score === 0) { pick = cand; best = 0; break search; }
        if (score < best) { best = score; pick = cand; }
      }
    }
    out.set(shape.id, pick);
    placed.push(labelBox(pick, text));
  }

  cache.clear();
  out.forEach((p, id) => cache.set(id, p));
  return out;
}

/** Placement chosen by the collision pass, or the default candidate if none was computed. */
function placedAt(c: Ctx, s: Shape): LabelPlacement | null {
  return c.placements.get(s.id) ?? labelCandidates(s, c.toView, c.scale)[0] ?? null;
}

/* ───────────── shared pieces ───────────── */

/** A stroke that draws on (dashoffset animation) in the main variant, or fades with the group in sidenote. */
function Stroke({ d, color, width, c, dash, opacity, dy }: {
  d: string; color: string; width: number; c: Ctx; dash?: string; opacity?: number; dy?: number;
}): ReactElement {
  const transform = dy ? `translate(0 ${dy})` : undefined;
  if (c.side) {
    return (
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={dash ?? "7 5"} strokeOpacity={opacity} transform={transform} />
    );
  }
  return (
    <path d={d} pathLength={1} className="gt-draw" fill="none" stroke={color} strokeWidth={width}
      strokeLinecap="round" strokeLinejoin="round" strokeOpacity={opacity} transform={transform}
      style={{ animationDelay: `${c.delay}ms` }} />
  );
}

/**
 * A hand-drawn stroke along `poly`: soft shadow and optional halo underlays (plain offset copies,
 * never SVG or CSS filters), a pressure-style variable-width body revealed chunk by chunk, a broken
 * gloss streak for texture, and a pen tip that rides the reveal.
 */
function inkNodes(
  poly: Pt[],
  c: Ctx,
  rnd: () => number,
  o: InkOpts & { width?: number; tag?: string; delay?: number; opacity?: number; tip?: boolean } = {},
): { d: string; nodes: ReactNode[] } {
  const width = o.width ?? STROKE_W;
  const tag = o.tag ?? "ink";
  const delay = o.delay ?? c.delay;
  const cc = delay === c.delay ? c : { ...c, delay };
  if (c.side) {
    const d = polyD(poly);
    return { d, nodes: [<Stroke key={tag} d={d} color={c.style.stroke} width={width} c={cc} opacity={o.opacity} />] };
  }
  const g = inkGeom(poly, width, rnd, o);
  // Underlays trail the ink slightly, so their round caps never poke out ahead of the pen tip.
  const under = { ...c, delay: delay + 35 };
  const nodes: ReactNode[] = [
    <Stroke key={`${tag}-shadow`} d={g.d} color="rgba(0,0,0,0.15)" width={width + 1} c={under} dy={1.6} />,
  ];
  if (c.style.halo) nodes.push(<Stroke key={`${tag}-halo`} d={g.d} color={c.style.halo} width={width + 4.5} c={under} />);
  nodes.push(
    <g key={tag} fill={c.style.stroke} opacity={o.opacity}>
      <circle cx={fmt(g.caps[0].x)} cy={fmt(g.caps[0].y)} r={fmt(g.caps[0].r)} className="gt-ink"
        style={{ animationDelay: `${delay}ms` }} />
      {g.chunks.map((ch, i) => (
        <path key={i} d={ch.d} className="gt-ink" style={{ animationDelay: `${Math.round(delay + ch.t * DRAW_MS)}ms` }} />
      ))}
      <circle cx={fmt(g.caps[1].x)} cy={fmt(g.caps[1].y)} r={fmt(g.caps[1].r)} className="gt-ink"
        style={{ animationDelay: `${delay + DRAW_MS - 30}ms` }} />
    </g>,
  );
  if (g.sheen) {
    nodes.push(
      <path key={`${tag}-sheen`} d={g.sheen} fill="none" stroke="#ffffff" strokeOpacity={0.24}
        strokeWidth={fmt(Math.max(0.8, width * 0.24))} strokeLinecap="round" strokeDasharray="38 3 61 5 23 2 47 4"
        transform="translate(-0.45 -0.75)" className="gt-fade" style={{ animationDelay: `${delay + DRAW_MS}ms` }} />,
    );
  }
  if (o.tip !== false) nodes.push(<PenTip key={`${tag}-tip`} pts={g.pts} delay={delay} color={c.style.stroke} />);
  return { d: g.d, nodes };
}

/**
 * Pen tip that travels along a stroke while it draws, then lifts and fades. Driven by one Web
 * Animation (transform + opacity only), timed like the chunk reveal: linear over DRAW_MS.
 */
function PenTip({ pts, delay, color }: { pts: Pt[]; delay: number; color: string }): ReactElement | null {
  const ref = useRef<SVGGElement>(null);
  const first = useRef({ pts, delay });
  const [done, setDone] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const p = first.current.pts;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!el || typeof el.animate !== "function" || p.length < 2 || reduce) { setDone(true); return; }
    const total = DRAW_MS + TIP_LINGER_MS;
    const f = DRAW_MS / total;
    const count = Math.min(p.length, 32);
    const frames: Keyframe[] = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const q = p[Math.round(t * (p.length - 1))];
      frames.push({ transform: `translate(${fmt(q[0])}px, ${fmt(q[1])}px)`, opacity: 1, offset: t * f });
    }
    const last = p[p.length - 1];
    frames.push({ transform: `translate(${fmt(last[0] + 5)}px, ${fmt(last[1] - 8)}px)`, opacity: 0, offset: 1 });
    let anim: Animation;
    try {
      anim = el.animate(frames, { duration: total, delay: first.current.delay, fill: "both", easing: "linear" });
    } catch {
      setDone(true);
      return;
    }
    anim.onfinish = () => setDone(true);
    return () => anim.cancel();
  }, []);
  if (done) return null;
  // Drawn pointing along -x with the point at the origin, then leaned like a pen held in the right hand.
  return (
    <g ref={ref} className="gt-tip">
      <g transform="rotate(-52) scale(1.12)">
        <path d="M0 0 L9 -3.6 L30 -3.6 Q32 -3.6 32 -1.6 L32 1.6 Q32 3.6 30 3.6 L9 3.6 Z" fill="rgba(0,0,0,0.2)"
          transform="translate(2.4 2.2)" />
        <path d="M9 -3.6 L28 -3.6 L28 3.6 L9 3.6 Z" fill={color} />
        <path d="M28 -3.6 L30 -3.6 Q32 -3.6 32 -1.6 L32 1.6 Q32 3.6 30 3.6 L28 3.6 Z" fill="#2b3140" />
        <path d="M3.2 -1.3 L9 -3.6 L9 3.6 L3.2 1.3 Z" fill="#f3dfbd" />
        <path d="M0 0 L3.2 -1.3 L3.2 1.3 Z" fill={color} />
        <path d="M10 -1.7 L27 -1.7" fill="none" stroke="#ffffff" strokeOpacity={0.55} strokeWidth={1.1} strokeLinecap="round" />
        <path d="M0 0 L9 -3.6 L30 -3.6 Q32 -3.6 32 -1.6 L32 1.6 Q32 3.6 30 3.6 L9 3.6 Z" fill="none"
          stroke="rgba(10,14,24,0.55)" strokeWidth={0.7} strokeLinejoin="round" />
      </g>
    </g>
  );
}

/** Arrowhead (or any filled glyph) that fades in after its stroke. */
function headNodes(d: string, c: Ctx, tag: string): ReactNode[] {
  const delay = c.delay + DRAW_MS - 40;
  const cls = c.side ? undefined : "gt-rise";
  const out: ReactNode[] = [];
  if (c.style.halo) {
    out.push(
      <path key={`${tag}-halo`} d={d} fill={c.style.halo} stroke={c.style.halo} strokeWidth={4.5}
        strokeLinejoin="round" className={cls} style={{ animationDelay: `${delay}ms` }} />,
    );
  }
  out.push(
    <path key={tag} d={d} fill={c.style.stroke} stroke={c.style.stroke} strokeWidth={1.4}
      strokeLinejoin="round" className={cls} style={{ animationDelay: `${delay}ms` }} />,
  );
  return out;
}

function labelStyle(c: Ctx): { fill: string; stroke: string } {
  return { fill: c.style.stroke, stroke: c.style.labelHalo ?? "none" };
}

function pillOf(c: Ctx): PillStyle | null {
  if (c.style.pill === false) return null;
  return c.style.pill ?? pillFor(c.style.stroke);
}

/**
 * Text label on a small glass pill: gradient body, hairline edge in the ink colour, a specular line
 * along the top and an offset shadow copy. Fades in after the stroke, unless it is a sidenote
 * (the group handles entrance). `size` is the font size; the pill scales with it.
 */
function labelEl(
  key: string,
  text: string | undefined,
  x: number,
  y: number,
  anchor: "start" | "middle" | "end",
  c: Ctx,
  className = "gt-label",
  delay: number = c.delay + DRAW_MS,
  size = 16,
): ReactNode {
  if (!text || !isFiniteNum(x) || !isFiniteNum(y)) return null;
  const pill = pillOf(c);
  if (!pill) {
    return (
      <text key={key} x={fmt(x)} y={fmt(y)} textAnchor={anchor}
        className={c.side ? className : `${className} gt-rise`}
        style={{ ...labelStyle(c), animationDelay: `${delay}ms` }}>
        {text}
      </text>
    );
  }
  const k = size / 16;
  const w = textWidth(text, size, size === 16 ? 700 : 600);
  const tx = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  const padX = PILL_PAD_X * (0.5 + 0.5 * k);
  const hh = PILL_HALF_H * (0.35 + 0.65 * k);
  const px = tx - padX, py = y - LABEL_MID * k - hh, pw = w + padX * 2, ph = hh * 2;
  return (
    <g key={key} className={c.side ? undefined : "gt-rise"} style={{ animationDelay: `${delay}ms` }}>
      <rect x={fmt(px - 0.5)} y={fmt(py + 1.6)} width={fmt(pw + 1)} height={fmt(ph + 0.6)} rx={fmt(hh + 0.3)}
        fill={pill.shadow} />
      <rect x={fmt(px)} y={fmt(py)} width={fmt(pw)} height={fmt(ph)} rx={fmt(hh)}
        fill={`url(#gt-pill-${pill.tone})`} stroke={c.style.stroke} strokeOpacity={0.34} strokeWidth={0.8} />
      <path d={`M${fmt(px + hh * 0.8)} ${fmt(py + 1.3)} L${fmt(px + pw - hh * 0.8)} ${fmt(py + 1.3)}`} fill="none"
        stroke={pill.shine} strokeWidth={1} strokeLinecap="round" />
      <text x={fmt(tx + w / 2)} y={fmt(y)} textAnchor="middle" className={className}
        style={{ fill: c.style.stroke, stroke: "none" }}>
        {text}
      </text>
    </g>
  );
}

/* ───────────── kinds ───────────── */

function buildCircle(s: Shape, c: Ctx): Built | null {
  const g = circleGeom(s, c.toView, c.scale);
  if (!g) return null;
  const rnd = seedOf(s.id);
  const ink = inkNodes(handCircle(g.cx, g.cy, g.R, rnd), c, rnd, { loop: true });
  const lp = placedAt(c, s);
  return {
    main: ink.d,
    nodes: [
      ...ink.nodes,
      lp ? labelEl("label", s.label, lp.x, lp.y, lp.anchor, c) : null,
    ],
  };
}

function buildBox(s: Shape, c: Ctx): Built | null {
  const g = rectGeom(s.rect, c.toView);
  if (!g) return null;
  const rnd = seedOf(s.id);
  const ink = inkNodes(handBox(g.L, g.T, g.W, g.H, rnd), c, rnd, { loop: true });
  const lp = placedAt(c, s);
  return {
    main: ink.d,
    nodes: [
      ...ink.nodes,
      lp ? labelEl("label", s.label, lp.x, lp.y, lp.anchor, c) : null,
    ],
  };
}

/** line, arrow and vector share geometry; they differ in head, width, label and components. */
function buildSegment(s: Shape, c: Ctx, kind: "line" | "arrow" | "vector"): Built | null {
  const g = segGeom(s, c.toView);
  if (!g) return null;
  const { a, b } = g;

  const isVector = kind === "vector";
  const width = isVector ? 4.4 : STROKE_W;
  const rnd = seedOf(s.id);
  const head = kind === "line" ? null : arrowHead(a, b, isVector ? 17 : 15, isVector ? 14 : 12);
  const ink = inkNodes(handLine(a, head ? head.shaftEnd : b, rnd), c, rnd, { width, taperEnd: !head });
  const d = ink.d;

  const nodes: ReactNode[] = ink.nodes;
  if (head) nodes.push(...headNodes(handHead(b, g.u, isVector ? 17 : 15, isVector ? 14 : 12, rnd), c, "head"));

  const lp = placedAt(c, s);
  if (isVector) {
    nodes.push(lp ? labelEl("label", combineLabel(s.label, s.magnitude), lp.x, lp.y, lp.anchor, c) : null);
    if (s.components && isFiniteNum(s.to?.[0]) && isFiniteNum(s.from?.[1])) {
      const corner = c.toView([s.to![0], s.from![1]]);
      if (isFinitePt(corner)) {
        const legDelay = c.delay + DRAW_MS;
        const cls = c.side ? undefined : "gt-rise";
        nodes.push(
          <path key="legX" d={linePath(a, corner)} fill="none" stroke={c.style.stroke} strokeWidth={1.5}
            strokeDasharray="5 4" strokeOpacity={0.6} className={cls} style={{ animationDelay: `${legDelay}ms` }} />,
          <path key="legY" d={linePath(corner, b)} fill="none" stroke={c.style.stroke} strokeWidth={1.5}
            strokeDasharray="5 4" strokeOpacity={0.6} className={cls} style={{ animationDelay: `${legDelay}ms` }} />,
        );
      }
    }
  } else {
    nodes.push(lp ? labelEl("label", s.label, lp.x, lp.y, lp.anchor, c) : null);
  }
  return { main: d, nodes };
}

function buildStroke(s: Shape, c: Ctx): Built | null {
  const pts = strokePts(s, c.toView);
  if (pts.length < 2) return null;
  const rnd = seedOf(s.id);
  const ink = inkNodes(curvePts(pts), c, rnd);
  return { main: ink.d, nodes: ink.nodes };
}

function buildText(s: Shape, c: Ctx): Built | null {
  if (!isFinitePt(s.center) || !s.label) return null;
  const [x, y] = c.toView(s.center);
  if (!isFiniteNum(x) || !isFiniteNum(y)) return null;
  const lp = c.placements.get(s.id) ?? { x, y: y + LABEL_MID, anchor: "middle" as const };
  return { nodes: [labelEl("text", s.label, lp.x, lp.y, lp.anchor, c, "gt-label", c.delay)] };
}

function buildGraph(s: Shape, c: Ctx): Built | null {
  if (!s.graph) return null;
  const g = s.graph;
  if (![g.x_min, g.x_max, g.y_min, g.y_max].every(isFiniteNum)) return null;
  if (g.x_max <= g.x_min || g.y_max <= g.y_min || !Array.isArray(g.series)) return null;
  const rg = rectGeom(s.rect, c.toView);
  if (!rg) return null;
  const { L, T, W, H } = rg;

  const plot = { left: L + 46, right: L + W - 18, top: T + 16, bottom: T + H - 40 };
  if (!(plot.right > plot.left && plot.bottom > plot.top)) return null;
  const { X, Y } = graphMapper(g, plot);
  const { left: pl, right: pr, top: pt, bottom: pb } = plot;

  const cls = c.side ? undefined : "gt-rise";
  const chromeDelay = c.delay + DRAW_MS;
  const nodes: ReactNode[] = [];

  // Panel
  nodes.push(
    <rect key="panel" x={fmt(L)} y={fmt(T)} width={fmt(W)} height={fmt(H)} rx={10}
      fill={c.style.fill ?? "none"} stroke={c.style.stroke} strokeOpacity={0.25} strokeWidth={1}
      className={cls} style={{ animationDelay: `${c.delay}ms` }} />,
  );

  // Axes with arrow tips
  nodes.push(
    <Stroke key="xaxis" d={linePath([pl, pb], [pr, pb])} color={c.style.stroke} width={1.75} c={c} />,
    <Stroke key="yaxis" d={linePath([pl, pb], [pl, pt])} color={c.style.stroke} width={1.75} c={c} />,
  );
  const xHead = arrowHead([pl, pb], [pr, pb], 9, 8);
  const yHead = arrowHead([pl, pb], [pl, pt], 9, 8);
  if (xHead) nodes.push(...headNodes(xHead.d, c, "xhead"));
  if (yHead) nodes.push(...headNodes(yHead.d, c, "yhead"));

  // Ticks
  for (let i = 1; i <= 4; i++) {
    const tx = pl + (i / 5) * (pr - pl);
    const ty = pb - (i / 5) * (pb - pt);
    nodes.push(
      <path key={`tx${i}`} d={linePath([tx, pb], [tx, pb - 5])} fill="none" stroke={c.style.stroke}
        strokeWidth={1.25} strokeLinecap="round" strokeOpacity={0.5} className={cls}
        style={{ animationDelay: `${chromeDelay}ms` }} />,
      <path key={`ty${i}`} d={linePath([pl, ty], [pl + 5, ty])} fill="none" stroke={c.style.stroke}
        strokeWidth={1.25} strokeLinecap="round" strokeOpacity={0.5} className={cls}
        style={{ animationDelay: `${chromeDelay}ms` }} />,
    );
  }

  // Axis labels
  // Axis titles sit on the graph's own panel, so they need no pill.
  const bare: Ctx = { ...c, style: { ...c.style, pill: false } };
  nodes.push(labelEl("xlabel", g.x_label, (pl + pr) / 2, pb + 28, "middle", bare, "gt-label gt-label-sm"));
  if (g.y_label) {
    const yx = L + 14;
    const yy = (pt + pb) / 2;
    nodes.push(
      <g key="ylabel" className={cls} style={{ animationDelay: `${chromeDelay}ms` }}>
        <text x={fmt(yx)} y={fmt(yy)} textAnchor="middle" transform={`rotate(-90 ${fmt(yx)} ${fmt(yy)})`}
          className="gt-label gt-label-sm" style={labelStyle(c)}>
          {g.y_label}
        </text>
      </g>,
    );
  }

  // Series
  const base = c.delay + 200;
  g.series.forEach((ser, j) => {
    if (!Array.isArray(ser.points)) return;
    const pts = ser.points
      .filter(isFinitePt)
      .map(([px, py]) => [X(px), Y(py)] as Pt)
      .filter(isFinitePt);
    if (pts.length === 0) return;
    const opacity = j === 0 ? 1 : 0.55;
    if (ser.style === "points") {
      pts.forEach((p, k) => {
        nodes.push(
          <circle key={`s${j}p${k}`} cx={fmt(p[0])} cy={fmt(p[1])} r={3.5} fill={c.style.stroke}
            fillOpacity={opacity} className={c.side ? undefined : "gt-pop"}
            style={c.side ? undefined : { animationDelay: `${base + k * 40}ms` }} />,
        );
      });
    } else if (pts.length >= 2) {
      nodes.push(
        ...inkNodes(curvePts(pts), c, seedOf(`${s.id}/s${j}`), { width: 3.2, tag: `s${j}`, delay: base, opacity }).nodes,
      );
    }
    if (ser.label) {
      // Beside the curve a little past half way, on its upper side (alternating for later series),
      // kept inside the panel. Away from the axes, their arrow tips and the end of the curve.
      const k = Math.min(pts.length - 1, Math.max(0, Math.round((pts.length - 1) * 0.55)));
      const p = pts[k];
      const frame = pts.length >= 2
        ? unitAndUpNormal(pts[Math.max(0, k - 1)], pts[Math.min(pts.length - 1, k + 1)])
        : null;
      const up: [number, number] = frame ? frame.n : [0, -1];
      const n: [number, number] = j % 2 === 0 ? up : [-up[0], -up[1]];
      const lp = sideLabel(p[0], p[1], n, 14);
      const w = textWidth(ser.label, 13, 600) + PILL_PAD_X * 2;
      const x0 = lp.anchor === "start" ? lp.x : lp.anchor === "end" ? lp.x - w : lp.x - w / 2;
      const shift = Math.max(L + 6 - x0, Math.min(0, L + W - 6 - (x0 + w)));
      const ly = Math.min(pb - 14, Math.max(T + 18, lp.y));
      nodes.push(
        labelEl(`slabel${j}`, ser.label, lp.x + shift, ly, lp.anchor, c,
          "gt-label gt-label-series", base + DRAW_MS, 13),
      );
    }
  });

  return { nodes };
}

function buildSlider(s: Shape, c: Ctx): Built | null {
  const spec = s.slider;
  if (!spec) return null;
  if (![spec.min, spec.max, spec.value, spec.step].every(isFiniteNum) || spec.step <= 0) return null;
  const g = rectGeom(s.rect, c.toView);
  if (!g) return null;
  return {
    nodes: [
      <SliderNode key="slider" label={spec.label} min={spec.min} max={spec.max} step={spec.step}
        initial={spec.value} unit={spec.unit} x={g.L} y={g.T} w={g.W} h={g.H} color={c.style.stroke}
        delay={c.delay + DRAW_MS} side={c.side} />,
    ],
  };
}

function SliderNode(p: {
  label: string; min: number; max: number; step: number; initial: number; unit: string;
  x: number; y: number; w: number; h: number; color: string; delay: number; side: boolean;
}): ReactElement {
  const [value, setValue] = useState<number>(p.initial);
  const decimals = p.step < 1 ? (String(p.step).split(".")[1] ?? "").length : 0;
  return (
    <foreignObject x={fmt(p.x)} y={fmt(p.y)} width={fmt(p.w)} height={fmt(p.h)}
      className={p.side ? undefined : "gt-rise"} style={{ animationDelay: `${p.delay}ms`, overflow: "visible" }}>
      <div className="gt-slider" style={{ accentColor: p.color }}>
        <div className="gt-slider-head">
          <span>{p.label}</span>
          <span className="gt-slider-value">{`${value.toFixed(decimals)}${p.unit ? ` ${p.unit}` : ""}`}</span>
        </div>
        <input
          type="range"
          className="gt-range"
          min={p.min}
          max={p.max}
          step={p.step}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          style={{ accentColor: p.color }}
        />
      </div>
    </foreignObject>
  );
}
