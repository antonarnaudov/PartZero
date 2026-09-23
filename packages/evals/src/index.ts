/**
 * @aicad/evals — the MakerBench evaluation harness.
 *
 * A task (`corpus/makerbench/<id>.task.json`) is a maker's request plus hidden tests; a
 * {@link Solver} produces CadScript, the pipeline compiles it, an {@link Engine} evaluates the IR
 * into an `aicad.metrics/0` report, and the hidden-test DSL ({@link evaluateTests}) scores it.
 */
export {
  bodiesOf,
  describeExpectation,
  describeTest,
  evaluateTest,
  evaluateTests,
  measure,
  rankedBodies,
  type CheckContext,
  type Subject,
  type TestResult,
  type Value,
} from "./checks.js";
export {
  EngineError,
  FIXTURE_SCHEMA,
  FixtureEngine,
  ForgeCliEngine,
  irHash,
  OracleEngine,
  runProcess,
  type Engine,
  type EngineAvailability,
  type EngineErrorCode,
  type EvaluateOptions,
  type FixtureEntry,
  type FixtureFile,
  type ForgeCliEngineOptions,
  type OracleEngineOptions,
} from "./engine.js";
export { fixtureDocuments, recordFixtures, writeFixture } from "./fixtures.js";
export { canonicalJson, contentHash } from "./hash.js";
export { circlesOf, curveChanges, featureChanges, featureNames, holeCircles, planeFrame, sketchesOf, toModel } from "./ir-geom.js";
export { isMutationKind, mutateIr, MUTATIONS, type MutationKind } from "./mutate.js";
export {
  distribution,
  FAILURE_CATEGORIES,
  RESULTS_SCHEMA,
  runSuite,
  runTask,
  summarize,
  type FailureCategory,
  type RunOptions,
  type SuiteResult,
  type SuiteSummary,
  type TaskResult,
} from "./pipeline.js";
export { renderReport } from "./report.js";
export { MutantSolver, ReferenceSolver, solverFromFunction, type SolveFn, type Solver, type SolverOutput } from "./solver.js";
export {
  BODY_CHECKS,
  CHECKS,
  IR0_CAPABILITIES,
  IR_CHECKS,
  isSupported,
  loadTasks,
  MODEL_CHECKS,
  publicTask,
  readTask,
  schemaProblems,
  semanticProblems,
  TaskLoadError,
  TIERS,
  type BodyCondition,
  type CheckName,
  type HiddenTest,
  type LoadedTask,
  type PublicTask,
  type TaskFile,
  type Tier,
} from "./task.js";
