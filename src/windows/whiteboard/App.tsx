import { useEffect, useRef, useState } from "react";
import { Whiteboard, visibleSegmentsFor } from "./Whiteboard";
import { useSession } from "@/lib/sessionMirror";
import { CMD, EV, emitEvent, invokeCmd } from "@/lib/ipc";

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
    const key = resp && first ? `${resp.concept}|${first.id}` : null;
    if (seenKey.current === undefined) seenKey.current = key; // baseline on mount
    if (!resp || !first) return; // wait until the first segment exists so the key is stable
    if (key === seenKey.current) return;
    seenKey.current = key;
    if (resp.surface === "whiteboard") {
      void invokeCmd(CMD.showWindow, { label: "whiteboard" });
    }
  }, [snap.response]);

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
      response={snap.response}
      visibleSegmentIds={visibleSegmentsFor(snap)}
      currentSegmentId={snap.currentSegmentId}
      pulseShapeIds={snap.pulseShapeIds}
      sideNote={snap.sideNote}
      theme={theme}
      caption={snap.caption}
      phase={snap.phase}
      sourceLabel={snap.sourceLabel}
      onToggleTheme={onToggleTheme}
      onClose={onClose}
    />
  );
}
