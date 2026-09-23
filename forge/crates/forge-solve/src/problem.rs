//! A solvable sub-system (a cluster, or a subset of its constraints) and the
//! Levenberg–Marquardt iteration.
//!
//! # The step
//! With `F` the residuals, `J` the Jacobian and `W` positive column weights, every step is
//! the damped, weighted **minimum-norm** Gauss–Newton step
//!
//! ```text
//! δ = −W⁻¹ Jᵀ (J W⁻¹ Jᵀ + μ I)⁻¹ F,    μ = λ·s₀ + floor
//! ```
//!
//! i.e. Levenberg–Marquardt written in the equation space. By the push-through identity it
//! equals the classical `(JᵀJ + μW) δ = −JᵀF`, so δ is the exact minimizer of the model
//! `½|F + Jδ|² + ½μ|δ|²_W` and the predicted reduction is never negative. (Damping by
//! `diag(J W⁻¹ Jᵀ)` instead would weight the *equations* and break the gain ratio.) `s₀`
//! is the largest diagonal entry of `J W⁻¹ Jᵀ` at the start, fixed for the whole solve so
//! that `λ` keeps one meaning. The system is solved with the sparse Cholesky factorization
//! of [`crate::sparse`] (minimum-degree order, structure cached per sub-system). As `λ → 0` this is the step that fixes the linearized
//! constraints while moving the parameters as little as possible (in the `W` norm), so an
//! under-constrained sketch stays close to where it was drawn, and a drag (large weight
//! on the dragged point, which starts at the cursor) moves everything else minimally.
//!
//! `λ` follows Nielsen's update; a step is accepted when the cost `½|F|²` decreases.

use forge_core::Dual;

use crate::dense::Mat;
use crate::sparse::Chol;
use crate::system::{Q, System};

/// Numerical settings of one LM run.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LmSettings {
    /// Converged when `max |F_i| <= tol` (mm).
    pub tol: f64,
    /// Maximum number of iterations (accepted or rejected steps).
    pub max_iter: usize,
    /// Initial relative damping.
    pub lambda0: f64,
}

/// Outcome of one LM run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct LmOutcome {
    /// `max |F_i| <= tol` at the returned point.
    pub converged: bool,
    /// Stopped because no further decrease was possible (a least-squares minimum with a
    /// non-zero residual: the hallmark of a conflict).
    pub stalled: bool,
    /// Iterations used.
    pub iterations: usize,
    /// `max |F_i|` at the returned point.
    pub max_residual: f64,
}

/// Rows (equations) and columns (unknown quantities) of a sub-system with its cached
/// sparsity structure and work buffers.
#[derive(Clone, Debug)]
pub(crate) struct Problem {
    /// Global equation indices, in order (the rows).
    pub eqs: Vec<usize>,
    /// Unknown quantities, ascending (the columns).
    pub cols: Vec<Q>,
    /// CSR row pointers of `J`.
    pub row_ptr: Vec<usize>,
    /// Local column of every Jacobian entry.
    pub row_cols: Vec<u32>,
    chol: Chol,
    work: Work,
}

#[derive(Clone, Debug, Default)]
struct Work {
    f: Vec<f64>,
    f_new: Vec<f64>,
    jac: Vec<f64>,
    a: Vec<f64>,
    l: Vec<f64>,
    y: Vec<f64>,
    tmp: Vec<f64>,
    delta: Vec<f64>,
    jd: Vec<f64>,
    x_old: Vec<f64>,
}

impl Problem {
    /// Build the sub-system of the given equations (their unknowns become the columns).
    pub(crate) fn new(sys: &System, eqs: Vec<usize>) -> Self {
        let mut cols: Vec<Q> = eqs
            .iter()
            .flat_map(|&e| sys.equations[e].vars.iter().copied())
            .filter(|&q| sys.unknown[q as usize])
            .collect();
        cols.sort_unstable();
        cols.dedup();
        Self::with_cols(sys, eqs, cols)
    }

    /// Build the sub-system of the given equations over the given columns (ascending; must
    /// contain every unknown of the equations, may contain more).
    pub(crate) fn with_cols(sys: &System, eqs: Vec<usize>, cols: Vec<Q>) -> Self {
        let mut row_ptr = Vec::with_capacity(eqs.len() + 1);
        let mut row_cols = Vec::new();
        row_ptr.push(0);
        for &e in &eqs {
            for &q in &sys.equations[e].vars {
                if sys.unknown[q as usize] {
                    let c = cols.binary_search(&q).expect("column of an unknown");
                    row_cols.push(c as u32);
                }
            }
            row_ptr.push(row_cols.len());
        }
        let chol = Chol::new(eqs.len(), cols.len(), &row_ptr, &row_cols);
        Self {
            eqs,
            cols,
            row_ptr,
            row_cols,
            chol,
            work: Work::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn chol_for_tests(&self) -> &Chol {
        &self.chol
    }

    /// Number of equations.
    pub(crate) fn m(&self) -> usize {
        self.eqs.len()
    }
    /// Number of unknowns.
    pub(crate) fn n(&self) -> usize {
        self.cols.len()
    }

    /// Residuals at `x` (global quantity vector) into `f`.
    pub(crate) fn residuals(&self, sys: &System, x: &[f64], f: &mut Vec<f64>) {
        f.clear();
        f.extend(self.eqs.iter().map(|&e| sys.residual(e, x)));
    }

    /// Residuals and Jacobian entries (CSR values, forward-mode AD).
    fn residuals_and_jacobian(
        &self,
        sys: &System,
        x: &[f64],
        f: &mut Vec<f64>,
        jac: &mut Vec<f64>,
    ) {
        f.clear();
        jac.clear();
        for (r, &e) in self.eqs.iter().enumerate() {
            let eq = &sys.equations[e];
            let mut value = None;
            let mut k = self.row_ptr[r];
            for &q in &eq.vars {
                if !sys.unknown[q as usize] {
                    continue;
                }
                let d: Dual = eq.kind.eval(&|i: Q| {
                    let v = x[i as usize];
                    if i == q {
                        Dual::variable(v)
                    } else {
                        Dual::constant(v)
                    }
                });
                value.get_or_insert(d.v);
                jac.push(d.d);
                k += 1;
            }
            debug_assert_eq!(k, self.row_ptr[r + 1]);
            f.push(value.unwrap_or_else(|| sys.residual(e, x)));
        }
    }

    /// Dense Jacobian (`m × n`, column-major) and residuals at `x`.
    pub(crate) fn dense_jacobian(&self, sys: &System, x: &[f64]) -> (Mat, Vec<f64>) {
        let (mut f, mut jac) = (Vec::new(), Vec::new());
        self.residuals_and_jacobian(sys, x, &mut f, &mut jac);
        let mut j = Mat::zeros(self.m(), self.n());
        for r in 0..self.m() {
            let (lo, hi) = (self.row_ptr[r], self.row_ptr[r + 1]);
            for (&c, &v) in self.row_cols[lo..hi].iter().zip(&jac[lo..hi]) {
                j.set(r, c as usize, v);
            }
        }
        (j, f)
    }

    /// Run Levenberg–Marquardt from `x` (global quantity vector, updated in place for this
    /// problem's columns). `w_inv[c]` is the inverse weight of local column `c`.
    pub(crate) fn solve(
        &mut self,
        sys: &System,
        x: &mut [f64],
        w_inv: &[f64],
        s: &LmSettings,
    ) -> LmOutcome {
        let m = self.m();
        let n = self.n();
        let mut w = std::mem::take(&mut self.work);
        self.residuals(sys, x, &mut w.f);
        let mut fmax = max_abs(&w.f);
        if m == 0 || fmax <= s.tol || n == 0 {
            self.work = w;
            return LmOutcome {
                converged: fmax <= s.tol,
                stalled: fmax > s.tol,
                iterations: 0,
                max_residual: fmax,
            };
        }
        self.residuals_and_jacobian(sys, x, &mut w.f, &mut w.jac);
        self.chol.assemble(&w.jac, w_inv, &mut w.a);
        let s0 = self.chol.max_diagonal(&w.a).max(1e-300);
        let mut lambda = s.lambda0;
        let mut nu = 2.0;
        let mut cost = 0.5 * dot(&w.f, &w.f);
        let mut stall = 0usize;
        let mut stalled = false;
        let mut converged = false;
        let mut iterations = 0usize;
        while iterations < s.max_iter {
            iterations += 1;
            let mu = lambda * s0 + 1e-13 * s0;
            w.l.clear();
            w.l.extend_from_slice(&w.a);
            if !self.chol.factor(&mut w.l, mu, &mut w.tmp) {
                lambda = (lambda * 10.0).max(1e-12);
                nu = 2.0;
                if lambda > 1e12 {
                    stalled = true;
                    break;
                }
                continue;
            }
            w.y.clear();
            w.y.extend_from_slice(&w.f);
            self.chol.solve(&w.l, &mut w.y, &mut w.tmp);
            // δ = −W⁻¹ Jᵀ y ;  Jδ.
            w.delta.clear();
            w.delta.resize(n, 0.0);
            for r in 0..m {
                let yr = w.y[r];
                for k in self.row_ptr[r]..self.row_ptr[r + 1] {
                    let c = self.row_cols[k] as usize;
                    w.delta[c] -= w_inv[c] * w.jac[k] * yr;
                }
            }
            w.jd.clear();
            for r in 0..m {
                let mut acc = 0.0;
                for k in self.row_ptr[r]..self.row_ptr[r + 1] {
                    acc += w.jac[k] * w.delta[self.row_cols[k] as usize];
                }
                w.jd.push(acc);
            }
            let pred = -dot(&w.f, &w.jd) - 0.5 * dot(&w.jd, &w.jd);
            let step = max_abs(&w.delta);
            let mut xscale = 1.0f64;
            w.x_old.clear();
            for (c, &q) in self.cols.iter().enumerate() {
                let xi = x[q as usize];
                w.x_old.push(xi);
                xscale = xscale.max(xi.abs());
                x[q as usize] = xi + w.delta[c];
            }
            self.residuals(sys, x, &mut w.f_new);
            let cost_new = 0.5 * dot(&w.f_new, &w.f_new);
            if cost_new.is_finite() && pred > 0.0 && cost_new < cost {
                let rho = (cost - cost_new) / pred;
                let rel = (cost - cost_new) / cost;
                cost = cost_new;
                std::mem::swap(&mut w.f, &mut w.f_new);
                fmax = max_abs(&w.f);
                if fmax <= s.tol {
                    converged = true;
                    break;
                }
                self.residuals_and_jacobian(sys, x, &mut w.f, &mut w.jac);
                self.chol.assemble(&w.jac, w_inv, &mut w.a);
                let t = 2.0 * rho - 1.0;
                lambda *= (1.0f64 / 3.0).max(1.0 - t * t * t);
                lambda = lambda.max(1e-15);
                nu = 2.0;
                if rel < 1e-10 {
                    stall += 1;
                    if stall >= 3 {
                        stalled = true;
                        break;
                    }
                } else {
                    stall = 0;
                }
            } else {
                for (c, &q) in self.cols.iter().enumerate() {
                    x[q as usize] = w.x_old[c];
                }
                lambda *= nu;
                nu *= 2.0;
                if lambda > 1e10 {
                    stalled = true;
                    break;
                }
            }
            if step <= 1e-15 * xscale {
                stalled = true;
                break;
            }
        }
        self.work = w;
        LmOutcome {
            converged,
            stalled: stalled && !converged,
            iterations,
            max_residual: fmax,
        }
    }
}

#[inline]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut s = 0.0;
    for (x, y) in a.iter().zip(b) {
        s += x * y;
    }
    s
}

#[inline]
pub(crate) fn max_abs(a: &[f64]) -> f64 {
    let mut m = 0.0f64;
    for &x in a {
        let ax = x.abs();
        if ax > m || ax.is_nan() {
            m = if ax.is_nan() { f64::INFINITY } else { ax };
        }
    }
    m
}
