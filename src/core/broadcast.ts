import { emit, listen } from "@tauri-apps/api/event";
import { EV } from "../../shared/contracts";
import { getSnapshot, sessionStore } from "./store";

const MIN_INTERVAL_MS = 33;

let lastEmitAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function emitNow(): void {
  lastEmitAt = Date.now();
  emit(EV.sessionState, getSnapshot()).catch((err) => console.warn("[brain] session emit failed", err));
}

/**
 * Trailing throttle: at most one emit per MIN_INTERVAL_MS, and the last change always gets an emit.
 * setTimeout, not requestAnimationFrame, because the brain window is hidden and rAF does not run there.
 */
function scheduleEmit(): void {
  if (timer !== null) return;
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastEmitAt));
  timer = setTimeout(() => {
    timer = null;
    emitNow();
  }, wait);
}

/** Starts mirroring the store to every window. Returns a cleanup function. */
export async function startBroadcast(): Promise<() => void> {
  const unsubscribe = sessionStore.subscribe(scheduleEmit);
  // Late-opening windows ask for the current state; answer right away.
  const unlisten = await listen("session:request", () => emitNow());
  emitNow();
  return () => {
    unsubscribe();
    unlisten();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
