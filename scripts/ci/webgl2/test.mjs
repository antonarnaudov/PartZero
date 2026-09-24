// Headless-Chromium check of forge-render's WebGL2 path through the packages/forge-web
// demo (spike 05 criterion "WebGL2 fallback works on Linux"; audit finding M7). Runs in CI
// (.github/workflows/ci.yml, job `webgl2`) against a static build of the demo served by
// serve.mjs (COOP/COEP), on Mesa llvmpipe (ANGLE → GLES → EGL) or SwiftShader.
//
//   node scripts/ci/webgl2/test.mjs <scenario> [dpr]
//     scenarios: llvmpipe | swiftshader | auto | auto-fallback | webgpu-noflags | webgpu-unsafe
//     `auto` expects whichever backend the browser can give (WebGPU if an adapter shows up);
//     `auto-fallback` (the CI one) *requires* that `navigator.gpu.requestAdapter()` resolves
//     null and that `backend: "auto"` then falls back to WebGL2, so the fallback path cannot
//     silently drop out of coverage when a runner's Chromium starts offering WebGPU.
//   env: BASE_URL (default http://127.0.0.1:8080), OUT_DIR (default ./webgl2-out),
//        DOC (default extrude_box), BENCH_N (default 20), CHROMIUM_PATH (a browser binary
//        instead of Playwright's own),
//        PLAYWRIGHT_FROM (a package.json whose dependencies include @playwright/test;
//        default packages/desktop/package.json)
//
// Exit code 0 only if every check passes. Results (JSON) and screenshots go to OUT_DIR.
// Edit latency is recorded, not gated: software rasterizers are far slower than GPUs.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(resolve(process.env.PLAYWRIGHT_FROM ?? join(repoRoot, "packages/desktop/package.json")));
const { chromium } = require("@playwright/test");

const scenario = process.argv[2] ?? "llvmpipe";
const dpr = Number(process.argv[3] ?? 1);
const doc = process.env.DOC ?? "extrude_box";
const benchN = Number(process.env.BENCH_N ?? 20);
const base = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const tag = `${scenario}-dpr${dpr}`;
const OUT = resolve(process.env.OUT_DIR ?? "webgl2-out");
mkdirSync(OUT, { recursive: true });

const SWIFT = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const MESA = ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist"];
const WEBGPU = [...SWIFT, "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-webgpu-adapter=swiftshader"];
const cfg = {
  swiftshader: { args: SWIFT, backend: "webgl2", renderer: /swiftshader/i },
  llvmpipe: { args: MESA, backend: "webgl2", renderer: /llvmpipe/i },
  auto: { args: SWIFT, backend: "auto" }, // expects WebGPU if an adapter exists, else WebGL2
  "auto-fallback": { args: SWIFT, backend: "auto", requireNoAdapter: true }, // must fall back to WebGL2
  "webgpu-noflags": { args: SWIFT, backend: "webgpu" },
  "webgpu-unsafe": { args: WEBGPU, backend: "webgpu" },
}[scenario];
if (!cfg) throw new Error(`unknown scenario ${scenario}`);

const result = { scenario, dpr, doc, args: cfg.args, requestedBackend: cfg.backend, checks: {}, console: [], pageErrors: [] };
const check = (name, ok, detail) => {
  result.checks[name] = { ok: !!ok, detail };
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const browser = await chromium.launch({ headless: true, args: cfg.args, executablePath: process.env.CHROMIUM_PATH || undefined });
result.chromium = browser.version();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") result.console.push(`${m.type()}: ${m.text()}`.slice(0, 400));
});
page.on("pageerror", (e) => result.pageErrors.push(String(e).slice(0, 400)));

const shot = async (name) => {
  const p = join(OUT, `${tag}-${doc}-${name}.png`);
  await page.waitForTimeout(600); // let the demo's 500 ms stats panel refresh
  await page.screenshot({ path: p });
  return p;
};
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

try {
  const t0 = Date.now();
  await page.goto(`${base}/?backend=${cfg.backend}&doc=${doc}`, { waitUntil: "load" });
  await page.waitForFunction(
    () => {
      const b = document.getElementById("backend")?.textContent;
      const f = document.getElementById("pick")?.textContent ?? "";
      return (globalThis.forgeDemo?.viewport && b && b !== "…") || f.startsWith("Failed");
    },
    null,
    { timeout: 180_000 },
  );
  result.startupMs = Date.now() - t0;
  const failed = await page.evaluate(() => {
    const f = document.getElementById("pick")?.textContent ?? "";
    return f.startsWith("Failed") ? f : null;
  });
  result.env = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    let gpuAdapter = "navigator.gpu missing";
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter().catch((e) => String(e));
      gpuAdapter = a && typeof a === "object" ? { ...(a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, fallback: a.info.isFallbackAdapter } : {}) } : a;
    }
    return {
      ua: navigator.userAgent,
      webgl2Renderer: gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null,
      webgpuAdapter: gpuAdapter,
      crossOriginIsolated: globalThis.crossOriginIsolated,
    };
  });
  console.log("env", JSON.stringify(result.env));
  check("page is cross-origin isolated", result.env.crossOriginIsolated === true, result.env.crossOriginIsolated);
  if (cfg.renderer) check(`WebGL2 renderer matches ${cfg.renderer}`, cfg.renderer.test(result.env.webgl2Renderer ?? ""), result.env.webgl2Renderer);
  if (cfg.requireNoAdapter) {
    // The precondition of the fallback test: navigator.gpu exists and offers no adapter.
    // Anything else (an adapter, a rejected promise, no navigator.gpu at all) means this run
    // does not exercise the requestAdapter() → null → WebGL2 path, so it fails loudly.
    check("navigator.gpu.requestAdapter() resolves null (no WebGPU adapter)", result.env.webgpuAdapter === null, result.env.webgpuAdapter);
  }
  if (failed) {
    result.startError = failed;
    check("viewport created", false, failed);
    await shot("failed");
    throw new Error("viewport creation failed");
  }

  const backend = await page.evaluate(() => forgeDemo.viewport.backend());
  result.backend = backend;
  const expectBackend = cfg.requireNoAdapter
    ? "webgl2"
    : cfg.backend === "auto"
      ? result.env.webgpuAdapter && typeof result.env.webgpuAdapter === "object" ? "webgpu" : "webgl2"
      : cfg.backend;
  check(`viewport.backend() === '${expectBackend}'`, backend === expectBackend, backend);

  // Load the document through the automation hook to get its report (bounds for the section).
  const load = await page.evaluate((d) => {
    const r = forgeDemo.selectDoc(d);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const f of r.report.features) for (const b of f.bodies ?? []) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.bbox_min[k]); max[k] = Math.max(max[k], b.bbox_max[k]);
    }
    return { status: r.report.status, timings: r.timings, bodies: r.report.features.reduce((n, f) => n + (f.bodies?.length ?? 0), 0), min, max };
  }, doc);
  result.load = load;
  check("document evaluated", load.status === "ok" && load.bodies > 0, { status: load.status, bodies: load.bodies });
  await page.evaluate(() => forgeDemo.viewport.render());
  await settle();
  result.stats = await page.evaluate(() => forgeDemo.viewport.stats());
  console.log("stats", JSON.stringify(result.stats));
  result.screens = { loaded: await shot("01-loaded") };

  const size = await page.evaluate(() => {
    const c = document.getElementById("view");
    return { w: c.clientWidth, h: c.clientHeight, pw: c.width, ph: c.height };
  });
  result.canvas = size;
  const cx = size.w / 2, cy = size.h / 2;

  // 1. Programmatic pick at the image centre.
  const pickC = await page.evaluate(([x, y]) => forgeDemo.viewport.pick(x, y), [cx, cy]);
  result.pickCentre = pickC;
  check("pick(centre) returns a face name", pickC && pickC.kind === "face" && typeof pickC.face === "string" && pickC.face.length > 0, pickC && { kind: pickC.kind, body: pickC.body, face: pickC.face, point: pickC.point });
  const pickBg = await page.evaluate(() => forgeDemo.viewport.pick(1275, 5));
  result.pickBackground = pickBg;
  check("pick(background corner) returns null", pickBg === null, pickBg && { kind: pickBg.kind, face: pickBg.face });

  // 2. Real input: hover + click-select at the centre via attachControls.
  await page.mouse.move(cx - 3, cy - 3);
  await page.mouse.move(cx, cy, { steps: 3 });
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);
  await page.waitForFunction(() => (forgeDemo.viewport.selection?.() ?? []).length > 0, null, { timeout: 15_000 }).catch(() => {});
  const sel = await page.evaluate(() => forgeDemo.viewport.selection());
  result.selectionAfterClick = sel;
  check("mouse click selects the centre face", Array.isArray(sel) && sel.length === 1 && sel[0].face === pickC?.face, sel?.map((s) => s.face ?? s.edge));
  await settle();
  result.screens.selected = await shot("02-selected");

  // 3. Section: toggle the demo's Section checkbox (Z axis, mid-height, removes z > mid).
  const planeZ = (load.min[2] + load.max[2]) / 2;
  result.sectionPlaneZ = planeZ;
  // A grid of picks over the model's screen area, before and after the section.
  const grid = async () =>
    page.evaluate(async ([w, h]) => {
      const out = [];
      for (let j = 1; j < 16; j++) for (let i = 1; i < 24; i++) {
        const x = (w * i) / 24, y = (h * j) / 16;
        const p = await forgeDemo.viewport.pick(x, y);
        if (p) out.push({ kind: p.kind, face: p.face, z: p.point ? p.point[2] : null });
      }
      return out;
    }, [size.w, size.h]);
  const before = await grid();
  await page.click("#section");
  await page.waitForTimeout(200);
  await page.evaluate(() => forgeDemo.viewport.render());
  await settle();
  result.screens.section = await shot("03-section");
  const after = await grid();
  const eps = 0.25;
  const summarize = (g) => ({
    hits: g.length,
    faces: g.filter((p) => p.kind === "face").length,
    edges: g.filter((p) => p.kind === "edge").length,
    section: g.filter((p) => p.kind === "section").length,
    aboveFace: g.filter((p) => p.kind === "face" && p.z > planeZ + eps).length,
    maxFaceZ: Math.max(...g.filter((p) => p.kind === "face").map((p) => p.z)),
    capZ: g.filter((p) => p.kind === "section").map((p) => p.z).reduce((a, z) => [Math.min(a[0], z), Math.max(a[1], z)], [Infinity, -Infinity]),
  });
  result.sectionGrid = { before: summarize(before), after: summarize(after) };
  console.log("section grid", JSON.stringify(result.sectionGrid));
  check("before section: some faces lie above the plane", result.sectionGrid.before.aboveFace > 0, result.sectionGrid.before);
  check("section on: no pick hits material above the plane", result.sectionGrid.after.aboveFace === 0, result.sectionGrid.after.aboveFace);
  const s = result.sectionGrid.after;
  check("section on: caps are pickable (kind 'section') at the plane", s.section > 0 && Math.abs(s.capZ[0] - planeZ) < eps && Math.abs(s.capZ[1] - planeZ) < eps, { caps: s.section, capZ: s.capZ, planeZ });
  const pickSecC = await page.evaluate(([x, y]) => forgeDemo.viewport.pick(x, y), [cx, cy]);
  result.pickCentreSectioned = pickSecC;
  console.log("pick(centre) sectioned", JSON.stringify(pickSecC && { kind: pickSecC.kind, face: pickSecC.face, point: pickSecC.point }));
  // Toggle off again and verify the geometry comes back.
  await page.click("#section");
  await page.waitForTimeout(200);
  const off = summarize(await grid());
  check("section off: geometry above the plane is back", off.aboveFace > 0 && off.section === 0, off);

  // 4. Benchmark: forgeDemo.runBench() (switches to the 25-feature fixture, 20 edits, main thread).
  const bench = await page.evaluate((n) => forgeDemo.runBench(n), benchN);
  result.bench = bench;
  console.log("bench", JSON.stringify({ median: bench.median, p95: bench.p95, max: bench.max, frameWaitMedian: bench.frameWaitMedian }));
  check("runBench completed", Number.isFinite(bench.median) && bench.samples.length === benchN, { median: bench.median, p95: bench.p95 });
  await page.evaluate(() => forgeDemo.viewport.render());
  await settle();
  result.screens.bench = await shot("04-bench");
  result.benchStats = await page.evaluate(() => forgeDemo.viewport.stats());
  const pickBench = await page.evaluate(([x, y]) => forgeDemo.viewport.pick(x, y), [cx, cy]);
  result.pickBenchCentre = pickBench && { kind: pickBench.kind, body: pickBench.body, face: pickBench.face, edge: pickBench.edge };
  check("pick(centre) on the 25-feature fixture", !!pickBench && (pickBench.face || pickBench.edge), result.pickBenchCentre);

  // Split the edit latency: CPU side (evaluate + tessellate + upload, from LoadResult.timings
  // via selectDoc on the fixture) vs. software-GPU frame + fence (render + 1-px pick, no edit).
  result.split = await page.evaluate(async () => {
    const vp = forgeDemo.viewport;
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const cpu = [], ev = [], tess = [], up = [], fence = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const r = forgeDemo.selectDoc("bench_fixture_25");
      cpu.push(performance.now() - t0);
      ev.push(r.timings.parseMs + r.timings.evaluateMs); tess.push(r.timings.tessellateMs); up.push(r.timings.uploadMs ?? NaN);
    }
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      vp.render();
      await vp.pick(0, 0);
      fence.push(performance.now() - t0);
    }
    return { loadIrWallMedian: med(cpu), evaluateMedian: med(ev), tessellateMedian: med(tess), uploadMedian: med(up), renderPlusFenceMedian: med(fence), renderPlusFenceSamples: fence };
  });
  console.log("split", JSON.stringify(result.split));

  // Frame time while orbiting.
  result.frames = await page.evaluate(() => forgeDemo.measureFrames(60));
  console.log("frames", JSON.stringify(result.frames));
  // Worker edit path, 10 edits. On SwiftShader (the auto-fallback run) this is a timing
  // measurement on a CPU rasteriser about 4x slower than llvmpipe, where a pick-buffer map can
  // exceed forge-wasm's 5 s readback timeout; that run checks the fallback, not speed, so a
  // timeout there is logged and skipped instead of failing the job.
  await page.selectOption("#editPath", "worker");
  try {
    const benchW = await page.evaluate(() => forgeDemo.runBench(10));
    result.benchWorker = { median: benchW.median, p95: benchW.p95, max: benchW.max, frameWaitMedian: benchW.frameWaitMedian };
    console.log("bench worker", JSON.stringify(result.benchWorker));
  } catch (e) {
    if (scenario === "llvmpipe" || !/timed out mapping/.test(String(e))) throw e;
    result.benchWorker = { skipped: String(e).split("\n")[0] };
    console.log("SKIP bench worker (slow software renderer)", result.benchWorker.skipped);
  }
  await page.selectOption("#editPath", "main");

  // Fixture cut on Y (as in the spike's WebGL2 screenshot), iso view.
  await page.selectOption("#secAxis", "Y");
  await page.click("#section");
  await page.click("#secFlip"); // remove the near half so the caps face the iso camera
  await page.evaluate(() => { forgeDemo.viewport.setView("iso"); forgeDemo.viewport.fitView(); forgeDemo.viewport.render(); });
  await settle();
  result.screens.benchSectionY = await shot("05-bench-section-y");

  const errs = result.console.filter((c) => c.startsWith("error")).concat(result.pageErrors);
  check("no console errors / page errors", errs.length === 0, errs.slice(0, 5));
} catch (e) {
  result.error = String(e?.stack ?? e).slice(0, 2000);
  console.log("ERROR", result.error);
} finally {
  result.pass = !result.error && Object.keys(result.checks).length > 0 && Object.values(result.checks).every((c) => c.ok);
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(result, null, 2));
  console.log(`RESULT ${tag}: ${result.pass ? "PASS" : "FAIL"}`);
  await browser.close();
  process.exitCode = result.pass ? 0 : 1;
}
