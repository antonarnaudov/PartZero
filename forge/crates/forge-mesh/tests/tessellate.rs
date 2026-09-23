//! Tessellation of reference bodies: watertightness, deviation, volume convergence,
//! singular fans, determinism.

// Render and body meshes must agree bit for bit; exact comparisons are intended.
#![allow(clippy::float_cmp)]

mod common;

use forge_core::math;
use forge_core::topo::{Body, samples};
use forge_mesh::{
    BodyMesh, TessParams, check_watertight, max_deviation, mesh_volume, tessellate,
    tessellate_render,
};

fn params(delta: f64) -> TessParams {
    TessParams::new(delta, 1.0)
}

fn mesh(body: &Body, delta: f64) -> BodyMesh {
    match tessellate(body, &params(delta)) {
        Ok(m) => m,
        Err(e) => panic!("tessellation failed [{}]: {e}", e.code()),
    }
}

/// Watertight, within deflection, unit normals; returns the Euler characteristic.
fn assert_good(body: &Body, m: &BodyMesh, delta: f64) -> i64 {
    let stats = match check_watertight(m) {
        Ok(s) => s,
        Err(e) => panic!("not watertight: {e}"),
    };
    let dev = max_deviation(body, m).expect("deviation");
    assert!(dev <= delta, "max deviation {dev} > deflection {delta}");
    for n in &m.normals {
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        assert!((l - 1.0).abs() < 1e-5, "normal {n:?} is not unit");
    }
    assert!(m.positions.iter().flatten().all(|x| x.is_finite()));
    assert_eq!(
        m.face_ranges
            .iter()
            .map(|r| r.tri_count as usize)
            .sum::<usize>(),
        m.triangles.len()
    );
    stats.euler_characteristic
}

fn rel(a: f64, b: f64) -> f64 {
    ((a - b) / b).abs()
}

/// Volume errors at decreasing deflection must shrink by at least `min_ratio` per
/// decade and end below `final_bound`.
fn assert_converges(name: &str, errs: &[(f64, f64)], min_ratio: f64, final_bound: f64) {
    for (d, e) in errs {
        eprintln!("{name}: deflection {d:>7} -> relative volume error {e:.3e}");
    }
    for w in errs.windows(2) {
        assert!(
            w[1].1 * min_ratio <= w[0].1,
            "{name}: error did not shrink enough from δ={} ({:e}) to δ={} ({:e})",
            w[0].0,
            w[0].1,
            w[1].0,
            w[1].1
        );
    }
    let last = errs.last().expect("errors").1;
    assert!(last < final_bound, "{name}: final error {last:e}");
}

#[test]
fn unit_cube_is_twelve_triangles_with_exact_volume() {
    let body = samples::unit_cube();
    let m = mesh(&body, 0.01);
    assert_eq!(m.positions.len(), 8);
    assert_eq!(m.triangles.len(), 12);
    assert_eq!(m.face_ranges.len(), 6);
    assert!(m.face_ranges.iter().all(|r| r.tri_count == 2));
    assert_eq!(m.edge_polylines.len(), 12);
    assert!(m.edge_polylines.iter().all(|e| e.points.len() == 2));
    assert_eq!(assert_good(&body, &m, 1e-12), 2);
    assert!((mesh_volume(&m) - 1.0).abs() < 1e-14);
    assert_eq!(m.face_ranges[0].face_name, "cube/cap:start");
}

#[test]
fn max_edge_length_is_respected_on_planar_faces() {
    let body = samples::unit_cube();
    let p = params(0.01).with_max_edge_length(0.3);
    let m = tessellate(&body, &p).expect("mesh");
    assert_good(&body, &m, 1e-12);
    for t in &m.triangles {
        for k in 0..3 {
            let a = m.positions[t[k] as usize];
            let b = m.positions[t[(k + 1) % 3] as usize];
            let l = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
            assert!(l <= 0.3 + 1e-12, "edge length {l}");
        }
    }
    assert!((mesh_volume(&m) - 1.0).abs() < 1e-12);
}

#[test]
fn cylinder_with_ring_edges_is_watertight_within_deflection() {
    let body = samples::cylinder(10.0, 30.0);
    for delta in [0.5, 0.1, 0.01] {
        let m = mesh(&body, delta);
        assert_eq!(
            assert_good(&body, &m, delta),
            2,
            "sphere-like closed surface"
        );
        // No seam: the side face shares every vertex with the caps' rings.
        let side = &m.face_ranges[2];
        assert_eq!(side.face_name, "cyl/side:c");
        let n_ring = m.edge_polylines[0].points.len() - 1;
        assert_eq!(
            side.tri_count as usize,
            2 * n_ring,
            "a band of 2n triangles"
        );
    }
}

#[test]
fn cylinder_volume_converges_as_deflection_shrinks() {
    let body = samples::cylinder(10.0, 30.0);
    let exact = math::PI * 100.0 * 30.0;
    let errs: Vec<(f64, f64)> = [1.0, 0.1, 0.01, 0.001]
        .into_iter()
        .map(|d| (d, rel(mesh_volume(&mesh(&body, d)), exact)))
        .collect();
    // The inscribed polygon's error is linear in the deflection.
    assert_converges("cylinder", &errs, 5.0, 1.5e-4);
    assert!(errs[2].1 < 1e-3, "error at δ = 0.01 must be < 1e-3");
}

#[test]
fn sphere_without_loops_has_pole_fans_and_converges() {
    let r = 10.0;
    let body = samples::sphere(r);
    let exact = 4.0 / 3.0 * math::PI * r * r * r;
    let mut errs = Vec::new();
    for delta in [1.0, 0.1, 0.01] {
        let m = mesh(&body, delta);
        assert_eq!(assert_good(&body, &m, delta), 2);
        // Both poles are single vertices with the exact limit normals.
        for (z, nz) in [(r, 1.0f32), (-r, -1.0f32)] {
            let poles: Vec<usize> = (0..m.positions.len())
                .filter(|&i| {
                    let p = m.positions[i];
                    p[0] == 0.0 && p[1] == 0.0 && (p[2] - z).abs() < 1e-12
                })
                .collect();
            assert_eq!(poles.len(), 1, "one pole vertex at z = {z}");
            let n = m.normals[poles[0]];
            assert!(
                (n[2] - nz).abs() < 1e-6 && n[0].abs() < 1e-6,
                "pole normal {n:?}"
            );
            let fan = m
                .triangles
                .iter()
                .filter(|t| t.contains(&(poles[0] as u32)))
                .count();
            assert!(fan >= 3, "fan around the pole");
        }
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    assert_converges("sphere", &errs, 5.0, 2e-3);
}

#[test]
fn full_torus_without_loops_is_a_closed_genus_one_mesh() {
    let (big, small) = (10.0, 3.0);
    let body = common::torus(big, small);
    let exact = 2.0 * math::PI * math::PI * big * small * small;
    let mut errs = Vec::new();
    for delta in [0.5, 0.05, 0.005] {
        let m = mesh(&body, delta);
        assert_eq!(assert_good(&body, &m, delta), 0, "torus: χ = 0");
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    // Expected ≈ (area/volume)·(mean deviation ≈ 0.4δ) = (2/r)·0.4δ ≈ 1.3e-3 at δ = 0.005.
    assert_converges("torus", &errs, 5.0, 2e-3);
}

#[test]
fn full_cone_bounded_by_a_ring_has_an_apex_fan() {
    let (r, h) = (5.0, 12.0);
    let body = common::cone(r, h);
    let exact = math::PI * r * r * h / 3.0;
    let mut errs = Vec::new();
    for delta in [0.1, 0.01, 0.001] {
        let m = mesh(&body, delta);
        assert_eq!(assert_good(&body, &m, delta), 2);
        let apex: Vec<usize> = (0..m.positions.len())
            .filter(|&i| {
                let p = m.positions[i];
                p[0].abs() < 1e-12 && p[1].abs() < 1e-12 && (p[2] - h).abs() < 1e-12
            })
            .collect();
        assert_eq!(apex.len(), 1, "a single apex vertex");
        // Limit normal at the apex: the mean of the generators' normals = the axis.
        let n = m.normals[apex[0]];
        assert!(n[2] > 0.999 && n[0].abs() < 1e-3, "apex normal {n:?}");
        // The cone face is a pure fan: every side triangle touches the apex.
        let side = m
            .face_ranges
            .iter()
            .position(|f| f.face_name == "rev/side:slant")
            .expect("side");
        let ring_n = m.edge_polylines[0].points.len() - 1;
        let tris = m.face_triangles(side);
        assert_eq!(tris.len(), ring_n);
        assert!(tris.iter().all(|t| t.contains(&(apex[0] as u32))));
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    // Theory: the base polygon loses ≈ 4·(0.74δ)/(3r) ≈ 2e-4 at δ = 1e-3.
    assert_converges("cone", &errs, 5.0, 3e-4);
}

#[test]
fn hemisphere_bounded_by_its_equator_ring() {
    let r = 7.0;
    let body = common::hemisphere(r);
    let exact = 2.0 / 3.0 * math::PI * r * r * r;
    let mut errs = Vec::new();
    for delta in [0.1, 0.01, 0.001] {
        let m = mesh(&body, delta);
        assert_eq!(assert_good(&body, &m, delta), 2);
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    assert_converges("hemisphere", &errs, 5.0, 2e-4);
}

#[test]
fn plate_with_multiple_circular_holes() {
    let holes = [(20.0, 20.0, 5.0), (50.0, 30.0, 8.0), (80.0, 40.0, 4.0)];
    let (w, d, h) = (100.0, 60.0, 10.0);
    let body = common::plate_with_holes(w, d, h, &holes);
    let exact = w * d * h - holes.iter().map(|x| math::PI * x.2 * x.2 * h).sum::<f64>();
    let mut errs = Vec::new();
    for delta in [0.1, 0.01, 0.001] {
        let m = mesh(&body, delta);
        // Genus 3 (three through holes): χ = 2 − 2·3.
        assert_eq!(assert_good(&body, &m, delta), -4);
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    assert_converges("plate", &errs, 5.0, 1e-5);
}

#[test]
fn partial_cylinder_face_bounded_by_arcs_and_lines_without_pcurves() {
    let (r, h) = (10.0, 30.0);
    let body = common::half_cylinder(r, h);
    let exact = 0.5 * math::PI * r * r * h;
    let mut errs = Vec::new();
    for delta in [0.1, 0.01, 0.001] {
        let m = mesh(&body, delta);
        assert_eq!(assert_good(&body, &m, delta), 2);
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    assert_converges("half cylinder", &errs, 5.0, 1e-4);
}

#[test]
fn triangle_counts_are_reasonable() {
    // Cylinder r = 10 at δ = 0.1: n ring segments, 2n side triangles, ~n caps each.
    let m = mesh(&samples::cylinder(10.0, 30.0), 0.1);
    let n = m.edge_polylines[0].points.len() - 1;
    let expect_n = (math::TAU / (2.0 * math::acos(1.0 - 0.075 / 10.0))).ceil() as usize;
    assert_eq!(n, expect_n);
    assert_eq!(m.triangles.len(), 2 * n + 2 * (n - 2));
    // Sphere r = 10 at δ = 0.1: a few thousand triangles, not tens of thousands.
    let s = mesh(&samples::sphere(10.0), 0.1);
    assert!(
        (500..6000).contains(&s.triangles.len()),
        "sphere triangles: {}",
        s.triangles.len()
    );
    eprintln!(
        "triangles: cylinder(δ=0.1) {}, sphere(δ=0.1) {}",
        m.triangles.len(),
        s.triangles.len()
    );
}

/// FNV-1a over the exact bits of a mesh.
fn fingerprint(m: &BodyMesh) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for p in &m.positions {
        for x in p {
            eat(&x.to_bits().to_le_bytes());
        }
    }
    for n in &m.normals {
        for x in n {
            eat(&x.to_bits().to_le_bytes());
        }
    }
    for t in &m.triangles {
        for x in t {
            eat(&x.to_le_bytes());
        }
    }
    for f in &m.face_ranges {
        eat(f.face_name.as_bytes());
        eat(&f.tri_start.to_le_bytes());
        eat(&f.tri_count.to_le_bytes());
    }
    for e in &m.edge_polylines {
        eat(e.edge_name.as_bytes());
        for p in &e.points {
            for x in p {
                eat(&x.to_bits().to_le_bytes());
            }
        }
    }
    h
}

#[test]
fn tessellation_is_deterministic() {
    let bodies = [
        samples::unit_cube(),
        samples::cylinder(10.0, 30.0),
        samples::sphere(10.0),
        common::torus(10.0, 3.0),
        common::cone(5.0, 12.0),
        common::plate_with_holes(100.0, 60.0, 10.0, &[(20.0, 20.0, 5.0), (60.0, 30.0, 8.0)]),
        common::half_cylinder(10.0, 30.0),
    ];
    for b in &bodies {
        let a = mesh(b, 0.05);
        let c = mesh(b, 0.05);
        assert_eq!(fingerprint(&a), fingerprint(&c));
    }
}

#[test]
fn render_mesh_matches_body_mesh() {
    for body in [samples::cylinder(10.0, 30.0), common::cone(5.0, 12.0)] {
        let m = mesh(&body, 0.05);
        let r = tessellate_render(&body, &params(0.05)).expect("render");
        assert_eq!(r.triangles.len(), m.triangles.len());
        assert_eq!(r.face_ranges, m.face_ranges);
        // The same edge discretization, from the same run.
        assert_eq!(r.edge_polylines, m.edge_polylines);
        // Same triangles geometrically.
        for (a, b) in m.triangles.iter().zip(&r.triangles) {
            for k in 0..3 {
                let p = m.positions[a[k] as usize];
                let q = r.positions[b[k] as usize];
                assert_eq!([p[0] as f32, p[1] as f32, p[2] as f32], q);
            }
        }
        // Creased normals: every cap vertex points along the cap normal exactly.
        let cap = &r.face_ranges[0];
        for t in &r.triangles[cap.tri_start as usize..(cap.tri_start + cap.tri_count) as usize] {
            for &k in t {
                assert!((r.normals[k as usize][2] + 1.0).abs() < 1e-6);
            }
        }
    }
}

#[test]
fn invalid_parameters_are_rejected_with_codes() {
    let body = samples::unit_cube();
    for p in [
        TessParams::new(0.0, 0.5),
        TessParams::new(f64::NAN, 0.5),
        TessParams::new(1e-9, 0.5),
        TessParams::new(0.1, 0.0),
        TessParams::new(0.1, 4.0),
        TessParams::new(0.1, 0.5).with_max_edge_length(-1.0),
    ] {
        let e = tessellate(&body, &p).unwrap_err();
        assert_eq!(e.code(), "MESH_INVALID_PARAMS");
    }
}

#[test]
fn edge_polylines_are_the_shared_boundary_vertices() {
    let m = mesh(&samples::cylinder(10.0, 30.0), 0.1);
    for e in &m.edge_polylines {
        // Ring edges are closed polylines.
        assert_eq!(e.points.first(), e.points.last());
        for p in &e.points {
            assert!(m.positions.contains(p));
        }
    }
}

#[test]
fn cone_wedge_with_an_apex_vertex_uses_a_singular_jump() {
    let (r, h) = (5.0, 12.0);
    let body = common::cone_wedge(r, h);
    let exact = math::PI * r * r * h / 12.0;
    let mut errs = Vec::new();
    for delta in [0.1, 0.01, 0.001] {
        let m = mesh(&body, delta);
        assert_eq!(assert_good(&body, &m, delta), 2);
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    assert_converges("cone wedge", &errs, 5.0, 3e-4);
}

/// Phase 0 audit V1: `gen_s23_00000/00101/00116/00159/00169` (revolves whose profile
/// touches the axis at a point) failed export with "refinement stopped … estimated
/// deviation inf". The cone apex vertex's pcurve `v` had rounded a few ulps onto the other
/// nappe, where `Cone::normal` flips; every normal-angle test next to the apex then
/// failed and refinement crowded points into the apex. The face's nappe now decides.
#[test]
fn cone_apex_vertex_rounded_onto_the_other_nappe_still_meshes() {
    let (r, h) = (5.0, 12.0);
    let exact = math::PI * r * r * h / 12.0;
    for ulps in [0, 1, 2, 8, 64] {
        let body = common::cone_wedge_apex_rounding(r, h, ulps);
        let mut errs = Vec::new();
        for delta in [0.1, 0.01] {
            let m = mesh(&body, delta);
            assert_eq!(assert_good(&body, &m, delta), 2, "{ulps} ulps");
            errs.push((delta, rel(mesh_volume(&m), exact)));
        }
        assert_converges(&format!("cone wedge, apex +{ulps} ulps"), &errs, 5.0, 3e-3);
    }
}

#[test]
fn pipe_elbow_torus_face_wrapping_in_v() {
    let (big, r) = (10.0, 3.0);
    let body = common::pipe_elbow(big, r);
    // Pappus: disc area × centroid path length.
    let exact = math::PI * r * r * big * math::FRAC_PI_2;
    let mut errs = Vec::new();
    for delta in [0.1, 0.01, 0.001] {
        let m = mesh(&body, delta);
        assert_eq!(assert_good(&body, &m, delta), 2);
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    assert_converges("pipe elbow", &errs, 5.0, 3e-4);
}

#[test]
fn periodic_band_with_a_hole_in_a_windowed_tube() {
    let (ro, ri, h) = (10.0, 8.0, 30.0);
    let (u1, u2, z1, z2) = (0.5, 1.5, 10.0, 20.0);
    let body = common::windowed_tube(ro, ri, h, u1, u2, z1, z2);
    let exact =
        math::PI * (ro * ro - ri * ri) * h - 0.5 * (ro * ro - ri * ri) * (u2 - u1) * (z2 - z1);
    let mut errs = Vec::new();
    for delta in [0.1, 0.01, 0.001] {
        let m = mesh(&body, delta);
        // A tube is a solid torus (genus 1); the window adds a handle: χ = 2 − 2·2.
        assert_eq!(assert_good(&body, &m, delta), -2);
        errs.push((delta, rel(mesh_volume(&m), exact)));
    }
    assert_converges("windowed tube", &errs, 5.0, 3e-4);
}

#[test]
fn bspline_sheet_meets_the_deflection_and_has_only_its_border_open() {
    for with_pcurves in [true, false] {
        let body = common::bspline_sheet(with_pcurves);
        let mut areas = Vec::new();
        // Coarse deflections: `max_deviation` projects 13 points per triangle onto the
        // B-spline (grid-seeded Newton), which dominates the test time in debug builds.
        for delta in [0.2, 0.05] {
            let m = mesh(&body, delta);
            let dev = max_deviation(&body, &m).expect("deviation");
            assert!(dev <= delta, "deviation {dev} > {delta}");
            // An open sheet: the only open edges are the border polylines' segments.
            let border: usize = m.edge_polylines.iter().map(|e| e.points.len() - 1).sum();
            let e = check_watertight(&m).unwrap_err();
            assert_eq!(e.issue, forge_mesh::WatertightIssue::BoundaryEdge);
            assert_eq!(
                (e.boundary_edges, e.nonmanifold_edges, e.misoriented_edges),
                (border, 0, 0)
            );
            areas.push(forge_mesh::mesh_area(&m));
        }
        // The mesh area settles as the deflection shrinks.
        assert!(
            ((areas[1] - areas[0]) / areas[1]).abs() < 1e-2,
            "areas {areas:?}"
        );
    }
}

/// Bit-level determinism guard: fingerprints recorded on the reference platform. **If
/// this fails on a new platform or toolchain, tessellation is not bit-identical across
/// targets** — investigate before touching the constants; update them only for an
/// intentional algorithm change (and say so in the commit message).
#[test]
fn golden_fingerprints_are_stable() {
    let cases: [(&str, Body, f64, u64); 5] = [
        ("cylinder", samples::cylinder(10.0, 30.0), 0.1, GOLDEN[0]),
        ("sphere", samples::sphere(10.0), 0.5, GOLDEN[1]),
        ("torus", common::torus(10.0, 3.0), 0.5, GOLDEN[2]),
        ("cone wedge", common::cone_wedge(5.0, 12.0), 0.05, GOLDEN[3]),
        (
            "windowed tube",
            common::windowed_tube(10.0, 8.0, 30.0, 0.5, 1.5, 10.0, 20.0),
            0.1,
            GOLDEN[4],
        ),
    ];
    let mut report = Vec::new();
    for (name, body, delta, _) in &cases {
        report.push(format!(
            "{name}: {:#018x}",
            fingerprint(&mesh(body, *delta))
        ));
    }
    eprintln!("{}", report.join("\n"));
    for ((name, body, delta, want), line) in cases.iter().zip(&report) {
        assert_eq!(
            fingerprint(&mesh(body, *delta)),
            *want,
            "{name} changed: {line}"
        );
    }
}

const GOLDEN: [u64; 5] = [
    0xe905_55ae_c26b_4d47,
    0xb108_3086_38dd_aa45,
    0x7861_06b0_593d_33f7,
    0x6a53_b01b_0058_1a2b,
    0x015d_6109_7a7c_05ec,
];

#[test]
fn unsupported_or_invalid_faces_fail_loudly_with_codes() {
    use forge_core::geom::{Circle3, Curve3, Cylinder, Plane, Surface};
    use forge_core::topo::{BodyBuilder, Provenance};
    use forge_core::{Frame, Vec3};

    // A cylinder face bounded by a single ring is unbounded.
    let mut b = BodyBuilder::new();
    let ring = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(Frame::world(), 5.0).expect("c")),
            Provenance::edge_between("x", "x/a", "x/b"),
        )
        .expect("ring");
    let shell = b.add_shell(false);
    let cyl = Cylinder::new(Frame::world(), 5.0).expect("cyl");
    let f = b
        .add_face(
            shell,
            Surface::Cylinder(cyl),
            true,
            Provenance::side("x", "c"),
        )
        .expect("f");
    b.add_loop(f, &[(ring, true)]).expect("loop");
    let e = tessellate(&b.finish(), &params(0.1)).unwrap_err();
    assert_eq!(e.code(), "MESH_UNBOUNDED_FACE", "{e}");

    // A planar face whose hole crosses its outer loop.
    let mut b = BodyBuilder::new();
    let outer = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(Frame::world(), 10.0).expect("c")),
            Provenance::edge_between("y", "y/a", "y/b"),
        )
        .expect("ring");
    let hole_frame = Frame::from_normal_x(
        Vec3::new(7.0, 0.0, 0.0),
        Vec3::unit_z(),
        Vec3::new(-1.0, 0.0, 0.0),
    )
    .expect("frame");
    let hole = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(hole_frame, 4.0).expect("c")),
            Provenance::edge_between("y", "y/a", "y/c"),
        )
        .expect("ring");
    let shell = b.add_shell(false);
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            true,
            Provenance::side("y", "p"),
        )
        .expect("f");
    b.add_loop(f, &[(outer, true)]).expect("loop");
    b.add_loop(f, &[(hole, false)]).expect("loop");
    let e = tessellate(&b.finish(), &params(0.1)).unwrap_err();
    assert_eq!(e.code(), "MESH_TRIANGULATION", "{e}");
    match e {
        forge_mesh::MeshError::Triangulation { face, source } => {
            assert_eq!(face, "y/side:p");
            assert_eq!(source.code(), "CDT_CONSTRAINTS_CROSS");
        }
        other => panic!("unexpected {other}"),
    }
}

/// Volume of the solid bounded by a spindle-torus sheet, by revolving the meridian
/// region: outer sheet `ρ ∈ [max(0, R − s), R + s]`, inner sheet `ρ ∈ [0, s − R]`, with
/// `s = √(r² − z²)` (composite midpoint rule, 400k panels).
fn spindle_volume(big: f64, r: f64, outer: bool) -> f64 {
    let zmax = if outer { r } else { (r * r - big * big).sqrt() };
    let n = 400_000;
    let h = 2.0 * zmax / n as f64;
    let mut acc = 0.0;
    for i in 0..n {
        let z = -zmax + (i as f64 + 0.5) * h;
        let s = (r * r - z * z).max(0.0).sqrt();
        let (lo, hi) = if outer {
            ((big - s).max(0.0), big + s)
        } else {
            (0.0, (s - big).max(0.0))
        };
        acc += hi * hi - lo * lo;
    }
    math::PI * acc * h
}

#[test]
fn spindle_torus_patches_mesh_like_spheres_with_axis_fans() {
    use forge_core::SpindlePatch;
    let (big, r) = (2.0, 3.0);
    // Final bounds ≈ (area/volume)·0.4δ: the small lemon has a large area/volume ratio.
    for (patch, outer, bound) in [
        (SpindlePatch::Outer, true, 3e-3),
        (SpindlePatch::Inner, false, 6e-3),
    ] {
        let body = common::spindle(big, r, patch);
        let exact = spindle_volume(big, r, outer);
        let mut errs = Vec::new();
        for delta in [0.05, 0.005] {
            let m = mesh(&body, delta);
            assert_eq!(assert_good(&body, &m, delta), 2, "{patch:?}: sphere-like");
            // Both axis points are single mesh vertices.
            let zs = r * math::sin(math::acos(-big / r));
            for z in [zs, -zs] {
                let n = m
                    .positions
                    .iter()
                    .filter(|p| p[0].abs() < 1e-12 && p[1].abs() < 1e-12 && (p[2] - z).abs() < 1e-9)
                    .count();
                assert_eq!(n, 1, "{patch:?}: axis point at z = {z}");
            }
            errs.push((delta, rel(mesh_volume(&m), exact)));
        }
        assert_converges(&format!("spindle {patch:?}"), &errs, 5.0, bound);
    }
}
