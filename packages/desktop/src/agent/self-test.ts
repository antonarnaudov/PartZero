/**
 * The agent worker's half of `--self-test` (docs/ALPHA-0-PLAN.md W1, G1 #2): read-only checks that the bundled worker
 * has everything a run needs, without a model call and without touching a document or a CLI.
 *
 * - CadScript compiles (the TypeScript compiler is inlined into the worker bundle, with a `createRequire` banner);
 * - Forge evaluates the compiled v0 document in this process (forge-web WASM, loaded from next to the worker);
 * - Forge migrates it to `aicad.ir/1` and evaluates that (`aicad.metrics/1`);
 * - the role prompts are found (`bundle/prompts`, or the agent package's own);
 * - the CLI agent-runtime driver is loadable;
 * - the CAD MCP path a Claude Code run in runtime mode uses works end to end, without a CLI or a model: the MCP host
 *   bundled into this worker opens a broker on a private socket under the CLI workspace root, the shim runs exactly
 *   as a CLI would start it (`ELECTRON_RUN_AS_NODE=1 <app> <shim>`, with the run's ticket in its environment), and
 *   answers MCP `initialize`, `tools/list` (the broker's tools, so the ticket was accepted) and `tools/call` (a
 *   read-only probe tool the broker runs).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt, type PromptRole } from "@aicad/agent";
import { compile } from "@aicad/cadscript";
import { createCliWorkspace, type CliMcpHost, type CliMcpSession, type CliWorkspace } from "@aicad/llm-gateway/cli";
import { bundledPromptsDir } from "../bundle-paths.js";
import { ForgeWebNodeEngine, forgeWasmPath } from "./engine.js";
import { loadCliRuntime, loadMcpServer, mcpShimCommand } from "./optional-modules.js";
import { brokerSocketFits } from "./protocol.js";

/** A small v0 part: an 80 × 50 × 8 mm plate (volume 32 000 mm³). */
export const SELF_TEST_SOURCE = `import { doc, part, sketch, line, extrude, XY } from "@aicad/std";

doc({ name: "self-test", description: "" });

part("part");
const base = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: line([40, 25], [-40, 25]),
  left: line([-40, 25], [-40, -25]),
});
const plate = extrude(base, { distance: 8 });
`;
export const SELF_TEST_VOLUME = 32_000;

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface EvalCheck extends CheckResult {
  schema: string | null;
  status: string | null;
  bodies: number;
  volume: number | null;
}

export interface WorkerSelfTestReport {
  cadscript: CheckResult;
  engine: CheckResult & { wasm: string | null };
  v0: EvalCheck;
  v1: EvalCheck;
  prompts: CheckResult & { dir: string; ids: string[] };
  /** The MCP shim run end to end through the broker ({@link mcpShimRoundTrip}). */
  mcp: CheckResult & { shim: string | null; exe: string | null; ms: number | null };
  cliRuntime: CheckResult;
}

interface AnyReport {
  schema?: string;
  status?: string;
  features?: Array<{ bodies?: Array<{ volume?: number }> }>;
  parts?: Array<{ bodies?: Array<{ volume?: number }> }>;
  error?: { code?: string; message?: string } | null;
}

/** Bodies and total volume of a v0 (last body-creating feature) or v1 (final part bodies) report. */
export function summarizeReport(r: AnyReport): Omit<EvalCheck, "ok" | "detail"> {
  let bodies: Array<{ volume?: number }> = [];
  if (Array.isArray(r.parts)) bodies = r.parts.flatMap((p) => p.bodies ?? []);
  else if (Array.isArray(r.features)) bodies = [...r.features].reverse().find((f) => (f.bodies ?? []).length > 0)?.bodies ?? [];
  const volumes = bodies.map((b) => b.volume).filter((v): v is number => typeof v === "number");
  return { schema: r.schema ?? null, status: r.status ?? null, bodies: bodies.length, volume: volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) : null };
}

function evalCheck(r: AnyReport, schema: string): EvalCheck {
  const s = summarizeReport(r);
  const volumeOk = s.volume !== null && Math.abs(s.volume - SELF_TEST_VOLUME) <= SELF_TEST_VOLUME * 1e-6;
  const ok = s.schema === schema && s.status === "ok" && s.bodies === 1 && volumeOk;
  const detail = ok
    ? `${schema}: 1 body, ${s.volume} mm³`
    : `${s.schema ?? "no schema"}: status ${s.status ?? "?"}, ${s.bodies} bodies, volume ${s.volume ?? "?"} (expected ${schema}, ok, 1 body, ${SELF_TEST_VOLUME} mm³)${r.error?.code ? `; ${r.error.code}: ${r.error.message ?? ""}` : ""}`;
  return { ok, detail, ...s };
}

const fail = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const NOT_RUN: EvalCheck = { ok: false, detail: "not run", schema: null, status: null, bodies: 0, volume: null };

export interface WorkerSelfTestOptions {
  /** The bundled MCP shim the main process found (`bundle-paths.ts`), or null. */
  mcpShimPath: string | null;
  /** Development: the workspace's `packages/mcp-server`. */
  mcpServerDir: string | null;
  /** The app executable a CLI runs the shim with (`WorkerCliConfig.exePath`), or null when this build cannot. */
  exePath: string | null;
  /** The private root for CLI workspaces and broker sockets (`WorkerCliConfig.workspaceRoot`), or null: CLIs are off. */
  workspaceRoot: string | null;
  /** The folder of the worker's code (default: this module's; tests pass another). */
  workerDir?: string;
}

// ─── The MCP shim, end to end ───────────────────────────────────────────────────────────────

/** The probe tool the self-test's broker serves: read-only, no arguments, answers {@link MCP_PROBE_TEXT}. */
export const MCP_PROBE_TOOL = "self_test_ping";
export const MCP_PROBE_TEXT = "pong";
const MCP_ROUND_TRIP_TIMEOUT_MS = 20_000;
/** What the shim child inherits besides the attachment's env and the ticket (a CLI passes its own, larger env). */
const SHIM_BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"];

interface RpcMessage {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** A minimal MCP stdio client: newline-delimited JSON-RPC, every request bounded by `deadline`. */
function stdioRpc(child: ChildProcess, deadline: number): { request(method: string, params: object): Promise<RpcMessage>; notify(method: string): void } {
  let buffer = "";
  let failure: string | null = null;
  const pending = new Map<number, (m: RpcMessage) => void>();
  const failAll = (why: string): void => {
    failure ??= why;
    for (const answer of pending.values()) answer({ error: { message: failure } });
    pending.clear();
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) {
      failAll("the shim wrote more than 1 MB without a line break");
      child.kill();
      return;
    }
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line.length === 0) continue;
      let m: RpcMessage;
      try {
        m = JSON.parse(line) as RpcMessage;
      } catch {
        failAll("the shim wrote a line that is not JSON-RPC on stdout");
        return;
      }
      if (typeof m.id === "number") {
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      }
    }
  });
  child.stdin?.on("error", () => undefined); // EPIPE once the shim is gone: reported through `exit`
  child.on("error", (e) => failAll(`the shim could not be started: ${e.message}`));
  child.on("exit", (code, signal) => failAll(`the shim exited (${signal ?? `code ${code}`}) before it answered`));
  let nextId = 1;
  const send = (m: object): void => {
    if (child.stdin?.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  };
  return {
    request(method, params) {
      if (failure !== null) return Promise.resolve({ error: { message: failure } });
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: { message: `no answer to ${method} in time` } });
        }, Math.max(0, deadline - Date.now()));
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        send({ id, method, params });
      });
    },
    notify(method) {
      send({ method });
    },
  };
}

/** Ends the shim the way a CLI does (stdin EOF), and kills it if it lingers. */
function endChild(child: ChildProcess, graceMs = 2_000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin?.end();
  });
}

export interface McpRoundTripOptions {
  /** The MCP host, built with the shim command a CLI run uses (`mcpShimCommand`). */
  host: CliMcpHost;
  /** Where the run's workspace and broker socket go (`<root>/s/<8 hex>/b.sock`). */
  workspaceRoot: string;
  timeoutMs?: number;
  /** Tests only: change the ticket the shim is given (a wrong one must fail the check). */
  ticket?: (real: string) => string;
}

/**
 * One MCP session through the real broker and shim, as a CLI run in runtime mode has it: a private workspace and
 * socket, the shim started with the attachment's command, args and env plus the ticket, then `initialize`,
 * `tools/list` (listing the broker's probe tool proves the ticket handshake) and `tools/call` (the broker runs the
 * handler). Everything is closed and removed afterwards. The ticket never appears in the result.
 */
export async function mcpShimRoundTrip(o: McpRoundTripOptions): Promise<CheckResult & { ms: number | null }> {
  const t0 = Date.now();
  const deadline = t0 + (o.timeoutMs ?? MCP_ROUND_TRIP_TIMEOUT_MS);
  let workspace: CliWorkspace | null = null;
  let session: CliMcpSession | null = null;
  let child: ChildProcess | null = null;
  const stderr: string[] = [];
  const failed = (why: string): CheckResult & { ms: null } => ({ ok: false, detail: `${why}${stderr.length > 0 ? ` (shim: ${stderr.join(" | ").slice(0, 300)})` : ""}`.slice(0, 600), ms: null });
  try {
    workspace = await createCliWorkspace({ root: o.workspaceRoot, runId: "self-test", basename: "self-test" });
    session = await o.host.open({
      dir: workspace.socketDir,
      scope: "read",
      tools: [{ name: MCP_PROBE_TOOL, description: "PartZero self-test: answers pong.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, readOnly: true }],
      instructions: `PartZero self-test: call ${MCP_PROBE_TOOL} once.`,
      handler: async (call) => (call.name === MCP_PROBE_TOOL ? { text: MCP_PROBE_TEXT, isError: false } : { text: `Unknown tool ${call.name}.`, isError: true }),
    });
    const a = session.attachment;
    const env: Record<string, string> = {};
    for (const k of SHIM_BASE_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    const ticket = o.ticket ? o.ticket(session.ticket) : session.ticket;
    child = spawn(a.command, [...a.args], { cwd: workspace.dir, env: { ...env, ...a.env, [a.ticketEnv]: ticket }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      for (const line of d.split("\n")) if (line.trim() && stderr.length < 3) stderr.push(line.trim().slice(0, 200));
    });
    const rpc = stdioRpc(child, deadline);
    const init = await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "partzero-self-test", version: "1" } });
    const server = (init.result?.["serverInfo"] as { name?: unknown } | undefined)?.name;
    if (server !== "cad") return failed(`initialize: ${init.error?.message ?? `unexpected answer (server ${JSON.stringify(server ?? null)})`}`);
    rpc.notify("notifications/initialized");
    const list = await rpc.request("tools/list", {});
    if (list.error) return failed(`tools/list: ${list.error.message ?? "error"}`);
    const names = ((list.result?.["tools"] as Array<{ name?: unknown }> | undefined) ?? []).map((t) => String(t.name));
    if (!names.includes(MCP_PROBE_TOOL)) {
      return failed(`tools/list has no ${MCP_PROBE_TOOL} (tools: ${names.join(", ") || "none"}): the shim did not get through to the broker (socket or ticket)`);
    }
    const call = await rpc.request("tools/call", { name: MCP_PROBE_TOOL, arguments: {} });
    const content = (call.result?.["content"] as Array<{ text?: unknown }> | undefined)?.[0]?.text;
    if (call.error || call.result?.["isError"] !== false || content !== MCP_PROBE_TEXT) {
      return failed(`tools/call ${MCP_PROBE_TOOL}: ${call.error?.message ?? `answered ${JSON.stringify(content ?? null).slice(0, 120)}`}`);
    }
    const ms = Date.now() - t0;
    const via = a.env["ELECTRON_RUN_AS_NODE"] === "1" ? `ELECTRON_RUN_AS_NODE=1 ${basename(a.command)}` : basename(a.command);
    return { ok: true, detail: `the shim (${via} ${basename(a.args[0] ?? "?")}) answered initialize, tools/list and tools/call through the broker in ${ms} ms`, ms };
  } catch (e) {
    return failed(fail(e));
  } finally {
    if (child !== null) await endChild(child);
    if (session !== null) {
      session.close("self-test done");
      await session.dispose().catch(() => undefined);
    }
    await workspace?.dispose().catch(() => undefined);
  }
}

/** The MCP check: why the shim cannot run in this build, or the round trip ({@link mcpShimRoundTrip}). */
async function mcpCheck(o: WorkerSelfTestOptions): Promise<WorkerSelfTestReport["mcp"]> {
  const loaded = await loadMcpServer(o.mcpServerDir, o.mcpShimPath).catch(() => null);
  const base = { shim: loaded?.stdio ?? null, exe: o.exePath, ms: null };
  if (!loaded) return { ok: false, detail: "the CAD MCP server is not available in this build", ...base };
  if (o.exePath === null) return { ok: false, detail: "this build cannot run the MCP shim (the app executable does not run as Node)", ...base };
  if (o.workspaceRoot === null) return { ok: false, detail: "CLI agents are off (no private folder for their workspaces), so the MCP shim cannot run", ...base };
  if (!brokerSocketFits(o.workspaceRoot)) return { ok: false, detail: `the CLI workspace folder ${o.workspaceRoot} is too long for the MCP broker socket`, ...base };
  const host = loaded.module.createMcpHost({ shim: mcpShimCommand(o.exePath, loaded.stdio) });
  const r = await mcpShimRoundTrip({ host, workspaceRoot: o.workspaceRoot });
  return { ...base, ...r };
}

export async function workerSelfTest(o: WorkerSelfTestOptions): Promise<WorkerSelfTestReport> {
  const workerDir = o.workerDir ?? dirname(fileURLToPath(import.meta.url));

  let ir: object | null = null;
  let cadscript: CheckResult;
  try {
    const r = compile(SELF_TEST_SOURCE);
    ir = r.ok ? (r.ir as object) : null;
    cadscript = r.ok ? { ok: true, detail: "CadScript v0 compiles" } : { ok: false, detail: r.diagnostics.map((d) => d.message).join("; ").slice(0, 300) };
  } catch (e) {
    cadscript = { ok: false, detail: fail(e) };
  }

  let wasm: string | null = null;
  try {
    wasm = forgeWasmPath(workerDir);
  } catch {
    wasm = null;
  }
  const web = new ForgeWebNodeEngine();
  const availability = await web.availability();
  const engine = { ok: availability.available, detail: availability.detail, wasm };
  let v0 = NOT_RUN;
  let v1 = NOT_RUN;
  if (availability.available && ir !== null) {
    try {
      const m = await web.module();
      v0 = evalCheck(m.evaluate(ir).report as AnyReport, "aicad.metrics/0");
      const migrated = m.migrate(ir).document;
      v1 = evalCheck(m.evaluate(migrated).report as AnyReport, "aicad.metrics/1");
    } catch (e) {
      const detail = fail(e);
      if (v0 === NOT_RUN) v0 = { ...NOT_RUN, detail };
      else v1 = { ...NOT_RUN, detail };
    }
  }

  const dir = bundledPromptsDir(workerDir);
  const ids: string[] = [];
  let prompts: WorkerSelfTestReport["prompts"];
  try {
    for (const role of ["triage", "spec_writer", "designer"] as PromptRole[]) {
      const p = loadPrompt(role, dir !== null ? { dir } : {});
      ids.push(`${p.id}@${p.sha256}`);
    }
    prompts = { ok: true, detail: dir !== null ? "bundled prompts" : "the agent package's prompts", dir: dir ?? "(package default)", ids };
  } catch (e) {
    prompts = { ok: false, detail: fail(e), dir: dir ?? "(package default)", ids };
  }

  const mcp = await mcpCheck(o).catch((e: unknown) => ({ ok: false, detail: fail(e), shim: null, exe: o.exePath, ms: null }));
  const runtime = await loadCliRuntime().catch(() => null);
  const cliRuntime = runtime ? { ok: true, detail: "CLI agent runtime loaded" } : { ok: false, detail: "the CLI agent runtime is not available" };

  return { cadscript, engine, v0, v1, prompts, mcp, cliRuntime };
}
