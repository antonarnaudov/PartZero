/**
 * The machine profile library (ALPHA-0-PLAN W5): the built-in printer and material profiles, and
 * `<userData>/machine-profiles.json`, which the main process owns and writes atomically.
 *
 * Alpha 0 (drop 0.1) ships one printer and one material:
 * - `builtin:bambu-p2s-0.4`, the Bambu Lab P2S with its 0.4 mm nozzle. The numbers come from
 *   Bambu Lab's public P2S spec sheet (read 2026-09-24, ALPHA-0-PLAN as5), **not** from any
 *   slicer's bundled profiles (ADR 0016 §3), and are not yet checked on the owner's machine: every
 *   such field is listed in `unverified` until the day-0 check (ALPHA-0-PLAN §4.2).
 * - `builtin:pla`, PLA design defaults. The clearances are the plan's starting values (as6), not
 *   measurements: the Fit Lab (drop 0.2) replaces them.
 *
 * The file holds the user's choices, not the built-ins: the selected printer and material and the
 * slicer path set in Settings. A missing or unreadable file means the defaults; it is rewritten on
 * the next change. Drop 0.2 adds the material library and Fit Lab readings here.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { MaterialProfileView, PrinterProfileView, PrintProfileView } from "@aicad/app/bridge";

/** A printer profile (drop 0.1: the built-in P2S). */
export interface MachineProfile extends PrinterProfileView {
  process: "fdm";
  /** Nozzle material, for the agent's context. */
  nozzleMaterial: string;
  /** Whether the printer heats its chamber (affects which materials it prints well). */
  chamberHeater: boolean;
  /** Areas of the bed no part may cover, in bed coordinates (mm). None known for the P2S yet. */
  exclusionZones: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  /** Tessellation for printing (ALPHA-0-PLAN W5): chordal deviation (mm) and angle (rad). */
  printTessellation: { deflection: number; angular: number };
  /** Where the numbers come from. */
  source: { kind: "builtin"; reference: string; read: string };
}

/** A material profile (drop 0.1: built-in PLA defaults). */
export interface MaterialProfile extends MaterialProfileView {
  /** Layer height the clearances assume, mm. */
  clearanceLayerHeight: number;
  /** One line for the agent. */
  note: string;
  /** Values that are starting points rather than measurements. */
  unverified: string[];
}

/** The Bambu Lab P2S, 0.4 mm nozzle (ALPHA-0-PLAN §2.2 G1 #6, as5). */
export const BUILTIN_P2S: MachineProfile = Object.freeze({
  id: "builtin:bambu-p2s-0.4",
  version: 1,
  name: "Bambu Lab P2S",
  process: "fdm",
  bed: Object.freeze({ x: 256, y: 256, z: 256 }),
  // Room for a brim or skirt (ALPHA-0-PLAN W5); ours, not the printer's.
  bedMargin: 10,
  nozzle: 0.4,
  nozzleMaterial: "hardened steel",
  chamberHeater: false,
  exclusionZones: [],
  printTessellation: Object.freeze({ deflection: 0.01, angular: 0.1 }),
  source: Object.freeze({ kind: "builtin" as const, reference: "Bambu Lab P2S public spec sheet", read: "2026-09-24" }),
  // Not checked on the owner's printer yet (day-0 check, ALPHA-0-PLAN §4.2). The exclusion zones
  // are unverified too: "none" means none is known, not that the printer has none.
  unverified: ["bed", "nozzle", "nozzleMaterial", "chamberHeater", "exclusionZones"],
}) as MachineProfile;

/** PLA design defaults (ALPHA-0-PLAN W5 table; as6: starting values, not measurements). */
export const BUILTIN_PLA: MaterialProfile = Object.freeze({
  id: "builtin:pla",
  version: 1,
  name: "PLA",
  // Diametral, for a printed pin in a printed hole, both vertical, at 0.20 mm layers. Press on
  // metal (a metal shaft in a printed hole) starts equal to press until the Fit Lab measures it.
  clearances: Object.freeze({ press: 0.05, slip: 0.2, running: 0.3, pressMetal: 0.05 }),
  clearanceSource: "default" as const,
  clearanceLayerHeight: 0.2,
  minWall: 0.8,
  // A common FDM rule of thumb, not a measurement: steeper overhangs need supports or a chamfer.
  maxOverhangDeg: 45,
  note: "Baseline",
  unverified: ["clearances", "minWall", "maxOverhangDeg"],
}) as MaterialProfile;

export const BUILTIN_PRINTERS: readonly MachineProfile[] = [BUILTIN_P2S];
export const BUILTIN_MATERIALS: readonly MaterialProfile[] = [BUILTIN_PLA];

export const PROFILE_LIBRARY_SCHEMA = "partzero.machine-profiles/1";

/** The contents of `machine-profiles.json`. */
export interface ProfileLibrary {
  schema: typeof PROFILE_LIBRARY_SCHEMA;
  /** Bumped on every write. */
  revision: number;
  /** Selected printer id. */
  printer: string;
  /** Selected material id. */
  material: string;
  /** A Bambu Studio `.app` set in Settings, overriding the search; null to search. */
  slicerPath: string | null;
}

export const DEFAULT_LIBRARY: ProfileLibrary = Object.freeze({
  schema: PROFILE_LIBRARY_SCHEMA,
  revision: 0,
  printer: BUILTIN_P2S.id,
  material: BUILTIN_PLA.id,
  slicerPath: null,
}) as ProfileLibrary;

const MAX_PATH = 1024;

/** A slicer path from Settings: absolute, a `.app` bundle, no control characters; else an error. */
export function checkSlicerPath(path: unknown): string | null {
  if (path === null) return null;
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH) throw new Error("invalid slicer path");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) throw new Error("invalid slicer path");
  const p = path.replace(/\/+$/, "");
  if (!isAbsolute(p) || !/\.app$/i.test(p)) throw new Error("the slicer path must be an absolute path to a .app bundle");
  return p;
}

function sanitize(raw: unknown): ProfileLibrary {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<ProfileLibrary>;
  let slicerPath: string | null = null;
  try {
    slicerPath = checkSlicerPath(o.slicerPath ?? null);
  } catch {
    slicerPath = null;
  }
  return {
    schema: PROFILE_LIBRARY_SCHEMA,
    revision: typeof o.revision === "number" && Number.isSafeInteger(o.revision) && o.revision >= 0 ? o.revision : 0,
    printer: typeof o.printer === "string" && BUILTIN_PRINTERS.some((p) => p.id === o.printer) ? o.printer : DEFAULT_LIBRARY.printer,
    material: typeof o.material === "string" && BUILTIN_MATERIALS.some((m) => m.id === o.material) ? o.material : DEFAULT_LIBRARY.material,
    slicerPath,
  };
}

/**
 * Write `data` to `file` atomically: a temp file in the same directory, flushed to disk, then
 * renamed over the target, so a reader sees the old file or the new one, never half of one.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = openSync(tmp, "w", 0o644);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** `<userData>/machine-profiles.json`. */
export class ProfileStore {
  constructor(
    private readonly file: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  /** The library; the defaults when the file is missing or unreadable. */
  read(): ProfileLibrary {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return { ...DEFAULT_LIBRARY };
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.warn(`${this.file} is not valid JSON; using the default printer and material`);
      return { ...DEFAULT_LIBRARY };
    }
  }

  /** Change the selection or the slicer path; writes atomically and bumps the revision. */
  update(patch: Partial<Pick<ProfileLibrary, "printer" | "material" | "slicerPath">>): ProfileLibrary {
    const cur = this.read();
    const next = sanitize({ ...cur, ...patch, revision: cur.revision + 1 });
    if (patch.slicerPath !== undefined) next.slicerPath = checkSlicerPath(patch.slicerPath);
    writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  printer(): MachineProfile {
    const id = this.read().printer;
    return BUILTIN_PRINTERS.find((p) => p.id === id) ?? BUILTIN_P2S;
  }

  material(): MaterialProfile {
    const id = this.read().material;
    return BUILTIN_MATERIALS.find((m) => m.id === id) ?? BUILTIN_PLA;
  }
}

/** A length for text: up to 2 decimals, no trailing zeros. */
function n(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** `Bambu Lab P2S · 0.4 mm · PLA`. */
export function profileSummary(printer: MachineProfile, material: MaterialProfile): string {
  return `${printer.name} · ${n(printer.nozzle)} mm · ${material.name}`;
}

/**
 * The machine, material and clearance line for the design agent's conventions (ALPHA-0-PLAN W5,
 * "Agent context"). It states the limits the export enforces and the defaults a design should use.
 */
export function agentConventionsLine(printer: MachineProfile, material: MaterialProfile): string {
  const b = printer.bed;
  const c = material.clearances;
  return [
    `Machine: ${printer.name}, FDM, ${n(printer.nozzle)} mm nozzle, bed ${n(b.x)} × ${n(b.y)} × ${n(b.z)} mm;`,
    `every part must fit ${n(b.x - 2 * printer.bedMargin)} × ${n(b.y - 2 * printer.bedMargin)} mm in X and Y and ${n(b.z)} mm in Z, modelled in print orientation (Z up, the face on the bed at z = 0).`,
    `Material: ${material.name} (${material.clearanceSource} values): diametral clearances press ${n(c.press)}, slip ${n(c.slip)}, running ${n(c.running)}, press on metal ${n(c.pressMetal)} mm;`,
    `walls at least ${n(material.minWall)} mm; overhangs up to ${n(material.maxOverhangDeg)}° from vertical print without supports.`,
  ].join(" ");
}

/** The `print:profile` view. */
export function profileView(printer: MachineProfile, material: MaterialProfile, printsDir: string): PrintProfileView {
  const printerView: PrinterProfileView = {
    id: printer.id,
    version: printer.version,
    name: printer.name,
    bed: { ...printer.bed },
    bedMargin: printer.bedMargin,
    nozzle: printer.nozzle,
    unverified: [...printer.unverified],
  };
  const materialView: MaterialProfileView = {
    id: material.id,
    version: material.version,
    name: material.name,
    clearances: { ...material.clearances },
    clearanceSource: material.clearanceSource,
    minWall: material.minWall,
    maxOverhangDeg: material.maxOverhangDeg,
  };
  return {
    printer: printerView,
    material: materialView,
    summary: profileSummary(printer, material),
    printsDir,
    agentConventions: agentConventionsLine(printer, material),
  };
}
