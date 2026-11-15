import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CMD, type AppSettings } from "@shared/contracts";
import { atRest, makeLoop, prefersReducedMotion, settle, spring, stepSpring } from "./spring";

type Edge = AppSettings["bubbleEdge"];

/** bubbleY is the bubble's centre as a fraction of the display height. */
export const BUBBLE_Y_MIN = 0.08;
export const BUBBLE_Y_MAX = 0.92;
const clampY = (y: number) => Math.min(BUBBLE_Y_MAX, Math.max(BUBBLE_Y_MIN, y));

const BEAD = 34; // px, the mini bubble's diameter on the map
const MERGE = 3; // px, how far the resting centre sits inside the edge

/**
 * A mini map of the display. The user drags a liquid bead; on release it snaps to the
 * nearer wall at that height with a springy wobble and reports {bubbleEdge, bubbleY}.
 */
export function BubbleMap({
  edge,
  y,
  onChange,
}: {
  edge: Edge;
  y: number;
  onChange: (edge: Edge, y: number) => void;
}) {
  const [aspect, setAspect] = useState(1728 / 1117);
  const [dragging, setDragging] = useState(false);
  const [hoverEdge, setHoverEdge] = useState<Edge>(edge);
  const [liveY, setLiveY] = useState(clampY(y));

  const mapRef = useRef<HTMLDivElement | null>(null);
  const beadRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const grab = useRef({ dx: 0, dy: 0 });
  // Position springs in map pixels (bead centre) plus a jelly spring for squash and stretch.
  const sx = useRef(spring(0));
  const sy = useRef(spring(0));
  const jelly = useRef(spring(0));
  const placed = useRef(false);
  const loop = useRef<ReturnType<typeof makeLoop> | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<{ displayId: number; frame: { w: number; h: number } }>(CMD.bubbleDisplay)
      .then((d) => {
        if (alive && d?.frame?.w > 0 && d.frame.h > 0) setAspect(d.frame.w / d.frame.h);
      })
      .catch(() => {
        /* outside Tauri (browser preview): keep the default aspect */
      });
    return () => {
      alive = false;
    };
  }, []);

  const size = () => {
    const r = mapRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1, left: r?.left ?? 0, top: r?.top ?? 0 };
  };
  const restX = (e: Edge, w: number) => (e === "left" ? MERGE : w - MERGE);

  const paint = () => {
    const el = beadRef.current;
    if (!el) return;
    const vx = sx.current.v;
    const vy = sy.current.v;
    const speed = Math.hypot(vx, vy);
    const stretch = Math.min(0.32, speed / 2400);
    const ang = speed > 1 ? Math.atan2(vy, vx) : 0;
    const j = jelly.current.x;
    el.style.transform =
      `translate3d(${sx.current.x - BEAD / 2}px, ${sy.current.x - BEAD / 2}px, 0) ` +
      `rotate(${ang}rad) scale(${1 + stretch}, ${1 - stretch * 0.7}) rotate(${-ang}rad) ` +
      `scale(${1 - j * 0.22}, ${1 + j * 0.22})`;
  };

  if (!loop.current) {
    loop.current = makeLoop((dt) => {
      const drag = draggingRef.current;
      // Dragging: a stiff, well-damped follow. Released: a loose spring so it wobbles on the wall.
      stepSpring(sx.current, drag ? 620 : 210, drag ? 34 : 11.5, dt);
      stepSpring(sy.current, drag ? 620 : 240, drag ? 34 : 15, dt);
      stepSpring(jelly.current, 300, 9, dt);
      paint();
      return drag || !atRest(sx.current, 0.05) || !atRest(sy.current, 0.05) || !atRest(jelly.current, 0.004);
    });
  }

  // Follow the saved setting (also when the real bubble is moved by hand) unless mid-drag.
  useEffect(() => {
    if (draggingRef.current) return;
    const { w, h } = size();
    sx.current.target = restX(edge, w);
    sy.current.target = clampY(y) * h;
    setHoverEdge(edge);
    setLiveY(clampY(y));
    if (!placed.current || prefersReducedMotion()) {
      placed.current = true;
      settle(sx.current);
      settle(sy.current);
      paint();
    } else {
      loop.current?.kick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge, y, aspect]);

  // Keep the bead on its wall when the map is resized.
  useEffect(() => {
    const el = mapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (draggingRef.current) return;
      const { w, h } = size();
      sx.current.target = restX(hoverEdgeRef.current, w);
      sy.current.target = liveYRef.current * h;
      settle(sx.current);
      settle(sy.current);
      paint();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => loop.current?.stop(), []);

  const hoverEdgeRef = useRef(hoverEdge);
  hoverEdgeRef.current = hoverEdge;
  const liveYRef = useRef(liveY);
  liveYRef.current = liveY;

  const moveTo = (clientX: number, clientY: number) => {
    const { w, h, left, top } = size();
    const px = Math.min(w - BEAD / 2 + 6, Math.max(BEAD / 2 - 6, clientX - left - grab.current.dx));
    const py = Math.min(h * BUBBLE_Y_MAX, Math.max(h * BUBBLE_Y_MIN, clientY - top - grab.current.dy));
    sx.current.target = px;
    sy.current.target = py;
    setHoverEdge(px < w / 2 ? "left" : "right");
    setLiveY(clampY(py / h));
    loop.current?.kick();
  };

  const commit = (e: Edge, yy: number, kick = 1) => {
    const { w, h } = size();
    const cy = clampY(yy);
    sx.current.target = restX(e, w);
    sy.current.target = cy * h;
    jelly.current.v += 9 * kick;
    setHoverEdge(e);
    setLiveY(cy);
    if (prefersReducedMotion()) {
      settle(sx.current);
      settle(sy.current);
      settle(jelly.current);
      paint();
    } else {
      loop.current?.kick();
    }
    onChange(e, Math.round(cy * 1000) / 1000);
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const { left, top } = size();
    grab.current = {
      dx: ev.clientX - left - sx.current.x,
      dy: ev.clientY - top - sy.current.x,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    draggingRef.current = true;
    setDragging(true);
    jelly.current.v -= 5;
    loop.current?.kick();
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    moveTo(ev.clientX, ev.clientY);
  };
  const onPointerUp = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
    const { w, h } = size();
    commit(sx.current.x < w / 2 ? "left" : "right", sy.current.x / h);
  };

  // Clicking anywhere on the map drops the bead on the nearer wall at that height.
  const onMapPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.target !== ev.currentTarget && !(ev.target as HTMLElement).classList.contains("map-pass")) return;
    const { w, h, left, top } = size();
    commit(ev.clientX - left < w / 2 ? "left" : "right", (ev.clientY - top) / h);
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const step = ev.shiftKey ? 0.1 : 0.02;
    let e = hoverEdge;
    let yy = liveY;
    if (ev.key === "ArrowUp") yy -= step;
    else if (ev.key === "ArrowDown") yy += step;
    else if (ev.key === "ArrowLeft") e = "left";
    else if (ev.key === "ArrowRight") e = "right";
    else return;
    ev.preventDefault();
    commit(e, yy, 0.5);
  };

  const pct = Math.round(liveY * 100);
  const where = pct < 34 ? "upper" : pct > 66 ? "lower" : "middle";

  return (
    <div className="bmap-wrap">
      <div
        ref={mapRef}
        className={`bmap ${dragging ? "dragging" : ""} near-${hoverEdge}`}
        style={{ aspectRatio: String(aspect) }}
        onPointerDown={onMapPointerDown}
      >
        <div className="bmap-wall map-pass" aria-hidden="true" />
        <div className="bmap-menubar map-pass" aria-hidden="true">
          <i />
          <i />
          <i />
          <span />
          <i />
          <i />
        </div>
        <div className="bmap-win w1 map-pass" aria-hidden="true">
          <b />
          <u />
          <u />
          <u />
        </div>
        <div className="bmap-win w2 map-pass" aria-hidden="true">
          <b />
          <u />
          <u />
        </div>
        <div className="bmap-track left" aria-hidden="true" />
        <div className="bmap-track right" aria-hidden="true" />
        <div
          ref={beadRef}
          className="bead"
          role="slider"
          tabIndex={0}
          aria-label="Bubble resting position"
          aria-orientation="vertical"
          aria-valuemin={Math.round(BUBBLE_Y_MIN * 100)}
          aria-valuemax={Math.round(BUBBLE_Y_MAX * 100)}
          aria-valuenow={pct}
          aria-valuetext={`${hoverEdge} edge, ${pct}% down`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <span className="bead-glass" />
        </div>
      </div>
      <div className="bmap-read" aria-live="polite">
        <span className="bmap-read-main">
          {hoverEdge === "left" ? "Left" : "Right"} edge, {where}
        </span>
        <span className="bmap-read-sub">{pct}% down the screen</span>
      </div>
    </div>
  );
}
