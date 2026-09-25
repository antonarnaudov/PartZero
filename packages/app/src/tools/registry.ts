/**
 * The tool registry: every toolbar tool, by group. Workstreams and the integrator add tools with
 * `registerTool(def)` (one line per tool, plan §3.3 "registration points"); the toolbar, the command
 * palette, the keyboard and `tool.start` all read from here.
 */
import { normalizeKey } from "../commands/registry";
import { Store } from "../store";
import { TOOL_GROUPS, type ShellMode, type ToolDefinition, type ToolGroupId } from "./framework/types";

const ID = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const GROUPS = new Set<ToolGroupId>(TOOL_GROUPS.map((g) => g.id));

export interface ToolRegistryState {
  /** Every registered tool, sorted by group order, then `order`, then label. */
  tools: readonly ToolDefinition[];
  /** Registration problems (duplicate shortcut, …); shown in the shortcuts map and logged. */
  warnings: readonly string[];
}

export class ToolRegistryError extends Error {}

function modesOf(t: ToolDefinition): readonly ShellMode[] {
  return t.modes ?? ["model"];
}

function sortTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const groupIndex = new Map(TOOL_GROUPS.map((g, i) => [g.id, i]));
  return [...tools].sort(
    (a, b) => groupIndex.get(a.group)! - groupIndex.get(b.group)! || (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}

export class ToolRegistry extends Store<ToolRegistryState> {
  /** Keys bound by app commands (they win over tool shortcuts). */
  private reservedKeys: ReadonlyMap<string, string> = new Map();

  constructor() {
    super({ tools: [], warnings: [] });
  }

  /** Tell the registry which keys app commands already own (checked on every registration). */
  reserveKeys(keys: ReadonlyMap<string, string>): void {
    this.reservedKeys = keys;
    this.setState((s) => ({ warnings: this.computeWarnings(s.tools) }));
  }

  /**
   * Add a tool. Throws {@link ToolRegistryError} for a malformed definition or a duplicate id.
   * Returns a function that removes it again.
   */
  register(def: ToolDefinition): () => void {
    if (!ID.test(def.id)) throw new ToolRegistryError(`tool id "${def.id}" must look like "area.name" (lower camel case segments)`);
    if (!def.label.trim()) throw new ToolRegistryError(`tool ${def.id} needs a label`);
    if (!GROUPS.has(def.group)) throw new ToolRegistryError(`tool ${def.id}: unknown group "${def.group}" (one of ${[...GROUPS].join(", ")})`);
    if (typeof def.activate !== "function") throw new ToolRegistryError(`tool ${def.id} needs an activate() function`);
    if (def.shortcut !== undefined && !/^((Mod|Ctrl|Alt|Shift)\+)*[^+\s]+$/i.test(def.shortcut)) {
      throw new ToolRegistryError(`tool ${def.id}: shortcut "${def.shortcut}" is not like "E", "Shift+F" or "Mod+Shift+H"`);
    }
    if (this.getState().tools.some((t) => t.id === def.id)) throw new ToolRegistryError(`a tool with id ${def.id} is already registered`);
    this.setState((s) => {
      const tools = sortTools([...s.tools, def]);
      return { tools, warnings: this.computeWarnings(tools) };
    });
    return () => this.unregister(def.id);
  }

  unregister(id: string): void {
    this.setState((s) => {
      const tools = s.tools.filter((t) => t.id !== id);
      return tools.length === s.tools.length ? {} : { tools, warnings: this.computeWarnings(tools) };
    });
  }

  get(id: string): ToolDefinition | undefined {
    return this.getState().tools.find((t) => t.id === id);
  }

  list(): readonly ToolDefinition[] {
    return this.getState().tools;
  }

  /** The tools of a group, in toolbar order (all modes). */
  byGroup(group: ToolGroupId): ToolDefinition[] {
    return this.getState().tools.filter((t) => t.group === group);
  }

  /** Normalized key → tool id, for the tools offered in `mode` (app command keys excluded). */
  keymap(mode: ShellMode): Map<string, string> {
    const m = new Map<string, string>();
    for (const t of this.getState().tools) {
      if (!t.shortcut || !modesOf(t).includes(mode)) continue;
      const k = normalizeKey(t.shortcut);
      if (this.reservedKeys.has(k) || m.has(k)) continue;
      m.set(k, t.id);
    }
    return m;
  }

  private computeWarnings(tools: readonly ToolDefinition[]): string[] {
    const out: string[] = [];
    const seen = new Map<string, string>();
    for (const t of tools) {
      if (!t.shortcut) continue;
      const k = normalizeKey(t.shortcut);
      const cmd = this.reservedKeys.get(k);
      if (cmd) {
        out.push(`${t.label} (${t.id}): ${t.shortcut} is already the app command ${cmd}; the command keeps it`);
        continue;
      }
      for (const mode of modesOf(t)) {
        const key = `${mode}:${k}`;
        const other = seen.get(key);
        if (other) out.push(`${t.label} (${t.id}): ${t.shortcut} is already ${other} in ${mode} mode; ${other} keeps it`);
        else seen.set(key, t.id);
      }
    }
    return out;
  }
}
