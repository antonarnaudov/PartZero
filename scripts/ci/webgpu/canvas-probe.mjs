// Can this runner's headless Chromium present WebGPU to a canvas? A check with no Forge
// code in it (plain WebGPU on a blank page), run by the `webgl2` job of
// .github/workflows/ci.yml before packages/forge-web/test/browser/webgpu-errors.mjs, in the
// same browser configuration: the same Playwright, `channel: "chromium"` (or CHROMIUM_PATH)
// and the same WEBGPU_ARGS.
//
//   node scripts/ci/webgpu/canvas-probe.mjs
//
// Exit code:
//   0  WebGPU renders and reads back offscreen, and a canvas configured with the preferred
//      format takes three cleared frames with the device still alive and no error:
//      every webgpu-errors scenario can run, and must pass.
//   3  WebGPU works offscreen, but the plain canvas loses the device or raises an error:
//      this browser cannot present WebGPU to a canvas, so no WebGPU viewport can be made.
//   1  anything else (no navigator.gpu, no adapter, the offscreen frame or its read-back
//      fails, the probe itself fails): nothing to explain it by, so the CI step fails.
//
// Why (CI runs up to 967af9e, Chromium 153.0.8010.12, SwiftShader Vulkan): forge-wasm's
// offscreen self-test passed on the WebGPU device, then every viewport lost that device
// ("Destroyed: Device was destroyed.") at canvas setup, including a canvas-configure call
// the test had deliberately broken. Upstream, WebGPU canvas presentation in headless
// Chromium on Linux is a known gap. This probe tells that environment apart from a Forge
// bug on every run, instead of assuming either.
//
//   env: WEBGPU_ARGS (Chromium flags, space-separated; default as webgpu-errors.mjs:
//        `--enable-unsafe-webgpu`, plus SwiftShader-Vulkan WebGPU flags on Linux),
//        CHROMIUM_PATH, PLAYWRIGHT_FROM (as webgpu-errors.mjs), OUT_DIR (default
//        ./webgpu-canvas-probe-out; the result as JSON)
//
// For information only (never the exit code), Playwright's chrome-headless-shell is probed
// with the same flags too, unless CHROMIUM_PATH is set.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(resolve(process.env.PLAYWRIGHT_FROM ?? join(repoRoot, "packages/desktop/package.json")));
const { chromium } = require("@playwright/test");

const OUT = resolve(process.env.OUT_DIR ?? "webgpu-canvas-probe-out");
mkdirSync(OUT, { recursive: true });
// Keep in step with packages/forge-web/test/browser/webgpu-errors.mjs (LINUX_WEBGPU, args).
const LINUX_WEBGPU = ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--disable-vulkan-surface"];
const args = process.env.WEBGPU_ARGS
  ? process.env.WEBGPU_ARGS.split(/\s+/).filter(Boolean)
  : ["--enable-unsafe-webgpu", ...(process.platform === "linux" ? LINUX_WEBGPU : [])];

// A secure, cross-origin-isolated blank page, as webgpu-errors.mjs serves.
const server = createServer((req, res) => {
  res
    .writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    })
    .end(`<!doctype html><html><head><meta charset="utf-8"><title>WebGPU canvas probe</title></head><body></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

/** Runs in the page: plain WebGPU offscreen, then on a canvas. Returns plain data. */
async function probeInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const timed = (p, ms, what) =>
    Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what} did not complete in ${ms} ms`)))]);
  const frame = () => timed(new Promise((r) => requestAnimationFrame(() => r())), 1000, "requestAnimationFrame").catch(() => undefined);
  const msg = (e) => String(e?.message ?? e).slice(0, 400);
  const r = { gpu: !!navigator.gpu, adapter: null, offscreen: null, canvas: null, lost: null, uncaptured: [] };
  if (!navigator.gpu) return r;
  const adapter = await timed(navigator.gpu.requestAdapter(), 10_000, "requestAdapter");
  if (!adapter) return r;
  const info = adapter.info ?? {};
  r.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
  const device = await timed(adapter.requestDevice(), 10_000, "requestDevice");
  let phase = "offscreen";
  device.lost.then((i) => {
    r.lost = { reason: i.reason, message: i.message, phase };
  });
  device.addEventListener("uncapturederror", (e) => r.uncaptured.push({ phase, message: msg(e.error) }));

  // Offscreen: clear a texture, copy it to a buffer, map it (what a pick read-back does).
  try {
    device.pushErrorScope("validation");
    const tex = device.createTexture({
      size: [4, 4],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const buf = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc
      .beginRenderPass({
        colorAttachments: [{ view: tex.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 1, g: 0, b: 0, a: 1 } }],
      })
      .end();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: 256 }, [4, 4]);
    device.queue.submit([enc.finish()]);
    await timed(buf.mapAsync(GPUMapMode.READ), 5000, "mapAsync");
    const px = Array.from(new Uint8Array(buf.getMappedRange(), 0, 4));
    buf.unmap();
    const err = await timed(device.popErrorScope(), 5000, "popErrorScope");
    r.offscreen = { ok: !err && !r.lost && px.join() === "255,0,0,255", px, error: err ? msg(err) : null };
  } catch (e) {
    r.offscreen = { ok: false, error: msg(e) };
  }
  if (!r.offscreen.ok) return r;

  // Canvas: configure with the preferred format, clear and present three frames.
  phase = "canvas";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    const ctx = canvas.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();
    device.pushErrorScope("validation");
    ctx.configure({ device, format, alphaMode: "opaque" });
    // Diagnostic only: does the last frame reach the canvas? Read in the frame's own task,
    // before it is presented (green = yes).
    const readPixel = () => {
      try {
        const c2 = document.createElement("canvas");
        c2.width = 1;
        c2.height = 1;
        const g = c2.getContext("2d");
        g.drawImage(canvas, 32, 32, 1, 1, 0, 0, 1, 1);
        return Array.from(g.getImageData(0, 0, 1, 1).data);
      } catch (e) {
        return msg(e);
      }
    };
    let pixel = null;
    for (let i = 0; i < 3; i++) {
      const enc = device.createCommandEncoder();
      enc
        .beginRenderPass({
          colorAttachments: [
            { view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 1, b: 0, a: 1 } },
          ],
        })
        .end();
      device.queue.submit([enc.finish()]);
      if (i === 2) pixel = readPixel();
      await frame();
    }
    let err = null;
    try {
      err = await timed(device.popErrorScope(), 5000, "popErrorScope");
    } catch (e) {
      err = e;
    }
    // The loss seen in CI arrives asynchronously after the canvas setup: give it time.
    await sleep(1000);
    r.canvas = { format, error: err ? msg(err) : null, pixel };
    r.canvas.ok = !err && !r.lost && !r.uncaptured.some((u) => u.phase === "canvas");
  } catch (e) {
    r.canvas = { ok: false, error: msg(e) };
  }
  return r;
}

async function probe(label, launchOptions) {
  const out = { label, args, chromium: null, result: null, error: null };
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args, ...launchOptions });
    out.chromium = browser.version();
    const page = await browser.newPage();
    await page.goto(base);
    out.result = await page.evaluate(probeInPage);
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 600);
  } finally {
    await browser?.close().catch(() => undefined);
  }
  const r = out.result;
  out.verdict = !r || !r.offscreen?.ok ? 1 : r.canvas?.ok ? 0 : 3;
  return out;
}

const verdictText = {
  0: "WebGPU works offscreen and on a canvas",
  3: "WebGPU works offscreen, but a plain WebGPU canvas loses the device or errors",
  1: "no working WebGPU device (or the probe failed)",
};

const results = [];
try {
  const gating = await probe(
    process.env.CHROMIUM_PATH ? "CHROMIUM_PATH" : 'Playwright channel "chromium" (as webgpu-errors.mjs)',
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" },
  );
  results.push(gating);
  if (!process.env.CHROMIUM_PATH) results.push({ ...(await probe("Playwright chrome-headless-shell (information only)", {})), informational: true });
} finally {
  server.close();
  writeFileSync(join(OUT, "webgpu-canvas-probe.json"), JSON.stringify(results, null, 2));
}

for (const p of results) {
  console.log(`\n# ${p.label}: Chromium ${p.chromium ?? "?"}`);
  console.log(`args ${JSON.stringify(p.args)}`);
  if (p.error) console.log(`error ${JSON.stringify(p.error)}`);
  if (p.result) {
    const { adapter, offscreen, canvas, lost, uncaptured } = p.result;
    console.log(`adapter ${JSON.stringify(adapter)}`);
    console.log(`offscreen ${JSON.stringify(offscreen)}`);
    console.log(`canvas ${JSON.stringify(canvas)}`);
    console.log(`device.lost ${JSON.stringify(lost)}`);
    if (uncaptured.length) console.log(`uncaptured errors ${JSON.stringify(uncaptured)}`);
  }
  console.log(`verdict ${p.verdict}: ${verdictText[p.verdict]}`);
}

const verdict = results[0].verdict;
if (verdict === 3 && process.env.GITHUB_ACTIONS) {
  const lost = results[0].result?.lost;
  const why = lost ? `device lost (${lost.reason}: ${lost.message})` : `error: ${results[0].result?.canvas?.error}`;
  console.log(`::warning title=No WebGPU canvas in this browser::A plain WebGPU canvas (no Forge code) fails here: ${why.replace(/[\r\n%]/g, " ")}`);
}
console.log(`\nRESULT webgpu-canvas-probe: ${verdict} (${verdictText[verdict]})`);
process.exitCode = verdict;
