# ADR 0008: Our own sketch and assembly solvers

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D8

## Context

- **The LLM must never place geometry by coordinates.** Constraint solvers handle sketches, and mate solvers handle assemblies ([RESEARCH.md](../RESEARCH.md#2-ai-for-cad-state-of-the-art)).
- **Agents need to know *why* a solve failed:**
  - how many degrees of freedom remain;
  - which constraints are redundant;
  - which minimal set of constraints conflicts.
- **Solver status is a strong reward signal.** AutoConstrain's solver-status rewards raised fully constrained sketches from 34% to 93%.
- **Existing open solvers are reference-quality but unsuitable to ship.** PlaneGCS and SolveSpace carry licence constraints (LGPL and GPL) that conflict with [ADR 0001](0001-open-core-licensing.md). Their diagnostics were not designed for agents.
- **The math is well understood.**

## Decision

**We build `forge-solve`.**

**Sketch solver:**
- graph decomposition (DR-planning) plus Newton/Levenberg–Marquardt with SVD;
- reports DOF, redundancy and *minimal conflicting sets*, with explanations;
- handles interactive drag solving (WASM, next to the UI);
- differentiable.

**Assembly solver:**
- mate connectors;
- a closed-form tree solve plus LM for loops;
- DOF and motion diagnostics.

**Oracles:** PlaneGCS and SolveSpace run in CI only.

## Consequences

**Positive:**
- **Diagnostics are designed for agents.** `sketch_edit` returns solver status, DOF and conflicts, and `render_sketch` colors entities by DOF.
- **Solver status becomes a training signal** for the Phase 3 auto-constrain model.
- **Differentiability** supports optimization tools later.

**Negative / costs:**
- **We own numerical robustness,** including near-singular Jacobians and drag stability.
- **Interactive performance is a hard requirement.**

**Gates:**
- Phase 0 spike 4, on 60–200-entity sketches:
  - ≤4 ms per drag frame (WASM);
  - DOF counts, redundancy and minimal conflict sets match PlaneGCS/SolveSpace on 1k generated sketches.
- Phase 2: 6 mate types; a 50-part assembly regenerates in <3 s; 0 coordinate placements.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Embed PlaneGCS (e.g. the `planegcs` WASM build) | LGPL. Its diagnostics are not designed around minimal conflict explanations for agents. |
| Embed SolveSpace's solver | GPL, which is incompatible with our licensing |
| Adopt a newer solver (e.g. Zoo's ezpz) | Young, and not designed around our diagnostic and differentiability needs. We watch it as a reference. |
| A generic nonlinear least-squares library only | No decomposition, no DOF or redundancy analysis, and poor explanations of failures |
