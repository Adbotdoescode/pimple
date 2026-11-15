import type { AppSettings, CaptureResult, Segment, Shape, TutorResponse } from "../../shared/contracts";
import tutorSchema from "../../shared/tutor_response.schema.json";
import { getAnthropic, readableApiError } from "./anthropic";
import { createResponseStreamParser } from "./jsonStream";
import { TUTOR_SYSTEM_PROMPT, buildTutorUserText, captureBlocks } from "./prompts";

export interface TutorCallInput {
  capture: CaptureResult; // must include imageBase64
  question: string;
  settings: AppSettings;
  interruption?: { segmentId: string; segmentText: string; spokenSegments: Segment[]; shapes: Shape[]; objection: string };
  followUp?: { previousQuestion: string; spokenSegments: Segment[]; shapes: Shape[]; note: string };
  checkAnswer?: { checkQuestion: string; answer: string };
  previousConcept?: string; // concept of the previous answer this session; absent for the first question
  critique?: string[];
  surfaceHint?: "overlay" | "whiteboard";
  signal?: AbortSignal;
}

export interface TutorStreamHandlers {
  onFirstToken?(): void;
  onMeta?(m: Partial<TutorResponse>): void;
  onSegment?(s: Segment): void;
  onShape?(s: Shape): void;
}

/**
 * Streams the tutor answer. Segments, shapes and meta are emitted through the handlers as they
 * complete; the returned promise resolves with the normalised full response.
 */
export async function streamTutor(input: TutorCallInput, h: TutorStreamHandlers): Promise<TutorResponse> {
  const client = await getAnthropic();
  const model = input.settings.tutorModel;
  const parser = createResponseStreamParser({ onSegment: h.onSegment, onShape: h.onShape, onMeta: h.onMeta });
  const t0 = performance.now();
  console.info(`[tutor] request start model=${model} fast=${input.settings.fastMode}`);

  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...(input.settings.fastMode ? { speed: "fast" as const } : {}),
      output_config: { effort: "low", format: { type: "json_schema", schema: tutorSchema } },
      system: [{ type: "text", text: TUTOR_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [...cachedCaptureBlocks(input.capture), { type: "text", text: buildTutorUserText(input) }],
        },
      ],
    },
    { signal: input.signal },
  );

  const onAbort = () => stream.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  let text = "";
  let gotFirst = false;
  stream.on("text", (delta) => {
    if (!gotFirst) {
      gotFirst = true;
      console.info(`[tutor] first token +${Math.round(performance.now() - t0)} ms`);
      h.onFirstToken?.();
    }
    text += delta;
    try {
      parser.push(text);
    } catch (err) {
      console.error("[tutor] consumer handler threw", err);
    }
  });

  const final = await stream
    .finalMessage()
    .catch((err: unknown) => {
      throw readableApiError(err, input.signal);
    })
    .finally(() => input.signal?.removeEventListener("abort", onAbort));

  if (final.stop_reason === "refusal") throw new Error("refused");

  const finalText = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("") || text;
  const response = parser.finish(finalText);
  if (final.model !== model) console.warn(`[tutor] answered by ${final.model}, not ${model} (server-side fallback)`);
  console.info(
    `[tutor] done +${Math.round(performance.now() - t0)} ms model=${final.model} stop=${final.stop_reason} ` +
      `segments=${response.segments.length} shapes=${response.shapes.length} surface=${response.surface} ` +
      `in=${final.usage.input_tokens} cache_read=${final.usage.cache_read_input_tokens ?? 0} cache_write=${final.usage.cache_creation_input_tokens ?? 0} out=${final.usage.output_tokens}`,
  );
  return response;
}

/**
 * Capture blocks with a cache breakpoint on the last image: follow-ups on the same capture
 * (interruptions, check answers, regenerations) then reuse system prompt + screenshot from cache.
 */
function cachedCaptureBlocks(capture: CaptureResult) {
  const blocks = captureBlocks(capture);
  const i = blocks.length - 1;
  blocks[i] = { ...blocks[i], cache_control: { type: "ephemeral" as const } } as unknown as (typeof blocks)[number];
  return blocks;
}
