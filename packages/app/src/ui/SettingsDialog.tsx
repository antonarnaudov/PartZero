/**
 * Settings: API keys (bring your own; stored encrypted by the desktop main process, never shown
 * again), the model per agent role from the gateway's profile registry, the per-task budget and the
 * base URL for OpenAI-compatible endpoints. Every change goes through a `settings.*` command.
 */
import { useEffect, useState, type ReactElement } from "react";
import type { AgentRoleId, ModelProfileInfo, ProviderId, ProviderKeyStatus } from "../agent-protocol";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";

const ROLES: Array<{ id: AgentRoleId; label: string; hint: string }> = [
  { id: "designer", label: "Designer", hint: "Main loop: plan, build, repair" },
  { id: "spec_writer", label: "Spec writer", hint: "Writes the spec and frozen tests" },
  { id: "triage", label: "Triage", hint: "Small, fast router" },
  { id: "judge", label: "Judge", hint: "Visual review (different family than the designer)" },
];

const SOURCE_LABEL: Record<string, string> = { keychain: "saved in the OS keychain", env: "from the environment", dotenv: "from .env (development)" };

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
            "Not set"
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

function groupByProvider(profiles: readonly ModelProfileInfo[]): Array<[string, ModelProfileInfo[]]> {
  const m = new Map<string, ModelProfileInfo[]>();
  for (const p of profiles) m.set(p.provider, [...(m.get(p.provider) ?? []), p]);
  return [...m.entries()];
}

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

  const profileName = (id: string): string => view?.profiles.find((p) => p.id === id)?.name ?? id;
  const providerOf = (id: string): ProviderId | undefined => view?.profiles.find((p) => p.id === id)?.provider;
  const keyMissing = (role: AgentRoleId): boolean => {
    if (!view || view.transport !== "live" || role === "judge") return false;
    const prov = providerOf(view.models[role]);
    const p = view.providers.find((x) => x.id === prov);
    return !!p && p.keyRequired && !p.configured;
  };

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
                <Icon.Info size={13} /> {view.transport === "scripted" ? "Scripted" : "Replay"} transport: the agent runs offline from a script; no API calls are made and keys are not used.
              </div>
            )}
            {error && (
              <div className="panel-banner warn" data-testid="settings-error">
                <Icon.Warning size={13} /> {error}
              </div>
            )}
            <section className="settings-section">
              <h3>
                <Icon.Key size={13} /> API keys
              </h3>
              <p className="muted small">
                {view.secureStorage.available ? view.secureStorage.detail : view.secureStorage.detail} Keys stay in the desktop app's main and agent processes and are never shown
                again; in development they can also come from environment variables or the repository&apos;s <code>.env</code>.
              </p>
              {view.providers.map((p) => (
                <KeyRow key={p.id} p={p} storageAvailable={view.secureStorage.available} />
              ))}
            </section>
            <section className="settings-section">
              <h3>Models</h3>
              {ROLES.map((r) => {
                const current = view.models[r.id];
                const isDefault = current === view.defaults[r.id];
                return (
                  <label key={r.id} className="model-row" data-testid="settings-model" data-role={r.id}>
                    <span className="model-role">
                      {r.label}
                      <span className="muted small">{r.hint}</span>
                    </span>
                    <select
                      value={isDefault ? "" : current}
                      aria-label={`${r.label} model`}
                      onChange={(e) => run({ id: "settings.setModel", args: { role: r.id, model: e.target.value === "" ? null : e.target.value } })}
                    >
                      <option value="">Default ({profileName(view.defaults[r.id])})</option>
                      {groupByProvider(view.profiles).map(([provider, list]) => (
                        <optgroup key={provider} label={view.providers.find((p) => p.id === provider)?.label ?? provider}>
                          {list.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {keyMissing(r.id) && <span className="model-warn">needs a key</span>}
                  </label>
                );
              })}
              {view.warnings.map((w) => (
                <div key={w} className="dep-warning warning">
                  <Icon.Warning size={12} /> {w}
                </div>
              ))}
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
                <p className="muted small">The run pauses at 80 % and asks before continuing to the cap.</p>
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
                <p className="muted small">vLLM, Ollama, OpenRouter… Empty uses each profile&apos;s default.</p>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
