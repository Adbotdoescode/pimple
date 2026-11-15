import { useCallback, useEffect, useRef } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UiIntent } from "@shared/contracts";
import { EV, emitEvent } from "../../lib/ipc";
import { useSession } from "../../lib/sessionMirror";
import { Card } from "./Card";

const CARD_WIDTH = 380;
const MIN_H = 120;
const MAX_H = 640;
const MIN_DELTA_PX = 2;

export default function App() {
  const snapshot = useSession((s) => s);

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

  return <Card snapshot={snapshot} onIntent={send} onHeightChange={onHeightChange} />;
}
