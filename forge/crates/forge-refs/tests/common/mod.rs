//! Test models: v0-surface documents evaluated with forge-ops the way the v1 evaluator will,
//! with provenance stamped by **feature id**, one body per region, origins `(feature id,
//! smallest outer curve)`, and the sweep regions (outer curves, junctions in world
//! coordinates) recorded in the feature table.
#![allow(dead_code)]

use std::collections::BTreeMap;

use forge_core::Tolerance;
use forge_core::linalg::{Frame, Vec3};
use forge_core::topo::{Body, BodyBuilder, Provenance};
use forge_ir::v1::metrics::Origin;
use forge_ir::v1::{self, Ref};
use forge_ops::{Region, extrude, regions, revolve, sketch_frame};
use forge_refs::{FeatureStatus, FeatureTable, Junction, Scope, ScopeBuilder, SweepRegion};

/// An evaluated model: the final bodies of its (single) part.
pub struct Model {
    pub v1: v1::Document,
    pub table: FeatureTable,
    pub bodies: Vec<(Body, Origin)>,
}

pub fn sweep_region(r: &Region, frame: &Frame) -> SweepRegion {
    SweepRegion {
        outer_curves: r.outer_curves.clone(),
        inner_curves: {
            let mut v: Vec<String> = r.holes.iter().flat_map(|l| l.sorted_ids()).collect();
            v.sort();
            v
        },
        junctions: r
            .loops()
            .flat_map(|l| l.junctions.iter())
            .map(|j| Junction {
                key: j.key.clone(),
                point: frame
                    .to_world_point(Vec3::new(j.point.x, j.point.y, 0.0))
                    .to_array(),
            })
            .collect(),
    }
}

/// Evaluate a v0 document (JSON text).
pub fn eval(v0_json: &str) -> Model {
    eval_part(v0_json, 0)
}

/// The number of parts of a v0 document.
pub fn part_count(v0_json: &str) -> usize {
    forge_ir::from_json(v0_json)
        .expect("v0 document")
        .parts
        .len()
}

/// Evaluate part `pi` of a v0 document (JSON text).
pub fn eval_part(v0_json: &str, pi: usize) -> Model {
    let d0 = forge_ir::from_json(v0_json).expect("v0 document");
    let v1doc = v1::migrate_v0_to_v1(&d0);
    let part = &v1doc.parts[pi];
    let mut table = FeatureTable::from_part(part, part.features.len());
    let mut sketches: BTreeMap<String, (Frame, Vec<Region>)> = BTreeMap::new();
    let mut bodies = Vec::new();
    let tol = Tolerance::IR_DEFAULT;
    for f in &d0.parts[pi].features {
        if f.suppressed() {
            if let Some(t) = table.get_mut(f.id()) {
                t.status = FeatureStatus::Suppressed;
            }
            continue;
        }
        match f {
            forge_ir::Feature::Sketch(s) => {
                let frame = sketch_frame(&s.plane).expect("frame");
                let regs = regions(s, &tol).expect("regions");
                sketches.insert(s.name.clone(), (frame, regs));
            }
            forge_ir::Feature::Extrude(e) => {
                let (frame, regs) = sketches.get(&e.sketch).expect("sketch").clone();
                let mut srs = Vec::new();
                for r in &regs {
                    let b = extrude(r, &frame, e.distance, e.direction, &e.id).expect("extrude");
                    bodies.push((
                        b,
                        Origin {
                            feature: e.id.clone(),
                            member: r.outer_curves[0].clone(),
                            instance: None,
                        },
                    ));
                    srs.push(sweep_region(r, &frame));
                }
                table.get_mut(&e.id).expect("feature").regions = srs;
            }
            forge_ir::Feature::Revolve(rv) => {
                let (frame, regs) = sketches.get(&rv.sketch).expect("sketch").clone();
                let mut srs = Vec::new();
                for r in &regs {
                    let b = revolve(r, &frame, &rv.axis, rv.angle, rv.direction, &rv.id)
                        .expect("revolve");
                    bodies.push((
                        b,
                        Origin {
                            feature: rv.id.clone(),
                            member: r.outer_curves[0].clone(),
                            instance: None,
                        },
                    ));
                    srs.push(sweep_region(r, &frame));
                }
                table.get_mut(&rv.id).expect("feature").regions = srs;
            }
        }
    }
    Model {
        v1: v1doc,
        table,
        bodies,
    }
}

impl Model {
    /// A scope over every body, seen by a feature appended at the end of the part.
    pub fn scope(&self) -> Scope<'_> {
        self.scope_with(self.table.clone())
    }
    pub fn scope_with(&self, table: FeatureTable) -> Scope<'_> {
        let mut b = ScopeBuilder::new(table);
        for (body, o) in &self.bodies {
            b = b.body(body, o.clone());
        }
        b.build()
    }
}

/// A copy of `body` with every provenance mapped (to simulate what later operations stamp:
/// split pieces sharing a key, hole faces, pattern copies). Arena order is preserved.
pub fn reprovenance(body: &Body, map: impl Fn(&Provenance) -> Provenance) -> Body {
    rebuild(body, map, |_| true)
}

/// [`reprovenance`], keeping the pcurves only of the faces whose (original) provenance
/// satisfies `keep_pcurves`: a face without pcurves has no computable domain, so its exact
/// properties and its probe fail (to test those failure paths).
pub fn rebuild(
    body: &Body,
    map: impl Fn(&Provenance) -> Provenance,
    keep_pcurves: impl Fn(&Provenance) -> bool,
) -> Body {
    let mut bb = BodyBuilder::with_tolerance(Tolerance::IR_DEFAULT);
    let mut vmap = BTreeMap::new();
    for (vid, v) in body.vertices().iter() {
        let n = bb.add_vertex(v.point, map(&v.provenance)).expect("vertex");
        if v.tolerance > Tolerance::IR_DEFAULT.linear {
            bb.set_vertex_tolerance(n, v.tolerance).expect("tol");
        }
        vmap.insert(vid, n);
    }
    let mut emap = BTreeMap::new();
    for (eid, e) in body.edges().iter() {
        let n = match (e.start, e.end) {
            (Some(s), Some(t)) => bb
                .add_edge(
                    e.curve.clone(),
                    e.t_range,
                    vmap[&s],
                    vmap[&t],
                    map(&e.provenance),
                )
                .expect("edge"),
            _ => bb
                .add_ring_edge_with_range(e.curve.clone(), e.t_range, map(&e.provenance))
                .expect("ring"),
        };
        if e.tolerance > Tolerance::IR_DEFAULT.linear {
            bb.set_edge_tolerance(n, e.tolerance).expect("tol");
        }
        emap.insert(eid, n);
    }
    let mut smap = BTreeMap::new();
    for &sid in body.shell_ids() {
        let sh = body.shell(sid).expect("shell");
        smap.insert(sid, bb.add_shell(sh.closed));
    }
    for (_, f) in body.faces().iter() {
        let nf = bb
            .add_face(
                smap[&f.shell],
                f.surface.clone(),
                f.sense,
                map(&f.provenance),
            )
            .expect("face");
        for &lid in &f.loops {
            let lp = body.loop_(lid).expect("loop");
            let uses: Vec<_> = lp
                .coedges
                .iter()
                .map(|c| {
                    let c = body.coedge(*c).expect("coedge");
                    (emap[&c.edge], c.forward)
                })
                .collect();
            let nl = bb.add_loop(nf, &uses).expect("add loop");
            let new_coedges = bb.body().loop_(nl).expect("loop").coedges.clone();
            for (nc, oc) in new_coedges.into_iter().zip(&lp.coedges) {
                if !keep_pcurves(&f.provenance) {
                    continue;
                }
                if let Some(pc) = &body.coedge(*oc).expect("coedge").pcurve {
                    bb.set_pcurve(nc, pc.clone()).expect("pcurve");
                }
            }
        }
    }
    bb.finish()
}

/// Replace `from` by `to` in a provenance's feature, sources and qualifier (substring).
pub fn rename_in(p: &Provenance, from: &str, to: &str) -> Provenance {
    let mut q = p.clone();
    q.sources = p.sources.iter().map(|s| s.replace(from, to)).collect();
    q
}

/// A Ref from JSON.
pub fn r(v: serde_json::Value) -> Ref {
    serde_json::from_value(v).expect("ref")
}

/// A plate 40 × 20 × 5 on XY (centred), with a hole `ring` (r 3 at (10, 0)): `e1`.
pub fn plate_json(extra_curves: &str) -> String {
    format!(
        r#"{{ "schema": "aicad.ir/0", "parts": [{{ "id": "p1", "name": "part", "features": [
  {{ "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
    {{ "kind": "line", "id": "bottom", "start": [-20, -10], "end": [20, -10] }},
    {{ "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] }},
    {{ "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] }},
    {{ "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }}{extra_curves} ] }},
  {{ "type": "extrude", "id": "e1", "name": "slab", "sketch": "base", "distance": 5 }} ] }}] }}"#
    )
}

/// A document with sketch `base` (on XY) holding `curves` and then `features` (JSON array
/// items, after the sketch).
pub fn doc(curves: &str, features: &str) -> String {
    format!(
        r#"{{ "schema": "aicad.ir/0", "parts": [{{ "id": "p1", "name": "part", "features": [
  {{ "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [ {curves} ] }},
  {features} ] }}] }}"#
    )
}

/// The plate outline with `bottom` renamed (same geometry): the body member becomes `left`.
pub const OUTLINE_ZB: &str = r#"
    { "kind": "line", "id": "zbottom", "start": [-20, -10], "end": [20, -10] },
    { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
    { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
    { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;

/// The plate outline.
pub const OUTLINE: &str = r#"
    { "kind": "line", "id": "bottom", "start": [-20, -10], "end": [20, -10] },
    { "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] },
    { "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] },
    { "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#;

/// `extrude e1` of `base` by `d`.
pub fn e1(d: f64) -> String {
    format!(
        r#"{{ "type": "extrude", "id": "e1", "name": "slab", "sketch": "base", "distance": {d} }}"#
    )
}

pub const RING: &str = r#", { "kind": "circle", "id": "ring", "center": [10, 0], "radius": 3 }"#;

/// The plate with its ring.
pub fn plate() -> Model {
    eval(&plate_json(RING))
}

/// A "D" profile (line `flat` + arc `bow` meeting twice) extruded 4 on XY: `e2`.
pub fn d_shape() -> Model {
    eval(
        r#"{ "schema": "aicad.ir/0", "parts": [{ "id": "p1", "name": "part", "features": [
  { "type": "sketch", "id": "s2", "name": "dsk", "plane": "XY", "curves": [
    { "kind": "line", "id": "flat", "start": [3, -4], "end": [3, 4] },
    { "kind": "arc", "id": "bow", "start": [3, 4], "end": [3, -4], "center": [0, 0], "ccw": true } ] },
  { "type": "extrude", "id": "e2", "name": "dee", "sketch": "dsk", "distance": 4 } ] }] }"#,
    )
}

/// Half a cone: the triangle (0,0)-(4,0)-(0,6) on XZ revolved 180° about the sketch y axis
/// (world Z): `r1`.
pub fn half_cone() -> Model {
    eval(
        r#"{ "schema": "aicad.ir/0", "parts": [{ "id": "p1", "name": "part", "features": [
  { "type": "sketch", "id": "s3", "name": "prof", "plane": "XZ", "curves": [
    { "kind": "line", "id": "a", "start": [0, 0], "end": [4, 0] },
    { "kind": "line", "id": "b", "start": [4, 0], "end": [0, 6] },
    { "kind": "line", "id": "c", "start": [0, 6], "end": [0, 0] } ] },
  { "type": "revolve", "id": "r1", "name": "cone", "sketch": "prof", "axis": { "origin": [0, 0], "direction": [0, 1] }, "angle": 180 } ] }] }"#,
    )
}

/// An L-shaped block (a concave vertical edge at (4, 4)): `e3`.
pub fn l_shape() -> Model {
    eval(
        r#"{ "schema": "aicad.ir/0", "parts": [{ "id": "p1", "name": "part", "features": [
  { "type": "sketch", "id": "s4", "name": "lsk", "plane": "XY", "curves": [
    { "kind": "line", "id": "l1", "start": [0, 0], "end": [10, 0] },
    { "kind": "line", "id": "l2", "start": [10, 0], "end": [10, 4] },
    { "kind": "line", "id": "l3", "start": [10, 4], "end": [4, 4] },
    { "kind": "line", "id": "l4", "start": [4, 4], "end": [4, 10] },
    { "kind": "line", "id": "l5", "start": [4, 10], "end": [0, 10] },
    { "kind": "line", "id": "l6", "start": [0, 10], "end": [0, 0] } ] },
  { "type": "extrude", "id": "e3", "name": "ell", "sketch": "lsk", "distance": 3 } ] }] }"#,
    )
}

/// A stadium (two lines and two tangent semicircles): smooth vertical edges: `e4`.
pub fn stadium() -> Model {
    eval(
        r#"{ "schema": "aicad.ir/0", "parts": [{ "id": "p1", "name": "part", "features": [
  { "type": "sketch", "id": "s5", "name": "ssk", "plane": "XY", "curves": [
    { "kind": "line", "id": "lo", "start": [0, 0], "end": [10, 0] },
    { "kind": "arc", "id": "ar", "start": [10, 0], "end": [10, 4], "center": [10, 2], "ccw": true },
    { "kind": "line", "id": "hi", "start": [10, 4], "end": [0, 4] },
    { "kind": "arc", "id": "al", "start": [0, 4], "end": [0, 0], "center": [0, 2], "ccw": true } ] },
  { "type": "extrude", "id": "e4", "name": "stad", "sketch": "ssk", "distance": 2 } ] }] }"#,
    )
}

/// Squares of side `size` with lower-left corners at `(x, 0)` for each `x`: the square `k`
/// has lines `<c>1..<c>4` (`c` = `a`, `b`, `c`, …; bottom, right, top, left), so its region's
/// member is `<c>1`.
pub fn squares(xs: &[f64], size: f64) -> String {
    let mut out: Vec<String> = Vec::new();
    for (k, x) in xs.iter().enumerate() {
        let c = (b'a' + k as u8) as char;
        let (x0, x1, y1) = (*x, x + size, size);
        out.push(format!(
            r#"{{ "kind": "line", "id": "{c}1", "start": [{x0}, 0], "end": [{x1}, 0] }},
    {{ "kind": "line", "id": "{c}2", "start": [{x1}, 0], "end": [{x1}, {y1}] }},
    {{ "kind": "line", "id": "{c}3", "start": [{x1}, {y1}], "end": [{x0}, {y1}] }},
    {{ "kind": "line", "id": "{c}4", "start": [{x0}, {y1}], "end": [{x0}, 0] }}"#
        ));
    }
    out.join(",\n    ")
}

/// The "D" of [`d_shape`] extruded `dist`, moved by `dy` along Y, its arc `bow` reversed or
/// not (the same geometry either way; a reversal swaps the `@bow.start`/`@bow.end` junction
/// qualifiers).
pub fn dee(dist: f64, dy: f64, reversed: bool) -> Model {
    let (a, b) = (dy - 4.0, dy + 4.0);
    let bow = if reversed {
        format!(
            r#"{{ "kind": "arc", "id": "bow", "start": [3, {a}], "end": [3, {b}], "center": [0, {dy}], "ccw": false }}"#
        )
    } else {
        format!(
            r#"{{ "kind": "arc", "id": "bow", "start": [3, {b}], "end": [3, {a}], "center": [0, {dy}], "ccw": true }}"#
        )
    };
    eval(&format!(
        r#"{{ "schema": "aicad.ir/0", "parts": [{{ "id": "p1", "name": "part", "features": [
  {{ "type": "sketch", "id": "s2", "name": "dsk", "plane": "XY", "curves": [
    {{ "kind": "line", "id": "flat", "start": [3, {a}], "end": [3, {b}] }}, {bow} ] }},
  {{ "type": "extrude", "id": "e2", "name": "dee", "sketch": "dsk", "distance": {dist} }} ] }}] }}"#
    ))
}

/// The sketch junctions of `feature` with curve `from` renamed `to`: the junction edges of
/// pieces that share `to`'s key keep `to`'s junction qualifier, as the operation that split
/// them would leave them (§5.2 rule 3: modified entities keep their keys).
pub fn share_junctions(table: &mut FeatureTable, feature: &str, from: &str, to: &str) {
    let f = table.get_mut(feature).expect("feature");
    for j in f.regions.iter_mut().flat_map(|r| r.junctions.iter_mut()) {
        j.key = j
            .key
            .split('|')
            .map(|end| match end.rsplit_once(':') {
                Some((c, e)) if c == from => format!("{to}:{e}"),
                _ => end.to_string(),
            })
            .collect::<Vec<_>>()
            .join("|");
    }
}

/// Give the side face of curve `from` of `e1` the key of curve `to` (pieces of one split
/// sharing its key, §5.2 rule 3, as a later operation would stamp them), with its junctions.
pub fn share_side_key(m: &mut Model, from: &str, to: &str) {
    let body = reprovenance(&m.bodies[0].0, |p| {
        let mut q = rename_in(p, &format!("e1/side:{from}"), &format!("e1/side:{to}"));
        if q.role == forge_core::topo::Role::Side && q.sources.iter().any(|x| x == from) {
            q.sources = [to.to_string()].into_iter().collect();
        }
        q
    });
    m.bodies[0].0 = body;
    share_junctions(&mut m.table, "e1", from, to);
}

/// The plate outline (40 × 20, no ring) extruded 5 as `e1`, its bottom line cut at `cuts`
/// (increasing, inside −20..20) into `bottom` (the leftmost piece), `bottom1`, `bottom2`, …;
/// with `share`, every piece carries the key `e1/side:bottom`.
pub fn split_bottom(cuts: &[f64], share: bool) -> Model {
    let mut xs = vec![-20.0];
    xs.extend_from_slice(cuts);
    xs.push(20.0);
    let id = |k: usize| {
        if k == 0 {
            "bottom".to_string()
        } else {
            format!("bottom{k}")
        }
    };
    let mut curves: Vec<String> = xs
        .windows(2)
        .enumerate()
        .map(|(k, w)| {
            format!(
                r#"{{ "kind": "line", "id": "{}", "start": [{}, -10], "end": [{}, -10] }}"#,
                id(k),
                w[0],
                w[1]
            )
        })
        .collect();
    curves.push(r#"{ "kind": "line", "id": "right", "start": [20, -10], "end": [20, 10] }"#.into());
    curves.push(r#"{ "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] }"#.into());
    curves
        .push(r#"{ "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }"#.into());
    let mut m = eval(&doc(&curves.join(",\n"), &e1(5.0)));
    if share {
        for k in 1..xs.len() - 1 {
            share_side_key(&mut m, &id(k), "bottom");
        }
    }
    m
}

/// The plate outline (no ring) with a notch `xl..xr` (height 5) cut into its bottom, extruded
/// 5 as `e1`: `bottom` (−20..xl) and `bottom_r` (xr..20, lifted by `dy`) share the key
/// `e1/side:bottom`, as the two pieces of a face a cut went through (not adjacent to each
/// other: §6.0.4 would merge adjacent pieces). With `dy ≠ 0` they are on different planes.
pub fn notched(xl: f64, xr: f64, dy: f64) -> Model {
    let yr = -10.0 + dy;
    let curves = format!(
        r#"
        {{ "kind": "line", "id": "bottom", "start": [-20, -10], "end": [{xl}, -10] }},
        {{ "kind": "line", "id": "notch_l", "start": [{xl}, -10], "end": [{xl}, -5] }},
        {{ "kind": "line", "id": "notch_t", "start": [{xl}, -5], "end": [{xr}, -5] }},
        {{ "kind": "line", "id": "notch_r", "start": [{xr}, -5], "end": [{xr}, {yr}] }},
        {{ "kind": "line", "id": "bottom_r", "start": [{xr}, {yr}], "end": [20, {yr}] }},
        {{ "kind": "line", "id": "right", "start": [20, {yr}], "end": [20, 10] }},
        {{ "kind": "line", "id": "top", "start": [20, 10], "end": [-20, 10] }},
        {{ "kind": "line", "id": "left", "start": [-20, 10], "end": [-20, -10] }}"#
    );
    let mut m = eval(&doc(&curves, &e1(5.0)));
    share_side_key(&mut m, "bottom_r", "bottom");
    m
}
