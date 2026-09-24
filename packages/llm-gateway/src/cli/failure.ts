import { GatewayError, type GatewayErrorCode } from "../errors.js";
import type { CliProviderId } from "../types.js";
import type { CliFailure, CliFailureCode } from "./provider.js";

/** `CliFailureCode` -> `GatewayErrorCode` (docs/CLI-PROVIDERS.md §7.2, frozen). */
export const CLI_FAILURE_TO_GATEWAY: Readonly<Record<CliFailureCode, { code: GatewayErrorCode; retryable: boolean }>> = {
  not_installed: { code: "not_installed", retryable: false },
  unsupported: { code: "config", retryable: false },
  lockdown_violation: { code: "lockdown_violation", retryable: false },
  not_logged_in: { code: "not_logged_in", retryable: false },
  rate_limited: { code: "rate_limited", retryable: true },
  quota_exhausted: { code: "quota_exhausted", retryable: false },
  context_overflow: { code: "context_window_exceeded", retryable: false },
  max_turns: { code: "bad_output", retryable: false },
  budget: { code: "budget_exceeded", retryable: false },
  timeout: { code: "timeout", retryable: false },
  stalled: { code: "timeout", retryable: false },
  cancelled: { code: "aborted", retryable: false },
  bad_output: { code: "bad_output", retryable: false },
  crashed: { code: "server_error", retryable: false },
  unknown: { code: "server_error", retryable: false },
};

export function cliFailureToGatewayError(provider: CliProviderId, failure: CliFailure): GatewayError {
  const map = CLI_FAILURE_TO_GATEWAY[failure.code];
  const details: Record<string, unknown> = { cliFailure: failure.code };
  if (failure.retryAfterMs !== undefined) details["retryAfterMs"] = failure.retryAfterMs;
  if (failure.resetsAt !== undefined) details["resetsAt"] = failure.resetsAt;
  return new GatewayError(map.code, `${provider}: ${failure.message}`, { provider, retryable: map.retryable, details });
}

/** Parse a reset time from free text ("Try again at 3:05 PM", ISO strings, epoch seconds). Returns ISO or undefined. */
export function parseResetTime(text: string, now: Date = new Date()): string | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(text);
  if (iso?.[1] !== undefined) {
    const d = new Date(iso[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const clock = /try again (?:at|after)\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    let h = Number(clock[1]);
    const m = Number(clock[2]);
    const ampm = clock[3]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return undefined;
}

/** Epoch seconds or milliseconds or an ISO string -> ISO, else null. */
export function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string" && value.length <= 64) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
