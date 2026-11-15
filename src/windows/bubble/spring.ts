// Tiny damped-spring integrator (semi-implicit Euler, sub-stepped for stability).

export interface SpringCfg {
  k: number; // stiffness
  c: number; // damping
  m?: number; // mass (default 1)
}

/** Damping for a given damping ratio ζ (mass 1). */
export const dampingFor = (k: number, zeta: number): number => 2 * zeta * Math.sqrt(k);

export const SPRING_DRAG: SpringCfg = { k: 700, c: 38 };
export const SPRING_PARK: SpringCfg = { k: 420, c: dampingFor(420, 0.82) };
export const SPRING_RETURN: SpringCfg = { k: 320, c: dampingFor(320, 0.7) };
export const SPRING_RADIUS: SpringCfg = { k: 600, c: dampingFor(600, 1) };

const SUBSTEP = 1 / 240;
export const MAX_DT = 1 / 30;

export interface Spring1 {
  x: number;
  v: number;
}

/** Advance a 1-D spring toward `target` by dt seconds (mutates s). */
export function step1(s: Spring1, target: number, cfg: SpringCfg, dt: number): void {
  const m = cfg.m ?? 1;
  let left = Math.min(Math.max(dt, 0), MAX_DT);
  while (left > 1e-6) {
    const h = Math.min(SUBSTEP, left);
    const a = (-cfg.k * (s.x - target) - cfg.c * s.v) / m;
    s.v += a * h;
    s.x += s.v * h;
    left -= h;
  }
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = target;
    s.v = 0;
  }
}

export interface Spring2 {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Advance a 2-D spring toward (tx, ty) by dt seconds (mutates s). */
export function step2(s: Spring2, tx: number, ty: number, cfg: SpringCfg, dt: number): void {
  const m = cfg.m ?? 1;
  let left = Math.min(Math.max(dt, 0), MAX_DT);
  while (left > 1e-6) {
    const h = Math.min(SUBSTEP, left);
    const ax = (-cfg.k * (s.x - tx) - cfg.c * s.vx) / m;
    const ay = (-cfg.k * (s.y - ty) - cfg.c * s.vy) / m;
    s.vx += ax * h;
    s.vy += ay * h;
    s.x += s.vx * h;
    s.y += s.vy * h;
    left -= h;
  }
  if (![s.x, s.y, s.vx, s.vy].every(Number.isFinite)) {
    s.x = tx;
    s.y = ty;
    s.vx = 0;
    s.vy = 0;
  }
}
