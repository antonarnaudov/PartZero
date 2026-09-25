/**
 * Spec tests: the spec writer's executable tests, written in the `@aicad/evals` hidden-test DSL
 * (same checks, same evaluator), plus the DesignSpec they come with. Results carry **margins**:
 * how much slack a passing test has, or how far a failing one is off.
 */
import { z } from "zod";
import { CHECKS, evaluateTests, measure, testProblems, type CheckContext, type HiddenTest, type Subject, type TestResult } from "@aicad/evals";
import { num, oneLine, vec } from "./format.js";

const BODY_CONDITION_CHECKS = ["volume", "area", "centroid", "bbox_size", "bbox_sorted", "bbox_min", "bbox_max", "face_count", "edge_count", "valid"] as const;

const comparators = {
  eq: z
    .union([z.number(), z.string(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .optional()
    .describe("Exact value (numbers, strings, booleans, or a list such as feature_names)."),
  approx: z
    .union([z.number(), z.array(z.number()), z.literal("$context")])
    .optional()
    .describe('Expected number or vector; needs abs and/or rel. "$context" = same as the starting model (edit tasks).'),
  abs: z.number().optional().describe("Absolute tolerance for approx (mm, mm², mm³)."),
  rel: z.number().optional().describe("Relative tolerance for approx (0.01 = 1%)."),
  between: z
    .union([z.array(z.number()), z.array(z.array(z.number()))])
    .optional()
    .describe("Inclusive [min, max]; for vector measures one [min, max] per element."),
  gte: z.number().optional().describe("Lower bound (inclusive)."),
  lte: z.number().optional().describe("Upper bound (inclusive)."),
};

const params = {
  type: z.string().optional().describe("face_count: plane|cylinder|cone|sphere|torus; edge_count: line|circle|ellipse; feature_count: sketch|extrude|revolve."),
  axis: z.enum(["x", "y", "z"]).optional().describe("Pick one component of a vector measure."),
};

export const bodyConditionSchema = z.strictObject({
  check: z.enum(BODY_CONDITION_CHECKS),
  ...comparators,
  ...params,
});

/** Spec test ids: snake_case identifiers (they are matched exactly and printed into prompts). */
export const SPEC_TEST_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
export const MAX_SPEC_TEST_ID_CHARS = 48;
export const MAX_SPEC_TEST_DESCRIPTION_CHARS = 240;

export const specTestSchema = z.strictObject({
  id: z.string().min(1).max(MAX_SPEC_TEST_ID_CHARS).regex(SPEC_TEST_ID).describe("Unique snake_case id, e.g. outer_size."),
  description: z
    .string()
    .max(MAX_SPEC_TEST_DESCRIPTION_CHARS)
    .describe("What it verifies in plain words (one line), starting with the requirement id, e.g. 'R1: 7 mm across and 1 mm thick'."),
  check: z.enum(CHECKS).describe("The measurement (see the check reference in your instructions)."),
  ...comparators,
  ...params,
  body: z.number().int().optional().describe("Measure one body: 0 = largest by volume, -1 = smallest. Omit for all bodies together."),
  kind: z.enum(["line", "arc", "circle"]).optional().describe("curve_count: which curve kind."),
  diameter: z.array(z.number()).optional().describe("curve_count / hole_pattern / hole_positions: inclusive [min, max] diameter, mm."),
  points: z
    .array(z.array(z.number()))
    .optional()
    .describe(
      "hole_pattern: 2D/3D centres (spacing only matters); hole_positions: 3D points on hole axes, or with relative_to \"edges\" [a, b] distances from the hole to the nearest part edge along the two directions across it.",
    ),
  relative_to: z
    .enum(["model", "edges"])
    .optional()
    .describe('hole_positions: "model" (default) = absolute 3D points; "edges" = [a, b] offsets from the part edges (placement-independent, e.g. a 3.5 mm inset).'),
  tol: z.number().optional().describe("hole_pattern / hole_positions distance tolerance, mm (default 0.05)."),
  where: z.array(bodyConditionSchema).optional().describe("bodies_matching: per-body conditions; the measure is how many bodies meet all of them."),
});

export type SpecTest = z.infer<typeof specTestSchema>;

export const designSpecSchema = z.strictObject({
  summary: z.string().describe("One or two sentences: what is being made and for what."),
  requirements: z
    .array(
      z.strictObject({
        id: z.string().describe("R1, R2, …"),
        text: z.string().describe("One verifiable requirement. Every feature the request names (hole, bore, slot, pocket, chamfer, fillet, boss, rib, lip, …) is its own requirement."),
        untested_reason: z
          .string()
          .optional()
          .describe(
            "Only when no check can measure this requirement (e.g. a cosmetic thread, a material): why. Never for a hole, bore, slot, pocket, chamfer, fillet, boss, rib, lip or shell — those are measurable. Every other requirement needs at least one test whose description starts with its id, and a feature requirement one whose check sees the feature (volume, face_count, edge_count, area, inner_loops, hole checks — not a bbox alone).",
          ),
      }),
    )
    .describe("Every requirement the request states or clearly implies; each needs a test (description starting with its id, e.g. 'R3: …') unless untested_reason says why none can check it."),
  assumptions: z
    .array(
      z.strictObject({
        id: z.string().describe("A1, A2, …"),
        text: z.string().describe("What was not specified."),
        default: z.string().describe("The value chosen (an editable parameter chip)."),
      }),
    )
    .describe("Unstated choices with the default taken."),
  key_dimensions: z
    .array(z.strictObject({ name: z.string(), value: z.number(), unit: z.string().describe("mm, deg, mm², mm³") }))
    .describe("The numbers the design hinges on."),
});

export type DesignSpecInput = z.infer<typeof designSpecSchema>;

export interface DesignSpec extends DesignSpecInput {
  tests: HiddenTest[];
}

/** Drop absent optional keys so the DSL validator sees exactly what was given. */
function clean<T extends object>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

export function toHiddenTests(tests: readonly SpecTest[]): HiddenTest[] {
  return tests.map((t) => clean(t) as unknown as HiddenTest);
}

/** DSL problems (schema + semantics) for spec tests; empty = valid. */
export function specTestProblems(tests: readonly HiddenTest[], hasContext: boolean): string[] {
  return testProblems(tests, { hasContext });
}

// ─── One test per requested feature ─────────────────────────────────────────────────────────────
//
// The CLI live test (docs/BACKLOG.md, "CLI providers") showed a spec writer passing its own tests
// while never checking a requested feature (the knob's blind bore). `submit_spec` therefore refuses
// a spec where
//   (1) a requirement has no test (a test covers a requirement when its description starts with
//       the requirement id);
//   (2) the request names a feature that no requirement mentions;
//   (3) a requirement that names a measurable feature (every group of REQUESTED_FEATURES except a
//       cosmetic thread) carries `untested_reason` — a hole, bore, pocket, chamfer, … can always be
//       measured;
//   (4) a requirement that names a measurable feature is covered only by checks that cannot see it
//       (a bbox, the body count, validity, feature names): at least one covering test must measure
//       something the feature changes (FEATURE_CHECKS);
//   (5) … or only by tests that do not pin it: a covering test that sees the feature must also pin
//       it (eq, approx, between, or a hole predicate) tightly enough to fail without it.
//       `volume gte 0`, `face_count lte 99`, `volume between [0, 1e12]` and `volume approx 32000
//       abs 1e9` pass whether or not the bore is there (see {@link looseness}); so does a count
//       whose type filter cannot see the feature (`face_count type torus eq 0` or `edge_count type
//       ellipse eq 0` for a bore, `face_count type plane` for a round through hole), which counts
//       as blind (4) ({@link blindTypes}).
//   (6) Small features — cavities (hole, bore, slot, pocket) and blends (fillet, chamfer) — are
//       pinned by what they change, not by a fixed fraction of the part: a count only exactly (one
//       through hole, or one filleted edge, changes a count by 1), and a volume or area only when
//       the test's whole tolerance band is narrower than the feature's own share of it. Four 3 mm
//       through holes in an 80×50×8 plate remove 226 mm³ (0.7 %): `volume approx 31774 rel 0.02`
//       passes without them. The share is estimated, as a lower bound, from the sizes the
//       requirement states ({@link featureScope}: a hole's diameter and depth, or "through" and the
//       wall's thickness from the request or the key dimensions — never a height or a hollow part's
//       envelope; the count only from a number right before the noun, never a size after Ø); a
//       blend's share depends on edge lengths no spec states, so a fillet or chamfer is pinned by an
//       exact count only. The knob's `volume approx 10140 rel 0.05` (±507 mm³ around a 283 mm³
//       bore) is refused, its `rel 0.01` (±101 mm³) accepted.
//   (7) In an edit task, a test compared with the starting model (`"$context"`) pins only a
//       requirement that keeps something as it is: for a feature the request adds, removes or
//       resizes, "same as before" holds exactly when the change was not made ({@link looseness}).
// A requirement no check can measure (a cosmetic thread, a material) says why in `untested_reason`.
// When the spec writer never gets past these rules, `specFeatureGaps` lists what stays unchecked
// (the orchestrator puts it in the build header and the proposal's known_issues).

const REQ_ID = "[A-Za-z]{1,3}\\d+[a-z]?";
const REQ_LIST = `${REQ_ID}(?:\\s*(?:[+,&/]|\\band\\b)?\\s*${REQ_ID})*`;
const REQ_PLAIN = new RegExp(`^\\s*(${REQ_LIST})\\s*[:\\-–—).]`);
const REQ_BRACKETED = new RegExp(`^\\s*[\\[(]\\s*(${REQ_LIST})\\s*[\\])]`);

/** The description formats that name requirement ids (quoted in refusals). */
export const REQUIREMENT_ID_FORMATS = '"R2: …", "R1+R3: …", "R1, R2 – …", "R1 R2: …", "[R2] …"';

/**
 * Requirement ids a test covers: the ids its description starts with (`R2: …`, `R1+R3: …`,
 * `R1, R2 – …`, `R1 and R4: …`, `R1 R2: …`, `[R2] …`, `(R2) …`).
 */
export function coveredRequirementIds(description: string): string[] {
  const m = description.match(REQ_BRACKETED) ?? description.match(REQ_PLAIN);
  if (!m) return [];
  return [...m[1]!.matchAll(new RegExp(REQ_ID, "g"))].map((x) => x[0].toUpperCase());
}

/**
 * Features a maker's request can name, with the words that name them. A request word from a group
 * must be matched by some requirement's text with any word of the same group (a "hole" requirement
 * may say "bore").
 */
export const REQUESTED_FEATURES: readonly { feature: string; words: RegExp }[] = [
  { feature: "hole", words: /\b(holes?|bores?|bored|drill(?:ed|ing)?|through-?holes?|counter-?bor(?:e|es|ed)|counter-?sinks?|countersunk|tapped|openings?|apertures?)\b/i },
  { feature: "slot", words: /\b(slots?(?:ted)?|key-?ways?|key-?seats?)\b/i },
  // "socket" is a pocket (a socket for a bearing), but not in "socket head cap screw" / "socket set screw".
  { feature: "pocket", words: /\b(pockets?|recess(?:es|ed)?|cavit(?:y|ies)|cut-?outs?|notch(?:es|ed)?|grooves?|sockets?(?![\s-]*(?:head|cap|set|screw|wrench|driver)))\b/i },
  { feature: "chamfer", words: /\b(chamfer(?:s|ed)?|bevel(?:s|ed|led)?)\b/i },
  { feature: "fillet", words: /\b(fillet(?:s|ed)?|rounded (?:corners?|edges?)|corner radi(?:us|i))\b/i },
  { feature: "boss", words: /\b(boss(?:es)?|stand-?offs?)\b/i },
  { feature: "rib", words: /\b(ribs?|gussets?)\b/i },
  { feature: "lip", words: /\b(lips?|flanges?|ledges?)\b/i },
  { feature: "thread", words: /\bthread(?:s|ed)?\b/i },
  { feature: "hollow", words: /\b(hollow(?:ed)?|shell(?:ed)?)\b/i },
];

/** Feature groups no check can measure: a cosmetic thread changes no geometry (SPEC-v1 §6.5). */
export const UNMEASURABLE_FEATURES: ReadonlySet<string> = new Set(["thread"]);

/**
 * Checks that see a feature of each group: they change when the feature is missing or the wrong
 * size. A bbox, the body count, validity and names never do for a hole or a bore (the knob's blind
 * bore changed neither), so they do not cover a feature requirement on their own.
 */
const GEOMETRY_CHECKS = ["volume", "area", "face_count", "edge_count"] as const;
export const FEATURE_CHECKS: Readonly<Record<string, readonly string[]>> = {
  hole: [...GEOMETRY_CHECKS, "inner_loops", "hole_pattern", "hole_positions", "curve_count"],
  slot: [...GEOMETRY_CHECKS, "inner_loops", "curve_count"],
  pocket: [...GEOMETRY_CHECKS, "inner_loops"],
  chamfer: GEOMETRY_CHECKS,
  fillet: GEOMETRY_CHECKS,
  boss: GEOMETRY_CHECKS,
  rib: GEOMETRY_CHECKS,
  lip: GEOMETRY_CHECKS,
  hollow: GEOMETRY_CHECKS,
};

/** The comparators of a test or a bodies_matching condition (what "pins" a measure). */
export interface CoverageComparators {
  eq?: unknown;
  approx?: unknown;
  abs?: number | undefined;
  rel?: number | undefined;
  between?: unknown;
  gte?: number | undefined;
  lte?: number | undefined;
  /** face_count / edge_count type filter: a type the feature never has makes the count blind to it ({@link blindTypes}). */
  type?: string | undefined;
}

/** What `specCoverage` reads of a test: its description, its check, its comparator and (bodies_matching) its conditions. */
export interface CoverageTest extends CoverageComparators {
  description: string;
  check?: string | undefined;
  where?: readonly ({ check: string } & CoverageComparators)[] | undefined;
}

/**
 * Small features. Cavities: a hole, bore, slot or pocket removes a small share of a part's volume
 * (four 3 mm through holes in an 80×50×8 plate: 0.7 %) and can add a single face (a through hole:
 * one cylinder). Blends: a fillet or chamfer changes it by less still (2 mm fillets on that plate's
 * four vertical edges: 0.09 %) and adds one face per edge. A count pins one only exactly (a range
 * holding one integer: `face_count approx 7 abs 1` passes with the hole missing); a volume or area
 * only within {@link CAVITY_PIN_MAX_REL} **and** with a tolerance band narrower than the feature's
 * own share ({@link featureScope}). A blend's share depends on edge lengths no spec states, so only
 * an exact count pins a fillet or chamfer.
 */
export const CAVITY_FEATURES: ReadonlySet<string> = new Set(["hole", "slot", "pocket"]);
export const BLEND_FEATURES: ReadonlySet<string> = new Set(["fillet", "chamfer"]);
export const CAVITY_PIN_MAX_REL = 0.02;

/** Checks that pass or fail on their own (no comparator). */
const PREDICATE_CHECKS: readonly string[] = ["hole_pattern", "hole_positions"];

/** Integer measures: a feature changes them by whole units. */
const COUNT_CHECKS: readonly string[] = ["face_count", "edge_count", "inner_loops", "curve_count", "bodies_matching"];
/** Measures that are never negative: a range reaching 0 is one-sided on them. */
const NONNEGATIVE_CHECKS: readonly string[] = ["volume", "area", ...COUNT_CHECKS];
/** The continuous measures a small feature changes by its own share. */
const SHARE_CHECKS: readonly string[] = ["volume", "area"];

/**
 * The widest tolerance that still pins a feature: ±10 % of the value for a volume or an area (a
 * spec writer's tolerances are 0.1–5 %; `abs 1e9` on a 32000 mm³ plate is none), ±25 % or ±1 for
 * a count (`face_count between [8, 12]` pins, `[1, 99]` does not). For the other features (boss,
 * rib, lip, shell) a cheap guard against vacuous tests, not a proof; small features are held to
 * their own share instead ({@link CAVITY_FEATURES}).
 */
export const PIN_MAX_REL = 0.1;
export const PIN_MAX_REL_COUNT = 0.25;

const isCount = (check: string | undefined): boolean => check !== undefined && COUNT_CHECKS.includes(check);
const isCavity = (group: string | undefined): boolean => group !== undefined && CAVITY_FEATURES.has(group);
const isBlend = (group: string | undefined): boolean => group !== undefined && BLEND_FEATURES.has(group);
const isSmall = (group: string | undefined): boolean => isCavity(group) || isBlend(group);

/** The widest relative tolerance that pins a feature of `group` with a continuous measure. */
function maxRel(check: string | undefined, group: string | undefined): number {
  return isCount(check) ? PIN_MAX_REL_COUNT : isCavity(group) ? CAVITY_PIN_MAX_REL : PIN_MAX_REL;
}

function maxHalfWidth(check: string | undefined, value: number, group: string | undefined): number {
  const v = Math.abs(value);
  return isCount(check) ? Math.max(1, PIN_MAX_REL_COUNT * v) : maxRel(check, group) * v;
}

function tolText(check: string | undefined, group: string | undefined): string {
  return isCount(check) ? `±${PIN_MAX_REL_COUNT * 100} % or ±1` : `±${maxRel(check, group) * 100} %`;
}

// ─── What a requirement says about its feature ──────────────────────────────────────────────────

/** A feature's own share of a measure: a lower bound (mm³ for a volume, mm² for an area) and how it was read. */
export interface FeatureShare {
  value: number;
  basis: string;
}

/**
 * What the gate knows about one requested feature: its group, the requirement text naming it, the
 * shape words that make some count types blind to it, and — for cavities — lower bounds of its own
 * share of the volume and the area, read from the sizes the requirement states.
 */
export interface FeatureScope {
  group: string;
  /** The requirement's text ("" when only the group is known). */
  text: string;
  /** A round hole (a diameter and no rectangular words): it has no line edges. */
  round: boolean;
  /** Through (not blind): a round one adds no plane face. */
  through: boolean;
  /** At an angle (a slope, oblique, °): a round hole may have ellipse edges. */
  angled: boolean;
  /** The requirement removes the feature: a type count of 0 then sees it. */
  removal: boolean;
  /**
   * The requirement keeps the feature as it is ("keep the 10 mm boss", "the holes stay unchanged"):
   * only then does a comparison with the starting model (`"$context"`) check it — for a feature
   * the requirement adds, removes or resizes, "same as before" holds exactly when it was not done.
   */
  keep: boolean;
  /** A blend on a circular edge ("the top circular edge", "the rim"): a fillet adds a torus, not a cylinder; a chamfer a cone, not a plane. */
  roundEdge: boolean;
  volume?: FeatureShare;
  area?: FeatureShare;
  /** Why there is no volume share: what the requirement would have to state. */
  unknownShare?: string;
}

/** The text around a requirement: the request, the other requirements, the spec's key dimensions. */
export interface ScopeContext {
  texts?: readonly string[];
  keyDimensions?: readonly { name: string; value: number; unit: string }[];
}

const NUM = String.raw`(?<![\d.])(\d+(?:\.\d+)?|\.\d+)`;
const SEP = String.raw`\s*(?:of\s+|=\s*|:\s*)?`;
/** Not a number another measure word claims ("diameter 6 mm, 5 deep": 5 is the depth). */
const NOT_MEASURE = String.raw`(?!\s*(?:mm)?\s*(?:deep|depth|long|length|wide|width|thick|thickness|tall|high|height)\b)`;

function numbersIn(text: string, re: RegExp, scale = 1): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    const v = Number(m[1]) * scale;
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}

const minOf = (xs: readonly number[]): number | undefined => (xs.length > 0 ? Math.min(...xs) : undefined);

/** The nouns of each cavity group, singular or plural, and plural only (a count before a plural noun is an instance count). */
const CAVITY_NOUNS: Readonly<Record<string, string>> = {
  hole: String.raw`(?:through-?)?holes?|bores?|counter-?bores?|counter-?sinks?|openings?|apertures?|drillings?`,
  slot: String.raw`slots?|key-?ways?|key-?seats?`,
  pocket: String.raw`pockets?|recess(?:es)?|cavit(?:y|ies)|cut-?outs?|sockets?|grooves?|notch(?:es)?`,
};
const PLURAL_NOUNS: Readonly<Record<string, string>> = {
  hole: String.raw`(?:through-?)?holes|bores|counter-?bores|counter-?sinks|openings|apertures|drillings`,
  slot: String.raw`slots|key-?ways|key-?seats`,
  pocket: String.raw`pockets|recesses|cavities|cut-?outs|sockets|grooves|notches`,
};
const COUNT_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };

/**
 * Words that may stand between an instance count and its noun: sizes ("3 mm", "Ø6", "M3") and the
 * adjectives of a cavity ("four 3 mm deep counterbored through holes"). Anything else — "per",
 * "plate", "with" — ends the phrase: "2 per side", "6 plate with Ø12 through holes" are no counts.
 */
const COUNT_FILLER = String.raw`(?:(?:[Ø⌀]\s*|M)?\d+(?:\.\d+)?(?:\s*-?\s*mm)?(?:-[a-z]+)?|mm|(?:through|thru|blind|clearance|counter-?bored|counter-?sunk|countersunk|cbored|tapped|threaded|drilled|plain|round|circular|cylindrical|mounting|fixing|bolt|screw|pilot|access|vent|small|large|big|equal|identical|evenly|spaced|evenly-spaced|deep|shallow|wide|long|diameter|dia|diam|additional|extra|matching|same|vertical|horizontal|radial|axial|side|top|bottom|corner|square|rectangular|hex|hexagonal|slotted|flat|bottomed|flat-bottomed)(?:-[a-z]+)?)`;

/**
 * "four 3 mm through holes", "4x M3 holes", "2 × Ø6 bores", "(8 holes)": the instance count — the
 * smallest a text states, 1 when it states none. A lower bound: never a size ("Ø10 through holes"
 * is one or more Ø10 holes, not ten; "200 x 150 x 6 plate with Ø12 through holes" has no count),
 * and no count reads past a word that is not a size or a cavity adjective ("one per corner").
 */
function instanceCount(text: string, group: string): number {
  const words = Object.keys(COUNT_WORDS).join("|");
  // Not a size: no Ø/⌀/M/R/#, "dia"/"radius"/… before it; no unit, degree, percent or "x <number>" after it.
  const notSize = String.raw`(?<![Ø⌀#][\s]*|\b(?:dia(?:meter)?|diam|radius|size|pitch|depth|width|length|thickness|height|spacing)\.?\s*(?:of\s+|=\s*|:\s*)?)`;
  const notUnit = String.raw`(?!\s*-?\s*(?:mm|cm|in\b|"|°|deg|%)|[\d.]|\s*[x×]\s*[\d.])`;
  const re = new RegExp(String.raw`${notSize}(?<![\d.,])\b(${words}|\d+)${notUnit}\s*(?:[x×]\s*)?(?:${COUNT_FILLER}[\s,]*){0,4}?(?:${PLURAL_NOUNS[group]})\b`, "gi");
  let best: number | undefined;
  for (const m of text.matchAll(re)) {
    const v = COUNT_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
    if (Number.isInteger(v) && v >= 1 && v <= 1000) best = best === undefined ? v : Math.min(best, v);
  }
  return best ?? 1;
}

/** Diameters a text states for a cavity (Ø6, M3 → its 2.4 mm tap drill at least, "6 mm diameter", "6 mm blind bore", "radius 3"). */
function diameters(text: string, group: string): number[] {
  const out = [
    ...numbersIn(text, new RegExp(String.raw`[Ø⌀]\s*${NUM}`, "g")),
    ...numbersIn(text, new RegExp(String.raw`\bM${NUM}(?![\d.])`, "g"), 0.8),
    ...numbersIn(text, new RegExp(String.raw`${NUM}\s*mm\s*(?:dia(?:meter)?\b|diam\b|Ø|⌀)`, "gi")),
    ...numbersIn(text, new RegExp(String.raw`\b(?:dia(?:meter)?|diam)\.?${SEP}${NUM}${NOT_MEASURE}`, "gi")),
    ...numbersIn(text, new RegExp(String.raw`${NUM}\s*mm\s*radius\b`, "gi"), 2),
    ...numbersIn(text, new RegExp(String.raw`\bradius${SEP}${NUM}${NOT_MEASURE}`, "gi"), 2),
  ];
  // A length right before the noun ("6 mm blind bore", "3 mm through holes"), no measure word between.
  const before = new RegExp(String.raw`(?<![\d.]\s*(?:mm)?\s*[x×]\s*)(?=${NUM}\s*mm\s+((?:[^\s,;]+\s+){0,3}?)(?:${CAVITY_NOUNS[group]})\b)`, "gi");
  for (const m of text.matchAll(before)) {
    if (/(?:^|\s)(?:deep|depth|long|length|wide|width|thick|thickness|tall|high|height|from|apart|away|spacing|pitch|cent(?:er|re)s?|inset|offset|radius|in|on|at|of|x|×)(?=\s|$)/i.test(m[2] ?? "")) continue;
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}

/** Depths a text states ("10 mm deep", "depth 5", "5 mm depth"). */
function depths(text: string): number[] {
  return [
    ...numbersIn(text, new RegExp(String.raw`${NUM}\s*(?:mm)?\s*deep\b`, "gi")),
    ...numbersIn(text, new RegExp(String.raw`\bdepth${SEP}${NUM}`, "gi")),
    ...numbersIn(text, new RegExp(String.raw`${NUM}\s*(?:mm)?\s*(?:in\s+)?depth\b`, "gi")),
  ];
}

const TRIPLE = new RegExp(String.raw`${NUM}\s*(?:mm)?\s*[x×]\s*${NUM}\s*(?:mm)?\s*[x×]\s*${NUM}(?![\d.])`, "gi");

/** The three sizes of every "A x B x C" in a text. */
function triples(text: string): [number, number, number][] {
  return [...text.matchAll(TRIPLE)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number]).filter((t) => t.every((x) => Number.isFinite(x) && x > 0));
}

/** "A x B" footprints that are not part of an "A x B x C". */
function pairs(text: string): [number, number][] {
  const re = new RegExp(String.raw`(?<![\d.]\s*(?:mm)?\s*[x×]\s*)${NUM}\s*(?:mm)?\s*[x×]\s*${NUM}(?![\d.])(?!\s*(?:mm)?\s*[x×]\s*[\d.])`, "gi");
  const out: [number, number][] = [...text.matchAll(re)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  const wide = minOf([...numbersIn(text, new RegExp(String.raw`${NUM}\s*(?:mm)?\s*wide\b`, "gi")), ...numbersIn(text, new RegExp(String.raw`\bwidth${SEP}${NUM}`, "gi"))]);
  const long = minOf([...numbersIn(text, new RegExp(String.raw`${NUM}\s*(?:mm)?\s*long\b`, "gi")), ...numbersIn(text, new RegExp(String.raw`\blength${SEP}${NUM}`, "gi"))]);
  if (wide !== undefined && long !== undefined) out.push([wide, long]);
  return out.filter((p) => p.every((x) => Number.isFinite(x) && x > 0));
}

/** Parts that are thin walls around a hollow or bent shape: their overall sizes are not the wall a through hole crosses. */
const THIN_WALLED = /\b(?:enclosures?|box(?:es)?|cases?|casings?|housings?|shells?|hollow(?:ed)?|cups?|tubes?|pipes?|channels?|brackets?|angles?|trays?|containers?|bins?|bent|folded|sheet-?metal|[LUZ][- ]?(?:shaped|profiles?|sections?|brackets?|channels?))\b/i;
/** Solid prisms: the smallest of their "A x B x C" is the wall a through hole crosses. */
const SOLID_PRISM = /\b(?:plates?|slabs?|blocks?|bars?|sheets?|panels?|boards?|bricks?|tiles?|coupons?|spacers?|shims?|washers?)\b/i;
/** Stock named by its thickness: "3 mm sheet", "6 mm aluminium plate". */
const STOCK = new RegExp(String.raw`${NUM}\s*(?:mm)?\s+(?:(?:thick|aluminium|aluminum|steel|stainless|brass|copper|acrylic|plywood|mdf|abs|pla|petg|pc|hdpe|polycarbonate|birch|oak)\s+){0,2}(?:sheet|plate|panel|board|slab|stock)s?\b`, "gi");

/** Every part length a text states outside a hole's size: "A x B (x C)", "N mm wide/long/tall/high/across", "width/length/height N". */
function partLengths(text: string): number[] {
  return [
    ...triples(text).flat(),
    ...pairs(text).flat(),
    ...numbersIn(text, new RegExp(String.raw`${NUM}\s*(?:mm)?\s*(?:wide|long|tall|high|across)\b`, "gi")),
    ...numbersIn(text, new RegExp(String.raw`\b(?:width|length|height)${SEP}${NUM}`, "gi")),
  ];
}

/**
 * The wall a through cavity crosses, at least: the smallest of what the request, the requirements
 * and the key dimensions state about the wall — never a size that only bounds it from above
 * (review: a lower bound that overestimates lets a volume test pass with every hole missing):
 * - a stated thickness or wall ("8 mm thick", "thickness 5", "2 mm walls", key dimensions named
 *   thickness, wall, sheet or gauge);
 * - stock named by its thickness ("3 mm sheet", "6 mm plate"), when some other part length the
 *   texts state is larger (stock is its part's smallest size: "a 100 mm plate" alone may be its width);
 * - the smallest of an "A x B x C" of a solid prism (a plate, block, …), or of any "A x B x C" when
 *   no text names a thin-walled part (an enclosure's or bracket's 60 x 40 x 40 is its envelope).
 * Heights ("40 mm tall", "height 40", a key dimension named height) never count: an L-bracket's
 * upright is 40 mm tall and its sheet 3 mm. Undefined when nothing states the wall: the cavity's
 * volume share is then unknown and a volume test cannot pin it.
 */
function thickness(texts: readonly string[], keyDimensions: ScopeContext["keyDimensions"]): { value: number; basis: string } | undefined {
  const found: { value: number; basis: string }[] = [];
  const add = (xs: number[], basis: (v: number) => string) => xs.forEach((v) => found.push({ value: v, basis: basis(v) }));
  const thin = texts.some((t) => THIN_WALLED.test(t));
  const lengths = texts.flatMap(partLengths);
  for (const k of keyDimensions ?? []) if (/width|length|height|tall|long|wide|size/i.test(k.name) && k.unit.trim().toLowerCase() === "mm" && Number.isFinite(k.value) && k.value > 0) lengths.push(k.value);
  for (const text of texts) {
    add(numbersIn(text, new RegExp(String.raw`${NUM}\s*(?:mm)?\s*(?:thick(?:ness)?|walls?)\b`, "gi")), (v) => `${num(v)} mm thick`);
    add(numbersIn(text, new RegExp(String.raw`\b(?:thickness|thick|wall(?:\s+thickness)?)${SEP}${NUM}`, "gi")), (v) => `${num(v)} mm thick`);
    // A thin-walled part's own sizes are its envelope; another text's solid prism ("the 80 x 50 x 8 plate") still counts.
    if (!(THIN_WALLED.test(text) || (thin && !SOLID_PRISM.test(text)))) {
      for (const t of triples(text)) found.push({ value: Math.min(...t), basis: `${num(Math.min(...t))} mm (${t.map(num).join("×")})` });
    }
    for (const m of text.matchAll(STOCK)) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0 && lengths.some((l) => l > v)) found.push({ value: v, basis: `${num(v)} mm ${oneLine(m[0].replace(/^[\d.]+\s*(?:mm)?\s+/i, ""), 30)}` });
    }
  }
  for (const k of keyDimensions ?? []) {
    if (/thick|wall|sheet|gauge/i.test(k.name) && k.unit.trim().toLowerCase() === "mm" && Number.isFinite(k.value) && k.value > 0) found.push({ value: k.value, basis: `${oneLine(k.name, 40)} ${num(k.value)} mm` });
  }
  return found.sort((a, b) => a.value - b.value)[0];
}

const ROUND_BLOCKERS = /\b(?:rectangular|rectangle|square|hex(?:agonal)?|obround|slot(?:ted)?|oval)\b/i;
const ANGLED = /°|\bdeg(?:rees?)?\b|\bangle[ds]?\b|\bslop(?:e|ed|ing)\b|\binclined\b|\boblique\b|\btilted\b|\bskew(?:ed)?\b/i;
const REMOVAL = /\b(?:remov\w*|delet\w*|without|no longer|eliminat\w*|get rid of|fill(?:ed|ing)? in|plug(?:ged)?)\b/i;
const KEEP = /\b(?:keep(?:s|ing)?|kept|unchanged|unmodified|untouched|intact|preserv(?:e|es|ed|ing)|retain(?:s|ed|ing)?|as (?:it|they) (?:is|are)|as is|as before|(?:still|remains?|stays?|stay) (?:there|present|in place|the same))\b|\b(?:do(?:es)?|must|should|shall) not (?:change|move|alter|touch)\b|\b(?:leave|leaves|left) (?:\w+\s+){0,3}?(?:as (?:it )?is|alone|in place|unchanged)\b/i;
const ROUND_EDGE = /\b(?:circular|round|cylindrical|curved)\s+(?:(?:top|bottom|outer|inner|upper|lower|front|back|outside|inside)\s+)?(?:edges?|rims?)\b|\b(?:rims?|circumferen\w*)\b|\b(?:edges?|rims?)\s+(?:of|around)\s+the\s+(?:[Ø⌀]\s*\d|round\b|circular\b|cylind\w*|knob\b|disc\b|disk\b|shaft\b|boss\b)/i;
/** Hole words that bring a cone: a countersink, a drill point, a taper. */
const CONE_WORDS = /\b(?:counter-?sinks?|counter-?sunk|countersunk|csk|csink|cones?|conical|drill[- ]?points?|points?\s+angle|tips?|taper(?:ed)?|chamfer(?:ed|s)?|spot(?:-?fac\w*)?)\b/i;
const FLAT_BOTTOM = /\bflat(?:[- ]?(?:bottom(?:ed)?|floor(?:ed)?))?\b/i;

/**
 * What a requirement says about its feature of `group` ({@link FeatureScope}). A cavity's shares
 * are lower bounds from the sizes its requirement states — n instances of a footprint (π/4·d² for
 * a diameter, π/4·A·B for an "A x B" or "W wide, L long": no rounded rectangle, slot or ellipse
 * inside that box is smaller) times its depth ("N mm deep", or for "through" the wall the spec
 * states anywhere, never a height: {@link thickness}); "A x B x C" is π/4·A·B·C whichever is the
 * depth. n is the smallest count stated right before the noun, else 1 ({@link instanceCount}). The area
 * share is the walls of a blind cavity (its floor replaces the opening): perimeter (π·d, or
 * π/2·(A+B)) × depth; a through cavity's walls and openings can cancel, so it has none.
 */
export function featureScope(group: string, text: string, context: ScopeContext = {}): FeatureScope {
  const through = /\b(?:through|thru)\b/i.test(text) && !/\bblind\b/i.test(text);
  const ds = isCavity(group) ? diameters(text, group) : [];
  // In a hole's requirement an "A x B x C" is the part it crosses ("through the 80x50x8 plate"), and an
  // "A x B" is the opening's own size only when no diameter is given: a part size taken for the hole's
  // would overstate its share (the ±2 % cap still bounds that).
  const box = !isCavity(group) ? [] : group !== "hole" || ds.length === 0 ? pairs(text) : [];
  const cubes = isCavity(group) && group !== "hole" ? triples(text) : [];
  const round = ds.length > 0 && (group === "hole" || (box.length === 0 && cubes.length === 0)) && !ROUND_BLOCKERS.test(text);
  const removal = REMOVAL.test(text);
  const scope: FeatureScope = { group, text, round, through, angled: ANGLED.test(text), removal, keep: !removal && KEEP.test(text), roundEdge: isBlend(group) && ROUND_EDGE.test(text) };
  if (!isCavity(group)) return scope;
  const n = instanceCount(text, group);
  const times = n > 1 ? `${n} × ` : "";
  // The footprint (area and perimeter) of one instance: the smallest the stated sizes allow.
  const prints: { area: number; perimeter: number; what: string }[] = [
    ...ds.map((d) => ({ area: (Math.PI / 4) * d * d, perimeter: Math.PI * d, what: `Ø${num(d)}` })),
    ...box.map(([a, b]) => ({ area: (Math.PI / 4) * a * b, perimeter: (Math.PI / 2) * (a + b), what: `${num(a)}×${num(b)}` })),
  ];
  const print = prints.sort((a, b) => a.area - b.area)[0];
  const stated = minOf(depths(text));
  const wall = through ? thickness([text, ...(context.texts ?? [])], context.keyDimensions) : undefined;
  const depth = minOf([...(stated !== undefined ? [stated] : []), ...(wall ? [wall.value] : [])]);
  const depthWhat = depth === undefined ? "" : depth === stated ? `${num(depth)} deep` : `through ${wall!.basis}`;
  const cube = cubes.map((t) => ({ value: (Math.PI / 4) * t[0] * t[1] * t[2], what: t.map(num).join("×") })).sort((a, b) => a.value - b.value)[0];
  const volumes: FeatureShare[] = [];
  if (print && depth !== undefined) volumes.push({ value: n * print.area * depth, basis: `${times}${print.what}, ${depthWhat}` });
  if (cube) volumes.push({ value: n * cube.value, basis: `${times}${cube.what}` });
  const volume = volumes.sort((a, b) => a.value - b.value)[0];
  if (volume) scope.volume = { value: volume.value, basis: `≈ ${num(volume.value)} mm³ at least: ${volume.basis}` };
  else scope.unknownShare = print ? `states no depth ("N mm deep", or "through" and the part's thickness)` : `states no size (a diameter, or "A x B", with a depth)`;
  if (print && stated !== undefined && !through) {
    const area = n * print.perimeter * stated;
    scope.area = { value: area, basis: `≈ ${num(area)} mm² of wall at least: ${times}${print.what}, ${num(stated)} deep` };
  }
  return scope;
}

/**
 * Count types that never see a feature: the feature adds, removes or reshapes no face or edge of
 * that type (SPEC-v1 §6.5–§6.7: a hole's faces are cylinders, cones and planes; a fillet's
 * cylinders, tori, spheres and freeform; a chamfer's planes and cones). A round hole has no line
 * edge (seam-free cylinders), and no ellipse edge unless it is drilled at an angle; a round through
 * hole adds no plane (it only perforates the faces it crosses; a counterbore's step is one). Types
 * the table leaves out can see the feature in some shape (a rectangular opening has planes and
 * lines, a radial hole in a cylinder freeform edges).
 */
export const BLIND_FACE_TYPES: Readonly<Record<string, readonly string[]>> = {
  hole: ["sphere", "torus", "bspline"],
  slot: ["cone", "sphere", "torus", "bspline"],
  chamfer: ["cylinder", "sphere", "torus"],
  fillet: ["plane", "cone"],
};

/**
 * The face_count / edge_count types that cannot see the feature of `scope`, by its shape (review:
 * the table alone accepted type counts that cannot change on round parts): a round through hole adds
 * no plane; a round hole without a countersink, taper or drill point (through, or flat-bottomed)
 * adds no cone; a fillet on a circular edge adds a torus, not a cylinder; a chamfer there adds a
 * cone, not a plane.
 */
export function blindTypes(check: string, scope: FeatureScope): readonly string[] {
  if (check === "face_count") {
    const out = [...(BLIND_FACE_TYPES[scope.group] ?? [])];
    if (scope.group === "hole" && scope.round) {
      if (scope.through && !/\b(?:counter-?bor\w*|cbore|spot-?fac\w*|step\w*)\b/i.test(scope.text)) out.push("plane");
      if ((scope.through || FLAT_BOTTOM.test(scope.text)) && !CONE_WORDS.test(scope.text)) out.push("cone");
    }
    if (scope.roundEdge && scope.group === "fillet") out.push("cylinder");
    if (scope.roundEdge && scope.group === "chamfer") out.push("plane");
    return out;
  }
  if (check === "edge_count" && scope.group === "hole" && scope.round) return scope.angled ? ["line"] : ["line", "ellipse"];
  return [];
}

/** A count range that holds only 0 (`eq 0`, `between [0, 0]`, `approx 0 abs 0.5`, `lte 0`). */
function onlyZero(t: CoverageComparators): boolean {
  if (t.eq !== undefined) return t.eq === 0;
  if (typeof t.approx === "number") {
    const tol = Math.max(Math.abs(t.abs ?? 0), Math.abs((t.rel ?? 0) * t.approx));
    return t.approx - tol <= 0 && t.approx + tol < 1;
  }
  if (Array.isArray(t.between) && t.between.length === 2 && typeof t.between[0] === "number" && typeof t.between[1] === "number") return t.between[0] <= 0 && t.between[1] < 1;
  return t.gte === undefined && t.lte !== undefined && t.lte < 1;
}

// ─── Pinning ────────────────────────────────────────────────────────────────────────────────────

const asScope = (s: string | FeatureScope | undefined): FeatureScope | undefined => (typeof s === "string" ? featureScope(s, "") : s);

/** Why a small feature's volume or area band (`width`, the whole band) does not pin it, or undefined when it does. */
function shareLooseness(check: string, width: number, scope: FeatureScope): string | undefined {
  const share = check === "volume" ? scope.volume : scope.area;
  const unit = check === "volume" ? "mm³" : "mm²";
  if (share) return width < share.value ? undefined : `allows a band of ${num(width)} ${unit}, as wide as the ${scope.group}'s own ${check} or wider (${share.basis})`;
  return `cannot be held against the ${scope.group}'s own ${check}: ${shareUnknown(check, scope)}`;
}

function shareUnknown(check: string, scope: FeatureScope): string {
  if (isBlend(scope.group)) return `a ${scope.group}'s share depends on the lengths of the edges it ${scope.group === "fillet" ? "rounds" : "bevels"}, which no spec states`;
  if (check === "area" && scope.volume) return `the walls a through ${scope.group} adds and the openings it cuts can cancel (only a blind one with a stated depth has a known share)`;
  return `the requirement ${scope.unknownShare ?? "states no size"}`;
}

/** How a requirement naming the feature of `scope` (or a group) is pinned (the refusal's advice). */
export function pinAdvice(scopeOrGroup: string | FeatureScope): string {
  const scope = asScope(scopeOrGroup)!;
  const group = scope.group;
  if (isBlend(group)) {
    const [straight, round] = group === "fillet" ? ["cylinder", "torus"] : ["plane", "cone"];
    return `pin it with an exact count (face_count eq — a ${group} adds one face per edge: face_count type ${straight} eq <edges> on straight edges, type ${round} on round ones, or the untyped face_count); no volume or area tolerance pins a ${group}`;
  }
  if (isCavity(group)) {
    const byVolume = scope.volume
      ? `or its volume within ±${CAVITY_PIN_MAX_REL * 100} % and with a band (twice the tolerance) under the ${group}'s own ${num(scope.volume.value)} mm³ (${scope.volume.basis.replace(/^≈ [^:]+: /, "")})`
      : `or — once the requirement states its size (a diameter and a depth, or "through" and the part's thickness) — its volume within ±${CAVITY_PIN_MAX_REL * 100} % and a band under the ${group}'s own volume`;
    return `pin it with an exact count (face_count or edge_count eq — one missing through hole changes a count by 1; e.g. face_count type cylinder eq <holes>) ${byVolume}`;
  }
  return `pin it with eq, approx (rel ≤ ${PIN_MAX_REL}, or abs within ${PIN_MAX_REL * 100} % of the value; counts ${PIN_MAX_REL_COUNT * 100} % or ±1) or between (as tight, lower bound above 0)`;
}

/**
 * Why a measure does not pin the feature of `scope` (or a group; none: any feature), or undefined
 * when it does: exact (`eq`), a predicate, or `approx` / `between` tight enough to fail when the
 * feature is missing. Not pinned: a one-sided `gte`/`lte` (`volume gte 0` passes whether or not the
 * bore is there; the DSL takes one comparator, so two-sided means `between`), a `between` reaching
 * 0 on a never-negative measure, a range or tolerance wider than {@link PIN_MAX_REL} (counts:
 * {@link PIN_MAX_REL_COUNT} or ±1), and for a small feature ({@link CAVITY_FEATURES},
 * {@link BLEND_FEATURES}) a count range holding more than one integer, or a volume or area band
 * as wide as the feature's own share (or with no known share). `approx: "$context"` has no value
 * to hold an `abs` against: only an exact count or a `rel` within the limits pins with it.
 */
export function looseness(t: { check?: string | undefined } & CoverageComparators, scopeOrGroup?: string | FeatureScope): string | undefined {
  const scope = asScope(scopeOrGroup);
  const group = scope?.group;
  if (t.check !== undefined && PREDICATE_CHECKS.includes(t.check)) return undefined;
  // "Same as the starting model" holds exactly when a requested addition, removal or change was not
  // made (review: `face_count eq "$context"` passed with the requested hole missing, and failed with it).
  if (scope !== undefined && !scope.keep && (t.eq === "$context" || t.approx === "$context")) {
    return `compares with the starting model ("$context"), which holds only while the model is unchanged: it fails when the requested ${group} change is made ("$context" pins only what a requirement keeps as it is)`;
  }
  if (t.eq !== undefined) return undefined;
  const scalar = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const exact = isCount(t.check) && isSmall(group);
  const share = scope !== undefined && isSmall(group) && t.check !== undefined && SHARE_CHECKS.includes(t.check);
  const inexact = (range: string) =>
    `allows ${range} on a count of a ${group} (${isBlend(group) ? `a ${group} on one edge adds one face` : "a missing through hole changes a count by 1"}: only an exact count sees it)`;
  if (t.approx !== undefined) {
    if (exact) {
      if (!scalar(t.approx)) return t.rel !== undefined && t.rel !== 0 ? inexact(`rel ${num(t.rel)}`) : t.abs !== undefined && !(Math.abs(t.abs) < 1) ? inexact(`±${num(t.abs)}`) : undefined;
      const tol = Math.max(Math.abs(t.abs ?? 0), Math.abs(t.rel ?? 0) * Math.abs(t.approx));
      return Math.floor(t.approx + tol) - Math.ceil(t.approx - tol) <= 0 ? undefined : inexact(`±${num(tol)} (approx ${num(t.approx)})`);
    }
    if (!scalar(t.approx)) {
      if (share) return `compares with the starting model ("$context"), so its tolerance cannot be held against the ${group}'s own ${t.check}`;
      if (t.abs !== undefined && !(isCount(t.check) && Math.abs(t.abs) <= 1)) return `has abs ${num(t.abs)} on "$context", whose value is unknown here, so the tolerance cannot be checked (use rel)`;
    }
    if (t.rel !== undefined && !(Math.abs(t.rel) <= maxRel(t.check, group))) return `has a tolerance wider than ${tolText(t.check, group)} (rel ${num(t.rel)})`;
    if (scalar(t.approx) && t.abs !== undefined && !(Math.abs(t.abs) <= maxHalfWidth(t.check, t.approx, group))) return `has a tolerance wider than ${tolText(t.check, group)} of its value (abs ${num(t.abs)} on ${num(t.approx)})`;
    if (share && scalar(t.approx)) return shareLooseness(t.check!, 2 * Math.max(Math.abs(t.abs ?? 0), Math.abs((t.rel ?? 0) * t.approx)), scope!);
    return undefined;
  }
  if (t.between !== undefined) {
    const b = t.between;
    if (!Array.isArray(b) || b.length !== 2 || !scalar(b[0]) || !scalar(b[1])) return undefined; // a vector range: not a feature measure
    const [lo, hi] = b as [number, number];
    if (t.check !== undefined && NONNEGATIVE_CHECKS.includes(t.check) && lo <= 0) return `has a range from ${num(lo)} (between [${num(lo)}, ${num(hi)}] also passes when the feature is missing)`;
    if (exact) return Math.floor(hi) - Math.ceil(lo) <= 0 ? undefined : inexact(`between [${num(lo)}, ${num(hi)}]`);
    if (!((hi - lo) / 2 <= maxHalfWidth(t.check, (lo + hi) / 2, group))) return `has a range wider than ${tolText(t.check, group)} of its middle (between [${num(lo)}, ${num(hi)}])`;
    if (share) return shareLooseness(t.check!, hi - lo, scope!);
    return undefined;
  }
  return t.gte !== undefined || t.lte !== undefined ? "only has a one-sided bound (gte/lte; gte 0 always passes)" : "has no comparator";
}

function pins(t: { check?: string | undefined } & CoverageComparators, scope?: FeatureScope): boolean {
  return looseness(t, scope) === undefined;
}

/** Whether one measure (a test, or a bodies_matching condition) can see the feature of `scope`: a check that measures it, no blind type filter, and no type count that stays at 0 either way. */
function measureSees(m: { check?: string | undefined; type?: string | undefined } & CoverageComparators, checks: readonly string[], scope: FeatureScope): boolean {
  if (m.check === undefined || !checks.includes(m.check)) return false;
  if ((m.check === "face_count" || m.check === "edge_count") && m.type !== undefined) {
    if (blindTypes(m.check, scope).includes(m.type.trim().toLowerCase())) return false;
    // A feature adds its faces and edges: a type that stays at 0 with it stays at 0 without it (unless it is being removed).
    if (!scope.removal && onlyZero(m)) return false;
  }
  return true;
}

/** A test's check as the refusal names it (with its type filter). */
function checkLabel(m: { check?: string | undefined; type?: string | undefined }): string {
  return `${m.check ?? "?"}${m.type !== undefined && (m.check === "face_count" || m.check === "edge_count") ? ` type ${m.type}` : ""}`;
}

/** Options of {@link specCoverage}, per dialect (CadScript v1: `v1.V1_COVERAGE_OPTIONS`), and the spec's key dimensions. */
export interface CoverageOptions {
  /** Checks the session's dialect refuses (CadScript v1: curve_count, hole_pattern, hole_positions). */
  unavailableChecks?: readonly string[] | undefined;
  /**
   * Checks that do not see a feature group in this dialect (CadScript v1: `inner_loops` for a hole —
   * a hole feature, or a blind bore cut from its own sketch, adds no inner loop to any sketch).
   */
  unseenChecks?: Readonly<Record<string, readonly string[]>> | undefined;
  /** The spec's key dimensions: a through cavity's depth may come from a thickness among them. */
  keyDimensions?: ScopeContext["keyDimensions"] | undefined;
}

/** The checks that can see a feature of `group`, minus the unavailable and unseen ones. */
export function featureChecks(group: string, opts: CoverageOptions = {}): readonly string[] {
  const off = [...(opts.unavailableChecks ?? []), ...(opts.unseenChecks?.[group] ?? [])];
  return (FEATURE_CHECKS[group] ?? []).filter((c) => !off.includes(c));
}

/** Whether a test's check can see the feature of `scope` (a bodies_matching sees what its conditions see). */
function sees(t: CoverageTest, checks: readonly string[], scope: FeatureScope): boolean {
  if (t.check === "bodies_matching") return (t.where ?? []).some((w) => measureSees(w, checks, scope));
  return measureSees(t, checks, scope);
}

/** The smallest number of matching bodies a bodies_matching comparator accepts (−∞: unknown or none). */
function countFloor(t: CoverageComparators): number {
  if (t.eq !== undefined) return typeof t.eq === "number" ? t.eq : -Infinity;
  if (typeof t.approx === "number") return t.approx - Math.max(Math.abs(t.abs ?? 0), Math.abs((t.rel ?? 0) * t.approx));
  if (Array.isArray(t.between) && typeof t.between[0] === "number") return t.between[0];
  if (t.gte !== undefined) return t.gte;
  return -Infinity;
}

function boundText(t: CoverageComparators): string {
  const loose = looseness(t);
  if (loose !== undefined) return loose;
  if (t.eq !== undefined) return `eq ${JSON.stringify(t.eq)}`;
  if (t.approx !== undefined) return `approx ${JSON.stringify(t.approx)}${t.abs !== undefined ? ` abs ${num(t.abs)}` : ""}${t.rel !== undefined ? ` rel ${num(t.rel)}` : ""}`;
  return "a lower bound of 0";
}

/**
 * Why a test that sees the feature of `scope` does not pin it, or undefined when it does. A
 * bodies_matching pins it with a pinned condition that sees it and a count that fails when no body
 * matches (eq ≥ 1, gte ≥ 1, an approx or between above 0): `eq 0` passes whatever the bodies are.
 */
function checksFeature(t: CoverageTest, checks: readonly string[], scope: FeatureScope): string | undefined {
  if (t.check === "bodies_matching") {
    if (!(countFloor(t) > 0)) return `counts bodies with a bound that passes when none matches (${boundText(t)})`;
    const seeing = (t.where ?? []).filter((w) => measureSees(w, checks, scope));
    return seeing.some((w) => pins(w, scope)) ? undefined : `condition ${checkLabel(seeing[0] ?? {})} ${looseness(seeing[0] ?? {}, scope) ?? "does not pin it"}`;
  }
  return sees(t, checks, scope) ? looseness(t, scope) : "cannot see it";
}

export interface SpecCoverage {
  /** Requirement ids without a test (and without an accepted `untested_reason`). */
  untested: string[];
  /** Features the request names that no requirement mentions. */
  unmentioned: { feature: string; word: string }[];
  /** Requirements naming a measurable feature that give `untested_reason` anyway. */
  exemptionRefused: { id: string; feature: string; word: string }[];
  /** Requirements naming a measurable feature whose covering tests all use checks that cannot see it. */
  blind: { id: string; feature: string; word: string; checks: string[] }[];
  /**
   * Requirements naming a measurable feature whose tests see it but do not pin it (one-sided bounds,
   * ranges from 0, tolerances wider than ±10 %, a small feature's inexact counts or a band as wide as
   * its own share): they pass when it is missing. `advice` says how to pin it.
   */
  loose: { id: string; feature: string; word: string; tests: string[]; why: string[]; advice: string }[];
}

type Requirement = { id: string; text: string; untested_reason?: string | undefined };

/** The measurable requested-feature groups a requirement's text names, with the word that names each. */
function namedFeatures(text: string): { feature: string; word: string }[] {
  return REQUESTED_FEATURES.map((f) => ({ f, m: text.match(f.words) }))
    .filter((x) => x.m !== null && !UNMEASURABLE_FEATURES.has(x.f.feature))
    .map((x) => ({ feature: x.f.feature, word: x.m![0].toLowerCase() }));
}

/** What a spec leaves unchecked: see the section comment above. */
export function specCoverage(requirements: readonly Requirement[], tests: readonly CoverageTest[], request?: string, opts: CoverageOptions = {}): SpecCoverage {
  const idOf = (id: string) => id.trim().toUpperCase();
  // Ids outside the R1 pattern still count when a description starts with them ("size: …").
  const covers = (t: CoverageTest, id: string) => coveredRequirementIds(t.description).includes(idOf(id)) || t.description.trim().toLowerCase().startsWith(`${id.trim().toLowerCase()}:`);
  const out: SpecCoverage = { untested: [], unmentioned: [], exemptionRefused: [], blind: [], loose: [] };
  const context: ScopeContext = { texts: [...(request !== undefined ? [request] : []), ...requirements.map((r) => r.text)], keyDimensions: opts.keyDimensions ?? [] };
  for (const r of requirements) {
    const named = namedFeatures(r.text);
    const exempt = r.untested_reason?.trim() ? true : false;
    if (exempt && named.length > 0) out.exemptionRefused.push({ id: r.id, ...named[0]! });
    const covering = tests.filter((t) => covers(t, r.id));
    if (covering.length === 0) {
      if (!exempt || named.length > 0) out.untested.push(r.id);
      continue;
    }
    for (const { feature, word } of named) {
      const checks = featureChecks(feature, opts);
      const scope = featureScope(feature, r.text, context);
      const seeing = covering.filter((t) => sees(t, checks, scope));
      if (seeing.length === 0) out.blind.push({ id: r.id, feature, word, checks: [...new Set(covering.map(checkLabel))] });
      else {
        const why = seeing.map((t) => checksFeature(t, checks, scope));
        if (why.every((w) => w !== undefined)) out.loose.push({ id: r.id, feature, word, tests: seeing.map(checkLabel), why: why as string[], advice: pinAdvice(scope) });
      }
    }
  }
  if (request !== undefined) {
    const texts = requirements.map((r) => r.text);
    for (const f of REQUESTED_FEATURES) {
      const m = request.match(f.words);
      if (m && !texts.some((t) => f.words.test(t))) out.unmentioned.push({ feature: f.feature, word: m[0].toLowerCase() });
    }
  }
  return out;
}

/** `submit_spec`'s refusal lines for a spec that leaves requested features unchecked (empty: accepted). */
export function specCoverageProblems(requirements: readonly Requirement[], tests: readonly CoverageTest[], request?: string, opts: CoverageOptions = {}): string[] {
  const c = specCoverage(requirements, tests, request, opts);
  const out: string[] = [];
  const text = (id: string) => oneLine(requirements.find((x) => x.id === id)?.text ?? "", 120);
  const checksText = (feature: string) => featureChecks(feature, opts).join(", ");
  for (const u of c.unmentioned) {
    out.push(`the request asks for a ${JSON.stringify(u.word)} (${u.feature}) but no requirement names it: add a requirement for it and a test that fails when it is missing or the wrong size`);
  }
  for (const e of c.exemptionRefused) {
    out.push(`${oneLine(e.id, 16)} (${text(e.id)}) names a ${JSON.stringify(e.word)} (${e.feature}), which is measurable: remove its untested_reason and test it (${checksText(e.feature)})`);
  }
  for (const id of c.untested) {
    if (c.exemptionRefused.some((e) => e.id === id)) continue;
    out.push(`${oneLine(id, 16)} (${text(id)}) has no test: add one whose description starts with its id (${REQUIREMENT_ID_FORMATS}), e.g. face_count, volume or bbox_sorted, or give untested_reason if no check can measure it`);
  }
  for (const b of c.blind) {
    out.push(
      `${oneLine(b.id, 16)} (${text(b.id)}) names a ${JSON.stringify(b.word)} (${b.feature}) but its tests only use ${b.checks.map((x) => oneLine(x, 24)).join(", ")}, which do not change when the ${b.feature} is missing: add a test on its id with ${checksText(b.feature)} (or bodies_matching on one of them) that fails without it`,
    );
  }
  for (const l of c.loose) {
    const tests = l.tests.map((x, i) => `its ${oneLine(x, 32)} test ${l.why[i] ?? "does not pin it"}`).join("; ");
    out.push(`${oneLine(l.id, 16)} (${text(l.id)}) names a ${JSON.stringify(l.word)} (${l.feature}) but ${tests}, which passes without the ${l.feature}: ${l.advice}`);
  }
  return out;
}

/**
 * The requested features a set of frozen tests leaves unchecked, one line each (for the proposal's
 * known_issues and the designer's build header), when the spec writer never passed `submit_spec`:
 * the knob-miss must not pass silently because the spec writer ran out of turns. With no
 * requirements every feature the request names is listed (no test is known to check it).
 */
export function specFeatureGaps(requirements: readonly Requirement[], tests: readonly CoverageTest[], request: string | undefined, opts: CoverageOptions = {}): string[] {
  const c = specCoverage(requirements, tests, request, opts);
  const lines = new Map<string, string>();
  const add = (feature: string, word: string, why: string) => {
    const key = `${feature}|${word}`;
    if (!lines.has(key)) lines.set(key, `spec: requested ${feature} ${JSON.stringify(word)} has no test that fails when it is missing (${why})`);
  };
  const rid = (id: string) => oneLine(id, 16);
  for (const u of c.unmentioned) add(u.feature, u.word, "no requirement names it");
  for (const e of c.exemptionRefused) add(e.feature, e.word, `${rid(e.id)} was marked untested`);
  for (const id of c.untested) for (const f of namedFeatures(requirements.find((r) => r.id === id)?.text ?? "")) add(f.feature, f.word, `${rid(id)} has no test`);
  for (const b of c.blind) add(b.feature, b.word, `${rid(b.id)} is only checked by ${b.checks.map((x) => oneLine(x, 24)).join(", ")}`);
  for (const l of c.loose) add(l.feature, l.word, `${rid(l.id)}'s ${oneLine(l.tests[0] ?? "?", 32)} test ${oneLine(l.why[0] ?? "does not pin it", 100)}`);
  return [...lines.values()];
}

export interface SpecTestResult extends TestResult {
  /**
   * Slack: for a passing test how far the value could move before failing, for a failing test
   * (negative) how far it is outside the tolerance. Same unit as the measure; absent for exact
   * checks and hole predicates.
   */
  margin?: number;
}

function numbers(v: unknown): number[] | undefined {
  if (typeof v === "number") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return v as number[];
  return undefined;
}

function marginOf(t: HiddenTest, actual: unknown, expected: unknown): number | undefined {
  const a = numbers(actual);
  if (!a) return undefined;
  if (t.approx !== undefined) {
    const e = numbers(expected);
    if (!e || e.length !== a.length) return undefined;
    return Math.min(...a.map((ai, i) => Math.max(t.abs ?? 0, (t.rel ?? 0) * Math.abs(e[i]!)) - Math.abs(ai - e[i]!)));
  }
  if (t.between !== undefined) {
    const ranges = (Array.isArray(t.between[0]) ? t.between : [t.between]) as [number, number][];
    if (ranges.length !== a.length) return undefined;
    return Math.min(...a.map((ai, i) => Math.min(ai - ranges[i]![0], ranges[i]![1] - ai)));
  }
  if (t.gte !== undefined && a.length === 1) return a[0]! - t.gte;
  if (t.lte !== undefined && a.length === 1) return t.lte - a[0]!;
  return undefined;
}

/** Run spec tests on the candidate (and, for edit tasks, the starting model). Never throws. */
export function runSpecTests(tests: readonly HiddenTest[], candidate: Subject, context?: Subject): SpecTestResult[] {
  const ctx: CheckContext = { candidate, context };
  const results = evaluateTests(tests, ctx);
  return results.map((r, i): SpecTestResult => {
    const t = tests[i]!;
    let expected: unknown = t.approx ?? t.eq;
    if (expected === "$context" && context) {
      const m = measure(t, context, ctx);
      expected = m.ok ? m.value : undefined;
    }
    const margin = r.actual === undefined ? undefined : marginOf(t, r.actual, expected);
    return margin === undefined || !Number.isFinite(margin) ? r : { ...r, margin };
  });
}

function fmtActual(v: unknown): string {
  if (typeof v === "number") return num(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return vec(v as number[]);
  return oneLine(JSON.stringify(v) ?? String(v), 300);
}

/** One line per test: `✓ id: expectation — actual X (margin m)` / `✗ … off by …`. */
export function formatTestResult(r: SpecTestResult): string {
  const mark = r.pass ? "✓" : "✗";
  const actual = r.actual === undefined ? "" : ` — actual ${fmtActual(r.actual)}`;
  const margin = r.margin === undefined ? "" : r.pass ? ` (margin ${num(r.margin)})` : ` (outside by ${num(-r.margin)})`;
  const msg = !r.pass && r.message ? `; ${oneLine(r.message, 300)}` : "";
  return `${mark} ${r.id}: ${oneLine(r.expected, 200)}${actual}${margin}${msg}`;
}

export function summarizeTests(results: readonly SpecTestResult[]): { passed: number; total: number; failing: string[] } {
  return { passed: results.filter((r) => r.pass).length, total: results.length, failing: results.filter((r) => !r.pass).map((r) => r.id) };
}
