//! Dense rank-revealing factorizations for the diagnostics (no LAPACK).
//!
//! Both backends factor `M = J_sᵀ` (`n × m`: one column per equation, rows normalized
//! to unit length) and return the same [`RankReveal`]:
//! - the numerical rank `r`,
//! - an orthonormal basis of the **right null space** of `J` (`n − r` directions in
//!   parameter space along which the sketch can move: its degrees of freedom),
//! - a basis of the **left null space** of `J` (`m − r` linear dependencies between
//!   equations: redundancies or conflicts).
//!
//! [`qrcp`] (Householder QR with Businger–Golub column pivoting and LAPACK-style norm
//! downdating with recomputation) is the production backend; [`jacobi_svd`] (one-sided
//! Hestenes–Jacobi) is the independent cross-check. Loops run in fixed order, pivots
//! break ties by index, so results are bit-identical on every target.

/// Column-major dense matrix.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Mat {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<f64>,
}

impl Mat {
    pub(crate) fn zeros(rows: usize, cols: usize) -> Self {
        Self {
            rows,
            cols,
            data: vec![0.0; rows * cols],
        }
    }
    #[inline]
    pub(crate) fn col(&self, j: usize) -> &[f64] {
        &self.data[j * self.rows..(j + 1) * self.rows]
    }
    #[inline]
    pub(crate) fn col_mut(&mut self, j: usize) -> &mut [f64] {
        &mut self.data[j * self.rows..(j + 1) * self.rows]
    }
    #[inline]
    pub(crate) fn get(&self, i: usize, j: usize) -> f64 {
        self.data[j * self.rows + i]
    }
    #[inline]
    pub(crate) fn set(&mut self, i: usize, j: usize, v: f64) {
        self.data[j * self.rows + i] = v;
    }
    fn swap_cols(&mut self, a: usize, b: usize) {
        if a == b {
            return;
        }
        let r = self.rows;
        let (lo, hi) = (a.min(b), a.max(b));
        let (left, right) = self.data.split_at_mut(hi * r);
        left[lo * r..(lo + 1) * r].swap_with_slice(&mut right[..r]);
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
fn norm(a: &[f64]) -> f64 {
    // Scaled to avoid overflow/underflow; fixed operation order.
    let mut scale = 0.0f64;
    for &x in a {
        scale = scale.max(x.abs());
    }
    if scale == 0.0 || !scale.is_finite() {
        return scale;
    }
    let mut s = 0.0;
    for &x in a {
        let t = x / scale;
        s += t * t;
    }
    scale * s.sqrt()
}

/// Result of a rank-revealing factorization of `M = J_sᵀ` (`n × m`).
#[derive(Clone, Debug)]
pub(crate) struct RankReveal {
    /// Numerical rank.
    pub rank: usize,
    /// `n × (n − rank)`, orthonormal columns: `J · N = 0`.
    pub right_null: Mat,
    /// `m × (m − rank)`: `Yᵀ · J_s = 0` (not orthonormal for QRCP).
    pub left_null: Mat,
    /// Ratio of the smallest kept to the largest pivot / singular value (a condition
    /// indicator of the retained part; 1 when rank = 0).
    pub kept_ratio: f64,
    /// Ratio of the largest dropped to the largest pivot / singular value (0 when full
    /// rank). A value close to the tolerance flags a near-degenerate decision.
    pub dropped_ratio: f64,
}

/// Householder QR with column pivoting of `m_in` (`n × m`), rank decided by
/// `|R_kk| <= tol · |R_00|`.
pub(crate) fn qrcp(m_in: &Mat, tol: f64) -> RankReveal {
    let (n, m) = (m_in.rows, m_in.cols);
    let mut a = m_in.clone();
    let mut perm: Vec<usize> = (0..m).collect();
    let mut norms: Vec<f64> = (0..m).map(|j| norm(a.col(j))).collect();
    let mut norms0 = norms.clone();
    let kmax = n.min(m);
    // Householder vectors v_k (stored below the diagonal in `a`, v_k[k] kept separately).
    let mut vhead = vec![0.0; kmax];
    let mut rank = 0usize;
    let mut r00 = 0.0f64;
    let mut kept_min = f64::INFINITY;
    let mut dropped_max = 0.0f64;
    for k in 0..kmax {
        // Pivot: the largest remaining column norm (ties: lowest index).
        let mut p = k;
        for j in k + 1..m {
            if norms[j] > norms[p] {
                p = j;
            }
        }
        a.swap_cols(k, p);
        perm.swap(k, p);
        norms.swap(k, p);
        norms0.swap(k, p);
        // Recompute this column's trailing norm exactly for the decision.
        let alpha_norm = norm(&a.col(k)[k..]);
        if k == 0 {
            r00 = alpha_norm;
        }
        if r00 == 0.0 || alpha_norm <= tol * r00 {
            dropped_max = alpha_norm;
            break;
        }
        kept_min = kept_min.min(alpha_norm);
        rank = k + 1;
        // Householder reflector H = I − 2 v vᵀ / (vᵀ v) mapping a[k.., k] to (β, 0, …).
        let x0 = a.get(k, k);
        let beta = if x0 >= 0.0 { -alpha_norm } else { alpha_norm };
        let v0 = x0 - beta;
        vhead[k] = v0;
        // v = (v0, a[k+1.., k]); vᵀv = v0² + Σ a²
        let colk: Vec<f64> = a.col(k)[k + 1..].to_vec();
        let vtv = v0 * v0 + dot(&colk, &colk);
        a.set(k, k, beta);
        for (i, x) in a.col_mut(k)[k + 1..].iter_mut().enumerate() {
            *x = colk[i]; // keep v below the diagonal
        }
        if vtv > 0.0 {
            for j in k + 1..m {
                let cj = a.col_mut(j);
                let s = v0 * cj[k] + dot(&colk, &cj[k + 1..]);
                let f = 2.0 * s / vtv;
                cj[k] -= f * v0;
                for (i, x) in cj[k + 1..].iter_mut().enumerate() {
                    *x -= f * colk[i];
                }
            }
        }
        // Norm downdating (LAPACK xLAQP2 safeguard).
        for j in k + 1..m {
            if norms[j] == 0.0 {
                continue;
            }
            let t = a.get(k, j).abs() / norms[j];
            let t = (1.0 - t * t).max(0.0);
            let ratio = norms[j] / norms0[j];
            if t * ratio * ratio <= 1e-8 {
                let nn = norm(&a.col(j)[k + 1..]);
                norms[j] = nn;
                norms0[j] = nn;
            } else {
                norms[j] *= t.sqrt();
            }
        }
    }
    if rank == kmax && kmax < m {
        // Full row rank of M reached with columns left over: all remaining are dependent.
        dropped_max = 0.0;
    }
    let kept_ratio = if rank == 0 || r00 == 0.0 {
        1.0
    } else {
        kept_min / r00
    };
    let dropped_ratio = if r00 == 0.0 { 0.0 } else { dropped_max / r00 };

    // Right null space of J = trailing columns of Q = H_0 … H_{r−1} (n × n).
    let d = n - rank;
    let mut right_null = Mat::zeros(n, d);
    for c in 0..d {
        let col = right_null.col_mut(c);
        col[rank + c] = 1.0;
        for k in (0..rank).rev() {
            let v0 = vhead[k];
            let vk = &a.col(k)[k + 1..];
            let vtv = v0 * v0 + dot(vk, vk);
            if vtv == 0.0 {
                continue;
            }
            let s = v0 * col[k] + dot(vk, &col[k + 1..]);
            let f = 2.0 * s / vtv;
            col[k] -= f * v0;
            for (i, x) in col[k + 1..].iter_mut().enumerate() {
                *x -= f * vk[i];
            }
        }
    }

    // Left null space: for every dependent column j (≥ rank), y = P [−R11⁻¹ R12_j ; e_j].
    let e = m - rank;
    let mut left_null = Mat::zeros(m, e);
    for c in 0..e {
        let j = rank + c;
        let mut z: Vec<f64> = (0..rank).map(|i| a.get(i, j)).collect();
        for i in (0..rank).rev() {
            let mut s = z[i];
            for (t, zt) in z.iter().enumerate().take(rank).skip(i + 1) {
                s -= a.get(i, t) * zt;
            }
            z[i] = s / a.get(i, i);
        }
        let col = left_null.col_mut(c);
        col[perm[j]] = 1.0;
        for i in 0..rank {
            col[perm[i]] = -z[i];
        }
    }
    RankReveal {
        rank,
        right_null,
        left_null,
        kept_ratio,
        dropped_ratio,
    }
}

/// One-sided (Hestenes) Jacobi SVD of `m_in` (`n × m`), orthogonalizing its columns.
/// Rank decided by `σ_i <= tol · σ_max`.
pub(crate) fn jacobi_svd(m_in: &Mat, tol: f64) -> RankReveal {
    let (n, m) = (m_in.rows, m_in.cols);
    let mut a = m_in.clone();
    let mut v = Mat::zeros(m, m);
    for i in 0..m {
        v.set(i, i, 1.0);
    }
    let eps = 1e-15;
    for _sweep in 0..80 {
        let mut rotated = false;
        for p in 0..m {
            for q in p + 1..m {
                let (alpha, beta, gamma) = {
                    let (ap, aq) = (a.col(p), a.col(q));
                    (dot(ap, ap), dot(aq, aq), dot(ap, aq))
                };
                if gamma == 0.0 || gamma.abs() <= eps * (alpha * beta).sqrt() {
                    continue;
                }
                rotated = true;
                let zeta = (beta - alpha) / (2.0 * gamma);
                let t = zeta.signum() / (zeta.abs() + (1.0 + zeta * zeta).sqrt());
                let c = 1.0 / (1.0 + t * t).sqrt();
                let s = c * t;
                for mat in [&mut a, &mut v] {
                    let rows = mat.rows;
                    for i in 0..rows {
                        let x = mat.data[p * rows + i];
                        let y = mat.data[q * rows + i];
                        mat.data[p * rows + i] = c * x - s * y;
                        mat.data[q * rows + i] = s * x + c * y;
                    }
                }
            }
        }
        if !rotated {
            break;
        }
    }
    let sigma: Vec<f64> = (0..m).map(|j| norm(a.col(j))).collect();
    let smax = sigma.iter().copied().fold(0.0f64, f64::max);
    let keep: Vec<bool> = sigma
        .iter()
        .map(|&s| smax > 0.0 && s > tol * smax)
        .collect();
    let rank = keep.iter().filter(|&&k| k).count();
    let kept_min = (0..m)
        .filter(|&j| keep[j])
        .map(|j| sigma[j])
        .fold(f64::INFINITY, f64::min);
    let dropped_max = (0..m)
        .filter(|&j| !keep[j])
        .map(|j| sigma[j])
        .fold(0.0f64, f64::max);
    // Left null space: V columns of the dropped singular values.
    let mut left_null = Mat::zeros(m, m - rank);
    for (c, j) in (0..m).filter(|&j| !keep[j]).enumerate() {
        left_null.col_mut(c).copy_from_slice(v.col(j));
    }
    // Row space basis U_r (n × r) → right null space = its orthogonal complement,
    // obtained from a QR of U_r (no pivoting needed: U_r is orthonormal).
    let mut ur = Mat::zeros(n, rank);
    for (c, j) in (0..m).filter(|&j| keep[j]).enumerate() {
        let s = sigma[j];
        for (dst, src) in ur.col_mut(c).iter_mut().zip(a.col(j)) {
            *dst = src / s;
        }
    }
    let qr = qrcp(&ur, 1e-12);
    RankReveal {
        rank,
        right_null: qr.right_null,
        left_null,
        kept_ratio: if rank == 0 { 1.0 } else { kept_min / smax },
        dropped_ratio: if smax == 0.0 { 0.0 } else { dropped_max / smax },
    }
}

/// Rank of a small matrix block with orthonormal-scale entries (`rows × cols`, given
/// row-major as `rows` slices), plus the dominant row-space direction for 2-row blocks.
pub(crate) fn block_rank(rows: &[&[f64]], tol: f64) -> (usize, Option<[f64; 2]>) {
    if rows.is_empty() {
        return (0, None);
    }
    let cols = rows[0].len();
    // Mᵀ as a column-major Mat (cols × rows): its column j is block row j.
    let mut mt = Mat::zeros(cols, rows.len());
    for (j, r) in rows.iter().enumerate() {
        mt.col_mut(j).copy_from_slice(r);
    }
    // Absolute test: the block of an orthonormal basis has singular values in [0, 1];
    // the first QRCP pivot is (about) the largest row norm, so scale the tolerance.
    let scale = rows.iter().map(|r| norm(r)).fold(0.0f64, f64::max);
    let rank = if scale <= tol {
        0
    } else {
        qrcp(&mt, tol / scale).rank
    };
    let direction = if rows.len() == 2 && rank == 1 {
        // Principal direction of G = B Bᵀ (2 × 2).
        let (a, b, c) = (
            dot(rows[0], rows[0]),
            dot(rows[0], rows[1]),
            dot(rows[1], rows[1]),
        );
        let theta = 0.5 * forge_core::math::atan2(2.0 * b, a - c);
        let (s, co) = forge_core::math::sin_cos(theta);
        let (mut dx, mut dy) = (co, s);
        // Canonical sign: largest component positive (x on ties).
        if (dx.abs() >= dy.abs() && dx < 0.0) || (dy.abs() > dx.abs() && dy < 0.0) {
            dx = -dx;
            dy = -dy;
        }
        // Snap numerically axis-aligned directions.
        if dx.abs() < 1e-12 {
            dx = 0.0;
        }
        if dy.abs() < 1e-12 {
            dy = 0.0;
        }
        Some([dx + 0.0, dy + 0.0])
    } else {
        None
    };
    (rank, direction)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64) / ((1u64 << 53) as f64) - 0.5
    }

    /// A random n × m matrix of rank `r` (product of random n × r and r × m).
    fn low_rank(n: usize, m: usize, r: usize, seed: u64) -> Mat {
        let mut s = seed;
        let a: Vec<f64> = (0..n * r).map(|_| lcg(&mut s)).collect();
        let b: Vec<f64> = (0..r * m).map(|_| lcg(&mut s)).collect();
        let mut out = Mat::zeros(n, m);
        for i in 0..n {
            for j in 0..m {
                let mut acc = 0.0;
                for t in 0..r {
                    acc += a[i * r + t] * b[t * m + j];
                }
                out.set(i, j, acc);
            }
        }
        out
    }

    fn check(mat: &Mat, rr: &RankReveal, expect_rank: usize) {
        assert_eq!(rr.rank, expect_rank);
        let (n, m) = (mat.rows, mat.cols);
        assert_eq!(rr.right_null.cols, n - expect_rank);
        assert_eq!(rr.left_null.cols, m - expect_rank);
        // Mᵀ N = 0 (N spans the null space of J = Mᵀ), N orthonormal.
        for c in 0..rr.right_null.cols {
            let nc = rr.right_null.col(c);
            for j in 0..m {
                assert!(dot(mat.col(j), nc).abs() < 1e-10);
            }
            for c2 in 0..rr.right_null.cols {
                let d = dot(nc, rr.right_null.col(c2));
                let e = if c == c2 { 1.0 } else { 0.0 };
                assert!((d - e).abs() < 1e-10);
            }
        }
        // M Y = 0.
        for c in 0..rr.left_null.cols {
            let y = rr.left_null.col(c);
            for i in 0..n {
                let s: f64 = (0..m).map(|j| mat.get(i, j) * y[j]).sum();
                assert!(s.abs() < 1e-9, "left null residual {s}");
            }
        }
    }

    #[test]
    fn qrcp_and_svd_reveal_the_rank_of_low_rank_matrices() {
        for (n, m, r) in [
            (6, 9, 4),
            (9, 6, 4),
            (8, 8, 8),
            (5, 7, 0),
            (12, 10, 7),
            (3, 3, 1),
        ] {
            let mat = low_rank(n, m, r, (n * 100 + m * 10 + r) as u64);
            check(&mat, &qrcp(&mat, 1e-10), r);
            check(&mat, &jacobi_svd(&mat, 1e-10), r);
        }
    }

    #[test]
    fn block_rank_finds_the_free_direction() {
        let r0 = [0.6, 0.0];
        let r1 = [0.0, 0.0];
        let (rank, dir) = block_rank(&[&r0, &r1], 1e-7);
        assert_eq!(rank, 1);
        assert_eq!(dir, Some([1.0, 0.0]));
        let r0 = [-0.3, 0.1];
        let r1 = [-0.3, 0.1];
        let (rank, dir) = block_rank(&[&r0, &r1], 1e-7);
        assert_eq!(rank, 1);
        let d = dir.expect("direction");
        assert!((d[0] - d[1]).abs() < 1e-12 && d[0] > 0.0);
    }
}
