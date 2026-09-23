//! # forge-render — Forge's own CAD renderer (wgpu)
//!
//! One renderer for every host ([ADR 0007](../../../../docs/adr/0007-own-renderer-wgpu.md)):
//! WebGPU in browsers and Electron, wgpu's GL backend as the **WebGL2** fallback, and native
//! Metal / Vulkan / DX12 for headless renders (tests, CLI, agents) and later iPad.
//!
//! ## What it draws
//! - **Bodies** from `forge_mesh::tessellate_render`: per-face vertices with the exact
//!   B-rep normals, a matte "PBR-lite" look (hemispheric ambient, camera-relative key
//!   and fill lights, soft specular, faint rim), a background gradient, a ground grid on
//!   XY (mm) with coloured X/Y axes, and an axes gizmo.
//! - **Exact B-rep edges** from the tessellation's edge polylines (the very vertices the
//!   faces share), as screen-space constant-width lines ([`lines`]): instanced quads,
//!   depth-tested with a view-ray bias so they sit on top of their faces.
//! - **Silhouettes** of curved faces: interior mesh edges whose two facets face opposite
//!   ways for the current view, selected per frame on the GPU.
//! - **Section view**: a clip plane with true caps — back faces seen through the cut are
//!   shaded flat (hatched) at the depth where the view ray meets the plane.
//! - **Hover / selection** highlights (face tint, thicker coloured edges), resolved by
//!   provenance name so they survive re-evaluation.
//!
//! ## Picking
//! Face and edge ids go into an `R32Uint` target ([`pick`] documents the encoding); a pick
//! reads back a small window, is pixel-exact under the cursor, snaps to edges within a
//! radius, and returns the body, the face/edge provenance name and the 3D point.
//!
//! ## Portability rules
//! Everything runs at WebGL2 limits: no storage buffers, no base vertex/instance, no clip
//! distances; per-entity state lives in `R8Uint` textures read with `textureLoad`. No
//! `unsafe`: canvases become surfaces through wgpu's safe `SurfaceTarget::Canvas` /
//! `OffscreenCanvas` (in `forge-wasm`).
//!
//! ## Determinism
//! Scene packing is deterministic (input order, sorted silhouette candidates); camera
//! math uses `forge_core::math`. Pixels are not claimed bit-identical across GPUs.

pub mod camera;
pub mod context;
pub mod lines;
pub mod pick;
pub mod scene;
pub mod viewport;

pub use camera::{Camera, CameraFrame, Projection, Sphere, StandardView};
#[cfg(not(target_arch = "wasm32"))]
pub use context::block_on;
pub use context::{BackendKind, GpuContext, RenderError};
pub use pick::PickKind;
pub use scene::{EntityRef, SceneBody, SceneData, SceneEdge, SceneError, SceneFace, SceneTables};
#[cfg(not(target_arch = "wasm32"))]
pub use viewport::read_buffer_blocking;
pub use viewport::{
    FrameStats, PickHit, PickRequest, RgbaImage, SectionPlane, ViewOptions, Viewport,
};

/// Re-exports of the wgpu and glam versions this crate is built on (hosts create
/// surfaces with wgpu and pass section planes as glam vectors).
pub use {glam, wgpu};
