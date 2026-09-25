//! Placing an export on a printer bed (ALPHA-0-PLAN W5): centring with z-min = 0, the
//! `EXPORT_BED_FIT` check, the 3MF that carries the placement as a build-item transform
//! while leaving every vertex unchanged, the layout warnings for bodies a slicer would drop
//! onto the plate, and the geometry hash that ignores the metadata.

// Exact (bit-level) equality of coordinates is the property under test here.
#![allow(clippy::float_cmp)]

use forge_core::topo::samples;
use forge_io::{
    Axis, BedRect, BuildVolume, LayoutWarning, PlacementError, ThreeMfOptions, geometry_hash,
    layout_warnings, parse_3mf_transform, place_on_bed, read_3mf, try_write_3mf_with, validate_3mf,
    write_3mf, zip,
};
use forge_mesh::{BodyMesh, TessParams, check_watertight, tessellate};
use proptest::prelude::*;

/// The Bambu Lab P2S build volume of the built-in profile (256 × 256 × 256 mm) with the
/// Alpha 0 margin of 10 mm per side.
fn p2s() -> BuildVolume {
    BuildVolume::new([256.0, 256.0, 256.0], 10.0)
}

/// A closed box mesh (8 corners, 12 outward triangles).
fn box_mesh(min: [f64; 3], max: [f64; 3]) -> BodyMesh {
    let c = |i: usize| {
        [
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        ]
    };
    BodyMesh {
        positions: (0..8).map(c).collect(),
        normals: vec![],
        triangles: vec![
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ],
        face_ranges: vec![],
        edge_polylines: vec![],
    }
}

fn shifted(m: &BodyMesh, d: [f64; 3]) -> BodyMesh {
    let mut m = m.clone();
    for p in &mut m.positions {
        *p = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    }
    m
}

/// A cylinder (r 10, h 30) moved off the origin and below z = 0, and a cube beside it: two
/// bodies that must keep their relative position.
fn two_bodies() -> (BodyMesh, BodyMesh) {
    let params = TessParams::new(0.01, 0.1);
    let cyl = tessellate(&samples::cylinder(10.0, 30.0), &params).expect("tessellate");
    let cube = tessellate(&samples::unit_cube(), &params).expect("tessellate");
    (
        shifted(&cyl, [-40.0, 17.5, -12.0]),
        shifted(&cube, [5.0, -3.0, -12.0]),
    )
}

#[test]
fn a_centred_3mf_puts_the_build_box_on_the_bed_centre_with_its_lowest_point_at_zero() {
    let (a, b) = two_bodies();
    let placement = place_on_bed(&[&a, &b], &p2s()).expect("fits");
    let opts = ThreeMfOptions {
        title: Some("two bodies".into()),
        application: Some("PartZero 0.0.1".into()),
        translation: Some(placement.translation),
    };
    let bytes = try_write_3mf_with(&[("cyl", &a), ("cube", &b)], &opts).expect("write");
    validate_3mf(&bytes).expect("valid 3MF");
    let model = read_3mf(&bytes).expect("read");
    let bounds = model.build_bounds().expect("bounds").expect("some");
    assert_eq!(
        bounds, placement.placed,
        "the file places the build where place_on_bed says"
    );
    let centre = [
        0.5 * (bounds.min[0] + bounds.max[0]),
        0.5 * (bounds.min[1] + bounds.max[1]),
    ];
    assert!(
        (centre[0] - 128.0).abs() < 1e-9 && (centre[1] - 128.0).abs() < 1e-9,
        "{centre:?}"
    );
    assert_eq!(bounds.min[2], 0.0);
    // Metadata: the Title and the Application the handoff receipt names.
    assert!(
        model
            .metadata
            .contains(&("Application".into(), "PartZero 0.0.1".into()))
    );
    assert!(
        model
            .metadata
            .contains(&("Title".into(), "two bodies".into()))
    );
    assert_eq!(model.unit, "millimeter");
    // One object per body, both placed by the same translation.
    assert_eq!(model.objects.len(), 2);
    assert_eq!(model.items.len(), 2);
    for it in &model.items {
        let m = it.matrix().expect("matrix");
        assert_eq!(&m[..9], &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(&m[9..], &placement.translation);
    }
}

#[test]
fn the_transform_leaves_every_vertex_and_triangle_unchanged() {
    let (a, b) = two_bodies();
    let placement = place_on_bed(&[&a, &b], &p2s()).expect("fits");
    let opts = ThreeMfOptions {
        translation: Some(placement.translation),
        ..ThreeMfOptions::default()
    };
    let placed = read_3mf(&try_write_3mf_with(&[("a", &a), ("b", &b)], &opts).expect("write"))
        .expect("read");
    let plain = read_3mf(&write_3mf(&[("a", &a), ("b", &b)])).expect("read");
    assert_eq!(placed.objects, plain.objects);
    assert_eq!(placed.objects[0].vertices, a.positions);
    assert_eq!(placed.objects[1].triangles, b.triangles);
    // Still watertight: the mesh is what tessellate produced.
    check_watertight(&a).expect("watertight");
}

#[test]
fn placement_is_byte_deterministic_and_the_model_part_is_golden() {
    let m = box_mesh([-10.0, -5.0, -2.0], [10.0, 5.0, 3.0]);
    let placement = place_on_bed(&[&m], &p2s()).expect("fits");
    assert_eq!(placement.translation, [128.0, 128.0, 2.0]);
    let opts = ThreeMfOptions {
        title: Some("knob & <co>".into()),
        application: Some("PartZero 0.0.1".into()),
        translation: Some(placement.translation),
    };
    let one = try_write_3mf_with(&[("box", &m)], &opts).expect("write");
    let two = try_write_3mf_with(&[("box", &m)], &opts).expect("write");
    assert_eq!(one, two);
    let parts = zip::read_zip(&one).expect("zip");
    let model = String::from_utf8(parts["3D/3dmodel.model"].clone()).expect("utf8");
    assert!(model.contains(
        " <metadata name=\"Application\">PartZero 0.0.1</metadata>\n <metadata name=\"Title\">knob &amp; &lt;co&gt;</metadata>\n <resources>\n"
    ));
    assert!(model.contains(
        " <build>\n  <item objectid=\"1\" transform=\"1 0 0 0 1 0 0 0 1 128 128 2\"/>\n </build>\n"
    ));
    // The default options write exactly what write_3mf writes.
    assert_eq!(
        try_write_3mf_with(&[("box", &m)], &ThreeMfOptions::default()).expect("write"),
        write_3mf(&[("box", &m)])
    );
}

#[test]
fn bed_fit_accepts_exactly_the_usable_size_and_rejects_anything_larger() {
    let bed = p2s();
    let usable = bed.usable();
    assert_eq!(usable, [236.0, 236.0, 256.0]);
    let exact = box_mesh([-50.0, 3.0, 7.0], [-50.0 + 236.0, 3.0 + 236.0, 7.0 + 256.0]);
    let p = place_on_bed(&[&exact], &bed).expect("exactly the usable size fits");
    assert_eq!(p.placed.min, [10.0, 10.0, 0.0]);
    assert_eq!(p.placed.max, [246.0, 246.0, 256.0]);
    for axis in [Axis::X, Axis::Y, Axis::Z] {
        let i = axis as usize;
        let mut max: [f64; 3] = [236.0, 236.0, 256.0];
        max[i] = max[i].next_up();
        let e = place_on_bed(&[&box_mesh([0.0; 3], max)], &bed).unwrap_err();
        assert_eq!(e.code(), "EXPORT_BED_FIT");
        let PlacementError::DoesNotFit { overflows, .. } = &e else {
            panic!("{e:?}")
        };
        assert_eq!(overflows.len(), 1);
        assert_eq!(overflows[0].axis, axis);
        assert!(overflows[0].excess() > 0.0);
    }
}

#[test]
fn every_overflowing_axis_is_reported_with_its_numbers() {
    let e = place_on_bed(&[&box_mesh([0.0; 3], [300.0, 100.0, 260.0])], &p2s()).unwrap_err();
    let PlacementError::DoesNotFit {
        extent,
        usable,
        overflows,
        ..
    } = &e
    else {
        panic!("{e:?}")
    };
    assert_eq!(*extent, [300.0, 100.0, 260.0]);
    assert_eq!(*usable, [236.0, 236.0, 256.0]);
    let axes: Vec<_> = overflows.iter().map(|o| (o.axis, o.excess())).collect();
    assert_eq!(axes, vec![(Axis::X, 64.0), (Axis::Z, 4.0)]);
    assert_eq!(
        e.to_string(),
        "the part is 300 × 100 × 260 mm but at most 236 × 236 × 256 mm fits (a 256 × 256 mm bed less a 10 mm margin per side): 64 mm too large in X, 4 mm too large in Z"
    );
}

#[test]
fn bodies_keep_their_relative_position() {
    let a = box_mesh([0.0, 0.0, 0.0], [20.0, 10.0, 5.0]);
    let b = box_mesh([30.0, 0.0, 0.0], [50.0, 10.0, 2.0]);
    let p = place_on_bed(&[&a, &b], &p2s()).expect("fits");
    // The pair (50 mm wide) is centred as a whole: a starts at 128 − 25.
    assert_eq!(p.translation, [103.0, 123.0, 0.0]);
}

#[test]
fn an_exclusion_zone_under_the_footprint_is_a_bed_fit_error_and_touching_is_not() {
    let mut bed = p2s();
    // A zone in the front-left corner; a 100 mm part centred on the bed spans 78..178.
    bed.exclusions.push(BedRect {
        min: [0.0, 0.0],
        max: [78.0, 78.0],
    });
    let part = box_mesh([0.0; 3], [100.0, 100.0, 10.0]);
    place_on_bed(&[&part], &bed).expect("touching the zone's corner is fine");
    let big = box_mesh([0.0; 3], [110.0, 110.0, 10.0]);
    let e = place_on_bed(&[&big], &bed).unwrap_err();
    assert_eq!(e.code(), "EXPORT_BED_FIT");
    assert!(
        matches!(e, PlacementError::ExclusionZone { zone: 0, .. }),
        "{e:?}"
    );
}

#[test]
fn invalid_beds_empty_exports_and_invalid_meshes_have_their_own_codes() {
    let m = box_mesh([0.0; 3], [1.0; 3]);
    for bed in [
        BuildVolume::new([256.0, 256.0, 0.0], 10.0),
        BuildVolume::new([256.0, f64::NAN, 256.0], 10.0),
        BuildVolume::new([256.0, 256.0, 256.0], -1.0),
        BuildVolume::new([256.0, 20.0, 256.0], 10.0),
        BuildVolume {
            exclusions: vec![BedRect {
                min: [5.0, 5.0],
                max: [5.0, 9.0],
            }],
            ..p2s()
        },
    ] {
        assert_eq!(
            place_on_bed(&[&m], &bed).unwrap_err().code(),
            "EXPORT_BED_INVALID",
            "{bed:?}"
        );
    }
    assert_eq!(
        place_on_bed(&[], &p2s()).unwrap_err().code(),
        "EXPORT_EMPTY"
    );
    let mut bad = m.clone();
    bad.triangles[0][1] = 99;
    assert_eq!(
        place_on_bed(&[&bad], &p2s()).unwrap_err().code(),
        "IO_INVALID_MESH"
    );
    let mut nan = m.clone();
    nan.positions[3][2] = f64::INFINITY;
    assert_eq!(
        place_on_bed(&[&nan], &p2s()).unwrap_err().code(),
        "IO_INVALID_MESH"
    );
    let opts = ThreeMfOptions {
        translation: Some([0.0, f64::NAN, 0.0]),
        ..ThreeMfOptions::default()
    };
    assert_eq!(
        try_write_3mf_with(&[("m", &m)], &opts).unwrap_err().code(),
        "IO_3MF"
    );
}

#[test]
fn transforms_are_parsed_and_validated() {
    assert_eq!(
        parse_3mf_transform(Some(" 1 0 0 0 1 0 0 0 1 128 -3.5 2e1 ")).expect("ok"),
        [
            1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 128.0, -3.5, 20.0
        ]
    );
    assert_eq!(parse_3mf_transform(None).expect("identity")[0], 1.0);
    for bad in [
        "1 0 0",
        "1 0 0 0 1 0 0 0 1 0 0 x",
        "1 0 0 0 1 0 0 0 1 0 0 NaN",
        "1 0 0 0 1 0 0 0 1 0 0 0 0",
    ] {
        assert_eq!(
            parse_3mf_transform(Some(bad)).unwrap_err().code(),
            "IO_3MF",
            "{bad}"
        );
    }
    // validate_3mf rejects a package whose build item has a malformed transform.
    let m = box_mesh([0.0; 3], [1.0; 3]);
    let bytes = write_3mf(&[("m", &m)]);
    let mut parts = zip::read_zip(&bytes).expect("zip");
    let model = String::from_utf8(parts["3D/3dmodel.model"].clone())
        .expect("utf8")
        .replace(
            "<item objectid=\"1\"/>",
            "<item objectid=\"1\" transform=\"1 2 3\"/>",
        );
    parts.insert("3D/3dmodel.model".into(), model.into_bytes());
    let entries: Vec<(&str, &[u8])> = parts
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_slice()))
        .collect();
    let broken = zip::write_zip(&entries).expect("zip");
    assert_eq!(validate_3mf(&broken).unwrap_err().code(), "IO_3MF");
}

/// A box with its lid modelled in place, 1 mm above it.
fn box_and_lid() -> (BodyMesh, BodyMesh) {
    (
        box_mesh([0.0, 0.0, 0.0], [40.0, 30.0, 20.0]),
        box_mesh([0.0, 0.0, 21.0], [40.0, 30.0, 24.0]),
    )
}

#[test]
fn bodies_resting_on_the_bed_give_no_layout_warning() {
    let (a, b) = two_bodies();
    let p = place_on_bed(&[&a, &b], &p2s()).expect("fits");
    assert_eq!(layout_warnings(&[&a, &b], &p, 0.01), Ok(vec![]));
    // Side by side, overlapping footprints on the bed (a print-in-place pair) are fine too.
    let (x, y) = (
        box_mesh([0.0; 3], [10.0, 10.0, 5.0]),
        box_mesh([5.0, 5.0, 0.0], [15.0, 15.0, 8.0]),
    );
    let p = place_on_bed(&[&x, &y], &p2s()).expect("fits");
    assert_eq!(layout_warnings(&[&x, &y], &p, 0.01), Ok(vec![]));
}

#[test]
fn a_lid_modelled_on_its_box_floats_and_is_stacked_over_it() {
    let (base, lid) = box_and_lid();
    let p = place_on_bed(&[&base, &lid], &p2s()).expect("fits");
    let w = layout_warnings(&[&base, &lid], &p, 0.01).expect("warnings");
    // The 40 × 30 footprint centred on (128, 128).
    let footprint = BedRect {
        min: [108.0, 113.0],
        max: [148.0, 143.0],
    };
    assert_eq!(
        w,
        vec![
            LayoutWarning::Floating {
                body: 1,
                z_min: 21.0
            },
            LayoutWarning::StackedOverlap {
                bodies: [0, 1],
                overlap: footprint
            },
        ]
    );
    assert_eq!(w[0].code(), "EXPORT_BODY_FLOATING");
    assert_eq!(w[1].code(), "EXPORT_BODIES_OVERLAP");
    let name = |i: usize| ["box", "lid"][i].to_string();
    assert_eq!(
        w[0].describe(name),
        "lid starts 21 mm above the bed; a slicer drops it onto the plate"
    );
    assert_eq!(
        w[1].describe(name),
        "box and lid are stacked: they overlap on the bed (108, 113 – 148, 143) and one floats above the other, so dropped onto the plate they would print inside each other"
    );
    // Laid out side by side, the lid still floats but no longer lands on the box.
    let beside = shifted(&lid, [50.0, 0.0, 0.0]);
    let p = place_on_bed(&[&base, &beside], &p2s()).expect("fits");
    let w = layout_warnings(&[&base, &beside], &p, 0.01).expect("warnings");
    assert_eq!(
        w,
        vec![LayoutWarning::Floating {
            body: 1,
            z_min: 21.0
        }]
    );
    // Touching footprints (the lid's edge on the box's edge) do not overlap.
    let touching = shifted(&lid, [40.0, 0.0, 0.0]);
    let p = place_on_bed(&[&base, &touching], &p2s()).expect("fits");
    assert_eq!(
        layout_warnings(&[&base, &touching], &p, 0.01)
            .expect("w")
            .len(),
        1
    );
}

#[test]
fn the_contact_tolerance_absorbs_a_curved_underside_and_nothing_more() {
    let flat = box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
    let near = box_mesh([20.0, 0.0, 0.005], [30.0, 10.0, 10.0]);
    let p = place_on_bed(&[&flat, &near], &p2s()).expect("fits");
    assert_eq!(layout_warnings(&[&flat, &near], &p, 0.01), Ok(vec![]));
    assert_eq!(
        layout_warnings(&[&flat, &near], &p, 0.001),
        Ok(vec![LayoutWarning::Floating {
            body: 1,
            z_min: 0.005
        }])
    );
    for bad in [-1.0, f64::NAN, f64::INFINITY] {
        let e = layout_warnings(&[&flat], &p, bad).unwrap_err();
        assert_eq!(e.code(), "EXPORT_BED_INVALID", "{bad}");
    }
}

#[test]
fn the_geometry_hash_is_pinned_and_changes_with_any_geometry() {
    let m = box_mesh([-10.0, -5.0, -2.0], [10.0, 5.0, 3.0]);
    let t = Some([128.0, 128.0, 2.0]);
    let h = geometry_hash(&[("box", &m)], t);
    // Pinned: the same on every target (IEEE bits, little-endian integers).
    assert_eq!(format!("{h:016x}"), PINNED_BOX_HASH);
    assert_eq!(h, geometry_hash(&[("box", &m.clone())], t));
    let mut ulp = m.clone();
    ulp.positions[3][1] = f64::from_bits(ulp.positions[3][1].to_bits() + 1);
    let mut flipped = m.clone();
    flipped.triangles[0] = [0, 1, 2];
    let others = [
        geometry_hash(&[("box", &ulp)], t),
        geometry_hash(&[("box", &flipped)], t),
        geometry_hash(&[("lid", &m)], t),
        geometry_hash(&[("box", &m)], None),
        geometry_hash(&[("box", &m)], Some([128.0, 128.0, 2.5])),
        geometry_hash(&[("box", &m), ("box", &m)], t),
        geometry_hash(&[], t),
    ];
    for (i, o) in others.iter().enumerate() {
        assert_ne!(*o, h, "variant {i}");
    }
    // The metadata is not an input: files that differ only in Title/Application share it.
    let file = |title: &str| {
        try_write_3mf_with(
            &[("box", &m)],
            &ThreeMfOptions {
                title: Some(title.into()),
                application: Some("PartZero 0.0.1".into()),
                translation: t,
            },
        )
        .expect("write")
    };
    assert_ne!(file("a"), file("b"));
}

const PINNED_BOX_HASH: &str = "bb587c4885a10fd7";

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// For any box anywhere and any sensible bed: it fits iff its extent is at most the usable
    /// size on every axis; a fitting one lands centred (to rounding), inside the usable area,
    /// with its lowest point exactly at z = 0, and the 3MF round trip keeps the vertices
    /// bit-identical while placing the build exactly where `place_on_bed` says.
    #[test]
    fn placement_centres_what_fits_and_rejects_what_does_not(
        origin in prop::array::uniform3(-1.0e3f64..1.0e3),
        extent in prop::array::uniform3(0.01f64..400.0),
        bed_xy in 100.0f64..400.0,
        bed_z in 50.0f64..400.0,
        margin in 0.0f64..20.0,
    ) {
        let bed = BuildVolume::new([bed_xy, bed_xy * 0.75, bed_z], margin);
        let max = [origin[0] + extent[0], origin[1] + extent[1], origin[2] + extent[2]];
        let m = box_mesh(origin, max);
        let usable = bed.usable();
        let real = [max[0] - origin[0], max[1] - origin[1], max[2] - origin[2]];
        let fits = (0..3).all(|i| real[i] <= usable[i]);
        match place_on_bed(&[&m], &bed) {
            Ok(p) => {
                prop_assert!(fits);
                prop_assert_eq!(p.placed.min[2], 0.0);
                let c = bed.centre();
                let tol = 1e-9 * (1.0 + origin.iter().fold(0.0f64, |a, v| a.max(v.abs())) + bed_xy);
                #[allow(clippy::needless_range_loop)]
                for i in 0..2 {
                    let mid = 0.5 * (p.placed.min[i] + p.placed.max[i]);
                    prop_assert!((mid - c[i]).abs() <= tol, "axis {} centre {} vs {}", i, mid, c[i]);
                    prop_assert!(p.placed.min[i] >= margin - tol);
                    prop_assert!(p.placed.max[i] <= bed.size[i] - margin + tol);
                }
                prop_assert!(p.placed.max[2] <= bed_z + tol);
                let opts = ThreeMfOptions { translation: Some(p.translation), ..ThreeMfOptions::default() };
                let model = read_3mf(&try_write_3mf_with(&[("b", &m)], &opts).expect("write")).expect("read");
                prop_assert_eq!(&model.objects[0].vertices, &m.positions);
                prop_assert_eq!(model.build_bounds().expect("bounds").expect("some"), p.placed);
            }
            Err(e) => {
                prop_assert!(!fits);
                prop_assert_eq!(e.code(), "EXPORT_BED_FIT");
                let PlacementError::DoesNotFit { overflows, .. } = e else { panic!("not DoesNotFit") };
                let want: Vec<usize> = (0..3).filter(|&i| real[i] > usable[i]).collect();
                let got: Vec<usize> = overflows.iter().map(|o| o.axis as usize).collect();
                prop_assert_eq!(got, want);
            }
        }
    }

    /// Where a part was modelled does not change where it lands (to rounding).
    #[test]
    fn placement_does_not_depend_on_the_model_position(
        shift in prop::array::uniform3(-5.0e2f64..5.0e2),
        extent in prop::array::uniform3(1.0f64..200.0),
    ) {
        let a = box_mesh([0.0; 3], extent);
        let b = shifted(&a, shift);
        let pa = place_on_bed(&[&a], &p2s()).expect("fits");
        let pb = place_on_bed(&[&b], &p2s()).expect("fits");
        for i in 0..3 {
            prop_assert!((pa.placed.min[i] - pb.placed.min[i]).abs() < 1e-9);
            prop_assert!((pa.placed.max[i] - pb.placed.max[i]).abs() < 1e-9);
        }
    }
    /// Floating is exactly "lowest point above the tolerance", and a pair is stacked exactly
    /// when their footprints overlap and one of them floats; the order is deterministic.
    #[test]
    fn layout_warnings_follow_their_definitions(
        boxes in prop::collection::vec(
            (prop::array::uniform3(0.0f64..60.0), prop::array::uniform3(0.5f64..30.0)),
            1..5,
        ),
        tol in 0.0f64..2.0,
    ) {
        let meshes: Vec<BodyMesh> = boxes
            .iter()
            .map(|(o, e)| box_mesh(*o, [o[0] + e[0], o[1] + e[1], o[2] + e[2]]))
            .collect();
        let refs: Vec<&BodyMesh> = meshes.iter().collect();
        let p = place_on_bed(&refs, &p2s()).expect("fits");
        let w = layout_warnings(&refs, &p, tol).expect("warnings");
        prop_assert_eq!(&w, &layout_warnings(&refs, &p, tol).expect("again"));
        let placed: Vec<_> = boxes
            .iter()
            .map(|(o, e)| {
                let min = [o[0] + p.translation[0], o[1] + p.translation[1], o[2] + p.translation[2]];
                (min, [min[0] + e[0], min[1] + e[1], min[2] + e[2]])
            })
            .collect();
        let floats = |i: usize| placed[i].0[2] > tol;
        let mut want = Vec::new();
        for i in 0..placed.len() {
            if floats(i) {
                want.push(("EXPORT_BODY_FLOATING", vec![i]));
            }
        }
        for i in 0..placed.len() {
            for j in i + 1..placed.len() {
                let (a, b) = (placed[i], placed[j]);
                let overlap = a.0[0] < b.1[0] && b.0[0] < a.1[0] && a.0[1] < b.1[1] && b.0[1] < a.1[1];
                if overlap && (floats(i) || floats(j)) {
                    want.push(("EXPORT_BODIES_OVERLAP", vec![i, j]));
                }
            }
        }
        let got: Vec<(&str, Vec<usize>)> = w
            .iter()
            .map(|x| match x {
                LayoutWarning::Floating { body, .. } => (x.code(), vec![*body]),
                LayoutWarning::StackedOverlap { bodies, .. } => (x.code(), bodies.to_vec()),
            })
            .collect();
        prop_assert_eq!(got, want);
        // The lowest body always rests on the bed.
        prop_assert!((0..placed.len()).any(|i| !floats(i)));
    }
}
