//! Robust geometric predicates with exact signs (after Shewchuk).
//!
//! Every function returns an `f64` whose **sign is exactly** the sign of the underlying
//! determinant evaluated in exact real arithmetic on the given `f64` inputs; its
//! magnitude approximates the determinant. Use them for every orientation and
//! in-circle/in-sphere decision in topology code; never compare a naive determinant
//! against an epsilon.
//!
//! | Function | Positive when |
//! |---|---|
//! | [`orient2d`]`(a, b, c)` | `a, b, c` are in counter-clockwise order |
//! | [`orient3d`]`(a, b, c, d)` | `d` lies below the plane of `a, b, c`, where "above" is the side from which `a, b, c` appear counter-clockwise (equivalently `(a−d)·((b−d)×(c−d)) > 0`) |
//! | [`incircle`]`(a, b, c, d)` | `d` is inside the circle through `a, b, c` (which must be counter-clockwise; the sign flips otherwise) |
//! | [`insphere`]`(a, b, c, d, e)` | `e` is inside the sphere through `a, b, c, d` (which must have `orient3d(a, b, c, d) > 0`; the sign flips otherwise) |
//!
//! # Adaptivity
//! Each predicate first evaluates the determinant in plain floating point and accepts
//! the sign when it exceeds Shewchuk's forward error bound (stage A; almost all calls
//! stop here). Otherwise:
//! - [`orient2d`] runs Shewchuk's full adaptive cascade (stages B, C, D).
//! - [`orient3d`], [`incircle`], [`insphere`] fall back directly to an exact expansion
//!   evaluation of the determinant (Shewchuk's intermediate stages B/C are not ported
//!   yet: this only costs speed on near-degenerate input, never correctness).
//!
//! # Assumptions
//! Inputs are finite and the computation neither overflows nor underflows (coordinates
//! with magnitudes roughly within `[1e-60, 1e60]` are safe). Results are deterministic on
//! every IEEE 754 target: only `+ − ×` are used, never FMA.

mod expansion;

use crate::linalg::{Point2, Point3};
use expansion::{
    EPSILON, add_expansions, diff_expansion, estimate, fast_expansion_sum, most_significant,
    mul_expansions, sub_expansions, two_diff_tail, two_product, two_two_diff,
};

const RESULT_ERRBOUND: f64 = (3.0 + 8.0 * EPSILON) * EPSILON;
const CCW_ERRBOUND_A: f64 = (3.0 + 16.0 * EPSILON) * EPSILON;
const CCW_ERRBOUND_B: f64 = (2.0 + 12.0 * EPSILON) * EPSILON;
const CCW_ERRBOUND_C: f64 = (9.0 + 64.0 * EPSILON) * EPSILON * EPSILON;
const O3D_ERRBOUND_A: f64 = (7.0 + 56.0 * EPSILON) * EPSILON;
const ICC_ERRBOUND_A: f64 = (10.0 + 96.0 * EPSILON) * EPSILON;
const ISP_ERRBOUND_A: f64 = (16.0 + 224.0 * EPSILON) * EPSILON;

/// The sign of a predicate result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Sign {
    /// Strictly negative.
    Negative,
    /// Exactly zero (degenerate configuration).
    Zero,
    /// Strictly positive.
    Positive,
}

impl Sign {
    /// The sign of `x` (NaN maps to `Zero`).
    pub fn of(x: f64) -> Self {
        if x > 0.0 {
            Sign::Positive
        } else if x < 0.0 {
            Sign::Negative
        } else {
            Sign::Zero
        }
    }
}

/// Orientation of the triangle `a, b, c` in the plane: positive if counter-clockwise,
/// negative if clockwise, zero if collinear. The value approximates twice the signed
/// area.
pub fn orient2d(a: Point2, b: Point2, c: Point2) -> f64 {
    let detleft = (a.x - c.x) * (b.y - c.y);
    let detright = (a.y - c.y) * (b.x - c.x);
    let det = detleft - detright;
    let detsum = if detleft > 0.0 {
        if detright <= 0.0 {
            return det;
        }
        detleft + detright
    } else if detleft < 0.0 {
        if detright >= 0.0 {
            return det;
        }
        -detleft - detright
    } else {
        return det;
    };
    let errbound = CCW_ERRBOUND_A * detsum;
    if det >= errbound || -det >= errbound {
        return det;
    }
    orient2d_adapt(a, b, c, detsum)
}

fn orient2d_adapt(a: Point2, b: Point2, c: Point2, detsum: f64) -> f64 {
    let acx = a.x - c.x;
    let bcx = b.x - c.x;
    let acy = a.y - c.y;
    let bcy = b.y - c.y;

    // Stage B: exact products of the (rounded) differences.
    let (detleft, detlefttail) = two_product(acx, bcy);
    let (detright, detrighttail) = two_product(acy, bcx);
    let bexp = two_two_diff(detleft, detlefttail, detright, detrighttail);
    let mut det = estimate(&bexp);
    let errbound = CCW_ERRBOUND_B * detsum;
    if det >= errbound || -det >= errbound {
        return det;
    }

    // Stage C: first-order correction with the roundoff tails of the differences.
    let acxtail = two_diff_tail(a.x, c.x, acx);
    let bcxtail = two_diff_tail(b.x, c.x, bcx);
    let acytail = two_diff_tail(a.y, c.y, acy);
    let bcytail = two_diff_tail(b.y, c.y, bcy);
    if acxtail == 0.0 && acytail == 0.0 && bcxtail == 0.0 && bcytail == 0.0 {
        return det;
    }
    let errbound = CCW_ERRBOUND_C * detsum + RESULT_ERRBOUND * det.abs();
    det += (acx * bcytail + bcy * acxtail) - (acy * bcxtail + bcx * acytail);
    if det >= errbound || -det >= errbound {
        return det;
    }

    // Stage D: exact.
    let (s1, s0) = two_product(acxtail, bcy);
    let (t1, t0) = two_product(acytail, bcx);
    let u = two_two_diff(s1, s0, t1, t0);
    let c1 = fast_expansion_sum(&bexp, &u);
    let (s1, s0) = two_product(acx, bcytail);
    let (t1, t0) = two_product(acy, bcxtail);
    let u = two_two_diff(s1, s0, t1, t0);
    let c2 = fast_expansion_sum(&c1, &u);
    let (s1, s0) = two_product(acxtail, bcytail);
    let (t1, t0) = two_product(acytail, bcxtail);
    let u = two_two_diff(s1, s0, t1, t0);
    let d = fast_expansion_sum(&c2, &u);
    most_significant(&d)
}

/// Orientation of the tetrahedron `a, b, c, d`: the determinant
/// `(a−d)·((b−d)×(c−d))`. Positive if `d` lies below the plane through `a, b, c`
/// (the side opposite to the one from which `a, b, c` appear counter-clockwise), zero if
/// coplanar.
pub fn orient3d(a: Point3, b: Point3, c: Point3, d: Point3) -> f64 {
    let adx = a.x - d.x;
    let bdx = b.x - d.x;
    let cdx = c.x - d.x;
    let ady = a.y - d.y;
    let bdy = b.y - d.y;
    let cdy = c.y - d.y;
    let adz = a.z - d.z;
    let bdz = b.z - d.z;
    let cdz = c.z - d.z;

    let bdxcdy = bdx * cdy;
    let cdxbdy = cdx * bdy;
    let cdxady = cdx * ady;
    let adxcdy = adx * cdy;
    let adxbdy = adx * bdy;
    let bdxady = bdx * ady;

    let det = adz * (bdxcdy - cdxbdy) + bdz * (cdxady - adxcdy) + cdz * (adxbdy - bdxady);
    let permanent = (bdxcdy.abs() + cdxbdy.abs()) * adz.abs()
        + (cdxady.abs() + adxcdy.abs()) * bdz.abs()
        + (adxbdy.abs() + bdxady.abs()) * cdz.abs();
    let errbound = O3D_ERRBOUND_A * permanent;
    if det > errbound || -det > errbound {
        return det;
    }
    orient3d_exact(a, b, c, d)
}

/// Exact 2×2 minor `p·s − q·r` of expansions.
fn minor2(p: &[f64], s: &[f64], q: &[f64], r: &[f64]) -> Vec<f64> {
    sub_expansions(&mul_expansions(p, s), &mul_expansions(q, r))
}

/// Exact 3×3 determinant `z_a·m_a + z_b·m_b + z_c·m_c` given the exact 2×2 minors.
fn combine3(za: &[f64], ma: &[f64], zb: &[f64], mb: &[f64], zc: &[f64], mc: &[f64]) -> Vec<f64> {
    let t = add_expansions(&mul_expansions(za, ma), &mul_expansions(zb, mb));
    add_expansions(&t, &mul_expansions(zc, mc))
}

fn orient3d_exact(a: Point3, b: Point3, c: Point3, d: Point3) -> f64 {
    let adx = diff_expansion(a.x, d.x);
    let bdx = diff_expansion(b.x, d.x);
    let cdx = diff_expansion(c.x, d.x);
    let ady = diff_expansion(a.y, d.y);
    let bdy = diff_expansion(b.y, d.y);
    let cdy = diff_expansion(c.y, d.y);
    let adz = diff_expansion(a.z, d.z);
    let bdz = diff_expansion(b.z, d.z);
    let cdz = diff_expansion(c.z, d.z);
    let bc = minor2(&bdx, &cdy, &cdx, &bdy);
    let ca = minor2(&cdx, &ady, &adx, &cdy);
    let ab = minor2(&adx, &bdy, &bdx, &ady);
    most_significant(&combine3(&adz, &bc, &bdz, &ca, &cdz, &ab))
}

/// In-circle test: positive if `d` lies inside the circle through `a, b, c` (given in
/// counter-clockwise order), negative if outside, zero if cocircular.
pub fn incircle(a: Point2, b: Point2, c: Point2, d: Point2) -> f64 {
    let adx = a.x - d.x;
    let bdx = b.x - d.x;
    let cdx = c.x - d.x;
    let ady = a.y - d.y;
    let bdy = b.y - d.y;
    let cdy = c.y - d.y;

    let bdxcdy = bdx * cdy;
    let cdxbdy = cdx * bdy;
    let alift = adx * adx + ady * ady;
    let cdxady = cdx * ady;
    let adxcdy = adx * cdy;
    let blift = bdx * bdx + bdy * bdy;
    let adxbdy = adx * bdy;
    let bdxady = bdx * ady;
    let clift = cdx * cdx + cdy * cdy;

    let det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
    let permanent = (bdxcdy.abs() + cdxbdy.abs()) * alift
        + (cdxady.abs() + adxcdy.abs()) * blift
        + (adxbdy.abs() + bdxady.abs()) * clift;
    let errbound = ICC_ERRBOUND_A * permanent;
    if det > errbound || -det > errbound {
        return det;
    }
    incircle_exact(a, b, c, d)
}

fn lift2(x: &[f64], y: &[f64]) -> Vec<f64> {
    add_expansions(&mul_expansions(x, x), &mul_expansions(y, y))
}

fn incircle_exact(a: Point2, b: Point2, c: Point2, d: Point2) -> f64 {
    let adx = diff_expansion(a.x, d.x);
    let bdx = diff_expansion(b.x, d.x);
    let cdx = diff_expansion(c.x, d.x);
    let ady = diff_expansion(a.y, d.y);
    let bdy = diff_expansion(b.y, d.y);
    let cdy = diff_expansion(c.y, d.y);
    let bc = minor2(&bdx, &cdy, &cdx, &bdy);
    let ca = minor2(&cdx, &ady, &adx, &cdy);
    let ab = minor2(&adx, &bdy, &bdx, &ady);
    let alift = lift2(&adx, &ady);
    let blift = lift2(&bdx, &bdy);
    let clift = lift2(&cdx, &cdy);
    most_significant(&combine3(&alift, &bc, &blift, &ca, &clift, &ab))
}

/// In-sphere test: positive if `e` lies inside the sphere through `a, b, c, d` (which
/// must satisfy `orient3d(a, b, c, d) > 0`), negative if outside, zero if cospherical.
pub fn insphere(a: Point3, b: Point3, c: Point3, d: Point3, e: Point3) -> f64 {
    let aex = a.x - e.x;
    let bex = b.x - e.x;
    let cex = c.x - e.x;
    let dex = d.x - e.x;
    let aey = a.y - e.y;
    let bey = b.y - e.y;
    let cey = c.y - e.y;
    let dey = d.y - e.y;
    let aez = a.z - e.z;
    let bez = b.z - e.z;
    let cez = c.z - e.z;
    let dez = d.z - e.z;

    let aexbey = aex * bey;
    let bexaey = bex * aey;
    let ab = aexbey - bexaey;
    let bexcey = bex * cey;
    let cexbey = cex * bey;
    let bc = bexcey - cexbey;
    let cexdey = cex * dey;
    let dexcey = dex * cey;
    let cd = cexdey - dexcey;
    let dexaey = dex * aey;
    let aexdey = aex * dey;
    let da = dexaey - aexdey;
    let aexcey = aex * cey;
    let cexaey = cex * aey;
    let ac = aexcey - cexaey;
    let bexdey = bex * dey;
    let dexbey = dex * bey;
    let bd = bexdey - dexbey;

    let abc = aez * bc - bez * ac + cez * ab;
    let bcd = bez * cd - cez * bd + dez * bc;
    let cda = cez * da + dez * ac + aez * cd;
    let dab = dez * ab + aez * bd + bez * da;

    let alift = aex * aex + aey * aey + aez * aez;
    let blift = bex * bex + bey * bey + bez * bez;
    let clift = cex * cex + cey * cey + cez * cez;
    let dlift = dex * dex + dey * dey + dez * dez;

    let det = (dlift * abc - clift * dab) + (blift * cda - alift * bcd);

    let aezp = aez.abs();
    let bezp = bez.abs();
    let cezp = cez.abs();
    let dezp = dez.abs();
    let aexbeyp = aexbey.abs();
    let bexaeyp = bexaey.abs();
    let bexceyp = bexcey.abs();
    let cexbeyp = cexbey.abs();
    let cexdeyp = cexdey.abs();
    let dexceyp = dexcey.abs();
    let dexaeyp = dexaey.abs();
    let aexdeyp = aexdey.abs();
    let aexceyp = aexcey.abs();
    let cexaeyp = cexaey.abs();
    let bexdeyp = bexdey.abs();
    let dexbeyp = dexbey.abs();
    let permanent = ((cexdeyp + dexceyp) * bezp
        + (dexbeyp + bexdeyp) * cezp
        + (bexceyp + cexbeyp) * dezp)
        * alift
        + ((dexaeyp + aexdeyp) * cezp + (aexceyp + cexaeyp) * dezp + (cexdeyp + dexceyp) * aezp)
            * blift
        + ((aexbeyp + bexaeyp) * dezp + (bexdeyp + dexbeyp) * aezp + (dexaeyp + aexdeyp) * bezp)
            * clift
        + ((bexceyp + cexbeyp) * aezp + (cexaeyp + aexceyp) * bezp + (aexbeyp + bexaeyp) * cezp)
            * dlift;
    let errbound = ISP_ERRBOUND_A * permanent;
    if det > errbound || -det > errbound {
        return det;
    }
    insphere_exact(a, b, c, d, e)
}

fn lift3(x: &[f64], y: &[f64], z: &[f64]) -> Vec<f64> {
    add_expansions(&lift2(x, y), &mul_expansions(z, z))
}

fn insphere_exact(a: Point3, b: Point3, c: Point3, d: Point3, e: Point3) -> f64 {
    let aex = diff_expansion(a.x, e.x);
    let bex = diff_expansion(b.x, e.x);
    let cex = diff_expansion(c.x, e.x);
    let dex = diff_expansion(d.x, e.x);
    let aey = diff_expansion(a.y, e.y);
    let bey = diff_expansion(b.y, e.y);
    let cey = diff_expansion(c.y, e.y);
    let dey = diff_expansion(d.y, e.y);
    let aez = diff_expansion(a.z, e.z);
    let bez = diff_expansion(b.z, e.z);
    let cez = diff_expansion(c.z, e.z);
    let dez = diff_expansion(d.z, e.z);

    let ab = minor2(&aex, &bey, &bex, &aey);
    let bc = minor2(&bex, &cey, &cex, &bey);
    let cd = minor2(&cex, &dey, &dex, &cey);
    let da = minor2(&dex, &aey, &aex, &dey);
    let ac = minor2(&aex, &cey, &cex, &aey);
    let bd = minor2(&bex, &dey, &dex, &bey);
    let neg_ac: Vec<f64> = ac.iter().map(|v| -v).collect();

    let abc = combine3(&aez, &bc, &bez, &neg_ac, &cez, &ab);
    let neg_bd: Vec<f64> = bd.iter().map(|v| -v).collect();
    let bcd = combine3(&bez, &cd, &cez, &neg_bd, &dez, &bc);
    let cda = combine3(&cez, &da, &dez, &ac, &aez, &cd);
    let dab = combine3(&dez, &ab, &aez, &bd, &bez, &da);

    let alift = lift3(&aex, &aey, &aez);
    let blift = lift3(&bex, &bey, &bez);
    let clift = lift3(&cex, &cey, &cez);
    let dlift = lift3(&dex, &dey, &dez);

    let t1 = sub_expansions(&mul_expansions(&dlift, &abc), &mul_expansions(&clift, &dab));
    let t2 = sub_expansions(&mul_expansions(&blift, &cda), &mul_expansions(&alift, &bcd));
    most_significant(&add_expansions(&t1, &t2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linalg::{Vec2, Vec3};

    fn p2(x: f64, y: f64) -> Point2 {
        Vec2::new(x, y)
    }
    fn p3(x: f64, y: f64, z: f64) -> Point3 {
        Vec3::new(x, y, z)
    }

    #[test]
    fn orient2d_sign_conventions() {
        assert!(orient2d(p2(0.0, 0.0), p2(1.0, 0.0), p2(0.0, 1.0)) > 0.0);
        assert!(orient2d(p2(0.0, 0.0), p2(0.0, 1.0), p2(1.0, 0.0)) < 0.0);
        assert!(orient2d(p2(0.0, 0.0), p2(1.0, 1.0), p2(2.0, 2.0)) == 0.0);
    }

    #[test]
    fn orient2d_resolves_classic_near_collinear_case() {
        // Points on the line y = x, nudged by one ulp: naive evaluation fails here.
        let a = p2(0.5, 0.5);
        let b = p2(12.0, 12.0);
        let c = p2(24.0, 24.0);
        assert_eq!(Sign::of(orient2d(a, b, c)), Sign::Zero);
        let c_up = p2(24.0, 24.0f64.next_up());
        assert_eq!(Sign::of(orient2d(a, b, c_up)), Sign::Positive);
        let c_dn = p2(24.0, 24.0f64.next_down());
        assert_eq!(Sign::of(orient2d(a, b, c_dn)), Sign::Negative);
    }

    #[test]
    fn orient3d_sign_convention() {
        let (a, b, c) = (p3(0.0, 0.0, 0.0), p3(1.0, 0.0, 0.0), p3(0.0, 1.0, 0.0));
        assert!(orient3d(a, b, c, p3(0.0, 0.0, -1.0)) > 0.0);
        assert!(orient3d(a, b, c, p3(0.0, 0.0, 1.0)) < 0.0);
        assert!(orient3d(a, b, c, p3(0.3, 0.3, 0.0)) == 0.0);
    }

    #[test]
    fn incircle_sign_convention() {
        let (a, b, c) = (p2(1.0, 0.0), p2(0.0, 1.0), p2(-1.0, 0.0));
        assert!(incircle(a, b, c, p2(0.0, 0.0)) > 0.0);
        assert!(incircle(a, b, c, p2(2.0, 2.0)) < 0.0);
        assert!(incircle(a, b, c, p2(0.0, -1.0)) == 0.0);
    }

    #[test]
    fn insphere_sign_convention() {
        let (a, b, c, d) = (
            p3(1.0, 0.0, 0.0),
            p3(0.0, 1.0, 0.0),
            p3(0.0, 0.0, 1.0),
            p3(0.0, 0.0, -1.0),
        );
        let (a, b) = if orient3d(a, b, c, d) > 0.0 {
            (a, b)
        } else {
            (b, a)
        };
        assert!(orient3d(a, b, c, d) > 0.0);
        assert!(insphere(a, b, c, d, p3(0.0, 0.0, 0.0)) > 0.0);
        assert!(insphere(a, b, c, d, p3(3.0, 0.0, 0.0)) < 0.0);
        assert!(insphere(a, b, c, d, p3(-1.0, 0.0, 0.0)) == 0.0);
    }

    #[test]
    fn exact_paths_agree_with_filters_on_easy_input() {
        let (a, b, c, d) = (
            p3(0.1, 0.2, 0.3),
            p3(1.5, -0.2, 0.7),
            p3(-0.4, 1.1, 0.2),
            p3(0.3, 0.3, -2.0),
        );
        assert_eq!(
            Sign::of(orient3d(a, b, c, d)),
            Sign::of(orient3d_exact(a, b, c, d))
        );
        let e = p3(0.2, 0.25, 0.1);
        assert_eq!(
            Sign::of(insphere(a, b, c, d, e)),
            Sign::of(insphere_exact(a, b, c, d, e))
        );
        let (a2, b2, c2, d2) = (p2(0.1, 0.2), p2(1.5, -0.2), p2(-0.4, 1.1), p2(0.3, 0.3));
        assert_eq!(
            Sign::of(incircle(a2, b2, c2, d2)),
            Sign::of(incircle_exact(a2, b2, c2, d2))
        );
    }
}
