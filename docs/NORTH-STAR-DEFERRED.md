# NORTH-STAR deferred edits

The approved [NORTH-STAR.md](NORTH-STAR.md) changes need edits in files that Phase C is working in now (FORGE.md, BACKLOG.md, CLAUDE.md, IR-V1-IMPLEMENTATION-PLAN.md, ADR 0013, `forge/`, `packages/`, `oracle/`, `corpus/`, `.github/`). They wait here until those files are free. The last section also holds an edit to [CLI-PROVIDERS.md](CLI-PROVIDERS.md), which the integration pass did not touch. One bullet per change: the file, the section and the new wording.

## ADR 0018 (B7): design context in the IR, IR v1.1 (apply after Phase C)

Source: [adr/0018-design-context-in-the-ir.md](adr/0018-design-context-in-the-ir.md). All bullets edit `forge/crates/forge-ir/SPEC-v1-DRAFT.md`; land them in one SPEC PR with the v1.1 types and fixtures (frozen-interface rule).

- **Header, end of the "Revision log" paragraph.** Append: "**IR v1.1, design context** ([ADR 0018](../../../docs/adr/0018-design-context-in-the-ir.md)): an optional `context` block on `Document` and `PartStudio` (§12). Additive under §0.2 rule 5: the schema stays `aicad.ir/1`, and every v1.0 document is valid and keeps its meaning. New conformance fixtures, append-only: the strip property, typed-parse errors inside `context`, and context diagnostics."
- **§0.1 "What v1 adds", table.** Add the row: "| Design context | none | v1.1: optional document- and part-level `context` (material, process, machine snapshot, requirements, loads, decisions, assumptions); geometry-free (§12) |".
- **§0.3 rule 1, the "No echo" bullet.** Replace "Free-text fields (`meta`, `note`, `intent`, `author`, `assumptions`) are not restricted;" with "Free-text fields (`meta`, `note`, `intent`, `author`, `assumptions`, and every text field of `context`, §12) are not restricted;".
- **§0.4, first bullet.** After "empty `note`/`intent`/`author`/`assumptions`/`decision_ids`" insert ", and an empty `context` (v1.1, §12)".
- **§0.5 rule 4, step 5.** Append: "Structural validation does not look inside `context` (v1.1): problems there are context diagnostics (§12 rule 7), never rejections."
- **§6.0.1.** Append: "[v1.1] Each `decision_ids` entry names a `context.decisions` id (§12). A dangling one is the context diagnostic `CONTEXT_UNRESOLVED`. It is never a rejection and changes no report."
- **§8.2, "Not compared".** Append to the list: "`context` (§12), which the oracle loads, passes through and ignores, and the check report".
- **New section after §11**, tagged with the next free `[D-n]`:

  "## 12. Design context (IR v1.1)

  1. `Document.context` and `PartStudio.context` are optional objects (default empty, omitted when empty) with the members `material`, `process` and `machine` (at most one each) and the lists `requirements`, `loads`, `decisions` and `assumptions`. A part's effective context is the document's, with the part's `material`, `process` and `machine` replacing the document's where present and the part's lists appended after the document's.
  2. **Geometry-free.** No geometry field, parameter, expression or reference reads `context`. It is not part of any cache key and changes no field of `aicad.metrics/1`. **Strip property:** removing `context` from any document leaves its `aicad.metrics/1` report bit-identical.
  3. **Loading.** Only the typed parse (§0.5 step 4) applies to `context`: unknown fields, JSON types and the closed enums in `ir-v1.constants.json` (`CONTEXT_UNITS`, `PROCESS_KINDS`, `LOAD_KINDS`). Nothing in `context` is a rejection or a feature error. The oracle loads it, passes it through and ignores it.
  4. **Entries.** Every entry has an `id` (the id grammar of §0.3; unique among context ids in the document, in a namespace of its own) and an optional `author`. Free text is unrestricted and untrusted (§0.3). The field names and shapes are the Rust types in `forge_ir::v1`.
  5. **Quantities** are `{ "value": number, "unit": U }` literals with one stored unit per kind: `mm`, `deg`, `ratio`, `count`, `kg`, `N`, `N_m`, `MPa`, `degC`, `g_cm3`. v1.1 allows no expression in `context`.
  6. **References.** A context entry may name a parameter (by name), a `tag` feature (by id: `loads[].on`) or another context id. No context entry stores a query. Outside `context`, only §6.0.1's `decision_ids` name a context entry.
  7. **Diagnostics.** The check layer, not the evaluator, reports context problems, under the no-echo rule of §0.3: `CONTEXT_INVALID_ID`, `CONTEXT_DUPLICATE_ID`, `CONTEXT_UNRESOLVED`, `CONTEXT_UNKNOWN_CHECK`, `CONTEXT_UNIT_MISMATCH`. They appear in the check report, never in `aicad.metrics/1`.
  8. **Checks.** `requirements[].check` names a check of the check catalogue (an id plus a behavior version `v`), which is defined outside this spec. Requirement statuses (`met`, `unmet`, `cannot_verify`, `not_checkable`) are computed, never stored.
  9. **Writes.** Only command-layer ops inside the user's transaction write `context` (§0.6). Evaluation never writes it.
  10. **CadScript** prints `context` as one declaration block and compiles it back one to one. Its syntax, including any reserved name, keeps every valid v1.0 document valid."

## ADR 0013: pointers to ADRs 0018 and 0019 (apply after Phase C)

Source: [adr/0019-local-face-operations.md](adr/0019-local-face-operations.md) Follow-ups, and [adr/0018-design-context-in-the-ir.md](adr/0018-design-context-in-the-ir.md), which extends SPEC-v1 under ADR 0013. Both bullets edit `docs/adr/0013-ir-v1-references-and-parameters.md`. The other amended ADRs (0000, 0004, 0009, 0010, 0014) already carry their 2026-09-24 addenda.

- **Status line.** "Accepted (2026-09-23; decisions appended)" becomes "Accepted (2026-09-23; decisions appended); extended by [ADR 0018](0018-design-context-in-the-ir.md) (IR v1.1 design context) and [ADR 0019](0019-local-face-operations.md) (naming rules for local face operations)". This is ADR 0019's wording plus ADR 0018, which also extends SPEC-v1 under this ADR; apply it once if another entry repeats it.
- **New last section, after "Appendix: decision log (contract amendments)".** Add:

  "## Addendum (2026-09-24): IR v1.1 and local face operations

  The text above stays as written.
  - **[ADR 0018](0018-design-context-in-the-ir.md), design context.** IR v1.1, an additive revision of `aicad.ir/1` (SPEC-v1 §0.2 rule 5), adds an optional, geometry-free `context` block. Decision 5 deferred measured parameters to the same revision; either may land first, and the SPEC revision log records each. Context entries never store a query: a load names a `tag` feature by id.
  - **[ADR 0019](0019-local-face-operations.md), local face operations.** Four new feature types at F3 add rows to SPEC-v1 §5.2 (roles per operation): acted-on faces and their extended or trimmed neighbours keep their keys (modified), as `draft`'s tilted faces do, and `delete_face` gives new edges and vertices `G/edge:{A|B}`-style keys. Resolution stays as this ADR defines it: uncertain matches fail loudly. Editing imported STEP needs the `import` revision to key imported faces stably and to give queries a named source."

## ROADMAP.md update: F4 timing (B14) and the F3 gate (A4) in FORGE.md (apply after Phase C)

Source: [ROADMAP.md](ROADMAP.md), "Overview" and "North star: metrics and gates". NORTH-STAR B14 noted that FORGE.md puts F4 at M12–M18 while ROADMAP put it in Phase 5 (M20–M26). ROADMAP now keeps FORGE.md's dates as kernel work and ships F4's user features in Phase 5. FORGE.md keeps its dates; these bullets say how they map to phases and where sensitivities land.

- **FORGE.md, "Milestones" table, F4 row, Scope.** "Differentiable evaluation; native SubD, mesh and SDF (convergent modeling)" becomes "Differentiable evaluation; native SubD, mesh and SDF (convergent modeling). Analytic sensitivities for a few parameters come first, by M10 (NORTH-STAR B14). Users get F4 in ROADMAP Phase 5 (M20–M26): the SubD workspace, and the "optimize" tools that replace the Phase 2 search optimizer."
- **FORGE.md, "Milestones", the line under the table.** "M1 = Oct 2026. How these milestones map onto product phases is in [ROADMAP.md](ROADMAP.md)." becomes "M1 = Oct 2026. A milestone's dates are kernel work; the phase that ships it to users can come later. F4 (M12–M18) reaches users in Phase 5 (M20–M26). The full mapping is in [ROADMAP.md](ROADMAP.md)."
- **FORGE.md, "What makes Forge AI-native" table, row 6.** "**Differentiable evaluation** (F4)" becomes "**Differentiable evaluation** (F4; analytic sensitivities for a few parameters by M10, NORTH-STAR B14)".
- **FORGE.md, "Milestones" table, F3 row, Gate (A4).** "To be set before F3 starts" becomes "On an F3 blend and offset corpus of ≥1,000 cases (definition-based oracles, plus defillet cases if that bet works): Forge's valid-result rate ≥ OCCT's, and 0 silent-wrong (NORTH-STAR §7, row A4). It gates F3, not beta."

## ADRs 0016 and 0019: FORGE.md (apply after Phase C)

Source: the Follow-ups of [adr/0016-manufacturing-output-own-vs-hand-off.md](adr/0016-manufacturing-output-own-vs-hand-off.md) and [adr/0019-local-face-operations.md](adr/0019-local-face-operations.md). Until these land, FORGE.md's F5 row (M18+, "CAM toolpaths") contradicts ROADMAP Phase 3, ADR 0000's addendum and ADR 0016, which put our own 2.5D CAM at M14–M19.

- **FORGE.md, "Milestones" table, F5 row, Scope (ADR 0016).** "GPU compute (tessellation, analysis, batch evaluation for agents); `forge-sim`, a differentiable FEA validated against CalculiX; CAM toolpaths" becomes "GPU compute (tessellation, analysis, batch evaluation for agents); `forge-sim`, a differentiable FEA validated against CalculiX. CAM toolpaths moved to Phase 3 (M14–M19) under [ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)."
- **FORGE.md, "Crate map", new row after `forge-sim` (ADR 0016).** Add "| `forge-cam` | 2.5D toolpaths, GRBL and LinuxCNC posts, stock-removal simulation; Kiri:Moto as CI oracle ([ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md)) | Phase 3 |".
- **FORGE.md, "Crate map", `forge-io` row, "Lands in" (ADR 0016).** "F0 (STL/3MF), F1 (STEP)" becomes "F0 (STL/3MF), F1 (STEP), Phase 1 beta (DXF/SVG, ADR 0016)".
- **FORGE.md, "Milestones" table, F3 row, Scope (ADR 0019).** "Full NURBS surfacing: sweep, loft, general and variable blends, NURBS offsets, HLR for drawings, sheet-metal operations" becomes "Full NURBS surfacing: sweep, loft, general and variable blends, NURBS offsets, local face operations (move, offset, replace and delete face; ADR 0019), HLR for drawings, sheet-metal operations".
- **FORGE.md, "Crate map", `forge-ops` row (ADR 0019).** "Later: sweep, loft, thicken, variable blends, sheet metal." becomes "Later: sweep, loft, thicken, variable blends, local face operations (ADR 0019), sheet metal."

## NORTH-STAR A2, A3 and B10, and the Kiri:Moto oracle: FORGE.md (apply after Phase C)

Source: [NORTH-STAR.md](NORTH-STAR.md) §5 and §8 rows A2, A3, A4 and B10; the ADR 0000 addendum. FORGE.md's "Verification machine" and `forge-check` row predate them.

- **FORGE.md, "Crate map", `forge-check` row, DFM item (A2).** "DFM analyses: overhang, wall thickness via distance fields, minimum feature size, sharp internal corners for CNC." becomes "Per-process manufacturability (DFM) checks, each with per-process MakerBench tests that gate beta (NORTH-STAR A2): FDM (overhang, wall thickness via distance fields, minimum feature size); laser and sketch DXF/SVG (flat-part detection, closed profiles, units, minimum feature vs kerf or blade); CNC (sharp internal corners, inner radii vs tool). Resin checks follow in Phase 2 (B15)."
- **FORGE.md, "Verification machine", "Other layers" table, new row after "Invariants after every operation" (A3, A4).** Add "| Definition-based oracles | Check a result against the definition of its operation, independent of OCCT: a fillet against the rolling ball that defines it; a local face operation against its moved, offset or target surface ([ADR 0019](adr/0019-local-face-operations.md)). They cover fillets, shells and offsets, where OCCT is weakest. The fillet oracle's corpus gates Phase 1 exit with 0 silent-wrong (NORTH-STAR A3), and these oracles supply the F3 gate's corpus (A4) |".
- **FORGE.md, "Verification machine", "Other layers" table, new last row (B10).** Add "| Scale (NORTH-STAR B10) | A staffed track with its own compute line: public-repo CI runners, plus self-hosted if needed, sized from the first runs' wall time. Today: 200 generated programs per push (Linux only); 1,000 a week, scheduled but not yet run. Targets: weekly suite green by M3, 10k cases a night by M4, 100k by M10. Datasets join only after their licences are recorded |".
- **FORGE.md, "Design rules", "Ownership and licensing", oracle bullet (ADR 0016).** "OCCT, PlaneGCS, SolveSpace, OpenSubdiv, Manifold and CalculiX may appear **only** in `oracle/` or CI test tooling." becomes "OCCT, PlaneGCS, SolveSpace, OpenSubdiv, Manifold, CalculiX and Kiri:Moto (2.5D CAM toolpaths, ADR 0016) may appear **only** in `oracle/` or CI test tooling."

## BACKLOG.md (apply after Phase C)

Source: [NORTH-STAR.md](NORTH-STAR.md) §5, §7 ("How we measure the AI numbers") and §8 rows B4, B10, B15 and B18; [ADR 0020](adr/0020-funded-eval-keys-fallback.md).

- **"AI", P0 "Live bake-off needs API keys".** Append: "Keys, if any, follow [ADR 0020](adr/0020-funded-eval-keys-fallback.md): the owner creates and holds them, and funded eval runs start no earlier than open alpha. Before then the bake-off uses CLI plans or local models ([ADR 0014](adr/0014-cli-agents-as-providers.md))."
- **"CLI providers", P1 "A struggling task burns about 10 minutes on a CLI plan".** Append: "The cap is a stated precondition of the weekly NHL runs (NORTH-STAR §7), local background agents (B15), funded eval runs ([ADR 0020](adr/0020-funded-eval-keys-fallback.md)) and round-the-clock failure-zoo grinding (NORTH-STAR §5)."
- **"App", P2 "Transparent ghost overlay for proposals".** "**P2 Transparent ghost overlay for proposals** in forge-render. Today it's a tinted toggle." becomes "**P2 Transparent ghost overlay for proposals** in forge-render, scheduled for Phase 1 alpha (NORTH-STAR B4). Today it's a tinted toggle."
- **"Oracle / verification", P1 "Run the nightly differential job in CI".** Append: "NORTH-STAR B10 sets the targets: weekly suite green by M3, 10k cases a night by M4, 100k by M10, on the verification machine's compute line (ROADMAP Phase 1, "Verification machine")."

## CLAUDE.md (apply after Phase C)

Source: the ADR 0000 addendum and [ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md) (Kiri:Moto as an oracle; the slicer rule); [ADR 0020](adr/0020-funded-eval-keys-fallback.md) decision 5 (keys). Agents read CLAUDE.md, so these rules belong there as well as in the ADRs.

- **"Non-negotiable principles", item 1, second sub-bullet.** "OCCT, PlaneGCS, SolveSpace, OpenSubdiv, Manifold and CalculiX may be used **only** in `oracle/` or CI test tooling." becomes "OCCT, PlaneGCS, SolveSpace, OpenSubdiv, Manifold, CalculiX and Kiri:Moto (2.5D CAM toolpaths, [ADR 0016](docs/adr/0016-manufacturing-output-own-vs-hand-off.md)) may be used **only** in `oracle/` or CI test tooling."
- **"Non-negotiable principles", item 1, new last sub-bullet.** Add: "Slicers, laser software and machine senders are hand-off targets: launch the one the user installed; never bundle, link or embed one ([ADR 0016](docs/adr/0016-manufacturing-output-own-vs-hand-off.md) §3)."
- **"Non-negotiable principles", new item 6.** Add: "6. **Never touch API keys.** Never ask for a key; never open, print, copy or search `.env`; never echo `*_API_KEY` variables; never write a key into a file, commit, log, issue or CI config. If you see a key by accident, stop and tell the owner without repeating it ([ADR 0020](docs/adr/0020-funded-eval-keys-fallback.md) decision 5)."

## IR-V1-IMPLEMENTATION-PLAN.md (apply after Phase C)

Source: [NORTH-STAR.md](NORTH-STAR.md) §7, row "Feasible range reported"; ROADMAP "Feature gates".

- **§1 "Workstreams at a glance", W6 row, "Delivers".** "blends and offsets with feasible-range errors" becomes "blends and offsets with feasible-range errors; a report of the share of single-parameter out-of-range errors (fillet radius, shell thickness, extrude depth, hole size) on the F2 corpus that return a feasible interval (target ≥90% by F2, NORTH-STAR §7; reported, not part of the F2 gate)".

## CLI-PROVIDERS.md: ADR 0015 follow-ups (not a Phase C file; apply any time)

Source: [adr/0015-autonomy-dial.md](adr/0015-autonomy-dial.md), Follow-ups, "Docs". The integration pass did not include this file.

- **§3.3 "Agent-runtime mode", new paragraph after "`ask_user` in runtime mode".** Add: "**The autonomy dial in runtime mode** ([ADR 0015](adr/0015-autonomy-dial.md)). The PROPOSE gate is unchanged. What follows a passing gate is set by the dial and decided by our orchestrator and the host's commit check, never by the CLI; runtime and completion modes behave the same. A CLI's own permission or approval mode never counts as the user's approval. At Ask at each step, the per-step pause uses the broker's user-wait path, as `ask_user` does. If the CLI cannot hold a tool call open long enough for the answer (`capabilities.maxToolCallMs`), BUILD runs in completion mode for that task."
- **§6.2 "Tools from the registry", `annotations` row.** "`destructiveHint` is false because every edit lands on the draft branch and is reviewed." becomes "`destructiveHint` is false because every edit lands on the draft branch and reaches the document only through the dial's commit rules ([ADR 0015](adr/0015-autonomy-dial.md))."
- **§6.7 "Session binding and branches", first bullet.** "**Nothing reaches the user's document** until they accept the proposal in the existing review UI (ARCHITECTURE §7)." becomes "**Nothing reaches the user's document** except through a commit the autonomy dial allows ([ADR 0015](adr/0015-autonomy-dial.md)): by default the user accepts the proposal in the existing review UI (ARCHITECTURE §7), and nothing is ever auto-applied to user-authored features." The bullet's second sentence stays.
