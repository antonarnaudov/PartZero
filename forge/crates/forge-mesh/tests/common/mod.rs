//! Reference bodies built with `BodyBuilder` for the tessellation tests (in addition to
//! `forge_core::topo::samples`). Every body is validated with `finish_validated`.

#![allow(dead_code)]

use forge_core::geom::{
    Circle2, Circle3, Cone, Curve2, Curve3, Cylinder, Line2, Line3, Plane, Surface, Torus,
};
use forge_core::topo::{Body, BodyBuilder, EdgeId, Provenance};
use forge_core::{Frame, Vec2, Vec3, math};

fn finish(b: BodyBuilder) -> Body {
    match b.finish_validated() {
        Ok(body) => body,
        Err(issues) => panic!("invalid test body: {issues:#?}"),
    }
}

/// A full torus: one loop-less face (major 10, minor 3).
pub fn torus(major: f64, minor: f64) -> Body {
    let mut b = BodyBuilder::new();
    let shell = b.add_shell(true);
    let t = Torus::new(Frame::world(), major, minor).expect("torus");
    b.add_face(
        shell,
        Surface::Torus(t),
        true,
        Provenance::side("ring", "c"),
    )
    .expect("face");
    finish(b)
}

/// A solid cone: apex at `(0, 0, h)`, base disc of radius `r` on z = 0. The cone face is
/// bounded only by the base ring (the apex is a surface singularity).
pub fn cone(r: f64, h: f64) -> Body {
    let half = math::atan(r / h);
    let apex_frame = Frame::from_normal_x(
        Vec3::new(0.0, 0.0, h),
        Vec3::new(0.0, 0.0, -1.0),
        Vec3::unit_x(),
    )
    .expect("frame");
    let cone = Cone::new(apex_frame, 0.0, half).expect("cone");
    let (base_name, side_name) = (
        Provenance::cap_start("rev"),
        Provenance::side("rev", "slant"),
    );
    let mut b = BodyBuilder::new();
    let ring = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(Frame::world(), r).expect("circle")),
            Provenance::edge_between("rev", base_name.name(), side_name.name()),
        )
        .expect("ring");
    let shell = b.add_shell(true);
    let base = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            false,
            base_name,
        )
        .expect("base");
    let lp = b.add_loop(base, &[(ring, false)]).expect("loop");
    let cid = b.body().loop_(lp).expect("loop").coedges[0];
    b.set_pcurve(
        cid,
        Curve2::Circle(Circle2::new(Vec2::zero(), r).expect("c")),
    )
    .expect("pc");
    let side = b
        .add_face(shell, Surface::Cone(cone), true, side_name)
        .expect("side");
    let lp = b.add_loop(side, &[(ring, true)]).expect("loop");
    // The cone frame is upside down, so its u runs clockwise: u = −t, v = h.
    let cid = b.body().loop_(lp).expect("loop").coedges[0];
    b.set_pcurve(
        cid,
        Curve2::Line(Line2::new(Vec2::new(0.0, h), Vec2::new(-1.0, 0.0)).expect("line")),
    )
    .expect("pc");
    finish(b)
}

/// Pcurve of a 3D line lying in a plane with the given frame (same parameter).
fn line_pcurve(frame: &Frame, l: &Line3) -> Curve2 {
    let o = frame.to_local_point(l.origin());
    let d = frame.to_local_vector(l.dir());
    Curve2::Line(Line2::new(Vec2::new(o.x, o.y), Vec2::new(d.x, d.y)).expect("in-plane line"))
}

/// A `w × d × h` plate (extrude `"plate"`) with vertical through holes
/// `(cx, cy, radius)`. Hole walls are cylinder faces with `sense = false`; every coedge
/// carries a pcurve.
pub fn plate_with_holes(w: f64, d: f64, h: f64, holes: &[(f64, f64, f64)]) -> Body {
    const F: &str = "plate";
    let pos = |i: usize| {
        Vec3::new(
            (i & 1) as f64 * w,
            ((i >> 1) & 1) as f64 * d,
            ((i >> 2) & 1) as f64 * h,
        )
    };
    let fr = |o: [f64; 3], n: [f64; 3], x: [f64; 3]| {
        Frame::from_normal_x(o.into(), n.into(), x.into()).expect("frame")
    };
    let top_frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, h));
    let faces: [(Provenance, Frame, bool, [usize; 4]); 6] = [
        (
            Provenance::cap_start(F),
            Frame::world(),
            false,
            [0, 2, 3, 1],
        ),
        (Provenance::cap_end(F), top_frame, true, [4, 5, 7, 6]),
        (
            Provenance::side(F, "s0"),
            fr([0.0; 3], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
            true,
            [0, 1, 5, 4],
        ),
        (
            Provenance::side(F, "s1"),
            fr([w, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            true,
            [1, 3, 7, 5],
        ),
        (
            Provenance::side(F, "s2"),
            fr([0.0, d, 0.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]),
            true,
            [2, 6, 7, 3],
        ),
        (
            Provenance::side(F, "s3"),
            fr([0.0; 3], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
            true,
            [0, 4, 6, 2],
        ),
    ];
    let mut b = BodyBuilder::new();
    let names: Vec<String> = faces.iter().map(|f| f.0.name()).collect();
    let verts: Vec<_> = (0..8)
        .map(|i| {
            b.add_vertex(pos(i), Provenance::vertex_at(F, [format!("c{i}")]))
                .expect("vertex")
        })
        .collect();
    let mut edges = std::collections::BTreeMap::new();
    for (fi, f) in faces.iter().enumerate() {
        for k in 0..4 {
            let (a, c) = (f.3[k], f.3[(k + 1) % 4]);
            let key = (a.min(c), a.max(c));
            if edges.contains_key(&key) {
                continue;
            }
            let other = faces
                .iter()
                .enumerate()
                .find(|(fj, g)| *fj != fi && (0..4).any(|m| g.3[m] == c && g.3[(m + 1) % 4] == a))
                .map(|(fj, _)| names[fj].clone())
                .expect("adjacent face");
            let line = Line3::through(pos(key.0), pos(key.1)).expect("line");
            let e: EdgeId = b
                .add_edge(
                    Curve3::Line(line),
                    (0.0, pos(key.0).distance(pos(key.1))),
                    verts[key.0],
                    verts[key.1],
                    Provenance::edge_between(F, names[fi].clone(), other),
                )
                .expect("edge");
            edges.insert(key, e);
        }
    }
    // Hole rings.
    let mut rings = Vec::new();
    for (k, &(cx, cy, r)) in holes.iter().enumerate() {
        let hname = Provenance::side(F, format!("h{k}")).name();
        let bot = b
            .add_ring_edge(
                Curve3::Circle(
                    Circle3::new(Frame::world().with_origin(Vec3::new(cx, cy, 0.0)), r).expect("c"),
                ),
                Provenance::edge_between(F, names[0].clone(), hname.clone()),
            )
            .expect("ring");
        let top = b
            .add_ring_edge(
                Curve3::Circle(
                    Circle3::new(Frame::world().with_origin(Vec3::new(cx, cy, h)), r).expect("c"),
                ),
                Provenance::edge_between(F, names[1].clone(), hname),
            )
            .expect("ring");
        rings.push((bot, top));
    }
    let shell = b.add_shell(true);
    for (fi, (prov, frame, sense, cyc)) in faces.iter().enumerate() {
        let face = b
            .add_face(
                shell,
                Surface::Plane(Plane::new(*frame)),
                *sense,
                prov.clone(),
            )
            .expect("face");
        let uses: Vec<_> = (0..4)
            .map(|k| {
                let (a, c) = (cyc[k], cyc[(k + 1) % 4]);
                (edges[&(a.min(c), a.max(c))], a < c)
            })
            .collect();
        let lp = b.add_loop(face, &uses).expect("loop");
        let cids = b.body().loop_(lp).expect("loop").coedges.clone();
        for (cid, (eid, _)) in cids.into_iter().zip(uses) {
            let Curve3::Line(l) = &b.body().edge(eid).expect("edge").curve else {
                unreachable!()
            };
            let pc = line_pcurve(frame, l);
            b.set_pcurve(cid, pc).expect("pc");
        }
        if fi < 2 {
            for (k, &(bot, top)) in rings.iter().enumerate() {
                let (cx, cy, r) = holes[k];
                // Bottom cap (outward −z): hole loop CCW in xy (forward). Top cap: CW.
                let (e, fwd) = if fi == 0 { (bot, true) } else { (top, false) };
                let lp = b.add_loop(face, &[(e, fwd)]).expect("hole loop");
                let cid = b.body().loop_(lp).expect("loop").coedges[0];
                b.set_pcurve(
                    cid,
                    Curve2::Circle(Circle2::new(Vec2::new(cx, cy), r).expect("c")),
                )
                .expect("pc");
            }
        }
    }
    for (k, &(bot, top)) in rings.iter().enumerate() {
        let (cx, cy, r) = holes[k];
        let cyl =
            Cylinder::new(Frame::world().with_origin(Vec3::new(cx, cy, 0.0)), r).expect("cyl");
        let wall = b
            .add_face(
                shell,
                Surface::Cylinder(cyl),
                false,
                Provenance::side(F, format!("h{k}")),
            )
            .expect("wall");
        // Outward normal points into the hole (sense false): face on the right in uv.
        let lp = b.add_loop(wall, &[(bot, false)]).expect("loop");
        let cid = b.body().loop_(lp).expect("loop").coedges[0];
        b.set_pcurve(
            cid,
            Curve2::Line(Line2::new(Vec2::zero(), Vec2::unit_x()).expect("l")),
        )
        .expect("pc");
        let lp = b.add_loop(wall, &[(top, true)]).expect("loop");
        let cid = b.body().loop_(lp).expect("loop").coedges[0];
        b.set_pcurve(
            cid,
            Curve2::Line(Line2::new(Vec2::new(0.0, h), Vec2::unit_x()).expect("l")),
        )
        .expect("pc");
    }
    finish(b)
}

/// Half of a closed cylinder (y ≥ 0): the partial cylinder face is bounded by two arcs
/// and two generator lines. **No pcurves** (parameters come from projection).
pub fn half_cylinder(r: f64, h: f64) -> Body {
    const F: &str = "half";
    let v = [
        Vec3::new(r, 0.0, 0.0),
        Vec3::new(-r, 0.0, 0.0),
        Vec3::new(r, 0.0, h),
        Vec3::new(-r, 0.0, h),
    ];
    let (curved, flat, bottom, top) = (
        Provenance::side(F, "arc"),
        Provenance::side(F, "diam"),
        Provenance::cap_start(F),
        Provenance::cap_end(F),
    );
    let e = |a: &Provenance, c: &Provenance| Provenance::edge_between(F, a.name(), c.name());
    let mut b = BodyBuilder::new();
    let vs: Vec<_> = v
        .iter()
        .enumerate()
        .map(|(i, p)| {
            b.add_vertex(*p, Provenance::vertex_at(F, [format!("v{i}")]))
                .expect("v")
        })
        .collect();
    let top_frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, h));
    let eb = b
        .add_edge(
            Curve3::Circle(Circle3::new(Frame::world(), r).expect("c")),
            (0.0, math::PI),
            vs[0],
            vs[1],
            e(&curved, &bottom),
        )
        .expect("eb");
    let et = b
        .add_edge(
            Curve3::Circle(Circle3::new(top_frame, r).expect("c")),
            (0.0, math::PI),
            vs[2],
            vs[3],
            e(&curved, &top),
        )
        .expect("et");
    let l0 = b
        .add_edge(
            Curve3::Line(Line3::through(v[0], v[2]).expect("l")),
            (0.0, h),
            vs[0],
            vs[2],
            e(&curved, &flat).with_index(0),
        )
        .expect("l0");
    let l1 = b
        .add_edge(
            Curve3::Line(Line3::through(v[1], v[3]).expect("l")),
            (0.0, h),
            vs[1],
            vs[3],
            e(&curved, &flat).with_index(1),
        )
        .expect("l1");
    let lb = b
        .add_edge(
            Curve3::Line(Line3::through(v[0], v[1]).expect("l")),
            (0.0, 2.0 * r),
            vs[0],
            vs[1],
            e(&flat, &bottom),
        )
        .expect("lb");
    let lt = b
        .add_edge(
            Curve3::Line(Line3::through(v[2], v[3]).expect("l")),
            (0.0, 2.0 * r),
            vs[2],
            vs[3],
            e(&flat, &top),
        )
        .expect("lt");
    let shell = b.add_shell(true);
    let cyl = Cylinder::new(Frame::world(), r).expect("cyl");
    let f = b
        .add_face(shell, Surface::Cylinder(cyl), true, curved.clone())
        .expect("f");
    b.add_loop(f, &[(eb, true), (l1, true), (et, false), (l0, false)])
        .expect("loop");
    let flat_frame = Frame::from_normal_x(Vec3::zero(), Vec3::new(0.0, -1.0, 0.0), Vec3::unit_x())
        .expect("frame");
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(flat_frame)), true, flat)
        .expect("f");
    b.add_loop(f, &[(lb, false), (l0, true), (lt, true), (l1, false)])
        .expect("loop");
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            false,
            bottom,
        )
        .expect("f");
    b.add_loop(f, &[(lb, true), (eb, false)]).expect("loop");
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(top_frame)), true, top)
        .expect("f");
    b.add_loop(f, &[(et, true), (lt, false)]).expect("loop");
    finish(b)
}

/// A solid hemisphere of radius `r` above z = 0: a spherical face bounded by the equator
/// ring (the north pole is a singularity) plus a planar disc.
pub fn hemisphere(r: f64) -> Body {
    const F: &str = "dome";
    let (sph, base) = (Provenance::side(F, "arc"), Provenance::cap_start(F));
    let mut b = BodyBuilder::new();
    let ring = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(Frame::world(), r).expect("c")),
            Provenance::edge_between(F, sph.name(), base.name()),
        )
        .expect("ring");
    let shell = b.add_shell(true);
    let s = forge_core::Sphere::new(Frame::world(), r).expect("sphere");
    let f = b.add_face(shell, Surface::Sphere(s), true, sph).expect("f");
    // Face above the equator (v = 0): the ring runs in +u.
    let lp = b.add_loop(f, &[(ring, true)]).expect("loop");
    let cid = b.body().loop_(lp).expect("loop").coedges[0];
    b.set_pcurve(
        cid,
        Curve2::Line(Line2::new(Vec2::zero(), Vec2::unit_x()).expect("l")),
    )
    .expect("pc");
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            false,
            base,
        )
        .expect("f");
    b.add_loop(f, &[(ring, false)]).expect("loop");
    finish(b)
}

/// A quarter of a solid cone (apex `(0, 0, h)`, base radius `r`, sector x, y ≥ 0): the
/// apex is a **B-rep vertex** where the partial cone face meets two planar triangles, so
/// the cone face's loop passes through the surface singularity. No pcurves.
pub fn cone_wedge(r: f64, h: f64) -> Body {
    const F: &str = "wedge";
    let (o, a, bb, p) = (
        Vec3::zero(),
        Vec3::new(r, 0.0, 0.0),
        Vec3::new(0.0, r, 0.0),
        Vec3::new(0.0, 0.0, h),
    );
    let (cone_f, base_f, xz_f, yz_f) = (
        Provenance::side(F, "slant"),
        Provenance::cap_start(F),
        Provenance::side(F, "xz"),
        Provenance::side(F, "yz"),
    );
    let e = |x: &Provenance, y: &Provenance| Provenance::edge_between(F, x.name(), y.name());
    let mut b = BodyBuilder::new();
    let vo = b.add_vertex(o, Provenance::vertex_at(F, ["o"])).expect("v");
    let va = b.add_vertex(a, Provenance::vertex_at(F, ["a"])).expect("v");
    let vb = b
        .add_vertex(bb, Provenance::vertex_at(F, ["b"]))
        .expect("v");
    let vp = b
        .add_vertex(p, Provenance::vertex_at(F, ["apex"]))
        .expect("v");
    let line = |b: &mut BodyBuilder, s: Vec3, t: Vec3, vs, vt, prov| {
        b.add_edge(
            Curve3::Line(Line3::through(s, t).expect("l")),
            (0.0, s.distance(t)),
            vs,
            vt,
            prov,
        )
        .expect("line")
    };
    let arc = b
        .add_edge(
            Curve3::Circle(Circle3::new(Frame::world(), r).expect("c")),
            (0.0, math::FRAC_PI_2),
            va,
            vb,
            e(&cone_f, &base_f),
        )
        .expect("arc");
    let bp = line(&mut b, bb, p, vb, vp, e(&cone_f, &yz_f));
    let pa = line(&mut b, p, a, vp, va, e(&cone_f, &xz_f));
    let oa = line(&mut b, o, a, vo, va, e(&base_f, &xz_f));
    let ob = line(&mut b, o, bb, vo, vb, e(&base_f, &yz_f));
    let op = line(&mut b, o, p, vo, vp, e(&xz_f, &yz_f));
    let shell = b.add_shell(true);
    let half = math::atan(r / h);
    let apex_frame =
        Frame::from_normal_x(p, Vec3::new(0.0, 0.0, -1.0), Vec3::unit_x()).expect("frame");
    let cone = Cone::new(apex_frame, 0.0, half).expect("cone");
    let f = b
        .add_face(shell, Surface::Cone(cone), true, cone_f)
        .expect("f");
    b.add_loop(f, &[(arc, true), (bp, true), (pa, true)])
        .expect("loop");
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            false,
            base_f,
        )
        .expect("f");
    b.add_loop(f, &[(ob, true), (arc, false), (oa, false)])
        .expect("loop");
    let xz = Frame::from_normal_x(o, Vec3::new(0.0, -1.0, 0.0), Vec3::unit_x()).expect("f");
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(xz)), true, xz_f)
        .expect("f");
    b.add_loop(f, &[(oa, true), (pa, false), (op, false)])
        .expect("loop");
    let yz = Frame::from_normal_x(o, Vec3::new(-1.0, 0.0, 0.0), Vec3::unit_y()).expect("f");
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(yz)), true, yz_f)
        .expect("f");
    b.add_loop(f, &[(op, true), (bp, false), (ob, false)])
        .expect("loop");
    finish(b)
}

/// A 90° pipe elbow: the revolve of a disc of radius `r` centred at distance `big` from
/// the z axis, from the xz-plane to the yz-plane. The torus face is bounded by two
/// **iso-u ring edges that wrap around the torus's v direction**. With pcurves.
pub fn pipe_elbow(big: f64, r: f64) -> Body {
    const F: &str = "elbow";
    let (tor_f, s_f, e_f) = (
        Provenance::side(F, "profile"),
        Provenance::end_cap_start(F),
        Provenance::end_cap_end(F),
    );
    let f0 = Frame::from_normal_x(
        Vec3::new(big, 0.0, 0.0),
        Vec3::new(0.0, -1.0, 0.0),
        Vec3::unit_x(),
    )
    .expect("frame");
    let f1 = Frame::from_normal_x(
        Vec3::new(0.0, big, 0.0),
        Vec3::new(1.0, 0.0, 0.0),
        Vec3::unit_y(),
    )
    .expect("frame");
    let mut b = BodyBuilder::new();
    let ring0 = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(f0, r).expect("c")),
            Provenance::edge_between(F, tor_f.name(), s_f.name()),
        )
        .expect("ring");
    let ring1 = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(f1, r).expect("c")),
            Provenance::edge_between(F, tor_f.name(), e_f.name()),
        )
        .expect("ring");
    let shell = b.add_shell(true);
    let t = Torus::new(Frame::world(), big, r).expect("torus");
    let f = b
        .add_face(shell, Surface::Torus(t), true, tor_f)
        .expect("f");
    // Face between u = 0 and u = π/2: down the u = 0 circle, up the u = π/2 circle.
    let lp = b.add_loop(f, &[(ring0, false)]).expect("loop");
    let cid = b.body().loop_(lp).expect("l").coedges[0];
    b.set_pcurve(
        cid,
        Curve2::Line(Line2::new(Vec2::zero(), Vec2::unit_y()).expect("l")),
    )
    .expect("pc");
    let lp = b.add_loop(f, &[(ring1, true)]).expect("loop");
    let cid = b.body().loop_(lp).expect("l").coedges[0];
    b.set_pcurve(
        cid,
        Curve2::Line(Line2::new(Vec2::new(math::FRAC_PI_2, 0.0), Vec2::unit_y()).expect("l")),
    )
    .expect("pc");
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(f0)), true, s_f)
        .expect("f");
    b.add_loop(f, &[(ring0, true)]).expect("loop");
    let f1n = Frame::from_normal_x(
        Vec3::new(0.0, big, 0.0),
        Vec3::new(-1.0, 0.0, 0.0),
        Vec3::unit_y(),
    )
    .expect("frame");
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(f1n)), true, e_f)
        .expect("f");
    b.add_loop(f, &[(ring1, false)]).expect("loop");
    finish(b)
}

/// A tube (outer radius `ro`, inner `ri`, height `h`) with a rectangular window through
/// its wall spanning angles `[u1, u2]` and heights `[z1, z2]`. The outer and inner
/// cylinder faces are periodic bands (two rings) **with a hole**; the window walls are
/// planar faces bounded by arcs and lines. No pcurves.
#[allow(clippy::too_many_arguments)]
pub fn windowed_tube(ro: f64, ri: f64, h: f64, u1: f64, u2: f64, z1: f64, z2: f64) -> Body {
    const F: &str = "tube";
    let at = |rad: f64, u: f64, z: f64| {
        let (s, c) = math::sin_cos(u);
        Vec3::new(rad * c, rad * s, z)
    };
    let names = [
        "outer", "inner", "bottom", "top", "w_u1", "w_u2", "w_z1", "w_z2",
    ];
    let p: Vec<Provenance> = names.iter().map(|n| Provenance::side(F, *n)).collect();
    let e = |x: usize, y: usize| Provenance::edge_between(F, p[x].name(), p[y].name());
    let mut b = BodyBuilder::new();
    let circ = |b: &mut BodyBuilder, rad: f64, z: f64, prov| {
        b.add_ring_edge(
            Curve3::Circle(
                Circle3::new(Frame::world().with_origin(Vec3::new(0.0, 0.0, z)), rad).expect("c"),
            ),
            prov,
        )
        .expect("ring")
    };
    let ob = circ(&mut b, ro, 0.0, e(0, 2));
    let ot = circ(&mut b, ro, h, e(0, 3));
    let ib = circ(&mut b, ri, 0.0, e(1, 2));
    let it = circ(&mut b, ri, h, e(1, 3));
    // Window corners: (radius, u, z) for outer/inner × u1/u2 × z1/z2.
    let mut v = std::collections::BTreeMap::new();
    for (ri_, rad) in [(0usize, ro), (1, ri)] {
        for (ui, u) in [(0usize, u1), (1, u2)] {
            for (zi, z) in [(0usize, z1), (1, z2)] {
                let id = b
                    .add_vertex(
                        at(rad, u, z),
                        Provenance::vertex_at(F, [format!("w{ri_}{ui}{zi}")]),
                    )
                    .expect("v");
                v.insert((ri_, ui, zi), id);
            }
        }
    }
    let arc = |b: &mut BodyBuilder, rad: f64, z: f64, s, t, prov| {
        b.add_edge(
            Curve3::Circle(
                Circle3::new(Frame::world().with_origin(Vec3::new(0.0, 0.0, z)), rad).expect("c"),
            ),
            (u1, u2),
            s,
            t,
            prov,
        )
        .expect("arc")
    };
    let line = |b: &mut BodyBuilder, s: Vec3, t: Vec3, vs, vt, prov| {
        b.add_edge(
            Curve3::Line(Line3::through(s, t).expect("l")),
            (0.0, s.distance(t)),
            vs,
            vt,
            prov,
        )
        .expect("line")
    };
    // Arcs (u1 → u2) at z1/z2 on both cylinders.
    let a_o1 = arc(&mut b, ro, z1, v[&(0, 0, 0)], v[&(0, 1, 0)], e(0, 6));
    let a_o2 = arc(&mut b, ro, z2, v[&(0, 0, 1)], v[&(0, 1, 1)], e(0, 7));
    let a_i1 = arc(&mut b, ri, z1, v[&(1, 0, 0)], v[&(1, 1, 0)], e(1, 6));
    let a_i2 = arc(&mut b, ri, z2, v[&(1, 0, 1)], v[&(1, 1, 1)], e(1, 7));
    // Vertical generator lines (z1 → z2) at u1/u2 on both cylinders.
    let g = |b: &mut BodyBuilder, rad_i: usize, ui: usize, prov| {
        let rad = if rad_i == 0 { ro } else { ri };
        let u = if ui == 0 { u1 } else { u2 };
        line(
            b,
            at(rad, u, z1),
            at(rad, u, z2),
            v[&(rad_i, ui, 0)],
            v[&(rad_i, ui, 1)],
            prov,
        )
    };
    let g_o1 = g(&mut b, 0, 0, e(0, 4));
    let g_o2 = g(&mut b, 0, 1, e(0, 5));
    let g_i1 = g(&mut b, 1, 0, e(1, 4));
    let g_i2 = g(&mut b, 1, 1, e(1, 5));
    // Radial lines (inner → outer) at the four window corners.
    let rl = |b: &mut BodyBuilder, ui: usize, zi: usize, prov| {
        let u = if ui == 0 { u1 } else { u2 };
        let z = if zi == 0 { z1 } else { z2 };
        line(
            b,
            at(ri, u, z),
            at(ro, u, z),
            v[&(1, ui, zi)],
            v[&(0, ui, zi)],
            prov,
        )
    };
    let r11 = rl(&mut b, 0, 0, e(4, 6));
    let r12 = rl(&mut b, 0, 1, e(4, 7));
    let r21 = rl(&mut b, 1, 0, e(5, 6));
    let r22 = rl(&mut b, 1, 1, e(5, 7));

    let shell = b.add_shell(true);
    let cyl = |rad: f64| Surface::Cylinder(Cylinder::new(Frame::world(), rad).expect("cyl"));
    // Outer wall (sense true): bottom ring +u, top ring −u, window hole clockwise in uv.
    let f = b.add_face(shell, cyl(ro), true, p[0].clone()).expect("f");
    b.add_loop(f, &[(ob, true)]).expect("l");
    b.add_loop(f, &[(ot, false)]).expect("l");
    b.add_loop(
        f,
        &[(a_o1, false), (g_o1, true), (a_o2, true), (g_o2, false)],
    )
    .expect("l");
    // Inner wall (sense false): everything reversed.
    let f = b.add_face(shell, cyl(ri), false, p[1].clone()).expect("f");
    b.add_loop(f, &[(ib, false)]).expect("l");
    b.add_loop(f, &[(it, true)]).expect("l");
    b.add_loop(
        f,
        &[(a_i1, true), (g_i2, true), (a_i2, false), (g_i1, false)],
    )
    .expect("l");
    // Bottom annulus (outward −z) and top annulus (outward +z).
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            false,
            p[2].clone(),
        )
        .expect("f");
    b.add_loop(f, &[(ob, false)]).expect("l");
    b.add_loop(f, &[(ib, true)]).expect("l");
    let tf = Frame::world().with_origin(Vec3::new(0.0, 0.0, h));
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(tf)), true, p[3].clone())
        .expect("f");
    b.add_loop(f, &[(ot, true)]).expect("l");
    b.add_loop(f, &[(it, false)]).expect("l");
    // Window side walls: radial planes at u1 (outward towards −u) and u2 (towards +u).
    let radial = |u: f64, out_sign: f64| {
        let (s, c) = math::sin_cos(u);
        let n = Vec3::new(-s, c, 0.0) * out_sign;
        Frame::from_normal_x(Vec3::zero(), n, Vec3::new(c, s, 0.0)).expect("frame")
    };
    // At u1 the window (outside the solid) is at larger u: outward normal +e_u.
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(radial(u1, 1.0))),
            true,
            p[4].clone(),
        )
        .expect("f");
    b.add_loop(f, &[(g_i1, true), (r12, true), (g_o1, false), (r11, false)])
        .expect("l");
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(radial(u2, -1.0))),
            true,
            p[5].clone(),
        )
        .expect("f");
    b.add_loop(f, &[(r21, true), (g_o2, true), (r22, false), (g_i2, false)])
        .expect("l");
    // Window floor at z1 (outward +z, the window is above) and ceiling at z2 (−z).
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(
                Frame::world().with_origin(Vec3::new(0.0, 0.0, z1)),
            )),
            true,
            p[6].clone(),
        )
        .expect("f");
    b.add_loop(f, &[(a_o1, true), (r21, false), (a_i1, false), (r11, true)])
        .expect("l");
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(
                Frame::world().with_origin(Vec3::new(0.0, 0.0, z2)),
            )),
            false,
            p[7].clone(),
        )
        .expect("f");
    b.add_loop(f, &[(a_o2, false), (r12, false), (a_i2, true), (r22, true)])
        .expect("l");
    finish(b)
}

/// An open sheet: one bicubic B-spline (Bézier) face over `[0, 30]²` with a saddle-like
/// bump, bounded by its four iso-parameter boundary curves (exact B-spline edges).
/// `with_pcurves = false` exercises the projection path on a B-spline surface.
pub fn bspline_sheet(with_pcurves: bool) -> Body {
    use forge_core::geom::{NurbsCurve3, NurbsSurface};
    const F: &str = "patch";
    let z = [
        [0.0, 2.0, 1.0, 0.0],
        [3.0, 8.0, -4.0, 2.0],
        [-2.0, 5.0, 9.0, -1.0],
        [0.0, -3.0, 2.0, 4.0],
    ];
    let ctrl: Vec<Vec3> = (0..4)
        .flat_map(|i| (0..4).map(move |j| Vec3::new(10.0 * i as f64, 10.0 * j as f64, z[i][j])))
        .collect();
    let knots = vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0];
    let surf = NurbsSurface::new(3, 3, knots.clone(), knots.clone(), 4, 4, ctrl.clone(), None)
        .expect("surface");
    let at = |i: usize, j: usize| ctrl[i * 4 + j];
    let curve = |pts: Vec<Vec3>| {
        Curve3::BSpline(NurbsCurve3::from_points(3, knots.clone(), &pts, None).expect("curve"))
    };
    let face = Provenance::side(F, "s");
    let mut b = BodyBuilder::new();
    let c = [at(0, 0), at(3, 0), at(3, 3), at(0, 3)];
    let vs: Vec<_> = c
        .iter()
        .enumerate()
        .map(|(k, p)| {
            b.add_vertex(*p, Provenance::vertex_at(F, [format!("c{k}")]))
                .expect("v")
        })
        .collect();
    let edge_name =
        |k: u32| Provenance::new(F, forge_core::Role::Other("border".into())).with_index(k);
    // v = 0 (u from 0 to 1), u = 1 (v from 0 to 1), v = 1, u = 0.
    let e_v0 = b
        .add_edge(
            curve((0..4).map(|i| at(i, 0)).collect()),
            (0.0, 1.0),
            vs[0],
            vs[1],
            edge_name(0),
        )
        .expect("e");
    let e_u1 = b
        .add_edge(
            curve((0..4).map(|j| at(3, j)).collect()),
            (0.0, 1.0),
            vs[1],
            vs[2],
            edge_name(1),
        )
        .expect("e");
    let e_v1 = b
        .add_edge(
            curve((0..4).map(|i| at(i, 3)).collect()),
            (0.0, 1.0),
            vs[3],
            vs[2],
            edge_name(2),
        )
        .expect("e");
    let e_u0 = b
        .add_edge(
            curve((0..4).map(|j| at(0, j)).collect()),
            (0.0, 1.0),
            vs[0],
            vs[3],
            edge_name(3),
        )
        .expect("e");
    let shell = b.add_shell(false);
    let f = b
        .add_face(shell, Surface::BSpline(surf), true, face)
        .expect("f");
    let lp = b
        .add_loop(
            f,
            &[(e_v0, true), (e_u1, true), (e_v1, false), (e_u0, false)],
        )
        .expect("loop");
    if with_pcurves {
        let cids = b.body().loop_(lp).expect("loop").coedges.clone();
        let pcs = [
            (Vec2::new(0.0, 0.0), Vec2::unit_x()),
            (Vec2::new(1.0, 0.0), Vec2::unit_y()),
            (Vec2::new(0.0, 1.0), Vec2::unit_x()),
            (Vec2::new(0.0, 0.0), Vec2::unit_y()),
        ];
        for (cid, (o, d)) in cids.into_iter().zip(pcs) {
            b.set_pcurve(cid, Curve2::Line(Line2::new(o, d).expect("l")))
                .expect("pc");
        }
    }
    finish(b)
}

/// A whole spindle-torus patch (`major < minor`) as one loop-less face: topologically a
/// sphere whose two singular points are the axis crossings. On the inner ("lemon") sheet
/// `S_u × S_v` points towards the axis, so the solid's face has `sense = false` there.
pub fn spindle(major: f64, minor: f64, patch: forge_core::SpindlePatch) -> Body {
    let mut b = BodyBuilder::new();
    let shell = b.add_shell(true);
    let t = Torus::spindle(Frame::world(), major, minor, patch).expect("spindle");
    let sense = patch == forge_core::SpindlePatch::Outer;
    b.add_face(
        shell,
        Surface::Torus(t),
        sense,
        Provenance::side("spin", "c"),
    )
    .expect("face");
    finish(b)
}
