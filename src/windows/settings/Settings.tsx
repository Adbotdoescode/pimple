import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CMD,
  DEFAULT_SETTINGS,
  type AppSettings,
  type SecretName,
  type SessionSnapshot,
  type TtsProvider,
  type UiIntent,
} from "@shared/contracts";
import "./settings.css";

// Inline icons (lucide-react is not a dependency of this project).
function CheckIcon({ size = 13, strokeWidth = 2.6 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function RefreshIcon({ size = 14, strokeWidth = 2.2, className }: { size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function WarningIcon({ size = 16, strokeWidth = 2.2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

type KeyStatus = Partial<Record<SecretName, boolean>>;

type CreditState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; used: number; limit: number };

export function Settings({
  snapshot,
  onIntent,
  initialSection,
}: {
  snapshot: SessionSnapshot | null;
  onIntent: (i: UiIntent) => void;
  initialSection?: "keys" | "general";
}) {
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [keysUnavailable, setKeysUnavailable] = useState(false);
  const keysRef = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    if (initialSection === "keys") {
      keysRef.current?.scrollIntoView({ block: "start" });
    }
  }, [initialSection]);

  // Once keys_status is known, if Anthropic is missing, bring its field into view and focus it.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (keys === null || autoFocusedRef.current) return;
    autoFocusedRef.current = true;
    if (!keys.anthropic) {
      const input = keysRef.current?.querySelector<HTMLInputElement>(
        'input[name="secret-anthropic"]',
      );
      input?.scrollIntoView({ block: "center" });
      input?.focus();
    }
  }, [keys]);

  // Local copy for optimistic updates; the snapshot is the source of truth.
  const serverSettings = snapshot?.settings;
  const [settings, setSettings] = useState<AppSettings>(
    serverSettings ?? DEFAULT_SETTINGS,
  );
  useEffect(() => {
    if (serverSettings) setSettings(serverSettings);
  }, [serverSettings]);

  const change = (patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    onIntent({ type: "settings-changed", settings: patch });
  };

  const needsAnthropic = keys !== null && !keys.anthropic;

  return (
    <div className="settings">
      <div className="settings-inner">
        <section className="section" ref={keysRef}>
          <h2 className="group-head">API keys</h2>
          {needsAnthropic && (
            <div className="banner" role="alert">
              <WarningIcon />
              <span>Glass Tutor needs an Anthropic key to answer.</span>
            </div>
          )}
          <div className="group">
            <KeyRow
              name="anthropic"
              label="Anthropic API key"
              hint="Required to answer questions"
              present={keys === null ? null : !!keys.anthropic}
              unavailable={keysUnavailable}
              onSaved={refreshKeys}
            />
            <KeyRow
              name="elevenlabs"
              label="ElevenLabs API key"
              hint="Optional. Without it, Glass Tutor uses the macOS voice"
              present={keys === null ? null : !!keys.elevenlabs}
              unavailable={keysUnavailable}
              onSaved={refreshKeys}
            />
          </div>
        </section>

        <section className="section">
          <h2 className="group-head">Tutor</h2>
          <div className="group">
            <ToggleRow
              title="Verify answers"
              subtitle="A fast second model checks each answer against the screen"
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
        </section>

        <section className="section">
          <h2 className="group-head">Voice</h2>
          <div className="group">
            <div className="row">
              <div className="row-text">
                <div className="row-title">Speech</div>
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
            <VoiceIdRow
              voiceId={settings.voiceId}
              onCommit={(v) => change({ voiceId: v })}
            />
            <CreditRow />
          </div>
        </section>

        <section className="section">
          <h2 className="group-head">Appearance</h2>
          <div className="group">
            <div className="row">
              <div className="row-text">
                <div className="row-title">Bubble edge</div>
              </div>
              <Segmented<AppSettings["bubbleEdge"]>
                label="Bubble edge"
                value={settings.bubbleEdge}
                options={[
                  { value: "left", label: "Left" },
                  { value: "right", label: "Right" },
                ]}
                onChange={(v) => change({ bubbleEdge: v })}
              />
            </div>
            <div className="row">
              <div className="row-text">
                <div className="row-title">Whiteboard theme</div>
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
        </section>

        <p className="footer">
          Keys are stored in your macOS Keychain and never leave this Mac except
          to call the provider.
        </p>
      </div>
    </div>
  );
}

function KeyRow({
  name,
  label,
  hint,
  present,
  unavailable,
  onSaved,
}: {
  name: SecretName;
  label: string;
  hint: string;
  present: boolean | null;
  unavailable: boolean;
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
      setFlash({ ok: true, text: "Saved" });
      await onSaved();
    } catch {
      // Generic message only: never echo the key value or raw error text.
      setFlash({ ok: false, text: "Couldn't save to Keychain. Try again." });
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
          Saved in Keychain
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
            placeholder="Paste to save"
            aria-label={label}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
          />
          <button
            type="submit"
            className="btn"
            disabled={saving || value.trim() === ""}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      )}
      {flash && (
        <div
          className={flash.ok ? "flash ok" : "flash err"}
          role={flash.ok ? "status" : "alert"}
        >
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
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
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
  onCommit: (v: string) => void;
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
    onCommit(v);
    invoke(CMD.setSecret, { name: "voice_id", value: v })
      .then(() => setTick(true))
      .catch(() => setError(true));
  };

  return (
    <div className="row">
      <div className="row-text">
        <div className="row-title">Voice ID</div>
        <div className="row-sub">Used for spoken replies</div>
      </div>
      <div className="voice-field">
        <input
          className="text-field wide"
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
  );
}

function CreditRow() {
  const [credit, setCredit] = useState<CreditState>({ status: "loading" });

  const load = useCallback(async () => {
    setCredit({ status: "loading" });
    try {
      const r = await invoke<{ used: number; limit: number; provider: string }>(
        CMD.ttsCredit,
      );
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
    credit.status === "ok" && credit.limit > 0
      ? Math.min(100, (credit.used / credit.limit) * 100)
      : 0;
  const tone = pct > 90 ? "red" : pct > 75 ? "amber" : "";

  let text: string;
  if (credit.status === "loading") text = "Checking…";
  else if (credit.status === "error") text = "Credit unavailable";
  else
    text = `${credit.used.toLocaleString("en-US")} of ${credit.limit.toLocaleString(
      "en-US",
    )} characters used`;

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
          <div
            className={tone ? `meter-fill ${tone}` : "meter-fill"}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
