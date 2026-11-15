import raw from "../../shared/tutor_system_prompt.md?raw";
import type { CaptureResult } from "../../shared/contracts";
import type { TutorCallInput } from "./claude";

export const TUTOR_SYSTEM_PROMPT: string = raw;

export const SUMMARY_SYSTEM_PROMPT = `You look at a screenshot region a student selected. Reply with exactly ONE short spoken sentence (max 25 words) saying what it shows, starting with "I'm looking at". No markdown, no question.`;

export const VERIFIER_SYSTEM_PROMPT = `You are a strict fact checker for a tutor. You get the screenshot the tutor saw, the student's question, and the tutor's draft answer (sentences and shape labels). List only the claims in the draft that need a flag. SUPPORTED: anything shown on screen; correct arithmetic on on-screen values (check the arithmetic yourself before flagging, to 2 significant figures); standard textbook facts, formulas and reasoning steps. FLAG ONLY: claims that contradict the screen; factually wrong statements; invented specifics (numbers, names, values, labels) that are not on screen and not derivable from it. If you would describe a claim as correct, it is NOT a flag. Each unsupported_claims entry is a short reason (max 12 words) naming the problem, e.g. 'uses 0.35 but the screen says μs = 0.45'. Ignore style. When in doubt, pass. verdict is "pass" when the list is empty, else "fail".`;

export const VERIFIER_SEGMENT_PROMPT = `You check one sentence a tutor is about to say about the screenshot. SUPPORTED: anything shown on screen; correct arithmetic on on-screen values (check the arithmetic yourself before flagging, to 2 significant figures); standard textbook facts, formulas and reasoning steps. FLAG ONLY: claims that contradict the screen; factually wrong statements; invented specifics (numbers, names, values, labels) that are not on screen and not derivable from it. If you would describe a claim as correct, it is NOT a flag. Each unsupported_claims entry is a short reason (max 12 words) naming the problem, e.g. 'uses 0.35 but the screen says μs = 0.45'. When in doubt, pass.`;

export const REWRITE_PROMPT = `Rewrite this one spoken tutor sentence so it is accurate for the screenshot, fixing only the flagged problem. Keep it under 25 words, same role in the explanation, readable notation (e.g. 24.5 N, sin 30°). Reply with the sentence only.`;

export type RequestBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };

/**
 * The image part of a request. With a focus crop (region/lasso) it sends the full screen as context
 * plus the focus crop, both labelled; without one it is just the main image. Callers append their text block.
 */
export function captureBlocks(capture: CaptureResult): RequestBlock[] {
  const main = imageBlock(capture);
  if (!capture.focus) return [main];
  const f = capture.focus;
  const [x, y, w, h] = f.rectInImagePx;
  return [
    {
      type: "text",
      text: `FULL SCREEN (context only; all overlay shape coordinates are pixels of this image, ${capture.imageWidth}×${capture.imageHeight}):`,
    },
    main,
    {
      type: "text",
      text: `FOCUS — the region the learner pointed at; this is the subject of the question. It sits at x,y,w,h = ${x}, ${y}, ${w}, ${h} in the full-screen image.`,
    },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.imageBase64 } },
  ];
}

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

/** Session-level gizmo state the prompt reads. The controller sets it when a diagram is offered or built. */
export const gizmoSession = { offeredThisSession: false };

export function buildTutorUserText(input: TutorCallInput): string {
  const { capture } = input;
  const parts: string[] = [
    `Image size: ${capture.imageWidth}×${capture.imageHeight} px. All overlay coordinates are pixels of this image.`,
    `Student question: "${input.question}"`,
  ];

  if (input.interruption) {
    parts.push("Set topic_changed false: an interruption stays on the current point, and an off-topic one is parked.");
  } else if (input.previousConcept) {
    parts.push(
      `PREVIOUS TOPIC. Your previous answer this session was about "${input.previousConcept}". ` +
        `Set topic_changed true only if what you answer now is about a different concept; ` +
        `false if it stays on that concept (a follow-up, an objection, an answer to your check question) or if you only park an aside.`,
    );
  } else {
    parts.push("This is the first question of the session: set topic_changed false.");
  }

  if (gizmoSession.offeredThisSession) {
    parts.push("An interactive diagram was already offered this session; keep gizmo_offer.recommended false.");
  }
  if (input.followUp) {
    const f = input.followUp;
    const said = f.spokenSegments.map((s) => s.text).join(" ") || "nothing yet";
    parts.push(
      `FOLLOW-UP. Earlier the student asked: "${f.previousQuestion}". You had said: ${said} ` +
        `(shapes on screen: ${JSON.stringify(f.shapes)}). ${f.note} ` +
        `Answer the new question in that context; it replaces the earlier answer.`,
    );
  }

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
    parts.push(
      `WHITEBOARD. Set surface "whiteboard": the student asked for the whiteboard (or the app chose it), and that overrides every other surface rule. ` +
        `Draw the picture from scratch on the blank 1600×1000 board, in board coordinates; the screenshot is context only, so never trace it or reuse its pixel positions.`,
    );
  } else if (input.surfaceHint === "overlay" && (input.interruption || input.checkAnswer)) {
    parts.push(`Use surface "overlay", like your main answer: shape coordinates are pixels of the image.`);
  }

  return parts.join("\n\n");
}
