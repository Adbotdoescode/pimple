import type { AppSettings, CaptureResult, Segment, Shape, TutorResponse, VerifierResult } from "../../shared/contracts";
import verifierSchema from "../../shared/verifier.schema.json";
import { getAnthropic } from "./anthropic";
import { REWRITE_PROMPT, VERIFIER_SEGMENT_PROMPT, VERIFIER_SYSTEM_PROMPT, captureBlocks } from "./prompts";

const VERIFIER_TIMEOUT_MS = 4000;
const SEGMENT_TIMEOUT_MS = 3000;
const REWRITE_TIMEOUT_MS = 2000;
const PASS: VerifierResult = { verdict: "pass", unsupported_claims: [] };
// A "claim" that says the thing is correct is not a flag (the checker sometimes lists its own passes).
const NOT_A_FLAG = /arithmetic is correct|is correct|correctly/i;

function shapeLabel(s: Shape): string {
  const parts = [s.label, s.magnitude, s.slider?.label].filter((x): x is string => !!x);
  return parts.join(" ");
}

function errorParts(err: unknown): { name: string; message: string } {
  return err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: "Error", message: String(err) };
}

/** One Haiku check: image + text against a system prompt, structured output. Throws on failure. */
async function callVerifier(args: {
  capture: CaptureResult;
  settings: AppSettings;
  system: string;
  text: string;
  maxTokens: number;
  signal: AbortSignal;
}): Promise<VerifierResult> {
  const client = await getAnthropic();
  const msg = await client.messages.create(
    {
      model: args.settings.verifierModel,
      max_tokens: args.maxTokens,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: verifierSchema } },
      system: args.system,
      messages: [
        {
          role: "user",
          content: [...captureBlocks(args.capture), { type: "text", text: args.text }],
        },
      ],
    },
    { signal: args.signal },
  );
  if (msg.stop_reason === "refusal") throw new Error("refused");

  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(text) as { unsupported_claims?: unknown };
  const claims = Array.isArray(parsed.unsupported_claims)
    ? parsed.unsupported_claims.filter((c): c is string => typeof c === "string" && !NOT_A_FLAG.test(c))
    : [];
  // Verdict follows the list, so the two can never disagree.
  return { verdict: claims.length > 0 ? "fail" : "pass", unsupported_claims: claims };
}

/** Runs `run` with a hard timeout. Aborts the request and rejects on timeout or outer abort. */
async function withTimeout<T>(
  ms: number,
  outer: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error(`verifier timeout after ${ms} ms`));
    }, ms);
  });
  const work = run(ctl.signal);
  work.catch(() => undefined); // a late rejection after the timeout must not surface
  timeout.catch(() => undefined);

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Haiku fact check of the whole draft against the screenshot. Hard 4 s cap. On timeout or any
 * error returns ran: false with a "pass" verdict, so the caller never blocks on the verifier.
 */
export async function verifyResponse(a: {
  capture: CaptureResult;
  question: string;
  draft: TutorResponse;
  settings: AppSettings;
  signal?: AbortSignal;
}): Promise<{ ran: boolean; result: VerifierResult; ms: number }> {
  const t0 = performance.now();
  const draft = {
    sentences: a.draft.segments.map((s) => s.text),
    shape_labels: a.draft.shapes.map(shapeLabel).filter((l) => l.length > 0),
  };
  try {
    const result = await withTimeout(VERIFIER_TIMEOUT_MS, a.signal, (signal) =>
      callVerifier({
        capture: a.capture,
        settings: a.settings,
        system: VERIFIER_SYSTEM_PROMPT,
        text: `Student question: "${a.question}"\nTutor draft (JSON): ${JSON.stringify(draft)}`,
        maxTokens: 1024,
        signal,
      }),
    );
    const ms = Math.round(performance.now() - t0);
    console.info("[verifier]", { ran: true, verdict: result.verdict, claims: result.unsupported_claims.length, ms });
    return { ran: true, result, ms };
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    console.warn("[verifier] failed", { ...errorParts(err), ms });
    console.info("[verifier]", { ran: false, verdict: "pass", claims: 0, ms });
    return { ran: false, result: PASS, ms };
  }
}

/**
 * Haiku check of ONE sentence before it is spoken. Hard 3 s cap. Fails open: on timeout or any
 * error returns ran: false, ok: true, so speech is never held up by the verifier.
 */
export async function verifySegment(a: {
  capture: CaptureResult;
  question: string;
  segment: Segment;
  previous: Segment[];
  settings: AppSettings;
  signal?: AbortSignal;
}): Promise<{ ran: boolean; ok: boolean; claims: string[]; ms: number }> {
  const t0 = performance.now();
  const earlier = a.previous.map((s) => s.text);
  const text =
    `Student question: "${a.question}"\n` +
    `Earlier sentences (context, already said): ${JSON.stringify(earlier)}\n` +
    `Check ONLY this sentence: ${a.segment.text}`;
  try {
    const r = await withTimeout(SEGMENT_TIMEOUT_MS, a.signal, (signal) =>
      callVerifier({
        capture: a.capture,
        settings: a.settings,
        system: VERIFIER_SEGMENT_PROMPT,
        text,
        maxTokens: 512,
        signal,
      }),
    );
    const ms = Math.round(performance.now() - t0);
    const claims = r.unsupported_claims;
    const ok = r.verdict === "pass" || claims.length === 0;
    console.info(`[verifier] seg ${a.segment.id}`, { ok, claims, ms });
    return { ran: true, ok, claims, ms };
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    console.warn(`[verifier] seg ${a.segment.id} skipped`, { ...errorParts(err), ms });
    return { ran: false, ok: true, claims: [], ms };
  }
}

/** Removes one pair of wrapping quotes, if the model added them. */
function trimQuotes(s: string): string {
  const open = /^["“‘']/;
  const close = /["”’']$/;
  return s.length >= 2 && open.test(s) && close.test(s) ? s.slice(1, -1).trim() : s;
}

/**
 * Haiku rewrite of ONE flagged sentence, fixing only the flagged problem. Hard 2 s cap. On timeout,
 * error or empty reply returns ok: false with the original sentence text.
 */
export async function rewriteSentence(a: {
  capture: CaptureResult;
  question: string;
  segment: Segment;
  previous: Segment[];
  claims: string[];
  settings: AppSettings;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; text: string; ms: number }> {
  const t0 = performance.now();
  const original = a.segment.text;
  const text =
    `Student question: "${a.question}"\n` +
    `Earlier sentences (context, already said): ${JSON.stringify(a.previous.map((s) => s.text))}\n` +
    `Flagged sentence: ${original}\n` +
    `Checker's claims: ${JSON.stringify(a.claims)}`;
  try {
    const raw = await withTimeout(REWRITE_TIMEOUT_MS, a.signal, async (signal) => {
      const client = await getAnthropic();
      const msg = await client.messages.create(
        {
          model: a.settings.verifierModel,
          max_tokens: 200,
          thinking: { type: "disabled" },
          output_config: { effort: "low" },
          system: REWRITE_PROMPT,
          messages: [{ role: "user", content: [...captureBlocks(a.capture), { type: "text", text }] }],
        },
        { signal },
      );
      if (msg.stop_reason === "refusal") throw new Error("refused");
      return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    });
    const cleaned = trimQuotes(raw.trim());
    const ms = Math.round(performance.now() - t0);
    if (!cleaned) {
      console.info(`[verifier] rewrite ${a.segment.id}`, { ok: false, ms });
      return { ok: false, text: original, ms };
    }
    console.info(`[verifier] rewrite ${a.segment.id}`, { ok: true, ms });
    return { ok: true, text: cleaned, ms };
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    console.warn(`[verifier] rewrite ${a.segment.id} skipped`, { ...errorParts(err), ms });
    console.info(`[verifier] rewrite ${a.segment.id}`, { ok: false, ms });
    return { ok: false, text: original, ms };
  }
}
