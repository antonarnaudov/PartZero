# @aicad/forge-web

Forge for the web, in one WebAssembly module compiled from Rust (`forge/crates/forge-wasm`):

- **Engine.** `evaluate` runs the IR through forge-regen and tessellates every body with `forge_mesh::tessellate_render`. You get per-face meshes with exact normals, and face ranges and edge polylines named by provenance. `exportMesh` writes 3MF, STL or OBJ through forge-io.
- **Viewport.** `forge-render` is our own wgpu CAD renderer ([ADR 0007](../../docs/adr/0007-own-renderer-wgpu.md)). It runs on WebGPU and falls back to WebGL2. It draws shaded bodies, exact B-rep edges, silhouettes, and a section view with caps. It has GPU ID picking, hover and selection, a Z-up turntable camera, a grid and an axes gizmo.

License: MPL-2.0. The spike report is [docs/spikes/05-renderer.md](../../docs/spikes/05-renderer.md).

## Build

```bash
# once: the wasm-bindgen CLI must match the wasm-bindgen crate version exactly
cargo install wasm-bindgen-cli --version 0.2.128 --locked

pnpm --filter @aicad/forge-web build   # cargo (wasm32, release, LTO) → wasm-bindgen → pkg/, then tsc → dist/
pnpm --filter @aicad/forge-web test    # Node smoke test of the built package
pnpm --filter @aicad/forge-web bench   # evaluate + tessellate timings (corpus, MakerBench, 25-feature fixture)
pnpm --filter @aicad/forge-web dev     # demo on http://localhost:5178 (?backend=webgpu|webgl2&doc=<name>)
```

- `scripts/build.mjs` also accepts `--debug`, `--skip-if-present` and `--allow-stale`. The last one keeps the existing `pkg/` if cargo fails, for example while another crate in the workspace is half-edited.
- If `wasm-opt` is on the PATH, the build runs it. It is optional.
- `pkg/` and `dist/` are generated. They are not committed.

## Quick start

```ts
import { init, evaluate, createSharedEvaluator, Viewport } from "@aicad/forge-web";

await init();                                   // fetch + compile the .wasm once
const viewport = await Viewport.create(canvas);  // WebGPU if available, else WebGL2
viewport.attachControls();                       // orbit / pan / zoom / hover / click-select

// Evaluate on this thread…
viewport.setBodies(evaluate(irJson).bodies);
// …or in a worker (shares the compiled module; typed arrays are transferred, not copied)
const evaluator = await createSharedEvaluator();
viewport.setBodies((await evaluator.evaluate(irJson)).bodies);
// …or evaluate + upload in one call without copying meshes through JS (fastest edit loop)
viewport.loadIr(irJson);

const hit = await viewport.pick(event.offsetX, event.offsetY);
// { kind: "face", body: "part/plate", face: "plate/cap:end", point: [x, y, z], … }
viewport.setSelection(hit ? [hit] : []);
viewport.setSectionPlane({ origin: [0, 0, 4], normal: [0, 0, 1] }); // removes z > 4
```

## API (the contract)

All geometry is in **millimetres**, with **Z up**. All screen coordinates are **CSS pixels relative to the canvas**; the viewport applies the device-pixel ratio. The full types, with doc comments, are in [`src/types.ts`](src/types.ts).

### Module

| Export | Signature | Notes |
|---|---|---|
| `init` | `(input?: InitInput) => Promise<void>` | Idempotent. The default input is `pkg/forge_wasm_bg.wasm`, resolved via `import.meta.url`. You can pass a URL, bytes, a `Response` or a compiled `WebAssembly.Module`. |
| `evaluate` | `(ir: string \| object, options?: TessellationOptions) => EvaluateResult` | Synchronous. Options are `{ chordalDeflection = 0.05, angularDeflection = 0.35 }`. |
| `exportMesh` | `(ir, format: "3mf" \| "stl" \| "obj", options?: ExportOptions) => Uint8Array` | `stl` is binary. Takes `allowPartial` (default false). |
| `engineVersion` | `() => string` | `"forge 0.0.1"` |
| `createEvaluator` | `(options?) => Evaluator` | Starts a Web Worker (`dist/worker.js`) that runs `evaluate`. |
| `createSharedEvaluator` | `(options?) => Promise<Evaluator>` | Runs `init()` first, then hands the compiled module to the worker. |
| `wasmModule` | `() => WebAssembly.Module \| null` | The compiled module. Post it to your own workers. |
| `transferables` | `(result) => ArrayBuffer[]` | The buffers of an `EvaluateResult`, for `postMessage`. |
| `Viewport` | class | See below. |

`EvaluateResult`:

```ts
{
  report: EvalReport;            // aicad.metrics/0 (type from @aicad/ir-types)
  bodies: {
    name: string;                // "part/feature" or "part/feature#i"
    positions: Float32Array;     // xyz, split per face
    normals: Float32Array;       // exact outward normals
    indices: Uint32Array;        // CCW from outside
    faceRanges: { face: string; start: number; count: number }[]; // start/count in TRIANGLES
    edges: { edge: string; points: Float32Array }[];               // polylines (ring edges closed)
  }[];
  meshErrors: { body: string; code: string; message: string }[];
  timings: { parseMs; evaluateMs; tessellateMs; packMs?; uploadMs?; totalMs };
}
```

Two cases worth knowing:

- **A document that does not parse or validate does not throw.** You get a report with `status: "error"` and a document-level `error` (the same as `aicad eval`), and `bodies: []`.
- **Some bodies have no edges.** A full torus or sphere is a single loopless face ([ADR 0012](../../docs/adr/0012-no-seam-edges.md)), so its `edges` is empty. The silhouettes still outline it.

Engine errors are thrown as `Error` objects with a stable `code`, such as `MESH_INVALID_PARAMS`, `EXPORT_FORMAT`, `EXPORT_NO_BODIES`, `RENDER_NO_ADAPTER` or `RENDER_BODY`.

### `Viewport`

| Member | Notes |
|---|---|
| `static create(canvas: HTMLCanvasElement \| OffscreenCanvas, options?: ViewportOptions): Promise<Viewport>` | <ul><li>`backend: "auto" \| "webgpu" \| "webgl2"` (default `auto`).</li><li>`width`/`height`/`devicePixelRatio`: for an `OffscreenCanvas`, pass `width` and `height`.</li><li>`autoRender` (default true): renders on demand with requestAnimationFrame.</li><li>`autoResize` (default true): uses a ResizeObserver on an `HTMLCanvasElement`.</li><li>`wasm`, `display`.</li><li>**Controls are not attached by default.**</li></ul> |
| `setBodies(bodies: RenderBody[])` | Replaces the scene and keeps the camera. The first non-empty scene is framed. Optional `color: [r, g, b]` per body (sRGB, 0..1). |
| `loadIr(ir, options?) → LoadResult` | *Addition.* Evaluates, tessellates and uploads inside WASM, with no JS copies. |
| `pick(x, y) → Promise<PickResult \| null>` | <ul><li>The face under the pixel is pixel-exact.</li><li>An edge within `pickRadius` (default 4 CSS px) wins over it.</li><li>A section cap returns `kind: "section"`.</li><li>`null` means background.</li></ul> |
| `setHover(entity \| null)` | Hovered faces get a tint. Hovered edges get thicker and change colour. |
| `setSelection(entities) → number` | Returns how many of the entities resolved. See **Hover and selection** below. |
| `setSectionPlane({ origin, normal } \| null)` | The half-space the **normal points into** is removed. Closed bodies get hatched caps. |
| `fitView()`, `setView("iso" \| "top" \| "front" \| "right" \| "bottom" \| "back" \| "left")` | `front` looks along +Y; `right` looks along −X; `iso` looks from (+X, −Y, +Z). |
| `setProjection("perspective" \| "orthographic")`, `projection()` | Toggling keeps the scale at the orbit target. |
| `onPointerDown/Move/Up(e, controlsOptions?)`, `onWheel(e)` | For your own event wiring. They read `offsetX`/`offsetY`. |
| `attachControls(target?, { hover, select, leftDrag }) → detach` | <ul><li>Left-drag orbits; shift+left and middle drag pan; right-drag orbits.</li><li>The wheel zooms to the cursor. Pinch arrives as ctrl+wheel.</li><li>Hover highlights. Click selects; shift, ctrl or meta+click toggles.</li><li>Calling it again replaces the previous wiring.</li></ul> |
| `on(listener) → unsubscribe` | Events are `{ type: "hover", pick }`, `{ type: "select", selection, pick }` and `{ type: "frame", stats }`. |
| `selection()` | The selection made through `attachControls`. |
| `resize(width, height, dpr?)` | CSS px. The canvas size is set here. |
| `render()`, `requestRender()` | Renders synchronously, or on the next animation frame. |
| `stats() → ViewportStats` | Backend, adapter, scene counts, MSAA, draw calls and CPU frame time. |
| `cameraState()`, `setCameraState(partial)` | `{ target, distance, yaw, pitch, fovY, projection }` |
| `orbit(dx, dy)`, `pan(dx, dy)`, `zoomAt(x, y, factor)` | Programmatic camera control. |
| `setDisplayOptions({ edgeWidth, silhouetteWidth, pickRadius, grid, axes, edges, silhouettes, … })` | |
| `displayModes() → DisplayMode[]`, `setDisplayMode(mode) → boolean`, `setXrayOpacity(a) → boolean` | forge-render display modes: `shaded`, `shadedEdges`, `wireframe`, `hiddenLine`, `xray`. Feature-detected: `[]` / `false` when the WASM module was built without `forge-wasm/src/web/view_ext.rs`. |
| `backend() → "webgpu" \| "webgl2"` | |
| `dispose()` | Frees the GPU resources and listeners. |

`PickResult`:

```ts
{ kind: "face" | "edge" | "section"; body: string; bodyIndex: number;
  face: string | null; faceIndex: number | null; edge: string | null; edgeIndex: number | null;
  point: [number, number, number] | null; pixel: [number, number] }
```

**Hover and selection.** Both take a `PickResult` or just names, such as `{ body, face }` or `{ body, edge }`. They are resolved by provenance name, so a selection **survives re-evaluation**, for example after a dimension edit, as long as the entity still exists.

## Deviations from the originally agreed API

The names and shapes of the brief are all kept. Where the brief left things open, or where members were added, the choices are:

1. **Tessellation parameters.** `evaluate` takes them as an options object, `{ chordalDeflection, angularDeflection }`, rather than as positional numbers. The defaults are 0.05 mm and 0.35 rad. The `ir` argument may be a JSON string or an object.
2. **More fields in `EvaluateResult`.** Besides `report` and `bodies`, it has `meshErrors` and `timings`.
3. **Face range units.** `faceRanges[].start` and `count` are **triangle** offsets, not index-buffer offsets. To get the index range, multiply by 3.
4. **Pick results carry more.** `PickResult` includes `kind`, `bodyIndex`, `faceIndex`, `edgeIndex`, `point` and `pixel`, besides `body`, `face` and `edge`. For a section cap, `face` is the face behind the cut.
5. **Controls are opt-in.** `Viewport.create` does not attach them; call `attachControls()`, or forward events to `onPointerDown`, `onPointerMove`, `onPointerUp` and `onWheel`.
6. **More views.** `setView` also accepts `bottom`, `back` and `left`.
7. **Additions.**
   - Viewport: `loadIr`, `on`, `selection`, `stats`, `cameraState`/`setCameraState`, `setDisplayOptions`, `orbit`/`pan`/`zoomAt`, `requestRender` and `projection()`.
   - Module: `createSharedEvaluator`, `wasmModule`, `transferables` and `engineVersion`.
   - The package export `@aicad/forge-web/worker`.

## Bundlers and hosts

- **Vite.** Linked workspace packages are served as source, so the `new URL("…", import.meta.url)` references to the `.wasm` and the worker resolve on their own.
  - If the package is ever pre-bundled, add `optimizeDeps: { exclude: ["@aicad/forge-web"] }`.
  - Set `worker: { format: "es" }`.
- **Electron.**
  - From `http(s)://` or a custom protocol, nothing special is needed. Serve `.wasm` as `application/wasm` for streaming compilation.
  - From `file://`, `fetch` of the `.wasm` may be blocked. Read the bytes in the preload or main process and call `init(bytes)`.
- **Worker rendering.** An `OffscreenCanvas` works with `Viewport.create`: pass `width` and `height`. In the spike, rendering stays on the main thread; only evaluation runs in the worker.
- **One context per canvas.** A canvas keeps the first context type it gets. To switch backends at runtime, create a new canvas, as the demo does.
