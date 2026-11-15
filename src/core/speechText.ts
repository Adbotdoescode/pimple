/**
 * Turns on-screen notation into speakable English for TTS.
 * Captions keep the notation ("5 × 9.8 = 49 N"); only the text sent to tts_synthesize
 * goes through toSpeech(). Rules run in order: compound units before single symbols,
 * powers before plain numbers, unit words only directly after a digit.
 */

const GREEK: Record<string, string> = {
  θ: " theta ", φ: " phi ", α: " alpha ", β: " beta ", γ: " gamma ", λ: " lambda ",
  μ: " mu ", µ: " mu ", π: " pi ", ω: " omega ", σ: " sigma ", ρ: " rho ", τ: " tau ",
  Δ: " delta ", Σ: " the sum of ",
};
const GREEK_RE = /[θφαβγλμµπωσρτΔΣ]/g;

const SUB_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

const UNITS: [RegExp, string][] = [
  [/(\d)\s*kN\b/g, "$1 kilonewtons"],
  [/(\d)\s*N\b/g, "$1 newtons"],
  [/(\d)\s*kg\b/g, "$1 kilograms"],
  [/(\d)\s*g\b/g, "$1 grams"],
  [/(\d)\s*cm\b/g, "$1 centimetres"],
  [/(\d)\s*mm\b/g, "$1 millimetres"],
  [/(\d)\s*km\b/g, "$1 kilometres"],
  [/(\d)\s*m\b(?!\/)/g, "$1 metres"],
  [/(\d)\s*s\b/g, "$1 seconds"],
  [/(\d)\s*J\b/g, "$1 joules"],
  [/(\d)\s*W\b/g, "$1 watts"],
  [/(\d)\s*Hz\b/g, "$1 hertz"],
];

export function toSpeech(s: string): string {
  let t = s;

  // Compound units first, so "m/s" is never read as "m" then "/s".
  t = t.replace(/\bm\/s(?:\^2|²)/g, "metres per second squared")
    .replace(/\bm\/s\b/g, "metres per second")
    .replace(/\bkm\/h\b/g, "kilometres per hour");

  // Powers before the general "^n" rule.
  t = t.replace(/\^2(?!\d)|²/g, " squared")
    .replace(/\^3(?!\d)|³/g, " cubed")
    .replace(/\^(\w+)/g, " to the power of $1");

  t = t.replace(/°C/g, " degrees Celsius")
    .replace(/°/g, " degrees")
    .replace(/%/g, " percent");

  // Operators. "x" only counts between two numbers, so variables survive.
  t = t.replace(/√/g, "the square root of ")
    .replace(/[×·]/g, " times ")
    .replace(/÷/g, " divided by ")
    .replace(/(\d)\s*x\s*(?=\d)/g, "$1 times ")
    .replace(/(\d)\s*\/\s*(?=\d)/g, "$1 over ")
    .replace(/(\d)\s+-\s+(?=\d)/g, "$1 minus ")
    .replace(/−/g, " minus ")
    .replace(/≠/g, " is not equal to ")
    .replace(/≈/g, " is about ")
    .replace(/≤/g, " is at most ")
    .replace(/≥/g, " is at least ")
    .replace(/±/g, " plus or minus ")
    .replace(/=/g, " equals ")
    .replace(/</g, " is less than ")
    .replace(/>/g, " is greater than ")
    .replace(/\+/g, " plus ");

  t = t.replace(GREEK_RE, (ch) => GREEK[ch] ?? ch);

  t = t.replace(/\bsin\b/g, "sine")
    .replace(/\bcos\b/g, "cosine")
    .replace(/\btan\b/g, "tangent")
    .replace(/\bln\b/g, "natural log")
    .replace(/\blog\b/g, "log");

  for (const [re, rep] of UNITS) t = t.replace(re, rep);

  // Subscripts: v_0 reads as "v zero", F_N as "F N", v_1 as "v sub 1", v₂ as "v sub 2".
  t = t.replace(/\bv(?:_\{?0\}?|₀)(?!\d)/g, "v zero")
    .replace(/([A-Za-z])_\{?([A-Za-z]+)\}?/g, "$1 $2")
    .replace(/([A-Za-z])_\{?(\d+)\}?/g, "$1 sub $2")
    .replace(/[₀-₉]/g, (c) => ` sub ${SUB_DIGITS.indexOf(c)}`);

  return t.replace(/\s+/g, " ").trim();
}

/** Documentation only: [notation, expected speech]. Not run by the app. */
export const SPEECH_SELF_CHECK: [string, string][] = [
  ["5 × 9.8 × sin 30° = 24.5 N", "5 times 9.8 times sine 30 degrees equals 24.5 newtons"],
  ["m/s²", "metres per second squared"],
  ["5 m/s² in 2 s", "5 metres per second squared in 2 seconds"],
  ["v_0 = 0 m/s", "v zero equals 0 metres per second"],
  ["F_net = m a", "F net equals m a"],
  ["ΔT ≈ 8.7°C", "delta T is about 8.7 degrees Celsius"],
  ["x^2 + y^3", "x squared plus y cubed"],
  ["ω = 2π f", "omega equals 2 pi f"],
  ["5 kN and 3 cm", "5 kilonewtons and 3 centimetres"],
  ["1/2 of 10 km/h", "1 over 2 of 10 kilometres per hour"],
  ["2 x 3 x 4", "2 times 3 times 4"],
  ["8 − 3", "8 minus 3"],
];
