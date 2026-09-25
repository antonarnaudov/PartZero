//! Forge geometry → STEP geometry entities (ISO 10303-42).
//!
//! Every Forge surface and curve has an exact STEP counterpart with the **same
//! parametrization** (so Forge's own pcurves stay valid; see [`curve2d`] for the 2D curves
//! of the `PCURVE`s written on non-planar faces):
//!
//! | Forge | STEP |
//! |---|---|
//! | `Plane` | `PLANE` |
//! | `Cylinder` | `CYLINDRICAL_SURFACE` |
//! | `Cone` (height parameter `v`, radius at `v = 0`) | `CONICAL_SURFACE` (same parametrization) |
//! | `Sphere` | `SPHERICAL_SURFACE` |
//! | `Torus` (ring, horn) | `TOROIDAL_SURFACE` |
//! | `Torus` spindle patch | `DEGENERATE_TOROIDAL_SURFACE` (`select_outer` = the outer sheet) |
//! | `NurbsSurface` | `B_SPLINE_SURFACE_WITH_KNOTS`, rational as the complex instance |
//! | `Line3` | `LINE` + `VECTOR` (magnitude 1) |
//! | `Circle3` | `CIRCLE` |
//! | `Ellipse3` | `ELLIPSE` (the frame turned by 90° when `rx < ry`, so `semi_axis_1` is the major one) |
//! | `NurbsCurve3` | `B_SPLINE_CURVE_WITH_KNOTS` (trimmed exactly to the edge's range by knot insertion), rational as the complex instance |
//!
//! `AXIS2_PLACEMENT_3D` carries a Forge [`Frame`] exactly: `axis` = `z`, `ref_direction` =
//! `x` (Forge frames are right-handed, so STEP's derived `y = z × x` is the frame's `y`).

use forge_core::geom::{Curve2, Curve3, NurbsCurve3, NurbsSurface, SpindlePatch, Surface};
use forge_core::linalg::Frame;

use super::p21::{Args, DataSection};

/// `AXIS2_PLACEMENT_3D` of a frame.
pub(crate) fn axis2(d: &mut DataSection, f: &Frame) -> u32 {
    let loc = d.point(f.origin());
    let z = d.direction(f.z());
    let x = d.direction(f.x());
    d.axis2(loc, z, x)
}

/// A surface entity.
pub(crate) fn surface(d: &mut DataSection, s: &Surface) -> u32 {
    match s {
        Surface::Plane(p) => {
            let a = axis2(d, p.frame());
            d.add(Args::new().str("").r(a).entity("PLANE"))
        }
        Surface::Cylinder(c) => {
            let a = axis2(d, c.frame());
            d.add(
                Args::new()
                    .str("")
                    .r(a)
                    .real(c.radius())
                    .entity("CYLINDRICAL_SURFACE"),
            )
        }
        Surface::Cone(c) => {
            let a = axis2(d, c.frame());
            d.add(
                Args::new()
                    .str("")
                    .r(a)
                    .real(c.radius())
                    .real(c.half_angle())
                    .entity("CONICAL_SURFACE"),
            )
        }
        Surface::Sphere(s) => {
            let a = axis2(d, s.frame());
            d.add(
                Args::new()
                    .str("")
                    .r(a)
                    .real(s.radius())
                    .entity("SPHERICAL_SURFACE"),
            )
        }
        Surface::Torus(t) => {
            let a = axis2(d, t.frame());
            match t.spindle_patch() {
                None => d.add(
                    Args::new()
                        .str("")
                        .r(a)
                        .real(t.major())
                        .real(t.minor())
                        .entity("TOROIDAL_SURFACE"),
                ),
                Some(patch) => d.add(
                    Args::new()
                        .str("")
                        .r(a)
                        .real(t.major())
                        .real(t.minor())
                        .bool(patch == SpindlePatch::Outer)
                        .entity("DEGENERATE_TOROIDAL_SURFACE"),
                ),
            }
        }
        Surface::BSpline(n) => bspline_surface(d, n),
        // `write_step` rejects bodies with thread geometry before any entity is written.
        Surface::Helicoid(_) => d.add(Args::new().str("").entity("PLANE")),
    }
}

/// Distinct knot values and their multiplicities.
pub(crate) fn knots_and_multiplicities(knots: &[f64]) -> (Vec<f64>, Vec<usize>) {
    let mut values: Vec<f64> = Vec::new();
    let mut mults: Vec<usize> = Vec::new();
    for &k in knots {
        match values.last() {
            Some(&last) if last.to_bits() == k.to_bits() => {
                if let Some(m) = mults.last_mut() {
                    *m += 1;
                }
            }
            _ => {
                values.push(k);
                mults.push(1);
            }
        }
    }
    (values, mults)
}

fn bspline_surface(d: &mut DataSection, n: &NurbsSurface) -> u32 {
    let (du, dv) = n.degrees();
    let (nu, nv) = n.net_size();
    let rows: Vec<Vec<u32>> = (0..nu)
        .map(|i| (0..nv).map(|j| d.point(n.control_point(i, j))).collect())
        .collect();
    let (uk, um) = knots_and_multiplicities(n.knots_u());
    let (vk, vm) = knots_and_multiplicities(n.knots_v());
    if n.is_rational() {
        let weights: Vec<Vec<f64>> = (0..nu)
            .map(|i| (0..nv).map(|j| n.weight(i, j)).collect())
            .collect();
        let rec = [
            "BOUNDED_SURFACE()".to_string(),
            Args::new()
                .int(du)
                .int(dv)
                .refs2(&rows)
                .raw(".UNSPECIFIED.")
                .bool(false)
                .bool(false)
                .bool(false)
                .entity("B_SPLINE_SURFACE"),
            Args::new()
                .ints(&um)
                .ints(&vm)
                .reals(&uk)
                .reals(&vk)
                .raw(".UNSPECIFIED.")
                .entity("B_SPLINE_SURFACE_WITH_KNOTS"),
            "GEOMETRIC_REPRESENTATION_ITEM()".to_string(),
            Args::new()
                .reals2(&weights)
                .entity("RATIONAL_B_SPLINE_SURFACE"),
            Args::new().str("").entity("REPRESENTATION_ITEM"),
            "SURFACE()".to_string(),
        ];
        d.add(format!("({})", rec.join(" ")))
    } else {
        d.add(
            Args::new()
                .str("")
                .int(du)
                .int(dv)
                .refs2(&rows)
                .raw(".UNSPECIFIED.")
                .bool(false)
                .bool(false)
                .bool(false)
                .ints(&um)
                .ints(&vm)
                .reals(&uk)
                .reals(&vk)
                .raw(".UNSPECIFIED.")
                .entity("B_SPLINE_SURFACE_WITH_KNOTS"),
        )
    }
}

/// A curve entity for an edge over `range` (B-splines are trimmed to it when it is a
/// strict sub-range of their domain; analytic curves are written whole and bounded by
/// the edge's vertices).
pub(crate) fn curve(d: &mut DataSection, c: &Curve3, range: (f64, f64)) -> u32 {
    match c {
        Curve3::Line(l) => {
            let p = d.point(l.origin());
            let dir = d.direction(l.dir());
            let v = d.add(Args::new().str("").r(dir).real(1.0).entity("VECTOR"));
            d.add(Args::new().str("").r(p).r(v).entity("LINE"))
        }
        Curve3::Circle(c) => {
            let a = axis2(d, c.frame());
            d.add(Args::new().str("").r(a).real(c.radius()).entity("CIRCLE"))
        }
        Curve3::Ellipse(e) => {
            let f = e.frame();
            if e.rx() >= e.ry() {
                let a = axis2(d, f);
                d.add(
                    Args::new()
                        .str("")
                        .r(a)
                        .real(e.rx())
                        .real(e.ry())
                        .entity("ELLIPSE"),
                )
            } else {
                // Major axis along `y`: turn the frame by +90° about `z` (x' = y, y' = −x).
                let turned = Frame::from_normal_x(f.origin(), f.z(), f.y()).unwrap_or(*f);
                let a = axis2(d, &turned);
                d.add(
                    Args::new()
                        .str("")
                        .r(a)
                        .real(e.ry())
                        .real(e.rx())
                        .entity("ELLIPSE"),
                )
            }
        }
        Curve3::BSpline(n) => {
            let trimmed = trim_nurbs(n, range.0, range.1);
            bspline_curve(d, trimmed.as_ref().unwrap_or(n))
        }
        // `write_step` rejects bodies with thread geometry before any entity is written.
        Curve3::Helix(_) => d.add(Args::new().str("").entity("LINE")),
    }
}

/// Fraction of a curve's domain length under which a cut parameter is moved onto an
/// existing knot, so that cutting never creates a sliver span a few ulps wide (readers
/// may merge its knots). The cut point moves by that fraction of the curve's parametric
/// speed — far below any modelling tolerance.
const KNOT_SNAP: f64 = 1e-12;

/// `t`, or the nearest knot of `c` if one is within [`KNOT_SNAP`] of the domain length.
fn snap_to_knot(c: &NurbsCurve3, t: f64) -> f64 {
    let (a, b) = c.domain();
    let near = KNOT_SNAP * (b - a);
    c.knots()
        .iter()
        .copied()
        .filter(|k| (k - t).abs() <= near)
        .min_by(|x, y| (x - t).abs().total_cmp(&(y - t).abs()))
        .unwrap_or(t)
}

/// A 2D curve (a pcurve in a face's parameter plane) moved by `shift`, or `None` for an
/// ellipse whose `rx < ry` (STEP's `ELLIPSE` needs the major axis first, and turning it
/// would shift the parameter the pcurve shares with its edge).
pub(crate) fn curve2d(d: &mut DataSection, c: &Curve2, shift: (f64, f64)) -> Option<u32> {
    let pt = |d: &mut DataSection, p: forge_core::linalg::Vec2| {
        d.add(
            Args::new()
                .str("")
                .reals(&[p.x + shift.0, p.y + shift.1])
                .entity("CARTESIAN_POINT"),
        )
    };
    let dir = |d: &mut DataSection, v: forge_core::linalg::Vec2| {
        d.add(Args::new().str("").reals(&[v.x, v.y]).entity("DIRECTION"))
    };
    Some(match c {
        Curve2::Line(l) => {
            let p = pt(d, l.origin());
            let v = dir(d, l.dir());
            let vec = d.add(Args::new().str("").r(v).real(1.0).entity("VECTOR"));
            d.add(Args::new().str("").r(p).r(vec).entity("LINE"))
        }
        Curve2::Circle(ci) => {
            let p = pt(d, ci.center());
            let x = dir(d, forge_core::linalg::Vec2::unit_x());
            let a = d.add(Args::new().str("").r(p).r(x).entity("AXIS2_PLACEMENT_2D"));
            d.add(Args::new().str("").r(a).real(ci.radius()).entity("CIRCLE"))
        }
        // Spirals are pcurves on planes only, which take no PCURVE entities.
        Curve2::Spiral(_) => return None,
        Curve2::Ellipse(e) => {
            if e.rx() < e.ry() {
                return None;
            }
            let p = pt(d, e.center());
            let x = dir(d, e.x_dir());
            let a = d.add(Args::new().str("").r(p).r(x).entity("AXIS2_PLACEMENT_2D"));
            d.add(
                Args::new()
                    .str("")
                    .r(a)
                    .real(e.rx())
                    .real(e.ry())
                    .entity("ELLIPSE"),
            )
        }
        Curve2::BSpline(n) => {
            let pts: Vec<u32> = n
                .control_points()
                .iter()
                .map(|q| pt(d, forge_core::linalg::Vec2::new(q[0], q[1])))
                .collect();
            let (k, m) = knots_and_multiplicities(n.knots());
            if n.is_rational() {
                let w: Vec<f64> = (0..pts.len()).map(|i| n.weight(i)).collect();
                let rec = [
                    "BOUNDED_CURVE()".to_string(),
                    Args::new()
                        .int(n.degree())
                        .refs(&pts)
                        .raw(".UNSPECIFIED.")
                        .bool(false)
                        .bool(false)
                        .entity("B_SPLINE_CURVE"),
                    Args::new()
                        .ints(&m)
                        .reals(&k)
                        .raw(".UNSPECIFIED.")
                        .entity("B_SPLINE_CURVE_WITH_KNOTS"),
                    "CURVE()".to_string(),
                    "GEOMETRIC_REPRESENTATION_ITEM()".to_string(),
                    Args::new().reals(&w).entity("RATIONAL_B_SPLINE_CURVE"),
                    Args::new().str("").entity("REPRESENTATION_ITEM"),
                ];
                d.add(format!("({})", rec.join(" ")))
            } else {
                d.add(
                    Args::new()
                        .str("")
                        .int(n.degree())
                        .refs(&pts)
                        .raw(".UNSPECIFIED.")
                        .bool(false)
                        .bool(false)
                        .ints(&m)
                        .reals(&k)
                        .raw(".UNSPECIFIED.")
                        .entity("B_SPLINE_CURVE_WITH_KNOTS"),
                )
            }
        }
    })
}

fn bspline_curve(d: &mut DataSection, n: &NurbsCurve3) -> u32 {
    let pts: Vec<u32> = n
        .control_points()
        .iter()
        .map(|c| d.point(forge_core::linalg::Vec3::new(c[0], c[1], c[2])))
        .collect();
    let (k, m) = knots_and_multiplicities(n.knots());
    let closed = n.is_closed(0.0);
    if n.is_rational() {
        let w: Vec<f64> = (0..pts.len()).map(|i| n.weight(i)).collect();
        let rec = [
            "BOUNDED_CURVE()".to_string(),
            Args::new()
                .int(n.degree())
                .refs(&pts)
                .raw(".UNSPECIFIED.")
                .bool(closed)
                .bool(false)
                .entity("B_SPLINE_CURVE"),
            Args::new()
                .ints(&m)
                .reals(&k)
                .raw(".UNSPECIFIED.")
                .entity("B_SPLINE_CURVE_WITH_KNOTS"),
            "CURVE()".to_string(),
            "GEOMETRIC_REPRESENTATION_ITEM()".to_string(),
            Args::new().reals(&w).entity("RATIONAL_B_SPLINE_CURVE"),
            Args::new().str("").entity("REPRESENTATION_ITEM"),
        ];
        d.add(format!("({})", rec.join(" ")))
    } else {
        d.add(
            Args::new()
                .str("")
                .int(n.degree())
                .refs(&pts)
                .raw(".UNSPECIFIED.")
                .bool(closed)
                .bool(false)
                .ints(&m)
                .reals(&k)
                .raw(".UNSPECIFIED.")
                .entity("B_SPLINE_CURVE_WITH_KNOTS"),
        )
    }
}

fn multiplicity(knots: &[f64], t: f64) -> usize {
    knots
        .iter()
        .filter(|&&k| k.to_bits() == t.to_bits())
        .count()
}

/// The piece of `c` over `[t0, t1]` as an exact B-spline with the same parametrization
/// (Boehm knot insertion to multiplicity `p` at each cut, then the control points of the
/// piece; The NURBS Book §5.3). `None` when `[t0, t1]` is not a strict sub-range of the
/// domain, or the piece does not reproduce the curve at its ends (then the whole curve is
/// written and the edge's vertices bound it).
pub(crate) fn trim_nurbs(c: &NurbsCurve3, t0: f64, t1: f64) -> Option<NurbsCurve3> {
    let (a, b) = c.domain();
    let p = c.degree();
    let (t0, t1) = (snap_to_knot(c, t0), snap_to_knot(c, t1));
    let (inner_start, inner_end) = (t0 > a, t1 < b);
    if t0 >= t1 || t0.is_nan() || t1.is_nan() || t0 < a || t1 > b || !(inner_start || inner_end) {
        return None;
    }
    let mut knots = c.knots().to_vec();
    let mut ctrl: Vec<[f64; 3]> = c.control_points().to_vec();
    let mut weights: Option<Vec<f64>> = c.weights().map(<[f64]>::to_vec);
    let rebuild = |knots: &[f64], ctrl: &[[f64; 3]], w: &Option<Vec<f64>>| {
        NurbsCurve3::new(p, knots.to_vec(), ctrl.to_vec(), w.clone()).ok()
    };
    if inner_end {
        let cur = rebuild(&knots, &ctrl, &weights)?;
        let s = multiplicity(&knots, t1);
        let cur = if s < p {
            cur.insert_knot(t1, p - s).ok()?
        } else {
            cur
        };
        knots = cur.knots().to_vec();
        ctrl = cur.control_points().to_vec();
        weights = cur.weights().map(<[f64]>::to_vec);
        let j = knots.iter().position(|k| k.to_bits() == t1.to_bits())?;
        knots.truncate(j + p);
        knots.push(t1);
        ctrl.truncate(j);
        if let Some(w) = weights.as_mut() {
            w.truncate(j);
        }
    }
    if inner_start {
        let cur = rebuild(&knots, &ctrl, &weights)?;
        let s = multiplicity(&knots, t0);
        let cur = if s < p {
            cur.insert_knot(t0, p - s).ok()?
        } else {
            cur
        };
        knots = cur.knots().to_vec();
        ctrl = cur.control_points().to_vec();
        weights = cur.weights().map(<[f64]>::to_vec);
        let k = knots.iter().position(|x| x.to_bits() == t0.to_bits())?;
        if k == 0 {
            return None;
        }
        let mut nk = vec![t0];
        nk.extend_from_slice(&knots[k..]);
        knots = nk;
        ctrl = ctrl[k - 1..].to_vec();
        if let Some(w) = weights.as_mut() {
            *w = w[k - 1..].to_vec();
        }
    }
    let out = rebuild(&knots, &ctrl, &weights)?;
    let scale = 1.0 + c.eval(t0).norm() + c.eval(t1).norm();
    let close = |t: f64| out.eval(t).distance(c.eval(t)) <= 1e-12 * scale;
    let (o0, o1) = out.domain();
    let same_domain = o0.to_bits() == t0.to_bits() && o1.to_bits() == t1.to_bits();
    (same_domain && close(t0) && close(t1) && close(0.5 * (t0 + t1))).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::linalg::Vec3;

    #[test]
    fn trimming_a_bspline_keeps_the_shape_and_parametrization() {
        let c = NurbsCurve3::new(
            3,
            vec![0.0, 0.0, 0.0, 0.0, 0.4, 0.7, 1.0, 1.0, 1.0, 1.0],
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 2.0, 0.0],
                [2.0, -1.0, 1.0],
                [3.0, 3.0, 0.5],
                [4.0, 0.0, 2.0],
                [5.0, 1.0, 0.0],
            ],
            Some(vec![1.0, 2.0, 0.5, 1.0, 3.0, 1.0]),
        )
        .expect("curve");
        for (t0, t1) in [
            (0.1, 0.9),
            (0.0, 0.55),
            (0.4, 1.0),
            (0.4, 0.7),
            (0.23, 0.231),
        ] {
            let tr = trim_nurbs(&c, t0, t1).expect("trims");
            assert_eq!(tr.domain(), (t0, t1));
            for k in 0..=20 {
                let t = t0 + (t1 - t0) * f64::from(k) / 20.0;
                assert!(tr.eval(t).distance(c.eval(t)) < 1e-12, "{t0}..{t1} at {t}");
            }
        }
        assert!(trim_nurbs(&c, 0.0, 1.0).is_none());
        assert!(trim_nurbs(&c, 0.5, 0.5).is_none());
        let _ = Vec3::new(0.0, 0.0, 0.0);
    }

    #[test]
    fn knot_vectors_compress_to_values_and_multiplicities() {
        let (k, m) = knots_and_multiplicities(&[0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0]);
        assert_eq!(k, vec![0.0, 0.5, 1.0]);
        assert_eq!(m, vec![3, 1, 3]);
    }
}
