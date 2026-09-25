/**
 * Settings → Printing (ALPHA-0-PLAN W5): the active printer and material, where prints go, and
 * the Bambu Studio that "Open in Bambu Studio" hands files to, with its path override (G2a a8).
 * Desktop only. It talks to the print bridge directly until `settings.setSlicerPath` exists in
 * the command layer (`commands/commands.ts` is open in IR v1 Phase C).
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { PrintProfileView, SlicerInfo } from "../bridge";
import { useApp } from "./context";

function n(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** Plain words for the profile fields a person still has to check. */
const FIELD_LABEL: Record<string, string> = {
  bed: "bed size",
  nozzle: "nozzle size",
  nozzleMaterial: "nozzle material",
  chamberHeater: "chamber heater",
  exclusionZones: "areas of the bed to avoid",
};

export function PrintingSection(): ReactElement | null {
  const { services } = useApp();
  const print = services.host.print ?? null;
  const [profile, setProfile] = useState<PrintProfileView | null>(null);
  const [slicer, setSlicer] = useState<SlicerInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((p: Promise<SlicerInfo>) => {
    setError(null);
    p.then(setSlicer).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!print) return;
    print.profile().then(setProfile, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    apply(print.detectSlicer());
  }, [print, apply]);

  if (!print) return null;
  const save = (): void => {
    const p = path.trim();
    apply(print.setSlicerPath(p === "" ? null : p));
    setEditing(false);
  };
  const printer = profile?.printer;
  const usable = printer ? `${n(printer.bed.x - 2 * printer.bedMargin)} × ${n(printer.bed.y - 2 * printer.bedMargin)} mm` : "";

  return (
    <section className="settings-section" data-testid="settings-printing">
      <h3>Printing</h3>
      {profile && printer && (
        <div className="provider-row">
          <div className="provider-head">
            <span className="key-name">{profile.summary}</span>
          </div>
          <div className="muted small">
            Bed {n(printer.bed.x)} × {n(printer.bed.y)} × {n(printer.bed.z)} mm; parts must fit {usable} ({n(printer.bedMargin)} mm kept free per side). Clearances for{" "}
            {profile.material.name} ({profile.material.clearanceSource} values): press {n(profile.material.clearances.press)}, slip {n(profile.material.clearances.slip)}, running{" "}
            {n(profile.material.clearances.running)} mm.
          </div>
          {printer.unverified.length > 0 && (
            <div className="provider-detail small">
              From the public spec sheet, not yet checked on your printer: {printer.unverified.map((f) => FIELD_LABEL[f] ?? f).join(", ")}.
            </div>
          )}
          <div className="provider-path small">
            Prints go to <span className="mono selectable">{profile.printsDir}</span>
          </div>
        </div>
      )}
      <div className="provider-row" data-testid="settings-slicer" data-found={slicer ? String(slicer.found) : undefined}>
        <div className="provider-head">
          <span className="key-name">Bambu Studio</span>
          {slicer && <span className={`provider-badge badge-${slicer.found ? "ok" : "warn"}`}>{slicer.found ? "found" : "not found"}</span>}
          {slicer?.version && <span className="mono muted small">{slicer.version}</span>}
          <span className="spacer" />
          <button type="button" className="ghost-btn tiny" onClick={() => apply(print.detectSlicer())}>
            Re-check
          </button>
        </div>
        {slicer && !slicer.found && (
          <div className="provider-detail small">
            {slicer.reason} {slicer.fix}
          </div>
        )}
        {slicer?.path && !editing && (
          <div className="provider-path small">
            <span className="mono" title={slicer.path}>
              {slicer.path}
            </span>{" "}
            <span className="muted">({slicer.customPath ? "set here" : "found"})</span>{" "}
            <button type="button" className="link-btn" onClick={() => (setPath(slicer.customPath ?? ""), setEditing(true))}>
              Change…
            </button>
          </div>
        )}
        {slicer && !slicer.path && !editing && (
          <button type="button" className="link-btn small" onClick={() => setEditing(true)}>
            Set its path…
          </button>
        )}
        {editing && (
          <div className="key-input">
            <input
              type="text"
              spellCheck={false}
              placeholder="/Applications/BambuStudio.app"
              aria-label="Bambu Studio path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
            <button type="button" className="primary-btn small" onClick={save}>
              Save
            </button>
            {slicer?.customPath && (
              <button type="button" className="ghost-btn" onClick={() => (setPath(""), apply(print.setSlicerPath(null)), setEditing(false))}>
                Use automatic
              </button>
            )}
            <button type="button" className="ghost-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        )}
        {error && <div className="provider-detail small">{error}</div>}
        <p className="muted small">
          PartZero opens your own Bambu Studio with the file and never ships or changes a slicer. In Bambu Studio, pick your printer and filament, then slice and print as usual.
        </p>
      </div>
    </section>
  );
}
