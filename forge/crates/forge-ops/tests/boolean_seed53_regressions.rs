//! Boolean seed-53 regressions (BACKLOG P1 "Boolean explicit errors"): two cylinders tangent
//! at a point that lies on the seam of the search surface's parameter box (`u = π`, the
//! start of a full period) used to fail with `FORGE_BOOLEAN_SSI` (`SSI_NOT_CONVERGED` after
//! 0 iterations): the march reached the tangent point from the far end of the period and
//! looked for its cluster without wrapping (forge-ssi `nearest_cluster`).
//!
//! Every result is checked for validity and against an **independent** closed-form volume
//! (a one-dimensional integral of exact cross-section areas, adaptive Simpson), and the
//! three operations against each other: `vol(A ∪ B) = vol A + vol B − vol(A ∩ B)`,
//! `vol(A − B) = vol A − vol(A ∩ B)`.

use forge_core::Severity;
use forge_core::topo::Body;
use forge_ir::v1::metrics::Origin;
use forge_ops::boolean::corpus::{Case, cases};
use forge_ops::boolean::{BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op};

fn ob(body: Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "m".into(),
            instance: None,
        },
        timeline,
    }
}

fn case(id: usize) -> Case {
    cases(53, id + 1)
        .into_iter()
        .find(|c| c.id == id)
        .expect("corpus case")
}

fn run(c: &Case, op: BodyOp) -> Result<BodyOpResult, BooleanError> {
    let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
    apply_body_op(op, &[ob(a, "a", 0)], &[ob(b, "b", 1)], "g")
}

fn volume(b: &Body) -> f64 {
    forge_check::mass_properties(b).expect("mass").volume
}

/// Total volume of a successful result, every body valid.
fn checked_volume(r: &BodyOpResult, what: &str) -> f64 {
    r.bodies
        .iter()
        .map(|x| {
            let errs: Vec<_> = forge_check::validate(&x.body)
                .into_iter()
                .filter(|i| i.severity == Severity::Error)
                .collect();
            assert!(errs.is_empty(), "{what}: invalid result: {errs:?}");
            volume(&x.body)
        })
        .sum()
}

/// Adaptive Simpson (deterministic; the reference integrals below are smooth apart from
/// square-root end points and kinks, which the subdivision resolves).
fn simpson(f: &dyn Fn(f64) -> f64, a: f64, b: f64, eps: f64) -> f64 {
    #[allow(clippy::too_many_arguments)]
    fn rec(
        f: &dyn Fn(f64) -> f64,
        a: f64,
        b: f64,
        fa: f64,
        fb: f64,
        fc: f64,
        whole: f64,
        eps: f64,
        depth: u32,
    ) -> f64 {
        let c = 0.5 * (a + b);
        let (l, r) = (0.5 * (a + c), 0.5 * (c + b));
        let (fl, fr) = (f(l), f(r));
        let left = (c - a) / 6.0 * (fa + 4.0 * fl + fc);
        let right = (b - c) / 6.0 * (fc + 4.0 * fr + fb);
        if depth > 50 || (left + right - whole).abs() <= 15.0 * eps {
            return left + right + (left + right - whole) / 15.0;
        }
        rec(f, a, c, fa, fc, fl, left, 0.5 * eps, depth + 1)
            + rec(f, c, b, fc, fb, fr, right, 0.5 * eps, depth + 1)
    }
    let c = 0.5 * (a + b);
    let (fa, fb, fc) = (f(a), f(b), f(c));
    rec(
        f,
        a,
        b,
        fa,
        fb,
        fc,
        (b - a) / 6.0 * (fa + 4.0 * fc + fb),
        eps,
        0,
    )
}

/// #38 `A ∩ B`: A the z-cylinder `(x − 2.75)² + (y − 3)² ≤ 16`, `z ∈ [−3, 4]`; B the
/// y-cylinder `(x + 0.25)² + (z + 2.5)² ≤ 1`, `y ∈ [−2.25, 2.25]` (tangent to A inside it at
/// `(−1.25, 3, −2.5)`, on A's seam). At height `y` the section is B's disc cut by
/// `x ≥ 2.75 − √(16 − (y − 3)²)` and `z ≥ −3`; with `x = −0.25 + sin t` its area is
/// `∫ L(t) cos t dt`, `L = 2 cos t` where `cos t ≤ ½` and `cos t + ½` elsewhere.
fn case_38_intersection_volume() -> f64 {
    let area = |y: f64| -> f64 {
        let s2 = 16.0 - (y - 3.0) * (y - 3.0);
        if s2 <= 0.0 {
            return 0.0;
        }
        let a = (2.75 - s2.sqrt()).max(-1.25);
        if a >= 0.75 {
            return 0.0;
        }
        let ta = (a + 0.25).clamp(-1.0, 1.0).asin();
        let k = std::f64::consts::FRAC_PI_3;
        let two_cos2 = |t: f64| t + t.sin() * t.cos();
        let cos2_half_cos = |t: f64| 0.5 * t + 0.25 * (2.0 * t).sin() + 0.5 * t.sin();
        let mut pts = vec![ta];
        pts.extend([-k, k].into_iter().filter(|&p| p > ta));
        pts.push(std::f64::consts::FRAC_PI_2);
        pts.windows(2)
            .map(|w| {
                let f = if (0.5 * (w[0] + w[1])).abs() < k {
                    cos2_half_cos
                } else {
                    two_cos2
                };
                f(w[1]) - f(w[0])
            })
            .sum()
    };
    simpson(&area, -2.25, 2.25, 1e-13)
}

/// #387 `A ∩ B`: A the x-cylinder `(y − 1.5)² + (z − 1)² ≤ 25`, `x ∈ [−3.5, 0.5]`; B the
/// z-prism over the stadium `x ∈ [−2, 8]`, `y ∈ [−3.5, 0.5]` (caps of radius 2 centred at
/// `x = 0` and `x = 6`), `z ∈ [−1, 6.5]`; tangent at `(0, −3.5, 1)`, on A's seam. At `y` the
/// section is a rectangle: `x ∈ [−√(4 − (y + 1.5)²), 0.5]` times A's chord clipped to
/// `[−1, 6.5]` (`2h` or `h + 2`, `h = √(25 − (y − 1.5)²)`).
fn case_387_intersection_volume() -> f64 {
    let f = |y: f64| -> f64 {
        let h = (25.0 - (y - 1.5) * (y - 1.5)).max(0.0).sqrt();
        let len = if h >= 2.0 { h + 2.0 } else { 2.0 * h };
        let w = 0.5 + (4.0 - (y + 1.5) * (y + 1.5)).max(0.0).sqrt();
        len * w
    };
    simpson(&f, -3.5, 0.5, 1e-13)
}

#[test]
fn slot_tangent_to_a_cylinder_on_its_seam_387_joins_cuts_and_intersects() {
    let c = case(387);
    assert_eq!(c.family, "slot");
    let (va, vb) = (
        volume(&c.a.build().expect("a")),
        volume(&c.b.build().expect("b")),
    );
    let vi = checked_volume(&run(&c, BodyOp::Intersect).expect("intersect"), "∩");
    let want = case_387_intersection_volume();
    assert!(
        (vi - want).abs() <= 1e-8 * want,
        "intersection {vi} vs closed form {want}"
    );
    let vj = checked_volume(&run(&c, BodyOp::Join).expect("join"), "∪");
    let vc = checked_volume(&run(&c, BodyOp::Cut).expect("cut"), "−");
    let s = 1e-9 * (va + vb);
    assert!(
        (vj - (va + vb - vi)).abs() <= s,
        "join {vj} vs {}",
        va + vb - vi
    );
    assert!((vc - (va - vi)).abs() <= s, "cut {vc} vs {}", va - vi);
}

#[test]
fn cylinders_tangent_on_the_seam_38_intersect_and_fail_join_cut_only_in_loop_orientation() {
    let c = case(38);
    assert_eq!(c.family, "cyl-cyl");
    let (va, vb) = (
        volume(&c.a.build().expect("a")),
        volume(&c.b.build().expect("b")),
    );
    let vi = checked_volume(&run(&c, BodyOp::Intersect).expect("intersect"), "∩");
    let want = case_38_intersection_volume();
    assert!(
        (vi - want).abs() <= 1e-9 * want,
        "intersection {vi} vs closed form {want}"
    );
    // Join and cut: the sections are right (the intersection above uses the same ones), but
    // the remaining cap of A has a notch 0.28 mm deep beside a 322° arc edge, and
    // forge-core's planar loop-orientation check (9 samples per edge, the orientation read at
    // the extreme sampled vertex) misreads that loop: its sampled shoelace area has the sign
    // of a correct outer loop, only the extreme-vertex test disagrees. Today's outcome is
    // pinned exactly: FORGE_BOOLEAN_INVALID_RESULT (LOOP_ORIENTATION), an explicit failure,
    // never a body and never an SSI failure. When forge-core's loop orientation uses the
    // exact line/arc area (BACKLOG), this panics with the volumes: replace the pin by the
    // volume identities (`vol(A ∪ B) = vol A + vol B − vol(A ∩ B)`, `vol(A − B) = vol A −
    // vol(A ∩ B)`, relative 1e-9).
    for (op, want) in [(BodyOp::Join, va + vb - vi), (BodyOp::Cut, va - vi)] {
        match run(&c, op) {
            Ok(r) => {
                let v = checked_volume(&r, "38");
                panic!(
                    "{op:?} now succeeds (volume {v}, identity {want}, difference {:e}): \
                     forge-core's loop orientation was fixed; pin the volume identity instead",
                    v - want
                );
            }
            Err(e) => {
                assert_eq!(e.code(), "FORGE_BOOLEAN_INVALID_RESULT", "{op:?}: {e}");
                assert!(e.to_string().contains("LOOP_ORIENTATION"), "{op:?}: {e}");
            }
        }
    }
}

/// Area of the intersection of two discs of radii `big` and `small` whose centres are `d`
/// apart.
fn disc_lens(big: f64, small: f64, d: f64) -> f64 {
    if small <= 0.0 || d >= big + small {
        return 0.0;
    }
    if d <= (big - small).abs() {
        return std::f64::consts::PI * big.min(small).powi(2);
    }
    let c = |x: f64| x.clamp(-1.0, 1.0);
    small * small * c((d * d + small * small - big * big) / (2.0 * d * small)).acos()
        + big * big * c((d * d + big * big - small * small) / (2.0 * d * big)).acos()
        - 0.5
            * ((-d + small + big) * (d + small - big) * (d - small + big) * (d + small + big))
                .max(0.0)
                .sqrt()
}

/// #163 `A − B` (review round 5: the OCCT differential's `both_wrong` row). A is the cone
/// with base radius 5 at `y = 0.5` and apex at `y = 1.5` about the line `x = 0, z = 0.5`
/// (volume `25π/3`); B the unit sphere at `(−2, 0, 2.5)`, which pokes out of the cone's
/// side. At height `y ∈ [0.5, 1]` the common section is the lens of the cone's disc (radius
/// `5·(1.5 − y)`) and the sphere's (radius `√(1 − y²)`), centres `2√2` apart. Forge's body
/// is valid and matches this closed form to 1e-9; OCCT's is invalid (`BRepCheck`) with
/// 25.941 mm³, and the differential's grid "truth" (26.758 mm³) exceeds the cone itself,
/// so that row is an oracle-side failure, not a Forge-wrong one.
#[test]
fn cone_minus_sphere_163_matches_its_closed_form() {
    let c = case(163);
    assert_eq!(c.family, "revolve");
    let d = 2.0 * std::f64::consts::SQRT_2;
    let (cone_r, sphere_r) = (
        |y: f64| 5.0 * (1.5 - y),
        |y: f64| (1.0 - y * y).max(0.0).sqrt(),
    );
    let lens = |y: f64| disc_lens(cone_r(y), sphere_r(y), d);
    // The lens is smooth between the heights where the sphere's disc leaves the cone's
    // (`d + ρs = ρc`) and where they part (`d − ρs = ρc`): integrate piecewise.
    let root = |g: &dyn Fn(f64) -> f64| {
        let (mut lo, mut hi) = (0.5, 1.0);
        for _ in 0..200 {
            let mid = 0.5 * (lo + hi);
            if g(mid) > 0.0 { lo = mid } else { hi = mid }
        }
        0.5 * (lo + hi)
    };
    let leaves = root(&|y| cone_r(y) - d - sphere_r(y));
    let parts = root(&|y| cone_r(y) - d + sphere_r(y));
    let common: f64 = [(0.5, leaves), (leaves, parts)]
        .iter()
        .map(|&(a, b)| simpson(&lens, a, b, 1e-13))
        .sum();
    let want = 25.0 * std::f64::consts::PI / 3.0 - common;
    let v = checked_volume(&run(&c, BodyOp::Cut).expect("cut"), "163");
    assert!(
        (v - want).abs() <= 1e-9 * want,
        "cut {v} vs closed form {want}"
    );
}
