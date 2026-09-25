//! Structured errors (SPEC-v1 §6.6–§6.8, §7.4, §7.5): every failure carries a stable code
//! and a `details` object with the catalogue's keys, entities named by key and display name
//! (never by arena id), and feasible ranges where they can be computed.

use serde::Serialize;
use serde_json::{Map, Value, json};
use thiserror::Error;

/// Which operation failed (selects the `FILLET_*` or `CHAMFER_*` code family).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlendOp {
    /// `fillet` (§6.6).
    Fillet,
    /// `chamfer` (§6.7).
    Chamfer,
}

impl BlendOp {
    fn prefix(self) -> &'static str {
        match self {
            BlendOp::Fillet => "FILLET",
            BlendOp::Chamfer => "CHAMFER",
        }
    }
    pub(crate) fn noun(self) -> &'static str {
        match self {
            BlendOp::Fillet => "fillet",
            BlendOp::Chamfer => "chamfer",
        }
    }
}

/// An entity named for a report: its provenance key and display name.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Named {
    /// Provenance key (SPEC §5.2).
    pub key: String,
    /// Display name (for people and agents; never stored).
    pub name: String,
}

/// Why an edge cannot be blended at all (`*_EDGE_UNSUPPORTED`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnsupportedReason {
    /// The two faces meet tangentially (the edge is `smooth`, §5.3).
    Smooth,
    /// A face is not a plane, cylinder, cone, sphere or torus.
    SurfaceType,
    /// The edge does not lie between two faces of one body.
    Boundary,
}

/// One unsupported edge.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UnsupportedEdge {
    /// Key.
    pub key: String,
    /// Display name.
    pub name: String,
    /// Why.
    pub reason: UnsupportedReason,
}

/// What limits the radius of an edge (§6.6 `limit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Limit {
    /// An adjacent face is too narrow across the edge (its own extent: another feature of the
    /// body in the blend's way is not a size limit but `*_FAILED`, W6 review round 6).
    FaceWidth,
    /// The blend runs into the blend of another edge of the set.
    AdjacentBlend,
    /// A curved face or the blend itself degenerates (a radius reaches zero).
    Curvature,
}

/// The largest radius (fillet) one failing edge accepts in the context of the whole set.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EdgeRadiusLimit {
    /// Key.
    pub key: String,
    /// Display name.
    pub name: String,
    /// Largest accepted radius (mm), rounded down to a multiple of 0.001.
    pub max_r: f64,
    /// What limits it.
    pub limit: Limit,
    /// The face where the limit was met (key), when one face is responsible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face: Option<String>,
    /// Display name of `face`, for the message (SPEC §7.4: names are for people and agents;
    /// `details` carries the key only).
    #[serde(skip)]
    pub face_name: Option<String>,
    /// The width of `face` across the edge (mm), when the limit is that face's own width and
    /// it is known in closed form — for the message, as SPEC §6.6's diagnostic shows it
    /// ("face width 6.82 at slab/side:right").
    #[serde(skip)]
    pub width: Option<f64>,
}

/// The largest distance (chamfer) one failing edge accepts in the context of the whole set.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EdgeDistanceLimit {
    /// Key.
    pub key: String,
    /// Display name.
    pub name: String,
    /// Largest accepted distance `d` (mm), rounded down to a multiple of 0.001.
    pub max_d: f64,
}

/// What limits a shell's thickness (§6.8 `limits[].reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShellLimitReason {
    /// An offset surface degenerates (a radius reaches zero).
    Curvature,
    /// Opposite walls collide (or an offset face vanishes).
    Gap,
}

/// One face that limits a shell's thickness.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ShellLimit {
    /// Face key.
    pub key: String,
    /// Display name.
    pub name: String,
    /// Why.
    pub reason: ShellLimitReason,
}

/// Why a face cannot be drafted (`DRAFT_FACE_UNSUPPORTED`, SPEC §6.9).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DraftFaceReason {
    /// The face is not a plane.
    NotPlanar,
    /// Its normal is not perpendicular to the pull direction.
    NotPerpendicular,
    /// It is not a face of the body drafted.
    NotOnBody,
}

/// One face that cannot be drafted.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UnsupportedFace {
    /// Key.
    pub key: String,
    /// Display name.
    pub name: String,
    /// Why.
    pub reason: DraftFaceReason,
}

/// A fillet, chamfer, shell or draft failure.
#[derive(Clone, Debug, PartialEq, Error)]
pub enum BlendError {
    /// A value is out of range (`INVALID_RADIUS` for a fillet radius, `INVALID_VALUE`
    /// otherwise; normally rejected before evaluation, §0.5).
    #[error("{field} = {value} is invalid: expected {expected}")]
    InvalidValue {
        /// `INVALID_RADIUS` or `INVALID_VALUE`.
        code: &'static str,
        /// The field (`r`, `d`, `d2`, `angle`, `thickness`).
        field: &'static str,
        /// The value.
        value: f64,
        /// The accepted range, worded as forge-ir's validation does (`> 0.000001`,
        /// `in (0, 90)`).
        expected: String,
    },
    /// `FILLET_RADIUS_TOO_LARGE`.
    #[error(
        "{}/{} edges failed: max feasible r = {max_feasible_r} (r = {}){}",
        edges.len(), total, num_text(*r), limit_hint(edges)
    )]
    RadiusTooLarge {
        /// Requested radius.
        r: f64,
        /// Minimum of the failing edges' `max_r`.
        max_feasible_r: f64,
        /// The failing edges.
        edges: Vec<EdgeRadiusLimit>,
        /// Number of blended edges (for the message).
        total: usize,
    },
    /// `CHAMFER_DISTANCE_TOO_LARGE`.
    #[error(
        "{}/{} edges failed: max feasible d = {max_feasible_d} (d = {}){}",
        edges.len(), total, num_text(*d), d2_hint(*d2)
    )]
    DistanceTooLarge {
        /// Requested distance.
        d: f64,
        /// Minimum of the failing edges' `max_d`.
        max_feasible_d: f64,
        /// The failing edges.
        edges: Vec<EdgeDistanceLimit>,
        /// Number of chamfered edges (for the message).
        total: usize,
        /// Two-distance form: the requested `d2` and the `d2` that goes with
        /// `max_feasible_d` (both distances scale together). In the message only: the
        /// SPEC's details have no key for it (see the contract issue in the W6 report).
        d2: Option<(f64, f64)>,
    },
    /// `FILLET_EDGE_UNSUPPORTED` / `CHAMFER_EDGE_UNSUPPORTED`.
    #[error("{} edge(s) cannot be blended: {}", edges.len(), unsupported_list(edges))]
    EdgeUnsupported {
        /// Fillet or chamfer.
        op: BlendOp,
        /// The edges and reasons.
        edges: Vec<UnsupportedEdge>,
    },
    /// `CHAMFER_SIDE_NOT_ADJACENT`.
    #[error("the chamfer side face is not adjacent to {} edge(s)", edges.len())]
    SideNotAdjacent {
        /// Edges the side face does not bound.
        edges: Vec<Named>,
    },
    /// `FILLET_FAILED` / `CHAMFER_FAILED`: the configuration cannot be built (explained in
    /// `reason`), never a wrong body.
    #[error("{} failed: {reason}", op.noun())]
    Failed {
        /// Fillet or chamfer.
        op: BlendOp,
        /// The edges involved.
        edges: Vec<Named>,
        /// What could not be built, with entity names.
        reason: String,
    },
    /// `SHELL_THICKNESS_TOO_LARGE`: the requested thickness is **proven** infeasible (an
    /// offset surface degenerates or walls collide, SPEC §6.8).
    #[error(
        "shell thickness {} is too large{}{}",
        num_text(*thickness),
        max_hint(*max_feasible_thickness),
        note.as_ref().map_or(String::new(), |n| format!(" ({n})"))
    )]
    ThicknessTooLarge {
        /// Requested thickness.
        thickness: f64,
        /// Largest thickness that succeeds, rounded down to 0.001, when confirmed: it was
        /// built, and `max + 0.001` and `1.01·max` were proven infeasible. Absent otherwise
        /// (SPEC §6.8 makes it optional).
        max_feasible_thickness: Option<f64>,
        /// Faces that limit it (proven violations only).
        limits: Vec<ShellLimit>,
        /// Why no maximum is given, when the search could not confirm one (message only; the
        /// SPEC's details have no key for it).
        note: Option<String>,
    },
    /// `SHELL_FACE_NOT_ON_BODY`.
    #[error("{} open face(s) are not faces of the body", faces.len())]
    FaceNotOnBody {
        /// The faces (keys).
        faces: Vec<String>,
    },
    /// `SHELL_FAILED`.
    #[error("shell failed: {reason}")]
    ShellFailed {
        /// What could not be built.
        reason: String,
    },
    /// `DRAFT_FACE_UNSUPPORTED` (SPEC §6.9): a face that is not planar, not perpendicular to
    /// the pull direction, or not on the body.
    #[error("{} face(s) cannot be drafted: {}", faces.len(), draft_list(faces))]
    DraftFaceUnsupported {
        /// The faces and reasons.
        faces: Vec<UnsupportedFace>,
    },
    /// `DRAFT_FAILED`: the configuration cannot be built (explained in `reason`), never a
    /// wrong body.
    #[error("draft failed: {reason}")]
    DraftFailed {
        /// The drafted faces.
        faces: Vec<Named>,
        /// What could not be built, with entity names.
        reason: String,
    },
}

fn draft_list(faces: &[UnsupportedFace]) -> String {
    faces
        .iter()
        .map(|f| {
            let r = match f.reason {
                DraftFaceReason::NotPlanar => "not planar",
                DraftFaceReason::NotPerpendicular => "not perpendicular to the pull direction",
                DraftFaceReason::NotOnBody => "not on the body",
            };
            format!("{} ({r})", f.name)
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn limit_hint(edges: &[EdgeRadiusLimit]) -> String {
    let Some(e) = edges.iter().min_by(|a, b| a.max_r.total_cmp(&b.max_r)) else {
        return String::new();
    };
    let what = match (e.limit, e.width) {
        (Limit::FaceWidth, Some(w)) => format!("face width {}", mm_text(w)),
        (Limit::FaceWidth, None) => "face width".to_string(),
        (Limit::AdjacentBlend, _) => "adjacent blend".to_string(),
        (Limit::Curvature, _) => "curvature".to_string(),
    };
    match e.face_name.as_ref().or(e.face.as_ref()) {
        Some(f) => format!(" ({what} at {f}, edge {})", e.name),
        None => format!(" ({what}, edge {})", e.name),
    }
}

/// A requested value for a message: as given, in scientific notation when it is huge (a radius
/// of 1e300 printed as 301 digits helps no one).
fn num_text(x: f64) -> String {
    if x.is_finite() && x.abs() >= 1e7 {
        format!("{x:e}")
    } else {
        format!("{x}")
    }
}

/// A length for a message: rounded to the nearest 0.001 mm, without trailing zeros (a
/// measurement, not a suggested value: those are rounded down, [`round_down_mm`]).
fn mm_text(x: f64) -> String {
    let r = (x * 1000.0).round() / 1000.0;
    let s = format!("{r:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

fn unsupported_list(edges: &[UnsupportedEdge]) -> String {
    edges
        .iter()
        .map(|e| {
            let r = match e.reason {
                UnsupportedReason::Smooth => "smooth",
                UnsupportedReason::SurfaceType => "surface-type",
                UnsupportedReason::Boundary => "boundary",
            };
            format!("{} ({r})", e.name)
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn d2_hint(d2: Option<(f64, f64)>) -> String {
    d2.map_or_else(String::new, |(asked, max)| {
        format!(" with d2 = {max} (d2 = {asked}; both distances scale together)")
    })
}

fn max_hint(m: Option<f64>) -> String {
    m.map_or_else(String::new, |m| format!(": max feasible thickness = {m}"))
}

impl BlendError {
    /// The stable code (SPEC §7.5).
    pub fn code(&self) -> String {
        match self {
            BlendError::InvalidValue { code, .. } => (*code).to_string(),
            BlendError::RadiusTooLarge { .. } => "FILLET_RADIUS_TOO_LARGE".into(),
            BlendError::DistanceTooLarge { .. } => "CHAMFER_DISTANCE_TOO_LARGE".into(),
            BlendError::EdgeUnsupported { op, .. } => format!("{}_EDGE_UNSUPPORTED", op.prefix()),
            BlendError::SideNotAdjacent { .. } => "CHAMFER_SIDE_NOT_ADJACENT".into(),
            BlendError::Failed { op, .. } => format!("{}_FAILED", op.prefix()),
            BlendError::ThicknessTooLarge { .. } => "SHELL_THICKNESS_TOO_LARGE".into(),
            BlendError::FaceNotOnBody { .. } => "SHELL_FACE_NOT_ON_BODY".into(),
            BlendError::ShellFailed { .. } => "SHELL_FAILED".into(),
            BlendError::DraftFaceUnsupported { .. } => "DRAFT_FACE_UNSUPPORTED".into(),
            BlendError::DraftFailed { .. } => "DRAFT_FAILED".into(),
        }
    }

    /// The `details` object, with the keys of the error-code catalogue.
    pub fn details(&self) -> Map<String, Value> {
        let v = match self {
            BlendError::InvalidValue {
                field,
                value,
                expected,
                ..
            } => json!({ "field": field, "value": value, "expected": expected }),
            BlendError::RadiusTooLarge {
                r,
                max_feasible_r,
                edges,
                ..
            } => json!({ "r": r, "max_feasible_r": max_feasible_r, "edges": edges }),
            BlendError::DistanceTooLarge {
                d,
                max_feasible_d,
                edges,
                ..
            } => json!({ "d": d, "max_feasible_d": max_feasible_d, "edges": edges }),
            BlendError::EdgeUnsupported { edges, .. } => json!({ "edges": edges }),
            BlendError::SideNotAdjacent { edges } => json!({ "edges": edges }),
            BlendError::Failed { edges, reason, .. } => json!({ "edges": edges, "reason": reason }),
            BlendError::ThicknessTooLarge {
                thickness,
                max_feasible_thickness,
                limits,
                ..
            } => {
                let mut m = json!({ "thickness": thickness, "limits": limits });
                if let Some(x) = max_feasible_thickness {
                    m["max_feasible_thickness"] = json!(x);
                }
                m
            }
            BlendError::FaceNotOnBody { faces } => json!({ "faces": faces }),
            BlendError::ShellFailed { reason } => json!({ "reason": reason }),
            BlendError::DraftFaceUnsupported { faces } => json!({ "faces": faces }),
            BlendError::DraftFailed { faces, reason } => {
                json!({ "faces": faces, "reason": reason })
            }
        };
        match v {
            Value::Object(m) => m,
            _ => Map::new(),
        }
    }

    /// As an I5 report error.
    pub fn to_report(&self) -> forge_ir::v1::metrics::ReportError {
        forge_ir::v1::metrics::ReportError {
            code: self.code(),
            message: self.to_string(),
            details: self.details(),
        }
    }
}

/// Round a feasible value **down** to a multiple of 0.001 mm (SPEC §6.6: a suggested value
/// is then safe to apply). Negative and non-finite inputs give 0.
pub fn round_down_mm(x: f64) -> f64 {
    if !(x.is_finite() && x > 0.0) {
        return 0.0;
    }
    let k = (x * 1000.0).floor();
    // `k / 1000` can round above `x` by an ulp; step down in that case.
    let v = k / 1000.0;
    if v > x {
        (k - 1.0).max(0.0) / 1000.0
    } else {
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_follow_the_catalogue() {
        let e = BlendError::Failed {
            op: BlendOp::Chamfer,
            edges: vec![],
            reason: "x".into(),
        };
        assert_eq!(e.code(), "CHAMFER_FAILED");
        let e = BlendError::EdgeUnsupported {
            op: BlendOp::Fillet,
            edges: vec![],
        };
        assert_eq!(e.code(), "FILLET_EDGE_UNSUPPORTED");
        for c in [
            "FILLET_RADIUS_TOO_LARGE",
            "FILLET_EDGE_UNSUPPORTED",
            "FILLET_FAILED",
            "CHAMFER_DISTANCE_TOO_LARGE",
            "CHAMFER_EDGE_UNSUPPORTED",
            "CHAMFER_SIDE_NOT_ADJACENT",
            "CHAMFER_FAILED",
            "SHELL_THICKNESS_TOO_LARGE",
            "SHELL_FACE_NOT_ON_BODY",
            "SHELL_FAILED",
            "DRAFT_FACE_UNSUPPORTED",
            "DRAFT_FAILED",
        ] {
            assert!(
                forge_ir::v1::codes::CATALOGUE.iter().any(|x| x.code == c),
                "{c} is in the catalogue"
            );
        }
    }

    #[test]
    fn radius_details_carry_the_catalogue_keys() {
        let e = BlendError::RadiusTooLarge {
            r: 4.0,
            max_feasible_r: 3.41,
            edges: vec![EdgeRadiusLimit {
                key: "e1/edge:{a|b}".into(),
                name: "slab/edge".into(),
                max_r: 3.41,
                limit: Limit::FaceWidth,
                face: Some("e1/side:right".into()),
                face_name: Some("slab/side:right".into()),
                width: Some(6.82),
            }],
            total: 4,
        };
        let d = e.details();
        let mut keys: Vec<&str> = d.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["edges", "max_feasible_r", "r"]);
        assert_eq!(d["edges"][0]["limit"], "face-width");
        // The display name and the width are in the message only (SPEC §6.6's diagnostic);
        // `details` names the face by key.
        assert_eq!(d["edges"][0]["face"], "e1/side:right");
        assert!(d["edges"][0].get("face_name").is_none());
        assert!(d["edges"][0].get("width").is_none());
        let m = e.to_string();
        assert!(m.contains("max feasible r = 3.41"), "{m}");
        assert!(
            m.contains("(face width 6.82 at slab/side:right, edge slab/edge)"),
            "{m}"
        );
    }

    #[test]
    fn huge_requested_values_print_in_scientific_notation() {
        assert_eq!(num_text(1e300), "1e300");
        assert_eq!(num_text(4.0), "4");
        assert_eq!(num_text(9.99999), "9.99999");
    }

    #[test]
    fn lengths_in_messages_drop_trailing_zeros() {
        assert_eq!(mm_text(6.82), "6.82");
        assert_eq!(mm_text(10.0), "10");
        assert_eq!(mm_text(3.4096), "3.41");
        assert_eq!(mm_text(0.0004), "0");
    }

    #[test]
    fn rounding_is_downward_to_micrometres() {
        // Bit-exact: the rounded values are the doubles nearest the decimal literals.
        assert_eq!(round_down_mm(3.4199999).to_bits(), 3.419f64.to_bits());
        assert_eq!(round_down_mm(3.41).to_bits(), 3.41f64.to_bits());
        assert!(round_down_mm(3.41) <= 3.41);
        assert_eq!(round_down_mm(-1.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(round_down_mm(f64::NAN).to_bits(), 0.0f64.to_bits());
        for i in 1..2000 {
            let x = i as f64 * 0.0137;
            let y = round_down_mm(x);
            assert!(y <= x && x - y < 0.001 + 1e-12, "{x} -> {y}");
        }
    }
}
