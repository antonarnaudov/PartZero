/**
 * Versioned role prompts, stored as Markdown files in `packages/agent/prompts/`:
 *
 *   <role>.<version>.md                 the default prompt
 *   <role>.<version>.<variant>.md       an optional per-model-family variant
 *
 * The variant id comes from the designer's (or role's) model profile (`promptVariant`, e.g.
 * `claude-5`, `gpt-6`, `gemini-3`, `generic`), so a provider-specific phrasing is a new file, not a
 * code change. Every loaded prompt carries its id and a content hash for traces and evals.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptRole = "designer" | "spec_writer" | "triage";

export interface PromptInfo {
  role: PromptRole;
  version: string;
  /** The variant that was found, or undefined when the default file was used. */
  variant?: string;
  /** `designer.v1` or `designer.v1.gpt-6`. */
  id: string;
  /** First 12 hex chars of the SHA-256 of the text. */
  sha256: string;
  text: string;
}

export const DEFAULT_PROMPT_VERSION = "v1";

/** `packages/agent/prompts/` (works from `src/` and `dist/`). */
export function defaultPromptsDir(): string {
  return fileURLToPath(new URL("../prompts/", import.meta.url));
}

const cache = new Map<string, PromptInfo>();

export function loadPrompt(role: PromptRole, options: { version?: string; variant?: string | undefined; dir?: string } = {}): PromptInfo {
  const version = options.version ?? DEFAULT_PROMPT_VERSION;
  const dir = options.dir ?? defaultPromptsDir();
  const key = `${dir}|${role}|${version}|${options.variant ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const candidates = options.variant ? [`${role}.${version}.${options.variant}`, `${role}.${version}`] : [`${role}.${version}`];
  for (const id of candidates) {
    const path = join(dir, `${id}.md`);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    const info: PromptInfo = {
      role,
      version,
      id,
      sha256: createHash("sha256").update(text).digest("hex").slice(0, 12),
      text,
      ...(id !== `${role}.${version}` && options.variant ? { variant: options.variant } : {}),
    };
    cache.set(key, info);
    return info;
  }
  throw new Error(`no prompt ${candidates.join(" or ")}.md in ${dir}`);
}
