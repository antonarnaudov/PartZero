/**
 * The command registry: the seed of the "one command API" (ARCHITECTURE §2) that the UI, the
 * native menu, keyboard shortcuts, the in-app agent and the MCP server all go through.
 *
 * - A command is a {@link CommandSpec}: an id, metadata, a **zod schema for its arguments** and a
 *   `run` function. Arguments are validated on every call, whoever the caller is.
 * - {@link CommandRegistry.execute} is the single entry point. It never throws: it returns a
 *   {@link CommandResult} with a machine-readable error code, like the agent tools do.
 * - {@link CommandRegistry.describe} exports every command with a JSON Schema of its arguments —
 *   the same shape agent tool definitions and MCP tools are generated from.
 */
import { z } from "zod";

export type CommandCategory = "File" | "Edit" | "Selection" | "View" | "Model" | "Engine" | "Chat" | "Help";

/** Who issued a command (for logs, permissions later, and the agent's "who changed what"). */
export type CommandSource = "ui" | "keyboard" | "menu" | "palette" | "agent" | "mcp" | "test" | "api";

export interface PaletteEntry<A> {
  title: string;
  args: A;
}

export interface CommandSpec<S extends z.ZodType, R, C> {
  id: string;
  title: string;
  category: CommandCategory;
  description?: string;
  args: S;
  /** Keybindings like `Mod+S`, `Mod+Shift+Z`, `F` (`Mod` = ⌘ on macOS, Ctrl elsewhere). */
  keys?: readonly string[];
  /**
   * Command palette entries. `true` (default for arg-less commands) lists the command itself;
   * an array lists fixed-argument variants (e.g. "View: Top"); `false` hides it.
   */
  palette?: boolean | ReadonlyArray<PaletteEntry<z.input<S>>>;
  /** Whether the command can run now (disabled commands return `DISABLED`). */
  enabled?: (ctx: C) => boolean;
  run(args: z.output<S>, ctx: C, meta: ExecuteMeta): R | Promise<R>;
}

export type AnyCommandSpec<C> = CommandSpec<z.ZodType, unknown, C>;

export type CommandErrorCode = "UNKNOWN_COMMAND" | "INVALID_ARGS" | "DISABLED" | "FAILED";

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  /** For INVALID_ARGS: one entry per invalid argument. */
  issues?: Array<{ path: string; message: string }>;
}

export type CommandResult<R> = { ok: true; value: R } | { ok: false; error: CommandError };

export interface ExecuteMeta {
  source: CommandSource;
}

export interface CommandInfo {
  id: string;
  title: string;
  category: CommandCategory;
  description?: string;
  keys: readonly string[];
  /** JSON Schema (draft 2020-12) of the arguments object. */
  argsSchema: unknown;
}

export interface ExecutionRecord {
  id: string;
  args: unknown;
  source: CommandSource;
  ok: boolean;
  error?: CommandError;
  ms: number;
}

export interface PaletteItem {
  key: string;
  id: string;
  title: string;
  category: CommandCategory;
  args: unknown;
  keys: readonly string[];
}

/** Identity helper that keeps the literal id and infers args/result types. */
export function defineCommand<C>() {
  return <const Id extends string, S extends z.ZodType, R>(spec: CommandSpec<S, R, C> & { id: Id }): CommandSpec<S, R, C> & { id: Id } =>
    spec;
}

type SpecMap<C> = Record<string, AnyCommandSpec<C>>;

export type CommandIdOf<M> = Extract<keyof M, string>;
export type ArgsOf<M, K extends keyof M> = M[K] extends CommandSpec<infer S, unknown, infer _C> ? z.input<S> : never;
export type ResultOf<M, K extends keyof M> = M[K] extends CommandSpec<z.ZodType, infer R, infer _C> ? Awaited<R> : never;

/** A command invocation: `{ id, args }` — what menus, the agent and MCP send. */
export type Invocation<M> = { [K in CommandIdOf<M>]: { id: K; args?: ArgsOf<M, K> } }[CommandIdOf<M>];

export class CommandRegistry<M extends SpecMap<C>, C> {
  private readonly specs: M;
  private readonly context: () => C;
  private readonly listeners = new Set<(r: ExecutionRecord) => void>();

  constructor(specs: M, context: () => C) {
    for (const [key, spec] of Object.entries(specs)) {
      if (key !== spec.id) throw new Error(`command key ${key} does not match its id ${spec.id}`);
    }
    this.specs = specs;
    this.context = context;
  }

  has(id: string): id is CommandIdOf<M> {
    return Object.prototype.hasOwnProperty.call(this.specs, id);
  }

  get(id: string): AnyCommandSpec<C> | undefined {
    return this.has(id) ? this.specs[id] : undefined;
  }

  /** Typed entry point. */
  execute<K extends CommandIdOf<M>>(
    cmd: { id: K; args?: ArgsOf<M, K> },
    meta: ExecuteMeta = { source: "api" },
  ): Promise<CommandResult<ResultOf<M, K>>> {
    return this.executeUnknown(cmd, meta) as Promise<CommandResult<ResultOf<M, K>>>;
  }

  /** Untyped entry point for menus, IPC, the agent and MCP: the id and args are validated here. */
  async executeUnknown(cmd: unknown, meta: ExecuteMeta = { source: "api" }): Promise<CommandResult<unknown>> {
    const t0 = Date.now();
    const shape = z.object({ id: z.string(), args: z.unknown().optional() }).safeParse(cmd);
    if (!shape.success) {
      return this.finish({ id: "?", args: cmd, source: meta.source }, t0, {
        ok: false,
        error: { code: "INVALID_ARGS", message: "a command is { id: string, args?: object }" },
      });
    }
    const { id, args } = shape.data;
    const spec = this.get(id);
    if (!spec) {
      return this.finish({ id, args, source: meta.source }, t0, {
        ok: false,
        error: { code: "UNKNOWN_COMMAND", message: `unknown command: ${id}` },
      });
    }
    const parsed = spec.args.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
      return this.finish({ id, args, source: meta.source }, t0, {
        ok: false,
        error: {
          code: "INVALID_ARGS",
          message: `invalid arguments for ${id}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`,
          issues,
        },
      });
    }
    const ctx = this.context();
    if (spec.enabled && !spec.enabled(ctx)) {
      return this.finish({ id, args, source: meta.source }, t0, {
        ok: false,
        error: { code: "DISABLED", message: `${spec.title} is not available right now` },
      });
    }
    try {
      const value = await spec.run(parsed.data, ctx, meta);
      return this.finish({ id, args, source: meta.source }, t0, { ok: true, value });
    } catch (e) {
      return this.finish({ id, args, source: meta.source }, t0, {
        ok: false,
        error: { code: "FAILED", message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  isEnabled(id: string): boolean {
    const spec = this.get(id);
    return !!spec && (!spec.enabled || spec.enabled(this.context()));
  }

  /** Every command with its argument JSON Schema (for agent tool definitions and MCP). */
  describe(): CommandInfo[] {
    return Object.values(this.specs).map((s) => ({
      id: s.id,
      title: s.title,
      category: s.category,
      ...(s.description ? { description: s.description } : {}),
      keys: s.keys ?? [],
      argsSchema: z.toJSONSchema(s.args, { io: "input", unrepresentable: "any" }),
    }));
  }

  /** Command palette items (commands and their fixed-argument variants). */
  paletteItems(): PaletteItem[] {
    const items: PaletteItem[] = [];
    for (const s of Object.values(this.specs)) {
      const p = s.palette ?? isArgless(s.args);
      if (p === false) continue;
      if (p === true) {
        items.push({ key: s.id, id: s.id, title: s.title, category: s.category, args: {}, keys: s.keys ?? [] });
      } else {
        p.forEach((entry, i) =>
          items.push({ key: `${s.id}#${i}`, id: s.id, title: entry.title, category: s.category, args: entry.args, keys: i === 0 ? (s.keys ?? []) : [] }),
        );
      }
    }
    return items;
  }

  /** Keybinding → command (first registration wins). */
  keymap(): Map<string, string> {
    const m = new Map<string, string>();
    for (const s of Object.values(this.specs)) for (const k of s.keys ?? []) if (!m.has(normalizeKey(k))) m.set(normalizeKey(k), s.id);
    return m;
  }

  onDidExecute(listener: (r: ExecutionRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private finish<R>(base: Omit<ExecutionRecord, "ok" | "ms" | "error">, t0: number, result: CommandResult<R>): CommandResult<R> {
    const record: ExecutionRecord = { ...base, ok: result.ok, ms: Date.now() - t0, ...(result.ok ? {} : { error: result.error }) };
    for (const l of [...this.listeners]) l(record);
    return result;
  }
}

/** Whether a schema accepts `{}` (i.e. the command needs no arguments). */
function isArgless(schema: z.ZodType): boolean {
  return schema.safeParse({}).success;
}

/** Canonical form of a keybinding: modifiers in fixed order, key lower-cased. */
export function normalizeKey(binding: string): string {
  const parts = binding.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const order = ["mod", "ctrl", "alt", "shift"].filter((m) => mods.has(m));
  return [...order, key.toLowerCase()].join("+");
}

/** The binding a keyboard event matches (`Mod` = ⌘ on macOS, Ctrl elsewhere). */
export function eventToKey(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, isMac: boolean): string {
  const mods: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) mods.push("mod");
  if (isMac && e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  // With Alt/Shift the produced character varies by layout; use the physical key for letters/digits.
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  return [...mods, key.toLowerCase()].join("+");
}

/** Display form of a keybinding, e.g. `⌘⇧Z` on macOS, `Ctrl+Shift+Z` elsewhere. */
export function formatKey(binding: string, isMac: boolean): string {
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  const label = key.length === 1 ? key.toUpperCase() : key;
  if (isMac) {
    const sym: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
    return parts.map((p) => sym[p.toLowerCase()] ?? p).join("") + label;
  }
  const word: Record<string, string> = { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
  return [...parts.map((p) => word[p.toLowerCase()] ?? p), label].join("+");
}
