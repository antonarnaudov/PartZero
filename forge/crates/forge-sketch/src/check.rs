//! Independent check of a constrained sketch's solution (SPEC-v1 §8.1 replay protocol).
//!
//! Written from the constraint definitions of SPEC-v1 §4.3, **not** from forge-solve's
//! residual code: plain geometric formulas in natural units (mm), so every violation is a
//! length. It verifies what the oracle verifies when it replays `sketch.solved`:
//! 1. the solved curves are the sketch's curves (same ids, kinds, `ccw` and `construction`),
//!    and there is one evaluated value set per constraint;
//! 2. welded ends coincide **exactly** (welding recomputed here from the stored geometry, by
//!    a sweep over x, independently of the evaluator's welding);
//! 3. every arc satisfies the arc rule `|end − center| = |start − center|`;
//! 4. every driving constraint holds to [`forge_ir::v1::SOLVE_CHECK_TOLERANCE`];
//! 5. every reported dimension `value` equals the evaluated one (bit for bit) and every
//!    reported `measured` value matches the geometry.
//!
//! ## Length scale of angular conditions
//!
//! SPEC-v1 §4.4 rule 3 pins forge-solve's convergence test (`SOLVE_TOLERANCE`), which turns an
//! angular condition into a length by a **constant** scale taken from the solver's starting
//! point: the welded stored guess (every welded end at its representative's stored position).
//! This check uses the same convention, so that it accepts exactly the solutions the pinned
//! solver can produce (with the 10× margin of `SOLVE_CHECK_TOLERANCE` over `SOLVE_TOLERANCE`),
//! however far a dimension moves the geometry from its guess:
//! - `parallel`, `perpendicular`: `|sin|` / `|cos|` of the angle between the two lines, and
//!   `angle`: the wrapped angle error in radians, times `sqrt(|u₀|·|w₀|)` floored at 1 µm,
//!   where `u₀`, `w₀` are the two lines' direction vectors in the welded stored guess;
//! - `tangent` at a **joint** (an end of `a` that is welded to, or joined by `coincident`
//!   constraints with, an end of `b`): the first-order condition at the joint point `p` —
//!   line–arc: `|cos|` of the angle between the line and the radius `p − center`, times
//!   `sqrt(|line₀|·|p₀ − center₀|)`; arc–arc: `|sin|` of the angle between the two radii at
//!   `p` (an end of `a`), times `sqrt(|p₀ − center_a₀|·|p₀ − center_b₀|)` (both floored at
//!   1 µm) — in addition to the distance condition, which is only second-order at a joint.
//!
//! Scaling by the *solved* lengths instead would reject valid solves whose lines a dimension
//! grew by more than ~10× (the solver's angular accuracy is relative to the guess).
//!
//! ## Geometric-error cap (Forge's own guard, **not** part of the oracle's check)
//!
//! [`check_solution`] and [`check_trace`] are exactly the checks above — what SPEC-v1 §8.1 asks
//! of the oracle, no more. Sketch evaluation runs [`check_solution_capped`], which adds one
//! guard of Forge's own (not in SPEC-v1; reported as a contract issue, and a failure is marked
//! [`crate::SolveFailure::GeometricCap`] so that W7/W9 can classify it):
//!
//! The guess-relative scale bounds the geometric error of an angular condition only relative
//! to the guess: a 1 µm guess line grown to 100 mm could be off-parallel by 1e-6 rad (1e-4 mm
//! at its far end) and still pass. So every angular condition is also measured at the
//! **solved** size — the same dimensionless quantity times the longer of the two solved lengths
//! involved (both lines; the line and the radius at the joint; the two radii at the joint),
//! i.e. how far the far end of the longer one is off — and must not exceed the larger of
//! - [`NATURAL_DEVIATION_CAP`] = *tol* (`LINEAR_TOLERANCE`, 1e-6 mm), and
//! - what the pinned tolerance itself permits at the **guess's** own size:
//!   `SOLVE_CHECK_TOLERANCE × (longer guess length) / (guess scale)`.
//!
//! The second term makes the guard fire only where the solve **amplified** the error by growing
//! the geometry beyond its guess. A solution whose lengths are no longer than the guess's —
//! in particular the fixed point of SPEC-v1 §4.4 rule 4, however extreme its length ratios
//! (a 1 µm line parallel to a 1 km one) — satisfies it whenever it passes the check above:
//! `angle × solved length ≤ angle × guess length ≤ (SOLVE_CHECK_TOLERANCE / scale) × guess
//! length`. Conditions that are lengths already are bounded by `SOLVE_CHECK_TOLERANCE`
//! (1e-9 mm) directly.
//!
//! **Bound**: every solution evaluation accepts satisfies each driving constraint to
//! `SOLVE_CHECK_TOLERANCE` in the pinned solver's units **and** deviates from each angular
//! condition by at most max(*tol*, the deviation the pinned tolerance permits at the stored
//! guess's size) in mm at its solved size. A solve converged to `SOLVE_TOLERANCE` meets the cap
//! unless a dimension grew the geometry by more than ~10⁴× its guess scale (~10³× at the check
//! tolerance); beyond that the sketch fails loudly (`SKETCH_SOLVE_FAILED`) instead of returning
//! geometry that is off by more than *tol*.
//!
//! ## Cost
//!
//! The welding is a sweep over the m curve ends sorted by x plus union–find: O(m log m + k),
//! where k is the number of pairs of ends within *tol* of each other in x (only those are
//! measured; k reaches m²/2 only when every end lies in one *tol*-wide column). Then one pass
//! over the welded ends and one over the constraints.

use std::collections::BTreeMap;

use forge_core::math;
use forge_ir::P2;
use forge_ir::v1::metrics::SketchReport;
use forge_ir::v1::{Constraint, LINEAR_TOLERANCE, LiteralCurve, SOLVE_CHECK_TOLERANCE};

use crate::lower::ConstraintValues;

/// The geometric deviation, mm, an accepted solution may always have from an angular
/// condition at its **solved** size (module docs, "Geometric-error cap"): *tol*. A condition
/// may deviate more only where the pinned tolerance already permits it at the stored guess's
/// own size.
pub const NATURAL_DEVIATION_CAP: f64 = LINEAR_TOLERANCE;

/// What a [`Violation`] is about.
#[derive(Debug, Clone, PartialEq)]
pub enum Subject {
    /// The solved curves are not the sketch's curves (count, id, kind, `ccw`, `construction`),
    /// or the trace's dimension list does not match the sketch's dimensions.
    Curves,
    /// The evaluated values are not one per constraint (a caller bug).
    Values,
    /// A welded end does not coincide exactly with its group's representative.
    Weld {
        /// The aliased end.
        end: String,
        /// Its representative (the solver point).
        representative: String,
    },
    /// An arc's end is not at its start's distance from the centre.
    ArcRule {
        /// The arc.
        arc: String,
    },
    /// A driving constraint does not hold.
    Constraint {
        /// The constraint id.
        id: String,
    },
    /// A reported dimension entry disagrees with the evaluated value or the geometry.
    Dimension {
        /// The constraint id.
        id: String,
    },
}

/// The worst violation found by [`check_solution`], [`check_solution_capped`] or
/// [`check_trace`].
#[derive(Debug, Clone, PartialEq)]
pub struct Violation {
    /// What is violated.
    pub subject: Subject,
    /// Human-readable: a constraint id (with an explanation where one helps),
    /// `"arc rule <arc>"`, `"weld <end>"`, `"dimension <id>"`, `"curve <index>"`, …
    pub what: String,
    /// The violation, mm (or the absolute difference for a dimension value); never 0 or NaN
    /// (a violation that cannot be measured is infinite).
    pub amount: f64,
    /// Only Forge's geometric-error cap is violated ([`check_solution_capped`]): the solution
    /// passes the SPEC-v1 §8.1 check.
    pub geometric_cap: bool,
}

/// A violation that is not the cap's.
fn violation(subject: Subject, what: String, amount: f64) -> Violation {
    Violation {
        subject,
        what,
        amount,
        geometric_cap: false,
    }
}

/// The amount of a violation measured as `d`: at least the smallest positive number (a
/// violation is never reported as 0), infinite when `d` is not a number (`f64::max` would
/// drop a NaN).
fn violation_amount(d: f64) -> f64 {
    if d.is_nan() {
        f64::INFINITY
    } else {
        d.max(f64::MIN_POSITIVE)
    }
}

/// Solved geometry by IR entity id.
struct View<'a> {
    curves: BTreeMap<&'a str, &'a LiteralCurve>,
}

fn sub(a: P2, b: P2) -> P2 {
    [a[0] - b[0], a[1] - b[1]]
}
fn dot(a: P2, b: P2) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn cross(a: P2, b: P2) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn norm(a: P2) -> f64 {
    math::hypot(a[0], a[1])
}
fn dist(a: P2, b: P2) -> f64 {
    norm(sub(a, b))
}
fn line_dist(p: P2, (a, b): (P2, P2)) -> f64 {
    let d = sub(b, a);
    cross(d, sub(p, a)).abs() / norm(d)
}
/// The coincidence distance of the welding rule: `sqrt(dx² + dy²)` without fused operations,
/// the formula of the IR crate's coincidence and degeneracy checks, so that a pair exactly at
/// the tolerance is decided the same way everywhere.
fn weld_dist(a: P2, b: P2) -> f64 {
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dy * dy).sqrt()
}
/// The constant length scale of an angular condition: the geometric mean of two lengths of
/// the welded stored guess, floored at 1 µm (see the module docs).
fn length_scale(a: f64, b: f64) -> f64 {
    (a * b).sqrt().max(1e-3)
}

/// The guess side of an angular condition from its two guess lengths: the length scale
/// ([`length_scale`]) and the longer length.
fn guess_lengths(a: f64, b: f64) -> (f64, f64) {
    (length_scale(a, b), a.max(b))
}

/// The measures of one constraint's violation, mm.
#[derive(Debug, Clone, Copy)]
struct Residual {
    /// The check residual, compared with [`SOLVE_CHECK_TOLERANCE`]: angular conditions scaled
    /// by the welded stored guess (the pinned solver's convention, module docs).
    check: f64,
    /// The geometric deviation at the **solved** size (the cap, module docs): angular
    /// conditions times the longer of the two solved lengths involved. Equal to `check` for
    /// conditions that are lengths already.
    natural: f64,
    /// The largest `natural` the cap accepts for this condition: the larger of
    /// [`NATURAL_DEVIATION_CAP`] and, for an angular condition, what `SOLVE_CHECK_TOLERANCE`
    /// permits at the guess's own size.
    allowed: f64,
}

/// `max` that propagates NaN (a NaN is a violation, never dropped).
fn nan_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

impl Residual {
    /// A condition that is a length.
    fn linear(e: f64) -> Self {
        Self {
            check: e,
            natural: e,
            allowed: NATURAL_DEVIATION_CAP,
        }
    }
    /// A dimensionless angular condition `ang` (a sine, cosine or wrapped angle), with the
    /// guess's length scale `scale`, the longer of the lengths involved in the guess
    /// (`guess_len`) and in the solution (`solved_len`).
    fn angular(ang: f64, scale: f64, guess_len: f64, solved_len: f64) -> Self {
        Self {
            check: ang * scale,
            natural: ang * solved_len,
            allowed: NATURAL_DEVIATION_CAP.max(SOLVE_CHECK_TOLERANCE * guess_len / scale),
        }
    }
    /// How far the cap is exceeded (> 0: violated; NaN: not measurable, a violation).
    fn excess(self) -> f64 {
        self.natural - self.allowed
    }
    /// The worse of two measures of one constraint (NaN propagates as a violation): the larger
    /// check residual, and the condition that exceeds its cap by more.
    fn max(self, o: Self) -> Self {
        let cap = if self.excess().is_nan() {
            self
        } else if o.excess().is_nan() || o.excess() > self.excess() {
            o
        } else {
            self
        };
        Self {
            check: nan_max(self.check, o.check),
            natural: cap.natural,
            allowed: cap.allowed,
        }
    }
}

impl<'a> View<'a> {
    fn new(solved: &'a [LiteralCurve]) -> Self {
        Self {
            curves: solved.iter().map(|c| (c.id(), c)).collect(),
        }
    }
    /// A point: a `point` curve, or `<curve>.start` / `.end` / `.center`.
    fn point(&self, id: &str) -> Option<P2> {
        if let Some(LiteralCurve::Point { at, .. }) = self.curves.get(id) {
            return Some(*at);
        }
        let (curve, which) = id.rsplit_once('.')?;
        match (self.curves.get(curve)?, which) {
            (LiteralCurve::Line { start, .. } | LiteralCurve::Arc { start, .. }, "start") => {
                Some(*start)
            }
            (LiteralCurve::Line { end, .. } | LiteralCurve::Arc { end, .. }, "end") => Some(*end),
            (LiteralCurve::Arc { center, .. } | LiteralCurve::Circle { center, .. }, "center") => {
                Some(*center)
            }
            _ => None,
        }
    }
    fn line(&self, id: &str) -> Option<(P2, P2)> {
        match self.curves.get(id)? {
            LiteralCurve::Line { start, end, .. } => Some((*start, *end)),
            _ => None,
        }
    }
    /// Centre and radius of a circle or arc (an arc's radius is `|start − center|`).
    fn round(&self, id: &str) -> Option<(P2, f64)> {
        match self.curves.get(id)? {
            LiteralCurve::Circle { center, radius, .. } => Some((*center, *radius)),
            LiteralCurve::Arc { center, start, .. } => Some((*center, dist(*start, *center))),
            _ => None,
        }
    }
    fn is_line(&self, id: &str) -> bool {
        matches!(self.curves.get(id), Some(LiteralCurve::Line { .. }))
    }
    /// The two end ids of a line or arc (none for circles and points).
    fn ends(&self, id: &str) -> Vec<String> {
        match self.curves.get(id) {
            Some(LiteralCurve::Line { .. } | LiteralCurve::Arc { .. }) => {
                vec![format!("{id}.start"), format!("{id}.end")]
            }
            _ => Vec::new(),
        }
    }
}

/// Union–find root with path halving.
fn root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Join the groups of `i` and `j`; the smaller root represents the union, so every group is
/// represented by its smallest index.
fn join(parent: &mut [usize], i: usize, j: usize) {
    let (ri, rj) = (root(parent, i), root(parent, j));
    if ri != rj {
        parent[ri.max(rj)] = ri.min(rj);
    }
}

/// The ends of `curves` that coincide within *tol* (inclusive), grouped transitively; each
/// group's first member (curve order, `start` before `end`) is its representative. Returns
/// the `(alias, representative)` pairs and `end id → representative's stored position` for
/// every end.
fn weld_targets(stored: &[LiteralCurve]) -> (Vec<(String, String)>, BTreeMap<String, P2>) {
    let mut ends: Vec<(String, P2)> = Vec::new();
    for c in stored {
        if let LiteralCurve::Line { id, start, end, .. }
        | LiteralCurve::Arc { id, start, end, .. } = c
        {
            ends.push((format!("{id}.start"), *start));
            ends.push((format!("{id}.end"), *end));
        }
    }
    let label = weld_labels(&ends.iter().map(|e| e.1).collect::<Vec<_>>()).0;
    let n = ends.len();
    let pairs = (0..n)
        .filter(|&i| label[i] != i)
        .map(|i| (ends[i].0.clone(), ends[label[i]].0.clone()))
        .collect();
    let rep_pos = (0..n)
        .map(|i| (ends[i].0.clone(), ends[label[i]].1))
        .collect();
    (pairs, rep_pos)
}

/// The welding of `points`: every point's representative, the smallest index of its group of
/// points transitively within *tol* (inclusive, [`weld_dist`]); and the number of distances
/// measured (for the cost bound, module docs).
///
/// A sweep over the points sorted by x: a pair more than *tol* apart in x is more than *tol*
/// apart (`weld_dist ≥ |Δx|` in floating point: `√fl(Δx² + Δy²) ≥ √fl(Δx²) = |Δx|`), and the
/// sorted x gap only grows, so each point is compared with the following ones until the gap
/// exceeds *tol* (or is not a number: a non-finite point welds nothing).
fn weld_labels(points: &[P2]) -> (Vec<usize>, usize) {
    let n = points.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| points[i][0].total_cmp(&points[j][0]).then(i.cmp(&j)));
    let mut parent: Vec<usize> = (0..n).collect();
    let mut measured = 0usize;
    for (k, &i) in order.iter().enumerate() {
        for &j in &order[k + 1..] {
            let gap = points[j][0] - points[i][0];
            if gap.is_nan() || gap > LINEAR_TOLERANCE {
                break;
            }
            measured += 1;
            if weld_dist(points[i], points[j]) <= LINEAR_TOLERANCE {
                join(&mut parent, i, j);
            }
        }
    }
    let label = (0..n).map(|i| root(&mut parent, i)).collect();
    (label, measured)
}

/// Points that denote one location for tangency: welded ends, and points joined by
/// `coincident` constraints (all of them driving), transitively.
struct Joints {
    /// Every point id named by a weld or a `coincident`, by index.
    index: BTreeMap<String, usize>,
    /// The group of every indexed point (its union–find root).
    group: Vec<usize>,
}

impl Joints {
    fn new(welds: &[(String, String)], constraints: &[Constraint]) -> Self {
        let mut index: BTreeMap<String, usize> = BTreeMap::new();
        let mut parent: Vec<usize> = Vec::new();
        let mut intern = |id: &str, parent: &mut Vec<usize>| -> usize {
            if let Some(&i) = index.get(id) {
                return i;
            }
            let i = parent.len();
            parent.push(i);
            index.insert(id.to_string(), i);
            i
        };
        let coincident = constraints.iter().filter_map(|c| match c {
            Constraint::Coincident { a, b, .. } => Some((a.as_str(), b.as_str())),
            _ => None,
        });
        for (a, b) in welds
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .chain(coincident)
        {
            let (i, j) = (intern(a, &mut parent), intern(b, &mut parent));
            join(&mut parent, i, j);
        }
        let group = (0..parent.len()).map(|i| root(&mut parent, i)).collect();
        Self { index, group }
    }
    /// `a` and `b` denote one location.
    fn same(&self, a: &str, b: &str) -> bool {
        match (self.index.get(a), self.index.get(b)) {
            (Some(&i), Some(&j)) => self.group[i] == self.group[j],
            _ => a == b,
        }
    }
    /// The joints of two curves: pairs (end of `a`, end of `b`) that denote one location.
    fn between(&self, v: &View<'_>, a: &str, b: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for ea in v.ends(a) {
            for eb in v.ends(b) {
                if self.same(&ea, &eb) {
                    out.push((ea.clone(), eb));
                }
            }
        }
        out
    }
}

/// The stored guess as the solver received it: welded ends at their representative's stored
/// position, every other point at its own.
struct Guess<'a> {
    stored: View<'a>,
    rep_pos: &'a BTreeMap<String, P2>,
}

impl Guess<'_> {
    fn point(&self, id: &str) -> Option<P2> {
        self.rep_pos
            .get(id)
            .copied()
            .or_else(|| self.stored.point(id))
    }
    /// A line's direction vector `end − start`.
    fn dir(&self, line: &str) -> Option<P2> {
        Some(sub(
            self.point(&format!("{line}.end"))?,
            self.point(&format!("{line}.start"))?,
        ))
    }
}

/// Everything a residual needs.
struct Ctx<'a> {
    v: View<'a>,
    guess: Guess<'a>,
    joints: Joints,
}

/// The worst violation of a solution (`solved`, the curves in sketch order) of the constrained
/// sketch whose stored guess is `stored`, with evaluated constraint `values` (one per
/// constraint): exactly the SPEC-v1 §8.1 check (module docs, items 1–4; no geometric-error
/// cap). `Ok(worst)` when every check holds: `worst` is the largest constraint residual
/// (≤ [`SOLVE_CHECK_TOLERANCE`]).
pub fn check_solution(
    stored: &[LiteralCurve],
    constraints: &[Constraint],
    values: &[ConstraintValues],
    solved: &[LiteralCurve],
) -> Result<f64, Violation> {
    check(stored, constraints, values, solved, false)
}

/// [`check_solution`] plus Forge's geometric-error cap (module docs): what sketch evaluation
/// requires of every successful solve. **Stricter than SPEC-v1 §8.1**: a solution that fails
/// only the cap is reported with [`Violation::geometric_cap`] set; the oracle (and W7's Rust
/// twin of its check) must not apply it.
pub fn check_solution_capped(
    stored: &[LiteralCurve],
    constraints: &[Constraint],
    values: &[ConstraintValues],
    solved: &[LiteralCurve],
) -> Result<f64, Violation> {
    check(stored, constraints, values, solved, true)
}

fn check(
    stored: &[LiteralCurve],
    constraints: &[Constraint],
    values: &[ConstraintValues],
    solved: &[LiteralCurve],
    cap: bool,
) -> Result<f64, Violation> {
    // 1. Same curves, one value set per constraint.
    if values.len() != constraints.len() {
        return Err(violation(
            Subject::Values,
            format!(
                "{} value sets for {} constraints",
                values.len(),
                constraints.len()
            ),
            f64::INFINITY,
        ));
    }
    if stored.len() != solved.len() {
        return Err(violation(
            Subject::Curves,
            format!("curve count {} != {}", solved.len(), stored.len()),
            f64::INFINITY,
        ));
    }
    for (k, (a, b)) in stored.iter().zip(solved).enumerate() {
        let same = match (a, b) {
            (
                LiteralCurve::Line {
                    id, construction, ..
                },
                LiteralCurve::Line {
                    id: i2,
                    construction: c2,
                    ..
                },
            )
            | (
                LiteralCurve::Circle {
                    id, construction, ..
                },
                LiteralCurve::Circle {
                    id: i2,
                    construction: c2,
                    ..
                },
            )
            | (
                LiteralCurve::Point {
                    id, construction, ..
                },
                LiteralCurve::Point {
                    id: i2,
                    construction: c2,
                    ..
                },
            ) => id == i2 && construction == c2,
            (
                LiteralCurve::Arc {
                    id,
                    ccw,
                    construction,
                    ..
                },
                LiteralCurve::Arc {
                    id: i2,
                    ccw: w2,
                    construction: c2,
                    ..
                },
            ) => id == i2 && ccw == w2 && construction == c2,
            _ => false,
        };
        if !same {
            return Err(violation(
                Subject::Curves,
                format!("curve {k}"),
                f64::INFINITY,
            ));
        }
    }
    let (pairs, rep_pos) = weld_targets(stored);
    let ctx = Ctx {
        v: View::new(solved),
        guess: Guess {
            stored: View::new(stored),
            rep_pos: &rep_pos,
        },
        joints: Joints::new(&pairs, constraints),
    };
    let v = &ctx.v;
    // 2. Welded ends coincide exactly.
    for (alias, rep) in &pairs {
        let (pa, pr) = (v.point(alias), v.point(rep));
        if pa != pr {
            let amount = match (pa, pr) {
                (Some(a), Some(b)) => violation_amount(dist(a, b)),
                _ => f64::INFINITY,
            };
            return Err(violation(
                Subject::Weld {
                    end: alias.clone(),
                    representative: rep.clone(),
                },
                format!("weld {alias}"),
                amount,
            ));
        }
    }
    // 3. Arc rule; 4. driving constraints. The worst one decides.
    let mut worst = 0.0f64;
    let mut worst_at: Option<(Subject, String)> = None;
    let mut note = |at: &dyn Fn() -> (Subject, String), e: f64| {
        if e > worst || e.is_nan() {
            worst = if e.is_nan() { f64::INFINITY } else { e };
            worst_at = Some(at());
        }
    };
    for c in solved {
        if let LiteralCurve::Arc {
            id,
            start,
            end,
            center,
            ..
        } = c
        {
            let e = (dist(*end, *center) - dist(*start, *center)).abs();
            note(
                &|| {
                    (
                        Subject::ArcRule { arc: id.clone() },
                        format!("arc rule {id}"),
                    )
                },
                e,
            );
        }
    }
    // The condition that exceeds the geometric-error cap by the most (module docs).
    let mut capped: Option<(f64, f64, &Constraint)> = None;
    for (con, val) in constraints.iter().zip(values) {
        if con.dimension().is_some_and(|(_, driving)| !driving) {
            continue;
        }
        let e = residual(con, val, &ctx).unwrap_or(Residual::linear(f64::INFINITY));
        let at = || {
            (
                Subject::Constraint {
                    id: con.id().to_string(),
                },
                explain(con, &ctx),
            )
        };
        note(&at, e.check);
        // A NaN excess is a violation: infinitely over the cap.
        let excess = if e.excess().is_nan() {
            f64::INFINITY
        } else {
            e.excess()
        };
        if excess > 0.0 && capped.is_none_or(|(w, _, _)| excess > w) {
            capped = Some((excess, violation_amount(e.natural), con));
        }
    }
    if let Some((subject, what)) = worst_at
        && worst > SOLVE_CHECK_TOLERANCE
    {
        return Err(violation(subject, what, worst));
    }
    if cap && let Some((_, amount, con)) = capped {
        let id = con.id();
        return Err(Violation {
            subject: Subject::Constraint { id: id.to_string() },
            what: format!(
                "{id} (Forge's geometric-error cap, not a SPEC-v1 check: the solver's angular accuracy is relative to the stored guess, and the solve grew the geometry so far beyond it that the solution deviates by more than tol at the solved size)"
            ),
            amount,
            geometric_cap: true,
        });
    }
    Ok(worst)
}

/// The residuals of one driving constraint at the solved geometry (see [`Residual`]).
fn residual(con: &Constraint, val: &ConstraintValues, ctx: &Ctx<'_>) -> Option<Residual> {
    let (v, g) = (&ctx.v, &ctx.guess);
    Some(match con {
        Constraint::Coincident { a, b, .. } => Residual::linear(dist(v.point(a)?, v.point(b)?)),
        Constraint::Horizontal { line, .. } => {
            let (a, b) = v.line(line)?;
            Residual::linear((b[1] - a[1]).abs())
        }
        Constraint::Vertical { line, .. } => {
            let (a, b) = v.line(line)?;
            Residual::linear((b[0] - a[0]).abs())
        }
        Constraint::Parallel { a, b, .. } | Constraint::Perpendicular { a, b, .. } => {
            let (la, lb) = (v.line(a)?, v.line(b)?);
            let (u, w) = (sub(la.1, la.0), sub(lb.1, lb.0));
            let t = if matches!(con, Constraint::Parallel { .. }) {
                cross(u, w)
            } else {
                dot(u, w)
            };
            let ang = t.abs() / (norm(u) * norm(w));
            let (s, len) = guess_lengths(norm(g.dir(a)?), norm(g.dir(b)?));
            Residual::angular(ang, s, len, norm(u).max(norm(w)))
        }
        Constraint::Tangent { a, b, internal, .. } => {
            let joints = ctx.joints.between(v, a, b);
            if v.is_line(a) || v.is_line(b) {
                let line_first = v.is_line(a);
                let (l, c) = if line_first { (a, b) } else { (b, a) };
                let (m, r) = v.round(c)?;
                let (la, lb) = v.line(l)?;
                let mut e = Residual::linear((line_dist(m, (la, lb)) - r).abs());
                // First order at a joint: the line is perpendicular to the radius there.
                for (ja, jb) in &joints {
                    let pl = if line_first { ja } else { jb };
                    let (d, rv) = (sub(lb, la), sub(v.point(pl)?, m));
                    let (s, len) = guess_lengths(
                        norm(g.dir(l)?),
                        dist(g.point(pl)?, g.point(&format!("{c}.center"))?),
                    );
                    let ang = dot(d, rv).abs() / (norm(d) * norm(rv));
                    e = e.max(Residual::angular(ang, s, len, norm(d).max(norm(rv))));
                }
                e
            } else {
                let ((m1, r1), (m2, r2)) = (v.round(a)?, v.round(b)?);
                let d = dist(m1, m2);
                let ext = (d - (r1 + r2)).abs();
                let int = (d - (r1 - r2).abs()).abs();
                let mut e = Residual::linear(match internal {
                    Some(true) => int,
                    Some(false) => ext,
                    None => ext.min(int),
                });
                // First order at a joint: the two radii there are collinear.
                for (ja, _) in &joints {
                    let p = v.point(ja)?;
                    let (u, w) = (sub(p, m1), sub(p, m2));
                    let p0 = g.point(ja)?;
                    let (s, len) = guess_lengths(
                        dist(p0, g.point(&format!("{a}.center"))?),
                        dist(p0, g.point(&format!("{b}.center"))?),
                    );
                    let ang = cross(u, w).abs() / (norm(u) * norm(w));
                    e = e.max(Residual::angular(ang, s, len, norm(u).max(norm(w))));
                }
                e
            }
        }
        Constraint::Equal { a, b, .. } => Residual::linear(if v.is_line(a) {
            let (la, lb) = (v.line(a)?, v.line(b)?);
            (dist(la.0, la.1) - dist(lb.0, lb.1)).abs()
        } else {
            (v.round(a)?.1 - v.round(b)?.1).abs()
        }),
        Constraint::Distance { a, b, .. } => {
            let value = val.value?;
            Residual::linear(if v.is_line(b) {
                (line_dist(v.point(a)?, v.line(b)?) - value).abs()
            } else {
                (dist(v.point(a)?, v.point(b)?) - value).abs()
            })
        }
        Constraint::Angle { a, b, .. } => {
            let value = val.value?;
            let (la, lb) = (v.line(a)?, v.line(b)?);
            let (u, w) = (sub(la.1, la.0), sub(lb.1, lb.0));
            let phi = math::atan2(cross(u, w), dot(u, w));
            let e = phi - math::deg_to_rad(value);
            let ang = math::atan2(math::sin(e), math::cos(e)).abs();
            let (s, len) = guess_lengths(norm(g.dir(a)?), norm(g.dir(b)?));
            Residual::angular(ang, s, len, norm(u).max(norm(w)))
        }
        Constraint::Radius { curve, .. } => {
            Residual::linear((v.round(curve)?.1 - val.value?).abs())
        }
        Constraint::Diameter { curve, .. } => {
            Residual::linear((2.0 * v.round(curve)?.1 - val.value?).abs())
        }
        Constraint::PointOnLine { point, line, .. } => {
            Residual::linear(line_dist(v.point(point)?, v.line(line)?))
        }
        Constraint::PointOnCircle { point, curve, .. } => {
            let (m, r) = v.round(curve)?;
            Residual::linear((dist(v.point(point)?, m) - r).abs())
        }
        Constraint::Midpoint { point, line, .. } => {
            let (a, b) = v.line(line)?;
            Residual::linear(dist(
                v.point(point)?,
                [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0],
            ))
        }
        Constraint::Symmetric { a, b, line, .. } => {
            let (pa, pb) = (v.point(a)?, v.point(b)?);
            let l = v.line(line)?;
            let m = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
            let d = sub(l.1, l.0);
            Residual::linear(line_dist(m, l) + dot(d, sub(pb, pa)).abs() / norm(d))
        }
        Constraint::Fix { entity, .. } => Residual::linear(if let Some(p) = v.point(entity) {
            let t = g.point(entity)?;
            dist(p, [val.x.unwrap_or(t[0]), val.y.unwrap_or(t[1])])
        } else if let Some((a, b)) = v.line(entity) {
            let (sa, sb) = (
                g.point(&format!("{entity}.start"))?,
                g.point(&format!("{entity}.end"))?,
            );
            dist(a, sa).max(dist(b, sb))
        } else {
            let (m, r) = v.round(entity)?;
            let (m0, r0) = g.stored.round(entity)?;
            dist(m, m0).max((r - r0).abs())
        }),
    })
}

/// The violated constraint's id, with an explanation for the one case whose cause is not
/// the geometry: `internal` on an arc–arc tangency at a joint, where forge-solve's joint
/// tangency keeps the stored configuration and ignores the flag.
fn explain(con: &Constraint, ctx: &Ctx<'_>) -> String {
    let id = con.id().to_string();
    let Constraint::Tangent {
        a,
        b,
        internal: Some(internal),
        ..
    } = con
    else {
        return id;
    };
    let v = &ctx.v;
    if v.is_line(a) || v.is_line(b) {
        return id;
    }
    let (Some((m1, _)), Some((m2, _))) = (v.round(a), v.round(b)) else {
        return id;
    };
    for (ja, jb) in ctx.joints.between(v, a, b) {
        let Some(p) = v.point(&ja) else { continue };
        // Internal tangency: both centres on the same side of the joint.
        let is_internal = dot(sub(m1, p), sub(m2, p)) > 0.0;
        if is_internal != *internal {
            let kind = |x: bool| if x { "internal" } else { "external" };
            return format!(
                "{id} (`internal: {internal}` asks for {} tangency, but {a} and {b} meet at the joint {ja} = {jb} in the {} configuration: forge-solve's tangency at a joint ignores `internal` and keeps the stored configuration)",
                kind(*internal),
                kind(is_internal)
            );
        }
    }
    id
}

/// Check a replay trace (`sketch.solved` and `sketch.dimensions`, SPEC-v1 §4.4) the way the
/// oracle does (SPEC-v1 §8.1): [`check_solution`] on `trace.solved` (no geometric-error cap),
/// plus every dimension entry: in constraint order, driving flag as declared, `value`
/// bit-identical to the evaluated value, `measured` within [`SOLVE_CHECK_TOLERANCE`] of the
/// geometry.
pub fn check_trace(
    stored: &[LiteralCurve],
    constraints: &[Constraint],
    values: &[ConstraintValues],
    trace: &SketchReport,
) -> Result<f64, Violation> {
    let worst = check_solution(stored, constraints, values, &trace.solved)?;
    let v = View::new(&trace.solved);
    let dims: Vec<(&Constraint, &ConstraintValues)> = constraints
        .iter()
        .zip(values)
        .filter(|(c, _)| c.dimension().is_some())
        .collect();
    if dims.len() != trace.dimensions.len() {
        return Err(violation(
            Subject::Curves,
            "dimension count".into(),
            f64::INFINITY,
        ));
    }
    for ((con, val), d) in dims.into_iter().zip(&trace.dimensions) {
        let (_, driving) = con.dimension().expect("dimension");
        let bad = |amount: f64| {
            violation(
                Subject::Dimension {
                    id: con.id().to_string(),
                },
                format!("dimension {}", con.id()),
                amount,
            )
        };
        if d.id != con.id() || d.driving != driving {
            return Err(bad(f64::INFINITY));
        }
        let expected = if driving { val.value } else { None };
        if d.value.map(f64::to_bits) != expected.map(f64::to_bits) {
            return Err(bad(match (d.value, expected) {
                (Some(a), Some(b)) => violation_amount((a - b).abs()),
                _ => f64::INFINITY,
            }));
        }
        let m = measure(con, &v).ok_or_else(|| bad(f64::INFINITY))?;
        // mm, or degrees for angles (compared modulo a full turn).
        let e = if matches!(con, Constraint::Angle { .. }) {
            let diff = (d.measured - m).abs() % 360.0;
            diff.min(360.0 - diff)
        } else {
            (d.measured - m).abs()
        };
        if e > SOLVE_CHECK_TOLERANCE || e.is_nan() {
            return Err(bad(violation_amount(e)));
        }
    }
    Ok(worst)
}

/// A dimension's value at the geometry (mm or degrees in (−180, 180]).
fn measure(con: &Constraint, v: &View<'_>) -> Option<f64> {
    Some(match con {
        Constraint::Distance { a, b, .. } => {
            if v.is_line(b) {
                line_dist(v.point(a)?, v.line(b)?)
            } else {
                dist(v.point(a)?, v.point(b)?)
            }
        }
        Constraint::Angle { a, b, .. } => {
            let (la, lb) = (v.line(a)?, v.line(b)?);
            let (u, w) = (sub(la.1, la.0), sub(lb.1, lb.0));
            math::rad_to_deg(math::atan2(cross(u, w), dot(u, w)))
        }
        Constraint::Radius { curve, .. } => v.round(curve)?.1,
        Constraint::Diameter { curve, .. } => 2.0 * v.round(curve)?.1,
        _ => return None,
    })
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

    fn parallel() -> Constraint {
        serde_json::from_value(
            serde_json::json!({ "id": "p", "type": "parallel", "a": "a", "b": "b" }),
        )
        .expect("constraint")
    }

    #[test]
    fn fewer_values_than_constraints_is_a_violation_not_a_silent_pass() {
        let curves = [
            line("a", [0.0, 0.0], [1.0, 0.0]),
            line("b", [0.0, 1.0], [1.0, 2.0]),
        ];
        let v = check_solution(&curves, &[parallel()], &[], &curves).expect_err("mismatch");
        assert_eq!(v.subject, Subject::Values);
        assert!(v.amount.is_infinite());
        let trace = SketchReport {
            mode: forge_ir::v1::metrics::SketchMode::Constrained,
            status: None,
            dof: None,
            solved: curves.to_vec(),
            dimensions: Vec::new(),
        };
        assert_eq!(
            check_trace(&curves, &[parallel()], &[], &trace)
                .expect_err("mismatch")
                .subject,
            Subject::Values
        );
        // With the value set, the (violated) constraint itself is reported.
        let v = check_solution(
            &curves,
            &[parallel()],
            &[ConstraintValues::default()],
            &curves,
        )
        .expect_err("not parallel");
        assert_eq!(v.subject, Subject::Constraint { id: "p".into() });
    }

    #[test]
    fn angular_residuals_are_scaled_by_the_stored_guess_not_the_solution() {
        // Stored: two unit lines. Solved: the same lines 1000× longer with an angle error of
        // 5e-12 rad: 5e-12 mm at the solver's (stored) scale of 1 mm — a converged solve —
        // but 5e-9 mm at the solved scale of 1000 mm, which would wrongly fail the check.
        let stored = [
            line("a", [0.0, 0.0], [1.0, 0.0]),
            line("b", [0.0, 1.0], [1.0, 1.0]),
        ];
        let solved = |eps: f64| {
            [
                line("a", [0.0, 0.0], [1000.0, 0.0]),
                line("b", [0.0, 1.0], [1000.0, 1.0 + 1000.0 * eps]),
            ]
        };
        let one = [ConstraintValues::default()];
        let worst = check_solution(&stored, &[parallel()], &one, &solved(5e-12))
            .expect("holds at the solver's scale");
        assert!(worst <= 1e-11, "{worst}");
        // A real violation at the stored scale is still caught: 1e-8 rad × 1 mm.
        let v = check_solution(&stored, &[parallel()], &one, &solved(1e-8)).expect_err("bad");
        assert!((v.amount - 1e-8).abs() <= 1e-12, "{}", v.amount);
    }

    /// Stored: two 1 µm lines (the guess scale floor). Solved: 100 mm lines whose angle error
    /// is `eps` rad.
    fn tiny_guess_grown(eps: f64) -> ([LiteralCurve; 2], [LiteralCurve; 2]) {
        let stored = [
            line("a", [0.0, 0.0], [1e-3, 0.0]),
            line("b", [0.0, 1.0], [1e-3, 1.0]),
        ];
        let solved = [
            line("a", [0.0, 0.0], [100.0, 0.0]),
            line("b", [0.0, 1.0], [100.0, 1.0 + 100.0 * eps]),
        ];
        (stored, solved)
    }

    #[test]
    fn an_angular_condition_off_by_more_than_tol_at_the_solved_size_fails_the_cap() {
        let one = [ConstraintValues::default()];
        // 5e-7 rad: 5e-10 mm at the guess scale (passes the solver-convention residual), but
        // the far end of a 100 mm line is 5e-5 mm off — 50× tol. The cap rejects it.
        let (stored, solved) = tiny_guess_grown(5e-7);
        let v = check_solution_capped(&stored, &[parallel()], &one, &solved).expect_err("capped");
        assert_eq!(v.subject, Subject::Constraint { id: "p".into() });
        assert!(v.geometric_cap);
        assert!((v.amount - 5e-5).abs() <= 1e-12, "{}", v.amount);
        assert!(
            v.what.starts_with("p (Forge's geometric-error cap"),
            "{}",
            v.what
        );
        // The SPEC-v1 §8.1 check (the oracle's, and the replay trace's) has no cap.
        let worst = check_solution(&stored, &[parallel()], &one, &solved).expect("§8.1 holds");
        assert!(worst <= SOLVE_CHECK_TOLERANCE, "{worst}");
        // 5e-9 rad: 5e-7 mm at the far end, within tol — accepted; `worst` stays the
        // solver-convention residual.
        let (stored, solved) = tiny_guess_grown(5e-9);
        let worst =
            check_solution_capped(&stored, &[parallel()], &one, &solved).expect("within tol");
        assert!(worst <= 1e-11, "{worst}");
        // The same holds for perpendicular, angle and the tangency joint conditions: the cap
        // uses the same dimensionless quantity as the residual (checked via `Residual`).
        let r = Residual::angular(2e-7, 1e-3, 1e-3, 100.0);
        assert!(r.check <= SOLVE_CHECK_TOLERANCE && r.excess() > 0.0);
        let m = Residual::linear(1e-12).max(Residual::angular(f64::NAN, 1.0, 1.0, 1.0));
        assert!(m.check.is_nan() && m.natural.is_nan(), "NaN is a violation");
        let m = Residual::angular(f64::NAN, 1.0, 1.0, 1.0).max(Residual::linear(1e-12));
        assert!(
            m.check.is_nan() && m.excess().is_nan(),
            "NaN wins either way"
        );
    }

    #[test]
    fn the_cap_never_rejects_a_solution_no_longer_than_its_guess() {
        // Review: at a fixed point (SPEC-v1 §4.4 rule 4) with extreme length ratios — a 1 µm
        // line parallel to a 1 km one — the pinned tolerance permits 2e-12 rad (6.3e-11 mm at
        // the guess scale √(1e-3 · 1e6) ≈ 31.6), which is 2e-6 mm (2 tol) at the far end of
        // the long line. The solution is the guess: nothing was amplified, so the cap accepts.
        let one = [ConstraintValues::default()];
        let fixed = [
            line("a", [0.0, 0.0], [1e-3, 0.0]),
            line("b", [0.0, 10.0], [1e6, 10.0 + 2e-6]),
        ];
        let worst = check_solution_capped(&fixed, &[parallel()], &one, &fixed).expect("fixed");
        assert!(worst <= forge_ir::v1::SOLVE_TOLERANCE, "{worst}");
        let (u, w) = ([1e-3, 0.0], [1e6, 2e-6]);
        let natural = cross(u, w).abs() / (norm(u) * norm(w)) * 1e6;
        assert!(
            natural > NATURAL_DEVIATION_CAP,
            "the case exercises the cap: {natural}"
        );
        // The same error after the solve grew the long line 1000× beyond its guess is
        // amplified: 5e-6 mm, over tol and over what the guess scale permits (1e-6 mm).
        let grown_from = [
            line("a", [0.0, 0.0], [1e-3, 0.0]),
            line("b", [0.0, 10.0], [1e3, 10.0]),
        ];
        let grown = [
            line("a", [0.0, 0.0], [1e-3, 0.0]),
            line("b", [0.0, 10.0], [1e6, 10.0 + 5e-6]),
        ];
        check_solution(&grown_from, &[parallel()], &one, &grown).expect("§8.1 holds");
        let v =
            check_solution_capped(&grown_from, &[parallel()], &one, &grown).expect_err("amplified");
        assert!(v.geometric_cap);
        assert!((v.amount - 5e-6).abs() <= 1e-12, "{}", v.amount);
    }

    /// The old welding of this module (repeated relabelling to the smallest connected index,
    /// O(passes · m²)): the reference for [`weld_labels`].
    fn brute_force_labels(points: &[P2]) -> Vec<usize> {
        let n = points.len();
        let mut label: Vec<usize> = (0..n).collect();
        let mut changed = true;
        while changed {
            changed = false;
            for i in 0..n {
                for j in 0..n {
                    if label[j] < label[i] && weld_dist(points[i], points[j]) <= LINEAR_TOLERANCE {
                        label[i] = label[j];
                        changed = true;
                    }
                }
            }
        }
        label
    }

    /// A small deterministic generator (splitmix64) for the welding cases.
    fn next(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    #[test]
    fn the_sweep_welding_equals_the_transitive_closure_on_clustered_points() {
        let tol = LINEAR_TOLERANCE;
        // Hand-picked edge cases: exactly tol apart (inclusive), just over, a chain whose ends
        // are 2 tol apart (transitive), negative zero, and non-finite points (weld nothing).
        let edge: Vec<P2> = vec![
            [0.0, 0.0],
            [tol, 0.0],
            [2.0 * tol, 0.0],
            [-0.0, tol],
            [5.0, 5.0],
            [5.0 + tol * (1.0 + 1e-9), 5.0],
            [f64::NAN, 0.0],
            [-f64::NAN, 0.0],
            [f64::INFINITY, 0.0],
            [f64::INFINITY, 0.0],
            [0.0, f64::NAN],
            [3.0, 4.0],
            [3.0 + 0.6 * tol, 4.0 + 0.8 * tol],
        ];
        assert_eq!(weld_labels(&edge).0, brute_force_labels(&edge));
        // Random clusters: points scattered within a few tol of a few centres, in random order.
        let mut state = 7u64;
        for case in 0..200 {
            let centres = 1 + (next(&mut state) % 4) as usize;
            let n = 2 + (next(&mut state) % 40) as usize;
            let points: Vec<P2> = (0..n)
                .map(|_| {
                    let c = (next(&mut state) % centres as u64) as f64;
                    let mut d = || ((next(&mut state) % 4001) as f64 - 2000.0) * 1e-3 * tol;
                    [c * 10.0 + d(), -c * 3.0 + d()]
                })
                .collect();
            assert_eq!(
                weld_labels(&points).0,
                brute_force_labels(&points),
                "case {case}: {points:?}"
            );
        }
    }

    #[test]
    fn an_adversarially_ordered_weld_chain_costs_linear_distance_evaluations() {
        // Review: a chain of ends 0.9 tol apart, listed so that the old relabelling needed a
        // pass per link (cubic overall). The sweep measures each end against its neighbours
        // in x only.
        let m = 4000;
        let mut points: Vec<P2> = Vec::with_capacity(2 * m);
        for k in 0..m {
            let t = if k == 0 { 0 } else { m - k };
            points.push([t as f64 * 0.9e-6, 0.0]);
            points.push([10.0 * (k + 1) as f64, 100.0]);
        }
        let (label, measured) = weld_labels(&points);
        assert!(
            measured <= 2 * points.len(),
            "{measured} distance evaluations"
        );
        for (i, &l) in label.iter().enumerate() {
            // Every chain end is welded to the first one (index 0); far ends stand alone.
            assert_eq!(l, if i % 2 == 0 { 0 } else { i }, "end {i}");
        }
    }

    #[test]
    fn joints_join_welds_and_coincident_constraints_transitively() {
        let c: Constraint = serde_json::from_value(serde_json::json!(
            { "id": "c", "type": "coincident", "a": "b.end", "b": "c.start" }
        ))
        .expect("constraint");
        let j = Joints::new(&[("b.start".into(), "a.end".into())], &[c]);
        assert!(j.same("a.end", "b.start"));
        assert!(j.same("c.start", "b.end"));
        assert!(!j.same("a.end", "c.start"));
        assert!(j.same("x.start", "x.start"), "an unnamed point is itself");
        assert!(!j.same("x.start", "a.end"));
    }

    #[test]
    #[allow(clippy::float_cmp)] // exact sentinel values
    fn a_nan_weld_or_dimension_violation_is_infinite_not_tiny() {
        // Review: `NaN.max(f64::MIN_POSITIVE)` is 2.2e-308, which would report an unmeasurable
        // weld violation as the smallest positive number.
        let stored = [
            line("a", [0.0, 0.0], [1.0, 0.0]),
            line("b", [1.0, 0.0], [1.0, 1.0]),
        ];
        let solved = [
            line("a", [0.0, 0.0], [f64::NAN, 0.0]),
            line("b", [1.0, 0.0], [1.0, 1.0]),
        ];
        let v = check_solution(&stored, &[], &[], &solved).expect_err("weld");
        assert!(
            matches!(v.subject, Subject::Weld { ref end, .. } if end == "b.start"),
            "{v:?}"
        );
        assert!(v.amount.is_infinite(), "{}", v.amount);
        assert_eq!(violation_amount(f64::NAN), f64::INFINITY);
        assert_eq!(violation_amount(0.0), f64::MIN_POSITIVE);
        assert_eq!(violation_amount(2.5), 2.5);
    }

    #[test]
    fn a_nan_natural_deviation_is_a_violation() {
        // Zero-length solved line b: the angle is 0/0 = NaN. Both measures report it.
        let stored = [
            line("a", [0.0, 0.0], [1.0, 0.0]),
            line("b", [0.0, 1.0], [1.0, 1.0]),
        ];
        let solved = [
            line("a", [0.0, 0.0], [1.0, 0.0]),
            line("b", [0.0, 1.0], [0.0, 1.0]),
        ];
        let v = check_solution(
            &stored,
            &[parallel()],
            &[ConstraintValues::default()],
            &solved,
        )
        .expect_err("NaN");
        assert!(v.amount.is_infinite(), "{}", v.amount);
    }
}
