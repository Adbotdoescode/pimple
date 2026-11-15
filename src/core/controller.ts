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
  type Segment,
  type Shape,
  type SttError,
  type SttFinal,
  type SttPartial,
  type TutorResponse,
  type UiIntent,
} from "../../shared/contracts";
import { streamTutor, type TutorCallInput, type TutorStreamHandlers } from "./claude";
import { verifySegment } from "./verifier";
import { summarizeCapture } from "./summary";
import { createTtsPlayer } from "./ttsPlayer";
import { wireToTutorResponse } from "./jsonStream";
import { sessionStore, type SessionData } from "./store";

type Player = ReturnType<typeof createTtsPlayer>;

/** Control-flow stage of a turn. The interruption, when present, has its own stage. */
type Stage =
  | "generating" // streaming or buffering the main tutor answer
  | "summary" // speaking the one-sentence summary and the prompt, then listen
  | "checkSpeech" // speaking the check question, then open the mic
  | "awaitingAnswer" // mic open for the student's check answer
  | "feedback" // streaming feedback for the check answer
  | "ending" // speaking the parked-questions sentence, then idle
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
}

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
}

let player: Player;
let turn: Turn | null = null;
let turnSeq = 0;
let runOverride: DebugInject["tts"];
/** Text of segments queued for speech, keyed by id. Covers the special ids (summary, check, back...). */
const queuedText = new Map<string, string>();
/** Ids that are not part of the main or side-note segment lists. */
const SPECIAL_IDS = new Set(["whichpart", "back", "check", "summary", "prompt", "parked"]);

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

function setPhase(phase: Phase): void {
  console.info("[brain]", phase);
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
  t.whiteboardShown = true;
  invoke(CMD.showWindow, { label: "whiteboard" }).catch((err) =>
    console.warn("[brain] show whiteboard failed:", errMsg(err)),
  );
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
  const label = sourceLabelFor(m.grounding);
  if (mode === "buffered") {
    // Buffered mode shows only the concept and source while the answer is held for verification.
    st().setMeta({ concept: m.concept });
    if (label) patch({ sourceLabel: label });
    maybeShowWhiteboard(t, m.surface);
    return;
  }
  // Segments and shapes arrive through onSegment/onShape, so they are not taken from meta.
  st().setMeta({
    concept: m.concept,
    surface: m.surface,
    grounding: m.grounding,
    gizmo_offer: m.gizmo_offer,
    summary_sentence: m.summary_sentence,
  });
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
  return {
    onMeta: (m) => {
      if (alive() && m.parked) patch({ parked: mergeUnique(st().parked, m.parked) });
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

async function startListening(): Promise<void> {
  patch({ partialTranscript: "" });
  setPhase("listening");
  try {
    await invoke(CMD.sttStart);
  } catch (err) {
    // Stay in listening so the typed box can still be used.
    console.warn("[brain] stt_start failed:", errMsg(err));
    patch({ error: "Mic unavailable — type your question" });
  }
}

async function openMicForCheck(t: Turn): Promise<void> {
  try {
    await invoke(CMD.sttStart);
  } catch (err) {
    if (!isCurrent(t)) return;
    console.warn("[brain] stt_start failed:", errMsg(err));
    t.stage = "done";
    patch({ error: "Mic unavailable — type your question" });
    setPhase("idle");
  }
}

/** Opens the mic for a push-to-talk or "which part" answer. On failure the main explanation resumes. */
async function openMicForInterrupt(t: Turn, ix: Interruption): Promise<void> {
  try {
    await invoke(CMD.sttStart);
  } catch (err) {
    if (!isCurrent(t) || t.interruption !== ix) return;
    console.warn("[brain] stt_start failed:", errMsg(err));
    patch({ error: "Mic unavailable — carrying on" });
    beginBack(t);
  }
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
  setPhase("idle");
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
      const next = nextCheck(t);
      if (next) startCheckSpeech(t, next);
      else endSession(t);
      return;
    }
    case "summary":
      t.stage = "done";
      void startListening();
      return;
    case "checkSpeech":
      t.stage = "awaitingAnswer";
      void openMicForCheck(t);
      return;
    case "ending":
      t.stage = "done";
      setPhase("idle");
      return;
    default:
      return;
  }
}

function fail(t: Turn, message: string): void {
  if (!isCurrent(t)) return; // a cancelled turn's error is expected noise
  console.warn("[brain] error:", message);
  t.stage = "done";
  t.interruption = null;
  player.stop();
  patch({ error: message });
  setPhase("idle");
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
    void openMicForInterrupt(t, ix);
  }
}

function onSpaceHoldStart(): void {
  const t = turn;
  if (!t || !isMainSpeech(t)) return;
  startInterruption(t, pauseMain(), "hold");
}

function onSpaceHoldEnd(): void {
  const ix = turn?.interruption;
  if (ix && ix.mode === "hold" && ix.stage === "recording") {
    invoke(CMD.sttStop).catch((err) => console.warn("[brain] stt_stop failed:", errMsg(err)));
    return;
  }
  if (st().phase === "listening") {
    invoke(CMD.sttStop).catch((err) => console.warn("[brain] stt_stop failed:", errMsg(err)));
  }
}

function onSpaceTap(): void {
  const t = turn;
  if (!t || !isMainSpeech(t)) return;
  startInterruption(t, pauseMain(), "tap");
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
  patch({ sideNote: { segments: [], shapes: [] } });
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
    advance(t);
  } catch (err) {
    fail(t, errMsg(err));
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
  patch({ sideNote: null, pulseShapeIds: [] });

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
        checkAnswer: { checkQuestion: check, answer },
      },
      sideHandlers(t, () => isCurrent(t) && t.stage === "feedback"),
    );
    if (!isCurrent(t) || t.stage !== "feedback") return;
    const next = (final.check_question ?? "").trim();
    // At most one follow-up: only when the new question differs and this is the first feedback round.
    t.followUp = next && next !== check && t.checkRounds < 2 ? next : null;
    t.streamDone = true;
    advance(t);
  } catch (err) {
    fail(t, errMsg(err));
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
  patch({ verifier: { ran: g.ranAny, verdict: g.droppedAny ? "fail" : "pass", ms: g.maxMs } });
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
  entry.state = r.ok ? "ok" : "dropped";
  g.ranAny = g.ranAny || r.ran;
  g.droppedAny = g.droppedAny || !r.ok;
  g.maxMs = Math.max(g.maxMs, r.ms);
  publishVerifier(g);
  if (!r.ok) console.info("[brain] dropped segment", entry.seg.id, r.claims);

  // Nothing has been spoken while the first segment is pending, so regenerate once from scratch.
  if (!r.ok && index === 0 && g.allowRegen) {
    console.info("[brain] first segment failed verification, regenerating once");
    setPhase("thinking");
    g.ac.abort(); // the old stream's rejection is ignored: its gate is no longer live
    void runGatedAttempt(t, { ...base, critique: r.claims }, false, {
      ranAny: g.ranAny,
      droppedAny: g.droppedAny,
      maxMs: g.maxMs,
    });
    return;
  }
  pump(t, g);
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
      fail(t, errMsg(err));
    })
    .finally(() => t.ac.signal.removeEventListener("abort", onTurnAbort));
}

async function ask(question: string): Promise<void> {
  const q = question.trim();
  if (!q) return;
  const cap = st().fullCapture;
  if (!cap) {
    patch({ error: "No screen capture yet — click the bubble first" });
    setPhase("idle");
    return;
  }
  cancelAll();
  const t = beginTurn(q);
  patch({
    question: q,
    response: null,
    checkQuestion: null,
    sourceLabel: null,
    currentSegmentId: null,
    spokenSegmentIds: [],
    caption: "",
    sideNote: null,
    pulseShapeIds: [],
    verifier: null,
    error: null,
    partialTranscript: "",
    timings: { captureAt: st().timings.captureAt }, // keep the capture time, drop per-answer timings
  });
  setPhase("thinking");
  const input: TutorCallInput = { capture: cap, question: q, settings: st().settings, signal: t.ac.signal };
  try {
    if (input.settings.verifierEnabled) await runGatedAttempt(t, input, true);
    else await askStreaming(t, input);
  } catch (err) {
    fail(t, errMsg(err));
  }
}

async function runCapture(req: CaptureRequest, fixture?: string): Promise<boolean> {
  cancelAll();
  st().resetSession(); // a new capture starts a new session: response, shapes, sideNote, pulse ids all cleared
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
    setPhase("idle");
    patch({ error: `Capture failed: ${errMsg(err)}` });
    return false;
  }
}

/** Summary flow for region/lasso captures: one sentence on what is seen, then the prompt, then listen. */
async function startSummaryFlow(): Promise<void> {
  const cap = st().fullCapture;
  if (!cap) return;
  const t = beginTurn("", "summary");
  setPhase("summarising");
  let sentence = "";
  try {
    sentence = await summarizeCapture({ capture: cap, settings: st().settings, signal: t.ac.signal });
  } catch (err) {
    if (!isCurrent(t)) return;
    console.warn("[brain] summary failed:", errMsg(err));
    patch({ error: `Summary failed: ${errMsg(err)}` });
  }
  if (!isCurrent(t)) return;
  const segs: Segment[] = [];
  if (sentence.trim()) segs.push({ id: "summary", text: sentence.trim() });
  segs.push({ id: "prompt", text: "What do you want to ask?" });
  queue(t, segs, "speak"); // onIdle → advance() → startListening()
}

async function handleTargetCommit(i: Extract<UiIntent, { type: "target-commit" }>): Promise<void> {
  if (!(await runCapture({ mode: i.mode, region: i.region }))) return;
  await startSummaryFlow();
}

async function handleDebugInject(d: DebugInject): Promise<void> {
  runOverride = d.tts;
  if (!(await runCapture({ mode: d.mode ?? "click" }, d.capture))) return;

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
      setPhase("idle");
      patch({ error: `Debug shapes failed: ${errMsg(err)}` });
    }
    return;
  }
  if (d.question) {
    await ask(d.question);
    return;
  }
  if (d.mode === "region" || d.mode === "lasso") {
    await startSummaryFlow();
    return;
  }
  await startListening();
}

async function handleIntent(i: UiIntent): Promise<void> {
  switch (i.type) {
    case "bubble-click":
      if (await runCapture({ mode: "click" })) await startListening();
      return;
    case "target-start":
      setPhase("targeting");
      return;
    case "target-commit":
      await handleTargetCommit(i);
      return;
    case "typed-question": {
      if (!st().fullCapture && !(await runCapture({ mode: "click" }))) return;
      const t = turn;
      if (st().phase === "checking" && t?.stage === "awaitingAnswer") {
        await handleCheckAnswer(t, i.text); // a typed answer counts as the check answer
        return;
      }
      await ask(i.text);
      return;
    }
    case "cancel":
      cancelAll();
      st().resetSession();
      setPhase("idle");
      return;
    case "ask-parked": {
      const s = st();
      const q = s.parked[i.index];
      if (q === undefined) return;
      patch({ parked: s.parked.filter((_, k) => k !== i.index) });
      await ask(q);
      return;
    }
    case "settings-changed":
      patch({ settings: { ...st().settings, ...i.settings } });
      return;
    case "accept-gizmo":
    case "decline-gizmo":
    case "open-whiteboard":
      console.info("[brain] intent not handled in this milestone:", i.type);
      return;
  }
}

function onSegmentStarted(id: string): void {
  if (!turn) return;
  if (id === "back") patch({ sideNote: null }); // views fade the side note out as "Back to where we were" starts
  const before = st();
  patch({
    currentSegmentId: id,
    caption: textFor(id),
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
  if (!turn || player.isPlaying()) return;
  turn.playerIdle = true;
  advance(turn);
}

function onFirstAudio(): void {
  const now = Date.now();
  const tm = st().timings;
  patch({ timings: { ...tm, firstAudioAt: now } });
  const delta = (a?: number, b?: number) => (a !== undefined && b !== undefined ? `${a - b}ms` : "n/a");
  console.info(
    "[brain] first audio:",
    "capture→audio",
    delta(now, tm.captureAt),
    "ask→token",
    delta(turn?.firstTokenAt, turn?.askedAt),
    "ask→first segment",
    delta(turn?.firstSegmentAt, turn?.askedAt),
    "ask→audio",
    delta(now, turn?.askedAt),
  );
}

/** Starts the controller. Returns a cleanup function. */
export async function startController(): Promise<() => void> {
  player = createTtsPlayer({
    getVoiceId: () => st().settings.voiceId,
    getProviderOverride: () => runOverride,
    onFallback: (reason) => console.warn("[brain] tts fallback:", reason),
    onFirstAudio,
  });
  const offStarted = player.onSegmentStarted(onSegmentStarted);
  const offIdle = player.onIdle(onPlayerIdle);

  // Guards handler promises so an unexpected throw cannot leave the phase stuck mid-turn.
  const run = (p: Promise<void>) =>
    p.catch((err) => {
      console.error("[brain] handler failed:", err);
      cancelAll();
      patch({ error: errMsg(err) });
      setPhase("idle");
    });

  const unlisten = await Promise.all([
    listen<UiIntent>(EV.uiIntent, (e) => void run(handleIntent(e.payload))),
    listen<DebugInject>(EV.debugInject, (e) => void run(handleDebugInject(e.payload))),
    listen<SttFinal>(EV.sttFinal, (e) => {
      const text = (e.payload?.text ?? "").trim();
      const ph = st().phase;
      if (ph === "listening") {
        if (text) void run(ask(text));
        else {
          patch({ error: "I didn't catch that." });
          setPhase("idle");
        }
      } else if (ph === "checking") {
        const t = turn;
        if (t && t.stage === "awaitingAnswer") void run(handleCheckAnswer(t, text));
      } else if (ph === "interrupted") {
        const t = turn;
        const ix = t?.interruption;
        if (t && ix && ix.stage === "recording") void run(handleObjection(t, ix, text));
      }
    }),
    listen<SttPartial>(EV.sttPartial, (e) => {
      const ph = st().phase;
      if (ph === "listening" || ph === "checking" || ph === "interrupted") patch({ partialTranscript: e.payload.text });
    }),
    listen<SttError>(EV.sttError, (e) => patch({ error: e.payload.message })),
    listen(EV.spaceTap, () => onSpaceTap()),
    listen(EV.spaceHoldStart, () => onSpaceHoldStart()),
    listen(EV.spaceHoldEnd, () => onSpaceHoldEnd()),
    listen(EV.keyEscape, () => {
      if (st().phase !== "idle") void run(handleIntent({ type: "cancel" }));
    }),
    listen(EV.hotkeyActivate, () => {
      if (st().phase === "idle") void run(handleIntent({ type: "bubble-click" }));
      else void run(handleIntent({ type: "cancel" }));
    }),
  ]);

  return () => {
    offStarted();
    offIdle();
    unlisten.forEach((u) => u());
    cancelAll();
  };
}
