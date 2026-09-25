# Full modeling plan: PartZero as a complete part modeler, with the copilot on top

- **Status:** Plan, 2026-09-25. Revised the same day after a 46-point review (§6.5). Nothing in it is built.
- **Answers:** the owner's ask of 2026-09-25: "I want the full features build set, the app should be fully functional like any other 3d cad app."
- **For:** the owner (the first section), and the coding agents who build it (§1–§6).
- **Sources:**
  - Five read-only surveys made on 2026-09-25 for this plan (not checked in): the sketcher; manual feature tools and direct manipulation; the viewport and interaction; documents, files and I/O; part-modeling parity with Shapr3D, Fusion, Onshape and Plasticity. They read the main checkout, including Phase C's uncommitted work, and the `alpha0-preview` worktree.
  - A review of the first draft, made the same day. It checked the draft against the main checkout, the `alpha0-preview` branch, `docs/ALPHA-0-PREVIEW.md` (on that branch), [BACKLOG.md](BACKLOG.md), `forge/crates/forge-blend/src/lib.rs`, and this Mac's disk, memory and CPU.
  - [ROADMAP.md](ROADMAP.md), [NORTH-STAR.md](NORTH-STAR.md), [AGENT-IN-APP.md](AGENT-IN-APP.md), [ALPHA-0-PLAN.md](ALPHA-0-PLAN.md), [ARCHITECTURE.md](ARCHITECTURE.md), [IR-V1-IMPLEMENTATION-PLAN.md](IR-V1-IMPLEMENTATION-PLAN.md), [SPEC-v1-DRAFT.md](../forge/crates/forge-ir/SPEC-v1-DRAFT.md), and ADRs [0015](adr/0015-autonomy-dial.md), [0016](adr/0016-manufacturing-output-own-vs-hand-off.md), [0018](adr/0018-design-context-in-the-ir.md) and [0019](adr/0019-local-face-operations.md).
- **Relation to other plans:**
  - Builds FM1 and FM1.1 **are** Alpha 0 drops 0.1 and 0.2 ([ALPHA-0-PLAN.md](ALPHA-0-PLAN.md) §3.1). Their scope stays as that plan defines it, except that Report Issue (Alpha 0 W10) moves into 0.1.
  - Their dates move by about half a week, because the merge and the file splits come first (§4.2). INT amends ALPHA-0-PLAN §3.1 to match in FM-W0.
  - The manual-modeling program starts at FM2.

**How to read the tags**

| Tag | Meaning |
|---|---|
| **S / M / L** | Size in agent-days: S ≤ 1, M = 2–4, L = 5–10. Totals use S = 1, M = 3, L = 7.5. |
| **[PC]** | Needs Phase C committed: the IR v1 features and the command layer that are uncommitted in the main checkout today. |
| **[fmN]** | An assumption. §6.2 says how each one is checked and what happens if it's wrong. |
| **FDn** | FD1–FD3 are decisions for the owner. FD4–FD9 are engineering defaults he can veto (§6.3). |
| **FM1 … FM9** | Installable builds. FM1.1 is Alpha 0 drop 0.2. |
| **FM-W0 … FM-W9** | Waves. Wave FM-W*n* ends with build FM*n*. FM-W0 has no build. |
| **FG1, FG2a–c** | This plan's gates (§4.1). Alpha 0's gates keep their own names, G1–G3. |
| **NORTH-STAR B*n*, Alpha 0 W*n*, Phase C** | Rows and workstreams of those documents. They are always written with their prefix. |

---

## For the owner

**In plain words.** Today PartZero makes parts through chat. You describe a part, the agent builds it, Forge checks it, and you send it to Bambu Studio. What you can't do yet is model by hand, the way you would in Shapr3D or Fusion. The hard kernel work is mostly done. Once the current IR work (Phase C) is committed, Forge builds extrudes, revolves, holes, fillets, chamfers, shells, patterns, mirrors, booleans and datum planes, and its sketch solver handles 16 kinds of constraints. What's missing is the hands-on layer: a sketcher, tool panels, picking, drag handles, an editable history, measuring and STEP export. **Every button you press runs the same command the agent calls.** So the copilot can do anything you can do by hand, and everything either of you does undoes the same way.

- **Alpha 0 comes first** (FM1, FM1.1), with the scope that plan promised, about half a week later than it said.
- **Your first part made entirely by hand arrives in FM3,** about 10 weeks after Phase C is committed.
- **A complete single-part modeler (T0) arrives in FM6,** about 22 weeks after Phase C: around early March 2027 if Phase C commits in early October. The dates are each wave's critical path plus a 20% buffer [fm1].
- **What users expect within weeks of first use (T1)** comes in FM7–FM9: STEP and mesh import, DXF/SVG, splines, draft, text, then sweep and loft.
- Assemblies, drawings, sheet metal and CAM stay separate roadmap programs (§1.4). They are not dropped.
- **One honest caveat:** sweep, loft, variable fillets and "move any face" are kernel work that the roadmap schedules for F3, from about M8. FD2 asks whether to start them earlier.

| Build | What it unlocks for you | Weeks after Phase C | Agent-days |
|---|---|---|---|
| **FM1** = Alpha 0 drop 0.1 | As ALPHA-0-PLAN promises: agent-built v1 parts (holes, fillets, shells, patterns), five starters, the Parameters panel, Open in Bambu Studio. Plus **Help → Report Issue**. The final window layout. | ~2½ (Alpha 0 said ~2) | ~34 base + ~30 |
| **FM1.1** = Alpha 0 drop 0.2 | The Fit Lab, the material library and picker | ~3½ (Alpha 0 said ~3) | ~7 |
| **FM2** Editable history | <ul><li>Timeline: rename, delete, reorder, suppress, roll back.</li><li>Parameters: add, rename, delete. Every value in the model is in one list, with "promote to parameter".</li><li>All views, a basic view cube, "look at" a face, section from a face, trackpad navigation.</li><li>Click a face or edge to point the agent at it.</li><li>Saves that can't corrupt a file.</li></ul> | ~6 | ~92 |
| **FM3** First hand-made part | <ul><li>Sketch on a plane or a face: lines, rectangles, circles, dimensions anchored to the origin; blue (free), black (fixed), red (conflict).</li><li>Extrude and cut: a distance, or through all.</li><li>Fillet and chamfer picked edges with a handle that stops at the largest size that builds.</li><li>Selection filters, box select, a Browser panel (origin, sketches, bodies: show, hide, color).</li><li>Body colors reach Bambu Studio, for your AMS.</li><li>Broken references repaired with one click.</li></ul> | ~10 | ~108 |
| **FM4** Full sketcher and feature tools | <ul><li>Arcs, slots, polygons, all constraints, horizontal and vertical dimensions.</li><li>A face's edges usable in its sketch, so dimensions follow upstream changes.</li><li>Hole, pattern, mirror, shell, boolean, datum planes, revolve.</li><li>`.partzero` files with autosave and crash recovery; basic measuring.</li></ul> | ~14½ | ~101 |
| **FM5** Direct editing and printing | <ul><li>Push/pull faces. Move, copy and rotate bodies with a gizmo.</li><li>Lay a part flat on a face; split a body by a plane to fit the bed; overhang shading.</li><li>Extrude up to a face or two-sided; revolve about an edge.</li><li>Trim, extend, sketch fillet, offset, auto-constrain.</li><li>The full view cube, full measuring, STEP export. Fillets that run into holes.</li></ul> | ~19 | ~116 |
| **FM6** T0 complete | Wireframe, hidden-line and X-ray views. ⌘K on the canvas: a quick edit shown as a checked ghost you accept. Checkpoints. Exact distances. | ~22 | ~51 |
| **FM7** T1a: exchange | STEP import (view, measure, sketch on its flat faces, re-export); STL/3MF as reference meshes; DXF/SVG export, and DXF/SVG import into a sketch; reference images; several windows; inch holes and display; copy and paste features; Tab suggestions and the autonomy dial | ~27 | ~75 |
| **FM8** T1b: freeform sketch and more features | Splines, draft, text emboss and engrave, thicken, rib, patterns along a path, filleted features in patterns, fillets on crossing cylinders, wall-thickness and interference checks, configurations, the laser pack | ~33 | ~120 |
| **FM9** T1c: F3 kernel features | Sweep, loft, modelled threads, variable fillets, and moving, offsetting or deleting any face | Paced by F3 (M8–M14) unless FD2 says otherwise | ~100+ |

**What you do**

| When | What |
|---|---|
| Each build | Run `scripts/alpha0-mac.sh --install`, or ask a coding agent to. It keeps the previous build for `--rollback`. Then do the build's checklist in §4 (15–20 minutes) and note anything odd with **Help → Report Issue** or in a Claude Code session. |
| Between builds (optional) | INT tags a weekly nightly from the last green merge. Ask an agent to install it if you want to look early. Skipping it costs nothing. |
| Once, now | Decide FD1–FD3 (§6.3). The most urgent is **FD3: do you navigate with a mouse or the trackpad?** It shapes FM2's navigation. FD4–FD9 are defaults: veto any you disagree with. |
| FM1, FM1.1 | Alpha 0's first-week prints and the Fit Lab (Alpha 0 G3). |
| FM3 | 30 minutes: model one simple part of your own by hand. |
| FM6 | One hour: model 3–5 of your own parts by hand from blank, and say where it felt slower than Fusion or Shapr3D. |

---

## 1. What "fully functional" means

### 1.1 Status legend

The parity survey tiered what users expect:
- **T0:** without it, it isn't a CAD app.
- **T1:** expected within weeks of first use.
- **T2:** pro and advanced programs.

"Status now" means the main checkout with Phase C inside:

| Status | Meaning |
|---|---|
| **Have** | Works in the app today (dev build or the Alpha 0 preview). |
| **Phase C** | The kernel and IR support it once Phase C is committed [PC], but there is no manual UI for it. |
| **New** | Nothing exists yet: kernel, IR, UI, or all three. |

### 1.2 T0 checklist: the part modeler

| # | Item | Status now | What's missing | Build |
|---|---|---|---|---|
| 1 | Feature-level ops (insert, edit, delete, reorder a feature; a rollback marker), each with its inverse, under one rule for edits that make later features fail (§2.2) | New | Only `setParam`, renames, reference repairs and `upgradeFeature` exist (`packages/app/src/doc/v1/ops.ts`) | FM2 |
| 2 | Feature panel: typed values and expressions, live checked preview, OK/Cancel, double-click to re-edit | New | The tool framework (§2.5) | FM3 |
| 3 | Sketch mode: on an origin plane, a planar face or a datum plane; look-at; grid; finish/cancel; redefine the plane | Phase C (sketch on face and datum in the IR, SPEC §3.1) | A UI; the solver in WASM; the sketch overlay | FM3 |
| 4 | Sketch tools: chained line, 3-point and tangent arc, circle, rectangle, slot, polygon, point, construction | Phase C (IR and solver) | Every tool | FM3 (line, rectangle, circle, point), FM4 (the rest) |
| 5 | Constraints and dimensions, typed while drawing, DOF colors, conflicts; the sketch origin and axes as targets; horizontal and vertical distances | Phase C (16 constraints, DOF and minimal conflicts in `forge-solve`). IR sketches have no origin or axis entities, only `fix` with x/y (SPEC §4.1, §4.3) | Every UI piece; SPEC set A's implicit origin and axes; set C's H/V distances (§2.11) | FM3, FM4 (all constraints, H/V) |
| 6 | Snapping and inference while drawing; deterministic auto-constrain (NORTH-STAR B2) | New | A snap engine, inference lines, auto-constraints on commit | FM3 (basic snaps), FM4 (full inference), FM5 (auto-constrain) |
| 7 | Project/include model edges; trim, extend, offset, sketch fillet and chamfer, sketch mirror | New | A sketch curve kind bound to a `Ref`; 2D intersection and splitting | FM4 (edges parallel to the sketch plane, including a face's own boundary), FM5 (trim and the rest), FM6 (other edges) |
| 8 | Extrude UI (new, join, cut, intersect, symmetric) plus extents: through all, up to a face, two-sided, start offset | Have (distance, direction, op, targets; SPEC §6.2) | The UI; the extents (kernel, IR, oracle) | FM3 (UI, through all), FM5 (the other extents) |
| 9 | Revolve, boolean, shell, hole, pattern, mirror and datum tools | Phase C | The UIs; a revolve axis bound to a sketch line (set A), an edge or a datum axis (set D) | FM4, FM5 (edge and datum axes) |
| 10 | Fillet and chamfer on picked edges, with max-size feedback before and during the drag | Phase C (analytic edges; `forge-blend` computes feasible ranges after a failure) | The UI; `feasibleRange` at drag start | FM3 |
| 11 | Move, copy and rotate bodies (typed values and a gizmo); lay flat on a face | New | A `transform` feature type (IR, kernel, oracle), a triad gizmo | FM5 |
| 12 | Push/pull a face to drive its parameter (NORTH-STAR B1) | New | A face-to-field resolver, handles, a fast provisional preview, feasible intervals for extrude depth and hole size | FM5 |
| 13 | Timeline: reorder, rollback bar, rename, delete, edit, error badges, reference repair | Have (list and suppress, v0) | Everything else | FM2 (edit and repair: FM3) |
| 14 | Parameters table: named values and expressions, plus every model value with "promote to parameter" | Phase C (`setParam`) | The panel (a placeholder today, `ui/Timeline.tsx`) | FM1 (Alpha 0 W4e), FM2 |
| 15 | Selection: v1 faces and edges; box select; filters for vertex, edge, face and body; select-other | Have (hover and single click, v0) | v1 picking to provenance, multi-select, filters, box, vertex picking, select-other | FM2 (v1 picking), FM3, FM5 (select-other) |
| 16 | View cube, all views, normal-to, zoom to selection | Have (iso, top, front, right; fit; perspective/ortho) | Three more views, look-at, zoom to selection, the cube, free orbit | FM2 (cube: faces and Home), FM5 (edges, corners, animation) |
| 17 | Measure: distance, angle, length, radius, area, mass properties | New (the agent reads report-level numbers only) | Point-to-point and report values; per-entity measures; exact minimum distance | FM4, FM5, FM6 |
| 18 | Section view with a movable plane | Have (renderer: one plane with caps) | A command, a panel and a drag handle | FM2 (handle: FM3) |
| 19 | Browser: origin planes and axes, sketches, construction, bodies; show/hide, isolate, rename, color, pick | New | The panel; per-body draw flags in `forge-render`; origin planes drawn | FM3 |
| 20 | Right-click context menu; a contextual toolbar | New | Both, on the existing command registry | FM3 |
| 21 | STEP export | New (`forge-io/src/step.rs` is a placeholder) | Our own AP214 writer, with seams synthesized on export (ADR 0012) | FM5 |
| 22 | STL/3MF export, undo/redo, open/save, command search | Have | 3MF colors (FM3) | — |
| 23 | Native file with autosave and crash recovery | New (the app saves `.ts`/`.json` with a plain, non-atomic write) | Atomic save; `.partzero`, autosave, recovery | FM2 (atomic), FM4 |
| 24 | Display modes: shaded, with edges, wireframe, hidden-line, X-ray | Have (edge and silhouette toggles, not wired in the app) | Wiring; wireframe; hidden-line; transparency | FM2, FM6 |
| 25 | Overlapping sketch curves: draw freely, then pick regions | New (crossing curves fail today, `forge-ops/src/sketch/mod.rs`) | Region arrangement (kernel, sketch `v: 2`, FD6) | FM4, or FM5 if it slips |
| 26 | Agent and manual edits at the same time; the ADR 0015 commit check | New (BACKLOG P1: the agent doesn't pause when the user edits mid-run) | The concurrency rule (§2.3); the commit check | FM2 |
| 27 | Printing basics: split a body by a plane, lay flat (#11), overhang shading | New (bed fit exists at export) | A `split` feature; a shading mode | FM5 |

### 1.3 T1 checklist: expected within weeks

| Item | Status now | Build | Notes |
|---|---|---|---|
| STEP import | New (placeholder) | FM7 | **Promise:** view, measure analytic faces, sketch on planar faces, re-export. Vendor STEP is mostly B-spline faces, which mass properties and SSI don't support yet (BACKLOG P1/P2); they display and export but aren't measured or used in booleans until KRN-B lands. The ABC differential pass rate is reported as a measurement, not a gate. Kernel track from FM-W4 |
| STL/3MF/OBJ import as a reference mesh | New (readers exist, used in tests only) | FM7 | Not editable and not usable in booleans (§1.4) |
| Reference image with calibration (Fusion's Canvas) | New | FM7 | |
| DXF/SVG export of sketches and planar faces | New | FM7 | The first half of NORTH-STAR B9 |
| DXF/SVG import into a sketch | New | FM7 (lines, arcs, circles, polylines), FM8 (splines) | Laser and CNC files, vendor drawings |
| Several documents at once | New (one window) | FM7 | One window per document |
| Holes above M8; inch sizes; mm/inch display | Phase C (M2–M8) | FM7 | Two sources per value, as the v1 hole table has |
| Material and a mass readout | New | FM7 | ADR 0018's context block. Appearance moved to FM3 |
| Feature folders; copy/paste features; keymap customization and a cheat sheet | New | FM7 | |
| Tab (5 deterministic proposers) and the autonomy dial | New | FM7 | NORTH-STAR B3 and B5, ADR 0015. The commit check lands earlier, in FM2 |
| **Fillet coverage:** a blend that runs into a hole or boss (reported as `*_TOO_LARGE` today); full rounds; three-blend corners where one edge isn't a line between planes; two-blend corners of mixed convexity | Explicit failures in Phase C (`forge-blend/src/lib.rs`, "Not implemented") | FM5 | F2 kernel track **KRN-F2** from FM-W3. "Fillet the top edges after drilling the holes" hits the first gap; until it lands, the fillet tool offers "move this fillet before `hole2`" |
| Fillets on edges between crossing cylinders, ellipse and B-spline edges | Same | FM8 | Needs B-spline surfaces in `forge-ssi` (KRN-B). Still F2, not F3 |
| Fillet and chamfer features as pattern and mirror seeds | New (seeds must be extrude, revolve or hole: `PATTERN_SEED_UNSUPPORTED`, SPEC §6.10) | FM8 | Until then the pattern tool offers a body-seed pattern plus a join (FM4) |
| Sketch splines | New | FM8 | Needs KRN-B first |
| Draft | New (`draft` is refused at load, SPEC §6.9) | FM8 | Planar faces first |
| Text emboss and engrave | New | FM8 | Glyph outlines to splines; licence check for font parsing |
| Split face, thicken, rib | New | FM8 | Split body by plane is T0 (FM5) |
| Associative sketch offset, ellipse, sketch pattern | New | FM8 | |
| Patterns along a curve or driven by sketch points; face patterns | New | FM8 | |
| Per-face shell thickness | New | FM8 | |
| Wall-thickness and interference checks | New | FM8 | Row A2 in ROADMAP |
| Configurations or variants table | New | FM8 | |
| Laser pack: flat-part detection, kerf, nesting | New | FM8 | NORTH-STAR B9, Phase 1 beta |
| Sweep, loft, modelled threads | New (modelled threads landed early, 2026-09-25: exact helicoid threads on bores and bosses, `docs/fm/threads.md`) | FM9 | F3 / Phase 2 in the roadmap. FD2 proposes restricted forms earlier, including a helical sweep of a planar profile (printed threads and springs) |
| Variable fillets; setback and chord fillets | New (analytic edges only) | FM9 | F3 |
| Move, offset, replace and delete face (ADR 0019) | New | FM9 | F3. Push/pull falls back to these on faces no parameter drives |

### 1.4 T2 and what is not planned

T2 programs stay on [ROADMAP.md](ROADMAP.md). Each gets its own plan when its phase starts, and reuses this plan's frameworks: the command layer, selection, tools, manipulators and the sketcher.

| Program | Roadmap phase | Reuses |
|---|---|---|
| Assemblies, joints/mates, interference, BOM | Phase 2 (M10–M15) | Selection, manipulators (the triad), `forge-solve` |
| Local background agents, fab packet, resin checks | Phase 2 | Command layer, branches |
| Drawings: HLR views, auto-dimensions from parameters, sections, title block | Phase 3 (M14–M19) | Measuring, display modes |
| Sheet metal: flanges, bends, flat patterns to DXF | Phase 3 | Sketcher, DXF writer (FM7) |
| 2.5D CAM for hobby routers (`forge-cam`, ADR 0016) | Phase 3 | STEP and the part model |
| Web build, accounts, sharing, customizer pages | Phase 4 (M17–M22) | Everything (WASM-native) |
| SubD workspace, SDF bodies, FEA (`forge-sim`) | Phase 5 (M20–M26) | Tool framework, manipulators |
| Real-time collaboration, iPad, scan-to-CAD | Phase 6+ | — |

**Not planned:** editing an imported STL or 3MF as a solid (for example, remixing a Printables model). Meshes stay references that you model around (FM7). Converting a mesh to a B-rep would be its own program, next to scan-to-CAD.

### 1.5 The order

1. **T0 first, completely** (FM2–FM6). A T1 item starts before FM6 only as a **kernel track** off the UI critical path: the STEP writer, the fillet gaps (KRN-F2), region arrangement, B-spline groundwork (KRN-B) and STEP import. It then ships in its planned build.
2. **Then T1** (FM7–FM9). FM9 is paced by F3 unless the owner decides otherwise (FD2).
3. **T2** follows the roadmap phases above.
4. **The copilot grows with every wave.** Each wave ships agent tools for its new ops (§2.10). The commit check lands in FM2; ⌘K on the canvas, the ghost overlay and checkpoints in FM6; Tab and the autonomy dial in FM7.

### 1.6 Where this plan differs from the roadmap

| Item | Roadmap today | This plan | Needs |
|---|---|---|---|
| Sketch splines, draft, text emboss | Phase 1 ([ROADMAP](ROADMAP.md) "In scope"); F0/F2 kernel | FM8 (T1) | Nothing: same phase |
| STEP export and import | F1 kernel | FM5 (export), FM7 (import, narrowed) | Nothing |
| Fillet coverage gaps | F2 | FM5 (crossing cylinders: FM8) | Nothing |
| FDM checks and orientation (ROADMAP "Printing") | Phase 1 | Lay flat, split by plane and overhang shading in FM5; wall thickness in FM8; orientation suggestions stay on the roadmap | Nothing |
| Sweep, loft | Phase 2, F3 | FM9, F3-paced | FD2 for restricted forms earlier |
| Local face operations | F3 (ADR 0019) | FM9 | Same as above |
| NORTH-STAR B1 push/pull, B2 auto-constrain, B3/B4 ⌘K, ghost and checkpoints, B3/B5 Tab and the dial | Phase 1 alpha and beta | FM5, FM5, FM6, FM7 | Nothing: same phases, earlier within them |

Sweep, loft and face moves need F3's NURBS work (B-spline SSI, offsets, extension). This plan keeps the roadmap for them unless FD2 changes it.

---

## 2. Architecture

This section is the contract that every workstream builds against. The FM-W0 contracts (§3.4) turn it into code. ADR 0021, "Manual modeling architecture", records it; it is written in FM-W0, and ARCHITECTURE §2, §3 "Edits" and §7 are updated to match.

### 2.1 One command layer for UI, agent, CLI and MCP

**The rule.** Every manual tool is a front end that produces **domain ops**. The same ops are agent tools, MCP tools and `aicad op` CLI verbs. A tool never edits IR JSON directly and never calls an engine edit function itself.

**Today there are two paths that must become one:**
- **App commands.** The app's `CommandRegistry` (`packages/app/src/commands/registry.ts`) holds UI commands, including Phase C's `ir-commands.ts` (`ir.setParam` …) and `view.*`. Its v1 domain ops are the `IrOp` zod union in `packages/app/src/doc/v1/ops.ts`, applied by `IrDocStore` (`doc/v1/ir-doc-store.ts`) through the Rust engine in `forge-wasm/src/commands.rs`.
- **Agent edits.** The agent's v1 tools (`packages/agent-tools/src/v1/tools.ts`) have their own TS edit functions (`v1/edits.ts`) that "mirror" those ops. MCP tools are generated from the agent-tools registry (`packages/mcp-server/src/tools.ts`).

**Target layering**

```
UI gesture, keyboard, menu, palette ──► app command (CommandRegistry: tool.*, view.*, selection.*, feature.*)
                                              │
agent tool (agent-tools v1, generated) ───────┤
MCP tool (mcp-server, generated) ─────────────┼──► domain op(s)  ── @aicad/model-ops: zod schema, label, inverse
                                              │        │
                                              │        ▼
                                              │   IrDocStore transaction (one undo step, authorship, groups, failure rule)
                                              │        │
                                              │        ▼
                                              │   forge-commands (host-free Rust, verified by evaluation), via forge-wasm
CLI `aicad op` (forge-cli, native) ───────────┴──────────────────── the same crate, natively
```

**Rules**

1. **One definition per op.**
   - The zod schema lives in a new host-free package, `packages/model-ops` (`@aicad/model-ops`). `ops.ts` and `command-engine.ts` move there from `packages/app/src/doc/v1/`, and the app re-exports them.
   - The implementation lives once, in Rust, in a new host-free crate, **`forge/crates/forge-commands`**. Phase C's `forge-wasm/src/commands.rs` moves there in FM-W0 with the evaluation core it uses (`Rejection`, loading, `evaluate_through`, now in `engine.rs`). The reason: forge-cli doesn't depend on forge-wasm, and forge-wasm pulls in wasm-bindgen, web-sys and forge-render (wgpu). forge-wasm (`web/commands.rs`) and forge-cli (`ops.rs`) both bind to it.
   - A shared fixture set, `corpus/v1/ops/*.json` (op + input document → expected canonical document, or the refusal code), is checked by Rust, TS and the CLI. It keeps the Rust serde types and the zod schema in step.
2. **A tool commits one transaction** made of catalogue ops (§2.2).
3. **Every document op is an agent tool and an MCP tool**, generated from its schema. The only exceptions are host-only ops, listed in `model-ops/src/host-only.ts` and reviewed against ADR 0015. `setAuthor` and checkpoint restore are host-only. A snapshot test fails when a catalogue op has no generated agent tool and isn't on the host-only list.
4. **`agent-tools/src/v1/edits.ts` stops re-implementing ops.** The agent applies ops through its `EngineV1` (forge-web in Node), then splices the result into CadScript with `applyIrEditV1` as today. The agent keeps `apply_cadscript` for free-form code.
5. **UI-state commands** (`view.*`, `selection.*`, `measure.*`, `sketch.enter` …) stay app commands. Read-only ones are exposed to the agent: `selection.get`, `measure.*`, `view.snapshot`. The agent never moves the user's camera.
6. **Code edits are ops too.** A CadScript edit compiles, is diffed structurally against the IR by feature id, and is applied as ops (ARCHITECTURE §3 "Edits"). Phase C's splice (`packages/cadscript/src/v1/splice.ts`) already handles added, removed and moved features.

### 2.2 Op catalogue v2

Existing ops [PC]: `setParam`, `writeBackSolution`, `captureRef`, `acceptRefCandidate`, `acceptRefProposal`, `renameCurve`, `renameFeature`, `upgradeFeature`. The new ones:

| Op | Arguments | Semantic inverse | Verified by (refusal code) | Build |
|---|---|---|---|---|
| `addParam` | `name`, `unit`, `value` (literal or expression), optional bounds, optional `part` | `deleteParam` | Type check, no cycles, name grammar and reserved names (SPEC §2) | FM2 |
| `deleteParam` | `name`, `uses: "refuse" \| "inline"` | `addParam` + restore uses | Dependents listed in `details` (`COMMAND_PARAM_IN_USE`) | FM2 |
| `renameParam` | `old`, `new` | `renameParam` back | Every expression rewritten; the report is equal up to the rename | FM2 |
| `addFeature` | `part`, `after` (feature id, or null for first), `feature` (v1 JSON; the id is `<type><n>` unless given) | `deleteFeature` | Schema, then evaluation and the failure rule | FM2 |
| `setField` | `feature`, `path` (JSON pointer, also into a sketch's constraints), `value` (JSON, or `{ expr }`) | `setField` with the previous value | Schema, then evaluation and the failure rule | FM2 |
| `deleteFeature` | `feature`, `dependents: "refuse" \| "cascade" \| "keep"` | `addFeature`(s) restoring each | The dependency graph (`COMMAND_HAS_DEPENDENTS` lists them); `keep` falls under the failure rule | FM2 |
| `moveFeature` | `feature`, `after` | `moveFeature` back | Features reference only earlier ones (SPEC §7.1) (`COMMAND_ILLEGAL_ORDER`) | FM2 |
| `setSuppressed` | `feature`, `suppressed` | The opposite | Evaluation and the failure rule | FM2 |
| `setRef` | `feature`, `field`, `ref` | The previous ref | Resolves with its declared cardinality. Also "redefine sketch plane" (`field: "plane"`) | FM3 |
| `sketchEdit` | `sketch`, `edits[]`: `addCurve`, `removeCurve`, `setConstruction`, `addConstraint`, `removeConstraint`, `setDimension` (value or expression, driving or driven), `moveTo` (a drag's end), `setLabel` | The inverse edit list | Solve, then evaluation; write-back to its fixed point | FM3 |
| `convertSketch` | `sketch` (explicit → constrained: expand compounds; expression sizes become driving dimensions bound to the same parameters) | Recorded inverse | The report is equal before and after, up to the new constraint block | FM3 |
| `setAppearance` | body (origin key) or feature, color | The previous value | Geometry-free (FD4) | FM3 |

**The failure rule** (ADR 0021; C1). It applies to every transaction from any origin. SPEC §7.1 lets a failed feature pass its input through while later features still run, so an edit can quietly break the rest of the timeline. Phase C's `setParam` is a pure IR edit, and nothing checks it by evaluation (`commands.rs` header). The store therefore evaluates the candidate document before it commits:
1. **The edited thing must build.** A feature the transaction adds or edits that fails is refused with `COMMAND_FEATURE_FAILS` and its code, details and feasible range. For `setParam` and `renameParam`, the parameter must evaluate.
2. **Newly failing features need an acknowledgement.** Features that were ok before and fail after are "newly failing". The UI shows "N features will newly fail" with **Apply anyway** and **Cancel**. Apply anyway sends `ackNewFailures: [ids]`. A transaction whose newly failing set differs from its acknowledgement is refused with `COMMAND_NEW_FAILURES` (details: ids and codes).
3. **Agent and MCP transactions are proposals.** The proposal lists its newly failing features, and accepting it is the acknowledgement. The CLI needs `--ack`.

New **feature types and fields** (`transform`, extrude extents, revolve axes, projected sketch curves, `split`, `draft`, splines) are added through `addFeature` and `setField`. Each needs a SPEC amendment set (§2.11), the oracle and CadScript.

**Queries (no edits)** go on the engine, and are exposed as read-only agent tools:

| Query | Returns | Build |
|---|---|---|
| `dependents(feature)` | Features that reference it by id, queries naming its provenance keys, parameter uses | FM2 |
| `evaluateThrough(feature)` | The report and bodies of the document cut at `feature` (rollback marker, edit-in-place) | FM2 |
| `feasibleRange(feature, field)` | The interval of a numeric field that builds with the rest of the document fixed. Bisection with certified checks, as `max_feasible_r` (SPEC §6.6), cached per document revision. Called **at drag start**, so a handle knows its limits before it moves; budget from FM-W0's spike [fm13] | FM2 (fillet `r`, chamfer `d`, shell `thickness`), FM5 (extrude distance, hole size) |
| `refFor({ at, picks[], card })` | A v1 `Ref` (a query synthesized from the picks with `synthesize_query`, plus a capture), verified to resolve to **exactly** the picked set at `at`. Otherwise `COMMAND_REF_NOT_EXACT` with the nearest candidates. Sets use a union or group query | FM3 |
| `measure(entities)` | Length, area, radius, angle, distance, with the formula used | FM4, FM5 |
| `faceDriver(key)` (TS, in `model-ops`) | The field or parameter that positions a face, or none (§2.6) | FM5 |

**Command errors** follow Phase C's pattern (`commands.rs` header): a `COMMAND_*` code, a message, and structured `details` (ids, feasible ranges, dependents). Ids that fail the id grammar are never echoed. Every new code gets a playbook entry (§5.5).

### 2.3 Transactions, undo, authorship and concurrency

- **One undo stack.** Alpha 0 W4c (OPS-1 in FM-W1) retires the v0 source stack. UI ops, code edits and accepted agent proposals all go on `IrDocStore`'s history, which records the exact inverse of every transaction (byte-exact on canonical IR).
- **Groups.** For sketch mode and multi-step tools, `IrDocStore` gains `openGroup({ label, origin })`:
  - While the group is open, each op is its own undo step (a local stack).
  - `seal()` collapses the group into **one** step on the main stack, for example "Edit sketch `outline`".
  - `abort()` restores the document from before the group.
  - Groups don't nest.
- **Previews never commit.** `store.preview(ops)` evaluates the candidate document in the engine worker at preview priority, and returns its report, bodies and newly failing features. A newer preview cancels an older one.
- **Drags never commit per frame.** Provisional frames don't touch the store (§2.6). Releasing the drag commits one transaction.
- **The rollback marker** is view state held by the store (`IrDocStore.marker`, C6). HIST writes it; VIEW, SKUI, DOC and the tools read it. New features go after it.
- **Authorship (ADR 0015).**
  - Every transaction carries an `origin`: `user`, `agent`, `mcp:<client>`, `cli` or `system`.
  - The host stamps each feature's `author` field. A user op makes the features it adds or edits the user's. Agent ops leave new features agent-authored. `author` is host-only: agent and MCP ops that try to set it are refused.
  - **The commit check lands in FM2 (OPS-2),** before hand-made features exist. An agent, MCP or CLI transaction that changes a user-authored feature or parameter without a matching approval is refused with `unapproved_user_change` (ADR 0015). Your own edits skip it. This makes NORTH-STAR §7's "silent changes to user features: 0" enforced, not just a policy. The dial itself comes in FM7.
- **Agent runs and manual edits at the same time** (ADR 0021). Today the agent doesn't pause when you edit mid-run; conflicts appear only at accept (BACKLOG P1). The rule:
  - A user commit during a run marks the run's base stale.
  - At its next step the agent rebases: it re-reads the document and replays its pending ops. If one of them touches a feature or parameter the user's commit changed, the agent pauses and asks.
  - An agent proposal accepted while a group is open waits until the group closes, then rebases the same way.
  - Agent features go after the rollback marker, like the user's. When the marker isn't at the end, the proposal says "inserted at the rollback bar, before N later features", and the failure rule covers those later features.

### 2.4 Selection model

Selection is app state, never IR. It is converted to references only when a tool commits (through `refFor`).

```ts
// packages/model-ops/src/selection.ts (owned by SEL; the agent's selection chips use the same type)
type SelectionItem =
  | { kind: "face" | "edge" | "vertex"; part: string; key: string; probe: Probe; point?: Vec3 }
  | { kind: "body"; part: string; body: string }                 // origin key: "F/body:m" or "F/body:m@i" (SPEC §5.2 rule 4)
  | { kind: "feature" | "datum" | "origin"; feature: string }     // feature id, or "XY" | "XZ" | "YZ" | "X" | "Y" | "Z"
  | { kind: "sketchCurve" | "sketchPoint"; sketch: string; id: string; sub?: "start" | "end" | "center" | "mid" }
  | { kind: "constraint" | "dimension"; sketch: string; index: number }
  | { kind: "region"; sketch: string; curves: string[] }
  | { kind: "param"; name: string };

interface SelectionState {
  items: SelectionItem[];     // ordered: the first item is the "primary"
  filter: KindMask;           // keys 1–4: vertex, edge, face, body; plus feature and sketch masks
  hover: SelectionItem | null;
  revision: number;
}
```

- **Model entities are held as provenance key plus probe**, so split pieces stay distinct (SPEC §5.2, §7.6). After every evaluation, items are re-resolved by key and probe, and items that vanished are dropped with a quiet notice.
- **Body identity is the SPEC §5.2 origin:** the creating feature's id plus the member, plus the instance for body-seed patterns (`F/body:m@i`). "Feature id" alone is ambiguous: an extrude makes one body per region, and a body-seed pattern makes several. Today body names come from feature names (`forge-wasm/src/engine.rs`), so renaming a feature drops highlights; ENG-0 fixes that.
- **Selection commands:** `selection.set`, `add`, `toggle`, `remove`, `clear`, `setFilter`, `box { rect, mode: window | crossing }`, `chain` (tangent chain), `selectOther` (cycles through the entities under the cursor).
- **The agent gets the same items as plural selection chips.** `packages/app/src/agent/selection.ts` handles one face or edge today; SEL owns it from FM-W0.
- **Selection first (Shapr3D).** The contextual toolbar and right-click menu show only the tools whose `accepts` matches the selection (§2.5).

### 2.5 Tool and panel framework

```ts
// packages/app/src/tools/framework/types.ts
interface ToolSpec<I> {
  id: string; title: string; icon: IconName;
  group: "sketch" | "create" | "modify" | "construct" | "pattern" | "inspect" | "print";
  keys?: string[];
  flag?: string;                       // build flag (§3.5); off = hidden in the owner's build
  accepts?: SelectionKind[][];         // selection-first: the tool is offered when the selection matches
  inputs: ToolInputs<I>;               // zod (from the generated v1 schemas) + UI hints
  init(ctx: ToolContext, sel: SelectionItem[]): I;   // prefill from the selection
  toOps(i: I, ctx: ToolContext): IrOp[] | Promise<IrOp[]>;   // the ONLY way a tool changes the document
  handles?(i: I, view: ViewInfo): HandleSpec[];      // manipulators bound to input fields
  fromFeature?(feature: Feature): I;   // re-edit an existing feature (timeline double-click)
}

type ToolState = "collecting" | "previewing" | "invalid" | "committing";
interface ToolSession<I> {
  inputs: I; state: ToolState; preview: PreviewResult | null; errors: FieldError[];
  set(path: string, value: unknown): void;
  commit(): Promise<CommandResult<unknown>>;   // one transaction, under the failure rule
  apply(): Promise<CommandResult<unknown>>;    // commit and keep the panel open
  cancel(): void;
}
```

- **Panels are generated** from the v1 zod schemas (`packages/ir-types/src/generated/ir-v1.ts`, e.g. `FilletFeatureSchema`), with per-field widget overrides:
  - a selection field bound to the selection;
  - an expression field with unit checking that accepts `12`, `wall*2` or a new parameter name;
  - enums as segmented controls; booleans as switches.
- **Errors map to fields.** The report's error path maps to the panel field. Feasible ranges show as hints under the field and as clamps on the handle.
- **Keys.** Enter = OK, Esc = Cancel (C10's Esc layering), Tab = next field. OK is one transaction; Cancel leaves nothing behind.
- **Edit feature.** Double-click in the timeline, or `feature.edit { feature }`:
  1. the view rolls back to just before the feature (`evaluateThrough`);
  2. the panel opens with `fromFeature`;
  3. OK commits `setField` ops as one transaction, and the rollback marker returns to where it was.
- **Layout.** The final layout lands in FM-W0 (TOOL-0), so FM1 already has it and later builds only add tabs. Panel registry: `packages/app/src/ui/shell/panels.ts`.

  | Where | What |
  |---|---|
  | Left | Tabs: Timeline, Browser, Parameters |
  | Centre | The viewport. The feature panel floats at its top left (as in Fusion and Shapr3D), the view cube at its top right, and the contextual toolbar near the selection |
  | Right | Tabs: Code, Proposal, Chat |
  | Bottom | Problems |
  | Top | Toolbar tabs: Sketch, Solid, Construct, Inspect, Print |

- **⌘K is decided now** (ADR 0021; FD9). `commands.ts:567` binds Mod+K and Mod+Shift+P to the palette today. Until FM6, ⌘K opens the palette. From FM6, ⌘K opens the AI quick edit when the canvas has a selection, and the palette otherwise. ⌘⇧P always opens the palette. AGENT-IN-APP's open question is closed by the ADR.
- **Default keys.** From the parity survey. They depend on context, and users can remap them in FM7.

  | Context | Keys |
  |---|---|
  | Sketch | L line, C circle, R rectangle, A arc, D dimension, T trim, O offset, X construction |
  | Model | E extrude, Q push/pull, Shift+F fillet (F stays "fit"), H hole, M move, I measure |
  | Anywhere | S context tools, Space repeat last, 1–4 selection filters, Shift+1…7 views, N normal-to, Esc (C10). Tab is reserved for Tab suggestions (FM7) outside panels |

### 2.6 Manipulators

- **Handle types:**
  - a linear arrow (distance, depth, thickness, offset);
  - a radius knob (fillet, hole size);
  - an angle arc (revolve, draft, datum angle);
  - a translate/rotate triad (transform, FM5);
  - a plane handle (section, datum offset).
- **Rendering.** A DOM/SVG overlay drawn from camera matrices that `forge-render` exports (`camera.rs` view-projection and `ray()`). GPU-drawn handles with occlusion come later and block nothing. The GPU `handle` pick kind is reserved in the re-encoded ID buffer (C4).
- **Each handle binds to one input field**, and so to `setField` on commit, or to `setParam` when the field is a bare parameter. When the field is a derived expression, the drag is refused with an offer to edit its base parameter. `param-uses.ts` (moved to `model-ops` in FM-W0) knows which features a parameter drives.
- **Drag math.** The cursor ray is projected onto the handle's axis or plane. Snapping goes to increments (1 mm, 0.5 mm with Shift, 15°) and to model points. Tab during a drag opens a typed value.
- **Limits before the drag.** At drag start the handle calls `feasibleRange(feature, field)` and clamps to it, saying why it stopped ("max 3.41 mm: the wall would vanish"). If the range isn't back within the budget [fm13], the handle starts unclamped and clamps when it arrives.
- **Push/pull (FM5)** is the manipulator applied to a picked face through `faceDriver`:

  | Face | Field it drives |
  |---|---|
  | Extrude end or start cap | `distance`, with its sign |
  | Extrude side face | The sketch dimension on that curve, when there is one |
  | Revolve end cap | `angle` |
  | Hole wall | The next or previous standard `size`, stepping through the size table. `d` only for a hole that already has a custom `d`, because writing `d` overrides the standard size (SPEC §6.5) |
  | Shell face | `thickness` |
  | Fillet face | `r` |
  | Chamfer face | `d` |
  | Pattern instance | `spacing` |

  - A planar face with no driver gets a new sketch on that face plus an extrude (join or cut), as Shapr3D does. Its outline uses the face's projected edges (FM4), so it stays associative.
  - Faces nothing drives, and imported faces, fall back to ADR 0019's face ops in FM9.
- **Provisional frames** (≤16 ms p95):
  - cap drags translate the cap's vertices in the render mesh (no Forge call);
  - other drags use the regen prefix cache (FM5, §2.8) and are drawn in the provisional style.
  - On release, Forge builds and checks the value in ≤150 ms. On failure the handle snaps back to the feasible limit.

### 2.7 Sketch mode

**Lifecycle**

1. **Enter.**
   - For a new sketch, pick an origin plane, a planar face or a datum, in the viewport or the Browser. `sketch.new` opens a group and adds the sketch feature (a `{ face: Ref }` plane from `refFor`).
   - To edit a sketch, double-click it in the timeline. The model is evaluated through the previous feature, and later features are hidden.
   - **Redefine plane** (`setRef` on `plane`) moves a sketch to another face or plane. It is the standard fix when an upstream change removes the face a sketch sits on.
   - The camera turns to look at the sketch plane, with roll for face frames.
2. **Session.** A WASM `SketchSession` (C5) loads the IR sketch through `forge-sketch` (weld, lower) and runs `forge-solve` for:
   - tentative edits, which are solved but not committed;
   - drags (≤4 ms per solve; spike 04 measured 1.75 ms worst case at 200 entities);
   - per-entity DOF, free directions, constraint states, minimal conflicts and suggested removals.

   It runs in the **main-thread WASM instance** that the renderer already uses, so a drag never waits behind a regeneration in the worker [fm4].
3. **What a sketch can anchor to** (SPEC set A, set C):
   - **The origin and axes.** Every sketch has an implicit fixed `origin` point and `u_axis`/`v_axis` construction lines. Snapping to them writes `coincident` with the origin or `point_on_line` with an axis. So a rectangle drawn from the origin with two typed sizes is fully constrained (black).
   - **A face's edges (FM4).** When sketching on a face, its boundary edges, and model edges parallel to the sketch plane, are offered as snap and dimension targets. Using one adds a projected curve bound to a `Ref` (set C). So a slot dimensioned 8 mm from an edge follows an upstream width change. Before FM4, a face sketch can anchor only to its frame origin, which is the world origin projected onto the face (SPEC §3.1), and the dimension tool says so. Other edges are projected in FM6.
4. **Gestures.**
   - A draw tool's rubber band comes from the session.
   - The snap and inference engine is TS, for latency. It snaps to endpoints, midpoints, centres, quadrants, nearest points on curves, intersections, the origin and axes, face edges (FM4) and the grid. It shows H/V, parallel, perpendicular and tangent hints.
   - On mouse-up, the gesture becomes **one** `sketchEdit` op inside the group. Snaps become auto-constraints (coincident, on-curve, midpoint, H/V, tangent, perpendicular, parallel). Alt suppresses them. Committed geometry always goes through the solver, so determinism holds.
5. **The IR stays the truth.** After each committed op the session re-syncs from the document (hash check). The session is a cache.
6. **Display.**
   - Curves, points, dashed construction, DOF colors, conflicts in red and failed geometry greyed out (SPEC §4.4 rule 6) are drawn in an **SVG overlay** (SKUI) from the camera matrices, like the handles, with the constraint glyphs and dimension text. Drawing them in `forge-render` is optional later.
   - A dimension label position is stored in a geometry-free IR field that the oracle ignores (set A).
7. **Dimensions.**
   - The type is inferred from the pick and the cursor position: aligned, or (from FM4, set C) horizontal or vertical, which is Fusion's default linear dimension.
   - A value typed while drawing becomes a driving dimension.
   - A value typed as a new name (`width = 40`) becomes a parameter (NORTH-STAR "typed dimensions become parameters").
   - An over-constraining dimension is solved first, and the user is offered "make driven?".
8. **Finish** seals the group and runs the write-back. **Cancel** aborts the group.

**Revolve axes.** The revolve tool picks a sketch line and stores `axis: { "curve": "<line id>" }` (set A), so editing the line moves the axis. SPEC §6.3 stores the axis as literal sketch coordinates today, which a later line edit would leave behind. Edges and datum axes (`AxisRef`) follow in FM5 (set D).

**Parametric intent.** The agent writes compound curves with expression sizes (`rect({ w: width })`). A constrained sketch can't hold compound curves (SPEC §4.2), so the first manual constraint on such a sketch runs `convertSketch`. That turns expression sizes into driving dimensions bound to the **same** parameters, so the agent's parameters keep driving the geometry.

### 2.8 Preview, regeneration and the performance path

- **One engine worker with a priority queue:** commit > preview > background checks. A newer preview cancels older ones. If measurement shows previews delaying commits, a second worker for previews is the fallback (COOP/COEP are already set, so SharedArrayBuffer is available).
- **Prefix cache in `forge-regen` (FM5, ENG).** It follows ARCHITECTURE §3 "Caching":
  - chained keys per feature, `k_i = H(k_{i-1}, type, v, evaluated fields, resolved refs, forgeBuild)`;
  - body states in an in-memory LRU.

  Today there is no cache. An edit reaches the screen in 46.9 ms median on a 25-feature part (spike 05), and a boolean costs about 20 ms (spike 03). Larger parts need the cache to stay under 150 ms.
- **Instrumentation.** `performance.mark` names are fixed in C7, so e2e perf tests measure the same span everywhere: `pz:input` at the input event, `pz:commit`, `pz:report`, and `pz:frame` at the first presented frame with the new bodies.

### 2.9 Documents

- **Saves (FM2):** temp file, fsync, rename, one `.bak`.
- **Native `.partzero` file (FM4).** A zip written deterministically by `forge-io`'s own zip writer:

  | Entry | What it holds |
  |---|---|
  | `manifest.json` | Format version, app and Forge build, IR schema, units, SHA-256 of each entry. Also **view state that is not IR:** the rollback marker, visibility, camera and named views |
  | `document.json` | Canonical IR v1, the only normative content |
  | `cadscript/main.cad.ts` | The code view, kept for its comments. On load it must compile to `document.json`; if it doesn't, the printer regenerates it and the user is warned |
  | `annotations/authorship.json` | Authorship marks |
  | `blobs/` | Imports, from FM7 |
  | `cache/<forgeBuild>/` | Meshes and a thumbnail. B-rep later, once B-rep serde exists (BACKLOG P1) |
  | `checkpoints/` | FD5 |

  Plain `.json` stays the export for git and agents.
- **The rollback marker is view state.** Evaluation stays a pure function of the IR (SPEC §0.6).
- **Autosave (FM4):** snapshots into `userData/Recovery/`, a marker for unclean shutdown, and a restore dialog at launch.
- **Several windows:** FM7.

### 2.10 What the agent, CLI and MCP get in every wave

| Surface | Gets |
|---|---|
| In-app agent | Every catalogue op as a tool (generated), the read-only queries, plural selection chips, and playbooks for every new `COMMAND_*` and IR code. Its edits land as proposals under the failure rule and the commit check; today that means per-feature accept |
| MCP (external agents) | The same op tools, scoped; always on the `mcp/<client>` branch; never auto-applied (ADR 0015) |
| CLI | `aicad op <doc> '<op json>' [--ack <ids>]`, which prints the new canonical document and report. `aicad op replay <doc> <transcript.jsonl>` replays a UI session. This is the harness for §5.3 |

### 2.11 IR amendment sets

Every IR change is one amendment set. Each set touches forge-ir (`validate.rs`, 2,987 lines, and the 122 KB `ir-v1.schema.json`), the generated `ir-types`, regen dispatch, the oracle's shared modules (validate, replay, generator, genops, constraints) and CadScript (`compile.ts` 99 KB, `validate.ts` 97 KB, `print.ts`). So every wave that implements a set has **SPEC-n** and **CS-n** rows (§4). A set is drafted in the wave before and frozen by day 3 of the wave that implements it. INT regenerates the generated files after the merge; they are never merged by hand.

| Set | Frozen by | Implemented in | Contents |
|---|---|---|---|
| **A** | FM-W0 | FM-W2 | Dimension label position (geometry-free); sketch frame and per-entity DOF in the report; **implicit sketch entities** `origin` (a fixed point at the frame origin), `u_axis` and `v_axis` (fixed construction lines), usable as constraint arguments, with spellings SPEC-0 chooses so they can't collide with existing ids (§0.3, §9.3); revolve `axis: { "curve": "<line id>" }` |
| **B** | FM-W3 day 3 | FM-W3 | Extrude `through_all` (length from the targets' extent, as hole `through` does); appearance (FD4) |
| **C** | FM-W4 day 3 | FM-W4 | Horizontal and vertical point-to-point distance; H/V between points; projected sketch curves bound to a `Ref` (edges parallel to the sketch plane); sketch `v: 2` regions (FD6; may slip to D) |
| **D** | FM-W5 day 3 | FM-W5 | `transform` (FD7); extents: up to a face, two-sided asymmetric, start offset; revolve `AxisRef`; `split` by a plane; constraint batch 2 (symmetric about a point, arc length, point on a segment, line–line distance) |
| **E** | FM-W6 day 3 | FM-W6 | Projection of edges not parallel to the sketch plane |
| Later | — | FM7–FM9 | `import` revision and `blobs`; splines, ellipses, draft, text, fillet seeds in patterns, … |

---

## 3. Workstreams, file ownership and contracts

### 3.1 Rules for parallel worktrees

1. **One workstream, one worktree, one branch.** For example, `.claude/worktrees/fm-w3-feat` on branch `fm/w3-feat`. Rebase on `main` after each merge window.
2. **A workstream writes only the paths it owns** (§3.2). It may **append one line** to a registration point (§3.3), even in a file another workstream owns. Anything else is a request to the owner, filed in the wave's coordination note (`docs/fm/wN.md`, INT).
3. **Serialized paths.** Only INT touches lockfiles, dependency lists, CI, the release scripts and generated files. Only SPEC touches the IR contract. A new dependency is a request to INT, with a licence check (CLAUDE.md principle 5).
4. **Rust verification ships with the op.** Every new kernel op arrives in the same branch with unit tests, property tests, invariant checks and an oracle case (CLAUDE.md principle 4). INT refuses a merge without them.
5. **Git rule.** Only the owner's own agents contribute (CLAUDE.md "Git"; ADR 0001). No code comes from outside pull requests.
6. **Machine capacity [fm12].** This Mac has an M4 Pro (14 cores), 48 GB of memory, and 54 GiB free of 460 GiB (88% used, 2026-09-25). `forge/target` in the main checkout is 19 GB, so 8–10 worktrees each running `cargo test`, clippy and wasm builds would need roughly 100–190 GB. Therefore:
   - **At most 3 worktrees build Rust at once,** INT's included.
   - **TS-only worktrees don't run cargo.** `scripts/fm/worktree.sh` links the `forge-web` build from INT's last merge.
   - **sccache** shares compiled crates between worktrees. A shared `CARGO_TARGET_DIR` is not used: cargo locks it, so parallel builds would serialize.
   - A worktree's `target/` is deleted when its branch merges. A new Rust worktree is refused below 40 GB free.
   - **Kernel tracks with no UI** (KRN-F2, KRN-B, IO-K, IO-7a) run in cloud sessions when the local slots are taken.
   - Performance budgets are measured only on a quiet machine (§5.6).
7. **Contracts one wave ahead.** A contract or amendment set is frozen before the wave that builds on it (§2.11, §3.4), never all at once in FM-W0.
8. **About 10% of every wave is FIX:** the owner's notes on the previous build, fixed by an extra agent working in the owning workstream's files, with that owner's review.

### 3.2 Workstreams and what they own

Workstream ids stay the same across waves. Each file has exactly one owner. Where a directory has an exception, the exception is named.

| Id | Workstream | Owns (writes) |
|---|---|---|
| **INT** | Integration and release | `pnpm-lock.yaml`, `forge/Cargo.lock`, the dependency lists in every `package.json` and `Cargo.toml`, `forge/Cargo.toml` members, `.github/**`, `scripts/alpha0-mac.sh`, `scripts/fm/**`, `packages/desktop/electron-builder*.cjs`, `docs/fm/**`, the ALPHA-0-PLAN §3.1 amendment, `packages/app/src/flags.ts`, `corpus/fullmodel/manifest.json`, every generated file after a merge (`packages/ir-types/src/generated/**`, `packages/forge-web/pkg`), and conflict resolution on registration points (§3.3) |
| **SPEC** | The IR slice: spec, contract and oracle core | `forge/crates/forge-ir/**`, `SPEC-v1-DRAFT.md`, `corpus/v1/conformance/**`, `corpus/v1/ops/**`, the oracle's shared modules `oracle/src/aicad_oracle/v1/{validate,replay,generator,genops,constraints,evaluate,consts,expr,query,compare,normalize,load,ids}.py`, `docs/adr/0021-*`, and the ARCHITECTURE and AGENT-IN-APP sections ADR 0021 changes |
| **OPS** | Command layer and document store | `packages/model-ops/**` (new) except `src/selection.ts` (SEL) and `src/face-driver.ts` (TOOL); `forge/crates/forge-commands/**` (new) except `src/queries/measure.rs` (SEL); `forge/crates/forge-wasm/src/web/commands.rs`; `forge/crates/forge-cli/src/ops.rs`, `tests/cli_ops.rs`; `packages/app/src/doc/**`; `packages/app/src/commands/ir-commands.ts` |
| **ENG** | Engine core | `forge/crates/forge-regen/src/{lib.rs,v1/mod.rs,v1/part.rs,v1/deps.rs,v1/bodies.rs,v1/error.rs,v1/features.rs,v1/feasible.rs}`; `forge/crates/forge-wasm/src/{lib,engine}.rs`, `web/{mod,engine}.rs`; `packages/forge-web/src/{engine,index,worker,evaluator}.ts`, `types/engine.ts`; from FM-W2, APPV1's `packages/app/src/{services,bootstrap,worker-rpc}.ts` and `engine/**` |
| **APPV1** | IR v1 in the app (FM-W1 only) | `packages/app/src/{services,bootstrap,worker-rpc}.ts`, `packages/app/src/engine/**`, `packages/app/src/ui/problems/**`, `ui/CodeEditor.tsx`, `packages/desktop/src/agent/{runner,engine}.ts`, and AG's files that Alpha 0 W4 names (AG starts in FM-W2). Afterwards its files pass to ENG, HIST and AG |
| **A0** | Alpha 0 items outside W4 | As listed per workstream in [ALPHA-0-PLAN.md](ALPHA-0-PLAN.md) §3.2 (W0, W2, W3, W5, W6, W7, W8, W9, W10), less the files named here for other owners |
| **DOC** | Documents and files | `packages/app/src/file/**` (new), `packages/app/src/commands/file.ts`, `packages/desktop/src/{files,recovery,window-state}.ts`, `packages/desktop/src/ipc/files.ts` |
| **HIST** | Timeline, parameters, problems | `packages/app/src/ui/timeline/**` (with the model moved from `doc/timeline.ts`), `ui/parameters/**`, `ui/problems/**` from FM-W2, `commands/timeline.ts` |
| **VIEW** | Renderer and viewport | `forge/crates/forge-render/**`, `forge/crates/forge-mesh/src/mesh.rs` (vertex data), `forge/crates/forge-wasm/src/web/viewport.rs`, `packages/forge-web/src/{viewport.ts,types/viewport.ts}`, `packages/app/src/viewport/**`, `ui/Viewport.tsx`, `commands/view.ts` |
| **SEL** | Selection, Browser and measuring | `packages/app/src/selection/**` (with `provenance.ts` moved from `doc/`), `measure/**`, `ui/inspect/**`, `ui/browser/**`, `packages/app/src/agent/selection.ts`, `packages/model-ops/src/selection.ts`, `commands/{selection,measure}.ts`, `forge/crates/forge-check/src/{measure,distance}.rs` (new), `forge/crates/forge-commands/src/queries/measure.rs` |
| **TOOL** | Tool framework, input and shell | `packages/app/src/tools/{framework,registry.ts}`, `manipulators/**`, `input/**` (C10), `ui/shell/**`, `ui/styles/{tokens,shell}.css`, `ui/{keyboard.ts,CommandPalette.tsx}`, `commands/tool.ts`, `packages/model-ops/src/face-driver.ts` |
| **FEAT** | Feature tools (one agent per tool directory) | `packages/app/src/tools/features/<tool>/**` |
| **SKUI** | Sketcher UI | `packages/app/src/sketch/**`, `tools/sketch/**`, `ui/sketch/**`, `commands/sketch.ts` |
| **SKK** | Sketch kernel | `forge/crates/forge-solve/**`, `forge/crates/forge-sketch/**`, `forge/crates/forge-ops/src/sketch/**`, `forge/crates/forge-wasm/src/{sketch_session.rs,web/sketch.rs}`, `packages/forge-web/src/{sketch.ts,types/sketch.ts}` |
| **KRN** | Kernel features (one agent per op) | `forge/crates/forge-ops/src/<op>/**`, `forge/crates/forge-regen/src/v1/<op>.rs`, `oracle/src/aicad_oracle/v1/<op>.py`, their tests and `corpus/v1/programs/<op>_*.json`. KRN-F2 owns `forge/crates/forge-blend/**`; KRN-B owns `forge/crates/forge-ssi/**` and `forge-check/**` except SEL's files |
| **IO** | Import and export | `forge/crates/forge-io/**`, `forge/crates/forge-wasm/src/web/io.rs`, `packages/app/src/commands/{export,import}.ts` |
| **CS** | CadScript | `packages/cadscript/**` |
| **AG** | Agent and MCP | `packages/agent-tools/**`, `packages/agent/**`, `packages/mcp-server/**`, `skills/**`, `packages/app/src/agent/**` except `selection.ts`, `ui/{ChatPanel,ProposalView}.tsx`, and from FM-W2 `packages/desktop/src/agent/**` |
| **QA** | Acceptance, evals, performance | `packages/desktop/e2e/{modeling,perf}/**`, `packages/app/src/test-hooks/**`, `scripts/fullmodel-accept.sh`, `corpus/fullmodel/**` except the manifest, `packages/evals/**`, additions to `corpus/makerbench/**` |

`packages/app/src/ui/styles.css` is split in FM-W0 into `ui/styles/<area>.css`, one per owner, plus `tokens.css` and `shell.css` (TOOL).

### 3.3 Hot files and registration points

FM-W0 (INT-0b) splits each hot file without changing behaviour, so parallel work only **appends** one line to a small index file. INT resolves those one-line conflicts at merge.

| Today | Split into | What a workstream appends |
|---|---|---|
| `packages/app/src/commands/commands.ts` (922 lines) | `commands/{file,edit,view,selection,model,agent,settings,print,tool,timeline,sketch,measure,export,import}.ts` + `commands/index.ts`; Phase C's `ir-commands.ts` stays | One import line |
| `forge/crates/forge-wasm/src/commands.rs` (2,447 lines, Phase C) | `forge/crates/forge-commands/src/{lib,params,features,refs,rename,upgrade,sketch}.rs` + `queries/*.rs`; forge-wasm keeps a thin `web/commands.rs` | `mod x;` + one dispatch arm |
| `forge/crates/forge-wasm/src/web.rs` (1,371 lines) | `web/{mod,engine,viewport,commands,io,sketch}.rs` | One `mod` line |
| `forge/crates/forge-cli/src/main.rs` subcommand enum | Stays; the `op` verbs live in `ops.rs` | One enum variant + one match arm |
| `packages/forge-web/src/types.ts` | `types/{engine,viewport,sketch}.ts`; `types.ts` re-exports | One export line |
| `packages/app/src/ui/App.tsx` layout | `ui/shell/App.tsx` + the panel registry `ui/shell/panels.ts` | One panel entry |
| `packages/app/src/ui/Toolbar.tsx` | Toolbar tabs built from `tools/registry.ts` | One tool entry |
| `packages/app/src/ui/styles.css` (2,282 lines) | `ui/styles/<area>.css` + `tokens.css`, `shell.css` | One `@import` line |
| `packages/desktop/src/ipc.ts` | `ipc/{index,files,slicer,agent,profiles}.ts` | One register call |
| `forge/crates/forge-regen/src/v1/part.rs` feature `match` | A dispatch table, `v1/features.rs` | One arm per feature type |
| `oracle/src/aicad_oracle/v1/evaluate.py` dispatch | A dispatch dict | One entry |
| `packages/agent-tools/src/v1/playbooks.ts` | `v1/playbooks/{index,refs,sketch,features,commands}.ts` | One import line |
| `forge/crates/forge-ops/src/lib.rs` | Unchanged: already a module list | `pub mod x;` |

**Moves** in the same step: `doc/timeline.ts` → `ui/timeline/model.ts` (HIST); `doc/provenance.ts` → `selection/provenance.ts` (SEL); `doc/problems.ts` and `ui/ProblemsPanel.tsx` → `ui/problems/` (APPV1, then HIST); `agent-tools/src/v1/param-uses.ts` → `model-ops/src/param-uses.ts` (OPS; agent-tools re-exports it). After the moves, `packages/app/src/doc/**` has one owner, OPS.

### 3.4 Contracts

Each contract is defined as types, interfaces and stubs that compile and are tested, with one owner. It is frozen before the wave that builds on it. After that it changes only through a short PR that its consumers review, as in IR-V1-IMPLEMENTATION-PLAN §3.

| Id | Contract | Owner | Consumers | Content | Frozen by |
|---|---|---|---|---|---|
| **C1** | Op catalogue v2 | OPS | Everyone | `@aicad/model-ops`: zod schemas for §2.2, labels, semantic inverses, `IrCommandEngine` v2; Rust stubs in `forge-commands` refusing `COMMAND_NOT_IMPLEMENTED`; `corpus/v1/ops/` format; the host-only list. **Part 1:** param and feature ops, `dependents`, `evaluateThrough`, `feasibleRange`, the failure rule. **Part 2:** `sketchEdit`, `convertSketch`, `refFor`, `setRef`, `setAppearance` | Part 1: FM-W0. Part 2: end of FM-W2 |
| **C2** | Selection | SEL | TOOL, FEAT, SKUI, AG | `SelectionItem` (body key = origin), `SelectionState`, `KindMask`, the re-resolution rule (§2.4) | FM-W0 |
| **C3** | Tool framework | TOOL | FEAT, SKUI | `ToolSpec`, `ToolSession`, `ToolInputs` hints, `HandleSpec`, the panel registry, tool command ids (`tool.start {id,args}`, `tool.commit`, `tool.cancel`, `feature.edit`) | Core: FM-W0. Handles: FM-W2 |
| **C4** | Viewport v2 | VIEW | SEL, TOOL, SKUI, FEAT | See below | Part 1: FM-W0. Part 2: FM-W2 |
| **C5** | SketchSession | SKK | SKUI, AG | See below | End of FM-W2, after the prototype |
| **C6** | Store v2 | OPS | Everyone | `IrDocStore.openGroup/seal/abort`, `preview(ops)` with newly failing features, transaction `origin`, host-stamped authorship, the commit check hook, the rollback marker | FM-W0 |
| **C7** | Test and performance hooks | QA | Everyone | See below | FM-W0 |
| **C8** | Architecture record | SPEC | Everyone | ADR 0021 (§2 of this plan, including the failure rule, the concurrency rule, body identity and the ⌘K binding); ARCHITECTURE §2, §3 "Edits" and §7; SPEC set A with conformance fixtures, the oracle accepting them | FM-W0 |
| **C9** | Feature naming for UI-created features | CS | FEAT, SKUI, AG | `<type><n>` ids and CadScript `const` names (`fillet1`, `hole2`), how they print, the rename flow | FM-W0 |
| **C10** | Canvas input and modes | TOOL | VIEW, SEL, SKUI, FEAT, HIST | See below | FM-W0 |

**C4, the viewport contract,** adds to `ViewportAdapter`:
- part 1: `camera()` returning `{ view, proj, viewport, ray(x, y), project(p) }`; a free-orbit `CameraState` v2 (quaternion orientation, target, distance, projection); `lookAt(frame, { roll })`; `pick(x, y, { filter })` for faces and edges; `setBodyState(originKey, { visible, color, opacity })`; `setDisplayMode`, `setSection`; an overlay host for DOM handles, labels and sketches;
- part 2: `pick` for vertex, cap, handle, datum and origin kinds; `pickBox(rect, "window" | "crossing", filter)`; `setPreviewBodies(bodies, "ghost" | "provisional" | "tint")`.

It sets the **pick-ID encoding once**: 4 kind bits and 28 index bits (`KIND_SHIFT = 28`). The 2-bit kind field in `forge-render/src/pick.rs` is full today.

**C5, the sketch session,** is `forge-wasm/src/sketch_session.rs` plus `packages/forge-web/src/sketch.ts`:
- `load(doc, sketchId)`, `solve()`;
- `dragBegin(point)`, `dragTo(uv)`, `dragEnd() → SketchEdit[]`;
- `apply(edits)` (tentative, not committed), `toEdits()`;
- `frame()`, `dispose()`.

Results carry per-entity DOF, free directions, constraint states and conflicts with suggested removals (the data in `forge-solve/src/result.rs`), and they include set A's implicit origin and axes.

**C7, the test and performance hooks:**
- `window.__pzTest`, **only** when `AICAD_ALLOW_DEBUGGER=1` or in dev builds. It offers `project(worldPoint)`, `documentText()`, `selection()`, `transcript()` (the committed ops with origin), `perf()`, and **fault-injection points** (for example `fault("save:afterTempWrite")` for `w2-files`' interrupted save). A hardening test asserts it is absent in the alpha config.
- The e2e driver, `packages/desktop/e2e/modeling/driver.ts`, which drives with real mouse events at projected points: `clickWorld`, `clickSnap`, `dragWorld`, `boxSelect`, `typeValue`.
- `pnpm --filter @aicad/desktop e2e:goldens`, the only way to regenerate goldens. The diff is reviewed in the PR.
- The `performance.mark` names from §2.8, and the skeleton of `scripts/fullmodel-accept.sh`.

**C10, canvas input and modes** (`packages/app/src/input/**`):
- **One router** receives every pointer and key event on the canvas and offers it, in this order, to: an active drag or a handle under the cursor → the active sketch tool → the active feature tool → selection → the camera. The first that claims a gesture owns it until pointer-up.
- **Esc unwinds one layer at a time:** cancel the drag → cancel the tool → leave the sketch (finish; its group seals) → clear the selection.
- **Modes** (`model`, `sketch(id)`, `tool(id)`) are published app state. The camera works in every mode.
- **The rollback marker** is read from the store (C6); only HIST's `timeline.setMarker` writes it.

### 3.5 Merge cadence, flags and the manifest

- **Merge windows twice a week** (Tuesday and Friday), so integration never piles up at a wave's end. INT merges in this order and runs FG1 after each group:
  1. SPEC;
  2. OPS, ENG;
  3. Rust: SKK, KRN, IO, and VIEW's Rust half;
  4. CS;
  5. VIEW's TS half, then TOOL;
  6. SEL, DOC and HIST;
  7. FEAT and SKUI;
  8. AG;
  9. QA.
- After each merge INT regenerates the generated files and publishes the `forge-web` build that TS-only worktrees link (§3.1 rule 6).
- A branch that breaks a gate waits for the next window. A merge conflict outside a registration point goes back to the file's owner.
- **Build flags** (`packages/app/src/flags.ts`, INT). Every unfinished tool is behind a flag that is off in the owner's build. A flag turns on only when the tool's FG2a specs pass.
- **The manifest** (`corpus/fullmodel/manifest.json`, INT) lists every e2e spec with its build and flag. When an item slips to the next build, INT moves its specs there, so FG2a skips them instead of failing.

### 3.6 Staffing

The calendar is set by each wave's critical path plus 20%, not by headcount. INT is one agent in every wave. "Busy" counts agents working at the same time, including FIX.

| Wave | Weeks after Phase C | Agent-days | Working days | Busy on average | Peak | Local Rust builders (cap 3) | In cloud sessions |
|---|---|---|---|---|---|---|---|
| FM-W0 + FM-W1 | 0–2½ | ~64 | 12 | ~5.5 | 12 | INT, OPS, SKK (ENG and SPEC take turns) | — |
| FM-W2 | 2–6 | ~92 | 20 | ~4.6 | 11 | INT, OPS, SKK or ENG | — |
| FM-W3 | 6–10 | ~108 | 20 | ~5.4 | 12 | INT, OPS or SKK, VIEW or KRN | KRN-F2, IO-K, KRN-B |
| FM-W4 | 10–14½ | ~101 | 22 | ~4.6 | 11 | INT, SKK, OPS | KRN-F2, IO-K, KRN-B, IO-7a |
| FM-W5 | 14½–19 | ~116 | 22 | ~5.3 | 12 | INT, KRN, SKK | KRN-F2, IO-K, KRN-B, IO-7a |
| FM-W6 | 19–22 | ~51 | 15 | ~3.4 | 8 | INT, SEL, SKK | KRN-B, IO-7a |

The peaks are what the owner's Claude plan must sustain. After one test run of the preview, the 7-day window stood at 61% (ALPHA-0-PREVIEW §3). INT-0c measures window use per agent-day in FM-W0 [fm1]. If the plan can't sustain the peaks, waves run nearer their averages and stretch by the shortfall on their critical paths.

---

## 4. Waves and builds

### 4.1 What every wave ends with

- **The build.** `scripts/alpha0-mac.sh --build` makes an ad-hoc signed arm64 `PartZero.app`, checks its signature and fuses, and runs `--self-test`. The script comes from the `alpha0-preview` branch, merged in FM-W0. It keeps its name until the first signed build (FD8).
- **The acceptance script,** `scripts/fullmodel-accept.sh --wave N`:
  - **FG1 (automated):**
    - `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` (on `main`, by INT);
    - the oracle diff on `corpus/v1/programs` plus the wave's new cases;
    - `pnpm -r build && pnpm -r test`;
    - the ops fixtures;
    - the licence checks.
  - **FG2a (the app, automated):** Playwright-Electron on the **bundled** main and worker, launched with `AICAD_SIMULATE_PACKAGED=1 AICAD_ALLOW_DEBUGGER=1` (the pattern of `e2e/bundled-alpha.e2e.ts`; Playwright can't attach to the packaged `.app` itself).
    - It runs every spec the manifest lists for builds up to and including N, so earlier waves are regression-tested.
    - It runs the `e2e/perf/*.perf.ts` budgets (§5.6).
    - It writes `packages/desktop/release/fullmodel/fmN-report.json`, which is not committed.
    - **It runs on this Mac.** Linux CI can't present a WebGPU canvas (BACKLOG P1), so FG2a runs nightly here while local builders are paused, and at hand-over. INT-2 restores Linux canvas coverage under xvfb; until then Linux CI runs the canvas-free specs.
  - **FG2b (from the shell):** signature, fuses and self-test of the installed copy, as in ALPHA-0-PLAN §2.
- **FG2c (the owner, 15–20 minutes):** the wave's checklist below, after `scripts/alpha0-mac.sh --install --no-build`.
- **The hand-over rule.** A build is handed over when FG1, FG2a and FG2b pass on its hand-over commit. Every failure is either fixed or listed as a known issue the owner accepts, as in Alpha 0.

### 4.2 FM-W0: the merged base and the contracts (days 1–10, no build)

**Precondition.** Phase C is committed and its final verification is green. That work belongs to the Phase C session. Until then this program touches none of Phase C's open files: `packages/app/src/{bootstrap,services,worker-rpc}.ts`, `packages/app/src/{commands,engine,doc/v1}/**`, `packages/agent/**`, `packages/agent-tools/**`, `packages/forge-web/**`, `forge/crates/forge-wasm/**`, `forge/crates/forge-regen/**`, `forge/crates/forge-ops/**`, `forge/crates/forge-blend/**` and `oracle/**`.

**Order: merge → split → contracts.** INT is one agent doing INT-0a and then INT-0b. While INT-0b runs (days 3–6), `main` is frozen for the files being split, and FM-W1's agents work only in other files. The contracts are written into the split files from day 5.

| Id | Days | Scope | Writes | Size |
|---|---|---|---|---|
| **INT-0a** | 1–2 | A trial merge in a scratch worktree, then merge `alpha0-preview` (40 commits, 88 files) into `main`. The only file both the preview and Phase C changed is `forge/crates/forge-cli/src/main.rs`, and `main` has no commits past the merge base `8279a60` [fm3]. The risk is behaviour, not text: the preview rewrote `packages/desktop/src/agent/{runner,engine}.ts`, which APPV1 then connects to v1. FG1, the preview's e2e (`bundled-alpha`, `print`) and `--self-test` pass on the merged tree | The merge commit | M 2 |
| **INT-0b** | 3–6 | First the empty `packages/model-ops` package and `forge/crates/forge-commands` crate (day 3), then the splits and moves of §3.3, with no behaviour change: every test passes before and after. With OPS: `forge-wasm/src/commands.rs` and the evaluation core it uses move to the new crate `forge/crates/forge-commands` | Every file in §3.3's "Today" column and the moves; `forge/Cargo.toml` | M 4 |
| **INT-0c** | 1–3 | Capacity and cadence: sccache; `scripts/fm/worktree.sh` (the §3.1 rule 6 checks, linking INT's `forge-web` build, cleanup at merge); `packages/app/src/flags.ts`; `corpus/fullmodel/manifest.json`; `docs/fm/w0.md` with the merge-window calendar; the ALPHA-0-PLAN §3.1 amendment (W10 into 0.1, the new dates); the plan-window measurement [fm1] | Those files; `docs/ALPHA-0-PLAN.md` §3.1 | S 1 |
| **SPEC-0** | 1–10 | C8: ADR 0021 (§2 of this plan: the failure rule, the concurrency rule, body identity, the ⌘K binding), ARCHITECTURE §2, §3 "Edits" and §7, AGENT-IN-APP's ⌘K note; SPEC set A with conformance fixtures, and the oracle accepting them (§2.11) | `forge/crates/forge-ir/**`, `SPEC-v1-DRAFT.md`, `corpus/v1/conformance/**`, the oracle's shared modules, `docs/adr/0021-*`, `docs/ARCHITECTURE.md`, `docs/AGENT-IN-APP.md` | M 4 |
| **OPS-0** | 6–10 | C1 part 1 and C6 as zod schemas in `@aicad/model-ops` and Rust stubs in `forge-commands` that refuse with `COMMAND_NOT_IMPLEMENTED`; the `corpus/v1/ops/` fixture format; the host-only list; `COMMAND_NEW_FAILURES` | `packages/model-ops/**` (new), `forge/crates/forge-commands/**`, `packages/app/src/doc/**` | M 4 |
| **TOOL-0** | 5–10 | C3 core and C10 as types and tests; **the final panel layout** (§2.5) in `ui/shell/`, with empty tabs hidden, behind the flag `layout.v2`. If the flag isn't green by day 9, FM1 ships today's layout and the new one moves to FM2 | `packages/app/src/{tools/framework,input,ui/shell}/**`, `tools/registry.ts`, `ui/styles/{tokens,shell}.css` | M 4 |
| **SEL-0** | 4–5 | C2 | `packages/model-ops/src/selection.ts`, `packages/app/src/selection/**` | M 2 |
| **VIEW-0** | 5–8 | C4 part 1 as TS types and Rust stubs; the pick-ID encoding (4 kind bits) | `forge/crates/forge-render/**`, `forge-wasm/src/web/viewport.rs`, `packages/forge-web/src/{viewport.ts,types/viewport.ts}`, `packages/app/src/viewport/**` | M 3 |
| **ENG-0** | 8–10 | Body keys = the SPEC §5.2 origin in `engine.rs` (fixes highlights dropped on rename). Spike: the cost of `feasibleRange` for fillet `r` and shell `thickness` on R25, which sets its budget [fm13] | `forge-wasm/src/{lib,engine}.rs`, `web/{mod,engine}.rs`, the forge-regen core, `packages/forge-web/src/{engine,index,worker,evaluator}.ts`, `types/engine.ts` | M 2 |
| **SKK-0** | 5–10 | C5 draft. Spike: the solver in the main-thread WASM instance keeps drags ≤4 ms on S200 [fm4]. The SketchSession prototype starts and continues in FM-W2 | `forge/crates/{forge-solve,forge-sketch}/**`, `forge-wasm/src/{sketch_session.rs,web/sketch.rs}`, `packages/forge-web/src/{sketch.ts,types/sketch.ts}` | M 3 |
| **CS-0** | 8–10 | C9 naming | `packages/cadscript/**` | S 1 |
| **QA-0** | 3–10 | C7: `__pzTest` with fault-injection points, the driver, `e2e:goldens`, the `fullmodel-accept.sh` skeleton, perf fixtures `corpus/fullmodel/perf/{R25,R50,S200}.json` (a 25-feature part, a 50-feature part, a 200-entity sketch) | `packages/desktop/e2e/{modeling,perf}/**`, `packages/app/src/test-hooks/**`, `scripts/fullmodel-accept.sh`, `corpus/fullmodel/**` except the manifest | M 4 |

**Size:** ~34 agent-days over 2 weeks.

**Staffing: seven agents.** Each runs its rows in order:
- INT: INT-0a with INT-0c (days 1–3; the capacity script is needed before the other worktrees start), then INT-0b.
- SPEC: SPEC-0, then CS-0.
- OPS: FM-W1's OPS-1 (days 3–6), then OPS-0.
- TOOL: SEL-0, then TOOL-0.
- VIEW: VIEW-0, then ENG-0.
- SKK: SKK-0.
- QA: QA-0, then FM-W1's QA-1.

FM-W1 adds five more agents: APPV1 ×2, HIST-1 and A0 ×2. Twelve at once is the program's peak.

**Acceptance.**
- FG1 and the preview's e2e pass on merged `main`. The split commits change no test result.
- Every contract compiles, and every stub op refuses with `COMMAND_NOT_IMPLEMENTED` (a test).
- C1 part 1, C2, C3 core, C4 part 1, C6, C7, C8 (set A), C9 and C10 are frozen.
- The two spikes report their numbers [fm4, fm13]. INT reports plan-window use per agent-day [fm1] and the disk check [fm12].

**Owner:** nothing to do. FM-W0 has no install.

### 4.3 FM-W1: Alpha 0 drop 0.1 (days 1–12, beside FM-W0) → FM1, then FM1.1

**Scope:** exactly ALPHA-0-PLAN §3.1's drop 0.1, plus Alpha 0 W10 (Report Issue: size S, no Phase C dependency). Alpha 0 W4d's stretch goal, face selection in the viewport, becomes a required item of FM2 (SEL-2).

| Id | Scope | Writes | Size |
|---|---|---|---|
| **APPV1** (2 agents) | Alpha 0 W4 a (EngineV1), b (the runner: on the preview's rewritten `runner.ts` and `engine.ts`), d (the proposal diff and accept on v1, v1 problems with playbook hints, Monaco v1 types), f (v1 bench), g (prompt rules), h (spec writer) | `packages/app/src/{services,bootstrap,worker-rpc}.ts`, `packages/app/src/engine/**`, `ui/problems/**`, `ui/CodeEditor.tsx`, `packages/desktop/src/agent/{runner,engine}.ts`; and, holding them for AG: `ui/ProposalView.tsx`, `packages/app/src/agent/agent-service.ts`, `packages/agent-tools/src/v1/engine.ts`, `packages/agent/src/{cli-main,spec-writer}.ts`, `packages/agent/prompts/{designer.v2,spec_writer.v2}.md` | L ×2 ≈ 12 |
| **OPS-1** | Alpha 0 W4c: the v1-only document pipeline, a plain refusal for v0 files, and **one** undo stack. Days 3–6, by the OPS agent before OPS-0 | `packages/app/src/doc/**` | M 3 |
| **HIST-1** | Alpha 0 W4e: the Parameters panel in its final slot (list; edit → `setParam`, spliced into CadScript, no LLM call; the feasible range when a value fails; assumption chips) | `packages/app/src/ui/parameters/**` | M 3 |
| **A0** (2 agents) | Alpha 0 W0 (references, `alpha0-accept.sh`); W2 minimum (empty document, welcome card, chips, rename, build identity); W3 (⌘P, Parameters opens after accept, stop reasons); what's left of W5 after the preview (the handoff exists); W6 (five starters); W8 (wall-time cap, messages, export gate); **W10 Report Issue** | As ALPHA-0-PLAN §3.2 for each item, less the files above | ≈ 10 |
| **QA-1** | Alpha 0 G2a a1–a10 on the merged base | `packages/desktop/e2e/**` (Alpha 0 specs) | M 2 |

**Timing.**
- Days 1–2: APPV1 and A0 start on files outside the split list (§3.3).
- Days 3–6: they stay out of the files INT-0b is splitting.
- From day 6: they write into the split files.
- **Critical path:** merge → APPV1 a and b with OPS-1 → W6's starters → Alpha 0's gates → **FM1 at about 2½ weeks.**

**Size:** ~30 agent-days.

**FM1.1 = drop 0.2, about a week later** (A0, ≈ 7): W7 Fit Lab, W5's material library and picker, W9's test, and the rest of W2 and W3.

**Acceptance.** Alpha 0's own gates, unchanged: for 0.1, G1 #1–6 and #8, G2a a1–a10, G2b and G2c, plus the Report Issue test (ALPHA-0-PLAN §5); for 0.2, G1 #7, G2a a11–a12, and G3 in the owner's first week.

**Owner checklist:** Alpha 0's G2c (the golden path), plus **Help → Report Issue** once, to see the folder it makes.

### 4.4 FM-W2: editable history and navigation (weeks 2–6) → FM2

| Workstream | Scope | Size |
|---|---|---|
| OPS-2 (Rust and TS agents) | In `forge-commands`: `addParam`, `deleteParam`, `renameParam`, `addFeature`, `setField`, `deleteFeature`, `moveFeature`, `setSuppressed`, verified, with inverses and **the failure rule**; `dependents`, `evaluateThrough`; `aicad op` and `aicad op replay`; the ops fixtures. The store: C6 in full, with the rollback marker. **The ADR 0015 commit check** for agent, MCP and CLI transactions | ≈ 13 |
| HIST-2 | Timeline: v1 icons, inline rename, delete with a dependents dialog ("delete them too / keep and show errors / cancel"), drag to reorder with legality shown while dragging, suppress, the **rollback bar**, context menu, error and warning badges; the failure-rule dialog. Parameters v2: add, delete, rename; **model values**: every numeric feature field and sketch dimension grouped by feature, edited with `setField`, with **promote to parameter** (`addParam` + `setField { expr }`) | ≈ 10 |
| VIEW-2 (2 agents, split by module) | (a) Free-orbit camera (C4); all 7 views; look-at; transitions; fit and zoom to selection; mouse presets per FD3, where a right click without a drag opens the menu; Mac trackpad (pixel-mode wheel: two-finger orbit or pan, pinch zoom). (b) `view.section` command and panel (principal planes, from a face, offset, flip); display toggles wired; theme colors reach `forge-render` (`setColors` does nothing today); **a basic view cube** (faces and Home) | ≈ 13 |
| SEL-2 | **v1 face and edge picking to provenance key and probe (required)**; single selection with hover labels ("Top face of `plate`" instead of `plate/cap:end`); the agent's selection chips on v1 (`agent/selection.ts`); re-resolution after a regen | ≈ 5 |
| TOOL-2 | The tool framework core (C3) behind the flag `tools.framework`: sessions, generated panels, expression and selection fields, errors mapped to fields, the preview pipeline (priority queue, cancel, stale drop); the C10 router. Started now so FM-W3's tools don't wait on it | ≈ 8 |
| ENG-2 | `feasibleRange` in `forge-regen` (`v1/feasible.rs`) for fillet `r`, chamfer `d` and shell `thickness`, within FM-W0's budget, exposed by OPS as a query; set A's revolve `axis: { curve }` in regen; the prefix cache here instead of FM5 if fm9 fails | ≈ 5 |
| SKK-2 | Set A in `forge-sketch` and `forge-solve` (the implicit origin and axes as fixed entities; label positions passed through); the SketchSession (C5) prototype, after which **C5 and C1 part 2 are frozen** at the end of the wave | ≈ 8 |
| SPEC-2 | Set A in forge-ir, the schema and the oracle (validate, replay, constraints, generator), with conformance fixtures; set B drafted | ≈ 4 |
| CS-2 | `applyIrEditV1` keeps comments inside changed statements (BACKLOG P1: manual edits will hit it constantly); C9 printing of UI-added features; set A in CadScript (std, compile, print, splice) | ≈ 4 |
| DOC-2 | Atomic save with `.bak`; binary read over IPC (`fs:readBytes`, size-capped); a "Save / Don't Save / Cancel" prompt on close and New | ≈ 3 |
| AG-2 | Agent tools generated from the catalogue; `v1/edits.ts` goes through the engine's ops; playbooks for the new `COMMAND_*` codes; **the concurrency rule** (§2.3) in the runner | ≈ 5 |
| QA-2 | The specs below; the perf baseline; the checklist dry run | ≈ 5 |
| FIX-2 | The owner's notes on FM1 and FM1.1 | ≈ 4 |
| INT-2 | Merge windows; regeneration; flags and manifest; Linux canvas coverage under xvfb (BACKLOG P1) | ≈ 5 |

**Size:** ~92 agent-days. **Critical path:** OPS-2's Rust ops (about 8 days), then HIST-2's wiring to them (3), then acceptance (2): about 13 working days, plus 20%. The wave starts on day 10, when FM-W0's contracts are frozen, and FM1's fixes arrive in its second week.

**FG2a specs**
- `w2-timeline.e2e.ts`: rename, delete with dependents, reorder (an illegal drop is refused), suppress, rollback and insert at the bar. After each step, undo restores the canonical bytes and redo restores the next.
- `w2-params.e2e.ts`: add, edit (literal and expression), rename, delete a used parameter (refused, with its uses); edit a model value; promote one.
- `w2-failure-rule.e2e.ts`: an edit whose own feature fails is refused with its range; an edit that makes two later features fail shows the dialog; Apply anyway commits with the acknowledgement; Cancel leaves nothing.
- `w2-navigation.e2e.ts`: 7 views; cube faces and Home; look-at a picked face; section from a face; trackpad orbit and pan through synthetic pixel-mode wheel events; zoom to selection.
- `w2-pick-chip.e2e.ts`: a picked edge becomes a v1 chip, and the scripted agent receives its provenance key.
- `w2-files.e2e.ts`: an interrupted save (C7's fault point) leaves the old file intact; the prompt's three choices.
- `w2-commit-check.e2e.ts`: a scripted agent op that edits a user-authored feature without approval is refused (`unapproved_user_change`).
- `w2-replay.e2e.ts`: the session transcript, replayed with `aicad op replay`, gives the same canonical IR (§5.3).
- `perf/edit-to-screen.perf.ts` on R25 and R50.

**Owner checklist (about 20 minutes)**
1. Open the **Storage bin** starter.
2. In Parameters, set `cells_x` = 3. It rebuilds in about a second, with no AI call.
3. In Parameters → **Model values**, set the chamfer to 5 mm. It's refused and shows the largest size that builds. Set it to 0.8 mm. Then promote any literal value to a parameter and give it a name.
4. In the timeline, rename the shell to `walls`. Drag the rollback bar above the chamfer: the chamfer disappears. Drag the bar back.
5. Suppress the divider pattern, then unsuppress it.
6. Try to delete the base sketch. It lists what depends on it, and says how many features would fail if you kept them. Cancel.
7. Navigate with your usual device (FD3): orbit, pan, zoom, **Shift+1…7**, the view cube's faces and Home. Click a face and press **N**: the view looks straight at it. Turn on the section from that face and move its offset.
8. Click an edge and type in chat "fillet this 1 mm". The chip names the edge. Accept the proposal.
9. ⌘Z through everything you did: one stack, in order.

**After FM2 you can** rework any part's history and change any value by hand, navigate like a CAD app, and point the agent at geometry. You still can't draw new geometry by hand.

### 4.5 FM-W3: first hand-made part → FM3

| Workstream | Scope | Size |
|---|---|---|
| SKUI-3a | Sketch mode: a new sketch on an origin plane, planar face or datum, picked in the viewport or the Browser; edit from the timeline with rollback; look-at with roll; grid; finish and cancel as a group (C6); later features hidden; **redefine plane**. The SVG sketch overlay (curves, points, dashed construction, DOF colors, failed geometry grey); the status line ("3 DOF", "Fully constrained"); conflicts in red with **Remove suggested** | ≈ 8 |
| SKUI-3b | Tools: line and polyline; rectangle (2-point, centre); circle (centre); point; construction toggle. The dimension tool (aligned distance, point-to-line distance, radius and diameter, angle; typed while drawing; a typed name becomes a parameter; "make driven?"). Snaps to endpoints, midpoints, centres, **the origin and axes**, the grid, and H/V, each written as its auto-constraint | ≈ 9 |
| SKK-3 | SketchSession complete (C5): drags ≤4 ms, tentative edits, per-entity DOF, free directions, conflicts, the id map | ≈ 5 |
| OPS-3 | `sketchEdit` and `convertSketch` (verified); `refFor` with sets (verified exact); `setRef`; `setAppearance` | ≈ 10 |
| KRN-3a | Extrude `through_all` (set B): regen, an oracle case, conformance | ≈ 3 |
| FEAT-3a | **Extrude and cut** from picked regions: distance, direction, symmetric, op (new, join, cut), **through all**, flip; the arrow handle; targets default to the bodies the profile touches (SPEC §6.0.2 requires explicit targets) | ≈ 5 |
| FEAT-3b | **Fillet and chamfer** on picked edges: tangent-chain preview; the radius knob clamped with `feasibleRange` at drag start; unsupported edges in red (`FILLET_EDGE_UNSUPPORTED`); a `*_TOO_LARGE` that names a hole or boss offers "move this fillet before `hole2`" (`moveFeature`); chamfer's three forms | ≈ 6 |
| TOOL-3 | The framework comes out of its flag: toolbar tabs, contextual toolbar, right-click menu, shortcuts (§2.5). Manipulators: arrow, radius knob, plane handle; drag math, snapping, Tab to type, clamp; the section plane's handle | ≈ 8 |
| SEL-3 | The selection set: filters (1–4), multi-select, box select (window and crossing), tangent chain, plural chips. **The Browser panel:** Origin (planes and axes), Sketches, Construction and Bodies sections, each with show/hide, isolate, rename and pick; a color swatch per body | ≈ 9 |
| VIEW-3 | Pick-ID re-encode (C4 part 2); vertex picking (a point-sprite pass); box read-back; an **alpha pass** for translucent previews [fm6]; **origin planes and axes**, datum planes and axes drawn and pickable; per-body visibility, color and opacity | ≈ 10 |
| HIST-3 | **Edit feature** (double-click → rollback → panel → `setField`). **Reference repair** in the timeline and the Problems panel: "`fillet1` lost 2 edges" → accept the suggestion (`acceptRefProposal`), pick a candidate (`acceptRefCandidate`), or re-pick in the viewport (`refFor` + `setRef`) | ≈ 6 |
| IO-3 | **3MF colors** from body appearance: one color group per body, so Bambu Studio can map bodies to AMS slots (it loads "geometry data and color data only" from our files, ALPHA-0-PREVIEW §3; `forge-io` writes no colors today) | ≈ 2 |
| SPEC-3, CS-3 | Set B in forge-ir, the oracle and conformance; CadScript for both; set C drafted | ≈ 3 + 3 |
| AG-3 | "This edge" in chat resolves through `refFor`; tools for extrude, fillet, chamfer and `sketchEdit`; the agent's `sketch_edit` goes through `sketchEdit` and returns the DOF change; `render_sketch` (an SVG from the solved geometry, colored by DOF); playbooks | ≈ 5 |
| QA-3 | The specs below | ≈ 6 |
| FIX-3 | The owner's notes on FM2 | ≈ 6 |
| INT-3 | Merges, regeneration, flags, manifest | ≈ 4 |
| Kernel tracks (cloud) | **KRN-F2** fillet gaps (lands in FM5); **IO-K** STEP AP214 writer (lands in FM5); **KRN-B** B-spline faces in mass properties and bbox, SSI with B-spline surfaces (BACKLOG P1/P2; lands with FM8) | Counted where they land |

**Size:** ~108 agent-days; about 4 weeks. **Critical path:** OPS-3's `sketchEdit` (about 5 days, beside SKK-3), then SKUI-3b (9), with FEAT-3a's region extrude joining in its last days, then the first-manual-part e2e: about 16 working days, plus 20%. SKUI-3a, SEL-3, VIEW-3 and FEAT-3b start on day 1 against frozen contracts.

**FG2a specs**
- `w3-select.e2e.ts`: filters, box window versus crossing, tangent chain, re-resolution after a regen.
- `w3-sketch-basics.e2e.ts`: a rectangle from the origin with two typed sizes is fully constrained; a circle dimensioned to two edges; a conflict fixed with Remove suggested; redefine plane.
- `w3-extrude.e2e.ts` (distance, cut, through all), `w3-fillet.e2e.ts`, `w3-chamfer.e2e.ts`, each following §5.1.
- `w3-repair.e2e.ts`: an upstream edit breaks a fillet's reference; accept the suggestion; pick a candidate; re-pick.
- `w3-browser.e2e.ts`: show/hide, isolate, a body color that appears in the exported 3MF.
- `w3-edit-feature.e2e.ts`.
- `w3-manual-part.e2e.ts`: blank → sketch on XY → rectangle from the origin with dimensions → extrude → sketch on the top face → rectangle → cut through all → fillet → 3MF. The result equals a golden canonical IR.
- `perf/sketch-drag.perf.ts` on S200; `perf/preview.perf.ts`.

**Owner checklist (about 20 minutes, then the 30-minute hands-on)**
1. New document. Pick **XY** in the Browser and start a sketch. Press **R**, click the origin, and type 60, Tab, 40. The rectangle turns black: fully constrained.
2. Press **C** and draw a circle near one corner. The status says "3 DOF". Press **D**: make it Ø5, then 8 mm from each of the two nearest edges. It turns black.
3. Draw a second rectangle away from the origin, with no dimensions, and drag one of its corners: it follows at full frame rate. Delete it.
4. Add a dimension that conflicts. It turns red, the panel explains why, and **Remove suggested** fixes it.
5. Finish the sketch. Press **E**, pick the rectangle region (not the circle), drag the arrow to 4 mm, and press Enter.
6. Select the top face and start a sketch on it. Draw a rectangle, then extrude it as a cut, **Through all**.
7. Press **2** (edges), box-select the top outer edges and press **Shift+F**. Drag the radius knob up until it stops, and read why it stopped. Type 1.5 and press Enter.
8. In the Browser, make the body red. Click **Open in Bambu Studio**: the object is red there, ready for an AMS slot.
9. Double-click the first sketch in the timeline and change 60 to 80. The fillet follows. If anything lost a reference, the Problems panel offers the repair: accept it.
10. Ask the agent: "make the plate 2 mm thicker". Accept. Save the document as `plate`.

**Hands-on (30 minutes):** model one simple part of your own by hand (a spacer, a bracket plate) and note what you reached for that isn't there. FIX-4 works through the notes.

**After FM3 you can** make simple parts from a blank document by hand (sketch, extrude, cut, fillet, chamfer), modify agent parts with real tools, and print them in color.

### 4.6 FM-W4: full sketcher and feature tools → FM4

| Workstream | Scope | Size |
|---|---|---|
| SKUI-4a | Arcs (3-point, centre, tangent); slots (centre-to-centre, overall, arc); polygons (inscribed, circumscribed); rectangle 3-point; circle 2- and 3-point | ≈ 7 |
| SKUI-4b | All 16 constraints, plus UI mappings for concentric, collinear and symmetric lines; the glyph overlay; draggable labels (set A); the angle quadrant; full inference (parallel, perpendicular, tangent hints; intersections, quadrants, nearest point on a curve) | ≈ 9 |
| SKK-4a | **Horizontal and vertical point-to-point distance**, H/V between points (set C: solver, IR, CadScript, checker, oracle replay). The dimension tool infers H/V or aligned from the cursor, as Fusion does | ≈ 4 |
| PRJ (SKK-4p, OPS-4, SKUI-4p) | **Planar Project/Include** (set C): a sketch curve kind bound to a `Ref`, re-evaluated on each evaluation, fixed in the solver, for edges parallel to the sketch plane. A face's boundary edges are offered automatically as snap and dimension targets when sketching on it. The **Project** tool for other parallel edges. Naming-harness family | ≈ 8 |
| SKK-4r | **Region arrangement** (§1.2 #25): split curves at intersections, regions from the faces, deterministic piece names `<curve>#k`, sketch `v: 2` (FD6), oracle support. A kernel track since FM-W3; it may land in FM5, and until then crossings show the highlighted error | ≈ 8 |
| FEAT-4a | **Hole.** Pick a face and click points: the tool makes a point sketch on the face, with each point dimensioned to the nearest projected face edges (snapped to the grid or typed), and a hole with `at.points`, so the holes follow the edges. Or pick existing sketch points. Sizes from `HOLE_SIZES`; fit; through, blind or up-to; cbore, csink, insert, cosmetic thread; `HOLE_POINT_OFF_FACE` shown at the point | ≈ 7 |
| FEAT-4b | **Pattern** (linear and circular, feature or body seeds, direction from an edge or axis, count and spacing handles, click an instance to skip it) and **mirror**. A fillet or chamfer seed (`PATTERN_SEED_UNSUPPORTED`) offers "pattern the body and join" instead | ≈ 7 |
| FEAT-4c | **Shell** (open faces, thickness, inward or outward), **boolean** (targets, tools, keep tools), **tag** (save the selection as a named set), **datum plane** (offset, angle, midplane, 3 points, frame) and **datum axis** with a plane triad, **revolve** (axis = a sketch line, stored as `{ curve }`; the angle arc) | ≈ 8 |
| DOC-4 | `.partzero` (§2.9) reader and writer with migration and a thumbnail; autosave and crash recovery; file association and `open-file`; the recent-files grid | ≈ 9 |
| SEL-4 | **Measure v1:** point to point from picks; body and part properties from the report (volume, area, bbox, mass with the material's density); a dimension-line overlay; export selected bodies, or one file per body | ≈ 4 |
| SPEC-4, CS-4 | Set C in forge-ir, the oracle and conformance; CadScript for set C; set D drafted | ≈ 3 + 4 |
| AG-4 | Tools for hole, pattern, mirror, shell, boolean, datum and revolve; sketch edits that use projected edges; playbooks | ≈ 5 |
| QA-4, FIX-4, INT-4 | Specs; the FM3 checklist and hands-on notes; merges | ≈ 6 + 8 + 4 |
| Kernel track (cloud) | **IO-7a** STEP import starts | Counted in FM7 |

**Size:** ~101 agent-days; about 4½ weeks. **Critical path:** PRJ (8), then the hole tool's point sketch on projected edges (about 4 of FEAT-4a's 7), then acceptance: about 14 working days, plus 20%, plus FIX-4 from the hands-on.

**FG2a specs:** `w4-sketch-<tool>` for each new draw tool; `w4-constraints`; `w4-dimensions` (H/V inferred; a label drag is stored); `w4-snap` (each snap target creates its constraint); `w4-project` (a point dimensioned to a face edge follows an upstream width change); `w4-hole` (points on a face; re-edit M3 → M4); `w4-pattern` (skip an instance; the fillet-seed offer); `w4-mirror`; `w4-shell`; `w4-boolean`; `w4-datum`; `w4-revolve` (the axis follows its line); `w4-convert` (an agent-written `rect({ w: width })` sketch keeps `width` driving after a manual constraint); `w4-recovery` (kill the app mid-edit, relaunch, restore); `w4-measure`.

**Owner checklist (about 20 minutes)**
1. Open `plate` from FM3. Edit its first sketch: add a slot and a tangent arc, and make the slot symmetric about the vertical axis.
2. Start a sketch on the top face. Its edges are offered: place a point 8 mm from one edge. Go back to the first sketch and change the width: the point follows the edge.
3. **Hole:** click two points on the top face, away from the cut and the existing hole, and type each one's distances to the nearest edges. Pick M3 countersunk, OK. Double-click the hole in the timeline and change it to M4.
4. Pattern the slot ×3 along X, then click the middle instance to skip it.
5. In a new document, extrude a 40 × 40 × 20 mm block (a solid body). **Shell** it 2 mm, removing its top face. Undo.
6. **Revolve:** on XZ, sketch a half-profile with one line on the vertical axis, and revolve it 360° about that line.
7. Add a datum plane 10 mm above the top face and start a sketch on it. Cancel.
8. Save as `plate.partzero`. Make one more edit, force-quit PartZero (⌥⌘Esc), reopen it, and accept the recovery.
9. Measure between two hole centres.

**After FM4 you can** sketch anything made of lines and arcs, place holes and patterns that keep their design intent, and use every Phase C feature by hand.

### 4.7 FM-W5: direct editing and printing → FM5

| Workstream | Scope | Size |
|---|---|---|
| TOOL-5 | **Push/pull** (§2.6): the `faceDriver` resolver (in `model-ops`, shared with the agent), the cap-drag fast path, commit on release, snap-back; "pull a face with no driver" (a sketch on the face from its projected edges + extrude join or cut); **hole-wall drags step through the size table** | ≈ 6 |
| ENG-5 | **Prefix cache** in `forge-regen` (§2.8) | ≈ 4 |
| KRN-5a | Feasible intervals for extrude distance and hole size, in `feasibleRange` and in error `details` (ROADMAP's F2 feasible-range target) | ≈ 4 |
| KRN-5b | **`transform` feature** (move, copy, rotate bodies; reuses `move_body` in `forge-ops/src/pattern/motion.rs`) (set D, regen, oracle, naming-harness family; FD7) | ≈ 6 |
| KRN-5c | **Extents:** up to a face (planar faces first; others refused with a code), two-sided asymmetric, start offset. **Revolve `AxisRef`** (an edge or a datum axis). An oracle case each | ≈ 8 |
| KRN-5d | **Split body by a plane** (set D): two bodies with their own origins, for parts larger than the P2S bed. It uses the existing boolean kernel; an oracle case | ≈ 4 |
| TOOL-5m | The triad gizmo (translate and rotate), typed deltas, snapping; the **Move** tool (M); **Lay flat**: pick a face, and a `transform` rotates the body so that face is on the bed at z = 0 | ≈ 4 |
| SKK-5, SKUI-5 (3 agents) | **Trim and extend** (2D intersection and splitting; constraints and references remapped the way `renameCurve` does); **sketch fillet and chamfer**; **sketch mirror**; **offset** (not associative); constraint batch 2 (set D); **deterministic auto-constrain and auto-dimension** (NORTH-STAR B2), with an agent tool | ≈ 18 |
| VIEW-5 | The full **view cube** (edges, corners, animation); **select-other** (cycle through what's under the cursor); **overhang shading** (faces steeper than the overhang angle from the printer profile, default 45°, shaded) | ≈ 6 |
| SEL-5 | **Measure v2:** `measure(entities)` for edge length, face area, radius and diameter, angle between planes, parallel distance, point to entity, from kernel projections (`curve3.rs`, `nurbs/surface.rs`) | ≈ 4 |
| IO-5 | The **STEP AP214 writer** lands (a track since FM-W3): product structure, units, every Forge surface and curve type, seams synthesized on export (ADR 0012), deterministic numbering, a fixed timestamp; a check before writing with `STEP_UNSUPPORTED_*` errors; OCCT reads it, BRepCheck passes, and volume, area and bbox match within 1e-6 relative; golden bytes. Export options: tessellation, STL binary or ASCII, 3MF units | ≈ 10 |
| KRN-F2 | The **fillet gaps** land (a track since FM-W3): blends trimmed around a hole or boss, full rounds, three-blend corners with a non-line edge, two-blend corners of mixed convexity. Definition-based checks where OCCT builds a free-form patch (SPEC §8.3 rule 5) | ≈ 12 |
| SPEC-5, CS-5 | Set D in forge-ir, the oracle and conformance; CadScript for `transform`, the extents, `AxisRef`, `split` and the new constraints; set E drafted | ≈ 3 + 5 |
| AG-5 | "Make this thicker" goes through `faceDriver`; `transform`, `split`, extents and the new constraints in prompts and playbooks | ≈ 4 |
| QA-5, FIX-5, INT-5 | Specs and perf; the FM4 notes; merges | ≈ 6 + 8 + 4 |

**Size:** ~116 agent-days, including the two tracks that land; about 4½ weeks. **Critical path:** KRN-5b (`transform`), then CS-5, then TOOL-5m: about 12 working days plus acceptance, plus 20%. Push/pull and the sketch tools run in parallel.

**FG2a specs:** `w5-pushpull` (a cap drives `distance`; a parameter-driven face drives `setParam`; a derived expression is refused; the drag snaps back at the feasible limit; a hole wall steps M3 → M4); `w5-move` (move, copy, rotate, typed deltas, lay flat); `w5-split`; `w5-extents`; `w5-revolve-axis`; `w5-trim`, `w5-sketch-fillet`, `w5-offset`, `w5-autoconstrain`; `w5-viewcube`; `w5-overhang`; `w5-measure`; `w5-fillet-after-holes`; `w5-step` (export; the file passes the oracle check in FG1); `perf/pushpull.perf.ts` (provisional ≤16 ms p95, checked ≤150 ms after release).

**Owner checklist (about 20 minutes)**
1. Open `plate.partzero`. Press **Q**, grab the top face and pull it. The thickness updates live (drawn provisional). Release: it's checked, and the extrude distance or its parameter changed.
2. Drag a hole's wall. It steps M4 → M5 → M6 and stops at the largest size that builds.
3. In a new document, make a 40 × 40 × 10 mm block with an M5 hole 5 mm from one top edge, then fillet that edge 4 mm. It builds, trimmed around the hole. Before FM5 this was refused with a size limit.
4. Open the **Electronics box** starter. Select the lid body, press **M**, move it 20 mm in X with the gizmo, then rotate it 90° by typing. Then use **Lay flat** on the lid's top face.
5. In a new document, extrude a 300 mm bar. **Split** it by a plane at its middle, then **Open in Bambu Studio**: two objects that fit the bed.
6. Turn on **overhang shading** and look at the phone stand starter.
7. Extrude a sketch **up to** a face, and another one two-sided.
8. In a sketch: trim an overhanging line, fillet a corner at 3 mm, offset a closed profile by 2 mm. Then run **Auto-constrain** on a loose sketch.
9. Click the view cube's corners and edges. Measure an edge's length, a hole's radius and the angle between two faces.
10. **Export STEP** and open it in any STEP viewer you have (optional).

**After FM5 you can** edit directly with push/pull, model most maker and CNC parts by hand, prepare them for the bed, and send STEP to a CNC shop or fab service.

### 4.8 FM-W6: T0 complete and the copilot on the canvas → FM6

| Workstream | Scope | Size |
|---|---|---|
| SKK-6, SKUI-6 | Projection of edges not parallel to the sketch plane (set E): lines and arcs where the projection is exact; others refused with a code until ellipses exist (FM8) | ≈ 5 |
| VIEW-6 | **Display modes:** wireframe, hidden-line (optional dashed hidden edges), X-ray (per-body sorted transparency within WebGL2 limits). The **ghost overlay** for proposals (NORTH-STAR B4) builds on it | ≈ 10 |
| AG-6 | **⌘K on the canvas** (NORTH-STAR B3, with ADR 0021's binding): selection + prompt → `quick_edit` → a checked ghost → accept or dismiss. **Checkpoints** (NORTH-STAR B4, ADR 0015 §7; FD5). Proposals shown as ghosts; agent-authored badges in the timeline | ≈ 8 |
| SEL-6 | **Exact minimum distance** between faces and edges (`forge-check`, an OCCT `BRepExtrema` oracle case) | ≈ 8 |
| DOC-6 | Camera persistence and named views in the manifest; settings polish | ≈ 2 |
| AG-6b | The manual-parity eval set (§5.5); an NHL check | ≈ 3 |
| QA-6 | **T0 parity acceptance:** 10 maker parts modeled by hand from blank in e2e, with real mouse events; the full perf report | ≈ 6 |
| FIX-6, INT-6 | The FM5 notes; merges | ≈ 6 + 3 |

**Size:** ~51 agent-days; about 3 weeks.

**FG2a specs:** `w6-project` (a projected non-parallel edge follows a parameter change); `w6-display`; `w6-cmdk` (scripted transport: ghost → accept → one undo step; the timeline shows the author); `w6-checkpoint` (restore is 100% correct: equal canonical IR and an identical report hash, ADR 0015's gate); `w6-parity-*` (the 10 parts); every perf spec.

**Owner checklist (about 60 minutes: the hands-on session)**
1. Model 3–5 of your own real parts by hand from blank: a bracket, a spacer, an enclosure, a knob.
2. Note each moment you reached for something that isn't there, or where it felt slower than Fusion or Shapr3D.
3. Select a face, press **⌘K**, and type "add a 1 mm chamfer here". Accept the ghost.
4. Restore a checkpoint.
5. Switch to X-ray and hidden-line.

**After FM6 you can** use PartZero as a complete single-part modeler, with the copilot in place on the canvas as well as in chat.

### 4.9 FM-W7 (T1a): exchange and copilot beta → FM7

| Workstream | Scope | Size |
|---|---|---|
| IO-7a | **STEP import, narrowed** (§1.3): a streaming Part 21 parser that handles complex instances; the entity subset; converting or adding surfaces Forge lacks (`surface_of_revolution`, `surface_of_linear_extrusion`, `offset_surface`, `rectangular_trimmed_surface`, composite and trimmed curves); seam removal (ADR 0012); tolerance checks; validation; an IR `import` revision with a naming rule (ADR 0019 §5; `Role::Imported` exists). The ABC differential run against OCCT is **reported as a measurement, not a gate.** A kernel track from FM-W4 | 2×L ≈ 18 |
| IO-7b | **STL/3MF (+ an OBJ reader) as reference meshes:** a `blobs` table, rendering, placement. Not editable and not usable in booleans | ≈ 5 |
| IO-7c | **DXF/SVG export** of sketches (solved geometry; construction curves on their own layer) and planar faces | ≈ 5 |
| IO-7d | **DXF/SVG import into a sketch:** lines, arcs, circles and polylines; units; layers to construction | ≈ 5 |
| VIEW-7 | **Reference image** with two-point calibration | ≈ 3 |
| DOC-7 | **Several windows:** per-window document state, access grants, close prompt, agent run; a Window menu | ≈ 4 |
| FEAT-7 | Holes above M8 and inch sizes (two sources per value); mm/inch display; material and a mass readout (ADR 0018 context, IR v1.1); feature folders; copy and paste features; keymap customization and a cheat sheet | ≈ 10 |
| AG-7 | **Tab** (5 deterministic proposers, ≤300 ms, off by default until its gate) and the **autonomy dial** (ADR 0015, NORTH-STAR B5), on the commit check from FM2 | ≈ 8 |
| SPEC-7, CS-7 | The `import` revision and `blobs` | ≈ 5 |
| QA-7, FIX-7, INT-7 | | ≈ 5 + 4 + 3 |

**Size:** ~75 agent-days, of which STEP import's 18 run as a kernel track from FM-W4; about 5 weeks.

**Owner checklist:** import a vendor STEP part (a motor or bearing model), measure it and place a sketch on one of its flat faces; import an STL as a reference and model around it; trace a calibrated photo; import a DXF into a sketch and extrude it; export a sketch as DXF; open two documents side by side; try Tab suggestions (turned on in Settings).

### 4.10 FM-W8 (T1b): freeform sketch and more features → FM8

| Scope | Size |
|---|---|
| **KRN-B** lands: B-spline faces in mass properties and bbox, SSI with B-spline surfaces (a track since FM-W3) | ≈ 12 |
| **Splines** (solver, IR, regions, extrude and revolve of spline profiles, oracle); spline import from DXF/SVG | L + L ≈ 17 |
| **Draft** (planar faces, SPEC §6.9; keeps the keys of tilted faces) | M–L ≈ 6 |
| **Text emboss and engrave** (glyph outlines to splines; licence check for any font parser) | L ≈ 8 |
| Ellipse; sketch pattern; associative offset (a new offset constraint) | ≈ 10 |
| Patterns along a curve or driven by sketch points; face patterns | ≈ 8 |
| **Fillet and chamfer features as pattern and mirror seeds** (SPEC, kernel, oracle) | ≈ 4 |
| **Fillets on crossing cylinders**, ellipse and B-spline edges (KRN-F2 on KRN-B) | ≈ 6 |
| Per-face shell thickness | ≈ 3 |
| Split face, thicken, rib | ≈ 7 |
| Wall-thickness and interference checks (ROADMAP A2, in `forge-check`) | ≈ 6 |
| Configurations or variants table (IR) | ≈ 4 |
| Laser pack (NORTH-STAR B9): flat-part detection, kerf compensation, simple nesting | ≈ 9 |
| SPEC, CS, AG, QA, FIX, INT | ≈ 20 |

**Size:** ~120 agent-days; about 6 weeks.

### 4.11 FM-W9 (T1c): F3-bound kernel features → FM9

- **Sweep** (L), **loft** (L), **modelled threads** by helical sweep (L).
- **Variable fillets**, setback and chord fillets (>L).
- **Local face operations** (ADR 0019): move, offset, replace and delete face (L+). Push/pull falls back to them on faces nothing drives, and on imported faces.
- Each ships behind its own gate, with definition-based oracles where OCCT is weak (ROADMAP A3, A4).

**Size:** ~100+ agent-days. **Timing:** F3 (M8–M14), unless FD2 approves restricted forms earlier.

### 4.12 Totals

| Span | Agent-days | Calendar |
|---|---|---|
| FM-W0 and FM1–FM1.1 (Alpha 0) | ~71 | ~3½ weeks after Phase C is committed |
| FM2–FM6 (T0) | ~468 | FM6 at ~22 weeks after Phase C |
| FM7–FM8 (T1a–b) | ~195 | ~11 weeks more |
| FM9 (T1c) | ~100+ | F3-paced |

T0 costs more agent-days than the first draft said (~540 against ~395). The additions are INT in every wave, the IR slice rows, FIX at about 10% of each wave, and the review's features: the origin and axes, planar projection moved earlier, H/V distances, reference repair, the Browser, model values, the failure rule, the commit check, `feasibleRange`, colors, split and lay flat, overhang shading, and the fillet-gap track. The calendar is set by critical paths plus 20%. If Phase C commits in early October 2026, T0 lands around early March 2027. That is inside ROADMAP Phase 1 (M2–M10), ahead of the closed alpha (~M7).

---

## 5. Verification

### 5.1 Per-tool e2e (Playwright-Electron, on the bundled app)

Every tool gets one spec. It drives the app with **real** mouse and keyboard events at points projected through `__pzTest.project` (C7), and reads state only through the test API. It asserts:

1. The panel prefills from the selection. A typed value and a handle drag both update the preview within the preview budget.
2. OK commits **one** transaction. The canonical IR equals the spec's golden (`corpus/fullmodel/golden/<tool>/*.json`).
3. Undo restores the previous canonical bytes; redo restores the next.
4. Save, quit and reopen keep it. The CadScript view shows the feature under its C9 name.
5. The error path: a value that doesn't build shows the error on the right field, with the feasible hint when Forge gives one. Nothing is committed.

**Determinism rules.** Positions from clicks and drags vary with window size and display scale, so:
- every pick that carries geometry lands on a snap target (a vertex, a midpoint, a grid point, the origin) or is followed by a typed value;
- the window size is fixed, the test build disables animation, and only app launch is retried;
- failure paths use C7's fault-injection points, never timing;
- goldens change only through `e2e:goldens`, and the diff is reviewed.

Specs are cumulative, through the manifest (§3.5): every build runs every earlier build's specs.

### 5.2 Command-layer tests

For **every** op in the catalogue:
- **Schema:** valid and malformed arguments. Unknown ids are refused with their `COMMAND_*` code and are never echoed when they fail the id grammar.
- **Refusal codes** carry their structured `details` (dependents, feasible ranges, candidates, newly failing features).
- **Inverse:** the recorded inverse restores the exact canonical bytes. The semantic inverse restores the same bytes. This is a property test over documents from the oracle's v1 generator (`oracle/src/aicad_oracle/v1/generator.py`).
- **Verification:** an op whose evaluated result doesn't match what it promises is refused with `COMMAND_NOT_EXACT`, as Phase C's ops are.
- **The failure rule:** the edited feature must build; a newly failing set must match its acknowledgement; property-tested over generated documents.
- **Authorship and the commit check:** a user op stamps `author`; agent and MCP ops can't set it; an unapproved change to a user feature is refused.
- **Store semantics:** serialization, atomic transactions, groups (open, seal, abort, undo inside), a preview never commits, and a transaction whose base changed is refused.
- **Fixtures:** `corpus/v1/ops/` pass in Rust (native and wasm32), TS and the CLI.

### 5.3 The same-command test

This proves §2.1. Each UI e2e records its transcript (`__pzTest.transcript()`: the committed ops with origin). Three replays of it must give **byte-identical canonical IR** and identical report hashes:
- `aicad op replay` (native Forge, through `forge-commands`);
- the agent's tool runner with a scripted transport, calling the generated op tools;
- the MCP host in headless mode (`@aicad/mcp-server/host`).

A catalogue snapshot test fails when a UI op has no agent or MCP tool and isn't on the host-only list.

### 5.4 Kernel and oracle cases for new ops

Every kernel addition follows CLAUDE.md principle 4, in the same PR:
- unit tests, property tests, and `forge-check` validation after the op;
- an oracle comparison through the v1 oracle, plus a generator family in the nightly differential;
- conformance fixtures for its amendment set;
- a naming-harness family when it creates or changes topology;
- golden hashes, and bit-identical results on all four targets.

| Addition | Build | Oracle note |
|---|---|---|
| Set A: implicit origin and axes, revolve `{ curve }`; `sketchEdit`, `convertSketch` | FM2, FM3 | Replay of solved geometry |
| `feasibleRange` | FM2, FM5 | Interval endpoints checked by building at the endpoint ± ε |
| Extrude `through_all` | FM3 | OCCT |
| H/V distances, planar projected curves, region arrangement (sketch `v: 2`) | FM4 | Replay; new region semantics in the oracle |
| `transform`, extents, `AxisRef`, `split`, constraint batch 2 | FM5 | OCCT for the geometry |
| Fillet gaps (KRN-F2) | FM5 | OCCT, plus definition-based corners (SPEC §8.3 rule 5) |
| STEP writer | FM5 | OCCT reads the file, BRepCheck passes, exact volume, area and bbox within 1e-6 relative, counts after seam normalization |
| Non-parallel projection, exact minimum distance | FM6 | OCCT `BRepExtrema` for distances |
| STEP import, reference meshes, DXF/SVG import | FM7 | ABC subset, differential against OCCT, reported as a measurement |
| Splines, draft, text, thicken, rib, fillet seeds, crossing-cylinder fillets | FM8 | OCCT, plus definition-based checks for draft angles |
| Sweep, loft, threads, variable fillets, face ops | FM9 | OCCT plus definition-based oracles (ROADMAP A3, A4) |

**Rule:** a silent-wrong result found by the oracle blocks the build (CLAUDE.md principle 2).

### 5.5 Agent evals on the same commands

- **Manual-parity set** (new, `corpus/makerbench/manual/`, grown by 3–5 tasks per wave). Each task gives a selection chip and a request ("fillet these edges 2 mm", "move this body 10 mm along X", "add an M3 countersunk hole here"). It is graded by the check DSL, **and** the agent must reach the result through op tools, not a CadScript rewrite. The transcript shows which.
- **MakerBench T4 edit tasks** are rerun on every build that changes the agent, its tools or its prompts.
- **No regression:** T1 pass@1 and benchmark NHL may not drop more than 2 points from the previous build (95% intervals published, as ROADMAP requires). Runs follow Alpha 0's rule: only when the agent changes, and outside the builder agents' plan windows.
- **Playbook coverage:** every new `COMMAND_*` or IR error code has a playbook. The existing coverage tests (`packages/agent-tools/test/`) are extended.

### 5.6 Performance budgets

Measured by `e2e/perf/*.perf.ts` on this Mac (Apple Silicon [fm5]), from the C7 marks, with n ≥ 20 per metric. **Only on a quiet machine:** in FG2a's nightly run while local builders are paused, or at hand-over with no builder running (`scripts/fm/worktree.sh status`). A sample taken while builders compile is discarded.

| Interaction | Budget (p95) | Fixture | Today |
|---|---|---|---|
| Sketch drag, input to presented frame (60 fps) | ≤16 ms; solve ≤4 ms | S200 | Solver 1.75 ms worst case (spike 04); no UI |
| Edit → screen (a typed value, OK, a parameter edit, undo) | ≤150 ms | R25 | 46.9 ms median, 48.1 ms p95 (spike 05, WebGPU main thread) |
| Edit → screen on a larger part | ≤250 ms (FM2–FM4), ≤150 ms from FM5 (prefix cache) | R50 | Unmeasured |
| Feature preview after typing stops | ≤250 ms (100 ms debounce + evaluation) | R25 | — |
| `feasibleRange` at drag start | Set by FM-W0's spike [fm13]; target ≤150 ms | R25 | — |
| Push/pull provisional frame / checked on release | ≤16 ms / ≤150 ms | R25 | — (NORTH-STAR B1 gate) |
| Hover pre-highlight | ≤16 ms | R50 | A pick runs every frame today |
| Box select (window) at 1440p | ≤50 ms | R50 | — |
| Open a `.partzero` to the first frame | ≤1.5 s | R50 | — |
| Cold start to an interactive window | ≤3 s | — | Unmeasured |

**Rule:** a build over budget, or more than 10% slower than the previous build on the same Mac, is handed over only if the owner accepts it as a known issue.

### 5.7 UX review

- **Every build:** an agent runs the owner checklist through the same driver and captures screenshots (the pattern of `e2e/screenshots.e2e.ts`). It then checks keys, panel behaviour and selection-first against §2.5, and lists the deviations in the acceptance report.
- **Checklists are dry-run by QA before hand-over**, so every step can pass on the build it names.
- **FM3:** the 30-minute hands-on. **FM6:** the one-hour session. The ROADMAP's hands-on bench (A1) runs later on the same builds.

---

## 6. Risks, assumptions and decisions

### 6.1 Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Phase C lands late, or its command layer changes from what was surveyed | FM-W0 waits for the commit. Contracts build on the committed ops. **Plan B:** pieces outside Phase C's files can start early in separate worktrees (VIEW-2's camera and trackpad, DOC-2, HIST-2's UI against a fake store). |
| R2 | Merge collisions with many agents in parallel | One owner per file (§3.2), registration points (§3.3), one integrator, merge windows twice a week, flags and the manifest (§3.5). Conflicts outside registration points go back to the file's owner. |
| R3 | Kernel long tail: up-to a general face, draft, splines, region arrangement, STEP import, fillet gaps | Planar and analytic cases first, an explicit error code for the rest. Kernel tracks stay off the UI critical path, in cloud sessions. Each ships behind its oracle gate. |
| R4 | B-spline gaps (SSI and mass properties, BACKLOG P1/P2) block splines, STEP import, crossing-cylinder fillets and sweep | KRN-B starts in FM-W3. STEP import is narrowed (§1.3). Splines don't ship until booleans on extruded spline faces pass the oracle. |
| R5 | Performance on larger parts: no regen cache; about 20 ms per boolean | The prefix cache in FM5 (earlier if fm9 fails); perf e2e on every build; provisional fast paths; a separate preview worker if previews delay commits. |
| R6 | Parametric intent lost by manual edits | The origin and axes and face edges as anchors; holes on point sketches dimensioned to edges; `convertSketch`; typed names become parameters; model values promotable; push/pull edits fields and parameters, never literal geometry; hole-wall drags step through standard sizes; a derived expression is never overwritten by a drag. |
| R7 | References break after manual edits | `refFor` is verified to resolve exactly; captures are written at commit; naming-harness families for every new topology-changing op; the repair UI in FM3. |
| R8 | Edits break later features quietly, or the agent and the user edit at once | The failure rule (§2.2) and the concurrency rule (§2.3), both in ADR 0021, property-tested in the store. |
| R9 | UI quality from agents without a designer | The conventions (§2.5), screenshot reviews every build, dry-run checklists, the FM3 and FM6 hands-on sessions, FIX in every wave. |
| R10 | Canvas e2e tests are flaky | §5.1's determinism rules; reads through the test API only. |
| R11 | Test hooks shipping in the app | `__pzTest` exists only with `AICAD_ALLOW_DEBUGGER=1` or in dev builds; a hardening test asserts it is absent from the alpha config. |
| R12 | The owner's Claude plan is shared by builder agents and evals | Evals run only when the agent or its tools change, outside builder windows (as in Alpha 0). Plan-window use is measured per agent-day [fm1]. |
| R13 | Owner time | 15–20 minutes per build, 30 minutes at FM3 and one hour at FM6; three decisions (§6.3); after FM1.1, a build every 3–6 weeks, with optional nightlies. |
| R14 | Scope pressure: the ask expects sweep, loft and face moves now | The honest table in §1.6 and FD2; restricted forms only behind their own gates. |
| R15 | Licences: font parsing, any new crate | `cargo deny` and the JS licence check in CI. No runtime CAD kernel, solver, mesher or renderer (CLAUDE.md principle 1). |
| R16 | Only this Mac is tested for these builds | Linux CI keeps the canvas-free specs and regains canvas coverage under xvfb in FM-W2; Windows and Linux builds follow the roadmap's signed-build work. |
| R17 | This Mac runs out of disk or memory with parallel Rust builds | §3.1 rule 6: three local Rust builders, sccache, cleanup at merge, a free-space floor, cloud sessions for kernel tracks [fm12]. |
| R18 | Common fillet workflows fail ("fillet after drilling the holes") | The "move before the hole" offer from FM3; KRN-F2 from FM-W3, landing in FM5. |

### 6.2 Assumptions

| # | Assumption | How we check it | If it's wrong |
|---|---|---|---|
| fm1 | Sizes are notional agent-days from the surveys and the review. The calendar is each wave's critical path plus 20%. Waves average 5–6 busy agents and peak at 11–12, and the owner's Claude plan sustains the peaks. | INT-0c measures 7-day-window use per agent-day in FM-W0; the preview's test week ended at 61% (ALPHA-0-PREVIEW §3). Actual days per workstream are tracked in `docs/fm/wN.md`. | Staff to what the plan sustains; waves stretch by the shortfall on their critical paths. The build order stays. |
| fm2 | Phase C lands as surveyed: 12 feature types evaluate (`draft` refused), the ops and `forge-wasm/src/commands.rs` exist, and fillet and chamfer are analytic-only. | FM-W0 reads the committed code before freezing C1. | Adjust C1; move items between waves. |
| fm3 | The preview branch (40 commits, 88 files) overlaps Phase C's uncommitted files only in `forge/crates/forge-cli/src/main.rs`, and `main` has no commits past the merge base `8279a60`. The real risk is behavioural: the preview rewrote `desktop/src/agent/{runner,engine}.ts`, which APPV1 must connect to v1. | INT-0a's trial merge on day 1; the preview's e2e and `--self-test` on the merged tree; APPV1's G2a a1–a10. | INT-0a grows by 1–2 days; FM1 slips by as much. |
| fm4 | The sketch solver in the main-thread WASM instance keeps drags ≤4 ms, and never queues behind a regen. | SKK-0's spike. | A dedicated sketch worker using SharedArrayBuffer (COOP/COEP already set). |
| fm5 | The owner's Mac is Apple Silicon on macOS 27; builds are arm64 only. | `scripts/alpha0-mac.sh` preflight. | As Alpha 0. |
| fm6 | `forge-render` can draw translucent bodies under WebGPU and WebGL2 within budget. | VIEW-3, first 2 days. | Ghosts drawn as edges plus a tint only; X-ray waits. |
| fm7 | Playwright can drive the canvas on the bundled app. Trackpad scroll is simulated with pixel-mode wheel events. Real pinch and rotate gestures are checked only by the owner. | QA-0's driver. | More owner checklist steps. |
| fm8 | The mouse presets and shortcut conventions come from product knowledge and the parity survey's sources, some of which could not be fetched (§6.4). | Check vendor docs before VIEW-2. | Adjust the presets; the architecture doesn't change. |
| fm9 | Edit → screen ≤150 ms holds on R25 without a cache; R50 needs the cache. | `perf/edit-to-screen.perf.ts` in FM2. | Pull ENG-5's prefix cache into FM-W3. |
| fm10 | Region arrangement fits sketch `v: 2` without changing any `v: 1` result (SPEC §4.4 rule 3). | SPEC review of set C. | Keep crossings refused until the rule is settled. |
| fm11 | The owner reviews each build within about 2 days of hand-over. | — | The next wave starts anyway; findings go into the next wave's FIX row. |
| fm12 | Three local Rust builders fit this Mac (14 cores, 48 GB, 54 GiB free on 2026-09-25) with sccache and cleanup at merge. | `scripts/fm/worktree.sh status` at every merge window: free space and active builders. | Move more agents to cloud sessions; prune old build profiles in the main checkout's 19 GB `target/`. |
| fm13 | `feasibleRange` for fillet `r` and shell `thickness` answers within about 150 ms p95 on R25, so handles know their limits at drag start. | ENG-0's spike. | Handles start unclamped and clamp when the range arrives; the cost goes into the perf report. |

### 6.3 Decisions

**For the owner:**

| # | Decision | Recommendation |
|---|---|---|
| FD1 | The order: T0 completely first (FM2–FM6), then T1 (FM7–FM9); T2 as its roadmap programs | Yes |
| FD2 | Start the F3-bound work (sweep, loft, threads, variable fillets, face ops) before F3. This moves roadmap rows from Phase 2 to Phase 1 beta for restricted forms | Start kernel spikes in FM-W5. Ship restricted forms behind their own gates, in FM8 if the spikes pass: a planar profile along a line or arc; **a helical sweep of a planar profile** (printed threads and springs: FM2's cosmetic threads print nothing); a ruled loft between two planar profiles; face ops on analytic faces. General forms stay F3. |
| FD3 | Default navigation: trackpad-first (Shapr3D-like) or a mouse preset (Fusion or Onshape style) | Tell us what you use. The proposed default: trackpad two-finger orbit, Shift+two-finger pan, pinch zoom; mouse right-drag orbit, middle-drag pan, wheel zoom; left-drag box select; a right click without a drag opens the menu. Other presets live in Settings. |

**Engineering defaults (they stand unless you veto them):**

| # | Default |
|---|---|
| FD4 | Body colors live in a geometry-free IR field (set B), next to ADR 0018's context block. The oracle ignores it, it round-trips through git and agents, and it feeds 3MF colors (FM3). |
| FD5 | Checkpoints live inside the `.partzero` file (`checkpoints/`). Automatic ones are pruned by a setting; manual ones never automatically (ADR 0015). |
| FD6 | Overlapping sketch curves are sketch `v: 2`. |
| FD7 | A new `transform` feature type (move, copy, rotate bodies; lay flat) as an additive IR v1 revision. It is the only way to move a body in v1. |
| FD8 | `scripts/alpha0-mac.sh` stays the installer for every build until the first signed build. |
| FD9 | ⌘K opens the palette until FM6. From FM6, ⌘K opens the AI quick edit when the canvas has a selection, and the palette otherwise; ⌘⇧P always opens the palette. |

**ADR 0021, "Manual modeling architecture"** (§2 of this plan), is written in FM-W0 and needs your acceptance, like ADRs 0015–0020.

### 6.4 External sources

These were used through the parity survey, accessed 2026-09-25, and treated as untrusted data.

- **Shapr3D:**
  - Selection filters both tools and history steps: https://www.shapr3d.com/blog/shapr3d-history-based-parametric-modeling
  - Hotkeys, from a third-party list that contradicts itself (unverified): https://defkey.com/shapr3d-windows-shortcuts
- **Fusion:**
  - Timeline and marking menu: https://help.autodesk.com/cloudhelp/ENU/Fusion-GetStarted/files/GUID-6514ABC1-CB75-4F0B-AB0E-316FAD36BA93.htm
  - Hotkeys (Autodesk's own shortcut page returned 403): https://productdesignonline.com/tips-and-tricks/autodesk-fusion-hotkeys-keyboard-shortcuts/
- **Onshape:**
  - https://cad.onshape.com/help/Content/Home/keyboard_shortcuts_and_hotkeys.htm
  - https://cad.onshape.com/help/Content/PartStudio/features_and_parts_lists.htm
- **Plasticity:**
  - https://doc.plasticity.xyz/all-commands
  - https://doc.plasticity.xyz/plasticity-essentials/plasticity-interface/selection-mode
- **Unverified:** Fusion's full Create/Modify menus, Change Parameters' model-value list, Onshape's toolbar beyond the fetched pages, and Plasticity's STEP export are product knowledge, not fetched pages.

### 6.5 Changes after the review (2026-09-25)

The review raised 46 points: P0 before FM-W0, P1 before the item's wave, P2 worth doing. All were adopted. Four were adopted with a change:

| Point | Change | Why |
|---|---|---|
| 3: revolve axis `{ line: "<curve id>" }` | Spelled `axis: { "curve": "<line id>" }` | `AxisRef` already uses `line` for an explicit 3D line (SPEC §3.2); one key must not mean two things. |
| 19: sccache **or** a shared target directory | sccache only, with per-worktree `target/` deleted at merge | Cargo locks a shared target directory, so parallel worktrees would serialize and rebuild each other's crates. |
| 36: a hand-made part in "B2" at about 7 weeks | FM3, at about 10 weeks | The 7 weeks had no buffer and a one-week Wave 0. With a two-week FM-W0 (point 20) and 20% buffers (point 29), the same scope lands at about 10 weeks. That is still 2–3 weeks earlier than the first draft's sketcher build on the same basis. |
| 40: a basic view cube in "B1" | FM2 (VIEW-2) | FM1 is Alpha 0 drop 0.1 with its scope unchanged (point 37, option a). Adding the cube there would put 0.1's date at risk; FM2 follows about 3½ weeks later. |

Also changed beyond the letter of the points:
- Point 9: hole clicks become an associative point sketch dimensioned to the face's edges (FM4), not literal coordinates.
- Point 39: the final layout ships in FM1 behind a flag, with a fallback to FM2.
- The sketch overlay is drawn as SVG by SKUI instead of in `forge-render`. This takes the sketcher off VIEW's critical path.
