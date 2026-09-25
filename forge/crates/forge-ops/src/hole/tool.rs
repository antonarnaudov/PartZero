//! Hole tool bodies (SPEC §6.5 "Geometry"): one solid of revolution per position.
//!
//! The tool at position `P` with drilling direction `d` is the 360° revolve of a profile in
//! the half-plane `(ρ ≥ 0, y)` spanned by a radial direction `e ⟂ d` and `d` (`y` = depth
//! along `d` from `P`), built with forge-ops' own `regions` and `revolve`. Profile curves
//! (their faces' roles; `R = D/2`):
//!
//! | Curve | From → to | Face |
//! |---|---|---|
//! | `top` | `(0, 0) → (R_top, 0)` | the disc at `P` (`R_top` = `Rc`, `Rk` or `R`) |
//! | `cbore_wall` | `(Rc, 0) → (Rc, hc)` | counterbore cylinder |
//! | `cbore_floor` | `(Rc, hc) → (R, hc)` | counterbore shoulder |
//! | `csink` | `(Rk, 0) → (R, hk)`, `hk = (Rk − R)/tan(β/2)` | countersink cone |
//! | `wall` | `(R, y0) → (R, h)` | the hole's cylinder |
//! | `tip` | `(R, h) → (0, h + R/tan(tip/2))` | drill-point cone (apex on the axis) |
//! | `floor` | `(R, h) → (0, h)` | flat floor (inserts, `up_to`, `tip: "flat"`) |
//! | `end` | `(R, L) → (0, L)` | the far end of a through tool (outside every target) |
//! | `axis` | back to `(0, 0)` | none (on the axis) |
//!
//! Faces are keyed `H/<role>@p` (SPEC §5.2: `wall`, `tip`, `floor`, `cbore_wall`,
//! `cbore_floor`, `csink`; `top` and `end` are this module's names for the two faces the SPEC
//! does not list — `top` survives only when the placement plane lies inside a target; `end`
//! never survives the hole itself, by construction, since the hole's through tool reaches
//! past its targets), edges `H/edge:{A|B}` between those faces. A through tool runs from `P`
//! to depth `L`, beyond the farthest point of the targets' boxes along `d` plus a margin
//! (`1 + 0.01·diag`; the SPEC only asks for "long enough to leave every target").
//!
//! A **pattern** copies the tool unchanged (SPEC §6.10), so a moved copy can end inside the
//! pattern's targets (a translation along `d`, a rotation or mirror that tilts `d`, thicker
//! targets). `apply_seed` checks every copy of a through tool and fails with
//! `FORGE_PATTERN_THROUGH_COPY_TOO_SHORT` instead of leaving the copy's `end` face as a
//! pocket floor.

use forge_core::Tolerance;
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::topo::{Body, Provenance, Role};
use forge_ir::{NamedPlane, PlaneSpec, SketchAxis, SketchCurve, SketchFeature, SweepDirection};

use super::error::HoleError;
use super::spec::{HoleSpec, Tip, tan_half_deg};
use crate::pattern::{Motion, move_body};
use crate::{regions, revolve};

/// The provenance of hole `feature`'s face `role` at position `at` (`H/<role>@p`).
pub fn hole_face_provenance(feature: &str, role: &str, at: &str) -> Provenance {
    Provenance::new(feature, Role::Other(role.into())).with_qualifier(at)
}

fn line(id: &str, a: (f64, f64), b: (f64, f64)) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: [a.0, a.1],
        end: [b.0, b.1],
    }
}

/// The profile curves of a tool reaching depth `h` (the shoulder of a blind hole, the far
/// end `L` of a through tool); `through` selects the `end` face.
fn profile(spec: &HoleSpec, h: f64, through: bool) -> Vec<SketchCurve> {
    let r = 0.5 * spec.d;
    let mut v = Vec::new();
    let y0 = if let Some((dc, hc)) = spec.cbore {
        let rc = 0.5 * dc;
        v.push(line("top", (0.0, 0.0), (rc, 0.0)));
        v.push(line("cbore_wall", (rc, 0.0), (rc, hc)));
        v.push(line("cbore_floor", (rc, hc), (r, hc)));
        hc
    } else if let Some((dk, beta)) = spec.csink {
        let rk = 0.5 * dk;
        let hk = (rk - r) / tan_half_deg(beta);
        v.push(line("top", (0.0, 0.0), (rk, 0.0)));
        v.push(line("csink", (rk, 0.0), (r, hk)));
        hk
    } else {
        v.push(line("top", (0.0, 0.0), (r, 0.0)));
        0.0
    };
    v.push(line("wall", (r, y0), (r, h)));
    let end = if through {
        v.push(line("end", (r, h), (0.0, h)));
        h
    } else {
        match spec.tip {
            Tip::Flat => {
                v.push(line("floor", (r, h), (0.0, h)));
                h
            }
            Tip::Angle(a) => {
                let apex = h + r / tan_half_deg(a);
                v.push(line("tip", (r, h), (0.0, apex)));
                apex
            }
        }
    };
    v.push(line("axis", (0.0, end), (0.0, 0.0)));
    v
}

/// The tool body of hole `spec` at `p` (position id `at`), drilling along the unit `d`, to
/// depth `h` (`through`: a through tool of length `h`), with `e` a unit vector
/// perpendicular to `d` (the profile's radial direction). Faces keyed `H/<role>@at`.
pub fn hole_tool(
    spec: &HoleSpec,
    at: &str,
    p: Point3,
    d: Vec3,
    e: Vec3,
    h: f64,
    through: bool,
) -> Result<Body, HoleError> {
    let fail = |reason: String| HoleError::Tool {
        at: at.into(),
        reason,
    };
    if spec.cbore.is_some() && spec.csink.is_some() {
        // `hole_spec` rejects this (HOLE_OPTIONS_CONFLICT); a hand-built spec must not lose
        // its countersink silently.
        return Err(fail("a counterbore and a countersink together".into()));
    }
    let sketch = SketchFeature {
        id: "hole_profile".into(),
        name: "hole_profile".into(),
        suppressed: false,
        plane: PlaneSpec::Named(NamedPlane::XY),
        curves: profile(spec, h, through),
    };
    let rs = regions(&sketch, &Tolerance::IR_DEFAULT)
        .map_err(|err| fail(format!("{}: {err}", err.code())))?;
    let [region] = rs.as_slice() else {
        return Err(fail(format!("the profile has {} regions", rs.len())));
    };
    // Sketch x = e (radial), sketch y = d (depth), normal e × d.
    let frame = Frame::from_normal_x(p, e.cross(d), e)
        .ok_or_else(|| fail("degenerate tool frame (e parallel to d)".into()))?;
    let axis = SketchAxis {
        origin: [0.0, 0.0],
        direction: [0.0, 1.0],
    };
    let body = revolve(
        region,
        &frame,
        &axis,
        360.0,
        SweepDirection::Normal,
        &spec.feature,
    )
    .map_err(|err| fail(format!("{}: {err}", err.code())))?;
    // Faces `H/side:<role>` → `H/<role>@at`; edge and vertex sources (face names) → keys.
    let key_of = |name: &str| -> Option<String> {
        let role = name.strip_prefix(&format!("{}/side:", spec.feature))?;
        Some(hole_face_provenance(&spec.feature, role, at).key())
    };
    let mut bad = None;
    let out = move_body(&body, &Motion::identity(), |_, prov| match prov.role {
        Role::Side => match prov.sources.first() {
            Some(role) => hole_face_provenance(&spec.feature, role, at),
            None => {
                bad.get_or_insert_with(|| "a side face without its curve".to_string());
                prov.clone()
            }
        },
        Role::EdgeBetween | Role::VertexAt => {
            let mut q = prov.clone();
            q.sources = prov
                .sources
                .iter()
                .map(|s| key_of(s).unwrap_or_else(|| s.clone()))
                .collect();
            q
        }
        _ => {
            bad.get_or_insert_with(|| format!("unexpected tool entity {}", prov.name()));
            prov.clone()
        }
    })
    .map_err(|err| fail(format!("{}: {err}", err.code())))?;
    if let Some(b) = bad {
        return Err(fail(b));
    }
    Ok(out)
}

/// Closed-form volume of a tool (mm³): cylinders `πR²·h`, cones `π·h·(R1² + R1·R2 + R2²)/3`.
pub fn tool_volume(spec: &HoleSpec, h: f64, through: bool) -> f64 {
    let pi = forge_core::math::PI;
    let r = 0.5 * spec.d;
    let frustum = |h: f64, a: f64, b: f64| pi * h * (a * a + a * b + b * b) / 3.0;
    let mut v = 0.0;
    let y0 = if let Some((dc, hc)) = spec.cbore {
        let rc = 0.5 * dc;
        v += pi * rc * rc * hc;
        hc
    } else if let Some((dk, beta)) = spec.csink {
        let rk = 0.5 * dk;
        let hk = (rk - r) / tan_half_deg(beta);
        v += frustum(hk, rk, r);
        hk
    } else {
        0.0
    };
    v += pi * r * r * (h - y0);
    if !through && let Tip::Angle(a) = spec.tip {
        v += frustum(r / tan_half_deg(a), r, 0.0);
    }
    v
}
