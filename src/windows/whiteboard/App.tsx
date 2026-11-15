import { useEffect, useMemo, useRef, useState } from "react";
import type { Segment, Shape, TutorResponse } from "@shared/contracts";
import { Whiteboard, visibleSegmentsFor } from "./Whiteboard";
import { useSession } from "@/lib/sessionMirror";
import { CMD, EV, emitEvent, invokeCmd } from "@/lib/ipc";
import { Effect, EffectState, Window as TauriWindow, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

/** One answer as drawn: kept after the session moves on so the board can stay dimmed. */
interface Drawing {
  response: TutorResponse;
  sourceLabel: string | null;
  sideNote: { segments: Segment[]; shapes: Shape[] } | null;
}

/** Where the sheet's opening animation starts from, in window px (the bubble's side). */
export interface Origin { x: string; y: string }

/** Native vibrancy material under the sheet, per board theme. */
const MATERIAL = { light: Effect.FullScreenUI, dark: Effect.HudWindow } as const;

const BUBBLE_GAP = 96;   // room kept for the droplet at its edge
const CARD_COL = 392;    // the card docks beside the droplet (380 wide + gap): the sheet starts past it
const SCREEN_PAD = 28;
const CLOSE_MS = 190;

/** Centre of the bubble window in screen points, or null when it cannot be read. */
async function bubbleCentre(sf: number): Promise<{ x: number; y: number } | null> {
  try {
    const bubble = await TauriWindow.getByLabel("bubble");
    if (!bubble) return null;
    const [pos, size] = await Promise.all([bubble.outerPosition(), bubble.outerSize()]);
    return { x: (pos.x + size.width / 2) / sf, y: (pos.y + size.height / 2) / sf };
  } catch {
    return null;
  }
}

/**
 * The sheet grows out of the droplet: it sits beside the bubble (past the card's column), centred on
 * the bubble's height (clamped to the display), about two thirds of the display wide. Returns the animation origin.
 * Never focuses the window; failures are ignored.
 */
async function placeBesideBubble(settingEdge: "left" | "right", settingY: number): Promise<Origin | null> {
  try {
    const monitor = await currentMonitor();
    if (!monitor) return null;
    const sf = monitor.scaleFactor || 1;
    const mx = monitor.position.x / sf;
    const my = monitor.position.y / sf;
    const mw = monitor.size.width / sf;
    const mh = monitor.size.height / sf;
    const c = await bubbleCentre(sf);
    const inside = c !== null && c.x >= mx && c.x <= mx + mw && c.y >= my && c.y <= my + mh;
    const edge = inside ? (c.x > mx + mw / 2 ? "right" : "left") : settingEdge;
    const cy = inside ? c.y : my + mh * (Number.isFinite(settingY) ? settingY : 0.5);
    // On a roomy display the card keeps its column beside the droplet, so its Stop / Interrupt /
    // check-question controls are never under the sheet; on a small one the sheet takes the space.
    const side = BUBBLE_GAP + (mw >= 1360 ? CARD_COL : 0);
    const width = Math.round(Math.max(680, Math.min(1180, 0.68 * mw, mw - side - SCREEN_PAD)));
    const height = Math.round(Math.max(460, Math.min(770, 0.72 * mh, mh - 2 * SCREEN_PAD - 20)));
    const x = Math.round(edge === "right" ? mx + mw - side - width : mx + side);
    const y = Math.round(Math.max(my + SCREEN_PAD + 20, Math.min(my + mh - SCREEN_PAD - height, cy - height / 2)));
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(width, height));
    await win.setPosition(new LogicalPosition(x, y));
    return {
      x: edge === "right" ? "calc(100% + 56px)" : "-56px",
      y: `${Math.round(Math.max(0, Math.min(height, cy - y)))}px`,
    };
  } catch (err) {
    console.warn("whiteboard placement failed", err);
    return null;
  }
}

/** Tell the card dock where the sheet is, so the card can keep off it. Screen points. */
async function announceRect(visible: boolean): Promise<void> {
  try {
    const win = getCurrentWindow();
    const sf = await win.scaleFactor();
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    await emit("whiteboard:rect", {
      x: pos.x / sf, y: pos.y / sf, w: size.width / sf, h: size.height / sf, visible,
    });
  } catch {
    /* best effort */
  }
}

export default function App() {
  const snap = useSession((s) => s);
  const brainTheme = snap.settings.whiteboardTheme;

  // Optimistic local theme so the toggle flips at once; re-synced whenever the brain echoes a change.
  const [theme, setTheme] = useState<"light" | "dark">(brainTheme);
  useEffect(() => {
    setTheme(brainTheme);
  }, [brainTheme]);

  // Frameless glass sheet (transparent window) or the old titled window: style accordingly.
  const [frameless, setFrameless] = useState(false);
  useEffect(() => {
    getCurrentWindow().isDecorated().then((d) => setFrameless(!d), () => undefined);
  }, []);

  // The native blur under the sheet follows the board theme: a clear light pane or a dark HUD pane.
  useEffect(() => {
    if (!frameless) return;
    getCurrentWindow()
      .setEffects({ effects: [MATERIAL[theme]], state: EffectState.Active, radius: 30 })
      .catch((err) => console.warn("whiteboard material failed", err));
  }, [frameless, theme]);

  // Sheet state. `openSeq` restarts the opening spring; `closing` plays the exit before the hide.
  const [openSeq, setOpenSeq] = useState(0);
  const [closing, setClosing] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const lastOpenAt = useRef(0);
  const playOpen = () => {
    const now = Date.now();
    setClosing(false);
    if (now - lastOpenAt.current < 1200) return; // brain and window both show it: one spring only
    lastOpenAt.current = now;
    setOpenSeq((n) => n + 1);
  };

  // Park the hidden window beside the bubble ahead of time, so whoever shows it (the brain, the tray,
  // this window) finds it already in place. A visible window is left where the student put it.
  const edge = snap.settings.bubbleEdge;
  const bubbleY = snap.settings.bubbleY;
  const sessionLive = snap.phase !== "idle";
  const place = async (): Promise<void> => {
    const win = getCurrentWindow();
    if (await win.isVisible().catch(() => false)) return;
    const o = await placeBesideBubble(edge, bubbleY);
    if (o) setOrigin(o);
  };
  useEffect(() => {
    void place();
  }, [edge, bubbleY, sessionLive]);

  // Any show (brain, tray, here) focuses the window: play the spring and report the rect.
  useEffect(() => {
    const win = getCurrentWindow();
    // The frame animates while the sheet grows: report it once it has settled, not every frame.
    let timer: number | null = null;
    const later = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void win.isVisible().then((v) => announceRect(v), () => undefined);
      }, 140);
    };
    const subs = [
      win.onFocusChanged(({ payload }) => {
        if (!payload) return;
        playOpen();
        void announceRect(true);
      }),
      win.onMoved(() => later()),
      win.onResized(() => later()),
    ];
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      for (const sub of subs) void sub.then((off) => off());
    };
  }, []);

  // Auto-open: show the window once for each new whiteboard answer. The first value seen at mount is a
  // baseline, so an answer that already exists when the window loads does not pop it open.
  const seenKey = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const resp = snap.response;
    const first = resp?.segments[0];
    const key = resp && first ? `${resp.surface}|${resp.concept}|${first.id}|${first.text}` : null;
    if (seenKey.current === undefined) seenKey.current = key; // baseline on mount
    if (!resp) {
      seenKey.current = null; // a new session's answer always counts as new
      return;
    }
    if (!first) return; // wait until the first segment exists so the key is stable
    if (key === seenKey.current) return;
    seenKey.current = key;
    if (resp.surface === "whiteboard") {
      void (async () => {
        await place();
        playOpen();
        await invokeCmd(CMD.showWindow, { label: "whiteboard" }).catch(() => undefined);
        void announceRect(true);
      })();
    }
  }, [snap.response]);

  // An overlay answer that draws on the screen takes over: the sheet steps aside. Spoken-only turns
  // (check feedback, a short follow-up with no shapes) leave the drawing up.
  const hidFor = useRef<string | null>(null);
  useEffect(() => {
    const resp = snap.response;
    if (!resp || resp.surface !== "overlay" || resp.shapes.length === 0) return;
    const first = resp.segments[0];
    const key = `${resp.concept}|${first?.id ?? ""}|${first?.text ?? ""}`;
    if (hidFor.current === key) return;
    hidFor.current = key;
    void invokeCmd(CMD.hideWindow, { label: "whiteboard" });
    void announceRect(false);
  }, [snap.response]);

  // Only whiteboard answers are drawn here, from scratch in board space. An overlay answer is in
  // screenshot pixels and belongs to the overlay: the board keeps its last drawing and never shows the capture.
  const boardResponse = snap.response?.surface === "whiteboard" ? snap.response : null;
  const live = useMemo<Drawing | null>(
    () =>
      boardResponse
        ? { response: boardResponse, sourceLabel: snap.sourceLabel, sideNote: snap.sideNote }
        : null,
    [boardResponse, snap.sourceLabel, snap.sideNote],
  );

  // Keep the last drawing: a new session dims it rather than blanking the board, and a spoken-only
  // turn is captioned over the drawing that is already up.
  const [kept, setKept] = useState<Drawing | null>(null);
  useEffect(() => {
    if (live) setKept(live);
  }, [live]);

  const shown = live ?? kept;
  const pending = snap.response === null && kept !== null && snap.phase !== "idle";
  const visibleIds = live
    ? visibleSegmentsFor(snap)
    : kept
      ? kept.response.segments.map((seg) => seg.id)
      : [];

  const onToggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    void emitEvent(EV.uiIntent, { type: "settings-changed", settings: { whiteboardTheme: next } });
  };

  // Close: the sheet slips back toward the bubble, then the window hides.
  const onClose = () => {
    setClosing(true);
    lastOpenAt.current = 0;
    window.setTimeout(() => {
      void invokeCmd(CMD.hideWindow, { label: "whiteboard" });
      void announceRect(false);
    }, CLOSE_MS);
  };

  return (
    <Whiteboard
      response={shown?.response ?? null}
      pending={pending}
      visibleSegmentIds={visibleIds}
      currentSegmentId={live ? snap.currentSegmentId : null}
      pulseShapeIds={live ? snap.pulseShapeIds : []}
      sideNote={shown?.sideNote ?? null}
      theme={theme}
      caption={snap.response ? snap.caption : ""}
      phase={snap.phase}
      sourceLabel={shown?.sourceLabel ?? null}
      onToggleTheme={onToggleTheme}
      onClose={onClose}
      frameless={frameless}
      openSeq={openSeq}
      closing={closing}
      origin={origin}
    />
  );
}
