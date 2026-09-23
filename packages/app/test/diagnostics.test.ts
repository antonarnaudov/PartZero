import { describe, expect, it } from "vitest";
import type { EvalReport } from "@aicad/ir-types";
import { compileAndCheck } from "../src/cadscript/inline-service";
import { collectProblems, countBySeverity, MarkerSeverity, problemsByFeature, problemsToMarkers, type Problem } from "../src/doc/problems";
import { BOX, HEADER } from "./helpers";

const lineLengthOf = (source: string) => (line: number): number => source.split("\n")[line - 1]?.length ?? 0;

function problem(p: Partial<Problem> & Pick<Problem, "span">): Problem {
  return { key: "k", severity: "error", code: "X", message: "m", source: "cadscript", spanMode: "exact", ...p };
}

describe("problemsToMarkers", () => {
  const src = "abc\n\nhello world\n";

  it("maps severities to Monaco marker severities and keeps 1-based, end-exclusive spans", () => {
    const markers = problemsToMarkers(
      [
        problem({ severity: "error", span: { start: { line: 1, col: 1 }, end: { line: 1, col: 4 } } }),
        problem({ severity: "warning", span: { start: { line: 3, col: 7 }, end: { line: 3, col: 12 } } }),
        problem({ severity: "info", span: { start: { line: 3, col: 1 }, end: { line: 3, col: 6 } } }),
      ],
      lineLengthOf(src),
    );
    expect(markers.map((m) => m.severity)).toEqual([MarkerSeverity.Error, MarkerSeverity.Warning, MarkerSeverity.Info]);
    expect(markers[1]).toMatchObject({ startLineNumber: 3, startColumn: 7, endLineNumber: 3, endColumn: 12 });
  });

  it("widens empty spans to one character (backwards at end of line)", () => {
    const [mid, eol, empty] = problemsToMarkers(
      [
        problem({ span: { start: { line: 1, col: 2 }, end: { line: 1, col: 2 } } }),
        problem({ span: { start: { line: 1, col: 4 }, end: { line: 1, col: 4 } } }),
        problem({ span: { start: { line: 2, col: 1 }, end: { line: 2, col: 1 } } }),
      ],
      lineLengthOf(src),
    );
    expect(mid).toMatchObject({ startColumn: 2, endColumn: 3 });
    expect(eol).toMatchObject({ startColumn: 3, endColumn: 4 });
    expect(empty).toMatchObject({ startColumn: 1, endColumn: 1 });
  });

  it("marks only the first line of a statement for kernel errors, and appends the hint", () => {
    const [m] = problemsToMarkers(
      [problem({ source: "forge", spanMode: "first-line", hint: "close the loop", span: { start: { line: 3, col: 1 }, end: { line: 9, col: 3 } } })],
      lineLengthOf(src),
    );
    expect(m).toMatchObject({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 12, source: "forge" });
    expect(m!.message).toBe("m\nHint: close the loop");
  });

  it("repairs reversed spans and skips problems without a location", () => {
    const markers = problemsToMarkers(
      [problem({ span: { start: { line: 3, col: 5 }, end: { line: 1, col: 1 } } }), { key: "e", severity: "error", code: "ENGINE_FAILED", message: "x", source: "engine" }],
      lineLengthOf(src),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 6 });
  });
});

describe("collectProblems", () => {
  it("reports compiler and type-checker diagnostics at their source positions", () => {
    const source = `${HEADER}\npart("p");\nconst s = sketch(XY, { c: circle({ center: [0, 0], radius: 5 }) });\nconst e = extrude(s, { distance: "8" });\n`;
    const out = compileAndCheck(source);
    const problems = collectProblems({ compile: out, model: out.ok ? out : null, report: null, engineError: null });
    const ts = problems.find((p) => p.source === "typescript");
    expect(ts?.code).toBe("TS2322");
    expect(ts?.span?.start.line).toBe(5);
    const markers = problemsToMarkers(problems, lineLengthOf(source));
    const tsMarker = markers.find((m) => m.code === "TS2322")!;
    expect(tsMarker).toMatchObject({ startLineNumber: 5, severity: MarkerSeverity.Error, source: "ts" });
    expect(source.split("\n")[4]!.slice(tsMarker.startColumn - 1, tsMarker.endColumn - 1)).toContain("distance");
  });

  it("carries CadScript hints and attributes diagnostics to the enclosing feature", () => {
    const source = `${BOX}const hole = extrude(missing, { distance: 1 });\n`;
    const out = compileAndCheck(source);
    const problems = collectProblems({ compile: out, model: null, report: null, engineError: null });
    const unresolved = problems.find((p) => p.code === "CS_UNRESOLVED_SKETCH")!;
    expect(unresolved.severity).toBe("error");
    expect(unresolved.hint).toBeTruthy();
    expect(unresolved.source).toBe("cadscript");
    expect(countBySeverity(problems).error).toBeGreaterThanOrEqual(1);
  });

  it("maps kernel errors from the report onto the failing feature's statement, with repair hints", () => {
    const out = compileAndCheck(BOX);
    const report: EvalReport = {
      schema: "aicad.metrics/0",
      engine: "forge 0.0.1",
      document: "box",
      status: "error",
      features: [
        { part: "plate", feature: "outline", type: "sketch", status: "error", error: { code: "SKETCH_OPEN_LOOP", message: 'the start of curve "bottom" meets no other curve end' } },
        { part: "plate", feature: "plate", type: "extrude", status: "error", error: { code: "DEPENDENCY_FAILED", message: 'sketch "outline" failed' } },
      ],
    };
    const problems = collectProblems({ compile: out, model: out, report, engineError: null });
    const open = problems.find((p) => p.code === "SKETCH_OPEN_LOOP")!;
    const outlineId = out.ir!.parts[0]!.features[0]!.id;
    expect(open).toMatchObject({ source: "forge", featureName: "outline", featureId: outlineId, spanMode: "first-line" });
    expect(open.hint).toMatch(/coincide/);
    expect(open.span?.start.line).toBe(BOX.split("\n").findIndex((l) => l.startsWith("const outline")) + 1);
    expect(problemsByFeature(problems).get(outlineId)?.map((p) => p.code)).toEqual(["SKETCH_OPEN_LOOP"]);
  });

  it("hides stale kernel errors while the code does not compile, and reports engine failures", () => {
    const good = compileAndCheck(BOX);
    const bad = compileAndCheck(`${BOX}const x = extrude(nope, { distance: 1 });\n`);
    const report: EvalReport = {
      schema: "aicad.metrics/0",
      engine: "forge",
      document: "box",
      status: "error",
      features: [{ part: "plate", feature: "outline", type: "sketch", status: "error", error: { code: "SKETCH_OPEN_LOOP", message: "x" } }],
    };
    const problems = collectProblems({ compile: bad, model: good, report, engineError: "aicad: not found" });
    expect(problems.some((p) => p.code === "SKETCH_OPEN_LOOP")).toBe(false);
    expect(problems.find((p) => p.source === "engine")).toMatchObject({ code: "ENGINE_FAILED", message: "aicad: not found" });
    // Errors sort before everything else.
    expect(problems[0]!.severity).toBe("error");
  });
});
