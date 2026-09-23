/**
 * Repair hints for Forge evaluation errors (forge-ir SPEC.md §3.1, §4). CadScript compiler
 * diagnostics carry their own `hint`; kernel errors in an `aicad.metrics/0` report do not, so the
 * UI adds these. (`@aicad/agent-tools` has richer, geometry-aware playbooks for the agent; they
 * are Node-only today, see the app shell open issues.)
 */
export const KERNEL_HINTS: Readonly<Record<string, string>> = {
  SKETCH_OPEN_LOOP:
    "Every line/arc end must coincide (≤ 1e-6 mm) with exactly one other curve end. Close the loop: make the dangling end equal the start of the next curve.",
  SKETCH_BRANCHING: "More than two curve ends meet at one point. Split the sketch or remove the extra curve so each end meets exactly one other.",
  SKETCH_CURVES_CROSS: "Two curves intersect or overlap away from a shared end. v0 never splits curves: move one, or split it at the crossing yourself.",
  SKETCH_DEGENERATE_LOOP: "A loop encloses (almost) no area. Remove the loop or give it a real size.",
  SKETCH_NO_REGIONS: "The sketch has no closed region. Add a closed loop of curves.",
  SKETCH_SUPPRESSED: "This feature uses a suppressed sketch. Unsuppress the sketch or suppress this feature too.",
  DEPENDENCY_FAILED: "An earlier feature this one depends on failed. Fix that feature first; this error clears with it.",
  REVOLVE_CROSSES_AXIS: "A profile region lies on both sides of the revolve axis. Keep the whole profile on one side (touching the axis is fine).",
  INVALID_RESULT: "The kernel produced a body that failed its own validity check. Please report the model; try slightly different dimensions meanwhile.",
  NO_PARTS: 'A file needs at least one part("name") with features.',
  IR_SCHEMA_INVALID: "The IR document does not match the aicad.ir/0 schema.",
  IR_PARSE_ERROR: "The IR JSON could not be parsed.",
  ENGINE_UNAVAILABLE: "No evaluation engine is available. Build the Forge CLI (`cargo build -p forge-cli` in forge/) or install @aicad/forge-web.",
  ENGINE_FAILED: "The engine failed to run. See the message for details.",
};

export function kernelHint(code: string): string | undefined {
  if (code in KERNEL_HINTS) return KERNEL_HINTS[code];
  if (code.startsWith("FORGE_") || code.startsWith("OCCT_")) return "Engine-internal failure (not a modeling error). Please report it with the model.";
  return undefined;
}
