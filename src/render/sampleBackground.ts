import { convertFileSrc } from "@tauri-apps/api/core";
import type { Pt, Shape } from "@shared/contracts";
import { hueFromRgb, relLumFromRgb } from "@/render/palette";

export interface BgSample { lum: number; hue: number }

export interface BgSampler {
  /**
   * Background colour under a shape, sampled from the capture JPEG.
   * Shape coordinates are image pixels. inflatePx = 6 × pixelScale (image px).
   */
  sample(shape: Shape, inflatePx: number): BgSample;
}

const FALLBACK: BgSample = { lum: 0.9, hue: 0 };
const MAX_TESTS = 3000;
const TEXT_CHAR_PX = 9; // screen points per label character
const TEXT_H_PX = 22;   // screen points

interface Pixels { data: Uint8ClampedArray; w: number; h: number }

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${src}`));
    img.src = src;
  });
}

function toPixels(source: CanvasImageSource, w: number, h: number): Pixels | null {
  if (w <= 0 || h <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  try {
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  } catch {
    return null; // tainted canvas
  }
}

async function decode(src: string): Promise<Pixels | null> {
  try {
    const img = await loadImageEl(src);
    const px = toPixels(img, img.naturalWidth, img.naturalHeight);
    if (px) return px;
  } catch (err) {
    console.warn("[sampleBackground] image element failed", err);
  }
  try {
    const blob = await (await fetch(src)).blob();
    const bmp = await createImageBitmap(blob);
    const px = toPixels(bmp, bmp.width, bmp.height);
    bmp.close();
    return px;
  } catch (err) {
    console.warn("[sampleBackground] fetch fallback failed", err);
    return null;
  }
}

interface Geometry {
  path: Path2D;
  fill: boolean;                                   // fill test (text/graph) vs stroke band
  box: [number, number, number, number];           // x0, y0, x1, y1 of the geometry (image px)
  anchor: Pt;
}

function geometryFor(shape: Shape, k: number): Geometry | null {
  const path = new Path2D();
  switch (shape.kind) {
    case "circle": {
      if (!shape.center || shape.radius == null) return null;
      const [cx, cy] = shape.center;
      const r = shape.radius;
      path.arc(cx, cy, r, 0, Math.PI * 2);
      return { path, fill: false, box: [cx - r, cy - r, cx + r, cy + r], anchor: [cx, cy] };
    }
    case "box": {
      if (!shape.rect) return null;
      const [x, y, w, h] = shape.rect;
      path.rect(x, y, w, h);
      return { path, fill: false, box: [x, y, x + w, y + h], anchor: [x + w / 2, y + h / 2] };
    }
    case "line":
    case "arrow":
    case "vector": {
      if (!shape.from || !shape.to) return null;
      const [ax, ay] = shape.from;
      const [bx, by] = shape.to;
      path.moveTo(ax, ay);
      path.lineTo(bx, by);
      if (shape.kind === "vector" && shape.components) {
        path.moveTo(ax, ay);
        path.lineTo(bx, ay);
        path.lineTo(bx, by);
      }
      return {
        path,
        fill: false,
        box: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
        anchor: [(ax + bx) / 2, (ay + by) / 2],
      };
    }
    case "stroke": {
      const pts = shape.points ?? [];
      if (pts.length === 0) return null;
      path.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return {
        path,
        fill: false,
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        anchor: pts[pts.length >> 1],
      };
    }
    case "text": {
      if (!shape.center) return null;
      const [cx, cy] = shape.center;
      // Label box in screen points, converted to image px with k (image px per point).
      const w = Math.max(4, (shape.label?.length ?? 0) * TEXT_CHAR_PX) * k;
      const h = TEXT_H_PX * k;
      path.rect(cx - w / 2, cy - h / 2, w, h);
      return { path, fill: true, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], anchor: [cx, cy] };
    }
    case "graph": {
      if (!shape.rect) return null;
      const [x, y, w, h] = shape.rect;
      path.rect(x, y, w, h);
      return { path, fill: true, box: [x, y, x + w, y + h], anchor: [x + w / 2, y + h / 2] };
    }
    default:
      return null;
  }
}

function measure(px: Pixels, ctx: CanvasRenderingContext2D, shape: Shape, inflatePx: number): BgSample {
  // inflatePx = 6 × pixelScale, so image px per screen point is inflatePx / 6.
  const k = Math.max(0.25, inflatePx / 6);
  const geo = geometryFor(shape, k);
  if (!geo) return FALLBACK;

  const d = geo.fill ? 0 : inflatePx;
  const [bx0, by0, bx1, by1] = geo.box;
  const x0 = Math.max(0, Math.floor(bx0 - d - 1));
  const y0 = Math.max(0, Math.floor(by0 - d - 1));
  const x1 = Math.min(px.w - 1, Math.ceil(bx1 + d + 1));
  const y1 = Math.min(px.h - 1, Math.ceil(by1 + d + 1));
  if (x1 < x0 || y1 < y0) return FALLBACK;

  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  const step = Math.max(1, Math.ceil(Math.sqrt(area / MAX_TESTS)));
  ctx.lineWidth = 2 * d + 3;

  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const hit = geo.fill ? ctx.isPointInPath(geo.path, x, y) : ctx.isPointInStroke(geo.path, x, y);
      if (!hit) continue;
      const i = (y * px.w + x) * 4;
      r += px.data[i];
      g += px.data[i + 1];
      b += px.data[i + 2];
      n++;
    }
  }

  if (n === 0) {
    // Nothing landed in the band (very thin or tiny shape): read the anchor pixel instead.
    const ax = Math.min(px.w - 1, Math.max(0, Math.round(geo.anchor[0])));
    const ay = Math.min(px.h - 1, Math.max(0, Math.round(geo.anchor[1])));
    const i = (ay * px.w + ax) * 4;
    r = px.data[i];
    g = px.data[i + 1];
    b = px.data[i + 2];
    n = 1;
  }

  // palette.ts takes sRGB channels in 0..255.
  const R = r / n;
  const G = g / n;
  const B = b / n;
  return { lum: relLumFromRgb(R, G, B), hue: hueFromRgb(R, G, B) };
}

function makeSampler(px: Pixels | null): BgSampler {
  if (!px) return { sample: () => FALLBACK };
  const scratch = document.createElement("canvas").getContext("2d");
  if (!scratch) return { sample: () => FALLBACK };
  const cache = new Map<string, BgSample>();
  return {
    sample(shape, inflatePx) {
      // Key includes the geometry so a reused shape id with new coordinates is not served stale.
      const key = `${shape.id}|${inflatePx}|${JSON.stringify(shape)}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const out = measure(px, scratch, shape, inflatePx);
      cache.set(key, out);
      return out;
    },
  };
}

/** Decode the capture JPEG once and return a sampler over its pixels. Never rejects. */
export async function loadCaptureSampler(imagePath: string): Promise<BgSampler> {
  const px = await decode(convertFileSrc(imagePath));
  if (!px) console.warn("[sampleBackground] no pixels for", imagePath, "- using flat light background");
  return makeSampler(px);
}
