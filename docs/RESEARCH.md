# Research summary

> **Caveats:**
> - Figures are as of **September 2026**.
> - Many of the AI-for-CAD papers cited here are **arXiv preprints** that have not been peer-reviewed.
> - Benchmark numbers are as reported by their authors. We have not reproduced them independently unless stated.
> - Re-check before quoting externally.

Source: [PLAN-2026-09-23.md](PLAN-2026-09-23.md) §1. The decisions this research drives are in [adr/](adr/README.md).

**Contents:**
1. [Geometry kernels](#1-geometry-kernels)
2. [AI for CAD: state of the art](#2-ai-for-cad-state-of-the-art)
3. [Proven reliability techniques](#3-proven-reliability-techniques)
4. [Platform precedents](#4-platform-precedents)
5. [Implications for this project](#5-implications-for-this-project)
6. [Key sources](#key-sources)

---

## 1. Geometry kernels

### Landscape

| Kernel | Licence | Used by | Assessment |
|---|---|---|---|
| **OCCT 8.0.1** | LGPL | FreeCAD, build123d/CadQuery, many others | The only free exact B-rep kernel. It carries decades of design choices: global state, tolerance creep, no native provenance, and a heavy WASM build. Its fillets, shells and offsets are weak. |
| **Parasolid** | Closed, opaque pricing | Onshape, Shapr3D, Plasticity | The gold standard for robustness. It is not open, and it cannot be changed to add AI-native properties. |

### Recent attempts at a new kernel

| Project | Status (Sept 2026) |
|---|---|
| Fornjot | Archived in June 2026 |
| CADmium | Archived |
| truck | No fillet or shell yet |
| Zoo | Years of funded work; still cloud-only and closed |

**The lesson.**
- The difficulty of a kernel sits in the **long tail of geometric edge cases**, not in the volume of code.
- None of these projects had a verification machine: large-scale differential testing against an independent reference, fuzzing, invariants and a regression zoo.
- That gap leaves an opening for a modern, open, AI-native kernel that builds the verification machine first ([FORGE.md](FORGE.md#verification-machine)).

### Related prior art

- **Persistent naming:**
  - FreeCAD's TNP algorithm (realthunder) retrofits naming onto OCCT.
  - Onshape tracks identity on top of Parasolid.

  Both show that naming is solvable but hard to bolt on afterwards. See [ADR 0006](adr/0006-native-persistent-naming.md).
- **Tolerances:** tolerant modeling (Jackson 1995) is the classic treatment of per-entity tolerances. It informs our explicit-tolerance policy.
- **Meshing:** Topology-First B-Rep Meshing (arXiv 2604.02141) is relevant to watertight tessellation.
- **Mesh and SubD libraries:** Manifold (mesh booleans) and OpenSubdiv (subdivision surfaces) are mature references. We use them as oracles, not as dependencies.
- **Sketch solvers:** PlaneGCS (FreeCAD's solver, packaged as `planegcs`), SolveSpace and Zoo's ezpz. PlaneGCS and SolveSpace are our CI oracles.

---

## 2. AI for CAD: state of the art

### Convergence

- **One method has won.** The field has converged on **code-as-CAD on a real kernel inside a verify loop**: the model writes a program, a real kernel evaluates it, and checks feed back into the next attempt.
- **Direct neural B-rep generation** is unshipped or low quality.
- **Frontier models with a strong harness beat fine-tuned CAD models.** On **CADGenBench**:
  - Claude Opus 5 with a build123d-MCP harness leads at **0.677**;
  - the harness alone adds **0.10**;
  - it lifts validity from **88% to 100%**.
- **Editing an existing model is easier than generating one.**

### Where AI still fails

| Task | Failure / success rate |
|---|---|
| Hardest text-to-CAD tier (Text2CAD-Bench L3) | ~70% doesn't even execute |
| Sweeps, lofts, shells | Fail 70–90% of the time |
| 6-DoF placement | Within 10 mm only 27.9% of the time |
| Assemblies | 30.6% match the intended design |

**Consequence:** the LLM should **never place anything by coordinates**.
- Constraint solvers handle sketches.
- Mate solvers handle assemblies.
- Semantic references identify faces and edges.

Phase 2's exit gate enforces this with a linter, requiring 0 coordinate placements.

### Products and integrations

- **Zoo Zookeeper:** an agent on Zoo's cloud kernel.
- **Onshape:** a FeatureScript MCP.
- **Autodesk:** a Fusion MCP.

The Onshape and Autodesk servers expose existing kernels and command sets to external agents. Zoo's agent runs on its own kernel, which is cloud-only and closed.

---

## 3. Proven reliability techniques

| Technique | Source | Measured effect | How we use it |
|---|---|---|---|
| Clarify before modeling | ProCAD | — | CLARIFY step: ≤1 round, ≤3 multiple-choice questions with defaults |
| Turn the spec into executable tests | CADTests | +10 points | SPEC step writes frozen CADTests. A fresh-context sub-agent writes them. |
| Exact kernel metrics plus a *different* model judging multi-view renders | CADSmith | Chamfer error 28.4 → 0.74 | L5 visual judge, from a different model family than the designer |
| Renders tagged with face/edge IDs | Vision2CAD | — | `render(overlay: face_ids/edge_ids)`; 6 ID-tagged views for the judge |
| Solver-status rewards | AutoConstrain | Fully constrained sketches 34% → 93% | `auto_constrain` tool; Phase 3 local auto-constrain model |
| Part-family skills | ArtisanCAD | — | `skills/`: 25 families in Phase 1 |
| Retrieve before generating | Leo AI | 60–80% of parts are duplicates | RETRIEVE step: library → skill → standard part → generate |

---

## 4. Platform precedents

| Product | Architecture | What we take from it |
|---|---|---|
| **Plasticity** | Electron + TypeScript + a native kernel addon, built by one developer | Electron with a native engine is viable for a demanding modeling app |
| **Figma** | A compiled engine in WASM rendering through WebGPU | A compiled engine in WASM can deliver desktop-class performance in a browser |
| **Zoo** | Cloud-only GPU kernel | A server cost for every session and no offline use. We avoid this ([ADR 0010](adr/0010-local-first.md)). |
| **Onshape** | Server-side kernel with a thin client | Strong collaboration, but always online. Our cloud workers run the same Forge as the client. |

---

## 5. Implications for this project

| Finding | Decision |
|---|---|
| Only one free exact kernel exists, and it carries legacy design; new kernels failed in the long tail | Build Forge, with the verification machine first and OCCT as an oracle only ([0000](adr/0000-own-the-core.md), [0003](adr/0003-forge-kernel-with-occt-oracle.md)) |
| Code-as-CAD on a real kernel in a verify loop wins | CadScript compiled to a typed IR, with a verification ladder ([0004](adr/0004-feature-graph-ir.md), [0005](adr/0005-cadscript.md)) |
| Placement and assemblies fail | Solvers and semantic references; no coordinates from the LLM ([0006](adr/0006-native-persistent-naming.md), [0008](adr/0008-own-solvers.md)) |
| Harness quality beats fine-tuning; a different-model judge helps | A model-agnostic gateway with per-model profiles and a cross-family judge ([0009](adr/0009-model-agnostic-llm-gateway.md)) |
| Cloud-only kernels carry per-session cost and no offline use | Local-first ([0010](adr/0010-local-first.md)) |
| Electron + native engine and WASM + WebGPU are proven | Electron shell, Rust engine to native and WASM, and a wgpu renderer ([0002](adr/0002-languages-by-purpose.md), [0007](adr/0007-own-renderer-wgpu.md)) |

---

## Key sources

### Kernels

- OCCT 8.0.0/8.0.1 releases (Open-Cascade-SAS/OCCT)
- Parasolid v39 (Siemens PLM Components blog)
- Fornjot (archived), CADmium (archived), truck (ricosjp/truck)
- Zoo CAD engine overview
- Manifold, OpenSubdiv
- FreeCAD TNP algorithm (realthunder)
- Onshape identity tracking
- Tolerant modeling (Jackson 1995)
- Topology-First B-Rep Meshing (arXiv 2604.02141)

### Solvers

- PlaneGCS (Salusoft89/planegcs)
- SolveSpace
- Zoo ezpz

### AI for CAD

| Category | Sources |
|---|---|
| Benchmarks | CADGenBench (huggingface/cadgenbench); Text2CAD-Bench (arXiv 2605.18430); OmniCAD (2608.22637); Hephaestus-CCX (2605.17448) |
| Agents and verification | CADSmith (2603.26512); CADTests (2605.07807); ProCAD; Vision2CAD (2609.22688); AssemCAD (2607.05123) |
| Training and generation | AutoConstrain (2504.13178); cadrille (2505.22914); CAD-Recode (2412.14042); ArtisanCAD (2607.05750); CADIR (2608.00891) |
| Datasets | DeepCAD; Fusion 360 Gallery; ABC. Check each licence before use and record it in `corpus/EXTERNAL_SOURCES.md`. |
| Products | Zoo Zookeeper; Onshape FeatureScript MCP; Autodesk Fusion MCP |

Numbers in parentheses are arXiv identifiers.

### Platform

- Plasticity
- Figma WebGPU
- Onshape architecture
- WebGPU status
- wgpu
- napi-rs
- Loro
- MCP 2026-07-28 spec
