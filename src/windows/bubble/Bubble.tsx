import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import type { Phase, UiIntent } from "@shared/contracts";
import { useBubbleGestures, type BubbleGestureOptions } from "./useBubbleGestures";
import { useSttLevel } from "./useSttLevel";
import "./bubble.css";

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
}

export function Bubble({ phase, onIntent, diameter = 56, motion = 0, gestures }: BubbleProps) {
  const state: BubbleState = STATE_OF[phase] ?? "idle";
  const listening = state === "listen" || state === "check";

  const level = useSttLevel(listening);
  const levelRef = useRef(0);
  levelRef.current = level;

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
        aria-label="Glass Tutor"
        className="gt-bubble"
        data-state={state}
        onKeyDown={onKeyDown}
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
