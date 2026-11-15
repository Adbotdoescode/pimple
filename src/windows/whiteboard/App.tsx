import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { CaptureResult, Segment, Shape, TutorResponse } from "@shared/contracts";
import { Whiteboard, visibleSegmentsFor, type Backdrop } from "./Whiteboard";
import { useSession } from "@/lib/sessionMirror";
import { CMD, EV, emitEvent, invokeCmd } from "@/lib/ipc";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

/** One answer as drawn: kept after the session moves on so the board can stay dimmed. */
interface Drawing {
  response: TutorResponse;
  backdrop: Backdrop | null;
  sourceLabel: string | null;
  sideNote: { segments: Segment[]; shapes: Shape[] } | null;
}

/**
 * Auto-open placement: width min(1200, 62% of the monitor), height width × 0.66 (min 560), vertically
 * centred on the side away from the bubble. Never focuses the window; failures are ignored.
 */
async function placeAwayFromBubble(bubbleEdge: "left" | "right"): Promise<void> {
  try {
    const monitor = await currentMonitor();
    if (!monitor) return;
    const sf = monitor.scaleFactor || 1;
    const mx = monitor.position.x / sf;
    const my = monitor.position.y / sf;
    const mw = monitor.size.width / sf;
    const mh = monitor.size.height / sf;
    const width = Math.min(1200, 0.62 * mw);
    const height = Math.max(560, width * 0.66);
    const x = bubbleEdge === "right" ? mx + 24 : mx + mw - width - 24;
    const y = my + (mh - height) / 2;
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(width, height));
    await win.setPosition(new LogicalPosition(x, y));
  } catch (err) {
    console.warn("whiteboard placement failed", err);
  }
}

/** Overlay answers are in captured-image pixels, so they need the screenshot under them. */
function backdropFor(response: TutorResponse, capture: CaptureResult | null): Backdrop | null {
  if (response.surface !== "overlay" || !capture) return null;
  return { src: convertFileSrc(capture.imagePath), w: capture.imageWidth, h: capture.imageHeight };
}

export default function App() {
  const snap = useSession((s) => s);
  const brainTheme = snap.settings.whiteboardTheme;

  // Optimistic local theme so the toggle flips at once; re-synced whenever the brain echoes a change.
  const [theme, setTheme] = useState<"light" | "dark">(brainTheme);
  useEffect(() => {
    setTheme(brainTheme);
  }, [brainTheme]);

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
      const edge = snap.settings.bubbleEdge;
      void (async () => {
        await placeAwayFromBubble(edge);
        await invokeCmd(CMD.showWindow, { label: "whiteboard" }).catch(() => undefined);
      })();
    } else if (resp.surface === "overlay") {
      void invokeCmd(CMD.hideWindow, { label: "whiteboard" });
    }
  }, [snap.response]);

  // The current session's drawing, or null when the snapshot has no response.
  const live = useMemo<Drawing | null>(
    () =>
      snap.response
        ? {
            response: snap.response,
            backdrop: backdropFor(snap.response, snap.capture),
            sourceLabel: snap.sourceLabel,
            sideNote: snap.sideNote,
          }
        : null,
    [snap.response, snap.capture, snap.sourceLabel, snap.sideNote],
  );

  // Keep the last drawing: a new session dims it rather than blanking the board.
  const [kept, setKept] = useState<Drawing | null>(null);
  useEffect(() => {
    if (live) setKept(live);
  }, [live]);

  const shown = live ?? kept;
  const pending = live === null && kept !== null && snap.phase !== "idle";
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

  const onClose = () => {
    void invokeCmd(CMD.hideWindow, { label: "whiteboard" });
  };

  return (
    <Whiteboard
      response={shown?.response ?? null}
      backdrop={shown?.backdrop ?? null}
      pending={pending}
      visibleSegmentIds={visibleIds}
      currentSegmentId={live ? snap.currentSegmentId : null}
      pulseShapeIds={live ? snap.pulseShapeIds : []}
      sideNote={shown?.sideNote ?? null}
      theme={theme}
      caption={live ? snap.caption : ""}
      phase={snap.phase}
      sourceLabel={shown?.sourceLabel ?? null}
      onToggleTheme={onToggleTheme}
      onClose={onClose}
    />
  );
}
