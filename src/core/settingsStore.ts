import { load, type Store } from "@tauri-apps/plugin-store";
import { DEFAULT_SETTINGS, type AppSettings } from "../../shared/contracts";

/** Persisted in the app data dir. Separate from Handy's settings_store.json. Holds no secrets. */
const FILE = "settings.json";
const KEY = "settings";
const SAVE_DEBOUNCE_MS = 300;

const ENUMS: Partial<Record<keyof AppSettings, readonly string[]>> = {
  ttsProvider: ["elevenlabs", "say", "off"],
  bubbleEdge: ["left", "right"],
  whiteboardTheme: ["light", "dark"],
};

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A value is kept only if it has the default's type, is in its allowed set, and is in range. */
function valid(k: keyof AppSettings, v: unknown): boolean {
  if (typeof v !== typeof DEFAULT_SETTINGS[k]) return false;
  const allowed = ENUMS[k];
  if (allowed && !allowed.includes(v as string)) return false;
  if (k === "bubbleY") return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (typeof v === "string" && v.trim() === "") return false;
  return true;
}

/** Merge known, valid keys from `partial` over `base`. Unknown keys and bad values are ignored. */
export function mergeSettings(base: AppSettings, partial: unknown): AppSettings {
  const out: AppSettings = { ...base };
  if (!partial || typeof partial !== "object") return out;
  const o = partial as Record<string, unknown>;
  for (const k of KEYS) {
    if (k in o && valid(k, o[k])) (out as unknown as Record<string, unknown>)[k] = o[k];
  }
  return out;
}

export function sanitizeSettings(raw: unknown): AppSettings {
  return mergeSettings({ ...DEFAULT_SETTINGS }, raw);
}

let storePromise: Promise<Store | null> | null = null;

function openStore(): Promise<Store | null> {
  if (storePromise === null) {
    storePromise = load(FILE, { defaults: {}, autoSave: false }).catch((err: unknown) => {
      console.warn("[brain] settings store unavailable:", errMsg(err));
      return null;
    });
  }
  return storePromise;
}

/** Persisted settings merged over the defaults. Never throws: any store error gives the defaults. */
export async function loadSettings(): Promise<AppSettings> {
  try {
    const store = await openStore();
    if (!store) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(await store.get<unknown>(KEY));
  } catch (err) {
    console.warn("[brain] settings load failed, using defaults:", errMsg(err));
    return { ...DEFAULT_SETTINGS };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: AppSettings | null = null;

async function flush(): Promise<void> {
  const s = pending;
  pending = null;
  if (!s) return;
  try {
    const store = await openStore();
    if (!store) return;
    await store.set(KEY, s);
    await store.save();
  } catch (err) {
    console.warn("[brain] settings save failed:", errMsg(err));
  }
}

/** Debounced (300 ms) save. Only the known setting keys are written. */
export function saveSettings(s: AppSettings): void {
  pending = sanitizeSettings(s);
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flush();
  }, SAVE_DEBOUNCE_MS);
}
