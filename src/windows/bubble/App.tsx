import type { CSSProperties } from "react";
import type { UiIntent } from "@shared/contracts";
import { EV, emitEvent } from "../../lib/ipc";
import { useSession } from "../../lib/sessionMirror";
import { Bubble } from "./Bubble";
import { useBubbleMotion } from "./useBubbleMotion";

// The wrapper is viewport-sized and always transformed, which makes it the containing block for
// Bubble's position:fixed stage. Its centre sits at (--lx, --ly) in window-local px, so the glass
// is drawn exactly there; the squash/stretch transform pivots on the glass centre.
// useBubbleMotion writes --lx/--ly/transform/opacity straight to the DOM every frame.
const WRAP_STYLE: CSSProperties = {
  position: "fixed",
  left: "calc(var(--lx, 50vw) - 50vw)",
  top: "calc(var(--ly, 50vh) - 50vh)",
  width: "100vw",
  height: "100vh",
  transform: "translateZ(0)",
  transformOrigin: "50% 50%",
  willChange: "transform",
};

export default function App() {
  const phase = useSession((s) => s.phase);
  const { wrapRef, diameter, motion, gestures } = useBubbleMotion(phase);
  const send = (i: UiIntent): void => {
    emitEvent(EV.uiIntent, i).catch((e) =>
      console.error("bubble: ui:intent emit failed", e instanceof Error ? e.message : e),
    );
  };
  return (
    <div style={{ width: "100%", height: "100%", background: "transparent" }}>
      <div ref={wrapRef} style={WRAP_STYLE}>
        <Bubble
          phase={phase}
          onIntent={send}
          diameter={diameter}
          motion={motion}
          gestures={gestures}
        />
      </div>
    </div>
  );
}
