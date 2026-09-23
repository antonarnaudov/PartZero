//! GPU error scopes around a batch of work, as the bindings use them (audit V3).
//!
//! Browser WebGPU reports errors asynchronously; popping the scopes yields a future that
//! resolves once the device has checked the work, so its verdict can be awaited. This
//! module has no JS in it, so it is compiled and tested natively (wgpu-core enforces the
//! same scope rules as the browser backend).

use std::future::Future;

use forge_render::{BackendKind, GpuContext, GpuFault, wgpu};

/// Error scopes (validation, out-of-memory, internal) pushed around a batch of GPU work.
///
/// wgpu panics when scopes are popped out of order (both its WebGPU and wgpu-core
/// backends check it), and on `wasm32` a panic aborts the whole module. So the scopes
/// are always popped innermost first: by [`Scopes::pop`], and also when a `Scopes` is
/// dropped unpopped (an early return between push and pop). The errors the dropped
/// scopes caught are recorded on the context like every other fault, never lost.
pub struct Scopes {
    ctx: GpuContext,
    /// Outermost first; empty once popped.
    guards: Vec<wgpu::ErrorScopeGuard>,
}

impl Scopes {
    /// Push the three scopes on the context's device.
    pub fn push(ctx: &GpuContext) -> Self {
        let d = &ctx.device;
        Scopes {
            ctx: ctx.clone(),
            guards: vec![
                d.push_error_scope(wgpu::ErrorFilter::Validation),
                d.push_error_scope(wgpu::ErrorFilter::OutOfMemory),
                d.push_error_scope(wgpu::ErrorFilter::Internal),
            ],
        }
    }

    /// Scopes on WebGPU only: wgpu-core (WebGL2) reports errors synchronously to the
    /// context's uncaptured-error handler, which the viewport checks during the call.
    pub fn on_webgpu(ctx: &GpuContext) -> Option<Self> {
        (ctx.backend == BackendKind::WebGpu).then(|| Scopes::push(ctx))
    }

    /// Pop the scopes now (innermost first) and resolve to the first error of the work,
    /// recorded on the context so that it is sticky like an uncaptured one.
    pub fn pop(mut self) -> impl Future<Output = Option<GpuFault>> + use<> {
        self.pop_guards()
    }

    /// Pop whatever is still pushed, innermost first; the future records the errors.
    fn pop_guards(&mut self) -> impl Future<Output = Option<GpuFault>> + use<> {
        let ctx = self.ctx.clone();
        let pending: Vec<_> = std::mem::take(&mut self.guards)
            .into_iter()
            .rev()
            .map(wgpu::ErrorScopeGuard::pop)
            .collect();
        async move {
            let mut first = None;
            for p in pending {
                if let Some(e) = p.await {
                    let f = ctx.record_gpu_error(&e);
                    first.get_or_insert(f);
                }
            }
            first
        }
    }
}

impl Drop for Scopes {
    /// Dropped unpopped: pop in order (a `Vec` would drop its guards outermost first,
    /// which wgpu rejects with a panic) and record what the scopes caught.
    fn drop(&mut self) {
        if self.guards.is_empty() {
            return;
        }
        let checked = self.pop_guards();
        #[cfg(target_arch = "wasm32")]
        wasm_bindgen_futures::spawn_local(async move {
            let _ = checked.await;
        });
        // wgpu-core resolves popped scopes at once.
        #[cfg(not(target_arch = "wasm32"))]
        let _ = forge_render::block_on(checked);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use forge_render::block_on;

    /// A native device (Metal / Vulkan / DX12 / GL). Without one the tests print a notice
    /// and pass, like forge-render's offscreen tests; `FORGE_RENDER_REQUIRE_GPU=1` makes a
    /// missing adapter a failure.
    fn context() -> Option<GpuContext> {
        match GpuContext::headless(wgpu::Backends::PRIMARY | wgpu::Backends::GL) {
            Ok(c) => Some(c),
            Err(e) => {
                if std::env::var("FORGE_RENDER_REQUIRE_GPU").is_ok_and(|v| v == "1") {
                    panic!("no GPU adapter: {e}");
                }
                eprintln!("forge-wasm scope tests skipped: {e}");
                None
            }
        }
    }

    /// A validation error: a buffer that is both `MAP_READ` and `MAP_WRITE`.
    fn invalid_buffer(ctx: &GpuContext) {
        let _ = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("forge-wasm scope test"),
            size: 16,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::MAP_WRITE,
            mapped_at_creation: false,
        });
    }

    #[test]
    fn pop_reports_and_records_the_first_error() {
        let Some(ctx) = context() else { return };
        let scopes = Scopes::push(&ctx);
        assert!(block_on(scopes.pop()).is_none(), "no work, no error");
        assert!(ctx.gpu_fault().is_none());
        let scopes = Scopes::push(&ctx);
        invalid_buffer(&ctx);
        let f = block_on(scopes.pop()).expect("the scope caught the error");
        assert_eq!(f.kind, "validation");
        assert_eq!(ctx.gpu_fault(), Some(f), "recorded on the context");
    }

    /// Review of audit V3: `create_viewport` returned early (`RENDER_SURFACE`) between
    /// pushing and popping, the guards dropped outermost first, and wgpu panicked
    /// ("error scopes must be popped in reverse order"), aborting the WASM module.
    #[test]
    fn early_return_pops_the_scopes_in_order_and_keeps_the_error() {
        let Some(ctx) = context() else { return };
        fn setup(ctx: &GpuContext) -> Result<(), &'static str> {
            let scopes = Scopes::push(ctx);
            invalid_buffer(ctx);
            let config: Result<(), &'static str> = Err("RENDER_SURFACE");
            config?;
            drop(scopes.pop());
            Ok(())
        }
        assert_eq!(setup(&ctx), Err("RENDER_SURFACE"));
        let f = ctx
            .gpu_fault()
            .expect("the dropped scopes' error is recorded");
        assert_eq!(f.kind, "validation");
        // The device's scope stack is balanced again.
        let scopes = Scopes::push(&ctx);
        assert!(block_on(scopes.pop()).is_none());
    }

    #[test]
    fn dropping_unpopped_scopes_does_not_panic() {
        let Some(ctx) = context() else { return };
        drop(Scopes::push(&ctx));
        let outer = Scopes::push(&ctx);
        drop(Scopes::push(&ctx));
        invalid_buffer(&ctx);
        let f = block_on(outer.pop()).expect("the outer scopes catch the later error");
        assert_eq!(f.kind, "validation");
    }
}
