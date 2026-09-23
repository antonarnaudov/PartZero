//! Native offscreen rendering: render Forge bodies to a texture, read the pixels back,
//! and check coverage, shading, exact ID picking, edges, silhouettes and section caps.
//!
//! Needs a GPU adapter (Metal / Vulkan / DX12 / GL). Without one the tests print a
//! notice and pass, so headless CI without a GPU stays green; set
//! `FORGE_RENDER_REQUIRE_GPU=1` to make a missing adapter a failure.
//! Screenshots go to `$CARGO_TARGET_TMPDIR/forge-render/*.png`.

use std::path::PathBuf;

use forge_mesh::TessParams;
use forge_render::glam::DVec3;
use forge_render::{
    GpuContext, PickKind, Projection, SceneBody, SectionPlane, StandardView, Viewport, wgpu,
};

const W: u32 = 480;
const H: u32 = 360;

fn corpus(rel: &str) -> String {
    let dir = std::fs::canonicalize(env!("CARGO_MANIFEST_DIR")).expect("manifest dir");
    let p = dir.join("../../../corpus").join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn bodies(ir: &str) -> Vec<SceneBody> {
    let doc = forge_ir::from_json(ir).expect("valid IR");
    let ev = forge_regen::evaluate(&doc);
    let mut out = Vec::new();
    for f in &ev.features {
        if let Ok(forge_regen::FeatureOutput::Bodies(bs)) = &f.outcome {
            for (i, b) in bs.iter().enumerate() {
                let m = forge_mesh::tessellate_render(b, &TessParams::default()).expect("mesh");
                out.push(SceneBody::from_owned_render_mesh(
                    format!("{}/{}#{i}", f.part, f.feature),
                    m,
                ));
            }
        }
    }
    out
}

fn context() -> Option<GpuContext> {
    match GpuContext::headless(wgpu::Backends::PRIMARY | wgpu::Backends::GL) {
        Ok(c) => Some(c),
        Err(e) => {
            if std::env::var("FORGE_RENDER_REQUIRE_GPU").is_ok_and(|v| v == "1") {
                panic!("no GPU adapter: {e}");
            }
            eprintln!("forge-render offscreen tests skipped: {e}");
            None
        }
    }
}

fn screenshot(name: &str, img: &forge_render::RgbaImage) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("forge-render");
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join(format!("{name}.png"));
    std::fs::write(&path, png(img)).expect("write png");
    eprintln!("screenshot: {}", path.display());
}

/// Minimal PNG encoder (RGBA8, zlib via miniz_oxide).
fn png(img: &forge_render::RgbaImage) -> Vec<u8> {
    fn crc32(data: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in data {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
        }
        !c
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut c = kind.to_vec();
        c.extend_from_slice(data);
        out.extend_from_slice(&c);
        out.extend_from_slice(&crc32(&c).to_be_bytes());
    }
    let mut raw = Vec::with_capacity(((img.width * 4 + 1) * img.height) as usize);
    for row in img.pixels.chunks_exact((img.width * 4) as usize) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&img.width.to_be_bytes());
    ihdr.extend_from_slice(&img.height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(
        &mut out,
        b"IDAT",
        &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6),
    );
    chunk(&mut out, b"IEND", &[]);
    out
}

fn px(img: &forge_render::RgbaImage, x: u32, y: u32) -> [u8; 4] {
    let o = ((y * img.width + x) * 4) as usize;
    [
        img.pixels[o],
        img.pixels[o + 1],
        img.pixels[o + 2],
        img.pixels[o + 3],
    ]
}

fn luma(p: [u8; 4]) -> f64 {
    0.2126 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[2])
}

/// Fraction of pixels that differ (max channel delta > 24) between two images.
fn coverage(a: &forge_render::RgbaImage, b: &forge_render::RgbaImage) -> f64 {
    let n = a
        .pixels
        .chunks_exact(4)
        .zip(b.pixels.chunks_exact(4))
        .filter(|(p, q)| (0..3).any(|k| p[k].abs_diff(q[k]) > 24))
        .count();
    n as f64 / f64::from(a.width * a.height)
}

fn project(vp: &Viewport, p: DVec3) -> (f64, f64) {
    let (w, h) = vp.size();
    let f = vp.camera.frame(f64::from(w), f64::from(h));
    let s = f.project(p).expect("in front");
    (s.x, s.y)
}

#[test]
fn box_renders_with_shading_edges_and_exact_face_picking() {
    let Some(ctx) = context() else { return };
    eprintln!(
        "adapter: {} ({}), MSAA x{}",
        ctx.adapter_name,
        ctx.backend.as_str(),
        ctx.sample_count
    );
    let ir = corpus("programs/extrude_box.json");
    let mut vp = Viewport::new_offscreen(&ctx, W, H, 1.0);
    let empty = vp.render_image().expect("image");
    vp.set_bodies(&bodies(&ir)).expect("scene");
    assert_eq!(vp.stats().faces, 6);
    assert_eq!(vp.stats().edges, 12);
    vp.set_view(StandardView::Iso);
    let iso = vp.render_image().expect("image");
    screenshot("box_iso", &iso);

    // Non-background pixels: the box covers a sensible share of the frame.
    let cov = coverage(&empty, &iso);
    assert!((0.08..0.7).contains(&cov), "coverage {cov}");
    // Deterministic: the same frame twice gives the same bytes.
    let again = vp.render_image().expect("image");
    assert_eq!(iso.pixels, again.pixels, "frames differ");

    // Shading: the three visible faces of the iso box are distinct, lit, and the top
    // (+Z, facing the key light) is the brightest.
    let at = |p: DVec3| {
        let (x, y) = project(&vp, p);
        luma(px(&iso, x as u32, y as u32))
    };
    let top = at(DVec3::new(0.0, 0.0, 8.0));
    let front = at(DVec3::new(0.0, -25.0, 4.0));
    let right = at(DVec3::new(40.0, 0.0, 4.0));
    eprintln!("luma top {top:.1} front {front:.1} right {right:.1}");
    assert!(
        top > front && top > right,
        "top {top} front {front} right {right}"
    );
    assert!(
        (front - right).abs() > 3.0,
        "front and right faces shade alike"
    );
    assert!(front > 60.0 && right > 60.0 && top < 254.0);

    // An edge is drawn dark over the faces: the top-front edge midpoint.
    let (ex, ey) = project(&vp, DVec3::new(0.0, -25.0, 8.0));
    let edge_luma = luma(px(&iso, ex.round() as u32, ey.round() as u32));
    assert!(edge_luma < 0.6 * top.min(front), "edge luma {edge_luma}");

    // Pixel-exact picking with snapping off: the pixel under the cursor decides.
    let mut opts = vp.options().clone();
    opts.pick_radius = 0.0;
    vp.set_options(opts);
    for (view, face) in [
        (StandardView::Top, "plate/cap:end"),
        (StandardView::Bottom, "plate/cap:start"),
        (StandardView::Front, "plate/side:bottom"),
        (StandardView::Right, "plate/side:right"),
        (StandardView::Back, "plate/side:top"),
        (StandardView::Left, "plate/side:left"),
    ] {
        vp.set_view(view);
        let hit = vp
            .pick_blocking(f64::from(W) / 2.0, f64::from(H) / 2.0)
            .unwrap_or_else(|| panic!("{view:?}: no hit"));
        assert_eq!(hit.kind, PickKind::Face, "{view:?}");
        assert_eq!(
            hit.face.as_ref().map(|f| f.1.as_str()),
            Some(face),
            "{view:?}"
        );
        assert_eq!(hit.body_name, "part/plate#0");
        let p = hit.point.expect("point");
        let expect = match view {
            StandardView::Top => [0.0, 0.0, 8.0],
            StandardView::Bottom => [0.0, 0.0, 0.0],
            StandardView::Front => [0.0, -25.0, 4.0],
            StandardView::Right => [40.0, 0.0, 4.0],
            StandardView::Back => [0.0, 25.0, 4.0],
            _ => [-40.0, 0.0, 4.0],
        };
        for k in 0..3 {
            assert!((p[k] - expect[k]).abs() < 0.5, "{view:?} point {p:?}");
        }
    }
    // Background.
    vp.set_view(StandardView::Top);
    assert!(vp.pick_blocking(2.0, 2.0).is_none());
    // Orthographic picks the same faces.
    vp.set_projection(Projection::Orthographic);
    let hit = vp
        .pick_blocking(f64::from(W) / 2.0, f64::from(H) / 2.0)
        .expect("hit");
    assert_eq!(hit.face.map(|f| f.1), Some("plate/cap:end".to_string()));
    vp.set_projection(Projection::Perspective);

    // Edge picking: snapping radius 4 px near the top-front edge in iso.
    let mut opts = vp.options().clone();
    opts.pick_radius = 4.0;
    vp.set_options(opts);
    vp.set_view(StandardView::Iso);
    let (ex, ey) = project(&vp, DVec3::new(10.0, -25.0, 8.0));
    let hit = vp.pick_blocking(ex, ey + 2.0).expect("edge hit");
    assert_eq!(hit.kind, PickKind::Edge, "{hit:?}");
    let edge = hit.edge.clone().expect("edge").1;
    let info = &vp.tables().bodies[0];
    assert!(info.edges.contains(&edge));
    eprintln!("picked edge {edge}");

    // Hover and selection highlights change the image.
    let e = vp
        .tables()
        .face_by_name("part/plate#0", "plate/cap:end")
        .expect("face");
    vp.set_selection(&[e]);
    let sel = vp.render_image().expect("image");
    screenshot("box_selected", &sel);
    let (tx, ty) = project(&vp, DVec3::new(0.0, 0.0, 8.0));
    let before = px(&iso, tx as u32, ty as u32);
    let after = px(&sel, tx as u32, ty as u32);
    assert!(
        after[0] > before[0] && after[2] < before[2],
        "{before:?} → {after:?}"
    );
    vp.set_selection(&[]);
}

#[test]
fn section_plane_shows_a_cap_and_picks_it() {
    let Some(ctx) = context() else { return };
    let ir = corpus("programs/extrude_plate_with_holes.json");
    let mut vp = Viewport::new_offscreen(&ctx, W, H, 1.0);
    vp.set_bodies(&bodies(&ir)).expect("scene");
    // Plate 100 × 60 × 5 at the origin corner: cut it at x = 50, remove +X.
    vp.set_section(Some(SectionPlane {
        origin: DVec3::new(50.0, 30.0, 2.5),
        normal: DVec3::new(1.0, 0.0, 0.0),
    }));
    vp.set_view(StandardView::Iso);
    let img = vp.render_image().expect("image");
    screenshot("plate_section_iso", &img);
    // Looking at the cut face along −X: the centre shows the cap.
    vp.set_view(StandardView::Right);
    vp.fit_view();
    let img = vp.render_image().expect("image");
    screenshot("plate_section_right", &img);
    let (cx, cy) = project(&vp, DVec3::new(50.0, 20.0, 2.5));
    let mut opts = vp.options().clone();
    opts.pick_radius = 0.0;
    vp.set_options(opts);
    let hit = vp.pick_blocking(cx, cy).expect("cap hit");
    assert_eq!(hit.kind, PickKind::SectionCap, "{hit:?}");
    let p = hit.point.expect("point");
    assert!(
        (p[0] - 50.0).abs() < 0.2,
        "cap depth not on the plane: {p:?}"
    );
    let c = px(&img, cx as u32, cy as u32);
    assert!(c[0] > c[2] + 40, "cap colour {c:?}");
    // Without the section the same pixel is the plate's side at x = 100.
    vp.set_section(None);
    let hit = vp.pick_blocking(cx, cy).expect("side hit");
    assert_eq!(hit.kind, PickKind::Face);
    assert!((hit.point.expect("point")[0] - 100.0).abs() < 0.2);
}

#[test]
fn cylinder_silhouettes_are_drawn() {
    let Some(ctx) = context() else { return };
    let ir = corpus("programs/revolve_solid_cylinder.json");
    let mut vp = Viewport::new_offscreen(&ctx, W, H, 1.0);
    let b = bodies(&ir);
    vp.set_bodies(&b).expect("scene");
    assert!(vp.stats().silhouette_candidates > 0);
    vp.set_view(StandardView::Iso);
    let with = vp.render_image().expect("image");
    screenshot("cylinder_iso", &with);
    let mut opts = vp.options().clone();
    opts.silhouettes = false;
    vp.set_options(opts.clone());
    let without = vp.render_image().expect("image");
    // Silhouette lines darken some pixels that are otherwise shaded or background.
    let darker = with
        .pixels
        .chunks_exact(4)
        .zip(without.pixels.chunks_exact(4))
        .filter(|(a, b)| luma([a[0], a[1], a[2], 255]) + 40.0 < luma([b[0], b[1], b[2], 255]))
        .count();
    eprintln!("silhouette pixels: {darker}");
    assert!(darker > 150, "only {darker} silhouette pixels");
    opts.silhouettes = true;
    vp.set_options(opts);
}

#[test]
fn makerbench_like_parts_render_without_errors() {
    let Some(ctx) = context() else { return };
    let mut vp = Viewport::new_offscreen(&ctx, W, H, 2.0);
    for name in [
        "revolve_torus",
        "revolve_cone_sphere",
        "extrude_two_regions",
        "extrude_slot_symmetric_xz",
    ] {
        let ir = corpus(&format!("programs/{name}.json"));
        vp.set_bodies(&bodies(&ir)).expect("scene");
        vp.set_view(StandardView::Iso);
        let img = vp.render_image().expect("image");
        screenshot(name, &img);
        let hit = vp.pick_blocking(f64::from(W) / 2.0, f64::from(H) / 2.0);
        eprintln!(
            "{name}: {:?} {} triangles",
            hit.map(|h| (h.kind, h.face, h.edge)),
            vp.stats().triangles
        );
    }
}
