//! Floating-point expansion arithmetic (Shewchuk 1997, "Adaptive Precision
//! Floating-Point Arithmetic and Fast Robust Geometric Predicates").
//!
//! An *expansion* is a sum of non-overlapping `f64` components stored from least to
//! most significant; it represents a real number exactly. All routines here assume IEEE
//! 754 binary64 with round-to-nearest-even and no overflow/underflow, and never use FMA.
//!
//! This is an independent Rust implementation of the public-domain algorithms.

/// `2^-53`: half an ulp of 1.0 (Shewchuk's `epsilon`).
pub(crate) const EPSILON: f64 = 1.1102230246251565e-16;
/// `2^27 + 1`, used to split a double into two 26-bit halves.
const SPLITTER: f64 = 134_217_729.0;

/// `x + y = a + b` exactly with `x = fl(a + b)`, provided `|a| >= |b|`.
#[inline]
pub(crate) fn fast_two_sum(a: f64, b: f64) -> (f64, f64) {
    let x = a + b;
    let bvirt = x - a;
    (x, b - bvirt)
}

/// `x + y = a + b` exactly with `x = fl(a + b)`.
#[inline]
pub(crate) fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let x = a + b;
    let bvirt = x - a;
    let avirt = x - bvirt;
    let bround = b - bvirt;
    let around = a - avirt;
    (x, around + bround)
}

/// The roundoff `y` of `x = fl(a − b)`, so that `a − b = x + y` exactly.
#[inline]
pub(crate) fn two_diff_tail(a: f64, b: f64, x: f64) -> f64 {
    let bvirt = a - x;
    let avirt = x + bvirt;
    let bround = bvirt - b;
    let around = a - avirt;
    around + bround
}

/// `x + y = a − b` exactly with `x = fl(a − b)`.
#[inline]
pub(crate) fn two_diff(a: f64, b: f64) -> (f64, f64) {
    let x = a - b;
    (x, two_diff_tail(a, b, x))
}

/// Split `a` into `hi + lo` with each half representable in 26 bits.
#[inline]
fn split(a: f64) -> (f64, f64) {
    let c = SPLITTER * a;
    let abig = c - a;
    let hi = c - abig;
    (hi, a - hi)
}

/// `x + y = a·b` exactly with `x = fl(a·b)` (Dekker's product, no FMA).
#[inline]
pub(crate) fn two_product(a: f64, b: f64) -> (f64, f64) {
    let x = a * b;
    let (ahi, alo) = split(a);
    let (bhi, blo) = split(b);
    (x, product_tail(x, ahi, alo, bhi, blo))
}

#[inline]
fn product_tail(x: f64, ahi: f64, alo: f64, bhi: f64, blo: f64) -> f64 {
    let err1 = x - ahi * bhi;
    let err2 = err1 - alo * bhi;
    let err3 = err2 - ahi * blo;
    alo * blo - err3
}

/// `(a1 + a0) − (b1 + b0)` as a four-component expansion (least significant first).
pub(crate) fn two_two_diff(a1: f64, a0: f64, b1: f64, b0: f64) -> [f64; 4] {
    // Two_One_Diff(a1, a0, b0) -> (j, r0, x0)
    let (i, x0) = two_diff(a0, b0);
    let (j, r0) = two_sum(a1, i);
    // Two_One_Diff(j, r0, b1) -> (x3, x2, x1)
    let (i, x1) = two_diff(r0, b1);
    let (x3, x2) = two_sum(j, i);
    [x0, x1, x2, x3]
}

/// Sum of two expansions with zero elimination (Shewchuk's
/// `fast_expansion_sum_zeroelim`). Both inputs must be non-empty and strongly
/// non-overlapping; the output is strongly non-overlapping and non-empty.
pub(crate) fn fast_expansion_sum(e: &[f64], f: &[f64]) -> Vec<f64> {
    debug_assert!(!e.is_empty() && !f.is_empty());
    let mut h = Vec::with_capacity(e.len() + f.len());
    let (elen, flen) = (e.len(), f.len());
    let (mut ei, mut fi) = (0usize, 0usize);
    let mut enow = e[0];
    let mut fnow = f[0];
    let mut q;
    // Take the smaller-magnitude component first.
    if (fnow > enow) == (fnow > -enow) {
        q = enow;
        ei += 1;
        enow = if ei < elen { e[ei] } else { 0.0 };
    } else {
        q = fnow;
        fi += 1;
        fnow = if fi < flen { f[fi] } else { 0.0 };
    }
    if ei < elen && fi < flen {
        let (qnew, hh) = if (fnow > enow) == (fnow > -enow) {
            let r = fast_two_sum(enow, q);
            ei += 1;
            enow = if ei < elen { e[ei] } else { 0.0 };
            r
        } else {
            let r = fast_two_sum(fnow, q);
            fi += 1;
            fnow = if fi < flen { f[fi] } else { 0.0 };
            r
        };
        q = qnew;
        if hh != 0.0 {
            h.push(hh);
        }
        while ei < elen && fi < flen {
            let (qnew, hh) = if (fnow > enow) == (fnow > -enow) {
                let r = two_sum(q, enow);
                ei += 1;
                enow = if ei < elen { e[ei] } else { 0.0 };
                r
            } else {
                let r = two_sum(q, fnow);
                fi += 1;
                fnow = if fi < flen { f[fi] } else { 0.0 };
                r
            };
            q = qnew;
            if hh != 0.0 {
                h.push(hh);
            }
        }
    }
    while ei < elen {
        let (qnew, hh) = two_sum(q, enow);
        ei += 1;
        enow = if ei < elen { e[ei] } else { 0.0 };
        q = qnew;
        if hh != 0.0 {
            h.push(hh);
        }
    }
    while fi < flen {
        let (qnew, hh) = two_sum(q, fnow);
        fi += 1;
        fnow = if fi < flen { f[fi] } else { 0.0 };
        q = qnew;
        if hh != 0.0 {
            h.push(hh);
        }
    }
    if q != 0.0 || h.is_empty() {
        h.push(q);
    }
    h
}

/// Expansion times a double with zero elimination (Shewchuk's
/// `scale_expansion_zeroelim`). `e` must be non-empty and non-overlapping.
pub(crate) fn scale_expansion(e: &[f64], b: f64) -> Vec<f64> {
    debug_assert!(!e.is_empty());
    let mut h = Vec::with_capacity(2 * e.len());
    let (bhi, blo) = split(b);
    let x = e[0] * b;
    let (ahi, alo) = split(e[0]);
    let mut q = x;
    let hh = product_tail(x, ahi, alo, bhi, blo);
    if hh != 0.0 {
        h.push(hh);
    }
    for &enow in &e[1..] {
        let p1 = enow * b;
        let (ahi, alo) = split(enow);
        let p0 = product_tail(p1, ahi, alo, bhi, blo);
        let (sum, hh) = two_sum(q, p0);
        if hh != 0.0 {
            h.push(hh);
        }
        let (qn, hh) = fast_two_sum(p1, sum);
        q = qn;
        if hh != 0.0 {
            h.push(hh);
        }
    }
    if q != 0.0 || h.is_empty() {
        h.push(q);
    }
    h
}

/// Approximate value of an expansion (sum of its components).
pub(crate) fn estimate(e: &[f64]) -> f64 {
    e.iter().sum()
}

/// The exact expansion `a − b` of two doubles (zeros removed, never empty).
pub(crate) fn diff_expansion(a: f64, b: f64) -> Vec<f64> {
    let (x, y) = two_diff(a, b);
    compress_pair(y, x)
}

fn compress_pair(lo: f64, hi: f64) -> Vec<f64> {
    match (lo != 0.0, hi != 0.0) {
        (true, true) => vec![lo, hi],
        (true, false) => vec![lo],
        (false, _) => vec![hi],
    }
}

/// Exact product of two expansions.
pub(crate) fn mul_expansions(e: &[f64], f: &[f64]) -> Vec<f64> {
    let mut acc = scale_expansion(e, f[0]);
    for &c in &f[1..] {
        let term = scale_expansion(e, c);
        acc = fast_expansion_sum(&acc, &term);
    }
    acc
}

/// Exact sum of two expansions.
pub(crate) fn add_expansions(e: &[f64], f: &[f64]) -> Vec<f64> {
    fast_expansion_sum(e, f)
}

/// Exact difference of two expansions.
pub(crate) fn sub_expansions(e: &[f64], f: &[f64]) -> Vec<f64> {
    let neg: Vec<f64> = f.iter().map(|c| -c).collect();
    fast_expansion_sum(e, &neg)
}

/// The most significant component: its sign is the exact sign of the expansion.
pub(crate) fn most_significant(e: &[f64]) -> f64 {
    *e.last().unwrap_or(&0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_sum_is_exact() {
        let (x, y) = two_sum(1.0, 1e-17);
        assert!((x - 1.0).abs() == 0.0 && (y - 1e-17).abs() == 0.0);
    }

    #[test]
    fn two_product_is_exact() {
        let a = 1.0 + EPSILON * 2.0; // 1 + 2^-52
        let (x, y) = two_product(a, a);
        // (1 + 2^-52)^2 = 1 + 2^-51 + 2^-104
        assert!((x - (1.0 + 4.0 * EPSILON)).abs() == 0.0);
        assert!((y - EPSILON * EPSILON * 4.0).abs() == 0.0);
    }

    #[test]
    fn expansion_sum_cancels_exactly() {
        let a = diff_expansion(1.0, 1e-30);
        let b = diff_expansion(1e-30, 1.0);
        let s = add_expansions(&a, &b);
        assert!(most_significant(&s) == 0.0 && s.len() == 1);
    }

    #[test]
    fn expansion_product_matches_known_value() {
        // (2^30 + 1)·(2^30 − 1) = 2^60 − 1, not representable in one double.
        let e = diff_expansion(1_073_741_824.0, -1.0);
        let f = diff_expansion(1_073_741_824.0, 1.0);
        let p = mul_expansions(&e, &f);
        let d = sub_expansions(&p, &[1_152_921_504_606_846_976.0]);
        assert!((estimate(&d) + 1.0).abs() == 0.0);
    }
}
