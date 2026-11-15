// Read-only mirror of the brain's session state (C5). Every view window renders from this.
// The brain broadcasts a full SessionSnapshot on `session:state`; views never mutate it
// (send `ui:intent` instead).
import { create } from "zustand";
import type { SessionSnapshot } from "@shared/contracts";
import { DEFAULT_SETTINGS, EV } from "@shared/contracts";
import { onEvent } from "./ipc";

export const INITIAL_SNAPSHOT: SessionSnapshot = {
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
  settings: DEFAULT_SETTINGS,
  timings: {},
};

interface MirrorState {
  snapshot: SessionSnapshot;
  set: (s: SessionSnapshot) => void;
}

export const useSessionMirror = create<MirrorState>((set) => ({
  snapshot: INITIAL_SNAPSHOT,
  set: (snapshot) => set({ snapshot }),
}));

let started = false;
/** Subscribe to `session:state` once per window. Called automatically by useSession. */
export function startSessionMirror(): void {
  if (started) return;
  started = true;
  onEvent(EV.sessionState, (snap) => useSessionMirror.getState().set(snap)).catch((e) => {
    started = false;
    console.error("sessionMirror: listen failed", e);
  });
}

/** Select from the latest snapshot: `const phase = useSession(s => s.phase)`. */
export function useSession<T>(selector: (s: SessionSnapshot) => T): T {
  startSessionMirror();
  return useSessionMirror((st) => selector(st.snapshot));
}

/** Non-hook access (e.g. inside event handlers). */
export function getSession(): SessionSnapshot {
  return useSessionMirror.getState().snapshot;
}
