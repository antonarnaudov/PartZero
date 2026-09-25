//! Real Forge bodies for the STEP export tests and the corpus dump: every operand and every
//! result of the boolean corpus (`forge_ops::boolean::corpus`), which covers prismatic and
//! revolved operands, coplanar and touching cases, voids, splits, B-spline intersection
//! curves, and vertices at poles.

use forge_core::topo::Body;
use forge_ir::v1::metrics::Origin;
use forge_ops::boolean::corpus::{Case, cases};
use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};

/// A named body.
pub struct NamedBody {
    pub name: String,
    pub body: Body,
    /// Exact metrics `(volume, area, bbox min, bbox max)` for bodies forge-check cannot
    /// measure yet (B-spline faces, BACKLOG P1).
    #[allow(dead_code)]
    pub known: Option<(f64, f64, [f64; 3], [f64; 3])>,
}

fn ob(body: Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "m".into(),
            instance: None,
        },
        timeline,
    }
}

fn op_name(op: BodyOp) -> &'static str {
    match op {
        BodyOp::Join => "join",
        BodyOp::Cut => "cut",
        BodyOp::Intersect => "intersect",
    }
}

/// The operands and results of one case (results of all three operations).
pub fn case_bodies(seed: u64, c: &Case) -> Vec<NamedBody> {
    let mut out = Vec::new();
    let (Ok(a), Ok(b)) = (c.a.build(), c.b.build()) else {
        return out;
    };
    let tag = format!("s{seed}-c{}-{}", c.id, c.family);
    out.push(NamedBody {
        name: format!("{tag}-a"),
        body: a.clone(),
        known: None,
    });
    out.push(NamedBody {
        name: format!("{tag}-b"),
        body: b.clone(),
        known: None,
    });
    for op in [BodyOp::Join, BodyOp::Cut, BodyOp::Intersect] {
        if let Ok(r) = apply_body_op(op, &[ob(a.clone(), "a", 0)], &[ob(b.clone(), "b", 1)], "g") {
            for (k, x) in r.bodies.into_iter().enumerate() {
                out.push(NamedBody {
                    name: format!("{tag}-{}-{k}", op_name(op)),
                    body: x.body,
                    known: None,
                });
            }
        }
    }
    out
}

/// All bodies of the first `n` cases of `seed`.
pub fn corpus(seed: u64, n: usize) -> Vec<NamedBody> {
    cases(seed, n)
        .iter()
        .flat_map(|c| case_bodies(seed, c))
        .collect()
}

/// Every result of `chains` chained operation sequences of `steps` steps
/// (`forge_ops::boolean::corpus::run_chains`): operands that are Forge's own results, so
/// loops through a vertex twice, circles touching edges and vertices at poles appear.
#[allow(dead_code)]
pub fn chained(seed: u64, chains: usize, steps: usize) -> Vec<NamedBody> {
    let mut out = Vec::new();
    forge_ops::boolean::corpus::run_chains(seed, chains, steps, |s| {
        for (op, r) in s.results {
            if let Ok(r) = r {
                for (k, x) in r.bodies.iter().enumerate() {
                    out.push(NamedBody {
                        name: format!("chain{seed}-{}-{}-{}-{k}", s.chain, s.step, op_name(*op)),
                        body: x.body.clone(),
                        known: None,
                    });
                }
            }
        }
    });
    out
}

/// The unit cube with its top face on a (rational) bilinear B-spline patch and its four
/// top edges as (rational) degree-2 B-spline curves along the straight lines: exercises
/// `B_SPLINE_SURFACE_WITH_KNOTS`, `B_SPLINE_CURVE_WITH_KNOTS` and their rational complex
/// instances end to end (volume 1, area 6).
pub fn nurbs_cube(rational: bool) -> Body {
    use forge_core::geom::{
        Curve2, Curve3, Line2, Line3, NurbsCurve2, NurbsCurve3, NurbsSurface, Plane, Surface,
    };
    use forge_core::linalg::{Frame, Vec2, Vec3};
    use forge_core::topo::{BodyBuilder, Provenance};
    use std::collections::BTreeMap;

    const F: &str = "ncube";
    let pos = |i: usize| Vec3::new((i & 1) as f64, ((i >> 1) & 1) as f64, ((i >> 2) & 1) as f64);
    let plane = |o: [f64; 3], n: [f64; 3], x: [f64; 3]| {
        Surface::Plane(Plane::new(
            Frame::from_normal_x(o.into(), n.into(), x.into()).expect("frame"),
        ))
    };
    // The top patch is S(u, v) = (u, v, 1) on [0,1]²; the rational variant has equal weights
    // (the same geometry and parametrization, written as the rational complex instance).
    let top = NurbsSurface::new(
        1,
        1,
        vec![0.0, 0.0, 1.0, 1.0],
        vec![0.0, 0.0, 1.0, 1.0],
        2,
        2,
        vec![
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(0.0, 1.0, 1.0),
            Vec3::new(1.0, 0.0, 1.0),
            Vec3::new(1.0, 1.0, 1.0),
        ],
        rational.then(|| vec![2.0; 4]),
    )
    .expect("patch");
    let faces: [(Provenance, Surface, bool, [usize; 4]); 6] = [
        (
            Provenance::cap_start(F),
            Surface::Plane(Plane::new(Frame::world())),
            false,
            [0, 2, 3, 1],
        ),
        (
            Provenance::cap_end(F),
            Surface::BSpline(top),
            true,
            [4, 5, 7, 6],
        ),
        (
            Provenance::side(F, "s0"),
            plane([0.0; 3], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
            true,
            [0, 1, 5, 4],
        ),
        (
            Provenance::side(F, "s1"),
            plane([1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            true,
            [1, 3, 7, 5],
        ),
        (
            Provenance::side(F, "s2"),
            plane([0.0, 1.0, 0.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]),
            true,
            [2, 6, 7, 3],
        ),
        (
            Provenance::side(F, "s3"),
            plane([0.0; 3], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
            true,
            [0, 4, 6, 2],
        ),
    ];
    let mut edge_faces: BTreeMap<(usize, usize), Vec<String>> = BTreeMap::new();
    let mut vertex_faces: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for (prov, _, _, cyc) in &faces {
        for k in 0..4 {
            let (a, c) = (cyc[k], cyc[(k + 1) % 4]);
            edge_faces
                .entry((a.min(c), a.max(c)))
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
        let prov = Provenance::edge_between(F, names[0].clone(), names[1].clone());
        let (pa, pc) = (pos(a), pos(c));
        let e = if a >= 4 && c >= 4 {
            // A top edge: the straight line as a degree-2 B-spline on [0, 2].
            let mid = (pa + pc) * 0.5;
            let curve = NurbsCurve3::new(
                2,
                vec![0.0, 0.0, 0.0, 2.0, 2.0, 2.0],
                vec![pa.to_array(), mid.to_array(), pc.to_array()],
                rational.then(|| vec![1.0, 0.7, 1.0]),
            )
            .expect("curve");
            b.add_edge(Curve3::BSpline(curve), (0.0, 2.0), verts[a], verts[c], prov)
        } else {
            let line = Line3::through(pa, pc).expect("line");
            b.add_edge(Curve3::Line(line), (0.0, 1.0), verts[a], verts[c], prov)
        }
        .expect("edge");
        edges.insert((a, c), e);
    }
    let shell = b.add_shell(true);
    for (prov, surface, sense, cyc) in faces {
        // The face's (u, v) of a point: plane-local x, y; the top patch is (x, y) itself.
        let uv = |p: Vec3| match &surface {
            Surface::Plane(pl) => {
                let l = pl.frame().to_local_point(p);
                [l.x, l.y]
            }
            _ => [p.x, p.y],
        };
        let face = b
            .add_face(shell, surface.clone(), sense, prov)
            .expect("face");
        let uses: Vec<_> = (0..4)
            .map(|k| {
                let (a, c) = (cyc[k], cyc[(k + 1) % 4]);
                (edges[&(a.min(c), a.max(c))], a < c)
            })
            .collect();
        let lp = b.add_loop(face, &uses).expect("loop");
        // Pcurves with the edge's own parameter (forge-check needs them).
        let coedges = b.body().loop_(lp).expect("loop").coedges.clone();
        for (cid, (eid, _)) in coedges.into_iter().zip(uses) {
            let pc = match &b.body().edge(eid).expect("edge").curve {
                Curve3::Line(l) => {
                    let o = uv(l.origin());
                    let e = uv(l.origin() + l.dir());
                    Curve2::Line(
                        Line2::new(Vec2::new(o[0], o[1]), Vec2::new(e[0] - o[0], e[1] - o[1]))
                            .expect("pcurve line"),
                    )
                }
                Curve3::BSpline(n) => Curve2::BSpline(
                    NurbsCurve2::new(
                        n.degree(),
                        n.knots().to_vec(),
                        n.control_points()
                            .iter()
                            .map(|q| uv(Vec3::new(q[0], q[1], q[2])))
                            .collect(),
                        n.weights().map(<[f64]>::to_vec),
                    )
                    .expect("pcurve spline"),
                ),
                _ => unreachable!("only lines and B-splines"),
            };
            b.set_pcurve(cid, pc).expect("pcurve");
        }
    }
    b.finish()
}

/// Hand-built sample bodies: the forge-core samples and the B-spline cubes.
pub fn samples() -> Vec<NamedBody> {
    use forge_core::topo::samples;
    let named = |name: &str, body| NamedBody {
        name: name.into(),
        body,
        known: None,
    };
    let unit = Some((1.0, 6.0, [0.0; 3], [1.0; 3]));
    vec![
        named("sample-cube", samples::unit_cube()),
        named("sample-cylinder", samples::cylinder(10.0, 30.0)),
        named("sample-sphere", samples::sphere(5.0)),
        NamedBody {
            known: unit,
            ..named("sample-nurbs-cube", nurbs_cube(false))
        },
        NamedBody {
            known: unit,
            ..named("sample-rational-nurbs-cube", nurbs_cube(true))
        },
    ]
}
