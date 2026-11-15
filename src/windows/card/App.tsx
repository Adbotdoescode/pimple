import { useCallback, useEffect, useRef } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Phase, UiIntent } from "@shared/contracts";
import { EV, emitEvent, invokeCmd } from "../../lib/ipc";
import { useSession } from "../../lib/sessionMirror";
import { Card } from "./Card";

const CARD_WIDTH = 380;
const MIN_H = 120;
const MAX_H = 640;
const MIN_DELTA_PX = 2;

/** Phases in which the card should be on screen. Never shown during capturing or targeting. */
const SHOW_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "summarising",
  "listening",
  "thinking",
  "verifying",
  "speaking",
  "interrupted",
  "checking",
]);
const HIDE_DELAY_MS = 8000;

function logErr(what: string, e: unknown): void {
  console.error(`card: ${what} failed`, e instanceof Error ? e.message : e);
}

export default function App() {
  const snapshot = useSession((s) => s);
  const phase: Phase = snapshot?.phase ?? "idle";
  const hasError = !!snapshot?.error;

  const send = useCallback((i: UiIntent): void => {
    emitEvent(EV.uiIntent, i).catch((e) =>
      console.error("card: ui:intent emit failed", e instanceof Error ? e.message : e),
    );
  }, []);

  // Resize the card window to fit its content. Coalesced to one update per animation frame,
  // and skipped unless the height moved by at least MIN_DELTA_PX.
  const lastH = useRef<number | null>(null);
  const pendingH = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  const onHeightChange = useCallback((h: number) => {
    pendingH.current = h;
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const target = pendingH.current;
      if (target === null || !Number.isFinite(target)) return;
      const next = Math.round(Math.min(Math.max(target, MIN_H), MAX_H));
      if (lastH.current !== null && Math.abs(next - lastH.current) < MIN_DELTA_PX) return;
      lastH.current = next;
      try {
        getCurrentWindow()
          .setSize(new LogicalSize(CARD_WIDTH, next))
          .catch((e) =>
            console.error("card: resize failed", e instanceof Error ? e.message : e),
          );
      } catch (e) {
        console.error("card: resize failed", e instanceof Error ? e.message : e);
      }
    });
  }, []);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    },
    [],
  );

  // Show / hide the card window. Calls happen only on transitions, tracked by visibleRef.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const visibleRef = useRef(false);
  const typingRef = useRef(false);
  const hideTimer = useRef<number | null>(null);

  const clearHide = useCallback((): void => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showCard = useCallback((): void => {
    if (visibleRef.current) return;
    visibleRef.current = true;
    try {
      invokeCmd("show_window", { label: "card" }).catch((e) => logErr("show_window", e));
    } catch (e) {
      logErr("show_window", e);
    }
  }, []);

  const hideSoon = useCallback((): void => {
    if (!visibleRef.current || hideTimer.current !== null) return;
    if (typingRef.current || phaseRef.current !== "idle") return;
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      if (!visibleRef.current || typingRef.current || phaseRef.current !== "idle") return;
      visibleRef.current = false;
      try {
        invokeCmd("hide_window", { label: "card" }).catch((e) => logErr("hide_window", e));
      } catch (e) {
        logErr("hide_window", e);
      }
    }, HIDE_DELAY_MS);
  }, []);

  useEffect(() => {
    if (phase === "capturing" || phase === "targeting") {
      // Hide at once so the old card does not cover the screen being aimed at.
      // The next show-phase calls show again.
      clearHide();
      if (visibleRef.current) {
        visibleRef.current = false;
        try {
          invokeCmd("hide_window", { label: "card" }).catch((e) => logErr("hide_window", e));
        } catch (e) {
          logErr("hide_window", e);
        }
      }
      return;
    }
    if (SHOW_PHASES.has(phase) || (phase === "idle" && hasError)) showCard();
    if (phase === "idle") hideSoon();
    else clearHide();
  }, [phase, hasError, clearHide, showCard, hideSoon]);

  useEffect(() => clearHide, [clearHide]);

  // Typing in the card keeps it open: cancel the pending hide, and reschedule once it stops.
  const onTypingChange = useCallback(
    (typing: boolean): void => {
      typingRef.current = typing;
      if (typing) clearHide();
      else hideSoon();
    },
    [clearHide, hideSoon],
  );

  return (
    <div className="card-native">
      <Card
        snapshot={snapshot}
        onIntent={send}
        onHeightChange={onHeightChange}
        onTypingChange={onTypingChange}
      />
    </div>
  );
}
