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

/// Analyze `prob` at `x`.
pub(crate) fn analyze(
    sys: &System,
    prob: &Problem,
    x: &[f64],
    tol: f64,
    method: RankMethod,
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
    let circuits = circuits(&rr.left_null, &fs, &prob.eqs);
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
fn circuits(y: &Mat, fs: &[f64], eqs: &[usize]) -> Vec<Circuit> {
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
        let mut best_val = 1e-9;
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
                .filter(|&j| r[j].abs() > 1e-8 * mx)
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
