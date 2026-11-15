import { createStore } from "zustand/vanilla";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CaptureResult,
  type Phase,
  type Segment,
  type SessionSnapshot,
  type Shape,
  type TutorResponse,
} from "../../shared/contracts";

/** Everything the brain keeps: the broadcast snapshot plus the full capture (base64, never broadcast). */
export interface SessionData extends SessionSnapshot {
  /** Full capture incl. imageBase64. Stays in the brain window; getSnapshot() never exposes it. */
  fullCapture: CaptureResult | null;
}

export interface SessionStore extends SessionData {
  setPhase(phase: Phase): void;
  patch(partial: Partial<SessionData>): void;
  resetSession(): void;
  appendSegment(seg: Segment): void;
  appendShape(shape: Shape): void;
  setMeta(partial: Partial<TutorResponse>): void;
}

// TODO(M3): re-enable verifier default. The verifier is not ready in this milestone.
const M1_SETTINGS: AppSettings = { ...DEFAULT_SETTINGS, verifierEnabled: false };

export function initialSnapshot(settings: AppSettings): SessionSnapshot {
  return {
    phase: "idle",
    mode: null,
    capture: null,
    question: null,
    partialTranscript: "",
    response: null,
    currentSegmentId: null,
    spokenSegmentIds: [],
    caption: "",
    sideNote: null,
    pulseShapeIds: [],
    parked: [],
    contested: [],
    checkQuestion: null,
    sourceLabel: null,
    verifier: null,
    gizmo: { status: "none" },
    error: null,
    settings,
    timings: {},
  };
}

function emptyResponse(): TutorResponse {
  return {
    concept: "",
    surface: "overlay",
    grounding: { source_type: "screen", source_ref: "", quote: "" },
    segments: [],
    shapes: [],
    check_question: "",
    gizmo_offer: { recommended: false, pitch: "" }, // phase 1: never recommended
    parked: [],
  };
}

/** Phase 1: the gizmo offer is always off, whatever the model sent. */
function normalizeResponse(r: TutorResponse): TutorResponse {
  return { ...r, gizmo_offer: { ...r.gizmo_offer, recommended: false } };
}

function definedOnly<T extends object>(o: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const sessionStore = createStore<SessionStore>()((set, get) => ({
  ...initialSnapshot(M1_SETTINGS),
  fullCapture: null,

  setPhase: (phase) => set({ phase }),

  patch: (partial) => {
    if (partial.response) partial = { ...partial, response: normalizeResponse(partial.response) };
    set(partial);
  },

  resetSession: () => set({ ...initialSnapshot(get().settings), fullCapture: null }),

  appendSegment: (seg) =>
    set((s) => {
      const r = s.response ?? emptyResponse();
      return { response: { ...r, segments: [...r.segments, seg] } };
    }),

  appendShape: (shape) =>
    set((s) => {
      const r = s.response ?? emptyResponse();
      return { response: { ...r, shapes: [...r.shapes, shape] } };
    }),

  setMeta: (partial) =>
    set((s) => {
      const r = s.response ?? emptyResponse();
      return { response: normalizeResponse({ ...r, ...definedOnly(partial) }) };
    }),
}));

/**
 * The snapshot broadcast as session:state. Built field by field so a new SessionSnapshot field is a
 * compile error here until it is added, and so the fullCapture field can never leak out.
 */
export function getSnapshot(): SessionSnapshot {
  const s = sessionStore.getState();
  return {
    phase: s.phase,
    mode: s.mode,
    capture: s.capture ? { ...s.capture, imageBase64: "" } : null,
    question: s.question,
    partialTranscript: s.partialTranscript,
    response: s.response,
    currentSegmentId: s.currentSegmentId,
    spokenSegmentIds: s.spokenSegmentIds,
    caption: s.caption,
    sideNote: s.sideNote,
    pulseShapeIds: s.pulseShapeIds,
    parked: s.parked,
    contested: s.contested,
    checkQuestion: s.checkQuestion,
    sourceLabel: s.sourceLabel,
    verifier: s.verifier,
    gizmo: s.gizmo,
    error: s.error,
    settings: s.settings,
    timings: s.timings,
  };
}
