import type { Provider } from "./types.js";

export type GatewayErrorCode =
  | "invalid_request"
  | "unsupported_input"
  | "unknown_model"
  | "unknown_role"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "connection"
  | "aborted"
  | "context_window_exceeded"
  | "budget_exceeded"
  | "replay_mismatch"
  | "config"
  | "unknown";

/** Machine-readable error thrown by the gateway. Provider SDK errors are wrapped with `cause`. */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly provider: Provider | undefined;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: GatewayErrorCode,
    message: string,
    options: {
      provider?: Provider;
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GatewayError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

/** Thrown before a call is issued when its projected cost would push the task over its USD cap. */
export class BudgetExceededError extends GatewayError {
  readonly taskId: string;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly projectedUsd: number;

  constructor(args: { taskId: string; capUsd: number; spentUsd: number; reservedUsd: number; projectedUsd: number; model: string }) {
    super(
      "budget_exceeded",
      `Task ${args.taskId}: call to ${args.model} projected at $${args.projectedUsd.toFixed(4)} would exceed the ` +
        `$${args.capUsd.toFixed(4)} budget (spent $${args.spentUsd.toFixed(4)}, in flight $${args.reservedUsd.toFixed(4)}).`,
      { details: { ...args } },
    );
    this.name = "BudgetExceededError";
    this.taskId = args.taskId;
    this.capUsd = args.capUsd;
    this.spentUsd = args.spentUsd;
    this.reservedUsd = args.reservedUsd;
    this.projectedUsd = args.projectedUsd;
  }
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Normalize an error thrown by a provider SDK. All three official SDKs expose an HTTP `status` on their API error
 * classes (`Anthropic.APIError`, `OpenAI.APIError`, `@google/genai` `ApiError`), and name connection/abort/timeout
 * errors consistently, so status + name classify almost everything. The one exception: providers report an
 * oversized prompt as a generic 400, so that case alone is recognized from the message text.
 * The SDKs have already retried 429/5xx (their built-in backoff) by the time we see the error.
 */
export function normalizeProviderError(provider: Provider, err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const status = numberField(err, "status");
  const name = stringField(err, "name") ?? "";
  const message = err instanceof Error ? err.message : String(err);

  if (name === "APIUserAbortError" || name === "AbortError") {
    return new GatewayError("aborted", `${provider}: request aborted`, { provider, cause: err });
  }
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError") {
    return new GatewayError("timeout", `${provider}: request timed out`, { provider, retryable: true, cause: err });
  }
  if (name === "APIConnectionError" || (status === undefined && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message))) {
    return new GatewayError("connection", `${provider}: connection error: ${message}`, { provider, retryable: true, cause: err });
  }
  if (status === undefined) {
    return new GatewayError("unknown", `${provider}: ${message}`, { provider, cause: err });
  }
  const opts = { provider, status, cause: err };
  if (status === 400 || status === 422) {
    if (/context window|context length|prompt is too long|input is too long|too many (input )?tokens|exceeds the maximum (number of )?tokens/i.test(message)) {
      return new GatewayError("context_window_exceeded", `${provider}: ${message}`, opts);
    }
    return new GatewayError("invalid_request", `${provider}: ${message}`, opts);
  }
  if (status === 401) return new GatewayError("auth", `${provider}: authentication failed`, opts);
  if (status === 403) return new GatewayError("permission", `${provider}: ${message}`, opts);
  if (status === 404) return new GatewayError("not_found", `${provider}: ${message}`, opts);
  if (status === 408) return new GatewayError("timeout", `${provider}: ${message}`, { ...opts, retryable: true });
  if (status === 413) return new GatewayError("context_window_exceeded", `${provider}: ${message}`, opts);
  if (status === 429) return new GatewayError("rate_limited", `${provider}: rate limited`, { ...opts, retryable: true });
  if (status === 529 || status === 503) return new GatewayError("overloaded", `${provider}: overloaded`, { ...opts, retryable: true });
  if (status >= 500) return new GatewayError("server_error", `${provider}: server error ${status}`, { ...opts, retryable: true });
  return new GatewayError("unknown", `${provider}: ${message}`, opts);
}
