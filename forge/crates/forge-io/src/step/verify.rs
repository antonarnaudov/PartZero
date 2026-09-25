//! Our own check of a STEP B-rep file: structure, topology and geometry.
//!
//! [`verify_step`] parses the file ([`super::parse`]), rebuilds its geometry as Forge
//! surfaces and curves, and checks every solid:
//! - every reference resolves; units are millimetres and radians;
//! - every loop is closed (consecutive oriented edges share their vertices);
//! - in every closed shell, every edge is used exactly twice, in opposite directions
//!   (a seam twice by the same face);
//! - every vertex lies on its edges' curves, every edge runs along its curve in the
//!   direction `same_sense` says, and sampled points of every edge lie on the surfaces of
//!   the faces that use it, all within the file's uncertainty;
//! - every pcurve (`SURFACE_CURVE`) lies on the surface of a face that uses its edge and
//!   maps the edge's parameter onto the edge's points.
//!
//! The writer runs it on its own output ([`super::write_step`] refuses to return a file
//! that fails it), and tests run it on every exported corpus body. It does not replace
//! the OCCT oracle (which checks volumes, areas and validity independently).

use std::collections::BTreeMap;

use forge_core::geom::{
    Circle2, Circle3, Cone, Curve2, Curve3, Cylinder, Ellipse2, Ellipse3, Line2, Line3,
    NurbsCurve2, NurbsCurve3, NurbsSurface, Plane, Sphere, SpindlePatch, Surface, Torus,
};
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::math;

use super::StepError;
use super::parse::{Instance, P21File, Record, Value, parse};

/// What a verified file contains.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StepSummary {
    /// `FILE_SCHEMA` names.
    pub schemas: Vec<String>,
    /// Number of data instances.
    pub entities: usize,
    /// The file's distance uncertainty (mm).
    pub uncertainty: f64,
    /// The solids, in the order the representation lists them.
    pub solids: Vec<SolidSummary>,
}

/// One solid of a verified file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SolidSummary {
    /// Its name.
    pub name: String,
    /// Closed shells (outer and voids).
    pub shells: usize,
    /// Faces.
    pub faces: usize,
    /// Distinct edges.
    pub edges: usize,
    /// Distinct vertices.
    pub vertices: usize,
    /// Edges used twice by the same face (seams).
    pub seam_edges: usize,
    /// Face count per surface entity name.
    pub face_types: BTreeMap<String, usize>,
}

fn fail(detail: impl Into<String>) -> StepError {
    StepError::SelfCheck {
        detail: detail.into(),
    }
}

struct File {
    f: P21File,
    /// Plane angle unit in radians.
    angle: f64,
}

impl File {
    fn inst(&self, id: u64) -> Result<&Instance, StepError> {
        self.f
            .data
            .get(&id)
            .ok_or_else(|| fail(format!("#{id} is referenced but not defined")))
    }
    /// The simple record `#id`, which must be `name`.
    fn rec(&self, id: u64, names: &[&str]) -> Result<&Record, StepError> {
        match self.inst(id)? {
            Instance::Simple(r) if names.contains(&r.name.as_str()) => Ok(r),
            i => Err(fail(format!(
                "#{id} is {:?}, expected one of {names:?}",
                i.names()
            ))),
        }
    }
    fn arg<'r>(&self, r: &'r Record, k: usize) -> Result<&'r Value, StepError> {
        r.args
            .get(k)
            .ok_or_else(|| fail(format!("{} has too few parameters", r.name)))
    }
    fn reff(&self, r: &Record, k: usize) -> Result<u64, StepError> {
        self.arg(r, k)?
            .as_ref()
            .ok_or_else(|| fail(format!("{} parameter {k} is not a reference", r.name)))
    }
    fn num(&self, r: &Record, k: usize) -> Result<f64, StepError> {
        let x = self
            .arg(r, k)?
            .as_f64()
            .ok_or_else(|| fail(format!("{} parameter {k} is not a number", r.name)))?;
        if x.is_finite() {
            Ok(x)
        } else {
            Err(fail(format!("{} parameter {k} is not finite", r.name)))
        }
    }
    fn boolean(&self, r: &Record, k: usize) -> Result<bool, StepError> {
        self.arg(r, k)?
            .as_bool()
            .ok_or_else(|| fail(format!("{} parameter {k} is not .T./.F.", r.name)))
    }
    fn list<'r>(&self, r: &'r Record, k: usize) -> Result<&'r [Value], StepError> {
        self.arg(r, k)?
            .as_list()
            .ok_or_else(|| fail(format!("{} parameter {k} is not a list", r.name)))
    }
    fn refs(&self, r: &Record, k: usize) -> Result<Vec<u64>, StepError> {
        self.list(r, k)?
            .iter()
            .map(|v| {
                v.as_ref()
                    .ok_or_else(|| fail(format!("{} parameter {k} holds a non-reference", r.name)))
            })
            .collect()
    }
    fn reals(&self, v: &Value) -> Result<Vec<f64>, StepError> {
        v.as_list()
            .ok_or_else(|| fail("expected a list of numbers"))?
            .iter()
            .map(|x| x.as_f64().ok_or_else(|| fail("expected a number")))
            .collect()
    }
    fn ints(&self, v: &Value) -> Result<Vec<usize>, StepError> {
        v.as_list()
            .ok_or_else(|| fail("expected a list of integers"))?
            .iter()
            .map(|x| match x {
                Value::Int(i) if *i >= 0 => Ok(*i as usize),
                _ => Err(fail("expected a non-negative integer")),
            })
            .collect()
    }

    fn point(&self, id: u64) -> Result<Point3, StepError> {
        let r = self.rec(id, &["CARTESIAN_POINT"])?;
        let c = self.reals(self.arg(r, 1)?)?;
        match c.as_slice() {
            [x, y, z] if x.is_finite() && y.is_finite() && z.is_finite() => {
                Ok(Vec3::new(*x, *y, *z))
            }
            _ => Err(fail(format!("#{id} is not a finite 3D point"))),
        }
    }
    fn direction(&self, id: u64) -> Result<Vec3, StepError> {
        let r = self.rec(id, &["DIRECTION"])?;
        let c = self.reals(self.arg(r, 1)?)?;
        match c.as_slice() {
            [x, y, z] => Vec3::new(*x, *y, *z)
                .normalize()
                .ok_or_else(|| fail(format!("#{id} is a zero direction"))),
            _ => Err(fail(format!("#{id} is not a 3D direction"))),
        }
    }
    fn frame(&self, id: u64) -> Result<Frame, StepError> {
        let r = self.rec(id, &["AXIS2_PLACEMENT_3D"])?;
        let o = self.point(self.reff(r, 1)?)?;
        let z = match self.arg(r, 2)? {
            Value::Unset => Vec3::unit_z(),
            v => self.direction(v.as_ref().ok_or_else(|| fail("bad axis"))?)?,
        };
        let x = match self.arg(r, 3)? {
            Value::Unset => z.any_perpendicular().unwrap_or(Vec3::unit_x()),
            v => self.direction(v.as_ref().ok_or_else(|| fail("bad ref_direction"))?)?,
        };
        Frame::from_normal_x(o, z, x).ok_or_else(|| fail(format!("#{id} has parallel axes")))
    }

    fn surface(&self, id: u64) -> Result<(String, Surface), StepError> {
        let geom = |e: forge_core::geom::GeomError| fail(format!("#{id}: {e}"));
        match self.inst(id)? {
            Instance::Simple(r) => {
                let s = match r.name.as_str() {
                    "PLANE" => Surface::Plane(Plane::new(self.frame(self.reff(r, 1)?)?)),
                    "CYLINDRICAL_SURFACE" => Surface::Cylinder(
                        Cylinder::new(self.frame(self.reff(r, 1)?)?, self.num(r, 2)?)
                            .map_err(geom)?,
                    ),
                    "CONICAL_SURFACE" => Surface::Cone(
                        Cone::new(
                            self.frame(self.reff(r, 1)?)?,
                            self.num(r, 2)?,
                            self.num(r, 3)? * self.angle,
                        )
                        .map_err(geom)?,
                    ),
                    "SPHERICAL_SURFACE" => Surface::Sphere(
                        Sphere::new(self.frame(self.reff(r, 1)?)?, self.num(r, 2)?)
                            .map_err(geom)?,
                    ),
                    "TOROIDAL_SURFACE" => Surface::Torus(
                        Torus::new(
                            self.frame(self.reff(r, 1)?)?,
                            self.num(r, 2)?,
                            self.num(r, 3)?,
                        )
                        .map_err(geom)?,
                    ),
                    "DEGENERATE_TOROIDAL_SURFACE" => {
                        let patch = if self.boolean(r, 4)? {
                            SpindlePatch::Outer
                        } else {
                            SpindlePatch::Inner
                        };
                        Surface::Torus(
                            Torus::spindle(
                                self.frame(self.reff(r, 1)?)?,
                                self.num(r, 2)?,
                                self.num(r, 3)?,
                                patch,
                            )
                            .map_err(geom)?,
                        )
                    }
                    "B_SPLINE_SURFACE_WITH_KNOTS" => {
                        let k = r
                            .args
                            .get(8..)
                            .ok_or_else(|| fail(format!("#{id}: too few parameters")))?;
                        Surface::BSpline(self.bspline_surface(r, k, None)?)
                    }
                    other => return Err(fail(format!("#{id}: unsupported surface {other}"))),
                };
                Ok((r.name.clone(), s))
            }
            Instance::Complex(_) => {
                let i = self.inst(id)?;
                let base = i
                    .record("B_SPLINE_SURFACE")
                    .ok_or_else(|| fail(format!("#{id}: unsupported complex surface")))?;
                let knots = i
                    .record("B_SPLINE_SURFACE_WITH_KNOTS")
                    .ok_or_else(|| fail(format!("#{id}: B-spline surface without knots")))?;
                let w = i
                    .record("RATIONAL_B_SPLINE_SURFACE")
                    .map(|r| self.arg(r, 0).cloned())
                    .transpose()?;
                // Re-assemble the parameters as a simple B_SPLINE_SURFACE_WITH_KNOTS.
                let mut args = vec![Value::Str(String::new())];
                args.extend(base.args.iter().cloned());
                let rec = Record {
                    name: "B_SPLINE_SURFACE_WITH_KNOTS".into(),
                    args,
                };
                let s = self.bspline_surface(&rec, &knots.args, w.as_ref())?;
                Ok(("B_SPLINE_SURFACE_WITH_KNOTS".into(), Surface::BSpline(s)))
            }
        }
    }

    /// `r` holds `(name, du, dv, points, form, uc, vc, si, …)`; `k` the knot data
    /// `(umults, vmults, uknots, vknots, spec)`.
    fn bspline_surface(
        &self,
        r: &Record,
        k: &[Value],
        w: Option<&Value>,
    ) -> Result<NurbsSurface, StepError> {
        let int = |v: &Value| match v {
            Value::Int(i) if *i > 0 => Ok(*i as usize),
            _ => Err(fail("bad B-spline degree")),
        };
        let du = int(self.arg(r, 1)?)?;
        let dv = int(self.arg(r, 2)?)?;
        let rows = self.list(r, 3)?;
        let nu = rows.len();
        let mut ctrl = Vec::new();
        let mut nv = 0;
        for row in rows {
            let row = row.as_list().ok_or_else(|| fail("bad control net"))?;
            nv = row.len();
            for p in row {
                ctrl.push(self.point(p.as_ref().ok_or_else(|| fail("bad control point"))?)?);
            }
        }
        if k.len() < 4 {
            return Err(fail("B-spline surface knot data missing"));
        }
        let expand = |mults: &[usize], vals: &[f64]| -> Vec<f64> {
            mults
                .iter()
                .zip(vals)
                .flat_map(|(&m, &v)| std::iter::repeat_n(v, m))
                .collect()
        };
        let ku = expand(&self.ints(&k[0])?, &self.reals(&k[2])?);
        let kv = expand(&self.ints(&k[1])?, &self.reals(&k[3])?);
        let weights = match w {
            Some(v) => {
                let mut out = Vec::new();
                for row in v.as_list().ok_or_else(|| fail("bad weights"))? {
                    out.extend(self.reals(row)?);
                }
                Some(out)
            }
            None => None,
        };
        NurbsSurface::new(du, dv, ku, kv, nu, nv, ctrl, weights)
            .map_err(|e| fail(format!("B-spline surface: {e}")))
    }

    /// The 3D curve of an `EDGE_CURVE`'s geometry (a curve, or a `SURFACE_CURVE` /
    /// `SEAM_CURVE`'s `curve_3d`).
    fn edge_curve(&self, id: u64) -> Result<Curve3, StepError> {
        match self.inst(id)?.simple_name() {
            Some("SURFACE_CURVE" | "SEAM_CURVE") => {
                let r = self.rec(id, &["SURFACE_CURVE", "SEAM_CURVE"])?;
                self.curve(self.reff(r, 1)?)
            }
            _ => self.curve(id),
        }
    }

    /// The pcurves of an `EDGE_CURVE`'s geometry (none for a plain curve).
    fn pcurves(&self, id: u64) -> Result<Vec<(u64, Curve2)>, StepError> {
        let Some("SURFACE_CURVE" | "SEAM_CURVE") = self.inst(id)?.simple_name() else {
            return Ok(Vec::new());
        };
        let r = self.rec(id, &["SURFACE_CURVE", "SEAM_CURVE"])?;
        let mut out = Vec::new();
        for pid in self.refs(r, 2)? {
            let pr = self.rec(pid, &["PCURVE"])?;
            let basis = self.reff(pr, 1)?;
            let dr = self.rec(self.reff(pr, 2)?, &["DEFINITIONAL_REPRESENTATION"])?;
            let items = self.refs(dr, 1)?;
            let [c2] = items.as_slice() else {
                return Err(fail(format!("#{pid}: a pcurve must hold one 2D curve")));
            };
            out.push((basis, self.curve2d(*c2)?));
        }
        Ok(out)
    }

    fn point2(&self, id: u64) -> Result<forge_core::linalg::Vec2, StepError> {
        let r = self.rec(id, &["CARTESIAN_POINT"])?;
        match self.reals(self.arg(r, 1)?)?.as_slice() {
            [x, y] if x.is_finite() && y.is_finite() => Ok(forge_core::linalg::Vec2::new(*x, *y)),
            _ => Err(fail(format!("#{id} is not a finite 2D point"))),
        }
    }

    fn direction2(&self, id: u64) -> Result<forge_core::linalg::Vec2, StepError> {
        let r = self.rec(id, &["DIRECTION"])?;
        match self.reals(self.arg(r, 1)?)?.as_slice() {
            [x, y] => forge_core::linalg::Vec2::new(*x, *y)
                .normalize()
                .ok_or_else(|| fail(format!("#{id} is a zero direction"))),
            _ => Err(fail(format!("#{id} is not a 2D direction"))),
        }
    }

    /// A 2D curve of a pcurve: line, circle, ellipse or (rational) B-spline.
    fn curve2d(&self, id: u64) -> Result<Curve2, StepError> {
        let geom = |e: forge_core::geom::GeomError| fail(format!("#{id}: {e}"));
        let placement =
            |aid: u64| -> Result<(forge_core::linalg::Vec2, forge_core::linalg::Vec2), StepError> {
                let a = self.rec(aid, &["AXIS2_PLACEMENT_2D"])?;
                let o = self.point2(self.reff(a, 1)?)?;
                let x = match self.arg(a, 2)? {
                    Value::Unset => forge_core::linalg::Vec2::unit_x(),
                    v => self.direction2(v.as_ref().ok_or_else(|| fail("bad ref_direction"))?)?,
                };
                Ok((o, x))
            };
        match self.inst(id)? {
            Instance::Simple(r) => Ok(match r.name.as_str() {
                "LINE" => {
                    let p = self.point2(self.reff(r, 1)?)?;
                    let v = self.rec(self.reff(r, 2)?, &["VECTOR"])?;
                    let d = self.direction2(self.reff(v, 1)?)?;
                    let m = self.num(v, 2)?;
                    if m <= 0.0 {
                        return Err(fail(format!("#{id}: non-positive vector magnitude")));
                    }
                    Curve2::Line(Line2::new(p, d * m).map_err(geom)?)
                }
                "CIRCLE" => {
                    let (o, x) = placement(self.reff(r, 1)?)?;
                    if (x.x - 1.0).abs() > 1e-12 || x.y.abs() > 1e-12 {
                        return Err(fail(format!("#{id}: a turned 2D circle is not supported")));
                    }
                    Curve2::Circle(Circle2::new(o, self.num(r, 2)?).map_err(geom)?)
                }
                "ELLIPSE" => {
                    let (o, x) = placement(self.reff(r, 1)?)?;
                    Curve2::Ellipse(
                        Ellipse2::new(o, x, self.num(r, 2)?, self.num(r, 3)?).map_err(geom)?,
                    )
                }
                "B_SPLINE_CURVE_WITH_KNOTS" => {
                    let k = r
                        .args
                        .get(6..)
                        .ok_or_else(|| fail(format!("#{id}: too few parameters")))?;
                    Curve2::BSpline(self.bspline_curve2(r, k, None)?)
                }
                other => return Err(fail(format!("#{id}: unsupported 2D curve {other}"))),
            }),
            Instance::Complex(_) => {
                let i = self.inst(id)?;
                let base = i
                    .record("B_SPLINE_CURVE")
                    .ok_or_else(|| fail(format!("#{id}: unsupported complex 2D curve")))?;
                let knots = i
                    .record("B_SPLINE_CURVE_WITH_KNOTS")
                    .ok_or_else(|| fail(format!("#{id}: B-spline curve without knots")))?;
                let w = i
                    .record("RATIONAL_B_SPLINE_CURVE")
                    .map(|r| self.arg(r, 0).cloned())
                    .transpose()?;
                let mut args = vec![Value::Str(String::new())];
                args.extend(base.args.iter().cloned());
                let rec = Record {
                    name: "B_SPLINE_CURVE_WITH_KNOTS".into(),
                    args,
                };
                Ok(Curve2::BSpline(self.bspline_curve2(
                    &rec,
                    &knots.args,
                    w.as_ref(),
                )?))
            }
        }
    }

    fn bspline_curve2(
        &self,
        r: &Record,
        k: &[Value],
        w: Option<&Value>,
    ) -> Result<NurbsCurve2, StepError> {
        let p = match self.arg(r, 1)? {
            Value::Int(i) if *i > 0 => *i as usize,
            _ => return Err(fail("bad B-spline degree")),
        };
        let pts: Vec<[f64; 2]> = self
            .refs(r, 2)?
            .into_iter()
            .map(|id| self.point2(id).map(|q| [q.x, q.y]))
            .collect::<Result<_, _>>()?;
        if k.len() < 2 {
            return Err(fail("B-spline curve knot data missing"));
        }
        let knots: Vec<f64> = self
            .ints(&k[0])?
            .iter()
            .zip(self.reals(&k[1])?)
            .flat_map(|(&m, v)| std::iter::repeat_n(v, m))
            .collect();
        let weights = w.map(|v| self.reals(v)).transpose()?;
        NurbsCurve2::new(p, knots, pts, weights).map_err(|e| fail(format!("B-spline curve: {e}")))
    }

    fn curve(&self, id: u64) -> Result<Curve3, StepError> {
        let geom = |e: forge_core::geom::GeomError| fail(format!("#{id}: {e}"));
        match self.inst(id)? {
            Instance::Simple(r) => Ok(match r.name.as_str() {
                "LINE" => {
                    let p = self.point(self.reff(r, 1)?)?;
                    let v = self.rec(self.reff(r, 2)?, &["VECTOR"])?;
                    let d = self.direction(self.reff(v, 1)?)?;
                    if self.num(v, 2)? <= 0.0 {
                        return Err(fail(format!("#{id}: non-positive vector magnitude")));
                    }
                    Curve3::Line(Line3::new(p, d).map_err(geom)?)
                }
                "CIRCLE" => Curve3::Circle(
                    Circle3::new(self.frame(self.reff(r, 1)?)?, self.num(r, 2)?).map_err(geom)?,
                ),
                "ELLIPSE" => Curve3::Ellipse(
                    Ellipse3::new(
                        self.frame(self.reff(r, 1)?)?,
                        self.num(r, 2)?,
                        self.num(r, 3)?,
                    )
                    .map_err(geom)?,
                ),
                "B_SPLINE_CURVE_WITH_KNOTS" => {
                    let k = r
                        .args
                        .get(6..)
                        .ok_or_else(|| fail(format!("#{id}: too few parameters")))?;
                    Curve3::BSpline(self.bspline_curve(r, k, None)?)
                }
                other => return Err(fail(format!("#{id}: unsupported curve {other}"))),
            }),
            Instance::Complex(_) => {
                let i = self.inst(id)?;
                let base = i
                    .record("B_SPLINE_CURVE")
                    .ok_or_else(|| fail(format!("#{id}: unsupported complex curve")))?;
                let knots = i
                    .record("B_SPLINE_CURVE_WITH_KNOTS")
                    .ok_or_else(|| fail(format!("#{id}: B-spline curve without knots")))?;
                let w = i
                    .record("RATIONAL_B_SPLINE_CURVE")
                    .map(|r| self.arg(r, 0).cloned())
                    .transpose()?;
                let mut args = vec![Value::Str(String::new())];
                args.extend(base.args.iter().cloned());
                let rec = Record {
                    name: "B_SPLINE_CURVE_WITH_KNOTS".into(),
                    args,
                };
                Ok(Curve3::BSpline(self.bspline_curve(
                    &rec,
                    &knots.args,
                    w.as_ref(),
                )?))
            }
        }
    }

    /// `r` holds `(name, degree, points, form, closed, si, …)`; `k` `(mults, knots, spec)`.
    fn bspline_curve(
        &self,
        r: &Record,
        k: &[Value],
        w: Option<&Value>,
    ) -> Result<NurbsCurve3, StepError> {
        let p = match self.arg(r, 1)? {
            Value::Int(i) if *i > 0 => *i as usize,
            _ => return Err(fail("bad B-spline degree")),
        };
        let pts: Vec<[f64; 3]> = self
            .refs(r, 2)?
            .into_iter()
            .map(|id| self.point(id).map(|q| [q.x, q.y, q.z]))
            .collect::<Result<_, _>>()?;
        if k.len() < 2 {
            return Err(fail("B-spline curve knot data missing"));
        }
        let knots: Vec<f64> = self
            .ints(&k[0])?
            .iter()
            .zip(self.reals(&k[1])?)
            .flat_map(|(&m, v)| std::iter::repeat_n(v, m))
            .collect();
        let weights = w.map(|v| self.reals(v)).transpose()?;
        NurbsCurve3::new(p, knots, pts, weights).map_err(|e| fail(format!("B-spline curve: {e}")))
    }
}

/// Check every reference of every instance resolves.
fn check_references(f: &P21File) -> Result<(), StepError> {
    fn walk(v: &Value, f: &P21File, from: u64) -> Result<(), StepError> {
        match v {
            Value::Ref(r) if !f.data.contains_key(r) => {
                Err(fail(format!("#{from} references undefined #{r}")))
            }
            Value::List(l) | Value::Typed(_, l) => l.iter().try_for_each(|x| walk(x, f, from)),
            _ => Ok(()),
        }
    }
    for (id, inst) in &f.data {
        let recs: Vec<&Record> = match inst {
            Instance::Simple(r) => vec![r],
            Instance::Complex(rs) => rs.iter().collect(),
        };
        for r in recs {
            for a in &r.args {
                walk(a, f, *id)?;
            }
        }
    }
    Ok(())
}

/// Units of the geometric context: millimetres required; the plane angle factor.
fn units(f: &P21File) -> Result<(f64, f64), StepError> {
    let mut mm = false;
    let mut angle = 1.0;
    let mut uncertainty = None;
    for inst in f.data.values() {
        if inst.record("LENGTH_UNIT").is_some()
            && let Some(si) = inst.record("SI_UNIT")
        {
            mm = matches!(
                (si.args.first(), si.args.get(1)),
                (Some(Value::Enum(p)), Some(Value::Enum(u))) if p == "MILLI" && u == "METRE"
            );
        }
        if inst.record("PLANE_ANGLE_UNIT").is_some()
            && inst.record("CONVERSION_BASED_UNIT").is_some()
        {
            angle = math::PI / 180.0;
        }
        if let Some(u) = inst.record("UNCERTAINTY_MEASURE_WITH_UNIT")
            && let Some(Value::Typed(_, v)) = u.args.first()
        {
            uncertainty = v.first().and_then(Value::as_f64);
        }
    }
    if !mm {
        return Err(fail("the length unit is not millimetres"));
    }
    let u = uncertainty.ok_or_else(|| fail("no distance uncertainty"))?;
    if !(u > 0.0 && u.is_finite()) {
        return Err(fail("the distance uncertainty is not positive"));
    }
    Ok((angle, u))
}

struct EdgeData {
    v: (u64, u64),
    curve: Curve3,
    /// `PCURVE`s of a `SURFACE_CURVE`: (basis surface instance, 2D curve).
    pcurves: Vec<(u64, Curve2)>,
    same_sense: bool,
    /// Uses: (face index within the solid, effective direction).
    uses: Vec<(usize, bool)>,
}

/// Parse and verify a STEP file (see the module docs).
pub fn verify_step(bytes: &[u8]) -> Result<StepSummary, StepError> {
    let f = parse(bytes)?;
    check_references(&f)?;
    let (angle, uncertainty) = units(&f)?;
    let schemas = f.schemas();
    let entities = f.data.len();
    let file = File { f, angle };
    let mut solids = Vec::new();
    let ids: Vec<u64> = file
        .f
        .data
        .iter()
        .filter(|(_, i)| {
            matches!(
                i.simple_name(),
                Some("MANIFOLD_SOLID_BREP" | "BREP_WITH_VOIDS")
            )
        })
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        solids.push(verify_solid(&file, id, uncertainty)?);
    }
    if solids.is_empty() {
        return Err(fail("the file has no solid"));
    }
    Ok(StepSummary {
        schemas,
        entities,
        uncertainty,
        solids,
    })
}

fn verify_solid(file: &File, id: u64, uncertainty: f64) -> Result<SolidSummary, StepError> {
    let r = file.rec(id, &["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS"])?;
    let name = file.arg(r, 0)?.as_str().unwrap_or("").to_string();
    let mut shells: Vec<(u64, bool)> = vec![(file.reff(r, 1)?, true)];
    if r.name == "BREP_WITH_VOIDS" {
        for v in file.refs(r, 2)? {
            let o = file.rec(v, &["ORIENTED_CLOSED_SHELL"])?;
            let orient = file.boolean(o, 3)?;
            if orient {
                return Err(fail(format!(
                    "#{v}: a void shell must have orientation .F."
                )));
            }
            shells.push((file.reff(o, 2)?, orient));
        }
    }
    let mut summary = SolidSummary {
        name,
        shells: shells.len(),
        ..SolidSummary::default()
    };
    let mut surfaces: Vec<Surface> = Vec::new();
    let mut surface_ids: Vec<u64> = Vec::new();
    let mut edges: BTreeMap<u64, EdgeData> = BTreeMap::new();
    let mut vertices: BTreeMap<u64, Point3> = BTreeMap::new();
    for (si, &(shell_id, shell_orient)) in shells.iter().enumerate() {
        let sh = file.rec(shell_id, &["CLOSED_SHELL"])?;
        let mut shell_edges: BTreeMap<u64, Vec<bool>> = BTreeMap::new();
        for face_id in file.refs(sh, 1)? {
            let fr = file.rec(face_id, &["ADVANCED_FACE"])?;
            let surface_id = file.reff(fr, 2)?;
            let (kind, surface) = file.surface(surface_id)?;
            surface_ids.push(surface_id);
            file.boolean(fr, 3)?;
            *summary.face_types.entry(kind).or_default() += 1;
            let fi = surfaces.len();
            surfaces.push(surface);
            let bounds = file.refs(fr, 1)?;
            if bounds.is_empty() {
                return Err(fail(format!("#{face_id}: a face without bounds")));
            }
            let mut face_uses: BTreeMap<u64, usize> = BTreeMap::new();
            for b in bounds {
                let br = file.rec(b, &["FACE_BOUND", "FACE_OUTER_BOUND"])?;
                let b_orient = file.boolean(br, 2)?;
                let lr = file.rec(file.reff(br, 1)?, &["EDGE_LOOP"])?;
                let oes = file.refs(lr, 1)?;
                if oes.is_empty() {
                    return Err(fail(format!("#{b}: an empty loop")));
                }
                let mut ends: Vec<(u64, u64)> = Vec::new();
                for oe in oes {
                    let o = file.rec(oe, &["ORIENTED_EDGE"])?;
                    let ec_id = file.reff(o, 3)?;
                    let fwd = file.boolean(o, 4)?;
                    let ed = match edges.entry(ec_id) {
                        std::collections::btree_map::Entry::Occupied(o) => o.into_mut(),
                        std::collections::btree_map::Entry::Vacant(slot) => {
                            let ec = file.rec(ec_id, &["EDGE_CURVE"])?;
                            let v1 = file.reff(ec, 1)?;
                            let v2 = file.reff(ec, 2)?;
                            for v in [v1, v2] {
                                if let std::collections::btree_map::Entry::Vacant(vs) =
                                    vertices.entry(v)
                                {
                                    let vp = file.rec(v, &["VERTEX_POINT"])?;
                                    vs.insert(file.point(file.reff(vp, 1)?)?);
                                }
                            }
                            slot.insert(EdgeData {
                                v: (v1, v2),
                                curve: file.edge_curve(file.reff(ec, 3)?)?,
                                pcurves: file.pcurves(file.reff(ec, 3)?)?,
                                same_sense: file.boolean(ec, 4)?,
                                uses: Vec::new(),
                            })
                        }
                    };
                    let dir = fwd == b_orient;
                    let effective = dir == shell_orient;
                    ed.uses.push((fi, effective));
                    shell_edges.entry(ec_id).or_default().push(effective);
                    *face_uses.entry(ec_id).or_default() += 1;
                    ends.push(if fwd { ed.v } else { (ed.v.1, ed.v.0) });
                }
                for k in 0..ends.len() {
                    let next = ends[(k + 1) % ends.len()];
                    if ends[k].1 != next.0 {
                        return Err(fail(format!("#{b}: the loop is not closed after edge {k}")));
                    }
                }
            }
            summary.seam_edges += face_uses.values().filter(|&&n| n == 2).count();
        }
        for (e, uses) in &shell_edges {
            let fwd = uses.iter().filter(|&&d| d).count();
            if uses.len() != 2 || fwd != 1 {
                return Err(fail(format!(
                    "#{e}: used {} times ({fwd} forward) in closed shell {si}; a closed shell uses \
                     every edge twice in opposite directions",
                    uses.len()
                )));
            }
        }
        summary.faces += file.refs(sh, 1)?.len();
    }
    summary.edges = edges.len();
    summary.vertices = vertices.len();

    // Geometry.
    let scale = vertices
        .values()
        .map(|p| p.x.abs().max(p.y.abs()).max(p.z.abs()))
        .fold(1.0, f64::max);
    let tol = uncertainty * 1.01 + 1e-9 * scale;
    for (id, e) in &edges {
        let p1 = vertices[&e.v.0];
        let p2 = vertices[&e.v.1];
        let (t1, d1) = e.curve.project(p1);
        let (t2, d2) = e.curve.project(p2);
        if d1 > tol || d2 > tol {
            return Err(fail(format!(
                "#{id}: a vertex is {:e} mm off the edge's curve",
                d1.max(d2)
            )));
        }
        let closed = e.v.0 == e.v.1;
        if closed && e.curve.period().is_none() {
            // A closed edge on a non-periodic curve covers the whole curve: its vertex must be
            // at both ends (readers take the curve's own range).
            let (ca, cb) = e.curve.domain();
            if e.curve.eval(ca).distance(p1) > tol || e.curve.eval(cb).distance(p1) > tol {
                return Err(fail(format!(
                    "#{id}: a closed edge's vertex is not at the ends of its non-periodic curve"
                )));
            }
        }
        let (a, b) = edge_range(&e.curve, t1, t2, closed, e.same_sense, tol).ok_or_else(|| {
            fail(format!(
                "#{id}: the edge runs against its curve's direction"
            ))
        })?;
        for k in 0..=8 {
            let p = e.curve.eval(a + (b - a) * f64::from(k) / 8.0);
            for &(fi, _) in &e.uses {
                let (_, _, d) = surfaces[fi].project(p);
                if d > tol {
                    return Err(fail(format!(
                        "#{id}: the edge leaves the surface of a face using it by {d:e} mm"
                    )));
                }
            }
        }
        // Each pcurve lies on a face that uses the edge and follows the edge's parameter.
        for (sid, pc) in &e.pcurves {
            let Some(&(fi, _)) = e.uses.iter().find(|(fi, _)| surface_ids[*fi] == *sid) else {
                return Err(fail(format!(
                    "#{id}: a pcurve is on #{sid}, which no face using the edge carries"
                )));
            };
            for k in 0..=16 {
                let t = a + (b - a) * f64::from(k) / 16.0;
                let uv = pc.eval(t);
                let d = surfaces[fi].eval(uv.x, uv.y).distance(e.curve.eval(t));
                if d.is_nan() || d > tol {
                    return Err(fail(format!(
                        "#{id}: a pcurve is {d:e} mm off the edge at parameter {t}"
                    )));
                }
            }
        }
    }
    Ok(summary)
}

/// The curve parameter range an edge covers, from its end parameters; `None` when a
/// non-periodic curve would run backwards.
fn edge_range(
    c: &Curve3,
    t1: f64,
    t2: f64,
    closed: bool,
    same_sense: bool,
    closure_tol: f64,
) -> Option<(f64, f64)> {
    match c.period() {
        Some(per) => {
            if closed {
                return Some((t1, t1 + per));
            }
            if same_sense {
                Some((t1, t1 + math::rem_euclid(t2 - t1, per)))
            } else {
                Some((t2, t2 + math::rem_euclid(t1 - t2, per)))
            }
        }
        None if closed => {
            let (a, b) = c.domain();
            (a.is_finite() && b.is_finite()).then_some((a, b))
        }
        None => {
            let (mut a, mut b) = if same_sense { (t1, t2) } else { (t2, t1) };
            // On a closed curve (a ring cut into pieces) the closing point projects to one
            // end of the domain; a piece that ends (starts) there uses the other end.
            let (d0, d1) = c.domain();
            if a >= b && c.eval(d0).distance(c.eval(d1)) <= closure_tol {
                if b <= d0 {
                    b = d1;
                }
                if a >= d1 {
                    a = d0;
                }
            }
            (a < b).then_some((a, b))
        }
    }
}
