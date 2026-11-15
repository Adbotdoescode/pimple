// Park the card window under (or above) the bubble's visible circle once the bubble is at rest.
import { Window } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import type { RectPts } from "@shared/contracts";

const GAP = 10;
const FALLBACK = { w: 380, h: 260 };

/**
 * @param cx,cy  visible circle centre, global logical points
 * @param radius visible circle radius (28 at rest)
 * @param frame  display the bubble is on
 */
export async function dockCard(
  cx: number,
  cy: number,
  radius: number,
  frame: RectPts,
  logErr: (tag: string, e: unknown) => void,
  avoid?: RectPts | null,
): Promise<void> {
  if (![cx, cy, radius].every(Number.isFinite)) return;
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

    const left = cx - radius;
    const right = cx + radius;
    const top = cy - radius;
    const bottom = cy + radius;
    const onRight = cx > frame.x + frame.w / 2;

    // Beside the droplet, toward the screen interior, top-aligned with it.
    let x = onRight ? left - GAP - w : right + GAP;
    let y = top - 6;
    void bottom;
    y = Math.min(Math.max(y, frame.y + 8), frame.y + frame.h - h - 8);
    // Keep clear of the region being explained: slide below or above it when they overlap.
    if (avoid && [avoid.x, avoid.y, avoid.w, avoid.h].every(Number.isFinite)) {
      const hit = x < avoid.x + avoid.w + GAP && x + w > avoid.x - GAP && y < avoid.y + avoid.h + GAP && y + h > avoid.y - GAP;
      if (hit) {
        const below = avoid.y + avoid.h + GAP * 2;
        const above = avoid.y - GAP * 2 - h;
        const okBelow = below + h <= frame.y + frame.h - 8;
        const okAbove = above >= frame.y + 8;
        if (okBelow && (!okAbove || Math.abs(below - y) <= Math.abs(above - y))) y = below;
        else if (okAbove) y = above;
      }
    }

    x = Math.min(Math.max(x, frame.x), frame.x + frame.w - w);
    y = Math.min(Math.max(y, frame.y), frame.y + frame.h - h);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    await card.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  } catch (e) {
    logErr("card dock", e);
  }
}
