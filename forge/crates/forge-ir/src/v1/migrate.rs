//! `migrate_v0_to_v1` (SPEC-v1 §9.1 [D-59], [W0-12]) and the v0 compatibility path.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::features::*;
use super::ids;
use super::planes::{FramePlane, PlaneRef, SketchAxis};
use super::scalar::{BoolScalar, SP2, SP3, Scalar};
use super::sketch::SketchCurve;
use super::{Document, IR_SCHEMA, PartStudio};

fn s2(p: [f64; 2]) -> SP2 {
    [Scalar::Num(p[0]), Scalar::Num(p[1])]
}
fn s3(p: [f64; 3]) -> SP3 {
    [Scalar::Num(p[0]), Scalar::Num(p[1]), Scalar::Num(p[2])]
}

/// One id or name that migration rewrote because it does not match the v1 id grammar
/// ([W0-12]). `from` is the original string: untrusted data, never to be spliced into prompts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct IdRename {
    /// JSON pointer of the rewritten field in the v1 document.
    pub path: String,
    pub kind: RenameKind,
    pub from: String,
    pub to: String,
}

/// What kind of id or name was rewritten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RenameKind {
    PartId,
    PartName,
    FeatureId,
    FeatureName,
    CurveId,
}

/// What `migrate_v0_to_v1` changed beyond the schema string and sketch references.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MigrationReport {
    /// Rewritten ids and names, in document order.
    pub renames: Vec<IdRename>,
}

/// New values for the ids of one namespace, in input order (`None` = unchanged): valid ids are
/// reserved first, then each invalid one becomes `unique(sanitize(id))` in order ([W0-12]).
fn assign(items: &[&str]) -> Vec<Option<String>> {
    let mut taken: BTreeSet<String> = items
        .iter()
        .filter(|s| ids::is_id(s))
        .map(|s| s.to_string())
        .collect();
    items
        .iter()
        .map(|s| {
            if ids::is_id(s) {
                None
            } else {
                let new = ids::unique(&ids::sanitize(s), &taken);
                taken.insert(new.clone());
                Some(new)
            }
        })
        .collect()
}

/// A pure, total, deterministic function from an `aicad.ir/0` document to `aicad.ir/1`:
/// 1. `schema` becomes `"aicad.ir/1"`;
/// 2. the `sketch` field of every `extrude` and `revolve` (a sketch **name** in v0) becomes that
///    sketch's **id** — the latest earlier sketch of the same part with that name, which is the
///    one v0 evaluation uses; a name that resolves to no earlier sketch (an invalid v0 document)
///    is kept verbatim, so v1 validation reports `UNRESOLVED_SKETCH` at the same path;
/// 3. ids and names that do not match the v1 id grammar ([W0-12]: part ids and names, feature
///    ids and names, curve ids) are rewritten deterministically ([`super::ids::sanitize`] plus a
///    collision suffix); see [`migrate_v0_to_v1_report`] for the list of rewrites;
/// 4. nothing else changes: `v` is omitted (1), `op` stays `new_body`, curves and curve
///    directions are untouched, no parameters, constraints or captures are added.
pub fn migrate_v0_to_v1(doc: &crate::Document) -> Document {
    migrate_v0_to_v1_report(doc).0
}

/// [`migrate_v0_to_v1`], also returning the ids and names it rewrote.
pub fn migrate_v0_to_v1_report(doc: &crate::Document) -> (Document, MigrationReport) {
    let mut report = MigrationReport::default();
    let part_ids = assign(&doc.parts.iter().map(|p| p.id.as_str()).collect::<Vec<_>>());
    let part_names = assign(
        &doc.parts
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>(),
    );
    let all: Vec<&crate::Feature> = doc.parts.iter().flat_map(|p| &p.features).collect();
    let mut feature_ids = assign(&all.iter().map(|f| f.id()).collect::<Vec<_>>()).into_iter();
    let mut feature_names = assign(&all.iter().map(|f| f.name()).collect::<Vec<_>>()).into_iter();
    let mut parts = Vec::with_capacity(doc.parts.len());
    for (pi, p) in doc.parts.iter().enumerate() {
        let pp = format!("/parts/{pi}");
        let mut rename = |path: String, kind, from: &str, to: &Option<String>| -> String {
            match to {
                None => from.to_string(),
                Some(t) => {
                    report.renames.push(IdRename {
                        path,
                        kind,
                        from: from.to_string(),
                        to: t.clone(),
                    });
                    t.clone()
                }
            }
        };
        let id = rename(format!("{pp}/id"), RenameKind::PartId, &p.id, &part_ids[pi]);
        let name = rename(
            format!("{pp}/name"),
            RenameKind::PartName,
            &p.name,
            &part_names[pi],
        );
        let mut fids = Vec::with_capacity(p.features.len());
        for (fi, f) in p.features.iter().enumerate() {
            let fp = format!("{pp}/features/{fi}");
            let new_id = rename(
                format!("{fp}/id"),
                RenameKind::FeatureId,
                f.id(),
                &feature_ids.next().expect("one per feature"),
            );
            let new_name = rename(
                format!("{fp}/name"),
                RenameKind::FeatureName,
                f.name(),
                &feature_names.next().expect("one per feature"),
            );
            let curves = match f {
                crate::Feature::Sketch(s) => {
                    let new = assign(&s.curves.iter().map(|c| c.id()).collect::<Vec<_>>());
                    s.curves
                        .iter()
                        .zip(&new)
                        .enumerate()
                        .map(|(ci, (c, n))| {
                            rename(
                                format!("{fp}/curves/{ci}/id"),
                                RenameKind::CurveId,
                                c.id(),
                                n,
                            )
                        })
                        .collect()
                }
                _ => Vec::new(),
            };
            fids.push((new_id, new_name, curves));
        }
        parts.push(migrate_part(p, id, name, fids));
    }
    let out = Document {
        schema: IR_SCHEMA.to_string(),
        meta: doc.meta.clone(),
        units: doc.units.clone(),
        params: Vec::new(),
        parts,
    };
    (out, report)
}

fn migrate_part(
    p: &crate::PartStudio,
    id: String,
    name: String,
    new_ids: Vec<(String, String, Vec<String>)>,
) -> PartStudio {
    // v0 references sketches by name; the v1 reference is the (possibly rewritten) sketch id.
    let mut sketch_ids: BTreeMap<&str, String> = BTreeMap::new();
    let mut features = Vec::with_capacity(p.features.len());
    for (f, (fid, fname, curve_ids)) in p.features.iter().zip(new_ids) {
        let resolve = |name: &str| {
            sketch_ids
                .get(name)
                .cloned()
                .unwrap_or_else(|| name.to_string())
        };
        features.push(match f {
            crate::Feature::Sketch(s) => Feature::Sketch(SketchFeature {
                id: fid.clone(),
                name: fname,
                v: 1,
                suppressed: BoolScalar::Bool(s.suppressed),
                plane: match &s.plane {
                    crate::PlaneSpec::Named(n) => PlaneRef::Named(*n),
                    crate::PlaneSpec::Frame(fr) => PlaneRef::Frame(FramePlane {
                        origin: s3(fr.origin),
                        normal: s3(fr.normal),
                        x_dir: s3(fr.x_dir),
                    }),
                },
                curves: s
                    .curves
                    .iter()
                    .zip(curve_ids)
                    .map(|(c, cid)| migrate_curve(c, cid))
                    .collect(),
                constraints: Vec::new(),
                note: String::new(),
                intent: String::new(),
                author: String::new(),
                assumptions: Vec::new(),
                decision_ids: Vec::new(),
            }),
            crate::Feature::Extrude(e) => Feature::Extrude(ExtrudeFeature {
                id: fid.clone(),
                name: fname,
                v: 1,
                suppressed: BoolScalar::Bool(e.suppressed),
                sketch: resolve(&e.sketch),
                regions: RegionSelection::default(),
                distance: Some(Scalar::Num(e.distance)),
                extent: None,
                direction: e.direction,
                op: BodyOp::NewBody,
                targets: None,
                note: String::new(),
                intent: String::new(),
                author: String::new(),
                assumptions: Vec::new(),
                decision_ids: Vec::new(),
            }),
            crate::Feature::Revolve(r) => Feature::Revolve(RevolveFeature {
                id: fid.clone(),
                name: fname,
                v: 1,
                suppressed: BoolScalar::Bool(r.suppressed),
                sketch: resolve(&r.sketch),
                regions: RegionSelection::default(),
                axis: SketchAxis {
                    origin: s2(r.axis.origin),
                    direction: s2(r.axis.direction),
                },
                angle: Scalar::Num(r.angle),
                direction: r.direction,
                op: BodyOp::NewBody,
                targets: None,
                note: String::new(),
                intent: String::new(),
                author: String::new(),
                assumptions: Vec::new(),
                decision_ids: Vec::new(),
            }),
        });
        if let crate::Feature::Sketch(s) = f {
            sketch_ids.insert(&s.name, fid);
        }
    }
    PartStudio {
        id,
        name,
        params: Vec::new(),
        features,
    }
}

fn migrate_curve(c: &crate::SketchCurve, id: String) -> SketchCurve {
    match c {
        crate::SketchCurve::Line { start, end, .. } => SketchCurve::Line {
            id,
            start: s2(*start),
            end: s2(*end),
            construction: false,
        },
        crate::SketchCurve::Arc {
            start,
            end,
            center,
            ccw,
            ..
        } => SketchCurve::Arc {
            id,
            start: s2(*start),
            end: s2(*end),
            center: s2(*center),
            ccw: *ccw,
            construction: false,
        },
        crate::SketchCurve::Circle { center, radius, .. } => SketchCurve::Circle {
            id,
            center: s2(*center),
            radius: Scalar::Num(*radius),
            construction: false,
        },
    }
}

/// Why a v1 document cannot take the v0 compatibility path: the first construct beyond the v0
/// surface, with its JSON pointer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("not expressible in IR v0 at {path}: {what}")]
pub struct NotV0Surface {
    pub path: String,
    pub what: String,
}

/// The **v0 compatibility path**: the inverse of [`migrate_v0_to_v1`] on documents whose v1
/// surface equals v0 semantics (no parameters, expressions, points, construction or compound
/// curves, constraints, face/datum planes, region lists, body ops, non-sketch/extrude/revolve
/// features, `v ≠ 1`). Non-semantic metadata is dropped. It lets the v0 evaluator
/// (`forge-regen`, the oracle) evaluate such documents until the v1 evaluator exists, and it
/// is how the migration gate checks metric identity (`downgrade_to_v0(migrate_v0_to_v1(d)) ==
/// d` for every valid v0 document `d`).
pub fn downgrade_to_v0(doc: &Document) -> Result<crate::Document, NotV0Surface> {
    let no = |path: String, what: &str| NotV0Surface {
        path,
        what: what.to_string(),
    };
    if !doc.params.is_empty() {
        return Err(no("/params".into(), "document parameters"));
    }
    let lit = |s: &Scalar, path: String| s.literal().ok_or_else(|| no(path, "an expression"));
    let lit2 = |p: &SP2, path: &str| -> Result<[f64; 2], NotV0Surface> {
        Ok([
            lit(&p[0], format!("{path}/0"))?,
            lit(&p[1], format!("{path}/1"))?,
        ])
    };
    let lit3 = |p: &SP3, path: &str| -> Result<[f64; 3], NotV0Surface> {
        Ok([
            lit(&p[0], format!("{path}/0"))?,
            lit(&p[1], format!("{path}/1"))?,
            lit(&p[2], format!("{path}/2"))?,
        ])
    };
    let supp = |b: &BoolScalar, path: String| b.literal().ok_or_else(|| no(path, "an expression"));
    let mut parts = Vec::with_capacity(doc.parts.len());
    for (pi, p) in doc.parts.iter().enumerate() {
        let pp = format!("/parts/{pi}");
        if !p.params.is_empty() {
            return Err(no(format!("{pp}/params"), "part parameters"));
        }
        let mut names: std::collections::BTreeMap<&str, &str> = std::collections::BTreeMap::new();
        let mut features = Vec::with_capacity(p.features.len());
        for (fi, f) in p.features.iter().enumerate() {
            let fp = format!("{pp}/features/{fi}");
            if f.v() != 1 {
                return Err(no(format!("{fp}/v"), "a behavior version other than 1"));
            }
            let sketch_name = |id: &str| names.get(id).map_or(id, |n| *n).to_string();
            features.push(match f {
                Feature::Sketch(s) => {
                    if !s.constraints.is_empty() {
                        return Err(no(format!("{fp}/constraints"), "constraints"));
                    }
                    let plane = match &s.plane {
                        PlaneRef::Named(n) => crate::PlaneSpec::Named(*n),
                        PlaneRef::Frame(fr) => crate::PlaneSpec::Frame(crate::Frame {
                            origin: lit3(&fr.origin, &format!("{fp}/plane/origin"))?,
                            normal: lit3(&fr.normal, &format!("{fp}/plane/normal"))?,
                            x_dir: lit3(&fr.x_dir, &format!("{fp}/plane/x_dir"))?,
                        }),
                        _ => return Err(no(format!("{fp}/plane"), "a face or datum plane")),
                    };
                    let mut curves = Vec::with_capacity(s.curves.len());
                    for (ci, c) in s.curves.iter().enumerate() {
                        let cp = format!("{fp}/curves/{ci}");
                        if c.construction() {
                            return Err(no(format!("{cp}/construction"), "construction geometry"));
                        }
                        curves.push(match c {
                            SketchCurve::Line { id, start, end, .. } => crate::SketchCurve::Line {
                                id: id.clone(),
                                start: lit2(start, &format!("{cp}/start"))?,
                                end: lit2(end, &format!("{cp}/end"))?,
                            },
                            SketchCurve::Arc {
                                id,
                                start,
                                end,
                                center,
                                ccw,
                                ..
                            } => crate::SketchCurve::Arc {
                                id: id.clone(),
                                start: lit2(start, &format!("{cp}/start"))?,
                                end: lit2(end, &format!("{cp}/end"))?,
                                center: lit2(center, &format!("{cp}/center"))?,
                                ccw: *ccw,
                            },
                            SketchCurve::Circle {
                                id, center, radius, ..
                            } => crate::SketchCurve::Circle {
                                id: id.clone(),
                                center: lit2(center, &format!("{cp}/center"))?,
                                radius: lit(radius, format!("{cp}/radius"))?,
                            },
                            _ => return Err(no(cp, "a point or compound curve")),
                        });
                    }
                    crate::Feature::Sketch(crate::SketchFeature {
                        id: s.id.clone(),
                        name: s.name.clone(),
                        suppressed: supp(&s.suppressed, format!("{fp}/suppressed"))?,
                        plane,
                        curves,
                    })
                }
                Feature::Extrude(e) => {
                    if e.op != BodyOp::NewBody || e.targets.is_some() {
                        return Err(no(format!("{fp}/op"), "a body operation"));
                    }
                    if e.regions != RegionSelection::default() {
                        return Err(no(format!("{fp}/regions"), "a region list"));
                    }
                    if e.extent.is_some() {
                        return Err(no(format!("{fp}/extent"), "an extent"));
                    }
                    let Some(distance) = &e.distance else {
                        return Err(no(
                            format!("{fp}/distance"),
                            "an extrude without a distance",
                        ));
                    };
                    crate::Feature::Extrude(crate::ExtrudeFeature {
                        id: e.id.clone(),
                        name: e.name.clone(),
                        suppressed: supp(&e.suppressed, format!("{fp}/suppressed"))?,
                        sketch: sketch_name(&e.sketch),
                        regions: crate::RegionSelection::All,
                        distance: lit(distance, format!("{fp}/distance"))?,
                        direction: e.direction,
                        op: crate::BodyOp::NewBody,
                    })
                }
                Feature::Revolve(r) => {
                    if r.op != BodyOp::NewBody || r.targets.is_some() {
                        return Err(no(format!("{fp}/op"), "a body operation"));
                    }
                    if r.regions != RegionSelection::default() {
                        return Err(no(format!("{fp}/regions"), "a region list"));
                    }
                    crate::Feature::Revolve(crate::RevolveFeature {
                        id: r.id.clone(),
                        name: r.name.clone(),
                        suppressed: supp(&r.suppressed, format!("{fp}/suppressed"))?,
                        sketch: sketch_name(&r.sketch),
                        regions: crate::RegionSelection::All,
                        axis: crate::SketchAxis {
                            origin: lit2(&r.axis.origin, &format!("{fp}/axis/origin"))?,
                            direction: lit2(&r.axis.direction, &format!("{fp}/axis/direction"))?,
                        },
                        angle: lit(&r.angle, format!("{fp}/angle"))?,
                        direction: r.direction,
                        op: crate::BodyOp::NewBody,
                    })
                }
                other => {
                    return Err(no(
                        format!("{fp}/type"),
                        &format!("a {} feature", other.type_name()),
                    ));
                }
            });
            if let Feature::Sketch(s) = f {
                names.insert(&s.id, &s.name);
            }
        }
        parts.push(crate::PartStudio {
            id: p.id.clone(),
            name: p.name.clone(),
            features,
        });
    }
    Ok(crate::Document {
        schema: crate::IR_SCHEMA.to_string(),
        meta: doc.meta.clone(),
        units: doc.units.clone(),
        parts,
    })
}
