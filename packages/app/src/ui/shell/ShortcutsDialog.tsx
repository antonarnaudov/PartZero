/**
 * The keyboard-shortcuts map (`?`): every command key from the command registries, every tool
 * shortcut by toolbar group, the panel keys and the viewport gestures. It is generated, so it can
 * never disagree with what the keys do.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { formatKey, type CommandInfo } from "../../commands/registry";
import { TOOL_GROUPS } from "../../tools/framework/types";
import { useApp } from "../context";
import { Icon } from "../icons";
import { useShell } from "./context";

interface Row {
  keys: string[];
  label: string;
  note?: string;
}

function Section({ title, rows, testId }: { title: string; rows: readonly Row[]; testId?: string }): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section className="sc-section" data-testid={testId}>
      <h3>{title}</h3>
      <dl>
        {rows.map((r) => (
          <div key={`${r.label}|${r.keys.join(",")}`} className="sc-row">
            <dt>
              {r.keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </dt>
            <dd>
              {r.label}
              {r.note && <span className="sc-note"> · {r.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutsDialog(): ReactElement {
  const { isMac } = useApp();
  const { shell, shortcutDocs } = useShell();
  const tools = useSyncExternalStore(shell.tools.subscribe, () => shell.tools.getState());
  const docs = useSyncExternalStore(shortcutDocs.subscribe, () => shortcutDocs.getState().sections);
  const [query, setQuery] = useState("");
  const close = (): void => shell.closeDialog();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        shell.closeDialog();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shell]);

  const commandSections = useMemo(() => {
    const byCategory = new Map<string, Row[]>();
    const seen = new Set<string>();
    for (const r of shell.registries) {
      for (const c of r.describe() as CommandInfo[]) {
        if (c.keys.length === 0 || seen.has(c.id)) continue;
        seen.add(c.id);
        const title = c.id === "help.about" ? "About PartZero" : c.title;
        const rows = byCategory.get(c.category) ?? [];
        rows.push({ keys: c.keys.map((k) => formatKey(k, isMac)), label: title.replace(/…$/, "") });
        byCategory.set(c.category, rows);
      }
    }
    return [...byCategory.entries()];
  }, [shell, isMac]);

  const toolSections = useMemo(
    () =>
      TOOL_GROUPS.map((g) => ({
        title: `${g.label} tools`,
        rows: tools.tools
          .filter((t) => t.group === g.id && t.shortcut)
          .map((t): Row => {
            const modes = t.modes ?? ["model"];
            return { keys: [formatKey(t.shortcut!, isMac)], label: t.label, ...(modes.includes("sketch") && !modes.includes("model") ? { note: "in a sketch" } : {}) };
          }),
      })),
    [tools, isMac],
  );

  const q = query.trim().toLowerCase();
  const filter = (rows: readonly Row[]): Row[] => (q ? rows.filter((r) => r.label.toLowerCase().includes(q) || r.keys.join(" ").toLowerCase().includes(q)) : [...rows]);

  return (
    <div className="overlay" onMouseDown={close} data-testid="shortcuts-dialog">
      <div className="dialog shortcuts" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <Icon.Key size={15} />
          <h2>Keyboard shortcuts</h2>
          <span className="spacer" />
          <input className="sc-search" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter shortcuts" autoFocus />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon.Close size={12} />
          </button>
        </header>
        <div className="sc-body">
          {toolSections.map((s) => (
            <Section key={s.title} title={s.title} rows={filter(s.rows)} testId={`shortcuts-tools-${s.title.split(" ")[0]!.toLowerCase()}`} />
          ))}
          {commandSections.map(([category, rows]) => (
            <Section key={category} title={category} rows={filter(rows)} testId={`shortcuts-${category.toLowerCase()}`} />
          ))}
          {docs.map((d) => (
            <Section key={d.id} title={d.title} rows={filter(d.rows.map((r) => ({ keys: [r.keys], label: r.label })))} testId={`shortcuts-${d.id}`} />
          ))}
          {tools.warnings.length > 0 && (
            <section className="sc-section sc-warnings">
              <h3>Shortcut clashes</h3>
              <ul>
                {tools.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
