import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { info } from "@tauri-apps/plugin-log";
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  Maximize2,
  Mic,
  Minus,
  Monitor,
  Square,
  X,
} from "lucide-react";
import type { Phase, SessionSnapshot, UiIntent } from "@shared/contracts";
import { invokeCmd } from "../../lib/ipc";
import { useCardLens } from "./cardLens";
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

/** Phases in which the tutor is busy, so "Stop" and "Interrupt" are offered. */
const BUSY_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "summarising",
  "thinking",
  "verifying",
  "speaking",
  "checking",
]);

/** Phases where the last caption stays on screen between segments (no flash to empty). */
const KEEP_CAPTION_PHASES: ReadonlySet<Phase> = new Set<Phase>(["speaking", "interrupted", "checking"]);

/**
 * Control buttons never take keyboard focus: the card is a non-activating panel that can be key
 * while another app is frontmost, so a focused button would fire on a Return/Space typed elsewhere.
 */
const NO_FOCUS = {
  tabIndex: -1,
  onMouseDown: (e: MouseEvent<HTMLButtonElement>) => e.preventDefault(),
};

/** Ignore clicks on ✕, Stop and Interrupt for this long after the window moves, resizes or changes phase. */
const CLICK_SETTLE_MS = 500;

function blurActiveButton() {
  const active = document.activeElement;
  if (active instanceof HTMLButtonElement) active.blur();
}

/** Map a raw backend error to a friendly title. The raw text stays available under "Details". */
function friendlyError(raw: string): { title: string; mic: boolean; asIs?: boolean } {
  // The brain now sends learner-ready text; show it untouched unless it looks like a raw error.
  const rawLooking = raw.length > 120 || /[{}[\]<>]|::|\b[45]\d\d\b|https?:|\berror\b|exception|failed to|undefined|null\b/i.test(raw);
  if (!rawLooking && /^[A-Z]/.test(raw.trim())) {
    return { title: raw.trim(), mic: /\bmic|microphone/i.test(raw), asIs: true };
  }
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
  onMinimisedChange,
  initialMinimised = false,
  autoMinimise = null,
}: {
  snapshot: SessionSnapshot | null;
  onIntent: (i: UiIntent) => void;
  onHeightChange?: (px: number) => void;
  /** True while the typed-question box is focused or holds text. */
  onTypingChange?: (typing: boolean) => void;
  /** Called when the card collapses to its pill or expands again, before the new height is reported. */
  onMinimisedChange?: (minimised: boolean) => void;
  initialMinimised?: boolean;
  /**
   * Request from the dock to collapse (the card would cover the drawing) or expand again.
   * `n` changes with every request. A manual expand wins until the next session.
   */
  autoMinimise?: { minimise: boolean; n: number } | null;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const lensRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const heightCb = useRef(onHeightChange);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [minimised, setMinimised] = useState(initialMinimised);

  /** True while the pill is there because the dock asked for it (not the learner). */
  const autoMini = useRef(false);
  /** Set when the learner expands the pill by hand; auto-minimise then waits for the next session. */
  const manualExpand = useRef(false);

  /** Last time the window moved, resized or changed phase; clicks right after are ignored. */
  const lastGeometryChange = useRef(Date.now());
  function clickTooSoon() {
    return Date.now() - lastGeometryChange.current < CLICK_SETTLE_MS;
  }

  useEffect(() => {
    let cancelled = false;
    let unlisten: Array<() => void> = [];
    const stamp = () => {
      lastGeometryChange.current = Date.now();
    };
    stamp();
    try {
      const win = getCurrentWindow();
      let scale = window.devicePixelRatio || 2;
      win.scaleFactor().then((f) => { scale = f; }).catch(() => {});
      // While the learner drags the card, tell the dock where it went: the learner's position
      // then wins for the rest of the session (no auto-dock, no auto-minimise).
      const moved = (e: { payload: { x: number; y: number } }) => {
        stamp();
        const d = drag.current;
        if (!d.dragging) return;
        // No pointer event tells us the OS drag ended, so a long silence ends it: a later move
        // (the dock, in the next session) must not be reported as the learner's.
        const last = Math.max(d.movedAt, d.draggedAt);
        if (Date.now() - last > 1200) {
          d.dragging = false;
          return;
        }
        d.movedAt = Date.now();
        const pos = { x: Math.round(e.payload.x / scale), y: Math.round(e.payload.y / scale) };
        const send = () => {
          d.sentAt = Date.now();
          emitTo("bubble", "card:user-moved", pos).catch(() => {});
        };
        if (Date.now() - d.sentAt > 90) send();
        if (d.timer !== null) window.clearTimeout(d.timer);
        d.timer = window.setTimeout(() => {
          d.timer = null;
          send();
        }, 140);
      };
      Promise.all([win.onMoved(moved), win.onResized(stamp)])
        .then((fns) => {
          if (cancelled) fns.forEach((f) => f());
          else unlisten = fns;
        })
        .catch(() => {});
    } catch {
      // Not running inside Tauri (e.g. a plain browser preview): nothing to listen to.
    }
    return () => {
      cancelled = true;
      unlisten.forEach((f) => f());
    };
  }, []);

  /**
   * Drag the card anywhere: press on the header, the body or the pill (not on a control or the
   * text field), move a few points, and the OS takes over the window drag.
   */
  const drag = useRef<{
    armed: boolean; x: number; y: number; dragging: boolean; movedAt: number; sentAt: number;
    timer: number | null; draggedAt: number;
  }>({ armed: false, x: 0, y: 0, dragging: false, movedAt: 0, sentAt: 0, timer: null, draggedAt: 0 });

  function onDragDown(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    d.dragging = false; // a fresh press inside the card means any earlier OS drag is over
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    if (t?.closest?.("input, textarea, a, summary, button:not(.mini-main)")) return;
    d.armed = true;
    d.x = e.screenX;
    d.y = e.screenY;
  }

  function onDragMove(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!(e.buttons & 1)) {
      d.armed = false;
      d.dragging = false;
      return;
    }
    if (!d.armed || Math.hypot(e.screenX - d.x, e.screenY - d.y) < 4) return;
    d.armed = false;
    d.dragging = true;
    d.draggedAt = Date.now();
    try {
      getCurrentWindow().startDragging().catch(() => {});
    } catch {
      // Not inside Tauri (browser preview).
    }
  }

  /** A press that turned into a drag must not also count as a click on the pill. */
  function justDragged() {
    return Date.now() - drag.current.draggedAt < 400 || Date.now() - drag.current.movedAt < 250;
  }

  const dragProps = {
    onPointerDown: onDragDown,
    onPointerMove: onDragMove,
    onPointerUp: () => {
      drag.current.armed = false;
    },
  };

  function setMini(next: boolean, by: "user" | "auto" = "user") {
    if (by === "user") {
      if (!next) manualExpand.current = true;
      autoMini.current = false;
    } else {
      autoMini.current = next;
    }
    if (next) setFocused(false); // the input unmounts without a blur event
    onMinimisedChange?.(next);
    setMinimised(next);
  }

  const autoN = autoMinimise?.n;
  useEffect(() => {
    if (!autoMinimise) return;
    if (autoMinimise.minimise) {
      // Never collapse under someone who is typing, or who already chose to keep the card open.
      if (minimised || manualExpand.current || focused || draft.trim()) return;
      setMini(true, "auto");
    } else if (minimised && autoMini.current) {
      setMini(false, "auto");
    }
    // Only a new request should run this, not the state it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoN]);

  // A new session forgets the manual choice.
  const phaseNow: Phase = snapshot?.phase ?? "idle";
  useEffect(() => {
    lastGeometryChange.current = Date.now();
    if (phaseNow === "capturing" || phaseNow === "targeting" || phaseNow === "idle") manualExpand.current = false;
    // A pill the dock asked for does not carry over into the next session.
    if ((phaseNow === "capturing" || phaseNow === "targeting") && autoMini.current) setMini(false, "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseNow]);

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
  }, [minimised]);

  const s = snapshot;
  const phase: Phase = s?.phase ?? "idle";
  const response = s?.response ?? null;
  const caption = s?.caption ?? "";
  const error = s?.error ?? null;
  const gizmo = s?.gizmo?.status ?? "none";
  // Live refraction of the desktop under the card, while the card is on screen.
  useCardLens(panelRef, lensRef, phase !== "idle" || !!error, minimised);
  // Landing in the contract shortly; read defensively until the type has it.
  const noticeRaw = (s as { notice?: unknown } | null)?.notice;
  const notice = typeof noticeRaw === "string" && noticeRaw.trim() ? noticeRaw.trim() : null;
  const parked = s?.parked ?? [];
  const contested = s?.contested ?? [];
  const checkQuestion = s?.checkQuestion || null;
  const tone = PHASE_TONE[phase];
  const isEmpty = phase === "idle" && !response && !caption && !error;
  const busy = BUSY_PHASES.has(phase);

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

  if (minimised) {
    const snippet = displayCaption || liveLine || response?.concept || (err ? err.title : "");
    return (
      <div className="card-shell card-shell-mini">
        <section ref={panelRef} className="glass-panel card-mini" aria-label="Pimple card, minimised" {...dragProps}>
          <canvas ref={lensRef} className="liquid-lens" aria-hidden="true" />
          <i className="liquid" aria-hidden="true" />
          <button
            type="button"
            className="mini-main"
            {...NO_FOCUS}
            onClick={() => {
              if (justDragged()) return;
              blurActiveButton();
              setMini(false);
            }}
            aria-label={`Expand Pimple card. ${PHASE_LABEL[phase]}`}
          >
            <span
              className={`dot dot-${tone}${phase === "listening" ? " dot-pulse" : ""}`}
              aria-hidden="true"
            />
            <span className="mini-status" role="status" aria-live="polite">
              {PHASE_LABEL[phase]}
            </span>
            {snippet && <span className="mini-caption ellipsis">{snippet}</span>}
            {gizmo === "ready" && <span className="mini-gizmo-dot" title="Diagram ready" aria-label="Diagram ready" />}
          </button>
          {busy && (
            <button
              type="button"
              className="glass-btn glass-btn-stop"
              {...NO_FOCUS}
              onClick={(e) => {
                if (e.detail === 0 || clickTooSoon()) return;
                blurActiveButton();
                onIntent({ type: "shut-up" });
              }}
              aria-label="Stop talking"
              title="Stop"
            >
              <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="glass-btn"
            {...NO_FOCUS}
            onClick={() => {
              blurActiveButton();
              setMini(false);
            }}
            aria-label="Expand Pimple card"
          >
            <Maximize2 size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="card-shell">
      <section ref={panelRef} className="glass-panel card" aria-label="Pimple card" {...dragProps}>
        <canvas ref={lensRef} className="liquid-lens" aria-hidden="true" />
        <i className="liquid" aria-hidden="true" />
        <header className="card-header">
          <div className="card-header-left">
            <span className="chip status" role="status" aria-live="polite">
              <span
                className={`dot dot-${tone}${phase === "listening" ? " dot-pulse" : ""}`}
                aria-hidden="true"
              />
              {PHASE_LABEL[phase]}
            </span>
            <VerifierBadge snapshot={s} />
          </div>
          <div className="card-controls">
            <button
              type="button"
              className="glass-btn"
              {...NO_FOCUS}
              onClick={() => {
                blurActiveButton();
                setMini(true);
              }}
              aria-label="Minimise Pimple card"
              title="Minimise"
            >
              <Minus size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="glass-btn glass-btn-close"
              {...NO_FOCUS}
              onClick={(e: MouseEvent<HTMLButtonElement>) => {
                if (!e.isTrusted || e.detail === 0 || clickTooSoon()) return;
                info(`[js] [card] close click at ${e.clientX},${e.clientY}`).catch(() => {});
                blurActiveButton();
                onIntent({ type: "card-close" });
              }}
              aria-label="Close and end this session"
              title="Close"
            >
              <X size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
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

              {gizmo !== "none" && (
                <div className={`gizmo-row gizmo-${gizmo} fade-up`} role="status">
                  {gizmo === "offered" && (
                    <>
                      <span className="gizmo-text">Want an interactive diagram for this?</span>
                      <button
                        type="button"
                        className="gizmo-pill gizmo-yes"
                        {...NO_FOCUS}
                        onClick={(e) => {
                          if (e.detail === 0 || clickTooSoon()) return;
                          blurActiveButton();
                          onIntent({ type: "accept-gizmo" });
                        }}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="gizmo-pill"
                        {...NO_FOCUS}
                        onClick={(e) => {
                          if (e.detail === 0 || clickTooSoon()) return;
                          blurActiveButton();
                          onIntent({ type: "decline-gizmo" });
                        }}
                      >
                        No
                      </button>
                    </>
                  )}
                  {gizmo === "building" && <span className="gizmo-text gizmo-shimmer">Building your diagram…</span>}
                  {gizmo === "ready" && (
                    <>
                      <span className="gizmo-text">Your diagram is ready</span>
                      <button
                        type="button"
                        className="gizmo-pill gizmo-yes"
                        {...NO_FOCUS}
                        onClick={(e) => {
                          if (e.detail === 0 || clickTooSoon()) return;
                          blurActiveButton();
                          try {
                            invokeCmd("show_window", { label: "gizmo" }).catch(() => {});
                          } catch {
                            // Not inside Tauri (browser preview).
                          }
                        }}
                      >
                        Open diagram
                      </button>
                    </>
                  )}
                  {gizmo === "failed" && <span className="gizmo-text gizmo-muted">Couldn't build the diagram</span>}
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
                        {...NO_FOCUS}
                        onClick={() => {
                          blurActiveButton();
                          onIntent({ type: "ask-parked", index: i });
                        }}
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
                    {!err.asIs && (
                      <details className="error-details">
                        <summary>Details</summary>
                        <div className="error-raw">{error}</div>
                      </details>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {busy && (
          <div className="card-actions" role="group" aria-label="Pimple controls">
            <button
              type="button"
              className="action action-stop"
              {...NO_FOCUS}
              onClick={(e) => {
                if (e.detail === 0 || clickTooSoon()) return;
                blurActiveButton();
                onIntent({ type: "shut-up" });
              }}
              aria-label="Stop talking now"
            >
              <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" />
              Stop
            </button>
            <button
              type="button"
              className="action action-interrupt"
              {...NO_FOCUS}
              onClick={(e) => {
                if (e.detail === 0 || clickTooSoon()) return;
                blurActiveButton();
                onIntent({ type: "interrupt" });
              }}
              aria-label="Interrupt and speak"
            >
              <Mic size={14} strokeWidth={2.2} aria-hidden="true" />
              Interrupt
            </button>
          </div>
        )}

        <footer className="card-footer">
          {notice && (
            <div className="notice fade-up" role="status" title={notice}>{notice}</div>
          )}
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
              {...NO_FOCUS}
              disabled={!canSend}
              onClick={() => {
                blurActiveButton();
                submit();
              }}
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
    const rawClaims = (v as { claims?: unknown }).claims;
    const claims = Array.isArray(rawClaims)
      ? rawClaims.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 3)
      : [];
    const why = claims.length > 0
      ? `Couldn't confirm: ${claims.join(" · ")}`
      : "A second model couldn't confirm one statement against the screen";
    return (
      <span className="chip chip-warn" title={why} aria-label={`Check flagged a claim. ${why}`}>
        <AlertTriangle size={12} strokeWidth={2.25} aria-hidden="true" />
        Check flagged a claim
      </span>
    );
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
