//! # forge-check — checks and metrics on the exact geometry
//!
//! - [`mass_properties`]: volume, area and centroid by Green's-theorem boundary
//!   integration over each face's trimmed parameter domain (no tessellation; see the
//!   `mass` module docs for the periodic-domain formulation).
//! - [`bbox`]: the tight axis-aligned box from analytic edge extremes, interior critical
//!   points of spheres and tori, and surface singular points.
//! - [`validate`]: `forge_core::topo::validate` plus closed shells, outward orientation
//!   (positive signed volume) and parameter-domain consistency.
//! - [`body_metrics`]: the `aicad.metrics/0` numbers of one body (SPEC §5).
//!
//! Nothing here uses a tessellation. Failures are structured [`CheckError`]s with stable
//! codes; a metric is never silently approximated.

mod bbox;
mod domain;
mod mass;

use std::collections::BTreeMap;

use forge_core::linalg::{Point3, Vec3};
use forge_core::topo::{Body, EntityRef, Severity, validate as topo_validate};
use forge_ir::BodyMetrics;
use thiserror::Error;

pub use domain::PERIOD_EPS;
pub use mass::ANGULAR_PANEL;

/// A check could not be carried out on a body.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum CheckError {
    /// A coedge has no pcurve, which the boundary integration needs.
    #[error("face {face} has a coedge without a pcurve")]
    MissingPcurve {
        /// Provenance name of the face.
        face: String,
    },
    /// An id inside the body does not resolve.
    #[error("face {face} references a missing loop, coedge or edge")]
    Dangling {
        /// Provenance name of the face.
        face: String,
    },
    /// Consecutive pcurves of a loop do not meet, and the gap is not a degenerate
    /// stretch of the surface.
    #[error("the parameter-space boundary of face {face} is open (3D gap {gap:e} mm)")]
    OpenBoundary {
        /// Provenance name of the face.
        face: String,
        /// Largest 3D extent of the gap.
        gap: f64,
    },
    /// The face's domain extends to infinity or to a line where the surface does not
    /// collapse.
    #[error("face {face} has an unbounded parameter domain")]
    UnboundedDomain {
        /// Provenance name of the face.
        face: String,
    },
    /// A geometry type the check does not support yet.
    #[error("unsupported: {what}")]
    Unsupported {
        /// What is unsupported.
        what: &'static str,
    },
    /// The body has no geometry at all.
    #[error("the body is empty")]
    Empty,
    /// A computed metric is NaN or infinite.
    #[error("non-finite {what}")]
    NonFinite {
        /// The quantity.
        what: &'static str,
    },
}

impl CheckError {
    /// Stable machine-readable code (engine-prefixed: these are Forge-internal
    /// failures, SPEC §4 [R-12]).
    pub fn code(&self) -> &'static str {
        match self {
            CheckError::MissingPcurve { .. } => "FORGE_MISSING_PCURVE",
            CheckError::Dangling { .. } => "FORGE_DANGLING_REFERENCE",
            CheckError::OpenBoundary { .. } => "FORGE_OPEN_PARAMETER_BOUNDARY",
            CheckError::UnboundedDomain { .. } => "FORGE_UNBOUNDED_DOMAIN",
            CheckError::Unsupported { .. } => "FORGE_UNSUPPORTED",
            CheckError::Empty => "FORGE_EMPTY_BODY",
            CheckError::NonFinite { .. } => "FORGE_NON_FINITE",
        }
    }
}

/// Mass properties at uniform density.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MassProps {
    /// Signed volume (mm³); positive for a correctly oriented solid.
    pub volume: f64,
    /// Total face area (mm²).
    pub area: f64,
    /// Centre of mass (mm).
    pub centroid: [f64; 3],
}

/// Largest distance a pcurve gap may span in 3D: a few times the largest vertex or edge
/// tolerance of the body.
fn gap_tolerance(body: &Body) -> f64 {
    let t = body
        .vertices()
        .values()
        .map(|v| v.tolerance)
        .chain(body.edges().values().map(|e| e.tolerance))
        .fold(forge_core::tolerance::IR_LINEAR_TOLERANCE, f64::max);
    4.0 * t
}

/// Per-shell `[area, volume, Mx, My, Mz]` about `c`.
fn shell_integrals(body: &Body, c: Point3) -> Result<Vec<[f64; 5]>, CheckError> {
    let gap_tol = gap_tolerance(body);
    let mut out = Vec::new();
    for &sid in body.shell_ids() {
        let shell = body.shell(sid).ok_or(CheckError::Empty)?;
        let mut acc = [0.0; 5];
        for &fid in &shell.faces {
            let face = body.face(fid).ok_or(CheckError::Empty)?;
            let dom = domain::face_domain(body, face, gap_tol)?;
            let q = mass::face_integrals(&dom, if face.sense { 1.0 } else { -1.0 }, c).map_err(
                |e| match e {
                    CheckError::UnboundedDomain { .. } => CheckError::UnboundedDomain {
                        face: face.provenance.name(),
                    },
                    other => other,
                },
            )?;
            for i in 0..5 {
                acc[i] += q[i];
            }
        }
        out.push(acc);
    }
    Ok(out)
}

/// Everything the metrics need, computed once: the tight box and the per-shell
/// integrals `[area, volume, Mx, My, Mz]` about the box centre.
struct Analysis {
    aabb: bbox::Aabb,
    shells: Vec<[f64; 5]>,
}

fn analyze(body: &Body) -> Result<Analysis, CheckError> {
    let aabb = bbox::body_box(body, gap_tolerance(body))?;
    let shells = shell_integrals(body, aabb.center())?;
    Ok(Analysis { aabb, shells })
}

impl Analysis {
    fn mass_properties(&self) -> Result<MassProps, CheckError> {
        let c = self.aabb.center();
        let mut t = [0.0; 5];
        for s in &self.shells {
            for (acc, x) in t.iter_mut().zip(s) {
                *acc += x;
            }
        }
        let [area, volume, mx, my, mz] = t;
        if !t.iter().all(|x| x.is_finite()) {
            return Err(CheckError::NonFinite {
                what: "mass properties",
            });
        }
        let centroid = if volume.abs() > 0.0 {
            c + Vec3::new(mx, my, mz) / volume
        } else {
            c
        };
        Ok(MassProps {
            volume,
            area,
            centroid: centroid.to_array(),
        })
    }
}

/// Volume, area and centroid of a body, integrated on the exact geometry.
pub fn mass_properties(body: &Body) -> Result<MassProps, CheckError> {
    analyze(body)?.mass_properties()
}

/// Tight axis-aligned bounding box `(min, max)` of the exact geometry.
pub fn bbox(body: &Body) -> Result<([f64; 3], [f64; 3]), CheckError> {
    let b = bbox::body_box(body, gap_tolerance(body))?;
    Ok((b.min.to_array(), b.max.to_array()))
}

/// One validation finding.
#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    /// Stable code (`forge_core` issue codes, or the ones of this crate).
    pub code: String,
    /// Error or warning.
    pub severity: Severity,
    /// Provenance name of the entity concerned, if any.
    pub entity: Option<String>,
    /// Explanation.
    pub message: String,
}

impl std::fmt::Display for Issue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.entity {
            Some(e) => write!(f, "[{}] {e}: {}", self.code, self.message),
            None => write!(f, "[{}] {}", self.code, self.message),
        }
    }
}

fn entity_name(body: &Body, e: EntityRef) -> Option<String> {
    match e {
        EntityRef::Face(id) => body.face(id).map(|f| f.provenance.name()),
        EntityRef::Edge(id) => body.edge(id).map(|x| x.provenance.name()),
        EntityRef::Vertex(id) => body.vertex(id).map(|x| x.provenance.name()),
        EntityRef::Loop(id) => body
            .loop_(id)
            .and_then(|l| body.face(l.face))
            .map(|f| format!("loop of {}", f.provenance.name())),
        EntityRef::Coedge(id) => body
            .coedge(id)
            .and_then(|c| body.edge(c.edge))
            .map(|e| format!("coedge of {}", e.provenance.name())),
        EntityRef::Shell(id) => Some(format!("{id:?}")),
        EntityRef::Body => None,
    }
}

/// Validate a body: `forge_core::topo::validate`, plus
/// - every shell is declared closed (`SHELL_NOT_CLOSED`);
/// - every face's parameter domain can be reconstructed from its pcurves
///   (`FORGE_*` codes of [`CheckError`]);
/// - every shell encloses non-zero volume (`SHELL_ZERO_VOLUME`) and the body's signed
///   volume is positive, i.e. faces point outwards (`NEGATIVE_VOLUME`).
///
/// Issues are returned in a deterministic order; the body is valid when no issue has
/// [`Severity::Error`].
pub fn validate(body: &Body) -> Vec<Issue> {
    let mut out = structural_issues(body);
    if out.iter().any(|i| i.severity == Severity::Error) {
        return out;
    }
    let analysis = analyze(body);
    out.extend(analysis_issues(body, analysis.as_ref()));
    out
}

fn error_issue(code: &str, entity: Option<String>, message: String) -> Issue {
    Issue {
        code: code.to_string(),
        severity: Severity::Error,
        entity,
        message,
    }
}

/// `forge_core` validation plus the closed-shell requirement.
fn structural_issues(body: &Body) -> Vec<Issue> {
    let mut out: Vec<Issue> = topo_validate(body)
        .into_iter()
        .map(|i| Issue {
            code: i.code.as_str().to_string(),
            severity: i.severity,
            entity: entity_name(body, i.entity),
            message: i.message,
        })
        .collect();
    for &sid in body.shell_ids() {
        if let Some(sh) = body.shell(sid)
            && !sh.closed
        {
            out.push(error_issue(
                "SHELL_NOT_CLOSED",
                Some(format!("{sid:?}")),
                "a solid body needs closed shells".into(),
            ));
        }
    }
    out
}

/// Domain reconstruction and orientation findings.
fn analysis_issues(body: &Body, analysis: Result<&Analysis, &CheckError>) -> Vec<Issue> {
    let a = match analysis {
        Ok(a) => a,
        Err(e) => return vec![error_issue(e.code(), None, e.to_string())],
    };
    let mut out = Vec::new();
    let mut total = 0.0;
    for (s, sid) in a.shells.iter().zip(body.shell_ids()) {
        total += s[1];
        // Zero-volume shells: |V| negligible against area^(3/2).
        if s[1].abs() <= 1e-12 * s[0].max(1.0) * s[0].max(1.0).sqrt() {
            out.push(error_issue(
                "SHELL_ZERO_VOLUME",
                Some(format!("{sid:?}")),
                format!("shell encloses no volume ({:e} mm³)", s[1]),
            ));
        }
    }
    if total.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        out.push(error_issue(
            "NEGATIVE_VOLUME",
            None,
            format!("signed volume {total:e} mm³ is not positive: faces are oriented inwards"),
        ));
    }
    out
}

/// The `aicad.metrics/0` metrics of one body (SPEC §5). Forge has no seam or degenerate
/// edges, so every edge counts. `valid` is the result of [`validate`].
pub fn body_metrics(body: &Body) -> Result<BodyMetrics, CheckError> {
    let structural = structural_issues(body);
    let analysis = analyze(body)?;
    let mp = analysis.mass_properties()?;
    let (bmin, bmax) = (analysis.aabb.min.to_array(), analysis.aabb.max.to_array());
    let mut face_types: BTreeMap<String, u32> = BTreeMap::new();
    for f in body.faces().values() {
        *face_types
            .entry(f.surface.kind_name().to_string())
            .or_insert(0) += 1;
    }
    let mut edge_types: BTreeMap<String, u32> = BTreeMap::new();
    for e in body.edges().values() {
        *edge_types
            .entry(e.curve.kind_name().to_string())
            .or_insert(0) += 1;
    }
    let valid = !structural
        .iter()
        .chain(analysis_issues(body, Ok(&analysis)).iter())
        .any(|i| i.severity == Severity::Error);
    let c = body.counts();
    Ok(BodyMetrics {
        volume: mp.volume,
        area: mp.area,
        centroid: mp.centroid,
        bbox_min: bmin,
        bbox_max: bmax,
        faces: c.faces as u32,
        edges: c.edges as u32,
        face_types,
        edge_types,
        valid,
    })
}
