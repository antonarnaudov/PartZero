# ADR 0010: Local-first

- **Status:** Accepted. Amended by [ADR 0017](0017-opt-in-product-counts-and-failure-reports.md) (Consequences: data handling; see the addendum below).
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D10

## Context

- **Our first users expect offline tools.** Makers are used to local tools (slicers, OpenSCAD, FreeCAD) and expect to work offline and keep their files private.
- **Hosted kernels have structural costs.** A server-side kernel with a thin client (Onshape) or a cloud-only GPU kernel (Zoo) has a server cost for every session and no offline use.
- **Forge is designed to run everywhere.** It compiles to native code and WASM ([ADR 0002](0002-languages-by-purpose.md)).
- **Collaboration matters, but later.** Assemblies and cloud sharing arrive in Phases 2–4, and real-time collaboration in Phase 6+.

## Decision

**Forge runs on the device:**
- desktop: a native utility process (napi-rs);
- web: WASM in a worker;
- iPad: through the native Swift host with Forge FFI. The plan also lists WASM for iPad, but the iOS WASM memory limits (no Memory64) favour the native path.

**Headless cloud workers run the *same* Forge** for heavy jobs: long agent tasks and batch evaluation.

**Documents go through a `DocStore` interface:**
- backed by Immer now;
- backed by a Loro CRDT with a Rust relay later.

IR transactions ([ADR 0004](0004-feature-graph-ir.md)) are the unit of change in both.

## Consequences

**Positive:**
- **Offline, private and fast.** There is no network round trip for regeneration.
- **No per-session server cost.** This makes a free tier and BYO-key AI viable.
- **Identical results locally and in the cloud,** thanks to bit-identical determinism.

**Negative / costs:**
- **Client hardware limits heavy work.** Very large assemblies, FEA and batch agent evaluation route to cloud workers.
- **WASM memory limits apply on the web.** Data-oriented memory layouts and native paths mitigate them.
- **Sync, sharing and collaboration need a CRDT and relay.** Sharing, fork and branch/merge arrive in Phase 4; real-time collaboration in Phase 6+.
- **The data flywheel is opt-in only,** with separate switches.

## Addendum (2026-09-24): opt-in counts and failure reports, per ADR 0017

[ADR 0017](0017-opt-in-product-counts-and-failure-reports.md) amends the Consequences. The text above stays as written, and "The data flywheel is opt-in only, with separate switches" still holds.

- **Two new content-free streams:** usage counts and kernel failure signatures. Each has its own switch, off by default.
- **Minimized failure cases** are sent only when the user reviews one and presses Send, one case at a time.
- **Local-first is unchanged.** No feature depends on these streams, offline use works the same, and with both switches off the app makes no request to our ingest. Design content, including design context ([ADR 0018](0018-design-context-in-the-ir.md)), is never sent, except a minimized case the user reviewed and sent.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Server-side kernel with a thin client (Onshape-style) | Strong collaboration, but always online, with server cost per session and latency on every edit |
| Cloud-only GPU kernel (Zoo-style) | No offline use, and a server cost for every session |
| Local-first with a CRDT from day one | Premature. Immer behind the `DocStore` interface keeps the swap to Loro cheap when collaboration arrives. |
