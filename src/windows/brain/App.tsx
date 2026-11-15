// Hidden brain window: runs the session controller (Domain 2). Renders nothing visible.
import { useEffect } from "react";
import { info, warn, error } from "@tauri-apps/plugin-log";
import { startBrain } from "@/core/brain";
import { getSnapshot } from "@/core/store";

// Never hot-patch the brain mid-session: a partial HMR re-run would stack duplicate listeners, and a
// reload mid-answer kills the live turn. Only updates to brain modules (src/core, src/windows/brain,
// shared) or a Vite error schedule a reload, and the reload waits until the session is idle.
// Until then the already-running controller keeps working (startBrain is guarded against re-runs).
const BRAIN_PATH = /\/(src\/core|src\/windows\/brain|shared)\//;
// Module instances re-run on HMR; keep the FIRST instance's phase getter (the live store) and flag globally.
const gr = globalThis as unknown as { __gtPhase?: () => string; __gtReloadPending?: boolean };
gr.__gtPhase ??= () => getSnapshot().phase;
function scheduleReload(why: string) {
  if (gr.__gtReloadPending) return;
  gr.__gtReloadPending = true;
  console.info(`[brain] reload scheduled (${why}); waiting for idle`);
  const tick = () => {
    if (gr.__gtPhase?.() === "idle") location.reload();
    else setTimeout(tick, 500);
  };
  setTimeout(tick, 400);
}
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", (p: { updates: { path: string; acceptedPath: string }[] }) => {
    const hit = p.updates.find((u) => BRAIN_PATH.test(u.path) || BRAIN_PATH.test(u.acceptedPath));
    if (hit) scheduleReload(hit.path);
  });
  import.meta.hot.on("vite:error", () => scheduleReload("vite error"));
}

// The brain window is hidden, so mirror its console into the Rust log (/tmp/glass-tutor-dev.log).
const gw = globalThis as unknown as { __gtConsoleForwarded?: boolean };
function forwardConsole() {
  if (gw.__gtConsoleForwarded) return;
  gw.__gtConsoleForwarded = true;
  const fmt = (args: unknown[]) =>
    "[js] " +
    args
      .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : safeJson(a)))
      .join(" ");
  const wrap = (orig: (...a: unknown[]) => void, sink: (m: string) => Promise<void>) =>
    (...args: unknown[]) => {
      orig(...args);
      sink(fmt(args)).catch(() => {});
    };
  console.info = wrap(console.info.bind(console), info);
  console.log = wrap(console.log.bind(console), info);
  console.warn = wrap(console.warn.bind(console), warn);
  console.error = wrap(console.error.bind(console), error);
  window.addEventListener("unhandledrejection", (e) => console.error("unhandledrejection", e.reason));
  window.addEventListener("error", (e) => console.error("window.error", e.message));
}
function safeJson(a: unknown): string {
  try {
    const s = JSON.stringify(a);
    return s && s.length > 400 ? s.slice(0, 400) + "…" : String(s);
  } catch {
    return String(a);
  }
}

export default function App() {
  useEffect(() => {
    forwardConsole();
    startBrain().catch((e) => console.error("[brain] start failed", e));
  }, []);
  return <div data-label="brain">brain</div>;
}
