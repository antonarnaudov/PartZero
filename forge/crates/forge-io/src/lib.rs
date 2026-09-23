//! # forge-io — mesh file formats (and, later, STEP)
//!
//! Our own writers and readers for the mesh formats produced from
//! [`forge_mesh::BodyMesh`]:
//!
//! | Format | Write | Read | Notes |
//! |---|---|---|---|
//! | STL binary / ASCII | [`write_stl`] | [`read_stl`] | `f32` coordinates, facet normals from `f64` positions |
//! | OBJ | [`write_obj`] | — | one `o` per body, one `g` per B-rep face, `v`/`vn` shared indices, full `f64` precision |
//! | 3MF | [`write_3mf`] | [`read_3mf`], [`validate_3mf`] | core spec, millimetres, one object per body with its name, exact `f64` round trip |
//! | STEP | — | — | planned (F1), see [`step`] |
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

mod num;
mod obj;
pub mod step;
mod stl;
mod threemf;
pub mod xml;
pub mod zip;

use forge_mesh::BodyMesh;
use thiserror::Error;

pub use obj::{try_write_obj, write_obj};
pub use stl::{StlFile, StlSolid, StlTriangle, read_stl, try_write_stl, write_stl};
pub use threemf::{
    BuildItem3mf, CORE_NS, MODEL_CONTENT_TYPE, MODEL_REL_TYPE, Model3mf, Object3mf,
    RELS_CONTENT_TYPE, ThreeMfReport, read_3mf, try_write_3mf, validate_3mf, write_3mf,
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
