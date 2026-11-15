// Typed IPC over @tauri-apps/api, keyed by the CMD / EV maps in shared/contracts.ts.
// Command args are passed as a flat camelCase object (Tauri maps them to snake_case Rust args).
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CaptureRequest,
  CaptureResult,
  DebugInject,
  RectPts,
  SecretName,
  SessionSnapshot,
  SttError,
  SttFinal,
  SttLevel,
  SttModelStatus,
  SttPartial,
  TargetingUpdate,
  TtsProvider,
  TtsSynthResult,
  UiIntent,
  WindowLabel,
} from "@shared/contracts";
import { CMD, EV } from "@shared/contracts";

type Empty = Record<string, never>;

/** Command name → [args, result]. Names are the snake_case values of CMD. */
export interface CmdSpec {
  [CMD.capture]: [CaptureRequest, CaptureResult];
  [CMD.sttStart]: [Empty, void];
  [CMD.sttStop]: [Empty, void];
  [CMD.sttCancel]: [Empty, void];
  [CMD.sttModelStatus]: [Empty, SttModelStatus];
  [CMD.ttsSynthesize]: [{ text: string; voiceId?: string }, TtsSynthResult];
  [CMD.ttsCredit]: [Empty, { used: number; limit: number; provider: TtsProvider }];
  [CMD.getSecret]: [{ name: SecretName }, string | null];
  [CMD.setSecret]: [{ name: SecretName; value: string }, void];
  [CMD.keysStatus]: [Empty, Record<SecretName, boolean>];
  [CMD.setSessionKeys]: [{ space: boolean; returnEsc: boolean }, void];
  [CMD.bubbleDisplay]: [Empty, { displayId: number; frame: RectPts }];
  [CMD.setIgnoreCursor]: [{ ignore: boolean }, void];
  [CMD.showWindow]: [{ label: WindowLabel }, void];
  [CMD.hideWindow]: [{ label: WindowLabel }, void];
  [CMD.readSourceFile]: [{ name: string }, string];
}
export type CmdName = keyof CmdSpec;

export function invokeCmd<N extends CmdName>(
  name: N,
  ...args: CmdSpec[N][0] extends Empty ? [] : [CmdSpec[N][0]]
): Promise<CmdSpec[N][1]> {
  return invoke<CmdSpec[N][1]>(name, (args[0] ?? {}) as Record<string, unknown>);
}

/** Event name → payload. */
export interface EvSpec {
  [EV.sttLevel]: SttLevel;
  [EV.sttPartial]: SttPartial;
  [EV.sttFinal]: SttFinal;
  [EV.sttError]: SttError;
  [EV.sttModel]: SttModelStatus;
  [EV.spaceTap]: Empty;
  [EV.spaceHoldStart]: Empty;
  [EV.spaceHoldEnd]: Empty;
  [EV.keyReturn]: Empty;
  [EV.keyEscape]: Empty;
  [EV.hotkeyActivate]: Empty;
  [EV.ttsFallback]: { reason: string };
  [EV.debugInject]: DebugInject;
  [EV.trayAction]: { action: "settings" | "keys" | "quit" | "whiteboard" };
  [EV.sessionState]: SessionSnapshot;
  [EV.uiIntent]: UiIntent;
  [EV.targeting]: TargetingUpdate;
}
export type EvName = keyof EvSpec;

export function onEvent<N extends EvName>(
  name: N,
  cb: (payload: EvSpec[N]) => void,
): Promise<UnlistenFn> {
  return listen<EvSpec[N]>(name, (e) => cb(e.payload));
}

/** Broadcast to every window. */
export function emitEvent<N extends EvName>(name: N, payload: EvSpec[N]): Promise<void> {
  return emit(name, payload);
}

/** Send to one window only (e.g. high-frequency targeting → "overlay"). */
export function emitEventTo<N extends EvName>(
  target: WindowLabel,
  name: N,
  payload: EvSpec[N],
): Promise<void> {
  return emitTo(target, name, payload);
}

export { CMD, EV };
