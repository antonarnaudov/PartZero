# Architecture

- **Baseline:** accepted 2026-09-23.
- **Amended:** 2026-09-24, for the approved [NORTH-STAR.md](NORTH-STAR.md): §1 (ADR [0016](adr/0016-manufacturing-output-own-vs-hand-off.md): Kiri:Moto oracle, hand-off targets), §3, §6 and §7 (ADRs [0015](adr/0015-autonomy-dial.md), [0016](adr/0016-manufacturing-output-own-vs-hand-off.md), [0018](adr/0018-design-context-in-the-ir.md)), §8 (ADRs [0017](adr/0017-opt-in-product-counts-and-failure-reports.md), [0020](adr/0020-funded-eval-keys-fallback.md); north-star metrics, public benchmarks) and §10 (verification machine at scale).
- **Source:** [PLAN-2026-09-23.md](PLAN-2026-09-23.md), §2–§7.
- **Related docs:**
  - [FORGE.md](FORGE.md) covers the kernel internals.
  - [adr/](adr/README.md) records each decision.
  - [forge-ir SPEC](../forge/crates/forge-ir/SPEC.md) gives the normative IR v0 semantics.

**Contents**
1. [Strategic decisions](#1-strategic-decisions)
2. [System overview](#2-system-overview)
3. [Feature-Graph IR](#3-feature-graph-ir)
4. [CadScript](#4-cadscript)
5. [Monorepo](#5-monorepo)
6. [AI agent system](#6-ai-agent-system)
7. [AI + manual co-editing UX](#7-ai--manual-co-editing-ux)
8. [Evaluation harness and data flywheel](#8-evaluation-harness-and-data-flywheel)
9. [External MCP server and CLI](#9-external-mcp-server-and-cli)
10. [Verification at a glance](#10-verification-at-a-glance)

---

## 1. Strategic decisions

**P0: Own the core; borrow only as oracles.** Everything that decides quality is ours and designed for AI:
- kernel, solvers, tessellation and renderer;
- regeneration, naming, DSL and checks, including per-process manufacturability checks, engineering calculations, machine profiles and export receipts ([ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md));
- later, SubD, HLR, FEA and CAM (our own 2.5D CAM in Phase 3, ADR 0016).

Mature open-source libraries (OCCT, PlaneGCS, SolveSpace, OpenSubdiv, Manifold, CalculiX, Gmsh, and Kiri:Moto for 2.5D CAM toolpaths) run only in dev/CI as **reference oracles for differential testing**. They are never shipped.

**Reused, not built:** React (UI), Electron (shell), Loro (CRDT), the LLMs, and the *specs* of standard file formats. We write our own readers and writers.

**Handed off, not shipped:** the user's installed slicers, laser software and machine senders, and fab services receive our files. We launch the slicer the user installed and never bundle, link or embed one. Their output is advisory: never a PartZero check, never in a receipt ([ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)).

| # | Decision | Summary | ADR |
|---|---|---|---|
| P0 | Own the core | See above | [0000](adr/0000-own-the-core.md) |
| D1 | Open-core licensing | <ul><li>Forge and the app: MPL-2.0 + CLA.</li><li>CadScript, format, SDK, MCP schemas and skills: Apache-2.0.</li><li>Paid: hosted AI, cloud sync/collaboration, cloud compute, pro content.</li><li>No LGPL/GPL runtime deps.</li></ul> | [0001](adr/0001-open-core-licensing.md) |
| D2 | Languages by purpose | <ul><li>Rust: the whole engine.</li><li>TypeScript: UI, DocStore, CadScript compiler, agent, gateway, MCP.</li><li>Python: ML, datasets, oracle.</li><li>Swift: iPad host, later.</li></ul> | [0002](adr/0002-languages-by-purpose.md) |
| D3 | Forge from day one; OCCT as a CI oracle | <ul><li>Forge ships native and WASM.</li><li>Release gates require Forge to match or beat the oracle on our robustness corpora.</li></ul> | [0003](adr/0003-forge-kernel-with-occt-oracle.md) |
| D4 | Typed Feature-Graph IR as the source of truth | <ul><li>Ordered timeline per Part Studio, derived dependency graph, unit-aware expressions.</li><li>Rust types → JSON Schema → TS/zod.</li></ul> | [0004](adr/0004-feature-graph-ir.md) |
| D5 | CadScript | <ul><li>A statically compiled TS subset, parsed into the IR and never executed.</li><li>A canonical printer round-trips it.</li></ul> | [0005](adr/0005-cadscript.md) |
| D6 | Native persistent naming | <ul><li>Every entity carries provenance.</li><li>Semantic queries and tags sit on top.</li><li>The fingerprint fallback always warns.</li></ul> | [0006](adr/0006-native-persistent-naming.md) |
| D7 | Own renderer on wgpu | <ul><li>`forge-render`: WebGPU with a WebGL2 fallback, and native wgpu on iPad.</li><li>The shell is Electron + React.</li></ul> | [0007](adr/0007-own-renderer-wgpu.md) |
| D8 | Own solvers | <ul><li>`forge-solve`: sketch (DR-planning + Newton/LM + SVD) and assembly solvers.</li><li>Both explain DOF and conflicts.</li></ul> | [0008](adr/0008-own-solvers.md) |
| D9 | Model-agnostic LLM gateway | <ul><li>Official SDKs, with a profile per model.</li><li>CLI agents (Claude Code, Gemini CLI, Codex CLI, opencode, Cursor Agent) and local models (Ollama) are first-class providers, so API keys are optional.</li><li>The leaderboard routes each role.</li><li>The judge comes from a different family than the builder.</li></ul> | [0009](adr/0009-model-agnostic-llm-gateway.md), [0014](adr/0014-cli-agents-as-providers.md) |
| D10 | Local-first | <ul><li>Forge runs on the device; cloud workers run the same Forge.</li><li>DocStore uses Immer now and a Loro CRDT later.</li></ul> | [0010](adr/0010-local-first.md) |
| D11 | Native freeform | SubD, mesh and SDF bodies live alongside B-rep in one convergent kernel. | [0011](adr/0011-native-freeform.md) |
| — | No seam edges | <ul><li>Periodic surfaces are handled natively in the parameter domain.</li><li>Ring edges are allowed.</li><li>Apexes and poles are surface singularities.</li></ul> | [0012](adr/0012-no-seam-edges.md) |

---

## 2. System overview

```
┌──────────────────────── Electron (desktop) / Browser (web) ────────────────────────────────┐
│ UI (React): viewport · timeline · sketcher · params · code view (Monaco+CadScript) · chat  │
│ forge-render (Rust→WASM, WebGPU; WebGL2 fallback) on canvas   DocStore (IR txns → Loro)     │
│ forge-solve (WASM) for 60 fps interactive sketch drag                                      │
│     │ IR snapshot ▼                          ▲ meshes, provenance names, diagnostics         │
│ Forge engine: native via napi-rs in an Electron utility process (multithreaded)             │
│              | WASM in a worker on web | native in CLI & cloud workers                      │
│   forge-regen (IR eval, expressions, queries, cache) → forge-ops/ssi/core → forge-mesh      │
│   forge-check (validity, DFM, mass, distance, interference) · forge-io (STEP/3MF/STL/…)     │
│ Agent runtime (utility process): orchestrator · LLM gateway · tool registry                 │
│ MCP server (localhost): same tool registry, for Claude Code / Cursor / other agents          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
 CLI `aicad` (native Forge): headless regen / export / render / eval, the harness for coding agents & CI
 oracle/ (Python + OCP/build123d, CI only): evaluates the same IR with OCCT for differential testing
```

### Where Forge runs

| Host | Forge | Renderer | Agent runtime |
|---|---|---|---|
| Desktop (Electron) | Native via napi-rs in a utility process (multithreaded) | `forge-render` (WASM) on canvas, WebGPU with a WebGL2 fallback | Utility process |
| Web | WASM in a worker | Same | Browser worker or server |
| iPad (Phase 6+) | Native Swift host with Forge FFI (avoids iOS WASM memory limits) | `forge-render` on Metal via wgpu | — |
| CLI, CI, cloud workers | Native | Offscreen | Headless Node |

`forge-solve` also runs as WASM next to the UI so sketch dragging stays at 60 fps.

### One command API, four clients

- The UI, the in-app agent, CLI/CadScript and the MCP server all call **the same typed command layer**.
- The same schemas generate both the agent tool definitions and the MCP tools.
- The agent has no special privileges.

### Life of an edit

1. **A client issues a domain op** (`setParam`, `addFeature`, …) inside a transaction. The client can be the UI, the agent, code or MCP.
2. **DocStore applies it** to the IR and records the inverse for undo.
3. **Forge regenerates** the new IR snapshot. `forge-regen` reuses cached results up to the first changed feature.
4. **Forge returns** meshes, provenance names and structured diagnostics.
5. **The results are consumed:**
   - `forge-render` draws the meshes;
   - the UI and agent read the names and diagnostics.

---

## 3. Feature-Graph IR

The IR is the single source of truth ([ADR 0004](adr/0004-feature-graph-ir.md)).
- **Where it is defined.** Rust types in `forge-ir` (serde + schemars) generate the JSON Schema. The schema then generates the TS types and zod schemas.
- **What is normative.** IR v0 semantics (`aicad.ir/0`, metrics `aicad.metrics/0`) are defined in [SPEC.md](../forge/crates/forge-ir/SPEC.md).
- **Scope of v0:** sketch, extrude and revolve.

### Document and features

- `Document { schema, units, params, parts, assemblies, blobs }`. IR v1.1, after Phase C, adds an optional, geometry-free `context` to `Document` and to each Part Studio ([ADR 0018](adr/0018-design-context-in-the-ir.md); see [Project memory](#scaling-to-machinery)).
- `Feature { id (uuidv7), name (= CadScript const), type, v (pinned behavior version), suppressed?, note?, expect? (verify clause), author, intent?, assumptions?, decision_ids?, …fields }`

| Feature types | |
|---|---|
| **v1** | sketch, extrude, revolve, hole (simple, counterbore, countersink, cosmetic-threaded, heat-set insert), fillet, chamfer, shell, draft, pattern (linear, circular, mirror), boolean, datums, mate connector, tag, import, text emboss |
| **Later** | sweep, loft, thicken, sheet metal, subd, mesh, sdf, custom |

### References

A reference is stored in the file as `Ref { kind, sel: QueryAST, card, fp? }`. Forge's native provenance resolves it in this order:

1. exact provenance;
2. fingerprint, for splits;
3. query filters;
4. geometric match, which warns and gives a confidence and candidates;
5. error.

A failed feature passes its input through, so a single regeneration shows every error. See [ADR 0006](adr/0006-native-persistent-naming.md).

### Expressions

- They use our own grammar with dimensional analysis, evaluated in Rust.
- Results are deterministic on every target.
- Units are always explicit in the IR.

### Edits

- Edits are domain ops (`addFeature`, `setField`, `setParam`, `moveFeature`, `setRef`, …).
- Ops are grouped into transactions with inverses, which gives undo/redo.
- An agent turn is one labelled group ("Revert turn").
- A code edit compiles, is structurally diffed against the IR by feature name, then applied as granular ops.

### File format

- **Native file:** a zip containing:
  - `manifest.json`;
  - a canonical `document.json`;
  - `blobs/`;
  - `cache/`, holding Forge-native B-rep, meshes and a thumbnail, keyed by the Forge build.
- **Git- and agent-friendly export:** a plain `.json`.

### Caching

- Keys are chained per feature: `k_i = H(k_{i-1}, type, v, evaluated fields, resolved refs, forgeBuild)`.
- Body states sit in an in-memory LRU, backed by a persistent B-rep and mesh cache.

---

## 4. CadScript

CadScript is a statically compiled TypeScript subset ([ADR 0005](adr/0005-cadscript.md)):
- It is parsed into the IR and never executed.
- It round-trips through a canonical printer.
- `tsc` and the compiler's diagnostics are the first verifier.
- Loops are allowed only inside a sandboxed `customFeature` (QuickJS-WASM).

A maker part:

```ts
import { param, sketch, rect, circle, extrude, hole, grid, fillet, shell, edgesBetween, XY, Z } from "@aicad/std";
const width = param(80), depth = param(50), thick = param(8);
const screw = param(5.5, { note: "M5 clearance" });
const base   = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: depth }) });
const plate  = extrude(base, { distance: thick });
const bossSk = sketch(plate.cap("end"), { ring: circle({ center: [0, 0], d: 22 }) });
const boss   = extrude(bossSk, { distance: 12, op: "join" });
const mounts = hole(plate.cap("end"), { at: grid({ nx: 2, ny: 2, dx: width - 12, dy: depth - 12 }),
                                        d: screw, depth: "through", counterbore: { d: 10, depth: 3 } });
const corners  = fillet(plate.sides().edges().parallel(Z), { r: 4 });
const bossRoot = fillet(edgesBetween(boss.sides(), plate.cap("end")), { r: 2 });
const hollow = shell(plate, { open: [plate.cap("start")], thickness: 2, expect: { solids: 1, minWall: 1.9 } });
```

Diagnostics come from Forge's explainable operations:

```
error FILLET_FAILED "corners": 1/4 edges failed: max feasible r = 3.41 (adjacent face width 6.82); hint: reduce r or move 'corners' before 'mounts'
```

---

## 5. Monorepo

| Path | Contents | Tooling |
|---|---|---|
| `forge/` | Cargo workspace: `forge-core`, `forge-ir`, `forge-ssi`, `forge-ops`, `forge-mesh`, `forge-solve`, `forge-regen`, `forge-check`, `forge-io`, `forge-render`, `forge-cli` (the `aicad` binary), `forge-napi`, `forge-wasm`, `forge-ffi`. See [FORGE.md](FORGE.md#crate-map). | Rust stable, clippy, proptest, cargo-fuzz, cargo deny |
| `packages/` | **Data and language:** `ir-types` (generated), `commands`, `cadscript` (`.d.ts` std lib, TS-AST → IR compiler, printer, source maps) | pnpm + Turborepo, strict TS, Vitest |
| | **Engine hosting:** `engine-host` (napi/WASM loading, workers, cancellation) | |
| | **Agent:** `agent-tools` (registry and operation playbooks), `llm-gateway`, `agent`, `mcp-server` | |
| | **Quality:** `evals`, `corpus` | |
| | **Content:** `std-parts` | |
| | **App:** `app` (React), `desktop` (Electron, served with COOP/COEP headers) | Playwright-Electron |
| `skills/` | Part-family skills | TS + Markdown |
| `oracle/` | OCCT/build123d IR evaluator and differential runner. **CI only.** | Python, uv |
| `corpus/` | IR test programs and golden metrics | JSON |
| `ml/` | Datasets, fine-tuning, RL | Python, uv |
| `docs/` | Vision, architecture, roadmap, ADRs, spike reports | Markdown |

---

## 6. AI agent system

### Roles

The eval harness chooses a model for each role, per provider profile ([ADR 0009](adr/0009-model-agnostic-llm-gateway.md)). The defaults below are as of Sept 2026.

| Role | Capability needed | Anthropic default | Other providers |
|---|---|---|---|
| Triage / utility | Small, fast | Haiku 4.5 | GPT/Gemini small tiers, local |
| **Designer** (main loop: clarify, plan, build, repair) | Frontier agentic | Opus 5.5 (medium effort; high for planning and repair) | GPT-5.x / Gemini 3.x flagships, ranked by MakerBench |
| Spec + test writer | Frontier; a fresh-context sub-agent that **never sees the builder's transcript** | Opus 5.5 (high) | Same |
| Critic / judge | Top vision model, **from a different model family than the designer** | Fable 5.1 (Opus 5.5 for zero-data-retention tiers) | Swap families across providers |
| Engineer advisor | Frontier, with the calculation tools | Opus 5.5 | Same |
| Economy main loop | Mid tier | Sonnet 5 | Mid tiers |

**Main-loop rules:**
- **One model per task,** because caches are per model. Cheaper models run only as sub-agents.
- **Append-only history.**
- **Tool use:** `tool_choice: auto` with strict schemas, because some models reject forced tool use.
- **Refusals** are handled explicitly.

### Orchestrator

It is our own TypeScript state machine on top of the gateway, not the Claude Agent SDK. The same code runs in:
- the Electron utility process;
- headless Node (evals, CLI);
- a browser worker;
- the server.

The Agent SDK is still used in the "external agent" eval track, where it drives our MCP server.

**CLI agents as providers** ([ADR 0014](adr/0014-cli-agents-as-providers.md), [CLI-PROVIDERS.md](CLI-PROVIDERS.md)):
- In **completion mode**, a CLI is a model endpoint of the gateway (triage, CLARIFY, judge).
- In **agent-runtime mode**, the CLI's own loop drives SPEC, BUILD and ASK. It sees only our CAD tools, through `packages/mcp-server`, and every call runs through this state machine's tool execution, so the ladder, stop rules and PROPOSE gate still apply.
- The phases stay ours in both modes. What follows a passing PROPOSE gate is set by the autonomy dial and decided by our orchestrator and the host's commit check, never by the CLI. A CLI's own permission or approval mode never counts as the user's approval ([ADR 0015](adr/0015-autonomy-dial.md)).

### Loop

```
TRIAGE ─┬─ ASK/EXPLAIN (read-only) ──────────────────────────────────────────► DONE
        ├─ QUICK_EDIT: plan-lite → BUILD → VERIFY L0–L3 → PROPOSE
        │              → by the autonomy dial: per-feature accept/reject, or auto-commit (ADR 0015)
        │              → CHECKPOINT → COMMIT + decision log with an approval record
        └─ DESIGN: CLARIFY (≤1 round, ≤3 multiple-choice Qs with defaults)
                 → SPEC (DesignSpec + CADTests, FROZEN) → RETRIEVE (library → skill → std part → generate)
                 → PLAN (feature plan, or product-structure tree for assemblies)
                 → per step: ACT (1–3 features) → REGEN → L0–L2 [→ step accept/reject at Ask at each step]
                             ; fail → REPAIR ×2 → ROLLBACK+REPLAN ×1 → ASK_USER
                 → MILESTONE: L3 tests → L4 DFM/eng → L5 judge ; fail → REFINE ×2 → PROPOSE with known issues
                 → PROPOSE (draft-branch diff) → per-feature accept/reject, or the accepted steps
                   at Ask at each step (ADR 0015)
                 → CHECKPOINT → COMMIT + decision log with an approval record
Every transition: budget and interrupt checks. A user edit in the agent's scope pauses it, and it rebases.
```

Tests are frozen. The builder can only *propose* a test change.

The dial never changes the ladder, the stop rules or the budget.

### Autonomy dial

[ADR 0015](adr/0015-autonomy-dial.md) sets how agent work lands. It ships at Phase 1 beta; checkpoints ship at Phase 1 alpha.

| Setting | What happens |
|---|---|
| Ask at each step | The agent stops after every plan step, and you accept or reject that step |
| **Propose per feature** (default) | The agent builds the whole task on its draft branch, then you accept or reject each feature |
| Auto-apply checked quick edits | A checked QUICK_EDIT lands without a click when it changes at most 3 features (provisional), all agent-authored, touches no existing parameter, and changes nothing a user-authored feature depends on. You then get Undo, Review and Keep. Everything else is proposed per feature. ADR 0015 §5 lists every condition |

- **Only the user sets it,** per project, in app settings (not the IR). No agent tool, MCP scope, skill, file or CLI flag can set or raise it. The app may *offer* a higher setting after a clean record; it never raises it by itself.
- **Authorship.** A feature counts as agent-authored until you accept it or edit it. The host's command layer alone writes the feature's existing `author` field; agent ops that set it are refused.
- **Nothing is auto-applied to your features.** Every commit of agent work carries an approval record. A commit check in the command layer refuses any change to a user-authored feature or parameter without a matching approval, with the code `unapproved_user_change`.
- **Surfaces.** Checks, Tab and ⌘K always propose. Background work always lands on its own branch. External agents never auto-apply and always land on their `mcp/<client>` branch (§9).

### Context

| Item | Policy |
|---|---|
| Prefix | Stable and sorted: tools, role prompt, a ~6k-token DSL reference, project conventions. A cache breakpoint follows. |
| Rare tools | Deferred behind tool search |
| Mutation results | Short deltas. The IR summary (≤4k tokens) is sent only at step boundaries. |
| Assemblies | Only the part in focus is expanded. Other parts appear as ~100-token cards (ports, envelope, mass). |
| Selection | Described semantically, with an image crop when needed |
| Images | At most 4 kept live |
| Task size | About 40 turns or 150k tokens. Longer work is split along the product-structure tree and handed off through memory files. |

### Tools

Every tool result:
- is ≤~2k tokens;
- names entities by ID and tag;
- returns **actionable errors from operation playbooks**, built on Forge's explainable diagnostics.

| Group | Tools |
|---|---|
| **Control** | `ask_user`, `report_progress`, `propose`, `load_skill`, `search_tools` |
| **Editing** (agent-branch transactions) | `apply_dsl`, `sketch_edit` (returns solver status, DOF and conflicts), `auto_constrain`, `set_param`, `edit_feature`, `tag`, `suppress`/`delete`/`reorder` (need approval on user features), `instantiate_skill`, `insert_standard_part`, `define_part`/`define_port`/`mate` (Phase 2), `checkpoint`/`rollback` |
| **Inspection** | `ir_summary`, `get_code`, `get_selection`, `query` (checks uniqueness), `describe`, `measure`, `mass_props`, `bbox`, `section`, `min_wall`, `clearance`, `interference`, `diff` |
| **Rendering** | `render(views, overlay: face_ids/edge_ids, highlight, section)`, `render_diff`, `render_sketch` (colored by DOF) |
| **Verification** | `run_tests` (reports margins), `validate`, `dfm(process, profile)`, `request_review`, `propose_test_change` |
| **Knowledge** | `search_parts` (text and shape embeddings), `search_standard_parts`, `search_skills`, `reference(topic)` (curated, cited engineering handbook), `memory_read`, `log_decision` |
| **Engineering calcs** (deterministic; each returns formula, inputs and source) | `fit` (ISO 286), `fastener`, `print_clearance`, `beam_plate`, `snap_fit`, `gear`, `bearing_select`, `material`; later `optimize` (Forge gradients) and `fea_run` (as an MCP Task) |
| **Manufacturing** | `export` (needs approval), `print_orientation`, `slicer_handoff` (launches the slicer the user installed, never a bundled one; [ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md) §3); later `drawing`, `bom`; CAM tools when Phase 3 starts |

### Verification ladder

Checks run cheapest first. A level runs only if the level below it passes.

| Level | Checks |
|---|---|
| L0 static | Types, schema, units, parameter ranges, selector cardinality |
| L1 kernel | Regeneration succeeds, Forge invariants, closed solids, body count, sketch DOF |
| L2 per-op | `expect` clauses and skill rules |
| L3 CADTests | Spec tests, regression tests, tag survival, and an **editability probe** (vary parameters ±20%) |
| L4 | DFM and engineering checks |
| L5 visual judge | 6 ID-tagged views plus the spec and metrics (~$0.14) |
| L6 | Human reviews the diff |

### Ask and stop rules

**Ask before modeling** only when both of these are true:
- the ambiguity changes topology or interfaces, the units are unclear, or requirements conflict;
- there is no safe default.

Otherwise, each assumption becomes an editable **parameter chip**.

**Stop when:**
- 2 repairs plus 1 replan have failed;
- the same error repeats;
- 80% of the budget is spent (show a summary and ask "continue for ~$X?");
- the tests pass but the judge disagrees;
- the next step would touch user-authored features or anything outside the selection;
- the part is safety-critical (warn and require acknowledgment);
- a policy refusal happens (never retry around it).

### Cost targets

These use the Anthropic default profile. Output tokens dominate the cost.

| Tier | Median | Cap |
|---|---|---|
| Q&A | $0.03 | $0.15 |
| Quick edit | $0.15 | $0.50 |
| T1 part | $0.75 | $1.50 |
| T2 part | $2.50 | $6 |
| T3 assembly | $10 | $20, with approval gates |

- Economy mode costs about 45% less.
- Single-turn eval and judge calls use batch APIs.

### Scaling to machinery

**Product-structure tree first.** Each node records:
- function and process;
- envelope and mass target;
- **typed ports:** bolt pattern, shaft/bore, planar mount, rail, gear mesh, PCB footprint.

Rules:
- **Ports are IR objects.** Mates connect ports, and the solver places the parts.
- **A skeleton part** owns every dimension that crosses parts. Parts may reference only skeleton parameters and ports.
- **Each part is its own task,** with its own spec and tests.
- **Build order:** skeleton → interfaces → standard parts → custom parts → integration tests (interference, clearance, DOF/motion, BOM, mass).

**Part-family skills** live in `skills/<family>/`:
- **Files:** `SKILL.md`, `params.ts`, `template.cad.ts`, `verify.ts` and `examples/`.
- **Output:** a skill expands into ordinary features the user can edit.
- **Community:** the community contributes skills, and CI tests each one.
- **Phase 1 set:** 25 families.
  - brackets, gussets, hole-pattern plates, standoffs
  - PCB enclosures (screw, snap and slide lids), clips, knobs
  - print-in-place hinges, snap fits, living hinges
  - Gridfinity bins and baseplates, Skadis hooks, wall mounts
  - NEMA17 mounts, 2020-extrusion brackets, GT2 pulleys, spur gears, couplers, pillow blocks
  - threaded caps, handles, drawers

**Standard parts** are TypeScript/Rust generators, and each one has ports:
- screws (ISO 4762, 7380, 10642), nuts (ISO 4032), washers, heat-set inserts;
- threads (cosmetic or modeled);
- bearings (608, 6xx, LM8UU);
- NEMA 14/17 motors, 2020/2040 extrusion profiles, servos;
- Raspberry Pi, Arduino and ESP32 mounting patterns;
- TraceParts, later.

**Project memory** is git-friendly:
- **design context in the IR** ([ADR 0018](adr/0018-design-context-in-the-ir.md), IR v1.1, after Phase C): an optional `context` block on the document and each Part Studio holds material, process, a machine-profile snapshot, requirements (with IDs), loads, decisions and assumptions. It replaces the planned `design/spec.md` and `design/decisions.jsonl`; a Markdown spec becomes a generated view, never a second source;
- `design/tests/*.test.ts`;
- `project.conventions.md`.

Design context rules:
- **Geometry-free.** Nothing reads it during evaluation, and removing it leaves the metrics report bit-identical. The oracle loads it and ignores it.
- **The agent writes it like features.** The SPEC step writes requirements, loads and assumptions; `log_decision` writes decisions. The frozen CADTests stay test files. Context edits are domain ops on the draft branch and follow the autonomy dial; the agent never silently changes user-authored context.
- **Checks read it with no LLM call.** Per-process checks, calculation tools and load badges read it, and each requirement gets a computed status: met, unmet, can't verify (with the reason) or not checkable. Results go in a separate check report, and the export receipt copies them.
- **It is design content.** It stays in the user's file, and every free-text field is untrusted when shown to a model.

Features carry `intent`, `assumptions` and `decision_ids`. Hovering over a value like "why 3.6 mm?" shows decision D-017; from IR v1.1, `decision_ids` resolve to the context's decisions.

---

## 7. AI + manual co-editing UX

| Element | Behavior |
|---|---|
| Selection-aware chat | `@` mentions and a selection chip. "Make this thicker" resolves to the parameter that drives it. |
| Draft branch and diff | <ul><li>A ghost overlay in the viewport and badges in the timeline.</li><li>Accept, Reject or Edit each feature (default) or each step (Ask at each step); rejecting is dependency-aware.</li><li>A qualifying quick edit to agent-authored features may auto-apply with a notice (Undo, Review, Keep) and an "agent" badge ([ADR 0015](adr/0015-autonomy-dial.md)).</li><li>The CadScript diff is shown alongside.</li><li>The whole task is one undo step. A checkpoint precedes every commit of agent work.</li></ul> |
| Autonomy dial | In the Assistant panel header, always showing its value: Ask at each step, Propose per feature (default), Auto-apply checked quick edits. Only the user changes it. Nothing is auto-applied to user-authored features (§6, [ADR 0015](adr/0015-autonomy-dial.md)). |
| Checkpoints | Named, restorable snapshots of the committed document (IR, CadScript, authorship marks), taken before every commit of agent work and every branch merge, or by hand. Restore is one undoable transaction. |
| Live progress | A plan checklist, CadScript streaming into the code view, a cost meter and a Stop button. First geometry appears within about 20 s. |
| Assumption chips | For example "PLA · 0.4 nozzle · M3 · 0.2 clearance". Editing a chip regenerates **with no LLM call**. From IR v1.1, chips read and write the design context ([ADR 0018](adr/0018-design-context-in-the-ir.md)). |
| Spec card | For T2 parts and up; editable before the build starts. From IR v1.1 it shows the design context's requirements, each with its computed status. |
| Design Review mode | Pinned findings, each with Why (rule or calculation plus source), Fix (the agent drafts a branch) and Dismiss |
| Always-on checks (no LLM) | Overhang heatmap, thin walls, bridges, sharp internal corners (CNC), unconstrained sketches |
| Learned preferences | Offered as updates to project conventions, never applied silently |

---

## 8. Evaluation harness and data flywheel

The harness is built in week 1. It runs headless: native Forge, offscreen `forge-render` and the agent.

### MakerBench

- **Size:** 60 tasks in Phase 0, 300 by beta, 600 by v1.0.
- **Tiers:**
  - T1: simple parts;
  - T2: multi-feature parts;
  - T3: assemblies;
  - T4: edits;
  - T5: under-specified prompts (does it ask, or assume well?);
  - T6: image or sketch to part.
- **Each task has** a reference model, **hidden tests**, a process profile and tags.
- **Sources:** hand-written tasks, verified synthetic variants, near-miss edits and, later, community submissions.
- **Today:** 61 tasks (34 T1, 14 T2; all IR v0) with 456 hidden tests. That is too few to gate on: with 14 tasks, a 65% result carries about ±25 points. A benchmark gate is evaluated only on a tier with ≥100 tasks. Until a tier reaches 100 tasks, its gate is not met, so a phase exit waits for the tasks. Every result is published with its 95% interval.

**External benchmarks:** CADPrompt, a Text2CAD-Bench subset, and CADGenBench generation and editing tasks. Check each licence first, and never use these benchmarks as prompt examples.

### Metrics

| Area | Metrics |
|---|---|
| Quality | Validity; hidden-test pass rate; IoU and Chamfer distance; spec adherence |
| Editability | Perturbation survival; share of sketches fully constrained; magic-number count; edit locality |
| Judge | Agreement with humans |
| Cost and speed | $/task; p50/p90 latency; repair count; quality of clarifying questions |
| Live product | Accept rate; manual corrections within 10 minutes; re-prompts; product NHL. For BYO-key and CLI users these come only from [ADR 0017](adr/0017-opt-in-product-counts-and-failure-reports.md)'s opt-in counts, which hold no content and no timing finer than a day, so corrections within 10 minutes and re-prompts are not measured for them |
| North star | Benchmark and product NHL; FTPS; the head-to-head table (below) |

A **cross-provider leaderboard** decides routing and tuning.

### North-star metrics, Fit Lab and head-to-head

[NORTH-STAR.md §7](NORTH-STAR.md#7-north-star-metrics-and-gates) holds the thresholds. This section says what each metric measures and where its data comes from. None is measured yet.

| Metric | What it measures | Data |
|---|---|---|
| **Benchmark NHL** (no-heavy-lifting rate; the north-star metric) | The share of MakerBench tasks where a scripted user only chats (at most 3 messages), accepts and exports, with zero manual sketch, feature or code edits. The export must pass the hidden tests, its machine profile's process checks and an independent reader: a model from a different family that reads the exported file against the prompt | This harness, weekly, on the public subset |
| **Product NHL** | The share of exported parts whose session had zero manual geometry operations | ADR 0017 opt-in usage counts (self-reported), or a recruited alpha study under study consent |
| **FTPS** (first-try physical success) | The share of parts that fit and work on the first attempt | The Fit Lab; alpha users' photos of a go/no-go coupon, under study consent |
| **Head-to-head** | The STEP-scorable MakerBench subset and the Fit Lab, run on Zoo, Adam, Fusion's Assistant (once available), CADZero and a build123d-plus-checks baseline | Run at open alpha; the table is published |

- **Gates.** At open alpha (~M8) NHL T1, the Fit Lab and the head-to-head table are run and published, not gating; the targets there are NHL T1 ≥50% and Fit Lab ≥70%. With the hands-on bench, they gate Phase 1 exit (~M10) (NORTH-STAR §8 A1). The head-to-head's exit gate is that it is re-run and published; it requires no margin. The existing gates still bind, including T1 ≥85% pass@1.
- **The "lead" rule.** We claim a lead only where PartZero beats the best of the others by ≥10 points with non-overlapping 95% intervals, and we publish the table.
- **Fit Lab.** 30 mating tasks (insert boss, bearing press fit, snap-fit lid, print-in-place hinge, finger-joint box, CNC bearing pocket), judged with go/no-go gauges.
  - It runs on the owner's own 3D printer(s), with no hardware bought now (owner decision, 2026-09-24), and about 3–5 hours a week of human printing by the owner. NORTH-STAR §7's full setup (3 calibrated printers and a diode laser) is deferred.
  - Until more machines exist, gated results count printed tasks only, on the named printer(s), and each result is published with its machine list. NORTH-STAR §7's "each task on several machines" applies once the deferred hardware is bought. Laser and CNC tasks join when access to those machines exists; until then kerf compensation is checked against geometry only ([ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)).
  - This capacity can delay open alpha (ROADMAP, "Top risks").
  - Gates count prints, not task types: ≥100 prints per gate, about ±9 points of 95% uncertainty at 70%.
  - Strength badges also need break tests: at least 10 printed brackets per material, loaded to failure on a scale. Until then, printed-part load checks return "can't verify".
- **How the AI runs are paid for.** Today NHL runs use the maintainer's Claude Code plan, shared with development ([ADR 0014](adr/0014-cli-agents-as-providers.md)). The reader and the non-Claude leaderboard rows need other CLI plans, a local model or API keys. If plan runs cannot keep a weekly cadence by open alpha, funded API keys cover the missing rows ([ADR 0020](adr/0020-funded-eval-keys-fallback.md)). BACKLOG's per-task wall-time cap comes first either way.

### Public benchmarks

NORTH-STAR B13 dates what was "Later":

| When | What goes public |
|---|---|
| M8 (open alpha) | **MakerBench, STEP-scorable subset.** Any tool's STEP can be scored on it; a hidden held-out set stays private. 99 of today's 456 hidden tests depend on our IR or on seam conventions (55 face counts, 25 curve counts, 19 feature-history checks). Those checks are seam-normalized or dropped, and each normalization is published. We publish our own failures first |
| M12 | **The Forge RL environment,** a training gym for AI models. It helps rivals too; we accept that |
| M15 (v1.0) | **The IR conformance runner:** `corpus/v1/conformance` as a public runner, so other engines can show they implement the IR SPEC |

### CI

| Trigger | What runs |
|---|---|
| Every PR | Unit tests, **Forge oracle diffs** (sampled), trajectory replay |
| Prompt, tool or skill PRs | 25 live tasks |
| Nightly | 100 tasks plus the full Forge differential suite (scheduled weekly today, not yet run; see §10) |
| Weekly | Full suite at pass@3 across providers; benchmark NHL on the public MakerBench subset |

- **Merge gate.** A PR is blocked if:
  - any tier drops more than 3 points;
  - cost rises more than 15%;
  - any silent-wrong Forge result appears.
- **Budget:** about $1–2k per month for evals, plus the verification machine's compute line (§10). Evals run on CLI plans and local models first. Funded API keys are a fallback from open alpha, capped at $2k a month inside this budget ([ADR 0020](adr/0020-funded-eval-keys-fallback.md)).

### Data flywheel

Two layers, both opt-in with separate switches. (1) Usage counts and kernel failure reports ([ADR 0017](adr/0017-opt-in-product-counts-and-failure-reports.md)): content-free, for every user whatever the provider, off by default. (2) Content logging (the list below): off for BYO-key and CLI users and for private projects.

**Layer 1: usage counts and kernel failure reports** ([ADR 0017](adr/0017-opt-in-product-counts-and-failure-reports.md)). Three streams, each consented separately. The two switches are asked about once, at first launch, and both start off:

| Stream | What it holds | Consent |
|---|---|---|
| Usage counts | Per part and per day: agent features offered, accepted and rejected; exports by format and process; whether geometry was edited by hand (yes/no, and which kinds). A random install ID and part token count makers and parts | Switch, off by default |
| Failure signatures | Per kernel failure kind and day: error code, operation, stage, versions, platform. Never the error's details | Switch, off by default |
| Minimized failure case | A shrunk, stripped IR program that still reproduces one kernel failure | The user reviews it and presses Send, every time |

- **Never sent:** designs (except a minimized case the user reviewed and sent), dimensions, names, file paths, prompts, chats, keys, account data or error details. The payload schema has no free-text strings, and Settings → Privacy shows exactly what will be sent.
- **No request at all** when both switches are off. Headless runs (the `aicad` CLI, headless MCP, evals, CI, tests, dev builds) never send and never ask.
- **Retention:** raw rows 12 months, then aggregates without the install ID. Published aggregates cover groups of at least 10 installs. "Delete my data" is honored within 30 days.
- **It feeds** product NHL and the failure zoo. Counts are self-reported, and published as such.
- **Beta's adoption gates** (≥99.5% crash-free sessions, 300 weekly active users) need a daily count of app runs and of runs that ended in an app crash. Those join the allowlist as count fields under ADR 0017's §3 rule, with no crash SDK; until they do, the alpha study measures these gates. Figures from opted-in installs are a lower bound on weekly active users.

**Layer 2: content logging. What is logged:**
- trajectories and verifier results;
- accept/reject decisions per feature;
- **manual edits made after accepting** (gold data);
- dismissed findings;
- sketches with their final constraints;
- Forge failures with the fix that worked, which feed the failure zoo.

| When | Model roadmap |
|---|---|
| M1–12 | No fine-tuning. Mine failures weekly into repair hints, skill rules and DSL ergonomics. |
| M8–M15 | Publish MakerBench's STEP-scorable subset (M8), the Forge RL environment (M12) and the IR conformance runner (M15); see [Public benchmarks](#public-benchmarks) |
| Phase 3 | A small local ONNX sketch auto-constrain model, rewarded by solver status |
| Phase 4 | A distilled vision critic that handles about 80% of judge calls |
| Phase 5–6 | Mesh, image or point cloud → CadScript. Training is SFT on synthetic programs, then online RL with IoU, validity and editability rewards, plus **Forge-gradient rewards**. Hosted "STL remix → parametric". |

---

## 9. External MCP server and CLI

Both ship in Phase 1.

| Aspect | Design |
|---|---|
| Source | Generated from the same tool registry as the in-app agent |
| Resources | `cad://doc/{id}/code \| ir-summary \| spec \| tests`; renders returned as images |
| Prompts | `design-part`, `review-design` |
| Transports | <ul><li>A stdio shim. In-app CLI agent runs use it in bridge mode: a private socket plus a per-run ticket to a host-side tool broker ([CLI-PROVIDERS.md §6](CLI-PROVIDERS.md#6-mcp-server-packagesmcp-server)).</li><li>Streamable HTTP on localhost with a token per client.</li><li>A headless mode.</li></ul> |
| Safety | <ul><li>External agents write only to a `mcp/<client>` branch, reviewed in the same diff UI.</li><li>Scopes: read, edit-on-branch, export.</li><li>Rate limits; no file access beyond the export directory.</li></ul> |
| Long operations | Run as **MCP Tasks** (2026-07-28 spec) |
| Delegation | `design_task(prompt, budget)` lets Claude Code delegate CAD work to our harness |
| CLI | CadScript files in git, plus `aicad build \| test \| render \| export`, with GUI live-reload |

---

## 10. Verification at a glance

| Layer | What runs |
|---|---|
| Forge | <ul><li>A differential suite against OCCT (volume, area, topology, validity, Hausdorff distance); its gate is 0 silent-wrong results. Scheduled weekly today, not yet run; nightly at scale (below).</li><li>Invariants after every operation.</li><li>Property and fuzz tests.</li><li>A bit-identical cross-target check.</li><li>Benchmarks under `forge/benches`.</li></ul> See [FORGE.md](FORGE.md#verification-machine). |
| App | <ul><li>Vitest unit and property tests (IR ops and their inverses, CadScript round-trip, units).</li><li>Golden-geometry corpus tests.</li><li>Playwright-Electron end-to-end tests (sketch → extrude → fillet → export).</li><li>`aicad` headless regeneration and export of every corpus model.</li></ul> |
| AI | <ul><li>MakerBench plus external subsets through `evals`.</li><li>Trajectory replay on every PR; live suites nightly and weekly.</li><li>The cross-provider leaderboard, benchmark NHL and the head-to-head table feed the phase exit metrics (§8).</li></ul> |
| Physical | The Fit Lab: FTPS from real prints, and break tests before any printed-part strength badge (§8). |
| Manual | In the Electron app, ask the agent for "a Gridfinity 2×3 bin with label tab", review the draft diff, accept it, export 3MF, slice and print. |

### The verification machine at scale

NORTH-STAR B10 makes the verification machine a staffed track with its own compute line.

| | Today | Target |
|---|---|---|
| Generated kernel cases | 200 per push, Linux only. 1,000 a week on a weekly schedule, cut from nightly for private-repo cost; it has not run yet. The three-OS matrix runs only on demand | Weekly suite green by M3; 10k cases a night by M4; 100k by M10 |
| Datasets | None used | DeepCAD, Fusion 360 Gallery and ABC, each only after its licence is recorded |
| Failure zoo | Agents grind it on the development plan and the runner above | Round-the-clock grinding, once the compute line and BACKLOG's per-task wall-time cap are in place |

- **Compute line:** public-repo CI runners, plus self-hosted runners if needed, sized from the first runs' wall time.
- **Protected:** tolerances, SPEC and tests stay protected from agent edits.
