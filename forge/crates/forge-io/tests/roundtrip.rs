//! Round trips, structural validation and byte stability of the STL, OBJ and 3MF
//! writers.

// Exact (bit-level) equality of coordinates is the property under test here.
#![allow(clippy::float_cmp)]

use forge_core::topo::samples;
use forge_io::{
    MODEL_CONTENT_TYPE, read_3mf, read_stl, try_write_3mf, try_write_stl, validate_3mf, write_3mf,
    write_obj, write_stl, xml, zip,
};
use forge_mesh::{BodyMesh, FaceRange, TessParams, tessellate};
use proptest::prelude::*;

fn mesh_of(body: &forge_core::Body, delta: f64) -> BodyMesh {
    tessellate(body, &TessParams::new(delta, 0.5)).expect("tessellate")
}

fn cylinder() -> BodyMesh {
    mesh_of(&samples::cylinder(10.0, 30.0), 0.05)
}

fn f32v(p: [f64; 3]) -> [f32; 3] {
    [p[0] as f32, p[1] as f32, p[2] as f32]
}

/// FNV-1a over bytes.
fn fnv(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[test]
fn binary_stl_round_trips_triangles_exactly_in_f32() {
    let m = cylinder();
    let bytes = write_stl(&m, true);
    assert_eq!(bytes.len(), 84 + 50 * m.triangles.len());
    assert!(!bytes.starts_with(b"solid"));
    let f = read_stl(&bytes).expect("read");
    assert!(f.binary);
    let tris: Vec<_> = f.triangles().collect();
    assert_eq!(tris.len(), m.triangles.len());
    for (t, st) in m.triangles.iter().zip(&tris) {
        for (v, &k) in st.vertices.iter().zip(t) {
            assert_eq!(*v, f32v(m.positions[k as usize]));
        }
        let n = st.normal;
        assert!(((n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() - 1.0).abs() < 1e-6);
    }
    // Welding by exact bits recovers the shared-vertex mesh.
    let (verts, itris) = f.to_indexed();
    assert_eq!(verts.len(), m.positions.len());
    assert_eq!(itris.len(), m.triangles.len());
}

#[test]
fn ascii_stl_round_trips_the_same_values_as_binary() {
    let m = cylinder();
    let ascii = write_stl(&m, false);
    assert!(ascii.starts_with(b"solid body0\n"));
    let a = read_stl(&ascii).expect("ascii");
    let b = read_stl(&write_stl(&m, true)).expect("binary");
    assert!(!a.binary);
    let ta: Vec<_> = a.triangles().collect();
    let tb: Vec<_> = b.triangles().collect();
    assert_eq!(ta.len(), tb.len());
    for (x, y) in ta.iter().zip(&tb) {
        assert_eq!(
            x.vertices, y.vertices,
            "ASCII must carry the exact f32 values"
        );
        assert_eq!(x.normal, y.normal);
    }
}

#[test]
fn several_bodies_in_one_stl() {
    let a = cylinder();
    let b = mesh_of(&samples::unit_cube(), 0.1);
    let both = vec![a.clone(), b.clone()];
    let bin = read_stl(&write_stl(&both, true)).expect("bin");
    assert_eq!(
        bin.triangles().count(),
        a.triangles.len() + b.triangles.len()
    );
    let ascii = read_stl(&write_stl(&[&a, &b][..], false)).expect("ascii");
    assert_eq!(ascii.solids.len(), 2);
    assert_eq!(ascii.solids[1].name, "body1");
    assert_eq!(ascii.solids[1].triangles.len(), 12);
}

#[test]
fn stl_reader_rejects_garbage_and_truncation() {
    assert!(read_stl(b"garbage").is_err());
    let bin = write_stl(&cylinder(), true);
    assert!(read_stl(&bin[..bin.len() - 7]).is_err());
    assert!(read_stl(b"solid x\n  facet normal 0 0 1\n    outer loop\n").is_err());
    assert_eq!(
        read_stl(b"solid x\nendsolid x\n")
            .expect("empty")
            .solids
            .len(),
        1
    );
    let e = read_stl(b"solid x\n facet normal 0 0 nan\n").unwrap_err();
    assert_eq!(e.code(), "IO_STL");
}

#[test]
fn three_mf_round_trips_positions_and_triangles_exactly() {
    let a = cylinder();
    let b = mesh_of(&samples::sphere(5.0), 0.05);
    let bytes = write_3mf(&[("cyl & <co>", &a), ("ball", &b)]);
    let model = read_3mf(&bytes).expect("read");
    assert_eq!(model.unit, "millimeter");
    assert_eq!(model.objects.len(), 2);
    assert_eq!(model.items.len(), 2);
    assert_eq!(model.objects[0].name.as_deref(), Some("cyl & <co>"));
    assert_eq!(model.objects[1].name.as_deref(), Some("ball"));
    for (o, m) in model.objects.iter().zip([&a, &b]) {
        assert_eq!(o.object_type, "model");
        assert_eq!(o.triangles, m.triangles);
        assert_eq!(o.vertices.len(), m.positions.len());
        for (p, q) in o.vertices.iter().zip(&m.positions) {
            for k in 0..3 {
                assert_eq!(p[k].to_bits() & !(1 << 63), q[k].to_bits() & !(1 << 63));
            }
        }
    }
    assert_eq!(
        model.metadata,
        vec![("Application".into(), "forge-io".into())]
    );
}

#[test]
fn three_mf_is_structurally_valid() {
    let a = cylinder();
    let bytes = write_3mf(&[("cylinder", &a)]);
    let rep = validate_3mf(&bytes).expect("valid");
    assert_eq!(
        rep.parts,
        ["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]
    );
    assert_eq!(rep.model_part, "3D/3dmodel.model");
    assert_eq!((rep.objects, rep.items), (1, 1));
    assert_eq!(rep.vertices, a.positions.len());
    assert_eq!(rep.triangles, a.triangles.len());
    // Every part is well-formed XML with the expected root.
    let parts = zip::read_zip(&bytes).expect("zip");
    let roots: Vec<String> = parts
        .values()
        .map(|p| xml::parse(p).expect("well-formed").name)
        .collect();
    assert_eq!(roots, ["model", "Types", "Relationships"]);
}

/// Build a package from hand-written parts (for negative tests).
fn package(parts: &[(&str, String)]) -> Vec<u8> {
    let entries: Vec<(&str, &[u8])> = parts.iter().map(|(n, d)| (*n, d.as_bytes())).collect();
    zip::write_zip(&entries).expect("zip")
}

fn good_parts(model: &str) -> Vec<(&'static str, String)> {
    vec![
        (
            "[Content_Types].xml",
            format!(
                "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"model\" ContentType=\"{MODEL_CONTENT_TYPE}\"/></Types>"
            ),
        ),
        (
            "_rels/.rels",
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Target=\"/3D/3dmodel.model\" Id=\"r\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/></Relationships>"
                .to_string(),
        ),
        ("3D/3dmodel.model", model.to_string()),
    ]
}

fn model_doc(objects: &str, items: &str) -> String {
    format!(
        "<model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\
<resources>{objects}</resources><build>{items}</build></model>"
    )
}

const TRI_OBJ: &str = "<object id=\"1\" type=\"model\"><mesh><vertices>\
<vertex x=\"0\" y=\"0\" z=\"0\"/><vertex x=\"1\" y=\"0\" z=\"0\"/><vertex x=\"0\" y=\"1\" z=\"0\"/>\
</vertices><triangles><triangle v1=\"0\" v2=\"1\" v3=\"2\"/></triangles></mesh></object>";

#[test]
fn three_mf_validation_catches_structural_errors() {
    // The hand-written baseline is valid.
    let ok = package(&good_parts(&model_doc(TRI_OBJ, "<item objectid=\"1\"/>")));
    assert!(validate_3mf(&ok).is_ok());

    let mut missing_ct = good_parts(&model_doc(TRI_OBJ, "<item objectid=\"1\"/>"));
    missing_ct.remove(0);
    let mut missing_model = good_parts("");
    missing_model.pop();
    let bad_cases: Vec<(&str, Vec<u8>)> = vec![
        ("no content types", package(&missing_ct)),
        ("no model part", package(&missing_model)),
        (
            "malformed XML",
            package(&good_parts("<model><resources></model>")),
        ),
        (
            "wrong namespace",
            package(&good_parts(
                "<model xmlns=\"urn:other\"><resources/><build/></model>",
            )),
        ),
        (
            "index out of range",
            package(&good_parts(&model_doc(
                &TRI_OBJ.replace("v3=\"2\"", "v3=\"7\""),
                "<item objectid=\"1\"/>",
            ))),
        ),
        (
            "degenerate triangle",
            package(&good_parts(&model_doc(
                &TRI_OBJ.replace("v3=\"2\"", "v3=\"1\""),
                "<item objectid=\"1\"/>",
            ))),
        ),
        (
            "duplicate object id",
            package(&good_parts(&model_doc(
                &format!("{TRI_OBJ}{TRI_OBJ}"),
                "<item objectid=\"1\"/>",
            ))),
        ),
        (
            "no build items",
            package(&good_parts(&model_doc(TRI_OBJ, ""))),
        ),
        (
            "item references a missing object",
            package(&good_parts(&model_doc(TRI_OBJ, "<item objectid=\"2\"/>"))),
        ),
        (
            "bad unit",
            package(&good_parts(
                &model_doc(TRI_OBJ, "<item objectid=\"1\"/>").replace("millimeter", "furlong"),
            )),
        ),
        ("not a zip", b"PK nothing".to_vec()),
    ];
    for (what, bytes) in bad_cases {
        let e = validate_3mf(&bytes).expect_err(what);
        assert!(
            ["IO_3MF", "IO_XML", "IO_ZIP"].contains(&e.code()),
            "{what}: {e}"
        );
    }
}

#[test]
fn writers_are_deterministic() {
    let m = cylinder();
    assert_eq!(write_stl(&m, true), write_stl(&m, true));
    assert_eq!(write_stl(&m, false), write_stl(&m, false));
    assert_eq!(write_obj(&[("c", &m)]), write_obj(&[("c", &m)]));
    assert_eq!(write_3mf(&[("c", &m)]), write_3mf(&[("c", &m)]));
}

/// A single triangle with exactly representable coordinates.
fn one_triangle() -> BodyMesh {
    BodyMesh {
        positions: vec![[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 1.5, -0.25]],
        normals: vec![[0.0, 0.0, 1.0]; 3],
        triangles: vec![[0, 1, 2]],
        face_ranges: vec![FaceRange {
            face_name: "t/side:a".into(),
            tri_start: 0,
            tri_count: 1,
        }],
        edge_polylines: vec![],
    }
}

#[test]
fn golden_bytes_binary_stl() {
    let m = one_triangle();
    let mut want = Vec::new();
    want.extend_from_slice(b"forge-io binary STL");
    want.resize(80, b' ');
    want.extend_from_slice(&1u32.to_le_bytes());
    // Normal of (2,0,0) × (0,1.5,-0.25) = (0, 0.5, 3) normalized.
    let l = (0.25f64 + 9.0).sqrt();
    let n = [0.0f32, (0.5 / l) as f32, (3.0 / l) as f32];
    for x in n {
        want.extend_from_slice(&x.to_le_bytes());
    }
    for p in [[0.0f32, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 1.5, -0.25]] {
        for x in p {
            want.extend_from_slice(&x.to_le_bytes());
        }
    }
    want.extend_from_slice(&[0, 0]);
    assert_eq!(write_stl(&m, true), want);
}

#[test]
fn golden_bytes_ascii_stl_and_obj() {
    let m = one_triangle();
    let stl = String::from_utf8(write_stl(&m, false)).expect("utf8");
    assert_eq!(
        stl,
        "solid body0\n  facet normal 0 0.16439898 0.9863939\n    outer loop\n      vertex 0 0 0\n      vertex 2 0 0\n      vertex 0 1.5 -0.25\n    endloop\n  endfacet\nendsolid body0\n"
    );
    let obj = String::from_utf8(write_obj(&[("my part", &m)])).expect("utf8");
    assert_eq!(
        obj,
        "# forge-io OBJ\n# units: millimetre\no my_part\nv 0 0 0\nv 2 0 0\nv 0 1.5 -0.25\nvn 0 0 1\nvn 0 0 1\nvn 0 0 1\ng t/side:a\nf 1//1 2//2 3//3\n"
    );
}

#[test]
fn golden_bytes_three_mf() {
    let m = one_triangle();
    let bytes = write_3mf(&[("tri", &m)]);
    let parts = zip::read_zip(&bytes).expect("zip");
    assert_eq!(
        String::from_utf8(parts["3D/3dmodel.model"].clone()).expect("utf8"),
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<model unit=\"millimeter\" xml:lang=\"en-US\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\n \
<metadata name=\"Application\">forge-io</metadata>\n <resources>\n  \
<object id=\"1\" type=\"model\" name=\"tri\">\n   <mesh>\n    <vertices>\n     \
<vertex x=\"0\" y=\"0\" z=\"0\"/>\n     <vertex x=\"2\" y=\"0\" z=\"0\"/>\n     \
<vertex x=\"0\" y=\"1.5\" z=\"-0.25\"/>\n    </vertices>\n    <triangles>\n     \
<triangle v1=\"0\" v2=\"1\" v3=\"2\"/>\n    </triangles>\n   </mesh>\n  </object>\n </resources>\n \
<build>\n  <item objectid=\"1\"/>\n </build>\n</model>\n"
    );
    // Whole-package byte stability (zip container + DEFLATE output).
    assert_eq!(
        fnv(&bytes),
        GOLDEN_3MF_TRIANGLE,
        "3MF bytes changed: {:#018x}",
        fnv(&bytes)
    );
    let cube = write_3mf(&[("cube", &mesh_of(&samples::unit_cube(), 0.1))]);
    assert_eq!(
        fnv(&cube),
        GOLDEN_3MF_CUBE,
        "3MF bytes changed: {:#018x}",
        fnv(&cube)
    );
}

/// FNV-1a of `write_3mf` outputs, recorded on the reference platform. Change only for an
/// intentional format change (or a reviewed `miniz_oxide` upgrade).
const GOLDEN_3MF_TRIANGLE: u64 = 0xae95_d48e_6f44_a4ae;
const GOLDEN_3MF_CUBE: u64 = 0x5ef0_f6bd_4ee1_4baf;

#[test]
fn obj_output_is_consistent() {
    let a = cylinder();
    let b = mesh_of(&samples::unit_cube(), 0.1);
    let text = String::from_utf8(write_obj(&[("cyl", &a), ("cube", &b)])).expect("utf8");
    let count = |p: &str| text.lines().filter(|l| l.starts_with(p)).count();
    assert_eq!(count("v "), a.positions.len() + b.positions.len());
    assert_eq!(count("vn "), a.normals.len() + b.normals.len());
    assert_eq!(count("f "), a.triangles.len() + b.triangles.len());
    assert_eq!(count("o "), 2);
    assert_eq!(count("g "), a.face_ranges.len() + b.face_ranges.len());
    let nv = (a.positions.len() + b.positions.len()) as u64;
    for l in text.lines().filter(|l| l.starts_with("f ")) {
        for tok in l.split_whitespace().skip(1) {
            let i: u64 = tok
                .split("//")
                .next()
                .and_then(|s| s.parse().ok())
                .expect("index");
            assert!((1..=nv).contains(&i));
        }
    }
    // Vertex coordinates keep full f64 precision.
    let first_v = text.lines().find(|l| l.starts_with("v ")).expect("v");
    let xs: Vec<f64> = first_v
        .split_whitespace()
        .skip(1)
        .map(|t| t.parse().expect("f64"))
        .collect();
    assert_eq!(xs, a.positions[0].to_vec());
}

#[test]
fn try_writers_reject_invalid_meshes() {
    let mut m = one_triangle();
    m.triangles[0][2] = 9;
    assert_eq!(
        try_write_stl(&m, true).unwrap_err().code(),
        "IO_INVALID_MESH"
    );
    assert_eq!(
        try_write_3mf(&[("x", &m)]).unwrap_err().code(),
        "IO_INVALID_MESH"
    );
    let mut m = one_triangle();
    m.positions[1][0] = f64::NAN;
    assert_eq!(
        try_write_stl(&m, false).unwrap_err().code(),
        "IO_INVALID_MESH"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Random meshes (wide coordinate range) survive STL binary/ASCII and 3MF round
    /// trips: STL exactly in f32, 3MF exactly in f64.
    #[test]
    fn random_meshes_round_trip(
        pts in prop::collection::vec(prop::array::uniform3(-1.0e6f64..1.0e6), 3..40),
        seed in any::<u64>(),
        ntri in 1usize..60,
    ) {
        let n = pts.len() as u64;
        let mut s = seed;
        let mut next = || { s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (s >> 33) % n };
        let triangles: Vec<[u32; 3]> = (0..ntri).map(|_| [next() as u32, next() as u32, next() as u32]).collect();
        let m = BodyMesh { positions: pts.clone(), normals: vec![], triangles: triangles.clone(), face_ranges: vec![], edge_polylines: vec![] };
        for binary in [true, false] {
            let f = read_stl(&write_stl(&m, binary)).expect("stl");
            let tris: Vec<_> = f.triangles().collect();
            prop_assert_eq!(tris.len(), triangles.len());
            for (t, st) in triangles.iter().zip(&tris) {
                for k in 0..3 {
                    prop_assert_eq!(st.vertices[k], f32v(pts[t[k] as usize]));
                }
            }
        }
        let model = read_3mf(&write_3mf(&[("r", &m)])).expect("3mf");
        prop_assert_eq!(&model.objects[0].vertices, &pts);
        prop_assert_eq!(&model.objects[0].triangles, &triangles);
    }
}
