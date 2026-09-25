//! Checks on a rewritten plan before it is built, and on the built body.
//!
//! - [`face_crossings_ex`]: a face's boundary, lifted into its `(u, v)` domain through the
//!   pcurves, must not cross, touch or come within the face's tolerance of itself away from
//!   the vertices its pieces share (with the periodic copies of periodic faces). This is what
//!   catches a contact curve running past another edge of its face, two blends' contacts
//!   crossing, or a trimmed face turning inside out. The test is **certified**
//!   ([`crate::cert2d`]): exact rational Bézier forms of the pcurves, convex-hull bounds and
//!   subdivision; what it cannot resolve is returned apart — undecided, not a crossing.
//! - [`face_inside`]: point in face with a clearance certificate (in, out, on the boundary,
//!   or not certified).
//! - `validate_body`: `forge_check::validate` (forge-core's structural and geometric
//!   checks, closed shells, domain reconstruction, positive face areas, shell orientation)
//!   and a positive volume.

use forge_core::linalg::Point2;
use forge_core::topo::{Body, Severity};

use crate::cert2d::Boundary;
use crate::plan::Plan;

/// Pairs of plan edges of face `f` whose images in the face's domain meet (cross, touch or
/// come within the face's tolerance) away from the vertices they share: the pairs found to
/// meet, and the pairs the certificate left unresolved (see [`Boundary::crossings_ex`]; an
/// edge whose pcurve cannot be converted is paired with itself, and a face with a use without
/// a pcurve is unresolved). Only the first are proven (W6 review round 5): callers report the
/// others as undecided, never as a size limit.
pub(crate) fn face_crossings_ex(
    plan: &Plan,
    f: usize,
) -> (crate::cert2d::EdgePairs, crate::cert2d::EdgePairs) {
    let Some(face) = plan.fs[f].as_ref() else {
        return (Vec::new(), Vec::new());
    };
    match Boundary::of_face(plan, f) {
        Some(b) => b.crossings_ex(),
        None => (
            Vec::new(),
            face.loops
                .iter()
                .flatten()
                .take(1)
                .map(|u| (u.edge, u.edge))
                .collect(),
        ),
    }
}

/// Point-in-face test in `(u, v)` for face `f` of `plan`: `Some(inside)`, or `None` when a
/// use has no pcurve, the point is within the face's tolerance of the boundary, or the answer
/// cannot be certified (see [`Boundary::contains`]). Loops run with the face on their left
/// seen from outside, i.e. on the left of the path in `(u, v)` when `sense` (`S_u × S_v`
/// outward) and on its right otherwise.
#[cfg(test)]
pub(crate) fn face_contains_uv(plan: &Plan, f: usize, q: Point2) -> Option<bool> {
    Boundary::of_face(plan, f)?.contains(q)
}

/// [`face_contains_uv`] with its `None` split ([`Boundary::contains_ex`]): within the face's
/// tolerance of the boundary, or not certified (also when a use has no pcurve).
pub(crate) fn face_inside(plan: &Plan, f: usize, q: Point2) -> crate::cert2d::Inside {
    Boundary::of_face(plan, f).map_or(crate::cert2d::Inside::Unknown, |b| b.contains_ex(q))
}

/// `forge_check::validate` without errors, and a positive volume.
pub(crate) fn validate_body(body: &Body) -> Result<f64, String> {
    let issues = forge_check::validate(body);
    if let Some(i) = issues.iter().find(|i| i.severity == Severity::Error) {
        return Err(i.to_string());
    }
    let m = forge_check::mass_properties(body).map_err(|e| e.to_string())?;
    if !(m.volume.is_finite() && m.volume > 0.0) {
        return Err(format!("non-positive volume {}", m.volume));
    }
    Ok(m.volume)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::Surface;
    use forge_core::linalg::Point3;
    use forge_ir::v1::metrics::Origin;
    use forge_ir::{Frame, PlaneSpec, SketchCurve, SketchFeature, SweepDirection};
    use forge_ops::boolean::corpus::{Operand, Sweep};
    use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};

    fn prism(feature: &str, z0: f64, curves: Vec<SketchCurve>, h: f64) -> Body {
        Operand {
            feature: feature.into(),
            sketch: SketchFeature {
                id: format!("s_{feature}"),
                name: format!("s_{feature}"),
                suppressed: false,
                plane: PlaneSpec::Frame(Frame {
                    origin: [0.0, 0.0, z0],
                    normal: [0.0, 0.0, 1.0],
                    x_dir: [1.0, 0.0, 0.0],
                }),
                curves,
            },
            sweep: Sweep::Extrude {
                distance: h,
                direction: SweepDirection::Normal,
            },
        }
        .build()
        .expect("prism")
    }

    fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
        SketchCurve::Line {
            id: id.into(),
            start: a,
            end: b,
        }
    }

    fn plate_with_hole() -> Body {
        let plate = prism(
            "e1",
            0.0,
            vec![
                line("b", [0.0, 0.0], [40.0, 0.0]),
                line("r", [40.0, 0.0], [40.0, 30.0]),
                line("t", [40.0, 30.0], [0.0, 30.0]),
                line("l", [0.0, 30.0], [0.0, 0.0]),
            ],
            6.0,
        );
        let hole = prism(
            "e2",
            -1.0,
            vec![SketchCurve::Circle {
                id: "c".into(),
                center: [20.0, 15.0],
                radius: 5.0,
            }],
            8.0,
        );
        let ob = |body, f: &str, t| OpBody {
            body,
            origin: Origin {
                feature: f.into(),
                member: "m".into(),
                instance: None,
            },
            timeline: t,
        };
        let r = apply_body_op(BodyOp::Cut, &[ob(plate, "a", 0)], &[ob(hole, "b", 1)], "c1")
            .expect("cut");
        r.bodies.into_iter().next().expect("body").body
    }

    fn classify(plan: &Plan, f: usize, p: Point3) -> Option<bool> {
        let (u, v, _) = plan.fs[f].as_ref().expect("face").surf.project(p);
        face_contains_uv(plan, f, Point2::new(u, v))
    }

    #[test]
    fn points_are_classified_in_the_trimmed_domain() {
        let plan = Plan::from_body(&plate_with_hole()).expect("plan");
        let top = (0..plan.fs.len())
            .find(|&f| {
                matches!(&plan.fs[f].as_ref().expect("face").surf,
                    Surface::Plane(p) if (p.frame().origin().z - 6.0).abs() < 1e-12
                        && p.frame().z().z.abs() > 0.5)
            })
            .expect("top face");
        assert_eq!(classify(&plan, top, Point3::new(5.0, 5.0, 6.0)), Some(true));
        assert_eq!(
            classify(&plan, top, Point3::new(20.0, 15.0, 6.0)),
            Some(false)
        );
        assert_eq!(
            classify(&plan, top, Point3::new(24.9, 15.0, 6.0)),
            Some(false)
        );
        assert_eq!(
            classify(&plan, top, Point3::new(25.1, 15.0, 6.0)),
            Some(true)
        );
        assert_eq!(
            classify(&plan, top, Point3::new(50.0, 5.0, 6.0)),
            Some(false)
        );
        let wall = (0..plan.fs.len())
            .find(|&f| {
                matches!(
                    plan.fs[f].as_ref().expect("face").surf,
                    Surface::Cylinder(_)
                )
            })
            .expect("hole wall");
        for a in [0.0f64, 1.0, 2.5, 4.0, 6.0] {
            let (s, c) = (a.sin(), a.cos());
            let at = |z: f64| Point3::new(20.0 + 5.0 * c, 15.0 + 5.0 * s, z);
            assert_eq!(classify(&plan, wall, at(3.0)), Some(true), "angle {a}");
            assert_eq!(classify(&plan, wall, at(7.0)), Some(false), "angle {a}");
            assert_eq!(classify(&plan, wall, at(-1.0)), Some(false), "angle {a}");
        }
    }
}
