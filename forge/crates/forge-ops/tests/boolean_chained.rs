//! Booleans on Forge's own results (chained operations) and at contacts between a curved
//! tool and a box **edge**, where the outcome used to depend on how the tool's surface was
//! parametrized (review round 3):
//! - a sphere tangent to a box face at a point of the face's edge (all three revolve axes,
//!   all three operations): the same valid body, with the closed-form volume, whichever
//!   axis the sphere was revolved about (it used to be an inside-out body, a false
//!   `BOOLEAN_NON_MANIFOLD`, or a valid body, depending on the axis);
//! - results with a loop through a vertex twice (a circle touching an edge), or a closed
//!   edge with one vertex, used as operands: every later boolean used to drop that edge
//!   (a closed sphere copy, an inverted body, or "inconsistent inside/outside status");
//! - a sphere split by planes through its revolve axis (edges through its poles);
//! - a chained stress test: random chains of join / cut / intersect on grid-snapped boxes,
//!   cylinders and spheres, each step checking validity and the volume identities on the
//!   results of the previous steps.

use forge_core::topo::{Body, Severity};
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{
    Operand, Sweep, chain_base, cylinder_operand, run_chains, sphere_operand,
};
use forge_ops::boolean::{BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op};

const PI: f64 = std::f64::consts::PI;

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

fn op(o: BodyOp, a: &Body, b: &Body) -> Result<BodyOpResult, BooleanError> {
    apply_body_op(o, &[ob(a.clone(), "a", 0)], &[ob(b.clone(), "b", 1)], "g")
}

fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Body {
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    let (x0, y0, w, h) = (lo[0], lo[1], size[0], size[1]);
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(Frame {
                origin: [0.0, 0.0, lo[2]],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves: vec![
                l("b", [x0, y0], [x0 + w, y0]),
                l("r", [x0 + w, y0], [x0 + w, y0 + h]),
                l("t", [x0 + w, y0 + h], [x0, y0 + h]),
                l("l", [x0, y0 + h], [x0, y0]),
            ],
        },
        sweep: Sweep::Extrude {
            distance: size[2],
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("box")
}

fn base() -> Body {
    chain_base().build().expect("base")
}

/// Sphere revolved about world axis `axis` (0 X, 1 Y, 2 Z).
fn sphere(feature: &str, c: [f64; 3], r: f64, axis: usize) -> Body {
    sphere_operand(feature, c, r, axis).build().expect("sphere")
}

fn cyl(feature: &str, axis: usize, c: [f64; 2], lo: f64, r: f64, h: f64) -> Body {
    cylinder_operand(feature, axis, c, lo, r, h)
        .build()
        .expect("cylinder")
}

fn volume(b: &Body) -> f64 {
    forge_check::mass_properties(b).expect("mass").volume
}

fn check_valid(b: &Body, what: &str) {
    let errs: Vec<_> = forge_check::validate(b)
        .into_iter()
        .filter(|i| i.severity == Severity::Error)
        .collect();
    assert!(errs.is_empty(), "{what}: invalid result: {errs:?}");
    assert!(volume(b) > 0.0, "{what}: non-positive volume");
}

/// The single valid body of a successful operation, checked.
fn one_body(r: Result<BodyOpResult, BooleanError>, what: &str) -> Body {
    let r = r.unwrap_or_else(|e| panic!("{what}: {} {e}", e.code()));
    assert_eq!(r.bodies.len(), 1, "{what}: {} bodies", r.bodies.len());
    let b = r.bodies.into_iter().next().expect("body").body;
    check_valid(&b, what);
    b
}

fn close(v: f64, want: f64, what: &str) {
    assert!(
        (v - want).abs() <= 1e-9 * want.abs().max(1.0),
        "{what}: volume {v} vs {want}"
    );
}

/// A sphere of radius 0.5 centred on the box face `x = 0` touches the top face `z = 2`
/// at `P = (0, 2.75, 2)`, a point of the box edge between them. The join, the cut and the
/// intersection are manifold at `P` (its link is one disk: the faces around it form one
/// vertex fan), and none of them depends on the sphere's revolve axis. The axis only moves
/// the poles: through `P` (Z), on the circle `x = 0` away from `P` (Y), or off it (X), which
/// changes the edge count (vertices stay at poles), never the outcome.
#[test]
fn a_sphere_touching_a_box_edge_gives_one_outcome_for_every_parametrization() {
    let b = base();
    let half = 2.0 / 3.0 * PI * 0.125;
    for axis in 0..3 {
        let s = sphere("k", [0.0, 2.75, 1.5], 0.5, axis);
        let w = |o: &str| format!("axis {axis} {o}");
        close(
            volume(&one_body(op(BodyOp::Join, &b, &s), &w("join"))),
            32.0 + half,
            &w("join"),
        );
        close(
            volume(&one_body(op(BodyOp::Cut, &b, &s), &w("cut"))),
            32.0 - half,
            &w("cut"),
        );
        close(
            volume(&one_body(op(BodyOp::Intersect, &b, &s), &w("intersect"))),
            half,
            &w("intersect"),
        );
        close(
            volume(&one_body(
                op(BodyOp::Intersect, &s, &b),
                &w("swapped intersect"),
            )),
            half,
            &w("swapped intersect"),
        );
        // The sphere minus the box: the other half.
        close(
            volume(&one_body(op(BodyOp::Cut, &s, &b), &w("sphere − box"))),
            half,
            &w("sphere − box"),
        );
    }
}

/// A dome's rim touching a face from inside at an interior point of the face (the dome's
/// top lies on the rim): the kept face passes smoothly through the contact while the
/// pocket touches it there, so the cut touches itself (`BOOLEAN_NON_MANIFOLD`, the point's
/// link is an annulus); the intersection is the dome.
#[test]
fn a_rim_touching_the_inside_of_a_face_is_non_manifold_for_the_cut_only() {
    // Box [−1, 4] × [0, 4] × [0, 2]; a hemisphere tool: the sphere's half x ≥ 0.
    let b = aabox("a", [-1.0, 0.0, 0.0], [5.0, 4.0, 2.0]);
    for axis in 0..3 {
        let s = sphere("k", [0.0, 2.75, 1.5], 0.5, axis);
        let dome = one_body(
            op(
                BodyOp::Cut,
                &s,
                &aabox("h", [-1.0, 2.0, 0.5], [1.0, 1.5, 1.5]),
            ),
            "dome",
        );
        match op(BodyOp::Cut, &b, &dome) {
            Err(e) => assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "axis {axis}: {e}"),
            Ok(_) => panic!("axis {axis}: the cut touches itself at (0, 2.75, 2)"),
        }
        let v = volume(&one_body(op(BodyOp::Intersect, &b, &dome), "dome ∩ box"));
        close(v, volume(&dome), "dome ∩ box");
    }
}

/// Chained operations on results whose faces have a loop through a vertex twice (a circle
/// touching the box edge) or a closed edge with one vertex: later booleans used to drop
/// that edge (a closed sphere copy came back as a second body; the cut of an internal
/// cylinder returned two extra spheres; a body of negative volume).
#[test]
fn chained_operations_on_circles_touching_edges_keep_every_edge() {
    let b = base();
    let far = aabox("k", [3.5, 3.5, -0.5], [0.25, 0.25, 1.0]);
    let far_v = 0.25 * 0.25 * 0.5;
    let half = |r: f64| 2.0 / 3.0 * PI * r * r * r;
    for axis in 0..3 {
        let w = |o: &str| format!("(a) axis {axis} {o}");
        // (a) A sphere centred on the side y = 0, touching the bottom edge.
        let j = one_body(
            op(BodyOp::Join, &b, &sphere("s", [1.0, 0.0, 0.5], 0.5, axis)),
            &w("join"),
        );
        close(volume(&j), 32.0 + half(0.5), &w("join"));
        let c = one_body(op(BodyOp::Cut, &j, &far), &w("cut far"));
        close(volume(&c), 32.0 + half(0.5) - far_v, &w("cut far"));
        // A dome on the top face touching the edge y = 0.
        let d = one_body(
            op(BodyOp::Join, &b, &sphere("s", [1.0, 0.5, 2.0], 0.5, axis)),
            &w("dome"),
        );
        close(volume(&d), 32.0 + half(0.5), &w("dome"));
        close(
            volume(&one_body(op(BodyOp::Cut, &d, &far), &w("dome cut far"))),
            32.0 + half(0.5) - far_v,
            &w("dome cut far"),
        );
    }
    // (b) A sphere poking out of three faces, its three circles pairwise touching on two
    // box edges; then an internal x-cylinder cut: v(join) − π r² h.
    let j = one_body(
        op(BodyOp::Join, &b, &sphere("s", [3.25, 2.25, 1.0], 1.25, 1)),
        "(b) join",
    );
    let xc = cyl("k", 0, [1.0, 0.75], 0.75, 0.5, 1.75);
    let c = one_body(op(BodyOp::Cut, &j, &xc), "(b) cut");
    close(volume(&c), volume(&j) - PI * 0.25 * 1.75, "(b) cut");
    // (c) Two cuts, then a cylinder across the first hole: cut + intersect = target.
    let a1 = one_body(
        op(BodyOp::Cut, &b, &cyl("k", 0, [2.25, 1.0], 0.25, 0.75, 2.5)),
        "(c) cut 1",
    );
    let a2 = one_body(
        op(BodyOp::Cut, &a1, &sphere("s", [3.25, 4.0, 1.75], 0.25, 1)),
        "(c) cut 2",
    );
    let k3 = cyl("k", 0, [0.75, 0.0], 0.5, 1.25, 2.0);
    let c3 = op(BodyOp::Cut, &a2, &k3).expect("(c) cut 3");
    let i3 = op(BodyOp::Intersect, &a2, &k3).expect("(c) intersect 3");
    let (mut vc, mut vi) = (0.0, 0.0);
    for x in &c3.bodies {
        check_valid(&x.body, "(c) cut 3");
        vc += volume(&x.body);
    }
    for x in &i3.bodies {
        check_valid(&x.body, "(c) intersect 3");
        vi += volume(&x.body);
    }
    let va2 = volume(&a2);
    assert!(
        (vc + vi - va2).abs() <= 1e-9 * va2,
        "(c) {vc} + {vi} vs {va2}"
    );
}

/// A boss tangent to a box edge (a peg on the top face touching the edge y = 0, a side
/// boss, an x-axis peg flush with the top face) used to make every later boolean fail with
/// "inconsistent inside/outside status": its circle is a closed edge with one vertex on
/// the box edge.
#[test]
fn bosses_tangent_to_an_edge_accept_later_booleans() {
    let b = base();
    let far_cut = aabox("k", [3.5, 3.5, -0.5], [0.25, 0.25, 1.0]);
    let far_join = aabox("k", [3.5, 3.5, 1.0], [1.0, 0.25, 0.25]);
    let bosses = [
        ("top peg", cyl("p", 2, [1.0, 0.5], 2.0, 0.5, 1.0), PI * 0.25),
        // Along +Y from y = −1 to 0: centre (x, z) = (1, 0.5), tangent to the bottom edge.
        (
            "side boss",
            cyl("p", 1, [1.0, 0.5], -1.0, 0.5, 1.0),
            PI * 0.25,
        ),
        // Along X, flush with the top face: centre (y, z) = (1, 1.75), r 0.25, x ∈ [−0.5, 1].
        (
            "x peg",
            cyl("p", 0, [1.0, 1.75], -0.5, 0.25, 1.5),
            PI * 0.0625 * 0.5,
        ),
    ];
    for (name, peg, outside) in bosses {
        let j = one_body(op(BodyOp::Join, &b, &peg), name);
        close(volume(&j), 32.0 + outside, name);
        let c = one_body(op(BodyOp::Cut, &j, &far_cut), &format!("{name} then cut"));
        close(
            volume(&c),
            32.0 + outside - 0.25 * 0.25 * 0.5,
            &format!("{name} then cut"),
        );
        let j2 = one_body(
            op(BodyOp::Join, &j, &far_join),
            &format!("{name} then join"),
        );
        close(
            volume(&j2),
            32.0 + outside + 0.5 * 0.25 * 0.25,
            &format!("{name} then join"),
        );
    }
}

/// Planes through a sphere's revolve axis: the section circles pass through both poles.
/// The two half circles meeting at a pole stay two edges (a merged edge would pass through
/// the pole, where no pcurve is continuous); the hemisphere and the three-quarter sphere
/// have their closed-form volumes for every operation and every axis.
#[test]
fn planes_through_a_sphere_axis_split_it_at_the_poles() {
    let half_box = aabox("k", [-2.0, -2.0, 0.0], [4.0, 4.0, 2.0]);
    let quarter = aabox("k", [0.0, -2.0, 0.0], [2.0, 4.0, 2.0]);
    let hemi = 2.0 / 3.0 * PI;
    for axis in 0..3 {
        let s = sphere("s", [0.0, 0.0, 0.0], 1.0, axis);
        let w = |o: &str| format!("axis {axis}: {o}");
        close(
            volume(&one_body(op(BodyOp::Join, &s, &half_box), &w("join"))),
            32.0 + hemi,
            &w("join"),
        );
        close(
            volume(&one_body(
                op(BodyOp::Cut, &s, &half_box),
                &w("sphere − box"),
            )),
            hemi,
            &w("sphere − box"),
        );
        close(
            volume(&one_body(
                op(BodyOp::Cut, &half_box, &s),
                &w("box − sphere"),
            )),
            32.0 - hemi,
            &w("box − sphere"),
        );
        close(
            volume(&one_body(
                op(BodyOp::Intersect, &s, &half_box),
                &w("intersect"),
            )),
            hemi,
            &w("intersect"),
        );
        close(
            volume(&one_body(
                op(BodyOp::Cut, &s, &quarter),
                &w("three quarters"),
            )),
            PI,
            &w("three quarters"),
        );
        close(
            volume(&one_body(
                op(BodyOp::Intersect, &s, &quarter),
                &w("quarter"),
            )),
            PI / 3.0,
            &w("quarter"),
        );
        close(
            volume(&one_body(
                op(BodyOp::Join, &s, &quarter),
                &w("sphere ∪ quarter box"),
            )),
            16.0 + PI,
            &w("sphere ∪ quarter box"),
        );
        // A 270° revolve of the same half disc (three quarters of the sphere, two flat end
        // caps through the axis) joined with the full sphere: the sphere; cut: a quarter.
        let mut part = sphere_operand("r", [0.0, 0.0, 0.0], 1.0, axis);
        if let Sweep::Revolve { angle, .. } = &mut part.sweep {
            *angle = 270.0;
        }
        let part = part.build().expect("270° revolve");
        close(volume(&part), PI, &w("270° revolve"));
        close(
            volume(&one_body(op(BodyOp::Join, &part, &s), &w("270° ∪ sphere"))),
            4.0 * PI / 3.0,
            &w("270° ∪ sphere"),
        );
        close(
            volume(&one_body(op(BodyOp::Cut, &s, &part), &w("sphere − 270°"))),
            PI / 3.0,
            &w("sphere − 270°"),
        );
    }
}

/// A short description of a chain tool (for failure reports).
fn tool_desc(t: &Operand) -> String {
    let PlaneSpec::Frame(f) = &t.sketch.plane else {
        return format!("{t:?}");
    };
    let sweep = match &t.sweep {
        Sweep::Extrude { distance, .. } => format!("extrude {distance}"),
        Sweep::Revolve { angle, .. } => format!("revolve {angle}°"),
    };
    let curves: Vec<String> = t
        .sketch
        .curves
        .iter()
        .map(|c| match c {
            SketchCurve::Line { start, .. } => format!("line@{start:?}"),
            SketchCurve::Circle { center, radius, .. } => format!("circle {center:?} r {radius}"),
            SketchCurve::Arc { center, start, .. } => format!("arc c {center:?} from {start:?}"),
        })
        .collect();
    format!(
        "plane o {:?} n {:?} x {:?}; {}; {sweep}",
        f.origin,
        f.normal,
        f.x_dir,
        curves.join(", ")
    )
}

/// Totals of a chained run.
#[derive(Default, Debug)]
struct ChainStats {
    steps: usize,
    all_ok: usize,
    semantic: usize,
    worst_rel: f64,
    internal: Vec<String>,
}

/// Volume of an operation's outcome for the identities (`None` for internal failures;
/// `Some(0)` for the semantic "nothing" outcomes), every returned body checked.
fn outcome(r: &Result<BodyOpResult, BooleanError>, va: f64, what: &str) -> Option<f64> {
    match r {
        Ok(r) => {
            let mut v = 0.0;
            for x in &r.bodies {
                check_valid(&x.body, what);
                v += volume(&x.body);
            }
            if !r.untouched.is_empty() {
                assert!(
                    r.bodies.is_empty(),
                    "{what}: one target untouched and modified"
                );
                v += va;
            }
            Some(v)
        }
        Err(e) if e.is_semantic() => Some(0.0),
        Err(_) => None,
    }
}

fn run_chain_batch(seed: u64, chains: usize, steps: usize, max_internal: f64) -> ChainStats {
    let mut st = ChainStats::default();
    run_chains(seed, chains, steps, |s| {
        st.steps += 1;
        let what = |o: BodyOp| {
            format!(
                "seed {seed} chain {} step {} {o:?} tool {}",
                s.chain,
                s.step,
                tool_desc(s.tool)
            )
        };
        let (va, vb) = (volume(s.a), volume(s.b));
        let res: Vec<Option<f64>> = s
            .results
            .iter()
            .map(|(o, r)| outcome(r, va, &what(*o)))
            .collect();
        let code = |i: usize| s.results[i].1.as_ref().err().map(|e| e.code());
        for (i, (o, r)) in s.results.iter().enumerate() {
            if res[i].is_none()
                && let Err(e) = r
            {
                st.internal.push(format!("{}: {} {e}", what(*o), e.code()));
            }
        }
        let [Some(vj), Some(vk), Some(vi)] = [res[0], res[1], res[2]] else {
            return;
        };
        // The plan's bound, 1e-9 relative, for exact and fitted boundaries alike (see
        // boolean_properties.rs).
        let tol = 1e-9 * (va + vb);
        if code(0).is_none() && code(1).is_none() && code(2).is_none() {
            st.all_ok += 1;
            let rel = (vj + vi - va - vb).abs().max((vk + vi - va).abs()) / (va + vb);
            st.worst_rel = st.worst_rel.max(rel);
            assert!(
                (vj + vi - va - vb).abs() <= tol,
                "{}: join {vj} + int {vi} vs {va} + {vb}",
                what(BodyOp::Join)
            );
            assert!(
                (vk + vi - va).abs() <= tol,
                "{}: cut {vk} + int {vi} vs {va}",
                what(BodyOp::Cut)
            );
            return;
        }
        st.semantic += 1;
        match code(2) {
            Some("BOOLEAN_EMPTY_RESULT") => {
                assert_eq!(
                    code(1),
                    Some("BOOLEAN_NO_INTERSECTION"),
                    "{}",
                    what(BodyOp::Cut)
                );
            }
            Some("BOOLEAN_NON_MANIFOLD") => {}
            None => {
                // A manifold intersection: cut + intersect = A whenever the cut is one too.
                if code(1).is_none() {
                    assert!(
                        (vk + vi - va).abs() <= tol,
                        "{}: cut {vk} + int {vi} vs {va}",
                        what(BodyOp::Cut)
                    );
                }
            }
            Some(x) => panic!("{}: unexpected {x}", what(BodyOp::Intersect)),
        }
        if code(0) == Some("BOOLEAN_NO_INTERSECTION") {
            assert_eq!(
                code(2),
                Some("BOOLEAN_EMPTY_RESULT"),
                "{}",
                what(BodyOp::Intersect)
            );
        }
    });
    eprintln!(
        "chains seed {seed}: {} steps, {} all ok (worst {:.1e} relative), {} semantic, {} internal errors",
        st.steps,
        st.all_ok,
        st.worst_rel,
        st.semantic,
        st.internal.len()
    );
    for s in &st.internal {
        eprintln!("  {s}");
    }
    let rate = st.internal.len() as f64 / (3 * st.steps.max(1)) as f64;
    assert!(
        rate <= max_internal,
        "internal error rate {rate} per operation"
    );
    st
}

/// Random operation chains on Forge's own results (grid-snapped boxes, cylinders and
/// spheres revolved about X, Y or Z, so that tangencies at edges and poles on faces are
/// frequent): every returned body is valid and the volume identities hold at every step.
#[test]
fn chained_operations_satisfy_the_volume_identities() {
    let (chains, steps) = if cfg!(debug_assertions) {
        (2, 3)
    } else {
        (8, 6)
    };
    let st = run_chain_batch(7, chains, steps, 0.02);
    assert!(st.all_ok > 0, "{st:?}");
}

/// More chains: `CHAIN_SEEDS=1,2,3 CHAIN_COUNT=40 CHAIN_STEPS=8 cargo test --release -p
/// forge-ops --test boolean_chained chained_operations_on_more_seeds -- --ignored
/// --nocapture`.
#[test]
#[ignore]
fn chained_operations_on_more_seeds() {
    let seeds = std::env::var("CHAIN_SEEDS").unwrap_or_else(|_| "1,2,3".into());
    let n: usize = std::env::var("CHAIN_COUNT").map_or(20, |s| s.parse().expect("count"));
    let steps: usize = std::env::var("CHAIN_STEPS").map_or(8, |s| s.parse().expect("steps"));
    // Internal errors fail the run unless a rate is allowed explicitly.
    let max: f64 = std::env::var("CHAIN_MAX_INTERNAL").map_or(0.0, |s| s.parse().expect("max"));
    for s in seeds.split(',') {
        run_chain_batch(s.parse().expect("seed"), n, steps, max);
    }
}

/// Debug helper: print the faces, coedges and pcurve kinds of a named configuration's
/// result (`CHAIN_DUMP=side-boss cargo test --release -p forge-ops --test boolean_chained
/// dump -- --ignored --nocapture`).
#[test]
#[ignore]
fn dump() {
    let b = base();
    let r = match std::env::var("CHAIN_DUMP").as_deref() {
        Ok("side-boss") => op(BodyOp::Join, &b, &cyl("p", 1, [1.0, 0.5], -1.0, 0.5, 1.0)),
        Ok("top-peg") => op(BodyOp::Join, &b, &cyl("p", 2, [1.0, 0.5], 2.0, 0.5, 1.0)),
        Ok(x @ ("fitted-bma" | "fitted-bia")) => {
            let a = one_body(
                op(BodyOp::Cut, &b, &cyl("k", 2, [2.5, 0.5], -1.0, 1.25, 3.75)),
                "a",
            );
            let o = if x == "fitted-bma" {
                BodyOp::Cut
            } else {
                BodyOp::Intersect
            };
            op(o, &sphere("s", [1.75, 2.25, 1.5], 0.75, 1), &a)
        }
        Ok(x @ ("fitted-join" | "fitted-cut" | "fitted-int")) => {
            let a = one_body(
                op(BodyOp::Cut, &b, &cyl("k", 2, [2.5, 0.5], -1.0, 1.25, 3.75)),
                "a",
            );
            let o = match x {
                "fitted-join" => BodyOp::Join,
                "fitted-cut" => BodyOp::Cut,
                _ => BodyOp::Intersect,
            };
            op(o, &a, &sphere("s", [1.75, 2.25, 1.5], 0.75, 1))
        }
        other => panic!("unknown configuration {other:?}"),
    };
    let r = r.expect("op");
    for x in &r.bodies {
        eprintln!("volume {}", volume(&x.body));
        for (_, f) in x.body.faces().iter() {
            eprintln!(
                "face {} {} sense {}",
                f.provenance.name(),
                f.surface.kind_name(),
                f.sense
            );
            for &l in &f.loops {
                for &cid in &x.body.loop_(l).expect("loop").coedges {
                    let co = x.body.coedge(cid).expect("coedge");
                    let e = x.body.edge(co.edge).expect("edge");
                    let spans = match &co.pcurve {
                        Some(forge_core::geom::Curve2::BSpline(n)) => {
                            format!("deg {} knots {}", n.degree(), n.knots().len())
                        }
                        _ => String::new(),
                    };
                    let gap = co.pcurve.as_ref().map_or(0.0, |p| {
                        let (a, b) = (p.eval(e.t_range.0), p.eval(e.t_range.1));
                        f.surface.eval(a.x, a.y).distance(f.surface.eval(b.x, b.y))
                    });
                    let dev = co.pcurve.as_ref().map_or(0.0, |p| {
                        (0..=200)
                            .map(|i| {
                                let t = e.t_range.0
                                    + (e.t_range.1 - e.t_range.0) * f64::from(i) / 200.0;
                                let q = p.eval(t);
                                f.surface.eval(q.x, q.y).distance(e.curve.eval(t))
                            })
                            .fold(0.0, f64::max)
                    });
                    eprintln!("    ends 3D gap {gap:e} max dev {dev:e}");
                    eprintln!(
                        "  {} {} fwd {} range {:?} pcurve {} {spans} tol {:e}",
                        e.provenance.name(),
                        e.curve.kind_name(),
                        co.forward,
                        e.t_range,
                        co.pcurve.as_ref().map_or("none", |p| p.kind_name()),
                        e.tolerance
                    );
                }
            }
        }
    }
}

/// Debug helper: replay chain step `CHAIN_CASE=seed:chain:step:op:steps` (op = join, cut or
/// intersect; `steps` the chain length of the run that reported it, default 8: the tools
/// of a chain depend on the length of the chains before it) and run that operation once
/// more at the end (so `FORGE_BOOLEAN_DEBUG` output of the last operation is the one of
/// interest).
#[test]
#[ignore]
fn chain_case() {
    let spec = std::env::var("CHAIN_CASE").expect("CHAIN_CASE=seed:chain:step:op:steps");
    let v: Vec<&str> = spec.split(':').collect();
    let (seed, chain, step): (u64, usize, usize) = (
        v[0].parse().expect("seed"),
        v[1].parse().expect("chain"),
        v[2].parse().expect("step"),
    );
    let o = match v.get(3).copied() {
        Some("join") => BodyOp::Join,
        Some("intersect") => BodyOp::Intersect,
        _ => BodyOp::Cut,
    };
    let steps: usize = v.get(4).map_or(8, |s| s.parse().expect("steps"));
    let mut hit: Option<(Body, Body, String)> = None;
    run_chains(seed, chain + 1, steps, |s| {
        if s.chain == chain && s.step <= step {
            eprintln!("step {}: {}", s.step, tool_desc(s.tool));
        }
        if s.chain == chain && s.step == step {
            hit = Some((s.a.clone(), s.b.clone(), tool_desc(s.tool)));
            for (op, r) in s.results {
                match r {
                    Ok(r) => eprintln!("{op:?}: ok, {} bodies", r.bodies.len()),
                    Err(e) => eprintln!("{op:?}: {} {e}", e.code()),
                }
            }
        }
    });
    let (a, b, tool) = hit.expect("step reached");
    eprintln!("tool {tool}\ntarget volume {}", volume(&a));
    match op(o, &a, &b) {
        Ok(r) => eprintln!("rerun {o:?}: ok, {} bodies", r.bodies.len()),
        Err(e) => eprintln!("rerun {o:?}: {} {e}", e.code()),
    }
}

/// Review round 3, the reviewer's fitted chained case: a box minus a z-cylinder, then a
/// sphere, revolved about X, Y or Z. About Y the sphere's pole lies on the hole's wall, so
/// the sphere–cylinder section passes through the pole: it used to be one edge through it,
/// whose sphere pcurve slid along the pole line (areas off by ~2e-5 mm², the join off by
/// 2.2e-6 mm³). The section now ends at the pole, and both identities hold within 1e-9
/// relative for every axis (fitted section curves included).
#[test]
fn a_section_through_a_sphere_pole_gets_a_vertex_there() {
    let a = one_body(
        op(
            BodyOp::Cut,
            &base(),
            &cyl("k", 2, [2.5, 0.5], -1.0, 1.25, 3.75),
        ),
        "a",
    );
    for axis in 0..3 {
        let s = sphere("s", [1.75, 2.25, 1.5], 0.75, axis);
        let (va, vb) = (volume(&a), volume(&s));
        let v = |o| {
            let r = op(o, &a, &s).unwrap_or_else(|e| panic!("axis {axis} {o:?}: {e}"));
            r.bodies
                .iter()
                .map(|b| {
                    check_valid(&b.body, "fitted chain");
                    volume(&b.body)
                })
                .sum::<f64>()
        };
        let (vj, vk, vi) = (v(BodyOp::Join), v(BodyOp::Cut), v(BodyOp::Intersect));
        let tol = 1e-9 * (va + vb);
        assert!(
            (vj + vi - va - vb).abs() <= tol,
            "axis {axis}: join {vj} int {vi}"
        );
        assert!(
            (vk + vi - va).abs() <= tol,
            "axis {axis}: cut {vk} int {vi}"
        );
    }
}
