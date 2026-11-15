import type { AppSettings, CaptureResult } from "../../shared/contracts";
import { getAnthropic } from "./anthropic";
import { SUMMARY_SYSTEM_PROMPT, imageBlock } from "./prompts";

const FALLBACK = "I'm looking at the region you picked.";

/** One spoken sentence describing a captured region (Haiku, plain text). Never throws. */
export async function summarizeCapture(a: {
  capture: CaptureResult;
  settings: AppSettings;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    const client = await getAnthropic();
    const msg = await client.messages.create(
      {
        model: a.settings.verifierModel,
        max_tokens: 200,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [imageBlock(a.capture), { type: "text", text: "What does this region show?" }],
          },
        ],
      },
      { signal: a.signal },
    );
    const block = msg.content.find((b) => b.type === "text");
    const text = block?.type === "text" ? block.text.trim() : "";
    return text || FALLBACK;
  } catch (err) {
    console.warn(`[summary] skipped: ${err instanceof Error ? err.message : String(err)}`);
    return FALLBACK;
  }
}
