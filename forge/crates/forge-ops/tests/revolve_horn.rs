//! Revolve of a profile whose rounded corners touch the axis (BACKLOG P1, v1 seed 47
//! #675/#975): the corner arc's carrier circle is tangent to the axis, so its side face is a
//! **horn** torus (minor = major) whose singular point closes the face where the on-axis
//! junction sweeps to no edge ([R-8, R-9], [R-16]). The corner radius, measured across a
//! subtraction (`y1 − (y1 − r)`), used to come out a few ulps under the centre's distance and
//! give a ring torus with a 1e-15 mm hole: `FORGE_UNBOUNDED_DOMAIN`.
//!
//! Every result is checked by `forge_check::validate` and against the closed-form volume
//! (Pappus): a rounded rectangle `[x0, x0 + w] × [y0, y0 + h]` with corner radius `r`, swept
//! by `Θ` about `x = 0`, has volume `Θ · (h·w²/2 − 2·w·r²·(1 − π/4) + x0·A)`, `A` its area.

use forge_core::Severity;
use forge_core::Tolerance;
use forge_core::geom::Surface;
use forge_core::topo::Body;
use forge_ir::{NamedPlane, PlaneSpec, SketchAxis, SketchCurve, SketchFeature, SweepDirection};
use forge_ops::{Region, regions, revolve, sketch_frame};
use proptest::prelude::*;

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

fn arc(id: &str, center: [f64; 2], start: [f64; 2], end: [f64; 2]) -> SketchCurve {
    SketchCurve::Arc {
        id: id.into(),
        start,
        end,
        center,
        ccw: true,
    }
}

/// The rounded rectangle of the IR `rect` compound (SPEC-v1 §4.1, `forge_ir::v1::compound`),
/// with the same member order and the same arithmetic for the arc points.
fn rounded_rect(x0: f64, y0: f64, w: f64, h: f64, r: f64) -> Vec<SketchCurve> {
    let (x1, y1) = (x0 + w, y0 + h);
    vec![
        line("bottom", [x0 + r, y0], [x1 - r, y0]),
        arc("c_br", [x1 - r, y0 + r], [x1 - r, y0], [x1, y0 + r]),
        line("right", [x1, y0 + r], [x1, y1 - r]),
        arc("c_tr", [x1 - r, y1 - r], [x1, y1 - r], [x1 - r, y1]),
        line("top", [x1 - r, y1], [x0 + r, y1]),
        arc("c_tl", [x0 + r, y1 - r], [x0 + r, y1], [x0, y1 - r]),
        line("left", [x0, y1 - r], [x0, y0 + r]),
        arc("c_bl", [x0 + r, y0 + r], [x0, y0 + r], [x0 + r, y0]),
    ]
}

fn region_of(curves: Vec<SketchCurve>) -> Region {
    let s = SketchFeature {
        id: "s".into(),
        name: "s".into(),
        suppressed: false,
        plane: PlaneSpec::Named(NamedPlane::XY),
        curves,
    };
    let mut r = regions(&s, &Tolerance::IR_DEFAULT).expect("regions");
    assert_eq!(r.len(), 1);
    r.remove(0)
}

fn y_axis() -> SketchAxis {
    SketchAxis {
        origin: [0.0, 0.0],
        direction: [0.0, 1.0],
    }
}

fn revolve_rect(x0: f64, y0: f64, w: f64, h: f64, r: f64, angle: f64, dir: SweepDirection) -> Body {
    let frame = sketch_frame(&PlaneSpec::Named(NamedPlane::XY)).expect("frame");
    revolve(
        &region_of(rounded_rect(x0, y0, w, h, r)),
        &frame,
        &y_axis(),
        angle,
        dir,
        "ring",
    )
    .expect("revolve")
}

fn errors(b: &Body) -> Vec<String> {
    forge_check::validate(b)
        .into_iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| format!("{i:?}"))
        .collect()
}

/// Pappus: `Θ · ∫ x dA` over the rounded rectangle.
fn closed_form_volume(x0: f64, w: f64, h: f64, r: f64, angle_deg: f64) -> f64 {
    let pi = std::f64::consts::PI;
    let area = w * h - (4.0 - pi) * r * r;
    let moment = h * w * w / 2.0 - 2.0 * w * r * r * (1.0 - pi / 4.0) + x0 * area;
    angle_deg.to_radians() * moment
}

/// The side face of profile curve `id` (provenance `ring/side:prof.<id>`).
fn side_surface<'a>(b: &'a Body, id: &str) -> &'a Surface {
    let name = format!("ring/side:{id}");
    &b.faces()
        .values()
        .find(|f| f.provenance.name() == name)
        .unwrap_or_else(|| panic!("no face {name}"))
        .surface
}

fn is_horn(s: &Surface) -> bool {
    matches!(s, Surface::Torus(t) if t.minor().to_bits() == t.major().to_bits())
}

fn face_types(b: &Body) -> [usize; 4] {
    let mut n = [0; 4];
    for f in b.faces().values() {
        match f.surface {
            Surface::Plane(_) => n[0] += 1,
            Surface::Cylinder(_) => n[1] += 1,
            Surface::Torus(_) => n[2] += 1,
            _ => n[3] += 1,
        }
    }
    n
}

/// The two seed-47 programs: `r_in = 0`, corner radius `min(w, h) / 4`, full revolve.
#[test]
fn seed_47_rounded_corners_on_the_axis_revolve_to_horn_tori() {
    for (y0, w, h) in [(-3.549f64, 7.342f64, 17.999f64), (-4.842, 14.985, 1.959)] {
        let r = w.min(h) / 4.0;
        for dir in [SweepDirection::Normal, SweepDirection::Symmetric] {
            let b = revolve_rect(0.0, y0, w, h, r, 360.0, dir);
            assert!(errors(&b).is_empty(), "{:#?}", errors(&b));
            let c = b.counts();
            // Seven side faces (the `left` line lies on the axis), six ring edges (the two
            // on-axis junctions sweep to singular points), no vertex at 360°.
            assert_eq!((c.faces, c.edges, c.vertices), (7, 6, 0));
            assert_eq!(face_types(&b), [2, 1, 4, 0]);
            assert!(
                is_horn(side_surface(&b, "c_tl")),
                "c_tl is not a horn torus"
            );
            assert!(
                is_horn(side_surface(&b, "c_bl")),
                "c_bl is not a horn torus"
            );
            assert!(!is_horn(side_surface(&b, "c_tr")));
            assert!(!is_horn(side_surface(&b, "c_br")));
            let v = forge_check::mass_properties(&b).expect("mass").volume;
            let want = closed_form_volume(0.0, w, h, r, 360.0);
            assert!(
                (v - want).abs() <= 1e-9 * want,
                "volume {v} vs closed form {want}"
            );
        }
    }
}

/// The corner radius that failed: `y1 − (y1 − r)` is not `r` in binary64, so the arc's
/// radius differs from its centre's distance to the axis by ulps (the direction of the error
/// depends on the numbers; both must give the horn torus).
#[test]
fn corner_radius_off_by_ulps_still_gives_a_horn_torus() {
    let (y0, h) = (-3.549, 17.999);
    let y1 = y0 + h;
    let mut seen_below = false;
    for k in 0..40 {
        let r = 0.5 + 0.0371 * f64::from(k);
        let measured = y1 - (y1 - r);
        seen_below |= measured < r;
        let b = revolve_rect(0.0, y0, 9.0, h, r, 360.0, SweepDirection::Normal);
        assert!(errors(&b).is_empty(), "r = {r}: {:#?}", errors(&b));
        assert!(is_horn(side_surface(&b, "c_tl")), "r = {r}");
        assert!(is_horn(side_surface(&b, "c_bl")), "r = {r}");
    }
    assert!(seen_below, "no radius exercised the ring-torus rounding");
}

/// A corner whose left side is more than *tol* from the axis does not touch it: its carrier is
/// a ring torus and the junction a ring edge (no snapping beyond [R-3]).
#[test]
fn corner_farther_than_tol_from_the_axis_stays_a_ring_torus() {
    let b = revolve_rect(
        2e-6,
        -3.549,
        7.342,
        17.999,
        1.8355,
        360.0,
        SweepDirection::Normal,
    );
    assert!(errors(&b).is_empty(), "{:#?}", errors(&b));
    assert!(!is_horn(side_surface(&b, "c_tl")));
    assert!(matches!(side_surface(&b, "left"), Surface::Cylinder(_)));
    let c = b.counts();
    assert_eq!((c.faces, c.edges), (8, 8));
}

/// Revolve an arbitrary profile about `x = 0` (the sketch's y axis).
fn revolve_profile(curves: Vec<SketchCurve>, angle: f64, dir: SweepDirection) -> Body {
    let frame = sketch_frame(&PlaneSpec::Named(NamedPlane::XY)).expect("frame");
    revolve(&region_of(curves), &frame, &y_axis(), angle, dir, "ring").expect("revolve")
}

/// The profile of the snapped-end cases: a line on the axis from `(0, 10)` down to the arc's
/// start `P_s` (`ψ = π − δ` on the circle of centre `(ρc, 0)` and radius `r = ρc − gap`, so
/// `P_s` lies `gap + r(1 − cos δ)` from the axis), the arc counter-clockwise to `(ρc, −r)`
/// (`ψ = 3π/2`), a line up to `(ρc, 10)` and back to the axis. Returns the curves and
/// `P_s`.
fn snapped_end_profile(rho_c: f64, gap: f64, delta: f64) -> (Vec<SketchCurve>, [f64; 2]) {
    let r = rho_c - gap;
    let a0 = std::f64::consts::PI - delta;
    let ps = [rho_c + r * a0.cos(), r * a0.sin()];
    (
        vec![
            line("axis", [0.0, 10.0], ps),
            arc("c", [rho_c, 0.0], ps, [rho_c, -r]),
            line("right", [rho_c, -r], [rho_c, 10.0]),
            line("top", [rho_c, 10.0], [0.0, 10.0]),
        ],
        ps,
    )
}

/// `∫ ρ dA` over the snapped-end profile with arc radius `r` from `ψ = π − δ` and the axis
/// line ending at `(x_s, y_s)` (Green: `∮ ρ²/2 dh`, counter-clockwise; exact primitives of
/// `cos`, `cos²`, `cos³`).
fn snapped_end_moment(rho_c: f64, r: f64, delta: f64, x_s: f64, y_s: f64) -> f64 {
    let (a0, a1) = (std::f64::consts::PI - delta, 1.5 * std::f64::consts::PI);
    let prim = |p: f64| {
        0.5 * r
            * (rho_c * rho_c * p.sin()
                + 2.0 * rho_c * r * (0.5 * p + 0.25 * (2.0 * p).sin())
                + r * r * (p.sin() - p.sin().powi(3) / 3.0))
    };
    let axis = (y_s - 10.0) * x_s * x_s / 6.0;
    let right = 0.5 * rho_c * rho_c * (10.0 + r);
    prim(a1) - prim(a0) + axis + right
}

/// Check one snapped-end revolve: valid, a horn torus for the arc, the [R-8, R-9] counts,
/// and the volume between the two readings of the profile within tolerance — the raw one
/// (radius `ρc − gap`, `P_s` where the sketch has it) and the fully snapped one (radius
/// `ρc`, `P_s` on the axis) — and within the tol-derived slack of the raw one (`Θ · 2·tol ·
/// ∫ρ ds` over the arc, which is all that moves).
fn check_snapped_end(rho_c: f64, gap: f64, delta: f64, angle: f64, dir: SweepDirection) {
    let what = format!("ρc {rho_c}, gap {gap:e}, δ {delta:e}, {angle}° {dir:?}");
    let (curves, ps) = snapped_end_profile(rho_c, gap, delta);
    let b = revolve_profile(curves, angle, dir);
    assert!(errors(&b).is_empty(), "{what}: {:#?}", errors(&b));
    // At the inclusive boundary (gap = tol, δ = 0) the start's computed distance from the
    // axis can round past tol: then it is not on the axis ([R-3] compares the sketch's
    // numbers), the arc stays a ring torus and its start a ring edge — a valid body whose
    // volume the bounds below still hold.
    let on_axis = ps[0].abs() <= Tolerance::IR_DEFAULT.linear;
    assert!(
        !on_axis || is_horn(side_surface(&b, "c")),
        "{what}: not a horn torus"
    );
    let c = b.counts();
    if !on_axis {
    } else if angle >= 360.0 {
        // Three side faces (the axis line has none), two ring edges (the on-axis junctions
        // sweep to singular points).
        assert_eq!((c.faces, c.edges, c.vertices), (3, 2, 0), "{what}");
    } else {
        // Two caps; two swept arcs, three side curves on each cap, the on-axis line; two
        // vertices per off-axis junction, one per on-axis junction.
        assert_eq!((c.faces, c.edges, c.vertices), (5, 9, 6), "{what}");
    }
    let th = angle.to_radians();
    let v = forge_check::mass_properties(&b).expect("mass").volume;
    let raw = th * snapped_end_moment(rho_c, rho_c - gap, delta, ps[0], ps[1]);
    let snapped = th * snapped_end_moment(rho_c, rho_c, delta, 0.0, ps[1]);
    let eps = 1e-9 * raw;
    assert!(
        v >= raw.min(snapped) - eps && v <= raw.max(snapped) + eps,
        "{what}: volume {v} outside [{raw}, {snapped}]"
    );
    // ∫ρ ds over the arc ≤ its length times ρ_max = 2ρc.
    let arc_len = (rho_c - gap) * (0.5 * std::f64::consts::PI + delta);
    let slack = th * 2.0 * Tolerance::IR_DEFAULT.linear * arc_len * 2.0 * rho_c;
    assert!(
        (v - raw).abs() <= eps + slack,
        "{what}: volume {v} vs raw {raw}"
    );
    if gap == 0.0 {
        assert!((v - raw).abs() <= eps, "{what}: volume {v} vs {raw}");
    }
}

/// An arc end snapped onto the axis ([R-16]) **away from** the carrier's closest point to the
/// axis (review finding): the carrier (centre `ρc`, radius `ρc − gap`, `gap ≤ tol`) comes
/// within `gap` of the axis at `ψ = π`, inside the arc `[π − δ, 3π/2]`, and the arc's start
/// lies `gap + r(1 − cos δ) ≤ tol` from it. The face is a horn torus whose singular point is
/// interior to its `ψ` range, not on the junction; full and partial sweeps are valid and
/// their volumes are bounded by the two readings of the profile.
#[test]
fn arc_end_snapped_onto_the_axis_away_from_the_tangent_point() {
    for (rho_c, gap, delta) in [
        (10.0, 3e-7, 2e-4),
        (10.0, 0.0, 2e-4),
        (1.0, 9e-7, 2e-4),
        (5.0, 5e-7, 3e-4),
    ] {
        for (angle, dir) in [
            (360.0, SweepDirection::Normal),
            (90.0, SweepDirection::Normal),
            (90.0, SweepDirection::Symmetric),
            (200.0, SweepDirection::Reverse),
        ] {
            check_snapped_end(rho_c, gap, delta, angle, dir);
        }
    }
}

/// Pins today's outcome of a region that touches the axis at an **interior** point of an
/// arc (review finding; a contract question, not a regression): a stadium `[2, 10] × [−2, 2]`
/// closed on the left by the half circle of centre `(2, 0)`, radius 2, which touches `x = 0`
/// at `(0, 0)`. The arc's face is a horn torus with its singular point inside the face; the
/// solid pinches there to a point, as a profile *vertex* touching the axis gives a double
/// cone (SPEC §4.4 lets both through: no rule rejects an isolated contact with the axis).
/// The body passes `forge_check::validate` and has the exact Pappus volume
/// `Θ · (192 + 4π − 16/3)`. If the Contract stage rules that such a profile must fail (or be
/// split at the contact), this test changes with the ruling.
#[test]
fn stadium_touching_the_axis_inside_an_arc_pins_todays_body() {
    let stadium = || {
        vec![
            line("b", [2.0, -2.0], [10.0, -2.0]),
            line("r", [10.0, -2.0], [10.0, 2.0]),
            line("t", [10.0, 2.0], [2.0, 2.0]),
            arc("c", [2.0, 0.0], [2.0, 2.0], [2.0, -2.0]),
        ]
    };
    for (angle, counts) in [(360.0, (4, 4, 0)), (90.0, (6, 12, 8))] {
        let b = revolve_profile(stadium(), angle, SweepDirection::Normal);
        assert!(errors(&b).is_empty(), "{angle}°: {:#?}", errors(&b));
        assert!(is_horn(side_surface(&b, "c")), "{angle}°");
        let c = b.counts();
        assert_eq!((c.faces, c.edges, c.vertices), counts, "{angle}°");
        let v = forge_check::mass_properties(&b).expect("mass").volume;
        let want = f64::to_radians(angle) * (192.0 + 4.0 * std::f64::consts::PI - 16.0 / 3.0);
        assert!(
            (v - want).abs() <= 1e-12 * want,
            "{angle}°: volume {v} vs {want}"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Snapped-end arcs of any size: carrier gap up to *tol* inclusive (review finding: the
    /// band `(0.9·tol, tol]` was never reached), the start within *tol* of the axis, any
    /// sweep.
    #[test]
    fn arc_ends_snapped_away_from_the_tangent_point_are_bounded_by_both_readings(
        rho_c in 0.5f64..50.0,
        gap_frac in prop_oneof![0.0f64..=1.0, Just(1.0f64)],
        delta_frac in 0.05f64..1.0,
        angle in prop_oneof![Just(360.0f64), 5.0f64..359.0],
        dir in prop_oneof![
            Just(SweepDirection::Normal),
            Just(SweepDirection::Reverse),
            Just(SweepDirection::Symmetric),
        ],
    ) {
        let tol = Tolerance::IR_DEFAULT.linear;
        let gap = gap_frac * tol;
        let r = rho_c - gap;
        // The start's distance from the axis, gap + r(1 − cos δ), at most tol (δ = 0 when the
        // gap is tol: the arc starts at the carrier's point nearest the axis).
        let room = (tol - gap).max(0.0);
        let delta = delta_frac * (1.0 - room / r).acos();
        check_snapped_end(rho_c, gap, delta, angle, dir);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(96))]

    /// Rounded rectangles with their left side on the axis (exactly, or within *tol* on either
    /// side, the boundary `±tol` included, snapped by [R-3]/[R-16]), any size, corner radius
    /// and sweep: a valid body whose
    /// corner faces on the axis are horn tori, with the closed-form volume.
    #[test]
    fn rounded_rectangle_on_the_axis_matches_its_closed_form(
        y0 in -30.0f64..30.0,
        w in 0.5f64..60.0,
        h in 0.5f64..60.0,
        frac in 0.02f64..0.45,
        x0 in prop_oneof![
            (-10i32..=10).prop_map(|k| f64::from(k) * 1e-7),
            // The inclusive boundary and a few ulps inside it, on either side (review
            // finding: `x0_steps` stopped at 0.9·tol).
            Just(1e-6f64),
            Just(-1e-6f64),
            (1u64..=16).prop_map(|u| f64::from_bits(1e-6f64.to_bits() - u)),
            (1u64..=16).prop_map(|u| -f64::from_bits(1e-6f64.to_bits() - u)),
        ],
        angle in prop_oneof![Just(360.0f64), 5.0f64..359.0],
        dir in prop_oneof![
            Just(SweepDirection::Normal),
            Just(SweepDirection::Reverse),
            Just(SweepDirection::Symmetric),
        ],
    ) {
        let r = frac * w.min(h);
        let b = revolve_rect(x0, y0, w, h, r, angle, dir);
        prop_assert!(errors(&b).is_empty(), "{:#?}", errors(&b));
        prop_assert!(is_horn(side_surface(&b, "c_tl")));
        prop_assert!(is_horn(side_surface(&b, "c_bl")));
        let c = b.counts();
        if angle >= 360.0 {
            prop_assert_eq!((c.faces, c.edges, c.vertices), (7, 6, 0));
        } else {
            // Two caps; six swept arcs, two copies of each of the seven side curves, the
            // shared on-axis line; two vertices per off-axis junction and one per on-axis one.
            prop_assert_eq!((c.faces, c.edges, c.vertices), (9, 21, 14));
        }
        let v = forge_check::mass_properties(&b).expect("mass").volume;
        let area = w * h - (4.0 - std::f64::consts::PI) * r * r;
        let want = closed_form_volume(0.0, w, h, r, angle);
        // Snapping moves the left side by |x0| ≤ tol and the corner ends by ≤ tol.
        let slack = angle.to_radians() * area * 2.0 * Tolerance::IR_DEFAULT.linear;
        prop_assert!((v - want).abs() <= 1e-9 * want + slack, "volume {} vs {}", v, want);
        if x0 == 0.0 {
            prop_assert!((v - want).abs() <= 1e-9 * want, "volume {} vs {}", v, want);
        }
    }
}

/// The inclusive tolerance boundary (review finding): a rounded rectangle whose left side
/// lies exactly *tol* from the axis, a few ulps inside, or *tol* beyond it, revolved fully
/// and partially. The corner radius spans 40 values (`w = 2r + 3`, the review's adversarial
/// scan). The on-axis test of a junction (`|ρ| ≤ tol`) and the corner's carrier gap
/// (`(x0 + r) − r`) round differently there, so the corner face must be chosen from the
/// junction (a horn torus whenever its end is on the axis), and the cap copies of its arc
/// must carry the face's deviation `|r − ρc|` (up to `tol` plus rounding) as their
/// tolerance, as the line copies do. Every body is valid (including its mass properties) and
/// within the snapping slack of the closed-form volume.
#[test]
fn rounded_rectangles_at_the_inclusive_tolerance_boundary_are_valid() {
    let tol = Tolerance::IR_DEFAULT.linear;
    let below = |x: f64, ulps: u64| f64::from_bits(x.to_bits() - ulps);
    let x0s = [
        tol,
        below(tol, 1),
        below(tol, 8),
        -tol,
        -below(tol, 1),
        0.999e-6,
        0.9e-6,
        -0.9e-6,
    ];
    let (y0, h) = (-3.549, 17.999);
    let mut failures = Vec::new();
    // Every 4th radius in a debug build (the full scan takes a minute there).
    let step = if cfg!(debug_assertions) { 4 } else { 1 };
    let ks: Vec<i32> = (0..40).step_by(step).collect();
    for &k in &ks {
        let r = 0.3 + 0.173 * f64::from(k);
        let w = 2.0 * r + 3.0;
        for &x0 in &x0s {
            for (angle, dir) in [
                (360.0, SweepDirection::Normal),
                (45.0, SweepDirection::Normal),
                (200.0, SweepDirection::Symmetric),
            ] {
                let what = format!("r {r}, x0 {x0:e}, {angle}°");
                let frame = sketch_frame(&PlaneSpec::Named(NamedPlane::XY)).expect("frame");
                let b = match revolve(
                    &region_of(rounded_rect(x0, y0, w, h, r)),
                    &frame,
                    &y_axis(),
                    angle,
                    dir,
                    "ring",
                ) {
                    Ok(b) => b,
                    Err(e) => {
                        failures.push(format!("{what}: {e}"));
                        continue;
                    }
                };
                let errs = errors(&b);
                if !errs.is_empty() {
                    failures.push(format!("{what}: {errs:?}"));
                    continue;
                }
                if !(is_horn(side_surface(&b, "c_tl")) && is_horn(side_surface(&b, "c_bl"))) {
                    failures.push(format!("{what}: a corner on the axis is not a horn torus"));
                    continue;
                }
                let v = match forge_check::mass_properties(&b) {
                    Ok(m) => m.volume,
                    Err(e) => {
                        failures.push(format!("{what}: mass properties: {e}"));
                        continue;
                    }
                };
                let area = w * h - (4.0 - std::f64::consts::PI) * r * r;
                let want = closed_form_volume(0.0, w, h, r, angle);
                let slack = f64::to_radians(angle) * area * 2.0 * tol;
                if (v - want).abs() > 1e-9 * want + slack {
                    failures.push(format!("{what}: volume {v} vs closed form {want}"));
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases fail:\n{}",
        failures.len(),
        ks.len() * x0s.len() * 3,
        failures.join("\n")
    );
}

/// A notch box `[8, 12] × [2, 4] × [−1, 1]` cut into the rim of a revolved knob.
fn rim_notch() -> Body {
    let pts = [[8.0, 2.0], [12.0, 2.0], [12.0, 4.0], [8.0, 4.0]];
    forge_ops::boolean::corpus::Operand {
        feature: "k".into(),
        sketch: SketchFeature {
            id: "s_k".into(),
            name: "s_k".into(),
            suppressed: false,
            plane: PlaneSpec::Frame(forge_ir::Frame {
                origin: [0.0, 0.0, -1.0],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves: (0..4)
                .map(|k| line(&format!("e{k}"), pts[k], pts[(k + 1) % 4]))
                .collect(),
        },
        sweep: forge_ops::boolean::corpus::Sweep::Extrude {
            distance: 2.0,
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("notch")
}

fn cut_knob(
    knob: Body,
) -> Result<forge_ops::boolean::BodyOpResult, forge_ops::boolean::BooleanError> {
    let ob = |body: Body, feature: &str, timeline: usize| forge_ops::boolean::OpBody {
        body,
        origin: forge_ir::v1::metrics::Origin {
            feature: feature.into(),
            member: "m".into(),
            instance: None,
        },
        timeline,
    };
    forge_ops::boolean::apply_body_op(
        forge_ops::boolean::BodyOp::Cut,
        &[ob(knob, "ring", 0)],
        &[ob(rim_notch(), "k", 1)],
        "e1",
    )
}

/// Review round 5 (BACKLOG P1 "booleans on horn-torus faces"): the revolve of a rounded
/// profile whose corners touch the axis is solved (horn tori, above), but the booleans do
/// not take horn-torus faces yet (`boolean::geom::supported_surface`: minor < major), so the
/// next feature on such a knob fails — explicitly, with `FORGE_BOOLEAN_UNSUPPORTED` naming
/// the corner's face — even a notch in the rim far from the tori. This pins today's outcome
/// with the review's program (rounded rectangle at `[0, 0]`, 10 × 6, radius 2, 360° about
/// Y); when booleans handle horn tori, replace the pin by the control's closed form. The
/// control: the same knob 1e-3 mm off the axis (ring tori, a 1e-3 mm bore) takes the notch
/// with the exact volume.
#[test]
fn a_cut_into_a_knob_with_horn_tori_fails_explicitly_until_booleans_take_them() {
    let knob = revolve_rect(0.0, 0.0, 10.0, 6.0, 2.0, 360.0, SweepDirection::Normal);
    assert!(errors(&knob).is_empty(), "{:#?}", errors(&knob));
    match cut_knob(knob) {
        Err(e) => {
            assert_eq!(e.code(), "FORGE_BOOLEAN_UNSUPPORTED", "{e}");
            assert!(e.to_string().contains("horn"), "{e}");
        }
        Ok(r) => panic!(
            "the cut now succeeds ({} bodies): booleans take horn tori; pin the closed form",
            r.bodies.len()
        ),
    }
    // Control: ring tori.
    let x0 = 1e-3;
    let knob = revolve_rect(x0, 0.0, 10.0, 6.0, 2.0, 360.0, SweepDirection::Normal);
    let r = cut_knob(knob).expect("cut with ring tori");
    assert_eq!(r.bodies.len(), 1);
    let b = &r.bodies[0].body;
    assert!(errors(b).is_empty(), "{:#?}", errors(b));
    let big_r: f64 = x0 + 10.0;
    let f = |z: f64| {
        0.5 * z * (big_r * big_r - z * z).sqrt() + 0.5 * big_r * big_r * (z / big_r).asin()
    };
    let notch = 2.0 * (f(1.0) - f(-1.0) - 16.0);
    let want = closed_form_volume(x0, 10.0, 6.0, 2.0, 360.0) - notch;
    let v = forge_check::mass_properties(b).expect("mass").volume;
    assert!((v - want).abs() <= 1e-9 * want, "volume {v} vs {want}");
}
