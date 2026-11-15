import type { UiIntent } from "@shared/contracts";
import { EV, emitEvent } from "../../lib/ipc";
import { useSession } from "../../lib/sessionMirror";
import { Bubble } from "./Bubble";

export default function App() {
  const phase = useSession((s) => s.phase);
  const send = (i: UiIntent): void => {
    emitEvent(EV.uiIntent, i).catch((e) =>
      console.error("bubble: ui:intent emit failed", e instanceof Error ? e.message : e),
    );
  };
  return (
    <div style={{ width: "100%", height: "100%", background: "transparent" }}>
      <Bubble phase={phase} onIntent={send} />
    </div>
  );
}
