//! JS bindings (wasm32 only). See the crate docs for the exported surface; the typed
//! wrapper and the documented contract live in packages/forge-web.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use forge_render::camera::{Projection, StandardView};
use forge_render::glam::DVec3;
use forge_render::wgpu;
use forge_render::{
    EntityRef, GpuContext, PickHit, SceneBody, SceneEdge, SceneFace, SceneTables, SectionPlane,
    Viewport,
};
use js_sys::{Array, Float32Array, Function, Object, Reflect, Uint8Array, Uint32Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::engine;

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

fn report_js(report: &forge_ir::EvalReport) -> Result<JsValue, JsValue> {
    let s = serde_json::to_string(report).map_err(|e| js_error("FORGE_REPORT", &e.to_string()))?;
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

/// Evaluate an IR document and tessellate its bodies for rendering.
#[wasm_bindgen(js_name = evaluate)]
pub fn evaluate(
    ir_json: &str,
    chordal: Option<f64>,
    angular: Option<f64>,
) -> Result<JsValue, JsValue> {
    let t0 = now_ms();
    let out = engine::evaluate_document(ir_json, &engine::tess_params(chordal, angular), &now_ms)
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
}

/// The viewport on a canvas (wrapped by `Viewport` in @aicad/forge-web).
#[wasm_bindgen]
pub struct RawViewport {
    inner: Rc<RefCell<Host>>,
}

/// Create a viewport on `canvas` (`HTMLCanvasElement` or `OffscreenCanvas`), sized
/// `width × height` physical pixels. `backend`: `"auto"` (WebGPU, else WebGL2),
/// `"webgpu"` or `"webgl2"`.
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
    let max = ctx.max_texture_dimension;
    let (w, h) = (width.clamp(1, max), height.clamp(1, max));
    let config = surface_config(&surface, &adapter, w, h)?;
    surface.configure(&ctx.device, &config);
    let viewport = Viewport::new(&ctx, config.format, w, h, dpr);
    Ok(RawViewport {
        inner: Rc::new(RefCell::new(Host {
            surface,
            config,
            viewport,
        })),
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

/// Map `buffer` for reading without blocking the event loop: WebGPU resolves the map
/// from the browser's event loop, the GL backend on `device.poll`.
async fn read_buffer(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Result<Vec<u8>, JsValue> {
    let state: Rc<Cell<Option<bool>>> = Rc::new(Cell::new(None));
    let s = Rc::clone(&state);
    buffer.map_async(wgpu::MapMode::Read, .., move |r| s.set(Some(r.is_ok())));
    let mut waited = 0;
    loop {
        let _ = device.poll(wgpu::PollType::Poll);
        if let Some(ok) = state.get() {
            if !ok {
                return Err(js_error(
                    "RENDER_READBACK",
                    "mapping the pick buffer failed",
                ));
            }
            break;
        }
        if waited > 5000 {
            return Err(js_error(
                "RENDER_READBACK",
                "timed out mapping the pick buffer",
            ));
        }
        sleep_ms(1).await;
        waited += 1;
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
    /// Render one frame and present it.
    pub fn render(&self) -> Result<(), JsValue> {
        let mut h = self.inner.borrow_mut();
        let frame = match h.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                h.reconfigure();
                return Ok(());
            }
            _ => return Ok(()),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        h.viewport.render(&view);
        let queue = h.viewport.context().queue.clone();
        queue.present(frame);
        Ok(())
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
        self.inner
            .borrow_mut()
            .viewport
            .set_bodies(&list)
            .map_err(|e| js_error(e.code(), &e.to_string()))
    }

    /// Evaluate + tessellate + upload in one call, without copying meshes through JS.
    /// Returns `{ report, meshErrors, timings }` (timings include `uploadMs`).
    #[wasm_bindgen(js_name = loadIr)]
    pub fn load_ir(
        &self,
        ir_json: &str,
        chordal: Option<f64>,
        angular: Option<f64>,
    ) -> Result<JsValue, JsValue> {
        let t0 = now_ms();
        let out =
            engine::evaluate_document(ir_json, &engine::tess_params(chordal, angular), &now_ms)
                .map_err(core_error)?;
        let t1 = now_ms();
        let bodies: Vec<SceneBody> = out
            .bodies
            .into_iter()
            .map(|b| SceneBody::from_owned_render_mesh(b.name, b.mesh))
            .collect();
        self.inner
            .borrow_mut()
            .viewport
            .set_bodies(&bodies)
            .map_err(|e| js_error(e.code(), &e.to_string()))?;
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

    /// Pick at physical pixel `(x, y)`; resolves to a pick object or `null`.
    pub fn pick(&self, x: f64, y: f64) -> js_sys::Promise {
        let req = self.inner.borrow_mut().viewport.begin_pick(x, y);
        let inner = Rc::clone(&self.inner);
        wasm_bindgen_futures::future_to_promise(async move {
            let Some(req) = req else {
                return Ok(JsValue::NULL);
            };
            let device = inner.borrow().viewport.context().device.clone();
            let bytes = read_buffer(&device, req.buffer()).await?;
            let hit = inner.borrow().viewport.finish_pick(&req, &bytes);
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
