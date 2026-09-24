# ADR 0000: Own the core; borrow only as oracles

- **Status:** Accepted. Amended by [ADR 0016](0016-manufacturing-output-own-vs-hand-off.md) (scope: manufacturing output; see the addendum below).
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
- CI enforces the boundaries: `cargo deny` and a JS licence check, and oracle libraries may appear only under `oracle/` and CI tooling (see the amendment below for `*/oracle/` directories).

## Amendment (2026-09-23): oracle directories next to the code they test

Some oracle harnesses belong next to the crate they check, for example `forge/crates/forge-solve/oracle/` (PlaneGCS, SolveSpace) and `forge/crates/forge-ssi/oracle/` (OCCT). Oracle libraries may therefore appear in **`oracle/` or any `*/oracle/` directory**, on these conditions:

- the directory is **CI and dev tooling only**: it is never a Cargo workspace member or a pnpm workspace package, and nothing that ships imports it;
- it is the repository's `oracle/`, a `<crate>/oracle/` right beside a crate's `Cargo.toml` (Cargo never compiles it), or another `*/oracle/` outside every pnpm workspace package and Rust crate. A directory named `oracle` *inside* a workspace package (e.g. `packages/x/src/oracle/`, which `files` or the bundler can ship) or inside a crate's sources (e.g. `src/oracle/`, which `mod oracle;` compiles) is not an oracle directory;
- it declares its own dependencies in its own manifest or script metadata (`package.json`, `pyproject.toml`, a PEP 723 `# /// script` block), never in a shipped package's manifest or lockfile;
- its files carry the MPL-2.0 licence of our oracle tooling ([LICENSING.md](../../LICENSING.md)).

CI checks this on every push: `scripts/license-check/oracle-boundary.mjs` fails when OCP, build123d, PlaneGCS, SolveSpace or an OCCT build for JavaScript is imported or declared outside an oracle directory, when a directory named `oracle` sits inside a workspace package or a crate's sources, when code outside an oracle directory reaches into one (a relative import, an import of a package the oracle directory defines, a `file:` link, a Cargo `path`, a Rust `#[path]` or `include!`), or when an oracle directory becomes a workspace member; `forge/deny.toml` bans crates that wrap another kernel or solver from the Forge dependency graph; `scripts/license-check/js-licenses.mjs` and `cargo deny` reject any LGPL/GPL dependency of a shipped package, and `js-licenses.mjs` also rejects an oracle library, or any package from an oracle directory, anywhere in a shipped package's dependency closure, whatever its license.

## Addendum (2026-09-24): manufacturing output, per ADR 0016

[ADR 0016](0016-manufacturing-output-own-vs-hand-off.md) draws the line at the machine. The text above stays as written; read it with these changes.

- **CAM is ours, and it comes earlier.** Our own 2.5D CAM for hobby routers (toolpaths, GRBL and LinuxCNC posts, stock-removal simulation, setup sheet) moves from Phase 6+ (FORGE.md F5) to Phase 3 (M14–M19). Turning and CAM beyond 2.5D stay Phase 6+. No G-code leaves the app without simulation and the user's acknowledgment.
- **What we own also includes** per-process checks before export, engineering calculations and the sourced handbook, machine profiles (with measured clearance and kerf) and export receipts.
- **Oracle table, new row:** Kiri:Moto (MIT) checks 2.5D CAM toolpaths, in CI only. Its licence would allow shipping it; this ADR keeps it an oracle.
- **Slicers are hand-offs, not dependencies.** Slicers, laser software, machine senders and fab services are tools the user already has, and they receive our files. We launch the slicer the user installed as a separate process and never bundle, link or embed one. Their output is advisory: never a PartZero check, never in a receipt.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Build on OCCT (like FreeCAD, build123d, CadQuery) | Its legacy design (global state, tolerance creep, no provenance, heavy WASM) caps what agents can do. It is also LGPL at runtime and weak at fillets, shells and offsets. |
| License Parasolid | Closed, with opaque pricing. We can't make it AI-native (provenance, determinism, differentiability). It conflicts with an open-core product and adds a licensing cost. |
| Adopt or fork a young open kernel (truck, Fornjot) | They lack fillet and shell or are archived. Their data models weren't designed for provenance or certification. We would inherit someone else's long-tail debt without a verification machine. |
| Mesh-based modeling (e.g. Manifold) | Not an exact B-rep. It is unsuitable for STEP, drawings, precise fillets and CAD-grade editing. |
| Cloud-hosted kernel (Zoo-style) | A server cost for every session and no offline use. It contradicts local-first ([ADR 0010](0010-local-first.md)). |
