# ADR 0012: No seam edges; ring edges and surface singularities

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** [FORGE.md](../FORGE.md#topology-model), "Topology model"; [forge-ir SPEC §5](../../forge/crates/forge-ir/SPEC.md#5-metrics-aicadmetrics0)

## Context

Many B-rep kernels, OCCT among them, force periodic surfaces into a rectangular parameter domain. This brings two artefacts:

- **Seam edges.**
  - A full cylindrical face is bounded by an extra edge, running along the cylinder, that the same face uses twice (once in each direction) to close the domain.
  - Full revolves, spheres and tori get seams the same way.
- **Degenerate edges.**
  - Zero-length edges stand in for singular points: the apex of a cone, the poles of a sphere.

These artefacts come from the parameterisation, not from the design, and they cause real problems:

- **Agents and queries are confused.** For example, `plate.sides().edges().parallel(Z)` on a part with a cylindrical boss would also return the boss's seam line. Users and LLMs see edges that don't exist physically.
- **Naming becomes unstable.** A seam's position depends on the surface's parameter origin, so an upstream edit that re-parameterises a surface can move or rename it. Fillets that pick up seams fail or behave oddly.
- **Degenerate edges conflict with the IR's own rules.** The IR treats any length ≤ `LINEAR_TOLERANCE` (1e-6 mm) as degenerate ([SPEC §1](../../forge/crates/forge-ir/SPEC.md#1-units-and-tolerance)).
- **Counts are inflated.** Edge counts and entity lists grow, which costs tokens in every tool result that names entities.

Parasolid shows the alternative works at industrial scale. It handles periodicity in the face's parameter domain, allows closed edges without vertices, and has no seams.

## Decision

1. **No seam edges.** Periodic surfaces (cylinder, cone, sphere, torus, periodic B-splines, and surfaces of revolution) are handled natively in the **face parameter domain**, which is periodic in u and/or v. A full cylindrical face is one face with two boundary loops and no seam.
2. **Ring edges are allowed.** A ring edge is a closed edge with no vertices, such as the circle bounding a cylinder's end. A loop may consist of a single ring half-edge. Faces with no loops at all are allowed, such as a full sphere or a full torus.
3. **Apexes and poles are surface singularities.** Cone apexes and sphere poles are properties of the surface, not degenerate edges or vertices. Forge never creates zero-length edges.
4. **Provenance applies unchanged.** Every face, edge and vertex still carries provenance and a canonical name ([ADR 0006](0006-native-persistent-naming.md)). A ring edge is named from its source, typically a sketch circle or an intersection.

## Consequences

### Topology and invariants

- **Loops without vertices.** The half-edge structure must represent a loop made of one ring half-edge with no vertices.
- **Generalized Euler check.** Invariant checkers use a generalized Euler–Poincaré check that accounts for ring edges, loopless faces and periodic face domains. The exact formula lives with the checker in `forge-check`.
- **Point-in-face classification on periodic domains** must handle loops that wrap around the periodic direction (non-contractible loops). It cannot assume a simply connected rectangle.

### SSI and booleans

- **Closed intersection curves are expected.** A closed intersection curve that wraps around a cylinder splits the face into two annular faces, separated by a ring edge, with no seam created.
- **Splitting and merging must preserve the rules.** Face splitting and merging on periodic domains must preserve "no seams, no degenerate edges" as an invariant.

### Tessellation

- **Periodic domains are meshed natively.** Where a tessellator needs a cut, it uses an internal, tessellation-only cut placed deterministically. The cut never becomes a topological edge, and watertightness across it is the mesher's responsibility.
- **Singular points** (apexes, poles) get dedicated handling, such as fans, so triangles don't degenerate.
- **Ring edges are sampled from a deterministic start parameter,** so meshes stay bit-identical across targets.

### Integration (mass properties)

- **Metrics are computed on the exact geometry** ([SPEC §5](../../forge/crates/forge-ir/SPEC.md#5-metrics-aicadmetrics0)). Face integrals must work over periodic domains whose boundary loops may be non-contractible. Boundary-integral (Green/Stokes) formulations must account for the wrap-around.
- **Singular points need care.** Integrands must stay well-defined at singular points. Closed forms are used for analytic surfaces where possible.

### Naming and agents

- **Queries return only real edges.** `.edges().parallel(Z)` never returns a seam.
- **Names are independent of the parameter origin.** Provenance names don't depend on where a surface's parameter origin sits.
- **Circles have no vertices.** Selections and queries must target edges or faces, not vertex positions.

### File I/O

- **Export adds artefacts where readers need them.** Many STEP consumers expect seam and degenerate edges on periodic and singular faces, so `forge-io` synthesizes them on export where the format or target reader requires it.
- **Import removes them.** On import, seams are removed and degenerate edges are dropped, which heals imported data into this model.

### Oracle diffs

- **Edge counts exclude OCCT's artefacts.** OCCT's seam edges and degenerated edges are excluded from `edges` and `edge_types` ([SPEC §5](../../forge/crates/forge-ir/SPEC.md#5-metrics-aicadmetrics0)), and Forge has neither kind.
- **Face counts match directly for the v0 feature set.** A full cylinder or sphere is one face in both engines. Any later case where OCCT splits periodic faces differently is handled by amending the diff rules in the SPEC.
- **Vertex counts are not compared in v0,** because OCCT's seams and degenerated edges carry vertices that Forge doesn't have.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| OCCT-style seams and degenerate edges | Simpler algorithms on a rectangular domain and direct STEP compatibility. But the artefacts leak into naming, queries, agent tool output and counts, and degenerate edges violate the IR's tolerance rule. |
| Split every periodic face into two half-faces (no seam, but two faces) | The arbitrary split doubles face counts, and "one design face" stops being one entity, which hurts naming and selection |
| Keep seams internally but hide them from the API | Two topologies to keep consistent. Hidden seams still affect provenance, invariants and fillet behavior, and bugs would surface as "invisible" edges. |
