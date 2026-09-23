//! Closed-form booleans swept over the sphere's revolve axis (review round 4): the same
//! solid must give the same outcome, with the closed-form volume or the expected semantic
//! code, whichever world axis its poles lie on.
//!
//! - **Viviani family**: a ball of radius `R` and a cylinder of radius `r ∈ {R/4, R/2,
//!   3R/4}` tangent to it from inside (a figure-eight section with its double point on the
//!   ball), for every sphere axis × cylinder axis × offset direction and sign: the tangent
//!   point, or a crossing of the section, lies on a pole in many of them. Join and
//!   intersect against `(2/3) ∫ [(R² − ρ₁²)^{3/2} − (R² − ρ₂²)^{3/2}] dθ` (Viviani's
//!   `(2/3)(π − 4/3)R³` for `r = R/2`), cuts in both directions `BOOLEAN_NON_MANIFOLD`
//!   (the remaining material pinches at the tangent point).
//! - **Napkin rings**: a ball and a coaxial cylinder through it (`π h³ / 6`), and the
//!   cylinder of radius `R` tangent along the equator.
//! - **Spheres and cylinders on planes and caps**: tangent (no intersection) and dipping
//!   (spherical caps, circular segments), a sphere inside a box touching a face from
//!   inside, a sphere tangent to a cylinder's cap and side.
//! - **Voids**: a hollow ball as a tool (a cut whose result has a component bounded by the
//!   tool's void only) and as a target, and a box with a spherical cavity as a target.
//!
//! Volumes are compared at `1e-9` relative to the operands' volume (exact and fitted
//! boundaries alike).

use forge_core::topo::{Body, Severity};
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep, cylinder_operand, sphere_operand};
use forge_ops::boolean::{BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op};

const PI: f64 = std::f64::consts::PI;

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

fn op(o: BodyOp, a: &Body, b: &Body) -> Result<BodyOpResult, BooleanError> {
    apply_body_op(o, &[ob(a.clone(), "a", 0)], &[ob(b.clone(), "b", 1)], "g")
}

fn volume(b: &Body) -> f64 {
    forge_check::mass_properties(b).expect("mass").volume
}

fn ball(r: f64) -> f64 {
    4.0 / 3.0 * PI * r * r * r
}

fn sphere(feature: &str, c: [f64; 3], r: f64, axis: usize) -> Body {
    sphere_operand(feature, c, r, axis).build().expect("sphere")
}

fn cyl(feature: &str, axis: usize, c: [f64; 2], lo: f64, r: f64, h: f64) -> Body {
    cylinder_operand(feature, axis, c, lo, r, h)
        .build()
        .expect("cylinder")
}

fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Body {
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    let (x0, y0, w, h) = (lo[0], lo[1], size[0], size[1]);
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(Frame {
                origin: [0.0, 0.0, lo[2]],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves: vec![
                l("b", [x0, y0], [x0 + w, y0]),
                l("r", [x0 + w, y0], [x0 + w, y0 + h]),
                l("t", [x0 + w, y0 + h], [x0, y0 + h]),
                l("l", [x0, y0 + h], [x0, y0]),
            ],
        },
        sweep: Sweep::Extrude {
            distance: size[2],
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("box")
}

/// Every body of a successful operation, checked valid; their total volume.
fn total(r: &BodyOpResult, what: &str) -> f64 {
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

/// What an operation is expected to give.
#[derive(Clone, Copy, Debug)]
enum Want {
    /// Bodies of this total volume (`pieces` of them), listed in `bodies`.
    Volume { v: f64, pieces: usize },
    /// The target unchanged and not listed (`untouched`).
    Untouched,
    /// The target consumed (`removed`, `BOOLEAN_BODY_CONSUMED`).
    Consumed,
    /// This error code.
    Code(&'static str),
}

/// Check one outcome; `scale` is the operands' volume for the relative tolerance.
/// Returns the relative volume error (0 for code outcomes).
fn check(r: Result<BodyOpResult, BooleanError>, want: Want, scale: f64, what: &str) -> f64 {
    match (want, r) {
        (Want::Volume { v, pieces }, Ok(r)) => {
            assert_eq!(r.bodies.len(), pieces, "{what}: bodies");
            assert!(
                r.untouched.is_empty() && r.removed.is_empty(),
                "{what}: {r:?}"
            );
            let got = total(&r, what);
            let rel = (got - v).abs() / scale;
            assert!(
                rel <= 1e-9,
                "{what}: volume {got} vs {v} ({rel:.2e} relative)"
            );
            if pieces > 1 {
                assert!(
                    r.notes.iter().any(|n| n.code() == "BOOLEAN_SPLIT"),
                    "{what}: split without BOOLEAN_SPLIT"
                );
            }
            rel
        }
        (Want::Untouched, Ok(r)) => {
            assert!(
                r.bodies.is_empty() && r.untouched.len() == 1,
                "{what}: expected the target untouched, got {} bodies",
                r.bodies.len()
            );
            0.0
        }
        (Want::Consumed, Ok(r)) => {
            assert!(
                r.bodies.is_empty() && r.removed.len() == 1,
                "{what}: expected the target consumed"
            );
            assert!(
                r.notes.iter().any(|n| n.code() == "BOOLEAN_BODY_CONSUMED"),
                "{what}: no BOOLEAN_BODY_CONSUMED"
            );
            0.0
        }
        (Want::Code(c), Err(e)) => {
            assert_eq!(e.code(), c, "{what}: {e}");
            0.0
        }
        (w, Ok(r)) => panic!(
            "{what}: expected {w:?}, got {} bodies ({} mm³)",
            r.bodies.len(),
            total(&r, what)
        ),
        (w, Err(e)) => panic!("{what}: expected {w:?}, got {} {e}", e.code()),
    }
}

/// Run `jobs` on all cores (each job is independent and deterministic; results come back
/// in job order).
fn par<T: Send + Sync, R: Send>(jobs: Vec<T>, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let n = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(jobs.len().max(1));
    let next = std::sync::atomic::AtomicUsize::new(0);
    let out: Vec<std::sync::Mutex<Option<R>>> =
        jobs.iter().map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..n {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if i >= jobs.len() {
                        break;
                    }
                    let r = f(&jobs[i]);
                    *out[i].lock().expect("lock") = Some(r);
                }
            });
        }
    });
    out.into_iter()
        .map(|m| m.into_inner().expect("lock").expect("job ran"))
        .collect()
}

/// `∫_a^b f` by tanh-sinh quadrature (endpoint singularities of the integrand allowed).
fn tanh_sinh(f: impl Fn(f64) -> f64, a: f64, b: f64) -> f64 {
    let (c, m) = (0.5 * (a + b), 0.5 * (b - a));
    let h = 1.0 / 64.0;
    let mut s = 0.0;
    for k in -320..=320 {
        let t = k as f64 * h;
        let u = 0.5 * PI * t.sinh();
        let x = u.tanh();
        let w = 0.5 * PI * t.cosh() / (u.cosh() * u.cosh());
        if x.abs() < 1.0 {
            s += w * f(c + m * x);
        }
    }
    s * h * m
}

/// Volume of a ball of radius `big_r` intersected with an infinite cylinder of radius `r`
/// tangent to it from inside (axis at distance `big_r − r` from the centre): in polar
/// coordinates about the centre, `V = (2/3) ∫ [(R² − ρ₁²)^{3/2} − (R² − ρ₂²)^{3/2}] dθ`
/// over the chords `ρ₁ ≤ ρ ≤ ρ₂` of the cylinder's cross-section disc. For `r = R/2`
/// this is Viviani's `(2/3)(π − 4/3) R³`.
fn ball_tangent_cylinder(big_r: f64, r: f64) -> f64 {
    let d = big_r - r;
    let cube = |x: f64| (big_r * big_r - x * x).max(0.0).powf(1.5);
    let chord = |th: f64| {
        let q = (r * r - d * d * th.sin() * th.sin()).max(0.0).sqrt();
        (d * th.cos() - q, d * th.cos() + q)
    };
    let f = |th: f64| {
        let (r1, r2) = chord(th);
        cube(r1.max(0.0)) - cube(r2)
    };
    let lim = if r >= d { PI } else { (r / d).asin() };
    (2.0 / 3.0) * (tanh_sinh(f, -lim, 0.0) + tanh_sinh(f, 0.0, lim))
}

/// Napkin ring left when a cylinder of radius `r` is drilled through the centre of a ball
/// of radius `big_r`: `π h³ / 6`, `h = 2 √(R² − r²)`.
fn napkin(big_r: f64, r: f64) -> f64 {
    let h = 2.0 * (big_r * big_r - r * r).sqrt();
    PI * h * h * h / 6.0
}

/// Spherical cap of height `h` of a ball of radius `r`.
fn cap(r: f64, h: f64) -> f64 {
    PI * h * h * (3.0 * r - h) / 3.0
}

#[test]
fn closed_forms_match_known_values() {
    let big_r = 4.0f64;
    let viviani = (2.0 / 3.0) * (PI - 4.0 / 3.0) * big_r.powi(3);
    let v = ball_tangent_cylinder(big_r, 2.0);
    assert!((v - viviani).abs() <= 1e-12 * viviani, "{v} vs {viviani}");
    // A cylinder of radius → R becomes the whole ball; → 0 nothing.
    assert!((ball_tangent_cylinder(big_r, 4.0) - ball(4.0)).abs() <= 1e-9 * ball(4.0));
    assert!(ball_tangent_cylinder(big_r, 1e-3) < 1e-6);
    // Napkin ring of height 6 is 36π whatever the ball.
    assert!((napkin(5.0, 4.0) - 36.0 * PI).abs() <= 1e-12 * 36.0 * PI);
    assert!((cap(2.0, 4.0) - ball(2.0)).abs() <= 1e-12);
}

/// The review's sweep: 3 radii × 3 sphere axes × 3 cylinder axes × 2 offset directions ×
/// 2 signs = 108 configurations, each joined, intersected and cut both ways, and the join
/// and intersection repeated with the operands swapped (the section's double point, or a
/// crossing, lies on a pole in many of them: they used to fail with inverted sphere faces
/// or "the curve passes through a singular point").
#[test]
fn sphere_with_an_internally_tangent_cylinder_on_every_axis() {
    let big_r = 4.0;
    // Debug builds run a subset that still puts the tangent point and crossings on poles.
    let full = !cfg!(debug_assertions);
    let mut jobs = Vec::new();
    for r in [1.0, 2.0, 3.0] {
        for ax in 0..3 {
            for ca in 0..3 {
                for off in 0..2 {
                    for sign in [1.0, -1.0] {
                        if full || (ax == 0 && sign > 0.0 && off == 0 && r < 3.0) {
                            jobs.push((r, ax, ca, off, sign));
                        }
                    }
                }
            }
        }
    }
    let worst = par(jobs, |&(r, ax, ca, off, sign)| {
        let mut c = [0.0, 0.0];
        c[off] = sign * (big_r - r);
        let s = sphere("s", [0.0; 3], big_r, ax);
        let cy = cyl("c", ca, c, -5.0, r, 10.0);
        let (vs, vc) = (ball(big_r), PI * r * r * 10.0);
        let vi = ball_tangent_cylinder(big_r, r);
        let scale = vs + vc;
        let what =
            |o: &str| format!("r {r} sphere axis {ax} cylinder axis {ca} offset {off} {sign} {o}");
        let mut w: f64 = 0.0;
        w = w.max(check(
            op(BodyOp::Join, &s, &cy),
            Want::Volume {
                v: vs + vc - vi,
                pieces: 1,
            },
            scale,
            &what("join"),
        ));
        w = w.max(check(
            op(BodyOp::Intersect, &s, &cy),
            Want::Volume { v: vi, pieces: 1 },
            scale,
            &what("intersect"),
        ));
        check(
            op(BodyOp::Cut, &s, &cy),
            Want::Code("BOOLEAN_NON_MANIFOLD"),
            scale,
            &what("cut"),
        );
        check(
            op(BodyOp::Cut, &cy, &s),
            Want::Code("BOOLEAN_NON_MANIFOLD"),
            scale,
            &what("cylinder − sphere"),
        );
        w = w.max(check(
            op(BodyOp::Join, &cy, &s),
            Want::Volume {
                v: vs + vc - vi,
                pieces: 1,
            },
            scale,
            &what("join swapped"),
        ));
        w = w.max(check(
            op(BodyOp::Intersect, &cy, &s),
            Want::Volume { v: vi, pieces: 1 },
            scale,
            &what("intersect swapped"),
        ));
        w
    });
    let w = worst.iter().copied().fold(0.0, f64::max);
    eprintln!("Viviani family: worst volume error {w:.2e} relative");
}

/// Napkin rings: a ball of radius 4 drilled through its centre along every axis (with its
/// poles on the drill's axis, or not), and the drill of radius 4 that touches the ball
/// along its equator (the ball is consumed by the cut and unchanged by the intersection).
#[test]
fn napkin_rings_on_every_axis() {
    let big_r = 4.0;
    let full = !cfg!(debug_assertions);
    let mut jobs = Vec::new();
    for r in [1.0, 2.5, 4.0] {
        for ax in 0..3 {
            for ca in 0..3 {
                if full || (ax != 1 && ca != 2) {
                    jobs.push((r, ax, ca));
                }
            }
        }
    }
    let worst = par(jobs, |&(r, ax, ca)| {
        let s = sphere("s", [0.0; 3], big_r, ax);
        let cy = cyl("c", ca, [0.0, 0.0], -5.0, r, 10.0);
        let (vs, vc) = (ball(big_r), PI * r * r * 10.0);
        let scale = vs + vc;
        let what = |o: &str| format!("r {r} sphere axis {ax} drill axis {ca} {o}");
        let mut w: f64 = 0.0;
        if r < big_r {
            let n = napkin(big_r, r);
            w = w.max(check(
                op(BodyOp::Cut, &s, &cy),
                Want::Volume { v: n, pieces: 1 },
                scale,
                &what("cut"),
            ));
            w = w.max(check(
                op(BodyOp::Intersect, &s, &cy),
                Want::Volume {
                    v: vs - n,
                    pieces: 1,
                },
                scale,
                &what("intersect"),
            ));
            w = w.max(check(
                op(BodyOp::Join, &s, &cy),
                Want::Volume {
                    v: vc + n,
                    pieces: 1,
                },
                scale,
                &what("join"),
            ));
        } else {
            // Tangent along the equator: the ball lies inside the drill.
            check(
                op(BodyOp::Cut, &s, &cy),
                Want::Consumed,
                scale,
                &what("cut"),
            );
            w = w.max(check(
                op(BodyOp::Intersect, &s, &cy),
                Want::Volume { v: vs, pieces: 1 },
                scale,
                &what("intersect"),
            ));
            w = w.max(check(
                op(BodyOp::Join, &s, &cy),
                Want::Volume { v: vc, pieces: 1 },
                scale,
                &what("join"),
            ));
            check(
                op(BodyOp::Join, &cy, &s),
                Want::Untouched,
                scale,
                &what("drill ∪ ball"),
            );
            // The cavity touches the drill's wall along the equator: zero thickness there.
            check(
                op(BodyOp::Cut, &cy, &s),
                Want::Code("BOOLEAN_NON_MANIFOLD"),
                scale,
                &what("drill − ball"),
            );
        }
        w
    });
    let w = worst.iter().copied().fold(0.0, f64::max);
    eprintln!("napkin rings: worst volume error {w:.2e} relative");
}

/// A ball of radius 2 on the top face `z = 0` of the box `[−5, 5]² × [−5, 0]`: tangent
/// from outside at its lowest point (a pole for the Z axis), dipping by `h`, and tangent
/// from inside at its highest point.
#[test]
fn spheres_on_a_plane_on_every_axis() {
    let mut jobs = Vec::new();
    for ax in 0..3 {
        for zc in [2.0, 1.0, 0.0, -1.0, -2.0] {
            // Off-centre too: the contact point away from the box's symmetry lines.
            for xy in [[0.0, 0.0], [1.25, -0.75]] {
                jobs.push((ax, zc, xy));
            }
        }
    }
    let worst = par(jobs, |&(ax, zc, xy)| {
        let bx = aabox("a", [-5.0, -5.0, -5.0], [10.0, 10.0, 5.0]);
        let s = sphere("s", [xy[0], xy[1], zc], 2.0, ax);
        let (vb, vs) = (500.0, ball(2.0));
        let scale = vb + vs;
        let what = |o: &str| format!("sphere axis {ax} centre z {zc} at {xy:?} {o}");
        let mut w: f64 = 0.0;
        let h = 2.0 - zc; // depth of the dip below z = 0
        if zc >= 2.0 {
            check(
                op(BodyOp::Join, &bx, &s),
                Want::Code("BOOLEAN_NO_INTERSECTION"),
                scale,
                &what("join"),
            );
            check(
                op(BodyOp::Cut, &bx, &s),
                Want::Code("BOOLEAN_NO_INTERSECTION"),
                scale,
                &what("cut"),
            );
            check(
                op(BodyOp::Intersect, &bx, &s),
                Want::Code("BOOLEAN_EMPTY_RESULT"),
                scale,
                &what("intersect"),
            );
        } else if zc <= -2.0 {
            // Inside the box, touching the top face from below at one point.
            check(
                op(BodyOp::Join, &bx, &s),
                Want::Untouched,
                scale,
                &what("join"),
            );
            check(
                op(BodyOp::Cut, &bx, &s),
                Want::Code("BOOLEAN_NON_MANIFOLD"),
                scale,
                &what("cut"),
            );
            w = w.max(check(
                op(BodyOp::Intersect, &bx, &s),
                Want::Volume { v: vs, pieces: 1 },
                scale,
                &what("intersect"),
            ));
        } else {
            let c = cap(2.0, h);
            w = w.max(check(
                op(BodyOp::Join, &bx, &s),
                Want::Volume {
                    v: vb + vs - c,
                    pieces: 1,
                },
                scale,
                &what("join"),
            ));
            w = w.max(check(
                op(BodyOp::Cut, &bx, &s),
                Want::Volume {
                    v: vb - c,
                    pieces: 1,
                },
                scale,
                &what("cut"),
            ));
            w = w.max(check(
                op(BodyOp::Intersect, &bx, &s),
                Want::Volume { v: c, pieces: 1 },
                scale,
                &what("intersect"),
            ));
            w = w.max(check(
                op(BodyOp::Cut, &s, &bx),
                Want::Volume {
                    v: vs - c,
                    pieces: 1,
                },
                scale,
                &what("sphere − box"),
            ));
        }
        w
    });
    let w = worst.iter().copied().fold(0.0, f64::max);
    eprintln!("spheres on a plane: worst volume error {w:.2e} relative");
}

/// Area of the circular segment of height `h` of a disc of radius `r`.
fn segment(r: f64, h: f64) -> f64 {
    r * r * ((r - h) / r).acos() - (r - h) * (2.0 * r * h - h * h).sqrt()
}

/// A cylinder of radius 1.5 lying on the top face `z = 0` of the box `[−5, 5]² × [−5, 0]`
/// along X and Y (tangent along a line), and dipping into it.
#[test]
fn cylinders_on_a_plane() {
    for ca in 0..2 {
        for zc in [1.5, 1.0, 0.0, -0.5] {
            let bx = aabox("a", [-5.0, -5.0, -5.0], [10.0, 10.0, 5.0]);
            // Axis along X (ca 0: centre (y, z)) or Y (ca 1: centre (x, z)); the cylinder
            // runs past the box on both sides.
            let cy = cyl("c", ca, [0.25, zc], -7.0, 1.5, 14.0);
            let (vb, vc) = (500.0, PI * 2.25 * 14.0);
            let scale = vb + vc;
            let what = |o: &str| format!("cylinder axis {ca} centre z {zc} {o}");
            if zc >= 1.5 {
                check(
                    op(BodyOp::Join, &bx, &cy),
                    Want::Code("BOOLEAN_NO_INTERSECTION"),
                    scale,
                    &what("join"),
                );
                check(
                    op(BodyOp::Cut, &bx, &cy),
                    Want::Code("BOOLEAN_NO_INTERSECTION"),
                    scale,
                    &what("cut"),
                );
                check(
                    op(BodyOp::Intersect, &bx, &cy),
                    Want::Code("BOOLEAN_EMPTY_RESULT"),
                    scale,
                    &what("intersect"),
                );
                continue;
            }
            let v = segment(1.5, 1.5 - zc) * 10.0;
            check(
                op(BodyOp::Join, &bx, &cy),
                Want::Volume {
                    v: vb + vc - v,
                    pieces: 1,
                },
                scale,
                &what("join"),
            );
            check(
                op(BodyOp::Cut, &bx, &cy),
                Want::Volume {
                    v: vb - v,
                    pieces: 1,
                },
                scale,
                &what("cut"),
            );
            check(
                op(BodyOp::Intersect, &bx, &cy),
                Want::Volume { v, pieces: 1 },
                scale,
                &what("intersect"),
            );
            // The cylinder minus the box: the parts beyond the box on both ends stay joined
            // through the part above the face.
            check(
                op(BodyOp::Cut, &cy, &bx),
                Want::Volume {
                    v: vc - v,
                    pieces: 1,
                },
                scale,
                &what("cylinder − box"),
            );
        }
    }
}

/// A ball of radius 1 on the end cap `z = 0` of the cylinder of radius 3 along Z over
/// `[−5, 0]` (tangent at the cap's centre, then dipping), and touching its side from
/// outside.
#[test]
fn spheres_on_a_cylinder_cap_and_side_on_every_axis() {
    for ax in 0..3 {
        let cy = cyl("a", 2, [0.0, 0.0], -5.0, 3.0, 5.0);
        let vc = PI * 9.0 * 5.0;
        let scale = vc + ball(1.0);
        let what = |o: &str| format!("sphere axis {ax} {o}");
        let s = sphere("s", [0.0, 0.0, 1.0], 1.0, ax);
        check(
            op(BodyOp::Join, &cy, &s),
            Want::Code("BOOLEAN_NO_INTERSECTION"),
            scale,
            &what("tangent to the cap: join"),
        );
        check(
            op(BodyOp::Intersect, &cy, &s),
            Want::Code("BOOLEAN_EMPTY_RESULT"),
            scale,
            &what("tangent to the cap: intersect"),
        );
        let s = sphere("s", [0.5, -0.25, 0.25], 1.0, ax);
        let c = cap(1.0, 0.75);
        check(
            op(BodyOp::Join, &cy, &s),
            Want::Volume {
                v: vc + ball(1.0) - c,
                pieces: 1,
            },
            scale,
            &what("dipping into the cap: join"),
        );
        check(
            op(BodyOp::Cut, &cy, &s),
            Want::Volume {
                v: vc - c,
                pieces: 1,
            },
            scale,
            &what("dipping into the cap: cut"),
        );
        check(
            op(BodyOp::Intersect, &cy, &s),
            Want::Volume { v: c, pieces: 1 },
            scale,
            &what("dipping into the cap: intersect"),
        );
        let s = sphere("s", [4.0, 0.0, -2.5], 1.0, ax);
        check(
            op(BodyOp::Join, &cy, &s),
            Want::Code("BOOLEAN_NO_INTERSECTION"),
            scale,
            &what("tangent to the side: join"),
        );
        check(
            op(BodyOp::Cut, &cy, &s),
            Want::Code("BOOLEAN_NO_INTERSECTION"),
            scale,
            &what("tangent to the side: cut"),
        );
    }
}

/// Hollow balls (radius 3 minus a concentric radius 2, the inner sphere revolved about the
/// next axis) as tools and targets, and a box with a spherical cavity as a target.
#[test]
fn void_tools_and_targets_on_every_axis() {
    let c = [5.0, 5.0, 5.0];
    let (v3, v2) = (ball(3.0), ball(2.0));
    let shell = v3 - v2;
    for ax in 0..3 {
        let what = |o: &str| format!("sphere axis {ax} {o}");
        let bx = aabox("a", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
        let outer = sphere("o", c, 3.0, ax);
        let inner = sphere("i", c, 2.0, ax + 1);
        let r = op(BodyOp::Cut, &outer, &inner).expect("hollow ball");
        assert_eq!(r.bodies.len(), 1, "{}", what("hollow ball"));
        let hollow = r.bodies[0].body.clone();
        assert_eq!(
            hollow.shell_ids().len(),
            2,
            "{}",
            what("hollow ball shells")
        );
        let scale = 1000.0 + shell;
        // Hollow tool: the box keeps a spherical cavity of radius 3 and the ball of radius 2
        // inside it comes loose (bounded by the tool's void only).
        check(
            op(BodyOp::Cut, &bx, &hollow),
            Want::Volume {
                v: 1000.0 - shell,
                pieces: 2,
            },
            scale,
            &what("box − hollow ball"),
        );
        check(
            op(BodyOp::Join, &bx, &hollow),
            Want::Untouched,
            scale,
            &what("box ∪ hollow ball"),
        );
        check(
            op(BodyOp::Intersect, &bx, &hollow),
            Want::Volume {
                v: shell,
                pieces: 1,
            },
            scale,
            &what("box ∩ hollow ball"),
        );
        // Hollow target.
        check(
            op(BodyOp::Cut, &hollow, &bx),
            Want::Consumed,
            scale,
            &what("hollow ball − box"),
        );
        check(
            op(BodyOp::Intersect, &hollow, &bx),
            Want::Volume {
                v: shell,
                pieces: 1,
            },
            scale,
            &what("hollow ball ∩ box"),
        );
        // Drilled hollow ball: a cylinder of radius 1 along Z through the centre.
        let drill = cyl("d", 2, [5.0, 5.0], -1.0, 1.0, 12.0);
        let in_drill = (v3 - napkin(3.0, 1.0)) - (v2 - napkin(2.0, 1.0));
        check(
            op(BodyOp::Cut, &hollow, &drill),
            Want::Volume {
                v: shell - in_drill,
                pieces: 1,
            },
            scale,
            &what("hollow ball − drill"),
        );
        check(
            op(BodyOp::Intersect, &hollow, &drill),
            Want::Volume {
                v: in_drill,
                pieces: 2,
            },
            scale,
            &what("hollow ball ∩ drill"),
        );
        // A box with a spherical cavity (radius 2) as target, a ball of radius 3 as tool.
        let cavity = op(BodyOp::Cut, &bx, &inner).expect("cavity");
        let cavity = cavity.bodies[0].body.clone();
        check(
            op(BodyOp::Join, &cavity, &outer),
            Want::Volume {
                v: 1000.0,
                pieces: 1,
            },
            scale,
            &what("cavity ∪ ball"),
        );
        check(
            op(BodyOp::Cut, &cavity, &outer),
            Want::Volume {
                v: 1000.0 - v3,
                pieces: 1,
            },
            scale,
            &what("cavity − ball"),
        );
        check(
            op(BodyOp::Intersect, &cavity, &outer),
            Want::Volume {
                v: shell,
                pieces: 1,
            },
            scale,
            &what("cavity ∩ ball"),
        );
    }
}
