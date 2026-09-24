/**
 * The agent worker's optional modules: `@aicad/mcp-server` (the CAD MCP host for CLI agents) and
 * `@aicad/agent/cli-runtime` (the CLI agent-runtime driver).
 *
 * Every import here names its module literally, so the packaging bundler (`scripts/bundle.mjs`) inlines both into
 * the worker bundle: a packaged app has no `node_modules`, and a specifier held in a variable would be left for Node
 * to resolve at run time, where it fails. The runner keeps its test hooks (`RunnerDeps.loadMcpServer`,
 * `RunnerDeps.loadCliRuntime`); these are the defaults.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentRuntime } from "@aicad/agent";
import type { CliAgentRuntimeOptions } from "@aicad/agent/cli-runtime";
import type { CliMcpHost } from "@aicad/llm-gateway/cli";
import type { McpShimCommand } from "./protocol.js";

/** The subset of `@aicad/mcp-server` the worker uses. */
export interface McpServerModule {
  createMcpHost(options: { shim: McpShimCommand }): CliMcpHost;
}

/** `@aicad/agent/cli-runtime` (docs/CLI-PROVIDERS.md §8.3), typed against the agent package's own declarations. */
export interface CliRuntimeModule {
  CliAgentRuntime: new (options: CliAgentRuntimeOptions) => AgentRuntime;
}

/**
 * How a CLI launches the MCP shim: the app executable run as Node (`ELECTRON_RUN_AS_NODE=1 <exe> <shim>`). The runner
 * and `--self-test` (self-test.ts) build it here, so the self-test runs exactly what a CLI run starts.
 */
export function mcpShimCommand(exePath: string, stdio: string): McpShimCommand {
  return { command: exePath, args: [stdio], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function asMcpServer(module: unknown): McpServerModule | null {
  return typeof (module as Partial<McpServerModule> | null)?.createMcpHost === "function" ? (module as McpServerModule) : null;
}

/**
 * `@aicad/mcp-server` for the `mcp-submit` envelope channel (Gemini, opencode) and the agent runtime, with the path of
 * the stdio shim a CLI launches (`ELECTRON_RUN_AS_NODE=1 <app> <shim>`):
 *
 * 1. `shimPath` (a bundled build: `bundle/mcp/stdio.mjs`, asar-unpacked when packaged): the MCP host bundled into this
 *    worker, and that shim; null when the shim file is missing.
 * 2. `dir` (development: the workspace's `packages/mcp-server`, which must be built): its `dist/index.js` and
 *    `dist/stdio.js`; null when it is not built.
 * 3. Neither: the `@aicad/mcp-server` package, with its `stdio` export as the shim; null when it is not installed.
 *
 * Null means no MCP server: Gemini and opencode then use the `text-json` envelope, and Claude Code (JSON-schema
 * envelope) needs none in completion mode.
 */
export async function loadMcpServer(dir: string | null, shimPath: string | null = null): Promise<{ module: McpServerModule; stdio: string } | null> {
  try {
    if (shimPath !== null) {
      if (!existsSync(shimPath)) return null;
      const module = asMcpServer(await import("@aicad/mcp-server"));
      return module ? { module, stdio: shimPath } : null;
    }
    if (dir !== null) {
      const stdio = join(dir, "dist", "stdio.js");
      if (!existsSync(stdio)) return null;
      const module = asMcpServer(await import(pathToFileURL(join(dir, "dist", "index.js")).href));
      return module ? { module, stdio } : null;
    }
    const stdio = fileURLToPath(import.meta.resolve("@aicad/mcp-server/stdio"));
    if (!existsSync(stdio)) return null;
    const module = asMcpServer(await import("@aicad/mcp-server"));
    return module ? { module, stdio } : null;
  } catch {
    // not installed or not built here
    return null;
  }
}

/** The agent-runtime driver, or null when the agent package does not ship it. */
export async function loadCliRuntime(): Promise<CliRuntimeModule | null> {
  try {
    const m = (await import("@aicad/agent/cli-runtime")) as Partial<CliRuntimeModule>;
    return typeof m.CliAgentRuntime === "function" ? (m as CliRuntimeModule) : null;
  } catch {
    return null;
  }
}
