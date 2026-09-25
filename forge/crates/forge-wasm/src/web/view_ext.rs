//! Display-mode bindings of the viewport: forge-render's [`DisplayMode`]s (shaded, shaded
//! with edges, wireframe, hidden line, X-ray) and the X-ray opacity.
//!
//! A child module of `web`, so it reaches `RawViewport`'s host without widening `web.rs`'s
//! API; it is wired by **one line** in `web.rs` (`mod view_ext;`), which the integrator adds
//! when merging the viewport stream (docs/fm/view-sel-followups.md). `@aicad/forge-web`
//! feature-detects these methods, so the app works (with fewer modes) without them.

use forge_render::DisplayMode;
use js_sys::Array;
use wasm_bindgen::prelude::*;

use super::{RawViewport, js_error};

#[wasm_bindgen]
impl RawViewport {
    /// Draw faces and edges as `shaded | shadedEdges | wireframe | hiddenLine | xray`.
    /// Rejects an unknown name with `RENDER_DISPLAY_MODE`.
    #[wasm_bindgen(js_name = setDisplayMode)]
    pub fn set_display_mode(&self, mode: &str) -> Result<(), JsValue> {
        let m = DisplayMode::parse(mode).ok_or_else(|| {
            js_error(
                "RENDER_DISPLAY_MODE",
                &format!(
                    "unknown display mode {mode:?}; use shaded, shadedEdges, wireframe, hiddenLine or xray"
                ),
            )
        })?;
        let mut h = self.inner.borrow_mut();
        let mut o = h.viewport.options().clone();
        o.display = m;
        h.viewport.set_options(o);
        Ok(())
    }

    /// The current display mode's name.
    #[wasm_bindgen(js_name = displayMode)]
    pub fn display_mode(&self) -> String {
        self.inner
            .borrow()
            .viewport
            .options()
            .display
            .as_str()
            .to_string()
    }

    /// Every display mode this renderer draws.
    #[wasm_bindgen(js_name = displayModes)]
    pub fn display_modes(&self) -> Array {
        DisplayMode::ALL
            .iter()
            .map(|m| JsValue::from_str(m.as_str()))
            .collect()
    }

    /// Face opacity in X-ray mode (clamped to 0.02–1).
    #[wasm_bindgen(js_name = setXrayOpacity)]
    pub fn set_xray_opacity(&self, opacity: f64) {
        if !opacity.is_finite() {
            return;
        }
        let mut h = self.inner.borrow_mut();
        let mut o = h.viewport.options().clone();
        o.xray_opacity = opacity.clamp(0.02, 1.0);
        h.viewport.set_options(o);
    }
}
