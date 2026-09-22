# ADR 0000: Own the core; borrow only as oracles

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 P0

## Context

We are building an AI-native 3D CAD app. The user, who is the product owner, set the direction: build our own AI-native core rather than stack on decades-old engines, and use existing mature libraries only as reference oracles for testing.

The research ([RESEARCH.md](../RESEARCH.md)) supports this:

- **Mature engines carry decades of design debt.**
  - OCCT has global state, tolerance creep, no native provenance, a heavy WASM build, and weak fillets, shells and offsets.
  - Parasolid is robust but closed, with opaque pricing.
  - Neither can be retrofitted with the properties agents need: native persistent naming, explainable failures with feasible ranges, bit-identical determinism, in-kernel queries and differentiable evaluation.
- **Quality in an AI CAD product is decided in the core.** Agents succeed or fail on whether references survive edits, whether failures explain themselves, and whether results are reproducible. A wrapper around a legacy kernel inherits that kernel's limits.
- **Recent new kernels failed or stalled** (Fornjot, CADmium, truck, Zoo). The cause was the long tail of edge cases combined with no systematic verification.
- **Our moat is an AI-native core plus a verification machine.** The model providers are shared by everyone. A kernel designed for agents, and proven against an independent reference at scale, is not.

## Decision

**We own every component that decides quality, and design each one for AI:**
- the kernel, solvers, tessellation, renderer and regeneration;
- persistent naming, the DSL and checks;
- later, SubD, HLR, FEA and CAM.

**Mature open-source libraries run only in dev/CI, as reference oracles for differential testing.** They are never shipped.

| Oracle | Checks |
|---|---|
| OCCT (via OCP/build123d) | Kernel operations, STEP I/O, mass properties |
| PlaneGCS, SolveSpace | Sketch and assembly solving |
| OpenSubdiv | SubD evaluation |
| Manifold | Mesh booleans |
| CalculiX, Gmsh | FEA and meshing for simulation |

**We deliberately reuse existing technology where it doesn't define quality:**
- React, for the UI framework;
- Electron, for the app shell;
- Loro, for the CRDT;
- the LLMs;
- the *specs* of standard file formats. We write our own readers and writers.

Small generic crates and packages (serde, thiserror, smallvec, proptest, …) are also fine.

## Consequences

**Positive:**
- **Forge is designed for agents from the first line.** It has provenance naming, explainable operations, determinism, exact-first numerics, in-kernel queries and differentiability ([FORGE.md](../FORGE.md)).
- **We control the licensing.** There are no LGPL/GPL runtime dependencies, and we keep an OEM licensing option ([ADR 0001](0001-open-core-licensing.md)).
- **One engine runs everywhere:** desktop, web, iPad, CLI and cloud workers.
- **The oracles give us ground truth from the first commit.**

**Negative / costs:**
- **The public MVP moves about 3 months later** than an OCCT-based plan would.
- **We take on the long-tail risk that sank other kernels.** Mitigations:
  - verification before features;
  - exact predicates and certified intersection;
  - milestones ordered from analytic → B-spline → general NURBS;
  - release gates measured against OCCT.
- **We must build CAD-specific rendering, solving and I/O ourselves.**

**Follow-ups:**
- Agent, app and eval work proceeds in parallel against the `oracle/` backend, so it isn't blocked by Forge.
- CI enforces the boundaries: `cargo deny` and a JS licence check, and oracle libraries may appear only under `oracle/` and CI tooling.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Build on OCCT (like FreeCAD, build123d, CadQuery) | Its legacy design (global state, tolerance creep, no provenance, heavy WASM) caps what agents can do. It is also LGPL at runtime and weak at fillets, shells and offsets. |
| License Parasolid | Closed, with opaque pricing. We can't make it AI-native (provenance, determinism, differentiability). It conflicts with an open-core product and adds a licensing cost. |
| Adopt or fork a young open kernel (truck, Fornjot) | They lack fillet and shell or are archived. Their data models weren't designed for provenance or certification. We would inherit someone else's long-tail debt without a verification machine. |
| Mesh-based modeling (e.g. Manifold) | Not an exact B-rep. It is unsuitable for STEP, drawings, precise fillets and CAD-grade editing. |
| Cloud-hosted kernel (Zoo-style) | A server cost for every session and no offline use. It contradicts local-first ([ADR 0010](0010-local-first.md)). |
