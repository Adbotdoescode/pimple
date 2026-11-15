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

/**
 * WIRE FORMAT. The API rejected the rich schema ("Schema is too complex"), so the model emits this
 * flat shape (shared/tutor_response.schema.json): every field required, unused ones 0 / "" / [].
 * The brain converts each completed wire shape with wireToShape() and stores the friendly Shape above.
 * Views and renderers only ever see Shape / TutorResponse.
 *  circle: points [[cx,cy]], radius, label          box: points [[x1,y1],[x2,y2]] (corners), label
 *  line / arrow: points [[x1,y1],[x2,y2]], label     vector: points [[tail],[head]], magnitude, label, values [1] = draw components
 *  stroke: points (≤ 32)                             text: points [[x,y]], label = the text
 *  graph: points = placement corners; values = [x_min, x_max, y_min, y_max, px0, py0, px1, py1, …] (plotted data);
 *         label = "x label|y label|series label"; magnitude = "line" | "points"
 *  slider: values = [min, max, value, step]; magnitude = unit; label; target = id of the shape it drives
 */
export interface WireShape {
  id: string; segment_id: string; kind: ShapeKind; color_role: ColorRole;
  points: number[][]; radius: number; label: string; magnitude: string; values: number[]; target: string;
}
export interface WireResponse extends Omit<TutorResponse, "shapes" | "summary_sentence"> { shapes: WireShape[] }

/** Returns null if the wire shape lacks the geometry its kind needs (drop it, never crash). */
export function wireToShape(w: WireShape): Shape | null {
  const pts = (w.points ?? []).filter((p) => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite)) as Pt[];
  const base = { id: w.id, segment_id: w.segment_id, kind: w.kind, color_role: w.color_role,
                 label: w.label || undefined, magnitude: w.magnitude || undefined };
  const rectFrom = (a: Pt, b: Pt): [number, number, number, number] =>
    [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
  switch (w.kind) {
    case "circle": return pts[0] && w.radius > 0 ? { ...base, center: pts[0], radius: w.radius } : null;
    case "text":   return pts[0] && w.label ? { ...base, center: pts[0] } : null;
    case "box":    return pts.length >= 2 ? { ...base, rect: rectFrom(pts[0], pts[1]) } : null;
    case "line": case "arrow":
      return pts.length >= 2 ? { ...base, from: pts[0], to: pts[1] } : null;
    case "vector":
      return pts.length >= 2 ? { ...base, from: pts[0], to: pts[1], components: w.values?.[0] === 1 } : null;
    case "stroke": return pts.length >= 2 ? { ...base, points: pts.slice(0, 32) } : null;
    case "graph": {
      const v = w.values ?? [];
      if (pts.length < 2 || v.length < 4) return null;
      const [xl = "", yl = "", sl = ""] = (w.label || "").split("|");
      const data: Pt[] = [];
      for (let i = 4; i + 1 < v.length; i += 2) data.push([v[i], v[i + 1]]);
      return { ...base, label: sl || undefined, rect: rectFrom(pts[0], pts[1]),
        graph: { x_min: v[0], x_max: v[1], y_min: v[2], y_max: v[3], x_label: xl, y_label: yl,
                 series: [{ label: sl, style: w.magnitude === "points" ? "points" : "line", points: data }] } };
    }
    case "slider": {
      const v = w.values ?? [];
      if (v.length < 3) return null;
      return { ...base, rect: pts.length >= 2 ? rectFrom(pts[0], pts[1]) : undefined,
        slider: { label: w.label, min: v[0], max: v[1], value: v[2], step: v[3] ?? (v[1] - v[0]) / 100,
                  unit: w.magnitude, shape_id: w.target } };
    }
    default: return null;
  }
}

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
  /**
   * v2 (user request 14:15): for modes "region" and "lasso" the MAIN image above is now the FULL
   * display (context, and the coordinate space for every shape), and `focus` is a sharper crop of
   * what the user pointed at. Both images go to the model; the focus is the subject of the question.
   * Absent for mode "click".
   */
  focus?: {
    imagePath: string;
    imageBase64: string;
    imageWidth: number;
    imageHeight: number;
    rectInImagePx: [number, number, number, number]; // the focus region in MAIN-image pixels [x,y,w,h]
    regionInScreenPoints: RectPts;                    // the focus region in screen points (padded 12%)
  };
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
  ttsVoices: "tts_voices",                  // v3: () → {voiceId, name, category, previewUrl, labels: Record<string,string>}[] (GET /v1/voices; cache 10 min)
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
  | { type: "shut-up" }       // v2: stop speech + drawing + generation NOW, keep the card open, open the mic for a new question
  | { type: "interrupt" }     // v2: same as space-hold, from any phase (thinking, verifying, speaking, checking)
  | { type: "card-close" }    // v2: end the session (shut up + clear shapes + bubble back to its edge)
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
  bubbleY: number;              // v3: resting height as a fraction of the display height (0..1), default 0.5
  micAutoOpen: boolean;         // v3: mic opens by itself after capture / check / offer; false = hold Space (or bubble click / card mic) to talk
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
  bubbleY: 0.5,
  micAutoOpen: true,
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
