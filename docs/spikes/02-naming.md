# Spike 02: Native provenance naming harness

- **Owner / workstream:** naming agent (Claude Code), main working tree (no git in this workstream)
- **Dates:** 2026-09-23 → 2026-09-23
- **Commit(s):** uncommitted. New crate `forge/crates/forge-naming/`; one naming fix in `forge/crates/forge-ops/src/revolve.rs` with its test in `forge/crates/forge-ops/tests/topology_details.rs`.
- **Verdict:** **GO**, after one forge-ops naming fix. Without the fix the same harness gives NO-GO: 34 silent-wrong references.

## Goal

Persistent naming is the #1 risk of parametric CAD. After an upstream edit, a reference to a face or edge must still point at the *same* entity, or be flagged. It must never be silently re-bound to a different entity. This spike asks two questions:
- Do Forge's native provenance names ([ADR 0006](../adr/0006-native-persistent-naming.md)) identify the same geometric entity across edits?
- Can a resolver built on those names re-find referenced entities, and flag correctly when it cannot?

IR v0 has no feature → face references yet; those arrive in IR v1 as semantic queries. So this spike measures the foundation those queries will stand on.

Criteria, verbatim from [README.md](README.md):

| Setup | GO when |
|---|---|
| 12–20 maker models, 10 scripted mutations each | ≥97% correct on dimension and suppress edits. ≥90% correct on topology-changing edits. **100% of fallbacks flagged.** |

**How the criteria are read.** These are interpretations, not changes:
- **Correct** = `CORRECT + FLAGGED_CORRECTLY` over scored references. The bar is applied to (a) and (b) *separately*, which is stricter than pooling them.
- **100% of fallbacks flagged** = zero `SILENT_WRONG`. Every reference that did not resolve exactly and correctly must have been flagged.
- **`SILENT_WRONG`** is stricter than "reported Exact but wrong". It also covers:
  - an exact resolution to *one piece* of a split entity (a partial re-bind);
  - any wrong answer with confidence ≥ 0.95. That is the auto-accept threshold, where a UI or agent could take the answer without asking.

## Setup

**Code (`forge-naming`, MPL-2.0)**

| Module | Contents |
|---|---|
| `src/view.rs` | `ModelView`: an evaluated document. Holds every body with its feature and region (the region's IR name, SPEC §3.2), plus the provenance name, `#index` family and fingerprint of each face and edge. |
| `src/fingerprint.rs` | `Fingerprint`, `Support` (the exact carrier), and `compare`. |
| `src/resolve.rs` | `EntityRef`, `resolve` (the ADR 0006 chain), `Resolution`/`Status`/`Reason`. Also `resolve_name_only`, a baseline used only for measurement. |
| `src/harness/models.rs` | The 20 models, embedded with `include_str!`. |
| `src/harness/mutate.rs` | The scripted mutation generators, plus the `Intent` of each mutation: how sketch curves map across the edit. |
| `src/harness/truth.rs` | The ground truth, computed from geometry only (see below). |
| `src/harness/{mod,report}.rs` | Runner, scoring and Markdown report. |
| `src/bin/naming-harness.rs` | CLI. Prints the report; exit code 0 = GO. |

**Tests (`cargo test -p forge-naming`: 20 tests, about 25 s in debug)**
- `tests/resolver.rs`: 11 tests, one per layer and flag reason, on small hand-written IR documents.
- `tests/props.rs`: 2 proptests over random plates.
  - Random dimension edits keep every reference `CORRECT`.
  - A renamed (and moved) hole is never silently re-bound.
- `tests/harness.rs`: the whole harness as a regression gate.
  - The criteria hold.
  - The ground truth agrees with provenance on every unedited model.
  - Every reference of an unedited model resolves exactly to itself.
  - Auto-accept confidence is reserved for geometry-identical matches.
  - Two runs give identical reports.
- Unit tests in `fingerprint.rs`.

**Models: 20 models, 793 faces and edges before any edit.** All data is in-repo; no external datasets.

| Source | Models |
|---|---|
| MakerBench (Apache-2.0, hand-written), compiled with `node packages/cadscript/dist/cli.js compile corpus/makerbench/<id>.cad.ts` | `t1-nema17-plate`, `t1-cable-clip`, `t1-knob`, `t1-v-pulley`, `t1-slotted-shim`, `t1-drawer-pull`, `t1-shelf-bracket`, `t1-2020-corner-plate`, `t1-tube-end-plug`, `t1-keychain-tag`, `t2-enclosure-with-lid` (2 parts, 4 bodies), `t2-parts-tray` (4 bodies, 2 region bodies in one feature), `t2-wall-hook` (reverse + symmetric extrudes), `t2-spool-holder` (extrude + revolve), `t2-jar-with-lid` (2 revolves), `t5-pcb-spacers` (4 identical region bodies) |
| `corpus/programs` | `revolve_partial_ring` (90° revolve), `extrude_two_regions` (2 bodies, reverse) |
| New for this spike | `naming-d-coupler-plate`: rounded corners, a D-shaft hole (a line and an arc that meet twice, so an `#index` family), 2 slots and 6 holes. `naming-revolve-bead-partial`: a 200° revolve of a filleted bowl wall (tori) plus a D-shaped bead, giving 2 bodies from 1 feature and `#index` families on the revolve. |

**Hardware and targets.** Apple M4 Pro, macOS (Darwin 27.0.0, arm64), rustc 1.92.0. Native only. The harness is deterministic, and its debug and release reports are byte-identical. Cross-target bit-identity is spike 1's job.

**Reproduce (from `forge/`):**
```bash
cargo run -p forge-naming --release --bin naming-harness -- --out /tmp/naming-report.md   # ≈2 s; exit 0 = GO
cargo run -p forge-naming --release --bin naming-harness -- --dump revolve_direction      # every scored ref of matching mutations
cargo test -p forge-naming && cargo clippy -p forge-naming --all-targets -- -D warnings
```

## Design

### Stored reference

`EntityRef { kind, feature, region, name, between, fingerprint, cardinality }`:
- **`name`** is the canonical provenance name. It is the primary key.
- **`region`** identifies the body among a feature's region bodies. It is the sorted outer-loop curve ids of the body's region, i.e. the region's IR name in SPEC §3.2.
- **`between`** is set for edges: the names of the edge's two faces, taken from its provenance sources.
- **`fingerprint`** records what the reference knew about the geometry at capture time:
  - surface or curve **kind**;
  - exact **carrier**: a plane with oriented normal and offset, a cylinder's axis and radius, a cone's apex and half angle, a line's direction and position, a circle's centre, normal and radius (axis signs canonical);
  - **area or length** (area from a deflection-bounded tessellation; used only as a heuristic);
  - **centroid**, both world and normalised to the body's box;
  - the body's box centre;
  - the entity's own **bbox**;
  - the number of **adjacent entities on the same carrier** (the split signature);
  - the **`#index` family size**.
- **`cardinality`** is 1 for every reference IR v0 can express. A result that would need more entities (a split) is flagged.

### Resolution chain (ADR 0006)

| # | Layer | Result |
|---|---|---|
| 1 | **Exact provenance.** The name is looked up among the feature's bodies, narrowed by `region`. A unique hit is **validated**: the kind is unchanged, it has no new or lost neighbours on the same carrier, and, for an `#index` family, the family size is unchanged and the named member is also the fingerprint's best match. | `Exact`, the only unflagged status |
| 2 | **Fingerprint among name hits.** Covers split pieces, index siblings, and region bodies whose region name changed. | `Disambiguated{confidence ≤ 0.9}` with the reason `kind-changed`, `index-family` or `region-changed`; or `Ambiguous{pieces}` with the reason `split` |
| 3 | Query filters | Empty in IR v0 |
| 4 | **Geometric match** within the feature's bodies. In order: a geometry-identical candidate (a rename); an edge whose two named faces still exist but no longer meet is gone; pieces on the stored carrier inside the stored box (a split with new ids); otherwise the best soft score. | `GeometricMatch{0.99}` for identical geometry; otherwise `Missing (faces-no-longer-meet)`, `Ambiguous{pieces}`, `GeometricMatch{≤ 0.9}` or `Ambiguous` for a tie |
| 5 | Nothing plausible (score < 0.35), or the feature has no bodies | `Missing` |

**Confidence policy.** Only a geometry-identical match (the carrier, box, size and centroid all equal) reaches the auto-accept threshold of 0.95. Disambiguation and approximate matches are capped at 0.9, so they always need confirmation. The integration test checks this invariant on all 18,997 resolutions.

## Ground truth

The ground truth does **not** use provenance, names, fingerprints or the resolver. It labels every face and edge from two things only:
- the IR, read with SPEC semantics;
- the body's geometry and adjacency.

**Labels.**
- **Extrude caps** are planar faces whose normal is parallel to the sweep. They are classified by their offset: `Start` at the start of the SPEC §4.2 sweep range (0 for `normal` and `reverse`, −d/2 for `symmetric`), `End` at its end.
- **Revolve end caps** are planes that contain the axis. They are classified by azimuth: `Start` where the SPEC §4.3 rotation starts (the profile plane for `normal` and `reverse`, −Θ/2 for `symmetric`).
- **Side faces.** The face of sketch curve `c` is the one that meets all three conditions:
  - its boundary, mapped back to the sketch (the extrude offset dropped, or to (ρ, h) about the revolve axis), lies on `c`;
  - its boundary contains every off-axis endpoint of `c`;
  - its carrier contains `c`.
- **Edges** get the sorted labels of their two faces. An edge that maps back to a single sketch point also gets the set of curve ends meeting there, which tells the two edges of a "D" apart.

**Expected outcome.** Each mutation carries an `Intent`: curve splits, renames, removals and end swaps. An old label is mapped through the intent and looked up among the new model's labels. The result is `Same`, `Renamed`, `Split` (the pieces on the old carrier), or `Gone`.

**Self-check.** On all 20 unedited models the geometric labels and the provenance names correspond one-to-one: **793 / 793 entities**. There are 0 unlabelled entities and 0 excluded references across all mutations.

**Semantic choices, stated explicitly.**
- **Cap start/end follow the sweep, not "which way it faces".** After `normal` → `reverse`, `cap:start` is still the sketch-plane face. This matches both SPEC's direction tables and mainstream CAD behaviour.
- **A collinear split is `Split`.** A reference to the old face is resolved correctly only when it is flagged with a piece first. An *exact* answer to one piece is `SILENT_WRONG`.
- **For a renamed curve, `Missing` is accepted as correctly flagged.** This is the task's own expectation. It mattered for 3 of 155 renamed references; the other 152 were geometric matches with the right entity first.

## Mutation families and counts

456 accepted mutations: 15 to 32 per model. 18,997 references were resolved: every face and edge of the base model, for every mutation.

15 generated mutations were rejected. All 15 were "unsuppress" on single-feature models, where the base model has nothing to reference.

| Family | Kinds (accepted mutations) |
|---|---|
| **(a) dimension**, 203 | `offset_line` 32 · `extrude_direction` 28 · `move_plane` 20 · `scale_sketch` 20 · `reorder_curves` 20 (curve list reversed, no geometric change) · `reverse_curve` 18 (a curve's start/end swapped, no geometric change) · `extrude_distance` 17 · `revolve_direction` 14 · `move_vertex` 10 · `move_hole` 10 · `resize_circle` 8 · `revolve_angle` 4 · `move_loop_by_junction_gap` 2 (adversarial: a "D" loop moved so one junction lands on the other) |
| **(b) suppress**, 50 | `suppress_feature` 25 · `suppress_sketch` 20 · `unsuppress_feature` 5 |
| **(c) topology**, 203 | `rename_curve` 31 · `add_hole` 25 · `split_line_keep_id` 23 · `add_region` 20 (a new body of the same feature) · `bulge_line` 18 (line → arc, same id) · `split_line_new_ids` 18 · `fillet_corner` 16 · `remove_hole` 10 · `rename_and_move_circle` 8 · `split_arc_keep_id` 7 · `dimension_edit_changing_topology` 6 (a `move_vertex` on a revolve profile that tilted a line off parallel or perpendicular to the axis, turning a cylinder or plane into a cone; re-filed from (a)) · `revolve_partial` 5 (360° → 270°, end caps appear) · `reorder_features` 4 · `unfillet_corner` 4 · `flatten_arc` 4 · `revolve_full` 2 · `reorder_parts` 2 |

## Results

| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| Correct on (a) dimension edits | ≥ 97 % | **99.98 %** (8,475 / 8,477) | yes |
| Correct on (b) suppress edits | ≥ 97 % | **100.00 %** (2,076 / 2,076) | yes |
| Correct on (c) topology-changing edits | ≥ 90 % | **100.00 %** (8,444 / 8,444) | yes |
| Fallbacks flagged | 100 % | **100.00 %**: 0 `SILENT_WRONG` out of 1,858 non-exact resolutions | yes |

**Per family.** "Exact" = resolved exactly with no user attention.

| Family | Refs | CORRECT | FLAGGED_CORRECTLY | WRONG_BUT_FLAGGED | SILENT_WRONG | Correct | Exact |
|---|---:|---:|---:|---:|---:|---:|---:|
| (a) dimension | 8,477 | 8,473 | 2 | 2 | 0 | 99.98 % | 99.95 % |
| (b) suppress | 2,076 | 782 | 1,294 | 0 | 0 | 100.00 % | 37.67 % |
| (c) topology | 8,444 | 7,884 | 560 | 0 | 0 | 100.00 % | 93.37 % |
| **all** | 18,997 | 17,139 | 1,856 | 2 | 0 | 99.99 % | 90.22 % |

**Before the forge-ops fix.** On the same harness and models:
- 34 `SILENT_WRONG`, and (a) drops to 99.58 %. The verdict is NO-GO. See the defects below.
- Every one of the 34 is in `revolve_direction` `normal → reverse`, on the two partial-revolve models.

**Flags by reason.**
- (c):
  - 216 `geometric/name-not-found`: renames (0.99 identical matches), plus junction edges renamed by a split;
  - 122 `ambiguous/split`;
  - 114 `missing/no-plausible-match`: 57 from removed holes, 34 from end caps that vanish when a revolve is made full, 20 from removed fillet arcs, and 3 from the renamed-and-moved circle;
  - 68 `disambiguated/kind-changed`: bulged or flattened curves, and revolve profile lines tilted into cones;
  - 24 `disambiguated/region-changed`;
  - 16 `missing/faces-no-longer-meet`: corners consumed by a fillet.
- (a): 4 `disambiguated/index-family`.
- (b): 1,294 `missing/feature-absent`.

**Names-only baseline.** This is exact lookup narrowed by region, with no validation and no fallback. It shows how far raw provenance goes.

| Family | Correct | Exact | SILENT_WRONG |
|---|---:|---:|---:|
| (a) dimension | 99.98 % | 99.98 % | 2 (`reverse_curve`: `#index` swap) |
| (b) suppress | 100.00 % | 37.67 % | 0 |
| (c) topology | 97.58 % | 94.17 % | 76 (partial re-binds after a split that kept the id: 57 lines, 19 arcs) |

- **Raw names survive every edit that keeps curve ids.** That covers all dimension, direction, plane, scale, reorder and suppress edits, adding holes and regions, and fillets. The exception is the index swap.
- **The validation layer is what makes the fallback safe.** It turns all 78 silent re-binds into correct flags.

**Per stored-name role.** "Names-only" = `SILENT_WRONG` count under the names-only baseline.

| Role | Refs | Exact | FLAGGED_CORRECTLY | WRONG_BUT_FLAGGED | Names-only |
|---|---:|---:|---:|---:|---:|
| edge cap\|side | 7,850 | 90.85 % | 718 | 0 | 40 |
| edge side\|side (junction) | 4,104 | 89.91 % | 413 | 1 | 1 |
| edge side\|side `#k` | 50 | 86.00 % | 6 | 1 | 1 |
| edge endcap\|side | 688 | 84.30 % | 108 | 0 | 6 |
| face side | 5,031 | 90.28 % | 489 | 0 | 30 |
| face cap | 1,128 | 92.02 % | 90 | 0 | 0 |
| face endcap | 146 | 78.08 % | 32 | 0 | 0 |

**WRONG_BUT_FLAGGED (2, by design).** `move_loop_by_junction_gap` moves a "D" loop so that one junction lands exactly where the other one was:
- The `#index` check sees the named member away from its stored position and a sibling at it. It flags `index-family` and proposes the sibling.
- The ground truth follows the curve ends, so the proposal is wrong.
- This is flagged at 0.9, below auto-accept. The policy (propose the fingerprint-best sibling) is right for the common index-swap case (`reverse_curve`, 2/2 correct) and wrong only for this adversarial move.

## Every SILENT_WRONG case

**After the fix: none.**

**Before the fix: 34.** All come from one pattern: a partial revolve's direction flipped `normal` → `reverse`.

| Model | References silently re-bound |
|---|---|
| `revolve_partial_ring` (90°) | 10: `quarter/endcap:start`, `quarter/endcap:end`, and the 8 edges `quarter/edge:{quarter/endcap:start\|end ∣ quarter/side:inner\|top\|outer\|bottom}` |
| `naming-revolve-bead-partial` (200°) | 24: both end caps and the 22 end-cap/side edges of both region bodies (`bowl/edge:{bowl/endcap:… ∣ bowl/side:bead_flat\|bead_arc\|floor_b\|fil_out\|wall_out\|lip\|wall_in\|fil_in\|floor_t\|hub}`) |

Each of these references resolved **exactly**, and to the other end cap.

**Minimal repro:**
1. Take `corpus/programs/revolve_partial_ring.json`.
2. Add `"direction": "reverse"` to the revolve.
3. Before the edit, `quarter/endcap:start` lies on the profile plane: the XZ half-plane at azimuth 0°.
4. After the edit, forge-ops gave that name to the cap at azimuth −90°, and named the profile-plane cap `quarter/endcap:end`.

Extrude does the opposite: it explicitly keeps `cap:start` on the sketch plane for `reverse` (`extrude.rs`, the `Reverse` arm).

## Provenance defects found

1. **FIXED: revolve `reverse` swapped the end-cap names** (forge-ops `revolve.rs`).
   - **Cause.** The revolve frame always runs from its start plane φ₀ up to φ₀ + Θ, and `endcap:start` was put on the frame's start plane. For `reverse` (φ₀ = −Θ) that is the *far* cap. So under a pure parameter edit the names moved to the other cap, and so did every edge and vertex name derived from them.
   - **Fix.** A 10-line change: for `reverse`, give the frame-start plane `endcap:end` and the frame-end plane (the profile plane) `endcap:start`. This is the same convention extrude already follows.
   - **Scope.** `normal` and `symmetric` are unchanged. Geometry and metrics are unchanged; only two provenance labels are swapped.
   - **Test.** New forge-ops test `partial_revolve_end_cap_names_follow_the_sweep_direction` checks the start/end azimuths for all three directions. It fails without the fix and passes with it.
   - **Docs.** The module docs are updated.
   - **Other crates.** The tests of forge-ops, forge-regen, forge-check, forge-mesh, forge-io and forge-cli all pass. No other crate referenced `endcap` names.
2. **Not fixed: `#index` order depends on curve direction and on the alphabetical order of curve ids.**
   - **Mechanism.** The two junction edges of a two-curve loop share a name and are numbered by sorting their junction keys (`a:end|b:start` < `a:start|b:end`). Reversing the alphabetically first curve rewrites the keys and swaps `#0` and `#1`.
   - **Evidence.** It happens in `naming-revolve-bead-partial` when `bead_arc` is reversed. It does *not* happen in `naming-d-coupler-plate` when `d_round` is reversed, because `d_flat` sorts first there.
   - **Why not fixed.** It is not clearly a bug. Any sketch-level order of the two junctions depends on some curve's direction, and ordering by geometry would be unstable under dimension edits.
   - **Mitigation.** The resolver validates `#index` families against the fingerprint: 2 / 2 swaps were flagged with the right entity first. The names-only baseline gets both silently wrong.
3. **Not fixed (a design gap): caps have no body identity.**
   - **Mechanism.** Cap names render no region. So `plate/cap:start`, the revolve's on-axis `endcap|endcap` edge, and the vertices on the caps exist once *per region body* of a feature.
   - **Where it shows.** `t5-pcb-spacers` has 4 bodies sharing the same cap names; `t2-parts-tray`, `extrude_two_regions` and the bead model are also affected.
   - **Mitigation.** References are qualified by the body's region name, the SPEC §3.2 `outer_curves`. But that region name changes when an outer-loop curve is split or renamed (24 `region-changed` flags).
   - **A resolver bug this exposed, fixed in forge-naming.** Body-local centroids alone cannot tell identical bodies apart: the 4 spacers all sit at local (0.5, 0.5, ·). The comparison now adds the body's own displacement.
4. **By design, but costly: edge names embed both face names.**
   - **Mechanism.** Splitting or renaming a curve renames edges whose geometry did not change. Examples: the junction at the end of a split line becomes `edge:{side:x_s|side:y}`, and every edge of a renamed curve changes name.
   - **Mitigation.** The resolver recovers these as identical-geometry matches (0.99, flagged). Edge references also carry their two face names, so "gone" can be decided structurally: both faces still exist but no longer meet. This catches the corners consumed by fillets (16), which proximity alone would have proposed as the new tangent edges.

## Recommendations for IR v1 references and queries

1. **Never persist `#k`.**
   - Express index siblings semantically. Examples: `edgeAt(bow.end)`, or `edgesBetween(chord, bow).at(chord.start)`. Curve ends are stable identities; sorted key strings are not.
   - If an index must be shown to users, re-derive it at display time.
2. **Give bodies a stable name, and put it in cap names.**
   - Select bodies by a *member* curve (`plate.bodyOf("d1_left")`) rather than by the full outer-curve set, which changes whenever any outer curve is split or renamed.
   - Render the region's smallest member curve id into cap names, e.g. `plate/cap:end@d1_bottom`, or add a body segment to the grammar.
3. **References are sets with a declared cardinality.**
   - A reference whose target split must either return all pieces (`card: many`) or be flagged.
   - Keep the cheap split detector: the count of neighbours on the same carrier.
   - An exact name hit on one piece is the most common silent re-bind (76 in the baseline).
4. **Flag kind changes.** A plane that became a cylinder (the line bulged, same id) keeps its name. That is correct identity, but a sketch-on-face or a planar-mate reference must not silently accept it.
5. **Store the two face references with every edge reference.** Then "renamed" and "gone" are decidable structurally, not by proximity.
6. **Fingerprint fields that mattered,** in order:
   - the **kind**, as a hard filter;
   - the **exact carrier**, for identity, split pieces and "is this the same line or cylinder";
   - the **box**, to test containment of pieces;
   - **size**, to confirm identical geometry;
   - **position relative to the body plus the body's own displacement**.
   The world centroid alone breaks on whole-body moves; the body-local centroid alone breaks on look-alike bodies. Face area from tessellation is adequate as a heuristic.
7. **Make renames explicit edits.** Agent tools and the CadScript printer must preserve curve ids and curve directions on round-trip. A rename should be an op that records an id map in the edit transaction, so regen can resolve renamed references *exactly* instead of via a 0.99 geometric match. Reversing a curve should likewise not re-index its edges.
8. **Key references by feature *id*, not feature name.** Feature names are CadScript `const`s and get renamed; today a feature rename makes every reference `Missing`.
9. **Confidence policy.** Keep auto-accept for geometry-identical matches only. Everything else is a warning with ranked candidates. The harness enforces this.
10. **Write the naming conventions into the SPEC**, next to the metrics: cap/end-cap start and end per direction, index ordering, and region identity. The oracle does not need them, but the naming contract does.

## Verdict: GO

After one minimal naming fix in forge-ops (revolve `reverse` end caps):
- all three criteria are met with large margins: 99.98 %, 100 %, 100 %;
- there are 0 silent re-binds across 18,997 references and 456 mutations of 20 maker models;
- the ground truth agrees 1:1 with provenance on every unedited model.

Without the fix, the spike is a NO-GO: 34 silent re-binds under a direction flip. Finding exactly that kind of defect is what this spike is for.

**Confidence is high for the IR v0 feature set:** extrude and revolve of line/arc/circle sketches, where every name derives from curve ids. **It is not yet evidence for F1/F2.** Booleans, fillets and shells split and merge faces by *intersection*, not by sketch curves. That is where native naming gets hard, and where the split detector, the `between` rule and the region identity will be tested for real.

**Limitations:**
- one edit per mutation (no edit sequences);
- faces and edges only (no vertex references);
- references to *every* entity, not a realistic reference mix;
- native macOS only.

## Follow-ups

- [ ] Rerun this harness when F1 booleans land. Add mutation families where a boolean splits or merges referenced faces, and give boolean-generated faces provenance that survives upstream edits.
- [ ] Amend ADR 0006 and the SPEC with the naming conventions above: the end-cap direction rule, `#index` rules and body identity.
- [ ] IR v1 `Ref` design: body-by-member selector, cardinality, edge references carrying face references, feature ids, no persisted `#k`.
- [ ] CadScript printer and agent tools: preserve curve ids and directions; explicit rename op with an id map.
- [ ] Add `cargo run -p forge-naming --release --bin naming-harness` as a CI gate (exit code 1 on NO-GO). `cargo test -p forge-naming` already gates it in debug.
- [ ] Extend the harness to edit sequences (capture at v0, resolve at vN) and to vertex references.
- [ ] `docs/spikes/README.md` names this report `02-provenance-naming.md`; this spike wrote it as `02-naming.md` as requested. Align the two.
