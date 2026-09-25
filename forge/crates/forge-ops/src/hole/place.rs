//! Hole positions (SPEC §6.5 "Placement `at`").
//!
//! Positions are `(u, v)` coordinates in the placement plane's frame (§3.1: origin `o`, axes
//! `x`, `y`, normal `n = z`), `P = o + u·x + v·y`:
//! - `list`: the listed `(u, v)`, ids as listed;
//! - `grid`: id `g<i>_<j>` at `center + ((i − (nx−1)/2)·dx, (j − (ny−1)/2)·dy)`, in index
//!   order (`i` outer, `j` inner);
//! - `circle`: id `c<k>` at `center + (d/2)·(cos θ_k, sin θ_k)`, `θ_k = start + (360·k)/n`
//!   (degrees; sine and cosine by `forge_ir::v1::degtrig`);
//! - `points`: sketch points (resolved to 3D by the caller, in the order the feature names
//!   them) projected along `n` onto the plane.
//!
//! A `list` or `points` id used twice is `DUPLICATE_ID { id }` (a rejection re-checked for
//! documents that bypassed validation; checked first). Positions within `tol` of an earlier
//! one are `HOLE_DUPLICATE_POSITION` (the later id), [R-3]'s inclusive coincidence.
//!
//! Limits (engine, not SPEC): at most [`MAX_HOLE_POSITIONS`] positions
//! (`FORGE_HOLE_TOO_MANY_POSITIONS`, checked before any position is computed: the SPEC caps
//! each count at `MAX_COUNT_MAGNITUDE` = 2^31, so a grid could ask for 2^62), and every
//! position must be finite (`INVALID_VALUE` at the field that overflowed, e.g. a grid `dx`
//! of 1e308 with `nx` = 5).

use forge_core::linalg::{Frame, Point2, Point3};
use forge_ir::v1::{HolePlacement, LINEAR_TOLERANCE, degtrig};

use super::error::HoleError;
use super::spec::num;

/// The most positions one hole may have (an engine limit; see the module docs).
pub const MAX_HOLE_POSITIONS: usize = 10_000;

fn too_many(field: &str, n: u64) -> Result<(), HoleError> {
    if n > MAX_HOLE_POSITIONS as u64 {
        return Err(HoleError::TooManyPositions {
            field: field.into(),
            value: n as f64,
            max: MAX_HOLE_POSITIONS as f64,
        });
    }
    Ok(())
}

/// `INVALID_VALUE` for a position that is not finite: `u` and `v` with the fields (and their
/// values) that produced their offsets and centers, `(offset field, offset value, offset)`
/// and `(center field, center value)` per coordinate.
fn check_finite(
    p: &HolePos,
    u: (&str, f64, f64, &str, f64),
    v: (&str, f64, f64, &str, f64),
) -> Result<(), HoleError> {
    if p.point.is_finite() {
        return Ok(());
    }
    let (uu, vv) = (p.uv.x, p.uv.y);
    let blame_u = !uu.is_finite() || (vv.is_finite() && uu.abs() >= vv.abs());
    let (f_off, v_off, off, f_c, v_c) = if blame_u { u } else { v };
    let (field, value) = if !off.is_finite() || off.abs() >= v_c.abs() {
        (f_off, v_off)
    } else {
        (f_c, v_c)
    };
    Err(HoleError::InvalidValue {
        field: field.into(),
        value,
        expected: "a value giving a finite position".into(),
    })
}

/// One hole position.
#[derive(Clone, Debug, PartialEq)]
pub struct HolePos {
    /// The position id (names the instance and its faces, `H/wall@id`).
    pub id: String,
    /// `(u, v)` in the placement plane's frame.
    pub uv: Point2,
    /// The 3D point `P` on the placement plane.
    pub point: Point3,
}

fn count(field: &str, v: f64) -> Result<u32, HoleError> {
    // Exact comparison on purpose: counts are exact integers.
    #[allow(clippy::float_cmp)]
    let integral = v.is_finite() && v.trunc() == v;
    if !integral || v < 1.0 || v > f64::from(u32::MAX) {
        return Err(HoleError::InvalidCount {
            field: field.into(),
            value: v,
            expected: "an integer >= 1".into(),
        });
    }
    Ok(v as u32)
}

fn at(frame: &Frame, id: String, uv: Point2) -> HolePos {
    HolePos {
        id,
        uv,
        point: frame.origin() + frame.x() * uv.x + frame.y() * uv.y,
    }
}

/// The positions of a literal placement (see the module docs) on the plane `frame`.
/// `sketch_points`: for `points`, the named sketch points in 3D, in the feature's order.
///
/// Errors: `INVALID_COUNT` (grid `nx`, `ny`, bolt-circle `n` < 1 or not integers),
/// `INVALID_VALUE` (a bolt-circle `d` ≤ tol, an empty list, a `points` placement without
/// points, a position that is not finite), `FORGE_HOLE_TOO_MANY_POSITIONS` (more than
/// [`MAX_HOLE_POSITIONS`]), `DUPLICATE_ID` (a `list` or `points` id used twice: a
/// rejection, re-checked for documents that bypassed validation, before positions are
/// compared: two tools with one id would share their face keys `H/<role>@p`),
/// `HOLE_DUPLICATE_POSITION`.
pub fn hole_positions(
    at_: &HolePlacement,
    frame: &Frame,
    sketch_points: &[(String, Point3)],
) -> Result<Vec<HolePos>, HoleError> {
    let out: Vec<HolePos> = match at_ {
        HolePlacement::List(list) => {
            if list.is_empty() {
                return Err(HoleError::InvalidValue {
                    field: "/at/list".into(),
                    value: 0.0,
                    expected: "a non-empty list".into(),
                });
            }
            too_many("/at/list", list.len() as u64)?;
            list.iter()
                .enumerate()
                .map(|(k, p)| {
                    let (fu, fv) = (format!("/at/list/{k}/at/0"), format!("/at/list/{k}/at/1"));
                    let u = num(&p.at[0], &fu)?;
                    let v = num(&p.at[1], &fv)?;
                    let pos = at(frame, p.id.clone(), Point2::new(u, v));
                    check_finite(&pos, (&fu, u, u, &fu, u), (&fv, v, v, &fv, v))?;
                    Ok(pos)
                })
                .collect::<Result<_, HoleError>>()?
        }
        HolePlacement::Grid(g) => {
            let nx = count("/at/grid/nx", num(&g.nx, "/at/grid/nx")?)?;
            let ny = count("/at/grid/ny", num(&g.ny, "/at/grid/ny")?)?;
            let dx = num(&g.dx, "/at/grid/dx")?;
            let dy = num(&g.dy, "/at/grid/dy")?;
            let cx = num(&g.center[0], "/at/grid/center/0")?;
            let cy = num(&g.center[1], "/at/grid/center/1")?;
            too_many("/at/grid", u64::from(nx) * u64::from(ny))?;
            let mut v = Vec::new();
            for i in 0..nx {
                for j in 0..ny {
                    let ou = (f64::from(i) - f64::from(nx - 1) / 2.0) * dx;
                    let ow = (f64::from(j) - f64::from(ny - 1) / 2.0) * dy;
                    let pos = at(frame, format!("g{i}_{j}"), Point2::new(cx + ou, cy + ow));
                    check_finite(
                        &pos,
                        ("/at/grid/dx", dx, ou, "/at/grid/center/0", cx),
                        ("/at/grid/dy", dy, ow, "/at/grid/center/1", cy),
                    )?;
                    v.push(pos);
                }
            }
            v
        }
        HolePlacement::Circle(c) => {
            let n = count("/at/circle/n", num(&c.n, "/at/circle/n")?)?;
            let d = num(&c.d, "/at/circle/d")?;
            if !(d.is_finite() && d > LINEAR_TOLERANCE) {
                return Err(HoleError::InvalidValue {
                    field: "/at/circle/d".into(),
                    value: d,
                    expected: "> 1e-6 mm".into(),
                });
            }
            let cx = num(&c.center[0], "/at/circle/center/0")?;
            let cy = num(&c.center[1], "/at/circle/center/1")?;
            let start = num(&c.start, "/at/circle/start")?;
            too_many("/at/circle/n", u64::from(n))?;
            let mut v = Vec::new();
            for k in 0..n {
                let theta = start + (360.0 * f64::from(k)) / f64::from(n);
                let (s, co) =
                    degtrig::sin_cos_deg(theta).ok_or_else(|| HoleError::InvalidValue {
                        field: "/at/circle/start".into(),
                        value: start,
                        expected: "a finite angle".into(),
                    })?;
                let r = d / 2.0;
                let pos = at(frame, format!("c{k}"), Point2::new(cx + r * co, cy + r * s));
                check_finite(
                    &pos,
                    ("/at/circle/d", d, r, "/at/circle/center/0", cx),
                    ("/at/circle/d", d, r, "/at/circle/center/1", cy),
                )?;
                v.push(pos);
            }
            v
        }
        HolePlacement::Points(_) => {
            if sketch_points.is_empty() {
                return Err(HoleError::InvalidValue {
                    field: "/at/points/ids".into(),
                    value: 0.0,
                    expected: "at least one sketch point".into(),
                });
            }
            too_many("/at/points/ids", sketch_points.len() as u64)?;
            let (o, n) = (frame.origin(), frame.z());
            sketch_points
                .iter()
                .map(|(id, p)| {
                    let q = *p - n * (*p - o).dot(n);
                    let l = frame.to_local_point(q);
                    HolePos {
                        id: id.clone(),
                        uv: Point2::new(l.x, l.y),
                        point: q,
                    }
                })
                .collect()
        }
    };
    // Position ids are unique within the hole (SPEC §6.5 [W0-10]); grid and circle ids are
    // generated distinct.
    let id_field = |k: usize| match at_ {
        HolePlacement::List(_) => Some(format!("/at/list/{k}/id")),
        HolePlacement::Points(_) => Some(format!("/at/points/ids/{k}")),
        _ => None,
    };
    let mut ids = std::collections::BTreeSet::new();
    for (k, p) in out.iter().enumerate() {
        if !ids.insert(p.id.as_str()) {
            return Err(HoleError::DuplicateId {
                field: id_field(k).unwrap_or_else(|| "/at".into()),
                id: p.id.clone(),
            });
        }
    }
    for (k, p) in out.iter().enumerate() {
        if out[..k]
            .iter()
            .any(|q| q.point.distance(p.point) <= LINEAR_TOLERANCE)
        {
            return Err(HoleError::DuplicatePosition { at: p.id.clone() });
        }
    }
    Ok(out)
}
