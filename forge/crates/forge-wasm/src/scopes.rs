//! GPU error scopes around a batch of work, as the bindings use them (audit V3).
//!
//! Browser WebGPU reports errors asynchronously; popping the scopes yields a future that
//! resolves once the device has checked the work, so its verdict can be awaited. This
//! module has no JS in it, so it is compiled and tested natively (wgpu-core enforces the
//! same scope rules as the browser backend).

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use forge_render::{BackendKind, GpuContext, GpuFault, wgpu};

/// Error scopes (validation, out-of-memory, internal) pushed around a batch of GPU work.
///
/// wgpu panics when scopes are popped out of order (both its WebGPU and wgpu-core
/// backends check it; the stack is per device and per thread), and on `wasm32` a panic
/// aborts the whole module. So the scopes are always popped innermost first:
/// - within one `Scopes`, by [`Scopes::pop`] and also when it is dropped unpopped (an
///   early return between push and pop);
/// - across instances on one device, by a per-thread registry of the live ones: a
///   `Scopes` released (popped or dropped) while scopes pushed after it are still live
///   is **deferred** — its scopes stay pushed until those are released, then go with
///   them. Its `pop` future resolves then. (Work in between is caught by the inner
///   scopes, which filter the same errors.)
///
/// The errors the scopes caught are recorded on the context like every other fault,
/// never lost. A `Scopes` leaked with `mem::forget` leaks its scopes, and those of every
/// `Scopes` pushed before it on the device that is released after.
pub struct Scopes {
    ctx: GpuContext,
    /// Registry id (see [`LIVE`]).
    id: u64,
    /// Outermost first; empty once released.
    guards: Vec<wgpu::ErrorScopeGuard>,
}

/// A popped `Scopes`' verdict: the first error its scopes caught, recorded on the
/// context.
type Verdict = Pin<Box<dyn Future<Output = Option<GpuFault>>>>;

/// A registered, not yet popped `Scopes`.
struct Live {
    id: u64,
    /// Its device. `wgpu::Device` equality compares ids, which distinct devices of
    /// separate wgpu-core instances may share: such a pair defers needlessly, never
    /// unsafely (the same device always compares equal).
    device: wgpu::Device,
    /// Released while scopes pushed after it on the same device were live: popped with
    /// them.
    deferred: Option<Deferred>,
}

struct Deferred {
    ctx: GpuContext,
    guards: Vec<wgpu::ErrorScopeGuard>,
    /// Where a deferred [`Scopes::pop`] awaits the verdict (`None` if it was dropped).
    reply: Option<Rc<Reply>>,
}

thread_local! {
    /// The live `Scopes` of this thread, in push order.
    static LIVE: RefCell<Vec<Live>> = const { RefCell::new(Vec::new()) };
    static NEXT_ID: Cell<u64> = const { Cell::new(0) };
}

impl Scopes {
    /// Push the three scopes on the context's device.
    pub fn push(ctx: &GpuContext) -> Self {
        let d = &ctx.device;
        let id = NEXT_ID.with(|n| {
            let id = n.get();
            n.set(id.wrapping_add(1));
            id
        });
        LIVE.with_borrow_mut(|live| {
            live.push(Live {
                id,
                device: d.clone(),
                deferred: None,
            })
        });
        Scopes {
            ctx: ctx.clone(),
            id,
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

    /// Pop the scopes (innermost first) and resolve to the first error of the work,
    /// recorded on the context so that it is sticky like an uncaptured one. Popped at
    /// once, or — if scopes pushed after these on the device are still live — together
    /// with them, and the future resolves then.
    pub fn pop(mut self) -> impl Future<Output = Option<GpuFault>> + use<> {
        let released = self.release(true);
        async move {
            match released {
                Released::Now(verdict) => verdict.await,
                Released::Deferred(Some(reply)) => AwaitReply(reply).await,
                Released::Deferred(None) | Released::Already => None,
            }
        }
    }

    /// Release the scopes: pop them now if they are the device's innermost live ones
    /// (and then every deferred `Scopes` that this uncovers), else defer them.
    fn release(&mut self, reply: bool) -> Released {
        let guards = std::mem::take(&mut self.guards);
        if guards.is_empty() {
            return Released::Already;
        }
        // Decide under the registry's borrow, pop after it (wgpu does not call back, but
        // this keeps `Drop` during unwinding free of re-entrancy).
        enum Plan {
            Pop(Vec<wgpu::ErrorScopeGuard>, Vec<Deferred>),
            Defer(Option<Rc<Reply>>),
        }
        let (ctx, id) = (self.ctx.clone(), self.id);
        let plan = LIVE.with_borrow_mut(move |live| {
            let Some(pos) = live.iter().position(|l| l.id == id) else {
                return Plan::Pop(guards, Vec::new());
            };
            let device = live[pos].device.clone();
            if live[pos + 1..].iter().any(|l| l.device == device) {
                let r = reply.then(|| Rc::new(Reply::default()));
                live[pos].deferred = Some(Deferred {
                    ctx,
                    guards,
                    reply: r.clone(),
                });
                return Plan::Defer(r);
            }
            live.remove(pos);
            // Innermost first: the deferred `Scopes` this uncovers, until a live one.
            let mut uncovered = Vec::new();
            while let Some(i) = live.iter().rposition(|l| l.device == device) {
                if live[i].deferred.is_none() {
                    break;
                }
                uncovered.extend(live.remove(i).deferred);
            }
            Plan::Pop(guards, uncovered)
        });
        match plan {
            Plan::Defer(r) => Released::Deferred(r),
            Plan::Pop(guards, uncovered) => {
                let verdict = popped(self.ctx.clone(), guards);
                for d in uncovered {
                    let v = popped(d.ctx, d.guards);
                    let reply = d.reply;
                    drive(async move {
                        let f = v.await;
                        if let Some(r) = reply {
                            r.fill(f);
                        }
                    });
                }
                Released::Now(verdict)
            }
        }
    }
}

/// What releasing a `Scopes` did.
enum Released {
    /// Popped: the verdict.
    Now(Verdict),
    /// Deferred: where a pop awaits the verdict.
    Deferred(Option<Rc<Reply>>),
    /// Nothing left to pop.
    Already,
}

/// Pop `guards` (outermost first) innermost first, now; the verdict records the errors.
fn popped(ctx: GpuContext, guards: Vec<wgpu::ErrorScopeGuard>) -> Verdict {
    let pending: Vec<_> = guards
        .into_iter()
        .rev()
        .map(wgpu::ErrorScopeGuard::pop)
        .collect();
    Box::pin(async move {
        let mut first = None;
        for p in pending {
            if let Some(e) = p.await {
                let f = ctx.record_gpu_error(&e);
                first.get_or_insert(f);
            }
        }
        first
    })
}

/// Run a verdict nobody awaits to completion (it records what the scopes caught).
fn drive(f: impl Future<Output = ()> + 'static) {
    #[cfg(target_arch = "wasm32")]
    wasm_bindgen_futures::spawn_local(f);
    // wgpu-core resolves popped scopes at once.
    #[cfg(not(target_arch = "wasm32"))]
    forge_render::block_on(f);
}

/// A deferred pop's verdict, filled when its scopes are finally popped.
#[derive(Default)]
struct Reply {
    verdict: RefCell<Option<Option<GpuFault>>>,
    waker: RefCell<Option<Waker>>,
}

impl Reply {
    fn fill(&self, v: Option<GpuFault>) {
        *self.verdict.borrow_mut() = Some(v);
        if let Some(w) = self.waker.borrow_mut().take() {
            w.wake();
        }
    }
}

struct AwaitReply(Rc<Reply>);

impl Future for AwaitReply {
    type Output = Option<GpuFault>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(v) = self.0.verdict.borrow_mut().take() {
            return Poll::Ready(v);
        }
        *self.0.waker.borrow_mut() = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl Drop for Scopes {
    /// Dropped unpopped: pop in order (a `Vec` would drop its guards outermost first,
    /// which wgpu rejects with a panic), or defer behind the scopes pushed after these,
    /// and record what the scopes caught.
    fn drop(&mut self) {
        if let Released::Now(verdict) = self.release(false) {
            drive(async move {
                let _ = verdict.await;
            });
        }
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
        assert_balanced(&ctx);
    }

    /// No scope is left pushed on `ctx`'s device: an error outside every scope reaches
    /// the uncaptured-error handler, which records it (a leftover scope would swallow it).
    fn assert_balanced(ctx: &GpuContext) {
        let before = ctx.gpu_faults().len();
        invalid_buffer(ctx);
        assert_eq!(
            ctx.gpu_faults().len(),
            before + 1,
            "a scope is still pushed"
        );
        LIVE.with_borrow(|live| {
            assert!(
                live.iter().all(|l| l.device != ctx.device),
                "registry not empty"
            )
        });
    }

    /// Review of the V3 fix: `Scopes` released out of order *across instances* (an
    /// outer one dropped or popped while an inner one is live, e.g. an outer moved into
    /// a struct that outlives the inner) would pop wgpu's scopes out of order: a panic,
    /// an abort on wasm32. They are deferred until the inner ones are released instead.
    #[test]
    fn out_of_order_release_across_instances_is_deferred() {
        let Some(ctx) = context() else { return };
        // Dropped out of order: the inner scopes still catch the error.
        let outer = Scopes::push(&ctx);
        let inner = Scopes::push(&ctx);
        drop(outer);
        invalid_buffer(&ctx);
        let f = block_on(inner.pop()).expect("the inner scopes catch the error");
        assert_eq!(f.kind, "validation");
        assert_balanced(&ctx);

        // Popped out of order: the outer verdicts wait for the inner release.
        let outer = Scopes::push(&ctx);
        let middle = Scopes::push(&ctx);
        let inner = Scopes::push(&ctx);
        invalid_buffer(&ctx);
        let outer_verdict = outer.pop();
        let middle_verdict = middle.pop();
        let f = block_on(inner.pop()).expect("the inner scopes catch the error");
        assert_eq!(f.kind, "validation");
        assert_eq!(block_on(middle_verdict), None);
        assert_eq!(block_on(outer_verdict), None);
        assert_balanced(&ctx);

        // Popped out of order, then the inner one dropped: both go at the drop, so the
        // next error is outside every scope (recorded by the uncaptured-error handler).
        let outer = Scopes::push(&ctx);
        let inner = Scopes::push(&ctx);
        let outer_verdict = outer.pop();
        drop(inner);
        invalid_buffer(&ctx);
        assert_eq!(
            block_on(outer_verdict),
            None,
            "popped with the inner scopes"
        );
        assert_eq!(ctx.gpu_faults().last().map(|f| f.kind), Some("validation"));
        assert_balanced(&ctx);
    }

    /// wgpu keeps one scope stack per device, and `wgpu::Device` equality is an id that
    /// separate wgpu-core instances may share, so scopes of another device can defer
    /// needlessly — never unsafely: each error is recorded on its own context once both
    /// are released, and both stacks end balanced.
    #[test]
    fn scopes_of_two_devices_release_in_any_order() {
        let (Some(a), Some(b)) = (context(), context()) else {
            return;
        };
        let on_a = Scopes::push(&a);
        let on_b = Scopes::push(&b);
        drop(on_a);
        invalid_buffer(&a);
        invalid_buffer(&b);
        let f = block_on(on_b.pop()).expect("b's scopes catch b's error");
        assert_eq!(f.kind, "validation");
        // `a`'s error: uncaptured, or caught by its deferred scopes; recorded either way.
        assert_eq!(a.gpu_faults().len(), 1);
        assert_balanced(&a);
        assert_balanced(&b);
    }
}
