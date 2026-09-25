//! Batch writer for the OCCT hole and pattern differential
//! (`forge-ops/oracle/occt_hole_pattern_diff.py`).
//!
//! ```text
//! HOLE_PATTERN_BATCH_OUT=/tmp/hp7.jsonl HOLE_PATTERN_SEED=7 HOLE_PATTERN_COUNT=320 \
//!   cargo test --release -p forge-ops --test hole_pattern_oracle -- --ignored --nocapture
//! ```
//!
//! Generations (a seed gives the same cases in a generation, whatever the engine does):
//! - 1 (`HOLE_PATTERN_LEGACY=1`): the first W5 generator;
//! - 2 (`HOLE_PATTERN_GEN=2`): + the tilted families and extra pattern-scope targets (the
//!   batches of the first two reviews);
//! - 3 (`HOLE_PATTERN_GEN=3`; the third review's batches): + every size, fit and preset in random holes (M2 … M8, `tap`, `thread`,
//!   presets a size has no table value for), **crossing** pattern families (a hole copied by
//!   a mirror or rotation about a point of its own axis: equal-radius walls whose axes meet),
//!   **curved** placement faces (a plate cut by a tilted cylinder — ellipses —, by a cone whose
//!   axis is parallel to it — hyperbolas, B-splines —, or notched by a vertical cylinder —
//!   arcs; and a cylinder cut by a slanted plane — an ellipse face — for probes only) with
//!   point–face probes (`planar_face_distance`, `up_to_depth`) compared to `BRepExtrema`, and,
//!   after the random cases, the deterministic **golden** family: every non-error case of
//!   `corpus/v1/conformance/holes/tools.json` drilled into a 40 × 40 × 20 plate (the oracle
//!   also checks the removed volume against its closed form);
//! - 4 (default): + pattern seeds with **several tools** (multi-position hole seeds — a grid
//!   whose pitch or centre makes copies coincide under the layout, half the time — and
//!   two-region cut and join seeds, one tool per region: [W0-39]'s per-tool join rule),
//!   **zero-instance** layouts (linear `count` 1, or `skip` naming the only instance), and,
//!   after the golden family, the deterministic **fixed** family (`fixed`: a name): the
//!   review cases — `up_to` the far face (the open break-through question), zero instances,
//!   a join instance with one detached boss, coincident blind copies — and the W4 regression
//!   `909#59` (a copied hole wall tangent to the bottom face). Since the fourth review the
//!   fixed family also replays the fourth review's cases by hand: section types of crossing
//!   and tilted copies (`edge_types_*`), and W4 regressions (`w4_*`: an SSI failure, an
//!   inconsistent face split with extra targets, a dense bolt circle Forge calls
//!   non-manifold). Since the fifth review: the tol band of a drill point's apex and of a flat
//!   floor at the far face (`tip_band_*`, `floor_band_*`: ±1.5e-6, ±0.5e-6 and 0 mm), seed
//!   97 #71's tangent join bosses, seed 131 #169 (`occt_wrong_131_169`: OCCT's cut is wrong,
//!   Forge's the closed form), an all-missing hole pattern (`all_failed_m3`), and body
//!   seeds joined to the plate (`body_join`: a notched rod whose cylinder face is not a
//!   (u, v) rectangle, `notched_rod_join`, and the same rod lying along the plate,
//!   `rod_contact_join`). Since the sixth review: seed 313 #37 (a detached join copy reported
//!   before the join's own non-manifold failure, `join_detached_first_313_37`), results
//!   pinched at a vertex (#73, #31: `pinch_vertex_313_*`), a two-fan OCCT vertex that is no
//!   pinch (#249, `pinch_refuted_313_249`), and two crossings where OCCT's cut is wrong and the
//!   script's exact adjudication says so (`occt_wrong_419_275`, `occt_wrong_521_267`).
//!
//! A pattern whose seed fails records the seed's error (`forge.seed`: `code`, `message`,
//! `details`; `stage: extra` for the extra block's join; `SPLIT` for a seed that splits the
//! plate), and every Forge body carries `unmerged`: its edges between two faces on one carrier
//! (SPEC §6.0.4 merges such faces; the script's `UNMERGED_SAME_DOMAIN` class).
//!
//! One JSON line per random case: the plate as an `aicad.ir/0` document (the oracle rebuilds
//! it with its own v0 evaluator), the hole (resolved numbers and the placement form: the
//! oracle computes positions, tools, misses and break-throughs itself) or the pattern (the
//! seed as a v0 operand document or a hole, the layout, `skip`, and optionally an `extra`
//! pattern-scope target: a thicker block joined under part of the plate, or a separate one
//! below it), and Forge's outcome (status, code, details, skipped instances, report entries,
//! per body the exact metrics).
//!
//! Layout families: in-plane linear, circular about +Z and vertical mirrors (the drilling
//! axis stays vertical), large grids and circles, and **tilted** families — circular about
//! horizontal and oblique axes, mirrors whose normal has a Z component, linear directions
//! with a component along the drilling axis — which move tool axes off the vertical (for
//! through holes: copies that end inside the targets, `FORGE_PATTERN_THROUGH_COPY_TOO_SHORT`).

use std::io::Write;
use std::time::Instant;

use forge_core::geom::Surface;
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::topo::{Body, Role, Severity};
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame as IrFrame, PlaneSpec, SketchAxis, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Rng, Sweep};
use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};
use forge_ops::hole::{
    HoleSite, apply_hole, hole_positions, hole_spec, literal_hole, planar_face_distance,
    up_to_depth,
};
use forge_ops::pattern::{
    CircularLayout, Layout, LinearLayout, MirrorLayout, SeedBody, SeedOp, apply_seed,
    pattern_instances,
};
use serde_json::{Value, json};

fn rect(x0: f64, y0: f64, w: f64, h: f64) -> Vec<SketchCurve> {
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    vec![
        l("b", [x0, y0], [x0 + w, y0]),
        l("r", [x0 + w, y0], [x0 + w, y0 + h]),
        l("t", [x0 + w, y0 + h], [x0, y0 + h]),
        l("l", [x0, y0 + h], [x0, y0]),
    ]
}

fn operand(feature: &str, z0: f64, curves: Vec<SketchCurve>, h: f64) -> Operand {
    framed(
        feature,
        IrFrame {
            origin: [0.0, 0.0, z0],
            normal: [0.0, 0.0, 1.0],
            x_dir: [1.0, 0.0, 0.0],
        },
        curves,
        Sweep::Extrude {
            distance: h,
            direction: SweepDirection::Normal,
        },
    )
}

fn framed(feature: &str, plane: IrFrame, curves: Vec<SketchCurve>, sweep: Sweep) -> Operand {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(plane),
            curves,
        },
        sweep,
    }
}

/// The pattern-scope target of a pattern case, or how the seed (or the extra target's join)
/// failed on Forge: `{ code, message, details?, stage? }` (the batch's `forge.seed`; `stage`:
/// `extra` for the join of the extra block).
type Seeded = Result<Body, Value>;

/// A boolean seed operation's outcome as a [`Seeded`]: one body, or its error, or `SPLIT` with
/// the number of pieces.
fn seeded(r: Result<forge_ops::boolean::BodyOpResult, forge_ops::boolean::BooleanError>) -> Seeded {
    match r {
        Ok(mut r) if r.bodies.len() == 1 => Ok(r.bodies.remove(0).body),
        Ok(r) => Err(json!({ "code": "SPLIT", "message": format!("{} bodies", r.bodies.len()) })),
        Err(e) => Err(json!({ "code": e.code(), "message": e.to_string(),
                              "details": serde_json::to_value(e.details()).expect("d") })),
    }
}

fn ob(body: Body, feature: &str, member: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: member.into(),
            instance: None,
        },
        timeline,
    }
}

/// Do two surfaces lie on one carrier (SPEC §6.0.4, for the triage count [`unmerged`]):
/// planes with the same outward normal, coaxial cylinders of one radius, cones with one apex,
/// axis direction and half angle, spheres with one centre and radius (within tol and 1e-9 rad)?
/// `sense_a`, `sense_b`: the faces' senses (outward normal = surface normal iff `true`).
fn same_carrier(a: &Surface, sense_a: bool, b: &Surface, sense_b: bool) -> bool {
    const T: f64 = 1e-6;
    const A: f64 = 1e-9;
    let coaxial = |fa: &Frame, fb: &Frame| {
        let off = fb.origin() - fa.origin();
        fa.z().cross(fb.z()).norm() <= A && (off - fa.z() * off.dot(fa.z())).norm() <= T
    };
    match (a, b) {
        (Surface::Plane(p), Surface::Plane(q)) => {
            let n = if sense_a {
                p.frame().z()
            } else {
                -p.frame().z()
            };
            let m = if sense_b {
                q.frame().z()
            } else {
                -q.frame().z()
            };
            n.dot(m) > 0.0
                && n.cross(m).norm() <= A
                && (q.frame().origin() - p.frame().origin()).dot(n).abs() <= T
        }
        (Surface::Cylinder(p), Surface::Cylinder(q)) => {
            sense_a == sense_b
                && coaxial(p.frame(), q.frame())
                && (p.radius() - q.radius()).abs() <= T
        }
        (Surface::Cone(p), Surface::Cone(q)) => {
            sense_a == sense_b
                && p.frame().z().dot(q.frame().z()) > 0.0
                && p.frame().z().cross(q.frame().z()).norm() <= A
                && p.apex().distance(q.apex()) <= T
                && (p.half_angle() - q.half_angle()).abs() <= A
        }
        (Surface::Sphere(p), Surface::Sphere(q)) => {
            sense_a == sense_b
                && p.frame().origin().distance(q.frame().origin()) <= T
                && (p.radius() - q.radius()).abs() <= T
        }
        _ => false,
    }
}

/// The edges of `body` between two distinct faces on one carrier ([`same_carrier`]): faces
/// SPEC §6.0.4 merges. A count mismatch with such edges is a W4 unify defect, which the oracle
/// script classifies `UNMERGED_SAME_DOMAIN` (review 5, fixed case `triage_topology_41_79`).
fn unmerged(body: &Body) -> usize {
    body.edges()
        .iter()
        .filter(|(eid, _)| {
            let fs = body.edge_faces(*eid);
            fs.len() == 2
                && fs[0] != fs[1]
                && match (body.face(fs[0]), body.face(fs[1])) {
                    (Some(a), Some(b)) => same_carrier(&a.surface, a.sense, &b.surface, b.sense),
                    _ => false,
                }
        })
        .count()
}

fn metrics(body: &Body) -> Value {
    let valid = forge_check::validate(body)
        .iter()
        .all(|i| i.severity != Severity::Error);
    match forge_check::body_metrics(body) {
        Ok(m) => json!({
            "volume": m.volume, "area": m.area, "centroid": m.centroid,
            "faces": m.faces, "edges": m.edges, "shells": body.shell_ids().len(),
            "face_types": m.face_types, "edge_types": m.edge_types, "valid": valid,
            "unmerged": unmerged(body),
        }),
        Err(e) => json!({ "metrics_error": e.to_string(), "valid": false }),
    }
}

/// A hole description: the fields of a v1 hole feature (literals) plus the facts the oracle
/// needs (resolved numbers).
struct HoleCase {
    fields: Value,
    top: bool,
    flip: bool,
    /// `depth: { up_to }`: `"far"` (the plate's opposite cap) or `"side"` (the side face at
    /// x = 0, parallel to the axis).
    up_to: Option<&'static str>,
}

fn random_hole(rng: &mut Rng, w: f64, d: f64, t: f64, positions: bool) -> HoleCase {
    // Generation 3: every size (M2 and M8, and presets a size has no table value for:
    // `HOLE_OPTIONS_CONFLICT` in both engines), the `tap` fit and cosmetic threads.
    let g3 = generation() >= 3;
    let sizes: &[&str] = if g3 {
        &["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"]
    } else {
        &["M2.5", "M3", "M4", "M5", "M6"]
    };
    let size = sizes[rng.below(sizes.len())];
    let fits: &[&str] = if g3 {
        &["close", "normal", "loose", "tap"]
    } else {
        &["close", "normal", "loose"]
    };
    let fit = fits[rng.below(fits.len())];
    let tip = [90.0, 118.0, 120.0, 135.0][rng.below(4)];
    let csizes: &[&str] = if g3 {
        &["M2.5", "M3", "M4", "M5", "M6", "M8"]
    } else {
        &["M3", "M4", "M5", "M6"]
    };
    let csize = csizes[rng.below(csizes.len())];
    let angle = [82.0, 90.0, 100.0, 120.0][rng.below(4)];
    let isizes: &[&str] = if g3 {
        &["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"]
    } else {
        &["M2", "M3", "M4"]
    };
    let isize = isizes[rng.below(isizes.len())];
    let mut f = match rng.below(if g3 { 11 } else { 9 }) {
        0 => json!({ "size": size, "fit": fit, "depth": "through" }),
        1 => json!({ "d": rng.grid(2.0, 6.0, 0.25), "depth": "through" }),
        2 => {
            json!({ "d": rng.grid(2.0, 6.0, 0.25), "depth": { "blind": rng.grid(1.0, t + 3.0, 0.5) },
                     "tip": tip })
        }
        3 => {
            json!({ "d": rng.grid(2.0, 6.0, 0.25), "depth": { "blind": rng.grid(1.0, t + 3.0, 0.5) }, "tip": "flat" })
        }
        4 => json!({ "size": size, "depth": "through", "cbore": "iso4762" }),
        5 => json!({ "d": 3.0, "depth": { "blind": rng.grid(t * 0.6, t + 2.0, 0.5) },
                     "cbore": { "d": rng.grid(5.0, 8.0, 0.5), "depth": rng.grid(0.5, t * 0.5, 0.5) } }),
        6 => json!({ "size": csize, "depth": "through", "csink": "iso10642" }),
        7 => {
            json!({ "d": 3.0, "depth": "through", "csink": { "d": rng.grid(5.0, 8.0, 0.5), "angle": angle } })
        }
        8 => json!({ "size": isize, "insert": "std" }),
        9 => {
            // A cosmetic thread (tap drill), blind or through.
            let depth = if rng.below(2) == 0 {
                json!("through")
            } else {
                json!({ "blind": rng.grid(2.0, t + 3.0, 0.5) })
            };
            json!({ "size": size, "depth": depth, "thread": true })
        }
        _ => {
            json!({ "size": size, "fit": fit, "depth": { "blind": rng.grid(1.0, t + 3.0, 0.5) }, "tip": tip })
        }
    };
    // Room for the widest part of the tool (≤ 11.47 / 2, or 18.25 / 2 with M8, + margin).
    let m = if g3 { 10.0 } else { 7.0 };
    let at = |rng: &mut Rng| [rng.grid(m, w - m, 0.5), rng.grid(m, d - m, 0.5)];
    let placement = match rng.below(4) {
        0 | 1 => {
            let n = 1 + rng.below(3);
            let mut list: Vec<Value> = Vec::new();
            let mut pts: Vec<[f64; 2]> = Vec::new();
            // Bounded: the first points can leave no room for the next ones (seed 41 #252 spun
            // forever); a case that needs more tries keeps the points it has.
            let mut tries = 0;
            while list.len() < n && tries < 10_000 {
                tries += 1;
                let p = at(rng);
                // Distinct holes 14 mm apart at least (no tangent or merged walls).
                if pts.iter().all(|q| (q[0] - p[0]).hypot(q[1] - p[1]) >= 14.0) {
                    list.push(json!({ "id": format!("p{}", list.len()), "at": p }));
                    pts.push(p);
                }
                if pts.len() > 8 {
                    break;
                }
            }
            json!({ "list": list })
        }
        2 => {
            let nx = 1 + rng.below(3);
            let ny = 1 + rng.below(2);
            let dx = if nx > 1 {
                ((w - 2.0 * m) / (nx as f64 - 1.0))
                    .min(20.0)
                    .floor()
                    .max(14.0)
            } else {
                0.0
            };
            let dy = if ny > 1 {
                ((d - 2.0 * m) / (ny as f64 - 1.0))
                    .min(20.0)
                    .floor()
                    .max(14.0)
            } else {
                0.0
            };
            json!({ "grid": { "nx": nx, "ny": ny, "dx": dx, "dy": dy,
                              "center": [(w / 2.0).floor(), (d / 2.0).floor()] } })
        }
        _ => {
            let r = (d.min(w) / 2.0 - m).max(7.0).floor();
            json!({ "circle": { "n": 3 + rng.below(4), "d": 2.0 * r,
                                "center": [(w / 2.0).floor(), (d / 2.0).floor()],
                                "start": 15.0 * rng.below(24) as f64 } })
        }
    };
    f["at"] = placement;
    // A few deliberate failures: a position off the face, a hole drilled away from the part.
    let r = rng.below(20);
    let mut up_to = None;
    if positions && r == 0 {
        f["at"] = json!({ "list": [{ "id": "in", "at": at(rng) }, { "id": "off", "at": [w + 2.5, d / 2.0] }] });
    }
    if positions && r == 2 {
        // Two positions within tol of each other.
        let p = at(rng);
        f["at"] =
            json!({ "list": [{ "id": "a", "at": p }, { "id": "b", "at": [p[0] + 5e-7, p[1]] }] });
    }
    if positions && (r == 3 || r == 4 || r == 5) && f.get("insert").is_none() {
        // Up to the plate's far face (a flat-bottomed hole of the plate's thickness), or up
        // to a side face the axis never reaches (`HOLE_UP_TO_MISSED`).
        let which = if r == 5 { "side" } else { "far" };
        f["depth"] = json!({ "up_to": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "start" } } });
        if let Some(o) = f.as_object_mut() {
            o.remove("tip");
            o.remove("thread");
        }
        if let Some(c) = f.get("cbore").cloned()
            && c.is_object()
        {
            // A custom counterbore must stay shallower than the plate.
            f["cbore"]["depth"] = json!(c["depth"].as_f64().expect("depth").min(t * 0.5));
        }
        up_to = Some(which);
    }
    HoleCase {
        fields: f,
        top: rng.below(4) != 0,
        flip: positions && r == 1,
        up_to,
    }
}

/// The frame of the plate's top (outward +Z: x = X, y = Y) or bottom (outward −Z: x = X,
/// y = −Y, SPEC §3.1), with the placement's (u, v) mapped so that the hole stays inside:
/// on the bottom, `(u, v)` is `(x, −y)`.
fn face_frame(top: bool, t: f64) -> Frame {
    if top {
        Frame::world().with_origin(Vec3::new(0.0, 0.0, t))
    } else {
        Frame::from_normal_x(Vec3::zero(), -Vec3::unit_z(), Vec3::unit_x()).expect("frame")
    }
}

fn hole_feature(fields: &Value) -> forge_ir::v1::HoleFeature {
    let mut v = json!({ "id": "h1", "name": "holes", "on": "XY" });
    for (k, x) in fields.as_object().expect("object") {
        v[k] = x.clone();
    }
    serde_json::from_value(v).expect("hole")
}

fn face_of(b: &Body, role: Role) -> forge_core::topo::FaceId {
    b.faces()
        .iter()
        .find(|(_, f)| f.provenance.role == role && f.provenance.feature == "e1")
        .map(|(id, _)| id)
        .expect("cap")
}

/// Run a hole on the plate; `(outcome JSON, the tools for a pattern seed, the cut plate)`.
fn run_hole(plate: &Body, hc: &HoleCase, t: f64) -> (Value, Option<(Vec<SeedBody>, Body)>) {
    let mut fields = hc.fields.clone();
    if !hc.top {
        // Bottom face: v = −y keeps the positions over the plate.
        flip_v(&mut fields["at"]);
    }
    let lit = literal_hole(&hole_feature(&fields), |s, _, _| s.literal().ok_or(())).expect("lit");
    let err = |e: &forge_ops::hole::HoleError| {
        json!({ "status": "error", "code": e.code(), "details": serde_json::to_value(e.details()).expect("d"),
                "message": e.to_string() })
    };
    let spec = match hole_spec(&lit) {
        Ok(s) => s,
        Err(e) => return (err(&e), None),
    };
    let frame = face_frame(hc.top, t);
    let pos = match hole_positions(&lit.at, &frame, &[]) {
        Ok(p) => p,
        Err(e) => return (err(&e), None),
    };
    let face = face_of(plate, if hc.top { Role::CapEnd } else { Role::CapStart });
    let up_to = hc.up_to.map(|w| match w {
        "far" => face_of(plate, if hc.top { Role::CapStart } else { Role::CapEnd }),
        _ => plate
            .faces()
            .iter()
            .find(|(_, f)| {
                f.provenance.role == Role::Side
                    && f.provenance.sources.first().map(String::as_str) == Some("l")
            })
            .map(|(id, _)| id)
            .expect("side l"),
    });
    let site = HoleSite {
        frame: &frame,
        flip: hc.flip,
        on_face: Some((plate, face)),
        up_to: up_to.map(|f| (plate, f)),
        timeline: 1,
        scope_scale: None,
    };
    match apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1", "b", 0)]) {
        Ok(o) => {
            let bodies: Vec<Value> = o.op.bodies.iter().map(|b| metrics(&b.body)).collect();
            let notes: Vec<Value> = o
                .notes
                .iter()
                .map(
                    |n| json!({ "code": n.code(), "details": serde_json::to_value(n).expect("n") }),
                )
                .collect();
            let tools = o.seed_bodies();
            let cut = o.op.bodies.first().map(|b| b.body.clone());
            (
                json!({ "status": "ok", "bodies": bodies, "holes": serde_json::to_value(&o.holes).expect("h"),
                        "notes": notes, "resolved": { "d": spec.d, "cbore": spec.cbore, "csink": spec.csink,
                        "insert": spec.insert,
                        "depth": match spec.depth { forge_ops::hole::Depth::Blind(h) => json!({ "blind": h }), _ => json!("through") },
                        "tip": match spec.tip { forge_ops::hole::Tip::Angle(a) => json!(a), forge_ops::hole::Tip::Flat => json!("flat") } } }),
                cut.map(|c| (tools, c)),
            )
        }
        Err(e) => (err(&e), None),
    }
}

/// `(u, v) → (u, −v)` in a placement (for the bottom face's frame).
fn flip_v(at: &mut Value) {
    if let Some(list) = at.get_mut("list").and_then(Value::as_array_mut) {
        for p in list {
            let v = p["at"][1].as_f64().expect("v");
            p["at"][1] = json!(-v);
        }
    }
    for k in ["grid", "circle"] {
        if let Some(g) = at.get_mut(k) {
            let v = g["center"][1].as_f64().expect("v");
            g["center"][1] = json!(-v);
        }
    }
}

/// A tilted layout (see the module docs): the drilling axis leaves the vertical.
fn tilted_layout(rng: &mut Rng, c: Vec3, t: f64) -> (Value, Layout) {
    let mid = Vec3::new(c.x, c.y, (t / 2.0).floor());
    match rng.below(3) {
        0 => {
            let axes = [
                Vec3::unit_x(),
                Vec3::unit_y(),
                Vec3::new(1.0, 0.0, 1.0),
                Vec3::new(0.0, 1.0, 2.0),
                Vec3::new(1.0, 1.0, 1.0),
            ];
            let axis = axes[rng.below(axes.len())];
            let count = 2 + rng.below(3);
            let angle = [360.0, 180.0, 90.0][rng.below(3)];
            let origin = if rng.below(2) == 0 { mid } else { c };
            (
                json!({ "circular": { "origin": origin.to_array(), "axis": axis.to_array(), "count": count, "angle": angle } }),
                Layout::Circular(CircularLayout {
                    origin,
                    axis,
                    count: count as f64,
                    angle,
                }),
            )
        }
        1 => {
            let normals = [
                Vec3::unit_z(),
                Vec3::new(0.0, 1.0, 1.0),
                Vec3::new(1.0, 0.0, 2.0),
                Vec3::new(1.0, 1.0, 4.0),
            ];
            let normal = normals[rng.below(normals.len())];
            let origin = [mid, c, c + Vec3::new(0.0, 0.0, -rng.grid(2.0, 12.0, 0.5))][rng.below(3)];
            (
                json!({ "mirror": { "origin": origin.to_array(), "normal": normal.to_array() } }),
                Layout::Mirror(MirrorLayout { origin, normal }),
            )
        }
        _ => {
            let dirs = [
                Vec3::new(1.0, 0.0, 1.0),
                Vec3::new(0.0, 1.0, -1.0),
                Vec3::unit_z(),
            ];
            let dir = dirs[rng.below(dirs.len())];
            let count = 2 + rng.below(2);
            let spacing = rng.grid(8.0, 16.0, 0.5) * if rng.below(3) == 0 { -1.0 } else { 1.0 };
            (
                json!({ "linear": { "dir": dir.to_array(), "count": count, "spacing": spacing } }),
                Layout::Linear(LinearLayout {
                    dir,
                    count: count as f64,
                    spacing,
                    second: None,
                }),
            )
        }
    }
}

/// The generator's generation (see the module docs).
fn generation() -> u32 {
    if std::env::var_os("HOLE_PATTERN_LEGACY").is_some() {
        return 1;
    }
    std::env::var("HOLE_PATTERN_GEN")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4)
}

fn legacy() -> bool {
    generation() == 1
}

fn random_layout(rng: &mut Rng, w: f64, d: f64, t: f64) -> (Value, Layout) {
    let c = Vec3::new((w / 2.0).floor(), (d / 2.0).floor(), 0.0);
    // One in three: a tilted family.
    if !legacy() && rng.below(3) == 0 {
        return tilted_layout(rng, c, t);
    }
    // One in six: a large layout (linear up to 12 × 12, circular up to 36), most instances
    // overlapping each other or running off the part.
    if rng.below(6) == 0 {
        if rng.below(2) == 0 {
            let (count, count2) = ((6 + rng.below(7)) as f64, (6 + rng.below(7)) as f64);
            let (s1, s2) = (rng.grid(6.0, 9.0, 0.5), rng.grid(6.0, 9.0, 0.5));
            return (
                json!({ "linear": { "dir": [1.0, 0.0, 0.0], "count": count, "spacing": s1,
                                    "dir2": [0.0, 1.0, 0.0], "count2": count2, "spacing2": s2 } }),
                Layout::Linear(LinearLayout {
                    dir: Vec3::unit_x(),
                    count,
                    spacing: s1,
                    second: Some((Vec3::unit_y(), count2, s2)),
                }),
            );
        }
        let count = (12 + rng.below(25)) as f64;
        return (
            json!({ "circular": { "origin": c.to_array(), "axis": [0.0, 0.0, 1.0], "count": count, "angle": 360.0 } }),
            Layout::Circular(CircularLayout {
                origin: c,
                axis: Vec3::unit_z(),
                count,
                angle: 360.0,
            }),
        );
    }
    match rng.below(5) {
        0 | 1 => {
            let dirs = [
                Vec3::unit_x(),
                Vec3::unit_y(),
                -Vec3::unit_x(),
                Vec3::new(3.0, 4.0, 0.0),
            ];
            let dir = dirs[rng.below(dirs.len())];
            let count = 2 + rng.below(5);
            let spacing = rng.grid(8.0, 24.0, 0.5) * if rng.below(4) == 0 { -1.0 } else { 1.0 };
            let second = (rng.below(3) == 0).then(|| {
                let d2 = if dir.x.abs() > 0.5 {
                    Vec3::unit_y()
                } else {
                    Vec3::unit_x()
                };
                (d2, (1 + rng.below(3)) as f64, rng.grid(8.0, 16.0, 0.5))
            });
            let mut j =
                json!({ "linear": { "dir": dir.to_array(), "count": count, "spacing": spacing } });
            if let Some((d2, c2, s2)) = second {
                j["linear"]["dir2"] = json!(d2.to_array());
                j["linear"]["count2"] = json!(c2);
                j["linear"]["spacing2"] = json!(s2);
            }
            (
                j,
                Layout::Linear(LinearLayout {
                    dir,
                    count: count as f64,
                    spacing,
                    second,
                }),
            )
        }
        2 | 3 => {
            let count = 2 + rng.below(7);
            let angle = if rng.below(2) == 0 {
                360.0
            } else {
                30.0 * (1 + rng.below(10)) as f64
            };
            let origin = c + Vec3::new(rng.grid(-4.0, 4.0, 0.5), rng.grid(-4.0, 4.0, 0.5), 0.0);
            (
                json!({ "circular": { "origin": origin.to_array(), "axis": [0.0, 0.0, 1.0], "count": count, "angle": angle } }),
                Layout::Circular(CircularLayout {
                    origin,
                    axis: Vec3::unit_z(),
                    count: count as f64,
                    angle,
                }),
            )
        }
        _ => {
            let normals = [Vec3::unit_x(), Vec3::unit_y(), Vec3::new(1.0, 1.0, 0.0)];
            let normal = normals[rng.below(normals.len())];
            (
                json!({ "mirror": { "origin": c.to_array(), "normal": normal.to_array() } }),
                Layout::Mirror(MirrorLayout { origin: c, normal }),
            )
        }
    }
}

/// Forge's outcome of one seed of a pattern (the batch's `forge` object).
fn run_pattern(
    layout: &Layout,
    skip: &[Vec<u32>],
    op: SeedOp,
    seeds: &[SeedBody],
    targets: Result<Vec<OpBody>, Value>,
) -> Value {
    match (targets, pattern_instances(layout, skip)) {
        (Err(seed), _) => json!({ "status": "seed_failed", "seed": seed }),
        (_, Err(e)) => json!({ "status": "error", "code": e.code(), "message": e.to_string() }),
        (Ok(all_targets), Ok(inst)) => {
            let targets = if op == SeedOp::NewBody {
                Vec::new()
            } else {
                all_targets
            };
            match apply_seed("pt1", 2, op, seeds, &inst, &targets, None) {
                Ok(o) => {
                    let mut bodies: Vec<Value> = Vec::new();
                    match &o.op {
                        Some(res) => {
                            bodies.extend(res.bodies.iter().map(|b| metrics(&b.body)));
                            bodies.extend(
                                res.untouched_targets
                                    .iter()
                                    .map(|&i| metrics(&targets[i].body)),
                            );
                        }
                        // No instance left after `skip`: the part is unchanged.
                        None if op != SeedOp::NewBody => {
                            bodies.extend(targets.iter().map(|t| metrics(&t.body)));
                        }
                        None => {}
                    }
                    let created: Vec<Value> = o
                        .created
                        .iter()
                        .map(|b| {
                            let mut m = metrics(&b.body);
                            m["instance"] = json!(b.origin.instance);
                            m
                        })
                        .collect();
                    json!({ "status": "ok", "instances": inst.iter().map(|i| i.index()).collect::<Vec<_>>(),
                            "skipped": o.skipped.iter().map(|s| json!({ "index": s.index, "code": s.code })).collect::<Vec<_>>(),
                            "notes": o.notes.iter().map(|n| json!({ "code": n.code(), "details": serde_json::to_value(n).expect("n") })).collect::<Vec<_>>(),
                            "bodies": bodies, "created": created })
                }
                Err(e) => {
                    json!({ "status": "error", "code": e.code(), "message": e.to_string(),
                            "details": serde_json::to_value(e.details()).expect("d") })
                }
            }
        }
    }
}

/// A random pattern case (the families of generations 1 and 2): `(case, forge)`.
fn random_pattern(rng: &mut Rng, plate: &Body, w: f64, d: f64, t: f64) -> (Value, Value) {
    let g4 = generation() >= 4;
    let (mut lj, mut layout) = random_layout(rng, w, d, t);
    let mut skip: Vec<Vec<u32>> = match (&layout, rng.below(4)) {
        (Layout::Mirror(_), _) | (_, 1..) => Vec::new(),
        (Layout::Linear(l), 0) if l.second.is_some() => vec![vec![1, 0]],
        (_, 0) => vec![vec![1]],
    };
    // Generation 4, one in twelve: no non-seed instance (linear `count` 1, or `skip` naming
    // the only instance).
    if g4 && rng.below(12) == 0 {
        let spacing = rng.grid(8.0, 20.0, 0.5);
        let count = if rng.below(2) == 0 {
            skip = Vec::new();
            1.0
        } else {
            skip = vec![vec![1]];
            2.0
        };
        lj = json!({ "linear": { "dir": [1.0, 0.0, 0.0], "count": count, "spacing": spacing } });
        layout = Layout::Linear(LinearLayout {
            dir: Vec3::unit_x(),
            count,
            spacing,
            second: None,
        });
    }
    let kind = ["cut", "join", "hole", "new_body"][rng.below(4)];
    // Generation 4, half the cut, join and hole seeds: several tools (two regions, or a
    // two- or three-position hole grid), spaced so that copies coincide half the time.
    let multi = g4 && kind != "new_body" && rng.below(2) == 0;
    let (pitch, centre) = if multi {
        coinciding(rng, &layout, w, d)
    } else {
        (0.0, [0.0, 0.0])
    };
    let (seed_json, seeds, op, target): (Value, Vec<SeedBody>, SeedOp, Seeded) = match kind {
        "cut" | "join" if multi => two_region_seed(rng, plate, kind, pitch, t, w, d),
        "hole" if multi => {
            let nx = 2 + rng.below(2);
            let depth = match rng.below(3) {
                0 => json!("through"),
                _ => json!({ "blind": rng.grid(1.0, t + 2.0, 0.5) }),
            };
            let mut fields = json!({ "d": rng.grid(2.0, 4.0, 0.25), "depth": depth,
                                     "at": { "grid": { "nx": nx, "ny": 1, "dx": pitch, "dy": 0.0,
                                                       "center": centre } } });
            if fields["depth"].is_object() && rng.below(2) == 0 {
                fields["tip"] = json!("flat");
            }
            hole_seed(
                plate,
                HoleCase {
                    fields,
                    top: true,
                    flip: false,
                    up_to: None,
                },
                t,
            )
        }
        "cut" | "join" | "new_body" => {
            let (x, y) = (rng.grid(4.0, w / 2.0, 0.5), rng.grid(4.0, d / 2.0, 0.5));
            let op = match kind {
                // A slot through the plate.
                "cut" => operand(
                    "e2",
                    -1.0,
                    rect(x, y, rng.grid(2.0, 6.0, 0.5), rng.grid(3.0, 10.0, 0.5)),
                    t + 2.0,
                ),
                // A cylindrical boss on the top.
                "join" => operand(
                    "e2",
                    t,
                    vec![SketchCurve::Circle {
                        id: "c".into(),
                        center: [x, y],
                        radius: rng.grid(1.5, 4.0, 0.5),
                    }],
                    rng.grid(2.0, 8.0, 0.5),
                ),
                // A separate block above the plate.
                _ => operand("e2", t + 5.0, rect(x, y, 4.0, 3.0), 2.5),
            };
            let body = op.build().expect("seed");
            let member = if kind == "join" { "c" } else { "b" };
            let seeds = vec![SeedBody {
                body: body.clone(),
                origin: Origin {
                    feature: "e2".into(),
                    member: member.into(),
                    instance: None,
                },
                keys: None,
                hole: None,
            }];
            let (sop, target) = match kind {
                "cut" | "join" => {
                    let bop = if kind == "cut" {
                        BodyOp::Cut
                    } else {
                        BodyOp::Join
                    };
                    let r = apply_body_op(
                        bop,
                        &[ob(plate.clone(), "e1", "b", 0)],
                        &[ob(body, "e2", member, 1)],
                        "e2",
                    );
                    (SeedOp::Body(bop), seeded(r))
                }
                _ => (SeedOp::NewBody, Ok(plate.clone())),
            };
            let doc = serde_json::to_value(op.document()).expect("doc");
            (
                json!({ "kind": kind, "doc": doc, "member": member }),
                seeds,
                sop,
                target,
            )
        }
        _ => {
            let mut hc = random_hole(rng, w, d, t, false);
            hc.top = true;
            hc.fields["at"] = json!({ "list": [{ "id": "a", "at": [rng.grid(8.0, w - 8.0, 0.5), rng.grid(8.0, d - 8.0, 0.5)] }] });
            hole_seed(plate, hc, t)
        }
    };
    // Pattern-scope targets that differ from the seed's (cut and hole seeds, one in three): a
    // thicker block joined under part of the plate (a step), or a separate block below it.
    let extra = (!legacy() && matches!(kind, "cut" | "hole") && rng.below(3) == 0).then(|| {
        let h2 = rng.grid(6.0, 20.0, 0.5);
        if rng.below(2) == 0 {
            let x0 = rng.grid(w * 0.3, w * 0.7, 0.5);
            (operand("e5", -h2, rect(x0, 0.0, w - x0, d), h2), true)
        } else {
            (operand("e5", -2.0 - h2, rect(0.0, 0.0, w, d), h2), false)
        }
    });
    let mut case = json!({ "layout": lj, "skip": skip, "seed": seed_json });
    if let Some((op, join)) = &extra {
        case["extra"] =
            json!({ "doc": serde_json::to_value(op.document()).expect("doc"), "join": join });
    }
    let targets: Result<Vec<OpBody>, Value> = target.and_then(|target| match &extra {
        None => Ok(vec![ob(target, "e1", "b", 0)]),
        Some((op, false)) => Ok(vec![
            ob(target, "e1", "b", 0),
            ob(op.build().expect("block"), "e5", "b", 1),
        ]),
        Some((op, true)) => seeded(apply_body_op(
            BodyOp::Join,
            &[ob(target, "e1", "b", 0)],
            &[ob(op.build().expect("block"), "e5", "b", 1)],
            "e5",
        ))
        .map(|b| vec![ob(b, "e1", "b", 0)])
        .map_err(|mut e| {
            e["stage"] = json!("extra");
            e
        }),
    });
    let forge = run_pattern(&layout, &skip, op, &seeds, targets);
    (case, forge)
}

/// Generation 4: the pitch and centre of a multi-tool seed. Half the time they make copies
/// coincide under `layout` (the linear spacing along ±X as the pitch; the centre on a
/// circular axis or a mirror plane, where the tools map onto each other), else random.
fn coinciding(rng: &mut Rng, layout: &Layout, w: f64, d: f64) -> (f64, [f64; 2]) {
    let random = |rng: &mut Rng| {
        (
            rng.grid(8.0, 16.0, 0.5),
            [
                rng.grid(w / 2.0 - 4.0, w / 2.0 + 4.0, 0.5),
                rng.grid(d / 2.0 - 4.0, d / 2.0 + 4.0, 0.5),
            ],
        )
    };
    if rng.below(2) == 0 {
        return random(rng);
    }
    match layout {
        Layout::Linear(l) if l.dir.y == 0.0 && l.dir.z == 0.0 && l.spacing.abs() <= 16.0 => {
            let (_, c) = random(rng);
            (l.spacing.abs(), c)
        }
        Layout::Circular(c) if c.axis.x == 0.0 && c.axis.y == 0.0 => {
            (rng.grid(8.0, 16.0, 0.5), [c.origin.x, c.origin.y])
        }
        Layout::Mirror(m) if m.normal.z == 0.0 => {
            (rng.grid(8.0, 16.0, 0.5), [m.origin.x, m.origin.y])
        }
        _ => random(rng),
    }
}

/// Generation 4: a cut (two through slots) or join (two bosses on the top) seed with one tool
/// per region, `pitch` apart along X: `(seed JSON, seed bodies, op, the seed's result)`.
fn two_region_seed(
    rng: &mut Rng,
    plate: &Body,
    kind: &str,
    pitch: f64,
    t: f64,
    w: f64,
    d: f64,
) -> (Value, Vec<SeedBody>, SeedOp, Seeded) {
    let (x, y) = (rng.grid(4.0, w / 2.0, 0.5), rng.grid(4.0, d / 2.0, 0.5));
    let ops: Vec<Operand> = if kind == "cut" {
        let (sw, sh) = (rng.grid(2.0, 6.0, 0.5), rng.grid(3.0, 10.0, 0.5));
        [x, x + pitch]
            .iter()
            .map(|&x| operand("e2", -1.0, rect(x, y, sw, sh), t + 2.0))
            .collect()
    } else {
        let (radius, h) = (rng.grid(1.5, 4.0, 0.5), rng.grid(2.0, 8.0, 0.5));
        [x, x + pitch]
            .iter()
            .map(|&x| {
                operand(
                    "e2",
                    t,
                    vec![SketchCurve::Circle {
                        id: "c".into(),
                        center: [x, y],
                        radius,
                    }],
                    h,
                )
            })
            .collect()
    };
    let prefix = if kind == "join" { "c" } else { "b" };
    let members: Vec<String> = (0..ops.len()).map(|k| format!("{prefix}{k}")).collect();
    let bodies: Vec<Body> = ops.iter().map(|o| o.build().expect("seed")).collect();
    let seeds: Vec<SeedBody> = bodies
        .iter()
        .zip(&members)
        .map(|(b, m)| SeedBody {
            body: b.clone(),
            origin: Origin {
                feature: "e2".into(),
                member: m.clone(),
                instance: None,
            },
            keys: None,
            hole: None,
        })
        .collect();
    let bop = if kind == "cut" {
        BodyOp::Cut
    } else {
        BodyOp::Join
    };
    let tools: Vec<OpBody> = bodies
        .iter()
        .zip(&members)
        .map(|(b, m)| ob(b.clone(), "e2", m, 1))
        .collect();
    let target = seeded(apply_body_op(
        bop,
        &[ob(plate.clone(), "e1", "b", 0)],
        &tools,
        "e2",
    ));
    let docs: Vec<Value> = ops
        .iter()
        .map(|o| serde_json::to_value(o.document()).expect("doc"))
        .collect();
    (
        json!({ "kind": kind, "docs": docs, "members": members }),
        seeds,
        SeedOp::Body(bop),
        target,
    )
}

/// A hole seed on the plate's top: `(seed JSON, seed bodies, op, the holed plate)`.
fn hole_seed(plate: &Body, hc: HoleCase, t: f64) -> (Value, Vec<SeedBody>, SeedOp, Seeded) {
    let (forge, seeds) = run_hole(plate, &hc, t);
    match seeds {
        Some((tools, cut)) => (
            json!({ "kind": "hole", "hole": hc.fields, "forge_seed": forge }),
            tools,
            SeedOp::Hole,
            Ok(cut),
        ),
        None => (
            json!({ "kind": "hole", "hole": hc.fields }),
            Vec::new(),
            SeedOp::Hole,
            Err(
                json!({ "code": forge["code"], "message": forge["message"], "details": forge["details"] }),
            ),
        ),
    }
}

/// A unit vector from spherical angles in degrees (polar `theta` from +Z, azimuth `phi`).
fn polar(theta: f64, phi: f64) -> Vec3 {
    let (st, ct) = (theta.to_radians().sin(), theta.to_radians().cos());
    let (sp, cp) = (phi.to_radians().sin(), phi.to_radians().cos());
    Vec3::new(st * cp, st * sp, ct)
}

/// A **crossing** pattern case (generation 3): a hole copied by a mirror in a tilted plane or
/// a rotation about a horizontal axis, both through a point of the hole's own axis inside the
/// plate — the copy's wall has the seed wall's radius and their axes meet (SPEC §8.3 rule 3:
/// ellipse sections; oracle case #279).
fn crossing_pattern(rng: &mut Rng, plate: &Body, w: f64, d: f64, t: f64) -> (Value, Value) {
    let mut hc = random_hole(rng, w, d, t, false);
    hc.top = true;
    let (x0, y0) = (rng.grid(12.0, w - 12.0, 0.5), rng.grid(12.0, d - 12.0, 0.5));
    hc.fields["at"] = json!({ "list": [{ "id": "a", "at": [x0, y0] }] });
    let pivot = Vec3::new(x0, y0, rng.grid(t * 0.25, t * 0.75, 0.25));
    let (lj, layout) = if rng.below(2) == 0 {
        let normal = polar(
            [30.0, 45.0, 60.0, 75.0][rng.below(4)],
            30.0 * rng.below(12) as f64,
        );
        (
            json!({ "mirror": { "origin": pivot.to_array(), "normal": normal.to_array() } }),
            Layout::Mirror(MirrorLayout {
                origin: pivot,
                normal,
            }),
        )
    } else {
        let axis = polar(90.0, 30.0 * rng.below(12) as f64);
        let count = 2 + rng.below(3);
        let angle = [360.0, 180.0][rng.below(2)];
        (
            json!({ "circular": { "origin": pivot.to_array(), "axis": axis.to_array(), "count": count, "angle": angle } }),
            Layout::Circular(CircularLayout {
                origin: pivot,
                axis,
                count: count as f64,
                angle,
            }),
        )
    };
    let (seed_json, seeds, op, target) = hole_seed(plate, hc, t);
    let case = json!({ "layout": lj, "skip": [], "seed": seed_json, "crossing": true });
    let targets = target.map(|b| vec![ob(b, "e1", "b", 0)]);
    let forge = run_pattern(&layout, &[], op, &seeds, targets);
    (case, forge)
}

/// The curved placement faces of generation 3 (see the module docs).
#[derive(Clone, Copy, Debug)]
enum Curved {
    /// A cylinder of radius `r` on the axis through `c` along the unit `a`, through the plate.
    Tilted { c: Point3, a: Vec3, r: f64 },
    /// A cone along +X with apex `apex` and `tan(half-angle) = k`, above the plate's top.
    Cone { apex: Point3, k: f64 },
    /// A vertical cylinder of radius `r` about `(c, ·)`.
    Notch { c: [f64; 2], r: f64 },
    /// The plate is a z-cylinder of radius `r` on `z ∈ [0, 60]`, cut above the plane through
    /// `(0, 0, 30)` whose normal is 90° − `tilt` from horizontal about X (probes only).
    Slanted { r: f64, tilt: f64 },
}

impl Curved {
    fn name(&self) -> &'static str {
        match self {
            Curved::Tilted { .. } => "tilted_cylinder",
            Curved::Cone { .. } => "cone",
            Curved::Notch { .. } => "notch",
            Curved::Slanted { .. } => "slanted",
        }
    }
    /// `> 0` in the material, `< 0` in the part the tool removed; at least as large as the
    /// distance to the tool's surface in magnitude, up to the cone's `cos α`.
    fn material(&self, p: Point3) -> f64 {
        match *self {
            Curved::Tilted { c, a, r } => {
                let q = p - c;
                (q - a * q.dot(a)).norm() - r
            }
            Curved::Cone { apex, k } => {
                let q = p - apex;
                q.y.hypot(q.z) - k * q.x
            }
            Curved::Notch { c, r } => (p.x - c[0]).hypot(p.y - c[1]) - r,
            Curved::Slanted { r, .. } => r - p.x.hypot(p.y),
        }
    }
    /// The slanted plane's unit normal and in-plane `w` (with `X`).
    fn slant(tilt: f64) -> (Vec3, Vec3) {
        let (s, c) = (tilt.to_radians().sin(), tilt.to_radians().cos());
        (Vec3::new(0.0, -s, c), Vec3::new(0.0, c, s))
    }
    /// The plate (`e1`) and the tool cut from it (`e2`).
    fn operands(&self, w: f64, d: f64, t: f64) -> (Operand, Operand) {
        let plate = operand("e1", 0.0, rect(0.0, 0.0, w, d), t);
        match *self {
            Curved::Tilted { c, a, r } => {
                let len = 2.0 * t / a.z.abs() + 40.0;
                let x = a.any_perpendicular().expect("perpendicular");
                let tool = framed(
                    "e2",
                    IrFrame {
                        origin: (c - a * (0.5 * len)).to_array(),
                        normal: a.to_array(),
                        x_dir: x.to_array(),
                    },
                    vec![SketchCurve::Circle {
                        id: "c".into(),
                        center: [0.0, 0.0],
                        radius: r,
                    }],
                    Sweep::Extrude {
                        distance: len,
                        direction: SweepDirection::Normal,
                    },
                );
                (plate, tool)
            }
            Curved::Cone { apex, k } => {
                let len = w - apex.x + 10.0;
                let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
                    id: id.into(),
                    start: a,
                    end: b,
                };
                let tool = framed(
                    "e2",
                    IrFrame {
                        origin: apex.to_array(),
                        normal: [0.0, -1.0, 0.0],
                        x_dir: [1.0, 0.0, 0.0],
                    },
                    vec![
                        l("a", [0.0, 0.0], [len, 0.0]),
                        l("b", [len, 0.0], [len, k * len]),
                        l("c", [len, k * len], [0.0, 0.0]),
                    ],
                    Sweep::Revolve {
                        axis: SketchAxis {
                            origin: [0.0, 0.0],
                            direction: [1.0, 0.0],
                        },
                        angle: 360.0,
                        direction: SweepDirection::Normal,
                    },
                );
                (plate, tool)
            }
            Curved::Notch { c, r } => {
                let tool = operand(
                    "e2",
                    -1.0,
                    vec![SketchCurve::Circle {
                        id: "c".into(),
                        center: c,
                        radius: r,
                    }],
                    t + 2.0,
                );
                (plate, tool)
            }
            Curved::Slanted { r, tilt } => {
                let cyl = operand(
                    "e1",
                    0.0,
                    vec![SketchCurve::Circle {
                        id: "c".into(),
                        center: [0.0, 0.0],
                        radius: r,
                    }],
                    60.0,
                );
                let (n, _) = Curved::slant(tilt);
                let tool = framed(
                    "e2",
                    IrFrame {
                        origin: [0.0, 0.0, 30.0],
                        normal: n.to_array(),
                        x_dir: [1.0, 0.0, 0.0],
                    },
                    rect(-100.0, -100.0, 200.0, 200.0),
                    Sweep::Extrude {
                        distance: 100.0,
                        direction: SweepDirection::Normal,
                    },
                );
                (cyl, tool)
            }
        }
    }
    /// A random point of the probe plane within `(lo, hi)` of the curved boundary (by
    /// [`Curved::material`], either side), inside the plate's outline by 0.3 mm.
    fn near(&self, rng: &mut Rng, (w, d, t): (f64, f64, f64), lo: f64, hi: f64) -> Point3 {
        for _ in 0..10_000 {
            let p = match *self {
                Curved::Tilted { c, a, r } => {
                    let e = c + a * ((t - c.z) / a.z);
                    let m = r / a.z.abs() + hi;
                    Vec3::new(rng.range(e.x - m, e.x + m), rng.range(e.y - m, e.y + m), t)
                }
                Curved::Cone { apex, k } => {
                    let m = k * (w - apex.x) + hi;
                    Vec3::new(
                        rng.range(apex.x.max(0.3), w - 0.3),
                        rng.range(apex.y - m, apex.y + m),
                        t,
                    )
                }
                Curved::Notch { c, r } => Vec3::new(
                    rng.range(c[0] - r - hi, c[0] + r + hi),
                    rng.range(c[1] - r - hi, c[1] + r + hi),
                    t,
                ),
                Curved::Slanted { r, tilt } => {
                    let (_, wv) = Curved::slant(tilt);
                    let m = r / tilt.to_radians().cos() + hi;
                    Vec3::new(0.0, 0.0, 30.0)
                        + Vec3::unit_x() * rng.range(-r - hi, r + hi)
                        + wv * rng.range(-m, m)
                }
            };
            let inside_outline = matches!(self, Curved::Slanted { .. })
                || (p.x > 0.3 && p.x < w - 0.3 && p.y > 0.3 && p.y < d - 0.3);
            let g = self.material(p).abs();
            if inside_outline && g >= lo && g < hi {
                return p;
            }
        }
        panic!("no sample near the boundary of {self:?}")
    }
}

/// A random curved shape for a `w × d × t` plate (retried by the caller if Forge's cut fails).
fn random_curved(rng: &mut Rng, w: f64, d: f64, t: f64) -> Curved {
    match rng.below(4) {
        0 => Curved::Tilted {
            c: Vec3::new(
                rng.grid(w * 0.35, w * 0.65, 0.5),
                rng.grid(d * 0.35, d * 0.65, 0.5),
                0.5 * t,
            ),
            a: polar(
                [20.0, 35.0, 50.0, 60.0][rng.below(4)],
                15.0 * rng.below(24) as f64,
            ),
            r: rng.grid(4.0, 8.0, 0.5),
        },
        1 => Curved::Cone {
            apex: Vec3::new(
                rng.grid(-10.0, w / 3.0, 0.5),
                rng.grid(d * 0.4, d * 0.6, 0.5),
                t + rng.grid(0.5, 3.0, 0.5),
            ),
            k: [0.2, 0.3, 0.4][rng.below(3)],
        },
        2 => Curved::Notch {
            c: [w, rng.grid(d * 0.3, d * 0.7, 0.5)],
            r: rng.grid(5.0, 12.0, 0.5),
        },
        _ => Curved::Slanted {
            r: rng.grid(6.0, 12.0, 0.5),
            tilt: [40.0, 55.0, 70.0][rng.below(3)],
        },
    }
}

/// `up_to_depth` / `planar_face_distance` results as JSON (a number, `null` for no hit, or
/// `{ "error": code }`).
fn num_or_error(r: Result<Option<f64>, forge_ops::hole::HoleError>) -> Value {
    match r {
        Ok(Some(x)) => json!(x),
        Ok(None) => Value::Null,
        Err(e) => json!({ "error": e.code() }),
    }
}

/// A **curved** case (generation 3): `(plate JSON, case, forge)`.
fn curved_case(rng: &mut Rng, (w, d, t): (f64, f64, f64)) -> (Value, Value, Value) {
    let (shape, pop, cop, body) = loop {
        let shape = random_curved(rng, w, d, t);
        let (pop, cop) = shape.operands(w, d, t);
        let r = apply_body_op(
            BodyOp::Cut,
            &[ob(pop.build().expect("plate"), "e1", "b", 0)],
            &[ob(cop.build().expect("tool"), "e2", "b", 1)],
            "e2",
        );
        if let Ok(mut r) = r
            && r.bodies.len() == 1
        {
            break (shape, pop, cop, r.bodies.remove(0).body);
        }
    };
    let slanted = matches!(shape, Curved::Slanted { .. });
    let size = if let Curved::Slanted { r, .. } = shape {
        [2.0 * r, 2.0 * r, 60.0]
    } else {
        [w, d, t]
    };
    let plate_json = json!({ "size": size,
        "doc": serde_json::to_value(pop.document()).expect("doc"),
        "cut_doc": serde_json::to_value(cop.document()).expect("doc") });
    // Probes: points near the curved boundary, their distances to the face; vertical rays.
    let (face, face_json, ray_face, ray_json, dir) = if let Curved::Slanted { tilt, .. } = shape {
        let (n, _) = Curved::slant(tilt);
        let f = body
            .faces()
            .iter()
            .find(|(_, f)| f.provenance.feature == "e2" && f.provenance.role == Role::CapStart)
            .map(|(id, _)| id)
            .expect("slanted face");
        let fj = json!({ "normal": n.to_array(), "point": [0.0, 0.0, 30.0] });
        (f, fj.clone(), f, fj, Vec3::unit_z())
    } else {
        (
            face_of(&body, Role::CapEnd),
            json!({ "normal": [0.0, 0.0, 1.0], "point": [0.0, 0.0, t] }),
            face_of(&body, Role::CapStart),
            json!({ "normal": [0.0, 0.0, -1.0], "point": [0.0, 0.0, 0.0] }),
            -Vec3::unit_z(),
        )
    };
    let mut points = Vec::new();
    let mut dists = Vec::new();
    let mut rays = Vec::new();
    let mut hs = Vec::new();
    for _ in 0..24 {
        let p = shape.near(rng, (w, d, t), 0.05, 4.0);
        dists.push(num_or_error(planar_face_distance(&body, face, p).map(Some)));
        points.push(p.to_array());
        let o = if slanted {
            Vec3::new(p.x, p.y, -5.0)
        } else {
            p
        };
        hs.push(num_or_error(up_to_depth(&body, ray_face, o, dir)));
        rays.push(json!({ "p": o.to_array(), "d": dir.to_array() }));
    }
    let probes = json!({ "face": face_json, "points": points, "d": dists,
                         "ray_face": ray_json, "rays": rays, "h": hs });
    if slanted {
        let case = json!({ "shape": shape.name(), "hole": Value::Null, "probes": probes });
        return (plate_json, case, json!({ "status": "probes" }));
    }
    // One hole near the curved boundary (or, one in four, anywhere on the face), sometimes up
    // to the plate's bottom (which the curved cut may have notched under the position).
    let mut hc = random_hole(rng, w, d, t, false);
    let p = if rng.below(4) == 0 {
        shape.near(rng, (w, d, t), 6.0, 60.0)
    } else {
        shape.near(rng, (w, d, t), 0.3, 5.0)
    };
    hc.fields["at"] = json!({ "list": [{ "id": "p0", "at": [p.x, p.y] }] });
    hc.top = true;
    if rng.below(3) == 0 && hc.fields.get("insert").is_none() {
        hc.fields["depth"] = json!({ "up_to": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "start" } } });
        if let Some(o) = hc.fields.as_object_mut() {
            o.remove("tip");
            o.remove("thread");
        }
        if let Some(c) = hc.fields.get("cbore").cloned()
            && c.is_object()
        {
            hc.fields["cbore"]["depth"] = json!(c["depth"].as_f64().expect("depth").min(t * 0.5));
        }
        hc.up_to = Some("far");
    }
    let (forge, _) = run_hole(&body, &hc, t);
    let case = json!({ "shape": shape.name(), "hole": hc.fields, "top": true, "flip": false,
                       "up_to": hc.up_to, "probes": probes });
    (plate_json, case, forge)
}

/// The golden family (generation 3): every non-error case of the I9 hole tool fixture, drilled
/// at the centre of a 40 × 40 × 20 plate's top.
fn golden_lines(first_id: usize) -> Vec<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../corpus/v1/conformance/holes/tools.json"
    );
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("tools.json")).expect("json");
    let (w, d, t) = (40.0, 40.0, 20.0);
    let plate_op = operand("e1", 0.0, rect(0.0, 0.0, w, d), t);
    let plate = plate_op.build().expect("plate");
    let mut out = Vec::new();
    for c in fixture["cases"].as_array().expect("cases") {
        if c.get("error").is_some() {
            continue;
        }
        let mut fields = c["hole"].clone();
        fields["at"] = json!({ "list": [{ "id": "a", "at": [20.0, 20.0] }] });
        let hc = HoleCase {
            fields: fields.clone(),
            top: true,
            flip: false,
            up_to: None,
        };
        let started = Instant::now();
        let (forge, _) = run_hole(&plate, &hc, t);
        out.push(json!({
            "id": first_id + out.len(), "family": "golden", "golden": c["id"],
            "ms": started.elapsed().as_secs_f64() * 1e3,
            "plate": { "size": [w, d, t], "doc": serde_json::to_value(plate_op.document()).expect("doc") },
            "case": { "hole": fields, "top": true, "flip": false, "up_to": Value::Null },
            "forge": forge,
        }));
    }
    out
}

/// Generation 4: the deterministic **fixed** family (see the module docs). Each line names
/// its case (`fixed`); the oracle script's known-issue list names the ones a workstream owns.
fn fixed_lines(first_id: usize) -> Vec<Value> {
    let mut out = Vec::new();
    let plate_of = |w: f64, d: f64, t: f64| {
        let op = operand("e1", 0.0, rect(0.0, 0.0, w, d), t);
        let body = op.build().expect("plate");
        (
            json!({ "size": [w, d, t], "doc": serde_json::to_value(op.document()).expect("doc") }),
            body,
        )
    };
    let up_to_far = json!({ "up_to": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "start" } } });
    // `up_to` the part's own far face (the open HOLE_BREAKS_THROUGH question), plain and
    // counterbored.
    for (name, extra) in [
        ("up_to_far", json!({})),
        (
            "up_to_far_cbore",
            json!({ "cbore": { "d": 6.0, "depth": 3.0 } }),
        ),
    ] {
        let (plate_json, plate) = plate_of(40.0, 40.0, 20.0);
        let mut fields = json!({ "d": 3.0, "depth": up_to_far,
                                 "at": { "list": [{ "id": "a", "at": [20.0, 20.0] }] } });
        for (k, v) in extra.as_object().expect("object") {
            fields[k] = v.clone();
        }
        let hc = HoleCase {
            fields: fields.clone(),
            top: true,
            flip: false,
            up_to: Some("far"),
        };
        let (forge, _) = run_hole(&plate, &hc, 20.0);
        out.push(
            json!({ "family": "hole", "fixed": name, "plate": plate_json,
                         "case": { "hole": fields, "top": true, "flip": false, "up_to": "far" },
                         "forge": forge }),
        );
    }
    let linear = |count: f64, spacing: f64, dir: Vec3| {
        (
            json!({ "linear": { "dir": dir.to_array(), "count": count, "spacing": spacing } }),
            Layout::Linear(LinearLayout {
                dir,
                count,
                spacing,
                second: None,
            }),
        )
    };
    let mut pattern =
        |name: &str,
         plate_json: Value,
         (lj, layout): (Value, Layout),
         skip: Vec<Vec<u32>>,
         (seed_json, seeds, op, target): (Value, Vec<SeedBody>, SeedOp, Seeded)| {
            let targets = target.map(|b| vec![ob(b, "e1", "b", 0)]);
            let forge = run_pattern(&layout, &skip, op, &seeds, targets);
            out.push(json!({ "family": "pattern", "fixed": name, "plate": plate_json,
                         "case": { "layout": lj, "skip": skip, "seed": seed_json }, "forge": forge }));
        };
    // Zero instances: a cut seed with `count` 1, a hole seed whose only instance is skipped.
    let (pj, plate) = plate_of(60.0, 40.0, 8.0);
    let slot = operand("e2", -1.0, rect(6.0, 15.0, 4.0, 10.0), 10.0);
    let slot_body = slot.build().expect("slot");
    let cut = seeded(apply_body_op(
        BodyOp::Cut,
        &[ob(plate.clone(), "e1", "b", 0)],
        &[ob(slot_body.clone(), "e2", "b", 1)],
        "e2",
    ));
    pattern(
        "count_one_cut",
        pj.clone(),
        linear(1.0, 10.0, Vec3::unit_x()),
        Vec::new(),
        (
            json!({ "kind": "cut", "doc": serde_json::to_value(slot.document()).expect("doc"), "member": "b" }),
            vec![SeedBody {
                body: slot_body,
                origin: Origin {
                    feature: "e2".into(),
                    member: "b".into(),
                    instance: None,
                },
                keys: None,
                hole: None,
            }],
            SeedOp::Body(BodyOp::Cut),
            cut,
        ),
    );
    let blind = |at: Value, extra: Value| {
        let mut f = json!({ "d": 3.0, "depth": { "blind": 5.0 }, "at": at });
        for (k, v) in extra.as_object().expect("object") {
            f[k] = v.clone();
        }
        HoleCase {
            fields: f,
            top: true,
            flip: false,
            up_to: None,
        }
    };
    pattern(
        "skip_all_hole",
        pj.clone(),
        linear(2.0, 10.0, Vec3::unit_x()),
        vec![vec![1]],
        hole_seed(
            &plate,
            blind(
                json!({ "list": [{ "id": "a", "at": [42.0, 20.0] }] }),
                json!({}),
            ),
            8.0,
        ),
    );
    // A two-boss join seed (x = 10, 30) whose instances straddle the part's edge: one boss
    // on the part and one detached is the join's error ([W0-39] per tool); both detached
    // is a skipped instance.
    // Two bosses of radius `r` and height `h` on the plate's top `t`, centres `xs` × `y`.
    let boss_pair = |plate: &Body, t: f64, xs: [f64; 2], y: f64, r: f64, h: f64| {
        let ops: Vec<Operand> = xs
            .iter()
            .map(|&x| {
                operand(
                    "e2",
                    t,
                    vec![SketchCurve::Circle {
                        id: "c".into(),
                        center: [x, y],
                        radius: r,
                    }],
                    h,
                )
            })
            .collect();
        let members = ["c0", "c1"];
        let bodies: Vec<Body> = ops.iter().map(|o| o.build().expect("boss")).collect();
        let tools: Vec<OpBody> = bodies
            .iter()
            .zip(members)
            .map(|(b, m)| ob(b.clone(), "e2", m, 1))
            .collect();
        let target = seeded(apply_body_op(
            BodyOp::Join,
            &[ob(plate.clone(), "e1", "b", 0)],
            &tools,
            "e2",
        ));
        let seeds = bodies
            .into_iter()
            .zip(members)
            .map(|(body, m)| SeedBody {
                body,
                origin: Origin {
                    feature: "e2".into(),
                    member: m.into(),
                    instance: None,
                },
                keys: None,
                hole: None,
            })
            .collect();
        let docs: Vec<Value> = ops
            .iter()
            .map(|o| serde_json::to_value(o.document()).expect("doc"))
            .collect();
        (
            json!({ "kind": "join", "docs": docs, "members": members }),
            seeds,
            SeedOp::Body(BodyOp::Join),
            target,
        )
    };
    for (name, layout) in [
        ("join_straddle_3x25", linear(3.0, 25.0, Vec3::unit_x())),
        ("join_straddle_2x40", linear(2.0, 40.0, Vec3::unit_x())),
        ("join_rows_4x10_y", linear(4.0, 10.0, Vec3::unit_y())),
    ] {
        pattern(
            name,
            pj.clone(),
            layout,
            Vec::new(),
            boss_pair(&plate, 8.0, [10.0, 30.0], 20.0, 3.0, 6.0),
        );
    }
    // Coincident blind copies: a two-position grid patterned at its own pitch, and a
    // circular layout about the grid's centre that maps positions onto each other.
    let (pj10, plate10) = plate_of(60.0, 40.0, 10.0);
    let grid = || HoleCase {
        fields: json!({ "d": 3.4, "depth": { "blind": 4.0 },
                            "at": { "grid": { "nx": 2, "ny": 1, "dx": 10.0, "dy": 0.0, "center": [20.0, 20.0] } } }),
        top: true,
        flip: false,
        up_to: None,
    };
    pattern(
        "coincident_linear",
        pj10.clone(),
        linear(3.0, 10.0, Vec3::unit_x()),
        Vec::new(),
        hole_seed(&plate10, grid(), 10.0),
    );
    let origin = Vec3::new(20.0, 20.0, 0.0);
    pattern(
        "coincident_circular",
        pj10,
        (
            json!({ "circular": { "origin": origin.to_array(), "axis": [0.0, 0.0, 1.0], "count": 6.0, "angle": 360.0 } }),
            Layout::Circular(CircularLayout {
                origin,
                axis: Vec3::unit_z(),
                count: 6.0,
                angle: 360.0,
            }),
        ),
        Vec::new(),
        hole_seed(&plate10, grid(), 10.0),
    );
    // W4 regression 909#59 (generation 3): a copied counterbored hole's wall tangent to the
    // bottom face across the seed hole's opening; OCCT: BOOLEAN_NON_MANIFOLD.
    let (pj909, plate909) = plate_of(66.0, 36.0, 7.0);
    let origin = Vec3::new(33.0, 18.0, 3.0);
    let axis = Vec3::new(1.0, 1.0, 1.0);
    pattern(
        "regression_909_59",
        pj909,
        (
            json!({ "circular": { "origin": origin.to_array(), "axis": axis.to_array(), "count": 3, "angle": 360.0 } }),
            Layout::Circular(CircularLayout {
                origin,
                axis,
                count: 3.0,
                angle: 360.0,
            }),
        ),
        Vec::new(),
        hole_seed(
            &plate909,
            HoleCase {
                fields: json!({ "at": { "list": [{ "id": "a", "at": [31.5, 17.0] }] },
                                "cbore": { "d": 8.0, "depth": 3.0 }, "d": 3.0, "depth": { "blind": 7.7 } }),
                top: true,
                flip: false,
                up_to: None,
            },
            7.0,
        ),
    );
    // Generation 4, review 4: the fourth review's cases, replayed in every batch. The three
    // `edge_types_*` cases were COUNT_MISMATCHes of the oracle script's older (pre-[W0-43])
    // edge typing, which counted OCCT's native conics for unlisted face pairs (a cone and its
    // mirror or rotated image) as conics; by the current §8.3 rule 3 (W7b's `section_type`)
    // Forge's `bspline` is right and they match. The `w4_*` cases are W4 regressions (the
    // script's `W4_TRACKED` names their reproductions).
    let mirror = |origin: [f64; 3], normal: [f64; 3]| {
        (
            json!({ "mirror": { "normal": normal, "origin": origin } }),
            Layout::Mirror(MirrorLayout {
                origin: Vec3::from(origin),
                normal: Vec3::from(normal),
            }),
        )
    };
    let seed_hole = |plate: &Body, fields: Value, t: f64| {
        hole_seed(
            plate,
            HoleCase {
                fields,
                top: true,
                flip: false,
                up_to: None,
            },
            t,
        )
    };
    // Seed 23 #37 (crossing): a countersunk through hole mirrored in an oblique plane through
    // a point of its axis (the two countersink cones meet in a planar conic; the pair is not
    // listed, so `bspline`).
    let (pj, plate) = plate_of(85.5, 41.0, 6.5);
    pattern(
        "edge_types_23_37",
        pj,
        mirror(
            [43.0, 22.0, 3.125],
            [
                -0.8365163037378078,
                -0.48296291314453427,
                0.25881904510252074,
            ],
        ),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [43.0, 22.0] }] },
                    "csink": "iso10642", "depth": "through", "size": "M3" }),
            6.5,
        ),
    );
    // Seed 23 #59 (crossing): a blind M4 hole rotated about a horizontal axis through a point
    // of its axis (count 3): tip cones meeting their rotated images (unlisted pair, `bspline`).
    let (pj, plate) = plate_of(47.0, 67.5, 6.0);
    let origin = Vec3::new(18.0, 35.5, 1.5);
    let axis = Vec3::new(
        -0.8660254037844387,
        0.49999999999999994,
        6.123233995736766e-17,
    );
    pattern(
        "edge_types_23_59",
        pj,
        (
            json!({ "circular": { "origin": origin.to_array(), "axis": axis.to_array(), "count": 3, "angle": 360.0 } }),
            Layout::Circular(CircularLayout {
                origin,
                axis,
                count: 3.0,
                angle: 360.0,
            }),
        ),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [18.0, 35.5] }] },
                    "depth": { "blind": 3.5 }, "fit": "normal", "size": "M4", "tip": 90.0 }),
            6.0,
        ),
    );
    // Seed 29 #41 (crossing): an M4 countersunk through hole mirrored in an oblique plane;
    // Forge fails with FORGE_BOOLEAN_SSI where OCCT cuts.
    let (pj, plate) = plate_of(40.5, 56.5, 7.0);
    pattern(
        "w4_ssi_29_41",
        pj,
        mirror(
            [21.5, 20.0, 2.0],
            [
                0.6123724356957945,
                0.3535533905932737,
                std::f64::consts::FRAC_1_SQRT_2,
            ],
        ),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [21.5, 20.0] }] },
                    "csink": "iso10642", "depth": "through", "size": "M4" }),
            7.0,
        ),
    );
    // Seed 29 #81 (tilted): a custom countersunk through hole mirrored in the plane with
    // normal (1, 1, 4): a countersink cone meeting its mirror image (unlisted pair, `bspline`).
    let (pj, plate) = plate_of(40.5, 66.0, 13.5);
    pattern(
        "edge_types_29_81",
        pj,
        mirror([20.0, 33.0, 6.0], [1.0, 1.0, 4.0]),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [15.0, 16.5] }] },
                    "csink": { "angle": 100.0, "d": 7.0 }, "d": 3.0, "depth": "through" }),
            13.5,
        ),
    );
    // Seed 41 #187 and #279 (crossing): countersunk through holes rotated four times about a
    // horizontal axis through a point of their axis; Forge fails with FORGE_BOOLEAN_SSI where
    // OCCT fails with BOOLEAN_NON_MANIFOLD (#187) or cuts (#279).
    for (name, size, at, fields, origin, axis) in [
        (
            "w4_ssi_41_187",
            [53.5, 54.5, 12.0],
            [28.5, 25.0],
            json!({ "csink": { "angle": 90.0, "d": 7.0 }, "d": 3.0, "depth": "through" }),
            [28.5, 25.0, 8.5],
            [
                0.8660254037844387,
                0.49999999999999994,
                6.123233995736766e-17,
            ],
        ),
        (
            "w4_ssi_41_279",
            [58.5, 63.0, 9.5],
            [38.5, 39.0],
            json!({ "csink": "iso10642", "depth": "through", "size": "M6" }),
            [38.5, 39.0, 4.375],
            [
                -0.8660254037844386,
                -0.5000000000000001,
                6.123233995736766e-17,
            ],
        ),
    ] {
        let (pj, plate) = plate_of(size[0], size[1], size[2]);
        let mut f = fields;
        f["at"] = json!({ "list": [{ "id": "a", "at": at }] });
        let (origin, axis) = (Vec3::from(origin), Vec3::from(axis));
        pattern(
            name,
            pj,
            (
                json!({ "circular": { "origin": origin.to_array(), "axis": axis.to_array(), "count": 4, "angle": 360.0 } }),
                Layout::Circular(CircularLayout {
                    origin,
                    axis,
                    count: 4.0,
                    angle: 360.0,
                }),
            ),
            Vec::new(),
            seed_hole(&plate, f, size[2]),
        );
    }
    // Seed 41 #79 (crossing, to triage — W4 unify or the oracle's rule 1): a counterbored blind
    // hole mirrored in an oblique plane through a point of its axis. Volume and area agree;
    // Forge keeps each tip cone in 3 pieces (24 faces, 41 edges), OCCT after §8.3 has 23 / 38:
    // the two tips are mirror images, whose intersection has crossing branches.
    let (pj, plate) = plate_of(74.5, 61.0, 11.0);
    pattern(
        "triage_topology_41_79",
        pj,
        mirror(
            [35.5, 32.5, 4.5],
            [
                -0.8365163037378078,
                -0.48296291314453427,
                0.25881904510252074,
            ],
        ),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [35.5, 32.5] }] },
                    "cbore": { "d": 7.5, "depth": 3.0 }, "d": 3.0, "depth": { "blind": 7.1 } }),
            11.0,
        ),
    );
    // Review 5, seed 131 #169 (crossing): a flat-bottomed blind hole rotated four times about a
    // horizontal axis through a point of its axis. Forge removes the closed form (a through
    // hole plus a crossing horizontal cylinder, Steinmetz overlap: `pattern_apply.rs`
    // `a_hole_rotated_about_a_point_of_its_axis_removes_the_bicylinder_closed_form`); OCCT's
    // cut removes 16.6 mm³ too little — the script's Monte Carlo adjudication classifies it
    // `OCCT_WRONG`.
    let (pj, plate) = plate_of(64.5, 45.0, 8.0);
    let origin = Vec3::new(17.0, 15.0, 3.25);
    let axis = Vec3::new(
        0.5000000000000001,
        0.8660254037844386,
        6.123233995736766e-17,
    );
    pattern(
        "occt_wrong_131_169",
        pj,
        (
            json!({ "circular": { "origin": origin.to_array(), "axis": axis.to_array(), "count": 4, "angle": 360.0 } }),
            Layout::Circular(CircularLayout {
                origin,
                axis,
                count: 4.0,
                angle: 360.0,
            }),
        ),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [17.0, 15.0] }] },
                    "d": 3.25, "depth": { "blind": 6.5 }, "tip": "flat" }),
            8.0,
        ),
    );
    // Review 5, seed 97 #71: a join seed of two bosses (r = 4, centres 8 apart) tangent to
    // each other along a vertical line above a 6.5 mm plate. By SPEC §6.0.3 the union touches
    // itself along that line: Forge's seed fails with BOOLEAN_NON_MANIFOLD (the oracle script
    // now flags tools touching outside the targets too).
    let (pj, plate) = plate_of(60.0, 45.0, 6.5);
    pattern(
        "tangent_join_bosses_97_71",
        pj,
        linear(2.0, 20.0, Vec3::unit_x()),
        Vec::new(),
        boss_pair(&plate, 6.5, [23.0, 31.0], 22.5, 4.0, 8.0),
    );
    // Review 5: a linear pattern of a blind M3 hole (count 3, spacing 30) on a 40 mm plate:
    // every copy misses — PATTERN_ALL_INSTANCES_FAILED (the engines differ in whether skip
    // warnings accompany the error and in the shape of `instances`: W5 contract issue 4).
    let (pj, plate) = plate_of(40.0, 40.0, 10.0);
    pattern(
        "all_failed_m3",
        pj,
        linear(3.0, 30.0, Vec3::unit_x()),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [20.0, 20.0] }] },
                    "size": "M3", "depth": { "blind": 5.0 } }),
            10.0,
        ),
    );
    // Review 5: a body seed joined to the plate [0, 30]² × [0, 10] (kind `body_join`: the seed
    // body is a separate body, only its copies are joined): a rod (r = 2, axis y = 15, z = 12,
    // x ∈ [15, 55]) whose bottom a notch removed over x ∈ [15, 40] (floor z = 11), with a leg
    // into the plate — a cylinder face whose (u, v) domain is not a rectangle, where W5's
    // tangent-contact guard once reported a false contact line — and the same rod notched
    // beyond the plate (x ∈ [35, 60]), whose bottom lies along the plate's top: a real one.
    let (pj30, plate30) = plate_of(30.0, 30.0, 10.0);
    for (name, notch_x0) in [("notched_rod_join", 15.0), ("rod_contact_join", 35.0)] {
        let rod_op = framed(
            "t1",
            IrFrame {
                origin: [15.0, 0.0, 0.0],
                normal: [1.0, 0.0, 0.0],
                x_dir: [0.0, 1.0, 0.0],
            },
            vec![SketchCurve::Circle {
                id: "c".into(),
                center: [15.0, 12.0],
                radius: 2.0,
            }],
            Sweep::Extrude {
                distance: 40.0,
                direction: SweepDirection::Normal,
            },
        );
        let notch = operand("n1", 9.0, rect(notch_x0, 12.0, 25.0, 6.0), 2.0);
        let leg = operand("n2", 5.0, rect(20.0, 14.0, 5.0, 2.0), 6.5);
        let rod = seeded(apply_body_op(
            BodyOp::Cut,
            &[ob(rod_op.build().expect("rod"), "t1", "b", 1)],
            &[ob(notch.build().expect("notch"), "n1", "b", 2)],
            "n1",
        ))
        .and_then(|r| {
            seeded(apply_body_op(
                BodyOp::Join,
                &[ob(r, "t1", "b", 1)],
                &[ob(leg.build().expect("leg"), "n2", "b", 3)],
                "n2",
            ))
        })
        .expect("the rod");
        let doc = |o: &Operand| serde_json::to_value(o.document()).expect("doc");
        pattern(
            name,
            pj30.clone(),
            linear(2.0, 5.0, Vec3::unit_y()),
            Vec::new(),
            (
                json!({ "kind": "body_join", "doc": doc(&rod_op), "member": "b",
                        "parts": [{ "op": "cut", "doc": doc(&notch) }, { "op": "join", "doc": doc(&leg) }] }),
                vec![SeedBody {
                    body: rod,
                    origin: Origin {
                        feature: "t1".into(),
                        member: "b".into(),
                        instance: None,
                    },
                    keys: None,
                    hole: None,
                }],
                SeedOp::Body(BodyOp::Join),
                Ok(plate30.clone()),
            ),
        );
    }
    // Seed 23 #49 (extra targets): a countersunk through hole patterned 29 times about Z
    // (instance [1] skipped) over the plate joined to a 20 mm block under its right half;
    // Forge fails with FORGE_BOOLEAN_INCONSISTENT where OCCT cuts.
    let (pj49, plate49) = plate_of(55.0, 52.5, 9.0);
    let (seed_json, seeds, op, target) = seed_hole(
        &plate49,
        json!({ "at": { "list": [{ "id": "a", "at": [37.0, 22.5] }] },
                "csink": { "angle": 82.0, "d": 7.5 }, "d": 3.0, "depth": "through" }),
        9.0,
    );
    let block = operand("e5", -20.0, rect(30.0, 0.0, 25.0, 52.5), 20.0);
    let targets = target.and_then(|t| {
        seeded(apply_body_op(
            BodyOp::Join,
            &[ob(t, "e1", "b", 0)],
            &[ob(block.build().expect("block"), "e5", "b", 1)],
            "e5",
        ))
        .map(|b| vec![ob(b, "e1", "b", 0)])
        .map_err(|mut e| {
            e["stage"] = json!("extra");
            e
        })
    });
    let origin = Vec3::new(27.0, 26.0, 0.0);
    let layout = Layout::Circular(CircularLayout {
        origin,
        axis: Vec3::unit_z(),
        count: 29.0,
        angle: 360.0,
    });
    let skip = vec![vec![1]];
    let forge = run_pattern(&layout, &skip, op, &seeds, targets);
    out.push(json!({ "family": "pattern", "fixed": "w4_inconsistent_23_49", "plate": pj49,
                     "case": { "layout": { "circular": { "origin": origin.to_array(), "axis": [0.0, 0.0, 1.0], "count": 29.0, "angle": 360.0 } },
                               "skip": skip, "seed": seed_json,
                               "extra": { "doc": serde_json::to_value(block.document()).expect("doc"), "join": true } },
                     "forge": forge }));
    // Review 4: a dense bolt circle (12 × Ø3 on a Ø6 circle, blind 4 in an 8 mm plate). Tools
    // i and i + 2 touch at a point that tool i + 1 covers, so the result is manifold; Forge
    // fails with BOOLEAN_NON_MANIFOLD (W4 tests tangencies without the other tools).
    let (pj, plate) = plate_of(40.0, 40.0, 8.0);
    let fields = json!({ "at": { "circle": { "n": 12, "d": 6.0, "center": [20.0, 20.0] } },
                         "d": 3.0, "depth": { "blind": 4.0 } });
    let hc = HoleCase {
        fields: fields.clone(),
        top: true,
        flip: false,
        up_to: None,
    };
    let (forge, _) = run_hole(&plate, &hc, 8.0);
    out.push(
        json!({ "family": "hole", "fixed": "w4_bolt_circle_12", "plate": pj,
                     "case": { "hole": fields, "top": true, "flip": false, "up_to": Value::Null },
                     "forge": forge }),
    );
    // Review 5: the tol band at the far face of a 40 × 40 × 10 plate (M3 at the centre): the
    // drill-point apex (`tip_band_*`) or the flat floor (`floor_band_*`) ends `below` under
    // the far face (`m`: above it; in 1e-6 mm). Within tol the bottom lies on the face ([R-3]):
    // Forge fails explicitly (tip: BOOLEAN_NON_MANIFOLD at the apex, or W4's
    // FORGE_BOOLEAN_INCONSISTENT under the face; floor: FORGE_BOOLEAN_NEAR_COINCIDENT), where the
    // oracle's reading is ok + HOLE_BREAKS_THROUGH (W5 contract question: a touching tip).
    let (pj, plate) = plate_of(40.0, 40.0, 10.0);
    let tip = 1.7 / 59f64.to_radians().tan();
    for (kind, drop) in [("tip", tip), ("floor", 0.0)] {
        for (tag, below) in [
            ("m15", -1.5e-6),
            ("m05", -0.5e-6),
            ("0", 0.0),
            ("p05", 0.5e-6),
            ("p15", 1.5e-6),
        ] {
            let mut fields = json!({ "size": "M3", "depth": { "blind": 10.0 - drop + below },
                                     "at": { "list": [{ "id": "a", "at": [20.0, 20.0] }] } });
            if kind == "floor" {
                fields["tip"] = json!("flat");
            }
            let hc = HoleCase {
                fields: fields.clone(),
                top: true,
                flip: false,
                up_to: None,
            };
            let (forge, _) = run_hole(&plate, &hc, 10.0);
            out.push(json!({ "family": "hole", "fixed": format!("{kind}_band_{tag}"), "plate": pj.clone(),
                             "case": { "hole": fields, "top": true, "flip": false, "up_to": Value::Null },
                             "forge": forge }));
        }
    }
    // (`pattern` borrows `out`, which the cases above push to directly.)
    let pattern_line =
        |name: &str,
         plate_json: Value,
         (lj, layout): (Value, Layout),
         skip: Vec<Vec<u32>>,
         (seed_json, seeds, op, target): (Value, Vec<SeedBody>, SeedOp, Seeded)| {
            let targets = target.map(|b| vec![ob(b, "e1", "b", 0)]);
            let forge = run_pattern(&layout, &skip, op, &seeds, targets);
            json!({ "family": "pattern", "fixed": name, "plate": plate_json,
                    "case": { "layout": lj, "skip": skip, "seed": seed_json }, "forge": forge })
        };
    let mut pattern = |name: &str,
                       plate_json: Value,
                       layout: (Value, Layout),
                       skip: Vec<Vec<u32>>,
                       seed: (Value, Vec<SeedBody>, SeedOp, Seeded)| {
        out.push(pattern_line(name, plate_json, layout, skip, seed));
    };
    // Review 6, seed 313 #37 (plan): a two-boss join seed (r = 1.5, 2 high, x = 5.5 and 21.5)
    // copied by −13 along X: one copy is detached, the other touches the seed's boss along a
    // line. [W0-39] per tool before the join's own failure: BOOLEAN_NO_INTERSECTION naming the
    // detached copy (`pattern_apply.rs`
    // `a_detached_join_tool_is_reported_before_the_joins_own_non_manifold_failure`).
    let (pj, plate) = plate_of(63.0, 47.5, 9.5);
    let two_dir = Layout::Linear(LinearLayout {
        dir: -Vec3::unit_x(),
        count: 2.0,
        spacing: 13.0,
        second: Some((Vec3::unit_y(), 1.0, 9.5)),
    });
    pattern(
        "join_detached_first_313_37",
        pj,
        (
            json!({ "linear": { "dir": [-1.0, 0.0, 0.0], "count": 2.0, "spacing": 13.0,
                                "dir2": [0.0, 1.0, 0.0], "count2": 1.0, "spacing2": 9.5 } }),
            two_dir,
        ),
        Vec::new(),
        boss_pair(&plate, 9.5, [5.5, 21.5], 21.0, 1.5, 2.0),
    );
    // Review 6, seed 313 #73 and #31 (crossing): results pinched at a vertex. #73: a
    // counterbored hole rotated four times about a horizontal axis through (59, 13, 1); the 90°
    // copy's wall top ruling (z = 2.5) reaches the seed's counterbore floor, wall and the
    // copy's shoulder at one point, leaving two horns joined there. #31: a blind hole rotated
    // about a horizontal axis (180°, count 3), pinched at two symmetric points. Forge fails
    // both with BOOLEAN_NON_MANIFOLD; the oracle's `pinch_vertices` + `pinch_verdict` confirm
    // the pinches on the operands (OCCT's own checks see one point of #31 and none of #73).
    let (pj, plate) = plate_of(89.0, 39.5, 4.0);
    let origin = Vec3::new(59.0, 13.0, 1.0);
    let axis = Vec3::new(
        0.8660254037844384,
        -0.5000000000000004,
        6.123233995736766e-17,
    );
    pattern(
        "pinch_vertex_313_73",
        pj,
        (
            json!({ "circular": { "origin": origin.to_array(), "axis": axis.to_array(), "count": 4, "angle": 360.0 } }),
            Layout::Circular(CircularLayout {
                origin,
                axis,
                count: 4.0,
                angle: 360.0,
            }),
        ),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [59.0, 13.0] }] },
                    "cbore": { "d": 7.0, "depth": 1.5 }, "d": 3.0, "depth": { "blind": 2.9 } }),
            4.0,
        ),
    );
    let (pj, plate) = plate_of(77.5, 49.5, 6.5);
    let origin = Vec3::new(62.0, 34.0, 2.375);
    let axis = Vec3::new(-1.0, 1.2246467991473532e-16, 6.123233995736766e-17);
    pattern(
        "pinch_vertex_313_31",
        pj,
        (
            json!({ "circular": { "origin": origin.to_array(), "axis": axis.to_array(), "count": 3, "angle": 180.0 } }),
            Layout::Circular(CircularLayout {
                origin,
                axis,
                count: 3.0,
                angle: 180.0,
            }),
        ),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [62.0, 34.0] }] },
                    "d": 4.25, "depth": { "blind": 2.0 }, "tip": 135.0 }),
            6.5,
        ),
    );
    // Review 6, seed 313 #249 (crossing): an M6 threaded blind hole mirrored in an oblique
    // plane through a point of its axis. OCCT's result has a vertex with two fans of faces
    // where the two shoulder circles cross the mirror plane, but the material around it is one
    // wedge (61 % of a small sphere, one region; the rest one region): the oracle refutes the
    // pinch (`pinch_verdict`), so Forge's body is not POTENTIAL_SILENT_WRONG; the face counts
    // differ by OCCT's pinched faces (COUNT_PINCHED_FACE, W5 contract issue 6).
    let (pj, plate) = plate_of(52.5, 60.5, 7.0);
    pattern(
        "pinch_refuted_313_249",
        pj,
        mirror(
            [29.0, 47.5, 3.75],
            [0.48296291314453427, 0.8365163037378078, 0.25881904510252074],
        ),
        Vec::new(),
        seed_hole(
            &plate,
            json!({ "at": { "list": [{ "id": "a", "at": [29.0, 47.5] }] },
                    "size": "M6", "thread": true, "depth": { "blind": 6.0 } }),
            7.0,
        ),
    );
    // Review 6, seeds 419 #275 and 521 #267 (crossing): flat-bottomed blind holes rotated half
    // a turn (count 4) about a horizontal axis through a point of their axis. OCCT's cut has an
    // edge in more than two faces in a manifold region (refuted) and the wrong volume or area;
    // the script's exact adjudication decides OCCT_WRONG (`pattern_apply.rs`
    // `flat_bottomed_holes_rotated_about_a_point_of_their_axis_match_the_analytic_reference`).
    for (name, size, fields, origin, axis) in [
        (
            "occt_wrong_419_275",
            [72.0, 41.0, 11.5],
            json!({ "at": { "list": [{ "id": "a", "at": [57.0, 26.0] }] },
                    "insert": "std", "size": "M3" }),
            [57.0, 26.0, 7.625],
            [6.123233995736766e-17, 1.0, 6.123233995736766e-17],
        ),
        (
            "occt_wrong_521_267",
            [59.5, 56.0, 14.0],
            json!({ "at": { "list": [{ "id": "a", "at": [30.5, 28.5] }] },
                    "d": 3.75, "depth": { "blind": 9.5 }, "tip": "flat" }),
            [30.5, 28.5, 5.75],
            [
                -0.8660254037844387,
                0.49999999999999994,
                6.123233995736766e-17,
            ],
        ),
    ] {
        let (pj, plate) = plate_of(size[0], size[1], size[2]);
        let (origin, axis) = (Vec3::from(origin), Vec3::from(axis));
        pattern(
            name,
            pj,
            (
                json!({ "circular": { "origin": origin.to_array(), "axis": axis.to_array(), "count": 4, "angle": 180.0 } }),
                Layout::Circular(CircularLayout {
                    origin,
                    axis,
                    count: 4.0,
                    angle: 180.0,
                }),
            ),
            Vec::new(),
            seed_hole(&plate, fields, size[2]),
        );
    }
    for (k, line) in out.iter_mut().enumerate() {
        line["id"] = json!(first_id + k);
    }
    out
}

#[test]
#[ignore]
fn write_hole_pattern_oracle_batch() {
    let out = std::env::var("HOLE_PATTERN_BATCH_OUT")
        .unwrap_or_else(|_| "hole_pattern_batch.jsonl".into());
    let seed: u64 = std::env::var("HOLE_PATTERN_SEED").map_or(7, |s| s.parse().expect("seed"));
    let n: usize = std::env::var("HOLE_PATTERN_COUNT").map_or(320, |s| s.parse().expect("count"));
    let g = generation();
    let mut f = std::fs::File::create(&out).expect("create batch file");
    let mut rng = Rng::new(seed);
    let mut stats = std::collections::BTreeMap::<String, usize>::new();
    let mut tally = |family: &str, forge: &Value| {
        let key = format!(
            "{family}:{}",
            forge
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or(forge["status"].as_str().unwrap_or("?"))
        );
        *stats.entry(key).or_default() += 1;
    };
    for id in 0..n {
        let (w, d, t) = (
            rng.grid(40.0, 90.0, 0.5),
            rng.grid(36.0, 70.0, 0.5),
            rng.grid(4.0, 14.0, 0.5),
        );
        let plate_op = operand("e1", 0.0, rect(0.0, 0.0, w, d), t);
        let plate = plate_op.build().expect("plate");
        let plain = json!({ "size": [w, d, t], "doc": serde_json::to_value(plate_op.document()).expect("doc") });
        let started = Instant::now();
        let family = if g >= 3 {
            ["hole", "pattern", "curved", "pattern"][id % 4]
        } else {
            ["hole", "pattern"][id % 2]
        };
        let (plate_json, case, forge) = match family {
            "hole" => {
                let hc = random_hole(&mut rng, w, d, t, true);
                let mut fields = hc.fields.clone();
                if !hc.top {
                    flip_v(&mut fields["at"]);
                }
                let (forge, _) = run_hole(&plate, &hc, t);
                (
                    plain,
                    json!({ "hole": fields, "top": hc.top, "flip": hc.flip, "up_to": hc.up_to }),
                    forge,
                )
            }
            "curved" => curved_case(&mut rng, (w, d, t)),
            _ => {
                let (case, forge) = if g >= 3 && rng.below(4) == 0 {
                    crossing_pattern(&mut rng, &plate, w, d, t)
                } else {
                    random_pattern(&mut rng, &plate, w, d, t)
                };
                (plain, case, forge)
            }
        };
        let ms = started.elapsed().as_secs_f64() * 1e3;
        tally(family, &forge);
        let line = json!({
            "id": id, "family": family, "ms": ms, "plate": plate_json, "case": case, "forge": forge,
        });
        writeln!(f, "{line}").expect("write");
    }
    if g >= 3 {
        let golden = golden_lines(n);
        let next = n + golden.len();
        for line in golden {
            tally("golden", &line["forge"]);
            writeln!(f, "{line}").expect("write");
        }
        if g >= 4 {
            for line in fixed_lines(next) {
                tally("fixed", &line["forge"]);
                writeln!(f, "{line}").expect("write");
            }
        }
    }
    eprintln!("wrote {out} (generation {g}): {stats:?}");
}
