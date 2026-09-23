# ADR 0006: Persistent naming is native to the kernel

- **Status:** Accepted; resolution policy amended by [ADR 0013](0013-ir-v1-references-and-parameters.md) (uncertain matches fail with repair candidates instead of proceeding)
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D6, §3 "References"

## Context

- **Topological naming is the hardest problem in parametric CAD.** A fillet references "these four edges". After an upstream edit, the kernel renumbers everything, so which edges are they now?
- **Retrofits exist but are fragile.** FreeCAD's TNP work retrofits naming onto OCCT through post-hoc history mapping, and Onshape tracks identity on top of Parasolid. Both show the problem can be solved, and that bolting a solution on afterwards is fragile.
- **For an agent the problem is sharper still.** An LLM can't reason with kernel indices or coordinates: 6-DoF placement lands within 10 mm only 27.9% of the time. It needs a *reference language*, i.e. stable, meaningful names and queries.

## Decision

- **Provenance on every entity.** Every face, edge and vertex carries `(feature op, role, source entities)` provenance, plus an index for disambiguation. It is assigned by the operation that creates the entity and serializes to a canonical name, e.g. `plate/side:bottom` ([FORGE.md](../FORGE.md#provenance)).
- **Semantic queries and explicit tags sit on top.**
  - Examples: `plate.cap("end")`, `plate.sides().edges().parallel(Z)`, `edgesBetween(boss.sides(), plate.cap("end"))`.
  - Queries are evaluated inside the kernel.
  - `query` checks uniqueness and cardinality.
- **References are stored as queries, never as kernel indices:** `Ref { kind, sel: QueryAST, card, fp? }`. Kernel indices are never persisted.
- **Resolution order:**
  1. exact provenance;
  2. fingerprint, for splits;
  3. query filters;
  4. geometric match, which warns with a confidence and ranked candidates;
  5. error.
- **The fingerprint and geometric fallback always warns.** It never resolves silently.

## Consequences

**Positive:**
- **The problem is fixed at the root.** Names survive edits because the operations that create entities also name them.
- **One vocabulary for everyone.** The same names serve the UI (selection chips), the agent (tool results name entities by ID and tag) and renders tagged with face/edge IDs.
- **Failures are visible.** A repair UI can list candidates instead of guessing.

**Negative / costs:**
- **Every operation must assign complete provenance.** This is an invariant checked after every op, and it adds work to every new operation.
- **Splits and merges need careful index and fingerprint rules** to keep names stable.

**Gates that measure this:**
- Phase 0 spike 2, on 12–20 maker models with 10 scripted mutations each:
  - ≥97% correct on dimension and suppress edits;
  - ≥90% correct on topology-changing edits;
  - **100% of fallbacks flagged.**
- F2 gate: provenance survival ≥99%.
- Phase 1 exit: ≥99% of provenance names survive edits.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Persist kernel indices (face #7) | Break on any topology change. This is the classic naming bug. |
| Post-hoc history mapping on a kernel without native provenance (FreeCAD TNP-style) | Works, but is complex and fragile because it reconstructs information the kernel discarded |
| Pure geometric fingerprinting | Ambiguous after edits and silently wrong when geometry moves. Kept only as a warned fallback. |
| Only explicit user tags | Too much burden on users and agents. Tags are kept as an optional layer on top of provenance. |
