//! Debug helper: one near-degenerate configuration (equal cylinders whose axes miss by δ,
//! or a sphere of the cylinder's radius δ off its axis).
//!
//! ```text
//! cargo run --release -p forge-ssi --example ssi_near -- <cyl|sph> <delta>
//! ```

use forge_core::geom::{Cylinder, Sphere, Surface};
use forge_core::math;
use forge_core::{Frame, Vec3};
use forge_ssi::{SsiTolerance, UvBox, intersect_surfaces};

fn frame(o: [f64; 3], n: [f64; 3], x: [f64; 3]) -> Frame {
    Frame::from_normal_x(Vec3::from(o), Vec3::from(n), Vec3::from(x)).expect("frame")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let which = args.get(1).map_or("cyl", String::as_str);
    let delta: f64 = args.get(2).map_or(1e-6, |s| s.parse().expect("delta"));
    let cyl: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
    let dc = UvBox::new(0.0, math::TAU, -4.0, 4.0);
    let (b, db): (Surface, UvBox) = if which == "cyl" {
        (
            Cylinder::new(
                frame([0.0, delta, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
                2.0,
            )
            .expect("c2")
            .into(),
            dc,
        )
    } else {
        let s: Surface = Sphere::new(
            frame([delta, 0.0, 0.3], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
            2.0,
        )
        .expect("s")
        .into();
        let d = UvBox::natural(&s, 0.0);
        (s, d)
    };
    let t = std::time::Instant::now();
    let r = intersect_surfaces(&cyl, dc, &b, db, &SsiTolerance::default());
    let el = t.elapsed();
    match r {
        Ok(g) => {
            println!(
                "{:?}: {} branches, {} vertices, certified {} ({el:?})",
                g.method,
                g.branches.len(),
                g.vertices.len(),
                g.certified_complete
            );
            for br in &g.branches {
                println!(
                    "  {} closed={} range={:?} bound={:e} min_angle={:e} start={:?} end={:?}",
                    br.curve.kind_name(),
                    br.closed,
                    br.range,
                    br.error_bound,
                    br.min_angle,
                    br.start,
                    br.end
                );
            }
            for v in &g.vertices {
                println!("  vertex {:?} {:?} {:?}", v.kind, v.point, v.contact);
            }
        }
        Err(e) => println!("error {}: {e} ({el:?})", e.code()),
    }
}
