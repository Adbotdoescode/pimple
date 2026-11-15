// Mode B motion: drag the glass, it becomes a lens, wheel resizes it, it commits after 1 s of
// stillness (or Return), parks beside the region, and springs back to the nearest edge when the
// session ends.
//
// State machine:
//   rest ──drag──▶ dragging ──release──▶ armed ──1 s still / Return──▶ parking ──settle──▶ parked
//                     │  ▲                  │                                               │
//                     │  └────re-grab───────┘                                               │
//                     └──1 s held still──▶ (commit, as above)                               │
//   dragging/armed ──Esc──▶ returning ──settle──▶ rest          parked ──phase→idle──▶ returning
//
// Window strategy: per-frame native resizes flicker and per-frame moves lag the DOM, so while the
// bubble is in motion the window is grown ONCE to cover the bubble's whole display and the glass is
// moved purely in CSS (zero native calls per frame). When it settles the window shrinks back to
// 104 × 104 around the circle. Both transitions hide the glass for ~3 frames so the user never sees
// the window jump.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import type { Phase, RectPts, UiIntent } from "@shared/contracts";
import { EV, emitEvent, emitEventTo, invokeCmd, onEvent } from "../../lib/ipc";
import type { BubbleGestureOptions } from "./useBubbleGestures";
import {
  SPRING_DRAG,
  SPRING_PARK,
  SPRING_RADIUS,
  SPRING_RETURN,
  step1,
  step2,
  type Spring1,
  type Spring2,
} from "./spring";
import { dockCard } from "./cardDock";

const SMALL = 104;
const R_REST = 28;
const R_LENS = 64;
const R_MAX = 220;
const EDGE_GAP = 12;
const EDGE_MARGIN_Y = 24;
const PARK_GAP = 16;
const PARK_MARGIN = 8;
const COMMIT_MS = 1000;
const INPUT_SLOP = 1.5;
const WHEEL_GAIN = 0.0025;
const LENS_DELAY_MS = 40; // let the drag read as a drag before the lens opens

type Mode = "rest" | "dragging" | "armed" | "parking" | "parked" | "returning";
type WinMode = "small" | "big";
interface Rect { x: number; y: number; w: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const fin = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
const nextFrame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));

const logged = new Set<string>();
function logErr(tag: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const key = `${tag}:${msg}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.error(`bubble: ${tag} failed:`, msg);
}

function sendIntent(i: UiIntent): void {
  emitEvent(EV.uiIntent, i).catch((e) => logErr("ui:intent emit", e));
}

export interface BubbleMotion {
  /** Attach to the wrapper div around <Bubble>. */
  wrapRef: RefObject<HTMLDivElement>;
  diameter: number;
  motion: number;
  gestures: Partial<Omit<BubbleGestureOptions, "onClick">>;
}

export function useBubbleMotion(phase: Phase): BubbleMotion {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [diameter, setDiameter] = useState(R_REST * 2);
  const [motion, setMotion] = useState(0);

  // All mutable motion state lives in one ref so the rAF loop and event handlers share it.
  const S = useRef({
    mode: "rest" as Mode,
    pos: { x: SMALL / 2, y: SMALL / 2, vx: 0, vy: 0 } as Spring2,
    rad: { x: R_REST, v: 0 } as Spring1,
    tx: SMALL / 2,
    ty: SMALL / 2,
    rT: R_REST,
    lensAt: 0, // time at which rT jumps to R_LENS (0 = none pending)
    frame: {
      x: 0,
      y: 0,
      w: typeof screen !== "undefined" ? screen.width : 1440,
      h: typeof screen !== "undefined" ? screen.height : 900,
    } as RectPts,
    geom: { x: 0, y: 0, w: SMALL, h: SMALL } as Rect,
    win: "small" as WinMode,
    want: "small" as WinMode,
    chain: Promise.resolve() as Promise<void>,
    hidden: false,
    held: false,
    suppress: false, // ignore drag moves until release (after a commit/cancel while held)
    lastInput: 0,
    lastPt: { x: 0, y: 0 },
    lastLens: { cx: NaN, cy: NaN, r: NaN },
    raf: 0,
    lastT: 0,
    dRendered: R_REST * 2,
    kRendered: 0,
    alive: true,
  });

  const win = useRef(getCurrentWindow());

  // ───────── rendering (direct DOM writes; React only for diameter / motion) ─────────

  const render = useCallback(() => {
    const s = S.current;
    const el = wrapRef.current;
    const p = s.pos;
    const speed = Math.hypot(p.vx, p.vy);
    const k = clamp(fin(speed / 2500, 0), 0, 1);
    const th = speed > 1 ? Math.atan2(p.vy, p.vx) : 0;
    if (el) {
      const lx = fin(p.x - s.geom.x, s.geom.w / 2);
      const ly = fin(p.y - s.geom.y, s.geom.h / 2);
      el.style.setProperty("--lx", `${lx.toFixed(2)}px`);
      el.style.setProperty("--ly", `${ly.toFixed(2)}px`);
      el.style.transform =
        k < 0.002
          ? "translateZ(0)"
          : `rotate(${th.toFixed(4)}rad) scale(${(1 + 0.12 * k).toFixed(4)}, ${(1 - 0.1 * k).toFixed(4)}) rotate(${(-th).toFixed(4)}rad)`;
      el.style.opacity = s.hidden ? "0" : "1";
    }
    const d = clamp(fin(s.rad.x, R_REST), R_REST, R_MAX) * 2;
    if (Math.abs(d - s.dRendered) > 0.2) {
      s.dRendered = d;
      setDiameter(d);
    }
    if (Math.abs(k - s.kRendered) > 0.02 || (k === 0 && s.kRendered !== 0)) {
      s.kRendered = k;
      setMotion(k);
    }
  }, []);

  // ───────── window geometry (serialised; never more than one native op in flight) ─────────

  const applyWindow = useCallback(async () => {
    const s = S.current;
    const want = s.want;
    const w = win.current;

    if (want === "big") {
      if (s.win === "big") return;
      // Resync with reality: Rust may have moved the bubble, and we want the display under it.
      try {
        const [pp, sf, disp] = await Promise.all([
          w.outerPosition(),
          w.scaleFactor(),
          invokeCmd("bubble_display"),
        ]);
        const lp = pp.toLogical(sf > 0 ? sf : 1);
        if (Number.isFinite(lp.x) && Number.isFinite(lp.y)) {
          const dx = lp.x - s.geom.x;
          const dy = lp.y - s.geom.y;
          s.pos.x += dx;
          s.pos.y += dy;
          s.tx += dx;
          s.ty += dy;
          s.geom = { ...s.geom, x: lp.x, y: lp.y };
        }
        const f = disp.frame;
        if ([f.x, f.y, f.w, f.h].every(Number.isFinite) && f.w > 0 && f.h > 0) s.frame = f;
      } catch (e) {
        logErr("window resync", e);
      }
      if (S.current.want !== "big") return;
    } else if (s.win === "small") {
      const nx = Math.round(s.pos.x - SMALL / 2);
      const ny = Math.round(s.pos.y - SMALL / 2);
      if (Math.abs(nx - s.geom.x) < 0.5 && Math.abs(ny - s.geom.y) < 0.5) return;
    }

    const f = s.frame;
    const next: Rect =
      want === "big"
        ? { x: f.x, y: f.y, w: f.w, h: f.h }
        : {
            x: Math.round(fin(s.pos.x, f.x + f.w - 40) - SMALL / 2),
            y: Math.round(fin(s.pos.y, f.y + f.h / 2) - SMALL / 2),
            w: SMALL,
            h: SMALL,
          };

    s.hidden = true;
    render();
    await nextFrame();
    await nextFrame();
    try {
      await w.setSize(new LogicalSize(next.w, next.h));
    } catch (e) {
      logErr("setSize", e);
    }
    try {
      await w.setPosition(new LogicalPosition(next.x, next.y));
    } catch (e) {
      logErr("setPosition", e);
    }
    s.geom = next;
    s.win = want;
    render(); // new local offset while still hidden
    await nextFrame();
    s.hidden = false;
    render();
  }, [render]);

  const ensureWindow = useCallback(
    (want: WinMode) => {
      const s = S.current;
      s.want = want;
      s.chain = s.chain.then(applyWindow).catch((e) => logErr("window op", e));
    },
    [applyWindow],
  );

  // ───────── geometry helpers ─────────

  const edgeTarget = useCallback(() => {
    const s = S.current;
    const f = s.frame;
    const onRight = s.pos.x > f.x + f.w / 2;
    const x = onRight ? f.x + f.w - EDGE_GAP - R_REST : f.x + EDGE_GAP + R_REST;
    const y = clamp(
      fin(s.pos.y, f.y + f.h / 2),
      f.y + EDGE_MARGIN_Y + R_REST,
      f.y + f.h - EDGE_MARGIN_Y - R_REST,
    );
    return { x, y };
  }, []);

  const parkTarget = useCallback((cx: number, cy: number, r: number) => {
    const f = S.current.frame;
    let x = cx + r + PARK_GAP + R_REST;
    if (x + R_REST > f.x + f.w - PARK_MARGIN) x = cx - r - PARK_GAP - R_REST;
    x = clamp(x, f.x + PARK_MARGIN + R_REST, f.x + f.w - PARK_MARGIN - R_REST);
    const y = clamp(cy, f.y + PARK_MARGIN + R_REST, f.y + f.h - PARK_MARGIN - R_REST);
    return { x: fin(x, f.x + f.w - 40), y: fin(y, f.y + f.h / 2) };
  }, []);

  // ───────── loop ─────────

  const loopRef = useRef<(t: number) => void>(() => {});

  const startLoop = useCallback(() => {
    const s = S.current;
    if (s.raf || !s.alive) return;
    s.lastT = performance.now();
    s.raf = requestAnimationFrame((t) => loopRef.current(t));
  }, []);

  const settle = useCallback(() => {
    const s = S.current;
    s.pos.x = s.tx;
    s.pos.y = s.ty;
    s.pos.vx = 0;
    s.pos.vy = 0;
    s.rad.x = s.rT;
    s.rad.v = 0;
    s.mode = s.mode === "parking" ? "parked" : "rest";
    render();
    ensureWindow("small");
    const settledMode = s.mode;
    s.chain = s.chain.then(() => {
      const c = S.current;
      if (c.mode !== settledMode) return;
      return dockCard(c.pos.x, c.pos.y, R_REST, c.frame, logErr);
    });
  }, [ensureWindow, render]);

  const emitLens = useCallback(() => {
    const s = S.current;
    const cx = s.pos.x;
    const cy = s.pos.y;
    const r = clamp(fin(s.rad.x, R_REST), R_REST, R_MAX);
    const L = s.lastLens;
    if (Math.abs(cx - L.cx) < 0.05 && Math.abs(cy - L.cy) < 0.05 && Math.abs(r - L.r) < 0.05) return;
    if (![cx, cy, r].every(Number.isFinite)) return;
    s.lastLens = { cx, cy, r };
    emitEventTo("overlay", EV.targeting, { kind: "lens", cx, cy, r }).catch((e) =>
      logErr("targeting emit", e),
    );
  }, []);

  const clearLens = useCallback(() => {
    S.current.lastLens = { cx: NaN, cy: NaN, r: NaN };
    emitEventTo("overlay", EV.targeting, { kind: "clear" }).catch((e) => logErr("targeting emit", e));
  }, []);

  const commit = useCallback(() => {
    const s = S.current;
    if (s.mode !== "dragging" && s.mode !== "armed") return;
    const r = clamp(fin(s.rad.x, R_REST), R_REST, R_MAX);
    const cx = s.pos.x;
    const cy = s.pos.y;
    if (![cx, cy].every(Number.isFinite)) return;
    sendIntent({
      type: "target-commit",
      mode: "region",
      region: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r },
    });
    clearLens();
    if (s.held) s.suppress = true;
    s.mode = "parking";
    s.lensAt = 0;
    s.rT = R_REST;
    const p = parkTarget(cx, cy, r);
    s.tx = p.x;
    s.ty = p.y;
    startLoop();
  }, [clearLens, parkTarget, startLoop]);

  const startReturn = useCallback(() => {
    const s = S.current;
    s.mode = "returning";
    s.lensAt = 0;
    s.rT = R_REST;
    const t = edgeTarget();
    s.tx = t.x;
    s.ty = t.y;
    const near =
      Math.hypot(s.pos.x - t.x, s.pos.y - t.y) < 1 && Math.abs(s.rad.x - R_REST) < 0.5;
    if (near && s.win === "small") {
      settle();
      return;
    }
    ensureWindow("big");
    startLoop();
  }, [edgeTarget, ensureWindow, settle, startLoop]);

  const cancel = useCallback(() => {
    const s = S.current;
    if (s.mode !== "dragging" && s.mode !== "armed") return;
    sendIntent({ type: "cancel" });
    clearLens();
    if (s.held) s.suppress = true;
    startReturn();
  }, [clearLens, startReturn]);

  loopRef.current = (now: number) => {
    const s = S.current;
    s.raf = 0;
    if (!s.alive) return;
    const dt = clamp((now - s.lastT) / 1000, 0, 1 / 30);
    s.lastT = now;

    if (s.lensAt && performance.now() >= s.lensAt) {
      s.lensAt = 0;
      s.rT = Math.max(s.rT, R_LENS);
    }

    const cfg =
      s.mode === "dragging" || s.mode === "armed"
        ? SPRING_DRAG
        : s.mode === "parking"
          ? SPRING_PARK
          : SPRING_RETURN;
    step2(s.pos, s.tx, s.ty, cfg, dt);
    s.rT = clamp(fin(s.rT, R_REST), R_REST, R_MAX);
    step1(s.rad, s.rT, SPRING_RADIUS, dt);
    s.rad.x = clamp(s.rad.x, R_REST * 0.9, R_MAX * 1.05);

    const targeting = s.mode === "dragging" || s.mode === "armed";
    if (targeting) {
      emitLens();
      if (!s.suppress && performance.now() - s.lastInput >= COMMIT_MS) commit();
    } else if (s.mode === "parking" || s.mode === "returning") {
      const still =
        Math.hypot(s.pos.x - s.tx, s.pos.y - s.ty) < 0.4 &&
        Math.hypot(s.pos.vx, s.pos.vy) < 6 &&
        Math.abs(s.rad.x - s.rT) < 0.3 &&
        Math.abs(s.rad.v) < 3;
      if (still) {
        settle();
        return;
      }
    }

    render();
    if (s.mode !== "rest" && s.mode !== "parked") startLoop();
  };

  // ───────── gestures ─────────

  const onDragStart = useCallback(
    (p: { x: number; y: number }) => {
      const s = S.current;
      if (![p.x, p.y].every(Number.isFinite)) return;
      const now = performance.now();
      s.held = true;
      s.suppress = false;
      const wasTargeting = s.mode === "dragging" || s.mode === "armed";
      if (!wasTargeting) {
        sendIntent({ type: "target-start" });
        s.rT = R_REST;
        s.lensAt = now + LENS_DELAY_MS;
      }
      s.mode = "dragging";
      s.tx = p.x;
      s.ty = p.y;
      s.lastInput = now;
      s.lastPt = { x: p.x, y: p.y };
      ensureWindow("big");
      startLoop();
    },
    [ensureWindow, startLoop],
  );

  const onDragMove = useCallback((p: { x: number; y: number }) => {
    const s = S.current;
    if (s.suppress || s.mode !== "dragging") return;
    if (![p.x, p.y].every(Number.isFinite)) return;
    s.tx = p.x;
    s.ty = p.y;
    if (Math.hypot(p.x - s.lastPt.x, p.y - s.lastPt.y) >= INPUT_SLOP) {
      s.lastPt = { x: p.x, y: p.y };
      s.lastInput = performance.now();
    }
  }, []);

  const onDragEnd = useCallback(() => {
    const s = S.current;
    s.held = false;
    if (s.suppress) {
      s.suppress = false;
      return;
    }
    if (s.mode === "dragging") s.mode = "armed";
  }, []);

  // ───────── listeners: wheel, keys, Rust key events ─────────

  useEffect(() => {
    const s = S.current;
    s.alive = true;

    const onWheel = (e: WheelEvent) => {
      const c = S.current;
      if (c.mode !== "dragging" && c.mode !== "armed") return;
      const dy = fin(e.deltaY, 0);
      if (!dy) return;
      e.preventDefault();
      c.lensAt = 0;
      const base = Math.max(c.rT, R_REST);
      c.rT = clamp(fin(base * Math.exp(-dy * WHEEL_GAIN), base), R_REST, R_MAX);
      c.lastInput = performance.now();
      startLoop();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const m = S.current.mode;
        if (m === "dragging" || m === "armed") {
          e.preventDefault();
          commit();
        }
      } else if (e.key === "Escape") {
        cancel();
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);

    const unlisten: Array<() => void> = [];
    let disposed = false;
    const track = (p: Promise<() => void>) =>
      p
        .then((u) => (disposed ? u() : unlisten.push(u)))
        .catch((e) => logErr("listen", e));
    track(onEvent(EV.keyReturn, () => commit()));
    track(onEvent(EV.keyEscape, () => cancel()));

    // Initial geometry: where Rust put us, and which display we are on.
    (async () => {
      try {
        const w = win.current;
        const [pp, sf, disp] = await Promise.all([
          w.outerPosition(),
          w.scaleFactor(),
          invokeCmd("bubble_display"),
        ]);
        if (disposed) return;
        const c = S.current;
        const f = disp.frame;
        if ([f.x, f.y, f.w, f.h].every(Number.isFinite) && f.w > 0 && f.h > 0) c.frame = f;
        if (c.mode !== "rest" || c.win !== "small") return;
        const lp = pp.toLogical(sf > 0 ? sf : 1);
        if (!Number.isFinite(lp.x) || !Number.isFinite(lp.y)) return;
        c.geom = { x: lp.x, y: lp.y, w: SMALL, h: SMALL };
        c.pos = { x: lp.x + SMALL / 2, y: lp.y + SMALL / 2, vx: 0, vy: 0 };
        c.tx = c.pos.x;
        c.ty = c.pos.y;
        render();
      } catch (e) {
        logErr("initial geometry", e);
      }
    })();

    return () => {
      disposed = true;
      s.alive = false;
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      unlisten.forEach((u) => u());
    };
  }, [cancel, commit, render, startLoop]);

  // ───────── session end → spring home ─────────

  const prevPhase = useRef<Phase>(phase);
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = phase;
    if (prev === "idle" || phase !== "idle") return;
    const s = S.current;
    if (s.mode === "dragging") return; // user is holding it; they decide
    if (s.mode === "armed") clearLens();
    startReturn();
  }, [phase, clearLens, startReturn]);

  return {
    wrapRef,
    diameter,
    motion,
    gestures: { onDragStart, onDragMove, onDragEnd },
  };
}
