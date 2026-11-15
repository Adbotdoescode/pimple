import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CMD,
  EV,
  type CaptureRequest,
  type CaptureResult,
  type DebugInject,
  type Phase,
  type Segment,
  type SttError,
  type SttFinal,
  type SttPartial,
  type TutorResponse,
  type UiIntent,
} from "../../shared/contracts";
import { streamTutor, type TutorCallInput, type TutorStreamHandlers } from "./claude";
import { verifyResponse } from "./verifier";
import { summarizeCapture } from "./summary";
import { createTtsPlayer } from "./ttsPlayer";
import { wireToTutorResponse } from "./jsonStream";
import { sessionStore, type SessionData } from "./store";

type Player = ReturnType<typeof createTtsPlayer>;

/**
 * Control-flow state for one turn (one question, one summary, one check answer).
 * response / spokenSegmentIds / currentSegmentId live in sessionStore so the broadcast sees them;
 * the turn only holds what the controller needs to decide what happens next.
 */
type Stage =
  | "generating" // streaming or buffering the tutor answer
  | "summary" // speaking the one-sentence summary and the prompt, then listen
  | "checkSpeech" // speaking check_question, then open the mic
  | "awaitingAnswer" // mic open for the student's check answer
  | "feedback" // streaming feedback for the check answer
  | "done";

interface Turn {
  id: number;
  question: string;
  ac: AbortController;
  stage: Stage;
  /** The model stream (or the already-complete response) has finished. */
  streamDone: boolean;
  /** The TTS queue is empty. Set false on every queue op; set true by the player's onIdle. */
  playerIdle: boolean;
  checkQuestion: string | null;
  askedAt: number;
  firstTokenAt?: number;
  // TODO(M3): interruption state goes here (paused at PausePoint, pending objection, contested point).
}

let player: Player;
let turn: Turn | null = null;
let turnSeq = 0;
let runOverride: DebugInject["tts"];
/** Text of segments queued for speech that are not in response.segments (summary, prompt, check). */
const queuedText = new Map<string, string>();

const st = () => sessionStore.getState();
const patch = (p: Partial<SessionData>) => st().patch(p);

function setPhase(phase: Phase): void {
  console.info("[brain]", phase);
  st().setPhase(phase);
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
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
    checkQuestion: null,
    askedAt: Date.now(),
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
  const s = st();
  return (
    s.response?.segments.find((x) => x.id === id)?.text ??
    s.sideNote?.segments.find((x) => x.id === id)?.text ??
    queuedText.get(id) ??
    ""
  );
}

function queue(t: Turn, segs: Segment[], mode: "speak" | "append"): void {
  if (segs.length === 0) return; // an empty queue never reports idle, so do not mark it busy
  for (const s of segs) queuedText.set(s.id, s.text);
  t.playerIdle = false;
  if (mode === "speak") player.speak(segs);
  else player.append(segs);
}

/** Move the turn forward once the stream and the speech queue are both done. */
function advance(t: Turn): void {
  if (!isCurrent(t) || !t.playerIdle) return;
  switch (t.stage) {
    case "generating":
    case "feedback":
      if (!t.streamDone) return;
      if (t.stage === "generating" && t.checkQuestion) {
        t.stage = "checkSpeech";
        setPhase("checking");
        queue(t, [{ id: "check", text: t.checkQuestion }], "speak");
        return;
      }
      t.stage = "done";
      setPhase("idle");
      return;
    case "summary":
      t.stage = "done";
      void startListening();
      return;
    case "checkSpeech":
      t.stage = "awaitingAnswer";
      void openMicForCheck(t);
      return;
    default:
      return;
  }
}

function fail(t: Turn, message: string): void {
  if (!isCurrent(t)) return; // a cancelled turn's error is expected noise
  console.warn("[brain] error:", message);
  t.stage = "done";
  player.stop();
  patch({ error: message });
  setPhase("idle");
}

function markFirstToken(t: Turn): void {
  if (!isCurrent(t) || t.firstTokenAt !== undefined) return;
  t.firstTokenAt = Date.now();
  patch({ timings: { ...st().timings, firstTokenAt: t.firstTokenAt } });
}

function commitResponse(t: Turn, r: TutorResponse): void {
  const check = (r.check_question ?? "").trim();
  t.checkQuestion = check ? check : null;
  const s = st();
  patch({
    response: r,
    checkQuestion: t.checkQuestion,
    sourceLabel: sourceLabelFor(r.grounding) ?? s.sourceLabel,
    parked: mergeUnique(s.parked, r.parked),
  });
}

/** Commit a complete response and speak it all, then let advance() finish the turn. */
function commitAndSpeak(t: Turn, resp: TutorResponse): void {
  commitResponse(t, resp);
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
  if (t.stage === "generating" && typeof m.check_question === "string") {
    const check = m.check_question.trim();
    t.checkQuestion = check ? check : null;
    patch({ checkQuestion: t.checkQuestion });
  }
}

function streamHandlers(t: Turn): TutorStreamHandlers {
  return {
    onFirstToken: () => markFirstToken(t),
    onMeta: (m) => applyMeta(t, m, "stream"),
    onSegment: (seg) => {
      if (!isCurrent(t)) return;
      st().appendSegment(seg);
      queue(t, [seg], "append");
    },
    onShape: (shape) => {
      if (!isCurrent(t)) return;
      st().appendShape(shape);
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

async function runCapture(req: CaptureRequest, fixture?: string): Promise<boolean> {
  cancelAll();
  st().resetSession(); // a new capture starts a new session context
  setPhase("capturing");
  patch({ mode: req.mode, timings: { captureAt: Date.now() } });
  try {
    const res = await invoke<CaptureResult>(CMD.capture, { req, fixture });
    patch({ fullCapture: res, capture: { ...res, imageBase64: "" } });
    return true;
  } catch (err) {
    console.warn("[brain] capture failed:", errMsg(err));
    setPhase("idle");
    patch({ error: `Capture failed: ${errMsg(err)}` });
    return false;
  }
}

async function askStreaming(t: Turn, input: TutorCallInput): Promise<void> {
  const final = await streamTutor(input, streamHandlers(t));
  if (!isCurrent(t)) return;
  t.streamDone = true;
  commitResponse(t, final);
  advance(t);
}

async function askBuffered(t: Turn, input: TutorCallInput): Promise<void> {
  // TODO(M3): verifier re-enabled by default once the verifier is ready; this path is exercised only when on.
  const handlers: TutorStreamHandlers = {
    onFirstToken: () => markFirstToken(t),
    onMeta: (m) => applyMeta(t, m, "buffered"),
  };
  let draft = await streamTutor(input, handlers);
  if (!isCurrent(t)) return;

  setPhase("verifying");
  const v = await verifyResponse({
    capture: input.capture,
    question: input.question,
    draft,
    settings: input.settings,
    signal: t.ac.signal,
  });
  if (!isCurrent(t)) return;
  patch({ verifier: { ran: v.ran, verdict: v.result.verdict, ms: v.ms } });

  if (v.result.verdict === "fail") {
    console.info("[brain] verifier failed, regenerating once:", v.result.unsupported_claims);
    setPhase("thinking");
    draft = await streamTutor({ ...input, critique: v.result.unsupported_claims }, handlers);
    if (!isCurrent(t)) return;
  }
  t.streamDone = true;
  commitAndSpeak(t, draft);
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
    if (st().settings.verifierEnabled) await askBuffered(t, input);
    else await askStreaming(t, input);
  } catch (err) {
    fail(t, errMsg(err));
  }
}

async function handleCheckAnswer(t: Turn, answer: string): Promise<void> {
  const cap = st().fullCapture;
  if (!answer.trim() || !cap) {
    t.stage = "done";
    setPhase("idle");
    return;
  }
  t.stage = "feedback";
  setPhase("thinking");
  try {
    await streamTutor(
      {
        capture: cap,
        question: t.question,
        settings: st().settings,
        signal: t.ac.signal,
        checkAnswer: { checkQuestion: t.checkQuestion ?? "", answer },
      },
      streamHandlers(t), // feedback segments are appended and spoken; the response is not replaced
    );
    if (!isCurrent(t)) return;
    t.streamDone = true;
    advance(t);
  } catch (err) {
    fail(t, errMsg(err));
  }
}

async function handleTargetCommit(i: Extract<UiIntent, { type: "target-commit" }>): Promise<void> {
  if (!(await runCapture({ mode: i.mode, region: i.region }))) return;
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
    case "typed-question":
      if (!st().fullCapture && !(await runCapture({ mode: "click" }))) return;
      await ask(i.text);
      return;
    case "cancel":
      cancelAll();
      st().resetSession();
      console.info("[brain]", "idle");
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
      }
    }),
    listen<SttPartial>(EV.sttPartial, (e) => {
      const ph = st().phase;
      if (ph === "listening" || ph === "checking") patch({ partialTranscript: e.payload.text });
    }),
    listen<SttError>(EV.sttError, (e) => patch({ error: e.payload.message })),
  ]);

  return () => {
    offStarted();
    offIdle();
    unlisten.forEach((u) => u());
    cancelAll();
  };
}
