/**
 * Entry point of the agent utility process (`utilityProcess.fork` from the main process).
 *
 * Why a utility process and not the main process: an agent run compiles and type-checks CadScript
 * (the TypeScript compiler) and evaluates Forge WASM synchronously, for seconds at a time. In the
 * main process that would stall every window's IPC, menus and the app:// protocol; a crash or OOM
 * in a provider SDK or in WASM would take the whole app down. Here it only ends the run: the main
 * process reports the crash and forks a fresh process for the next run. The process gets an
 * allowlisted environment (`env.ts` `agentWorkerEnv`: no keys, no `*_BASE_URL` or Node overrides)
 * and receives keys per run, in memory.
 */
import { PROTOCOL_VERSION, scrubKeyLike, type HostToWorker, type WorkerToHost } from "./protocol.js";
import { AgentRunner } from "./runner.js";

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
});

process.on("unhandledRejection", (reason) => {
  post({ type: "log", v: PROTOCOL_VERSION, level: "error", message: scrubKeyLike(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`) });
});

post({ type: "ready", v: PROTOCOL_VERSION });
