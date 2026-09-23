//! Property tests for the constrained Delaunay triangulation on random polygons with
//! holes: every constrained edge is present, triangles do not overlap (positive
//! orientation, edge-manifold, total area = polygon area), and every unconstrained
//! interior edge is locally Delaunay. Inputs optionally snap to a coarse grid, which
//! produces many exactly collinear and cocircular configurations.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::Point2;
use forge_core::predicates::{incircle, orient2d};
use forge_mesh::cdt::{Cdt, SteinerOutcome};
use proptest::prelude::*;

/// splitmix64: a tiny deterministic generator driven by the proptest seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.unit()
    }
}

fn snap(x: f64, grid: Option<f64>) -> f64 {
    match grid {
        Some(g) => (x / g).round() * g,
        None => x,
    }
}

/// A star-shaped polygon around `c` (angles strictly increasing, so it is simple).
#[allow(clippy::too_many_arguments)]
fn star(
    rng: &mut Rng,
    c: Point2,
    n: usize,
    rmin: f64,
    rmax: f64,
    grid: Option<f64>,
    ccw: bool,
) -> Vec<Point2> {
    let mut pts: Vec<Point2> = (0..n)
        .map(|k| {
            let a = std::f64::consts::TAU * (k as f64 + rng.range(-0.4, 0.4)) / n as f64;
            let r = rng.range(rmin, rmax);
            let (s, co) = forge_core::math::sin_cos(a);
            Point2::new(snap(c.x + r * co, grid), snap(c.y + r * s, grid))
        })
        .collect();
    if !ccw {
        pts.reverse();
    }
    pts
}

fn twice_area(ring: &[Point2]) -> f64 {
    let n = ring.len();
    (0..n).map(|i| ring[i].perp_dot(ring[(i + 1) % n])).sum()
}

struct Case {
    rings: Vec<Vec<Point2>>,
    steiner: Vec<Point2>,
}

fn make_case(seed: u64, n_outer: usize, hole_mask: u8, snapped: bool, n_steiner: usize) -> Case {
    let mut rng = Rng(seed);
    let outer = star(
        &mut rng,
        Point2::new(0.0, 0.0),
        n_outer,
        6.0,
        10.0,
        snapped.then_some(1.0 / 16.0),
        true,
    );
    let mut rings = vec![outer];
    // Holes (distance 3.54 + radius ≤ 1 from the centre) fit only if the outer star
    // polygon's inradius exceeds 4.6: vertices at radius ≥ 6 with angular gaps ≤ 1.8·2π/n
    // guarantee 6·cos(0.9·π/n) > 4.6 for n ≥ 10.
    let hole_mask = if n_outer >= 10 { hole_mask } else { 0 };
    let centers = [(-2.5, -2.5), (2.5, -2.5), (2.5, 2.5), (-2.5, 2.5)];
    for (k, (x, y)) in centers.into_iter().enumerate() {
        if hole_mask & (1 << k) != 0 {
            let n = 3 + (rng.next() % 10) as usize;
            rings.push(star(
                &mut rng,
                Point2::new(x, y),
                n,
                0.3,
                1.0,
                snapped.then_some(1.0 / 64.0),
                false,
            ));
        }
    }
    let steiner = (0..n_steiner)
        .map(|_| {
            let g = snapped.then_some(1.0 / 8.0);
            Point2::new(snap(rng.range(-6.0, 6.0), g), snap(rng.range(-6.0, 6.0), g))
        })
        .collect();
    Case { rings, steiner }
}

fn check_case(case: &Case) -> Result<(), TestCaseError> {
    let pts: Vec<Point2> = case.rings.iter().flatten().copied().collect();
    let mut min = pts[0];
    let mut max = pts[0];
    for p in &pts {
        min = Point2::new(min.x.min(p.x), min.y.min(p.y));
        max = Point2::new(max.x.max(p.x), max.y.max(p.y));
    }
    let mut cdt = Cdt::new(min, max).expect("cdt");
    for p in &pts {
        cdt.insert_point(*p).expect("insert point");
    }
    let mut segs = Vec::new();
    let mut base = 0u32;
    for r in &case.rings {
        let n = r.len() as u32;
        for k in 0..n {
            segs.push((base + k, base + (k + 1) % n));
        }
        base += n;
    }
    for &(a, b) in &segs {
        cdt.insert_constraint(a, b).expect("constraint");
    }
    for &(a, b) in &segs {
        prop_assert!(cdt.is_constrained(a, b), "constraint ({a}, {b}) missing");
    }
    cdt.mark_domain(&segs).expect("domain");
    for q in &case.steiner {
        match cdt.insert_steiner(*q).expect("steiner") {
            SteinerOutcome::Inserted(_) | SteinerOutcome::Rejected => {}
        }
    }
    let all: Vec<Point2> = (0..cdt.vertex_count() as u32)
        .map(|v| cdt.point(v))
        .collect();
    let tris = cdt.triangles();

    // Positive orientation and area.
    let mut area2 = 0.0;
    for t in &tris {
        let [a, b, c] = t.map(|k| all[k as usize]);
        prop_assert!(
            orient2d(a, b, c) > 0.0,
            "triangle {t:?} is not counter-clockwise"
        );
        area2 += (b - a).perp_dot(c - a);
    }
    let expect2: f64 = case.rings.iter().map(|r| twice_area(r)).sum();
    prop_assert!(
        (area2 - expect2).abs() <= 1e-9 * expect2.abs(),
        "area {area2} != polygon area {expect2}"
    );

    // Edge manifoldness: interior edges twice in opposite directions, boundary edges once
    // and exactly the constraints (in their domain-on-the-left direction).
    let mut directed: BTreeMap<(u32, u32), usize> = BTreeMap::new();
    for t in &tris {
        for k in 0..3 {
            *directed.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
        }
    }
    prop_assert!(
        directed.values().all(|&c| c == 1),
        "a directed edge is used twice"
    );
    let seg_set: BTreeSet<(u32, u32)> = segs.iter().copied().collect();
    for &(a, b) in directed.keys() {
        if !directed.contains_key(&(b, a)) {
            prop_assert!(
                seg_set.contains(&(a, b)),
                "boundary edge ({a}, {b}) is not a constraint"
            );
        }
    }
    for s in &seg_set {
        prop_assert!(
            directed.contains_key(s),
            "constraint {s:?} not on the domain boundary"
        );
    }
    // Every input point is used.
    let used: BTreeSet<u32> = tris.iter().flatten().copied().collect();
    for v in 0..pts.len() as u32 {
        prop_assert!(used.contains(&v), "input point {v} unused");
    }
    // Delaunay on unconstrained interior edges.
    for (t, d) in cdt.interior_edge_pairs() {
        let [a, b, c] = t.map(|k| all[k as usize]);
        prop_assert!(
            incircle(a, b, c, all[d as usize]) <= 0.0,
            "edge of {t:?} is not locally Delaunay (opposite vertex {d})"
        );
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn cdt_of_random_polygons_with_holes_is_valid(
        seed in any::<u64>(),
        n_outer in 3usize..40,
        hole_mask in 0u8..16,
        snapped in any::<bool>(),
        n_steiner in 0usize..60,
    ) {
        let case = make_case(seed, n_outer, hole_mask, snapped, n_steiner);
        check_case(&case)?;
    }
}

#[test]
fn cdt_is_deterministic() {
    let case = make_case(42, 25, 0b1011, true, 40);
    let run = || {
        let pts: Vec<Point2> = case.rings.iter().flatten().copied().collect();
        let mut cdt = Cdt::new(Point2::new(-10.0, -10.0), Point2::new(10.0, 10.0)).expect("cdt");
        for p in &pts {
            cdt.insert_point(*p).expect("pt");
        }
        let mut segs = Vec::new();
        let mut base = 0u32;
        for r in &case.rings {
            let n = r.len() as u32;
            for k in 0..n {
                segs.push((base + k, base + (k + 1) % n));
            }
            base += n;
        }
        for &(a, b) in &segs {
            cdt.insert_constraint(a, b).expect("c");
        }
        cdt.mark_domain(&segs).expect("domain");
        for q in &case.steiner {
            cdt.insert_steiner(*q).expect("s");
        }
        cdt.triangles()
    };
    assert_eq!(run(), run());
}

#[test]
fn exact_grid_polygon_with_collinear_and_cocircular_points() {
    // A 12×12 lattice square with a square hole; all lattice points inside inserted:
    // maximal collinearity and cocircularity.
    let mut outer = Vec::new();
    for i in 0..12 {
        outer.push(Point2::new(i as f64, 0.0));
    }
    for j in 0..12 {
        outer.push(Point2::new(12.0, j as f64));
    }
    for i in (1..=12).rev() {
        outer.push(Point2::new(i as f64, 12.0));
    }
    for j in (1..=12).rev() {
        outer.push(Point2::new(0.0, j as f64));
    }
    let hole = vec![
        Point2::new(4.0, 4.0),
        Point2::new(4.0, 8.0),
        Point2::new(8.0, 8.0),
        Point2::new(8.0, 4.0),
    ];
    let mut steiner = Vec::new();
    for i in 1..12 {
        for j in 1..12 {
            steiner.push(Point2::new(i as f64, j as f64));
        }
    }
    let case = Case {
        rings: vec![outer, hole],
        steiner,
    };
    check_case(&case).expect("valid");
}
