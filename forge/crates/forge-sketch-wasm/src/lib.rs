//! # forge-sketch-wasm — the sketch session for the web
//!
//! `wasm-bindgen` bindings of [`forge_sketch::session`] (plan contract C5), consumed by
//! `@aicad/forge-web/sketch` (`packages/forge-web/src/sketch.ts`), which wraps them in a typed
//! API. The sketcher runs this module **on the UI thread**, so a drag never waits behind a
//! regeneration in the engine worker (plan §2.7, [fm4]).
//!
//! Every method speaks JSON text through [`forge_sketch::session_json`] (natively tested there);
//! this crate is only the binding layer. It is a separate module from `forge-wasm` for now (no
//! wgpu; about 0.9 MB gzipped): folding it into `forge-wasm` is `mod sketch_session;` with the
//! `web` module below as its contents (see `docs/fm/sketcher.md`).

#[cfg(target_arch = "wasm32")]
mod web {
    use forge_sketch::session::SketchSession;
    use forge_sketch::session_json as j;
    use wasm_bindgen::prelude::*;

    /// One sketch session (see `forge_sketch::session`).
    #[wasm_bindgen]
    pub struct RawSketchSession {
        inner: SketchSession,
    }

    #[wasm_bindgen]
    impl RawSketchSession {
        /// Load from a `{ sketch, document?, part? }` JSON text; throws the error JSON text.
        #[wasm_bindgen(constructor)]
        pub fn new(request: &str) -> Result<RawSketchSession, JsValue> {
            console_error_panic_hook::set_once();
            j::load(request)
                .map(|inner| RawSketchSession { inner })
                .map_err(|e| JsValue::from_str(&e))
        }

        /// The current snapshot (JSON).
        pub fn snapshot(&self) -> String {
            j::snapshot(&self.inner)
        }

        /// Apply an edit batch (JSON) with options (JSON, may be empty).
        pub fn apply(&mut self, edits: &str, options: &str) -> String {
            j::apply(&mut self.inner, edits, options)
        }

        /// Solve an edit batch without committing it.
        pub fn preview(&self, edits: &str, options: &str) -> String {
            j::preview(&self.inner, edits, options)
        }

        /// Undo; the snapshot.
        pub fn undo(&mut self) -> String {
            j::undo(&mut self.inner)
        }

        /// Redo; the snapshot.
        pub fn redo(&mut self) -> String {
            j::redo(&mut self.inner)
        }

        /// Grab a point, a curve or a circle's rim (`DragSpec` JSON).
        #[wasm_bindgen(js_name = dragBegin)]
        pub fn drag_begin(&mut self, spec: &str) -> String {
            j::drag_begin(&mut self.inner, spec)
        }

        /// One drag frame.
        #[wasm_bindgen(js_name = dragTo)]
        pub fn drag_to(&mut self, u: f64, v: f64) -> String {
            j::drag_to(&mut self.inner, u, v)
        }

        /// Commit the drag.
        #[wasm_bindgen(js_name = dragEnd)]
        pub fn drag_end(&mut self) -> String {
            j::drag_end(&mut self.inner)
        }

        /// Abandon the drag.
        #[wasm_bindgen(js_name = dragCancel)]
        pub fn drag_cancel(&mut self) {
            self.inner.drag_cancel();
        }

        /// Evaluate an expression (`length`, `angle`, `count`, `ratio`).
        #[wasm_bindgen(js_name = evalExpression)]
        pub fn eval_expression(&self, expr: &str, field: &str) -> String {
            j::eval_expression(&self.inner, expr, field)
        }

        /// Define a document parameter (`mm`, `deg`, `ratio`, `count`).
        #[wasm_bindgen(js_name = defineParam)]
        pub fn define_param(&mut self, name: &str, unit: &str, value: &str) -> String {
            j::define_param(&mut self.inner, name, unit, value)
        }

        /// The finished feature and its checks.
        pub fn finish(&self) -> String {
            j::finish(&self.inner)
        }

        /// The committed edits since load.
        pub fn edits(&self) -> String {
            j::edits(&self.inner)
        }

        /// The current sketch feature.
        pub fn feature(&self) -> String {
            j::feature(&self.inner)
        }
    }

    /// The crate version (cache keys, About).
    #[wasm_bindgen(js_name = sketchEngineVersion)]
    pub fn sketch_engine_version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
