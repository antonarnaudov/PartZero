# Vision

> Product name: **PartZero**. "Forge" and "aicad" are internal codenames; see the [naming note](#naming-note).

## The product in one paragraph

We are building the first AI-native, cross-platform 3D CAD application. It offers Fusion-, SolidWorks- and Shapr3D-class parametric modeling and Blender-style freeform modeling at CAD precision. An in-app agent builds sketches, parts, assemblies and drawings through the app's own tools and gives professional engineering guidance. People can model everything by hand and edit anything the agent made. The app runs on **Forge**, our own geometry kernel. Forge is written in Rust, compiles to native code and WebAssembly, and is designed for agents from its first line.

## North star: Cursor for CAD, from intent to the machine

Cursor put agents inside the code editor: developers describe and review, and the agent writes. PartZero aims to do the same for 3D CAD.
- **You say what the part must do.** The agent drafts the sketches, features, dimensions and engineering numbers.
- **Forge checks every step.** Forge builds and checks every proposal before you can accept it.
- **Your hands and the agent share one model.** You shape the result by hand whenever you want. Your moves and the agent's land in one parametric model, one timeline and one undo stack.
- **It ends at the machine.** You export a file your printer, laser or CNC accepts, tuned to your machine, with the evidence attached. Today the chain ends at a checked handoff: a file plus its receipt. It reaches the machine's work origin only for CNC, once our own CAM ships in Phase 3 ([ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)).

**Built never to lie.** Every result is checked by the kernel, every number cites its source, and every case where we got it wrong is published in the failure zoo. This is a design rule we measure, not a fact yet. Today: 0 silent-wrong results on the named generator corpus (6,008 extrude and revolve programs). The Phase 0 audit found 2 outside it, now pinned by regression tests.

**How we measure it.** The north-star metric is the **no-heavy-lifting rate (NHL)**: the share of parts that reach a checked export with no manual sketch, feature or code edits. Its companion is **first-try physical success (FTPS)**: the share of parts that fit and work on the first attempt, measured in a Fit Lab of real prints. Neither is measured yet.

The promise per persona, the metrics and gates, the roadmap changes and the honest caveats are in [NORTH-STAR.md](NORTH-STAR.md), approved by the owner on 2026-09-24.

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
2. **The kernel is built for agents.** These are design goals; where one is not met yet, its milestone is named.
   - Persistent naming is built in.
   - Every failure explains itself with a structured error. Feasible parameter ranges arrive with F2.
   - Results are designed to be bit-identical on every platform. So far that is measured on macOS and Linux (amd64 emulated); wasm32 matches only locally and fails in CI, and Windows has not run yet.
   - Selectors are evaluated inside the kernel.
   - Evaluation will be differentiable (F4). Analytic sensitivities for a few parameters come first, by M10.

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
   - Agent work lands on a draft branch. By default you accept, reject or edit it per feature.
   - The autonomy dial ([ADR 0015](adr/0015-autonomy-dial.md)) lets you review each step instead, or let checked quick edits to the agent's own features apply without a click. Nothing is auto-applied to your features.
   - A whole agent task is one undo step, with a checkpoint before it lands.
   - Assumptions appear as editable chips.
7. **External agents are first-class.** Claude Code, Cursor and others get the same tools through MCP and the CLI.

## Principles

| Principle | In practice | Record |
|---|---|---|
| **Own the core; borrow only as oracles** | Every component that decides quality is ours, including the kernel, solvers, tessellation, renderer, naming, DSL and checks. Mature libraries (OCCT, PlaneGCS, SolveSpace, …) run only in CI as references for differential testing and are never shipped. | [ADR 0000](adr/0000-own-the-core.md) |
| **Verification first** | We build the verification machine before the features: oracle diffs, fuzzing, invariants, formal proofs and a failure zoo. Forge is designed to fail loudly and never return silently wrong geometry, and we report how often that holds on each named corpus. | [ADR 0003](adr/0003-forge-kernel-with-occt-oracle.md), [FORGE.md](FORGE.md) |
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
- **Not a slicer or machine sender.** We hand files to the user's own slicer, laser software, sender or fab service, and never bundle a slicer ([ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)).
- **Not in the first year:** PDM/PLM, CAM toolpaths (Phase 3, from M14), iPad and real-time collaboration (Phase 6+).

## Platforms and business model

- **Platforms:** desktop first (macOS, Windows, Linux), then web, then iPad.
- **Open-core business model:**
  - Forge and the app are MPL-2.0, with a contributor CLA.
  - CadScript, the file format, the SDK, the MCP schemas and skills are Apache-2.0.
  - Revenue comes from hosted AI, cloud sync and collaboration, cloud compute and pro content.
  - BYO-key AI use stays free.

  See [ADR 0001](adr/0001-open-core-licensing.md) and [LICENSING.md](../LICENSING.md).

## Naming note

**PartZero** (chosen 2026-09-24) is the product name.
- **Meaning.** In CNC machining, *part zero* is the work origin, the (0,0,0) every dimension and toolpath of a job is measured from. It also reads as "from zero to a real part", which is the product's promise.
- **How it was chosen.** A 90-name sweep: five naming angles, automated registry, domain and web-conflict screening, and three independent judges scoring against the owner's taste profile ("fresh, not heavy, like Fusion 360 / SolidWorks but with AI").

**What was checked, informally:**
- The name is free as a GitHub repository name, an npm package name and a crates.io crate name.
- `partzero.ai`, `getpartzero.com` and `partzero3d.com` looked unregistered.
- `partzero.com` is parked and may be purchasable. `.io`, `.app` and `.dev` are registered.
- A web search found no product or company named PartZero.

**Risks to resolve in the formal US and EU trademark search before launch:**
- **CADZero** (cadzero.dev) is an AI-native parametric CAD tool with the same "…Zero" pattern. The first word differs, but the category is the same.
- **PlayerZero** is an AI engineering platform with a similar pattern, in a different field.

**Names rejected along the way:**

| Name | Why it was rejected |
|---|---|
| Bozzetto | Owner's feedback: "annoying" |
| DemiCAD | Owner's feedback: too heavy |
| Arges, Hardforge, Vulkar, Ironhold | Owner's feedback: too heavy / mythic |
| SynthCAD, TensorForm, BrepMind, Kinemind | Owner's feedback: random, or too close to TensorFlow |
| CortexCAD, MindCAD | Existing AI-CAD products |
| Daedalus | An AI manufacturing company |
| Hephaestus | Hestus, an AI-CAD startup |
| Vitruvius | ICON's AI home-design tool |
| ProtoForge | An AI prototyping tool for makers |
| SparkForge | Several AI businesses |
| ArcForge | A CAD design service |
| ShapeFlow | A CAD viewer |
| AlloyCAD | Confusable with AllyCAD |
| Partwright, Kerf, Formwright, Maquette, Brokkr, Mechanist | Existing projects, crowded, or too close to competitors |

"Forge" and "aicad" remain internal codenames, pending the same review:
- "acad" was avoided because it is AutoCAD's executable name.
- "Forge" was Autodesk's former platform brand, so a review is required before public launch.

The master plan ([PLAN-2026-09-23.md](PLAN-2026-09-23.md)) still says `acad` for the CLI and `@acad/std` for the package scope. These docs use `aicad` and `@aicad/std`.
