# IR v1 implementation plan

- **Status:** Draft, 2026-09-23. Tracks [SPEC-v1-DRAFT](../forge/crates/forge-ir/SPEC-v1-DRAFT.md) and [ADR 0013](adr/0013-ir-v1-references-and-parameters.md).
- **Audience:** the agents (and people) implementing IR v1 in parallel worktrees: Forge kernel,
  oracle, CadScript, command layer, agent tools, evals.
- **Rule zero:** the SPEC is the contract. When two workstreams disagree, fix the SPEC first (a
  short spec PR, reviewed by every affected owner), then the code. Rule tags `[D-n]` are the
  vocabulary for issues and test names.

**Contents**
1. [Workstreams at a glance](#1-workstreams-at-a-glance)
2. [Ordering and critical path](#2-ordering-and-critical-path)
3. [Interfaces between workstreams](#3-interfaces-between-workstreams)
4. [Workstreams in detail](#4-workstreams-in-detail)
5. [MakerBench v1](#5-makerbench-v1)
6. [Gates summary](#6-gates-summary)
7. [Risks](#7-risks)
8. [Definition of done](#8-definition-of-done)

---

## 1. Workstreams at a glance

| Id | Workstream | Where | Depends on | Delivers |
|---|---|---|---|---|
| **W0** | Contract: types, schema, validation, migration, conformance fixtures | `forge/crates/forge-ir`, `corpus/v1/` | — | the frozen v1 contract (I1, I9) |
| **W1** | Expressions and parameters | `forge-ir::expr` (pure), `forge-regen::params` (evaluator) | W0 | parser, canonical printer, type checker, evaluator (I2) |
| **W2** | Constrained and compound sketches | `forge-regen` ↔ `forge-solve`, `forge-ops::sketch` | W0, W1 | solve at evaluation, write-back, `sketch` report block |
| **W3** | References core | `forge-core::topo::provenance`, new crate `forge-refs`, `forge-regen` | W0 | keys, query evaluator, resolver, probes, datums, sketch on face (I3, I6) |
| **W4** | Booleans | `forge-ops` on `forge-ssi` | W0, W3 keys, forge-ssi | join/cut/intersect, same-domain merge, identity (I4) |
| **W5** | Holes and patterns | `forge-ops`, `forge-regen` | W4 (cut), W3 | hole tools and placement, linear/circular/mirror patterns |
| **W6** | Fillet, chamfer, shell, draft (F2) | `forge-ops`, `forge-check` | W3, W4 | blends and offsets with feasible-range errors |
| **W7** | Oracle v1 | `oracle/` | W0 (then follows W1–W6) | independent evaluation, replay, diff v1, generators |
| **W8** | CadScript v1 | `packages/cadscript`, `packages/ir-types` | W0, I2 conformance | std, compiler, printer, splice, identity (I8) |
| **W9** | Command layer and bindings | `forge-wasm`, `forge-cli`, DocStore ops in `packages/app` / `packages/forge-web` | W0, W2, W3 | ops with inverses (I7), CLI verbs |
| **W10** | Agent tools and playbooks | `packages/agent-tools`, `packages/agent` | W8, report I5 | playbooks for every new code, new tools, DSL reference v1 |
| **W11** | Evals and naming harness | `corpus/makerbench`, `packages/evals`, `forge/crates/forge-naming` | W3–W6, W8 | MakerBench v1 tasks, check DSL, harness v1 gates |

Worktree ownership: one workstream per crate or package directory at a time. Shared files
(`forge-ir` types, constants, `corpus/v1/conformance/`) change only through W0 spec PRs after
Phase A.

## 2. Ordering and critical path

```
Phase A (contract, ~1 week)
  W0 ──────────────► I1 schema + I9 conformance fixtures frozen
Phase B (parallel, weeks 1–4)
  W1 expressions ──┐
  W2 sketches ─────┼─► v1 on the v0 operation set (extrude/revolve + params + constraints + refs + datums)
  W3 references ───┤
  W7a oracle port ─┤
  W8a CadScript ───┤
  W9a bindings ────┘
  W4 booleans (starts as soon as forge-ssi's analytic pairs pass spike 3)
Phase C (F1, weeks 3–8)
  W4 ─► W5 holes + patterns;  W7b oracle ops;  W8b CadScript ops;  W10 playbooks;  W11 tasks + harness (booleans)
Phase D (F2, weeks 6–14)
  W6 blends + shell ─► W7c oracle blends + independent-refs;  W11 harness (fillets);  F2 gate
```

- **Kernel critical path:** W0 → W3 (keys) → W4 → W5 → W6. forge-ssi gates W4; W5's tool builders
  and W7's oracle side can be written against `new_body` semantics before W4 lands.
- **Agent critical path:** W0 → W8 → W10. The agent can use v1 syntax against the oracle backend as
  soon as W7a and W8a land, before Forge supports every operation (the existing "agent works against
  the oracle while Forge grows" strategy of the ROADMAP).
- **Milestone "v1 on v0 ops"** (end of Phase B) is shippable on its own: parameters, constraints,
  compound curves, sketch on face, datums and references on extrude/revolve.

## 3. Interfaces between workstreams

| Id | Interface | Owner | Consumers | Frozen when |
|---|---|---|---|---|
| **I1** | Rust IR v1 types, `schema/ir-v1.schema.json`, `metrics-v1.schema.json`, `ir-v1.constants.json` (tolerances, `RESERVED_NAMES`, `HOLE_SIZES`) | W0 | all | end of Phase A |
| **I2** | `forge_ir::expr::{parse, canonical, typecheck}` and `forge_regen::params::evaluate(&Document) -> ParamValues` | W1 | W2–W6, W9 (WASM), W8 (conformance only) | Phase B week 2 |
| **I3** | `forge-refs`: `Scope`, `eval_query(&Query, &Scope)`, `resolve(&Ref, &Scope) -> Resolution`, `probe(entity)`, `fingerprint(entity)`, `synthesize_query(candidate, &Scope)`, `plane_frame(&PlaneRef, &Scope)`, `axis(&AxisRef, &Scope)` | W3 | W2 (sketch on face), W4–W6 (resolved sets), W11 (harness) | Phase B week 3 |
| **I4** | forge-ops body-op API: `apply_body_op(op, targets, tools) -> BodyOpResult { bodies (with origin, change), merged_into, removed, splits }`, `unify_same_domain`, `hole_tools(spec, positions, frame)`, `pattern_instances(layout) -> Vec<Transform>`, `fillet/chamfer/shell/draft`; every error is a `thiserror` enum with a `Serialize` details struct | W4 (then W5, W6) | `forge-regen` | Phase C week 1 |
| **I5** | `aicad.metrics/1` report (SPEC §7) | W0 | W7 (diff), W9, W10, W11 | end of Phase A |
| **I6** | Replay trace: `sketch.solved`, `refs[].members[].probe` | W2, W3 | W7 | Phase B week 3 |
| **I7** | Command-layer ops (`setParam`, `writeBackSolution`, `captureRef`, `acceptRefCandidate`, `acceptRefProposal`, `renameCurve`, `renameFeature`, `upgradeFeature`) and their WASM/napi entry points | W9 | UI, W10 | Phase B week 4 |
| **I8** | `@aicad/std` v1 declarations | W8 | W10 prompts, skills | Phase B week 2 (additions per op later) |
| **I9** | Conformance fixtures `corpus/v1/conformance/`: expressions (text → canonical, type, value bits or error), migration pairs, invalid documents with expected `{code, path}`, query typing, compound expansions, hole tools | W0 | Rust, TS and Python test suites | end of Phase A, append-only after |

Every interface change after its freeze date is a SPEC PR plus a fixture update, reviewed by the
consumers listed.

## 4. Workstreams in detail

Each workstream lists scope, then **acceptance tests**: the gates a reviewer checks before merging.
All Rust work follows CLAUDE.md (unit + property tests + invariants + an oracle case per operation,
bit-identical determinism, `cargo clippy -D warnings`).

### W0 — Contract

**Scope.**
- Split `forge-ir/src/doc.rs` into modules: `params`, `expr` (AST only), `sketch` (curves,
  compound curves, constraints), `refs` (Ref, Query, predicates, capture), `features` (one struct
  per feature type), `metrics` (report v1). `Scalar = number | string`, `deny_unknown_fields`
  everywhere, canonical JSON with every stated default omitted.
- `validate` for every **R** code of SPEC §7.5, returning all problems with JSON-pointer paths.
- `migrate_v0_to_v1` (SPEC §9.1), and v0 input acceptance in `from_json`.
- `ir-v1.constants.json`: tolerances of SPEC §1, `RESERVED_NAMES` v1, `HOLE_SIZES` (after the
  standards check of open point 1).
- `corpus/v1/conformance/` fixtures (I9) and `corpus/v1/programs/` (one hand-written program per
  feature and per SPEC example, with CadScript twins).

**Acceptance.**
- Every conformance document round-trips `from_json → to_json` byte-identically.
- `corpus/v1/invalid/`: at least 3 documents per R code, each with the expected `{code, path}` list;
  `validate` matches exactly.
- **Migration gate:** the 8 corpus programs and the generated seeds 5, 11, 23 (6,000 programs)
  migrate; Forge's v1 report of each migrated program equals its v0 report (same features,
  statuses, codes, regions, body metrics bit for bit); idempotence proptest; rejected v0 documents
  keep their codes and paths.
- `schema_up_to_date` covers the v1 files; the TS reserved-names test reads `ir-v1.constants.json`.

### W1 — Expressions and parameters

**Scope.** Lexer, parser, AST, canonical printer, type checker (Flex rules, SPEC §2.5), scope and
dependency graph, cycle detection in `forge-ir::expr` (pure, no transcendentals). The evaluator in
`forge-regen::params`: IEEE rules, degree trigonometry with the exact table, binary exponentiation,
domain errors, integrality, bounds, `PARAM_FAILED` propagation, measured-parameter hook for W2.
WASM export `params(doc)` for UIs.

**Acceptance.**
- Conformance suite of **≥ 600 cases**, covering every row of the §2.5 typing table and every
  function, with expected values as f64 bit patterns and expected error codes.
- Proptests: `parse(canonical(ast)) == ast`; `canonical` is idempotent; the type checker never
  accepts an expression the evaluator then fails on for a *type* reason.
- Exactness: `sin`, `cos`, `tan` at `k·30°` and `k·45°` for `k ∈ [−48, 48]` and the inverse table
  of §2.7 rule 5 return the tabulated values exactly.
- Cross-target: the suite's result hash is identical on macOS, Linux, Windows and wasm32.
- Oracle agreement (with W7a): 10,000 random well-typed expressions; reals within 1e-12 relative,
  counts and bools exact, identical error codes.

### W2 — Constrained and compound sketches

**Scope.** Compound-curve expansion (`rect`, `slot`, `polygon`); the IR → forge-solve mapping of
SPEC §4.3 (derived ids, welding, `ccw: false` arcs); evaluation of dimension values; solving with
pinned options; status mapping, flip check and the `sketch` report block; regions by member curve;
`forge_regen::write_back(doc, eval) -> Document`, exposed as `aicad solve --write-back` and in WASM.
forge-solve must guarantee the fixed point of SPEC §4.4 rule 4 (add a test there if missing).

**Acceptance.**
- One unit test per constraint kind mapping, and for `ccw: false` arcs in `tangent`, `radius` and
  `point_on_circle`.
- Compound curves: golden expansions for every member table row, including omitted degenerate
  members (`r = h/2`); the oracle expands independently and matches.
- **Fixed point:** on 1,000 generated constrained sketches (forge-solve's `generate::corpus` lifted
  to IR, plus extrusion), `evaluate(write_back(d))` is bit-identical to `evaluate(d)` and
  `write_back` is idempotent.
- **Parameter sweep:** for the fully constrained sketches, varying one bound dimension by ±20 %
  from the written-back state gives the same geometry as from the original state (within 1e-9) in
  ≥ 99.5 % of cases, and every other case is flagged `SKETCH_LOOP_FLIPPED` or fails loudly.
- Conflicts: spike 04's 217 conflict sketches fail with `SKETCH_CONSTRAINT_CONFLICT` whose sets equal
  a direct forge-solve call's.
- **Oracle replay gate** (with W7a): the 1,000 extruded sketches classify `MATCH`, with zero
  independent constraint-check failures.

### W3 — References core

**Scope.**
- forge-core provenance: keys by feature id, qualifiers (cap member, junction `@c.end`, hole
  position, pattern instance), aliases for merged faces, escaping with `@` and `%`, display names.
  The invariant checker enforces completeness and key uniqueness (except split pieces).
- New crate `forge-refs`, extracted from `forge-naming` (whose `ModelView` depends on
  `forge-regen`, so `forge-regen` cannot use it today): fingerprints with **exact** sizes (from
  `forge-check`), the query evaluator with named/broad tracking, static kind checks, the resolution
  algorithm of SPEC §5.7, candidate query synthesis, probes, and the `refs` report entries.
  `forge-naming` keeps the harness and depends on `forge-refs`.
- In `forge-regen`: plane references (face frames, datums), axis references, `datum_plane`,
  `datum_axis`, `tag`, `regions` by member, reference resolution before each operation.

**Acceptance.**
- One test per row of the §5.7 tables and per query op and predicate; one test per `QUERY_INVALID`
  path.
- **Naming harness v1** (with W11) on the 20 spike models, with every reference expressed as a v1
  query (named sources for faces, `between` for edges, `edge_at` for junction edges):
  (a) dimension ≥ 99.9 %, (b) suppress 100 %, (c) topology ≥ 99 % correct; **0 SILENT_WRONG**; only
  geometry-identical matches reach 0.95.
- New families: `renameCurve` → 100 % exact (no geometric matches); feature rename → 100 % exact;
  parameter edits → 100 % exact; `#k` never appears in a capture.
- Probe property: over every body of the corpus, every probe lies on its entity within tol and at
  least `10·tol` from its boundary.
- Determinism: `refs` report entries are byte-identical across runs and targets.
- Oracle replay: 100 % of probes match exactly one OCCT entity on the v1-on-v0-ops corpus.

### W4 — Booleans

**Scope.** Face–face classification and splitting on forge-ssi curves, regularization,
connected components, non-manifold detection, `unify_same_domain`, provenance per SPEC §5.2 (kept
keys, intersection edges and vertices, aliases), identity (origin propagation, `merged_into`,
splits, consumed bodies), `op`/`targets` on extrude and revolve, the `boolean` feature, and errors
with details (`min_distance` for `BOOLEAN_NO_INTERSECTION`).

**Acceptance** (aligned with the F1 gate).
- ≥ 99.5 % `MATCH` against the oracle on the DeepCAD replay subset (sketch + extrude with join and
  cut) and on the generated boolean corpus of W7b (3 seeds × 2,000: coplanar faces, tangent
  cylinders, coincident edges, through cuts, splits into pieces, consumed targets); **0
  POTENTIAL_SILENT_WRONG**.
- Proptests: `vol(A ∪ B) = vol A + vol B − vol(A ∩ B)` and `vol(A − B) + vol(A ∩ B) = vol A` within
  1e-9 relative; `forge-check::validate` clean after every operation.
- Naming harness boolean families (W11): ≥ 90 % correct on topology changes, 0 SILENT_WRONG.
- Bit-identical reports on all four targets.

### W5 — Holes and patterns

**Scope.** Hole tool profiles (SPEC §6.5), the size table from constants, the four placement forms,
position checks, one combined cut, the `holes` report; patterns (linear, circular, mirror; feature
seeds re-applying tools with re-resolved targets; body seeds; `skip`; instance provenance;
orientation handling for mirror).

**Acceptance.**
- Golden tests for every size × fit and every preset (`iso4762`, `iso10642`, `std` insert,
  `thread`), with closed-form volumes; oracle `MATCH`.
- Error corpus: `HOLE_POINT_OFF_FACE`, `HOLE_DUPLICATE_POSITION`, `HOLE_UP_TO_MISSED`,
  `HOLE_MISSES_BODY`, `HOLE_BREAKS_THROUGH` reproduced by both engines.
- Generated pattern corpus (linear up to 12 × 12, circular up to 36, mirrors; feature and body
  seeds; instances running off the part): ≥ 99.5 % `MATCH`, 0 POTENTIAL_SILENT_WRONG, identical
  `skipped` lists.
- The MakerBench v1 hole and pattern tasks pass with their reference solutions on Forge.

### W6 — Fillet, chamfer, shell, draft (F2)

**Scope.** Rolling-ball fillets for the analytic pairs of SPEC §6.6, the normative spherical corner,
other vertex blends, chain expansion; chamfers (three forms); shell with intersection joins; draft
(optional); feasible-range computation (`max_feasible_r`, `max_feasible_d`,
`max_feasible_thickness`); provenance (`blend`, `bevel`, `corner`, `offset`, `rim`).

**Acceptance** (the F2 maker release gate of FORGE.md).
- Validity ≥ OCCT on the 300-case fillet/chamfer/shell corpus and the maker corpus.
- `MATCH` + `NORMALIZED` ≥ 99 % against the oracle, with `NORMALIZED` ≤ 5 % of programs; 0
  POTENTIAL_SILENT_WRONG.
- **Feasible-range property** on analytic cases: filleting with `r = max_feasible_r` succeeds and
  with `1.01 · max_feasible_r` fails with `FILLET_RADIUS_TOO_LARGE` (same for chamfer and shell).
- Naming harness fillet families: ≥ 90 % correct on topology changes, 0 SILENT_WRONG; provenance
  survival ≥ 99 %.

### W7 — Oracle v1

The oracle must implement the SPEC, not Forge. It reads the v1 schemas at run time, as today.

| Slice | Phase | Scope |
|---|---|---|
| **W7a** | B | Port of v1 validation and migration; the Python expression parser, type checker and evaluator; compound curves; face frames and datums; **sketch replay** with an independent constraint checker written from SPEC §4.3 (not from forge-solve's residuals); **reference replay** (probe matching plus re-checking the geometric predicates of each query); report v1; `kernel-diff` v1 with the new classes |
| **W7b** | C | Booleans via `BRepAlgoAPI_*` with the §8.3 normalizations (same-domain merge, curve recognition), origin tracking, split/consumed detection; hole tools as revolved profiles; patterns; `oracle gen` v1 (boolean, hole and pattern programs with params); error corpus v1 |
| **W7c** | D | Fillet/chamfer/shell/draft with the §8.3 rules; the **independent-refs** mode (provenance keys from OCCT history, own query evaluation, `REF_MISMATCH`) |

**Acceptance.**
- The body gate (closed-form predictions) extended to holes (closed-form tool volumes), patterns
  (instance count × seed volume for disjoint instances) and booleans of boxes and cylinders.
- Error corpus v1: at least 3 cases per **E** code the oracle can compute (all but the
  replay-only `SKETCH_*` solver outcomes), each with the expected code; the oracle agrees with every
  expectation.
- **Replay mutation tests:** tampered Forge reports (a solved point moved by 1e-6, a probe moved to a
  neighbouring face, a member added that fails its predicate) are classified
  `POTENTIAL_SILENT_WRONG` or `ROBUSTNESS`, never `MATCH`.
- `kernel-diff` v1 unit tests for every row of SPEC §8.2 and every §8.3 rule; the severity order of
  §8.4.
- Nightly job: fresh seed, all v1 generators, MATCH-rate trend (BACKLOG P1 item extended to v1).

### W8 — CadScript v1

**Scope.**
- `@aicad/std` v1 `.d.ts`: `param`, `measure`, `point`, `rect`, `slot`, `polygon`, the `C`
  constraint namespace, feature handles with the query methods of SPEC §5.10, `hole` with `grid`,
  `boltCircle`, sketch `points(…)` and list placements, `fillet`, `chamfer`, `shell`, `draft`,
  `boolean`, `linearPattern`, `circularPattern`, `mirror`, `datumPlane`, `datumAxis`, `tag`, math
  functions and unit helpers, `X`/`Y`/`Z`.
- Compiler: document and part parameters; expression lowering to canonical IR strings (a TS port of
  the parser, canonical printer and type checker, validated by the I9 suite; **no TS evaluator**);
  unit and type errors at the span of the offending sub-expression; constraints; queries as method
  chains (bijection with the AST); static `QUERY_UNKNOWN_CURVE`; captures carried over from `base`;
  curve-rename detection offering the `renameCurve` fix; features referenced by id.
- Printer and splice for every new construct; printing a v0 IR prints its migration.

**Acceptance.**
- `compile(print(ir), { base: ir }).ir` deep-equals `ir` for every v1 conformance program, every
  MakerBench v1 reference and fast-check random v1 documents (5,000 cases once, 300 per CI run);
  the printer is a fixed point.
- Every **R** code of SPEC §7.5 has a CadScript test that produces it at the right span, with a
  hint.
- The TS expression port passes the whole I9 expression suite (parse, canonical, types, errors).
- `tsc` type-checks every MakerBench v1 reference against the new `.d.ts`.
- Splicing keeps untouched statements verbatim (the existing property, extended to v1 edits).

### W9 — Command layer and bindings

**Scope.** WASM and napi exports (`evaluate` v1, `params`, `writeBack`, `captureRefs`, candidate
acceptance); `aicad` CLI verbs (`eval` with the v1 report, `migrate`, `solve --write-back`,
`refs --capture`); DocStore domain ops of SPEC §0.6 and §5.9 with inverses; regenerated
`@aicad/ir-types`.

**Acceptance.**
- Every op has an apply → undo → identical-IR test and a redo test.
- `renameCurve` property: on random documents, renaming any curve leaves every reference `exact`
  and the report identical except display names.
- `writeBackSolution` and `captureRef` are idempotent at the op level; a transaction containing
  them undoes as one step.

### W10 — Agent tools and playbooks

**Scope.**
- Playbooks for every code in SPEC §7.5, computed from `details`: `FILLET_RADIUS_TOO_LARGE` →
  "use r ≤ max_feasible_r, or fillet before the feature that narrowed the face";
  `REF_*` → the candidates with display names, a render highlight from their probes, and the
  `repair_ref` call that applies a candidate's query; `EXPR_UNIT_MISMATCH` → the unit to add;
  `SKETCH_CONSTRAINT_CONFLICT` → the suggested removal; `BOOLEAN_NO_INTERSECTION` → flip the
  direction or check the plane, with `min_distance`; `HOLE_POINT_OFF_FACE` → the distance and the
  face's extent. Remove the message regexes (`regionIdsFromMessage`).
- Tools: `set_param`; `query` (evaluate a selector against the current model: count, display
  names, whether it is unique, probes); `repair_ref`; `sketch_edit` (constraints, returns DOF and
  conflicts); `describe` (an entity by display name or probe). `ir_summary` v1 lists parameters and
  unresolved references. The ~6k-token DSL reference is rewritten for v1.
- Verification ladder: L1 treats `warning`-severity codes on features the agent just edited as
  failures to explain; L3 gains the editability probe (vary every driving parameter ±20 %, the
  model must still evaluate).

**Acceptance.**
- The playbook coverage test reads the v1 code list from `ir-v1.constants.json` (add the catalogue
  there) and fails on any code without a hint.
- One computed-hint test per code, from fixture reports produced by Forge and the oracle.
- Offline trajectory replay passes; live MakerBench runs do not drop any v0 tier by more than 3
  points (the existing merge gate).

### W11 — Evals and naming harness

**Scope.**
- MakerBench v1 tasks (§5) with `requires` tokens (`ir/1`, `op/boolean`, `op/hole`, `op/fillet`,
  `op/chamfer`, `op/shell`, `op/pattern`, `op/draft`, `sketch/constraints`).
- Check DSL: hole checks read the report's `holes` (and cylindrical faces) instead of sketch
  circles, so `curve_count` and `hole_pattern` keep working when holes become features; `param`
  checks (set a parameter, re-evaluate, assert); `ref_stability` checks for T4 edits.
- Naming harness v1 in `forge-naming`: references as v1 queries; new mutation families (boolean
  split and merge, hole add/move/resize, fillet add/remove, pattern count changes, parameter edits,
  `renameCurve` ops, feature renames) and edit **sequences** (capture at v0, resolve at vN), as the
  spike's follow-ups ask.

**Acceptance.**
- Every v1 task's reference solution passes all of its hidden tests on both Forge and the oracle;
  the mutant solver shows the hidden tests catch real mistakes.
- The harness gates of W3, W4 and W6 run in CI (`cargo run -p forge-naming --release --bin
  naming-harness`, exit 1 on NO-GO).

## 5. MakerBench v1

Target: **+40 tasks**, reaching the ~100 needed on the way to 300 by beta.

| Group | Tasks (examples) | Exercises |
|---|---|---|
| Rewrite v0 workarounds idiomatically (same prompts, new references) | enclosure with lid (shell + lip join), parts tray (shell + divider join), knob (chamfer), drawer pull (fillet), spool holder (chamfer), jar with lid (shell), Gridfinity cell (`rect` with `r`), hex standoff (`polygon` + tapped hole with `thread`) | shell, join, chamfer, fillet, compound curves, cosmetic threads |
| Holes | counterbored M4 plate, countersunk bracket, bolt-circle flange, heat-set insert bosses in a lid, blind tapped holes | every hole kind and placement form |
| Patterns and datums | vent slots (linear cut pattern), spoked wheel (circular), mirrored bracket arms, angled mount on a datum plane | patterns, mirror, datums, sketch on face |
| Blends and order | filleted box then shell (feature order matters), rounded enclosure with chamfered lid edge | fillet/chamfer/shell interplay and references across them |
| Constraints | fully constrained bracket profile driven by 3 parameters | constrained sketches, measured parameters |
| T4 edits | "walls 3 mm", "M4 instead of M3", "add a fillet to the top edges", "move the holes 5 mm inward", "one more row of vents" | `set_param`, reference stability (the fillet survives), minimal edits |
| T5 | under-specified requests whose defaults must become parameters | parameter chips |

## 6. Gates summary

| When | Gate | Measured by |
|---|---|---|
| End of Phase A | Contract frozen; migration gate (6,008 programs metric-identical); I9 suites pass in Rust | W0 |
| End of Phase B ("v1 on v0 ops") | Expression suite bit-identical on 4 targets and within 1e-12 of the oracle; constrained-sketch replay 100 % MATCH; naming harness v1 GO with 0 SILENT_WRONG; CadScript v1 round-trip; playbook coverage | W1, W2, W3, W7a, W8, W10 |
| F1 (end of Phase C) | ≥ 99.5 % MATCH on DeepCAD boolean replays and generated boolean/hole/pattern corpora; 0 POTENTIAL_SILENT_WRONG; harness boolean families ≥ 90 % with 0 SILENT_WRONG | W4, W5, W7b, W11 |
| F2 (end of Phase D) | FORGE.md F2 gate; `NORMALIZED` ≤ 5 %; feasible-range property; independent-refs mode 0 `REF_MISMATCH` on the maker corpus; provenance survival ≥ 99 % | W6, W7c, W11 |
| Every PR | sampled oracle diff, trajectory replay, conformance suites in all three languages | CI |

## 7. Risks

| Risk | Mitigation |
|---|---|
| forge-ssi or booleans slip, blocking W5 and W6 | Holes and patterns build their tool bodies and oracle cases against `new_body` first; the "v1 on v0 ops" milestone ships independently; the agent keeps working against the oracle backend. |
| The three expression implementations drift | One conformance suite (I9) run by Rust, TS and Python in CI; the TS port does no evaluation. |
| Stricter reference failures annoy users | Candidate queries make repair one click; the harness measures how often non-exact outcomes occur per mutation family; ADR 0013 open point 2 goes to the product owner early. |
| OCCT history is too weak for independent-refs | Replay mode is the blocking gate; independent-refs starts as a nightly report and becomes a gate only at F2. |
| Fillet corners disagree with OCCT beyond normalization | Normative spherical corner first; other corners are `NORMALIZED` with a budget; a normative corner family can come with fillet `v: 2`. |
| Capture churn in git | Measure diff noise on MakerBench edits in Phase B; switch to "refresh on edit/repair only" (SPEC open point 5) if it hurts. |
| Query evaluation cost on every regeneration | Resolved references go into the cache key; unchanged prefixes skip resolution; queries over one feature's entities use a per-feature index. |
| Standard tables are wrong | SPEC open point 1 blocks acceptance of §6.5; the tables live in constants, so a correction is a data change plus a hole `v` bump. |

## 8. Definition of done

IR v1 is done when:
1. SPEC-v1-DRAFT is accepted (open points resolved) and replaces SPEC.md as the normative spec;
   ADR 0013 is accepted and ADR 0006 is marked amended.
2. Forge, the oracle and CadScript implement every section; the gates of §6 up to F2 pass.
3. All MakerBench tasks run on `ir/1`, and the v0 tasks still score at least as well.
4. ARCHITECTURE §3–§4, FORGE.md (provenance grammar), the agent's DSL reference and
   `@aicad/std` docs describe v1.
