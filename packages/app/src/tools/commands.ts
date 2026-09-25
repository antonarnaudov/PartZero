/**
 * The shell's commands (plan C3: `tool.start {id,args}`, `tool.commit`, `tool.cancel`, `feature.edit`;
 * plus the welcome screen and the shortcuts map). They have the same shape as the app's `COMMANDS` so the integrator can
 * spread them into `commands/commands.ts` (one line); until then the shell runs them from a second
 * registry that the palette and the keyboard also read (`createShellCommandRegistry`).
 */
import { z } from "zod";
import { CommandRegistry, defineCommand, type Invocation } from "../commands/registry";
import type { AppServices } from "../services";
import { shellOf } from "./shell";

const command = defineCommand<AppServices>();
const NoArgs = z.strictObject({});

export const SHELL_COMMANDS = {
  "tool.start": command({
    id: "tool.start",
    title: "Start Tool",
    category: "Model",
    description:
      "Start a toolbar tool by id (e.g. `inspect.bodyProperties`); it opens its property panel. `args` prefill the panel's inputs by field key (numbers as text or numbers: `{ \"r\": \"2 mm\" }`). `tool.list` lists the ids. Replaces an open tool panel.",
    args: z.strictObject({ id: z.string().min(1).max(100), args: z.record(z.string().max(100), z.unknown()).optional() }),
    palette: false,
    async run({ id, args }, ctx, meta) {
      const r = await shellOf(ctx).startTool(id, meta.source, args ?? {});
      if (!r.started) throw new Error(r.reason ?? `could not start ${id}`);
      return { started: true, panel: r.panel };
    },
  }),

  "feature.edit": command({
    id: "feature.edit",
    title: "Edit Feature",
    category: "Model",
    description: "Re-edit a feature (by id or name) in the property panel of the tool that makes it, prefilled from the feature. OK changes that feature as one undoable transaction.",
    args: z.strictObject({ feature: z.string().min(1).max(200) }),
    palette: false,
    async run({ feature }, ctx, meta) {
      const r = await shellOf(ctx).editFeature(feature, meta.source);
      if (!r.started) throw new Error(r.reason ?? `could not edit ${feature}`);
      return { started: true, panel: r.panel, tool: r.tool ?? null };
    },
  }),

  "tool.list": command({
    id: "tool.list",
    title: "List Tools",
    category: "Model",
    description: "Every toolbar tool: id, label, group, shortcut, and whether it can start now (with the reason when not).",
    args: NoArgs,
    palette: false,
    run(_args, ctx) {
      const shell = shellOf(ctx);
      return {
        tools: shell.tools.list().map((t) => {
          const en = shell.enablement(t);
          return { id: t.id, label: t.label, group: t.group, shortcut: t.shortcut ?? null, enabled: en === true, ...(en === true ? {} : { reason: en.reason }) };
        }),
      };
    },
  }),

  "tool.commit": command({
    id: "tool.commit",
    title: "OK (Commit Tool)",
    category: "Model",
    description: "Press OK on the open tool panel: commit its change as one undoable transaction.",
    args: NoArgs,
    palette: false,
    enabled: (ctx) => shellOf(ctx).getState().panel !== null,
    async run(_args, ctx, meta) {
      const r = await shellOf(ctx).commitPanel(meta.source);
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
  }),

  "tool.cancel": command({
    id: "tool.cancel",
    title: "Cancel Tool",
    category: "Model",
    description: "Close the open tool panel without changing the document.",
    args: NoArgs,
    palette: false,
    enabled: (ctx) => shellOf(ctx).getState().panel !== null,
    run(_args, ctx) {
      return { cancelled: shellOf(ctx).cancelPanel() };
    },
  }),

  "tool.repeat": command({
    id: "tool.repeat",
    title: "Repeat Last Tool",
    category: "Model",
    args: NoArgs,
    keys: ["Space"],
    enabled: (ctx) => shellOf(ctx).getState().lastToolId !== null && shellOf(ctx).getState().panel === null,
    async run(_args, ctx) {
      const r = await shellOf(ctx).repeatLastTool();
      if (!r.started) throw new Error(r.reason ?? "no tool to repeat");
      return { started: true };
    },
  }),

  "help.welcome": command({
    id: "help.welcome",
    title: "Welcome",
    category: "Help",
    description: "Show the start screen: new, open, recent documents, the starter parts, and the agent and printer status.",
    args: NoArgs,
    run(_args, ctx) {
      shellOf(ctx).showWelcome();
      return { open: true };
    },
  }),

  "help.shortcuts": command({
    id: "help.shortcuts",
    title: "Keyboard Shortcuts",
    category: "Help",
    description: "Show every keyboard shortcut: commands, tools by group, panel keys.",
    args: NoArgs,
    keys: ["Shift+?"],
    run(_args, ctx) {
      const shell = shellOf(ctx);
      shell.openDialog(shell.getState().dialog === "shortcuts" ? null : "shortcuts");
      return { open: shell.getState().dialog === "shortcuts" };
    },
  }),
};

export type ShellCommands = typeof SHELL_COMMANDS;
export type ShellInvocation = Invocation<ShellCommands>;
export type ShellCommandRegistry = CommandRegistry<ShellCommands, AppServices>;

export function createShellCommandRegistry(services: () => AppServices): ShellCommandRegistry {
  return new CommandRegistry<ShellCommands, AppServices>(SHELL_COMMANDS, services);
}
