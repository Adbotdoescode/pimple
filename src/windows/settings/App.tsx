import { useEffect, useState } from "react";
import type { UiIntent } from "@shared/contracts";
import { EV, emitEvent, invokeCmd, onEvent } from "../../lib/ipc";
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

  // Dev only (the tray is hard to reach from scripts): an injected ui:intent carrying
  // `devOpen: "<tab>"` shows this window on that tab, `devOpen: "hide"` hides it. Example:
  //   scripts/gt-emit.sh ui:intent '{"type":"settings-changed","settings":{},"devOpen":"voice"}'
  const [devTab, setDevTab] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onEvent(EV.uiIntent, (p) => {
      const dev = (p as { devOpen?: unknown }).devOpen;
      if (typeof dev !== "string") return;
      if (dev === "hide") {
        invokeCmd("hide_window", { label: "settings" }).catch(() => {});
        return;
      }
      setDevTab(dev);
      invokeCmd("show_window", { label: "settings" }).catch(() => {});
    })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
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
    <Settings snapshot={snapshot} onIntent={send} initialSection={section} navNonce={nonce} devTab={devTab} />
  );
}
