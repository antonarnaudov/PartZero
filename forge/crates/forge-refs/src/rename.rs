//! `renameCurve` on references (SPEC-v1 §5.9 [D-32]): the command layer renames a sketch
//! curve and, in the same op, rewrites every query naming it and every capture key, so that
//! renamed references resolve **exactly** (naming recommendation 7), never through a 0.99
//! geometric match.
//!
//! A rename can change more than the curve's own leaf: a body's member is the byte-wise
//! smallest outer-loop curve id (§5.2 rule 4) and a junction qualifier the smallest curve end
//! at the sketch vertex (§5.2 rule 3), so both are recomputed from the sweeps' regions (the
//! [`FeatureTable`] of the evaluation before the rename) rather than substituted.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::topo::{KeyRoleArg, parse_key};
use forge_ir::v1::{AxisObject, Capture, CaptureMember, Dir, Predicate, Query, Ref};

use crate::table::FeatureTable;

/// A curve rename of one sketch, as it affects references.
#[derive(Clone, Debug, PartialEq)]
pub struct CurveRename {
    /// The sweep features consuming the renamed sketch.
    pub features: BTreeSet<String>,
    /// Old curve id.
    pub old: String,
    /// New curve id.
    pub new: String,
    members: BTreeMap<(String, String), String>,
    qualifiers: BTreeMap<(String, String), String>,
}

impl CurveRename {
    /// The rename of `old` to `new` in the sketch consumed by `features`, with body members and
    /// junction qualifiers recomputed from the regions recorded in `table`.
    pub fn new(
        table: &FeatureTable,
        features: impl IntoIterator<Item = String>,
        old: impl Into<String>,
        new: impl Into<String>,
    ) -> Self {
        let (old, new) = (old.into(), new.into());
        let features: BTreeSet<String> = features.into_iter().collect();
        let rn = |c: &str| if c == old { new.clone() } else { c.to_string() };
        let mut members = BTreeMap::new();
        let mut qualifiers = BTreeMap::new();
        for f in &features {
            let Some(info) = table.get(f) else { continue };
            for r in &info.regions {
                if let Some(m) = r.member() {
                    let renamed = r.outer_curves.iter().map(|c| rn(c)).min();
                    if let Some(n) = renamed {
                        members.insert((f.clone(), m.to_string()), n);
                    }
                }
                for j in &r.junctions {
                    if let Some(q) = j.qualifier() {
                        let n = j.ends().iter().map(|(c, e)| format!("{}.{e}", rn(c))).min();
                        if let Some(n) = n {
                            qualifiers.insert((f.clone(), q), n);
                        }
                    }
                }
            }
        }
        CurveRename {
            features,
            old,
            new,
            members,
            qualifiers,
        }
    }

    fn curve(&self, c: &str) -> String {
        if c == self.old {
            self.new.clone()
        } else {
            c.to_string()
        }
    }

    /// Rewrite a provenance key (recursively through nested keys).
    pub fn key(&self, key: &str) -> String {
        let Ok(mut p) = parse_key(key) else {
            return key.to_string();
        };
        let ours = self.features.contains(&p.feature);
        p.arg = match p.arg {
            KeyRoleArg::Keys(ks) => {
                let mut ks: Vec<String> = ks.iter().map(|k| self.key(k)).collect();
                ks.sort();
                KeyRoleArg::Keys(ks)
            }
            KeyRoleArg::Leaf(l) if ours && p.label == "side" => KeyRoleArg::Leaf(self.curve(&l)),
            KeyRoleArg::Leaf(l) if ours && p.label == "body" => KeyRoleArg::Leaf(
                self.members
                    .get(&(p.feature.clone(), l.clone()))
                    .cloned()
                    .unwrap_or_else(|| self.curve(&l)),
            ),
            KeyRoleArg::Leaves(ls) if ours && p.label == "side" => {
                let mut ls: Vec<String> = ls.iter().map(|l| self.curve(l)).collect();
                ls.sort();
                KeyRoleArg::Leaves(ls)
            }
            other => other,
        };
        if ours && let Some(q) = p.qualifier.take() {
            let f = p.feature.clone();
            p.qualifier = Some(match p.label.as_str() {
                "cap" | "endcap" => self.members.get(&(f, q.clone())).cloned().unwrap_or(q),
                "edge" | "vertex" => match self.qualifiers.get(&(f, q.clone())) {
                    Some(n) => n.clone(),
                    None => match q.rsplit_once('.') {
                        Some((c, e)) => format!("{}.{e}", self.curve(c)),
                        None => q,
                    },
                },
                _ => q,
            });
        }
        p.render()
    }

    /// Rewrite the curve and member fields of a query that name the renamed curve.
    pub fn query(&self, q: &Query) -> Query {
        let ours = |f: &str| self.features.contains(f);
        let m = |f: &str, x: &Option<String>| {
            x.as_ref()
                .map(|c| if ours(f) { self.curve(c) } else { c.clone() })
        };
        let rec = |x: &Query| Box::new(self.query(x));
        match q {
            Query::Body { feature, member } => Query::Body {
                feature: feature.clone(),
                member: m(feature, member),
            },
            Query::Cap {
                feature,
                end,
                member,
            } => Query::Cap {
                feature: feature.clone(),
                end: *end,
                member: m(feature, member),
            },
            Query::Endcap {
                feature,
                end,
                member,
            } => Query::Endcap {
                feature: feature.clone(),
                end: *end,
                member: m(feature, member),
            },
            Query::Side { feature, curve } => Query::Side {
                feature: feature.clone(),
                curve: if ours(feature) {
                    self.curve(curve)
                } else {
                    curve.clone()
                },
            },
            Query::Sides { feature, member } => Query::Sides {
                feature: feature.clone(),
                member: m(feature, member),
            },
            Query::EdgeAt {
                feature,
                curve,
                end,
            } => Query::EdgeAt {
                feature: feature.clone(),
                curve: if ours(feature) {
                    self.curve(curve)
                } else {
                    curve.clone()
                },
                end: *end,
            },
            Query::Between { a, b } => Query::Between {
                a: rec(a),
                b: rec(b),
            },
            Query::Faces { of } => Query::Faces { of: rec(of) },
            Query::Edges { of } => Query::Edges { of: rec(of) },
            Query::Vertices { of } => Query::Vertices { of: rec(of) },
            Query::Owner { of } => Query::Owner { of: rec(of) },
            Query::Union { of } => Query::Union {
                of: of.iter().map(|x| self.query(x)).collect(),
            },
            Query::Intersect { of } => Query::Intersect {
                of: of.iter().map(|x| self.query(x)).collect(),
            },
            Query::Minus { a, b } => Query::Minus {
                a: rec(a),
                b: rec(b),
            },
            Query::Filter { of, pred } => Query::Filter {
                of: rec(of),
                pred: self.predicate(pred),
            },
            Query::Extreme { of, dir, which } => Query::Extreme {
                of: rec(of),
                dir: self.dir(dir),
                which: *which,
            },
            Query::Largest { of } => Query::Largest { of: rec(of) },
            Query::Smallest { of } => Query::Smallest { of: rec(of) },
            other => other.clone(),
        }
    }

    fn predicate(&self, p: &Predicate) -> Predicate {
        match p {
            Predicate::Normal(d) => Predicate::Normal(self.dir(d)),
            Predicate::Parallel(d) => Predicate::Parallel(self.dir(d)),
            Predicate::Perpendicular(d) => Predicate::Perpendicular(self.dir(d)),
            other => other.clone(),
        }
    }

    fn dir(&self, d: &Dir) -> Dir {
        match d {
            Dir::Axis(o) => Dir::Axis(Box::new(match o.as_ref() {
                AxisObject::Edge(e) => {
                    let mut e = e.clone();
                    e.edge = self.apply(&e.edge);
                    AxisObject::Edge(e)
                }
                AxisObject::Cylinder(c) => {
                    let mut c = c.clone();
                    c.cylinder = self.apply(&c.cylinder);
                    AxisObject::Cylinder(c)
                }
                other => other.clone(),
            })),
            other => other.clone(),
        }
    }

    /// Rewrite a reference: its query and its capture's keys (members and edge faces).
    pub fn apply(&self, r: &Ref) -> Ref {
        Ref {
            kind: r.kind,
            q: self.query(&r.q),
            card: r.card,
            capture: r.capture.as_ref().map(|c| {
                let mut members: Vec<CaptureMember> = c
                    .members
                    .iter()
                    .map(|m| CaptureMember {
                        key: self.key(&m.key),
                        via: m.via,
                        faces: m.faces.as_ref().map(|[a, b]| {
                            let mut v = [self.key(a), self.key(b)];
                            v.sort();
                            v
                        }),
                        geom: m.geom.clone(),
                    })
                    .collect();
                // Canonical order is by key (stable: pieces of one key keep their order).
                members.sort_by(|a, b| a.key.cmp(&b.key));
                Capture { members }
            }),
        }
    }
}
