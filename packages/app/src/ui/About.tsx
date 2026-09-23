import { useEffect, useState, type ReactElement } from "react";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";

/**
 * Where recipients of this build can get its source code (MPL-2.0 §3.2(a) asks every executable
 * distribution to say so). PLACEHOLDER: the repository has no public remote yet. Replace the URL and
 * set {@link SOURCE_CODE_URL_IS_PLACEHOLDER} to false when it has one. `.invalid` is reserved
 * (RFC 2606), so the placeholder can never resolve to someone else's site.
 */
export const SOURCE_CODE_URL = "https://example.invalid/aicad";
export const SOURCE_CODE_URL_IS_PLACEHOLDER = true;

/** Files written next to `index.html` by the production build (packages/app/vite.config.ts). */
const TEXT_FILES = {
  license: { file: "LICENSE.txt", title: "aicad license (MPL-2.0)" },
  notices: { file: "THIRD_PARTY_NOTICES.txt", title: "Third-party notices" },
} as const;

type TextView = keyof typeof TEXT_FILES;
type LoadState = { status: "loading" } | { status: "ok"; text: string } | { status: "missing"; detail: string };

/** Loads a notices file shipped with the web bundle (same origin; plain text only). */
function useShippedText(file: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetch(new URL(file, document.baseURI).href)
      .then(async (res) => {
        const type = res.headers.get("content-type") ?? "";
        // A dev server answers unknown paths with index.html: only real text files count.
        if (!res.ok || !type.startsWith("text/plain")) throw new Error(`${file} is not part of this build (HTTP ${res.status}, ${type || "no type"})`);
        return res.text();
      })
      .then(
        (text) => live && setState({ status: "ok", text }),
        (e: unknown) =>
          live &&
          setState({
            status: "missing",
            detail: `${e instanceof Error ? e.message : String(e)}. The production build writes it (pnpm --filter @aicad/app build); the Vite dev server does not.`,
          }),
      );
    return () => {
      live = false;
    };
  }, [file]);
  return state;
}

function LicenseText({ view }: { view: TextView }): ReactElement {
  const state = useShippedText(TEXT_FILES[view].file);
  if (state.status === "loading") return <p className="muted small license-status">Loading {TEXT_FILES[view].file}…</p>;
  if (state.status === "missing") return <p className="muted small license-status" data-testid="license-missing">{state.detail}</p>;
  return (
    <pre className="license-text" data-testid="license-text" tabIndex={0} aria-label={TEXT_FILES[view].title}>
      {state.text}
    </pre>
  );
}

export function AboutDialog(): ReactElement {
  const { services } = useApp();
  const info = useStore(services.ui, (s) => s.appInfo);
  const engines = useStore(services.engines, (s) => s.candidates);
  const active = useStore(services.engines, (s) => s.active);
  const viewport = useStore(services.ui, (s) => s.viewport);
  const [view, setView] = useState<"about" | TextView>("about");
  const close = (): void => services.ui.closeDialog();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const rows: Array<[string, string]> = [
    ["Version", info?.version ?? "—"],
    ["Electron / Chrome / Node", info ? `${info.electron} / ${info.chrome} / ${info.node}` : "—"],
    ["Platform", info ? `${info.platform} ${info.arch}` : "—"],
    ["Cross-origin isolated", String(globalThis.crossOriginIsolated === true)],
    ["Active engine", `${active.label} — ${active.detail}`],
    ...engines.map((c): [string, string] => [`Engine: ${c.id}`, `${c.available === null ? "not probed" : c.available ? "available" : "unavailable"} — ${c.detail}`]),
    ["Viewport", `${viewport.kind} · ${viewport.backend}`],
  ];
  return (
    <div className="overlay" onMouseDown={close}>
      <div className={`dialog about${view === "about" ? "" : " about-text"}`} role="dialog" aria-label="About aicad" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          {view === "about" ? (
            <>
              <Icon.Cube size={15} />
              <h2>aicad</h2>
              <span className="muted small">AI-native CAD · app shell spike</span>
            </>
          ) : (
            <>
              <button type="button" className="ghost-btn tiny" onClick={() => setView("about")} data-testid="about-back">
                ‹ About
              </button>
              <h2>{TEXT_FILES[view].title}</h2>
            </>
          )}
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon.Close size={12} />
          </button>
        </header>
        {view === "about" ? (
          <>
            <dl className="about-grid">
              {rows.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <section className="about-licenses" aria-label="Licenses" data-testid="about-licenses">
              <p className="small">
                aicad is free software under the Mozilla Public License 2.0. CadScript, the file format and the SDK are Apache-2.0. It includes third-party software under
                their own licenses.
              </p>
              <p className="small" data-testid="about-source">
                Source code: <code>{SOURCE_CODE_URL}</code>
                {SOURCE_CODE_URL_IS_PLACEHOLDER && <span className="muted"> (placeholder: the public repository address is not published yet)</span>}
              </p>
              <div className="about-actions">
                <button type="button" className="ghost-btn" onClick={() => setView("license")} data-testid="about-license">
                  License (MPL-2.0)
                </button>
                <button type="button" className="ghost-btn" onClick={() => setView("notices")} data-testid="about-notices">
                  Third-party notices
                </button>
              </div>
            </section>
          </>
        ) : (
          <LicenseText view={view} />
        )}
      </div>
    </div>
  );
}
