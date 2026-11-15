import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/sessionMirror";
import { CMD, invokeCmd } from "@/lib/ipc";
import "./gizmo.css";

export type GizmoStatus = "none" | "offered" | "building" | "ready" | "failed";

/** Decodes the few entities assembleGizmoHtml escapes into <title>. &amp; goes last. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The <title> of a kept diagram, which is the concept it was built for. */
function titleFromHtml(html: string | null): string | null {
  if (!html) return null;
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? decodeEntities(m[1]).trim() : "";
  return t || null;
}

function displayTitle(concept?: string | null): string {
  const t = (concept ?? "").trim();
  if (!t) return "Diagram";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function StatusPill({ status, hasHtml }: { status: GizmoStatus; hasHtml: boolean }) {
  if (status === "building") {
    return (
      <span className="gz-status gz-status--building" role="status">
        <span className="gz-label">Building…</span>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="gz-status gz-status--failed" role="status">
        <span className="gz-dot" aria-hidden="true" />
        Failed
      </span>
    );
  }
  if (hasHtml) {
    return (
      <span className="gz-status gz-status--live" role="status">
        <span className="gz-dot" aria-hidden="true" />
        Live
      </span>
    );
  }
  return null;
}

/** Presentational view shared by the live window and the dev preview. */
export function GizmoView({
  html,
  status,
  concept,
  onClose,
}: {
  html: string | null;
  status: GizmoStatus;
  concept?: string | null;
  onClose?: () => void;
}) {
  // Each new diagram (or a reload press) gets a fresh iframe, which replays the fade-in.
  const [frameKey, setFrameKey] = useState(0);
  const [seenHtml, setSeenHtml] = useState(html);
  if (html !== seenHtml) {
    setSeenHtml(html);
    setFrameKey((k) => k + 1);
  }

  const title = displayTitle(concept);

  let body: React.ReactNode;
  if (html) {
    body = (
      <iframe
        key={frameKey}
        className="gz-frame"
        title="Interactive diagram"
        sandbox="allow-scripts"
        srcDoc={html}
        referrerPolicy="no-referrer"
        style={{ border: 0, width: "100%", height: "100%" }}
      />
    );
  } else if (status === "building") {
    body = (
      <div className="gz-center">
        <div className="gz-card glass-panel">
          <div className="gz-bar" aria-hidden="true" />
          <h2 className="gz-card-title">Building your diagram…</h2>
          <p className="gz-card-sub">This usually takes 15–40 seconds.</p>
        </div>
      </div>
    );
  } else if (status === "failed") {
    body = (
      <div className="gz-center">
        <div className="gz-card glass-panel">
          <h2 className="gz-card-title">Couldn't build the diagram</h2>
          <p className="gz-card-sub">Ask the tutor to draw it on the whiteboard instead.</p>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="gz-center">
        <p className="gz-empty">
          No diagram yet. Say &ldquo;make me an interactive diagram&rdquo; during an explanation.
        </p>
      </div>
    );
  }

  return (
    <div className="gz-root">
      <header className="gz-header">
        <div className="gz-titles">
          <span className="gz-eyebrow">INTERACTIVE DIAGRAM</span>
          <h1 className="gz-title" title={title}>
            {title}
          </h1>
        </div>
        <div className="gz-actions">
          <StatusPill status={status} hasHtml={html !== null} />
          <button
            type="button"
            className="gz-btn"
            aria-label="Reload diagram"
            title="Reload"
            disabled={!html}
            onClick={() => setFrameKey((k) => k + 1)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 4v5h-5" />
            </svg>
          </button>
          <button
            type="button"
            className="gz-btn"
            aria-label="Close diagram window"
            title="Close"
            onClick={() => onClose?.()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>
      <main className="gz-body">{body}</main>
    </div>
  );
}

export default function App() {
  const snap = useSession((s) => s);
  const liveHtml = snap.gizmo.status === "ready" && snap.gizmo.html ? snap.gizmo.html : null;

  // Keep the last ready diagram so it stays on screen when a new session resets the snapshot.
  const [kept, setKept] = useState<string | null>(null);
  useEffect(() => {
    if (liveHtml) setKept(liveHtml);
  }, [liveHtml]);

  const html = liveHtml ?? kept;
  // The diagram's own title wins: a later turn may have changed the response concept.
  const concept = useMemo(() => titleFromHtml(html) ?? snap.response?.concept ?? null, [html, snap.response?.concept]);

  return (
    <GizmoView
      html={html}
      status={snap.gizmo.status}
      concept={concept}
      onClose={() => {
        void invokeCmd(CMD.hideWindow, { label: "gizmo" }).catch(() => undefined);
      }}
    />
  );
}
