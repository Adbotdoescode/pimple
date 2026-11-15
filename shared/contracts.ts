/**
 * Glass Tutor contracts C1–C5. Owned by the orchestrator.
 * Do NOT change names or shapes without the orchestrator's sign-off.
 * Import from the frontend as `@shared/contracts` (Vite + tsconfig alias).
 *
 * Units: all screen geometry is in macOS POINTS, global desktop coordinates
 * (origin top-left of the primary display, y down) — the same space Tauri's
 * LogicalPosition uses and `screencapture -R` takes.
 */

// ───────────────────────── C1: tutor response (shared/tutor_response.schema.json) ─────────────────────────

export type ColorRole = "primary" | "secondary" | "accent" | "warn";
export type ShapeKind =
  | "circle" | "box" | "line" | "arrow" | "vector" | "stroke" | "text" | "graph" | "slider";
export type Pt = [number, number];

export interface GraphSpec {
  x_min: number; x_max: number; y_min: number; y_max: number;
  x_label: string; y_label: string;
  series: { label: string; style: "line" | "points"; points: Pt[] }[];
}
export interface SliderSpec {
  label: string; min: number; max: number; value: number; step: number; unit: string;
  shape_id: string; // the shape whose label/magnitude it drives ("" if none)
}

/**
 * Coordinates are PIXELS IN THE IMAGE THE MODEL WAS SENT (CaptureResult.imageWidth × imageHeight)
 * when surface = "overlay"; for surface = "whiteboard" they are in a virtual 1600 × 1000 board.
 * Field use per kind:
 *  circle: center, radius, label?      box: rect [x,y,w,h], label?
 *  line / arrow: from, to, label?       vector: from, to, magnitude?, label?, components? (draw dashed x/y legs)
 *  stroke: points (≤ 32, smoothed)      text: center (anchor), label (the text)
 *  graph: rect + graph                  slider: slider (+ rect on whiteboard). Never on the overlay.
 */
export interface Shape {
  id: string;
  segment_id: string;
  kind: ShapeKind;
  color_role: ColorRole;
  center?: Pt; radius?: number;
  rect?: [number, number, number, number];
  from?: Pt; to?: Pt;
  points?: Pt[];
  label?: string; magnitude?: string; components?: boolean;
  graph?: GraphSpec; slider?: SliderSpec;
}
export interface Segment { id: string; text: string }
export interface TutorResponse {
  concept: string;
  summary_sentence?: string;
  surface: "overlay" | "whiteboard";
  grounding: { source_type: "screen" | "fixed_source"; source_ref: string; quote: string };
  segments: Segment[];
  shapes: Shape[];
  check_question: string; // "" when no check is due this turn
  gizmo_offer: { recommended: boolean; pitch: string }; // phase 1: always false
  parked: string[];
}
export interface VerifierResult { verdict: "pass" | "fail"; unsupported_claims: string[] }

// ───────────────────────── C2: capture ─────────────────────────

export type CaptureMode = "click" | "region" | "lasso";
export interface RectPts { x: number; y: number; w: number; h: number }

export interface CaptureRequest {
  mode: CaptureMode;
  /** Target bounding box in points. Rust pads by 12% per side and clamps to the display.
   *  Omit for mode "click" → full display the bubble is on. */
  region?: RectPts;
}
export interface CaptureResult {
  mode: CaptureMode;
  imagePath: string;          // JPEG on disk (app cache dir). Load in webviews with convertFileSrc().
  imageBase64: string;        // same JPEG, base64, no data: prefix (for the Claude request)
  imageWidth: number;         // pixels of the JPEG actually sent to the model (long edge ≤ 1568)
  imageHeight: number;
  regionInScreenPoints: RectPts; // padded + clamped region actually captured
  displayId: number;
  pixelScale: number;         // imageWidth / regionInScreenPoints.w
  capturedAt: number;         // ms epoch
}
/** Map a model pixel coordinate back to global screen points. */
export function imagePxToScreen(c: CaptureResult, p: Pt): Pt {
  return [
    c.regionInScreenPoints.x + p[0] / c.pixelScale,
    c.regionInScreenPoints.y + p[1] / c.pixelScale,
  ];
}

// ───────────────────────── C3: voice I/O ─────────────────────────

/** STT (Rust → all windows). Mic opens with stt_start; VAD ends the turn after ~1 s of silence. */
export interface SttLevel { level: number }        // 0..1 RMS, ~30 Hz while listening
export interface SttPartial { text: string }       // optional, may never fire
export interface SttFinal { text: string }         // the finished utterance ("" if nothing heard)
export interface SttError { message: string }
export interface SttModelStatus { ready: boolean; downloading: boolean; progress: number /*0..1*/; error?: string }

/** TTS (frontend player in the brain window, backed by Rust tts_synthesize). */
export type TtsProvider = "elevenlabs" | "say" | "off";
export interface TtsSynthResult { path: string; provider: TtsProvider; cached: boolean; durationMs: number }
export interface PausePoint { segmentId: string; fractionPlayed: number }
export interface TtsPlayer {
  speak(segments: Segment[]): void;            // queue; synth-prefetch ahead; plays in order
  append(segments: Segment[]): void;           // add more while playing (streaming)
  pause(): PausePoint | null;                   // fade out ≤150 ms, returns where it stopped
  resume(fromSegmentId: string): void;         // replay from this segment (whole sentence)
  stop(): void;                                 // clear queue
  onSegmentStarted(cb: (id: string) => void): () => void; // drives shape timing; returns unsubscribe
  onSegmentEnded(cb: (id: string) => void): () => void;
  onIdle(cb: () => void): () => void;           // queue drained
}

// ───────────────────────── Tauri commands (Rust, snake_case, invoke() args camelCase) ─────────────────────────

export const CMD = {
  capture: "capture",                       // (req: CaptureRequest) → CaptureResult
  sttStart: "stt_start",                    // () → void. Opens mic, VAD auto-ends → stt:final
  sttStop: "stt_stop",                      // () → void. Ends the turn now (push-to-talk release) → stt:final
  sttCancel: "stt_cancel",                  // () → void. Discard, no stt:final
  sttModelStatus: "stt_model_status",       // () → SttModelStatus (starts download if missing)
  ttsSynthesize: "tts_synthesize",          // ({text, voiceId?}) → TtsSynthResult (disk-cached by hash(text,voice,model))
  ttsCredit: "tts_credit",                  // () → {used: number, limit: number, provider: TtsProvider}
  getSecret: "get_secret",                  // ({name: SecretName}) → string | null   (never log the value)
  setSecret: "set_secret",                  // ({name, value}) → void (writes macOS Keychain)
  keysStatus: "keys_status",                // () → Record<SecretName, boolean>
  setSessionKeys: "set_session_keys",       // ({space: boolean, returnEsc: boolean}) → void (register/unregister global keys)
  bubbleDisplay: "bubble_display",          // () → {displayId, frame: RectPts}  display under the bubble
  setIgnoreCursor: "overlay_set_ignore_cursor", // ({ignore: boolean}) → void
  showWindow: "show_window",                // ({label: WindowLabel}) → void (panels: orderFront without activating)
  hideWindow: "hide_window",                // ({label: WindowLabel}) → void
  readSourceFile: "read_source_file",       // ({name}) → string  (content/sources/<name>, demo phase)
} as const;

export type SecretName = "anthropic" | "elevenlabs" | "voice_id";
// Keychain: service "glass-tutor.anthropic-api-key" | "glass-tutor.elevenlabs-api-key" | "glass-tutor.elevenlabs-voice-id", account "glass-tutor".

export type WindowLabel = "brain" | "bubble" | "overlay" | "card" | "whiteboard" | "settings" | "gizmo";

// ───────────────────────── Events ─────────────────────────

export const EV = {
  // Rust → all
  sttLevel: "stt:level",            // SttLevel
  sttPartial: "stt:partial",        // SttPartial
  sttFinal: "stt:final",            // SttFinal
  sttError: "stt:error",            // SttError
  sttModel: "stt:model",            // SttModelStatus (download progress)
  spaceTap: "space:tap",            // {}  (press < 250 ms)
  spaceHoldStart: "space:hold-start", // {} (fires at 250 ms while still held)
  spaceHoldEnd: "space:hold-end",   // {}
  keyReturn: "key:return",          // {}  only while returnEsc registered
  keyEscape: "key:escape",          // {}
  hotkeyActivate: "hotkey:activate",// {}  always-on ctrl+option+space
  ttsFallback: "tts:fallback",      // {reason: string}  ElevenLabs failed/quota → using `say`
  debugInject: "debug:inject",      // DebugInject (from the dev HTTP hook)
  trayAction: "tray:action",        // {action: "settings" | "keys" | "quit" | "whiteboard"}

  // brain → all (state mirror, C5)
  sessionState: "session:state",    // SessionSnapshot, full snapshot on every change (rAF-throttled)

  // views → brain
  uiIntent: "ui:intent",            // UiIntent

  // bubble → overlay (high-frequency, bypasses the store)
  targeting: "targeting:update",    // TargetingUpdate
} as const;

export interface DebugInject {
  capture?: string;    // absolute path to a fixture PNG/JPEG used instead of a real screenshot
  question?: string;   // typed question used instead of the mic
  shapes?: string;     // absolute path to a canned TutorResponse JSON to render directly (no API call)
  mode?: CaptureMode;  // default "click"
  tts?: TtsProvider;   // override for this run
}

export type TargetingUpdate =
  | { kind: "lens"; cx: number; cy: number; r: number }                  // points
  | { kind: "lasso"; points: Pt[]; closed: boolean }                      // points, trail
  | { kind: "clear" };

export type UiIntent =
  | { type: "bubble-click" }                                    // mode A
  | { type: "target-commit"; mode: "region" | "lasso"; region: RectPts } // B/C, bbox in points (unpadded)
  | { type: "target-start" }                                    // drag began → phase targeting
  | { type: "cancel" }                                          // Esc / close
  | { type: "typed-question"; text: string }                    // card text box (fallback to mic)
  | { type: "accept-gizmo" } | { type: "decline-gizmo" }
  | { type: "ask-parked"; index: number }
  | { type: "open-whiteboard" }
  | { type: "settings-changed"; settings: Partial<AppSettings> };

// ───────────────────────── C5: session state machine ─────────────────────────

export type Phase =
  | "idle" | "targeting" | "capturing" | "summarising" | "listening"
  | "thinking" | "verifying" | "speaking" | "interrupted" | "checking";

export interface ContestedPoint { segmentId: string; segmentText: string; objection: string; resolution: string }

export interface AppSettings {
  verifierEnabled: boolean;     // default true
  fastMode: boolean;            // Opus speed:"fast", default false
  tutorModel: string;           // "claude-opus-5-5"
  verifierModel: string;        // "claude-haiku-5-5"
  ttsProvider: TtsProvider;     // default from GT_TTS env, else "elevenlabs"
  voiceId: string;              // default "SAz9YHcvj6GT2YYXdXww" (River)
  bubbleEdge: "left" | "right"; // default right
  whiteboardTheme: "light" | "dark";
}

export interface SessionSnapshot {
  phase: Phase;
  mode: CaptureMode | null;
  capture: CaptureResult | null;   // NOTE: imageBase64 is stripped ("") in the broadcast; use imagePath
  question: string | null;
  partialTranscript: string;
  response: TutorResponse | null;  // grows while streaming (segments/shapes appended as they complete)
  currentSegmentId: string | null; // segment being spoken now
  spokenSegmentIds: string[];      // fully or partly spoken
  caption: string;                 // text shown in the speech card right now
  sideNote: { segments: Segment[]; shapes: Shape[] } | null; // interruption answer, drawn in distinct style
  pulseShapeIds: string[];         // shapes to pulse (space tap "Which part?")
  parked: string[];
  contested: ContestedPoint[];
  checkQuestion: string | null;
  sourceLabel: string | null;      // e.g. "Source: your screen — the incline diagram"
  verifier: { ran: boolean; verdict?: "pass" | "fail"; ms?: number } | null;
  gizmo: { status: "none" | "offered" | "building" | "ready" | "failed"; html?: string } ;
  error: string | null;
  settings: AppSettings;
  timings: { captureAt?: number; firstTokenAt?: number; firstAudioAt?: number }; // for latency display
}

export const DEFAULT_SETTINGS: AppSettings = {
  verifierEnabled: true,
  fastMode: false,
  tutorModel: "claude-opus-5-5",
  verifierModel: "claude-haiku-5-5",
  ttsProvider: "elevenlabs",
  voiceId: "SAz9YHcvj6GT2YYXdXww",
  bubbleEdge: "right",
  whiteboardTheme: "light",
};

// ───────────────────────── C4: gizmos (phase 2, do not implement yet) ─────────────────────────

export interface GizmoRequest {
  concept: string;
  grounding: TutorResponse["grounding"];
  keyQuantities: { name: string; value: string; unit: string }[];
  explanation: string[]; // segment texts
}
export interface GizmoReady { ok: boolean; html?: string; error?: string; ms: number }
