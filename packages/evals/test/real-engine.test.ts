/**
 * Opt-in: evaluate every reference (and every mutant) with a REAL engine instead of fixtures.
 *
 *   AICAD_EVALS_REAL_ENGINE=oracle pnpm --filter @aicad/evals test real-engine
 *   AICAD_EVALS_REAL_ENGINE=forge  pnpm --filter @aicad/evals test real-engine   (needs forge/target/debug/aicad)
 *
 * `AICAD_EVALS_FORGE_BIN` picks another `aicad` (a release build: `forge/target/release/aicad`
 * runs the largest v1 documents in ~9 s instead of ~80 s in debug); `AICAD_EVALS_TIMEOUT_MS`
 * sets the per-document timeout (default 600 s, enough for a debug build at concurrency 8). A
 * run the OS killed (SIGKILL under memory pressure) is retried once (`ForgeCliEngine.retried`);
 * the last test then fails unless `AICAD_EVALS_ALLOW_RETRY=1` (memory-constrained local runs),
 * so no gate passes on a second run unnoticed. An engine crash (any other signal) is never
 * retried.
 *
 * The MakerBench v1 block also compares the engine with the recorded (oracle) v1 fixtures,
 * document by document: with `forge` that is Forge against OCCT on the whole v1 corpus.
 *
 * Skipped by default so `pnpm test` stays hermetic and fast.
 */
import { describe, expect, it } from "vitest";
import { ALLOW_RETRY_ENV, ForgeCliEngine, OracleEngine, type Engine } from "../src/engine.js";
import { fixtureDocumentsV1 } from "../src/fixtures.js";
import { runSuite } from "../src/pipeline.js";
import { MutantSolver, ReferenceSolver } from "../src/solver.js";
import { classifyDifferencesV1 } from "../src/v1/diff.js";
import { MUTATIONS_V1 } from "../src/v1/mutate.js";
import { corpusTasks, corpusTasksV1, fixtureEngineV1 } from "./helpers.js";

const which = process.env.AICAD_EVALS_REAL_ENGINE;
const forge = new ForgeCliEngine({
  ...(process.env.AICAD_EVALS_FORGE_BIN ? { bin: process.env.AICAD_EVALS_FORGE_BIN } : {}),
  timeoutMs: Number(process.env.AICAD_EVALS_TIMEOUT_MS ?? 600_000),
});
const engine: Engine | undefined = which === "oracle" ? new OracleEngine({ replay: forge }) : which === "forge" ? forge : undefined;

describe.skipIf(!engine)(`real engine (${which ?? "set AICAD_EVALS_REAL_ENGINE"})`, () => {
  const tasks = corpusTasks();

  it("is available", async () => {
    expect(await engine!.availability()).toMatchObject({ available: true });
  });

  it("scores every reference 100%", { timeout: 900_000 }, async () => {
    const result = await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: engine!, concurrency: 8 });
    const failures = result.tasks
      .filter((t) => !t.pass)
      .map((t) => `${t.id} [${t.category}] ${t.error?.message ?? ""} ${t.tests.filter((x) => !x.pass).map((x) => `${x.id}: ${x.message ?? x.expected}`).join("; ")}`);
    expect(failures).toEqual([]);
  });

  it("fails every applicable non-T5 mutant", { timeout: 900_000 }, async () => {
    for (const kind of ["scale", "drop_hole", "hole_size"] as const) {
      const result = await runSuite(tasks, { solver: new MutantSolver(tasks, kind), engine: engine!, concurrency: 8 });
      const escaped = result.tasks.filter((t) => t.tier !== "T5" && t.pass).map((t) => `${kind}: ${t.id}`);
      expect(escaped).toEqual([]);
    }
  });
});

describe.skipIf(!engine)(`real engine, MakerBench v1 (${which ?? "set AICAD_EVALS_REAL_ENGINE"})`, () => {
  const tasks = corpusTasksV1();

  it("evaluates IR v1", () => {
    expect(engine!.evaluateV1).toBeTypeOf("function");
  });

  it("scores every v1 reference 100%", { timeout: 1_800_000 }, async () => {
    const result = await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: engine!, concurrency: 8 });
    const failures = result.tasks
      .filter((t) => !t.pass)
      .map((t) => `${t.id} [${t.category}] ${t.error?.message ?? ""} ${t.tests.filter((x) => !x.pass).map((x) => `${x.id}: ${x.message ?? x.expected}`).join("; ")}`);
    expect(failures).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("fails every applicable non-T5 v1 mutant", { timeout: 1_800_000 }, async () => {
    for (const kind of MUTATIONS_V1) {
      const result = await runSuite(tasks, { solver: new MutantSolver(tasks, kind), engine: engine!, concurrency: 8 });
      const escaped = result.tasks.filter((t) => t.tier !== "T5" && t.pass).map((t) => `${kind}: ${t.id}`);
      expect(escaped).toEqual([]);
    }
  });

  /**
   * The recorded fixtures (the oracle's reports) against this engine, document by document, with
   * `classifyDifferencesV1`: SPEC-v1 §8.2 (statuses and codes, feature list, bodies matched by
   * origin and nearest centroid with the v0 §6 tolerances, `removed`, hole ids with centres, axes,
   * `d` and `depth` to the §8.2 tolerances, pattern instances, blend edge keys, parameters) plus
   * what the checks read beyond it (every warning code, reference statuses, hole preset
   * dimensions, shells, `valid`). With AICAD_EVALS_REAL_ENGINE=forge this is the MakerBench v1
   * differential of Forge against OCCT. Open contract questions (`OPEN_CONTRACT_QUESTIONS`) are
   * CODE_MISMATCHes the SPEC does not decide yet: listed, not failed, and pinned so a new one
   * cannot slip in unnoticed.
   */
  it("agrees with the recorded fixtures on every document", { timeout: 1_800_000 }, async () => {
    const fixtures = fixtureEngineV1();
    const problems: string[] = [];
    const open: string[] = [];
    for (const t of tasks) {
      for (const { label, doc } of fixtureDocumentsV1(t)) {
        const [a, b] = [await fixtures.evaluateV1(doc), await engine!.evaluateV1!(doc, { name: t.id })];
        const c = classifyDifferencesV1(a, b, { doc });
        for (const d of c.differences) problems.push(`${t.id} ${label}: ${d}`);
        for (const d of c.openContract) open.push(`${t.id} ${label}: ${d}`);
      }
    }
    expect(problems).toEqual([]);
    if (which === "forge") {
      // Only the magnetic tray's up_to drain meets an open question (the oracle warns, Forge does
      // not): a CODE_MISMATCH until the Contract stage rules on SPEC §6.5.
      expect(open.every((o) => o.startsWith("t1-magnetic-parts-tray ") && o.includes("drain: CODE_MISMATCH pending a contract ruling: HOLE_BREAKS_THROUGH on an up_to hole")), open.join("\n")).toBe(true);
    } else {
      expect(open).toEqual([]);
    }
  });
});

// Last in the file (vitest runs a file's tests in order): every run above has finished.
describe.skipIf(!engine)(`real engine runs (${which ?? "set AICAD_EVALS_REAL_ENGINE"})`, () => {
  it("had no aicad run killed by the OS and retried (unless AICAD_EVALS_ALLOW_RETRY=1)", () => {
    if (forge.retried.length === 0) return;
    const list = `aicad runs killed by the OS (SIGKILL) and retried once:\n${forge.retried.join("\n")}`;
    if (process.env[ALLOW_RETRY_ENV] === "1") {
      console.warn(`${list}\n(allowed by ${ALLOW_RETRY_ENV}=1)`);
      return;
    }
    expect.fail(`${list}\nRerun with lower concurrency, or set ${ALLOW_RETRY_ENV}=1 for a memory-constrained local run.`);
  });
});
