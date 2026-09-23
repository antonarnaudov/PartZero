//! Welding of coincident curve ends (SPEC-v1 §4.3).
//!
//! Curve **ends** (the `start`/`end` points of lines and arcs, construction or not) that
//! coincide within *tol* (inclusive) in the stored geometry are welded into one solver point:
//! union–find over the ends in curve order, `start` before `end`; each group is represented by
//! its first member, the others are aliases. Points and centres never weld.

use std::collections::BTreeMap;

use forge_ir::P2;
use forge_ir::v1::{LINEAR_TOLERANCE, LiteralCurve};

use crate::diagnosis::WeldGroup;
use crate::geometry::dist;

/// One curve end.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct End {
    /// Derived id, `<curve>.start` or `<curve>.end`.
    pub id: String,
    /// Index of the curve in the sketch.
    pub curve: usize,
    /// Stored position.
    pub point: P2,
}

/// The welding of a sketch's stored geometry.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Welding {
    /// Every line/arc end in curve order, `start` before `end`.
    pub ends: Vec<End>,
    /// Representative (index into `ends`) of every end: the smallest index of its group.
    pub rep: Vec<usize>,
    /// Index of every end by derived id.
    by_id: BTreeMap<String, usize>,
}

fn find(parent: &mut [usize], mut a: usize) -> usize {
    while parent[a] != a {
        parent[a] = parent[parent[a]];
        a = parent[a];
    }
    a
}

impl Welding {
    /// Weld the ends of `curves` (the stored geometry, in curve order).
    pub fn compute(curves: &[LiteralCurve]) -> Self {
        let mut ends = Vec::new();
        for (ci, c) in curves.iter().enumerate() {
            if let LiteralCurve::Line { id, start, end, .. }
            | LiteralCurve::Arc { id, start, end, .. } = c
            {
                ends.push(End {
                    id: format!("{id}.start"),
                    curve: ci,
                    point: *start,
                });
                ends.push(End {
                    id: format!("{id}.end"),
                    curve: ci,
                    point: *end,
                });
            }
        }
        let n = ends.len();
        let mut parent: Vec<usize> = (0..n).collect();
        for i in 0..n {
            for j in (i + 1)..n {
                let (p, q) = (ends[i].point, ends[j].point);
                // Cheap rejection first; the decision itself is the inclusive distance rule.
                if (p[0] - q[0]).abs() > LINEAR_TOLERANCE || (p[1] - q[1]).abs() > LINEAR_TOLERANCE
                {
                    continue;
                }
                if dist(p, q) <= LINEAR_TOLERANCE {
                    let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                    if ri != rj {
                        let (lo, hi) = (ri.min(rj), ri.max(rj));
                        parent[hi] = lo;
                    }
                }
            }
        }
        let rep = (0..n).map(|i| find(&mut parent, i)).collect();
        let by_id = ends
            .iter()
            .enumerate()
            .map(|(i, e)| (e.id.clone(), i))
            .collect();
        Self { ends, rep, by_id }
    }

    /// Index of the end with derived id `id`.
    fn index(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }

    /// The solver id of an IR entity reference: an aliased end maps to its representative;
    /// everything else is unchanged.
    pub fn resolve<'a>(&'a self, id: &'a str) -> &'a str {
        match self.index(id) {
            Some(i) => &self.ends[self.rep[i]].id,
            None => id,
        }
    }

    /// `true` when `id` is an end that is not its group's representative.
    pub fn is_alias(&self, id: &str) -> bool {
        self.index(id).is_some_and(|i| self.rep[i] != i)
    }

    /// The groups with at least two members, in order of their representative (one pass).
    pub fn groups(&self) -> Vec<WeldGroup> {
        let mut members: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for (j, e) in self.ends.iter().enumerate() {
            members.entry(self.rep[j]).or_default().push(e.id.clone());
        }
        members
            .into_iter()
            .filter(|(_, m)| m.len() > 1)
            .map(|(i, members)| WeldGroup {
                representative: self.ends[i].id.clone(),
                members,
            })
            .collect()
    }

    /// Curves whose two ends weld into one point (degenerate for the solver).
    pub fn collapsed_curves(&self) -> Vec<usize> {
        // Ends are pushed in pairs: `2k` is curve k's start, `2k + 1` its end.
        (0..self.ends.len() / 2)
            .filter(|k| self.rep[2 * k] == self.rep[2 * k + 1])
            .map(|k| self.ends[2 * k].curve)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, a: P2, b: P2) -> LiteralCurve {
        LiteralCurve::Line {
            id: id.into(),
            start: a,
            end: b,
            construction: false,
        }
    }

    #[test]
    fn the_first_end_in_curve_order_represents_its_group() {
        let w = Welding::compute(&[
            line("a", [0.0, 0.0], [10.0, 0.0]),
            line("b", [10.0, 5e-7], [10.0, 5.0]),
            line("c", [10.0, 5.0], [0.0, 1e-6]),
        ]);
        assert_eq!(w.resolve("b.start"), "a.end");
        assert_eq!(w.resolve("c.end"), "a.start");
        assert_eq!(w.resolve("c.start"), "b.end");
        assert_eq!(w.resolve("a.start"), "a.start");
        assert_eq!(w.resolve("p"), "p", "non-ends are unchanged");
        assert!(w.is_alias("c.end") && !w.is_alias("a.start"));
        let g = w.groups();
        assert_eq!(g.len(), 3);
        assert_eq!(g[0].members, ["a.start", "c.end"]);
        assert!(w.collapsed_curves().is_empty());
    }

    #[test]
    fn welding_is_transitive_and_inclusive_at_the_tolerance() {
        // x.start ~ y.start ~ x.end: x collapses through the chain.
        let w = Welding::compute(&[
            line("x", [0.0, 0.0], [1.8e-6, 0.0]),
            line("y", [0.9e-6, 0.0], [5.0, 5.0]),
        ]);
        assert_eq!(w.collapsed_curves(), [0]);
        // Exactly tol apart welds (inclusive, [R-3]); a hair more does not.
        let at = Welding::compute(&[
            line("a", [0.0, 0.0], [1.0, 0.0]),
            line("b", [1.0 + LINEAR_TOLERANCE, 0.0], [2.0, 0.0]),
        ]);
        assert_eq!(at.resolve("b.start"), "a.end");
        let beyond = Welding::compute(&[
            line("a", [0.0, 0.0], [1.0, 0.0]),
            line("b", [1.0 + 1.5 * LINEAR_TOLERANCE, 0.0], [2.0, 0.0]),
        ]);
        assert_eq!(beyond.resolve("b.start"), "b.start");
    }

    #[test]
    fn centres_and_points_never_weld() {
        let w = Welding::compute(&[
            LiteralCurve::Point {
                id: "p".into(),
                at: [0.0, 0.0],
                construction: false,
            },
            LiteralCurve::Circle {
                id: "c".into(),
                center: [0.0, 0.0],
                radius: 1.0,
                construction: false,
            },
            line("l", [0.0, 0.0], [1.0, 0.0]),
        ]);
        assert!(w.groups().is_empty());
        assert_eq!(w.ends.len(), 2);
    }
}
