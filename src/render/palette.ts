import type { ColorRole } from "@shared/contracts";

export interface ShapeStyle {
  stroke: string;
  halo?: string;       // underlay behind the stroke
  labelHalo?: string;  // halo behind label text; undefined means no label halo
  fill?: string;
}

const LIGHT_BG: Record<ColorRole, string> = {
  primary: "#1D4ED8",
  secondary: "#15803D",
  accent: "#B86E00",
  warn: "#C8102E",
};
const DARK_BG: Record<ColorRole, string> = {
  primary: "#22D3EE",
  secondary: "#A3E635",
  accent: "#FACC15",
  warn: "#FF7A66",
};
const SIDENOTE_LIGHT = "#7C3AED";
const SIDENOTE_DARK = "#C4A1FF";
const WHITE_HALO = "rgba(255,255,255,0.92)";
const INK_HALO = "rgba(10,14,24,0.85)";

function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance from sRGB channels 0..255. */
export function relLumFromRgb(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function relLumFromHex(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return relLumFromRgb(r, g, b);
}

/** Hue in degrees 0..360 from sRGB channels 0..255. */
export function hueFromRgb(r: number, g: number, b: number): number {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Legibility halo for a label drawn in `stroke`: white-ish for dark strokes, near-black for light ones. */
export function labelHaloFor(stroke: string): string {
  return relLumFromHex(stroke) < 0.35 ? WHITE_HALO : INK_HALO;
}

function pick(role: ColorRole, light: boolean, variant: "main" | "sidenote"): string {
  if (variant === "sidenote" && role !== "warn") return light ? SIDENOTE_LIGHT : SIDENOTE_DARK;
  const table = light ? LIGHT_BG : DARK_BG;
  return table[role] ?? table.primary;
}

/** Style for a shape drawn over a sampled screen background (overlay). */
export function adaptiveStyle(
  role: ColorRole,
  sampledBg: { lum: number; hue: number },
  variant: "main" | "sidenote" = "main",
): ShapeStyle {
  const light = sampledBg.lum > 0.4;
  const stroke = pick(role, light, variant);
  const ratio = contrastRatio(relLumFromHex(stroke), sampledBg.lum);
  const [r, g, b] = parseHex(stroke);
  const dh = Math.abs(hueFromRgb(r, g, b) - sampledBg.hue) % 360;
  const hueDiff = Math.min(dh, 360 - dh);
  const needsHalo = ratio < 3 || (hueDiff < 25 && ratio < 4.5);
  const haloStyle = needsHalo ? { halo: labelHaloFor(stroke) } : {};
  const labelHalo = ratio < 3
    ? labelHaloFor(stroke)
    : sampledBg.lum > 0.4 ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.5)";
  return { stroke, labelHalo, ...haloStyle };
}

/** Style for a shape drawn on the whiteboard, which has a known theme and no halo. */
export function boardStyle(
  role: ColorRole,
  theme: "light" | "dark",
  variant: "main" | "sidenote" = "main",
): ShapeStyle {
  return { stroke: pick(role, theme === "light", variant) };
}
