/**
 * The viewport's command registry (`view.*`, `selection.*`, `measure.*`) until it merges into the
 * app registry (one spread line each in `commands/commands.ts`; see
 * docs/fm/view-sel-followups.md). It uses the same `CommandRegistry` class and the same
 * `AppServices` context, so the specs move unchanged. {@link routedExecute} sends an invocation to
 * whichever registry has its id (this one first: it extends `view.setView` to all seven views and
 * animates `view.fit`).
 */
import type { AppCommandRegistry } from "../commands/commands";
import { CommandRegistry, type CommandResult, type CommandSource } from "../commands/registry";
import { MEASURE_COMMANDS } from "../measure/commands";
import { SELECTION_COMMANDS } from "../selection/commands";
import type { AppServices } from "../services";
import { VIEW_COMMANDS } from "./commands";

export const VIEWPORT_COMMANDS = { ...VIEW_COMMANDS, ...SELECTION_COMMANDS, ...MEASURE_COMMANDS };
export type ViewportCommands = typeof VIEWPORT_COMMANDS;
export type ViewportCommandRegistry = CommandRegistry<ViewportCommands, AppServices>;

const registries = new WeakMap<AppServices, ViewportCommandRegistry>();

export function viewportCommands(app: AppServices): ViewportCommandRegistry {
  let r = registries.get(app);
  if (!r) {
    r = new CommandRegistry<ViewportCommands, AppServices>(VIEWPORT_COMMANDS, () => app);
    // Failures of user-initiated commands surface as toasts, as in the app registry.
    r.onDidExecute((rec) => {
      if (!rec.ok && rec.error && (rec.source === "ui" || rec.source === "keyboard" || rec.source === "menu" || rec.source === "palette")) {
        app.ui.toast("error", rec.error.message);
      }
    });
    registries.set(app, r);
  }
  return r;
}

/** Execute on the viewport registry when it has the id, else on the app registry. */
export function routedExecute(app: AppServices, appCommands: AppCommandRegistry, cmd: unknown, source: CommandSource): Promise<CommandResult<unknown>> {
  const vr = viewportCommands(app);
  const id = typeof cmd === "object" && cmd !== null ? (cmd as { id?: unknown }).id : undefined;
  if (typeof id === "string" && vr.has(id)) return vr.executeUnknown(cmd, { source });
  return appCommands.executeUnknown(cmd, { source });
}
