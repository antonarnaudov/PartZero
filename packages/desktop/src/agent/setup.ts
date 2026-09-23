/**
 * Main-process wiring of the agent: key store (safeStorage), settings, environment/.env keys in
 * development, the transport (live / scripted / replay) and the utility process factory.
 *
 * Environment (all optional; development and tests only: a packaged build always uses the live
 * transport and never reads a `.env`):
 * - `AICAD_AGENT_TRANSPORT` = `live` (default) | `scripted` | `replay`
 * - `AICAD_AGENT_SCRIPT`    = JSON script for `scripted` (see `runner.ts` `parseScriptFile`)
 * - `AICAD_AGENT_FIXTURES`  = JSON fixture array for `replay` (`@aicad/llm-gateway` `Fixture[]`)
 * - `AICAD_AGENT_DOTENV`    = path of the `.env` read in development, or `off` (default: `<repo>/.env`)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@aicad/app/bridge";
import { AgentHost, type WorkerHandle } from "./host.js";
import { KeyResolver, KeyStore, keysFromVariables, parseDotenv, type Cipher } from "./keys.js";
import type { TransportConfig } from "./protocol.js";
import { SettingsStore } from "./settings.js";

export function transportFromEnv(env: NodeJS.ProcessEnv, warn: (m: string) => void = () => undefined, isPackaged = false): TransportConfig {
  if (isPackaged) {
    if (env["AICAD_AGENT_TRANSPORT"]) warn("AICAD_AGENT_TRANSPORT is ignored in packaged builds; using the live transport");
    return { kind: "live" };
  }
  const kind = env["AICAD_AGENT_TRANSPORT"] ?? "live";
  if (kind === "scripted") {
    const scriptPath = env["AICAD_AGENT_SCRIPT"];
    if (scriptPath && existsSync(scriptPath)) return { kind: "scripted", scriptPath };
    warn(`AICAD_AGENT_TRANSPORT=scripted needs AICAD_AGENT_SCRIPT pointing to a script file; using the live transport`);
  } else if (kind === "replay") {
    const fixturesPath = env["AICAD_AGENT_FIXTURES"];
    if (fixturesPath && existsSync(fixturesPath)) return { kind: "replay", fixturesPath };
    warn(`AICAD_AGENT_TRANSPORT=replay needs AICAD_AGENT_FIXTURES pointing to a fixtures file; using the live transport`);
  } else if (kind !== "live") {
    warn(`unknown AICAD_AGENT_TRANSPORT=${kind}; using the live transport`);
  }
  return { kind: "live" };
}

/** Keys from a development `.env` (never read in packaged builds). */
export function dotenvKeys(env: NodeJS.ProcessEnv, repoRoot: string | null, isPackaged: boolean): ReturnType<typeof keysFromVariables> {
  if (isPackaged) return {};
  const setting = env["AICAD_AGENT_DOTENV"];
  if (setting === "off") return {};
  const path = setting ?? (repoRoot ? join(repoRoot, ".env") : null);
  if (!path || !existsSync(path)) return {};
  try {
    return keysFromVariables(parseDotenv(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

export interface AgentSetupOptions {
  userData: string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  repoRoot: string | null;
  forgeBin: string;
  cipher: Cipher;
  spawnWorker(): WorkerHandle;
  send(event: AgentEvent): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export interface AgentSetup {
  host: AgentHost;
  keys: KeyResolver;
  settings: SettingsStore;
}

export function setupAgent(o: AgentSetupOptions): AgentSetup {
  const store = new KeyStore(join(o.userData, "agent-keys.json"), o.cipher);
  const keys = new KeyResolver(store, keysFromVariables(o.env), dotenvKeys(o.env, o.repoRoot, o.isPackaged));
  const settings = new SettingsStore(join(o.userData, "agent-settings.json"));
  const transport = transportFromEnv(o.env, (m) => o.log("warn", m), o.isPackaged);
  const host = new AgentHost({ spawnWorker: o.spawnWorker, keys, settings, transport, forgeBin: o.forgeBin, send: o.send, log: o.log });
  return { host, keys, settings };
}
