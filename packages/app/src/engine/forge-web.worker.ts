/**
 * Worker host for `@aicad/forge-web`: keeps WASM evaluation and tessellation off the UI thread.
 * Result buffers are transferred, not copied.
 */
import { available, load, source } from "virtual:aicad/forge-web";
import { serveRpc } from "../worker-rpc";
import { isForgeWebModule, missingForgeWebMembers, type ForgeWebModule } from "./forge-web-contract";
import type { ForgeWebRequest } from "./forge-web-engine";
import type { RenderBody } from "./types";

let mod: ForgeWebModule | null = null;

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
  }
});
