//! Run forge-ssi on a deterministic batch of analytic surface pairs and write the inputs
//! and results as JSON Lines for the OCCT differential oracle
//! (`crates/forge-ssi/oracle/occt_ssi_diff.py`).
//!
//! ```text
//! cargo run --release -p forge-ssi --example ssi_oracle_batch -- [--seed 17] [--count 2400] [--out batch.jsonl]
//! ```
//!
//! Also prints Forge-side statistics (status per pair family, time per pair).

use std::collections::BTreeMap;
use std::time::Instant;

use forge_core::geom::Surface;
use forge_ssi::corpus::{PairCase, random_pairs};
use forge_ssi::{IntersectionGraph, SsiError, SsiTolerance, UvBox, intersect_surfaces};
use serde_json::{Value, json};

/// Maximum chord sagitta of the exported branch samples (mm).
const SAGITTA: f64 = 1e-5;

fn surface_json(s: &Surface) -> Value {
    let (kind, f, extra) = match s {
        Surface::Plane(p) => ("plane", *p.frame(), json!({})),
        Surface::Cylinder(c) => ("cylinder", *c.frame(), json!({ "radius": c.radius() })),
        Surface::Cone(c) => (
            "cone",
            *c.frame(),
            json!({ "radius": c.radius(), "half_angle": c.half_angle() }),
        ),
        Surface::Sphere(c) => ("sphere", *c.frame(), json!({ "radius": c.radius() })),
        Surface::Torus(t) => (
            "torus",
            *t.frame(),
            json!({ "major": t.major(), "minor": t.minor() }),
        ),
        Surface::BSpline(_) => ("bspline", forge_core::Frame::world(), json!({})),
    };
    let mut v = json!({
        "type": kind,
        "origin": f.origin().to_array(),
        "z": f.z().to_array(),
        "x": f.x().to_array(),
    });
    if let (Value::Object(m), Value::Object(e)) = (&mut v, extra) {
        m.extend(e);
    }
    v
}

fn dom_json(d: &UvBox) -> Value {
    json!({ "u": [d.u.0, d.u.1], "v": [d.v.0, d.v.1] })
}

fn result_json(r: &Result<IntersectionGraph, SsiError>, us: f64) -> Value {
    match r {
        Err(e) => {
            json!({ "status": "error", "code": e.code(), "message": e.to_string(), "time_us": us })
        }
        Ok(g) => {
            let branches: Vec<Value> = g
                .branches
                .iter()
                .map(|b| {
                    // 513 uniform samples, plus 16 per knot span for B-splines with few
                    // spans (exact rational conics have very non-uniform speed).
                    let n = 128;
                    let mut ts: Vec<f64> = (0..=n)
                        .map(|i| b.range.0 + (b.range.1 - b.range.0) * i as f64 / n as f64)
                        .collect();
                    if let forge_core::geom::Curve3::BSpline(c) = &b.curve {
                        let mut k: Vec<f64> = c
                            .knots()
                            .iter()
                            .copied()
                            .filter(|&x| x >= b.range.0 && x <= b.range.1)
                            .collect();
                        k.dedup();
                        if k.len() <= 65 {
                            for w in k.windows(2) {
                                for j in 1..16 {
                                    ts.push(w[0] + (w[1] - w[0]) * j as f64 / 16.0);
                                }
                            }
                            ts.sort_by(f64::total_cmp);
                        }
                    }
                    // Refine until every chord's deviation from the true curve (checked
                    // at the quarter points too: an arc with an inflection can pass
                    // through its chord's midpoint) is at most SAGITTA, so the oracle can
                    // compare plain polylines to 1e-5 mm.
                    let mut i = 0;
                    while i + 1 < ts.len() && ts.len() < 50_000 {
                        let (a, c) = (b.curve.eval(ts[i]), b.curve.eval(ts[i + 1]));
                        let tm = 0.5 * (ts[i] + ts[i + 1]);
                        let ac = c - a;
                        let l2 = ac.norm_squared();
                        let dev = [0.25, 0.5, 0.75]
                            .iter()
                            .map(|f| {
                                let m = b.curve.eval(ts[i] + (ts[i + 1] - ts[i]) * f);
                                let s = if l2 > 0.0 {
                                    ((m - a).dot(ac) / l2).clamp(0.0, 1.0)
                                } else {
                                    0.0
                                };
                                (a + ac * s).distance(m)
                            })
                            .fold(0.0, f64::max);
                        if dev > SAGITTA && ts[i + 1] - ts[i] > 1e-12 * (1.0 + ts[i].abs()) {
                            ts.insert(i + 1, tm);
                            continue;
                        }
                        i += 1;
                    }
                    let pts: Vec<[f64; 3]> =
                        ts.iter().map(|&t| b.curve.eval(t).to_array()).collect();
                    json!({
                        "closed": b.closed,
                        "kind": b.curve.kind_name(),
                        "tangent": b.contact.is_tangent(),
                        "exact": matches!(b.representation, forge_ssi::Representation::Exact),
                        "error_bound": b.error_bound,
                        "points": pts,
                    })
                })
                .collect();
            let vertices: Vec<Value> = g
                .vertices
                .iter()
                .map(|v| json!({ "kind": format!("{:?}", v.kind), "point": v.point.to_array(), "tangent": v.contact.is_tangent() }))
                .collect();
            json!({
                "status": "ok",
                "method": format!("{:?}", g.method),
                "coincident": g.coincidence.is_some(),
                "certified_complete": g.certified_complete,
                "branches": branches,
                "vertices": vertices,
                "time_us": us,
            })
        }
    }
}

fn main() {
    let mut seed = 17u64;
    let mut count = 2400usize;
    let mut out: Option<String> = None;
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--seed" => {
                seed = args[i + 1].parse().expect("seed");
                i += 1;
            }
            "--count" => {
                count = args[i + 1].parse().expect("count");
                i += 1;
            }
            "--out" => {
                out = Some(args[i + 1].clone());
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    let cases: Vec<PairCase> = random_pairs(seed, count);
    let tol = SsiTolerance::default();
    // JSON Lines output: a header line, then one case per line (streamed by the oracle).
    use std::io::Write;
    let mut writer = out
        .as_ref()
        .map(|p| std::io::BufWriter::new(std::fs::File::create(p).expect("create")));
    if let Some(w) = writer.as_mut() {
        let head = json!({ "seed": seed, "count": count, "fit": tol.fit, "sagitta": SAGITTA });
        writeln!(w, "{head}").expect("write");
    }
    // family -> (count, ok, errors by code, total µs)
    let mut stats: BTreeMap<String, (usize, usize, BTreeMap<String, usize>, f64)> = BTreeMap::new();
    for c in &cases {
        let t0 = Instant::now();
        let r = intersect_surfaces(&c.a, c.dom_a, &c.b, c.dom_b, &tol);
        let us = t0.elapsed().as_secs_f64() * 1e6;
        let e = stats.entry(c.family.clone()).or_default();
        e.0 += 1;
        e.3 += us;
        match &r {
            Ok(_) => e.1 += 1,
            Err(err) => *e.2.entry(err.code().to_string()).or_default() += 1,
        }
        if let Err(err) = &r {
            eprintln!("case {} {}: {}", c.id, c.family, err);
        }
        if let Some(w) = writer.as_mut() {
            let row = json!({
                "id": c.id,
                "family": c.family,
                "a": surface_json(&c.a),
                "dom_a": dom_json(&c.dom_a),
                "b": surface_json(&c.b),
                "dom_b": dom_json(&c.dom_b),
                "forge": result_json(&r, us),
            });
            writeln!(w, "{row}").expect("write");
        }
    }
    let (mut n, mut ok) = (0, 0);
    println!(
        "{:<44} {:>5} {:>5} {:>10}  errors",
        "family", "n", "ok", "µs/pair"
    );
    for (fam, (cnt, k, errs, us)) in &stats {
        n += cnt;
        ok += k;
        println!(
            "{fam:<44} {cnt:>5} {k:>5} {:>10.0}  {errs:?}",
            us / *cnt as f64
        );
    }
    println!("total {n}, ok {ok} ({:.2}%)", 100.0 * ok as f64 / n as f64);
    if let (Some(path), Some(mut w)) = (out, writer) {
        w.flush().expect("flush");
        println!("wrote {path}");
    }
}
