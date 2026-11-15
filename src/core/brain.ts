import { startBroadcast } from "./broadcast";
import { startController } from "./controller";

let started = false;

/** Starts the session brain in the hidden brain window. Safe to call twice; only the first call runs. */
export async function startBrain(): Promise<void> {
  if (started) return;
  started = true;
  await startBroadcast();
  await startController();
  console.info("[brain] ready");
}
