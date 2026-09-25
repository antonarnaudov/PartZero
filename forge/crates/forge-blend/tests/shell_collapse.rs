//! Inward shells whose whole cavity collapses (W6 review round 6): prisms whose walls are
//! not parallel — a triangle, a regular pentagon, a thin wedge — shelled past their
//! inradius. Every side face vanishes there because every wall's offset meets the others':
//! opposite walls colliding (SPEC §6.8, `gap`), so `SHELL_THICKNESS_TOO_LARGE` with the
//! inradius as the feasible range (rounded down, built, and confirmed), never `SHELL_FAILED`.
//! A face used up while the cavity goes on (a narrow bevel between two walls) is still
//! `SHELL_FAILED` naming it (`shells.rs`).

mod common;

use common::*;
use forge_blend::{BlendError, ShellDirection, ShellLimitReason, ShellOptions, shell};
use forge_core::topo::Body;

fn opts() -> ShellOptions {
    ShellOptions::new("sh1")
}

/// The prism of `poly` (counter-clockwise) from z = 0 to `h`, and its top face.
fn prism_top(poly: &[[f64; 2]], h: f64) -> (Body, forge_core::topo::FaceId) {
    let b = prism("q", 0.0, polygon(poly), h);
    let n = poly.len() as f64;
    let c = poly
        .iter()
        .fold([0.0, 0.0], |a, p| [a[0] + p[0] / n, a[1] + p[1] / n]);
    let top = face_near(&b, [c[0], c[1], h]);
    (b, top)
}

/// Area and perimeter of a polygon.
fn area_perimeter(poly: &[[f64; 2]]) -> (f64, f64) {
    let n = poly.len();
    let mut a = 0.0;
    let mut p = 0.0;
    for i in 0..n {
        let (u, v) = (poly[i], poly[(i + 1) % n]);
        a += u[0] * v[1] - v[0] * u[1];
        p += ((v[0] - u[0]).powi(2) + (v[1] - u[1]).powi(2)).sqrt();
    }
    (0.5 * a, p)
}

/// A tangential polygon (all sides touch the incircle of radius `rho`) offset inward by `t`
/// is similar to it with the ratio `(rho − t)/rho`.
fn offset_area(poly: &[[f64; 2]], rho: f64, t: f64) -> f64 {
    let (a, _) = area_perimeter(poly);
    a * ((rho - t) / rho).powi(2)
}

/// Asserts `SHELL_THICKNESS_TOO_LARGE` with the maximum `round_down(rho)` and every side
/// wall named with `gap`; builds the maximum and checks its closed-form volume (open top:
/// the cavity is the offset polygon times `h − t`; closed: `h − 2t`).
fn assert_collapse(poly: &[[f64; 2]], h: f64, rho: f64, t: f64, open: bool) {
    let (b, top) = prism_top(poly, h);
    let open_faces = if open { vec![top] } else { vec![] };
    let err = shell(&b, &fs(&b, &open_faces), t, ShellDirection::Inward, &opts())
        .expect_err("the cavity collapses");
    let BlendError::ThicknessTooLarge {
        max_feasible_thickness,
        limits,
        ..
    } = &err
    else {
        panic!(
            "t = {t}: expected SHELL_THICKNESS_TOO_LARGE, got {} {err}",
            err.code()
        );
    };
    let max = max_feasible_thickness.unwrap_or_else(|| panic!("no maximum: {err}"));
    assert_eq!(
        max.to_bits(),
        forge_blend::round_down_mm(rho).to_bits(),
        "t = {t}: {err}"
    );
    let sides: Vec<&str> = limits
        .iter()
        .filter(|l| l.key.starts_with("q/side:"))
        .map(|l| l.key.as_str())
        .collect();
    assert_eq!(sides.len(), poly.len(), "every side wall collides: {err}");
    assert!(
        limits.iter().all(|l| l.reason == ShellLimitReason::Gap),
        "{err}"
    );
    assert!(err.to_string().contains("collapses"), "{err}");
    let out = shell(
        &b,
        &fs(&b, &open_faces),
        max,
        ShellDirection::Inward,
        &opts(),
    )
    .unwrap_or_else(|e| panic!("the maximum {max} must build: {e}"));
    assert_valid(&out.body);
    let height = if open { h - max } else { h - 2.0 * max };
    let cavity = offset_area(poly, rho, max) * height;
    let v = volume(&out.body);
    assert!(
        rel(v, volume(&b) - cavity) < 1e-9,
        "{v} vs {}",
        volume(&b) - cavity
    );
}

#[test]
fn an_equilateral_prism_collapses_at_its_inradius() {
    let s = 10.0;
    let tri = [[0.0, 0.0], [s, 0.0], [0.5 * s, 0.5 * 3f64.sqrt() * s]];
    let rho = s / (2.0 * 3f64.sqrt());
    for t in [2.9, 3.5, 4.4, 6.0] {
        assert_collapse(&tri, 10.0, rho, t, true);
        assert_collapse(&tri, 10.0, rho, t, false);
    }
}

#[test]
fn a_regular_pentagonal_prism_collapses_at_its_inradius() {
    let pent: Vec<[f64; 2]> = (0..5)
        .map(|k| {
            let a = 2.0 * std::f64::consts::PI / 5.0 * k as f64;
            [20.0 + 5.0 * a.cos(), 20.0 + 5.0 * a.sin()]
        })
        .collect();
    let rho = 5.0 * (std::f64::consts::PI / 5.0).cos();
    assert_collapse(&pent, 12.0, rho, 4.4, true);
}

#[test]
fn a_thin_wedge_collapses_at_its_inradius() {
    // A right triangle with a 5° tip: inradius (a + b − c)/2.
    let (a, b) = (20.0, 20.0 * (5f64).to_radians().tan());
    let wedge = [[0.0, 0.0], [a, 0.0], [a, b]];
    let rho = 0.5 * (a + b - (a * a + b * b).sqrt());
    assert_collapse(&wedge, 8.0, rho, 1.0, true);
}

#[test]
fn a_box_just_under_its_half_width_builds_the_thin_cavity() {
    // 10 × 20 × 30, top open: at t = 4.99999 the cavity is 2e-5 mm wide — not collapsed,
    // built (it was SHELL_FAILED naming the bottom as a vanishing face); at t = 5 the walls
    // meet.
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let top = face_near(&b, [5.0, 10.0, 30.0]);
    let t = 4.99999;
    let out = shell(&b, &fs(&b, &[top]), t, ShellDirection::Inward, &opts()).expect("thin");
    assert_valid(&out.body);
    let cavity = (10.0 - 2.0 * t) * (20.0 - 2.0 * t) * (30.0 - t);
    assert!(rel(volume(&out.body), 6000.0 - cavity) < 1e-11);
    let err = shell(&b, &fs(&b, &[top]), 5.0, ShellDirection::Inward, &opts())
        .expect_err("the walls meet");
    assert_eq!(err.code(), "SHELL_THICKNESS_TOO_LARGE", "{err}");
    assert_eq!(err.details()["max_feasible_thickness"], 4.999, "{err}");
}

#[test]
fn a_regular_hexagonal_prism_is_limited_by_its_parallel_walls() {
    // Parallel walls meet at the inradius in closed form (unchanged).
    let hex: Vec<[f64; 2]> = (0..6)
        .map(|k| {
            let a = std::f64::consts::PI / 3.0 * k as f64;
            [20.0 + 5.0 * a.cos(), 20.0 + 5.0 * a.sin()]
        })
        .collect();
    let (b, top) = prism_top(&hex, 12.0);
    let err =
        shell(&b, &fs(&b, &[top]), 4.4, ShellDirection::Inward, &opts()).expect_err("walls meet");
    assert_eq!(err.code(), "SHELL_THICKNESS_TOO_LARGE", "{err}");
    let rho = 5.0 * (std::f64::consts::PI / 6.0).cos();
    assert_eq!(
        err.details()["max_feasible_thickness"],
        forge_blend::round_down_mm(rho),
        "{err}"
    );
}
