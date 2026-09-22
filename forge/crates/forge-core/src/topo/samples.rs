//! Hand-built reference bodies, constructed with [`BodyBuilder`] exactly as a modelling
//! operation would (with provenance and pcurves). Used by tests here and in downstream
//! crates (meshing, mass properties, I/O).

use std::collections::BTreeMap;

use super::{Body, BodyBuilder, Provenance};
use crate::geom::{
    Circle2, Circle3, Curve2, Curve3, Cylinder, Line2, Line3, Plane, Sphere, Surface,
};
use crate::linalg::{Frame, Vec2, Vec3};

/// The unit cube `[0, 1]³`, modelled as the extrude `"cube"` of a square sketch whose
/// curves `s0..s3` run counter-clockwise from the origin: 6 planar faces (`cap:start` at
/// z = 0 with `sense = false`, `cap:end` at z = 1, `side:s0..s3`), 12 line edges, 8
/// vertices, and a line pcurve on every coedge.
pub fn unit_cube() -> Body {
    const F: &str = "cube";
    // Vertex i sits at (i & 1, (i >> 1) & 1, (i >> 2) & 1).
    let pos = |i: usize| Vec3::new((i & 1) as f64, ((i >> 1) & 1) as f64, ((i >> 2) & 1) as f64);
    let frame = |o: [f64; 3], n: [f64; 3], x: [f64; 3]| {
        Frame::from_normal_x(o.into(), n.into(), x.into()).expect("axis-aligned frame")
    };
    // (provenance, plane frame, sense, vertex cycle counter-clockwise about the outward
    // normal).
    let faces: [(Provenance, Frame, bool, [usize; 4]); 6] = [
        (
            Provenance::cap_start(F),
            Frame::world(),
            false,
            [0, 2, 3, 1],
        ),
        (
            Provenance::cap_end(F),
            frame([0.0, 0.0, 1.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
            true,
            [4, 5, 7, 6],
        ),
        (
            Provenance::side(F, "s0"),
            frame([0.0; 3], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
            true,
            [0, 1, 5, 4],
        ),
        (
            Provenance::side(F, "s1"),
            frame([1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            true,
            [1, 3, 7, 5],
        ),
        (
            Provenance::side(F, "s2"),
            frame([0.0, 1.0, 0.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]),
            true,
            [2, 6, 7, 3],
        ),
        (
            Provenance::side(F, "s3"),
            frame([0.0; 3], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
            true,
            [0, 4, 6, 2],
        ),
    ];

    // Which faces meet at each edge and vertex (for provenance names).
    let mut edge_faces: BTreeMap<(usize, usize), Vec<String>> = BTreeMap::new();
    let mut vertex_faces: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for (prov, _, _, cyc) in &faces {
        for k in 0..4 {
            let (a, b) = (cyc[k], cyc[(k + 1) % 4]);
            edge_faces
                .entry((a.min(b), a.max(b)))
                .or_default()
                .push(prov.name());
            vertex_faces.entry(a).or_default().push(prov.name());
        }
    }

    let mut b = BodyBuilder::new();
    let verts: Vec<_> = (0..8)
        .map(|i| {
            b.add_vertex(pos(i), Provenance::vertex_at(F, vertex_faces[&i].clone()))
                .expect("vertex")
        })
        .collect();
    let mut edges = BTreeMap::new();
    for (&(a, c), names) in &edge_faces {
        let line = Line3::through(pos(a), pos(c)).expect("distinct corners");
        let prov = Provenance::edge_between(F, names[0].clone(), names[1].clone());
        let e = b
            .add_edge(Curve3::Line(line), (0.0, 1.0), verts[a], verts[c], prov)
            .expect("edge");
        edges.insert((a, c), e);
    }
    let shell = b.add_shell(true);
    for (prov, fr, sense, cyc) in faces {
        let face = b
            .add_face(shell, Surface::Plane(Plane::new(fr)), sense, prov)
            .expect("face");
        let uses: Vec<_> = (0..4)
            .map(|k| {
                let (a, c) = (cyc[k], cyc[(k + 1) % 4]);
                (edges[&(a.min(c), a.max(c))], a < c)
            })
            .collect();
        let lp = b.add_loop(face, &uses).expect("closed loop");
        // Pcurves: the edge line expressed in the face plane, same parameter.
        let coedges = b.body().loop_(lp).expect("loop").coedges.clone();
        for (cid, (eid, _)) in coedges.into_iter().zip(uses) {
            let Curve3::Line(l) = &b.body().edge(eid).expect("edge").curve else {
                unreachable!()
            };
            let o = fr.to_local_point(l.origin());
            let d = fr.to_local_vector(l.dir());
            let pc =
                Line2::new(Vec2::new(o.x, o.y), Vec2::new(d.x, d.y)).expect("in-plane direction");
            b.set_pcurve(cid, Curve2::Line(pc)).expect("pcurve");
        }
    }
    b.finish()
}

/// A closed cylinder of the given radius and height on the world XY plane, modelled as
/// the extrude `"cyl"` of a circle `c`: 3 faces (planar `cap:start` with
/// `sense = false`, planar `cap:end`, cylindrical `side:c`), 2 **ring** edges, **no
/// vertices and no seam**. The side face is bounded by two ring loops.
///
/// # Panics
/// If `radius` or `height` is not finite and positive.
pub fn cylinder(radius: f64, height: f64) -> Body {
    assert!(
        radius.is_finite() && radius > 0.0 && height.is_finite() && height > 0.0,
        "invalid cylinder size"
    );
    const F: &str = "cyl";
    let bottom_frame = Frame::world();
    let top_frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, height));
    let cap_start = Provenance::cap_start(F);
    let cap_end = Provenance::cap_end(F);
    let side = Provenance::side(F, "c");

    let mut b = BodyBuilder::new();
    let bottom = Circle3::new(bottom_frame, radius).expect("radius");
    let top = Circle3::new(top_frame, radius).expect("radius");
    let e_bot = b
        .add_ring_edge(
            Curve3::Circle(bottom),
            Provenance::edge_between(F, cap_start.name(), side.name()),
        )
        .expect("ring");
    let e_top = b
        .add_ring_edge(
            Curve3::Circle(top),
            Provenance::edge_between(F, cap_end.name(), side.name()),
        )
        .expect("ring");

    let shell = b.add_shell(true);
    let circle_pc = Curve2::Circle(Circle2::new(Vec2::zero(), radius).expect("radius"));
    let f_bot = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(bottom_frame)),
            false,
            cap_start,
        )
        .expect("face");
    let l = b.add_loop(f_bot, &[(e_bot, false)]).expect("ring loop");
    set_single_pcurve(&mut b, l, circle_pc.clone());

    let f_top = b
        .add_face(shell, Surface::Plane(Plane::new(top_frame)), true, cap_end)
        .expect("face");
    let l = b.add_loop(f_top, &[(e_top, true)]).expect("ring loop");
    set_single_pcurve(&mut b, l, circle_pc);

    let cyl = Cylinder::new(Frame::world(), radius).expect("radius");
    let f_side = b
        .add_face(shell, Surface::Cylinder(cyl), true, side)
        .expect("face");
    let l = b.add_loop(f_side, &[(e_bot, true)]).expect("ring loop");
    set_single_pcurve(
        &mut b,
        l,
        Curve2::Line(Line2::new(Vec2::zero(), Vec2::unit_x()).expect("line")),
    );
    let l = b.add_loop(f_side, &[(e_top, false)]).expect("ring loop");
    set_single_pcurve(
        &mut b,
        l,
        Curve2::Line(Line2::new(Vec2::new(0.0, height), Vec2::unit_x()).expect("line")),
    );
    b.finish()
}

fn set_single_pcurve(b: &mut BodyBuilder, lp: super::LoopId, pc: Curve2) {
    let cid = b.body().loop_(lp).expect("loop").coedges[0];
    b.set_pcurve(cid, pc).expect("pcurve");
}

/// A sphere of the given radius about the origin, modelled as the full revolve `"ball"`
/// of a half-disc with arc `a`: **one face with no loops**, no edges, no vertices (the
/// poles are surface singularities).
///
/// # Panics
/// If `radius` is not finite and positive.
pub fn sphere(radius: f64) -> Body {
    let mut b = BodyBuilder::new();
    let shell = b.add_shell(true);
    let s = Sphere::new(Frame::world(), radius).expect("sphere radius must be finite and > 0");
    b.add_face(
        shell,
        Surface::Sphere(s),
        true,
        Provenance::side("ball", "a"),
    )
    .expect("face");
    b.finish()
}
