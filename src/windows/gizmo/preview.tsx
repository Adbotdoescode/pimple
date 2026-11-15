// Dev-only harness: open http://localhost:1420/src/windows/gizmo/preview.html
// Params: state=ready|building|failed|none (default ready), title=<concept>.
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@/ui/glass.css";
import { GizmoView, type GizmoStatus } from "./App";

const DEFAULT_TITLE = "Sun's power spread over a growing bubble";
const STATES: readonly GizmoStatus[] = ["ready", "building", "failed", "none"];

function Preview() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("state") ?? "ready";
  const status: GizmoStatus = (STATES as readonly string[]).includes(requested)
    ? (requested as GizmoStatus)
    : "ready";
  const concept = params.get("title") ?? DEFAULT_TITLE;

  const [template, setTemplate] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/gizmos/template.html")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (alive) setTemplate(text);
      })
      .catch((err) => console.error("gizmo preview: template fetch failed", err));
    return () => {
      alive = false;
    };
  }, []);

  const html = status === "ready" ? template : null;
  return <GizmoView html={html} status={status} concept={concept} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
