# Architecture Decision Records

Each ADR records one significant decision:
- the context that forced it;
- the decision itself;
- its consequences;
- the alternatives we rejected.

ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes the old one, then update the old one's status line.

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

Plan refs point to [PLAN-2026-09-23.md](../PLAN-2026-09-23.md).

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
