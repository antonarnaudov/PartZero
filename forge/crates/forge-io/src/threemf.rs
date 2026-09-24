//! 3MF (3D Manufacturing Format, core specification 1.3): writer, reader and structural
//! validator.
//!
//! # Package written
//! An OPC zip ([`crate::zip`], deterministic: sorted entries, fixed timestamps) with
//! exactly three parts:
//! - `[Content_Types].xml`: defaults for `rels` and `model`;
//! - `_rels/.rels`: one relationship of type
//!   `http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel` targeting
//!   `/3D/3dmodel.model`;
//! - `3D/3dmodel.model`: `<model unit="millimeter">` in the core namespace with an
//!   `Application` metadata entry (and `Title` when given, see [`ThreeMfOptions`]), one
//!   `<object type="model" name="…">` per body (ids 1, 2, … in input order) holding its
//!   shared-vertex mesh, and one build `<item>` per object, with a `transform` when a
//!   translation is given (centring on a printer bed, [`crate::place_on_bed`]).
//!
//! Coordinates are written in shortest round-trip decimal form, so a written file reads
//! back to the exact same `f64` positions.
//!
//! # Reader and validator
//! [`read_3mf`] resolves the model part through the root relationships and parses it
//! with our strict XML parser. [`validate_3mf`] additionally checks the package
//! structure (content types, relationship target present) and the model rules this
//! crate relies on (unique object ids, triangle indices in range and distinct, build
//! items referencing mesh objects). Component objects and extensions are reported as
//! unsupported rather than skipped silently.

use std::collections::{BTreeMap, BTreeSet};

use forge_mesh::BodyMesh;

use crate::IoError;
use crate::bed::{Aabb, transform_attr};
use crate::num::push_f64;
use crate::stl::check_mesh;
use crate::xml::{self, Element, escape};
use crate::zip;

/// The 3MF core namespace.
pub const CORE_NS: &str = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
/// Relationship type of the 3D model part.
pub const MODEL_REL_TYPE: &str = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
/// Content type of the 3D model part.
pub const MODEL_CONTENT_TYPE: &str = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
/// Content type of relationship parts.
pub const RELS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-package.relationships+xml";
const MODEL_PART: &str = "3D/3dmodel.model";
const UNITS: [&str; 6] = [
    "micron",
    "millimeter",
    "centimeter",
    "inch",
    "foot",
    "meter",
];

fn content_types() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n\
 <Default Extension=\"rels\" ContentType=\"{RELS_CONTENT_TYPE}\"/>\n\
 <Default Extension=\"model\" ContentType=\"{MODEL_CONTENT_TYPE}\"/>\n\
</Types>\n"
    )
}

fn root_rels() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n\
 <Relationship Target=\"/{MODEL_PART}\" Id=\"rel0\" Type=\"{MODEL_REL_TYPE}\"/>\n\
</Relationships>\n"
    )
}

fn model_xml(bodies: &[(&str, &BodyMesh)], opts: &ThreeMfOptions) -> String {
    let tris: usize = bodies.iter().map(|b| b.1.triangles.len()).sum();
    let verts: usize = bodies.iter().map(|b| b.1.positions.len()).sum();
    let mut s = String::with_capacity(256 + 64 * verts + 48 * tris);
    s.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    s.push_str(&format!(
        "<model unit=\"millimeter\" xml:lang=\"en-US\" xmlns=\"{CORE_NS}\">\n"
    ));
    s.push_str(&format!(
        " <metadata name=\"Application\">{}</metadata>\n",
        escape(opts.application.as_deref().unwrap_or(DEFAULT_APPLICATION))
    ));
    if let Some(title) = &opts.title {
        s.push_str(&format!(
            " <metadata name=\"Title\">{}</metadata>\n",
            escape(title)
        ));
    }
    s.push_str(" <resources>\n");
    for (i, (name, m)) in bodies.iter().enumerate() {
        s.push_str(&format!(
            "  <object id=\"{}\" type=\"model\" name=\"{}\">\n   <mesh>\n    <vertices>\n",
            i + 1,
            escape(name)
        ));
        for p in &m.positions {
            s.push_str("     <vertex x=\"");
            push_f64(&mut s, p[0]);
            s.push_str("\" y=\"");
            push_f64(&mut s, p[1]);
            s.push_str("\" z=\"");
            push_f64(&mut s, p[2]);
            s.push_str("\"/>\n");
        }
        s.push_str("    </vertices>\n    <triangles>\n");
        for t in &m.triangles {
            s.push_str(&format!(
                "     <triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>\n",
                t[0], t[1], t[2]
            ));
        }
        s.push_str("    </triangles>\n   </mesh>\n  </object>\n");
    }
    s.push_str(" </resources>\n <build>\n");
    let transform = opts
        .translation
        .map(|t| format!(" transform=\"{}\"", transform_attr(t)))
        .unwrap_or_default();
    for i in 0..bodies.len() {
        s.push_str(&format!("  <item objectid=\"{}\"{transform}/>\n", i + 1));
    }
    s.push_str(" </build>\n</model>\n");
    s
}

/// The `Application` metadata written when [`ThreeMfOptions::application`] is `None`.
pub const DEFAULT_APPLICATION: &str = "forge-io";

/// Options of [`try_write_3mf_with`]. The default writes exactly what [`write_3mf`] writes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ThreeMfOptions {
    /// Model-level `Title` metadata (e.g. the document name); omitted when `None`.
    pub title: Option<String>,
    /// Model-level `Application` metadata (e.g. `PartZero 0.0.1`); [`DEFAULT_APPLICATION`]
    /// when `None`.
    pub application: Option<String>,
    /// A translation stored as the `transform` of every build item (the vertices are written
    /// unchanged), e.g. [`crate::BedPlacement::translation`]; no `transform` when `None`.
    pub translation: Option<[f64; 3]>,
}

/// Write a 3MF package with one object per named body; fails on invalid meshes or a
/// part larger than 4 GiB (no ZIP64).
pub fn try_write_3mf(bodies: &[(&str, &BodyMesh)]) -> Result<Vec<u8>, IoError> {
    try_write_3mf_with(bodies, &ThreeMfOptions::default())
}

/// [`try_write_3mf`] with metadata and a build-item translation (see [`ThreeMfOptions`]);
/// also fails on a non-finite translation.
pub fn try_write_3mf_with(
    bodies: &[(&str, &BodyMesh)],
    opts: &ThreeMfOptions,
) -> Result<Vec<u8>, IoError> {
    for (i, (_, m)) in bodies.iter().enumerate() {
        check_mesh(m, i)?;
    }
    if let Some(t) = opts.translation
        && t.iter().any(|v| !v.is_finite())
    {
        return Err(tmf("the build translation is not finite"));
    }
    let ct = content_types();
    let rels = root_rels();
    let model = model_xml(bodies, opts);
    zip::write_zip(&[
        ("[Content_Types].xml", ct.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        (MODEL_PART, model.as_bytes()),
    ])
}

/// Write a 3MF package (see the module docs) with one object per `(name, mesh)`.
///
/// # Panics
/// If a mesh has out-of-range indices or non-finite coordinates (never the case for
/// meshes from `forge_mesh::tessellate`), or the model part exceeds 4 GiB. Use
/// [`try_write_3mf`] for untrusted meshes.
pub fn write_3mf(bodies: &[(&str, &BodyMesh)]) -> Vec<u8> {
    match try_write_3mf(bodies) {
        Ok(v) => v,
        Err(e) => panic!("write_3mf: {e}"),
    }
}

/// A mesh object read from a 3MF model.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object3mf {
    /// Resource id.
    pub id: u32,
    /// `name` attribute.
    pub name: Option<String>,
    /// Object type (`model`, `support`, …).
    pub object_type: String,
    /// Vertex positions (in the model unit).
    pub vertices: Vec<[f64; 3]>,
    /// Triangles (indices into `vertices`).
    pub triangles: Vec<[u32; 3]>,
}

/// A build item.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BuildItem3mf {
    /// Referenced object id.
    pub object_id: u32,
    /// Raw `transform` attribute, if any.
    pub transform: Option<String>,
}

impl BuildItem3mf {
    /// The item's `transform` as 12 numbers ([`parse_3mf_transform`]; the identity when the
    /// attribute is absent).
    pub fn matrix(&self) -> Result<[f64; 12], IoError> {
        parse_3mf_transform(self.transform.as_deref())
    }
}

/// The identity `ST_Matrix3D`.
pub const IDENTITY_3MF_TRANSFORM: [f64; 12] =
    [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0];

/// Parse a 3MF `transform` attribute (`ST_Matrix3D`: 12 finite numbers
/// `m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32`); `None` is the identity.
pub fn parse_3mf_transform(attr: Option<&str>) -> Result<[f64; 12], IoError> {
    let Some(text) = attr else {
        return Ok(IDENTITY_3MF_TRANSFORM);
    };
    let values: Vec<f64> = text
        .split_ascii_whitespace()
        .map(|t| t.parse::<f64>().ok().filter(|v| v.is_finite()))
        .collect::<Option<Vec<f64>>>()
        .ok_or_else(|| tmf(format!("invalid transform {text:?}")))?;
    <[f64; 12]>::try_from(values).map_err(|_| tmf(format!("a transform has 12 numbers: {text:?}")))
}

/// Apply a 3MF matrix to a point (row vector convention of 3MF core §3.3: `p' = p · M`,
/// `m30 m31 m32` being the translation).
pub fn apply_3mf_transform(m: &[f64; 12], p: [f64; 3]) -> [f64; 3] {
    [
        p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9],
        p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10],
        p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11],
    ]
}

/// A parsed 3MF model.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Model3mf {
    /// Unit of the model (`millimeter`, …).
    pub unit: String,
    /// Model-level metadata `(name, value)` in document order.
    pub metadata: Vec<(String, String)>,
    /// Mesh objects in document order.
    pub objects: Vec<Object3mf>,
    /// Build items in document order.
    pub items: Vec<BuildItem3mf>,
}

impl Model3mf {
    /// Bounding box of the build as a slicer places it: every vertex of every build item's
    /// object after the item's transform. `Ok(None)` when no build item has a vertex; an error
    /// for an item that references a missing object or carries an invalid transform.
    pub fn build_bounds(&self) -> Result<Option<Aabb>, IoError> {
        let mut b: Option<Aabb> = None;
        for it in &self.items {
            let m = it.matrix()?;
            let o = self
                .objects
                .iter()
                .find(|o| o.id == it.object_id)
                .ok_or_else(|| {
                    tmf(format!(
                        "build item references missing object {}",
                        it.object_id
                    ))
                })?;
            for &v in &o.vertices {
                let p = apply_3mf_transform(&m, v);
                b = Some(match b {
                    None => Aabb { min: p, max: p },
                    Some(a) => Aabb {
                        min: [a.min[0].min(p[0]), a.min[1].min(p[1]), a.min[2].min(p[2])],
                        max: [a.max[0].max(p[0]), a.max[1].max(p[1]), a.max[2].max(p[2])],
                    },
                });
            }
        }
        Ok(b)
    }
}

/// Summary returned by [`validate_3mf`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreeMfReport {
    /// Part names in the package (sorted).
    pub parts: Vec<String>,
    /// The model part resolved through `_rels/.rels`.
    pub model_part: String,
    /// Number of mesh objects.
    pub objects: usize,
    /// Number of build items.
    pub items: usize,
    /// Total vertices.
    pub vertices: usize,
    /// Total triangles.
    pub triangles: usize,
}

fn tmf(detail: impl Into<String>) -> IoError {
    IoError::ThreeMf {
        detail: detail.into(),
    }
}

fn parse_u32(v: Option<&str>, what: &str) -> Result<u32, IoError> {
    v.and_then(|s| s.trim().parse::<u32>().ok())
        .ok_or_else(|| tmf(format!("missing or invalid {what}")))
}

fn parse_f64(v: Option<&str>, what: &str) -> Result<f64, IoError> {
    v.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|x| x.is_finite())
        .ok_or_else(|| tmf(format!("missing or invalid {what}")))
}

/// An unzipped package: parts, the model part name, the content-types root element.
type Package = (BTreeMap<String, Vec<u8>>, String, Element);

/// Unzip and resolve the model part.
fn open_package(bytes: &[u8]) -> Result<Package, IoError> {
    let parts = zip::read_zip(bytes)?;
    let ct_bytes = parts
        .get("[Content_Types].xml")
        .ok_or_else(|| tmf("missing [Content_Types].xml"))?;
    let ct = xml::parse(ct_bytes)?;
    if ct.local_name() != "Types" {
        return Err(tmf("[Content_Types].xml root is not <Types>"));
    }
    let rels_bytes = parts
        .get("_rels/.rels")
        .ok_or_else(|| tmf("missing _rels/.rels"))?;
    let rels = xml::parse(rels_bytes)?;
    if rels.local_name() != "Relationships" {
        return Err(tmf("_rels/.rels root is not <Relationships>"));
    }
    let target = rels
        .children_named("Relationship")
        .find(|r| r.attr("Type") == Some(MODEL_REL_TYPE))
        .and_then(|r| r.attr("Target"))
        .ok_or_else(|| tmf("no 3D model relationship in _rels/.rels"))?;
    let model_part = target.trim_start_matches('/').to_string();
    if !parts.contains_key(&model_part) {
        return Err(tmf(format!(
            "relationship target {target} is not in the package"
        )));
    }
    Ok((parts, model_part, ct))
}

fn parse_model(bytes: &[u8]) -> Result<Model3mf, IoError> {
    let root = xml::parse(bytes)?;
    if root.local_name() != "model" {
        return Err(tmf("model part root is not <model>"));
    }
    if root.attr("xmlns") != Some(CORE_NS) {
        return Err(tmf("model is not in the 3MF core namespace"));
    }
    if let Some(req) = root.attr("requiredextensions")
        && !req.trim().is_empty()
    {
        return Err(IoError::Unsupported {
            what: "3MF required extensions",
        });
    }
    let unit = root.attr("unit").unwrap_or("millimeter").to_string();
    if !UNITS.contains(&unit.as_str()) {
        return Err(tmf(format!("invalid unit {unit}")));
    }
    let metadata = root
        .children_named("metadata")
        .map(|m| (m.attr("name").unwrap_or("").to_string(), m.text.clone()))
        .collect();
    let resources = root
        .child("resources")
        .ok_or_else(|| tmf("missing <resources>"))?;
    let mut objects = Vec::new();
    for o in resources.children_named("object") {
        let id = parse_u32(o.attr("id"), "object id")?;
        if id == 0 {
            return Err(tmf("object id 0"));
        }
        if o.child("components").is_some() {
            return Err(IoError::Unsupported {
                what: "3MF component objects",
            });
        }
        let mesh = o
            .child("mesh")
            .ok_or_else(|| tmf(format!("object {id} has no <mesh>")))?;
        let mut vertices = Vec::new();
        if let Some(vs) = mesh.child("vertices") {
            for v in vs.children_named("vertex") {
                vertices.push([
                    parse_f64(v.attr("x"), "vertex x")?,
                    parse_f64(v.attr("y"), "vertex y")?,
                    parse_f64(v.attr("z"), "vertex z")?,
                ]);
            }
        }
        let mut triangles = Vec::new();
        if let Some(ts) = mesh.child("triangles") {
            for t in ts.children_named("triangle") {
                triangles.push([
                    parse_u32(t.attr("v1"), "triangle v1")?,
                    parse_u32(t.attr("v2"), "triangle v2")?,
                    parse_u32(t.attr("v3"), "triangle v3")?,
                ]);
            }
        }
        objects.push(Object3mf {
            id,
            name: o.attr("name").map(str::to_string),
            object_type: o.attr("type").unwrap_or("model").to_string(),
            vertices,
            triangles,
        });
    }
    let build = root.child("build").ok_or_else(|| tmf("missing <build>"))?;
    let items = build
        .children_named("item")
        .map(|it| {
            Ok(BuildItem3mf {
                object_id: parse_u32(it.attr("objectid"), "item objectid")?,
                transform: it.attr("transform").map(str::to_string),
            })
        })
        .collect::<Result<Vec<_>, IoError>>()?;
    Ok(Model3mf {
        unit,
        metadata,
        objects,
        items,
    })
}

/// Read the model of a 3MF package (mesh objects, build items, metadata).
pub fn read_3mf(bytes: &[u8]) -> Result<Model3mf, IoError> {
    let (parts, model_part, _) = open_package(bytes)?;
    parse_model(&parts[&model_part])
}

/// Structurally validate a 3MF package: required parts present, content types declared
/// for every part, the model relationship resolving to an existing part, well-formed
/// XML, core namespace and unit, unique positive object ids, every object a mesh with
/// at least one triangle whose indices are in range and distinct, and at least one build
/// item, each referencing an existing object.
pub fn validate_3mf(bytes: &[u8]) -> Result<ThreeMfReport, IoError> {
    let (parts, model_part, ct) = open_package(bytes)?;
    // Content types: every part must be covered by an Override or an extension Default.
    let defaults: BTreeMap<String, String> = ct
        .children_named("Default")
        .filter_map(|d| {
            Some((
                d.attr("Extension")?.to_ascii_lowercase(),
                d.attr("ContentType")?.to_string(),
            ))
        })
        .collect();
    let overrides: BTreeMap<String, String> = ct
        .children_named("Override")
        .filter_map(|o| {
            Some((
                o.attr("PartName")?.trim_start_matches('/').to_string(),
                o.attr("ContentType")?.to_string(),
            ))
        })
        .collect();
    let type_of = |part: &str| -> Option<&String> {
        overrides.get(part).or_else(|| {
            let ext = part.rsplit('.').next()?.to_ascii_lowercase();
            defaults.get(&ext)
        })
    };
    for p in parts.keys().filter(|p| *p != "[Content_Types].xml") {
        if type_of(p).is_none() {
            return Err(tmf(format!("part {p} has no content type")));
        }
    }
    if type_of(&model_part).map(String::as_str) != Some(MODEL_CONTENT_TYPE) {
        return Err(tmf(
            "the model part does not have the 3D model content type",
        ));
    }
    if type_of("_rels/.rels").map(String::as_str) != Some(RELS_CONTENT_TYPE) {
        return Err(tmf(
            "relationship parts do not have the relationships content type",
        ));
    }
    let model = parse_model(&parts[&model_part])?;
    let mut ids = BTreeSet::new();
    let (mut vertices, mut triangles) = (0usize, 0usize);
    for o in &model.objects {
        if !ids.insert(o.id) {
            return Err(tmf(format!("duplicate object id {}", o.id)));
        }
        if o.triangles.is_empty() || o.vertices.len() < 3 {
            return Err(tmf(format!("object {} has an empty mesh", o.id)));
        }
        let n = o.vertices.len() as u64;
        for t in &o.triangles {
            if t.iter().any(|&k| u64::from(k) >= n) {
                return Err(tmf(format!("object {}: triangle {t:?} out of range", o.id)));
            }
            if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
                return Err(tmf(format!("object {}: degenerate triangle {t:?}", o.id)));
            }
        }
        vertices += o.vertices.len();
        triangles += o.triangles.len();
    }
    if model.items.is_empty() {
        return Err(tmf("the build has no items"));
    }
    for it in &model.items {
        if !ids.contains(&it.object_id) {
            return Err(tmf(format!(
                "build item references missing object {}",
                it.object_id
            )));
        }
        it.matrix()?;
    }
    Ok(ThreeMfReport {
        parts: parts.keys().cloned().collect(),
        model_part,
        objects: model.objects.len(),
        items: model.items.len(),
        vertices,
        triangles,
    })
}
