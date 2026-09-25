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
        // Parameters of each input's middle (for dropped pieces, below).
        let mids: Vec<Point2> = inputs
            .iter()
            .map(|inp| inp.pcurve.eval(0.5 * (inp.range.0 + inp.range.1)))
            .collect();
        let chart = Chart::build(&f.surface, f.sense, inputs)
            .map_err(|e| BooleanError::inconsistent(format!("face split: {e}"), f.prov.name()))?;
        for &i in chart.dropped() {
            // A piece attached to the face within the tolerance but lying outside it (along
            // the outside of a narrow face, touching it at an end: the 1.5e-6 mm wide root
            // of a covered fin, SPEC [W0-53]) is no contact of this face.
            if f.chart.contains(mids[i]) == Some(false) {
                continue;
            }
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
    let err = first_err.expect("at least one point");
    if let Some(c) = boundary_fallback(m, imp, fr, &err) {
        if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
            eprintln!(
                "fragment {} #{} classified {c:?} by its boundary pieces",
                m.faces[fr.face].prov.name(),
                fr.group
            );
        }
        return Ok((c, fr.uv));
    }
    if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
        eprintln!(
            "fragment {} #{} unclassified: {err}",
            m.faces[fr.face].prov.name(),
            fr.group
        );
    }
    Err(err)
}

/// The class of a fragment none of whose interior points classified (`err`: the most
/// specific failure), read from its boundary pieces — only when the fragment is **narrow**.
///
/// SPEC [W0-48], [W0-53]: a fragment narrower than twice the tolerance (the hole a 1.5e-6 mm
/// through-pin leaves in a face, the cap of a covered fin, the corner of a target 1.2e-6 mm
/// inside a tool face) has no interior point farther than the tolerance from the other
/// operand's boundary, so every point is "on" it. Its class is then read from its own
/// boundary pieces, which decide it exactly ([`classify_by_boundary`]). The premise is
/// checked, not assumed (review round 5): every interior point tried lies within twice the
/// tolerance of the other operand's boundary (exact distances). A fragment that fails for
/// any other reason — a wide fragment whose every ray direction is degenerate, a point on
/// the boundary of a coincident face far from the other operand's faces — keeps its error:
/// its boundary alone is no evidence for its interior. Near-coincident faces keep their
/// diagnosis.
fn boundary_fallback(m: &Model, imp: &Imprint, fr: &Fragment, err: &BooleanError) -> Option<Class> {
    if !matches!(err, BooleanError::Inconsistent { .. }) || !narrow(m, fr) {
        return None;
    }
    classify_by_boundary(m, imp, fr)
}

/// The premise of [`boundary_fallback`]: every interior point of `fr` (the one it would be
/// classified at and the alternatives) lies within twice the tolerance of the other
/// operand's boundary.
fn narrow(m: &Model, fr: &Fragment) -> bool {
    let f = &m.faces[fr.face];
    let other = 1 - f.operand;
    std::iter::once(fr.uv)
        .chain(fr.alts.iter().copied())
        .all(|uv| {
            let p = f.surface.eval(uv.x, uv.y);
            super::thin::boundary_distance(m, other, p, 4.0 * VTOL) <= 2.0 * VTOL
        })
}

/// Least sine of the angle between a fragment's face and a face of the other operand for a
/// boundary piece to vote on the fragment's side of that face (`classify_by_boundary`).
const BOUNDARY_VOTE_SINE: f64 = 1e-2;

/// The class of fragment `fr` read from its boundary pieces, when every piece that decides
/// agrees (`None` otherwise, or when no piece decides).
///
/// The fragment is a connected region of its face `F` that no piece of the arrangement
/// crosses, so its side of every face of the other operand is one side throughout. It lies
/// on the **left** of its loops (chart convention): at a piece traversed with 3D tangent
/// `t`, the fragment is on the side `d = n_F × t` (`n_F` the outward normal).
/// - **Coincident face `G`** (SSI coincidence): a piece on `G`'s boundary, traversed by `G`
///   with tangent `t_G`, has `G` on the side `n_G × t_G`; the fragment is inside `G` iff the
///   two sides agree — for `n_F = ±n_G`, iff `±(t · t_G) > 0` — and a piece inside `G`
///   (not on its boundary) puts the fragment inside `G`. Inside: `OnSame` / `OnOpp`.
/// - **Transversal face `O`** (the piece lies inside `O`, which crosses `F` at a sine of at
///   least `BOUNDARY_VOTE_SINE`): near the piece the other operand is the half-space behind
///   `O`, so the fragment is `In` iff `d · n_O < 0`.
///
/// Pieces on the boundary of a transversal face (where two faces of the other operand
/// meet) do not vote. Only used when no interior point of the fragment classifies and the
/// fragment is narrow ([`boundary_fallback`]).
pub(crate) fn classify_by_boundary(m: &Model, imp: &Imprint, fr: &Fragment) -> Option<Class> {
    let f = &m.faces[fr.face];
    let other = 1 - f.operand;
    let outward = |fi: usize, uv: Point2| -> Option<Vec3> {
        let face = &m.faces[fi];
        let n = face.surface.normal(uv.x, uv.y)?;
        Some(if face.sense { n } else { -n })
    };
    // Coincident faces of the other operand, with their orientation relation.
    let coincident: Vec<(usize, bool)> = imp
        .coincident
        .iter()
        .filter_map(|&(a, b, same)| {
            if a == fr.face {
                Some((b, same))
            } else if b == fr.face {
                Some((a, same))
            } else {
                None
            }
        })
        .collect();
    let pieces: Vec<(usize, bool)> = fr.loops.iter().flatten().copied().collect();
    // A piece the intersection attached to face `o` without being part of its boundary
    // lies inside it only if its middle does (pieces are attached within the tolerance, so
    // a piece along the outside of a narrow face may be attached to it).
    let inside_face = |pi: usize, o: &super::intersect::OnFace| -> bool {
        let pc = &imp.pieces[pi];
        let tm = 0.5 * (pc.range.0 + pc.range.1);
        m.faces[o.face].chart.contains(o.pcurve.eval(tm)) == Some(true)
    };
    // 1. Inside a coincident face: one vote per piece on its boundary (orientation) or
    //    inside it; conflicting votes leave the face undecided.
    for &(g, same) in &coincident {
        let mut inside = None::<bool>;
        let mut conflict = false;
        for &(pi, fwd) in &pieces {
            let Some(on_g) = imp.pieces[pi].on.iter().find(|o| o.face == g) else {
                continue;
            };
            let vote = match on_g.boundary {
                None if inside_face(pi, on_g) => true,
                None => continue,
                Some(gfwd) => (fwd == gfwd) == same,
            };
            match inside {
                None => inside = Some(vote),
                Some(x) if x != vote => conflict = true,
                Some(_) => {}
            }
        }
        if !conflict && inside == Some(true) {
            return Some(if same { Class::OnSame } else { Class::OnOpp });
        }
    }
    // 2. The side of transversal faces.
    let mut class = None::<Class>;
    for &(pi, fwd) in &pieces {
        let pc = &imp.pieces[pi];
        let Some(on_f) = pc.on.iter().find(|o| o.face == fr.face) else {
            continue;
        };
        let tm = 0.5 * (pc.range.0 + pc.range.1);
        let t = pc.curve.d1(tm);
        let Some(t) = (if fwd { t } else { -t }).normalize() else {
            continue;
        };
        let Some(nf) = outward(fr.face, on_f.pcurve.eval(tm)) else {
            continue;
        };
        let d = nf.cross(t);
        for o in &pc.on {
            if m.faces[o.face].operand != other
                || o.boundary.is_some()
                || coincident.iter().any(|x| x.0 == o.face)
                || !inside_face(pi, o)
            {
                continue;
            }
            let Some(no) = outward(o.face, o.pcurve.eval(tm)) else {
                continue;
            };
            if nf.cross(no).norm() < BOUNDARY_VOTE_SINE {
                continue;
            }
            let vote = if d.dot(no) < 0.0 {
                Class::In
            } else {
                Class::Out
            };
            match class {
                None => class = Some(vote),
                Some(c) if c != vote => return None,
                Some(_) => {}
            }
        }
    }
    class
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boolean::corpus::{Operand, Sweep};
    use crate::boolean::intersect::imprint;
    use forge_core::topo::Body;
    use forge_ir::{Frame, PlaneSpec, SketchCurve, SketchFeature, SweepDirection};

    /// The prism over the square `[-h, h]²` in the XY plane, from `z0` (`symmetric`: `h/2`
    /// each side) over `height`.
    fn square_prism(feature: &str, h: f64, height: f64, symmetric: bool) -> Body {
        let pts = [[-h, -h], [h, -h], [h, h], [-h, h]];
        let curves = (0..4)
            .map(|k| SketchCurve::Line {
                id: format!("e{k}"),
                start: pts[k],
                end: pts[(k + 1) % 4],
            })
            .collect();
        Operand {
            feature: feature.into(),
            sketch: SketchFeature {
                id: format!("s_{feature}"),
                name: format!("s_{feature}"),
                suppressed: false,
                plane: PlaneSpec::Frame(Frame {
                    origin: [0.0, 0.0, 0.0],
                    normal: [0.0, 0.0, 1.0],
                    x_dir: [1.0, 0.0, 0.0],
                }),
                curves,
            },
            sweep: Sweep::Extrude {
                distance: height,
                direction: if symmetric {
                    SweepDirection::Symmetric
                } else {
                    SweepDirection::Normal
                },
            },
        }
        .build()
        .expect("prism")
    }

    /// Review round 5: the fallback to a fragment's boundary pieces is taken only for a
    /// narrow fragment. A box `[-5, 5]² × [0, 10]` and a square pin 1.2e-6 mm wide through
    /// it: the top face splits into the pin's cross-section (narrow: its interior points lie
    /// within 6e-7 mm of the pin's walls, "on" them, so it is classified from its boundary:
    /// `In`) and the rest of the face (wide). The wide fragment's boundary pieces alone would
    /// classify it (`Out`, from the pin's walls), but when its interior points fail — for any
    /// reason, here a simulated `Inconsistent` failure — its error is kept, never a class
    /// read from its boundary.
    #[test]
    fn only_a_narrow_fragment_is_classified_from_its_boundary() {
        let target = square_prism("t", 5.0, 10.0, false);
        let pin = square_prism("k", 0.6e-6, 30.0, true);
        let m = Model::new(&target, &pin).expect("model");
        let imp = imprint(&m, true).expect("imprint");
        let (frags, _, _) = split_faces(&m, &imp).expect("split");
        let top: Vec<&Fragment> = frags
            .iter()
            .filter(|fr| {
                let f = &m.faces[fr.face];
                f.operand == 0 && (f.surface.eval(fr.uv.x, fr.uv.y).z - 10.0).abs() < 1e-9
            })
            .collect();
        assert_eq!(top.len(), 2, "the top face and the pin's cross-section");
        let at = |fr: &Fragment| m.faces[fr.face].surface.eval(fr.uv.x, fr.uv.y);
        let (small, wide) = if at(top[0]).x.abs() < 1e-5 && at(top[0]).y.abs() < 1e-5 {
            (top[0], top[1])
        } else {
            (top[1], top[0])
        };
        let err = BooleanError::inconsistent("simulated: every ray direction is degenerate", "t");
        assert!(narrow(&m, small));
        assert_eq!(boundary_fallback(&m, &imp, small, &err), Some(Class::In));
        // The wide fragment reaches the fallback: its boundary would say `Out`, but it is
        // not narrow, so the failure stands.
        assert_eq!(classify_by_boundary(&m, &imp, wide), Some(Class::Out));
        assert!(!narrow(&m, wide));
        assert_eq!(boundary_fallback(&m, &imp, wide, &err), None);
        // Other failures never fall back (near-coincident faces keep their diagnosis).
        let near = BooleanError::NearCoincident {
            entities: "t × k".into(),
            offset: 0.0,
            limit: VTOL,
            point: [0.0; 3],
            reason: "test".into(),
        };
        assert_eq!(boundary_fallback(&m, &imp, small, &near), None);
    }
}
