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
import { getCurrentWindow, Window as TauriWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { info } from "@tauri-apps/plugin-log";
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
import { LassoTracker, type LassoLoop } from "./lasso";
import { lensState } from "./liquidLens";
import { useSessionMirror } from "../../lib/sessionMirror";

const SMALL = 124;
const R_REST = 34; // idle droplet: 68 pt across, bulging about 42 pt out of the screen edge
const R_LENS = 64;
const R_MAX = 220;
const EDGE_GAP = -26; // negative: the droplet is half-merged into the screen edge (centre 8 pt in)
const EDGE_MARGIN_Y = 24;
const PARK_GAP = 16;
const PARK_MARGIN = 8;
const COMMIT_MS = 1000; // after release
const COMMIT_HELD_MS = 2000; // while the button is still held and the pointer is still
const DRAG_SLOP = 4;
const INPUT_SLOP = 1.5;
const WHEEL_GAIN = 0.0025;
const LENS_DELAY_MS = 40; // let the drag read as a drag before the lens opens

type Edge = "left" | "right";
type Mode = "rest" | "dragging" | "armed" | "parking" | "parked" | "returning";
type WinMode = "small" | "big";
interface Rect { x: number; y: number; w: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const fin = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
/** Next animation frame, with a timeout so a throttled webview can never stall the window queue. */
const nextFrame = () =>
  new Promise<void>((res) => {
    const t = setTimeout(res, 60);
    requestAnimationFrame(() => {
      clearTimeout(t);
      res();
    });
  });
const IDLE_WATCHDOG_MS = 3000;

/** State-change log: console plus the Rust log plugin (only the brain's console is forwarded). */
export function blog(msg: string): void {
  console.info(msg);
  info(`[js] ${msg}`).catch(() => {});
}

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

export function useBubbleMotion(phase: Phase, edge: Edge = "right"): BubbleMotion {
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
    glowK: -1,
    alive: true,
    // lasso (mode C)
    lasso: false,
    tracker: new LassoTracker(),
    loop: null as LassoLoop | null,
    loopAt: 0, // time the latest loop closed
    sentVer: -1,
    sentClosed: false,
    // rest edge
    wantEdge: edge as Edge,
    geomReady: false,
    // real pointer tracking (independent of useBubbleGestures, which can go stale)
    down: null as null | { id: number; x: number; y: number; el: HTMLElement | null },
    shrinkPending: false,
    homeEdge: edge as Edge, // rest edge before the current excursion (cancel returns here)
    modeSince: 0,
    phase: phase as Phase,
    idleSince: 0,
    lastRegion: null as RectPts | null, // last committed target; the card keeps clear of it
  });

  /** State change with one concise log line (forwarded to the dev log). */
  const setMode = useCallback((to: Mode, reason: string) => {
    const s = S.current;
    const from = s.mode;
    s.mode = to;
    s.modeSince = performance.now();
    blog(
      `[bubble] ${from} → ${to} (${reason}) cx=${s.pos.x.toFixed(0)} cy=${s.pos.y.toFixed(0)} r=${s.rad.x.toFixed(0)} target=(${s.tx.toFixed(0)},${s.ty.toFixed(0)}) win=${s.win}${s.lasso ? " lasso" : ""}${s.held ? " held" : ""}`,
    );
  }, []);

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
      // Squash, stretch, glow and shadow are all drawn by the liquid-lens shader now.
      el.style.opacity = s.hidden ? "0" : "1";
      // Docked at an edge, the drop's centre is almost on the edge: CSS nudges the state marks
      // (core, bars) into the visible bulge.
      const dock = s.mode === "rest" || s.mode === "parked" ? (p.x > s.frame.x + s.frame.w / 2 ? "right" : "left") : "";
      if (el.dataset.dock !== dock) el.dataset.dock = dock;
    }
    void th;
    const L = lensState;
    L.cx = fin(p.x, L.cx);
    L.cy = fin(p.y, L.cy);
    L.r = clamp(fin(s.rad.x, R_REST), R_REST * 0.9, R_MAX * 1.05);
    L.tx = s.tx;
    L.ty = s.ty;
    L.fx = s.frame.x;
    L.fy = s.frame.y;
    L.fw = s.frame.w;
    L.fh = s.frame.h;
    L.mode = s.mode;
    L.hidden = s.hidden;
    L.ready = s.geomReady;
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
    } else if (s.held || s.down) {
      // Never shrink under a pressed pointer: the release would land outside the window and the
      // gesture would go stale. Shrink on release instead.
      if (!s.shrinkPending) blog("[bubble] shrink deferred: pointer still down");
      s.shrinkPending = true;
      return;
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

    const desc = (r: Rect) => `${r.x.toFixed(0)},${r.y.toFixed(0)},${r.w.toFixed(0)}x${r.h.toFixed(0)}`;
    blog(`[bubble] win ${s.win} → ${want} at ${desc(next)} (glass cx=${s.pos.x.toFixed(0)} cy=${s.pos.y.toFixed(0)})`);
    if (want === "big") {
      // Grow first with the drop still on screen (the window keeps its top-left corner, so the
      // glass does not move), then hide only for the one native move. The drop stays visible
      // while it peels off the edge.
      try {
        await w.setSize(new LogicalSize(next.w, next.h));
      } catch (e) {
        logErr("setSize", e);
      }
      s.geom = { ...s.geom, w: next.w, h: next.h };
      s.hidden = true;
      render();
      await nextFrame();
    } else {
      // Shrink in ONE native frame change and never hide: until the webview has re-laid out at
      // the small size, the small window only shows the old layout's empty top-left corner, and
      // the new local offset is applied in the same frame the viewport becomes small. No blink.
      let atomic = false;
      try {
        await invoke("bubble_set_frame", { x: next.x, y: next.y, w: next.w, h: next.h });
        atomic = true;
      } catch (e) {
        logErr("bubble_set_frame", e);
      }
      if (atomic) {
        const t0 = performance.now();
        while (window.innerWidth > next.w + 2 && performance.now() - t0 < 300) await nextFrame();
        s.geom = next;
        s.win = want;
        s.hidden = false;
        render();
        blog(
          `[bubble] win now ${want} at ${desc(next)} (atomic, ${(performance.now() - t0).toFixed(0)} ms); glass local=(${(s.pos.x - next.x).toFixed(0)},${(s.pos.y - next.y).toFixed(0)})`,
        );
        return;
      }
      s.hidden = true;
      render();
      await nextFrame();
      await nextFrame();
      try {
        await w.setSize(new LogicalSize(next.w, next.h));
      } catch (e) {
        logErr("setSize", e);
      }
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
    blog(
      `[bubble] win now ${want} at ${desc(next)}; glass local=(${(s.pos.x - next.x).toFixed(0)},${(s.pos.y - next.y).toFixed(0)})`,
    );
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

  const sideOf = useCallback((x: number): Edge => {
    const f = S.current.frame;
    return x > f.x + f.w / 2 ? "right" : "left";
  }, []);

  const edgeTarget = useCallback((force?: Edge) => {
    const s = S.current;
    const f = s.frame;
    const onRight = (force ?? sideOf(s.pos.x)) === "right";
    const x = onRight ? f.x + f.w - EDGE_GAP - R_REST : f.x + EDGE_GAP + R_REST;
    const y = clamp(
      fin(s.pos.y, f.y + f.h / 2),
      f.y + EDGE_MARGIN_Y + R_REST,
      f.y + f.h - EDGE_MARGIN_Y - R_REST,
    );
    return { x, y };
  }, [sideOf]);

  const parkTarget = useCallback((reg: RectPts) => {
    const f = S.current.frame;
    let x = reg.x + reg.w + PARK_GAP + R_REST;
    if (x + R_REST > f.x + f.w - PARK_MARGIN) x = reg.x - PARK_GAP - R_REST;
    x = clamp(x, f.x + PARK_MARGIN + R_REST, f.x + f.w - PARK_MARGIN - R_REST);
    const y = clamp(reg.y + reg.h / 2, f.y + PARK_MARGIN + R_REST, f.y + f.h - PARK_MARGIN - R_REST);
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
    setMode(s.mode === "parking" ? "parked" : "rest", "settled");
    render();
    if (s.mode === "rest") {
      const side = sideOf(s.pos.x);
      s.homeEdge = side;
      if (side !== s.wantEdge) {
        s.wantEdge = side; // optimistic, so a stale snapshot does not bounce it back
        sendIntent({ type: "settings-changed", settings: { bubbleEdge: side } });
      }
    }
    render();
    ensureWindow("small");
    const settledMode = s.mode;
    s.chain = s.chain.then(() => {
      const c = S.current;
      if (c.mode !== settledMode) return;
      return dockCard(c.pos.x, c.pos.y, R_REST, c.frame, logErr, c.lastRegion);
    });
  }, [ensureWindow, render, setMode, sideOf]);

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

  const emitLasso = useCallback(() => {
    const s = S.current;
    // Show the closed loop once the pen pauses or lifts; the live trail while it is moving.
    const showClosed =
      s.loop !== null && (!s.held || performance.now() - s.lastInput > 150 || s.loopAt >= s.lastInput);
    if (showClosed === s.sentClosed && s.tracker.version === s.sentVer) return;
    s.sentClosed = showClosed;
    s.sentVer = s.tracker.version;
    const update =
      showClosed && s.loop
        ? { kind: "lasso" as const, points: s.loop.points, closed: true }
        : { kind: "lasso" as const, points: s.tracker.trail(), closed: false };
    emitEventTo("overlay", EV.targeting, update).catch((e) => logErr("targeting emit", e));
  }, []);

  const resetLasso = useCallback(() => {
    const s = S.current;
    s.lasso = false;
    s.loop = null;
    s.loopAt = 0;
    s.sentVer = -1;
    s.sentClosed = false;
    s.tracker.reset();
  }, []);

  const commit = useCallback(() => {
    const s = S.current;
    if (s.mode !== "dragging" && s.mode !== "armed") return;
    let region: RectPts;
    let mode: "region" | "lasso";
    if (s.lasso) {
      if (!s.loop) return; // lasso mode always has a loop; be defensive
      region = s.loop.bbox;
      mode = "lasso";
    } else {
      const r = clamp(fin(s.rad.x, R_REST), R_REST, R_MAX);
      region = { x: s.pos.x - r, y: s.pos.y - r, w: 2 * r, h: 2 * r };
      mode = "region";
    }
    if (![region.x, region.y, region.w, region.h].every(Number.isFinite)) return;
    sendIntent({ type: "target-commit", mode, region });
    clearLens();
    resetLasso();
    if (s.held) s.suppress = true;
    blog(
      `[bubble] commit ${mode} region=(${region.x.toFixed(0)},${region.y.toFixed(0)},${region.w.toFixed(0)}x${region.h.toFixed(0)})`,
    );
    setMode("parking", s.held ? "commit (held still)" : "commit");
    s.lensAt = 0;
    s.rT = R_REST;
    // Spring to the screen edge AWAY from the target so the glass never covers its explanation.
    const f = s.frame;
    const away: Edge = region.x + region.w / 2 > f.x + f.w / 2 ? "left" : "right";
    const p = edgeTarget(away);
    s.lastRegion = region;
    s.tx = p.x;
    s.ty = clamp(
      fin(region.y + region.h / 2, p.y),
      f.y + EDGE_MARGIN_Y + R_REST,
      f.y + f.h - EDGE_MARGIN_Y - R_REST,
    );
    blog(`[bubble] park at ${away} edge (${s.tx.toFixed(0)},${s.ty.toFixed(0)}), away from the target`);
    void parkTarget;
    startLoop();
  }, [clearLens, edgeTarget, parkTarget, resetLasso, setMode, startLoop]);

  const startReturn = useCallback((force?: Edge, reason = "return") => {
    const s = S.current;
    setMode("returning", force ? `${reason} → ${force} edge` : reason);
    s.lensAt = 0;
    s.rT = R_REST;
    const t = edgeTarget(force);
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
  }, [edgeTarget, ensureWindow, setMode, settle, startLoop]);

  const cancel = useCallback(() => {
    const s = S.current;
    if (s.mode !== "dragging" && s.mode !== "armed") return;
    sendIntent({ type: "cancel" });
    clearLens();
    resetLasso();
    if (s.held) s.suppress = true;
    startReturn(s.homeEdge, "cancel");
  }, [clearLens, resetLasso, startReturn]);

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
      if (s.lasso) emitLasso();
      else emitLens();
      const wait = s.held ? COMMIT_HELD_MS : COMMIT_MS;
      if (!s.suppress && performance.now() - s.lastInput >= wait) commit();
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
      // Only a real pointerdown in this gesture, moved >= 4 pt, may start a drag.
      const d = s.down;
      if (!d || Math.hypot(p.x - d.x, p.y - d.y) < DRAG_SLOP - 0.5) {
        blog(`[bubble] ignored drag start without a live pointerdown at (${p.x.toFixed(0)},${p.y.toFixed(0)})`);
        return;
      }
      const now = performance.now();
      s.held = true;
      s.suppress = false;
      const wasTargeting = s.mode === "dragging" || s.mode === "armed";
      if (s.mode === "rest") s.homeEdge = sideOf(s.pos.x);
      if (!wasTargeting) {
        sendIntent({ type: "target-start" });
        s.rT = R_REST;
        s.lensAt = now + LENS_DELAY_MS;
        resetLasso();
      }
      s.tracker.push(p.x, p.y, now);
      s.tx = p.x;
      s.ty = p.y;
      if (s.mode !== "dragging") setMode("dragging", wasTargeting ? "re-grab" : "drag start");
      s.tx = p.x;
      s.ty = p.y;
      s.lastInput = now;
      s.lastPt = { x: p.x, y: p.y };
      ensureWindow("big");
      startLoop();
    },
    [ensureWindow, resetLasso, setMode, sideOf, startLoop],
  );

  const onDragMove = useCallback((p: { x: number; y: number }) => {
    const s = S.current;
    if (s.suppress || s.mode !== "dragging" || !s.down || !s.held) return;
    if (![p.x, p.y].every(Number.isFinite)) return;
    s.tx = p.x;
    s.ty = p.y;
    const now = performance.now();
    if (Math.hypot(p.x - s.lastPt.x, p.y - s.lastPt.y) >= INPUT_SLOP) {
      s.lastPt = { x: p.x, y: p.y };
      s.lastInput = now;
    }
    s.tracker.push(p.x, p.y, now);
    const loop = s.tracker.detect();
    if (loop) {
      if (!s.lasso) {
        // Became a pen: no lens growth; spring the glass back to 56 pt.
        s.lasso = true;
        s.lensAt = 0;
        s.rT = R_REST;
        blog(`[bubble] lasso detected (${loop.points.length} pts)`);
      }
      s.loop = loop; // latest closed loop wins
      s.loopAt = now;
    }
  }, []);

  const onDragEnd = useCallback(() => {
    const s = S.current;
    const wasHeld = s.held;
    s.held = false;
    s.down = null; // the gesture hook only ends a drag on pointerup / pointercancel
    if (s.suppress) {
      s.suppress = false;
    } else if (s.mode === "dragging") {
      setMode("armed", "released");
    }
    if (wasHeld && s.shrinkPending && !s.down) {
      s.shrinkPending = false;
      if (s.mode === "rest" || s.mode === "parked") ensureWindow("small");
    }
  }, [ensureWindow, setMode]);

  /** The physical pointer is no longer pressed: end everything, including a stale gesture hook. */
  const endPointer = useCallback(
    (reason: string, synthCancel: boolean) => {
      const s = S.current;
      const d = s.down;
      if (!d) return;
      s.down = null;
      if (synthCancel && d.el) {
        // useBubbleGestures keeps its own press state; a lost pointerup would leave it "dragging"
        // and every later hover move would start a new drag. Clear it with a pointercancel.
        try {
          d.el.releasePointerCapture(d.id);
        } catch {
          /* not captured */
        }
        try {
          d.el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: d.id, bubbles: true }));
        } catch {
          /* best effort */
        }
      }
      if (s.held) {
        blog(`[bubble] pointer ended (${reason})`);
        onDragEnd();
      } else if (s.shrinkPending) {
        s.shrinkPending = false;
        if (s.mode === "rest" || s.mode === "parked") ensureWindow("small");
      }
    },
    [ensureWindow, onDragEnd],
  );

  // ───────── listeners: wheel, keys, Rust key events ─────────

  useEffect(() => {
    const s = S.current;
    s.alive = true;

    const onWheel = (e: WheelEvent) => {
      const c = S.current;
      if (c.mode !== "dragging" && c.mode !== "armed") return;
      if (c.lasso) return; // the pen does not resize
      const dy = fin(e.deltaY, 0);
      if (!dy) return;
      // Only scrolls over (or near) the lens resize it; leave the rest alone.
      const gx = c.geom.x + e.clientX;
      const gy = c.geom.y + e.clientY;
      const r = clamp(fin(c.rad.x, R_REST), R_REST, R_MAX);
      if (Math.hypot(gx - c.pos.x, gy - c.pos.y) > 2 * r) return;
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
    const onPDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const el = (e.target as Element | null)?.closest?.(".gt-bubble") as HTMLElement | null;
      if (!el) return;
      S.current.down = { id: e.pointerId, x: e.screenX, y: e.screenY, el };
    };
    const onPMove = (e: PointerEvent) => {
      const d = S.current.down;
      if (d && e.pointerId === d.id && e.buttons === 0) endPointer("move with no buttons", true);
    };
    const onPUp = (e: PointerEvent) => {
      const d = S.current.down;
      if (d && e.pointerId === d.id) endPointer(e.type, false);
    };
    const onLost = (e: PointerEvent) => {
      const d = S.current.down;
      if (!d || e.pointerId !== d.id) return;
      if (e.buttons !== 0 && d.el) {
        // Still physically pressed (e.g. capture dropped by a window resize): take it back.
        try {
          d.el.setPointerCapture(d.id);
          return;
        } catch {
          /* fall through: end the gesture */
        }
      }
      endPointer("lostpointercapture", true);
    };
    window.addEventListener("pointerdown", onPDown, true);
    window.addEventListener("pointermove", onPMove, true);
    window.addEventListener("pointerup", onPUp, true);
    window.addEventListener("pointercancel", onPUp, true);
    window.addEventListener("lostpointercapture", onLost, true);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);

    const unlisten: Array<() => void> = [];
    let disposed = false;
    const track = (p: Promise<() => void>) =>
      p
        .then((u) => (disposed ? u() : unlisten.push(u)))
        .catch((e) => logErr("listen", e));
    track(onEvent(EV.keyReturn, () => commit()));
    // The card can collapse to a pill or grow: keep it beside the drop when its size changes.
    let redock = 0;
    const redockSoon = (ms: number) => {
      window.clearTimeout(redock);
      redock = window.setTimeout(() => {
        const c = S.current;
        if (c.mode !== "rest" && c.mode !== "parked") return;
        c.chain = c.chain
          .then(() => dockCard(c.pos.x, c.pos.y, R_REST, c.frame, logErr, c.lastRegion))
          .catch((e) => logErr("card redock", e));
      }, ms);
    };
    TauriWindow.getByLabel("card")
      .then((card) => {
        if (!card || disposed) return;
        track(card.onResized(() => redockSoon(60)));
      })
      .catch((e) => logErr("card lookup", e));
    // New drawings arrive while the tutor talks: move the card out of their way (debounced).
    let shapeKey = "";
    const unsubShapes = useSessionMirror.subscribe((st) => {
      const sn = st.snapshot;
      const key = `${sn.capture?.capturedAt ?? 0}:${sn.response?.surface ?? ""}:${sn.response?.shapes?.length ?? 0}:${sn.sideNote?.shapes?.length ?? 0}`;
      if (key === shapeKey) return;
      shapeKey = key;
      redockSoon(200);
    });
    unlisten.push(unsubShapes, () => window.clearTimeout(redock));
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
        c.geomReady = true;
        render();
        syncEdgeRef.current();
      } catch (e) {
        logErr("initial geometry", e);
      }
    })();

    return () => {
      disposed = true;
      s.alive = false;
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
      window.removeEventListener("pointerdown", onPDown, true);
      window.removeEventListener("pointermove", onPMove, true);
      window.removeEventListener("pointerup", onPUp, true);
      window.removeEventListener("pointercancel", onPUp, true);
      window.removeEventListener("lostpointercapture", onLost, true);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      unlisten.forEach((u) => u());
    };
  }, [cancel, commit, endPointer, render, startLoop]);

  // ───────── session end → spring home ─────────

  // ───────── rest edge from settings ─────────

  const syncEdgeRef = useRef<() => void>(() => {});
  syncEdgeRef.current = () => {
    const s = S.current;
    if (!s.geomReady || s.mode !== "rest") return;
    if (sideOf(s.pos.x) !== s.wantEdge) startReturn(s.wantEdge, "settings edge");
  };
  useEffect(() => {
    S.current.wantEdge = edge;
    syncEdgeRef.current();
  }, [edge]);

  const prevPhase = useRef<Phase>(phase);
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = phase;
    const s = S.current;
    s.phase = phase;
    if (phase === "idle" && prev !== "idle") {
      s.idleSince = performance.now();
      s.lastRegion = null; // the next session has its own target (or none, for a click)
    }
    if (prev === "idle" || phase !== "idle") return;
    if (s.mode === "returning") return; // already heading home (e.g. our own cancel)
    if (s.mode === "dragging" && s.held && s.down) return; // user is holding it; they decide
    if (s.mode === "dragging") s.held = false; // stale drag: the session ended under it
    if (s.mode === "armed" || s.mode === "dragging") {
      // Targeting was cancelled elsewhere: go back where we came from.
      clearLens();
      resetLasso();
      startReturn(s.homeEdge, `targeting cancelled (${prev} → idle)`);
      return;
    }
    // Natural session end: nearest edge.
    startReturn(undefined, `session ${prev} → idle`);
  }, [phase, clearLens, resetLasso, startReturn]);

  // Watchdog: away from rest, nothing held, and the session idle for 3 s → go home.
  useEffect(() => {
    const id = setInterval(() => {
      const s = S.current;
      if (s.phase !== "idle" || s.held || s.down) return;
      if (s.mode === "rest" || s.mode === "returning") return;
      const since = Math.max(s.idleSince, s.modeSince);
      if (performance.now() - since < IDLE_WATCHDOG_MS) return;
      if (s.mode === "armed" || s.mode === "dragging") {
        clearLens();
        resetLasso();
      }
      startReturn(s.homeEdge, `watchdog: idle ${IDLE_WATCHDOG_MS / 1000}s in ${s.mode}`);
    }, 500);
    return () => clearInterval(id);
  }, [clearLens, resetLasso, startReturn]);

  return {
    wrapRef,
    diameter,
    motion,
    gestures: { onDragStart, onDragMove, onDragEnd },
  };
}
