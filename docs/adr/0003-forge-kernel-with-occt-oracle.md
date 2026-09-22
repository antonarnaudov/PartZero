# ADR 0003: Forge is the kernel from day one; OCCT is a CI oracle

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D3, §3b

## Context

- **[ADR 0000](0000-own-the-core.md) commits us to our own kernel.** That leaves two questions: when Forge becomes the production kernel, and how we know it is right.
- **"Temporarily" shipping OCCT has a hidden cost.** Its semantics (tolerances, seam edges, naming) would leak into the IR, the file format and user files.
- **Building a kernel without an independent reference is the failure mode** of the projects that stalled (Fornjot, CADmium, truck).
- **OCCT is LGPL.** It is the only free exact B-rep kernel and a mature, independent implementation. It is ideal as a reference, but unacceptable as a shipped runtime dependency ([ADR 0001](0001-open-core-licensing.md)).

## Decision

1. **Forge is the geometry kernel from day one,** shipped both native and as WASM. No other kernel is ever wired into the product.
2. **OCCT is a CI oracle only.** It is reached through Python OCP/build123d in `oracle/`, which evaluates the *same* IR independently. It is never distributed.
3. **The IR has one normative spec that both engines implement:** [forge-ir SPEC.md](../../forge/crates/forge-ir/SPEC.md). They must produce the same `aicad.metrics/0` report within the spec's diff rules. When they disagree, first decide which engine violates the spec. If the spec is ambiguous, fix the spec first.
4. **The oracle is not presumed correct.** Mismatches are classified:
   - one engine errors and the other doesn't → a **robustness difference**;
   - both report `ok` with different metrics → a **potential silent-wrong result**, and every such case is investigated.
5. **Release gates require Forge to match or beat the oracle** on our robustness corpora, with **0 silent-wrong results** ([FORGE.md](../FORGE.md#milestones)).

## Consequences

**Positive:**
- **Ground truth from the first commit.** The `oracle-diff` CI job runs Forge vs OCCT over `corpus/programs` on every PR.
- **No OCCT semantics leak into our formats.** Where OCCT has representation artefacts (seam and degenerated edges), the metrics spec normalises them ([ADR 0012](0012-no-seam-edges.md)).
- **Agent work isn't blocked by Forge.** Agent and eval work can start before Forge covers a feature: early spike 7 runs evaluate CadScript through the `oracle/` backend.

**Negative / costs:**
- **Two IR evaluators must be kept semantically identical.** The oracle's Python code is real engineering work.
- **CI carries a Python + OCP toolchain.** Its Python version is pinned, because OCP wheels lag CPython releases.
- **OCCT's weak spots limit the comparison.** In the fillet, shell and offset areas where OCCT itself fails, the oracle can't confirm our results. There we rely on invariants, property tests, exact metrics and the failure zoo, and the gate is "fewer failures than OCCT".

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Ship OCCT first, replace with Forge later | OCCT semantics would leak into the IR, files and naming. The replacement would become a migration, and LGPL obligations would apply in the meantime. |
| Build Forge with no external oracle | No independent ground truth. This is how earlier open kernels drifted into the long tail unnoticed. |
| Use Parasolid or another commercial kernel as the oracle | Not freely available for open CI, and licence terms would constrain publishing oracle-comparison dashboards |
| Rely only on self-consistency (invariants, property tests) | Necessary but not sufficient. A result can be valid but wrong: a closed, oriented solid with the wrong volume. |
