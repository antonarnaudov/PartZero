//! # forge-solve — Forge's own 2D sketch constraint solver
//!
//! The AI agent never places geometry by coordinates: it adds constraints and this solver
//! places things. So besides solving, the solver *explains* the state of a sketch in a
//! structured, machine-readable way: remaining degrees of freedom per entity, redundant
//! constraints and what implies them, and **minimal** conflicting sets.
//! ([ADR 0008](../../../docs/adr/0008-own-solvers.md))
//!
//! ## Pipeline
//! | Stage | Module | What |
//! |---|---|---|
//! | model | [`model`] | entities (point, line, circle, arc) and constraints with stable string ids; serde JSON |
//! | compile | `system` | validation, scalar quantities, residual equations generic over [`forge_core::Scalar`] |
//! | decompose | [`Solver::new`] | union–find over unknowns → independent clusters (drags re-solve one) |
//! | solve | `problem` | Levenberg–Marquardt with weighted minimum-norm steps; sparse envelope Cholesky in RCM order |
//! | diagnose | `analysis`, `dense` | rank-revealing QR with column pivoting (or Jacobi SVD) of the row-normalized Jacobian; null spaces → DOF per entity; reduced dependency basis → redundancy circuits; deletion filter → minimal conflicting sets |
//! | explain | [`explain`] | sentences naming ids |
//!
//! ## Guarantees
//! - **Deterministic**: no hash-order iteration, fixed loop orders, index tie-breaks,
//!   transcendental functions through `forge_core::math` (libm). The same input gives
//!   bit-identical output on every target, including `wasm32-unknown-unknown`.
//! - **Never silently wrong**: a cluster that is not solved keeps its input geometry and
//!   is reported as [`SolveStatus::Conflict`] or [`SolveStatus::FailedToConverge`];
//!   `ok` is true only when every driving constraint holds to `tolerance`.
//! - **Exact Jacobians** by forward-mode automatic differentiation ([`forge_core::Dual`]).
//!
//! ## Example
//! ```
//! use forge_solve::{c, solve, Constraint, Entity, Sketch, SolveOptions, SolveStatus};
//! let sketch = Sketch {
//!     entities: vec![
//!         Entity::point("a", 0.0, 0.0), Entity::point("b", 9.0, 0.5),
//!         Entity::line("ab", "a", "b"),
//!     ],
//!     constraints: vec![
//!         Constraint::new("fix_a", c::fix("a")),
//!         Constraint::new("h", c::horizontal("ab")),
//!         Constraint::new("len", c::distance("a", "b", 10.0)),
//!         Constraint::new("len2", c::distance("a", "b", 12.0)),
//!     ],
//! };
//! let r = solve(&sketch, &SolveOptions::default()).unwrap();
//! assert_eq!(r.status, SolveStatus::Conflict);
//! assert_eq!(r.conflicts[0].constraints, ["len", "len2"]);
//! assert_eq!(r.conflicts[0].suggested_removal, "len2");
//! ```

mod analysis;
mod dense;
pub mod error;
pub mod explain;
pub mod generate;
pub mod json;
pub mod model;
mod problem;
pub mod result;
mod solver;
mod sparse;
mod system;

pub use analysis::RankMethod;
pub use error::SketchError;
pub use json::{DragRequest, DragResponse, SolveRequest, drag_json, solve_json};
pub use model::{Constraint, ConstraintKind, Entity, Geometry, Sketch, c};
pub use result::{
    ClusterReport, Conflict, ConstraintReport, ConstraintState, DragResult, EntityReport,
    MovedPoint, Redundancy, SolveOptions, SolveResult, SolveStatus, SolvedGeometry,
};
pub use solver::Solver;

/// Solve a sketch and diagnose it.
///
/// Returns an error only for invalid input (unknown ids, wrong entity types, degenerate
/// entities, bad dimension values). Solver outcomes — under-, fully- and over-constrained,
/// conflicts, non-convergence — are reported in the [`SolveResult`].
pub fn solve(sketch: &Sketch, options: &SolveOptions) -> Result<SolveResult, SketchError> {
    Ok(Solver::new(sketch, options)?.solve())
}

/// Solve, then run drag frames moving `point` through `targets`; returns every frame's
/// result and the final sketch. For interactive use keep a [`Solver`] and call
/// [`Solver::drag`] per frame instead.
pub fn drag(
    sketch: &Sketch,
    point: &str,
    targets: &[[f64; 2]],
    options: &SolveOptions,
) -> Result<(Vec<DragResult>, Sketch), SketchError> {
    let mut solver = Solver::new(sketch, options)?;
    solver.solve();
    let frames = targets
        .iter()
        .map(|&t| solver.drag(point, t))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((frames, solver.sketch()))
}
