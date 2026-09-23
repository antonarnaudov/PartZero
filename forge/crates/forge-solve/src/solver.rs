//! The stateful solver: decomposition into independent clusters, full solves with
//! diagnostics, and interactive drag frames that re-solve only the affected cluster.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::math;

use crate::analysis::{Analysis, Circuit, CircuitTolerances, analyze};
use crate::dense::block_rank;
use crate::error::SketchError;
use crate::explain;
use crate::model::{Geometry, Sketch};
use crate::problem::{LmSettings, Problem};
use crate::result::{
    ClusterReport, Conflict, ConstraintReport, ConstraintState, DragResult, EntityReport,
    MovedPoint, Redundancy, SolveOptions, SolveResult, SolveStatus, SolvedGeometry,
};
use crate::system::{Owner, Q, System, compile};

const NONE: u32 = u32::MAX;

/// Initial relative LM damping for full solves.
const LAMBDA0_SOLVE: f64 = 1e-6;
/// Initial relative LM damping for drag frames (warm start near a solution).
const LAMBDA0_DRAG: f64 = 1e-9;
/// A rank decision is reported as near-degenerate (`ClusterReport::near_degenerate`)
/// when the smallest kept pivot is less than this factor above `rank_tolerance`, or the
/// largest dropped pivot more than `rank_tolerance` / this factor: within three decades
/// of the threshold, a small change of the geometry could flip the rank.
const NEAR_DEGENERATE_MARGIN: f64 = 1e3;
/// An inconsistent circuit seeds the conflict search when its irreducible residual
/// `|yᵀ F_s|` exceeds this × `tolerance` × `max(1, Σ|y_j|)`: a decade above what the
/// residuals of a solved sketch (each at most `tolerance`) can add up to.
const CONFLICT_RESIDUAL_FACTOR: f64 = 10.0;

/// One independent sub-system.
#[derive(Clone, Debug)]
struct Cluster {
    problem: Problem,
    /// Constraints with at least one equation in this cluster (ascending).
    constraints: Vec<usize>,
    /// Arc-rule equations of this cluster (global indices, ascending).
    arc_rules: Vec<usize>,
}

/// What happened to one cluster in a full solve.
#[derive(Clone, Debug)]
struct ClusterOutcome {
    status: SolveStatus,
    iterations: usize,
    /// Analysis whose null space describes the returned DOF (columns = cluster columns).
    analysis: Analysis,
    /// Consistent dependencies (redundancies).
    redundant: Vec<Circuit>,
    /// Minimal conflicting sets (constraint indices, ascending) and whether every
    /// one-smaller subset was proven solvable.
    conflicts: Vec<(Vec<usize>, bool)>,
}

/// Outcome of a consistency test (LM from the input geometry).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    /// Converged: the constraints hold simultaneously.
    Consistent,
    /// Stalled at a least-squares minimum with a non-zero residual: no solution near the
    /// input geometry (a conflict, possibly only avoidable by degenerating an entity).
    Inconsistent,
    /// Iteration budget exhausted while still descending: undecided.
    Unknown,
}

impl Verdict {
    fn of(o: &crate::problem::LmOutcome) -> Self {
        if o.converged {
            Verdict::Consistent
        } else if o.stalled {
            Verdict::Inconsistent
        } else {
            Verdict::Unknown
        }
    }
}

/// A compiled sketch with its current geometry.
///
/// ```
/// use forge_solve::{Entity, Constraint, Sketch, SolveOptions, Solver, c};
/// let sketch = Sketch {
///     entities: vec![Entity::point("a", 0.0, 0.0), Entity::point("b", 9.0, 1.0),
///                    Entity::line("ab", "a", "b")],
///     constraints: vec![Constraint::new("h", c::horizontal("ab")),
///                       Constraint::new("d", c::distance("a", "b", 10.0))],
/// };
/// let mut solver = Solver::new(&sketch, &SolveOptions::default()).unwrap();
/// let result = solver.solve();
/// assert_eq!(result.dof, 2);
/// let frame = solver.drag("b", [20.0, 5.0]).unwrap();
/// assert!(frame.converged);
/// ```
#[derive(Clone, Debug)]
pub struct Solver {
    sketch: Sketch,
    sys: System,
    values: Vec<f64>,
    options: SolveOptions,
    clusters: Vec<Cluster>,
    /// Cluster of every quantity (`NONE` for constants and unconstrained unknowns).
    q_cluster: Vec<u32>,
    /// Cluster of every equation (`NONE` for equations without unknowns).
    eq_cluster: Vec<u32>,
    /// Equations without unknowns (they only involve fixed geometry).
    constant_eqs: Vec<usize>,
}

fn find(parent: &mut [u32], mut a: u32) -> u32 {
    while parent[a as usize] != a {
        let p = parent[a as usize];
        parent[a as usize] = parent[p as usize];
        a = parent[a as usize];
    }
    a
}

impl Solver {
    /// Validate `options` ([`SolveOptions::validate`]) and `sketch`, compile it, and
    /// decompose it into independent clusters.
    pub fn new(sketch: &Sketch, options: &SolveOptions) -> Result<Self, SketchError> {
        options.validate()?;
        let sys = compile(sketch)?;
        let nq = sys.nq();
        // Union–find over unknown quantities connected by an equation.
        let mut parent: Vec<u32> = (0..nq as u32).collect();
        let mut in_eq = vec![false; nq];
        let mut constant_eqs = Vec::new();
        for (e, eq) in sys.equations.iter().enumerate() {
            let mut first: Option<u32> = None;
            for &q in &eq.vars {
                if !sys.unknown[q as usize] {
                    continue;
                }
                in_eq[q as usize] = true;
                match first {
                    None => first = Some(q),
                    Some(f) => {
                        let (ra, rb) = (find(&mut parent, f), find(&mut parent, q));
                        if ra != rb {
                            let (lo, hi) = (ra.min(rb), ra.max(rb));
                            parent[hi as usize] = lo;
                        }
                    }
                }
            }
            if first.is_none() {
                constant_eqs.push(e);
            }
        }
        // Clusters numbered by their smallest quantity.
        let mut root_cluster: BTreeMap<u32, u32> = BTreeMap::new();
        let mut q_cluster = vec![NONE; nq];
        for q in 0..nq {
            if in_eq[q] {
                let r = find(&mut parent, q as u32);
                let next = root_cluster.len() as u32;
                q_cluster[q] = *root_cluster.entry(r).or_insert(next);
            }
        }
        let nc = root_cluster.len();
        let mut eqs_of: Vec<Vec<usize>> = vec![Vec::new(); nc];
        let mut eq_cluster = vec![NONE; sys.equations.len()];
        for (e, eq) in sys.equations.iter().enumerate() {
            if let Some(&q) = eq.vars.iter().find(|&&q| sys.unknown[q as usize]) {
                let c = q_cluster[q as usize];
                eq_cluster[e] = c;
                eqs_of[c as usize].push(e);
            }
        }
        let clusters = eqs_of
            .into_iter()
            .map(|eqs| {
                let mut constraints = BTreeSet::new();
                let mut arc_rules = Vec::new();
                for &e in &eqs {
                    match sys.equations[e].owner {
                        Owner::Constraint(ci) => {
                            constraints.insert(ci);
                        }
                        Owner::ArcRule(_) => arc_rules.push(e),
                    }
                }
                Cluster {
                    problem: Problem::new(&sys, eqs),
                    constraints: constraints.into_iter().collect(),
                    arc_rules,
                }
            })
            .collect();
        Ok(Self {
            sketch: sketch.clone(),
            values: sys.values0.clone(),
            sys,
            options: options.clone(),
            clusters,
            q_cluster,
            eq_cluster,
            constant_eqs,
        })
    }

    /// Number of independent clusters.
    pub fn cluster_count(&self) -> usize {
        self.clusters.len()
    }

    /// The options in use.
    pub fn options(&self) -> &SolveOptions {
        &self.options
    }

    /// Current coordinates of a point.
    pub fn point(&self, id: &str) -> Option<[f64; 2]> {
        let i = *self.sys.entity_index.get(id)?;
        let p = self.sys.entities[i].point?;
        Some([self.values[p.x as usize], self.values[p.y as usize]])
    }

    /// The sketch with the current geometry (coordinates and radii updated).
    pub fn sketch(&self) -> Sketch {
        let mut s = self.sketch.clone();
        for (i, e) in s.entities.iter_mut().enumerate() {
            let info = &self.sys.entities[i];
            match &mut e.geometry {
                Geometry::Point { x, y } => {
                    let p = info.point.expect("point quantities");
                    *x = self.values[p.x as usize];
                    *y = self.values[p.y as usize];
                }
                Geometry::Circle { radius, .. } => {
                    *radius = self.values[info.radius.expect("radius quantity") as usize];
                }
                Geometry::Line { .. } | Geometry::Arc { .. } => {}
            }
        }
        s
    }

    fn lm(&self, max_iter: usize, lambda0: f64) -> LmSettings {
        LmSettings {
            tol: self.options.tolerance,
            max_iter,
            lambda0,
        }
    }

    /// Solve every cluster from the current geometry and compute the diagnostics.
    pub fn solve(&mut self) -> SolveResult {
        let x_start = self.values.clone();
        let mut x = self.values.clone();
        let mut outcomes = Vec::with_capacity(self.clusters.len());
        for ci in 0..self.clusters.len() {
            outcomes.push(self.solve_cluster(ci, &mut x, &x_start));
        }
        self.values = x;
        self.build_result(&outcomes)
    }

    fn solve_cluster(&mut self, ci: usize, x: &mut [f64], x_start: &[f64]) -> ClusterOutcome {
        let lm = self.lm(self.options.max_iterations, LAMBDA0_SOLVE);
        let (rank_tol, method) = (self.options.rank_tolerance, self.options.rank_method);
        let ct = CircuitTolerances::of(&self.options);
        let ones = vec![1.0; self.clusters[ci].problem.n()];
        let out = self.clusters[ci].problem.solve(&self.sys, x, &ones, &lm);
        if out.converged {
            let analysis = analyze(
                &self.sys,
                &self.clusters[ci].problem,
                x,
                rank_tol,
                method,
                ct,
            );
            let status = if !analysis.circuits.is_empty() {
                SolveStatus::OverConstrainedRedundant
            } else if analysis.dof() == 0 {
                SolveStatus::FullyConstrained
            } else {
                SolveStatus::UnderConstrained
            };
            let redundant = analysis.circuits.clone();
            return ClusterOutcome {
                status,
                iterations: out.iterations,
                analysis,
                redundant,
                conflicts: Vec::new(),
            };
        }

        // Not solved: look for minimal conflicting sets, starting from the input geometry.
        // A conflict is only claimed when the main solve *stalled* (a least-squares
        // minimum with a non-zero residual), not when it merely ran out of iterations.
        let x_ls = x.to_vec();
        let cols = self.clusters[ci].problem.cols.clone();
        for &q in &cols {
            x[q as usize] = x_start[q as usize];
        }
        let loose = self.options.conflict_rank_tolerance.max(rank_tol);
        let an_ls = analyze(
            &self.sys,
            &self.clusters[ci].problem,
            &x_ls,
            loose,
            method,
            ct,
        );
        let mut seed = self.conflicting_constraints(&an_ls);
        let all: Vec<usize> = self.clusters[ci].constraints.clone();
        let mut removed: BTreeSet<usize> = BTreeSet::new();
        let mut conflicts: Vec<(Vec<usize>, bool)> = Vec::new();
        let mut repaired: Option<(Problem, Vec<f64>)> = None;
        let mut candidates_inconsistent = Verdict::of(&out) == Verdict::Inconsistent;
        while conflicts.len() < self.options.max_conflicts {
            let candidates: Vec<usize> = all
                .iter()
                .copied()
                .filter(|c| !removed.contains(c))
                .collect();
            let Some((mcs, verified)) =
                self.deletion_filter(ci, &candidates, &seed, candidates_inconsistent, x_start)
            else {
                break;
            };
            removed.insert(*mcs.last().expect("non-empty conflict"));
            conflicts.push((mcs, verified));
            let remaining: Vec<usize> = all
                .iter()
                .copied()
                .filter(|c| !removed.contains(c))
                .collect();
            let mut p = self.subproblem(ci, &remaining, true);
            let mut xr = x_start.to_vec();
            let o = p.solve(&self.sys, &mut xr, &vec![1.0; p.n()], &lm);
            if o.converged {
                repaired = Some((p, xr));
                break;
            }
            candidates_inconsistent = Verdict::of(&o) == Verdict::Inconsistent;
            let an = analyze(&self.sys, &p, &xr, loose, method, ct);
            seed = self.conflicting_constraints(&an);
        }
        if conflicts.is_empty() {
            let analysis = analyze(
                &self.sys,
                &self.clusters[ci].problem,
                &x_ls,
                rank_tol,
                method,
                ct,
            );
            return ClusterOutcome {
                status: SolveStatus::FailedToConverge,
                iterations: out.iterations,
                analysis,
                redundant: Vec::new(),
                conflicts,
            };
        }
        let (analysis, redundant) = match repaired {
            Some((p, xr)) => {
                let an = analyze(&self.sys, &p, &xr, rank_tol, method, ct);
                let red = an.circuits.clone();
                (an, red)
            }
            None => (
                analyze(
                    &self.sys,
                    &self.clusters[ci].problem,
                    &x_ls,
                    rank_tol,
                    method,
                    ct,
                ),
                Vec::new(),
            ),
        };
        ClusterOutcome {
            status: SolveStatus::Conflict,
            iterations: out.iterations,
            analysis,
            redundant,
            conflicts,
        }
    }

    /// Constraints owning an equation of an inconsistent circuit.
    fn conflicting_constraints(&self, an: &Analysis) -> Vec<usize> {
        let tol = self.options.tolerance;
        let mut set = BTreeSet::new();
        for c in &an.circuits {
            if c.inconsistency > CONFLICT_RESIDUAL_FACTOR * tol * c.weight.max(1.0) {
                for &e in &c.support {
                    if let Owner::Constraint(k) = self.sys.equations[e].owner {
                        set.insert(k);
                    }
                }
            }
        }
        set.into_iter().collect()
    }

    /// The sub-system of cluster `ci` made of its arc rules and the equations (in this
    /// cluster) of `constraints`. With `all_cols`, the columns are the cluster's.
    fn subproblem(&self, ci: usize, constraints: &[usize], all_cols: bool) -> Problem {
        let cl = &self.clusters[ci];
        let mut eqs = cl.arc_rules.clone();
        for &c in constraints {
            for e in self.sys.constraint_eqs[c].clone() {
                if self.eq_cluster[e] == ci as u32 {
                    eqs.push(e);
                }
            }
        }
        eqs.sort_unstable();
        if all_cols {
            Problem::with_cols(&self.sys, eqs, cl.problem.cols.clone())
        } else {
            Problem::new(&self.sys, eqs)
        }
    }

    /// Consistency verdict for `constraints` (plus the cluster's arc rules), solving from
    /// `x_start`.
    fn verdict(&self, ci: usize, constraints: &[usize], x_start: &[f64]) -> Verdict {
        let lm = self.lm(self.options.max_iterations, LAMBDA0_SOLVE);
        let mut p = self.subproblem(ci, constraints, false);
        let mut x = x_start.to_vec();
        Verdict::of(&p.solve(&self.sys, &mut x, &vec![1.0; p.n()], &lm))
    }

    /// Deletion filter: shrink a provably inconsistent set of constraints to a minimal one.
    ///
    /// Starts from the `seed` (constraints of the inconsistent dependencies found by rank
    /// analysis) when it is itself proven inconsistent, else from all `candidates` when
    /// those are (`candidates_inconsistent`). A member is dropped only when the set without
    /// it is *proven* inconsistent, so the result is always proven inconsistent. Returns
    /// the set and whether every one-smaller subset was proven solvable (true
    /// minimality); `None` when no inconsistency can be proven.
    fn deletion_filter(
        &self,
        ci: usize,
        candidates: &[usize],
        seed: &[usize],
        candidates_inconsistent: bool,
        x_start: &[f64],
    ) -> Option<(Vec<usize>, bool)> {
        let seed: Vec<usize> = seed
            .iter()
            .copied()
            .filter(|c| candidates.binary_search(c).is_ok())
            .collect();
        let mut s: Vec<usize> = if !seed.is_empty()
            && seed.len() < candidates.len()
            && self.verdict(ci, &seed, x_start) == Verdict::Inconsistent
        {
            seed
        } else if candidates_inconsistent {
            candidates.to_vec()
        } else {
            return None;
        };
        let mut verified = true;
        for c in s.clone() {
            let t: Vec<usize> = s.iter().copied().filter(|&d| d != c).collect();
            match self.verdict(ci, &t, x_start) {
                Verdict::Inconsistent => s = t,
                Verdict::Consistent => {}
                Verdict::Unknown => verified = false,
            }
        }
        (!s.is_empty()).then_some((s, verified))
    }

    /// One interactive drag frame: move `point` towards `target` and re-solve only the
    /// clusters that contain it, moving everything else as little as possible. If the
    /// constraints cannot be satisfied the frame is rejected and nothing moves.
    pub fn drag(&mut self, point: &str, target: [f64; 2]) -> Result<DragResult, SketchError> {
        let invalid = |reason: &'static str| SketchError::InvalidDrag {
            id: point.to_owned(),
            reason,
        };
        let &idx = self
            .sys
            .entity_index
            .get(point)
            .ok_or_else(|| invalid("no such entity"))?;
        let p = self.sys.entities[idx]
            .point
            .ok_or_else(|| invalid("not a point"))?;
        if !(target[0].is_finite() && target[1].is_finite()) {
            return Err(invalid("non-finite target"));
        }
        let unknown = [p.x, p.y].map(|q| self.sys.unknown[q as usize]);
        if !unknown[0] && !unknown[1] {
            return Err(invalid("point is fixed"));
        }
        let prev = self.values.clone();
        for (k, q) in [p.x, p.y].into_iter().enumerate() {
            if unknown[k] {
                self.values[q as usize] = target[k];
            }
        }
        let mut clusters: Vec<usize> = [p.x, p.y]
            .into_iter()
            .map(|q| self.q_cluster[q as usize])
            .filter(|&c| c != NONE)
            .map(|c| c as usize)
            .collect();
        clusters.sort_unstable();
        clusters.dedup();
        let lm = self.lm(self.options.drag_max_iterations, LAMBDA0_DRAG);
        let w_drag = 1.0 / self.options.drag_weight;
        let (mut converged, mut iterations, mut max_residual) = (true, 0usize, 0.0f64);
        for &ci in &clusters {
            let prob = &mut self.clusters[ci].problem;
            let mut w_inv = vec![1.0; prob.n()];
            for q in [p.x, p.y] {
                if let Ok(c) = prob.cols.binary_search(&q) {
                    w_inv[c] = w_drag;
                }
            }
            let out = prob.solve(&self.sys, &mut self.values, &w_inv, &lm);
            iterations += out.iterations;
            max_residual = max_residual.max(out.max_residual);
            converged &= out.converged;
        }
        if !converged {
            self.values = prev.clone();
        }
        let mut moved = Vec::new();
        for (i, e) in self.sketch.entities.iter().enumerate() {
            if let Some(pp) = self.sys.entities[i].point {
                let (x, y) = (self.values[pp.x as usize], self.values[pp.y as usize]);
                if x.to_bits() != prev[pp.x as usize].to_bits()
                    || y.to_bits() != prev[pp.y as usize].to_bits()
                {
                    moved.push(MovedPoint {
                        id: e.id.clone(),
                        x,
                        y,
                    });
                }
            }
        }
        let (px, py) = (self.values[p.x as usize], self.values[p.y as usize]);
        Ok(DragResult {
            converged,
            iterations,
            max_residual,
            target_error: math::hypot(px - target[0], py - target[1]),
            clusters,
            moved,
        })
    }

    // ----- result assembly -----------------------------------------------------------

    fn build_result(&self, outcomes: &[ClusterOutcome]) -> SolveResult {
        let sys = &self.sys;
        let tol = self.options.tolerance;
        let x = &self.values;
        let nconstr = self.sketch.constraints.len();

        // Conflicts: per-cluster minimal sets plus constant equations that fail.
        let mut conflict_sets: Vec<(Vec<usize>, bool)> = Vec::new();
        for o in outcomes {
            conflict_sets.extend(o.conflicts.iter().cloned());
        }
        let mut const_redundant: Vec<usize> = Vec::new();
        for &e in &self.constant_eqs {
            if let Owner::Constraint(c) = sys.equations[e].owner {
                if sys.residual(e, x).abs() <= tol {
                    const_redundant.push(c);
                } else if !conflict_sets.iter().any(|(s, _)| s == &vec![c]) {
                    conflict_sets.push((vec![c], true));
                }
            }
        }
        let in_conflict: BTreeSet<usize> = conflict_sets
            .iter()
            .flat_map(|(s, _)| s.iter().copied())
            .collect();

        // Redundancies: pivot equations of consistent circuits, grouped by constraint.
        let mut pivots: BTreeMap<usize, (usize, BTreeSet<usize>, BTreeSet<usize>)> =
            BTreeMap::new();
        for o in outcomes {
            for circ in &o.redundant {
                let Owner::Constraint(c) = sys.equations[circ.pivot].owner else {
                    continue;
                };
                if in_conflict.contains(&c) {
                    continue;
                }
                let entry = pivots.entry(c).or_default();
                entry.0 += 1;
                for &e in &circ.support {
                    match sys.equations[e].owner {
                        Owner::Constraint(k) if k != c => {
                            entry.1.insert(k);
                        }
                        Owner::ArcRule(a) => {
                            entry.2.insert(a);
                        }
                        _ => {}
                    }
                }
            }
        }
        for &c in &const_redundant {
            pivots.entry(c).or_default().0 += 1;
        }

        // Constraint reports.
        let mut constraints = Vec::with_capacity(nconstr);
        let mut max_residual = 0.0f64;
        for (ci, con) in self.sketch.constraints.iter().enumerate() {
            let range = sys.constraint_eqs[ci].clone();
            let neq = range.len();
            let residual = range
                .clone()
                .map(|e| sys.residual(e, x).abs())
                .fold(0.0f64, f64::max);
            if con.driving {
                max_residual = max_residual.max(residual);
            }
            let measured = sys.measures[ci].map(|m| m.eval(x));
            let state = if !con.driving {
                ConstraintState::Reference
            } else if in_conflict.contains(&ci) {
                ConstraintState::Conflicting
            } else if let Some(&(np, _, _)) = pivots.get(&ci) {
                if np >= neq {
                    ConstraintState::Redundant
                } else {
                    ConstraintState::PartiallyRedundant
                }
            } else if residual <= tol {
                ConstraintState::Satisfied
            } else {
                ConstraintState::Unsatisfied
            };
            constraints.push(ConstraintReport {
                id: con.id.clone(),
                state,
                residual: if con.driving { residual } else { 0.0 },
                measured,
            });
        }

        let redundant: Vec<Redundancy> = pivots
            .iter()
            .map(|(&c, (np, by, arcs))| {
                let partial = *np < sys.constraint_eqs[c].len();
                let implied_by: Vec<String> = by
                    .iter()
                    .map(|&k| self.sketch.constraints[k].id.clone())
                    .collect();
                let arcs: Vec<String> = arcs
                    .iter()
                    .map(|&a| self.sketch.entities[a].id.clone())
                    .collect();
                let explanation = explain::redundancy(
                    &self.sketch,
                    c,
                    partial,
                    by,
                    &arcs,
                    const_redundant.contains(&c),
                );
                Redundancy {
                    constraint: self.sketch.constraints[c].id.clone(),
                    partial,
                    implied_by,
                    implied_by_arcs: arcs,
                    explanation,
                }
            })
            .collect();

        let conflicts: Vec<Conflict> = conflict_sets
            .iter()
            .map(|(set, verified)| self.conflict_report(set, *verified))
            .collect();

        // Entity DOF from the per-cluster null spaces (direct sum) plus free unknowns.
        let entities = self.entity_reports(outcomes);

        let free_unknowns = (0..sys.nq())
            .filter(|&q| sys.unknown[q] && self.q_cluster[q] == NONE)
            .count();
        let dof = outcomes.iter().map(|o| o.analysis.dof()).sum::<usize>() + free_unknowns;

        let clusters: Vec<ClusterReport> = outcomes
            .iter()
            .enumerate()
            .map(|(i, o)| self.cluster_report(i, o, x))
            .collect();

        let mut status = outcomes
            .iter()
            .map(|o| o.status)
            .max()
            .unwrap_or(SolveStatus::UnderConstrained);
        if !conflicts.is_empty() {
            status = SolveStatus::Conflict;
        } else if status < SolveStatus::OverConstrainedRedundant {
            status = if !redundant.is_empty() {
                SolveStatus::OverConstrainedRedundant
            } else if dof == 0 {
                SolveStatus::FullyConstrained
            } else {
                SolveStatus::UnderConstrained
            };
        }
        let ok = status.is_solved() && max_residual <= tol;
        let iterations = outcomes.iter().map(|o| o.iterations).sum();
        let explanation =
            explain::summary(status, dof, &entities, &redundant, &conflicts, max_residual);
        SolveResult {
            status,
            ok,
            dof,
            max_residual,
            iterations,
            explanation,
            entities,
            constraints,
            redundant,
            conflicts,
            clusters,
        }
    }

    fn conflict_report(&self, set: &[usize], verified_minimal: bool) -> Conflict {
        let sys = &self.sys;
        let mut fixed = BTreeSet::new();
        let mut arcs = BTreeSet::new();
        for &c in set {
            for r in self.sketch.constraints[c].kind.references() {
                if let Some(&ei) = sys.entity_index.get(r) {
                    // Any referenced entity with a constant quantity is "fixed geometry".
                    if sys.entities[ei]
                        .block
                        .iter()
                        .any(|&q| !sys.unknown[q as usize])
                    {
                        fixed.insert(ei);
                    }
                    if matches!(self.sketch.entities[ei].geometry, Geometry::Arc { .. }) {
                        arcs.insert(ei);
                    }
                }
            }
        }
        let fixed: Vec<String> = fixed
            .iter()
            .map(|&e| self.sketch.entities[e].id.clone())
            .collect();
        let arcs: Vec<String> = arcs
            .iter()
            .map(|&e| self.sketch.entities[e].id.clone())
            .collect();
        let suggested = *set.last().expect("non-empty conflict");
        Conflict {
            constraints: set
                .iter()
                .map(|&c| self.sketch.constraints[c].id.clone())
                .collect(),
            suggested_removal: self.sketch.constraints[suggested].id.clone(),
            explanation: explain::conflict(&self.sketch, set, &fixed),
            verified_minimal,
            fixed_entities: fixed,
            arcs,
        }
    }

    fn cluster_report(&self, index: usize, o: &ClusterOutcome, x: &[f64]) -> ClusterReport {
        let cl = &self.clusters[index];
        let entities: Vec<String> = self
            .sys
            .entities
            .iter()
            .enumerate()
            .filter(|(_, info)| {
                info.block
                    .iter()
                    .any(|&q| self.q_cluster[q as usize] == index as u32)
            })
            .map(|(i, _)| self.sketch.entities[i].id.clone())
            .collect();
        let max_residual = cl
            .problem
            .eqs
            .iter()
            .map(|&e| self.sys.residual(e, x).abs())
            .fold(0.0f64, f64::max);
        ClusterReport {
            index,
            status: o.status,
            dof: o.analysis.dof(),
            unknowns: cl.problem.n(),
            equations: cl.problem.m(),
            rank: o.analysis.rank,
            iterations: o.iterations,
            max_residual,
            conditioning: o.analysis.kept_ratio,
            near_degenerate: o.analysis.kept_ratio
                < NEAR_DEGENERATE_MARGIN * self.options.rank_tolerance
                || o.analysis.dropped_ratio
                    > (1.0 / NEAR_DEGENERATE_MARGIN) * self.options.rank_tolerance,
            entities,
            constraints: cl
                .constraints
                .iter()
                .map(|&c| self.sketch.constraints[c].id.clone())
                .collect(),
        }
    }

    fn entity_reports(&self, outcomes: &[ClusterOutcome]) -> Vec<EntityReport> {
        let sys = &self.sys;
        let x = &self.values;
        let tol = self.options.dof_tolerance;
        let mut out = Vec::with_capacity(self.sketch.entities.len());
        for (i, e) in self.sketch.entities.iter().enumerate() {
            let info = &sys.entities[i];
            let unknowns: Vec<Q> = info
                .block
                .iter()
                .copied()
                .filter(|&q| sys.unknown[q as usize])
                .collect();
            // Column layout: each touched cluster's null basis, then one column per free
            // unknown.
            let mut touched: Vec<u32> = unknowns
                .iter()
                .map(|&q| self.q_cluster[q as usize])
                .filter(|&c| c != NONE)
                .collect();
            touched.sort_unstable();
            touched.dedup();
            let free: Vec<Q> = unknowns
                .iter()
                .copied()
                .filter(|&q| self.q_cluster[q as usize] == NONE)
                .collect();
            let mut offsets = Vec::with_capacity(touched.len());
            let mut width = 0usize;
            for &c in &touched {
                offsets.push(width);
                width += outcomes[c as usize].analysis.right_null.cols;
            }
            let free_off = width;
            width += free.len();
            let rows: Vec<Vec<f64>> = unknowns
                .iter()
                .map(|&q| {
                    let mut row = vec![0.0; width];
                    let c = self.q_cluster[q as usize];
                    if c == NONE {
                        let k = free.iter().position(|&f| f == q).expect("free unknown");
                        row[free_off + k] = 1.0;
                    } else {
                        let t = touched.iter().position(|&tc| tc == c).expect("touched");
                        let an = &outcomes[c as usize].analysis;
                        let local = self.clusters[c as usize]
                            .problem
                            .cols
                            .binary_search(&q)
                            .expect("cluster column");
                        for k in 0..an.right_null.cols {
                            row[offsets[t] + k] = an.right_null.get(local, k);
                        }
                    }
                    row
                })
                .collect();
            let row_refs: Vec<&[f64]> = rows.iter().map(|r| r.as_slice()).collect();
            let (dof, dir) = block_rank(&row_refs, tol);
            let is_point = info.point.is_some();
            let radius_free = info.radius.map(|r| {
                sys.unknown[r as usize]
                    && unknowns
                        .iter()
                        .position(|&q| q == r)
                        .is_some_and(|k| rows[k].iter().map(|v| v * v).sum::<f64>().sqrt() > tol)
            });
            let geometry = match &e.geometry {
                Geometry::Point { .. } => {
                    let p = info.point.expect("point");
                    SolvedGeometry::Point {
                        x: x[p.x as usize],
                        y: x[p.y as usize],
                    }
                }
                Geometry::Line { .. } => SolvedGeometry::Line {
                    length: self.line_length(i),
                },
                Geometry::Circle { .. } => SolvedGeometry::Circle {
                    radius: x[info.radius.expect("radius") as usize],
                },
                Geometry::Arc { center, start, .. } => {
                    let c = self.point(center).expect("center");
                    let s = self.point(start).expect("start");
                    SolvedGeometry::Arc {
                        radius: math::hypot(s[0] - c[0], s[1] - c[1]),
                    }
                }
            };
            let cluster = unknowns
                .iter()
                .map(|&q| self.q_cluster[q as usize])
                .filter(|&c| c != NONE)
                .min()
                .map(|c| c as usize);
            out.push(EntityReport {
                id: e.id.clone(),
                geometry,
                dof,
                free_direction: if is_point && dof == 1 { dir } else { None },
                radius_free,
                cluster,
            });
        }
        out
    }

    fn line_length(&self, i: usize) -> f64 {
        let Geometry::Line { p1, p2 } = &self.sketch.entities[i].geometry else {
            return 0.0;
        };
        let a = self.point(p1).expect("p1");
        let b = self.point(p2).expect("p2");
        math::hypot(b[0] - a[0], b[1] - a[1])
    }

    /// Number of scalar parameters and how many of them are unknowns (not fixed).
    pub fn parameter_count(&self) -> (usize, usize) {
        let unknowns = self.sys.unknown.iter().filter(|&&u| u).count();
        (self.sys.nq(), unknowns)
    }

    /// The cluster owning each of entity `id`'s own quantities — a point's `[x, y]`, a
    /// circle's `[radius]`, nothing for lines and arcs (their shape is their points') — as
    /// the [`crate::ClusterReport::index`] of the solve's clusters; `None` for a fixed
    /// quantity or an unknown no equation touches. `None` for an unknown id.
    ///
    /// Read-only diagnostics: an entity listed under several clusters (a point whose `x` is
    /// in one and `y` in another) is split here quantity by quantity.
    pub fn quantity_clusters(&self, id: &str) -> Option<Vec<Option<usize>>> {
        let info = &self.sys.entities[*self.sys.entity_index.get(id)?];
        let own: Vec<Q> = match (info.point, info.radius) {
            (Some(p), _) => vec![p.x, p.y],
            (None, Some(r)) => vec![r],
            (None, None) => Vec::new(),
        };
        Some(
            own.into_iter()
                .map(|q| {
                    let c = self.q_cluster[q as usize];
                    (c != NONE).then_some(c as usize)
                })
                .collect(),
        )
    }

    /// The largest `|residual|` over the equations of cluster `index` (a
    /// [`crate::ClusterReport::index`]) at the current geometry — after [`Solver::solve`], the
    /// geometry it returned, where [`crate::ClusterReport::max_residual`] is measured. The
    /// same value as that field, except that a residual that is not a number (NaN) makes the
    /// result NaN instead of being skipped by the maximum. `None` for an unknown index.
    ///
    /// Read-only diagnostics for callers that must not report an unmeasurable residual as a
    /// small number.
    pub fn cluster_max_residual(&self, index: usize) -> Option<f64> {
        let cl = self.clusters.get(index)?;
        let mut m = 0.0f64;
        for &e in &cl.problem.eqs {
            let r = self.sys.residual(e, &self.values).abs();
            if r.is_nan() {
                return Some(f64::NAN);
            }
            m = m.max(r);
        }
        Some(m)
    }
}
