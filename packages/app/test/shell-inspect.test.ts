import { describe, expect, it } from "vitest";
import { bedFit, bodySummary, reportBodies, registerInspectTools } from "../src/tools/builtin/inspect";
import { createShellCommandRegistry } from "../src/tools/commands";
import { ToolRegistry } from "../src/tools/registry";
import { attachShell, Shell } from "../src/tools/shell";
import { exampleAvailability, openExample, STARTERS } from "../src/tools/starters";
import { BLANK_SOURCE } from "../src/host/templates";
import { BOX, makeHarness } from "./helpers";

const body = (min: [number, number, number], max: [number, number, number], volume = 1000, valid = true) => ({
  volume,
  area: 600,
  centroid: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  bbox_min: min,
  bbox_max: max,
  faces: 6,
  edges: 12,
  valid,
});

describe("report bodies", () => {
  it("reads every feature body of an aicad.metrics/0 report", () => {
    const report = {
      schema: "aicad.metrics/0",
      features: [
        { part: "plate", feature: "outline", type: "sketch", status: "ok", regions: [] },
        { part: "plate", feature: "plate", type: "extrude", status: "ok", bodies: [body([-25, -25, 0], [25, 25, 5], 10417.75)] },
        { part: "pucks", feature: "pucks", type: "extrude", status: "ok", bodies: [body([0, 0, 0], [1, 1, 1]), body([2, 0, 0], [3, 1, 1])] },
      ],
    };
    const b = reportBodies(report);
    expect(b.map((x) => x.label)).toEqual(["plate/plate", "pucks/pucks#1", "pucks/pucks#2"]);
    expect(b[0]).toMatchObject({ renderName: "plate/plate", volume: 10417.75, valid: true });
  });

  it("reads the final part bodies of an aicad.metrics/1 report (after booleans)", () => {
    const report = {
      schema: "aicad.metrics/1",
      features: [{ part: "box", feature: "shell", bodies: [{ ...body([0, 0, 0], [1, 1, 1]), change: "created" }] }],
      parts: [
        { part: "box", bodies: [{ origin: { feature: "f_shell", member: "outer.bottom" }, ...body([-32, -18, 0], [32, 18, 24], 12721.47) }] },
        { part: "lid", bodies: [{ origin: { feature: "f_lid", member: "plate.bottom" }, ...body([-32, -62, 0], [32, -26, 5], 10295.38) }] },
      ],
    };
    const b = reportBodies(report);
    expect(b.map((x) => [x.label, x.volume])).toEqual([
      ["box", 12721.47],
      ["lid", 10295.38],
    ]);
    const rows = Object.fromEntries(bodySummary(b).map((r) => [r.label, r.value]));
    expect(rows["Bodies"]).toBe("2");
    expect(rows["Size (X × Y × Z)"]).toBe("64 × 80 × 24 mm");
    expect(rows["Volume"]).toBe("23016.85 mm³ (23.017 cm³)");
    expect(rows["Solid PLA"]).toBe("≈ 28.5 g (no infill)");
    expect(rows["Check"]).toBe("Valid solids");
  });

  it("flags invalid bodies and ignores malformed entries", () => {
    const b = reportBodies({ features: [{ part: "p", feature: "f", bodies: [body([0, 0, 0], [1, 1, 1], 1, false), { volume: "x" }] }] });
    expect(b).toHaveLength(1);
    expect(bodySummary(b).at(-1)).toEqual({ label: "Check", value: "1 invalid body", tone: "error" });
    expect(reportBodies(null)).toEqual([]);
  });
});

describe("printer fit", () => {
  const p2s = { x: 256, y: 256, z: 256 };
  it("fits inside the bed less its margin, with the room left per axis", () => {
    const fit = bedFit(reportBodies({ parts: [{ part: "a", bodies: [body([-32, -62, 0], [32, 18, 24])] }] }), p2s, 10)!;
    expect(fit.fits).toBe(true);
    expect(fit.usable).toEqual([236, 236, 256]);
    expect(fit.slack).toEqual([172, 156, 232]);
  });

  it("says by how much a part is too big, and which bodies float", () => {
    const fit = bedFit(
      reportBodies({ parts: [{ part: "a", bodies: [body([0, 0, 0], [240, 10, 10]), body([0, 20, 5], [10, 30, 15])] }] }),
      p2s,
      10,
    )!;
    expect(fit.fits).toBe(false);
    expect(fit.slack[0]).toBe(-4);
    expect(fit.floating).toEqual(["a · body 2"]);
  });
});

describe("inspect tools in the shell", () => {
  it("are disabled without bodies and open read-only panels with Forge's numbers", async () => {
    const h = await makeHarness({ source: BOX });
    const tools = new ToolRegistry();
    const shell = new Shell({ services: h.services, commands: h.commands, shellCommands: createShellCommandRegistry(() => h.services), tools });
    attachShell(h.services, shell);
    registerInspectTools(tools);
    // The fake engine reports no metrics: nothing to measure yet.
    expect(shell.enablement(tools.get("inspect.bodyProperties")!)).toEqual({ reason: "There are no bodies yet: build or open a part first" });
    expect(shell.enablement(tools.get("inspect.printerFit")!)).toEqual({ reason: "Printer profiles are in the desktop app" });
    // Give the report real metrics.
    const report = h.services.doc.getState().report!;
    (report.features[1] as { bodies?: unknown }).bodies = [body([-25, -25, 0], [25, 25, 5], 12500)];
    const r = await shell.startTool("inspect.bodyProperties");
    expect(r).toEqual({ started: true, panel: true });
    const panel = shell.getState().panel!;
    await panel.settled();
    const rows = Object.fromEntries(panel.getState().summary.map((x) => [x.label, x.value]));
    expect(rows["Volume"]).toBe("12500 mm³ (12.5 cm³)");
    expect(rows["Size (X × Y × Z)"]).toBe("50 × 50 × 5 mm");
    expect(panel.getState().readOnly).toBe(true);
    expect((await panel.commit()).ok).toBe(true);
    expect(shell.getState().panel).toBeNull();
  });
});

describe("starter parts", () => {
  it("bundles the five Alpha 0 starters with their prompts, and examples where Forge builds them", () => {
    expect(STARTERS.map((s) => s.id)).toEqual(["p1-storage-bin", "p2-phone-stand", "p3-cable-clip", "p4-knob", "p5-electronics-box"]);
    for (const s of STARTERS) expect(s.prompt.length).toBeGreaterThan(60);
    expect(STARTERS.filter((s) => s.source).map((s) => s.id)).toEqual(["p2-phone-stand", "p5-electronics-box"]);
    for (const s of STARTERS.filter((x) => !x.source)) expect(s.needs).toMatch(/IR v1/);
    expect(STARTERS[4]!.prompt).toContain("ESP32 dev board");
  });

  it("offers an example only when the document store compiles it, and never opens it half-compiled", async () => {
    const h = await makeHarness({ source: BLANK_SOURCE });
    const p5 = STARTERS.find((s) => s.id === "p5-electronics-box")!;
    // This app's store is IR v0: the parametric (v1) example must say why it cannot open.
    const a = await exampleAvailability(h.services, p5);
    expect(a).toMatchObject({ status: "unavailable", reason: expect.stringContaining("IR v1") });
    const r = await openExample(h.services, p5);
    expect(r.opened).toBe(false);
    expect(h.services.doc.getState().source).toBe(BLANK_SOURCE);
    const p1 = STARTERS.find((s) => s.id === "p1-storage-bin")!;
    expect(await exampleAvailability(h.services, p1)).toMatchObject({ status: "unavailable" });
  });
});
