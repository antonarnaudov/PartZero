//! STEP export for the web engine (IO stream): evaluate an IR document and write its final
//! bodies with forge-io's own STEP writer, exactly as `aicad export --format step` does (same
//! body names, same options, same bytes).
//!
//! **Wiring (integrator, after Phase C):** this file is not compiled until `lib.rs` declares
//! it — add `pub mod step_export;` next to `pub mod engine;` — and `web.rs` gets the binding:
//!
//! ```ignore
//! /// Evaluate and write every final body as STEP (AP214 by default); `optionsJson` is
//! /// `{ "schema"?: "ap214" | "ap242", "productName"?: string, "allowPartial"?: bool }`.
//! #[wasm_bindgen(js_name = exportStep)]
//! pub fn export_step(ir_json: &str, options_json: Option<String>) -> Result<Uint8Array, JsValue> {
//!     let opts = crate::step_export::StepExportOptions::from_json(options_json.as_deref())
//!         .map_err(core_error)?;
//!     let bytes = crate::step_export::export_step(ir_json, &opts).map_err(core_error)?;
//!     Ok(Uint8Array::from(bytes.as_slice()))
//! }
//! ```
//!
//! and `@aicad/forge-web` exposes it next to `exportMesh`.

use forge_io::step::{StepBody, StepOptions, StepSchema, write_step};

use crate::engine::{CoreError, body_name, is_v0};

fn err(code: &str, message: impl Into<String>) -> CoreError {
    CoreError {
        code: code.to_string(),
        message: message.into(),
    }
}

/// Options of [`export_step`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StepExportOptions {
    /// AP214 (default) or AP242.
    pub schema: StepSchema,
    /// The STEP product name (default `part`).
    pub product_name: String,
    /// Export the bodies that evaluated even when some features failed.
    pub allow_partial: bool,
}

impl Default for StepExportOptions {
    fn default() -> Self {
        StepExportOptions {
            schema: StepSchema::Ap214,
            product_name: "part".into(),
            allow_partial: false,
        }
    }
}

impl StepExportOptions {
    /// Parse `{ "schema"?, "productName"?, "allowPartial"? }` (`None` or `{}`: the defaults).
    pub fn from_json(text: Option<&str>) -> Result<Self, CoreError> {
        let mut o = StepExportOptions::default();
        let Some(text) = text else { return Ok(o) };
        let v: serde_json::Value = serde_json::from_str(text)
            .map_err(|e| err("STEP_INVALID_OPTIONS", format!("options are not JSON: {e}")))?;
        let obj = v
            .as_object()
            .ok_or_else(|| err("STEP_INVALID_OPTIONS", "options must be an object"))?;
        for (k, val) in obj {
            match (k.as_str(), val) {
                ("schema", serde_json::Value::String(s)) if s == "ap214" => {
                    o.schema = StepSchema::Ap214
                }
                ("schema", serde_json::Value::String(s)) if s == "ap242" => {
                    o.schema = StepSchema::Ap242
                }
                ("productName", serde_json::Value::String(s)) if !s.trim().is_empty() => {
                    o.product_name = s.clone();
                }
                ("allowPartial", serde_json::Value::Bool(b)) => o.allow_partial = *b,
                _ => {
                    return Err(err(
                        "STEP_INVALID_OPTIONS",
                        format!("unknown or invalid option {k:?}"),
                    ));
                }
            }
        }
        Ok(o)
    }
}

/// Evaluate `ir_json` (`aicad.ir/0` or `aicad.ir/1`) and write every final body as one STEP
/// part. Fails with the first feature or parameter error unless `allow_partial`, with
/// `EXPORT_NO_BODIES` when nothing evaluated, and with the writer's `STEP_*` code otherwise.
pub fn export_step(ir_json: &str, opts: &StepExportOptions) -> Result<Vec<u8>, CoreError> {
    let step_opts = StepOptions {
        schema: opts.schema,
        product_name: opts.product_name.clone(),
        file_name: format!("{}.step", opts.product_name),
        ..StepOptions::default()
    };
    let write = |bodies: &[StepBody<'_>]| -> Result<Vec<u8>, CoreError> {
        if bodies.is_empty() {
            return Err(err(
                "EXPORT_NO_BODIES",
                "the document produced no bodies; nothing to export",
            ));
        }
        write_step(bodies, &step_opts)
            .map(|(bytes, _)| bytes)
            .map_err(|e| err(e.code(), e.to_string()))
    };
    if is_v0(ir_json) {
        let doc = forge_ir::from_json(ir_json).map_err(|e| match &e {
            forge_ir::IrError::Parse(p) => err("IR_PARSE_ERROR", p.to_string()),
            forge_ir::IrError::Invalid(errs) => {
                err(errs.first().map_or("IR_INVALID", |x| x.code), e.to_string())
            }
        })?;
        let evaluation = forge_regen::evaluate(&doc);
        if !opts.allow_partial
            && let Some((f, e)) = evaluation
                .features
                .iter()
                .find_map(|f| f.outcome.as_ref().err().map(|e| (f, e)))
        {
            return Err(err(e.code(), format!("{}/{}: {e}", f.part, f.feature)));
        }
        let mut named = Vec::new();
        for f in &evaluation.features {
            let Ok(forge_regen::FeatureOutput::Bodies(bs)) = &f.outcome else {
                continue;
            };
            for (i, body) in bs.iter().enumerate() {
                named.push((body_name(&f.part, &f.feature, i, bs.len()), body));
            }
        }
        let items: Vec<StepBody<'_>> = named
            .iter()
            .map(|(name, body)| StepBody {
                name,
                body,
                color: None,
            })
            .collect();
        return write(&items);
    }
    let l = forge_regen::v1::load(ir_json).map_err(|e| {
        let code = e.errors().first().map_or("IR_PARSE_ERROR", |x| x.code);
        err(code, e.to_string())
    })?;
    let ev = forge_regen::v1::evaluate(&l.doc);
    if !opts.allow_partial {
        if let Some((p, e)) = ev
            .params
            .iter()
            .find_map(|p| p.error.as_ref().map(|e| (p, e)))
        {
            return Err(err(&e.code, format!("parameter {}: {}", p.name, e.message)));
        }
        if let Some((f, e)) = ev
            .features
            .iter()
            .find_map(|f| f.error.as_ref().map(|e| (f, e)))
        {
            return Err(err(
                &e.code,
                format!("{}/{}: {}", f.part, f.feature, e.message),
            ));
        }
    }
    // Final bodies, named as `aicad export` names them (`part/feature`, `#k` for repeats).
    let mut named = Vec::new();
    for (pi, part) in ev.parts.iter().enumerate() {
        let names: Vec<String> = part
            .bodies
            .iter()
            .map(|b| {
                let feature = l
                    .doc
                    .parts
                    .get(pi)
                    .and_then(|p| p.features.iter().find(|f| f.id() == b.origin.feature))
                    .map_or(b.origin.feature.as_str(), |f| f.name());
                format!("{}/{feature}", part.part)
            })
            .collect();
        for (i, b) in part.bodies.iter().enumerate() {
            let same: Vec<usize> = (0..names.len()).filter(|&j| names[j] == names[i]).collect();
            let name = if same.len() == 1 {
                names[i].clone()
            } else {
                let k = same.iter().position(|&j| j == i).unwrap_or(0);
                format!("{}#{k}", names[i])
            };
            named.push((name, &b.body));
        }
    }
    let items: Vec<StepBody<'_>> = named
        .iter()
        .map(|(name, body)| StepBody {
            name,
            body,
            color: None,
        })
        .collect();
    write(&items)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOX: &str = include_str!("../../../../corpus/programs/extrude_box.json");
    const TORUS: &str = include_str!("../../../../corpus/programs/revolve_torus.json");
    const V1_PLATE: &str = include_str!("../../../../corpus/v1/programs/params_plate.json");

    #[test]
    fn exports_v0_and_v1_documents_as_verified_step() {
        for (doc, schema) in [(BOX, "ap214"), (TORUS, "ap242"), (V1_PLATE, "ap214")] {
            let opts = StepExportOptions::from_json(Some(&format!(
                "{{\"schema\":\"{schema}\",\"productName\":\"p\"}}"
            )))
            .expect("options");
            let bytes = export_step(doc, &opts).expect("exports");
            let summary = forge_io::verify_step(&bytes).expect("verifies");
            assert!(!summary.solids.is_empty());
            assert_eq!(
                export_step(doc, &opts).expect("again"),
                bytes,
                "deterministic"
            );
        }
    }

    #[test]
    fn options_are_validated() {
        assert_eq!(
            StepExportOptions::from_json(None).expect("default"),
            StepExportOptions::default()
        );
        for bad in ["[]", "{\"schema\":\"ap203\"}", "{\"x\":1}", "nope"] {
            assert_eq!(
                StepExportOptions::from_json(Some(bad)).expect_err(bad).code,
                "STEP_INVALID_OPTIONS"
            );
        }
    }

    #[test]
    fn a_rejected_document_is_a_coded_error() {
        let e = export_step("{\"schema\":\"aicad.ir/1\"}", &StepExportOptions::default())
            .expect_err("rejected");
        assert!(!e.code.is_empty());
    }
}
