# aicad oracle: OCCT reference evaluator for IR v0 and IR v1

The oracle evaluates the same `aicad.ir/0` and `aicad.ir/1` documents as Forge, using OCCT through
build123d/OCP. It emits the same `aicad.metrics/0` / `aicad.metrics/1` reports, so the two engines
can be diffed under the rules in `forge/crates/forge-ir/SPEC.md` §6 (v0) and
`forge/crates/forge-ir/SPEC-v1-DRAFT.md` §8 (v1). IR v1 support is described in
[IR v1 (W7a)](#ir-v1-w7a); the rest of this file describes the v0 oracle, which v1 reuses.

- It is **dev/CI tooling only and is never shipped**. OCCT is LGPL. See `CLAUDE.md`, "Own the core; borrow only as oracles".
- It implements SPEC revision **2026-09-23b** (rules tagged [R-1]…[R-15]), and nothing else.
- Where the spec still leaves room, the oracle's reading is listed under [Open spec points](#open-spec-points). Fix those in the spec, not here.

## Setup

```bash
cd oracle
uv sync                 # creates .venv with the pinned CPython and wheels
uv run pytest           # about 1,360 tests (245 v0, the rest v1), about 2 min
```

**Python is pinned to 3.13** (`.python-version`).
- `cadquery-ocp-novtk 7.9.3.1.1` (OCCT 7.9.3) ships cp310–cp314 wheels for macOS arm64/x86_64, manylinux_2_31 x86_64/aarch64 and Windows.
- 3.13 is the newest CPython that every transitive dependency also covers.
- Verified: `uv sync` on macOS arm64, plus `uv pip install --dry-run --only-binary :all: --python-platform x86_64-manylinux_2_31` for Linux x86_64.

**`build123d==0.12.0`** is pinned. It is the latest release on OCCT 7.9.
- 0.13.0 (2026-09-21) moved to OCCT 8.0.1. We don't adopt a brand-new major OCCT for the reference engine without a separate evaluation.
- The oracle calls OCP directly for everything geometric.
- build123d is used for its version string and for the `--step` debug export.

The JSON Schemas and `ir-v0.constants.json` are **read at run time** from `forge/crates/forge-ir/schema/`. They are never vendored. Override the location with `AICAD_IR_SCHEMA_DIR`.

## IR v1 (W7a)

Workstream W7a of [IR-V1-IMPLEMENTATION-PLAN](../docs/IR-V1-IMPLEMENTATION-PLAN.md): the oracle reads
IR v1, evaluates it independently of Forge, and diffs it with `kernel-diff` v1. The code is in
`src/aicad_oracle/v1/`; the v0 modules are reused for sketches, OCCT construction and the body gate.
The schemas and `ir-v1.constants.json` are read at run time (never vendored); the handful of
constants used in arithmetic are asserted against the constants file at load time.

### What the oracle computes and what it replays (SPEC-v1 §8.1)

| Item | Oracle |
|---|---|
| Rejection pipeline (§0.5 rule 4) | computes: strict JSON (correctly rounded, duplicate keys rejected) → v0/v1 dispatch → W0's raw pre-checks → `ir-v1.schema.json` → a port of W0's structural validation → the oracle's own expression checker (syntax, names, functions, arity, units, types, `EXPR_SCOPE`, `PARAM_CYCLE`) |
| Migration of v0 input (§9.1) | computes: `migrate_v0_to_v1` with the rename report; canonical JSON printed byte-identically to Forge's `to_json` |
| Parameters and expressions (§2) | computes: own lexer, parser, canonical printer, type checker and IEEE evaluator (exact degree trigonometry, binary exponentiation, `-0 → +0`), `PARAM_FAILED` propagation, bounds |
| Explicit sketches, compound curves (§4.1, §4.2) | computes |
| Constrained sketches (§4.3–§4.4) | never solves. Checks run in the §7.1 order: the dimension values (`SKETCH_INVALID_DIMENSION`), then the `plane` reference, then the operation. Standalone: only the §4.4 rule 4 **fixed point** (the welded stored guess, when it already satisfies every driving constraint to `SOLVE_TOLERANCE`), else `ORACLE_SOLVE_REQUIRES_REPLAY`; `sketch.status` and `sketch.dof` are then **omitted** (they are forge-solve's verdict, which the oracle cannot compute). With a Forge report (`--replay`, `oracle diff`): **replays** only the *numbers* of `sketch.solved` — the replayed geometry is the document's curves in document order, with the document's `kind`, `construction` and `ccw` — after an **independent check** written from the SPEC's constraint table (`v1/constraints.py`, one unit test per row): `solved` must list exactly the document's curves, in order, with the same kind, `construction` and `ccw` and finite numbers; every driving constraint holds to `SOLVE_CHECK_TOLERANCE` on the replayed geometry — angular conditions scaled by the welded guess's lengths (the convention of the solver pinned by §4.4 rule 3); a curve–curve `tangent` without a joint in the mode `internal` gives, or (omitted) the welded guess decides; a line–arc tangency at a joint also to first order (line ⟂ radius); an arc–arc tangency at a joint as forge-solve's `TangentCurvesAt` does — collinear radii at the joint, tangency in *either* mode, `internal` not applied; a `fix` holds every coordinate `x`/`y` do not give at the welded guess —; welded ends are bit-identical; `sketch.dimensions` lists the document's dimension constraints in order with the same `driving` flag and every driving `value` equals the oracle's own evaluation (§8.1's "equals" is read at `PARAM_VALUE_REL`, as §8.2 compares real parameters — the expression fixtures allow libm differences at 1e-12); and when the welded guess is clearly a fixed point (residuals ≤ ½·`SOLVE_TOLERANCE`), rule 4 is enforced: the solution must equal the guess bit for bit, and a Forge `SKETCH_CONSTRAINT_CONFLICT` / `SKETCH_SOLVE_FAILED` is provably wrong. Any failure is `ORACLE_REPLAY_CHECK_FAILED` (POTENTIAL_SILENT_WRONG). Two findings on rules the SPEC does not state are ROBUSTNESS warnings instead, never failures: `ORACLE_REPLAY_SIZE_BOUND` (an angular constraint within the check tolerance at the solver's scale but off by more than *tol* at the solved size) and `ORACLE_TANGENCY_MODE_DIFFERS` (an arc–arc joint tangency solved in the other mode than `internal` / the guess rule). `DEGENERATE_CURVE` then applies to every solved curve (§4.2). `status`/`dof` are copied from the replayed report and marked by an info warning `ORACLE_REPLAYED`. Off a fixed point, `SKETCH_CONSTRAINT_CONFLICT` / `SKETCH_SOLVE_FAILED` are mirrored from the reference (replay-only). |
| Datum planes and axes, face frames (§3) | computes (every mode; the §3.1 face-frame table) |
| References (§5) | standalone: computes them itself — provenance keys for its own bodies (§5.2 rule 3; history through booleans), the query evaluator (every op and predicate), cardinality, capture validation by key. With a Forge report, **default mode** (the §8.1 PR/nightly gate): **replays** Forge's members — an `ok` feature must report a `refs` entry per Ref field (else `ORACLE_REF_UNREPORTED` → ROBUSTNESS); every probe must match exactly one OCCT entity and no two probes the same one (a probe with an outward `normal` — face and body probes, §7.6 — also needs a face there whose outward normal agrees within 1e-3 rad, for a single candidate too, which also tells coincident faces of touching bodies apart; else `ORACLE_PROBE_UNMATCHED` → ROBUSTNESS, and the oracle falls back to its own resolution); the query's geometric predicates and picks are re-applied to them **recursively over the whole query** (union: some operand; intersect: every operand; minus: `a`, and not clearly in a key-free `b`; navigation and `between` through adjacency; `tagged` through the tag's query; key-based sources are left to the set comparison) and the member count is checked against the cardinality (`ORACLE_PREDICATE_FAILED` → POTENTIAL_SILENT_WRONG; a predicate or pick it cannot evaluate there — an empty or failing pool, a non-evaluable normal, radius or material angle — or one the member misses by less than the cross-engine tolerance — radius bounds and `eq` at rel 1e-6 / 1e-9·s, angle tests at 1e-9, extreme at 1e-6·s, size picks at the v0 §6 size tolerance — is `ORACLE_PREDICATE_UNCHECKED` → ROBUSTNESS); the oracle then **builds from Forge's members** (also when its own naming is unavailable), and a set difference from its own resolution, or its own resolution failing, is `ORACLE_REF_DIFFERS` → **ROBUSTNESS** (never MATCH, never REF_MISMATCH). **Independent-refs mode** (`--independent-refs`, nightly, W7c): builds from its own resolution; a set difference is `ORACLE_REF_MISMATCH` → REF_MISMATCH. A Ref **nested in a query's Dir** (an AxisRef such as `{parallel: {edge: Ref}}`) is always the oracle's own resolution in every mode — a wrong nested member of Forge's must steer neither the enclosing query nor the re-check of Forge's members; Forge's entry for it at its JSON pointer (e.g. `/target/q/where/parallel/edge`), when reported, goes through the same probe / predicate / set checks but is never adopted, and a missing one is not `ORACLE_REF_UNREPORTED` (forge-refs does not report them). Convexity orients each face's in-face direction in the face's parametric frame (2D classifier), not with a fixed 3D step. |
| extrude / revolve (§6.2, §6.3) | computes: the v0 construction and body gate, `regions` by member, `new_body` |
| `join` / `cut` / `intersect`, `boolean` (§6.0.3, §6.4) | computes with `BRepAlgoAPI_*` (no fuzzy, not parallel, non-destructive) + `ShapeUpgrade_UnifySameDomain` (§8.3 rules 1–2); identity, split, consumed; gated by set-volume identities. §8.3 rule 3: `edge_types` of body-operation results recognise free-form edges as lines/circles/ellipses within `1e-7·s` (`ShapeAnalysis_CanonicalRecognition`; the SPEC names `GeomConvert_CurveToAnalyticalCurve`, which this OCP build does not expose). `new_body` sweeps keep the v0 construction and v0 metrics (no same-domain merge; see the contract issues). |
| hole, fillet, chamfer, shell, draft, pattern | not yet (W7b/W7c): the feature fails with the engine-internal `ORACLE_UNSUPPORTED_FEATURE`, evaluation continues |

Engine-internal codes (`OCCT_*`, `ORACLE_*`) are never a silent-wrong answer: `kernel-diff` classifies
them as ROBUSTNESS, and caps later differences in the same part at ROBUSTNESS (see "Downstream capping" below). A polygon `n` up to 2^31 never hangs the oracle: all-omitted members are computed without the loop, more than 100,000 sides are `ORACLE_RESOURCE_LIMIT`.

### Commands (v1)

| Command | What it does |
|---|---|
| `oracle eval FILE` | `aicad.ir/1` input → `aicad.metrics/1`; `aicad.ir/0` input keeps the v0 report unless `--report-version v1` (migrate, then the v1 pipeline). `--replay FORGE.json` replays and checks a Forge v1 report (default mode); add `--independent-refs` for the independent-refs mode. Exit codes as v0. |
| `oracle diff DIR --forge-bin BIN` | runs Forge first; when it prints `aicad.metrics/1`, the oracle evaluates with that report as replay input and compares with `kernel-diff` v1. Exit 1 on POTENTIAL_SILENT_WRONG, REF_MISMATCH or CODE_MISMATCH. `--independent-refs`: the independent-refs mode (oracle builds from its own references, `REF_MISMATCH` and `REF_*` warning codes compared). `--a/--b` compares two reports. The number of differences capped at ROBUSTNESS is printed. |
| `oracle golden DIR` | v1 programs get `aicad.metrics/1` goldens. |
| `oracle gen --ir v1` | random valid v1 programs (parameters, derived parameters, bounds, expressions, `rect`/`slot`/`polygon`, datum planes and axes, sketches on faces and on tags, regions by member, `join`/`cut`/`intersect` extrudes, `boolean` features, `tag`s, fixed-point **constrained** sketches, suppression by expression, lifted v0 programs with exact parameters), each accepted by the pipeline and evaluated `ok`. Programs are checked against the Python port of W0's validation; checking them with Forge's v1 CLI too is for when W9 lands. |
| `oracle exprs --count 10000 --out F` / `--check THEIRS.json` | the W1 ↔ oracle expression agreement gate: random cases in the I9 format with the oracle's answers; `--check` compares another implementation's answers (reals 1e-12 relative, counts/bools/codes exact). |

### kernel-diff v1 (SPEC-v1 §8.2–§8.4)

Classes, most severe first: POTENTIAL_SILENT_WRONG, REF_MISMATCH, CODE_MISMATCH, ROBUSTNESS,
NORMALIZED, MATCH. Exact: statuses, semantic codes, the oracle-computable warning codes, count/bool
parameters, regions, bodies (matched by origin, same-origin pieces by nearest centroid), `removed`,
topology counts and `shells`; tolerance: real parameters (1e-12 relative), v0 §6 body metrics,
datum origins (1e-6·s) and directions (1e-9). `valid` must be true on every reported body [R-12].

Parameters: a status or code disagreement is CODE_MISMATCH (evaluation is deterministic), unless an
engine-internal code is involved (ROBUSTNESS); `unit` is compared exactly; a `bool` against a number
is POTENTIAL_SILENT_WRONG either way round.

**Downstream capping (a policy of this tool, not of the SPEC — needs owner sign-off).** After a
feature on which the engines disagree about **status** (one fails, the other not — including the
oracle's `ORACLE_UNSUPPORTED_FEATURE` for hole/fillet/chamfer/shell/draft/pattern against a Forge
`ok`, until W7b/W7c, and a failed replay check), the part states differ by construction (§7.1: a
failed feature passes its input through), so later differences in that part would all be spurious
POTENTIAL_SILENT_WRONG. They are capped at ROBUSTNESS instead — never hidden: each is still listed
(suffixed "downstream of …; would be <class>"), counted in `Comparison.capped`, printed by
`oracle diff`, and noted per part. When **both** engines fail a feature (whatever the codes,
engine-internal or not — e.g. Forge `HOLE_MISSES_BODY` against the oracle's
`ORACLE_UNSUPPORTED_FEATURE`), both pass their input through, the states stay identical, and later
features are classified normally. Not capping after a status divergence on `ORACLE_UNSUPPORTED_FEATURE`
was considered and rejected: it would turn every program with a W7b/W7c feature Forge evaluates
`ok` into a false POTENTIAL_SILENT_WRONG. The cap also applies to the oracle's reference replay
findings (`ORACLE_PREDICATE_FAILED`, `ORACLE_REF_MISMATCH`): downstream, Forge's probes are replayed
onto a different B-rep. It deliberately does **not** apply to `ORACLE_REPLAY_CHECK_FAILED`: the
constrained-sketch check is 2D and depends only on the document, the parameters (measured
parameters, the only state-dependent ones, are v1.1) and Forge's reported solution. Until W7b/W7c land, a `POTENTIAL_SILENT_WRONG`
downstream of such a feature is therefore only visible as a capped count.

Warning codes (§8.2) are compared as a **set** per feature. A report field of the wrong JSON type
(a violation of the frozen I5 interface) is a difference of that field's class, never an exception;
a parameter reported twice is POTENTIAL_SILENT_WRONG.

### Tests

`tests/test_v1_*.py`: all 376 expression fixtures plus parse/print, type-soundness and exactness
properties; all I9 fixtures (196 invalid documents with exact `{code, path}` multisets, 81 migrations
byte-identical, 42 compound expansions, 134 query typings); migration equivalence (v0 report ==
v1 report of the migrated document, bit for bit, over the corpus, the migration fixtures, generated
programs, the error corpus, and parametrized lifts); evaluation (parameters, expression range checks,
compounds, datums, the face-frame table, references, booleans with closed forms and inclusion–exclusion);
`kernel-diff` v1 rows and the replay mutation tests (coordinates *and* structure of `sketch.solved`:
extra / missing / duplicate / reordered curves, `construction` and `ccw` flips, malformed numbers,
dimension values; §4.4 rule 4: an under-constrained fixed point moved along a free degree of freedom,
a solver failure claimed on a fixed point, `fix` with `x` only; probes on neighbouring faces — also on
predicate-free `cap`/`side` queries —, added members failing a predicate nested in `union`, `minus`,
`intersect`, navigation, picks or a `tagged` query, a key-free `minus` exclusion, empty pools,
non-evaluable predicates, radius bounds within the cross-engine tolerance, cardinality, near-ties,
missing `refs` entries, body probes on stacked bodies, probe normals contradicting a single
candidate, AxisRef Dirs in `filter` / `extreme` with wrong outer and wrong nested members; capping
only after a status divergence — reference findings capped, a failed sketch replay check not —,
warning codes as sets, malformed report fields, arc–arc joint tangency end to end); the independent constraint checker
(`test_v1_constraints.py`: one test per row of the §4.3 table, tangency mode and joints — arc–arc
joints with `internal` true, false and omitted —, `fix` with `x`/`y`, the guess-scaled angular
convention and the solved-size note, the fixed point, seeded property tests); the hole-tool
fixture's rejections (its tool dimensions are W7b, skipped); §8.3 rule 3; convexity next to narrow
faces; generator validity and group coverage (every generated program also replays its own report
as MATCH); the CLI.

### Where the oracle had to read the contract (reported to W0)

- Canonical key order is the Rust struct order (serde), not derivable from the schema
  (`properties` are alphabetical); the oracle transcribes it (`v1/jsonio.py`).
- v0 text is read with serde_json's non-correctly-rounded float parser, which migration then copies;
  the oracle emulates it (`jsonio.serde_number`) to stay byte-identical.
- `Query.instance.index` has `minItems/maxItems` in the schema but a coded `QUERY_INVALID` in the
  fixtures; the oracle drops the two keywords from its typed parse.
- `MAX_EXPR_DEPTH` nesting: the oracle counts parentheses, call argument lists, `?:` branches, unary
  operands and `^` exponents (left-associative chains do not nest).
- `datum_axis` origins: `planes` → the point of the line closest to the world origin; `points` → the
  first point. Vertex keys of sweeps: `F/vertex:{…}` of the incident faces' keys.
- §6.0.4 / §8.3 rule 1 ("after every body operation"): does a `new_body` extrude/revolve count? The
  oracle merges only after `join`/`cut`/`intersect`/`boolean`; a `new_body` sweep keeps one side face
  per profile curve (each keeps its `side:<curve>` key; migrated v0 programs keep their v0 metrics bit
  for bit, §9.1). Two collinear adjacent profile lines therefore give two coplanar faces on a new body
  (pinned by `test_new_body_sweeps_are_not_same_domain_merged`). Needs a SPEC decision.
- §8.3 rule 3 names `GeomConvert_CurveToAnalyticalCurve`, which the pinned OCP build does not expose;
  the oracle uses `ShapeAnalysis_CanonicalRecognition` (line / circle / ellipse) at `1e-7·s`.
- §7.2 [W0-16] says the constrained `sketch` block has `status` and `dof`; the oracle cannot compute
  them (it does not solve, §8.1). With a reference they are copied (marked `ORACLE_REPLAYED`); in the
  standalone fixed-point mode they are omitted. The frozen report type omits an empty `dimensions`
  list (`skip_serializing_if`), so an absent list is read as empty in the replay check.
- §8.1 default-mode references vs the W7 acceptance ("a probe moved to a neighbouring face is never
  MATCH"): §8.1 has the PR gate replay Forge's members and re-check only the *geometric* predicates,
  and §8.4 reserves REF_MISMATCH for independent-refs mode, so a Forge that resolves a key-based
  query (`cap`, `side`, `edge_at`, `body`, `tagged`) to the wrong entity builds the same wrong
  geometry in the replaying oracle. The oracle therefore also compares Forge's set with its own
  resolution in the default mode and classifies a difference ROBUSTNESS (`ORACLE_REF_DIFFERS`) —
  never MATCH, never REF_MISMATCH. Needs a SPEC decision (the SPEC does not name this class).
- §7.6 vs §8.1 probe tolerances: face and edge probes are only `≥ 10·tol` (1e-5 mm) from their
  boundaries, but §8.1 matches probes within `1e-6·s`; for `s > 10` mm a valid probe can lie within
  `1e-6·s` of an adjacent entity and match two (`ORACLE_PROBE_UNMATCHED`, ROBUSTNESS). Suggested:
  probes at `≥ 10·1e-6·s` from boundaries, or match within `1e-6` mm.
- §7.6 body probes: "the probe of its face with the smallest key" — that face is often a cap another
  body touches, so the point alone matches both bodies. The oracle's body probes carry that face's
  outward `normal` and the replay uses it to disambiguate; the SPEC should say body probes carry it.
  Edge probes on edges shared by touching bodies stay ambiguous (no normal).
- §4.3/§4.4: forge-solve's model decides a curve–curve tangency without `internal` from the input
  geometry and holds the coordinates a `fix` does not give at their initial values; neither is in
  the SPEC's table. The oracle checks both (from the welded guess). "Satisfies every driving
  constraint to `SOLVE_TOLERANCE`" (rule 4) and "holds to `SOLVE_CHECK_TOLERANCE`" (§8.1) do not say
  how angular conditions become lengths; the oracle uses forge-solve's convention (sin/cos/angle ×
  √(product of the two guess lengths), floored at 1 µm). Its extra bound — off by at most *tol* at
  the solved size — is not in the SPEC, so a violation is the ROBUSTNESS finding
  `ORACLE_REPLAY_SIZE_BOUND`, not a failure, until the SPEC adopts (or rejects) it.
- §4.3 tangency at an **arc–arc joint**: forge-solve (`system.rs::compile_constraint`,
  `TangentCurvesAt`) requires only collinear radii at the joint and ignores `internal`, while its
  own doc on `Tangent.internal` (`model.rs`) describes a forced mode; the SPEC row says nothing.
  The oracle checks what forge-solve defines (collinear radii; tangency in either mode) and
  reports a solved mode other than `internal` / the guess rule as ROBUSTNESS
  (`ORACLE_TANGENCY_MODE_DIFFERS`). The SPEC must say whether such a tangency has a mode.
- §5.8 and Refs **nested in a query's Dir** (an AxisRef, §3.2, e.g. `{parallel: {edge: Ref}}`):
  "one entry per Ref-valued field" does not say whether they get an entry; forge-refs
  (`frames::direction`) drops them. The oracle never adopts Forge's member for them (it always
  resolves them itself), checks Forge's entry when one is reported, and does not require one.
- §3.3 `datum_plane` `through`: only collinearity is rejected (`|cross| ≤ tol·|p1 − p0|`), not
  `|p1 − p0| ≤ tol` as `datum_axis` `points` does; with `|p1 − p0| ≈ 1e-9` and `p2` far away,
  `x = normalize(p1 − p0)` is set by sub-tolerance noise and two kernels' vertex positions a
  1e-12 apart give x axes that §8.2 (1e-9) calls POTENTIAL_SILENT_WRONG. Suggested: also require
  `|p1 − p0| > tol` (and `|p2 − p0| > tol`). The oracle follows the SPEC as written
  (`test_datum_plane_through_with_nearly_coincident_p0_p1_is_ill_conditioned_by_the_spec`).

## Commands

| Command | What it does | Exit code |
|---|---|---|
| `oracle eval FILE [--out R.json] [--self-check] [--step OUT.step]` | Validates FILE (JSON Schema + the `validate.rs` rules), evaluates it, validates the report against `metrics-v0.schema.json`, and prints or writes the report. `--self-check` also prints the gate's findings. | 0 = ok, 1 = a feature failed, **2 = document rejected [R-10]** or usage error, 3 = internal schema violation, 4 = gate findings (only with `--self-check`) |
| `oracle diff DIR\|FILE [--forge-bin BIN] [--golden-dir D] [--report out.md] [--fail-on-robustness] [--fail-on-no-reference]` | For each program, runs the oracle and `BIN eval FILE --format json`, then classifies per §6. Prints a table and optionally writes a Markdown report. | 1 on any `POTENTIAL_SILENT_WRONG` or `CODE_MISMATCH` (also on `ROBUSTNESS` / `NO_REFERENCE` with the flags); 2 on a usage error, including a `--forge-bin` that does not exist or a target with no programs |
| `oracle diff --a A.json --b B.json [--report out.md]` | Compares two reports directly (A = Forge, B = oracle). | same as above |
| `oracle golden DIR [--out D]` | Writes `<D>/<stem>.metrics.json` for every program in DIR. D defaults to `DIR/../golden`. These files **are committed**. | 4 if a gate fails |
| `oracle gen [--count 1000] [--seed 0] [--out ../corpus/generated/] [--jobs N] [--with-reports] [--invalid-per-kind 4] [--invalid-out D]` | Generates random valid F0 programs **and** an error corpus in `<out>/invalid/`. See [Generator](#generator). | 1 if a program could not be produced, or the oracle disagrees with an error-corpus expectation |

`oracle diff` details:
- **Rejection [R-10].** Forge exiting with code 2 means the document was rejected. Both engines rejecting is `MATCH`; only one rejecting is `ROBUSTNESS`.
- **Golden mode.** Without `--forge-bin`, the oracle is compared against `corpus/golden/*.metrics.json`. This is an OCCT-drift check only; it says nothing about Forge. A program without a golden file is `NO_REFERENCE`.
- **Missing Forge binary.** A `--forge-bin` that doesn't exist exits 2; there is no fallback to the goldens. CI builds `forge-cli` and runs `oracle diff … --forge-bin ../forge/target/debug/aicad --fail-on-robustness --fail-on-no-reference`.
- **Crash.** A Forge run that produces no report and doesn't exit 2 counts as `ROBUSTNESS`.

Classification (§6, [R-11]) is the most severe class found in a program, in the order POTENTIAL_SILENT_WRONG > CODE_MISMATCH > ROBUSTNESS > MATCH. The spec does not rank them; this order is the oracle's choice.

| Class | When |
|---|---|
| `MATCH` | Every rule holds, or both engines rejected the document. |
| `ROBUSTNESS` | Only one engine errored or rejected; or either engine reported an engine-prefixed internal code (`OCCT_*`, `FORGE_*`). |
| `CODE_MISMATCH` | Both engines failed the same feature with different **semantic** codes. |
| `POTENTIAL_SILENT_WRONG` | Both engines reported `ok`, but an exact field or a tolerance field differs; or either engine reported a body with `valid` ≠ true (false, missing, null) as `ok` [R-12]. |

§6 arithmetic, implemented exactly in `compare.py`:
- `rel = |a−b| / max(|a|, |b|)`;
- `s = max(1, diagA, diagB)`, with `s = 1` for regions;
- vectors are compared per component;
- the engines' `valid` values are **not** compared with each other [R-13], but each report must have `valid: true` on every body of an `ok` feature [R-12]; a violation is `POTENTIAL_SILENT_WRONG`.

## How it evaluates (module map)

| Module | Role |
|---|---|
| `ir.py` | Typed model; plane resolution with x re-orthogonalised against the normal ([R-14], same arithmetic as `PlaneSpec::resolve`); a line-by-line port of `validate.rs`, with document-wide id/name uniqueness and `RESERVED_NAME` from the constants file. |
| `sketch.py` | **Pure 2D, no OCCT.** Staged sketch errors [R-2]: endpoints, crossings, degenerate loops. Also loop walking, winding-number nesting, regions, canonical order, closed-form areas and moments, and snapping to the axis. |
| `occt.py` | Region → planar face → prism/revol solid → metrics. Every OCCT convention is normalised here; see the next section. |
| `evaluate.py` | §4 timeline: suppression, `SKETCH_SUPPRESSED`, `DEPENDENCY_FAILED` [R-1], error continuation, the body gate, report assembly. |
| `selfcheck.py` | The gate: independent closed-form and §4.4 predictions for every body. |
| `compare.py`, `diffrun.py` | §6 diff and the runner. |
| `generator.py`, `invalidgen.py` | Valid-program generator and error-corpus generator. |

Tolerance comparisons are **inclusive** [R-3]:
- points coincide when `d ≤ 1e-6`;
- lengths are degenerate when `≤ 1e-6`;
- loops are degenerate when `|A| ≤ 1e-12` [R-5].

The crossing test [R-4] is analytic. It examines the pair's **contact points** and fails if one lies more than 2·tol from every endpoint the pair shares:
- **Proper intersections:** line–line, line–circle and circle–circle.
- **Tangency points:** where the gap is ≤ tol, located at the foot point or on the centre line.
- **Endpoint contacts:** curve end points within tol of the other curve.
- **Overlaps:** a shared stretch longer than tol always fails.

## OCCT conventions the oracle normalises

1. **Planes are explicit.**
   - Every sketch builds `gp_Ax3(origin, n, x)` from SPEC §2, so the XZ normal is −Y and the YZ x-axis is +Y.
   - build123d's named planes are never used.
   - Arcs are `Geom_Circle(gp_Ax2(c, n, x), r = |start − c|)`, parametrised counter-clockwise about the normal, and end at the angle of `end − c` [R-6].
2. **Shared vertices.**
   - Each loop junction is a single `TopoDS_Vertex` at the midpoint of the two partnered end points.
   - Its tolerance is `max(1e-7, 1.5 × the actual gap)`. Lines run exactly between their given end points [R-6], and the vertex tolerance absorbs any gap of up to tol.
3. **Orientation.**
   - Outer loops are wired counter-clockwise, holes clockwise.
   - Every face's OCCT area is checked against the closed-form region area (`OCCT_INTERNAL` otherwise).
   - Negative-volume solids would be re-oriented. This never occurred in 1200 generated programs.
4. **Sweep directions.**
   - Extrude `reverse`: prism along −n. `symmetric`: translate by −d/2·n, then prism by d·n.
   - Revolve `reverse`: revolve about the reversed axis. `symmetric`: pre-rotate by −angle/2.
   - The right-hand rule is tested.
5. **Profile points within tol of the revolve axis are snapped onto it** before OCCT sees them ([R-3] with §4.4):
   - such a vertex is *on* the axis, so it sweeps to a singular point, never to a ring edge of radius ≤ tol;
   - a profile reaching ≤ tol past the axis does not cross it [R-7];
   - without snapping, OCCT's `BRepPrimAPI_MakeRevol` fails outright on a profile only 5e-7 mm past the axis.
6. **Seams and degenerated edges are never counted** (§4.4, §5).
   - A seam is an edge with `BRep_Tool::IsClosed(edge, face)` on any adjacent face: cylinder seams, the profile curve of a 360° revolve, both torus seams, and the vertex arc of a partial torus.
   - A degenerated edge is one with `BRep_Tool::Degenerated`: cone apexes, sphere poles, and vertices on the axis.
7. **Canonical types, with the §4.4 tolerances [R-8]:**
   - `GetType` first;
   - a cone with |semi-angle| ≤ 1e-9 rad is a `cylinder`, and one within 1e-9 of π/2 is a `plane`;
   - a torus with major radius ≤ tol is a `sphere`; horn and spindle tori stay `torus`;
   - surfaces of revolution and extrusion are classified from the basis curve and the axis;
   - free-form faces go through `ShapeAnalysis_CanonicalRecognition`.
8. **The bounding box is tight, and computed without `AddOptimal` on faces.**
   - `BRepBndLib::AddOptimal` enlarges analytic tori by `Precision::Confusion()`.
   - Worse, OCCT represents **horn tori as `SurfaceOfRevolution`**, and on that face type `AddOptimal`'s numerical search stops short of the interior maximum. It was off by 8.7e-4 mm and 4.9e-2 mm on two generated programs; Forge's first diff flagged both, and **the oracle was the wrong side**.
   - The box is now the union of exact pieces: vertices; interior extremes of circular edges; the closed-form critical points of sphere, torus and circle-revolution faces, located on the face by projection and kept if the classifier puts them inside; and a sampled-plus-refined search for any other surface type.
   - The body gate cross-checks the result against an independent closed-form bbox of the swept profile.
9. **Mass properties use the non-adaptive `BRepGProp` integrator**, on the exact surfaces, measured against closed forms on 526 bodies:
   - **Adaptive `VolumeProperties(S, P, Eps)`:** has a false-convergence error estimator. With `Eps=1e-9` it was off by **1.2e-5 relative** while reporting an estimated error of 2e-16.
   - **`VolumePropertiesGK`:** takes 18–150 s on some bodies.
   - **Default fixed-order Gauss:** worst 3.2e-11 (volume) and 6.5e-13 (area). This is what the oracle uses.
10. **Invalid or inexact OCCT bodies are feature errors, never `ok` [R-12].**
    - A body that `BRepCheck_Analyzer` rejects is reported as `OCCT_INVALID_RESULT`.
    - A body that fails the [gate](#the-body-gate) is reported as `OCCT_SELF_CHECK_FAILED`.
    - Both codes are engine-prefixed, so a disagreement with Forge classifies as ROBUSTNESS, not as a false POTENTIAL_SILENT_WRONG.

## The body gate

Every body is gated before it is reported. `selfcheck.py` predicts each quantity from the 2D profile alone, and the body must match:

| Quantity | Prediction | Tolerance |
|---|---|---|
| Volume | extrude A·d; revolve θ·\|∬ρ dA\| (Pappus) | 1e-8 relative |
| Area | extrude 2A + P·d; revolve θ·Σ\|∫ρ ds\| + 2A for partial revolves | 1e-8 relative |
| Centroid | extrudes only | 1e-8·s |
| `faces`, `edges`, `face_types`, `edge_types` | the §4.4 rules | exact |
| bbox | closed-form extremes of the swept profile boundary | 1e-8·s per component |

The 1e-8 tolerance is 100× inside the §6 tolerance and about 300× above OCCT's measured integration noise.

The gate catches real OCCT defects that would otherwise be silently wrong:
- **Cone snapped to a cylinder.** `BRepSweep_Rotation` builds a cylinder for a profile line up to ~3e-4 rad off parallel, when §4.4 says it is a cone. The geometry is then off by up to 1e-4 mm and the face types are wrong.
- **Partial horn torus returned as a full turn.** OCCT returns a **full 360° torus** for a 311.5° reverse revolve of a circle tangent to the axis. The volume is 15% too high.
- Both are pinned as tests in `tests/test_eval.py`.

## Generator

**Valid programs.** `oracle gen` writes:
- `gen_s<seed>_<index>.json`;
- `gen_s<seed>.stats.json`, which counts oracle failures by kind and code;
- `failed/`, with every program the oracle could not evaluate, for triage. The generator then retries that index.

Every program uses its own RNG, seeded `aicad-gen/<seed>/<index>/<attempt>`, so output is byte-identical across `--jobs` values. Each program is validated (schema + `validate.rs`) and evaluated through the gate. Feature ids and names are unique document-wide and never reserved.

Content:
- **Extrude profiles:** rectangles, convex and star polygons, slots, circles, rounded rectangles, arc+chord "D" shapes, lenses, and circles cut by chords or same-circle arcs.
- **Extrude layout:** 1–3 regions, holes, and islands inside holes. Planes are XY, XZ, YZ or random frames, with every sweep direction.
- **Revolve profiles**, built in (ρ, z) and mapped rigidly onto a random axis:
  - rings and rectangles on the axis, cones and apex touches;
  - tori and horn tori;
  - balls and hemispheres, shell sectors and D-shaped torus patches;
  - off-axis extrude shapes, holes, and stacked regions.
- **Revolve angles:** 360°, classic values, random, tiny (0.01°–1°) and almost-closed.
- **Stress cases:** shuffled curve order, directions and ids; suppressed features; second parts; scale ×0.01…×100; far origins; thin walls.

**Error corpus.** Written to `<out>/invalid/`. `invalidgen.py` produces `inv_s<seed>_<kind>_<k>.json`, 82 per seed at the default `--invalid-per-kind 4` (near_touch, crosses_axis, degenerate_loop and rejected always cover every variant). Every case has an expected per-feature outcome under the SPEC, and `gen` checks the oracle against it.

| Kind | Construction | Expected outcome |
|---|---|---|
| `open_loop` | a curve removed, or a line end moved 1.5·tol … 1e-3 | `SKETCH_OPEN_LOOP` |
| `branching` | a duplicated line, or a fin at a vertex | `SKETCH_BRANCHING` |
| `crossing` | a circle dropped on a line | `SKETCH_CURVES_CROSS` |
| `near_touch` | line/circle, internal and external circle/circle, vertex/line and parallel line/line, at gaps {0.3, 0.6, 0.95}·tol | `SKETCH_CURVES_CROSS` |
| | the same pairs at {1.5, 3, 50}·tol (controls) | `ok` |
| `crosses_axis` | δ ∈ {2·tol, 10·tol, 1e-3, 0.5} past the axis, with and without an extra valid region | `REVOLVE_CROSSES_AXIS` |
| | δ = 0.5·tol, or regions on opposite sides (controls) | `ok` |
| `degenerate_loop` | triangle (0,0), (2·tol,0), (tol,tol) of area exactly tol² [R-5]: alone, next to a valid region, or as a hole in one; under the 8 symmetries of the square, either direction | `SKETCH_DEGENERATE_LOOP`; the extrude `DEPENDENCY_FAILED` |
| | the same with apex (tol, (1+1e-9)·tol), area 1.000000001·tol² (control) | `ok` |
| `dependency` | a broken sketch with two consumers, followed by independent features | `DEPENDENCY_FAILED` for the consumers; the rest `ok` |
| `suppressed` | the consumed sketch is suppressed | `SKETCH_SUPPRESSED` |
| `rejected` | `RESERVED_NAME`, cross-part `DUPLICATE_NAME`, an unknown curve field, `INCONSISTENT_ARC`, a line of length exactly tol, `INVALID_ANGLE`, `INVALID_PLANE`, `UNRESOLVED_SKETCH` | rejected, exit 2 |

Every consumer of a broken sketch expects `DEPENDENCY_FAILED`.

**Runs with the current code:**

| Seed | Programs | Oracle failures | Error-corpus mismatches |
|---|---|---|---|
| 5 | 2000 | 1 | 0 |
| 11 | 2000 | 0 | 0 |
| 23 | 2000 | 1 | 0 |
| 3 | 3000 | 2 | 0 |

All oracle failures are OCCT defects, caught and reported as engine-internal errors:

| Seed / program | Code | What OCCT did |
|---|---|---|
| 5 / 724 | `OCCT_SELF_CHECK_FAILED` | Snapped a line 1.0e-4 rad off parallel to a cylinder; volume off by 2.9e-7 |
| 3 / 2600 | `OCCT_SELF_CHECK_FAILED` | Returned a full turn for a 311.5° horn torus |
| 3 / 763 | `OCCT_INVALID_RESULT` | Built an invalid solid for a 120° revolve of a small horn torus |
| 23 / 1562 | `OCCT_INVALID_RESULT` | Built an invalid solid of volume −6.7e-14 for a 21.4° symmetric revolve of a horn torus |

In all of these, Forge's body matches the closed-form volume, area and bbox to about 1e-15, with the §4.4 topology.

## Forge vs oracle

Diff of Forge (`forge/target/debug/aicad`) against the oracle, after the horn-torus bbox fix:

| Set | Programs | MATCH | ROBUSTNESS | CODE_MISMATCH | POTENTIAL_SILENT_WRONG |
|---|---|---|---|---|---|
| `corpus/programs` | 8 | 8 | 0 | 0 | 0 |
| generated seed 5 | 2000 | 2000 | 0 | 0 | 0 |
| generated seed 11 | 2000 | 2000 | 0 | 0 | 0 |
| generated seed 23 | 2000 | 2000 | 0 | 0 | 0 |
| error corpus, seeds 5, 11, 23 | 3 × 70 | 210 | 0 | 0 | 0 |
| OCCT-failed programs (`failed/`, seeds 5 and 23) | 2 | 0 | 2 (OCCT side) | 0 | 0 |

The error corpus includes 24 rejected documents, where both engines exit 2.

The `degenerate_loop` kind came after these runs. With the current tree (debug `aicad`, 2026-09-23), its 120 cases of seeds 0–9 give 112 MATCH and 8 ROBUSTNESS: every failure is the 1.000000001·tol² control, which Forge's sketch accepts and its body validation (`forge-core/src/topo/validate.rs`) then rejects as `LOOP_DEGENERATE`. That is an open Forge regression ([spike 01](../docs/spikes/01-forge-f0-oracle.md)); until it is fixed, CI's error-corpus diff fails on `inv_s1_degenerate_loop_001`.

Regression tests for the diff findings are in `tests/test_forge_diff_regressions.py`.

## Known limitations

- **Validity is BRepCheck, not a self-intersection check.** It is not compared between the engines [R-13]; each report is only held to `valid: true` on its own `ok` bodies [R-12].
- **Small float budget.** Exact-geometry numbers still carry one: volume ≤ 3e-11, area ≤ 1e-12, centroid ~1e-13·s relative. Golden files are not bit-reproducible across platforms or OCCT versions, so diff with tolerances.
- **Gate false alarms.** The 2D predicates are plain doubles. The gate can fire on legal edge cases: a line within 1e-9 rad of parallel with length/radius > ~10, where §4.4 says "cylinder" but no cylinder radius is specified. Such a case shows up as ROBUSTNESS, never as a silent pass.
- **Reachability of `SKETCH_DEGENERATE_LOOP`.** A thin loop whose apex lies within tol of another curve fails earlier, with `SKETCH_CURVES_CROSS`. A loop whose sides are all ~tol long reaches [R-5]: the error corpus's `degenerate_loop` kind uses the triangle (0,0), (2·tol,0), (tol,tol), whose area is exactly tol² in floating point, and a control just above it. `SKETCH_NO_REGIONS` is defensive only.

## Open spec points

Revision 2026-09-23b resolved the 15 points the oracle raised. These remain or are new:

1. **[R-4]'s wording, read literally, rejects legal sketches.** "Come within tol of each other at a location more than 2·tol from every shared endpoint" fails every tangent join and every small-angle corner, because such curves stay within tol along a stretch far longer than 2·tol. At a slot's tangent join that stretch is ≈ √(2·r·tol) ≈ 3.5e-3 mm. The oracle evaluates the rule on **contact points** (proper intersections, tangency points with gap ≤ tol, and end points within tol of the other curve), which is what was intended. The spec should say so.
2. **Non-empty part names are not enforced.** §0 says "a part name is any non-empty string", but neither the schema nor `validate.rs` rejects `""`. The oracle mirrors `validate.rs` and accepts it.
3. **The exact geometry of an in-tolerance classification is not stated.** A line within 1e-9 rad of parallel is a cylinder, but of which radius? The same question applies to a perpendicular line (plane) and to an arc whose centre is within tol of the axis (sphere radius). The effect is ≤ 1e-9·length, harmless for §6. The oracle builds OCCT's surface and gates at 1e-8.
4. **"Within tol of the axis ⇒ on the axis" is implied, not stated.** §4.4 speaks of profile vertices and edges "on the axis" without tying that to tol. The oracle snaps points within tol. State this explicitly.
5. **Class precedence within one program is unspecified.** The oracle uses POTENTIAL_SILENT_WRONG > CODE_MISMATCH > ROBUSTNESS > MATCH.
6. **Feature-list mismatches are unclassified.** A missing, extra or reordered feature entry in one report falls under no §6 class. The oracle calls it POTENTIAL_SILENT_WRONG.

## STEP export check (`step-check`)

`oracle step-check` reads Forge's **own** STEP files (forge-io's writer, `aicad export --format step`)
with OCCT's `STEPControl_Reader` and compares each body with Forge's exact metrics from the export
summary: `BRepCheck_Analyzer` validity and closed shells; volume, area and tight box within 1e-6
relative (fixed-order integrators first, the adaptive ones when those disagree); the face count; and
the edge count after seam normalization, which must account exactly for the seams and split pieces
the writer reports. Code: `src/aicad_oracle/step_check.py`; tests: `tests/test_step_check.py`.

```bash
uv run oracle step-check --programs ../corpus/programs ../corpus/v1/programs   # exports with forge/target/debug/aicad
(cd ../forge && cargo run --release -p forge-io --example step_corpus -- /tmp/step 200 1 7)
uv run oracle step-check --dir /tmp/step --json /tmp/step-check.json          # the boolean corpus + samples
```

Match rate on 2026-09-25: corpus programs 11/11 bodies; boolean corpus (seeds 1 and 7, 200 cases each,
every operand and result) plus the hand-built samples 1600/1605 bodies at 1e-6. The five others: four
revolve-family bodies whose B-spline section curves lie on spheres or tori differ by 1.3e-6 to 9e-6
relative (OCCT derives their pcurves by projection; writing PCURVEs is the follow-up), and one join whose
face boundary touches itself at two vertices (valid in Forge, rejected by `BRepCheck`).
