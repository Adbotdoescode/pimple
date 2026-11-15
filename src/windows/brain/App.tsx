// Hidden brain window: runs the session controller (Domain 2). Renders nothing visible.
import { useEffect } from "react";
import { info, warn, error } from "@tauri-apps/plugin-log";
import { startBrain } from "@/core/brain";

// The brain window is hidden, so mirror its console into the Rust log (/tmp/glass-tutor-dev.log).
let forwarded = false;
function forwardConsole() {
  if (forwarded) return;
  forwarded = true;
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
