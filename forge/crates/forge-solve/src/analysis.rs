//! Rank analysis of a sub-system at a configuration: degrees of freedom and equation
//! dependencies.
//!
//! 1. The Jacobian rows are scaled to unit length (`J_s = D J`), so the rank decision is
//!    about geometric independence, not about magnitudes.
//! 2. A rank-revealing factorization of `J_sᵀ` ([`crate::dense`]) gives the rank `r`, an
//!    orthonormal basis of the motions the sketch still allows (right null space, `n − r`
//!    DOF) and a basis of the dependencies between equations (left null space, `m − r`).
//! 3. The dependency basis is brought to **reduced row-echelon form, pivoting on the
//!    most recent equation first**. Each reduced vector then contains exactly one pivot
//!    equation — the latest one that is implied by earlier ones — plus the earlier
//!    equations it depends on: a *fundamental circuit*. The pivots are exactly the
//!    complement of the greedy basis that keeps equations in sketch order, so "the
//!    constraint you just added is the redundant one" falls out of linear algebra rather
//!    than a heuristic.
//! 4. Each circuit carries `yᵀ F_s`, the part of the residual that no motion can remove:
//!    zero for a consistent (redundant) dependency, non-zero for a conflict.

use crate::dense::{Mat, jacobi_svd, qrcp};
use crate::problem::Problem;
use crate::system::System;

/// Which rank-revealing factorization to use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RankMethod {
    /// Householder QR with column pivoting (default; fastest).
    #[default]
    Qrcp,
    /// One-sided Jacobi SVD (slower; independent cross-check).
    Svd,
}

/// Thresholds of the circuit extraction ([`SolveOptions::circuit_pivot_tolerance`] and
/// [`SolveOptions::circuit_support_tolerance`]).
///
/// [`SolveOptions::circuit_pivot_tolerance`]: crate::SolveOptions::circuit_pivot_tolerance
/// [`SolveOptions::circuit_support_tolerance`]: crate::SolveOptions::circuit_support_tolerance
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CircuitTolerances {
    /// Smallest coefficient magnitude that may pivot the echelon reduction.
    pub pivot: f64,
    /// Relative magnitude (× the circuit's largest coefficient) above which an equation
    /// belongs to the circuit's support.
    pub support: f64,
}

impl CircuitTolerances {
    /// The thresholds configured in `options`.
    pub(crate) fn of(options: &crate::SolveOptions) -> Self {
        Self {
            pivot: options.circuit_pivot_tolerance,
            support: options.circuit_support_tolerance,
        }
    }
}

/// A dependency between equations.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Circuit {
    /// Global index of the pivot equation (the latest dependent one).
    pub pivot: usize,
    /// Global indices of all equations in the circuit (pivot included), ascending.
    pub support: Vec<usize>,
    /// `|yᵀ F_s|` with the pivot coefficient normalized to 1 (mm).
    pub inconsistency: f64,
    /// `Σ |y_j|` (for scaling the consistency threshold).
    pub weight: f64,
}

/// The rank analysis of one problem at one configuration.
#[derive(Clone, Debug)]
pub(crate) struct Analysis {
    /// Numerical rank of the Jacobian.
    pub rank: usize,
    /// Number of unknowns.
    pub n: usize,
    /// `n × (n − rank)` orthonormal basis of allowed motions (problem-local columns).
    pub right_null: Mat,
    /// Dependencies, ordered by pivot equation.
    pub circuits: Vec<Circuit>,
    /// Smallest kept / largest pivot (conditioning of the retained part).
    pub kept_ratio: f64,
    /// Largest dropped / largest pivot (closeness of the rank decision).
    pub dropped_ratio: f64,
}

impl Analysis {
    /// Degrees of freedom of the problem.
    pub(crate) fn dof(&self) -> usize {
        self.n - self.rank
    }
}

/// Analyze `prob` at `x`: rank decision with relative tolerance `tol`, circuits
/// extracted with `circuit`.
pub(crate) fn analyze(
    sys: &System,
    prob: &Problem,
    x: &[f64],
    tol: f64,
    method: RankMethod,
    circuit: CircuitTolerances,
) -> Analysis {
    let (m, n) = (prob.m(), prob.n());
    let (j, f) = prob.dense_jacobian(sys, x);
    // M = J_sᵀ (n × m), F_s = D F.
    let mut mt = Mat::zeros(n, m);
    let mut fs = vec![0.0; m];
    for r in 0..m {
        let mut s = 0.0;
        for c in 0..n {
            let v = j.get(r, c);
            s += v * v;
        }
        let nr = s.sqrt();
        if nr > 0.0 && nr.is_finite() {
            for c in 0..n {
                mt.set(c, r, j.get(r, c) / nr);
            }
            fs[r] = f[r] / nr;
        } else {
            fs[r] = f[r];
        }
    }
    let rr = match method {
        RankMethod::Qrcp => qrcp(&mt, tol),
        RankMethod::Svd => jacobi_svd(&mt, tol),
    };
    let circuits = circuits(&rr.left_null, &fs, &prob.eqs, circuit);
    Analysis {
        rank: rr.rank,
        n,
        right_null: rr.right_null,
        circuits,
        kept_ratio: rr.kept_ratio,
        dropped_ratio: rr.dropped_ratio,
    }
}

/// Reduce the dependency basis `y` (`m × k`) to echelon form with pivots taken from the
/// last equation backwards and extract the circuits.
///
/// Each basis vector is first scaled to a largest coefficient of magnitude 1. A column
/// can only pivot on a coefficient larger than `tol.pivot`; an equation belongs to a
/// reduced circuit when its coefficient exceeds `tol.support` × the circuit's largest
/// coefficient.
fn circuits(y: &Mat, fs: &[f64], eqs: &[usize], tol: CircuitTolerances) -> Vec<Circuit> {
    let (m, k) = (y.rows, y.cols);
    let mut rows: Vec<Vec<f64>> = (0..k)
        .map(|c| {
            let mut v = y.col(c).to_vec();
            let s = v.iter().fold(0.0f64, |a, &b| a.max(b.abs()));
            if s > 0.0 {
                for x in &mut v {
                    *x /= s;
                }
            }
            v
        })
        .collect();
    let mut used = vec![false; k];
    let mut pivots: Vec<(usize, usize)> = Vec::new();
    for col in (0..m).rev() {
        let mut best = None;
        let mut best_val = tol.pivot;
        for (i, r) in rows.iter().enumerate() {
            if !used[i] && r[col].abs() > best_val {
                best_val = r[col].abs();
                best = Some(i);
            }
        }
        let Some(b) = best else { continue };
        used[b] = true;
        let pv = rows[b][col];
        for x in &mut rows[b] {
            *x /= pv;
        }
        let prow = rows[b].clone();
        for (i, r) in rows.iter_mut().enumerate() {
            if i == b {
                continue;
            }
            let fct = r[col];
            if fct != 0.0 {
                for (x, p) in r.iter_mut().zip(&prow) {
                    *x -= fct * p;
                }
                r[col] = 0.0;
            }
        }
        pivots.push((b, col));
    }
    let mut out: Vec<Circuit> = pivots
        .into_iter()
        .map(|(i, col)| {
            let r = &rows[i];
            let mx = r.iter().fold(0.0f64, |a, &b| a.max(b.abs()));
            let support: Vec<usize> = (0..m)
                .filter(|&j| r[j].abs() > tol.support * mx)
                .map(|j| eqs[j])
                .collect();
            let mut dotf = 0.0;
            let mut weight = 0.0;
            for j in 0..m {
                dotf += r[j] * fs[j];
                weight += r[j].abs();
            }
            Circuit {
                pivot: eqs[col],
                support,
                inconsistency: dotf.abs(),
                weight,
            }
        })
        .collect();
    out.sort_by_key(|c| c.pivot);
    out
}

#[cfg(test)]
mod tests {
    use crate::{Constraint, Entity, Sketch, SolveOptions, SolveResult, SolveStatus, c, solve};

    /// Point `b` at (3, 4) on the fixed lines x = 3 (`on_x`) and y = 4 (`on_y`), then
    /// `d`: distance 5 from the fixed origin, which the two lines already imply. With unit
    /// Jacobian rows the dependency is `0.6·on_x + 0.8·on_y − d = 0`.
    fn implied_distance() -> Sketch {
        let mut s = Sketch::default();
        for (id, x, y) in [
            ("o", 0.0, 0.0),
            ("v0", 3.0, -10.0),
            ("v1", 3.0, 10.0),
            ("h0", -10.0, 4.0),
            ("h1", 10.0, 4.0),
        ] {
            s.entities.push(Entity::point(id, x, y).fixed());
        }
        s.entities.push(Entity::point("b", 3.0, 4.0));
        s.entities.push(Entity::line("lx", "v0", "v1"));
        s.entities.push(Entity::line("ly", "h0", "h1"));
        for (id, k) in [
            ("on_x", c::point_on_line("b", "lx")),
            ("on_y", c::point_on_line("b", "ly")),
            ("d", c::distance("o", "b", 5.0)),
        ] {
            s.constraints.push(Constraint::new(id, k));
        }
        s
    }

    fn run(o: &SolveOptions) -> SolveResult {
        solve(&implied_distance(), o).expect("valid sketch")
    }

    #[test]
    fn default_circuit_tolerances_are_the_historical_constants() {
        let o = SolveOptions::default();
        assert_eq!(o.circuit_pivot_tolerance.to_bits(), 1e-9f64.to_bits());
        assert_eq!(o.circuit_support_tolerance.to_bits(), 1e-8f64.to_bits());
        // Options JSON written before the fields existed still loads with the defaults.
        let old: SolveOptions =
            serde_json::from_str(r#"{"rank_tolerance": 1e-8}"#).expect("options json");
        assert_eq!(old, o);
    }

    /// Audit finding L5: the circuit thresholds come from `SolveOptions`, not from
    /// constants hidden in `analysis.rs`.
    #[test]
    fn circuit_tolerances_from_options_drive_the_redundancy_diagnostics() {
        let r = run(&SolveOptions::default());
        assert_eq!(
            r.status,
            SolveStatus::OverConstrainedRedundant,
            "{}",
            r.explanation
        );
        assert_eq!(r.redundant.len(), 1);
        assert_eq!(r.redundant[0].constraint, "d");
        assert_eq!(r.redundant[0].implied_by, ["on_x", "on_y"]);

        // Support threshold above 0.6: `on_x` (coefficient 0.6) leaves the circuit.
        let r = run(&SolveOptions {
            circuit_support_tolerance: 0.7,
            ..SolveOptions::default()
        });
        assert_eq!(r.redundant.len(), 1);
        assert_eq!(r.redundant[0].implied_by, ["on_y"]);

        // The pivot threshold: with `d` first, the dependency is `−d + 0.6·on_x +
        // 0.8·on_y` and the latest equation, `on_y`, pivots by default. Above 0.8 it
        // cannot, and neither can `on_x` (0.6): `d` (1) becomes the pivot.
        let mut s = implied_distance();
        s.constraints.rotate_right(1);
        let r = solve(&s, &SolveOptions::default()).expect("valid sketch");
        assert_eq!(r.redundant.len(), 1, "{}", r.explanation);
        assert_eq!(r.redundant[0].constraint, "on_y");
        assert_eq!(r.redundant[0].implied_by, ["d", "on_x"]);
        let o = SolveOptions {
            circuit_pivot_tolerance: 0.85,
            ..SolveOptions::default()
        };
        let r = solve(&s, &o).expect("valid sketch");
        assert_eq!(r.redundant.len(), 1, "{}", r.explanation);
        assert_eq!(r.redundant[0].constraint, "d");
        assert_eq!(r.redundant[0].implied_by, ["on_x", "on_y"]);
    }

    /// Review of L5: a circuit tolerance that cannot select any circuit (NaN, ≥ 1) or
    /// selects noise (≤ 0) is rejected with `SKETCH_INVALID_OPTION` before solving —
    /// before this check, `circuit_pivot_tolerance: 1.5` reported this redundant sketch
    /// as `FullyConstrained` with no diagnostic.
    #[test]
    fn invalid_circuit_tolerances_are_rejected_with_a_code() {
        let bad = [f64::NAN, 1.5, 1.0, 0.0, -1e-9, f64::INFINITY];
        for v in bad {
            for o in [
                SolveOptions {
                    circuit_pivot_tolerance: v,
                    ..SolveOptions::default()
                },
                SolveOptions {
                    circuit_support_tolerance: v,
                    ..SolveOptions::default()
                },
            ] {
                let e = solve(&implied_distance(), &o).expect_err("rejected");
                assert_eq!(e.code(), "SKETCH_INVALID_OPTION", "{v}: {e}");
                assert!(
                    matches!(e, crate::SketchError::InvalidOption { option, .. }
                        if option.starts_with("circuit_")),
                    "{e:?}"
                );
                // Every entry point: drag and the JSON API too.
                let d = crate::drag(&implied_distance(), "b", &[[3.0, 4.0]], &o);
                assert_eq!(d.expect_err("rejected").code(), "SKETCH_INVALID_OPTION");
            }
        }
        // Options from JSON (NaN is not JSON; out-of-range values are).
        for field in ["circuit_pivot_tolerance", "circuit_support_tolerance"] {
            let req = serde_json::json!({
                "sketch": serde_json::to_value(implied_distance()).expect("sketch"),
                "options": { field: 1.5 },
            });
            let out: serde_json::Value =
                serde_json::from_str(&crate::solve_json(&req.to_string())).expect("json");
            assert_eq!(out["error"]["code"], "SKETCH_INVALID_OPTION", "{out}");
            assert_eq!(out["error"]["details"]["option"], field, "{out}");
        }
        // The defaults and in-range values solve.
        assert!(SolveOptions::default().validate().is_ok());
        let ok = SolveOptions {
            circuit_pivot_tolerance: 0.5,
            circuit_support_tolerance: 0.5,
            ..SolveOptions::default()
        };
        assert_eq!(run(&ok).status, SolveStatus::OverConstrainedRedundant);
    }
}
