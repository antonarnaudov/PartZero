//! Screen-space constant-width lines drawn as instanced quads.
//!
//! Every line segment is one instance of 6 vertices (two triangles). The vertex shader
//! (`line_corner` in `shaders/lines.wgsl`) projects both endpoints, clips the segment
//! against the near plane, and pushes each corner sideways by the half width (plus a
//! one-pixel feather used for anti-aliasing) and outwards along the segment by the half
//! width, so consecutive segments of a polyline overlap at their joints without gaps.
//! [`line_corner`] is a CPU mirror of that shader function, used by the unit tests to
//! pin down the geometry.
//!
//! Endpoints are moved towards the eye by a few pixels' worth of depth before projection
//! (`depth_bias_px`), so edges win the depth test against the faces they bound without a
//! polygon offset on the faces; the move is along the view ray, so it does not change
//! where the line appears.

use glam::{DVec2, DVec4};

/// Extra pixels on each side of a line for the anti-aliasing ramp.
pub const FEATHER_PX: f64 = 1.0;

/// `(endpoint, side)` of the 6 vertices of a segment quad: endpoint 0 or 1, side −1/+1.
pub const LINE_CORNERS: [(u32, f64); 6] = [
    (0, -1.0),
    (0, 1.0),
    (1, 1.0),
    (0, -1.0),
    (1, 1.0),
    (1, -1.0),
];

/// Clip the segment `c0 → c1` (clip space) against the perspective near plane
/// `w = near`; `None` when it lies entirely in front of it (towards the eye).
pub fn clip_to_near(c0: DVec4, c1: DVec4, near: f64) -> Option<(DVec4, DVec4)> {
    let in0 = c0.w >= near;
    let in1 = c1.w >= near;
    match (in0, in1) {
        (true, true) => Some((c0, c1)),
        (false, false) => None,
        _ => {
            let t = (near - c0.w) / (c1.w - c0.w);
            let m = c0 + (c1 - c0) * t;
            if in0 { Some((c0, m)) } else { Some((m, c1)) }
        }
    }
}

/// Clip-space position of quad corner `corner` (0..6) of the segment `c0 → c1`, and the
/// signed distance of that corner from the centre line in pixels (for the feather).
///
/// `viewport` is the target size in pixels; `half_width_px` the half line width.
pub fn line_corner(
    c0: DVec4,
    c1: DVec4,
    viewport: DVec2,
    half_width_px: f64,
    corner: usize,
) -> (DVec4, f64) {
    let (end, side) = LINE_CORNERS[corner % 6];
    let s0 = c0.truncate().truncate() / c0.w * viewport * 0.5;
    let s1 = c1.truncate().truncate() / c1.w * viewport * 0.5;
    let d = s1 - s0;
    let len = d.length();
    let dir = if len > 1e-6 { d / len } else { DVec2::X };
    let normal = DVec2::new(-dir.y, dir.x);
    let ext = half_width_px + FEATHER_PX;
    let along = if end == 0 {
        -half_width_px
    } else {
        half_width_px
    };
    let offset_px = normal * (side * ext) + dir * along;
    let c = if end == 0 { c0 } else { c1 };
    let off = offset_px * 2.0 / viewport * c.w;
    (DVec4::new(c.x + off.x, c.y + off.y, c.z, c.w), side * ext)
}

/// Feathered coverage of a line fragment at signed distance `dist` (pixels) from the
/// centre line: 1 inside the core, a one-pixel linear ramp at the border.
pub fn coverage(dist: f64, half_width_px: f64) -> f64 {
    (half_width_px + 0.5 - dist.abs()).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VP: DVec2 = DVec2::new(800.0, 600.0);

    fn to_px(c: DVec4) -> DVec2 {
        c.truncate().truncate() / c.w * VP * 0.5
    }

    #[test]
    fn horizontal_segment_quad_has_the_requested_width_and_end_caps() {
        let c0 = DVec4::new(-0.5, 0.0, 0.5, 1.0);
        let c1 = DVec4::new(0.5, 0.0, 0.5, 1.0);
        let hw = 1.5;
        let px: Vec<(DVec2, f64)> = (0..6)
            .map(|k| {
                let (c, d) = line_corner(c0, c1, VP, hw, k);
                assert_eq!(c.z.to_bits(), 0.5f64.to_bits());
                (to_px(c), d)
            })
            .collect();
        for (p, d) in &px {
            assert!((p.y.abs() - (hw + FEATHER_PX)).abs() < 1e-9);
            assert!((d.abs() - (hw + FEATHER_PX)).abs() < 1e-12);
            assert!(p.y.signum() * d.signum() > 0.0);
        }
        // Ends extended by the half width: x = ±200 px ± hw.
        let xs: Vec<f64> = px.iter().map(|(p, _)| p.x).collect();
        assert!(xs.iter().any(|x| (x + 200.0 + hw).abs() < 1e-9));
        assert!(xs.iter().any(|x| (x - 200.0 - hw).abs() < 1e-9));
    }

    #[test]
    fn width_is_constant_in_pixels_regardless_of_depth_and_direction() {
        for (w0, w1) in [(1.0, 1.0), (0.2, 7.0), (3.0, 0.5)] {
            for angle in [0.1_f64, 0.7, 1.3, 2.9] {
                let (s, c) = forge_core::math::sin_cos(angle);
                let a = DVec2::new(-100.0 * c, -100.0 * s);
                let b = DVec2::new(120.0 * c, 120.0 * s);
                // Clip-space points whose NDC is a/b in pixels, at different w.
                let c0 = DVec4::new(a.x / (VP.x * 0.5) * w0, a.y / (VP.y * 0.5) * w0, 0.3, w0);
                let c1 = DVec4::new(b.x / (VP.x * 0.5) * w1, b.y / (VP.y * 0.5) * w1, 0.3, w1);
                let n = DVec2::new(-s, c);
                for k in 0..6 {
                    let (cl, _) = line_corner(c0, c1, VP, 2.0, k);
                    let p = to_px(cl);
                    let dist = (p - a).dot(n).abs();
                    assert!((dist - 3.0).abs() < 1e-6, "{w0} {w1} {angle} {k}: {dist}");
                }
            }
        }
    }

    #[test]
    fn degenerate_segment_still_yields_a_square_dot() {
        let c = DVec4::new(0.1, 0.2, 0.4, 2.0);
        for k in 0..6 {
            let (cl, _) = line_corner(c, c, VP, 2.0, k);
            let d = to_px(cl) - to_px(c);
            assert!(d.x.abs() <= 2.0 + 1e-9 && (d.y.abs() - 3.0).abs() < 1e-9);
        }
    }

    #[test]
    fn near_plane_clipping_keeps_the_visible_part() {
        let near = 0.1;
        let a = DVec4::new(0.0, 0.0, 0.1, 1.0);
        let b = DVec4::new(1.0, 0.0, 0.1, -1.0);
        let (p, q) = clip_to_near(a, b, near).expect("partly visible");
        assert_eq!(p, a);
        assert!((q.w - near).abs() < 1e-12);
        let (p, q) = clip_to_near(b, a, near).expect("partly visible");
        assert!((p.w - near).abs() < 1e-12 && q == a);
        assert!(clip_to_near(b, b, near).is_none());
    }

    #[test]
    fn coverage_ramps_over_one_pixel() {
        assert!((coverage(0.0, 1.0) - 1.0).abs() < 1e-15);
        assert!(coverage(1.5, 1.0).abs() < 1e-15);
        assert!((coverage(1.25, 1.0) - 0.25).abs() < 1e-12);
        assert!(coverage(-2.5, 1.0).abs() < 1e-15);
    }
}
