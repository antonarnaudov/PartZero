// Background gradient and the XY ground grid (mm) with coloured X/Y axes.

struct BgOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_background(@builtin(vertex_index) vi: u32) -> BgOut {
    let x = f32((vi << 1u) & 2u);
    let y = f32(vi & 2u);
    var out: BgOut;
    out.clip = vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2<f32>(x, y);
    return out;
}

fn hash2(p: vec2<u32>) -> f32 {
    var h = p.x * 1664525u + p.y * 1013904223u;
    h = h ^ (h >> 16u);
    h = h * 2246822519u;
    h = h ^ (h >> 13u);
    h = h * 3266489917u;
    h = h ^ (h >> 16u);
    return f32(h >> 8u) / 16777216.0;
}

@fragment
fn fs_background(in: BgOut) -> @location(0) vec4<f32> {
    let t = clamp(in.uv.y, 0.0, 1.0);
    let c = mix(frame.bg_bottom.rgb, frame.bg_top.rgb, t * t * (3.0 - 2.0 * t));
    // ±0.5 LSB ordered noise in sRGB space against gradient banding (deterministic).
    let n = hash2(vec2<u32>(in.clip.xy)) - 0.5;
    let s = clamp(linear_to_srgb(c) + vec3<f32>(n / 255.0), vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(srgb_to_linear(s), 1.0);
}

struct GridOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
};

@vertex
fn vs_grid(@builtin(vertex_index) vi: u32) -> GridOut {
    var xs = array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0);
    var ys = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
    let p = vec3<f32>(xs[vi] * frame.grid.z, ys[vi] * frame.grid.z, 0.0);
    var out: GridOut;
    // One pixel of depth away from the viewer, so faces lying on z = 0 win.
    out.clip = frame.view_proj * vec4<f32>(bias_towards_viewer(p, -1.0), 1.0);
    out.world = p;
    return out;
}

fn grid_lines(p: vec2<f32>, step: f32) -> f32 {
    let c = p / step;
    let fw = max(fwidth(c), vec2<f32>(1e-6));
    let g = abs(fract(c - 0.5) - 0.5) / fw;
    let l = min(g.x, g.y);
    // Fade a level out as its cells shrink below ~5 px (avoids moiré).
    let density = max(fw.x, fw.y);
    return (1.0 - min(l, 1.0)) * (1.0 - smoothstep(0.1, 0.25, density));
}

@fragment
fn fs_grid(in: GridOut) -> @location(0) vec4<f32> {
    let p = in.world.xy;
    let a_minor = grid_lines(p, frame.grid.x) * frame.grid_minor.a;
    let a_major = grid_lines(p, frame.grid.y) * frame.grid_major.a;
    var rgb = frame.grid_minor.rgb * a_minor * (1.0 - a_major) + frame.grid_major.rgb * a_major;
    var a = a_minor * (1.0 - a_major) + a_major;
    // World axes on the grid: X red, Y green (1.5 px wide).
    let fw = max(fwidth(p), vec2<f32>(1e-6));
    let ax = (1.0 - min(abs(p.y) / fw.y / 1.5, 1.0)) * 0.85;
    let ay = (1.0 - min(abs(p.x) / fw.x / 1.5, 1.0)) * 0.85;
    rgb = rgb * (1.0 - ax) + vec3<f32>(0.80, 0.16, 0.16) * ax;
    a = a * (1.0 - ax) + ax;
    rgb = rgb * (1.0 - ay) + vec3<f32>(0.18, 0.62, 0.22) * ay;
    a = a * (1.0 - ay) + ay;
    // Fade with distance and at grazing angles; dim when seen from below.
    let v = to_viewer(in.world);
    var fade = 1.0 - smoothstep(0.35 * frame.grid.w, frame.grid.w, length(in.world - frame.eye.xyz));
    if (!is_perspective()) {
        fade = 1.0 - smoothstep(0.35 * frame.grid.w, frame.grid.w, length(p - frame.eye.xy));
    }
    fade = fade * smoothstep(0.02, 0.2, abs(v.z));
    if (v.z < 0.0) {
        fade = fade * 0.35;
    }
    return vec4<f32>(rgb * fade, a * fade);
}
