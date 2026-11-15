import type { AppSettings, CaptureResult, Shape, TutorResponse, VerifierResult } from "../../shared/contracts";
import verifierSchema from "../../shared/verifier.schema.json";
import { getAnthropic } from "./anthropic";
import { VERIFIER_SYSTEM_PROMPT, imageBlock } from "./prompts";

const VERIFIER_TIMEOUT_MS = 3000;
const PASS: VerifierResult = { verdict: "pass", unsupported_claims: [] };

function shapeLabel(s: Shape): string {
  const parts = [s.label, s.magnitude, s.slider?.label].filter((x): x is string => !!x);
  return parts.join(" ");
}

async function runVerifier(
  a: { capture: CaptureResult; question: string; draft: TutorResponse; settings: AppSettings },
  signal: AbortSignal,
): Promise<VerifierResult> {
  const client = await getAnthropic();
  const draft = {
    sentences: a.draft.segments.map((s) => s.text),
    shape_labels: a.draft.shapes.map(shapeLabel).filter((l) => l.length > 0),
  };
  const msg = await client.messages.create(
    {
      model: a.settings.verifierModel,
      max_tokens: 1024,
      output_config: { effort: "low", format: { type: "json_schema", schema: verifierSchema } },
      system: VERIFIER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            imageBlock(a.capture),
            { type: "text", text: `Student question: "${a.question}"\nTutor draft (JSON): ${JSON.stringify(draft)}` },
          ],
        },
      ],
    },
    { signal },
  );
  if (msg.stop_reason === "refusal") throw new Error("refused");

  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(text) as { unsupported_claims?: unknown };
  const claims = Array.isArray(parsed.unsupported_claims)
    ? parsed.unsupported_claims.filter((c): c is string => typeof c === "string")
    : [];
  // Verdict follows the list, so the two can never disagree.
  return { verdict: claims.length > 0 ? "fail" : "pass", unsupported_claims: claims };
}

/**
 * Haiku fact check of the draft against the screenshot. Hard 3 s cap. On timeout or any error
 * returns ran: false with a "pass" verdict, so the caller never blocks on the verifier.
 */
export async function verifyResponse(a: {
  capture: CaptureResult;
  question: string;
  draft: TutorResponse;
  settings: AppSettings;
  signal?: AbortSignal;
}): Promise<{ ran: boolean; result: VerifierResult; ms: number }> {
  const t0 = performance.now();
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  a.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error("verifier timeout"));
    }, VERIFIER_TIMEOUT_MS);
  });
  const work = runVerifier(a, ctl.signal);
  work.catch(() => undefined); // late rejection after the timeout must not surface
  timeout.catch(() => undefined);

  try {
    const result = await Promise.race([work, timeout]);
    return { ran: true, result, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    console.warn(`[verifier] skipped: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, result: PASS, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
    a.signal?.removeEventListener("abort", onOuterAbort);
  }
}
