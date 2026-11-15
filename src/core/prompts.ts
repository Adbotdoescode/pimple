import raw from "../../shared/tutor_system_prompt.md?raw";
import type { CaptureResult } from "../../shared/contracts";
import type { TutorCallInput } from "./claude";

export const TUTOR_SYSTEM_PROMPT: string = raw;

export const SUMMARY_SYSTEM_PROMPT = `You look at a screenshot region a student selected. Reply with exactly ONE short spoken sentence (max 25 words) saying what it shows, starting with "I'm looking at". No markdown, no question.`;

export const VERIFIER_SYSTEM_PROMPT = `You are a strict fact checker for a tutor. You get the screenshot the tutor saw, the student's question, and the tutor's draft answer (sentences and shape labels). List every claim in the draft that CONTRADICTS the screenshot (wrong numbers, wrong labels, wrong objects, wrong direction or step) or is factually false. Anything derivable from the visible numbers by simple arithmetic or standard reasoning, and anything the page itself states or implies, is supported. Ignore style. When in doubt, pass. verdict is "pass" when the list is empty, else "fail".`;

export const VERIFIER_SEGMENT_PROMPT = `You check one sentence a tutor is about to say about the screenshot. Flag a claim ONLY if it CONTRADICTS the screenshot (wrong number, label, object, direction, step) or is factually false. Anything derivable from the visible numbers by simple arithmetic or standard reasoning, and anything the page itself states or implies, is supported. When in doubt, pass.`;

/** Image content block for the Claude request. Placed BEFORE the text block by callers. */
export function imageBlock(capture: CaptureResult) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/jpeg" as const,
      data: capture.imageBase64,
    },
  };
}

export function buildTutorUserText(input: TutorCallInput): string {
  const { capture } = input;
  const parts: string[] = [
    `Image size: ${capture.imageWidth}×${capture.imageHeight} px. All overlay coordinates are pixels of this image.`,
    `Student question: "${input.question}"`,
  ];

  if (input.interruption) {
    const i = input.interruption;
    const spoken = i.spokenSegments.map((s) => `${s.id}: "${s.text}"`).join(" | ") || "none";
    parts.push(
      `INTERRUPTION. The student stopped you during sentence ${i.segmentId}: "${i.segmentText}". ` +
        `Sentences already spoken: ${spoken}. ` +
        `Shapes on screen (JSON, compact): ${JSON.stringify(i.shapes)}. ` +
        `Their objection: "${i.objection}". ` +
        `Answer ONLY this objection as a short side note (1–3 sentences) with its own shapes ` +
        `(use color_role "accent"), ids prefixed "n". If it is off-topic, park it instead.`,
    );
  }

  if (input.checkAnswer) {
    const c = input.checkAnswer;
    parts.push(
      `CHECK ANSWER. You asked: "${c.checkQuestion}". The student answered: "${c.answer}". ` +
        `Give 1–2 sentences of feedback (correct what is wrong, name the misconception if any). ` +
        `check_question: a follow-up only if the answer shows a misconception, else "".`,
    );
  }

  if (input.critique?.length) {
    parts.push(
      `A fact checker flagged these claims in your previous draft as unsupported; fix or drop them:\n` +
        input.critique.map((c) => `- ${c}`).join("\n"),
    );
  }

  if (input.surfaceHint === "whiteboard") {
    parts.push(`Use surface "whiteboard" (1600×1000 board coordinates).`);
  }

  return parts.join("\n\n");
}
