//! # forge-check — checks and metrics on the exact geometry
//!
//! - [`mass_properties`]: volume, area and centroid by Green's-theorem boundary
//!   integration over each face's trimmed parameter domain (no tessellation; see the
//!   `mass` module docs for the periodic-domain formulation).
//! - [`bbox`]: the tight axis-aligned box from analytic edge extremes, interior critical
//!   points of spheres and tori, and surface singular points.
//! - [`validate`]: `forge_core::topo::validate` plus closed shells, parameter-domain
//!   consistency, a positive domain area per face, per-shell orientation (a shell inside
//!   an even number of other shells encloses positive volume, inside an odd number
//!   negative: decided by point-in-shell ray casting, see the `nesting` module) and a
//!   positive total.
//! - [`body_metrics`]: the `aicad.metrics/0` numbers of one body (SPEC §5).
//!
//! Nothing here uses a tessellation. Failures are structured [`CheckError`]s with stable
//! codes; a metric is never silently approximated. Messages name entities by provenance
//! (or by shell ordinal, [`forge_core::topo::EntityNames`]), never by arena id: ids never
//! leave the process.
//!
//! # Tolerances
//! Every threshold is a named constant: [`PERIOD_EPS`] and [`SINGULAR_LINE_EPS`] for
//! parameter-space joins, [`GAP_TOLERANCE_FACTOR`] for 3D gap segments,
//! [`ZERO_VOLUME_REL`] for empty shells, [`ANGULAR_PANEL`] for the quadrature,
//! [`NESTING_GRAZING_COS`] for the shell-nesting rays.

mod bbox;
mod domain;
mod mass;
mod nesting;

use std::collections::BTreeMap;

use forge_core::linalg::{Point3, Vec3};
use forge_core::topo::{
    Body, EntityNames, FaceId, Severity, entity_name, shell_name, validate as topo_validate,
};
use forge_ir::BodyMetrics;
use thiserror::Error;

pub use bbox::curve_extreme_points;
pub use domain::{PERIOD_EPS, SINGULAR_LINE_EPS};
pub use mass::ANGULAR_PANEL;
pub use nesting::{NESTING_GRAZING_COS, RAY_DIRECTIONS};

/// A gap segment between consecutive pcurves may span at most this many times the
/// largest vertex or edge tolerance of the body in 3D: a vertex is within its tolerance
/// of each curve end, so two ends of the same vertex may be two tolerances apart; the
/// factor 4 leaves room for the curve-end rounding on top.
pub const GAP_TOLERANCE_FACTOR: f64 = 4.0;

/// A shell encloses no volume when `|V| ≤ ZERO_VOLUME_REL · A^{3/2}` (`A` its area,
/// clamped below at 1 mm²). `A^{3/2}` is the volume scale of the area (a ball of area `A`
/// holds `≈ 0.094·A^{3/2}`), and the boundary quadrature is accurate to `~1e-14`
/// relative, so `1e-12` separates a real (if thin) solid from a sheet whose two sides
/// cancel.
pub const ZERO_VOLUME_REL: f64 = 1e-12;

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
    /// A loop passes through a singular point (pole, apex) between pcurves that both run
    /// along the singular line, so the side of the domain there cannot be decided.
    #[error("face {face} meets a singular line along its pcurves; the domain side is ambiguous")]
    AmbiguousSingularJoin {
        /// Provenance name of the face.
        face: String,
    },
    /// Whether a shell lies inside another could not be decided: the point-in-shell rays
    /// were ill-conditioned or disagreed evenly (see the `nesting` module).
    #[error("cannot decide whether {shell} lies inside another shell")]
    AmbiguousNesting {
        /// Name of the shell whose nesting is undecided.
        shell: String,
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
            CheckError::AmbiguousSingularJoin { .. } => "FORGE_AMBIGUOUS_SINGULAR_JOIN",
            CheckError::AmbiguousNesting { .. } => "FORGE_AMBIGUOUS_SHELL_NESTING",
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

/// Largest distance a pcurve gap may span in 3D: [`GAP_TOLERANCE_FACTOR`] times the
/// largest vertex or edge tolerance of the body.
fn gap_tolerance(body: &Body) -> f64 {
    let t = body
        .vertices()
        .values()
        .map(|v| v.tolerance)
        .chain(body.edges().values().map(|e| e.tolerance))
        .fold(forge_core::tolerance::IR_LINEAR_TOLERANCE, f64::max);
    GAP_TOLERANCE_FACTOR * t
}

/// The integrals of one shell about a reference point.
struct ShellIntegrals {
    /// `[area, volume, Mx, My, Mz]` summed over the shell's faces.
    total: [f64; 5],
    /// Each face's `(id, domain area ∬|n| du dv)` (signed by the domain orientation).
    face_areas: Vec<(FaceId, f64)>,
}

/// Per-shell integrals about `c`.
fn shell_integrals(body: &Body, c: Point3) -> Result<Vec<ShellIntegrals>, CheckError> {
    let gap_tol = gap_tolerance(body);
    let mut out = Vec::new();
    for &sid in body.shell_ids() {
        let shell = body.shell(sid).ok_or(CheckError::Empty)?;
        let mut acc = [0.0; 5];
        let mut face_areas = Vec::with_capacity(shell.faces.len());
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
            face_areas.push((fid, q[0]));
        }
        out.push(ShellIntegrals {
            total: acc,
            face_areas,
        });
    }
    Ok(out)
}

/// Everything the metrics need, computed once: the tight box and the per-shell
/// integrals `[area, volume, Mx, My, Mz]` about the box centre.
struct Analysis {
    aabb: bbox::Aabb,
    shells: Vec<ShellIntegrals>,
    /// Per-shell tight boxes, only for bodies with several shells (they bound the
    /// nesting rays and exclude shells whose box does not hold the point).
    shell_boxes: Vec<bbox::Aabb>,
}

fn analyze(body: &Body) -> Result<Analysis, CheckError> {
    let gap_tol = gap_tolerance(body);
    let aabb = bbox::body_box(body, gap_tol)?;
    let shells = shell_integrals(body, aabb.center())?;
    let shell_boxes = if body.shell_ids().len() > 1 {
        body.shell_ids()
            .iter()
            .map(|&sid| bbox::shell_box(body, sid, gap_tol))
            .collect::<Result<_, _>>()?
    } else {
        Vec::new()
    };
    Ok(Analysis {
        aabb,
        shells,
        shell_boxes,
    })
}

impl Analysis {
    fn mass_properties(&self) -> Result<MassProps, CheckError> {
        let c = self.aabb.center();
        let mut t = [0.0; 5];
        for s in &self.shells {
            for (acc, x) in t.iter_mut().zip(&s.total) {
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

/// Validate a body: `forge_core::topo::validate`, plus
/// - every shell is declared closed (`SHELL_NOT_CLOSED`);
/// - every face's parameter domain can be reconstructed from its pcurves
///   (`FORGE_*` codes of [`CheckError`]);
/// - every face's domain has a positive area `∬|n| du dv`, signed by the orientation the
///   face's `sense` gives its loops (`FORGE_FACE_AREA_NOT_POSITIVE`: an inverted or
///   collapsed domain);
/// - every shell encloses non-zero volume (`SHELL_ZERO_VOLUME`); in a body with several
///   shells, a shell that lies inside an odd number of other shells is a cavity and must
///   enclose negative volume, every other shell (a lump, or an island inside a cavity)
///   positive volume (`FORGE_SHELL_ORIENTATION`). Containment is decided by point-in-shell
///   ray casting on the exact geometry, not by boxes: a lump in the hole of a ring lies in
///   the ring's box but outside the ring (`FORGE_AMBIGUOUS_SHELL_NESTING` if the rays
///   cannot decide);
/// - the body's signed volume is positive, i.e. faces point outwards (`NEGATIVE_VOLUME`).
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
    let topo = topo_validate(body);
    let names = (!topo.is_empty()).then(|| EntityNames::new(body));
    let mut out: Vec<Issue> = topo
        .into_iter()
        .map(|i| Issue {
            code: i.code.as_str().to_string(),
            severity: i.severity,
            entity: entity_name(body, i.entity),
            message: names
                .as_ref()
                .map_or_else(|| i.message.clone(), |n| n.rewrite(&i.message)),
        })
        .collect();
    for &sid in body.shell_ids() {
        if let Some(sh) = body.shell(sid)
            && !sh.closed
        {
            out.push(error_issue(
                "SHELL_NOT_CLOSED",
                Some(shell_name(body, sid)),
                "a solid body needs closed shells".into(),
            ));
        }
    }
    out
}

/// How many other shells contain each shell (see the `nesting` module). `signs` are the
/// signs of the shells' volumes, which tell which side of each shell its region is.
fn nesting_depths(body: &Body, a: &Analysis, signs: &[f64]) -> Result<Vec<usize>, CheckError> {
    let tol = gap_tolerance(body);
    let ids = body.shell_ids();
    let shells = ids
        .iter()
        .map(|&sid| nesting::ShellFaces::new(body, sid, tol))
        .collect::<Result<Vec<_>, _>>()?;
    let mut depths = vec![0; ids.len()];
    for (i, si) in shells.iter().enumerate() {
        let p = si.sample_point()?;
        for (j, sj) in shells.iter().enumerate() {
            if j != i
                && nesting::inside(sj, signs[j], &a.shell_boxes[j], p, tol, &|| {
                    shell_name(body, ids[i])
                })?
            {
                depths[i] += 1;
            }
        }
    }
    Ok(depths)
}

/// Domain, orientation and volume findings.
fn analysis_issues(body: &Body, analysis: Result<&Analysis, &CheckError>) -> Vec<Issue> {
    let a = match analysis {
        Ok(a) => a,
        Err(e) => return vec![error_issue(e.code(), None, e.to_string())],
    };
    let mut out = Vec::new();
    // Per face: a domain whose Green's-theorem area is not positive is inverted (its
    // loops run against the orientation its sense implies) or empty.
    for s in &a.shells {
        for &(fid, area) in &s.face_areas {
            if area.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
                out.push(error_issue(
                    "FORGE_FACE_AREA_NOT_POSITIVE",
                    body.face(fid).map(|f| f.provenance.name()),
                    format!(
                        "the face's parameter domain has area {area:e} mm²: its loops are \
                         inverted or enclose nothing"
                    ),
                ));
            }
        }
    }
    let mut total = 0.0;
    let mut signs = Vec::with_capacity(a.shells.len());
    for (s, &sid) in a.shells.iter().zip(body.shell_ids()) {
        let [area, volume, ..] = s.total;
        total += volume;
        let scale = area.max(1.0) * area.max(1.0).sqrt();
        if volume.abs() <= ZERO_VOLUME_REL * scale {
            out.push(error_issue(
                "SHELL_ZERO_VOLUME",
                Some(shell_name(body, sid)),
                format!("shell encloses no volume ({volume:e} mm³)"),
            ));
        }
        signs.push(volume.signum());
    }
    // Per-shell orientation, once every shell has a side (a zero-volume shell is
    // already an error and bounds no region).
    let sided = !out.iter().any(|i| i.code == "SHELL_ZERO_VOLUME");
    if a.shells.len() > 1 && sided {
        match nesting_depths(body, a, &signs) {
            Ok(depths) => {
                for ((s, &sid), depth) in a.shells.iter().zip(body.shell_ids()).zip(depths) {
                    let volume = s.total[1];
                    let cavity = depth % 2 == 1;
                    if cavity && volume > 0.0 {
                        out.push(error_issue(
                            "FORGE_SHELL_ORIENTATION",
                            Some(shell_name(body, sid)),
                            format!(
                                "cavity shell (inside {depth} other shell(s)) encloses \
                                 positive volume ({volume:e} mm³): its faces point into the \
                                 material"
                            ),
                        ));
                    } else if !cavity && volume < 0.0 {
                        out.push(error_issue(
                            "FORGE_SHELL_ORIENTATION",
                            Some(shell_name(body, sid)),
                            format!(
                                "outer shell (inside {depth} other shell(s)) encloses \
                                 negative volume ({volume:e} mm³): its faces point inwards"
                            ),
                        ));
                    }
                }
            }
            Err(e) => out.push(error_issue(e.code(), None, e.to_string())),
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
