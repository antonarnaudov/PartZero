import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Helpers for the real-binary harnesses (docs/CLI-PROVIDERS.md §13.1): the installed CLI runs against an isolated
 * HOME/XDG tree and a local mock model server, never the user's login or the network (a dead proxy catches any other
 * request). Nothing here reads real CLI state.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const MINI_MCP = join(here, "fake", "mini-mcp.mjs");

/** Absolute path (as found on PATH, not resolved: detection checks the name) of an installed CLI, or null. */
export function which(name: string): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      realpathSync(p);
      return p;
    } catch {
      // next
    }
  }
  return null;
}

/** A throwaway HOME + XDG tree under `root`, plus env that sends any non-loopback request to a dead proxy. */
export function isolatedEnv(root: string): Record<string, string> {
  const home = join(root, "home");
  for (const d of ["", "c", "d", "s", "k"]) mkdirSync(join(home, d), { recursive: true });
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "c"),
    XDG_DATA_HOME: join(home, "d"),
    XDG_STATE_HOME: join(home, "s"),
    XDG_CACHE_HOME: join(home, "k"),
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    LANG: "en_US.UTF-8",
  };
}

/**
 * One scripted model reply: plain text, or one tool call (OpenAI chat-completions streaming shape). `finish` overrides
 * the text reply's finish_reason (e.g. "length" for a reply cut off at the output limit).
 */
export type MockReply = { text: string; finish?: string } | { tool: string; args: Record<string, unknown> };

export interface MockOpenAI {
  port: number;
  baseURL: string;
  /** Parsed JSON bodies of every chat/completions request, in order. */
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** A local OpenAI-compatible server that streams the scripted replies in order (the last one repeats). */
export async function startMockOpenAI(replies: readonly MockReply[]): Promise<MockOpenAI> {
  const requests: Array<Record<string, unknown>> = [];
  let n = 0;
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      if (!(req.url ?? "").includes("chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        requests.push({});
      }
      const reply = replies[Math.min(n, replies.length - 1)] ?? { text: "" };
      n += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: "m1" };
      const chunk = (o: unknown): void => void res.write(`data: ${JSON.stringify(o)}\n\n`);
      if ("text" in reply) {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.finish ?? "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
      } else {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Fixture recording for the parser tests: with AICAD_RECORD_FIXTURES=1 the raw stdout lines of a harness run are
 * written (paths under `scrubRoot` replaced by "<tmp>") to test/cli/fixtures/<rel>. Returns the CliRunIO hook and a
 * `save()` to call after the run; both are no-ops otherwise.
 */
export function fixtureRecorder(rel: string, scrubRoot: string): { onStdoutLine?: (line: string) => void; save(): void } {
  if (process.env["AICAD_RECORD_FIXTURES"] !== "1") return { save: () => {} };
  const lines: string[] = [];
  return {
    onStdoutLine: (line: string) => void lines.push(line.split(scrubRoot).join("<tmp>")),
    save: () => writeFileSync(join(here, "fixtures", rel), `${lines.join("\n")}\n`),
  };
}
