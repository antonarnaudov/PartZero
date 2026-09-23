//! Normative compound-curve expansion (SPEC-v1 §4.1 [D-19]): `rect`, `slot` and `polygon`
//! expand into member curves `<id>.<member>`, evaluated in f64 exactly as written; a member of
//! length ≤ tol is omitted ([W0-6]: a line's length is `|end − start|`, an arc's is its chord).
//!
//! Inputs are **evaluated** values (literals, or W1's evaluation of the expressions). W2 calls
//! this from sketch evaluation; W0's conformance suite checks it against
//! `corpus/v1/conformance/compound/`.

use super::LINEAR_TOLERANCE;
use super::degtrig::{cos_deg, sin_cos_deg, sin_deg};
use super::sketch::LiteralCurve;
use crate::P2;

/// A compound curve with evaluated fields.
#[derive(Debug, Clone, PartialEq)]
pub enum Compound {
    /// `center` xor `corner` (lower-left).
    Rect {
        center: Option<P2>,
        corner: Option<P2>,
        w: f64,
        h: f64,
        r: f64,
    },
    Slot {
        a: P2,
        b: P2,
        w: f64,
    },
    Polygon {
        center: P2,
        n: f64,
        size: PolygonSize,
        rotation: f64,
    },
}

/// The one size field of a polygon.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PolygonSize {
    Circumradius(f64),
    Inradius(f64),
    AcrossFlats(f64),
    Side(f64),
}

impl PolygonSize {
    pub fn field(self) -> &'static str {
        match self {
            PolygonSize::Circumradius(_) => "circumradius",
            PolygonSize::Inradius(_) => "inradius",
            PolygonSize::AcrossFlats(_) => "across_flats",
            PolygonSize::Side(_) => "side",
        }
    }
    pub fn value(self) -> f64 {
        match self {
            PolygonSize::Circumradius(v)
            | PolygonSize::Inradius(v)
            | PolygonSize::AcrossFlats(v)
            | PolygonSize::Side(v) => v,
        }
    }
}

/// An invalid size (`INVALID_VALUE`, details `{ field, value, expected }`), or a count problem
/// (`INVALID_COUNT` / `EXPR_NOT_INTEGER` for a polygon's `n`).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{code}: {field} = {value}: expected {expected}")]
pub struct CompoundError {
    pub code: &'static str,
    pub field: &'static str,
    pub value: f64,
    pub expected: String,
}

fn bad(field: &'static str, value: f64, expected: impl Into<String>) -> CompoundError {
    CompoundError {
        code: "INVALID_VALUE",
        field,
        value,
        expected: expected.into(),
    }
}

fn dist(a: P2, b: P2) -> f64 {
    ((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])).sqrt()
}

fn line(id: &str, member: &str, start: P2, end: P2, construction: bool) -> Option<LiteralCurve> {
    (dist(start, end) > LINEAR_TOLERANCE).then(|| LiteralCurve::Line {
        id: format!("{id}.{member}"),
        start,
        end,
        construction,
    })
}

fn arc(
    id: &str,
    member: &str,
    center: P2,
    start: P2,
    end: P2,
    construction: bool,
) -> Option<LiteralCurve> {
    (dist(start, end) > LINEAR_TOLERANCE).then(|| LiteralCurve::Arc {
        id: format!("{id}.{member}"),
        start,
        end,
        center,
        ccw: true,
        construction,
    })
}

/// Expand a compound curve with id `id` into its member curves, in member-table order
/// (rect: bottom, c_br, right, c_tr, top, c_tl, left, c_bl; slot: right, cap_b, left, cap_a;
/// polygon: e0 … e(n−1)).
pub fn expand(
    id: &str,
    curve: &Compound,
    construction: bool,
) -> Result<Vec<LiteralCurve>, CompoundError> {
    let tol = LINEAR_TOLERANCE;
    let mut out = Vec::new();
    match *curve {
        Compound::Rect {
            center,
            corner,
            w,
            h,
            r,
        } => {
            if !(w.is_finite() && w > tol) {
                return Err(bad("w", w, format!("> {tol}")));
            }
            if !(h.is_finite() && h > tol) {
                return Err(bad("h", h, format!("> {tol}")));
            }
            let half_min = w.min(h) / 2.0;
            if !(r.is_finite() && r >= 0.0 && r <= half_min) {
                return Err(bad("r", r, format!("in [0, {half_min}] (min(w, h)/2)")));
            }
            let (x0, x1, y0, y1) = match (center, corner) {
                (Some(c), None) => (
                    c[0] - w / 2.0,
                    c[0] + w / 2.0,
                    c[1] - h / 2.0,
                    c[1] + h / 2.0,
                ),
                (None, Some(k)) => (k[0], k[0] + w, k[1], k[1] + h),
                _ => return Err(bad("center", f64::NAN, "exactly one of center / corner")),
            };
            let push = |out: &mut Vec<LiteralCurve>, c: Option<LiteralCurve>| out.extend(c);
            if r == 0.0 {
                push(
                    &mut out,
                    line(id, "bottom", [x0, y0], [x1, y0], construction),
                );
                push(
                    &mut out,
                    line(id, "right", [x1, y0], [x1, y1], construction),
                );
                push(&mut out, line(id, "top", [x1, y1], [x0, y1], construction));
                push(&mut out, line(id, "left", [x0, y1], [x0, y0], construction));
            } else {
                push(
                    &mut out,
                    line(id, "bottom", [x0 + r, y0], [x1 - r, y0], construction),
                );
                push(
                    &mut out,
                    arc(
                        id,
                        "c_br",
                        [x1 - r, y0 + r],
                        [x1 - r, y0],
                        [x1, y0 + r],
                        construction,
                    ),
                );
                push(
                    &mut out,
                    line(id, "right", [x1, y0 + r], [x1, y1 - r], construction),
                );
                push(
                    &mut out,
                    arc(
                        id,
                        "c_tr",
                        [x1 - r, y1 - r],
                        [x1, y1 - r],
                        [x1 - r, y1],
                        construction,
                    ),
                );
                push(
                    &mut out,
                    line(id, "top", [x1 - r, y1], [x0 + r, y1], construction),
                );
                push(
                    &mut out,
                    arc(
                        id,
                        "c_tl",
                        [x0 + r, y1 - r],
                        [x0 + r, y1],
                        [x0, y1 - r],
                        construction,
                    ),
                );
                push(
                    &mut out,
                    line(id, "left", [x0, y1 - r], [x0, y0 + r], construction),
                );
                push(
                    &mut out,
                    arc(
                        id,
                        "c_bl",
                        [x0 + r, y0 + r],
                        [x0, y0 + r],
                        [x0 + r, y0],
                        construction,
                    ),
                );
            }
        }
        Compound::Slot { a, b, w } => {
            let len = dist(a, b);
            if !(len.is_finite() && len > tol) {
                return Err(bad("b", len, format!("|b − a| > {tol}")));
            }
            if !(w.is_finite() && w > tol) {
                return Err(bad("w", w, format!("> {tol}")));
            }
            let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
            let m = [-d[1], d[0]];
            let h = w / 2.0;
            let a_minus = [a[0] - h * m[0], a[1] - h * m[1]];
            let a_plus = [a[0] + h * m[0], a[1] + h * m[1]];
            let b_minus = [b[0] - h * m[0], b[1] - h * m[1]];
            let b_plus = [b[0] + h * m[0], b[1] + h * m[1]];
            out.extend(line(id, "right", a_minus, b_minus, construction));
            out.extend(arc(id, "cap_b", b, b_minus, b_plus, construction));
            out.extend(line(id, "left", b_plus, a_plus, construction));
            out.extend(arc(id, "cap_a", a, a_plus, a_minus, construction));
        }
        Compound::Polygon {
            center,
            n,
            size,
            rotation,
        } => {
            if !n.is_finite() || n.fract() != 0.0 || n.abs() > super::MAX_COUNT_MAGNITUDE {
                return Err(CompoundError {
                    code: "EXPR_NOT_INTEGER",
                    field: "n",
                    value: n,
                    expected: "an exact integer".into(),
                });
            }
            if n < 3.0 {
                return Err(CompoundError {
                    code: "INVALID_COUNT",
                    field: "n",
                    value: n,
                    expected: ">= 3".into(),
                });
            }
            let s = size.value();
            if !(s.is_finite() && s > tol) {
                return Err(bad(size.field(), s, format!("> {tol}")));
            }
            if !rotation.is_finite() {
                return Err(bad("rotation", rotation, "finite"));
            }
            let half = 180.0 / n;
            let trig_err = || bad("n", n, "a finite polygon");
            let big_r = match size {
                PolygonSize::Circumradius(v) => v,
                PolygonSize::Inradius(v) => v / cos_deg(half).ok_or_else(trig_err)?,
                PolygonSize::AcrossFlats(v) => v / (2.0 * cos_deg(half).ok_or_else(trig_err)?),
                PolygonSize::Side(v) => v / (2.0 * sin_deg(half).ok_or_else(trig_err)?),
            };
            let count = n as usize;
            let mut pts = Vec::with_capacity(count);
            for k in 0..count {
                let theta = rotation + (360.0 * k as f64) / n;
                let (sn, cs) =
                    sin_cos_deg(theta).ok_or_else(|| bad("rotation", rotation, "finite"))?;
                pts.push([center[0] + big_r * cs, center[1] + big_r * sn]);
            }
            for k in 0..count {
                out.extend(line(
                    id,
                    &format!("e{k}"),
                    pts[k],
                    pts[(k + 1) % count],
                    construction,
                ));
            }
        }
    }
    Ok(out)
}

/// Every member suffix a compound kind can produce (for static `QUERY_UNKNOWN_CURVE` checks):
/// rect and slot members; for polygons `e0 … e(n−1)` (`n = None` when `n` is an expression:
/// every `e<k>` is then accepted).
pub fn member_names(kind: &str, n: Option<u32>) -> Vec<String> {
    match kind {
        "rect" => [
            "bottom", "c_br", "right", "c_tr", "top", "c_tl", "left", "c_bl",
        ]
        .map(String::from)
        .to_vec(),
        "slot" => ["right", "cap_b", "left", "cap_a"]
            .map(String::from)
            .to_vec(),
        "polygon" => (0..n.unwrap_or(0)).map(|k| format!("e{k}")).collect(),
        _ => Vec::new(),
    }
}
