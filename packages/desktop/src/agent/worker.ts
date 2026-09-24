/**
 * Entry point of the agent utility process (`utilityProcess.fork` from the main process).
 *
 * Why a utility process and not the main process: an agent run compiles and type-checks CadScript
 * (the TypeScript compiler) and evaluates Forge WASM synchronously, for seconds at a time. In the
 * main process that would stall every window's IPC, menus and the app:// protocol; a crash or OOM
 * in a provider SDK or in WASM would take the whole app down. Here it only ends the run: the main
 * process reports the crash and forks a fresh process for the next run. The process gets an
 * allowlisted environment (`env.ts` `agentWorkerEnv`: no keys, no `*_BASE_URL` or Node overrides;
 * only the locations where CLI agents keep their own logins, and proxy settings) and receives API
 * keys per run, in memory.
 *
 * CLI agents run as children of this process, each in its own process group. They are killed when
 * this process exits, is terminated or crashes; the main process also kills the groups it was told
 * about if this process dies without doing so.
 */
import { killAllCliProcesses } from "@aicad/llm-gateway/cli";
import { PROTOCOL_VERSION, scrubKeyLike, type HostToWorker, type WorkerToHost } from "./protocol.js";
import { AgentRunner } from "./runner.js";
import { workerSelfTest } from "./self-test.js";

interface ParentPort {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!port) {
  console.error("[aicad-agent] not started as an Electron utility process");
  process.exit(1);
}

const post = (m: WorkerToHost): void => port.postMessage(m);
const runner = new AgentRunner({ post });

port.on("message", (e) => {
  const m = e.data as HostToWorker | undefined;
  if (!m || typeof m !== "object" || m.v !== PROTOCOL_VERSION) return;
  if (m.type === "start" || m.type === "answer" || m.type === "stop") runner.handle(m);
  if (m.type === "selftest") {
    void workerSelfTest({ mcpShimPath: m.mcpShimPath, mcpServerDir: m.mcpServerDir, exePath: m.exePath, workspaceRoot: m.workspaceRoot }).then(
      (report) => post({ type: "selftest", v: PROTOCOL_VERSION, report }),
      (e: unknown) => post({ type: "log", v: PROTOCOL_VERSION, level: "error", message: scrubKeyLike(`self-test failed: ${e instanceof Error ? e.message : String(e)}`) }),
    );
  }
});

process.on("unhandledRejection", (reason) => {
  post({ type: "log", v: PROTOCOL_VERSION, level: "error", message: scrubKeyLike(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`) });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    killAllCliProcesses();
    process.exit(0);
  });
}

process.on("uncaughtException", (e) => {
  killAllCliProcesses();
  post({ type: "log", v: PROTOCOL_VERSION, level: "error", message: scrubKeyLike(`uncaught exception: ${e.message}`) });
  process.exit(1);
});

post({ type: "ready", v: PROTOCOL_VERSION });
