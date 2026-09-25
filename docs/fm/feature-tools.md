# Feature tools (create and construct): what is built, and the integrator's notes

- **Status:** built and tested on branch `worktree-wf_c69c637e-016-5` (2026-09-25), on top of
  `fm-integration` (0d74c92). Not pushed.
- **Plan:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md) T0 items 1–4, 8, 11 and §2.6 (push/pull),
  [NORTH-STAR.md](../NORTH-STAR.md) B1. Command layer: [command-layer.md](command-layer.md).
- **The rule this stream follows:** every hand tool is **one command**. The panel in the app, the
  app command `model.*`, the agent's tool and the MCP tool all run the same modeling command
  (`@aicad/model-ops`, `src/modeling/`), which turns typed arguments into catalogue ops
  (`addFeature`, `updateFeature`, `renameFeature`, `setParam`) and commits them as **one
  transaction** (one undo step, the failure rule, agent authorship). No tool writes code.

## The tools

| Tool (key) | Command · app command · agent/MCP tool | What it does | Tested by |
|---|---|---|---|
| Extrude (E) | `extrude` · `model.extrude` · `extrude` | Profile regions of a sketch; distance (number or expression) with a drag arrow; one side / flip / symmetric; **through all** (cut or intersect); **up to** a planar face, datum or origin plane (follows it); new body / join / cut / intersect with target bodies (click any face) | `model-ops/test/modeling.test.ts` "extrude", `app/test/create-tools.test.ts` (4 extrude tests), e2e "Extrude (E)", "Extrude extents" |
| Revolve | `revolve` · `model.revolve` · `revolve` | Axis: the sketch's u/v axis or one of its lines (a construction line is offered first); angle with a rotate ring; one side / symmetric; body operations | modeling "revolve", app "Revolve", e2e "Revolve" |
| Hole (H) | `hole` · `model.hole` · `hole` | Simple, counterbore, countersink (ISO sizes or a custom diameter, fit), cosmetic thread, heat-set insert; on a face at the clicked point, typed (u, v), sketch points, a grid or a bolt circle; through or blind (depth arrow), tip, flip | modeling "hole", app "Hole" (3), e2e "Hole (H)", "Hole: re-edited" |
| Plane (Construct) | `datum_plane` · `model.datumPlane` · `datum_plane` | Offset (arrow), angle about an axis, midplane of two planes, three points | modeling "datum plane and axis", app, e2e "Plane and Axis" |
| Axis (Construct) | `datum_axis` · `model.datumAxis` · `datum_axis` | Along an edge, a cylinder's axis, two planes' intersection, two points; flip | same |
| Combine | `boolean` · `model.combine` · `combine` | Join / cut / intersect target bodies with tool bodies (picked by any face), keep tools | modeling "combine", app, e2e "Combine" |
| Push/Pull (Q) | `push_pull` · `model.pushPull` · `push_pull` | Edits the face's **driver**, never the geometry: extrude end cap → `distance` (sign-aware for cuts, ×2 symmetric), revolve end cap → `angle`, custom hole wall → `d`, shell face → `thickness`; a bare parameter is set instead; an expression is refused (`MODEL_DERIVED_VALUE`), a side face or an extent extrude's cap too (`MODEL_NO_DRIVER`, saying what to edit) | modeling "push/pull", app, e2e "Push/Pull (Q)" |
| Move/Copy (M) | `move` · `model.move` · `move_bodies` | Bodies (picked by any face) translated (X/Y/Z arrows) and rotated (ring) about X/Y/Z or a picked edge/axis; copy keeps the originals | modeling "move/copy", app "Move/Copy", e2e "Move/Copy (M)" |

Every panel: typed fields with units and expressions, selection inputs with counts, a live
checked preview (changed bodies tinted, the candidate evaluated before commit), manipulator
handles placed from the previewed geometry, the engine's errors on the field they belong to (with
the feasible range when the engine's details give one), OK = one transaction, and re-editing
the feature from the timeline in the same panel (`updateFeature` with a minimal patch). The
same-command rule is pinned by `app/test/create-tools.test.ts` ("a hole made in the panel, by
model.hole and by the agent's hole tool is the same document") and `mcp-server/test/ops.test.ts`
(an MCP client drills a hole through the broker).

## IR amendment set F (new kernel features)

The tools needed two things the IR did not have; both are additive (SPEC-v1 §6.2, §6.13, §11.2):

- **Extrude extents:** `extent: "through_all"` (cut/intersect only) or `{ "up_to": PlaneRef }`
  instead of `distance`. Codes: `EXTRUDE_EXTENT_CONFLICT` (R), `EXTRUDE_UP_TO_NOT_PARALLEL`,
  `EXTRUDE_UP_TO_BEHIND` (E).
- **`transform`:** move or copy bodies by a rigid motion. A move keeps every key (junction
  qualifiers are stamped into the provenance so they survive the move; `forge-regen/src/v1/transform.rs`);
  a copy is a one-instance body pattern (`T/copy:{K}@1`).

Everywhere in the same change: forge-ir (types, validation, canonical, migration, schema),
forge-regen, the OCCT oracle (both programs MATCH; the whole `v1_programs` directory MATCH=33),
ir-types, CadScript (`transform(…)`, `extrude(sk, { throughAll | upTo })`), agent repair hints,
fixtures. Golden hash re-pinned to `0xc0a1_01f4_0697_a26b` (the earlier programs' hash is unchanged).

## Integrator notes

- **Wiring:** `tools/builtin/features.ts` → `registerCreateTools` (the old extrude panel is gone);
  `ui/shell/install.ts` binds the runtime selection port and the manipulator handles port;
  `MODEL_COMMANDS` are spread after `IR_COMMANDS` in `commands/commands.ts`; `OPS_TOOLS` in
  agent-tools includes the modeling tools (so the `ops` MCP scope has them).
- **WASM:** `packages/forge-web/pkg` is git-ignored: rebuild it (`node scripts/build.mjs` in
  `packages/forge-web`) after merging, or the app's engine lacks `transform` and extents.
- **Recorded engine fixtures** (`agent-tools/test/fixtures/v1-{forge,oracle}-reports.json`): only
  the new entries were added (two `extrude_up_to_*` programs, the new conformance case, and
  `unsupported-feature-type`, whose supported list now names `transform`). A full re-record also
  brings the engines' other drift since the last recording (fillet limit details, shell messages,
  draft and sketch scenarios on the oracle), which breaks unrelated expectations; that re-record
  belongs to the playbook owner.
- **Pre-existing failures, not from this stream** (present on 0d74c92):
  `forge-ir/tests/v1_conformance_amendments.rs` `boolean_identity_fixtures` (eight
  `FORGE_PENDING_BOOLEANS` cases now pass: remove them from the list); CadScript's seven
  expression-checker stack overflows (`e377`, `e390`, `e399`, `e400`, `w0-19`, `w0-20`, `[W0-12]`).
- **Agent prompt budget:** the CadScript v1 reference is 35,491 of the 35,500 characters
  `agent/test/v1-agent.test.ts` allows; the next std addition needs the budget raised or text cut.

## Not done

- Extrude **draft/taper angle**, **up to body / next face**, and up to a non-planar face (the IR
  has no field for them; a taper needs a kernel sweep with draft).
- Revolve about a **datum axis or a model edge**: the IR revolve axis lives in the sketch plane, so
  only the sketch's axes and lines are offered (a projection or an IR amendment would add it).
- Hole depth **up to a face** in the panel (the `hole` command already takes `up_to`).
- Feasible ranges show only where the engine's error details carry one.
