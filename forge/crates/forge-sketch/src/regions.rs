//! Regions of a sketch's literal geometry (SPEC-v1 §4.5): the non-construction lines, arcs,
//! circles and compound members go through v0 §3 (forge-ops' staged checks, loops, nesting,
//! canonical regions); points and construction curves are ignored.

use forge_core::Tolerance;
use forge_core::math;
use forge_ir::P2;
use forge_ir::v1::{LINEAR_TOLERANCE, LiteralCurve, RegionSelection};
use forge_ops::{Loop, Region};

use crate::error::SketchError;
use crate::geometry::is_profile;

/// The v0 curves the regions are built from: the profile curves in sketch order (compound
/// members in place of their compound). `forge_ops::LoopCurve::sketch_index` indexes this list.
pub(crate) fn profile_curves(curves: &[LiteralCurve]) -> Vec<forge_ir::SketchCurve> {
    curves
        .iter()
        .filter(|c| is_profile(c))
        .filter_map(|c| match c {
            LiteralCurve::Line { id, start, end, .. } => Some(forge_ir::SketchCurve::Line {
                id: id.clone(),
                start: *start,
                end: *end,
            }),
            LiteralCurve::Arc {
                id,
                start,
                end,
                center,
                ccw,
                ..
            } => Some(forge_ir::SketchCurve::Arc {
                id: id.clone(),
                start: *start,
                end: *end,
                center: *center,
                ccw: *ccw,
            }),
            LiteralCurve::Circle {
                id, center, radius, ..
            } => Some(forge_ir::SketchCurve::Circle {
                id: id.clone(),
                center: *center,
                radius: *radius,
            }),
            LiteralCurve::Point { .. } => None,
        })
        .collect()
}

/// v0 §3 on the profile curves. A sketch without profile curves (only points and
/// construction geometry, e.g. a hole-placement sketch) has no regions and no error.
pub(crate) fn regions_of(
    sketch_id: &str,
    profile: &[forge_ir::SketchCurve],
) -> Result<Vec<Region>, SketchError> {
    if profile.is_empty() {
        return Ok(Vec::new());
    }
    let v0 = forge_ir::SketchFeature {
        id: sketch_id.to_string(),
        name: sketch_id.to_string(),
        suppressed: false,
        // Regions are computed in sketch coordinates; the plane is irrelevant here.
        plane: forge_ir::PlaneSpec::Named(forge_ir::NamedPlane::XY),
        curves: profile.to_vec(),
    };
    forge_ops::regions(&v0, &Tolerance::IR_DEFAULT).map_err(SketchError::Regions)
}

/// The regions a body feature selects (SPEC-v1 §4.5): `"all"`, or for each listed curve id the
/// region whose **outer loop** contains that curve; each region once, in canonical order.
pub fn select_regions<'a>(
    regions: &'a [Region],
    selection: &RegionSelection,
) -> Result<Vec<&'a Region>, RegionNotFound> {
    match selection {
        RegionSelection::All(_) => Ok(regions.iter().collect()),
        RegionSelection::Curves(ids) => {
            let mut picked = vec![false; regions.len()];
            for id in ids {
                let k = regions
                    .iter()
                    .position(|r| r.outer.curves.iter().any(|c| &c.id == id))
                    .ok_or_else(|| RegionNotFound { curve: id.clone() })?;
                picked[k] = true;
            }
            Ok(regions
                .iter()
                .zip(picked)
                .filter(|(_, p)| *p)
                .map(|(r, _)| r)
                .collect())
        }
    }
}

/// No region's outer loop contains the curve (`REGION_NOT_FOUND`, details `{ "curve" }`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("no region of the sketch has curve {curve:?} on its outer loop")]
pub struct RegionNotFound {
    /// The selecting curve id.
    pub curve: String,
}

impl RegionNotFound {
    /// `REGION_NOT_FOUND`.
    pub fn code(&self) -> &'static str {
        "REGION_NOT_FOUND"
    }
    /// `{ "curve" }`.
    pub fn details(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        m.insert("curve".into(), serde_json::json!(self.curve));
        m
    }
}

/// Signed area (positive = counter-clockwise) of `lp`'s traversal evaluated on `curves`
/// (looked up by id): the area of the closed polygon through the curves' traversal ends in
/// loop order — every curve's chord, and a straight **gap chord** from each curve's traversal
/// end to the next one's traversal start, the last back to the first — plus the circular
/// segment `½ r² (θ − sin θ)` of every arc, with its signed sweep θ in the traversal
/// direction. `None` for a loop with a circle (a circle cannot flip) or an unknown curve.
///
/// On the solution the loop is closed and every gap chord has length ≤ *tol*. The stored
/// guess need not be closed along the solved loop: two ends a `coincident` constraint joins
/// (instead of welding) are apart in the guess. Closing the gaps makes the area the one of the
/// polygon the solved loop implies, so it does not depend on where the sketch sits: the
/// shoelace sum of an **open** chain changes by `½ T × (end − start)` under a translation `T`,
/// which would make the sign comparison of the flip check depend on the sketch's position.
/// Every term is taken relative to the loop's first traversal point (a closed polygon's area
/// is the same about any origin; a local one keeps the products small far from the origin).
///
/// Also returns the traversal's length: every chord (arc length for arcs) and gap chord.
#[allow(clippy::float_cmp)] // an exact full-turn test on the reduced sweep
fn traversal(lp: &Loop, curves: &[LiteralCurve]) -> Option<Traversal> {
    let cross_about =
        |o: P2, a: P2, b: P2| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut area = 0.0;
    let mut length = 0.0;
    // The loop's first traversal point (the origin of every term) and the previous curve's
    // traversal end (the start of the next gap chord).
    let mut origin: Option<P2> = None;
    let mut previous_end: Option<P2> = None;
    for lc in &lp.curves {
        let c = curves.iter().find(|c| c.id() == lc.id)?;
        let (p0, p1, seg, len) = match c {
            LiteralCurve::Line { start, end, .. } => {
                (*start, *end, 0.0, crate::geometry::dist(*start, *end))
            }
            LiteralCurve::Arc {
                start,
                end,
                center,
                ccw,
                ..
            } => {
                let r = crate::geometry::dist(*start, *center);
                let a0 = math::atan2(start[1] - center[1], start[0] - center[0]);
                let a1 = math::atan2(end[1] - center[1], end[0] - center[0]);
                let ccw_sweep = |from: f64, to: f64| {
                    let s = math::rem_euclid(to - from, math::TAU);
                    if s == 0.0 { math::TAU } else { s }
                };
                let sweep = if *ccw {
                    ccw_sweep(a0, a1)
                } else {
                    -ccw_sweep(a1, a0)
                };
                (
                    *start,
                    *end,
                    0.5 * r * r * (sweep - math::sin(sweep)),
                    r * sweep.abs(),
                )
            }
            LiteralCurve::Circle { .. } | LiteralCurve::Point { .. } => return None,
        };
        let (a, b, seg): (P2, P2, f64) = if lc.reversed {
            (p1, p0, -seg)
        } else {
            (p0, p1, seg)
        };
        let o = *origin.get_or_insert(a);
        if let Some(p) = previous_end {
            // The gap chord p → a (zero when the loop is closed there).
            area += 0.5 * cross_about(o, p, a);
            length += crate::geometry::dist(p, a);
        }
        area += 0.5 * cross_about(o, a, b) + seg;
        length += len;
        previous_end = Some(b);
    }
    // The closing gap chord (last end → origin) contributes (end − o) × (o − o) = 0 to the
    // area, and its length.
    if let (Some(o), Some(p)) = (origin, previous_end) {
        length += crate::geometry::dist(p, o);
    }
    Some(Traversal { area, length })
}

/// A loop's traversal evaluated on some geometry ([`traversal`]).
#[derive(Debug, Clone, Copy)]
struct Traversal {
    /// Signed area, positive counter-clockwise.
    area: f64,
    /// Length of the closed traversal, mm.
    length: f64,
}

impl Traversal {
    /// The orientation: `Some(true)` counter-clockwise, `Some(false)` clockwise, `None` when
    /// the loop has none at the tolerance scale — `|area| ≤ tol × length`. A closed curve of
    /// length L inside a strip of width w encloses at most w·L/2, so every loop that lies
    /// within *tol* of a straight line (a degenerate, collinear guess) is below the bound,
    /// and the sign of its computed area — decided by roundoff — is never used. (Roundoff
    /// on the area stays far below the bound for any loop smaller than ~1e9 mm / curves.)
    fn orientation(self) -> Option<bool> {
        if self.area.abs() <= LINEAR_TOLERANCE * self.length || self.area.is_nan() {
            None
        } else {
            Some(self.area > 0.0)
        }
    }
}

/// SPEC-v1 §4.4 rule 8: the loops of the solution whose signed area has the opposite sign in
/// the stored guess (the solver jumped to a mirrored configuration). The stored guess is
/// measured along the solved loop with its gaps closed ([`traversal`]), so the decision
/// does not depend on the sketch's position. Each entry is a loop's sorted curve ids. Loops
/// with a circle, and loops without an orientation at the tolerance scale in the guess or the
/// solution (`|area| ≤ tol × length`, [`Traversal::orientation`]: e.g. a collinear guess,
/// whose computed sign is roundoff), are never reported.
pub(crate) fn flipped_loops(
    regions: &[Region],
    stored: &[LiteralCurve],
    solved: &[LiteralCurve],
) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for lp in regions.iter().flat_map(|r| r.loops()) {
        let orientation =
            |curves: &[LiteralCurve]| traversal(lp, curves).and_then(Traversal::orientation);
        if let (Some(before), Some(after)) = (orientation(stored), orientation(solved))
            && before != after
        {
            out.push(lp.sorted_ids());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_ir::v1::compound::{Compound, expand};

    fn slot_curves(ccw_flip: bool) -> Vec<LiteralCurve> {
        let mut curves = expand(
            "s",
            &Compound::Slot {
                a: [0.0, 0.0],
                b: [7.0, 3.0],
                w: 2.5,
            },
            false,
        )
        .expect("slot");
        if ccw_flip {
            // The same geometry with every arc written clockwise from its end to its start.
            for c in &mut curves {
                if let LiteralCurve::Arc {
                    start, end, ccw, ..
                } = c
                {
                    std::mem::swap(start, end);
                    *ccw = false;
                }
            }
        }
        curves
    }

    #[test]
    fn the_traversal_area_matches_forge_ops_exact_area_with_arcs_either_way() {
        for flip in [false, true] {
            let curves = slot_curves(flip);
            let profile = profile_curves(&curves);
            let regions = regions_of("s", &profile).expect("one region");
            let lp = &regions[0].outer;
            let a = traversal(lp, &curves).expect("no circles").area;
            assert!(
                (a - lp.signed_area).abs() <= 1e-9 * a.abs(),
                "{a} vs {}",
                lp.signed_area
            );
            assert!(a > 0.0, "outer loops run counter-clockwise");
            assert!(flipped_loops(&regions, &curves, &curves).is_empty());
        }
    }

    fn line(id: &str, a: P2, b: P2, off: P2) -> LiteralCurve {
        LiteralCurve::Line {
            id: id.into(),
            start: [a[0] + off[0], a[1] + off[1]],
            end: [b[0] + off[0], b[1] + off[1]],
            construction: false,
        }
    }

    /// A triangle t1 (0,0)→(10,0), t2 (10,0)→`apex`, t3 `apex`→`back`, translated by `off`.
    /// With `back` ≠ (0, 0) the chain is open (closed only by a `coincident` in a sketch).
    fn triangle(apex: P2, back: P2, off: P2) -> Vec<LiteralCurve> {
        vec![
            line("t1", [0.0, 0.0], [10.0, 0.0], off),
            line("t2", [10.0, 0.0], apex, off),
            line("t3", apex, back, off),
        ]
    }

    const OFFSETS: [P2; 8] = [
        [0.0, 0.0],
        [1000.0, 0.0],
        [-1000.0, 0.0],
        [0.0, 1000.0],
        [1000.0, 1000.0],
        [-1000.0, -1000.0],
        [1e6, -1e6],
        [-3.7e4, 2.9e5],
    ];

    #[test]
    fn the_stored_area_of_an_open_chain_does_not_depend_on_the_sketch_position() {
        // Regression (review): the plain shoelace sum of an open chain shifts by
        // ½ T × (end − start) under a translation T, so the flip check's sign depended on
        // where the sketch sits. Closed along the solved loop, the stored guess is the polygon
        // (0,0) (10,0) (0,10) (0,−1): area exactly 50 (the gap chord runs along t3).
        for off in OFFSETS {
            let solved = triangle([0.0, 10.0], [0.0, 0.0], off);
            let stored = triangle([0.0, 10.0], [0.0, -1.0], off);
            let regions = regions_of("s", &profile_curves(&solved)).expect("a triangle");
            let lp = &regions[0].outer;
            let a = traversal(lp, &stored).expect("lines").area;
            assert!((a - 50.0).abs() <= 1e-9, "offset {off:?}: {a}");
            let b = traversal(lp, &solved).expect("lines").area;
            assert!((b - 50.0).abs() <= 1e-9, "offset {off:?}: {b}");
            assert!(
                flipped_loops(&regions, &stored, &solved).is_empty(),
                "{off:?}"
            );
        }
    }

    #[test]
    fn a_mirror_jump_of_a_loop_the_guess_leaves_open_is_flagged_at_every_position() {
        // The review's case: a clockwise stored triangle with a 1 mm gap (closed by a
        // `coincident`), solved with the apex across the base. Unflagged at offset
        // (−1000, 0) before the fix; flagged everywhere now.
        for off in OFFSETS {
            let stored = triangle([5.0, -2.0], [0.0, -1.0], off);
            let solved = triangle([5.0, 5.0], [0.0, 0.0], off);
            let regions = regions_of("s", &profile_curves(&solved)).expect("a triangle");
            assert_eq!(
                flipped_loops(&regions, &stored, &solved),
                [vec!["t1", "t2", "t3"]],
                "offset {off:?}"
            );
        }
    }

    #[test]
    fn gap_chords_close_every_gap_not_only_the_last() {
        // A square whose stored guess has two gaps (two coincident-closed joints): the gaps
        // are chorded, so the area is the one of the octagon through the traversal ends,
        // whatever the translation.
        let sq = |off: P2| {
            vec![
                line("a", [0.0, 0.0], [10.0, 0.0], off),
                line("b", [10.0, 0.0], [10.0, 10.0], off),
                line("c", [10.0, 10.0], [0.0, 10.0], off),
                line("d", [0.0, 10.0], [0.0, 0.0], off),
            ]
        };
        let gappy = |off: P2| {
            vec![
                line("a", [0.0, 0.0], [10.0, 0.0], off),
                line("b", [10.5, 0.5], [10.0, 10.0], off),
                line("c", [10.0, 10.0], [0.0, 10.0], off),
                line("d", [-0.5, 10.5], [0.0, 0.0], off),
            ]
        };
        // Shoelace of (0,0) (10,0) (10.5,0.5) (10,10) (0,10) (−0.5,10.5) back to (0,0).
        let pts: [P2; 6] = [
            [0.0, 0.0],
            [10.0, 0.0],
            [10.5, 0.5],
            [10.0, 10.0],
            [0.0, 10.0],
            [-0.5, 10.5],
        ];
        let want: f64 = 0.5
            * (0..pts.len())
                .map(|i| {
                    let (p, q) = (pts[i], pts[(i + 1) % pts.len()]);
                    p[0] * q[1] - p[1] * q[0]
                })
                .sum::<f64>();
        for off in OFFSETS {
            let regions = regions_of("s", &profile_curves(&sq(off))).expect("a square");
            let a = traversal(&regions[0].outer, &gappy(off))
                .expect("lines")
                .area;
            assert!(
                (a - want).abs() <= 1e-9 * want.abs().max(1.0),
                "{off:?}: {a} vs {want}"
            );
        }
    }

    /// The review's probe: a triangle whose stored guess is collinear (every point on
    /// y = x/3, exact area 0), solved to the triangle (0,0) (0.3,0.1) (0.3t, 0.1t + 2).
    fn collinear_guess(t: f64) -> (Vec<LiteralCurve>, Vec<LiteralCurve>) {
        let o = [0.0, 0.0];
        let (b, apex) = ([0.3, 0.1], [0.3 * t, 0.1 * t]);
        let stored = vec![
            line("t1", [0.0, 0.0], b, o),
            line("t2", b, apex, o),
            line("t3", apex, [0.0, 0.0], o),
        ];
        let lifted = [0.3 * t, 0.1 * t + 2.0];
        let solved = vec![
            line("t1", [0.0, 0.0], b, o),
            line("t2", b, lifted, o),
            line("t3", lifted, [0.0, 0.0], o),
        ];
        (stored, solved)
    }

    #[test]
    fn a_collinear_guess_has_no_orientation_whatever_its_roundoff() {
        // Review: the sign of the computed area of a collinear guess is roundoff, so
        // SKETCH_LOOP_FLIPPED was raised for t = 0.7, 1.3, 2.9, 0.37 and not for 0.1, 5.3,
        // 11.1, 0.9 — geometrically identical situations.
        let mut negative = 0;
        for t in [
            0.7, 1.3, 2.9, 0.37, 0.1, 5.3, 11.1, 0.9, 1.7, 3.3, 7.77, 0.013,
        ] {
            let (stored, solved) = collinear_guess(t);
            let regions = regions_of("s", &profile_curves(&solved)).expect("a triangle");
            let lp = &regions[0].outer;
            let guess = traversal(lp, &stored).expect("lines");
            assert!(
                guess.area.abs() <= 1e-15,
                "t = {t}: exact area 0, roundoff {}",
                guess.area
            );
            negative += usize::from(guess.area < 0.0);
            assert_eq!(guess.orientation(), None, "t = {t}");
            assert_eq!(
                traversal(lp, &solved).expect("lines").orientation(),
                Some(true),
                "t = {t}"
            );
            assert!(
                flipped_loops(&regions, &stored, &solved).is_empty(),
                "t = {t}"
            );
        }
        assert!(
            negative > 0,
            "the roundoff sign flips for some t (the case is exercised)"
        );
    }

    #[test]
    fn a_thin_but_oriented_guess_still_flags_a_mirror_jump() {
        // Base 10 mm, apex 1e-4 mm below it: area 5e-4 mm² against tol × length ≈ 2e-5 mm²,
        // so the guess is clockwise; the solution's apex is above the base.
        for off in OFFSETS {
            let stored = triangle([5.0, -1e-4], [0.0, 0.0], off);
            let solved = triangle([5.0, 5.0], [0.0, 0.0], off);
            let regions = regions_of("s", &profile_curves(&solved)).expect("a triangle");
            assert_eq!(
                traversal(&regions[0].outer, &stored)
                    .expect("lines")
                    .orientation(),
                Some(false),
                "{off:?}"
            );
            assert_eq!(
                flipped_loops(&regions, &stored, &solved),
                [vec!["t1", "t2", "t3"]],
                "{off:?}"
            );
        }
    }

    #[test]
    fn a_mirrored_solution_is_reported_by_its_sorted_curve_ids() {
        let curves = slot_curves(false);
        let regions = regions_of("s", &profile_curves(&curves)).unwrap();
        // The stored guess mirrored across the x axis runs the other way round.
        let mirrored: Vec<LiteralCurve> = curves
            .iter()
            .map(|c| match c.clone() {
                LiteralCurve::Line {
                    id,
                    start,
                    end,
                    construction,
                } => LiteralCurve::Line {
                    id,
                    start: [start[0], -start[1]],
                    end: [end[0], -end[1]],
                    construction,
                },
                LiteralCurve::Arc {
                    id,
                    start,
                    end,
                    center,
                    ccw,
                    construction,
                } => LiteralCurve::Arc {
                    id,
                    start: [start[0], -start[1]],
                    end: [end[0], -end[1]],
                    center: [center[0], -center[1]],
                    // A mirror reverses the sense of rotation.
                    ccw: !ccw,
                    construction,
                },
                other => other,
            })
            .collect();
        let flipped = flipped_loops(&regions, &mirrored, &curves);
        assert_eq!(flipped, [vec!["s.cap_a", "s.cap_b", "s.left", "s.right"]]);
    }
}
