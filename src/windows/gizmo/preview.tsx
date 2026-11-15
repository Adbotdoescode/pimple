// Dev-only harness: open http://localhost:1420/src/windows/gizmo/preview.html
// Params: state=ready|building|failed|none (default ready), title=<concept>,
// assembled=1 (run the template's last <script> through assembleGizmoHtml),
// broken=1 with assembled=1 (appends an undefined call to prove the error card).
import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "@/ui/glass.css";
import { assembleGizmoHtml } from "@/core/gizmo";
import { GizmoView, type GizmoStatus } from "./App";

const DEFAULT_TITLE = "Sun's power spread over a growing bubble";
const STATES: readonly GizmoStatus[] = ["ready", "building", "failed", "none"];

/** Contents of the last <script>...</script> block, or null if there is none. */
function lastScriptBody(text: string): string | null {
  const end = text.lastIndexOf("</script>");
  if (end < 0) return null;
  const start = text.lastIndexOf("<script", end);
  if (start < 0) return null;
  const open = text.indexOf(">", start);
  if (open < 0 || open > end) return null;
  return text.slice(open + 1, end);
}

function Preview() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("state") ?? "ready";
  const status: GizmoStatus = (STATES as readonly string[]).includes(requested)
    ? (requested as GizmoStatus)
    : "ready";
  const concept = params.get("title") ?? DEFAULT_TITLE;
  const assembled = params.get("assembled") === "1";
  const broken = params.get("broken") === "1";

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

  const html = useMemo(() => {
    if (status !== "ready" || template === null) return null;
    if (!assembled) return template;
    const scene = lastScriptBody(template);
    if (scene === null) {
      console.error("gizmo preview: no <script> block in template");
      return null;
    }
    return assembleGizmoHtml(broken ? `${scene}\nundefinedFn();` : scene, concept);
  }, [status, template, assembled, broken, concept]);

  return <GizmoView html={html} status={status} concept={concept} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
