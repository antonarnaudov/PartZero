/**
 * ForgeCliEngine's child environment (phase 0 audit L11): the `aicad` binary inherits an allowlist
 * (paths, locale, Windows essentials, RUST_BACKTRACE), never provider keys, base-URL redirects or
 * Node switches from the caller's environment (the desktop agent's main process holds keys).
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { IrDocument } from "@aicad/ir-types";
import { FORGE_CLI_ENV_ALLOWLIST, ForgeCliEngine, forgeCliEnv } from "../src/engine.js";

const dir = mkdtempSync(join(tmpdir(), "aicad-evals-env-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Secrets and redirectors the binary must never see. */
const HOSTILE_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-canary-0000000000",
  OPENAI_API_KEY: "sk-canary-0000000000",
  GEMINI_API_KEY: "AIza-canary-0000000000",
  AWS_SECRET_ACCESS_KEY: "aws-canary-0000000000",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9/evil-anthropic",
  OPENAI_BASE_URL: "http://127.0.0.1:9/evil-openai",
  GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:9/evil-google",
  NODE_OPTIONS: "--require /nonexistent/evil.js",
  ELECTRON_RUN_AS_NODE: "1",
};

const saved = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe("ForgeCliEngine child environment", () => {
  it("forgeCliEnv keeps only the allowlist", () => {
    const env = { PATH: "/bin", HOME: "/h", LANG: "C", SystemRoot: "C:\\Windows", RUST_BACKTRACE: "1", AICAD_BIN: "/x", ...HOSTILE_ENV };
    expect(forgeCliEnv(env)).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", SystemRoot: "C:\\Windows", RUST_BACKTRACE: "1" });
    for (const k of Object.keys(HOSTILE_ENV)) expect(FORGE_CLI_ENV_ALLOWLIST).not.toContain(k);
  });

  it.skipIf(process.platform === "win32")("the spawned aicad sees no provider key, base URL or Node switch", async () => {
    setEnv({ ...HOSTILE_ENV, RUST_BACKTRACE: "1" });
    const dump = join(dir, "env.txt");
    const bin = join(dir, "aicad");
    // A POSIX shell script: independent of NODE_OPTIONS, so a leak shows up in the dump instead of a crash.
    writeFileSync(bin, `#!/bin/sh\nenv > '${dump}'\nprintf 'not a report'\n`);
    chmodSync(bin, 0o755);
    await expect(new ForgeCliEngine({ bin }).evaluate({} as IrDocument)).rejects.toMatchObject({ code: "ENGINE_BAD_OUTPUT" });
    const seen = readFileSync(dump, "utf8");
    for (const [k, v] of Object.entries(HOSTILE_ENV)) {
      expect(seen, k).not.toMatch(new RegExp(`^${k}=`, "m"));
      if (v.length > 8) expect(seen, k).not.toContain(v); // the value under another name
    }
    expect(seen).toMatch(/^PATH=/m);
    expect(seen).toMatch(/^RUST_BACKTRACE=1$/m);
  });
});
