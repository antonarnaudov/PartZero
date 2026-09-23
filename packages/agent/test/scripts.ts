/** Scripted turns shared by the tests. */
import type { ScriptStep, ScriptTurn } from "../src/index.js";

export const triage = (kind: "design" | "quick_edit" | "ask" = "design", needs_clarification = false): ScriptTurn => ({
  tools: [{ name: "classify", input: { kind, complexity: "T1", needs_clarification, reason: `scripted ${kind}` } }],
  usage: { input: 400, output: 60 },
});

export function specTurns(tests: object[], requirements: { id: string; text: string }[], summary = "The requested part."): ScriptStep[] {
  return [
    { text: "Tests first.", tools: [{ name: "set_spec_tests", input: { tests } }] },
    { tools: [{ name: "submit_spec", input: { summary, requirements, assumptions: [], key_dimensions: [] } }] },
  ];
}

export const apply = (input: Record<string, unknown>, text = "Next step."): ScriptTurn => ({ text, tools: [{ name: "apply_cadscript", input }] });

export const propose = (summary: string, assumptions: string[] = [], known_issues: string[] = []): ScriptTurn => ({
  tools: [{ name: "propose", input: { summary, assumptions, known_issues } }],
});

export const WASHER_TESTS = [
  { id: "valid", description: "R1: valid solid", check: "valid", eq: true },
  { id: "one_body", description: "R1: one printable part", check: "body_count", eq: 1 },
  { id: "size", description: "R1: 7 mm across, 1 mm thick", check: "bbox_sorted", approx: [1, 7, 7], abs: 0.05 },
  { id: "bore", description: "R2: one 3.2 mm hole", check: "curve_count", kind: "circle", diameter: [3.1, 3.3], eq: 1 },
  { id: "volume", description: "R1+R2: π/4·(7² − 3.2²)·1 ≈ 30.44 mm³", check: "volume", approx: 30.44, rel: 0.01 },
];
export const WASHER_REQS = [
  { id: "R1", text: "7 mm OD, 1 mm thick" },
  { id: "R2", text: "3.2 mm hole" },
];

export const GASKET_TESTS = [
  { id: "valid", description: "R1: valid solid", check: "valid", eq: true },
  { id: "one_body", description: "R1: one sheet part", check: "body_count", eq: 1 },
  { id: "size", description: "R1: 90 x 70 x 1.5 mm", check: "bbox_sorted", approx: [1.5, 70, 90], abs: 0.1 },
  { id: "cutouts", description: "R2+R3: opening and four holes", check: "inner_loops", eq: 5 },
  { id: "m3_pattern", description: "R3: M3 holes on 82 x 62", check: "hole_pattern", diameter: [3.2, 3.5], points: [[0, 0], [82, 0], [82, 62], [0, 62]] },
];
export const GASKET_REQS = [
  { id: "R1", text: "90 x 70 mm outside, 1.5 mm sheet" },
  { id: "R2", text: "8 mm band (74 x 54 opening)" },
  { id: "R3", text: "M3 clearance hole in each corner, centred in the band" },
];

export const SPACER_TESTS = [
  { id: "valid", description: "R1: valid solid", check: "valid", eq: true },
  { id: "one_body", description: "R1: one part", check: "body_count", eq: 1 },
  { id: "size", description: "R1: 10 mm OD, 15 mm long", check: "bbox_sorted", approx: [10, 10, 15], abs: 0.05 },
  { id: "round", description: "R1+R2: outside and bore are cylinders", check: "face_count", type: "cylinder", eq: 2 },
  { id: "volume", description: "R2: π/4·(10² − 5.3²)·15 ≈ 847.2 mm³", check: "volume", approx: 847.17, rel: 0.01 },
];
export const SPACER_REQS = [
  { id: "R1", text: "10 mm OD, 15 mm long" },
  { id: "R2", text: "5.3 mm bore" },
];
