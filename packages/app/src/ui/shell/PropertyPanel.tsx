/**
 * The property panel host: renders the open tool's {@link PanelSession} — typed fields, inline errors
 * with feasible ranges, the live preview's summary, and OK / Apply / Cancel. Enter = OK and
 * Esc = Cancel while a field has focus (the window keyboard handler covers the rest of the window).
 */
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { clampToRange, formatNumber, formatQuantity, stepNumberText, unitLabel } from "../../tools/framework/expr";
import { selectionNoun, type FieldState, type PanelSession } from "../../tools/framework/session";
import type { ChoiceFieldSpec, FieldError, NumberFieldSpec, NumberValue, SelectionFieldSpec, SelectionItem, TextFieldSpec, ToggleFieldSpec } from "../../tools/framework/types";
import { Icon } from "../icons";
import { useShellState } from "./context";
import { ToolIcon } from "./tool-icons";

function useSession(session: PanelSession): ReturnType<PanelSession["getState"]> {
  return useSyncExternalStore(session.subscribe, session.getState);
}

function itemLabel(item: SelectionItem): string {
  switch (item.kind) {
    case "face":
    case "edge":
    case "vertex":
      return item.label ?? item.key;
    case "body":
      return item.label ?? item.body;
    case "feature":
    case "datum":
    case "origin":
      return item.label ?? item.feature;
    case "sketchCurve":
    case "sketchPoint":
      return `${item.sketch}.${item.id}${item.kind === "sketchPoint" && item.sub ? `.${item.sub}` : ""}`;
    case "constraint":
    case "dimension":
      return `${item.sketch} #${item.index + 1}`;
    case "region":
      return `${item.sketch} region`;
    case "param":
      return item.name;
  }
}

function ErrorLine({ error, fieldKey, fix, quantity }: { error: FieldError; fieldKey: string; fix?: { label: string; run: () => void } | null; quantity?: NumberFieldSpec["quantity"] }): ReactElement {
  const prompt = error.code === "REQUIRED";
  const f = error.feasible;
  const range =
    f && quantity
      ? f.min !== undefined && f.max !== undefined
        ? `${formatQuantity(f.min, quantity)} – ${formatQuantity(f.max, quantity)}`
        : f.max !== undefined
          ? `up to ${formatQuantity(f.max, quantity)}`
          : f.min !== undefined
            ? `from ${formatQuantity(f.min, quantity)}`
            : null
      : null;
  return (
    <div className={`pp-error${prompt ? " prompt" : ""}`} id={`pp-err-${fieldKey}`} data-testid={`field-error-${fieldKey}`} role={prompt ? undefined : "alert"}>
      {!prompt && <Icon.Warning size={12} />}
      <span>
        {error.message}
        {range && <span className="pp-range"> Builds with {range}.</span>}
      </span>
      {fix && (
        <button type="button" className="pp-use" data-testid={`use-feasible-${fieldKey}`} onClick={fix.run}>
          {fix.label}
        </button>
      )}
    </div>
  );
}

function FieldRow({ field, children, htmlFor }: { field: FieldState; children: ReactNode; htmlFor?: string | undefined }): ReactElement {
  return (
    <div className={`pp-field kind-${field.spec.kind}`} data-testid={`field-${field.key}`}>
      <label className="pp-label" htmlFor={htmlFor}>
        {field.spec.label}
      </label>
      <div className="pp-control">
        {children}
        {field.spec.hint && <div className="pp-hint">{field.spec.hint}</div>}
      </div>
    </div>
  );
}

function NumberInput({ session, field }: { session: PanelSession; field: FieldState }): ReactElement {
  const spec = field.spec as NumberFieldSpec;
  const value = field.value as NumberValue;
  const error = field.remoteError ?? field.error;
  const id = `pp-${session.id}-${field.key}`;
  const plainNumber = /^\s*-?\d+(\.\d+)?\s*$/.test(value.text);
  const unit = unitLabel(spec.quantity);
  const feasible = error?.feasible;
  const target = feasible && (feasible.min !== undefined || feasible.max !== undefined) ? clampToRange(value.value ?? feasible.max ?? feasible.min ?? 0, feasible) : null;
  const fix = target !== null && target !== value.value ? { label: `Use ${formatQuantity(target, spec.quantity)}`, run: () => session.set(field.key, formatNumber(target)) } : null;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const base = spec.step ?? 1;
    const step = (e.shiftKey ? base * 10 : e.altKey ? base / 10 : base) * (e.key === "ArrowUp" ? 1 : -1);
    const next = stepNumberText(value.text, step);
    if (next !== null) {
      e.preventDefault();
      session.set(field.key, next);
    }
  };
  return (
    <FieldRow field={field} htmlFor={id}>
      <div className={`pp-number${error && error.code !== "REQUIRED" ? " invalid" : ""}`}>
        <input
          id={id}
          className="pp-input mono"
          value={value.text}
          spellCheck={false}
          autoComplete="off"
          inputMode="decimal"
          aria-invalid={error !== null && error.code !== "REQUIRED"}
          aria-describedby={error ? `pp-err-${field.key}` : undefined}
          onChange={(e) => session.set(field.key, e.target.value)}
          onKeyDown={onKeyDown}
          data-testid={`input-${field.key}`}
        />
        {unit && plainNumber && <span className="pp-unit">{unit}</span>}
      </div>
      {field.resolved && !error && <div className="pp-resolved mono">{field.resolved}</div>}
      {error && <ErrorLine error={error} fieldKey={field.key} quantity={spec.quantity} fix={fix} />}
    </FieldRow>
  );
}

function SelectionInput({ session, field, active }: { session: PanelSession; field: FieldState; active: boolean }): ReactElement {
  const spec = field.spec as SelectionFieldSpec;
  const items = field.value as readonly SelectionItem[];
  const error = field.remoteError ?? field.error;
  return (
    <FieldRow field={field}>
      <div
        className={`pp-selection${active ? " active" : ""}${error && error.code !== "REQUIRED" ? " invalid" : ""}`}
        role="button"
        tabIndex={0}
        aria-pressed={active}
        aria-label={`${spec.label}: ${items.length ? selectionNoun(spec.accepts, items.length) : "nothing selected"}${active ? ", picking" : ""}`}
        data-testid={`selection-${field.key}`}
        onClick={() => session.activateSelectionField(field.key)}
        onKeyDown={(e) => {
          if (e.key === " ") {
            e.preventDefault();
            session.activateSelectionField(field.key);
          }
        }}
      >
        {items.length > 0 ? (
          <>
            <span className="pp-count" data-testid={`selection-count-${field.key}`}>
              {selectionNoun(spec.accepts, items.length)}
            </span>
            <span className="pp-items mono">{items.slice(0, 3).map(itemLabel).join(", ")}{items.length > 3 ? ` +${items.length - 3}` : ""}</span>
            <button
              type="button"
              className="icon-btn pp-clear"
              aria-label={`Clear ${spec.label}`}
              onClick={(e) => {
                e.stopPropagation();
                session.clearSelectionField(field.key);
              }}
            >
              <Icon.Close size={10} />
            </button>
          </>
        ) : (
          <span className="pp-placeholder">{active ? "Pick in the viewport or the timeline…" : "Click, then pick"}</span>
        )}
        {active && <span className="pp-picking">Picking</span>}
      </div>
      {field.ignored > 0 && <div className="pp-hint">{field.ignored} selected item{field.ignored === 1 ? "" : "s"} of another kind ignored</div>}
      {error && <ErrorLine error={error} fieldKey={field.key} />}
    </FieldRow>
  );
}

function ChoiceInput({ session, field }: { session: PanelSession; field: FieldState }): ReactElement {
  const spec = field.spec as ChoiceFieldSpec;
  const value = field.value as string;
  const style = spec.style ?? (spec.options.length <= 4 ? "segmented" : "dropdown");
  const id = `pp-${session.id}-${field.key}`;
  return (
    <FieldRow field={field} htmlFor={style === "dropdown" ? id : undefined}>
      {style === "segmented" ? (
        <div className="pp-segmented" role="radiogroup" aria-label={spec.label}>
          {spec.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              title={o.hint}
              className={o.value === value ? "on" : ""}
              data-testid={`choice-${field.key}-${o.value}`}
              onClick={() => session.set(field.key, o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <select id={id} className="pp-select" value={value} onChange={(e) => session.set(field.key, e.target.value)} data-testid={`input-${field.key}`}>
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {field.remoteError && <ErrorLine error={field.remoteError} fieldKey={field.key} />}
    </FieldRow>
  );
}

function ToggleInput({ session, field }: { session: PanelSession; field: FieldState }): ReactElement {
  const spec = field.spec as ToggleFieldSpec;
  const on = field.value === true;
  return (
    <FieldRow field={field}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={spec.label}
        className={`pp-switch${on ? " on" : ""}`}
        data-testid={`toggle-${field.key}`}
        onClick={() => session.set(field.key, !on)}
      >
        <span className="knob" />
      </button>
      {field.remoteError && <ErrorLine error={field.remoteError} fieldKey={field.key} />}
    </FieldRow>
  );
}

function TextInput({ session, field }: { session: PanelSession; field: FieldState }): ReactElement {
  const spec = field.spec as TextFieldSpec;
  const error = field.remoteError ?? field.error;
  const id = `pp-${session.id}-${field.key}`;
  return (
    <FieldRow field={field} htmlFor={id}>
      <input
        id={id}
        className={`pp-input${error && error.code !== "REQUIRED" ? " invalid" : ""}`}
        value={String(field.value)}
        placeholder={spec.placeholder}
        maxLength={spec.maxLength}
        spellCheck={false}
        aria-invalid={error !== null && error.code !== "REQUIRED"}
        onChange={(e) => session.set(field.key, e.target.value)}
        data-testid={`input-${field.key}`}
      />
      {error && <ErrorLine error={error} fieldKey={field.key} />}
    </FieldRow>
  );
}

const STATE_LABEL: Record<string, string> = {
  collecting: "Waiting for input",
  previewing: "Checking…",
  ready: "Ready",
  invalid: "Won't build",
  committing: "Applying…",
  closed: "Closed",
};

export function PropertyPanel({ session }: { session: PanelSession }): ReactElement {
  const s = useSession(session);
  const focusTick = useShellState((st) => st.focusTick);
  const rootRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // The first text field, else the first control (a selection input, a switch, a choice).
    const root = rootRef.current;
    const first = root?.querySelector<HTMLElement>(".pp-body input, .pp-body select") ?? root?.querySelector<HTMLElement>(".pp-body [role=button], .pp-body [role=switch], .pp-body [role=radio]");
    first?.focus();
  }, [focusTick, session]);

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      session.cancel();
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      e.stopPropagation();
      void session.commit();
    }
  };

  const visible = s.fields.filter((f) => f.visible);
  // OK while the check runs waits for it and commits only if it passes (session.ts).
  const canOk = s.readOnly || ((s.state === "ready" || s.state === "previewing") && !s.pendingCommit);
  const tone = s.pendingCommit ? "busy" : s.state === "ready" ? "ok" : s.state === "invalid" ? "error" : s.state === "previewing" || s.state === "committing" ? "busy" : "idle";
  const stateLabel = s.readOnly ? (s.state === "previewing" ? "Updating…" : "Read only") : s.pendingCommit ? "Checking, then applying…" : STATE_LABEL[s.state];

  return (
    <form
      ref={rootRef}
      className="property-panel"
      data-testid="property-panel"
      data-state={s.state}
      data-pending-commit={s.pendingCommit ? "true" : undefined}
      data-tool={s.toolId ?? ""}
      aria-label={`${s.title} properties`}
      onSubmit={(e) => {
        e.preventDefault();
        void session.commit();
      }}
      onKeyDown={onKeyDown}
    >
      <header className="pp-head">
        <span className="pp-icon">
          <ToolIcon name={s.icon ?? s.toolId?.split(".").pop() ?? null} size={16} />
        </span>
        <h2 className="pp-title">{s.title}</h2>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel (Esc)" onClick={() => session.cancel()}>
          <Icon.Close size={11} />
        </button>
      </header>
      {s.description && <p className="pp-desc">{s.description}</p>}
      <div className="pp-body">
        {visible.map((f) => {
          switch (f.spec.kind) {
            case "number":
              return <NumberInput key={f.key} session={session} field={f} />;
            case "selection":
              return <SelectionInput key={f.key} session={session} field={f} active={s.activeSelectionField === f.key} />;
            case "choice":
              return <ChoiceInput key={f.key} session={session} field={f} />;
            case "toggle":
              return <ToggleInput key={f.key} session={session} field={f} />;
            case "text":
              return <TextInput key={f.key} session={session} field={f} />;
          }
          return null;
        })}
        {s.summary.length > 0 && (
          <dl className={`pp-summary${s.state === "previewing" ? " stale" : ""}`} data-testid="panel-summary">
            {s.summary.map((row) => (
              <div key={row.label} className={row.tone ? `tone-${row.tone}` : undefined}>
                <dt>{row.label}</dt>
                <dd className="mono">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {s.warnings.map((w) => (
          <div key={w} className="pp-warning" data-testid="panel-warning">
            <Icon.Warning size={12} /> {w}
          </div>
        ))}
        {s.notice && (
          <div className="pp-notice" role="status" data-testid="panel-notice">
            <Icon.Info size={12} /> {s.notice}
          </div>
        )}
        {s.errors.map((e, i) => (
          <div key={`${e.code ?? ""}${i}`} className="pp-panel-error" role="alert" data-testid="panel-error">
            <Icon.Error size={12} />
            <span>
              {e.message}
              {e.code && <code className="pp-code">{e.code}</code>}
            </span>
          </div>
        ))}
      </div>
      <footer className="pp-foot">
        <span className={`pp-state tone-${tone}`} data-testid="panel-state">
          {tone === "busy" ? <Icon.Spinner size={11} /> : <span className="dot" />}
          {stateLabel}
        </span>
        <span className="spacer" />
        {!s.readOnly && (
          <button type="button" className="ghost-btn" onClick={() => session.cancel()} data-testid="panel-cancel">
            Cancel
          </button>
        )}
        {!s.readOnly && s.apply && (
          <button type="button" className="ghost-btn" disabled={!canOk} onClick={() => void session.apply()} data-testid="panel-apply">
            Apply
          </button>
        )}
        <button type="submit" className="primary-btn small" disabled={!canOk} data-testid="panel-ok" title={s.readOnly ? "Close (Enter)" : `${s.okLabel} (Enter)`}>
          {s.readOnly ? "Close" : s.okLabel}
        </button>
      </footer>
    </form>
  );
}
