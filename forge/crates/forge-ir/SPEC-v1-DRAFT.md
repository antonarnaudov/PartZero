# IR v1: normative semantics (`aicad.ir/1`) — DRAFT

> **Status: DRAFT (2026-09-23), with interfaces I1, I5 and I9 FROZEN on 2026-09-23 (W0).**
> - **FROZEN — I1** (the contract types): the Rust types in `forge_ir::v1`,
>   [`schema/ir-v1.schema.json`](schema/ir-v1.schema.json),
>   [`schema/ir-v1.constants.json`](schema/ir-v1.constants.json) (tolerances, `RESERVED_NAMES`,
>   `ID_PATTERN`, `ERROR_CODES`, `HOLE_SIZES` with sources) and the structural validation
>   (`forge_ir::v1::validate`, every **R** code of §7.5 except the W1 expression codes).
> - **FROZEN — I5** (`aicad.metrics/1`): [`schema/metrics-v1.schema.json`](schema/metrics-v1.schema.json)
>   (`forge_ir::v1::metrics`).
> - **FROZEN — I9** (conformance fixtures): [`corpus/v1/conformance/`](../../../corpus/v1/conformance),
>   append-only from now on (§9.4).
>
> A change to a frozen interface is a SPEC PR plus a fixture update, reviewed by its consumers
> (IR-V1 plan §3). The rest of the text stays a draft until W1–W11 have implemented it. When
> accepted, this file replaces [SPEC.md](SPEC.md) as the normative spec, and SPEC.md is kept as the
> v0 reference. Decisions and rejected alternatives: [ADR 0013](../../../docs/adr/0013-ir-v1-references-and-parameters.md)
> (its "Decisions on the open questions" are folded in below). Work split:
> [IR-V1-IMPLEMENTATION-PLAN.md](../../../docs/IR-V1-IMPLEMENTATION-PLAN.md).
>
> **Revision log.** 2026-09-23 W0 freeze: ADR 0013 decisions 1–7 applied (§6.5 table verified,
> §0.6 capture refresh, measured parameters deferred to v1.1, §10 closed); ambiguities resolved
> while encoding the types are tagged **[W0-n]** and listed in §11.

IR v1 keeps every rule of IR v0 ([SPEC.md](SPEC.md)) unless a rule below overrides it. Rules new in
this draft carry a **[D-n]** tag so reviewers and implementers can cite them. The words MUST, MUST
NOT, SHOULD and MAY are used as in RFC 2119.

Two engines still implement this spec independently: **Forge** and the **oracle** (OCCT). Where
the oracle cannot reasonably compute something itself (a constraint solve, a provenance-based
query), §8 defines a **replay** protocol in which the oracle consumes Forge's trace and verifies it
instead of recomputing it. Nothing in the trace is trusted without an independent check.

**Contents**
- [0. Scope, versioning, identity and canonical form](#0-scope-versioning-identity-and-canonical-form)
- [1. Units and tolerances](#1-units-and-tolerances)
- [2. Parameters and expressions](#2-parameters-and-expressions)
- [3. Planes, axes and datums](#3-planes-axes-and-datums)
- [4. Sketches](#4-sketches)
- [5. References and queries](#5-references-and-queries)
- [6. Features](#6-features)
- [7. Evaluation and report (`aicad.metrics/1`)](#7-evaluation-and-report-aicadmetrics1)
- [8. Diff rules (`kernel-diff` v1)](#8-diff-rules-kernel-diff-v1)
- [9. Versioning and migration](#9-versioning-and-migration)
- [10. Open points (resolved)](#10-open-points-resolved-2026-09-23)
- [11. W0 resolutions and notes for W1–W11](#11-w0-resolutions-and-notes-for-w1w11)

---

## 0. Scope, versioning, identity and canonical form

### 0.1 What v1 adds

| Area | v0 | v1 |
|---|---|---|
| Values | literal numbers | named **parameters** and unit-checked **expressions** (§2) |
| Sketches | lines, arcs, circles; literal coordinates | + points, construction curves, `rect`/`slot`/`polygon` compound curves, **constraints and dimensions** solved by forge-solve (§4) |
| Planes | `XY`/`XZ`/`YZ`, explicit frame | + planar faces, datum planes; datum axes (§3) |
| Body ops | new bodies only | `join`/`cut`/`intersect` with explicit targets, standalone `boolean` (§6.2–6.4) |
| Features | sketch, extrude, revolve | + hole, fillet, chamfer, shell, draft (optional), pattern (linear, circular, mirror), datum_plane, datum_axis, tag (§6) |
| References | sketch by name | features by **id**; faces/edges/vertices/bodies by typed **query** with declared **cardinality** and an optional **capture** (§5) |
| Report | metrics | + parameter values, warnings, structured error details, reference resolutions, per-part final bodies (§7) |

**Out of scope for v1** (additive later revisions, each with its own feature `v`): splines, text
emboss, import, mate connectors, sweep/loft, variable fillets, modelled threads, measured
expressions over bodies (e.g. `plate.volume`), `expect` clauses.

### 0.2 Schema identifiers and behavior versions [D-1]

1. A v1 document has `"schema": "aicad.ir/1"`. A v1 report has `"schema": "aicad.metrics/1"`.
2. Every feature has a behavior version `v`, a positive integer. **Omitted means 1.** A feature
   type's semantics MUST NOT change for a given `v`. A change that can alter any report field
   (geometry, topology, naming, error codes, solver result) needs a new `v`, and engines MUST keep
   evaluating every older `v` they have ever accepted.
3. An engine that does not implement a feature's `v` rejects the document with
   `UNSUPPORTED_FEATURE_VERSION` (path of the `v` field). An unknown `type` is rejected with
   `UNSUPPORTED_FEATURE`. [W0-1] A `v` that is not a positive integer (`0`, `1.5`, `"1"`) is also
   `UNSUPPORTED_FEATURE_VERSION`. This revision defines `v: 1` for every feature type
   (`FEATURE_VERSIONS` in the constants file).
4. v1 engines MUST also accept `aicad.ir/0` documents. They migrate them with §9.1 before
   evaluating; the report is then a v1 report. Engines never write `aicad.ir/0`.
5. Additive revisions of v1 (a new feature type, a new optional field whose default preserves
   meaning) keep `aicad.ir/1`; they are listed in the revision log at the top of this file.

### 0.3 Identity [D-2]

1. **Ids.** [W0-12] Part ids, feature ids, and the ids of curves, points, constraints and hole
   positions match the **id grammar** `ID_PATTERN` = `[A-Za-z_][A-Za-z0-9_]*`, 1 to `MAX_ID_LEN` =
   64 bytes (`INVALID_ID`, details `{ "path", "reason": "empty" | "charset" | "too-long", "length" }`).
   This **replaces** the earlier "ids stay free and are escaped" rule (BACKLOG): ids flow into
   provenance keys and, through reports and messages, into LLM prompts, where unrestricted ids were
   shown to inject orchestrator control lines (security audit, 2026-09-23). The escaping of §5.2
   rule 5 remains as defence in depth. Feature ids are unique across the document; curve, point
   and constraint ids are unique within their sketch, where they share one namespace together with
   the derived ids of §4.3 (`DUPLICATE_ID`; a declared id cannot contain `.`, so it never clashes
   with a derived or member id).
   - **References** to ids (a sketch or datum id, a query's `feature`, `curve`, `member`, `at` and
     `role`, a region curve id, a pattern seed, a hole's point ids, a constraint argument) are 1 to
     `MAX_REF_SEGMENTS` = 3 ids joined by `.` (`l.start`, `outline.bottom`, `outline.c_br.start`);
     anything else is `INVALID_ID` at the reference's path, and the reference is not resolved
     further.
   - **No echo.** A string that fails the id grammar, the name grammar or an expression grammar is
     never copied into a `message` or `details` (they give its path, reason and length). Free-text
     fields (`meta`, `note`, `intent`, `author`, `assumptions`) are not restricted; tools that show
     them to a model MUST mark them as untrusted data (W10).
2. **Features are referenced by id, never by name.** Every cross-feature reference in v1 (a sketch
   consumed by an extrude, a datum used as a plane, a feature named by a query, a pattern seed)
   stores the target's **feature id**. Renaming a feature changes its `name` only and never breaks a
   reference. (v0 stored the sketch *name*; §9.1 rewrites it.)
3. **Names.** Feature names and parameter names share **one namespace** (they are all CadScript
   `const`s in one file): they are unique across the document (`DUPLICATE_NAME`) and match the id
   grammar of rule 1, at most 64 bytes (`INVALID_NAME`). Part names follow the same grammar
   ([W0-12]; unique among parts). [W0-2] v1 adds its builtins to `RESERVED_NAMES`
   (`schema/ir-v1.constants.json`, list in §9.3). IR validation rejects (`RESERVED_NAME`) a
   **parameter** name in the full v1 list, and a **feature** name in the v0 list
   (`RESERVED_NAMES_V0`) only: §9.3 keeps migrated v0 documents that name a feature `hole` or
   `fillet` valid, and CadScript reports those with `CS_RESERVED_NAME`.
4. **References to a feature must point backwards** in the same part's timeline
   (`UNRESOLVED_FEATURE`). A reference to a feature of another part is `UNRESOLVED_FEATURE`.
   (Parameters are referenced by name, not id, and follow the scope rules of §2.8.)
5. Engine arena ids never appear in the IR or in reports. Entities are named by provenance keys
   (§5.2) and located by probes (§7.6).

### 0.4 Canonical JSON [D-3]

- Canonical JSON (`forge_ir::to_json`) omits every field that holds a default stated in this spec
  (the "Default" columns of §2–§6). In addition to the v0 list this includes `v: 1`, `params: []`,
  `constraints: []`, `construction: false`, `card` equal to the field's default cardinality (§5.5),
  an absent `capture`, `tangent_chain: true`, shell `direction: "inward"`, hole `fit: "normal"`,
  `flip: false`, `tip: 118`, `keep_tools: false`, `skip: []`, `r: 0` (rect) and empty
  `note`/`intent`/`author`/`assumptions`/`decision_ids`.
- A value that is a plain literal number is written as a JSON **number**; an expression is written as
  a JSON **string** in the canonical expression form (§2.4). `"8"` is not canonical; `8` is.
- JSON numbers MUST be parsed correctly rounded and printed in shortest round-trip form, so that
  print → parse is bit-exact. [W0-11] serde_json's default parser is off by one ulp for about one
  in eight 17-digit decimals, and enabling its `float_roundtrip` feature would change how every
  crate in a build parses v0 documents; so the v1 loader reads JSON text with its own strict
  RFC 8259 reader (`forge_ir::v1::json`, correctly rounded, duplicate keys rejected). v0 documents
  keep serde_json's parser (bit-for-bit v0 behavior).
- [W0-11] **Canonical text** is exactly `forge_ir::v1::to_json`: serde_json's pretty printer
  (2-space indent, `": "` separators), object keys in schema declaration order (the order of the
  JSON Schema's `properties`, required ones first as declared), JSON numbers printed by Ryū:
  decimal notation for `1e-5 ≤ |x| < 1e16` with integral values ending in `.0` (`8.0`, `0.00001`),
  otherwise `<digits>e<sign><exp>` with an explicit `+` (`1e-7`, `1.5e+16`). Numbers **inside
  expression strings** use the ECMAScript `Number::toString` form instead (§2.4). The TypeScript
  and Python ports reproduce this byte for byte.
- Readers accept both the explicit and the omitted form of every default. [W0-11] Context-dependent
  defaults are omitted too: a Ref's `card` equal to its field's default, `thread: false`, a linear
  pattern's `count2: 1`, `rotation: 0`, grid and bolt-circle `center: [0, 0]`, bolt-circle
  `start: 0`, custom countersink `angle: 90`, circular pattern `angle: 360`.
- [W0-1] IR v1 has **no nullable field**: an optional field is omitted, never `null` (a `null`
  anywhere is a parse error).

### 0.5 Rejection versus evaluation errors [D-4]

1. **Rejection** (the document is never evaluated; CLI exit code 2): parse errors, unknown fields,
   schema/version errors, identity errors, expression **syntax, name, arity and unit** errors,
   parameter cycles, malformed queries, query/field kind mismatches, and every range check on a
   **literal** value (v0's `INVALID_DISTANCE`, `INVALID_ANGLE`, … keep their codes and paths).
2. **Evaluation errors** (the feature fails, evaluation continues, §7.1): everything that depends on
   a computed value or on geometry. **Range checks on expression-valued fields** use the **same code
   and path** as the literal check would, but are raised at evaluation time, as a feature error.
   Example: `"distance": "t - 10"` with `t = 8` fails the extrude with `INVALID_DISTANCE`, detail
   `{"value": -2, "expected": "> 1e-6"}`.
3. Validation returns every problem, not just the first (as in v0). [W0-1] The set of
   `{ code, path }` is normative; its order is not (fixtures compare multisets).
4. [W0-1] **Rejection pipeline** (every implementation runs the same steps, so the same document
   gets the same codes):
   1. JSON text → value (correctly rounded numbers, duplicate keys rejected);
   2. dispatch on `schema`: `aicad.ir/0` → v0 parse and v0 validation (same codes and paths as v0),
      then §9.1; `aicad.ir/1` → the steps below; anything else → `UNSUPPORTED_SCHEMA` at `/schema`;
   3. **raw pre-checks** on the value, for rejections that a typed parse could not code: any `null`
      (parse error); unknown feature `type` (`UNSUPPORTED_FEATURE`); a `v` that is not a defined
      version (`UNSUPPORTED_FEATURE_VERSION`); a parameter's unknown `unit`, missing `value` or
      present `measure` (`PARAM_INVALID`); a Ref's (`{ "kind", "q", … }`) `card` outside
      `one`/`some`/`any`/integer ≥ 1 (`INVALID_CARDINALITY`); a hole `size` not in `HOLE_SIZES`
      (`HOLE_SIZE_UNKNOWN`); `driving` or `value` on a constraint that is not a dimension
      (`SKETCH_NOT_A_DIMENSION`). If any fails, the document is rejected with those problems;
   4. typed parse against `schema/ir-v1.schema.json` (unknown fields, wrong JSON types: parse
      error without a code);
   5. structural validation (`forge_ir::v1::validate`), then the expression checks of W1 through
      the hook `forge_ir::v1::expr::ExprValidator`, which receives every expression site with its
      JSON pointer, field type (§2.2) and scope (§2.8).

### 0.6 Evaluation is a pure function; the command layer writes back [D-5]

Evaluation reads the document and writes nothing into it. Three pieces of stored state track the
evaluated state, and only the **command layer** (DocStore ops: UI, agent, CLI, MCP) writes them, as
ordinary undoable ops inside the user's transaction:

| Stored state | Written by the op | When |
|---|---|---|
| Solved sketch geometry (§4.5) | `writeBackSolution(sketchId)` | after any committed edit whose evaluation re-solved a constrained sketch successfully |
| Reference captures (§5.6) | `captureRef(featureId, fieldPath)` | **only** when a reference is created or edited, or a repair is accepted (ADR 0013 decision 4: captures are not refreshed on every commit, so `document.json` diffs stay readable) |
| Rename maps (§5.9) | `renameCurve`, `renameFeature` | explicit renames; they rewrite every query that names the old id in the same op |

A document that nobody has written back is still valid and evaluates deterministically; it just
starts solves from older guesses and validates references against older captures.

## 1. Units and tolerances

- Stored lengths are millimetres and stored angles are degrees, as in v0. Expressions may use other
  length literals (§2.3) but always evaluate to mm and degrees.
- Every tolerance is a named constant in `schema/ir-v1.constants.json`. Comparisons are inclusive
  (`≤`), as in v0 [R-3].

| Constant | Value | Used for |
|---|---|---|
| `LINEAR_TOLERANCE` (*tol*) | `1e-6` mm | coincidence, degeneracy, point-on-entity (v0) |
| `ANGULAR_TOLERANCE` | `1e-9` rad | surface/curve classification, frame perpendicularity (v0) |
| `QUERY_ANGLE_TOLERANCE` | `1e-6` rad | query predicates `normal`, `parallel`, `perpendicular`, `convex`/`concave` (§5.3) |
| `TANGENT_CHAIN_TOLERANCE` | `1e-6` rad | tangent-chain propagation of fillets and chamfers (§6.6) |
| `QUERY_SIZE_TIE_REL` | `1e-9` | ties in `largest`/`smallest` (relative) |
| `SOLVE_TOLERANCE` | `1e-10` mm | a driving constraint holds (forge-solve `SolveOptions::tolerance`) |
| `SOLVE_CHECK_TOLERANCE` | `1e-9` mm | the oracle's independent constraint check of a replayed solution (§8.2) |
| `AUTO_ACCEPT_CONFIDENCE` | `0.95` | a non-exact reference resolution may be used without confirmation (§5.7) |
| `IDENTICAL_MATCH_CONFIDENCE` | `0.99` | confidence of a geometry-identical match |
| `MAX_DISAMBIGUATION_CONFIDENCE` | `0.9` | cap for every other non-exact match |
| `MIN_PLAUSIBLE` | `0.35` | candidates below this are not offered |
| `TIE_MARGIN` | `0.1` | candidates within this fraction of the best are a tie |
| `MAX_CANDIDATES` | `6` | candidates listed per unresolved member |
| `PARAM_VALUE_REL` | `1e-12` | diff tolerance for real-valued parameters (§8.2) |
| `MAX_EXPR_BYTES`, `MAX_EXPR_DEPTH` | `4096`, `64` | expression size limits (§2.3) |
| `MAX_COUNT_MAGNITUDE` | `2^31` | `count` values (§2.7 rule 9) |
| `ID_PATTERN`, `MAX_ID_LEN`, `MAX_REF_SEGMENTS` | `^[A-Za-z_][A-Za-z0-9_]*$`, `64`, `3` | ids, names and references (§0.3, [W0-12]) |

The last six constants are the values the spike 02 harness validated
([02-naming.md](../../../docs/spikes/02-naming.md)); changing them requires re-running that harness.

## 2. Parameters and expressions

### 2.1 Parameters [D-6]

A parameter is a named, typed value. `Document.params` holds **document-level** parameters,
`PartStudio.params` holds **part-level** parameters. Both are ordered lists; the order is the
declaration order and matters only for printing and tie-breaking (§2.8).

```json
{ "name": "width",    "unit": "mm",    "value": 80, "min": 20, "max": 300, "note": "outer width" }
{ "name": "inner",    "unit": "mm",    "value": "width - 2 * wall" }
{ "name": "holes",    "unit": "count", "value": 4, "min": 1 }
{ "name": "tilt",     "unit": "deg",   "value": 15 }
{ "name": "with_lid", "unit": "bool",  "value": true }
{ "name": "slot_len", "unit": "mm",    "measure": { "sketch": "s_slot", "constraint": "d_len" } }   // DEFERRED to v1.1
```

> **Measured parameters are deferred to IR v1.1** (ADR 0013 decision 5). The `measure` rows below
> and the `MEASURE_*` codes stay as the v1.1 design; an `aicad.ir/1` document with a `measure`
> field is rejected with `PARAM_INVALID` (reason `measure-deferred`). v1.1 adds `measure` as an
> additive optional field (§0.2 rule 5). [W0] `unit` and `value` are therefore both required in v1.

| Field | Meaning |
|---|---|
| `name` | Shares the feature-name namespace (§0.3). |
| `unit` | `mm` (length), `deg` (angle), `ratio` (dimensionless real), `count` (dimensionless integer), `bool`. |
| `value` | A literal (number or boolean) or an expression string (§2.3). Exactly one of `value` and `measure`. |
| `measure` | A **measured parameter**: the value of a reference dimension (§4.3, `driving: false`) of an earlier sketch of the same part. Part-level only. `unit` must be `mm` for `distance`/`radius`/`diameter` and `deg` for `angle` (`MEASURE_UNIT_MISMATCH`); the constraint must be a reference dimension (`MEASURE_NOT_REFERENCE`). |
| `min`, `max` | Optional bounds (literal or expression of the same type), checked after evaluation (`PARAM_OUT_OF_RANGE`). Not allowed for `bool` (`PARAM_INVALID`). [W0-13] With a literal value and literal bounds the check is a rejection (§0.5 rule 1), as is literal `min > max` (`PARAM_INVALID`); a literal of the wrong kind (`true` for `mm`, `3` for `bool`) is `EXPR_TYPE_MISMATCH`; a non-integer literal `count` is `EXPR_NOT_INTEGER`. |
| `note` | Free text, not semantic. |

A parameter whose `value` is an expression is **derived**; UIs show it read-only unless the user
replaces the expression. Driving parameters are the literal ones.

### 2.2 Scalar fields [D-7]

Every numeric field of the IR (distances, angles, coordinates, radii, counts, pattern spacings,
hole sizes, dimension values, query radii, …) has the JSON type **Scalar** = `number | string`. A
number is a literal in the field's unit; a string is an expression. Boolean fields that accept
expressions have the type `boolean | string`. Each field declares its **field type**: `length`
(mm), `angle` (deg), `ratio`, `count` or `bool`. A `P2`/`P3` vector is an array of Scalars.

[W0-3] The boolean fields that accept expressions are exactly: `suppressed` (every feature), hole
`flip`, AxisRef and `datum_axis` `flip`, `tangent_chain` and `keep_tools`. `construction`, `ccw`,
`driving`, tangent `internal` and hole `thread: true` are literal booleans. [W0-4] The components
of **direction vectors** (frame `normal` and `x_dir`, face-plane `x_dir`, `line.direction`,
revolve `axis.direction`, `Dir` vectors) have field type `ratio`; positions are `length`. The full
field-type table is the site walker `forge_ir::v1::expr::expr_sites`; the fixtures of
`queries/` and `programs/` exercise it.

### 2.3 Expression grammar [D-8]

```ebnf
expr      = cond ;
cond      = or_expr , [ "?" , expr , ":" , expr ] ;
or_expr   = and_expr , { "||" , and_expr } ;
and_expr  = cmp_expr , { "&&" , cmp_expr } ;
cmp_expr  = add_expr , [ cmp_op , add_expr ] ;          (* not associative: a < b < c is a syntax error *)
cmp_op    = "<" | "<=" | ">" | ">=" | "==" | "!=" ;
add_expr  = mul_expr , { ( "+" | "-" ) , mul_expr } ;    (* left-associative *)
mul_expr  = unary , { ( "*" | "/" | "%" ) , unary } ;    (* left-associative *)
unary     = ( "-" | "!" ) , unary | power ;
power     = atom , [ "^" , unary ] ;                     (* right-associative; -a^2 = -(a^2); a^-1 is allowed *)
atom      = number , [ unit ] | "true" | "false" | call | ident | "(" , expr , ")" ;
call      = ident , "(" , [ expr , { "," , expr } ] , ")" ;
number    = digits , [ "." , digits ] , [ ( "e" | "E" ) , [ "+" | "-" ] , digits ] ;
digits    = digit , { digit } ;
unit      = "mm" | "cm" | "in" | "deg" ;                 (* only directly after a number *)
ident     = ( letter | "_" ) , { letter | digit | "_" } ;
```

- Whitespace (space, tab) may separate any two tokens and is otherwise insignificant; `12mm` and
  `12 mm` are the same token pair. A unit is recognised only immediately after a number, so an
  identifier named `mm` or `in` elsewhere is an identifier.
- Identifiers are parameter names, the constant `PI`, or function names followed by `(`.
- Maximum nesting depth 64 and maximum length 4096 bytes (`EXPR_SYNTAX` beyond).
- [W0-15] Whitespace is exactly space and tab: a newline is `EXPR_SYNTAX`. A call is an identifier
  followed by `(` after optional whitespace (`sin (30)` is a call). A number literal that rounds
  to ±∞ (`1e400`) is `EXPR_SYNTAX`; one that underflows is its rounded value. An empty or
  blank expression is `EXPR_SYNTAX` (W0 checks this and the length limit without a parser).

### 2.4 Canonical form [D-9]

The canonical text of an expression is produced by printing its AST:
1. numbers in shortest round-trip form (`-0` → `0`), then a single space and the unit if present
   (`12 mm`, `0.25 in`, `30 deg`); [W0-11] the textual form is ECMAScript `Number::toString`
   (ECMA-262 §6.1.6.1.20): `1000` for `1e3`, `0.000001`, `1e-7`, `100000000000000000000`,
   `1e+21`, `1.5e+300`;
2. one space on both sides of every binary operator and of `?` and `:`; no space after a unary
   operator; `f(a, b)` with one space after each comma;
3. parentheses only where the precedence and associativity of §2.3 require them, plus around the
   operand of a unary minus when that operand is a `^` (`-(a ^ 2)` is printed as `-(a ^ 2)`, never
   `-a ^ 2`, to match CadScript, where `-a ** 2` is illegal). [W0-15] The same holds for `!`
   (TypeScript rejects any unary operator directly before `**`). Precedence levels, lowest first:
   `?:`, `||`, `&&`, comparisons (non-associative: both operands need at least `+`/`-` level),
   `+ -`, `* / %`, unary, `^` (base must be an atom; exponent at least unary), atoms.

An engine MUST accept any expression the grammar accepts; the CadScript compiler and the DocStore
MUST store the canonical form. `parse(canonical(ast)) == ast` for every AST.

### 2.5 Types and dimensional analysis [D-10]

Every expression has a static type, computed bottom-up:
- **Bool**, or
- **Real(d)** with a dimension vector `d = (L, A)` of integer exponents (L = length in mm,
  A = angle in degrees; `(0, 0)` is dimensionless), or
- **Flex**: a real whose dimension is fixed later by its context.

| Construct | Rule |
|---|---|
| bare number, `PI` | Flex |
| number with `mm`/`cm`/`in` | Real(1, 0) |
| number with `deg` | Real(0, 1) |
| parameter | its unit: `mm` → Real(1,0), `deg` → Real(0,1), `ratio`/`count` → Real(0,0), `bool` → Bool |
| `a + b`, `a - b`, `a % b`, comparisons, `min`, `max`, `clamp`, `hypot`, the two branches of `?:` | **unify** the operands: two fixed dimensions must be equal (`EXPR_UNIT_MISMATCH`); a Flex operand adopts the other operand's dimension; all-Flex gives Flex. Comparisons return Bool. |
| `a * b` | Flex·Flex = Flex; Flex·Real(d) = Real(d) if d ≠ 0, else Flex; Real(a)·Real(b) = Real(a + b) |
| `a / b` | Flex/Flex = Flex; Flex/Real(d) = Real(−d) if d ≠ 0, else Flex; Real(d)/Flex = Real(d) if d ≠ 0, else Flex; Real(a)/Real(b) = Real(a − b) |
| unary `-`, `abs`, `floor`, `ceil`, `round` | same type as the operand |
| `a ^ b` | base Flex or Real(0,0): exponent must be Flex or Real(0,0); result is the base's type. Base Real(d ≠ 0): the exponent must be an integer literal, optionally negated and parenthesised; result Real(n·d). Otherwise `EXPR_UNIT_MISMATCH`. |
| `sqrt(x)` | Flex → Flex; Real(d) with both exponents even → Real(d/2); odd → `EXPR_UNIT_MISMATCH` |
| `sin`, `cos`, `tan` | argument Real(0,1) or Flex (a Flex argument is in degrees); result Real(0,0), or Flex if the argument was Flex |
| `asin`, `acos`, `atan` | argument Real(0,0) or Flex; result Real(0,1) |
| `atan2(y, x)` | unify `y` and `x`; result Real(0,1) |
| `!`, `&&`, `\|\|`, the condition of `?:` | Bool operands (`EXPR_TYPE_MISMATCH`) |
| [W0-15] `==`, `!=` | two Bools, or two numbers unified as above; `<`, `<=`, `>`, `>=` on Bool are `EXPR_TYPE_MISMATCH` |

[W0-15] **Type notation** (fixtures, `EXPR_UNIT_MISMATCH` details): `flex`, `bool`, and for
Real(L, A) the factors `mm`/`mm^L` and `deg`/`deg^A` joined by `*` (`mm`, `mm^2`, `mm^-1`, `deg`,
`mm*deg`), or `1` when both exponents are 0. An integer exponent literal may be written with a
fractional zero (`width ^ 2.0`).

**Use site.** The field type fixes the result: a Flex result takes the field's dimension; a fixed
result must equal it (`EXPR_UNIT_MISMATCH`, with `expected` and `found` in the details); `count`
fields take Real(0,0) or Flex; `bool` fields take Bool. A parameter's `unit` is the use-site type of
its own expression.

The rule "a literal coefficient is dimensionless, a literal term adopts its neighbour's unit" makes
the everyday forms legal and still catches the classic mistakes:

| Expression | At a `length` field | Why |
|---|---|---|
| `width - 12` | ok, `12` is mm | additive: Flex adopts L |
| `(width - 12) / (holes - 1)` | ok | L / Real(0,0) = L |
| `10 * sin(30)` | ok, 5 mm | all-Flex, then the field fixes L |
| `holes * 20` | ok, `20` is mm | Real(0,0)·Flex = Flex |
| `width * sin(tilt)` | ok | L · Real(0,0) = L |
| `width + holes` | `EXPR_UNIT_MISMATCH` | L + Real(0,0) |
| `sin(tilt)` | `EXPR_UNIT_MISMATCH` | Real(0,0) at a length field |
| `width * width` | `EXPR_UNIT_MISMATCH` | Real(2,0) |
| `sqrt(area_a * area_b)` … | only if the exponents come out as (1, 0) | |
| `tilt + 5 mm` | `EXPR_UNIT_MISMATCH` | Real(0,1) + Real(1,0) |

### 2.6 Functions [D-11]

| Function | Arity | Semantics |
|---|---|---|
| `min(a, b, …)`, `max(a, b, …)` | ≥ 2 | IEEE comparison; on equality the first argument wins |
| `abs(x)` | 1 | |
| `sqrt(x)` | 1 | correctly rounded; `x < 0` → `EXPR_DOMAIN` (`-0` gives `0`) |
| `floor(x)`, `ceil(x)` | 1 | exact |
| `round(x)` | 1 | nearest integer, halves away from zero (`f64::round`) |
| `clamp(x, lo, hi)` | 3 | `min(max(x, lo), hi)`; `lo > hi` → `EXPR_DOMAIN` |
| `hypot(a, b)` | 2 | `libm::hypot` |
| `sin(x)`, `cos(x)`, `tan(x)` | 1 | degrees, §2.7 |
| `asin(x)`, `acos(x)`, `atan(x)` | 1 | result in degrees, §2.7; `\|x\| > 1` → `EXPR_DOMAIN` for asin/acos |
| `atan2(y, x)` | 2 | degrees in (−180, 180]; `atan2(0, 0)` → `EXPR_DOMAIN` |

Unknown function names are `EXPR_UNKNOWN_FUNCTION`, wrong arity `EXPR_ARITY` (both rejections).
`PI` is π rounded to the nearest f64.

### 2.7 Evaluation [D-12]

Evaluation is in IEEE-754 binary64, deterministic and bit-identical on every target. The Forge
evaluator is the evaluator of record; CadScript and the UI never evaluate for semantics (they call
Forge, natively or through WASM).

1. `+ − * /`, `sqrt`, `floor`, `ceil`, `round`, `abs`, `min`, `max` and `%` (IEEE `fmod`: the result
   has the sign of the dividend) are the exactly specified IEEE operations.
2. Unit literals convert with one multiplication: `x cm = x · 10`, `x in = x · 25.4`; `mm` and
   `deg` are the identity.
3. `a ^ b`: if `b` is an integer with `|b| ≤ 64`, compute `r = a^|b|` by binary exponentiation
   (`r = 1; p = a; n = |b|; loop { if n odd: r = r·p; n = n >> 1; if n == 0: break; p = p·p }`)
   and return `1 / r` for negative `b`. Otherwise use `forge_core::math::pow`; a negative base with
   a non-integer exponent, or `0 ^ b` with `b < 0`, is `EXPR_DOMAIN`.
4. **Degree trigonometry.** `sin`/`cos`/`tan` of `x`:
   1. `r = x rem_euclid 360` (exact); [W0-5] except that for a tiny negative `x` the addition
      inside `rem_euclid` rounds up to exactly `360`, which is replaced by `0` (the same angle).
      The function is `forge_ir::v1::degtrig::sin_cos_deg`, shared by W1, compound curves and
      hole placement;
   2. `q` = the largest integer in {0, 1, 2, 3} with `90·q ≤ r` (exact comparisons), and
      `s = r − 90·q` (exact by Sterbenz's lemma, since `r < 360`);
   3. if `s ∈ {0, 30, 45, 60}`, take `(sin s, cos s)` from the table `0 → (0, 1)`,
      `30 → (0.5, 0.8660254037844386)`, `45 → (0.7071067811865476, 0.7071067811865476)`,
      `60 → (0.8660254037844386, 0.5)` (the correctly rounded values); otherwise
      `(sin s, cos s) = forge_core::math::sin_cos(s · 0.017453292519943295)`;
   4. rotate by the quadrant exactly: `q = 0 → (sin s, cos s)`, `1 → (cos s, −sin s)`,
      `2 → (−sin s, −cos s)`, `3 → (−cos s, sin s)`; then `tan = sin / cos`, where `cos == 0` is
      `EXPR_DOMAIN`.
5. **Inverse trigonometry** returns degrees: `rad · 57.29577951308232` (the f64 nearest 180/π),
   except these exact results: `asin(0) = 0`, `asin(±0.5) = ±30`, `asin(±1) = ±90`,
   `acos(1) = 0`, `acos(0.5) = 60`, `acos(0) = 90`, `acos(-0.5) = 120`, `acos(-1) = 180`,
   `atan(0) = 0`, `atan(±1) = ±45`, and `atan2(y, x)` is exact when `y = 0`, `x = 0` or `|y| = |x|`.
6. `?:` evaluates the condition and then **only** the chosen branch; `&&` and `||` short-circuit.
   (Both branches are still type-checked.)
7. Any operation producing NaN or ±∞, a division or `%` by zero, and the domain errors above fail
   with `EXPR_DOMAIN`, details `{ "expr", "subexpr", "operands" }`.
8. Every result `−0` is replaced by `+0` before it is used or reported.
9. **Integrality.** A `count` parameter or field requires an exact integer with `|v| ≤ 2^31`
   (`EXPR_NOT_INTEGER`, details `{ "value" }`). Field-specific ranges (e.g. pattern count ≥ 1) are
   checked afterwards (§0.5 rule 2).

### 2.8 Scope and dependency order [D-13]

1. A **document** parameter's expression may reference document parameters only.
2. A **part** parameter's expression may reference document parameters and parameters of the same
   part. A feature field may reference document parameters and its own part's parameters.
   Referencing another part's parameter is `EXPR_SCOPE`; an unknown identifier (including a feature
   name used as a value) is `EXPR_UNKNOWN_NAME`.
3. The engine builds the dependency graph (parameter → the parameters it uses; measured parameter →
   its sketch feature) and orders it topologically; ties are broken by declaration order, document
   parameters first. A cycle is `PARAM_CYCLE` (rejected), details `{ "cycle": [names…] }`. A cycle
   through a measured parameter (a sketch whose driving dimension uses a parameter that measures the
   same sketch) is also `PARAM_CYCLE`.
4. Non-measured parameters are evaluated before the first feature. A measured parameter is
   evaluated right after its sketch; any feature or parameter that uses it must come later in the
   timeline (`MEASURE_FORWARD`, rejected).
5. A parameter that fails (`EXPR_DOMAIN`, `EXPR_NOT_INTEGER`, `PARAM_OUT_OF_RANGE`, or its measured
   sketch failed or is suppressed) is reported in `params` with its error; every parameter and
   feature that uses it, directly or transitively, fails with `PARAM_FAILED`, details
   `{ "param", "code" }`. `PARAM_FAILED` is decided before the feature runs.

### 2.9 CadScript v1 surface [D-14]

**Declarations.** `param(value, options?)` declares a parameter; its `const` name is the parameter
name. Statements before the first `part(…)` declare document parameters, statements inside a part
declare that part's parameters. `measure(sketchHandle, "constraintId")` declares a measured
parameter.

```ts
const width = param(80, { min: 20, max: 300, note: "outer width" }); // unit defaults to "mm"
const wall  = param(2);
const inner = param(width - 2 * wall);        // derived; unit inferred from the expression (mm)
const holes = param(4, { unit: "count", min: 1 });
const tilt  = param(15, { unit: "deg" });
const withLid = param(true);                   // bool
```

Unit inference for `param(expr)`: a fixed expression type gives the unit; a Flex expression gives
`mm` unless `unit` is given; a boolean gives `bool`.

**Expressions in arguments.** v1 reverses v0's literal-only rule. Every Scalar argument accepts:

| CadScript | IR (canonical) | Notes |
|---|---|---|
| numeric literal, `-2.5` | JSON number `-2.5` | a bare, optionally negated literal is stored as a number, never folded further |
| parameter `const` | `width` | |
| `+ - * / %`, unary `-` | same | |
| `a ** b` | `a ^ b` | `^` in CadScript is XOR and is rejected (`CS_EXPR_UNSUPPORTED`, hint "use **") |
| `=== !== < <= > >=` (and `== !=`) | `== != < <= > >=` | printed back as `===`/`!==` |
| `&& \|\| !`, `c ? a : b`, `true`, `false` | same | |
| `min max abs sqrt floor ceil round clamp hypot sin cos tan asin acos atan atan2 PI` from `@aicad/std` | same names | degrees |
| `mm(12)`, `cm(2)`, `inch(0.25)`, `deg(30)` (numeric literal argument only) | `12 mm`, `2 cm`, `0.25 in`, `30 deg` | |

Rejected with `CS_EXPR_UNSUPPORTED` and a hint: `Math.*` (radians; "use sin() from @aicad/std,
which takes degrees"), calls to anything else, template strings, member access on parameters,
`++`/`--`/assignment, bitwise operators, `??`, optional chaining, `typeof`, spreads, and `let`/`var`
bindings (derived values are `param(expr)`). Unit and type errors are reported with the IR codes
(`EXPR_UNIT_MISMATCH`, …) at the span of the offending sub-expression.

**Printing.** The printer turns the canonical IR expression back into TypeScript: `^` → `**`,
`==`/`!=` → `===`/`!==`, `12 mm` → `mm(12)`, `0.25 in` → `inch(0.25)`; it adds the parentheses
TypeScript needs (`-(a ** 2)`, `(-a) ** 2`). `compile(print(ir), { base: ir }).ir` deep-equals
`ir`. `print(compile(src))` equals `src` except inside expressions, which come back canonical; edit
splicing keeps untouched statements verbatim, as in v0.

**Typing in `tsc`.** `param()` returns `number` (or `boolean`), so ordinary TypeScript arithmetic
type-checks; dimensional analysis is the compiler's job, not `tsc`'s.

### 2.10 Example

```json
{
  "schema": "aicad.ir/1",
  "params": [
    { "name": "width", "unit": "mm", "value": 80 },
    { "name": "depth", "unit": "mm", "value": 50 },
    { "name": "thick", "unit": "mm", "value": 8, "min": 2 }
  ],
  "parts": [{ "id": "p1", "name": "plate", "features": [
    { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
      { "kind": "rect", "id": "outline", "center": [0, 0], "w": "width", "h": "depth", "r": 4 }
    ]},
    { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": "thick" }
  ]}]
}
```

```ts
import { param, part, sketch, rect, extrude, XY } from "@aicad/std";

const width = param(80);
const depth = param(50);
const thick = param(8, { min: 2 });

part("plate");
const base = sketch(XY, { outline: rect({ center: [0, 0], w: width, h: depth, r: 4 }) });
const slab = extrude(base, { distance: thick });
```

Report excerpt (§7.2): `"params": [{ "name": "width", "unit": "mm", "value": 80 }, …]`.

## 3. Planes, axes and datums

### 3.1 Plane references [D-15]

A **PlaneRef** is one of:

| Form | Frame (origin, x, y, normal) |
|---|---|
| `"XY"`, `"XZ"`, `"YZ"` | v0 §2 |
| `{ "origin", "normal", "x_dir" }` | v0 §2 explicit frame (Scalars allowed) |
| `{ "face": Ref }` with optional `"origin": P3`, `"x_dir": P3` | the **face frame** below; the Ref has kind `face`, card `one` |
| `{ "datum": "<feature id>" }` | the frame of a `datum_plane` feature (§3.3) |

**Face frame.** The face must be planar at evaluation time (`PLANE_NOT_PLANAR`, details
`{ "surface": "<type>" }`); a face whose type changed from plane is caught here (naming
recommendation 4).
1. `n` = the face's **outward** unit normal in the current body.
2. `origin` = the projection onto the face plane of the given `origin`, or of the world origin when
   none is given.
3. `x` = the projection of the given `x_dir` onto the plane, normalised; when none is given, the
   world axis among X, Y, Z with the smallest `|n · axis|` (ties: X before Y before Z), projected and
   normalised. A projection of length ≤ 1e-9 is `PLANE_DEGENERATE`.
4. `y = n × x`.

So a sketch on the top cap of an XY plate has the same (u, v) coordinates as the plate's XY sketch,
and faces facing −Y or +X get the frames of `XZ` and `YZ`:

| Outward normal | x | y | Same as |
|---|---|---|---|
| +Z | +X | +Y | `XY` |
| −Z | +X | −Y | |
| −Y | +X | +Z | `XZ` |
| +Y | +X | −Z | |
| +X | +Y | +Z | `YZ` |
| −X | +Y | −Z | |

The frame is recomputed on every evaluation from the current face, so a sketch on a face follows
the face when upstream dimensions change.

### 3.2 Axis references and directions [D-16]

An **AxisRef** (an oriented line) is one of:

| Form | Origin | Direction |
|---|---|---|
| `"X"`, `"Y"`, `"Z"` | world origin | +X, +Y, +Z |
| `{ "edge": Ref }` (card `one`) | line edge: the point of the line closest to the world origin; circular edge: the circle's centre | line: the line direction; circle: the circle's normal; both made **sign-canonical** |
| `{ "cylinder": Ref }` (card `one`) | cylindrical or conical face: the axis point closest to the world origin | the axis, sign-canonical |
| `{ "datum": "<feature id>" }` | the `datum_axis` feature (§3.4) | its direction |
| `{ "line": { "origin": P3, "direction": P3 } }` | explicit | explicit (non-zero, normalised) |

- **Sign-canonical**: the first component (x, then y, then z) with absolute value > 1e-9 is made
  positive. B-rep edge orientation is engine-specific and never used.
- Any AxisRef may carry `"flip": true`, which reverses the direction after the rules above.
- An edge that is neither a line nor a circle, or a face that is not a cylinder or cone, is
  `AXIS_REF_UNSUPPORTED`.

A **PointRef** is a `P3` (Scalars) or `{ "vertex": Ref }` (vertex, `one`): the vertex's position.

A **Dir** (used by query predicates and linear patterns) is `"+X"`, `"-X"`, `"+Y"`, `"-Y"`, `"+Z"`,
`"-Z"` (signed), `"X"`, `"Y"`, `"Z"` (unsigned: parallel tests ignore the sign; where a sign is
needed they mean +), a P3 vector, or an AxisRef object (its direction).

### 3.3 `datum_plane` [D-17]

Produces no body. Its frame can be used wherever a PlaneRef is accepted.

| `mode` | Fields | Frame |
|---|---|---|
| `offset` | `from: PlaneRef`, `distance: length` (any sign) | `from` translated by `distance · n` |
| `angle` | `from: PlaneRef`, `axis: AxisRef`, `angle: angle` | `from` rotated by `angle` about the axis line (right-hand rule about its direction). The axis must be parallel to the plane: `\|a · n\| ≤ sin(QUERY_ANGLE_TOLERANCE)`, else `DATUM_DEGENERATE` |
| `midplane` | `a: PlaneRef`, `b: PlaneRef` | normal and axes of `a`; origin `o_a + ((o_b − o_a) · n_a / 2) · n_a`. The normals must be parallel or anti-parallel within `QUERY_ANGLE_TOLERANCE`, else `DATUM_DEGENERATE` |
| `through` | `points`: three PointRefs `p0, p1, p2` | origin `p0`, `x = normalize(p1 − p0)`, normal `normalize((p1 − p0) × (p2 − p0))` (orientation follows the point order), `y = n × x`; collinear points (`\|cross\| ≤ tol·\|p1 − p0\|`) → `DATUM_DEGENERATE` |
| `frame` | `origin`, `normal`, `x_dir` | v0 §2 |

```json
{ "type": "datum_plane", "id": "d1", "name": "mid", "mode": "midplane",
  "a": { "face": { "kind": "face", "q": { "op": "side", "feature": "e1", "curve": "left" } } },
  "b": { "face": { "kind": "face", "q": { "op": "side", "feature": "e1", "curve": "right" } } } }
```
```ts
const mid = datumPlane({ midplane: [slab.side("left"), slab.side("right")] });
const tilted = datumPlane({ from: XY, axis: X, angle: 30 });
const above = datumPlane({ offset: slab.cap("end"), distance: 10 });
const slant = datumPlane({ through: [wedge.edgeAt("a", "end").vertices().max("+Z").one(),
                                     wedge.edgeAt("b", "end").vertices().max("+Z").one(), [0, 40, 12]] });
```

The report lists the evaluated frame (`datum: { origin, x, y, normal }`), compared per §8.2.

### 3.4 `datum_axis` [D-18]

| `mode` | Fields | Axis |
|---|---|---|
| `edge` | `edge: Ref` | as the `{ "edge" }` AxisRef |
| `cylinder` | `face: Ref` | as the `{ "cylinder" }` AxisRef |
| `planes` | `a: PlaneRef`, `b: PlaneRef` | the intersection line; direction `normalize(n_a × n_b)`, sign-canonical; parallel planes → `DATUM_DEGENERATE` |
| `points` | `points`: two PointRefs `[a, b]` ([W0-8]; not `a`/`b`, which are PlaneRefs in `planes` mode) | through both, direction `b − a`; `\|b − a\| ≤ tol` → `DATUM_DEGENERATE` |

[W0-8] Both datum features are one JSON object with a `mode` and the fields of that mode; a missing
or extra field is `DATUM_OPTIONS_CONFLICT` (rejected, details `{ "mode", "fields", "missing",
"unexpected" }`). A literal `frame` whose normal and `x_dir` are not perpendicular is
`INVALID_PLANE`. `flip` is allowed as for AxisRef. CadScript: `datumAxis({ cylinder: boss.side("ring") })`,
`datumAxis({ planes: [XZ, mid] })`. Report: `datum: { origin, direction }`.

## 4. Sketches

### 4.1 Sketch feature [D-19]

`{ "type": "sketch", "id", "name", "v"?, "suppressed"?, "plane": PlaneRef, "curves": [...], "constraints"?: [...] }`

**Curves.** v0's `line`, `arc` and `circle` keep their fields; every coordinate and radius is a
Scalar. Each curve may set `"construction": true`. New kinds:

| Kind | Fields | Meaning |
|---|---|---|
| `point` | `id`, `at: P2` | A sketch point. Never part of a loop. Used by constraints, hole placement (§6.5) and queries. |
| `rect` | `id`, exactly one of `center: P2` / `corner: P2` (lower-left), `w`, `h`, `r` (corner radius, default 0) | compound curve, expanded below |
| `slot` | `id`, `a: P2`, `b: P2`, `w` | compound curve: a straight slot with round ends centred on `a` and `b` |
| `polygon` | `id`, `center: P2`, `n` (count ≥ 3), exactly one of `circumradius` / `inradius` / `across_flats` / `side`, `rotation` (angle, default 0) | compound curve: a regular polygon |

**Compound curves** expand, before anything else, into **member** curves with ids
`<id>.<member>`. Members are ordinary curves for every later rule (loops, regions, provenance
`side:<member id>`, queries). The expansion is normative, evaluated in f64 exactly as written, and
**a member of length ≤ tol is omitted** (so a `rect` with `r = h/2` is a stadium with no `left` and
`right` members). Invalid sizes fail with `INVALID_VALUE`, details `{ "field", "value", "expected" }`.

[W0-6] A member's "length" is `|end − start|` (for arcs: the chord), consistent with v0's
degeneracy rule. Members are listed in table order (rect: `bottom`, `c_br`, `right`, `c_tr`,
`top`, `c_tl`, `left`, `c_bl`; slot: `right`, `cap_b`, `left`, `cap_a`; polygon: `e0` … `e(n−1)`).
The `corner` form of `rect` uses `x0 = kx, x1 = kx + w, y0 = ky, y1 = ky + h`. A `rect` with both or
neither of `center`/`corner`, and a `polygon` with other than exactly one size field, is
`CURVE_OPTIONS_CONFLICT` (rejected, details `{ "curve", "fields" }`); a polygon `n` that is not an
exact integer is `EXPR_NOT_INTEGER`, `n < 3` is `INVALID_COUNT`. Any curve kind, including
`point`, may carry `construction`. Reference implementation: `forge_ir::v1::compound::expand`;
golden cases: `corpus/v1/conformance/compound/expansions.json`.

`rect` (with `x0 = cx − w/2`, `x1 = cx + w/2`, `y0 = cy − h/2`, `y1 = cy + h/2`; requires
`w > tol`, `h > tol`, `0 ≤ r ≤ min(w, h)/2`), all arcs `ccw: true`:

| Member | `r = 0` | `r > 0` |
|---|---|---|
| `bottom` | line (x0, y0) → (x1, y0) | line (x0 + r, y0) → (x1 − r, y0) |
| `c_br` | — | arc centre (x1 − r, y0 + r), (x1 − r, y0) → (x1, y0 + r) |
| `right` | line (x1, y0) → (x1, y1) | line (x1, y0 + r) → (x1, y1 − r) |
| `c_tr` | — | arc centre (x1 − r, y1 − r), (x1, y1 − r) → (x1 − r, y1) |
| `top` | line (x1, y1) → (x0, y1) | line (x1 − r, y1) → (x0 + r, y1) |
| `c_tl` | — | arc centre (x0 + r, y1 − r), (x0 + r, y1) → (x0, y1 − r) |
| `left` | line (x0, y1) → (x0, y0) | line (x0, y1 − r) → (x0, y0 + r) |
| `c_bl` | — | arc centre (x0 + r, y0 + r), (x0, y0 + r) → (x0 + r, y0) |

`slot` (requires `|b − a| > tol`, `w > tol`; `d = (b − a)/|b − a|`, left normal `m = (−d_v, d_u)`,
`h = w/2`): `right` line `a − h·m → b − h·m`; `cap_b` arc centre `b`, `b − h·m → b + h·m`, ccw;
`left` line `b + h·m → a + h·m`; `cap_a` arc centre `a`, `a + h·m → a − h·m`, ccw.

`polygon`: circumradius `R` = `circumradius`, or `inradius / cos(180/n)`,
`across_flats / (2·cos(180/n))`, `side / (2·sin(180/n))` (degree trigonometry of §2.7). Vertex
`k ∈ [0, n)` is `P_k = center + R·(cos θ_k, sin θ_k)` with `θ_k = rotation + (360·k)/n`; member
`e<k>` is the line `P_k → P_(k+1 mod n)`. With `rotation: 0` a vertex lies on +u, so a hexagon's
flats are parallel to u (the MakerBench hex standoff is `polygon({ n: 6, across_flats: 5.5 })`).

### 4.2 Sketch modes [D-20]

| Mode | When | Geometry fields | Compound curves | Semantics |
|---|---|---|---|---|
| **explicit** | `constraints` empty | Scalars (expressions allowed) | allowed | evaluate every Scalar, expand compound curves, then v0 §3 on the result |
| **constrained** | `constraints` non-empty | **literal numbers only**: the stored initial guess, normally the last solution | not allowed | §4.3–§4.5: solve, then v0 §3 on the solved geometry |

Violations are `SKETCH_MIXED_MODE` (rejected). In explicit mode the v0 structural curve checks
(`DEGENERATE_CURVE`, `INCONSISTENT_ARC`) apply to literal values at validation and to computed
values at evaluation (§0.5). In constrained mode `INCONSISTENT_ARC` is not checked (the solver's arc
rule restores it); `DEGENERATE_CURVE` still is.

Explicit mode is what the agent writes most (`rect({ w: width, … })`); constrained mode is what the
interactive sketcher and `sketch_edit` produce. Both are first-class and round-trip through
CadScript.

### 4.3 Mapping to forge-solve [D-21]

**Entities.** Each IR curve maps to forge-solve entities with derived ids:

| IR curve | forge-solve entities |
|---|---|
| `point p` | point `p` |
| `line l` | points `l.start`, `l.end`; line `l` (`p1 = l.start`, `p2 = l.end`) |
| `arc a` | points `a.start`, `a.end`, `a.center`; arc `a` = (`a.center`, `a.start`, `a.end`) if `ccw`, else (`a.center`, `a.end`, `a.start`), since forge-solve arcs are counter-clockwise |
| `circle c` | point `c.center`; circle `c` with its `radius` parameter |

`construction` is passed through. Derived ids share the sketch namespace (§0.3); a clash is
`DUPLICATE_ID`.

**Welding.** Curve **ends** (the `start`/`end` points of lines and arcs) that coincide within *tol*
in the stored geometry are welded into one solver point: union-find over the ends in curve order,
`start` before `end`; each group is represented by its first member, and the other members are
aliases of it. Points and centres never weld. After the solve every alias takes the
representative's solved coordinates, so loops that were closed stay closed bit-exactly. (This keeps
v0's rule that coincident ends are joined, without requiring explicit coincident constraints.)

**Constraints.** Each constraint is `{ "id", "type", …arguments, "value"?, "driving"? }`. Arguments
are entity reference strings resolved **exactly** against the solver entity ids (`p`, `l`, `l.start`,
`a.center`, …); an unknown id is `SKETCH_UNKNOWN_REFERENCE`. The 16 kinds are forge-solve's
(`forge-solve/src/model.rs`), with the same argument names:

| `type` | Arguments | `value` field type |
|---|---|---|
| `coincident` | `a`, `b` points | — |
| `horizontal`, `vertical` | `line` (relative to the sketch's u/v axes) | — |
| `parallel`, `perpendicular` | `a`, `b` lines | — |
| `tangent` | `a`, `b` (line–circle/arc, circle/arc–circle/arc), optional `internal: bool` | — |
| `equal` | `a`, `b` (two lines: length; two circles/arcs: radius) | — |
| `distance` | `a` point, `b` point or line | length |
| `angle` | `a`, `b` lines; counter-clockwise from `a` (`p1 → p2`) to `b` | angle |
| `radius`, `diameter` | `curve` circle or arc | length |
| `point_on_line`, `midpoint` | `point`, `line` | — |
| `point_on_circle` | `point`, `curve` | — |
| `symmetric` | `a`, `b` points, `line` | — |
| `fix` | `entity`, optional `x`, `y` (lengths) | — |

- **Driving dimensions** (`distance`, `angle`, `radius`, `diameter` with `driving` omitted or
  `true`) require `value` ([W0-13] `CONSTRAINT_VALUE_REQUIRED`, rejected), a Scalar that may
  reference parameters. A literal `distance`/`radius`/`diameter` value ≤ 0 is
  `SKETCH_INVALID_DIMENSION` at validation (§0.5 rule 1); an expression one fails the sketch at
  evaluation (§4.4). This is how dimensions are
  **bound to parameters**: `"value": "width"`.
- **Reference dimensions** (`"driving": false`) MUST NOT have a `value`
  (`CONSTRAINT_VALUE_ON_REFERENCE`); they are measured, reported in `sketch.dimensions`, and can be
  bound to a **measured parameter** (§2.1) that later features use.
- The structural errors of forge-solve map to rejections with the same codes:
  `SKETCH_UNKNOWN_REFERENCE`, `SKETCH_WRONG_ENTITY_TYPE`, `SKETCH_NOT_A_DIMENSION`,
  `SKETCH_UNSUPPORTED_COMBINATION`, `SKETCH_SELF_REFERENCE`. [W0-9] They are decided with
  forge-solve's rules and order (`system.rs::compile_constraint`), one per constraint, on the
  argument ids **as written**: two different ids that welding maps to one solver point are not a
  self-reference (§4.6: such a constraint is redundant, and W2 must lower it so that forge-solve
  reports it as redundant instead of raising `SketchError::SelfReference`). Paths point at the
  offending argument (`…/constraints/k/line`); `SKETCH_UNSUPPORTED_COMBINATION` points at the
  constraint.
- [W0-9] The IR constraint types, `type` tags and argument names equal forge-solve's JSON model; a
  constraint with literal values deserializes as a `forge_solve::Constraint` (tested). The only
  difference: an IR reference dimension has no `value`.

### 4.4 Solving [D-22]

1. Evaluate every constraint `value`. A `distance`, `radius` or `diameter` value ≤ 0 fails the
   sketch with `SKETCH_INVALID_DIMENSION`, details `{ "constraint", "value" }`.
2. Build the solver sketch: entities in curve order (each curve's points, then the curve), welded;
   constraints in IR order (forge-solve attributes redundancy and conflicts to later constraints).
3. Solve with forge-solve using the options pinned by the sketch's `v` (for `v: 1`:
   `SolveOptions::default()` as of forge-solve 0.0.1 — tolerance 1e-10, 200 iterations, QRCP rank
   tolerance 1e-8, conflict rank tolerance 1e-6, DOF tolerance 1e-7, at most 8 conflicts). Any
   change to forge-solve that can change a v1 result (including where an under-constrained sketch
   ends up) requires sketch `v: 2`.
4. **Fixed point.** If the stored guess already satisfies every driving constraint to
   `SOLVE_TOLERANCE`, the solution MUST be bit-identical to the guess.
5. Map the status:

| forge-solve status | Feature | Report |
|---|---|---|
| `fully_constrained` | ok | — |
| `under_constrained` | ok | info `SKETCH_UNDER_CONSTRAINED`, details `{ "dof", "entities": [{ "id", "dof" }] }` |
| `over_constrained_redundant` | ok | warning `SKETCH_REDUNDANT_CONSTRAINTS`, details `{ "redundant": [{ "constraint", "implied_by" }] }` |
| `conflict` | **fails** `SKETCH_CONSTRAINT_CONFLICT` | details `{ "conflicts": [{ "constraints", "suggested_removal", "verified_minimal" }] }` |
| `failed_to_converge` | **fails** `SKETCH_SOLVE_FAILED` | details `{ "max_residual", "clusters": [{ "entities", "constraints" }] }` |

6. **No stale fallback.** A sketch whose solve fails never feeds its stored geometry to later
   features: that geometry satisfies older values and would be silently wrong. Its consumers fail
   with `DEPENDENCY_FAILED`. A UI MAY draw the stored geometry greyed out.
7. The solved geometry replaces the guess for this evaluation (arcs mapped back through the `ccw`
   rule of §4.3), then v0 §3's stages run on it; a solution can still cross itself
   (`SKETCH_CURVES_CROSS`).
8. **Flip check.** For every closed loop, if the sign of its signed area differs between the stored
   guess and the solution, the sketch reports warning `SKETCH_LOOP_FLIPPED`, details
   `{ "curves" }`: the solver jumped to a mirrored configuration. The sketch still succeeds.
9. **Write-back** (§0.6): after a committed edit, `writeBackSolution` replaces the literal
   coordinates with the solved ones. By rule 4 this is idempotent.

The report entry of a sketch (§7.2) carries `sketch: { "mode", "status", "dof", "solved": [curves
with literal geometry], "dimensions": [{ "id", "driving", "value", "measured" }] }`. The oracle
replays `solved` instead of solving (§8.1).

### 4.5 Regions [D-23]

v0 §3.1–§3.2 apply to the non-construction lines, arcs, circles and compound members. Points and
construction curves are ignored for loops and regions. Region names stay the sorted outer-loop curve
ids (member ids for compound curves: a `rect` region is `["outline.bottom", "outline.left", …]`).

Body features select regions with `regions`: `"all"` (default) or a list of curve ids; each id
selects the region whose **outer loop contains** that curve (`REGION_NOT_FOUND`, details
`{ "curve" }`, when none does). Selected regions are used once each, in canonical order. Selecting by
a member curve instead of the full outer-curve set is naming recommendation 2: it survives edits to
the region's other curves.

[W0-14] Statically, `regions` is `"all"` or a non-empty list (`INVALID_VALUE`), and every id must
name a **profile curve** of the consumed sketch — a non-construction line, arc or circle, or a
member id a compound curve can produce (all eight rect members, all four slot members, `e0` …
`e(n−1)`, or any `e<k>` when `n` is an expression) — else `QUERY_UNKNOWN_CURVE` (rejected). Points
and construction curves are not profile curves.

### 4.6 Example (constrained)

```json
{ "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
  "curves": [
    { "kind": "line", "id": "bottom", "start": [-40, -25], "end": [40, -25] },
    { "kind": "line", "id": "right",  "start": [40, -25],  "end": [40, 25] },
    { "kind": "line", "id": "top",    "start": [40, 25],   "end": [-40, 25] },
    { "kind": "line", "id": "left",   "start": [-40, 25],  "end": [-40, -25] },
    { "kind": "point", "id": "o", "at": [0, 0] },
    { "kind": "line", "id": "diag", "start": [-40, -25], "end": [40, 25], "construction": true }
  ],
  "constraints": [
    { "id": "h1", "type": "horizontal", "line": "bottom" },
    { "id": "h2", "type": "horizontal", "line": "top" },
    { "id": "v1", "type": "vertical", "line": "left" },
    { "id": "v2", "type": "vertical", "line": "right" },
    { "id": "w",  "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": "width" },
    { "id": "d",  "type": "distance", "a": "left.start", "b": "left.end", "value": "depth" },
    { "id": "mid", "type": "midpoint", "point": "o", "line": "diag" },
    { "id": "pin", "type": "fix", "entity": "o" }
  ] }
```
```ts
const base = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: line([40, 25], [-40, 25]),
  left: line([-40, 25], [-40, -25]),
  o: point([0, 0]),
  diag: line([-40, -25], [40, 25], { construction: true }),
}, {
  constraints: {
    h1: C.horizontal("bottom"), h2: C.horizontal("top"),
    v1: C.vertical("left"), v2: C.vertical("right"),
    w: C.distance("bottom.start", "bottom.end", width),
    d: C.distance("left.start", "left.end", depth),
    mid: C.midpoint("o", "diag"),
    pin: C.fix("o"),
  },
});
```

The construction diagonal's ends coincide with `bottom.start` and `top.start` in the stored guess,
so welding (§4.3) joins them; no coincident constraints are needed. Welding applies to every curve
end, construction or not. An explicit `coincident` between two ends that are already welded is
redundant and is reported under `SKETCH_REDUNDANT_CONSTRAINTS`; writers SHOULD omit it. The sketch
is fully constrained: 10 unknowns (4 welded corners and `o`, 2 each) against 10 independent
equations (4 horizontal/vertical, 2 distances, 2 for the midpoint, 2 for the fix).

CadScript exports the constraint builders as one namespace, `C` (`C.distance`, `C.tangent`, …), so
that `distance`, `angle` or `radius` stay free as parameter names. `rect`/`slot`/`polygon` inside a
constrained sketch are rejected with `SKETCH_MIXED_MODE` and the hint "use lines and constraints, or
drop the constraints and drive the rect with parameters".

## 5. References and queries

This section implements ADR 0006 with the nine recommendations of the naming spike
([02-naming.md](../../../docs/spikes/02-naming.md) §Recommendations, BACKLOG "How IR v1 should store
face and edge references"). The mapping is in §5.12.

### 5.1 The Ref object [D-24]

```json
{ "kind": "face", "q": { …query… }, "card": "one", "capture": { … } }
```

| Field | Meaning |
|---|---|
| `kind` | `face`, `edge`, `vertex` or `body`. MUST equal the static kind of `q` (§5.4) and be accepted by the field (§6), else `REF_KIND_MISMATCH` (rejected). |
| `q` | A query AST (§5.3). It is the **intent** of the reference and the only part that CadScript shows. |
| `card` | Declared cardinality (§5.5). Omitted means the field's default. |
| `capture` | Optional snapshot of what the reference resolved to when it was last accepted (§5.6). Written only by the command layer. |

References never store kernel indices, `#k` indices, coordinates as identity, or feature names.

### 5.2 Provenance keys and naming conventions [D-25]

Every face, edge and vertex of every body carries provenance (FORGE.md "Provenance"). Its
serialization, the **provenance key**, is what captures store and what the resolver matches.

1. **Grammar.** The forge-core grammar (`forge-core/src/topo/provenance.rs`) with two changes:
   the `feature` segment is the feature **id** (naming recommendation 6), and a role may carry a
   **qualifier** `@q`:
   ```text
   key    := fid "/" role [ "@" qual ]            ; "#index" is NEVER part of a key
   role   := "cap:start" | "cap:end" | "endcap:start" | "endcap:end"
           | "side:" leaf | "edge:{" key "|" key "}" | "vertex:{" key ( "|" key )* "}"
           | label [ ":{" key "}" | ":" leaf ]         ; the op roles of rule 3
   qual   := text                                  ; parsed per role, see below
   ```
   The qualifier is the body member `m` for caps and end caps (a curve id), `c.start`/`c.end` for
   junction edges (split at the **last** `.`), the position id for hole faces, and `i` or `i.j` for
   pattern copies.
2. **Display names** replace each feature id by the feature's current name and drop qualifiers that
   are not needed to tell entities apart (`plate/cap:end`, `plate/side:bottom`). Display names are
   for people and agents; they are never stored.
3. **Roles per operation.** Every operation MUST name everything it creates (checked by the
   invariant checker), following this table. An entity that an operation only **modifies** (trims,
   splits, extends) keeps its key.

| Operation | Entity | Key |
|---|---|---|
| extrude `F` | start cap / end cap | `F/cap:start@m`, `F/cap:end@m`. `start` is the cap at the start of the v0 §4.2 sweep range: the sketch-plane side for `normal` and `reverse`, the `−d/2` side for `symmetric`. |
| | side face of curve `c` | `F/side:c` |
| | edge between faces `A` and `B` | `F/edge:{A\|B}` (sorted); a side–side junction edge also gets the qualifier `@c.end` naming the **smallest** (byte-wise) curve end `c.start`/`c.end` of the sketch vertex it was swept from |
| revolve `F` | end caps (below 360°) | `F/endcap:start@m`, `F/endcap:end@m`. `start` is on the profile plane for `normal` **and** `reverse`, at `−Θ/2` for `symmetric` (the rule forge-ops already follows since spike 02). |
| | sides, edges | as extrude; a circular junction edge swept from a vertex gets `@c.end` |
| any body op (join/cut/intersect, `boolean`, hole, pattern with an op) | faces of targets and tools that survive | keep their keys; split pieces **share** the key (display `#k` only) |
| | new edges and vertices from the intersection | `G/edge:{A\|B}`, `G/vertex:{…}`, where `G` is the operation's feature id |
| | faces merged by the same-domain rule (§6.0.4) | the surviving face keeps the byte-wise smallest key among the merged faces **of the target bodies** (or among all merged faces if none is a target's); every other merged key becomes an **alias** of it |
| hole `H`, position `p` | wall, tip cone, flat floor, counterbore wall and floor, countersink cone | `H/wall@p`, `H/tip@p`, `H/floor@p`, `H/cbore_wall@p`, `H/cbore_floor@p`, `H/csink@p` |
| fillet `F` / chamfer `F` | blend face of edge `E`; corner patch at vertex `V` | `F/blend:{E}` / `F/bevel:{E}`; `F/corner:{V}` |
| shell `S` | offset of face `X`; rim left where face `X` was opened | `S/offset:{X}`, `S/rim:{X}` |
| draft `D` | drafted faces | keep their keys (modified) |
| pattern `P`, instance `(i, j)` | copy of seed entity `K` | `P/copy:{K}@i` (linear, circular, mirror = instance 1) or `P/copy:{K}@i.j` (two-direction linear) |

4. **Body member `m`.** A body is identified by its **origin**: the feature id that created it and
   the byte-wise smallest curve id of its region's outer loop *at creation*. Caps carry that member
   as qualifier (naming recommendation 2). Bodies modified by later operations keep their origin;
   pieces of a split body share it.
5. **Escaping.** When an id is rendered into a key, each byte of `/ : { } | + # @ %` and of
   whitespace is written as `%XX` (upper-case hex); display names show the unescaped id. (`@` and
   `%` join the v0 reserved set; `.` is not escaped, so the compound member `outline.bottom` renders
   as `e1/side:outline.bottom`.)
6. **Index families are display-only.** When several entities share a key (split pieces), they get
   display indices `#0, #1, …` in the canonical order of §5.4. Indices are never persisted
   (naming recommendation 1).

### 5.3 Query AST [D-26]

A query is a JSON object with an `op`. Kinds: **F** faces, **E** edges, **V** vertices, **B**
bodies. The **scope** of a query is the bodies of the feature's part in the feature's **input
state** (just before the feature runs). `feature` fields are feature ids of earlier features of the
same part (`UNRESOLVED_FEATURE`); curve ids named in `curve` and `member` fields must exist in the
sketch that feature consumed (`QUERY_UNKNOWN_CURVE`, rejected; the compiler checks this
statically). A `hole_face` position id that the hole no longer produces (e.g. a grid that shrank)
simply yields nothing, which the cardinality check reports.

[W0-14] **Static checks** (all rejections, paths into the query): a named source's `feature` must
be an earlier feature of the same part (`UNRESOLVED_FEATURE`) of the right type, else
`QUERY_INVALID` at `…/feature` with `expected` / `found` feature types: `cap` → `extrude`;
`endcap` → `revolve`; `side`, `sides`, `edge_at` → `extrude` or `revolve`; `body` → `extrude`,
`revolve` or `pattern`; `hole_face` → `hole`; `instance` → `pattern`; `tagged` → `tag`; `created` →
any feature that creates geometry (not `sketch`, datums or `tag`). `curve` and `member` must name
profile curves of the consumed sketch (§4.5; `QUERY_UNKNOWN_CURVE`); `edge_at` of a circle is
`QUERY_INVALID` (a circle has no ends). `union`/`intersect` need at least one operand;
`convex`/`concave`/`smooth` take only `true`; `radius` is `{ "eq" }` or `{ "min"?, "max"? }` with
at least one bound, bounds ≥ 0 (`INVALID_VALUE`); `instance.index` has one or two entries;
`largest`/`smallest` of vertices is `QUERY_INVALID` (vertices have no size); a literal zero `Dir`
vector is `INVALID_VALUE`. `hole_face.at` and `created.role` follow the id grammar. The golden
cases are `corpus/v1/conformance/queries/typing.json`.

**Sources.** A source is **named** when it designates specific entities by identity; named sources
are the only ones the capture validates and the only ones that can fall back geometrically (§5.7).

| `op` | Fields | Kind | Named | Result |
|---|---|---|---|---|
| `body` | `feature`, `member`? | B | yes | bodies whose origin feature is `feature` (with `member`: whose origin region's outer loop contains `member`), including every piece of a split |
| `bodies` | — | B | no | every body in scope |
| `cap` | `feature`, `end` (`start`/`end`), `member`? | F | yes | the extrude's cap faces (of the body with that member) |
| `endcap` | `feature`, `end`, `member`? | F | yes | the revolve's end-cap faces |
| `side` | `feature`, `curve` | F | yes | faces keyed `F/side:curve` (all pieces) |
| `sides` | `feature`, `member`? | F | no | every side face of the feature |
| `edge_at` | `feature`, `curve`, `end` | E | yes | the junction edges swept from the sketch vertex at that curve end (the `edgeAt(bow.end)` of recommendation 1) |
| `between` | `a`: F query, `b`: F query | E | yes if `a` and `b` are both named | edges with one adjacent face in `a` and the other in `b` (recommendation 5) |
| `hole_face` | `feature`, `at` (position id), `part` (`wall`, `tip`, `floor`, `cbore_wall`, `cbore_floor`, `csink`) | F | yes | |
| `created` | `feature`, `role`? | F | no | every face whose key has that feature id (and role label) |
| `instance` | `feature` (a pattern), `index`: `[i]` or `[i, j]` | F | no | every face of that pattern instance |
| `tagged` | `feature` (a `tag` feature) | the tag's kind | as the tag's query | the tag's query re-evaluated in the current scope (§6.12) |

**Navigation** (always **not named**; named-ness is cleared):

| `op` | Fields | From → to |
|---|---|---|
| `faces` | `of` | B → faces of the bodies; E → the two adjacent faces; V → incident faces |
| `edges` | `of` | B → all edges; F → boundary edges; V → incident edges |
| `vertices` | `of` | B, F, E → vertices |
| `owner` | `of` | F, E, V → the bodies containing them |

**Set algebra** (operands of one kind; named-ness is kept per member): `union { of: [q…] }`,
`intersect { of: [q…] }`, `minus { a, b }` (the members of `a` not in `b`).

**Filters and picks** (named-ness is kept per member):

| `op` | Fields | Keeps |
|---|---|---|
| `filter` | `of`, `where`: one predicate | members satisfying the predicate |
| `extreme` | `of`, `dir` (signed Dir), `which` (`max`/`min`) | members whose **centroid** projected on `dir` is within `LINEAR_TOLERANCE·s` of the max (min) |
| `largest`, `smallest` | `of` | members of maximal (minimal) **size** — area, length or volume — ties within `QUERY_SIZE_TIE_REL` |

**Predicates** (one per `filter`; all angle tests use `QUERY_ANGLE_TOLERANCE`):

| Predicate | Applies to | True when |
|---|---|---|
| `{ "type": t }` | F: `plane`, `cylinder`, `cone`, `sphere`, `torus`, `bspline`; E: `line`, `circle`, `ellipse`, `bspline` | the canonical type (v0 §5) is `t` |
| `{ "normal": Dir }` | F | planar, outward normal equal to the **signed** direction |
| `{ "parallel": Dir }` | E, F | E: a line parallel to the direction (either sign). F: a plane whose normal is perpendicular to it, or a cylinder/cone whose axis is parallel to it |
| `{ "perpendicular": Dir }` | E, F | E: a line perpendicular to it, or a circle whose normal is parallel to it. F: a plane whose normal is parallel to it (either sign) |
| `{ "convex": true }`, `{ "concave": true }`, `{ "smooth": true }` | E | the material angle across the edge, measured at the edge's parametric midpoint, is < 180° − tol, > 180° + tol, or within tol of 180° |
| `{ "radius": { "eq" \| "min" \| "max": length } }` | F (cylinder, sphere; torus: minor radius), E (circle) | radius equal within `LINEAR_TOLERANCE`, or within the bounds (inclusive); other types are false |

Sizes and centroids are computed on the exact geometry, as metrics are. `s` is the scale of v0 §6
(the diagonal of the scope's bounding box, at least 1).

### 5.4 Static kinds and canonical order [D-27]

- The kind of every node is computed statically from the table above. An operand of the wrong kind
  (e.g. `normal` on edges, `between` of edges, `union` of faces and edges) is `QUERY_INVALID`
  (rejected), details `{ "path", "expected", "found" }`.
- A result set is ordered canonically: faces, edges and vertices by key (byte-wise), then pieces of
  one key by the lexicographic order of their probe points (§7.6) compared with tolerance
  `LINEAR_TOLERANCE·s`; bodies by origin (timeline index of the origin feature, then member), then
  pieces by centroid in the same way. The order is used for display indices, for the report and
  for anything that iterates a set; it never changes which entities are selected.

### 5.5 Cardinality [D-28]

| `card` | Meaning | Violations |
|---|---|---|
| `"one"` | exactly 1 | 0 → `REF_MISSING`; ≥ 2 → `REF_AMBIGUOUS` (or `REF_SPLIT`, §5.7) |
| `"some"` | ≥ 1 | 0 → `REF_MISSING` |
| `"any"` | ≥ 0 | none |
| integer `n ≥ 1` | exactly `n` | → `REF_CARDINALITY`, details `{ "expected", "found" }` |

[W0-14] A field whose default is `one` designates exactly one entity (a plane face, an axis edge or
face, a vertex point, `up_to`, chamfer `side`, shell `body`, datum-axis `edge`/`face`): its `card`
may only be `one` or `1` (`INVALID_CARDINALITY`). Default cardinalities per field: `some` for
body `targets`/`tools`, fillet/chamfer `edges`, draft `faces`, pattern `bodies` and `tag.target`;
`any` for shell `open`; `one` for the rest.

A reference whose target was split therefore either takes every piece (`some`, `any`, or `n` when
the count still matches) or fails loudly: an exact answer on one piece, the most common silent
re-bind of the spike, cannot happen (recommendation 3).

### 5.6 Capture [D-29]

```json
"capture": { "members": [
  { "key": "e1/side:bottom", "via": "named",
    "geom": { "type": "plane", "carrier": { "plane": { "normal": [0, -1, 0], "offset": 25 } },
              "bbox": [[-40, -25, 0], [40, -25, 8]], "size": 640, "centroid": [0, -25, 4],
              "local": [0.5, 0, 0.5], "body_center": [0, 0, 4], "neighbors": 0 } },
  { "key": "e1/edge:{e1/cap:end@bottom|e1/side:bottom}", "via": "broad",
    "faces": ["e1/cap:end@bottom", "e1/side:bottom"], "geom": { … } }
] }
```

- One entry per member of the resolved set, in canonical order, with `via` = `named` or `broad`
  (§5.3).
- `geom` holds the fingerprint fields the spike found useful (recommendation 6 of the spike): the
  canonical `type`; the exact `carrier` (plane: outward normal and offset; cylinder: canonical
  axis, closest point, radius; cone: axis, apex, half-angle; sphere: centre, radius; torus: axis,
  centre, major, minor; line: canonical direction, closest point; circle: canonical normal, centre,
  radius; otherwise `"free"`); the entity's `bbox`; exact `size`; world `centroid`; `local` (the
  centroid normalised to the body's bbox); `body_center` (the body's bbox centre, i.e. its own
  displacement); `neighbors` (the number of adjacent entities on the same carrier: the split
  signature).
- [W0-7] Carrier encodings (`carrier` is externally tagged, or the string `"free"`):
  `{ "plane": { "normal", "offset" } }`, `{ "cylinder": { "axis", "point", "radius" } }`,
  `{ "cone": { "axis", "apex", "half_angle" } }` (degrees), `{ "sphere": { "center", "radius" } }`,
  `{ "torus": { "axis", "center", "major", "minor" } }`, `{ "line": { "direction", "point" } }`,
  `{ "circle": { "normal", "center", "radius" } }`. `geom.type` is one of `plane`, `cylinder`,
  `cone`, `sphere`, `torus`, `bspline`, `line`, `circle`, `ellipse`, `other`, `vertex` (vertex
  members: `size` 0, `carrier` `"free"`) or `body` (body members: `size` = volume).
- Edge members also store the keys of their two `faces` (recommendation 5), sorted.
- A capture is canonical JSON, part of the feature's cache key, and never shown in CadScript.
  `compile(src, { base })` carries a reference's capture over when its query is unchanged.

### 5.7 Resolution [D-30]

Resolution maps a Ref and the input state to a set of entities, or fails the feature. The layers
are those of ADR 0006: exact provenance → disambiguation → query filters → geometric fallback with
confidence → error. Here they run in this normative order:

**Step 1 — Evaluate the query** (exact provenance and filters). Named sources look entities up by
key (and by alias, §5.2 rule 3); filters and picks run on the result. The evaluator records, per
member, whether it is `named` or `broad`. If a named source refers to a feature that **failed** in
this evaluation, the reference fails with `DEPENDENCY_FAILED` (`{ "feature", "code" }`); if that
feature is **suppressed**, the source yields nothing and the reason is `feature-suppressed`.

**Step 2 — Without a capture**, go to step 5.

**Step 3 — Validate the captured named members.** For each captured member `m` with `via: named`,
let `M` be the members of the step-1 result whose key is `m.key` or an alias of it:

| Case | Outcome | Used? | Reported |
|---|---|---|---|
| `\|M\| = 1`, same type, same `neighbors` | exact | yes | — |
| `\|M\| = 1`, found through an alias | merged | yes | info `REF_MERGED` `{ "key", "into" }` |
| `\|M\| = 1`, `neighbors` decreased | neighbourhood changed | yes | warning `REF_NEIGHBORHOOD_CHANGED` |
| `\|M\| = 1`, type changed | kind changed | yes, unless the consuming field needs the old type, which then fails with its own code (e.g. `PLANE_NOT_PLANAR`) | warning `REF_KIND_CHANGED` `{ "key", "was", "now" }` (recommendation 4) |
| `\|M\| ≥ 2`, or `\|M\| = 1` with more `neighbors` (a split) | split | all pieces, if the cardinality allows it | info `REF_SPLIT_ACCEPTED` `{ "key", "pieces" }`; with `card: "one"` (or an `n` the pieces break) the reference **fails** with `REF_SPLIT` and the pieces as candidates, the name-anchored piece first, then by size |
| `\|M\| = 0` | → step 4 | | |

**Step 4 — Geometric fallback** for a missing named member, over every entity of the member's kind
in scope whose type equals the captured type (type is a hard filter). Candidates are scored with the
forge-naming fingerprint comparison (`forge-naming/src/fingerprint.rs`, `compare`):

| Case (checked in this order) | Outcome | Confidence | Used? |
|---|---|---|---|
| exactly one candidate is **geometry-identical** (carrier, bbox, size and centroid equal within the forge-naming tolerances) | repaired | `IDENTICAL_MATCH_CONFIDENCE` | **yes** (≥ `AUTO_ACCEPT_CONFIDENCE`); info `REF_REPAIRED` with a proposal (§5.8) |
| several geometry-identical candidates | ambiguous | 0 | no → `REF_AMBIGUOUS` |
| an edge whose two captured `faces` both still resolve by key but no longer meet | missing, reason `faces-no-longer-meet` | 0 | no → `REF_MISSING` |
| ≥ 2 candidates on the captured carrier inside the captured bbox | split (pieces with new keys) | 0 | no → `REF_SPLIT` |
| one such piece | uncertain | 0.7 | no → `REF_UNCERTAIN` |
| best score ≥ `MIN_PLAUSIBLE`, others below `(1 − TIE_MARGIN)·best` | uncertain | `min(best, MAX_DISAMBIGUATION_CONFIDENCE)` | no → `REF_UNCERTAIN` |
| a tie | ambiguous | 0 | no → `REF_AMBIGUOUS` |
| nothing plausible | missing, reason `no-plausible-match` (or `feature-suppressed`) | 0 | no → `REF_MISSING` |

**Only exact resolutions and geometry-identical repairs are used without confirmation**
(recommendation 8). Every other non-exact outcome **fails the feature** with its code and ranked
candidates; the feature passes its input through (§7.1) and the repair is an explicit edit (§5.9).
Broad members never fall back geometrically.

**Step 5 — Broad members and cardinality.** Compare the broad members of the result with the
captured broad members; any difference is warning `REF_SET_CHANGED` `{ "added", "removed" }`, and the
query's current result is used (the query is the intent: `slab.sides().edges().parallel(Z)` means
"all vertical side edges", including new ones). Then check `card` on the final set (§5.5).

**Outcome.** The reference's status is `exact` (no report entries), `accepted` (warnings or infos
only) or `failed`. A feature with any failed reference fails with the code of its first failed
reference in field order, and its details list every failed reference (§5.8).

### 5.8 What is reported [D-31]

Every feature report has `refs`: one entry per Ref-valued field, in field order.

```json
{ "field": "/edges", "status": "failed", "code": "REF_UNCERTAIN",
  "members": [
    { "key": "e1/edge:{e1/side:bottom|e1/side:left}@bottom.start", "name": "slab/edge:{slab/side:bottom|slab/side:left}",
      "via": "broad", "status": "exact", "probe": { "kind": "edge", "point": [-40, -25, 4] } } ],
  "unresolved": [
    { "key": "e1/side:top", "name": "slab/side:top", "reason": "name-not-found",
      "candidates": [
        { "key": "e1/side:top_a", "name": "slab/side:top_a", "confidence": 0.7, "reason": "split-piece",
          "probe": { "kind": "face", "point": [-20, 25, 4], "normal": [0, 1, 0] },
          "query": { "op": "side", "feature": "e1", "curve": "top_a" } } ] } ],
  "added": [], "removed": [],
  "proposal": null }
```

- `members`: the resolved set, with display `name`, `via`, per-member status and a **probe**
  (§7.6) that locates the entity for UIs, renders and the oracle replay.
- `unresolved`: per failed member, the reason (`name-not-found`, `faces-no-longer-meet`,
  `split`, `split-piece`, `tie`, `no-plausible-match`, `feature-suppressed`) and up to
  `MAX_CANDIDATES` candidates, best first, each with confidence, probe and — SHOULD — a `query` that
  selects exactly that candidate. Engines synthesise it by trying, in order: a named source; a
  `between` of two named sources; an `edge_at`; the original query narrowed by `extreme` along the
  world axis that best separates the candidate.
- `proposal`: for `REF_REPAIRED` and `REF_SET_CHANGED`, the rewritten reference (query and fresh
  capture) the command layer can apply with one op.
- Warnings and infos of §5.7 are also listed in the feature's `warnings` (§7.3), so tools that only
  read warnings see them.

### 5.9 Repairs and renames (command layer) [D-32]

| Op | Effect |
|---|---|
| `acceptRefCandidate(featureId, field, memberKey, candidateKey)` | replaces the reference's query by the candidate's `query` (the op fails if there is none) and refreshes the capture |
| `acceptRefProposal(featureId, field)` | applies `proposal` |
| `captureRef(featureId, field)` | refreshes the capture from the current resolution (§0.6) |
| `renameCurve(sketchId, old, new)` | renames the curve and, in the same op, rewrites every query field naming it (`side.curve`, `edge_at.curve`, `member`, `regions`, hole `points`), every constraint argument and every capture key; direction and geometry are untouched (recommendation 7) |
| `renameFeature(featureId, newName)` | changes the name only; nothing else needs rewriting because references use ids |

Curve renames made **in CadScript text** are caught statically: `slab.side("oldId")` after the
sketch renamed the curve is `QUERY_UNKNOWN_CURVE`. When the compiler (with `base`) sees exactly one
disappeared and one new curve with identical geometry in the same sketch, it reports
`CS_RENAME_DETECTED` with a fix that rewrites the queries, which is what `renameCurve` does. Renames
therefore resolve **exactly**, never through a 0.99 geometric match. The CadScript printer preserves
curve ids and directions.

### 5.10 CadScript v1 surface [D-33]

Queries are method chains on feature handles. The compiler maps each call to one AST node, and the
printer prints each node back as the same call, so the mapping is a bijection.

| CadScript | AST |
|---|---|
| `slab.cap("end")`, `slab.cap("end", { body: "d1_left" })` | `cap` (`member` from `body`) |
| `bowl.endcap("start")` | `endcap` |
| `slab.side("bottom")` (also `faceOf(slab, "bottom")`, printed as `slab.side(…)`) | `side` |
| `slab.sides()`, `slab.sides({ body: "d1_left" })` | `sides` |
| `slab.edgeAt("bow", "end")` | `edge_at` |
| `slab.body()`, `slab.body("d1_left")` (also `body(slab, "d1_left")`) | `body` |
| `bodies()` | `bodies` |
| `slab.faces()` | `created` |
| `mounts.wall("ne")`, `.tip(…)`, `.floor(…)`, `.cboreWall(…)`, `.cboreFloor(…)`, `.csink(…)` | `hole_face` |
| `holes.instance(2)`, `grid.instance(1, 3)` | `instance` |
| `edgesBetween(a, b)` | `between` |
| `q.faces()`, `q.edges()`, `q.vertices()`, `q.owner()` | navigation |
| `q.and(r)`, `q.common(r)`, `q.minus(r)` | `union`, `intersect`, `minus` |
| `q.planes()`, `.cylinders()`, `.cones()`, `.spheres()`, `.tori()`, `.lines()`, `.circles()`, `.ofType("bspline")` | `filter` `type` |
| `q.normal("+Z")`, `q.parallel(Z)`, `q.perpendicular(X)` | `filter` `normal`/`parallel`/`perpendicular` |
| `q.convex()`, `q.concave()`, `q.smooth()` | `filter` `convex`/`concave`/`smooth` |
| `q.radius(2)`, `q.radius({ min: 1, max: 3 })` | `filter` `radius` |
| `q.max("+Z")`, `q.min("+X")` | `extreme` |
| `q.largest()`, `q.smallest()` | `largest`, `smallest` |
| `q.one()`, `q.some()`, `q.any()`, `q.exactly(4)` | the Ref's `card` (the last call of the chain) |

- **Directions.** `X`, `Y`, `Z` are unsigned axis constants; signed directions are the strings
  `"+X"` … `"-Z"`; a `[x, y, z]` literal is a vector. (`+Z` is not used: TypeScript types unary plus
  on an object as a number.)
- **Arguments** of `radius`, `cap(…, { body })` etc. are Scalars and may use parameters.
- A handle used where a body set is expected (`targets: slab`) means `slab.body()`.
- Curve ids in `side`, `edgeAt`, `body` and `cap(…, { body })` are string literals, checked
  against the consumed sketch at compile time (`QUERY_UNKNOWN_CURVE`).
- Tags: `const top = tag(slab.cap("end"))`; the handle `top` is then a query (`tagged`).

### 5.11 Examples

```ts
const corners  = fillet(slab.sides().edges().parallel(Z), { r: 4 });
const rootRing = fillet(edgesBetween(boss.side("ring"), slab.cap("end")), { r: 2 });
const topFace  = slab.faces().planes().max("+Z").one();
const dEdge    = coupler.edgeAt("bow", "end");            // one of the two edges of a "D"
```

```json
{ "type": "fillet", "id": "f1", "name": "corners", "r": 4,
  "edges": { "kind": "edge",
             "q": { "op": "filter", "where": { "parallel": "Z" },
                    "of": { "op": "edges", "of": { "op": "sides", "feature": "e1" } } } } }

{ "type": "fillet", "id": "f2", "name": "rootRing", "r": 2,
  "edges": { "kind": "edge",
             "q": { "op": "between",
                    "a": { "op": "side", "feature": "e2", "curve": "ring" },
                    "b": { "op": "cap", "feature": "e1", "end": "end" } } } }
```

### 5.12 How the nine naming recommendations are met

| # | Recommendation (BACKLOG) | Where |
|---|---|---|
| 1 | Never store `#k`; write the position (`edgeAt(bow.end)`) | §5.2 rules 3 and 6 (junction qualifier `@c.end`, display-only indices), `edge_at` in §5.3 |
| 2 | Body identity by one of its curves; body identity in cap names | origin member §5.2 rule 4, `body`/`cap` `member`, `regions` by member (§4.5) |
| 3 | References are sets with a declared count | `card` (§5.5), split handling (§5.7 step 3) |
| 4 | Flag a reference whose surface type changed | `REF_KIND_CHANGED`, field-level type checks (`PLANE_NOT_PLANAR`, …) |
| 5 | Store both face references with every edge reference | capture `faces` (§5.6), `between` named source, `faces-no-longer-meet` (§5.7 step 4) |
| 6 | Key references by feature id | §0.3 rule 2, keys §5.2 rule 1 |
| 7 | Renames are explicit edits with id maps; printer preserves ids and directions | §5.9 |
| 8 | Auto-accept only identical geometry | §5.7 step 4 and the rule after it |
| 9 | Write the naming conventions into the SPEC | §5.2 rule 3 |

## 6. Features

### 6.0 Rules shared by all features

#### 6.0.1 Common fields [D-34]

`id`, `name`, `type`, `v` (default 1), `suppressed` (default false). The metadata fields `note`,
`intent`, `author`, `assumptions` (list of strings) and `decision_ids` (list of strings) are **not
semantic**: engines ignore them, they are not part of cache keys, and changing them never changes a
report.

#### 6.0.2 Targets [D-35]

A body operation (`op` other than `new_body`, `boolean`, `hole`, a `pattern` with an op) has
`targets`: `"all"` (every body in scope) or a Ref of kind `body` (default card `some`). For
`extrude` and `revolve` with `op ≠ new_body` the field is **required** (`BOOLEAN_TARGETS_REQUIRED`,
rejected): target selection is explicit. [W0-10] `targets` with `op: new_body` is `INVALID_VALUE`
(almost always a forgotten `op`).

#### 6.0.3 Boolean semantics [D-36]

Let **T** be the resolved target bodies and **K** the operation's tool bodies. Bodies in scope that
are not targets are untouched. All results are regularized closed solids.

| `op` | Result | Failure |
|---|---|---|
| `join` | the union of T and K; the result bodies are its connected components | a tool that neither overlaps nor shares a face of positive area with any target: `BOOLEAN_NO_INTERSECTION`, details `{ "tool", "min_distance" }` (a detached boss is almost always a direction mistake) |
| `cut` | T minus the union of K | no tool meets the interior of any target: `BOOLEAN_NO_INTERSECTION` |
| `intersect` | each target intersected with the union of K; targets whose intersection is empty disappear | all targets empty: `BOOLEAN_EMPTY_RESULT` |

- A result that touches itself only along an edge or at a vertex (non-manifold) fails with
  `BOOLEAN_NON_MANIFOLD`, details `{ "probe" }`.
- **Identity.** Each result body inherits the **origin** (§5.2 rule 4) of the target it comes from.
  A join component containing several targets takes the origin that sorts first (timeline index,
  then member); the others are reported as `merged_into`. Tools never give their origin to a result
  unless the operation creates new bodies.
- **Split.** A target cut into several pieces yields several bodies with the same origin (info
  `BOOLEAN_SPLIT`, `{ "origin", "pieces" }`). References to the body see every piece (§5.5).
- **Consumed.** A target removed entirely (cut, or an empty intersect) is not an error: warning
  `BOOLEAN_BODY_CONSUMED`, `{ "origin" }`.

#### 6.0.4 Same-domain merging [D-37]

After every body operation, adjacent faces of a result body that lie on the **same carrier surface
with the same orientation** are merged into one face, and edges that then lie on one carrier curve
and meet at a vertex shared by no other edge are merged into one edge. Keys follow §5.2 rule 3.
Faces on different carriers are never merged, even when tangent (v0 §4.4). This makes a boss flush
with a plate side one face, as users expect, and matches OCCT's `ShapeUpgrade_UnifySameDomain`,
which the oracle applies (§8.3).

#### 6.0.5 Reporting bodies [D-38]

A feature's `bodies` lists the result bodies it **created or modified**, each with `origin` and
`change` (`created`/`modified`), in canonical order (§5.4); `removed` lists the origins it consumed.
The document-level `parts[].bodies` lists every body at the end of each part's timeline (§7.2).

### 6.1 `sketch`

See §4. Ref fields: `plane.face` (face, `one`).

### 6.2 `extrude` [D-39]

| Field | Type | Default | Notes |
|---|---|---|---|
| `sketch` | feature id | — | an earlier sketch of the same part (`UNRESOLVED_SKETCH`) |
| `regions` | `"all"` or curve ids | `"all"` | §4.5 |
| `distance` | length | — | > tol (`INVALID_DISTANCE`) |
| `direction` | `normal`/`reverse`/`symmetric` | `normal` | v0 §4.2 |
| `op` | `new_body`/`join`/`cut`/`intersect` | `new_body` | |
| `targets` | `"all"` or Ref (body, `some`) | — | required when `op ≠ new_body` |

Tools: one body per selected region, swept as in v0 §4.2 and named per §5.2. With `new_body` they
are the result (v0 behaviour). Otherwise §6.0.3 applies.

```json
{ "type": "extrude", "id": "e2", "name": "boss", "sketch": "s2", "distance": 12, "op": "join",
  "targets": { "kind": "body", "q": { "op": "body", "feature": "e1" } } }
{ "type": "extrude", "id": "e3", "name": "pocket", "sketch": "s3", "distance": 3,
  "direction": "reverse", "op": "cut", "targets": "all" }
```
```ts
const bossSk = sketch(slab.cap("end"), { ring: circle({ center: [0, 0], radius: 11 }) });
const boss   = extrude(bossSk, { distance: 12, op: "join", targets: slab });
const pocket = extrude(pocketSk, { distance: 3, direction: "reverse", op: "cut", targets: "all" });
```

### 6.3 `revolve` [D-40]

v0 §4.3 plus the `regions`, `op` and `targets` fields of §6.2 with the same meaning. The axis stays
in sketch coordinates.

```json
{ "type": "revolve", "id": "r1", "name": "groove", "sketch": "s4",
  "axis": { "origin": [0, 0], "direction": [0, 1] }, "angle": 360,
  "op": "cut", "targets": { "kind": "body", "q": { "op": "body", "feature": "r0" } } }
```
```ts
const groove = revolve(grooveSk, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360, op: "cut", targets: pulley });
```

### 6.4 `boolean` [D-41]

| Field | Type | Default |
|---|---|---|
| `op` | `join`/`cut`/`intersect` | — |
| `targets` | Ref (body, `some`) | — |
| `tools` | Ref (body, `some`) | — |
| `keep_tools` | bool | `false` |

A body in both sets is `BOOLEAN_TOOL_IS_TARGET` (evaluation error). Tools are consumed unless
`keep_tools`. §6.0.3 applies; kept tools keep their origin.

```json
{ "type": "boolean", "id": "b1", "name": "merged", "op": "join",
  "targets": { "kind": "body", "q": { "op": "body", "feature": "e1" } },
  "tools":   { "kind": "body", "q": { "op": "body", "feature": "e5" } } }
```
```ts
const merged = boolean("join", { targets: floor, tools: walls });
```

### 6.5 `hole` [D-42]

| Field | Type | Default | Notes |
|---|---|---|---|
| `on` | PlaneRef | — | usually `{ "face": Ref }` (face, `one`); the placement plane |
| `flip` | bool | false | the drilling direction is `d = −n` (into the material under a face with outward normal `n`); `flip` reverses it |
| `at` | placement (below) | — | position ids name the instances |
| `size` | `"M2"`, `"M2.5"`, `"M3"`, `"M4"`, `"M5"`, `"M6"`, `"M8"` | — | `HOLE_SIZE_UNKNOWN` otherwise |
| `fit` | `close`/`normal`/`loose`/`tap` | `normal` | picks the diameter from the table |
| `d` | length | from `size` + `fit` | overrides the table; one of `d` and `size` is required (`HOLE_SIZE_REQUIRED`) |
| `depth` | `"through"`, `{ "blind": length }`, `{ "up_to": Ref }` (face, `one`) | — | required, except with `insert`, whose preset sets a blind depth (`HOLE_DEPTH_REQUIRED`) |
| `tip` | angle or `"flat"` | 118 | blind holes only |
| `cbore` | `"iso4762"` or `{ "d", "depth" }` | — | counterbore |
| `csink` | `"iso10642"` or `{ "d", "angle" (default 90) }` | — | countersink |
| `insert` | `"std"` or `{ "d", "depth" }` | — | heat-set insert hole (flat floor) |
| `thread` | `true` or `{ "pitch"?, "depth"? }` | — | cosmetic thread; with `size`, the default diameter becomes the tap drill |
| `targets` | `"all"` or Ref (body, `some`) | the body owning the `on` face | required when `on` is not a face |

At most one of `cbore`, `csink`, `insert`; `thread` excludes `insert`; the presets need `size`.
Violations are `HOLE_OPTIONS_CONFLICT` (rejected).

**Placement `at`** (exactly one form):

| Form | Positions and ids |
|---|---|
| `{ "points": { "sketch": "<id>", "ids": [...] \| "all" } }` | sketch points (`point` curves, or `<circle>.center`) mapped to 3D and projected along `n` onto the placement plane; ids are the point ids |
| `{ "list": [{ "id": "ne", "at": P2 }, …] }` | (u, v) in the placement plane's frame (§3.1) |
| `{ "grid": { "nx", "ny", "dx", "dy", "center": P2 = [0, 0] } }` | id `g<i>_<j>` at `center + ((i − (nx−1)/2)·dx, (j − (ny−1)/2)·dy)`, i < nx, j < ny |
| `{ "circle": { "n", "d", "center": P2 = [0, 0], "start": angle = 0 } }` | id `c<k>` at `center + (d/2)·(cos θ_k, sin θ_k)`, `θ_k = start + (360·k)/n` (a bolt circle) |

Positions closer than tol to each other fail with `HOLE_DUPLICATE_POSITION`. When `on` is a face,
every position must lie on that face (inside or on its boundary within tol), else
`HOLE_POINT_OFF_FACE`, `{ "at", "distance" }`.

**Geometry** at position `P` with direction `d`, hole diameter `D` (normative):
- `through`: a cylinder of diameter `D` from `P` along `d`, long enough to leave every target.
- `blind: h`: a cylinder from `P` to `P + h·d` (depth is measured to the shoulder), then a cone of
  apex angle `tip` whose apex is at `P + (h + (D/2) / tan(tip/2))·d`; `"flat"` gives a flat floor.
- `up_to: face`: `h` = the distance along `d` from `P` to the first point of the face (≥ tol), then as
  `blind` with a flat floor; no hit is `HOLE_UP_TO_MISSED`.
- `cbore`: a cylinder of diameter `Dc > D` from `P` to depth `hc` (`hc` < the hole depth for blind
  holes). `csink`: a cone with diameter `Dk > D` at `P` and included angle `β`, down to diameter
  `D`. `insert`: a blind flat-floored hole of the insert's diameter and depth. Violations are
  `INVALID_VALUE`.
- The tools of all positions form one `cut` of the targets (§6.0.3). A position whose tool meets no
  target is `HOLE_MISSES_BODY`, `{ "at" }`. A blind hole that breaks through is warning
  `HOLE_BREAKS_THROUGH`, `{ "at" }`.
- `thread` changes no geometry: the report records `{ "size", "pitch", "depth" }` on the instance
  and the wall face `H/wall@p` carries the thread attribute for drawings and export.

**Standard sizes** (normative table `HOLE_SIZES` in `schema/ir-v1.constants.json`, values in mm,
**verified 2026-09-23** against at least two independent published tables per family; ADR 0013
decision 1). The constants file carries every value's sources and notes, and the list of values
left out; the Rust table is `forge_ir::v1::holes`.

| Family | Rule | Sources |
|---|---|---|
| pitch | ISO 261/262 coarse | ISO 2306:1972 Table 1; ISO metric thread tables |
| `tap` | ISO 2306 tap drill (the default diameter of `thread`) | ISO 2306:1972; Fractory tap drill chart |
| `close` / `normal` / `loose` | ISO 273 fine / medium / coarse clearance | ISO 273:1979 Table 1; Engineering Hardware |
| cbore d, depth (`iso4762`) | DIN 974-1 row 1 (ISO 4762 without washer); depth = the published counterbore depth (k + 0.4 for M3–M6, k + 0.6 for M8) | Ifanger DIN 974-1 table; ingenieurkurse.de; neue-physik.de; schraube-mutter.de; engineersbible.com |
| csink d (`iso10642`, 90°) | DIN 74:2003 Form F, the countersink written for ISO 10642 heads (always wider than the ISO 10642 head's theoretical dk) | Ifanger DIN 74 table; SMW Schrauben datasheet |
| insert d, depth (`std`) | the common tapered brass heat-set insert, standard length; bore per the makers' datasheets; depth = insert length + 1 (both makers' minimum) | ruthex; CNC Kitchen |

| Size | Pitch | `tap` | `close` | `normal` | `loose` | cbore d | cbore depth | csink d | insert d | insert depth |
|---|---|---|---|---|---|---|---|---|---|---|
| M2 | 0.4 | 1.6 | 2.2 | 2.4 | 2.6 | 4.4 | — | — | 3.2 | 5.0 |
| M2.5 | 0.45 | 2.05 | 2.7 | 2.9 | 3.1 | 5.5 | 3.0 | — | 4.0 | 6.7 |
| M3 | 0.5 | 2.5 | 3.2 | 3.4 | 3.6 | 6.5 | 3.4 | 6.94 | 4.0 | 6.7 |
| M4 | 0.7 | 3.3 | 4.3 | 4.5 | 4.8 | 8.0 | 4.4 | 9.18 | 5.6 | 9.1 |
| M5 | 0.8 | 4.2 | 5.3 | 5.5 | 5.8 | 10.0 | 5.4 | 11.47 | 6.4 | 10.5 |
| M6 | 1.0 | 5.0 | 6.4 | 6.6 | 7.0 | 11.0 | 6.4 | 13.71 | 8.0 | 13.7 |
| M8 | 1.25 | 6.8 | 8.4 | 9.0 | 10.0 | 15.0 | 8.6 | 18.25 | 9.6 | 13.7 |

Changes from the earlier draft table, all from the sources: counterbore diameters M2–M3 (4.3 /
5.0 / 6.0 are SN 213.183 / GB/T values, not DIN 974-1); every counterbore depth (the draft's
"head height + 0.2" appears in no table); every countersink diameter (the draft's 4.4 … 17.3 are
ISO 15065 values for ISO 7721 heads and are **smaller** than the ISO 10642 head: a screw would
stand proud); the M2.5 insert bore (3.6 is in no maker table; both makers use 4.0) and the M2,
M2.5 and M8 insert data. **Left out** (—, no two agreeing sources): M2 counterbore depth (2.1 /
2.2 / 2.3 published), M2 and M2.5 countersinks (ISO 10642:2019 added these sizes, but the
DIN 74:2020 Form F values could not be obtained). A preset that needs a missing value is
rejected for that size with `HOLE_OPTIONS_CONFLICT` (details `allowed`: the sizes that have it).
Where makers disagree the table records both in a note: M2 and M2.5 insert lengths (ruthex 4.0 /
5.7 vs CNC Kitchen 3.0 / 4.0 — the deeper hole is chosen because it seats either insert), M4–M8
insert bores (CNC Kitchen's current table is 0.1 mm larger; ruthex and older CNC Kitchen data are
the majority), M2.5 tap 2.05 (some tables round to 2.1), M8 tap 6.8 (Optimas lists 6.75). **FDM
compensation is not in this table**: it is a process-profile setting, so the IR keeps nominal
geometry (ADR 0013 decision 1). Changing a value is a hole `v` bump.

[W0-10] Resolved hole rules (all rejections unless noted):
- `tip` other than the default 118 on a hole that is not `{ "blind" }` is `HOLE_OPTIONS_CONFLICT`
  (`tip` is meaningless for through, `up_to` and insert holes). The keyword `"flat"` wins over an
  expression that would name a parameter `flat`.
- `depth` together with `insert` is `HOLE_OPTIONS_CONFLICT` (the insert sets its blind depth).
- `thread` with `fit` `close` or `loose` is `HOLE_OPTIONS_CONFLICT` (a threaded hole uses the tap
  drill); `thread` without `size` needs an explicit `pitch` (`HOLE_OPTIONS_CONFLICT`); `thread:
  false` means no thread (omitted in canonical JSON).
- The diameter `D` is `d` if given, else the insert bore for `insert`, else the tap drill when
  threaded or `fit: tap`, else the ISO 273 series of `fit` (`forge_ir::v1::holes::tool_dims`;
  golden cases `corpus/v1/conformance/holes/tools.json`).
- `on` that is not a face needs `targets` (`BOOLEAN_TARGETS_REQUIRED`). Position ids follow the id
  grammar and are unique within the hole (`DUPLICATE_ID`); `list` and `points.ids` are non-empty
  (`INVALID_VALUE`); `points.ids` name `point` curves or `<circle>.center` of that sketch
  (`QUERY_UNKNOWN_CURVE`), and `"all"` means every `point` curve in curve order; grid `nx`, `ny`
  and bolt-circle `n` are counts ≥ 1 (`INVALID_COUNT`).
- Literal sizes: `d`, blind depth, custom counterbore/insert `d` and `depth`, thread `pitch` and
  `depth`, bolt-circle `d` are > tol; `tip` and custom countersink `angle` are in (0, 180)
  (`INVALID_VALUE`).

**Report**: `holes: [{ "at", "center": P3, "axis": P3 (= d), "d", "depth" (number, or null for
through), "kind" ("simple", "counterbore", "countersink", "insert"), "size"?, "cbore"?, "csink"?,
"thread"? }]`, in position order.

```json
{ "type": "hole", "id": "h1", "name": "mounts",
  "on": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } },
  "at": { "grid": { "nx": 2, "ny": 2, "dx": "width - 12", "dy": "depth - 12" } },
  "size": "M5", "depth": "through", "cbore": "iso4762" }
{ "type": "hole", "id": "h2", "name": "inserts",
  "on": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e2", "end": "end" } } },
  "at": { "points": { "sketch": "s2", "ids": ["p1", "p2"] } }, "size": "M3", "insert": "std" }
```
```ts
const mounts  = hole(slab.cap("end"), { at: grid({ nx: 2, ny: 2, dx: width - 12, dy: depth - 12 }),
                                        size: "M5", depth: "through", cbore: "iso4762" });
const bolts   = hole(flange.cap("end"), { at: boltCircle({ n: 4, d: 50 }), size: "M4", fit: "close", depth: "through" });
const pilots  = hole(plate.cap("end"), { at: { a: [15.5, 15.5], b: [-15.5, 15.5] }, d: 3.4, depth: { blind: 6 } });
const inserts = hole(boss.cap("end"), { at: bossSk.points("p1", "p2"), size: "M3", insert: "std" });
```

### 6.6 `fillet` [D-43]

| Field | Type | Default |
|---|---|---|
| `edges` | Ref (edge, `some`) | — |
| `r` | length > tol (`INVALID_RADIUS`) | — |
| `tangent_chain` | bool | `true` |

- **Chain expansion.** With `tangent_chain`, the engine repeatedly adds every edge that shares a
  vertex with an edge of the set, whose tangent at that vertex is within `TANGENT_CHAIN_TOLERANCE`
  of the set edge's tangent, and whose convexity (§5.3) is the same. Added edges are reported in
  `fillet.chain_added` (keys); they are not part of the reference.
- **Blend.** Each edge is replaced by a constant-radius rolling-ball blend of radius `r` tangent to
  both adjacent faces. Normative blend surface types: plane–plane line edge → `cylinder`;
  plane–cylinder circular edge with the plane perpendicular to the cylinder axis → `torus`;
  plane–cone circular edge likewise → `torus`; cylinder–cylinder coaxial → `torus`. At a vertex
  where three convex edges between mutually perpendicular planes are all filleted with the same
  `r`, the corner patch is a `sphere` of radius `r`. Other corner patches are engine-defined (§8.3
  rule 5).
- **Supported edges** (v1): edges between two faces of one body, each face a plane, cylinder, cone,
  sphere or torus, the edge not `smooth`. Otherwise `FILLET_EDGE_UNSUPPORTED`, details
  `{ "edges": [{ "key", "name", "reason" }] }` with reason `smooth`, `surface-type` or
  `boundary`.
- **Atomic.** If any edge cannot be blended, the whole feature fails and passes its input through.
  `FILLET_RADIUS_TOO_LARGE`, details `{ "r", "max_feasible_r", "edges": [{ "key", "name", "max_r",
  "limit": "face-width" | "adjacent-blend" | "curvature", "face"? }] }`: `max_r` is the largest
  radius that edge accepts in the context of the whole set, computed analytically where possible
  (e.g. the width of the narrowest adjacent planar face across the edge) and otherwise by bisection
  to 1e-3 relative; values are **rounded down** to a multiple of 0.001 mm so that a suggested value
  is safe to apply; `max_feasible_r` is the minimum over the failing edges. Any other failure is
  `FILLET_FAILED`, `{ "edges", "reason" }`.
- Report: `fillet: { "edges", "chain_added", "faces_created" }`.

```json
{ "type": "fillet", "id": "f1", "name": "corners", "r": 4,
  "edges": { "kind": "edge", "q": { "op": "filter", "where": { "parallel": "Z" },
             "of": { "op": "edges", "of": { "op": "sides", "feature": "e1" } } } } }
```
```ts
const corners = fillet(slab.sides().edges().parallel(Z), { r: 4 });
```
Diagnostic as the agent sees it (§7.4): `error FILLET_RADIUS_TOO_LARGE "corners": 1/4 edges
failed: max feasible r = 3.41 (face width 6.82 at slab/side:right)`.

### 6.7 `chamfer` [D-44]

| Field | Type | Default |
|---|---|---|
| `edges` | Ref (edge, `some`) | — |
| `d` | length > tol | — |
| `d2` | length > tol | — (two-distance form) |
| `angle` | angle in (0, 90) | — (distance–angle form) |
| `side` | Ref (face, `one`) | — (the face `d` is measured on; required with `d2` or `angle`) |
| `tangent_chain` | bool | `true` |

Exactly one of the forms `{ d }`, `{ d, d2, side }`, `{ d, angle, side }` (`CHAMFER_OPTIONS_CONFLICT`,
rejected). `side` must be adjacent to every chamfered edge (`CHAMFER_SIDE_NOT_ADJACENT`). The bevel
of a line edge between two planes is a `plane`; of a circular edge between a plane and a coaxial
cylinder or cone, a `cone`. Chain expansion, supported edges, atomicity and reporting as for fillet,
with `CHAMFER_DISTANCE_TOO_LARGE` (`{ "d", "max_feasible_d", "edges": [{ "key", "name", "max_d" }] }`),
`CHAMFER_EDGE_UNSUPPORTED` and `CHAMFER_FAILED`.

```json
{ "type": "chamfer", "id": "c1", "name": "topEdge", "d": 2,
  "edges": { "kind": "edge", "q": { "op": "edges", "of": { "op": "cap", "feature": "r1", "end": "end" } } } }
```
```ts
const topEdge = chamfer(knob.cap("end").edges(), { d: 2 });
```

### 6.8 `shell` [D-45]

| Field | Type | Default |
|---|---|---|
| `body` | Ref (body, `one`) | — |
| `open` | Ref (face, `any`) | none |
| `thickness` | length > tol | — |
| `direction` | `inward`/`outward` | `inward` |

Every face of the body that is not open is offset by `thickness` (toward the interior for `inward`,
away from it for `outward`); open faces are removed; rim faces close the wall where open faces were.
Offset faces meet by **intersection** (sharp joins, like OCCT's `GeomAbs_Intersection`). The offset
of a cylinder, cone, sphere or torus is the concentric surface of the same type. Open faces must
belong to `body` (`SHELL_FACE_NOT_ON_BODY`). With no open face the body gets an internal void (info
`SHELL_CLOSED_VOID`; the body metrics count 2 shells). `SHELL_THICKNESS_TOO_LARGE`, details
`{ "thickness", "max_feasible_thickness"?, "limits": [{ "key", "name", "reason": "curvature" |
"gap" }] }`, when an offset surface degenerates (radius ≤ 0) or opposite walls collide;
`SHELL_FAILED` otherwise. Report: `shell: { "removed_faces" }`.

```json
{ "type": "shell", "id": "sh1", "name": "hollow", "thickness": 2,
  "body": { "kind": "body", "q": { "op": "body", "feature": "e1" } },
  "open": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } }
```
```ts
const hollow = shell(box, { open: box.cap("end"), thickness: 2 });
```

### 6.9 `draft` (optional in v1) [D-46]

Engines that do not implement draft reject it with `UNSUPPORTED_FEATURE`; the MakerBench `requires`
token is `op/draft`.

| Field | Type | Default |
|---|---|---|
| `faces` | Ref (face, `some`) | — |
| `neutral` | PlaneRef | — |
| `angle` | angle in (0, 45) | — |
| `pull` | `normal`/`reverse` | `normal` |

The pull direction `p` is the neutral plane's normal (reversed for `reverse`). Each face must be
planar with outward normal `n` perpendicular to `p` within `QUERY_ANGLE_TOLERANCE`
(`DRAFT_FACE_UNSUPPORTED`). It is replaced by the plane through the line where it meets the neutral
plane, with normal `cos(angle)·n + sin(angle)·p`, so the part tapers inward along `+p`; adjacent
faces are extended or trimmed. Failures: `DRAFT_FAILED`. Drafted faces keep their keys.

```ts
const tapered = draft(cup.sides(), { neutral: XY, angle: 2 });
```

### 6.10 `pattern` [D-47]

| Field | Type | Default |
|---|---|---|
| `seed` | `{ "features": [feature ids] }` or `{ "bodies": Ref }` (body, `some`) | — |
| `layout` | `{ "linear": … }`, `{ "circular": … }` or `{ "mirror": … }` | — |
| `skip` | list of instance indices (`[i]` or `[i, j]`) | `[]` |
| `op`, `targets` | body seeds only: `new_body` (default) or `join` with targets | |

| Layout | Fields | Instances |
|---|---|---|
| `linear` | `dir` (Dir or AxisRef), `count` (≥ 1), `spacing` (length, `\|spacing\| > tol`), optional `dir2`, `count2` (≥ 1), `spacing2` | `(i, j)` for `i < count`, `j < count2` (default 1), translated by `i·spacing·u1 + j·spacing2·u2`; `(0, 0)` is the seed and is not re-created |
| `circular` | `axis` (AxisRef), `count` (≥ 2), `angle` (in (0, 360], default 360) | `k = 1 … count−1`, rotated by `k·Δ` about the axis (right-hand rule), `Δ = 360/count` when `angle = 360`, else `angle/(count − 1)` |
| `mirror` | `plane` (PlaneRef) | one instance, index 1: the reflection |

**Feature seeds** must be `extrude`, `revolve` (any `op`) or `hole` features of the same part
(`PATTERN_SEED_UNSUPPORTED`, rejected); a failed or suppressed seed gives `DEPENDENCY_FAILED` /
`DEPENDENCY_SUPPRESSED`. For each seed (in timeline order) the pattern takes the seed's **tool
bodies** as evaluated at the seed, transforms a copy for every instance (in instance order), and
applies the seed's operation once with all instance tools together: `new_body` seeds create new
bodies (origin: the pattern id, the seed's member and the instance, §5.2); body-op and hole seeds
apply their op to the seed's targets **re-resolved in the pattern's scope**. An instance whose tool
meets no target is skipped with warning `PATTERN_INSTANCE_SKIPPED`, `{ "index", "code" }`; if every
instance is skipped the pattern fails with `PATTERN_ALL_INSTANCES_FAILED`.

**Body seeds** are copied from the current state; with `op: join` the copies are joined to
`targets` (§6.0.3).

Report: `pattern: { "instances", "skipped": [indices] }` (`instances` = the non-seed instances the
layout defines, minus `skip`).

[W0-16] Resolved pattern rules (rejections): feature seeds are earlier features of the part
(`UNRESOLVED_FEATURE`) of type `extrude`, `revolve` or `hole` (`PATTERN_SEED_UNSUPPORTED`); the
seed list is non-empty (`INVALID_VALUE`). `op` and `targets` are for body seeds only
(`PATTERN_OPTIONS_CONFLICT`, new code); `op: join` needs `targets` (`BOOLEAN_TARGETS_REQUIRED`);
`targets` with `op: new_body` is `PATTERN_OPTIONS_CONFLICT`. `dir2` and `spacing2` come together,
and `count2` needs them (`PATTERN_OPTIONS_CONFLICT`); `count2` defaults to 1. Literal `count` ≥ 1
(linear) or ≥ 2 (circular) and `count2` ≥ 1 (`INVALID_COUNT`), `|spacing| > tol`
(`INVALID_VALUE`), circular `angle` in (0, 360] (`INVALID_ANGLE`). Each `skip` entry has the
layout's arity (`[i]`, or `[i, j]` with `dir2`), is not the seed (`[0]`, `[0, 0]`) and, with
literal counts, is in range (`INVALID_VALUE`).

```json
{ "type": "pattern", "id": "pt1", "name": "bossRow", "seed": { "features": ["e2", "h2"] },
  "layout": { "linear": { "dir": "X", "count": "holes", "spacing": 20 } } }
{ "type": "pattern", "id": "pt2", "name": "slots", "seed": { "features": ["e4"] },
  "layout": { "circular": { "axis": "Z", "count": 6 } } }
{ "type": "pattern", "id": "pt3", "name": "otherArm", "seed": { "features": ["e6"] },
  "layout": { "mirror": { "plane": "YZ" } } }
```
```ts
const bossRow  = linearPattern([boss, inserts], { dir: X, count: holes, spacing: 20 });
const slots    = circularPattern([slotCut], { axis: Z, count: 6 });
const otherArm = mirror([arm], { plane: YZ });
const copies   = linearPattern(spacer.body(), { dir: X, count: 4, spacing: 15 });   // body seed
```

### 6.11 `datum_plane`, `datum_axis`

See §3.3 and §3.4.

### 6.12 `tag` [D-48]

`{ "type": "tag", "id", "name", "target": Ref }` produces no geometry. It resolves `target` at its
own position (so a broken tag shows up there), and every later `{ "op": "tagged", "feature": "<tag
id>" }` re-evaluates the tag's query, with the tag's capture, in the scope of the feature that uses
it. A tag is a stable, named handle for a selection (the agent's "mount_face").

```ts
const mountFace = tag(slab.faces().planes().normal("-Z").one());
const inserts   = hole(mountFace, { at: { a: [10, 10], b: [-10, 10] }, size: "M3", insert: "std" });
```

## 7. Evaluation and report (`aicad.metrics/1`)

### 7.1 Timeline [D-49]

1. Evaluate the non-measured parameters (§2.8).
2. Evaluate each part's features in timeline order. Suppressed features are skipped and produce no
   entry (v0). For each feature the checks run in this order, and the first failure decides the
   code: `PARAM_FAILED` → `SKETCH_SUPPRESSED` / `DEPENDENCY_SUPPRESSED` / `DEPENDENCY_FAILED` for
   features referenced by id (sketch, datum, tag, pattern seed) → field expressions and range checks
   → references, in field order (§5.7) → the operation itself → the validity check of every
   produced body (`INVALID_RESULT`, v0 [R-12]).
3. A failed feature **passes its input through**: the part's bodies are exactly as before it. Later
   features still run, so one regeneration reports every error.
4. Measured parameters are evaluated right after their sketch.

### 7.2 Report shape [D-50]

```json
{
  "schema": "aicad.metrics/1", "engine": "forge 0.1.0", "document": "plate", "status": "error",
  "params": [
    { "name": "width", "scope": "doc", "unit": "mm", "value": 80 },
    { "name": "slot_len", "scope": "plate", "unit": "mm", "error": { "code": "PARAM_FAILED", "message": "…", "details": { … } } }
  ],
  "features": [
    { "part": "plate", "feature": "corners", "feature_id": "f1", "type": "fillet", "status": "error",
      "error": { "code": "FILLET_RADIUS_TOO_LARGE", "message": "1/4 edges failed: max feasible r = 3.41",
                 "details": { "r": 4, "max_feasible_r": 3.41, "edges": [ … ] } },
      "warnings": [],
      "refs": [ { "field": "/edges", "status": "exact", "members": [ … ] } ] }
  ],
  "parts": [ { "part": "plate", "bodies": [ { "origin": { "feature": "e1", "member": "outline.bottom" }, "volume": … } ] } ]
}
```

| Feature entry field | Present for | Content |
|---|---|---|
| `part`, `feature` (name), `feature_id`, `type`, `status` | all | |
| `error` | failed features | `{ "code", "message", "details" }` (§7.4) |
| `warnings` | all | `[{ "code", "severity": "info" \| "warning", "message", "details" }]` in the order raised |
| `regions` | sketch | v0 §4.1 |
| `sketch` | sketch | `{ "mode", "status", "dof", "solved", "dimensions" }` (§4.4) |
| `datum` | datum features | frame or axis |
| `bodies`, `removed` | body features | §6.0.5; body metrics are v0 §5 plus `origin`, `change` and `shells` |
| `refs` | features with Ref fields | §5.8 |
| `holes`, `fillet`, `chamfer`, `shell`, `pattern` | those features | the per-feature summaries of §6 |

- [W0-16] Frozen report details (I5, `schema/metrics-v1.schema.json`): the report also has
  `migration: { "renames": [{ "path", "kind", "from", "to" }] }` when a v0 input needed id
  rewrites (§9.1; `from` is untrusted data), and `error` (the first rejection, all of them in
  `details.errors`) for a rejected document. `parts[]` entries are `{ "part", "part_id",
  "bodies" }`; a body is `{ "origin": { "feature", "member", "instance"? }, "change"?, …v0 metrics,
  "shells" }` (`change` only in feature entries). The `sketch` block has `mode`, `solved` (always:
  the literal geometry the regions came from, compound members expanded) and `dimensions`;
  `status` (forge-solve's spelling) and `dof` in constrained mode only. Reference members carry a
  `status` (`exact`, `merged`, `neighborhood_changed`, `kind_changed`, `split`, `repaired`);
  unresolved `reason`s are the kebab-case list of §5.8; candidate `reason`s are `identical`,
  `split-piece`, `plausible` or `tie`. Hole instances: `depth` is `null` for through holes;
  `cbore`/`insert` are `{ "d", "depth" }`, `csink` `{ "d", "angle" }`, `thread` `{ "size"?,
  "pitch", "depth" }`. Fillet and chamfer: `{ "edges", "chain_added", "faces_created" }` (keys);
  shell: `{ "removed_faces", "closed_void"? }`.
- `status` is `ok` iff every parameter and every feature is ok. Warnings never change `status`,
  geometry or exit codes.
- `parts[].bodies` is the final state of each part, in canonical order (§5.4).
- The CLI keeps v0's exit codes: 0 ok, 1 a feature or parameter failed, 2 rejected.

### 7.3 Warnings [D-51]

`info` records something expected that a user may want to know (`SKETCH_UNDER_CONSTRAINED`,
`REF_REPAIRED`, `BOOLEAN_SPLIT`); `warning` records something that is probably unintended but
well-defined (`REF_SET_CHANGED`, `SKETCH_LOOP_FLIPPED`, `HOLE_BREAKS_THROUGH`). The agent's L1
verification (ARCHITECTURE §6) treats `warning`-severity codes on features it just edited as
failures to explain; `info` never blocks.

### 7.4 Error details [D-52]

Every error and warning carries `details`, a JSON object whose keys are listed per code in §7.5.
Details name entities by key and display name and locate them by probe, give values with units
(mm, deg), and give **feasible ranges** where the engine can compute them. They never contain arena
ids. The agent's playbooks read `details` instead of parsing `message` (today's playbooks regex the
v0 messages; v1 removes the need).

### 7.5 Error-code catalogue [D-53]

Stage: **R** rejected (exit 2), **E** evaluation error (the feature or parameter fails),
**W**/**I** warning/info, **R/E** rejected when every input is a literal and an evaluation error
when an expression is involved (§0.5). Codes of v0 keep their meaning and are not repeated unless
extended. [W0-13] The machine-readable catalogue — every code with its stage, section, detail keys
and `since` (`v0`, `v1`, `v1.1`) — is `ERROR_CODES` in `schema/ir-v1.constants.json`
(`forge_ir::v1::codes`); agent playbooks, the oracle and CadScript read it from there.

| Code | Stage | Raised when | `details` |
|---|---|---|---|
| `UNSUPPORTED_FEATURE` | R | unknown `type`, or an optional type the engine lacks (draft) | `type` |
| `UNSUPPORTED_FEATURE_VERSION` | R | `v` not implemented | `type`, `v`, `supported` |
| `INVALID_ID` | R | [W0-12] an id outside the id grammar, or a reference that is not 1–3 ids joined by `.` | `path`, `reason`, `length` |
| `CURVE_OPTIONS_CONFLICT` | R | [W0-6] rect `center`/`corner`, polygon size fields | `curve`, `fields` |
| `CONSTRAINT_VALUE_REQUIRED` | R | [W0-13] a driving dimension without `value` | `constraint` |
| `PATTERN_OPTIONS_CONFLICT` | R | [W0-16] §6.10 | `fields` |
| `DATUM_OPTIONS_CONFLICT` | R | [W0-8] §3.3, §3.4 | `mode`, `fields`, `missing`, `unexpected` |
| `UNRESOLVED_FEATURE` | R | a feature id that is not an earlier feature of the same part (or, for `datum` references, not a datum of the right kind) | `id`, `field`, `expected` |
| `EXPR_SYNTAX` | R | §2.3 ([W0-12]: `expr` is present only when the text lexes) | `expr`, `offset`, `expected` |
| `EXPR_UNKNOWN_NAME` | R | identifier is not a visible parameter | `name`, `is_feature`, `similar` |
| `EXPR_UNKNOWN_FUNCTION` | R | | `name`, `similar` |
| `EXPR_ARITY` | R | | `name`, `expected`, `found` |
| `EXPR_UNIT_MISMATCH` | R | §2.5 | `expr`, `subexpr`, `expected`, `found` (as `mm`, `deg`, `mm^2`, `1`, …) |
| `EXPR_TYPE_MISMATCH` | R | bool vs number | `expr`, `subexpr`, `expected`, `found` |
| `EXPR_SCOPE` | R | another part's parameter | `name`, `part` |
| `PARAM_INVALID` | R | bad `unit`, both/neither of `value` and `measure`, bounds on a bool | `name`, `reason` |
| `PARAM_CYCLE` | R | §2.8 | `cycle` |
| `MEASURE_NOT_REFERENCE`, `MEASURE_UNIT_MISMATCH`, `MEASURE_FORWARD` | R | §2.1, §2.8 — **deferred to v1.1** with measured parameters | `name`, `sketch`, `constraint` |
| `SKETCH_MIXED_MODE` | R | §4.2 | `sketch`, `path` |
| `CONSTRAINT_VALUE_ON_REFERENCE` | R | §4.3 | `constraint` |
| `SKETCH_UNKNOWN_REFERENCE`, `SKETCH_WRONG_ENTITY_TYPE`, `SKETCH_NOT_A_DIMENSION`, `SKETCH_UNSUPPORTED_COMBINATION`, `SKETCH_SELF_REFERENCE` | R | forge-solve input errors (§4.3) | forge-solve's `details` |
| `REF_KIND_MISMATCH` | R | `kind` ≠ the query's kind, or the field does not accept it | `field`, `expected`, `found` |
| `QUERY_INVALID` | R | §5.4 | `path`, `expected`, `found` |
| `QUERY_UNKNOWN_CURVE` | R | §5.3 | `feature`, `curve`, `similar` |
| `INVALID_CARDINALITY` | R | `card` is not `one`/`some`/`any`/integer ≥ 1, or not `one`/`1` on a single-entity field ([W0-14]) | `field`, `allowed` |
| `BOOLEAN_TARGETS_REQUIRED` | R | §6.0.2 | `feature` |
| `HOLE_SIZE_UNKNOWN`, `HOLE_SIZE_REQUIRED`, `HOLE_OPTIONS_CONFLICT`, `HOLE_DEPTH_REQUIRED` | R | §6.5 | `field`, `allowed` |
| `CHAMFER_OPTIONS_CONFLICT` | R | §6.7 | `fields` |
| `PATTERN_SEED_UNSUPPORTED` | R | §6.10 | `seed`, `type` |
| `INVALID_RADIUS`, `INVALID_COUNT`, `INVALID_VALUE` | R (literal) / E (expression) | range checks (§0.5) | `field`, `value`, `expected` |
| `EXPR_DOMAIN` | E | §2.7 | `expr`, `subexpr`, `operands` |
| `EXPR_NOT_INTEGER` | R/E | §2.7 | `expr`, `value` |
| `PARAM_OUT_OF_RANGE` | R/E | §2.1 | `name`, `value`, `min`, `max` |
| `PARAM_FAILED` | E | a used parameter failed | `param`, `code` |
| `DEPENDENCY_FAILED` | E | extended: any feature referenced by id or named in a query failed | `feature`, `code`, `message` |
| `DEPENDENCY_SUPPRESSED` | E | a datum, tag or seed referenced by id is suppressed | `feature` |
| `PLANE_NOT_PLANAR`, `PLANE_DEGENERATE` | E | §3.1 | `surface` / `x_dir` |
| `AXIS_REF_UNSUPPORTED` | E | §3.2 | `type` |
| `DATUM_DEGENERATE` | E | §3.3, §3.4 | `reason`, `angle_deg` |
| `REGION_NOT_FOUND` | E | §4.5 | `curve` |
| `SKETCH_INVALID_DIMENSION` | R/E | §4.3, §4.4 | `constraint`, `value` |
| `SKETCH_CONSTRAINT_CONFLICT` | E | §4.4 | `conflicts` |
| `SKETCH_SOLVE_FAILED` | E | §4.4 | `max_residual`, `clusters` |
| `REF_MISSING`, `REF_AMBIGUOUS`, `REF_SPLIT`, `REF_UNCERTAIN`, `REF_CARDINALITY` | E | §5.5, §5.7 | the reference's report entry (§5.8): `field`, `unresolved` with candidates, `expected`/`found` |
| `BOOLEAN_NO_INTERSECTION` | E | §6.0.3 | `tool`, `min_distance` |
| `BOOLEAN_EMPTY_RESULT` | E | §6.0.3 | `targets` |
| `BOOLEAN_NON_MANIFOLD` | E | §6.0.3 | `probe` |
| `BOOLEAN_TOOL_IS_TARGET` | E | §6.4 | `origin` |
| `HOLE_POINT_OFF_FACE`, `HOLE_DUPLICATE_POSITION`, `HOLE_UP_TO_MISSED`, `HOLE_MISSES_BODY` | E | §6.5 | `at`, `distance` |
| `FILLET_RADIUS_TOO_LARGE`, `FILLET_EDGE_UNSUPPORTED`, `FILLET_FAILED` | E | §6.6 | §6.6 |
| `CHAMFER_DISTANCE_TOO_LARGE`, `CHAMFER_EDGE_UNSUPPORTED`, `CHAMFER_SIDE_NOT_ADJACENT`, `CHAMFER_FAILED` | E | §6.7 | §6.7 |
| `SHELL_THICKNESS_TOO_LARGE`, `SHELL_FACE_NOT_ON_BODY`, `SHELL_FAILED` | E | §6.8 | §6.8 |
| `DRAFT_FACE_UNSUPPORTED`, `DRAFT_FAILED` | E | §6.9 | `faces` |
| `PATTERN_ALL_INSTANCES_FAILED` | E | §6.10 | `instances` |
| `SKETCH_UNDER_CONSTRAINED` | I | §4.4 | `dof`, `entities` |
| `SKETCH_REDUNDANT_CONSTRAINTS` | W | §4.4 | `redundant` |
| `SKETCH_LOOP_FLIPPED` | W | §4.4 | `curves` |
| `REF_REPAIRED`, `REF_MERGED`, `REF_SPLIT_ACCEPTED` | I | §5.7 | `field`, `key`, `into`/`pieces`, `proposal` |
| `REF_SET_CHANGED`, `REF_KIND_CHANGED`, `REF_NEIGHBORHOOD_CHANGED` | W | §5.7 | `field`, `added`, `removed` / `key`, `was`, `now` |
| `BOOLEAN_SPLIT` | I | §6.0.3 | `origin`, `pieces` |
| `BOOLEAN_BODY_CONSUMED` | W | §6.0.3 | `origin` |
| `HOLE_BREAKS_THROUGH` | W | §6.5 | `at` |
| `PATTERN_INSTANCE_SKIPPED` | W | §6.10 | `index`, `code` |
| `SHELL_CLOSED_VOID` | I | §6.8 | — |

Engine-internal failures keep the engine prefix (`FORGE_*`, `OCCT_*`, v0 [R-12]).

### 7.6 Probes [D-54]

A probe `{ "kind", "point": P3, "normal"? }` locates an entity without persisting it:
- **face**: a point on the face (within tol) at distance ≥ `10·tol` from its boundary (faces
  smaller than that: any interior point), with the outward normal there;
- **edge**: the point at the middle of the edge's parameter range (ring edges: half a turn from the
  deterministic start of ADR 0012), at distance ≥ `10·tol` from its vertices;
- **vertex**: its position;
- **body**: the probe of its face with the smallest key.

Probes are deterministic in Forge. They are used by UIs (highlight), renders, the agent (`describe`)
and the oracle's replay (§8.1); they are never stored in the IR.

## 8. Diff rules (`kernel-diff` v1)

### 8.1 What the oracle computes, and what it replays [D-55]

| Item | Oracle | How the oracle stays independent |
|---|---|---|
| Parameters and expressions | **computes** (own parser, type checker and evaluator in Python) | compared per §8.2 |
| Explicit sketches, compound curves, regions | **computes** | v0 rules |
| Constrained sketches | **replays** Forge's `sketch.solved` | it checks, with its own residual code, that every driving constraint holds to `SOLVE_CHECK_TOLERANCE` at the replayed geometry, that welded ends coincide exactly, and that every dimension value equals its own evaluation of the expression. A failed check is `POTENTIAL_SILENT_WRONG`: Forge returned a wrong solution. (The solver itself is gated separately against PlaneGCS and SolveSpace, spike 04.) |
| Datum frames, face frames | **computes** | compared per §8.2 |
| References | **replays** (PR and nightly gate) the members' probes: each probe must match exactly one OCCT entity of the right kind within `1e-6·s` (else `ORACLE_PROBE_UNMATCHED`, engine-prefixed, hence `ROBUSTNESS`) | the oracle independently re-applies the **geometric** predicates and picks of the query (type, normal, parallel, perpendicular, convexity, radius, extreme, largest/smallest) to the replayed members; a member that fails its predicate is `POTENTIAL_SILENT_WRONG` |
| References, independent mode (nightly, from F2) | **computes**: provenance keys from OCCT's shape history (`BRepPrimAPI_MakePrism`/`MakeRevol` generated, first and last shapes; `BRepAlgoAPI_*` `Modified`/`Generated`/`IsDeleted`; `BRepFilletAPI_MakeFillet`/`MakeChamfer` `Generated`; `BRepOffsetAPI_MakeThickSolid`; its own bookkeeping for holes and patterns), then evaluates the queries itself | resolved sets are compared by key and probe; a difference is `REF_MISMATCH` |
| Body operations, holes, patterns, fillets, chamfers, shells, drafts | **computes** from the resolved references | §8.2, with the normalizations of §8.3 |

### 8.2 Compared fields [D-56]

**Exact:**
- document, parameter and feature `status`; semantic error codes of parameters and features;
- the set of oracle-computable semantic warning codes per feature: `BOOLEAN_SPLIT`,
  `BOOLEAN_BODY_CONSUMED`, `HOLE_BREAKS_THROUGH`, `PATTERN_INSTANCE_SKIPPED`, `SHELL_CLOSED_VOID`
  (in independent-refs mode also the `REF_*` codes);
- `count` and `bool` parameter values;
- region count, `loops`, `outer_curves`;
- the number of bodies per feature and per part, `origin` of each body, `removed`;
- `faces`, `edges`, `face_types`, `edge_types` (after §8.3), `shells`;
- hole instance count and `at` ids, pattern `instances` and `skipped`, fillet/chamfer `edges`.

**Tolerance** (v0 §6 definitions of `rel`, `abs`, `s`):

| Quantity | Match when |
|---|---|
| real parameter values | `\|a − b\| ≤ PARAM_VALUE_REL · max(1, \|a\|, \|b\|)` |
| `volume`, `area`, `centroid`, `bbox_*` | v0 §6 |
| datum and face-frame origins, hole `center` | each component `abs ≤ 1e-6·s` |
| datum directions and normals, hole `axis` | each component `abs ≤ 1e-9` |
| hole `d`, `depth` | `abs ≤ 1e-9·s` |

**Body matching.** Bodies are matched by `origin` (exact); bodies sharing an origin are matched by
nearest centroid, greedily in canonical order. An unmatched body is a body-count mismatch.

**Not compared:** `message`, `details` (including feasible values), probes, captures, `valid`,
vertex counts, `chain_added` (compared only in independent-refs mode).

### 8.3 OCCT normalizations [D-57]

The oracle MUST apply, in addition to v0's (seams, degenerate edges, canonical types, exact bbox,
fixed-order Gauss mass properties):

1. **Same-domain merge** (§6.0.4): `ShapeUpgrade_UnifySameDomain(UnifyFaces = true,
   UnifyEdges = true, ConcatBSplines = false)` after every body operation, with linear tolerance
   *tol* and angular tolerance `ANGULAR_TOLERANCE`. This also re-merges periodic faces that OCCT
   split along seams.
2. **Booleans**: no fuzzy value, `SetRunParallel(false)`, `SetNonDestructive(true)`; tolerance growth
   of the result is ignored because bboxes are computed exactly (v0).
3. **Curve types**: intersection edges that OCCT returns as B-splines but that are conics within
   `1e-7·s` (e.g. an oblique plane–cylinder ellipse) are recognised with
   `GeomConvert_CurveToAnalyticalCurve` before `edge_types` is counted; Forge reports conics as
   conics.
4. **Blend surface types**: fillet and chamfer faces that OCCT returns as B-spline, offset or
   revolution surfaces go through `ShapeAnalysis_CanonicalRecognition` (tolerance `1e-7·s`). If a
   face is still `bspline` where Forge reports the normative analytic type of §6.6, the program is
   `NORMALIZED`, provided every tolerance field matches.
5. **Corner patches**: for bodies with a vertex where three or more blended edges meet, other than
   the normative spherical corner, face/edge counts and types are not compared, volume and area are
   compared at `rel ≤ 1e-5`, and the program is `NORMALIZED` (OCCT approximates such corners).
6. **Shell**: `BRepOffsetAPI_MakeThickSolid` with `GeomAbs_Intersection` joins, offset tolerance
   1e-7, for both directions.
7. **Holes**: the oracle builds each hole tool as the revolution of the exact §6.5 profile and
   applies one cut.
8. **Draft**: `BRepOffsetAPI_DraftAngle` with the neutral plane and pull direction of §6.9.

### 8.4 Classes [D-58]

v0's classes, plus:

| Class | Meaning | Severity |
|---|---|---|
| `REF_MISMATCH` | independent-refs mode: the engines resolved a reference to different sets | between `POTENTIAL_SILENT_WRONG` and `CODE_MISMATCH` |
| `NORMALIZED` | a MATCH that needed §8.3 rule 4 or 5; logged with the rule | just above `MATCH` |

Severity order, most severe first: `POTENTIAL_SILENT_WRONG`, `REF_MISMATCH`, `CODE_MISMATCH`,
`ROBUSTNESS`, `NORMALIZED`, `MATCH`. A release requires zero `POTENTIAL_SILENT_WRONG` and zero
`REF_MISMATCH` on the gate corpora, and every `NORMALIZED` rule must stay below a budget set per
milestone.

## 9. Versioning and migration

### 9.1 `migrate_v0_to_v1` [D-59]

A pure, total, deterministic function from a valid `aicad.ir/0` document to an `aicad.ir/1`
document:
1. set `schema` to `"aicad.ir/1"`;
2. in each part, replace the `sketch` field of every `extrude` and `revolve` (a sketch **name** in
   v0) by that sketch's **id**;
3. [W0-12] rewrite every part id, part name, feature id, feature name and curve id that does not
   match the id grammar of §0.3: `sanitize` (each character outside `[A-Za-z0-9_]` → `_`; a
   `_` prefix for an empty result or a leading digit; cut to 64 bytes), then, if the result is
   taken in its namespace (part ids, part names, feature ids and names document-wide, curve ids
   per sketch), the first free `base_2`, `base_3`, … (the base cut so the total stays ≤ 64). Valid
   ids are reserved first, invalid ones are assigned in document order. Every rewrite is recorded
   in the **migration report** (`migrate_v0_to_v1_report`: `{ "renames": [{ "path", "kind":
   "part_id" | "part_name" | "feature_id" | "feature_name" | "curve_id", "from", "to" }] }`), which
   an engine copies into the report's `migration` field. The 6,079 v0 documents in the repository
   (8 corpus programs, 69 MakerBench references and contexts, 6,002 generated) need no rewrite;
4. change nothing else: `v` is omitted (1), `op` stays `new_body`, curves and curve directions are
   untouched; no parameters, constraints or captures are added.

**Properties** (each is a test in `forge-ir`, `@aicad/ir-types` and the oracle, over shared
fixtures):
- **Metric preservation.** For every v0 document `d`, the v1 report of `migrate(d)` has the same
  feature list, statuses, error codes, regions and body metrics as the v0 report of `d`, bit for
  bit. Only the schema string and the new v1 fields differ.
- **Idempotence.** `migrate(migrate(d)) == migrate(d)`; v1 input is returned unchanged.
- **Rejections are preserved.** An invalid v0 document is rejected with the same codes and paths.
- The three implementations (Rust, TypeScript, Python) produce byte-identical canonical JSON.
- [W0-18] **Compatibility path and gate.** `forge_ir::v1::downgrade_to_v0` is the inverse of the
  migration on documents whose surface equals v0 (it returns `NotV0Surface` otherwise); until
  forge-regen evaluates v1, engines MAY evaluate such documents through it. The W0 gate
  (`forge-ir/tests/v1_migration_gate.rs`) checks, for every v0 program in the repository: the
  migration is valid v1 with no rewrite, `to_json ∘ from_json` is stable, `downgrade_to_v0 ∘
  migrate` is the identity, and forge-regen's report through the compatibility path is
  bit-identical (all 6,079 programs, the generated ones in the ignored release test). W1–W3 own
  the direct gate: forge-regen evaluating the migrated v1 document and comparing its
  `aicad.metrics/1` report with the v0 report field by field.

v1 engines evaluate v0 files by migrating them in memory. The CadScript compiler always emits v1;
printing a v0 IR prints its migration.

### 9.2 Behavior versions [D-60]

- A feature's `v` never changes by migration or by editing other fields. The command layer writes
  the newest `v` only when a feature is **created**; upgrading an existing feature is an explicit
  op (`upgradeFeature`) that shows the report diff before it is applied.
- Every `(type, v)` pair has a frozen golden corpus; a PR that changes any report of a frozen pair
  fails CI.
- `forge-solve` changes that can move a v1 sketch solution require `sketch v: 2` (§4.4 rule 3).

### 9.3 Reserved names

v1 adds these CadScript builtins to `RESERVED_NAMES`: `param`, `measure`, `point`, `rect`, `slot`,
`polygon`, `hole`, `grid`, `boltCircle`, `fillet`, `chamfer`, `shell`, `draft`, `boolean`,
`linearPattern`, `circularPattern`, `mirror`, `datumPlane`, `datumAxis`, `tag`, `edgesBetween`,
`faceOf`, `body`, `bodies`, `min`, `max`, `abs`, `sqrt`, `floor`, `ceil`, `round`, `clamp`, `hypot`,
`sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `PI`, `mm`, `cm`, `inch`, `deg`, `X`, `Y`, `Z`,
`C`. A v0 document that uses one of them as a feature name is still valid IR v1 at the IR level,
because migration does not rename; the CadScript printer then reports `CS_RESERVED_NAME` for it,
and the command layer offers `renameFeature` (safe, because references use ids). [W0-2] IR
validation therefore checks feature names against `RESERVED_NAMES_V0` and parameter names (new in
v1) against the full `RESERVED_NAMES`; the constants file has both lists and
`RESERVED_NAMES_V1_BUILTINS`. CadScript v1 (W8) must switch its reserved-name test to
`ir-v1.constants.json`.

### 9.4 Conformance fixtures (I9) [W0-17]

`corpus/v1/conformance/` is shared by the Rust, TypeScript and Python suites and is **append-only**:
a new rule or a fix adds cases, never edits old ones. JSON numbers are read correctly rounded
(`JSON.parse`, Python `json`, `forge_ir::v1::json`). Every file has a `description`.

| Path | Content | Checked by W0 |
|---|---|---|
| `expressions/cases.json` | `params` (the environment) and ≥ 150 `cases`: `text`, `field`, then `canonical`, `type`, `value` with `bits` (big-endian hex of the binary64) or `tolerance_rel` (libm-dependent), or `error: { code, stage }` | well-formedness only; `TODO(W1)` test ignored until W1 lands |
| `migration/programs/`, `migration/makerbench/`, `migration/renames/` | `<name>.v0.json` → `<name>.v1.json` (canonical text) and, for rewrites, `<name>.renames.json` | byte-for-byte |
| `invalid/documents.json` | `cases`: `document`, `expected` (multiset of `{ code, path }`; `[]` = valid edge case) or `parse_error: true`; `requires: ["expr"]` marks cases that need W1's checker | exact, except `requires` cases (accepted structurally) |
| `queries/typing.json` | a `context` document and `cases` appended as a `tag`: `kind` + `q`, then `expect` (the static kind) or `errors` (paths relative to the Ref) | exact |
| `compound/expansions.json` | `curve` → `members` (bit-exact, or `tolerance` when non-table trigonometry is involved) or `error: { code, field }` | exact |
| `holes/tools.json` | size-related hole fields → the resolved `d`, preset dimensions and thread pitch, or the rejection code | exact |

`corpus/v1/programs/` holds canonical v1 example programs (the SPEC examples, every feature type and
query op); their CadScript twins are W8's.

## 10. Open points (resolved 2026-09-23)

The owner delegated these calls to the coordinator; ADR 0013 "Decisions on the open questions"
records them. All are applied above.

| # | Open point | Resolution |
|---|---|---|
| 1 | Standard tables, `std` insert, FDM compensation | Verified and sourced (§6.5); unverifiable values left out; `std` = the common tapered standard-length brass insert (ruthex / CNC Kitchen datasheets, neutral name); FDM compensation belongs to the process profile. (Decision 1) |
| 2 | Uncertain references fail the feature | Confirmed (§5.7); the UI shows a one-click repair card, the agent gets the same candidates. (Decision 2) |
| 3 | Detached join; pattern instances that miss | A join or cut whose tool touches nothing is `BOOLEAN_NO_INTERSECTION`; a missing pattern instance is skipped with `PATTERN_INSTANCE_SKIPPED`, and only all-missing fails. (Decision 3) |
| 4 | Fillet corners | Accepted: only the equal-radius three-plane corner is normative; others are `NORMALIZED` within a budget. (Decision 7) |
| 5 | Capture refresh | Only on create, edit or repair (§0.6). (Decision 4) |
| 6 | Measured parameters | Deferred to v1.1 (§2.1). (Decision 5) |
| 7 | Draft | Stays in the spec and optional; not a Phase 1 exit requirement. (Decision 5) |
| 8 | Units | `mm`, `cm`, `in`, `deg` only. (Decision 6) |
| 9 | Parameter configurations | Deferred. (Decision 6) |

## 11. W0 resolutions and notes for W1–W11

Ambiguities resolved while encoding the types, by tag (each is also marked in place):

| Tag | Where | Resolution (short) |
|---|---|---|
| [W0-1] | §0.2, §0.4, §0.5 | Rejection pipeline with raw pre-checks; no nullable fields; `v` must be a defined positive integer; error order not normative |
| [W0-2] | §0.3, §9.3 | Feature names checked against the v0 reserved list, parameter names against the full v1 list |
| [W0-3] | §2.2 | The boolean fields that accept expressions |
| [W0-4] | §2.2 | Direction-vector components are `ratio` |
| [W0-5] | §2.7 | `rem_euclid` rounding to 360 means 0 |
| [W0-6] | §4.1 | Compound member order, `corner` form, chord length, `CURVE_OPTIONS_CONFLICT` |
| [W0-7] | §5.6 | Capture carrier and fingerprint encodings |
| [W0-8] | §3.3, §3.4 | Flat datum objects with `mode`; `datum_axis` `points: [a, b]`; `DATUM_OPTIONS_CONFLICT` |
| [W0-9] | §4.3 | Constraint vocabulary = forge-solve; reference checks on ids as written; welding vs self-reference |
| [W0-10] | §6.0.2, §6.5 | Hole option conflicts, diameter resolution, `targets` with `new_body` |
| [W0-11] | §0.4, §2.4 | Correctly rounded v1 reader; canonical JSON text (Ryū) vs canonical expression numbers (ECMAScript) |
| [W0-12] | §0.3, §9.1 | Id grammar (≤ 64 bytes), references, no echo of rejected strings, migration rewrites + report |
| [W0-13] | §2.1, §4.3, §7.5 | Literal range checks as rejections; `CONSTRAINT_VALUE_REQUIRED`; machine-readable catalogue |
| [W0-14] | §4.5, §5.3, §5.5 | Static query and region checks; single-entity fields take only `one` |
| [W0-15] | §2.3–§2.5 | Whitespace, calls, literal overflow, `!` before `^`, Bool `==`, type notation |
| [W0-16] | §6.10, §7.2 | Pattern rules; frozen report details |
| [W0-17] | §9.4 | Conformance fixture layout |
| [W0-18] | §9.1 | v0 compatibility path and migration gate |

**Notes for the workstreams.**
- **W1** plugs its parser/type checker into `forge_ir::v1::expr::ExprValidator` (sites carry path,
  field type, scope and owner) and makes `v1_conformance::expression_fixtures_parse_type_and_evaluate`
  pass (run `invalid/documents.json` `requires: ["expr"]` cases with the hook too). Reuse
  `forge_ir::v1::degtrig` (rule 4 of §2.7). Canonicalize expression text in `to_json` callers
  (the DocStore stores canonical text; `forge_ir::v1::to_json` never rewrites strings).
- **W2** expands compound curves with `forge_ir::v1::compound::expand` (evaluated values), lowers
  constraints per [W0-9] (welded ids in one constraint are redundant, not a self-reference), and
  emits the `sketch` report block.
- **W3** uses the frozen `Ref`, `Query`, `Capture` and report types; static kinds and feature-type
  rules are already enforced by validation.
- **W5** resolves hole dimensions with `forge_ir::v1::holes::tool_dims` and positions with
  `degtrig` (bolt circles).
- **W7** mirrors the pipeline of §0.5 rule 4 (raw pre-checks before JSON-Schema validation), the
  id grammar, the migration rewrite and the fixtures; it reads `ir-v1.schema.json` and
  `ir-v1.constants.json` at run time.
- **W8** generates from `@aicad/ir-types` (`v1` and `metricsV1` namespaces); must switch the
  reserved-name test to `ir-v1.constants.json`, print `--3` as `-(-3)` in TypeScript, and never
  echo rejected ids in diagnostics.
- **W9** can already expose `migrate` (with the rename report) and the canonical printer; `aicad
  eval` on v1 input can use the compatibility path until W1–W3 land.
- **W10** reads `ERROR_CODES` for playbook coverage and treats free-text metadata and
  `migration.renames[].from` as untrusted.
