import { useId, useState, type ReactElement, type ReactNode } from "react";
import type { Pt, Shape } from "@shared/contracts";
import { labelHaloFor, type ShapeStyle } from "./palette";
import {
  arrowHead,
  circlePath,
  fmt,
  graphMapper,
  isFiniteNum,
  isFinitePt,
  isRect,
  linePath,
  roundedRectPath,
  smoothPath,
  unitAndUpNormal,
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
}

const STEP_MS = 120;   // stagger between shapes that appear together
const DRAW_MS = 260;   // stroke-draw duration
const STROKE_W = 3;
const LABEL_OFFSET = 14;

/** Per-shape rendering context. `delay` is the stroke start time in ms. */
interface Ctx {
  toView: (p: Pt) => Pt;
  scale: number;
  style: ShapeStyle;
  side: boolean;
  delay: number;
  labelStroke: string;
}

interface Built {
  main?: string;      // primary path, used for the pulse glow
  nodes: ReactNode[];
}

export function ShapeLayer(props: ShapeLayerProps): ReactElement {
  const { shapes, visibleSegmentIds, pulseShapeIds, variant = "main", toView, scale, styleFor, opacity = 1 } = props;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const side = variant === "sidenote";
  const visibleSet = new Set(visibleSegmentIds);
  const pulseSet = new Set(pulseShapeIds ?? []);

  // Only shapes in visible segments mount. Index within the segment drives the stagger.
  const counters = new Map<string, number>();
  const items: { shape: Shape; index: number }[] = [];
  for (const shape of shapes) {
    if (!visibleSet.has(shape.segment_id)) continue;
    const index = counters.get(shape.segment_id) ?? 0;
    counters.set(shape.segment_id, index + 1);
    items.push({ shape, index });
  }

  return (
    <g className={side ? "gt-root gt-sidenote" : "gt-root"} style={{ opacity }}>
      <defs>
        <filter id={`gt-shadow-${uid}`} x="-15%" y="-15%" width="130%" height="140%">
          <feDropShadow dx={0} dy={1} stdDeviation={1.2} floodColor="#000000" floodOpacity={0.25} />
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
}

function ShapeNode({ shape, index, toView, scale, style, side, uid, pulsing }: ShapeNodeProps): ReactElement | null {
  const ctx: Ctx = {
    toView,
    scale,
    style,
    side,
    delay: index * STEP_MS,
    labelStroke: labelHaloFor(style.stroke),
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
      filter={`url(#gt-shadow-${uid})`}
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

function combineLabel(label: string | undefined, magnitude: string | undefined): string | undefined {
  if (label && magnitude) return label.includes("=") ? `${label} ${magnitude}` : `${label} = ${magnitude}`;
  return label || magnitude || undefined;
}

/* ───────────── kinds ───────────── */

function buildCircle(s: Shape, c: Ctx): Built | null {
  if (!isFinitePt(s.center) || !isFiniteNum(s.radius) || s.radius <= 0) return null;
  const [cx, cy] = c.toView(s.center);
  const R = s.radius * c.scale;
  if (!isFiniteNum(cx) || !isFiniteNum(cy) || !isFiniteNum(R) || R <= 0) return null;
  const d = circlePath(cx, cy, R);
  const k = Math.SQRT1_2;
  return {
    main: d,
    nodes: [
      ...strokeNodes(d, c),
      labelEl("label", s.label, cx + R * k + 6, cy - R * k - 4, "start", c),
    ],
  };
}

function buildBox(s: Shape, c: Ctx): Built | null {
  if (!isRect(s.rect)) return null;
  const [x, y, w, h] = s.rect;
  const a = c.toView([x, y]);
  const b = c.toView([x + w, y + h]);
  if (!isFinitePt(a) || !isFinitePt(b)) return null;
  const L = Math.min(a[0], b[0]);
  const T = Math.min(a[1], b[1]);
  const W = Math.abs(b[0] - a[0]);
  const H = Math.abs(b[1] - a[1]);
  if (!(W > 0 && H > 0)) return null;
  const d = roundedRectPath(L, T, W, H, 6);
  return {
    main: d,
    nodes: [...strokeNodes(d, c), labelEl("label", s.label, L, T - 8, "start", c)],
  };
}

/** line, arrow and vector share geometry; they differ in head, width, label and components. */
function buildSegment(s: Shape, c: Ctx, kind: "line" | "arrow" | "vector"): Built | null {
  if (!isFinitePt(s.from) || !isFinitePt(s.to)) return null;
  const a = c.toView(s.from);
  const b = c.toView(s.to);
  if (!isFinitePt(a) || !isFinitePt(b)) return null;
  const frame = unitAndUpNormal(a, b);
  if (!frame) return null;

  const isVector = kind === "vector";
  const width = isVector ? 3.5 : STROKE_W;
  const head = kind === "line" ? null : arrowHead(a, b, isVector ? 14 : 12, isVector ? 11 : 10);
  const d = linePath(a, head ? head.shaftEnd : b);

  const nodes: ReactNode[] = strokeNodes(d, c, width);
  if (head) nodes.push(...headNodes(head.d, c, "head"));

  if (isVector) {
    const text = combineLabel(s.label, s.magnitude);
    const [ux, uy] = frame.u;
    const tx = b[0] + ux * 16;
    const ty = b[1] + uy * 16 + (uy > 0.35 ? 14 : uy < -0.35 ? -6 : 5);
    const anchor = ux > 0.35 ? "start" : ux < -0.35 ? "end" : "middle";
    nodes.push(labelEl("label", text, tx, ty, anchor, c));
    if (s.components) {
      const corner = c.toView([s.to[0], s.from[1]]);
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
    const mx = (a[0] + b[0]) / 2 + frame.n[0] * LABEL_OFFSET;
    const my = (a[1] + b[1]) / 2 + frame.n[1] * LABEL_OFFSET;
    const anchor = Math.abs(frame.n[0]) > 0.5 ? (frame.n[0] < 0 ? "end" : "start") : "middle";
    nodes.push(labelEl("label", s.label, mx, my + 5, anchor, c));
  }
  return { main: d, nodes };
}

function buildStroke(s: Shape, c: Ctx): Built | null {
  if (!Array.isArray(s.points)) return null;
  const pts = s.points.filter(isFinitePt).slice(0, 32).map((p) => c.toView(p)).filter(isFinitePt);
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
  if (!isRect(s.rect) || !s.graph) return null;
  const g = s.graph;
  if (![g.x_min, g.x_max, g.y_min, g.y_max].every(isFiniteNum)) return null;
  if (g.x_max <= g.x_min || g.y_max <= g.y_min || !Array.isArray(g.series)) return null;

  const [x, y, w, h] = s.rect;
  const a = c.toView([x, y]);
  const b = c.toView([x + w, y + h]);
  if (!isFinitePt(a) || !isFinitePt(b)) return null;
  const L = Math.min(a[0], b[0]);
  const T = Math.min(a[1], b[1]);
  const W = Math.abs(b[0] - a[0]);
  const H = Math.abs(b[1] - a[1]);
  if (!(W > 0 && H > 0)) return null;

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
  if (!isRect(s.rect) || !spec) return null;
  if (![spec.min, spec.max, spec.value, spec.step].every(isFiniteNum) || spec.step <= 0) return null;
  const [x, y, w, h] = s.rect;
  const a = c.toView([x, y]);
  const b = c.toView([x + w, y + h]);
  if (!isFinitePt(a) || !isFinitePt(b)) return null;
  const L = Math.min(a[0], b[0]);
  const T = Math.min(a[1], b[1]);
  const W = Math.abs(b[0] - a[0]);
  const H = Math.abs(b[1] - a[1]);
  if (!(W > 0 && H > 0)) return null;
  return {
    nodes: [
      <SliderNode key="slider" label={spec.label} min={spec.min} max={spec.max} step={spec.step}
        initial={spec.value} unit={spec.unit} x={L} y={T} w={W} h={H} color={c.style.stroke}
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
