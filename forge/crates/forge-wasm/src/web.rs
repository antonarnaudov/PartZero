//! JS bindings (wasm32 only). See the crate docs for the exported surface; the typed
//! wrapper and the documented contract live in packages/forge-web.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use forge_render::camera::{Projection, StandardView};
use forge_render::glam::DVec3;
use forge_render::wgpu;
use forge_render::{
    BackendKind, EntityRef, GpuContext, GpuFault, PickHit, SceneBody, SceneEdge, SceneFace,
    SceneTables, SectionPlane, Viewport,
};
use js_sys::{Array, Float32Array, Function, Object, Reflect, Uint8Array, Uint32Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::engine;
use crate::scopes::Scopes;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn js_error(code: &str, message: &str) -> JsValue {
    let e = js_sys::Error::new(message);
    let _ = Reflect::set(&e, &"code".into(), &code.into());
    e.into()
}

fn core_error(e: engine::CoreError) -> JsValue {
    js_error(&e.code, &e.message)
}

/// A GPU fault as a JS error (`code: "RENDER_GPU"`).
fn gpu_error(f: &GpuFault) -> JsValue {
    js_error(f.code(), &f.to_string())
}

/// The message of a JS error value (for folding it into another error's message).
fn js_message(v: &JsValue) -> String {
    v.dyn_ref::<js_sys::Error>()
        .map_or_else(|| format!("{v:?}"), |e| String::from(e.message()))
}

fn set(o: &Object, k: &str, v: impl Into<JsValue>) {
    let _ = Reflect::set(o, &JsValue::from_str(k), &v.into());
}

fn get(o: &JsValue, k: &str) -> JsValue {
    Reflect::get(o, &JsValue::from_str(k)).unwrap_or(JsValue::UNDEFINED)
}

fn get_f64(o: &JsValue, k: &str) -> Option<f64> {
    get(o, k).as_f64()
}

/// `performance.now()` where available (window, worker, Node), else `Date.now()`.
fn now_ms() -> f64 {
    let g = js_sys::global();
    let perf = get(&g, "performance");
    if let Ok(f) = get(&perf, "now").dyn_into::<Function>()
        && let Some(t) = f.call0(&perf).ok().and_then(|v| v.as_f64())
    {
        return t;
    }
    js_sys::Date::now()
}

/// The report (`aicad.metrics/0` or `aicad.metrics/1`) as a JS object.
fn report_js(report: &engine::Report) -> Result<JsValue, JsValue> {
    let s = report
        .to_json()
        .map_err(|e| js_error("FORGE_REPORT", &e.to_string()))?;
    js_sys::JSON::parse(&s)
}

fn body_js(b: &engine::EvalBody) -> JsValue {
    let o = Object::new();
    set(&o, "name", b.name.as_str());
    set(
        &o,
        "positions",
        Float32Array::from(b.mesh.positions.as_flattened()),
    );
    set(
        &o,
        "normals",
        Float32Array::from(b.mesh.normals.as_flattened()),
    );
    set(
        &o,
        "indices",
        Uint32Array::from(b.mesh.triangles.as_flattened()),
    );
    let faces = Array::new();
    for f in &b.mesh.face_ranges {
        let x = Object::new();
        set(&x, "face", f.face_name.as_str());
        set(&x, "start", f.tri_start);
        set(&x, "count", f.tri_count);
        faces.push(&x);
    }
    set(&o, "faceRanges", faces);
    let edges = Array::new();
    for e in &b.mesh.edge_polylines {
        let pts: Vec<f32> = e.points.iter().flat_map(|p| p.map(|c| c as f32)).collect();
        let x = Object::new();
        set(&x, "edge", e.edge_name.as_str());
        set(&x, "points", Float32Array::from(pts.as_slice()));
        edges.push(&x);
    }
    set(&o, "edges", edges);
    o.into()
}

fn mesh_errors_js(errs: &[engine::MeshFailure]) -> Array {
    let a = Array::new();
    for e in errs {
        let x = Object::new();
        set(&x, "body", e.body.as_str());
        set(&x, "code", e.code.as_str());
        set(&x, "message", e.message.as_str());
        a.push(&x);
    }
    a
}

fn timings_js(t: &engine::Timings, extra: &[(&str, f64)]) -> Object {
    let o = Object::new();
    set(&o, "parseMs", t.parse_ms);
    set(&o, "evaluateMs", t.evaluate_ms);
    set(&o, "tessellateMs", t.tessellate_ms);
    for (k, v) in extra {
        set(&o, k, *v);
    }
    o
}

/// Evaluate an IR document and tessellate its bodies for rendering. `report_version`:
/// `"auto"` (default; a v0 document keeps the `aicad.metrics/0` report) or `"v1"` (a v0
/// document is migrated and gets the `aicad.metrics/1` report, SPEC-v1 §0.2 rule 4).
#[wasm_bindgen(js_name = evaluate)]
pub fn evaluate(
    ir_json: &str,
    chordal: Option<f64>,
    angular: Option<f64>,
    report_version: Option<String>,
) -> Result<JsValue, JsValue> {
    let t0 = now_ms();
    let version = engine::ReportVersion::parse(report_version.as_deref()).map_err(core_error)?;
    let out = engine::evaluate_document(
        ir_json,
        &engine::tess_params(chordal, angular),
        version,
        &now_ms,
    )
    .map_err(core_error)?;
    let t1 = now_ms();
    let o = Object::new();
    set(&o, "report", report_js(&out.report)?);
    let bodies = Array::new();
    for b in &out.bodies {
        bodies.push(&body_js(b));
    }
    set(&o, "bodies", bodies);
    set(&o, "meshErrors", mesh_errors_js(&out.mesh_errors));
    let t2 = now_ms();
    set(
        &o,
        "timings",
        timings_js(&out.timings, &[("packMs", t2 - t1), ("totalMs", t2 - t0)]),
    );
    Ok(o.into())
}

/// A JSON value as a JS value.
fn json_js(v: &serde_json::Value) -> Result<JsValue, JsValue> {
    let s = serde_json::to_string(v).map_err(|e| js_error("FORGE_JSON", &e.to_string()))?;
    js_sys::JSON::parse(&s)
}

/// A rejected command-layer input as a JS error: `code`, `message`, and `errors` (every problem,
/// `{ code, path, message, details }`).
fn rejection_js(r: engine::Rejection) -> JsValue {
    let e = js_error(&r.code, &r.message);
    if let Ok(errors) = json_js(&serde_json::Value::Array(r.errors)) {
        let _ = Reflect::set(&e, &"errors".into(), &errors);
    }
    e
}

/// `migrate_v0_to_v1` (SPEC-v1 §9.1): `{ document, renames }` — the canonical `aicad.ir/1` text
/// and the migration report's renames. Throws (code, `errors`) for a rejected document.
#[wasm_bindgen(js_name = migrate)]
pub fn migrate(ir_json: &str) -> Result<JsValue, JsValue> {
    let m = engine::migrate(ir_json).map_err(rejection_js)?;
    let o = Object::new();
    set(&o, "document", m.document.as_str());
    let report =
        serde_json::to_value(&m.report).map_err(|e| js_error("FORGE_JSON", &e.to_string()))?;
    set(&o, "renames", json_js(&report["renames"])?);
    Ok(o.into())
}

/// The `params` block of the document's `aicad.metrics/1` report (no feature is evaluated).
/// Throws (code, `errors`) for a rejected document.
#[wasm_bindgen(js_name = params)]
pub fn params(ir_json: &str) -> Result<JsValue, JsValue> {
    let ps = engine::params(ir_json).map_err(rejection_js)?;
    let v = serde_json::to_value(&ps).map_err(|e| js_error("FORGE_JSON", &e.to_string()))?;
    json_js(&v)
}

/// `writeBackSolution` (SPEC-v1 §0.6): `{ document, written, skipped }`. `sketches`: an array of
/// sketch ids, or `undefined` / `null` for every constrained sketch. Throws (code, `errors`)
/// for a rejected document and `WRITE_BACK_UNKNOWN_SKETCH` for an unknown id.
#[wasm_bindgen(js_name = writeBack)]
pub fn write_back(ir_json: &str, sketches: JsValue) -> Result<JsValue, JsValue> {
    let ids: Option<Vec<String>> = if sketches.is_undefined() || sketches.is_null() {
        None
    } else {
        let arr = sketches.dyn_ref::<Array>().ok_or_else(|| {
            js_error(
                "WRITE_BACK_SKETCHES",
                "sketches must be an array of sketch ids",
            )
        })?;
        let mut v = Vec::with_capacity(arr.length() as usize);
        for x in arr.iter() {
            v.push(x.as_string().ok_or_else(|| {
                js_error(
                    "WRITE_BACK_SKETCHES",
                    "sketches must be an array of sketch ids",
                )
            })?);
        }
        Some(v)
    };
    let wb = engine::write_back(ir_json, ids.as_deref()).map_err(rejection_js)?;
    let o = Object::new();
    set(&o, "document", wb.document.as_str());
    set(&o, "written", json_js(&serde_json::json!(wb.written))?);
    set(
        &o,
        "skipped",
        json_js(&serde_json::Value::Array(wb.skipped))?,
    );
    Ok(o.into())
}

/// Evaluate, tessellate (watertight) and encode as `3mf`, `stl` (binary) or `obj`.
#[wasm_bindgen(js_name = exportMesh)]
pub fn export_mesh(
    ir_json: &str,
    format: &str,
    chordal: Option<f64>,
    angular: Option<f64>,
    allow_partial: Option<bool>,
) -> Result<Uint8Array, JsValue> {
    let f = engine::ExportFormat::parse(format).ok_or_else(|| {
        js_error(
            "EXPORT_FORMAT",
            &format!("unknown mesh format {format:?}; use 3mf, stl or obj"),
        )
    })?;
    let bytes = engine::export_mesh(
        ir_json,
        f,
        &engine::tess_params(chordal, angular),
        allow_partial.unwrap_or(false),
    )
    .map_err(core_error)?;
    Ok(Uint8Array::from(bytes.as_slice()))
}

/// The engine identifier (`forge <version>`).
#[wasm_bindgen(js_name = engineVersion)]
pub fn engine_version() -> String {
    forge_regen::engine_id()
}

enum Canvas {
    Html(web_sys::HtmlCanvasElement),
    Offscreen(web_sys::OffscreenCanvas),
}

fn global_has(name: &str) -> bool {
    !get(&js_sys::global(), name).is_undefined()
}

impl Canvas {
    fn from_js(v: JsValue) -> Result<Self, JsValue> {
        if global_has("OffscreenCanvas") && v.is_instance_of::<web_sys::OffscreenCanvas>() {
            return Ok(Canvas::Offscreen(v.unchecked_into()));
        }
        if global_has("HTMLCanvasElement") && v.is_instance_of::<web_sys::HtmlCanvasElement>() {
            return Ok(Canvas::Html(v.unchecked_into()));
        }
        Err(js_error(
            "RENDER_CANVAS",
            "expected an HTMLCanvasElement or an OffscreenCanvas",
        ))
    }

    fn target(&self) -> wgpu::SurfaceTarget<'static> {
        match self {
            Canvas::Html(c) => wgpu::SurfaceTarget::Canvas(c.clone()),
            Canvas::Offscreen(c) => wgpu::SurfaceTarget::OffscreenCanvas(c.clone()),
        }
    }
}

fn has_webgpu() -> bool {
    let nav = get(&js_sys::global(), "navigator");
    !nav.is_undefined() && !get(&nav, "gpu").is_undefined() && !get(&nav, "gpu").is_null()
}

type Made = (wgpu::Surface<'static>, wgpu::Adapter, GpuContext);

/// Render a test quad offscreen and pick it back — uploads, pipelines, a frame and a
/// read-back, what the viewport relies on — inside error scopes, **before** the canvas is
/// committed to WebGPU (a canvas keeps its first context type).
///
/// Audit V3: Chromium's SwiftShader WebGPU adapter (unsafe flags) gave a device whose
/// canvas stayed blank and whose every pick failed to map. Such a device fails here, so
/// `auto` falls back to WebGL2 on the still-free canvas, and `webgpu` rejects with
/// `RENDER_NO_ADAPTER` naming the failure.
async fn webgpu_self_test(ctx: &GpuContext) -> Result<(), String> {
    const SIZE: u32 = 16;
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let scopes = Scopes::push(ctx);
    let mut vp = Viewport::new(ctx, format, SIZE, SIZE, 1.0);
    let quad = SceneBody {
        name: "self-test".into(),
        positions: vec![
            [-1.0, -1.0, 0.0],
            [1.0, -1.0, 0.0],
            [1.0, 1.0, 0.0],
            [-1.0, 1.0, 0.0],
        ],
        normals: vec![[0.0, 0.0, 1.0]; 4],
        triangles: vec![[0, 1, 2], [0, 2, 3]],
        faces: vec![SceneFace {
            name: "quad".into(),
            tri_start: 0,
            tri_count: 2,
        }],
        edges: Vec::new(),
        color: None,
    };
    let upload = vp.set_bodies(&[quad]);
    vp.set_view(StandardView::Top);
    let target = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("forge-render self-test"),
        size: wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let frame = vp.render(&target.create_view(&wgpu::TextureViewDescriptor::default()));
    let centre = f64::from(SIZE) / 2.0;
    let pick = vp.begin_pick(centre, centre);
    let checked = scopes.pop();
    upload.map_err(|e| e.to_string())?;
    frame.map_err(|f| f.to_string())?;
    let req = pick
        .map_err(|f| f.to_string())?
        .ok_or_else(|| "the pick window is empty".to_string())?;
    let bytes = read_buffer(
        &ctx.device,
        req.buffer(),
        "the self-test read-back",
        SELF_TEST_TIMEOUT_MS,
    )
    .await
    .map_err(|e| js_message(&e))?;
    if let Some(f) = checked.await {
        return Err(f.to_string());
    }
    match vp.finish_pick(&req, &bytes) {
        Ok(Some(h)) if h.face.as_ref().is_some_and(|(_, n)| n == "quad") => Ok(()),
        Ok(other) => Err(format!(
            "the read-back pick returned {:?} instead of the test quad",
            other.map(|h| h.id)
        )),
        Err(f) => Err(f.to_string()),
    }
}

async fn init_webgpu(canvas: &Canvas) -> Result<Made, String> {
    let mut d = wgpu::InstanceDescriptor::new_without_display_handle();
    d.backends = wgpu::Backends::BROWSER_WEBGPU;
    let instance = wgpu::Instance::new(d);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    if adapter.get_info().backend != wgpu::Backend::BrowserWebGpu {
        return Err("the instance did not produce a WebGPU adapter".into());
    }
    let ctx = GpuContext::request(&adapter)
        .await
        .map_err(|e| e.to_string())?;
    webgpu_self_test(&ctx)
        .await
        .map_err(|e| format!("device self-test failed: {e}"))?;
    // The canvas gets its "webgpu" context only now, so a failure above leaves it free
    // for the WebGL2 fallback.
    let surface = instance
        .create_surface(canvas.target())
        .map_err(|e| e.to_string())?;
    Ok((surface, adapter, ctx))
}

async fn init_webgl2(canvas: &Canvas) -> Result<Made, String> {
    let mut d = wgpu::InstanceDescriptor::new_without_display_handle();
    d.backends = wgpu::Backends::GL;
    let instance = wgpu::Instance::new(d);
    let surface = instance
        .create_surface(canvas.target())
        .map_err(|e| e.to_string())?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    let ctx = GpuContext::request(&adapter)
        .await
        .map_err(|e| e.to_string())?;
    Ok((surface, adapter, ctx))
}

fn surface_config(
    surface: &wgpu::Surface<'static>,
    adapter: &wgpu::Adapter,
    w: u32,
    h: u32,
) -> Result<wgpu::SurfaceConfiguration, JsValue> {
    use wgpu::TextureFormat as F;
    let caps = surface.get_capabilities(adapter);
    let mut config = surface.get_default_config(adapter, w, h).ok_or_else(|| {
        js_error(
            "RENDER_SURFACE",
            "the surface is not supported by the adapter",
        )
    })?;
    if let Some(f) = caps.formats.iter().copied().find(|f| {
        matches!(
            f,
            F::Bgra8Unorm | F::Rgba8Unorm | F::Bgra8UnormSrgb | F::Rgba8UnormSrgb
        )
    }) {
        config.format = f;
    }
    if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
        config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
    }
    config.present_mode = wgpu::PresentMode::Fifo;
    config.view_formats = Vec::new();
    Ok(config)
}

struct Host {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    viewport: Viewport,
}

impl Host {
    fn reconfigure(&mut self) {
        let device = self.viewport.context().device.clone();
        self.surface.configure(&device, &self.config);
    }

    /// Acquire the canvas texture, render and present one frame. A frame whose encoding
    /// raised a GPU fault is not presented; a faulted device draws nothing.
    fn draw(&mut self) -> Result<(), GpuFault> {
        self.viewport.check_gpu()?;
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.reconfigure();
                return self.viewport.check_gpu();
            }
            // Timeout / occluded: skip this frame. A validation error of the acquisition
            // itself was recorded as a fault.
            _ => return self.viewport.check_gpu(),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        self.viewport.render(&view)?;
        let queue = self.viewport.context().queue.clone();
        queue.present(frame);
        self.viewport.check_gpu()
    }
}

/// The JS callback told about GPU faults found after a call returned (browser WebGPU
/// reports errors asynchronously).
type FaultCallback = Rc<RefCell<Option<Function>>>;

fn notify_fault(callback: &FaultCallback, f: &GpuFault) {
    // Cloned out first: the callback may re-register itself.
    let cb = callback.borrow().clone();
    if let Some(cb) = cb {
        let _ = cb.call1(&JsValue::NULL, &gpu_error(f));
    }
}

/// The viewport on a canvas (wrapped by `Viewport` in @aicad/forge-web).
#[wasm_bindgen]
pub struct RawViewport {
    inner: Rc<RefCell<Host>>,
    on_fault: FaultCallback,
    /// Why `auto` fell back to WebGL2 although the browser offers WebGPU.
    fallback: Option<String>,
}

impl RawViewport {
    /// Replace the scene (`RENDER_BODY`-style scene errors, or `RENDER_GPU`).
    fn upload(&self, bodies: &[SceneBody]) -> Result<(), JsValue> {
        let (scopes, uploaded) = {
            let mut h = self.inner.borrow_mut();
            let scopes = Scopes::on_webgpu(h.viewport.context());
            (scopes, h.viewport.set_bodies(bodies))
        };
        self.watch(scopes);
        uploaded.map_err(|e| js_error(e.code(), &e.to_string()))
    }

    /// Await `scopes` in the background and report a fault to the fault callback.
    fn watch(&self, scopes: Option<Scopes>) {
        let Some(scopes) = scopes else { return };
        let checked = scopes.pop();
        let callback = Rc::clone(&self.on_fault);
        wasm_bindgen_futures::spawn_local(async move {
            if let Some(f) = checked.await {
                notify_fault(&callback, &f);
            }
        });
    }
}

/// Create a viewport on `canvas` (`HTMLCanvasElement` or `OffscreenCanvas`), sized
/// `width × height` physical pixels. `backend`: `"auto"` (WebGPU, else WebGL2),
/// `"webgpu"` or `"webgl2"`. A WebGPU device must pass a self-test (a frame and a pick
/// read-back) before the canvas is committed to it; `auto` otherwise falls back to WebGL2.
/// The surface setup and the first frame are awaited inside error scopes.
///
/// Rejects with `RENDER_NO_ADAPTER` (every backend failed; the message lists each
/// backend's reason), `RENDER_GPU` (the device faulted while setting up the canvas or
/// drawing the first frame), `RENDER_SURFACE`, `RENDER_CANVAS` or `RENDER_BACKEND`.
#[wasm_bindgen(js_name = createViewport)]
pub async fn create_viewport(
    canvas: JsValue,
    backend: String,
    width: u32,
    height: u32,
    dpr: f64,
) -> Result<RawViewport, JsValue> {
    let canvas = Canvas::from_js(canvas)?;
    let want = backend.as_str();
    if !matches!(want, "auto" | "webgpu" | "webgl2") {
        return Err(js_error(
            "RENDER_BACKEND",
            &format!("unknown backend {want:?}; use auto, webgpu or webgl2"),
        ));
    }
    let mut errors: Vec<String> = Vec::new();
    let mut made: Option<Made> = None;
    if want != "webgl2" {
        if has_webgpu() {
            match init_webgpu(&canvas).await {
                Ok(m) => made = Some(m),
                Err(e) => errors.push(format!("webgpu: {e}")),
            }
        } else {
            errors.push("webgpu: navigator.gpu is not available".into());
        }
    }
    if made.is_none() && want != "webgpu" {
        match init_webgl2(&canvas).await {
            Ok(m) => made = Some(m),
            Err(e) => errors.push(format!("webgl2: {e}")),
        }
    }
    let (surface, adapter, ctx) =
        made.ok_or_else(|| js_error("RENDER_NO_ADAPTER", &errors.join("; ")))?;
    let fallback = (want == "auto" && ctx.backend != BackendKind::WebGpu && has_webgpu())
        .then(|| errors.join("; "));
    let max = ctx.max_texture_dimension;
    let (w, h) = (width.clamp(1, max), height.clamp(1, max));
    // No GPU call yet, so no scope: the configuration is only read from the adapter.
    let config = surface_config(&surface, &adapter, w, h)?;
    // The canvas is committed to this backend now: the setup and the first frame run
    // inside error scopes and are awaited, so a device that fails them is reported
    // (`RENDER_GPU`) instead of leaving a blank canvas. (An early return after this point
    // would still pop the scopes in order: see `Scopes`'s `Drop`.)
    let scopes = Scopes::push(&ctx);
    surface.configure(&ctx.device, &config);
    let viewport = Viewport::new(&ctx, config.format, w, h, dpr);
    let mut host = Host {
        surface,
        config,
        viewport,
    };
    let first = host.draw();
    let checked = scopes.pop().await;
    if let Some(f) = first.err().or(checked).or_else(|| ctx.gpu_fault()) {
        return Err(js_error(
            f.code(),
            &format!(
                "{}: the device failed setting up the canvas or drawing the first frame: {f}",
                ctx.backend.as_str()
            ),
        ));
    }
    Ok(RawViewport {
        inner: Rc::new(RefCell::new(host)),
        on_fault: Rc::new(RefCell::new(None)),
        fallback,
    })
}

fn scene_body_from_js(v: &JsValue, index: usize) -> Result<SceneBody, JsValue> {
    let bad = |what: &str| js_error("RENDER_BODY", &format!("bodies[{index}]: {what}"));
    let name = get(v, "name")
        .as_string()
        .ok_or_else(|| bad("name must be a string"))?;
    let f32s = |k: &str| -> Result<Vec<f32>, JsValue> {
        let x = get(v, k);
        if x.is_undefined() || x.is_null() {
            return Err(bad(&format!("{k} is missing")));
        }
        Ok(Float32Array::new(&x).to_vec())
    };
    let triples = |flat: Vec<f32>, k: &str| -> Result<Vec<[f32; 3]>, JsValue> {
        if !flat.len().is_multiple_of(3) {
            return Err(bad(&format!("{k} length is not a multiple of 3")));
        }
        Ok(flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
    };
    let positions = triples(f32s("positions")?, "positions")?;
    let normals = triples(f32s("normals")?, "normals")?;
    let idx = get(v, "indices");
    if idx.is_undefined() || idx.is_null() {
        return Err(bad("indices is missing"));
    }
    let idx = Uint32Array::new(&idx).to_vec();
    if !idx.len().is_multiple_of(3) {
        return Err(bad("indices length is not a multiple of 3"));
    }
    let triangles = idx.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    let mut faces = Vec::new();
    let fr = get(v, "faceRanges");
    if !fr.is_undefined() && !fr.is_null() {
        for f in Array::from(&fr).iter() {
            faces.push(SceneFace {
                name: get(&f, "face").as_string().unwrap_or_default(),
                tri_start: get_f64(&f, "start").unwrap_or(0.0) as u32,
                tri_count: get_f64(&f, "count").unwrap_or(0.0) as u32,
            });
        }
    }
    let mut edges = Vec::new();
    let es = get(v, "edges");
    if !es.is_undefined() && !es.is_null() {
        for e in Array::from(&es).iter() {
            let pts = Float32Array::new(&get(&e, "points")).to_vec();
            edges.push(SceneEdge {
                name: get(&e, "edge").as_string().unwrap_or_default(),
                points: pts.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect(),
            });
        }
    }
    let c = get(v, "color");
    let color = if c.is_undefined() || c.is_null() {
        None
    } else {
        let a = Float32Array::new(&c).to_vec();
        (a.len() >= 3).then(|| [a[0], a[1], a[2]])
    };
    Ok(SceneBody {
        name,
        positions,
        normals,
        triangles,
        faces,
        edges,
        color,
    })
}

fn entity_from_js(t: &SceneTables, v: &JsValue) -> Option<EntityRef> {
    if v.is_null() || v.is_undefined() {
        return None;
    }
    if get(v, "kind").as_string().as_deref() == Some("section") {
        return None;
    }
    let body = match get(v, "body").as_string() {
        Some(n) => t.body_index(&n)?,
        None => get_f64(v, "bodyIndex")? as usize,
    };
    let bname = t.bodies.get(body)?.name.clone();
    if let Some(e) = get(v, "edge").as_string() {
        return t.edge_by_name(&bname, &e);
    }
    if let Some(i) = get_f64(v, "edgeIndex") {
        return t.edge_by_index(body, i as usize);
    }
    if let Some(f) = get(v, "face").as_string() {
        return t.face_by_name(&bname, &f);
    }
    if let Some(i) = get_f64(v, "faceIndex") {
        return t.face_by_index(body, i as usize);
    }
    None
}

fn hit_js(h: &PickHit) -> JsValue {
    let o = Object::new();
    set(&o, "kind", h.kind.as_str());
    set(&o, "body", h.body_name.as_str());
    set(&o, "bodyIndex", h.body);
    match &h.face {
        Some((i, n)) => {
            set(&o, "face", n.as_str());
            set(&o, "faceIndex", *i);
        }
        None => {
            set(&o, "face", JsValue::NULL);
            set(&o, "faceIndex", JsValue::NULL);
        }
    }
    match &h.edge {
        Some((i, n)) => {
            set(&o, "edge", n.as_str());
            set(&o, "edgeIndex", *i);
        }
        None => {
            set(&o, "edge", JsValue::NULL);
            set(&o, "edgeIndex", JsValue::NULL);
        }
    }
    match h.point {
        Some(p) => {
            let a = Array::new();
            for c in p {
                a.push(&JsValue::from(c));
            }
            set(&o, "point", a);
        }
        None => set(&o, "point", JsValue::NULL),
    }
    let px = Array::new();
    px.push(&JsValue::from(h.pixel[0]));
    px.push(&JsValue::from(h.pixel[1]));
    set(&o, "pixel", px);
    o.into()
}

/// Resolve after `ms` milliseconds via `setTimeout` (window, worker or Node).
async fn sleep_ms(ms: i32) {
    let p = js_sys::Promise::new(&mut |resolve, _| {
        let g = js_sys::global();
        match get(&g, "setTimeout").dyn_into::<Function>() {
            Ok(f) => {
                let _ = f.call2(&g, &resolve, &JsValue::from(ms));
            }
            Err(_) => {
                let _ = resolve.call0(&JsValue::NULL);
            }
        }
    });
    let _ = JsFuture::from(p).await;
}

/// How long a pick's read-back may take (ms) before it fails with `RENDER_READBACK`.
const PICK_READBACK_TIMEOUT_MS: f64 = 5000.0;
/// How long the WebGPU self-test's read-back may take (ms; forge-web's device check uses
/// the same budget per step).
const SELF_TEST_TIMEOUT_MS: f64 = 3000.0;

/// Map `buffer` (`what`, for messages) for reading without blocking the event loop:
/// WebGPU resolves the map from the browser's event loop, the GL backend on
/// `device.poll`. Fails with `RENDER_READBACK` when the map fails or takes longer than
/// `timeout_ms`.
async fn read_buffer(
    device: &wgpu::Device,
    buffer: &wgpu::Buffer,
    what: &str,
    timeout_ms: f64,
) -> Result<Vec<u8>, JsValue> {
    let state: Rc<Cell<Option<bool>>> = Rc::new(Cell::new(None));
    let s = Rc::clone(&state);
    buffer.map_async(wgpu::MapMode::Read, .., move |r| s.set(Some(r.is_ok())));
    let t0 = now_ms();
    loop {
        let _ = device.poll(wgpu::PollType::Poll);
        if let Some(ok) = state.get() {
            if !ok {
                return Err(js_error(
                    "RENDER_READBACK",
                    &format!("mapping {what} failed"),
                ));
            }
            break;
        }
        if now_ms() - t0 > timeout_ms {
            return Err(js_error(
                "RENDER_READBACK",
                &format!("timed out mapping {what} ({timeout_ms} ms)"),
            ));
        }
        sleep_ms(1).await;
    }
    let bytes = buffer
        .get_mapped_range(..)
        .map_err(|e| js_error("RENDER_READBACK", &e.to_string()))?
        .to_vec();
    buffer.unmap();
    Ok(bytes)
}

#[wasm_bindgen]
impl RawViewport {
    /// Render one frame and present it. Throws `RENDER_GPU` once the device faulted
    /// (WebGPU faults found after the call returned go to the `onGpuFault` callback).
    pub fn render(&self) -> Result<(), JsValue> {
        let (scopes, drawn) = {
            let mut h = self.inner.borrow_mut();
            let scopes = Scopes::on_webgpu(h.viewport.context());
            (scopes, h.draw())
        };
        self.watch(scopes);
        drawn.map_err(|f| gpu_error(&f))
    }

    /// Register `callback(error)` for GPU faults found after a call returned (browser
    /// WebGPU reports them asynchronously) that no caller receives otherwise: those of
    /// `render`, `setBodies` and `loadIr` (a pick's fault rejects its promise instead);
    /// `error.code` is `RENDER_GPU`. `null` removes it.
    #[wasm_bindgen(js_name = onGpuFault)]
    pub fn on_gpu_fault(&self, callback: Option<Function>) {
        *self.on_fault.borrow_mut() = callback;
    }

    /// The first GPU fault of the device as an error (`code: "RENDER_GPU"`), or `null`.
    #[wasm_bindgen(js_name = gpuFault)]
    pub fn gpu_fault(&self) -> JsValue {
        self.inner
            .borrow()
            .viewport
            .gpu_fault()
            .map_or(JsValue::NULL, |f| gpu_error(&f))
    }

    /// Why `backend: "auto"` fell back to WebGL2 although the browser offers WebGPU
    /// (the WebGPU failure), or `undefined`.
    #[wasm_bindgen(js_name = backendFallback)]
    pub fn backend_fallback(&self) -> Option<String> {
        self.fallback.clone()
    }

    /// Resize to `width × height` physical pixels at device-pixel ratio `dpr`.
    pub fn resize(&self, width: u32, height: u32, dpr: f64) {
        let mut h = self.inner.borrow_mut();
        let max = h.viewport.context().max_texture_dimension;
        let (w, hh) = (width.clamp(1, max), height.clamp(1, max));
        h.viewport.resize(w, hh, dpr);
        if (h.config.width, h.config.height) != (w, hh) {
            h.config.width = w;
            h.config.height = hh;
            h.reconfigure();
        }
    }

    /// Replace the scene with `EvaluateResult.bodies`-shaped objects.
    #[wasm_bindgen(js_name = setBodies)]
    pub fn set_bodies(&self, bodies: JsValue) -> Result<(), JsValue> {
        let arr = Array::from(&bodies);
        let mut list = Vec::with_capacity(arr.length() as usize);
        for (i, b) in arr.iter().enumerate() {
            list.push(scene_body_from_js(&b, i)?);
        }
        self.upload(&list)
    }

    /// Evaluate + tessellate + upload in one call, without copying meshes through JS.
    /// Returns `{ report, meshErrors, timings }` (timings include `uploadMs`).
    /// `report_version` as for `evaluate` (`"auto"` default, or `"v1"`).
    #[wasm_bindgen(js_name = loadIr)]
    pub fn load_ir(
        &self,
        ir_json: &str,
        chordal: Option<f64>,
        angular: Option<f64>,
        report_version: Option<String>,
    ) -> Result<JsValue, JsValue> {
        let t0 = now_ms();
        let version =
            engine::ReportVersion::parse(report_version.as_deref()).map_err(core_error)?;
        let out = engine::evaluate_document(
            ir_json,
            &engine::tess_params(chordal, angular),
            version,
            &now_ms,
        )
        .map_err(core_error)?;
        let t1 = now_ms();
        let bodies: Vec<SceneBody> = out
            .bodies
            .into_iter()
            .map(|b| SceneBody::from_owned_render_mesh(b.name, b.mesh))
            .collect();
        self.upload(&bodies)?;
        let t2 = now_ms();
        let o = Object::new();
        set(&o, "report", report_js(&out.report)?);
        set(&o, "meshErrors", mesh_errors_js(&out.mesh_errors));
        set(
            &o,
            "timings",
            timings_js(&out.timings, &[("uploadMs", t2 - t1), ("totalMs", t2 - t0)]),
        );
        Ok(o.into())
    }

    /// Pick at physical pixel `(x, y)`; resolves to a pick object or `null` (nothing
    /// under the cursor). Rejects with `RENDER_GPU` when the device faulted (before or
    /// during the pick: a faulted device's read-back would read as "nothing hit") and
    /// `RENDER_READBACK` when the read-back cannot be mapped.
    pub fn pick(&self, x: f64, y: f64) -> js_sys::Promise {
        let (req, checked) = {
            let mut h = self.inner.borrow_mut();
            let scopes = Scopes::on_webgpu(h.viewport.context());
            let req = h.viewport.begin_pick(x, y);
            (req, scopes.map(Scopes::pop))
        };
        let inner = Rc::clone(&self.inner);
        wasm_bindgen_futures::future_to_promise(async move {
            let req = req.map_err(|f| gpu_error(&f))?;
            // The rejection carries the fault to the caller awaiting this pick, so it does
            // not also go to the fault callback (that is for faults no caller receives).
            if let Some(checked) = checked
                && let Some(f) = checked.await
            {
                return Err(gpu_error(&f));
            }
            let Some(req) = req else {
                return Ok(JsValue::NULL);
            };
            let device = inner.borrow().viewport.context().device.clone();
            let bytes = read_buffer(
                &device,
                req.buffer(),
                "the pick buffer",
                PICK_READBACK_TIMEOUT_MS,
            )
            .await
            // A fault explains a failed map better than the map error does.
            .map_err(|e| {
                inner
                    .borrow()
                    .viewport
                    .gpu_fault()
                    .map_or(e, |f| gpu_error(&f))
            })?;
            let hit = inner
                .borrow()
                .viewport
                .finish_pick(&req, &bytes)
                .map_err(|f| gpu_error(&f))?;
            Ok(hit.as_ref().map_or(JsValue::NULL, hit_js))
        })
    }

    /// Set the hovered entity from a pick-like object (`null` clears). Returns whether it
    /// resolved to an entity of the current scene.
    #[wasm_bindgen(js_name = setHover)]
    pub fn set_hover(&self, pick: JsValue) -> bool {
        let mut h = self.inner.borrow_mut();
        let e = entity_from_js(h.viewport.tables(), &pick);
        h.viewport.set_hover(e);
        e.is_some()
    }

    /// Replace the selection with pick-like objects. Returns how many resolved.
    #[wasm_bindgen(js_name = setSelection)]
    pub fn set_selection(&self, picks: JsValue) -> u32 {
        let mut h = self.inner.borrow_mut();
        let es: Vec<EntityRef> = Array::from(&picks)
            .iter()
            .filter_map(|p| entity_from_js(h.viewport.tables(), &p))
            .collect();
        h.viewport.set_selection(&es);
        es.len() as u32
    }

    /// Set the section plane (the side the normal points to is removed).
    #[wasm_bindgen(js_name = setSection)]
    pub fn set_section(&self, ox: f64, oy: f64, oz: f64, nx: f64, ny: f64, nz: f64) {
        self.inner
            .borrow_mut()
            .viewport
            .set_section(Some(SectionPlane {
                origin: DVec3::new(ox, oy, oz),
                normal: DVec3::new(nx, ny, nz),
            }));
    }

    /// Remove the section plane.
    #[wasm_bindgen(js_name = clearSection)]
    pub fn clear_section(&self) {
        self.inner.borrow_mut().viewport.set_section(None);
    }

    /// Frame the scene.
    #[wasm_bindgen(js_name = fitView)]
    pub fn fit_view(&self) {
        self.inner.borrow_mut().viewport.fit_view();
    }

    /// `iso | top | front | right | bottom | back | left`.
    #[wasm_bindgen(js_name = setView)]
    pub fn set_view(&self, view: &str) -> Result<(), JsValue> {
        let v = StandardView::parse(view)
            .ok_or_else(|| js_error("RENDER_VIEW", &format!("unknown view {view:?}")))?;
        self.inner.borrow_mut().viewport.set_view(v);
        Ok(())
    }

    /// `perspective | orthographic`.
    #[wasm_bindgen(js_name = setProjection)]
    pub fn set_projection(&self, p: &str) -> Result<(), JsValue> {
        let p = match p {
            "perspective" => Projection::Perspective,
            "orthographic" | "ortho" => Projection::Orthographic,
            _ => {
                return Err(js_error(
                    "RENDER_PROJECTION",
                    &format!("unknown projection {p:?}"),
                ));
            }
        };
        self.inner.borrow_mut().viewport.set_projection(p);
        Ok(())
    }

    /// Current projection name.
    pub fn projection(&self) -> String {
        match self.inner.borrow().viewport.camera.projection {
            Projection::Perspective => "perspective".into(),
            Projection::Orthographic => "orthographic".into(),
        }
    }

    /// Orbit by a pointer motion in physical pixels.
    pub fn orbit(&self, dx: f64, dy: f64) {
        self.inner.borrow_mut().viewport.orbit(dx, dy);
    }

    /// Pan by a pointer motion in physical pixels.
    pub fn pan(&self, dx: f64, dy: f64) {
        self.inner.borrow_mut().viewport.pan(dx, dy);
    }

    /// Zoom by `factor` (< 1 zooms in) about physical pixel `(x, y)`.
    #[wasm_bindgen(js_name = zoomAt)]
    pub fn zoom_at(&self, x: f64, y: f64, factor: f64) {
        self.inner.borrow_mut().viewport.zoom_at(x, y, factor);
    }

    /// Update display options (any subset of the documented fields).
    #[wasm_bindgen(js_name = setOptions)]
    pub fn set_options(&self, o: JsValue) {
        let mut h = self.inner.borrow_mut();
        let mut opt = h.viewport.options().clone();
        let num = |k: &str, d: &mut f64| {
            if let Some(v) = get_f64(&o, k).filter(|v| v.is_finite() && *v >= 0.0) {
                *d = v;
            }
        };
        let flag = |k: &str, d: &mut bool| {
            if let Some(v) = get(&o, k).as_bool() {
                *d = v;
            }
        };
        num("edgeWidth", &mut opt.edge_width);
        num("silhouetteWidth", &mut opt.silhouette_width);
        num("highlightWidthScale", &mut opt.highlight_width_scale);
        num("lineDepthBias", &mut opt.line_depth_bias);
        num("pickRadius", &mut opt.pick_radius);
        flag("grid", &mut opt.grid);
        flag("axes", &mut opt.axes);
        flag("edges", &mut opt.edges);
        flag("silhouettes", &mut opt.silhouettes);
        h.viewport.set_options(opt);
    }

    /// Scene and frame counters.
    pub fn stats(&self) -> JsValue {
        let h = self.inner.borrow();
        let s = h.viewport.stats();
        let o = Object::new();
        set(&o, "bodies", s.bodies);
        set(&o, "faces", s.faces);
        set(&o, "edges", s.edges);
        set(&o, "triangles", s.triangles);
        set(&o, "vertices", s.vertices);
        set(&o, "edgeSegments", s.edge_segments);
        set(&o, "silhouetteCandidates", s.silhouette_candidates);
        set(&o, "drawCalls", s.draw_calls);
        set(&o, "sampleCount", s.sample_count);
        set(&o, "width", s.width);
        set(&o, "height", s.height);
        set(&o, "frames", s.frames as f64);
        let ctx = h.viewport.context();
        set(&o, "backend", ctx.backend.as_str());
        set(&o, "adapter", ctx.adapter_name.as_str());
        o.into()
    }

    /// `webgpu` or `webgl2`.
    pub fn backend(&self) -> String {
        self.inner
            .borrow()
            .viewport
            .context()
            .backend
            .as_str()
            .to_string()
    }

    /// Camera state `{ target, distance, yaw, pitch, fovY, projection }`.
    #[wasm_bindgen(js_name = cameraState)]
    pub fn camera_state(&self) -> JsValue {
        let h = self.inner.borrow();
        let c = &h.viewport.camera;
        let o = Object::new();
        let t = Array::new();
        for v in c.target.to_array() {
            t.push(&JsValue::from(v));
        }
        set(&o, "target", t);
        set(&o, "distance", c.distance);
        set(&o, "yaw", c.yaw);
        set(&o, "pitch", c.pitch);
        set(&o, "fovY", c.fov_y);
        set(
            &o,
            "projection",
            match c.projection {
                Projection::Perspective => "perspective",
                Projection::Orthographic => "orthographic",
            },
        );
        o.into()
    }

    /// Restore a camera state (any subset of the fields of `cameraState()`).
    #[wasm_bindgen(js_name = setCameraState)]
    pub fn set_camera_state(&self, s: JsValue) {
        let mut h = self.inner.borrow_mut();
        let c = &mut h.viewport.camera;
        let t = Float32Array::new(&get(&s, "target")).to_vec();
        if t.len() == 3 {
            c.target = DVec3::new(f64::from(t[0]), f64::from(t[1]), f64::from(t[2]));
        }
        if let Some(d) = get_f64(&s, "distance").filter(|d| d.is_finite() && *d > 0.0) {
            c.distance = d;
        }
        if let Some(y) = get_f64(&s, "yaw").filter(|v| v.is_finite()) {
            c.yaw = y;
        }
        if let Some(p) = get_f64(&s, "pitch").filter(|v| v.is_finite()) {
            c.pitch = p.clamp(-std::f64::consts::FRAC_PI_2, std::f64::consts::FRAC_PI_2);
        }
        if let Some(f) = get_f64(&s, "fovY").filter(|v| v.is_finite() && *v > 0.01 && *v < 3.0) {
            c.fov_y = f;
        }
        match get(&s, "projection").as_string().as_deref() {
            Some("perspective") => c.projection = Projection::Perspective,
            Some("orthographic") => c.projection = Projection::Orthographic,
            _ => {}
        }
    }
}
