import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { EV, type Pt, type TargetingUpdate } from "@shared/contracts";
import { fmt, smoothPath } from "@/render/geometry";
import { useSession } from "@/lib/sessionMirror";

const CLEAR_MS = 200;
const GRAD_ID = "gt-tgt-lasso-grad";
const GLOW_ID = "gt-tgt-glow";
const MAX_TRAIL = 400;

interface Origin { x: number; y: number }

/**
 * Lens and lasso feedback while the user drags a target. Coordinates arrive in global
 * points and are converted to overlay-view points by subtracting the display origin.
 */
export function TargetingLayer({ origin }: { origin: Origin }) {
  const [target, setTarget] = useState<TargetingUpdate | null>(null);
  const [live, setLive] = useState(false);
  const clearTimer = useRef<number | null>(null);

  useEffect(() => {
    let dead = false;
    let unlisten: (() => void) | undefined;

    listen<TargetingUpdate>(EV.targeting, (e) => {
      const u = e.payload;
      if (clearTimer.current !== null) {
        window.clearTimeout(clearTimer.current);
        clearTimer.current = null;
      }
      if (u.kind === "clear") {
        setLive(false);
        clearTimer.current = window.setTimeout(() => {
          clearTimer.current = null;
          setTarget(null);
        }, CLEAR_MS);
        return;
      }
      setTarget(u);
      setLive(true);
    })
      .then((fn) => {
        if (dead) fn();
        else unlisten = fn;
      })
      .catch((err) => console.warn("[TargetingLayer] listen failed", err));

    return () => {
      dead = true;
      unlisten?.();
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    };
  }, []);

  const view = (p: Pt): Pt => [p[0] - origin.x, p[1] - origin.y];

  return (
    <>
    <SetupHint />
    <g style={{ opacity: live && target ? 1 : 0, transition: `opacity ${CLEAR_MS}ms ease-out` }}>
      <defs>
        <filter id={GLOW_ID} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <linearGradient
          id={GRAD_ID}
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={0}
          x2={120}
          y2={0}
          spreadMethod="repeat"
        >
          <animate attributeName="x1" values="0;120" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="x2" values="120;240" dur="2.4s" repeatCount="indefinite" />
          <stop offset="0" stopColor="#5EF2FF" />
          <stop offset="0.5" stopColor="#9B7BFF" />
          <stop offset="1" stopColor="#FF6EC7" />
        </linearGradient>
      </defs>
      {target?.kind === "lens" && (
        <Lens cx={target.cx - origin.x} cy={target.cy - origin.y} r={target.r} />
      )}
      {target?.kind === "lasso" && <Lasso pts={target.points.slice(-MAX_TRAIL).map(view)} closed={target.closed} />}
    </g>
    </>
  );
}

const HINT_TEXT = "Set up Pimple";
const HINT_W = 126;
const HINT_H = 30;
// The resting drop: centre 8 pt in from the display edge, 34 pt radius (see useBubbleMotion).
const DROP_INSET = 8;
const DROP_R = 34;

/**
 * "Set up Pimple": a small glass pill beside the resting drop while the app has no key yet. The
 * bubble window is too small to hold it, so the bubble asks for it here ("bubble:setup-hint" {ms}:
 * show for that long, 0 hides) on arrival, every 20 s and on hover. Never shown during a session.
 */
function SetupHint() {
  const needsSetup = useSession((s) => (s as { needsSetup?: unknown }).needsSetup === true);
  const idle = useSession((s) => s.phase === "idle");
  const edge = useSession((s) => s.settings?.bubbleEdge) ?? "right";
  const bubbleY = useSession((s) => s.settings?.bubbleY) ?? 0.5;
  const [shown, setShown] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let dead = false;
    let unlisten: (() => void) | undefined;
    const stop = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    listen<{ ms?: number }>("bubble:setup-hint", (e) => {
      const ms = Number(e.payload?.ms) || 0;
      stop();
      if (ms <= 0) {
        setShown(false);
        return;
      }
      setShown(true);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setShown(false);
      }, ms);
    })
      .then((fn) => {
        if (dead) fn();
        else unlisten = fn;
      })
      .catch((err) => console.warn("[SetupHint] listen failed", err));
    return () => {
      dead = true;
      unlisten?.();
      stop();
    };
  }, []);

  const on = shown && needsSetup && idle;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  const right = edge !== "left";
  const cy = Math.min(Math.max(Number.isFinite(bubbleY) ? bubbleY : 0.5, 0.08), 0.92) * vh;
  const gap = 12;
  const x = right ? vw - DROP_INSET - DROP_R - gap - HINT_W : DROP_INSET + DROP_R + gap;
  const y = cy - HINT_H / 2;
  const slide = right ? 10 : -10;
  return (
    <g
      aria-hidden="true"
      style={{
        opacity: on ? 1 : 0,
        transform: `translate(${on ? 0 : slide}px, 0px)`,
        transition: "opacity 320ms ease, transform 420ms cubic-bezier(0.25, 1.3, 0.4, 1)",
      }}
    >
      <rect x={x - 0.5} y={y + 2.5} width={HINT_W + 1} height={HINT_H} rx={HINT_H / 2} fill="rgba(20,24,40,0.16)" />
      <rect x={x} y={y} width={HINT_W} height={HINT_H} rx={HINT_H / 2} fill="rgba(255,255,255,0.86)"
        stroke="rgba(255,170,70,0.55)" strokeWidth={1} />
      <path d={`M${x + 13} ${y + 1.4} H${x + HINT_W - 13}`} stroke="rgba(255,255,255,0.95)" strokeWidth={1} strokeLinecap="round" />
      <circle cx={x + 16} cy={y + HINT_H / 2} r={4} fill="#FFA63D" />
      <circle cx={x + 16} cy={y + HINT_H / 2} r={7} fill="none" stroke="rgba(255,166,61,0.35)" strokeWidth={1.5} />
      <text x={x + 29} y={y + HINT_H / 2 + 4.4}
        style={{ font: '600 12.5px -apple-system, "SF Pro Text", system-ui, sans-serif', fill: "#2A2D36" }}>
        {HINT_TEXT}
      </text>
    </g>
  );
}

function Lens({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  // The bubble itself is the lens now (a WebGL drop that refracts the live screen), so the overlay
  // only hints at the capture box. Nothing is drawn inside the glass: it would be refracted.
  const half = r * 1.12; // capture box: bounding square plus the 12% padding the capture uses
  const c = Math.min(14, half * 0.25);
  const corner = (sx: number, sy: number) => {
    const x = cx + sx * half;
    const y = cy + sy * half;
    return `M${x - sx * c} ${y} H${x} V${y - sy * c}`;
  };
  const d = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].join(" ");
  return (
    <>
      <path d={d} fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth={3} strokeLinecap="round" />
      <path d={d} fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth={1.5} strokeLinecap="round" />
    </>
  );
}

const CAPTURE_PAD = 0.12; // the capture pads the loop's box by 12% a side; the brackets show that box

function Lasso({ pts, closed }: { pts: Pt[]; closed: boolean }) {
  if (pts.length === 0) return null;
  const isLoop = closed && pts.length > 2;
  const d = pts.length === 1
    ? `M${fmt(pts[0][0])} ${fmt(pts[0][1])} h0.01`
    : isLoop
      ? closedPath(pts)
      : smoothPath(pts);
  const stroke = `url(#${GRAD_ID})`;

  let bbox: { x: number; y: number; w: number; h: number } | null = null;
  if (isLoop) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const px = (x1 - x0) * CAPTURE_PAD, py = (y1 - y0) * CAPTURE_PAD;
    bbox = { x: x0 - px, y: y0 - py, w: x1 - x0 + 2 * px, h: y1 - y0 + 2 * py };
  }

  // Liquid ribbon: a clear glass tube with a dispersed (rainbow) edge. Layered strokes only, no
  // SVG filters (WebKit rasterises them blurry): contact shadow, tube body, the three dispersed
  // channels pulled apart sideways, a running spectrum, then the specular thread on top.
  // When the loop closes, the ribbon flashes once, the inside fills and the capture brackets land.
  const line = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <>
      {isLoop && <path d={d} className="gt-lasso-fill" fill="rgba(255,255,255,0.12)" stroke="none" />}
      <path d={d} {...line} stroke="rgba(10,20,40,0.16)" strokeWidth={13} transform="translate(0 2)" />
      <path d={d} {...line} stroke="rgba(10,20,40,0.30)" strokeWidth={10} />
      <path d={d} {...line} stroke="rgba(255,255,255,0.55)" strokeWidth={8.5} />
      <path d={d} {...line} stroke="rgba(255,64,96,0.55)" strokeWidth={6} transform="translate(-1.6 -1.2)" />
      <path d={d} {...line} stroke="rgba(60,220,255,0.55)" strokeWidth={6} transform="translate(1.6 1.2)" />
      <path d={d} {...line} stroke="rgba(255,214,64,0.45)" strokeWidth={4.5} transform="translate(1.2 -1.4)" />
      <path d={d} {...line} stroke={stroke} strokeWidth={5} opacity={0.55} />
      <path d={d} {...line} stroke="rgba(255,255,255,0.72)" strokeWidth={4} />
      <path d={d} {...line} stroke="#FFFFFF" strokeWidth={1.4} transform="translate(-1 -1.1)" />
      {isLoop && <path d={d} {...line} className="gt-lasso-flash" stroke="#FFFFFF" strokeWidth={9} />}
      {bbox && (
        <g className="gt-lasso-box">
          <path d={brackets(bbox)} {...line} stroke="rgba(0,0,0,0.25)" strokeWidth={3} />
          <path d={brackets(bbox)} {...line} stroke="rgba(255,255,255,0.85)" strokeWidth={1.5} />
        </g>
      )}
      <style>{LASSO_CSS}</style>
    </>
  );
}

const LASSO_CSS = `
.gt-lasso-fill { animation: gt-lasso-fill 320ms ease-out both; }
.gt-lasso-flash { animation: gt-lasso-flash 420ms ease-out both; pointer-events: none; }
.gt-lasso-box { animation: gt-lasso-box 360ms cubic-bezier(0.25, 1.4, 0.4, 1) both; transform-box: fill-box; transform-origin: center; }
@keyframes gt-lasso-fill { from { opacity: 0; } to { opacity: 1; } }
@keyframes gt-lasso-flash { from { opacity: 0.75; } to { opacity: 0; } }
@keyframes gt-lasso-box { from { opacity: 0; transform: scale(1.08); } to { opacity: 1; transform: none; } }
`;

/** A smooth closed curve through the loop's points (Catmull-Rom, wrapped), so the join has no corner. */
function closedPath(pts: Pt[]): string {
  const n = pts.length;
  // Drop a duplicated end point so the wrap is clean.
  const m = Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) < 0.5 ? n - 1 : n;
  if (m < 3) return smoothPath(pts) + " Z";
  const at = (i: number) => pts[((i % m) + m) % m];
  let d = `M${fmt(at(0)[0])} ${fmt(at(0)[1])}`;
  for (let i = 0; i < m; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d + " Z";
}

/** Corner brackets around a box (the same capture hint the lens uses). */
function brackets(b: { x: number; y: number; w: number; h: number }): string {
  const c = Math.min(14, b.w * 0.25, b.h * 0.25);
  const corner = (x: number, y: number, sx: number, sy: number) => `M${x - sx * c} ${y} H${x} V${y - sy * c}`;
  return [
    corner(b.x, b.y, -1, -1),
    corner(b.x + b.w, b.y, 1, -1),
    corner(b.x + b.w, b.y + b.h, 1, 1),
    corner(b.x, b.y + b.h, -1, 1),
  ].join(" ");
}
