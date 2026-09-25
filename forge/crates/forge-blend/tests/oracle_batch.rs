//! Batch writer for the OCCT differential of fillet / chamfer / shell
//! (`forge-blend/oracle/occt_blend_diff.py`).
//!
//! ```text
//! BLEND_BATCH_OUT=/tmp/blend17.jsonl BLEND_SEED=17 BLEND_COUNT=400 BLEND_CURVED=60 \
//!   BLEND_SEQ=100 BLEND_ADV=120 \
//!   cargo test --release -p forge-blend --test oracle_batch write_blend_oracle_batch -- --ignored --nocapture
//! ```
//!
//! The corpus: the core families, the curved ones (`BLEND_CURVED`), the maker **sequences**
//! (`BLEND_SEQ`: fillet → shell, fillet → fillet, chamfer → shell — each case's earlier blends
//! recorded with their edge probes and Forge's result, so the oracle replays them with OCCT;
//! with the family's closed form where it has one) and the **adversarial** parts
//! (`BLEND_ADV`: star prisms, tilted wedges, V-grooves, ribs); W6 review round 4.
//!
//! One JSON line per corpus case: the base as IR v0 operands with the booleans that
//! combine them (the oracle rebuilds them with its own evaluator and `BRepAlgoAPI`), the
//! operation, the selected edges (probe = the point at the edge's middle parameter, and
//! its curve type) or open faces (probe = an interior point), the chamfer `side` face, and
//! Forge's outcome: status, code, details, exact metrics (forge-check); for a value that
//! is too large, also the metrics at `max_feasible_*` so that the oracle can confirm it.

mod common;

use std::io::Write;
use std::time::Instant;

use common::corpus::{
    Case, CaseOp, ClosedForm, adv_cases, cases, curved_cases, edge_mid, select_edges,
    select_edges_by, select_faces, seq_cases,
};
use forge_blend::{
    BlendError, BlendOptions, ChamferSpec, ShellDirection, ShellOptions, chamfer, fillet, shell,
};
use forge_core::linalg::Point3;
use forge_core::topo::{Body, EdgeId, FaceId};
use serde_json::{Value, json};

/// Forge's own certified self-intersection verdict on a result (an independent check of the
/// construction's: `forge_check::validate` does not see a body passing through itself).
fn interference(b: &Body, id: &str) -> Value {
    let t0 = Instant::now();
    let verdict = match forge_blend::self_intersections(b) {
        Ok(v) if v.is_empty() => "clear".to_string(),
        Ok(v) => format!("hit: {} face pair(s)", v.len()),
        Err(e) => format!("unverified: {e}"),
    };
    let ms = t0.elapsed().as_secs_f64() * 1e3;
    if ms > 20_000.0 {
        eprintln!("slow self-intersection check: {id}: {ms:.0} ms");
    }
    json!(verdict)
}

fn metrics(b: &Body) -> Value {
    let valid = forge_check::validate(b)
        .iter()
        .all(|i| i.severity != forge_core::topo::Severity::Error);
    match forge_check::body_metrics(b) {
        Ok(m) => json!({
            "volume": m.volume, "area": m.area, "centroid": m.centroid,
            "bbox_min": m.bbox_min, "bbox_max": m.bbox_max,
            "faces": m.faces, "edges": m.edges, "shells": b.shell_ids().len(),
            "face_types": m.face_types, "edge_types": m.edge_types, "valid": valid,
        }),
        Err(e) => json!({ "metrics_error": e.to_string(), "valid": false }),
    }
}

/// The corner patches of a result: key, surface type, and whether the corner is the
/// normative one (SPEC §6.6: a sphere where three faces of the input meet at right angles;
/// every other corner patch is engine-defined, §8.3 rule 5).
fn corners(base: &Body, out: &Body) -> Value {
    let keys = forge_blend::KeyMap::derive(base);
    let mut v = Vec::new();
    for (_, f) in out.faces().iter() {
        if f.provenance.role != forge_core::topo::Role::Derived("corner".into()) {
            continue;
        }
        let key = f.provenance.key();
        let src = f.provenance.sources.first().cloned().unwrap_or_default();
        let vertex = base
            .vertices()
            .iter()
            .map(|(id, _)| id)
            .find(|&id| keys.vertex(id).is_some_and(|n| n.key == src));
        let normals: Vec<forge_core::linalg::Vec3> = vertex
            .map(|vid| {
                let mut fs: Vec<forge_core::topo::FaceId> = Vec::new();
                for (eid, e) in base.edges().iter() {
                    if e.start == Some(vid) || e.end == Some(vid) {
                        for x in base.edge_faces(eid) {
                            if !fs.contains(&x) {
                                fs.push(x);
                            }
                        }
                    }
                }
                fs.iter()
                    .filter_map(|&x| match &base.face(x).expect("face").surface {
                        forge_core::geom::Surface::Plane(p) => Some(p.frame().z()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Recorded for reference only: the oracle decides normativity itself (SPEC §8.3
        // rule 5, ANGULAR_TOLERANCE) from the base's geometry at `at`.
        // SPEC §8.3 rule 3's test, as Forge and the oracle apply it (W6 review round 6).
        let perpendicular = normals.len() == 3
            && (0..3).all(|i| {
                ((i + 1)..3)
                    .all(|j| normals[i].dot(normals[j]).abs() <= forge_ir::v1::ANGULAR_TOLERANCE)
            });
        let at = vertex.map(|vid| p3(base.vertex(vid).expect("vertex").point));
        let kind = f.surface.kind_name();
        v.push(json!({ "key": key, "surface": kind, "at": at,
                       "forge_normative": kind == "sphere" && perpendicular }));
    }
    Value::Array(v)
}

fn p3(p: Point3) -> Value {
    json!([p.x, p.y, p.z])
}

/// A point inside a planar face, 1e-3 mm in from the middle of its first edge.
fn face_probe(b: &Body, f: FaceId) -> Point3 {
    let face = b.face(f).expect("face");
    let lp = b.loop_(face.loops[0]).expect("loop");
    let c = b.coedge(lp.coedges[0]).expect("coedge");
    let e = b.edge(c.edge).expect("edge");
    let t = 0.5 * (e.t_range.0 + e.t_range.1);
    let p = e.curve.eval(t);
    let d = e.curve.d1(t).normalize().expect("tangent");
    let d = if c.forward { d } else { -d };
    let (u, v, _) = face.surface.project(p);
    let n = face.surface.normal(u, v).expect("normal");
    let n = if face.sense { n } else { -n };
    let inward = n.cross(d).normalize().expect("inward");
    p + inward * 1e-3
}

fn run_op(
    case: &Case,
    b: &Body,
    edges: &[EdgeId],
    faces: &[FaceId],
    side: Option<FaceId>,
    v: Option<f64>,
) -> Result<(Body, Value), BlendError> {
    let opts = BlendOptions::new("f1");
    let edges = &forge_blend::pick_edges(b, 0, edges);
    let faces = &forge_blend::pick_faces(b, 0, faces);
    let side = side.map(|s| forge_blend::pick_faces(b, 0, &[s]).remove(0));
    match case.op {
        CaseOp::Fillet { r } => fillet(b, edges, v.unwrap_or(r), &opts)
            .map(|o| (o.body, serde_json::to_value(&o.report).expect("report"))),
        CaseOp::Chamfer { d } => {
            chamfer(b, edges, &ChamferSpec::Equal { d: v.unwrap_or(d) }, &opts)
                .map(|o| (o.body, serde_json::to_value(&o.report).expect("report")))
        }
        CaseOp::Chamfer2 { d, d2 } => chamfer(
            b,
            edges,
            &ChamferSpec::TwoDistances {
                d: v.unwrap_or(d),
                // At the suggested value both distances scale together.
                d2: v.map_or(d2, |m| forge_blend::round_down_mm(d2 * (m / d))),
                side: side.clone().expect("side"),
            },
            &opts,
        )
        .map(|o| (o.body, serde_json::to_value(&o.report).expect("report"))),
        CaseOp::ChamferAngle { d, angle } => chamfer(
            b,
            edges,
            &ChamferSpec::DistanceAngle {
                d: v.unwrap_or(d),
                angle_deg: angle,
                side: side.clone().expect("side"),
            },
            &opts,
        )
        .map(|o| (o.body, serde_json::to_value(&o.report).expect("report"))),
        CaseOp::Shell { t, outward } => shell(
            b,
            faces,
            v.unwrap_or(t),
            if outward {
                ShellDirection::Outward
            } else {
                ShellDirection::Inward
            },
            &ShellOptions::new("sh1"),
        )
        .map(|o| (o.body, serde_json::to_value(&o.report).expect("report"))),
    }
}

fn closed_json(c: ClosedForm) -> Value {
    match c {
        ClosedForm::Enclosure { a, b, c, rv, rb } => {
            json!({ "kind": "enclosure", "a": a, "b": b, "c": c, "rv": rv, "rb": rb })
        }
        ClosedForm::RoundedBox { a, b, c, r } => {
            json!({ "kind": "rounded_box", "a": a, "b": b, "c": c, "r": r })
        }
    }
}

fn op_json(op: CaseOp) -> Value {
    match op {
        CaseOp::Fillet { r } => json!({ "kind": "fillet", "r": r }),
        CaseOp::Chamfer { d } => json!({ "kind": "chamfer", "d": d }),
        CaseOp::Chamfer2 { d, d2 } => json!({ "kind": "chamfer", "d": d, "d2": d2 }),
        CaseOp::ChamferAngle { d, angle } => json!({ "kind": "chamfer", "d": d, "angle": angle }),
        CaseOp::Shell { t, outward } => {
            json!({ "kind": "shell", "thickness": t, "direction": if outward { "outward" } else { "inward" } })
        }
    }
}

#[test]
#[ignore]
fn write_blend_oracle_batch() {
    let out = std::env::var("BLEND_BATCH_OUT").unwrap_or_else(|_| "blend_batch.jsonl".into());
    let seed: u64 = std::env::var("BLEND_SEED").map_or(17, |s| s.parse().expect("seed"));
    let n: usize = std::env::var("BLEND_COUNT").map_or(400, |s| s.parse().expect("count"));
    // The curved families after the core ones (W6 review round 2): what Forge does not
    // blend yet is measured, not left out.
    let nc: usize = std::env::var("BLEND_CURVED").map_or(60, |s| s.parse().expect("count"));
    // Then the maker sequences and the adversarial parts (W6 review round 4).
    let nq: usize = std::env::var("BLEND_SEQ").map_or(100, |s| s.parse().expect("count"));
    let na: usize = std::env::var("BLEND_ADV").map_or(120, |s| s.parse().expect("count"));
    let only: Option<String> = std::env::var("BLEND_ONLY").ok();
    let mut f = std::fs::File::create(&out).expect("create batch file");
    let mut stats = std::collections::BTreeMap::<String, usize>::new();
    for case in cases(seed, n)
        .into_iter()
        .chain(curved_cases(seed, nc))
        .chain(seq_cases(seed, nq))
        .chain(adv_cases(seed, na))
    {
        if only.as_ref().is_some_and(|o| !case.id.contains(o.as_str())) {
            continue;
        }
        let steps: Vec<Value> = case
            .steps
            .iter()
            .map(|(op, operand)| {
                json!({ "op": op.name(), "doc": serde_json::to_value(operand.document()).expect("doc") })
            })
            .collect();
        let closed = case.closed.map(closed_json);
        // The body the operation applies to: the base, after the sequence's blends.
        let mut base = case.base();
        let mut pre: Vec<Value> = Vec::new();
        let mut pre_failed: Option<(usize, BlendError)> = None;
        for k in 0..case.pre.len() {
            let p = case.pre[k];
            let edges = select_edges_by(p.select, case.pick, &base);
            let probes: Vec<Value> = edges
                .iter()
                .map(|&e| {
                    json!({ "probe": p3(edge_mid(&base, e)),
                            "type": base.edge(e).expect("edge").curve.kind_name() })
                })
                .collect();
            match case.apply_pre(k, &base) {
                Ok((_, next)) => {
                    pre.push(
                        json!({ "op": op_json(p.op), "select": p.select, "edges": probes,
                                     "metrics": metrics(&next) }),
                    );
                    base = next;
                }
                Err(e) => {
                    pre.push(json!({ "op": op_json(p.op), "select": p.select, "edges": probes }));
                    pre_failed = Some((k, e));
                    break;
                }
            }
        }
        if let Some((k, e)) = pre_failed {
            // Forge fails the sequence before the operation: recorded (the oracle runs the
            // same blends with OCCT; an OCCT success is a validity loss).
            *stats.entry(format!("pre:{}", e.code())).or_default() += 1;
            let line = json!({
                "id": case.id, "family": case.family, "select": case.select, "op": op_json(case.op),
                "steps": steps, "edges": [], "faces": [], "side": null, "pre": pre,
                "pre_failed": { "index": k, "code": e.code(), "message": e.to_string() },
                "closed_form": closed, "base": metrics(&base),
                "forge": { "status": "error", "code": e.code(), "message": e.to_string(),
                           "details": e.details() },
                "ms": 0.0,
            });
            writeln!(f, "{line}").expect("write");
            continue;
        }

        let is_shell = matches!(case.op, CaseOp::Shell { .. });
        let mut edges: Vec<EdgeId> = Vec::new();
        let mut faces: Vec<FaceId> = Vec::new();
        let mut side: Option<FaceId> = None;
        if is_shell {
            faces = select_faces(&case, &base);
        } else {
            edges = select_edges(&case, &base);
            if matches!(
                case.op,
                CaseOp::Chamfer2 { .. } | CaseOp::ChamferAngle { .. }
            ) && let Some(&e0) = edges.first()
            {
                // The side: a face of the first edge; keep the edges it bounds.
                let fs = base.edge_faces(e0);
                let s = fs[(case.pick % fs.len() as u64) as usize];
                edges.retain(|&e| base.edge_faces(e).contains(&s));
                side = Some(s);
            }
            if edges.is_empty() {
                *stats.entry("skipped".into()).or_default() += 1;
                continue;
            }
        }
        let t0 = Instant::now();
        let r = run_op(&case, &base, &edges, &faces, side, None);
        let ms = t0.elapsed().as_secs_f64() * 1e3;
        let forge = match r {
            Ok((body, report)) => {
                *stats.entry("ok".into()).or_default() += 1;
                json!({ "status": "ok", "metrics": metrics(&body), "report": report,
                        "corners": corners(&base, &body), "interference": interference(&body, &case.id) })
            }
            Err(e) => {
                *stats.entry(e.code()).or_default() += 1;
                let max = match &e {
                    BlendError::RadiusTooLarge { max_feasible_r, .. } => Some(*max_feasible_r),
                    BlendError::DistanceTooLarge { max_feasible_d, .. } => Some(*max_feasible_d),
                    BlendError::ThicknessTooLarge {
                        max_feasible_thickness,
                        ..
                    } => *max_feasible_thickness,
                    _ => None,
                };
                let value2 = match (&e, case.op) {
                    (
                        BlendError::DistanceTooLarge {
                            d2: Some((_, s)), ..
                        },
                        _,
                    ) => Some(*s),
                    _ => None,
                };
                let at_max = max.map(|m| match run_op(&case, &base, &edges, &faces, side, Some(m)) {
                    Ok((body, report)) => json!({ "value": m, "value2": value2, "status": "ok",
                        "metrics": metrics(&body), "report": report,
                        "corners": corners(&base, &body), "interference": interference(&body, &case.id) }),
                    Err(e2) => json!({ "value": m, "value2": value2, "status": "error", "code": e2.code(), "message": e2.to_string() }),
                });
                json!({ "status": "error", "code": e.code(), "message": e.to_string(),
                        "details": e.details(), "at_max": at_max })
            }
        };
        let edge_probes: Vec<Value> = edges
            .iter()
            .map(|&e| {
                json!({ "probe": p3(edge_mid(&base, e)),
                        "type": base.edge(e).expect("edge").curve.kind_name() })
            })
            .collect();
        let face_probes: Vec<Value> = faces
            .iter()
            .map(|&x| json!({ "probe": p3(face_probe(&base, x)) }))
            .collect();
        let line = json!({
            "id": case.id, "family": case.family, "select": case.select, "op": op_json(case.op),
            "steps": steps, "pre": pre, "closed_form": closed, "edges": edge_probes, "faces": face_probes,
            "side": side.map(|s| json!({ "probe": p3(face_probe(&base, s)) })),
            "base": metrics(&base), "forge": forge, "ms": ms,
        });
        writeln!(f, "{line}").expect("write");
    }
    eprintln!("wrote {out}: {stats:?}");
}

/// The corpus is deterministic and every base builds (a quick guard for CI).
#[test]
fn curved_corpus_bases_build_and_are_valid() {
    let a = curved_cases(5, 9);
    let b = curved_cases(5, 9);
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(x.id, y.id);
        assert_eq!(format!("{:?}", x.op), format!("{:?}", y.op));
    }
    for c in &a {
        let base = c.base();
        common::assert_valid(&base);
        let kinds: Vec<&str> = base
            .faces()
            .iter()
            .map(|(_, f)| f.surface.kind_name())
            .collect();
        match c.family {
            "dflat" => assert!(kinds.contains(&"cylinder") && kinds.contains(&"plane")),
            "sphere" => assert!(kinds.contains(&"sphere"), "{kinds:?}"),
            "cross_hole" => {
                let ek: Vec<&str> = base
                    .edges()
                    .iter()
                    .map(|(_, e)| e.curve.kind_name())
                    .collect();
                assert!(
                    ek.iter().any(|k| *k == "bspline" || *k == "ellipse"),
                    "crossing holes meet in B-spline (or, for equal radii, elliptic) edges: {ek:?} {:?}",
                    c.steps
                        .iter()
                        .map(|s| format!("{:?}", s.1.sketch.curves))
                        .collect::<Vec<_>>()
                );
            }
            other => panic!("{other}"),
        }
    }
}

/// The sequence and adversarial families are deterministic, their bases are valid, and the
/// sequences' earlier blends build on the enclosure and rounded-box families (W6 review
/// round 4).
#[test]
fn sequence_and_adversarial_bases_build() {
    let a = seq_cases(5, 10);
    let b = seq_cases(5, 10);
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(x.id, y.id);
        assert_eq!(format!("{:?}", x.op), format!("{:?}", y.op));
        assert_eq!(format!("{:?}", x.pre), format!("{:?}", y.pre));
    }
    for c in &a {
        common::assert_valid(&c.base());
        if matches!(c.family, "enc_shell" | "rbox_shell" | "enc_fillet") {
            let body = c
                .prepared()
                .unwrap_or_else(|e| panic!("{}: {} {e}", c.id, e.code()));
            common::assert_valid(&body);
            assert!(c.closed.is_some(), "{}", c.id);
        }
    }
    for c in adv_cases(5, 8) {
        common::assert_valid(&c.base());
    }
}

#[test]
fn corpus_bases_build_deterministically() {
    let a = cases(3, 36);
    let b = cases(3, 36);
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(x.id, y.id);
        assert_eq!(format!("{:?}", x.op), format!("{:?}", y.op));
    }
    for c in a.iter().take(12) {
        let base = c.base();
        common::assert_valid(&base);
    }
}

/// Profiling aid (not part of the batch): times Forge's self-intersection verdict on the
/// results of the corpus cases `BLEND_FROM..BLEND_TO` of seed `BLEND_SEED` (core then curved,
/// as the batch orders them), `BLEND_THREADS` at a time, printing those over one second.
#[test]
#[ignore]
fn profile_self_intersections() {
    let seed: u64 = std::env::var("BLEND_SEED").map_or(17, |s| s.parse().expect("seed"));
    let n: usize = std::env::var("BLEND_COUNT").map_or(400, |s| s.parse().expect("count"));
    let nc: usize = std::env::var("BLEND_CURVED").map_or(60, |s| s.parse().expect("count"));
    let from: usize = std::env::var("BLEND_FROM").map_or(0, |s| s.parse().expect("from"));
    let to: usize = std::env::var("BLEND_TO").map_or(usize::MAX, |s| s.parse().expect("to"));
    let threads: usize = std::env::var("BLEND_THREADS").map_or(4, |s| s.parse().expect("threads"));
    let all: Vec<Case> = cases(seed, n)
        .into_iter()
        .chain(curved_cases(seed, nc))
        .collect();
    let chosen: Vec<&Case> = all
        .iter()
        .skip(from)
        .take(to.saturating_sub(from))
        .collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(case) = chosen.get(i) else { break };
                    let base = case.base();
                    let is_shell = matches!(case.op, CaseOp::Shell { .. });
                    let (edges, faces) = if is_shell {
                        (Vec::new(), select_faces(case, &base))
                    } else {
                        (select_edges(case, &base), Vec::new())
                    };
                    if !is_shell && edges.is_empty() {
                        continue;
                    }
                    let side = if matches!(
                        case.op,
                        CaseOp::Chamfer2 { .. } | CaseOp::ChamferAngle { .. }
                    ) {
                        edges.first().map(|&e0| {
                            let fs = base.edge_faces(e0);
                            fs[(case.pick % fs.len() as u64) as usize]
                        })
                    } else {
                        None
                    };
                    let edges: Vec<EdgeId> = match side {
                        Some(s) => edges
                            .into_iter()
                            .filter(|&e| base.edge_faces(e).contains(&s))
                            .collect(),
                        None => edges,
                    };
                    let Ok((body, _)) = run_op(case, &base, &edges, &faces, side, None) else {
                        continue;
                    };
                    let t0 = Instant::now();
                    let v = forge_blend::self_intersections(&body);
                    let ms = t0.elapsed().as_secs_f64() * 1e3;
                    if ms > 1000.0 {
                        let verdict = match v {
                            Ok(x) => format!("{} pairs", x.len()),
                            Err(e) => format!("unverified: {e}"),
                        };
                        eprintln!(
                            "{} {:.0} ms {} faces: {verdict}",
                            case.id,
                            ms,
                            body.faces().len()
                        );
                    }
                }
            });
        }
    });
}
