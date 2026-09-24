# ADR 0018: Design context in the IR

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** owner (approved [docs/NORTH-STAR.md](../NORTH-STAR.md))
- **Plan reference:** [NORTH-STAR.md](../NORTH-STAR.md) §3 ("Design context in the model") and §8 row B7.
- **Extends:** [ADR 0004](0004-feature-graph-ir.md) and SPEC-v1 ([SPEC-v1-DRAFT.md](../../forge/crates/forge-ir/SPEC-v1-DRAFT.md), governed by [ADR 0013](0013-ir-v1-references-and-parameters.md)), through an additive revision, IR v1.1. The SPEC edit is deferred (see Follow-ups).

## Context

- **What the part must do has no home in the model.** The IR stores geometry intent: parameters (`mm`, `deg`, `ratio`, `count`, `bool`), features and references. Material, process, machine, loads and requirements live in chat or in the user's head. Features already carry free-text `intent`, `assumptions` and `decision_ids`. SPEC-v1 §6.0.1 makes them non-semantic, and the decisions that `decision_ids` point to are stored nowhere.
- **The plan so far put this in side files.** ARCHITECTURE §6 "Project memory" plans `design/spec.md` (requirements with ids) and `design/decisions.jsonl`. Side files sit outside IR transactions. Edits to them do not undo with the model. They are not in the plain `.json` export for git and agents, not schema-checked, and not reachable by MCP clients through the one command layer. They drift from the model.
- **The approved North Star needs this as data.** NORTH-STAR §3: material, process, machine, loads and requirements become editable values in the model. A load badge such as "5 kg: SF 1.8–3.4 (PLA, printed flat, 20% infill)" turns red when you thin a wall, with no LLM call. Other approved items read the same values:
  - B6: the handbook, 8 calculation tools and closed-form checks (material, loads, process);
  - A2: per-process manufacturability checks (process, machine);
  - B8 and [ADR 0016](0016-manufacturing-output-own-vs-hand-off.md): machine profiles with measured clearance, and export receipts that list the "checks passed against a named machine profile";
  - benchmark NHL (§7): an export must pass "its machine profile's process checks";
  - ARCHITECTURE §6–7: the agent's SPEC step, the spec card, and assumption chips ("PLA · 0.4 nozzle · M3 · 0.2 clearance") that regenerate with no LLM call.
- **Honesty rules apply to every number** (NORTH-STAR §3 and §9). Each engineering number shows its formula, inputs and source. When no formula fits, the answer is "can't verify", never a guess. We never say "certified" or "safe". Printed-part safety-factor badges ship only after Fit Lab break tests.
- **Two engines, one spec.** Forge and the OCCT oracle implement SPEC-v1 independently, and both must track every IR change (ADR 0004). The oracle has nothing to compute for a material or a requirement. Design context should cost it nothing beyond accepting the schema.
- **Timing.** Phase C (F1) is implementing SPEC-v1 now, and its contract types (I1) are frozen. SPEC-v1 §0.2 rule 5 allows additive revisions that keep `aicad.ir/1`: a new optional field whose default keeps the meaning. ADR 0013 decision 5 already deferred measured parameters to such a revision, v1.1. Unknown fields are rejected (SPEC §0.5), so a reader that predates the revision rejects a document that uses it.
- **Free text is an injection surface.** SPEC-v1 §0.3 requires tools to mark free-text fields as untrusted data when they show them to a model.
- **Privacy.** Design context is design content. It stays in the user's local file ([ADR 0010](0010-local-first.md)). ADR 0017's opt-in counts never include design content.

## Decision

We will store design context in the IR as a typed, geometry-free `context` block. It lands in IR v1.1, after Phase C.

### 1. A `context` block, geometry-free by construction

1. IR v1.1 adds an optional `context` object to `Document` (applies to every part) and to each `PartStudio` (applies to that part). Both default to empty, and canonical JSON omits an empty one.
2. **Nothing reads context during evaluation.** No geometry field, parameter, expression or reference may read a context entry. Context is not part of any feature cache key. It changes no field of `aicad.metrics/1`.
3. **The strip property is normative.** For every document, removing `context` leaves the `aicad.metrics/1` report bit-identical. A Forge property test and the conformance fixtures pin it.
4. **The oracle ignores it.** The oracle's loader accepts the block through the generated schema and passes it through unchanged. The oracle never evaluates it, never validates it beyond the schema, and `kernel-diff` never compares it.
5. **Context never rejects a document and never fails a feature.** Only the typed parse applies (unknown fields, JSON types, closed enums). Every other problem is a **context diagnostic** with a `CONTEXT_*` code in the check report (§4). Examples: a duplicate or malformed context id, a dangling reference, an unknown check, a unit that does not fit its check. A broken requirement never stops the part from building.

### 2. What the block holds

Every entry has an `id` and an `author`, as features do. Context ids follow the id grammar of SPEC §0.3 and are unique among context ids in the document. They form their own namespace, separate from feature and parameter names. Free text is not restricted and is always untrusted.

| Entry | Holds | Main readers |
|---|---|---|
| `material` (one) | A handbook material by versioned id, plus optional property overrides, each with a source | Calculation tools, load checks, mass |
| `process` (one) | A process kind from `PROCESS_KINDS`, one checked-in closed list in the IR constants file that follows NORTH-STAR §4's machines (`fdm`, `resin`, `sls`, `laser`, `cnc_router`, …; default `any`). [ADR 0017](0017-opt-in-product-counts-and-failure-reports.md)'s export counts use the same list. Plus the settings checks need (orientation, infill, layer height, perimeters) | Per-process checks, badges |
| `machine` (one) | A **snapshot** of a machine profile: its name, profile id and version, and the values checks use (bed size, nozzle, kerf, tool radius, measured clearance and when it was measured) | Per-process checks, export receipt |
| `requirements` (list) | Text, plus optionally one check from the check catalogue (§4) with its arguments | Spec card, requirement status, agent |
| `loads` (list) | Kind (`force`, `mass`, `torque`, `pressure`), a quantity, an optional direction, an optional `on` (the id of a `tag` feature) and an optional load-case name | Load checks; FEA later (ROADMAP Phase 5) |
| `decisions` (list) | Text, `because` (ids of requirements, loads or assumptions) and cited sources | "Why?" on a value. Features' existing `decision_ids` now resolve here |
| `assumptions` (list) | Text, what it is about (a context id or a parameter name), and `confirmed` (default false) | Assumption chips, spec card, agent |

An illustrative example (the SPEC revision fixes the field names):

```json
"context": {
  "material": { "id": "mat", "handbook": "std:pla@1" },
  "process": { "id": "proc", "kind": "fdm", "orientation": "+Z", "infill": 0.2 },
  "machine": { "id": "mk4", "profile": "user:mk4@3", "nozzle": 0.4, "clearance": 0.2 },
  "loads": [{ "id": "L1", "kind": "mass", "value": 5, "unit": "kg", "direction": "-Z", "on": "t_mount" }],
  "requirements": [{ "id": "R1", "text": "Holds a 5 kg shelf", "check": { "id": "load_margin", "v": 1, "load": "L1", "min_sf": 1.5 } }],
  "decisions": [{ "id": "D17", "text": "Wall 3.6 mm keeps SF >= 1.5 at 5 kg", "because": ["R1", "L1"] }],
  "assumptions": [{ "id": "A1", "text": "20% infill", "about": "proc" }]
}
```

Rules:
- **Quantities are literals with one stored unit per kind**, as lengths are always stored in mm: mm, deg, ratio, count, kg, N, N·m, MPa, °C and g/cm³ (the SPEC revision sets their ASCII tokens). The UI may show other units. Context values are not expressions in v1.1. The one evaluator of record (ADR 0013 decision 11) and the oracle's copy of it do not change.
- **Context points at the model; the model never points at context.** The one exception is the existing, non-semantic `decision_ids`. A context entry may name a parameter (by name) or a `tag` feature (by id). It never stores a query. A load "on the mount face" goes through a `tag`, which is already a stable, named handle (SPEC §6.12).
- **Every number a check uses carries a source:** a handbook entry, a measurement (a fit coupon, B8; a break test), or `user` when the user typed it without one. Checks show the source. Handbook values follow B6: formulas or cited facts, never copied tables, and never a slicer's filament profiles (ADR 0016).
- **Machine profiles are snapshots.** The profile library lives in the app's settings, outside the design. Attaching a profile copies the values checks use, so the file stays self-contained and its checks reproduce on another computer. When the library profile changes (for example after a new fit coupon), the app offers an update. It never applies one silently. An export may check against another profile; its receipt names the one it used.
- **Scope.** A part's effective context is the document's context, with two changes: the part's `material`, `process` and `machine` replace the document's where present, and the part's lists are added to the document's.

**Out of scope for v1.1:** per-body materials (multi-material 3MF), load combinations, FEA boundary conditions, tolerances and GD&T, and cost. Each one can come later as an additive revision.

### 3. Edits, authorship and the agent

- **Context edits are domain ops** inside transactions with inverses (`setMaterial`, `setProcess`, `setMachine`, `addRequirement`, `addLoad`, `logDecision`, `confirmAssumption`, …). They go through the one command layer that the UI, agent, CLI and MCP share. They undo, diff and merge like feature edits.
- **The agent never silently changes user-authored context.** It proposes context entries on its draft branch, as it does features, and they follow the autonomy dial (ADR 0015). An agent-authored entry stays agent-authored until the user accepts or edits it. External agents land on their `mcp/<client>` branch.
- **The agent's DesignSpec is stored here.** The SPEC step (ARCHITECTURE §6) writes `requirements`, `loads` and `assumptions`, and the `log_decision` tool writes `decisions`. The frozen CADTests stay test files. The context says what the part must do; the tests are how the agent shows it.
- **CadScript prints the context** as one declaration block at the top of the file and compiles it back one to one. The SPEC revision picks its exact syntax, including any reserved name, so that no valid v1.0 document becomes invalid.
- **Every free-text context field is untrusted** when a tool shows it to a model (SPEC §0.3, W10).

### 4. Checks read context; results live in their own report

- **A check catalogue** in the check layer (A2's process checks in `forge-check`, B6's calculation tools) defines each check by id and behavior version `v`, as feature types are defined. Examples: `max_mass`, `min_wall`, `fits_bed`, `load_margin`. Checks are deterministic, run locally and call no LLM. New checks join the catalogue, not the IR schema. An older app shows a newer check as "not checkable in this version".
- **Each requirement gets one status per evaluation:**
  - `met` or `unmet`;
  - `cannot_verify`, with the reason: a missing input, no formula that fits, or a printed part outside validated cases;
  - `not_checkable`, for text-only requirements.

  Margins are ranges shown with their formula, inputs, simplifications and sources. Statuses are computed, never stored in the IR (evaluation is a pure function, SPEC §0.6).
- **Results go in a separate check report**, not in `aicad.metrics/1`. The frozen metrics schema, the golden corpora and `kernel-diff` do not change. The check report's schema is set with A2 and B6. The export receipt copies the requirement statuses and names the machine snapshot.
- **Existing gates bind the checks.** Printed-part load checks return `cannot_verify` until the Fit Lab break tests for that material exist. A calculation check ships only after its golden cases pass (100% of at least 150 cases within 1% before the tools ship, NORTH-STAR §7).

### 5. How it lands

- **IR v1.1, after Phase C.** It is an additive revision of `aicad.ir/1` (SPEC §0.2 rule 5). The schema string does not change. Every v1.0 document is a valid v1.1 document, unchanged. Migration from v0 adds no context. ADR 0013 decision 5 deferred measured parameters to the same revision; either may land first, and the SPEC revision log records each.
- **It changes the frozen I1**, so it follows the frozen-interface rule: a SPEC PR plus append-only conformance fixtures, reviewed by the Rust, TypeScript and Python consumers. The SPEC wording waits in [NORTH-STAR-DEFERRED.md](../NORTH-STAR-DEFERRED.md) until Phase C releases SPEC-v1-DRAFT.md.
- **Old readers.** A reader that implements only v1.0 rejects a document with context. The plain `.json` export can leave the context out for such readers; by the strip property, that loses no geometry.

## Consequences

- **Positive:**
  - The example badge works with no LLM call. Editing a wall or the load reruns the checks locally.
  - One file carries the design, what it must do and why. A shared `.json` keeps its requirements, and git diffs show requirement changes next to feature changes.
  - One set of values drives the checks, the receipts, NHL's process checks and the agent, so they cannot disagree.
  - "Why 3.6 mm?" resolves to a stored decision with its sources. Features' `decision_ids` finally point at something.
  - The oracle, `aicad.metrics/1`, the golden corpora and `kernel-diff` are untouched. The strip property is a cheap test that keeps it that way.
  - Undo, branches, the autonomy dial and MCP apply to context with no special path.
  - The check catalogue grows without schema changes, and older apps degrade to "not checkable".
- **Negative / costs:**
  - About 3–4 AW (NORTH-STAR B7): Rust types and schema, regenerated TS and zod types, command-layer ops, the CadScript printer and compiler, the spec card and chips, the oracle's schema pass-through, fixtures and diagnostics.
  - A second kind of typed value next to parameters. Geometry cannot depend on a load: there is no `wall = f(load)` expression. That is deliberate. Sizing from loads goes through checks, and later through the Phase 2 search optimizer (B14). Changing this needs a new ADR, because it would pull context into the evaluator and the oracle.
  - Machine snapshots can go stale against the user's library. The update offer must be clear.
  - More free text reaches models. W10's untrusted marking must cover every context field.
  - Readers that implement only v1.0 reject documents with context. This matters for third-party readers and the conformance runner (B13).
  - A "met" requirement is only as good as its check. The mitigation is showing formula, inputs and sources, and saying "can't verify". The catalogue needs its own golden cases and behavior versions.
  - A malformed context is not rejected at load. The spec card must show context diagnostics where the user will see them.
- **Follow-ups:**
  - SPEC-v1 v1.1 text (a new §12 plus small edits to the revision log, §0.1, §0.3, §0.4, §0.5, §6.0.1 and §8.2): recorded in [NORTH-STAR-DEFERRED.md](../NORTH-STAR-DEFERRED.md), applied after Phase C.
  - The v1.1 work after Phase C: `forge-ir` types, `ir-v1.schema.json` and constants (context units; process kinds as `PROCESS_KINDS`, shared with ADR 0017's counts), `@aicad/ir-types`, the oracle's loader, and conformance fixtures (strip property, parse errors, diagnostics).
  - [ARCHITECTURE.md](../ARCHITECTURE.md): §3 adds `context` to the `Document` shape. §6 "Project memory" replaces `design/spec.md` and `design/decisions.jsonl` with the context; a Markdown spec becomes a generated view, never a second source. §7's assumption chips and spec card read the context.
  - Mark ADR 0004 "Extended by ADR 0018", and add 0018 to the [ADR index](README.md).
  - The check-report schema and the first catalogue checks, with A2 and B6.
  - MakerBench tasks declare their process and machine through the same block, so NHL's process checks have a defined profile.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Side files in the project (`design/spec.md`, `design/decisions.jsonl`), as ARCHITECTURE §6 planned | Outside transactions and undo, missing from the plain `.json` export, not schema-checked, and not reachable through the command layer. They drift from the model, and a badge cannot read them deterministically. The Markdown spec survives as a generated view. |
| A sidecar `context.json` inside the native zip | Two canonical files and transactions that span both. The plain `.json` export for git and agents would still lose it. |
| Context as ordinary IR parameters, with new units (N, kg, MPa) in the expression language | Widens the one evaluator of record and the dimensional analysis that the oracle re-implements at 1e-12. It puts non-geometric values into `kernel-diff`, and it lets geometry read loads, so the oracle could no longer ignore context. |
| Free text only (more `meta.description`, feature `note` and `assumptions`) | Cheap, but nothing is checkable. A badge would need an LLM, and numbers would carry no source. |
| Keep context in the user's app settings, not in the design | A shared design would lose what it must do, and its checks would not reproduce on another computer. The profile library stays in settings; the design keeps a snapshot. |
| Loads that store their own geometry queries | Resolving context would become evaluation, and the oracle would have to replay it. `tag` features already give stable, named handles. |
| Let the oracle check the calculations too | OCCT has no counterpart for a safety factor or a fit. Golden cases and Fit Lab break tests verify calculations; the oracle stays on geometry. |
| A new schema version, `aicad.ir/2` | Not needed. The change is additive and its default keeps meaning (SPEC §0.2 rule 5). A major version would force a migration of every file. |
| Land it in v1.0 now | It would reopen the frozen I1 during Phase C, which is on the critical path to F1. |
| Reject documents with a malformed context | A typo in a requirement would stop the part from building. It would also make the oracle implement context validation to keep rejections identical in both engines. |
