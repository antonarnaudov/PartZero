//! Candidate query synthesis (SPEC-v1 §5.8): a query that selects **exactly** one entity, so
//! a repair is one op (`acceptRefCandidate`, §5.9).
//!
//! Tried in the order of §5.8, and every attempt is verified by evaluating it:
//! 1. a named source read off the entity's key (`side`, `cap`/`endcap` with or without
//!    `member`, `hole_face`, `body`);
//! 2. for an edge, `between` of the named sources of its two faces;
//! 3. for a junction edge, `edge_at` from its `@c.end` qualifier;
//! 4. a base query narrowed by `extreme` along the signed world axis that separates the
//!    entity best (then two nested axes): the original query when its result contains the
//!    entity, else a broad base around it (`created` of its feature, the edges of an adjacent
//!    face, the vertices of an incident edge, `bodies`), else the entity's own named source
//!    (split pieces share it);
//! 5. beyond the §5.8 list (an interior member no axis isolates, e.g. the middle piece of a
//!    three-way split): the base with the members above it along one axis peeled off,
//!    `extreme(minus { a: q, b: extreme(q, d, max) }, d, max)`, at most `MAX_PEELS` levels.
//!
//! Returns `None` when nothing selects exactly the entity (the SPEC's SHOULD).

use forge_core::linalg::Vec3;
use forge_core::topo::{KeyRoleArg, parse_key};
use forge_ir::v1::{Dir, DirName, End, EntityKind, HolePart, LINEAR_TOLERANCE, Query, Which};

use crate::query::{edges_of, eval_query, faces_of};
use crate::scope::{Entity, Scope};

/// A query that selects exactly `e` in `scope` (see the module docs). `base` is the query
/// the entity is a candidate for, if any.
pub fn synthesize_query(e: Entity, scope: &Scope<'_>, base: Option<&Query>) -> Option<Query> {
    let selects = |q: &Query| {
        eval_query(q, scope).is_ok_and(|s| s.members.len() == 1 && s.members[0].entity == e)
    };
    for q in named_sources(e, scope) {
        if selects(&q) {
            return Some(q);
        }
    }
    if e.kind() == EntityKind::Edge {
        let faces = faces_of(scope, e);
        if let [fa, fb] = faces.as_slice() {
            for qa in named_sources(*fa, scope) {
                for qb in named_sources(*fb, scope) {
                    let q = Query::Between {
                        a: Box::new(qa.clone()),
                        b: Box::new(qb),
                    };
                    if selects(&q) {
                        return Some(q);
                    }
                }
            }
        }
        if let Some(q) = edge_at(e, scope)
            && selects(&q)
        {
            return Some(q);
        }
    }
    let mut bases: Vec<Query> = Vec::new();
    if let Some(b) = base {
        bases.push(b.clone());
    }
    bases.extend(broad_bases(e, scope));
    // Last, the entity's own named sources that designate several entities (the pieces of a
    // split sharing the key), narrowed: other members of the original query or of the broad
    // bases can sit level with a middle piece on every axis.
    bases.extend(named_sources(e, scope));
    for b in bases {
        if let Some(q) = narrow(e, scope, &b) {
            return Some(q);
        }
    }
    None
}

/// Named sources that may designate `e`, most specific last.
fn named_sources(e: Entity, scope: &Scope<'_>) -> Vec<Query> {
    let mut out = Vec::new();
    let table = scope.table();
    if e.kind() == EntityKind::Body {
        let o = scope.origin(e.body);
        out.push(Query::Body {
            feature: o.feature.clone(),
            member: None,
        });
        out.push(Query::Body {
            feature: o.feature.clone(),
            member: Some(o.member.clone()),
        });
        return out;
    }
    if e.kind() != EntityKind::Face {
        return out;
    }
    let Ok(p) = parse_key(scope.key(e)) else {
        return out;
    };
    let ty = table.get(&p.feature).map(|f| f.ty.as_str());
    let end = |l: &str| match l {
        "start" => Some(End::Start),
        "end" => Some(End::End),
        _ => None,
    };
    match (p.label.as_str(), &p.arg, ty) {
        ("side", KeyRoleArg::Leaf(c), Some("extrude" | "revolve")) if p.qualifier.is_none() => {
            out.push(Query::Side {
                feature: p.feature.clone(),
                curve: c.clone(),
            });
        }
        ("cap", KeyRoleArg::Leaf(l), Some("extrude"))
        | ("endcap", KeyRoleArg::Leaf(l), Some("revolve")) => {
            if let Some(end) = end(l) {
                let mk = |member: Option<String>| {
                    if p.label == "cap" {
                        Query::Cap {
                            feature: p.feature.clone(),
                            end,
                            member,
                        }
                    } else {
                        Query::Endcap {
                            feature: p.feature.clone(),
                            end,
                            member,
                        }
                    }
                };
                out.push(mk(None));
                if let Some(m) = &p.qualifier {
                    out.push(mk(Some(m.clone())));
                }
            }
        }
        (part, KeyRoleArg::None, Some("hole")) => {
            let hp = match part {
                "wall" => Some(HolePart::Wall),
                "tip" => Some(HolePart::Tip),
                "floor" => Some(HolePart::Floor),
                "cbore_wall" => Some(HolePart::CboreWall),
                "cbore_floor" => Some(HolePart::CboreFloor),
                "csink" => Some(HolePart::Csink),
                _ => None,
            };
            if let (Some(part), Some(at)) = (hp, &p.qualifier) {
                out.push(Query::HoleFace {
                    feature: p.feature.clone(),
                    at: at.clone(),
                    part,
                });
            }
        }
        _ => {}
    }
    out
}

/// `edge_at` from a junction edge's `@c.end` qualifier.
fn edge_at(e: Entity, scope: &Scope<'_>) -> Option<Query> {
    let p = parse_key(scope.key(e)).ok()?;
    let q = p.qualifier?;
    let (curve, end) = q.rsplit_once('.')?;
    let end = match end {
        "start" => End::Start,
        "end" => End::End,
        _ => return None,
    };
    Some(Query::EdgeAt {
        feature: p.feature,
        curve: curve.to_string(),
        end,
    })
}

/// Broad queries whose result contains `e`, to narrow with `extreme`.
fn broad_bases(e: Entity, scope: &Scope<'_>) -> Vec<Query> {
    let mut out = Vec::new();
    let creator = |f: &str| {
        scope.table().get(f).is_some_and(|x| {
            matches!(
                x.ty.as_str(),
                "extrude"
                    | "revolve"
                    | "boolean"
                    | "hole"
                    | "fillet"
                    | "chamfer"
                    | "shell"
                    | "draft"
                    | "pattern"
            )
        })
    };
    match e.kind() {
        EntityKind::Face => {
            if let Ok(p) = parse_key(scope.key(e))
                && creator(&p.feature)
            {
                out.push(Query::Created {
                    feature: p.feature,
                    role: None,
                });
            }
        }
        EntityKind::Edge => {
            for f in faces_of(scope, e) {
                for q in named_sources(f, scope) {
                    out.push(Query::Edges { of: Box::new(q) });
                }
            }
        }
        EntityKind::Vertex => {
            for x in edges_of(scope, e) {
                if let Some(q) = synthesize_query(x, scope, None) {
                    out.push(Query::Vertices { of: Box::new(q) });
                    break;
                }
            }
        }
        EntityKind::Body => out.push(Query::Bodies {}),
    }
    out
}

const DIRS: [DirName; 6] = [
    DirName::PosX,
    DirName::NegX,
    DirName::PosY,
    DirName::NegY,
    DirName::PosZ,
    DirName::NegZ,
];

fn dir_vec(d: DirName) -> Vec3 {
    match d {
        DirName::PosX | DirName::X => Vec3::unit_x(),
        DirName::NegX => -Vec3::unit_x(),
        DirName::PosY | DirName::Y => Vec3::unit_y(),
        DirName::NegY => -Vec3::unit_y(),
        DirName::PosZ | DirName::Z => Vec3::unit_z(),
        DirName::NegZ => -Vec3::unit_z(),
    }
}

/// `extreme` narrowing of `base` to exactly `e`: one axis with the best margin, else two.
fn narrow(e: Entity, scope: &Scope<'_>, base: &Query) -> Option<Query> {
    let set = eval_query(base, scope).ok()?;
    let members = set.entities();
    if !members.contains(&e) {
        return None;
    }
    let tol = LINEAR_TOLERANCE * scope.scale();
    let centroid = |x: Entity| scope.props(x).ok().map(|p| Vec3::from(p.centroid));
    let ce = centroid(e)?;
    // Margin of `e` over the rest of `among` along `d` (positive: `e` is the unique max).
    let margin = |among: &[Entity], d: Vec3| -> f64 {
        let me = ce.dot(d);
        among
            .iter()
            .filter(|x| **x != e)
            .filter_map(|x| centroid(*x))
            .map(|c| me - c.dot(d))
            .fold(f64::INFINITY, f64::min)
    };
    let wrap = |of: Query, d: DirName| Query::Extreme {
        of: Box::new(of),
        dir: Dir::Name(d),
        which: Which::Max,
    };
    let verify = |q: &Query| {
        eval_query(q, scope).is_ok_and(|s| s.members.len() == 1 && s.members[0].entity == e)
    };
    if members.len() == 1 {
        return verify(base).then(|| base.clone());
    }
    // One axis.
    let mut best: Option<(f64, DirName)> = None;
    for d in DIRS {
        let m = margin(&members, dir_vec(d));
        if m > tol && best.is_none_or(|(bm, _)| m > bm) {
            best = Some((m, d));
        }
    }
    if let Some((_, d)) = best {
        let q = wrap(base.clone(), d);
        if verify(&q) {
            return Some(q);
        }
    }
    // Two nested axes: keep the maxima along d1, then separate along d2.
    let mut best2: Option<(f64, DirName, DirName)> = None;
    for d1 in DIRS {
        let v1 = dir_vec(d1);
        let top = members
            .iter()
            .filter_map(|x| centroid(*x).map(|c| (*x, c.dot(v1))))
            .map(|(_, v)| v)
            .fold(f64::NEG_INFINITY, f64::max);
        if (ce.dot(v1) - top).abs() > tol {
            continue;
        }
        let kept: Vec<Entity> = members
            .iter()
            .copied()
            .filter(|x| centroid(*x).is_some_and(|c| (c.dot(v1) - top).abs() <= tol))
            .collect();
        for d2 in DIRS {
            let m = margin(&kept, dir_vec(d2));
            if m > tol && best2.is_none_or(|(bm, _, _)| m > bm) {
                best2 = Some((m, d1, d2));
            }
        }
    }
    if let Some((_, d1, d2)) = best2 {
        let q = wrap(wrap(base.clone(), d1), d2);
        if verify(&q) {
            return Some(q);
        }
    }
    // Peeling (an interior member, e.g. the middle piece of a three-way split): along the
    // axis with the fewest members above `e` (and none level with it), remove the current
    // maxima one level at a time, `minus { a: q, b: extreme(q, d, max) }`, until `e` is the
    // maximum.
    let mut peel: Option<(usize, DirName)> = None;
    for d in DIRS {
        let v = dir_vec(d);
        let me = ce.dot(v);
        let others: Vec<f64> = members
            .iter()
            .filter(|x| **x != e)
            .filter_map(|x| centroid(*x).map(|c| c.dot(v)))
            .collect();
        if others.len() + 1 != members.len() || others.iter().any(|o| (o - me).abs() <= tol) {
            continue;
        }
        let above = others.iter().filter(|o| **o > me).count();
        if above > 0 && peel.is_none_or(|(n, _)| above < n) {
            peel = Some((above, d));
        }
    }
    let (above, d) = peel?;
    let mut q = base.clone();
    for _ in 0..above.min(MAX_PEELS) {
        let top = wrap(q.clone(), d);
        if verify(&top) {
            return Some(top);
        }
        q = Query::Minus {
            a: Box::new(q),
            b: Box::new(top),
        };
    }
    let top = wrap(q, d);
    verify(&top).then_some(top)
}

/// At most this many levels are peeled (the query grows with each).
const MAX_PEELS: usize = 5;
