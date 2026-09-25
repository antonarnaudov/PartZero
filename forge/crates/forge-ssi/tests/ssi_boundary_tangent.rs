//! Tangent points on the seam of the search box (boolean seed 53 #38, #387; BACKLOG P1
//! "Boolean explicit errors").
//!
//! Two perpendicular cylinders touching at a point have a singular point of the section
//! there (two branches crossing). When that point lies on the seam of a full-period box
//! (`u = u₀ ≡ u₀ + 2π`), three things went wrong in the march (forge-ssi `ssi::march`):
//! - the cell at one end of the period missed the point by the rounding of `u₀ + 2π` and
//!   was certified regular, so the irregular cluster existed at the other end only and
//!   traces ran through the point from the first end (`March::across_seam` now requires
//!   regularity across the seam);
//! - a branch end stuck next to the seam was matched to clusters without wrapping the
//!   period (`nearest_cluster`): `SSI_NOT_CONVERGED` "after 0 iterations";
//! - the duplicate-seed test slid from a branch's end through the crossing onto another
//!   arm and skipped that arm's seeds (`distance_to_branch`): `SSI_TANGENT_UNRESOLVED` with
//!   an odd number of branch ends.
//!
//! Two more when the point lies just **inside** one end of the period (1e-14 to 1e-9 in `u`
//! from the seam, as a rotated scene or a box start a few ulps off the tangent line gives):
//! - the cell across the seam was certified regular with the point an ulp-sized distance
//!   beyond its edge (the across-seam band covered 8 ulps only; it is now one minimal
//!   cell): `SSI_TANGENT_UNRESOLVED`, five branch ends;
//! - with `2r = R` the section is tangent to the line `u = 5π/2` (B's far line meets A's
//!   axis plane), a cell edge of the initial grid 1e-14 away: its two crossings are a
//!   near-double root placed only to within `G`'s rounding, so one traced point lay 3e-7 mm
//!   behind the previous one and reversed its node's tangent (`fit_branch` now drops such
//!   points): `SSI_NOT_CONVERGED` at "fit node projection". The property below excluded
//!   `2r = R` until then.
//!
//! Each result is checked against the output contract (points on both surfaces, pcurves)
//! and against a brute-force sampler for missed branches.

mod common;

use common::{check_contract, frame, missed_samples};
use forge_core::geom::{Cylinder, Surface};
use forge_core::math;
use forge_core::{Frame, Vec3};
use forge_ssi::{SsiTolerance, UvBox, intersect_surfaces};
use proptest::prelude::*;

fn tol() -> SsiTolerance {
    SsiTolerance::default()
}

/// The face pair of boolean seed 53 #38 (`a/side:c × b/side:c`), boxes as the boolean
/// passes them: A's box starts at `u = π`, the tangent point `(−1.25, 3, −2.5)`.
fn case_38() -> (Surface, UvBox, Surface, UvBox) {
    let a: Surface = Cylinder::new(
        frame([2.75, 3.0, -3.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        4.0,
    )
    .expect("a")
    .into();
    let b: Surface = Cylinder::new(
        frame([-0.25, 2.25, -2.5], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
        1.0,
    )
    .expect("b")
    .into();
    let da = UvBox::new(math::PI, 3.0 * math::PI, -8e-6, 7.000008000000001);
    let db = UvBox::new(
        math::PI,
        3.0 * math::PI,
        -7.2831853071795856e-6,
        4.500007283185308,
    );
    (a, da, b, db)
}

/// The face pair of boolean seed 53 #387 (`a/side:c × b/side:w`): tangent at `(0, −3.5, 1)`,
/// A's seam and the end of B's half-period box.
fn case_387() -> (Surface, UvBox, Surface, UvBox) {
    let a: Surface = Cylinder::new(
        frame([-3.5, 1.5, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        5.0,
    )
    .expect("a")
    .into();
    let b: Surface = Cylinder::new(
        frame([0.0, -1.5, -1.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        2.0,
    )
    .expect("b")
    .into();
    let da = UvBox::new(
        math::PI,
        3.0 * math::PI,
        -7.2831853071795856e-6,
        4.000007283185308,
    );
    let db = UvBox::new(
        7.853973133974483,
        10.995582787564278,
        -8.5e-6,
        7.500008500000002,
    );
    (a, da, b, db)
}

#[test]
fn tangent_point_on_the_seam_of_the_search_box_38() {
    let (a, da, b, db) = case_38();
    let g = intersect_surfaces(&a, da, &b, db, &tol()).expect("no SSI_NOT_CONVERGED");
    check_contract(&g, &a, &b, 1e-7);
    assert_eq!(missed_samples(&g, &a, &da, &b, &db, 200, 0.05), 0);
    assert_eq!(missed_samples(&g, &b, &db, &a, &da, 200, 0.05), 0);
    // Within B's box (y ≤ 2.25, clear of the tangent point at y = 3) the section is one arc
    // of B's circle, cut by A's box at z = 0 (A's bottom) into a short and a long piece.
    assert_eq!(g.branches.len(), 2, "{:#?}", g.stats);
    assert!(g.branches.iter().all(|br| !br.closed));
}

#[test]
fn tangent_point_on_the_seam_of_the_search_box_387() {
    let (a, da, b, db) = case_387();
    let g = intersect_surfaces(&a, da, &b, db, &tol()).expect("no SSI_NOT_CONVERGED");
    check_contract(&g, &a, &b, 1e-7);
    assert_eq!(missed_samples(&g, &a, &da, &b, &db, 200, 0.05), 0);
    assert_eq!(missed_samples(&g, &b, &db, &a, &da, 200, 0.05), 0);
    assert!(!g.branches.is_empty());
}

/// The tangent point on the seam of A's full-period box or just inside one end of it (A's
/// box starts `off` from the tangent line, `|off|` from 1e-16 to 1e-3), for perpendicular
/// cylinders touching internally, among them `2r = R` (the section also tangent to the grid
/// edge `u = 5π/2`). Before the fixes, offsets from 1e-14 to 1e-9 failed explicitly:
/// `SSI_TANGENT_UNRESOLVED` (five branch ends) for `(5.5, 4.75)` and `(3, 2.25)`,
/// `SSI_NOT_CONVERGED` at "fit node projection" for every `2r = R` pair. Each result meets
/// the output contract and misses no sampled intersection point.
#[test]
fn tangent_points_within_a_minimal_cell_of_the_seam_are_resolved() {
    let pairs: &[(f64, f64)] = if cfg!(debug_assertions) {
        &[(4.0, 2.0), (5.5, 4.75), (3.0, 2.25)]
    } else {
        &[
            (4.0, 2.0),
            (2.0, 1.0),
            (7.0, 3.5),
            (5.5, 4.75),
            (3.0, 2.25),
            (7.5, 3.5),
        ]
    };
    let mut offsets = vec![0.0f64];
    for e in [
        1e-16, 4.4e-16, 1e-15, 1e-14, 1e-13, 1e-12, 1e-11, 1e-10, 1e-9, 1e-8, 1e-6, 1e-4, 1e-3,
    ] {
        offsets.extend([e, -e]);
    }
    let n = if cfg!(debug_assertions) { 40 } else { 120 };
    for &(big_r, r) in pairs {
        for &(z0, y_lo, y_len) in &[(2.0, -3.0, 4.0), (0.5, -6.0, 7.75)] {
            for &off in &offsets {
                let what = format!("R {big_r}, r {r}, z0 {z0}, offset {off:e}");
                let a: Surface = Cylinder::new(
                    frame([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
                    big_r,
                )
                .expect("a")
                .into();
                let b: Surface = Cylinder::new(
                    frame(
                        [-big_r + r, y_lo + y_len, z0],
                        [0.0, -1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ),
                    r,
                )
                .expect("b")
                .into();
                let da = UvBox::new(math::PI + off, 3.0 * math::PI + off, 0.0, z0 + 3.0);
                let db = UvBox::new(math::PI, 3.0 * math::PI, 0.0, y_len);
                let g = intersect_surfaces(&a, da, &b, db, &tol())
                    .unwrap_or_else(|e| panic!("{what}: {e:?}"));
                check_contract(&g, &a, &b, 1e-7);
                assert_eq!(missed_samples(&g, &a, &da, &b, &db, n, 0.05), 0, "{what}");
                assert_eq!(missed_samples(&g, &b, &db, &a, &da, n, 0.05), 0, "{what}");
            }
        }
    }
}

/// A rigid motion: rotation `(x, y, z)` columns, then translation.
struct Motion {
    x: Vec3,
    y: Vec3,
    z: Vec3,
    t: Vec3,
}

impl Motion {
    fn new(a: Vec3, b: Vec3, t: Vec3) -> Option<Motion> {
        let z = a.normalize()?;
        let x = (b - z * b.dot(z)).normalize()?;
        Some(Motion {
            x,
            y: z.cross(x),
            z,
            t,
        })
    }
    fn dir(&self, v: [f64; 3]) -> [f64; 3] {
        (self.x * v[0] + self.y * v[1] + self.z * v[2]).to_array()
    }
    fn point(&self, p: [f64; 3]) -> [f64; 3] {
        (Vec3::from(self.dir(p)) + self.t).to_array()
    }
    fn frame(&self, o: [f64; 3], n: [f64; 3], x: [f64; 3]) -> Frame {
        frame(self.point(o), self.dir(n), self.dir(x))
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        // Debug builds run a subset (the missed-branch sampler dominates).
        cases: if cfg!(debug_assertions) { 40 } else { 120 },
        max_global_rejects: 100_000,
        ..ProptestConfig::default()
    })]

    /// A cylinder of radius `R` (axis z, box `u ∈ [π, 3π]`: the seam at `(−R, 0, ·)`) and a
    /// perpendicular cylinder of radius `r < R` (axis ∥ y) touching it from inside at
    /// `(−R, 0, z₀)`, on that seam (or, with a seam offset, up to 1e-8 inside one end of
    /// A's period); B's box starts at its own touching line or not, covers the tangent point
    /// or ends before it; the scene axis-aligned or in a random position.
    /// Quarter-millimetre sizes, as the boolean corpus makes them, put the point exactly on
    /// the seam in floating point (without the fixes the property fails within a few cases).
    /// The intersection is computed (never `SSI_NOT_CONVERGED`), meets the output contract, and
    /// misses no sampled intersection point.
    #[test]
    fn seam_tangent_points_are_resolved(
        q_big_r in 8u32..32,
        q_r in 2u32..24,
        q_z0 in 2u32..20,
        q_y_lo in -24i32..4,
        q_y_len in 4u32..32,
        b_seam_at_contact in any::<bool>(),
        seam_offset in prop_oneof![
            3 => Just(0.0f64),
            1 => (-15i32..=-8, any::<bool>())
                .prop_map(|(e, neg)| if neg { -(10f64.powi(e)) } else { 10f64.powi(e) }),
        ],
        placed in any::<bool>(),
        n in (-1.0f64..1.0, -1.0f64..1.0, -1.0f64..1.0),
        m in (-1.0f64..1.0, -1.0f64..1.0, -1.0f64..1.0),
        t in (-20.0f64..20.0, -20.0f64..20.0, -20.0f64..20.0),
    ) {
        // Quarter-millimetre values, as the boolean corpus generates them (the seed-53
        // failures needed the tangent point exactly on the seam in floating point). `2r = R`
        // included: the section is then tangent to a cell edge of the initial grid.
        let (big_r, r) = (0.25 * f64::from(q_big_r), 0.25 * f64::from(q_r));
        prop_assume!(r < big_r);
        let (z0, y_lo, y_len) = (0.25 * f64::from(q_z0), 0.25 * f64::from(q_y_lo), 0.25 * f64::from(q_y_len));
        let (nv, mv) = if placed {
            (Vec3::new(n.0, n.1, n.2), Vec3::new(m.0, m.1, m.2))
        } else {
            (Vec3::new(0.0, 0.0, 1.0), Vec3::new(1.0, 0.0, 0.0))
        };
        prop_assume!(nv.norm() > 0.1 && mv.norm() > 0.1);
        prop_assume!(mv.normalize().expect("m").cross(nv.normalize().expect("n")).norm() > 0.1);
        // No box edge tangent to the section: the brute-force sampler counts a curve that
        // touches a box edge from outside as one point, the SSI clips it away (a piece of
        // length zero). On the section `y² = R² − x²` with `x ∈ [−R, 2r − R]` (B's circle):
        // `|y|` is extreme at `x = 0` (`R`, when the range reaches it), at B's far line
        // `x = 2r − R`, and at the tangent point (`0`); `z = z₀ ± r` at B's top and bottom.
        let y_far = (big_r * big_r - (2.0 * r - big_r).powi(2)).max(0.0).sqrt();
        for edge in [y_lo, y_lo + y_len] {
            for y_ext in [big_r, y_far, 0.0] {
                prop_assume!((edge.abs() - y_ext).abs() > 0.01);
            }
        }
        for edge in [0.0, z0 + 3.0] {
            prop_assume!((edge - (z0 + r)).abs() > 0.01 && (edge - (z0 - r)).abs() > 0.01);
        }
        // Nor the section through a corner of both boxes (B's `y` end and A's bottom or top
        // at once, e.g. `(1.25, −3, 0)` for `R = 3.25`, `r = 2.5`, `z₀ = 1.5`): the sampler
        // then finds an isolated crossing the SSI clips to a point.
        for ye in [y_lo, y_lo + y_len] {
            let xx = big_r * big_r - ye * ye;
            if xx < 0.0 {
                continue;
            }
            for x in [xx.sqrt(), -xx.sqrt()] {
                let c = (x + big_r - r) / r;
                if c.abs() > 1.0 {
                    continue;
                }
                let s = (1.0 - c * c).sqrt();
                for z in [z0 + r * s, z0 - r * s] {
                    prop_assume!(z.abs() > 0.01 && (z - (z0 + 3.0)).abs() > 0.01);
                }
            }
        }
        let t = if placed { Vec3::new(t.0, t.1, t.2) } else { Vec3::zero() };
        let w = Motion::new(nv, mv, t).expect("a rotation");
        let a: Surface = Cylinder::new(w.frame([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]), big_r)
            .expect("a")
            .into();
        // B's axis along −y through (−R + r, ·, z0); its frame x points at +x, so its `u = π`
        // is the touching line when `b_seam_at_contact`.
        let bx = if b_seam_at_contact { [1.0, 0.0, 0.0] } else { [0.0, 0.0, 1.0] };
        let b: Surface = Cylinder::new(
            w.frame([-big_r + r, y_lo + y_len, z0], [0.0, -1.0, 0.0], bx),
            r,
        )
        .expect("b")
        .into();
        // A's box starts on the tangent line, or up to 1e-8 off it (the point just inside
        // one end of the period).
        let da = UvBox::new(math::PI + seam_offset, 3.0 * math::PI + seam_offset, 0.0, z0 + 3.0);
        let db = UvBox::new(math::PI, 3.0 * math::PI, 0.0, y_len);
        let g = intersect_surfaces(&a, da, &b, db, &tol());
        prop_assert!(g.is_ok(), "{:?}", g.err());
        let g = g.expect("checked");
        check_contract(&g, &a, &b, 1e-7);
        prop_assert_eq!(missed_samples(&g, &a, &da, &b, &db, 120, 0.05), 0);
        prop_assert_eq!(missed_samples(&g, &b, &db, &a, &da, 120, 0.05), 0);
    }
}
