// Park the card window beside the docked droplet, toward the screen interior, without covering
// the region being explained or the tutor's own drawings. When no position beside the drop keeps
// clear of them, the card is asked to collapse to its minimised pill ("card:auto-minimise").
import { Window } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { info } from "@tauri-apps/plugin-log";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { imagePxToScreen, type Pt, type RectPts, type SessionSnapshot, type Shape } from "@shared/contracts";
import { getSession } from "../../lib/sessionMirror";

const GAP = 10;
const EDGE = 8;
const FALLBACK = { w: 380, h: 260 };
const PILL = { w: 340, h: 44 };
const DRAW_PAD = 16;
/** Sent to the card window: {minimise: boolean}. The card collapses to / expands from its pill. */
export const AUTO_MINIMISE_EVENT = "card:auto-minimise";

let autoMin = false; // we asked the card to minimise (so we may ask it to expand again)
let lastFull = { ...FALLBACK }; // last expanded card size seen
let lastLine = "";
let userMoved = false; // the user dragged the card: leave it alone until the session ends

/** The card window reported a user drag ("card:user-moved"): stop docking and auto-minimising. */
export function cardUserMoved(): void {
  userMoved = true;
  autoMin = false;
}
/** The whiteboard window's rect in screen points while it is visible ("whiteboard:rect"). */
let whiteboard: RectPts | null = null;
export function setWhiteboardRect(r: RectPts | null): void {
  whiteboard = r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0 ? r : null;
}
/** Session over: the card docks beside the drop again. */
export function cardSessionEnded(): void {
  userMoved = false;
}

/** Union bbox (global points, padded) of everything the tutor has drawn on the overlay. */
export function drawingsBBox(s: SessionSnapshot): RectPts | null {
  const cap = s.capture;
  if (!cap || !(cap.pixelScale > 0)) return null;
  const shapes: Shape[] = [];
  if (s.response && s.response.surface === "overlay") shapes.push(...(s.response.shapes ?? []));
  if (s.sideNote && (!s.response || s.response.surface === "overlay")) shapes.push(...(s.sideNote.shapes ?? []));
  if (shapes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Pt | undefined, padX = 0, padY = 0) => {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    const q = imagePxToScreen(cap, p);
    x0 = Math.min(x0, q[0] - padX);
    y0 = Math.min(y0, q[1] - padY);
    x1 = Math.max(x1, q[0] + padX);
    y1 = Math.max(y1, q[1] + padY);
  };
  for (const sh of shapes) {
    const labelHalf = sh.label ? Math.min(220, sh.label.length * 4 + 12) : 0;
    if (sh.center) {
      const r = Number.isFinite(sh.radius) ? (sh.radius as number) / cap.pixelScale : 0;
      // A text shape is anchored at its centre; a labelled circle carries its label nearby.
      if (sh.kind === "text") add(sh.center, labelHalf, 14);
      else add(sh.center, r, r);
    }
    if (sh.rect && sh.rect.every(Number.isFinite)) {
      add([sh.rect[0], sh.rect[1]]);
      add([sh.rect[0] + sh.rect[2], sh.rect[1] + sh.rect[3]]);
    }
    add(sh.from);
    add(sh.to);
    if (sh.from && sh.to && sh.label) add([(sh.from[0] + sh.to[0]) / 2, (sh.from[1] + sh.to[1]) / 2], labelHalf, 14);
    for (const p of sh.points ?? []) add(p);
  }
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return { x: x0 - DRAW_PAD, y: y0 - DRAW_PAD, w: x1 - x0 + 2 * DRAW_PAD, h: y1 - y0 + 2 * DRAW_PAD };
}

const hits = (x: number, y: number, w: number, h: number, r: RectPts) =>
  x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y;

/**
 * A y for a w×h card at column x that clears every rect. The preferred y (beside the drop) wins
 * when it is free; otherwise the card slides into the LARGER free space above or below the
 * occupied area in its column. null when neither side is tall enough.
 */
function slide(x: number, w: number, h: number, prefer: number, frame: RectPts, avoid: RectPts[]): number | null {
  const lo = frame.y + EDGE;
  const hi = frame.y + frame.h - h - EDGE;
  if (hi < lo) return null;
  const p = Math.min(Math.max(prefer, lo), hi);
  const col = avoid.filter((r) => x < r.x + r.w && x + w > r.x);
  if (!col.some((r) => hits(x, p, w, h, r))) return p;
  const top = Math.min(...col.map((r) => r.y));
  const bottom = Math.max(...col.map((r) => r.y + r.h));
  const above = top - GAP - lo; // free height above the area
  const below = hi + h - (bottom + GAP); // free height below it
  const yAbove = above >= h ? Math.min(top - GAP - h, p) : null;
  const yBelow = below >= h ? Math.max(bottom + GAP, p) : null;
  if (below >= above) return yBelow ?? yAbove;
  return yAbove ?? yBelow;
}

/** Nudge the card back inside the display (8 pt margin) without otherwise moving it. */
async function keepOnDisplay(frame: RectPts, logErr: (tag: string, e: unknown) => void): Promise<void> {
  try {
    const card = await Window.getByLabel("card");
    if (!card) return;
    const [pos, size, scale] = await Promise.all([card.outerPosition(), card.outerSize(), card.scaleFactor()]);
    const k = scale > 0 ? scale : 1;
    const x = pos.x / k, y = pos.y / k, w = size.width / k, h = size.height / k;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return;
    const mid = x + w / 2;
    if (mid < frame.x || mid > frame.x + frame.w) return; // on another display: not ours to move
    const nx = Math.max(frame.x + EDGE, Math.min(x, frame.x + frame.w - w - EDGE));
    const ny = Math.max(frame.y + EDGE, Math.min(y, frame.y + frame.h - h - EDGE));
    if (Math.abs(nx - x) < 0.5 && Math.abs(ny - y) < 0.5) return;
    await card.setPosition(new LogicalPosition(Math.round(nx), Math.round(ny)));
  } catch (e) {
    logErr("card keep on display", e);
  }
}

/**
 * @param cx,cy  drop centre, global logical points
 * @param radius drop radius at rest
 * @param frame  display the bubble is on
 * @param region the committed target region (kept clear, like the drawings)
 */
export async function dockCard(
  cx: number,
  cy: number,
  radius: number,
  frame: RectPts,
  logErr: (tag: string, e: unknown) => void,
  region?: RectPts | null,
): Promise<void> {
  if (![cx, cy, radius].every(Number.isFinite)) return;
  if (userMoved) {
    // The learner's spot wins, but a card that has grown must not hang off the display.
    await keepOnDisplay(frame, logErr);
    return;
  }
  try {
    const card = await Window.getByLabel("card");
    if (!card) return;
    let w = FALLBACK.w;
    let h = FALLBACK.h;
    try {
      const [size, scale] = await Promise.all([card.outerSize(), card.scaleFactor()]);
      const s = scale > 0 ? scale : 1;
      if (size.width > 0 && size.height > 0) {
        w = size.width / s;
        h = size.height / s;
      }
    } catch (e) {
      logErr("card size", e);
    }
    const isPill = h < 80;
    if (!isPill) lastFull = { w, h };

    const snap = getSession();
    if (snap.phase === "idle" && autoMin) {
      // The session is over: hand the card back expanded for the next one.
      autoMin = false;
      emitTo("card", AUTO_MINIMISE_EVENT, { minimise: false }).catch((e) => logErr("auto-minimise emit", e));
    }
    const avoid: RectPts[] = [];
    const ok = (r: RectPts | null | undefined): r is RectPts =>
      !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;
    if (ok(region)) avoid.push({ x: region.x - GAP, y: region.y - GAP, w: region.w + 2 * GAP, h: region.h + 2 * GAP });
    // Whiteboard answers are drawn in the board's own 1600×1000 space, not on screen: while the
    // board is up, keep clear of its window instead of mapping shapes to the display.
    const drawn = whiteboard || snap.response?.surface === "whiteboard" ? null : drawingsBBox(snap);
    if (ok(drawn)) avoid.push(drawn);
    if (ok(whiteboard)) avoid.push(whiteboard);
    // The focus crop is what the learner pointed at: it stays visible too.
    const focus = snap.phase === "idle" ? null : snap.capture?.focus?.regionInScreenPoints;
    if (ok(focus)) avoid.push(focus);

    const onRight = cx > frame.x + frame.w / 2;
    const colX = (cw: number) =>
      Math.min(Math.max(onRight ? cx - radius - GAP - cw : cx + radius + GAP, frame.x), frame.x + frame.w - cw);
    const prefer = cy - radius - 6;

    // Would the EXPANDED card fit somewhere along the drop's column?
    const full = isPill ? lastFull : { w, h };
    const yFull = slide(colX(full.w), full.w, full.h, prefer, frame, avoid);

    let x: number;
    let y: number;
    if (yFull !== null && (!isPill || autoMin)) {
      if (autoMin) {
        autoMin = false;
        emitTo("card", AUTO_MINIMISE_EVENT, { minimise: false }).catch((e) => logErr("auto-minimise emit", e));
      }
      x = colX(full.w);
      y = yFull;
    } else {
      if (yFull === null && !isPill && !autoMin && avoid.length > 0) {
        autoMin = true;
        emitTo("card", AUTO_MINIMISE_EVENT, { minimise: true }).catch((e) => logErr("auto-minimise emit", e));
      }
      // Place the pill (the live one, or the one the card is about to become).
      const pw = isPill ? w : autoMin ? PILL.w : w;
      const ph = isPill ? h : autoMin ? PILL.h : h;
      x = colX(pw);
      const lo = frame.y + EDGE;
      const hi = Math.max(lo, frame.y + frame.h - ph - EDGE);
      y = slide(x, pw, ph, cy - ph / 2, frame, avoid) ?? Math.min(Math.max(prefer, lo), hi);
      if (!isPill && !autoMin) {
        // Nothing to avoid could be cleared and no pill is coming: stay beside the drop.
        x = colX(w);
        y = Math.min(Math.max(prefer, lo), Math.max(lo, frame.y + frame.h - h - EDGE));
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    {
      // Whatever branch chose the spot, the card as it is right now stays fully on the display
      // (a card taller than the space is shifted up to the top margin).
      const liveH = autoMin && !isPill ? PILL.h : h;
      y = Math.max(frame.y + EDGE, Math.min(y, frame.y + frame.h - liveH - EDGE));
    }
    const line = `[bubble] card dock (${Math.round(x)},${Math.round(y)}) size=${Math.round(w)}x${Math.round(h)} avoid=${avoid.length}${whiteboard ? " whiteboard" : ""}${drawn ? ` drawings=(${Math.round(drawn.x)},${Math.round(drawn.y)},${Math.round(drawn.w)}x${Math.round(drawn.h)})` : ""}${autoMin ? " auto-minimised" : ""}`;
    if (line !== lastLine) {
      lastLine = line;
      info(`[js] ${line}`).catch(() => {});
    }
    await card.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  } catch (e) {
    logErr("card dock", e);
  }
}
