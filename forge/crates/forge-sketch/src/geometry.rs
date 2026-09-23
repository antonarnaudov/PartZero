//! Curve geometry: evaluation of explicit sketches (Scalars and compound curves → literal
//! curves), reading the stored guess of constrained sketches, and the v0 structural curve
//! checks (`DEGENERATE_CURVE`, `INCONSISTENT_ARC`) on computed values (SPEC-v1 §4.1, §4.2).

use forge_ir::P2;
use forge_ir::v1::compound::{self, Compound, PolygonSize};
use forge_ir::v1::{
    FieldType, LINEAR_TOLERANCE, LiteralCurve, SP2, Scalar, SketchCurve, SketchFeature,
};

use crate::error::SketchError;
use crate::values::{SiteRef, ValueSource};

/// Largest polygon side count Forge expands (an engine limit, `FORGE_LIMIT_EXCEEDED`).
///
/// SPEC-v1 §4.1 bounds `n` only by `MAX_COUNT_MAGNITUDE` (2^31); expanding that many members
/// would exhaust memory and the region stage is quadratic in the curve count. 4096 is also the
/// bound `forge_ir::v1::validate` uses to enumerate a literal polygon's member ids.
pub const MAX_POLYGON_SIDES: f64 = 4096.0;

/// Largest number of curves a sketch may have after compound expansion (points and
/// construction curves included): an engine limit, `FORGE_LIMIT_EXCEEDED`.
///
/// The SPEC sets no bound. The region stage (v0 §3) is quadratic in the curve count (four
/// 4096-gons took ~100 s in a debug build) and the solver's cost grows faster still, so a
/// sketch beyond this fails loudly instead of hanging the evaluation (and the WASM UI).
pub const MAX_SKETCH_CURVES: usize = 4096;

/// `|b − a|`, computed exactly as the IR crate's checks do (no fused operations).
pub(crate) fn dist(a: P2, b: P2) -> f64 {
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dy * dy).sqrt()
}

/// Evaluate one Scalar field: a literal as-is, an expression through `values`.
pub(crate) fn scalar(
    values: &dyn ValueSource,
    path: String,
    v: &Scalar,
    field: FieldType,
) -> Result<f64, SketchError> {
    let x = match v {
        Scalar::Num(x) => *x,
        Scalar::Expr(text) => match values.value(&SiteRef {
            path: &path,
            text,
            field,
        }) {
            None => return Err(SketchError::MissingValue { path }),
            Some(Err(error)) => return Err(SketchError::Value { path, error }),
            Some(Ok(x)) => x,
        },
    };
    if x.is_finite() {
        Ok(x)
    } else {
        Err(SketchError::NonFinite { path })
    }
}

fn point(values: &dyn ValueSource, path: &str, v: &SP2) -> Result<P2, SketchError> {
    Ok([
        scalar(values, format!("{path}/0"), &v[0], FieldType::Length)?,
        scalar(values, format!("{path}/1"), &v[1], FieldType::Length)?,
    ])
}

/// The v0 structural checks of one line, arc or circle with computed values (the same
/// rules and reasons as validation, SPEC-v1 §4.2). `check_arc_consistency` is `false` in
/// constrained mode, where the solver's arc rule restores it.
pub(crate) fn structural_check(
    c: &LiteralCurve,
    path: &str,
    check_arc_consistency: bool,
) -> Result<(), SketchError> {
    let tol = LINEAR_TOLERANCE;
    let degenerate = |reason: &'static str| SketchError::DegenerateCurve {
        curve: c.id().to_string(),
        path: path.to_string(),
        reason,
    };
    match c {
        LiteralCurve::Line { start, end, .. } => {
            if dist(*start, *end) <= tol {
                return Err(degenerate("zero-length line"));
            }
        }
        LiteralCurve::Arc {
            start, end, center, ..
        } => {
            let r0 = dist(*start, *center);
            let r1 = dist(*end, *center);
            if r0 <= tol || r1 <= tol {
                return Err(degenerate("zero-radius arc"));
            } else if check_arc_consistency && (r0 - r1).abs() > tol {
                return Err(SketchError::InconsistentArc {
                    curve: c.id().to_string(),
                    path: path.to_string(),
                    r_start: r0,
                    r_end: r1,
                });
            } else if dist(*start, *end) <= tol {
                return Err(degenerate("arc start == end; use a circle for a full turn"));
            }
        }
        LiteralCurve::Circle { radius, .. } => {
            if *radius <= tol {
                return Err(degenerate("circle radius must be > 0"));
            }
        }
        LiteralCurve::Point { .. } => {}
    }
    Ok(())
}

/// A curve after pass 1 of explicit mode: its Scalars evaluated, nothing checked yet.
enum Evaluated {
    /// A line, arc, circle or point with computed values.
    Literal(LiteralCurve),
    /// A compound curve with computed fields.
    Compound(Compound),
    /// A polygon without a size field (rejected by validation; re-checked defensively).
    PolygonWithoutSize,
}

/// Explicit mode (SPEC-v1 §4.2: "evaluate every Scalar, expand compound curves, then v0 §3").
/// Returns every curve with literal geometry, in curve order, compound curves replaced by
/// their members; points and construction curves included.
///
/// The checks run in two passes, and the first failure decides the error:
/// 1. every Scalar of every curve, in curve order and, within a curve, in field order
///    (expression errors, `NON_FINITE`, a missing value);
/// 2. in curve order: the structural checks of a line, arc or circle (`DEGENERATE_CURVE`,
///    `INCONSISTENT_ARC`) or the expansion of a compound curve (`INVALID_VALUE`,
///    `INVALID_COUNT`, `EXPR_NOT_INTEGER`, then the polygon limit `FORGE_LIMIT_EXCEEDED`), then
///    the sketch's curve limit ([`MAX_SKETCH_CURVES`], `FORGE_LIMIT_EXCEEDED`) on the running
///    count of evaluated curves.
pub(crate) fn evaluate_explicit(
    sketch: &SketchFeature,
    values: &dyn ValueSource,
) -> Result<Vec<LiteralCurve>, SketchError> {
    // Pass 1: every Scalar.
    let mut evaluated = Vec::with_capacity(sketch.curves.len());
    for (ci, c) in sketch.curves.iter().enumerate() {
        evaluated.push(evaluate_fields(c, &format!("/curves/{ci}"), values)?);
    }
    // Pass 2: checks and expansion.
    let mut out = Vec::with_capacity(sketch.curves.len());
    for (ci, (c, ev)) in sketch.curves.iter().zip(evaluated).enumerate() {
        let cp = format!("/curves/{ci}");
        match ev {
            Evaluated::Literal(lc) => {
                structural_check(&lc, &cp, true)?;
                out.push(lc);
            }
            Evaluated::Compound(compound) => {
                out.extend(expand(c, &cp, &compound, c.construction())?);
            }
            Evaluated::PolygonWithoutSize => {
                return Err(SketchError::Compound {
                    curve: c.id().to_string(),
                    path: cp,
                    expr: None,
                    error: Box::new(compound::CompoundError {
                        code: "INVALID_VALUE",
                        field: "circumradius",
                        value: f64::NAN,
                        expected: "exactly one of circumradius / inradius / across_flats / side"
                            .into(),
                    }),
                });
            }
        }
        curve_limit(out.len(), c.id())?;
    }
    Ok(out)
}

/// The sketch's curve limit: `FORGE_LIMIT_EXCEEDED` once more than [`MAX_SKETCH_CURVES`]
/// curves (after compound expansion) are evaluated; `curve` is the curve that crossed it.
pub(crate) fn curve_limit(count: usize, curve: &str) -> Result<(), SketchError> {
    if count > MAX_SKETCH_CURVES {
        return Err(SketchError::LimitExceeded {
            curve: curve.to_string(),
            path: "/curves".into(),
            field: "curves",
            value: count as f64,
            limit: MAX_SKETCH_CURVES as f64,
        });
    }
    Ok(())
}

/// Pass 1 for one curve: its Scalars in field order.
fn evaluate_fields(
    c: &SketchCurve,
    cp: &str,
    values: &dyn ValueSource,
) -> Result<Evaluated, SketchError> {
    let id = c.id().to_string();
    let construction = c.construction();
    let len = |name: &str, v: &Scalar| scalar(values, format!("{cp}/{name}"), v, FieldType::Length);
    Ok(match c {
        SketchCurve::Line { start, end, .. } => Evaluated::Literal(LiteralCurve::Line {
            id,
            start: point(values, &format!("{cp}/start"), start)?,
            end: point(values, &format!("{cp}/end"), end)?,
            construction,
        }),
        SketchCurve::Arc {
            start,
            end,
            center,
            ccw,
            ..
        } => Evaluated::Literal(LiteralCurve::Arc {
            id,
            start: point(values, &format!("{cp}/start"), start)?,
            end: point(values, &format!("{cp}/end"), end)?,
            center: point(values, &format!("{cp}/center"), center)?,
            ccw: *ccw,
            construction,
        }),
        SketchCurve::Circle { center, radius, .. } => Evaluated::Literal(LiteralCurve::Circle {
            id,
            center: point(values, &format!("{cp}/center"), center)?,
            radius: len("radius", radius)?,
            construction,
        }),
        SketchCurve::Point { at, .. } => Evaluated::Literal(LiteralCurve::Point {
            id,
            at: point(values, &format!("{cp}/at"), at)?,
            construction,
        }),
        SketchCurve::Rect {
            center,
            corner,
            w,
            h,
            r,
            ..
        } => {
            let center = match center {
                Some(p) => Some(point(values, &format!("{cp}/center"), p)?),
                None => None,
            };
            let corner = match corner {
                Some(p) => Some(point(values, &format!("{cp}/corner"), p)?),
                None => None,
            };
            Evaluated::Compound(Compound::Rect {
                center,
                corner,
                w: len("w", w)?,
                h: len("h", h)?,
                r: len("r", r)?,
            })
        }
        SketchCurve::Slot { a, b, w, .. } => Evaluated::Compound(Compound::Slot {
            a: point(values, &format!("{cp}/a"), a)?,
            b: point(values, &format!("{cp}/b"), b)?,
            w: len("w", w)?,
        }),
        SketchCurve::Polygon {
            center,
            n,
            circumradius,
            inradius,
            across_flats,
            side,
            rotation,
            ..
        } => {
            let center = point(values, &format!("{cp}/center"), center)?;
            let n = scalar(values, format!("{cp}/n"), n, FieldType::Count)?;
            // Exactly one size field (validation: CURVE_OPTIONS_CONFLICT); the first given
            // one wins defensively.
            let size = if let Some(v) = circumradius {
                Some(PolygonSize::Circumradius(len("circumradius", v)?))
            } else if let Some(v) = inradius {
                Some(PolygonSize::Inradius(len("inradius", v)?))
            } else if let Some(v) = across_flats {
                Some(PolygonSize::AcrossFlats(len("across_flats", v)?))
            } else if let Some(v) = side {
                Some(PolygonSize::Side(len("side", v)?))
            } else {
                None
            };
            let rotation = scalar(values, format!("{cp}/rotation"), rotation, FieldType::Angle)?;
            match size {
                Some(size) => Evaluated::Compound(Compound::Polygon {
                    center,
                    n,
                    size,
                    rotation,
                }),
                None => Evaluated::PolygonWithoutSize,
            }
        }
    })
}

/// `compound::expand` with the engine's polygon limit and errors mapped to fields.
fn expand(
    c: &SketchCurve,
    cp: &str,
    compound: &Compound,
    construction: bool,
) -> Result<Vec<LiteralCurve>, SketchError> {
    let id = c.id();
    let wrap = |error: compound::CompoundError| {
        // The field as a whole (a slot's coincident ends are reported on the point `b`).
        let field_path = format!("{cp}/{}", error.field);
        let expr = field_scalar(c, error.field)
            .and_then(Scalar::expr)
            .map(str::to_string);
        SketchError::Compound {
            curve: id.to_string(),
            path: field_path,
            expr,
            error: Box::new(error),
        }
    };
    if let Compound::Polygon { n, .. } = *compound
        && n.is_finite()
        && n.fract() == 0.0
        && n > MAX_POLYGON_SIDES
        && n.abs() <= forge_ir::v1::MAX_COUNT_MAGNITUDE
    {
        // Let the SPEC-defined size and rotation errors take precedence: they do not depend
        // on `n`, so probe them on a triangle before reporting the engine limit.
        let mut probe = compound.clone();
        if let Compound::Polygon { n, .. } = &mut probe {
            *n = 3.0;
        }
        compound::expand(id, &probe, construction).map_err(wrap)?;
        return Err(SketchError::LimitExceeded {
            curve: id.to_string(),
            path: format!("{cp}/n"),
            field: "n",
            value: n,
            limit: MAX_POLYGON_SIDES,
        });
    }
    compound::expand(id, compound, construction).map_err(wrap)
}

/// The Scalar a compound field name refers to (for the `expr` of error details).
fn field_scalar<'a>(c: &'a SketchCurve, field: &str) -> Option<&'a Scalar> {
    match (c, field) {
        (SketchCurve::Rect { w, .. }, "w") | (SketchCurve::Slot { w, .. }, "w") => Some(w),
        (SketchCurve::Rect { h, .. }, "h") => Some(h),
        (SketchCurve::Rect { r, .. }, "r") => Some(r),
        (SketchCurve::Polygon { n, .. }, "n") => Some(n),
        (SketchCurve::Polygon { rotation, .. }, "rotation") => Some(rotation),
        (SketchCurve::Polygon { circumradius, .. }, "circumradius") => circumradius.as_ref(),
        (SketchCurve::Polygon { inradius, .. }, "inradius") => inradius.as_ref(),
        (SketchCurve::Polygon { across_flats, .. }, "across_flats") => across_flats.as_ref(),
        (SketchCurve::Polygon { side, .. }, "side") => side.as_ref(),
        _ => None,
    }
}

/// Constrained mode: the stored guess as literal curves (SPEC-v1 §4.2: literal numbers
/// only, no compound curves — `SKETCH_MIXED_MODE` otherwise, re-checked defensively), with
/// `DEGENERATE_CURVE` checked on the stored values (`INCONSISTENT_ARC` is not: the solver's arc
/// rule restores it).
pub(crate) fn stored_geometry(sketch: &SketchFeature) -> Result<Vec<LiteralCurve>, SketchError> {
    let mut out = Vec::with_capacity(sketch.curves.len());
    for (ci, c) in sketch.curves.iter().enumerate() {
        let cp = format!("/curves/{ci}");
        let lit = |field: &str, v: &Scalar| -> Result<f64, SketchError> {
            match v {
                Scalar::Num(x) if x.is_finite() => Ok(*x),
                Scalar::Num(_) => Err(SketchError::NonFinite {
                    path: format!("{cp}/{field}"),
                }),
                Scalar::Expr(_) => Err(SketchError::MixedMode {
                    sketch: sketch.id.clone(),
                    path: format!("{cp}/{field}"),
                    what: "an expression",
                }),
            }
        };
        let lit2 = |field: &str, v: &SP2| -> Result<P2, SketchError> {
            Ok([
                lit(&format!("{field}/0"), &v[0])?,
                lit(&format!("{field}/1"), &v[1])?,
            ])
        };
        let id = c.id().to_string();
        let construction = c.construction();
        let lc = match c {
            SketchCurve::Line { start, end, .. } => LiteralCurve::Line {
                id,
                start: lit2("start", start)?,
                end: lit2("end", end)?,
                construction,
            },
            SketchCurve::Arc {
                start,
                end,
                center,
                ccw,
                ..
            } => LiteralCurve::Arc {
                id,
                start: lit2("start", start)?,
                end: lit2("end", end)?,
                center: lit2("center", center)?,
                ccw: *ccw,
                construction,
            },
            SketchCurve::Circle { center, radius, .. } => LiteralCurve::Circle {
                id,
                center: lit2("center", center)?,
                radius: lit("radius", radius)?,
                construction,
            },
            SketchCurve::Point { at, .. } => LiteralCurve::Point {
                id,
                at: lit2("at", at)?,
                construction,
            },
            SketchCurve::Rect { .. } | SketchCurve::Slot { .. } | SketchCurve::Polygon { .. } => {
                return Err(SketchError::MixedMode {
                    sketch: sketch.id.clone(),
                    path: cp,
                    what: "a compound curve",
                });
            }
        };
        structural_check(&lc, &cp, false)?;
        out.push(lc);
        curve_limit(out.len(), c.id())?;
    }
    Ok(out)
}

/// `true` for the curves that take part in loops and regions (SPEC-v1 §4.5): non-construction
/// lines, arcs and circles (compound members included).
pub(crate) fn is_profile(c: &LiteralCurve) -> bool {
    match c {
        LiteralCurve::Line { construction, .. }
        | LiteralCurve::Arc { construction, .. }
        | LiteralCurve::Circle { construction, .. } => !construction,
        LiteralCurve::Point { .. } => false,
    }
}
