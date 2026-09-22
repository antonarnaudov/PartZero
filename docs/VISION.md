# Vision

> Working title. "Forge" and "aicad" are codenames; see the [naming note](#naming-note).

## The product in one paragraph

We are building the first AI-native, cross-platform 3D CAD application. It offers Fusion-, SolidWorks- and Shapr3D-class parametric modeling and Blender-style freeform modeling at CAD precision. An in-app agent builds sketches, parts, assemblies and drawings through the app's own tools and gives professional engineering guidance. People can model everything by hand and edit anything the agent made. The app runs on **Forge**, our own geometry kernel. Forge is written in Rust, compiles to native code and WebAssembly, and is designed for agents from its first line.

## Why now

- **AI for CAD has converged on one method.** The approach that works is code-as-CAD on a real kernel inside a verify loop. Frontier models with a strong harness beat fine-tuned CAD models. See [RESEARCH.md](RESEARCH.md).
- **AI still fails where CAD is hard.** It struggles with 6-DoF placement, assemblies, and sweeps, lofts and shells. The fixes are structural: solvers, semantic references and verification. Bigger prompts won't close the gap.
- **Existing kernels were not built for agents.** OCCT carries global state, tolerance creep, no native provenance and a heavy WASM build. Parasolid is closed. Every recent new kernel stalled in the long tail of edge cases, and none of them had a verification machine. That leaves an opening for a modern, open, AI-native kernel.

## Who it is for

| Order | Users | What they need | Arrives in |
|---|---|---|---|
| 1 | **Makers, 3D printing and CNC hobbyists/prosumers** | Fast functional parts (brackets, enclosures, Gridfinity, mounts), print-aware checks, parametric remixing, STL/3MF/STEP | Phase 1: Maker MVP |
| 2 | **Professional engineers** | Assemblies with mates, drawings with auto-dimensioning, sheet metal, CNC checks, FEA, STEP fidelity | Phases 2–5 |
| 3 | **Product and industrial designers** | SubD freeform at CAD precision, organic → B-rep, surface analysis, and later iPad with Pencil | Phases 5–6+ |

**Why makers first:**
- They form a large online community that pro tools serve poorly.
- Most of their parts are analytic geometry, which Forge handles exactly first.
- Every print is a fast, physical feedback loop.
- They share parametric designs in public, which makes them the natural first audience.

Details are in [ROADMAP.md](ROADMAP.md).

## What "AI-native" means here

It does **not** mean a chatbot bolted onto a CAD app. Concretely:

1. **The agent uses the app like any other client.** One typed command API serves the UI, the in-app agent, CLI/CadScript and MCP. The agent has no special privileges.
2. **The kernel is built for agents.**
   - Persistent naming is built in.
   - Every failure explains itself and gives the feasible parameter range.
   - Results are bit-identical on every platform.
   - Selectors are evaluated inside the kernel.
   - Evaluation is differentiable.

   See [FORGE.md](FORGE.md).
3. **The output is real, editable CAD.** The agent writes CadScript, which compiles into a parametric feature timeline with sketches, constraints and parameters. It never produces a dead mesh.
4. **The LLM never places anything by coordinates.** Sketch constraint solvers, assembly mate solvers and semantic references do the placing.
5. **Verification is part of the loop.** Every step climbs a ladder of checks:
   - static checks;
   - kernel invariants;
   - frozen spec tests;
   - DFM checks;
   - a visual judge from a different model family.

   Failures return as structured repair hints.
6. **Humans stay in charge.**
   - Agent work lands on a draft branch as a per-feature diff that you accept, reject or edit.
   - A whole agent task is one undo step.
   - Assumptions appear as editable chips.
7. **External agents are first-class.** Claude Code, Cursor and others get the same tools through MCP and the CLI.

## Principles

| Principle | In practice | Record |
|---|---|---|
| **Own the core; borrow only as oracles** | Every component that decides quality is ours, including the kernel, solvers, tessellation, renderer, naming, DSL and checks. Mature libraries (OCCT, PlaneGCS, SolveSpace, …) run only in CI as references for differential testing and are never shipped. | [ADR 0000](adr/0000-own-the-core.md) |
| **Verification first** | We build the verification machine before the features: oracle diffs, fuzzing, invariants, formal proofs and a failure zoo. Forge fails loudly and never returns silently wrong geometry. | [ADR 0003](adr/0003-forge-kernel-with-occt-oracle.md), [FORGE.md](FORGE.md) |
| **Agent-first design** | One command API; a typed IR as the single source of truth; CadScript as the editable surface; native provenance naming and semantic queries; no coordinate placement by the LLM | [ADR 0004](adr/0004-feature-graph-ir.md), [0005](adr/0005-cadscript.md), [0006](adr/0006-native-persistent-naming.md) |
| **Model-agnostic AI** | Anthropic, OpenAI, Google and OpenAI-compatible open/local models are all first-class. Each model has its own profile, and an eval leaderboard decides routing. The judge comes from a different model family than the builder. | [ADR 0009](adr/0009-model-agnostic-llm-gateway.md) |
| **Local-first** | Forge runs on the device and works offline. Cloud workers run the *same* Forge for heavy jobs. Collaboration comes later through a CRDT. | [ADR 0010](adr/0010-local-first.md) |

## Non-goals

- **Not a text-to-mesh generator.** AI mesh generators such as TRELLIS.2 supply reference bodies only.
- **Not a wrapper around an existing kernel.** OCCT, Parasolid and similar kernels never ship in the product.
- **Not cloud-only.** Offline use works fully. The cloud is for heavy jobs, sync and collaboration.
- **Not tied to one AI vendor.** Routing is configuration, not code.
- **Not an animation, rigging or VFX tool.** Freeform modeling exists to produce manufacturable geometry at CAD precision.
- **No silent changes.** The agent never:
  - touches user-authored features without approval;
  - applies learned preferences silently;
  - applies GD&T automatically (it only suggests it).

  Safety-critical parts require an explicit acknowledgment.
- **No general plugin API early.** Phase 1 ships part-family skills only.
- **No LGPL/GPL runtime dependencies** in anything we ship.
- **Not in the first year:** PDM/PLM, CAM toolpaths, iPad and real-time collaboration (Phase 6+).

## Platforms and business model

- **Platforms:** desktop first (macOS, Windows, Linux), then web, then iPad.
- **Open-core business model:**
  - Forge and the app are MPL-2.0, with a contributor CLA.
  - CadScript, the file format, the SDK, the MCP schemas and skills are Apache-2.0.
  - Revenue comes from hosted AI, cloud sync and collaboration, cloud compute and pro content.
  - BYO-key AI use stays free.

  See [ADR 0001](adr/0001-open-core-licensing.md) and [LICENSING.md](../LICENSING.md).

## Naming note

"Forge" and "aicad" are working codenames pending a naming and trademark review:
- "acad" was avoided because it is AutoCAD's executable name.
- "Forge" was Autodesk's former platform brand, so a review is required before public launch.

The master plan ([PLAN-2026-09-23.md](PLAN-2026-09-23.md)) still says `acad` for the CLI and `@acad/std` for the package scope. These docs use `aicad` and `@aicad/std`.
