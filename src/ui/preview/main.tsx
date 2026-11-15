// Visual preview harness for headless Chromium. Not part of the app and not a test.
// Picks a view from the URL query (see index.html / shoot.sh). Components are imported
// unchanged from src/windows/*; this file only builds mock snapshots and fixtures.
import "./tauriStub";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  DEFAULT_SETTINGS,
  wireToShape,
  type CaptureResult,
  type Phase,
  type SessionSnapshot,
  type Shape,
  type TutorResponse,
  type WireResponse,
  type WireShape,
} from "@shared/contracts";
import { INITIAL_SNAPSHOT } from "../../lib/sessionMirror";
import { Bubble } from "../../windows/bubble/Bubble";
import { Card } from "../../windows/card/Card";
import { OverlayRoot } from "../../windows/overlay/OverlayRoot";
import { Settings } from "../../windows/settings/Settings";
import "./preview.css";

const noop = (): void => {};

const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "bubble";

const GRID_PHASES: Phase[] = [
  "idle", "targeting", "capturing", "summarising", "listening",
  "thinking", "verifying", "speaking", "interrupted", "checking",
];

function isPhase(s: string | null): s is Phase {
  return s !== null && (GRID_PHASES as string[]).includes(s);
}

/** Dark mode for card / settings: stamp the in-app theme attribute and force color-scheme. */
function applyTheme(dark: boolean): void {
  const root = document.documentElement;
  if (dark) {
    root.dataset.theme = "dark";
    root.style.colorScheme = "dark";
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = "light";
  }
}

// ───────────────────────── bubble ─────────────────────────

/** Fake mic level so the waveform animates in the listening phase. ~30 Hz. */
function startLevelEmitter(): void {
  const emit = (window as unknown as { __previewEmit?: (e: string, p: unknown) => void }).__previewEmit;
  const t0 = performance.now();
  window.setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const level = 0.42 + 0.3 * Math.sin(2 * Math.PI * 1.4 * t) + 0.12 * Math.sin(2 * Math.PI * 3.1 * t);
    emit?.("stt:level", { level: Math.min(1, Math.max(0, level)) });
  }, 33);
}

function BubbleView({ phase, bg }: { phase: Phase; bg: "light" | "dark" }) {
  return (
    <div className="pv-page" data-bg={bg}>
      {bg === "light" ? (
        <div className="pv-doc" aria-hidden="true">
          <div className="pv-doc-title" />
          {Array.from({ length: 14 }, (_, i) => (
            <div key={i} className="pv-doc-line" style={{ width: `${64 + ((i * 37) % 30)}%` }} />
          ))}
        </div>
      ) : (
        <div className="pv-dark-blob" aria-hidden="true" />
      )}
      <div className="pv-center">
        <div className="pv-zoom-4">
          <Bubble phase={phase} onIntent={noop} />
        </div>
      </div>
    </div>
  );
}

function BubbleGridView({ bg }: { bg: "light" | "dark" }) {
  return (
    <div className="pv-page pv-page-grid" data-bg={bg}>
      <div className="pv-grid">
        {GRID_PHASES.map((p) => (
          <div key={p} className="pv-cell">
            <div className="pv-cell-label">{p}</div>
            <div className="pv-zoom-25">
              <Bubble phase={p} onIntent={noop} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── card ─────────────────────────

type CardState = "idle" | "thinking" | "speaking" | "full";

const CARD_RESPONSE: TutorResponse = {
  concept: "Forces on a block on a frictionless incline",
  surface: "overlay",
  grounding: {
    source_type: "screen",
    source_ref: "the incline diagram",
    quote: "A 2 kg block rests on a frictionless 30° incline.",
  },
  segments: [
    { id: "s1", text: "Gravity pulls the block straight down, with weight mg." },
    { id: "s2", text: "Only part of that pull acts along the ramp, so the block speeds up more slowly." },
  ],
  shapes: [],
  check_question: "Which component of the weight pushes into the ramp?",
  gizmo_offer: { recommended: false, pitch: "" },
  parked: ["How does friction change this on a rough ramp?", "Why does the normal force depend on the angle?"],
};

function cardSnapshot(state: CardState): SessionSnapshot {
  const base: SessionSnapshot = { ...INITIAL_SNAPSHOT, settings: DEFAULT_SETTINGS };
  switch (state) {
    case "thinking":
      return {
        ...base,
        phase: "thinking",
        mode: "click",
        question: "Why does the block slide down the ramp?",
        partialTranscript: "Why does the block slide down the ramp?",
      };
    case "speaking":
      return {
        ...base,
        phase: "speaking",
        response: CARD_RESPONSE,
        currentSegmentId: "s2",
        spokenSegmentIds: ["s1", "s2"],
        caption: "Only part of that pull acts along the ramp, so the block speeds up more slowly.",
        sourceLabel: "Source: your screen — the incline diagram",
      };
    case "full":
      return {
        ...base,
        phase: "speaking",
        response: CARD_RESPONSE,
        currentSegmentId: "s2",
        spokenSegmentIds: ["s1", "s2"],
        caption: "Only part of that pull acts along the ramp, so the block speeds up more slowly.",
        sourceLabel: "Source: your screen — the incline diagram",
        checkQuestion: CARD_RESPONSE.check_question,
        parked: CARD_RESPONSE.parked,
        contested: [
          {
            segmentId: "s2",
            segmentText: CARD_RESPONSE.segments[1].text,
            objection: "Doesn't the ramp hold the block up, so gravity has no effect?",
            resolution: "The ramp only supplies the normal force. Gravity still pulls along the slope.",
          },
          {
            segmentId: "s1",
            segmentText: CARD_RESPONSE.segments[0].text,
            objection: "Is the weight the same as the normal force?",
            resolution: "No. The normal force is perpendicular to the surface and equals mg cos 30°.",
          },
        ],
        verifier: { ran: true, verdict: "pass", ms: 820 },
        timings: { captureAt: 1_000_000, firstAudioAt: 1_001_400 },
      };
    default:
      return base;
  }
}

function CardView({ state, dark, mini = false }: { state: CardState; dark: boolean; mini?: boolean }) {
  applyTheme(dark);
  // `notice=<text>` previews the service note line in the footer.
  const noticeParam = params.get("notice");
  const base = cardSnapshot(state);
  // `gizmo=offered|building|ready|failed` previews the interactive-diagram row.
  const gizmoParam = (["offered", "building", "ready", "failed"] as const).find((g) => g === params.get("gizmo"));
  const withNotice = noticeParam && base ? ({ ...base, notice: noticeParam } as typeof base) : base;
  const withGizmo = gizmoParam && withNotice ? { ...withNotice, gizmo: { status: gizmoParam } } : withNotice;
  // `talk=1` previews "Tap to talk": the mic set not to open by itself, in the listening phase.
  const snap = params.get("talk") === "1" && withGizmo
    ? { ...withGizmo, phase: "listening" as const, micOpen: false, settings: { ...withGizmo.settings, micAutoOpen: false } }
    : withGizmo;
  return (
    <div className="pv-wallpaper" data-bg={dark ? "dark" : "light"}>
      <div className="pv-blur" aria-hidden="true">
        <i className="pv-blob" style={{ left: "6%", top: "10%", width: 460, height: 420, background: "#ff7a59" }} />
        <i className="pv-blob" style={{ right: "4%", top: "30%", width: 380, height: 380, background: "#3fb6c6" }} />
        <i className="pv-blob" style={{ left: "30%", bottom: "2%", width: 420, height: 300, background: "#8f6bff" }} />
      </div>
      <div className="pv-card-stage">
        <div className="pv-card-slot">
          <Card snapshot={snap} onIntent={noop} initialMinimised={mini} />
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── overlay ─────────────────────────

const OVERLAY_W = 1728;
const OVERLAY_H = 1117;

/** Natural size of the fixture PNG, so the capture metadata matches the real image. */
function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error(`image load failed: ${src}`));
    img.src = src;
  });
}

async function loadJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

function toShapes(ws: WireShape[] | undefined): Shape[] {
  return (ws ?? []).map((w) => wireToShape(w)).filter((s): s is Shape => s !== null);
}

function OverlayView({ fixture, upto, sidenote }: { fixture: string; upto: string | null; sidenote: boolean }) {
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      const wire = await loadJson<WireResponse>(`/demo/fixtures/${fixture}.json`);
      const response: TutorResponse = { ...wire, shapes: toShapes(wire.shapes) };

      const allIds = response.segments.map((s) => s.id);
      const idx = upto ? allIds.indexOf(upto) : -1;
      const ids = idx >= 0 ? allIds.slice(0, idx + 1) : allIds;

      let sideNote: SessionSnapshot["sideNote"] = null;
      if (sidenote) {
        const sn = await loadJson<{ segments: { id: string; text: string }[]; shapes: WireShape[] }>(
          "/demo/fixtures/sidenote.json",
        );
        sideNote = { segments: sn.segments, shapes: toShapes(sn.shapes) };
      }

      const png = `/demo/fixtures/${fixture}.png`;
      const dims = await imageSize(png);
      const capture: CaptureResult = {
        mode: "click",
        imagePath: `/Users/adam/Developer/glass-tutor/demo/fixtures/${fixture}.png`,
        imageBase64: "",
        imageWidth: dims.w,
        imageHeight: dims.h,
        regionInScreenPoints: { x: 0, y: 0, w: OVERLAY_W, h: OVERLAY_H },
        displayId: 1,
        pixelScale: dims.w / OVERLAY_W,
        capturedAt: Date.now(),
        // `focus=1` previews the glass rim around a pointed-at region.
        ...(params.get("focus") === "1"
          ? {
              focus: {
                imagePath: "",
                imageBase64: "",
                imageWidth: 0,
                imageHeight: 0,
                rectInImagePx: [300, 440, 420, 330] as [number, number, number, number],
                regionInScreenPoints: { x: 300, y: 440, w: 420, h: 330 },
              },
            }
          : {}),
      };

      const next: SessionSnapshot = {
        ...INITIAL_SNAPSHOT,
        // `phase=` previews the phase-aware parts of the overlay (the screen-edge glow).
        phase: isPhase(params.get("phase")) ? (params.get("phase") as Phase) : "speaking",
        mode: "click",
        capture,
        response,
        currentSegmentId: ids[ids.length - 1] ?? null,
        spokenSegmentIds: ids,
        sideNote,
        settings: DEFAULT_SETTINGS,
      };
      if (!dead) setSnap(next);
    })().catch((e: unknown) => {
      if (!dead) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      dead = true;
    };
  }, [fixture, upto, sidenote]);

  return (
    <div className="pv-overlay-page">
      <img
        className="pv-overlay-bg"
        src={`/demo/fixtures/${fixture}.png`}
        alt=""
        width={OVERLAY_W}
        height={OVERLAY_H}
      />
      {snap && <OverlayRoot snapshot={snap} />}
      {error && <div className="pv-error">{error}</div>}
    </div>
  );
}

// ───────────────────────── settings ─────────────────────────

function SettingsView({ dark }: { dark: boolean }) {
  applyTheme(dark);
  return (
    <div className="pv-settings-page" data-bg={dark ? "dark" : "light"}>
      <div className="pv-settings-frame">
        <Settings snapshot={INITIAL_SNAPSHOT} onIntent={noop} initialSection="general" />
      </div>
    </div>
  );
}

// ───────────────────────── router ─────────────────────────

function App() {
  const bg: "light" | "dark" = params.get("bg") === "dark" ? "dark" : "light";
  const dark = params.get("theme") === "dark";

  switch (view) {
    case "bubblegrid":
      return <BubbleGridView bg={bg} />;
    case "card": {
      const state = (["idle", "thinking", "speaking", "full"] as const).find((s) => s === params.get("state")) ?? "idle";
      return <CardView state={state} dark={dark} mini={params.get("mini") === "1"} />;
    }
    case "overlay": {
      const fixture = params.get("fixture") ?? "incline-light";
      const upto = params.get("upto");
      const sidenote = params.get("sidenote") === "1";
      return <OverlayView fixture={fixture} upto={upto} sidenote={sidenote} />;
    }
    case "settings":
      return <SettingsView dark={dark} />;
    default: {
      const phaseParam = params.get("phase");
      const phase: Phase = isPhase(phaseParam) ? phaseParam : "idle";
      return <BubbleView phase={phase} bg={bg} />;
    }
  }
}

if (view === "bubble" || view === "bubblegrid") startLevelEmitter();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
