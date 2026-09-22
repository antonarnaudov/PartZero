//! Evaluation report: the metrics both Forge (`aicad eval`) and the OCCT oracle
//! (`oracle eval`) emit for the same IR document, so they can be diffed.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EvalReport {
    /// Must equal [`crate::METRICS_SCHEMA`].
    pub schema: String,
    /// Engine identifier, e.g. `forge 0.0.1` or `occt 7.8.1 (build123d 0.9)`.
    pub engine: String,
    /// Document name (meta.name, or the file stem).
    pub document: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ReportError>,
    /// One entry per non-suppressed feature, in timeline order (all part studios, in order).
    pub features: Vec<FeatureReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Error,
}

/// A machine-readable error. `code` values are stable (SCREAMING_SNAKE_CASE) and
/// shared between engines where the failure is semantic (e.g. `SKETCH_OPEN_LOOP`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReportError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeatureReport {
    pub part: String,
    pub feature: String,
    #[serde(rename = "type")]
    pub feature_type: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ReportError>,
    /// Sketch features: the regions found, in canonical region order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<RegionMetrics>,
    /// Body-creating features: the bodies created, in canonical region order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bodies: Vec<BodyMetrics>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RegionMetrics {
    /// Area in mm².
    pub area: f64,
    /// Number of boundary loops (1 outer + holes).
    pub loops: u32,
    /// Sorted ids of the curves forming the outer loop (the region's stable name).
    pub outer_curves: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BodyMetrics {
    /// mm³ — computed on the exact geometry, not on a tessellation.
    pub volume: f64,
    /// mm² — exact geometry.
    pub area: f64,
    /// Centre of mass (uniform density), mm.
    pub centroid: [f64; 3],
    /// Tight axis-aligned bounding box of the exact geometry.
    pub bbox_min: [f64; 3],
    pub bbox_max: [f64; 3],
    pub faces: u32,
    /// Edge count EXCLUDING seam edges (Forge has none; OCCT seams are not counted).
    pub edges: u32,
    /// Canonical surface types → count (`plane`, `cylinder`, `cone`, `sphere`, `torus`,
    /// `bspline`, `other`).
    pub face_types: BTreeMap<String, u32>,
    /// Canonical curve types of non-seam edges → count (`line`, `circle`, `ellipse`,
    /// `bspline`, `other`).
    pub edge_types: BTreeMap<String, u32>,
    /// Engine's own validity check (closed, oriented, no self-intersection).
    pub valid: bool,
}
