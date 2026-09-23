//! The viewport: GPU resources, pipelines, frame encoding and ID picking.
//!
//! ## Frame
//! 1. **Main pass** (MSAA ×4 where supported, `Rgba8UnormSrgb` + reverse-Z
//!    `Depth32Float`): background gradient → faces (culled; or unculled with section
//!    clipping and caps) → ground grid → silhouettes → B-rep edges → axes gizmo
//!    (corner viewport). Resolved into a single-sample colour texture.
//! 2. **Blit** of the resolved image into the output view (a canvas surface texture or
//!    an offscreen texture), encoding sRGB in the shader when the output format is
//!    linear (e.g. WebGPU canvases).
//!
//! ## Picking
//! [`Viewport::begin_pick`] renders face ids and edge ids (`R32Uint`, see
//! [`crate::pick`]) plus the depth bits (`R32Uint`) into single-sample targets, scissored
//! to a small window around the cursor, and copies that window into a mappable buffer.
//! The host maps it (blocking natively, asynchronously on the web) and calls
//! [`Viewport::finish_pick`].

use std::collections::BTreeSet;

use glam::{DMat4, DVec3, DVec4};
use wgpu::util::DeviceExt;

use crate::camera::{Camera, CameraFrame, Projection, Sphere, StandardView};
use crate::context::{COLOR_FORMAT, DEPTH_FORMAT, GpuContext, ID_FORMAT};
use crate::pick::{self, PickKind, PickWindow};
use crate::scene::{
    EntityRef, FACE_VERTEX_STRIDE, LINE_INSTANCE_STRIDE, SILHOUETTE_INSTANCE_STRIDE, SceneBody,
    SceneData, SceneError, SceneTables,
};

const COMMON_WGSL: &str = include_str!("shaders/common.wgsl");
const FACES_WGSL: &str = include_str!("shaders/faces.wgsl");
const LINES_WGSL: &str = include_str!("shaders/lines.wgsl");
const GRID_WGSL: &str = include_str!("shaders/grid.wgsl");
const BLIT_WGSL: &str = include_str!("shaders/blit.wgsl");

/// Texels per row of the state textures (matches `STATE_WIDTH` in common.wgsl).
const STATE_WIDTH: u32 = 2048;
const STATE_HOVER: u8 = 1;
const STATE_SELECTED: u8 = 2;
/// Size of the `Frame` uniform in bytes.
const FRAME_SIZE: u64 = 2 * 64 + 21 * 16;
/// Capacity of the gizmo line buffer (segments).
const GIZMO_CAPACITY: u64 = 32;

/// Display options (all widths in CSS pixels).
#[derive(Clone, Debug, PartialEq)]
pub struct ViewOptions {
    /// B-rep edge line width.
    pub edge_width: f64,
    /// Silhouette line width.
    pub silhouette_width: f64,
    /// Width multiplier for hovered/selected edges.
    pub highlight_width_scale: f64,
    /// Depth bias of lines towards the viewer, in pixels of depth.
    pub line_depth_bias: f64,
    /// Show the ground grid.
    pub grid: bool,
    /// Show the axes gizmo.
    pub axes: bool,
    /// Show B-rep edges.
    pub edges: bool,
    /// Show silhouettes.
    pub silhouettes: bool,
    /// Edge snapping radius for picking.
    pub pick_radius: f64,
}

impl Default for ViewOptions {
    fn default() -> Self {
        ViewOptions {
            edge_width: 1.25,
            silhouette_width: 1.25,
            highlight_width_scale: 2.2,
            line_depth_bias: 1.5,
            grid: true,
            axes: true,
            edges: true,
            silhouettes: true,
            pick_radius: 4.0,
        }
    }
}

/// A section (clip) plane: everything on the side `normal` points to is removed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SectionPlane {
    /// A point on the plane (mm).
    pub origin: DVec3,
    /// Normal towards the removed half-space (need not be unit; must be non-zero).
    pub normal: DVec3,
}

/// Counters of the current scene and the last frame.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameStats {
    /// Bodies.
    pub bodies: u32,
    /// Faces.
    pub faces: u32,
    /// Edges.
    pub edges: u32,
    /// Triangles.
    pub triangles: u32,
    /// Vertices (after per-face splitting).
    pub vertices: u32,
    /// Edge line segments.
    pub edge_segments: u32,
    /// Silhouette candidate segments.
    pub silhouette_candidates: u32,
    /// Draw calls in the last frame.
    pub draw_calls: u32,
    /// Colour MSAA sample count.
    pub sample_count: u32,
    /// Target width (px).
    pub width: u32,
    /// Target height (px).
    pub height: u32,
    /// Frames rendered.
    pub frames: u64,
}

/// A picked entity.
#[derive(Clone, Debug, PartialEq)]
pub struct PickHit {
    /// What was hit.
    pub kind: PickKind,
    /// Body index (input order of [`Viewport::set_bodies`]).
    pub body: u32,
    /// Body name.
    pub body_name: String,
    /// `(local index, provenance name)` of the face (face hits and section caps — for a
    /// cap, the face behind the cut).
    pub face: Option<(u32, String)>,
    /// `(local index, provenance name)` of the edge (edge hits).
    pub edge: Option<(u32, String)>,
    /// World point under the picked pixel (mm).
    pub point: Option<[f64; 3]>,
    /// The picked pixel (physical px).
    pub pixel: [u32; 2],
    /// The encoded id.
    pub id: u32,
}

/// A pick in flight: the read-back buffer and what is needed to interpret it.
#[derive(Debug)]
pub struct PickRequest {
    buffer: wgpu::Buffer,
    window: PickWindow,
    bytes_per_row: u32,
    frame: CameraFrame,
    generation: u64,
    edge_radius: u32,
}

impl PickRequest {
    /// The buffer to map for reading (whole range).
    pub fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }
}

/// An RGBA8 image (sRGB-encoded, rows top to bottom, tightly packed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbaImage {
    /// Width (px).
    pub width: u32,
    /// Height (px).
    pub height: u32,
    /// `width × height × 4` bytes.
    pub pixels: Vec<u8>,
}

struct Pipelines {
    background: wgpu::RenderPipeline,
    face: wgpu::RenderPipeline,
    face_clipped: wgpu::RenderPipeline,
    section_mask: wgpu::RenderPipeline,
    cap: wgpu::RenderPipeline,
    grid: wgpu::RenderPipeline,
    silhouette: wgpu::RenderPipeline,
    edge: wgpu::RenderPipeline,
    gizmo: wgpu::RenderPipeline,
    face_id: wgpu::RenderPipeline,
    face_id_clipped: wgpu::RenderPipeline,
    cap_id: wgpu::RenderPipeline,
    edge_id: wgpu::RenderPipeline,
    blit: wgpu::RenderPipeline,
}

struct IdTargets {
    id: wgpu::Texture,
    id_view: wgpu::TextureView,
    depth_bits: wgpu::Texture,
    depth_bits_view: wgpu::TextureView,
    depth_view: wgpu::TextureView,
}

struct Targets {
    width: u32,
    height: u32,
    color_ms: Option<wgpu::TextureView>,
    color: wgpu::TextureView,
    depth: wgpu::TextureView,
    id: Option<IdTargets>,
    blit_bind: wgpu::BindGroup,
    /// Section parity mask (R: back faces, G: front faces surviving the clip).
    mask: wgpu::TextureView,
    mask_bind: wgpu::BindGroup,
}

struct GpuScene {
    vertices: Option<wgpu::Buffer>,
    indices: Option<wgpu::Buffer>,
    index_count: u32,
    edges: Option<wgpu::Buffer>,
    edge_count: u32,
    silhouettes: Option<wgpu::Buffer>,
    silhouette_count: u32,
    tables: SceneTables,
    sphere: Option<Sphere>,
    face_state: Vec<u8>,
    edge_state: Vec<u8>,
    face_tex: wgpu::Texture,
    edge_tex: wgpu::Texture,
    frame_bind: wgpu::BindGroup,
    gizmo_bind: wgpu::BindGroup,
}

/// The CAD viewport (see the module docs).
pub struct Viewport {
    ctx: GpuContext,
    output_format: wgpu::TextureFormat,
    frame_layout: wgpu::BindGroupLayout,
    blit_layout: wgpu::BindGroupLayout,
    mask_layout: wgpu::BindGroupLayout,
    pipes: Pipelines,
    frame_buf: wgpu::Buffer,
    gizmo_buf: wgpu::Buffer,
    gizmo_lines: wgpu::Buffer,
    targets: Targets,
    scene: GpuScene,
    offscreen: Option<(wgpu::Texture, wgpu::TextureView)>,
    /// The camera (public: hosts may drive it directly).
    pub camera: Camera,
    options: ViewOptions,
    dpr: f64,
    hover: Option<EntityRef>,
    selection: BTreeSet<EntityRef>,
    section: Option<SectionPlane>,
    generation: u64,
    stats: FrameStats,
}

fn module(device: &wgpu::Device, label: &str, body: &str, with_common: bool) -> wgpu::ShaderModule {
    let src = if with_common {
        format!("{COMMON_WGSL}\n{body}")
    } else {
        body.to_string()
    };
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(src.into()),
    })
}

const PREMULTIPLIED: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
};

const ADDITIVE: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Add,
    },
};

/// Format of the section parity mask.
const MASK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

struct PipeDesc<'a> {
    label: &'a str,
    module: &'a wgpu::ShaderModule,
    vs: &'a str,
    fs: &'a str,
    buffers: &'a [Option<wgpu::VertexBufferLayout<'a>>],
    cull: Option<wgpu::Face>,
    depth_write: bool,
    depth_compare: wgpu::CompareFunction,
    targets: &'a [Option<wgpu::ColorTargetState>],
    samples: u32,
    depth: bool,
}

fn pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    d: PipeDesc<'_>,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(d.label),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: d.module,
            entry_point: Some(d.vs),
            compilation_options: Default::default(),
            buffers: d.buffers,
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: d.cull,
            ..Default::default()
        },
        depth_stencil: d.depth.then(|| wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(d.depth_write),
            depth_compare: Some(d.depth_compare),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: d.samples,
            ..Default::default()
        },
        fragment: Some(wgpu::FragmentState {
            module: d.module,
            entry_point: Some(d.fs),
            compilation_options: Default::default(),
            targets: d.targets,
        }),
        multiview_mask: None,
        cache: None,
    })
}

const FACE_ATTRS: [wgpu::VertexAttribute; 4] =
    wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Uint32, 3 => Unorm8x4];
const LINE_ATTRS: [wgpu::VertexAttribute; 4] =
    wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Uint32, 3 => Unorm8x4];
const SIL_ATTRS: [wgpu::VertexAttribute; 5] = wgpu::vertex_attr_array![
    0 => Float32x3, 1 => Float32x3, 2 => Float32x3, 3 => Float32x3, 4 => Uint32
];

fn face_layout() -> wgpu::VertexBufferLayout<'static> {
    wgpu::VertexBufferLayout {
        array_stride: FACE_VERTEX_STRIDE,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &FACE_ATTRS,
    }
}

fn line_layout() -> wgpu::VertexBufferLayout<'static> {
    wgpu::VertexBufferLayout {
        array_stride: LINE_INSTANCE_STRIDE,
        step_mode: wgpu::VertexStepMode::Instance,
        attributes: &LINE_ATTRS,
    }
}

fn silhouette_layout() -> wgpu::VertexBufferLayout<'static> {
    wgpu::VertexBufferLayout {
        array_stride: SILHOUETTE_INSTANCE_STRIDE,
        step_mode: wgpu::VertexStepMode::Instance,
        attributes: &SIL_ATTRS,
    }
}

fn create_pipelines(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    mask_layout: &wgpu::BindGroupLayout,
    blit_layout: &wgpu::BindGroupLayout,
    samples: u32,
    output_format: wgpu::TextureFormat,
) -> Pipelines {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("forge-render frame"),
        bind_group_layouts: &[Some(frame_layout)],
        immediate_size: 0,
    });
    let cap_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("forge-render section cap"),
        bind_group_layouts: &[Some(frame_layout), Some(mask_layout)],
        immediate_size: 0,
    });
    let blit_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("forge-render blit"),
        bind_group_layouts: &[Some(blit_layout)],
        immediate_size: 0,
    });
    let faces = module(device, "faces.wgsl", FACES_WGSL, true);
    let lines = module(device, "lines.wgsl", LINES_WGSL, true);
    let grid = module(device, "grid.wgsl", GRID_WGSL, true);
    let blit = module(device, "blit.wgsl", BLIT_WGSL, false);

    let opaque = [Some(wgpu::ColorTargetState {
        format: COLOR_FORMAT,
        blend: None,
        write_mask: wgpu::ColorWrites::ALL,
    })];
    let blended = [Some(wgpu::ColorTargetState {
        format: COLOR_FORMAT,
        blend: Some(PREMULTIPLIED),
        write_mask: wgpu::ColorWrites::ALL,
    })];
    let id_targets = [
        Some(wgpu::ColorTargetState {
            format: ID_FORMAT,
            blend: None,
            write_mask: wgpu::ColorWrites::ALL,
        }),
        Some(wgpu::ColorTargetState {
            format: ID_FORMAT,
            blend: None,
            write_mask: wgpu::ColorWrites::ALL,
        }),
    ];
    let face_buf = [Some(face_layout())];
    let line_buf = [Some(line_layout())];
    let sil_buf = [Some(silhouette_layout())];
    use wgpu::CompareFunction::{Always, GreaterEqual};
    let main_with =
        |layout, label, module, vs, fs, buffers, cull, depth_write, depth_compare, targets| {
            pipeline(
                device,
                layout,
                PipeDesc {
                    label,
                    module,
                    vs,
                    fs,
                    buffers,
                    cull,
                    depth_write,
                    depth_compare,
                    targets,
                    samples,
                    depth: true,
                },
            )
        };
    let main = |label, module, vs, fs, buffers, cull, depth_write, depth_compare, targets| {
        main_with(
            &layout,
            label,
            module,
            vs,
            fs,
            buffers,
            cull,
            depth_write,
            depth_compare,
            targets,
        )
    };
    let id_with = |layout, label, module, vs, fs, buffers, cull, depth_write| {
        pipeline(
            device,
            layout,
            PipeDesc {
                label,
                module,
                vs,
                fs,
                buffers,
                cull,
                depth_write,
                depth_compare: GreaterEqual,
                targets: &id_targets,
                samples: 1,
                depth: true,
            },
        )
    };
    let id = |label, module, vs, fs, buffers, cull, depth_write| {
        id_with(&layout, label, module, vs, fs, buffers, cull, depth_write)
    };
    let back = Some(wgpu::Face::Back);
    let front = Some(wgpu::Face::Front);
    Pipelines {
        background: main(
            "background",
            &grid,
            "vs_background",
            "fs_background",
            &[],
            None,
            false,
            Always,
            &opaque,
        ),
        face: main(
            "face",
            &faces,
            "vs_face",
            "fs_face",
            &face_buf,
            back,
            true,
            GreaterEqual,
            &opaque,
        ),
        face_clipped: main(
            "face clipped",
            &faces,
            "vs_face",
            "fs_face_clipped",
            &face_buf,
            back,
            true,
            GreaterEqual,
            &opaque,
        ),
        cap: main_with(
            &cap_layout,
            "section cap",
            &faces,
            "vs_face",
            "fs_cap",
            &face_buf,
            front,
            true,
            GreaterEqual,
            &opaque,
        ),
        section_mask: pipeline(
            device,
            &layout,
            PipeDesc {
                label: "section mask",
                module: &faces,
                vs: "vs_face",
                fs: "fs_section_mask",
                buffers: &face_buf,
                cull: None,
                depth_write: false,
                depth_compare: Always,
                targets: &[Some(wgpu::ColorTargetState {
                    format: MASK_FORMAT,
                    blend: Some(ADDITIVE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                samples: 1,
                depth: false,
            },
        ),
        grid: main(
            "grid",
            &grid,
            "vs_grid",
            "fs_grid",
            &[],
            None,
            false,
            GreaterEqual,
            &blended,
        ),
        silhouette: main(
            "silhouette",
            &lines,
            "vs_silhouette",
            "fs_line",
            &sil_buf,
            None,
            false,
            GreaterEqual,
            &blended,
        ),
        edge: main(
            "edge",
            &lines,
            "vs_edge",
            "fs_line",
            &line_buf,
            None,
            false,
            GreaterEqual,
            &blended,
        ),
        gizmo: main(
            "gizmo", &lines, "vs_gizmo", "fs_line", &line_buf, None, false, Always, &blended,
        ),
        face_id: id(
            "face id",
            &faces,
            "vs_face",
            "fs_face_id",
            &face_buf,
            back,
            true,
        ),
        face_id_clipped: id(
            "face id clipped",
            &faces,
            "vs_face",
            "fs_face_id_clipped",
            &face_buf,
            back,
            true,
        ),
        cap_id: id_with(
            &cap_layout,
            "cap id",
            &faces,
            "vs_face",
            "fs_cap_id",
            &face_buf,
            front,
            true,
        ),
        edge_id: id(
            "edge id",
            &lines,
            "vs_edge",
            "fs_line_id",
            &line_buf,
            None,
            false,
        ),
        blit: pipeline(
            device,
            &blit_pl,
            PipeDesc {
                label: "blit",
                module: &blit,
                vs: "vs_fullscreen",
                fs: if output_format.is_srgb() {
                    "fs_blit"
                } else {
                    "fs_blit_encode"
                },
                buffers: &[],
                cull: None,
                depth_write: false,
                depth_compare: Always,
                targets: &[Some(wgpu::ColorTargetState {
                    format: output_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                samples: 1,
                depth: false,
            },
        ),
    }
}

fn texture(
    device: &wgpu::Device,
    label: &str,
    (w, h): (u32, u32),
    format: wgpu::TextureFormat,
    samples: u32,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: samples,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor::default())
}

/// sRGB (0..1) → linear.
fn lin(c: [f64; 3]) -> [f64; 3] {
    c.map(|x| {
        if x <= 0.04045 {
            x / 12.92
        } else {
            forge_core::math::powf((x + 0.055) / 1.055, 2.4)
        }
    })
}

/// Little-endian uniform writer.
#[derive(Default)]
struct Uniform(Vec<u8>);

impl Uniform {
    fn mat(&mut self, m: &DMat4) {
        for v in m.to_cols_array() {
            self.0.extend_from_slice(&(v as f32).to_le_bytes());
        }
    }
    fn v4(&mut self, v: [f64; 4]) {
        for x in v {
            self.0.extend_from_slice(&(x as f32).to_le_bytes());
        }
    }
    fn v3w(&mut self, v: DVec3, w: f64) {
        self.v4([v.x, v.y, v.z, w]);
    }
    fn rgb(&mut self, c: [f64; 3], a: f64) {
        let l = lin(c);
        self.v4([l[0], l[1], l[2], a]);
    }
    fn u4(&mut self, v: [u32; 4]) {
        for x in v {
            self.0.extend_from_slice(&x.to_le_bytes());
        }
    }
}

/// Parameters of one `Frame` uniform.
struct FrameParams<'a> {
    cam: &'a CameraFrame,
    section: Option<SectionPlane>,
    grid: bool,
    silhouettes: bool,
    edge_half_px: f64,
    silhouette_half_px: f64,
    bias_px: f64,
    highlight_scale: f64,
    dpr: f64,
    grid_steps: (f64, f64, f64, f64),
}

fn frame_uniform(p: &FrameParams<'_>) -> Vec<u8> {
    let c = p.cam;
    let mut u = Uniform::default();
    u.mat(&c.view_proj);
    u.mat(&c.inv_view_proj);
    u.v3w(c.eye, if c.perspective { 1.0 } else { 0.0 });
    u.v3w(c.forward, c.px_scale);
    u.v3w(c.right, p.dpr);
    u.v3w(c.up, if c.perspective { c.near } else { 0.0 });
    u.v4([c.size.x, c.size.y, 1.0 / c.size.x, 1.0 / c.size.y]);
    match p.section {
        Some(s) => {
            let n = s.normal.normalize_or_zero();
            u.v3w(n, n.dot(s.origin));
        }
        None => u.v4([0.0, 0.0, 1.0, 0.0]),
    }
    u.u4([
        u32::from(p.section.is_some()),
        u32::from(p.grid),
        u32::from(p.silhouettes),
        0,
    ]);
    u.v4([
        p.edge_half_px,
        p.silhouette_half_px,
        p.bias_px,
        p.highlight_scale,
    ]);
    // Camera-relative lights (view-space directions → world).
    let to_world = |x: f64, y: f64, z: f64| (c.right * x + c.up * y - c.forward * z).normalize();
    u.v3w(to_world(-0.35, 0.55, 0.75), 0.62);
    u.v3w(to_world(0.65, -0.25, 0.45), 0.2);
    u.rgb([0.98, 0.99, 1.0], 0.46);
    u.rgb([0.62, 0.60, 0.58], 0.0);
    u.rgb([0.10, 0.11, 0.13], 1.0); // edge (silhouette) colour
    u.rgb([0.30, 0.62, 1.0], 0.38); // hover tint
    u.rgb([1.0, 0.55, 0.12], 0.6); // selection
    u.rgb([0.86, 0.42, 0.32], 1.0); // section cap
    u.rgb([0.955, 0.965, 0.98], 1.0); // background top
    u.rgb([0.80, 0.83, 0.87], 1.0); // background bottom
    let (minor, major, extent, fade) = p.grid_steps;
    u.v4([minor, major, extent, fade]);
    u.rgb([0.45, 0.48, 0.53], 0.22);
    u.rgb([0.40, 0.43, 0.48], 0.45);
    debug_assert_eq!(u.0.len() as u64, FRAME_SIZE);
    u.0
}

fn create_scene_resources(
    ctx: &GpuContext,
    frame_layout: &wgpu::BindGroupLayout,
    frame_buf: &wgpu::Buffer,
    gizmo_buf: &wgpu::Buffer,
    data: &SceneData,
) -> GpuScene {
    let device = &ctx.device;
    let buf = |label: &str, bytes: &[u8], usage: wgpu::BufferUsages| {
        (!bytes.is_empty()).then(|| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytes,
                usage,
            })
        })
    };
    let v = wgpu::BufferUsages::VERTEX;
    let indices: Vec<u8> = data.indices.iter().flat_map(|i| i.to_le_bytes()).collect();
    let state_tex = |label: &str, n: u32| {
        let rows = n.div_ceil(STATE_WIDTH).max(1);
        texture(
            device,
            label,
            (STATE_WIDTH, rows),
            wgpu::TextureFormat::R8Uint,
            1,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        )
    };
    let nf = data.tables.face_count();
    let ne = data.tables.edge_count();
    let face_tex = state_tex("face state", nf);
    let edge_tex = state_tex("edge state", ne);
    let (fv, ev) = (view(&face_tex), view(&edge_tex));
    let bind = |ubo: &wgpu::Buffer| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("forge-render frame"),
            layout: frame_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: ubo.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&fv),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&ev),
                },
            ],
        })
    };
    let sphere = data.bounds.map(|(lo, hi)| Sphere::from_box(lo, hi, 1e-3));
    let s = GpuScene {
        vertices: buf("faces", &data.vertices, v),
        indices: buf("indices", &indices, wgpu::BufferUsages::INDEX),
        index_count: data.indices.len() as u32,
        edges: buf("edges", &data.edge_segments, v),
        edge_count: data.edge_segment_count,
        silhouettes: buf("silhouettes", &data.silhouettes, v),
        silhouette_count: data.silhouette_count,
        tables: data.tables.clone(),
        sphere,
        face_state: vec![0; (nf.div_ceil(STATE_WIDTH).max(1) * STATE_WIDTH) as usize],
        edge_state: vec![0; (ne.div_ceil(STATE_WIDTH).max(1) * STATE_WIDTH) as usize],
        frame_bind: bind(frame_buf),
        gizmo_bind: bind(gizmo_buf),
        face_tex,
        edge_tex,
    };
    upload_state(&ctx.queue, &s.face_tex, &s.face_state);
    upload_state(&ctx.queue, &s.edge_tex, &s.edge_state);
    s
}

fn upload_state(queue: &wgpu::Queue, tex: &wgpu::Texture, bytes: &[u8]) {
    let rows = (bytes.len() as u32 / STATE_WIDTH).max(1);
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(STATE_WIDTH),
            rows_per_image: Some(rows),
        },
        wgpu::Extent3d {
            width: STATE_WIDTH,
            height: rows,
            depth_or_array_layers: 1,
        },
    );
}

impl Viewport {
    /// A viewport rendering into views of `output_format`, `width × height` physical
    /// pixels at device-pixel ratio `dpr`.
    pub fn new(
        ctx: &GpuContext,
        output_format: wgpu::TextureFormat,
        width: u32,
        height: u32,
        dpr: f64,
    ) -> Self {
        let device = &ctx.device;
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge-render frame"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(FRAME_SIZE),
                    },
                    count: None,
                },
                state_entry(1),
                state_entry(2),
            ],
        });
        let blit_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge-render blit"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let mask_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("forge-render section mask"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let pipes = create_pipelines(
            device,
            &frame_layout,
            &mask_layout,
            &blit_layout,
            ctx.sample_count,
            output_format,
        );
        let ubo = |label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: FRAME_SIZE,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let frame_buf = ubo("frame");
        let gizmo_buf = ubo("gizmo frame");
        let gizmo_lines = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gizmo lines"),
            size: GIZMO_CAPACITY * LINE_INSTANCE_STRIDE,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let (w, h) = clamp_size(ctx, width, height);
        let targets = create_targets(ctx, &blit_layout, &mask_layout, w, h);
        let scene = create_scene_resources(
            ctx,
            &frame_layout,
            &frame_buf,
            &gizmo_buf,
            &SceneData::default(),
        );
        Viewport {
            ctx: ctx.clone(),
            output_format,
            frame_layout,
            blit_layout,
            mask_layout,
            pipes,
            frame_buf,
            gizmo_buf,
            gizmo_lines,
            targets,
            scene,
            offscreen: None,
            camera: Camera::default(),
            options: ViewOptions::default(),
            dpr: sanitize_dpr(dpr),
            hover: None,
            selection: BTreeSet::new(),
            section: None,
            generation: 0,
            stats: FrameStats::default(),
        }
    }

    /// An offscreen viewport (output `Rgba8UnormSrgb`) for headless renders.
    pub fn new_offscreen(ctx: &GpuContext, width: u32, height: u32, dpr: f64) -> Self {
        Self::new(ctx, wgpu::TextureFormat::Rgba8UnormSrgb, width, height, dpr)
    }

    /// The GPU context.
    pub fn context(&self) -> &GpuContext {
        &self.ctx
    }

    /// The output format the viewport renders into.
    pub fn output_format(&self) -> wgpu::TextureFormat {
        self.output_format
    }

    /// Target size in physical pixels.
    pub fn size(&self) -> (u32, u32) {
        (self.targets.width, self.targets.height)
    }

    /// Device pixel ratio.
    pub fn dpr(&self) -> f64 {
        self.dpr
    }

    /// Current options.
    pub fn options(&self) -> &ViewOptions {
        &self.options
    }

    /// Replace the options.
    pub fn set_options(&mut self, options: ViewOptions) {
        self.options = options;
    }

    /// Counters.
    pub fn stats(&self) -> &FrameStats {
        &self.stats
    }

    /// Name tables of the current scene.
    pub fn tables(&self) -> &SceneTables {
        &self.scene.tables
    }

    /// Scene generation: incremented by every [`Viewport::set_bodies`].
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Resize the targets (physical pixels) and set the device pixel ratio.
    pub fn resize(&mut self, width: u32, height: u32, dpr: f64) {
        self.dpr = sanitize_dpr(dpr);
        let (w, h) = clamp_size(&self.ctx, width, height);
        if (w, h) != (self.targets.width, self.targets.height) {
            self.targets = create_targets(&self.ctx, &self.blit_layout, &self.mask_layout, w, h);
            self.offscreen = None;
        }
    }

    /// Replace the scene. Keeps the camera; the first non-empty scene is framed.
    /// Hover and selection are re-resolved by *name* (provenance), so they survive
    /// re-evaluation when the entities still exist.
    pub fn set_bodies(&mut self, bodies: &[SceneBody]) -> Result<(), SceneError> {
        let data = SceneData::build(bodies)?;
        self.set_scene_data(&data);
        Ok(())
    }

    /// Replace the scene with pre-packed data (see [`Viewport::set_bodies`]).
    pub fn set_scene_data(&mut self, data: &SceneData) {
        let names = |t: &SceneTables, e: EntityRef| -> Option<(String, bool, String)> {
            match e {
                EntityRef::Face(g) => t
                    .face(g)
                    .map(|(b, _, n)| (t.bodies[b as usize].name.clone(), true, n.to_string())),
                EntityRef::Edge(g) => t
                    .edge(g)
                    .map(|(b, _, n)| (t.bodies[b as usize].name.clone(), false, n.to_string())),
            }
        };
        let old = &self.scene.tables;
        let hover = self.hover.and_then(|e| names(old, e));
        let sel: Vec<_> = self
            .selection
            .iter()
            .filter_map(|&e| names(old, e))
            .collect();
        let was_empty = self.scene.sphere.is_none();
        self.scene = create_scene_resources(
            &self.ctx,
            &self.frame_layout,
            &self.frame_buf,
            &self.gizmo_buf,
            data,
        );
        self.generation += 1;
        let resolve = |t: &SceneTables, (b, face, n): &(String, bool, String)| {
            if *face {
                t.face_by_name(b, n)
            } else {
                t.edge_by_name(b, n)
            }
        };
        self.hover = hover.as_ref().and_then(|h| resolve(&self.scene.tables, h));
        self.selection = sel
            .iter()
            .filter_map(|s| resolve(&self.scene.tables, s))
            .collect();
        self.refresh_state();
        let t = &self.scene.tables;
        self.stats.bodies = t.bodies.len() as u32;
        self.stats.faces = t.face_count();
        self.stats.edges = t.edge_count();
        self.stats.triangles = data.triangle_count();
        self.stats.vertices = data.vertex_count;
        self.stats.edge_segments = data.edge_segment_count;
        self.stats.silhouette_candidates = data.silhouette_count;
        if let Some(s) = self.scene.sphere {
            self.camera.scene = s;
            if was_empty {
                self.fit_view();
            }
        }
    }

    fn aspect(&self) -> f64 {
        f64::from(self.targets.width) / f64::from(self.targets.height.max(1))
    }

    /// Frame the whole scene.
    pub fn fit_view(&mut self) {
        let s = self.scene.sphere.unwrap_or(self.camera.scene);
        let a = self.aspect();
        self.camera.fit(s, a);
    }

    /// Switch to a standard view (and fit).
    pub fn set_view(&mut self, view: StandardView) {
        if let Some(s) = self.scene.sphere {
            self.camera.scene = s;
        }
        let a = self.aspect();
        self.camera.set_view(view, a);
    }

    /// Perspective or orthographic.
    pub fn set_projection(&mut self, p: Projection) {
        self.camera.projection = p;
    }

    /// Orbit by a pointer motion in physical pixels.
    pub fn orbit(&mut self, dx_px: f64, dy_px: f64) {
        self.camera.orbit(dx_px / self.dpr, dy_px / self.dpr);
    }

    /// Pan by a pointer motion in physical pixels.
    pub fn pan(&mut self, dx_px: f64, dy_px: f64) {
        let h = f64::from(self.targets.height);
        self.camera.pan(dx_px, dy_px, h);
    }

    /// Zoom by `factor` (< 1 zooms in) about the physical pixel `(x, y)`.
    pub fn zoom_at(&mut self, x_px: f64, y_px: f64, factor: f64) {
        let (w, h) = (
            f64::from(self.targets.width),
            f64::from(self.targets.height),
        );
        self.camera.zoom_at(x_px, y_px, w, h, factor);
    }

    /// Set or clear the section plane (a zero normal clears it).
    pub fn set_section(&mut self, plane: Option<SectionPlane>) {
        self.section = plane.filter(|p| {
            p.normal.length_squared() > 0.0 && p.normal.is_finite() && p.origin.is_finite()
        });
    }

    /// The section plane.
    pub fn section(&self) -> Option<SectionPlane> {
        self.section
    }

    /// Set the hovered entity.
    pub fn set_hover(&mut self, e: Option<EntityRef>) {
        if self.hover != e {
            self.hover = e;
            self.refresh_state();
        }
    }

    /// The hovered entity.
    pub fn hover(&self) -> Option<EntityRef> {
        self.hover
    }

    /// Replace the selection.
    pub fn set_selection(&mut self, entities: &[EntityRef]) {
        let s: BTreeSet<EntityRef> = entities.iter().copied().collect();
        if s != self.selection {
            self.selection = s;
            self.refresh_state();
        }
    }

    /// The selection.
    pub fn selection(&self) -> impl Iterator<Item = EntityRef> + '_ {
        self.selection.iter().copied()
    }

    fn refresh_state(&mut self) {
        let s = &mut self.scene;
        let (nf, ne) = (s.tables.face_count(), s.tables.edge_count());
        s.face_state.fill(0);
        s.edge_state.fill(0);
        let mut mark = |e: EntityRef, bit: u8| match e {
            EntityRef::Face(g) if g < nf => s.face_state[g as usize] |= bit,
            EntityRef::Edge(g) if g < ne => s.edge_state[g as usize] |= bit,
            _ => {}
        };
        for &e in &self.selection {
            mark(e, STATE_SELECTED);
        }
        if let Some(h) = self.hover {
            mark(h, STATE_HOVER);
        }
        upload_state(&self.ctx.queue, &s.face_tex, &s.face_state);
        upload_state(&self.ctx.queue, &s.edge_tex, &s.edge_state);
    }

    fn camera_frame(&self) -> CameraFrame {
        let mut cam = self.camera.clone();
        if let Some(s) = self.scene.sphere {
            cam.scene = s;
        }
        cam.frame(
            f64::from(self.targets.width),
            f64::from(self.targets.height),
        )
    }

    fn grid_steps(&self, cam: &CameraFrame) -> (f64, f64, f64, f64) {
        use forge_core::math;
        let wpp_css = self.camera.world_per_px(f64::from(self.targets.height)) * self.dpr;
        // Minor lines at least ~12 CSS px apart, on a power of ten.
        let decade = math::ln((wpp_css * 12.0).max(1e-9)) / math::ln(10.0);
        let minor = math::powf(10.0, decade.ceil());
        let r = self.scene.sphere.map_or(50.0, |s| s.radius);
        let fade = (self.camera.distance * 6.0).max(r * 4.0);
        let extent = fade * if cam.perspective { 1.0 } else { 2.0 };
        (minor, minor * 10.0, extent, fade)
    }

    fn write_uniforms(&self, cam: &CameraFrame) {
        let o = &self.options;
        let params = FrameParams {
            cam,
            section: self.section,
            grid: o.grid,
            silhouettes: o.silhouettes,
            edge_half_px: o.edge_width * self.dpr * 0.5,
            silhouette_half_px: o.silhouette_width * self.dpr * 0.5,
            bias_px: o.line_depth_bias * self.dpr,
            highlight_scale: o.highlight_width_scale,
            dpr: self.dpr,
            grid_steps: self.grid_steps(cam),
        };
        self.ctx
            .queue
            .write_buffer(&self.frame_buf, 0, &frame_uniform(&params));
    }

    /// Gizmo corner size and origin in physical pixels.
    fn gizmo_rect(&self) -> (f32, f32, f32) {
        let s = (96.0 * self.dpr).min(f64::from(self.targets.width.min(self.targets.height)) * 0.4);
        let m = 8.0 * self.dpr;
        (
            m as f32,
            (f64::from(self.targets.height) - m - s) as f32,
            s as f32,
        )
    }

    fn write_gizmo(&self, cam: &CameraFrame) -> u32 {
        let (_, _, size) = self.gizmo_rect();
        let size = f64::from(size).max(1.0);
        // Orthographic, rotation only: the gizmo lives in [-1.6, 1.6]^2.
        let half = 1.6;
        let view = DMat4::from_cols(
            DVec4::new(cam.right.x, cam.up.x, -cam.forward.x, 0.0),
            DVec4::new(cam.right.y, cam.up.y, -cam.forward.y, 0.0),
            DVec4::new(cam.right.z, cam.up.z, -cam.forward.z, 0.0),
            DVec4::new(0.0, 0.0, 0.0, 1.0),
        );
        let proj = DMat4::from_cols(
            DVec4::new(1.0 / half, 0.0, 0.0, 0.0),
            DVec4::new(0.0, 1.0 / half, 0.0, 0.0),
            DVec4::new(0.0, 0.0, 0.25, 0.0),
            DVec4::new(0.0, 0.0, 0.5, 1.0),
        );
        let view_proj = proj * view;
        let gcam = CameraFrame {
            view,
            proj,
            view_proj,
            inv_view_proj: view_proj.inverse(),
            eye: -cam.forward * 3.0,
            forward: cam.forward,
            right: cam.right,
            up: cam.up,
            px_scale: 2.0 * half / size,
            near: 0.0,
            far: 0.0,
            perspective: false,
            size: glam::DVec2::new(size, size),
        };
        let params = FrameParams {
            cam: &gcam,
            section: None,
            grid: false,
            silhouettes: false,
            edge_half_px: self.dpr,
            silhouette_half_px: 0.0,
            bias_px: 0.0,
            highlight_scale: 1.0,
            dpr: self.dpr,
            grid_steps: (1.0, 10.0, 1.0, 1.0),
        };
        self.ctx
            .queue
            .write_buffer(&self.gizmo_buf, 0, &frame_uniform(&params));
        let segs = gizmo_segments(cam.right, cam.up, cam.forward);
        let mut bytes = Vec::with_capacity(segs.len() * LINE_INSTANCE_STRIDE as usize);
        for (a, b, color) in &segs {
            for v in [a.x, a.y, a.z, b.x, b.y, b.z] {
                bytes.extend_from_slice(&(v as f32).to_le_bytes());
            }
            bytes.extend_from_slice(&u32::MAX.to_le_bytes());
            bytes.extend_from_slice(color);
        }
        self.ctx.queue.write_buffer(&self.gizmo_lines, 0, &bytes);
        segs.len() as u32
    }

    /// Is a section active on a non-empty scene?
    fn sectioned(&self) -> bool {
        self.section.is_some() && self.scene.vertices.is_some()
    }

    /// The section parity-mask pass (see `faces.wgsl`), optionally scissored.
    fn encode_mask_pass(&self, enc: &mut wgpu::CommandEncoder, scissor: Option<&PickWindow>) {
        let s = &self.scene;
        let (Some(vb), Some(ib)) = (&s.vertices, &s.indices) else {
            return;
        };
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("section mask"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.targets.mask,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        if let Some(w) = scissor {
            pass.set_scissor_rect(w.x0, w.y0, w.width, w.height);
        }
        pass.set_bind_group(0, &s.frame_bind, &[]);
        pass.set_pipeline(&self.pipes.section_mask);
        pass.set_vertex_buffer(0, vb.slice(..));
        pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..s.index_count, 0, 0..1);
    }

    /// Render a frame into `output` (a view of the output format).
    pub fn render(&mut self, output: &wgpu::TextureView) {
        let cam = self.camera_frame();
        self.write_uniforms(&cam);
        let gizmo_count = if self.options.axes {
            self.write_gizmo(&cam)
        } else {
            0
        };
        let mut enc = self
            .ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forge-render frame"),
            });
        let mut draws = 0u32;
        let sectioned = self.sectioned();
        if sectioned {
            self.encode_mask_pass(&mut enc, None);
            draws += 1;
        }
        {
            let t = &self.targets;
            let (color_view, resolve) = match &t.color_ms {
                Some(ms) => (ms, Some(&t.color)),
                None => (&t.color, None),
            };
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: color_view,
                    depth_slice: None,
                    resolve_target: resolve,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: if resolve.is_some() {
                            wgpu::StoreOp::Discard
                        } else {
                            wgpu::StoreOp::Store
                        },
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &t.depth,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(0.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            let s = &self.scene;
            pass.set_bind_group(0, &s.frame_bind, &[]);
            pass.set_pipeline(&self.pipes.background);
            pass.draw(0..3, 0..1);
            draws += 1;
            if let (Some(vb), Some(ib)) = (&s.vertices, &s.indices) {
                pass.set_vertex_buffer(0, vb.slice(..));
                pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
                if sectioned {
                    pass.set_pipeline(&self.pipes.face_clipped);
                    pass.draw_indexed(0..s.index_count, 0, 0..1);
                    pass.set_bind_group(1, &t.mask_bind, &[]);
                    pass.set_pipeline(&self.pipes.cap);
                    pass.draw_indexed(0..s.index_count, 0, 0..1);
                    draws += 2;
                } else {
                    pass.set_pipeline(&self.pipes.face);
                    pass.draw_indexed(0..s.index_count, 0, 0..1);
                    draws += 1;
                }
            }
            if self.options.grid {
                pass.set_pipeline(&self.pipes.grid);
                pass.draw(0..6, 0..1);
                draws += 1;
            }
            if self.options.silhouettes
                && let Some(sb) = &s.silhouettes
            {
                pass.set_pipeline(&self.pipes.silhouette);
                pass.set_vertex_buffer(0, sb.slice(..));
                pass.draw(0..6, 0..s.silhouette_count);
                draws += 1;
            }
            if self.options.edges
                && let Some(eb) = &s.edges
            {
                pass.set_pipeline(&self.pipes.edge);
                pass.set_vertex_buffer(0, eb.slice(..));
                pass.draw(0..6, 0..s.edge_count);
                draws += 1;
            }
            if gizmo_count > 0 {
                let (x, y, size) = self.gizmo_rect();
                pass.set_viewport(x, y, size, size, 0.0, 1.0);
                pass.set_bind_group(0, &s.gizmo_bind, &[]);
                pass.set_pipeline(&self.pipes.gizmo);
                pass.set_vertex_buffer(0, self.gizmo_lines.slice(..));
                pass.draw(0..6, 0..gizmo_count);
                draws += 1;
            }
        }
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: output,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipes.blit);
            pass.set_bind_group(0, &self.targets.blit_bind, &[]);
            pass.draw(0..3, 0..1);
            draws += 1;
        }
        self.ctx.queue.submit([enc.finish()]);
        self.stats.draw_calls = draws;
        self.stats.sample_count = self.ctx.sample_count;
        self.stats.width = self.targets.width;
        self.stats.height = self.targets.height;
        self.stats.frames += 1;
    }

    /// Start a pick at physical pixel `(x, y)`: renders the ID pass around the cursor
    /// and schedules the copy. `None` when the point is outside the viewport.
    pub fn begin_pick(&mut self, x_px: f64, y_px: f64) -> Option<PickRequest> {
        let (w, h) = (self.targets.width, self.targets.height);
        let radius = (self.options.pick_radius * self.dpr)
            .round()
            .clamp(0.0, 64.0) as u32;
        let window = PickWindow::around(x_px, y_px, radius, w, h)?;
        let cam = self.camera_frame();
        self.write_uniforms(&cam);
        if self.targets.id.is_none() {
            self.targets.id = Some(create_id_targets(&self.ctx, w, h));
        }
        let Some(id) = &self.targets.id else {
            return None;
        };
        let bpr = window.padded_bytes_per_row();
        let half = u64::from(bpr) * u64::from(window.height);
        let buffer = self.ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pick readback"),
            size: half * 2,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = self
            .ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("forge-render pick"),
            });
        let sectioned = self.sectioned();
        if sectioned {
            self.encode_mask_pass(&mut enc, Some(&window));
        }
        {
            let clear = wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                store: wgpu::StoreOp::Store,
            };
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("id"),
                color_attachments: &[
                    Some(wgpu::RenderPassColorAttachment {
                        view: &id.id_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: clear,
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: &id.depth_bits_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: clear,
                    }),
                ],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &id.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(0.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            pass.set_scissor_rect(window.x0, window.y0, window.width, window.height);
            let s = &self.scene;
            pass.set_bind_group(0, &s.frame_bind, &[]);
            if let (Some(vb), Some(ib)) = (&s.vertices, &s.indices) {
                pass.set_vertex_buffer(0, vb.slice(..));
                pass.set_index_buffer(ib.slice(..), wgpu::IndexFormat::Uint32);
                if sectioned {
                    pass.set_pipeline(&self.pipes.face_id_clipped);
                    pass.draw_indexed(0..s.index_count, 0, 0..1);
                    pass.set_bind_group(1, &self.targets.mask_bind, &[]);
                    pass.set_pipeline(&self.pipes.cap_id);
                    pass.draw_indexed(0..s.index_count, 0, 0..1);
                } else {
                    pass.set_pipeline(&self.pipes.face_id);
                    pass.draw_indexed(0..s.index_count, 0, 0..1);
                }
            }
            if self.options.edges
                && let Some(eb) = &s.edges
            {
                pass.set_pipeline(&self.pipes.edge_id);
                pass.set_vertex_buffer(0, eb.slice(..));
                pass.draw(0..6, 0..s.edge_count);
            }
        }
        let extent = wgpu::Extent3d {
            width: window.width,
            height: window.height,
            depth_or_array_layers: 1,
        };
        for (tex, offset) in [(&id.id, 0), (&id.depth_bits, half)] {
            enc.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: window.x0,
                        y: window.y0,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset,
                        bytes_per_row: Some(bpr),
                        rows_per_image: Some(window.height),
                    },
                },
                extent,
            );
        }
        self.ctx.queue.submit([enc.finish()]);
        Some(PickRequest {
            buffer,
            window,
            bytes_per_row: bpr,
            frame: cam,
            generation: self.generation,
            edge_radius: radius,
        })
    }

    /// Interpret the mapped contents of a [`PickRequest`] buffer. `None` for the
    /// background, or when the scene changed since the pick started.
    pub fn finish_pick(&self, req: &PickRequest, bytes: &[u8]) -> Option<PickHit> {
        if req.generation != self.generation {
            return None;
        }
        let win = &req.window;
        let half = (req.bytes_per_row * win.height) as usize;
        let ids = pick::unpack_rows(bytes.get(..half)?, win, req.bytes_per_row);
        let depths = pick::unpack_rows(bytes.get(half..)?, win, req.bytes_per_row);
        let chosen = pick::choose(&ids, win, req.edge_radius)?;
        let k = ((chosen.y - win.y0) * win.width + (chosen.x - win.x0)) as usize;
        let depth = f64::from(f32::from_bits(depths[k]));
        let point = (depth > 0.0).then(|| {
            req.frame
                .unproject(f64::from(chosen.x) + 0.5, f64::from(chosen.y) + 0.5, depth)
                .to_array()
        });
        let (kind, index) = pick::decode(chosen.id)?;
        let t = &self.scene.tables;
        let (body, face, edge) = match kind {
            PickKind::Face | PickKind::SectionCap => {
                let (b, l, n) = t.face(index)?;
                (b, Some((l, n.to_string())), None)
            }
            PickKind::Edge => {
                let (b, l, n) = t.edge(index)?;
                (b, None, Some((l, n.to_string())))
            }
        };
        Some(PickHit {
            kind,
            body,
            body_name: t.bodies[body as usize].name.clone(),
            face,
            edge,
            point,
            pixel: [chosen.x, chosen.y],
            id: chosen.id,
        })
    }

    /// Pick synchronously (native hosts: tests, CLI, agents).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn pick_blocking(&mut self, x_px: f64, y_px: f64) -> Option<PickHit> {
        let req = self.begin_pick(x_px, y_px)?;
        let bytes = read_buffer_blocking(&self.ctx.device, req.buffer())?;
        self.finish_pick(&req, &bytes)
    }

    /// Render into an internal `Rgba8UnormSrgb` texture and read it back (native).
    /// Requires an offscreen viewport ([`Viewport::new_offscreen`]).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_image(&mut self) -> Option<RgbaImage> {
        if self.output_format != wgpu::TextureFormat::Rgba8UnormSrgb {
            return None;
        }
        let (w, h) = (self.targets.width, self.targets.height);
        if self.offscreen.is_none() {
            let t = texture(
                &self.ctx.device,
                "offscreen output",
                (w, h),
                wgpu::TextureFormat::Rgba8UnormSrgb,
                1,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            );
            let v = view(&t);
            self.offscreen = Some((t, v));
        }
        let (tex, v) = self.offscreen.as_ref()?;
        let (tex, v) = (tex.clone(), v.clone());
        self.render(&v);
        let bpr = (w * 4).div_ceil(256) * 256;
        let buffer = self.ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("image readback"),
            size: u64::from(bpr) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = self
            .ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("readback"),
            });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bpr),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        self.ctx.queue.submit([enc.finish()]);
        let bytes = read_buffer_blocking(&self.ctx.device, &buffer)?;
        let mut pixels = Vec::with_capacity((w * h * 4) as usize);
        for row in 0..h as usize {
            let s = row * bpr as usize;
            pixels.extend_from_slice(&bytes[s..s + (w * 4) as usize]);
        }
        Some(RgbaImage {
            width: w,
            height: h,
            pixels,
        })
    }
}

/// Map a buffer for reading and wait (native).
#[cfg(not(target_arch = "wasm32"))]
pub fn read_buffer_blocking(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Option<Vec<u8>> {
    use std::sync::{Arc, Mutex};
    let done: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
    let d = Arc::clone(&done);
    buffer.map_async(wgpu::MapMode::Read, .., move |r| {
        if let Ok(mut g) = d.lock() {
            *g = Some(r.is_ok());
        }
    });
    device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    let ok = done.lock().ok().and_then(|g| *g)?;
    if !ok {
        return None;
    }
    let bytes = buffer.get_mapped_range(..).ok()?.to_vec();
    buffer.unmap();
    Some(bytes)
}

fn state_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Uint,
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn sanitize_dpr(dpr: f64) -> f64 {
    if dpr.is_finite() && dpr > 0.0 {
        dpr.clamp(0.25, 8.0)
    } else {
        1.0
    }
}

fn clamp_size(ctx: &GpuContext, w: u32, h: u32) -> (u32, u32) {
    let m = ctx.max_texture_dimension.max(1);
    (w.clamp(1, m), h.clamp(1, m))
}

fn create_targets(
    ctx: &GpuContext,
    blit_layout: &wgpu::BindGroupLayout,
    mask_layout: &wgpu::BindGroupLayout,
    w: u32,
    h: u32,
) -> Targets {
    let d = &ctx.device;
    let ra = wgpu::TextureUsages::RENDER_ATTACHMENT;
    let color = texture(
        d,
        "color",
        (w, h),
        COLOR_FORMAT,
        1,
        ra | wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let color_ms = (ctx.sample_count > 1).then(|| {
        view(&texture(
            d,
            "color msaa",
            (w, h),
            COLOR_FORMAT,
            ctx.sample_count,
            ra,
        ))
    });
    let depth = view(&texture(
        d,
        "depth",
        (w, h),
        DEPTH_FORMAT,
        ctx.sample_count,
        ra,
    ));
    let color_view = view(&color);
    let blit_bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("blit"),
        layout: blit_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(&color_view),
        }],
    });
    let mask = view(&texture(
        d,
        "section mask",
        (w, h),
        MASK_FORMAT,
        1,
        ra | wgpu::TextureUsages::TEXTURE_BINDING,
    ));
    let mask_bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("section mask"),
        layout: mask_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(&mask),
        }],
    });
    Targets {
        width: w,
        height: h,
        color_ms,
        color: color_view,
        depth,
        id: None,
        blit_bind,
        mask,
        mask_bind,
    }
}

fn create_id_targets(ctx: &GpuContext, w: u32, h: u32) -> IdTargets {
    let d = &ctx.device;
    let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC;
    let id = texture(d, "id", (w, h), ID_FORMAT, 1, usage);
    let depth_bits = texture(d, "id depth bits", (w, h), ID_FORMAT, 1, usage);
    let depth = texture(
        d,
        "id depth",
        (w, h),
        DEPTH_FORMAT,
        1,
        wgpu::TextureUsages::RENDER_ATTACHMENT,
    );
    IdTargets {
        id_view: view(&id),
        depth_bits_view: view(&depth_bits),
        depth_view: view(&depth),
        id,
        depth_bits,
    }
}

/// Axes-gizmo segments `(from, to, sRGB colour)` in gizmo space, back to front: the
/// three unit axes and stroke letters X, Y, Z facing the screen.
fn gizmo_segments(right: DVec3, up: DVec3, forward: DVec3) -> Vec<(DVec3, DVec3, [u8; 4])> {
    const COLORS: [[u8; 4]; 3] = [[214, 58, 58, 255], [56, 168, 72, 255], [58, 110, 222, 255]];
    let axes = [DVec3::X, DVec3::Y, DVec3::Z];
    let s = 0.16;
    let letter = |i: usize, tip: DVec3| -> Vec<(DVec3, DVec3)> {
        let p = |x: f64, y: f64| tip + right * (x * s) + up * (y * s);
        match i {
            0 => vec![(p(-1.0, -1.0), p(1.0, 1.0)), (p(-1.0, 1.0), p(1.0, -1.0))],
            1 => vec![
                (p(-1.0, 1.0), p(0.0, 0.0)),
                (p(1.0, 1.0), p(0.0, 0.0)),
                (p(0.0, 0.0), p(0.0, -1.0)),
            ],
            _ => vec![
                (p(-1.0, 1.0), p(1.0, 1.0)),
                (p(1.0, 1.0), p(-1.0, -1.0)),
                (p(-1.0, -1.0), p(1.0, -1.0)),
            ],
        }
    };
    // Axes sorted far → near (larger forward·axis is farther).
    let mut order: Vec<usize> = (0..3).collect();
    order.sort_by(|&a, &b| {
        let da = axes[a].dot(forward);
        let db = axes[b].dot(forward);
        db.total_cmp(&da).then(a.cmp(&b))
    });
    let mut out = Vec::new();
    for &i in &order {
        out.push((DVec3::ZERO, axes[i], COLORS[i]));
    }
    for &i in &order {
        for (a, b) in letter(i, axes[i] * 1.35) {
            out.push((a, b, COLORS[i]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_uniform_has_the_wgsl_layout_size() {
        let cam = Camera::default().frame(640.0, 480.0);
        let p = FrameParams {
            cam: &cam,
            section: None,
            grid: true,
            silhouettes: true,
            edge_half_px: 1.0,
            silhouette_half_px: 1.0,
            bias_px: 1.0,
            highlight_scale: 2.0,
            dpr: 1.0,
            grid_steps: (1.0, 10.0, 100.0, 100.0),
        };
        assert_eq!(frame_uniform(&p).len() as u64, FRAME_SIZE);
        // The WGSL struct has exactly 2 matrices and 21 vec4s.
        let src = include_str!("shaders/common.wgsl");
        let start = src.find("struct Frame {").expect("Frame struct");
        let body = &src[start..src[start..].find("};").expect("end") + start];
        assert_eq!(body.matches("mat4x4<f32>").count(), 2);
        assert_eq!(body.matches(": vec4<").count(), 21);
    }

    #[test]
    fn gizmo_draws_three_axes_and_letters_back_to_front() {
        let segs = gizmo_segments(DVec3::X, DVec3::Z, DVec3::Y);
        assert_eq!(segs.len(), 3 + 2 + 3 + 3);
        // Looking along +Y: the Y axis points away and is drawn first.
        assert_eq!(segs[0].1, DVec3::Y);
        assert!(segs.len() <= GIZMO_CAPACITY as usize);
    }

    #[test]
    fn srgb_conversion_matches_reference_points() {
        let l = lin([0.0, 0.5, 1.0]);
        assert!(l[0].abs() < 1e-15);
        assert!((l[1] - 0.214_041).abs() < 1e-5);
        assert!((l[2] - 1.0).abs() < 1e-12);
    }
}
