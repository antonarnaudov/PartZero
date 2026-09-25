//! Property tests of the curved pairs (W6 review round 3): random D-flats and dimples, the
//! fillet or chamfer of a D-flat's edge or a dimple's rim at a random value. Every returned
//! body is valid, free of self-intersections and has the closed-form volume (the D-flat: the
//! cross-section area × the length, from the rolling ball at `r` from the flat and `R − r`
//! from the axis; the rim: Pappus on the meridian cross-section); every `*_TOO_LARGE` suggests
//! a value that builds and whose `1.01×` fails with the same code.
#![cfg(not(target_family = "wasm"))]

mod common;

use common::*;
use forge_blend::{BlendError, BlendOptions, ChamferSpec, chamfer, fillet};
use forge_core::topo::{Body, EdgeId};
use forge_ir::{Frame, PlaneSpec};
use forge_ops::boolean::corpus::{Operand, Sweep};
use proptest::prelude::*;

fn segment(r: f64, c: f64) -> f64 {
    let th = 2.0 * (c / (2.0 * r)).asin();
    0.5 * r * r * (th - th.sin())
}

fn tri(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs()
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// A shaft of radius `rr` about z (height `h`) with a flat at x = `x0`.
fn dflat(rr: f64, x0: f64, h: f64) -> Body {
    let shaft = zcyl("shaft", [0.0, 0.0], 0.0, rr, h);
    let flat = aabox(
        "flat",
        [x0, -rr - 1.0, -1.0],
        [2.0 * rr, 2.0 * rr + 2.0, h + 2.0],
    );
    cut(shaft, flat, "c1")
}

/// Cross-section area of the D-flat edge's fillet (`fillet`) or chamfer.
fn dflat_area(rr: f64, x0: f64, s: f64, fillet: bool) -> f64 {
    let y0 = (rr * rr - x0 * x0).sqrt();
    let ee = [x0, y0];
    if fillet {
        let c2 = [x0 - s, ((rr - s).powi(2) - (x0 - s).powi(2)).sqrt()];
        let pa = [x0, c2[1]];
        let k = rr / (rr - s);
        let pb = [c2[0] * k, c2[1] * k];
        tri(ee, pa, pb) - segment(s, dist(pa, pb)) + segment(rr, dist(pb, ee))
    } else {
        let pa = [x0, y0 - s];
        let th = y0.atan2(x0) + 2.0 * (s / (2.0 * rr)).asin();
        let pb = [rr * th.cos(), rr * th.sin()];
        tri(ee, pa, pb) + segment(rr, s)
    }
}

fn ball(c: [f64; 3], r: f64) -> Body {
    let mut op = prism_op(
        "ball",
        PlaneSpec::Frame(Frame {
            origin: [c[0], c[1], 0.0],
            normal: [0.0, -1.0, 0.0],
            x_dir: [1.0, 0.0, 0.0],
        }),
        vec![
            arc("a", [0.0, c[2] - r], [0.0, c[2] + r], [0.0, c[2]], true),
            line("x", [0.0, c[2] + r], [0.0, c[2] - r]),
        ],
        1.0,
    );
    op.sweep = Sweep::Revolve {
        axis: forge_ir::SketchAxis {
            origin: [0.0, 0.0],
            direction: [0.0, 1.0],
        },
        angle: 360.0,
        direction: forge_ir::SweepDirection::Normal,
    };
    Operand::build(&op).expect("ball")
}

/// Pappus on a closed path of segments and arcs `(centre, radius, a0, a1)` in `(ρ, ζ)`.
fn pappus(segs: &[([f64; 2], [f64; 2])], arcs: &[([f64; 2], f64, f64, f64)]) -> f64 {
    let n = 4000;
    let simpson = |f: &dyn Fn(f64) -> f64| {
        let h = 1.0 / n as f64;
        let mut acc = f(0.0) + f(1.0);
        for k in 1..n {
            acc += f(k as f64 * h) * if k % 2 == 1 { 4.0 } else { 2.0 };
        }
        acc * h / 3.0
    };
    let mut total = 0.0;
    for &(a, b) in segs {
        total += simpson(&|s| {
            let rho = a[0] + (b[0] - a[0]) * s;
            0.5 * rho * rho * (b[1] - a[1])
        });
    }
    for &(c, r, a0, a1) in arcs {
        total += simpson(&|s| {
            let th = a0 + (a1 - a0) * s;
            let rho = c[0] + r * th.cos();
            0.5 * rho * rho * r * th.cos() * (a1 - a0)
        });
    }
    2.0 * std::f64::consts::PI * total.abs()
}

fn ang(c: [f64; 2], p: [f64; 2]) -> f64 {
    (p[1] - c[1]).atan2(p[0] - c[0])
}

/// The rim of a dimple in a plate of thickness `h` (sphere centre `zc`, radius `rs`): the
/// removed volume of its fillet or chamfer `s`.
fn rim_volume(h: f64, zc: f64, rs: f64, s: f64, fillet: bool) -> f64 {
    let e = [(rs * rs - (h - zc).powi(2)).sqrt(), h];
    let o = [0.0, zc];
    if fillet {
        let cz = h - s;
        let c2 = [((rs + s).powi(2) - (cz - zc).powi(2)).sqrt(), cz];
        let pa = [c2[0], h];
        let k = rs / (rs + s);
        let pb = [c2[0] * k, zc + (cz - zc) * k];
        pappus(
            &[(e, pa)],
            &[
                (c2, s, ang(c2, pa), ang(c2, pb)),
                (o, rs, ang(o, pb), ang(o, e)),
            ],
        )
    } else {
        let pa = [e[0] + s, h];
        let th = ang(o, e) - 2.0 * (s / (2.0 * rs)).asin();
        let pb = [rs * th.cos(), zc + rs * th.sin()];
        pappus(&[(e, pa), (pa, pb)], &[(o, rs, ang(o, pb), ang(o, e))])
    }
}

fn run(b: &Body, e: EdgeId, s: f64, fillet_it: bool) -> Result<Body, BlendError> {
    if fillet_it {
        fillet(b, &es(b, &[e]), s, &BlendOptions::new("f1")).map(|o| o.body)
    } else {
        chamfer(
            b,
            &es(b, &[e]),
            &ChamferSpec::Equal { d: s },
            &BlendOptions::new("c1"),
        )
        .map(|o| o.body)
    }
}

/// The body is valid, not self-intersecting and removes `exact(s)`; or the value is too large
/// and the suggestion builds and removes `exact(max)`, `1.01×` failing again.
fn check(b: &Body, e: EdgeId, s: f64, fillet_it: bool, exact: &dyn Fn(f64) -> f64) {
    let v0 = volume(b);
    let verify = |out: &Body, x: f64| {
        assert_valid(out);
        assert!(
            forge_blend::self_intersections(out)
                .expect("certified")
                .is_empty()
        );
        let removed = v0 - volume(out);
        assert!(
            rel(removed, exact(x)) < 1e-8,
            "{x}: {removed} vs {}",
            exact(x)
        );
    };
    match run(b, e, s, fillet_it) {
        Ok(out) => verify(&out, s),
        Err(err) => {
            let max = match &err {
                BlendError::RadiusTooLarge { max_feasible_r, .. } => *max_feasible_r,
                BlendError::DistanceTooLarge { max_feasible_d, .. } => *max_feasible_d,
                other => panic!("{s}: {} {other}", other.code()),
            };
            assert!(max < s, "{err}");
            let out = run(b, e, max, fillet_it).unwrap_or_else(|x| panic!("max {max}: {x}"));
            verify(&out, max);
            let again = run(b, e, 1.01 * max, fillet_it).expect_err("above the range");
            assert_eq!(again.code(), err.code(), "{again}");
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 16, .. ProptestConfig::default() })]

    #[test]
    fn d_flat_edges_blend_to_the_closed_form(
        rr in 4.0f64..15.0, depth in 0.2f64..0.8, h in 6.0f64..30.0,
        f in 0.05f64..1.2, fillet_it in any::<bool>(),
    ) {
        let x0 = rr * (1.0 - depth);
        let b = dflat(rr, x0, h);
        let y0 = (rr * rr - x0 * x0).sqrt();
        let e = edge_near(&b, [x0, y0, h / 2.0]);
        let s = f * rr * 0.5;
        check(&b, e, s, fillet_it, &|x| dflat_area(rr, x0, x, fillet_it) * h);
    }

    #[test]
    fn dimple_rims_blend_to_the_closed_form(
        rs in 3.0f64..8.0, depth in 0.3f64..0.9, f in 0.02f64..0.8, fillet_it in any::<bool>(),
    ) {
        let h = 6.0;
        let zc = h - depth * rs + rs;
        let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, h]);
        let b = cut(plate, ball([20.0, 15.0, zc], rs), "c1");
        let e = b
            .edges()
            .iter()
            .find(|(_, x)| matches!(&x.curve, forge_core::geom::Curve3::Circle(c)
                if (c.frame().origin().z - h).abs() < 1e-9))
            .map(|(id, _)| id)
            .expect("rim");
        let s = f * rs * 0.5;
        check(&b, e, s, fillet_it, &|x| rim_volume(h, zc, rs, x, fillet_it));
    }
}
