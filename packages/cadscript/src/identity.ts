/**
 * Identity: IR parts and features carry `id`s that never appear in CadScript. When a file is
 * compiled against a `base` IR, ids are carried over by matching names; everything else gets a
 * deterministic fresh id (`p_<name>`, `f_<name>`, suffixed `_2`, `_3`, … on collision).
 *
 * Matching rules:
 * 1. A part matches the first unmatched base part with the same name.
 * 2. Within a matched part, a feature matches the first unmatched base feature with the same
 *    name **and type** (changing a feature's type makes it a new feature).
 * 3. Rename detection (parts and features alike): when exactly one base item is left unmatched and
 *    exactly one new item is left unmatched, at the same position (and, for features, of the same
 *    type), the new item keeps the old id and a `CS_RENAME_DETECTED` info diagnostic is emitted.
 */
/** The parts of a base document identity matching needs (an `aicad.ir/0` or `aicad.ir/1` IR). */
export interface IdentityBase<P extends IdentityBasePart = IdentityBasePart> {
  parts: readonly P[];
}
export interface IdentityBasePart {
  id: string;
  name: string;
  features: readonly { id: string; name: string; type: string }[];
}

export interface IdentityInput {
  name: string;
  features: { name: string; type: string }[];
}

export interface Rename {
  kind: "part" | "feature";
  partIndex: number;
  /** Index within the part; -1 for parts. */
  featureIndex: number;
  from: string;
  to: string;
  id: string;
}

export interface IdentityResult<P extends IdentityBasePart = IdentityBasePart> {
  partIds: string[];
  /** Matched base part per part (for preserving explicit default fields). */
  baseParts: (P | undefined)[];
  featureIds: string[][];
  baseFeatures: (P["features"][number] | undefined)[][];
  renames: Rename[];
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Ids in use, plus per stem the first suffix not yet seen taken. Ids are only ever added, so a
 * suffix once taken stays taken and the search can resume where it stopped: linear time for n
 * items with the same name (restarting from `_2` each time made that quadratic).
 */
interface Taken {
  ids: Set<string>;
  next: Map<string, number>;
}

const taken = (ids: Iterable<string>): Taken => ({ ids: new Set(ids), next: new Map() });

/**
 * The first of `stem`, `stem_2`, `stem_3`, … that is not taken; it becomes taken. With
 * `maxLen` (IR v1's 64-byte id limit) the stem is cut so that every candidate fits.
 */
function fresh(prefix: string, name: string, t: Taken, maxLen?: number): string {
  let stem = `${prefix}${sanitize(name)}`;
  if (maxLen !== undefined) stem = stem.slice(0, maxLen);
  const cut = (i: number): string => {
    if (i === 1) return stem;
    const suffix = `_${i}`;
    return maxLen === undefined ? `${stem}${suffix}` : `${stem.slice(0, maxLen - suffix.length)}${suffix}`;
  };
  let i = t.next.get(stem) ?? 1;
  let id = cut(i);
  while (t.ids.has(id)) id = cut(++i);
  t.ids.add(id);
  t.next.set(stem, i + 1);
  return id;
}

/** Match `new` items to `base` items: by key first, then a single same-position rename. */
function match<N, B>(
  items: readonly N[],
  bases: readonly B[],
  same: (n: N, b: B) => boolean,
  renameOk: (n: N, b: B) => boolean,
): { matched: (number | undefined)[]; renamed: number | undefined } {
  const used = new Set<number>();
  const matched: (number | undefined)[] = items.map((n) => {
    const j = bases.findIndex((b, k) => !used.has(k) && same(n, b));
    if (j < 0) return undefined;
    used.add(j);
    return j;
  });
  const newLeft = matched.flatMap((m, i) => (m === undefined ? [i] : []));
  const baseLeft = bases.flatMap((_, k) => (used.has(k) ? [] : [k]));
  let renamed: number | undefined;
  if (newLeft.length === 1 && baseLeft.length === 1 && newLeft[0] === baseLeft[0]) {
    const i = newLeft[0]!;
    if (renameOk(items[i]!, bases[i]!)) {
      matched[i] = i;
      renamed = i;
    }
  }
  return { matched, renamed };
}

export function assignIds<P extends IdentityBasePart>(
  parts: IdentityInput[],
  base: IdentityBase<P> | undefined,
  options: { maxIdLength?: number } = {},
): IdentityResult<P> {
  const maxLen = options.maxIdLength;
  const baseParts: readonly P[] = base?.parts ?? [];
  const takenParts = taken(baseParts.map((p) => p.id));
  const takenFeatures = taken(baseParts.flatMap((p) => p.features.map((f) => f.id)));
  const renames: Rename[] = [];

  const pm = match(
    parts,
    baseParts,
    (n, b) => n.name === b.name,
    () => true,
  );
  const partIds = parts.map((p, i) => {
    const j = pm.matched[i];
    if (j === undefined) return fresh("p_", p.name, takenParts, maxLen);
    const id = baseParts[j]!.id;
    if (pm.renamed === i) renames.push({ kind: "part", partIndex: i, featureIndex: -1, from: baseParts[j]!.name, to: p.name, id });
    return id;
  });
  const matchedParts = parts.map((_, i) => {
    const j = pm.matched[i];
    return j === undefined ? undefined : baseParts[j];
  });

  const featureIds: string[][] = [];
  const baseFeatures: (P["features"][number] | undefined)[][] = [];
  parts.forEach((p, pi) => {
    const bp = matchedParts[pi];
    const bfs = bp?.features ?? [];
    const fm = match(
      p.features,
      bfs,
      (n, b) => n.name === b.name && n.type === b.type,
      (n, b) => n.type === b.type,
    );
    featureIds.push(
      p.features.map((f, fi) => {
        const k = fm.matched[fi];
        if (k === undefined) return fresh("f_", f.name, takenFeatures, maxLen);
        const id = bfs[k]!.id;
        if (fm.renamed === fi) renames.push({ kind: "feature", partIndex: pi, featureIndex: fi, from: bfs[k]!.name, to: f.name, id });
        return id;
      }),
    );
    baseFeatures.push(
      p.features.map((_, fi) => {
        const k = fm.matched[fi];
        return k === undefined ? undefined : bfs[k];
      }),
    );
  });

  return { partIds, baseParts: matchedParts, featureIds, baseFeatures, renames };
}
