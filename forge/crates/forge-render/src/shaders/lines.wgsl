// Screen-space constant-width lines as instanced quads: B-rep edges, silhouettes, the
// axes gizmo, and the edge ID pass. `line_geom` mirrors `lines::line_corner` (Rust).

struct LineIn {
    @location(0) p0: vec3<f32>,
    @location(1) p1: vec3<f32>,
    @location(2) id: u32,
    @location(3) color: vec4<f32>,
};

struct SilhouetteIn {
    @location(0) p0: vec3<f32>,
    @location(1) p1: vec3<f32>,
    @location(2) na: vec3<f32>,
    @location(3) nb: vec3<f32>,
    @location(4) face: u32,
};

struct LineOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) dist: f32,
    @location(2) @interpolate(flat) half_width: f32,
    @location(3) color: vec4<f32>,
    @location(4) @interpolate(flat) id: u32,
};

struct LineGeom {
    clip: vec4<f32>,
    dist: f32,
    world: vec3<f32>,
};

// A position outside the clip volume: the whole quad is discarded by clipping.
const CULLED: vec4<f32> = vec4<f32>(2.0, 2.0, 2.0, 1.0);

fn line_geom(p0w: vec3<f32>, p1w: vec3<f32>, vi: u32, half_width: f32) -> LineGeom {
    var g: LineGeom;
    let bias = frame.lines.z;
    var c0 = frame.view_proj * vec4<f32>(bias_towards_viewer(p0w, bias), 1.0);
    var c1 = frame.view_proj * vec4<f32>(bias_towards_viewer(p1w, bias), 1.0);
    var w0 = p0w;
    var w1 = p1w;
    if (is_perspective()) {
        let near = frame.up.w;
        let in0 = c0.w >= near;
        let in1 = c1.w >= near;
        if (!in0 && !in1) {
            g.clip = CULLED;
            g.dist = 0.0;
            g.world = p0w;
            return g;
        }
        if (!in0) {
            let t = (near - c0.w) / (c1.w - c0.w);
            c0 = mix(c0, c1, t);
            w0 = mix(w0, w1, t);
        }
        if (!in1) {
            let t = (near - c1.w) / (c0.w - c1.w);
            c1 = mix(c1, c0, t);
            w1 = mix(w1, w0, t);
        }
    }
    let vp = frame.viewport.xy;
    let s0 = c0.xy / c0.w * vp * 0.5;
    let s1 = c1.xy / c1.w * vp * 0.5;
    let d = s1 - s0;
    let len = length(d);
    var dir = vec2<f32>(1.0, 0.0);
    if (len > 1e-6) {
        dir = d / len;
    }
    let normal = vec2<f32>(-dir.y, dir.x);
    let end1 = vi == 2u || vi == 4u || vi == 5u;
    let side = select(-1.0, 1.0, vi == 1u || vi == 2u || vi == 4u);
    let ext = half_width + 1.0;
    let along = select(-half_width, half_width, end1);
    let off = normal * (side * ext) + dir * along;
    let c = select(c0, c1, end1);
    let clip_off = off * 2.0 / vp * c.w;
    g.clip = vec4<f32>(c.xy + clip_off, c.z, c.w);
    g.dist = side * ext;
    g.world = select(w0, w1, end1);
    return g;
}

fn line_out(g: LineGeom, half_width: f32, color: vec4<f32>, id: u32) -> LineOut {
    var out: LineOut;
    out.clip = g.clip;
    out.world = g.world;
    out.dist = g.dist;
    out.half_width = half_width;
    out.color = color;
    out.id = id;
    return out;
}

@vertex
fn vs_edge(@builtin(vertex_index) vi: u32, in: LineIn) -> LineOut {
    let state = state_of(edge_state, in.id);
    var hw = frame.lines.x;
    var color = vec4<f32>(srgb_to_linear(in.color.rgb), in.color.a);
    if ((state & STATE_SELECTED) != 0u) {
        hw = hw * frame.lines.w;
        color = vec4<f32>(frame.select_color.rgb, 1.0);
    }
    if ((state & STATE_HOVER) != 0u) {
        hw = hw * frame.lines.w;
        color = vec4<f32>(frame.hover_color.rgb, 1.0);
    }
    return line_out(line_geom(in.p0, in.p1, vi, hw), hw, color, in.id);
}

@vertex
fn vs_gizmo(@builtin(vertex_index) vi: u32, in: LineIn) -> LineOut {
    let hw = frame.lines.x;
    let color = vec4<f32>(srgb_to_linear(in.color.rgb), in.color.a);
    return line_out(line_geom(in.p0, in.p1, vi, hw), hw, color, in.id);
}

// Keeps only the mesh edges where the facing flips for the current view: the exact
// silhouette of the tessellated surface (within the chordal deflection of the B-rep).
@vertex
fn vs_silhouette(@builtin(vertex_index) vi: u32, in: SilhouetteIn) -> LineOut {
    let v = to_viewer(0.5 * (in.p0 + in.p1));
    let sa = dot(in.na, v);
    let sb = dot(in.nb, v);
    let hw = frame.lines.y;
    var g: LineGeom;
    if (frame.flags.z == 0u || sa * sb > 0.0) {
        g.clip = CULLED;
        g.dist = 0.0;
        g.world = in.p0;
    } else {
        g = line_geom(in.p0, in.p1, vi, hw);
    }
    return line_out(g, hw, frame.edge_color, ID_FACE | in.face);
}

@fragment
fn fs_line(in: LineOut) -> @location(0) vec4<f32> {
    if (section_clipped(in.world)) {
        discard;
    }
    let a = clamp(in.half_width + 0.5 - abs(in.dist), 0.0, 1.0) * in.color.a;
    if (a <= 0.0) {
        discard;
    }
    return vec4<f32>(in.color.rgb * a, a);
}

@fragment
fn fs_line_id(in: LineOut) -> IdOut {
    if (section_clipped(in.world) || abs(in.dist) > max(in.half_width, 1.0)) {
        discard;
    }
    var out: IdOut;
    out.id = ID_EDGE | in.id;
    out.depth = bitcast<u32>(in.clip.z);
    return out;
}
