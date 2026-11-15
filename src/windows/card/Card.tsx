import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowUp, BookOpen, Check, ChevronRight, Monitor, Sparkles } from "lucide-react";
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

export function Card({
  snapshot,
  onIntent,
  onHeightChange,
}: {
  snapshot: SessionSnapshot | null;
  onIntent: (i: UiIntent) => void;
  onHeightChange?: (px: number) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const heightCb = useRef(onHeightChange);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    heightCb.current = onHeightChange;
  }, [onHeightChange]);

  // Report the shell's rendered height (card + its side and shadow margins) so the
  // lead can size the transparent window to fit.
  useEffect(() => {
    const el = shellRef.current;
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
  const showLoading = !caption && LOADING_PHASES.has(phase);
  const liveLine = phase === "listening" ? s?.partialTranscript || s?.question || "" : "";
  const sourceText =
    s?.sourceLabel ||
    (response?.grounding.source_ref ? `Source: ${response.grounding.source_ref}` : null);
  const SourceIcon = response?.grounding.source_type === "fixed_source" ? BookOpen : Monitor;
  const latency =
    s?.timings.captureAt != null && s.timings.firstAudioAt != null
      ? Math.max(0, (s.timings.firstAudioAt - s.timings.captureAt) / 1000).toFixed(1)
      : null;
  const canSend = draft.trim().length > 0;

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
    <div className="card-shell" ref={shellRef}>
      <section className="glass-panel card" aria-label="Tutor card">
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
              {(response?.concept || liveLine || caption || showLoading) && (
                <div className="lead fade-up">
                  {response?.concept && <div className="concept">{response.concept}</div>}
                  {liveLine && (
                    <div className="you-line">
                      <span className="you-label">You:</span> {liveLine}
                    </div>
                  )}
                  {showLoading ? (
                    <div className="skeleton" aria-label="Loading">
                      <div className="skel" />
                      <div className="skel" />
                      <div className="skel" />
                    </div>
                  ) : caption ? (
                    <p key={caption} className="caption caption-in">
                      {caption}
                    </p>
                  ) : null}
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

              {error && (
                <div className="error fade-up" role="alert">
                  <AlertTriangle size={15} strokeWidth={2} aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="card-footer">
          <div className="ask">
            <input
              className="ask-input"
              type="text"
              value={draft}
              placeholder="Type a question instead…"
              aria-label="Type a question"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
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
      <div className="empty-glyph" aria-hidden="true">
        <Sparkles size={20} strokeWidth={1.75} />
      </div>
      <div className="empty-title">Ask about anything on your screen</div>
      <div className="empty-sub">Click the bubble and speak, or drag it over a region.</div>
    </div>
  );
}
