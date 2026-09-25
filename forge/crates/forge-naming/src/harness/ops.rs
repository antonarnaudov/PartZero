//! Naming harness v1, **Phase C operation families**: references across booleans (split,
//! merge, tool moves, deeper and removed cuts), holes (add, move, resize, remove a position,
//! change kind), blends (add a fillet, remove one, change its radius, a later chamfer through
//! the fillet's tangent chain) and patterns (count up and down, spacing, skip, circular count),
//! on IR v1 models evaluated by `forge-regen`'s v1 pipeline.
//!
//! Unlike the spike families ([`super::v1`], v0 models and a scope rebuilt from the v0
//! evaluation), these references are resolved by the **product's own resolver in place**: each
//! reference is a `tag` feature appended to its part (SPEC-v1 §6.12), so it resolves against the
//! part's final bodies with forge-regen's full scope (merged-face aliases, sweep regions, pattern
//! instances), and its report entry (§5.8) is what is scored.
//!
//! For every model and mutation:
//! 1. evaluate the base; over each part's final bodies, synthesize a query that selects every
//!    face and edge exactly (`forge_refs::synthesize_query`, §5.8);
//! 2. append one `tag` per query (card `one`, an empty capture) and evaluate: the report's
//!    `proposal` carries the fresh capture (the command layer's `captureRef`, §0.6); a query that
//!    does not resolve to its own entity is dropped (counted, not scored), and so is one whose
//!    member comes from a **broad** source (a pick such as `extreme` over a face's edges): a
//!    pick's intent is re-evaluated by design (§5.7 step 5, `REF_SET_CHANGED`), so identity is
//!    not its truth — the spike family (i) scores picks against their own re-evaluation. The
//!    exception is a **pattern copy**: no named source designates one (`instance` is broad,
//!    §5.3), so its query narrows `instance(P, [i])` (its edges: that instance's edges); the
//!    mutations keep instance indices, so the intent "that face of instance `i`" is the identity
//!    the geometric truth follows, and these references are scored — except where the instance
//!    **rotates** (a circular pattern's new angle step): the narrowing picks are in world axes,
//!    so their intent is not the rotated identity, and those are excluded. The other exception
//!    is a **blend entity** (a fillet's or chamfer's own face `F/blend:{E}`, `F/bevel:{E}`,
//!    `F/corner:{V}`, and every edge of one): no named source designates a blend face either
//!    (`created` is broad), so its query is **authored** — `created(F, role)` narrowed by
//!    world-axis `extreme` picks, and each of its edges `between` that pick and the named
//!    source of the neighbouring face (a synthesized `extreme` pick over the neighbour's edges
//!    would re-bind to the sharp edge once the blend is gone, which is the pick's intent, not
//!    the edge's identity). The blend mutations keep every blend at its corner (a new radius
//!    scales it about the corner's sharp edge, [`Motion::Radial`]), so the authored intent is
//!    the identity the truth follows, and these references are scored;
//! 3. **identity**: re-evaluate the base with the captured tags: every one must be `exact` and
//!    select its entity (otherwise an identity failure);
//! 4. apply the mutation to the document, append the captured tags and evaluate; a tag the
//!    mutated document rejects statically is dropped and retried without (scored as a static
//!    rejection);
//! 5. score each tag's resolution against a **geometric ground truth**.
//!
//! # Ground truth
//! Each mutation declares how it moves the model: a [`Motion`] per base entity, chosen from the
//! entity's provenance key (the base's keys are verified by the identity check): unchanged,
//! translated (a moved hole, a pattern instance at a new spacing), rotated (a circular pattern
//! instance at a new angle), scaled about an axis (a resized hole; a fillet whose radius changed,
//! about the sharp edge it replaced), or unknown (not scored; no scripted mutation uses it
//! today). The truth of a base entity `e` in the mutated model is every mutated entity
//! `e'` of the same kind that **overlaps** its image — `e'` contains the moved probe of `e`, or `e`
//! contains the probe of `e'` moved back — with no reference to keys: none is `Gone`, one is
//! `Same`, several are a `Split`.
//!
//! Scoring is the v1 harness's: used (`exact`/`accepted`) and equal to the truth is `CORRECT`
//! (exact) or `FLAGGED_CORRECTLY` (accepted); used and different is **`SILENT_WRONG`**; failed with
//! its best candidate in the truth, or failed/rejected when the truth is `Gone`, is
//! `FLAGGED_CORRECTLY`; any other failure is `WRONG_BUT_FLAGGED`.

use std::collections::BTreeSet;

use forge_core::linalg::Vec3;
use forge_core::math::sin_cos_deg;
use forge_core::topo::parse_key;
use forge_ir::v1::metrics::{CandidateReason, FeatureReport, Probe, RefReport, RefStatus};
use forge_ir::v1::{AUTO_ACCEPT_CONFIDENCE, Document, EntityKind, LINEAR_TOLERANCE, Query, Via};
use forge_refs::{
    Entity, EntityId, FeatureTable, Scope, ScopeBuilder, eval_query, synthesize_query,
};
use forge_regen::v1::{Evaluation, evaluate, load};
use serde_json::{Value, json};

use super::Outcome;
use super::v1::{V1Family, V1Record, V1Report};

// ---- models -------------------------------------------------------------------------------

/// A Phase C harness model: canonical IR v1 JSON (the `.cad.ts` next to it is its source).
#[derive(Clone, Debug)]
pub struct OpsModel {
    /// File stem under `models/v1/`.
    pub name: &'static str,
    /// Canonical `aicad.ir/1` JSON.
    pub json: &'static str,
}

/// The Phase C models, embedded at compile time
/// (`node packages/cadscript/dist/cli.js compile models/v1/<name>.cad.ts -o models/v1/<name>.json`).
pub fn ops_models() -> Vec<OpsModel> {
    vec![
        OpsModel {
            name: "ops-hole-plate",
            json: include_str!("../../models/v1/ops-hole-plate.json"),
        },
        OpsModel {
            name: "ops-pattern-rail",
            json: include_str!("../../models/v1/ops-pattern-rail.json"),
        },
        OpsModel {
            name: "ops-boolean-block",
            json: include_str!("../../models/v1/ops-boolean-block.json"),
        },
    ]
}

// ---- motions ------------------------------------------------------------------------------

type P3 = [f64; 3];

/// How a mutation moves a base entity (the ground truth's map from base to mutated geometry).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Motion {
    /// Unchanged (it may be trimmed, extended or split: overlap decides).
    Same,
    /// Translated.
    Translate(P3),
    /// Rotated by `deg` about the line (`origin`, unit `dir`), right-hand rule.
    Rotate {
        /// A point on the axis.
        origin: P3,
        /// Unit direction.
        dir: P3,
        /// Degrees.
        deg: f64,
    },
    /// Scaled radially about the line (`origin`, unit `dir`) from radius `from` to `to` (a
    /// resized hole: points on the old cylinder map to the new one; a fillet of a sharp convex
    /// edge whose radius changed, about that edge: the blend's axis, tangent lines and arcs all
    /// scale by `to / from` about it).
    Radial {
        /// A point on the axis.
        origin: P3,
        /// Unit direction.
        dir: P3,
        /// Old radius.
        from: f64,
        /// New radius.
        to: f64,
    },
    /// The geometry changes in a way no map here describes: not scored (a key the mutation's
    /// motion cannot place, e.g. a blend whose corner the key does not name).
    Unknown,
}

fn add(a: P3, b: P3) -> P3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: P3, b: P3) -> P3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn scale(a: P3, k: f64) -> P3 {
    [a[0] * k, a[1] * k, a[2] * k]
}
fn dot(a: P3, b: P3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: P3, b: P3) -> P3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn rotate(p: P3, origin: P3, d: P3, deg: f64) -> P3 {
    // The portable degree trig (CLAUDE.md determinism rules), exact at multiples of 90°.
    let (s, c) = sin_cos_deg(deg);
    let v = sub(p, origin);
    let r = add(
        add(scale(v, c), scale(cross(d, v), s)),
        scale(d, dot(d, v) * (1.0 - c)),
    );
    add(origin, r)
}

fn radial(p: P3, origin: P3, d: P3, k: f64) -> P3 {
    let v = sub(p, origin);
    let along = scale(d, dot(v, d));
    add(add(origin, along), scale(sub(v, along), k))
}

impl Motion {
    /// The image of a base point.
    pub fn apply(&self, p: P3) -> Option<P3> {
        match *self {
            Motion::Same => Some(p),
            Motion::Translate(t) => Some(add(p, t)),
            Motion::Rotate { origin, dir, deg } => Some(rotate(p, origin, dir, deg)),
            Motion::Radial {
                origin,
                dir,
                from,
                to,
            } => Some(radial(p, origin, dir, to / from)),
            Motion::Unknown => None,
        }
    }
    /// The base point of a mutated point.
    pub fn invert(&self, p: P3) -> Option<P3> {
        match *self {
            Motion::Same => Some(p),
            Motion::Translate(t) => Some(sub(p, t)),
            Motion::Rotate { origin, dir, deg } => Some(rotate(p, origin, dir, -deg)),
            Motion::Radial {
                origin,
                dir,
                from,
                to,
            } => Some(radial(p, origin, dir, from / to)),
            Motion::Unknown => None,
        }
    }
}

// ---- key helpers ----------------------------------------------------------------------------

/// `true` if `key` (or a key nested in it, an edge's face keys) is an entity of feature `fid`
/// with qualifier `qual` (`fid/…@qual`); `qual` `None` matches any qualifier.
fn key_names(key: &str, fid: &str, qual: Option<&str>) -> bool {
    key_has(key, &format!("{fid}/"), qual)
}

/// `true` if `key` or a key nested in it starts with `prefix` (and ends with `@qual`, if given).
fn key_has(key: &str, prefix: &str, qual: Option<&str>) -> bool {
    let pat = prefix;
    let bytes = key.as_bytes();
    let mut i = 0;
    while let Some(off) = key[i..].find(pat) {
        let start = i + off;
        // A key starts at the beginning, or after `{` or `|`.
        let at_start = start == 0 || matches!(bytes[start - 1], b'{' | b'|');
        if at_start {
            let end = key_end(key, start);
            let own = &key[start..end];
            match qual {
                None => return true,
                Some(q) => {
                    if own.rsplit_once('@').is_some_and(|(_, x)| x == q) {
                        return true;
                    }
                }
            }
        }
        i = start + pat.len();
    }
    false
}

/// The end of the key starting at `start` inside `key` (at the `|` or `}` closing it).
fn key_end(key: &str, start: usize) -> usize {
    let mut depth = 0usize;
    for (i, b) in key.as_bytes().iter().enumerate().skip(start) {
        match b {
            b'{' => depth += 1,
            b'}' if depth == 0 => return i,
            b'}' => depth -= 1,
            b'|' if depth == 0 => return i,
            _ => {}
        }
    }
    key.len()
}

/// The pattern and instance of a pattern copy's own key (`P/copy:{K}@i`), if it is one.
fn copy_of(key: &str) -> Option<(String, u32)> {
    let (pid, rest) = key.split_once("/copy:{")?;
    if pid.contains(['/', '{', '|']) {
        return None;
    }
    let i = rest.rsplit_once("}@")?.1.split('.').next()?.parse().ok()?;
    Some((pid.to_string(), i))
}

/// The pattern instance of a copy made by pattern `pid` named in `key` (`pid/copy:{…}@i`).
fn instance_of(key: &str, pid: &str) -> Option<usize> {
    let pat = format!("{pid}/copy:{{");
    let start = key.find(&pat)?;
    let end = key_end(key, start);
    let own = &key[start..end];
    own.rsplit_once("}@")
        .and_then(|(_, i)| i.split('.').next())
        .and_then(|i| i.parse().ok())
}

// ---- mutations ----------------------------------------------------------------------------

/// A scripted edit of a Phase C model with its ground-truth motion.
pub struct OpsMutation {
    /// Id shown in the report.
    pub id: &'static str,
    /// Family.
    pub family: V1Family,
    edit: Box<dyn Fn(&mut Value)>,
    motion: Box<dyn Fn(&str) -> Motion>,
}

fn feature_mut<'a>(v: &'a mut Value, id: &str) -> &'a mut Value {
    v["parts"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .flat_map(|p| p["features"].as_array_mut().into_iter().flatten())
        .find(|f| f["id"] == id)
        .unwrap_or_else(|| panic!("model has no feature {id}"))
}

fn part_features_mut(v: &mut Value, part: usize) -> &mut Vec<Value> {
    v["parts"][part]["features"]
        .as_array_mut()
        .expect("features")
}

fn m(
    id: &'static str,
    family: V1Family,
    edit: impl Fn(&mut Value) + 'static,
    motion: impl Fn(&str) -> Motion + 'static,
) -> OpsMutation {
    OpsMutation {
        id,
        family,
        edit: Box::new(edit),
        motion: Box::new(motion),
    }
}

/// Two motions in a row (translations add up; anything else with a non-trivial motion is unknown).
fn compose(a: Motion, b: Motion) -> Motion {
    match (a, b) {
        (Motion::Same, x) | (x, Motion::Same) => x,
        (Motion::Translate(s), Motion::Translate(t)) => Motion::Translate(add(s, t)),
        _ => Motion::Unknown,
    }
}

/// An edit **sequence**: `a` then `b`, applied to the base whose captures the references hold
/// (capture at v0, resolve at v2: §0.6 does not refresh captures on exact commits).
fn seq(id: &'static str, family: V1Family, a: OpsMutation, b: OpsMutation) -> OpsMutation {
    let OpsMutation {
        edit: ea,
        motion: ma,
        ..
    } = a;
    let OpsMutation {
        edit: eb,
        motion: mb,
        ..
    } = b;
    OpsMutation {
        id,
        family,
        edit: Box::new(move |v| {
            ea(v);
            eb(v);
        }),
        motion: Box::new(move |k| compose(ma(k), mb(k))),
    }
}

fn take(list: &mut Vec<OpsMutation>, id: &str) -> OpsMutation {
    let i = list.iter().position(|m| m.id == id).expect("mutation");
    list.remove(i)
}

const Z: P3 = [0.0, 0.0, 1.0];

/// The hole positions of `ops-hole-plate` (`f_holes`).
const HOLE_POS: [(&str, [f64; 2]); 3] = [
    ("a", [-30.0, -15.0]),
    ("b", [30.0, -15.0]),
    ("c", [0.0, 15.0]),
];

/// `ops-hole-plate`'s outline (`rect` 100 × 60 about the origin): the coordinate of each side
/// curve, as `(axis, value)`.
const PLATE_SIDES: [(&str, usize, f64); 4] = [
    ("outline.left", 0, -50.0),
    ("outline.right", 0, 50.0),
    ("outline.bottom", 1, -30.0),
    ("outline.top", 1, 30.0),
];

/// The sharp vertical corner of `ops-hole-plate` a key's `f_corners` blend replaced: the blend
/// face `f_corners/blend:{f_plate/edge:{f_plate/side:A|f_plate/side:B}…}` names the two plate
/// sides that met there (an edge of the blend nests that key, plus maybe one of the two sides
/// again). `None` unless the key names exactly one side along X and one along Y.
fn plate_corner(key: &str) -> Option<P3> {
    let mut at: [Option<(&str, f64)>; 2] = [None, None];
    for (curve, axis, v) in PLATE_SIDES {
        if key_has(key, &format!("f_plate/side:{curve}"), None) {
            match at[axis] {
                Some((c, _)) if c != curve => return None,
                _ => at[axis] = Some((curve, v)),
            }
        }
    }
    Some([at[0]?.1, at[1]?.1, 0.0])
}

fn hole_plate_mutations() -> Vec<OpsMutation> {
    vec![
        m(
            "hole_add",
            V1Family::Hole,
            |v| {
                feature_mut(v, "f_holes")["at"]["list"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({ "id": "d", "at": [30, 15] }));
            },
            |_| Motion::Same,
        ),
        m(
            "hole_move",
            V1Family::Hole,
            |v| feature_mut(v, "f_holes")["at"]["list"][0]["at"] = json!([-25, -15]),
            |k| {
                if key_names(k, "f_holes", Some("a")) {
                    Motion::Translate([5.0, 0.0, 0.0])
                } else {
                    Motion::Same
                }
            },
        ),
        m(
            "hole_resize",
            V1Family::Hole,
            |v| feature_mut(v, "f_holes")["d"] = json!(7),
            |k| {
                for (p, c) in HOLE_POS {
                    if key_names(k, "f_holes", Some(p)) {
                        return Motion::Radial {
                            origin: [c[0], c[1], 0.0],
                            dir: Z,
                            from: 3.0,
                            to: 3.5,
                        };
                    }
                }
                Motion::Same
            },
        ),
        m(
            "hole_remove_position",
            V1Family::Hole,
            |v| {
                feature_mut(v, "f_holes")["at"]["list"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            },
            |_| Motion::Same,
        ),
        m(
            "hole_cbore_to_csink",
            V1Family::Hole,
            |v| {
                let f = feature_mut(v, "f_screw").as_object_mut().unwrap();
                f.remove("cbore");
                f.insert("csink".into(), json!("iso10642"));
            },
            |_| Motion::Same,
        ),
        m(
            "fillet_add_top",
            V1Family::Fillet,
            |v| {
                part_features_mut(v, 0).push(json!({
                    "type": "fillet", "id": "f_top", "name": "top", "r": 1,
                    "edges": { "kind": "edge", "q": { "op": "between",
                        "a": { "op": "cap", "feature": "f_plate", "end": "end" },
                        "b": { "op": "sides", "feature": "f_plate" } } }
                }));
            },
            |_| Motion::Same,
        ),
        m(
            "fillet_remove",
            V1Family::Fillet,
            |v| feature_mut(v, "f_corners")["suppressed"] = json!(true),
            |_| Motion::Same,
        ),
        m(
            "fillet_radius",
            V1Family::Fillet,
            |v| feature_mut(v, "f_corners")["r"] = json!(8),
            |k| {
                // R5 → R8: each corner's blend face, tangent lines and arcs scale by 8/5 about
                // the sharp vertical edge the blend replaced; the plate's faces and edges are
                // only trimmed or extended (overlap decides).
                if key_names(k, "f_corners", None) {
                    match plate_corner(k) {
                        Some(origin) => Motion::Radial {
                            origin,
                            dir: Z,
                            from: 5.0,
                            to: 8.0,
                        },
                        None => Motion::Unknown,
                    }
                } else {
                    Motion::Same
                }
            },
        ),
        m(
            "chamfer_bottom_rim",
            V1Family::Fillet,
            |v| {
                // A later blend: the bottom rim's straight edges, whose tangent chain runs
                // through the corner blends' bottom arcs (they are consumed; every other blend
                // entity is trimmed).
                part_features_mut(v, 0).push(json!({
                    "type": "chamfer", "id": "f_rim", "name": "rim", "d": 1,
                    "edges": { "kind": "edge", "q": { "op": "between",
                        "a": { "op": "cap", "feature": "f_plate", "end": "start" },
                        "b": { "op": "sides", "feature": "f_plate" } } }
                }));
            },
            |_| Motion::Same,
        ),
    ]
}

fn pattern_rail_mutations() -> Vec<OpsMutation> {
    let row_spacing = |from: f64, to: f64| {
        move |k: &str| match instance_of(k, "f_row") {
            Some(i) => Motion::Translate([(to - from) * i as f64, 0.0, 0.0]),
            None => Motion::Same,
        }
    };
    vec![
        m(
            "row_count_up",
            V1Family::Pattern,
            |v| feature_mut(v, "f_row")["layout"]["linear"]["count"] = json!(5),
            |_| Motion::Same,
        ),
        m(
            "row_count_down",
            V1Family::Pattern,
            |v| feature_mut(v, "f_row")["layout"]["linear"]["count"] = json!(3),
            |_| Motion::Same,
        ),
        m(
            "row_spacing",
            V1Family::Pattern,
            |v| feature_mut(v, "f_row")["layout"]["linear"]["spacing"] = json!(24),
            row_spacing(22.0, 24.0),
        ),
        m(
            "row_skip",
            V1Family::Pattern,
            |v| feature_mut(v, "f_row")["skip"] = json!([[2]]),
            |_| Motion::Same,
        ),
        m(
            "ring_count_up",
            V1Family::Pattern,
            |v| feature_mut(v, "f_ring")["layout"]["circular"]["count"] = json!(6),
            |k| match instance_of(k, "f_ring") {
                Some(i) => Motion::Rotate {
                    origin: [0.0, 80.0, 0.0],
                    dir: Z,
                    deg: (60.0 - 72.0) * i as f64,
                },
                None => Motion::Same,
            },
        ),
    ]
}

fn boolean_block_mutations() -> Vec<OpsMutation> {
    vec![
        m(
            "cut_splits_body",
            V1Family::Boolean,
            |v| feature_mut(v, "f_groove")["distance"] = json!(20),
            |_| Motion::Same,
        ),
        m(
            "join_merges_bodies",
            V1Family::Boolean,
            |v| {
                feature_mut(v, "f_bridgeSk")["curves"][0]["w"] = json!(18);
            },
            |_| Motion::Same,
        ),
        m(
            "join_tool_moves",
            V1Family::Boolean,
            |v| feature_mut(v, "f_bossSk")["curves"][0]["center"] = json!([28, 0]),
            |k| {
                if key_names(k, "f_boss", None) {
                    Motion::Translate([3.0, 0.0, 0.0])
                } else {
                    Motion::Same
                }
            },
        ),
        m(
            "cut_deeper",
            V1Family::Boolean,
            |v| feature_mut(v, "f_groove")["distance"] = json!(12),
            |k| {
                // The groove's floor (its end cap) and the edges on it move down; its walls
                // extend (overlap); its rim on the block's top stays.
                if key_has(k, "f_groove/cap:end", None) {
                    Motion::Translate([0.0, 0.0, -2.0])
                } else {
                    Motion::Same
                }
            },
        ),
        m(
            "cut_suppressed",
            V1Family::Boolean,
            |v| feature_mut(v, "f_groove")["suppressed"] = json!(true),
            |_| Motion::Same,
        ),
    ]
}

impl OpsMutation {
    /// Apply the edit to a copy of a model's JSON.
    pub fn apply(&self, doc: &Value) -> Value {
        let mut v = doc.clone();
        (self.edit)(&mut v);
        v
    }
    /// The motion the ground truth applies to a base entity with this provenance key.
    pub fn motion(&self, key: &str) -> Motion {
        (self.motion)(key)
    }
}

/// A two-edit sequence of a model: `(id, family, first mutation, second mutation)`.
type SeqSpec = (&'static str, V1Family, &'static str, &'static str);

/// The mutations of a model: the single edits, then its two-edit sequences.
pub fn ops_mutations(model: &str) -> Vec<OpsMutation> {
    let (make, seqs): (fn() -> Vec<OpsMutation>, &[SeqSpec]) = match model {
        "ops-hole-plate" => (
            hole_plate_mutations,
            &[
                (
                    "hole_move+fillet_add_top",
                    V1Family::Hole,
                    "hole_move",
                    "fillet_add_top",
                ),
                (
                    "fillet_radius+chamfer_bottom_rim",
                    V1Family::Fillet,
                    "fillet_radius",
                    "chamfer_bottom_rim",
                ),
            ],
        ),
        "ops-pattern-rail" => (
            pattern_rail_mutations,
            &[(
                "row_spacing+row_count_down",
                V1Family::Pattern,
                "row_spacing",
                "row_count_down",
            )],
        ),
        "ops-boolean-block" => (
            boolean_block_mutations,
            &[(
                "join_tool_moves+cut_deeper",
                V1Family::Boolean,
                "join_tool_moves",
                "cut_deeper",
            )],
        ),
        _ => return Vec::new(),
    };
    let mut out = make();
    for &(id, family, a, b) in seqs {
        let mut pool = make();
        let first = take(&mut pool, a);
        let second = take(&mut pool, b);
        out.push(seq(id, family, first, second));
    }
    out
}

// ---- evaluation and scopes ----------------------------------------------------------------

struct Evaluated {
    doc: Document,
    eval: Evaluation,
}

fn load_eval(v: &Value) -> Result<Evaluated, forge_ir::v1::LoadError> {
    let loaded = load(&v.to_string())?;
    let eval = evaluate(&loaded.doc);
    Ok(Evaluated {
        doc: loaded.doc,
        eval,
    })
}

/// The scope of a part's final bodies (the scope a feature appended to the part would see).
fn part_scope(ev: &Evaluated, pi: usize) -> Scope<'_> {
    let part = &ev.doc.parts[pi];
    let table = FeatureTable::from_part(part, part.features.len());
    let mut b = ScopeBuilder::new(table);
    for pb in &ev.eval.parts[pi].bodies {
        b = b.body(&pb.body, pb.origin.clone());
    }
    b.build()
}

/// The containment tolerance for probes and their images (a few `tol`: probes lie on their
/// entity within `tol` and 10·`tol` from its boundary, §7.6).
const CONTAIN_TOL: f64 = 4.0 * LINEAR_TOLERANCE;

fn contains(s: &Scope<'_>, e: Entity, p: P3) -> bool {
    let body = s.body(e);
    match e.id {
        EntityId::Face(f) => {
            forge_refs::exact::point_on_face(body, f, p, CONTAIN_TOL).unwrap_or(false)
        }
        EntityId::Edge(x) => forge_refs::exact::point_on_edge(body, x, p, CONTAIN_TOL),
        _ => false,
    }
}

/// [`contains`], and not on the entity's boundary (a face's edges, an edge's vertices): the
/// probe of a neighbouring entity lies on this one's boundary, which is contact, not overlap.
fn contains_inside(s: &Scope<'_>, e: Entity, p: P3) -> bool {
    if !contains(s, e, p) {
        return false;
    }
    let body = s.body(e);
    match e.id {
        EntityId::Face(f) => !body
            .face_edges(f)
            .into_iter()
            .any(|x| forge_refs::exact::point_on_edge(body, x, p, CONTAIN_TOL)),
        EntityId::Edge(x) => body.edge(x).is_some_and(|edge| {
            [edge.start, edge.end]
                .into_iter()
                .flatten()
                .filter_map(|v| body.vertex(v))
                .all(|v| v.point.distance(Vec3::from(p)) > CONTAIN_TOL)
        }),
        _ => false,
    }
}

/// The entities of `kind` containing `p`.
fn entities_at(s: &Scope<'_>, kind: EntityKind, p: P3) -> BTreeSet<Entity> {
    s.entities(kind)
        .into_iter()
        .filter(|e| contains(s, *e, p))
        .collect()
}

// ---- references -----------------------------------------------------------------------------

struct Reference {
    part: usize,
    tag: String,
    kind: EntityKind,
    key: String,
    query: Value,
    entity: Entity,
    probe: P3,
    /// The capture written by the base evaluation (`None` until step 2).
    capture: Option<Value>,
    /// An authored query of a blend entity (scored although its member is broad).
    authored: bool,
}

/// A fillet's or chamfer's own face (`F/blend:{E}`, `F/bevel:{E}`, `F/corner:{V}`): the
/// feature and the role label, for `created(F, role)`.
fn blend_face(s: &Scope<'_>, e: Entity) -> Option<(String, String)> {
    if e.kind() != EntityKind::Face {
        return None;
    }
    let p = parse_key(s.key(e)).ok()?;
    let blend = s
        .table()
        .get(&p.feature)
        .is_some_and(|f| matches!(f.ty.as_str(), "fillet" | "chamfer"));
    (blend && matches!(p.label.as_str(), "blend" | "bevel" | "corner"))
        .then_some((p.feature, p.label))
}

/// `true` when `q` selects exactly `e`.
fn selects(s: &Scope<'_>, q: &Query, e: Entity) -> bool {
    eval_query(q, s).is_ok_and(|set| set.members.len() == 1 && set.members[0].entity == e)
}

/// A blend face's authored query: `created(F, role)` narrowed by world-axis `extreme` picks.
fn blend_face_query(s: &Scope<'_>, e: Entity) -> Option<Query> {
    let (feature, role) = blend_face(s, e)?;
    let base = Query::Created {
        feature,
        role: Some(role),
    };
    synthesize_query(e, s, Some(&base)).filter(|q| {
        // Only a pick over the fillet's own faces: its intent is "the blend at that corner".
        serde_json::to_string(q).is_ok_and(|j| j.contains(r#""op":"created""#))
    })
}

/// A face's query when it is a named source (every member `named`).
fn named_query(s: &Scope<'_>, f: Entity) -> Option<Query> {
    let q = synthesize_query(f, s, None)?;
    let set = eval_query(&q, s).ok()?;
    set.members.iter().all(|m| m.via == Via::Named).then_some(q)
}

/// An edge of a blend face: `between` the blend face's authored query and the other face's
/// (authored if it is a blend face too, else its named source). `None` for other edges, and
/// when that `between` does not select exactly the edge.
fn blend_edge_query(s: &Scope<'_>, e: Entity) -> Option<Query> {
    let EntityId::Edge(x) = e.id else {
        return None;
    };
    let faces: Vec<Entity> = s
        .body(e)
        .edge_faces(x)
        .into_iter()
        .map(|f| Entity {
            body: e.body,
            id: EntityId::Face(f),
        })
        .collect();
    let [fa, fb] = faces.as_slice() else {
        return None;
    };
    let side = |f: Entity| {
        if blend_face(s, f).is_some() {
            blend_face_query(s, f)
        } else {
            named_query(s, f)
        }
    };
    let q = Query::Between {
        a: Box::new(side(*fa)?),
        b: Box::new(side(*fb)?),
    };
    selects(s, &q, e).then_some(q)
}

/// `true` for a blend face or an edge of one.
fn is_blend_entity(s: &Scope<'_>, e: Entity) -> bool {
    match e.id {
        EntityId::Face(_) => blend_face(s, e).is_some(),
        EntityId::Edge(x) => s.body(e).edge_faces(x).into_iter().any(|f| {
            blend_face(
                s,
                Entity {
                    body: e.body,
                    id: EntityId::Face(f),
                },
            )
            .is_some()
        }),
        _ => false,
    }
}

fn kind_str(k: EntityKind) -> &'static str {
    match k {
        EntityKind::Face => "face",
        EntityKind::Edge => "edge",
        EntityKind::Vertex => "vertex",
        EntityKind::Body => "body",
    }
}

fn with_tags(base: &Value, refs: &[&Reference]) -> Value {
    let mut v = base.clone();
    for r in refs {
        let mut target = json!({ "kind": kind_str(r.kind), "q": r.query, "card": "one" });
        target["capture"] = r
            .capture
            .clone()
            .unwrap_or_else(|| json!({ "members": [] }));
        part_features_mut(&mut v, r.part).push(json!({
            "type": "tag", "id": r.tag, "name": r.tag, "target": target
        }));
    }
    v
}

fn tag_entry<'a>(ev: &'a Evaluated, tag: &str) -> Option<&'a RefReport> {
    ev.eval
        .features
        .iter()
        .find(|f: &&FeatureReport| f.feature_id == tag)
        .and_then(|f| f.refs.first())
}

/// Every face and edge of every part of the base, with a query that selects it exactly. The
/// entities no query could be synthesized for are listed in `report.unreferenced`
/// (`model: key`), not scored.
fn references(model: &str, base: &Evaluated, report: &mut OpsCounts) -> Vec<Reference> {
    let mut out = Vec::new();
    for pi in 0..base.doc.parts.len() {
        let s = part_scope(base, pi);
        for kind in [EntityKind::Face, EntityKind::Edge] {
            for e in s.canonical(s.entities(kind)) {
                // A pattern copy (a face keyed `P/copy:…@i`, an edge of one) narrows its instance.
                let key = s.key(e);
                let copy = copy_of(key).or_else(|| {
                    let start = key.find('{')? + 1;
                    copy_of(&key[start..key_end(key, start)]).or_else(|| {
                        let bar = key.find('|')? + 1;
                        copy_of(&key[bar..key_end(key, bar)])
                    })
                });
                let base = copy.map(|(feature, i)| {
                    let inst = Query::Instance {
                        feature,
                        index: vec![i],
                    };
                    match kind {
                        EntityKind::Edge => Query::Edges { of: Box::new(inst) },
                        _ => inst,
                    }
                });
                // A blend entity's query is authored (see the module docs, step 2).
                let authored = base.is_none() && is_blend_entity(&s, e);
                let q = if !authored {
                    synthesize_query(e, &s, base.as_ref())
                } else if kind == EntityKind::Face {
                    blend_face_query(&s, e)
                } else {
                    blend_edge_query(&s, e)
                };
                let (Some(q), Ok(probe)) = (q, s.probe(e)) else {
                    report.unreferenced.push(format!("{model}: {}", s.key(e)));
                    continue;
                };
                if authored {
                    report.blend += 1;
                }
                let tag = format!("zt{}", out.len());
                out.push(Reference {
                    part: pi,
                    tag,
                    kind,
                    key: s.key(e).to_string(),
                    query: serde_json::to_value(&q).expect("query json"),
                    entity: e,
                    probe: probe.point,
                    capture: None,
                    authored,
                });
            }
        }
    }
    out
}

/// The entity a report member designates: the one containing its probe.
fn member_entities(s: &Scope<'_>, kind: EntityKind, probe: &Probe) -> BTreeSet<Entity> {
    entities_at(s, kind, probe.point)
}

// ---- truth and scoring --------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Truth {
    Same(Entity),
    Split(BTreeSet<Entity>),
    Gone,
    Inconclusive,
}

fn truth(base: &Scope<'_>, r: &Reference, motion: Motion, mutated: &Scope<'_>) -> Truth {
    let Some(image) = motion.apply(r.probe) else {
        return Truth::Inconclusive;
    };
    let mut set = entities_at(mutated, r.kind, image);
    for e in mutated.entities(r.kind) {
        if set.contains(&e) {
            continue;
        }
        let Ok(p) = mutated.probe(e) else { continue };
        if motion
            .invert(p.point)
            .is_some_and(|q| contains_inside(base, r.entity, q))
        {
            set.insert(e);
        }
    }
    match set.len() {
        0 => Truth::Gone,
        1 => Truth::Same(*set.iter().next().expect("one")),
        _ => Truth::Split(set),
    }
}

fn truth_set(t: &Truth) -> BTreeSet<Entity> {
    match t {
        Truth::Same(e) => BTreeSet::from([*e]),
        Truth::Split(s) => s.clone(),
        Truth::Gone | Truth::Inconclusive => BTreeSet::new(),
    }
}

fn describe_truth(t: &Truth, s: &Scope<'_>) -> String {
    match t {
        Truth::Same(e) => format!("same {}", s.key(*e)),
        Truth::Split(p) => format!("split into {}", p.len()),
        Truth::Gone => "gone".into(),
        Truth::Inconclusive => "inconclusive (geometry changed)".into(),
    }
}

/// Score one reference: `(outcome, status, code, resolution in words)`.
fn score(
    t: &Truth,
    rr: Option<&RefReport>,
    kind: EntityKind,
    s: &Scope<'_>,
) -> (Outcome, RefStatus, Option<String>, String) {
    let Some(rr) = rr else {
        // Rejected statically (the document would not load with this reference).
        let o = match t {
            Truth::Inconclusive => Outcome::Excluded,
            Truth::Gone => Outcome::FlaggedCorrectly,
            _ => Outcome::WrongButFlagged,
        };
        return (
            o,
            RefStatus::Failed,
            Some("REJECTED".into()),
            "rejected".into(),
        );
    };
    if matches!(t, Truth::Inconclusive) {
        return (
            Outcome::Excluded,
            rr.status,
            rr.code.clone(),
            format!("{:?}", rr.status),
        );
    }
    let want = truth_set(t);
    match rr.status {
        RefStatus::Exact | RefStatus::Accepted => {
            let got: BTreeSet<Entity> = rr
                .members
                .iter()
                .flat_map(|m| member_entities(s, kind, &m.probe))
                .collect();
            let words = format!(
                "{} {}",
                if rr.status == RefStatus::Exact {
                    "exact"
                } else {
                    "accepted"
                },
                rr.members
                    .iter()
                    .map(|m| m.key.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let o = if !want.is_empty() && got == want {
                if rr.status == RefStatus::Exact && want.len() == 1 {
                    Outcome::Correct
                } else {
                    Outcome::FlaggedCorrectly
                }
            } else {
                Outcome::SilentWrong
            };
            (o, rr.status, rr.code.clone(), words)
        }
        RefStatus::Failed => {
            let code = rr.code.clone();
            let best = rr
                .unresolved
                .iter()
                .flat_map(|u| u.candidates.first())
                .next();
            let best_in_truth = best.is_some_and(|c| {
                let e = member_entities(s, kind, &c.probe);
                !e.is_empty() && e.is_subset(&want)
            });
            let o = if best_in_truth
                || (matches!(t, Truth::Gone) && code.as_deref() == Some("REF_MISSING"))
            {
                Outcome::FlaggedCorrectly
            } else {
                Outcome::WrongButFlagged
            };
            let words = format!(
                "failed {}{}",
                code.as_deref().unwrap_or("?"),
                best.map(|c| format!(" (best candidate {} {:.3})", c.key, c.confidence))
                    .unwrap_or_default()
            );
            (o, rr.status, code, words)
        }
    }
}

// ---- the run --------------------------------------------------------------------------------

/// Coverage gate of each Phase C family: at least this many accepted mutations — every scripted
/// mutation of the family today ((j) 6, (k) 6, (l) 5, (m) 6), so dropping one from the script
/// (or its model) turns the gate red, as a rejected one already does (`OpsCounts::skipped`).
pub fn min_family_mutations(f: V1Family) -> usize {
    match f {
        V1Family::Fillet => 5,
        _ => 6,
    }
}

/// …and this many scored references: about 90 % of today's ((j) 384, (k) 300, (l) 250, (m) 696
/// scored of 756, the 60 rotated pattern picks excluded), so a large loss of coverage — a model
/// dropped, a query family no longer synthesized, references newly excluded — is NO-GO, while
/// a small, explained change to the models only moves the counts. A family that scores nothing
/// can never pass vacuously. Raise these with the coverage (never lower them to make a run
/// pass without saying why).
pub fn min_family_scored(f: V1Family) -> usize {
    match f {
        V1Family::Boolean => 345,
        V1Family::Hole => 270,
        V1Family::Fillet => 225,
        V1Family::Pattern => 626,
        _ => 0,
    }
}

/// Coverage gate of family (l): scored references to blend entities (keys naming a fillet's or
/// chamfer's own face), so a regression in blend naming can turn the gate red (100 today).
pub const MIN_BLEND_SCORED: usize = 90;
/// Coverage gate of every run: at most this many base entities without a synthesized query
/// (`OpsCounts::unreferenced`, not scored). The Phase C models have 12 today (pinned by name in
/// `tests/harness_ops.rs`); more means `synthesize_query` lost evidence, a coverage problem.
pub const MAX_UNREFERENCED: usize = 12;
/// Coverage gate of every run: at most this many synthesized queries that do not resolve to
/// their own entity on the base (`OpsCounts::dropped`, not scored). None today: one means the
/// resolver and `synthesize_query` disagree, and its reference silently leaves the evidence.
pub const MAX_DROPPED: usize = 0;
/// Coverage gate of every run: at most this many synthesized queries whose member comes from a
/// broad source (`OpsCounts::broad`, picks, not scored here: family (i) scores their intent).
/// 10 today; more means references moved from scored named sources to unscored picks.
pub const MAX_BROAD: usize = 10;

/// `true` for the key of a blend entity: a fillet's or chamfer's own face (`F/blend:{E}`,
/// `F/bevel:{E}`, `F/corner:{V}`) or an edge that names one.
pub fn is_blend_key(key: &str) -> bool {
    ["/blend:{", "/bevel:{", "/corner:{"]
        .iter()
        .any(|r| key.contains(r))
}

/// Counts the ops run adds to the report besides the scored references.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpsCounts {
    /// Models run.
    pub models: usize,
    /// Mutations whose mutated document was rejected outright (`model/mutation: reason`).
    pub skipped: Vec<String>,
    /// Entities no query could be synthesized for (not scored), `model: key`, in model and
    /// canonical order.
    pub unreferenced: Vec<String>,
    /// Synthesized queries that did not resolve to their own entity on the base (not scored).
    pub dropped: usize,
    /// Synthesized queries whose member comes from a broad source (picks; not scored here).
    pub broad: usize,
    /// Blend entities (faces and edges) given an authored query (scored).
    pub blend: usize,
    /// References rejected statically by a mutated document (scored as rejections).
    pub rejected: usize,
}

/// Evaluate `v` with as many of `refs` as the document accepts: tags whose paths a rejection
/// names are dropped and the rest retried. Returns the evaluation and the dropped tags.
fn eval_tolerant(v: &Value, refs: &[&Reference]) -> Result<(Evaluated, BTreeSet<String>), String> {
    let mut dropped: BTreeSet<String> = BTreeSet::new();
    for _ in 0..8 {
        let kept: Vec<&Reference> = refs
            .iter()
            .copied()
            .filter(|r| !dropped.contains(&r.tag))
            .collect();
        let doc = with_tags(v, &kept);
        match load_eval(&doc) {
            Ok(ev) => return Ok((ev, dropped)),
            Err(e) => {
                let before = dropped.len();
                for err in e.errors() {
                    // `/parts/<p>/features/<i>/…`: the tag at that index, if it is one.
                    let parts: Vec<&str> = err.path.split('/').collect();
                    if let (Some(p), Some(i)) = (
                        parts.get(2).and_then(|x| x.parse::<usize>().ok()),
                        parts.get(4).and_then(|x| x.parse::<usize>().ok()),
                    ) && let Some(tag) = doc["parts"][p]["features"][i]["id"].as_str()
                        && tag.starts_with("zt")
                    {
                        dropped.insert(tag.to_string());
                    }
                }
                if dropped.len() == before {
                    return Err(e.to_string());
                }
            }
        }
    }
    Err("too many rejected references".into())
}

/// Run the Phase C families on the given models and append their records to `rep`.
pub fn run_ops_models(models: &[OpsModel], rep: &mut V1Report) -> OpsCounts {
    let mut counts = OpsCounts::default();
    for model in models {
        counts.models += 1;
        let base_v: Value = serde_json::from_str(model.json).expect("model JSON");
        let base = match load_eval(&base_v) {
            Ok(b) if b.eval.is_ok() => b,
            other => {
                rep.identity_failures.push(format!(
                    "{}: the base model does not evaluate cleanly ({})",
                    model.name,
                    other
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "feature errors".into())
                ));
                continue;
            }
        };
        let mut refs = references(model.name, &base, &mut counts);
        // Step 2: capture on the base (empty capture → the proposal carries a fresh one).
        let all: Vec<&Reference> = refs.iter().collect();
        let captured = match load_eval(&with_tags(&base_v, &all)) {
            Ok(ev) => ev,
            Err(e) => {
                rep.identity_failures
                    .push(format!("{}: tagged base rejected: {e}", model.name));
                continue;
            }
        };
        let bscopes: Vec<Scope<'_>> = (0..base.doc.parts.len())
            .map(|pi| part_scope(&base, pi))
            .collect();
        let mut keep = Vec::new();
        for mut r in refs.drain(..) {
            let s = &bscopes[r.part];
            let entry = tag_entry(&captured, &r.tag);
            let instance = r.query.to_string().contains(r#""op":"instance""#);
            if !instance
                && !r.authored
                && entry.is_some_and(|rr| rr.members.len() == 1 && rr.members[0].via == Via::Broad)
            {
                counts.broad += 1;
                continue;
            }
            let ok = entry.is_some_and(|rr| {
                rr.status != RefStatus::Failed
                    && rr.members.len() == 1
                    && member_entities(s, r.kind, &rr.members[0].probe)
                        == BTreeSet::from([r.entity])
            });
            let capture = tag_entry(&captured, &r.tag)
                .and_then(|rr| rr.proposal.as_ref())
                .and_then(|p| p.capture.as_ref())
                .map(|c| serde_json::to_value(c).expect("capture json"));
            match (ok, capture) {
                (true, Some(c)) => {
                    r.capture = Some(c);
                    if r.key.contains('#') {
                        rep.captures_with_index += 1;
                    }
                    keep.push(r);
                }
                _ => counts.dropped += 1,
            }
        }
        let refs = keep;
        let tagged: Vec<&Reference> = refs.iter().collect();
        // Step 3: identity with the captures.
        match load_eval(&with_tags(&base_v, &tagged)) {
            Ok(ev) => {
                for r in &refs {
                    let s = &bscopes[r.part];
                    let exact = tag_entry(&ev, &r.tag).is_some_and(|rr| {
                        rr.status == RefStatus::Exact
                            && rr.members.len() == 1
                            && member_entities(s, r.kind, &rr.members[0].probe)
                                == BTreeSet::from([r.entity])
                    });
                    if !exact {
                        rep.identity_failures.push(format!(
                            "{} {}: {} does not resolve exactly to itself",
                            model.name, r.tag, r.key
                        ));
                    }
                }
            }
            Err(e) => rep
                .identity_failures
                .push(format!("{}: captured base rejected: {e}", model.name)),
        }
        // Steps 4 and 5: every mutation.
        for mutation in ops_mutations(model.name) {
            let v = mutation.apply(&base_v);
            let (mutated, rejected) = match eval_tolerant(&v, &tagged) {
                Ok(x) => x,
                Err(e) => {
                    counts
                        .skipped
                        .push(format!("{}/{}: {e}", model.name, mutation.id));
                    continue;
                }
            };
            *rep.mutations.entry(mutation.family).or_default() += 1;
            counts.rejected += rejected.len();
            let mscopes: Vec<Scope<'_>> = (0..mutated.doc.parts.len())
                .map(|pi| part_scope(&mutated, pi))
                .collect();
            for r in &refs {
                let (bs, ms) = (&bscopes[r.part], &mscopes[r.part]);
                let motion = mutation.motion(&r.key);
                let rotated_pick = matches!(motion, Motion::Rotate { .. })
                    && r.query.to_string().contains(r#""op":"instance""#);
                let t = if rotated_pick {
                    Truth::Inconclusive
                } else {
                    truth(bs, r, motion, ms)
                };
                let rr = if rejected.contains(&r.tag) {
                    None
                } else {
                    tag_entry(&mutated, &r.tag)
                };
                if let Some(rr) = rr {
                    for c in rr.unresolved.iter().flat_map(|u| &u.candidates) {
                        if c.confidence >= AUTO_ACCEPT_CONFIDENCE
                            && c.reason != CandidateReason::Identical
                        {
                            rep.auto_accept_violations += 1;
                        }
                    }
                }
                let (outcome, status, code, resolution) = score(&t, rr, r.kind, ms);
                rep.refs.push(V1Record {
                    model: model.name.to_string(),
                    mutation: mutation.id.to_string(),
                    family: mutation.family,
                    entity: r.kind,
                    key: r.key.clone(),
                    query: r.query.to_string(),
                    expected: describe_truth(&t, ms),
                    status,
                    code,
                    resolution,
                    outcome,
                });
            }
        }
    }
    counts
}

/// [`run_ops_models`] on every Phase C model.
pub fn run_ops(rep: &mut V1Report) -> OpsCounts {
    run_ops_models(&ops_models(), rep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_names_finds_nested_keys_and_qualifiers() {
        let k = "f_plate/edge:{f_holes/wall@a|f_plate/cap:end@outline.bottom}";
        assert!(key_names(k, "f_holes", Some("a")));
        assert!(!key_names(k, "f_holes", Some("b")));
        assert!(key_names(k, "f_plate", None));
        assert!(!key_names("f_holes2/wall@a", "f_holes", None));
        assert!(key_names("f_holes/wall@a", "f_holes", Some("a")));
    }

    #[test]
    fn copy_of_reads_a_copys_own_key_only() {
        assert_eq!(
            copy_of("f_row/copy:{f_boss/side:ring}@2"),
            Some(("f_row".into(), 2))
        );
        assert_eq!(
            copy_of("f_row/copy:{f_bore/wall@p}@1.2"),
            Some(("f_row".into(), 1))
        );
        assert_eq!(
            copy_of("f_rail/edge:{f_rail/cap:end@rail.bottom|f_row/copy:{f_boss/side:ring}@3}"),
            None
        );
        assert_eq!(copy_of("f_boss/side:ring"), None);
    }

    #[test]
    fn instance_of_reads_the_copy_qualifier() {
        assert_eq!(
            instance_of("f_row/copy:{f_boss/side:ring}@2", "f_row"),
            Some(2)
        );
        assert_eq!(
            instance_of(
                "f_rail/edge:{f_rail/cap:end@rail.bottom|f_row/copy:{f_boss/side:ring}@3}",
                "f_row"
            ),
            Some(3)
        );
        assert_eq!(
            instance_of("f_row/copy:{f_bore/wall@p}@1.2", "f_row"),
            Some(1)
        );
        assert_eq!(instance_of("f_boss/side:ring", "f_row"), None);
    }

    #[test]
    #[allow(clippy::float_cmp)] // the corners are exact constants
    fn plate_corner_reads_the_two_sides_a_blend_key_names() {
        let face = "f_corners/blend:{f_plate/edge:{f_plate/side:outline.bottom|f_plate/side:outline.left}@outline.bottom.start}";
        assert_eq!(plate_corner(face), Some([-50.0, -30.0, 0.0]));
        // An edge of the blend: the cap's `@outline.bottom` qualifier is not a side.
        let arc = format!("f_corners/edge:{{{face}|f_plate/cap:end@outline.bottom}}");
        assert_eq!(plate_corner(&arc), Some([-50.0, -30.0, 0.0]));
        // A tangent line names one of the corner's sides again.
        let line = format!("f_corners/edge:{{{face}|f_plate/side:outline.left}}");
        assert_eq!(plate_corner(&line), Some([-50.0, -30.0, 0.0]));
        // Not a corner: one side only, or two sides along the same axis.
        assert_eq!(plate_corner("f_plate/side:outline.left"), None);
        assert_eq!(
            plate_corner("f_x/edge:{f_plate/side:outline.left|f_plate/side:outline.right}"),
            None
        );
    }

    #[test]
    fn blend_keys_are_the_fillet_and_chamfer_faces_and_their_edges() {
        assert!(is_blend_key("f_c/blend:{f_p/edge:{f_p/side:a|f_p/side:b}}"));
        assert!(is_blend_key(
            "f_c/edge:{f_c/blend:{f_p/edge:{f_p/side:a|f_p/side:b}}|f_p/cap:end@a}"
        ));
        assert!(is_blend_key("f_c/bevel:{f_p/edge:{f_p/side:a|f_p/side:b}}"));
        assert!(is_blend_key(
            "f_c/corner:{f_p/vertex:{f_p/side:a|f_p/side:b|f_p/cap:end@a}}"
        ));
        assert!(!is_blend_key("f_p/side:corner"));
        assert!(!is_blend_key("f_h/wall@a"));
    }

    #[test]
    #[allow(clippy::float_cmp)] // exactness is the point
    fn rotation_uses_exact_degree_trig() {
        // A quarter turn about Z is exact (the portable degree trig), not 6e-17 off.
        assert_eq!(rotate([1.0, 0.0, 0.0], [0.0; 3], Z, 90.0), [0.0, 1.0, 0.0]);
        assert_eq!(
            rotate([0.0, 2.0, 5.0], [0.0; 3], Z, 180.0),
            [0.0, -2.0, 5.0]
        );
    }

    #[test]
    fn motions_compose() {
        let t = Motion::Translate([1.0, 0.0, 0.0]);
        assert_eq!(compose(Motion::Same, t), t);
        assert_eq!(compose(t, Motion::Same), t);
        assert_eq!(
            compose(t, Motion::Translate([0.0, 2.0, 0.0])),
            Motion::Translate([1.0, 2.0, 0.0])
        );
        assert_eq!(compose(t, Motion::Unknown), Motion::Unknown);
    }

    #[test]
    fn motions_invert() {
        let ms = [
            Motion::Same,
            Motion::Translate([1.0, -2.0, 3.0]),
            Motion::Rotate {
                origin: [0.0, 80.0, 0.0],
                dir: Z,
                deg: -12.0,
            },
            Motion::Radial {
                origin: [3.0, 4.0, 0.0],
                dir: Z,
                from: 3.0,
                to: 3.5,
            },
        ];
        let p = [7.0, 11.0, 5.0];
        for m in ms {
            let q = m.invert(m.apply(p).unwrap()).unwrap();
            for i in 0..3 {
                assert!((q[i] - p[i]).abs() < 1e-12, "{m:?}");
            }
        }
        assert_eq!(Motion::Unknown.apply(p), None);
    }
}
