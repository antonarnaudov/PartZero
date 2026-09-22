# Roadmap

> **Current status:** Phase 0 started 2026-09-23 (M1 = Oct 2026).
>
> **What exists so far:**
> - the repo skeleton and CI;
> - `forge-ir`, with the IR v0 types, the JSON Schema and the normative [SPEC](../forge/crates/forge-ir/SPEC.md);
> - the first corpus programs.
>
> Spike reports go in [spikes/](spikes/README.md).

Source: [PLAN-2026-09-23.md](PLAN-2026-09-23.md), §8–§10.

## Ground rules

- **Exit gates decide when a phase ends, not dates.** The month ranges and calendar dates below are indicative.
- **Parallel agent workstreams** (Forge, app, agent, evals) run in separate worktrees.
- **Forge first costs about 3 months.** Building Forge first moves the public MVP about 3 months later than an OCCT-based plan would, in exchange for a kernel we own. Meanwhile, agent, app and eval work proceeds against the `oracle/` backend and the growing Forge.

## Overview

| Phase | Months | ≈ Calendar | Theme | Forge milestones |
|---|---|---|---|---|
| 0 | M1–M2 | Oct–Nov 2026 | Foundations and spikes | F0 |
| 1 | M2–M10 | Nov 2026 – Jul 2027 | Maker MVP on Forge | F1, F2 (the maker release gate) |
| 2 | M10–M15 | Jul – Dec 2027 | Assemblies + v1.0 | F3 begins |
| 3 | M14–M19 | Nov 2027 – Apr 2028 | Fabrication | F3 (HLR, sheet metal) |
| 4 | M17–M22 | Feb – Jul 2028 | Web + cloud | — |
| 5 | M20–M26 | May – Nov 2028 | Organic + simulation | F4, F5 (`forge-sim`) |
| 6+ | Later | — | Scan-to-CAD, CAM, iPad, collaboration, PLM | F5 |

Forge milestone scopes and gates are in [FORGE.md](FORGE.md#milestones).

---

## Phase 0: Foundations and spikes (M1–M2)

Every spike is go/no-go. The criteria and the report template are in [spikes/README.md](spikes/README.md).

| # | Spike | Pass criteria (summary) |
|---|---|---|
| 1 | Forge F0 core + oracle harness | Bit-identical on macOS, Windows, Linux and WASM; extrude/revolve match OCCT on 1k programs; napi and WASM builds work in the CLI and Electron |
| 2 | Native provenance naming harness | ≥97% correct on dimension/suppress edits; ≥90% on topology-changing edits; 100% of fallbacks flagged |
| 3 | SSI + boolean feasibility | ≥99% agreement with the oracle on 500 DeepCAD replays; 0 silent-wrong. Sets the pace for F1. |
| 4 | `forge-solve` sketch solver | ≤4 ms per drag frame (WASM) for 60–200 entities; DOF, redundancy and conflict sets match PlaneGCS/SolveSpace on 1k sketches |
| 5 | `forge-render` in Electron | Exact edges/silhouettes; pixel-exact ID picking; section view; WebGL2 fallback on Linux; dimension edit → 3D in ≤150 ms |
| 6 | CadScript ⇄ IR round-trip | Lossless on 50 models; UI edits keep comments and formatting |
| 7 | Agent vertical slice + bake-off | CadScript ≥ build123d's score minus 5 points; ≥50% hidden tests passing; median cost ≤$1 |
| 8 | Eval harness skeleton | Harness plus 60 MakerBench tasks |

**Out of scope:** anything shipped to users, and kernel work beyond F0 except the SSI/boolean feasibility spike.

**Deliverables:**
- ADRs ([adr/](adr/README.md));
- a decision memo;
- a landing page and waitlist;
- a public "building an AI-native kernel" dev log.

---

## Phase 1: Maker MVP on Forge (M2–M10)

**Milestones:**
- Closed alpha when the **F2 gate** passes (target ~M7).
- **Open-source public alpha ~M8.**
- Beta ~M10.

### In scope

| Area | Scope |
|---|---|
| Documents | Single-part documents with multiple bodies |
| Sketcher | Line, arc, circle, rectangle, slot, polygon, spline, constraints and dimensions |
| Features | Extrude, revolve, holes, fillet, chamfer, shell, draft, patterns, mirror, booleans, datums, text emboss |
| Parametrics | Parameters and equations, the timeline, a two-way code view |
| Import | STL and 3MF as reference meshes; STEP as a solid |
| Export | STL, 3MF and STEP |
| Printing | FDM checks, orientation suggestions, printer profiles |
| AI | <ul><li>The full agent loop with 25 skills and the standard-parts set.</li><li>Draft-branch diffs.</li><li>BYO keys for every provider at alpha; hosted credits at beta.</li></ul> |
| Integration and distribution | <ul><li>MCP server and CLI.</li><li>Signed macOS and Windows builds with auto-update; Linux AppImage beta.</li><li>A web preview build is optional and cheap, since Forge and the renderer are WASM-native.</li></ul> |

### Deferred

- Assemblies.
- Sweeps and lofts.
- Drawings.
- Sheet metal.
- Cloud (billing only).
- FEA and CAM.
- SubD.
- iPad.
- Fine-tuning.
- A plugin API (skills only).

### Exit gates

| Area | Gate |
|---|---|
| Accuracy | T1 ≥85% hidden-test pass@1; T2 ≥65%; T4 ≥80% |
| Robustness | Validity ≥98%; editability ≥90%; ≥99% of provenance names survive edits; 0 silent-wrong Forge results in the nightly differential suite |
| Speed and cost | Median T1 ≤$0.75 and ≤90 s |
| Adoption and quality | <ul><li>20 alpha makers each print ≥3 parts.</li><li>≥60% of proposals accepted with ≤2 manual edits.</li><li>≥99.5% crash-free sessions.</li><li>300 weekly active users.</li></ul> |

---

## Phase 2: Assemblies + v1.0 (M10–M15)

### In scope

| Area | Scope |
|---|---|
| Assembly modeling | Assemblies with ports; 6 mate types via `forge-solve`; a skeleton part; interference checks; motion scrubbing; BOM |
| AI | Product-structure decomposition, with a task per part and automatic mating of standard parts |
| Geometry | Sweeps, lofts and splines. F3 begins; these are exposed through skills first. |
| Output and publishing | Slicer handoff (Bambu, Orca, Prusa); publish pages with parameter sliders |
| Evaluation | CADGenBench |

### Deferred

These move to later phases:
- drawings and sheet metal (Phase 3);
- web and cloud accounts (Phase 4);
- SubD and FEA (Phase 5);
- CAM, iPad and real-time collaboration (Phase 6+).

### Exit gates

| Area | Gate |
|---|---|
| Assembly quality | <ul><li>T3 ≥60% intent-correct (baseline 30.6%).</li><li>0 coordinate placements, enforced by a linter.</li><li>≥95% of accepted assemblies interference-free.</li></ul> |
| Performance | A 50-part assembly regenerates in <3 s |
| Business | v1.0 shipped, 2k weekly active users, $5k MRR |

---

## Phase 3: Fabrication (M14–M19)

### In scope

| Area | Scope |
|---|---|
| Sheet metal | Flanges, bends, reliefs, K-factor, flat patterns → DXF |
| Laser | DXF/SVG export |
| Drawings | <ul><li>Forge HLR views.</li><li>**Auto-dimensioning driven by the design's parameters.**</li><li>Sections, detail views, title block.</li><li>GD&T is *suggested* from ports, never applied automatically.</li><li>A vision-model review pass.</li></ul> |
| CNC | 3-axis manufacturability checks |
| AI | The auto-constrain model |

### Deferred

These move to later phases:
- web and cloud (Phase 4);
- SubD and FEA (Phase 5);
- CAM toolpaths (Phase 6+).

### Exit gates

| Area | Gate |
|---|---|
| Drawings | Auto-drawings produced for 90% of MakerBench parts; average rating ≥4/5 on a 50-part sample |
| Sheet metal | Flat patterns within ±0.1 mm on 20 parts |
| Auto-constrain | ≥85% of sketches end up fully constrained |
| Business | 5 paying shops |

---

## Phase 4: Web + cloud (M17–M22)

### In scope

| Area | Scope |
|---|---|
| Web | A web build with OPFS storage |
| Accounts and sharing | Accounts and sync; share, fork and branch/merge via IR diffs; geometry-anchored comments |
| Cloud agent | Hosted long agent tasks |
| Community | <ul><li>Public customizer pages with real B-rep and STEP. This is the viral loop, competing with Thingiverse and MakerWorld customizers.</li><li>A community library of skills and parts.</li><li>TraceParts integration.</li></ul> |
| AI | The distilled critic |

### Deferred

These move to later phases:
- real-time collaboration through a Loro CRDT and a Rust relay (Phase 6+);
- SubD and FEA (Phase 5).

### Exit gates

| Area | Gate |
|---|---|
| Web parity | ≥90% of part-design features work in the browser; P95 load of a 30-feature part in <5 s |
| Business | 4k monthly active users, $15k MRR |
| Judge cost | Down 60%, with at most a 2-point quality loss |

---

## Phase 5: Organic + simulation (M20–M26)

### In scope

| Area | Scope |
|---|---|
| Freeform modeling | <ul><li>The SubD workspace on Forge F4: creases, symmetry, dimensionable cages.</li><li>SubD → B-rep, with CAD features applied afterwards.</li><li>SDF/implicit bodies (lattices, organic blends).</li></ul> |
| Optimization | Differentiable "optimize" tools |
| AI meshes | TRELLIS.2 used as a reference body |
| Simulation | `forge-sim` linear static FEA, validated against CalculiX, with loads on semantic faces. The advisor explains the margins. |

### Deferred

These move to Phase 6+:
- scan/mesh/photo → parametric;
- CAM toolpaths;
- iPad;
- GPU Forge compute.

### Exit gates

| Area | Gate |
|---|---|
| SubD → B-rep | ≥90% success on cages up to 2k faces |
| FEA | Within ±10% of the oracle on 15 cases |
| Advisor | Catches ≥80% of under-designed brackets |

---

## Phase 6+

In scope:
- **Scan, mesh or photo → parametric model**, through fine-tuning and RL with Forge gradients.
- **2.5D CAM and laser toolpaths.** They are our own, with Kiri:Moto as the oracle.
- **iPad:** a native Swift host with Forge FFI, `forge-render` on Metal via wgpu, and Pencil support.
- **Real-time collaboration** (Loro + a Rust relay).
- **PDM/PLM.**
- **GPU Forge compute.**
- **Forge OEM licensing.**

Exit gates are defined when each item is scheduled.

---

## Explicitly reused (not built)

- React
- Electron
- Loro
- The LLMs
- File-format *specs*

Everything that defines quality is ours ([ADR 0000](adr/0000-own-the-core.md)).

---

## Go-to-market

| When | What |
|---|---|
| M1 | Waitlist; build in public. **The "open AI-native kernel" story is a headline in itself**: a dev log with oracle-comparison dashboards, and agent videos. |
| M3–4 | An NLnet/NGI Zero grant (a strong fit for an open kernel); free browser mini-tools built on skills (Gridfinity, project boxes, Skadis) for SEO and the waitlist |
| M8 | Open-source launch: Show HN, r/3Dprinting, r/functionalprint, r/gridfinity, r/openscad, r/cad, r/rust. Discord and GitHub Sponsors. |
| M8–10 | Printables/MakerWorld showcases with parametric source; early access for maker YouTubers (Zack Freedman, CNC Kitchen, Maker's Muse, Teaching Tech) |
| M10 | Hosted credits plus a "Founding Supporter" plan (no lifetime AI credits) |
| M12–15 | Crowdfunding or pre-sales around v1.0, if the waitlist is ≥5k or WAU ≥1k. Target $30–60k. |
| M15+ | Fabrication partners (SendCutSend, OSHCut, JLC); Forge OEM licensing conversations |
| M17+ | Public customizer pages |

---

## Top risks

| Risk | Mitigation |
|---|---|
| **Forge's long tail** (the thing that sank Fornjot and slowed Zoo) | <ul><li>The verification machine comes first: large-scale oracle differential testing (DeepCAD, Fusion 360 Gallery, ABC, our corpus), fuzzing, invariants, and a failure zoo.</li><li>Exact predicates and certified intersection.</li><li>Explainable failures, never silent.</li><li>Milestones ordered from winnable cases outward (analytic → B-spline → general NURBS).</li><li>Release gates measured against OCCT.</li><li>Many agent workstreams in parallel.</li></ul> |
| MVP is later than the OCCT path (~+3 months) | Agent, app and eval work proceeds in parallel against the `oracle/` backend and the growing Forge. Public alpha is gated on F2, not on a date. |
| Topological naming instability | Native provenance plus queries and tags; a harness in Phase 0; never resolve silently; a repair UI |
| LLMs weaker at CadScript than build123d | Phase 0 bake-off; change the syntax, not the engine |
| Agent cost and latency | Tiered pipeline; deterministic checks before any LLM call; caching; economy mode; judge distillation |
| WASM memory limits (no Memory64 on iOS) | Native napi and FFI paths; data-oriented memory; iPad through the native Swift host |
| Scope creep | Phase exit gates, the list of explicitly reused components, skills instead of a plugin API |
| Provider drift | Per-model profiles plus a nightly cross-provider leaderboard; routing is config, not code |
