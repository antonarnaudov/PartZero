/**
 * Parameters (FULL-MODELING-PLAN T0 #14; Fusion's "Change Parameters"): every value of the model
 * in one list.
 *
 * - **User parameters:** name, expression (`80`, `12 mm`, `width - 2 * wall`), the evaluated
 *   value, unit, bounds. Edit in place (Enter), add, rename (every use is rewritten), delete
 *   (refused while used, or with each use replaced by its value).
 * - **Model values:** each feature's dimensions (`model-values.ts`): an extrude's distance, a
 *   sketch's sizes and driving dimensions, a pattern's count and spacing… as literals or
 *   expressions; expressions show the engine's own evaluation. **Make parameter** turns a value
 *   into a named parameter it then uses (one transaction).
 *
 * Every edit is one command of the one command layer (`ir.setParam`, `ir.addParam`,
 * `ir.renameParam`, `ir.deleteParam`, `ir.setField`, `ir.apply`) and rebuilds the model at once:
 * one undo step, the failure rule applied, the same ops the assistant calls.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { PARAM_UNITS } from "@aicad/model-ops";
import { modelValues, PARAM_NAME, suggestParamName, withScratchParams, type ModelValue, type ParamUnit } from "../../doc/v1/model-values";
import { useApp, useStore } from "../context";
import { Icon } from "../icons";
import { useShell } from "../shell/context";
import { ToolIcon } from "../shell/tool-icons";
import { selectFeature, startRename, type ModelActionContext } from "./actions";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { featureIcon, typeTitle } from "./feature-types";
import { ModelIcon } from "./icons";
import "./model.css";
import "./panels.css";

type Result = { ok: true; value: unknown } | { ok: false; error: { message: string } };

interface DeclaredParam {
  name: string;
  unit: ParamUnit;
  value: number | boolean | string;
  min?: number | string;
  max?: number | string;
  note?: string;
  part: string | null;
}

interface ParamReportLike {
  name: string;
  unit: string;
  value?: number | boolean;
  error?: { code?: string; message: string };
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined;

const UNIT_SUFFIX: Record<string, string> = { mm: "mm", deg: "°", ratio: "", count: "", bool: "" };

export function formatValue(v: number | boolean | null | undefined, unit: string): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  const n = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  const s = UNIT_SUFFIX[unit] ?? unit;
  return s === "°" ? `${n}°` : s ? `${n} ${s}` : n;
}

/** What a typed value is: a number literal, a boolean literal, or an expression. */
export function parseTyped(text: string): number | boolean | string | null {
  const t = text.trim();
  if (t === "") return null;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return t;
}

/** The last words of a value's label (`width` for `rect outline · width`), unless another value of the feature ends the same. */
function shortLabel(v: ModelValue, group: readonly ModelValue[]): string {
  const tail = (x: ModelValue): string => x.label.split(" · ").pop() ?? x.label;
  const t = tail(v);
  return group.filter((x) => tail(x) === t).length > 1 ? v.label : t;
}

function declaredParams(document: string | null): DeclaredParam[] {
  if (!document) return [];
  try {
    const d = JSON.parse(document) as { params?: DeclaredParam[]; parts?: Array<{ id: string; params?: DeclaredParam[] }> };
    return [...(d.params ?? []).map((p) => ({ ...p, part: null })), ...(d.parts ?? []).flatMap((pt) => (pt.params ?? []).map((p) => ({ ...p, part: pt.id })))];
  } catch {
    return [];
  }
}

/** An in-place value editor: Enter or leaving the field commits, Esc reverts. */
function ValueField({ value, label, onCommit, disabled, testId }: { value: string; label: string; onCommit: (text: string) => Promise<string | null>; disabled?: boolean; testId?: string }): ReactElement {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const skipBlur = useRef(false);
  useEffect(() => {
    setText(value);
    setError(null);
  }, [value]);
  const commit = async (): Promise<void> => {
    if (text.trim() === value.trim() || text.trim() === "") {
      setText(value);
      setError(null);
      return;
    }
    setBusy(true);
    const err = await onCommit(text);
    setBusy(false);
    setError(err);
  };
  return (
    <span className="pzp-field-wrap">
      <input
        className={`pz-field mono pzp-value${error ? " invalid" : ""}${busy ? " busy" : ""}`}
        value={text}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        data-testid={testId}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            skipBlur.current = true;
            void commit().then(() => (skipBlur.current = false));
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setText(value);
            setError(null);
            skipBlur.current = true;
            e.currentTarget.blur();
            skipBlur.current = false;
          }
        }}
        onBlur={() => {
          if (!skipBlur.current) void commit();
        }}
      />
      {error && (
        <span className="pzp-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

export function ParametersPanel(): ReactElement {
  const { services } = useApp();
  const { shell } = useShell();
  const ctx: ModelActionContext = useMemo(() => ({ services, shell }), [services, shell]);
  const v1 = useStore(services.doc, (s) => s.format === "ir-v1");
  const document = useStore(services.doc, (s) => (s.format === "ir-v1" ? s.source : null));
  const reports = useSyncExternalStore(services.ir ? services.ir.subscribe : NO_SUBSCRIBE, () => (services.ir?.getState().params ?? null) as ParamReportLike[] | null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<{ name: string; value: string; unit: ParamUnit } | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ items: MenuEntry[]; x: number; y: number } | null>(null);
  const [evaluated, setEvaluated] = useState<Map<string, { value?: number | boolean; error?: string }>>(new Map());

  const exec = (id: string, args: Record<string, unknown>): Promise<Result> => shell.execute({ id, args }, "ui") as Promise<Result>;
  const errorOf = (r: Result): string | null => (r.ok ? null : r.error.message);

  const params = useMemo(() => declaredParams(document), [document]);
  const values = useMemo(() => {
    if (!document) return [];
    try {
      return modelValues(JSON.parse(document) as never);
    } catch {
      return [];
    }
  }, [document]);
  // Parameters share the feature-name namespace (SPEC-v1 §0.3).
  const taken = useMemo(() => {
    const t = new Set(params.map((p) => p.name));
    try {
      for (const pt of (JSON.parse(document ?? "{}") as { parts?: Array<{ features?: Array<{ id?: string; name?: string }> }> }).parts ?? []) {
        for (const f of pt.features ?? []) {
          if (f.id) t.add(f.id);
          if (f.name) t.add(f.name);
        }
      }
    } catch {
      // loading
    }
    return t;
  }, [params, document]);

  // The engine evaluates every expression value exactly as the model does (scratch parameters).
  useEffect(() => {
    let live = true;
    let engine: ReturnType<NonNullable<typeof services.ir>["commandEngine"]> | null = null;
    try {
      engine = services.ir?.commandEngine() ?? null;
    } catch {
      engine = null;
    }
    const scratch = document ? withScratchParams(document, values) : null;
    if (!engine || !scratch) {
      setEvaluated(new Map());
      return;
    }
    engine.params(scratch.text).then(
      (reps) => {
        if (!live) return;
        const byName = new Map(reps.map((r) => [r.name, r]));
        const m = new Map<string, { value?: number | boolean; error?: string }>();
        for (const [key, name] of scratch.names) {
          const r = byName.get(name) as { value?: number | boolean; error?: { message: string } } | undefined;
          if (r) m.set(key, r.error ? { error: r.error.message } : { value: r.value as number | boolean });
        }
        setEvaluated(m);
      },
      () => live && setEvaluated(new Map()),
    );
    return () => {
      live = false;
    };
  }, [document, values, services.ir]);

  const q = query.trim().toLowerCase();
  const shownParams = params.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.value).toLowerCase().includes(q));
  const shownValues = values.filter((v) => !q || v.featureName.toLowerCase().includes(q) || v.label.toLowerCase().includes(q) || String(v.value).toLowerCase().includes(q));
  const groups = useMemo(() => {
    const m = new Map<string, ModelValue[]>();
    for (const v of shownValues) {
      const l = m.get(v.feature);
      if (l) l.push(v);
      else m.set(v.feature, [v]);
    }
    return [...m.values()];
  }, [shownValues]);

  const setParam = async (p: DeclaredParam, text: string): Promise<string | null> => {
    const v = parseTyped(text);
    if (v === null) return null;
    return errorOf(await exec("ir.setParam", { name: p.name, value: v }));
  };
  const setValue = async (v: ModelValue, text: string): Promise<string | null> => {
    const t = parseTyped(text);
    if (t === null || typeof t === "boolean") return "a number or an expression";
    return errorOf(await exec("ir.setField", { feature: v.feature, path: v.path, value: typeof t === "number" ? t : { expr: t } }));
  };
  const promote = async (v: ModelValue): Promise<void> => {
    const name = suggestParamName(v, taken);
    const r = await exec("ir.apply", {
      ops: [
        { op: "addParam", name, unit: v.unit, value: v.value },
        { op: "setField", feature: v.feature, path: v.path, value: { expr: name } },
      ],
      label: `Make ${v.featureName} ${v.label.split(" · ").pop()} a parameter (${name})`,
    });
    if (r.ok) {
      services.ui.toast("success", `${v.featureName} now uses the parameter ${name}`);
      requestAnimationFrame(() => startRename(ctx, { kind: "param", id: name, name }, window.document.querySelector(`[data-testid="param-row"][data-name="${CSS.escape(name)}"] .pzp-name`)));
    }
  };

  const paramMenu = (p: DeclaredParam, e: React.MouseEvent): void => {
    e.preventDefault();
    const el = (e.currentTarget as HTMLElement).querySelector(".pzp-name");
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { key: "rename", label: "Rename…", run: () => startRename(ctx, { kind: "param", id: p.name, name: p.name }, el) },
        { key: "sep", separator: true },
        { key: "delete", label: "Delete", danger: true, run: () => void exec("ir.deleteParam", { name: p.name }) },
        { key: "inline", label: "Delete and keep its value where used", danger: true, run: () => void exec("ir.deleteParam", { name: p.name, uses: "inline" }) },
      ],
    });
  };

  if (!v1) {
    return (
      <section className="panel pzp" aria-label="Parameters" data-testid="params-panel">
        <div className="panel-body">
          <p className="muted pzp-note">Parameters need a PartZero model (File ▸ New).</p>
        </div>
      </section>
    );
  }

  const reportOf = (name: string) => reports?.find((r) => r.name === name);

  return (
    <section className="panel pzp" aria-label="Parameters" data-testid="params-panel">
      <div className="pzp-bar">
        <span className="pzp-search">
          <Icon.Search size={12} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter values" aria-label="Filter parameters and values" spellCheck={false} data-testid="params-filter" />
        </span>
        <button type="button" className="ghost-btn tiny pzp-add-btn" onClick={() => setAdding({ name: "", value: "", unit: "mm" })} data-testid="params-add" title="Add a user parameter">
          <ModelIcon.Plus size={12} /> Parameter
        </button>
      </div>
      <div className="panel-body pzp-body">
        <div className="pzp-section">
          <div className="pzp-section-head">
            <span>User parameters</span>
            <span className="pzp-count">{params.length}</span>
          </div>
          {params.length === 0 && !adding && <p className="muted small pzp-note">Name a value — like wall = 2 mm — and use it in any field or dimension. Or promote a model value below.</p>}
          {shownParams.map((p) => {
            const rep = reportOf(p.name);
            const expr = typeof p.value === "string";
            const bounds = p.min !== undefined || p.max !== undefined ? `${p.min ?? "…"} to ${p.max ?? "…"}` : null;
            return (
              <div
                key={`${p.part ?? ""}/${p.name}`}
                className={`pzp-row${rep?.error ? " has-error" : ""}`}
                data-testid="param-row"
                data-name={p.name}
                onContextMenu={(e) => paramMenu(p, e)}
                title={[p.note, p.part ? "Part parameter" : null, bounds ? `Range ${bounds}` : null, rep?.error ? `${rep.error.code ?? "Error"}: ${rep.error.message}` : null].filter(Boolean).join("\n") || undefined}
              >
                <span className="pzp-name mono" onDoubleClick={(e) => startRename(ctx, { kind: "param", id: p.name, name: p.name }, e.currentTarget)}>
                  {p.name}
                </span>
                <ValueField value={String(p.value)} label={`${p.name} value`} onCommit={(t) => setParam(p, t)} testId="param-value" />
                <span className={`pzp-eval${expr ? " expr" : ""}`} data-testid="param-eval">
                  {rep?.error ? <span className="pzp-bad">error</span> : expr ? `= ${formatValue(rep?.value, p.unit)}` : UNIT_SUFFIX[p.unit] || p.unit}
                </span>
                <button type="button" className="pzp-more" aria-label={`More for ${p.name}`} onClick={(e) => paramMenu(p, e)}>
                  <ModelIcon.More size={13} />
                </button>
              </div>
            );
          })}
          {adding && (
            <form
              className="pzp-add"
              data-testid="param-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                const name = adding.name.trim();
                const value = parseTyped(adding.value);
                if (!PARAM_NAME.test(name) || value === null) return;
                void exec("ir.addParam", { name, unit: adding.unit, value }).then((r) => r.ok && setAdding(null));
              }}
            >
              <input className="pz-field mono" aria-label="New parameter name" placeholder="name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} autoFocus spellCheck={false} />
              <input className="pz-field mono" aria-label="New parameter value" placeholder="value or expression" value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} spellCheck={false} />
              <select className="pz-field" aria-label="New parameter unit" value={adding.unit} onChange={(e) => setAdding({ ...adding, unit: e.target.value as ParamUnit })}>
                {PARAM_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <span className="pzp-add-actions">
                <button type="button" className="ghost-btn tiny" onClick={() => setAdding(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn small" disabled={!PARAM_NAME.test(adding.name.trim()) || adding.value.trim() === "" || taken.has(adding.name.trim())} data-testid="param-add-submit">
                  Add
                </button>
              </span>
              {adding.name.trim() !== "" && !PARAM_NAME.test(adding.name.trim()) && <span className="pzp-error">A name starts with a letter: letters, digits and _</span>}
              {taken.has(adding.name.trim()) && <span className="pzp-error">{adding.name.trim()} already exists</span>}
            </form>
          )}
        </div>
        <div className="pzp-section">
          <div className="pzp-section-head">
            <span>Model values</span>
            <span className="pzp-count">{values.length}</span>
          </div>
          {values.length === 0 && <p className="muted small pzp-note">The dimensions of your features (extrude distances, sketch sizes, fillet radii…) appear here.</p>}
          {groups.map((g) => {
            const f = g[0]!;
            const open = !closed[f.feature];
            return (
              <div key={f.feature} className={`pzp-group${f.suppressed ? " suppressed" : ""}`} data-testid="value-group" data-feature={f.featureName}>
                <div className="pzp-group-head" onClick={() => selectFeature(ctx, f.feature)}>
                  <span
                    className={`pzb-chev${open ? " open" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setClosed((c) => ({ ...c, [f.feature]: open }));
                    }}
                    aria-label={open ? "Collapse" : "Expand"}
                  >
                    <Icon.Chevron size={10} />
                  </span>
                  <span className={`ptl-icon type-${f.featureType}`}>
                    <ToolIcon name={featureIcon(f.featureType)} size={13} />
                  </span>
                  <span className="pzp-group-name">{f.featureName}</span>
                  <span className="muted small">{typeTitle(f.featureType)}</span>
                </div>
                {open &&
                  g.map((v) => {
                    const ev = evaluated.get(v.key);
                    const label = shortLabel(v, g);
                    return (
                      <div key={v.key} className="pzp-row value" data-testid="value-row" data-key={v.key} data-feature={v.featureName} data-path={v.path}>
                        <span className="pzp-name" title={`${v.featureName} · ${v.label}`}>
                          {label}
                        </span>
                        <ValueField value={String(v.value)} label={`${v.featureName} ${v.label}`} onCommit={(t) => setValue(v, t)} testId="value-input" />
                        <span className={`pzp-eval${v.isExpression ? " expr" : ""}`} data-testid="value-eval">
                          {v.isExpression ? ev?.error ? <span className="pzp-bad" title={ev.error}>error</span> : `= ${formatValue(ev?.value, v.unit)}` : UNIT_SUFFIX[v.unit] || v.unit}
                        </span>
                        <button
                          type="button"
                          className="pzp-more"
                          title={v.isExpression ? "Uses parameters" : "Make this value a named parameter"}
                          aria-label={`Make ${v.featureName} ${v.label} a parameter`}
                          disabled={v.isExpression}
                          data-testid="value-promote"
                          onClick={() => void promote(v)}
                        >
                          {v.isExpression ? <ModelIcon.Fx size={13} /> : <ModelIcon.Promote size={13} />}
                        </button>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
      {menu && <ContextMenu testId="param-menu" at={{ x: menu.x, y: menu.y }} items={menu.items} onClose={() => setMenu(null)} />}
    </section>
  );
}
