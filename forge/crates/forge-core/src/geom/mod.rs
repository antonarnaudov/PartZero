//! Curves and surfaces with evaluation, derivatives and projection.
//!
//! - 2D ([`Curve2`]: [`Line2`], [`Circle2`], [`Ellipse2`], [`Spiral2`], [`NurbsCurve2`]) for sketches
//!   and pcurves in a face's `(u, v)` space.
//! - 3D curves ([`Curve3`]: [`Line3`], [`Circle3`], [`Ellipse3`], [`Helix3`],
//!   [`NurbsCurve3`]) carried by edges.
//! - Surfaces ([`Surface`]: [`Plane`], [`Cylinder`], [`Cone`], [`Sphere`], [`Torus`],
//!   [`Helicoid`], [`NurbsSurface`]) carried by faces.
//!
//! Parametrization conventions are documented on each type and summarised in the
//! tables on [`Curve3`] and [`Surface`]. All angles are radians.
//!
//! # Design
//! - Each geometric type is a small struct with **private fields and validating
//!   constructors** (`Result<_, GeomError>`), so an invalid circle (negative radius) or
//!   frame (non-orthonormal) cannot exist. The enums [`Curve3`], [`Curve2`] and
//!   [`Surface`] dispatch to them.
//! - Evaluation and derivatives are generic over [`Scalar`](crate::scalar::Scalar) in the
//!   parameters (the geometry's own data is `f64`), so the same code yields certified
//!   enclosures with [`Interval`](crate::scalar::Interval) and exact derivatives with
//!   [`Dual`](crate::scalar::Dual).
//! - Projection, arc length and other iterative algorithms are `f64`-only and fully
//!   deterministic (fixed iteration schemes, deterministic tie-breaking).

mod curve2;
mod curve3;
mod ellipse_proj;
mod error;
mod helix;
pub mod nurbs;
pub mod quadrature;
mod surface;

pub use curve2::{Circle2, Curve2, Ellipse2, Line2};
pub use curve3::{Circle3, Curve3, Ellipse3, Line3};
pub use error::{GeomError, NurbsError};
pub use helix::{Helix3, Spiral2};
pub use nurbs::{NurbsCurve, NurbsCurve2, NurbsCurve3, NurbsSurface};
pub use surface::{
    BSPLINE_NORMAL_DEGENERACY, Cone, Cylinder, Helicoid, HelicoidLineHit, HelicoidLineHitsError,
    LINE_HITS_BUDGET, Plane, Sphere, SpindlePatch, Surface, SurfaceDerivs, Torus,
};

/// A 2D B-spline curve (alias of [`NurbsCurve2`]).
pub type BSpline2 = NurbsCurve2;
