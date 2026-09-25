//! STEP (ISO 10303-21 physical files, AP214 / AP242): our own B-rep **writer**, a Part 21
//! **reader** ([`parse`]) and a **verifier** of written files ([`verify_step`]).
//!
//! # Writer
//! [`write_step`] turns Forge bodies into an AP214 (default) or AP242 file:
//! - **Product structure:** one `PRODUCT` (`StepOptions::product_name`) with its
//!   definition, a `SHAPE_DEFINITION_REPRESENTATION` and one
//!   `ADVANCED_BREP_SHAPE_REPRESENTATION` holding every solid; each body becomes a
//!   `MANIFOLD_SOLID_BREP` named after it (`BREP_WITH_VOIDS` when it has cavities; a body
//!   with several lumps becomes one solid per lump). Optional body colours are written as
//!   `STYLED_ITEM`s in a `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION`.
//! - **Units:** millimetres, radians, steradians; the distance uncertainty is the largest
//!   edge/vertex tolerance of the bodies (at least 1e-6 mm, the IR's linear tolerance).
//! - **Geometry:** every Forge surface and curve with the same parametrization
//!   (see `step/geometry.rs`): planes, cylinders, cones, spheres, tori (spindle patches as
//!   `DEGENERATE_TOROIDAL_SURFACE`), (rational) B-spline surfaces; lines, circles,
//!   ellipses and (rational) B-spline curves. Forge has no surfaces of linear extrusion
//!   or revolution (they are B-splines), so none are written.
//! - **Topology:** `CLOSED_SHELL` / `ADVANCED_FACE` / `FACE_(OUTER_)BOUND` / `EDGE_LOOP` /
//!   `ORIENTED_EDGE` / `EDGE_CURVE` / `VERTEX_POINT`, with the seams, ring vertices and
//!   singular-point splits that STEP needs and Forge does not have
//!   (ADR 0012; see `step/brep.rs`).
//! - **Pcurves:** the edges of non-planar faces carry Forge's own pcurves
//!   (`SURFACE_CURVE` / `PCURVE`), moved into the written surface's parameter window, so
//!   readers integrate over exactly Forge's face domains instead of approximating them by
//!   projection; a face whose pcurves cannot all be placed gets none.
//! - **Determinism:** instances are numbered in a fixed traversal order, numbers use the
//!   shortest round-trip form, and the header carries a fixed timestamp unless the caller
//!   passes one, so the bytes are a pure function of the bodies and options on every
//!   target.
//! - **Never silently wrong:** unsupported cases are [`StepError`]s with stable codes
//!   (`STEP_UNSUPPORTED_SEAM`, `STEP_UNSUPPORTED_TOPOLOGY`, …), and the writer verifies
//!   its own output with [`verify_step`] before returning it (`STEP_SELF_CHECK`),
//!   including every face's orientation (an inside-out face or shell is refused, not
//!   left for a reader's healing to guess at; `step/orient.rs`).
//!
//! ```
//! use forge_core::topo::samples;
//! use forge_io::step::{StepBody, StepOptions, write_step, verify_step};
//!
//! let cyl = samples::cylinder(10.0, 30.0);
//! let (bytes, report) = write_step(
//!     &[StepBody { name: "cylinder", body: &cyl, color: None }],
//!     &StepOptions::default(),
//! )
//! .unwrap();
//! assert_eq!(report.bodies[0].faces, 3);
//! assert_eq!(report.bodies[0].seam_edges, 1); // the side face got a seam
//! let summary = verify_step(&bytes).unwrap();
//! assert_eq!(summary.solids[0].name, "cylinder");
//! // The verifier measures what the file bounds: π r² h.
//! assert!((summary.solids[0].volume - std::f64::consts::PI * 100.0 * 30.0).abs() < 1e-9);
//! ```
//!
//! # Reader (groundwork for import, FM7)
//! [`parse`] is a complete Part 21 lexer/parser (complex instances, typed parameters,
//! string encodings). Import proper — seam removal back into Forge's seam-free model,
//! tolerance checks, `Role::Imported` provenance — is planned (IO-7a).

mod brep;
mod geometry;
mod orient;
mod p21;
pub mod parse;
mod verify;

pub use verify::{SolidSummary, StepSummary, verify_step};

use std::collections::BTreeMap;
use std::fmt::Write;

use forge_core::topo::{Body, EdgeId, FaceId};
use thiserror::Error;

use self::p21::{Args, DataSection};

/// A STEP failure. Every variant has a stable [`StepError::code`].
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum StepError {
    /// Nothing to write.
    #[error("no bodies to write")]
    NoBodies,
    /// Invalid options (e.g. a colour component outside `[0, 1]`).
    #[error("invalid STEP options: {detail}")]
    InvalidOptions {
        /// What is wrong.
        detail: String,
    },
    /// A body is inconsistent (stale ids, missing vertices, non-finite data).
    #[error("body {body:?} cannot be written: {detail}")]
    InvalidBody {
        /// The body's name.
        body: String,
        /// What is wrong.
        detail: String,
    },
    /// A face's seam cannot be placed faithfully.
    #[error("body {body:?}, face {face}: {detail}")]
    UnsupportedSeam {
        /// The body's name.
        body: String,
        /// The face's provenance name.
        face: String,
        /// Why.
        detail: String,
    },
    /// A body's shell structure is not supported (sheets, lumps with voids).
    #[error("body {body:?}: {detail}")]
    UnsupportedTopology {
        /// The body's name.
        body: String,
        /// Why.
        detail: String,
    },
    /// Malformed Part 21 text.
    #[error("STEP syntax error at byte {offset}: {detail}")]
    Syntax {
        /// Byte offset.
        offset: usize,
        /// What is wrong.
        detail: String,
    },
    /// A file failed [`verify_step`] (for the writer's own output: an internal error).
    #[error("STEP check failed: {detail}")]
    SelfCheck {
        /// What is wrong.
        detail: String,
    },
}

impl StepError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            StepError::NoBodies => "STEP_NO_BODIES",
            StepError::InvalidOptions { .. } => "STEP_INVALID_OPTIONS",
            StepError::InvalidBody { .. } => "STEP_INVALID_BODY",
            StepError::UnsupportedSeam { .. } => "STEP_UNSUPPORTED_SEAM",
            StepError::UnsupportedTopology { .. } => "STEP_UNSUPPORTED_TOPOLOGY",
            StepError::Syntax { .. } => "STEP_SYNTAX",
            StepError::SelfCheck { .. } => "STEP_SELF_CHECK",
        }
    }
}

/// The application protocol written in `FILE_SCHEMA`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StepSchema {
    /// AP214 (`AUTOMOTIVE_DESIGN`): the most widely read.
    #[default]
    Ap214,
    /// AP242 (`AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF`).
    Ap242,
}

impl StepSchema {
    /// `"ap214"` / `"ap242"`.
    pub fn name(self) -> &'static str {
        match self {
            StepSchema::Ap214 => "ap214",
            StepSchema::Ap242 => "ap242",
        }
    }
    fn file_schema(self) -> &'static str {
        match self {
            StepSchema::Ap214 => "AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }",
            StepSchema::Ap242 => {
                "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }"
            }
        }
    }
}

/// Options of [`write_step`].
#[derive(Clone, Debug, PartialEq)]
pub struct StepOptions {
    /// Application protocol.
    pub schema: StepSchema,
    /// `PRODUCT` id and name (the part name other CAD tools show).
    pub product_name: String,
    /// `FILE_NAME.name`.
    pub file_name: String,
    /// `FILE_NAME.time_stamp` (ISO 8601). Fixed by default so the bytes are deterministic.
    pub timestamp: String,
    /// `FILE_NAME.author` (one entry; empty by default).
    pub author: String,
    /// `FILE_NAME.organization` (one entry; empty by default).
    pub organization: String,
    /// `FILE_NAME.originating_system`.
    pub originating_system: String,
    /// Write each face's provenance name as its `ADVANCED_FACE` name.
    pub face_names: bool,
}

impl Default for StepOptions {
    fn default() -> Self {
        StepOptions {
            schema: StepSchema::Ap214,
            product_name: "part".into(),
            file_name: "part.step".into(),
            timestamp: "1970-01-01T00:00:00".into(),
            author: String::new(),
            organization: String::new(),
            originating_system: "PartZero".into(),
            face_names: true,
        }
    }
}

/// One body to write.
#[derive(Clone, Copy, Debug)]
pub struct StepBody<'a> {
    /// Its name (the solid's name in the file).
    pub name: &'a str,
    /// The body (a closed Forge B-rep).
    pub body: &'a Body,
    /// Optional RGB colour, each component in `[0, 1]`.
    pub color: Option<[f64; 3]>,
}

/// What [`write_step`] wrote.
#[derive(Clone, Debug, PartialEq)]
pub struct StepReport {
    /// The schema.
    pub schema: StepSchema,
    /// Number of data instances.
    pub entities: usize,
    /// File size in bytes.
    pub bytes: usize,
    /// The distance uncertainty written (mm).
    pub uncertainty: f64,
    /// Per body, in input order.
    pub bodies: Vec<StepBodyReport>,
}

/// What one body became.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepBodyReport {
    /// Its name.
    pub name: String,
    /// Solids written (lumps).
    pub solids: usize,
    /// Void shells.
    pub voids: usize,
    /// Faces (always the body's face count).
    pub faces: usize,
    /// STEP edges (Forge edges, plus split pieces, plus seams).
    pub edges: usize,
    /// STEP vertices (Forge vertices plus synthesized ones).
    pub vertices: usize,
    /// Seam edges synthesized.
    pub seam_edges: usize,
    /// Extra edge pieces from splitting Forge edges at seams and singular points.
    pub split_pieces: usize,
    /// Vertices synthesized (ring vertices, seam crossings, poles, splits).
    pub new_vertices: usize,
}

/// Write `bodies` as one STEP part. The output is checked with [`verify_step`] before it
/// is returned.
///
/// # Errors
/// [`StepError::NoBodies`], [`StepError::InvalidOptions`] (colour out of range),
/// [`StepError::InvalidBody`], [`StepError::UnsupportedSeam`],
/// [`StepError::UnsupportedTopology`], and [`StepError::SelfCheck`] if the written file
/// fails its own check (an internal error, never a silently bad file).
pub fn write_step(
    bodies: &[StepBody<'_>],
    opts: &StepOptions,
) -> Result<(Vec<u8>, StepReport), StepError> {
    if bodies.is_empty() {
        return Err(StepError::NoBodies);
    }
    for b in bodies {
        if let Some(c) = b.color
            && !c.iter().all(|x| (0.0..=1.0).contains(x))
        {
            return Err(StepError::InvalidOptions {
                detail: format!("colour of {:?} must have components in [0, 1]", b.name),
            });
        }
    }
    let topos: Vec<brep::Topo> = bodies
        .iter()
        .map(|b| brep::build(b.body, b.name))
        .collect::<Result<_, _>>()?;
    let uncertainty = topos
        .iter()
        .map(|t| t.tolerance)
        .fold(forge_core::tolerance::IR_LINEAR_TOLERANCE, f64::max);

    let mut d = DataSection::default();
    let pds = product(&mut d, opts);
    let ctx = context(&mut d, uncertainty);
    let origin = geometry::axis2(&mut d, &forge_core::linalg::Frame::world());
    let mut items = vec![origin];
    let mut styled = Vec::new();
    let mut reports = Vec::new();
    let mut ctx2d: Option<u32> = None;
    for (b, topo) in bodies.iter().zip(&topos) {
        let solids = write_body(&mut d, b, topo, opts.face_names, &mut ctx2d);
        if let Some(c) = b.color {
            for &s in &solids {
                styled.push(style(&mut d, s, c));
            }
        }
        let used = used_vertices(topo);
        reports.push(StepBodyReport {
            name: b.name.to_string(),
            solids: solids.len(),
            voids: topo.stats.voids,
            faces: topo.faces.len(),
            edges: topo.edges.len(),
            vertices: used,
            seam_edges: topo.stats.seams,
            split_pieces: topo.stats.split_pieces,
            new_vertices: topo.stats.new_vertices,
        });
        items.extend(solids);
    }
    let absr = d.add(
        Args::new()
            .str(&opts.product_name)
            .refs(&items)
            .r(ctx)
            .entity("ADVANCED_BREP_SHAPE_REPRESENTATION"),
    );
    d.add(
        Args::new()
            .r(pds)
            .r(absr)
            .entity("SHAPE_DEFINITION_REPRESENTATION"),
    );
    if !styled.is_empty() {
        d.add(
            Args::new()
                .str("")
                .refs(&styled)
                .r(ctx)
                .entity("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION"),
        );
    }

    let mut out = String::with_capacity(64 * d.len() + 512);
    out.push_str("ISO-10303-21;\nHEADER;\n");
    let _ = writeln!(
        out,
        "{};",
        Args::new()
            .raw("('PartZero model')")
            .str("2;1")
            .entity("FILE_DESCRIPTION")
    );
    let mut author = String::new();
    p21::push_string(&mut author, &opts.author);
    let mut org = String::new();
    p21::push_string(&mut org, &opts.organization);
    let _ = writeln!(
        out,
        "{};",
        Args::new()
            .str(&opts.file_name)
            .str(&opts.timestamp)
            .raw(&format!("({author})"))
            .raw(&format!("({org})"))
            .str("forge-io STEP writer")
            .str(&opts.originating_system)
            .str("")
            .entity("FILE_NAME")
    );
    let mut schema = String::new();
    p21::push_string(&mut schema, opts.schema.file_schema());
    let _ = writeln!(out, "FILE_SCHEMA(({schema}));");
    out.push_str("ENDSEC;\n");
    d.write_to(&mut out);
    out.push_str("END-ISO-10303-21;\n");
    let bytes = out.into_bytes();

    // Never hand out a file we cannot read back consistently.
    let summary = verify_step(&bytes)?;
    let expected: Vec<(usize, usize)> = topos
        .iter()
        .flat_map(|t| {
            t.solids.iter().map(|s| {
                (
                    s.outer.len() + s.voids.iter().map(Vec::len).sum::<usize>(),
                    1 + s.voids.len(),
                )
            })
        })
        .collect();
    let got: Vec<(usize, usize)> = summary.solids.iter().map(|s| (s.faces, s.shells)).collect();
    if expected != got {
        return Err(StepError::SelfCheck {
            detail: format!("solids read back as {got:?}, written {expected:?}"),
        });
    }
    let report = StepReport {
        schema: opts.schema,
        entities: d.len(),
        bytes: bytes.len(),
        uncertainty,
        bodies: reports,
    };
    Ok((bytes, report))
}

fn used_vertices(t: &brep::Topo) -> usize {
    let mut used = vec![false; t.vertices.len()];
    for e in &t.edges {
        used[e.start] = true;
        used[e.end] = true;
    }
    used.iter().filter(|&&u| u).count()
}

/// Product structure; returns the `PRODUCT_DEFINITION_SHAPE`.
fn product(d: &mut DataSection, opts: &StepOptions) -> u32 {
    let (app, year, protocol) = match opts.schema {
        StepSchema::Ap214 => (
            "core data for automotive mechanical design processes",
            2000,
            "automotive_design",
        ),
        StepSchema::Ap242 => (
            "managed model based 3d engineering",
            2014,
            "ap242_managed_model_based_3d_engineering",
        ),
    };
    let ac = d.add(Args::new().str(app).entity("APPLICATION_CONTEXT"));
    d.add(
        Args::new()
            .str("international standard")
            .str(protocol)
            .int(year)
            .r(ac)
            .entity("APPLICATION_PROTOCOL_DEFINITION"),
    );
    let pc = d.add(
        Args::new()
            .str("")
            .r(ac)
            .str("mechanical")
            .entity("PRODUCT_CONTEXT"),
    );
    let p = d.add(
        Args::new()
            .str(&opts.product_name)
            .str(&opts.product_name)
            .str("")
            .refs(&[pc])
            .entity("PRODUCT"),
    );
    d.add(
        Args::new()
            .str("part")
            .raw("$")
            .refs(&[p])
            .entity("PRODUCT_RELATED_PRODUCT_CATEGORY"),
    );
    let pdf = d.add(
        Args::new()
            .str("")
            .str("")
            .r(p)
            .entity("PRODUCT_DEFINITION_FORMATION"),
    );
    let pdc = d.add(
        Args::new()
            .str("part definition")
            .r(ac)
            .str("design")
            .entity("PRODUCT_DEFINITION_CONTEXT"),
    );
    let pd = d.add(
        Args::new()
            .str("design")
            .str("")
            .r(pdf)
            .r(pdc)
            .entity("PRODUCT_DEFINITION"),
    );
    d.add(
        Args::new()
            .str("")
            .str("")
            .r(pd)
            .entity("PRODUCT_DEFINITION_SHAPE"),
    )
}

/// Units and the geometric representation context; returns the context.
fn context(d: &mut DataSection, uncertainty: f64) -> u32 {
    let mm = d.add("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))".to_string());
    let rad = d.add("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))".to_string());
    let sr = d.add("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())".to_string());
    let mut u = String::new();
    p21::push_real(&mut u, uncertainty);
    let unc = d.add(
        Args::new()
            .raw(&format!("LENGTH_MEASURE({u})"))
            .r(mm)
            .str("distance_accuracy_value")
            .str("confusion accuracy")
            .entity("UNCERTAINTY_MEASURE_WITH_UNIT"),
    );
    d.add(format!(
        "(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#{unc})) \
         GLOBAL_UNIT_ASSIGNED_CONTEXT((#{mm},#{rad},#{sr})) REPRESENTATION_CONTEXT('3D','3D'))"
    ))
}

/// The topology and geometry of one body; returns its solids. `ctx2d` is the parametric
/// representation context of pcurves, created on first use.
fn write_body(
    d: &mut DataSection,
    b: &StepBody<'_>,
    topo: &brep::Topo,
    face_names: bool,
    ctx2d: &mut Option<u32>,
) -> Vec<u32> {
    let body = b.body;
    // Surfaces first (pcurves name them): one per face, with its `u` origin turned.
    let surf: Vec<u32> = topo
        .faces
        .iter()
        .map(|tf| {
            let face = body.face(tf.face).expect("face of the body");
            match tf.u_origin {
                Some(a) => geometry::surface(d, &brep::rotate_u(&face.surface, a)),
                None => geometry::surface(d, &face.surface),
            }
        })
        .collect();
    let face_index: BTreeMap<FaceId, usize> = topo
        .faces
        .iter()
        .enumerate()
        .map(|(i, tf)| (tf.face, i))
        .collect();
    let with_pcurves = pcurve_faces(body, topo, &face_index);
    let mut used = vec![false; topo.vertices.len()];
    for e in &topo.edges {
        used[e.start] = true;
        used[e.end] = true;
    }
    let mut vp = vec![0u32; topo.vertices.len()];
    for (i, p) in topo.vertices.iter().enumerate() {
        if used[i] {
            let pt = d.point(*p);
            vp[i] = d.add(Args::new().str("").r(pt).entity("VERTEX_POINT"));
        }
    }
    let mut curves: BTreeMap<EdgeId, u32> = BTreeMap::new();
    let mut seams: BTreeMap<usize, u32> = BTreeMap::new();
    let mut ec = Vec::with_capacity(topo.edges.len());
    for e in &topo.edges {
        let geometry = match e.curve {
            brep::TCurve::Edge(eid) => {
                let edge = body.edge(eid).expect("edge of the body");
                let c3 = *curves
                    .entry(eid)
                    .or_insert_with(|| geometry::curve(d, &edge.curve, edge.t_range));
                let pcs = pcurves(
                    d,
                    body,
                    topo,
                    eid,
                    e.t,
                    &face_index,
                    &with_pcurves,
                    &surf,
                    ctx2d,
                );
                if pcs.is_empty() {
                    c3
                } else {
                    d.add(
                        Args::new()
                            .str("")
                            .r(c3)
                            .refs(&pcs)
                            .raw(".CURVE_3D.")
                            .entity("SURFACE_CURVE"),
                    )
                }
            }
            brep::TCurve::Seam(i) => *seams
                .entry(i)
                .or_insert_with(|| geometry::curve(d, &topo.seam_curves[i], (0.0, 0.0))),
        };
        ec.push(
            d.add(
                Args::new()
                    .str("")
                    .r(vp[e.start])
                    .r(vp[e.end])
                    .r(geometry)
                    .bool(true)
                    .entity("EDGE_CURVE"),
            ),
        );
    }
    let mut faces = Vec::with_capacity(topo.faces.len());
    for (fi, tf) in topo.faces.iter().enumerate() {
        let face = body.face(tf.face).expect("face of the body");
        let mut bounds = Vec::with_capacity(tf.bounds.len());
        for bd in &tf.bounds {
            let oes: Vec<u32> = bd
                .edges
                .iter()
                .map(|&(e, fwd)| {
                    d.add(
                        Args::new()
                            .str("")
                            .raw("*")
                            .raw("*")
                            .r(ec[e])
                            .bool(fwd)
                            .entity("ORIENTED_EDGE"),
                    )
                })
                .collect();
            let lp = d.add(Args::new().str("").refs(&oes).entity("EDGE_LOOP"));
            let kind = if bd.outer {
                "FACE_OUTER_BOUND"
            } else {
                "FACE_BOUND"
            };
            bounds.push(d.add(Args::new().str("").r(lp).bool(bd.orientation).entity(kind)));
        }
        let name = if face_names {
            face.provenance.name()
        } else {
            String::new()
        };
        faces.push(
            d.add(
                Args::new()
                    .str(&name)
                    .refs(&bounds)
                    .r(surf[fi])
                    .bool(tf.same_sense)
                    .entity("ADVANCED_FACE"),
            ),
        );
    }
    let mut out = Vec::new();
    for (k, s) in topo.solids.iter().enumerate() {
        let name = if k == 0 {
            b.name.to_string()
        } else {
            format!("{} #{}", b.name, k + 1)
        };
        let shell_of = |d: &mut DataSection, list: &[usize]| {
            let fs: Vec<u32> = list.iter().map(|&i| faces[i]).collect();
            d.add(Args::new().str("").refs(&fs).entity("CLOSED_SHELL"))
        };
        let outer = shell_of(d, &s.outer);
        if s.voids.is_empty() {
            out.push(
                d.add(
                    Args::new()
                        .str(&name)
                        .r(outer)
                        .entity("MANIFOLD_SOLID_BREP"),
                ),
            );
        } else {
            let voids: Vec<u32> = s
                .voids
                .iter()
                .map(|v| {
                    let cs = shell_of(d, v);
                    d.add(
                        Args::new()
                            .str("")
                            .raw("*")
                            .r(cs)
                            .bool(false)
                            .entity("ORIENTED_CLOSED_SHELL"),
                    )
                })
                .collect();
            out.push(
                d.add(
                    Args::new()
                        .str(&name)
                        .r(outer)
                        .refs(&voids)
                        .entity("BREP_WITH_VOIDS"),
                ),
            );
        }
    }
    out
}

/// A pcurve of one piece of a Forge edge on one face, as it is written.
enum PcurvePlacement {
    /// No pcurve needed (a plane: readers project exactly).
    NotNeeded,
    /// Cannot be written faithfully (no Forge pcurve, straddles a period, a turned
    /// ellipse): the face gets no pcurves at all.
    Unavailable,
    /// The face, the pcurve with the reader's parameter, and the `(u, v)` shift.
    Ready(usize, forge_core::geom::Curve2, (f64, f64)),
}

/// Place Forge's pcurve of coedge `cid` (on piece `t` of edge `eid`) in the written
/// surface's parameters: the parameter moved by whole periods to the range readers derive
/// from the vertices (`[0, 2π)` for a periodic curve), `u` less the face's `u` origin and by
/// whole periods so the piece lies in `[0, 2π)` (and `v` in `[v_origin, v_origin + 2π)` on a
/// ring torus).
fn place_pcurve(
    body: &Body,
    topo: &brep::Topo,
    eid: EdgeId,
    t: (f64, f64),
    cid: forge_core::topo::CoedgeId,
    face_index: &BTreeMap<FaceId, usize>,
) -> PcurvePlacement {
    use forge_core::geom::{Curve3, Surface};
    let tau = forge_core::math::TAU;
    let (Some(edge), Some(co)) = (body.edge(eid), body.coedge(cid)) else {
        return PcurvePlacement::Unavailable;
    };
    let Some(fid) = body.loop_(co.loop_id).map(|l| l.face) else {
        return PcurvePlacement::Unavailable;
    };
    let (Some(&fi), Some(face)) = (face_index.get(&fid), body.face(fid)) else {
        return PcurvePlacement::Unavailable;
    };
    if matches!(face.surface, Surface::Plane(_)) {
        return PcurvePlacement::NotNeeded;
    }
    let Some(pc) = co.pcurve.as_ref() else {
        return PcurvePlacement::Unavailable;
    };
    if let Curve3::Ellipse(el) = &edge.curve
        && el.rx() < el.ry()
    {
        // Written with its frame turned: the STEP parameter is not Forge's.
        return PcurvePlacement::Unavailable;
    }
    let tf = &topo.faces[fi];
    // Readers take a periodic curve's parameters from its vertices in [0, 2π): move the
    // pcurve's parameter by the same whole periods.
    let delta = match edge.curve.period() {
        Some(per) => {
            let mut ts = forge_core::math::rem_euclid(t.0, per);
            if ts >= per {
                ts = 0.0;
            }
            ts - t.0
        }
        None => 0.0,
    };
    let Some(pc) = reparametrize(pc, delta) else {
        return PcurvePlacement::Unavailable;
    };
    let t = (t.0 + delta, t.1 + delta);
    let q = pc.eval(0.5 * (t.0 + t.1));
    let mut shift = (0.0, 0.0);
    if let Some(a) = tf.u_origin {
        shift.0 = -a - tau * ((q.x - a) / tau).floor();
    }
    if let Some(b0) = tf.v_origin {
        shift.1 = -tau * ((q.y - b0) / tau).floor();
    }
    // The whole piece must stay inside the chosen period.
    let inside = (0..=16).all(|k| {
        let p = pc.eval(t.0 + (t.1 - t.0) * f64::from(k) / 16.0);
        let u_ok = tf.u_origin.is_none() || (-1e-9..=tau + 1e-9).contains(&(p.x + shift.0));
        let v_ok = tf
            .v_origin
            .is_none_or(|b0| (b0 - 1e-9..=b0 + tau + 1e-9).contains(&(p.y + shift.1)));
        u_ok && v_ok
    });
    if !inside || matches!(&pc, forge_core::geom::Curve2::Ellipse(e) if e.rx() < e.ry()) {
        return PcurvePlacement::Unavailable;
    }
    PcurvePlacement::Ready(fi, pc, shift)
}

/// Faces that get pcurves: every non-planar face all of whose pieces place a pcurve (a
/// reader mixing given and computed pcurves on one face could put them in different
/// periods, so a face gets all or none).
fn pcurve_faces(body: &Body, topo: &brep::Topo, face_index: &BTreeMap<FaceId, usize>) -> Vec<bool> {
    let mut ok = vec![true; topo.faces.len()];
    for e in &topo.edges {
        let brep::TCurve::Edge(eid) = e.curve else {
            continue;
        };
        let Some(edge) = body.edge(eid) else { continue };
        for &cid in &edge.coedges {
            match place_pcurve(body, topo, eid, e.t, cid, face_index) {
                PcurvePlacement::Unavailable => {
                    if let Some(fi) = body
                        .coedge(cid)
                        .and_then(|c| body.loop_(c.loop_id))
                        .and_then(|l| face_index.get(&l.face))
                    {
                        ok[*fi] = false;
                    }
                }
                PcurvePlacement::NotNeeded | PcurvePlacement::Ready(..) => {}
            }
        }
    }
    ok
}

/// The `PCURVE`s of one piece of a Forge edge: Forge's own pcurve on each adjacent
/// non-planar face that takes pcurves ([`pcurve_faces`]), placed by [`place_pcurve`], so
/// readers integrate over the same face domains Forge does instead of approximating them
/// by projection.
#[allow(clippy::too_many_arguments)]
fn pcurves(
    d: &mut DataSection,
    body: &Body,
    topo: &brep::Topo,
    eid: EdgeId,
    t: (f64, f64),
    face_index: &BTreeMap<FaceId, usize>,
    with_pcurves: &[bool],
    surf: &[u32],
    ctx2d: &mut Option<u32>,
) -> Vec<u32> {
    let Some(edge) = body.edge(eid) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for &cid in &edge.coedges {
        let PcurvePlacement::Ready(fi, pc, shift) =
            place_pcurve(body, topo, eid, t, cid, face_index)
        else {
            continue;
        };
        if !with_pcurves[fi] {
            continue;
        }
        let Some(c2) = geometry::curve2d(d, &pc, shift) else {
            continue;
        };
        let ctx = *ctx2d.get_or_insert_with(|| {
            d.add(
                "(GEOMETRIC_REPRESENTATION_CONTEXT(2) PARAMETRIC_REPRESENTATION_CONTEXT() \
                 REPRESENTATION_CONTEXT('2D SPACE',''))"
                    .to_string(),
            )
        });
        let dr = d.add(
            Args::new()
                .str("")
                .refs(&[c2])
                .r(ctx)
                .entity("DEFINITIONAL_REPRESENTATION"),
        );
        out.push(d.add(Args::new().str("").r(surf[fi]).r(dr).entity("PCURVE")));
    }
    out
}

/// `pc` with its parameter moved by `delta` (`pc'(t + delta) = pc(t)`); a circle or ellipse
/// is 2π-periodic in its parameter and `delta` a whole number of periods, so it is kept.
fn reparametrize(pc: &forge_core::geom::Curve2, delta: f64) -> Option<forge_core::geom::Curve2> {
    use forge_core::geom::{Curve2, Line2, NurbsCurve2};
    if delta == 0.0 {
        return Some(pc.clone());
    }
    match pc {
        Curve2::Line(l) => Line2::new(l.origin() - l.dir() * delta, l.dir())
            .ok()
            .map(Curve2::Line),
        Curve2::Circle(_) | Curve2::Ellipse(_) => Some(pc.clone()),
        Curve2::BSpline(n) => NurbsCurve2::new(
            n.degree(),
            n.knots().iter().map(|k| k + delta).collect(),
            n.control_points().to_vec(),
            n.weights().map(<[f64]>::to_vec),
        )
        .ok()
        .map(Curve2::BSpline),
    }
}

/// A colour for a solid; returns the `STYLED_ITEM`.
fn style(d: &mut DataSection, item: u32, c: [f64; 3]) -> u32 {
    let rgb = d.add(
        Args::new()
            .str("")
            .real(c[0])
            .real(c[1])
            .real(c[2])
            .entity("COLOUR_RGB"),
    );
    let fasc = d.add(Args::new().str("").r(rgb).entity("FILL_AREA_STYLE_COLOUR"));
    let fas = d.add(Args::new().str("").refs(&[fasc]).entity("FILL_AREA_STYLE"));
    let ssfa = d.add(Args::new().r(fas).entity("SURFACE_STYLE_FILL_AREA"));
    let sss = d.add(
        Args::new()
            .str("")
            .refs(&[ssfa])
            .entity("SURFACE_SIDE_STYLE"),
    );
    let ssu = d.add(
        Args::new()
            .raw(".BOTH.")
            .r(sss)
            .entity("SURFACE_STYLE_USAGE"),
    );
    let psa = d.add(
        Args::new()
            .refs(&[ssu])
            .entity("PRESENTATION_STYLE_ASSIGNMENT"),
    );
    d.add(
        Args::new()
            .str("color")
            .refs(&[psa])
            .r(item)
            .entity("STYLED_ITEM"),
    )
}
