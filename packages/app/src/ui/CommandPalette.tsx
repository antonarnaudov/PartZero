/**
 * Command palette (⌘K / ⌘⇧P, FD9): fuzzy search over every command and its fixed-argument variants
 * (straight from the command registries, so it lists exactly what the agent can call) and every
 * toolbar tool (from the tool registry).
 */
import { useContext, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { formatKey } from "../commands/registry";
import { TOOL_GROUPS } from "../tools/framework/types";
import { useApp } from "./context";
import { ShellContext } from "./shell/context";
import { ToolIcon } from "./shell/tool-icons";

/** Subsequence fuzzy score (higher is better), or -1 when `q` does not match. */
export function fuzzyScore(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  const direct = t.indexOf(query);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - query.length) * 0.1;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of query) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

/** Display titles that differ from a command's registered title (the app is PartZero). */
const TITLE_OVERRIDES: Record<string, string> = { "help.about": "About PartZero" };

interface Item {
  key: string;
  /** Command id, or `tool.start` for tools. */
  id: string;
  title: string;
  category: string;
  keys: readonly string[];
  args: unknown;
  enabled: () => boolean;
  /** Why a tool is disabled. */
  reason?: () => string | null;
  icon?: string;
}

export function CommandPalette(): ReactElement {
  const { commands, isMac, services } = useApp();
  const shellCtx = useContext(ShellContext);
  const shell = shellCtx?.shell ?? null;
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo((): Item[] => {
    const out: Item[] = [];
    const paletteItems = shell ? shell.paletteItems() : commands.paletteItems();
    for (const p of paletteItems) {
      out.push({
        key: p.key,
        id: p.id,
        title: TITLE_OVERRIDES[p.key] ?? p.title,
        category: p.category,
        keys: p.keys,
        args: p.args,
        enabled: () => (shell ? shell.isCommandEnabled(p.id) : commands.isEnabled(p.id)),
      });
    }
    if (shell) {
      const groupLabel = new Map(TOOL_GROUPS.map((g) => [g.id, g.label]));
      for (const t of shell.tools.list()) {
        out.push({
          key: `tool:${t.id}`,
          id: "tool.start",
          title: t.label,
          category: groupLabel.get(t.group) ?? "Tool",
          keys: t.shortcut ? [t.shortcut] : [],
          args: { id: t.id },
          enabled: () => shell.enablement(t) === true,
          reason: () => {
            const en = shell.enablement(t);
            return en === true ? null : en.reason;
          },
          icon: t.icon,
        });
      }
    }
    return out;
  }, [commands, shell]);

  const results = useMemo(() => {
    return items
      .map((item) => ({ item, score: Math.max(fuzzyScore(query, item.title), fuzzyScore(query, `${item.category} ${item.title}`) - 5) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
      .map((r) => r.item);
  }, [items, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".pal-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const close = (): void => services.ui.closeDialog();
  const choose = (item: Item | undefined): void => {
    if (!item) return;
    close();
    if (shell) void shell.execute({ id: item.id, args: item.args }, "palette");
    else void commands.executeUnknown({ id: item.id, args: item.args }, { source: "palette" });
  };

  return (
    <div className="overlay" onMouseDown={close} data-testid="command-palette">
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command or a tool…"
          value={query}
          aria-label="Command"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[index]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="empty">No matching commands or tools</div>}
          {results.map((item, i) => {
            const enabled = item.enabled();
            const reason = !enabled ? (item.reason?.() ?? null) : null;
            return (
              <div
                key={item.key}
                role="option"
                aria-selected={i === index}
                aria-disabled={!enabled}
                title={reason ?? undefined}
                data-key={item.key}
                className={`pal-item${i === index ? " active" : ""}${enabled ? "" : " disabled"}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(item)}
              >
                <span className="pal-cat">{item.category}</span>
                <span className="pal-title">
                  {item.icon && <ToolIcon name={item.icon} size={13} />}
                  {item.title}
                </span>
                <span className="pal-id">{item.key.startsWith("tool:") ? item.key.slice(5) : item.id}</span>
                {item.keys[0] && <kbd>{formatKey(item.keys[0], isMac)}</kbd>}
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span className="spacer" />
          <span className="muted">Same commands the agent and MCP use</span>
        </div>
      </div>
    </div>
  );
}
