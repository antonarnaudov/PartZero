//! Sparse symmetric positive-definite solves for the Levenberg–Marquardt / drag steps.
//!
//! Every step solves `(J W⁻¹ Jᵀ + μI) y = b` with the `m × m` matrix `A = J W⁻¹ Jᵀ`,
//! whose sparsity pattern links two equations when they share an unknown. Sketches
//! produce chains and loops (local constraints) plus *hubs* (many dimensions measured
//! from one origin or corner): a hub's equations form a clique.
//!
//! - **Ordering**: minimum degree (ties by index) on the graph of `A`, simulated
//!   explicitly; the elimination graph gives the exact nonzero pattern of the Cholesky
//!   factor `L`, so the symbolic phase is exact. Hubs are eliminated as compact cliques,
//!   which a bandwidth ordering (RCM) would smear across the whole envelope.
//! - **Numeric**: left-looking column Cholesky on the fixed pattern (dense accumulator).
//! - The structure is computed once per sub-system and reused by every iteration and
//!   every drag frame.
//!
//! Everything is deterministic: orderings break ties by index, loops run in fixed order.

/// Symbolic Cholesky structure of `A = J W⁻¹ Jᵀ` in minimum-degree order.
#[derive(Clone, Debug)]
pub(crate) struct Chol {
    /// Dimension (number of equations).
    pub m: usize,
    /// `perm[new] = old` row index.
    pub perm: Vec<u32>,
    /// Column pointers of `L` (CSC, `m + 1`); each column stores its diagonal first, then
    /// its strictly-lower rows in increasing order.
    col_ptr: Vec<usize>,
    /// Row index (new order) of every stored entry.
    row_idx: Vec<u32>,
    /// For every row `j`: the `(column k < j, position of L(j, k))` pairs, `k` increasing.
    row_list: Vec<Vec<(u32, u32)>>,
    /// Assembly of `A` from Jacobian entries: for Jacobian column `c`, the triples
    /// `asm[asm_ptr[c]..asm_ptr[c+1]]` are `(target position, entry a, entry b)`.
    asm_ptr: Vec<usize>,
    asm: Vec<(u32, u32, u32)>,
}

impl Chol {
    /// Build the structure from the Jacobian pattern (`row_ptr`/`row_cols`, CSR with `m`
    /// rows and `n` columns).
    pub(crate) fn new(m: usize, n: usize, row_ptr: &[usize], row_cols: &[u32]) -> Self {
        // Column → (row, Jacobian entry index), rows ascending.
        let mut col_rows: Vec<Vec<(u32, u32)>> = vec![Vec::new(); n];
        for r in 0..m {
            for kk in row_ptr[r]..row_ptr[r + 1] {
                col_rows[row_cols[kk] as usize].push((r as u32, kk as u32));
            }
        }
        // Graph of A.
        let mut adj: Vec<Vec<u32>> = vec![Vec::new(); m];
        for rows in &col_rows {
            for (i, &(ra, _)) in rows.iter().enumerate() {
                for &(rb, _) in &rows[i + 1..] {
                    adj[ra as usize].push(rb);
                    adj[rb as usize].push(ra);
                }
            }
        }
        for a in &mut adj {
            a.sort_unstable();
            a.dedup();
        }
        let (perm, patterns) = minimum_degree(adj);
        let mut iperm = vec![0u32; m];
        for (new, &old) in perm.iter().enumerate() {
            iperm[old as usize] = new as u32;
        }
        // Column structure of L (new indices).
        let mut col_ptr = Vec::with_capacity(m + 1);
        let mut row_idx = Vec::new();
        col_ptr.push(0);
        for (j, pat) in patterns.iter().enumerate() {
            row_idx.push(j as u32);
            let mut rows: Vec<u32> = pat.iter().map(|&o| iperm[o as usize]).collect();
            rows.sort_unstable();
            debug_assert!(rows.iter().all(|&r| r as usize > j));
            row_idx.extend(rows);
            col_ptr.push(row_idx.len());
        }
        let mut row_list: Vec<Vec<(u32, u32)>> = vec![Vec::new(); m];
        for k in 0..m {
            for p in col_ptr[k] + 1..col_ptr[k + 1] {
                row_list[row_idx[p] as usize].push((k as u32, p as u32));
            }
        }
        let pos = |row: u32, col: u32| -> u32 {
            let (lo, hi) = (col_ptr[col as usize], col_ptr[col as usize + 1]);
            if row == col {
                return lo as u32;
            }
            let rel = row_idx[lo + 1..hi]
                .binary_search(&row)
                .expect("A's pattern is contained in L's");
            (lo + 1 + rel) as u32
        };
        let mut asm_ptr = Vec::with_capacity(n + 1);
        let mut asm = Vec::new();
        asm_ptr.push(0);
        for rows in &col_rows {
            let mut e: Vec<(u32, u32)> = rows
                .iter()
                .map(|&(r, kk)| (iperm[r as usize], kk))
                .collect();
            e.sort_unstable();
            for (a, &(ia, ka)) in e.iter().enumerate() {
                for &(ib, kb) in &e[..=a] {
                    // ib <= ia: entry (ia, ib) lives in column ib.
                    asm.push((pos(ia, ib), ka, kb));
                }
            }
            asm_ptr.push(asm.len());
        }
        Self {
            m,
            perm,
            col_ptr,
            row_idx,
            row_list,
            asm_ptr,
            asm,
        }
    }

    /// Number of stored entries of `L`.
    pub(crate) fn len(&self) -> usize {
        self.row_idx.len()
    }

    /// Assemble `A = J W⁻¹ Jᵀ` into `out` (the layout of `L`).
    pub(crate) fn assemble(&self, jac: &[f64], w_inv: &[f64], out: &mut Vec<f64>) {
        out.clear();
        out.resize(self.len(), 0.0);
        for (c, &w) in w_inv.iter().enumerate() {
            for &(p, ka, kb) in &self.asm[self.asm_ptr[c]..self.asm_ptr[c + 1]] {
                out[p as usize] += jac[ka as usize] * w * jac[kb as usize];
            }
        }
    }

    /// Largest diagonal entry of an assembled matrix.
    pub(crate) fn max_diagonal(&self, a: &[f64]) -> f64 {
        (0..self.m)
            .map(|j| a[self.col_ptr[j]])
            .fold(0.0f64, f64::max)
    }

    /// Factor `A + μI` in place into `L` (same layout). `x` is a work vector. Returns
    /// `false` if a pivot is not positive and finite.
    pub(crate) fn factor(&self, a: &mut [f64], mu: f64, x: &mut Vec<f64>) -> bool {
        x.clear();
        x.resize(self.m, 0.0);
        for j in 0..self.m {
            let (lo, hi) = (self.col_ptr[j], self.col_ptr[j + 1]);
            for p in lo..hi {
                x[self.row_idx[p] as usize] = a[p];
            }
            x[j] += mu;
            for &(k, pk) in &self.row_list[j] {
                let pk = pk as usize;
                let ljk = a[pk];
                for p in pk..self.col_ptr[k as usize + 1] {
                    x[self.row_idx[p] as usize] -= a[p] * ljk;
                }
            }
            let d = x[j];
            x[j] = 0.0;
            if !(d > 0.0 && d.is_finite()) {
                for p in lo + 1..hi {
                    x[self.row_idx[p] as usize] = 0.0;
                }
                return false;
            }
            let ljj = d.sqrt();
            a[lo] = ljj;
            for (ap, &r) in a[lo + 1..hi].iter_mut().zip(&self.row_idx[lo + 1..hi]) {
                *ap = x[r as usize] / ljj;
                x[r as usize] = 0.0;
            }
        }
        true
    }

    /// Solve `L Lᵀ y = b` in place; `b` is in the *original* row order.
    pub(crate) fn solve(&self, l: &[f64], b: &mut [f64], tmp: &mut Vec<f64>) {
        tmp.clear();
        tmp.extend(self.perm.iter().map(|&old| b[old as usize]));
        for j in 0..self.m {
            let (lo, hi) = (self.col_ptr[j], self.col_ptr[j + 1]);
            let zj = tmp[j] / l[lo];
            tmp[j] = zj;
            for p in lo + 1..hi {
                tmp[self.row_idx[p] as usize] -= l[p] * zj;
            }
        }
        for j in (0..self.m).rev() {
            let (lo, hi) = (self.col_ptr[j], self.col_ptr[j + 1]);
            let mut s = tmp[j];
            for p in lo + 1..hi {
                s -= l[p] * tmp[self.row_idx[p] as usize];
            }
            tmp[j] = s / l[lo];
        }
        for (new, &old) in self.perm.iter().enumerate() {
            b[old as usize] = tmp[new];
        }
    }
}

/// Minimum-degree ordering by explicit elimination (ties: lowest index). Returns
/// `perm[new] = old` and, per eliminated node (new order), its neighbours at elimination
/// time (old indices): exactly the strictly-lower pattern of that column of `L`.
fn minimum_degree(mut nbrs: Vec<Vec<u32>>) -> (Vec<u32>, Vec<Vec<u32>>) {
    let n = nbrs.len();
    let mut alive: std::collections::BTreeSet<(usize, u32)> =
        (0..n).map(|v| (nbrs[v].len(), v as u32)).collect();
    let mut perm = Vec::with_capacity(n);
    let mut patterns = Vec::with_capacity(n);
    let mut merged: Vec<u32> = Vec::new();
    while let Some((_, v)) = alive.pop_first() {
        let nv = std::mem::take(&mut nbrs[v as usize]);
        for &u in &nv {
            let old = std::mem::take(&mut nbrs[u as usize]);
            alive.remove(&(old.len(), u));
            // nbrs[u] ← (old ∪ nv) \ {u, v}; both lists are sorted.
            merged.clear();
            let (mut i, mut k) = (0, 0);
            while i < old.len() || k < nv.len() {
                let next = match (old.get(i), nv.get(k)) {
                    (Some(&a), Some(&b)) if a == b => {
                        i += 1;
                        k += 1;
                        a
                    }
                    (Some(&a), Some(&b)) if a < b => {
                        i += 1;
                        a
                    }
                    (Some(_), Some(&b)) => {
                        k += 1;
                        b
                    }
                    (Some(&a), None) => {
                        i += 1;
                        a
                    }
                    (None, Some(&b)) => {
                        k += 1;
                        b
                    }
                    (None, None) => unreachable!("loop condition"),
                };
                if next != u && next != v {
                    merged.push(next);
                }
            }
            nbrs[u as usize] = merged.clone();
            alive.insert((merged.len(), u));
        }
        perm.push(v);
        patterns.push(nv);
    }
    (perm, patterns)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dense reference: A = J Jᵀ + μI.
    fn dense(m: usize, row_ptr: &[usize], cols: &[u32], vals: &[f64], mu: f64) -> Vec<Vec<f64>> {
        let mut a = vec![vec![0.0; m]; m];
        for i in 0..m {
            for j in 0..m {
                let mut s = 0.0;
                for ki in row_ptr[i]..row_ptr[i + 1] {
                    for kj in row_ptr[j]..row_ptr[j + 1] {
                        if cols[ki] == cols[kj] {
                            s += vals[ki] * vals[kj];
                        }
                    }
                }
                a[i][j] = s;
            }
            a[i][i] += mu;
        }
        a
    }

    #[test]
    fn sparse_cholesky_solves_like_dense() {
        // A chain with a hub column (0) shared by three rows: 6 rows over 7 columns.
        let row_ptr = [0, 2, 4, 6, 9, 11, 14];
        let cols: Vec<u32> = vec![0, 1, 1, 2, 2, 3, 0, 3, 4, 4, 5, 0, 5, 6];
        let vals: Vec<f64> = (0..cols.len()).map(|i| 1.0 + 0.37 * i as f64).collect();
        let m = 6;
        let ch = Chol::new(m, 7, &row_ptr, &cols);
        let mut a = Vec::new();
        ch.assemble(&vals, &[1.0; 7], &mut a);
        let mu = 0.05;
        let mut x = Vec::new();
        assert!(ch.factor(&mut a, mu, &mut x));
        let b0 = [1.0, -2.0, 0.5, 3.0, -1.0, 0.25];
        let mut y = b0;
        let mut tmp = Vec::new();
        ch.solve(&a, &mut y, &mut tmp);
        let ad = dense(m, &row_ptr, &cols, &vals, mu);
        for i in 0..m {
            let r: f64 = (0..m).map(|j| ad[i][j] * y[j]).sum::<f64>() - b0[i];
            assert!(r.abs() < 1e-10, "row {i}: {r}");
        }
    }

    #[test]
    fn minimum_degree_is_a_deterministic_permutation() {
        let adj = vec![vec![1, 4], vec![0, 2], vec![1, 3], vec![2], vec![0], vec![]];
        let (p, pats) = minimum_degree(adj.clone());
        let mut s = p.clone();
        s.sort_unstable();
        assert_eq!(s, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(pats.len(), 6);
        assert_eq!(p, minimum_degree(adj).0);
    }

    #[test]
    #[ignore = "profiling aid: prints factor sizes of the benchmark sketches"]
    fn print_factor_sizes() {
        use crate::generate::benchmark;
        use crate::problem::Problem;
        use crate::system::compile;
        for size in [60, 200] {
            let s = benchmark(size, true);
            let sys = compile(&s).expect("valid");
            let p = Problem::new(&sys, (0..sys.equations.len()).collect());
            let ch = p.chol_for_tests();
            let flops: usize = (0..ch.m)
                .map(|j| {
                    let c = ch.col_ptr[j + 1] - ch.col_ptr[j];
                    c * c
                })
                .sum();
            println!(
                "size {size}: m={} nnz(L)={} factor flops≈{flops}",
                ch.m,
                ch.len()
            );
        }
    }
}
