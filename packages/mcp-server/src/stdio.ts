#!/usr/bin/env node
/**
 * `aicad-mcp`: the `cad` MCP server over stdio (CLI-PROVIDERS.md §6.6, ARCHITECTURE §9).
 *
 * Bridge mode (default; what in-app CLI agent runs launch through their MCP config):
 *   env AICAD_MCP_BRIDGE=<socket or pipe>, AICAD_MCP_TICKET=<ticket>   (the ticket never goes in argv)
 *   Tools come from the host broker's `welcome`; every call is forwarded to the broker.
 *
 * Headless mode (external agents; a design host in this process, no desktop app needed):
 *   aicad-mcp --doc <file.cad.ts> [--engine auto|forge|oracle|fixture] [--forge-bin <path>]
 *             [--fixtures <dir>] [--export-dir <dir>] [--scopes ext-read,ext-edit,ext-export]
 *   Edits land on an `mcp/<client>` branch; `propose` writes `<file>.proposal.cad.ts` for review.
 *
 * Output channels: stdout carries JSON-RPC frames only; stderr gets at most 20 short lines per
 * process and never the environment (a CLI's environment holds its own session tokens).
 * Exits on stdin EOF or SIGTERM.
 *
 * Bridge mode imports nothing outside Node built-ins, so every CLI run starts fast.
 */
import { BridgeBackend } from "./bridge-client.js";
import { BRIDGE_ENDPOINT_ENV, BRIDGE_TICKET_ENV } from "./bridge-protocol.js";
import { serveStreams } from "./mcp.js";
import { MCP_SERVER_VERSION } from "./version.js";

const MAX_STDERR_LINES = 20;
const MAX_STDERR_CHARS = 200;

let stderrLines = 0;

/** Capped diagnostics: ≤ 20 lines of ≤ 200 chars per process, control characters removed. */
function shimLog(line: string): void {
  if (stderrLines >= MAX_STDERR_LINES) return;
  stderrLines++;
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_STDERR_CHARS);
  process.stderr.write(`aicad-mcp: ${clean}\n`);
}

const USAGE = `aicad-mcp ${MCP_SERVER_VERSION}: the cad MCP server (stdio)
  bridge mode (default): needs ${BRIDGE_ENDPOINT_ENV} and ${BRIDGE_TICKET_ENV} in the environment
  headless mode:         aicad-mcp --doc <file.cad.ts> [--engine auto|forge|oracle|fixture] [--forge-bin <path>]
                                   [--fixtures <dir>] [--export-dir <dir>] [--scopes ext-read,ext-edit,ext-export]
`;

async function runBridge(): Promise<void> {
  const backend = new BridgeBackend({
    endpoint: process.env[BRIDGE_ENDPOINT_ENV],
    ticket: process.env[BRIDGE_TICKET_ENV],
    pid: process.pid,
    log: shimLog,
  });
  const { done } = serveStreams({ backend, input: process.stdin, output: process.stdout });
  const quit = () => {
    backend.close();
    // Let the bye frame flush; never linger.
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGTERM", quit);
  process.stdout.on("error", quit); // EPIPE: the client is gone
  await done;
  quit();
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(USAGE);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${MCP_SERVER_VERSION}\n`);
    return;
  }
  if (argv.length === 0) return runBridge();
  if (argv.includes("--doc")) {
    const { runHeadless } = await import("./host/headless.js");
    const code = await runHeadless(argv, { stdin: process.stdin, stdout: process.stdout, log: shimLog });
    process.exitCode = code;
    return;
  }
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  shimLog(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
