import type { CliProviderId } from "../types.js";
import { ClaudeCliProvider } from "./claude.js";
import { CodexCliProvider } from "./codex.js";
import { CursorAgentProvider } from "./cursor.js";
import { GeminiCliProvider } from "./gemini.js";
import { OpencodeProvider } from "./opencode.js";
import type { CliProvider } from "./provider.js";

/** One instance per CLI provider (stateless apart from opencode's per-binary MCP server list). */
export const CLI_PROVIDERS: ReadonlyMap<CliProviderId, CliProvider> = new Map<CliProviderId, CliProvider>([
  ["claude-cli", new ClaudeCliProvider()],
  ["gemini-cli", new GeminiCliProvider()],
  ["codex-cli", new CodexCliProvider()],
  ["opencode", new OpencodeProvider()],
  ["cursor-agent", new CursorAgentProvider()],
]);

export function cliProvider(id: CliProviderId): CliProvider {
  const p = CLI_PROVIDERS.get(id);
  if (p === undefined) throw new Error(`unknown CLI provider ${id}`);
  return p;
}
