import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowUp, BookOpen, Check, ChevronRight, Monitor } from "lucide-react";
import type { Phase, SessionSnapshot, UiIntent } from "@shared/contracts";
import "../../ui/glass.css";
import "./card.css";

type Tone = "neutral" | "accent" | "live" | "violet" | "warn" | "ok";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Ready",
  targeting: "Aim at something",
  capturing: "Looking…",
  summarising: "Reading the screen…",
  listening: "Listening…",
  thinking: "Thinking…",
  verifying: "Double-checking…",
  speaking: "Explaining",
  interrupted: "Paused — go ahead",
  checking: "Quick check",
};

const PHASE_TONE: Record<Phase, Tone> = {
  idle: "neutral",
  targeting: "accent",
  capturing: "accent",
  summarising: "accent",
  listening: "live",
  thinking: "violet",
  verifying: "warn",
  speaking: "ok",
  interrupted: "warn",
  checking: "violet",
};

const LOADING_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "capturing",
  "summarising",
  "thinking",
  "verifying",
]);

/** Phases where the last caption stays on screen between segments (no flash to empty). */
const KEEP_CAPTION_PHASES: ReadonlySet<Phase> = new Set<Phase>(["speaking", "interrupted", "checking"]);

/** Map a raw backend error to a friendly title. The raw text stays available under "Details". */
function friendlyError(raw: string): { title: string; mic: boolean } {
  if (/microphone|stt|vad/i.test(raw)) {
    return { title: "Microphone unavailable — type your question below", mic: true };
  }
  if (/capture|screen/i.test(raw)) return { title: "Couldn't capture the screen", mic: false };
  if (/api|anthropic|401|key/i.test(raw)) {
    return { title: "Tutor unavailable — check your API key in Settings", mic: false };
  }
  return { title: "Something went wrong", mic: false };
}

export function Card({
  snapshot,
  onIntent,
  onHeightChange,
  onTypingChange,
}: {
  snapshot: SessionSnapshot | null;
  onIntent: (i: UiIntent) => void;
  onHeightChange?: (px: number) => void;
  /** True while the typed-question box is focused or holds text. */
  onTypingChange?: (typing: boolean) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const heightCb = useRef(onHeightChange);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    heightCb.current = onHeightChange;
  }, [onHeightChange]);

  // Report the panel's exact rendered height so the window can be sized to it.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const report = () => heightCb.current?.(Math.ceil(el.offsetHeight));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const s = snapshot;
  const phase: Phase = s?.phase ?? "idle";
  const response = s?.response ?? null;
  const caption = s?.caption ?? "";
  const error = s?.error ?? null;
  const parked = s?.parked ?? [];
  const contested = s?.contested ?? [];
  const checkQuestion = s?.checkQuestion || null;
  const tone = PHASE_TONE[phase];
  const isEmpty = phase === "idle" && !response && !caption && !error;

  // Keep the last caption while a turn is speaking so the text never flashes to empty.
  const lastCaption = useRef("");
  if (caption) lastCaption.current = caption;
  const displayCaption =
    caption || (KEEP_CAPTION_PHASES.has(phase) ? lastCaption.current : "");
  const showLoading = !displayCaption && LOADING_PHASES.has(phase);

  const liveLine = phase === "listening" ? s?.partialTranscript || s?.question || "" : "";
  const sourceText =
    s?.sourceLabel ||
    (response?.grounding.source_ref ? `Source: ${response.grounding.source_ref}` : null);
  const SourceIcon = response?.grounding.source_type === "fixed_source" ? BookOpen : Monitor;
  const latency =
    s?.timings.captureAt != null && s.timings.firstAudioAt != null
      ? Math.max(0, (s.timings.firstAudioAt - s.timings.captureAt) / 1000).toFixed(1)
      : null;
  const err = error ? friendlyError(error) : null;
  const micError = !!err?.mic;

  // A microphone failure means the user must type instead, so put the cursor in the box.
  useEffect(() => {
    if (micError) inputRef.current?.focus();
  }, [micError, error]);

  const canSend = draft.trim().length > 0;
  const typing = focused || canSend;

  const typingCb = useRef(onTypingChange);
  useEffect(() => {
    typingCb.current = onTypingChange;
  }, [onTypingChange]);
  useEffect(() => {
    typingCb.current?.(typing);
  }, [typing]);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    onIntent({ type: "typed-question", text });
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="card-shell">
      <section ref={panelRef} className="glass-panel card" aria-label="Tutor card">
        <header className="card-header">
          <span className="chip status" role="status" aria-live="polite">
            <span
              className={`dot dot-${tone}${phase === "listening" ? " dot-pulse" : ""}`}
              aria-hidden="true"
            />
            {PHASE_LABEL[phase]}
          </span>
          <VerifierBadge snapshot={s} />
        </header>

        <div className="card-body">
          {isEmpty ? (
            <EmptyState />
          ) : (
            <>
              {(response?.concept || liveLine || displayCaption || showLoading) && (
                <div className="lead fade-up">
                  {response?.concept && <div className="concept">{response.concept}</div>}
                  {liveLine && (
                    <div className="you-line">
                      <span className="you-label">You:</span> {liveLine}
                    </div>
                  )}
                  <div className="caption-slot">
                    {showLoading ? (
                      <div className="skeleton" aria-label="Loading">
                        <div className="skel" />
                        <div className="skel" />
                        <div className="skel" />
                      </div>
                    ) : displayCaption ? (
                      <p key={displayCaption} className="caption caption-in">
                        {displayCaption}
                      </p>
                    ) : null}
                  </div>
                </div>
              )}

              {sourceText && (
                <div className="source-row fade-up">
                  <span
                    className="chip source-chip"
                    title={response?.grounding.quote || sourceText}
                  >
                    <SourceIcon size={12} strokeWidth={2} aria-hidden="true" />
                    <span className="ellipsis">{sourceText}</span>
                  </span>
                </div>
              )}

              {checkQuestion && (
                <section className="check fade-up" aria-label="Check yourself">
                  <div className="check-label">Check yourself</div>
                  <p className="check-q">{checkQuestion}</p>
                </section>
              )}

              {contested.length > 0 && (
                <section className="section fade-up">
                  <h3 className="section-title">Points you questioned</h3>
                  <ul className="contested">
                    {contested.map((c, i) => (
                      <li key={`${c.segmentId}-${i}`} className="contested-item">
                        <span className="contested-dot" aria-hidden="true" />
                        <div>
                          <div className="objection">{c.objection}</div>
                          <div className="resolution">{c.resolution}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {parked.length > 0 && (
                <section className="section fade-up">
                  <div className="section-head">
                    <h3 className="section-title">Parked for later</h3>
                    <span className="count">{parked.length}</span>
                  </div>
                  <div className="parked-list">
                    {parked.map((text, i) => (
                      <button
                        key={`${i}-${text}`}
                        type="button"
                        className="parked-row"
                        onClick={() => onIntent({ type: "ask-parked", index: i })}
                      >
                        <span className="parked-text">{text}</span>
                        <ChevronRight size={15} strokeWidth={2} className="parked-chev" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {err && (
                <div className="error fade-up" role="alert">
                  <AlertTriangle size={15} strokeWidth={2} aria-hidden="true" />
                  <div className="error-body">
                    <div className="error-title">{err.title}</div>
                    <details className="error-details">
                      <summary>Details</summary>
                      <div className="error-raw">{error}</div>
                    </details>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="card-footer">
          <div className="ask">
            <input
              ref={inputRef}
              className="ask-input"
              type="text"
              value={draft}
              placeholder="Type a question instead…"
              aria-label="Type a question"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
            <button
              type="button"
              className="send"
              disabled={!canSend}
              onClick={submit}
              aria-label="Send question"
            >
              <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
          <div className="hint-row">
            <span>Space to interrupt · Esc to cancel</span>
            {latency !== null && <span className="latency">First word in {latency} s</span>}
          </div>
        </footer>
      </section>
    </div>
  );
}

function VerifierBadge({ snapshot }: { snapshot: SessionSnapshot | null }) {
  if (!snapshot) return null;
  const v = snapshot.verifier;
  if (v?.ran && v.verdict === "pass") {
    return (
      <span className="chip chip-ok">
        <Check size={12} strokeWidth={2.5} aria-hidden="true" />
        Verified
        {v.ms != null ? ` · ${(v.ms / 1000).toFixed(1)} s` : ""}
      </span>
    );
  }
  if (v?.ran && v.verdict === "fail") {
    return <span className="chip chip-warn">Revised after check</span>;
  }
  if (!snapshot.settings.verifierEnabled) {
    return <span className="chip chip-muted">Verifier off</span>;
  }
  return null;
}

function EmptyState() {
  return (
    <div className="empty fade-up">
      <div className="empty-title">Ask about anything on your screen</div>
      <div className="empty-sub">Click the bubble and speak, or drag it over a region.</div>
    </div>
  );
}
