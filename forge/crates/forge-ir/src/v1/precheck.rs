//! Raw pre-checks (SPEC-v1 §0.5, [W0-1]): the rejections that must carry a code although the
//! typed parse (serde / JSON Schema) would fail on them. They run on the JSON value before the
//! typed parse, in document order:
//!
//! | Where | Code |
//! |---|---|
//! | any `null` | parse error (IR v1 has no nullable field) |
//! | `parts[*].features[*].type` unknown | `UNSUPPORTED_FEATURE` |
//! | `…features[*].v` not a positive integer, or not a defined version | `UNSUPPORTED_FEATURE_VERSION` |
//! | a parameter's `unit` unknown, `value` missing, `measure` present (deferred to v1.1) | `PARAM_INVALID` |
//! | any Ref (an object with `kind` and `q`) whose `card` is not `one`/`some`/`any`/integer ≥ 1 | `INVALID_CARDINALITY` |
//! | a hole's `size` not in `HOLE_SIZES` | `HOLE_SIZE_UNKNOWN` |
//! | `driving` or `value` on a constraint that is not a dimension | `SKETCH_NOT_A_DIMENSION` |
//!
//! The oracle (W7) and CadScript (W8) must run the same checks before their schema validation.

use serde_json::{Value, json};

use super::LoadError;
use super::features::{FEATURE_TYPES, HoleSize, defined_versions};
use super::ids;
use super::params::ParamUnit;
use super::sketch::{CONSTRAINT_TYPES, DIMENSION_TYPES};
use super::validate::ValidationError;

pub(crate) struct Precheck {
    pub(crate) parse: Option<LoadError>,
    pub(crate) errors: Vec<ValidationError>,
}

pub(crate) fn precheck(v: &Value) -> Precheck {
    let mut out = Precheck {
        parse: None,
        errors: Vec::new(),
    };
    if let Some(p) = find_null(v, "") {
        out.parse = Some(LoadError::Parse {
            message: format!("null is not allowed at {p} (omit the field instead)"),
            path: Some(p),
        });
        return out;
    }
    let errs = &mut out.errors;
    if let Some(params) = v.get("params").and_then(Value::as_array) {
        for (i, p) in params.iter().enumerate() {
            param(p, &format!("/params/{i}"), errs);
        }
    }
    if let Some(parts) = v.get("parts").and_then(Value::as_array) {
        for (pi, part) in parts.iter().enumerate() {
            let pp = format!("/parts/{pi}");
            if let Some(params) = part.get("params").and_then(Value::as_array) {
                for (i, p) in params.iter().enumerate() {
                    param(p, &format!("{pp}/params/{i}"), errs);
                }
            }
            let Some(features) = part.get("features").and_then(Value::as_array) else {
                continue;
            };
            for (fi, f) in features.iter().enumerate() {
                feature(f, &format!("{pp}/features/{fi}"), errs);
            }
        }
    }
    refs(v, "", errs);
    out
}

fn find_null(v: &Value, path: &str) -> Option<String> {
    match v {
        Value::Null => Some(if path.is_empty() {
            "/".into()
        } else {
            path.into()
        }),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .find_map(|(i, x)| find_null(x, &format!("{path}/{i}"))),
        Value::Object(o) => o
            .iter()
            .find_map(|(k, x)| find_null(x, &format!("{path}/{}", escape(k)))),
        _ => None,
    }
}

/// JSON-pointer escaping of one path segment.
fn escape(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

fn param(p: &Value, pp: &str, errs: &mut Vec<ValidationError>) {
    let Some(o) = p.as_object() else { return };
    let name = ids::shown(o.get("name").and_then(Value::as_str).unwrap_or(""));
    let invalid = |errs: &mut Vec<ValidationError>, path: String, reason: &str, msg: String| {
        errs.push(ValidationError::new(
            "PARAM_INVALID",
            path,
            msg,
            json!({ "name": name, "reason": reason, "allowed": ParamUnit::ALL }),
        ));
    };
    match o.get("unit") {
        Some(Value::String(u)) if ParamUnit::ALL.contains(&u.as_str()) => {}
        Some(u) => invalid(
            errs,
            format!("{pp}/unit"),
            "bad-unit",
            format!(
                "unit {} is not one of mm, deg, ratio, count, bool",
                shown_value(u)
            ),
        ),
        None => invalid(errs, pp.to_string(), "bad-unit", "unit is required".into()),
    }
    if o.contains_key("measure") {
        invalid(
            errs,
            format!("{pp}/measure"),
            "measure-deferred",
            "measured parameters are deferred to IR v1.1 (ADR 0013 decision 5)".into(),
        );
    } else if !o.contains_key("value") {
        invalid(
            errs,
            pp.to_string(),
            "value-required",
            "value is required".into(),
        );
    }
}

fn feature(f: &Value, fp: &str, errs: &mut Vec<ValidationError>) {
    let Some(o) = f.as_object() else { return };
    let ty = o.get("type").and_then(Value::as_str);
    match ty {
        Some(t) if FEATURE_TYPES.contains(&t) => {}
        _ => {
            errs.push(ValidationError::new(
                "UNSUPPORTED_FEATURE",
                format!("{fp}/type"),
                format!("unknown feature type {}", shown_value(o.get("type").unwrap_or(&Value::Null))),
                json!({ "type": shown_value(o.get("type").unwrap_or(&Value::Null)), "supported": FEATURE_TYPES }),
            ));
            return;
        }
    }
    let ty = ty.unwrap_or_default();
    if let Some(v) = o.get("v") {
        let supported = defined_versions(ty);
        let ok = v
            .as_u64()
            .is_some_and(|n| supported.iter().any(|s| u64::from(*s) == n));
        if !ok {
            errs.push(ValidationError::new(
                "UNSUPPORTED_FEATURE_VERSION",
                format!("{fp}/v"),
                format!(
                    "{ty} v{} is not implemented (supported: {supported:?})",
                    shown_value(v)
                ),
                json!({ "type": ty, "v": shown_value(v), "supported": supported }),
            ));
        }
    }
    if ty == "hole"
        && let Some(size) = o.get("size")
        && size.as_str().is_none_or(|s| HoleSize::parse(s).is_none())
    {
        let allowed: Vec<&str> = HoleSize::ALL.iter().map(|s| s.as_str()).collect();
        errs.push(ValidationError::new(
            "HOLE_SIZE_UNKNOWN",
            format!("{fp}/size"),
            format!(
                "unknown hole size {}; use one of {}",
                shown_value(size),
                allowed.join(", ")
            ),
            json!({ "field": "size", "allowed": allowed }),
        ));
    }
    if ty == "sketch"
        && let Some(cons) = o.get("constraints").and_then(Value::as_array)
    {
        for (k, c) in cons.iter().enumerate() {
            let Some(c) = c.as_object() else { continue };
            let Some(t) = c.get("type").and_then(Value::as_str) else {
                continue;
            };
            if !CONSTRAINT_TYPES.contains(&t) || DIMENSION_TYPES.contains(&t) {
                continue;
            }
            for key in ["driving", "value"] {
                if c.contains_key(key) {
                    let id = ids::shown(c.get("id").and_then(Value::as_str).unwrap_or(""));
                    errs.push(ValidationError::new(
                        "SKETCH_NOT_A_DIMENSION",
                        format!("{fp}/constraints/{k}/{key}"),
                        format!(
                            "`{id}`: only dimensions (distance, angle, radius, diameter) take {key}"
                        ),
                        json!({ "id": id }),
                    ));
                }
            }
        }
    }
}

/// A raw JSON value as messages may show it ([W0-12]): numbers and booleans as they are, strings
/// only when they are well-formed ids, anything else as a placeholder.
fn shown_value(v: &Value) -> String {
    match v {
        Value::Number(_) | Value::Bool(_) | Value::Null => v.to_string(),
        Value::String(s) if ids::is_ref(s) => format!("{s:?}"),
        _ => "<invalid value>".to_string(),
    }
}

/// Every Ref in the document (an object with both `kind` and `q`): check `card`.
fn refs(v: &Value, path: &str, errs: &mut Vec<ValidationError>) {
    match v {
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                refs(x, &format!("{path}/{i}"), errs);
            }
        }
        Value::Object(o) => {
            if o.contains_key("kind")
                && o.contains_key("q")
                && let Some(card) = o.get("card")
            {
                let ok = match card {
                    Value::String(s) => ["one", "some", "any"].contains(&s.as_str()),
                    Value::Number(n) => n
                        .as_u64()
                        .is_some_and(|n| (1..=u64::from(u32::MAX)).contains(&n)),
                    _ => false,
                };
                if !ok {
                    errs.push(ValidationError::new(
                        "INVALID_CARDINALITY",
                        format!("{path}/card"),
                        format!("card {card} is not one, some, any or an integer >= 1"),
                        json!({ "field": path, "allowed": ["one", "some", "any", ">= 1"] }),
                    ));
                }
            }
            for (k, x) in o {
                if k == "capture" {
                    continue;
                }
                refs(x, &format!("{path}/{}", escape(k)), errs);
            }
        }
        _ => {}
    }
}
