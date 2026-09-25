/**
 * Worker host for `@aicad/forge-web`: keeps WASM evaluation and tessellation off the UI thread.
 * Result buffers are transferred, not copied.
 */
import { available, load, source } from "virtual:aicad/forge-web";
import {
  CommandEngineError,
  FORGE_WEB_COMMANDS,
  forgeWebCommandEngine,
  missingCommandMembers,
  type ForgeWebCommandModule,
  type IrCommandEngine,
} from "../doc/v1/command-engine";
import { serveRpc } from "../worker-rpc";
import { isForgeWebModule, missingForgeWebMembers, type ForgeWebModule } from "./forge-web-contract";
import type { ForgeWebRequest } from "./forge-web-engine";
import type { RenderBody } from "./types";

let mod: ForgeWebModule | null = null;
/** The IR v1 command layer, when the loaded forge-web build has it. */
let commands: IrCommandEngine | null = null;
let commandsMissing: string[] = [];

function transferablesOf(bodies: RenderBody[]): Transferable[] {
  const out = new Set<ArrayBufferLike>();
  for (const b of bodies) {
    out.add(b.positions.buffer);
    out.add(b.normals.buffer);
    out.add(b.indices.buffer);
    for (const e of b.edges) out.add(e.points.buffer);
  }
  return [...out].filter((x): x is ArrayBuffer => x instanceof ArrayBuffer);
}

serveRpc<ForgeWebRequest>(async (req) => {
  switch (req.type) {
    case "init": {
      if (!available) throw new Error(`@aicad/forge-web unavailable: ${source}`);
      const m: unknown = await load();
      if (!isForgeWebModule(m)) throw new Error(`@aicad/forge-web does not match the contract (missing: ${missingForgeWebMembers(m).join(", ")})`);
      await m.init();
      mod = m;
      commandsMissing = missingCommandMembers(m);
      commands = commandsMissing.length === 0 ? forgeWebCommandEngine(m as unknown as ForgeWebCommandModule) : null;
      return { result: { source } };
    }
    case "evaluate": {
      if (!mod) throw new Error("forge-web not initialised");
      const r = mod.evaluate(req.irJson, req.tess);
      return { result: r, transfer: transferablesOf(r.bodies) };
    }
    case "export": {
      if (!mod) throw new Error("forge-web not initialised");
      const bytes = mod.exportMesh(req.irJson, req.format);
      return { result: bytes, transfer: bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [] };
    }
    case "command": {
      if (!mod) throw new Error("forge-web not initialised");
      if (!commands) {
        throw new CommandEngineError(
          "ENGINE_UNSUPPORTED",
          `this @aicad/forge-web build has no IR v1 command layer (missing: ${commandsMissing.join(", ")}); rebuild it`,
        );
      }
      if (!(FORGE_WEB_COMMANDS as readonly string[]).includes(req.name)) throw new Error(`unknown command ${String(req.name)}`);
      const f = commands[req.name] as (...args: unknown[]) => Promise<unknown>;
      return { result: await f(...req.args) };
    }
  }
});
