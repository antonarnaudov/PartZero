/**
 * The starter parts (docs/ALPHA-0-PLAN.md §2.4), bundled from `corpus/gallery/`: the welcome
 * screen's prompt chips, and the ready-made example documents for the starters Forge can already
 * build with committed features.
 *
 * An example opens only when the running document store can compile it: examples are IR v1
 * CadScript, compiled into an IR v1 model (the app's document model). Nothing is opened
 * half-compiled.
 */
import { z } from "zod";
import type { AppServices } from "../services";

const StarterSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  blurb: z.string().min(1),
  prompt: z.string().min(1),
  example: z.string().nullable(),
  exampleNote: z.string().optional(),
  needs: z.string().optional(),
});

const FileSchema = z.object({ starters: z.array(StarterSchema).length(5) });

export interface Starter {
  id: string;
  title: string;
  blurb: string;
  /** The prompt the chip sends to the design agent (verbatim from the plan). */
  prompt: string;
  /** The ready-made example's CadScript, or null. */
  source: string | null;
  exampleNote: string | null;
  /** Why there is no example yet. */
  needs: string | null;
}

const indexFiles = import.meta.glob("../../../../corpus/gallery/starters.json", { eager: true, import: "default" });
const sources = import.meta.glob("../../../../corpus/gallery/*.cad.ts", { eager: true, query: "?raw", import: "default" });

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function loadStarters(): Starter[] {
  const raw = Object.values(indexFiles)[0];
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) return [];
  const byFile = new Map<string, string>();
  for (const [path, text] of Object.entries(sources)) if (typeof text === "string") byFile.set(fileName(path), text);
  return parsed.data.starters.map((s) => ({
    id: s.id,
    title: s.title,
    blurb: s.blurb,
    prompt: s.prompt,
    source: s.example ? (byFile.get(s.example) ?? null) : null,
    exampleNote: s.exampleNote ?? null,
    needs: s.needs ?? (s.example && !byFile.has(s.example) ? `the example file ${s.example} is missing from this build` : null),
  }));
}

export const STARTERS: readonly Starter[] = loadStarters();

export type ExampleAvailability = { status: "checking" } | { status: "ready" } | { status: "unavailable"; reason: string };

const probes = new WeakMap<AppServices, Map<string, Promise<ExampleAvailability>>>();

/** Whether this app can open a starter's example (its document store compiles the source). Cached. */
export function exampleAvailability(services: AppServices, starter: Starter): Promise<ExampleAvailability> {
  if (!starter.source) return Promise.resolve({ status: "unavailable", reason: starter.needs ?? "no example yet" });
  let cache = probes.get(services);
  if (!cache) {
    cache = new Map();
    probes.set(services, cache);
  }
  const hit = cache.get(starter.id);
  if (hit) return hit;
  const source = starter.source;
  // IR v1 models (the app's document model) open CadScript v1 examples; a CadScript (IR v0) host only v0 ones.
  const p = (
    services.doc.v1Available
      ? services.cadscript.compileV1(source).then(async (v1): Promise<boolean> => v1.ok || (await services.cadscript.compile(source)).ok)
      : services.cadscript.compile(source).then((out) => out.ok && out.ir !== null)
  ).then(
    (ok): ExampleAvailability => (ok ? { status: "ready" } : { status: "unavailable", reason: "its code does not compile in this build" }),
    (e: unknown): ExampleAvailability => ({ status: "unavailable", reason: e instanceof Error ? e.message : String(e) }),
  );
  cache.set(starter.id, p);
  return p;
}

/**
 * Open a starter's example as a new, unsaved document (asks before discarding unsaved changes).
 * Resolves to whether it opened.
 */
export async function openExample(services: AppServices, starter: Starter): Promise<{ opened: boolean; reason?: string }> {
  const availability = await exampleAvailability(services, starter);
  if (availability.status !== "ready" || !starter.source) {
    return { opened: false, reason: availability.status === "unavailable" ? availability.reason : "still checking" };
  }
  const s = services.doc.getState();
  if (s.dirty && !(await services.confirm(`Discard unsaved changes to “${s.name}”?`))) return { opened: false, reason: "cancelled" };
  if (services.doc.v1Available) {
    const v1 = await services.cadscript.compileV1(starter.source);
    const text = v1.ok && v1.irJson ? v1.irJson : await services.cadscript.compile(starter.source).then((c) => (c.ok && c.ir ? JSON.stringify(c.ir) : null));
    if (text === null) return { opened: false, reason: "its code does not compile in this build" };
    services.doc.load({ path: null, name: starter.id, format: "ir-v1", source: text });
    const st = await services.doc.idle();
    if (st.engineError && st.model === null) return { opened: false, reason: st.engineError };
    return { opened: true };
  }
  services.doc.load({ path: null, name: starter.id, format: "cadscript", source: starter.source });
  return { opened: true };
}
