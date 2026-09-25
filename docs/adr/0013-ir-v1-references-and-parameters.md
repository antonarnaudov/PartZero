# ADR 0013: IR v1 references, parameters and constraints

- **Status:** Accepted (2026-09-23; decisions appended)
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §3 "IR essentials"; amends [ADR 0006](0006-native-persistent-naming.md) (resolution policy) and extends [ADR 0004](0004-feature-graph-ir.md)
- **Spec:** [forge-ir SPEC-v1-DRAFT.md](../../forge/crates/forge-ir/SPEC-v1-DRAFT.md) · **Plan:** [IR-V1-IMPLEMENTATION-PLAN.md](../IR-V1-IMPLEMENTATION-PLAN.md)

## Context

IR v0 (`aicad.ir/0`) covers sketches of lines, arcs and circles, and extrudes and revolves that
create new bodies. Forge matches the OCCT oracle on more than 6,000 random programs. The Phase 1
maker MVP ([ROADMAP](../ROADMAP.md)) needs parameters, constrained sketches, booleans, holes,
fillets, chamfers, shells, patterns and datums. Every one of those except parameters needs a way to
**point at topology**: "fillet these edges", "sketch on that face", "cut these bodies".

Evidence that shapes the design:
- **Spike 02** ([02-naming.md](../spikes/02-naming.md)): native provenance names survive every
  dimension edit that keeps curve ids, but a **validation layer** is what turns 78 silent re-binds
  into flags. The most common silent re-bind is an exact name hit on **one piece of a split**. Feature
  renames make every reference missing. It produced nine recommendations (BACKLOG).
- **Spike 04** ([04-sketch-solver.md](../spikes/04-sketch-solver.md)): forge-solve is deterministic,
  explains DOF, redundancy and minimal conflicts, and keeps input geometry when it fails. JSON float
  parsing is not yet bit-exact (`float_roundtrip`).
- **Spike 07**: the agent's repair playbooks parse v0 error *messages* with regexes, because v0
  errors carry no structured context.
- **MakerBench** (61 tasks): 8 tasks document v0 workarounds in their reference or notes
  (separate floor and wall bodies instead of a shell or join, chamfers and fillets drawn into the
  profile), 17 prompts mention a feature v0 lacks or fakes (chamfers, rounds, taps, inserts,
  shells), every hole is a sketch circle, the hex standoff hand-computes its vertices, and
  literal-only numbers defeat the editability probe.
- **Three writers, two engines.** The IR is written by the UI, the agent (through CadScript) and
  external MCP clients, and evaluated independently by Forge and OCCT. Every rule must be
  implementable identically in Rust, TypeScript and Python.

## Decision

### References

1. **A reference is a typed query plus a declared cardinality, with an optional capture.** It is
   stored as `Ref { kind, q, card, capture? }` (SPEC §5.1). `q` is a JSON query AST (§5.3) and is
   the *intent*; `card` (`one`, `some`, `any`, or an exact count) makes every reference a set;
   `capture` records what the reference resolved to when it was last accepted (provenance keys and
   fingerprints). Kernel indices, `#k` indices, coordinates-as-identity and feature names are never
   stored.
2. **Named sources and broad sources.** Query leaves that designate specific entities by identity
   (`cap`, `side`, `edge_at`, `between` of two named sets, `body`, `hole_face`) are *named*; leaves
   that mean "all of a kind" (`sides`, `created`, `bodies`) and all navigation are *broad*. Only
   named members are validated against the capture and may fall back to geometry. A change in the
   broad part of a result is the query's meaning at work and is reported as `REF_SET_CHANGED`, not
   repaired.
3. **Only exact resolutions and geometry-identical repairs are used without confirmation.**
   Resolution runs exact provenance → capture validation (type change, split, merge) →
   disambiguation → geometric fallback (SPEC §5.7). A geometry-identical match is auto-accepted at
   confidence 0.99. **Every other non-exact outcome fails the feature** with ranked candidates, each
   with a probe and an engine-synthesised query that selects exactly that candidate; the feature
   passes its input through, so one regeneration shows every broken reference. This **amends ADR
   0006**, whose layer 4 "warns and gives a confidence": we now fail instead of proceeding on a
   warned guess.
4. **Features are keyed by id.** Every cross-feature reference stores the target feature's id;
   provenance keys use feature ids; names appear only in display names. A feature rename touches one
   field.
5. **Renames are explicit edits.** `renameCurve` rewrites every query and capture that names the
   curve in the same undoable op. In CadScript, a query naming a curve that no longer exists is a
   compile-time error (`QUERY_UNKNOWN_CURVE`) with a rename quick-fix, so renames resolve exactly
   instead of through a 0.99 geometric match.
6. **Body identity is an origin.** A body is identified by the feature that created it and one curve
   of its region (the smallest outer curve id at creation). Caps carry that member. Booleans pass
   the **target's** origin to the result; split pieces share it; coplanar faces are merged after
   every body operation (the target's key survives, the others become aliases).
7. **The naming conventions are normative** (SPEC §5.2): cap/end-cap start and end per direction,
   side–side junction qualifiers (`@bow.end`) instead of `#k`, and the key of every entity each new
   operation creates.

### Parameters and expressions

8. **Parameters are named, typed and scoped.** Document-level and part-level lists; units `mm`,
   `deg`, `ratio`, `count`, `bool`; optional bounds; derived parameters are parameters whose value
   is an expression; *measured* parameters read a sketch's reference dimension. Parameters share the
   feature namespace because both are CadScript `const`s. Expressions refer to parameters by name:
   a broken name is a rejection, never a silent re-binding.
9. **Expressions are stored as canonical strings in a small grammar of our own** (SPEC §2.3), not
   as JSON ASTs and not as CadScript. A plain literal stays a JSON number, so v0 documents are
   already valid v1 values.
10. **Dimensional analysis with context-typed literals.** Types are Bool or a real with a dimension
    vector (length, angle). A bare literal is *Flex*: it adopts its neighbour's unit in additive
    positions and the field's unit at the root, and is a dimensionless coefficient in products.
    `width - 12` and `10 * sin(30)` are legal at a length field; `width + holes` and `sin(tilt)`
    are not.
11. **One evaluator of record, in Rust, bit-identical everywhere.** Degree trigonometry with exact
    quadrant reduction and exact values at 0°, 30°, 45°, 60° (and their inverses), binary
    exponentiation for integer powers, libm for the rest. CadScript and the UI never evaluate for
    semantics. The oracle re-implements the evaluator in Python and is compared at 1e-12 relative.

### Sketch constraints

12. **Two sketch modes.** *Explicit* sketches may use expressions in coordinates and compound curves
    (`rect`, `slot`, `polygon`, expanded normatively into member curves with stable ids);
    *constrained* sketches store literal geometry plus forge-solve constraints whose dimension
    values may be expressions. Mixing is rejected.
13. **The stored geometry of a constrained sketch is the last solution and the next initial guess.**
    Evaluation solves from it and never writes it; the command layer writes the solution back after
    a committed edit. A stored guess that already satisfies the constraints is returned unchanged
    (fixed point), so write-back is idempotent. Curve ends that coincide are welded, so loops need no
    explicit coincident constraints. The solver's options and algorithm are pinned by the sketch's
    `v`.
14. **A failed solve fails the sketch.** Conflicts and non-convergence are feature errors with
    forge-solve's minimal conflicting sets and suggested removals as details. The stored geometry is
    never used as a fallback, because it satisfies *old* values.

### Evaluation, reports and verification

15. **Evaluation is a pure function of the document.** Solutions, captures and rename maps are
    written only by command-layer ops inside the user's transaction.
16. **Errors carry structured details** (SPEC §7.4–§7.5): keys, display names, probes, values and
    feasible ranges (`max_feasible_r`). Warnings have a severity. Playbooks read details, not prose.
17. **The oracle computes what it can and replays the rest with independent checks.** It computes
    parameters, explicit sketches, datums and all geometry; it replays Forge's constraint solutions
    (checking every constraint with its own residuals) and reference resolutions (matching probes,
    re-checking geometric predicates). A nightly *independent-refs* mode derives provenance from
    OCCT's shape history and compares resolved sets (`REF_MISMATCH`).

### CadScript v1

18. Arithmetic, `param()`, ternaries and the std math functions are allowed in arguments (reversing
    v0's literal-only rule). Queries are method chains on feature handles (`slab.cap("end")`,
    `slab.sides().edges().parallel(Z)`, `edgesBetween(a, b)`), in bijection with the AST so the
    printer round-trips them. Constraint builders live in one namespace, `C`, so `distance`,
    `angle` and `radius` stay free as parameter names. Signed directions are strings (`"+Z"`),
    because TypeScript types `+Z` as a number.

## Consequences

**Positive:**
- **No silent re-binds by construction.** Splits either return every piece or fail; renames are
  exact; auto-acceptance is limited to identical geometry; kind changes are flagged.
- **References say what the user meant.** "All vertical side edges" stays a query and picks up new
  edges; "this face" stays an identity and fails loudly when it disappears.
- **Agents get repairs, not riddles.** A failed reference comes with candidates, probes for renders
  and ready-to-apply queries; a failed fillet comes with `max_feasible_r`.
- **Editability is measurable.** Parameters and bound dimensions make MakerBench's editability probe
  (vary parameters ±20 %) meaningful.
- **v0 carries over unchanged.** Migration only rewrites sketch names to ids, and reports are
  metric-identical.
- **Differential testing extends to v1.** Parameters and geometry are computed independently; the
  parts that cannot be recomputed are independently verified.

**Negative / costs:**
- **Every new operation must assign keys per SPEC §5.2** and keep them stable. This is the bulk of
  the naming work for F1/F2, and the naming harness must be extended to booleans and fillets.
- **Stricter than ADR 0006.** More edits end in a repair card instead of a best guess. The UI needs a
  good one-click repair flow, and the agent needs a `repair_ref` playbook.
- **Three implementations of the expression language** (Rust evaluator, Python oracle, TypeScript
  parser/printer/type checker) must stay in lock-step; a shared conformance suite is mandatory.
- **Capture churn.** Refreshing captures on commit makes `document.json` diffs noisier.
- **Independent-refs mode in the oracle** (provenance from OCCT history) is substantial work; until
  it exists, query semantics are verified only through replay and predicate re-checks.
- **Behavior versions accumulate.** forge-solve changes that move under-constrained solutions need a
  new sketch `v`, and old ones must keep evaluating.

**Follow-ups:**
- Mark ADR 0006 "Amended by ADR 0013" and add 0013 to the [ADR index](README.md) when this ADR is
  accepted; update ARCHITECTURE §3 ("References", "Expressions") to point at the v1 SPEC.
- forge-core: add `@` and `%` to `RESERVED_NAME_CHARS`, key provenance by feature id, add the
  junction qualifier; enable serde_json `float_roundtrip` workspace-wide.
- Move the resolver and fingerprints out of `forge-naming` (which depends on `forge-regen`) into a
  crate `forge-regen` can depend on; keep the harness in `forge-naming`.
- Re-run the naming harness with boolean, fillet and parameter mutation families (BACKLOG).

## Alternatives considered

**References**

| Alternative | Why not chosen |
|---|---|
| Store provenance names only (spike 02's `EntityRef`) | Cannot express intent ("all vertical edges"), treats set changes as errors, and a name alone re-binds silently to one piece of a split. Kept as the capture. |
| Persist kernel indices or `#k` | The classic naming bug; `#k` order already flips when a curve is reversed (spike 02 defect 2). |
| Pure geometric selectors (build123d/CadQuery style `>Z`, `.filter_by(Axis.Z)`) | Identity changes silently when geometry moves (the "topmost face" becomes another face). Kept as filters on top of named sources, where a change is visible. |
| A string selector language stored in the IR (CSS- or CadQuery-like) | Needs a parser in three languages and loses JSON-Schema validation of every node. The readable form already exists: CadScript. |
| Tags only | Too much burden on users and agents; kept as an optional named handle (`tag`). |
| Proceed on the best non-identical match with a warning (the literal reading of ADR 0006) | Wrong geometry propagates downstream and looks valid; warnings are routinely ignored by agents and people. A loud failure with one-click candidates is cheaper overall. |
| Two policies, strict (CI/agent) and lenient (UI) | Two semantics for one document: cache keys, the oracle and golden reports would all need both. |
| Reference features by name | Spike 02: a feature rename makes every reference missing. |

**Parameters and expressions**

| Alternative | Why not chosen |
|---|---|
| Expressions as JSON ASTs | Verbose, hard for LLMs and people to read in the file, noisy diffs. The canonical string is just as unambiguous. |
| Expressions only in CadScript; the IR stores evaluated numbers | Loses parameter links on every GUI edit, makes the IR not self-contained and breaks the "IR is the source of truth" rule (ADR 0004). |
| Full TypeScript expressions evaluated in JavaScript | `Math.sin` is not bit-identical across engines, radians invite bugs, and evaluation would mean executing user code. |
| Unitless numbers | Misses the errors dimensional analysis exists for (`width + holes`). |
| Every literal must carry a unit | Correct but hostile to agents and people (`width - 12 mm` everywhere). Context-typed literals keep the checks that matter. |
| Radian trigonometry | Makers think in degrees; exact right angles and 30/45/60° values keep hexagons and bolt circles bit-reproducible. |
| Parameters referenced by id | Expressions must stay readable; a stale name is a static rejection, not a silent re-binding, so ids buy nothing here. |

**Sketch constraints**

| Alternative | Why not chosen |
|---|---|
| Store constraints only and solve from scratch | The initial guess would be engine-defined; under-constrained sketches and multi-root systems would jump between branches. |
| Store solved geometry only (constraints as UI metadata) | The IR would lose design intent, and parameters could not drive dimensions. |
| Fall back to the stored geometry when a solve fails | That geometry satisfies older values: silently wrong. |
| One mode mixing expression coordinates and constraints | Ambiguous (which wins?), and the stored guess must be literal for write-back and the fixed-point rule. |
| Let the oracle solve with PlaneGCS | Different minimal-move solutions for under-constrained sketches would produce false diffs. Replay plus an independent constraint check plus the existing solver gate is stronger. |
| Compound curves as CadScript-only sugar | The printer could not recover `rect(…)`, and member ids (`outline.top`) would not be stable names for references. |

**Booleans**

| Alternative | Why not chosen |
|---|---|
| Implicit targets ("everything the tool touches") | Results change when unrelated bodies move; an explicit `"all"` exists when that is wanted. |
| A detached `join` tool silently becomes a new body | Almost always a direction mistake; a loud `BOOLEAN_NO_INTERSECTION` is a better agent signal. |
| No coplanar face merging | Leaves phantom edges on flat faces that queries and fillets trip over, and OCCT's oracle output would need un-merging. |

## Decisions on the open questions (2026-09-23)

The owner delegated product and technical calls to the coordinator. Each decision below applies the core principles, above all "never silently wrong" and "clear signals for the agent". The owner can override any of them with a follow-up ADR.

| # | Question | Decision |
|---|---|---|
| 1 | Hole size tables, heat-set insert preset, FDM compensation | W0 must cite a source for every table value: ISO 273 for clearance holes (fine, medium, coarse), DIN 974-1 / ISO 4762 for counterbores, ISO 10642 at 90° for countersinks, ISO 2306 for tap drills. An unverified value blocks the freeze. The `std` heat-set preset is the **common tapered M2–M8 "standard length" insert** used across the maker community. Its bore diameters follow the insert makers' published datasheets. It has a neutral name, no brand. **FDM hole compensation belongs in the process profile**, not in hole presets, so the IR keeps nominal geometry. |
| 2 | An uncertain reference fails its feature instead of proceeding with a warning | **Yes.** An uncertain match must never silently change the model. The feature fails with `REF_UNCERTAIN` and ranked candidates, and the UI shows a **one-click repair card**. The agent gets the same candidates, each with a query that selects it. |
| 3 | A join whose tool touches nothing; pattern instances that miss | A join or cut whose tool touches nothing is an **error** (`BOOLEAN_NO_INTERSECTION`). It never silently becomes a new body, because the agent needs a clear signal. A pattern instance that misses is **skipped with a warning** (`PATTERN_INSTANCE_SKIPPED`), and the feature fails only if every instance misses. |
| 4 | When reference snapshots refresh | **Only when a reference is created, edited or repaired.** Snapshots are not refreshed on every commit. This keeps `document.json` diffs readable in git. |
| 5 | Scope trims | **Measured parameters are deferred to v1.1.** Their section stays in the spec, marked deferred. **Draft is not a Phase 1 exit requirement.** It is implemented in F2 if it is cheap, and it stays in the spec. |
| 6 | Units | mm, cm, in and deg are enough for v1. Parameter configurations (named variants) are deferred. |
| 7 | Fillet corner shapes | Accepted. The equal-radius corner where three planes meet is exact. Other corner types may differ from OCCT within the documented budget, and the differences are tracked in the oracle diff as `NORMALIZED`. |

**Status: Accepted.** SPEC-v1-DRAFT.md stays a draft until W0 freezes I1, I5 and I9.

## Appendix: decision log (contract amendments)

Later rulings on the frozen v1 contract. Each is a SPEC-v1 amendment with a `[W0-n]` tag,
its rationale and its append-only fixtures in SPEC-v1-DRAFT §11.1; this log only records them.

| Date | Tags | Decision |
|---|---|---|
| 2026-09-24 | [W0-19] … [W0-27] | Expressions and parameters: nesting depth defined (an empty argument list counts); limits apply to the stored text and writers refuse edits whose canonical form would exceed them or be rejected; one rejection per expression by a single post-order pass; `atan2` −180 → 180; an exponent overflow under a negative exponent gives 0; `−0` normalization for results and literal parameter values only; bounds typed and evaluated after the value; bounds and ill-typed expressions are dependency edges, one `PARAM_CYCLE` per component at the offending field; `PARAM_FAILED` names the root cause. |
| 2026-09-24 | [W0-28] … [W0-32] | Sketches and datums: forge-solve's `fix`/tangency semantics and length convention for angular conditions are normative; the fixed point is on the welded guess; a solved-size cap on angular errors; write-back reaches its fixed point in at most two steps when a solve joins ends; `through` datum points must be more than *tol* apart; datum-axis origins and face-frame ties fixed. |
| 2026-09-24 | [W0-33] … [W0-38] | References, replay and ports: body keys, junction-vertex qualifiers, repeatable `G/` keys, key survival through merges and the merged-edge key rule; `tagged` pass-through and gated feature-id sources; forge-refs' resolution refinements adopted; probe match radius and body-probe normals; default-mode reference differences and downstream differences are `ROBUSTNESS`; canonical key order is the Rust field order; v0 input keeps the v0 report by default. |
| 2026-09-24 | [W0-39] … [W0-44] | Booleans and the oracle: `modified` means acted on (not geometrically changed); `removed` lists only origins no body carries afterwards; a solid thinner than *tol*/2 on average (`2V/A`) is degenerate and the smallest cut that counts is decided by that, never by a body-relative volume; no same-domain merge after `new_body`; the oracle's seam and edge-merge count normalizations, pair-based conic recognition with a curve-relative tolerance, parabola/hyperbola as `bspline`, adaptive mass properties. (Degeneracy and join connectivity revised in the review row below.) |
| 2026-09-24 (review) | [W0-39], [W0-41] revised; [W0-33], [W0-35], [W0-40], [W0-42], [W0-43] made precise; [W0-45] | Contacts are decided after [R-3] coincidence (overlaps and layers nowhere thicker than *tol* are contacts; a cut meets when a target point is inside a tool farther than *tol* from its boundary) and `2V/A ≤ tol/2` applies to each result piece only, never to the common part; the join failure row stays per tool (joining through another tool withdrawn); `merged_into` never holds the kept origin; a repeated `G/` key never widens a captured selection; probe radius `clamp(1e-6·s, 2·tol, 5·tol)` with a sign test on normals; the oracle's edge merge uses transversal faces and its conic pair tests use `ANGULAR_TOLERANCE` (no unnamed tolerances); `EXPR_NOT_INTEGER` details follow the catalogue. Superseded sentences are struck through in the SPEC. |
| 2026-09-24 (review 2) | [W0-46] … [W0-50]; [W0-41] step 2 and [W0-45] revised | The `expr`/`subexpr` details are canonical text for every expression code (the node where the rule failed; a literal as a JSON value; `EXPR_SYNTAX` keeps the stored text iff it lexes), replacing [W0-45]'s "stored text"; `invalid/documents.json` can pin `details`, and pins `PARAM_CYCLE`'s `cycle`; suites count fixtures with lower bounds; contacts and meets use one measure (within *tol* of both a target face and a tool face), so through-slits and embedded tools wider than *tol* meet; Forge's snap claim limited to what §8.2 actually bounds; the oracle's carrier and transversality tests named (`t₀ · t₁ < 0` added, residue documented) and section types decided by the pair list alone with positions within *tol*; edge probes carry a normal. |
| 2026-09-24 (review 3) | [W0-51] … [W0-54]; [W0-49]'s typing and [W0-46]'s rationale revised | Plane–cone sections by a named test (ellipse iff `\|n · a\| > sin α + ANGULAR_TOLERANCE`, lines only through the apex, parabola/hyperbola `bspline`); a section edge is a conic only when its pair qualifies **and** each engine's own curve lies within *tol* of that conic, so near-miss singular pairs are `bspline` and a disagreement is an ordinary `edge_types` mismatch (the pair list alone was unsound); a region containing a ball wider than *tol* is volume even when coincident target and tool faces bound it on both sides (covered fins, thin walls); a cusp edge's probe has no normal and probes without one match by position alone (also the transition until Forge emits edge normals); fixture `details` are matched to distinct errors, `null` meaning absent. |
