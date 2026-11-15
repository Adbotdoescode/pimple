import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/sessionMirror";
import { CMD, invokeCmd } from "@/lib/ipc";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./gizmo.css";

export type GizmoStatus = "none" | "offered" | "building" | "ready" | "failed";

const STORE_KEY = "pimple.gizmo.last";

export interface StoredDiagram {
  html: string;
  title: string;
  at: number;
}

/** The last ready diagram, so the window can show it again after an app relaunch. Best effort. */
export function readStoredDiagram(): StoredDiagram | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredDiagram>;
    if (typeof v.html !== "string" || !v.html) return null;
    return {
      html: v.html,
      title: typeof v.title === "string" ? v.title : "",
      at: typeof v.at === "number" ? v.at : 0,
    };
  } catch {
    return null;
  }
}

function storeDiagram(html: string, title: string): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ html, title, at: Date.now() }));
  } catch {
    /* storage disabled or full */
  }
}

/** Tell the overlay where this window is, so it can keep off it. Screen points; best effort. */
async function announceRect(visible: boolean): Promise<void> {
  try {
    const win = getCurrentWindow();
    const sf = await win.scaleFactor();
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    await emit("gizmo:rect", {
      x: pos.x / sf, y: pos.y / sf, w: size.width / sf, h: size.height / sf, visible,
    });
  } catch {
    /* best effort */
  }
}

/** Hide the window (it stays alive and reopenable), clearing the overlay's avoid-rect first. */
async function closeWindow(): Promise<void> {
  await announceRect(false);
  await invokeCmd(CMD.hideWindow, { label: "gizmo" }).catch(() => undefined);
}

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
export function titleFromHtml(html: string | null): string | null {
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

function StatusChip({ status, hasHtml }: { status: GizmoStatus; hasHtml: boolean }) {
  if (status === "building") {
    return (
      <span className="chip gz-chip gz-chip--building" role="status">
        <span className="gz-label">Building…</span>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="chip gz-chip gz-chip--failed" role="status">
        <span className="gz-dot gz-dot--bad" aria-hidden="true" />
        Failed
      </span>
    );
  }
  if (hasHtml) {
    return (
      <span className="chip gz-chip gz-chip--live" role="status">
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
      <div className="gz-stage">
        <iframe
          key={frameKey}
          className="gz-frame"
          title="Interactive diagram"
          sandbox="allow-scripts"
          srcDoc={html}
          referrerPolicy="no-referrer"
          style={{ border: 0, width: "100%", height: "100%" }}
        />
      </div>
    );
  } else if (status === "building") {
    body = (
      <section className="gz-card glass-panel">
        <i className="liquid" aria-hidden="true" />
        <div className="gz-bar" aria-hidden="true" />
        <h2 className="gz-card-title">Building your diagram…</h2>
        <p className="gz-card-sub">This usually takes 15–40 seconds.</p>
      </section>
    );
  } else if (status === "failed") {
    body = (
      <section className="gz-card glass-panel">
        <i className="liquid" aria-hidden="true" />
        <span className="gz-dot gz-dot--bad gz-dot--card" aria-hidden="true" />
        <h2 className="gz-card-title">Couldn't build the diagram</h2>
        <p className="gz-card-sub">Ask the tutor to draw it on the whiteboard instead.</p>
      </section>
    );
  } else {
    body = (
      <section className="gz-card glass-panel">
        <i className="liquid" aria-hidden="true" />
        <p className="gz-card-sub">
          No diagram yet. Say &ldquo;make me an interactive diagram&rdquo; during an explanation.
        </p>
      </section>
    );
  }

  return (
    <div className="gz-root">
      <main className="gz-body">{body}</main>
      <header className="gz-header glass-panel">
        <i className="liquid" aria-hidden="true" />
        <div className="gz-titles">
          <span className="gz-eyebrow">INTERACTIVE DIAGRAM</span>
          <h1 className="gz-title" title={title}>
            {title}
          </h1>
        </div>
        <div className="gz-actions">
          <StatusChip status={status} hasHtml={html !== null} />
          <button
            type="button"
            className="glass-btn gz-btn"
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
            className="glass-btn gz-btn"
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
    </div>
  );
}

export default function App() {
  const snap = useSession((s) => s);
  const liveHtml = snap.gizmo.status === "ready" && snap.gizmo.html ? snap.gizmo.html : null;

  // Keep the last ready diagram so it stays on screen when a new session resets the snapshot.
  // Starts from storage, so the last diagram also survives an app relaunch.
  const [kept, setKept] = useState<string | null>(() => readStoredDiagram()?.html ?? null);
  useEffect(() => {
    if (!liveHtml) return;
    setKept(liveHtml);
    storeDiagram(liveHtml, titleFromHtml(liveHtml) ?? "");
  }, [liveHtml]);

  const html = liveHtml ?? kept;
  // The diagram's own title wins: a later turn may have changed the response concept.
  const concept = useMemo(() => titleFromHtml(html) ?? snap.response?.concept ?? null, [html, snap.response?.concept]);

  // Window rect for the overlay. Visible on show (visibilitychange), move/resize (debounced), new html.
  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const onVisibility = () => {
      void announceRect(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));

    let debounce: ReturnType<typeof setTimeout> | undefined;
    const nudge = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void announceRect(document.visibilityState === "visible");
      }, 50);
    };
    cleanups.push(() => clearTimeout(debounce));

    const track = (p: Promise<() => void>) => {
      p.then((unlisten) => {
        if (disposed) unlisten();
        else cleanups.push(unlisten);
      }).catch(() => undefined);
    };

    try {
      const win = getCurrentWindow();
      track(win.onMoved(nudge));
      track(win.onResized(nudge));
      track(
        win.onCloseRequested(async (event) => {
          event.preventDefault(); // red button hides instead of destroying the window
          await closeWindow();
        }),
      );
      void win
        .isVisible()
        .then((visible) => {
          if (visible && !disposed) void announceRect(true);
        })
        .catch(() => undefined);
    } catch {
      /* not running inside Tauri */
    }

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  // A new ready diagram means the window is showing (or about to), so refresh the rect.
  useEffect(() => {
    if (!liveHtml) return;
    void (async () => {
      try {
        await announceRect(await getCurrentWindow().isVisible());
      } catch {
        /* best effort */
      }
    })();
  }, [liveHtml]);

  return (
    <GizmoView
      html={html}
      status={snap.gizmo.status}
      concept={concept}
      onClose={() => {
        void closeWindow();
      }}
    />
  );
}
