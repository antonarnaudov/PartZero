/**
 * The command layer's ops over MCP: the `ops` / `ext-ops` / `ops-read` scopes expose the op tools
 * generated from the model-ops catalogue; a client builds a part through the real broker (socket,
 * ticket, frames) on an in-memory document and the real Forge engine, as `mcp:<client>`: its features
 * are marked agent-made and the user's features need approval.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OPS_READ_TOOLS, OPS_TOOLS, opsRegistry } from "@aicad/agent-tools";
import { blankDocument, forgeWebCommandEngine, MemoryOpsHost, parseDoc, type ForgeWebCommandModule, type IrCommandEngine } from "@aicad/model-ops";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startBroker } from "../src/broker.js";
import { opsHandler, opsToolDefs } from "../src/ops.js";
import { scopeToolNames, withReadOnly } from "../src/scopes.js";
import { toBrokerTools } from "../src/tools.js";
import { RawBridge, shortTmp } from "./helpers/util.js";

const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = existsSync(wasmUrl);
if (!hasWasm && process.env["CI"]) throw new Error("mcp-server ops: packages/forge-web/pkg is not built");
const it_ = hasWasm ? it : it.skip;

let engine: IrCommandEngine;
beforeAll(async () => {
  if (!hasWasm) return;
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  const mod = (await import(/* @vite-ignore */ entry)) as ForgeWebCommandModule & { init(input: unknown): Promise<void> };
  await mod.init(readFileSync(wasmUrl));
  engine = forgeWebCommandEngine(mod);
}, 60_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("ops scopes", () => {
  it("expose the op tools generated from the catalogue, with read-only annotations", () => {
    expect(scopeToolNames("ops")).toEqual([...OPS_TOOLS]);
    expect(scopeToolNames("ext-ops")).toEqual([...OPS_TOOLS]);
    expect(scopeToolNames("ops-read")).toEqual([...OPS_READ_TOOLS].sort());
    const registry = opsRegistry();
    const tools = toBrokerTools(opsToolDefs());
    expect(tools.map((t) => t.name)).toEqual([...OPS_TOOLS]);
    for (const t of tools) {
      expect(JSON.stringify(t.inputSchema)).toBe(JSON.stringify(registry.schema(t.name)));
      const ro = (OPS_READ_TOOLS as readonly string[]).includes(t.name);
      expect(t.annotations.readOnlyHint, t.name).toBe(ro);
    }
    expect(withReadOnly(opsToolDefs([...OPS_READ_TOOLS])).every((d) => d.readOnly)).toBe(true);
  });
});

describe("an MCP client operating the model through the broker", () => {
  it_("adds a sketch and an extrude, reads the model, and is refused on the user's feature", async () => {
    // The user's plate…
    const host = await MemoryOpsHost.open({
      engine,
      document: JSON.stringify({
        schema: "aicad.ir/1",
        meta: { name: "plate" },
        parts: [
          {
            id: "p1",
            name: "part",
            features: [
              { type: "sketch", id: "s1", name: "base", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 40 }] },
              { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 4 },
            ],
          },
        ],
      }),
      origin: "mcp:test-client",
    });
    const tmp = shortTmp();
    cleanups.push(tmp.cleanup);
    const broker = await startBroker({ dir: join(tmp.dir, "s"), scope: "ext-ops", tools: toBrokerTools(opsToolDefs()), instructions: "operate the model", handler: opsHandler({ host }) });
    cleanups.push(() => broker.dispose());
    const c = await RawBridge.open(broker.endpoint);
    cleanups.push(() => c.close());
    const w = await c.hello(broker.ticket);
    expect(w.t).toBe("welcome");

    // …the client adds a boss on top of it.
    let r = await c.call(1, "add_feature", {
      feature_json: JSON.stringify({ type: "sketch", name: "bossSk", plane: { origin: [0, 0, 4], normal: [0, 0, 1], x_dir: [1, 0, 0] }, curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 6 }] }),
    });
    expect(r.isError, r.text).toBe(false);
    r = await c.call(2, "add_feature", { feature_json: JSON.stringify({ type: "extrude", name: "boss", sketch: "sketch1", distance: 8, op: "join", targets: "all" }) });
    expect(r.isError, r.text).toBe(false);
    r = await c.call(3, "get_model", {});
    expect(r.text).toMatch(/extrude1 boss \[extrude\] ok \(agent-made\)/);
    expect(r.text).toMatch(/s1 base \[sketch\] ok\n/);
    // The user's slab is not the client's to change (ADR 0015).
    r = await c.call(4, "set_field", { feature: "slab", path: "/distance", value_json: "6" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unapproved_user_change/);
    const doc = parseDoc(await host.document());
    expect(doc.parts[0]!.features.map((f) => [f.id, f["author"] ?? "user"])).toEqual([
      ["s1", "user"],
      ["e1", "user"],
      ["sketch1", "agent"],
      ["extrude1", "agent"],
    ]);
    const report = await host.report();
    expect(report.parts?.[0]?.bodies).toHaveLength(1);
    expect(report.parts?.[0]?.bodies[0]?.volume).toBeCloseTo(40 * 40 * 4 + Math.PI * 36 * 8, 3);
    expect(blankDocument()).toContain("aicad.ir/1");

    // The hand tools are MCP tools too: the client drills the boss with the Hole tool's command.
    r = await c.call(5, "hole", { face: "extrude1/cap:end", at: [{ u: 0, v: 0 }], size: "M5", depth: 6, tip: "flat" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/Done: Hole M5 .*feature hole1/);
    const after = await host.report();
    expect(after.features.find((f) => f.feature_id === "hole1")?.status).toBe("ok");
    expect(after.parts?.[0]?.bodies[0]?.volume).toBeLessThan(report.parts![0]!.bodies[0]!.volume);
  });
});
