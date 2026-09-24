/**
 * `aicad-agent run|bench` with CLI agents as providers (docs/CLI-PROVIDERS.md §13.4): CLI profile ids
 * on the model flags, `--cli-mode`, `--cli-bin`, and the bench's plan rules (one task at a time, 5
 * tasks unless `--limit`). The run test drives the fake `claude` binary end to end.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLMGateway } from "@aicad/llm-gateway";
import { createMcpHost, nodeShimCommand } from "@aicad/mcp-server";
import { cliMain } from "../src/index.js";
import { FakeClaude, skipRealBroker } from "./cli-harness.js";
import { CLI_TEST_PROFILES } from "./fake-runtime.js";
import { fixtureEngine } from "./helpers.js";
import { CORPUS_DIR, PLATE_OK, PLATE_THICK, SLAB_10 } from "./scenarios.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), cwd: process.cwd() }, out, err };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

describe.skipIf(skipRealBroker())("aicad-agent run with a CLI agent (fake claude, real broker)", () => {
  it("--designer-model claude-cli:haiku --cli-mode runtime edits the file through the CLI's own tool loop", async () => {
    const fake = new FakeClaude({
      runtime: {
        build: {
          turns: [
            [
              { calls: [{ name: "apply_cadscript", args: { patches: [SLAB_10] } }] },
              { calls: [{ name: "propose", args: { summary: "Plate is now 10 mm thick.", assumptions: [], known_issues: [] } }] },
            ],
          ],
        },
      },
    });
    cleanup.push(() => fake.dispose());
    const file = join(fake.dir, "plate.cad.ts");
    writeFileSync(file, PLATE_OK);
    const c = io();
    const code = await cliMain(
      ["run", "--prompt", "Make the plate 10 mm thick.", "--context", file, "--kind", "quick_edit", "--engine", "fixture", "--designer-model", "claude-cli:haiku", "--cli-mode", "runtime"],
      c.io,
      { makeEngine: () => fixtureEngine(), cli: { binary: () => fake.binary(), mcpHost: createMcpHost({ shim: nodeShimCommand() }), workspaceRoot: join(fake.dir, "ws") } },
    );
    const err = c.err.join("");
    expect(code, err).toBe(0);
    expect(c.out.join("")).toBe(PLATE_THICK);
    expect(err).toMatch(/aicad-agent: claude-cli 2\.1\.260 at .* \(your own login and plan\)/);
    expect(err).toContain("[cli-runtime, plan]");
    expect(err).toContain("cost is notional: the designer ran on your CLI plan (cli-runtime)");
    expect(fake.invocations()).toHaveLength(1);
  });
});

describe("aicad-agent CLI-provider flags", () => {
  it("--cli-mode runtime without an MCP server, and a malformed --cli-bin, are usage errors", async () => {
    const a = io();
    expect(
      await cliMain(["run", "--prompt", "x", "--engine", "fixture", "--designer-model", "claude-cli:haiku", "--cli-mode", "runtime"], a.io, {
        makeEngine: () => fixtureEngine(),
        cli: { binary: () => Promise.reject(new Error("never detected")), mcpHost: null },
      }),
    ).toBe(2);
    expect(a.err.join("")).toContain("claude-cli is not ready: never detected");

    const fake = new FakeClaude({});
    cleanup.push(() => fake.dispose());
    const b = io();
    expect(
      await cliMain(["run", "--prompt", "x", "--engine", "fixture", "--designer-model", "claude-cli:haiku", "--cli-mode", "runtime"], b.io, {
        makeEngine: () => fixtureEngine(),
        cli: { binary: () => fake.binary(), mcpHost: null },
      }),
    ).toBe(2);
    expect(b.err.join("")).toContain("--cli-mode runtime needs the CAD MCP server");

    const c = io();
    expect(await cliMain(["run", "--prompt", "x", "--engine", "fixture", "--designer-model", "claude-cli:haiku", "--cli-bin", "claude=/x"], c.io, { makeEngine: () => fixtureEngine() })).toBe(2);
    expect(c.err.join("")).toContain("--cli-bin takes <provider>=<path>");
    const d = io();
    expect(await cliMain(["run", "--prompt", "x", "--cli-mode", "sometimes"], d.io, { makeEngine: () => fixtureEngine() })).toBe(2);
    expect(d.err.join("")).toContain("--cli-mode must be auto, completion or runtime");
  });

  it("bench on a CLI plan: one task at a time, the first 5 tasks unless --limit, costs labelled as plan usage", async () => {
    const out = mkdtempSync(join(realpathSync(tmpdir()), "aicad-bench-plan-"));
    cleanup.push(() => rmSync(out, { recursive: true, force: true }));
    const c = io();
    // No CLI transport in this gateway: every task fails fast, which is enough to check the plan rules.
    const code = await cliMain(["bench", "--tasks", CORPUS_DIR, "--models", "claude-cli:opus", "--engine", "fixture", "--out", out], c.io, {
      makeEngine: () => fixtureEngine(),
      makeGateway: () => new LLMGateway({ profiles: CLI_TEST_PROFILES }),
    });
    expect(code).toBe(0);
    const err = c.err.join("");
    expect(err).toContain("CLI plan models: running the first 5 tasks (--limit <n> to change, --limit 0 for all)");
    expect(err).toContain("on 5 tasks");
    const rows = JSON.parse(readFileSync(join(out, "comparison.json"), "utf8")) as Array<{ tasks: number; billing: string }>;
    expect(rows[0]).toMatchObject({ tasks: 5, billing: "subscription" });
    expect(c.out.join("")).toMatch(/\| `claude-cli:opus` \| [a-z-]+ \| 0\.0% \(0\/5\) .*≈\$0\.000 \(plan\)/);
  });
});
