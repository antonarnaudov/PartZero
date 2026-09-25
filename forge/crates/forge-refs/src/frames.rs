//! Plane, axis, point and direction references (SPEC-v1 §3.1–§3.2) and the datum features
//! (§3.3 `datum_plane`, §3.4 `datum_axis`).
//!
//! Every function takes the JSON pointer of the field it evaluates, so the reference
//! resolutions it makes carry their report paths (`/plane/face`, `/axis/edge`, …). They
//! return [`Evaluated`]: the value (or the first error) together with every reference
//! resolution made on the way, in field order, for the feature's `refs` report entries.

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Frame, Vec3};
use forge_ir::v1::metrics::{DatumFrame, DatumLine};
use forge_ir::v1::{
    ANGULAR_TOLERANCE, AxisName, AxisObject, AxisRef, DatumAxisFeature, DatumAxisMode,
    DatumPlaneFeature, DatumPlaneMode, Dir, DirName, LINEAR_TOLERANCE, PlaneRef, PointRef,
    QUERY_ANGLE_TOLERANCE, Ref, SP3, degtrig,
};
use serde_json::json;

use crate::error::RefError;
use crate::geom::{axis_angle, clean, clean3, closest_to_origin, sign_canonical};
use crate::keys::EntityId;
use crate::resolve::{FieldSpec, Resolution, resolve_with};
use crate::scope::Scope;
use crate::table::{DatumValue, FeatureStatus};
use crate::typing::RefField;

/// A plane frame (origin, unit axes, `y = normal × x`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaneFrame {
    /// Origin (mm).
    pub origin: [f64; 3],
    /// Unit x axis.
    pub x: [f64; 3],
    /// Unit y axis.
    pub y: [f64; 3],
    /// Unit normal.
    pub normal: [f64; 3],
}

impl PlaneFrame {
    /// The report block of a `datum_plane` (§3.3).
    pub fn to_report(&self) -> DatumFrame {
        DatumFrame {
            origin: self.origin,
            x: self.x,
            y: self.y,
            normal: self.normal,
        }
    }
    /// As a forge-core frame (for sketching on it).
    pub fn to_frame(&self) -> Option<Frame> {
        Frame::from_normal_x(
            Vec3::from(self.origin),
            Vec3::from(self.normal),
            Vec3::from(self.x),
        )
    }
    fn from_vecs(o: Vec3, x: Vec3, n: Vec3) -> PlaneFrame {
        PlaneFrame {
            origin: clean3(o),
            x: clean3(x),
            y: clean3(n.cross(x)),
            normal: clean3(n),
        }
    }
}

/// An oriented line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxisLine {
    /// A point of the line (mm).
    pub origin: [f64; 3],
    /// Unit direction.
    pub direction: [f64; 3],
}

impl AxisLine {
    /// The report block of a `datum_axis` (§3.4).
    pub fn to_report(&self) -> DatumLine {
        DatumLine {
            origin: self.origin,
            direction: self.direction,
        }
    }
}

/// A value with the reference resolutions made to compute it (in field order).
#[derive(Clone, Debug)]
pub struct Evaluated<T> {
    /// The value, or the first error in field order.
    pub result: Result<T, RefError>,
    /// Every reference resolution, for the feature's `refs` entries.
    pub refs: Vec<Resolution>,
}

struct Ctx<'s, 'a> {
    scope: &'s Scope<'a>,
    refs: Vec<Resolution>,
}

fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::from(a)
}

impl Ctx<'_, '_> {
    fn sp3(&self, v: &SP3, path: &str) -> Result<Vec3, RefError> {
        Ok(Vec3::new(
            self.scope.scalar(&v[0], &format!("{path}/0"))?,
            self.scope.scalar(&v[1], &format!("{path}/1"))?,
            self.scope.scalar(&v[2], &format!("{path}/2"))?,
        ))
    }

    /// Resolve a single-entity reference; its resolution is recorded.
    fn one(&mut self, r: &Ref, field: String) -> Result<crate::Entity, RefError> {
        let res = resolve_with(
            r,
            self.scope,
            &FieldSpec {
                field,
                card: RefField::FACE_ONE.card,
            },
        );
        let out = match (&res.error, res.members.as_slice()) {
            (Some(e), _) => Err(RefError::Reference {
                code: e.code.clone(),
                message: e.message.clone(),
                details: e.details.clone(),
            }),
            (None, [m]) => Ok(m.entity),
            (None, _) => Err(RefError::Reference {
                code: "REF_CARDINALITY".into(),
                message: "a single-entity reference resolved to several entities".into(),
                details: serde_json::Map::new(),
            }),
        };
        self.refs.push(res);
        out
    }

    fn datum(&self, id: &str, path: &str, plane: bool) -> Result<DatumValue, RefError> {
        let expected = if plane { "datum_plane" } else { "datum_axis" };
        let f = self
            .scope
            .table()
            .get(id)
            .filter(|f| f.ty == expected)
            .ok_or_else(|| RefError::UnresolvedFeature {
                id: id.to_string(),
                field: path.to_string(),
                expected: expected.into(),
            })?;
        match &f.status {
            FeatureStatus::Suppressed => Err(RefError::DependencySuppressed {
                feature: id.to_string(),
            }),
            FeatureStatus::Failed { code, message } => Err(RefError::DependencyFailed {
                feature: id.to_string(),
                code: code.clone(),
                message: message.clone(),
            }),
            FeatureStatus::Ok => f.datum.ok_or_else(|| RefError::DependencyFailed {
                feature: id.to_string(),
                code: "FORGE_DATUM_NOT_EVALUATED".into(),
                message: "the datum has no evaluated frame".into(),
            }),
        }
    }

    fn plane(&mut self, p: &PlaneRef, path: &str) -> Result<PlaneFrame, RefError> {
        match p {
            PlaneRef::Named(n) => {
                let (o, x, y, nn) = forge_ir::PlaneSpec::Named(*n).resolve();
                Ok(PlaneFrame {
                    origin: o,
                    x,
                    y,
                    normal: nn,
                })
            }
            PlaneRef::Frame(f) => {
                let o = self.sp3(&f.origin, &format!("{path}/origin"))?;
                let n = self.sp3(&f.normal, &format!("{path}/normal"))?;
                let x = self.sp3(&f.x_dir, &format!("{path}/x_dir"))?;
                explicit_frame(o, n, x, path)
            }
            PlaneRef::Face(fp) => {
                let e = self.one(&fp.face, format!("{path}/face"))?;
                let EntityId::Face(fid) = e.id else {
                    return Err(RefError::PlaneNotPlanar {
                        surface: e.kind().as_str().into(),
                    });
                };
                let face = self
                    .scope
                    .body(e)
                    .face(fid)
                    .ok_or(RefError::PlaneNotPlanar {
                        surface: "missing".into(),
                    })?;
                let Surface::Plane(pl) = &face.surface else {
                    return Err(RefError::PlaneNotPlanar {
                        surface: face.surface.kind_name().into(),
                    });
                };
                let n = if face.sense {
                    pl.frame().z()
                } else {
                    -pl.frame().z()
                };
                let p0 = pl.frame().origin();
                let o = match &fp.origin {
                    Some(o) => self.sp3(o, &format!("{path}/origin"))?,
                    None => Vec3::zero(),
                };
                let o = o - n * (o - p0).dot(n);
                let xd = match &fp.x_dir {
                    Some(x) => self.sp3(x, &format!("{path}/x_dir"))?,
                    None => least_aligned_axis(n),
                };
                let x = xd - n * xd.dot(n);
                if x.norm() <= 1e-9 {
                    return Err(RefError::PlaneDegenerate { x_dir: clean3(xd) });
                }
                let x = x
                    .normalize()
                    .ok_or(RefError::PlaneDegenerate { x_dir: clean3(xd) })?;
                Ok(PlaneFrame::from_vecs(o, x, n))
            }
            PlaneRef::Datum(d) => match self.datum(&d.datum, &format!("{path}/datum"), true)? {
                DatumValue::Plane(f) => Ok(f),
                DatumValue::Axis(_) => Err(RefError::UnresolvedFeature {
                    id: d.datum.clone(),
                    field: format!("{path}/datum"),
                    expected: "datum_plane".into(),
                }),
            },
        }
    }

    fn axis_object(&mut self, o: &AxisObject, path: &str) -> Result<AxisLine, RefError> {
        let line = match o {
            AxisObject::Edge(a) => {
                let e = self.one(&a.edge, format!("{path}/edge"))?;
                edge_axis(self.scope, e)?
            }
            AxisObject::Cylinder(a) => {
                let e = self.one(&a.cylinder, format!("{path}/cylinder"))?;
                cylinder_axis(self.scope, e)?
            }
            AxisObject::Datum(a) => match self.datum(&a.datum, &format!("{path}/datum"), false)? {
                DatumValue::Axis(l) => l,
                DatumValue::Plane(_) => {
                    return Err(RefError::UnresolvedFeature {
                        id: a.datum.clone(),
                        field: format!("{path}/datum"),
                        expected: "datum_axis".into(),
                    });
                }
            },
            AxisObject::Line(l) => {
                let o = self.sp3(&l.line.origin, &format!("{path}/line/origin"))?;
                let d = self.sp3(&l.line.direction, &format!("{path}/line/direction"))?;
                let dn = d
                    .normalize()
                    .filter(|_| d.norm() > LINEAR_TOLERANCE)
                    .ok_or_else(|| RefError::InvalidAxis {
                        field: format!("{path}/line/direction"),
                        value: json!(clean3(d)),
                    })?;
                AxisLine {
                    origin: clean3(o),
                    direction: clean3(dn),
                }
            }
        };
        let flip = self.scope.boolean(o.flip(), &format!("{path}/flip"))?;
        Ok(if flip {
            AxisLine {
                origin: line.origin,
                direction: clean3(-v3(line.direction)),
            }
        } else {
            line
        })
    }

    fn axis(&mut self, a: &AxisRef, path: &str) -> Result<AxisLine, RefError> {
        match a {
            AxisRef::Named(n) => Ok(AxisLine {
                origin: [0.0; 3],
                direction: match n {
                    AxisName::X => [1.0, 0.0, 0.0],
                    AxisName::Y => [0.0, 1.0, 0.0],
                    AxisName::Z => [0.0, 0.0, 1.0],
                },
            }),
            AxisRef::Object(o) => self.axis_object(o, path),
        }
    }

    fn point(&mut self, p: &PointRef, path: &str) -> Result<Vec3, RefError> {
        match p {
            PointRef::Point(v) => self.sp3(v, path),
            PointRef::Vertex(v) => {
                let e = self.one(&v.vertex, format!("{path}/vertex"))?;
                let EntityId::Vertex(vid) = e.id else {
                    return Err(RefError::Reference {
                        code: "REF_KIND_MISMATCH".into(),
                        message: "a point reference must designate a vertex".into(),
                        details: serde_json::Map::new(),
                    });
                };
                Ok(self
                    .scope
                    .body(e)
                    .vertex(vid)
                    .map(|v| v.point)
                    .unwrap_or(Vec3::zero()))
            }
        }
    }

    fn dir(&mut self, d: &Dir, path: &str) -> Result<Vec3, RefError> {
        match d {
            Dir::Name(n) => Ok(match n {
                DirName::PosX | DirName::X => Vec3::unit_x(),
                DirName::NegX => -Vec3::unit_x(),
                DirName::PosY | DirName::Y => Vec3::unit_y(),
                DirName::NegY => -Vec3::unit_y(),
                DirName::PosZ | DirName::Z => Vec3::unit_z(),
                DirName::NegZ => -Vec3::unit_z(),
            }),
            Dir::Vector(v) => {
                let x = self.sp3(v, path)?;
                x.normalize()
                    .filter(|_| x.norm() > LINEAR_TOLERANCE)
                    .ok_or_else(|| RefError::InvalidValue {
                        field: path.to_string(),
                        value: json!(clean3(x)),
                        expected: "a non-zero vector".into(),
                    })
            }
            Dir::Axis(o) => Ok(v3(self.axis_object(o, path)?.direction)),
        }
    }
}

/// v0 [R-14]: `n` normalised, `x` re-orthogonalised against it, `y = n × x`.
fn explicit_frame(o: Vec3, n: Vec3, x: Vec3, path: &str) -> Result<PlaneFrame, RefError> {
    let deg = |reason: &str| RefError::InvalidPlane {
        field: path.to_string(),
        reason: reason.into(),
    };
    if n.norm() <= LINEAR_TOLERANCE || x.norm() <= LINEAR_TOLERANCE {
        return Err(deg("zero-length normal or x_dir"));
    }
    let n = n.normalize().ok_or_else(|| deg("zero-length normal"))?;
    // [W0-8] / validation's literal check, on the evaluated vectors: an expression-driven
    // frame is not re-orthogonalised silently.
    if (n.dot(x) / x.norm()).abs() > 1e-9 {
        return Err(deg("normal and x_dir are not perpendicular"));
    }
    let x = (x - n * x.dot(n))
        .normalize()
        .ok_or_else(|| deg("x_dir parallel to the normal"))?;
    Ok(PlaneFrame::from_vecs(o, x, n))
}

/// The world axis least aligned with `n` (smallest `|n · axis|`; ties X, then Y, then Z,
/// §3.1 step 3). Components within `ANGULAR_TOLERANCE` are ties, so a 45° face computed with
/// rounding noise in either component always gets X (not X or Y by the last ulp).
fn least_aligned_axis(n: Vec3) -> Vec3 {
    let axes = [Vec3::unit_x(), Vec3::unit_y(), Vec3::unit_z()];
    // The minimum first, then the first axis (X, Y, Z order) within the tolerance of it: a
    // tie test against a running best would not be transitive.
    let v = axes.map(|a| n.dot(a).abs());
    let min = v.iter().copied().fold(f64::INFINITY, f64::min);
    axes.into_iter()
        .zip(v)
        .find(|(_, x)| *x <= min + ANGULAR_TOLERANCE)
        .map_or(axes[0], |(a, _)| a)
}

/// The axis of an edge (§3.2): a line's line (point closest to the world origin), a circle's
/// centre and normal; sign-canonical.
fn edge_axis(scope: &Scope<'_>, e: crate::Entity) -> Result<AxisLine, RefError> {
    let EntityId::Edge(x) = e.id else {
        return Err(RefError::AxisRefUnsupported {
            kind: e.kind().as_str().into(),
        });
    };
    let edge = scope.body(e).edge(x).ok_or(RefError::AxisRefUnsupported {
        kind: "missing".into(),
    })?;
    match &edge.curve {
        Curve3::Line(l) => {
            let d = sign_canonical(l.dir());
            Ok(AxisLine {
                origin: clean3(closest_to_origin(l.origin(), d)),
                direction: clean3(d),
            })
        }
        Curve3::Circle(c) => Ok(AxisLine {
            origin: clean3(c.frame().origin()),
            direction: clean3(sign_canonical(c.frame().z())),
        }),
        other => Err(RefError::AxisRefUnsupported {
            kind: other.kind_name().into(),
        }),
    }
}

/// The axis of a cylindrical or conical face (§3.2): the axis point closest to the world
/// origin, sign-canonical direction.
fn cylinder_axis(scope: &Scope<'_>, e: crate::Entity) -> Result<AxisLine, RefError> {
    let EntityId::Face(f) = e.id else {
        return Err(RefError::AxisRefUnsupported {
            kind: e.kind().as_str().into(),
        });
    };
    let face = scope.body(e).face(f).ok_or(RefError::AxisRefUnsupported {
        kind: "missing".into(),
    })?;
    let frame = match &face.surface {
        Surface::Cylinder(c) => *c.frame(),
        Surface::Cone(c) => *c.frame(),
        other => {
            return Err(RefError::AxisRefUnsupported {
                kind: other.kind_name().into(),
            });
        }
    };
    let d = sign_canonical(frame.z());
    Ok(AxisLine {
        origin: clean3(closest_to_origin(frame.origin(), d)),
        direction: clean3(d),
    })
}

fn run<T>(
    scope: &Scope<'_>,
    f: impl FnOnce(&mut Ctx<'_, '_>) -> Result<T, RefError>,
) -> Evaluated<T> {
    let mut ctx = Ctx {
        scope,
        refs: Vec::new(),
    };
    let result = f(&mut ctx);
    Evaluated {
        result,
        refs: ctx.refs,
    }
}

/// The frame of a plane reference (§3.1). `field` is its JSON pointer in the feature.
pub fn plane_frame(p: &PlaneRef, scope: &Scope<'_>, field: &str) -> Evaluated<PlaneFrame> {
    run(scope, |c| c.plane(p, field))
}

/// The oriented line of an axis reference (§3.2), `flip` applied.
pub fn axis(a: &AxisRef, scope: &Scope<'_>, field: &str) -> Evaluated<AxisLine> {
    run(scope, |c| c.axis(a, field))
}

/// The position of a point reference (§3.2).
pub fn point(p: &PointRef, scope: &Scope<'_>, field: &str) -> Evaluated<[f64; 3]> {
    run(scope, |c| c.point(p, field).map(clean3))
}

/// The unit vector of a direction (§3.2): unsigned `X`/`Y`/`Z` mean `+`. Nested reference
/// failures become [`RefError::Reference`].
pub fn direction(d: &Dir, scope: &Scope<'_>, field: &str) -> Result<Vec3, RefError> {
    run(scope, |c| c.dir(d, field)).result
}

/// [`direction`] with the reference resolutions it made (an edge or cylinder `Dir`, e.g. a
/// linear pattern's `dir`, §6.10), for the feature's `refs` entries (§5.8). Integration
/// wiring (forge-regen, Phase C): same value and errors as [`direction`].
pub fn direction_eval(d: &Dir, scope: &Scope<'_>, field: &str) -> Evaluated<Vec3> {
    run(scope, |c| c.dir(d, field))
}

fn degenerate(reason: &str, angle_deg: f64) -> RefError {
    RefError::DatumDegenerate {
        reason: reason.into(),
        angle_deg,
    }
}

/// Rotate `v` by `angle` degrees about the unit axis `a` (right-hand rule), with the exact
/// degree trigonometry of §2.7 rule 4.
fn rotate(v: Vec3, a: Vec3, angle: f64) -> Result<Vec3, RefError> {
    let (s, c) = degtrig::sin_cos_deg(angle).ok_or_else(|| RefError::InvalidValue {
        field: "angle".into(),
        value: json!(angle),
        expected: "a finite angle".into(),
    })?;
    Ok(v * c + a.cross(v) * s + a * (a.dot(v) * (1.0 - c)))
}

fn field<'x, T>(v: &'x Option<T>, name: &str) -> Result<&'x T, RefError> {
    v.as_ref().ok_or_else(|| RefError::Rejected {
        code: "DATUM_OPTIONS_CONFLICT",
        path: format!("/{name}"),
        message: format!("missing {name}"),
        details: json!({ "mode": "", "fields": [name], "missing": [name], "unexpected": [] }),
    })
}

/// Evaluate a `datum_plane` feature (§3.3). `fp` is the feature's JSON pointer prefix for the
/// fields' report paths (usually empty: report paths are relative to the feature).
pub fn datum_plane(d: &DatumPlaneFeature, scope: &Scope<'_>, fp: &str) -> Evaluated<PlaneFrame> {
    run(scope, |c| {
        let tol = QUERY_ANGLE_TOLERANCE;
        match d.mode {
            DatumPlaneMode::Offset => {
                let from = c.plane(field(&d.from, "from")?, &format!("{fp}/from"))?;
                let dist = c
                    .scope
                    .scalar(field(&d.distance, "distance")?, &format!("{fp}/distance"))?;
                let n = v3(from.normal);
                Ok(PlaneFrame::from_vecs(
                    v3(from.origin) + n * dist,
                    v3(from.x),
                    n,
                ))
            }
            DatumPlaneMode::Angle => {
                let from = c.plane(field(&d.from, "from")?, &format!("{fp}/from"))?;
                let ax = c.axis(field(&d.axis, "axis")?, &format!("{fp}/axis"))?;
                let ang = c
                    .scope
                    .scalar(field(&d.angle, "angle")?, &format!("{fp}/angle"))?;
                let (a, n) = (v3(ax.direction), v3(from.normal));
                if a.dot(n).abs() > forge_core::math::sin(tol) {
                    return Err(degenerate(
                        "the axis is not parallel to the plane",
                        clean(90.0 - forge_core::math::rad_to_deg(axis_angle(a, n))),
                    ));
                }
                let p = v3(ax.origin);
                let o = p + rotate(v3(from.origin) - p, a, ang)?;
                let x = rotate(v3(from.x), a, ang)?;
                let n2 = rotate(n, a, ang)?;
                Ok(PlaneFrame::from_vecs(o, x, n2))
            }
            DatumPlaneMode::Midplane => {
                let a = c.plane(field(&d.a, "a")?, &format!("{fp}/a"))?;
                let b = c.plane(field(&d.b, "b")?, &format!("{fp}/b"))?;
                let (na, nb) = (v3(a.normal), v3(b.normal));
                let ang = axis_angle(na, nb);
                if ang > tol {
                    return Err(degenerate(
                        "the planes are not parallel",
                        clean(forge_core::math::rad_to_deg(ang)),
                    ));
                }
                let oa = v3(a.origin);
                let o = oa + na * ((v3(b.origin) - oa).dot(na) * 0.5);
                Ok(PlaneFrame::from_vecs(o, v3(a.x), na))
            }
            DatumPlaneMode::Through => {
                let pts = field(&d.points, "points")?;
                let p0 = c.point(&pts[0], &format!("{fp}/points/0"))?;
                let p1 = c.point(&pts[1], &format!("{fp}/points/1"))?;
                let p2 = c.point(&pts[2], &format!("{fp}/points/2"))?;
                let (u, w) = (p1 - p0, p2 - p0);
                let cr = u.cross(w);
                // The angle between p1 − p0 and p2 − p0 (0 when a difference vanishes).
                let spread = clean(forge_core::math::rad_to_deg(forge_core::math::atan2(
                    cr.norm(),
                    u.dot(w),
                )));
                if u.norm() <= LINEAR_TOLERANCE || cr.norm() <= LINEAR_TOLERANCE * u.norm() {
                    return Err(degenerate("the three points are collinear", spread));
                }
                let x = u
                    .normalize()
                    .ok_or_else(|| degenerate("coincident points", 0.0))?;
                let n = cr
                    .normalize()
                    .ok_or_else(|| degenerate("collinear points", spread))?;
                Ok(PlaneFrame::from_vecs(p0, x, n))
            }
            DatumPlaneMode::Frame => {
                let o = c.sp3(field(&d.origin, "origin")?, &format!("{fp}/origin"))?;
                let n = c.sp3(field(&d.normal, "normal")?, &format!("{fp}/normal"))?;
                let x = c.sp3(field(&d.x_dir, "x_dir")?, &format!("{fp}/x_dir"))?;
                explicit_frame(o, n, x, fp)
            }
        }
    })
}

/// Evaluate a `datum_axis` feature (§3.4), `flip` applied.
pub fn datum_axis(d: &DatumAxisFeature, scope: &Scope<'_>, fp: &str) -> Evaluated<AxisLine> {
    run(scope, |c| {
        let line = match d.mode {
            DatumAxisMode::Edge => {
                let e = c.one(field(&d.edge, "edge")?, format!("{fp}/edge"))?;
                edge_axis(c.scope, e)?
            }
            DatumAxisMode::Cylinder => {
                let e = c.one(field(&d.face, "face")?, format!("{fp}/face"))?;
                cylinder_axis(c.scope, e)?
            }
            DatumAxisMode::Planes => {
                let a = c.plane(field(&d.a, "a")?, &format!("{fp}/a"))?;
                let b = c.plane(field(&d.b, "b")?, &format!("{fp}/b"))?;
                let (na, nb) = (v3(a.normal), v3(b.normal));
                let u = na.cross(nb);
                let ang = axis_angle(na, nb);
                if ang <= QUERY_ANGLE_TOLERANCE {
                    return Err(degenerate(
                        "the planes are parallel",
                        clean(forge_core::math::rad_to_deg(ang)),
                    ));
                }
                // The point of the intersection line closest to the world origin: in the
                // span of the two normals.
                let (da, db) = (na.dot(v3(a.origin)), nb.dot(v3(b.origin)));
                let k = na.dot(nb);
                let den = u.norm_squared();
                let p = (na * (da - db * k) + nb * (db - da * k)) / den;
                let dir = sign_canonical(u.normalize().ok_or_else(|| {
                    degenerate(
                        "the planes are parallel",
                        clean(forge_core::math::rad_to_deg(ang)),
                    )
                })?);
                AxisLine {
                    origin: clean3(p),
                    direction: clean3(dir),
                }
            }
            DatumAxisMode::Points => {
                let pts = field(&d.points, "points")?;
                let a = c.point(&pts[0], &format!("{fp}/points/0"))?;
                let b = c.point(&pts[1], &format!("{fp}/points/1"))?;
                let w = b - a;
                if w.norm() <= LINEAR_TOLERANCE {
                    return Err(degenerate("the two points coincide", 0.0));
                }
                AxisLine {
                    origin: clean3(a),
                    direction: clean3(
                        w.normalize()
                            .ok_or_else(|| degenerate("coincident points", 0.0))?,
                    ),
                }
            }
        };
        let flip = c.scope.boolean(&d.flip, &format!("{fp}/flip"))?;
        Ok(if flip {
            AxisLine {
                origin: line.origin,
                direction: clean3(-v3(line.direction)),
            }
        } else {
            line
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §3.1 step 3: the least-aligned axis, ties within `ANGULAR_TOLERANCE` to X before Y
    /// before Z, decided against the minimum (not a running best).
    #[test]
    fn least_aligned_axis_ties_are_decided_against_the_minimum() {
        let t = ANGULAR_TOLERANCE;
        let a = 0.5;
        // |n·X| = a, |n·Y| = a − 0.9·t, |n·Z| = a − 1.1·t (not normalised on purpose: only
        // the absolute components matter). Y and Z tie, X does not: Y.
        let n = Vec3::new(a, a - 0.9 * t, a - 1.1 * t);
        assert_eq!(least_aligned_axis(n), Vec3::unit_y());
        // Exact ties go to the earlier axis.
        assert_eq!(least_aligned_axis(Vec3::new(0.6, 0.6, 0.6)), Vec3::unit_x());
        assert_eq!(least_aligned_axis(Vec3::new(0.9, 0.3, 0.3)), Vec3::unit_y());
        // A clear minimum wins, whatever the sign.
        assert_eq!(least_aligned_axis(Vec3::new(0.0, 0.0, 1.0)), Vec3::unit_x());
        assert_eq!(least_aligned_axis(Vec3::new(1.0, 0.0, 0.0)), Vec3::unit_y());
        assert_eq!(
            least_aligned_axis(Vec3::new(0.6, -0.8, 0.0)),
            Vec3::unit_z()
        );
        assert_eq!(
            least_aligned_axis(Vec3::new(-0.2, 0.7, 0.6)),
            Vec3::unit_x()
        );
    }
}
