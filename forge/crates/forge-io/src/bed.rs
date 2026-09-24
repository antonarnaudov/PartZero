//! Placing an export on a printer's bed: the bed-fit check and the centring translation that
//! [`crate::try_write_3mf_with`] stores as a build-item `transform` (ALPHA-0-PLAN W5).
//!
//! # Coordinates
//! The slicer convention for a bed: the origin is the front-left corner of the bed surface,
//! X to the right, Y to the back, Z up (the build direction). A part is modelled in its print
//! orientation (Z up, the face that lies on the bed at the bottom), so placing it is a pure
//! translation:
//! - the bounding box of all bodies together is centred on the bed centre in X and Y;
//! - its lowest point goes to z = 0.
//!
//! The meshes are never changed: the 3MF carries the translation, and every body keeps its
//! position relative to the others (a box and its lid stay side by side).
//!
//! # The fit check
//! The usable volume is the bed less [`BuildVolume::margin`] on each side in X and Y (room for
//! a brim or skirt) and the full build height in Z. An export fits when the extent of its
//! bodies is at most the usable size on every axis, compared exactly (no tolerance: a part
//! exactly as large as the usable area fits, anything larger does not), and when its placed
//! footprint does not overlap a [`BuildVolume::exclusions`] rectangle. The extent is measured
//! on the tessellated meshes, which is what the slicer sees; their vertices lie on the exact
//! surfaces, so the mesh box is inside the exact box by at most the chordal tolerance.
//!
//! Every failure is a [`PlacementError`] with a stable [`PlacementError::code`]; a part that
//! does not fit is `EXPORT_BED_FIT` with the offending axes and sizes.

use forge_mesh::BodyMesh;
use thiserror::Error;

use crate::IoError;
use crate::num::push_f64;
use crate::stl::check_mesh;

/// An axis of the bed frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Axis {
    /// Left to right.
    X,
    /// Front to back.
    Y,
    /// Build direction (height).
    Z,
}

impl Axis {
    /// `x`, `y` or `z`.
    pub fn as_str(self) -> &'static str {
        match self {
            Axis::X => "x",
            Axis::Y => "y",
            Axis::Z => "z",
        }
    }

    fn all() -> [Axis; 3] {
        [Axis::X, Axis::Y, Axis::Z]
    }

    fn index(self) -> usize {
        match self {
            Axis::X => 0,
            Axis::Y => 1,
            Axis::Z => 2,
        }
    }
}

/// An axis-aligned rectangle on the bed surface, in bed coordinates (mm).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BedRect {
    /// Front-left corner `[x, y]`.
    pub min: [f64; 2],
    /// Back-right corner `[x, y]`.
    pub max: [f64; 2],
}

impl BedRect {
    /// Whether the interiors of `self` and `other` intersect (touching edges do not count).
    pub fn overlaps(&self, other: &BedRect) -> bool {
        self.min[0] < other.max[0]
            && other.min[0] < self.max[0]
            && self.min[1] < other.max[1]
            && other.min[1] < self.max[1]
    }
}

/// A printer's build volume as an export sees it (from the machine profile).
#[derive(Clone, Debug, PartialEq)]
pub struct BuildVolume {
    /// Bed width (X) and depth (Y) and the maximum print height (Z), mm.
    pub size: [f64; 3],
    /// Clearance kept free on each side of the bed in X and Y, mm (room for a brim or skirt).
    pub margin: f64,
    /// Areas of the bed surface no part may cover, in bed coordinates.
    pub exclusions: Vec<BedRect>,
}

impl BuildVolume {
    /// A bed of `size` with `margin` per side and no exclusion zones.
    pub fn new(size: [f64; 3], margin: f64) -> Self {
        Self {
            size,
            margin,
            exclusions: Vec::new(),
        }
    }

    /// The largest extent that fits: `size − 2·margin` in X and Y, `size` in Z.
    pub fn usable(&self) -> [f64; 3] {
        [
            self.size[0] - 2.0 * self.margin,
            self.size[1] - 2.0 * self.margin,
            self.size[2],
        ]
    }

    /// The centre of the bed surface `[x, y]`.
    pub fn centre(&self) -> [f64; 2] {
        [0.5 * self.size[0], 0.5 * self.size[1]]
    }

    /// Check the numbers: finite, positive sizes, a margin that leaves room, proper rectangles.
    pub fn validate(&self) -> Result<(), PlacementError> {
        let bad = |detail: String| Err(PlacementError::InvalidBed { detail });
        if self.size.iter().any(|s| !s.is_finite() || *s <= 0.0) {
            return bad(format!(
                "the bed size must be positive and finite, got {}",
                mm3(self.size)
            ));
        }
        if !self.margin.is_finite() || self.margin < 0.0 {
            return bad(format!(
                "the margin must be finite and not negative, got {}",
                mm(self.margin)
            ));
        }
        if 2.0 * self.margin >= self.size[0] || 2.0 * self.margin >= self.size[1] {
            return bad(format!(
                "a margin of {} per side leaves no room on a {} × {} mm bed",
                mm(self.margin),
                mm(self.size[0]),
                mm(self.size[1])
            ));
        }
        for (i, r) in self.exclusions.iter().enumerate() {
            let finite = r.min.iter().chain(&r.max).all(|v| v.is_finite());
            if !finite || r.min[0] >= r.max[0] || r.min[1] >= r.max[1] {
                return bad(format!(
                    "exclusion zone {i} is not a rectangle with min < max"
                ));
            }
        }
        Ok(())
    }
}

/// An axis-aligned bounding box, mm.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb {
    /// Minimum corner.
    pub min: [f64; 3],
    /// Maximum corner.
    pub max: [f64; 3],
}

impl Aabb {
    /// `max − min` per axis.
    pub fn extent(&self) -> [f64; 3] {
        [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ]
    }

    /// The box moved by `t`.
    pub fn translated(&self, t: [f64; 3]) -> Aabb {
        Aabb {
            min: [self.min[0] + t[0], self.min[1] + t[1], self.min[2] + t[2]],
            max: [self.max[0] + t[0], self.max[1] + t[1], self.max[2] + t[2]],
        }
    }

    /// The box's shadow on the bed.
    pub fn footprint(&self) -> BedRect {
        BedRect {
            min: [self.min[0], self.min[1]],
            max: [self.max[0], self.max[1]],
        }
    }
}

/// Bounding box of every vertex used by a triangle of `meshes` (what a slicer loads).
///
/// Fails with the mesh's `IO_INVALID_MESH` for an index out of range or a non-finite
/// coordinate, and with `EXPORT_EMPTY` when no mesh has a triangle.
pub fn mesh_bounds(meshes: &[&BodyMesh]) -> Result<Aabb, PlacementError> {
    let mut b: Option<Aabb> = None;
    for (i, m) in meshes.iter().enumerate() {
        check_mesh(m, i)?;
        for t in &m.triangles {
            for &k in t {
                let p = m.positions[k as usize];
                b = Some(match b {
                    None => Aabb { min: p, max: p },
                    Some(a) => Aabb {
                        min: [a.min[0].min(p[0]), a.min[1].min(p[1]), a.min[2].min(p[2])],
                        max: [a.max[0].max(p[0]), a.max[1].max(p[1]), a.max[2].max(p[2])],
                    },
                });
            }
        }
    }
    b.ok_or(PlacementError::Empty)
}

/// Where an export goes on the bed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BedPlacement {
    /// Added to every vertex of every body (the build-item translation), mm.
    pub translation: [f64; 3],
    /// Bounding box of the bodies as modelled.
    pub model: Aabb,
    /// Bounding box on the bed: `model` moved by `translation`.
    pub placed: Aabb,
}

impl BedPlacement {
    /// The 3MF `transform` attribute of a build item: the 3 × 4 affine matrix
    /// `m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32` (3MF core §3.3, row vectors:
    /// `p' = p · M`), here the identity rotation followed by [`BedPlacement::translation`].
    pub fn transform_3mf(&self) -> String {
        transform_attr(self.translation)
    }
}

/// `1 0 0 0 1 0 0 0 1 tx ty tz` in shortest round-trip form.
pub(crate) fn transform_attr(t: [f64; 3]) -> String {
    let mut s = String::from("1 0 0 0 1 0 0 0 1");
    for v in t {
        s.push(' ');
        push_f64(&mut s, v);
    }
    s
}

/// One axis on which an export is larger than the usable bed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Overflow {
    /// The axis.
    pub axis: Axis,
    /// The export's extent along it, mm.
    pub extent: f64,
    /// The usable size along it, mm.
    pub usable: f64,
}

impl Overflow {
    /// How much too large, mm (`extent − usable`, positive).
    pub fn excess(&self) -> f64 {
        self.extent - self.usable
    }
}

/// Why an export cannot be placed on the bed.
#[derive(Clone, Debug, PartialEq, Error)]
pub enum PlacementError {
    /// No mesh has a triangle.
    #[error("the export has no triangles to place on the bed")]
    Empty,
    /// A mesh is invalid (index out of range, non-finite coordinate).
    #[error(transparent)]
    Mesh(#[from] IoError),
    /// The build volume's numbers make no sense.
    #[error("invalid build volume: {detail}")]
    InvalidBed {
        /// What is wrong.
        detail: String,
    },
    /// The export is larger than the usable bed on at least one axis.
    #[error(
        "the part is {} but at most {} fits ({} less a {} margin per side): {}",
        mm3(*.extent),
        mm3(*.usable),
        bed_xy(*.size),
        mm(*.margin),
        overflow_text(.overflows)
    )]
    DoesNotFit {
        /// The export's extent (X, Y, Z), mm.
        extent: [f64; 3],
        /// The usable size (X, Y, Z), mm.
        usable: [f64; 3],
        /// The bed size (X, Y, Z), mm.
        size: [f64; 3],
        /// The margin per side, mm.
        margin: f64,
        /// Each axis that is too large, in X, Y, Z order.
        overflows: Vec<Overflow>,
    },
    /// The placed footprint covers an exclusion zone of the bed.
    #[error(
        "the part's footprint on the bed ({} – {}) overlaps exclusion zone {zone} ({} – {})",
        xy(.footprint.min),
        xy(.footprint.max),
        xy(.rect.min),
        xy(.rect.max)
    )]
    ExclusionZone {
        /// Index into [`BuildVolume::exclusions`].
        zone: usize,
        /// The zone.
        rect: BedRect,
        /// The export's footprint after centring.
        footprint: BedRect,
    },
}

impl PlacementError {
    /// Stable machine-readable code: `EXPORT_BED_FIT` (too large, or on an exclusion zone),
    /// `EXPORT_BED_INVALID`, `EXPORT_EMPTY`, or the mesh error's own code.
    pub fn code(&self) -> &'static str {
        match self {
            PlacementError::Empty => "EXPORT_EMPTY",
            PlacementError::Mesh(e) => e.code(),
            PlacementError::InvalidBed { .. } => "EXPORT_BED_INVALID",
            PlacementError::DoesNotFit { .. } | PlacementError::ExclusionZone { .. } => {
                "EXPORT_BED_FIT"
            }
        }
    }
}

/// Check that `meshes` fit `bed` and compute the translation that centres them on it
/// (see the module docs). Deterministic: plain IEEE arithmetic on the input coordinates.
pub fn place_on_bed(
    meshes: &[&BodyMesh],
    bed: &BuildVolume,
) -> Result<BedPlacement, PlacementError> {
    bed.validate()?;
    let model = mesh_bounds(meshes)?;
    let extent = model.extent();
    let usable = bed.usable();
    let overflows: Vec<Overflow> = Axis::all()
        .into_iter()
        .filter(|a| extent[a.index()] > usable[a.index()])
        .map(|a| Overflow {
            axis: a,
            extent: extent[a.index()],
            usable: usable[a.index()],
        })
        .collect();
    if !overflows.is_empty() {
        return Err(PlacementError::DoesNotFit {
            extent,
            usable,
            size: bed.size,
            margin: bed.margin,
            overflows,
        });
    }
    let c = bed.centre();
    // `+ 0.0` turns a −0 into +0, so the written transform never says "-0".
    let translation = [
        c[0] - 0.5 * (model.min[0] + model.max[0]) + 0.0,
        c[1] - 0.5 * (model.min[1] + model.max[1]) + 0.0,
        -model.min[2] + 0.0,
    ];
    let placed = model.translated(translation);
    let footprint = placed.footprint();
    if let Some((zone, rect)) = bed
        .exclusions
        .iter()
        .enumerate()
        .find(|(_, r)| r.overlaps(&footprint))
    {
        return Err(PlacementError::ExclusionZone {
            zone,
            rect: *rect,
            footprint,
        });
    }
    Ok(BedPlacement {
        translation,
        model,
        placed,
    })
}

/// A layout that a slicer may load differently from the model (see [`layout_warnings`]).
///
/// Slicers drop each object of a plain 3MF onto the plate on import (Bambu Studio does, see
/// `docs/SLICER-HANDOFF.md`), and [`place_on_bed`] moves all bodies together. A body that does
/// not reach the bed is therefore printed lower than modelled, and a body stacked above another
/// ends up inside it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LayoutWarning {
    /// The body's lowest point is `z_min` above the bed after placement.
    Floating {
        /// Index into the meshes.
        body: usize,
        /// Height of its lowest point above the bed, mm (more than the contact tolerance).
        z_min: f64,
    },
    /// The bodies' footprints overlap (their interiors intersect) and at least one of them
    /// floats: one is stacked above the other, and dropped onto the plate they would occupy the
    /// same space.
    StackedOverlap {
        /// Indices into the meshes, the lower index first.
        bodies: [usize; 2],
        /// Where the footprints overlap, in bed coordinates.
        overlap: BedRect,
    },
}

impl LayoutWarning {
    /// Stable machine-readable code: `EXPORT_BODY_FLOATING` or `EXPORT_BODIES_OVERLAP`.
    pub fn code(&self) -> &'static str {
        match self {
            LayoutWarning::Floating { .. } => "EXPORT_BODY_FLOATING",
            LayoutWarning::StackedOverlap { .. } => "EXPORT_BODIES_OVERLAP",
        }
    }

    /// A plain sentence, naming each body with `name(index)`.
    pub fn describe(&self, name: impl Fn(usize) -> String) -> String {
        match self {
            LayoutWarning::Floating { body, z_min } => format!(
                "{} starts {} above the bed; a slicer drops it onto the plate",
                name(*body),
                mm(*z_min)
            ),
            LayoutWarning::StackedOverlap { bodies, overlap } => format!(
                "{} and {} are stacked: they overlap on the bed ({} – {}) and one floats above the other, so dropped onto the plate they would print inside each other",
                name(bodies[0]),
                name(bodies[1]),
                xy(overlap.min),
                xy(overlap.max)
            ),
        }
    }
}

/// What a slicer would do differently from the model with bodies placed by `placement`
/// (see [`LayoutWarning`]): every floating body in index order, then every stacked pair in
/// `(i, j)` order. Deterministic; empty when every body rests on the bed.
///
/// `contact_tolerance` (mm, finite, not negative): a body whose lowest point is at most this far
/// above the bed counts as resting on it. Pass at least the chordal tolerance of the
/// tessellation: the vertices lie on the exact surfaces, so the mesh of a curved underside (a
/// cylinder on its side) can sit up to that far above the point that touches the bed.
pub fn layout_warnings(
    meshes: &[&BodyMesh],
    placement: &BedPlacement,
    contact_tolerance: f64,
) -> Result<Vec<LayoutWarning>, PlacementError> {
    if !contact_tolerance.is_finite() || contact_tolerance < 0.0 {
        return Err(PlacementError::InvalidBed {
            detail: format!(
                "the contact tolerance must be finite and not negative, got {}",
                mm(contact_tolerance)
            ),
        });
    }
    let mut placed = Vec::with_capacity(meshes.len());
    for (i, m) in meshes.iter().enumerate() {
        check_mesh(m, i)?;
        // A body without triangles has no footprint and nothing for a slicer to drop.
        placed.push(
            mesh_bounds(&[*m])
                .ok()
                .map(|b| b.translated(placement.translation)),
        );
    }
    let floats = |b: &Aabb| b.min[2] > contact_tolerance;
    let mut out: Vec<LayoutWarning> = placed
        .iter()
        .enumerate()
        .filter_map(|(body, b)| match b {
            Some(b) if floats(b) => Some(LayoutWarning::Floating {
                body,
                z_min: b.min[2],
            }),
            _ => None,
        })
        .collect();
    for (i, a) in placed.iter().enumerate() {
        let Some(a) = a else { continue };
        for (j, b) in placed.iter().enumerate().skip(i + 1) {
            let Some(b) = b else { continue };
            let (fa, fb) = (a.footprint(), b.footprint());
            if (floats(a) || floats(b)) && fa.overlaps(&fb) {
                out.push(LayoutWarning::StackedOverlap {
                    bodies: [i, j],
                    overlap: BedRect {
                        min: [fa.min[0].max(fb.min[0]), fa.min[1].max(fb.min[1])],
                        max: [fa.max[0].min(fb.max[0]), fa.max[1].min(fb.max[1])],
                    },
                });
            }
        }
    }
    Ok(out)
}

/// A length for messages: at most 3 decimals, trailing zeros dropped, with the unit.
fn mm(v: f64) -> String {
    format!("{} mm", num3(v))
}

fn num3(v: f64) -> String {
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.into() }
}

fn mm3(v: [f64; 3]) -> String {
    format!("{} × {} × {} mm", num3(v[0]), num3(v[1]), num3(v[2]))
}

fn bed_xy(size: [f64; 3]) -> String {
    format!("a {} × {} mm bed", num3(size[0]), num3(size[1]))
}

fn xy(p: [f64; 2]) -> String {
    format!("{}, {}", num3(p[0]), num3(p[1]))
}

fn overflow_text(o: &[Overflow]) -> String {
    o.iter()
        .map(|o| {
            format!(
                "{} too large in {}",
                mm(o.excess()),
                o.axis.as_str().to_uppercase()
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    fn tri(p: [[f64; 3]; 3]) -> BodyMesh {
        BodyMesh {
            positions: p.to_vec(),
            normals: vec![],
            triangles: vec![[0, 1, 2]],
            face_ranges: vec![],
            edge_polylines: vec![],
        }
    }

    #[test]
    fn transform_attribute_is_identity_plus_translation_without_negative_zero() {
        assert_eq!(
            transform_attr([128.0, 0.0, 1.5]),
            "1 0 0 0 1 0 0 0 1 128 0 1.5"
        );
        assert_eq!(
            transform_attr([-0.0, 1e-7, 3.0]),
            "1 0 0 0 1 0 0 0 1 0 1e-7 3"
        );
    }

    #[test]
    fn lowest_point_goes_to_zero_and_zero_translation_is_positive_zero() {
        let m = tri([[-10.0, -5.0, 0.0], [10.0, -5.0, 0.0], [0.0, 5.0, 0.0]]);
        let bed = BuildVolume::new([20.0, 10.0, 5.0], 0.0);
        let p = place_on_bed(&[&m], &bed).expect("fits exactly");
        assert_eq!(p.translation, [10.0, 5.0, 0.0]);
        assert!(p.translation[2].is_sign_positive());
    }

    #[test]
    fn messages_name_the_axis_and_the_numbers() {
        let m = tri([[0.0, 0.0, 0.0], [250.0, 0.0, 0.0], [0.0, 40.0, 30.0]]);
        let bed = BuildVolume::new([256.0, 256.0, 256.0], 10.0);
        let e = place_on_bed(&[&m], &bed).unwrap_err();
        assert_eq!(e.code(), "EXPORT_BED_FIT");
        assert_eq!(
            e.to_string(),
            "the part is 250 × 40 × 30 mm but at most 236 × 236 × 256 mm fits (a 256 × 256 mm bed less a 10 mm margin per side): 14 mm too large in X"
        );
    }
}
