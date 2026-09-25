//! Fillet → shell sequences, the most common maker workflow (W6 review round 4): a rounded
//! enclosure opened at the top, a rounded box closed or opened through its smooth top, and
//! the feasible range of such shells — against closed forms.
//!
//! Closed forms. A body whose horizontal sections are rounded rectangles `a × b` with corner
//! radius `R`, rounded at the bottom by a blend of radius `ρ` (tori at the corners), has the
//! section area `A(d) = (a − 2d)(b − 2d) − (4 − π)(R − d)²` at the inset `d` of the bottom
//! blend. With `d = ρ(1 − sin θ)`, `z − z₀ = ρ(1 − cos θ)`, the blend's slab
//! `∫ A dz = ρ[(ab − kR²) + ρ(2kR − 2(a + b))(1 − π/4) + ρ²(4 − k)(5/3 − π/2)]`, `k = 4 − π`
//! (Pappus, exactly). A box with all twelve edges rounded by `r` has the volume
//! `(a−2r)(b−2r)(c−2r) + 2r[(a−2r)(b−2r) + (b−2r)(c−2r) + (c−2r)(a−2r)] + πr²(a+b+c−6r) + 4πr³/3`.

mod common;

use std::time::Instant;

use common::*;
use forge_blend::{BlendError, BlendOptions, ShellDirection, ShellOptions, fillet, shell};
use forge_core::math::PI;
use forge_core::topo::Body;

fn sopts() -> ShellOptions {
    ShellOptions::new("sh1")
}

const K: f64 = 4.0 - PI;

/// `∫ A dz` over a bottom blend of radius `rho` of the rounded rectangle `a × b`, corner `r_c`.
fn blend_slab(a: f64, b: f64, r_c: f64, rho: f64) -> f64 {
    rho * ((a * b - K * r_c * r_c)
        + rho * (2.0 * K * r_c - 2.0 * (a + b)) * (1.0 - PI / 4.0)
        + rho * rho * (4.0 - K) * (5.0 / 3.0 - PI / 2.0))
}

/// Volume of the rounded-rectangle prism `a × b × c` (corner `r_c`) whose bottom edges are
/// rounded by `rho` (all sections from the bottom at 0 to the top at `c`).
fn enclosure(a: f64, b: f64, c: f64, r_c: f64, rho: f64) -> f64 {
    blend_slab(a, b, r_c, rho) + (c - rho) * (a * b - K * r_c * r_c)
}

/// A box with all twelve edges rounded by `r`.
fn rounded_box(a: f64, b: f64, c: f64, r: f64) -> f64 {
    let (x, y, z) = (a - 2.0 * r, b - 2.0 * r, c - 2.0 * r);
    x * y * z
        + 2.0 * r * (x * y + y * z + z * x)
        + PI * r * r * (x + y + z)
        + 4.0 / 3.0 * PI * r * r * r
}

/// Box `a × b × c`, its vertical edges filleted by `r_v`, then its bottom edge loop (one
/// bottom edge and its tangent chain) by `r_b`.
fn filleted_enclosure(a: f64, b: f64, c: f64, r_v: f64, r_b: f64) -> Body {
    let b0 = aabox("e1", [0.0, 0.0, 0.0], [a, b, c]);
    let verts = [
        edge_near(&b0, [0.0, 0.0, 0.5 * c]),
        edge_near(&b0, [a, 0.0, 0.5 * c]),
        edge_near(&b0, [a, b, 0.5 * c]),
        edge_near(&b0, [0.0, b, 0.5 * c]),
    ];
    let b1 = fillet(&b0, &es(&b0, &verts), r_v, &BlendOptions::new("f1"))
        .expect("vertical fillets")
        .body;
    let e = edge_near(&b1, [0.5 * a, 0.0, 0.0]);
    let out = fillet(&b1, &es(&b1, &[e]), r_b, &BlendOptions::new("f2")).expect("bottom loop");
    assert_eq!(
        out.report.edges.len(),
        8,
        "the bottom loop: 4 lines and 4 arcs"
    );
    out.body
}

/// Box `a × b × c` with all twelve edges filleted by `r`.
fn rounded(a: f64, b: f64, c: f64, r: f64) -> Body {
    let b0 = aabox("e1", [0.0, 0.0, 0.0], [a, b, c]);
    let all: Vec<_> = b0.edges().iter().map(|(id, _)| id).collect();
    fillet(&b0, &es(&b0, &all), r, &BlendOptions::new("f1"))
        .expect("rounded box")
        .body
}

fn top_of(b: &Body, a: f64, bb: f64, c: f64) -> forge_core::topo::FaceId {
    face_near(b, [0.5 * a, 0.5 * bb, c])
}

/// Release builds only: debug builds are an order of magnitude slower.
fn assert_quick(t0: Instant, secs: f64, what: &str) {
    let s = t0.elapsed().as_secs_f64();
    if !cfg!(debug_assertions) {
        assert!(s < secs, "{what} took {s:.1} s (limit {secs} s)");
    }
}

/// The reviewer's enclosure: 40 × 30 × 20, vertical r = 4, bottom loop r = 2, shelled inward
/// with the top open. Every thickness below the bottom blend's radius builds and equals the
/// closed form; t = 2 degenerates the bottom blend's offset (curvature).
#[test]
fn a_filleted_enclosure_shells_with_its_top_open() {
    let (a, b, c, rv, rb) = (40.0, 30.0, 20.0, 4.0, 2.0);
    let body = filleted_enclosure(a, b, c, rv, rb);
    let v0 = enclosure(a, b, c, rv, rb);
    assert!(rel(volume(&body), v0) < 1e-10, "{} vs {v0}", volume(&body));
    let top = top_of(&body, a, b, c);
    for t in [1.0, 1.5, 1.7] {
        let t0 = Instant::now();
        let out = shell(
            &body,
            &fs(&body, &[top]),
            t,
            ShellDirection::Inward,
            &sopts(),
        )
        .unwrap_or_else(|e| panic!("t = {t}: {} {e}", e.code()));
        assert_quick(t0, 20.0, "one shell");
        assert_valid(&out.body);
        // The cavity: the offset body, open to the top plane.
        let cavity = blend_slab(a - 2.0 * t, b - 2.0 * t, rv - t, rb - t)
            + (c - rb) * ((a - 2.0 * t) * (b - 2.0 * t) - K * (rv - t) * (rv - t));
        let want = v0 - cavity;
        assert!(
            rel(volume(&out.body), want) < 1e-9,
            "t = {t}: {} vs {want}",
            volume(&out.body)
        );
        assert!(
            forge_blend::self_intersections(&out.body)
                .expect("certified")
                .is_empty(),
            "t = {t}"
        );
    }
    // The reviewer's values at t = 1 and 1.5.
    assert!((v0 - enclosure_cavity(a, b, c, rv, rb, 1.0) - 3571.1456).abs() < 1e-3);
    assert!((v0 - enclosure_cavity(a, b, c, rv, rb, 1.5) - 5237.7897).abs() < 1e-3);
}

fn enclosure_cavity(a: f64, b: f64, c: f64, rv: f64, rb: f64, t: f64) -> f64 {
    blend_slab(a - 2.0 * t, b - 2.0 * t, rv - t, rb - t)
        + (c - rb) * ((a - 2.0 * t) * (b - 2.0 * t) - K * (rv - t) * (rv - t))
}

/// Past the bottom blend's radius its offset degenerates: `SHELL_THICKNESS_TOO_LARGE` with
/// `curvature` limits only (never a `gap` between walls that cannot meet), and the
/// feasible-range property: the maximum builds, `max + 0.001` and `1.01·max` fail with the
/// same code; the search is bounded.
///
/// Release builds only for now: in debug builds forge-ssi's marcher panics on a statistics
/// counter (`stats.regular_cells -= 1` underflows in `ssi/march/mod.rs`, a W4 file) on the
/// near-degenerate thin tubes the search probes just below the limit; reported to the
/// integrator. Release builds wrap that counter, which only feeds statistics.
#[test]
#[cfg_attr(
    debug_assertions,
    ignore = "forge-ssi statistics counter underflow in debug builds (W4); runs in release"
)]
fn the_enclosure_shell_is_limited_by_the_bottom_blend_curvature() {
    let (a, b, c, rv, rb) = (40.0, 30.0, 20.0, 4.0, 2.0);
    let body = filleted_enclosure(a, b, c, rv, rb);
    let top = top_of(&body, a, b, c);
    let open = fs(&body, &[top]);
    let t0 = Instant::now();
    let err = shell(&body, &open, 2.3, ShellDirection::Inward, &sopts()).expect_err("too thick");
    assert_quick(t0, 120.0, "the feasible-range search");
    let BlendError::ThicknessTooLarge {
        max_feasible_thickness,
        limits,
        ..
    } = &err
    else {
        panic!("{} {err}", err.code());
    };
    assert!(!limits.is_empty());
    for l in limits {
        assert_eq!(
            l.reason,
            forge_blend::ShellLimitReason::Curvature,
            "{err}: {l:?}"
        );
    }
    let max = max_feasible_thickness.unwrap_or_else(|| panic!("a maximum: {err}"));
    assert!((1.99..2.0).contains(&max), "{max}: {err}");
    shell(&body, &open, max, ShellDirection::Inward, &sopts()).expect("max builds");
    for x in [max + 0.001, 1.01 * max] {
        let e = shell(&body, &open, x, ShellDirection::Inward, &sopts()).expect_err("above");
        assert_eq!(e.code(), "SHELL_THICKNESS_TOO_LARGE", "{x}: {e}");
    }
}

/// The reviewer's second enclosure (40 × 25 × 15, vertical r = 3, bottom loop r = 1): t = 0.5
/// was a false `gap` (tangent offset walls forge-ssi could not separate); every thickness
/// below 1 builds.
#[test]
fn thin_shells_of_a_small_bottom_blend_build() {
    let (a, b, c, rv, rb) = (40.0, 25.0, 15.0, 3.0, 1.0);
    let body = filleted_enclosure(a, b, c, rv, rb);
    let v0 = enclosure(a, b, c, rv, rb);
    let top = top_of(&body, a, b, c);
    for t in [0.2, 0.5, 0.8] {
        let t0 = Instant::now();
        let out = shell(
            &body,
            &fs(&body, &[top]),
            t,
            ShellDirection::Inward,
            &sopts(),
        )
        .unwrap_or_else(|e| panic!("t = {t}: {} {e}", e.code()));
        assert_quick(t0, 20.0, "one shell");
        let want = v0 - enclosure_cavity(a, b, c, rv, rb, t);
        assert!(
            rel(volume(&out.body), want) < 1e-9,
            "t = {t}: {} vs {want}",
            volume(&out.body)
        );
    }
}

/// Outward: the corner tori's tubes (major 2, minor 2 + t) grow past their axes and become
/// outer sheets of spindle tori (the reviewer's `offsetting the torus face … is not
/// supported`).
#[test]
fn a_filleted_enclosure_shells_outward() {
    let (a, b, c, rv, rb) = (40.0, 30.0, 20.0, 4.0, 2.0);
    let body = filleted_enclosure(a, b, c, rv, rb);
    let v0 = enclosure(a, b, c, rv, rb);
    let top = top_of(&body, a, b, c);
    for t in [0.5, 1.5] {
        let out = shell(
            &body,
            &fs(&body, &[top]),
            t,
            ShellDirection::Outward,
            &sopts(),
        )
        .unwrap_or_else(|e| panic!("t = {t}: {} {e}", e.code()));
        assert_valid(&out.body);
        // The outer body: sections grow by t, the bottom blend's radius by t about the same
        // axes (from z = −t), up to the open top at z = c.
        let (a2, b2, rc2, rho2) = (a + 2.0 * t, b + 2.0 * t, rv + t, rb + t);
        let outer = blend_slab(a2, b2, rc2, rho2) + (c - rb) * (a2 * b2 - K * rc2 * rc2);
        let want = outer - v0;
        assert!(
            rel(volume(&out.body), want) < 1e-9,
            "t = {t}: {} vs {want}",
            volume(&out.body)
        );
    }
}

/// A box with all twelve edges rounded (sphere corners), shelled closed: an internal void
/// that is the rounded box of radius r − t (inward) or r + t around it (outward).
#[test]
fn a_rounded_box_shells_closed() {
    let (a, b, c, r) = (20.0, 12.0, 8.0, 2.0);
    let body = rounded(a, b, c, r);
    let v0 = rounded_box(a, b, c, r);
    assert!(rel(volume(&body), v0) < 1e-10);
    for t in [0.5, 1.0] {
        let t0 = Instant::now();
        let out = shell(&body, &fs(&body, &[]), t, ShellDirection::Inward, &sopts())
            .unwrap_or_else(|e| panic!("inward t = {t}: {} {e}", e.code()));
        assert_quick(t0, 20.0, "one shell");
        assert_valid(&out.body);
        assert!(out.report.closed_void);
        let want = v0 - rounded_box(a - 2.0 * t, b - 2.0 * t, c - 2.0 * t, r - t);
        assert!(
            rel(volume(&out.body), want) < 1e-9,
            "{} vs {want}",
            volume(&out.body)
        );
        let out = shell(&body, &fs(&body, &[]), t, ShellDirection::Outward, &sopts())
            .unwrap_or_else(|e| panic!("outward t = {t}: {} {e}", e.code()));
        assert_valid(&out.body);
        let want = rounded_box(a + 2.0 * t, b + 2.0 * t, c + 2.0 * t, r + t) - v0;
        assert!(
            rel(volume(&out.body), want) < 1e-9,
            "{} vs {want}",
            volume(&out.body)
        );
    }
}

/// Opening the flat top of a rounded box (its edges are all smooth): the walls end in lateral
/// rims along the top's normal, between the top's edges and their offsets — the cavity is the
/// inner rounded box plus the prism of the top face over the thickness.
#[test]
fn a_rounded_box_opens_through_its_smooth_top() {
    let (a, b, c, r) = (40.0, 30.0, 20.0, 3.0);
    let body = rounded(a, b, c, r);
    let v0 = rounded_box(a, b, c, r);
    let top = top_of(&body, a, b, c);
    let flat = (a - 2.0 * r) * (b - 2.0 * r);
    for t in [0.5, 1.0] {
        let out = shell(
            &body,
            &fs(&body, &[top]),
            t,
            ShellDirection::Inward,
            &sopts(),
        )
        .unwrap_or_else(|e| panic!("inward t = {t}: {} {e}", e.code()));
        assert_valid(&out.body);
        let want = v0 - rounded_box(a - 2.0 * t, b - 2.0 * t, c - 2.0 * t, r - t) - flat * t;
        assert!(
            rel(volume(&out.body), want) < 1e-9,
            "{} vs {want}",
            volume(&out.body)
        );
        let rims = out
            .body
            .faces()
            .iter()
            .filter(|(_, f)| f.provenance.key().starts_with("sh1/rim:{"))
            .count();
        assert_eq!(rims, 4, "one lateral rim per edge of the top");
        let out = shell(
            &body,
            &fs(&body, &[top]),
            t,
            ShellDirection::Outward,
            &sopts(),
        )
        .unwrap_or_else(|e| panic!("outward t = {t}: {} {e}", e.code()));
        assert_valid(&out.body);
        let want = rounded_box(a + 2.0 * t, b + 2.0 * t, c + 2.0 * t, r + t) - v0 - flat * t;
        assert!(
            rel(volume(&out.body), want) < 1e-9,
            "{} vs {want}",
            volume(&out.body)
        );
    }
}

/// SPEC §6.8 makes `max_feasible_thickness` optional so that a thickness proven infeasible
/// stays `SHELL_THICKNESS_TOO_LARGE` when no feasible thickness is found (W6 review round 4:
/// it was `SHELL_FAILED`): a plate 3e-5 mm thick, shelled closed.
#[test]
fn a_thickness_infeasible_all_the_way_down_is_too_large_without_a_maximum() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 3e-5]);
    let err = shell(&b, &fs(&b, &[]), 1.0, ShellDirection::Inward, &sopts())
        .expect_err("walls 3e-5 apart");
    let BlendError::ThicknessTooLarge {
        max_feasible_thickness,
        limits,
        ..
    } = &err
    else {
        panic!("{} {err}", err.code());
    };
    assert_eq!(*max_feasible_thickness, None, "{err}");
    assert!(!limits.is_empty(), "{err}");
    assert!(err.details().get("max_feasible_thickness").is_none());
}

/// Outward, a corner torus of major radius 1 (vertical r = 5.5, bottom r = 4.5) grows into a
/// spindle torus's outer sheet; at the smooth corners where four tangent offset faces meet
/// the vertices and the offset arcs are placed exactly along the common normal (Gauss–Newton
/// on nearly parallel offsets left them 4e-6 mm off, and the body failed validation).
#[test]
fn an_enclosure_with_tight_corners_shells_outward_through_spindle_tori() {
    let (a, b, c, rv, rb) = (48.0, 23.5, 19.5, 5.5, 4.5);
    let body = filleted_enclosure(a, b, c, rv, rb);
    let v0 = enclosure(a, b, c, rv, rb);
    let top = top_of(&body, a, b, c);
    for (t, closed) in [(1.52, false), (3.39, true)] {
        let open = if closed { vec![] } else { vec![top] };
        let out = shell(
            &body,
            &fs(&body, &open),
            t,
            ShellDirection::Outward,
            &sopts(),
        )
        .unwrap_or_else(|e| panic!("t = {t}: {} {e}", e.code()));
        assert_valid(&out.body);
        let (a2, b2, rc2, rho2) = (a + 2.0 * t, b + 2.0 * t, rv + t, rb + t);
        let top_z = if closed { c + t } else { c };
        let outer = blend_slab(a2, b2, rc2, rho2) + (top_z - rb) * (a2 * b2 - K * rc2 * rc2);
        let want = outer - v0;
        assert!(
            rel(volume(&out.body), want) < 1e-9,
            "t = {t}: {} vs {want}",
            volume(&out.body)
        );
    }
}

/// W6 review round 4: what cannot be certified either way is `SHELL_FAILED` naming the pair —
/// never a `gap` limit. A shell 2e-4 mm short of the bottom blend's radius leaves offset tubes
/// 2e-4 mm thick whose tangent neighbours neither forge-ssi nor the band certificate
/// separates within their budgets (the pad is 1e-5 mm).
#[test]
#[cfg_attr(
    debug_assertions,
    ignore = "forge-ssi statistics counter underflow in debug builds (W4); runs in release"
)]
fn an_undecidable_shell_is_a_failure_naming_the_walls_not_a_limit() {
    let (a, b, c, rv, rb) = (40.0, 30.0, 20.0, 4.0, 2.0);
    let body = filleted_enclosure(a, b, c, rv, rb);
    let top = top_of(&body, a, b, c);
    let err = shell(
        &body,
        &fs(&body, &[top]),
        1.9998,
        ShellDirection::Inward,
        &sopts(),
    )
    .expect_err("undecidable");
    assert_eq!(err.code(), "SHELL_FAILED", "{err}");
    assert!(
        err.to_string().contains("cannot be verified"),
        "names what could not be verified: {err}"
    );
}
