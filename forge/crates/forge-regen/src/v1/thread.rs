//! `thread` (SPEC-v1 §6.13) and the modelled threads of `hole` (§6.5) in the timeline:
//! forge-ops' `thread` construction on the part's state.
//!
//! # Thread feature
//! Order of checks (§7.1 step 2):
//! 1. **values**: `standard` (`THREAD_STANDARD_UNKNOWN`, re-checked), `major`, `pitch`,
//!    `length` (`INVALID_VALUE`, `> 1e-6`), `offset` (`>= 0`), `starts` (`INVALID_COUNT`, an
//!    integer in `[1, 8]`), `flip`, `modeled`;
//! 2. **references**: `/face` (face, `one`);
//! 3. **the operation**: the face must be a cylinder bounded by two full circles
//!    (`THREAD_FACE_UNSUPPORTED`); a bore gets a nut thread, a boss a bolt thread; the thread
//!    starts at the face's **start end** — the end whose neighbouring face opens away from the
//!    cylinder (a hole's entry, a boss's free end), the higher one (world `z`, then `y`, then
//!    `x`) when both or neither do, the other one with `flip` — and runs `length` (default:
//!    the rest of the face) from `offset`; then `forge_ops::thread::thread_face` (its
//!    `THREAD_*` failures) when `modeled`;
//! 4. the validity of the produced body ([R-12]).
//!
//! The report gets `thread` (`{ face, kind, standard?, major, pitch, minor, crest_d, length,
//! offset, starts, hand, modeled }`) and, when modelled, the modified body.
//!
//! # Hole threads
//! A hole whose `thread.modeled` is true threads, after the cut, every wall piece of every
//! position (`H/wall@p` pieces: the coaxial cylinders of the hole's diameter) from the
//! placement plane down to the thread depth (default: the hole's depth; through holes: every
//! wall piece). Its phase: the groove of start 0 is centred on the placement plane at the
//! placement frame's `x`. A hole with a modelled thread cannot be a pattern seed yet
//! (`FORGE_PATTERN_MODELED_THREAD`).

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::topo::{Body, FaceId};
use forge_ir::v1::metrics::{FeatureReport, ThreadReport};
use forge_ir::v1::threads::thread_standard;
use forge_ir::v1::{Cardinality, FieldType, LINEAR_TOLERANCE, Scalar, ThreadFeature, ThreadHand};
use forge_ops::thread::{
    END_MARGIN, ThreadError, ThreadForm, ThreadKind, ThreadRequest, crest_faces, thread_face,
};
use forge_refs::EntityId;
use serde_json::{Value, json};

use super::error::{FeatureError, finite};
use super::part::PartEval;

impl From<ThreadError> for FeatureError {
    fn from(e: ThreadError) -> Self {
        let details = match serde_json::to_value(&e) {
            Ok(Value::Object(m)) => Value::Object(m),
            _ => json!({}),
        };
        FeatureError::new(e.code(), e.to_string(), details)
    }
}

fn range(code: &str, field: &str, value: f64, expected: &str) -> FeatureError {
    FeatureError::new(
        code,
        format!("{field} = {value}: must be {expected}"),
        json!({ "field": field, "value": finite(value), "expected": expected }),
    )
}

/// A starts count: an integer in `[1, 8]`.
pub(super) fn starts_count(field: &str, n: f64) -> Result<u32, FeatureError> {
    // Exact comparison on purpose: counts are exact integers.
    #[allow(clippy::float_cmp)]
    let integral = n == n.trunc();
    if integral && (1.0..=8.0).contains(&n) {
        Ok(n as u32)
    } else {
        Err(range("INVALID_COUNT", field, n, "an integer in [1, 8]"))
    }
}

/// The two ends of a cylinder face: its boundary circles' centres, and whether the face next
/// to each one opens away from the cylinder.
struct Ends {
    centres: [Point3; 2],
    open: [bool; 2],
}

fn cylinder_ends(body: &Body, face: FaceId) -> Option<Ends> {
    let f = body.face(face)?;
    let Surface::Cylinder(cyl) = &f.surface else {
        return None;
    };
    if f.loops.len() != 2 {
        return None;
    }
    let mut centres = Vec::with_capacity(2);
    let mut open = Vec::with_capacity(2);
    for &lid in &f.loops {
        let lp = body.loop_(lid)?;
        let [cid] = lp.coedges.as_slice() else {
            return None;
        };
        let c = body.coedge(*cid)?;
        let e = body.edge(c.edge)?;
        let Curve3::Circle(k) = &e.curve else {
            return None;
        };
        centres.push(k.frame().origin());
        // The neighbour face: a plane across the axis whose outward normal points away from
        // the cylinder's extent is an opening.
        let other = e.coedges.iter().copied().find(|&x| x != *cid)?;
        let nf = body.face(
            body.coedge(other)
                .map(|c| c.loop_id)
                .and_then(|l| body.loop_(l))?
                .face,
        )?;
        open.push(match &nf.surface {
            Surface::Plane(p) => {
                let n = p.frame().z() * if nf.sense { 1.0 } else { -1.0 };
                // Away from the face: along from the other end's centre to this one.
                Some(n)
            }
            _ => None,
        });
    }
    let (c0, c1) = (centres[0], centres[1]);
    let _ = cyl;
    let away = |i: usize, n: Option<Vec3>| -> bool {
        let (this, other) = if i == 0 { (c0, c1) } else { (c1, c0) };
        n.is_some_and(|n| n.dot(this - other) > 0.0)
    };
    Some(Ends {
        centres: [c0, c1],
        open: [away(0, open[0]), away(1, open[1])],
    })
}

/// The start end index (see the module docs).
fn start_end(ends: &Ends, flip: bool) -> usize {
    let [a, b] = ends.centres;
    let higher = |p: Point3, q: Point3| -> bool {
        (p.z, p.y, p.x)
            .partial_cmp(&(q.z, q.y, q.x))
            .is_some_and(|o| o == std::cmp::Ordering::Greater)
    };
    let s = match ends.open {
        [true, false] => 0,
        [false, true] => 1,
        _ => {
            if higher(b, a) {
                1
            } else {
                0
            }
        }
    };
    if flip { 1 - s } else { s }
}

impl PartEval<'_> {
    /// Evaluate thread feature `x` at timeline index `fi` (see the module docs).
    pub(super) fn thread(
        &mut self,
        fi: usize,
        x: &ThreadFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        // 1. Values.
        let std = match &x.standard {
            Some(s) => Some(thread_standard(s).ok_or_else(|| {
                FeatureError::new(
                    "THREAD_STANDARD_UNKNOWN",
                    format!("{s:?} is not a thread designation of THREAD_STANDARDS"),
                    json!({ "field": "standard", "value": s }),
                )
            })?),
            None => None,
        };
        let opt = |this: &mut Self,
                   s: &Option<Scalar>,
                   t: FieldType|
         -> Result<Option<f64>, FeatureError> {
            match s {
                Some(s) => Ok(Some(this.scalar(s, t)?)),
                None => Ok(None),
            }
        };
        let positive = |field: &str, v: f64| -> Result<f64, FeatureError> {
            if v.is_finite() && v > LINEAR_TOLERANCE {
                Ok(v)
            } else {
                Err(range(
                    "INVALID_VALUE",
                    field,
                    v,
                    &format!("> {LINEAR_TOLERANCE}"),
                ))
            }
        };
        let major = match (opt(self, &x.major, FieldType::Length)?, std) {
            (Some(m), _) => positive("major", m)?,
            (None, Some(s)) => s.major,
            (None, None) => {
                return Err(FeatureError::new(
                    "THREAD_SIZE_REQUIRED",
                    "a thread needs a standard designation, or both major and pitch",
                    json!({ "field": "standard", "allowed": ["standard", "major + pitch"] }),
                ));
            }
        };
        let pitch = match (opt(self, &x.pitch, FieldType::Length)?, std) {
            (Some(p), _) => positive("pitch", p)?,
            (None, Some(s)) => s.pitch,
            (None, None) => {
                return Err(FeatureError::new(
                    "THREAD_SIZE_REQUIRED",
                    "a thread needs a standard designation, or both major and pitch",
                    json!({ "field": "standard", "allowed": ["standard", "major + pitch"] }),
                ));
            }
        };
        let length = match opt(self, &x.length, FieldType::Length)? {
            Some(l) => Some(positive("length", l)?),
            None => None,
        };
        let offset = opt(self, &x.offset, FieldType::Length)?.unwrap_or(0.0);
        if !(offset.is_finite() && offset >= 0.0) {
            return Err(range("INVALID_VALUE", "offset", offset, ">= 0"));
        }
        let starts = match opt(self, &x.starts, FieldType::Count)? {
            Some(n) => starts_count("starts", n)?,
            None => 1,
        };
        let flip = self.pv.boolean(self.pi, &x.flip)?;
        let modeled = self.pv.boolean(self.pi, &x.modeled)?;
        // 2. References.
        let face = self.resolve_entity(fi, &x.face, "/face", Cardinality::ONE, entry)?;
        let EntityId::Face(fid) = face.id else {
            return Err(FeatureError::new(
                "REF_KIND_MISMATCH",
                "/face: the reference resolved to an entity that is not a face",
                json!({ "field": "/face", "expected": "face", "found": "not a face" }),
            ));
        };
        let b = face.body;
        let body = &self.bodies[b].body;
        let fname = body
            .face(fid)
            .map(|f| f.provenance.name())
            .unwrap_or_default();
        let unsupported = |reason: &str| -> FeatureError {
            ThreadError::FaceUnsupported {
                face: fname.clone(),
                reason: reason.into(),
            }
            .into()
        };
        let f = body
            .face(fid)
            .ok_or_else(|| unsupported("the face does not resolve"))?;
        let Surface::Cylinder(cyl) = &f.surface else {
            return Err(unsupported(&format!(
                "it is a {}, not a cylinder",
                f.surface.kind_name()
            )));
        };
        let ends = cylinder_ends(body, fid)
            .ok_or_else(|| unsupported("a threadable cylinder is bounded by two full circles"))?;
        // 3. The operation.
        let kind = if f.sense {
            ThreadKind::External
        } else {
            ThreadKind::Internal
        };
        let form = ThreadForm {
            kind,
            major,
            pitch,
            starts,
            right_hand: x.hand == ThreadHand::Right,
        };
        form.validate()?;
        let s = start_end(&ends, flip);
        let (p0, p1) = (ends.centres[s], ends.centres[1 - s]);
        let span = p0.distance(p1);
        let z = (p1 - p0)
            .normalize()
            .ok_or_else(|| unsupported("the face has no length"))?;
        let frame = Frame::from_normal_x(p0, z, cyl.frame().x())
            .or_else(|| Frame::from_normal(p0, z))
            .ok_or_else(|| unsupported("degenerate axis"))?;
        let len = match length {
            Some(l) => l,
            None => span - offset,
        };
        let (za, zb) = (offset, offset + len);
        // Snap ends within the tolerance of the face's end circles onto them.
        let snap = |v: f64| {
            if (v - span).abs() <= LINEAR_TOLERANCE {
                span
            } else if v.abs() <= LINEAR_TOLERANCE {
                0.0
            } else {
                v
            }
        };
        let (za, zb) = (snap(za), snap(zb));
        let crest_d = 2.0 * cyl.radius();
        let key = self.with_scope(fi, |sc| sc.key(face).to_string());
        let report = ThreadReport {
            face: key,
            kind: kind.as_str().into(),
            standard: std.map(|s| s.designation.to_string()),
            major,
            pitch,
            minor: major - 1.25 * pitch * 3f64.sqrt() * 0.5,
            crest_d,
            length: zb - za,
            offset: za,
            starts,
            hand: x.hand,
            modeled,
        };
        if modeled {
            // A cosmetic thread checks the form against the face too.
            let id = self.part.features[fi].id().to_string();
            let threaded = thread_face(
                body,
                fid,
                &ThreadRequest {
                    form,
                    frame,
                    z_range: (za, zb),
                    feature: &id,
                    qualifier: None,
                },
            )?;
            entry.bodies = self.replace_bodies(vec![(b, threaded)])?;
        } else {
            form.check_crest(crest_d)?;
            if zb > span + LINEAR_TOLERANCE || za < 0.0 {
                return Err(ThreadError::LengthOutOfRange {
                    face: fname,
                    start: za,
                    end: zb,
                    face_start: 0.0,
                    face_end: span,
                }
                .into());
            }
        }
        entry.thread = Some(report);
        Ok(())
    }

    /// Thread every wall piece of hole position `(point, dir, x_dir)` of radius `r` down to
    /// `depth` (`None`: every piece), in `body` (see the module docs).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn thread_hole_walls(
        body: Body,
        form: ThreadForm,
        point: Point3,
        dir: Vec3,
        x_dir: Vec3,
        r: f64,
        depth: Option<f64>,
        feature: &str,
        at: &str,
    ) -> Result<Body, FeatureError> {
        let frame = Frame::from_normal_x(point, dir, x_dir)
            .or_else(|| Frame::from_normal(point, dir))
            .ok_or_else(|| {
                FeatureError::new(
                    "FORGE_THREAD_INTERNAL",
                    "a hole axis without a frame",
                    json!({ "detail": format!("hole position {at}: no frame for the axis") }),
                )
            })?;
        let limit = depth.unwrap_or(f64::INFINITY);
        let mut body = body;
        let mut done: Vec<(f64, f64)> = Vec::new();
        loop {
            let pieces = crest_faces(&body, &frame, r, (0.0, limit));
            let next = pieces.into_iter().find(|(_, (lo, hi))| {
                !done
                    .iter()
                    .any(|(a, b)| (a - lo).abs() <= 1e-9 && (b - hi).abs() <= 1e-9)
            });
            let Some((face, (lo, hi))) = next else {
                break;
            };
            done.push((lo, hi));
            let za = lo.max(0.0);
            let mut zb = hi.min(limit);
            if (hi - zb).abs() <= LINEAR_TOLERANCE || (zb < hi && hi - zb < END_MARGIN) {
                zb = hi;
            }
            if zb - za <= END_MARGIN {
                continue;
            }
            // A piece already threaded has helix edges: it is not a two-circle band; skip it.
            let band = body.face(face).is_some_and(|f| f.loops.len() == 2);
            if !band {
                continue;
            }
            body = thread_face(
                &body,
                face,
                &ThreadRequest {
                    form,
                    frame,
                    z_range: (za, zb),
                    feature,
                    qualifier: Some(at),
                },
            )?;
        }
        Ok(body)
    }
}
