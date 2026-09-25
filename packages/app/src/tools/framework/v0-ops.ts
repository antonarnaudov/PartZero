/**
 * The shell's default {@link OpsPort} for today's document store (CadScript source over IR v0): it
 * applies a tool's ops as one undoable transaction **to the document as it is at OK time**, so an edit
 * made while the panel was open (undo, the code editor, an accepted agent proposal) is kept.
 *
 * How: wait for the compile of the current source, apply the ops to its IR (`applyOpsV0`, pure; every
 * op is checked, and the result must pass the IR schema), splice the result into the CadScript source
 * (`applyIrEdit`, which keeps untouched statements and comments), then set the source through the
 * command layer (`doc.setSource`, one undo step). If the document changed while the splice ran, the
 * transaction is refused with `COMMAND_STALE` instead of overwriting that change: the check and the
 * write run in the same task (the command's `run` is synchronous up to the store write).
 *
 * The integrator replaces this port with the IR v1 store's transaction (C6) through `Shell.bindPorts`.
 */
import { IrDocumentSchema, type IrDocument } from "@aicad/ir-types";
import type { AppInvocation } from "../../commands/commands";
import type { CommandResult, CommandSource } from "../../commands/registry";
import { findFeature } from "../../doc/provenance";
import type { AppServices } from "../../services";
import type { CommitOutcome, OpsPort, ToolOp } from "./types";

/** A refused op: a `COMMAND_*` code and a message naming what was wrong. */
export class OpRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `/a/b~1c` → `["a", "b/c"]` (RFC 6901). */
export function parsePointer(path: string): string[] {
  if (!path.startsWith("/") || path === "/") throw new OpRefusal("COMMAND_BAD_PATH", `"${path}" is not a JSON pointer into the feature (like "/distance")`);
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => {
      if (s === "__proto__" || s === "constructor" || s === "prototype") throw new OpRefusal("COMMAND_BAD_PATH", `"${path}" names a reserved key`);
      return s;
    });
}

/** Fields that identify a feature: a tool never rewrites them with `setField`. */
const FIXED_FIELDS = new Set(["id", "type"]);

type Json = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Json {
  return typeof v === "object" && v !== null;
}

function setAt(root: Record<string, unknown>, segments: readonly string[], value: unknown, feature: string): void {
  let node: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next: unknown = Array.isArray(node) ? node[Number(seg)] : isContainer(node) ? (node as Record<string, unknown>)[seg] : undefined;
    if (!isContainer(next)) throw new OpRefusal("COMMAND_BAD_PATH", `${feature} has nothing at /${segments.slice(0, i + 1).join("/")}`);
    node = next;
  }
  const last = segments[segments.length - 1]!;
  if (Array.isArray(node)) {
    const i = Number(last);
    if (!/^\d+$/.test(last) || i >= node.length) throw new OpRefusal("COMMAND_BAD_PATH", `${feature}: index ${last} is outside /${segments.slice(0, -1).join("/")} (length ${node.length})`);
    node[i] = value;
  } else {
    (node as Record<string, unknown>)[last] = value;
  }
}

function allFeatureIds(ir: IrDocument): Set<string> {
  return new Set(ir.parts.flatMap((p) => p.features.map((f) => f.id)));
}

function allFeatureNames(ir: IrDocument): Set<string> {
  return new Set(ir.parts.flatMap((p) => p.features.map((f) => f.name)));
}

/** C9: the first free `<type><n>` (`fillet1`, `fillet2`, …). */
function nextFeatureId(ir: IrDocument, type: string): string {
  const taken = new Set([...allFeatureIds(ir), ...allFeatureNames(ir)]);
  for (let n = 1; ; n++) if (!taken.has(`${type}${n}`)) return `${type}${n}`;
}

function applyOne(ir: IrDocument, op: ToolOp): void {
  switch (op.op) {
    case "setField": {
      const loc = findFeature(ir, op.feature);
      if (!loc) throw new OpRefusal("COMMAND_UNKNOWN_FEATURE", `there is no feature ${op.feature}`);
      const segments = parsePointer(op.path);
      if (segments.length === 1 && FIXED_FIELDS.has(segments[0]!)) throw new OpRefusal("COMMAND_FIXED_FIELD", `a feature's ${segments[0]} can't be changed with setField`);
      if (isContainer(op.value) && !Array.isArray(op.value) && "expr" in op.value) {
        throw new OpRefusal("COMMAND_NO_EXPRESSIONS", "this document is IR v0, which has no parameters: expressions need an IR v1 document");
      }
      if (op.value === undefined) throw new OpRefusal("COMMAND_BAD_VALUE", "setField needs a value");
      setAt(loc.feature as unknown as Record<string, unknown>, segments, structuredClone(op.value), loc.feature.name);
      return;
    }
    case "setSuppressed": {
      const loc = findFeature(ir, op.feature);
      if (!loc) throw new OpRefusal("COMMAND_UNKNOWN_FEATURE", `there is no feature ${op.feature}`);
      if (op.suppressed) loc.feature.suppressed = true;
      else delete loc.feature.suppressed;
      return;
    }
    case "addFeature": {
      const part = ir.parts.find((p) => p.id === op.part) ?? ir.parts.find((p) => p.name === op.part);
      if (!part) throw new OpRefusal("COMMAND_UNKNOWN_PART", `there is no part ${op.part}`);
      let index = 0;
      if (op.after !== null) {
        const i = part.features.findIndex((f) => f.id === op.after);
        const j = i >= 0 ? i : part.features.findIndex((f) => f.name === op.after);
        if (j < 0) throw new OpRefusal("COMMAND_UNKNOWN_FEATURE", `part ${part.name} has no feature ${op.after}`);
        index = j + 1;
      }
      const feature = structuredClone(op.feature) as Record<string, unknown>;
      if (typeof feature["type"] !== "string") throw new OpRefusal("COMMAND_BAD_VALUE", "addFeature needs a feature with a type");
      const id = typeof feature["id"] === "string" ? feature["id"] : nextFeatureId(ir, feature["type"]);
      if (allFeatureIds(ir).has(id)) throw new OpRefusal("COMMAND_DUPLICATE_ID", `a feature with id ${id} already exists`);
      const name = typeof feature["name"] === "string" ? feature["name"] : id;
      if (allFeatureNames(ir).has(name)) throw new OpRefusal("COMMAND_DUPLICATE_NAME", `a feature named ${name} already exists`);
      part.features.splice(index, 0, { ...feature, id, name } as unknown as IrDocument["parts"][number]["features"][number]);
      return;
    }
    default: {
      const unknownOp = (op as { op?: unknown }).op;
      throw new OpRefusal("COMMAND_NOT_IMPLEMENTED", `the op ${String(unknownOp)} is not available on this document yet`);
    }
  }
}

/**
 * Apply ops to a copy of `ir`, in order; throws {@link OpRefusal} on the first refused op, or when the
 * result isn't a valid IR document. Pure: `ir` is not changed.
 */
export function applyOpsV0(ir: IrDocument, ops: readonly ToolOp[]): IrDocument {
  const next = structuredClone(ir);
  ops.forEach((op, i) => {
    try {
      applyOne(next, op);
    } catch (e) {
      if (e instanceof OpRefusal && ops.length > 1) throw new OpRefusal(e.code, `op ${i + 1} (${op.op}): ${e.message}`);
      throw e;
    }
  });
  const parsed = IrDocumentSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `/${issue.path.map(String).join("/")}` : "";
    throw new OpRefusal("COMMAND_SCHEMA", `the change would make an invalid document${issue ? ` (at ${where}: ${issue.message})` : ""}`);
  }
  return parsed.data;
}

type Run = (cmd: AppInvocation, source: CommandSource) => Promise<CommandResult<unknown>>;

function refuse(code: string, message: string): CommitOutcome {
  return { ok: false, errors: [{ code, message }] };
}

export function v0OpsPort(services: AppServices, run: Run): OpsPort {
  return {
    async apply(ops, { label, source }) {
      if (ops.length === 0) return { ok: true };
      const state = await services.doc.idle();
      const compiled = state.compile;
      if (!compiled?.ok || !compiled.ir) {
        const n = compiled?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
        return refuse("COMMAND_CODE_ERRORS", `The code has ${n} error${n === 1 ? "" : "s"}; fix ${n === 1 ? "it" : "them"} first.`);
      }
      let next: IrDocument;
      try {
        next = applyOpsV0(compiled.ir, ops);
      } catch (e) {
        if (e instanceof OpRefusal) return refuse(e.code, e.message);
        throw e;
      }
      const source0 = state.source;
      const revision0 = state.revision;
      const docId0 = state.docId;
      const spliced = await services.cadscript.applyIrEdit(source0, compiled.ir, next);
      const now = services.doc.getState();
      if (now.docId !== docId0 || now.revision !== revision0 || now.source !== source0) {
        return refuse("COMMAND_STALE", "The part changed while this change was being prepared; it was not applied.");
      }
      if (spliced === source0) return { ok: true };
      // `doc.setSource` writes synchronously within this call: nothing can change the document in between.
      const r = await run({ id: "doc.setSource", args: { source: spliced, label: label.slice(0, 200) } }, source);
      return r.ok ? { ok: true } : refuse("COMMAND_FAILED", r.error.message);
    },
  };
}
