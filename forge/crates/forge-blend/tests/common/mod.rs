//! Test bodies built with forge-ops (sketch + extrude, booleans), and entity pickers.
#![allow(dead_code)]

pub mod corpus;
pub mod polytope;

use forge_core::linalg::Point3;
use forge_core::topo::{Body, EdgeId, FaceId};
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchCurve, SketchFeature, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};

pub fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

pub fn arc(id: &str, start: [f64; 2], end: [f64; 2], center: [f64; 2], ccw: bool) -> SketchCurve {
    SketchCurve::Arc {
        id: id.into(),
        start,
        end,
        center,
        ccw,
    }
}

pub fn circle(id: &str, c: [f64; 2], r: f64) -> SketchCurve {
    SketchCurve::Circle {
        id: id.into(),
        center: c,
        radius: r,
    }
}

/// Closed polygon of lines `p0`, `p1`, ….
pub fn polygon(pts: &[[f64; 2]]) -> Vec<SketchCurve> {
    let n = pts.len();
    (0..n)
        .map(|i| line(&format!("p{i}"), pts[i], pts[(i + 1) % n]))
        .collect()
}

pub fn rect(x0: f64, y0: f64, w: f64, h: f64) -> Vec<SketchCurve> {
    vec![
        line("b", [x0, y0], [x0 + w, y0]),
        line("r", [x0 + w, y0], [x0 + w, y0 + h]),
        line("t", [x0 + w, y0 + h], [x0, y0 + h]),
        line("l", [x0, y0 + h], [x0, y0]),
    ]
}

/// A slot along x centred at `c`: straight length `len`, radius `r`.
pub fn slot(c: [f64; 2], len: f64, r: f64) -> Vec<SketchCurve> {
    let (x0, x1) = (c[0] - 0.5 * len, c[0] + 0.5 * len);
    let (y0, y1) = (c[1] - r, c[1] + r);
    vec![
        line("b", [x0, y0], [x1, y0]),
        arc("e", [x1, y0], [x1, y1], [x1, c[1]], true),
        line("t", [x1, y1], [x0, y1]),
        arc("w", [x0, y1], [x0, y0], [x0, c[1]], true),
    ]
}

/// XY plane at height `z`.
pub fn xy(z: f64) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin: [0.0, 0.0, z],
        normal: [0.0, 0.0, 1.0],
        x_dir: [1.0, 0.0, 0.0],
    })
}

pub fn prism_op(feature: &str, plane: PlaneSpec, curves: Vec<SketchCurve>, h: f64) -> Operand {
    Operand {
        feature: feature.into(),
        sketch: SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane,
            curves,
        },
        sweep: Sweep::Extrude {
            distance: h,
            direction: SweepDirection::Normal,
        },
    }
}

pub fn prism(feature: &str, z0: f64, curves: Vec<SketchCurve>, h: f64) -> Body {
    prism_op(feature, xy(z0), curves, h).build().expect("prism")
}

pub fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Body {
    prism(
        feature,
        lo[2],
        rect(lo[0], lo[1], size[0], size[1]),
        size[2],
    )
}

pub fn zcyl(feature: &str, c: [f64; 2], z0: f64, r: f64, h: f64) -> Body {
    prism(feature, z0, vec![circle("c", c, r)], h)
}

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

pub fn boolean(target: Body, tool: Body, op: BodyOp, feature: &str) -> Body {
    let r =
        apply_body_op(op, &[ob(target, "a", 0)], &[ob(tool, "b", 1)], feature).expect("boolean");
    assert_eq!(r.bodies.len(), 1, "one result body");
    r.bodies.into_iter().next().expect("body").body
}

pub fn cut(target: Body, tool: Body, feature: &str) -> Body {
    boolean(target, tool, BodyOp::Cut, feature)
}

pub fn join(target: Body, tool: Body, feature: &str) -> Body {
    boolean(target, tool, BodyOp::Join, feature)
}

/// The edge whose parametric middle is nearest `p`.
pub fn edge_near(b: &Body, p: [f64; 3]) -> EdgeId {
    let p = Point3::new(p[0], p[1], p[2]);
    b.edges()
        .iter()
        .min_by(|x, y| {
            let m = |e: &forge_core::topo::Edge| e.curve.eval(0.5 * (e.t_range.0 + e.t_range.1));
            m(x.1).distance(p).total_cmp(&m(y.1).distance(p))
        })
        .map(|(id, _)| id)
        .expect("edges")
}

/// The circular edge nearest `p` (by the distance from `p` to the circle).
pub fn circle_near(b: &Body, p: [f64; 3]) -> EdgeId {
    let p = Point3::new(p[0], p[1], p[2]);
    b.edges()
        .iter()
        .filter(|(_, e)| matches!(e.curve, forge_core::geom::Curve3::Circle(_)))
        .min_by(|x, y| x.1.curve.project(p).1.total_cmp(&y.1.curve.project(p).1))
        .map(|(id, _)| id)
        .expect("a circular edge")
}

/// The face whose surface is nearest `p` and that contains a point near it (by probing the
/// face's edges' midpoints; faces are planar in the tests that use this).
pub fn face_near(b: &Body, p: [f64; 3]) -> FaceId {
    let q = Point3::new(p[0], p[1], p[2]);
    b.faces()
        .iter()
        .min_by(|x, y| {
            let d = |f: &forge_core::topo::Face| {
                let (_, _, dist) = f.surface.project(q);
                let e = b
                    .face_edges(
                        b.faces()
                            .iter()
                            .find(|(_, g)| std::ptr::eq(*g, f))
                            .map(|(id, _)| id)
                            .expect("face"),
                    )
                    .iter()
                    .map(|&e| {
                        let e = b.edge(e).expect("edge");
                        e.curve.eval(0.5 * (e.t_range.0 + e.t_range.1)).distance(q)
                    })
                    .fold(f64::INFINITY, f64::min);
                dist * 1e6 + e
            };
            d(x.1).total_cmp(&d(y.1))
        })
        .map(|(id, _)| id)
        .expect("faces")
}

/// Picks for edges of `b` (body index 0, keys derived from provenance).
pub fn es(b: &Body, ids: &[EdgeId]) -> Vec<forge_blend::Pick<EdgeId>> {
    let v = forge_blend::pick_edges(b, 0, ids);
    assert_eq!(v.len(), ids.len(), "edges of the body");
    v
}

/// Picks for faces of `b` (body index 0).
pub fn fs(b: &Body, ids: &[FaceId]) -> Vec<forge_blend::Pick<FaceId>> {
    let v = forge_blend::pick_faces(b, 0, ids);
    assert_eq!(v.len(), ids.len(), "faces of the body");
    v
}

/// The pick of one face of `b`.
pub fn f1(b: &Body, id: FaceId) -> forge_blend::Pick<FaceId> {
    fs(b, &[id]).remove(0)
}

pub fn volume(b: &Body) -> f64 {
    forge_check::mass_properties(b).expect("mass").volume
}

pub fn area(b: &Body) -> f64 {
    forge_check::mass_properties(b).expect("mass").area
}

pub fn assert_valid(b: &Body) {
    let issues = forge_check::validate(b);
    let errs: Vec<_> = issues
        .iter()
        .filter(|i| i.severity == forge_core::topo::Severity::Error)
        .collect();
    assert!(errs.is_empty(), "invalid body: {errs:?}");
}

pub fn face_types(b: &Body) -> std::collections::BTreeMap<String, u32> {
    forge_check::body_metrics(b).expect("metrics").face_types
}

pub fn edge_types(b: &Body) -> std::collections::BTreeMap<String, u32> {
    forge_check::body_metrics(b).expect("metrics").edge_types
}

pub fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / b.abs().max(1e-300)
}

/// A blend's obstacle failure (W6 review round 6: another feature of the body in the blend's
/// way is `*_FAILED`, a capability gap, never a size limit): asserts the code, the edges and
/// the reason, and returns the value the reason says builds clear of the obstacle.
pub fn obstacle_hint(err: &forge_blend::BlendError) -> f64 {
    assert!(err.code().ends_with("_FAILED"), "{} {err}", err.code());
    let forge_blend::BlendError::Failed { reason, edges, .. } = err else {
        panic!("{} {err}", err.code());
    };
    assert!(!edges.is_empty(), "{err}");
    assert!(
        reason.contains("another feature") && reason.contains("not a size limit"),
        "{reason}"
    );
    let end = reason
        .find(" mm builds clear of it")
        .unwrap_or_else(|| panic!("no hint: {reason}"));
    let start = reason[..end].rfind(' ').expect("number") + 1;
    reason[start..end]
        .parse()
        .unwrap_or_else(|_| panic!("hint in {reason}"))
}
