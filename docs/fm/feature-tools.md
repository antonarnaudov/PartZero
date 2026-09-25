# Feature tools (modify and pattern): what is built

- **Status:** built on branch `worktree-wf_c69c637e-016-6` (from `fm-integration`, 2026-09-25).
- **Plan:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md), the feature-tools stream (Fillet, Chamfer, Shell, Draft, Linear / Circular Pattern, Mirror).
- **Where:** `forge/crates/forge-regen/src/v1/ref_for.rs`, `forge/crates/forge-blend/src/draft.rs`, `forge/crates/forge-regen/src/v1/blend.rs` (`draft`), `forge/crates/forge-wasm/src/commands.rs` (`refFor`), `packages/model-ops/src/picks.ts`, `packages/agent-tools/src/ops.ts` (`ref_for`, `feasible_range`), `packages/app/src/tools/builtin/{feature-kit,modify,pattern}.ts`, `packages/app/src/tools/model-selection.ts`, `packages/app/src/tools/framework/handles.ts`.

## One command for the hand and the agent

A tool never writes the document itself. OK commits the ops its panel builds (`addFeature` for a new feature, `updateFeature` for a re-edit) through `ir.apply`, the same transaction the agent's `add_feature` / `update_feature` run. The e2e test "the agent's op host builds the same fillet from the same JSON" checks that the agent's op and the tool's give byte-identical features (only `author` differs).

What the hand gets from the viewport, the agent gets from two read tools:

| Tool need | Hand | Agent / MCP (`ops-read`) |
|---|---|---|
| A Ref for picked geometry | clicks → `refFor` | `ref_for` (picks by render name or key, with the picked point) |
| The largest size that builds | shown on the field ("Builds with … Use 3.499 mm") | `feasible_range` (feature or candidate JSON) |
| Start a tool, prefill it, press OK | ribbon, palette, shortcuts | `tool.start {id, args}`, `tool.commit`, `feature.edit` |

### `refFor` (forge-regen `v1::ref_for`, WASM `refFor`)

Maps picks — a face, edge or vertex by render name or key plus the picked point, a body by origin — to entities in the scope of a feature inserted at a timeline position (the rollback marker, the end of the part, or an existing feature's input state for a re-edit). It synthesizes a query per entity with forge-refs, joins them with `union` (a face stands for its edges when an edge Ref is wanted; any entity for its owner body when a body Ref is wanted), resolves the Ref the way a feature would, captures it, and resolves it again. It returns only a Ref that is verified to resolve to exactly the picked set. The refusal codes are `PICK_NOT_FOUND`, `PICK_AMBIGUOUS`, `REF_NO_QUERY`, `REF_NOT_EXACT` and `COMMAND_INVALID_ARGUMENT`.

### Feasible ranges (`@aicad/model-ops` `feasibleRange`)

Fillet `r`, chamfer `d` and shell `thickness` are probed at 100 000 mm. When Forge answers `*_TOO_LARGE`, its `max_feasible_*` detail is the answer. When the size fails for another reason (`FILLET_FAILED`, `CHAMFER_FAILED`, `SHELL_FAILED` or `INVALID_RESULT`, for example a blend that runs into a pocket), the range is found by quartering (at most 24 steps), then bisecting to 0.0005 mm (at most 24 steps), rounding down to 0.001 mm and probing again (at most 3 times). The panel shows the result on the field with a **Use** button, and the handles clamp to it while dragging.

## The tools

| Tool (id, shortcut) | Inputs | Handle | Re-edit |
|---|---|---|---|
| Fillet (`feature.fillet`, Shift+F) | edges (or faces for all their edges), radius, tangent chain | radius, on the first edge's outward bisector | `updateFeature` |
| Chamfer (`feature.chamfer`) | edges; equal distance, two distances (with the face the first is measured on) or distance + angle | distance | `updateFeature` |
| Shell (`feature.shell`) | faces to open (none gives an inner void), body, thickness, inward / outward | thickness | `updateFeature` |
| Draft (`feature.draft`) | walls, neutral plane (origin plane, planar face or datum; default XY), angle (default 3°), flip pull | angle, a rotate handle about the hinge line | `updateFeature` |
| Linear pattern (`pattern.linear`) | features (timeline) or bodies, direction (axis, edge or datum), count, spacing, optional second direction, new body / join | spacing | `updateFeature` |
| Circular pattern (`pattern.circular`) | features or bodies, axis (origin axis, edge, cylindrical face, datum), count, angle, flip | angle (origin axes only) | `updateFeature` |
| Mirror (`pattern.mirror`) | features or bodies, plane (origin plane, planar face, datum) | — | `updateFeature` |

Each tool gets a live checked preview: the edited document is evaluated as you type, the bodies it touches are tinted, and the summary shows counts and volume. Forge's failures are mapped to the field they concern, with the feasible maximum where one exists. Picking works on the viewport's multi-selection, restricted to the kinds the active field accepts (a click toggles an entity). The timeline picks pattern seeds. A feature seed must be an extrude, revolve or hole (`PATTERN_SEED_UNSUPPORTED` otherwise, on the field).

### Draft (new in Forge)

SPEC-v1 §6.9 `draft` is now evaluated. `REJECTED_FEATURE_TYPES` is empty, and forge-cli and forge-wasm evaluate drafts. forge-blend's `draft` builds the result directly: each drafted planar wall is replaced by the plane through its hinge line, tilted by the angle toward the pull direction. Every vertex of a drafted wall moves to the meet of its faces' planes, and every edge with a moved vertex becomes the line through its new vertices. Keys are kept (§5.2). Before a body is returned it must pass these checks: every edge keeps its direction without collapsing or turning over, every face boundary is certified free of self-crossings, every changed face is certified to meet no other face away from what they share, forge-check validates the body and its volume is positive, and every loop passes the strict degenerate-loop rule (`ValidateOptions::strict_loops`, see [FORGE.md](../FORGE.md) "Degenerate loops"). If any check fails, the result is `DRAFT_FAILED` naming the faces. A face that is not planar, is not perpendicular to the pull, or is not on the body is `DRAFT_FACE_UNSUPPORTED`.

- **Tests:**
  - `forge-blend/tests/drafts.rs`: closed-form volumes (box, neutral at the top, reversed pull, one wall, an L prism with a reflex corner), refusals, a slot's curved neighbour, rib collapse, and a property test.
  - `forge-regen/tests/v1.rs`: the draft section.
  - `forge-cli/tests/cli_v1.rs` and `forge-wasm/src/engine.rs`: closed-form volume and export.
  - The oracle case `forge-regen/tests/v1_programs/draft_walls.json`: `oracle diff` gives MATCH, and Forge and OCCT agree to 1e-4 mm³ with the same face and edge counts.
  - The v1 golden hash was re-pinned (history in `v1_golden_hash.rs`).

## Tests

- **Rust:** `forge-regen` `ref_for_tests.rs` has 8 tests, including a property test over every face and edge of generated pocketed slabs. `forge-wasm` `commands_tests.rs` has the `refFor` tests.
- **TypeScript unit tests:**
  - `model-ops/test/picks.test.ts` covers the insertion point, `refFor` picks and the feasible-range search.
  - `agent-tools` has the `ref_for` / `feasible_range` snapshot and a fillet + shell + mirror chain.
  - `app/test/feature-tools.test.ts` runs every tool on the real WASM engine: preview, commit, the agent's identical op, feasible errors and **Use**, handles and the drag clamp, and re-edit.
  - `app/test/model-selection.test.ts` covers picking.
- **e2e:** `desktop/e2e/feature-tools.e2e.ts` has one scenario per tool on the real viewport:
  - clicks on projected points;
  - timeline picks;
  - handle drags that stop at Forge's largest radius;
  - **Use**;
  - undo and redo;
  - double-click re-edit;
  - screenshots.

## Gaps (honest)

- **Sketch-driven pattern** is not in IR v1: `pattern` has linear, circular and mirror layouts only. It needs a spec revision (`layout.sketch_points`) before a tool can exist.
- **Draft coverage:** planar walls whose neighbours are planar only. A wall next to a cylinder (a rounded corner) or a curved wall is refused, so draft before rounding. A cap cannot be drafted, and the neutral plane must be a plane.
- **Re-edit and removing picks:** in a re-edit, the feature's existing Ref members stay pinned. To remove one, clear the input and pick again.
- **Picking preview-only geometry:** a pick on geometry that exists only in the preview (for example a fillet face while the fillet is being previewed) gives `PICK_NOT_FOUND` on the field. The pick must be on the input state.
- **Re-edit view:** re-editing does not roll the view back to the feature's input state. The preview shows the whole model with the edit applied.
- **Handles:** the circular-pattern angle handle appears only with an origin axis, and the draft angle handle only with an origin plane as the neutral plane.
- **Feasible search cost:** when Forge cannot state a maximum, the search takes at most about 50 evaluations (quartering, bisection and re-probes; the count was not measured per case). It is debounced, and it runs only after a size failure.
