import { startBroadcast } from "./broadcast";
import { startController } from "./controller";
import { loadSettings } from "./settingsStore";
import { sessionStore } from "./store";

// HMR would re-run this module and stack a second set of listeners (duplicate Claude calls and speech).
// The brain window reloads itself on any hot update (see src/windows/brain/App.tsx); this guard is a backstop.
const g = globalThis as unknown as { __gtBrainStarted?: boolean };

/** Starts the session brain in the hidden brain window. Safe to call twice; only the first call runs. */
export async function startBrain(): Promise<void> {
  if (g.__gtBrainStarted) return;
  g.__gtBrainStarted = true;
  // Persisted settings go in before the first broadcast, so every window's first snapshot has them.
  sessionStore.getState().patch({ settings: await loadSettings() });
  await startBroadcast();
  await startController();
  console.info("[brain] ready");
}
