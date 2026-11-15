import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { EV, type Pt, type TargetingUpdate } from "@shared/contracts";
import { fmt, smoothPath } from "@/render/geometry";

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

function Lasso({ pts, closed }: { pts: Pt[]; closed: boolean }) {
  if (pts.length === 0) return null;
  const d = pts.length === 1
    ? `M${fmt(pts[0][0])} ${fmt(pts[0][1])} h0.01`
    : smoothPath(pts) + (closed && pts.length > 2 ? " Z" : "");
  const stroke = `url(#${GRAD_ID})`;

  let bbox: { x: number; y: number; w: number; h: number } | null = null;
  if (closed && pts.length > 2) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pad = 6;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    bbox = { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
  }

  // Liquid ribbon: a clear glass tube with a dispersed (rainbow) edge. Layered strokes only, no
  // SVG filters (WebKit rasterises them blurry): contact shadow, tube body, the three dispersed
  // channels pulled apart sideways, a running spectrum, then the specular thread on top.
  const line = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <>
      {closed && pts.length > 2 && <path d={d} fill="rgba(255,255,255,0.10)" stroke="none" />}
      <path d={d} {...line} stroke="rgba(10,20,40,0.16)" strokeWidth={13} transform="translate(0 2)" />
      <path d={d} {...line} stroke="rgba(10,20,40,0.30)" strokeWidth={10} />
      <path d={d} {...line} stroke="rgba(255,255,255,0.55)" strokeWidth={8.5} />
      <path d={d} {...line} stroke="rgba(255,64,96,0.55)" strokeWidth={6} transform="translate(-1.6 -1.2)" />
      <path d={d} {...line} stroke="rgba(60,220,255,0.55)" strokeWidth={6} transform="translate(1.6 1.2)" />
      <path d={d} {...line} stroke="rgba(255,214,64,0.45)" strokeWidth={4.5} transform="translate(1.2 -1.4)" />
      <path d={d} {...line} stroke={stroke} strokeWidth={5} opacity={0.55} />
      <path d={d} {...line} stroke="rgba(255,255,255,0.72)" strokeWidth={4} />
      <path d={d} {...line} stroke="#FFFFFF" strokeWidth={1.4} transform="translate(-1 -1.1)" />
      {bbox && <path d={brackets(bbox)} {...line} stroke="rgba(0,0,0,0.25)" strokeWidth={3} />}
      {bbox && <path d={brackets(bbox)} {...line} stroke="rgba(255,255,255,0.8)" strokeWidth={1.5} />}
    </>
  );
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
