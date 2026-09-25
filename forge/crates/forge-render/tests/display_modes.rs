//! Display modes on a real GPU (offscreen): wireframe, hidden line, X-ray and shaded without
//! edges, checked on pixels and picks of the corpus box (80 × 50 × 8, x ∈ [−40, 40],
//! y ∈ [−25, 25], z ∈ [0, 8]).
//!
//! Needs a GPU adapter; without one the tests print a notice and pass (as `offscreen.rs`),
//! unless `FORGE_RENDER_REQUIRE_GPU=1`.

use forge_mesh::TessParams;
use forge_render::glam::DVec3;
use forge_render::{
    DisplayMode, GpuContext, PickKind, RgbaImage, SceneBody, SectionPlane, StandardView, Viewport,
    wgpu,
};

const W: u32 = 480;
const H: u32 = 360;

fn context() -> Option<GpuContext> {
    match GpuContext::headless(wgpu::Backends::PRIMARY | wgpu::Backends::GL) {
        Ok(c) => Some(c),
        Err(e) => {
            if std::env::var("FORGE_RENDER_REQUIRE_GPU").is_ok_and(|v| v == "1") {
                panic!("no GPU adapter: {e}");
            }
            eprintln!("forge-render display-mode tests skipped: {e}");
            None
        }
    }
}

fn box_bodies() -> Vec<SceneBody> {
    let dir = std::fs::canonicalize(env!("CARGO_MANIFEST_DIR")).expect("manifest dir");
    let ir = std::fs::read_to_string(dir.join("../../../corpus/programs/extrude_box.json"))
        .expect("corpus");
    let doc = forge_ir::from_json(&ir).expect("valid IR");
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

fn px(img: &RgbaImage, x: f64, y: f64) -> [u8; 3] {
    let o = ((y.round() as u32 * img.width + x.round() as u32) * 4) as usize;
    [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2]]
}

fn luma(p: [u8; 3]) -> f64 {
    0.2126 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[2])
}

fn diff(a: [u8; 3], b: [u8; 3]) -> u8 {
    (0..3).map(|k| a[k].abs_diff(b[k])).max().unwrap_or(0)
}

fn project(vp: &Viewport, p: DVec3) -> (f64, f64) {
    let (w, h) = vp.size();
    let s = vp
        .camera
        .frame(f64::from(w), f64::from(h))
        .project(p)
        .expect("in front");
    (s.x, s.y)
}

fn set_mode(vp: &mut Viewport, mode: DisplayMode) {
    let mut o = vp.options().clone();
    o.display = mode;
    o.grid = false;
    o.axes = false;
    o.pick_radius = 0.0;
    vp.set_options(o);
}

struct Probe {
    /// Centre of the top face.
    top: (f64, f64),
    /// Midpoint of the top-front edge (visible from iso).
    edge: (f64, f64),
    /// Midpoint of the back-bottom edge (hidden behind the box from iso).
    hidden: (f64, f64),
}

fn setup(ctx: &GpuContext) -> (Viewport, Probe, RgbaImage) {
    let mut vp = Viewport::new_offscreen(ctx, W, H, 1.0);
    set_mode(&mut vp, DisplayMode::ShadedEdges);
    let empty = vp.render_image().expect("empty image");
    vp.set_bodies(&box_bodies()).expect("scene");
    vp.set_view(StandardView::Iso);
    let probe = Probe {
        top: project(&vp, DVec3::new(0.0, 0.0, 8.0)),
        edge: project(&vp, DVec3::new(0.0, -25.0, 8.0)),
        hidden: project(&vp, DVec3::new(-10.0, 25.0, 0.0)),
    };
    (vp, probe, empty)
}

#[test]
fn wireframe_draws_every_edge_and_no_faces_and_picks_edges_only() {
    let Some(ctx) = context() else { return };
    let (mut vp, p, empty) = setup(&ctx);
    let shaded = vp.render_image().expect("image");
    set_mode(&mut vp, DisplayMode::Wireframe);
    let wire = vp.render_image().expect("image");
    // No face: the top-face centre is background.
    assert!(
        diff(px(&wire, p.top.0, p.top.1), px(&empty, p.top.0, p.top.1)) < 6,
        "face drawn in wireframe"
    );
    assert!(diff(px(&shaded, p.top.0, p.top.1), px(&empty, p.top.0, p.top.1)) > 20);
    // The hidden back-bottom edge shows (dark), the visible one too.
    let bg = luma(px(&empty, p.hidden.0, p.hidden.1));
    assert!(
        luma(px(&wire, p.hidden.0, p.hidden.1)) < bg - 60.0,
        "hidden edge not drawn"
    );
    assert!(luma(px(&wire, p.edge.0, p.edge.1)) < bg - 60.0);
    // Picking: nothing at the face centre, the edge on the edge.
    assert!(vp.pick_blocking(p.top.0, p.top.1).expect("pick").is_none());
    let mut o = vp.options().clone();
    o.pick_radius = 3.0;
    vp.set_options(o);
    let hit = vp
        .pick_blocking(p.hidden.0, p.hidden.1)
        .expect("pick")
        .expect("edge");
    assert_eq!(hit.kind, PickKind::Edge);
    assert_eq!(vp.gpu_fault(), None);
}

#[test]
fn hidden_line_draws_paper_faces_that_hide_back_edges() {
    let Some(ctx) = context() else { return };
    let (mut vp, p, _) = setup(&ctx);
    let shaded = vp.render_image().expect("image");
    set_mode(&mut vp, DisplayMode::HiddenLine);
    let hl = vp.render_image().expect("image");
    let face = px(&hl, p.top.0, p.top.1);
    // Paper white, and not the shaded colour.
    assert!(luma(face) > 235.0, "face {face:?}");
    assert!(
        face.iter().max().unwrap_or(&0) - face.iter().min().unwrap_or(&0) < 12,
        "not neutral: {face:?}"
    );
    assert!(diff(face, px(&shaded, p.top.0, p.top.1)) > 20);
    // Visible edges drawn, the hidden one not (the face covers it).
    assert!(luma(px(&hl, p.edge.0, p.edge.1)) < luma(face) - 60.0);
    assert!(
        diff(px(&hl, p.hidden.0, p.hidden.1), face) < 16,
        "hidden edge shows through"
    );
    // Faces are pickable.
    let hit = vp
        .pick_blocking(p.top.0, p.top.1)
        .expect("pick")
        .expect("face");
    assert_eq!(hit.face.map(|f| f.1), Some("plate/cap:end".to_string()));
    // A selected face is tinted, not shaded.
    let e = vp
        .tables()
        .face_by_name("part/plate#0", "plate/cap:end")
        .expect("face");
    vp.set_selection(&[e]);
    let sel = vp.render_image().expect("image");
    assert!(diff(px(&sel, p.top.0, p.top.1), face) > 30);
    assert_eq!(vp.gpu_fault(), None);
}

#[test]
fn xray_shows_hidden_edges_through_translucent_faces() {
    let Some(ctx) = context() else { return };
    let (mut vp, p, empty) = setup(&ctx);
    let shaded = vp.render_image().expect("image");
    set_mode(&mut vp, DisplayMode::XRay);
    let x = vp.render_image().expect("image");
    let face = px(&x, p.top.0, p.top.1);
    // The darker front face lets the light background through: lighter than shaded, but
    // still there (not the background).
    let (fx, fy) = project(&vp, DVec3::new(0.0, -25.0, 4.0));
    let front = px(&x, fx, fy);
    eprintln!(
        "x-ray front {front:?} shaded {:?} background {:?}",
        px(&shaded, fx, fy),
        px(&empty, fx, fy)
    );
    assert!(
        luma(front) > luma(px(&shaded, fx, fy)) + 15.0,
        "front face opaque: {front:?}"
    );
    assert!(
        diff(front, px(&empty, fx, fy)) > 3,
        "front face invisible: {front:?}"
    );
    // The hidden edge is visible through the faces.
    assert!(
        luma(px(&x, p.hidden.0, p.hidden.1)) < luma(px(&shaded, p.hidden.0, p.hidden.1)) - 40.0,
        "hidden edge not visible"
    );
    // More opaque than the default setting, more like the shaded face.
    let mut o = vp.options().clone();
    o.xray_opacity = 0.8;
    vp.set_options(o);
    let dense = vp.render_image().expect("image");
    assert!(diff(px(&dense, fx, fy), px(&shaded, fx, fy)) < diff(front, px(&shaded, fx, fy)));
    let _ = face;
    // The nearest face is picked.
    let hit = vp
        .pick_blocking(p.top.0, p.top.1)
        .expect("pick")
        .expect("face");
    assert_eq!(hit.face.map(|f| f.1), Some("plate/cap:end".to_string()));
    // With a section plane (caps + translucent faces) the frame still renders cleanly.
    vp.set_section(Some(SectionPlane {
        origin: DVec3::new(0.0, 0.0, 4.0),
        normal: DVec3::new(1.0, 0.0, 0.0),
    }));
    vp.render_image().expect("image");
    set_mode(&mut vp, DisplayMode::Wireframe);
    vp.render_image().expect("image");
    assert_eq!(vp.gpu_fault(), None);
}

#[test]
fn shaded_mode_draws_no_edges_and_is_deterministic() {
    let Some(ctx) = context() else { return };
    let (mut vp, p, _) = setup(&ctx);
    let edges = vp.render_image().expect("image");
    set_mode(&mut vp, DisplayMode::Shaded);
    let plain = vp.render_image().expect("image");
    assert!(
        luma(px(&plain, p.edge.0, p.edge.1)) > luma(px(&edges, p.edge.0, p.edge.1)) + 40.0,
        "edge still drawn"
    );
    assert_eq!(plain.pixels, vp.render_image().expect("image").pixels);
    // Edges are not pickable when not drawn: the face under the cursor wins.
    let mut o = vp.options().clone();
    o.pick_radius = 4.0;
    vp.set_options(o);
    let hit = vp
        .pick_blocking(p.edge.0, p.edge.1 - 2.0)
        .expect("pick")
        .expect("face");
    assert_eq!(hit.kind, PickKind::Face);
    assert_eq!(vp.gpu_fault(), None);
}
