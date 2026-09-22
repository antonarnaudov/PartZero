//! NURBS curves and surfaces.
//!
//! - [`NurbsCurve<D>`](NurbsCurve) (aliases [`NurbsCurve2`], [`NurbsCurve3`]): de Boor
//!   evaluation in homogeneous coordinates, derivatives of any order, Boehm knot
//!   insertion, validity checks, closest-point projection, arc length.
//! - [`NurbsSurface`]: the tensor-product analogue (derivatives up to any total order).
//! - Exact rational quadratic arcs: [`NurbsCurve2::circle_arc`],
//!   [`NurbsCurve3::circle_arc`], and the elliptical variants.
//!
//! Algorithms follow Piegl & Tiller, *The NURBS Book* (2nd ed.), A2.1–A2.3, A3.2, A3.6,
//! A4.2, A4.4, A5.1 (single insertions) and A7.1.

mod basis;
mod conic;
mod curve;
mod surface;

pub use curve::{NurbsCurve, NurbsCurve2, NurbsCurve3};
pub use surface::{NurbsSurface, SurfaceDerivTable};
