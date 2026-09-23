//! JSON in / JSON out, for the TypeScript app, the agent tools and the oracle harness.
//!
//! - `solve_json`: `{"sketch": Sketch, "options"?: SolveOptions}` → [`SolveResult`].
//! - `drag_json`: `{"sketch", "options"?, "point": id, "targets": [[x, y], …]}` →
//!   [`DragResponse`].
//! - Errors: `{"error": {"code": "SKETCH_…", "message": "…", "details": {…}}}`.
//!
//! Output is deterministic: fields in declaration order, floats in shortest round-trip form.

use serde::{Deserialize, Serialize};

use crate::error::SketchError;
use crate::model::Sketch;
use crate::result::{DragResult, SolveOptions, SolveResult};

/// Input of [`solve_json`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SolveRequest {
    /// The sketch.
    pub sketch: Sketch,
    /// Options (defaults when omitted).
    #[serde(default)]
    pub options: SolveOptions,
}

/// Input of [`drag_json`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DragRequest {
    /// The sketch.
    pub sketch: Sketch,
    /// Options (defaults when omitted).
    #[serde(default)]
    pub options: SolveOptions,
    /// The dragged point id.
    pub point: String,
    /// Cursor positions, one per frame.
    pub targets: Vec<[f64; 2]>,
}

/// Output of [`drag_json`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DragResponse {
    /// One result per frame.
    pub frames: Vec<DragResult>,
    /// The sketch after the last frame.
    pub sketch: Sketch,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'static str,
    message: String,
    details: &'a SketchError,
}

#[derive(Serialize)]
struct ErrorEnvelope<'a> {
    error: ErrorBody<'a>,
}

/// Serialize an error as `{"error": {…}}`.
pub fn error_json(e: &SketchError) -> String {
    serde_json::to_string(&ErrorEnvelope {
        error: ErrorBody {
            code: e.code(),
            message: e.to_string(),
            details: e,
        },
    })
    .unwrap_or_else(|_| format!("{{\"error\":{{\"code\":\"{}\"}}}}", e.code()))
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| {
        error_json(&SketchError::Json {
            message: e.to_string(),
        })
    })
}

/// Solve a JSON [`SolveRequest`]; returns a [`SolveResult`] or an error envelope.
pub fn solve_json(input: &str) -> String {
    match serde_json::from_str::<SolveRequest>(input) {
        Err(e) => error_json(&SketchError::Json {
            message: e.to_string(),
        }),
        Ok(req) => match crate::solve(&req.sketch, &req.options) {
            Ok(r) => to_json::<SolveResult>(&r),
            Err(e) => error_json(&e),
        },
    }
}

/// Run a JSON [`DragRequest`]; returns a [`DragResponse`] or an error envelope.
pub fn drag_json(input: &str) -> String {
    match serde_json::from_str::<DragRequest>(input) {
        Err(e) => error_json(&SketchError::Json {
            message: e.to_string(),
        }),
        Ok(req) => match crate::drag(&req.sketch, &req.point, &req.targets, &req.options) {
            Ok((frames, sketch)) => to_json(&DragResponse { frames, sketch }),
            Err(e) => error_json(&e),
        },
    }
}
