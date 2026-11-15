import { parse, Allow } from "partial-json";
import { z } from "zod";
import { wireToShape } from "../../shared/contracts";
import type { Segment, Shape, TutorResponse, WireShape } from "../../shared/contracts";

export interface ResponseStreamHandlers {
  onSegment?(s: Segment): void;
  onShape?(s: Shape): void;
  onMeta?(m: Partial<TutorResponse>): void;
}

type Grounding = TutorResponse["grounding"];
type Gizmo = TutorResponse["gizmo_offer"];

// Top-level key order of the wire schema. A field is complete once a later key has started.
const ORDER = [
  "concept", "surface", "grounding", "segments", "shapes", "check_question", "gizmo_offer", "parked",
];
const AFTER_SEGMENTS = ["shapes", "check_question", "gizmo_offer", "parked"];
const AFTER_SHAPES = ["check_question", "gizmo_offer", "parked"];

const segmentSchema = z.object({ id: z.string().min(1), text: z.string().min(1) });

// Lenient on missing fields (defaults), strict on enums. wireToShape() does the geometry checks.
const wireShapeSchema = z.object({
  id: z.string().min(1),
  segment_id: z.string().default(""),
  kind: z.enum(["circle", "box", "line", "arrow", "vector", "stroke", "text", "graph", "slider"]),
  color_role: z.enum(["primary", "secondary", "accent", "warn"]),
  points: z.array(z.array(z.number())).default([]),
  radius: z.number().default(0),
  label: z.string().default(""),
  magnitude: z.string().default(""),
  values: z.array(z.number()).default([]),
  target: z.string().default(""),
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseSegment(raw: unknown): Segment | null {
  const r = segmentSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Validates one wire shape and converts it to the friendly Shape. Null = dropped. */
function parseWireShape(raw: unknown, warn: boolean): Shape | null {
  const r = wireShapeSchema.safeParse(raw);
  if (!r.success) {
    if (warn) {
      console.warn("[tutor] dropped invalid shape", isObj(raw) ? raw.id : undefined,
        r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`));
    }
    return null;
  }
  const shape = wireToShape(r.data as WireShape);
  if (!shape && warn) console.warn("[tutor] dropped shape without usable geometry", r.data.id, r.data.kind);
  return shape;
}

function groundingReady(g: unknown): boolean {
  return isObj(g) && typeof g.source_type === "string" && typeof g.source_ref === "string" && typeof g.quote === "string";
}

function normalizeGrounding(g: unknown): Grounding {
  const o = isObj(g) ? g : {};
  return {
    source_type: o.source_type === "fixed_source" ? "fixed_source" : "screen",
    source_ref: typeof o.source_ref === "string" && o.source_ref ? o.source_ref : "your screen",
    quote: typeof o.quote === "string" ? o.quote : "",
  };
}

function normalizeGizmo(g: unknown): Gizmo {
  const pitch = isObj(g) && typeof g.pitch === "string" ? g.pitch : "";
  return { recommended: false, pitch }; // phase 1: never offered
}

function normalizeParked(p: unknown): string[] {
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Normalises a whole (wire-format) response into a TutorResponse with safe defaults.
 * Invalid segments and shapes are dropped; gizmo_offer.recommended is always false.
 */
export function wireToTutorResponse(w: unknown): TutorResponse {
  const o = isObj(w) ? w : {};
  const segments = (Array.isArray(o.segments) ? o.segments : [])
    .map(parseSegment)
    .filter((s): s is Segment => s !== null);
  const shapes = (Array.isArray(o.shapes) ? o.shapes : [])
    .map((s) => parseWireShape(s, false))
    .filter((s): s is Shape => s !== null);
  return {
    concept: typeof o.concept === "string" ? o.concept : "",
    surface: o.surface === "whiteboard" ? "whiteboard" : "overlay",
    grounding: normalizeGrounding(o.grounding),
    segments,
    shapes,
    check_question: typeof o.check_question === "string" ? o.check_question : "",
    gizmo_offer: normalizeGizmo(o.gizmo_offer),
    parked: normalizeParked(o.parked),
  };
}

/**
 * Incremental parser over the growing wire JSON. Emits each segment/shape/meta field exactly once,
 * as soon as it is complete. Feed it every snapshot with push(); call finish() with the final text.
 */
export function createResponseStreamParser(h: ResponseStreamHandlers) {
  let segCursor = 0;
  let shapeCursor = 0;
  const metaSent = new Set<string>();
  let lastObj: Record<string, unknown> | null = null;

  function process(obj: Record<string, unknown>, done: boolean): void {
    const has = (k: string) => k in obj;

    const segs: unknown[] = Array.isArray(obj.segments) ? obj.segments : [];
    const segsClosed = done || AFTER_SEGMENTS.some(has);
    while (segCursor < segs.length && (segsClosed || segCursor < segs.length - 1)) {
      const seg = parseSegment(segs[segCursor]);
      segCursor++;
      if (seg) h.onSegment?.(seg);
    }

    const shapes: unknown[] = Array.isArray(obj.shapes) ? obj.shapes : [];
    const shapesClosed = done || AFTER_SHAPES.some(has);
    while (shapeCursor < shapes.length && (shapesClosed || shapeCursor < shapes.length - 1)) {
      const shape = parseWireShape(shapes[shapeCursor], true);
      shapeCursor++;
      if (shape) h.onShape?.(shape);
    }

    const later = (key: string) => done || ORDER.slice(ORDER.indexOf(key) + 1).some(has);
    const fresh: Partial<TutorResponse> = {};
    const ready = (key: string, valid: boolean): boolean => {
      if (!valid || metaSent.has(key) || !later(key)) return false;
      metaSent.add(key);
      return true;
    };
    if (ready("concept", typeof obj.concept === "string")) fresh.concept = obj.concept as string;
    if (ready("surface", obj.surface === "overlay" || obj.surface === "whiteboard")) {
      fresh.surface = obj.surface as TutorResponse["surface"];
    }
    if (ready("grounding", groundingReady(obj.grounding))) fresh.grounding = normalizeGrounding(obj.grounding);
    if (ready("check_question", typeof obj.check_question === "string")) {
      fresh.check_question = obj.check_question as string;
    }
    if (ready("gizmo_offer", isObj(obj.gizmo_offer))) fresh.gizmo_offer = normalizeGizmo(obj.gizmo_offer);
    if (ready("parked", Array.isArray(obj.parked))) fresh.parked = normalizeParked(obj.parked);
    if (Object.keys(fresh).length) h.onMeta?.(fresh);
  }

  return {
    push(snapshot: string): void {
      let obj: Record<string, unknown> | null = null;
      let done = false;
      try {
        const full: unknown = JSON.parse(snapshot);
        if (isObj(full)) {
          obj = full;
          done = true;
        }
      } catch {
        // still streaming
      }
      if (!done) {
        try {
          const partial: unknown = parse(snapshot, Allow.ALL);
          if (isObj(partial)) obj = partial;
        } catch {
          return; // not parseable yet
        }
      }
      if (!obj) return;
      lastObj = obj;
      process(obj, done);
    },

    finish(finalText: string): TutorResponse {
      let obj: Record<string, unknown> = lastObj ?? {};
      let complete = false;
      try {
        const full: unknown = JSON.parse(finalText);
        if (isObj(full)) {
          obj = full;
          complete = true;
        }
      } catch {
        try {
          const partial: unknown = parse(finalText, Allow.ALL);
          if (isObj(partial)) obj = partial;
        } catch {
          // keep the last good snapshot
        }
      }
      process(obj, complete);

      const r = wireToTutorResponse(obj);
      const rest: Partial<TutorResponse> = {};
      if (!metaSent.has("concept")) rest.concept = r.concept;
      if (!metaSent.has("surface")) rest.surface = r.surface;
      if (!metaSent.has("grounding")) rest.grounding = r.grounding;
      if (!metaSent.has("check_question")) rest.check_question = r.check_question;
      if (!metaSent.has("gizmo_offer")) rest.gizmo_offer = r.gizmo_offer;
      if (!metaSent.has("parked")) rest.parked = r.parked;
      if (Object.keys(rest).length) h.onMeta?.(rest);
      return r;
    },
  };
}
