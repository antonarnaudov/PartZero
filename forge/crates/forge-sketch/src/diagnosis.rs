//! The solver's verdict on a constrained sketch, in IR terms (SPEC-v1 §4.3, §4.4).

use forge_ir::v1::metrics::SolveStatus as IrSolveStatus;
use forge_solve::{SolveResult, SolveStatus};

/// A group of curve ends that coincide within *tol* in the stored geometry and are welded
/// into one solver point (SPEC-v1 §4.3): the representative is the first member in curve
/// order (`start` before `end`); the other members are aliases of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeldGroup {
    /// The representative end (`<curve>.start` / `<curve>.end`): the solver point's id.
    pub representative: String,
    /// Every member, representative first, in curve order.
    pub members: Vec<String>,
}

/// A minimal set of mutually contradicting constraints (IR constraint ids).
#[derive(Debug, Clone, PartialEq)]
pub struct ConflictSet {
    /// The constraints, in sketch order.
    pub constraints: Vec<String>,
    /// The default repair: the most recently added member.
    pub suggested_removal: String,
    /// Every one-smaller subset was proven solvable.
    pub verified_minimal: bool,
    /// Why (from forge-solve, or the welding rule).
    pub explanation: String,
}

/// A redundant constraint and what implies it.
#[derive(Debug, Clone, PartialEq)]
pub struct RedundantConstraint {
    /// The redundant constraint.
    pub constraint: String,
    /// Only some of its equations are implied.
    pub partial: bool,
    /// The earlier constraints that imply it (empty when welding alone implies it).
    pub implied_by: Vec<String>,
    /// Why.
    pub explanation: String,
}

/// A cluster that did not converge.
#[derive(Debug, Clone, PartialEq)]
pub struct FailedCluster {
    /// Solver entity ids (IR curve ids and derived point ids; welded ends by their
    /// representative).
    pub entities: Vec<String>,
    /// IR constraint ids.
    pub constraints: Vec<String>,
}

/// Everything forge-solve said about a constrained sketch, lifted to IR ids and merged with
/// the diagnoses the lowering decides itself (constraints between welded ends, SPEC-v1 §4.3
/// [W0-9]).
#[derive(Debug, Clone, PartialEq)]
pub struct SolveDiagnosis {
    /// The combined status: forge-solve's, raised to `conflict` by a driving distance between
    /// welded ends and to `over_constrained_redundant` by a constraint welding already implies.
    pub status: SolveStatus,
    /// Remaining degrees of freedom.
    pub dof: usize,
    /// Every redundant constraint (forge-solve's and the welded ones), in constraint order.
    pub redundant: Vec<RedundantConstraint>,
    /// Every minimal conflicting set (forge-solve's, then the welded ones).
    pub conflicts: Vec<ConflictSet>,
    /// The weld groups (groups of two or more ends), in curve order of their representative.
    pub welds: Vec<WeldGroup>,
    /// The forge-solve input the IR sketch was lowered to: the **welded stored guess**. On a
    /// failed sketch this is the stale geometry of SPEC-v1 §4.4 rule 6 — display only (greyed
    /// out), never input to a later feature.
    pub solver_input: forge_solve::Sketch,
    /// forge-solve's raw result on [`SolveDiagnosis::solver_input`].
    pub solver: SolveResult,
}

/// forge-solve's status in the report's spelling.
pub fn ir_status(s: SolveStatus) -> IrSolveStatus {
    match s {
        SolveStatus::UnderConstrained => IrSolveStatus::UnderConstrained,
        SolveStatus::FullyConstrained => IrSolveStatus::FullyConstrained,
        SolveStatus::OverConstrainedRedundant => IrSolveStatus::OverConstrainedRedundant,
        SolveStatus::Conflict => IrSolveStatus::Conflict,
        SolveStatus::FailedToConverge => IrSolveStatus::FailedToConverge,
    }
}
