/**
 * Solvers turn a public task (prompt + optional context file) into CadScript.
 *
 * - {@link ReferenceSolver}: returns the task's reference solution (must score 100%).
 * - {@link MutantSolver}: returns a deliberately wrong variant of the reference, to prove that the
 *   hidden tests catch real mistakes (see `mutate.ts`).
 *
 * Agent solvers (LLM providers, MCP clients) implement the same interface and must only use the
 * {@link PublicTask} they are given: they never see the reference or the hidden tests.
 */
import { compile, print, v1 as cs } from "@aicad/cadscript";
import { isMutationKind, mutateIr, type MutationKind } from "./mutate.js";
import { isV1Task, type LoadedTask, type PublicTask } from "./task.js";
import { isMutationKindV1, mutateIrV1, type MutationKindV1 } from "./v1/mutate.js";

export interface SolverOutput {
  /** The candidate CadScript source (a whole `.cad.ts` file). */
  cadscript: string;
  /** Provider cost of producing it, USD. */
  costUsd?: number;
  /**
   * Who paid `costUsd` (ADR 0014): `metered` (API keys), `subscription` (a CLI agent on the user's
   * plan: the amount is notional, the API list-price equivalent) or `local`. Absent = metered.
   */
  billing?: "metered" | "subscription" | "local";
  /** Solver-reported latency; the pipeline measures wall time when absent. */
  latencyMs?: number;
  /** Anything worth keeping for debugging (messages, tool calls, clarifying questions). */
  transcript?: unknown;
}

export type SolveFn = (task: PublicTask) => Promise<SolverOutput>;

export interface Solver {
  /** Shown in results (e.g. `reference`, `mutant:scale`, `anthropic:opus-5.5`). */
  readonly name: string;
  solve: SolveFn;
  /** Optional: tasks this solver cannot attempt are skipped (not failed). */
  applicable?(task: LoadedTask): boolean;
}

/** Wrap a plain function as a solver. */
export function solverFromFunction(name: string, fn: SolveFn): Solver {
  return { name, solve: fn };
}

function byId(tasks: readonly LoadedTask[]): Map<string, LoadedTask> {
  return new Map(tasks.map((t) => [t.id, t] as const));
}

export class ReferenceSolver implements Solver {
  readonly name = "reference";
  private readonly tasks: Map<string, LoadedTask>;

  constructor(tasks: readonly LoadedTask[]) {
    this.tasks = byId(tasks);
  }

  solve(task: PublicTask): Promise<SolverOutput> {
    const t = this.tasks.get(task.id);
    if (!t) return Promise.reject(new Error(`unknown task ${task.id}`));
    return Promise.resolve({ cadscript: t.referenceSource, costUsd: 0 });
  }
}

/**
 * The mutated CadScript of a task's reference, or null when the mutation does not apply. IR v0
 * tasks use the v0 mutations (`mutate.ts`), IR v1 tasks the v1 ones (`v1/mutate.ts`); the source
 * is printed from the mutated IR in the task's CadScript version.
 */
export function mutantSource(task: LoadedTask, kind: MutationKind | MutationKindV1): string | null {
  if (isV1Task(task)) {
    if (!isMutationKindV1(kind)) return null;
    const r = cs.compile(task.referenceSource, { fileName: task.reference });
    if (!r.ok || !r.ir) throw new Error(`${task.id}: reference does not compile`);
    const m = mutateIrV1(r.ir, kind);
    return m ? cs.print(m) : null;
  }
  if (!isMutationKind(kind)) return null;
  const r = compile(task.referenceSource, { fileName: task.reference });
  if (!r.ok || !r.ir) throw new Error(`${task.id}: reference does not compile`);
  const m = mutateIr(r.ir, kind);
  return m ? print(m) : null;
}

export class MutantSolver implements Solver {
  readonly name: string;
  readonly kind: MutationKind | MutationKindV1;
  private readonly tasks: Map<string, LoadedTask>;

  constructor(tasks: readonly LoadedTask[], kind: MutationKind | MutationKindV1) {
    this.tasks = byId(tasks);
    this.kind = kind;
    this.name = `mutant:${kind}`;
  }

  /** The mutated CadScript for a task, or null when the mutation does not apply (e.g. no holes). */
  mutant(task: LoadedTask): string | null {
    return mutantSource(task, this.kind);
  }

  applicable(task: LoadedTask): boolean {
    return this.mutant(task) !== null;
  }

  solve(task: PublicTask): Promise<SolverOutput> {
    const t = this.tasks.get(task.id);
    if (!t) return Promise.reject(new Error(`unknown task ${task.id}`));
    const src = this.mutant(t);
    if (src === null) return Promise.reject(new Error(`${this.name} does not apply to ${task.id}`));
    return Promise.resolve({ cadscript: src, costUsd: 0, transcript: { mutation: this.kind } });
  }
}
