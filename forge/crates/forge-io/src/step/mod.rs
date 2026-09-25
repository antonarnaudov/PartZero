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
//!   (see [`geometry`]): planes, cylinders, cones, spheres, tori (spindle patches as
//!   `DEGENERATE_TOROIDAL_SURFACE`), (rational) B-spline surfaces; lines, circles,
//!   ellipses and (rational) B-spline curves. Forge has no surfaces of linear extrusion
//!   or revolution (they are B-splines), so none are written.
//! - **Topology:** `CLOSED_SHELL` / `ADVANCED_FACE` / `FACE_(OUTER_)BOUND` / `EDGE_LOOP` /
//!   `ORIENTED_EDGE` / `EDGE_CURVE` / `VERTEX_POINT`, with the seams, ring vertices and
//!   singular-point splits that STEP needs and Forge does not have
//!   (ADR 0012; see [`brep`]).
//! - **Determinism:** instances are numbered in a fixed traversal order, numbers use the
//!   shortest round-trip form, and the header carries a fixed timestamp unless the caller
//!   passes one, so the bytes are a pure function of the bodies and options on every
//!   target.
//! - **Never silently wrong:** unsupported cases are [`StepError`]s with stable codes
//!   (`STEP_UNSUPPORTED_SEAM`, `STEP_UNSUPPORTED_TOPOLOGY`, …), and the writer verifies
//!   its own output with [`verify_step`] before returning it (`STEP_SELF_CHECK`).
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
//! ```
//!
//! # Reader (groundwork for import, FM7)
//! [`parse`] is a complete Part 21 lexer/parser (complex instances, typed parameters,
//! string encodings). Import proper — seam removal back into Forge's seam-free model,
//! tolerance checks, `Role::Imported` provenance — is planned (IO-7a).

mod brep;
mod geometry;
mod p21;
pub mod parse;
mod verify;

pub use verify::{SolidSummary, StepSummary, verify_step};

use std::collections::BTreeMap;
use std::fmt::Write;

use forge_core::topo::{Body, EdgeId};
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
    for (b, topo) in bodies.iter().zip(&topos) {
        let solids = write_body(&mut d, b, topo, opts.face_names);
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

/// The topology and geometry of one body; returns its solids.
fn write_body(
    d: &mut DataSection,
    b: &StepBody<'_>,
    topo: &brep::Topo,
    face_names: bool,
) -> Vec<u32> {
    let body = b.body;
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
        let curve = match e.curve {
            brep::TCurve::Edge(eid) => match curves.get(&eid) {
                Some(&c) => c,
                None => {
                    let edge = body.edge(eid).expect("edge of the body");
                    let c = geometry::curve(d, &edge.curve, edge.t_range);
                    curves.insert(eid, c);
                    c
                }
            },
            brep::TCurve::Seam(i) => match seams.get(&i) {
                Some(&c) => c,
                None => {
                    let c = geometry::curve(d, &topo.seam_curves[i], (0.0, 0.0));
                    seams.insert(i, c);
                    c
                }
            },
        };
        ec.push(
            d.add(
                Args::new()
                    .str("")
                    .r(vp[e.start])
                    .r(vp[e.end])
                    .r(curve)
                    .bool(true)
                    .entity("EDGE_CURVE"),
            ),
        );
    }
    let mut faces = Vec::with_capacity(topo.faces.len());
    for tf in &topo.faces {
        let face = body.face(tf.face).expect("face of the body");
        let surf = geometry::surface(d, &face.surface);
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
                    .r(surf)
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
