//! Splitting faces into fragments and classifying them against the other operand.
//!
//! Each operand face is rebuilt in its chart with every piece lying on it: its own
//! boundary pieces and the section / imprinted pieces inside it. Every resulting
//! fragment is then classified against the other operand:
//! - **on** (same or opposite orientation) when its interior point lies inside a face of
//!   the other operand whose surface coincides with it (SSI coincidence);
//! - otherwise **in** or **out** by ray casting from that interior point: rays in a fixed
//!   list of directions, intersected with every face of the other operand
//!   (`intersect_curve_surface`, certified complete); a direction is used only if no hit
//!   is tangential, lies on a face boundary, or lies in a surface; the parity of the hits
//!   inside faces decides.

use forge_core::geom::{Curve3, Line3};
use forge_core::linalg::{Point2, Point3, Vec3};
use forge_ssi::{SsiTolerance, intersect_curve_surface};

use super::chart::{Chart, Input, Use};
use super::error::BooleanError;
use super::geom::{Aabb, uv_near};
use super::intersect::{Imprint, Loc, VTOL, locate};
use super::model::Model;

/// A fragment of an operand face.
#[derive(Clone, Debug)]
pub(crate) struct Fragment {
    /// The operand face.
    pub face: usize,
    /// Index of the fragment among its face's chart outputs.
    pub group: usize,
    /// Loops of `(piece, forward)`.
    pub loops: Vec<Vec<(usize, bool)>>,
    /// A parameter point inside the fragment (the one its classification used).
    pub uv: Point2,
    /// Further inside points, tried when `uv` turns out degenerate.
    pub alts: Vec<Point2>,
}

/// Fragment classification against the other operand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    In,
    Out,
    /// On a coincident face, outward normals agreeing.
    OnSame,
    /// On a coincident face, outward normals opposite.
    OnOpp,
}

/// Split every operand face along the pieces lying on it.
/// Returns the fragments, the chart of every face, and the `(piece, face)` pairs of section
/// pieces that separate nothing on that face (tangent contacts, dropped from its loops).
#[allow(clippy::type_complexity)]
pub(crate) fn split_faces(
    m: &Model,
    imp: &Imprint,
) -> Result<(Vec<Fragment>, Vec<Chart>, Vec<(usize, usize)>), BooleanError> {
    // Pieces per face.
    let mut on_face: Vec<Vec<(usize, usize)>> = vec![Vec::new(); m.faces.len()];
    for (pi, p) in imp.pieces.iter().enumerate() {
        for (k, of) in p.on.iter().enumerate() {
            on_face[of.face].push((pi, k));
        }
    }
    let mut frags = Vec::new();
    let mut charts = Vec::new();
    let mut contacts = Vec::new();
    for (fi, f) in m.faces.iter().enumerate() {
        let mut inputs = Vec::new();
        let mut piece_of_input = Vec::new();
        for &(pi, k) in &on_face[fi] {
            let p = &imp.pieces[pi];
            let of = &p.on[k];
            inputs.push(Input {
                pcurve: of.pcurve.clone(),
                range: p.range,
                start: p.start,
                end: p.end,
                use_: match of.boundary {
                    Some(fwd) => Use::Boundary(fwd),
                    None => Use::Interior,
                },
            });
            piece_of_input.push(pi);
        }
        if std::env::var_os("FORGE_BOOLEAN_DEBUG_FACE").is_some_and(|x| x == f.prov.name().as_str())
        {
            for (k, inp) in inputs.iter().enumerate() {
                let pc = &imp.pieces[piece_of_input[k]];
                eprintln!(
                    "  input {k} (piece {}): {:?} {} {:?}->{:?} v {:?}->{:?} p {:?}->{:?} uv {:?}->{:?}",
                    piece_of_input[k],
                    inp.use_,
                    pc.curve.kind_name(),
                    pc.range,
                    (),
                    pc.start,
                    pc.end,
                    pc.curve.eval(pc.range.0),
                    pc.curve.eval(pc.range.1),
                    inp.pcurve.eval(pc.range.0),
                    inp.pcurve.eval(pc.range.1)
                );
            }
        }
        let chart = Chart::build(&f.surface, f.sense, inputs)
            .map_err(|e| BooleanError::inconsistent(format!("face split: {e}"), f.prov.name()))?;
        for &i in chart.dropped() {
            if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                let pc = &imp.pieces[piece_of_input[i]];
                eprintln!(
                    "dropped contact piece {} on {}: {} {:?} -> {:?}",
                    piece_of_input[i],
                    f.prov.name(),
                    pc.curve.kind_name(),
                    pc.curve.eval(pc.range.0),
                    pc.curve.eval(pc.range.1)
                );
            }
            contacts.push((piece_of_input[i], fi));
        }
        let outs = chart
            .faces()
            .map_err(|e| BooleanError::inconsistent(format!("face split: {e}"), f.prov.name()))?;
        for (gi, o) in outs.into_iter().enumerate() {
            let uv = o.interior_uv.ok_or_else(|| {
                BooleanError::inconsistent("no interior point for a face fragment", f.prov.name())
            })?;
            frags.push(Fragment {
                face: fi,
                group: gi,
                loops: o
                    .loops
                    .iter()
                    .map(|l| l.iter().map(|&(i, fw)| (piece_of_input[i], fw)).collect())
                    .collect(),
                uv,
                alts: o.more_uv.clone(),
            });
        }
        charts.push(chart);
    }
    Ok((frags, charts, contacts))
}

/// Unit ray directions with "generic" components.
const RAY_DIRS: [[f64; 3]; 7] = [
    [0.573_462_931_5, 0.618_033_988_7, 0.537_700_146_1],
    [-0.439_823_120_1, 0.766_044_443_1, -0.469_470_963_8],
    [0.271_828_182_8, -0.314_159_265_3, 0.909_297_426_8],
    [-0.832_049_307_2, -0.184_899_845_4, 0.522_687_228_6],
    [0.108_239_220_0, 0.994_125_159_8, -0.001_234_567_8],
    [0.947_368_421_1, 0.052_631_578_9, -0.315_789_473_7],
    [-0.267_261_241_9, -0.534_522_483_8, -0.801_783_725_7],
];

/// Where a point is relative to operand `k`'s solid, with the face it lies on when it is
/// `On`.
fn point_in_operand_at(
    m: &Model,
    k: usize,
    p: Point3,
) -> Result<(Loc, Option<usize>), BooleanError> {
    let tol = SsiTolerance::default();
    let bb = m.bbox[k];
    if bb.is_empty() {
        return Ok((Loc::Out, None));
    }
    if !bb.grown(VTOL).overlaps(&Aabb { lo: p, hi: p }) {
        return Ok((Loc::Out, None));
    }
    let len = 2.0 * (bb.diag() + p.distance(bb.lo.lerp(bb.hi, 0.5))) + 1.0;
    'dirs: for d in RAY_DIRS {
        let dir = Vec3::from(d).normalize().expect("unit");
        let line: Curve3 = Line3::new(p, dir)
            .map_err(|_| BooleanError::inconsistent("ray", "classification"))?
            .into();
        let seg = Aabb {
            lo: p.min_components(p + dir * len),
            hi: p.max_components(p + dir * len),
        };
        let mut count = 0usize;
        for gi in m.faces_of(k) {
            let g = &m.faces[gi];
            if !g.bbox.overlaps(&seg) {
                continue;
            }
            let hits = intersect_curve_surface(&line, (0.0, len), &g.surface, g.uvbox, &tol)
                .map_err(|e| BooleanError::ssi(&e, format!("ray × face {}", g.prov.name())))?;
            if !hits.overlaps.is_empty() {
                continue 'dirs;
            }
            for h in &hits.points {
                if h.point.distance(p) <= VTOL {
                    // The point lies on this face's surface: on the solid's boundary if it
                    // is inside (or on the boundary of) the face.
                    if locate(m, gi, h.point, h.uv) != Loc::Out {
                        return Ok((Loc::On, Some(gi)));
                    }
                    continue;
                }
                if h.contact.is_tangent() {
                    continue 'dirs;
                }
                match locate(m, gi, h.point, h.uv) {
                    Loc::On => continue 'dirs,
                    Loc::In => count += 1,
                    Loc::Out => {}
                }
            }
        }
        return Ok((if count % 2 == 1 { Loc::In } else { Loc::Out }, None));
    }
    Err(BooleanError::inconsistent(
        "every ray direction is degenerate",
        format!("({}, {}, {})", p.x, p.y, p.z),
    ))
}

/// Classify a fragment against the other operand: at its interior point, or, when that
/// point is degenerate (on the other operand's boundary, e.g. on a tangent contact line the
/// fragment does not contain), at the next of its other interior points. Returns the class
/// and the point used.
pub(crate) fn classify(
    m: &Model,
    imp: &Imprint,
    fr: &Fragment,
) -> Result<(Class, Point2), BooleanError> {
    let mut first_err: Option<BooleanError> = None;
    for uv in std::iter::once(fr.uv).chain(fr.alts.iter().copied()) {
        match classify_at(m, imp, fr, uv) {
            Ok(c) => return Ok((c, uv)),
            Err(e) => {
                // The most specific diagnosis wins: near-coincident faces.
                let better = matches!(e, BooleanError::NearCoincident { .. })
                    && !matches!(first_err, Some(BooleanError::NearCoincident { .. }));
                if first_err.is_none() || better {
                    first_err = Some(e);
                }
            }
        }
    }
    Err(first_err.expect("at least one point"))
}

fn classify_at(
    m: &Model,
    imp: &Imprint,
    fr: &Fragment,
    uv0: Point2,
) -> Result<Class, BooleanError> {
    let f = &m.faces[fr.face];
    let other = 1 - f.operand;
    let p = f.surface.eval(uv0.x, uv0.y);
    // Coincident faces of the other operand containing the point.
    for &(a, b, same) in &imp.coincident {
        let g = if a == fr.face {
            b
        } else if b == fr.face {
            a
        } else {
            continue;
        };
        let gs = &m.faces[g].surface;
        let uv = uv_near(gs, p, None);
        match locate(m, g, p, uv) {
            Loc::In => return Ok(if same { Class::OnSame } else { Class::OnOpp }),
            Loc::On => {
                if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                    eprintln!(
                        "coincident on-boundary: face {} vs {} uv {:?} p {:?} loops {:?}",
                        f.prov.name(),
                        m.faces[g].prov.name(),
                        uv0,
                        p,
                        fr.loops
                    );
                    for (pi, pc) in imp.pieces.iter().enumerate() {
                        if fr.loops.iter().flatten().any(|x| x.0 == pi) {
                            eprintln!(
                                "  piece {pi}: {} {:?} {:?}->{:?} src {:?} p0 {:?} p1 {:?}",
                                pc.curve.kind_name(),
                                pc.range,
                                pc.start,
                                pc.end,
                                pc.src,
                                pc.curve.eval(pc.range.0),
                                pc.curve.eval(pc.range.1)
                            );
                        }
                    }
                }
                return Err(BooleanError::inconsistent(
                    "fragment interior point on the boundary of a coincident face",
                    f.prov.name(),
                ));
            }
            Loc::Out => {}
        }
    }
    match point_in_operand_at(m, other, p)? {
        (Loc::In, _) => Ok(Class::In),
        (Loc::Out, _) => Ok(Class::Out),
        (Loc::On, g) => {
            if let Some(e) = g.and_then(|g| near_coincident(m, fr.face, uv0, g, p)) {
                return Err(e);
            }
            if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                eprintln!(
                    "on-boundary interior point: face {} uv {:?} p {:?} loops {:?}",
                    f.prov.name(),
                    uv0,
                    p,
                    fr.loops
                );
                for (pi, pc) in imp.pieces.iter().enumerate() {
                    if fr.loops.iter().flatten().any(|x| x.0 == pi) {
                        eprintln!(
                            "  piece {pi}: {} {:?} {:?}->{:?} src {:?} d {}",
                            pc.curve.kind_name(),
                            pc.range,
                            pc.start,
                            pc.end,
                            pc.src,
                            super::geom::param_on(&pc.curve, pc.range, p).1
                        );
                    }
                }
            }
            Err(BooleanError::inconsistent(
                "fragment interior point on the other operand's boundary without a coincidence",
                f.prov.name(),
            ))
        }
    }
}

/// A fragment's interior point `p` (parameters `uv` on face `f`) lies on face `g` of the
/// other operand without an SSI coincidence: if the two surfaces are nearly parallel there,
/// the faces are near-coincident (or cross at a tiny angle) where the boolean cannot tell
/// the sides apart; it reports that instead of guessing a side, with the largest separation
/// of the two faces over their overlap (`near::separation`) and their angle.
fn near_coincident(m: &Model, f: usize, uv: Point2, g: usize, p: Point3) -> Option<BooleanError> {
    let (fs, gs) = (&m.faces[f].surface, &m.faces[g].surface);
    let nf = fs.normal(uv.x, uv.y)?;
    let (u, v, _) = gs.project(p);
    let ng = gs.normal(u, v)?;
    if nf.cross(ng).norm() > 1e-3 {
        return None;
    }
    let (a, b) = if m.faces[f].operand == 0 {
        (f, g)
    } else {
        (g, f)
    };
    let (sep, angle, at) = super::near::separation(m, a, b).unwrap_or((0.0, 0.0, p));
    Some(BooleanError::NearCoincident {
        entities: format!("{} × {}", m.faces[f].prov.name(), m.faces[g].prov.name()),
        offset: sep,
        limit: super::near::DISTINCT_OFFSET,
        point: at.to_array(),
        reason: if angle > 1e-9 {
            format!(
                "a fragment's interior point lies on the other face, which crosses it at {:.3e} rad",
                forge_core::math::asin(angle.min(1.0))
            )
        } else {
            "a fragment's interior point lies on the other, parallel face".into()
        },
    })
}
