import { useEffect, useState } from "react";
import type { UiIntent } from "@shared/contracts";
import { EV, emitEvent, onEvent } from "../../lib/ipc";
import { useSession } from "../../lib/sessionMirror";
import { Settings } from "./Settings";

type Section = "general" | "keys";

export default function App() {
  const snapshot = useSession((s) => s);
  const [section, setSection] = useState<Section>("general");
  // Bumped on every tray navigation so Settings re-runs its scroll-into-view even when
  // the section is already selected.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onEvent(EV.trayAction, (p) => {
      if (p.action === "keys" || p.action === "settings") {
        setSection(p.action === "keys" ? "keys" : "general");
        setNonce((n) => n + 1);
      }
    })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch((e) =>
        console.error("settings: tray listen failed", e instanceof Error ? e.message : e),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const send = (i: UiIntent): void => {
    emitEvent(EV.uiIntent, i).catch((e) =>
      console.error("settings: ui:intent emit failed", e instanceof Error ? e.message : e),
    );
  };

  return (
    <Settings
      key={`${section}-${nonce}`}
      snapshot={snapshot}
      onIntent={send}
      initialSection={section}
    />
  );
}
