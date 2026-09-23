// Shaded B-rep faces, section caps, and the face ID pass.

struct FaceIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) face: u32,
    @location(3) color: vec4<f32>,
};

struct FaceOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
    @location(3) @interpolate(flat) face: u32,
    @location(4) @interpolate(flat) state: u32,
};

@vertex
fn vs_face(in: FaceIn) -> FaceOut {
    var out: FaceOut;
    out.clip = frame.view_proj * vec4<f32>(in.position, 1.0);
    out.world = in.position;
    out.normal = in.normal;
    out.color = srgb_to_linear(in.color.rgb);
    out.face = in.face;
    out.state = state_of(face_state, in.face);
    return out;
}

// Matte "PBR-lite": hemispheric ambient (Z up) + camera-relative key and fill lights,
// a soft Blinn-Phong highlight and a faint rim term for curvature cues.
fn shade(n_in: vec3<f32>, world: vec3<f32>, base: vec3<f32>) -> vec3<f32> {
    let n = normalize(n_in);
    let v = to_viewer(world);
    let hemi = mix(frame.ground.rgb, frame.sky.rgb, 0.5 + 0.5 * n.z) * frame.sky.a;
    let kd = max(dot(n, frame.key_light.xyz), 0.0) * frame.key_light.w;
    let fd = max(dot(n, frame.fill_light.xyz), 0.0) * frame.fill_light.w;
    let h = normalize(frame.key_light.xyz + v);
    let spec = pow(max(dot(n, h), 0.0), 40.0) * 0.16 * frame.key_light.w;
    let rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0) * 0.05;
    return base * (hemi + vec3<f32>(kd + fd)) + vec3<f32>(spec + rim);
}

fn highlight(base: vec3<f32>, state: u32) -> vec3<f32> {
    var c = base;
    let selected = (state & STATE_SELECTED) != 0u;
    if (selected) {
        c = mix(c, frame.select_color.rgb, frame.select_color.a);
    }
    if ((state & STATE_HOVER) != 0u) {
        // Hovering a selected face only lightens it, so the selection colour stays readable.
        if (selected) {
            c = mix(c, vec3<f32>(1.0), 0.25);
        } else {
            c = mix(c, frame.hover_color.rgb, frame.hover_color.a);
        }
    }
    return c;
}

@fragment
fn fs_face(in: FaceOut) -> @location(0) vec4<f32> {
    return vec4<f32>(shade(in.normal, in.world, highlight(in.color, in.state)), 1.0);
}

// ---- Section view -------------------------------------------------------------------
//
// With a clip plane, the cut solid is capped in three steps (closed bodies only):
// 1. `fs_section_mask` (own pass, additive): for every pixel, count the back faces (R)
//    and front faces (G) that survive the clip, with no depth test. Along a view ray
//    coming from the removed side, back − front = 1 exactly when the ray's crossing
//    point with the plane lies inside material.
// 2. Front faces are drawn clipped (`fs_face_clipped`, culling back faces).
// 3. Back faces carry the cap (`fs_cap`, culling front faces): where the mask says
//    "inside", they are shaded flat and hatched at the depth of the plane crossing, so
//    the cap occludes what lies behind it and is occluded by what lies in front.

@group(1) @binding(0) var section_mask: texture_2d<f32>;

@fragment
fn fs_face_clipped(in: FaceOut) -> @location(0) vec4<f32> {
    if (section_clipped(in.world)) {
        discard;
    }
    return vec4<f32>(shade(in.normal, in.world, highlight(in.color, in.state)), 1.0);
}

@fragment
fn fs_section_mask(in: FaceOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    if (section_clipped(in.world)) {
        discard;
    }
    let one = 1.0 / 255.0;
    if (front) {
        return vec4<f32>(0.0, one, 0.0, 0.0);
    }
    return vec4<f32>(one, 0.0, 0.0, 0.0);
}

fn inside_cut(pixel: vec2<f32>) -> bool {
    let m = textureLoad(section_mask, vec2<i32>(pixel), 0);
    return m.r > m.g + 0.5 / 255.0;
}

// Depth of the cap at this pixel. Several back faces can cover one cap pixel (several
// bodies along the ray); they all compute the same plane depth, and the tiny term in
// the fragment's own depth lets the nearest one win (reverse-Z: larger is nearer).
fn cap_depth(in: FaceOut) -> f32 {
    return section_cap_depth(in.world) + 1e-6 * in.clip.z;
}

fn cap_color(world: vec3<f32>, pixel: vec2<f32>) -> vec3<f32> {
    var n = frame.section.xyz;
    if (dot(n, to_viewer(world)) < 0.0) {
        n = -n;
    }
    var c = shade(n, world, frame.cap_color.rgb);
    // Light 45° hatching in screen space, 8 CSS px apart.
    let k = (pixel.x + pixel.y) / (8.0 * frame.right.w);
    if (fract(k) < 0.12) {
        c = c * 0.8;
    }
    return c;
}

struct CapOut {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

@fragment
fn fs_cap(in: FaceOut) -> CapOut {
    if (section_clipped(in.world) || !inside_cut(in.clip.xy)) {
        discard;
    }
    var out: CapOut;
    out.color = vec4<f32>(cap_color(in.world, in.clip.xy), 1.0);
    out.depth = cap_depth(in);
    return out;
}

// ---- ID passes ------------------------------------------------------------------------

@fragment
fn fs_face_id(in: FaceOut) -> IdOut {
    var out: IdOut;
    out.id = ID_FACE | in.face;
    out.depth = bitcast<u32>(in.clip.z);
    return out;
}

@fragment
fn fs_face_id_clipped(in: FaceOut) -> IdOut {
    if (section_clipped(in.world)) {
        discard;
    }
    var out: IdOut;
    out.id = ID_FACE | in.face;
    out.depth = bitcast<u32>(in.clip.z);
    return out;
}

struct CapIdOut {
    @location(0) id: u32,
    @location(1) depth: u32,
    @builtin(frag_depth) frag_depth: f32,
};

@fragment
fn fs_cap_id(in: FaceOut) -> CapIdOut {
    if (section_clipped(in.world) || !inside_cut(in.clip.xy)) {
        discard;
    }
    var out: CapIdOut;
    out.id = ID_CAP | in.face;
    out.frag_depth = cap_depth(in);
    out.depth = bitcast<u32>(out.frag_depth);
    return out;
}
