/**
 * @aicad/evals — the MakerBench evaluation harness.
 *
 * A task (`corpus/makerbench/<id>.task.json`) is a maker's request plus hidden tests; a
 * {@link Solver} produces CadScript, the pipeline compiles it, an {@link Engine} evaluates the IR
 * into an `aicad.metrics/0` report, and the hidden-test DSL ({@link evaluateTests}) scores it.
 * IR v1 tasks (`corpus/makerbench/v1/`, `requires: ["ir/1", …]`) are compiled with CadScript v1
 * and evaluated into `aicad.metrics/1` reports ({@link Engine.evaluateV1}, {@link subjectV1}).
 */
export {
  bodiesOf,
  describeExpectation,
  describeTest,
  evaluateTest,
  evaluateTests,
  measure,
  rankedBodies,
  variantKey,
  type CheckContext,
  type Subject,
  type TestResult,
  type Value,
  type VariantOutcome,
} from "./checks.js";
export {
  ALLOW_RETRY_ENV,
  EngineError,
  FIXTURE_SCHEMA,
  FIXTURE_SCHEMA_V1,
  FixtureEngine,
  ForgeCliEngine,
  irHash,
  irHashV1,
  killedByOs,
  ORACLE_SOLVE_REQUIRES_REPLAY,
  OracleEngine,
  runProcess,
  type Engine,
  type EngineAvailability,
  type EngineErrorCode,
  type EvalReportV1,
  type EvaluateOptions,
  type FixtureEntry,
  type FixtureEntryV1,
  type FixtureFile,
  type FixtureFileV1,
  type ForgeCliEngineOptions,
  type IrDocumentV1,
  type OracleEngineOptions,
} from "./engine.js";
export { candidatesOf, loadCandidates, readCandidate, type TaskCandidate } from "./candidates.js";
export { fixtureDocuments, fixtureDocumentsV1, recordFixtures, recordFixturesV1, recordTaskFixtures, writeFixture } from "./fixtures.js";
export { canonicalJson, contentHash } from "./hash.js";
export {
  circlesOf,
  curveChanges,
  featureChanges,
  featureNames,
  holeCircles,
  logicalCurves,
  planeFrame,
  sketchCircles,
  sketchesOf,
  toModel,
  type IrChange,
  type LogicalCurve,
  type SketchCircle,
} from "./ir-geom.js";
export { isMutationKind, mutateIr, MUTATIONS, type MutationKind } from "./mutate.js";
export {
  compileV1,
  distribution,
  FAILURE_CATEGORIES,
  paramSets,
  paramVariants,
  RESULTS_SCHEMA,
  runSuite,
  runTask,
  subjectV1,
  summarize,
  variantLabel,
  type FailureCategory,
  type RunOptions,
  type SuiteResult,
  type SuiteSummary,
  type TaskResult,
} from "./pipeline.js";
export { renderReport } from "./report.js";
export { MutantSolver, mutantSource, ReferenceSolver, solverFromFunction, type SolveFn, type Solver, type SolverOutput } from "./solver.js";
export {
  ALL_CHECKS,
  BODY_CHECKS,
  capabilitiesUsedV1,
  CHECKS,
  FEATURE_TYPES_V1,
  IR0_CAPABILITIES,
  IR1_CAPABILITIES,
  IR_CHECKS,
  isSupported,
  isV1Task,
  loadTasks,
  MODEL_CHECKS,
  publicTask,
  readTask,
  schemaProblems,
  SCORABILITIES,
  semanticProblems,
  TaskLoadError,
  testScorability,
  testProblems,
  TIERS,
  V1_CHECKS,
  type BodyCondition,
  type CheckName,
  type HiddenTest,
  type HoleFilter,
  type NestedTest,
  type V1CheckName,
  type LoadedTask,
  type PublicTask,
  type Scorability,
  type TaskFile,
  type Tier,
} from "./task.js";
export { evalCount, evalNumber, evalScalar, paramValues, sinCosDeg, type Evaluated, type ParamValues } from "./v1/expr.js";
export { classifyDifferencesV1, isEngineInternal, OPEN_CONTRACT_QUESTIONS, reportDifferencesV1, type ClassifiedDifferences, type DiffOptions, type OpenContractQuestion } from "./v1/diff.js";
export { isMutationKindV1, mutateIrV1, MUTATIONS_V1, type MutationKindV1 } from "./v1/mutate.js";
export {
  blendsV1,
  circlesV1,
  curvesV1,
  holesV1,
  paramChanges,
  refChanges,
  shellsV1,
  v0ViewOfV1,
  withParams,
  type BlendInfo,
  type HoleInstance,
  type ShellInfo,
  type SubjectV1,
} from "./v1/subject.js";
