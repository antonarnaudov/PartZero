//! Human- and agent-readable explanations. Every sentence names the ids involved so an
//! agent can act on it; the structured fields of [`crate::SolveResult`] carry the same
//! facts in machine-readable form.

use std::collections::BTreeSet;
use std::fmt::Write;

use crate::model::{Constraint, ConstraintKind as K, Sketch};
use crate::result::{Conflict, EntityReport, Redundancy, SolveStatus, SolvedGeometry};

/// `id (kind args)`, e.g. `k3 (distance p0–p1 = 10)`.
pub fn describe(c: &Constraint) -> String {
    let body = match &c.kind {
        K::Coincident { a, b } => format!("coincident {a}, {b}"),
        K::Horizontal { line } => format!("horizontal {line}"),
        K::Vertical { line } => format!("vertical {line}"),
        K::Parallel { a, b } => format!("parallel {a} ∥ {b}"),
        K::Perpendicular { a, b } => format!("perpendicular {a} ⟂ {b}"),
        K::Tangent { a, b, .. } => format!("tangent {a}, {b}"),
        K::Equal { a, b } => format!("equal {a} = {b}"),
        K::Distance { a, b, value } => format!("distance {a}–{b} = {value}"),
        K::Angle { a, b, value } => format!("angle {a}→{b} = {value}°"),
        K::Radius { curve, value } => format!("radius {curve} = {value}"),
        K::Diameter { curve, value } => format!("diameter {curve} = {value}"),
        K::PointOnLine { point, line } => format!("{point} on line {line}"),
        K::PointOnCircle { point, curve } => format!("{point} on {curve}"),
        K::Midpoint { point, line } => format!("{point} midpoint of {line}"),
        K::Symmetric { a, b, line } => format!("{a}, {b} symmetric about {line}"),
        K::Fix { entity, .. } => format!("fix {entity}"),
    };
    let reference = if c.driving { "" } else { ", reference" };
    format!("{} ({body}{reference})", c.id)
}

fn list(items: impl IntoIterator<Item = String>) -> String {
    let v: Vec<String> = items.into_iter().collect();
    match v.len() {
        0 => String::new(),
        1 => v[0].clone(),
        _ => {
            let (last, rest) = v.split_last().expect("non-empty");
            format!("{} and {last}", rest.join(", "))
        }
    }
}

pub(crate) fn redundancy(
    sketch: &Sketch,
    c: usize,
    partial: bool,
    by: &BTreeSet<usize>,
    arcs: &[String],
    fixed_only: bool,
) -> String {
    let what = describe(&sketch.constraints[c]);
    let how = if partial {
        "is partially redundant (some of its equations are implied)"
    } else {
        "is redundant"
    };
    let mut sources: Vec<String> = by
        .iter()
        .map(|&k| describe(&sketch.constraints[k]))
        .collect();
    sources.extend(arcs.iter().map(|a| format!("the arc rule of {a}")));
    if fixed_only || sources.is_empty() {
        format!(
            "{what} {how}: it only involves fixed geometry, which already satisfies it. It can be deleted without changing the sketch."
        )
    } else {
        format!(
            "{what} {how}: it is implied by {}. It can be deleted without changing the sketch.",
            list(sources)
        )
    }
}

pub(crate) fn conflict(sketch: &Sketch, set: &[usize], fixed: &[String]) -> String {
    let latest = *set.last().expect("non-empty");
    let mut s = String::new();
    if set.len() == 1 {
        let _ = write!(
            s,
            "{} cannot be satisfied",
            describe(&sketch.constraints[latest])
        );
        if fixed.is_empty() {
            s.push('.');
        } else {
            let _ = write!(
                s,
                " by the fixed geometry ({}).",
                list(fixed.iter().cloned())
            );
        }
        let _ = write!(s, " Remove it or change its value.");
        return s;
    }
    let _ = write!(
        s,
        "These {} constraints cannot all hold at once: {}",
        set.len(),
        list(set.iter().map(|&c| describe(&sketch.constraints[c])))
    );
    if !fixed.is_empty() {
        let _ = write!(s, " (with fixed {})", list(fixed.iter().cloned()));
    }
    let _ = write!(
        s,
        ". Removing any one of them (or changing a dimension value) resolves this conflict; no smaller subset conflicts. Suggested: remove {} (the most recently added).",
        sketch.constraints[latest].id
    );
    s
}

pub(crate) fn summary(
    status: SolveStatus,
    dof: usize,
    entities: &[EntityReport],
    redundant: &[Redundancy],
    conflicts: &[Conflict],
    max_residual: f64,
) -> String {
    let free = || {
        let movers: Vec<String> = entities
            .iter()
            .filter(|e| {
                e.dof > 0
                    && matches!(
                        e.geometry,
                        SolvedGeometry::Point { .. } | SolvedGeometry::Circle { .. }
                    )
            })
            .map(|e| {
                let extra = match (&e.geometry, e.free_direction, e.radius_free) {
                    (_, Some(d), _) => format!(", along ({:.3}, {:.3})", d[0], d[1]),
                    (SolvedGeometry::Circle { .. }, _, Some(true)) => ", radius free".to_owned(),
                    _ => String::new(),
                };
                format!("{} ({} DOF{extra})", e.id, e.dof)
            })
            .collect();
        if movers.is_empty() {
            String::new()
        } else if movers.len() > 12 {
            format!(
                " Free to move: {}, … and {} more.",
                movers[..12].join(", "),
                movers.len() - 12
            )
        } else {
            format!(" Free to move: {}.", movers.join(", "))
        }
    };
    match status {
        SolveStatus::FullyConstrained => {
            "Fully constrained: every entity is determined (0 DOF).".to_owned()
        }
        SolveStatus::UnderConstrained => format!(
            "Under-constrained: {dof} degree{} of freedom remain{}.{}",
            if dof == 1 { "" } else { "s" },
            if dof == 1 { "s" } else { "" },
            free()
        ),
        SolveStatus::OverConstrainedRedundant => format!(
            "Solved, but {} constraint{} redundant: {}. {dof} DOF remain.{}",
            redundant.len(),
            if redundant.len() == 1 { " is" } else { "s are" },
            list(redundant.iter().map(|r| {
                if r.implied_by.is_empty() {
                    r.constraint.clone()
                } else {
                    format!("{} (implied by {})", r.constraint, r.implied_by.join(", "))
                }
            })),
            free()
        ),
        SolveStatus::Conflict => {
            let mut s = format!(
                "Conflict: {} minimal conflicting set{}; the geometry of the affected clusters is unchanged.",
                conflicts.len(),
                if conflicts.len() == 1 { "" } else { "s" }
            );
            for c in conflicts {
                let _ = write!(s, " {}", c.explanation);
            }
            s
        }
        SolveStatus::FailedToConverge => format!(
            "The solver did not converge (largest residual {max_residual:e} mm) and no conflicting subset could be isolated; the geometry of the affected clusters is unchanged. Try moving the geometry closer to the intended shape."
        ),
    }
}
