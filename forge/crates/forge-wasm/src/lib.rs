//! # forge-wasm — Forge for the web
//!
//! `wasm-bindgen` bindings consumed by `@aicad/forge-web` (packages/forge-web), which
//! wraps them in the typed, documented JS API (see its README). The raw exports are:
//!
//! - `evaluate(irJson, chordal?, angular?, reportVersion?)` → `{ report, bodies, meshErrors,
//!   timings }`: forge-regen evaluation and `forge_mesh::tessellate_render` meshes as typed
//!   arrays. `aicad.ir/0` documents get the `aicad.metrics/0` report and one body per feature
//!   body (or, with `reportVersion = "v1"`, are migrated and get the `aicad.metrics/1` report,
//!   SPEC-v1 §0.2 rule 4); `aicad.ir/1` documents the `aicad.metrics/1` report and the final
//!   bodies of each part;
//! - `migrate(irJson)` → `{ document, renames }` (SPEC-v1 §9.1), `params(irJson)` → the report's
//!   `params` block, `writeBack(irJson, sketches?)` → `{ document, written, skipped }`
//!   (`writeBackSolution`, §0.6): the command layer's engine entry points (W9); they throw a
//!   `code`d error with `errors` for a rejected document;
//! - the command layer's edits (W9, interface I7; module [`commands`]): `setParam(irJson, name,
//!   valueJson)`, `renameFeature(irJson, featureId, name)`, `upgradeFeature(irJson, featureId,
//!   to?)`, `captureRef(irJson, featureId, field)`, `acceptRefProposal(irJson, featureId,
//!   field)`, `acceptRefCandidate(irJson, featureId, field, memberKey, candidateKey,
//!   candidateIndex?)`, `renameCurve(irJson, sketchId, old, new)` → `{ document, changed,
//!   result }` (canonical `aicad.ir/1` text, verified by evaluation); they throw a `code`d error
//!   with `errors` (rejections) or `details` (`COMMAND_*` refusals);
//! - `report(irJson, reportVersion?)` → the report of `evaluate` without tessellation;
//! - `exportMesh(irJson, format, chordal?, angular?, allowPartial?)` → `Uint8Array`
//!   (3MF / binary STL / OBJ via forge-io);
//! - `createViewport(canvas, backend, width, height, dpr)` → `RawViewport` (its
//!   `loadIr(irJson, chordal?, angular?, reportVersion?)` evaluates and uploads): the
//!   forge-render viewport on an `HTMLCanvasElement` or `OffscreenCanvas`, on WebGPU or
//!   WebGL2 (`backend` = `"auto" | "webgpu" | "webgl2"`).
//!
//! The logic that does not touch JS lives in [`engine`] and [`scopes`] (the GPU error
//! scopes the viewport bindings wrap their work in) and is tested natively; the bindings
//! themselves (module `web`) only exist on `wasm32`.

pub mod commands;
pub mod engine;
pub mod scopes;

#[cfg(target_arch = "wasm32")]
mod web;
