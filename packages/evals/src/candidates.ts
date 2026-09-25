/**
 * Hand-written **candidates** of MakerBench tasks: solutions an agent could plausibly write,
 * each with the verdict the hidden tests must reach. They pin what the mutations cannot express:
 *
 * - `fail`: a wrong part that a weak test would let through — a counterbore drilled from the
 *   bottom, a chamfer on the wrong edge, a pattern started on the wrong axis, a fillet that now
 *   rounds different edges after an edit;
 * - `pass`: a correct part built another way than the reference — a circular pattern about the
 *   bore's cylinder instead of Z, hole positions marked with sketch circles — which a check that
 *   measures how the model was built would wrongly fail.
 *
 * Files live next to the tasks in `candidates/<task id>--<label>.cad.ts`. The first line states
 * the verdict and the reason: `// expect: fail — <what is wrong>` or `// expect: pass — <why it
 * is right>`. Fixtures record their reports like the references' (`candidate:<label>`), and
 * `v1-candidates.test.ts` scores every one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoadedTask } from "./task.js";

export const CANDIDATES_DIR = "candidates";
const SUFFIX = ".cad.ts";

export interface TaskCandidate {
  /** The task id (the file name before `--`). */
  task: string;
  /** The label (the file name after `--`). */
  label: string;
  /** The verdict the hidden tests must reach. */
  expect: "pass" | "fail";
  /** Why (the first line after the verdict). */
  why: string;
  source: string;
  /** Absolute path. */
  file: string;
}

const HEADER = /^\/\/ expect: (pass|fail) — (.+)$/;

/** Parse one candidate file; throws on a malformed name or header. */
export function readCandidate(file: string): TaskCandidate {
  const name = file.split(/[\\/]/).pop()!;
  const m = /^(.+)--([a-z0-9_-]+)\.cad\.ts$/.exec(name);
  if (!m) throw new Error(`${name}: a candidate is named <task id>--<label>.cad.ts`);
  const source = readFileSync(file, "utf8");
  const h = HEADER.exec(source.split("\n", 1)[0]!.trim());
  if (!h) throw new Error(`${name}: the first line must be "// expect: pass — <why>" or "// expect: fail — <why>"`);
  return { task: m[1]!, label: m[2]!, expect: h[1] as "pass" | "fail", why: h[2]!, source, file };
}

/** Every candidate in `<tasksDir>/candidates`, sorted by file name. */
export function loadCandidates(tasksDir: string): TaskCandidate[] {
  const dir = join(tasksDir, CANDIDATES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(SUFFIX))
    .sort()
    .map((f) => readCandidate(join(dir, f)));
}

/** The candidates of one task (next to its task file). */
export function candidatesOf(task: Pick<LoadedTask, "id" | "file">): TaskCandidate[] {
  return loadCandidates(dirname(task.file)).filter((c) => c.task === task.id);
}
