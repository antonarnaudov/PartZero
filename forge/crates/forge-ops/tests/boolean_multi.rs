//! Booleans with several targets and tools (SPEC §6.0.3): multi-tool cuts (the path hole
//! features take), overlapping tools, consumed and untouched targets, multi-tool
//! intersections, join components independent of operand order, non-manifold contacts
//! between operands, identity and keys (§5.2 rule 3), canonical order of split pieces
//! (§5.4), empty operand lists and `BOOLEAN_TOOL_IS_TARGET`. Closed-form volumes, validity
//! of every result.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::topo::{Body, Provenance, Role, Severity};
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchAxis, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyChange, BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op};

const PI: f64 = std::f64::consts::PI;

fn plane_z(z: f64) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin: [0.0, 0.0, z],
        normal: [0.0, 0.0, 1.0],
        x_dir: [1.0, 0.0, 0.0],
    })
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

fn build(feature: &str, plane: PlaneSpec, curves: Vec<SketchCurve>, sweep: Sweep) -> Body {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane,
            curves,
        },
        sweep,
    }
    .build()
    .unwrap_or_else(|e| panic!("operand {feature}: {e:?}"))
}

fn extrude(d: f64) -> Sweep {
    Sweep::Extrude {
        distance: d,
        direction: SweepDirection::Normal,
    }
}

/// Axis-aligned box `[lo, hi]`.
fn aabox(feature: &str, lo: [f64; 3], hi: [f64; 3]) -> Body {
    build(
        feature,
        plane_z(lo[2]),
        vec![
            line("b", [lo[0], lo[1]], [hi[0], lo[1]]),
            line("r", [hi[0], lo[1]], [hi[0], hi[1]]),
            line("t", [hi[0], hi[1]], [lo[0], hi[1]]),
            line("l", [lo[0], hi[1]], [lo[0], lo[1]]),
        ],
        extrude(hi[2] - lo[2]),
    )
}

/// Cylinder of radius `r` about Z through `c`, `z` in `[z0, z1]`.
fn zcyl(feature: &str, c: [f64; 2], r: f64, z0: f64, z1: f64) -> Body {
    build(
        feature,
        plane_z(z0),
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: c,
            radius: r,
        }],
        extrude(z1 - z0),
    )
}

/// Sphere of radius `r` at `c` (axis Z).
fn sphere(feature: &str, c: [f64; 3], r: f64) -> Body {
    build(
        feature,
        PlaneSpec::Frame(Frame {
            origin: c,
            normal: [0.0, -1.0, 0.0],
            x_dir: [1.0, 0.0, 0.0],
        }),
        vec![
            SketchCurve::Arc {
                id: "a".into(),
                start: [0.0, -r],
                end: [0.0, r],
                center: [0.0, 0.0],
                ccw: true,
            },
            line("l", [0.0, r], [0.0, -r]),
        ],
        Sweep::Revolve {
            axis: SketchAxis {
                origin: [0.0, 0.0],
                direction: [0.0, 1.0],
            },
            angle: 360.0,
            direction: SweepDirection::Normal,
        },
    )
}

fn origin(feature: &str) -> Origin {
    Origin {
        feature: feature.into(),
        member: "m".into(),
        instance: None,
    }
}

fn ob(body: Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: origin(feature),
        timeline,
    }
}

fn run(op: BodyOp, targets: &[OpBody], tools: &[OpBody]) -> BodyOpResult {
    apply_body_op(op, targets, tools, "g").unwrap_or_else(|e| panic!("{op:?}: {} {e}", e.code()))
}

/// `(volume, area, faces, edges)` of every result body, after checking validity.
fn metrics(r: &BodyOpResult) -> Vec<(f64, f64, usize, usize)> {
    r.bodies
        .iter()
        .map(|b| {
            let issues = forge_check::validate(&b.body);
            assert!(
                issues.iter().all(|i| i.severity != Severity::Error),
                "invalid result: {issues:?}"
            );
            let mp = forge_check::mass_properties(&b.body).expect("mass");
            (
                mp.volume,
                mp.area,
                b.body.faces().len(),
                b.body.edges().len(),
            )
        })
        .collect()
}

fn centroid(b: &Body) -> [f64; 3] {
    forge_check::mass_properties(b).expect("mass").centroid
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * (1.0 + a.abs().max(b.abs()))
}

/// Face display name → SPEC §5.2 key, for names one key designates (`None`: ambiguous).
fn face_name_keys(b: &Body) -> BTreeMap<String, Option<String>> {
    let mut m: BTreeMap<String, Option<String>> = BTreeMap::new();
    for (_, f) in b.faces().iter() {
        let k = f.provenance.key();
        let slot = m
            .entry(f.provenance.name())
            .or_insert_with(|| Some(k.clone()));
        if slot.as_ref() != Some(&k) {
            *slot = None;
        }
    }
    m
}

/// The SPEC §5.2 key of an entity as forge-refs renders it: sources that are face display
/// names become those faces' keys; sources that are keys stay.
fn spec_key(b: &Body, p: &Provenance) -> String {
    let names = face_name_keys(b);
    match p.role {
        Role::EdgeBetween | Role::VertexAt => {
            let sources: Vec<String> = p
                .sources
                .iter()
                .map(|s| match names.get(s) {
                    Some(Some(k)) => k.clone(),
                    _ => s.clone(),
                })
                .collect();
            p.key_with_sources(&sources)
        }
        _ => p.key(),
    }
}

fn face_keys(b: &Body) -> Vec<String> {
    let mut k: Vec<String> = b.faces().iter().map(|(_, f)| f.provenance.key()).collect();
    k.sort();
    k
}

fn edge_keys(b: &Body) -> BTreeSet<String> {
    b.edges()
        .iter()
        .map(|(_, e)| spec_key(b, &e.provenance))
        .collect()
}

/// The key invariant of SPEC §5.2 on a result body, as forge-refs' `key_problems` states it
/// for what a body operation controls: every cap and end cap carries its body member;
/// every edge source is a face of the body (by unambiguous name or by key), or an alias
/// (from `aliases`) of one; faces or edges share a key only as split pieces (on one
/// carrier). Returns the problems.
///
/// Vertices are not held to the source rule: an operand vertex keeps its key through the
/// operation even when a face it names is dropped (a boss's bottom corner on the plate's
/// top), as the W7b oracle keys them from OCCT's history; forge-refs' `key_problems` does
/// hold them to it (a contract note of `docs/spikes/03-ssi.md`).
fn key_problems(b: &Body, aliases: &[(String, String)]) -> Vec<String> {
    let names = face_name_keys(b);
    let face_keys: BTreeSet<String> = b.faces().iter().map(|(_, f)| f.provenance.key()).collect();
    let alias_to: BTreeMap<&str, &str> = aliases
        .iter()
        .map(|(a, t)| (a.as_str(), t.as_str()))
        .collect();
    let mut out = Vec::new();
    for (_, f) in b.faces().iter() {
        let p = &f.provenance;
        let cap = matches!(
            p.role,
            Role::CapStart | Role::CapEnd | Role::EndCapStart | Role::EndCapEnd
        );
        if cap && p.qualifier.is_none() {
            out.push(format!("{}: cap without a body member", p.key()));
        }
    }
    let provs: Vec<&Provenance> = b.edges().iter().map(|(_, e)| &e.provenance).collect();
    for p in provs {
        if !matches!(p.role, Role::EdgeBetween | Role::VertexAt) {
            continue;
        }
        for s in &p.sources {
            let ok = matches!(names.get(s), Some(Some(_)))
                || face_keys.contains(s)
                || alias_to
                    .get(s.as_str())
                    .is_some_and(|t| face_keys.contains(*t));
            if !ok {
                out.push(format!(
                    "{}: source {s} is not a face of the body",
                    p.name()
                ));
            }
        }
    }
    let mut by_key: BTreeMap<(u8, String), Vec<String>> = BTreeMap::new();
    for (_, f) in b.faces().iter() {
        by_key
            .entry((0, f.provenance.key()))
            .or_default()
            .push(format!("{:?}", f.surface));
    }
    for (_, e) in b.edges().iter() {
        by_key
            .entry((1, spec_key(b, &e.provenance)))
            .or_default()
            .push(format!("{:?}", e.curve));
    }
    for ((_, k), carriers) in by_key {
        if carriers.iter().any(|c| *c != carriers[0]) {
            out.push(format!("{k}: shared by entities on different carriers"));
        }
    }
    out
}

/// Every permutation of `0..n` (n ≤ 4).
fn permutations(n: usize) -> Vec<Vec<usize>> {
    if n == 0 {
        return vec![Vec::new()];
    }
    let mut out = Vec::new();
    for p in permutations(n - 1) {
        for i in 0..=p.len() {
            let mut q = p.clone();
            q.insert(i, n - 1);
            out.push(q);
        }
    }
    out
}

/// A plate with four holes cut by four tools in one operation (what a hole feature with
/// four positions does): the exact volume, 10 faces, the hole walls keep the tools' keys and
/// the rims are the operation's intersection edges; any order of the tools gives the same
/// body, bit for bit.
#[test]
fn four_holes_in_one_cut() {
    let plate = || ob(aabox("p", [0.0, 0.0, 0.0], [10.0, 10.0, 2.0]), "p", 0);
    let centers = [[2.5, 2.5], [7.5, 2.5], [2.5, 7.5], [7.5, 7.5]];
    let tools: Vec<OpBody> = centers
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            let f = format!("h{i}");
            ob(zcyl(&f, c, 1.0, -1.0, 3.0), &f, 1 + i)
        })
        .collect();
    let r = run(BodyOp::Cut, &[plate()], &tools);
    let m = metrics(&r);
    assert_eq!(m.len(), 1);
    assert!(close(m[0].0, 200.0 - 8.0 * PI), "{m:?}");
    assert!(
        close(
            m[0].1,
            2.0 * (100.0 - 4.0 * PI) + 80.0 + 4.0 * 2.0 * PI * 2.0
        ),
        "{m:?}"
    );
    assert_eq!((m[0].2, m[0].3), (10, 20), "{m:?}");
    let body = &r.bodies[0].body;
    let keys = face_keys(body);
    for i in 0..4 {
        assert!(keys.contains(&format!("h{i}/side:c")), "{keys:?}");
        let edges = edge_keys(body);
        for cap in ["p/cap:start@m", "p/cap:end@m"] {
            let k = format!("g/edge:{{h{i}/side:c|{cap}}}");
            assert!(edges.contains(&k), "{k} not in {edges:?}");
        }
    }
    assert!(r.untouched.is_empty() && r.removed.is_empty() && r.splits.is_empty());
    assert_eq!(r.bodies[0].origin, origin("p"));
    let reference = format!("{:?}", r.bodies[0].body);
    for perm in permutations(4) {
        let ts: Vec<OpBody> = perm.iter().map(|&i| tools[i].clone()).collect();
        let rp = run(BodyOp::Cut, &[plate()], &ts);
        assert_eq!(
            format!("{:?}", rp.bodies[0].body),
            reference,
            "tool order {perm:?} changed the result"
        );
    }
}

/// Two overlapping hole tools: the plate minus the union of two unit disks one apart.
#[test]
fn overlapping_tools_cut_their_union() {
    let plate = ob(aabox("p", [0.0, 0.0, 0.0], [10.0, 10.0, 2.0]), "p", 0);
    let k1 = ob(zcyl("k1", [4.5, 5.0], 1.0, -1.0, 3.0), "k1", 1);
    let k2 = ob(zcyl("k2", [5.5, 5.0], 1.0, -1.0, 3.0), "k2", 2);
    let r = run(BodyOp::Cut, &[plate], &[k1, k2]);
    let m = metrics(&r);
    let lens = 2.0 * PI / 3.0 - 3f64.sqrt() / 2.0;
    let union = 2.0 * PI - lens;
    assert_eq!(m.len(), 1);
    assert!(close(m[0].0, 200.0 - 2.0 * union), "{m:?}");
    // Plate faces + two partial walls.
    assert_eq!(m[0].2, 8, "{m:?}");
}

/// Three targets: one inside the tool (consumed, a warning), one away from it (untouched,
/// not reported as modified), one cut.
#[test]
fn consumed_and_untouched_targets() {
    let inside = ob(aabox("t1", [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]), "t1", 0);
    let away = ob(aabox("t2", [20.0, 0.0, 0.0], [22.0, 2.0, 2.0]), "t2", 1);
    let cut = ob(aabox("t3", [3.0, 0.0, 0.0], [8.0, 3.0, 3.0]), "t3", 2);
    let tool = ob(aabox("k", [0.0, 0.0, 0.0], [5.0, 3.0, 3.0]), "k", 3);
    let r = run(BodyOp::Cut, &[inside, away, cut], &[tool]);
    assert_eq!(r.removed, vec![origin("t1")]);
    assert_eq!(r.untouched, vec![origin("t2")]);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].origin, origin("t3"));
    let m = metrics(&r);
    assert!(close(m[0].0, 3.0 * 3.0 * 3.0), "{m:?}");
    let codes: Vec<&str> = r.notes.iter().map(|n| n.code()).collect();
    assert_eq!(codes, ["BOOLEAN_BODY_CONSUMED"]);
    assert_eq!(r.notes[0].severity(), "warning");
    // An intersect with a tool containing the target gives the target itself, reported
    // `modified` (SPEC §6.0.3 intersects every target; review round 4: the oracle reports
    // every non-empty intersection so); one missing it consumes it.
    let r = run(
        BodyOp::Intersect,
        &[
            ob(aabox("t1", [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]), "t1", 0),
            ob(aabox("t2", [20.0, 0.0, 0.0], [22.0, 2.0, 2.0]), "t2", 1),
        ],
        &[ob(aabox("k", [0.0, 0.0, 0.0], [5.0, 3.0, 3.0]), "k", 3)],
    );
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].origin, origin("t1"));
    assert_eq!(r.bodies[0].change, BodyChange::Modified);
    assert!(close(metrics(&r)[0].0, 1.0));
    assert!(r.untouched.is_empty());
    assert_eq!(r.removed, vec![origin("t2")]);
}

/// A target intersected with two overlapping tools is intersected with their union; with
/// two disjoint tools it splits.
#[test]
fn multi_tool_intersections() {
    let t = || ob(aabox("t", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]), "t", 0);
    let k1 = ob(aabox("k1", [-1.0, -1.0, 1.0], [2.0, 5.0, 3.0]), "k1", 1);
    let k2 = ob(aabox("k2", [1.0, 1.0, -1.0], [5.0, 2.0, 5.0]), "k2", 2);
    let r = run(BodyOp::Intersect, &[t()], &[k1.clone(), k2.clone()]);
    let m = metrics(&r);
    assert_eq!(m.len(), 1);
    assert!(close(m[0].0, 16.0 + 12.0 - 2.0), "{m:?}");
    let swapped = run(BodyOp::Intersect, &[t()], &[k2, k1]);
    assert_eq!(
        format!("{:?}", swapped.bodies[0].body),
        format!("{:?}", r.bodies[0].body)
    );
    // Disjoint tools: two pieces, one origin, BOOLEAN_SPLIT.
    let r = run(
        BodyOp::Intersect,
        &[t()],
        &[
            ob(aabox("k1", [-1.0, -1.0, -1.0], [1.0, 5.0, 5.0]), "k1", 1),
            ob(aabox("k2", [3.0, -1.0, -1.0], [5.0, 5.0, 5.0]), "k2", 2),
        ],
    );
    let m = metrics(&r);
    assert_eq!(m.len(), 2);
    assert!(close(m[0].0, 16.0) && close(m[1].0, 16.0), "{m:?}");
    assert_eq!(r.splits, vec![(origin("t"), 2)]);
    // Canonical order: the piece at x ≈ 0.5 first.
    assert!(centroid(&r.bodies[0].body)[0] < centroid(&r.bodies[1].body)[0]);
}

/// Tools whose union touches itself along an edge or at a point give a non-manifold
/// intersection (the cut with the same tools already failed so).
#[test]
fn multi_tool_intersections_that_touch_themselves_are_non_manifold() {
    let t = || ob(aabox("t", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]), "t", 0);
    for (a, b, kind) in [
        (
            ([-1.0, -1.0, -1.0], [2.0, 2.0, 5.0]),
            ([2.0, 2.0, -1.0], [5.0, 5.0, 5.0]),
            "edge",
        ),
        (
            ([-1.0, -1.0, -1.0], [2.0, 2.0, 2.0]),
            ([2.0, 2.0, 2.0], [5.0, 5.0, 5.0]),
            "vertex",
        ),
    ] {
        let tools = [
            ob(aabox("k1", a.0, a.1), "k1", 1),
            ob(aabox("k2", b.0, b.1), "k2", 2),
        ];
        for op in [BodyOp::Intersect, BodyOp::Cut] {
            let e = apply_body_op(op, &[t()], &tools, "g").expect_err("non-manifold");
            assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{op:?} {kind}: {e}");
            let d = serde_json::to_value(e.details()).expect("details");
            if op == BodyOp::Intersect {
                assert_eq!(d["probe"]["kind"], kind, "{d}");
            }
        }
    }
}

/// SPEC §6.0.3: the join is the connected components of T ∪ K, whatever the order of the
/// operands; a target overlapping another target joins its component.
#[test]
fn join_components_do_not_depend_on_operand_order() {
    let t0 = ob(aabox("t0", [0.0, 0.0, 0.0], [2.0, 2.0, 2.0]), "t0", 0);
    let t1 = ob(aabox("t1", [1.0, 0.0, 0.0], [3.0, 2.0, 2.0]), "t1", 1);
    let k = ob(aabox("k", [2.5, 0.5, 0.5], [4.5, 1.5, 1.5]), "k", 2);
    let mut reference: Option<String> = None;
    for ts in [[t0.clone(), t1.clone()], [t1.clone(), t0.clone()]] {
        let r = run(BodyOp::Join, &ts, std::slice::from_ref(&k));
        let m = metrics(&r);
        assert_eq!(m.len(), 1, "{m:?}");
        assert!(close(m[0].0, 13.5), "{m:?}");
        assert_eq!(r.bodies[0].origin, origin("t0"));
        assert_eq!(r.merged_into, vec![(origin("t1"), origin("t0"))]);
        assert!(r.untouched.is_empty());
        let s = format!("{:?}", r.bodies[0].body);
        match &reference {
            None => reference = Some(s),
            Some(x) => assert_eq!(&s, x, "target order changed the result"),
        }
    }
    // A tool that only overlaps another tool is detached from the targets, in either order
    // (SPEC: "a tool that neither overlaps nor shares a face … with any target").
    let target = ob(aabox("t", [0.0, 0.0, 0.0], [2.0, 2.0, 2.0]), "t", 0);
    let k1 = ob(aabox("k1", [1.5, 0.5, 0.5], [3.5, 1.5, 1.5]), "k1", 1);
    let k2 = ob(aabox("k2", [3.0, 0.5, 0.5], [5.0, 1.5, 1.5]), "k2", 2);
    for ks in [[k1.clone(), k2.clone()], [k2.clone(), k1.clone()]] {
        let e = apply_body_op(BodyOp::Join, std::slice::from_ref(&target), &ks, "g")
            .expect_err("k2 is detached");
        match e {
            BooleanError::NoIntersection { tool, min_distance } => {
                assert_eq!(tool, origin("k2"));
                assert!((min_distance - 1.0).abs() < 1e-9, "{min_distance}");
            }
            other => panic!("{} {other}", other.code()),
        }
    }
    // Two tools on one target, any order: identical bodies.
    let k3 = ob(aabox("k3", [-1.0, 0.5, 0.5], [0.5, 1.5, 1.5]), "k3", 3);
    let a = run(
        BodyOp::Join,
        std::slice::from_ref(&target),
        &[k1.clone(), k3.clone()],
    );
    let b = run(BodyOp::Join, std::slice::from_ref(&target), &[k3, k1]);
    assert_eq!(
        format!("{:?}", a.bodies[0].body),
        format!("{:?}", b.bodies[0].body)
    );
    assert!(
        close(metrics(&a)[0].0, 8.0 + 1.5 + 1.0),
        "{:?}",
        metrics(&a)
    );
}

/// Contacts along an edge or at a point between join components (review round 3): one
/// that a tool creates makes T ∪ K non-manifold; one between two targets existed before the
/// operation (they were separate bodies touching) and is left as it was, whether or not a
/// tool modifies one of them elsewhere — as a cut treats targets one by one.
#[test]
fn join_contacts_between_components() {
    let ta = ob(aabox("ta", [0.0, 0.0, 0.0], [2.0, 2.0, 2.0]), "ta", 0);
    let tb = ob(aabox("tb", [3.0, 0.0, 0.0], [5.0, 2.0, 2.0]), "tb", 1);
    let k = ob(aabox("k", [1.0, 0.5, 0.5], [4.0, 1.5, 1.5]), "k", 3);
    // tc touches tb along the edge x = 5, y = 2 (before and after the join).
    let tc = ob(aabox("tc", [5.0, 2.0, 0.0], [7.0, 4.0, 2.0]), "tc", 2);
    let r = run(
        BodyOp::Join,
        &[ta.clone(), tb.clone(), tc.clone()],
        std::slice::from_ref(&k),
    );
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.merged_into, vec![(origin("tb"), origin("ta"))]);
    assert_eq!(r.untouched, vec![origin("tc")]);
    assert!(close(metrics(&r)[0].0, 8.0 + 8.0 + 1.0));
    // The reviewer's configuration: t1 and t2 touch along an edge; a tool modifies t1 far
    // from it. The join succeeds (the cut already did).
    let t1 = ob(aabox("t1", [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]), "t1", 0);
    let t2 = ob(aabox("t2", [1.0, 1.0, 0.0], [2.0, 2.0, 1.0]), "t2", 1);
    let kk = ob(aabox("kk", [-0.5, 0.0, 0.0], [0.5, 1.0, 1.0]), "kk", 2);
    let r = run(
        BodyOp::Join,
        &[t1.clone(), t2.clone()],
        std::slice::from_ref(&kk),
    );
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.untouched, vec![origin("t2")]);
    assert!(close(metrics(&r)[0].0, 1.5));
    let r = run(BodyOp::Cut, &[t1, t2], std::slice::from_ref(&kk));
    assert!(close(metrics(&r)[0].0, 0.5));
    // A tool that overlaps ta and touches the target tc along an edge (x = 5, y = 2)
    // creates that contact: non-manifold.
    let k5 = ob(aabox("k5", [1.0, 0.5, 0.5], [5.0, 2.0, 1.5]), "k5", 3);
    let e = apply_body_op(
        BodyOp::Join,
        &[ta.clone(), tc.clone()],
        std::slice::from_ref(&k5),
        "g",
    )
    .expect_err("k5 touches tc along an edge");
    assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{e}");
    let d = serde_json::to_value(e.details()).expect("details");
    assert_eq!(d["probe"]["kind"], "edge", "{d}");
    // td and te touch each other along an edge, far from the tool: untouched both.
    let td = ob(aabox("td", [20.0, 0.0, 0.0], [22.0, 2.0, 2.0]), "td", 4);
    let te = ob(aabox("te", [22.0, 2.0, 0.0], [24.0, 4.0, 2.0]), "te", 5);
    let r = run(BodyOp::Join, &[ta, tb, td, te], std::slice::from_ref(&k));
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.merged_into, vec![(origin("tb"), origin("ta"))]);
    assert_eq!(r.untouched, vec![origin("td"), origin("te")]);
    assert!(close(metrics(&r)[0].0, 8.0 + 8.0 + 1.0));
}

/// Empty operand lists are an explicit error for every operation (a `card: any` reference
/// that resolved to nothing), never a panic.
#[test]
fn empty_operand_lists_are_errors() {
    let b = || ob(aabox("a", [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]), "a", 0);
    for op in [BodyOp::Join, BodyOp::Cut, BodyOp::Intersect] {
        for (targets, tools, role) in [
            (vec![], vec![b()], "targets"),
            (vec![b()], vec![], "tools"),
            (vec![], vec![], "targets"),
        ] {
            let e = apply_body_op(op, &targets, &tools, "g").expect_err("empty");
            assert_eq!(e.code(), "FORGE_BOOLEAN_NO_OPERANDS", "{op:?}");
            let d = serde_json::to_value(e.details()).expect("details");
            assert_eq!(d["role"], role, "{op:?}");
        }
    }
}

/// `BOOLEAN_TOOL_IS_TARGET` compares bodies, not origins: two pieces of one split body share
/// an origin and may be target and tool.
#[test]
fn tool_is_target_compares_bodies() {
    let split = run(
        BodyOp::Cut,
        &[ob(aabox("a", [0.0, 0.0, 0.0], [6.0, 2.0, 2.0]), "a", 0)],
        &[ob(aabox("k", [2.0, -1.0, -1.0], [4.0, 3.0, 3.0]), "k", 1)],
    );
    assert_eq!(split.bodies.len(), 2);
    let piece = |i: usize| OpBody {
        body: split.bodies[i].body.clone(),
        origin: split.bodies[i].origin.clone(),
        timeline: 0,
    };
    // Different pieces: an ordinary (disjoint) join attempt, not TOOL_IS_TARGET.
    let e = apply_body_op(BodyOp::Join, &[piece(0)], &[piece(1)], "g").expect_err("disjoint");
    assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION");
    // The same piece twice.
    let e = apply_body_op(BodyOp::Join, &[piece(0)], &[piece(0)], "g").expect_err("same");
    assert_eq!(e.code(), "BOOLEAN_TOOL_IS_TARGET");
}

/// `min_distance` is 0 whenever the tool touches a target (known exactly from the
/// intersection), including a sphere resting on a face, which has no vertex or edge near
/// the contact; otherwise the distance between the nearest features.
#[test]
fn min_distance_of_detached_tools() {
    let t = || ob(aabox("t", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]), "t", 0);
    for (z, want) in [(5.0, 0.0), (5.5, 0.5), (6.25, 1.25)] {
        let s = ob(sphere("k", [2.0, 1.5, z], 1.0), "k", 1);
        let e = apply_body_op(BodyOp::Join, &[t()], std::slice::from_ref(&s), "g")
            .expect_err("detached");
        match e {
            BooleanError::NoIntersection { min_distance, .. } => {
                assert!((min_distance - want).abs() < 1e-9, "z={z}: {min_distance}")
            }
            other => panic!("{} {other}", other.code()),
        }
        let e = apply_body_op(BodyOp::Cut, &[t()], &[s], "g").expect_err("detached");
        match e {
            BooleanError::NoIntersection { min_distance, .. } => {
                assert!((min_distance - want).abs() < 1e-9, "z={z}: {min_distance}")
            }
            other => panic!("{} {other}", other.code()),
        }
    }
    // Cut reports the closest of several tools.
    let far = ob(aabox("far", [10.0, 0.0, 0.0], [11.0, 1.0, 1.0]), "far", 1);
    let near = ob(aabox("near", [0.0, 0.0, 4.25], [1.0, 1.0, 5.0]), "near", 2);
    let e = apply_body_op(BodyOp::Cut, &[t()], &[far, near], "g").expect_err("detached");
    match e {
        BooleanError::NoIntersection { tool, min_distance } => {
            assert_eq!(tool, origin("near"));
            assert!((min_distance - 0.25).abs() < 1e-9, "{min_distance}");
        }
        other => panic!("{} {other}", other.code()),
    }
}

/// SPEC §5.4: pieces of one origin are ordered by their exact centroid (not the centre of
/// their box), lexicographically with tolerance `LINEAR_TOLERANCE·s`.
#[test]
fn split_pieces_are_ordered_by_centroid_with_tolerance() {
    // An L-shaped piece (box centre x = 5, centroid x ≈ 2.87) and a small square (x = 4):
    // centroid order puts the L first, box-centre order the square.
    let plate = ob(aabox("p", [0.0, 0.0, 0.0], [10.0, 10.0, 1.0]), "p", 0);
    let tools = [
        ob(aabox("k1", [1.0, 1.0, -1.0], [11.0, 3.5, 2.0]), "k1", 1),
        ob(aabox("k2", [1.0, 4.5, -1.0], [11.0, 11.0, 2.0]), "k2", 2),
        ob(aabox("k3", [1.0, 3.0, -1.0], [3.5, 5.0, 2.0]), "k3", 3),
        ob(aabox("k4", [4.5, 3.0, -1.0], [11.0, 5.0, 2.0]), "k4", 4),
    ];
    let r = run(BodyOp::Cut, &[plate], &tools);
    let m = metrics(&r);
    assert_eq!(m.len(), 2, "{m:?}");
    assert!(close(m[0].0, 19.0) && close(m[1].0, 1.0), "L first: {m:?}");
    // A tie in x within the tolerance (a notch moves one piece's centroid by 1.2e-7): y
    // decides, although an exact comparison would put the other piece first.
    let bar = ob(aabox("b", [0.0, 0.0, 0.0], [2.0, 10.0, 1.0]), "b", 0);
    let tools = [
        ob(aabox("k1", [-1.0, 4.0, -1.0], [3.0, 6.0, 2.0]), "k1", 1),
        ob(
            aabox("k2", [-1.0, -1.0, -1.0], [0.001, 0.001, 2.0]),
            "k2",
            2,
        ),
    ];
    let r = run(BodyOp::Cut, &[bar], &tools);
    assert_eq!(r.bodies.len(), 2);
    let (c0, c1) = (centroid(&r.bodies[0].body), centroid(&r.bodies[1].body));
    assert!(c0[0] > c1[0] && c0[0] - c1[0] < 1e-6, "{c0:?} {c1:?}");
    assert!(c0[1] < c1[1], "the lower piece first: {c0:?} {c1:?}");
    // The scope scale of SPEC §5.4 (`apply_body_op_in_scope`, review round 3): a notch
    // moving the lower piece's centroid by ~3.1e-6 in x is a tie at the operands' scale (the
    // tolerance 1e-6·s with s ≈ 13), not at a scope scale of 1 (tolerance 1e-6): then x
    // decides and the upper piece comes first.
    let bar = || ob(aabox("b", [0.0, 0.0, 0.0], [2.0, 10.0, 1.0]), "b", 0);
    let tools = [
        ob(aabox("k1", [-1.0, 4.0, -1.0], [3.0, 6.0, 2.0]), "k1", 1),
        ob(
            aabox("k2", [-1.0, -1.0, -1.0], [0.005, 0.005, 2.0]),
            "k2",
            2,
        ),
    ];
    let r = run(BodyOp::Cut, &[bar()], &tools);
    let (c0, c1) = (centroid(&r.bodies[0].body), centroid(&r.bodies[1].body));
    assert!(c0[0] > c1[0] && c0[0] - c1[0] < 1e-5, "{c0:?} {c1:?}");
    assert!(
        c0[1] < c1[1],
        "operand scale: the lower piece first: {c0:?} {c1:?}"
    );
    let r =
        forge_ops::apply_body_op_in_scope(BodyOp::Cut, &[bar()], &tools, "g", 1.0).expect("cut");
    let (c0, c1) = (centroid(&r.bodies[0].body), centroid(&r.bodies[1].body));
    assert!(c0[0] < c1[0], "scope scale 1: x decides: {c0:?} {c1:?}");
}

/// SPEC §5.2 rule 3: split pieces share their keys; new edges and vertices are
/// `g/edge:{…}` and `g/vertex:{…}`; merged faces and edges keep the target's keys, the
/// tool's become aliases.
#[test]
fn keys_of_split_merged_and_new_entities() {
    // A through cut: both pieces keep a/cap:start and a/cap:end (shared keys).
    let r = run(
        BodyOp::Cut,
        &[ob(aabox("a", [0.0, 0.0, 0.0], [6.0, 2.0, 2.0]), "a", 0)],
        &[ob(aabox("k", [2.0, -1.0, -1.0], [4.0, 3.0, 3.0]), "k", 1)],
    );
    for b in &r.bodies {
        let keys = face_keys(&b.body);
        assert!(keys.contains(&"a/cap:start@m".to_string()), "{keys:?}");
        assert!(keys.contains(&"a/cap:end@m".to_string()), "{keys:?}");
        assert!(
            key_problems(&b.body, &r.aliases).is_empty(),
            "{:?}",
            key_problems(&b.body, &r.aliases)
        );
    }
    // A corner cut: new vertices where the tool's edges pierce the target's faces.
    let r = run(
        BodyOp::Cut,
        &[ob(aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]), "a", 0)],
        &[ob(aabox("k", [3.0, 3.0, 3.0], [5.0, 5.0, 5.0]), "k", 1)],
    );
    let body = &r.bodies[0].body;
    let new_vertices: Vec<String> = body
        .vertices()
        .iter()
        .map(|(_, v)| v.provenance.name())
        .filter(|k| k.starts_with("g/vertex:{"))
        .collect();
    // Six: the tool's three edges from its corner (3,3,3) pierce the target's faces, and
    // the target's three edges at (4,4,4) pierce the tool's faces. The tool's corner keeps
    // the tool's key. Each new vertex has three faces around it.
    assert_eq!(new_vertices.len(), 6, "{new_vertices:?}");
    for k in &new_vertices {
        assert_eq!(k.matches('|').count(), 2, "three faces around {k}");
    }
    assert!(
        body.vertices()
            .iter()
            .any(|(_, v)| v.provenance.name().starts_with("k/")),
        "the tool's corner keeps its key"
    );
    // Two section edges on each of the three target faces around the removed corner.
    let section: Vec<String> = body
        .edges()
        .iter()
        .map(|(_, e)| e.provenance.name())
        .filter(|k| k.starts_with("g/edge:{"))
        .collect();
    assert_eq!(section.len(), 6, "{section:?}");
    assert!(
        section
            .iter()
            .all(|k| k.contains("{a/") && k.contains("|k/")),
        "{section:?}"
    );
    // Flush boxes side by side: the merged top keeps a/cap:end, the merged top-front edge
    // keeps the target's key; the tool's keys become aliases.
    let r = run(
        BodyOp::Join,
        &[ob(aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 2.0]), "a", 0)],
        &[ob(aabox("b", [4.0, 0.0, 0.0], [6.0, 4.0, 2.0]), "b", 1)],
    );
    let m = metrics(&r);
    assert_eq!((m[0].2, m[0].3), (6, 12), "{m:?}");
    let has = |from: &str, to: &str| r.aliases.iter().any(|(f, t)| f == from && t == to);
    assert!(has("b/cap:end@m", "a/cap:end@m"), "{:?}", r.aliases);
    assert!(has("b/side:b", "a/side:b"), "{:?}", r.aliases);
    let edges = edge_keys(&r.bodies[0].body);
    assert!(edges.contains("a/edge:{a/cap:end@m|a/side:b}"), "{edges:?}");
    assert!(
        has(
            "b/edge:{b/cap:end@m|b/side:b}",
            "a/edge:{a/cap:end@m|a/side:b}"
        ),
        "{:?}",
        r.aliases
    );
    assert!(
        key_problems(&r.bodies[0].body, &r.aliases).is_empty(),
        "{:?}",
        key_problems(&r.bodies[0].body, &r.aliases)
    );
    // Intersect with two coplanar-adjacent tools: the tools' union merges their shared
    // side planes; those aliases are reported too.
    let r = run(
        BodyOp::Intersect,
        &[ob(aabox("p", [0.0, 0.0, 0.0], [8.0, 4.0, 1.0]), "p", 0)],
        &[
            ob(aabox("u1", [-1.0, 1.0, -1.0], [4.0, 3.0, 2.0]), "u1", 1),
            ob(aabox("u2", [4.0, 1.0, -1.0], [9.0, 3.0, 2.0]), "u2", 2),
        ],
    );
    assert!(close(metrics(&r)[0].0, 16.0));
    assert!(has_alias(&r, "u2/side:b", "u1/side:b"), "{:?}", r.aliases);
}

fn has_alias(r: &BodyOpResult, from: &str, to: &str) -> bool {
    r.aliases.iter().any(|(f, t)| f == from && t == to)
}

/// The bodies of a multi-region extrude (one per region, SPEC §4.5), each with its origin
/// `(feature, smallest outer curve id)`: squares of side `w` at the given lower-left
/// corners (curve ids `<prefix>1..4` per square), from `z0` up by `h`.
fn region_bodies(
    feature: &str,
    corners: &[(&str, [f64; 2])],
    w: f64,
    z0: f64,
    h: f64,
) -> Vec<OpBody> {
    let mut curves = Vec::new();
    for (p, [x, y]) in corners {
        curves.push(line(&format!("{p}1"), [*x, *y], [x + w, *y]));
        curves.push(line(&format!("{p}2"), [x + w, *y], [x + w, y + w]));
        curves.push(line(&format!("{p}3"), [x + w, y + w], [*x, y + w]));
        curves.push(line(&format!("{p}4"), [*x, y + w], [*x, *y]));
    }
    let sk = forge_ir::SketchFeature {
        id: format!("s_{feature}"),
        name: format!("s_{feature}"),
        suppressed: false,
        plane: plane_z(z0),
        curves,
    };
    let frame = forge_ops::sketch_frame(&sk.plane).expect("frame");
    let regions = forge_ops::regions(&sk, &forge_core::Tolerance::IR_DEFAULT).expect("regions");
    assert_eq!(regions.len(), corners.len());
    regions
        .iter()
        .map(|r| {
            let member = r.outer_curves.iter().min().expect("outer curves").clone();
            OpBody {
                body: forge_ops::extrude(r, &frame, h, SweepDirection::Normal, feature)
                    .expect("extrude"),
                origin: Origin {
                    feature: feature.into(),
                    member,
                    instance: None,
                },
                timeline: 0,
            }
        })
        .collect()
}

/// Review round 3: keys, not display names, decide which merged entity survives and what
/// becomes an alias. The two regions of one extrude are two bodies whose caps share the
/// display name `e1/cap:end` but not the key (`@a1`, `@b1`); a flush tool bridging them
/// joins both (targets) into one body whose top is one face: `e1/cap:end@a1` survives and
/// `e1/cap:end@b1` (and the tool's cap) become its aliases. A second flush join keeps every
/// key complete, and every source resolvable.
#[test]
fn merges_decide_by_key_and_alias_every_merged_key() {
    let targets = region_bodies("e1", &[("a", [0.0, 0.0]), ("b", [4.0, 0.0])], 2.0, 0.0, 1.0);
    assert_eq!(targets[0].origin.member, "a1");
    assert_eq!(targets[1].origin.member, "b1");
    let bridge = ob(aabox("k", [1.0, 0.5, 0.0], [5.0, 1.5, 1.0]), "k", 1);
    let r = run(BodyOp::Join, &targets, std::slice::from_ref(&bridge));
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.merged_into.len(), 1);
    assert!(close(metrics(&r)[0].0, 2.0 * 4.0 + 2.0 * 1.0));
    let has = |from: &str, to: &str| r.aliases.iter().any(|(f, t)| f == from && t == to);
    assert!(has("e1/cap:end@b1", "e1/cap:end@a1"), "{:?}", r.aliases);
    assert!(has("e1/cap:start@b1", "e1/cap:start@a1"), "{:?}", r.aliases);
    assert!(has("k/cap:end@m", "e1/cap:end@a1"), "{:?}", r.aliases);
    let body = &r.bodies[0].body;
    let faces = face_keys(body);
    assert!(faces.contains(&"e1/cap:end@a1".to_string()), "{faces:?}");
    assert!(!faces.contains(&"e1/cap:end@b1".to_string()), "{faces:?}");
    assert!(
        key_problems(body, &r.aliases).is_empty(),
        "{:?}",
        key_problems(body, &r.aliases)
    );
    // Edges of the merged-away cap keep their keys (they were not modified): their source
    // is the alias `e1/cap:end@b1`.
    let edges = edge_keys(body);
    assert!(
        edges.contains("e1/edge:{e1/cap:end@b1|e1/side:b2}"),
        "{edges:?}"
    );
    // A second flush join on the result.
    let next = ob(body.clone(), "e1", 0);
    let next = OpBody {
        origin: targets[0].origin.clone(),
        ..next
    };
    let r2 = run(
        BodyOp::Join,
        &[next],
        &[ob(aabox("k2", [0.5, 1.5, 0.0], [1.5, 3.0, 1.0]), "k2", 2)],
    );
    let mut all_aliases = r.aliases.clone();
    all_aliases.extend(r2.aliases.iter().cloned());
    let b2 = &r2.bodies[0].body;
    assert!(
        key_problems(b2, &all_aliases).is_empty(),
        "{:?}",
        key_problems(b2, &all_aliases)
    );
    assert!(
        r2.aliases
            .iter()
            .any(|(f, t)| f == "k2/cap:end@m" && t == "e1/cap:end@a1"),
        "{:?}",
        r2.aliases
    );
}

/// Review round 3: the caps of a multi-region sweep's bodies joined into another body carry
/// their body member (SPEC §5.2 rules 1 and 4, stamped by the boolean): two bosses from one
/// sketch keep distinct keys `e2/cap:end@a1` and `e2/cap:end@b1`.
#[test]
fn caps_of_multi_region_tools_keep_their_member_in_the_target() {
    let plate = ob(aabox("p", [0.0, 0.0, 0.0], [10.0, 4.0, 1.0]), "p", 0);
    let bosses = region_bodies("e2", &[("a", [1.0, 1.0]), ("b", [6.0, 1.0])], 2.0, 1.0, 1.5);
    let tools: Vec<OpBody> = bosses
        .into_iter()
        .map(|mut b| {
            b.timeline = 1;
            b
        })
        .collect();
    let r = run(BodyOp::Join, &[plate], &tools);
    assert_eq!(r.bodies.len(), 1);
    assert!(close(metrics(&r)[0].0, 40.0 + 2.0 * 4.0 * 1.5));
    let body = &r.bodies[0].body;
    let faces = face_keys(body);
    for k in [
        "e2/cap:end@a1",
        "e2/cap:end@b1",
        "p/cap:end@m",
        "p/cap:start@m",
    ] {
        assert!(faces.contains(&k.to_string()), "{k} not in {faces:?}");
    }
    assert!(
        key_problems(body, &r.aliases).is_empty(),
        "{:?}",
        key_problems(body, &r.aliases)
    );
    // The bosses' bottom rims now lie between the plate's top and the bosses' sides: new
    // edges of the operation, keyed by those faces.
    let edges = edge_keys(body);
    assert!(
        edges.contains("g/edge:{e2/side:a1|p/cap:end@m}"),
        "{edges:?}"
    );
    assert!(
        edges.contains("g/edge:{e2/side:b1|p/cap:end@m}"),
        "{edges:?}"
    );
    // The bosses' top rims were not modified: their keys name the stamped caps.
    assert!(
        edges.contains("e2/edge:{e2/cap:end@a1|e2/side:a1}"),
        "{edges:?}"
    );
    assert!(
        edges.contains("e2/edge:{e2/cap:end@b1|e2/side:b1}"),
        "{edges:?}"
    );
}
