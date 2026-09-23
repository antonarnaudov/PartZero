//! Wavefront OBJ writer.
//!
//! One `o` object per body, one `g` group per B-rep face (named by its provenance name),
//! `v` positions and `vn` normals (shared indices, so each face line is
//! `f a//a b//b c//c`), 1-based indices running across objects. Coordinates are written
//! in shortest round-trip form (full `f64` precision); units are millimetres (OBJ has no
//! unit field; a comment records it). Whitespace in names is replaced by `_` because OBJ
//! names are whitespace-delimited.

use forge_mesh::BodyMesh;

use crate::IoError;
use crate::num::{push_f32, push_f64};
use crate::stl::check_mesh;

fn obj_name(s: &str) -> String {
    let n: String = s
        .chars()
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .collect();
    if n.is_empty() { "_".into() } else { n }
}

/// Write OBJ; fails on invalid meshes.
pub fn try_write_obj(bodies: &[(&str, &BodyMesh)]) -> Result<Vec<u8>, IoError> {
    let mut s = String::from("# forge-io OBJ\n# units: millimetre\n");
    let mut base = 1u64;
    for (i, (name, m)) in bodies.iter().enumerate() {
        check_mesh(m, i)?;
        s.push_str("o ");
        s.push_str(&obj_name(name));
        s.push('\n');
        for p in &m.positions {
            s.push('v');
            for x in p {
                s.push(' ');
                push_f64(&mut s, *x);
            }
            s.push('\n');
        }
        let normals = m.normals.len() == m.positions.len();
        if normals {
            for n in &m.normals {
                s.push_str("vn");
                for x in n {
                    s.push(' ');
                    push_f32(&mut s, *x);
                }
                s.push('\n');
            }
        }
        let face = |s: &mut String, t: &[u32; 3]| {
            s.push('f');
            for &k in t {
                let idx = base + u64::from(k);
                if normals {
                    s.push_str(&format!(" {idx}//{idx}"));
                } else {
                    s.push_str(&format!(" {idx}"));
                }
            }
            s.push('\n');
        };
        let mut covered = 0usize;
        for r in &m.face_ranges {
            s.push_str("g ");
            s.push_str(&obj_name(&r.face_name));
            s.push('\n');
            let a = r.tri_start as usize;
            let b = a + r.tri_count as usize;
            for t in m.triangles.get(a..b).unwrap_or(&[]) {
                face(&mut s, t);
            }
            covered = covered.max(b);
        }
        if covered < m.triangles.len() {
            // Triangles outside any face range (hand-built meshes).
            for t in &m.triangles[covered..] {
                face(&mut s, t);
            }
        }
        base += m.positions.len() as u64;
    }
    Ok(s.into_bytes())
}

/// Write OBJ for named bodies.
///
/// # Panics
/// If a mesh has out-of-range indices or non-finite coordinates (never the case for
/// meshes from `forge_mesh::tessellate`). Use [`try_write_obj`] for untrusted meshes.
pub fn write_obj(bodies: &[(&str, &BodyMesh)]) -> Vec<u8> {
    match try_write_obj(bodies) {
        Ok(v) => v,
        Err(e) => panic!("write_obj: {e}"),
    }
}
