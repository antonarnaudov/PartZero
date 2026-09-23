//! STL, binary and ASCII: writer and reader.
//!
//! # Binary layout (little-endian)
//! 80-byte header, `u32` triangle count, then per triangle: facet normal `3 × f32`, three
//! vertices `3 × 3 × f32`, a `u16` attribute (0). Our header is the fixed text
//! `"forge-io binary STL"` padded with spaces (it deliberately does not start with
//! `solid`, which would confuse ASCII detection in other readers).
//!
//! # ASCII layout
//! One `solid bodyN … endsolid bodyN` block per body; numbers are the shortest decimal
//! that round-trips the `f32` value, so ASCII and binary files carry identical values.
//!
//! Facet normals are computed from the `f64` positions (right-hand rule) and
//! normalized; a degenerate triangle gets a zero normal. Units are millimetres (STL has
//! no unit field).

use forge_mesh::BodyMesh;

use crate::num::push_f32;
use crate::{IoError, MeshSet};

const HEADER: &[u8] = b"forge-io binary STL";

fn facet(mesh: &BodyMesh, t: [u32; 3]) -> ([f32; 3], [[f32; 3]; 3]) {
    let p = t.map(|k| mesh.positions[k as usize]);
    let u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    let v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let n = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    // `+ 0.0` turns −0 into +0 so binary and ASCII files carry identical bits.
    let c = |x: f64| (x as f32) + 0.0;
    let nf = if l > 0.0 && l.is_finite() {
        [c(n[0] / l), c(n[1] / l), c(n[2] / l)]
    } else {
        [0.0; 3]
    };
    (nf, p.map(|q| [c(q[0]), c(q[1]), c(q[2])]))
}

/// Check that a mesh can be written: indices in range, finite coordinates.
pub(crate) fn check_mesh(mesh: &BodyMesh, index: usize) -> Result<(), IoError> {
    let n = mesh.positions.len() as u64;
    if let Some(t) = mesh
        .triangles
        .iter()
        .find(|t| t.iter().any(|&k| u64::from(k) >= n))
    {
        return Err(IoError::InvalidMesh {
            body: index,
            detail: format!("triangle {t:?} references a missing vertex"),
        });
    }
    if mesh.positions.iter().flatten().any(|x| !x.is_finite()) {
        return Err(IoError::InvalidMesh {
            body: index,
            detail: "non-finite vertex coordinate".into(),
        });
    }
    Ok(())
}

/// Write STL (see the module docs); fails on invalid meshes or more than `u32::MAX`
/// triangles in a binary file.
pub fn try_write_stl<M: MeshSet + ?Sized>(meshes: &M, binary: bool) -> Result<Vec<u8>, IoError> {
    let list = meshes.meshes();
    for (i, m) in list.iter().enumerate() {
        check_mesh(m, i)?;
    }
    if binary {
        let total: usize = list.iter().map(|m| m.triangles.len()).sum();
        let count = u32::try_from(total).map_err(|_| IoError::TooLarge {
            what: "binary STL triangle count",
        })?;
        let mut out = Vec::with_capacity(84 + 50 * total);
        out.extend_from_slice(HEADER);
        out.resize(80, b' ');
        out.extend_from_slice(&count.to_le_bytes());
        for m in &list {
            for &t in &m.triangles {
                let (n, vs) = facet(m, t);
                for x in n.iter().chain(vs.iter().flatten()) {
                    out.extend_from_slice(&x.to_le_bytes());
                }
                out.extend_from_slice(&0u16.to_le_bytes());
            }
        }
        Ok(out)
    } else {
        let mut s = String::new();
        let v3 = |s: &mut String, head: &str, v: [f32; 3]| {
            s.push_str(head);
            for (k, x) in v.iter().enumerate() {
                if k > 0 {
                    s.push(' ');
                }
                push_f32(s, *x);
            }
            s.push('\n');
        };
        for (i, m) in list.iter().enumerate() {
            s.push_str(&format!("solid body{i}\n"));
            for &t in &m.triangles {
                let (n, vs) = facet(m, t);
                v3(&mut s, "  facet normal ", n);
                s.push_str("    outer loop\n");
                for v in vs {
                    v3(&mut s, "      vertex ", v);
                }
                s.push_str("    endloop\n  endfacet\n");
            }
            s.push_str(&format!("endsolid body{i}\n"));
        }
        Ok(s.into_bytes())
    }
}

/// Write STL: binary (`binary = true`) or ASCII, one or several meshes (see
/// [`MeshSet`]).
///
/// # Panics
/// If a mesh has out-of-range indices or non-finite coordinates (never the case for
/// meshes from `forge_mesh::tessellate`) or a binary file would exceed `u32::MAX`
/// triangles. Use [`try_write_stl`] for untrusted meshes.
pub fn write_stl<M: MeshSet + ?Sized>(meshes: &M, binary: bool) -> Vec<u8> {
    match try_write_stl(meshes, binary) {
        Ok(v) => v,
        Err(e) => panic!("write_stl: {e}"),
    }
}

/// One STL triangle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StlTriangle {
    /// Facet normal as stored.
    pub normal: [f32; 3],
    /// Vertices in file order.
    pub vertices: [[f32; 3]; 3],
}

/// One `solid` (ASCII) or the whole file (binary).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StlSolid {
    /// Solid name (ASCII) or the trimmed header text (binary).
    pub name: String,
    /// Triangles in file order.
    pub triangles: Vec<StlTriangle>,
}

/// A parsed STL file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StlFile {
    /// `true` if the file was binary.
    pub binary: bool,
    /// Solids in file order (exactly one for binary files).
    pub solids: Vec<StlSolid>,
}

impl StlFile {
    /// All triangles of all solids.
    pub fn triangles(&self) -> impl Iterator<Item = &StlTriangle> {
        self.solids.iter().flat_map(|s| s.triangles.iter())
    }

    /// Shared-vertex form: vertices merged by **exact** coordinate bits (in first-seen
    /// order) and triangles indexing them.
    pub fn to_indexed(&self) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
        let mut map: std::collections::BTreeMap<[u32; 3], u32> = Default::default();
        let mut verts = Vec::new();
        let mut tris = Vec::new();
        for t in self.triangles() {
            let mut idx = [0u32; 3];
            for (k, v) in t.vertices.iter().enumerate() {
                let key = v.map(f32::to_bits);
                let n = verts.len() as u32;
                idx[k] = *map.entry(key).or_insert_with(|| {
                    verts.push(*v);
                    n
                });
            }
            tris.push(idx);
        }
        (verts, tris)
    }
}

fn stl_err(detail: impl Into<String>) -> IoError {
    IoError::Stl {
        detail: detail.into(),
    }
}

/// Read a binary or ASCII STL file. A file whose size is exactly
/// `84 + 50 × count` is binary (even if its header starts with `solid`); otherwise it
/// must be ASCII.
pub fn read_stl(bytes: &[u8]) -> Result<StlFile, IoError> {
    if bytes.len() >= 84 {
        let count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        if count
            .checked_mul(50)
            .and_then(|n| n.checked_add(84))
            .is_some_and(|n| n == bytes.len())
        {
            return read_binary(bytes, count);
        }
    }
    let text = std::str::from_utf8(bytes).map_err(|_| stl_err("neither binary nor ASCII STL"))?;
    if !text.trim_start().starts_with("solid") {
        return Err(stl_err("neither binary nor ASCII STL"));
    }
    read_ascii(text)
}

fn read_binary(bytes: &[u8], count: usize) -> Result<StlFile, IoError> {
    let f =
        |at: usize| f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let mut tris = Vec::with_capacity(count);
    for i in 0..count {
        let b = 84 + 50 * i;
        let v = |k: usize| [f(b + 12 * k), f(b + 12 * k + 4), f(b + 12 * k + 8)];
        let t = StlTriangle {
            normal: v(0),
            vertices: [v(1), v(2), v(3)],
        };
        if t.vertices.iter().flatten().any(|x| !x.is_finite()) {
            return Err(stl_err(format!("triangle {i} has a non-finite coordinate")));
        }
        tris.push(t);
    }
    let name = String::from_utf8_lossy(&bytes[..80])
        .trim_end_matches(['\0', ' '])
        .to_string();
    Ok(StlFile {
        binary: true,
        solids: vec![StlSolid {
            name,
            triangles: tris,
        }],
    })
}

fn read_ascii(text: &str) -> Result<StlFile, IoError> {
    let mut solids = Vec::new();
    let mut lines = text.lines().enumerate().peekable();
    let num = |tok: Option<&str>, line: usize| -> Result<f32, IoError> {
        tok.and_then(|t| t.parse::<f32>().ok())
            .filter(|x| x.is_finite())
            .ok_or_else(|| stl_err(format!("line {}: expected a finite number", line + 1)))
    };
    while let Some((ln, line)) = lines.next() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let Some(rest) = l.strip_prefix("solid") else {
            return Err(stl_err(format!("line {}: expected 'solid'", ln + 1)));
        };
        let mut solid = StlSolid {
            name: rest.trim().to_string(),
            triangles: Vec::new(),
        };
        let mut closed = false;
        while let Some((ln, line)) = lines.next() {
            let mut tok = line.split_whitespace();
            match tok.next() {
                None => continue,
                Some("endsolid") => {
                    closed = true;
                    break;
                }
                Some("facet") => {
                    if tok.next() != Some("normal") {
                        return Err(stl_err(format!("line {}: expected 'facet normal'", ln + 1)));
                    }
                    let normal = [
                        num(tok.next(), ln)?,
                        num(tok.next(), ln)?,
                        num(tok.next(), ln)?,
                    ];
                    let mut expect = |kw: &[&str]| -> Result<(usize, Vec<String>), IoError> {
                        loop {
                            let (ln, line) = lines
                                .next()
                                .ok_or_else(|| stl_err("unexpected end of file"))?;
                            let toks: Vec<String> =
                                line.split_whitespace().map(str::to_string).collect();
                            if toks.is_empty() {
                                continue;
                            }
                            if toks.len() >= kw.len() && toks.iter().zip(kw).all(|(a, b)| a == b) {
                                return Ok((ln, toks));
                            }
                            return Err(stl_err(format!(
                                "line {}: expected '{}'",
                                ln + 1,
                                kw.join(" ")
                            )));
                        }
                    };
                    expect(&["outer", "loop"])?;
                    let mut vs = [[0f32; 3]; 3];
                    for v in &mut vs {
                        let (ln, toks) = expect(&["vertex"])?;
                        let mut it = toks.iter().skip(1).map(String::as_str);
                        *v = [
                            num(it.next(), ln)?,
                            num(it.next(), ln)?,
                            num(it.next(), ln)?,
                        ];
                    }
                    expect(&["endloop"])?;
                    expect(&["endfacet"])?;
                    solid.triangles.push(StlTriangle {
                        normal,
                        vertices: vs,
                    });
                }
                Some(other) => {
                    return Err(stl_err(format!("line {}: unexpected '{other}'", ln + 1)));
                }
            }
        }
        if !closed {
            return Err(stl_err("missing 'endsolid'"));
        }
        solids.push(solid);
    }
    if solids.is_empty() {
        return Err(stl_err("no solid"));
    }
    Ok(StlFile {
        binary: false,
        solids,
    })
}
