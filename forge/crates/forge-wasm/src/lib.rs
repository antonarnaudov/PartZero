//! # forge-wasm — Forge for the web
//!
//! `wasm-bindgen` bindings consumed by `@aicad/forge-web` (packages/forge-web), which
//! wraps them in the typed, documented JS API (see its README). The raw exports are:
//!
//! - `evaluate(irJson, chordal?, angular?)` → `{ report, bodies, meshErrors, timings }`:
//!   forge-regen evaluation and `forge_mesh::tessellate_render` meshes as typed arrays;
//! - `exportMesh(irJson, format, chordal?, angular?, allowPartial?)` → `Uint8Array`
//!   (3MF / binary STL / OBJ via forge-io);
//! - `createViewport(canvas, backend, width, height, dpr)` → `RawViewport`: the
//!   forge-render viewport on an `HTMLCanvasElement` or `OffscreenCanvas`, on WebGPU or
//!   WebGL2 (`backend` = `"auto" | "webgpu" | "webgl2"`).
//!
//! The logic that does not touch JS lives in [`engine`] and [`scopes`] (the GPU error
//! scopes the viewport bindings wrap their work in) and is tested natively; the bindings
//! themselves (module `web`) only exist on `wasm32`.

pub mod engine;
pub mod scopes;

#[cfg(target_arch = "wasm32")]
mod web;
