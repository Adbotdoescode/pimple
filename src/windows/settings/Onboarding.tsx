import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
  checkScreenRecordingPermission,
  requestAccessibilityPermission,
  requestMicrophonePermission,
  requestScreenRecordingPermission,
} from "tauri-plugin-macos-permissions-api";
import { CMD, type SecretName } from "@shared/contracts";
import { VoicePicker } from "./VoicePicker";
import { CheckIcon } from "./icons";

export type OnbStep = "welcome" | "anthropic" | "elevenlabs" | "voice" | "permissions" | "done";
type KeyStatus = Partial<Record<SecretName, boolean>>;

/** True when the running build has no such command yet (or we are in a plain browser preview). */
function commandMissing(e: unknown): boolean {
  const m = (typeof e === "string" ? e : e instanceof Error ? e.message : "").toLowerCase();
  return m.includes("not found") || m.includes("not allowed") || m.includes("undefined");
}

function open(url: string): void {
  try {
    openUrl(url).catch(() => {});
  } catch {
    /* outside Tauri, or the URL scheme is not allowed by the opener scope */
  }
}

/**
 * First-run setup: welcome → Anthropic key → ElevenLabs key → voice → permissions → done.
 * Keys are validated, written to the Keychain and then only ever shown masked. Never logged.
 */
export function Onboarding({
  keys,
  keysUnavailable,
  refreshKeys,
  voiceId,
  onSelectVoice,
  onFinish,
  onExit,
  startStep,
}: {
  keys: KeyStatus | null;
  keysUnavailable: boolean;
  refreshKeys: () => Promise<void>;
  voiceId: string;
  onSelectVoice: (id: string) => Promise<void>;
  /** "Start using Pimple": setup is complete, hide the window. */
  onFinish: () => void;
  /** Leave the flow for the normal tabs. */
  onExit: () => void;
  startStep?: OnbStep;
}) {
  const hasAnthropic = !!keys?.anthropic;
  const hasEleven = !!keys?.elevenlabs;

  // The voice step exists only once an ElevenLabs key is saved.
  const steps = useMemo<OnbStep[]>(
    () =>
      hasEleven
        ? ["welcome", "anthropic", "elevenlabs", "voice", "permissions", "done"]
        : ["welcome", "anthropic", "elevenlabs", "permissions", "done"],
    [hasEleven],
  );
  const [step, setStep] = useState<OnbStep>(startStep ?? "welcome");
  const [dir, setDir] = useState(1);
  useEffect(() => {
    if (startStep) setStep(startStep);
  }, [startStep]);

  const index = Math.max(0, steps.indexOf(step));
  const move = (delta: number) => {
    const next = steps[Math.min(steps.length - 1, Math.max(0, index + delta))];
    setDir(delta >= 0 ? 1 : -1);
    setStep(next);
  };

  const canContinue = step !== "anthropic" || hasAnthropic;
  let nextLabel = "Continue";
  if (step === "welcome") nextLabel = "Get started";
  else if (step === "elevenlabs" && !hasEleven) nextLabel = "Skip, use the Mac voice";
  else if (step === "permissions") nextLabel = "Continue";
  else if (step === "done") nextLabel = "Start using Pimple";

  return (
    <div className="onb">
      <Progress steps={steps} index={index} />

      <div className="onb-stage">
        <div
          key={step}
          className={step === "voice" ? "pane onb-pane wide" : "pane onb-pane"}
          style={{ ["--dir" as string]: dir }}
        >
          {step === "welcome" && (
            <section className="blob onb-card onb-welcome">
              <div className="onb-hero" aria-hidden="true">
                <span className="logo-glass" />
              </div>
              <h2 className="onb-title">Pimple</h2>
              <p className="onb-lede">A tutor that lives on the edge of your screen</p>
              <ul className="onb-how">
                <li>
                  <span className="onb-num">1</span>
                  <div>
                    <b>Click the droplet</b>
                    <span>Ask out loud about whatever is on your screen.</span>
                  </div>
                </li>
                <li>
                  <span className="onb-num">2</span>
                  <div>
                    <b>Drag to aim, circle to lasso</b>
                    <span>Point it at one part of the page and Pimple draws right on top of it.</span>
                  </div>
                </li>
                <li>
                  <span className="onb-num">3</span>
                  <div>
                    <b>Hold Space to interrupt</b>
                    <span>Cut in with a follow-up at any moment.</span>
                  </div>
                </li>
              </ul>
            </section>
          )}

          {step === "anthropic" && (
            <KeyStep
              name="anthropic"
              title="Add your Anthropic key"
              lede="Required. This is what Pimple thinks with."
              host="console.anthropic.com"
              url="https://console.anthropic.com/settings/keys"
              present={keys === null ? null : hasAnthropic}
              unavailable={keysUnavailable}
              onSaved={refreshKeys}
            />
          )}

          {step === "elevenlabs" && (
            <KeyStep
              name="elevenlabs"
              title="Give Pimple a voice"
              lede="Optional. Without it Pimple uses the Mac voice."
              host="elevenlabs.io"
              url="https://elevenlabs.io/app/settings/api-keys"
              present={keys === null ? null : hasEleven}
              unavailable={keysUnavailable}
              onSaved={refreshKeys}
            />
          )}

          {step === "voice" && (
            <section className="blob onb-card">
              <div className="blob-head">
                <h2>Pick a voice</h2>
                <p>Tap play to hear one (previews are free), then choose. You can change it later.</p>
              </div>
              <div className="onb-voices">
                <VoicePicker voiceId={voiceId} hasKey={hasEleven} onSelect={onSelectVoice} />
              </div>
            </section>
          )}

          {step === "permissions" && <Permissions />}

          {step === "done" && (
            <section className="blob onb-card onb-welcome">
              <div className="onb-hero done" aria-hidden="true">
                <span className="logo-glass" />
                <span className="onb-hero-tick">
                  <CheckIcon size={16} strokeWidth={3.2} />
                </span>
              </div>
              <h2 className="onb-title">You're all set</h2>
              <p className="onb-lede">Look for the droplet on the edge of your screen</p>
              <p className="onb-note">
                Pimple stays in the menu bar. Open this window from there whenever you want to move the
                droplet, change the voice or replace a key.
              </p>
            </section>
          )}
        </div>
      </div>

      <div className="onb-nav">
        {index > 0 ? (
          <button type="button" className="btn ghost" onClick={() => move(-1)}>
            Back
          </button>
        ) : (
          <span />
        )}
        <div className="onb-nav-right">
          {step === "done" ? (
            <button type="button" className="link" onClick={onExit}>
              Open settings
            </button>
          ) : (
            hasAnthropic && (
              <button type="button" className="link" onClick={onExit}>
                Finish later
              </button>
            )
          )}
          <button
            type="button"
            className={`btn ${step === "elevenlabs" && !hasEleven ? "" : "primary"}`}
            disabled={!canContinue}
            title={canContinue ? undefined : "Save your Anthropic key to continue"}
            onClick={() => (step === "done" ? onFinish() : move(1))}
          >
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A glass channel with one dot per step and a droplet that slides (and overshoots) along it. */
function Progress({ steps, index }: { steps: OnbStep[]; index: number }) {
  const n = steps.length;
  return (
    <div
      className="onb-progress"
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={1}
      aria-valuemax={n}
      aria-valuenow={index + 1}
      aria-valuetext={`Step ${index + 1} of ${n}`}
      style={{ ["--f" as string]: n > 1 ? index / (n - 1) : 0 }}
    >
      <span className="onb-track" />
      <span className="onb-fill" />
      {steps.map((s, i) => (
        <span
          key={s}
          className={`onb-dot${i < index ? " past" : ""}`}
          style={{ left: `${n > 1 ? (i / (n - 1)) * 100 : 0}%` }}
        />
      ))}
      <span className="onb-drop" />
    </div>
  );
}

function KeyStep({
  name,
  title,
  lede,
  host,
  url,
  present,
  unavailable,
  onSaved,
}: {
  name: "anthropic" | "elevenlabs";
  title: string;
  lede: string;
  host: string;
  url: string;
  present: boolean | null;
  unavailable: boolean;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<"" | "checking" | "saving">("");
  const [error, setError] = useState<string | null>(null);
  const label = name === "anthropic" ? "Anthropic" : "ElevenLabs";
  const showForm = !present || replacing;

  async function save() {
    const v = value.trim();
    if (!v || busy) return;
    setError(null);
    setBusy("checking");
    try {
      // One cheap provider call. If this build has no validator yet, save without checking.
      let verdict: { ok: boolean; error?: string } = { ok: true };
      try {
        verdict = await invoke<{ ok: boolean; error?: string }>("validate_key", { name, value: v });
      } catch (e) {
        if (!commandMissing(e)) {
          setError("Couldn't check that key. Check your connection and try again.");
          return;
        }
      }
      if (!verdict?.ok) {
        // The validator's message describes the failure; it never contains the key.
        setError(verdict?.error || `${label} didn't accept that key. Copy it again and paste it here.`);
        return;
      }
      setBusy("saving");
      await invoke(CMD.setSecret, { name, value: v });
      setValue("");
      setReplacing(false);
      try {
        await emit("keys:changed", {});
      } catch {
        /* outside Tauri */
      }
      await onSaved();
    } catch {
      // Generic message only: never echo the key or a raw error.
      setError("Couldn't save to your Keychain. Paste the key and try again.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="blob onb-card">
      <div className="blob-head">
        <h2>{title}</h2>
        <p>{lede}</p>
      </div>

      {present && !replacing ? (
        <div className="onb-saved" role="status">
          <span className="onb-mask" aria-hidden="true">
            ••••••••••••
          </span>
          <span className="ok">
            <CheckIcon />
            Saved in your Keychain
          </span>
          <button
            type="button"
            className="link"
            onClick={() => {
              setReplacing(true);
              setValue("");
              setError(null);
            }}
          >
            Replace
          </button>
        </div>
      ) : (
        showForm && (
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
              name={`onb-secret-${name}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`Paste your ${label} key`}
              aria-label={`${label} API key`}
              autoComplete="off"
              autoFocus
              spellCheck={false}
              disabled={unavailable}
              data-1p-ignore="true"
              data-lpignore="true"
            />
            <button type="submit" className="btn primary" disabled={!!busy || value.trim() === "" || unavailable}>
              {busy === "checking" ? "Checking…" : busy === "saving" ? "Saving…" : "Save key"}
            </button>
            {replacing && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setReplacing(false);
                  setValue("");
                  setError(null);
                }}
              >
                Cancel
              </button>
            )}
          </form>
        )
      )}

      {error && (
        <div className="flash err" role="alert">
          {error}
        </div>
      )}
      {unavailable && (
        <div className="flash err" role="alert">
          The Keychain isn't reachable right now. Quit and reopen Pimple, then try again.
        </div>
      )}

      <div className="onb-get">
        <span>
          No key yet? Create one at <b>{host}</b>
        </span>
        <button type="button" className="btn" onClick={() => open(url)}>
          Open {host}
        </button>
      </div>
      <p className="onb-fine">Stored in your macOS Keychain. It leaves this Mac only to call {label}.</p>
    </section>
  );
}

type PermId = "screen" | "mic" | "ax";
const PERMS: {
  id: PermId;
  title: string;
  why: string;
  check: () => Promise<boolean>;
  request: () => Promise<unknown>;
  pane: string;
}[] = [
  {
    id: "screen",
    title: "Screen Recording",
    why: "So Pimple can see what you're asking about",
    check: checkScreenRecordingPermission,
    request: requestScreenRecordingPermission,
    pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  },
  {
    id: "mic",
    title: "Microphone",
    why: "So Pimple can hear your question",
    check: checkMicrophonePermission,
    request: requestMicrophonePermission,
    pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  },
  {
    id: "ax",
    title: "Accessibility",
    why: "For the Space-bar shortcut",
    check: checkAccessibilityPermission,
    request: requestAccessibilityPermission,
    pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
];

function Permissions() {
  const [state, setState] = useState<Record<PermId, boolean | null>>({ screen: null, mic: null, ax: null });

  const recheck = useCallback(async () => {
    const results = await Promise.all(
      PERMS.map(async (p) => {
        try {
          return [p.id, !!(await p.check())] as const;
        } catch {
          return [p.id, null] as const;
        }
      }),
    );
    setState((prev) => {
      const next = { ...prev };
      for (const [id, v] of results) next[id] = v;
      return next;
    });
  }, []);

  // Re-check every 2 s while this step is on screen, so a grant in System Settings shows up here.
  useEffect(() => {
    void recheck();
    const t = window.setInterval(() => void recheck(), 2000);
    return () => window.clearInterval(t);
  }, [recheck]);

  const grant = async (p: (typeof PERMS)[number]) => {
    try {
      await p.request();
    } catch {
      /* the request API is unavailable; the pane below still gets the user there */
    }
    open(p.pane);
    void recheck();
  };

  const all = PERMS.every((p) => state[p.id] === true);

  return (
    <section className="blob onb-card">
      <div className="blob-head">
        <h2>Let Pimple see and hear</h2>
        <p>
          macOS asks once for each. Turn Pimple on in System Settings and this list updates by itself.
        </p>
      </div>
      <div className="rows">
        {PERMS.map((p) => {
          const s = state[p.id];
          let right: ReactNode;
          if (s === true)
            right = (
              <span className="ok">
                <CheckIcon />
                Allowed
              </span>
            );
          else
            right = (
              <button type="button" className="btn" onClick={() => void grant(p)}>
                Open Settings
              </button>
            );
          return (
            <div className="row" key={p.id}>
              <span className={`perm-dot ${s === true ? "ok" : s === false ? "need" : ""}`} aria-hidden="true" />
              <div className="row-text perm-text">
                <div className="row-title">{p.title}</div>
                <div className="row-sub">
                  {p.why}
                  {s === null ? " · status unknown" : s ? "" : " · not allowed yet"}
                </div>
              </div>
              <div className="status">{right}</div>
            </div>
          );
        })}
      </div>
      <p className="onb-fine">
        {all
          ? "Everything is allowed."
          : "If a switch is already on but this still says not allowed, quit and reopen Pimple."}
      </p>
    </section>
  );
}
