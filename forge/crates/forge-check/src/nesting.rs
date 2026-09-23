//! Shell nesting: which closed shells of a body lie inside which, by point-in-shell ray
//! casting on the exact geometry.
//!
//! A body's shells are disjoint, so a shell lies wholly inside or wholly outside each other
//! shell, and one point of it decides. The **nesting depth** of a shell is the number of
//! other shells that contain it: an even depth is a lump's outer shell (it must enclose
//! positive volume), an odd depth a cavity (negative volume). This holds for any mix of
//! lumps, cavities and islands inside cavities, and for a lump in the hole of a ring,
//! whose box lies inside the ring's box although the lump is outside it.
//!
//! # Point in shell
//! A ray from the point is intersected with every face surface of the other shell in
//! closed form (plane: linear; cylinder, cone, sphere: quadratic; torus, including
//! spindle and horn tori: quartic), each crossing is mapped to `(u, v)` with the surface's
//! own projection and kept if the face's trimmed domain contains it. The **nearest**
//! crossing decides: the ray leaves the region the shell bounds there when the face's
//! outward normal, times the sign of the shell's volume (an inverted shell's normals
//! point into its region), points along the ray. Only the nearest crossing matters, so
//! tangencies and edge hits further along the ray cannot flip the answer.
//!
//! A ray is **ill-conditioned** when its nearest crossing is grazing
//! ([`NESTING_GRAZING_COS`]) or when a second crossing within the body's gap tolerance
//! disagrees with it (the ray passes through an edge between faces). Each of the fixed,
//! generic [`RAY_DIRECTIONS`] votes; ill-conditioned rays abstain, and a tie (or no vote
//! at all) is an error rather than a guess.

use forge_core::geom::Surface;
use forge_core::linalg::{Point3, Vec2, Vec3};
use forge_core::math;
use forge_core::topo::{Body, ShellId};

use crate::CheckError;
use crate::bbox::Aabb;
use crate::domain::{FaceDomain, contains, face_domain};

/// A ray crossing whose `|cos|` between the ray and the face normal is below this is
/// grazing: the ray may only touch the surface there, so the side it leaves on is not
/// decided by that crossing (the ray abstains).
pub const NESTING_GRAZING_COS: f64 = 1e-3;

/// Ray directions (normalised at use). Generic on purpose: no component is zero or
/// repeats another, so no ray runs along a coordinate axis, a coordinate plane or a
/// diagonal, where modelled geometry tends to put edges and tangencies. Odd in number so
/// that a full vote cannot tie.
pub const RAY_DIRECTIONS: [[f64; 3]; 5] = [
    [0.2873, 0.4636, 0.8380],
    [-0.6435, 0.5404, 0.5419],
    [0.7713, -0.1974, 0.5864],
    [-0.3218, -0.8961, 0.3058],
    [0.4912, 0.2502, -0.8343],
];

/// Bisection steps for a polynomial root (the bracket reaches adjacent doubles well
/// before this).
const BISECTION_STEPS: usize = 200;

/// The faces of one shell with their reconstructed domains and outward-normal signs.
pub(crate) struct ShellFaces<'a> {
    faces: Vec<(FaceDomain<'a>, f64)>,
}

impl<'a> ShellFaces<'a> {
    pub fn new(body: &'a Body, shell: ShellId, gap_tol: f64) -> Result<Self, CheckError> {
        let sh = body.shell(shell).ok_or(CheckError::Empty)?;
        let mut faces = Vec::with_capacity(sh.faces.len());
        for &fid in &sh.faces {
            let f = body.face(fid).ok_or(CheckError::Empty)?;
            faces.push((
                face_domain(body, f, gap_tol)?,
                if f.sense { 1.0 } else { -1.0 },
            ));
        }
        Ok(Self { faces })
    }

    /// A point on the shell: the start of its first face's boundary, or a point of the
    /// surface of a face without loops (whole sphere or torus).
    pub fn sample_point(&self) -> Result<Point3, CheckError> {
        let (dom, _) = self.faces.first().ok_or(CheckError::Empty)?;
        let uv = match dom.pieces().next() {
            Some(p) => p.start(),
            None => {
                let ((u0, u1), (v0, v1)) = dom.surface.domain();
                Vec2::new(0.5 * (u0 + u1), 0.5 * (v0 + v1))
            }
        };
        Ok(dom.surface.eval(uv.x, uv.y))
    }
}

/// `true` if `p` lies inside the region bounded by `shell`, whose signed volume has the
/// sign `orientation`; `bounds` is the shell's tight box and `tie` the distance along a
/// ray below which two crossings are the same point. `what` names the shell in errors.
pub(crate) fn inside(
    shell: &ShellFaces<'_>,
    orientation: f64,
    bounds: &Aabb,
    p: Point3,
    tie: f64,
    what: &dyn Fn() -> String,
) -> Result<bool, CheckError> {
    let (lo, hi) = (bounds.min.to_array(), bounds.max.to_array());
    let q = p.to_array();
    if (0..3).any(|k| q[k] < lo[k] - tie || q[k] > hi[k] + tie) {
        return Ok(false);
    }
    // Every crossing lies in the box, so no ray needs to be longer than this.
    let reach = p.distance(bounds.center()) + 0.5 * bounds.max.distance(bounds.min) + 1.0;
    let (mut ins, mut outs) = (0usize, 0usize);
    for d in RAY_DIRECTIONS {
        let d = Vec3::new(d[0], d[1], d[2])
            .normalize()
            .expect("non-zero direction");
        match ray_vote(shell, orientation, p, d, reach, tie) {
            Some(true) => ins += 1,
            Some(false) => outs += 1,
            None => {}
        }
    }
    match ins.cmp(&outs) {
        std::cmp::Ordering::Greater => Ok(true),
        std::cmp::Ordering::Less => Ok(false),
        std::cmp::Ordering::Equal => Err(CheckError::AmbiguousNesting { shell: what() }),
    }
}

/// One ray's verdict (`None`: ill-conditioned, see the module docs).
fn ray_vote(
    shell: &ShellFaces<'_>,
    orientation: f64,
    p: Point3,
    d: Vec3,
    reach: f64,
    tie: f64,
) -> Option<bool> {
    // Candidate crossings of the carrying surfaces, nearest first.
    let mut cands: Vec<(f64, usize)> = Vec::new();
    for (i, (dom, _)) in shell.faces.iter().enumerate() {
        for t in surface_crossings(dom.surface, p, d, reach) {
            cands.push((t, i));
        }
    }
    cands.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    // The first crossing inside its face's domain, then every other one within `tie`.
    let mut first: Option<(f64, f64)> = None;
    for (t, i) in cands {
        if first.is_some_and(|(t0, _)| t > t0 + tie) {
            break;
        }
        let (dom, sense) = &shell.faces[i];
        let x = p + d * t;
        let (u, v, _) = dom.surface.project(x);
        if !contains(dom, u, v) {
            continue;
        }
        let n = dom.surface.normal(u, v)?;
        let cos = d.dot(n) * sense * orientation;
        if cos.abs() < NESTING_GRAZING_COS {
            return None;
        }
        match first {
            None => first = Some((t, cos)),
            Some((_, c0)) if (c0 > 0.0) != (cos > 0.0) => return None,
            Some(_) => {}
        }
    }
    // Leaving the region at the nearest crossing: the point is inside. No crossing: outside.
    Some(first.is_some_and(|(_, cos)| cos > 0.0))
}

/// Parameters `t ∈ (0, reach]` where `p + t·d` crosses the (untrimmed) surface, i.e. the
/// sign changes of its implicit equation along the ray. Tangent touches without a sign
/// change are not crossings.
fn surface_crossings(surface: &Surface, p: Point3, d: Vec3, reach: f64) -> Vec<f64> {
    let frame = match surface {
        Surface::Plane(s) => s.frame(),
        Surface::Cylinder(s) => s.frame(),
        Surface::Cone(s) => s.frame(),
        Surface::Sphere(s) => s.frame(),
        Surface::Torus(s) => s.frame(),
        // The mass properties reject B-spline faces before nesting is checked.
        Surface::BSpline(_) => return Vec::new(),
    };
    let o = frame.to_local_point(p);
    let d = frame.to_local_vector(d);
    let dd = d.dot(d);
    let od = o.dot(d);
    let oo = o.dot(o);
    // Radial (x, y) parts: ρ(t)² = e2·t² + e1·t + e0.
    let e2 = d.x * d.x + d.y * d.y;
    let e1 = 2.0 * (o.x * d.x + o.y * d.y);
    let e0 = o.x * o.x + o.y * o.y;
    // Coefficients in ascending powers of t.
    let c: Vec<f64> = match surface {
        Surface::Plane(_) => vec![o.z, d.z],
        Surface::Cylinder(s) => {
            let r = s.radius();
            vec![e0 - r * r, e1, e2]
        }
        Surface::Cone(s) => {
            // ρ² = (R + k·z)² on the double cone.
            let k = math::tan(s.half_angle());
            let (w0, w1) = (s.radius() + k * o.z, k * d.z);
            vec![e0 - w0 * w0, e1 - 2.0 * w0 * w1, e2 - w1 * w1]
        }
        Surface::Sphere(s) => {
            let r = s.radius();
            vec![oo - r * r, 2.0 * od, dd]
        }
        Surface::Torus(s) => {
            // (|x|² + R² − r²)² = 4R²·ρ², with |x|² = dd·t² + 2·od·t + oo.
            let (big, small) = (s.major(), s.minor());
            let a0 = oo + big * big - small * small;
            let f = 4.0 * big * big;
            vec![
                a0 * a0 - f * e0,
                4.0 * a0 * od - f * e1,
                4.0 * od * od + 2.0 * dd * a0 - f * e2,
                4.0 * dd * od,
                dd * dd,
            ]
        }
        Surface::BSpline(_) => return Vec::new(),
    };
    sign_changes(&c, 0.0, reach)
}

fn horner(c: &[f64], t: f64) -> f64 {
    c.iter().rev().fold(0.0, |acc, &k| acc * t + k)
}

/// The points in `(lo, hi]` where the polynomial `Σ c[k]·t^k` changes sign, in increasing
/// order. The extrema (sign changes of the derivative, found recursively) split the
/// interval into monotone pieces; a piece whose ends differ in sign holds exactly one
/// crossing, found by bisection. Deterministic: no tolerances, no iteration counts that
/// depend on the data beyond [`BISECTION_STEPS`].
fn sign_changes(c: &[f64], lo: f64, hi: f64) -> Vec<f64> {
    let mut n = c.len();
    while n > 0 && c[n - 1] == 0.0 {
        n -= 1;
    }
    let c = &c[..n];
    if n <= 1 {
        return Vec::new();
    }
    if n == 2 {
        let t = -c[0] / c[1];
        return if t > lo && t <= hi {
            vec![t]
        } else {
            Vec::new()
        };
    }
    let dc: Vec<f64> = (1..n).map(|k| c[k] * k as f64).collect();
    let mut knots = vec![lo];
    knots.extend(sign_changes(&dc, lo, hi));
    knots.push(hi);
    let neg = |t: f64| horner(c, t) < 0.0;
    let mut out = Vec::new();
    for w in knots.windows(2) {
        let (mut a, mut b) = (w[0], w[1]);
        let na = neg(a);
        if na == neg(b) {
            continue;
        }
        for _ in 0..BISECTION_STEPS {
            let m = 0.5 * (a + b);
            if m <= a || m >= b {
                break;
            }
            if neg(m) == na {
                a = m;
            } else {
                b = m;
            }
        }
        out.push(0.5 * (a + b));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_changes_find_simple_roots_and_skip_touches() {
        // (t − 1)(t − 2)(t − 3)(t − 4)
        let c = [24.0, -50.0, 35.0, -10.0, 1.0];
        let r = sign_changes(&c, 0.0, 10.0);
        assert_eq!(r.len(), 4, "{r:?}");
        for (x, want) in r.iter().zip([1.0, 2.0, 3.0, 4.0]) {
            assert!((x - want).abs() < 1e-12, "{r:?}");
        }
        // (t − 2)² touches zero without crossing.
        assert!(sign_changes(&[4.0, -4.0, 1.0], 0.0, 10.0).is_empty());
        // Roots outside (lo, hi] are not reported.
        assert_eq!(sign_changes(&c, 1.5, 3.5).len(), 2);
    }

    #[test]
    fn ray_crossings_of_every_analytic_surface_match_closed_forms() {
        use forge_core::geom::{Cone, Cylinder, Plane, Sphere, SpindlePatch, Torus};
        use forge_core::linalg::Frame;
        let w = Frame::world;
        let x = Vec3::new(1.0, 0.0, 0.0);
        let s375 = 3.75f64.sqrt();
        let cases: Vec<(Surface, Point3, Vec3, Vec<f64>)> = vec![
            (
                Surface::Plane(Plane::new(w())),
                Vec3::new(0.3, 0.2, -2.0),
                Vec3::new(0.0, 0.0, 1.0),
                vec![2.0],
            ),
            (
                Surface::Cylinder(Cylinder::new(w(), 2.0).expect("cylinder")),
                Vec3::new(-5.0, 0.5, 1.0),
                x,
                vec![5.0 - s375, 5.0 + s375],
            ),
            // Double cone ρ = |1 + z| (45°): both nappes are crossed at z = 0 … ρ = 1.
            (
                Surface::Cone(Cone::new(w(), 1.0, forge_core::math::FRAC_PI_4).expect("cone")),
                Vec3::new(-5.0, 0.0, 0.0),
                x,
                vec![4.0, 6.0],
            ),
            (
                Surface::Sphere(Sphere::new(w(), 3.0).expect("sphere")),
                Vec3::new(-5.0, 0.0, 0.0),
                x,
                vec![2.0, 8.0],
            ),
            (
                Surface::Torus(Torus::new(w(), 10.0, 3.0).expect("ring")),
                Vec3::new(-20.0, 0.0, 0.0),
                x,
                vec![7.0, 13.0, 27.0, 33.0],
            ),
            // Horn torus R = r = 3 at height z = 1: ρ = 3 ± √8.
            (
                Surface::Torus(Torus::new(w(), 3.0, 3.0).expect("horn")),
                Vec3::new(-10.0, 0.0, 1.0),
                x,
                vec![
                    7.0 - 8f64.sqrt(),
                    7.0 + 8f64.sqrt(),
                    13.0 - 8f64.sqrt(),
                    13.0 + 8f64.sqrt(),
                ],
            ),
            // Spindle torus R = 2, r = 3: apple at |x| = 5, lemon at |x| = 1.
            (
                Surface::Torus(
                    Torus::spindle(w(), 2.0, 3.0, SpindlePatch::Outer).expect("spindle"),
                ),
                Vec3::new(-10.0, 0.0, 0.0),
                x,
                vec![5.0, 9.0, 11.0, 15.0],
            ),
        ];
        for (surface, p, d, want) in cases {
            let got = surface_crossings(&surface, p, d, 100.0);
            assert_eq!(got.len(), want.len(), "{}: {got:?}", surface.kind_name());
            for (g, w) in got.iter().zip(&want) {
                assert!(
                    (g - w).abs() < 1e-9,
                    "{}: {got:?} vs {want:?}",
                    surface.kind_name()
                );
            }
        }
        // Through the horn centre the ray only touches the surface (a double root at
        // t = 10). Rounding may split the touch into a pair of crossings a few 1e-7
        // apart, which `ray_vote` treats as ill-conditioned (opposite signs within the
        // tie distance); it never shows up as a single crossing.
        let horn = Surface::Torus(Torus::new(w(), 3.0, 3.0).expect("horn"));
        let got = surface_crossings(&horn, Vec3::new(-10.0, 0.0, 0.0), x, 100.0);
        let (ends, touch): (Vec<f64>, Vec<f64>) =
            got.iter().partition(|t| (*t - 10.0).abs() > 1e-6);
        assert_eq!(ends.len(), 2, "{got:?}");
        assert!(
            (ends[0] - 4.0).abs() < 1e-9 && (ends[1] - 16.0).abs() < 1e-9,
            "{got:?}"
        );
        assert!(touch.len() % 2 == 0, "{got:?}");
    }
}
