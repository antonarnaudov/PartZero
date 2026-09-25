/**
 * The welcome screen (ALPHA-0-PLAN W2, the golden path's first step): shown over the empty viewport
 * of a new document. New, Open and Recent; the five starter parts as prompt chips (and their
 * ready-made examples where Forge already builds them); the agent's provider and the printer, each
 * with its exact fix when it is not ready; and the build identity.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { CliProviderStatus, PrintProfileView, SlicerInfo } from "../../bridge";
import { baseName } from "../../host/host";
import { isBlankDocument } from "../../tools/shell";
import { exampleAvailability, openExample, STARTERS, type ExampleAvailability, type Starter } from "../../tools/starters";
import { useApp, useStore } from "../context";
import { Icon } from "../icons";
import { BrandMark, BRAND_NAME } from "./BrandMark";
import { useShell } from "./context";

type Load<T> = { status: "loading" } | { status: "ok"; value: T } | { status: "error"; message: string };

function Status({ tone, children, testId }: { tone: "ok" | "warn" | "error" | "busy"; children: React.ReactNode; testId: string }): ReactElement {
  return (
    <div className={`wl-status tone-${tone}`} data-testid={testId} data-tone={tone}>
      {tone === "busy" ? <Icon.Spinner size={12} /> : <span className="dot" />}
      <div className="wl-status-body">{children}</div>
    </div>
  );
}

/** The design agent's provider: Claude Code first (the Alpha 0 path), then whatever the routing picked. */
function ProviderStatus(): ReactElement {
  const { services, run } = useApp();
  const available = useStore(services.agent, (s) => s.available);
  const settings = useStore(services.agent, (s) => s.settings);
  const settingsError = useStore(services.agent, (s) => s.settingsError);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (available && !settings) void services.agent.refreshSettings().catch(() => undefined);
  }, [available, settings, services]);

  const recheck = (): void => {
    setChecking(true);
    void services.agent
      .probeProviders(["claude-cli"])
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  if (!available) {
    return (
      <Status tone="warn" testId="welcome-provider">
        <strong>Design agent</strong>
        <span>Runs in the desktop app. Here you can model and edit code.</span>
      </Status>
    );
  }
  if (checking || (!settings && !settingsError)) {
    return (
      <Status tone="busy" testId="welcome-provider">
        <strong>Design agent</strong>
        <span>Checking Claude Code…</span>
      </Status>
    );
  }
  if (!settings) {
    return (
      <Status tone="error" testId="welcome-provider">
        <strong>Design agent</strong>
        <span>{settingsError ?? "Could not read the agent settings."}</span>
        <div className="wl-actions">
          <button type="button" className="ghost-btn tiny" onClick={recheck}>
            Re-check
          </button>
        </div>
      </Status>
    );
  }
  const claude: CliProviderStatus | undefined = settings.cli?.find((c) => c.id === "claude-cli");
  const designer = settings.models.designer;
  const model = settings.profiles.find((p) => p.id === designer)?.name ?? designer;
  const recheckButton = (
    <button type="button" className="ghost-btn tiny" onClick={recheck} data-testid="welcome-recheck">
      Re-check
    </button>
  );
  if (claude && claude.support === "ready" && claude.auth !== "logged_out") {
    return (
      <Status tone="ok" testId="welcome-provider">
        <strong>Using Claude Code (your plan) · ready</strong>
        <span>{[claude.version ? `Claude Code ${claude.version}` : null, model, claude.plan ? `${claude.plan[0]!.toUpperCase()}${claude.plan.slice(1)} plan` : null].filter(Boolean).join(" · ")}</span>
      </Status>
    );
  }
  if (claude && claude.support === "ready" && claude.auth === "logged_out") {
    return (
      <Status tone="warn" testId="welcome-provider">
        <strong>Claude Code needs a login</strong>
        <span>{claude.loginHint || "Run `claude auth login` in Terminal"}, then Re-check.</span>
        <div className="wl-actions">{recheckButton}</div>
      </Status>
    );
  }
  const auto = settings.autoDefault;
  if (auto && auto.provider !== "claude-cli") {
    return (
      <Status tone="ok" testId="welcome-provider">
        <strong>Using {auto.label}</strong>
        <span className="mono">{model}</span>
        {claude && <span className="muted">Claude Code: {claude.supportDetail || claude.support.replace("_", " ")}</span>}
      </Status>
    );
  }
  const notInstalled = !claude || claude.support === "not_installed";
  return (
    <Status tone="error" testId="welcome-provider">
      <strong>{notInstalled ? "Claude Code not found" : `Claude Code ${claude.support === "blocked" ? "is blocked" : "is not supported"}`}</strong>
      <span>
        {notInstalled
          ? "Install Claude Code and log in (claude auth login), or set its path in Settings. The agent runs on your plan; no API key is needed."
          : claude.supportDetail}
      </span>
      <div className="wl-actions">
        {recheckButton}
        <button type="button" className="ghost-btn tiny" onClick={() => run({ id: "settings.open" })}>
          Open Settings
        </button>
      </div>
    </Status>
  );
}

function PrinterStatus(): ReactElement {
  const { services } = useApp();
  const print = services.host.print ?? null;
  const [profile, setProfile] = useState<Load<PrintProfileView>>({ status: "loading" });
  const [slicer, setSlicer] = useState<Load<SlicerInfo>>({ status: "loading" });
  const load = useCallback(() => {
    if (!print) return;
    setSlicer({ status: "loading" });
    print.profile().then(
      (value) => setProfile({ status: "ok", value }),
      (e: unknown) => setProfile({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    print.detectSlicer().then(
      (value) => setSlicer({ status: "ok", value }),
      (e: unknown) => setSlicer({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
  }, [print]);
  useEffect(load, [load]);

  if (!print) {
    return (
      <Status tone="warn" testId="welcome-printer">
        <strong>Printer</strong>
        <span>Printing hands off to Bambu Studio in the desktop app. Export 3MF works here.</span>
      </Status>
    );
  }
  const summary = profile.status === "ok" ? profile.value.summary : profile.status === "loading" ? "Reading the printer profile…" : profile.message;
  const s = slicer.status === "ok" ? slicer.value : null;
  const tone = profile.status === "error" ? "error" : slicer.status === "loading" || profile.status === "loading" ? "busy" : s?.found ? "ok" : "warn";
  return (
    <Status tone={tone} testId="welcome-printer">
      <strong>Printer: {summary}</strong>
      {s && s.found && <span>{`${s.name}${s.version ? ` ${s.version}` : ""} · ready for Open in Bambu Studio`}</span>}
      {s && !s.found && (
        <span>
          {s.name} not found{s.reason ? `: ${s.reason}` : ""}. {s.fix ?? "Prints are saved to ~/PartZero/Prints; open them in your slicer."}
        </span>
      )}
      {slicer.status === "error" && <span>{slicer.message}</span>}
      {s && !s.found && (
        <div className="wl-actions">
          <button type="button" className="ghost-btn tiny" onClick={load}>
            Re-check
          </button>
        </div>
      )}
    </Status>
  );
}

function StarterCard({ starter }: { starter: Starter }): ReactElement {
  const { services, run } = useApp();
  const available = useStore(services.agent, (s) => s.available);
  const busy = useStore(services.agent, (s) => s.activeRunId !== null);
  const [example, setExample] = useState<ExampleAvailability>(starter.source ? { status: "checking" } : { status: "unavailable", reason: starter.needs ?? "" });
  useEffect(() => {
    let live = true;
    void exampleAvailability(services, starter).then((a) => live && setExample(a));
    return () => {
      live = false;
    };
  }, [services, starter]);

  const ask = (): void => {
    services.ui.setPanel("right", true);
    services.ui.setPanel("chat", true);
    run({ id: "chat.send", args: { text: starter.prompt } });
  };
  const open = (): void => {
    void openExample(services, starter).then((r) => {
      if (!r.opened && r.reason && r.reason !== "cancelled") services.ui.toast("error", `Could not open the example: ${r.reason}`);
    });
  };

  return (
    <li className="wl-starter" data-testid="welcome-starter" data-starter={starter.id}>
      <div className="wl-starter-text">
        <span className="wl-starter-title">{starter.title}</span>
        <span className="wl-starter-blurb">{starter.blurb}</span>
      </div>
      <div className="wl-starter-actions">
        <button
          type="button"
          className="chip-btn"
          title={available ? starter.prompt : "The design agent runs in the desktop app"}
          disabled={busy}
          onClick={ask}
          data-testid="starter-ask"
        >
          <Icon.Sparkle size={12} /> Ask the agent
        </button>
        {example.status === "ready" && (
          <button type="button" className="chip-btn" title={starter.exampleNote ?? "Open the ready-made, parametric part"} onClick={open} data-testid="starter-open">
            <Icon.FolderOpen size={12} /> Open example
          </button>
        )}
        {example.status === "checking" && <span className="wl-note">Checking example…</span>}
        {example.status === "unavailable" && starter.source && (
          <span className="wl-note" data-testid="starter-example-note" title={`The ready-made example ${example.reason}.`}>
            Example ready; opens with IR v1
          </span>
        )}
      </div>
    </li>
  );
}

export function Welcome(): ReactElement {
  const { services, run, isMac } = useApp();
  const { shell } = useShell();
  const recent = useStore(services.ui, (s) => s.recentFiles);
  const info = useStore(services.ui, (s) => s.appInfo);
  const build = info?.build;
  const identity = [
    info ? `v${info.version}` : null,
    build?.commit ? `${build.commit.slice(0, 7)}${build.dirty ? "+" : ""}` : null,
    build && build.edition !== "default" ? build.edition : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const mod = isMac ? "⌘" : "Ctrl+";

  return (
    <div className="welcome" role="dialog" aria-label={`Welcome to ${BRAND_NAME}`} data-testid="welcome">
      <header className="wl-head">
        <BrandMark size={44} />
        <div className="wl-title">
          <h1>{BRAND_NAME}</h1>
          <span className="wl-sub">Describe a part, or model it yourself. Forge checks every change.</span>
        </div>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close the welcome screen" onClick={() => shell.dismissWelcome()} data-testid="welcome-close">
          <Icon.Close size={12} />
        </button>
      </header>

      <div className="wl-grid">
        <section className="wl-col" aria-label="Start">
          <h2>Start</h2>
          <div className="wl-start">
            <button
              type="button"
              className="wl-action"
              onClick={() => {
                if (isBlankDocument(services)) {
                  shell.dismissWelcome();
                  return;
                }
                void shell.execute({ id: "file.new" }).then((r) => {
                  if (r.ok && (r.value as { created?: boolean }).created) shell.dismissWelcome();
                });
              }}
              data-testid="welcome-new"
            >
              <Icon.File size={15} />
              <span>New part</span>
              <kbd>{mod}N</kbd>
            </button>
            <button type="button" className="wl-action" onClick={() => run({ id: "file.open" })} data-testid="welcome-open">
              <Icon.FolderOpen size={15} />
              <span>Open…</span>
              <kbd>{mod}O</kbd>
            </button>
          </div>
          <h2>Recent</h2>
          {recent.length === 0 ? (
            <p className="wl-empty">Nothing yet. Saved parts show up here.</p>
          ) : (
            <ul className="wl-recent" data-testid="welcome-recent">
              {recent.slice(0, 6).map((p) => (
                <li key={p}>
                  <button type="button" title={p} onClick={() => run({ id: "file.openRecent", args: { path: p } })}>
                    <span className="wl-recent-name">{baseName(p)}</span>
                    <span className="wl-recent-dir mono">{p.slice(0, Math.max(0, p.length - baseName(p).length - 1))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h2>Status</h2>
          <ProviderStatus />
          <PrinterStatus />
        </section>

        <section className="wl-col" aria-label="Starter parts">
          <h2>Starter parts</h2>
          <p className="wl-lede">Ask the agent to design one of these, then change it by hand or with its parameters.</p>
          <ul className="wl-starters">
            {STARTERS.map((s) => (
              <StarterCard key={s.id} starter={s} />
            ))}
          </ul>
        </section>
      </div>

      <footer className="wl-foot">
        <span className="mono" data-testid="welcome-build">
          {BRAND_NAME} {identity}
        </span>
        <span className="spacer" />
        <button type="button" className="link-btn" onClick={() => run({ id: "view.commandPalette" })}>
          All commands <kbd>{mod}K</kbd>
        </button>
        <button type="button" className="link-btn" onClick={() => void shell.execute({ id: "help.shortcuts" })}>
          Shortcuts <kbd>?</kbd>
        </button>
      </footer>
    </div>
  );
}
