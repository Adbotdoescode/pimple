/**
 * Frontend TTS player for the hidden brain window (contract C3, TtsPlayer).
 *
 * Synthesis comes from Rust `tts_synthesize`. Audio plays through one lazily created
 * AudioContext (HTMLAudioElement when the context will not run). If synthesis, fetch or
 * decode fails, the item is simulated with a timer so segment events keep firing and the
 * session pipeline never stalls. Timing uses setTimeout and audio onended only (no
 * requestAnimationFrame), so it works in a hidden webview.
 */
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CMD, EV } from "../../shared/contracts";
import type { PausePoint, Segment, TtsPlayer, TtsProvider, TtsSynthResult } from "../../shared/contracts";
import { toSpeech } from "./speechText";

export interface TtsPlayerOptions {
  getVoiceId(): string;
  getProviderOverride?(): TtsProvider | undefined;
  onFallback?(reason: string): void;
  onFirstAudio?(): void;
}

const GAP_MS = 120;   // silence between sentences
const FADE_MS = 120;  // fade-out on pause and stop
const PREFETCH = 3;   // current item plus the next two queued items

interface AudioGraph {
  ctx: AudioContext;
  gain: GainNode;
  pendingStop: (() => void) | null; // a faded-out source waiting to be stopped
}
/** path === "" means simulated: play by timer for durationMs. */
interface Loaded { durationMs: number; path: string; buffer: AudioBuffer | null }
type Finish = (ok: boolean) => void;
interface Playback { fraction(): number; cancel(fade: boolean): void }
interface Current extends Playback { segId: string | null }

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

function emitter<A extends unknown[]>() {
  const subs = new Set<(...args: A) => void>();
  return {
    add(cb: (...args: A) => void): () => void {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
    emit(...args: A): void {
      for (const cb of [...subs]) {
        try { cb(...args); } catch (err) { console.warn("[tts] listener threw", err); }
      }
    },
  };
}

const warned = new Set<string>();
function warnOnce(stage: string, err: unknown): void {
  if (warned.has(stage)) return;
  warned.add(stage);
  console.warn(`[tts] ${stage} failed`, err);
}

// Module-level: one Rust fallback listener shared by every player; each player registers a sink.
const fallbackSinks = new Set<(reason: string) => void>();
let fallbackListening = false;
function ensureFallbackListener(): void {
  if (fallbackListening) return;
  fallbackListening = true;
  listen<{ reason: string }>(EV.ttsFallback, (event) => {
    const reason = String(event.payload?.reason ?? "unknown");
    for (const sink of [...fallbackSinks]) {
      try { sink(reason); } catch (err) { console.warn("[tts] onFallback threw", err); }
    }
  }).catch((err) => warnOnce("fallback listener", err));
}

function estimateMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1200, words * 330);
}

function simulated(seg: Segment): Loaded {
  return { durationMs: estimateMs(seg.text), path: "", buffer: null };
}

function createGraph(): AudioGraph | null {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    return { ctx, gain, pendingStop: null };
  } catch (err) {
    warnOnce("audio context", err);
    return null;
  }
}

async function load(seg: Segment, opts: TtsPlayerOptions, getGraph: () => AudioGraph | null): Promise<Loaded> {
  const voiceId = opts.getVoiceId();
  const provider = opts.getProviderOverride?.();
  let res: TtsSynthResult;
  try {
    res = await invoke<TtsSynthResult>(CMD.ttsSynthesize, { text: toSpeech(seg.text), voiceId, provider });
  } catch (err) {
    warnOnce("synthesis", err);
    return simulated(seg);
  }
  const durationMs = res.durationMs > 0 ? res.durationMs : estimateMs(seg.text);
  if (res.provider === "off" || !res.path) return { durationMs, path: "", buffer: null };
  const graph = getGraph();
  if (!graph) return { durationMs, path: res.path, buffer: null }; // element playback only
  try {
    const bytes = await (await fetch(convertFileSrc(res.path))).arrayBuffer();
    const buffer = await graph.ctx.decodeAudioData(bytes);
    const decodedMs = buffer.duration * 1000;
    return { durationMs: decodedMs > 0 ? decodedMs : durationMs, path: res.path, buffer };
  } catch (err) {
    warnOnce("fetch or decode", err);
    return simulated(seg);
  }
}

function flushFade(g: AudioGraph | null): void {
  const stop = g?.pendingStop ?? null;
  if (g) g.pendingStop = null;
  stop?.();
}

function playSim(durationMs: number, finish: Finish, offsetMs = 0): Playback {
  const startedAt = performance.now() - offsetMs;
  const timer = setTimeout(() => finish(true), Math.max(0, durationMs - offsetMs));
  return {
    fraction: () => (durationMs > 0 ? clamp01((performance.now() - startedAt) / durationMs) : 1),
    cancel: () => clearTimeout(timer),
  };
}

function playBuffer(g: AudioGraph, buffer: AudioBuffer, durationMs: number, finish: Finish): Playback {
  flushFade(g);
  const { ctx, gain } = g;
  gain.gain.cancelScheduledValues(ctx.currentTime);
  gain.gain.setValueAtTime(1, ctx.currentTime);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(gain);
  src.onended = () => finish(true);
  const startedAt = performance.now();
  src.start();
  const stopSource = (): void => {
    try { src.stop(); } catch { /* already stopped */ }
  };
  return {
    fraction: () => clamp01((performance.now() - startedAt) / durationMs),
    cancel: (fade) => {
      if (!fade) { stopSource(); return; }
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_MS / 1000);
      const timer = setTimeout(stopSource, FADE_MS);
      g.pendingStop = () => { clearTimeout(timer); stopSource(); };
    },
  };
}

function playElement(path: string, durationMs: number, finish: Finish): Playback {
  const el = new Audio(convertFileSrc(path));
  let inner: Playback | null = null;
  let dead = false;
  // Stall guard: if the element never reports ended, finish on time anyway.
  const watchdog = setTimeout(() => degrade(), durationMs * 1.5 + 2000);
  const degrade = (): void => {
    if (inner || dead) return;
    clearTimeout(watchdog);
    el.pause();
    inner = playSim(durationMs, finish, el.currentTime * 1000);
  };
  el.onended = () => { clearTimeout(watchdog); finish(true); };
  el.onerror = () => degrade();
  el.play().catch(() => degrade());
  return {
    fraction: () => {
      if (inner) return inner.fraction();
      return Number.isFinite(el.duration) && el.duration > 0 ? clamp01(el.currentTime / el.duration) : 0;
    },
    cancel: (fade) => {
      dead = true;
      clearTimeout(watchdog);
      if (inner) inner.cancel(fade);
      else el.pause();
    },
  };
}

function startPlayback(loaded: Loaded, g: AudioGraph | null, finish: Finish): Playback {
  flushFade(g);
  if (!loaded.path) return playSim(loaded.durationMs, finish);
  if (g && loaded.buffer && g.ctx.state === "running") {
    return playBuffer(g, loaded.buffer, loaded.durationMs, finish);
  }
  return playElement(loaded.path, loaded.durationMs, finish);
}

export function createTtsPlayer(
  opts: TtsPlayerOptions,
): TtsPlayer & { isPlaying(): boolean; currentSegmentId(): string | null } {
  ensureFallbackListener();
  fallbackSinks.add((reason) => opts.onFallback?.(reason));

  const started = emitter<[string]>();
  const ended = emitter<[string]>();
  const idle = emitter<[]>();

  let graph: AudioGraph | null = null;
  const getGraph = (): AudioGraph | null => {
    if (!graph) graph = createGraph();
    return graph;
  };

  let history: Segment[] = []; // everything since the last speak() or stop(), for resume()
  let pos = 0;                 // index of the item playing now, or the next one to play
  let gen = 0;                 // bumped to invalidate every in-flight continuation
  let loopActive = false;
  let paused = false;
  let firstAudioPending = true;
  let current: Current | null = null;
  const loads = new Map<string, Promise<Loaded>>();

  const loadFor = (seg: Segment): Promise<Loaded> => {
    let p = loads.get(seg.id);
    if (!p) {
      p = load(seg, opts, getGraph).catch((err) => {
        warnOnce("load", err);
        return simulated(seg);
      });
      loads.set(seg.id, p);
    }
    return p;
  };

  // Keep synthesis in flight for the current item and the next queued items; drop the rest.
  const prefetch = (): void => {
    const upcoming = history.slice(pos, pos + PREFETCH);
    const keep = new Set(upcoming.map((s) => s.id));
    for (const id of [...loads.keys()]) {
      if (!keep.has(id)) loads.delete(id);
    }
    for (const seg of upcoming) loadFor(seg);
  };

  // Invalidate the loop and cancel whatever is sounding. Never emits events.
  const interrupt = (fade: boolean): void => {
    gen++;
    loopActive = false;
    const cur = current;
    current = null;
    cur?.cancel(fade);
  };

  const waitGap = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        current = null;
        resolve(true);
      }, GAP_MS);
      current = {
        segId: null,
        fraction: () => 0,
        cancel: () => {
          clearTimeout(timer);
          resolve(false);
        },
      };
    });

  // Plays one item. Resolves true on natural end, false if cancelled.
  const playItem = async (seg: Segment, loaded: Loaded): Promise<boolean> => {
    let live = true;
    let inner: Playback | null = null;
    let settle: (ok: boolean) => void = () => undefined;
    const outcome = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const finish: Finish = (ok) => {
      if (live) {
        live = false;
        settle(ok);
      }
    };
    current = {
      segId: seg.id,
      fraction: () => (inner ? inner.fraction() : 0),
      cancel: (fade) => {
        if (!live) return;
        live = false;
        inner?.cancel(fade);
        settle(false);
      },
    };

    const g = getGraph();
    if (g && loaded.buffer) await g.ctx.resume().catch(() => undefined);
    if (!live) return false;

    try {
      inner = startPlayback(loaded, g, finish);
    } catch (err) {
      warnOnce("playback", err);
      inner = playSim(loaded.durationMs, finish);
    }
    if (firstAudioPending) {
      firstAudioPending = false;
      try { opts.onFirstAudio?.(); } catch (err) { console.warn("[tts] onFirstAudio threw", err); }
    }
    started.emit(seg.id);
    return outcome;
  };

  const run = async (myGen: number): Promise<void> => {
    while (myGen === gen && pos < history.length) {
      const seg = history[pos];
      prefetch();
      const loaded = await loadFor(seg);
      if (myGen !== gen) return;
      const ok = await playItem(seg, loaded);
      if (myGen !== gen) return;
      current = null;
      if (!ok) return;
      pos++;
      ended.emit(seg.id);
      if (myGen !== gen) return;
      if (pos < history.length) {
        const gapOk = await waitGap();
        if (myGen !== gen || !gapOk) return;
      }
    }
    if (myGen === gen) {
      loopActive = false;
      idle.emit();
    }
  };

  const startRun = (): void => {
    loopActive = true;
    paused = false;
    const myGen = gen;
    run(myGen).catch((err) => {
      // Skip the item that broke the loop so the queue keeps moving.
      warnOnce("playback loop", err);
      if (myGen === gen) {
        current = null;
        pos++;
        startRun();
      }
    });
  };

  const append = (segments: Segment[]): void => {
    if (segments.length === 0) return;
    history.push(...segments);
    if (!loopActive && !paused) startRun();
    else prefetch();
  };

  const stop = (): void => {
    interrupt(true);
    history = [];
    pos = 0;
    paused = false;
    firstAudioPending = true;
    loads.clear();
  };

  const speak = (segments: Segment[]): void => {
    stop();
    append(segments);
  };

  const pause = (): PausePoint | null => {
    const seg = history[pos];
    if (!loopActive || !seg) return null;
    const fractionPlayed = current ? clamp01(current.fraction()) : 0;
    paused = true;
    interrupt(true);
    return { segmentId: seg.id, fractionPlayed };
  };

  const resume = (fromSegmentId: string): void => {
    const idx = history.findIndex((s) => s.id === fromSegmentId);
    if (idx >= 0) pos = idx;
    interrupt(true);
    paused = false;
    if (pos < history.length) startRun();
  };

  return {
    speak,
    append,
    pause,
    resume,
    stop,
    onSegmentStarted: (cb) => started.add(cb),
    onSegmentEnded: (cb) => ended.add(cb),
    onIdle: (cb) => idle.add(cb),
    isPlaying: () => loopActive,
    currentSegmentId: () => current?.segId ?? null,
  };
}
