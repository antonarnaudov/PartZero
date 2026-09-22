import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseIrDocument, type IrDocument } from "@aicad/ir-types";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CORPUS_PROGRAMS = `${REPO_ROOT}corpus/programs/`;
export const CORPUS_CADSCRIPT = `${REPO_ROOT}corpus/cadscript/`;

export interface CorpusProgram {
  stem: string;
  ir: IrDocument;
}

export function corpusPrograms(): CorpusProgram[] {
  return readdirSync(CORPUS_PROGRAMS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ stem: f.replace(/\.json$/, ""), ir: parseIrDocument(readFileSync(`${CORPUS_PROGRAMS}${f}`, "utf8")) }));
}

export const HEADER = 'import { doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ } from "@aicad/std";\n';

/** Prefix a body with the canonical import. */
export function src(body: string): string {
  return `${HEADER}\n${body}`;
}
