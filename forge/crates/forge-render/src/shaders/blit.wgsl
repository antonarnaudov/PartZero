// Final copy of the resolved (linear, sRGB-stored) image to the output target.
// Self-contained: does not include common.wgsl.

@group(0) @binding(0) var src: texture_2d<f32>;

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let x = f32((vi << 1u) & 2u);
    let y = f32(vi & 2u);
    return vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

// Output format is sRGB: the hardware encodes.
@fragment
fn fs_blit(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    return textureLoad(src, vec2<i32>(pos.xy), 0);
}

// Output format is linear (e.g. a WebGPU canvas `bgra8unorm`): encode here.
@fragment
fn fs_blit_encode(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(src, vec2<i32>(pos.xy), 0);
    return vec4<f32>(linear_to_srgb(max(c.rgb, vec3<f32>(0.0))), c.a);
}
