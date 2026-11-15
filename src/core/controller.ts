import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CMD,
  EV,
  type CaptureRequest,
  type CaptureResult,
  type DebugInject,
  type PausePoint,
  type Phase,
  type RectPts,
  type Segment,
  type Shape,
  type SttError,
  type SttFinal,
  type SttPartial,
  type TutorResponse,
  type UiIntent,
} from "../../shared/contracts";
import { streamTutor, type TutorCallInput, type TutorStreamHandlers } from "./claude";
import { rewriteSentence, verifySegment } from "./verifier";
import { createTtsPlayer } from "./ttsPlayer";
import { wireToTutorResponse } from "./jsonStream";
import { buildGizmoRequest, generateGizmo } from "./gizmo";
import { gizmoSession } from "./prompts";
import { sessionStore, type SessionData } from "./store";
import { mergeSettings, saveSettings } from "./settingsStore";

type Player = ReturnType<typeof createTtsPlayer>;

/** Control-flow stage of a turn. The interruption, when present, has its own stage. */
type Stage =
  | "generating" // streaming or buffering the main tutor answer
  | "checkSpeech" // speaking the check question, then open the mic
  | "awaitingAnswer" // mic open for the student's check answer
  | "feedback" // streaming feedback for the check answer
  | "ending" // speaking the parked-questions sentence, then idle
  | "frozen" // stopped by an interrupt or shut-up: the mic is open for the student's next question
  | "gizmoSpeech" // speaking "Want an interactive diagram for this?"
  | "gizmoAsk" // mic open for the answer to that offer
  | "done";

/** A space-bar interruption of the main explanation. */
interface Interruption {
  pp: PausePoint; // where the main speech stopped
  mode: "hold" | "tap";
  stage: "whichpart" | "recording" | "answering" | "back";
  objection: string;
  streamDone: boolean; // the side-note stream has finished
  finalCheck: string; // check_question from the side note ("" if none)
}

/** One main-answer segment waiting for, or having passed, its verification. */
interface GateEntry {
  seg: Segment;
  state: "pending" | "ok" | "dropped";
  released: boolean;
}

/** Verifier running stats across attempts, shown as snapshot.verifier. */
interface VerifierStats {
  ranAny: boolean;
  droppedAny: boolean;
  maxMs: number;
  claims: string[]; // distinct claims from flagged sentences, max 3
}

const MIC_DOWN = "Mic unavailable — type your question below";

/**
 * Per-attempt gate for verified streaming. Segments are verified in parallel but released in order:
 * a segment reaches the store and the player only when it and every earlier segment are resolved.
 */
interface Gate extends VerifierStats {
  ac: AbortController; // this attempt's stream and checks; aborted on regenerate or cancel
  entries: GateEntry[];
  byId: Map<string, GateEntry>;
  shapes: Map<string, Shape[]>; // shapes waiting for their segment's release
  released: number; // index of the next entry to release
  streamEnded: boolean;
  allowRegen: boolean;
}

/**
 * Control-flow state for one turn. response / spokenSegmentIds / currentSegmentId / sideNote live in
 * sessionStore so the broadcast sees them; the turn only holds what decides what happens next.
 */
interface Turn {
  id: number;
  question: string;
  ac: AbortController;
  stage: Stage;
  /** The model stream (or the already-complete response) has finished. */
  streamDone: boolean;
  /** The TTS queue is empty. Set false on every queue op; set true by the player's onIdle. */
  playerIdle: boolean;
  askedAt: number;
  firstTokenAt?: number;
  firstSegmentAt?: number;
  /** Check question from the main answer. */
  checkQuestion: string | null;
  /** Check question from an interruption's side note. Overrides checkQuestion. */
  sideCheck: string | null;
  /** Follow-up check decided after a feedback answer (max one follow-up). */
  followUp: string | null;
  lastCheck: string | null;
  checkRounds: number;
  interruption: Interruption | null;
  /** The speech currently queued is side-note (interruption answer or check feedback). */
  speakingSide: boolean;
  sideSpeechStarted: boolean;
  whiteboardShown: boolean;
  gate: Gate | null;
  audioStarted: boolean; // first-audio latency recorded for this turn
  freezeMode: "hold" | "tap" | "interrupt" | "shut" | null; // how a frozen turn's mic was opened
  frozenMicPending: boolean; // open the mic once the "Which part?" line has played
  pendingOffer: boolean; // a gizmo offer is waiting for the student's answer
  replaceResponse: boolean; // a follow-up keeps the old shapes until the new answer's first segment is released
  surface: TutorResponse["surface"] | null; // the answer's surface as soon as the stream reports it
  pendingMeta: Partial<TutorResponse>; // meta of a replacing answer, applied when it takes over the kept response
  topicCleared: boolean; // topic_changed was handled this turn (the old drawings are gone)
}

/** Context for the student's next question after an interrupt or shut-up. */
interface FollowUpCtx {
  previousQuestion: string;
  spokenSegments: Segment[];
  shapes: Shape[];
  pulseIds: string[];
  from: number; // index into response.segments where a resume would start
  resumable: boolean;
}

let player: Player;
let pendingFollowUp: FollowUpCtx | null = null;
let turn: Turn | null = null;
let turnSeq = 0;
let runOverride: DebugInject["tts"];
/** Text of segments queued for speech, keyed by id. Covers the special ids (summary, check, back...). */
const queuedText = new Map<string, string>();
/** Ids that are not part of the main or side-note segment lists. */
const SPECIAL_IDS = new Set([
  "whichpart",
  "back",
  "check",
  "summary",
  "prompt",
  "parked",
  "gizmo-offer",
  "gizmo-ready",
  "gizmo-fail",
]);

const st = () => sessionStore.getState();
const patch = (p: Partial<SessionData>) => st().patch(p);

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}

/** Session keys: space while a capture or session is active, Return/Escape while targeting. */
function setKeys(space: boolean, returnEsc: boolean): void {
  invoke(CMD.setSessionKeys, { space, returnEsc }).catch((err) =>
    console.warn("[brain] session keys unavailable:", errMsg(err)),
  );
}

function setPhase(phase: Phase, reason?: string): void {
  if (phase === "idle") console.info("[brain] idle — reason:", reason ?? "unspecified");
  else console.info("[brain]", phase);
  st().setPhase(phase);
  if (phase === "capturing") setKeys(true, false);
  else if (phase === "targeting") setKeys(false, true);
  else if (phase === "idle") setKeys(false, false);
}

function mergeUnique(a: string[], b: string[] = []): string[] {
  return Array.from(new Set([...a, ...b]));
}

function sourceLabelFor(g: TutorResponse["grounding"] | undefined): string | null {
  if (!g?.source_ref) return null;
  return g.source_type === "screen" ? `Source: your screen — ${g.source_ref}` : `Source: ${g.source_ref}`;
}

function beginTurn(question: string, stage: Stage = "generating"): Turn {
  turn?.ac.abort();
  const t: Turn = {
    id: ++turnSeq,
    question,
    ac: new AbortController(),
    stage,
    streamDone: false,
    playerIdle: true,
    askedAt: Date.now(),
    checkQuestion: null,
    sideCheck: null,
    followUp: null,
    lastCheck: null,
    checkRounds: 0,
    interruption: null,
    speakingSide: false,
    sideSpeechStarted: false,
    whiteboardShown: false,
    gate: null,
    audioStarted: false,
    freezeMode: null,
    frozenMicPending: false,
    pendingOffer: false,
    replaceResponse: false,
    surface: null,
    pendingMeta: {},
    topicCleared: false,
  };
  turn = t;
  return t;
}

function isCurrent(t: Turn): boolean {
  return turn === t;
}

/** Stop everything in flight: model calls, speech, and the mic. */
function cancelAll(): void {
  turn?.ac.abort();
  turn = null;
  player.stop();
  cancelMicTimer();
  setMicOpen(false);
  invoke(CMD.sttCancel).catch(() => undefined);
}

function textFor(id: string): string {
  if (SPECIAL_IDS.has(id)) return queuedText.get(id) ?? "";
  const s = st();
  if (turn?.speakingSide) return s.sideNote?.segments.find((x) => x.id === id)?.text ?? "";
  return s.response?.segments.find((x) => x.id === id)?.text ?? queuedText.get(id) ?? "";
}

function queue(t: Turn, segs: Segment[], mode: "speak" | "append"): void {
  if (segs.length === 0) return; // an empty queue never reports idle, so do not mark it busy
  for (const s of segs) queuedText.set(s.id, s.text);
  t.playerIdle = false;
  if (mode === "speak") player.speak(segs);
  else player.append(segs);
}

function markFirstToken(t: Turn): void {
  if (!isCurrent(t) || t.firstTokenAt !== undefined) return;
  t.firstTokenAt = Date.now();
  patch({ timings: { ...st().timings, firstTokenAt: t.firstTokenAt } });
}

function markFirstSegment(t: Turn): void {
  if (t.firstSegmentAt === undefined) t.firstSegmentAt = Date.now();
}

/** The check question that is pending now: a side-note check overrides the main one. */
function pendingCheck(t: Turn): string | null {
  return t.sideCheck ?? t.checkQuestion;
}

function publishCheck(t: Turn): void {
  patch({ checkQuestion: pendingCheck(t) });
}

/** Whiteboard surface: show the window once per turn, never otherwise. */
function maybeShowWhiteboard(t: Turn, surface: TutorResponse["surface"] | undefined): void {
  if (surface !== "whiteboard" || t.whiteboardShown || !isCurrent(t)) return;
  // A follow-up keeps the previous answer up until its first segment: opening now would show an old or empty board.
  // takeOverResponse opens it once the new answer is in the store.
  if (t.replaceResponse && st().response?.surface !== "whiteboard") return;
  t.whiteboardShown = true;
  console.info("[brain] surface whiteboard: showing the whiteboard window");
  invoke(CMD.showWindow, { label: "whiteboard" }).catch((err) =>
    console.warn("[brain] show whiteboard failed:", errMsg(err)),
  );
}

/** Side notes are drawn on the main answer's surface: they open the board only when the main answer is on it. */
function maybeShowWhiteboardForSide(t: Turn, surface: TutorResponse["surface"] | undefined): void {
  maybeShowWhiteboard(t, st().response?.surface === "whiteboard" ? surface : undefined);
}

/** Record the answer's surface; apply it to the store unless an old response is still shown (follow-up). */
function noteSurface(t: Turn, surface: TutorResponse["surface"] | undefined): void {
  if (!surface || !isCurrent(t)) return;
  t.surface = surface;
  if (!t.replaceResponse) st().setMeta({ surface });
}

/** The first new segment of a replacing answer takes over: the kept response, its side note and spoken ids go. */
function takeOverResponse(t: Turn): void {
  if (!t.replaceResponse) return;
  t.replaceResponse = false;
  patch({ response: null, sideNote: null, spokenSegmentIds: [], currentSegmentId: null, pulseShapeIds: [] });
  // The new answer starts with the meta that streamed before it, and keeps its surface (emptyResponse defaults to overlay).
  st().setMeta({ ...t.pendingMeta, ...(t.surface ? { surface: t.surface } : {}) });
  t.pendingMeta = {};
  maybeShowWhiteboard(t, t.surface ?? undefined);
}

/**
 * The tutor says the student moved to a different concept: the previous answer's drawings and side note
 * go now (the views fade them), its caption clears, and the stale follow-up context is dropped.
 * Parked questions and contested points stay.
 */
function clearStaleTopic(): void {
  pendingFollowUp = null;
  patch({ response: null, sideNote: null, spokenSegmentIds: [], currentSegmentId: null, pulseShapeIds: [], caption: "" });
}

/** Main answer: topic_changed arrived while the old response is still shown, before any new segment. */
function onMainTopicChanged(t: Turn): void {
  if (!isCurrent(t) || !t.replaceResponse || t.topicCleared) return; // never touches the new answer
  t.topicCleared = true;
  console.info("[brain] topic changed: clearing the previous answer's drawings");
  clearStaleTopic(); // replaceResponse stays true: meta keeps buffering and the first segment creates the new response
}

/** Check feedback that is about a different concept: the old drawings go, and the side note keeps a surface to draw on. */
function onFeedbackTopicChanged(t: Turn, concept: string): void {
  if (!isCurrent(t) || t.topicCleared || t.sideSpeechStarted) return; // only before the new answer has started
  t.topicCleared = true;
  console.info("[brain] topic changed during check feedback: clearing the previous answer's drawings");
  const r = st().response;
  clearStaleTopic();
  t.checkQuestion = null;
  if (r) {
    patch({
      response: { ...r, concept: concept || r.concept, topic_changed: true, segments: [], shapes: [],
        check_question: "", gizmo_offer: { recommended: false, pitch: "" }, parked: [] },
    });
  }
}

function commitResponse(t: Turn, r: TutorResponse): void {
  const check = (r.check_question ?? "").trim();
  t.checkQuestion = check ? check : null;
  const s = st();
  patch({
    response: r,
    sourceLabel: sourceLabelFor(r.grounding) ?? s.sourceLabel,
    parked: mergeUnique(s.parked, r.parked),
  });
  publishCheck(t);
  maybeShowWhiteboard(t, r.surface);
}

/** Commit a complete response and speak all of it, then let advance() finish the turn. */
function commitAndSpeak(t: Turn, resp: TutorResponse): void {
  commitResponse(t, resp);
  if (resp.segments.length) markFirstSegment(t);
  setPhase("speaking");
  queue(t, resp.segments, "speak");
  t.streamDone = true;
  advance(t);
}

function applyMeta(t: Turn, m: Partial<TutorResponse>, mode: "buffered" | "stream"): void {
  if (!isCurrent(t)) return;
  if (m.topic_changed === true && t.stage === "generating" && !t.interruption) onMainTopicChanged(t);
  const label = sourceLabelFor(m.grounding);
  if (mode === "buffered") {
    // Buffered mode shows only the concept, source and surface while the answer is held for verification.
    if (!t.replaceResponse) st().setMeta({ concept: m.concept });
    else if (m.concept !== undefined) t.pendingMeta.concept = m.concept; // the kept response keeps its own concept
    if (label) patch({ sourceLabel: label });
    noteSurface(t, m.surface);
    maybeShowWhiteboard(t, m.surface);
    return;
  }
  // Segments and shapes arrive through onSegment/onShape, so they are not taken from meta.
  const meta: Partial<TutorResponse> = {
    concept: m.concept,
    grounding: m.grounding,
    gizmo_offer: m.gizmo_offer,
    summary_sentence: m.summary_sentence,
  };
  if (!t.replaceResponse) st().setMeta(meta);
  else {
    // A replacing answer's meta waits for its first segment, so the kept response is not relabelled.
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined) (t.pendingMeta as Record<string, unknown>)[k] = v;
    }
  }
  noteSurface(t, m.surface);
  if (label) patch({ sourceLabel: label });
  if (m.parked) patch({ parked: mergeUnique(st().parked, m.parked) });
  maybeShowWhiteboard(t, m.surface);
  if (t.stage === "generating" && typeof m.check_question === "string") {
    const check = m.check_question.trim();
    t.checkQuestion = check ? check : null;
    publishCheck(t);
  }
}

/** Handlers for the main answer. Segments stream into the store always, into the player only when not interrupted. */
function mainHandlers(t: Turn): TutorStreamHandlers {
  return {
    onFirstToken: () => markFirstToken(t),
    onMeta: (m) => applyMeta(t, m, "stream"),
    onSegment: (seg) => {
      if (!isCurrent(t)) return;
      markFirstSegment(t);
      takeOverResponse(t);
      st().appendSegment(seg);
      // While an interruption is active the segment is stored but not played; resume() replays it.
      if (!t.interruption) queue(t, [seg], "append");
    },
    onShape: (shape) => {
      if (!isCurrent(t)) return;
      st().appendShape(shape);
    },
  };
}

/** Handlers for side-note answers (interruption answer and check feedback). They go to sideNote, not response. */
function sideHandlers(t: Turn, alive: () => boolean): TutorStreamHandlers {
  let concept = "";
  return {
    onMeta: (m) => {
      if (!alive()) return;
      if (m.concept) concept = m.concept;
      if (m.topic_changed === true && t.stage === "feedback") onFeedbackTopicChanged(t, concept);
      if (m.parked) patch({ parked: mergeUnique(st().parked, m.parked) });
      maybeShowWhiteboardForSide(t, m.surface);
    },
    onSegment: (seg) => {
      if (!alive()) return;
      const sn = st().sideNote ?? { segments: [], shapes: [] };
      patch({ sideNote: { ...sn, segments: [...sn.segments, seg] } });
      t.speakingSide = true;
      queue(t, [seg], t.sideSpeechStarted ? "append" : "speak");
      t.sideSpeechStarted = true;
    },
    onShape: (shape: Shape) => {
      if (!alive()) return;
      const sn = st().sideNote ?? { segments: [], shapes: [] };
      patch({ sideNote: { ...sn, shapes: [...sn.shapes, shape] } });
    },
  };
}

/** Our own speech tails off into the mic for a moment; wait before opening it. */
const ECHO_DELAY_MS = 600;
let micTimer: ReturnType<typeof setTimeout> | null = null;
/** The last three sentences the tutor spoke, for the echo check. */
const recentSpoken: string[] = [];

function normWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when at least 60% of the transcript's words appear in one of the last three tutor sentences. */
function isEcho(text: string): boolean {
  const words = normWords(text);
  if (words.length === 0) return false;
  return recentSpoken.some((sentence) => {
    const said = new Set(normWords(sentence));
    const hits = words.filter((w) => said.has(w)).length;
    return hits / words.length >= 0.6;
  });
}

/** Drops our own speech picked up by the mic, or a single word. Not used in the check step. */
function rejectUtterance(text: string): boolean {
  if (normWords(text).length === 1) {
    console.info("[brain] dropped short transcript:", text);
    return true;
  }
  if (isEcho(text)) {
    console.info("[brain] dropped echo transcript:", text);
    return true;
  }
  return false;
}

function cancelMicTimer(): void {
  if (micTimer !== null) {
    clearTimeout(micTimer);
    micTimer = null;
  }
}

/** Open the mic after the echo delay. Cancelled if the phase changes meanwhile. One attempt, no retry loop. */
function scheduleMic(onFail: () => void, force = false): void {
  cancelMicTimer();
  if (!force && !st().settings.micAutoOpen) {
    holdToTalkHint(); // the phase is entered, but the mic waits for Space
    return;
  }
  if (st().micOpen) return;
  const phase = st().phase;
  micTimer = setTimeout(() => {
    micTimer = null;
    if (st().phase !== phase) {
      console.info("[brain] mic start cancelled: phase changed");
      return;
    }
    void tryMic().then((ok) => {
      if (!ok) onFail();
    });
  }, ECHO_DELAY_MS);
}

/** Whether the mic is open (or opening). Set by a successful stt_start, cleared by any stt_cancel/stt_stop/final. */
let micStarting: Promise<boolean> | null = null;

/** The only writer of micOpen. It patches the store, so the broadcast carries the same flag. */
function setMicOpen(open: boolean): void {
  if (st().micOpen !== open) patch({ micOpen: open });
}

/** One stt_start. Never called twice: an open or opening mic is not started again. No retry loop. */
function tryMic(): Promise<boolean> {
  if (st().micOpen) return Promise.resolve(true);
  if (micStarting === null) {
    micStarting = invoke(CMD.sttStart)
      .then(() => {
        setMicOpen(true);
        return true;
      })
      .catch((err: unknown) => {
        console.warn("[brain] stt_start failed:", errMsg(err));
        return false;
      })
      .finally(() => {
        micStarting = null;
      });
  }
  return micStarting;
}

/** First run: re-read whether the Anthropic key is set. A failed read counts as set up. */
async function refreshNeedsSetup(): Promise<void> {
  let needs = false;
  try {
    const keys = await invoke<Record<string, boolean>>(CMD.keysStatus);
    needs = !keys?.anthropic;
  } catch (err) {
    console.warn("[brain] keys_status failed, assuming set up:", errMsg(err));
  }
  if (st().needsSetup !== needs) console.info("[brain] needsSetup:", needs);
  patch({ needsSetup: needs });
}

/** While the key is missing, nothing captures and nothing calls Claude. The settings window opens instead. */
function blockedForSetup(): boolean {
  if (!st().needsSetup) return false;
  console.info("[brain] blocked: needs setup");
  patch({ error: "Set up Pimple first — add your Anthropic key" });
  invoke(CMD.showWindow, { label: "settings" }).catch((err) =>
    console.warn("[brain] show settings failed:", errMsg(err)),
  );
  return true;
}

/** Card-side hint when the mic will not open by itself (micAutoOpen off). */
function holdToTalkHint(): void {
  console.info("[brain] mic waiting for Space (micAutoOpen off)");
  const c = st().caption.trim();
  if (!c || c.endsWith("?")) patch({ caption: "Hold Space to talk" });
}

/** Explicit open from Space (hold) or the card's mic button: no echo delay, and it does nothing if already open. */
function openMicNow(): void {
  if (st().micOpen) return;
  cancelMicTimer();
  patch({ partialTranscript: "" });
  void tryMic().then((ok) => {
    if (!ok) patch({ error: MIC_DOWN });
  });
}

async function startListening(): Promise<void> {
  patch({ partialTranscript: "" });
  setPhase("listening");
  // Stay in listening on failure so the typed box can still be used.
  scheduleMic(() => patch({ error: MIC_DOWN }));
}

function openMicForCheck(t: Turn): void {
  scheduleMic(() => {
    if (!isCurrent(t)) return;
    t.stage = "done";
    patch({ error: MIC_DOWN });
    setPhase("listening"); // the typed box takes the answer
  });
}

/** Opens the mic for a push-to-talk or "which part" answer. On failure the main explanation resumes. */
function openMicForInterrupt(t: Turn, ix: Interruption, force = false): void {
  scheduleMic(() => {
    if (!isCurrent(t) || t.interruption !== ix) return;
    patch({ error: MIC_DOWN });
    beginBack(t);
  }, force);
}

/** Ends the turn: optionally mention parked questions first, then idle. */
function endSession(t: Turn): void {
  const parked = st().parked;
  if (parked.length > 0) {
    t.stage = "ending";
    setPhase("speaking");
    queue(
      t,
      [{ id: "parked", text: `You also asked about ${parked[0]}. Tap it in the card when you want to go there.` }],
      "speak",
    );
    return;
  }
  t.stage = "done";
  setPhase("idle", "answer complete");
}

function nextCheck(t: Turn): string | null {
  if (t.stage === "feedback") return t.followUp;
  if (t.checkRounds === 0) return pendingCheck(t);
  return null;
}

function startCheckSpeech(t: Turn, check: string): void {
  t.checkRounds += 1;
  t.lastCheck = check;
  t.checkQuestion = check;
  t.sideCheck = null;
  t.followUp = null;
  t.speakingSide = false;
  t.stage = "checkSpeech";
  publishCheck(t);
  setPhase("checking");
  queue(t, [{ id: "check", text: check }], "speak");
}

// ───── interactive diagram (gizmo, phase 2) ─────
const ACCEPT_RE = /^(yes|yeah|yep|sure|please|ok(ay)?|go ahead|do it)\b/i;
const DECLINE_RE = /^(no|nah|nope|not now|skip)\b/i;
const VOICE_KIND_RE = /(interactive|gizmo|simulation|animat)\w*.*(diagram|this|it)?/i;
const VOICE_VERB_RE = /(make|build|show|give|create)/i;
/** The student asked for the whiteboard ("use a whiteboard", "draw me a whiteboard", "on the white board"). */
const WHITEBOARD_RE = /\bwhite[\s-]?boards?\b/i;
/** ...unless they said not to ("no whiteboard", "don't use the whiteboard", "close the whiteboard"). */
const NO_WHITEBOARD_RE =
  /\b(?:no|not|don['’]?t|do not|without|stop|close)\s+(?:(?:use|using|need|want|open|show|draw|on|the|a|any|that)\s+){0,3}white[\s-]?boards?\b/i;

/** The build in flight. Aborted by card-close and by a new capture. */
let gizmoAc: AbortController | null = null;
/** Question to retry on the whiteboard after a failed build, while the student's answer is pending. */
let gizmoFailedQuestion: string | null = null;
/** Open the mic once the speech queued without a turn (gizmo-fail) has finished. */
let asideListen = false;
/** Bumped on every new capture and on card-close. A build only speaks if its session is still the current one. */
let sessionSeq = 0;

function gizmoLog(state: string): void {
  console.info("[brain] gizmo", state);
}

function isVoiceRequest(text: string): boolean {
  return VOICE_KIND_RE.test(text) && VOICE_VERB_RE.test(text);
}

function wantsWhiteboard(text: string): boolean {
  return WHITEBOARD_RE.test(text) && !NO_WHITEBOARD_RE.test(text);
}

/** Per-capture offer state. A build that is running is not touched here. */
function resetOffer(): void {
  gizmoSession.offeredThisSession = false;
  gizmoFailedQuestion = null;
  asideListen = false;
}

/** Card-close: the only thing that aborts a build. Clears the card's diagram too. */
function endGizmoSession(): void {
  gizmoAc?.abort();
  gizmoAc = null;
  resetOffer();
  patch({ gizmo: { status: "none" } });
}

/** Speech that is not part of a turn (gizmo-ready, gizmo-fail). It plays after whatever is queued. */
function speakAside(id: string, text: string, listenAfter = false): void {
  queuedText.set(id, text);
  if (listenAfter) asideListen = true;
  player.append([{ id, text }]);
}

function wantsGizmoOffer(): boolean {
  return st().response?.gizmo_offer.recommended === true && !gizmoSession.offeredThisSession;
}

function startGizmoOffer(t: Turn): void {
  gizmoSession.offeredThisSession = true;
  patch({ gizmo: { status: "offered" } });
  gizmoLog("offered");
  t.pendingOffer = true; // set before speaking, so a button press during the line is already an answer
  t.stage = "gizmoSpeech";
  setPhase("speaking");
  queue(t, [{ id: "gizmo-offer", text: "Want an interactive diagram for this?" }], "speak");
}

/** The offer is settled: carry on with the check question as usual. */
function continueAfterOffer(t: Turn): void {
  t.pendingOffer = false;
  t.stage = "generating";
  t.streamDone = true;
  t.playerIdle = true;
  advance(t);
}

function declineGizmo(): void {
  if (st().gizmo.status === "offered") {
    patch({ gizmo: { status: "none" } });
    gizmoLog("declined");
  }
}

/**
 * Starts the build without awaiting it. It has its own AbortController: a new capture, ask, interrupt or
 * shut-up does not abort it. Only card-close does. A second accept while one is running is ignored.
 */
function acceptGizmo(resp: TutorResponse, question: string): void {
  if (gizmoAc !== null) {
    gizmoLog("accept ignored: a build is already running");
    return;
  }
  const ac = new AbortController();
  gizmoAc = ac;
  const session = sessionSeq;
  gizmoSession.offeredThisSession = true;
  patch({ gizmo: { status: "building" } });
  gizmoLog("building");
  void generateGizmo(buildGizmoRequest(resp, question), { signal: ac.signal, timeoutMs: 60000 }).then((res) => {
    if (ac.signal.aborted) {
      gizmoLog("result dropped: card closed");
      return;
    }
    if (gizmoAc === ac) gizmoAc = null;
    // Speak only into the same session, and only between segments. Otherwise the card just updates.
    const speakOk = session === sessionSeq && !player.isPlaying();
    if (res.ok && res.html) {
      patch({ gizmo: { status: "ready", html: res.html } });
      gizmoLog(`ready in ${res.ms} ms`);
      invoke(CMD.showWindow, { label: "gizmo" }).catch((err) =>
        console.warn("[brain] show gizmo window failed:", errMsg(err)),
      );
      if (speakOk) speakAside("gizmo-ready", "Your diagram is ready.");
      else gizmoLog("ready, not spoken (session moved on)");
    } else {
      patch({ gizmo: { status: "failed" } });
      gizmoLog(`failed after ${res.ms} ms: ${res.error ?? "unknown"}`);
      if (speakOk) {
        gizmoFailedQuestion = question;
        speakAside("gizmo-fail", "I couldn't build the diagram in time. Want me to draw it on the whiteboard instead?", true);
      } else gizmoLog("failed, not spoken (session moved on)");
    }
  });
}

/** The student's answer to the offer. Empty or no answer counts as no. Any other question is a normal follow-up. */
function answerOffer(t: Turn, text: string): void {
  if (!isCurrent(t) || !t.pendingOffer) return;
  cancelMicTimer();
  if (t.stage === "gizmoSpeech") player.stop(); // a press during the offer line cuts it short
  const a = text.trim();
  if (a && wantsWhiteboard(a) && !isEcho(a)) {
    // "Use the whiteboard" is neither a yes nor a no: skip the diagram and answer on the board.
    t.pendingOffer = false;
    declineGizmo();
    gizmoLog("offer skipped: whiteboard requested");
    void ask(a);
    return;
  }
  if (ACCEPT_RE.test(a)) {
    const r = st().response;
    if (r) acceptGizmo(r, t.question);
    continueAfterOffer(t);
    return;
  }
  if (a && !DECLINE_RE.test(a)) {
    if (isEcho(a)) {
      console.info("[brain] dropped echo transcript:", a);
      scheduleMic(() => answerOffer(t, ""));
      return;
    }
    t.pendingOffer = false;
    gizmoLog("offer skipped: follow-up question");
    void ask(a);
    return;
  }
  declineGizmo();
  continueAfterOffer(t);
}

/** Move the turn forward once the stream and the speech queue are both done. */
function advance(t: Turn): void {
  if (!isCurrent(t) || !t.playerIdle) return;

  const ix = t.interruption;
  if (ix) {
    switch (ix.stage) {
      case "whichpart":
        ix.stage = "recording";
        void openMicForInterrupt(t, ix);
        return;
      case "answering":
        if (ix.streamDone) finishSide(t);
        return;
      case "back":
        resume(t);
        return;
      default:
        return; // recording: waits for stt:final
    }
  }

  switch (t.stage) {
    case "generating":
    case "feedback": {
      if (!t.streamDone) return;
      if (t.stage === "generating" && wantsGizmoOffer()) {
        startGizmoOffer(t); // after the last main segment, before the check question
        return;
      }
      const next = nextCheck(t);
      if (next) startCheckSpeech(t, next);
      else endSession(t);
      return;
    }
    case "frozen":
      if (t.frozenMicPending) {
        t.frozenMicPending = false;
        void openMicFrozen(t);
      }
      return;
    case "checkSpeech":
      t.stage = "awaitingAnswer";
      void openMicForCheck(t);
      return;
    case "ending":
      t.stage = "done";
      setPhase("idle", "parked sentence done");
      return;
    case "gizmoSpeech":
      t.stage = "gizmoAsk";
      t.pendingOffer = true;
      setPhase("listening");
      scheduleMic(() => answerOffer(t, "")); // no mic: treat as no answer
      return;
    default:
      return;
  }
}

/** A short, user-facing message for an error from Claude, the key store or the network. */
function friendlyError(err: unknown): string {
  const msg = errMsg(err);
  if (/Anthropic key missing/i.test(msg)) return "Anthropic key missing — add it in Settings → Keys";
  if (/connection|network|failed to fetch|ENOTFOUND|ECONN|timed out|timeout/i.test(msg)) {
    return "I couldn't reach Claude. Check your connection and try again.";
  }
  return msg.slice(0, 160);
}

/** Stop everything for this turn, show the error, and reopen the mic so the student can just ask again. */
async function recoverToListening(message: string): Promise<void> {
  turn?.ac.abort();
  turn = null;
  player.stop();
  patch({ error: message, partialTranscript: "" });
  setPhase("listening");
  await micCancel();
  scheduleMic(() => undefined); // no retry loop: if the mic is down, the error stands and the typed box is the fallback
}

function fail(t: Turn, err: unknown): void {
  if (!isCurrent(t)) return; // a cancelled turn's error is expected noise
  console.warn("[brain] error:", errMsg(err));
  t.stage = "done";
  t.interruption = null;
  void recoverToListening(friendlyError(err));
}

/** Space-bar interruption: pause the main explanation and start the "which part" or push-to-talk step. */
function pauseMain(): PausePoint {
  const s = st();
  const fallback = s.spokenSegmentIds[s.spokenSegmentIds.length - 1] ?? s.response?.segments[0]?.id ?? "";
  return player.pause() ?? { segmentId: s.currentSegmentId ?? fallback, fractionPlayed: 0 };
}

function isMainSpeech(t: Turn): boolean {
  return st().phase === "speaking" && t.stage === "generating" && !t.interruption && !t.speakingSide;
}

function startInterruption(t: Turn, pp: PausePoint, mode: "hold" | "tap"): void {
  const ix: Interruption = {
    pp,
    mode,
    stage: mode === "tap" ? "whichpart" : "recording",
    objection: "",
    streamDone: false,
    finalCheck: "",
  };
  t.interruption = ix;
  t.speakingSide = false;
  setPhase("interrupted");
  if (mode === "tap") {
    const shapeIds = (st().response?.shapes ?? []).filter((s) => s.segment_id === pp.segmentId).map((s) => s.id);
    patch({ pulseShapeIds: shapeIds });
    queue(t, [{ id: "whichpart", text: "Which part?" }], "speak");
  } else {
    t.playerIdle = true; // nothing is playing while the student speaks
    void openMicForInterrupt(t, ix, true); // push-to-talk is an explicit open
  }
}

function onSpaceHoldEnd(): void {
  const t = turn;
  const ix = t?.interruption;
  const holdingObjection = !!ix && ix.mode === "hold" && ix.stage === "recording";
  const holdingFollowUp = t?.stage === "frozen" && t.freezeMode === "hold";
  if (micTimer !== null && (holdingObjection || holdingFollowUp)) {
    cancelMicTimer(); // released before the mic opened: nothing was said
    if (holdingObjection && t) beginBack(t);
    else resumeOrIdle();
    return;
  }
  if (holdingObjection || holdingFollowUp || st().phase === "listening") {
    invoke(CMD.sttStop)
      .then(() => setMicOpen(false))
      .catch((err) => console.warn("[brain] stt_stop failed:", errMsg(err)));
  }
}

async function micCancel(): Promise<void> {
  await invoke(CMD.sttCancel).catch(() => undefined);
  setMicOpen(false);
}

function openMicFrozen(t: Turn, force = false): void {
  patch({ partialTranscript: "" });
  scheduleMic(() => {
    if (!isCurrent(t)) return;
    patch({ error: MIC_DOWN });
    setPhase("listening"); // typed box is the fallback
  }, force);
}

/** Snapshot where the main answer stopped, for a follow-up question or a resume. Call before stopping the turn. */
function computeFreezeCtx(t: Turn | null): FollowUpCtx {
  const s = st();
  const main = s.response?.segments ?? [];
  const shapes = s.response?.shapes ?? [];
  const pp: PausePoint | null = t?.interruption?.pp ?? player.pause();
  let from = main.length;
  if (pp) {
    const idx = main.findIndex((x) => x.id === pp.segmentId);
    if (idx >= 0) from = pp.fractionPlayed < 0.5 ? idx : idx + 1;
  }
  return {
    previousQuestion: s.question ?? "",
    spokenSegments: main.slice(0, from),
    shapes,
    pulseIds: pp ? shapes.filter((x) => x.segment_id === pp.segmentId).map((x) => x.id) : [],
    from,
    resumable: from < main.length,
  };
}

/** Stop generation, verification, rewrites and speech. The drawn shapes and captions stay as they are. */
function freezeMain(): FollowUpCtx {
  const t = turn;
  const live = t !== null && t.stage !== "frozen" && t.stage !== "done";
  t?.ac.abort(); // aborts the stream, the verifier, rewrites and any side note; their results are ignored
  turn = null;
  if (live || pendingFollowUp === null) pendingFollowUp = computeFreezeCtx(live ? t : null);
  player.stop();
  return pendingFollowUp;
}

/** Interrupt from any phase. Side-note interruption only when the main answer is complete and speaking. */
async function onInterrupt(mode: "hold" | "tap" | "interrupt"): Promise<void> {
  const t = turn;
  const ph = st().phase;
  if (ph === "idle" || ph === "capturing" || ph === "targeting") return;
  if (ph === "listening" || (ph === "checking" && t?.stage === "awaitingAnswer")) {
    if (mode !== "tap") openMicNow(); // push-to-talk or interrupt opens a closed mic
    return;
  }
  if (t && t.stage === "frozen") return; // a follow-up mic is already open
  if (ph === "interrupted" && t?.interruption && (t.interruption.stage === "recording" || t.interruption.stage === "whichpart")) return;

  if (t && t.streamDone && isMainSpeech(t)) {
    startInterruption(t, pauseMain(), mode === "tap" ? "tap" : "hold");
    return;
  }

  // Anywhere else: freeze what is shown and ask for the student's next question.
  const heardNothing = !t?.audioStarted;
  const ctx = freezeMain();
  if (heardNothing) patch({ caption: "Go ahead, I'm listening" });
  const t2 = beginTurn(ctx.previousQuestion, "frozen");
  t2.freezeMode = mode;
  t2.streamDone = true;
  setPhase("interrupted");
  await micCancel(); // a mic left open from the check step must not double up
  if (mode === "tap" && ctx.spokenSegments.length > 0) {
    patch({ pulseShapeIds: ctx.pulseIds });
    t2.frozenMicPending = true;
    queue(t2, [{ id: "whichpart", text: "Which part?" }], "speak");
    return;
  }
  openMicFrozen(t2, mode !== "tap");
}

/** Shut up: stop everything now, keep the card and shapes, and listen for a new question with follow-up context. */
async function onShutUp(): Promise<void> {
  const ph = st().phase;
  if (ph === "idle" || ph === "capturing" || ph === "targeting") return;
  console.info("[brain] shut up");
  freezeMain();
  await micCancel();
  await startListening();
}

async function onEscape(): Promise<void> {
  const ph = st().phase;
  if (ph === "idle") return;
  if (ph === "targeting" || ph === "listening" || ph === "capturing") await handleIntent({ type: "cancel" });
  else await onShutUp();
}

/** Empty transcript after a freeze: resume the frozen answer if it has more to say, else go idle. */
function resumeOrIdle(): void {
  const ctx = pendingFollowUp;
  pendingFollowUp = null;
  if (!ctx || !ctx.resumable) {
    patch({ error: "I didn't catch that." });
    setPhase("idle", "nothing to resume");
    return;
  }
  const main = st().response?.segments ?? [];
  const t = beginTurn(ctx.previousQuestion);
  patch({ question: ctx.previousQuestion || null });
  t.streamDone = true; // the frozen stream is gone; play what is left, then end
  setPhase("speaking");
  queue(t, main.slice(ctx.from), "speak");
}

/**
 * Full reset of the conversational context for a new session: aborts every in-flight model call
 * (stream, verifier checks, rewrites), stops speech and the mic, and forgets the previous question,
 * answer, follow-up context, side note, contested points, parked items, cached audio and echo history.
 * Settings are kept (resetSession keeps them), and so is a diagram build that is already running.
 */
function resetConversation(reason: string): void {
  console.info("[brain] fresh context:", reason);
  cancelAll(); // aborts the turn's AbortController, which also aborts its gate (stream, checks, rewrites)
  pendingFollowUp = null;
  sessionSeq++;
  resetOffer(); // also clears gizmoFailedQuestion and asideListen
  recentSpoken.length = 0;
  queuedText.clear();
  player.reset();
  st().resetSession();
}

/** Cancel everything and clear the card. Used by card-close, cancel and Escape while targeting or listening. */
function closeCard(): void {
  resetConversation("card closed");
  endGizmoSession();
  patch({ notice: null }); // the notice lasts for the session only
  setPhase("idle", "card closed");
}

/** The student's objection arrived: stream a side note answer about the paused segment. */
async function handleObjection(t: Turn, ix: Interruption, text: string): Promise<void> {
  const objection = text.trim();
  patch({ pulseShapeIds: [] });
  const cap = st().fullCapture;
  if (!objection || !cap) {
    beginBack(t); // empty objection: resume straight away
    return;
  }

  ix.stage = "answering";
  ix.objection = objection;
  t.speakingSide = true;
  t.sideSpeechStarted = false;
  patch({ sideNote: { segments: [], shapes: [] }, question: objection }); // the card shows what the student said
  setPhase("thinking");

  const main = st().response?.segments ?? [];
  const pIdx = main.findIndex((s) => s.id === ix.pp.segmentId);
  const spokenSegments = pIdx < 0 ? [] : main.slice(0, pIdx + 1);
  const segmentText = pIdx < 0 ? "" : main[pIdx].text;
  try {
    const final = await streamTutor(
      {
        capture: cap,
        question: t.question,
        settings: st().settings,
        signal: t.ac.signal,
        surfaceHint: st().response?.surface,
        interruption: {
          segmentId: ix.pp.segmentId,
          segmentText,
          spokenSegments,
          shapes: st().response?.shapes ?? [],
          objection,
        },
      },
      sideHandlers(t, () => isCurrent(t) && t.interruption === ix),
    );
    if (!isCurrent(t) || t.interruption !== ix) return;
    ix.streamDone = true;
    ix.finalCheck = final.check_question ?? "";
    maybeShowWhiteboardForSide(t, final.surface);
    advance(t);
  } catch (err) {
    fail(t, err);
  }
}

/** Side answer finished and spoken: log the contested point, then say "Back to where we were…". */
function finishSide(t: Turn): void {
  const ix = t.interruption;
  if (!ix) return;
  const sn = st().sideNote;
  const resolution = (sn?.segments ?? []).map((s) => s.text).join(" ");
  const pIdx = (st().response?.segments ?? []).findIndex((s) => s.id === ix.pp.segmentId);
  const segmentText = pIdx < 0 ? "" : (st().response?.segments[pIdx]?.text ?? "");
  patch({
    contested: [
      ...st().contested,
      { segmentId: ix.pp.segmentId, segmentText, objection: ix.objection, resolution },
    ],
  });
  const sc = ix.finalCheck.trim();
  if (sc) t.sideCheck = sc;
  publishCheck(t);
  beginBack(t);
}

function beginBack(t: Turn): void {
  const ix = t.interruption;
  if (!ix) return;
  ix.stage = "back";
  t.speakingSide = false;
  setPhase("speaking");
  queue(t, [{ id: "back", text: "Back to where we were…" }], "speak");
}

/** Resume the main explanation from the paused segment, or from the next one if it was mostly heard. */
function resume(t: Turn): void {
  const ix = t.interruption;
  if (!ix) return;
  const main = st().response?.segments ?? [];
  const idx = main.findIndex((s) => s.id === ix.pp.segmentId);
  const from = idx < 0 ? main.length : ix.pp.fractionPlayed < 0.5 ? idx : idx + 1;
  t.interruption = null;
  t.speakingSide = false;
  t.sideSpeechStarted = false;
  patch({ sideNote: null, pulseShapeIds: [], question: t.question || null }); // back to the original question

  if (from < main.length) {
    setPhase("speaking");
    queue(t, main.slice(from), "speak"); // includes segments streamed while interrupted
    return;
  }
  if (t.streamDone) {
    advance(t);
    return;
  }
  setPhase("thinking"); // further main segments will be appended as they arrive
}

async function handleCheckAnswer(t: Turn, answer: string): Promise<void> {
  const cap = st().fullCapture;
  const check = t.lastCheck ?? "";
  if (!answer.trim() || !cap) {
    endSession(t);
    return;
  }
  if (wantsWhiteboard(answer) && st().response?.surface !== "whiteboard") {
    console.info("[brain] whiteboard requested in a check answer: answering it as a follow-up");
    freezeMain();
    await ask(answer);
    return;
  }
  t.stage = "feedback";
  t.streamDone = false;
  t.followUp = null;
  t.speakingSide = true;
  t.sideSpeechStarted = false;
  patch({ sideNote: { segments: [], shapes: [] } });
  setPhase("thinking");
  try {
    const final = await streamTutor(
      {
        capture: cap,
        question: t.question,
        settings: st().settings,
        signal: t.ac.signal,
        surfaceHint: st().response?.surface,
        previousConcept: st().response?.concept || undefined,
        checkAnswer: { checkQuestion: check, answer },
      },
      sideHandlers(t, () => isCurrent(t) && t.stage === "feedback"),
    );
    if (!isCurrent(t) || t.stage !== "feedback") return;
    const next = (final.check_question ?? "").trim();
    // At most one follow-up: only when the new question differs and this is the first feedback round.
    t.followUp = next && next !== check && t.checkRounds < 2 ? next : null;
    maybeShowWhiteboardForSide(t, final.surface);
    t.streamDone = true;
    advance(t);
  } catch (err) {
    fail(t, err);
  }
}

async function askStreaming(t: Turn, input: TutorCallInput): Promise<void> {
  const final = await streamTutor(input, mainHandlers(t));
  if (!isCurrent(t)) return;
  t.streamDone = true;
  commitResponse(t, final);
  advance(t);
}

function live(t: Turn, g: Gate): boolean {
  return isCurrent(t) && t.gate === g;
}

/** Commit only the meta of the final response (check, parked, grounding). Segments and shapes come through the gate. */
function commitMetaOnly(t: Turn, r: TutorResponse): void {
  const check = (r.check_question ?? "").trim();
  t.checkQuestion = check ? check : null;
  const s = st();
  st().setMeta({ concept: r.concept, surface: r.surface, grounding: r.grounding, gizmo_offer: r.gizmo_offer });
  patch({ sourceLabel: sourceLabelFor(r.grounding) ?? s.sourceLabel, parked: mergeUnique(s.parked, r.parked) });
  publishCheck(t);
  maybeShowWhiteboard(t, r.surface);
}

function publishVerifier(g: Gate): void {
  patch({ verifier: { ran: g.ranAny, verdict: g.droppedAny ? "fail" : "pass", ms: g.maxMs, claims: [...g.claims] } });
}

function addClaims(g: Gate, claims: string[]): void {
  for (const c of claims) {
    if (g.claims.length >= 3) return;
    if (!g.claims.includes(c)) g.claims.push(c);
  }
}

/** Release every resolved segment at the front of the gate, in order. */
function pump(t: Turn, g: Gate): void {
  if (!live(t, g)) return;
  while (g.released < g.entries.length) {
    const e = g.entries[g.released];
    if (e.state === "pending") break;
    g.released += 1;
    e.released = true;
    if (e.state === "dropped") continue;
    takeOverResponse(t);
    st().appendSegment(e.seg);
    for (const sh of g.shapes.get(e.seg.id) ?? []) st().appendShape(sh);
    g.shapes.delete(e.seg.id);
    if (!t.interruption) queue(t, [e.seg], "append"); // during an interruption the segment waits for resume()
  }
  maybeFinish(t, g);
}

function maybeFinish(t: Turn, g: Gate): void {
  if (!live(t, g) || !g.streamEnded || g.released < g.entries.length || t.streamDone) return;
  t.streamDone = true;
  advance(t);
}

function onGatedSegment(t: Turn, g: Gate, base: TutorCallInput, seg: Segment): void {
  if (!live(t, g)) return;
  markFirstSegment(t);
  if (st().phase === "thinking") setPhase("verifying");
  const index = g.entries.length;
  const entry: GateEntry = { seg, state: "pending", released: false };
  g.entries.push(entry);
  g.byId.set(seg.id, entry);
  const previous = g.entries.slice(0, index).map((e) => e.seg);
  // Synthesise speech while the verifier runs, so a passing sentence plays without a synth delay.
  player.warm([seg]);
  void verifySegment({
    capture: base.capture,
    question: base.question,
    segment: seg,
    previous,
    settings: base.settings,
    signal: g.ac.signal,
  }).then((r) => onGatedVerdict(t, g, base, entry, index, r));
}

function onGatedVerdict(
  t: Turn,
  g: Gate,
  base: TutorCallInput,
  entry: GateEntry,
  index: number,
  r: { ran: boolean; ok: boolean; claims: string[]; ms: number },
): void {
  if (!live(t, g)) return;
  g.ranAny = g.ranAny || r.ran;
  g.droppedAny = g.droppedAny || !r.ok;
  if (!r.ok) addClaims(g, r.claims);
  g.maxMs = Math.max(g.maxMs, r.ms);

  // Nothing has been spoken while the first sentence is pending: regenerate the whole answer once.
  if (!r.ok && index === 0 && g.allowRegen) {
    console.info("[brain] first segment failed verification, regenerating once", r.claims);
    entry.state = "dropped";
    publishVerifier(g);
    setPhase("thinking");
    g.ac.abort(); // the old stream's rejection is ignored: its gate is no longer live
    void runGatedAttempt(t, { ...base, critique: r.claims }, false, {
      ranAny: g.ranAny,
      droppedAny: g.droppedAny,
      maxMs: g.maxMs,
      claims: g.claims,
    });
    return;
  }

  if (r.ok) {
    entry.state = "ok";
    publishVerifier(g);
    pump(t, g);
    return;
  }

  // A later sentence failed: rewrite it in place. It stays pending, so the gate keeps releasing in order.
  // The verdict stays "fail" (badge) whatever the rewrite returns.
  entry.state = "pending";
  publishVerifier(g);
  console.info("[brain] verifier flagged segment", entry.seg.id, "(rewriting)", r.claims);
  void rewriteSentence({
    capture: base.capture,
    question: base.question,
    segment: entry.seg,
    previous: g.entries.slice(0, index).map((e) => e.seg),
    claims: r.claims,
    settings: base.settings,
    signal: g.ac.signal,
  }).then((rw) => {
    if (!live(t, g)) return;
    g.maxMs = Math.max(g.maxMs, r.ms + rw.ms);
    if (rw.ok && rw.text.trim()) {
      entry.seg = { ...entry.seg, text: rw.text.trim() }; // same id, so the shapes still line up
      console.info("[brain] rewrote segment", entry.seg.id);
    }
    entry.state = "ok";
    publishVerifier(g);
    pump(t, g);
  });
}

function onGatedShape(t: Turn, g: Gate, shape: Shape): void {
  if (!live(t, g)) return;
  const e = g.byId.get(shape.segment_id);
  if (e?.state === "dropped") return; // dropped with its segment
  if (e?.released && e.state === "ok") {
    st().appendShape(shape);
    return;
  }
  const list = g.shapes.get(shape.segment_id) ?? [];
  list.push(shape);
  g.shapes.set(shape.segment_id, list);
}

/** One streamed attempt with per-segment verification. Resolves when the stream ends; release happens in pump(). */
function runGatedAttempt(t: Turn, base: TutorCallInput, allowRegen: boolean, carry?: VerifierStats): Promise<void> {
  const g: Gate = {
    ac: new AbortController(),
    entries: [],
    byId: new Map(),
    shapes: new Map(),
    released: 0,
    streamEnded: false,
    allowRegen,
    ranAny: carry?.ranAny ?? false,
    droppedAny: carry?.droppedAny ?? false,
    maxMs: carry?.maxMs ?? 0,
    claims: [...(carry?.claims ?? [])],
  };
  t.gate = g;
  const onTurnAbort = () => g.ac.abort();
  t.ac.signal.addEventListener("abort", onTurnAbort, { once: true });

  const handlers: TutorStreamHandlers = {
    onFirstToken: () => markFirstToken(t),
    onMeta: (m) => applyMeta(t, m, "buffered"), // concept and source only; the rest waits for the end
    onSegment: (seg) => onGatedSegment(t, g, base, seg),
    onShape: (shape) => onGatedShape(t, g, shape),
  };
  return streamTutor({ ...base, signal: g.ac.signal }, handlers)
    .then((final) => {
      if (!live(t, g)) return;
      g.streamEnded = true;
      commitMetaOnly(t, final);
      maybeFinish(t, g);
    })
    .catch((err) => {
      if (!live(t, g)) return;
      fail(t, err);
    })
    .finally(() => t.ac.signal.removeEventListener("abort", onTurnAbort));
}

async function ask(question: string, opts: { surfaceHint?: "whiteboard" } = {}): Promise<void> {
  const q = question.trim();
  if (!q) return;
  cancelMicTimer(); // a reopen scheduled for a dropped utterance must not fire into this turn
  const cap = st().fullCapture;
  if (!cap) {
    patch({ error: "No screen capture yet — click the bubble first" });
    setPhase("idle", "no screen capture");
    return;
  }
  // A previous answer this session stays drawn until the new answer takes over (first segment) or the tutor says the topic changed.
  const prev = st().response;
  const keep = !!prev && (prev.segments.length > 0 || prev.shapes.length > 0);
  const followUp = pendingFollowUp;
  pendingFollowUp = null;
  gizmoFailedQuestion = null;
  cancelAll();
  const t = beginTurn(q);
  t.replaceResponse = keep;
  patch({
    question: q,
    response: keep ? prev : null,
    checkQuestion: null,
    sourceLabel: null,
    ...(keep ? {} : { currentSegmentId: null, spokenSegmentIds: [] }), // kept drawings stay visible until takeover
    caption: "",
    sideNote: null,
    pulseShapeIds: [],
    verifier: null,
    error: null,
    partialTranscript: "",
    timings: { captureAt: st().timings.captureAt }, // keep the capture time, drop per-answer timings
  });
  setPhase("thinking");
  const hint = opts.surfaceHint ?? (wantsWhiteboard(q) ? "whiteboard" : undefined);
  if (hint === "whiteboard" && !opts.surfaceHint) console.info("[brain] whiteboard requested: forcing surface whiteboard");
  const input: TutorCallInput = {
    capture: cap,
    question: q,
    settings: st().settings,
    signal: t.ac.signal,
    surfaceHint: hint,
    previousConcept: keep && prev ? prev.concept || undefined : undefined,
    followUp: followUp
      ? {
          previousQuestion: followUp.previousQuestion,
          spokenSegments: followUp.spokenSegments,
          shapes: followUp.shapes,
          note: "The student interrupted you.",
        }
      : undefined,
  };
  try {
    // No whole-answer regeneration: a flagged first sentence is rewritten in place like any other,
    // instead of throwing the answer away and making a second Opus call with a critique.
    if (input.settings.verifierEnabled) await runGatedAttempt(t, input, false);
    else await askStreaming(t, input);
  } catch (err) {
    fail(t, err);
  }
}

async function runCapture(req: CaptureRequest, fixture?: string): Promise<boolean> {
  resetConversation(`new capture (${req.mode})`); // a new capture is a new session: nothing from the last one is kept
  setPhase("capturing");
  patch({ mode: req.mode, isFixture: !!fixture, timings: { captureAt: Date.now() } });
  try {
    const res = await invoke<CaptureResult>(CMD.capture, {
      mode: req.mode,
      region: req.region ?? null,
      fixture: fixture ?? null,
    });
    patch({ fullCapture: res, capture: { ...res, imageBase64: "" } });
    return true;
  } catch (err) {
    console.warn("[brain] capture failed:", errMsg(err));
    setPhase("idle", "capture failed");
    patch({ error: `Capture failed: ${errMsg(err)}` });
    return false;
  }
}

async function handleTargetCommit(i: Extract<UiIntent, { type: "target-commit" }>): Promise<void> {
  if (blockedForSetup()) return;
  if (await runCapture({ mode: i.mode, region: i.region })) await startListening(); // mic opens straight away
}

/** Debug region as "x,y,w,h" or {x,y,w,h}; read defensively because DebugInject does not declare it. */
function parseRegion(v: unknown): RectPts | undefined {
  if (typeof v === "string") {
    const n = v.split(",").map((x) => Number(x.trim()));
    return n.length === 4 && n.every(Number.isFinite) ? { x: n[0], y: n[1], w: n[2], h: n[3] } : undefined;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const { x, y, w, h } = o;
    if ([x, y, w, h].every((k) => typeof k === "number" && Number.isFinite(k))) {
      return { x: x as number, y: y as number, w: w as number, h: h as number };
    }
  }
  return undefined;
}

async function handleDebugInject(d: DebugInject): Promise<void> {
  if (blockedForSetup()) return;
  runOverride = d.tts;
  const region = parseRegion((d as { region?: unknown }).region);
  if (!(await runCapture({ mode: d.mode ?? "click", region }, d.capture))) return;

  if (d.shapes) {
    // Canned response from disk: no API call. Wire JSON is converted to the friendly TutorResponse.
    try {
      const text = await invoke<string>("read_debug_file", { path: d.shapes });
      const resp = wireToTutorResponse(JSON.parse(text));
      const t = beginTurn(d.question ?? "");
      patch({ question: d.question ?? null });
      commitAndSpeak(t, resp);
    } catch (err) {
      console.warn("[brain] debug shapes failed:", errMsg(err));
      setPhase("idle", "debug shapes failed");
      patch({ error: `Debug shapes failed: ${errMsg(err)}` });
    }
    return;
  }
  if (d.question) {
    await ask(d.question);
    return;
  }
  await startListening();
}

async function handleIntent(i: UiIntent): Promise<void> {
  switch (i.type) {
    case "bubble-click":
      if (blockedForSetup()) return;
      if (await runCapture({ mode: "click" })) await startListening();
      return;
    case "target-start":
      setPhase("targeting");
      return;
    case "target-commit":
      await handleTargetCommit(i);
      return;
    case "typed-question": {
      if (blockedForSetup()) return;
      // After a session has ended (idle, nothing pending) a typed question is a new session:
      // take a fresh screenshot instead of answering about the old one.
      const ended = st().phase === "idle" && pendingFollowUp === null && !turn?.pendingOffer && gizmoFailedQuestion === null;
      if ((!st().fullCapture || ended) && !(await runCapture({ mode: "click" }))) return;
      const t = turn;
      if (t?.pendingOffer) {
        answerOffer(t, i.text);
        return;
      }
      if (gizmoFailedQuestion !== null) {
        const q = gizmoFailedQuestion;
        gizmoFailedQuestion = null;
        if (ACCEPT_RE.test(i.text.trim())) {
          await ask(q, { surfaceHint: "whiteboard" });
          return;
        }
      }
      if (st().phase === "checking" && t?.stage === "awaitingAnswer") {
        await handleCheckAnswer(t, i.text); // a typed answer counts as the check answer
        return;
      }
      await ask(i.text);
      return;
    }
    case "cancel":
    case "card-close":
      closeCard();
      return;
    case "shut-up":
      await onShutUp();
      return;
    case "interrupt":
      await onInterrupt("interrupt");
      return;
    case "ask-parked": {
      const s = st();
      const q = s.parked[i.index];
      if (q === undefined) return;
      patch({ parked: s.parked.filter((_, k) => k !== i.index) });
      await ask(q);
      return;
    }
    case "settings-changed": {
      // Applied live (voice, models, provider are read per call) and persisted, without secrets.
      const next = mergeSettings(st().settings, i.settings);
      patch({ settings: next });
      saveSettings(next);
      void refreshNeedsSetup();
      return;
    }
    case "accept-gizmo": {
      const t = turn;
      if (t?.pendingOffer) answerOffer(t, "yes");
      else console.info("[brain] accept-gizmo with no pending offer");
      return;
    }
    case "decline-gizmo": {
      const t = turn;
      if (t?.pendingOffer) answerOffer(t, "no");
      else declineGizmo();
      return;
    }
    case "open-whiteboard":
      console.info("[brain] intent not handled in this milestone:", i.type);
      return;
  }
}

function onSegmentStarted(id: string): void {
  const t = turn;
  if (t) recordFirstAudio(t, id);
  if (id === "back") patch({ sideNote: null }); // views fade the side note out as "Back to where we were" starts
  const before = st();
  const spokenText = textFor(id);
  if (spokenText) {
    recentSpoken.push(spokenText);
    if (recentSpoken.length > 3) recentSpoken.shift();
  }
  patch({
    currentSegmentId: id,
    caption: spokenText,
    spokenSegmentIds: before.spokenSegmentIds.includes(id)
      ? before.spokenSegmentIds
      : [...before.spokenSegmentIds, id],
  });
  const ph = before.phase;
  if (ph === "thinking" || ph === "verifying") setPhase("speaking");
}

function onPlayerIdle(): void {
  patch({ currentSegmentId: null });
  // Ignore stale idle callbacks from a stopped queue while new speech is already playing.
  if (player.isPlaying()) return;
  if (asideListen) {
    asideListen = false;
    if (st().phase === "idle") {
      setPhase("listening");
      scheduleMic(() => patch({ error: MIC_DOWN }));
    }
  }
  if (!turn) return;
  turn.playerIdle = true;
  advance(turn);
}

/**
 * Latency for the card: first spoken word of this turn's main answer (the capture→first word target).
 * Recorded once per turn.
 */
function recordFirstAudio(t: Turn, id: string): void {
  if (t.audioStarted) return;
  const s = st();
  const isMain = t.stage === "generating" && !t.speakingSide && !t.interruption && !SPECIAL_IDS.has(id);
  if (!isMain) return;
  t.audioStarted = true;
  const now = Date.now();
  const tm = s.timings;
  patch({ timings: { ...tm, firstAudioAt: now } });
  const delta = (a?: number, b?: number) => (a !== undefined && b !== undefined ? `${a - b}ms` : "n/a");
  console.info(
    "[brain] first audio:",
    "capture→audio",
    delta(now, tm.captureAt),
    "ask→token",
    delta(t.firstTokenAt, t.askedAt),
    "ask→first segment",
    delta(t.firstSegmentAt, t.askedAt),
    "ask→audio",
    delta(now, t.askedAt),
  );
}

/** Starts the controller. Returns a cleanup function. */
export async function startController(): Promise<() => void> {
  player = createTtsPlayer({
    getVoiceId: () => st().settings.voiceId,
    getProviderOverride: () => runOverride ?? st().settings.ttsProvider, // the Rust GT_TTS ceiling still applies
    onFallback: (reason) => console.warn("[brain] tts fallback:", reason),
  });
  const offStarted = player.onSegmentStarted(onSegmentStarted);
  const offIdle = player.onIdle(onPlayerIdle);

  // Guards handler promises so an unexpected throw cannot leave the phase stuck mid-turn.
  const run = (p: Promise<void>) =>
    p.catch((err) => {
      console.error("[brain] handler failed:", err);
      void recoverToListening(friendlyError(err));
    });

  const unlisten = await Promise.all([
    listen<UiIntent>(EV.uiIntent, (e) => void run(handleIntent(e.payload))),
    listen<DebugInject>(EV.debugInject, (e) => void run(handleDebugInject(e.payload))),
    listen<SttFinal>(EV.sttFinal, (e) => {
      setMicOpen(false); // the utterance ends the mic on the Rust side
      let raw = (e.payload?.text ?? "").trim();
      const ph = st().phase;
      const t = turn;
      const frozenListen = ph === "interrupted" && t?.stage === "frozen";
      const objection = ph === "interrupted" && !frozenListen && !!t?.interruption && t.interruption.stage === "recording";
      // Very long utterances are cut to their first 120 words, and the tutor still answers.
      const parts = raw.split(/\s+/).filter(Boolean);
      if (parts.length > 120) {
        console.info("[brain] truncated transcript to 120 words");
        raw = parts.slice(0, 120).join(" ");
      }
      const words = normWords(raw).length;
      if (ph === "checking") {
        // One-word answers are valid in the check step, and it is where the tutor's own question is echoed back.
        if (t && t.stage === "awaitingAnswer") void run(handleCheckAnswer(t, raw));
        return;
      }
      if (ph === "listening" || frozenListen || objection) {
        // While a gizmo offer is pending, only a short yes/no counts as an answer.
        if (ph === "listening" && t?.pendingOffer) {
          const yesNo = ACCEPT_RE.test(raw) || DECLINE_RE.test(raw);
          if (yesNo && words <= 4) {
            answerOffer(t, raw);
          } else if (wantsWhiteboard(raw)) {
            answerOffer(t, raw);
          } else {
            console.info("[brain] ignored offer reply (not a short yes/no):", raw);
            scheduleMic(() => patch({ error: MIC_DOWN }));
          }
          return;
        }
        if (ph === "listening" && gizmoFailedQuestion !== null) {
          const q = gizmoFailedQuestion;
          gizmoFailedQuestion = null;
          if (ACCEPT_RE.test(raw)) {
            void run(ask(q, { surfaceHint: "whiteboard" }));
            return;
          }
        }
        if (raw && rejectUtterance(raw)) {
          scheduleMic(() => patch({ error: MIC_DOWN })); // stay listening, open the mic again once
          return;
        }
        const r = st().response;
        if (raw && !objection && r && isVoiceRequest(raw)) {
          gizmoLog("requested by voice");
          acceptGizmo(r, st().question ?? "");
          scheduleMic(() => patch({ error: MIC_DOWN })); // the diagram builds while we keep listening
          return;
        }
        if (objection && t?.interruption) {
          if (wantsWhiteboard(raw) && st().response?.surface !== "whiteboard") {
            // A side note is drawn on the main answer's surface: a whiteboard request becomes a follow-up answer on the board.
            console.info("[brain] whiteboard requested during an interruption: answering it as a follow-up");
            freezeMain();
            void run(ask(raw));
          } else void run(handleObjection(t, t.interruption, raw));
        } else if (raw) void run(ask(raw));
        else resumeOrIdle();
      }
    }),
    listen<SttPartial>(EV.sttPartial, (e) => {
      const ph = st().phase;
      if (ph === "listening" || ph === "checking" || ph === "interrupted") patch({ partialTranscript: e.payload.text });
    }),
    listen<SttError>(EV.sttError, (e) => {
      console.warn("[brain] stt error:", e.payload.message);
      setMicOpen(false);
      patch({ error: MIC_DOWN });
      const ph = st().phase;
      if (ph === "checking" || ph === "interrupted") setPhase("listening");
    }),
    listen<{ reason: string }>(EV.ttsFallback, (e) => {
      const reason = (e.payload?.reason ?? "").slice(0, 80);
      console.warn("[brain] tts fallback:", reason);
      patch({ notice: `ElevenLabs unavailable — using the system voice${reason ? ` (${reason})` : ""}` });
    }),
    listen("keys:changed", () => void refreshNeedsSetup()),
    listen("onboarding:show", () => void refreshNeedsSetup()),
    listen(EV.spaceTap, () => void run(onInterrupt("tap"))),
    listen(EV.spaceHoldStart, () => void run(onInterrupt("hold"))),
    listen(EV.spaceHoldEnd, () => onSpaceHoldEnd()),
    listen(EV.keyEscape, () => void run(onEscape())),
    listen(EV.hotkeyActivate, () => {
      if (st().phase === "idle") void run(handleIntent({ type: "bubble-click" }));
      else void run(handleIntent({ type: "cancel" }));
    }),
  ]);

  void refreshNeedsSetup();
  return () => {
    offStarted();
    offIdle();
    unlisten.forEach((u) => u());
    cancelAll();
  };
}
