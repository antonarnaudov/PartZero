# ADR 0011: Freeform is native to Forge

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D11, §3b property 7

## Context

- **The product promises Blender-style freeform modeling at CAD precision,** alongside parametric B-rep modeling.
- **The usual approach loses precision and history.** Model in a mesh or SubD tool, export, and convert, often with manual reverse engineering.
- **AI mesh generators are not CAD.** Tools like TRELLIS.2 produce plausible shapes quickly, but not exact, editable or manufacturable geometry.
- **Some shapes don't fit B-rep.** Lattices and organic blends are natural as SDF/implicit bodies and awkward as B-rep.

## Decision

**Freeform is native to Forge:**
- **SubD cages evaluate to exact Catmull–Clark limit surfaces.** They are exact B-splines in regular regions, with certified fits near extraordinary vertices.
- **Mesh bodies and SDF/implicit bodies live alongside B-rep** in one convergent kernel (`forge-mesh`).
- **CAD features apply after conversion.** SubD → B-rep conversion lets fillets, holes, shells and so on apply to freeform bodies.
- **AI mesh generators supply reference bodies only.** They are never the final geometry.
- **OpenSubdiv is a CI oracle** for limit-surface evaluation. It is never shipped ([ADR 0000](0000-own-the-core.md)).

## Consequences

**Positive:**
- **Blender-like flexibility with CAD precision,** and no hand-off between kernels.
- **One provenance, naming and verification model** across all representations.
- **Agents can mix representations,** e.g. an organic grip merged with a parametric mount.

**Negative / costs:**
- **Significant kernel work.** This is scheduled as Forge F4 (M12–M18) and the Phase 5 SubD workspace, after the maker MVP.
- **Mixed bodies need their own checks.** Validity and tolerance rules across mixed B-rep/mesh/SDF bodies need their own invariants.

**Gate:** Phase 5 exit requires SubD → B-rep ≥90% success on cages up to 2k faces.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Hand off to an external mesh or SubD tool and convert | Loses precision and history, and splits the workflow across apps |
| Embed OpenSubdiv at runtime | It would be a quality-defining dependency, against P0. It stays an oracle. |
| Use AI-generated meshes as final geometry | Not exact, not editable, not reliably manufacturable |
| A separate freeform kernel next to Forge | Two kernels, two naming systems and conversion seams. This is exactly what convergent modeling avoids. |
