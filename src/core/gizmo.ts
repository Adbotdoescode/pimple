import type { GizmoReady, GizmoRequest, TutorResponse } from "../../shared/contracts";
import templateHtml from "../../gizmos/template.html?raw";
import { getAnthropic, readableApiError } from "./anthropic";

// ───────────────────────── template derivation (once, at module load) ─────────────────────────

/** Text of the first HTML comment in the kit template: the Kit API documentation. */
const CMT_OPEN = templateHtml.indexOf("<!--");
const CMT_CLOSE = templateHtml.indexOf("-->", CMT_OPEN + 4);
const KIT_DOC = templateHtml.slice(CMT_OPEN + 4, CMT_CLOSE).trim();

/**
 * The last <script> block is the SCENE example. Located from the last closing tag so the
 * "<script>" mentioned inside the KIT comment prose is never mistaken for a block start.
 */
const SCRIPT_CLOSE = templateHtml.lastIndexOf("</script>");
const SCRIPT_OPEN = templateHtml.lastIndexOf("<script", SCRIPT_CLOSE);
const SCRIPT_BODY_START = templateHtml.indexOf(">", SCRIPT_OPEN) + 1;
/** Everything up to and including the opening tag of the scene script. */
const PREFIX = templateHtml.slice(0, SCRIPT_BODY_START);
/** The scene example's source, used as a style reference for the model. */
const SAMPLE_SCENE = templateHtml.slice(SCRIPT_BODY_START, SCRIPT_CLOSE).trim();
/** From the scene's closing </script> to the end of the file. */
const SUFFIX = templateHtml.slice(SCRIPT_CLOSE);

const MODEL = "claude-opus-5-5";
const DEFAULT_TIMEOUT_MS = 45000;
const RETRY_BEFORE_MS = 25000;
const MAX_QUANTITIES = 8;

const SYSTEM =
  "You write the SCENE script for an interactive teaching diagram ('gizmo') that runs inside a fixed design kit. " +
  "Output ONLY JavaScript inside one ```js code block, no prose. " +
  "Use ONLY the Kit API documented below (window.Kit); no other libraries, no network, no fetch, no external images, " +
  "no document.write, no alert. Plain ES2020. " +
  "Do not add an outer try/catch, HTML, or a script tag; the page supplies those. " +
  "Build: 1–3 sections (Kit.section with circled numbers from 0), each a card; one main SVG diagram with in-diagram " +
  "colour-coded labels; at least one Kit.slider driving a draw(v) function that updates the SVG and a Kit.valuePanel of " +
  "live values; a Kit.playButton that animates the slider; and one Kit.equation strip whose coloured terms match the " +
  "diagram colours. Call draw once at the end of setup. Keep the scene under 140 lines. " +
  "Ground every number in the provided quantities; label units. " +
  "Make the slider explore the key relationship of the concept (what changes when the parameter changes). " +
  "Must work at 400–1100 px wide." +
  "\n\nKIT API:\n" +
  KIT_DOC +
  "\n\nEXAMPLE SCENE (style reference; do not copy its content):\n```js\n" +
  SAMPLE_SCENE +
  "\n```";

// ───────────────────────── request building ─────────────────────────

const NUM = String.raw`-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?:[ \t]*×[ \t]*10[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)?`;
/** "name = number unit": name is the token right before "=". Unit optional. */
const NAMED_RE = new RegExp(
  String.raw`(?<![\w])([A-Za-z][A-Za-z0-9_]{0,15})[ \t]*=[ \t]*(${NUM})[ \t]*(°[CFK]?|%|[A-Za-zµμΩ][A-Za-zµμΩ/²³^·]{0,7})?`,
  "g",
);
/** "number unit" with no name, unit required (e.g. "30°", "42.4 N"). */
const UNNAMED_RE = new RegExp(
  String.raw`(?<![\w.])(${NUM})[ \t]*(°[CFK]?|%|[A-Za-zµμΩ][A-Za-zµμΩ/²³^·]{0,5})`,
  "g",
);

interface KeyQuantity {
  name: string;
  value: string;
  unit: string;
}

function extractKeyQuantities(texts: string[]): KeyQuantity[] {
  const out: KeyQuantity[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string, unit: string) => {
    const key = `${name}|${value}`;
    if (!value || seen.has(key) || out.length >= MAX_QUANTITIES) return;
    seen.add(key);
    out.push({ name, value, unit });
  };
  // Named matches first; they are blanked out so the unnamed pass does not repeat them.
  const rest = texts.map((t) =>
    t.replace(NAMED_RE, (_m, name: string, value: string, unit: string | undefined) => {
      push(name.trim(), value.trim(), (unit ?? "").trim());
      return " ";
    }),
  );
  for (const t of rest) {
    t.replace(UNNAMED_RE, (_m, value: string, unit: string) => {
      push("", value.trim(), unit.trim());
      return " ";
    });
  }
  return out;
}

/** Brief for the scene model: the concept, grounding, key quantities and the explanation. */
export function buildGizmoRequest(resp: TutorResponse, question?: string): GizmoRequest {
  const segmentTexts = (resp.segments ?? []).map((s) => s.text);
  const shapeTexts = (resp.shapes ?? []).flatMap((s) => [s.label ?? "", s.magnitude ?? ""]);
  const keyQuantities = extractKeyQuantities([...segmentTexts, ...shapeTexts].filter((t) => t.length > 0));
  const q = question?.trim();
  return {
    concept: resp.concept,
    grounding: resp.grounding,
    keyQuantities,
    explanation: q ? [`Learner's question: ${q}`, ...segmentTexts] : segmentTexts,
  };
}

function buildUserText(req: GizmoRequest): string {
  const quantities =
    req.keyQuantities.length > 0
      ? req.keyQuantities
          .map((k) => (k.name ? `${k.name} = ${k.value}${k.unit ? " " + k.unit : ""}` : `${k.value}${k.unit ? " " + k.unit : ""}`))
          .join("\n")
      : "(none found; use only numbers that appear in the explanation)";
  const explanation = req.explanation.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return [
    `Concept: ${req.concept}`,
    `Source quote: "${req.grounding.quote}"`,
    `Source: ${req.grounding.source_ref}`,
    "",
    "Key quantities (use these numbers exactly):",
    quantities,
    "",
    "Explanation, numbered:",
    explanation,
    "",
    "Write the scene for this concept.",
  ].join("\n");
}

// ───────────────────────── HTML assembly ─────────────────────────

const CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; ` +
  `style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; ` +
  `base-uri 'none'; form-action 'none'">`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Error guard, emitted before the scene's try block. Defines __gizmoShow (shows the error card once,
 * pinned to the viewport bottom) and routes window errors through it, so errors thrown later inside
 * slider or play callbacks also show the card.
 */
const ERROR_GUARD_PREFIX =
  "var __gizmoShow = (function () {\n" +
  "  var shown = false;\n" +
  "  function show(m) {\n" +
  "    if (shown) return;\n" +
  "    shown = true;\n" +
  "    document.body.insertAdjacentHTML(\"beforeend\", '<div style=\"position:fixed;left:16px;right:16px;bottom:16px;z-index:99;" +
  "box-shadow:0 8px 24px rgba(0,0,0,.15);margin:24px;padding:16px;border-radius:12px;background:#fff4f2;color:#a33;" +
  "font:14px -apple-system\">This diagram hit an error: ' + String(m).replace(/</g,\"&lt;\") + '</div>');\n" +
  "  }\n" +
  "  window.addEventListener(\"error\", function (ev) { show((ev && ev.error && ev.error.message) || ev.message || ev); });\n" +
  "  return show;\n" +
  "})();\n";

const ERROR_GUARD_CATCH = "} catch (e) { __gizmoShow((e && e.message) || e); }";

/** Pure: kit template + scene code + title -> one self-contained page. */
export function assembleGizmoHtml(sceneCode: string, title: string): string {
  // A "</script" inside the code would close the page's script block early.
  const code = sceneCode.trim().replace(/<\/script/gi, () => "<\\/script");
  const scene = `${ERROR_GUARD_PREFIX}try {\n${code}\n${ERROR_GUARD_CATCH}`;
  let html = `${PREFIX}\n${scene}\n${SUFFIX}`;

  const safeTitle = escapeHtml(title);
  if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title>${safeTitle}</title>`);
  } else if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n<title>${safeTitle}</title>`);
  } else {
    html = `<title>${safeTitle}</title>\n${html}`;
  }

  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${CSP}`);
  } else {
    html = `${CSP}\n${html}`;
  }
  return html;
}

// ───────────────────────── model call ─────────────────────────

type Turn = { role: "user" | "assistant"; content: { type: "text"; text: string }[] };

/** Pulls the scene code out of the reply: first js/javascript/bare fence, else the whole text. */
function extractCode(text: string): string {
  const m = /```(?:js|javascript)?[^\n]*\n([\s\S]*?)(?:```|$)/.exec(text);
  return (m ? m[1] : text).trim();
}

/** Parses the code without running it. Returns the error message, or null when it parses. */
function syntaxError(code: string): string | null {
  try {
    new Function(code);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function callModel(turns: Turn[], signal: AbortSignal): Promise<string> {
  const client = await getAnthropic();
  const res = await client.beta.messages.create(
    {
      model: MODEL,
      max_tokens: 6000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: turns,
    },
    { signal },
  );
  if (res.stop_reason === "refusal") throw new Error("refused");
  return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

/**
 * Asks Claude for a scene script and assembles the page. Never throws.
 * A scene that fails the syntax check gets one corrective retry if there is time left.
 */
export async function generateGizmo(
  req: GizmoRequest,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<GizmoReady> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ctrl = new AbortController();
  const outerSignal = opts?.signal;
  const onOuterAbort = () => ctrl.abort();
  if (outerSignal?.aborted) ctrl.abort();
  else outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  try {
    const turns: Turn[] = [{ role: "user", content: [{ type: "text", text: buildUserText(req) }] }];
    let raw = await callModel(turns, ctrl.signal);
    let code = extractCode(raw);
    let err = syntaxError(code);

    if (err && elapsed() < RETRY_BEFORE_MS) {
      turns.push({ role: "assistant", content: [{ type: "text", text: raw }] });
      turns.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Your previous code had a syntax error: ${err}. Return the full corrected scene.`,
          },
        ],
      });
      raw = await callModel(turns, ctrl.signal);
      code = extractCode(raw);
      err = syntaxError(code);
    }

    if (err) {
      const error = `syntax: ${err}`;
      console.warn(`[gizmo] failed ms=${elapsed()} ${error}`);
      return { ok: false, error, ms: elapsed() };
    }

    const html = assembleGizmoHtml(code, req.concept);
    console.info(`[gizmo] ok ms=${elapsed()} chars=${html.length}`);
    return { ok: true, html, ms: elapsed() };
  } catch (e) {
    if (timedOut) {
      console.warn(`[gizmo] failed ms=${elapsed()} timeout`);
      return { ok: false, error: "timeout", ms: elapsed() };
    }
    const error = readableApiError(e, ctrl.signal).message;
    console.warn(`[gizmo] failed ms=${elapsed()} ${error}`);
    return { ok: false, error, ms: elapsed() };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}
