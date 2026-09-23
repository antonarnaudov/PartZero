/** fast-check generators for valid IR v0 documents (and edits of them). */
import fc from "fast-check";
import {
  IR_SCHEMA,
  type ExtrudeFeature,
  type Feature,
  type IrDocument,
  type P2,
  type P3,
  type PartStudio,
  type PlaneSpec,
  type RevolveFeature,
  type SketchCurve,
  type SketchFeature,
  type SweepDirection,
} from "@aicad/ir-types";
import { isBuiltin, RESERVED_WORDS } from "../src/syntax.js";

const noNegZero = (v: number): number => (Object.is(v, -0) ? 0 : v);

/** Coordinates: integers, "nice" decimals, awkward doubles and a few edge magnitudes. */
export const coord: fc.Arbitrary<number> = fc
  .oneof(
    { weight: 4, arbitrary: fc.integer({ min: -500, max: 500 }) },
    { weight: 3, arbitrary: fc.integer({ min: -50000, max: 50000 }).map((n) => n / 100) },
    { weight: 3, arbitrary: fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }) },
    { weight: 1, arbitrary: fc.constantFrom(0.1 + 0.2, 1 / 3, 1e-7, -2.5e-7, 123456.789, 1e-300) },
  )
  .map(noNegZero);

const positive = (min: number, max: number): fc.Arbitrary<number> =>
  fc.oneof(
    fc.integer({ min: Math.ceil(min), max: Math.floor(max) }).filter((n) => n > min),
    fc.double({ min, max, noNaN: true, noDefaultInfinity: true, minExcluded: true }),
  );

const p2: fc.Arbitrary<P2> = fc.tuple(coord, coord);

export const identifier: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z_][A-Za-z0-9_]{0,7}$/)
  .filter((n) => !RESERVED_WORDS.has(n) && !isBuiltin(n));

/** Curve ids: identifiers or arbitrary strings (quoted keys, escapes, unicode). */
const curveId: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: identifier },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 6 }) },
  { weight: 1, arbitrary: fc.constantFrom("__proto__", "constructor", "default", "hole-1", "1", "", 'a"b', " ") },
);

const line = (id: string): fc.Arbitrary<SketchCurve> =>
  fc
    .tuple(p2, p2)
    .filter(([a, b]) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-3)
    .map(([start, end]) => ({ kind: "line", id, start, end }));

const arc = (id: string): fc.Arbitrary<SketchCurve> =>
  fc
    .record({
      c: fc.tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 }).map((n) => n / 4)),
      r: fc.oneof(fc.integer({ min: 1, max: 500 }), fc.double({ min: 0.01, max: 500, noNaN: true })),
      a0: fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
      da: fc.double({ min: 0.1, max: 2 * Math.PI - 0.1, noNaN: true }),
      ccw: fc.boolean(),
    })
    .map(({ c, r, a0, da, ccw }) => {
      const center: P2 = [c[0], c[1]];
      const at = (a: number): P2 => [noNegZero(center[0] + r * Math.cos(a)), noNegZero(center[1] + r * Math.sin(a))];
      return { kind: "arc", id, start: at(a0), end: at(a0 + da), center, ccw };
    });

const circle = (id: string): fc.Arbitrary<SketchCurve> =>
  fc.record({ center: p2, radius: positive(1e-3, 1e4) }).map(({ center, radius }) => ({ kind: "circle", id, center, radius }));

const curves: fc.Arbitrary<SketchCurve[]> = fc
  .uniqueArray(curveId, { minLength: 1, maxLength: 5 })
  .chain((ids) => fc.tuple(...ids.map((id) => fc.oneof(line(id), arc(id), circle(id)))));

const vec3 = fc.tuple(
  fc.double({ min: -10, max: 10, noNaN: true }),
  fc.double({ min: -10, max: 10, noNaN: true }),
  fc.double({ min: -10, max: 10, noNaN: true }),
);

const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (v: P3): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const frame: fc.Arbitrary<PlaneSpec> = fc
  .oneof(
    // Axis-aligned integer frames.
    fc.constantFrom<[P3, P3]>(
      [[0, 0, 1], [1, 0, 0]],
      [[0, -1, 0], [1, 0, 0]],
      [[1, 0, 0], [0, 1, 0]],
      [[0, 0, -2], [0, 3, 0]],
    ),
    // General frames: x_dir = normal × helper.
    fc.tuple(vec3, vec3).map(([n, h]): [P3, P3] => [n, cross(n, h)]),
  )
  .filter(([n, x]) => len(n) > 0.1 && len(x) > 1e-3 && Math.abs(dot(n, x) / (len(n) * len(x))) <= 1e-12)
  .chain(([normal, x_dir]) =>
    fc.tuple(coord, coord, coord).map(([a, b, c]): PlaneSpec => ({
      origin: [a, b, c],
      normal: normal.map(noNegZero) as P3,
      x_dir: x_dir.map(noNegZero) as P3,
    })),
  );

const plane: fc.Arbitrary<PlaneSpec> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom<PlaneSpec>("XY", "XZ", "YZ") },
  { weight: 1, arbitrary: frame },
);

/** Optionally present fields: absent, or explicitly set (possibly to the default value). */
const maybe = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arb, { nil: undefined, freq: 2 });
const direction: fc.Arbitrary<SweepDirection | undefined> = maybe(fc.constantFrom<SweepDirection>("normal", "reverse", "symmetric"));

interface FeatureSpec {
  kind: "sketch" | "extrude" | "revolve";
  pick: number;
  sketch: { plane: PlaneSpec; curves: SketchCurve[] };
  extrude: { distance: number };
  revolve: { origin: P2; direction: P2; angle: number };
  direction: SweepDirection | undefined;
  suppressed: boolean | undefined;
  regions: boolean;
  op: boolean;
}

const featureSpec: fc.Arbitrary<FeatureSpec> = fc.record({
  kind: fc.constantFrom("sketch", "extrude", "revolve"),
  pick: fc.nat(),
  sketch: fc.record({ plane, curves }),
  extrude: fc.record({ distance: fc.oneof(positive(1e-5, 1e4), fc.constantFrom(8, 0.5, 1e-5, 2.75)) }),
  revolve: fc.record({
    origin: p2,
    direction: p2.filter(([u, v]) => Math.hypot(u, v) > 1e-3),
    angle: fc.oneof(fc.constant(360), fc.integer({ min: 1, max: 360 }), fc.double({ min: 1e-3, max: 360, noNaN: true })),
  }),
  direction,
  suppressed: maybe(fc.boolean()),
  regions: fc.boolean(),
  op: fc.boolean(),
});

function buildFeature(spec: FeatureSpec, id: string, name: string, sketchesSoFar: string[]): Feature {
  const kind = sketchesSoFar.length === 0 ? "sketch" : spec.kind;
  const common = <T extends object>(f: T): T => {
    if (spec.suppressed !== undefined) Object.assign(f, { suppressed: spec.suppressed });
    return f;
  };
  if (kind === "sketch") {
    const f = common({ type: "sketch", id, name } as SketchFeature);
    f.plane = spec.sketch.plane;
    f.curves = spec.sketch.curves;
    return f;
  }
  const sketch = sketchesSoFar[spec.pick % sketchesSoFar.length]!;
  if (kind === "extrude") {
    const f = common({ type: "extrude", id, name } as ExtrudeFeature);
    f.sketch = sketch;
    if (spec.regions) f.regions = "all";
    f.distance = spec.extrude.distance;
    if (spec.direction !== undefined) f.direction = spec.direction;
    if (spec.op) f.op = "new_body";
    return f;
  }
  const f = common({ type: "revolve", id, name } as RevolveFeature);
  f.sketch = sketch;
  if (spec.regions) f.regions = "all";
  f.axis = { origin: spec.revolve.origin, direction: spec.revolve.direction };
  f.angle = spec.revolve.angle;
  if (spec.direction !== undefined) f.direction = spec.direction;
  if (spec.op) f.op = "new_body";
  return f;
}

const metaText = fc.oneof(fc.string({ maxLength: 12 }), fc.string({ unit: "binary", maxLength: 8 }));

/** A structurally valid IR v0 document that CadScript can express. */
export const irDocument: fc.Arbitrary<IrDocument> = fc
  .record({
    parts: fc.array(fc.array(featureSpec, { maxLength: 5 }), { minLength: 1, maxLength: 3 }),
    partNames: fc.uniqueArray(fc.oneof(identifier, fc.string({ unit: "binary", minLength: 1, maxLength: 6 })), { minLength: 3, maxLength: 3 }),
    featureNames: fc.uniqueArray(identifier, { minLength: 15, maxLength: 15 }),
    ids: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 18, maxLength: 18 }),
    meta: maybe(fc.record({ name: maybe(metaText), description: maybe(metaText) })),
    units: fc.boolean(),
  })
  .map(({ parts, partNames, featureNames, ids, meta, units }) => {
    let nameIx = 0;
    let idIx = 0;
    const doc = { schema: IR_SCHEMA } as IrDocument;
    if (meta) {
      const m: NonNullable<IrDocument["meta"]> = {};
      if (meta.name !== undefined) m.name = meta.name;
      if (meta.description !== undefined) m.description = meta.description;
      doc.meta = m;
    }
    if (units) doc.units = { length: "mm", angle: "deg" };
    doc.parts = parts.map((specs, pi): PartStudio => {
      const sketches: string[] = [];
      const features = specs.map((spec) => {
        const f = buildFeature(spec, ids[idIx++]!, featureNames[nameIx++]!, sketches);
        if (f.type === "sketch") sketches.push(f.name);
        return f;
      });
      return { id: ids[idIx++]!, name: partNames[pi]!, features };
    });
    return doc;
  });

// ─── Edits ───────────────────────────────────────────────────────────────────────────────────

type Mutation = (doc: IrDocument) => void;

const clone = <T>(v: T): T => structuredClone(v);

const pickPart = (doc: IrDocument, n: number): PartStudio | undefined => doc.parts[n % Math.max(1, doc.parts.length)];

const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  // Change a number.
  fc.tuple(fc.nat(), fc.nat(), positive(1e-3, 1000)).map(([p, i, v]): Mutation => (doc) => {
    const part = pickPart(doc, p);
    const f = part?.features[i % Math.max(1, part.features.length)];
    if (!f) return;
    if (f.type === "extrude") f.distance = v;
    else if (f.type === "revolve") f.angle = Math.min(360, v);
    else if (f.curves[0]?.kind === "circle") f.curves[0].radius = v;
    else if (f.curves[0]?.kind === "line") f.curves[0].end = [v, -v];
  }),
  // Toggle suppression.
  fc.tuple(fc.nat(), fc.nat()).map(([p, i]): Mutation => (doc) => {
    const part = pickPart(doc, p);
    const f = part?.features[i % Math.max(1, part.features.length)];
    if (f) f.suppressed = !f.suppressed;
  }),
  // Remove a feature.
  fc.tuple(fc.nat(), fc.nat()).map(([p, i]): Mutation => (doc) => {
    const part = pickPart(doc, p);
    if (part && part.features.length > 0) part.features.splice(i % part.features.length, 1);
  }),
  // Insert a new sketch.
  fc.tuple(fc.nat(), fc.nat(), identifier, curves, plane).map(([p, i, name, cs, pl]): Mutation => (doc) => {
    const part = pickPart(doc, p);
    if (!part) return;
    const f: SketchFeature = { type: "sketch", id: `new_${name}`, name: `n_${name}`, plane: pl, curves: cs };
    part.features.splice(i % (part.features.length + 1), 0, f);
  }),
  // Rename a feature (and its references).
  fc.tuple(fc.nat(), fc.nat(), identifier).map(([p, i, name]): Mutation => (doc) => {
    const part = pickPart(doc, p);
    const f = part?.features[i % Math.max(1, part.features.length)];
    if (!part || !f) return;
    const old = f.name;
    f.name = `r_${name}`;
    for (const g of part.features) if (g.type !== "sketch" && g.sketch === old) g.sketch = f.name;
  }),
  // Move a feature.
  fc.tuple(fc.nat(), fc.nat(), fc.nat()).map(([p, i, j]): Mutation => (doc) => {
    const part = pickPart(doc, p);
    if (!part || part.features.length < 2) return;
    const [f] = part.features.splice(i % part.features.length, 1);
    part.features.splice(j % (part.features.length + 1), 0, f!);
  }),
  // Change the document metadata.
  fc.option(metaText, { nil: undefined }).map((name): Mutation => (doc) => {
    if (name === undefined) delete doc.meta;
    else doc.meta = { ...doc.meta, name };
  }),
  // Add, remove, rename or reorder parts.
  fc.tuple(fc.nat(), identifier).map(([n, name]): Mutation => (doc) => {
    switch (n % 4) {
      case 0:
        doc.parts.splice(n % (doc.parts.length + 1), 0, { id: `pnew_${name}`, name: `new ${name}`, features: [] });
        break;
      case 1:
        if (doc.parts.length > 0) doc.parts.splice(n % doc.parts.length, 1);
        break;
      case 2: {
        const part = pickPart(doc, n);
        if (part) part.name = `${part.name}_renamed`;
        break;
      }
      default:
        doc.parts.reverse();
    }
  }),
);

/** A document and an edited copy of it. */
export const irEdit: fc.Arbitrary<{ before: IrDocument; after: IrDocument }> = fc
  .tuple(irDocument, fc.array(mutation, { minLength: 1, maxLength: 4 }))
  .map(([before, muts]) => {
    const after = clone(before);
    for (const m of muts) m(after);
    return { before, after };
  });
