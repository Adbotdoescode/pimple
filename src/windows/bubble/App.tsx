import { useEffect, useRef, type CSSProperties } from "react";
import { emitTo } from "@tauri-apps/api/event";
import type { UiIntent } from "@shared/contracts";
import { EV, emitEvent } from "../../lib/ipc";
import { useSession } from "../../lib/sessionMirror";
import { Bubble } from "./Bubble";
import { blog, useBubbleMotion } from "./useBubbleMotion";
import { startLiquidLens } from "./liquidLens";

// The wrapper is a fixed 504 pt square (2·R_MAX + 64) centred on (--lx, --ly) in window-local px.
// It is always transformed, which makes it the containing block for Bubble's position:fixed stage;
// the injected rule below sizes that stage to the wrapper (instead of the viewport) so the glow
// filter and squash transform only touch a small layer, even when the window covers the display.
// useBubbleMotion writes --lx/--ly/transform/filter/opacity straight to the DOM every frame.
/** Sent to the overlay, which draws the "Set up Pimple" pill beside the resting drop for `ms`. */
export const SETUP_HINT_EVENT = "bubble:setup-hint";
const HINT_EVERY_MS = 20000;
const HINT_SHOW_MS = 5200;
function setupHint(ms: number): void {
  emitTo("overlay", SETUP_HINT_EVENT, { ms }).catch(() => {});
}

const WRAP = 504;
const WRAP_CSS = `.gt-wrap .gt-stage { width: 100%; height: 100%; }`;
const WRAP_STYLE: CSSProperties = {
  position: "fixed",
  left: `calc(var(--lx, 50vw) - ${WRAP / 2}px)`,
  top: `calc(var(--ly, 50vh) - ${WRAP / 2}px)`,
  width: WRAP,
  height: WRAP,
  transform: "translateZ(0)",
  transformOrigin: "50% 50%",
  pointerEvents: "none",
};

export default function App() {
  const phase = useSession((s) => s.phase);
  const edge = useSession((s) => s.settings?.bubbleEdge) ?? "right";
  const bubbleY = useSession((s) => s.settings?.bubbleY) ?? 0.5;
  const { wrapRef, diameter, motion, gestures } = useBubbleMotion(phase, edge, bubbleY);
  // Until the Anthropic key is in, the resting drop glows amber and a small glass pill beside it
  // says "Set up Pimple": once on arrival, then every 20 s, and whenever the pointer is over the drop.
  const needsSetup = useSession((s) => (s as { needsSetup?: unknown }).needsSetup === true);
  const hinting = needsSetup && phase === "idle";
  useEffect(() => {
    if (!hinting) {
      setupHint(0);
      return;
    }
    const first = window.setTimeout(() => setupHint(HINT_SHOW_MS + 1500), 900);
    const every = window.setInterval(() => setupHint(HINT_SHOW_MS), HINT_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
      setupHint(0);
    };
  }, [hinting]);
  const lensRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = lensRef.current;
    if (!c) return;
    return startLiquidLens(c, blog);
  }, []);
  const send = (i: UiIntent): void => {
    if (i.type === "bubble-click") blog(`[bubble] click (phase ${phase})`);
    emitEvent(EV.uiIntent, i).catch((e) =>
      console.error("bubble: ui:intent emit failed", e instanceof Error ? e.message : e),
    );
  };
  return (
    <div style={{ width: "100%", height: "100%", background: "transparent" }}>
      <style>{WRAP_CSS}</style>
      <div ref={wrapRef} className="gt-wrap" style={WRAP_STYLE}>
        <canvas
          ref={lensRef}
          className="gt-lens"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        />
        <Bubble
          phase={phase}
          onIntent={send}
          diameter={diameter}
          motion={motion}
          gestures={gestures}
          needsSetup={needsSetup}
          onHover={(over) => {
            if (hinting) setupHint(over ? 60000 : 900);
          }}
        />
      </div>
    </div>
  );
}
