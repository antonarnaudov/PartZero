//! Device creation, capability probing and GPU error capture.
//!
//! ## GPU errors
//! Every [`GpuContext`] installs **one** uncaptured-error handler on its device when it is
//! created ([`GpuContext::from_device`], used by [`GpuContext::request`] and
//! [`GpuContext::headless`]): WebGPU validation, out-of-memory and internal errors are
//! recorded as [`GpuFault`]s in a list that every clone of the context — and every
//! [`crate::Viewport`] created on it — shares, instead of reaching wgpu's default handler,
//! which panics (and a panic aborts the whole WASM module, engine included).
//!
//! A recorded fault is sticky and is never silent: every result-producing entry point of
//! the viewport (`render`, `set_bodies`, `begin_pick`/`finish_pick`, `pick_blocking`,
//! `render_image`) returns it as an error (code `RENDER_GPU`) from then on, so no host can
//! consume a frame, a pick or an image from a faulted device. On native and WebGL2
//! (wgpu-core) errors are reported synchronously by the call that caused them; on
//! browser WebGPU they arrive asynchronously, so the call after the fault reports it
//! (hosts that must know at once await an error scope, as forge-wasm does on creation).

use std::sync::{Arc, Mutex, MutexGuard};

/// At most this many GPU faults are kept per device (the first one matters most).
const MAX_GPU_FAULTS: usize = 16;

/// An error the GPU device reported (see the module docs): the device cannot be trusted
/// for rendering or picking any more.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{kind} GPU error: {message}")]
pub struct GpuFault {
    /// `validation`, `out-of-memory`, `internal` or `device-lost`.
    pub kind: &'static str,
    /// The device's description of the error.
    pub message: String,
}

impl GpuFault {
    /// Stable machine-readable code (`RENDER_GPU`).
    pub fn code(&self) -> &'static str {
        "RENDER_GPU"
    }

    /// The fault for a wgpu error.
    pub fn from_wgpu(e: &wgpu::Error) -> Self {
        let kind = match e {
            wgpu::Error::OutOfMemory { .. } => "out-of-memory",
            wgpu::Error::Validation { .. } => "validation",
            wgpu::Error::Internal { .. } => "internal",
        };
        GpuFault {
            kind,
            message: e.to_string(),
        }
    }
}

/// A device's fault list (shared by every clone of its [`GpuContext`]).
type FaultSink = Arc<Mutex<Vec<GpuFault>>>;

fn lock(sink: &FaultSink) -> MutexGuard<'_, Vec<GpuFault>> {
    // Only `push` runs under the lock, so a poisoned lock still holds a valid list.
    sink.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn record(sink: &FaultSink, fault: GpuFault) {
    let mut v = lock(sink);
    if v.len() < MAX_GPU_FAULTS {
        v.push(fault);
    }
}

/// Why the renderer could not start.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum RenderError {
    /// No adapter matched the request.
    #[error("no suitable GPU adapter: {0}")]
    NoAdapter(String),
    /// The adapter refused the device.
    #[error("cannot create the GPU device: {0}")]
    Device(String),
    /// The surface could not be created or configured.
    #[error("surface: {0}")]
    Surface(String),
}

impl RenderError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            RenderError::NoAdapter(_) => "RENDER_NO_ADAPTER",
            RenderError::Device(_) => "RENDER_DEVICE",
            RenderError::Surface(_) => "RENDER_SURFACE",
        }
    }
}

/// Which graphics API the device runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendKind {
    /// Browser WebGPU.
    WebGpu,
    /// WebGL2 (wgpu's GL backend on the web) or native GLES.
    Gl,
    /// Native Metal.
    Metal,
    /// Native Vulkan.
    Vulkan,
    /// Native Direct3D 12.
    Dx12,
    /// Anything else (e.g. the no-op backend).
    Other,
}

impl BackendKind {
    /// From wgpu's backend enum.
    pub fn from_wgpu(b: wgpu::Backend) -> Self {
        match b {
            wgpu::Backend::BrowserWebGpu => BackendKind::WebGpu,
            wgpu::Backend::Gl => BackendKind::Gl,
            wgpu::Backend::Metal => BackendKind::Metal,
            wgpu::Backend::Vulkan => BackendKind::Vulkan,
            wgpu::Backend::Dx12 => BackendKind::Dx12,
            _ => BackendKind::Other,
        }
    }

    /// Short lower-case name (`webgpu`, `webgl2`, `metal`, `vulkan`, `dx12`, `other`).
    pub fn as_str(self) -> &'static str {
        match self {
            BackendKind::WebGpu => "webgpu",
            BackendKind::Gl => {
                if cfg!(target_arch = "wasm32") {
                    "webgl2"
                } else {
                    "gl"
                }
            }
            BackendKind::Metal => "metal",
            BackendKind::Vulkan => "vulkan",
            BackendKind::Dx12 => "dx12",
            BackendKind::Other => "other",
        }
    }
}

/// Formats of the internal targets.
pub const COLOR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
/// Depth format (reverse-Z).
pub const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// ID buffer format.
pub const ID_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Uint;

/// A device plus what forge-render learned about it.
#[derive(Clone, Debug)]
pub struct GpuContext {
    /// The device.
    pub device: wgpu::Device,
    /// Its queue.
    pub queue: wgpu::Queue,
    /// Backend.
    pub backend: BackendKind,
    /// Adapter name (for diagnostics).
    pub adapter_name: String,
    /// MSAA sample count used for the colour pass (4 where supported, else 1).
    pub sample_count: u32,
    /// Largest 2D texture dimension.
    pub max_texture_dimension: u32,
    /// GPU errors the device reported (see the module docs).
    faults: FaultSink,
}

impl GpuContext {
    /// The device descriptor forge-render needs from `adapter`: WebGL2-level limits
    /// (raised to the adapter's texture sizes) and no optional features, so the same
    /// renderer runs on WebGPU, WebGL2 and every native backend.
    pub fn device_descriptor(adapter: &wgpu::Adapter) -> wgpu::DeviceDescriptor<'static> {
        let base = if adapter.get_info().backend == wgpu::Backend::Gl {
            wgpu::Limits::downlevel_webgl2_defaults()
        } else {
            wgpu::Limits::downlevel_defaults()
        };
        wgpu::DeviceDescriptor {
            label: Some("forge-render"),
            required_features: wgpu::Features::empty(),
            required_limits: base.using_resolution(adapter.limits()),
            ..Default::default()
        }
    }

    /// Wrap a device created from `adapter` with [`GpuContext::device_descriptor`], and
    /// route the device's uncaptured errors into the context's fault list (see the module
    /// docs). Create **one** context per device: a device has a single uncaptured-error
    /// handler, and wrapping it again moves the errors to the new context's list.
    pub fn from_device(adapter: &wgpu::Adapter, device: wgpu::Device, queue: wgpu::Queue) -> Self {
        let faults: FaultSink = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&faults);
        device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
            record(&sink, GpuFault::from_wgpu(&e));
        }));
        // A lost device raises no further errors (WebGPU turns every call into a no-op),
        // so the loss itself is a fault: nothing drawn or picked after it is real.
        let lost = Arc::clone(&faults);
        device.set_device_lost_callback(move |reason, message| {
            record(
                &lost,
                GpuFault {
                    kind: "device-lost",
                    message: format!("{reason:?}: {message}"),
                },
            );
        });
        let info = adapter.get_info();
        let msaa = |f: wgpu::TextureFormat| {
            adapter
                .get_texture_format_features(f)
                .flags
                .sample_count_supported(4)
        };
        let sample_count = if msaa(COLOR_FORMAT) && msaa(DEPTH_FORMAT) {
            4
        } else {
            1
        };
        let max_texture_dimension = device.limits().max_texture_dimension_2d;
        GpuContext {
            device,
            queue,
            backend: BackendKind::from_wgpu(info.backend),
            adapter_name: info.name,
            sample_count,
            max_texture_dimension,
            faults,
        }
    }

    /// The first GPU error the device reported since the context was created, or `None`
    /// while the device is healthy. Faults are sticky: a device that raised one is not
    /// trusted again.
    pub fn gpu_fault(&self) -> Option<GpuFault> {
        lock(&self.faults).first().cloned()
    }

    /// [`GpuContext::gpu_fault`] as a `Result`, for `?` in hosts.
    pub fn check_gpu(&self) -> Result<(), GpuFault> {
        self.gpu_fault().map_or(Ok(()), Err)
    }

    /// Every recorded GPU fault (at most 16), oldest first.
    pub fn gpu_faults(&self) -> Vec<GpuFault> {
        lock(&self.faults).clone()
    }

    /// Record an error the host captured itself (e.g. through an error scope, which
    /// keeps it from the uncaptured-error handler) so that it is sticky like the others.
    /// Returns the recorded fault.
    pub fn record_gpu_error(&self, e: &wgpu::Error) -> GpuFault {
        let f = GpuFault::from_wgpu(e);
        record(&self.faults, f.clone());
        f
    }

    /// Request a device from `adapter`.
    pub async fn request(adapter: &wgpu::Adapter) -> Result<Self, RenderError> {
        let desc = Self::device_descriptor(adapter);
        let (device, queue) = adapter
            .request_device(&desc)
            .await
            .map_err(|e| RenderError::Device(e.to_string()))?;
        Ok(Self::from_device(adapter, device, queue))
    }

    /// A headless native context on any of `backends` (for tests, CLI renders and
    /// agents). Blocks; native wgpu futures complete immediately.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn headless(backends: wgpu::Backends) -> Result<Self, RenderError> {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = backends;
        let instance = wgpu::Instance::new(desc);
        let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            ..Default::default()
        }))
        .map_err(|e| RenderError::NoAdapter(e.to_string()))?;
        block_on(Self::request(&adapter))
    }
}

/// Minimal executor for native wgpu futures, which are ready on first poll (or after a
/// few polls); keeps `pollster` out of the runtime dependencies.
#[cfg(not(target_arch = "wasm32"))]
pub fn block_on<F: std::future::Future>(f: F) -> F::Output {
    use std::task::{Context, Poll, Waker};
    let mut f = std::pin::pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::yield_now();
    }
}
