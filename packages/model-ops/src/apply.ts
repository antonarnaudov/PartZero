/**
 * Applying one catalogue op to a document: {@link applyOp}.
 *
 * - **Phase C ops** (`setParam`, `writeBackSolution`, `captureRef`, the reference repairs,
 *   `renameCurve`, `renameFeature`, `upgradeFeature`) run in the engine's command layer (forge-wasm
 *   `commands`), which verifies each write by evaluation.
 * - **Catalogue v2 ops** (`addFeature`, `setField`, `updateFeature`, `deleteFeature`,
 *   `moveFeature`, `setSuppressed`, `addParam`, `deleteParam`, `renameParam`, `setAuthor`) edit the
 *   document's JSON here and the engine's full v1 rejection pipeline (`canonicalize`) verifies the
 *   result: every problem comes back as the IR rejection code at its path, and the document of
 *   record is the engine's canonical text. Dependencies are the engine's too: a delete, a move or a
 *   parameter removal is tried, and the references the engine then refuses (`UNRESOLVED_*`,
 *   `EXPR_UNKNOWN_NAME`, at their paths) are exactly the dependents or uses.
 * - **Host-state ops** (`setRollback`, `setAppearance`) change the store's host state (the rollback
 *   marker and body colours: view state and FD4's geometry-free appearance, which SPEC set B will
 *   move into the IR), never the IR text.
 *
 * Authorship (ADR 0015 §2) is stamped here, from the op's `origin`: features an agent surface adds
 * are marked `"agent"`; features you add carry no mark (an absent author reads as yours, so undoing
 * a delete restores the exact bytes); an agent feature you edit, rename, move or suppress becomes
 * `"user"`; an agent or MCP op that writes `author` is refused (`COMMAND_AUTHOR_HOST_ONLY`). The commit check (changes to your
 * features need your approval) and the failure rule run per transaction (`rules.ts`).
 *
 * Deviation from FULL-MODELING-PLAN §2.1 rule 1, recorded: the plan puts every op's implementation
 * in a Rust crate (`forge-commands`) so the CLI shares it. The structural ops live here instead,
 * verified by the same Rust engine, so the app, the agent's tools and MCP share one implementation
 * today without a WASM rebuild; `aicad op` (the CLI) is not built yet and would move them to Rust.
 */
import type { metricsV1 } from "@aicad/ir-types";
import type { IrOp, OpOf } from "./catalogue.js";
import { opLabel } from "./catalogue.js";
import {
  allFeatures,
  allParams,
  featureOfPath,
  formatPointer,
  getAt,
  isObject,
  jsonEqual,
  nextFeatureId,
  paramOfPath,
  parseDoc,
  parsePointer,
  requireFeature,
  requireParam,
  requirePart,
  safeId,
  setAt,
  type DocJson,
  type FeatureJson,
  type JsonObject,
} from "./doc.js";
import { CommandEngineError, requireCommandEngine, type EditResult, type IrCommandEngine, type UpgradeFeatureResult, type WriteBackResult } from "./engine.js";
import { inlineLiteral, replaceName } from "./expr.js";

// ─── Origins, authorship and host state ──────────────────────────────────────────────────────

/**
 * Who issued a transaction (FULL-MODELING-PLAN §2.3): `user` (a UI gesture, key, menu or the
 * palette), `command` (host code and tests), `system` (the store itself), `agent` (the in-app
 * agent), `mcp:<client>` (an external MCP client), `cli`.
 */
export type OpOrigin = "user" | "command" | "system" | "agent" | "cli" | `mcp:${string}`;

/** The two authorship marks ADR 0015 records in a feature's `author` field. */
export type Author = "user" | "agent";

/** Agent surfaces: their new features are agent-authored and they cannot write authorship. */
export function isAgentOrigin(origin: OpOrigin): boolean {
  return origin === "agent" || origin.startsWith("mcp:");
}

/** Origins whose transactions pass ADR 0015's commit check (changes to your features need your approval). */
export function needsApproval(origin: OpOrigin): boolean {
  return isAgentOrigin(origin) || origin === "cli";
}

/** The author a new feature gets from its origin. */
export function authorFor(origin: OpOrigin): Author {
  return isAgentOrigin(origin) ? "agent" : "user";
}

/** Whether a feature reads as agent-authored (anything else, an empty field included, is yours). */
export function isAgentAuthored(feature: JsonObject): boolean {
  return feature["author"] === "agent";
}

/** Origins that are "you" issuing an op on a feature: it becomes yours (ADR 0015 §2). */
function claimsForUser(origin: OpOrigin): boolean {
  return origin === "user" || origin === "command";
}

/**
 * State the store keeps beside the IR and records with it (undo restores both): the rollback
 * marker (FULL-MODELING-PLAN §2.3) and body appearance (FD4; the IR has no geometry-free colour
 * field until SPEC set B).
 */
export interface HostState {
  /** The last feature that is built (a feature id), or null: everything is built. */
  rollback: string | null;
  /** Feature id → `#rrggbb`: the colour of the bodies that feature creates. */
  appearance: Readonly<Record<string, string>>;
}

export const EMPTY_HOST_STATE: HostState = Object.freeze({ rollback: null, appearance: Object.freeze({}) });

export function hostStateEqual(a: HostState, b: HostState): boolean {
  return a.rollback === b.rollback && jsonEqual(a.appearance, b.appearance);
}

// ─── Outcomes ────────────────────────────────────────────────────────────────────────────────

/** What an op touched, for the failure rule (`rules.ts`). */
export interface Touched {
  /** Features the op added or edited: they must build. */
  features: string[];
  /** Parameters the op added or set: they must evaluate. */
  params: string[];
  /** Features the op suppressed (they have no report entry). */
  suppressed: string[];
}

/** The outcome of one op on a document. */
export interface OpOutcome {
  op: IrOp;
  /** The canonical `aicad.ir/1` text after the op. */
  document: string;
  changed: boolean;
  /** The engine's or the op's result (previous values, ids, dependents, captures, report diff, …). */
  result: unknown;
  /** The op that undoes this one semantically, when one op does (the store always undoes exactly). */
  inverse: IrOp | null;
  /** The whole semantic inverse (several ops, e.g. a cascading delete restored feature by feature). */
  inverseOps: IrOp[] | null;
  /** A short human-readable label (undo menu, transcripts). */
  label: string;
  touched: Touched;
  /** The host state after the op, when the op changed it. */
  host?: HostState;
}

export interface ApplyOptions {
  /** Compute the op's outcome for review only (an upgrade then needs no `confirm`). */
  preview?: boolean;
  /** Who issues it (default `command`): authorship is stamped from it. */
  origin?: OpOrigin;
  /** The host state the op sees and may change (default: none). */
  host?: HostState;
}

const noTouch = (): Touched => ({ features: [], params: [], suppressed: [] });

function outcome(
  op: IrOp,
  r: EditResult<unknown>,
  inverseOps: IrOp[] | null,
  touched: Touched = noTouch(),
  host?: HostState,
): OpOutcome {
  const inv = r.changed ? inverseOps : null;
  return {
    op,
    document: r.document,
    changed: r.changed || host !== undefined,
    result: r.result,
    inverse: inv && inv.length === 1 ? inv[0]! : null,
    inverseOps: inv,
    label: opLabel(op),
    touched,
    ...(host ? { host } : {}),
  };
}

/** A 64-bit digest of a text (hex): the diff binding of an upgrade's `confirm` token (not a security measure). */
function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** The `confirm` token of an upgrade's result: its feature, versions and report diff. */
export function upgradeConfirmation(r: UpgradeFeatureResult): string {
  return `v${r.from}-v${r.to}-${digest(JSON.stringify([r.feature, r.from, r.to, r.diff]))}`;
}

// ─── Verification through the engine ────────────────────────────────────────────────────────

/** The engine's canonical text of an edited document, or its rejection (every problem at its path). */
async function verify(engine: IrCommandEngine, doc: DocJson): Promise<string> {
  return (await engine.canonicalize(JSON.stringify(doc))).document;
}

/** The engine's canonical text, or the rejection as data (for the dependency loops). */
async function tryVerify(engine: IrCommandEngine, doc: DocJson): Promise<{ ok: true; document: string } | { ok: false; error: CommandEngineError }> {
  try {
    return { ok: true, document: await verify(engine, doc) };
  } catch (e) {
    if (e instanceof CommandEngineError && e.errors.length > 0) return { ok: false, error: e };
    throw e;
  }
}

/** Refuse an agent op that writes authorship (ADR 0015 §2: the host is the only writer). */
function refuseAuthorWrite(origin: OpOrigin, where: string): void {
  if (isAgentOrigin(origin)) {
    throw new CommandEngineError("COMMAND_AUTHOR_HOST_ONLY", `${where}: authorship is written by the app, not by agents (ADR 0015); leave "author" out`, [], {
      field: "author",
    });
  }
}

/** `{ "expr": "…" }` anywhere in a value → the expression string (how callers say "this is an expression"). */
function exprValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(exprValue);
  if (isObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "expr") {
      const e = v["expr"];
      if (typeof e !== "string" || e.trim() === "") throw new CommandEngineError("COMMAND_BAD_VALUE", '{ "expr" } needs a non-empty expression string', [], {});
      return e;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, exprValue(x)]));
  }
  return v;
}

/** After an op by "you" on agent features: they become yours (ADR 0015 §2). Returns true when something changed. */
function claim(features: readonly FeatureJson[], origin: OpOrigin): boolean {
  if (!claimsForUser(origin)) return false;
  let changed = false;
  for (const f of features) {
    if (isAgentAuthored(f)) {
      f["author"] = "user";
      changed = true;
    }
  }
  return changed;
}

/** An engine op's result document with the edited agent features claimed for the user (re-verified). */
async function claimAfterEngine(engine: IrCommandEngine, r: EditResult<unknown>, featureIds: readonly string[], origin: OpOrigin): Promise<EditResult<unknown>> {
  if (!r.changed || !claimsForUser(origin)) return r;
  const d = parseDoc(r.document);
  const fs = featureIds.map((id) => allFeatures(d).find((f) => f.id === id)).filter((f): f is FeatureJson => f !== undefined);
  if (!claim(fs, origin)) return r;
  return { ...r, document: await verify(engine, d) };
}

const FIXED_FIELDS = new Set(["id", "type"]);

// ─── The op table ────────────────────────────────────────────────────────────────────────────

/**
 * Apply one op to `document` (either IR version; the result is canonical `aicad.ir/1` text).
 * Throws a `CommandEngineError` when the op is refused (the document's rejection, a `COMMAND_*`
 * refusal with its `details`, or `COMMAND_UPGRADE_UNCONFIRMED`); never returns a document that failed
 * the engine's verification.
 */
export async function applyOp(engine: IrCommandEngine | null | undefined, document: string, op: IrOp, options: ApplyOptions = {}): Promise<OpOutcome> {
  const e = requireCommandEngine(engine);
  const origin = options.origin ?? "command";
  const host = options.host ?? EMPTY_HOST_STATE;
  switch (op.op) {
    case "setParam": {
      const r = await e.setParam(document, op.name, op.value);
      return outcome(op, r, [{ op: "setParam", name: op.name, value: r.result.previous }], { ...noTouch(), params: [op.name] });
    }
    case "writeBackSolution": {
      // The engine iterates to the fixed point ([W0-31]), so a second write-back changes nothing.
      const r: WriteBackResult = await e.writeBack(document, op.sketches);
      const { document: text, ...result } = r;
      return outcome(op, { document: text, changed: r.changed, result }, null);
    }
    case "captureRef": {
      const r = await claimAfterEngine(e, await e.captureRef(document, op.feature, op.field), [op.feature], origin);
      return outcome(op, r, null, { ...noTouch(), features: [op.feature] });
    }
    case "acceptRefCandidate": {
      const r0 = await e.acceptRefCandidate(document, op.feature, op.field, op.member, op.candidate, op.candidateIndex, op.probe);
      const r = await claimAfterEngine(e, r0, [op.feature], origin);
      return outcome(op, r, null, { ...noTouch(), features: [op.feature] });
    }
    case "acceptRefProposal": {
      const r = await claimAfterEngine(e, await e.acceptRefProposal(document, op.feature, op.field), [op.feature], origin);
      return outcome(op, r, null, { ...noTouch(), features: [op.feature] });
    }
    case "renameCurve": {
      const r = await claimAfterEngine(e, await e.renameCurve(document, op.sketch, op.old, op.new), [op.sketch], origin);
      return outcome(op, r, [{ op: "renameCurve", sketch: op.sketch, old: op.new, new: op.old }], { ...noTouch(), features: [op.sketch] });
    }
    case "renameFeature": {
      const r0 = await e.renameFeature(document, op.feature, op.name);
      const r = await claimAfterEngine(e, r0, [op.feature], origin);
      return outcome(op, r, [{ op: "renameFeature", feature: op.feature, name: r0.result.previous }]);
    }
    case "upgradeFeature": {
      const r0: EditResult<UpgradeFeatureResult> = await e.upgradeFeature(document, op.feature, op.to);
      const confirm = upgradeConfirmation(r0.result);
      if (r0.changed && !options.preview && op.confirm !== confirm) {
        const { feature, from, to, diff } = r0.result;
        throw new CommandEngineError(
          "COMMAND_UPGRADE_UNCONFIRMED",
          `upgrading ${feature} from v${from} to v${to} changes the report of ${diff.length} entr${diff.length === 1 ? "y" : "ies"}: ` +
            `review the diff and apply it with its confirm token (${op.confirm === undefined ? "none was given" : "the given token is for another diff"})`,
          [],
          { feature, from, to, diff, confirm, ...(op.confirm !== undefined ? { given: op.confirm } : {}) },
        );
      }
      const r = await claimAfterEngine(e, r0, [op.feature], origin);
      return outcome(op, { ...r, result: { ...r0.result, confirm } }, null, { ...noTouch(), features: [op.feature] });
    }
    case "addFeature":
      return addFeature(e, document, op, origin, host);
    case "setField":
      return setField(e, document, op, origin);
    case "updateFeature":
      return updateFeature(e, document, op, origin);
    case "deleteFeature":
      return deleteFeature(e, document, op, host);
    case "moveFeature":
      return moveFeature(e, document, op, origin);
    case "setSuppressed":
      return setSuppressed(e, document, op, origin);
    case "addParam":
      return addParam(e, document, op);
    case "deleteParam":
      return deleteParam(e, document, op);
    case "renameParam":
      return renameParam(e, document, op);
    case "setRollback": {
      const d = parseDoc(document);
      const after = op.after === null ? null : requireFeature(d, op.after).feature.id;
      const unchanged = { document, changed: false, result: { rollback: after, previous: host.rollback } };
      if (after === host.rollback) return outcome(op, unchanged, null);
      return outcome(op, { ...unchanged, changed: true }, [{ op: "setRollback", after: host.rollback }], noTouch(), { ...host, rollback: after });
    }
    case "setAppearance": {
      const d = parseDoc(document);
      const id = requireFeature(d, op.feature).feature.id;
      const previous = host.appearance[id] ?? null;
      const color = op.color === null ? null : op.color.toLowerCase();
      const result = { feature: id, color, previous };
      if (previous === color) return outcome(op, { document, changed: false, result }, null);
      const appearance: Record<string, string> = { ...host.appearance };
      if (color === null) delete appearance[id];
      else appearance[id] = color;
      return outcome(op, { document, changed: true, result }, [{ op: "setAppearance", feature: id, color: previous }], noTouch(), { ...host, appearance });
    }
    case "setAuthor":
      return setAuthor(e, document, op, origin);
    case "replaceDocument":
      return replaceDocument(e, document, op, origin);
  }
}

/** A feature's JSON without its authorship mark (what a code edit may change). */
function unmarked(f: JsonObject): JsonObject {
  const { author: _author, ...rest } = f;
  return rest;
}

async function replaceDocument(e: IrCommandEngine, document: string, op: OpOf<"replaceDocument">, origin: OpOrigin): Promise<OpOutcome> {
  const base = parseDoc(document);
  const next = parseDoc((await e.canonicalize(op.document)).document);
  const before = new Map(allFeatures(base).map((f) => [f.id, f]));
  const touched: Touched = noTouch();
  if (op.keepAuthors && isAgentOrigin(origin)) refuseAuthorWrite(origin, "replaceDocument");
  for (const f of allFeatures(next)) {
    const b = before.get(f.id);
    const changed = !b || !jsonEqual(unmarked(b), unmarked(f));
    if (changed) touched.features.push(f.id);
    if (op.keepAuthors) continue;
    // Authorship is the host's (ADR 0015 §2): an `author` in the code is ignored.
    delete f["author"];
    if (b && b["author"] !== undefined) f["author"] = b["author"];
    if (!b && isAgentOrigin(origin)) f["author"] = "agent";
    if (changed && b && claimsForUser(origin) && isAgentAuthored(b)) f["author"] = "user";
  }
  const oldParams = new Map(allParams(base).map((l) => [String(l.param["name"]), l.param]));
  for (const l of allParams(next)) {
    const name = String(l.param["name"]);
    const p = oldParams.get(name);
    if (!p || !jsonEqual(p, l.param)) touched.params.push(name);
  }
  const text = await verify(e, next);
  const result = { features: touched.features, params: touched.params };
  return outcome(op, { document: text, changed: text !== document, result }, [{ op: "replaceDocument", document, keepAuthors: true }], touched);
}

// ─── Features ────────────────────────────────────────────────────────────────────────────────

async function addFeature(e: IrCommandEngine, document: string, op: OpOf<"addFeature">, origin: OpOrigin, host: HostState): Promise<OpOutcome> {
  const d = parseDoc(document);
  const { part } = requirePart(d, op.part);
  let index: number;
  let atMarker = false;
  if (op.after === undefined) {
    const m = host.rollback === null ? -1 : part.features.findIndex((f) => f.id === host.rollback);
    atMarker = m >= 0;
    index = atMarker ? m + 1 : part.features.length;
  } else if (op.after === null) {
    index = 0;
  } else {
    const loc = requireFeature(d, op.after);
    if (loc.part !== part) {
      throw new CommandEngineError("COMMAND_WRONG_PART", `${safeId(op.after)} is in part ${loc.part.id}, not in ${part.id}: a feature goes after a feature of its own part`, [], {
        after: loc.feature.id,
        part: part.id,
      });
    }
    index = loc.index + 1;
  }
  const feature = exprValue(structuredClone(op.feature)) as JsonObject;
  // ADR 0015 §2: an agent's feature is marked "agent"; yours needs no mark (an absent author reads
  // as yours), so a feature you add, or re-add through an inverse, keeps exactly the JSON given.
  if (Object.prototype.hasOwnProperty.call(feature, "author")) refuseAuthorWrite(origin, "addFeature");
  else if (authorFor(origin) === "agent") feature["author"] = "agent";
  const type = String(feature["type"]);
  const id = typeof feature["id"] === "string" ? feature["id"] : nextFeatureId(d, type);
  if (typeof feature["id"] !== "string") feature["id"] = id;
  if (typeof feature["name"] !== "string") feature["name"] = id;
  part.features.splice(index, 0, feature as FeatureJson);
  const text = await verify(e, d);
  const result = { feature: id, name: feature["name"], type, part: part.id, index, author: feature["author"] === "agent" ? "agent" : "user" };
  // New features go at the marker, and the marker moves past them (the next one goes after it).
  const nextHost = atMarker ? { ...host, rollback: id } : undefined;
  return outcome(op, { document: text, changed: true, result }, [{ op: "deleteFeature", feature: id }], { ...noTouch(), features: [id] }, nextHost);
}

function refuseFixed(field: string, origin: OpOrigin, what: string): void {
  if (FIXED_FIELDS.has(field)) {
    throw new CommandEngineError("COMMAND_FIXED_FIELD", `${what}: a feature's ${field} cannot be changed (add a new feature instead)`, [], { field });
  }
  if (field === "author") refuseAuthorWrite(origin, what);
}

async function setField(e: IrCommandEngine, document: string, op: OpOf<"setField">, origin: OpOrigin): Promise<OpOutcome> {
  const d = parseDoc(document);
  const loc = requireFeature(d, op.feature);
  const f = loc.feature;
  const segs = parsePointer(op.path);
  refuseFixed(segs[0]!, origin, "setField");
  if (!op.remove && op.value === undefined) throw new CommandEngineError("COMMAND_BAD_VALUE", "setField needs a value (or remove: true)", [], { path: op.path });
  const parent = getAt(f, segs.slice(0, -1));
  const last = segs[segs.length - 1]!;
  const appending = Array.isArray(parent) && (last === "-" || last === String(parent.length));
  const concrete = appending ? [...segs.slice(0, -1), String((parent as unknown[]).length)] : segs;
  const previous = appending ? undefined : structuredClone(getAt(f, segs));
  if (op.remove && previous === undefined) return outcome(op, { document, changed: false, result: { feature: f.id, path: op.path, previous: null } }, null);
  setAt(f, segs, op.remove ? undefined : exprValue(structuredClone(op.value)), `${f.name}`);
  if (segs[0] !== "author") claim([f], origin);
  const text = await verify(e, d);
  const changed = text !== document;
  const inverse: IrOp =
    previous === undefined
      ? { op: "setField", feature: f.id, path: formatPointer(concrete), remove: true }
      : { op: "setField", feature: f.id, path: formatPointer(concrete), value: previous };
  return outcome(op, { document: text, changed, result: { feature: f.id, path: formatPointer(concrete), previous: previous ?? null } }, [inverse], {
    ...noTouch(),
    features: [f.id],
  });
}

async function updateFeature(e: IrCommandEngine, document: string, op: OpOf<"updateFeature">, origin: OpOrigin): Promise<OpOutcome> {
  const d = parseDoc(document);
  const f = requireFeature(d, op.feature).feature;
  const previous: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op.set)) {
    refuseFixed(k, origin, "updateFeature");
    if (k === "__proto__" || k === "constructor" || k === "prototype") throw new CommandEngineError("COMMAND_BAD_PATH", `updateFeature: "${k}" is a reserved key`, [], {});
    previous[k] = Object.prototype.hasOwnProperty.call(f, k) ? structuredClone(f[k]) : null;
    if (v === null) delete f[k];
    else f[k] = exprValue(structuredClone(v));
  }
  if (!Object.prototype.hasOwnProperty.call(op.set, "author")) claim([f], origin);
  const text = await verify(e, d);
  return outcome(op, { document: text, changed: text !== document, result: { feature: f.id, previous } }, [{ op: "updateFeature", feature: f.id, set: previous }], {
    ...noTouch(),
    features: [f.id],
  });
}

interface Dependent {
  id: string;
  name: string;
  type: string;
  /** The rejection that names the deleted feature, e.g. `UNRESOLVED_SKETCH` at `/sketch`. */
  code: string;
  path: string;
}

/** Features a rejection locates (by their paths in `doc`); problems outside features are returned apart. */
function rejectedFeatures(doc: DocJson, err: CommandEngineError): { features: Array<{ feature: FeatureJson; partIndex: number; index: number; code: string; path: string }>; other: boolean } {
  const out = new Map<string, { feature: FeatureJson; partIndex: number; index: number; code: string; path: string }>();
  let other = false;
  for (const p of err.errors) {
    const at = featureOfPath(p.path);
    const f = at ? doc.parts[at.partIndex]?.features[at.index] : undefined;
    if (!at || !f) {
      other = true;
      continue;
    }
    if (!out.has(f.id)) out.set(f.id, { feature: f, partIndex: at.partIndex, index: at.index, code: p.code, path: at.rest });
  }
  return { features: [...out.values()], other };
}

async function deleteFeature(e: IrCommandEngine, document: string, op: OpOf<"deleteFeature">, host: HostState): Promise<OpOutcome> {
  const original = parseDoc(document);
  const target = requireFeature(original, op.feature);
  const mode = op.dependents ?? "refuse";
  const work = parseDoc(document);
  const removed = new Set<string>([target.feature.id]);
  const dependents: Dependent[] = [];
  const drop = (id: string) => {
    for (const p of work.parts) p.features = p.features.filter((f) => f.id !== id);
  };
  drop(target.feature.id);
  let text: string | null = null;
  for (let guard = 0; guard <= allFeatures(original).length; guard++) {
    const r = await tryVerify(e, work);
    if (r.ok) {
      text = r.document;
      break;
    }
    const hit = rejectedFeatures(work, r.error);
    if (hit.other || hit.features.length === 0) throw r.error;
    for (const h of hit.features) {
      dependents.push({ id: h.feature.id, name: h.feature.name, type: h.feature.type, code: h.code, path: h.path });
      removed.add(h.feature.id);
      drop(h.feature.id);
    }
  }
  if (text === null) throw new CommandEngineError("COMMAND_HAS_DEPENDENTS", "the delete does not converge", [], { feature: target.feature.id });
  if (dependents.length > 0 && mode !== "cascade") {
    const list = dependents.map((d) => `${d.name} (${d.type}, ${d.code})`).join(", ");
    throw new CommandEngineError(
      "COMMAND_HAS_DEPENDENTS",
      `${target.feature.name} is referenced by ${dependents.length} feature${dependents.length === 1 ? "" : "s"}: ${list}. ` +
        (mode === "keep"
          ? "They reference it by id, so they cannot be kept without it: delete them too (dependents: cascade) or change them first."
          : "Delete them too (dependents: cascade), or change them first."),
      [],
      { feature: target.feature.id, dependents },
    );
  }
  // The inverse re-adds every deleted feature at its place, in timeline order.
  const inverse: IrOp[] = [];
  for (const p of original.parts) {
    p.features.forEach((f, i) => {
      if (!removed.has(f.id)) return;
      inverse.push({ op: "addFeature", part: p.id, after: i === 0 ? null : p.features[i - 1]!.id, feature: structuredClone(f) as OpOf<"addFeature">["feature"] });
    });
  }
  // Host state: no colour for deleted features; a marker on one moves to the last feature before it.
  let nextHost: HostState | undefined;
  const appearance = Object.fromEntries(Object.entries(host.appearance).filter(([id]) => !removed.has(id)));
  let rollback = host.rollback;
  if (rollback !== null && removed.has(rollback)) {
    const p = original.parts.find((pp) => pp.features.some((f) => f.id === rollback))!;
    const i = p.features.findIndex((f) => f.id === rollback);
    rollback = p.features.slice(0, i).reverse().find((f) => !removed.has(f.id))?.id ?? null;
  }
  if (rollback !== host.rollback || Object.keys(appearance).length !== Object.keys(host.appearance).length) nextHost = { rollback, appearance };
  return outcome(op, { document: text, changed: true, result: { deleted: [...removed], dependents } }, inverse, noTouch(), nextHost);
}

async function moveFeature(e: IrCommandEngine, document: string, op: OpOf<"moveFeature">, origin: OpOrigin): Promise<OpOutcome> {
  const d = parseDoc(document);
  const loc = requireFeature(d, op.feature);
  const part = loc.part;
  const f = loc.feature;
  const previousAfter = loc.index > 0 ? part.features[loc.index - 1]!.id : null;
  let afterId: string | null = null;
  if (op.after !== null) {
    const a = requireFeature(d, op.after);
    if (a.part !== part) {
      throw new CommandEngineError("COMMAND_WRONG_PART", `${safeId(op.after)} is in part ${a.part.id}: a feature moves within its own part (${part.id})`, [], {
        feature: f.id,
        after: a.feature.id,
      });
    }
    if (a.feature.id === f.id) throw new CommandEngineError("COMMAND_BAD_VALUE", "a feature cannot move after itself", [], { feature: f.id });
    afterId = a.feature.id;
  }
  const result = { feature: f.id, after: afterId, previousAfter };
  if (afterId === previousAfter) return outcome(op, { document, changed: false, result }, null);
  part.features.splice(loc.index, 1);
  const to = afterId === null ? 0 : part.features.findIndex((x) => x.id === afterId) + 1;
  part.features.splice(to, 0, f);
  claim([f], origin);
  const r = await tryVerify(e, d);
  if (!r.ok) {
    const hit = rejectedFeatures(d, r.error);
    if (hit.other || hit.features.length === 0) throw r.error;
    const problems = hit.features.map((h) => ({ feature: h.feature.id, name: h.feature.name, code: h.code, path: h.path }));
    throw new CommandEngineError(
      "COMMAND_ILLEGAL_ORDER",
      `moving ${f.name} there would make ${problems.map((p) => `${p.name} (${p.code})`).join(", ")} reference a later feature; features reference only earlier ones`,
      r.error.errors,
      { feature: f.id, after: afterId, problems },
    );
  }
  return outcome(op, { document: r.document, changed: true, result }, [{ op: "moveFeature", feature: f.id, after: previousAfter }], { ...noTouch(), features: [f.id] });
}

async function setSuppressed(e: IrCommandEngine, document: string, op: OpOf<"setSuppressed">, origin: OpOrigin): Promise<OpOutcome> {
  const d = parseDoc(document);
  const f = requireFeature(d, op.feature).feature;
  const previous = f["suppressed"];
  if (op.suppressed) f["suppressed"] = true;
  else delete f["suppressed"];
  claim([f], origin);
  const text = await verify(e, d);
  const inverse: IrOp =
    typeof previous === "string"
      ? { op: "setField", feature: f.id, path: "/suppressed", value: previous }
      : { op: "setSuppressed", feature: f.id, suppressed: previous === true };
  const touched = op.suppressed ? { ...noTouch(), suppressed: [f.id] } : { ...noTouch(), features: [f.id] };
  return outcome(op, { document: text, changed: text !== document, result: { feature: f.id, suppressed: op.suppressed, previous: previous ?? false } }, [inverse], touched);
}

async function setAuthor(e: IrCommandEngine, document: string, op: OpOf<"setAuthor">, origin: OpOrigin): Promise<OpOutcome> {
  refuseAuthorWrite(origin, "setAuthor");
  const d = parseDoc(document);
  const inverse: IrOp[] = [];
  const ids: string[] = [];
  for (const name of op.features) {
    const f = requireFeature(d, name).feature;
    const prev = f["author"];
    if (prev === op.author) continue;
    ids.push(f.id);
    inverse.push(prev === undefined ? { op: "setField", feature: f.id, path: "/author", remove: true } : { op: "setField", feature: f.id, path: "/author", value: prev });
    f["author"] = op.author;
  }
  if (ids.length === 0) return outcome(op, { document, changed: false, result: { features: [], author: op.author } }, null);
  const text = await verify(e, d);
  return outcome(op, { document: text, changed: text !== document, result: { features: ids, author: op.author } }, inverse);
}

// ─── Parameters ──────────────────────────────────────────────────────────────────────────────

async function addParam(e: IrCommandEngine, document: string, op: OpOf<"addParam">): Promise<OpOutcome> {
  const d = parseDoc(document);
  let list: JsonObject[];
  let scope = "doc";
  if (op.part !== undefined) {
    const { part } = requirePart(d, op.part);
    part.params ??= [];
    list = part.params;
    scope = part.id;
  } else {
    d.params ??= [];
    list = d.params;
  }
  const param: JsonObject = { name: op.name, unit: op.unit, value: op.value };
  if (op.min !== undefined) param["min"] = op.min;
  if (op.max !== undefined) param["max"] = op.max;
  if (op.note !== undefined) param["note"] = op.note;
  const at = Math.min(op.at ?? list.length, list.length);
  list.splice(at, 0, param);
  const text = await verify(e, d);
  return outcome(op, { document: text, changed: true, result: { param: op.name, scope, index: at } }, [{ op: "deleteParam", name: op.name }], {
    ...noTouch(),
    params: [op.name],
  });
}

/** A site of a parameter's use that the engine reported (`EXPR_UNKNOWN_NAME` at its path). */
interface UseSite {
  path: string;
  /** The feature whose field it is. */
  feature?: string;
  /** The parameter whose value or bound it is. */
  param?: string;
  /** The expression text there. */
  text: string;
}

function useSites(doc: DocJson, err: CommandEngineError, name: string): { sites: UseSite[]; other: boolean } {
  const sites: UseSite[] = [];
  let other = false;
  for (const p of err.errors) {
    if (p.code !== "EXPR_UNKNOWN_NAME" || p.details?.["name"] !== name) {
      other = true;
      continue;
    }
    const text = getAt(doc, parsePointer(p.path));
    if (typeof text !== "string") {
      other = true;
      continue;
    }
    const fa = featureOfPath(p.path);
    const pa = paramOfPath(p.path);
    const feature = fa ? doc.parts[fa.partIndex]?.features[fa.index]?.id : undefined;
    const param = pa ? (pa.partIndex === undefined ? doc.params : doc.parts[pa.partIndex]?.params)?.[pa.index]?.["name"] : undefined;
    sites.push({ path: p.path, text, ...(feature ? { feature } : {}), ...(typeof param === "string" ? { param } : {}) });
  }
  return { sites, other };
}

async function deleteParam(e: IrCommandEngine, document: string, op: OpOf<"deleteParam">): Promise<OpOutcome> {
  const d = parseDoc(document);
  const loc = requireParam(d, op.name);
  const removedParam = structuredClone(loc.param);
  loc.list.splice(loc.index, 1);
  const addBack: IrOp = {
    op: "addParam",
    name: op.name,
    unit: removedParam["unit"] as OpOf<"addParam">["unit"],
    value: removedParam["value"] as OpOf<"addParam">["value"],
    ...(removedParam["min"] !== undefined ? { min: removedParam["min"] as number | string } : {}),
    ...(removedParam["max"] !== undefined ? { max: removedParam["max"] as number | string } : {}),
    ...(typeof removedParam["note"] === "string" ? { note: removedParam["note"] } : {}),
    ...(loc.partIndex !== undefined ? { part: d.parts[loc.partIndex]!.id } : {}),
    at: loc.index,
  };
  const first = await tryVerify(e, d);
  if (first.ok) return outcome(op, { document: first.document, changed: true, result: { param: op.name, uses: [] } }, [addBack]);
  const { sites, other } = useSites(d, first.error, op.name);
  if (other || sites.length === 0) throw first.error;
  if ((op.uses ?? "refuse") === "refuse") {
    // The engine's paths are in the document without the parameter: report them in the document as it is.
    const original = (path: string): string => {
      const pa = paramOfPath(path);
      if (!pa || pa.partIndex !== loc.partIndex || pa.index < loc.index) return path;
      const head = pa.partIndex === undefined ? "/params" : `/parts/${pa.partIndex}/params`;
      return `${head}/${pa.index + 1}${pa.rest}`;
    };
    for (const s of sites) s.path = original(s.path);
    throw new CommandEngineError(
      "COMMAND_PARAM_IN_USE",
      `${op.name} is used by ${sites.length} expression${sites.length === 1 ? "" : "s"} (${sites
        .slice(0, 8)
        .map((s) => s.feature ?? s.param ?? s.path)
        .join(", ")}): change them first, or inline its value (uses: inline)`,
      [],
      { param: op.name, uses: sites },
    );
  }
  // Inline: each use gets the parameter's current value.
  const report = await e.params(document);
  const value = report.find((p) => p.name === op.name)?.value;
  if (typeof value !== "number" && typeof value !== "boolean") {
    throw new CommandEngineError("COMMAND_PARAM_FAILED", `${op.name} has no value to inline (it fails to evaluate)`, [], { param: op.name });
  }
  const unit = String(removedParam["unit"]);
  const restore: IrOp[] = [addBack];
  let exact = true;
  for (const s of sites) {
    const segs = parsePointer(s.path);
    const whole = s.text.trim() === op.name;
    setAt(d, segs, whole ? value : replaceName(s.text, op.name, inlineLiteral(unit, value)), "the document");
    const fa = featureOfPath(s.path);
    if (fa && s.feature) restore.push({ op: "setField", feature: s.feature, path: fa.rest, value: s.text });
    else if (s.param && paramOfPath(s.path)?.rest === "/value") restore.push({ op: "setParam", name: s.param, value: s.text });
    else exact = false;
  }
  const text = await verify(e, d);
  return outcome(op, { document: text, changed: true, result: { param: op.name, uses: sites, inlined: value } }, exact ? restore : null, {
    ...noTouch(),
    features: [...new Set(sites.flatMap((s) => (s.feature ? [s.feature] : [])))],
  });
}

async function renameParam(e: IrCommandEngine, document: string, op: OpOf<"renameParam">): Promise<OpOutcome> {
  const d = parseDoc(document);
  const loc = requireParam(d, op.old);
  if (op.new === op.old) return outcome(op, { document, changed: false, result: { param: op.old, uses: [] } }, null);
  loc.param["name"] = op.new;
  let r = await tryVerify(e, d);
  let sites: UseSite[] = [];
  if (!r.ok) {
    const u = useSites(d, r.error, op.old);
    if (u.other || u.sites.length === 0) throw r.error;
    sites = u.sites;
    for (const s of sites) setAt(d, parsePointer(s.path), replaceName(s.text, op.old, op.new), "the document");
    r = await tryVerify(e, d);
    if (!r.ok) throw r.error;
  }
  return outcome(op, { document: r.document, changed: true, result: { param: op.new, previous: op.old, uses: sites.map((s) => s.path) } }, [
    { op: "renameParam", old: op.new, new: op.old },
  ], { ...noTouch(), params: [op.new] });
}

// ─── Report helpers (the repair UI and the agent) ─────────────────────────────────────────────

/** A reference's report entry, located by feature id and field (SPEC-v1 §5.8). */
export interface RefLocation {
  featureId: string;
  feature: string;
  field: string;
  entry: metricsV1.RefReport;
}

/**
 * Every reference entry of an `aicad.metrics/1` report (optionally of one feature): members with
 * probes, unresolved members with ranked candidates (each with probe and synthesised `query`),
 * and proposals — what the repair UI and the agent's `repair_ref` read.
 */
export function refEntries(report: metricsV1.EvalReport, featureId?: string): RefLocation[] {
  const out: RefLocation[] = [];
  for (const f of report.features) {
    if (featureId !== undefined && f.feature_id !== featureId) continue;
    for (const entry of f.refs ?? []) out.push({ featureId: f.feature_id, feature: f.feature, field: entry.field, entry });
  }
  return out;
}

/** Whether a reported member is the entity of that key and probe (split pieces share a key). */
function sameEntity(m: { key: string; probe: metricsV1.Probe }, c: { key: string; probe: metricsV1.Probe }): boolean {
  return m.key === c.key && JSON.stringify(m.probe) === JSON.stringify(c.probe);
}

/**
 * Whether accepting candidate `c` of unresolved entry `u` drops no other member (forge-wasm's
 * `COMMAND_CANDIDATE_PARTIAL` rule): the reference has no other unresolved entry, and every
 * resolved member is `c` itself or stands for `u` — a candidate of an entry without a capture
 * (key `""`), or a piece of `u`'s own key that `u` offers. A member merely listed among the
 * candidates (another captured key accounts for it) is still another member.
 */
export function candidateReplacesAll(e: metricsV1.RefReport, u: metricsV1.Unresolved, c: metricsV1.Candidate): boolean {
  if ((e.unresolved ?? []).length !== 1) return false;
  return e.members.every((m) => sameEntity(m, c) || ((u.key === "" || m.key === u.key) && u.candidates.some((x) => sameEntity(m, x))));
}

/**
 * The ops a failed or changed reference offers, derived from its report entry — only ops the
 * engine can apply: a candidate with a query whose acceptance drops no other member
 * ({@link candidateReplacesAll}), and `captureRef` only for a reference the query resolves by
 * itself (not failed, no member repaired by the geometric fallback: accept the proposal
 * instead).
 */
export function repairOps(loc: RefLocation): IrOp[] {
  const ops: IrOp[] = [];
  const e = loc.entry;
  if (e.proposal) ops.push({ op: "acceptRefProposal", feature: loc.featureId, field: loc.field });
  for (const u of e.unresolved ?? []) {
    u.candidates.forEach((c, i) => {
      if (!c.query || !candidateReplacesAll(e, u, c)) return;
      const shared = u.candidates.filter((x) => x.key === c.key).length > 1;
      // The probe identifies the entity the caller saw, whatever the store does before applying
      // it (the write-back before a repair): an index alone could name another piece then.
      ops.push({
        op: "acceptRefCandidate",
        feature: loc.featureId,
        field: loc.field,
        member: u.key,
        candidate: c.key,
        ...(shared ? { candidateIndex: i } : {}),
        probe: c.probe,
      });
    });
  }
  const repaired = e.members.some((m) => m.status === "repaired");
  if (e.status !== "failed" && !repaired) ops.push({ op: "captureRef", feature: loc.featureId, field: loc.field });
  return ops;
}
