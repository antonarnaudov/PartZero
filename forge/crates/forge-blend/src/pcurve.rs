//! Pcurves of new edges: the image of an edge curve in a face's `(u, v)` space, sharing the
//! edge's parameter (`S(pc(t)) ≈ C(t)`), as forge-check's boundary integration needs.
//!
//! Exact forms first: an **affine** image (lines on planes and cylinders, parallel circles
//! of cylinders, cones and tori, meridian circles of tori) is a degree-1 B-spline; a circle
//! or ellipse on a plane whose image turns counter-clockwise is an [`Ellipse2`]. Otherwise a
//! C⁰ quintic B-spline interpolating the curve's surface parameters at Chebyshev–Lobatto
//! nodes, spans halved until the image is within [`PCURVE_FIT`] of the curve (the method of
//! forge-ops' boolean pcurves). The deviation returned is measured, and feeds the edge
//! tolerance.

use forge_core::geom::{Curve2, Curve3, Ellipse2, NurbsCurve2, Surface};
use forge_core::linalg::{Point2, Point3};
use forge_core::math;

/// Largest deviation (mm) of a fitted pcurve's image from its edge curve.
pub(crate) const PCURVE_FIT: f64 = 1e-10;

/// Parameters of `p` on `s`, periodic parameters shifted by whole periods towards `near`.
pub(crate) fn uv_near(s: &Surface, p: Point3, near: Option<Point2>) -> Point2 {
    let (u, v, _) = s.project(p);
    let mut uv = Point2::new(u, v);
    if let Some(n) = near {
        let (pu, pv) = s.periodicity();
        if let Some(per) = pu {
            uv.x += ((n.x - uv.x) / per).round() * per;
        }
        if let Some(per) = pv {
            uv.y += ((n.y - uv.y) / per).round() * per;
        }
    }
    uv
}

/// `v` values of the singular lines of `s` (sphere poles, cone apex).
fn singular_vs(s: &Surface) -> Vec<f64> {
    match s {
        Surface::Sphere(_) => vec![-math::FRAC_PI_2, math::FRAC_PI_2],
        Surface::Cone(c) => vec![c.apex_v()],
        Surface::Torus(t) => t
            .spindle_v_range()
            .map(|(a, b)| vec![a, b])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn sample_ts(range: (f64, f64), n: usize) -> impl Iterator<Item = f64> {
    let (t0, t1) = range;
    (0..=n).map(move |i| {
        if i == n {
            t1
        } else {
            t0 + (t1 - t0) * i as f64 / n as f64
        }
    })
}

/// Largest distance between `S(pc(t))` and `C(t)` at `n + 1` uniform samples.
pub(crate) fn deviation(s: &Surface, c: &Curve3, pc: &Curve2, range: (f64, f64), n: usize) -> f64 {
    sample_ts(range, n)
        .map(|t| {
            let uv = pc.eval(t);
            s.eval(uv.x, uv.y).distance(c.eval(t))
        })
        .fold(0.0, f64::max)
}

/// A pcurve of `c` over `range` on `s` and its measured deviation (mm); see the module
/// docs. `near`: the period copy to start in. Errors (as text) when the curve does not lie
/// on the surface, passes a singular point, or no fit converges.
pub(crate) fn pcurve_for(
    s: &Surface,
    c: &Curve3,
    range: (f64, f64),
    near: Option<Point2>,
) -> Result<(Curve2, f64), String> {
    let (t0, t1) = range;
    if t0.partial_cmp(&t1) != Some(std::cmp::Ordering::Less) {
        return Err("empty pcurve range".into());
    }
    let size = 1.0 + c.eval(t0).norm().max(c.eval(t1).norm());
    let mut off: f64 = 0.0;
    for t in sample_ts(range, 64) {
        off = off.max(s.project(c.eval(t)).2);
    }
    if off > 1e-7 * size.max(1.0) {
        return Err(format!(
            "a {} edge does not lie on its {} face (off by {off:.3e} mm)",
            c.kind_name(),
            s.kind_name()
        ));
    }
    let sing = singular_vs(s);
    let uv_at = |t: f64, prev: Option<Point2>| -> Result<Point2, String> {
        let uv = uv_near(s, c.eval(t), prev);
        if sing
            .iter()
            .any(|&vs| (uv.y - vs).abs() <= 1e-7 * (1.0 + vs.abs()))
        {
            return Err(format!(
                "a {} edge passes a singular point of its {} face",
                c.kind_name(),
                s.kind_name()
            ));
        }
        Ok(uv)
    };
    let tol = PCURVE_FIT.max(1e-13 * size);
    let start = uv_at(t0, near)?;
    // Affine images.
    let end = {
        let mut prev = start;
        for t in sample_ts(range, 16).skip(1) {
            prev = uv_at(t, Some(prev))?;
        }
        prev
    };
    let lin: Curve2 = NurbsCurve2::new(
        1,
        vec![t0, t0, t1, t1],
        vec![start.to_array(), end.to_array()],
        None,
    )
    .map_err(|e| format!("degree-1 pcurve: {e}"))?
    .into();
    let e_lin = deviation(s, c, &lin, range, 32);
    if e_lin <= tol {
        let dev = deviation(s, c, &lin, range, 256);
        if dev <= tol {
            return Ok((lin, dev));
        }
    }
    // Circles and ellipses on planes, turning counter-clockwise in the plane's frame.
    if let (Surface::Plane(pl), Curve3::Circle(_) | Curve3::Ellipse(_)) = (s, c) {
        let f = pl.frame();
        let (fr, rx, ry) = match c {
            Curve3::Circle(k) => (*k.frame(), k.radius(), k.radius()),
            Curve3::Ellipse(e) => (*e.frame(), e.rx(), e.ry()),
            _ => unreachable!("matched above"),
        };
        let o = f.to_local_point(fr.origin());
        let x = f.to_local_vector(fr.x()).truncate();
        let y = f.to_local_vector(fr.y()).truncate();
        let (xl, yl) = (x.norm(), y.norm());
        if xl > 0.0 && yl > 0.0 && x.dot(y).abs() <= 1e-12 && x.perp_dot(y) > 0.0 {
            let mut o2 = o.truncate();
            // The period copy of `near` is irrelevant on a plane.
            if !o2.is_finite() {
                o2 = Point2::new(0.0, 0.0);
            }
            if let Ok(e2) = Ellipse2::new(o2, x, rx * xl, ry * yl) {
                let pc: Curve2 = e2.into();
                let dev = deviation(s, c, &pc, range, 256);
                if dev <= tol {
                    return Ok((pc, dev));
                }
            }
        }
    }
    // C⁰ quintic pieces.
    for pass_tol in [tol, 0.1 * tol] {
        if let Some(pc) = quintic_pass(&uv_at, s, c, range, start, pass_tol, 4096)? {
            let dev = deviation(s, c, &pc, range, 512);
            if dev <= tol {
                return Ok((pc, dev));
            }
        }
    }
    Err(format!(
        "no pcurve of a {} edge on its {} face converges to {tol:.1e} mm",
        c.kind_name(),
        s.kind_name()
    ))
}

/// Chebyshev–Lobatto nodes on `[0, 1]`: `(1 − cos(kπ/5)) / 2`.
const QUINTIC_NODES: [f64; 6] = [
    0.0,
    0.095_491_502_812_526_27,
    0.345_491_502_812_526_3,
    0.654_508_497_187_473_7,
    0.904_508_497_187_473_7,
    1.0,
];

const BINOM5: [f64; 6] = [1.0, 5.0, 10.0, 10.0, 5.0, 1.0];

/// Inverse of the quintic Bernstein collocation matrix at [`QUINTIC_NODES`].
fn quintic_inverse() -> &'static [[f64; 6]; 6] {
    static INV: std::sync::OnceLock<[[f64; 6]; 6]> = std::sync::OnceLock::new();
    INV.get_or_init(|| {
        let mut a = [[0.0f64; 12]; 6];
        for (k, &s) in QUINTIC_NODES.iter().enumerate() {
            for j in 0..6 {
                a[k][j] = BINOM5[j] * math::powi(s, j as i32) * math::powi(1.0 - s, 5 - j as i32);
            }
            a[k][6 + k] = 1.0;
        }
        for c in 0..6 {
            let p = (c..6)
                .max_by(|&x, &y| a[x][c].abs().total_cmp(&a[y][c].abs()))
                .expect("rows");
            a.swap(c, p);
            let d = a[c][c];
            for x in &mut a[c] {
                *x /= d;
            }
            for r in 0..6 {
                if r != c {
                    let f = a[r][c];
                    if f != 0.0 {
                        let row = a[c];
                        for (x, y) in a[r].iter_mut().zip(row) {
                            *x -= f * y;
                        }
                    }
                }
            }
        }
        let mut inv = [[0.0; 6]; 6];
        for (r, row) in inv.iter_mut().enumerate() {
            row.copy_from_slice(&a[r][6..]);
        }
        inv
    })
}

fn bezier5(c: &[Point2; 6], s: f64) -> Point2 {
    let r = 1.0 - s;
    let (mut x, mut y) = (0.0, 0.0);
    for (j, cj) in c.iter().enumerate() {
        let b = BINOM5[j] * math::powi(s, j as i32) * math::powi(r, 5 - j as i32);
        x += b * cj.x;
        y += b * cj.y;
    }
    Point2::new(x, y)
}

type UvAt<'a> = dyn Fn(f64, Option<Point2>) -> Result<Point2, String> + 'a;

fn quintic_pass(
    uv_at: &UvAt<'_>,
    s: &Surface,
    c: &Curve3,
    (t0, t1): (f64, f64),
    start: Point2,
    tol: f64,
    max_spans: usize,
) -> Result<Option<Curve2>, String> {
    let inv = quintic_inverse();
    let min_span = 1e-12 * (1.0 + t0.abs().max(t1.abs()));
    let mut spans: Vec<(f64, f64)> = sample_ts((t0, t1), 4)
        .collect::<Vec<_>>()
        .windows(2)
        .map(|w| (w[0], w[1]))
        .collect();
    let mut out: Vec<[Point2; 6]> = Vec::with_capacity(spans.len());
    let mut breaks: Vec<f64> = vec![t0];
    let mut prev = start;
    let mut i = 0;
    while i < spans.len() {
        let (a, b) = spans[i];
        let mut vals = [prev; 6];
        let mut p = prev;
        for (k, &x) in QUINTIC_NODES.iter().enumerate().skip(1) {
            let t = if k == 5 { b } else { a + (b - a) * x };
            p = uv_at(t, Some(p))?;
            vals[k] = p;
        }
        let mut cp = [Point2::new(0.0, 0.0); 6];
        for (j, cj) in cp.iter_mut().enumerate() {
            let (mut x, mut y) = (0.0, 0.0);
            for (k, v) in vals.iter().enumerate() {
                x += inv[j][k] * v.x;
                y += inv[j][k] * v.y;
            }
            *cj = Point2::new(x, y);
        }
        cp[0] = vals[0];
        cp[5] = vals[5];
        let mut e: f64 = 0.0;
        for m in 0..24 {
            let x = (m as f64 + 0.5) / 24.0;
            let uv = bezier5(&cp, x);
            e = e.max(s.eval(uv.x, uv.y).distance(c.eval(a + (b - a) * x)));
        }
        if e > tol {
            if b - a <= min_span || spans.len() >= max_spans {
                return Ok(None);
            }
            let m = 0.5 * (a + b);
            spans[i] = (a, m);
            spans.insert(i + 1, (m, b));
            continue;
        }
        out.push(cp);
        breaks.push(b);
        prev = vals[5];
        i += 1;
    }
    let mut knots = vec![t0; 6];
    let mut ctrl: Vec<[f64; 2]> = Vec::with_capacity(5 * out.len() + 1);
    for (k, cp) in out.iter().enumerate() {
        if k == 0 {
            ctrl.push(cp[0].to_array());
        }
        for cj in &cp[1..] {
            ctrl.push(cj.to_array());
        }
        if k + 1 < out.len() {
            knots.extend([breaks[k + 1]; 5]);
        }
    }
    knots.extend([t1; 6]);
    Ok(NurbsCurve2::new(5, knots, ctrl, None).ok().map(Into::into))
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::{Circle3, Cylinder, Ellipse3, Line3, Plane, Sphere, Torus};
    use forge_core::linalg::{Frame, Vec3};

    #[test]
    fn affine_images_are_exact_degree_one() {
        let cyl = Surface::Cylinder(Cylinder::new(Frame::world(), 2.0).unwrap());
        let generator = Curve3::Line(Line3::new(Vec3::new(2.0, 0.0, 1.0), Vec3::unit_z()).unwrap());
        let (pc, dev) = pcurve_for(&cyl, &generator, (0.0, 3.0), None).unwrap();
        assert!(dev <= 1e-14, "{dev}");
        assert!(matches!(pc, Curve2::BSpline(ref n) if n.degree() == 1));
        let par = Curve3::Circle(
            Circle3::new(Frame::world().with_origin(Vec3::new(0.0, 0.0, 1.5)), 2.0).unwrap(),
        );
        let (_, dev) = pcurve_for(&cyl, &par, (0.3, 2.0), None).unwrap();
        assert!(dev <= 1e-13, "{dev}");
    }

    #[test]
    fn plane_ellipses_and_oblique_cylinder_sections_fit_within_tolerance() {
        let pl = Surface::Plane(Plane::new(Frame::world()));
        let e = Curve3::Ellipse(Ellipse3::new(Frame::world(), 3.0, 1.0).unwrap());
        let (pc, dev) = pcurve_for(&pl, &e, (0.0, 1.0), None).unwrap();
        assert!(matches!(pc, Curve2::Ellipse(_)));
        assert!(dev <= 1e-12, "{dev}");
        // An ellipse on a cylinder (oblique section) is not affine: quintic fit.
        let cyl = Surface::Cylinder(Cylinder::new(Frame::world(), 1.0).unwrap());
        let tilt = Frame::from_normal_x(
            Vec3::zero(),
            Vec3::new(1.0, 0.0, 1.0),
            Vec3::new(1.0, 0.0, -1.0),
        )
        .unwrap();
        let sec = Curve3::Ellipse(Ellipse3::new(tilt, 2f64.sqrt(), 1.0).unwrap());
        let (pc, dev) = pcurve_for(&cyl, &sec, (0.2, 2.5), None).unwrap();
        assert!(matches!(pc, Curve2::BSpline(ref n) if n.degree() == 5));
        assert!(dev <= PCURVE_FIT, "{dev}");
    }

    #[test]
    fn great_circles_off_the_poles_fit_on_spheres_and_tori() {
        let sph = Surface::Sphere(Sphere::new(Frame::world(), 2.0).unwrap());
        let gc = Curve3::Circle(
            Circle3::new(
                Frame::from_normal_x(Vec3::zero(), Vec3::unit_x(), Vec3::unit_y()).unwrap(),
                2.0,
            )
            .unwrap(),
        );
        let (_, dev) = pcurve_for(&sph, &gc, (-1.0, 1.0), None).unwrap();
        assert!(dev <= PCURVE_FIT, "{dev}");
        let tor = Surface::Torus(Torus::new(Frame::world(), 5.0, 1.0).unwrap());
        let mer = Curve3::Circle(
            Circle3::new(
                Frame::from_normal_x(Vec3::new(5.0, 0.0, 0.0), -Vec3::unit_y(), Vec3::unit_x())
                    .unwrap(),
                1.0,
            )
            .unwrap(),
        );
        let (pc, dev) = pcurve_for(&tor, &mer, (0.0, 1.5), None).unwrap();
        assert!(matches!(pc, Curve2::BSpline(ref n) if n.degree() == 1));
        assert!(dev <= 1e-13, "{dev}");
    }

    #[test]
    fn curves_off_the_surface_are_refused() {
        let pl = Surface::Plane(Plane::new(Frame::world()));
        let l = Curve3::Line(Line3::new(Vec3::new(0.0, 0.0, 1e-3), Vec3::unit_x()).unwrap());
        assert!(pcurve_for(&pl, &l, (0.0, 1.0), None).is_err());
    }
}
