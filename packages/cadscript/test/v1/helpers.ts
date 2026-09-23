import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIrDocument as parseV0, v1, type IrDocument as V0Document } from "@aicad/ir-types";
import { parseV0JsonText } from "../../src/v1/v0json.js";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const V1_DIR = join(REPO_ROOT, "corpus/v1");
export const V1_PROGRAMS = join(V1_DIR, "programs");
export const V1_CADSCRIPT = join(V1_DIR, "cadscript");
export const CONFORMANCE = join(V1_DIR, "conformance");
export const MIGRATION = join(CONFORMANCE, "migration");
export const MAKERBENCH = join(REPO_ROOT, "corpus/makerbench");

export const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
export const readText = (p: string): string => readFileSync(p, "utf8");

export interface V1Program {
  stem: string;
  path: string;
  text: string;
  ir: v1.IrDocument;
}

/** The canonical v1 example programs (corpus/v1/programs). */
export function v1Programs(): V1Program[] {
  return readdirSync(V1_PROGRAMS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const path = join(V1_PROGRAMS, f);
      const text = readText(path);
      return { stem: f.replace(/\.json$/, ""), path, text, ir: v1.parseIrDocument(JSON.parse(text)) };
    });
}

export interface MigrationPair {
  group: string;
  stem: string;
  v0: V0Document;
  v1Text: string;
  v1: v1.IrDocument;
  renamesPath: string;
}

/** Every `<name>.v0.json` → `<name>.v1.json` pair of the migration fixtures. */
export function migrationPairs(): MigrationPair[] {
  const out: MigrationPair[] = [];
  for (const group of ["programs", "makerbench", "renames"]) {
    const dir = join(CONFORMANCE, "migration", group);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".v0.json")).sort()) {
      const stem = f.replace(/\.v0\.json$/, "");
      const v1Text = readText(join(dir, `${stem}.v1.json`));
      out.push({
        group,
        stem,
        v0: parseV0(parseV0JsonText(readText(join(dir, f)))),
        v1Text,
        v1: v1.parseIrDocument(JSON.parse(v1Text)),
        renamesPath: join(dir, `${stem}.renames.json`),
      });
    }
  }
  return out;
}
