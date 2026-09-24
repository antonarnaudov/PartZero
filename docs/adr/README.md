# Architecture Decision Records

Each ADR records one significant decision:
- the context that forced it;
- the decision itself;
- its consequences;
- the alternatives we rejected.

ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes the old one, then update the old one's status line. A later ADR that amends or extends an earlier one without superseding it may also add a dated addendum to it. The original text stays as written.

## Index

| ADR | Title | Status | Date | Plan ref |
|---|---|---|---|---|
| [0000](0000-own-the-core.md) | Own the core; borrow only as oracles | Accepted | 2026-09-23 | §2 P0 |
| [0001](0001-open-core-licensing.md) | Open-core licensing | Accepted | 2026-09-23 | §2 D1 |
| [0002](0002-languages-by-purpose.md) | Languages by purpose; Rust for Forge | Accepted | 2026-09-23 | §2 D2, D2a |
| [0003](0003-forge-kernel-with-occt-oracle.md) | Forge is the kernel from day one; OCCT is a CI oracle | Accepted | 2026-09-23 | §2 D3 |
| [0004](0004-feature-graph-ir.md) | A typed Feature-Graph IR is the source of truth | Accepted | 2026-09-23 | §2 D4 |
| [0005](0005-cadscript.md) | CadScript: a statically compiled TypeScript subset | Accepted | 2026-09-23 | §2 D5 |
| [0006](0006-native-persistent-naming.md) | Persistent naming is native to the kernel | Accepted | 2026-09-23 | §2 D6 |
| [0007](0007-own-renderer-wgpu.md) | Our own renderer on wgpu | Accepted | 2026-09-23 | §2 D7 |
| [0008](0008-own-solvers.md) | Our own sketch and assembly solvers | Accepted | 2026-09-23 | §2 D8 |
| [0009](0009-model-agnostic-llm-gateway.md) | Model-agnostic LLM gateway | Accepted | 2026-09-23 | §2 D9 |
| [0010](0010-local-first.md) | Local-first | Accepted | 2026-09-23 | §2 D10 |
| [0011](0011-native-freeform.md) | Freeform is native to Forge | Accepted | 2026-09-23 | §2 D11 |
| [0012](0012-no-seam-edges.md) | No seam edges; ring edges and surface singularities | Accepted | 2026-09-23 | [FORGE.md](../FORGE.md#topology-model) |
| [0013](0013-ir-v1-references-and-parameters.md) | IR v1: references (typed queries, fail-on-uncertain), parameters, constrained sketches | Accepted | 2026-09-23 | [SPEC-v1-DRAFT](../../forge/crates/forge-ir/SPEC-v1-DRAFT.md), [plan](../IR-V1-IMPLEMENTATION-PLAN.md) |
| [0014](0014-cli-agents-as-providers.md) | CLI agents as providers (completion and agent-runtime modes, mandatory lockdown, MCP broker) | Accepted | 2026-09-24 | §2 D9, [design](../CLI-PROVIDERS.md) |
| [0015](0015-autonomy-dial.md) | The autonomy dial | Accepted | 2026-09-24 | [NORTH-STAR](../NORTH-STAR.md) §8 B5 |
| [0016](0016-manufacturing-output-own-vs-hand-off.md) | Manufacturing output: own vs hand off (slicer rule; own 2.5D CAM in Phase 3) | Accepted | 2026-09-24 | [NORTH-STAR](../NORTH-STAR.md) §8 B8, B9, B17 |
| [0017](0017-opt-in-product-counts-and-failure-reports.md) | Opt-in product counts and kernel failure reports | Accepted | 2026-09-24 | [NORTH-STAR](../NORTH-STAR.md) §8 B12 |
| [0018](0018-design-context-in-the-ir.md) | Design context in the IR (IR v1.1) | Accepted | 2026-09-24 | [NORTH-STAR](../NORTH-STAR.md) §8 B7 |
| [0019](0019-local-face-operations.md) | Local face operations are parametric features | Accepted | 2026-09-24 | [NORTH-STAR](../NORTH-STAR.md) §8 B16 |
| [0020](0020-funded-eval-keys-fallback.md) | Funded eval API keys as a fallback | Accepted | 2026-09-24 | [NORTH-STAR](../NORTH-STAR.md) §8 B18 |

Plan refs that start with § point to [PLAN-2026-09-23.md](../PLAN-2026-09-23.md). NORTH-STAR refs point to rows of [NORTH-STAR.md](../NORTH-STAR.md) §8, which the owner approved on 2026-09-24.

**Amended ADRs.** ADRs 0015–0020 amend or extend earlier ADRs without rewriting them. Each earlier ADR names the new one in its status line and in a dated addendum:

| ADR | Amended or extended by |
|---|---|
| 0000 | 0016 (scope: CAM is ours; slicers are hand-offs) |
| 0004 | 0015 (agent commits), 0018 (design context), 0019 (local face operations) |
| 0009 | 0017 (data handling) |
| 0010 | 0017 (data handling) |
| 0013 | 0018 (IR v1.1 design context), 0019 (naming rules for local face operations). These edits wait for Phase C ([NORTH-STAR-DEFERRED.md](../NORTH-STAR-DEFERRED.md)) |
| 0014 | 0015 (after the PROPOSE gate), 0020 (funded eval keys, eval runs only) |

## Writing a new ADR

1. Copy [adr-template.md](adr-template.md) to `NNNN-short-name.md`, using the next free number.
2. Fill in every section. Alternatives must be real options, each with a reason it was not chosen.
3. Add the ADR to the index above.
4. Update the docs that describe the affected area: [ARCHITECTURE.md](../ARCHITECTURE.md), [FORGE.md](../FORGE.md) or [ROADMAP.md](../ROADMAP.md).

**An ADR is required for:**
- any `unsafe` code in Forge;
- a new runtime dependency that touches geometry, solving, meshing or rendering;
- a breaking change to the IR contract, meaning a new schema version (clarifying the spec doesn't need one);
- a change to licensing.
