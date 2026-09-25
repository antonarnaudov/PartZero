// Shared by every forge-render shader module (prepended to each at build time).
//
// Must stay compatible with WebGL2 through naga's GLSL ES 3.00 backend: no storage
// buffers, no clip distances, no base vertex/instance; integer varyings are flat.

// Pick id encoding: kind << 30 | index (see src/pick.rs; a unit test checks these).
const ID_FACE: u32 = 1073741824u;
const ID_EDGE: u32 = 2147483648u;
const ID_CAP: u32 = 3221225472u;
const ID_INDEX_MASK: u32 = 1073741823u;

// Width of the per-face / per-edge state textures (texels per row).
const STATE_WIDTH: u32 = 2048u;
const STATE_HOVER: u32 = 1u;
const STATE_SELECTED: u32 = 2u;

// Display modes (`frame.flags.w`; see src/display.rs, a unit test checks these).
const MODE_SHADED: u32 = 0u;
const MODE_SHADED_EDGES: u32 = 1u;
const MODE_WIREFRAME: u32 = 2u;
const MODE_HIDDEN_LINE: u32 = 3u;
const MODE_XRAY: u32 = 4u;

struct Frame {
    view_proj: mat4x4<f32>,
    inv_view_proj: mat4x4<f32>,
    // xyz: eye (perspective) or a point on the camera plane; w: 1 perspective, 0 ortho.
    eye: vec4<f32>,
    // xyz: view direction; w: world size of a pixel (at unit distance if perspective).
    forward: vec4<f32>,
    // xyz: screen right; w: device pixel ratio.
    right: vec4<f32>,
    // xyz: screen up; w: perspective near plane (clip w).
    up: vec4<f32>,
    // x, y: target size in pixels; z, w: 1/x, 1/y.
    viewport: vec4<f32>,
    // xyz: section plane normal (clipped side); w: dot(normal, origin).
    section: vec4<f32>,
    // x: section on; y: grid on; z: silhouettes on; w: display mode (MODE_*).
    flags: vec4<u32>,
    // x: edge half width px; y: silhouette half width px; z: depth bias px; w: highlight width scale.
    lines: vec4<f32>,
    // xyz: key light direction (towards the light, world); w: intensity.
    key_light: vec4<f32>,
    fill_light: vec4<f32>,
    // Hemispheric ambient: rgb (linear), a: intensity.
    sky: vec4<f32>,
    ground: vec4<f32>,
    edge_color: vec4<f32>,
    hover_color: vec4<f32>,
    select_color: vec4<f32>,
    cap_color: vec4<f32>,
    bg_top: vec4<f32>,
    bg_bottom: vec4<f32>,
    // x: minor step (mm); y: major step; z: half extent; w: fade distance.
    grid: vec4<f32>,
    grid_minor: vec4<f32>,
    grid_major: vec4<f32>,
    // x: X-ray face opacity; yzw: hidden-line face colour (linear).
    display: vec4<f32>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var face_state: texture_2d<u32>;
@group(0) @binding(2) var edge_state: texture_2d<u32>;

fn state_of(tex: texture_2d<u32>, index: u32) -> u32 {
    let c = vec2<i32>(i32(index % STATE_WIDTH), i32(index / STATE_WIDTH));
    return textureLoad(tex, c, 0).r;
}

fn is_perspective() -> bool {
    return frame.eye.w > 0.5;
}

// Unit vector from a world point towards the viewer.
fn to_viewer(p: vec3<f32>) -> vec3<f32> {
    if (is_perspective()) {
        return normalize(frame.eye.xyz - p);
    }
    return -frame.forward.xyz;
}

// Signed distance to the section plane: > 0 on the clipped side.
fn section_distance(p: vec3<f32>) -> f32 {
    return dot(frame.section.xyz, p) - frame.section.w;
}

fn section_clipped(p: vec3<f32>) -> bool {
    return frame.flags.x != 0u && section_distance(p) > 0.0;
}

// Move a world point towards the viewer along its view ray by `px` pixels' worth of
// depth (screen position unchanged).
fn bias_towards_viewer(p: vec3<f32>, px: f32) -> vec3<f32> {
    if (is_perspective()) {
        let k = min(px * frame.forward.w, 0.25);
        return p + (frame.eye.xyz - p) * k;
    }
    return p - frame.forward.xyz * (px * frame.forward.w);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

// Reverse-Z depth of the point where the view ray through world point `p` crosses the
// section plane (for caps); falls back to p's own depth for rays parallel to the plane.
fn section_cap_depth(p: vec3<f32>) -> f32 {
    var origin: vec3<f32>;
    var dir: vec3<f32>;
    if (is_perspective()) {
        origin = frame.eye.xyz;
        dir = p - origin;
    } else {
        dir = frame.forward.xyz;
        origin = p - dir;
    }
    let n = frame.section.xyz;
    let denom = dot(n, dir);
    var q = p;
    if (abs(denom) > 1e-12) {
        let t = (frame.section.w - dot(n, origin)) / denom;
        q = origin + dir * t;
    }
    let c = frame.view_proj * vec4<f32>(q, 1.0);
    return clamp(c.z / c.w, 0.0, 1.0);
}

// Output of the ID passes: the encoded id and the bit pattern of the reverse-Z depth.
struct IdOut {
    @location(0) id: u32,
    @location(1) depth: u32,
};
