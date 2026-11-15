// Hidden brain window: runs the session controller (Domain 2). Renders nothing visible.
import { useEffect } from "react";
import { info, warn, error } from "@tauri-apps/plugin-log";
import { startBrain } from "@/core/brain";

// Never hot-patch the brain: a partial HMR re-run would stack duplicate listeners. Reload the window instead.
if (import.meta.hot) {
  // Let Vite finish writing the update first, then reload the whole window.
  import.meta.hot.on("vite:beforeUpdate", () => setTimeout(() => location.reload(), 400));
  import.meta.hot.on("vite:error", () => setTimeout(() => location.reload(), 1500));
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
