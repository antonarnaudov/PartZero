//! Robust closest point on an ellipse (D. Eberly, "Distance from a Point to an Ellipse,
//! an Ellipsoid, or a Hyperellipsoid", 2013): reduction to the first quadrant and
//! bisection on a monotone function of one variable. Deterministic, no iteration seed.

use crate::math;

/// Root of `F(s) = (r0·z0/(s + r0))² + (z1/(s + 1))² − 1` by bisection.
fn get_root(r0: f64, z0: f64, z1: f64, g: f64) -> f64 {
    let n0 = r0 * z0;
    let mut s0 = z1 - 1.0;
    let mut s1 = if g < 0.0 {
        0.0
    } else {
        math::hypot(n0, z1) - 1.0
    };
    let mut s = 0.0;
    // Bisection halves the bracket each step; ~1100 steps exhaust the f64 exponent range.
    for _ in 0..1100 {
        s = 0.5 * (s0 + s1);
        if s <= s0 || s >= s1 {
            break;
        }
        let ratio0 = n0 / (s + r0);
        let ratio1 = z1 / (s + 1.0);
        let gs = ratio0 * ratio0 + ratio1 * ratio1 - 1.0;
        if gs > 0.0 {
            s0 = s;
        } else if gs < 0.0 {
            s1 = s;
        } else {
            break;
        }
    }
    s
}

/// Closest point `(x0, x1)` on `(x/e0)² + (y/e1)² = 1` (with `e0 >= e1 > 0`) to the
/// first-quadrant point `(y0, y1)`, `y0, y1 >= 0`.
fn closest_first_quadrant(e0: f64, e1: f64, y0: f64, y1: f64) -> (f64, f64) {
    if y1 > 0.0 {
        if y0 > 0.0 {
            let z0 = y0 / e0;
            let z1 = y1 / e1;
            let g = z0 * z0 + z1 * z1 - 1.0;
            if g != 0.0 {
                let r0 = (e0 / e1) * (e0 / e1);
                let sbar = get_root(r0, z0, z1, g);
                (r0 * y0 / (sbar + r0), y1 / (sbar + 1.0))
            } else {
                (y0, y1)
            }
        } else {
            (0.0, e1)
        }
    } else {
        let numer0 = e0 * y0;
        let denom0 = e0 * e0 - e1 * e1;
        if numer0 < denom0 {
            let xde0 = numer0 / denom0;
            (e0 * xde0, e1 * (1.0 - xde0 * xde0).max(0.0).sqrt())
        } else {
            (e0, 0.0)
        }
    }
}

/// Closest point on the ellipse `(rx·cos t, ry·sin t)` to `(px, py)`: returns
/// `(t, distance)` with `t ∈ [0, 2π)`.
pub(crate) fn closest_param(rx: f64, ry: f64, px: f64, py: f64) -> (f64, f64) {
    if rx.total_cmp(&ry).is_eq() {
        // Circle: radial projection (t = 0 at the centre, where all points tie).
        let rho = math::hypot(px, py);
        let t = if rho > 0.0 {
            math::wrap_angle(math::atan2(py, px), 0.0)
        } else {
            0.0
        };
        return (t, (rho - rx).abs());
    }
    let swap = ry > rx;
    let (e0, e1, y0, y1) = if swap {
        (ry, rx, py.abs(), px.abs())
    } else {
        (rx, ry, px.abs(), py.abs())
    };
    let (x0, x1) = closest_first_quadrant(e0, e1, y0, y1);
    let (qx, qy) = if swap { (x1, x0) } else { (x0, x1) };
    let qx = if px < 0.0 { -qx } else { qx };
    let qy = if py < 0.0 { -qy } else { qy };
    let t = math::wrap_angle(math::atan2(qy / ry, qx / rx), 0.0);
    // Distance to the point actually at parameter t (consistent with eval).
    let (s, c) = math::sin_cos(t);
    (t, math::hypot(rx * c - px, ry * s - py))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_on_ellipse_round_trip() {
        for (rx, ry) in [(5.0, 2.0), (2.0, 5.0), (3.0, 3.0), (10.0, 0.1)] {
            for i in 0..64 {
                let t = math::TAU * (i as f64 + 0.3) / 64.0;
                let (s, c) = math::sin_cos(t);
                let (tp, d) = closest_param(rx, ry, rx * c, ry * s);
                assert!(d < 1e-12, "rx {rx} ry {ry} t {t}: d = {d}");
                assert!((tp - t).abs() < 1e-9, "rx {rx} ry {ry} t {t}: tp = {tp}");
            }
        }
    }

    #[test]
    fn distance_is_minimal_against_sampling() {
        let (rx, ry) = (4.0, 1.5);
        for (px, py) in [
            (0.3, 0.2),
            (-5.0, 3.0),
            (0.0, 0.0),
            (1.0, -0.1),
            (0.0, 7.0),
            (6.0, 0.0),
        ] {
            let (_, d) = closest_param(rx, ry, px, py);
            let mut best = f64::INFINITY;
            for i in 0..20000 {
                let t = math::TAU * i as f64 / 20000.0;
                let (s, c) = math::sin_cos(t);
                best = best.min(math::hypot(rx * c - px, ry * s - py));
            }
            assert!(d <= best + 1e-9, "({px}, {py}): {d} vs sampled {best}");
        }
    }
}
