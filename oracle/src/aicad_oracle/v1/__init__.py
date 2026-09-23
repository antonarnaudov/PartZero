"""IR v1 (`aicad.ir/1`) support of the OCCT oracle (workstream W7a).

The normative contract is `forge/crates/forge-ir/SPEC-v1-DRAFT.md` (rules [D-n], [W0-n]); the
schemas and constants are read at run time from `forge/crates/forge-ir/schema/` (never
vendored). Everything here is an independent Python implementation of that text:

| Module | Contents |
|---|---|
| `consts` | schema files, constants, JSON-Schema validators |
| `jsonio` | strict JSON reader (correctly rounded, duplicate keys rejected), canonical JSON text |
| `ids` | the id grammar, `sanitize`, `unique` |
| `expr` | expression lexer, parser, canonical printer, type checker, evaluator (§2) |
| `precheck`, `validate` | the rejection pipeline of §0.5 rule 4 (a port of W0's rules) |
| `migrate` | `migrate_v0_to_v1` with its rename report (§9.1) |
| `compound` | compound-curve expansion (§4.1) |
| `params` | parameter evaluation, scope and failure propagation (§2.8) |
| `constraints` | the independent constraint checker used to replay solved sketches (§8.1) |
| `topo` | OCCT bodies with provenance keys, probes and the query evaluator (§5) |
| `evaluate` | the §7.1 timeline and the `aicad.metrics/1` report |
| `compare` | `kernel-diff` v1 (§8.2–§8.4) |
| `generator` | `oracle gen --ir v1` |

What the oracle **computes** and what it **replays** follows SPEC §8.1; see `evaluate.py`.
"""
