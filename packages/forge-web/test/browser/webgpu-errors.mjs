// Headless-Chromium checks of forge-web's WebGPU error paths (audit V3/V4 and their
// review): the WebGPU self-test and the WebGL2 fallback, the error codes creation rejects
// with, and GPU faults found after creation. Each scenario runs in a fresh page of one
// browser with WebGPU enabled and asserts its outcome; faults are injected by wrapping
// WebGPU prototype methods in the page. The exit code is 0 only if every check passes.
//
//   node packages/forge-web/test/browser/webgpu-errors.mjs [scenario-prefix]
//
// Needs the built package (`pnpm --filter @aicad/forge-web run build`) and Playwright's
// Chromium (`pnpm --filter @aicad/desktop exec playwright install chromium`).
//   env: WEBGPU_ARGS (Chromium flags, space-separated; default `--enable-unsafe-webgpu`,
//        plus SwiftShader-Vulkan WebGPU flags on Linux), CHROMIUM_PATH (a browser binary
//        instead of Playwright's own), PLAYWRIGHT_FROM (a package.json whose dependencies
//        include @playwright/test; default packages/desktop/package.json), OUT_DIR
//        (default ./webgpu-errors-out; results as JSON)
//
// Every scenario but `auto-self-test-fails` and `webgpu-self-test-fails` needs a WebGPU
// device that passes forge-wasm's self-test; `webgpu-healthy` checks that one exists, and
// without it those scenarios fail (they would not exercise their paths otherwise).
// Not covered here: `RENDER_SURFACE` from a surface the adapter does not support. Neither
// of wgpu's web backends reports a surface without formats, so it cannot be provoked in a
// browser; forge-wasm's `scopes` unit tests cover the early return it takes.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const repoRoot = resolve(pkgRoot, "../..");
const require = createRequire(resolve(process.env.PLAYWRIGHT_FROM ?? join(repoRoot, "packages/desktop/package.json")));
const { chromium } = require("@playwright/test");

const only = process.argv[2] ?? "";
const OUT = resolve(process.env.OUT_DIR ?? "webgpu-errors-out");
mkdirSync(OUT, { recursive: true });
const ir = JSON.parse(readFileSync(join(repoRoot, "corpus/programs/extrude_box.json"), "utf8"));
const LINUX_WEBGPU = ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--disable-vulkan-surface"];
const args = process.env.WEBGPU_ARGS
  ? process.env.WEBGPU_ARGS.split(/\s+/).filter(Boolean)
  : ["--enable-unsafe-webgpu", ...(process.platform === "linux" ? LINUX_WEBGPU : [])];

// ---- static server for the package (dist/ + pkg/), cross-origin isolated ----------------

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>forge-web WebGPU errors</title></head>
<body><script type="module">
import * as fw from "/dist/index.js";
await fw.init();
window.fw = fw;
window.ready = true;
</script></body></html>`;
const types = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  if (p === "/") {
    res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    return;
  }
  if (!p.startsWith("/dist/") && !p.startsWith("/pkg/")) {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    const body = await readFile(join(pkgRoot, p));
    res.writeHead(200, { ...headers, "Content-Type": types[extname(p)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---- page-side helpers (run in the browser) ---------------------------------------------

/** Installed in every page before the scenario: helpers on `window.t`. */
function pageHelpers() {
  const t = {
    /** Wrap `proto[name]` with `wrap(orig)`; returns the restore function. */
    patch(proto, name, wrap) {
      const orig = proto[name];
      proto[name] = wrap(orig);
      return () => {
        proto[name] = orig;
      };
    },
    canvas() {
      const c = document.createElement("canvas");
      c.style.width = "320px";
      c.style.height = "240px";
      document.body.append(c);
      return c;
    },
    options: (backend, extra = {}) => ({ backend, width: 320, height: 240, devicePixelRatio: 1, autoResize: false, ...extra }),
    err: (e) => ({ code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 400) }),
    /** Load the IR, frame it from the top, render and pick the centre. */
    async exercise(vp, ir) {
      const status = vp.loadIr(ir).report.status;
      vp.setView("top");
      vp.render();
      const hit = await vp.pick(160, 120);
      return { backend: vp.backend(), status, pick: hit && { kind: hit.kind, face: hit.face } };
    },
    /**
     * Every render pipeline gets an invalid sample count: the JS device check (buffers
     * only) passes, forge-wasm's self-test (pipelines, a frame, a pick) fails before the
     * canvas is committed to WebGPU. Returns the restore function.
     */
    breakPipelines: () =>
      t.patch(GPUDevice.prototype, "createRenderPipeline", (orig) => function (d) {
        return orig.call(this, { ...d, multisample: { ...(d.multisample ?? {}), count: 3 } });
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async until(pred, ms = 3000) {
      const t0 = performance.now();
      while (!pred() && performance.now() - t0 < ms) await t.sleep(20);
      return pred();
    },
  };
  window.t = t;
}

// ---- scenarios ------------------------------------------------------------------------
// `run` executes in the page with `{ ir }` and returns plain data; `check(r)` returns
// [name, ok, detail] triples. Page errors (uncaught exceptions, WASM traps) always fail.

const facePick = (x) => !!x && x.status === "ok" && x.pick?.kind === "face" && typeof x.pick.face === "string";

const scenarios = [
  {
    name: "webgpu-healthy",
    about: "precondition: a WebGPU device passes forge-wasm's self-test and renders + picks",
    run: async ({ ir }) => {
      const vp = await fw.Viewport.create(t.canvas(), t.options("webgpu"));
      return { ...(await t.exercise(vp, ir)), fault: vp.gpuFault() };
    },
    check: (r) => [
      ["backend() is webgpu", r.backend === "webgpu", r.error ?? r.backend],
      ["loads, renders and picks a face", facePick(r), r.pick],
      ["no GPU fault", r.fault === null, r.fault],
    ],
  },
  {
    name: "webgl2-then-webgpu",
    about: "a WebGL2 viewport, then a WebGPU one on another canvas of the same page (audit V3: the WebGPU upload panicked after a WebGL2 context existed)",
    run: async ({ ir }) => {
      const a = await fw.Viewport.create(t.canvas(), t.options("webgl2"));
      const first = await t.exercise(a, ir);
      const b = await fw.Viewport.create(t.canvas(), t.options("webgpu"));
      const second = await t.exercise(b, ir);
      const again = await t.exercise(a, ir);
      return { first, second, again, faults: [a.gpuFault(), b.gpuFault()] };
    },
    check: (r) => [
      ["the first viewport is webgl2 and picks a face", r.first?.backend === "webgl2" && facePick(r.first), r.error ?? r.first],
      ["the second viewport is webgpu and picks a face", r.second?.backend === "webgpu" && facePick(r.second), r.second],
      ["the WebGL2 viewport still works", facePick(r.again), r.again],
      ["no GPU faults", r.faults?.every((f) => f === null), r.faults],
    ],
  },
  {
    name: "auto-self-test-fails",
    about: "auto: the WebGPU device fails the self-test, so the still-free canvas gets WebGL2",
    run: async ({ ir }) => {
      t.breakPipelines();
      const vp = await fw.Viewport.create(t.canvas(), t.options("auto"));
      const fb = vp.backendFallback();
      return { ...(await t.exercise(vp, ir)), fallback: fb && t.err(fb) };
    },
    check: (r) => [
      ["backend() is webgl2", r.backend === "webgl2", r.error ?? r.backend],
      ["backendFallback() is RENDER_WEBGPU_UNHEALTHY naming the self-test", r.fallback?.code === "RENDER_WEBGPU_UNHEALTHY" && /device self-test failed/.test(r.fallback.message), r.fallback],
      ["the fallback loads, renders and picks a face", facePick(r), r.pick],
    ],
  },
  {
    name: "webgpu-self-test-fails",
    about: "explicit webgpu: a device failing the self-test rejects with RENDER_NO_ADAPTER (audit V4) and leaves the canvas free",
    run: async ({ ir }) => {
      const restore = t.breakPipelines();
      const canvas = t.canvas();
      let error = null;
      try {
        await fw.Viewport.create(canvas, t.options("webgpu"));
      } catch (e) {
        error = t.err(e);
      }
      restore();
      const vp = await fw.Viewport.create(canvas, t.options("webgl2"));
      return { rejected: error, after: await t.exercise(vp, ir) };
    },
    check: (r) => [
      ["create rejects with RENDER_NO_ADAPTER", r.rejected?.code === "RENDER_NO_ADAPTER", r.error ?? r.rejected],
      ["the message names the WebGPU self-test", /^webgpu: device self-test failed: /.test(r.rejected?.message ?? ""), r.rejected?.message],
      ["the same canvas then takes WebGL2", r.after?.backend === "webgl2" && facePick(r.after), r.after],
    ],
  },
  {
    name: "canvas-configure-fault",
    about: "the device faults configuring the committed canvas: creation rejects with RENDER_GPU (no trap)",
    run: async () => {
      const canvas = t.canvas();
      t.patch(GPUCanvasContext.prototype, "configure", (orig) => function (c) {
        return orig.call(this, this.canvas === canvas ? { ...c, viewFormats: ["r32float"] } : c);
      });
      try {
        await fw.Viewport.create(canvas, t.options("webgpu"));
        return { rejected: null };
      } catch (e) {
        return { rejected: t.err(e) };
      }
    },
    check: (r) => [
      ["create rejects with RENDER_GPU", r.rejected?.code === "RENDER_GPU", r.error ?? r.rejected],
      ["the message says the canvas setup failed", /webgpu: the device failed setting up the canvas or drawing the first frame/.test(r.rejected?.message ?? ""), r.rejected?.message],
    ],
  },
  {
    name: "fault-after-create",
    about: "an upload faults after creation: one `error` event, then render/pick throw RENDER_GPU",
    run: async ({ ir }) => {
      const vp = await fw.Viewport.create(t.canvas(), t.options("webgpu", { autoRender: false }));
      const events = [];
      vp.on((e) => e.type === "error" && events.push(t.err(e.error)));
      const before = await t.exercise(vp, ir);
      const restore = t.patch(GPUQueue.prototype, "writeBuffer", (orig) => function (b, off, ...rest) {
        return orig.call(this, b, b.size + 1024, ...rest);
      });
      let loadAfter = "returned";
      try {
        vp.loadIr(ir);
      } catch (e) {
        loadAfter = t.err(e);
      }
      restore();
      await t.until(() => events.length > 0);
      await t.sleep(200);
      const fault = vp.gpuFault();
      let render = "ok";
      try {
        vp.render();
      } catch (e) {
        render = t.err(e);
      }
      let pick = "ok";
      try {
        await vp.pick(160, 120);
      } catch (e) {
        pick = t.err(e);
      }
      return { before, loadAfter, events, fault: fault && t.err(fault), render, pick };
    },
    check: (r) => [
      ["healthy before the fault", facePick(r.before), r.error ?? r.before],
      ["exactly one `error` event, RENDER_GPU", r.events?.length === 1 && r.events[0].code === "RENDER_GPU", r.events],
      ["gpuFault() is RENDER_GPU", r.fault?.code === "RENDER_GPU", r.fault],
      ["render() throws RENDER_GPU", r.render?.code === "RENDER_GPU", r.render],
      ["pick() rejects with RENDER_GPU", r.pick?.code === "RENDER_GPU", r.pick],
    ],
  },
  {
    name: "pick-fault-no-listener",
    about: "a pick faults with no `error` listener: the awaiting caller gets RENDER_GPU and nothing is thrown asynchronously besides (review of V3: it was reported twice)",
    run: async ({ ir }) => {
      const vp = await fw.Viewport.create(t.canvas(), t.options("webgpu", { autoRender: false }));
      const before = await t.exercise(vp, ir);
      const restore = t.patch(GPUDevice.prototype, "createBuffer", (orig) => function (d) {
        return orig.call(this, d.label === "pick readback" ? { ...d, usage: d.usage | GPUBufferUsage.MAP_WRITE } : d);
      });
      let pick = "resolved";
      try {
        await vp.pick(160, 120);
      } catch (e) {
        pick = t.err(e);
      }
      restore();
      await t.sleep(300);
      const fault = vp.gpuFault();
      return { before, pick, fault: fault && t.err(fault) };
    },
    check: (r) => [
      ["healthy before the fault", facePick(r.before), r.error ?? r.before],
      ["pick() rejects with RENDER_GPU", r.pick?.code === "RENDER_GPU", r.pick],
      ["gpuFault() is RENDER_GPU", r.fault?.code === "RENDER_GPU", r.fault],
    ],
  },
  {
    name: "lost-device",
    about: "the device is lost outside any call: gpuFault() reports it at once and emits it (review of V4)",
    run: async ({ ir }) => {
      let device = null;
      t.patch(GPUAdapter.prototype, "requestDevice", (orig) => async function (...a) {
        device = await orig.apply(this, a);
        return device;
      });
      const vp = await fw.Viewport.create(t.canvas(), t.options("webgpu", { autoRender: false }));
      const events = [];
      vp.on((e) => e.type === "error" && events.push(t.err(e.error)));
      const before = await t.exercise(vp, ir);
      const healthy = vp.gpuFault();
      device.destroy();
      await device.lost;
      await t.sleep(100);
      const fault = vp.gpuFault();
      return { before, healthy, fault: fault && t.err(fault), events };
    },
    check: (r) => [
      ["healthy before the loss", facePick(r.before) && r.healthy === null, r.error ?? r.before],
      ["gpuFault() is RENDER_GPU (device-lost) with no call in between", r.fault?.code === "RENDER_GPU" && /device-lost/.test(r.fault.message), r.fault],
      ["one `error` event", r.events?.length === 1 && r.events[0].code === "RENDER_GPU", r.events],
    ],
  },
];

// ---- runner -----------------------------------------------------------------------------

const browser = await chromium.launch({
  headless: true,
  args,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
});
const results = { chromium: browser.version(), args, scenarios: {} };
let failed = 0;
try {
  for (const s of scenarios) {
    if (!s.name.startsWith(only)) continue;
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 400)));
    await page.goto(base);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });
    await page.evaluate(pageHelpers);
    let r;
    try {
      r = await page.evaluate(`(${s.run})(${JSON.stringify({ ir })})`);
    } catch (e) {
      r = { error: String(e?.message ?? e).slice(0, 600) };
    }
    await page.waitForTimeout(100);
    const checks = [...s.check(r), ["no uncaught errors or WASM traps", pageErrors.length === 0, pageErrors]];
    console.log(`\n# ${s.name}: ${s.about}`);
    for (const [name, ok, detail] of checks) {
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
    }
    results.scenarios[s.name] = { result: r, pageErrors, checks: checks.map(([name, ok]) => ({ name, ok })) };
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  writeFileSync(join(OUT, "webgpu-errors.json"), JSON.stringify(results, null, 2));
}
const ran = Object.keys(results.scenarios).length;
console.log(`\nRESULT webgpu-errors: ${failed === 0 && ran > 0 ? "PASS" : "FAIL"} (${ran} scenarios, ${failed} failed checks)`);
process.exitCode = failed === 0 && ran > 0 ? 0 : 1;
