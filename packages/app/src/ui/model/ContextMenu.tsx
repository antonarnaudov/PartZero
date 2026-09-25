/**
 * The model panels' right-click menu: items with a shortcut hint, disabled items saying why, a
 * danger item, separators and custom rows (the colour swatches). Arrow keys move, Enter runs,
 * Esc or a click elsewhere closes. Kept inside the window.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

export type MenuEntry =
  | { key: string; label: string; run: () => void; hint?: string; disabled?: boolean; title?: string; danger?: boolean; checked?: boolean }
  | { key: string; separator: true }
  | { key: string; render: (close: () => void) => ReactNode };

export function ContextMenu({ items, at, onClose, testId = "context-menu" }: { items: readonly MenuEntry[]; at: { x: number; y: number }; onClose: () => void; testId?: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 6)), y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 6)) });
  }, [at]);
  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keys = (e: KeyboardEvent): void => {
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button.cm-item:not([disabled])") ?? [])];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = buttons.length;
        if (n) buttons[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n]?.focus();
      }
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", keys, true);
    window.addEventListener("blur", onClose);
    ref.current?.querySelector<HTMLButtonElement>("button.cm-item:not([disabled])")?.focus();
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", keys, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="cm-menu" role="menu" style={{ left: pos.x, top: pos.y }} data-testid={testId} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => {
        if ("separator" in it) return <div key={it.key} className="cm-sep" role="separator" />;
        if ("render" in it) return <div key={it.key}>{it.render(onClose)}</div>;
        return (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            className={`cm-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            title={it.title}
            aria-checked={it.checked}
            data-testid={`${testId}-${it.key}`}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span className="cm-check">{it.checked ? "✓" : ""}</span>
            <span className="cm-label">{it.label}</span>
            {it.hint && <kbd className="cm-hint">{it.hint}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
