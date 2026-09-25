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
 */
import type { AppCommandRegistry } from "../commands/commands";
import type { AnyCommandSpec } from "../commands/registry";
import type { AppServices } from "../services";
import { DocStoreAdapter } from "./adapter";
import { makeFileCommands } from "./commands";
import { DocumentFiles } from "./document-files";
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

export interface InstallOptions {
  host?: FileHost;
  autosaveDelayMs?: number;
}

export function installDocumentFiles(boot: { services: AppServices; commands: AppCommandRegistry }, options: InstallOptions = {}): DocumentFiles {
  const { services, commands } = boot;
  const host = options.host ?? createFileHost(services.host);
  const info = services.ui.getState().appInfo;
  const files = new DocumentFiles({
    adapter: new DocStoreAdapter(services.doc, services.cadscript),
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
  replaceCommands(commands, makeFileCommands(() => files) as unknown as Record<string, AnyCommandSpec<AppServices>>);
  current = files;
  void files.start().catch((e: unknown) => services.ui.toast("error", `Could not restore the window's documents: ${e instanceof Error ? e.message : String(e)}`));
  return files;
}
