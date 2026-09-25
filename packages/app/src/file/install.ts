/**
 * Installs the document layer into a running app (called from `main.tsx`, right after `bootstrap()`).
 *
 * Until the integrator splits the command table (FULL-MODELING-PLAN §3.3: `commands/file.ts` + `commands/index.ts`)
 * and adds `files` to `AppServices`, this is the whole wiring:
 * 1. one {@link DocumentFiles} per window, over the current store ({@link DocStoreAdapter}) and host;
 * 2. the `file.*` commands of `makeFileCommands` replace the registry's old ones (menu, keyboard, palette, agent and
 *    the e2e automation all reach them, because they all go through the same registry);
 * 3. the instance is published for the UI (`documentFiles()`: FileLayer, the viewport's reference meshes).
 *
 * The integrator's version:
 * - services.ts: `files: DocumentFiles` in `AppServices`;
 * - bootstrap.ts: build it as below (with the v1 store's adapter once `services.ir` is the document), then
 *   `void files.start()` after the starter document is loaded;
 * - commands (`commands/file.ts` after the split): `...makeFileCommands((ctx) => ctx.files)`, and delete the old
 *   `file.*` entries from commands.ts;
 * - main.tsx: drop the `installDocumentFiles` call; FileLayer and `useReferenceBodies` read `services.files`.
 * Then {@link replaceCommands} and this module go away.
 *
 * MERGE GATE (Phase C): {@link DocStoreAdapter} saves only the IR v0 `services.doc`. When `services.ir` (the IR v1
 * store) exists, its edits must be saved by an `IrDocumentAdapter` (pass it as `adapter`, with `protects: ["ir"]`) or
 * guarded by an {@link UnsavedContentSource} that reports its real unsaved state (`contentSources`, with
 * `protects: ["ir"]`). Until one of them is wired, this module registers a fail-closed guard (see
 * {@link failClosedSource}) so v1 edits are never lost silently, and the test "every document store in AppServices
 * is saved or guarded" fails.
 *
 * Wired: IR v1 is the document model. {@link DocStoreAdapter} saves `services.ir` whenever the window's document is
 * an IR v1 model (`services.doc` mirrors the store; `.partzero` holds the v1 document). main.tsx still passes
 * {@link documentStoreGuards}: its {@link UnsavedContentSource} over `services.ir` ({@link irStoreContentSource})
 * reports unsaved content only on hosts without the IR v1 engine (a CadScript document) whose v1 store was loaded or
 * edited through `ir.*` commands, which no file would hold. It replaced the stopgap when v1 became the
 * document of record.
 */
import type { AppCommandRegistry } from "../commands/commands";
import type { AnyCommandSpec } from "../commands/registry";
import type { IrDocState } from "../doc/v1/ir-doc-store";
import type { AppServices } from "../services";
import { DocStoreAdapter, type DocumentAdapter } from "./adapter";
import { makeFileCommands } from "./commands";
import { DocumentFiles, type UnsavedContentSource } from "./document-files";
import { createFileHost, type FileHost } from "./host";

let current: DocumentFiles | null = null;

/** This window's document layer (null before `installDocumentFiles`). */
export function documentFiles(): DocumentFiles | null {
  return current;
}

/**
 * Put `specs` into the registry's command table, replacing commands with the same id and adding the others. The
 * table object is copied, never mutated, so the shared `COMMANDS` constant stays as it is.
 */
export function replaceCommands(registry: AppCommandRegistry, specs: Record<string, AnyCommandSpec<AppServices>>): void {
  const table: unknown = Reflect.get(registry, "specs");
  if (!table || typeof table !== "object") throw new Error("the command registry has no command table (registry.ts changed?)");
  for (const [key, spec] of Object.entries(specs)) if (key !== spec.id) throw new Error(`command key ${key} does not match its id ${spec.id}`);
  Reflect.set(registry, "specs", { ...(table as Record<string, AnyCommandSpec<AppServices>>), ...specs });
}

/** `AppServices` members that hold document content besides `doc`, with the label used in messages. */
export const OTHER_DOCUMENT_STORES: Readonly<Record<string, string>> = { ir: "IR v1 model" };

/** Members of `services` that hold document content (see {@link OTHER_DOCUMENT_STORES}) and are not in `protects`. */
export function unprotectedDocumentStores(services: object, protects: readonly string[]): string[] {
  return Object.keys(OTHER_DOCUMENT_STORES).filter((key) => Reflect.get(services, key) !== undefined && !protects.includes(key));
}

/**
 * The stopgap guard for a document store nothing saves: it counts as holding unsaved content from its first change
 * notification after install (or always, when it offers no `subscribe`). It cannot tell a content edit from any other
 * notification, so it may refuse saves more often than needed; that is the point: loudly, never silently.
 */
export function failClosedSource(label: string, store: unknown): UnsavedContentSource {
  const subscribeFn: unknown = store !== null && typeof store === "object" ? Reflect.get(store, "subscribe") : undefined;
  if (typeof subscribeFn !== "function") return { label, hasUnsavedContent: () => true, subscribe: () => () => undefined };
  let changed = false;
  const listeners = new Set<() => void>();
  const unsubscribe: unknown = Reflect.apply(subscribeFn, store, [
    () => {
      changed = true;
      for (const l of [...listeners]) l();
    },
  ]);
  return {
    label,
    hasUnsavedContent: () => changed,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof unsubscribe === "function") (unsubscribe as () => void)();
      };
    },
  };
}

/**
 * The unsaved-content source for the IR v1 store until its adapter lands: nothing writes the v1 document into a file,
 * so it holds unsaved content whenever it holds a document that changed after `ir` was handed to the document layer
 * (loaded or edited through the `ir.*` commands, a tool or the agent). Listeners hear only when that answer changes,
 * never on the store's other notifications (`busy`, history).
 */
export function irStoreContentSource(
  ir: { getState(): Pick<IrDocState, "document" | "revision">; subscribe(listener: () => void): () => void },
  label: string = OTHER_DOCUMENT_STORES["ir"] ?? "IR v1 model",
  doc?: { getState(): { format: string }; subscribe(listener: () => void): () => void },
): UnsavedContentSource {
  // While the window's document is an IR v1 model, the IR store IS the document: the adapter saves it.
  let base = ir.getState().revision;
  const unsaved = (): boolean => {
    const s = ir.getState();
    if (doc?.getState().format === "ir-v1") {
      base = s.revision;
      return false;
    }
    return s.document !== null && s.revision !== base;
  };
  return {
    label,
    hasUnsavedContent: unsaved,
    subscribe(listener) {
      let last = unsaved();
      return ir.subscribe(() => {
        const now = unsaved();
        if (now === last) return;
        last = now;
        listener();
      });
    },
  };
}

/** The {@link installDocumentFiles} options that save or guard every document store in `services` besides `doc`. */
export function documentStoreGuards(services: AppServices): Pick<InstallOptions, "protects" | "contentSources"> {
  return services.ir ? { protects: ["ir"], contentSources: [irStoreContentSource(services.ir, undefined, services.doc)] } : {};
}

export interface InstallOptions {
  host?: FileHost;
  autosaveDelayMs?: number;
  /** The adapter over the window's document (default: {@link DocStoreAdapter} over `services.doc`, IR v0). */
  adapter?: DocumentAdapter;
  /** Keys of {@link OTHER_DOCUMENT_STORES} that `adapter` saves or `contentSources` guard. */
  protects?: readonly string[];
  /** Guards for content the adapter does not save (see {@link UnsavedContentSource}). */
  contentSources?: readonly UnsavedContentSource[];
}

export function installDocumentFiles(boot: { services: AppServices; commands: AppCommandRegistry }, options: InstallOptions = {}): DocumentFiles {
  const { services, commands } = boot;
  const host = options.host ?? createFileHost(services.host);
  const info = services.ui.getState().appInfo;
  const files = new DocumentFiles({
    adapter: options.adapter ?? new DocStoreAdapter(services.doc, services.cadscript),
    host,
    toast: (kind, text) => services.ui.toast(kind, text),
    confirm: (text) => services.confirm(text),
    setDocumentState: (state) => services.host.setDocumentState(state),
    engine: () => services.engines.active,
    runCommand: (c) => commands.executeUnknown({ id: c.id, args: c.args ?? {} }, { source: "menu" }),
    generator: { app: info?.name ?? "PartZero", version: info?.version ?? "0.0.0" },
    fitView: () => services.viewport.fitView(),
    ...(options.autosaveDelayMs !== undefined ? { autosaveDelayMs: options.autosaveDelayMs } : {}),
  });
  for (const source of options.contentSources ?? []) files.registerContentSource(source);
  for (const key of unprotectedDocumentStores(services, options.protects ?? [])) {
    const label = OTHER_DOCUMENT_STORES[key] ?? key;
    console.error(`[files] services.${key} (${label}) is neither saved nor guarded by the document layer: saves refuse once it changes. See file/install.ts.`);
    files.registerContentSource(failClosedSource(label, Reflect.get(services, key)));
  }
  replaceCommands(commands, makeFileCommands(() => files) as unknown as Record<string, AnyCommandSpec<AppServices>>);
  current = files;
  void files.start().catch((e: unknown) => services.ui.toast("error", `Could not restore the window's documents: ${e instanceof Error ? e.message : String(e)}`));
  return files;
}
