import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
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
    if (!snapshot || phase === "idle" || inTarget || !cap || !sn || snapshot.response?.surface === "whiteboard") return null;
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
    return isFixture || forcedByUrl ? snapshot.capture : null;
  }, [snapshot, phase, isFixture, forcedByUrl]);

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

  return (
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
      <TargetingLayer origin={origin} />
    </svg>
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
