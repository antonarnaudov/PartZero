/**
 * Command palette (⌘K / ⌘⇧P): fuzzy search over every command and its fixed-argument variants,
 * straight from the command registry — so it lists exactly what the agent can call.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { formatKey, type PaletteItem } from "../commands/registry";
import { useApp } from "./context";

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

export function CommandPalette(): ReactElement {
  const { commands, run, isMac, services } = useApp();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => commands.paletteItems(), [commands]);

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
  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return;
    close();
    void commands.executeUnknown({ id: item.id, args: item.args }, { source: "palette" });
  };

  return (
    <div className="overlay" onMouseDown={close} data-testid="command-palette">
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
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
          {results.length === 0 && <div className="empty">No matching commands</div>}
          {results.map((item, i) => {
            const enabled = commands.isEnabled(item.id);
            return (
              <div
                key={item.key}
                role="option"
                aria-selected={i === index}
                aria-disabled={!enabled}
                className={`pal-item${i === index ? " active" : ""}${enabled ? "" : " disabled"}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(item)}
              >
                <span className="pal-cat">{item.category}</span>
                <span className="pal-title">{item.title}</span>
                <span className="pal-id">{item.id}</span>
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
