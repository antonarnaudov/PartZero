//! Device creation and capability probing.

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

    /// Wrap a device created from `adapter` with [`GpuContext::device_descriptor`].
    pub fn from_device(adapter: &wgpu::Adapter, device: wgpu::Device, queue: wgpu::Queue) -> Self {
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
        }
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
