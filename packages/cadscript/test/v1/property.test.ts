/**
 * Property tests of CadScript v1 over random IR v1 documents (`arbitraries.ts`):
 * - valid documents: `compileV1(printV1(ir), { base: ir }).ir` deep-equals `ir` (canonical), with
 *   no diagnostics, and the printer is a fixed point;
 * - invalid but printable documents (mutations): the bijection holds on the lowered document and
 *   the front end reports nothing (only IR validation codes);
 * - edit splicing keeps every untouched statement verbatim, and with query aliases in the source
 *   (renames, field edits, deletions) the result still compiles to the new IR.
 * Run count: `CADSCRIPT_V1_RUNS` (default 300 per CI run; the plan's one-off is 5000:
 * `CADSCRIPT_V1_RUNS=5000 npx vitest run test/v1/property.test.ts`). Beyond the default run count
 * the tests have no timeout (5000 runs take minutes; vitest's 30 s default would cut them off).
 */
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeV1, compileV1 } from "../../src/v1/compile.js";
import { canonicalDocument } from "../../src/v1/json.js";
import { printabilityProblemsV1, printV1 } from "../../src/v1/print.js";
import { applyIrEditV1 } from "../../src/v1/splice.js";
import { validateV1 } from "../../src/v1/validate.js";
import { genValidDoc, mutate } from "./arbitraries.js";

const RUNS = Number(process.env["CADSCRIPT_V1_RUNS"] ?? 300);
/** Per-test timeout: vitest's default for the default run count, none (0) for longer runs. */
const TIMEOUT = RUNS > 300 ? 0 : undefined;

describe("the generator covers the language", () => {
  it("every feature type, query op, predicate, curve and constraint kind appears", () => {
    const seen = new Set<string>();
    const walk = (v: unknown, parentKey = ""): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, parentKey));
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o["type"] === "string" && "id" in o && "name" in o) seen.add(`feature:${o["type"]}`);
        if (typeof o["op"] === "string") seen.add(`op:${o["op"]}`);
        if (typeof o["kind"] === "string" && "id" in o) seen.add(`curve:${o["kind"]}`);
        if (parentKey === "constraints" && typeof o["type"] === "string") seen.add(`constraint:${o["type"]}`);
        if (parentKey === "where") for (const k of Object.keys(o)) seen.add(`predicate:${k}`);
        for (const [k, x] of Object.entries(o)) walk(x, k);
      }
    };
    fc.assert(
      fc.property(fc.gen(), (g) => {
        walk(genValidDoc(g));
      }),
      { numRuns: 800 },
    );
    const expected = [
      ...["sketch", "extrude", "revolve", "boolean", "hole", "fillet", "chamfer", "shell", "draft", "pattern", "datum_plane", "datum_axis", "tag"].map((t) => `feature:${t}`),
      ...["body", "bodies", "cap", "endcap", "side", "sides", "edge_at", "between", "hole_face", "created", "instance", "tagged", "faces", "edges", "vertices", "owner", "union", "intersect", "minus", "filter", "extreme", "largest", "smallest"].map((o) => `op:${o}`),
      ...["type", "normal", "parallel", "perpendicular", "convex", "concave", "smooth", "radius"].map((p) => `predicate:${p}`),
      ...["line", "arc", "circle", "point", "rect", "slot", "polygon"].map((k) => `curve:${k}`),
      ...["coincident", "horizontal", "vertical", "parallel", "perpendicular", "tangent", "equal", "distance", "angle", "radius", "diameter", "point_on_line", "point_on_circle", "midpoint", "symmetric", "fix"].map((c) => `constraint:${c}`),
    ];
    expect(expected.filter((e) => !seen.has(e))).toEqual([]);
  }, TIMEOUT);
});

describe("CadScript v1 properties", () => {
  it("the generator makes valid documents", () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const doc = genValidDoc(g);
        expect(validateV1(doc).map((e) => `${e.code} ${e.path}: ${e.message}`)).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  }, TIMEOUT);

  it("valid documents round-trip: compileV1(printV1(ir), { base: ir }).ir deep-equals ir; the printer is a fixed point", () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const doc = genValidDoc(g);
        const canonical = canonicalDocument(doc);
        const src = printV1(doc);
        const r = compileV1(src, { base: doc });
        expect(r.diagnostics.filter((d) => d.severity !== "info" && d.code !== "CS_RESERVED_NAME").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
        expect(r.ir).toStrictEqual(canonical);
        expect(printV1(r.ir!)).toBe(src);
      }),
      { numRuns: RUNS },
    );
  }, TIMEOUT);

  it("forward parameter references (IR v1 orders by dependency): exact with base, up to parameter order without", () => {
    let forward = 0;
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const doc = structuredClone(canonicalDocument(genValidDoc(g)));
        const shuffle = (ps: { name: string }[] | undefined): void => {
          if (!ps || ps.length < 2) return;
          for (let i = ps.length - 1; i > 0; i--) {
            const j = g(fc.integer, { min: 0, max: i });
            [ps[i], ps[j]] = [ps[j]!, ps[i]!];
          }
        };
        shuffle(doc.params);
        for (const p of doc.parts) shuffle(p.params);
        expect(validateV1(doc).map((e) => `${e.code} ${e.path}`)).toEqual([]);
        const src = printV1(doc);
        const withBase = compileV1(src, { base: doc });
        expect(withBase.ir).toStrictEqual(doc);
        const without = compileV1(src).ir!;
        const order = (d: typeof doc): string => JSON.stringify([d.params, ...d.parts.map((p) => p.params)].map((ps) => (ps ?? []).map((p) => p.name)));
        if (order(without) !== order(doc)) forward++; // a forward reference made the printer reorder
        const byName = (ps: { name: string }[] | undefined): unknown => [...(ps ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1));
        expect(byName(without.params)).toStrictEqual(byName(doc.params));
        without.parts.forEach((p, i) => expect(byName(p.params)).toStrictEqual(byName(doc.parts[i]!.params)));
        expect(printV1(without)).toBe(src);
      }),
      { numRuns: Math.max(50, Math.floor(RUNS / 3)) },
    );
    void forward;
  }, TIMEOUT);

  it("forward parameter references: the reviewer's repro (an edit makes `width` use the later `thick`)", () => {
    const src = `import { part, sketch, XY, param, rect, extrude } from "@aicad/std";\n\nconst width = param(80);\nconst thick = param(8);\n\npart("p");\nconst base = sketch(XY, { o: rect({ center: [0, 0], w: width, h: 20 }) });\nconst slab = extrude(base, { distance: thick });\n`;
    const ir = compileV1(src).ir!;
    const next = structuredClone(ir);
    next.params![0]!.value = "thick * 10";
    expect(validateV1(next)).toEqual([]);
    const spliced = applyIrEditV1(src, ir, next);
    expect(spliced.indexOf("const thick")).toBeLessThan(spliced.indexOf("const width"));
    const r = compileV1(spliced, { base: next });
    expect(r.ir).toStrictEqual(canonicalDocument(next)); // the base's order [width, thick]
    expect(compileV1(spliced).ir!.params!.map((p) => p.name)).toEqual(["thick", "width"]); // without base: source order
    expect(compileV1(printV1(next), { base: next }).ir).toStrictEqual(canonicalDocument(next));
  }, TIMEOUT);

  it("invalid printable documents: the bijection holds and only IR codes are reported", () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const doc = mutate(g, genValidDoc(g));
        if (printabilityProblemsV1(doc).length > 0) return;
        const src = printV1(doc);
        const a = analyzeV1(src, { base: doc });
        const frontEnd = a.result.diagnostics.filter((d) => d.code.startsWith("CS_") && d.severity === "error");
        expect(frontEnd.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
        expect(a.doc).toStrictEqual(canonicalDocument(doc));
        // every IR diagnostic points into the source
        for (const d of a.result.diagnostics) expect(d.span.start.line).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: RUNS },
    );
  }, TIMEOUT);

  it("edit splicing keeps untouched statements (and their comments) verbatim", () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const doc = canonicalDocument(genValidDoc(g));
        // A hand-formatted source: a comment above every statement.
        const lines = printV1(doc).split("\n");
        const src = lines.map((l) => (l.startsWith("const ") ? `// keep: ${l.slice(6, 6 + l.slice(6).indexOf(" "))}\n${l}` : l)).join("\n");
        // Edit: change the first feature's name-independent field, or drop the last feature.
        const next = structuredClone(doc);
        const part = next.parts[g(fc.integer, { min: 0, max: next.parts.length - 1 })]!;
        if (part.features.length === 0) return;
        const k = g(fc.integer, { min: 0, max: part.features.length - 1 });
        const victim = part.features[k]!;
        const dropped = g(fc.boolean) && part.features.every((f, i) => i === k || !JSON.stringify(f).includes(`"${victim.id}"`));
        if (dropped) part.features.splice(k, 1);
        else (victim as { suppressed?: unknown }).suppressed = true;
        const out = applyIrEditV1(src, doc, next);
        const r = compileV1(out, { base: next });
        expect(r.ir).toStrictEqual(canonicalDocument(next));
        for (const f of doc.parts.flatMap((p) => p.features)) {
          if (f.id === victim.id) continue;
          const stmt = lines.find((l) => l.startsWith(`const ${f.name} = `));
          if (stmt && !stmt.endsWith("{")) expect(out).toContain(`// keep: ${f.name}\n${stmt}`);
        }
      }),
      { numRuns: Math.max(50, Math.floor(RUNS / 3)) },
    );
  }, TIMEOUT);

  it("edit splicing with query aliases: renames, field edits and deletions compile to the new IR", () => {
    let aliased = 0;
    let keptAliases = 0;
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const doc = canonicalDocument(genValidDoc(g));
        const printed = printV1(doc);
        const src = withAliases(printed, () => g(fc.boolean));
        if (src === printed) return;
        const before = compileV1(src, { base: doc });
        if (!before.ok || !sameDoc(before.ir, doc)) return; // (an alias in a position that takes none)
        aliased++;
        const next = structuredClone(doc);
        const all = next.parts.flatMap((p) => p.features);
        const renamed = all[g(fc.integer, { min: 0, max: all.length - 1 })]!;
        if (g(fc.boolean)) renamed.name = `${renamed.name}_r`;
        const part = next.parts[g(fc.integer, { min: 0, max: next.parts.length - 1 })]!;
        if (part.features.length > 0) {
          const k = g(fc.integer, { min: 0, max: part.features.length - 1 });
          const victim = part.features[k]!;
          const unreferenced = next.parts.every((p) => p.features.every((f) => f === victim || !JSON.stringify(f).includes(`"${victim.id}"`)));
          if (unreferenced && g(fc.boolean)) part.features.splice(k, 1);
          else (victim as { suppressed?: unknown }).suppressed = true;
        }
        const out = applyIrEditV1(src, doc, next);
        const r = compileV1(out, { base: next });
        expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)).toEqual([]);
        expect(r.ir).toStrictEqual(canonicalDocument(next));
        if (/^const q_\d+ = /m.test(out)) keptAliases++;
      }),
      { numRuns: Math.max(50, Math.floor(RUNS / 3)) },
    );
    expect(aliased).toBeGreaterThan(10);
    expect(keptAliases).toBeGreaterThan(5); // aliases survive edits (in place), not only by inlining
  }, TIMEOUT);
});

/** Whether two documents are the same (canonical) document. */
function sameDoc(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `printed` with some queries named by aliases: in each `const` statement (when `pick()`), the
 * first maximal method chain on an earlier const becomes `const q_<k> = <chain>;` above it, and
 * the chain its name.
 */
function withAliases(printed: string, pick: () => boolean): string {
  const sf = ts.createSourceFile("p.cad.ts", printed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = new Set<string>();
  const edits: { start: number; end: number; text: string }[] = [];
  let k = 0;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const d = st.declarationList.declarations[0]!;
    let chain: ts.CallExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (chain) return;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) {
        let root: ts.Expression = n;
        while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression)) root = root.expression.expression;
        if (ts.isIdentifier(root) && declared.has(root.text)) {
          chain = n;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    if (d.initializer) visit(d.initializer);
    if (chain && pick()) {
      const name = `q_${k++}`;
      edits.push({ start: st.getStart(sf), end: st.getStart(sf), text: `const ${name} = ${chain.getText(sf)};\n` });
      edits.push({ start: chain.getStart(sf), end: chain.end, text: name });
    }
    if (ts.isIdentifier(d.name)) declared.add(d.name.text);
  }
  edits.sort((x, y) => y.start - x.start || y.end - x.end);
  let out = printed;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
