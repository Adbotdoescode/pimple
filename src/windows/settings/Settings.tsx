import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CMD,
  DEFAULT_SETTINGS,
  type AppSettings,
  type SecretName,
  type SessionSnapshot,
  type TtsProvider,
  type UiIntent,
} from "@shared/contracts";
import { loadSettings } from "../../core/settingsStore";
import { BubbleMap } from "./BubbleMap";
import { VoicePicker } from "./VoicePicker";
import { CheckIcon, RefreshIcon, WarningIcon } from "./icons";
import { atRest, makeLoop, prefersReducedMotion, spring, stepSpring } from "./spring";
import "./settings.css";

type KeyStatus = Partial<Record<SecretName, boolean>>;
type Tab = "bubble" | "voice" | "tutor" | "keys";
const TABS: { value: Tab; label: string }[] = [
  { value: "bubble", label: "Bubble" },
  { value: "voice", label: "Voice" },
  { value: "tutor", label: "Tutor" },
  { value: "keys", label: "Keys" },
];

type CreditState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; used: number; limit: number };

/**
 * Liquid that reacts to the pointer: a soft specular glow trails the cursor across the pane
 * and the header droplet leans toward it. Springs, so everything overshoots and settles.
 */
function useCursorLiquid(
  rootRef: React.RefObject<HTMLDivElement | null>,
  logoRef: React.RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || prefersReducedMotion()) return;
    const gx = spring(root.clientWidth * 0.7);
    const gy = spring(80);
    const lx = spring(0);
    const ly = spring(0);
    const loop = makeLoop((dt) => {
      stepSpring(gx, 38, 9, dt);
      stepSpring(gy, 38, 9, dt);
      stepSpring(lx, 150, 7.5, dt);
      stepSpring(ly, 150, 7.5, dt);
      root.style.setProperty("--gx", `${gx.x.toFixed(1)}px`);
      root.style.setProperty("--gy", `${gy.x.toFixed(1)}px`);
      const logo = logoRef.current;
      if (logo) {
        const sp = Math.min(0.14, Math.hypot(lx.v, ly.v) / 700);
        logo.style.transform = `translate(${lx.x.toFixed(2)}px, ${ly.x.toFixed(2)}px) scale(${1 + sp}, ${1 - sp})`;
        logo.style.setProperty("--hx", `${(32 + lx.x * 2.2).toFixed(1)}%`);
        logo.style.setProperty("--hy", `${(26 + ly.x * 2.2).toFixed(1)}%`);
      }
      return !(atRest(gx, 0.3) && atRest(gy, 0.3) && atRest(lx, 0.02) && atRest(ly, 0.02));
    });
    const onMove = (e: PointerEvent) => {
      const r = root.getBoundingClientRect();
      gx.target = e.clientX - r.left;
      gy.target = e.clientY - r.top;
      const logo = logoRef.current;
      if (logo) {
        const b = logo.getBoundingClientRect();
        const dx = e.clientX - (b.left + b.width / 2);
        const dy = e.clientY - (b.top + b.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        // Leans up to 5 px toward the cursor, more when it is close.
        const pull = 5 * Math.min(1, 160 / d);
        lx.target = (dx / d) * pull;
        ly.target = (dy / d) * pull;
      }
      root.classList.add("has-pointer");
      loop.kick();
    };
    const onLeave = () => {
      lx.target = 0;
      ly.target = 0;
      root.classList.remove("has-pointer");
      loop.kick();
    };
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      loop.stop();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, [rootRef, logoRef]);
}

const INTERACTIVE = "button, input, textarea, select, a, [role='slider'], [role='radio'], [role='switch'], .bmap";

export function Settings({
  snapshot,
  onIntent,
  initialSection,
  navNonce = 0,
  devTab,
}: {
  snapshot: SessionSnapshot | null;
  onIntent: (i: UiIntent) => void;
  initialSection?: "keys" | "general";
  navNonce?: number;
  /** Dev-only scripted navigation (see App.tsx). */
  devTab?: string;
}) {
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [keysUnavailable, setKeysUnavailable] = useState(false);
  const [tab, setTab] = useState<Tab>(initialSection === "keys" ? "keys" : "bubble");
  const [dir, setDir] = useState(1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const logoRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useCursorLiquid(rootRef, logoRef);

  const go = useCallback((next: Tab) => {
    setTab((prev) => {
      if (prev === next) return prev;
      const a = TABS.findIndex((t) => t.value === prev);
      const b = TABS.findIndex((t) => t.value === next);
      setDir(b > a ? 1 : -1);
      return next;
    });
    bodyRef.current?.scrollTo({ top: 0 });
  }, []);

  // Tray navigation: "Keys…" opens Keys, "Settings…" keeps the current section.
  useEffect(() => {
    if (initialSection === "keys") go("keys");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSection, navNonce]);

  useEffect(() => {
    const t = TABS.find((x) => x.value === devTab);
    if (t) go(t.value);
  }, [devTab, go]);

  const refreshKeys = useCallback(async () => {
    try {
      const status = await invoke<KeyStatus>(CMD.keysStatus);
      setKeys(status);
      setKeysUnavailable(false);
    } catch {
      setKeys(null);
      setKeysUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  // First run: if the Anthropic key is missing, open Keys once.
  const nudged = useRef(false);
  useEffect(() => {
    if (keys === null || nudged.current) return;
    nudged.current = true;
    if (!keys.anthropic) go("keys");
  }, [keys, go]);

  // Local copy for optimistic updates; the snapshot is the source of truth. Until the first real
  // snapshot arrives the mirror holds DEFAULT_SETTINGS (same object), so the persisted settings
  // are read straight from the store instead. Nothing here ever emits: settings-changed is sent
  // only from `change`, which only user gestures call.
  const serverSettings = snapshot?.settings;
  const live = !!serverSettings && serverSettings !== DEFAULT_SETTINGS;
  const liveRef = useRef(live);
  liveRef.current = live;
  const [settings, setSettings] = useState<AppSettings>(serverSettings ?? DEFAULT_SETTINGS);
  const [ready, setReady] = useState(live);
  useEffect(() => {
    if (!live || !serverSettings) return;
    setSettings({ ...DEFAULT_SETTINGS, ...serverSettings });
    setReady(true);
  }, [live, serverSettings]);
  useEffect(() => {
    if (liveRef.current) return;
    let alive = true;
    loadSettings()
      .then((stored) => {
        if (!alive) return;
        if (!liveRef.current) setSettings(stored);
        setReady(true);
      })
      .catch(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const change = (patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    onIntent({ type: "settings-changed", settings: patch });
  };

  const selectVoice = async (id: string) => {
    change({ voiceId: id });
    // Voice IDs are not secret; the keychain copy is what the Rust synthesiser reads.
    await invoke(CMD.setSecret, { name: "voice_id", value: id });
  };

  const needsAnthropic = keys !== null && !keys.anthropic;

  // The whole header moves the window, except its controls.
  const onHeaderDown = (e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    try {
      void getCurrentWindow()
        .startDragging()
        .catch(() => {});
    } catch {
      /* outside Tauri */
    }
  };

  const tabIndex = TABS.findIndex((t) => t.value === tab);

  return (
    <div className="app" ref={rootRef}>
      <div className="app-wash" aria-hidden="true">
        <i className="wash a" />
        <i className="wash b" />
        <i className="wash c" />
        <i className="cursor-glow" />
      </div>

      <header className="lg-header" onMouseDown={onHeaderDown}>
        <div className="brand">
          <div className="logo" ref={logoRef} aria-hidden="true">
            <span className="logo-glass" />
          </div>
          <div className="brand-text">
            <h1>Pimple</h1>
            <p>The tutor that rests on the edge of your screen</p>
          </div>
          <button
            type="button"
            className={`status-pill ${needsAnthropic ? "warn" : keys ? "ok" : ""}`}
            onClick={() => needsAnthropic && go("keys")}
            tabIndex={needsAnthropic ? 0 : -1}
            aria-label={needsAnthropic ? "An Anthropic key is needed. Open Keys." : "Pimple is ready"}
          >
            <span className="dot" />
            {needsAnthropic ? "Needs a key" : keys ? "Ready" : keysUnavailable ? "Preview" : "Waking up"}
          </button>
        </div>

        <nav
          className="tabs"
          role="tablist"
          aria-label="Sections"
          style={{ ["--n" as string]: TABS.length, ["--i" as string]: tabIndex }}
        >
          <span className="tab-thumb" aria-hidden="true" />
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={t.value === tab}
              className={t.value === tab ? "tab on" : "tab"}
              onClick={() => go(t.value)}
            >
              {t.label}
              {t.value === "keys" && needsAnthropic && <span className="tab-dot" aria-hidden="true" />}
            </button>
          ))}
        </nav>

        <svg className="meniscus" viewBox="0 0 1200 14" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 7 C 100 0, 200 14, 300 7 S 500 0, 600 7 S 800 14, 900 7 S 1100 0, 1200 7" />
          <path d="M0 7 C 100 0, 200 14, 300 7 S 500 0, 600 7 S 800 14, 900 7 S 1100 0, 1200 7" />
        </svg>
      </header>

      <main className="lg-body" ref={bodyRef}>
        <div key={tab} className="pane" role="tabpanel" style={{ ["--dir" as string]: dir }}>
          {tab === "bubble" && (
            <>
              <Blob
                title="Where Pimple rests"
                sub="Drag the droplet to either edge, at any height. Let go and the real bubble glides there."
              >
                <BubbleMap
                  ready={ready}
                  edge={settings.bubbleEdge}
                  y={typeof settings.bubbleY === "number" ? settings.bubbleY : 0.5}
                  onChange={(e, y) => change({ bubbleEdge: e, bubbleY: y })}
                />
              </Blob>
            </>
          )}

          {tab === "voice" && (
            <>
              <Blob title="Speech" sub="How Pimple talks back while it draws.">
                <div className="rows">
                  <div className="row">
                    <div className="row-text">
                      <div className="row-title">Speak with</div>
                    </div>
                    <Segmented<TtsProvider>
                      label="Speech provider"
                      value={settings.ttsProvider}
                      options={[
                        { value: "elevenlabs", label: "ElevenLabs" },
                        { value: "say", label: "macOS voice" },
                        { value: "off", label: "Off" },
                      ]}
                      onChange={(v) => change({ ttsProvider: v })}
                    />
                  </div>
                  <CreditRow />
                </div>
              </Blob>
              <Blob
                title="Voice"
                sub={
                  settings.ttsProvider === "elevenlabs"
                    ? "Tap play to hear a voice (previews are free), then pick the one you like."
                    : "These voices are used when speech is set to ElevenLabs."
                }
              >
                <VoicePicker
                  voiceId={settings.voiceId}
                  hasKey={keys === null ? null : !!keys.elevenlabs}
                  onSelect={selectVoice}
                />
                <VoiceIdRow voiceId={settings.voiceId} onCommit={selectVoice} />
              </Blob>
            </>
          )}

          {tab === "tutor" && (
            <>
              <Blob title="How it answers">
                <div className="rows">
                  <ToggleRow
                    title="Verify answers"
                    subtitle="A fast second model checks each answer against your screen"
                    checked={settings.verifierEnabled}
                    onChange={(v) => change({ verifierEnabled: v })}
                  />
                  <ToggleRow
                    title="Fast mode"
                    subtitle="Faster answers, higher cost"
                    checked={settings.fastMode}
                    onChange={(v) => change({ fastMode: v })}
                  />
                </div>
              </Blob>
              <Blob title="Whiteboard">
                <div className="rows">
                  <div className="row">
                    <div className="row-text">
                      <div className="row-title">Theme</div>
                      <div className="row-sub">For longer explanations that open the board</div>
                    </div>
                    <Segmented<AppSettings["whiteboardTheme"]>
                      label="Whiteboard theme"
                      value={settings.whiteboardTheme}
                      options={[
                        { value: "light", label: "Light" },
                        { value: "dark", label: "Dark" },
                      ]}
                      onChange={(v) => change({ whiteboardTheme: v })}
                    />
                  </div>
                </div>
              </Blob>
            </>
          )}

          {tab === "keys" && (
            <>
              {needsAnthropic && (
                <div className="banner" role="alert">
                  <WarningIcon />
                  <span>Pimple needs an Anthropic key before it can answer.</span>
                </div>
              )}
              <Blob title="API keys" sub="Paste a key to save it. Saved keys are never shown again.">
                <div className="rows">
                  <KeyRow
                    name="anthropic"
                    label="Anthropic"
                    hint="Required. Powers every answer"
                    present={keys === null ? null : !!keys.anthropic}
                    unavailable={keysUnavailable}
                    autoFocus={needsAnthropic}
                    onSaved={refreshKeys}
                  />
                  <KeyRow
                    name="elevenlabs"
                    label="ElevenLabs"
                    hint="Optional. Without it Pimple uses the macOS voice"
                    present={keys === null ? null : !!keys.elevenlabs}
                    unavailable={keysUnavailable}
                    onSaved={refreshKeys}
                  />
                </div>
              </Blob>
              <p className="footnote">
                Keys live in your macOS Keychain and leave this Mac only to call the provider.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/** A soft, slightly irregular glass card. */
function Blob({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="blob">
      <div className="blob-head">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function KeyRow({
  name,
  label,
  hint,
  present,
  unavailable,
  autoFocus,
  onSaved,
}: {
  name: SecretName;
  label: string;
  hint: string;
  present: boolean | null;
  unavailable: boolean;
  autoFocus?: boolean;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2400);
    return () => window.clearTimeout(t);
  }, [flash]);

  const showForm = !unavailable && present !== null && (!present || replacing);

  async function save() {
    const v = value.trim();
    if (!v || saving) return;
    setSaving(true);
    setFlash(null);
    try {
      await invoke(CMD.setSecret, { name, value: v });
      setValue("");
      setReplacing(false);
      setFlash({ ok: true, text: "Saved to Keychain" });
      await onSaved();
    } catch {
      // Generic message only: never echo the key value or raw error text.
      setValue("");
      setFlash({ ok: false, text: "Couldn't save to Keychain. Paste the key and try again." });
    } finally {
      setSaving(false);
    }
  }

  let status: ReactNode;
  if (unavailable) {
    status = <span className="muted">Unavailable</span>;
  } else if (present === null) {
    status = <span className="muted">Checking…</span>;
  } else if (present) {
    status = (
      <>
        <span className="ok">
          <CheckIcon />
          In Keychain
        </span>
        <button
          type="button"
          className="link"
          onClick={() => {
            setReplacing((r) => !r);
            setValue("");
          }}
        >
          {replacing ? "Cancel" : "Replace"}
        </button>
      </>
    );
  } else {
    status = <span className="badge">Missing</span>;
  }

  return (
    <div className="row stack">
      <div className="row-line">
        <div className="row-text">
          <div className="row-title">{label}</div>
          <div className="row-sub">{hint}</div>
        </div>
        <div className="status">{status}</div>
      </div>
      {showForm && (
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="text-field"
            type="password"
            name={`secret-${name}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste your ${label} key`}
            aria-label={`${label} API key`}
            autoComplete="off"
            autoFocus={autoFocus}
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
          />
          <button type="submit" className="btn primary" disabled={saving || value.trim() === ""}>
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      )}
      {flash && (
        <div className={flash.ok ? "flash ok" : "flash err"} role={flash.ok ? "status" : "alert"}>
          {flash.text}
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-title">{title}</div>
        <div className="row-sub">{subtitle}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={checked ? "switch on" : "switch"}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      style={{ ["--n" as string]: options.length, ["--i" as string]: index }}
    >
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={on ? "seg on" : "seg"}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function VoiceIdRow({
  voiceId,
  onCommit,
}: {
  voiceId: string;
  onCommit: (v: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(voiceId);
  const [tick, setTick] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setDraft(voiceId);
  }, [voiceId]);

  useEffect(() => {
    if (!tick) return;
    const t = window.setTimeout(() => setTick(false), 1500);
    return () => window.clearTimeout(t);
  }, [tick]);

  // Voice IDs are not secret: the saved value stays visible in the field.
  const commit = () => {
    const v = draft.trim();
    if (!v) {
      setDraft(voiceId);
      return;
    }
    if (v === voiceId) return;
    setDraft(v);
    setError(false);
    onCommit(v)
      .then(() => setTick(true))
      .catch(() => setError(true));
  };

  return (
    <details className="advanced">
      <summary>Use a voice ID instead</summary>
      <div className="row">
        <div className="row-text">
          <div className="row-title">Voice ID</div>
          <div className="row-sub">For a voice outside your library</div>
        </div>
        <div className="voice-field">
          <input
            className="text-field mono"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            aria-label="Voice ID"
            autoComplete="off"
            spellCheck={false}
          />
          {tick && (
            <span className="ok" role="status">
              <CheckIcon />
              Saved
            </span>
          )}
          {error && (
            <span className="flash err" role="alert">
              Couldn't save
            </span>
          )}
        </div>
      </div>
    </details>
  );
}

function CreditRow() {
  const [credit, setCredit] = useState<CreditState>({ status: "loading" });

  const load = useCallback(async () => {
    setCredit({ status: "loading" });
    try {
      const r = await invoke<{ used: number; limit: number; provider: string }>(CMD.ttsCredit);
      setCredit({ status: "ok", used: r.used, limit: r.limit });
    } catch {
      setCredit({ status: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loading = credit.status === "loading";
  const pct =
    credit.status === "ok" && credit.limit > 0 ? Math.min(100, (credit.used / credit.limit) * 100) : 0;
  const tone = pct > 90 ? "red" : pct > 75 ? "amber" : "";

  let text: string;
  if (credit.status === "loading") text = "Checking…";
  else if (credit.status === "error") text = "Credit isn't available right now";
  else
    text = `${credit.used.toLocaleString("en-US")} of ${credit.limit.toLocaleString("en-US")} characters used`;

  return (
    <div className="row stack">
      <div className="row-line">
        <div className="row-text">
          <div className="row-title">ElevenLabs credit</div>
          <div className="row-sub">{text}</div>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh ElevenLabs credit"
          title="Refresh"
        >
          <RefreshIcon className={loading ? "spin" : undefined} />
        </button>
      </div>
      {credit.status === "ok" && (
        <div
          className="meter"
          role="progressbar"
          aria-label="Characters used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className={tone ? `meter-fill ${tone}` : "meter-fill"} style={{ width: `${Math.max(pct, 3)}%` }} />
        </div>
      )}
    </div>
  );
}
