//! The JSON face of [`crate::session`]: what the WASM bindings (`forge-sketch-wasm`, later
//! `forge-wasm/src/sketch_session.rs`), the CLI and tests call. Host-free and natively tested.
//!
//! Every input is JSON **text** read with the IR's correctly rounded reader
//! ([`forge_ir::v1::json::parse`]; serde_json's own parser is up to an ulp off), so numbers
//! cross the JS boundary bit-exactly in both directions (JS prints shortest round-trip decimals,
//! serde_json prints them with `ryu`). Every output is a JSON object:
//!
//! | call | success | failure |
//! |---|---|---|
//! | [`load`] | the session | `SessionError` |
//! | [`apply`], [`preview`], [`drag_end`] | `{ "ok": true, "snapshot" }` | `{ "ok": false, "error", "candidate"? }` |
//! | [`drag_begin`] | `{ "ok": true }` | `{ "ok": false, "error" }` |
//! | [`drag_to`] | `{ "ok": true, "frame" }` | `{ "ok": false, "error" }` |
//! | [`eval_expression`], [`define_param`] | `{ "ok": true, "value" }` | `{ "ok": false, "error" }` |
//! | [`finish`] | the [`FinishResult`](crate::session::FinishResult) | — |

use forge_ir::v1::{FieldType, ParamUnit};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::session::{
    ApplyOptions, DragSpec, LoadRequest, Rejection, SessionError, SketchEdit, SketchSession,
};

fn read<T: DeserializeOwned>(text: &str, what: &str) -> Result<T, SessionError> {
    let v = forge_ir::v1::json::parse(text).map_err(|e| bad(what, &e.to_string()))?;
    serde_json::from_value(v).map_err(|e| bad(what, &e.to_string()))
}

fn bad(what: &str, why: &str) -> SessionError {
    SessionError {
        code: "SESSION_BAD_REQUEST".into(),
        message: format!("{what}: {why}"),
        details: serde_json::Map::new(),
        path: None,
    }
}

fn text(v: &impl Serialize) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| {
        json!({ "ok": false, "error": { "code": "FORGE_INTERNAL", "message": e.to_string() } })
            .to_string()
    })
}

fn failure(e: &SessionError) -> String {
    text(&json!({ "ok": false, "error": e }))
}

fn outcome(s: &SketchSession, r: Result<(), Rejection>) -> String {
    match r {
        Ok(()) => text(&json!({ "ok": true, "snapshot": s.snapshot() })),
        Err(rej) => text(&json!({ "ok": false, "error": rej.error, "candidate": rej.candidate })),
    }
}

/// Load a session from a [`LoadRequest`] JSON text (`{ sketch, document?, part? }`).
pub fn load(request: &str) -> Result<SketchSession, String> {
    let req: LoadRequest = read(request, "load request").map_err(|e| text(&e))?;
    SketchSession::load(req).map_err(|e| text(&e))
}

/// The current snapshot.
pub fn snapshot(s: &SketchSession) -> String {
    text(s.snapshot())
}

fn options(opts: &str) -> Result<ApplyOptions, SessionError> {
    if opts.trim().is_empty() {
        Ok(ApplyOptions::default())
    } else {
        read(opts, "apply options")
    }
}

/// Apply an edit batch (`[SketchEdit]` JSON) with `ApplyOptions` JSON (may be empty).
pub fn apply(s: &mut SketchSession, edits: &str, opts: &str) -> String {
    let edits: Vec<SketchEdit> = match read(edits, "edits") {
        Ok(e) => e,
        Err(e) => return failure(&e),
    };
    let opts = match options(opts) {
        Ok(o) => o,
        Err(e) => return failure(&e),
    };
    let r = s.apply(&edits, opts).map(|_| ());
    outcome(s, r)
}

/// Solve an edit batch without committing it.
pub fn preview(s: &SketchSession, edits: &str, opts: &str) -> String {
    let edits: Vec<SketchEdit> = match read(edits, "edits") {
        Ok(e) => e,
        Err(e) => return failure(&e),
    };
    let opts = match options(opts) {
        Ok(o) => o,
        Err(e) => return failure(&e),
    };
    match s.preview(&edits, opts) {
        Ok(snap) => text(&json!({ "ok": true, "snapshot": snap })),
        Err(rej) => text(&json!({ "ok": false, "error": rej.error, "candidate": rej.candidate })),
    }
}

/// Undo; returns the snapshot.
pub fn undo(s: &mut SketchSession) -> String {
    s.undo();
    snapshot(s)
}

/// Redo; returns the snapshot.
pub fn redo(s: &mut SketchSession) -> String {
    s.redo();
    snapshot(s)
}

/// Grab (`DragSpec` JSON).
pub fn drag_begin(s: &mut SketchSession, spec: &str) -> String {
    let spec: DragSpec = match read(spec, "drag spec") {
        Ok(v) => v,
        Err(e) => return failure(&e),
    };
    match s.drag_begin(&spec) {
        Ok(()) => text(&json!({ "ok": true })),
        Err(e) => failure(&e),
    }
}

/// One drag frame.
pub fn drag_to(s: &mut SketchSession, u: f64, v: f64) -> String {
    match s.drag_to([u, v]) {
        Ok(f) => text(&json!({ "ok": true, "frame": f })),
        Err(e) => failure(&e),
    }
}

/// Commit the drag.
pub fn drag_end(s: &mut SketchSession) -> String {
    let r = s.drag_end().map(|_| ());
    outcome(s, r)
}

fn field(name: &str) -> Result<FieldType, SessionError> {
    match name {
        "length" => Ok(FieldType::Length),
        "angle" => Ok(FieldType::Angle),
        "count" => Ok(FieldType::Count),
        "ratio" => Ok(FieldType::Ratio),
        _ => Err(bad("field", "expected length, angle, count or ratio")),
    }
}

/// Evaluate an expression as `length` or `angle` (or `count`, `ratio`).
pub fn eval_expression(s: &SketchSession, expr: &str, field_name: &str) -> String {
    let r = field(field_name).and_then(|f| s.eval_expression(expr, f));
    match r {
        Ok(v) => text(&json!({ "ok": true, "value": v })),
        Err(e) => failure(&e),
    }
}

/// Define a parameter (`unit`: `mm`, `deg`, `ratio`, `count`).
pub fn define_param(s: &mut SketchSession, name: &str, unit: &str, value: &str) -> String {
    let unit = match unit {
        "mm" => ParamUnit::Mm,
        "deg" => ParamUnit::Deg,
        "ratio" => ParamUnit::Ratio,
        "count" => ParamUnit::Count,
        _ => return failure(&bad("unit", "expected mm, deg, ratio or count")),
    };
    match s.define_param(name, unit, value) {
        Ok(v) => text(&json!({ "ok": true, "value": v })),
        Err(e) => failure(&e),
    }
}

/// The finished feature and its checks.
pub fn finish(s: &SketchSession) -> String {
    text(&s.finish())
}

/// The committed edits since load.
pub fn edits(s: &SketchSession) -> String {
    text(&s.edits())
}

/// The current sketch feature (as committed, not canonicalized).
pub fn feature(s: &SketchSession) -> String {
    let mut v = serde_json::to_value(s.sketch()).unwrap_or(Value::Null);
    if let Value::Object(m) = &mut v {
        m.insert("type".into(), json!("sketch"));
    }
    text(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        forge_ir::v1::json::parse(s).unwrap()
    }

    #[test]
    fn a_session_round_trips_through_json_text() {
        let mut s = load(r#"{ "sketch": { "id": "s1", "name": "s", "plane": "XY", "curves": [] } }"#)
            .unwrap();
        let r = parse(&apply(
            &mut s,
            r#"[{ "op": "addCurve", "curve": { "kind": "line", "id": "l", "start": [0, 0], "end": [10.1, 0.30000000000000004] } }]"#,
            "",
        ));
        assert_eq!(r["ok"], true);
        assert_eq!(r["snapshot"]["curves"][0]["end"][1], json!(0.30000000000000004));
        let r = parse(&apply(&mut s, r#"[{ "op": "removeCurve", "id": "nope" }]"#, "{}"));
        assert_eq!(r["ok"], false);
        assert_eq!(r["error"]["code"], "SESSION_UNKNOWN_ID");
        let r = parse(&apply(&mut s, "not json", ""));
        assert_eq!(r["error"]["code"], "SESSION_BAD_REQUEST");
        let r = parse(&drag_begin(&mut s, r#"{ "target": "l.end", "grab": [10.1, 0.3] }"#));
        assert_eq!(r["ok"], true);
        let r = parse(&drag_to(&mut s, 12.0, 1.0));
        assert_eq!(r["ok"], true);
        assert_eq!(r["frame"]["converged"], true);
        let r = parse(&drag_end(&mut s));
        assert_eq!(r["ok"], true);
        let r = parse(&eval_expression(&s, "2 * 3 mm", "length"));
        assert_eq!(r["value"], json!(6.0));
        let r = parse(&finish(&s));
        assert_eq!(r["feature"]["type"], "sketch");
        assert_eq!(r["error"]["code"], "SKETCH_OPEN_LOOP", "a lone line is an open profile");
        let r = parse(&feature(&s));
        assert_eq!(r["curves"][0]["id"], "l");
        assert!(load("{}").is_err());
    }
}
