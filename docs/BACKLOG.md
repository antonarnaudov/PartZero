# Backlog

This list collects follow-ups from agent reports and reviews. Items are grouped by area and tagged by priority:

| Tag | Meaning |
|---|---|
| **P0** | Blocks a Phase 0 go/no-go |
| **P1** | Needed for the Phase 1 MVP |
| **P2** | Later |

## Forge kernel
- **P1 Curve ids containing provenance-reserved characters** (`/ : { } | + #`) make extrude and revolve fail with `FORGE_INVALID_CURVE_ID`.
  - Decision: curve ids stay free, non-empty strings, and Forge escapes reserved characters in provenance names.
  - SPEC: add a one-liner to §0.
- **P1 forge-check analyses each body twice** (once in regen validation, once in the report). Cache per-body analysis.
- **P1 B-spline faces are not supported** in mass properties or bbox. Imported and F3 bodies will need this.
- **P1 Determinism golden test needs CI coverage** on x86_64 Linux and Windows.
- **P1 No serde on forge-core geometry or topology.** It is needed for the native B-rep cache format.
- **P2 Port the intermediate adaptive stages of Shewchuk's predicates.** `orient3d`, `incircle` and `insphere` currently go filter → exact. This only affects speed.
- **P2 Interval libm bounds are assumed, not proven.** They are widened by 2 ulps based on musl's documented error.
- **P2 B-spline projection is not a certified global minimum.** Use subdivision with convex-hull pruning.
- **P2 Euler check for torus faces that have loops** needs pcurve winding numbers.
- **P2 Loosen `PERIOD_EPS` for imported bodies.**
- **P2 `SKETCH_DEGENERATE_LOOP` is effectively unreachable.** Consider folding it into the crossing stage in IR v1.

## IR / CadScript
- **P1 Comments inside a changed statement are lost** by `applyIrEdit`. Comments above and after the statement are kept.
- **P1 IR v1 additions:** parameters and expressions, constraints (feeding `forge-solve`), booleans, holes as features, fillet and chamfer, and face and edge references through semantic queries.

## Oracle / verification
- **P0 Two horn-torus bbox differences.** The Forge agent's analysis says the oracle is wrong. Being investigated.
- **P1 Run the nightly differential job in CI** with a fresh seed each night, and track the MATCH rate over time.

## AI
- **P0 Live bake-off needs API keys** for Anthropic, OpenAI and Google. The owner has to provide these.
- **P1 Refusal fallbacks (decision pending):** Anthropic recommends server-side fallbacks for its newest models, while ADR 0009 says never retry around a refusal. They are currently off, and can be enabled per request.
- **P1 Sonnet 5 and Haiku 4.5 prices** in the gateway profiles came from the brief and are not verified against docs. The Opus 5.5 cache-write prices are marked "confirm at launch".
- **P2 Gateway features not implemented yet:** mid-conversation system messages, per-message effort, compaction, Gemini explicit caching, OpenAI `configuration_update`.
- **P1 MakerBench needs 20 more tasks** to reach the Phase 0 target of 60. Also:
  - detect holes drawn as two arcs;
  - add hole-offset checks beyond the T4 tasks.

## Product / legal
- **P0 Naming and trademark review** before any public launch. "Forge" and "aicad" are codenames.
- **P1 CLA bot** before accepting outside contributions.
