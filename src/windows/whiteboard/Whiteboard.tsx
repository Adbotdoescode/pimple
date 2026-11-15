import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  GraphSpec,
  Phase,
  Pt,
  Segment,
  SessionSnapshot,
  Shape,
  SliderSpec,
  TutorResponse,
} from "@shared/contracts";
import { ShapeLayer } from "@/render/ShapeLayer";
import { boardStyle } from "@/render/palette";
import { graphMapper } from "@/render/geometry";
import { VIEW_SCALE, composeBoard, contentBox, type Box } from "./layout";
import "./whiteboard.css";

export interface WhiteboardProps {
  response: TutorResponse | null;
  /** Retained drawing shown dimmed while a new answer is pending (no caption text except "Thinking…"). */
  pending?: boolean;
  visibleSegmentIds: string[];
  currentSegmentId: string | null;
  pulseShapeIds: string[];
  sideNote: { segments: Segment[]; shapes: Shape[] } | null;
  theme: "light" | "dark";
  caption: string;
  phase: Phase;
  sourceLabel?: string | null;
  onToggleTheme?: () => void;
  onClose?: () => void;
  /** The window is a frameless transparent sheet over native blur (else an ordinary titled window). */
  frameless?: boolean;
  /** Bumped each time the sheet should spring open again. */
  openSeq?: number;
  /** Play the exit; the caller hides the window afterwards. */
  closing?: boolean;
  /** Where the spring starts from (the bubble's side), as CSS lengths in window px. */
  origin?: { x: string; y: string } | null;
}

/**
 * Segments whose shapes should be drawn now: everything once the answer has finished,
 * otherwise what has been spoken so far (plus the segment being spoken).
 */
export function visibleSegmentsFor(snapshot: SessionSnapshot): string[] {
  const { response } = snapshot;
  if (!response) return [];
  if (snapshot.phase === "idle" || snapshot.phase === "checking") {
    return response.segments.map((seg) => seg.id);
  }
  const ids = new Set(snapshot.spokenSegmentIds);
  if (snapshot.currentSegmentId) ids.add(snapshot.currentSegmentId);
  return [...ids];
}

const GRID = 40;
const SLIDER_MIN_W = 200;
/** Crossfade length when one board is swapped for another. */
const BOARD_FADE_MS = 260;
/** View px per board unit: the layer is always drawn at this scale and the camera does the rest. */
const V = VIEW_SCALE;
// Camera limits. At zoom 1 a label is 16 px; below Z_MIN it would stop being readable.
const Z_MIN = 0.74;
const Z_MAX = 1.7;
// Sheet px kept clear around the framed drawing for the floating title and caption.
const INSET = { top: 78, bottom: 108, side: 46 };
// The camera never frames less than this much board, so one small first shape is not blown up.
const MIN_FRAME = { w: 620, h: 400 };
const DEFAULT_FRAME: Box = { x: 300, y: 200, w: 1000, h: 600 };

interface Camera { x: number; y: number; z: number }

/** Camera that centres `box` (board units) in the clear part of a width × height sheet. */
function frameBox(box: Box, width: number, height: number): Camera {
  const w = Math.max(box.w, MIN_FRAME.w), h = Math.max(box.h, MIN_FRAME.h);
  const availW = Math.max(160, width - 2 * INSET.side);
  const availH = Math.max(120, height - INSET.top - INSET.bottom);
  const z = Math.min(Z_MAX, Math.max(Z_MIN, Math.min(availW / (w * V), availH / (h * V))));
  return {
    z,
    x: INSET.side + availW / 2 - (box.x + box.w / 2) * V * z,
    y: INSET.top + availH / 2 - (box.y + box.h / 2) * V * z,
  };
}
// Same plot inset ShapeLayer uses for graphs.
const PLOT_INSET = { left: 46, right: 18, top: 16, bottom: 40 };

type SliderShape = Shape & { slider: SliderSpec };
const isSlider = (sh: Shape): sh is SliderShape => sh.kind === "slider" && sh.slider !== undefined;

/**
 * Slider semantics: a vector/arrow target is scaled about its tail by value / initial
 * (clamped 0.15..3). Labels are never changed. Graph targets get a marker (see Board).
 */
function applySliders(shapes: Shape[], values: Record<string, number>): Shape[] {
  const out = shapes.map((sh) => ({ ...sh }));
  const byId = new Map(out.map((sh) => [sh.id, sh] as const));
  for (const sl of out) {
    if (!isSlider(sl)) continue;
    const spec = sl.slider;
    const target = spec.shape_id ? byId.get(spec.shape_id) : undefined;
    if (!target || (target.kind !== "vector" && target.kind !== "arrow")) continue;
    if (!target.from || !target.to) continue;
    const v = values[sl.id] ?? spec.value;
    const ratio = Math.min(3, Math.max(0.15, v / (spec.value || 1)));
    const [fx, fy] = target.from;
    const [tx, ty] = target.to;
    target.to = [fx + (tx - fx) * ratio, fy + (ty - fy) * ratio];
  }
  return out;
}

/** Linear interpolation of a graph's first series at x (clamped to the data range). */
function graphValueAt(g: GraphSpec, x: number): number | null {
  const pts = [...(g.series[0]?.points ?? [])].sort((a, b) => a[0] - b[0]);
  if (pts.length === 0) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return pts[pts.length - 1][1];
}

/** Concepts arrive lowercase; the header shows them with a capital first letter. */
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "N (N)" → "N": the unit suffix is dropped from the read-out. */
const shortName = (label: string) => label.replace(/\s*\(.*\)\s*$/, "").trim() || "y";

/** View-px position of a point on a graph shape (fitted coordinates) using ShapeLayer's plot box. */
function graphPoint(graph: Shape, x: number, y: number, s: number) {
  const g = graph.graph;
  const r = graph.rect;
  if (!g || !r) return null;
  const L = r[0] * s, T = r[1] * s, W = r[2] * s, H = r[3] * s;
  const plot = {
    left: L + PLOT_INSET.left,
    right: L + W - PLOT_INSET.right,
    top: T + PLOT_INSET.top,
    bottom: T + H - PLOT_INSET.bottom,
  };
  if (!(plot.right > plot.left && plot.bottom > plot.top)) return null;
  const { X, Y } = graphMapper(g, plot);
  return { px: X(x), py: Y(y), left: plot.left, bottom: plot.bottom };
}

function useStageSize(ref: { current: HTMLElement | null }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function SliderControl({
  spec,
  value,
  readout,
  onChange,
  onDragStart,
  style,
}: {
  spec: SliderSpec;
  value: number;
  readout?: string;
  onChange: (v: number) => void;
  onDragStart: () => void;
  style?: CSSProperties;
}) {
  const span = spec.max - spec.min || 1;
  const pct = Math.min(100, Math.max(0, ((value - spec.min) / span) * 100));
  const fill = { "--wb-fill": `${pct}%` } as CSSProperties;
  return (
    <div className="wb-slider" style={style}>
      <div className="wb-slider-label">
        {spec.label}: <strong className="wb-accent">{value}{spec.unit}</strong>
      </div>
      <input
        type="range"
        className="wb-range"
        aria-label={spec.label}
        min={spec.min}
        max={spec.max}
        step={spec.step > 0 ? spec.step : 1}
        value={value}
        style={fill}
        onPointerDown={onDragStart}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      {readout && <div className="wb-slider-read">{readout}</div>}
    </div>
  );
}

function EmptyBoard() {
  return (
    <div className="wb-empty">
      <svg className="wb-doodle" width="240" height="120" viewBox="0 0 240 120" aria-hidden="true">
        <path pathLength={1} d="M18 92 C52 62 78 112 116 84 S186 48 222 70" />
        <circle pathLength={1} cx="62" cy="36" r="18" />
        <path pathLength={1} d="M150 30 L206 22 M194 12 L206 22 L198 34" />
      </svg>
      <p>Ask about anything on your screen — or say “draw it on the whiteboard.”</p>
    </div>
  );
}

interface BoardProps {
  response: TutorResponse | null;
  sideNote: WhiteboardProps["sideNote"];
  visibleSegmentIds: string[];
  pulseShapeIds: string[];
  theme: "light" | "dark";
  width: number;
  height: number;
}

interface SliderItem {
  sh: SliderShape;
  value: number;
  target?: Shape;
  readout?: { y: number; text: string };
}

/**
 * The drawing. Shapes stay at the coordinates the tutor gave them, drawn at a fixed scale; a camera
 * (one CSS transform) glides to frame what has been drawn so far, so each step is large and centred
 * and the finished picture fills the sheet. Keyed by concept in the parent: a new answer starts fresh.
 */
function Board({ response, sideNote, visibleSegmentIds, pulseShapeIds, theme, width, height }: BoardProps) {
  const s = V;
  const [sliderValues, setSliderValues] = useState<Record<string, number>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const visible = useMemo(() => new Set(visibleSegmentIds), [visibleSegmentIds]);

  useEffect(() => {
    if (dragging === null) return;
    const end = () => setDragging(null);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragging]);

  // Whiteboard answers are only tidied: composeBoard never moves geometry, so streaming never reshuffles it.
  const prep = (shapes: Shape[]) => composeBoard(shapes);
  const baseMain = useMemo(() => prep(response?.shapes ?? []), [response?.shapes]);
  const baseSide = useMemo(() => prep(sideNote?.shapes ?? []), [sideNote?.shapes]);
  const mainShapes = useMemo(() => applySliders(baseMain, sliderValues), [baseMain, sliderValues]);
  const sideShapes = useMemo(() => applySliders(baseSide, sliderValues), [baseSide, sliderValues]);
  const sideIds = useMemo(() => sideNote?.segments.map((seg) => seg.id) ?? [], [sideNote]);

  const toView = useMemo(() => (p: Pt): Pt => [p[0] * s, p[1] * s], [s]);
  const styleFor = useMemo(() => (sh: Shape) => boardStyle(sh.color_role, theme), [theme]);

  // What the camera frames: everything drawn so far (the first step while nothing is drawn yet).
  const firstSegId = response?.segments[0]?.id;
  const focus = useMemo<Box>(() => {
    const placedShapes = baseMain.filter((sh) => sh.kind !== "slider" || sh.rect);
    let seen = placedShapes.filter((sh) => visible.has(sh.segment_id));
    if (baseSide.length > 0) seen = [...seen, ...baseSide.filter((sh) => sh.kind !== "slider" || sh.rect)];
    if (seen.length === 0) seen = placedShapes.filter((sh) => sh.segment_id === firstSegId);
    if (seen.length === 0) seen = placedShapes;
    return contentBox(seen) ?? DEFAULT_FRAME;
  }, [baseMain, baseSide, visible, firstSegId]);
  const cam = frameBox(focus, width, height);
  const camCss = `translate(${cam.x.toFixed(1)}px, ${cam.y.toFixed(1)}px) scale(${cam.z.toFixed(4)})`;

  // The first frame lands on its target; every later change glides.
  const [gliding, setGliding] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGliding(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const camClass = gliding ? "wb-cam is-gliding" : "wb-cam";

  const mainDraw = mainShapes.filter((sh) => sh.kind !== "slider");
  const sideDraw = sideShapes.filter((sh) => sh.kind !== "slider");

  const mainById = new Map(mainShapes.map((sh) => [sh.id, sh] as const));
  const sideById = new Map(sideShapes.map((sh) => [sh.id, sh] as const));
  const toItem = (sh: SliderShape, byId: Map<string, Shape>): SliderItem => {
    const value = sliderValues[sh.id] ?? sh.slider.value;
    const target = sh.slider.shape_id ? byId.get(sh.slider.shape_id) : undefined;
    let readout: SliderItem["readout"];
    if (target?.graph) {
      const y = graphValueAt(target.graph, value);
      if (y !== null) {
        readout = { y, text: `${shortName(target.graph.y_label)} ≈ ${y.toFixed(1)}` };
      }
    }
    return { sh, value, target, readout };
  };
  const mainItems = mainShapes
    .filter(isSlider)
    .filter((sh) => visible.has(sh.segment_id))
    .map((sh) => toItem(sh, mainById));
  const sideItems = sideShapes.filter(isSlider).map((sh) => toItem(sh, sideById));
  const items = [...mainItems, ...sideItems];
  const placed = items.filter((it) => it.sh.rect);
  const floating = items.filter((it) => !it.sh.rect);

  // Graph markers: dot on the first series at the slider value, with guides and a read-out pill.
  const markers = items.flatMap((it) => {
    if (!it.readout || !it.target) return [];
    const geo = graphPoint(it.target, it.value, it.readout.y, s);
    return geo ? [{ key: it.sh.id, ...geo, text: it.readout.text }] : [];
  });

  // Pulse the target of a slider that is being dragged, unless it is a graph (marker) or vector (scaled).
  const pulse = new Set(pulseShapeIds);
  if (dragging) {
    const it = items.find((i) => i.sh.id === dragging);
    const kind = it?.target?.kind;
    if (it?.target && kind !== "graph" && kind !== "vector" && kind !== "arrow") pulse.add(it.target.id);
  }

  return (
    <div className="wb-board" style={{ width, height }}>
      <svg className="wb-svg" width={width} height={height} aria-hidden="true">
        <defs>
          <pattern id="wb-grid" width={GRID * s} height={GRID * s} patternUnits="userSpaceOnUse">
            <circle cx={GRID * s * 0.5} cy={GRID * s * 0.5} r={1.1} style={{ fill: "var(--wb-grid)" }} />
          </pattern>
        </defs>
        <g className={camClass} style={{ transform: camCss }}>
          <rect x={-4000} y={-4000} width={10000} height={9000} fill="url(#wb-grid)" />
          <ShapeLayer
            shapes={mainDraw}
            visibleSegmentIds={visibleSegmentIds}
            pulseShapeIds={[...pulse]}
            variant="main"
            toView={toView}
            scale={s}
            styleFor={styleFor}
            opacity={sideNote ? 0.35 : 1}
          />
          {sideNote && (
            <ShapeLayer
              shapes={sideDraw}
              visibleSegmentIds={sideIds}
              pulseShapeIds={pulseShapeIds}
              variant="sidenote"
              toView={toView}
              scale={s}
              styleFor={styleFor}
            />
          )}
          {markers.map((m) => (
            <g key={m.key} className="wb-marker" style={{ transform: `translate(${m.px}px, ${m.py}px)` }}>
              <line className="wb-guide" x1={0} y1={0} x2={0} y2={m.bottom - m.py} />
              <line className="wb-guide" x1={0} y1={0} x2={m.left - m.px} y2={0} />
              <circle className="wb-marker-dot" r={3.5} />
              <g transform="translate(10, -30)">
                <rect className="wb-pill" width={m.text.length * 6.6 + 16} height={20} rx={10} />
                <text className="wb-pill-text" x={8} y={14}>{m.text}</text>
              </g>
            </g>
          ))}
        </g>
      </svg>

      {!response && <EmptyBoard />}

      {placed.length > 0 && (
        <div className={`wb-cam-html ${camClass}`} style={{ transform: camCss }}>
          {placed.map((it) => {
            const r = it.sh.rect;
            if (!r) return null;
            return (
              <SliderControl
                key={it.sh.id}
                spec={it.sh.slider}
                value={it.value}
                readout={it.readout?.text}
                onChange={(v) => setSliderValues((prev) => ({ ...prev, [it.sh.id]: v }))}
                onDragStart={() => setDragging(it.sh.id)}
                style={{ left: r[0] * s, top: r[1] * s, width: Math.max(r[2] * s, SLIDER_MIN_W) }}
              />
            );
          })}
        </div>
      )}
      {floating.length > 0 && (
        <div className="wb-slider-stack">
          {floating.map((it) => (
            <SliderControl
              key={it.sh.id}
              spec={it.sh.slider}
              value={it.value}
              readout={it.readout?.text}
              onChange={(v) => setSliderValues((prev) => ({ ...prev, [it.sh.id]: v }))}
              onDragStart={() => setDragging(it.sh.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function Whiteboard(props: WhiteboardProps) {
  const {
    response,
    visibleSegmentIds,
    currentSegmentId,
    pulseShapeIds,
    sideNote,
    theme,
    caption,
    phase,
    sourceLabel,
    onToggleTheme,
    onClose,
    pending = false,
    frameless = false,
    openSeq = 0,
    closing = false,
    origin = null,
  } = props;

  const stageRef = useRef<HTMLElement>(null);
  const stage = useStageSize(stageRef);

  const boardKey = response?.concept ?? "__empty__";
  const boardProps: BoardProps = {
    response, sideNote, visibleSegmentIds, pulseShapeIds, theme, width: stage.w, height: stage.h,
  };
  // Last committed board props, so a board that is replaced can stay up, frozen, while it fades.
  const lastBoard = useRef<BoardProps>(boardProps);
  useEffect(() => {
    lastBoard.current = boardProps;
  });
  const [shownKey, setShownKey] = useState(boardKey);
  const [leaving, setLeaving] = useState<{ key: string; props: BoardProps }[]>([]);
  if (shownKey !== boardKey) {
    // Derived during render, so the old board never unmounts for a frame before it fades.
    setShownKey(boardKey);
    setLeaving((l) => [...l.filter((x) => x.key !== boardKey && x.key !== shownKey), { key: shownKey, props: lastBoard.current }]);
  }
  const leavingKeys = leaving.map((l) => l.key).join("|");
  useEffect(() => {
    if (!leavingKeys) return;
    const timer = window.setTimeout(() => setLeaving([]), BOARD_FADE_MS + 40);
    return () => window.clearTimeout(timer);
  }, [leavingKeys]);
  const boards = [
    ...leaving.filter((l) => l.key !== boardKey).map((l) => ({ key: l.key, props: l.props, out: true })),
    { key: boardKey, props: boardProps, out: false },
  ];

  const visible = useMemo(() => new Set(visibleSegmentIds), [visibleSegmentIds]);
  const segments = response?.segments ?? [];
  const currentText = segments.find((seg) => seg.id === currentSegmentId)?.text ?? "";
  const thinking = pending || phase === "thinking" || phase === "verifying";
  const text = (caption || currentText).trim();
  const showCaption = response !== null && (thinking || text.length > 0 || segments.length > 0);

  const rootClass = [
    "wb-root",
    `wb-${theme}`,
    frameless ? "wb-frameless" : "wb-framed",
    closing ? "is-closing" : openSeq > 0 ? (openSeq % 2 ? "is-open-a" : "is-open-b") : "",
  ].join(" ");
  const rootStyle = (origin ? { "--wb-ox": origin.x, "--wb-oy": origin.y } : {}) as CSSProperties;

  return (
    <div className={rootClass} style={rootStyle}>
      <div className="wb-sheet">
        <main className="wb-stage" ref={stageRef}>
          {stage.w >= 80 && stage.h >= 80 && (
            <div className={`wb-board-wrap${pending ? " is-pending" : ""}`}>
              {boards.map((b) => (
                <div key={b.key} className={`wb-board-layer${b.out ? " is-leaving" : ""}`}>
                  <Board {...b.props} />
                </div>
              ))}
            </div>
          )}
        </main>

        <header className="wb-header" data-tauri-drag-region>
          <div className="wb-titles" data-tauri-drag-region>
            <div className="wb-eyebrow" data-tauri-drag-region>
              {response?.surface === "whiteboard" ? "Whiteboard · drawn from scratch" : "Whiteboard"}
            </div>
            <h1 className="wb-title" title={response?.concept} data-tauri-drag-region>
              {response ? capitalise(response.concept) : "Nothing drawn yet"}
            </h1>
          </div>
          <div className="wb-actions">
            {response && sourceLabel ? (
              <span className="wb-chip" title={sourceLabel}>{sourceLabel}</span>
            ) : null}
            <button
              type="button"
              className="wb-btn"
              onClick={() => onToggleTheme?.()}
              aria-label={theme === "light" ? "Switch to dark board" : "Switch to light board"}
              title={theme === "light" ? "Dark board" : "Light board"}
            >
              {theme === "light" ? <MoonIcon /> : <SunIcon />}
            </button>
            <button
              type="button"
              className="wb-btn"
              onClick={() => onClose?.()}
              aria-label="Close whiteboard"
              title="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        {showCaption && (
          <footer className="wb-caption">
            <p
              key={thinking ? "__thinking__" : text}
              className={`wb-caption-text${thinking ? " wb-shimmer" : ""}`}
              aria-live="polite"
            >
              {thinking ? "Thinking…" : text}
            </p>
            {segments.length > 1 && (
              <div className="wb-dots" aria-hidden="true">
                {segments.map((seg) => {
                  const on = visible.has(seg.id);
                  const cur = seg.id === currentSegmentId;
                  return (
                    <span
                      key={seg.id}
                      className={`wb-dot${on ? " is-on" : ""}${cur ? " is-current" : ""}`}
                    />
                  );
                })}
              </div>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
