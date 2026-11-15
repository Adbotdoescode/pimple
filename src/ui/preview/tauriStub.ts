// Preview-only shim so @tauri-apps/api runs in a plain browser (Vite dev + headless Chromium).
// Installed only when the real Tauri runtime is absent, so it does nothing inside the app.
// Must be imported first by ./main.tsx.

type Bag = Record<string, unknown>;
const w = window as unknown as Bag;

interface ListenerEntry { eventId: number; event: string; handler: number }

if (w.__TAURI_INTERNALS__ === undefined) {
  const listeners: ListenerEntry[] = [];
  let nextEventId = 1;

  const randomId = (): number => Math.floor(Math.random() * 2 ** 31);

  const internals = {
    metadata: {
      currentWindow: { label: "preview" },
      currentWebview: { windowLabel: "preview", label: "preview" },
    },

    transformCallback(cb: ((data: unknown) => unknown) | undefined, once = false): number {
      const id = randomId();
      w[`_${id}`] = (data: unknown) => {
        if (once) delete w[`_${id}`];
        return cb?.(data);
      };
      return id;
    },

    unregisterCallback(id: number): void {
      delete w[`_${id}`];
    },

    convertFileSrc(path: string): string {
      return "/@fs" + path;
    },

    async invoke(cmd: string, args?: Bag): Promise<unknown> {
      switch (cmd) {
        case "plugin:event|listen": {
          const eventId = nextEventId++;
          listeners.push({
            eventId,
            event: String(args?.event ?? ""),
            handler: Number(args?.handler),
          });
          return eventId;
        }
        case "plugin:event|unlisten": {
          const eventId = Number(args?.eventId);
          const idx = listeners.findIndex((l) => l.eventId === eventId);
          if (idx >= 0) listeners.splice(idx, 1);
          return null;
        }
        case "plugin:event|emit":
        case "plugin:event|emit_to":
          return null;
        case "plugin:window|outer_position":
          return { x: 0, y: 0 };
        case "plugin:window|scale_factor":
          return 1;
        case "plugin:window|inner_size":
        case "plugin:window|outer_size":
          return { width: window.innerWidth, height: window.innerHeight };
        case "keys_status":
          return { anthropic: true, elevenlabs: false, voice_id: false };
        case "tts_credit":
          return { used: 12340, limit: 100000, provider: "elevenlabs" };
        default:
          return null;
      }
    },
  };

  w.__TAURI_INTERNALS__ = internals;

  // Fire every listener registered for `event`, the way Tauri's Rust side would.
  w.__previewEmit = (event: string, payload: unknown): void => {
    for (const l of listeners.filter((x) => x.event === event)) {
      const cb = w[`_${l.handler}`];
      if (typeof cb === "function") {
        (cb as (d: unknown) => unknown)({ event, id: l.eventId, payload });
      }
    }
  };
}

export {};
