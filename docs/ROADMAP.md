# Roadmap

> **Current status:** Phase 0 started 2026-09-23 (M1 = Oct 2026).
>
> **What exists so far:**
> - the repo skeleton and CI;
> - `forge-ir`, with the IR v0 types, the JSON Schema and the normative [SPEC](../forge/crates/forge-ir/SPEC.md);
> - the first corpus programs.
>
> Spike reports go in [spikes/](spikes/README.md).
>
> **North star:** [NORTH-STAR.md](NORTH-STAR.md), approved by the owner on 2026-09-24. This roadmap includes every change in its §8 (rows A1–A4 and B1–B18) and the metrics in its §7.

Source: [PLAN-2026-09-23.md](PLAN-2026-09-23.md), §8–§10, amended by [NORTH-STAR.md](NORTH-STAR.md) §7–§8 and ADRs [0015](adr/0015-autonomy-dial.md), [0016](adr/0016-manufacturing-output-own-vs-hand-off.md), [0017](adr/0017-opt-in-product-counts-and-failure-reports.md), [0018](adr/0018-design-context-in-the-ir.md), [0019](adr/0019-local-face-operations.md) and [0020](adr/0020-funded-eval-keys-fallback.md). Row IDs such as A1 or B8 refer to NORTH-STAR §8.

## Ground rules

- **Exit gates decide when a phase ends, not dates.** The month ranges and calendar dates below are indicative.
- **Only group A items bind a phase or milestone.** NORTH-STAR §8 group A items (A1–A4) join a gate and can delay it. Group B items ship when ready and gate only their own feature.
- **Every existing gate stays.** The F2 gate stays exactly as [FORGE.md](FORGE.md#milestones) defines it. New checks join the Phase 1 exit (beta) gate instead.
- **Claims follow published numbers.** We claim "lead" only where a published head-to-head table shows it, and "better than Parasolid" only with a named corpus and a number. Bets are labelled as bets (NORTH-STAR §9).
- **Parallel agent workstreams** (Forge, app, agent, evals) run in separate worktrees.
- **Forge first costs about 3 months.** Building Forge first moves the public MVP about 3 months later than an OCCT-based plan would, in exchange for a kernel we own. Meanwhile, agent, app and eval work proceeds against the `oracle/` backend and the growing Forge.

## Overview

| Phase | Months | ≈ Calendar | Theme | Forge milestones (kernel work, dates from FORGE.md) |
|---|---|---|---|---|
| 0 | M1–M2 | Oct–Nov 2026 | Foundations and spikes | F0 (M1–M2) |
| 1 | M2–M10 | Nov 2026 – Jul 2027 | Maker MVP on Forge | F1 (M2–M5); F2 (M4–M8), the maker release gate; F3 starts (M8) |
| 2 | M10–M15 | Jul – Dec 2027 | Assemblies + v1.0 | F3 (to M14); F4 starts (M12) |
| 3 | M14–M19 | Nov 2027 – Apr 2028 | Fabrication | F3 lands (HLR, sheet metal); F4 (to M18); `forge-cam` (2.5D CAM, a new crate; [ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)) |
| 4 | M17–M22 | Feb – Jul 2028 | Web + cloud | F5 starts (M18+) |
| 5 | M20–M26 | May – Nov 2028 | Organic + simulation | F4 and F5 reach users (SubD, "optimize" tools, `forge-sim`) |
| 6+ | Later | — | Scan-to-CAD, iPad, collaboration, PLM | F5 |

Forge milestone scopes and gates are in [FORGE.md](FORGE.md#milestones).

**Milestones and phases.** A milestone's dates are kernel work. The phase that ships its features to users can come later. F4 (gradients, SubD, mesh and SDF) is kernel work at M12–M18. Users get the SubD workspace and the "optimize" tools in Phase 5 (M20–M26). Analytic sensitivities for a few parameters come earlier, by M10 (B14). This settles the F4 timing clash that NORTH-STAR B14 noted. The matching FORGE.md wording waits in [NORTH-STAR-DEFERRED.md](NORTH-STAR-DEFERRED.md).

---

## North star: metrics and gates

Full definitions are in [NORTH-STAR.md](NORTH-STAR.md) §7.

- **North-star metric: the no-heavy-lifting rate (NHL).**
  - **Benchmark NHL:** the share of MakerBench tasks where a scripted user only chats (at most 3 messages), accepts and exports, with no manual sketch, feature or code edit. The export must pass the hidden tests, its machine profile's process checks and an independent reader: a model from a different family that reads the exported file against the prompt.
  - **Product NHL:** the share of exported parts whose session had zero manual geometry operations. It needs [ADR 0017](adr/0017-opt-in-product-counts-and-failure-reports.md)'s opt-in counts or a recruited alpha study under study consent.
- **Companion: first-try physical success (FTPS),** the share of parts that fit and work on the first attempt. The Fit Lab measures it.
- **Sample sizes.** MakerBench has 61 tasks today (34 T1, 14 T2, all IR v0). With 14 tasks, a 65% result carries about ±25 points. A benchmark gate is evaluated only on a tier with ≥100 tasks (ARCHITECTURE plans 300 by beta). Until a tier reaches 100 tasks, its gate is not met, so a phase exit waits for the tasks. Every result is published with its 95% interval.
- **NHL vs pass@1.** NHL allows 5 points below the pass@1 gates for its stricter checks. The pass@1 gates (T1 ≥85%, T2 ≥65%) still bind.
- **How we run the AI numbers.** Weekly, on the public MakerBench subset, on the maintainer's Claude Code plan (shared with development). Non-Claude rows need Codex or Gemini CLI plans or a local model. BACKLOG's per-task wall-time cap comes first. If plan runs cannot keep a weekly cadence by open alpha, funded eval keys take over the rows plans cannot run ([ADR 0020](adr/0020-funded-eval-keys-fallback.md), B18).

### The Fit Lab

- **30 mating tasks:** insert boss, bearing press fit, snap-fit lid, print-in-place hinge, finger-joint box, CNC bearing pocket. Go/no-go gauges judge them.
- **Gates count prints, not task types:** ≥100 prints per gated result, each task repeated. At 70%, that gives about ±9 points of 95% uncertainty.
- **Hardware:** the owner's own 3D printer(s), with the owner printing the test parts, 3–5 h/week. No hardware is bought now (owner decision, 2026-09-24). NORTH-STAR §7's full setup (3 calibrated printers and a diode laser, about $4–6k) is deferred.
- **What counts toward the gates for now.** Until more machines exist, gated Fit Lab results count printed tasks only, on the named printer(s), and each result is published with its machine list. NORTH-STAR §7's "each task on several machines" applies once the deferred hardware is bought.
- **Laser and CNC tasks wait for machine access.** They join the Fit Lab when access exists. Until then, kerf compensation is checked against geometry only ([ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)).
- **Break tests** gate strength badges: at least 10 printed brackets per material, loaded to failure on a scale.

### Group A: gate items

| # | Item | Binds |
|---|---|---|
| A1 | Fit Lab; NHL, FTPS and head-to-head gates; hands-on bench | Run and published at open alpha (~M8), not gating there, but open alpha waits for the runs. Targets at open alpha (published, not gating): benchmark NHL T1 ≥50%, Fit Lab ≥70%. Gating at Phase 1 exit (see the Phase 1 exit gates) |
| A2 | Per-process manufacturability checks in `forge-check` (FDM, laser, CNC), each with per-process MakerBench tests | The per-process tests gate beta |
| A3 | Definition-based fillet oracle: it checks a fillet against the rolling ball that defines it | 0 silent-wrong on its corpus at Phase 1 exit |
| A4 | The F3 gate, set now: on an F3 blend and offset corpus of ≥1,000 cases (definition-based oracles, plus defillet cases if that bet works), Forge's valid-result rate ≥ OCCT's, and 0 silent-wrong | Gates F3, not beta |

**The head-to-head.** At open alpha we run the STEP-scorable MakerBench subset and the Fit Lab on Zoo, Adam, Fusion's Assistant (once available), CADZero and a build123d-plus-checks baseline. We publish the table. We claim "lead" only where PartZero beats the best of them by ≥10 points with non-overlapping 95% intervals. At Phase 1 exit the head-to-head is re-run and published; that is the gate, and it requires no margin.

**The hands-on bench.** 10 maker parts, chosen by a third party. At least 5 novices use PartZero; at least 3 experts each use Fusion and Shapr3D. Time runs from blank to a checked export, agent latency included.

### Feature gates

These gate only their own feature, not a phase.

| Feature | Gate |
|---|---|
| Tab (B3) | ≤300 ms; ≥30% of offers accepted; ≤5% undone within 60 s; on ≥2,000 offers in the alpha study group. Off by default until met |
| Push/pull and dimension drag (B1) | Provisional drag frame ≤16 ms p95; checked result on release ≤150 ms; sketch drag ≤4 ms |
| Deterministic auto-constrain (B2) | ≥70% of sketches fully constrained at beta. Phase 3's ≥85% stays |
| Calculation tools (B6) | 100% of ≥150 golden cases within 1% before the tools ship; ≥300 cases by beta. These check the arithmetic, not whether a part holds; break tests do that |
| Autonomy dial and checkpoints (B4, B5) | 0 silent changes to user features: every agent transaction is diffed against user-authored features at commit, and MakerBench T4 edit tasks assert unchanged features. Checkpoint restore 100% correct ([ADR 0015](adr/0015-autonomy-dial.md)) |
| Feasible ranges (F2 scope) | By F2, ≥90% of single-parameter out-of-range errors (fillet radius, shell thickness, extrude depth, hole size) on the F2 corpus return a feasible interval. Not part of the F2 gate |
| Verification machine (B10) | Weekly suite green by M3; 10k cases a night by M4; 100k by M10 |
| Determinism | Per push: Linux and wasm32. macOS and Windows on demand. One full four-target CI run closes FORGE.md's existing F0 gate (all four targets bit-identical) before F1. All four targets per push once the repo is public or on self-hosted runners |
| Silent-wrong results | 0 every release on each named corpus (generator, error corpus, each licensed dataset), reported with corpus size next to the success rate |
| Sketch-and-extrude Parasolid proxy (B11) | Reported at F1 next to FORGE.md's ≥99.5% DeepCAD oracle gate. Not a new gate |
| Local face operations (B16) | Their own ship gate ([ADR 0019](adr/0019-local-face-operations.md)). It binds no milestone |
| CAM (B17) | 0 silent-wrong toolpaths on the CAM corpus (see Phase 3) |

### Bets, not gates

Each has a stated proof in NORTH-STAR §9: CadScript fluency (spike 7); a learned Tab model; defillet-and-rebuild on ABC parts; a third-party IR implementation by v1.0; NHL T2 ≥85% and T3 ≥60% by end of 2028; Parasolid-class robustness on blends, offsets and industrial STEP in 2029–2031.

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
- **Closed alpha** when the **F2 gate** passes (target ~M7). ADR 0017's opt-in counts and kernel failure reports ship for it (B12).
- **Open-source public alpha ~M8.** We publish our numbers first: the A1 runs (benchmark NHL, Fit Lab, the first head-to-head table, the hands-on bench), the public MakerBench subset (B13) and a public kernel dashboard and failure zoo. Targets at open alpha (published, not gating): benchmark NHL T1 ≥50%, Fit Lab ≥70%. These don't gate open alpha, but it can slip by the time the runs take.
- **Beta ~M10,** when the exit gates below pass.

**Load.** The approved NORTH-STAR changes add about 40–65 agent-weeks to Phase 1 (notional). The bottlenecks are physical testing (3–5 h/week), plan or compute time for evals, and the owner's review.

### In scope

| Area | Scope |
|---|---|
| Documents | Single-part documents with multiple bodies |
| Sketcher | Line, arc, circle, rectangle, slot, polygon, spline, constraints and dimensions. Sketches auto-constrain as you draw, deterministically (B2). The learned model stays in Phase 3 |
| Features | Extrude, revolve, holes, fillet, chamfer, shell, draft, patterns, mirror, booleans, datums, text emboss |
| Parametrics | Parameters and equations, the timeline, a two-way code view |
| Hands-on editing (alpha) | Push/pull and dimension drag drive parameters (B1): pull a plate's top and `thickness` changes. Live frames come from a fast preview path, drawn in a provisional style. On release, Forge builds and checks the value; a failing value snaps back to the feasible limit (F2 feasible ranges) |
| Working with the agent (alpha) | <ul><li>⌘K on the canvas: a quick edit at the selection lands in place as a checked ghost (B3).</li><li>A translucent ghost overlay (B4).</li><li>Checkpoints with restore (B4, [ADR 0015](adr/0015-autonomy-dial.md)).</li></ul> |
| Working with the agent (beta) | <ul><li>Tab: a checked ghost of the likely next feature from 5 deterministic proposers, with no LLM. Off by default until its gate is met (B3).</li><li>The autonomy dial (B5, [ADR 0015](adr/0015-autonomy-dial.md)): ask at each step; propose per feature (the default); auto-apply checked quick edits to agent-authored features. Nothing is auto-applied to your features.</li></ul> |
| Engineering copilot | <ul><li>M3–M5: a sourced handbook, 8 calculation tools (`fit` ISO 286, `fastener`, `print_clearance`, `snap_fit`, `gear`, `bearing_select`, `beam_plate`, `material`) and closed-form structural checks (B6). Values come from formulas or cited facts, never copied tables. Printed-part safety-factor badges wait for Fit Lab break tests.</li><li>By M10: analytic sensitivities for a few parameters (B14).</li></ul> |
| Design context | IR v1.1, after Phase C: a geometry-free `context` block holding material, process, machine, requirements, loads, decisions and assumptions (B7, [ADR 0018](adr/0018-design-context-in-the-ir.md)). The oracle ignores it |
| Import | STL and 3MF as reference meshes; STEP as a solid |
| Export | STL, 3MF and STEP. Beta: DXF and SVG for lasers, waterjets, vinyl and drag-knife cutters and plotters, with flat-part detection, kerf compensation and simple nesting (B9, [ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)). Plasma later |
| Printing | FDM checks, orientation suggestions, printer profiles. Alpha (B8): profiles gain a measured clearance from a fit coupon printed on the user's printer, and slicer handoff opens an oriented 3MF in the user's installed Bambu Studio, OrcaSlicer or PrusaSlicer. We launch the slicer the user installed and never bundle or link one (ADR 0016) |
| Manufacturability checks (A2) | Per-process checks in `forge-check`: FDM, laser and CNC (such as inner radii vs tool), each with per-process MakerBench tests |
| AI | <ul><li>The full agent loop with 25 skills and the standard-parts set.</li><li>Draft-branch diffs.</li><li>BYO keys for every provider at alpha; hosted credits at beta.</li></ul> |
| Evaluation and data | <ul><li>The Fit Lab, NHL, FTPS, head-to-head and hands-on bench runs (A1).</li><li>Public MakerBench at M8: a STEP-scorable subset with a hidden held-out set (B13). Checks that depend on our IR or seam conventions (99 of today's 456 hidden tests) are seam-normalized or dropped, and each normalization is published.</li><li>Opt-in, content-free product counts (pseudonymous; [ADR 0017](adr/0017-opt-in-product-counts-and-failure-reports.md)) and minimized kernel failure reports, at closed alpha (B12).</li><li>Funded eval keys from open alpha, only if plan runs cannot keep a weekly cadence (B18, [ADR 0020](adr/0020-funded-eval-keys-fallback.md)).</li></ul> |
| Verification machine | <ul><li>A staffed track (B10). Compute: public-repo CI runners, plus self-hosted if needed, sized from the first runs' wall time. Today: 200 generated programs per push (Linux only); 1,000 a week, scheduled but not yet run.</li><li>The definition-based fillet oracle (A3).</li><li>The failure zoo: every failure shrinks to a minimal repro kept forever. Round-the-clock grinding needs the compute line and BACKLOG's wall-time cap first.</li><li>Datasets (DeepCAD, Fusion 360 Gallery, ABC) come in only after their licences are recorded. We check whether Onshape's terms allow competitive benchmarking before using ABC that way.</li><li>At F1, the sketch-and-extrude Parasolid proxy is reported beside the DeepCAD oracle gate (B11).</li></ul> |
| Integration and distribution | <ul><li>MCP server and CLI.</li><li>Signed macOS and Windows builds with auto-update; Linux AppImage beta.</li><li>A web preview build is optional and cheap, since Forge and the renderer are WASM-native.</li></ul> |

### Deferred

- Assemblies.
- Sweeps and lofts.
- Drawings.
- Sheet metal.
- Cloud (billing only).
- FEA (Phase 5) and CAM (Phase 3).
- Local background agents, the fab packet and resin checks (Phase 2).
- SubD.
- iPad.
- Fine-tuning.
- A plugin API (skills only).

### Exit gates

| Area | Gate |
|---|---|
| Accuracy | T1 ≥85% hidden-test pass@1; T2 ≥65%; T4 ≥80% |
| No heavy lifting (A1) | Benchmark NHL: T1 ≥80%, T2 ≥60%. Product NHL: ≥50% of accepted parts, on ≥200 exported parts from ≥20 alpha makers (ADR 0017 counts or the alpha study) |
| First-try physical success (A1) | Fit Lab ≥85%, on ≥100 prints. Alpha users ≥70%, on ≥100 parts reported with a photo of the go/no-go coupon |
| Head-to-head (A1) | Re-run and published; beta waits for it. No margin is required (NORTH-STAR §7 sets none). "Lead" is claimed only where PartZero beats the best rival by ≥10 points with non-overlapping 95% intervals |
| Hands-on bench (A1) | Novice median time ≤ the expert median; novice success ≥80% |
| Manufacturability (A2) | The per-process MakerBench tests (FDM, laser, CNC) pass |
| Robustness | Validity ≥98%; editability ≥90%; ≥99% of provenance names survive edits; 0 silent-wrong Forge results in the nightly differential suite (weekly today). 0 silent-wrong on the definition-based fillet oracle's corpus (A3) |
| Speed and cost | Median T1 ≤$0.75 and ≤90 s |
| Adoption and quality | <ul><li>20 alpha makers each print ≥3 parts.</li><li>≥60% of proposals accepted with ≤2 manual edits.</li><li>≥99.5% crash-free sessions.</li><li>300 weekly active users.</li></ul> |

- **Benchmark gates and tier size.** A benchmark gate is evaluated only on a tier with ≥100 tasks. Until a tier reaches 100 tasks, its gate is not met, so beta waits for the tasks. Every result is published with its 95% interval.
- **How the adoption gates are measured.** Crash-free sessions and weekly active users need data from BYO-key and CLI users, who are every alpha user. They come from [ADR 0017](adr/0017-opt-in-product-counts-and-failure-reports.md)'s opt-in usage counts, once those add a daily count of app runs (for this gate, a session is one app run) and of runs that ended in an app crash (count fields under its §3 rule; no crash SDK), or from the alpha study under study consent. Opt-in users choose themselves: weekly active users counted from opted-in installs are a lower bound, and each figure is published with its count of installs.

---

## Phase 2: Assemblies + v1.0 (M10–M15)

### In scope

| Area | Scope |
|---|---|
| Assembly modeling | Assemblies with ports; 6 mate types via `forge-solve`; a skeleton part; interference checks; motion scrubbing; BOM |
| AI | <ul><li>Product-structure decomposition, with a task per part and automatic mating of standard parts.</li><li>Local background agents: long jobs such as variants and part families, each on its own branch, after BACKLOG's wall-time cap (B15). Hosted ones stay in Phase 4.</li></ul> |
| Geometry | <ul><li>Sweeps, lofts and splines, from F3. These are exposed through skills first.</li><li>Local face operations (move, offset, replace and delete face) arrive with F3 as timeline features, with OCCT as the oracle, behind their own ship gate (B16, [ADR 0019](adr/0019-local-face-operations.md)). B-spline faces wait for F3's NURBS offsets.</li></ul> |
| Optimization | A search optimizer: "make it 20% lighter" returns a lighter branch that passes every check. Few parameters only. F4 gradients replace it in Phase 5 (B14) |
| Output and publishing | <ul><li>The fab packet: STEP plus a PDF of critical dimensions, fits, material and quantity (B15).</li><li>Resin checks: minimum wall, islands, suction cups, for a hollowed part with drain holes (B15).</li><li>Publish pages with parameter sliders.</li><li>Slicer handoff moved to Phase 1 alpha (B8).</li></ul> |
| Open standard | The Forge RL environment (M12); a public IR conformance runner (M15) (B13). A third-party IR implementation by v1.0 is a bet, not a gate |
| Evaluation | CADGenBench |

### Deferred

These move to later phases:
- drawings, sheet metal and CAM (Phase 3);
- web and cloud accounts, and hosted background agents (Phase 4);
- SubD and FEA (Phase 5);
- iPad and real-time collaboration (Phase 6+).

### Exit gates

| Area | Gate |
|---|---|
| Assembly quality | <ul><li>T3 ≥60% intent-correct (baseline 30.6%).</li><li>0 coordinate placements, enforced by a linter.</li><li>≥95% of accepted assemblies interference-free.</li></ul> |
| No heavy lifting (A1) | Benchmark NHL: T1 ≥85%, T2 ≥75% |
| Performance | A 50-part assembly regenerates in <3 s |
| Business | v1.0 shipped, 2k weekly active users, $5k MRR |

---

## Phase 3: Fabrication (M14–M19)

### In scope

| Area | Scope |
|---|---|
| Sheet metal | Flanges, bends, reliefs, K-factor, flat patterns → DXF |
| Laser | DXF/SVG export moved to Phase 1 beta (B9, ADR 0016) |
| Drawings | <ul><li>Forge HLR views.</li><li>**Auto-dimensioning driven by the design's parameters.**</li><li>Sections, detail views, title block.</li><li>GD&T is *suggested* from ports, never applied automatically.</li><li>A vision-model review pass.</li></ul> |
| CNC | <ul><li>3-axis manufacturability checks, beyond Phase 1's per-process checks.</li><li>Our own 2.5D CAM for hobby routers (B17, [ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)): toolpaths, GRBL and LinuxCNC posts, stock-removal simulation and a setup sheet. It lives in a new Forge crate, provisionally `forge-cam`, with Kiri:Moto as the CI oracle.</li><li>No G-code leaves the app without simulation and the user's acknowledgment.</li></ul> |
| AI | The learned auto-constrain model (the deterministic version ships in Phase 1) |

M14 is past year one, so VISION's "no CAM toolpaths in the first year" still holds.

### Deferred

These move to later phases:
- web and cloud (Phase 4);
- SubD and FEA (Phase 5);
- turning and CAM beyond 2.5D (Phase 6+).

### Exit gates

| Area | Gate |
|---|---|
| Drawings | Auto-drawings produced for 90% of MakerBench parts; average rating ≥4/5 on a 50-part sample |
| Sheet metal | Flat patterns within ±0.1 mm on 20 parts |
| Auto-constrain | ≥85% of sketches end up fully constrained |
| CAM | 0 silent-wrong toolpaths on the CAM corpus: none reported as fine while the oracle or an independent check shows a gouge, a collision or stock left beyond tolerance. Corpus size, agreement with Kiri:Moto and physical test cuts are set before CAM work starts (M14) |
| Business | 5 paying shops |

---

## Phase 4: Web + cloud (M17–M22)

### In scope

| Area | Scope |
|---|---|
| Web | A web build with OPFS storage |
| Accounts and sharing | Accounts and sync; share, fork and branch/merge via IR diffs; geometry-anchored comments |
| Cloud agent | Hosted long agent tasks (local background agents arrive in Phase 2) |
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
| Optimization | Differentiable "optimize" tools on F4 gradients. They replace the Phase 2 search optimizer |
| AI meshes | TRELLIS.2 used as a reference body |
| Simulation | `forge-sim` linear static FEA, validated against CalculiX, with loads on semantic faces. The advisor explains the margins. |

### Deferred

These move to Phase 6+:
- scan/mesh/photo → parametric;
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
- **Turning and CAM beyond 2.5D, our own.** Direct laser G-code only if the LightBurn handoff proves too weak.
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
- The user's installed slicers, laser software and machine senders, and fab services, as hand-off targets ([ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)). We never bundle or link a slicer.

Everything that defines quality is ours ([ADR 0000](adr/0000-own-the-core.md)).

---

## Go-to-market

| When | What |
|---|---|
| M1 | Waitlist; build in public. **The "open AI-native kernel" story is a headline in itself**: a dev log with oracle-comparison dashboards, and agent videos. |
| M3–4 | An NLnet/NGI Zero grant (a strong fit for an open kernel); free browser mini-tools built on skills (Gridfinity, project boxes, Skadis) for SEO and the waitlist |
| M8 | Open-source launch with our numbers published first: the public MakerBench subset, the kernel dashboard and failure zoo, NHL and Fit Lab results, and the first head-to-head table. Show HN, r/3Dprinting, r/functionalprint, r/gridfinity, r/openscad, r/cad, r/rust. Discord and GitHub Sponsors. |
| M8–10 | Printables/MakerWorld showcases with parametric source; early access for maker YouTubers (Zack Freedman, CNC Kitchen, Maker's Muse, Teaching Tech) |
| M10 | Hosted credits plus a "Founding Supporter" plan (no lifetime AI credits) |
| M12–15 | Crowdfunding or pre-sales around v1.0, if the waitlist is ≥5k or WAU ≥1k. Target $30–60k. |
| M15+ | Fabrication partners (SendCutSend, OSHCut, JLC); Forge OEM licensing conversations. Until then, users upload to fab services by hand |
| M17+ | Public customizer pages |

---

## Top risks

| Risk | Mitigation |
|---|---|
| **Forge's long tail** (the thing that sank Fornjot and slowed Zoo) | <ul><li>The verification machine comes first, as a staffed track with a compute line (B10): large-scale oracle differential testing (DeepCAD, Fusion 360 Gallery, ABC, our corpus, once licensed), fuzzing, invariants, and a failure zoo.</li><li>Definition-based oracles where OCCT is weakest: fillets, shells and offsets (A3).</li><li>Exact predicates and certified intersection.</li><li>Explainable failures, never silent.</li><li>Milestones ordered from winnable cases outward (analytic → B-spline → general NURBS).</li><li>Release gates measured against OCCT.</li><li>Many agent workstreams in parallel.</li></ul> |
| MVP is later than the OCCT path (~+3 months) | Agent, app and eval work proceeds in parallel against the `oracle/` backend and the growing Forge. Public alpha is gated on F2, not on a date. |
| Rivals ship first (Zoo and Adam ship agents today; CADZero works end to end; an OCCT-based rival with checks could cover most maker needs within weeks) | Publish our numbers first at open alpha; claim a lead only where a published head-to-head shows it |
| Topological naming instability | Native provenance plus queries and tags; a harness in Phase 0; never resolve silently; a repair UI |
| LLMs weaker at CadScript than build123d | Phase 0 bake-off; change the syntax, not the engine |
| Agent cost and latency | Tiered pipeline; deterministic checks before any LLM call; caching; economy mode; judge distillation |
| Eval capacity: plan time is shared with development, and a struggling task burns about 10 minutes | BACKLOG's wall-time cap first; weekly runs; funded eval keys from open alpha as a fallback (ADR 0020) |
| Thin physical proof: fits and strength vary by printer, material and slicer | The claim is "fits on your calibrated printer". The Fit Lab runs on the owner's own printer(s), and each result names its machines; laser and CNC tasks wait for machine access; strength badges only after break tests |
| Fit Lab capacity: one person printing 3–5 h/week on the owner's printer(s) can delay open alpha (A1) and beta. The head-to-head runs the Fit Lab on up to 5 rivals too, which multiplies the prints | Gated results need ≥100 prints each; the break tests add more. Track prints per week against the open-alpha and beta needs from the first run. If the rate falls short, the owner revisits the deferred hardware purchase (~$4–6k) |
| Dataset terms: ABC is under Onshape's terms, which may restrict competitive benchmarking | Record each licence before first use; make no parity claim without a licensed, named corpus |
| CAM can break tools and hurt people | Simulation and acknowledgment are mandatory; 2.5D on hobby routers first (ADR 0016) |
| WASM memory limits (no Memory64 on iOS) | Native napi and FFI paths; data-oriented memory; iPad through the native Swift host |
| Scope creep | Phase exit gates, group A vs group B, the list of explicitly reused components, skills instead of a plugin API |
| Provider drift | Per-model profiles plus a nightly cross-provider leaderboard; routing is config, not code |
