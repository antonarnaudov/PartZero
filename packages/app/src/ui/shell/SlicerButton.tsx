/**
 * "Open in Bambu Studio" (ALPHA-0-PLAN W3/W5), the window's primary action: a split button over the
 * `file.openInSlicer { format }` command (⌘P). The main part sends the last chosen format; the
 * chevron offers the choice the owner asked for: **3MF, print-ready** (meshes at 0.01 mm / 5°,
 * centred on the printer's bed; the default) or **STEP, exact geometry** (Bambu Studio 02.06 imports
 * STEP and tessellates it with its own precision). The choice is remembered per machine. Desktop only.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { SlicerFormat } from "../../bridge";
import { formatKey } from "../../commands/registry";
import { useApp } from "../context";
import { Icon } from "../icons";
import { useShell } from "./context";

const FORMAT_KEY = "pz.slicerFormat";

function loadFormat(): SlicerFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === "step" ? "step" : "3mf";
  } catch {
    return "3mf";
  }
}

function saveFormat(f: SlicerFormat): void {
  try {
    localStorage.setItem(FORMAT_KEY, f);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}

const CHOICES: ReadonlyArray<{ format: SlicerFormat; title: string; detail: string }> = [
  { format: "3mf", title: "3MF · print-ready", detail: "Meshes at 0.01 mm and 5°, centred on the printer's bed. Recommended." },
  { format: "step", title: "STEP · exact geometry", detail: "The exact shapes. Bambu Studio meshes them on import and places the part." },
];

export function OpenInSlicerButton(): ReactElement | null {
  const { services, isMac } = useApp();
  const { shell } = useShell();
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<SlicerFormat>(loadFormat);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLButtonElement>(".sb-choice")?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!services.host.print) return null;

  const send = (f: SlicerFormat): void => {
    setOpen(false);
    setBusy(true);
    void shell.execute({ id: "file.openInSlicer", args: { format: f } }, "ui").finally(() => setBusy(false));
  };
  const choose = (f: SlicerFormat): void => {
    setFormat(f);
    saveFormat(f);
    send(f);
  };
  const key = formatKey("Mod+P", isMac);
  const title =
    format === "step"
      ? `Check the part, save it as STEP (exact geometry) to ~/PartZero/Prints and open it in Bambu Studio (${key})`
      : `Check the part, save a print-ready 3MF to ~/PartZero/Prints centred on the printer's bed, and open it in Bambu Studio (${key})`;
  return (
    <div className="split-btn" ref={ref} data-format={format}>
      <button type="button" className="tb-primary sb-main" title={title} disabled={busy} aria-busy={busy} onClick={() => send(format)} data-testid="open-in-slicer">
        {busy ? <Icon.Spinner size={14} /> : <Icon.Printer size={14} />}
        <span>Open in Bambu Studio</span>
        {format === "step" && (
          <span className="sb-badge" data-testid="open-in-slicer-format">
            STEP
          </span>
        )}
      </button>
      <button
        type="button"
        className="tb-primary sb-more"
        aria-label="Choose what Bambu Studio gets"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
        data-testid="open-in-slicer-menu"
      >
        <Icon.Chevron size={10} />
      </button>
      {open && (
        <div className="sb-menu" role="menu" aria-label="Send to Bambu Studio as" data-testid="open-in-slicer-choices">
          {CHOICES.map((c) => (
            <button
              key={c.format}
              type="button"
              role="menuitemradio"
              aria-checked={c.format === format}
              className={`sb-choice${c.format === format ? " current" : ""}`}
              onClick={() => choose(c.format)}
              data-testid={`slicer-format-${c.format}`}
            >
              <span className="sb-check" aria-hidden="true">
                {c.format === format ? <Icon.Check size={12} /> : null}
              </span>
              <span className="sb-text">
                <span className="sb-title">{c.title}</span>
                <span className="sb-detail">{c.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
