//! # forge-ssi — surface–surface and curve–surface intersection for Forge
//!
//! The intersection layer under Forge's booleans: given two analytic surfaces (plane,
//! cylinder, cone, sphere, torus) restricted to parameter boxes, return **every**
//! intersection branch as a 3D curve with a pcurve on each surface, plus the vertices
//! (branch ends, crossings, singular points) and tangential contacts, all within an
//! explicit output tolerance and with a completeness certificate. Trimming by face
//! boundaries is the boolean's job; SSI works on parameter boxes ([`UvBox`]).
//!
//! ## API
//! | Function | Result |
//! |---|---|
//! | [`intersect_curve_surface`]`(&Curve3, t_range, &Surface, UvBox, &SsiTolerance)` | [`CurveSurfaceHits`]: certified hits `(t, (u, v), point, contact, multiplicity, certificate)` and overlap ranges |
//! | [`intersect_surfaces`]`(&Surface, UvBox, &Surface, UvBox, &SsiTolerance)` | [`IntersectionGraph`]: [`Branch`]es, [`Vertex`]es, [`Coincidence`], [`Method`], completeness flag, [`SsiStats`] |
//!
//! Failures are structured [`SsiError`]s with stable codes (`SSI_INVALID_DOMAIN`,
//! `SSI_INVALID_TOLERANCE`, `SSI_UNSUPPORTED`, `SSI_TANGENT_UNRESOLVED`,
//! `SSI_NOT_CONVERGED`, `SSI_FIT_FAILED`, `SSI_BUDGET_EXCEEDED`, `SSI_INCONSISTENT`) and
//! diagnostics (3D point, parameters on both operands, measured value vs limit). A
//! result is never silently incomplete: whatever cannot be certified is an error.
//!
//! ## Output contract ([`SsiTolerance`])
//! - Every 3D curve point is within `fit` (default `1e-7` mm) of **both** surfaces. For
//!   every branch this is **certified**: [`Branch::error_bound`] `<= fit` is a proven
//!   upper bound from the Bernstein form of the homogenized algebraic residual of each
//!   Bézier segment (rational curves included), converted to a distance through the
//!   exact factorization of each surface's implicit form.
//! - Every pcurve maps onto its 3D curve within `fit` (`|S(pcurve(t)) − C(t)| <= fit`),
//!   verified on 16 samples per span on top of the construction (exact parameter maps
//!   for closed forms, Hermite interpolation of exact parameter derivatives otherwise).
//! - Vertices and tangential contact points are within `fit` of both surfaces; `fit` is
//!   also the gap below which a near-miss is reported as a tangential contact.
//!
//! ## Curve–surface ([`curve_surface`](intersect_curve_surface))
//! `g(t) = d_S(C(t))` with the surface's distance form `d_S`
//! (`forge_core::geom::surface::implicit`). Lines, circles and ellipses get closed-form
//! candidates (degree-1/2/4 polynomial or trigonometric polynomial: stable quadratic,
//! recursive-derivative isolation of the quartic, half-angle substitution); every
//! candidate is certified by **interval Newton** (unique root, residual enclosure
//! containing 0), and the rest of the range is proven root-free (or searched) by the
//! certified branch-and-bound root finder. Hence hits are certified complete. Roots that
//! cannot be isolated are tangential (multiplicity 2 or 3); flat ranges with `|g| <= fit`
//! are overlaps (the curve lies in the surface). B-spline curves use the certified search
//! span by span (interval evaluation is only valid inside one knot span).
//!
//! ## Surface–surface
//! 1. **Closed forms** ([`Method`] other than `Marching`): plane–plane; common extrusion
//!    (plane ∥ cylinder axis, parallel cylinders: 2D line/circle arrangement → lines);
//!    common axis of revolution (any pair of plane ⟂ axis, cylinder, cone, sphere, torus
//!    sharing an axis — including every plane–sphere and sphere–sphere pair: meridian
//!    arrangement → circles, tangent circles, axis points); oblique plane–cylinder
//!    (ellipse); plane–cone (ellipse, exact rational parabola/hyperbola arcs, line pairs
//!    through the apex, apex point); plane through a torus axis (meridian circles);
//!    bitangent plane of a ring torus (the two Villarceau circles, crossing at the two
//!    tangency points); equal cylinders with intersecting axes (two ellipses crossing at
//!    the tangency points); coincident surfaces (with an affine uv map where one exists).
//!    Closed-form decisions snap at `0.1·fit` over the problem size, and every exact
//!    branch is certified afterwards; a failed certificate falls back to marching.
//! 2. **Marching** (every other pair, e.g. general cylinder–cylinder, anything with a
//!    torus or a cone in general position): the zero set of `G(u, v) = d_Q(S_P(u, v))`
//!    in the box of the better-parametrized surface `P`.
//!    - *Completeness:* a quadtree of `P`'s box classifies each cell with interval
//!      arithmetic as **excluded** (`0 ∉ G(cell)`), **regular** (`G_u` or `G_v` certainly
//!      ≠ 0: the curve is a graph over the cell, no closed loop fits inside, every piece
//!      reaches the boundary, where the crossings are found by the certified 1D root
//!      finder) or **irregular** at the resolution limit. The tracer consumes crossings
//!      until none is unvisited, so every piece of curve meeting a regular cell — closed
//!      loops included — is traced; irregular cells form clusters that must be resolved
//!      explicitly.
//!    - *Tangency and singularities:* a cluster with no branch ends is an isolated
//!      tangential contact if the surfaces meet there within `fit` (reported as a
//!      [`VertexKind::TangentPoint`] with the gap), otherwise it is certified empty on a
//!      finer grid; a cluster with branch ends is a singular vertex (branch crossing,
//!      tangency point, apex/pole) found by Newton on `∇G = 0`, where the branches are
//!      joined, or a shallow pass-through. Anything else is `SSI_TANGENT_UNRESOLVED` —
//!      tangential contact is reported explicitly or not at all. Tangential branches
//!      (surfaces touching along a curve) come from the closed forms.
//!    - *Tracing:* predictor–corrector with steps truncated at exact cell exits, closure
//!      detection in 3D and in parameters, deterministic seed order.
//!    - *Fitting:* exact nodes (Newton-projected points with exact `C'`, `C''` and
//!      parameter derivatives on both surfaces), quintic Hermite spans (3D curve and both
//!      pcurves share `t`), refined until the estimated error is `< fit/4`, stored as
//!      degree-5 B-splines, then certified as above.
//!
//! ## Determinism
//! No hashing, no parallelism, fixed split ratios and schedules, libm transcendental
//! functions only: results are bit-identical across runs, debug/release and native vs
//! wasm32. `tests/determinism_golden.rs` pins a fingerprint of a fixed batch
//! ([`corpus::GOLDEN_FINGERPRINT`]); `wasm/` runs the same batch under Node.
//!
//! ## Verification tooling
//! [`corpus`] generates the deterministic random pair corpus shared by the property
//! tests, the OCCT differential oracle (`oracle/occt_ssi_diff.py`, dev tooling only),
//! the fingerprint and the benchmarks (`examples/`). See `docs/spikes/03-ssi.md`.

pub mod corpus;
pub mod error;
pub mod tolerance;
pub mod types;

mod clip;
mod curve_surface;
mod func;
mod poly;
mod roots1d;
mod ssi;

pub use curve_surface::intersect_curve_surface;
pub use error::{Operand, SsiError};
pub use ssi::intersect_surfaces;
pub use tolerance::SsiTolerance;
pub use types::*;
