# ADR 0007: Our own renderer on wgpu

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D7

## Context

- **CAD viewports need passes that generic engines don't provide:**
  - exact B-rep edges and silhouettes;
  - pixel-exact picking of faces, edges and vertices;
  - section caps;
  - surface-quality analysis (zebra, curvature, draft);
  - huge instanced assemblies.
- **Agents need offscreen renders with face/edge ID overlays.** These feed the `render` tool and the L5 visual judge.
- **We ship on four kinds of host:** Electron desktop, browser, iPad, and headless CLI/cloud workers.
- **Precedent:** Figma shows a compiled engine in WASM rendering through WebGPU. Plasticity shows Electron is viable for a demanding modeler.

## Decision

**We build `forge-render`, in Rust on wgpu:**
- WebGPU in Electron and browsers;
- wgpu's WebGL2 backend as a fallback;
- native wgpu (Metal) on iPad.

**Features:**
- exact B-rep edges and silhouettes;
- ID-buffer picking with BVH snapping;
- section caps;
- zebra, curvature and draft analysis;
- instancing and LOD for large assemblies;
- later, PBR and path tracing.

**The app shell is Electron + React.** Electron gives the same Chromium WebGPU on every desktop OS, and the same bundle becomes the web app.

## Consequences

**Positive:**
- **Zero-copy.** Forge's tessellation feeds the renderer with no copy, in the same language and memory model.
- **One renderer on every platform,** including offscreen rendering for evals and agents.
- **We own the CAD-specific passes and their performance.**

**Negative / costs:**
- **We build and maintain GPU code** that a scene-graph library would otherwise supply.
- **We depend on WebGPU availability.** The WebGL2 fallback must stay working, especially on Linux.
- **The desktop bundle is Chromium-sized, because of Electron.**

**Gate:** Phase 0 spike 5 requires:
- exact edges and silhouettes;
- pixel-exact ID picking;
- a section view;
- a working WebGL2 fallback on Linux;
- a dimension edit visible in 3D within ≤150 ms.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| three.js / Babylon.js | Generic JS scene graphs: meshes are copied across the WASM boundary, CAD passes are bolted on, and they don't serve the native iPad or headless hosts |
| Separate native renderers per platform (Metal, D3D12, Vulkan) | Several renderers to maintain, and no web path |
| Tauri or another system-webview shell | WebGPU support and behavior vary across system webviews (especially on Linux), and there's no single Chromium to test against |
| A game engine (Unity, Unreal, Godot) | Heavy, not CAD-oriented, awkward to embed alongside a React UI, and not designed for exact edges or ID picking |
