import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  imagePxToScreen,
  type CaptureResult,
  type Phase,
  type Pt,
  type SessionSnapshot,
  type Shape,
} from "@shared/contracts";
import { ShapeLayer } from "@/render/ShapeLayer";
import { adaptiveStyle, type ShapeStyle } from "@/render/palette";
import { loadCaptureSampler, type BgSampler } from "@/render/sampleBackground";
import { useDisplayOrigin, type Origin } from "./useDisplayOrigin";
import { TargetingLayer } from "./TargetingLayer";
import "./overlay.css";

const MAIN_FADE_MS = 400;
const SIDE_FADE_MS = 450;
const SIDE_DIM = 0.3;
const FLAT_BG = { lum: 0.9, hue: 0 };
const TARGET_FADE_MS = 200;
/** Phases in which the debug fixture backdrop may show. Never while the user is aiming. */
const FIXTURE_PHASES = new Set<Phase>([
  "summarising", "listening", "thinking", "verifying", "speaking", "interrupted", "checking",
]);

/** Phases in which the screen-edge glow is on. Off while aiming and capturing, so it is never photographed. */
const GLOW_PHASES = new Set<Phase>([
  "summarising", "listening", "thinking", "verifying", "speaking", "interrupted", "checking",
]);
const EDGE_T = 9;             // glow thickness in points
const EDGE_FLOW_MS = 16000;   // one colour period passing a point at rate 1 (speaking)
const EDGE_FADE_MS = 500;

interface Layer {
  capture: CaptureResult;
  shapes: Shape[];
  visibleIds: string[];
  pulseIds: string[];
}

/** Keeps the last non-null value mounted for `fadeMs` after it becomes null, so it can fade out. */
function useRetained<T>(value: T | null, fadeMs: number): { value: T | null; visible: boolean } {
  const [held, setHeld] = useState<T | null>(value);
  const [visible, setVisible] = useState(value !== null);

  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      setVisible(true);
      return;
    }
    setVisible(false);
    const t = window.setTimeout(() => setHeld(null), fadeMs);
    return () => window.clearTimeout(t);
  }, [value, fadeMs]);

  return { value: value ?? held, visible };
}

/** Memoised per-shape styles: sample the background under each shape, then pick a legible colour. */
function useStyler(
  sampler: BgSampler | null,
  pixelScale: number,
  variant: "main" | "sidenote",
): (shape: Shape) => ShapeStyle {
  return useMemo(() => {
    const cache = new Map<string, ShapeStyle>();
    return (shape: Shape) => {
      const key = `${shape.id}|${JSON.stringify(shape)}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const bg = sampler ? sampler.sample(shape, 6 * pixelScale) : FLAT_BG;
      const style = adaptiveStyle(shape.color_role, bg, variant);
      cache.set(key, style);
      return style;
    };
  }, [sampler, pixelScale, variant]);
}

function toViewFor(capture: CaptureResult | null, origin: Origin): (p: Pt) => Pt {
  return (p: Pt) => {
    if (!capture) return p;
    const s = imagePxToScreen(capture, p);
    return [s[0] - origin.x, s[1] - origin.y];
  };
}

export function OverlayRoot({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const origin = useDisplayOrigin();
  const imagePath = snapshot?.capture?.imagePath ?? null;

  // Sampler for the current capture image. Reset only when the image changes, so a fade-out
  // after the session goes idle keeps its colours.
  const [sampler, setSampler] = useState<BgSampler | null>(null);
  useEffect(() => {
    if (!imagePath) return;
    let dead = false;
    setSampler(null);
    loadCaptureSampler(imagePath)
      .then((s) => {
        if (!dead) setSampler(s);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [imagePath]);

  // Window size in view points, so the shape layers can keep labels on screen.
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cuts = useWindowCuts();
  const current = snapshot?.currentSegmentId ?? null;
  const phase: Phase = snapshot?.phase ?? "idle";
  // Entering a drag: the previous session's shapes fade out quickly, and the backdrop hides at once.
  const inTarget = phase === "targeting" || phase === "capturing";

  const main = useMemo<Layer | null>(() => {
    const cap = snapshot?.capture;
    const resp = snapshot?.response;
    if (!snapshot || phase === "idle" || inTarget || !cap || !resp || resp.surface !== "overlay") return null;
    const visibleIds = [...snapshot.spokenSegmentIds, ...(current ? [current] : [])];
    return {
      capture: cap,
      shapes: resp.shapes.filter((s) => s.kind !== "slider"),
      visibleIds,
      pulseIds: snapshot.pulseShapeIds,
    };
  }, [snapshot, phase, inTarget, current]);

  const side = useMemo<Layer | null>(() => {
    const cap = snapshot?.capture;
    const sn = snapshot?.sideNote;
    if (!snapshot || phase === "idle" || inTarget || !cap || !sn || snapshot.response?.surface !== "overlay") return null;
    const spoken = new Set([...snapshot.spokenSegmentIds, ...(current ? [current] : [])]);
    const matching = sn.segments.filter((s) => spoken.has(s.id)).map((s) => s.id);
    return {
      capture: cap,
      shapes: sn.shapes.filter((s) => s.kind !== "slider"),
      visibleIds: matching.length > 0 ? matching : sn.segments.map((s) => s.id),
      pulseIds: snapshot.pulseShapeIds,
    };
  }, [snapshot, phase, inTarget, current]);

  // Debug fixture backdrop: the raw capture drawn under the shapes, so a headless preview can
  // check alignment. Forced on by `?fixtureBackdrop=1` or by the snapshot's isFixture flag.
  const forcedByUrl = useMemo(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("fixtureBackdrop") === "1",
    [],
  );
  const isFixture = (snapshot as (SessionSnapshot & { isFixture?: boolean }) | null)?.isFixture === true;
  const backdrop = useMemo<CaptureResult | null>(() => {
    if (!snapshot || !FIXTURE_PHASES.has(phase) || !snapshot.capture) return null;
    // A whiteboard answer draws nothing here: the opaque backdrop would cover the whiteboard window.
    if (snapshot.response?.surface === "whiteboard") return null;
    if (cuts.whiteboard) return null; // never paint the capture while the whiteboard is up
    return isFixture || forcedByUrl ? snapshot.capture : null;
  }, [snapshot, phase, isFixture, forcedByUrl, cuts.whiteboard]);

  // Fade lengths: 200 ms when a drag starts, 400 ms at session end, 450 ms for a side note cleared mid-session.
  const mainFadeMs = inTarget ? TARGET_FADE_MS : MAIN_FADE_MS;
  const sideFadeMs = inTarget ? TARGET_FADE_MS : phase === "idle" ? MAIN_FADE_MS : SIDE_FADE_MS;
  const mainHeld = useRetained(main, mainFadeMs);
  const sideHeld = useRetained(side, sideFadeMs);
  const backdropHeld = useRetained(backdrop, MAIN_FADE_MS);

  const pixelScale = mainHeld.value?.capture.pixelScale ?? sideHeld.value?.capture.pixelScale ?? 1;
  const mainStyle = useStyler(sampler, pixelScale, "main");
  const sideStyle = useStyler(sampler, pixelScale, "sidenote");

  const mainLayer = mainHeld.value;
  const sideLayer = sideHeld.value;
  const dimMain = sideHeld.visible;

  const glowOn = !!snapshot && GLOW_PHASES.has(phase);

  return (
    <>
    <svg
      className="gt-overlay"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        overflow: "visible",
        background: "transparent",
      }}
    >
      <defs>
        {CUT_SOURCES.map((name) => {
          const r = cuts[name];
          if (!r) return null;
          return (
            <clipPath key={name} id={`gt-cut-${name}`} clipPathUnits="userSpaceOnUse">
              <path clipRule="evenodd" d={cutPath(r, origin, viewport)} />
            </clipPath>
          );
        })}
      </defs>
      {/* Our own windows (whiteboard, gizmo) are cut out of the drawing: one nested clip per window,
          so overlapping windows still cut correctly. The tree keeps its shape, so nothing remounts. */}
      <g clipPath={cuts.whiteboard ? "url(#gt-cut-whiteboard)" : undefined}>
      <g clipPath={cuts.gizmo ? "url(#gt-cut-gizmo)" : undefined}>
      {backdropHeld.value && !inTarget && (
        <g style={{ opacity: backdropHeld.visible ? 1 : 0, transition: `opacity ${MAIN_FADE_MS}ms ease` }}>
          <g className="gt-fixture-in">
            <FixtureBackdrop capture={backdropHeld.value} origin={origin} />
          </g>
        </g>
      )}
      {mainLayer && (
        <g style={{ opacity: mainHeld.visible ? 1 : 0, transition: `opacity ${mainFadeMs}ms ease` }}>
          <FocusOutline key={mainLayer.capture.imagePath} capture={mainLayer.capture} origin={origin} />
          <ShapeLayer
            shapes={mainLayer.shapes}
            visibleSegmentIds={mainLayer.visibleIds}
            pulseShapeIds={mainLayer.pulseIds}
            variant="main"
            toView={toViewFor(mainLayer.capture, origin)}
            scale={1 / mainLayer.capture.pixelScale}
            styleFor={mainStyle}
            opacity={dimMain ? SIDE_DIM : 1}
            viewport={viewport}
          />
        </g>
      )}
      {sideLayer && (
        <g style={{ opacity: sideHeld.visible ? 1 : 0, transition: `opacity ${sideFadeMs}ms ease` }}>
          <ShapeLayer
            shapes={sideLayer.shapes}
            visibleSegmentIds={sideLayer.visibleIds}
            pulseShapeIds={sideLayer.pulseIds}
            variant="sidenote"
            toView={toViewFor(sideLayer.capture, origin)}
            scale={1 / sideLayer.capture.pixelScale}
            styleFor={sideStyle}
            viewport={viewport}
          />
        </g>
      )}
      </g>
      </g>
      <TargetingLayer origin={origin} />
    </svg>
    <EdgeGlow active={glowOn} phase={phase} width={viewport.width} height={viewport.height} />
    </>
  );
}

/** How fast the colours travel round the screen, relative to the speaking pace. */
function edgeRate(phase: Phase): number {
  if (phase === "thinking" || phase === "verifying") return 3.4;
  if (phase === "speaking") return 1;
  if (phase === "listening") return 0.4;
  return 0.55;
}

function edgeMood(phase: Phase): string {
  if (phase === "thinking" || phase === "verifying") return "gt-edge-thinking";
  if (phase === "speaking") return "gt-edge-speaking";
  if (phase === "listening") return "gt-edge-listening";
  return "gt-edge-calm";
}

/* ───────────── cut-outs for our own windows ───────────── */

const CUT_SOURCES = ["whiteboard", "gizmo"] as const;
type CutSource = (typeof CUT_SOURCES)[number];
interface CutRect { x: number; y: number; w: number; h: number }
const CUT_RADIUS = 26;

/**
 * Rects (global screen points) of the whiteboard and gizmo windows while they are visible, from
 * their "whiteboard:rect" / "gizmo:rect" events ({x, y, w, h, visible}). The overlay panel sits
 * above those windows, so the drawing is clipped away where they are.
 */
function useWindowCuts(): Partial<Record<CutSource, CutRect>> {
  const [cuts, setCuts] = useState<Partial<Record<CutSource, CutRect>>>({});
  useEffect(() => {
    let gone = false;
    const offs: Array<() => void> = [];
    for (const name of CUT_SOURCES) {
      try {
        listen<{ x?: unknown; y?: unknown; w?: unknown; h?: unknown; visible?: unknown }>(`${name}:rect`, (e) => {
          const p = e.payload ?? {};
          const nums = [p.x, p.y, p.w, p.h];
          const ok = p.visible === true && nums.every((v) => typeof v === "number" && Number.isFinite(v))
            && (p.w as number) > 1 && (p.h as number) > 1;
          setCuts((prev) => {
            const next = { ...prev };
            if (ok) next[name] = { x: p.x as number, y: p.y as number, w: p.w as number, h: p.h as number };
            else delete next[name];
            return next;
          });
        })
          .then((un) => {
            if (gone) un();
            else offs.push(un);
          })
          .catch(() => {});
      } catch {
        // Not inside Tauri (headless preview): nothing to cut.
      }
    }
    return () => {
      gone = true;
      offs.forEach((f) => f());
    };
  }, []);
  return cuts;
}

/** The whole view with one rounded hole (even-odd), in view coordinates. */
function cutPath(r: CutRect, origin: Origin, vp: { width: number; height: number }): string {
  const x = r.x - origin.x, y = r.y - origin.y;
  const q = Math.min(CUT_RADIUS, r.w / 2, r.h / 2);
  const x2 = x + r.w, y2 = y + r.h;
  const outer = `M-200 -200 H${vp.width + 200} V${vp.height + 200} H-200 Z`;
  const hole = `M${x + q} ${y} H${x2 - q} Q${x2} ${y} ${x2} ${y + q} V${y2 - q} Q${x2} ${y2} ${x2 - q} ${y2} `
    + `H${x + q} Q${x} ${y2} ${x} ${y2 - q} V${y + q} Q${x} ${y} ${x + q} ${y} Z`;
  return `${outer} ${hole}`;
}

/** Height of the menu bar in points: the screen's visible frame when the webview reports it, else 30. */
function menuBarInset(): number {
  const t = typeof window !== "undefined" ? (window.screen as Screen & { availTop?: number }).availTop : undefined;
  return typeof t === "number" && t >= 20 && t <= 60 ? Math.round(t) : 30;
}

/**
 * Thin rainbow glow hugging the screen border while a session is active. Four mitred strips, each a
 * long gradient band that slides under a fixed window, so the motion is a compositor-only transform
 * (no repaint of a full-screen layer, no blur filter). The colour period divides the perimeter, and
 * each strip is phased by its distance round the edge, so the colours run continuously through the
 * corners. Speed follows the phase through the animations' playback rate, which never jumps.
 */
function EdgeGlow({ active, phase, width, height }: { active: boolean; phase: Phase; width: number; height: number }) {
  const held = useRetained(active ? true : null, EDGE_FADE_MS + 100);
  const mounted = held.value !== null;
  // The top edge starts below the menu bar, so the glow never draws over it.
  const top0 = menuBarInset();
  const W = Math.max(1, width);
  const H = Math.max(1, height - top0);
  const P = (2 * W + 2 * H) / 3;
  const inners = useRef<(HTMLDivElement | null)[]>([null, null, null, null]);
  const anims = useRef<Animation[]>([]);
  // The mood (breathe, shimmer) stays as it was while fading out, so the glow does not flicker at the end.
  const moodRef = useRef("gt-edge-calm");
  if (active) moodRef.current = edgeMood(phase);

  useEffect(() => {
    if (!mounted) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const shifts = [`translateX(${P}px)`, `translateY(${P}px)`, `translateX(${-P}px)`, `translateY(${-P}px)`];
    const made: Animation[] = [];
    inners.current.forEach((el, i) => {
      if (!el || typeof el.animate !== "function") return;
      try {
        made.push(el.animate([{ transform: "translate(0px, 0px)" }, { transform: shifts[i] }], {
          duration: EDGE_FLOW_MS,
          iterations: Infinity,
          easing: "linear",
        }));
      } catch {
        // A static glow is fine.
      }
    });
    anims.current = made;
    return () => {
      made.forEach((a) => a.cancel());
      anims.current = [];
    };
  }, [mounted, P]);

  const rate = edgeRate(phase);
  useEffect(() => {
    if (!active) return;
    for (const a of anims.current) {
      try {
        if (typeof a.updatePlaybackRate === "function") a.updatePlaybackRate(rate);
        else a.playbackRate = rate;
      } catch {
        // Keep the current pace.
      }
    }
  }, [rate, active, mounted, P]);

  if (!mounted) return null;
  const T = EDGE_T;
  const strips: { cls: string; box: CSSProperties; inner: CSSProperties }[] = [
    {
      cls: "gt-edge-top",
      box: { left: 0, top: 0, width: W, height: T },
      inner: { left: -P, top: 0, width: W + P, height: T, backgroundSize: `${P}px 100%`, backgroundPosition: "0px 0px" },
    },
    {
      cls: "gt-edge-right",
      box: { right: 0, top: 0, width: T, height: H },
      inner: { left: 0, top: -P, width: T, height: H + P, backgroundSize: `100% ${P}px`, backgroundPosition: `0px ${-W}px` },
    },
    {
      cls: "gt-edge-bottom",
      box: { left: 0, bottom: 0, width: W, height: T },
      inner: { left: 0, top: 0, width: W + P, height: T, backgroundSize: `${P}px 100%`, backgroundPosition: `${2 * W + H}px 0px` },
    },
    {
      cls: "gt-edge-left",
      box: { left: 0, top: 0, width: T, height: H },
      inner: { left: 0, top: 0, width: T, height: H + P, backgroundSize: `100% ${P}px`, backgroundPosition: "0px 0px" },
    },
  ];
  return (
    <div className={`gt-edge${held.visible ? "" : " gt-edge-off"}`} style={{ top: top0 }} aria-hidden="true">
      <div className={`gt-edge-mood ${moodRef.current}`}>
        {strips.map((s, i) => (
          <div key={s.cls} className={`gt-edge-strip ${s.cls}`} style={s.box}>
            <div ref={(el) => { inners.current[i] = el; }} className="gt-edge-band" style={s.inner} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Soft glass rim around the region the learner pointed at. It shows as the answer starts, holds for
 * about 1.5 s, then fades away (overlay.css), so it never lingers as a stray frame. Light strokes
 * only: a wide faint bloom, a hairline and a short specular run along the top. No fill, no filter.
 */
function FocusOutline({ capture, origin }: { capture: CaptureResult; origin: Origin }) {
  const r = capture.focus?.regionInScreenPoints;
  if (!r || !(r.w > 8 && r.h > 8)) return null;
  const x = r.x - origin.x;
  const y = r.y - origin.y;
  const rx = Math.min(20, r.w / 4, r.h / 4);
  return (
    <g className="gt-focus-rim">
      <rect x={x} y={y} width={r.w} height={r.h} rx={rx} fill="none"
        stroke="rgba(255,255,255,0.16)" strokeWidth={6} />
      <rect x={x} y={y} width={r.w} height={r.h} rx={rx} fill="none"
        stroke="rgba(120,170,255,0.45)" strokeWidth={2.5} />
      <rect x={x} y={y} width={r.w} height={r.h} rx={rx} fill="none"
        stroke="rgba(255,255,255,0.85)" strokeWidth={1} />
      <path d={`M${x + rx} ${y} L${x + Math.min(r.w - rx, rx + r.w * 0.3)} ${y}`} fill="none"
        stroke="rgba(255,255,255,0.95)" strokeWidth={2} strokeLinecap="round" />
    </g>
  );
}

/** Debug only: the raw capture drawn at its screen rect, labelled so it is never mistaken for the real screen. */
function FixtureBackdrop({ capture, origin }: { capture: CaptureResult; origin: Origin }) {
  const r = capture.regionInScreenPoints;
  const x = r.x - origin.x;
  const y = r.y - origin.y;
  const labelW = 92;
  return (
    <>
      <image
        href={convertFileSrc(capture.imagePath)}
        x={x}
        y={y}
        width={r.w}
        height={r.h}
        preserveAspectRatio="none"
        opacity={1}
      />
      <rect x={x} y={y} width={r.w} height={r.h} fill="none" stroke="rgba(255,80,80,0.8)" strokeWidth={1} strokeDasharray="4 3" />
      <rect x={x + 4} y={y + 4} width={labelW} height={16} rx={8} fill="rgba(220,38,38,0.92)" />
      <text x={x + 4 + labelW / 2} y={y + 15.5} textAnchor="middle" fontSize={10} fontFamily="system-ui, sans-serif" fontWeight={600} fill="#FFFFFF">
        DEBUG FIXTURE
      </text>
    </>
  );
}
