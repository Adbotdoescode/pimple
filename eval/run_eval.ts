#!/usr/bin/env bun
/*
 * Hand-run hallucination-rate eval for the tutor. A measurement script, not a test suite:
 * no assertions, no pass/fail. It spends API credit.
 * Usage: bun eval/run_eval.ts [--only <id>] [--dry]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { wireToTutorResponse } from "../src/core/jsonStream";
import tutorSchema from "../shared/tutor_response.schema.json";
import verifierSchema from "../shared/verifier.schema.json";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(EVAL_DIR, "..");
const CACHE_DIR = join(EVAL_DIR, ".cache");
const RESULTS_PATH = join(EVAL_DIR, "results.md");

const TUTOR_MODEL = "claude-opus-5-5";
const VERIFIER_MODEL = "claude-haiku-5-5";
const JUDGE_MODEL = "claude-opus-5-5";
const BETAS = ["server-side-fallback-2026-07-01"];

const TUTOR_SYSTEM = readFileSync(join(REPO, "shared/tutor_system_prompt.md"), "utf8");

// Copied from src/core/prompts.ts (VERIFIER_SEGMENT_PROMPT) and src/core/verifier.ts (NOT_A_FLAG). Keep in sync.
const VERIFIER_SEGMENT_PROMPT = `You check one sentence a tutor is about to say about the screenshot. SUPPORTED: anything shown on screen; correct arithmetic on on-screen values (check the arithmetic yourself before flagging, to 2 significant figures); standard textbook facts, formulas and reasoning steps. FLAG ONLY: claims that contradict the screen; factually wrong statements; invented specifics (numbers, names, values, labels) that are not on screen and not derivable from it. If you would describe a claim as correct, it is NOT a flag. Each unsupported_claims entry is a short reason (max 12 words) naming the problem, e.g. 'uses 0.35 but the screen says μs = 0.45'. When in doubt, pass.`;
const NOT_A_FLAG = /arithmetic is correct|is correct|correctly/i;

const JUDGE_SYSTEM = `You grade a tutor's spoken answer for hallucinations. You get the screenshot the tutor saw, the student's question, a reference explanation, key facts a correct answer should reflect, and known wrong claims.
First split the spoken answer into atomic factual claims: one fact, number or step per claim, quoted or closely paraphrased. Skip non-factual lines (greetings, questions, "let's look at", and pointers such as "the arrow I've labelled N" that only say where something is).
Then label each claim:
- supported: true, and either shown on screen, stated in the reference or key facts, or a standard textbook fact or correct derivation from what is on screen or in the question.
- unsupported: not on screen, not in the reference, and not derivable from them; an invented specific (number, value, label, name) that cannot be checked.
- contradicted: conflicts with what is on screen, with the reference, or with a known wrong claim; or is factually wrong.
Check arithmetic yourself. Be strict about numbers and labels, lenient about wording. Give a short why (max 15 words) for every claim.`;

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "label", "why"],
        properties: {
          text: { type: "string" },
          label: { enum: ["supported", "unsupported", "contradicted"] },
          why: { type: "string" },
        },
      },
    },
  },
};

type Mode = "off" | "on";
type Label = "supported" | "unsupported" | "contradicted";
const LABELS: Label[] = ["supported", "unsupported", "contradicted"];

interface Concept {
  id: string;
  fixture: string;
  question: string;
  reference: string;
  key_facts: string[];
  known_wrong: string[];
}
interface Img {
  path: string;
  mediaType: "image/jpeg" | "image/png";
  base64: string;
  sha: string;
  width: number;
  height: number;
}
interface Segment {
  id: string;
  text: string;
}
interface Claim {
  text: string;
  label: Label;
  why: string;
}
interface Row {
  concept: string;
  mode: Mode;
  segments: number;
  dropped: number;
  verifierErrors: number;
  claims: number;
  unsupported: number;
  contradicted: number;
  rate: number | null;
}
interface CacheFile {
  key: string;
  created: string;
  responseText: string;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pct = (r: number | null): string => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);

/** Key from the environment, else the macOS keychain. Never printed. */
function apiKey(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv) return fromEnv;
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", "glass-tutor.anthropic-api-key", "-a", "glass-tutor", "-w"],
    { encoding: "utf8" },
  );
  const key = (r.stdout ?? "").trim();
  if (r.status !== 0 || !key) {
    throw new Error("no API key: set ANTHROPIC_API_KEY or add keychain item glass-tutor.anthropic-api-key (account glass-tutor)");
  }
  return key;
}

function loadConcepts(): Concept[] {
  return JSON.parse(readFileSync(join(EVAL_DIR, "concepts.json"), "utf8")) as Concept[];
}

function loadImage(fixture: string): Img {
  const path = isAbsolute(fixture) ? fixture : join(REPO, fixture);
  const ext = extname(path).toLowerCase();
  const mediaType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : null;
  if (!mediaType) throw new Error(`unsupported image type: ${path}`);
  const bytes = readFileSync(path);
  const sips = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  const width = Number(/pixelWidth:\s*(\d+)/.exec(sips.stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(sips.stdout)?.[1]);
  if (!width || !height) throw new Error(`sips could not read the size of ${path}`);
  return {
    path,
    mediaType,
    base64: bytes.toString("base64"),
    sha: createHash("sha256").update(bytes).digest("hex"),
    width,
    height,
  };
}

/** Same text the app builds (buildTutorUserText) for a plain question with no follow-up or interruption. */
function tutorUserText(img: Img, question: string): string {
  return [
    `Image size: ${img.width}×${img.height} px. All overlay coordinates are pixels of this image.`,
    `Student question: "${question}"`,
  ].join("\n\n");
}

function imageBlock(img: Img) {
  return { type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 } };
}

function cacheKey(img: Img, question: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ model: TUTOR_MODEL, system: TUTOR_SYSTEM, user: tutorUserText(img, question), image: img.sha }))
    .digest("hex");
}

function readCache(id: string, key: string): string | null {
  const p = join(CACHE_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  const c = JSON.parse(readFileSync(p, "utf8")) as CacheFile;
  return c.key === key ? c.responseText : null;
}

function writeCache(id: string, key: string, responseText: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const c: CacheFile = { key, created: new Date().toISOString(), responseText };
  writeFileSync(join(CACHE_DIR, `${id}.json`), JSON.stringify(c, null, 2));
}

function segmentsOf(responseText: string): Segment[] {
  return wireToTutorResponse(JSON.parse(responseText)).segments;
}

/** The tutor answer for this concept: cached if the key still matches, else one app-identical call. */
async function tutorAnswer(client: Anthropic, c: Concept, img: Img): Promise<Segment[]> {
  const key = cacheKey(img, c.question);
  const cached = readCache(c.id, key);
  if (cached !== null) {
    console.log("  tutor: cache hit");
    return segmentsOf(cached);
  }
  const msg = await client.beta.messages.create({
    model: TUTOR_MODEL,
    max_tokens: 8000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: tutorSchema } },
    system: [{ type: "text", text: TUTOR_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [imageBlock(img), { type: "text", text: tutorUserText(img, c.question) }],
      },
    ],
  });
  if (msg.stop_reason === "refusal") throw new Error("tutor refused");
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const segments = segmentsOf(text); // throws if the answer is not valid wire JSON; nothing is cached then
  writeCache(c.id, key, text);
  console.log(`  tutor: called, ${segments.length} sentences`);
  return segments;
}

/** One Haiku check of a sentence, as the app's verifySegment does. Returns the flagged claims. */
async function verifyOne(client: Anthropic, img: Img, question: string, seg: Segment, earlier: Segment[]): Promise<string[]> {
  const text =
    `Student question: "${question}"\n` +
    `Earlier sentences (context, already said): ${JSON.stringify(earlier.map((s) => s.text))}\n` +
    `Check ONLY this sentence: ${seg.text}`;
  const msg = await client.messages.create({
    model: VERIFIER_MODEL,
    max_tokens: 512,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: verifierSchema } },
    system: VERIFIER_SEGMENT_PROMPT,
    messages: [{ role: "user", content: [imageBlock(img), { type: "text", text }] }],
  });
  if (msg.stop_reason === "refusal") throw new Error("verifier refused");
  const raw = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(raw) as { unsupported_claims?: unknown };
  return Array.isArray(parsed.unsupported_claims)
    ? parsed.unsupported_claims.filter((c): c is string => typeof c === "string" && !NOT_A_FLAG.test(c))
    : [];
}

/** Verifier on: keeps sentences the verifier passes. Fail-open on errors, as the app does. */
async function verifySegments(
  client: Anthropic,
  img: Img,
  question: string,
  segments: Segment[],
): Promise<{ kept: Segment[]; errors: number }> {
  const kept: Segment[] = [];
  let errors = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let flagged: string[] = [];
    try {
      flagged = await verifyOne(client, img, question, seg, segments.slice(0, i));
    } catch (err) {
      errors++;
      console.warn(`  verifier ${seg.id} failed, kept (fail-open): ${errMsg(err)}`);
    }
    if (flagged.length === 0) kept.push(seg);
    else console.log(`  verifier dropped ${seg.id}: ${flagged.join("; ")}`);
  }
  return { kept, errors };
}

function isClaim(x: unknown): x is Claim {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.why === "string" && LABELS.includes(o.label as Label);
}

/** Opus splits the spoken answer into atomic claims and labels each one. */
async function judge(client: Anthropic, img: Img, c: Concept, spoken: Segment[]): Promise<Claim[]> {
  const answer = spoken.map((s) => s.text).join(" ") || "(no sentences were spoken)";
  const text = [
    `Student question: "${c.question}"`,
    `Reference explanation: ${c.reference}`,
    `Key facts: ${JSON.stringify(c.key_facts)}`,
    `Known wrong claims: ${JSON.stringify(c.known_wrong)}`,
    `Spoken answer:\n${answer}`,
  ].join("\n\n");
  const msg = await client.beta.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 4000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: JUDGE_SCHEMA } },
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: [imageBlock(img), { type: "text", text }] }],
  });
  if (msg.stop_reason === "refusal") throw new Error("judge refused");
  const raw = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(raw) as { claims?: unknown };
  return Array.isArray(parsed.claims) ? parsed.claims.filter(isClaim) : [];
}

function tally(claims: Claim[]): Pick<Row, "claims" | "unsupported" | "contradicted" | "rate"> {
  const unsupported = claims.filter((c) => c.label === "unsupported").length;
  const contradicted = claims.filter((c) => c.label === "contradicted").length;
  return {
    claims: claims.length,
    unsupported,
    contradicted,
    rate: claims.length ? (unsupported + contradicted) / claims.length : null,
  };
}

interface Totals {
  mode: Mode;
  concepts: number;
  segments: number;
  dropped: number;
  verifierErrors: number;
  claims: number;
  unsupported: number;
  contradicted: number;
  rate: number | null;
}

function totals(rows: Row[], mode: Mode): Totals {
  const rs = rows.filter((r) => r.mode === mode);
  const sum = (k: "segments" | "dropped" | "verifierErrors" | "claims" | "unsupported" | "contradicted") =>
    rs.reduce((a, r) => a + r[k], 0);
  const claims = sum("claims");
  const bad = sum("unsupported") + sum("contradicted");
  return {
    mode,
    concepts: rs.length,
    segments: sum("segments"),
    dropped: sum("dropped"),
    verifierErrors: sum("verifierErrors"),
    claims,
    unsupported: sum("unsupported"),
    contradicted: sum("contradicted"),
    rate: claims ? bad / claims : null,
  };
}

function printDry(c: Concept, img: Img): void {
  const cached = readCache(c.id, cacheKey(img, c.question));
  console.log(`  image: ${img.path} (${img.width}×${img.height}, ${img.mediaType})`);
  console.log(`  tutor: ${cached ? "cache hit, no call" : "1 call"} ${TUTOR_MODEL} (effort low, fallbacks default) -> eval/.cache/${c.id}.json`);
  console.log(`  user text: ${JSON.stringify(tutorUserText(img, c.question))}`);
  const n = cached ? segmentsOf(cached).length : null;
  console.log(`  mode off: 1 judge call ${JUDGE_MODEL} (effort medium)`);
  console.log(`  mode on: ${n ?? "N"} verifier calls ${VERIFIER_MODEL} (effort low), then 1 judge call`);
}

function resultsMarkdown(rows: Row[], failed: string[], date: string): string {
  const lines = [
    "# Hallucination-rate eval",
    "",
    `Date: ${date}`,
    `Models: tutor ${TUTOR_MODEL} (effort low, fallbacks default); verifier ${VERIFIER_MODEL} (one call per sentence, effort low); judge ${JUDGE_MODEL} (effort medium, fallbacks default).`,
    "Rate = (unsupported + contradicted) / claims. Claims are judged against the image, reference, key facts and known wrong claims.",
    "Verifier on drops the sentences it flags (the app rewrites them instead, so this is a stricter approximation). Off and on score the same cached tutor answer.",
    "",
    "| Concept | Mode | Sentences | Dropped | Verifier errors | Claims | Unsupported | Contradicted | Rate |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.concept} | ${r.mode} | ${r.segments} | ${r.dropped} | ${r.verifierErrors} | ${r.claims} | ${r.unsupported} | ${r.contradicted} | ${pct(r.rate)} |`,
    );
  }
  lines.push("", "Totals", "", "| Mode | Concepts | Sentences | Dropped | Claims | Unsupported | Contradicted | Rate |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  const off = totals(rows, "off");
  const on = totals(rows, "on");
  for (const t of [off, on]) {
    lines.push(`| ${t.mode} | ${t.concepts} | ${t.segments} | ${t.dropped} | ${t.claims} | ${t.unsupported} | ${t.contradicted} | ${pct(t.rate)} |`);
  }
  if (off.rate !== null && on.rate !== null) {
    lines.push("", `Change, verifier on minus off: ${((on.rate - off.rate) * 100).toFixed(1)} percentage points.`);
  }
  if (failed.length) lines.push("", `Failed and omitted: ${failed.join(", ")}.`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
  if (onlyIdx >= 0 && !only) throw new Error("--only needs a concept id");

  const all = loadConcepts();
  const concepts = only ? all.filter((c) => c.id === only) : all;
  if (only && concepts.length === 0) {
    throw new Error(`no concept "${only}" in eval/concepts.json (ids: ${all.map((c) => c.id).join(", ")})`);
  }

  if (dry) {
    for (const c of concepts) {
      console.log(`\n${c.id} [dry, no API calls, no writes]`);
      printDry(c, loadImage(c.fixture));
    }
    return;
  }

  const client = new Anthropic({ apiKey: apiKey(), maxRetries: 1 });
  const rows: Row[] = [];
  const failed: string[] = [];

  for (const c of concepts) {
    console.log(`\n${c.id}`);
    let img: Img;
    let segments: Segment[];
    try {
      img = loadImage(c.fixture);
      segments = await tutorAnswer(client, c, img);
    } catch (err) {
      console.error(`  tutor failed: ${errMsg(err)}`);
      failed.push(c.id);
      continue;
    }

    for (const mode of ["off", "on"] as const) {
      try {
        let spoken = segments;
        let verifierErrors = 0;
        if (mode === "on") {
          const v = await verifySegments(client, img, c.question, segments);
          spoken = v.kept;
          verifierErrors = v.errors;
        }
        const claims = await judge(client, img, c, spoken);
        rows.push({
          concept: c.id,
          mode,
          segments: segments.length,
          dropped: segments.length - spoken.length,
          verifierErrors,
          ...tally(claims),
        });
        console.log(`  ${mode}: ${claims.length} claims`);
      } catch (err) {
        console.error(`  ${mode} failed: ${errMsg(err)}`);
        if (!failed.includes(c.id)) failed.push(c.id);
      }
    }
  }

  console.log("");
  console.table(
    rows.map((r) => ({
      concept: r.concept,
      mode: r.mode,
      sentences: r.segments,
      dropped: r.dropped,
      claims: r.claims,
      unsupported: r.unsupported,
      contradicted: r.contradicted,
      rate: pct(r.rate),
    })),
  );
  const t = [totals(rows, "off"), totals(rows, "on")];
  console.table(t.map((x) => ({ mode: x.mode, concepts: x.concepts, claims: x.claims, unsupported: x.unsupported, contradicted: x.contradicted, rate: pct(x.rate) })));

  writeFileSync(RESULTS_PATH, resultsMarkdown(rows, failed, new Date().toISOString().slice(0, 10)));
  console.log(`wrote ${RESULTS_PATH}`);
}

main().catch((err: unknown) => {
  console.error(errMsg(err));
  process.exitCode = 1;
});
