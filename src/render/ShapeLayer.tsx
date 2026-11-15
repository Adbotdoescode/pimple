import { useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Pt, Shape } from "@shared/contracts";
import { labelHaloFor, type ShapeStyle } from "./palette";
import {
  arrowHead,
  boxOverlapArea,
  circlePath,
  fmt,
  graphMapper,
  inflate,
  isFiniteNum,
  isFinitePt,
  isRect,
  linePath,
  polySegs,
  rectSegs,
  roundedRectPath,
  segHitsBox,
  smoothPath,
  unitAndUpNormal,
  type Box,
  type Seg,
} from "./geometry";
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
const DRAW_MS = 260;   // stroke-draw duration
const STROKE_W = 3.5;
const LABEL_OFFSET = 14;
const CHAR_W = 9.2;      // estimated advance per character at 16 px / 700
const LABEL_ASCENT = 15;
const LABEL_H = 20;

interface LabelPlacement { x: number; y: number; anchor: "start" | "middle" | "end" }

/** Per-shape rendering context. `delay` is the stroke start time in ms. */
interface Ctx {
  toView: (p: Pt) => Pt;
  scale: number;
  style: ShapeStyle;
  side: boolean;
  delay: number;
  labelStroke: string;
  placements: Map<string, LabelPlacement>;
}

interface Built {
  main?: string;      // primary path, used for the pulse glow
  nodes: ReactNode[];
}

interface Item { shape: Shape; index: number }

export function ShapeLayer(props: ShapeLayerProps): ReactElement {
  const { shapes, visibleSegmentIds, pulseShapeIds, variant = "main", toView, scale, styleFor, opacity = 1, viewport } = props;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
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
        <filter id={`gt-shadow-${uid}`} x="-15%" y="-15%" width="130%" height="140%">
          <feDropShadow dx={0} dy={1.5} stdDeviation={1.6} floodColor="#000000" floodOpacity={0.28} />
        </filter>
        <filter id={`gt-blur-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={2.5} />
        </filter>
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
          uid={uid}
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
  uid: string;
  pulsing: boolean;
  placements: Map<string, LabelPlacement>;
}

function ShapeNode({ shape, index, toView, scale, style, side, uid, pulsing, placements }: ShapeNodeProps): ReactElement | null {
  const ctx: Ctx = {
    toView,
    scale,
    style,
    side,
    delay: index * STEP_MS,
    labelStroke: labelHaloFor(style.stroke),
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
      strokeWidth={6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="gt-glow"
      filter={`url(#gt-blur-${uid})`}
    />
  ) : null;
  return (
    <g
      className={side ? "gt-side-shape" : undefined}
      style={side ? { animationDelay: `${ctx.delay}ms` } : undefined}
      filter={side ? undefined : `url(#gt-shadow-${uid})`}
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

function combineLabel(label: string | undefined, magnitude: string | undefined): string | undefined {
  if (label && magnitude) return label.includes("=") ? `${label} ${magnitude}` : `${label} = ${magnitude}`;
  return label || magnitude || undefined;
}

/** Text that the placer moves. Text shapes and graphs never move. */
function placeableText(s: Shape): string | undefined {
  switch (s.kind) {
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
function sideLabel(px: number, py: number, n: [number, number], dist: number): LabelPlacement {
  return { x: px + n[0] * dist, y: py + n[1] * dist + 5, anchor: anchorForNormal(n) };
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
        { x: cx + R * k + 6, y: cy - R * k - 4, anchor: "start" },   // upper-right
        { x: cx - R * k - 6, y: cy - R * k - 4, anchor: "end" },     // upper-left
        { x: cx + R + 6, y: cy + 5, anchor: "start" },               // right
        { x: cx + R * k + 6, y: cy + R * k + 16, anchor: "start" },  // lower-right
        { x: cx - R - 6, y: cy + 5, anchor: "end" },                 // left
        { x: cx, y: cy - R - 8, anchor: "middle" },                  // top
      ];
    }
    case "box": {
      const g = rectGeom(s.rect, toView);
      if (!g) return [];
      const { L, T, W, H } = g;
      return [
        { x: L, y: T - 8, anchor: "start" },                 // above-left
        { x: L + W, y: T - 8, anchor: "end" },               // above-right
        { x: L, y: T + H + 16, anchor: "start" },            // below-left
        { x: L + W, y: T + H + 16, anchor: "end" },          // below-right
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
          x: bx + ux * 26,
          y: by + uy * 26 + (uy > 0.35 ? 14 : uy < -0.35 ? -6 : 5),
          anchor: ux > 0.35 ? "start" : ux < -0.35 ? "end" : "middle",
        },
        sideLabel(bx, by, g.n, 18),                          // either side of the tip
        sideLabel(bx, by, [-g.n[0], -g.n[1]], 18),
      ];
    }
    default:
      return [];
  }
}

function labelBox(p: LabelPlacement, text: string): Box {
  const w = text.length * CHAR_W;
  const x0 = p.anchor === "start" ? p.x : p.anchor === "end" ? p.x - w : p.x - w / 2;
  const y0 = p.y - LABEL_ASCENT;
  return { x0, y0, x1: x0 + w, y1: y0 + LABEL_H };
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
      return g ? [[g.a[0], g.a[1], g.b[0], g.b[1]]] : [];
    }
    case "stroke":
      return polySegs(strokePts(s, toView));
    case "text": {
      if (!s.label || !isFinitePt(s.center)) return [];
      const [x, y] = toView(s.center);
      if (!isFiniteNum(x) || !isFiniteNum(y)) return [];
      return rectSegs(labelBox({ x, y: y + 5, anchor: "middle" }, s.label));
    }
    default:
      return [];
  }
}

/** 0 means clean. Otherwise a rough cost: label overlap area, stroke hits, and leaving the viewport. */
function scoreCandidate(box: Box, segs: Seg[], placed: Box[], vp: { width: number; height: number } | undefined): number {
  let score = 0;
  for (const p of placed) score += boxOverlapArea(box, p);
  const grown = inflate(box, 3);
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
  for (const { shape } of items) segs.push(...obstaclesOf(shape, toView, scale));

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

  // New labels, greedily in shape order.
  for (const { shape } of items) {
    const text = placeableText(shape);
    if (!text || out.has(shape.id)) continue;
    const cands = labelCandidates(shape, toView, scale);
    if (cands.length === 0) continue;
    let pick = cands[0];
    let best = Infinity;
    for (const cand of cands) {
      const score = scoreCandidate(labelBox(cand, text), segs, placed, vp);
      if (score === 0) { pick = cand; break; }
      if (score < best) { best = score; pick = cand; }
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
function Stroke({ d, color, width, c, dash, opacity }: {
  d: string; color: string; width: number; c: Ctx; dash?: string; opacity?: number;
}): ReactElement {
  if (c.side) {
    return (
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={dash ?? "7 5"} strokeOpacity={opacity} />
    );
  }
  return (
    <path d={d} pathLength={1} className="gt-draw" fill="none" stroke={color} strokeWidth={width}
      strokeLinecap="round" strokeLinejoin="round" strokeOpacity={opacity}
      style={{ animationDelay: `${c.delay}ms` }} />
  );
}

/** Main stroke with an optional halo underlay (same path, 2 px per side wider). */
function strokeNodes(d: string, c: Ctx, width = STROKE_W): ReactNode[] {
  const out: ReactNode[] = [];
  if (c.style.halo) out.push(<Stroke key="halo" d={d} color={c.style.halo} width={width + 4} c={c} />);
  out.push(<Stroke key="main" d={d} color={c.style.stroke} width={width} c={c} />);
  return out;
}

/** Arrowhead (or any filled glyph) that fades in after its stroke. */
function headNodes(d: string, c: Ctx, tag: string): ReactNode[] {
  const delay = c.delay + DRAW_MS;
  const cls = c.side ? undefined : "gt-rise";
  const out: ReactNode[] = [];
  if (c.style.halo) {
    out.push(
      <path key={`${tag}-halo`} d={d} fill={c.style.halo} stroke={c.style.halo} strokeWidth={4}
        strokeLinejoin="round" className={cls} style={{ animationDelay: `${delay}ms` }} />,
    );
  }
  out.push(
    <path key={tag} d={d} fill={c.style.stroke} stroke={c.style.stroke} strokeWidth={1}
      strokeLinejoin="round" className={cls} style={{ animationDelay: `${delay}ms` }} />,
  );
  return out;
}

function labelStyle(c: Ctx): { fill: string; stroke: string } {
  return { fill: c.style.stroke, stroke: c.labelStroke };
}

/** Text label. Fades in after the stroke, unless it is a sidenote (the group handles entrance). */
function labelEl(
  key: string,
  text: string | undefined,
  x: number,
  y: number,
  anchor: "start" | "middle" | "end",
  c: Ctx,
  className = "gt-label",
  delay: number = c.delay + DRAW_MS,
): ReactNode {
  if (!text || !isFiniteNum(x) || !isFiniteNum(y)) return null;
  return (
    <text
      key={key}
      x={fmt(x)}
      y={fmt(y)}
      textAnchor={anchor}
      className={c.side ? className : `${className} gt-rise`}
      style={{ ...labelStyle(c), animationDelay: `${delay}ms` }}
    >
      {text}
    </text>
  );
}

/* ───────────── kinds ───────────── */

function buildCircle(s: Shape, c: Ctx): Built | null {
  const g = circleGeom(s, c.toView, c.scale);
  if (!g) return null;
  const d = circlePath(g.cx, g.cy, g.R);
  const lp = placedAt(c, s);
  return {
    main: d,
    nodes: [
      ...strokeNodes(d, c),
      lp ? labelEl("label", s.label, lp.x, lp.y, lp.anchor, c) : null,
    ],
  };
}

function buildBox(s: Shape, c: Ctx): Built | null {
  const g = rectGeom(s.rect, c.toView);
  if (!g) return null;
  const d = roundedRectPath(g.L, g.T, g.W, g.H, 6);
  const lp = placedAt(c, s);
  return {
    main: d,
    nodes: [
      ...strokeNodes(d, c),
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
  const width = isVector ? 4 : STROKE_W;
  const head = kind === "line" ? null : arrowHead(a, b, 15, 12);
  const d = linePath(a, head ? head.shaftEnd : b);

  const nodes: ReactNode[] = strokeNodes(d, c, width);
  if (head) nodes.push(...headNodes(head.d, c, "head"));

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
  const d = smoothPath(pts);
  return { main: d, nodes: strokeNodes(d, c) };
}

function buildText(s: Shape, c: Ctx): Built | null {
  if (!isFinitePt(s.center) || !s.label) return null;
  const [x, y] = c.toView(s.center);
  if (!isFiniteNum(x) || !isFiniteNum(y)) return null;
  return {
    nodes: [
      <text
        key="text"
        x={fmt(x)}
        y={fmt(y)}
        dy="0.35em"
        textAnchor="middle"
        className={c.side ? "gt-label" : "gt-label gt-rise"}
        style={{ ...labelStyle(c), animationDelay: `${c.delay}ms` }}
      >
        {s.label}
      </text>,
    ],
  };
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
  nodes.push(labelEl("xlabel", g.x_label, (pl + pr) / 2, pb + 28, "middle", c, "gt-label gt-label-sm"));
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
        <Stroke key={`s${j}`} d={smoothPath(pts)} color={c.style.stroke} width={3} c={{ ...c, delay: base }}
          opacity={opacity} />,
      );
    }
    if (ser.label) {
      const last = pts[pts.length - 1];
      const nearRight = last[0] > pr - 80;
      const lx = nearRight ? last[0] - 8 : last[0] + 8;
      const ly = Math.max(pt + 12, last[1] - 8);
      nodes.push(
        labelEl(`slabel${j}`, ser.label, lx, ly, nearRight ? "end" : "start", c,
          "gt-label gt-label-series", base + DRAW_MS),
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
