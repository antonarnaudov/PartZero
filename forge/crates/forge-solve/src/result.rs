//! Solver options and machine-readable results (serde JSON both ways).

use serde::{Deserialize, Serialize};

use crate::analysis::RankMethod;

/// Solver options. Every tolerance is explicit and documented; defaults suit sketches
/// in millimetres up to a few metres.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SolveOptions {
    /// A constraint is satisfied when every one of its residuals is at most this (mm).
    pub tolerance: f64,
    /// Levenberg–Marquardt iteration limit per solve.
    pub max_iterations: usize,
    /// Relative rank tolerance on unit-length Jacobian rows: a pivot / singular value at
    /// most `rank_tolerance × largest` counts as zero.
    pub rank_tolerance: f64,
    /// Looser rank tolerance used only to *seed* conflict search at a least-squares point
    /// (the minimal conflicting set itself is verified by re-solving).
    pub conflict_rank_tolerance: f64,
    /// Absolute tolerance on an entity's share of the allowed motions (the singular values
    /// of its block of the orthonormal DOF basis lie in [0, 1]).
    pub dof_tolerance: f64,
    /// Rank-revealing factorization.
    pub rank_method: RankMethod,
    /// Maximum number of minimal conflicting sets reported per cluster.
    pub max_conflicts: usize,
    /// Relative weight that keeps a dragged point at the cursor (others weigh 1).
    pub drag_weight: f64,
    /// Iteration limit per drag frame.
    pub drag_max_iterations: usize,
}

impl Default for SolveOptions {
    fn default() -> Self {
        Self {
            tolerance: 1e-10,
            max_iterations: 200,
            rank_tolerance: 1e-8,
            conflict_rank_tolerance: 1e-6,
            dof_tolerance: 1e-7,
            rank_method: RankMethod::Qrcp,
            max_conflicts: 8,
            drag_weight: 1e6,
            drag_max_iterations: 50,
        }
    }
}

/// Overall or per-cluster outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SolveStatus {
    /// Solved; degrees of freedom remain; no redundant constraints.
    UnderConstrained,
    /// Solved; no degrees of freedom; no redundant constraints.
    FullyConstrained,
    /// Solved, but some constraints are implied by others (consistent redundancy). The
    /// sketch may still have degrees of freedom (see `dof`).
    OverConstrainedRedundant,
    /// Constraints contradict each other; see `conflicts`. The geometry of the affected
    /// clusters is returned unchanged.
    Conflict,
    /// The solver did not reach a solution and could not prove a conflict. The geometry
    /// of the affected clusters is returned unchanged.
    FailedToConverge,
}

impl SolveStatus {
    /// `true` when the geometry satisfies every driving constraint.
    pub fn is_solved(self) -> bool {
        matches!(
            self,
            SolveStatus::UnderConstrained
                | SolveStatus::FullyConstrained
                | SolveStatus::OverConstrainedRedundant
        )
    }
}

/// State of one constraint after solving.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintState {
    /// Enforced and satisfied, independent of the other constraints.
    Satisfied,
    /// Satisfied but implied by other constraints (all of its equations).
    Redundant,
    /// Satisfied; some (not all) of its equations are implied by other constraints.
    PartiallyRedundant,
    /// Member of a minimal conflicting set.
    Conflicting,
    /// Enforced but not satisfied (its cluster failed or is in conflict).
    Unsatisfied,
    /// A reference (driven) dimension: measured, not enforced.
    Reference,
}

/// Solved geometry of an entity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SolvedGeometry {
    /// A point.
    Point {
        /// x (mm).
        x: f64,
        /// y (mm).
        y: f64,
    },
    /// A line (its points carry the coordinates).
    Line {
        /// Length (mm).
        length: f64,
    },
    /// A circle.
    Circle {
        /// Radius (mm).
        radius: f64,
    },
    /// An arc.
    Arc {
        /// Radius (mm).
        radius: f64,
    },
}

/// Per-entity result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityReport {
    /// Entity id.
    pub id: String,
    /// Solved geometry.
    #[serde(flatten)]
    pub geometry: SolvedGeometry,
    /// Remaining degrees of freedom of this entity's shape and position (the rank of its
    /// parameters' share of the allowed motions): point 0–2, line 0–4, circle 0–3, arc 0–5.
    pub dof: usize,
    /// Points with exactly one DOF: the unit direction in which they can (infinitesimally)
    /// move.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_direction: Option<[f64; 2]>,
    /// Circles: the radius can still change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius_free: Option<bool>,
    /// Index of the cluster that owns most of its unknowns (`None` if it has none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster: Option<usize>,
}

/// Per-constraint result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConstraintReport {
    /// Constraint id.
    pub id: String,
    /// State.
    pub state: ConstraintState,
    /// Largest absolute residual of its equations at the returned geometry (mm); 0 for
    /// reference dimensions.
    pub residual: f64,
    /// Dimensions: the measured value at the returned geometry (mm or degrees).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured: Option<f64>,
}

/// A redundant constraint and what implies it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Redundancy {
    /// The redundant constraint (the most recent member of its dependency).
    pub constraint: String,
    /// Only some of its equations are implied.
    pub partial: bool,
    /// The earlier constraints that imply it.
    pub implied_by: Vec<String>,
    /// Arcs whose built-in rule takes part in the dependency.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub implied_by_arcs: Vec<String>,
    /// Human/agent-readable explanation.
    pub explanation: String,
}

/// A minimal set of mutually contradicting constraints.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    /// The constraints (sketch order). They cannot all hold near the input geometry
    /// (the solver stalls at a non-zero least-squares minimum); removing any single one
    /// makes the rest solvable (see `verified_minimal`).
    pub constraints: Vec<String>,
    /// The most recently added member: the default repair.
    pub suggested_removal: String,
    /// Every one-smaller subset was proven solvable from the input geometry (strict
    /// minimality). `false` when some subset test was undecided (iteration budget):
    /// the set is still proven contradictory, but might not be the smallest.
    pub verified_minimal: bool,
    /// Fixed entities (constants) the conflict leans on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fixed_entities: Vec<String>,
    /// Arcs whose built-in rule takes part.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arcs: Vec<String>,
    /// Human/agent-readable explanation.
    pub explanation: String,
}

/// Per-cluster summary (independent sub-systems solved separately).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClusterReport {
    /// Index (clusters are ordered by their first unknown).
    pub index: usize,
    /// Outcome.
    pub status: SolveStatus,
    /// Degrees of freedom.
    pub dof: usize,
    /// Unknowns.
    pub unknowns: usize,
    /// Scalar equations.
    pub equations: usize,
    /// Jacobian rank.
    pub rank: usize,
    /// LM iterations of the main solve.
    pub iterations: usize,
    /// Largest residual at the returned geometry.
    pub max_residual: f64,
    /// Smallest kept pivot relative to the largest (conditioning; small = nearly
    /// degenerate).
    pub conditioning: f64,
    /// The rank decision was close to the tolerance (a nearly singular configuration,
    /// e.g. almost-parallel lines meant to intersect): DOF and redundancy may flip under
    /// small changes.
    pub near_degenerate: bool,
    /// Entities with unknowns in this cluster.
    pub entities: Vec<String>,
    /// Constraints in this cluster.
    pub constraints: Vec<String>,
}

/// The result of [`crate::solve`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SolveResult {
    /// Overall status (worst over clusters: conflict > failed > redundant > under/fully).
    pub status: SolveStatus,
    /// Every driving constraint is satisfied by the returned geometry.
    pub ok: bool,
    /// Total remaining degrees of freedom.
    pub dof: usize,
    /// Largest residual over all driving constraints at the returned geometry.
    pub max_residual: f64,
    /// Total LM iterations (main solves only).
    pub iterations: usize,
    /// One-paragraph summary for humans and agents.
    pub explanation: String,
    /// Entities in sketch order.
    pub entities: Vec<EntityReport>,
    /// Constraints in sketch order.
    pub constraints: Vec<ConstraintReport>,
    /// Redundant constraints (consistent but implied).
    pub redundant: Vec<Redundancy>,
    /// Minimal conflicting sets.
    pub conflicts: Vec<Conflict>,
    /// Independent clusters.
    pub clusters: Vec<ClusterReport>,
}

/// The result of one drag frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DragResult {
    /// Constraints hold after the frame (otherwise the frame was rejected and the
    /// geometry left as it was).
    pub converged: bool,
    /// LM iterations.
    pub iterations: usize,
    /// Largest residual in the re-solved clusters.
    pub max_residual: f64,
    /// Distance from the dragged point to the cursor target (mm): 0 when the point can
    /// follow, positive when constraints hold it back.
    pub target_error: f64,
    /// Clusters that were re-solved.
    pub clusters: Vec<usize>,
    /// Points whose position changed, with their new coordinates.
    pub moved: Vec<MovedPoint>,
}

/// A point moved by a drag frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MovedPoint {
    /// Point id.
    pub id: String,
    /// New x.
    pub x: f64,
    /// New y.
    pub y: f64,
}
