import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CMD } from "@shared/contracts";
import { CheckIcon, PauseIcon, PlayIcon, RefreshIcon } from "./icons";

export interface Voice {
  voiceId: string;
  name: string;
  category?: string | null;
  previewUrl?: string | null;
  labels?: Record<string, string> | null;
}

type Load =
  | { status: "loading" }
  | { status: "ok"; voices: Voice[] }
  | { status: "error"; kind: "nokey" | "unavailable" | "failed" };

function classify(e: unknown): "nokey" | "unavailable" | "failed" {
  const m = (typeof e === "string" ? e : e instanceof Error ? e.message : "").toLowerCase();
  if (m.includes("no elevenlabs key") || m.includes("http 401")) return "nokey";
  // The running build predates the command, or we are in a plain browser preview.
  if (m.includes("not found") || m.includes("not allowed") || m.includes("__tauri") || m.includes("undefined"))
    return "unavailable";
  return "failed";
}

const pretty = (s: string) => s.replace(/[_-]+/g, " ").trim();

/** "Roger - Laid-Back, Casual, Resonant" → short name + tagline; labels → one line + a use-case chip. */
function describe(v: Voice): { short: string; tagline: string; line: string; use: string } {
  const l = v.labels ?? {};
  const [short, ...rest] = v.name.split(" - ");
  const tagline = rest.join(" - ").trim() || pretty(String(l.description ?? l.descriptive ?? ""));
  const line = [l.accent, l.gender, l.age].filter(Boolean).map((s) => pretty(String(s))).join(" · ");
  const use = pretty(String(l.use_case ?? l["use case"] ?? v.category ?? ""));
  return { short: short.trim() || v.name, tagline, line, use };
}

/**
 * The account's ElevenLabs voices as glass cards: preview (free, plays previewUrl in an
 * <audio> element), select (settings-changed {voiceId} + keychain voice_id via onSelect).
 */
export function VoicePicker({
  voiceId,
  hasKey,
  onSelect,
}: {
  voiceId: string;
  hasKey: boolean | null;
  onSelect: (voiceId: string) => Promise<void> | void;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [justPicked, setJustPicked] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const attempt = useRef(0);

  const fetchVoices = useCallback(async (quiet = false) => {
    const mine = ++attempt.current;
    if (!quiet) setLoad({ status: "loading" });
    try {
      const voices = await invoke<Voice[]>(CMD.ttsVoices);
      if (mine !== attempt.current) return;
      setLoad({ status: "ok", voices: Array.isArray(voices) ? voices : [] });
    } catch (e) {
      if (mine !== attempt.current) return;
      setLoad({ status: "error", kind: classify(e) });
    }
  }, []);

  useEffect(() => {
    void fetchVoices();
  }, [fetchVoices, hasKey]);

  // The command may land after this window opened: retry quietly while it is unavailable.
  useEffect(() => {
    if (load.status !== "error" || load.kind !== "unavailable") return;
    const t = window.setInterval(() => void fetchVoices(true), 8000);
    return () => window.clearInterval(t);
  }, [load, fetchVoices]);

  const stop = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    setPlaying(null);
    setProgress(0);
  }, []);

  useEffect(() => stop, [stop]);

  const toggle = (v: Voice) => {
    if (!v.previewUrl) return;
    if (playing === v.voiceId) {
      stop();
      return;
    }
    let a = audioRef.current;
    if (!a) {
      a = new Audio();
      a.preload = "none";
      a.addEventListener("ended", () => {
        setPlaying(null);
        setProgress(0);
      });
      a.addEventListener("timeupdate", () => {
        const el = audioRef.current;
        if (el && el.duration > 0) setProgress(el.currentTime / el.duration);
      });
      a.addEventListener("error", () => {
        setPlaying(null);
        setProgress(0);
      });
      audioRef.current = a;
    }
    a.pause();
    a.src = v.previewUrl;
    setProgress(0);
    setPlaying(v.voiceId);
    a.play().catch(() => {
      setPlaying(null);
    });
  };

  const pick = (v: Voice) => {
    if (v.voiceId === voiceId) return;
    setJustPicked(v.voiceId);
    window.setTimeout(() => setJustPicked((p) => (p === v.voiceId ? null : p)), 700);
    void onSelect(v.voiceId);
  };

  const voices = load.status === "ok" ? load.voices : [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter((v) => {
      const d = describe(v);
      return `${v.name} ${d.tagline} ${d.line} ${d.use}`.toLowerCase().includes(q);
    });
  }, [voices, query]);

  const current = voices.find((v) => v.voiceId === voiceId);

  return (
    <div className="voices">
      <div className="voices-head">
        <div className="voices-now">
          <span className="eyebrow">Speaking as</span>
          <span className="voices-now-name">
            {current ? describe(current).short : load.status === "ok" ? "A custom voice" : "…"}
            {current && describe(current).tagline && <em>{describe(current).tagline}</em>}
          </span>
        </div>
        {load.status === "ok" && voices.length > 6 && (
          <input
            className="text-field search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter voices"
            aria-label="Filter voices"
            spellCheck={false}
          />
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={() => void fetchVoices()}
          disabled={load.status === "loading"}
          aria-label="Reload voices"
          title="Reload voices"
        >
          <RefreshIcon className={load.status === "loading" ? "spin" : undefined} />
        </button>
      </div>

      {load.status === "loading" && (
        <div className="voice-grid" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="voice-card skeleton" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      )}

      {load.status === "error" && (
        <div className="voices-empty" role="status">
          <p className="voices-empty-title">
            {load.kind === "nokey"
              ? "Add your ElevenLabs key to list your voices"
              : load.kind === "unavailable"
                ? "The voice list is warming up"
                : "Couldn't reach ElevenLabs"}
          </p>
          <p className="voices-empty-sub">
            {load.kind === "nokey"
              ? "Paste it under Keys. Until then Pimple speaks with the system voice."
              : load.kind === "unavailable"
                ? "Pimple needs a restart to pick this up. Checking again every few seconds."
                : "Check your connection, then try again. Your current voice still works."}
          </p>
          <button type="button" className="btn" onClick={() => void fetchVoices()}>
            Try again
          </button>
        </div>
      )}

      {load.status === "ok" && shown.length === 0 && (
        <div className="voices-empty" role="status">
          <p className="voices-empty-title">
            {voices.length === 0 ? "No voices in this account yet" : "No voice matches that filter"}
          </p>
          <p className="voices-empty-sub">
            {voices.length === 0
              ? "Add one in your ElevenLabs voice library, then reload."
              : "Clear the filter to see every voice."}
          </p>
        </div>
      )}

      {load.status === "ok" && shown.length > 0 && (
        <div className="voice-grid" role="radiogroup" aria-label="Assistant voice">
          {shown.map((v, i) => {
            const d = describe(v);
            const on = v.voiceId === voiceId;
            const isPlaying = playing === v.voiceId;
            return (
              <div
                key={v.voiceId}
                className={`voice-card${on ? " on" : ""}${isPlaying ? " playing" : ""}${
                  justPicked === v.voiceId ? " picked" : ""
                }`}
                style={{ animationDelay: `${Math.min(i, 14) * 28}ms` }}
              >
                <button
                  type="button"
                  className="voice-play"
                  onClick={() => toggle(v)}
                  disabled={!v.previewUrl}
                  aria-label={isPlaying ? `Stop preview of ${v.name}` : `Preview ${v.name}`}
                  title={v.previewUrl ? (isPlaying ? "Stop" : "Preview (free)") : "No preview"}
                  style={isPlaying ? { ["--p" as string]: String(progress) } : undefined}
                >
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`${v.name}${d.line ? `, ${d.line}` : ""}`}
                  className="voice-pick"
                  onClick={() => pick(v)}
                >
                  <span className="voice-top">
                    <span className="voice-name">{d.short}</span>
                    {d.use && <span className="voice-chip">{d.use}</span>}
                  </span>
                  {d.tagline && <span className="voice-line">{d.tagline}</span>}
                  {d.line && <span className="voice-meta">{d.line}</span>}
                </button>
                {on && (
                  <span className="voice-tick" aria-hidden="true">
                    <CheckIcon size={11} strokeWidth={3.2} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
