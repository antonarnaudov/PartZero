// Error surfacing of Viewport.create in Node (audit V3/V4): no GPU here, so fake
// OffscreenCanvas and navigator.gpu objects drive the real WASM createViewport and the
// WebGPU device check. Run after `pnpm build` (uses dist/ and pkg/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { init } from "../dist/index.js";
import { Viewport, asForgeError, probeWebGpu } from "../dist/viewport.js";

const here = dirname(fileURLToPath(import.meta.url));
await init(readFileSync(join(here, "../pkg/forge_wasm_bg.wasm")));

/** An OffscreenCanvas whose every context request fails (no WebGL2, no WebGPU). */
class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.contexts = [];
  }
  getContext(type) {
    this.contexts.push(type);
    return null;
  }
}
globalThis.OffscreenCanvas = FakeOffscreenCanvas;

/**
 * A fake `navigator.gpu` implementing what the device check uses. `healthy`: buffers
 * behave (the read-back returns what was written); otherwise `mapAsync` rejects, like the
 * SwiftShader WebGPU adapter of the audit.
 */
function fakeGpu({ healthy }) {
  const calls = { requestAdapter: 0, destroyed: 0 };
  const buffer = ({ size, usage }) => {
    const bytes = new Uint8Array(size);
    return {
      bytes,
      usage,
      mapAsync: () => (healthy ? Promise.resolve() : Promise.reject(new Error("fake: mapping the buffer failed"))),
      getMappedRange: () => bytes.buffer,
      unmap() {},
      destroy() {},
    };
  };
  const device = {
    createBuffer: buffer,
    createCommandEncoder: () => {
      const ops = [];
      return {
        copyBufferToBuffer: (a, ao, b, bo, n) => ops.push(() => b.bytes.set(a.bytes.subarray(ao, ao + n), bo)),
        finish: () => ops,
      };
    },
    queue: {
      writeBuffer: (b, offset, data) => b.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset),
      submit: (cmds) => cmds.flat().forEach((op) => op()),
    },
    pushErrorScope() {},
    popErrorScope: async () => null,
    destroy() {
      calls.destroyed++;
    },
  };
  const gpu = {
    requestAdapter: async () => {
      calls.requestAdapter++;
      return { requestDevice: async () => device };
    },
  };
  return { gpu, calls };
}

function setGpu(gpu) {
  Object.defineProperty(globalThis.navigator, "gpu", { value: gpu, configurable: true });
}

afterEach(() => {
  delete globalThis.navigator.gpu;
});

const create = (canvas) => Viewport.create(canvas, { width: 64, height: 48, devicePixelRatio: 1 });

test("asForgeError keeps codes, names WASM traps and falls back otherwise", () => {
  const coded = Object.assign(new Error("no adapter"), { code: "RENDER_NO_ADAPTER" });
  assert.equal(asForgeError(coded, "RENDER_INIT"), coded);

  const trap = new WebAssembly.RuntimeError("unreachable");
  const t = asForgeError(trap, "RENDER_INIT");
  assert.equal(t.code, "FORGE_WASM_TRAP");
  assert.match(t.message, /trapped: unreachable/);
  assert.equal(t.cause, trap);

  const plain = new TypeError("boom");
  const p = asForgeError(plain, "RENDER_INIT");
  assert.equal(p.code, "RENDER_INIT");
  assert.equal(p.message, "boom");
  assert.equal(p.cause, plain);

  const s = asForgeError("just a string", "RENDER_FRAME");
  assert.equal(s.code, "RENDER_FRAME");
  assert.equal(s.message, "just a string");
});

test("without WebGPU and WebGL2, create rejects with RENDER_NO_ADAPTER naming each backend", async () => {
  assert.equal(globalThis.navigator.gpu, undefined);
  assert.equal(await probeWebGpu(), null, "no WebGPU: nothing to check");
  const canvas = new FakeOffscreenCanvas(64, 48);
  await assert.rejects(create(canvas), (e) => {
    assert.equal(e.code, "RENDER_NO_ADAPTER");
    assert.match(e.message, /webgpu: navigator\.gpu is not available/);
    assert.match(e.message, /webgl2: .*getContext/);
    return true;
  });
  assert.deepEqual(canvas.contexts, ["webgl2"]);
});

test("a healthy WebGPU device passes the check", async () => {
  const { gpu, calls } = fakeGpu({ healthy: true });
  setGpu(gpu);
  assert.equal(await probeWebGpu(), null);
  assert.equal(calls.requestAdapter, 1);
  assert.equal(calls.destroyed, 1, "the check's device is released");
  // Once per navigator.gpu.
  assert.equal(await probeWebGpu(), null);
  assert.equal(calls.requestAdapter, 1);
});

test("an unhealthy WebGPU device is reported, never gets the canvas, and its reason is kept", async () => {
  const { gpu, calls } = fakeGpu({ healthy: false });
  setGpu(gpu);
  const verdict = await probeWebGpu();
  assert.equal(verdict?.code, "RENDER_WEBGPU_UNHEALTHY");
  assert.match(verdict.message, /WebGPU device check failed: fake: mapping the buffer failed/);
  assert.equal(calls.destroyed, 1);

  const canvas = new FakeOffscreenCanvas(64, 48);
  await assert.rejects(create(canvas), (e) => {
    assert.equal(e.code, "RENDER_NO_ADAPTER");
    // The check's reason, then WebGL2 (tried first), then WebGPU (tried last, decided by
    // forge-wasm's own self-test of the device; it fails here: Node has no WebGPU for wgpu).
    assert.match(e.message, /^WebGPU device check failed: fake: mapping the buffer failed; webgl2: .+; webgpu: .+/s);
    assert.ok(e.message.indexOf("; webgl2: ") < e.message.indexOf("; webgpu: "));
    assert.equal(e.cause, verdict);
    return true;
  });
  // WebGL2 first; a failed WebGL2 request leaves the canvas free, and WebGPU never got a
  // context on it (its adapter request failed first).
  assert.deepEqual(canvas.contexts, ["webgl2"]);
});

test("an explicit backend skips the device check and reports only that backend", async () => {
  const { gpu, calls } = fakeGpu({ healthy: false });
  setGpu(gpu);
  const canvas = new FakeOffscreenCanvas(64, 48);
  await assert.rejects(Viewport.create(canvas, { width: 64, height: 48, devicePixelRatio: 1, backend: "webgl2" }), (e) => {
    assert.equal(e.code, "RENDER_NO_ADAPTER");
    assert.match(e.message, /^webgl2: /);
    assert.doesNotMatch(e.message, /webgpu/i);
    return true;
  });
  assert.equal(calls.requestAdapter, 0);
  assert.deepEqual(canvas.contexts, ["webgl2"]);
});

test("a non-canvas is RENDER_CANVAS and an unknown backend RENDER_BACKEND", async () => {
  await assert.rejects(create({ width: 1, height: 1 }), (e) => e.code === "RENDER_CANVAS");
  await assert.rejects(
    Viewport.create(new FakeOffscreenCanvas(8, 8), { width: 8, height: 8, backend: "vulkan" }),
    (e) => e.code === "RENDER_BACKEND",
  );
});

/**
 * A Viewport around a stand-in for the WASM RawViewport (the constructor is private in
 * TypeScript only): enough to check the wrapper's fault bookkeeping without a GPU.
 */
function wrap(rawViewport) {
  return new Viewport(rawViewport, new FakeOffscreenCanvas(8, 8), 8, 8, 1, false, null);
}

test("gpuFault() returns a fault the device recorded before any call reported it", () => {
  // Review of audit V4: a WebGPU error outside a scoped call (resize()'s texture
  // recreation, a lost device) sat in the device's record while gpuFault() said null.
  const fault = Object.assign(new Error("validation GPU error: texture recreation"), { code: "RENDER_GPU" });
  let recorded = null;
  const vp = wrap({ gpuFault: () => recorded, onGpuFault() {}, free() {} });
  const events = [];
  vp.on((e) => events.push(e));
  assert.equal(vp.gpuFault(), null, "healthy");
  assert.deepEqual(events, []);
  recorded = fault;
  assert.equal(vp.gpuFault(), fault);
  assert.deepEqual(events, [{ type: "error", error: fault }], "emitted once, when first seen");
  assert.equal(vp.gpuFault(), fault, "sticky");
  assert.equal(events.length, 1);
  vp.dispose();
  assert.equal(vp.gpuFault(), fault, "still reported after dispose, without touching the freed module");
});
