/**
 * A deterministic stub engine (a trimmed copy of agent-tools' test stub): each circle in a sketch is a
 * region; each extrude makes one cylinder body per circle. A curve id starting with "bad" fails its
 * sketch with SKETCH_OPEN_LOOP.
 */
import type { Engine, EngineAvailability } from "@aicad/evals";

export type IrDocument = Parameters<Engine["evaluate"]>[0];
export type EvalReport = Awaited<ReturnType<Engine["evaluate"]>>;

interface StubSketch {
  curves: { id: string; kind: string; center?: number[]; radius?: number }[];
}

export class StubEngine implements Engine {
  readonly kind = "stub";
  evaluations = 0;

  async availability(): Promise<EngineAvailability> {
    return { available: true, detail: "stub" };
  }

  async evaluate(ir: IrDocument, options: { name?: string } = {}): Promise<EvalReport> {
    this.evaluations++;
    const features: unknown[] = [];
    const sketches = new Map<string, StubSketch | null>();
    let status: "ok" | "error" = "ok";
    for (const part of ir.parts) {
      for (const f of part.features as unknown as Record<string, unknown>[]) {
        if (f["suppressed"]) continue;
        const name = String(f["name"]);
        if (f["type"] === "sketch") {
          const sk = f as unknown as StubSketch;
          const bad = sk.curves.find((c) => c.id.startsWith("bad"));
          if (bad) {
            status = "error";
            sketches.set(name, null);
            features.push({ part: part.name, feature: name, type: "sketch", status: "error", error: { code: "SKETCH_OPEN_LOOP", message: `the end of curve '${bad.id}' meets no other curve end` } });
            continue;
          }
          const regions = sk.curves.filter((c) => c.kind === "circle").map((c) => ({ area: Math.PI * c.radius! * c.radius!, loops: 1, outer_curves: [c.id] }));
          sketches.set(name, sk);
          features.push({ part: part.name, feature: name, type: "sketch", status: "ok", regions });
        } else {
          const s = sketches.get(String(f["sketch"]));
          if (!s) {
            status = "error";
            features.push({ part: part.name, feature: name, type: f["type"], status: "error", error: { code: "DEPENDENCY_FAILED", message: `sketch ${String(f["sketch"])} failed` } });
            continue;
          }
          const d = f["type"] === "extrude" ? Number(f["distance"]) : 10;
          const bodies = s.curves
            .filter((c) => c.kind === "circle")
            .map((c) => {
              const r = c.radius!;
              const [x, y] = c.center as [number, number];
              return {
                volume: Math.PI * r * r * d,
                area: 2 * Math.PI * r * r + 2 * Math.PI * r * d,
                centroid: [x, y, d / 2],
                bbox_min: [x - r, y - r, 0],
                bbox_max: [x + r, y + r, d],
                faces: 3,
                edges: 2,
                face_types: { cylinder: 1, plane: 2 },
                edge_types: { circle: 2 },
                valid: true,
              };
            });
          features.push({ part: part.name, feature: name, type: f["type"], status: "ok", bodies });
        }
      }
    }
    return { schema: "aicad.metrics/0", engine: "stub 0", document: options.name ?? "doc", status, features } as unknown as EvalReport;
  }
}

export const IMP = `import { part, sketch, circle, extrude, XY } from "@aicad/std";\n`;

/** One disc: sketch `s` with one circle (curve id `id`), extruded as `e`. */
export const disc = (r = 5, d = 5, id = "c"): string =>
  `${IMP}part("p");\nconst s = sketch(XY, { ${id}: circle({ center: [0, 0], radius: ${r} }) });\nconst e = extrude(s, { distance: ${d} });\n`;
