# ADR 0019: Local face operations are parametric features

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** owner (approved [docs/NORTH-STAR.md](../NORTH-STAR.md))
- **Plan reference:** [NORTH-STAR.md](../NORTH-STAR.md) §8 row B16, and §2 "Hands-on, Shapr3D-grade"
- **Extends:** [ADR 0004](0004-feature-graph-ir.md) (four new feature types; direct edits stay in the timeline) and [ADR 0013](0013-ir-v1-references-and-parameters.md) (naming rules for the new operations). The ADR 0013 edit is deferred (see Follow-ups).

## Context

- **Push/pull must reach every face.** NORTH-STAR §2 promises Shapr3D-grade hands-on editing. Row B1 (Phase 1 alpha) makes push/pull drive parameters: pull a plate's top and `thickness` changes. That works only when a parameter positions the face. Many faces have none:
  - every face of an imported STEP body;
  - faces that no single field positions, so B1 finds nothing to drive;
  - edits the user wants to make to the result, not to the sketch, such as "make this one wall 1 mm thicker".
- **Direct modelers already do this.** Shapr3D has the best push/pull, and since v5.590 every direct move is a history step (NORTH-STAR §5 snapshot). Plasticity does fast direct modeling on Parasolid. Commercial kernels offer local operations that move, offset, replace or delete faces and heal the model around them (from memory, unverified).
- **ADR 0004 rejected history-free direct modeling.** A B-rep edited in place loses parametric intent, and agents can no longer "change the width" safely. Whatever we add must be a feature in the timeline.
- **IR v1 already has one local operation.** `draft` (SPEC-v1 §6.9, optional in v1) tilts faces, extends or trims their neighbours, and keeps the keys of the faces it tilts (SPEC-v1 §5.2). `shell` builds offset surfaces, concentric for cylinders, cones, spheres and tori (§6.8). Local face operations generalize both.
- **The geometry is long-tail work.** Moving a face means extending its neighbours and intersecting them again. On analytic faces this is the extend-and-trim step `draft` needs. On B-spline faces it needs NURBS offsets and surface extension, which are F3 scope (FORGE.md milestones). Self-intersecting offsets are unstarted (NORTH-STAR §5, "Where we must earn it").
- **The oracle is weak exactly here.** OCCT struggles with fillets, shells and offsets, so it cannot confirm every result ([ADR 0003](0003-forge-kernel-with-occt-oracle.md)). NORTH-STAR §5 answers this with definition-based oracles.
- **Where we are today.** None of this exists. `draft` is specified but not implemented. STEP import is planned for F1; `forge-io`'s STEP module is a placeholder. The IR has no `import` feature yet (SPEC-v1 §0.1 lists import as a later revision).
- **Owner decision.** NORTH-STAR B16, approved 2026-09-24: local face operations as new feature types, at F3 (M8–M14), with OCCT as the oracle. Size L, risk "long tail". Like every group B row, it gates nothing but its own feature.

## Decision

### 1. Four new feature types

We will add four feature types to the IR. Each is an ordinary timeline feature ([ADR 0004](0004-feature-graph-ir.md)). It has an id, a name (a CadScript `const`), a behavior version `v` and an author. It is added, edited and undone through domain ops inside transactions.

| Type | CadScript | Fields | What it does |
|---|---|---|---|
| `move_face` | `moveFace(faces, { dir, d })` or `moveFace(faces, { axis, angle })` | `faces`: Ref (face, `some`); a translation (`dir`: Dir, `d`: length) or a rotation (`axis`: AxisRef, `angle`) | Moves each face's surface rigidly. Its neighbours extend or trim to meet it. |
| `offset_face` | `offsetFace(faces, { d })` | `faces`: Ref (face, `some`); `d`: signed length | Replaces each face's surface by its offset at `d` along the outward normal; positive adds material. Offsets of analytic surfaces are concentric, as in `shell`. |
| `replace_face` | `replaceFace(faces, { to })` | `faces`: Ref (face, `some`); `to`: a PlaneRef, or a Ref (face, `one`) | Gives each face the surface of `to`, extended as needed ("make these faces flush with that one"). |
| `delete_face` | `deleteFace(faces)` | `faces`: Ref (face, `some`) | Removes the faces. Their neighbours extend and meet to close the gap. This is defeaturing: remove a boss, a fillet or a hole. |

- Every scalar field is a v1 scalar field, so it takes parameters and expressions (SPEC-v1 §2.2). Signed directions are strings (`"+Z"`), as in CadScript v1.
- Field names, error codes and report shapes in this ADR are provisional. The SPEC section fixes them (see Follow-ups).
- The new types are an additive revision of `aicad.ir/1` (SPEC-v1 §0.2 rule 5). An engine that lacks them rejects the document with `UNSUPPORTED_FEATURE`. MakerBench marks tasks that need them with `requires` tokens such as `op/move_face`, as it does for `op/draft`.

### 2. Local means local: a strict topology rule

Behavior version 1 of all four types follows one rule. Forge and the oracle both check it.
- **Only the acted-on faces change surface.** Their neighbours keep their surfaces; only their boundaries move. Every other face is unchanged.
- **No other topology changes.**
  - For `move_face`, `offset_face` and `replace_face`: no face or edge vanishes or splits, and no two faces touch that did not touch before.
  - For `delete_face`: the neighbours of the removed faces may meet each other in new edges, because that is how the gap closes. Nothing else changes.
  - An edge or face that shrinks to tolerance counts as vanishing. Forge never creates zero-length edges ([ADR 0012](0012-no-seam-edges.md)).
- **The result is one valid closed solid per input body.** `forge-check::validate` checks it, as it checks every operation.
- **Anything else fails loudly.** The feature fails with a structured error and passes its input through (ADR 0004). When a move or offset would change the topology, the error carries the **feasible interval**: the values of `d` or `angle` around 0 that keep the topology. Each end is rounded toward 0 to a multiple of 0.001 mm (or 0.001°), so a suggested value is safe to apply, as fillet's `max_feasible_r` is. A drag clamps to this interval (NORTH-STAR §2).
- **Provisional error codes:**

  | Code | When | Details |
  |---|---|---|
  | `FACE_OP_TOPOLOGY_CHANGE` | a face or edge would vanish or split, or a new contact would appear | `{ faces: [{ key, name, reason: "vanishes" \| "splits" \| "new-contact" }], min_feasible, max_feasible }` |
  | `FACE_OP_UNSUPPORTED` | a face or neighbour has an unsupported surface type | `{ faces: [{ key, name, reason: "surface-type" }] }` |
  | `DELETE_FACE_CANNOT_HEAL` | the extended neighbours do not close the gap (for example, one face of a box) | `{ faces }` |
  | `FACE_OP_FAILED` | any other failure | `{ faces, reason }` |

- **Topology-changing resolution comes later, as a new `v`.** Letting a neighbour vanish, or a moved face cut into a new face, is useful. It is also where direct modelers surprise their users. It arrives as a new behavior version with its own oracle cases, never by loosening `v: 1`.

### 3. Analytic first, then B-spline

- `v: 1` supports faces and neighbours whose surfaces are planes, cylinders, cones, spheres or tori: the set fillet supports (SPEC-v1 §6.6). Any other surface fails with `FACE_OP_UNSUPPORTED`.
- B-spline faces and neighbours need F3's NURBS offsets and surface extension. Supporting them changes the reports of documents that failed before, so it is a new behavior version (SPEC-v1 §0.2).
- The work follows FORGE.md's order: analytic, then B-spline, then general NURBS.

### 4. How they stay parametric

- **Parameter first.** Push/pull on a face first looks for the parameter that positions it (B1): an extrude's depth, a hole's diameter, a shell's thickness. It creates a local face operation only when no parameter drives the face, or when the user explicitly picks "Move face". The timeline does not fill up with moves where a parameter edit would do.
- **Values become parameters.** A drag writes `d` or `angle` as a literal. The user or the agent can bind it to a named, bounded parameter (`lip_gap`). From then on it behaves like any dimension: editable, explained by "Why?", and open to sensitivities and "make it 20% lighter" (NORTH-STAR §3).
- **They regenerate.** A local face operation sits at one place in the timeline and runs again after every upstream edit. Its `faces` field is a reference, resolved by ADR 0013's rules. If an upstream edit splits or removes the face, the feature fails with repair candidates. It never moves the wrong face.
- **One gesture, one feature.** When the user drags the same face set again and no feature has been added since, the command layer edits the existing feature's value (`setField`) instead of adding a new one. Each gesture is still its own undo step.
- **Drags follow NORTH-STAR §2.** Live frames come from the provisional preview path. On release Forge builds and checks the value. The ≤150 ms release target applies and is measured for these operations like any other; we do not assume it.
- **Agents use them like any feature.** The agent sees them as CadScript lines. Its tool descriptions and playbooks tell it to prefer editing a driving parameter, and it reads the feasible interval from the error details. A local face operation on a face of a user-authored feature is a new feature, proposed and accepted like any other. It never edits the user's feature, so the "silent changes to user features" check (NORTH-STAR §7) applies unchanged.

### 5. How they stay nameable (extends ADR 0013)

New rows for SPEC-v1 §5.2, "Roles per operation":

| Operation | Entity | Key |
|---|---|---|
| `move_face`, `offset_face`, `replace_face` `G` | the acted-on faces | keep their keys (modified), as `draft`'s tilted faces do |
| any local face operation `G` | neighbours that extend or trim, and their surviving edges and vertices | keep their keys (modified) |
| `delete_face` `G` | new edges and vertices where neighbours meet | `G/edge:{A\|B}`, `G/vertex:{…}`, as for body operations |
| `delete_face` `G` | the removed faces and their edges | gone; the removed faces are listed in the report |

- **The face you pushed is still that face.** After `moveFace(slab.cap("end"), …)`, the query `slab.cap("end")` still selects it. Downstream references keep resolving exactly, as they do after a dimension edit.
- **Resolution is ADR 0013's, unchanged.**
  - A replaced face that changes type (a plane becomes a cylinder) raises `REF_KIND_CHANGED`, and a field that needs the old type fails with its own code.
  - A `delete_face` inserted upstream of a captured reference can give a neighbour new adjacent faces. SPEC-v1 §5.7 step 3 treats more neighbours as a split, so this may raise a repair card. That is loud, not silent. The SPEC section may later tell growth by extension apart from a split, using the operation's report.
- **Keys kept, geometry moved.** Like `draft`, these operations can move a cap's edges while keeping their keys. They must re-establish the cap-loop area rule in FORGE.md "Degenerate loops", or give those edges new keys.
- **Reports list what changed.** Each report lists the acted-on faces, the extended or trimmed neighbours and, for `delete_face`, the removed faces, all by key. The agent and the naming harness both read them.
- **Imported bodies need an import naming rule.** Editing imported STEP needs the `import` revision of the IR to do two things:
  - key every imported face stably for a given file. `forge-core`'s provenance grammar already has an `imported` role, and the STEP design note in `forge-io` plans the file's STEP instance ids as its sources;
  - give queries a *named* source for imported faces, so the capture can validate them (ADR 0013 decision 2).

  Replacing the imported file is an edit. Its references go through capture validation and fail loudly when uncertain. This ADR requires both rules; the import revision defines them.

### 6. Verification

Each type lands with unit tests, property tests, invariant checks and an oracle comparison case, all in the same PR (CLAUDE.md principle 4).

| Layer | What it checks |
|---|---|
| OCCT oracle | The oracle **computes** each type from the resolved references, like the other body operations (SPEC-v1 §8.1), and `kernel-diff` compares the reports as usual. Candidate OCCT entry points, to be confirmed by a spike at F3 start: `BRepAlgoAPI_Defeaturing` for `delete_face`, and `BRepOffset_MakeOffset` with per-face offsets for `offset_face`. Where OCCT has no suitable operator (likely `move_face` and `replace_face`), the oracle builds the result with its own extend-and-intersect code on OCCT surfaces and intersections. OCCT stays in CI only (ADR 0003). |
| Independent-refs mode | Keys from OCCT's shape history (`Modified`, `Generated`, `IsDeleted`) where the operator provides it; otherwise the oracle's own bookkeeping, as for holes and patterns |
| Definition-based checks | Independent of OCCT. Each acted-on face lies on its moved, offset or target surface. Each neighbour lies on its original surface. Every other face is unchanged. The topology rule of §2 holds. On analytic surfaces these checks are exact. They carry the weight where OCCT fails, as NORTH-STAR §5 plans for fillets. |
| Naming harness | A new mutation family: insert, edit and delete local face operations upstream of captured references. Every reference is correct or flagged; 0 silent re-binds |

**Ship gate** (this feature only; the numbers are provisional, as NORTH-STAR's are):
- a local-face-operation corpus of ≥1,000 generated cases, at least 200 per type;
- Forge's valid-result rate ≥ OCCT's wherever OCCT has an operator;
- 0 silent-wrong, by oracle diff and by the definition-based checks;
- the naming family above passes.

Cases on imported STEP parts join once a STEP dataset's licence is recorded in `corpus/EXTERNAL_SOURCES.md`. This gate binds no milestone. It does not join the F2 gate, the F3 gate (NORTH-STAR §7, row A4) or the Phase 1 exit.

## Consequences

- **Positive:**
  - **Push/pull reaches every face,** including faces of imported STEP parts once the IR `import` revision keys them stably (§5). A maker can then adjust a downloaded bracket without redrawing it.
  - **Direct edits keep intent.** They are features with expressions, so they regenerate, diff and undo like the rest (ADR 0004).
  - **Names survive.** Moved faces keep their keys, so downstream fillets and holes keep resolving exactly.
  - **Agents get numbers, not riddles.** A failure carries a feasible interval, and a drag clamps to it.
  - **One mechanism.** `draft`, `shell` offsets and local face operations share the extend-and-trim and offset code.
- **Negative / costs:**
  - **Size L, long tail** (NORTH-STAR B16). Extending and re-intersecting faces on real parts is where kernels fail. B-spline support waits for F3's NURBS offsets.
  - **The strict rule clamps early.** Users of Shapr3D or Plasticity will hit `FACE_OP_TOPOLOGY_CHANGE` where those tools resolve the new topology. We accept this until a topology-changing `v` has its own oracle cases.
  - **Four more oracle features.** Two of them may need the oracle's own construction code, which is an oracle we must trust more than a stock OCCT call.
  - **Three implementations track four types:** Rust (Forge), Python (oracle) and TypeScript (types, CadScript compiler and printer), plus four new reserved names.
  - **The timeline grows.** Heavy direct editing adds features. Parameter-first and gesture merging limit this; they do not remove it.
  - **Upstream insertions can raise repair cards** where a neighbourhood grows (§5), until the SPEC tells extension apart from a split.
  - **Editing imported STEP depends on the import revision's naming,** which is not designed yet.
- **Follow-ups:**
  - **At F3 start:** a spike that confirms the OCCT entry points and the analytic extend-and-trim approach. Then, before implementation, the SPEC-v1 section for the four types: fields, errors, report, the §5.2 rows above, §8.1 oracle rows, and the §9.3 reserved names `moveFace`, `offsetFace`, `replaceFace` and `deleteFace`, with conformance fixtures.
  - **Import revision:** stable keys and a named query source for imported faces (§5).
  - **MakerBench:** T4 edit tasks that push faces of imported STEP parts and of parts with no driving parameter.
  - **Command layer and UI:** "Move face", "Offset face", "Replace face" and "Delete face" commands; push/pull falls back to them as §4 says.
  - **Index:** add this ADR to the [ADR README](README.md) index, and add "extended by ADR 0019" to ADR 0004's status line.
  - **Deferred edits** (Phase C is editing these files; this wording is recorded in [NORTH-STAR-DEFERRED.md](../NORTH-STAR-DEFERRED.md) until then):
    - ADR 0013, status line: "Accepted (2026-09-23; decisions appended)" becomes "Accepted (2026-09-23; decisions appended); extended by [ADR 0019](0019-local-face-operations.md) (naming rules for local face operations)".
    - FORGE.md, Milestones table, F3 row, Scope: "Full NURBS surfacing: sweep, loft, general and variable blends, NURBS offsets, HLR for drawings, sheet-metal operations" becomes "Full NURBS surfacing: sweep, loft, general and variable blends, NURBS offsets, local face operations (move, offset, replace and delete face; ADR 0019), HLR for drawings, sheet-metal operations".
    - FORGE.md, Crate map, `forge-ops` row: "Later: sweep, loft, thicken, variable blends, sheet metal." becomes "Later: sweep, loft, thicken, variable blends, local face operations (ADR 0019), sheet metal."

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| History-free direct editing of the B-rep | ADR 0004 rejected it: it loses parametric intent, and agents can't change a width safely. |
| Synchronous-style editing (as in Solid Edge): no history, with geometric rules inferred on every drag | Two sources of truth. Inferred rules change what a drag does without showing why, which conflicts with "never silently wrong". |
| Parameter-driven push/pull only (B1 alone) | Cannot edit imported STEP, or any face that no parameter positions. |
| Bake each direct edit into a new imported body | Drops every parameter and upstream link. Downstream references break on every bake, and files grow. |
| One generic `local_op` type with a mode field | Four types give clearer schemas, error codes and CadScript names, and each can gain a behavior version on its own. |
| New keys for moved faces (`G/moved:{X}`) | Every downstream reference would break whenever a move is inserted, the same failure as keying features by name (ADR 0013). `draft` already keeps keys. |
| Topology-changing resolution in `v: 1` | More capable, but more ways to surprise users, and it needs its own oracle cases first. It comes later as a new `v`. |
| Ship analytic local face operations at F2 | It would add work next to the maker release gate, which NORTH-STAR §8 rules out without owner approval. The owner approved F3. |
| Run OCCT's local operators at runtime | Against [ADR 0000](0000-own-the-core.md) and ADR 0003: OCCT is LGPL and a CI oracle only. |
