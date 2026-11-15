import type { GraphSpec, Pt, TutorResponse } from "@shared/contracts";

// N = mg cos θ for m = 5 kg (mg = 49 N), sampled every 10°.
const NORMAL_SERIES: Pt[] = Array.from({ length: 10 }, (_, i) => {
  const deg = i * 10;
  return [deg, Math.round(49 * Math.cos((deg * Math.PI) / 180) * 10) / 10];
});

const normalGraph: GraphSpec = {
  x_min: 0,
  x_max: 90,
  y_min: 0,
  y_max: 50,
  x_label: "θ (°)",
  y_label: "N (N)",
  series: [{ label: "N = mg cos θ", style: "line", points: NORMAL_SERIES }],
};

/** Hand-written whiteboard answer on the virtual 1600 × 1000 board. Used by preview.html. */
export const SAMPLE_WHITEBOARD: TutorResponse = {
  concept: "Forces on a block on an incline",
  topic_changed: false,
  summary_sentence:
    "Gravity splits into a push into the slope (N) and a pull along it (mg sin θ), and friction balances the pull.",
  surface: "whiteboard",
  grounding: { source_type: "fixed_source", source_ref: "incline-diagram", quote: "" },
  segments: [
    { id: "s1", text: "This block rests on an incline, so let's list the forces acting on it." },
    {
      id: "s2",
      text: "Gravity pulls it straight down with weight mg, 49 N. Part of that pull runs along the slope.",
    },
    {
      id: "s3",
      text: "The surface pushes back perpendicular to the slope: that's the normal force N, 42 N. Friction f holds the block still, 24.5 N up the slope.",
    },
    {
      id: "s4",
      text: "Tilt the incline and the normal force changes as N = mg cos θ, which the graph shows.",
    },
  ],
  shapes: [
    { id: "slope", segment_id: "s1", kind: "stroke", color_role: "primary", points: [[250, 800], [1050, 350]] },
    { id: "base", segment_id: "s1", kind: "line", color_role: "secondary", from: [150, 800], to: [1150, 800] },
    { id: "block", segment_id: "s1", kind: "box", color_role: "accent", rect: [600, 535, 100, 80], label: "m" },
    {
      id: "mg",
      segment_id: "s2",
      kind: "vector",
      color_role: "warn",
      from: [650, 575],
      to: [650, 715],
      label: "mg",
      magnitude: "49 N",
    },
    {
      id: "mg_par",
      segment_id: "s2",
      kind: "vector",
      color_role: "secondary",
      from: [650, 575],
      to: [589, 609],
      label: "mg sin θ",
      components: true,
    },
    {
      id: "N",
      segment_id: "s3",
      kind: "vector",
      color_role: "primary",
      from: [650, 575],
      to: [591, 470],
      label: "N",
      magnitude: "42 N",
    },
    {
      id: "f",
      segment_id: "s3",
      kind: "vector",
      color_role: "accent",
      from: [650, 575],
      to: [711, 541],
      label: "f",
      magnitude: "24.5 N",
    },
    // Deliberately out of bounds (x = 1640) so the fit/nudge logic is visible.
    { id: "oob", segment_id: "s3", kind: "text", color_role: "accent", center: [1640, 470], label: "f = mg sin θ" },
    { id: "angle", segment_id: "s4", kind: "circle", color_role: "warn", center: [250, 800], radius: 60 },
    { id: "angle_label", segment_id: "s4", kind: "text", color_role: "warn", center: [360, 785], label: "θ = 30°" },
    { id: "graph", segment_id: "s4", kind: "graph", color_role: "primary", rect: [1150, 150, 380, 300], graph: normalGraph },
    {
      id: "angle_slider",
      segment_id: "s4",
      kind: "slider",
      color_role: "accent",
      rect: [1150, 560, 380, 70],
      slider: { label: "Angle θ", min: 0, max: 60, value: 30, step: 1, unit: "°", shape_id: "graph" },
    },
  ],
  check_question: "Why does N shrink as the angle grows?",
  gizmo_offer: { recommended: false, pitch: "" },
  parked: [],
};
