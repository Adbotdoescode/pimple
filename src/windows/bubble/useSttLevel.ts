import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SttLevel } from "@shared/contracts";

const DECAY_AFTER_MS = 300;
const SMOOTHING = 0.35;

/**
 * Smoothed microphone level (0..1) from the Rust "stt:level" event.
 * Eases toward the latest sample each frame and decays to 0 when events stop.
 * Only listens while `active` is true.
 */
export function useSttLevel(active: boolean): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active) {
      setValue(0);
      return;
    }

    let target = 0;
    let current = 0;
    let shown = 0;
    let lastEventAt = 0;
    let raf = 0;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    const tick = () => {
      if (performance.now() - lastEventAt > DECAY_AFTER_MS) target = 0;
      current += (target - current) * SMOOTHING;
      const next = current < 0.002 ? 0 : current;
      if (next !== shown && (Math.abs(next - shown) > 0.002 || next === 0)) {
        shown = next;
        setValue(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    listen<SttLevel>("stt:level", (e) => {
      const level = Number(e.payload?.level ?? 0);
      target = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
      lastEventAt = performance.now();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* not running inside Tauri (plain browser dev): stay at 0 */
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, [active]);

  return value;
}
