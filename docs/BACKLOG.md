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

- **P1 SSI near-crossings.** Equal cylinders whose axes miss by 1e-7 to 1e-5 mm fail with `SSI_NOT_CONVERGED`. Fix: pair branch ends by oriented pass-throughs. This must be closed before the DeepCAD boolean replays (spike 03 open issue 1).
- **P1 Near-coincident surfaces along an arc.** Examples: a sphere 1e-7 mm inside a cylinder of equal radius takes 3.4 s, and at 1e-6 mm it fails. These should become tangent branches traced along the band (spike 03 open issue 2).
- **P1 Interval arithmetic slowed SSI by about 40%.** A concurrent `forge-core` change caused it. Add a fast path for finite bounds.
- **P2 SSI pcurve consistency is sampled, not proven.** B-spline surfaces are unsupported in SSI.

## IR v1 Phase C (from the Phase B final verification, 2026-09-24)
- **P0 W5: holes and patterns.** Neither is implemented; `corpus/v1/programs` rows stay ROBUSTNESS until they are.
- **P0 W6: fillet, chamfer, shell and draft** (the F2 gate).
- **P0 W7b: oracle normalization of OCCT seam artifacts.** This covers arcs on one circle split at a seam vertex, and periodic faces split along seams. All 85 POTENTIAL_SILENT_WRONG rows on v1 seed 47 are oracle-side. SPEC §8.3 needs amending first: rule 1's merges don't hold for OCCT, and rule 3's conic tolerance must be relative to the curve.
- **P0 W0 rulings on boolean identity edge cases:** an unchanged join target counts as `modified`?; `merged_into`/`removed` for join components; the minimum cut that counts.
- **P1 Forge revolve fails with `FORGE_UNBOUNDED_DOMAIN`** on rounded profile corners that touch the axis (degenerate torus). The error is explicit, but must become a solved case (v1 seed 47 #675/#975).
- **P1 Boolean explicit errors:**
  - `FORGE_BOOLEAN_SSI` (`SSI_NOT_CONVERGED`) at tangent or singular start points;
  - `FORGE_BOOLEAN_UNSUPPORTED` for torus minus disks.
- **P1 W9–W11:** command-layer ops and bindings, agent playbooks for v1 codes, and MakerBench v1 tasks (+40), plus boolean, hole, fillet and pattern families in the naming harness.
- **P2 Expression validation DoS.** Levenshtein suggestions over long unknown identifiers: prune by length difference.
- **P2 Record the conditioning-aware tolerance for the expression oracle.** Also: the expression conformance suite has 376 cases against the plan's 600; wasm32-wasip1 CI for the forge-params golden; forge-regen's v0 golden on wasip1 needs wasmtime.

## IR / CadScript
- **P1 Comments inside a changed statement are lost** by `applyIrEdit`. Comments above and after the statement are kept.
- **P1 IR v1 additions:** parameters and expressions, constraints (feeding `forge-solve`), booleans, holes as features, fillet and chamfer, and face and edge references through semantic queries.
- **P1 How IR v1 should store face and edge references** (from spike 02, [02-naming.md](spikes/02-naming.md)):
  1. Never store `#k` indices. Write the position instead, e.g. `edgeAt(bow.end)`.
  2. Identify a body by one of its curves, and include body identity in cap names.
  3. Treat a reference as a set with a declared count, so a split returns every piece or is flagged.
  4. Flag a reference whose surface type changed.
  5. Store the two face references with every edge reference.
  6. Key references by feature id, not feature name.
  7. Make renames explicit edits that carry a map from old id to new id, and have the printer preserve curve ids and directions.
  8. Auto-accept a match only when the geometry is identical.
  9. Write the naming conventions into the SPEC.
- **P1 Rerun the naming harness** after booleans (F1) and fillets (F2) are in. Splits and merges are where naming is genuinely hard.

## Oracle / verification
- ~~**P0 Two horn-torus bbox differences.**~~ **Resolved 2026-09-23:** the oracle was wrong, because OCCT's `AddOptimal` stops short on surfaces of revolution. The oracle now uses closed-form bounds. Forge matches OCCT on 6,218 of 6,220 programs. The other 2 are OCCT defects where Forge equals the closed form.
- **P1 Run the nightly differential job in CI** with a fresh seed each night, and track the MATCH rate over time.

## AI
- **P0 Live bake-off needs API keys** for Anthropic, OpenAI and Google. The owner has to provide these.
- **P1 Refusal fallbacks (decision pending):** Anthropic recommends server-side fallbacks for its newest models, while ADR 0009 says never retry around a refusal. They are currently off, and can be enabled per request.
- **P1 Sonnet 5 and Haiku 4.5 prices** in the gateway profiles came from the brief and are not verified against docs. The Opus 5.5 cache-write prices are marked "confirm at launch".
- **P2 Gateway features not implemented yet:** mid-conversation system messages, per-message effort, compaction, Gemini explicit caching, OpenAI `configuration_update`.
- ~~**P1 MakerBench needs 20 more tasks.**~~ Done: 61 tasks, validated on Forge and OCCT, with arc-drawn holes and edge-offset checks.
- ~~**P1 The spec writer's check schema drops `relative_to`.**~~ Fixed: the schema and the spec writer prompt now cover edge offsets and holes drawn as arcs.
- **P2 MakerBench should record a rendered image per task** once the agent's L5 visual judge exists.
## CLI providers (from the live smoke test, 2026-09-24)
- **P1 The spec writer can pass its own tests while missing requested features.** In the knob task it never checked for the blind bore. Require one spec test per requested feature.
- **P1 A struggling task burns about 10 minutes on a CLI plan.** Add a per-task wall-time cap and stop after N failed applies in bench/runtime mode.
- **P2 Cursor Agent is blocked.** Headless mode offers no documented `--trust` option and no web-search off switch. Unblock it once the CLI supports a full lockdown.
- **P2 Desktop e2e tests fail confusingly when `forge/target/debug/aicad` is missing** (for example after `cargo clean`). Add a global-setup check with a clear message, or build it automatically.

## App
- **P1 Packaged builds can't run the agent yet.** electron-builder needs a bundling step for the agent worker, gateway, forge-web WASM and prompts.
- **P1 The agent doesn't pause when the user edits mid-run.** Conflicts are only detected at accept time.
- **P1 Assumption chips aren't editable yet.** This needs IR v1 parameters.
- **P1 The L5 visual judge isn't wired.** The judge model setting is stored, but nothing calls it yet.
- **P2 Transparent ghost overlay for proposals** in forge-render. Today it's a tinted toggle.
- **P2 Scripted and replay transports only speak the Anthropic format.**

## Product / legal
- **P0 Naming and trademark review** before any public launch. "Forge" and "aicad" are codenames.
- **P1 CLA bot** before accepting outside contributions.
