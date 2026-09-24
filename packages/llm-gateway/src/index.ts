export * from "./types.js";
export { GatewayError, BudgetExceededError, normalizeProviderError, type GatewayErrorCode } from "./errors.js";
export {
  ProfileRegistry,
  modelProfileSchema,
  pricingSchema,
  deepMerge,
  profileKind,
  type ModelProfile,
  type Pricing,
  type ProfileOverride,
  type ReasoningStyle,
} from "./profile.js";
export {
  BUILTIN_PROFILES,
  BUILTIN_CLI_PROFILES,
  BUILTIN_LOCAL_PROFILES,
  DEFAULT_OLLAMA_URL,
  cliProfile,
  ollamaProfile,
  profileFromDiscovery,
  smallModelFor,
  smallModelForProfile,
  type OllamaModelInfo,
} from "./builtin-profiles.js";
// CLI provider contracts are types only here (erased at runtime); the implementations are Node-only in `./cli`.
export type {
  CliAgentId,
  CliAuthStatus,
  CliBinary,
  CliCapabilities,
  CliDetection,
  CliExit,
  CliFailure,
  CliFailureCode,
  CliImage,
  CliInvocation,
  CliLimits,
  CliMode,
  CliProvider,
  CliRun,
  DiscoveredModel,
  LockdownCheck,
  LockdownReport,
} from "./cli/provider.js";
export type { CliEvent, CliResultEvent } from "./cli/events.js";
export type { BrokerLimits, CliMcpHost, CliMcpSession, McpAttachment, McpScope, McpToolCall, McpToolResult } from "./cli/mcp.js";
export {
  computeCostUsd,
  estimateInputTokens,
  pricesAt,
  projectCostUsd,
  resolveMaxOutputTokens,
  type CostProjection,
  type EffectivePrices,
} from "./pricing.js";
export { toAnthropicSchema, toGoogleSchema, toOpenAIStrictSchema, stripOptionalNulls } from "./schema.js";
export {
  Router,
  ROLES,
  DEFAULT_ROUTING,
  routingConfigSchema,
  type Role,
  type RoleRoute,
  type RouteTarget,
  type RoutingConfig,
  type RoutingWarning,
} from "./router.js";
export { BudgetGuard, type LedgerEntry, type Reservation } from "./budget.js";
export { gatewayConfigSchema, parseGatewayConfig, loadGatewayConfigFile, type GatewayConfig } from "./config.js";
export { Conversation } from "./conversation.js";
export { LLMGateway, ChatStream, Task, type CallOptions, type GatewayOptions, type TaskOptions } from "./gateway.js";
export type { AdapterContext, BuiltRequest, ParsedResponse, ProviderAdapter } from "./adapters/adapter.js";
export { AnthropicAdapter } from "./adapters/anthropic.js";
export { OpenAIAdapter } from "./adapters/openai.js";
export { GoogleAdapter, SKIP_THOUGHT_SIGNATURE } from "./adapters/google.js";
export { OpenAICompatAdapter } from "./adapters/openai-compat.js";
export {
  ReplayTransport,
  RecordingTransport,
  stableStringify,
  type Fixture,
  type ProviderTransport,
  type ReplayOptions,
  type TransportCall,
  type TransportOperation,
} from "./transport/transport.js";
export { AnthropicSdkTransport, OpenAISdkTransport, GoogleSdkTransport, type SdkClientOptions, type GoogleClientOptions } from "./transport/sdk.js";
