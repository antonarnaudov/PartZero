import { z } from "zod";
import { GatewayError } from "./errors.js";
import { routingConfigSchema } from "./router.js";

const clientOptions = z.object({
  /** Prefer env vars / the SDK's default credential lookup; never commit keys into config files. */
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * Gateway JSON config. Example:
 *
 * ```json
 * {
 *   "profiles": {
 *     "claude-opus-5-5": { "pricing": { "cacheWritePerMTok": 5 } },
 *     "qwen-local": { "extends": "gpt-oss-120b", "apiModelId": "qwen3-coder", "family": "qwen", "vendor": "alibaba" }
 *   },
 *   "routing": { "roles": { "...": {} }, "judgeRule": "family" },
 *   "providers": { "anthropic": { "maxRetries": 3 } }
 * }
 * ```
 */
export const gatewayConfigSchema = z.object({
  profiles: z.record(z.string(), z.looseObject({ extends: z.string().optional() })).optional(),
  routing: routingConfigSchema.optional(),
  providers: z
    .object({
      anthropic: clientOptions.optional(),
      openai: clientOptions.optional(),
      google: clientOptions.extend({ vertexai: z.boolean().optional(), project: z.string().optional(), location: z.string().optional() }).optional(),
      "openai-compat": clientOptions.optional(),
    })
    .optional(),
});

export type GatewayConfig = z.input<typeof gatewayConfigSchema>;

export function parseGatewayConfig(value: unknown): z.output<typeof gatewayConfigSchema> {
  const parsed = gatewayConfigSchema.safeParse(value);
  if (!parsed.success) throw new GatewayError("config", `Invalid gateway config: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Read and validate a JSON config file (Node only; the rest of the package is runtime-agnostic). */
export async function loadGatewayConfigFile(path: string): Promise<z.output<typeof gatewayConfigSchema>> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new GatewayError("config", `Cannot read gateway config ${path}: ${(err as Error).message}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new GatewayError("config", `Gateway config ${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  return parseGatewayConfig(json);
}
