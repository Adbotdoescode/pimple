import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";

export interface BubblePoint {
  x: number;
  y: number;
}

export interface BubbleDragMove extends BubblePoint {
  /** px per ms, smoothed */
  vx: number;
  /** px per ms, smoothed */
  vy: number;
}

export interface BubbleGestureOptions {
  onClick: () => void;
  onDragStart?: (p: BubblePoint) => void;
  onDragMove?: (p: BubbleDragMove) => void;
  onDragEnd?: (p: BubblePoint) => void;
  onWheel?: (deltaY: number) => void;
}

export interface BubbleGestureProps {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onWheel: (e: ReactWheelEvent<HTMLElement>) => void;
}

const SLOP_PX = 4;
const CLICK_MAX_MS = 250;
const VELOCITY_WEIGHT = 0.5;

interface Press {
  id: number;
  startX: number;
  startY: number;
  startT: number;
  lastX: number;
  lastY: number;
  lastT: number;
  vx: number;
  vy: number;
  dragging: boolean;
}

/**
 * Click vs drag on the bubble. Positions are screen coordinates (screenX/Y).
 * A click is under 4 px of travel and under 250 ms. Past 4 px it becomes a drag.
 * A long press without movement does nothing.
 */
export function useBubbleGestures(opts: BubbleGestureOptions): BubbleGestureProps {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const pressRef = useRef<Press | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    const now = performance.now();
    pressRef.current = {
      id: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      startT: now,
      lastX: e.screenX,
      lastY: e.screenY,
      lastT: now,
      vx: 0,
      vy: 0,
      dragging: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    const x = e.screenX;
    const y = e.screenY;
    const now = performance.now();
    const dt = Math.max(1, now - p.lastT);
    p.vx = p.vx * (1 - VELOCITY_WEIGHT) + ((x - p.lastX) / dt) * VELOCITY_WEIGHT;
    p.vy = p.vy * (1 - VELOCITY_WEIGHT) + ((y - p.lastY) / dt) * VELOCITY_WEIGHT;
    p.lastX = x;
    p.lastY = y;
    p.lastT = now;

    if (!p.dragging) {
      if (Math.hypot(x - p.startX, y - p.startY) < SLOP_PX) return;
      p.dragging = true;
      optsRef.current.onDragStart?.({ x, y });
    }
    optsRef.current.onDragMove?.({ x, y, vx: p.vx, vy: p.vy });
  };

  const release = (e: ReactPointerEvent<HTMLElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    pressRef.current = null;
    release(e);

    const x = e.screenX;
    const y = e.screenY;
    if (p.dragging) {
      optsRef.current.onDragEnd?.({ x, y });
      return;
    }
    const held = performance.now() - p.startT;
    const moved = Math.hypot(x - p.startX, y - p.startY);
    if (moved < SLOP_PX && held < CLICK_MAX_MS) {
      optsRef.current.onClick();
    }
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const p = pressRef.current;
    if (!p || p.id !== e.pointerId) return;
    pressRef.current = null;
    if (p.dragging) optsRef.current.onDragEnd?.({ x: p.lastX, y: p.lastY });
  };

  const onWheel = (e: ReactWheelEvent<HTMLElement>) => {
    optsRef.current.onWheel?.(e.deltaY);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onWheel };
}
