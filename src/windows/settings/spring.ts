// Tiny damped-spring helpers for the settings window's jiggle physics.

export interface Spring {
  x: number;
  v: number;
  target: number;
}

export function spring(x: number): Spring {
  return { x, v: 0, target: x };
}

/** Semi-implicit Euler step. k = stiffness, c = damping, dt in seconds. */
export function stepSpring(s: Spring, k: number, c: number, dt: number): void {
  const a = -k * (s.x - s.target) - c * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

export function atRest(s: Spring, eps = 0.02): boolean {
  return Math.abs(s.x - s.target) < eps && Math.abs(s.v) < eps * 20;
}

export function settle(s: Spring): void {
  s.x = s.target;
  s.v = 0;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Runs `tick(dt)` every frame until it returns false, and restarts on `kick()`.
 * The loop sleeps at rest so an idle window costs nothing.
 */
export function makeLoop(tick: (dt: number) => boolean): { kick: () => void; stop: () => void } {
  let raf = 0;
  let last = 0;
  const frame = (t: number) => {
    const dt = Math.min(0.032, last ? (t - last) / 1000 : 0.016);
    last = t;
    if (tick(dt)) raf = requestAnimationFrame(frame);
    else {
      raf = 0;
      last = 0;
    }
  };
  return {
    kick() {
      if (!raf) raf = requestAnimationFrame(frame);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    },
  };
}
