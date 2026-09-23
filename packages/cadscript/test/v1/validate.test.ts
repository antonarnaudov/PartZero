/**
 * The TypeScript mirror of IR v1 validation against the I9 fixtures: every invalid document of
 * `invalid/documents.json` (exact `{code, path}` multisets, including the cases that need the
 * expression checker), every static query typing case of `queries/typing.json`, and the
 * rejections of `compound/expansions.json` and `holes/tools.json` (SPEC-v1 §9.4: shared by the
 * Rust, TypeScript and Python suites; member and tool dimensions need an evaluator, which the
 * TypeScript side does not have, so only rejection vs clean load is checked here).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { queryKind } from "../../src/v1/lower-query.js";
import { loadIrDocument, precheckV1, validateV1 } from "../../src/v1/validate.js";
import { CONFORMANCE, migrationPairs, readJson, v1Programs } from "./helpers.js";

interface InvalidCase {
  id: string;
  document: unknown;
  expected?: { code: string; path: string }[];
  parse_error?: boolean;
  requires?: string[];
}

const invalid = readJson(join(CONFORMANCE, "invalid/documents.json")) as { cases: InvalidCase[] };

const multiset = (xs: { code: string; path: string }[]): string[] => xs.map((e) => `${e.code} ${e.path}`).sort();

describe("invalid documents (I9, SPEC-v1 §0.5 / §7.5 stage R)", () => {
  it("has the fixture", () => {
    expect(invalid.cases.length).toBeGreaterThanOrEqual(150);
  });

  for (const c of invalid.cases) {
    it(`${c.id}${c.requires ? " (expression checker)" : ""}`, () => {
      const r = loadIrDocument(c.document);
      if (c.parse_error) {
        expect(r.ok).toBe(false);
        expect(!r.ok && r.parseError).toBeTruthy();
        return;
      }
      const got = r.ok ? [] : r.errors.map((e) => ({ code: e.code, path: e.path }));
      if (!r.ok) expect(r.parseError).toBeUndefined();
      expect(multiset(got)).toEqual(multiset(c.expected ?? []));
    });
  }

  it("never echoes an invalid id in messages or details ([W0-12])", () => {
    for (const c of invalid.cases) {
      const r = loadIrDocument(c.document);
      if (r.ok) continue;
      for (const e of r.errors) {
        if (e.code !== "INVALID_ID" && e.code !== "INVALID_NAME") continue;
        const text = JSON.stringify([e.message, e.details]);
        expect(text).not.toMatch(/[\s/:{}|#@%]{2}|\n/);
        expect(e.details).toHaveProperty("reason");
      }
    }
  });
});

interface TypingCase {
  id: string;
  kind: string;
  q: unknown;
  expect?: string;
  errors?: { code: string; path: string }[];
}

const typing = readJson(join(CONFORMANCE, "queries/typing.json")) as { context: { parts: { features: unknown[] }[] }; cases: TypingCase[] };

export function typingDocument(c: { kind: string; q: unknown }): { doc: unknown; tagPath: string } {
  const doc = structuredClone(typing.context) as { parts: { features: unknown[] }[] };
  const features = doc.parts[0]!.features;
  features.push({ type: "tag", id: "tq", name: "tq", target: { kind: c.kind, q: c.q } });
  return { doc, tagPath: `/parts/0/features/${features.length - 1}/target` };
}

describe("static query typing (I9, SPEC-v1 §5.3–§5.5)", () => {
  it("has the fixture", () => {
    expect(typing.cases.length).toBeGreaterThanOrEqual(100);
  });

  for (const c of typing.cases) {
    it(c.id, () => {
      const { doc, tagPath } = typingDocument(c);
      const r = loadIrDocument(doc);
      const got = r.ok ? [] : r.errors.map((e) => ({ code: e.code, path: e.path }));
      const expected = (c.errors ?? []).map((e) => ({ code: e.code, path: `${tagPath}${e.path}` }));
      expect(multiset(got)).toEqual(multiset(expected));
      if (c.expect !== undefined) {
        // "must validate with no error and have that static kind": the validator's typing, and
        // the compiler's (the kind CadScript writes for a query it lowers).
        const kinds = new Map<string, string | undefined>();
        validateV1(doc as never, { onRefKind: (p, k) => kinds.set(p, k) });
        expect(kinds.get(tagPath)).toBe(c.expect);
        const tagKinds = new Map<string, string>();
        for (const f of typing.context.parts[0]!.features as { type: string; id: string; target?: { kind: string } }[]) if (f.type === "tag" && f.target) tagKinds.set(f.id, f.target.kind);
        expect(queryKind(c.q as never, tagKinds)).toBe(c.expect);
      }
    });
  }

  it("has the `expect` cases whose static kind is asserted above", () => {
    expect(typing.cases.filter((c) => c.expect !== undefined).length).toBeGreaterThanOrEqual(50);
  });
});

describe("valid documents", () => {
  for (const p of v1Programs()) {
    it(`corpus/v1/programs/${p.stem} validates cleanly`, () => {
      expect(precheckV1(JSON.parse(p.text)).errors).toEqual([]);
      expect(validateV1(p.ir)).toEqual([]);
    });
  }

  it("every migrated document validates, and v0 inputs load through migration", () => {
    for (const pair of migrationPairs()) {
      expect(validateV1(pair.v1).map((e) => `${e.code} ${e.path}`)).toEqual([]);
      const r = loadIrDocument(pair.v0);
      expect(r.ok && r.version).toBe(0);
      if (r.ok) expect(r.doc).toStrictEqual(pair.v1);
    }
  });
});

interface CompoundCase {
  id: string;
  curve: Record<string, unknown>;
  error?: { code: string; field: string };
}

describe("compound curves (I9 compound/expansions.json, SPEC-v1 §4.1): rejections at the named field", () => {
  const cases = (readJson(join(CONFORMANCE, "compound/expansions.json")) as { cases: CompoundCase[] }).cases;
  it("has the fixture (with rejection cases)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.filter((c) => c.error).length).toBeGreaterThanOrEqual(9);
  });

  for (const c of cases) {
    it(`${c.id}${c.error ? ` → ${c.error.code} at ${c.error.field}` : " loads"}`, () => {
      const doc = { schema: "aicad.ir/1", parts: [{ id: "p1", name: "part", features: [{ type: "sketch", id: "s1", name: "base", plane: "XY", curves: [c.curve] }] }] };
      const r = loadIrDocument(doc);
      if (!c.error) {
        expect(r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`)).toEqual([]);
        expect(r.ok).toBe(true);
        return;
      }
      expect(r.ok).toBe(false);
      expect(!r.ok && r.parseError).toBeFalsy();
      expect(!r.ok && r.errors.map((e) => ({ code: e.code, path: e.path }))).toEqual([{ code: c.error.code, path: `/parts/0/features/0/curves/0/${c.error.field}` }]);
    });
  }
});

interface HoleToolCase {
  id: string;
  hole: Record<string, unknown>;
  error?: string;
}

describe("hole tools (I9 holes/tools.json, SPEC-v1 §6.5): unverified presets are rejected, the rest load", () => {
  const cases = (readJson(join(CONFORMANCE, "holes/tools.json")) as { cases: HoleToolCase[] }).cases;
  it("has the fixture (with rejection cases)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(cases.filter((c) => c.error).length).toBeGreaterThanOrEqual(3);
  });

  for (const c of cases) {
    it(`${c.id}${c.error ? ` → ${c.error}` : " loads"}`, () => {
      // The Rust suite's wrapping (forge-ir tests/v1_conformance.rs `hole_tool_dimensions`).
      const hole = {
        ...c.hole,
        type: "hole",
        id: "h1",
        name: "holes",
        on: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } },
        at: { list: [{ id: "a", at: [0, 0] }] },
      };
      const doc = {
        schema: "aicad.ir/1",
        parts: [
          {
            id: "p1",
            name: "part",
            features: [
              { type: "sketch", id: "s1", name: "base", plane: "XY", curves: [{ kind: "rect", id: "o", center: [0, 0], w: 40, h: 40 }] },
              { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 20 },
              hole,
            ],
          },
        ],
      };
      const r = loadIrDocument(doc);
      if (!c.error) {
        expect(r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`)).toEqual([]);
        expect(r.ok).toBe(true);
        return;
      }
      expect(r.ok).toBe(false);
      // Stricter than the Rust suite (`any` code matches): exactly this one rejection, on the hole.
      expect(!r.ok && r.errors.map((e) => e.code)).toEqual([c.error]);
      expect(!r.ok && r.errors.every((e) => e.path.startsWith("/parts/0/features/2"))).toBe(true);
    });
  }
});
