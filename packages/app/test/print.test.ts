/**
 * "Open in Bambu Studio" in the app (ALPHA-0-PLAN W3/W5): the compiled IR and the document name
 * go to the desktop shell's `slicer:open`, and each outcome becomes a toast (with Show in Finder
 * when a file was written).
 */
import { describe, expect, it } from "vitest";
import type { OpenInSlicerRequest, OpenInSlicerResult, PrintBridge, SlicerInfo } from "../src/bridge";
import { openInSlicer, printableIr, type PrintableIrStore } from "../src/print/open-in-slicer";
import { BOX, HEADER, makeHarness } from "./helpers";

const SLICER: SlicerInfo = {
  found: true,
  name: "Bambu Studio",
  bundleId: "com.bambulab.bambu-studio",
  path: "/Applications/BambuStudio.app",
  version: "02.06.00.51",
  source: "applications",
  customPath: null,
};

class FakePrintBridge implements PrintBridge {
  requests: OpenInSlicerRequest[] = [];
  revealed: string[] = [];
  constructor(public next: OpenInSlicerResult) {}
  profile(): never {
    throw new Error("unused");
  }
  detectSlicer(): Promise<SlicerInfo> {
    return Promise.resolve(SLICER);
  }
  setSlicerPath(): Promise<SlicerInfo> {
    return Promise.resolve(SLICER);
  }
  openInSlicer(request: OpenInSlicerRequest): Promise<OpenInSlicerResult> {
    this.requests.push(request);
    return Promise.resolve(this.next);
  }
  reveal(path: string): Promise<void> {
    this.revealed.push(path);
    return Promise.resolve();
  }
}

const FILE = "/Users/me/PartZero/Prints/test-1a2b3c4d.3mf";

async function harnessWith(print: FakePrintBridge | null, source = BOX) {
  const h = await makeHarness({ source });
  Object.assign(h.host, { print });
  return h;
}

describe("Open in Bambu Studio", () => {
  it("sends the compiled IR and the document name, and offers Show in Finder", async () => {
    const bridge = new FakePrintBridge({ status: "opened", file: FILE, receipt: FILE.replace(".3mf", ".receipt.json"), slicer: SLICER, bodies: 1, bytes: 1234, alreadyRunning: false, warnings: [] });
    const h = await harnessWith(bridge);
    const r = await openInSlicer(h.services);
    expect(r.status).toBe("opened");
    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]!.docName).toBe("test");
    const ir = JSON.parse(bridge.requests[0]!.irJson) as { schema: string; parts: Array<{ name: string }> };
    expect(ir.schema).toBe("aicad.ir/0");
    expect(ir.parts[0]!.name).toBe("plate");
    const toast = h.services.ui.getState().toasts.at(-1)!;
    // "Sent", not "Opened": `open` handed the file over, nobody saw Bambu Studio load it.
    expect(toast).toMatchObject({ kind: "success", message: "Sent test-1a2b3c4d.3mf to Bambu Studio." });
    toast.action!.run();
    expect(bridge.revealed).toEqual([FILE]);
  });

  it("says where the file is and how to fix it when Bambu Studio is missing", async () => {
    const bridge = new FakePrintBridge({
      status: "exported",
      file: FILE,
      receipt: FILE.replace(".3mf", ".receipt.json"),
      slicer: { ...SLICER, found: false, path: null, version: null, source: null },
      bodies: 1,
      bytes: 1234,
      warnings: [],
      message: "Saved to /Users/me/PartZero/Prints. Bambu Studio isn't installed in /Applications or ~/Applications.",
      fix: "Install Bambu Studio from bambulab.com, or set its path in Settings.",
    });
    const h = await harnessWith(bridge);
    await openInSlicer(h.services);
    const toast = h.services.ui.getState().toasts.at(-1)!;
    expect(toast.kind).toBe("info");
    expect(toast.message).toMatch(/Saved to .*isn't installed.*Install Bambu Studio/);
    expect(toast.action?.label).toBe("Show in Finder");
  });

  it("shows a refusal as an error, with no file to show", async () => {
    const bridge = new FakePrintBridge({ status: "refused", code: "EXPORT_BED_FIT", message: "It doesn't fit the Bambu Lab P2S: 14 mm too large in X." });
    const h = await harnessWith(bridge);
    expect(await openInSlicer(h.services)).toMatchObject({ status: "refused", code: "EXPORT_BED_FIT" });
    const toast = h.services.ui.getState().toasts.at(-1)!;
    expect(toast).toMatchObject({ kind: "error", message: "It doesn't fit the Bambu Lab P2S: 14 mm too large in X." });
    expect(toast.action).toBeUndefined();
  });

  it("refuses code with errors, and needs the desktop app", async () => {
    const bridge = new FakePrintBridge({ status: "refused", code: "EXPORT_FAILED", message: "unused" });
    const broken = await harnessWith(bridge, `${HEADER}\npart("p");\nconst s = sketch(XY, { a: line([0, 0], [1 });\n`);
    await expect(openInSlicer(broken.services)).rejects.toThrow(/the code has \d+ errors?/);
    expect(bridge.requests).toHaveLength(0);
    const web = await harnessWith(null);
    await expect(openInSlicer(web.services)).rejects.toThrow(/needs the desktop app/);
  });

  it("warns that a running Bambu Studio may open a new window, and passes on layout warnings", async () => {
    const floating = { code: "EXPORT_BODY_FLOATING", message: 'body "p/lid" starts 21 mm above the bed; a slicer drops it onto the plate' };
    const bridge = new FakePrintBridge({ status: "opened", file: FILE, receipt: FILE, slicer: SLICER, bodies: 2, bytes: 1, alreadyRunning: true, warnings: [floating] });
    const h = await harnessWith(bridge);
    await openInSlicer(h.services);
    const toast = h.services.ui.getState().toasts.at(-1)!;
    expect(toast.kind).toBe("info");
    expect(toast.message).toBe(
      `Sent test-1a2b3c4d.3mf to Bambu Studio. Bambu Studio was already open, so it may open this in a new window: close the previous one when you're done. Note: ${floating.message}.`,
    );
    expect(toast.action?.label).toBe("Show in Finder");
  });
});

/** A stand-in for Phase C's `IrDocStore`: a canonical v1 document, changed by transactions. */
class FakeIrStore implements PrintableIrStore {
  state: { document: string | null; busy: boolean };
  constructor(document: string | null) {
    this.state = { document, busy: false };
  }
  getState(): { document: string | null; busy: boolean } {
    return this.state;
  }
  /** `setParam` as a transaction: busy while the engine works, then the new document. */
  setParam(name: string, value: string, ms: number): Promise<void> {
    this.state = { ...this.state, busy: true };
    return new Promise((done) =>
      setTimeout(() => {
        const doc = JSON.parse(this.state.document!) as { params: Record<string, string> };
        doc.params[name] = value;
        this.state = { document: JSON.stringify(doc), busy: false };
        done();
      }, ms),
    );
  }
}

const V1_DOC = JSON.stringify({ schema: "aicad.ir/1", params: { width: "40 mm" }, parts: [] });

describe("which document Open in Bambu Studio exports", () => {
  it("exports the IR v1 document of record, after a parameter edit has landed", async () => {
    const bridge = new FakePrintBridge({ status: "opened", file: FILE, receipt: FILE, slicer: SLICER, bodies: 1, bytes: 1, alreadyRunning: false, warnings: [] });
    const h = await harnessWith(bridge);
    const ir = new FakeIrStore(V1_DOC);
    const edit = ir.setParam("width", "55 mm", 120);
    // Pressed while the edit is still running: it waits for it rather than exporting the old width.
    await openInSlicer({ ...h.services, ir });
    await edit;
    expect(bridge.requests).toHaveLength(1);
    const sent = JSON.parse(bridge.requests[0]!.irJson) as { schema: string; params: Record<string, string> };
    expect(sent.schema).toBe("aicad.ir/1");
    expect(sent.params["width"]).toBe("55 mm");
    expect(bridge.requests[0]!.docName).toBe("test");
  });

  it("uses the CadScript document when no v1 document is loaded, and refuses while the v1 store stays busy", async () => {
    const h = await harnessWith(null);
    const empty = new FakeIrStore(null);
    expect(JSON.parse((await printableIr({ ...h.services, ir: empty })).irJson)).toMatchObject({ schema: "aicad.ir/0" });
    const stuck = new FakeIrStore(V1_DOC);
    stuck.state.busy = true;
    await expect(printableIr({ ...h.services, ir: stuck }, 100)).rejects.toThrow(/still being changed/);
  });
});
