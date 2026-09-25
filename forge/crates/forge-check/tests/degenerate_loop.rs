//! SPEC §3.1 [R-5]: a sketch loop that encloses at most tol² is `SKETCH_DEGENERATE_LOOP`,
//! and the **sketch stage** decides it, on the exact 2D data. The body-level check
//! (forge-core's `LOOP_DEGENERATE`, run by forge-ops after every operation and again by
//! [`forge_check::validate`]) only sees a loop after a 3D round trip, so it must not
//! re-decide the sketch's loops within rounding of the limit: a loop the sketch accepted
//! must give a valid body, never `INVALID_RESULT`.
//!
//! Regression: error corpus `inv_s31_degenerate_loop_005` (`oracle gen --count 50 --seed
//! 31`): a triangle hole of area 1.000000001·tol² passed the sketch, then the extrude
//! failed with `INVALID_RESULT: [LOOP_DEGENERATE] loop of extrude_1/cap:start: loop
//! encloses area 9.999999955e-13, at most tolerance² = 1e-12`. The oracle evaluates it
//! `ok`.
//!
//! The body check measures loops of lines and arcs exactly (the sketch's formula) and
//! applies the strict rule — a loop must provably enclose more than tol² — to every loop
//! no sketch decided (section loops of a boolean or of a body op, including an extrude
//! cutting into its own cap; imports). Only a loop of a swept sketch region's cap whose
//! edges are all the sweep's own (by provenance) is left to the sketch, and only when it
//! may enclose more than tol² within the round trip's error and provably encloses
//! something (so never below tol²/2), measured against the least tolerance of its edges:
//! collapsed or shrunk loops, which only a construction bug produces, are still caught.

use forge_check::{body_metrics, validate};
use forge_core::Tolerance;
use forge_core::geom::{Circle3, Curve3, Line3, Plane, Surface};
use forge_core::linalg::{Frame, Vec3};
use forge_core::math::{self, PI};
use forge_core::topo::{Body, BodyBuilder, IssueCode, Provenance, Role, Severity, TopoIssue};
use forge_ir::v1::metrics::Origin;
use forge_ir::{
    Feature, Frame as IrFrame, NamedPlane, PlaneSpec, SketchAxis, SketchCurve, SketchFeature,
    SweepDirection,
};
use forge_ops::{
    BodyOp, OpBody, apply_body_op, check_revolve_profile, extrude, regions, revolve, sketch_frame,
};
use proptest::prelude::*;

const TOL: f64 = Tolerance::IR_DEFAULT.linear;

// ---------------------------------------------------------------------------------------
// Sketch construction (mirrors oracle/src/aicad_oracle/invalidgen.py `degenerate_loop`)
// ---------------------------------------------------------------------------------------

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

/// One of the 8 symmetries of the square: bit 2 swaps x and y, bit 0 negates x, bit 1
/// negates y (all exact).
fn symmetry(i: u8, p: [f64; 2]) -> [f64; 2] {
    let [mut x, mut y] = p;
    if i & 4 != 0 {
        std::mem::swap(&mut x, &mut y);
    }
    if i & 1 != 0 {
        x = -x;
    }
    if i & 2 != 0 {
        y = -y;
    }
    [x + 0.0, y + 0.0]
}

/// The triangle `(0,0), (2·tol,0), (tol, h·tol)` of area `h·tol²`, under symmetry `sym`,
/// moved by `offset`, traversed forwards or backwards, curve list rotated by `rot`.
fn triangle(h: f64, sym: u8, reversed: bool, rot: usize, offset: [f64; 2]) -> Vec<SketchCurve> {
    let pts = [[0.0, 0.0], [2.0 * TOL, 0.0], [TOL, h * TOL]].map(|p| {
        let [x, y] = symmetry(sym, p);
        [x + offset[0], y + offset[1]]
    });
    let mut tri: Vec<SketchCurve> = (0..3)
        .map(|i| line(&format!("t{i}"), pts[i], pts[(i + 1) % 3]))
        .collect();
    if reversed {
        tri = tri
            .into_iter()
            .rev()
            .map(|c| match c {
                SketchCurve::Line { id, start, end } => line(&id, end, start),
                other => other,
            })
            .collect();
    }
    tri.rotate_left(rot % 3);
    tri
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<SketchCurve> {
    let p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    (0..4)
        .map(|i| line(&format!("r{i}"), p[i], p[(i + 1) % 4]))
        .collect()
}

/// `loop_` alone (0), next to a valid rectangle (1), or as a hole in one (2).
fn layout(k: usize, loop_: Vec<SketchCurve>) -> Vec<SketchCurve> {
    match k % 3 {
        0 => loop_,
        1 => [loop_, rect(8.0, -10.0, 20.0, 5.0)].concat(),
        _ => [rect(-2.899, -4.158, 2.899, 4.158), loop_].concat(),
    }
}

fn sketch(plane: PlaneSpec, curves: Vec<SketchCurve>) -> SketchFeature {
    SketchFeature {
        id: "s1".into(),
        name: "sketch_1".into(),
        suppressed: false,
        plane,
        curves,
    }
}

fn frame_plane(origin: [f64; 3], normal: [f64; 3], x_dir: [f64; 3]) -> PlaneSpec {
    PlaneSpec::Frame(IrFrame {
        origin,
        normal,
        x_dir,
    })
}

/// The sketch plane of `inv_s31_degenerate_loop_005`.
fn plane_005() -> PlaneSpec {
    frame_plane(
        [22.761346374109294, -36.31668396908126, 42.96947919660391],
        [
            -0.9716747017531459,
            -0.18093997624508468,
            -0.15201644308877701,
        ],
        [-0.4963956415306271, 2.351172137777101, 0.37439407883726356],
    )
}

fn planes() -> Vec<PlaneSpec> {
    vec![
        PlaneSpec::Named(NamedPlane::XY),
        PlaneSpec::Named(NamedPlane::YZ),
        plane_005(),
        frame_plane(
            [-412.5, 377.25, 901.125],
            [0.3, -0.8, 0.52],
            [1.0, 0.7, 0.5],
        ),
    ]
}

// ---------------------------------------------------------------------------------------
// Evaluation (as forge-regen does it: sketch → regions → op → forge_check::validate)
// ---------------------------------------------------------------------------------------

#[derive(Debug)]
enum Outcome {
    /// The sketch stage failed with this code.
    Sketch(&'static str),
    /// The operation or the body check failed: never acceptable after a passing sketch.
    Body(String),
    /// Valid bodies, with the total region area.
    Ok(Vec<Body>, f64),
}

fn checked(body: Body) -> Result<Body, String> {
    let errors: Vec<String> = validate(&body)
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .map(ToString::to_string)
        .collect();
    if errors.is_empty() {
        Ok(body)
    } else {
        Err(errors.join("; "))
    }
}

fn run(
    sk: &SketchFeature,
    op: impl Fn(&forge_ops::Region, &Frame) -> Result<Body, forge_ops::OpError>,
) -> Outcome {
    let frame = sketch_frame(&sk.plane).expect("sketch plane");
    let regs = match regions(sk, &Tolerance::IR_DEFAULT) {
        Ok(r) => r,
        Err(e) => return Outcome::Sketch(e.code()),
    };
    let mut bodies = Vec::new();
    for r in &regs {
        match op(r, &frame) {
            Ok(b) => match checked(b) {
                Ok(b) => bodies.push(b),
                Err(e) => return Outcome::Body(format!("forge_check::validate: {e}")),
            },
            Err(e) => return Outcome::Body(format!("{}: {e}", e.code())),
        }
    }
    Outcome::Ok(bodies, regs.iter().map(|r| r.area).sum())
}

fn run_extrude(sk: &SketchFeature, distance: f64, direction: SweepDirection) -> Outcome {
    run(sk, |r, f| extrude(r, f, distance, direction, "extrude_1"))
}

/// Every body valid for `body_metrics` too, with volume = region area × distance.
fn assert_valid_extrusion(out: &Outcome, distance: f64, what: &str) {
    let Outcome::Ok(bodies, area) = out else {
        panic!("{what}: expected valid bodies, got {out:?}");
    };
    let mut volume = 0.0;
    for b in bodies {
        let m = body_metrics(b).unwrap_or_else(|e| panic!("{what}: metrics: {e}"));
        assert!(m.valid, "{what}: body_metrics says invalid");
        assert!(m.volume > 0.0, "{what}: volume {}", m.volume);
        volume += m.volume;
    }
    let want = area * distance;
    assert!(
        (volume - want).abs() <= 1e-9 * want + 1e-15,
        "{what}: volume {volume} ≠ area × distance {want}"
    );
}

/// The number of loops on the extrusion's start cap.
fn cap_loops(bodies: &[Body]) -> Vec<usize> {
    bodies
        .iter()
        .flat_map(|b| b.faces().values())
        .filter(|f| f.provenance.name().ends_with("/cap:start"))
        .map(|f| f.loops.len())
        .collect()
}

// ---------------------------------------------------------------------------------------
// The two sides of the limit, as the sketch stage decides them
// ---------------------------------------------------------------------------------------

#[test]
fn triangle_of_area_exactly_tol_squared_is_rejected_by_the_sketch_stage() {
    for plane in planes() {
        for sym in 0..8 {
            for reversed in [false, true] {
                for k in 0..3 {
                    let sk = sketch(
                        plane.clone(),
                        layout(k, triangle(1.0, sym, reversed, sym as usize, [0.0, 0.0])),
                    );
                    let out = run_extrude(&sk, 7.09, SweepDirection::Normal);
                    assert!(
                        matches!(out, Outcome::Sketch("SKETCH_DEGENERATE_LOOP")),
                        "sym {sym}, reversed {reversed}, layout {k}, {plane:?}: {out:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn triangle_just_above_tol_squared_gives_a_valid_body_in_every_layout() {
    let h = 1.0 + 1e-9;
    for plane in planes() {
        for sym in 0..8 {
            for reversed in [false, true] {
                for k in 0..3 {
                    for (distance, direction) in [
                        (7.09, SweepDirection::Normal),
                        (3.5, SweepDirection::Reverse),
                        (12.0, SweepDirection::Symmetric),
                    ] {
                        let sk = sketch(
                            plane.clone(),
                            layout(k, triangle(h, sym, reversed, sym as usize, [0.0, 0.0])),
                        );
                        let out = run_extrude(&sk, distance, direction);
                        let what = format!(
                            "sym {sym}, reversed {reversed}, layout {k}, {direction:?}, {plane:?}"
                        );
                        assert_valid_extrusion(&out, distance, &what);
                        if k == 2 {
                            // The hole is really there: outer loop + triangle.
                            let Outcome::Ok(bodies, _) = &out else {
                                unreachable!()
                            };
                            assert_eq!(cap_loops(bodies), [2], "{what}");
                        }
                    }
                }
            }
        }
    }
}

/// The exact document of the error-corpus case (IR v0, as `oracle gen` wrote it).
const INV_S31_DEGENERATE_LOOP_005: &str = r#"{
 "schema": "aicad.ir/0",
 "meta": {"name": "inv_s31_degenerate_loop_005", "description": "triangle of area 1.000000001·tol² as a hole in a valid region"},
 "parts": [{"id": "p1", "name": "part_1", "features": [
  {"type": "sketch", "id": "s1", "name": "sketch_1",
   "plane": {"origin": [22.761346374109294, -36.31668396908126, 42.96947919660391],
             "normal": [-0.9716747017531459, -0.18093997624508468, -0.15201644308877701],
             "x_dir": [-0.4963956415306271, 2.351172137777101, 0.37439407883726356]},
   "curves": [
    {"kind": "line", "id": "r0", "start": [-2.899213398334504, -4.158109484889048], "end": [2.899213398334504, -4.158109484889048]},
    {"kind": "line", "id": "r1", "start": [2.899213398334504, -4.158109484889048], "end": [2.899213398334504, 4.158109484889048]},
    {"kind": "line", "id": "r2", "start": [2.899213398334504, 4.158109484889048], "end": [-2.899213398334504, 4.158109484889048]},
    {"kind": "line", "id": "r3", "start": [-2.899213398334504, 4.158109484889048], "end": [-2.899213398334504, -4.158109484889048]},
    {"kind": "line", "id": "t2", "start": [-1.000000001e-06, 1e-06], "end": [0.0, 0.0]},
    {"kind": "line", "id": "t0", "start": [0.0, 0.0], "end": [0.0, 2e-06]},
    {"kind": "line", "id": "t1", "start": [0.0, 2e-06], "end": [-1.000000001e-06, 1e-06]}]},
  {"type": "extrude", "id": "e1", "name": "extrude_1", "sketch": "sketch_1", "distance": 7.090668327331272}]}]
}"#;

#[test]
fn error_corpus_case_inv_s31_degenerate_loop_005_extrudes_to_a_valid_body() {
    let doc = forge_ir::from_json(INV_S31_DEGENERATE_LOOP_005).expect("valid IR v0");
    let feats = &doc.parts[0].features;
    let (Feature::Sketch(sk), Feature::Extrude(ex)) = (&feats[0], &feats[1]) else {
        panic!("sketch + extrude expected");
    };
    let out = run_extrude(sk, ex.distance, ex.direction);
    assert_valid_extrusion(&out, ex.distance, "inv_s31_degenerate_loop_005");
    let Outcome::Ok(bodies, area) = &out else {
        unreachable!()
    };
    assert_eq!(cap_loops(bodies), [2]);
    // Rectangle minus the 1.000000001e-12 hole.
    let rect = (2.0 * 2.899213398334504) * (2.0 * 4.158109484889048);
    assert!((area - (rect - 1.000000001e-12)).abs() < 1e-12, "{area}");
}

#[test]
fn revolved_triangle_hole_just_above_tol_squared_gives_a_valid_body() {
    // The profile lies right of the axis x = −20; a quarter turn gives planar end caps,
    // the second one rotated off the sketch plane.
    let axis = SketchAxis {
        origin: [-20.0, 0.0],
        direction: [0.0, 1.0],
    };
    for (h, want_ok) in [(1.0 + 1e-9, true), (1.0, false)] {
        for plane in planes() {
            for sym in 0..8 {
                let sk = sketch(
                    plane.clone(),
                    layout(2, triangle(h, sym, false, 0, [0.0, 0.0])),
                );
                let out = run(&sk, |r, f| {
                    check_revolve_profile(r, &axis, TOL)?;
                    revolve(r, f, &axis, 0.5 * PI, SweepDirection::Normal, "revolve_1")
                });
                if want_ok {
                    let Outcome::Ok(bodies, _) = &out else {
                        panic!("h {h}, sym {sym}, {plane:?}: {out:?}");
                    };
                    for b in bodies {
                        assert!(body_metrics(b).expect("metrics").valid);
                    }
                } else {
                    assert!(
                        matches!(out, Outcome::Sketch("SKETCH_DEGENERATE_LOOP")),
                        "h {h}, sym {sym}, {plane:?}: {out:?}"
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Curved edges: the sketch computes the exact segment area, and so does the body check
// ---------------------------------------------------------------------------------------

/// A circular segment over the chord `(−a, 0) → (a, 0)`, bulging to `+y`, whose area is
/// `target` (the centre `(0, −d)` found by bisection; `a = 1.9·tol` keeps every point of
/// the arc within 2·tol of a shared endpoint, so R-4 accepts the pair).
fn circular_segment(target: f64, sym: u8, offset: [f64; 2]) -> (Vec<SketchCurve>, f64, f64) {
    let a = 1.9 * TOL;
    let area = |d: f64| {
        let r2 = a * a + d * d;
        let sweep = PI - 2.0 * math::atan2(d, a);
        0.5 * r2 * (sweep - math::sin(sweep))
    };
    // area(d) decreases in d.
    let (mut lo, mut hi) = (0.0, 1e-3);
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if area(mid) > target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let d = lo;
    let t = |p: [f64; 2]| {
        let [x, y] = symmetry(sym, p);
        [x + offset[0], y + offset[1]]
    };
    // A symmetry that flips orientation (odd number of swaps/negations) turns ccw arcs cw.
    let flips = (sym & 1) + ((sym >> 1) & 1) + ((sym >> 2) & 1);
    let ccw = flips.is_multiple_of(2);
    let curves = vec![
        line("c0", t([-a, 0.0]), t([a, 0.0])),
        SketchCurve::Arc {
            id: "c1".into(),
            start: t([a, 0.0]),
            end: t([-a, 0.0]),
            center: t([0.0, -d]),
            ccw,
        },
    ];
    let r = math::sqrt(a * a + d * d);
    let sweep = PI - 2.0 * math::atan2(d, a);
    (curves, r, sweep)
}

/// Area of the polygon of `n` uniform samples of the arc (both ends included) closed by
/// the chord: what a sampling check sees.
fn sampled_segment_area(r: f64, sweep: f64, n: usize) -> f64 {
    let pieces = (n - 1) as f64;
    let exact = 0.5 * r * r * (sweep - math::sin(sweep));
    let lost = pieces * 0.5 * r * r * (sweep / pieces - math::sin(sweep / pieces));
    exact - lost
}

#[test]
fn circular_segment_just_above_tol_squared_gives_a_valid_body() {
    let target = 1.001 * TOL * TOL;
    let (_, r, sweep) = circular_segment(target, 0, [0.0, 0.0]);
    // The case matters: the 9-sample polygon of this loop encloses less than tol², so a
    // body check that compares the sampled area with tol² rejects a loop the sketch
    // (exact segment area) accepts.
    assert!(sampled_segment_area(r, sweep, 9) < TOL * TOL);
    for plane in planes() {
        for sym in 0..8 {
            for k in [0, 2] {
                let (seg, ..) = circular_segment(target, sym, [0.0, 0.0]);
                let sk = sketch(plane.clone(), layout(k, seg));
                let out = run_extrude(&sk, 5.0, SweepDirection::Normal);
                assert_valid_extrusion(&out, 5.0, &format!("sym {sym}, layout {k}, {plane:?}"));
            }
        }
    }
}

#[test]
fn circular_segment_below_tol_squared_is_rejected_by_the_sketch_stage() {
    for sym in 0..8 {
        let (seg, ..) = circular_segment(0.999 * TOL * TOL, sym, [0.0, 0.0]);
        for k in [0, 2] {
            let sk = sketch(plane_005(), layout(k, seg.clone()));
            let out = run_extrude(&sk, 5.0, SweepDirection::Normal);
            assert!(
                matches!(out, Outcome::Sketch("SKETCH_DEGENERATE_LOOP")),
                "sym {sym}, layout {k}: {out:?}"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------
// The body check alone: single-face bodies built directly (no sketch in front of them)
// ---------------------------------------------------------------------------------------

/// Who made a test face, which decides the rule its loop gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Maker {
    /// An extrude's cap: face `poly/cap:end`, loop edges
    /// `poly/edge:{poly/cap:end|poly/side:sN}`: a loop the sketch stage decided.
    SketchCap,
    /// A revolve's end cap `poly/endcap:start` whose region has its profile line `s0` on
    /// the axis: that edge is shared with the other end cap
    /// (`poly/edge:{poly/endcap:end|poly/endcap:start}`), the others are side edges. A
    /// loop the sketch stage decided.
    RevolveEndCap,
    /// The same cap face with a loop a standalone `boolean` cut into it: the loop's
    /// edges are the boolean's section edges (`bool_1/edge:{poly/cap:end|tool/side:cN}`).
    BooleanSection,
    /// Review finding: the loop an extrude with `op: cut/join/intersect` cuts into its
    /// **own** cap. SPEC §5.2 names the section edges after the operation, and the body op
    /// is the extrude itself: `poly/edge:{poly/cap:end|target/side:cN}` (same feature as
    /// the cap, the other face a target's; `real_body_op_names_its_section_edges_so`
    /// checks forge-ops does this).
    BodyOpSection,
    /// A sketch cap loop with one edge (`i = 0`) replaced by such a section edge.
    PartlyCut,
    /// Edges that only resemble the sweep's own: the other face belongs to a feature
    /// whose id merely starts with the cap's (`polyx/side:sN`), is a face of the cap's
    /// feature that no sweep makes (`poly/wall:sN`), or is the cap itself.
    Lookalike,
    /// An imported face and edges.
    Imported,
}

const MAKERS: [Maker; 7] = [
    Maker::SketchCap,
    Maker::RevolveEndCap,
    Maker::BooleanSection,
    Maker::BodyOpSection,
    Maker::PartlyCut,
    Maker::Lookalike,
    Maker::Imported,
];
const SKETCH: [Maker; 2] = [Maker::SketchCap, Maker::RevolveEndCap];
const NOT_SKETCH: [Maker; 5] = [
    Maker::BooleanSection,
    Maker::BodyOpSection,
    Maker::PartlyCut,
    Maker::Lookalike,
    Maker::Imported,
];

const F: &str = "poly";

impl Maker {
    /// Whether the body check may leave this loop to the sketch stage ([R-5]).
    fn sketch_decided(self) -> bool {
        SKETCH.contains(&self)
    }
    fn face(self) -> Provenance {
        match self {
            Maker::RevolveEndCap => Provenance::end_cap_start(F),
            Maker::Imported => Provenance::new("step_1", Role::Imported).with_sources(["f1"]),
            _ => Provenance::cap_end(F),
        }
    }
    fn edge(self, i: usize) -> Provenance {
        let cap = self.face().name();
        let own_side = Provenance::side(F, format!("s{i}")).name();
        let target_side = Provenance::side("target", format!("c{i}")).name();
        match self {
            Maker::SketchCap => Provenance::edge_between(F, cap, own_side),
            Maker::RevolveEndCap if i == 0 => {
                Provenance::edge_between(F, cap, Provenance::end_cap_end(F).name())
            }
            Maker::RevolveEndCap => Provenance::edge_between(F, cap, own_side),
            Maker::BooleanSection => Provenance::edge_between(
                "bool_1",
                cap,
                Provenance::side("tool", format!("c{i}")).name(),
            ),
            Maker::BodyOpSection => Provenance::edge_between(F, cap, target_side),
            Maker::PartlyCut if i == 0 => Provenance::edge_between(F, cap, target_side),
            Maker::PartlyCut => Provenance::edge_between(F, cap, own_side),
            Maker::Lookalike => {
                let other = match i % 3 {
                    0 => Provenance::side(format!("{F}x"), format!("s{i}")).name(),
                    1 => Provenance::new(F, Role::Other("wall".into()))
                        .with_sources([format!("s{i}")])
                        .name(),
                    _ => cap.clone(),
                };
                Provenance::edge_between(F, cap, other)
            }
            Maker::Imported => {
                Provenance::new("step_1", Role::Imported).with_sources([format!("e{i}")])
            }
        }
    }
    fn vertex(self, i: usize) -> Provenance {
        match self {
            Maker::Imported => {
                Provenance::new("step_1", Role::Imported).with_sources([format!("v{i}")])
            }
            _ => Provenance::vertex_at(F, [format!("{F}/v{i}")]),
        }
    }
}

/// One piece of a planar test loop, from the previous corner to `to` (plane coordinates).
#[derive(Clone, Copy, Debug)]
enum Piece {
    Line {
        to: [f64; 2],
    },
    /// A circular arc about `center`, counter-clockwise in the plane if `ccw`.
    Arc {
        to: [f64; 2],
        center: [f64; 2],
        ccw: bool,
    },
}

fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

/// Counter-clockwise sweep from direction `a` to direction `b`, in `(0, 2π]`.
fn ccw_sweep(a: [f64; 2], b: [f64; 2]) -> f64 {
    let s = math::atan2(b[1], b[0]) - math::atan2(a[1], a[0]);
    if s <= 0.0 { s + 2.0 * PI } else { s }
}

/// One planar face (open shell, sense = true) bounded by the closed loop that starts at
/// `start` and follows `pieces` (the last one ends at `start`), in the plane coordinates
/// of `frame`. With `reversed`, every edge runs the other way (curve from the piece's end
/// to its start) and the loop uses it backwards.
fn loop_face(
    frame: Frame,
    start: [f64; 2],
    pieces: &[Piece],
    maker: Maker,
    reversed: bool,
) -> Body {
    let n = pieces.len();
    let w = |p: [f64; 2]| frame.to_world_point(Vec3::new(p[0], p[1], 0.0));
    let mut corners = vec![start];
    for pc in &pieces[..n - 1] {
        corners.push(match *pc {
            Piece::Line { to } | Piece::Arc { to, .. } => to,
        });
    }
    let mut b = BodyBuilder::new();
    let vs: Vec<_> = (0..n)
        .map(|i| {
            b.add_vertex(w(corners[i]), maker.vertex(i))
                .expect("vertex")
        })
        .collect();
    let es: Vec<_> = (0..n)
        .map(|i| {
            let (mut a, mut z) = (corners[i], corners[(i + 1) % n]);
            let mut piece = pieces[i];
            if reversed {
                std::mem::swap(&mut a, &mut z);
                if let Piece::Arc { ref mut ccw, .. } = piece {
                    *ccw = !*ccw;
                }
            }
            let (vi, vz) = if reversed {
                (vs[(i + 1) % n], vs[i])
            } else {
                (vs[i], vs[(i + 1) % n])
            };
            let (curve, range) = match piece {
                Piece::Line { .. } => {
                    let line = Line3::through(w(a), w(z)).expect("distinct corners");
                    (Curve3::Line(line), (0.0, w(a).distance(w(z))))
                }
                Piece::Arc { center, ccw, .. } => {
                    let (da, dz) = (sub(a, center), sub(z, center));
                    let r = math::sqrt(da[0] * da[0] + da[1] * da[1]);
                    let axis = if ccw { frame.z() } else { -frame.z() };
                    let cf =
                        Frame::from_normal_x(w(center), axis, w(a) - w(center)).expect("arc frame");
                    let sweep = if ccw {
                        ccw_sweep(da, dz)
                    } else {
                        ccw_sweep(dz, da)
                    };
                    let circle = Circle3::new(cf, r).expect("circle");
                    (Curve3::Circle(circle), (0.0, sweep))
                }
            };
            b.add_edge(curve, range, vi, vz, maker.edge(i))
                .expect("edge")
        })
        .collect();
    let shell = b.add_shell(false);
    let face = b
        .add_face(shell, Surface::Plane(Plane::new(frame)), true, maker.face())
        .expect("face");
    let uses: Vec<_> = es.iter().map(|&e| (e, !reversed)).collect();
    b.add_loop(face, &uses).expect("closed loop");
    b.finish()
}

fn polygon_face(frame: Frame, corners: &[[f64; 2]], maker: Maker) -> Body {
    let n = corners.len();
    let pieces: Vec<_> = (0..n)
        .map(|i| Piece::Line {
            to: corners[(i + 1) % n],
        })
        .collect();
    loop_face(frame, corners[0], &pieces, maker, false)
}

/// A face bounded by one ring edge: the circle of radius `r` about `center`
/// (counter-clockwise, the outer loop of a face with sense = true). With `flip`, the
/// circle's axis is opposite the plane normal and the loop uses it backwards.
fn ring_face(frame: Frame, center: [f64; 2], r: f64, maker: Maker, flip: bool) -> Body {
    let c = frame.to_world_point(Vec3::new(center[0], center[1], 0.0));
    let axis = if flip { -frame.z() } else { frame.z() };
    let cf = Frame::from_normal_x(c, axis, frame.x()).expect("ring frame");
    let mut b = BodyBuilder::new();
    let e = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(cf, r).expect("circle")),
            maker.edge(0),
        )
        .expect("ring");
    let shell = b.add_shell(false);
    let face = b
        .add_face(shell, Surface::Plane(Plane::new(frame)), true, maker.face())
        .expect("face");
    b.add_loop(face, &[(e, !flip)]).expect("ring loop");
    b.finish()
}

/// Reference area of a test loop, independent of the body check's formula: the dense
/// polygon of 20 000 points per arc (relative error ~(θ/20 000)²/12 < 1e-8).
fn reference_area(start: [f64; 2], pieces: &[Piece]) -> f64 {
    let mut pts = vec![start];
    let mut at = start;
    for pc in pieces {
        match *pc {
            Piece::Line { to } => pts.push(to),
            Piece::Arc { to, center, ccw } => {
                let (da, dz) = (sub(at, center), sub(to, center));
                let r = math::sqrt(da[0] * da[0] + da[1] * da[1]);
                let a0 = math::atan2(da[1], da[0]);
                let sweep = if ccw {
                    ccw_sweep(da, dz)
                } else {
                    -ccw_sweep(dz, da)
                };
                const N: usize = 20_000;
                for k in 1..N {
                    let t = a0 + sweep * (k as f64 / N as f64);
                    pts.push([center[0] + r * math::cos(t), center[1] + r * math::sin(t)]);
                }
                pts.push(to);
            }
        }
        at = pts[pts.len() - 1];
    }
    pts.pop(); // back at the start
    let o = pts[0];
    let n = pts.len();
    0.5 * (0..n)
        .map(|i| {
            let (a, b) = (sub(pts[i], o), sub(pts[(i + 1) % n], o));
            a[0] * b[1] - a[1] * b[0]
        })
        .sum::<f64>()
}

fn issues_of(body: &Body) -> Vec<TopoIssue> {
    forge_core::topo::validate(body)
        .into_iter()
        .filter(|i| {
            matches!(
                i.code,
                IssueCode::LoopOrientation | IssueCode::LoopDegenerate
            )
        })
        .collect()
}

fn loop_codes(body: &Body) -> Vec<IssueCode> {
    issues_of(body).into_iter().map(|i| i.code).collect()
}

/// The world frame (exact plane coordinates) and two far, rotated frames.
fn frames() -> Vec<Frame> {
    vec![
        Frame::world(),
        Frame::from_normal_x(
            Vec3::new(22.761346374109294, -36.31668396908126, 42.96947919660391),
            Vec3::new(
                -0.9716747017531459,
                -0.18093997624508468,
                -0.15201644308877701,
            ),
            Vec3::new(-0.4963956415306271, 2.351172137777101, 0.37439407883726356),
        )
        .expect("frame"),
        Frame::from_normal_x(
            Vec3::new(-412.5, 377.25, 901.125),
            Vec3::new(0.3, -0.8, 0.52),
            Vec3::new(1.0, 0.7, 0.5),
        )
        .expect("frame"),
    ]
}

/// Counter-clockwise triangle `(0,0), (2·tol,0), (tol, h·tol)` of area `h·tol²`.
fn tri_corners(h: f64, offset: [f64; 2]) -> Vec<[f64; 2]> {
    [[0.0, 0.0], [2.0 * TOL, 0.0], [TOL, h * TOL]]
        .map(|[x, y]| [x + offset[0], y + offset[1]])
        .to_vec()
}

/// A sliver `(off, 0), (off + len, 0), (off + len/2, height)` of area `frac·tol²`.
fn sliver(len: f64, off: f64, frac: f64) -> Vec<[f64; 2]> {
    let height = 2.0 * frac * TOL * TOL / len;
    vec![[off, 0.0], [off + len, 0.0], [off + 0.5 * len, height]]
}

#[test]
fn body_check_rejects_loops_at_or_below_tol_squared() {
    for frame in frames() {
        for maker in MAKERS {
            // At or below the limit, collapsed included: degenerate for every maker (the
            // round-off of these µm loops is ~1e-5·tol² at most).
            for h in [0.0, 0.5, 0.9, 0.999] {
                let corners = if h == 0.0 {
                    vec![[0.0, 0.0], [0.1, 0.0], [0.2, 0.0]]
                } else {
                    tri_corners(h, [0.0, 0.0])
                };
                assert_eq!(
                    loop_codes(&polygon_face(frame, &corners, maker)),
                    [IssueCode::LoopDegenerate],
                    "h {h}, {maker:?}, {frame:?}"
                );
            }
            // Controls: clearly above the limit, valid.
            for h in [1.001, 2.0] {
                assert_eq!(
                    loop_codes(&polygon_face(frame, &tri_corners(h, [0.0, 0.0]), maker)),
                    [],
                    "h {h}, {maker:?}, {frame:?}"
                );
            }
        }
        // Just above the limit: within the round trip of the rotated frames, so only the
        // sketch-decided loop may pass there (a loop no sketch decided must provably
        // enclose more than tol²); in the world frame (exact coordinates) the strict rule
        // sees it above tol² too.
        let above = tri_corners(1.0 + 1e-9, [0.0, 0.0]);
        for maker in SKETCH {
            assert_eq!(
                loop_codes(&polygon_face(frame, &above, maker)),
                [],
                "{maker:?}, {frame:?}"
            );
        }
        if frame != Frame::world() {
            for maker in NOT_SKETCH {
                assert_eq!(
                    loop_codes(&polygon_face(frame, &above, maker)),
                    [IssueCode::LoopDegenerate],
                    "{maker:?}, {frame:?}"
                );
            }
        }
    }
    let world = Frame::world();
    for maker in MAKERS {
        let above = tri_corners(1.0 + 1e-9, [0.0, 0.0]);
        assert_eq!(
            loop_codes(&polygon_face(world, &above, maker)),
            [],
            "{maker:?}"
        );
        // 1e-9 below: degenerate for everyone.
        let below = tri_corners(1.0 - 1e-9, [0.0, 0.0]);
        assert_eq!(
            loop_codes(&polygon_face(world, &below, maker)),
            [IssueCode::LoopDegenerate],
            "{maker:?}"
        );
    }
    // Exactly tol²: degenerate unless the sketch decided the loop (it rejects exactly
    // tol², so such a cap never reaches the body check, see the sketch-stage tests).
    let exact = tri_corners(1.0, [0.0, 0.0]);
    for maker in NOT_SKETCH {
        assert_eq!(
            loop_codes(&polygon_face(world, &exact, maker)),
            [IssueCode::LoopDegenerate],
            "{maker:?}"
        );
    }
    for maker in SKETCH {
        assert_eq!(
            loop_codes(&polygon_face(world, &exact, maker)),
            [],
            "{maker:?}"
        );
    }
}

/// Review finding: loops no sketch decided — a boolean's section loop, an imported
/// face — get the strict rule at any scale. Millimetre slivers of area 0.3–1.0·tol² in
/// the world frame (exact coordinates) and in rotated frames far from the origin were
/// accepted by the earlier, unconditional relaxation.
#[test]
fn loops_no_sketch_decided_get_the_strict_rule() {
    let fracs = [0.3, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 0.99, 1.0];
    for frame in frames() {
        for (len, off) in [(5.0, 9.0), (4.0, 12.0), (3.0, 20.0), (5.0, 6.0)] {
            for frac in fracs {
                for maker in NOT_SKETCH {
                    let body = polygon_face(frame, &sliver(len, off, frac), maker);
                    assert_eq!(
                        loop_codes(&body),
                        [IssueCode::LoopDegenerate],
                        "sliver {len} mm at {off} mm, frac {frac}, {maker:?}, {frame:?}"
                    );
                }
            }
        }
        // Full circles of area frac·tol² (a ring edge, exact area π·r²).
        for frac in [0.5, 0.8, 0.82, 0.85, 0.9, 0.95, 0.99, 0.999_999, 1.0] {
            let r = math::sqrt(frac * TOL * TOL / PI);
            for center in [[0.0, 0.0], [7.25, -3.5]] {
                for (maker, flip) in NOT_SKETCH.into_iter().flat_map(|m| [(m, false), (m, true)]) {
                    assert_eq!(
                        loop_codes(&ring_face(frame, center, r, maker, flip)),
                        [IssueCode::LoopDegenerate],
                        "circle frac {frac} at {center:?}, {maker:?}, flip {flip}, {frame:?}"
                    );
                }
            }
        }
        // Controls: the same shapes at 1.001·tol² (µm-sized, so well above their
        // round-off) are valid for every maker.
        let r = math::sqrt(1.001 * TOL * TOL / PI);
        for maker in MAKERS {
            for flip in [false, true] {
                assert_eq!(
                    loop_codes(&ring_face(frame, [7.25, -3.5], r, maker, flip)),
                    [],
                    "{maker:?}, flip {flip}, {frame:?}"
                );
            }
        }
    }
}

/// Review finding: an extrude or revolve with `op: cut/join/intersect` is its own body
/// op, so the section edges it cuts into its **own** cap carry the cap's feature
/// (`poly/edge:{poly/cap:end|target/side:cN}`). The earlier classification took such a
/// loop for the sketch's and gave it the relaxed band; it gets the strict rule. Each
/// case below is one where the sweep's own loop (`SKETCH`) is left to the sketch, so
/// the assertions fail under that classification.
#[test]
fn body_op_section_loops_on_the_ops_own_cap_get_the_strict_rule() {
    let world = Frame::world();
    let cut = [Maker::BodyOpSection, Maker::PartlyCut, Maker::Lookalike];
    // Exactly tol² in exact coordinates.
    let exact = tri_corners(1.0, [0.0, 0.0]);
    // 1 + 1e-9 in rotated frames (within their round trip's round-off).
    let above = tri_corners(1.0 + 1e-9, [0.0, 0.0]);
    // A 5 mm sliver 6 mm from the origin: its round trip's round-off is ~0.8·tol², so
    // the sketch-decided band reaches down to ~0.8·tol² for it.
    let slivers: Vec<_> = [0.85, 0.9, 0.99, 1.0]
        .map(|frac| sliver(5.0, 6.0, frac))
        .to_vec();
    let mut cases = vec![(world, exact)];
    cases.extend(frames().into_iter().skip(1).map(|f| (f, above.clone())));
    cases.extend(slivers.into_iter().map(|c| (world, c)));
    for (frame, corners) in &cases {
        for maker in SKETCH {
            assert_eq!(
                loop_codes(&polygon_face(*frame, corners, maker)),
                [],
                "{maker:?} (sketch-decided), {corners:?}, {frame:?}"
            );
        }
        for maker in cut {
            assert_eq!(
                loop_codes(&polygon_face(*frame, corners, maker)),
                [IssueCode::LoopDegenerate],
                "{maker:?}, {corners:?}, {frame:?}"
            );
        }
    }
}

/// The premise of [`Maker::BodyOpSection`], on forge-ops' real body op: extrude `e2`
/// with `op: cut` (the body op is the extrude itself: `apply_body_op(.., "e2")`) pockets
/// box `t` across one of its sides. The pocket floor is `e2`'s start cap; `t`'s side cuts
/// it with the section edge `e2/edge:{e2/cap:start|t/side:…}` — the cap's own feature,
/// the other face the target's — next to pieces of `e2`'s own cap edges. The result, an
/// ordinary pocket, is valid.
#[test]
fn real_body_op_names_its_section_edges_so() {
    let body_of = |id: &str, z: f64, curves: Vec<SketchCurve>, d: f64| -> Body {
        let sk = SketchFeature {
            id: format!("s_{id}"),
            name: format!("s_{id}"),
            suppressed: false,
            plane: frame_plane([0.0, 0.0, z], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
            curves,
        };
        let frame = sketch_frame(&sk.plane).expect("frame");
        let regs = regions(&sk, &Tolerance::IR_DEFAULT).expect("regions");
        assert_eq!(regs.len(), 1);
        extrude(&regs[0], &frame, d, SweepDirection::Normal, id).expect("extrude")
    };
    let operand = |body, feature: &str, timeline| OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "r0".into(),
            instance: None,
        },
        timeline,
    };
    let target = body_of("t", 0.0, rect(0.0, 0.0, 10.0, 10.0), 10.0);
    let tool = body_of("e2", 5.0, rect(5.0, 2.0, 15.0, 8.0), 10.0);
    let res = apply_body_op(
        BodyOp::Cut,
        &[operand(target, "t", 0)],
        &[operand(tool, "e2", 1)],
        "e2",
    )
    .unwrap_or_else(|e| panic!("cut: {} {e}", e.code()));
    assert_eq!(res.bodies.len(), 1);
    let body = &res.bodies[0].body;
    assert!(body_metrics(body).expect("metrics").valid);
    assert_eq!(issues_of(body), []);
    let floor = body
        .faces()
        .values()
        .find(|f| f.provenance.feature == "e2" && f.provenance.role == Role::CapStart)
        .expect("the pocket floor is e2's start cap");
    let cap = floor.provenance.name();
    let (mut own, mut section) = (0, 0);
    for &lid in &floor.loops {
        for &cid in &body.loop_(lid).expect("loop").coedges {
            let c = body.coedge(cid).expect("coedge");
            let p = &body.edge(c.edge).expect("edge").provenance;
            assert_eq!(
                (p.feature.as_str(), &p.role),
                ("e2", &Role::EdgeBetween),
                "{p:?}"
            );
            assert!(p.sources.contains(&cap), "{p:?}");
            let other = p.sources.iter().find(|s| **s != cap).expect("other face");
            if other.starts_with("e2/side") {
                own += 1;
            } else if other.starts_with("t/") {
                section += 1;
            } else {
                panic!("unexpected edge {}", p.name());
            }
        }
    }
    assert_eq!((own, section), (3, 1), "floor loop of {cap}");
}

/// Review finding: a boolean may raise an edge's tolerance above the document's (its
/// pcurve error), and the body check measures a loop against the largest tolerance of
/// its edges. A sketch-decided loop is measured against the least one — the closest to
/// the document tolerance the sketch used — so a hole the sketch accepted does not fail
/// after an unrelated boolean raised one of its edges' tolerances. Every other loop
/// keeps the largest.
#[test]
fn sketch_decided_loops_use_the_least_edge_tolerance() {
    let world = Frame::world();
    // Raise the tolerance of the first `raised` edges (arena order) to `t`.
    let raise = |body: Body, raised: usize, t: f64| -> Body {
        let ids: Vec<_> = body.edges().iter().map(|(id, _)| id).take(raised).collect();
        let mut b = BodyBuilder::from_body(body, Tolerance::IR_DEFAULT);
        for id in ids {
            b.set_edge_tolerance(id, t).expect("tolerance");
        }
        b.finish()
    };
    let above = tri_corners(1.0 + 1e-9, [0.0, 0.0]);
    for maker in MAKERS {
        let body = raise(polygon_face(world, &above, maker), 1, 2.0 * TOL);
        let want: &[IssueCode] = if maker.sketch_decided() {
            &[]
        } else {
            &[IssueCode::LoopDegenerate]
        };
        assert_eq!(loop_codes(&body), want, "{maker:?}");
    }
    // Below tol² stays degenerate, reported against the document tolerance.
    for maker in SKETCH {
        let body = raise(
            polygon_face(world, &tri_corners(0.999, [0.0, 0.0]), maker),
            1,
            2.0 * TOL,
        );
        let issues = issues_of(&body);
        assert_eq!(issues.len(), 1, "{maker:?}: {issues:?}");
        assert_eq!(issues[0].allowed, Some(TOL * TOL), "{maker:?}");
    }
    // Known limitation (loud, never silent): with every edge raised, the least tolerance
    // is the raised one.
    for maker in SKETCH {
        let body = raise(polygon_face(world, &above, maker), 3, 2.0 * TOL);
        assert_eq!(loop_codes(&body), [IssueCode::LoopDegenerate], "{maker:?}");
    }
}

/// A sketch-decided loop is only left to the sketch when it may enclose more than tol²
/// and provably encloses something (`a > err`, `a + err > tol²`, so `a > tol²/2`):
/// millimetre slivers are within their own round-off of zero, circles are measured
/// exactly.
#[test]
fn sketch_decided_loops_are_deferred_only_within_their_round_off() {
    for frame in frames() {
        for (len, off) in [(5.0, 9.0), (4.0, 12.0), (3.0, 20.0), (5.0, 6.0)] {
            for frac in [0.3, 0.5, 0.55, 0.6] {
                for maker in SKETCH {
                    let body = polygon_face(frame, &sliver(len, off, frac), maker);
                    assert_eq!(
                        loop_codes(&body),
                        [IssueCode::LoopDegenerate],
                        "sliver {len} mm at {off} mm, frac {frac}, {maker:?}, {frame:?}"
                    );
                }
            }
        }
        // Circles: no vertices, so only the radius's round-off (~1e-4·tol² 900 mm from
        // the origin) separates them from the limit.
        for frac in [0.5, 0.8, 0.9, 0.99, 0.999] {
            let r = math::sqrt(frac * TOL * TOL / PI);
            for center in [[0.0, 0.0], [7.25, -3.5]] {
                for (maker, flip) in SKETCH.into_iter().flat_map(|m| [(m, false), (m, true)]) {
                    assert_eq!(
                        loop_codes(&ring_face(frame, center, r, maker, flip)),
                        [IssueCode::LoopDegenerate],
                        "circle frac {frac} at {center:?}, {maker:?}, flip {flip}, {frame:?}"
                    );
                }
            }
        }
    }
    // A collapsed sketch-decided loop far from the origin is still caught, and so is a
    // sliver whose area is below its own round-off although the band reaches above tol².
    let world = Frame::world();
    let flat = [[100.0, 100.0], [120.0, 100.0], [140.0, 100.0]];
    let thin = [[100.0, 100.0], [140.0, 100.0], [120.0, 100.0 + 2.5e-14]];
    for corners in [flat, thin] {
        for maker in SKETCH {
            assert_eq!(
                loop_codes(&polygon_face(world, &corners, maker)),
                [IssueCode::LoopDegenerate],
                "{corners:?}, {maker:?}"
            );
        }
    }
}

/// Test loops of lines and arcs (convex and concave arcs, both turning directions),
/// scaled by `s`, each with its start point.
fn arc_loops(s: f64) -> Vec<([f64; 2], Vec<Piece>)> {
    let p = |x: f64, y: f64| [x * s, y * s];
    vec![
        // "D": chord (−1,0)→(1,0), arc back over the top (ccw about (0,−0.4)).
        (
            p(-1.0, 0.0),
            vec![
                Piece::Line { to: p(1.0, 0.0) },
                Piece::Arc {
                    to: p(-1.0, 0.0),
                    center: p(0.0, -0.4),
                    ccw: true,
                },
            ],
        ),
        // Square with its top side bulging inwards (a clockwise arc about (0.5, 1.8)).
        (
            p(0.0, 0.0),
            vec![
                Piece::Line { to: p(1.0, 0.0) },
                Piece::Line { to: p(1.0, 1.0) },
                Piece::Arc {
                    to: p(0.0, 1.0),
                    center: p(0.5, 1.8),
                    ccw: false,
                },
                Piece::Line { to: p(0.0, 0.0) },
            ],
        ),
        // Lens of two arcs; the second one spans more than a half turn (major arc).
        (
            p(-1.0, 0.0),
            vec![
                Piece::Arc {
                    to: p(1.0, 0.0),
                    center: p(0.0, 0.5),
                    ccw: true,
                },
                Piece::Arc {
                    to: p(-1.0, 0.0),
                    center: p(0.0, 0.3),
                    ccw: true,
                },
            ],
        ),
        // Triangle with a convex arc side (bulging out, below) and a concave one (bulging
        // in, a clockwise arc about a centre outside).
        (
            p(0.0, 0.0),
            vec![
                Piece::Arc {
                    to: p(2.0, 0.0),
                    center: p(1.0, 1.5),
                    ccw: true,
                },
                Piece::Line { to: p(1.0, 1.6) },
                Piece::Arc {
                    to: p(0.0, 0.0),
                    center: p(-1.1, 1.8),
                    ccw: false,
                },
            ],
        ),
    ]
}

/// The body check measures loops of lines and arcs exactly (the sketch's formula), so its
/// decision and its reported area match the true area, not the sampled polygon's.
#[test]
fn loops_with_arcs_are_measured_exactly() {
    for (start, pieces) in arc_loops(1.0) {
        let unit = reference_area(start, &pieces);
        assert!(unit > 0.0, "{pieces:?}");
        for (frame, reversed) in frames().into_iter().flat_map(|f| [(f, false), (f, true)]) {
            for maker in MAKERS {
                // Scaled to 0.9·tol²: degenerate, reported with its exact area.
                let s = math::sqrt(0.9 * TOL * TOL / unit);
                let (start_s, pieces_s) = arc_loops(s)
                    .into_iter()
                    .find(|(_, p)| p.len() == pieces.len() && matches_shape(p, &pieces))
                    .expect("same shape");
                let want = reference_area(start_s, &pieces_s);
                let body = loop_face(frame, start_s, &pieces_s, maker, reversed);
                let issues = issues_of(&body);
                assert_eq!(issues.len(), 1, "{maker:?}, {frame:?}: {issues:#?}");
                assert_eq!(issues[0].code, IssueCode::LoopDegenerate);
                let got = issues[0].measured.expect("measured");
                assert!(
                    (got - want).abs() <= 1e-6 * want,
                    "{pieces:?}, {maker:?}, {frame:?}: measured {got:e}, want {want:e}"
                );
                // Scaled to 1.01·tol²: valid (and correctly oriented) for every maker.
                let s = math::sqrt(1.01 * TOL * TOL / unit);
                let (start_s, pieces_s) = arc_loops(s)
                    .into_iter()
                    .find(|(_, p)| p.len() == pieces.len() && matches_shape(p, &pieces))
                    .expect("same shape");
                assert_eq!(
                    loop_codes(&loop_face(frame, start_s, &pieces_s, maker, reversed)),
                    [],
                    "{pieces:?}, {maker:?}, reversed {reversed}, {frame:?}"
                );
            }
        }
    }
}

/// Same sequence of piece kinds and arc directions.
fn matches_shape(a: &[Piece], b: &[Piece]) -> bool {
    a.iter().zip(b).all(|(x, y)| match (x, y) {
        (Piece::Line { .. }, Piece::Line { .. }) => true,
        (Piece::Arc { ccw: p, .. }, Piece::Arc { ccw: q, .. }) => p == q,
        _ => false,
    })
}

#[test]
fn degenerate_loop_issue_reports_the_area_and_the_limit() {
    let body = polygon_face(
        Frame::world(),
        &tri_corners(0.5, [0.0, 0.0]),
        Maker::SketchCap,
    );
    let issues = forge_core::topo::validate(&body);
    let deg: Vec<_> = issues
        .iter()
        .filter(|i| i.code == IssueCode::LoopDegenerate)
        .collect();
    assert_eq!(deg.len(), 1, "{issues:#?}");
    assert_eq!(deg[0].allowed, Some(TOL * TOL));
    let a = deg[0].measured.expect("measured area");
    assert!((a - 0.5 * TOL * TOL).abs() < 1e-24, "{a}");
    assert!(
        deg[0].message.contains("not provably more than tolerance²"),
        "{}",
        deg[0].message
    );
}

#[test]
fn body_check_is_deterministic() {
    let frame = frames()[2];
    for maker in MAKERS {
        let body = polygon_face(frame, &tri_corners(1.0 + 1e-9, [3.25, -7.5]), maker);
        let first = forge_core::topo::validate(&body);
        for _ in 0..5 {
            assert_eq!(forge_core::topo::validate(&body), first);
        }
    }
}

// ---------------------------------------------------------------------------------------
// The round trip the sketch-decided allowance covers, measured
// ---------------------------------------------------------------------------------------

/// The body's coordinate scale as the body check computes it: the largest |coordinate|
/// of its vertices, surface frame origins and circle centres.
fn coordinate_scale(body: &Body) -> f64 {
    let mut m = 0.0f64;
    for v in body.vertices().values() {
        m = math::max(m, v.point.max_abs_component());
    }
    for f in body.faces().values() {
        let o = match &f.surface {
            Surface::Plane(s) => Some(s.frame().origin()),
            Surface::Cylinder(s) => Some(s.frame().origin()),
            Surface::Cone(s) => Some(s.frame().origin()),
            Surface::Sphere(s) => Some(s.frame().origin()),
            Surface::Torus(s) => Some(s.frame().origin()),
            Surface::Helicoid(s) => Some(s.frame().origin()),
            Surface::BSpline(_) => None,
        };
        if let Some(o) = o {
            m = math::max(m, o.max_abs_component());
        }
    }
    for e in body.edges().values() {
        if let Curve3::Circle(c) = &e.curve {
            m = math::max(m, c.frame().origin().max_abs_component());
        }
    }
    m
}

/// For every cap loop of `body` (a sweep of the single-loop region with sketch area
/// `sketch_area`): `|A_cap − A_sketch|` in units of `½·ε·M·Σ‖p_{i+1} − p_{i−1}‖₁`, the
/// ulps of `M` per plane coordinate the round trip actually cost.
fn cap_round_trip_ulps(body: &Body, sketch_area: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let m = coordinate_scale(body);
    for f in body.faces().values() {
        if !matches!(
            f.provenance.role,
            Role::CapStart | Role::CapEnd | Role::EndCapStart | Role::EndCapEnd
        ) {
            continue;
        }
        let Surface::Plane(plane) = &f.surface else {
            panic!("planar cap expected");
        };
        for lid in &f.loops {
            let lp = body.loop_(*lid).expect("loop");
            let pts: Vec<[f64; 2]> = lp
                .coedges
                .iter()
                .map(|cid| {
                    let c = body.coedge(*cid).expect("coedge");
                    let e = body.edge(c.edge).expect("edge");
                    let v = if c.forward { e.start } else { e.end };
                    let (u, w, _) =
                        plane.project(body.vertex(v.expect("vertex")).expect("v").point);
                    [u, w]
                })
                .collect();
            let n = pts.len();
            let (mut twice, mut spread) = (0.0, 0.0);
            for i in 0..n {
                let (a, b) = (sub(pts[i], pts[0]), sub(pts[(i + 1) % n], pts[0]));
                twice += a[0] * b[1] - a[1] * b[0];
                let d = sub(pts[(i + 1) % n], pts[(i + n - 1) % n]);
                spread += d[0].abs() + d[1].abs();
            }
            let diff = (0.5 * twice).abs() - sketch_area.abs();
            out.push(diff.abs() / (0.5 * f64::EPSILON * m * spread));
        }
    }
    out
}

/// The allowance the body check grants a sketch-decided loop's plane coordinates
/// (forge-core `SKETCH_LOOP_ROUNDOFF_ULPS`).
const SKETCH_LOOP_ROUNDOFF_ULPS: f64 = 64.0;

// ---------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------

fn unit(v: [f64; 3]) -> Option<[f64; 3]> {
    let n = math::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    (n > 0.1).then(|| [v[0] / n, v[1] / n, v[2] / n])
}

prop_compose! {
    fn arb_plane()(
        o in prop::array::uniform3(-500.0..500.0f64),
        n in prop::array::uniform3(-1.0..1.0f64),
        x in prop::array::uniform3(-1.0..1.0f64),
    ) -> Option<PlaneSpec> {
        let n = unit(n)?;
        // x_dir must not be parallel to the normal.
        let c = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
        unit(c)?;
        Some(frame_plane(o, n, x))
    }
}

/// The world frame and its axis permutations and reflections, at the origin: lifting to
/// 3D and projecting back is exact, so a test face holds exactly the intended loop.
fn arb_exact_frame() -> impl Strategy<Value = Frame> {
    (0usize..3, any::<bool>(), any::<bool>()).prop_map(|(k, flip_n, flip_x)| {
        let axes = [Vec3::unit_x(), Vec3::unit_y(), Vec3::unit_z()];
        let s = |f: bool| if f { -1.0 } else { 1.0 };
        let n = axes[k] * s(flip_n);
        let x = axes[(k + 1) % 3] * s(flip_x);
        Frame::from_normal_x(Vec3::zero(), n, x).expect("axis frame")
    })
}

/// Log-uniform in `[lo, hi]`.
fn log_uniform(lo: f64, hi: f64) -> impl Strategy<Value = f64> {
    (0.0..1.0f64).prop_map(move |t| lo * math::exp(t * math::ln(hi / lo)))
}

fn arb_maker() -> impl Strategy<Value = Maker> {
    prop::sample::select(MAKERS.to_vec())
}

fn arb_apex() -> impl Strategy<Value = f64> {
    prop_oneof![
        Just(1.0),
        Just(1.0 + 1e-9),
        Just(1.0 - 1e-9),
        Just(1.0 + 1e-8),
        Just(1.0 + 1e-6),
        0.9..1.1f64,
    ]
}

fn arb_offset() -> impl Strategy<Value = [f64; 2]> {
    prop_oneof![Just([0.0, 0.0]), prop::array::uniform2(-30.0..30.0f64)]
}

fn arb_direction() -> impl Strategy<Value = SweepDirection> {
    prop_oneof![
        Just(SweepDirection::Normal),
        Just(SweepDirection::Reverse),
        Just(SweepDirection::Symmetric),
    ]
}

/// Triangle `(0,0), (base,0), (apex·base, height)` of area `h·tol²`, moved by `offset`,
/// or `None` when its corners are not distinct in 3D.
fn thin_triangle(
    frame: &Frame,
    h: f64,
    base: f64,
    apex: f64,
    offset: [f64; 2],
) -> Option<Vec<[f64; 2]>> {
    let height = 2.0 * h * TOL * TOL / base;
    let corners = [[0.0, 0.0], [base, 0.0], [apex * base, height]]
        .map(|[x, y]| [x + offset[0], y + offset[1]]);
    let p = |c: [f64; 2]| frame.to_world_point(Vec3::new(c[0], c[1], 0.0));
    (0..3)
        .all(|i| p(corners[i]).distance(p(corners[(i + 1) % 3])) > 1e-3 * TOL)
        .then(|| corners.to_vec())
}

proptest! {
    /// Whatever the sketch stage decides for a tiny triangle — anywhere in the sketch,
    /// on any plane, alone, beside or inside another region — the body check agrees: a
    /// rejection always comes from the sketch stage, an accepted sketch gives valid
    /// bodies. At the sketch origin (exact coordinates) the decision is exactly `h > 1`,
    /// and a rejection is `SKETCH_DEGENERATE_LOOP`.
    #[test]
    fn sketch_stage_and_body_check_agree(
        plane in arb_plane(),
        h in arb_apex(),
        sym in 0u8..8,
        reversed in any::<bool>(),
        rot in 0usize..3,
        k in 0usize..3,
        offset in arb_offset(),
        // ≥ 2 mm: a lone tiny-triangle body is then ≥ 2e-12 mm³. Below ~1e-12 mm³,
        // forge-check's SHELL_ZERO_VOLUME (|V| ≤ 1e-12·max(A, 1 mm²)^{3/2}) rejects it,
        // a separate issue from the loop-area rule (reported, not covered here).
        distance in 2.0..20.0f64,
        direction in arb_direction(),
    ) {
        let Some(plane) = plane else { return Ok(()) };
        // Keep the triangle clear of the layout's other rectangle.
        let offset = if k == 1 { [offset[0].min(0.0) - 1.0, offset[1]] } else if k == 2 {
            [offset[0].clamp(-2.0, 2.0), offset[1].clamp(-3.0, 3.0)]
        } else { offset };
        let sk = sketch(plane, layout(k, triangle(h, sym, reversed, rot, offset)));
        let out = run_extrude(&sk, distance, direction);
        match &out {
            // Any sketch-stage rejection is the sketch's decision. (Off the sketch origin,
            // R-4 may reject a triangle at or just below tol² as SKETCH_CURVES_CROSS while
            // the oracle says SKETCH_DEGENERATE_LOOP: a sketch-stage code difference,
            // reported separately; it never produces a body.)
            Outcome::Sketch(code) => prop_assert!(code.starts_with("SKETCH_"), "{}", code),
            Outcome::Body(e) => prop_assert!(false, "sketch accepted, body failed: {}", e),
            Outcome::Ok(bodies, _) => {
                for b in bodies {
                    prop_assert!(body_metrics(b).expect("metrics").valid);
                }
            }
        }
        if offset == [0.0, 0.0] {
            let want_ok = h > 1.0;
            prop_assert_eq!(matches!(out, Outcome::Ok(..)), want_ok, "h {}: {:?}", h, out);
            if !want_ok {
                prop_assert!(matches!(out, Outcome::Sketch("SKETCH_DEGENERATE_LOOP")), "{:?}", out);
            }
        }
    }

    /// Exact frames (the face holds exactly the intended triangle): a loop no sketch
    /// decided is degenerate whenever its area is at most tol², from µm to 10 mm sides
    /// and 50 mm from the origin; a sketch-decided one whenever it is at most tol²/2.
    #[test]
    fn strict_rule_rejects_every_loop_at_or_below_tol_squared(
        frame in arb_exact_frame(),
        maker in arb_maker(),
        h in prop_oneof![0.0..1.0f64, Just(1.0 - 1e-9), Just(0.5)],
        base in log_uniform(1e-6, 10.0),
        apex in -1.0..2.0f64,
        offset in prop::array::uniform2(-50.0..50.0f64),
    ) {
        // Sketch-decided loops are only degenerate at or below tol²/2 (scaled, not
        // rejected: no global-reject limit at high PROPTEST_CASES).
        let h = if maker.sketch_decided() { 0.5 * h } else { h };
        let Some(corners) = thin_triangle(&frame, h, base, apex, offset) else {
            return Ok(());
        };
        let codes = loop_codes(&polygon_face(frame, &corners, maker));
        prop_assert_eq!(codes, vec![IssueCode::LoopDegenerate], "h {}, base {}, {:?}", h, base, maker);
    }

    /// Any plane (up to ~550 mm from the origin), sides up to 0.01 mm (so building the
    /// test face moves its area by < 0.01·tol²): clearly-below loops are degenerate for
    /// every maker; the sketch-decided allowance never reaches below tol²/2.
    #[test]
    fn body_check_rejects_triangles_clearly_below_tol_squared(
        plane in arb_plane(),
        maker in arb_maker(),
        h in 0.0..0.9f64,
        base in log_uniform(1e-6, 1e-2),
        apex in -1.0..2.0f64,
        offset in prop::array::uniform2(-50.0..50.0f64),
    ) {
        let Some(plane) = plane else { return Ok(()) };
        // Sketch-decided loops are only degenerate at or below tol²/2 (scaled, not
        // rejected: no global-reject limit at high PROPTEST_CASES).
        let h = if maker.sketch_decided() { 0.5 * h } else { h };
        let frame = sketch_frame(&plane).expect("frame");
        let Some(corners) = thin_triangle(&frame, h, base, apex, offset) else {
            return Ok(());
        };
        let codes = loop_codes(&polygon_face(frame, &corners, maker));
        prop_assert_eq!(codes, vec![IssueCode::LoopDegenerate], "h {}, base {}, {:?}", h, base, maker);
    }

    /// Loops of lines and arcs in any plane, 0.5–1.5·tol²: the reported area is the true
    /// one (dense reference polygon) and the decision follows it.
    #[test]
    fn arc_loops_are_measured_exactly_in_any_plane(
        plane in arb_plane(),
        shape in 0usize..4,
        frac in 0.5..1.5f64,
        maker in arb_maker(),
        reversed in any::<bool>(),
    ) {
        let Some(plane) = plane else { return Ok(()) };
        let frame = sketch_frame(&plane).expect("frame");
        let (start, pieces) = arc_loops(1.0).swap_remove(shape);
        let s = math::sqrt(frac * TOL * TOL / reference_area(start, &pieces));
        let (start, pieces) = arc_loops(s).swap_remove(shape);
        let want = reference_area(start, &pieces);
        let issues = issues_of(&loop_face(frame, start, &pieces, maker, reversed));
        // Round-off of these µm loops 900 mm out is < 1e-4·tol²: decide clear cases only.
        if frac < 0.999 {
            prop_assert_eq!(issues.len(), 1, "{:?}", issues);
            prop_assert_eq!(issues[0].code, IssueCode::LoopDegenerate);
            let got = issues[0].measured.expect("measured");
            prop_assert!((got - want).abs() <= 1e-6 * want, "measured {:e}, want {:e}", got, want);
        } else if frac > 1.001 {
            prop_assert!(issues.is_empty(), "{:?}", issues);
        }
    }

    /// The round trip of forge-ops' extrude and revolve caps (single-loop line regions,
    /// µm to 10 mm, anywhere within 50 mm of the origin of any plane within 500 mm)
    /// costs a few ulps of the body's coordinate scale per plane coordinate — far inside
    /// the allowance for sketch-decided loops.
    #[test]
    fn sketch_region_round_trip_is_within_the_allowance(
        plane in arb_plane(),
        size in log_uniform(1e-5, 10.0),
        aspect in 0.2..5.0f64,
        quad in any::<bool>(),
        offset in prop::array::uniform2(-50.0..50.0f64),
        distance in 1.0..20.0f64,
        direction in arb_direction(),
    ) {
        let Some(plane) = plane else { return Ok(()) };
        let (w, hgt) = (size, size * aspect);
        let o = offset;
        let pts: Vec<[f64; 2]> = if quad {
            vec![[o[0], o[1]], [o[0] + w, o[1]], [o[0] + w, o[1] + hgt], [o[0], o[1] + hgt]]
        } else {
            vec![[o[0], o[1]], [o[0] + w, o[1]], [o[0] + 0.3 * w, o[1] + hgt]]
        };
        let n = pts.len();
        let curves: Vec<_> = (0..n).map(|i| line(&format!("l{i}"), pts[i], pts[(i + 1) % n])).collect();
        let sk = sketch(plane, curves);
        let frame = sketch_frame(&sk.plane).expect("frame");
        let regs = regions(&sk, &Tolerance::IR_DEFAULT).expect("regions");
        prop_assert_eq!(regs.len(), 1);
        let area = regs[0].outer.signed_area;
        let ext = extrude(&regs[0], &frame, distance, direction, "extrude_1").expect("extrude");
        let axis = SketchAxis { origin: [-70.0, 0.0], direction: [0.0, 1.0] };
        check_revolve_profile(&regs[0], &axis, TOL).expect("profile");
        let rev = revolve(&regs[0], &frame, &axis, 0.5 * PI, direction, "revolve_1").expect("revolve");
        for body in [&ext, &rev] {
            let ulps = cap_round_trip_ulps(body, area);
            prop_assert_eq!(ulps.len(), 2);
            for u in ulps {
                // A quarter of the allowance: margin for what random planes miss.
                prop_assert!(u <= 0.25 * SKETCH_LOOP_ROUNDOFF_ULPS, "{} ulps", u);
            }
        }
    }
}
