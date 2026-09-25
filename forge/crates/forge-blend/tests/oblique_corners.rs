//! Chamfer corners of three edges. The corner Forge builds is the triangle through the three
//! contact-line corners; on a convex prism the chamfered body is then the convex polytope
//! bounded by the prism's faces, the three bevel planes and the corner plane, whose volume is
//! computed here independently (the polytope's vertices from the half-spaces, then faces
//! fanned from the centroid) from the SPEC's definition of the bevels (distance `d` from the
//! edge on each face), never from Forge's construction.
//!
//! W6 review round 6: SPEC §6.7 defines no chamfer corner, and at vertices whose faces are not
//! mutually perpendicular OCCT's corner differs from the triangle by up to 2e-3 of the volume
//! — beyond §8.3 rule 5's 1e-5, so such a row is potential silent-wrong under the SPEC's
//! comparison. Forge builds the corner only where the faces are mutually perpendicular (the
//! two engines agree there) and fails explicitly elsewhere, naming the vertex, until the
//! Contract stage defines the chamfer corner.

mod common;

use common::polytope::{Half, chamfer_halves, polytope_volume};
use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer};
use forge_core::linalg::{Point3, Vec3};
use forge_core::topo::Body;

fn opts() -> BlendOptions {
    BlendOptions::new("c1")
}

/// A convex prism of the polygon `poly` (counter-clockwise) from z = 0 to `h`, as a body and as
/// half-spaces.
fn prism_body(poly: &[[f64; 2]], h: f64) -> (Body, Vec<Half>) {
    let b = prism("base", 0.0, polygon(poly), h);
    let mut hs: Vec<Half> = vec![
        (Point3::new(0.0, 0.0, 0.0), Vec3::new(0.0, 0.0, -1.0)),
        (Point3::new(0.0, 0.0, h), Vec3::new(0.0, 0.0, 1.0)),
    ];
    for i in 0..poly.len() {
        let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
        let d = Vec3::new(q[0] - p[0], q[1] - p[1], 0.0);
        hs.push((
            Point3::new(p[0], p[1], 0.0),
            Vec3::new(d.y, -d.x, 0.0).normalize().unwrap(),
        ));
    }
    (b, hs)
}

/// Index of the half-space of `hs` whose plane holds the side `i` of the polygon.
fn side(i: usize) -> usize {
    2 + i
}

fn check_corner(poly: &[[f64; 2]], h: f64, corner: usize, d: f64) {
    let (b, hs) = prism_body(poly, h);
    let n = poly.len();
    let p = poly[corner];
    let vtx = Point3::new(p[0], p[1], h);
    // Edges at the top vertex: the top edges to the next and previous polygon points, and
    // the vertical edge.
    let next = poly[(corner + 1) % n];
    let prev = poly[(corner + n - 1) % n];
    let e_next = edge_near(&b, [(p[0] + next[0]) / 2.0, (p[1] + next[1]) / 2.0, h]);
    let e_prev = edge_near(&b, [(p[0] + prev[0]) / 2.0, (p[1] + prev[1]) / 2.0, h]);
    let e_vert = edge_near(&b, [p[0], p[1], h / 2.0]);
    let dir = |q: [f64; 2]| {
        Vec3::new(q[0] - p[0], q[1] - p[1], 0.0)
            .normalize()
            .unwrap()
    };
    let (s_next, s_prev) = (side(corner), side((corner + n - 1) % n));
    let halves = chamfer_halves(
        &hs,
        vtx,
        [dir(next), dir(prev), Vec3::new(0.0, 0.0, -1.0)],
        [(1, s_next), (1, s_prev), (s_next, s_prev)],
        d,
    );
    let mut all = hs.clone();
    all.extend(halves);
    let expect = polytope_volume(&all);
    let out = chamfer(
        &b,
        &es(&b, &[e_next, e_prev, e_vert]),
        &ChamferSpec::Equal { d },
        &opts(),
    )
    .unwrap_or_else(|e| panic!("corner {corner} of {poly:?}: {} {e}", e.code()));
    assert_valid(&out.body);
    assert!(
        forge_blend::self_intersections(&out.body)
            .expect("certified")
            .is_empty()
    );
    let v = volume(&out.body);
    assert!(
        rel(v, expect) < 1e-10,
        "corner {corner} of {poly:?}: Forge {v} vs the polytope {expect} (base {})",
        polytope_volume(&hs)
    );
    // The corner triangle is one planar face with three edges.
    let tri = out
        .body
        .faces()
        .iter()
        .filter(|(_, f)| f.provenance.key().starts_with("c1/corner:"))
        .count();
    assert_eq!(tri, 1);
}

#[test]
fn the_polytope_volume_is_exact_on_a_cube_corner() {
    // Sanity of the independent check: the unit cube, and the cube with its corner chamfered
    // perpendicularly (the normative planar corner: 1 − 3·d²/2 + tetrahedron terms).
    let (_, hs) = prism_body(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], 1.0);
    assert!((polytope_volume(&hs) - 1.0).abs() < 1e-12);
}

/// The three chamfered edges at the top vertex `corner` of the prism.
fn corner_edges(
    b: &Body,
    poly: &[[f64; 2]],
    h: f64,
    corner: usize,
) -> Vec<forge_core::topo::EdgeId> {
    let n = poly.len();
    let p = poly[corner];
    let next = poly[(corner + 1) % n];
    let prev = poly[(corner + n - 1) % n];
    vec![
        edge_near(b, [(p[0] + next[0]) / 2.0, (p[1] + next[1]) / 2.0, h]),
        edge_near(b, [(p[0] + prev[0]) / 2.0, (p[1] + prev[1]) / 2.0, h]),
        edge_near(b, [p[0], p[1], h / 2.0]),
    ]
}

/// The corner at an oblique vertex is an explicit `CHAMFER_FAILED` naming the vertex and the
/// three edges, never a body.
fn check_refused(poly: &[[f64; 2]], h: f64, corner: usize, d: f64) {
    let (b, _) = prism_body(poly, h);
    let edges = corner_edges(&b, poly, h, corner);
    let err = chamfer(&b, &es(&b, &edges), &ChamferSpec::Equal { d }, &opts())
        .expect_err("an oblique chamfer corner is refused");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
    let msg = err.to_string();
    assert!(
        msg.contains("not mutually perpendicular") && msg.contains("Contract ruling"),
        "{msg}"
    );
    let p = poly[corner];
    let keys = forge_blend::KeyMap::derive(&b);
    let vtx = b
        .vertices()
        .iter()
        .find(|(_, v)| v.point.distance(Point3::new(p[0], p[1], h)) < 1e-9)
        .map(|(id, _)| id)
        .expect("vertex");
    let vname = keys.vertex(vtx).expect("vertex name").name;
    assert!(msg.contains(&vname), "{msg} names {vname}");
    let named: Vec<String> = err.details()["edges"]
        .as_array()
        .expect("edges")
        .iter()
        .map(|x| x["key"].as_str().unwrap_or_default().to_string())
        .collect();
    for e in &edges {
        let k = keys.edge(*e).expect("edge").key;
        assert!(named.contains(&k), "{named:?} lacks {k}");
    }
}

#[test]
fn a_triangular_prism_corner_is_refused_until_the_contract_defines_it() {
    let tri = [[0.0, 0.0], [30.0, 0.0], [10.0, 20.0]];
    for corner in 0..3 {
        check_refused(&tri, 15.0, corner, 1.5);
    }
}

#[test]
fn a_hexagonal_prism_corner_is_refused_until_the_contract_defines_it() {
    let hex: Vec<[f64; 2]> = (0..6)
        .map(|i| {
            let a = std::f64::consts::PI / 3.0 * i as f64;
            [20.0 + 12.0 * a.cos(), 20.0 + 12.0 * a.sin()]
        })
        .collect();
    check_refused(&hex, 10.0, 0, 1.2);
    check_refused(&hex, 10.0, 3, 2.5);
}

#[test]
fn two_chamfers_at_an_oblique_vertex_still_build() {
    // Only the three-edge corner is refused: two chamfered top edges meet in their mitre.
    let tri = [[0.0, 0.0], [30.0, 0.0], [10.0, 20.0]];
    let (b, _) = prism_body(&tri, 15.0);
    let edges = corner_edges(&b, &tri, 15.0, 2);
    let out = chamfer(
        &b,
        &es(&b, &edges[..2]),
        &ChamferSpec::Equal { d: 1.5 },
        &opts(),
    )
    .expect("two chamfers at an oblique vertex");
    assert_valid(&out.body);
}

#[test]
fn a_perpendicular_corner_is_the_corner_triangle() {
    let sq = [[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [0.0, 10.0]];
    for corner in 0..4 {
        check_corner(&sq, 8.0, corner, 2.0);
    }
    // A rotated square prism: perpendicular within ANGULAR_TOLERANCE, whatever the
    // rounding of its normals.
    let (c, sn) = (0.6f64, 0.8f64);
    let rot: Vec<[f64; 2]> = sq
        .iter()
        .map(|p| [5.0 + c * p[0] - sn * p[1], 5.0 + sn * p[0] + c * p[1]])
        .collect();
    check_corner(&rot, 8.0, 1, 1.5);
}
