/**
 * The engine entry points of the IR v1 command layer. They live in `@aicad/model-ops` (the one
 * command layer, FULL-MODELING-PLAN §2.1) and are re-exported here for the app's modules.
 */
export {
  COMMAND_MEMBERS,
  CommandEngineError,
  FORGE_WEB_COMMANDS,
  forgeWebCommandEngine,
  missingCommandMembers,
  requireCommandEngine,
  toCommandEngineError,
  type AcceptRefCandidateResult,
  type AcceptRefProposalResult,
  type CaptureRefResult,
  type EditResult,
  type ForgeWebCommandModule,
  type ForgeWebCommandName,
  type IrCommandEngine,
  type MigrateResult,
  type ParamValueInput,
  type RejectionProblem,
  type RenameCurveResult,
  type RenameFeatureResult,
  type SetParamResult,
  type UpgradeFeatureResult,
  type WriteBackResult,
} from "@aicad/model-ops";
