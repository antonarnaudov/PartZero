# Spike 05: forge-render — our own wgpu CAD renderer on WebGPU, with a WebGL2 fallback

- **Owner / workstream:** renderer agent (engine side). The Electron + React shell is built in parallel in `packages/app` and `packages/desktop`.
- **Dates:** 2026-09-23 → 2026-09-23
- **Commit(s):** uncommitted working tree (this run did no git operations)
- **Verdict:** **GO**, on one condition: run the Linux WebGL2 check in CI (see [Follow-ups](#follow-ups))
- **Report name:** the spike table in [README.md](README.md) calls this report `05-render-electron.md`. This file was requested as `05-renderer.md`.

## Goal

Can our own renderer, `forge-render` (Rust on wgpu, compiled to WASM), cover the CAD-specific passes that generic engines lack, with the latency the AI-native edit loop needs, in a Chromium/Electron host? The decision under test is [ADR 0007](../adr/0007-own-renderer-wgpu.md).

The go/no-go criteria, copied from [README.md](README.md):

> - Exact edges and silhouettes.
> - Pixel-exact ID picking.
> - Section view.
> - WebGL2 fallback works on Linux.
> - A dimension edit shows up in 3D within ≤150 ms.

## Setup

### Code

| Path | What |
|---|---|
| `forge/crates/forge-render` (MPL-2.0) | <ul><li>`camera`: Z-up turntable; perspective with infinite far plane, or orthographic; reverse-Z; zoom to cursor, fit, standard views.</li><li>`scene`: packs bodies into GPU buffers, finds silhouette candidates, keeps provenance name tables.</li><li>`lines`: screen-space quad lines.</li><li>`pick`: id encoding and pick-window logic.</li><li>`viewport`: pipelines, frame, ID pass.</li><li>WGSL shaders in `src/shaders/`.</li></ul> |
| `forge/crates/forge-wasm` (MPL-2.0) | `wasm-bindgen` bindings: `evaluate`, `exportMesh`, `createViewport` → `RawViewport`. The logic that does not touch JS is in `engine.rs` and is tested natively. |
| `packages/forge-web` (MPL-2.0) | `@aicad/forge-web`, the typed API contract (see its [README](../../packages/forge-web/README.md)): `init`, `evaluate`, `exportMesh`, `Viewport`, the worker evaluator, the build script and the Vite demo. |
| `forge-mesh` (small additive change) | `RenderMesh` gained `edge_polylines`, filled from the same tessellation run as `tessellate`. A test asserts they are identical to `BodyMesh::edge_polylines`. |

### Dependencies

All permissive, all runtime Rust:
- `wgpu` 30.0.1 — the GPU abstraction the ADR allows;
- `glam` 0.33, `bytemuck` 1;
- `wasm-bindgen` 0.2.128, `js-sys`, `web-sys`, `wasm-bindgen-futures`;
- `console_error_panic_hook`.

All are MIT or Apache-2.0, some dual-licensed with Zlib. There is no three.js or Babylon, and no `unsafe` in our code (`unsafe_code = forbid` holds). Canvases become surfaces through wgpu's safe `SurfaceTarget::Canvas` and `SurfaceTarget::OffscreenCanvas`.

### Corpus

- `corpus/programs/*.json` (8 documents).
- All 44 `corpus/makerbench/*.cad.ts`, compiled with `@aicad/cadscript`.
- A synthetic **25-feature fixture** ([`packages/forge-web/demo/bench-doc.js`](../../packages/forge-web/demo/bench-doc.js)). IR v0 has no booleans, so the fixture is a multi-body part:
  - a rounded base plate with holes;
  - 4 standoffs and 2 gussets;
  - a revolved dome, a torus handle and a cone;
  - a slot extruded both ways;
  - a perforated plate.

  In total: 13 bodies, 78 faces, 133 edges and 6,350 triangles at the default tolerances. Every sketch sits at `z = thickness`, so editing that one dimension re-evaluates all 25 features.

### Hardware and hosts

- **Machine:** Apple M4 Pro, macOS 27.0.
- **Native:** wgpu on Metal.
- **Web:** Chromium 152, embedded in an Electron host (the Claude desktop app's browser pane), device-pixel ratio 2, canvas 1024×768 CSS = 2048×1536 px.
  - **WebGPU:** the adapter name is hidden by the browser.
  - **WebGL2:** forced with `backend: "webgl2"`; the adapter is "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro)".
- **MSAA:** ×4 on every backend.
- **Node:** 22.16 (V8) for the WASM bench.
- **Linux:** not available in this environment.

### Reproduce

```bash
cd forge
cargo test -p forge-render -p forge-wasm -p forge-mesh   # unit + native offscreen render tests
cargo clippy -p forge-render -p forge-wasm -p forge-mesh --all-targets -- -D warnings
cargo clippy -p forge-render -p forge-wasm --target wasm32-unknown-unknown -- -D warnings
cargo fmt -p forge-render -p forge-wasm -p forge-mesh --check

cargo install wasm-bindgen-cli --version 0.2.128 --locked   # once
pnpm --filter @aicad/forge-web build    # wasm (release, LTO) + wasm-bindgen + tsc
pnpm --filter @aicad/forge-web test     # Node smoke test
pnpm --filter @aicad/forge-web bench    # WASM evaluate + tessellate timings
pnpm --filter @aicad/forge-web dev      # demo: http://localhost:5178/?doc=bench_fixture_25&backend=webgl2
```

In the demo:
- **"Run 20 edits"** runs the dimension-edit benchmark.
- **`globalThis.forgeDemo`** exposes `runBench`, `measureFrames`, `selectDoc` and `setBackend` for automation.

## Rendering architecture

### One frame

1. **Parity-mask pass** (only when sectioning; see below).
2. **Main pass.** MSAA ×4, `Rgba8UnormSrgb` colour, reverse-Z `Depth32Float`. It draws, in order:
   - **Background gradient**, dithered.
   - **Faces.** Per-face vertices carry the exact B-rep normals. The look is a matte "PBR-lite": a hemispheric Z-up ambient, camera-relative key and fill lights, a soft Blinn-Phong highlight and a faint rim term.
   - **Ground grid** on XY in mm, with power-of-ten steps, red and green X/Y axes, and fading by distance and grazing angle.
   - **Silhouettes.**
   - **B-rep edges.**
   - **Axes gizmo** with stroke-letter labels, in a corner viewport.
3. **Resolve and blit** to the surface. The blit encodes sRGB in the shader when the canvas format is linear (WebGPU's `bgra8unorm`).

### Edges

- **Source.** Edges come from forge-mesh's edge polylines. These are the very vertices the adjacent faces share, so each line lies exactly on the face boundaries and within the chordal deflection of the exact curve.
- **Drawing.** Each segment is one instanced quad of constant screen-space width with a one-pixel anti-aliasing feather. Segments are clipped to the near plane in the vertex shader. Their ends are extended by half the width, so polyline joints overlap without gaps.
- **Depth.** Endpoints are moved towards the eye along the view ray by 1.5 px of depth. The line wins the depth test against its own faces without a polygon offset, and its screen position does not change.

### Silhouettes

- **Candidates.** Every interior mesh edge of a curved face is a candidate, packed with the normals of its two facets.
- **Selection.** Per frame, the vertex shader keeps only the edges where the facing flips (`(n_a·v)(n_b·v) ≤ 0`) and collapses the rest.
- **Result.** The exact contour of the tessellated surface. A loopless torus or sphere, which has no B-rep edges (ADR 0012), is still outlined.

### Picking

- **ID pass.** A pick renders face ids and edge ids into an `R32Uint` target. A second `R32Uint` target holds the depth bits.
- **Encoding.** `kind << 30 | index`: face, edge or section cap.
- **Scissor.** Both targets are scissored to a small window around the cursor.
- **Readback.** The window is copied to a mappable buffer and read back asynchronously. The web polls through `setTimeout`; native code blocks.
- **Choice.**
  - The pixel under the cursor is exact.
  - An edge pixel within the snapping radius wins (default 4 CSS px, 0 for pixel-exact); ties go to the smaller id.
  - The 3D point is unprojected from the depth bits.
- **Result.** Body, face and edge provenance names.

### Hover and selection

- **Storage.** Per-entity state lives in `R8Uint` textures read with `textureLoad` (WebGL2 has no storage buffers).
- **Look.** Faces are tinted; edges get thicker and change colour.
- **Surviving edits.** `set_bodies` re-resolves hover and selection **by provenance name**, so they survive re-evaluation.

### Section view

- **Clipping.** The fragment shader discards the removed half-space; clip distances are not portable.
- **Caps** are true caps without stencil, and assume closed bodies:
  1. **Parity mask.** An additive `Rgba8Unorm` pass counts, per pixel, the back and front faces that survive the clip, with no depth test. Back − front = 1 exactly when the ray's crossing with the plane lies inside material.
  2. **Front faces** are drawn clipped.
  3. **Back faces** carry the cap where the mask says "inside". They are shaded flat and hatched, and they write the depth of the plane crossing, so the cap occludes what lies behind it.
- **Cap picking.** The same steps run in the ID pass, so caps are pickable (`kind: "section"`).
- **The bug this replaced.** The first single-pass version wrote the plane depth before the depth test, and painted caps over faces where the ray crossed the plane in air. The native section test and the screenshot caught it. See the Findings.

### Portability rules

- Everything runs at WebGL2 limits: no storage buffers, no `base_vertex` (indices are rebased on the CPU), no base instance and no clip distances.
- Only one uniform struct (464 B) is used.
- Backend selection with `"auto"` requests a WebGPU adapter and device *before* touching the canvas, so a WebGPU failure leaves the canvas free for a WebGL2 context.

## Results

### Criteria

| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| Exact edges and silhouettes | B-rep edges and silhouettes drawn exactly | <ul><li>**Edges:** drawn from the tessellation's shared boundary vertices, which lie on the exact curves within 0.05 mm; forge-mesh tests assert render and body polylines are identical.</li><li>**Silhouettes:** the GPU-selected contour of the mesh, exact to the chordal tolerance; the loopless torus is outlined (screenshot).</li><li>**Native offscreen test:** asserts the edge pixel is dark over faces, and at least 150 silhouette pixels on a cylinder (measured 361).</li></ul> | **Yes**, exact to the tessellation tolerance; analytic silhouettes of quadrics are a later refinement |
| Pixel-exact ID picking | The id under the cursor is exact | <ul><li>**Native (Metal):** snapping radius 0, image centre, 6 standard views and orthographic → exactly `plate/cap:end`, `cap:start`, `side:bottom`, `side:right`, `side:top`, `side:left`. The 3D point is within 0.5 mm of the expected face point; the background gives `null`; the 4 px edge snap returns `plate/edge:{plate/cap:end\|plate/side:bottom}`.</li><li>**Browser, WebGPU and WebGL2:** picks return provenance names and exact points (e.g. `idler/side:top` at z = 9.00, `idler/side:flange1_top` at z = 1.00); click-select and hover work with real mouse events.</li></ul> | **Yes** |
| Section view | A clip plane with caps | <ul><li>**Native test:** cap picked as `kind: section` at the plane (\|x − 50\| < 0.2 mm), cap colour checked; without the section the same pixel hits the far side at x = 100.</li><li>**Browser (WebGL2):** the 25-feature fixture cut on Y shows hatched caps on the base plate and the perforated plate.</li></ul> | **Yes** |
| WebGL2 fallback works on Linux | Parity on Linux | <ul><li>Forced WebGL2 on **macOS Chromium 152 (ANGLE → Metal)**: full parity, including MSAA ×4, `R32Uint` id readback, section caps, hover and selection, and a 47.7 ms edit.</li><li>The GL path is compiled for `wasm32` in every build.</li><li>**Not run on Linux:** no Linux host here, and native GL cannot be forced on macOS without EGL.</li></ul> | **Partial**: the code path is proven; the Linux run is outstanding |
| A dimension edit visible within ≤150 ms | ≤150 ms, 25-feature part | Input → GPU finished the new frame, n = 20 (then ≤ 8.3 ms to the next 120 Hz vsync):<ul><li>**WebGPU, main thread (`loadIr`):** 46.9 ms median, 48.1 p95, 49.6 max.</li><li>**WebGPU, worker (`evaluate` → `setBodies`):** 54.4 ms median, 59.9 p95.</li><li>**WebGL2, main thread:** 47.7 ms median, 50.2 p95.</li></ul> | **Yes** (≈ 3× margin) |

### Measured numbers

**Evaluate + tessellate in WASM** (Node 22.16, 20 runs, median). The table covers all 44 MakerBench parts; programs are 1–8 ms.

| Document set | Triangles | Evaluate | Tessellate | Total (median / max) |
|---|---|---|---|---|
| corpus/programs (8) | 12 – 3,464 | 0.5 – 5.6 ms | 0.1 – 3.6 ms | 1.1 – 8.4 ms |
| MakerBench (44 parts) | 24 – 2,078 | — | — | **4.75 ms median, 12.27 ms max** (`t5-pcb-spacers`, 4 bodies) |
| 25-feature fixture (thickness 6, 6.5, 8) | 6,350 | 29.8 – 30.5 ms | 16.7 – 17.5 ms | **47.3 – 49.0 ms** median, 58 – 83 ms p95 |

- **Where the time goes.** "Evaluate" includes forge-check validation and the exact metrics report. For interactive edits the metrics could be deferred.
- **In the browser** (Chromium, main thread), `loadIr` on the fixture breaks down as:
  - evaluate 26 ms;
  - tessellate 14 ms;
  - GPU upload 1.1 ms;
  - frame encode 0.2 ms;
  - GPU fence 5 ms.

**Frame time.** 2048×1536 px, MSAA ×4, CPU encode + submit per frame. Throughput is from N back-to-back frames followed by a GPU fence.

| Scene | WebGPU CPU | WebGPU GPU throughput | WebGL2 GPU throughput |
|---|---|---|---|
| Fixture, 6,350 tris, 5,893 silhouette candidates | 0.05 ms (0.2 ms in the demo loop) | 0.57 ms/frame | 4.1 ms/frame on the first frames, which include lazy GL shader compiles; 0.4 ms CPU per frame when warm |
| Fixture at 0.005 mm, 48,832 tris, 61,598 candidates | 0.04 ms | 0.97 ms/frame | 1.79 ms/frame |
| Fixture at 0.001 mm, 216,792 tris, 299,293 candidates | 0.05 ms | 1.69 ms/frame | 2.44 ms/frame |

- **Interactive orbit** is vsync-bound on both backends: 8.3 ms intervals at 120 Hz.
- **Upload of very large meshes** is much slower on WebGL2: 350 ms at 217k triangles, against 40 ms on WebGPU. At the default tolerances it is 3.8 ms against 1.1 ms.

**Bundle size.** Release build, fat LTO, `panic=abort`, name section stripped, no `wasm-opt`:

| Artifact | Raw | gzip -9 |
|---|---|---|
| `forge_wasm_bg.wasm` | 3,915.6 KiB | **1,359.0 KiB** |
| `forge_wasm.js` (wasm-bindgen glue) | 124.1 KiB | 20.2 KiB |
| `dist/*.js` (typed wrapper, worker) | 23.7 KiB | 8.1 KiB |

- **Other builds measured:**
  - With the name section kept: 4,542.6 KiB raw / 1,526.6 KiB gzip.
  - With `opt-level = "s"`: 3.4 MB / 1.16 MB. It is not adopted, because evaluation speed matters more.
- **What dominates:** most of the module is wgpu-core plus naga, whose WGSL front end and GLSL back end are needed for WebGL2.
- **Download and compile happen once.** The main thread compiles the module once and hands the `WebAssembly.Module` to the evaluation worker (`createSharedEvaluator`).

### Verification summary

| Check | Result |
|---|---|
| `forge-render` unit tests | 33 pass: camera math (basis, standard views, reverse-Z, project/unproject, zoom-to-cursor invariance, pan, fit, orbit clamping, determinism), pick encoding and window selection, the shader-constant match, line-quad geometry, scene packing, uniform layout |
| `forge-render` native offscreen tests (Metal) | 4 pass: coverage, determinism (two frames byte-identical), shading order, edges, exact picks on 6 views, edge snap, selection tint, section cap, silhouettes, 4 more corpus parts |
| `forge-wasm` tests | 5 pass (evaluate, rejected documents, invalid parameters, 3 export formats, determinism) |
| `forge-mesh` tests | Still pass, plus the new render-vs-body polyline equality |
| Node smoke test of the built package | 7 pass: all corpus programs, result shapes, determinism, error reports, coded errors, export |
| Clippy `-D warnings` (native and wasm32), rustfmt | Clean |
| `pnpm --filter @aicad/forge-web build` | Passes |
| Demo production build | Passes |
| Browser, WebGPU and WebGL2 | Render, hover, click-select, drag orbit, wheel zoom-to-cursor, section, standard views, projection toggle and edit loop exercised with real input and scripted checks; no console errors |

**Screenshots** (native offscreen, Metal):
- [`05-renderer/box_selected.png`](05-renderer/box_selected.png): shading, edges and the selection tint.
- [`05-renderer/cylinder_iso.png`](05-renderer/cylinder_iso.png): silhouettes.
- [`05-renderer/plate_section_iso.png`](05-renderer/plate_section_iso.png): a section cap.
- [`05-renderer/revolve_torus.png`](05-renderer/revolve_torus.png): the edgeless torus outlined by its silhouette.

### Findings

- **Caught by the tests.** The single-pass section cap painted caps over faces in front of the plane crossing: the fragment depth is written before the depth test. The parity-mask design above fixes it, and the native test pins the cap depth to the plane.
- **Edgeless bodies are real.** A full torus has no edges (ADR 0012), so silhouettes are necessary, not optional.
- **A hidden browser pane throttles `requestAnimationFrame` to about 400 ms.** Latencies are therefore measured to a GPU fence, which here is a 1-px pick whose buffer map resolves after the frame; the time to the next vsync is added on top.
- **Throttling skews numbers.** One benchmark run taken while the pane had just been hidden showed about 300 ms edits: the evaluation itself took 219 ms, so the CPU was being throttled. Repeated runs were stable at about 47 ms. These numbers are from a visible or stably backgrounded pane.

## Verdict: GO

`forge-render` meets the spike-5 bar:
- exact B-rep edges and a silhouette pass that outlines even edgeless bodies;
- pixel-exact `R32Uint` picking with provenance names and 3D points;
- a capped section view;
- a 25-feature dimension edit visible in about 55 ms, against a 150 ms budget, on both WebGPU and WebGL2.

All of this is our code on wgpu, with no `unsafe`, in a Chromium/Electron host, and with the same renderer running headless natively for tests and agents.

The one gap is procedural: the WebGL2 fallback has not been run **on Linux**. The path is compiled in every build and works in Chromium's WebGL2 (ANGLE) with full parity, so the risk is low. The GO holds on the condition that a Linux CI job confirms it (see Follow-ups).

Confidence: high for the architecture and the latency budget; medium for bundle size, which is acceptable for a desktop app at 1.36 MB gzip and needs work for a fast first web load.

## Follow-ups

- [ ] **Linux WebGL2 CI job.** Headless Chromium (Mesa or SwiftShader) runs the demo with `?backend=webgl2`, then `forgeDemo.runBench()` and picks. Also run it in `packages/desktop` once the Electron shell lands.
- [ ] **Bundle size.**
  - Evaluate `wasm-opt -O3`/`-Oz` and `opt-level="s"` for the renderer crates only.
  - Consider a WebGPU-only build flag for hosts that never need GL.
  - Consider an eval-only module for workers.
- [ ] **Faster edits.**
  - Skip or defer the metrics in interactive edits (about 40% of the evaluation time).
  - Cache per feature in forge-regen.
  - Upload incrementally per body instead of rebuilding the whole scene.
- [ ] **Faster WebGL2 uploads.** Large uploads are about 9× slower than WebGPU's; try `queue.write_buffer` in chunks instead of `mapped_at_creation` on GL.
- [ ] **Analytic silhouettes** for cylinders, cones, spheres and tori, and stroking the section-cap outline.
- [ ] **More picking:** vertices and BVH snapping (ADR 0007); pick-through and filters.
- [ ] **More analysis views:** SSAO (skipped in the spike), zebra, curvature and draft (ADR 0007).
- [ ] **Docs to update:** the spike table in [README.md](README.md) (report file name), and the `forge-render`/`forge-wasm` rows in [FORGE.md](../FORGE.md#crate-map), which should become "Exists".
