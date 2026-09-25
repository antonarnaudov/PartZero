//! # forge-io — mesh file formats and STEP
//!
//! Our own writers and readers for the mesh formats produced from
//! [`forge_mesh::BodyMesh`], and our own STEP B-rep writer for Forge bodies:
//!
//! | Format | Write | Read | Notes |
//! |---|---|---|---|
//! | STL binary / ASCII | [`write_stl`] | [`read_stl`] | `f32` coordinates, facet normals from `f64` positions |
//! | OBJ | [`write_obj`] | — | one `o` per body, one `g` per B-rep face, `v`/`vn` shared indices, full `f64` precision |
//! | 3MF | [`write_3mf`], [`try_write_3mf_with`] | [`read_3mf`], [`validate_3mf`] | core spec, millimetres, one object per body with its name, exact `f64` round trip; optional `Title`/`Application` metadata and a build-item translation |
//! | STEP AP214 / AP242 | [`write_step`] | [`step::parse`] (Part 21), [`verify_step`] | exact B-rep of Forge bodies (seams synthesized, ADR 0012), mm, per-body names and colours, deterministic bytes; import planned (FM7), see [`step`] |
//!
//! [`place_on_bed`] ([`bed`]) checks that the bodies fit a printer's bed (less a margin per
//! side, `EXPORT_BED_FIT` otherwise) and computes the translation that centres them on it
//! with their lowest point at z = 0; the 3MF writer stores it as the build items' `transform`
//! and leaves the vertices unchanged. [`layout_warnings`] flags bodies a slicer would drop
//! onto the plate (floating, or stacked above another), and [`geometry_hash`] identifies the
//! geometry of a 3MF without its metadata.
//!
//! ```
//! use forge_core::topo::samples;
//! use forge_mesh::{tessellate, TessParams};
//!
//! let mesh = tessellate(&samples::cylinder(10.0, 30.0), &TessParams::new(0.05, 0.5)).unwrap();
//! let stl = forge_io::write_stl(&mesh, true);
//! let three_mf = forge_io::write_3mf(&[("cylinder", &mesh)]);
//! let obj = forge_io::write_obj(&[("cylinder", &mesh)]);
//! assert_eq!(stl.len(), 84 + 50 * mesh.triangles.len());
//! assert_eq!(forge_io::validate_3mf(&three_mf).unwrap().objects, 1);
//! assert!(obj.starts_with(b"# forge-io OBJ"));
//! ```
//!
//! ## Determinism
//! Every writer is byte-for-byte deterministic: fixed headers, no timestamps (the 3MF zip
//! uses the DOS epoch and sorted entries), and shortest round-trip number formatting,
//! which Rust computes in `core` with integer arithmetic (identical on every target).
//!
//! ## Dependencies
//! The format logic — STL, OBJ, 3MF/OPC, the ZIP container, CRC-32 and the XML parser —
//! is ours. Only raw DEFLATE is borrowed, from [`miniz_oxide`] (MIT OR Zlib OR
//! Apache-2.0, pure Rust, `#![forbid(unsafe_code)]`, no further dependencies besides
//! `adler2`, builds for `wasm32-unknown-unknown`): a compression codec is generic
//! infrastructure, not geometry, and writing an interoperable DEFLATE encoder/decoder
//! ourselves would add risk without adding value. Its output is deterministic for a
//! given version (pinned by `Cargo.lock`; the golden-byte tests catch any change).
//!
//! ## Errors
//! Readers and the `try_*` writers return [`IoError`] with a stable [`IoError::code`].
//! The plain writers take meshes produced by `forge_mesh::tessellate` (always valid)
//! and panic on invalid input, as documented on each.

pub mod bed;
mod num;
mod obj;
pub mod step;
mod stl;
mod threemf;
pub mod xml;
pub mod zip;

use forge_mesh::BodyMesh;
use thiserror::Error;

pub use bed::{
    Aabb, Axis, BedPlacement, BedRect, BuildVolume, LayoutWarning, Overflow, PlacementError,
    layout_warnings, mesh_bounds, place_on_bed,
};
pub use obj::{try_write_obj, write_obj};
pub use step::{
    StepBody, StepBodyReport, StepError, StepOptions, StepReport, StepSchema, verify_step,
    write_step,
};
pub use stl::{StlFile, StlSolid, StlTriangle, read_stl, try_write_stl, write_stl};
pub use threemf::{
    BuildItem3mf, CORE_NS, DEFAULT_APPLICATION, IDENTITY_3MF_TRANSFORM, MODEL_CONTENT_TYPE,
    MODEL_REL_TYPE, Model3mf, Object3mf, RELS_CONTENT_TYPE, ThreeMfOptions, ThreeMfReport,
    apply_3mf_transform, geometry_hash, parse_3mf_transform, read_3mf, try_write_3mf,
    try_write_3mf_with, validate_3mf, write_3mf,
};

/// An I/O failure. Every variant has a stable [`IoError::code`].
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum IoError {
    /// A mesh cannot be written (index out of range, non-finite coordinate).
    #[error("mesh {body} is invalid: {detail}")]
    InvalidMesh {
        /// Index of the body in the input.
        body: usize,
        /// What is wrong.
        detail: String,
    },
    /// Output would exceed a format limit.
    #[error("{what} exceeds the format limit")]
    TooLarge {
        /// Which quantity.
        what: &'static str,
    },
    /// Malformed STL.
    #[error("STL: {detail}")]
    Stl {
        /// What is wrong.
        detail: String,
    },
    /// Malformed or unsupported ZIP container.
    #[error("zip: {detail}")]
    Zip {
        /// What is wrong.
        detail: String,
    },
    /// Malformed XML.
    #[error("XML at byte {offset}: {detail}")]
    Xml {
        /// Byte offset in the part.
        offset: usize,
        /// What is wrong.
        detail: String,
    },
    /// A 3MF package or model violates the specification.
    #[error("3MF: {detail}")]
    ThreeMf {
        /// What is wrong.
        detail: String,
    },
    /// A valid feature this crate does not support (yet).
    #[error("unsupported: {what}")]
    Unsupported {
        /// What.
        what: &'static str,
    },
    /// STEP export or reading failed (its own stable code, `STEP_*`).
    #[error(transparent)]
    Step(#[from] StepError),
}

impl IoError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            IoError::InvalidMesh { .. } => "IO_INVALID_MESH",
            IoError::TooLarge { .. } => "IO_TOO_LARGE",
            IoError::Stl { .. } => "IO_STL",
            IoError::Zip { .. } => "IO_ZIP",
            IoError::Xml { .. } => "IO_XML",
            IoError::ThreeMf { .. } => "IO_3MF",
            IoError::Unsupported { .. } => "IO_UNSUPPORTED",
            IoError::Step(e) => e.code(),
        }
    }
}

/// One or several meshes, for writers that accept either (`&mesh`, `&[mesh]`,
/// `&vec_of_meshes`, `&[&mesh]`).
pub trait MeshSet {
    /// The meshes, in order.
    fn meshes(&self) -> Vec<&BodyMesh>;
}

impl MeshSet for BodyMesh {
    fn meshes(&self) -> Vec<&BodyMesh> {
        vec![self]
    }
}

impl MeshSet for [BodyMesh] {
    fn meshes(&self) -> Vec<&BodyMesh> {
        self.iter().collect()
    }
}

impl MeshSet for Vec<BodyMesh> {
    fn meshes(&self) -> Vec<&BodyMesh> {
        self.iter().collect()
    }
}

impl MeshSet for [&BodyMesh] {
    fn meshes(&self) -> Vec<&BodyMesh> {
        self.to_vec()
    }
}

impl MeshSet for Vec<&BodyMesh> {
    fn meshes(&self) -> Vec<&BodyMesh> {
        self.clone()
    }
}

impl<const N: usize> MeshSet for [BodyMesh; N] {
    fn meshes(&self) -> Vec<&BodyMesh> {
        self.iter().collect()
    }
}
