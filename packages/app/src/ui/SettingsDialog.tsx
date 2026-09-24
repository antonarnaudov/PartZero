/**
 * Settings: which model plays each agent role, and where the models come from (ADR 0014):
 *
 * 1. **CLI agents (your subscription):** Claude Code, Codex, Gemini CLI, opencode, Cursor Agent, as the desktop app
 *    detected them (version, lockdown, login; no model call). Runs use the user's own login and plan limits.
 * 2. **Local models (Ollama):** the server's tool-capable models. The app never pulls models.
 * 3. **API keys (optional):** stored encrypted by the desktop main process, never shown again.
 *
 * The model pickers list every profile grouped by provider, with its kind (Plan, Local, API key); unavailable ones are
 * disabled with the reason. When nothing is chosen, the defaults come from the first ready provider ("Using Claude Code
 * (detected)"). Every change goes through a `settings.*` command. CLI output and paths are shown as text only.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AgentRoleId, AgentSettingsView, CliModeSetting, CliProviderStatus, LocalProviderStatus, ModelProfileInfo, PlanUsageView, ProviderId, ProviderKeyStatus } from "../agent-protocol";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";

const ROLES: Array<{ id: AgentRoleId; label: string; hint: string }> = [
  { id: "designer", label: "Designer", hint: "Main loop: plan, build, repair" },
  { id: "spec_writer", label: "Spec writer", hint: "Writes the spec and frozen tests" },
  { id: "triage", label: "Triage", hint: "Small, fast router" },
  { id: "judge", label: "Judge", hint: "Visual review (different family than the designer)" },
];

const SOURCE_LABEL: Record<string, string> = { keychain: "saved in the OS keychain", env: "from the environment", dotenv: "from .env (development)" };
const PATH_SOURCE: Record<string, string> = { settings: "set in Settings", path: "found on PATH", "known-dir": "found in a standard install folder", "login-shell": "found through your login shell" };
const KIND_BADGE: Record<string, string> = { cli: "Plan", local: "Local", api: "API key" };
const INSTALL_URL: Partial<Record<ProviderId, string>> = {
  "claude-cli": "https://docs.anthropic.com/en/docs/claude-code/setup",
  "gemini-cli": "https://github.com/google-gemini/gemini-cli",
  "codex-cli": "https://github.com/openai/codex",
  opencode: "https://opencode.ai/docs/",
  "cursor-agent": "https://cursor.com/cli",
};

// Frozen copy (docs/CLI-PROVIDERS.md §11.7).
const CLI_INTRO =
  "Use AI coding tools you already have. Runs go through your own account and count against that tool's plan limits; the app never sees your login. The tool runs with its own tools switched off and can only use this app's CAD tools, in an empty temporary folder.";
const DATA_NOTE = "Prompts and your design are sent to the tool's vendor under your plan's terms.";
const CURSOR_BLOCKED = "Not supported yet: Cursor Agent has no documented way to switch off its web search in headless runs, so the app cannot guarantee it only uses CAD tools.";

/** The command inside a login hint ("Run `claude auth login` in a terminal" → "claude auth login"). */
function loginCommand(hint: string): string | null {
  return /`([^`]+)`/.exec(hint)?.[1] ?? null;
}

type Badge = { label: string; tone: "ok" | "warn" | "muted" | "err" };

/** Blocked because a run caught it breaking its lockdown (not a CLI we do not support): Re-check tests it again. */
function trippedLockdown(s: CliProviderStatus): boolean {
  return s.support === "blocked" && /lockdown violation/i.test(s.supportDetail);
}

function cliBadge(s: CliProviderStatus): Badge {
  if (s.checkedAt === null) return { label: "Checking…", tone: "muted" };
  switch (s.support) {
    case "not_installed":
      return { label: "Not installed", tone: "muted" };
    case "unsupported_version":
      return { label: "Update needed", tone: "warn" };
    case "blocked":
      return trippedLockdown(s) ? { label: "Blocked", tone: "err" } : { label: "Not supported yet", tone: "err" };
    case "ready":
      return s.auth === "logged_out" ? { label: "Log in needed", tone: "warn" } : { label: "Ready", tone: "ok" };
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function loginLine(s: CliProviderStatus): string {
  if (s.support !== "ready") return "";
  if (s.auth === "logged_in") return `Logged in${s.plan ? ` · ${capitalize(s.plan)} plan` : ""}${s.billing === "metered" ? " · API key (billed per token)" : ""}`;
  if (s.auth === "logged_out") return `${s.label} is installed but not logged in. Run \`${loginCommand(s.loginHint) ?? "the CLI's login command"}\` in a terminal, then press Re-check.`;
  return "Login state unknown: a run will say if a login is needed.";
}

function PlanBars({ usage }: { usage: PlanUsageView }): ReactElement {
  return (
    <div className="plan-usage" data-testid="settings-plan-usage" title={`Plan usage reported by the CLI at ${new Date(usage.observedAt).toLocaleString()}`}>
      {usage.windows.map((w) => (
        <span key={w.id} className="plan-window">
          <span className="muted small">{w.label}</span>
          <span className="plan-bar" aria-hidden="true">
            <span className={`plan-fill${(w.utilization ?? 0) >= 0.8 ? " warn" : ""}`} style={{ width: `${Math.round((w.utilization ?? 0) * 100)}%` }} />
          </span>
          <span className="mono small">{w.utilization === null ? "?" : `${Math.round(w.utilization * 100)} %`}</span>
        </span>
      ))}
      {usage.status === "rejected" && <span className="model-warn">limit reached</span>}
    </div>
  );
}

function CliRow({ s }: { s: CliProviderStatus }): ReactElement {
  const { run } = useApp();
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(s.path ?? "");
  const [hint, setHint] = useState(false);
  const badge = cliBadge(s);
  const login = loginCommand(s.loginHint);
  const savePath = (): void => {
    const p = path.trim();
    run({ id: "settings.setCliPath", args: { provider: s.id, path: p === "" ? null : p } });
    setEditing(false);
  };
  const copyLogin = (): void => {
    setHint(true);
    if (login) void navigator.clipboard?.writeText(login).catch(() => undefined);
  };
  let detail = "";
  if (s.support === "blocked") detail = trippedLockdown(s) ? s.supportDetail : s.id === "cursor-agent" ? CURSOR_BLOCKED : `Not supported yet: ${s.supportDetail}`;
  else if (s.support === "unsupported_version") detail = `Update needed: ${s.supportDetail}`;
  else if (s.support === "ready" && s.lockdownLevel === "static") detail = "Newer than the last verified version: the lockdown relies on runtime checks.";
  return (
    <div className="provider-row" data-testid="settings-cli" data-provider={s.id} data-support={s.support} data-auth={s.auth}>
      <div className="provider-head">
        <span className="key-name">{s.label}</span>
        <span className={`provider-badge badge-${badge.tone}`} data-testid="settings-cli-badge">
          {badge.label}
        </span>
        {s.version && <span className="mono muted small">{s.version}</span>}
        <span className="spacer" />
        <button type="button" className="ghost-btn tiny" onClick={() => run({ id: "settings.probeProviders", args: { providers: [s.id] } })}>
          Re-check
        </button>
      </div>
      {s.support === "not_installed" && s.checkedAt !== null && (
        <div className="muted small">
          Not found on this computer.{" "}
          {INSTALL_URL[s.id] && (
            <a href={INSTALL_URL[s.id]} target="_blank" rel="noreferrer">
              How to install
            </a>
          )}{" "}
          · or{" "}
          <button type="button" className="link-btn" onClick={() => setEditing(true)}>
            set its path…
          </button>
        </div>
      )}
      {s.path && !editing && (
        <div className="provider-path small">
          <span className="mono" title={s.path}>
            {s.path}
          </span>{" "}
          <span className="muted">({PATH_SOURCE[s.pathSource ?? ""] ?? "found"})</span>{" "}
          <button type="button" className="link-btn" onClick={() => setEditing(true)}>
            Change…
          </button>
        </div>
      )}
      {editing && (
        <div className="key-input">
          <input
            type="text"
            spellCheck={false}
            placeholder={`/absolute/path/to/${s.id === "claude-cli" ? "claude" : s.id === "gemini-cli" ? "gemini" : s.id === "codex-cli" ? "codex" : s.id}`}
            aria-label={`${s.label} path`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") savePath();
            }}
          />
          <button type="button" className="primary-btn small" onClick={savePath}>
            Save
          </button>
          {s.pathSource === "settings" && (
            <button type="button" className="ghost-btn" onClick={() => (setPath(""), run({ id: "settings.setCliPath", args: { provider: s.id, path: null } }), setEditing(false))}>
              Use automatic
            </button>
          )}
          <button type="button" className="ghost-btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}
      {s.support === "ready" && (
        <div className={`provider-login small${s.auth === "logged_out" ? " warn" : s.auth === "logged_in" ? " ok" : ""}`} data-testid="settings-cli-login">
          {loginLine(s)}
          {s.auth !== "logged_in" && login && (
            <>
              {" "}
              <button type="button" className="link-btn" onClick={copyLogin}>
                How to log in
              </button>
            </>
          )}
        </div>
      )}
      {hint && login && (
        <div className="small">
          In a terminal: <code className="selectable">{login}</code>, then press Re-check.
        </div>
      )}
      {detail && <div className="provider-detail small">{detail}</div>}
      {s.planUsage && s.planUsage.windows.length > 0 && <PlanBars usage={s.planUsage} />}
      {s.installed && (
        <details className="provider-more small">
          <summary>Details</summary>
          <div>
            Lockdown: {s.lockdownLevel ?? "not evaluated"}
            {s.modes.length > 0 ? ` · modes: ${s.modes.join(", ")}` : ""}
          </div>
          {s.supportDetail && <div className="muted">{s.supportDetail}</div>}
          {s.residualRisks.length > 0 && (
            <ul>
              {s.residualRisks.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}

function LocalGroup({ l, url, profiles }: { l: LocalProviderStatus | undefined; url: string | null; profiles: readonly ModelProfileInfo[] }): ReactElement {
  const { run } = useApp();
  const [value, setValue] = useState(url ?? "");
  useEffect(() => setValue(url ?? ""), [url]);
  const missing = profiles.filter((p) => p.kind === "local" && !p.available && p.reason?.startsWith("not pulled"));
  return (
    <div className="provider-group" data-testid="settings-local">
      <h4>
        Local models (Ollama)
        <span className={`provider-badge badge-${l?.running ? "ok" : "muted"}`}>{l ? (l.running ? `Running${l.version ? ` ${l.version}` : ""}` : "Not running") : "Checking…"}</span>
        <span className="spacer" />
        <button type="button" className="ghost-btn tiny" onClick={() => run({ id: "settings.probeProviders", args: { providers: ["ollama"] } })}>
          Re-check
        </button>
      </h4>
      <p className="muted small">Runs on this computer: nothing leaves it, and nothing is billed. The app never downloads models.</p>
      <div className="inline-field">
        <input
          type="url"
          placeholder="http://127.0.0.1:11434"
          value={value}
          aria-label="Ollama URL"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            const next = value.trim() || null;
            if (next !== url) run({ id: "settings.setOllamaUrl", args: { url: next } });
          }}
        />
      </div>
      {l && !l.running && <p className="muted small">{l.detail}</p>}
      {l && l.running && (
        <ul className="local-models">
          {l.models.length === 0 && <li className="muted">No models yet.</li>}
          {l.models.map((m) => (
            <li key={m.id} className={m.tools ? "" : "muted"}>
              <span className="mono">{m.tag}</span>
              {m.tools ? <span className="provider-badge badge-ok">tools</span> : <span className="provider-badge badge-muted">no tool calling</span>}
              {m.vision && <span className="provider-badge badge-muted">vision</span>}
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <p className="muted small">
          Suggested models (pull them yourself: disk space is your call):{" "}
          {missing.map((p, i) => (
            <span key={p.id}>
              {i > 0 ? ", " : ""}
              <code className="selectable">ollama pull {p.id.replace(/^ollama:/, "")}</code>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function KeyRow({ p, storageAvailable }: { p: ProviderKeyStatus; storageAvailable: boolean }): ReactElement {
  const { run } = useApp();
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const save = (): void => {
    const key = value.trim();
    if (!key) return;
    // The key leaves the renderer here; the field is cleared right away and never re-filled.
    run({ id: "settings.setApiKey", args: { provider: p.id, key } });
    setValue("");
    setEditing(false);
  };
  return (
    <div className="key-row" data-testid="settings-key" data-provider={p.id} data-configured={p.configured ? "yes" : "no"}>
      <div className="key-label">
        <span className="key-name">{p.label}</span>
        <span className={`key-status${p.configured ? " ok" : ""}`} data-testid="settings-key-status">
          {p.configured ? (
            <>
              <Icon.Check size={11} /> Configured{p.last4 ? ` · …${p.last4}` : ""} · {SOURCE_LABEL[p.source ?? ""] ?? ""}
            </>
          ) : p.keyRequired ? (
            "Not set (optional)"
          ) : (
            "Not set (optional for local servers)"
          )}
        </span>
      </div>
      {editing || !p.configured ? (
        <div className="key-input">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={storageAvailable ? `Paste your ${p.label} API key` : `Set ${p.envVar} instead`}
            aria-label={`${p.label} API key`}
            disabled={!storageAvailable}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <button type="button" className="primary-btn small" disabled={!value.trim() || !storageAvailable} onClick={save}>
            Save
          </button>
          {p.configured && (
            <button type="button" className="ghost-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="key-input">
          <button type="button" className="ghost-btn" onClick={() => setEditing(true)} disabled={!storageAvailable}>
            Replace…
          </button>
          {p.source === "keychain" && (
            <button type="button" className="ghost-btn" onClick={() => run({ id: "settings.clearApiKey", args: { provider: p.id } })}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A few words for the warning next to a role's picker (the full reason is its tooltip). */
function shortReason(reason: string | undefined): string {
  if (!reason) return "unavailable";
  if (/not logged in/.test(reason)) return "log in needed";
  if (/not installed/.test(reason)) return "not installed";
  if (/cannot be used/.test(reason)) return "update needed";
  if (/not supported yet/.test(reason)) return "not supported yet";
  if (/API key$/.test(reason)) return "needs a key";
  if (/^not pulled/.test(reason)) return "not pulled";
  if (/Ollama is not running/.test(reason)) return "Ollama not running";
  return reason;
}

/** Group label of a provider in the pickers: its name and kind ("Claude Code · Plan"). */
function groupLabel(view: AgentSettingsView, provider: ProviderId, kind: string): string {
  const name = view.cli?.find((c) => c.id === provider)?.label ?? view.providers.find((p) => p.id === provider)?.label ?? (provider === "ollama" ? "Ollama" : provider);
  return `${name} · ${KIND_BADGE[kind] ?? kind}`;
}

function groupByProvider(profiles: readonly ModelProfileInfo[]): Array<[ProviderId, ModelProfileInfo[]]> {
  const m = new Map<ProviderId, ModelProfileInfo[]>();
  for (const p of profiles) m.set(p.provider, [...(m.get(p.provider) ?? []), p]);
  return [...m.entries()];
}

function ModelsSection({ view }: { view: AgentSettingsView }): ReactElement {
  const { run } = useApp();
  const designerRef = useRef<HTMLSelectElement>(null);
  const info = (id: string): ModelProfileInfo | undefined => view.profiles.find((p) => p.id === id);
  const chosenAny = ROLES.some((r) => view.models[r.id] !== view.defaults[r.id]);
  const auto = view.autoDefault ?? null;
  const autoCli = auto ? view.cli?.find((c) => c.id === auto.provider) : undefined;
  const live = view.transport === "live";
  return (
    <section className="settings-section" data-testid="settings-models">
      <h3>Models</h3>
      {live && auto && !chosenAny && autoCli?.support === "blocked" && (
        <div className="panel-banner warn" data-testid="settings-auto-default" data-state="blocked">
          <Icon.Warning size={13} /> {autoCli.label} is blocked: a run caught it using a tool it must not have. Press Re-check to test it again.
        </div>
      )}
      {live && auto && !chosenAny && autoCli?.support !== "blocked" && autoCli?.auth === "logged_out" && (
        <div className="panel-banner warn" data-testid="settings-auto-default" data-state="login">
          <Icon.Warning size={13} /> {loginLine(autoCli)}
        </div>
      )}
      {live && auto && !chosenAny && autoCli?.support !== "blocked" && autoCli?.auth !== "logged_out" && (
        <div className="panel-banner ok" data-testid="settings-auto-default" data-state="ready">
          <Icon.Check size={13} /> Using {auto.label} (detected).{" "}
          <button type="button" className="link-btn" onClick={() => designerRef.current?.focus()}>
            Change
          </button>
        </div>
      )}
      {live && !auto && !chosenAny && (
        <div className="panel-banner warn" data-testid="settings-no-provider">
          <Icon.Warning size={13} /> No model provider is set up yet. Log in to a CLI agent below, start Ollama, or add an API key.
        </div>
      )}
      {ROLES.map((r) => {
        const current = view.models[r.id];
        const isDefault = current === view.defaults[r.id];
        const cur = info(current);
        return (
          <label key={r.id} className="model-row" data-testid="settings-model" data-role={r.id} data-model={current}>
            <span className="model-role">
              {r.label}
              <span className="muted small">{r.hint}</span>
            </span>
            <select
              ref={r.id === "designer" ? designerRef : undefined}
              value={isDefault ? "" : current}
              aria-label={`${r.label} model`}
              onChange={(e) => run({ id: "settings.setModel", args: { role: r.id, model: e.target.value === "" ? null : e.target.value } })}
            >
              <option value="">Default ({info(view.defaults[r.id])?.name ?? view.defaults[r.id]})</option>
              {groupByProvider(view.profiles).map(([provider, list]) => (
                <optgroup key={provider} label={groupLabel(view, provider, list[0]?.kind ?? "api")}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available && p.id !== current}>
                      {p.name}
                      {p.available ? "" : ` — ${p.reason ?? "unavailable"}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {live && r.id !== "judge" && cur && !cur.available ? (
              <span className="model-warn" title={cur.reason} data-testid="settings-model-warning">
                {shortReason(cur.reason)}
              </span>
            ) : (
              <span className={`model-kind kind-${cur?.kind ?? "api"}`}>{cur ? KIND_BADGE[cur.kind] : ""}</span>
            )}
          </label>
        );
      })}
      {view.warnings.map((w) => (
        <div key={w} className="dep-warning warning">
          <Icon.Warning size={12} /> {w}
        </div>
      ))}
    </section>
  );
}

const CLI_MODE_LABEL: Record<CliModeSetting, string> = { auto: "Automatic (recommended)", completion: "Single calls only", runtime: "Agent runtime" };

export function SettingsDialog(): ReactElement {
  const { services, run } = useApp();
  const view = useStore(services.agent, (s) => s.settings);
  const error = useStore(services.agent, (s) => s.settingsError);
  const [budget, setBudget] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const close = (): void => services.ui.closeDialog();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (view) {
      setBudget(view.budgetUsd.toFixed(2));
      setBaseUrl(view.compatBaseUrl ?? "");
    }
  }, [view?.budgetUsd, view?.compatBaseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const planModels = view ? ROLES.some((r) => view.profiles.find((p) => p.id === view.models[r.id])?.billing === "subscription") : false;

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog settings" role="dialog" aria-label="Settings" data-testid="settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <Icon.Gear size={15} />
          <h2>Settings</h2>
          <span className="muted small">Design agent</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon.Close size={12} />
          </button>
        </header>
        {!view ? (
          <div className="settings-body">
            <p className="muted">{services.host.settings ? (error ?? "Loading…") : "Agent settings are only available in the desktop app."}</p>
          </div>
        ) : (
          <div className="settings-body">
            {view.transport !== "live" && (
              <div className="panel-banner" data-testid="settings-transport">
                <Icon.Info size={13} /> {view.transport === "scripted" ? "Scripted" : "Replay"} transport: the agent runs offline from a script; no model is called and keys are not used.
              </div>
            )}
            {error && (
              <div className="panel-banner warn" data-testid="settings-error">
                <Icon.Warning size={13} /> {error}
              </div>
            )}
            <ModelsSection view={view} />
            <section className="settings-section" data-testid="settings-providers">
              <h3>Models &amp; providers</h3>
              <div className="provider-group" data-testid="settings-cli-group">
                <h4>
                  CLI agents (your subscription)
                  <span className="spacer" />
                  <button type="button" className="ghost-btn tiny" data-testid="settings-recheck" onClick={() => run({ id: "settings.probeProviders", args: {} })}>
                    Re-check all
                  </button>
                </h4>
                <p className="muted small">{CLI_INTRO}</p>
                <p className="muted small">{DATA_NOTE}</p>
                {view.transport === "live" ? (view.cli ?? []).map((s) => <CliRow key={s.id} s={s} />) : <p className="muted small">Not checked in offline mode.</p>}
              </div>
              {view.transport === "live" && <LocalGroup l={view.local?.[0]} url={view.ollamaBaseUrl ?? null} profiles={view.profiles} />}
              {view.apiKeysEnabled !== false && (
                <div className="provider-group" data-testid="settings-keys">
                  <h4>
                    <Icon.Key size={13} /> API keys (optional)
                  </h4>
                  <p className="muted small">
                    Only needed for the vendors&apos; APIs, which bill per token. {view.secureStorage.detail} Keys stay in the desktop app&apos;s main and agent processes and are
                    never shown again; in development they can also come from environment variables or the repository&apos;s <code>.env</code>.
                  </p>
                  {view.providers.map((p) => (
                    <KeyRow key={p.id} p={p} storageAvailable={view.secureStorage.available} />
                  ))}
                </div>
              )}
            </section>
            <section className="settings-section two-col">
              <div>
                <h3>Budget per task</h3>
                <div className="inline-field">
                  <span className="muted">$</span>
                  <input
                    type="number"
                    min={0.01}
                    max={100}
                    step={0.25}
                    value={budget}
                    aria-label="Budget per task (USD)"
                    data-testid="settings-budget"
                    onChange={(e) => setBudget(e.target.value)}
                    onBlur={() => {
                      const usd = Number(budget);
                      if (Number.isFinite(usd) && usd >= 0.01 && usd <= 100 && usd !== view.budgetUsd) run({ id: "settings.setBudget", args: { usd } });
                    }}
                  />
                </div>
                <p className="muted small">
                  The run pauses at 80 % and asks before continuing to the cap.
                  {planModels ? " On a CLI plan the budget counts plan usage at API list prices (not billed); the plan's own limits still apply." : ""}
                </p>
              </div>
              <div>
                <h3>OpenAI-compatible base URL</h3>
                <div className="inline-field">
                  <input
                    type="url"
                    placeholder="http://localhost:8000/v1"
                    value={baseUrl}
                    aria-label="OpenAI-compatible base URL"
                    onChange={(e) => setBaseUrl(e.target.value)}
                    onBlur={() => {
                      const url = baseUrl.trim() || null;
                      if (url !== view.compatBaseUrl) run({ id: "settings.setCompatBaseUrl", args: { url } });
                    }}
                  />
                </div>
                <p className="muted small">vLLM, LM Studio, OpenRouter… Empty uses each profile&apos;s default. Ollama has its own URL above.</p>
              </div>
            </section>
            {view.transport === "live" && (
              <section className="settings-section">
                <h3>Advanced</h3>
                <label className="model-row" data-testid="settings-cli-mode">
                  <span className="model-role">
                    Agent mode for CLI providers
                    <span className="muted small">How a CLI agent runs the design loop</span>
                  </span>
                  <select value={view.cliMode ?? "auto"} aria-label="Agent mode for CLI providers" onChange={(e) => run({ id: "settings.setCliMode", args: { mode: e.target.value as CliModeSetting } })}>
                    {(Object.keys(CLI_MODE_LABEL) as CliModeSetting[]).map((m) => (
                      <option key={m} value={m}>
                        {CLI_MODE_LABEL[m]}
                      </option>
                    ))}
                  </select>
                  <span />
                </label>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
