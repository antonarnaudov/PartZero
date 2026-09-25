//! `convertSketch` (plan §2.2, §2.7 "Parametric intent"): an explicit sketch — what the agent
//! writes, `rect({ w: width, … })` — as an equivalent **constrained** sketch the sketcher can edit.
//!
//! - Compound curves expand into their members (SPEC-v1 §4.1). A constrained sketch's curve ids
//!   cannot contain `.`, so member `outline.bottom` becomes curve `outline_bottom`; the renames are
//!   returned for the command layer, which rewrites later references (`regions`, queries).
//! - Sizes and positions become **constraints bound to the same expressions**, so the parameters
//!   keep driving the geometry: a rect gets horizontals, verticals, its width and height as
//!   driving distances and its corner (or rounded corner's centre) pinned by a `fix` whose
//!   targets are the position expressions; a slot its tangencies, equal caps and radius; a
//!   polygon a construction circumcircle, equal sides and its first vertex pinned; plain curves a
//!   `fix` of every point (targets: its literal or expression coordinates), an arc's end by its
//!   chord, a circle's radius as a dimension. The converted sketch is exactly as determined as the
//!   explicit one (0 DOF); removing a `fix` frees a point.
//! - A composed expression (`(width) / 2`) that does not evaluate in the document's scope
//!   (a type rule, say) falls back to its evaluated number, with a note: never a wrong value.
//! - The literal geometry is the explicit sketch's own evaluated geometry, so the converted sketch
//!   solves at that geometry (SPEC-v1 §4.4 rule 4: it is a fixed point) — the report's geometry is
//!   the same before and after.

use std::collections::BTreeSet;

use forge_ir::v1::{Constraint, FieldType, LiteralCurve, Scalar, SketchCurve, SketchFeature, ids};

use crate::error::SketchError;
use crate::geometry::{evaluate_explicit, scalar};
use crate::session::sketch_curve;
use crate::values::ValueSource;

/// The result of [`convert_to_constrained`].
#[derive(Debug, Clone, PartialEq)]
pub struct Conversion {
    /// The constrained sketch (literal geometry, constraints bound to the expressions).
    pub sketch: SketchFeature,
    /// Member ids that became curve ids: `(outline.bottom, outline_bottom)`.
    pub renames: Vec<(String, String)>,
    /// What could not be kept parametric, for people.
    pub notes: Vec<String>,
}

/// A value to write into a constraint: a number or an expression text.
#[derive(Debug, Clone, PartialEq)]
enum Sv {
    Num(f64),
    Expr(String),
}

impl Sv {
    fn of(s: &Scalar) -> Sv {
        match s {
            Scalar::Num(x) => Sv::Num(*x),
            Scalar::Expr(t) => Sv::Expr(t.clone()),
        }
    }
    fn scalar(&self) -> Scalar {
        match self {
            Sv::Num(x) => Scalar::Num(*x + 0.0),
            Sv::Expr(t) => Scalar::Expr(t.clone()),
        }
    }
    fn is_expr(&self) -> bool {
        matches!(self, Sv::Expr(_))
    }
    /// The operand text for composing (numbers printed exactly, negatives parenthesized).
    fn text(&self) -> String {
        match self {
            Sv::Num(x) => format!("({x})"),
            Sv::Expr(t) => format!("({t})"),
        }
    }
}

struct Ctx<'a> {
    values: &'a dyn ValueSource,
    eval: &'a dyn Fn(&str, FieldType) -> Option<f64>,
    taken: BTreeSet<String>,
    notes: Vec<String>,
    constraints: Vec<Constraint>,
}

impl Ctx<'_> {
    fn id(&mut self, base: &str) -> String {
        let id = ids::unique(&ids::sanitize(base), &self.taken);
        self.taken.insert(id.clone());
        id
    }

    fn num(&self, path: String, s: &Scalar, field: FieldType) -> Result<f64, SketchError> {
        scalar(self.values, path, s, field)
    }

    /// `f(args)`: a number when every argument is one, else the expression `template(texts)`,
    /// checked by evaluation (falls back to `value`, the evaluated result, with a note).
    fn compose(
        &mut self,
        args: &[&Sv],
        value: f64,
        template: impl Fn(&[String]) -> String,
        what: &str,
    ) -> Sv {
        if !args.iter().any(|a| a.is_expr()) {
            return Sv::Num(value);
        }
        let texts: Vec<String> = args.iter().map(|a| a.text()).collect();
        let e = template(&texts);
        match (self.eval)(&e, FieldType::Length) {
            Some(v) if (v - value).abs() <= 1e-9 * value.abs().max(1.0) => Sv::Expr(e),
            _ => {
                self.notes.push(format!("{what} is kept as the number {value} (its expression could not be written as a constraint)"));
                Sv::Num(value)
            }
        }
    }

    fn push(&mut self, c: Constraint) {
        self.constraints.push(c);
    }

    fn fix_point(&mut self, owner: &str, point: &str, x: Sv, y: Sv) {
        let id = self.id(&format!("{owner}_fix"));
        self.push(Constraint::Fix {
            id,
            entity: point.to_string(),
            x: Some(x.scalar()),
            y: Some(y.scalar()),
        });
    }

    fn distance(&mut self, owner: &str, a: &str, b: &str, v: Sv) {
        let id = self.id(&format!("{owner}_d"));
        self.push(Constraint::Distance {
            id,
            a: a.to_string(),
            b: b.to_string(),
            value: Some(v.scalar()),
            driving: true,
        });
    }

    fn line_hv(&mut self, owner: &str, line: &str, horizontal: bool) {
        let id = self.id(&format!("{owner}_{}", if horizontal { "h" } else { "v" }));
        let line = line.to_string();
        self.push(if horizontal {
            Constraint::Horizontal { id, line }
        } else {
            Constraint::Vertical { id, line }
        });
    }

    fn pair(&mut self, owner: &str, kind: &str, a: &str, b: &str) {
        let id = self.id(&format!("{owner}_{kind}"));
        let (a, b) = (a.to_string(), b.to_string());
        self.push(match kind {
            "tan" => Constraint::Tangent {
                id,
                a,
                b,
                internal: None,
            },
            "eq" => Constraint::Equal { id, a, b },
            _ => Constraint::Coincident { id, a, b },
        });
    }
}

/// Convert an explicit sketch (see the module docs). `values` resolves the sketch's expression
/// sites; `eval` evaluates a composed expression text in the sketch's scope (`None` when it does
/// not evaluate).
pub fn convert_to_constrained(
    sketch: &SketchFeature,
    values: &dyn ValueSource,
    eval: &dyn Fn(&str, FieldType) -> Option<f64>,
) -> Result<Conversion, SketchError> {
    if !sketch.constraints.is_empty() {
        return Ok(Conversion {
            sketch: sketch.clone(),
            renames: Vec::new(),
            notes: Vec::new(),
        });
    }
    let lits = evaluate_explicit(sketch, values)?;
    let mut taken: BTreeSet<String> = sketch.curves.iter().map(|c| c.id().to_string()).collect();
    // Member ids → curve ids (unique among curves and the constraints to come).
    let mut renames: Vec<(String, String)> = Vec::new();
    let mut curves: Vec<LiteralCurve> = Vec::with_capacity(lits.len());
    for lc in &lits {
        let id = lc.id();
        if id.contains('.') {
            let new = ids::unique(&ids::sanitize(&id.replace('.', "_")), &taken);
            taken.insert(new.clone());
            renames.push((id.to_string(), new.clone()));
            curves.push(with_id(lc, &new));
        } else {
            curves.push(lc.clone());
        }
    }
    let renamed = |member: &str| -> Option<String> {
        renames
            .iter()
            .find(|(from, _)| from == member)
            .map(|(_, to)| to.clone())
    };

    let mut ctx = Ctx {
        values,
        eval,
        taken,
        notes: Vec::new(),
        constraints: Vec::new(),
    };
    let mut extra: Vec<LiteralCurve> = Vec::new();

    for (ci, c) in sketch.curves.iter().enumerate() {
        let cp = format!("/curves/{ci}");
        let id = c.id().to_string();
        let m = |name: &str| renamed(&format!("{id}.{name}"));
        match c {
            // Plain curves are pinned where the explicit sketch put them (bound to their
            // expressions), so the converted sketch is as determined as the explicit one; the
            // user frees a point by removing its `fix`.
            SketchCurve::Point { at, .. } => {
                ctx.fix_point(&id, &id, Sv::of(&at[0]), Sv::of(&at[1]));
            }
            SketchCurve::Line { start, end, .. } => {
                ctx.fix_point(
                    &id,
                    &format!("{id}.start"),
                    Sv::of(&start[0]),
                    Sv::of(&start[1]),
                );
                ctx.fix_point(&id, &format!("{id}.end"), Sv::of(&end[0]), Sv::of(&end[1]));
            }
            SketchCurve::Arc { start, center, .. } => {
                // Centre and start (2 + 2), then the end's angle by its chord to the start (1):
                // pinning the end too would repeat the arc rule (a redundant equation).
                ctx.fix_point(
                    &id,
                    &format!("{id}.center"),
                    Sv::of(&center[0]),
                    Sv::of(&center[1]),
                );
                ctx.fix_point(
                    &id,
                    &format!("{id}.start"),
                    Sv::of(&start[0]),
                    Sv::of(&start[1]),
                );
                let lc = curves.iter().find(|x| x.id() == id).cloned();
                if let Some(LiteralCurve::Arc {
                    start: s0, end: e0, ..
                }) = lc
                {
                    let chord = forge_core::math::hypot(e0[0] - s0[0], e0[1] - s0[1]);
                    if chord > forge_ir::v1::LINEAR_TOLERANCE {
                        ctx.distance(
                            &id,
                            &format!("{id}.start"),
                            &format!("{id}.end"),
                            Sv::Num(chord),
                        );
                    }
                }
            }
            SketchCurve::Circle { center, radius, .. } => {
                ctx.fix_point(
                    &id,
                    &format!("{id}.center"),
                    Sv::of(&center[0]),
                    Sv::of(&center[1]),
                );
                let rid = ctx.id(&format!("{id}_r"));
                ctx.push(Constraint::Radius {
                    id: rid,
                    curve: id.clone(),
                    value: Some(radius.clone()),
                    driving: true,
                });
            }
            SketchCurve::Rect {
                center,
                corner,
                w,
                h,
                r,
                ..
            } => {
                let (wv, hv, rv) = (
                    ctx.num(format!("{cp}/w"), w, FieldType::Length)?,
                    ctx.num(format!("{cp}/h"), h, FieldType::Length)?,
                    ctx.num(format!("{cp}/r"), r, FieldType::Length)?,
                );
                let (ws, hs, rs) = (Sv::of(w), Sv::of(h), Sv::of(r));
                // Lower-left corner x0, y0 (SPEC-v1 §4.1: the same operations as the expansion).
                let (x0s, y0s, x0, y0) = match (center, corner) {
                    (Some(cc), _) => {
                        let (cx, cy) = (
                            ctx.num(format!("{cp}/center/0"), &cc[0], FieldType::Length)?,
                            ctx.num(format!("{cp}/center/1"), &cc[1], FieldType::Length)?,
                        );
                        let (x0, y0) = (cx - wv / 2.0, cy - hv / 2.0);
                        let (a, b) = (Sv::of(&cc[0]), Sv::of(&cc[1]));
                        let x0s = ctx.compose(
                            &[&a, &ws],
                            x0,
                            |t| format!("{} - {} / 2", t[0], t[1]),
                            &format!("{id}'s position"),
                        );
                        let y0s = ctx.compose(
                            &[&b, &hs],
                            y0,
                            |t| format!("{} - {} / 2", t[0], t[1]),
                            &format!("{id}'s position"),
                        );
                        (x0s, y0s, x0, y0)
                    }
                    (None, Some(k)) => {
                        let (kx, ky) = (
                            ctx.num(format!("{cp}/corner/0"), &k[0], FieldType::Length)?,
                            ctx.num(format!("{cp}/corner/1"), &k[1], FieldType::Length)?,
                        );
                        (Sv::of(&k[0]), Sv::of(&k[1]), kx, ky)
                    }
                    (None, None) => (Sv::Num(0.0), Sv::Num(0.0), 0.0, 0.0),
                };
                if rv <= 0.0 {
                    let (b, rr, t, l) = (m("bottom"), m("right"), m("top"), m("left"));
                    if let (Some(b), Some(rr), Some(t), Some(l)) = (b, rr, t, l) {
                        ctx.line_hv(&id, &b, true);
                        ctx.line_hv(&id, &t, true);
                        ctx.line_hv(&id, &l, false);
                        ctx.line_hv(&id, &rr, false);
                        ctx.distance(&id, &format!("{b}.start"), &format!("{b}.end"), ws);
                        ctx.distance(&id, &format!("{rr}.start"), &format!("{rr}.end"), hs);
                        ctx.fix_point(&id, &format!("{b}.start"), x0s, y0s);
                    }
                } else {
                    let arcs = ["c_br", "c_tr", "c_tl", "c_bl"].map(m);
                    let [Some(c_br), Some(c_tr), Some(c_tl), Some(c_bl)] = arcs else {
                        ctx.notes.push(format!(
                            "{id}: rounded corners without arcs were not constrained"
                        ));
                        continue;
                    };
                    let order = [
                        "bottom", "c_br", "right", "c_tr", "top", "c_tl", "left", "c_bl",
                    ];
                    let present: Vec<(String, String)> = order
                        .iter()
                        .filter_map(|n| m(n).map(|x| ((*n).to_string(), x)))
                        .collect();
                    for (k, (name, curve)) in present.iter().enumerate() {
                        match name.as_str() {
                            "bottom" | "top" => ctx.line_hv(&id, curve, true),
                            "left" | "right" => ctx.line_hv(&id, curve, false),
                            _ => {}
                        }
                        // Tangency at each line–arc junction.
                        let (_, next) = &present[(k + 1) % present.len()];
                        let is_arc = |n: &str| n.starts_with("c_");
                        let next_name = &present[(k + 1) % present.len()].0;
                        if is_arc(name) != is_arc(next_name) {
                            ctx.pair(&id, "tan", curve, next);
                        }
                    }
                    for other in [&c_tr, &c_tl, &c_bl] {
                        ctx.pair(&id, "eq", &c_br, other);
                    }
                    let rid = ctx.id(&format!("{id}_r"));
                    ctx.push(Constraint::Radius {
                        id: rid,
                        curve: c_br.clone(),
                        value: Some(rs.scalar()),
                        driving: true,
                    });
                    // Width and height between the corner centres (coincident when they collapse).
                    let tol = forge_ir::v1::LINEAR_TOLERANCE;
                    let span = |ctx: &mut Ctx<'_>,
                                a: &str,
                                b: &str,
                                total: &Sv,
                                tv: f64,
                                what: &str| {
                        let v = tv - 2.0 * rv;
                        if v > tol {
                            let s = ctx.compose(
                                &[total, &rs],
                                v,
                                |t| format!("{} - 2 * {}", t[0], t[1]),
                                what,
                            );
                            ctx.distance(&id, &format!("{a}.center"), &format!("{b}.center"), s);
                        } else {
                            ctx.pair(&id, "con", &format!("{a}.center"), &format!("{b}.center"));
                        }
                    };
                    span(&mut ctx, &c_bl, &c_br, &ws, wv, &format!("{id}'s width"));
                    span(&mut ctx, &c_br, &c_tr, &hs, hv, &format!("{id}'s height"));
                    let cx = ctx.compose(
                        &[&x0s, &rs],
                        x0 + rv,
                        |t| format!("{} + {}", t[0], t[1]),
                        &format!("{id}'s position"),
                    );
                    let cy = ctx.compose(
                        &[&y0s, &rs],
                        y0 + rv,
                        |t| format!("{} + {}", t[0], t[1]),
                        &format!("{id}'s position"),
                    );
                    ctx.fix_point(&id, &format!("{c_bl}.center"), cx, cy);
                }
            }
            SketchCurve::Slot { a, b, w, .. } => {
                let parts = ["right", "cap_b", "left", "cap_a"].map(m);
                let [Some(right), Some(cap_b), Some(left), Some(cap_a)] = parts else {
                    continue;
                };
                ctx.pair(&id, "tan", &right, &cap_b);
                ctx.pair(&id, "tan", &left, &cap_b);
                ctx.pair(&id, "tan", &left, &cap_a);
                ctx.pair(&id, "tan", &right, &cap_a);
                ctx.pair(&id, "eq", &cap_a, &cap_b);
                let wv = ctx.num(format!("{cp}/w"), w, FieldType::Length)?;
                let ws = Sv::of(w);
                let r = ctx.compose(
                    &[&ws],
                    wv / 2.0,
                    |t| format!("{} / 2", t[0]),
                    &format!("{id}'s width"),
                );
                let rid = ctx.id(&format!("{id}_r"));
                ctx.push(Constraint::Radius {
                    id: rid,
                    curve: cap_a.clone(),
                    value: Some(r.scalar()),
                    driving: true,
                });
                ctx.fix_point(
                    &id,
                    &format!("{cap_a}.center"),
                    Sv::of(&a[0]),
                    Sv::of(&a[1]),
                );
                ctx.fix_point(
                    &id,
                    &format!("{cap_b}.center"),
                    Sv::of(&b[0]),
                    Sv::of(&b[1]),
                );
            }
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
                let nv = ctx.num(format!("{cp}/n"), n, FieldType::Count)?;
                if n.is_expr() {
                    ctx.notes.push(format!(
                        "{id} keeps {nv} sides: a converted polygon's side count is fixed"
                    ));
                }
                let edges: Vec<String> = (0..nv as usize)
                    .filter_map(|k| m(&format!("e{k}")))
                    .collect();
                if edges.len() < 3 {
                    continue;
                }
                // The circumradius, from whichever size the polygon was written with.
                let (size, field, formula): (&Scalar, &str, fn(&str, &str) -> String) =
                    if let Some(s) = circumradius {
                        (s, "circumradius", |s, _| s.to_string())
                    } else if let Some(s) = inradius {
                        (s, "inradius", |s, n| format!("{s} / cos(180 / {n})"))
                    } else if let Some(s) = across_flats {
                        (s, "across_flats", |s, n| {
                            format!("{s} / (2 * cos(180 / {n}))")
                        })
                    } else if let Some(s) = side {
                        (s, "side", |s, n| format!("{s} / (2 * sin(180 / {n}))"))
                    } else {
                        continue;
                    };
                let _ = ctx.num(format!("{cp}/{field}"), size, FieldType::Length)?;
                let (cx, cy) = (
                    ctx.num(format!("{cp}/center/0"), &center[0], FieldType::Length)?,
                    ctx.num(format!("{cp}/center/1"), &center[1], FieldType::Length)?,
                );
                // R and the first vertex from the evaluated geometry.
                let v0 = curves
                    .iter()
                    .find(|c| c.id() == edges[0])
                    .and_then(|c| match c {
                        LiteralCurve::Line { start, .. } => Some(*start),
                        _ => None,
                    })
                    .unwrap_or([cx, cy]);
                let rv = forge_core::math::hypot(v0[0] - cx, v0[1] - cy);
                let ns = Sv::Num(nv);
                let ss = Sv::of(size);
                let rsv = ctx.compose(
                    &[&ss, &ns],
                    rv,
                    |t| formula(&t[0], &t[1]),
                    &format!("{id}'s size"),
                );
                let circle = ctx.id(&format!("{id}_circle"));
                extra.push(LiteralCurve::Circle {
                    id: circle.clone(),
                    center: [cx, cy],
                    radius: rv,
                    construction: true,
                });
                ctx.fix_point(
                    &id,
                    &format!("{circle}.center"),
                    Sv::of(&center[0]),
                    Sv::of(&center[1]),
                );
                let rid = ctx.id(&format!("{id}_r"));
                ctx.push(Constraint::Radius {
                    id: rid,
                    curve: circle.clone(),
                    value: Some(rsv.scalar()),
                    driving: true,
                });
                for e in edges.iter().skip(1) {
                    let oid = ctx.id(&format!("{id}_on"));
                    ctx.push(Constraint::PointOnCircle {
                        id: oid,
                        point: format!("{e}.start"),
                        curve: circle.clone(),
                    });
                    ctx.pair(&id, "eq", &edges[0], e);
                }
                // The first vertex: on the circle at `rotation` (from the centre).
                let rot = Sv::of(rotation);
                let a = Sv::of(&center[0]);
                let b = Sv::of(&center[1]);
                let x = ctx.compose(
                    &[&a, &rsv, &rot],
                    v0[0],
                    |t| format!("{} + {} * cos({})", t[0], t[1], t[2]),
                    &format!("{id}'s first vertex"),
                );
                let y = ctx.compose(
                    &[&b, &rsv, &rot],
                    v0[1],
                    |t| format!("{} + {} * sin({})", t[0], t[1], t[2]),
                    &format!("{id}'s first vertex"),
                );
                ctx.fix_point(&id, &format!("{}.start", edges[0]), x, y);
            }
        }
    }

    curves.extend(extra);
    let mut out = sketch.clone();
    out.curves = curves.iter().map(sketch_curve).collect();
    out.constraints = ctx.constraints;
    Ok(Conversion {
        sketch: out,
        renames,
        notes: ctx.notes,
    })
}

fn with_id(lc: &LiteralCurve, id: &str) -> LiteralCurve {
    let mut c = lc.clone();
    match &mut c {
        LiteralCurve::Line { id: i, .. }
        | LiteralCurve::Arc { id: i, .. }
        | LiteralCurve::Circle { id: i, .. }
        | LiteralCurve::Point { id: i, .. } => *i = id.to_string(),
    }
    c
}

/// A sketch that needs [`convert_to_constrained`] before the session can edit it: an explicit
/// sketch with a compound curve or an expression coordinate.
pub fn needs_conversion(sketch: &SketchFeature) -> bool {
    sketch.constraints.is_empty()
        && sketch.curves.iter().any(|c| {
            c.is_compound()
                || match c {
                    SketchCurve::Line { start, end, .. } => {
                        start.iter().chain(end).any(Scalar::is_expr)
                    }
                    SketchCurve::Arc {
                        start, end, center, ..
                    } => start.iter().chain(end).chain(center).any(Scalar::is_expr),
                    SketchCurve::Circle { center, radius, .. } => {
                        center.iter().any(Scalar::is_expr) || radius.is_expr()
                    }
                    SketchCurve::Point { at, .. } => at.iter().any(Scalar::is_expr),
                    _ => false,
                }
        })
}

trait IsExpr {
    fn is_expr(&self) -> bool;
}

impl IsExpr for Scalar {
    fn is_expr(&self) -> bool {
        matches!(self, Scalar::Expr(_))
    }
}
