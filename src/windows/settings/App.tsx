import { useEffect, useState } from "react";
import type { UiIntent } from "@shared/contracts";
import { EV, emitEvent, invokeCmd, onEvent } from "../../lib/ipc";
import { useSession } from "../../lib/sessionMirror";
import { Settings } from "./Settings";

type Section = "general" | "keys";

/**
 * Dev only: drags the mini bubble with in-page pointer events (the OS cursor does not move) to the
 * map fraction (fx, fy), holds `hold` ms, then lets go. Exercises the real drag handlers.
 */
function devDragBead(fx: number, fy: number, hold = 120): void {
  const map = document.querySelector<HTMLElement>(".bmap");
  const bead = document.querySelector<HTMLElement>(".bead");
  if (!map || !bead) return;
  const m = map.getBoundingClientRect();
  const b = bead.getBoundingClientRect();
  const from = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  const to = { x: m.left + fx * m.width, y: m.top + fy * m.height };
  const fire = (type: string, x: number, y: number) =>
    bead.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y, isPrimary: true }),
    );
  fire("pointerdown", from.x, from.y);
  const steps = 24;
  let i = 0;
  const tick = () => {
    i += 1;
    const t = i / steps;
    fire("pointermove", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    // Timers, not rAF: a hidden window gets no animation frames and the drag would never end.
    if (i < steps) window.setTimeout(tick, 16);
    else window.setTimeout(() => fire("pointerup", to.x, to.y), hold);
  };
  window.setTimeout(tick, 16);
}

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

  // Dev only (the tray is hard to reach from scripts): an injected ui:intent of the made-up type
  // "dev" (which the brain ignores) drives this window. `devOpen: "<tab>"` shows it on that tab,
  // `devOpen: "hide"` hides it, `devTab: "<tab>"` switches section without focusing,
  // `devDrag: {x, y}` drags the mini bubble in-page, `devReload: true` reloads this webview. Example:
  //   scripts/gt-emit.sh ui:intent '{"type":"dev","devOpen":"voice"}'
  const [devTab, setDevTab] = useState<string | undefined>(undefined);
  const [devOnboard, setDevOnboard] = useState<string | undefined>(() => {
    // Browser preview: …/settings/index.html#onboard=<step>
    const m = import.meta.env.DEV ? /^#onboard=(\w+)$/.exec(window.location.hash) : null;
    return m ? `${m[1]}#0` : undefined;
  });
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onEvent(EV.uiIntent, (p) => {
      // `devTab` switches the section without showing or focusing the window.
      const tabOnly = (p as { devTab?: unknown }).devTab;
      if (typeof tabOnly === "string") setDevTab(tabOnly);
      if ((p as { devReload?: unknown }).devReload === true) {
        window.location.reload();
        return;
      }
      // `devOnboard: "<step>"` opens the first-run flow on that step; "off" leaves it.
      const onb = (p as { devOnboard?: unknown }).devOnboard;
      if (typeof onb === "string") setDevOnboard(`${onb}#${Date.now()}`);
      const drag = (p as { devDrag?: { x: number; y: number; hold?: number } }).devDrag;
      if (drag && typeof drag.x === "number" && typeof drag.y === "number") devDragBead(drag.x, drag.y, drag.hold);
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
    <Settings snapshot={snapshot} onIntent={send} initialSection={section} navNonce={nonce} devTab={devTab} devOnboard={devOnboard} />
  );
}
