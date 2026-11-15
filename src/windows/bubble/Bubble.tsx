import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import type { Phase, UiIntent } from "@shared/contracts";
import { useBubbleGestures, type BubbleGestureOptions } from "./useBubbleGestures";
import { useSttLevel } from "./useSttLevel";
import { lensState } from "./liquidLens";
import "./bubble.css";

/** Phase colour the liquid lens picks up at its rim and halo: [r, g, b, strength]. */
const TINT: Record<string, [number, number, number, number]> = {
  idle: [0.55, 0.82, 1, 0],
  target: [0.55, 0.85, 1, 0.1],
  capture: [1, 1, 1, 0.5],
  listen: [0.3, 0.85, 1, 0.5],
  check: [1, 0.72, 0.25, 0.55],
  think: [0.62, 0.5, 1, 0.5],
  verify: [0.45, 0.6, 1, 0.5],
  speak: [0.75, 0.9, 1, 0.55],
  interrupt: [1, 0.66, 0.2, 0.7],
};
/** Resting drop while the app still needs its key: a gentle amber, slowly breathing. */
const SETUP_TINT: [number, number, number, number] = [1, 0.7, 0.24, 0.42];

type BubbleState =
  | "idle"
  | "target"
  | "capture"
  | "listen"
  | "check"
  | "think"
  | "verify"
  | "speak"
  | "interrupt";

const STATE_OF: Record<Phase, BubbleState> = {
  idle: "idle",
  targeting: "target",
  capturing: "capture",
  listening: "listen",
  checking: "check",
  summarising: "think",
  thinking: "think",
  verifying: "verify",
  speaking: "speak",
  interrupted: "interrupt",
};

/** Per-bar multipliers so the five bars never move in lockstep. */
const BAR_MULT = [0.55, 0.85, 1, 0.8, 0.5];
const BAR_MIN = 4;
const BAR_MAX = 26;

export interface BubbleProps {
  phase: Phase;
  onIntent: (i: UiIntent) => void;
  /** Bubble diameter in px (exposed as --d). */
  diameter?: number;
  /** 0..1 drag speed; intensifies the chromatic edge. */
  motion?: number;
  /** Drag callbacks, wired later by the lead. onClick is owned by Bubble. */
  gestures?: Partial<Omit<BubbleGestureOptions, "onClick">>;
  /** No key yet: the resting drop glows amber and a click opens the app window (the brain's job). */
  needsSetup?: boolean;
  /** Pointer entered / left the drop (used for the "Set up Pimple" hint). */
  onHover?: (over: boolean) => void;
}

export function Bubble({ phase, onIntent, diameter = 68, motion = 0, gestures, needsSetup = false, onHover }: BubbleProps) {
  const state: BubbleState = STATE_OF[phase] ?? "idle";
  const setup = needsSetup && state === "idle";
  const listening = state === "listen" || state === "check";

  const level = useSttLevel(listening);
  const levelRef = useRef(0);
  levelRef.current = level;

  // Tint + breathing halo for the WebGL drop (speaking pulses, thinking breathes, mic follows level).
  useEffect(() => {
    lensState.tint = setup ? SETUP_TINT : (TINT[state] ?? TINT.idle);
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      lensState.pulse =
        setup
          ? 0.35 + 0.3 * Math.sin(t * 1.7)
          : state === "speak"
          ? 0.5 + 0.5 * Math.sin(t * 7)
          : state === "think" || state === "verify"
            ? 0.5 + 0.5 * Math.sin(t * 3)
            : state === "listen" || state === "check"
              ? Math.min(1, Math.sqrt(Math.max(0, levelRef.current)) * 1.6)
              : 0;
      raf = requestAnimationFrame(tick);
    };
    if (setup || (state !== "idle" && state !== "target")) raf = requestAnimationFrame(tick);
    else lensState.pulse = 0;
    return () => cancelAnimationFrame(raf);
  }, [state, setup]);

  const stageRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const pointer = useBubbleGestures({
    ...gestures,
    onClick: () => onIntent({ type: "bubble-click" }),
  });

  // Waveform bars: rAF-driven, written straight to the DOM to avoid React re-renders per frame.
  useEffect(() => {
    if (!listening) return;
    const heights = BAR_MULT.map(() => BAR_MIN);
    let raf = 0;
    const tick = () => {
      const v = Math.min(1, Math.sqrt(Math.max(0, levelRef.current)) * 1.6);
      BAR_MULT.forEach((mult, i) => {
        const jitter = 1 + (Math.random() - 0.5) * 0.2;
        const target = BAR_MIN + (BAR_MAX - BAR_MIN) * Math.min(1, v * mult * jitter);
        heights[i] += (target - heights[i]) * 0.35;
        const el = barRefs.current[i];
        if (el) el.style.height = `${heights[i].toFixed(2)}px`;
      });
      stageRef.current?.style.setProperty("--lvl", v.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [listening]);

  const style = {
    "--d": `${diameter}px`,
    "--motion": String(Math.min(1, Math.max(0, motion))),
  } as CSSProperties;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onIntent({ type: "bubble-click" });
    }
  };

  return (
    <div ref={stageRef} className="gt-stage" style={style}>
      <button
        type="button"
        role="button"
        aria-label="Pimple"
        className="gt-bubble"
        data-state={state}
        data-setup={setup ? "1" : undefined}
        onKeyDown={onKeyDown}
        onPointerEnter={() => onHover?.(true)}
        onPointerLeave={() => onHover?.(false)}
        {...pointer}
      >
        <span className="gt-layer gt-glow" aria-hidden="true" />
        <span className="gt-layer gt-pulse" aria-hidden="true" />
        <span className="gt-layer gt-pulse p2" aria-hidden="true" />

        <span className="gt-layer gt-face" aria-hidden="true">
          <span className="gt-layer gt-shadow" />
          <span className="gt-layer gt-body" />
          <span className="gt-layer gt-inner" />
          <span className="gt-layer gt-clip">
            <span className="gt-sweep" />
          </span>
          <span className="gt-layer gt-ring gt-spin" />
          <span className="gt-layer gt-ring gt-chroma gt-chroma-m" />
          <span className="gt-layer gt-ring gt-chroma gt-chroma-c" />
          <span className="gt-layer gt-ring gt-rim" />
          <span className="gt-layer gt-ring gt-amber" />
          <span className="gt-gloss" />
          <span className="gt-spec" />
          <span className="gt-layer gt-flash" />
          <span className="gt-layer gt-center">
            <span className="gt-core" />
            <span className="gt-bars">
              {BAR_MULT.map((_, i) => (
                <span
                  key={i}
                  className="gt-bar"
                  ref={(el) => {
                    barRefs.current[i] = el;
                  }}
                />
              ))}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}
