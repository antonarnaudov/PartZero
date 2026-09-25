//! Deterministic corpus of boolean cases built from IR v0-style operands (one sketch and
//! one extrude or revolve each). Shared by the property tests, the OCCT differential
//! (`forge-ops/oracle/occt_boolean_diff.py`, which rebuilds every operand with the oracle's
//! own v0 evaluator) and benchmarks.
//!
//! Families (round-robin, operations cycling join / cut / intersect):
//! - `box-box`, `box-cyl`, `cyl-cyl`, `slot`, `hole`, `poly`: prismatic operands on the
//!   principal planes, sizes and offsets on a 0.5 mm grid, so that coplanar faces,
//!   coincident edges and equal radii occur exactly and often;
//! - `rotated`: prismatic operands on rotated sketch frames (general position);
//! - `revolve`: revolved profiles (tubes, discs, tori, spheres, cones, partial angles)
//!   against prismatic or revolved operands;
//! - `coplanar`: the tool shares a face plane with the target (same side);
//! - `touching`: the tool touches the target face to face (opposite sides);
//! - `nested`: the tool strictly inside the target;
//! - `disjoint`: the tool away from the target (expected `BOOLEAN_NO_INTERSECTION` /
//!   `BOOLEAN_EMPTY_RESULT`).

use forge_core::Tolerance;
use forge_core::math;
use forge_core::topo::Body;
use forge_ir::{
    BodyOp as IrBodyOp, Document, ExtrudeFeature, Feature, Frame, Meta, NamedPlane, PartStudio,
    PlaneSpec, RegionSelection, RevolveFeature, SketchAxis, SketchCurve, SketchFeature,
    SweepDirection, Units,
};

use super::BodyOp;
use crate::error::OpError;
use crate::{extrude, regions, revolve, sketch_frame};

/// The sweep of an operand.
#[derive(Clone, Debug, PartialEq)]
pub enum Sweep {
    /// Extrude (v0 §4.2).
    Extrude {
        /// Distance (mm).
        distance: f64,
        /// Direction.
        direction: SweepDirection,
    },
    /// Revolve (v0 §4.3).
    Revolve {
        /// Axis in sketch coordinates.
        axis: SketchAxis,
        /// Angle (degrees).
        angle: f64,
        /// Direction.
        direction: SweepDirection,
    },
}

/// One operand: a sketch with one region and its sweep.
#[derive(Clone, Debug, PartialEq)]
pub struct Operand {
    /// Feature id of the sweep (provenance of the body's entities).
    pub feature: String,
    /// The sketch (id and name `"s_<feature>"`).
    pub sketch: SketchFeature,
    /// Its sweep.
    pub sweep: Sweep,
}

impl Operand {
    /// Build the body as forge-regen does (regions, then extrude or revolve).
    pub fn build(&self) -> Result<Body, OpError> {
        let mut rs = regions(&self.sketch, &Tolerance::IR_DEFAULT)?;
        if rs.len() != 1 {
            return Err(OpError::Internal(format!(
                "corpus operand {} has {} regions",
                self.feature,
                rs.len()
            )));
        }
        let r = rs.remove(0);
        let frame = sketch_frame(&self.sketch.plane)?;
        match &self.sweep {
            Sweep::Extrude {
                distance,
                direction,
            } => extrude(&r, &frame, *distance, *direction, &self.feature),
            Sweep::Revolve {
                axis,
                angle,
                direction,
            } => revolve(&r, &frame, axis, *angle, *direction, &self.feature),
        }
    }

    /// The operand as an `aicad.ir/0` document with one part (for the oracle).
    pub fn document(&self) -> Document {
        let sweep = match &self.sweep {
            Sweep::Extrude {
                distance,
                direction,
            } => Feature::Extrude(ExtrudeFeature {
                id: self.feature.clone(),
                name: self.feature.clone(),
                suppressed: false,
                sketch: self.sketch.name.clone(),
                regions: RegionSelection::All,
                distance: *distance,
                direction: *direction,
                op: IrBodyOp::NewBody,
            }),
            Sweep::Revolve {
                axis,
                angle,
                direction,
            } => Feature::Revolve(RevolveFeature {
                id: self.feature.clone(),
                name: self.feature.clone(),
                suppressed: false,
                sketch: self.sketch.name.clone(),
                regions: RegionSelection::All,
                axis: axis.clone(),
                angle: *angle,
                direction: *direction,
                op: IrBodyOp::NewBody,
            }),
        };
        Document {
            schema: "aicad.ir/0".into(),
            meta: Meta {
                name: self.feature.clone(),
                description: String::new(),
            },
            units: Units::default(),
            parts: vec![PartStudio {
                id: "p".into(),
                name: "p".into(),
                features: vec![Feature::Sketch(self.sketch.clone()), sweep],
            }],
        }
    }
}

/// A boolean case: `a op b`.
#[derive(Clone, Debug, PartialEq)]
pub struct Case {
    /// Index in the corpus.
    pub id: usize,
    /// Family name.
    pub family: &'static str,
    /// Target.
    pub a: Operand,
    /// Tool.
    pub b: Operand,
    /// Operation.
    pub op: BodyOp,
}

/// SplitMix64.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    /// Seeded generator.
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }
    /// Next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Uniform in `[lo, hi)`.
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
    /// Uniform integer in `[0, n)`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    /// A multiple of `step` in `[lo, hi]`.
    pub fn grid(&mut self, lo: f64, hi: f64, step: f64) -> f64 {
        let n = ((hi - lo) / step).floor() as usize;
        lo + step * self.below(n + 1) as f64
    }
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

fn rect(x0: f64, y0: f64, w: f64, h: f64) -> Vec<SketchCurve> {
    vec![
        line("b", [x0, y0], [x0 + w, y0]),
        line("r", [x0 + w, y0], [x0 + w, y0 + h]),
        line("t", [x0 + w, y0 + h], [x0, y0 + h]),
        line("l", [x0, y0 + h], [x0, y0]),
    ]
}

fn circle(id: &str, c: [f64; 2], r: f64) -> SketchCurve {
    SketchCurve::Circle {
        id: id.into(),
        center: c,
        radius: r,
    }
}

/// A slot along x: centre `c`, straight length `len`, radius `r`.
fn slot(c: [f64; 2], len: f64, r: f64) -> Vec<SketchCurve> {
    let (x0, x1) = (c[0] - 0.5 * len, c[0] + 0.5 * len);
    let (y0, y1) = (c[1] - r, c[1] + r);
    vec![
        line("b", [x0, y0], [x1, y0]),
        SketchCurve::Arc {
            id: "e".into(),
            start: [x1, y0],
            end: [x1, y1],
            center: [x1, c[1]],
            ccw: true,
        },
        line("t", [x1, y1], [x0, y1]),
        SketchCurve::Arc {
            id: "w".into(),
            start: [x0, y1],
            end: [x0, y0],
            center: [x0, c[1]],
            ccw: true,
        },
    ]
}

fn polygon(c: [f64; 2], r: f64, n: usize, phase: f64) -> Vec<SketchCurve> {
    let pts: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let a = phase + math::TAU * i as f64 / n as f64;
            let (sa, ca) = math::sin_cos(a);
            [c[0] + r * ca, c[1] + r * sa]
        })
        .collect();
    (0..n)
        .map(|i| line(&format!("p{i}"), pts[i], pts[(i + 1) % n]))
        .collect()
}

fn sketch(feature: &str, plane: PlaneSpec, curves: Vec<SketchCurve>) -> SketchFeature {
    SketchFeature {
        id: format!("s_{feature}"),
        name: format!("s_{feature}"),
        suppressed: false,
        plane,
        curves,
    }
}

/// A principal plane offset along its normal (an explicit frame).
fn plane(kind: usize, offset: f64) -> PlaneSpec {
    match kind % 3 {
        0 => PlaneSpec::Frame(Frame {
            origin: [0.0, 0.0, offset],
            normal: [0.0, 0.0, 1.0],
            x_dir: [1.0, 0.0, 0.0],
        }),
        1 => PlaneSpec::Frame(Frame {
            origin: [0.0, -offset, 0.0],
            normal: [0.0, -1.0, 0.0],
            x_dir: [1.0, 0.0, 0.0],
        }),
        _ => PlaneSpec::Frame(Frame {
            origin: [offset, 0.0, 0.0],
            normal: [1.0, 0.0, 0.0],
            x_dir: [0.0, 1.0, 0.0],
        }),
    }
}

fn named(kind: usize) -> PlaneSpec {
    PlaneSpec::Named(match kind % 3 {
        0 => NamedPlane::XY,
        1 => NamedPlane::XZ,
        _ => NamedPlane::YZ,
    })
}

fn rotated_plane(rng: &mut Rng) -> PlaneSpec {
    let n = [
        rng.range(-1.0, 1.0),
        rng.range(-1.0, 1.0),
        rng.range(0.2, 1.0),
    ];
    let len = math::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    let n = [n[0] / len, n[1] / len, n[2] / len];
    // x ⟂ n.
    let a = if n[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
    let x = [a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]];
    PlaneSpec::Frame(Frame {
        origin: [
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
        ],
        normal: n,
        x_dir: x,
    })
}

fn dir(rng: &mut Rng) -> SweepDirection {
    match rng.below(3) {
        0 => SweepDirection::Normal,
        1 => SweepDirection::Reverse,
        _ => SweepDirection::Symmetric,
    }
}

fn extrude_op(
    feature: &str,
    plane: PlaneSpec,
    curves: Vec<SketchCurve>,
    d: f64,
    dirn: SweepDirection,
) -> Operand {
    Operand {
        feature: feature.into(),
        sketch: sketch(feature, plane, curves),
        sweep: Sweep::Extrude {
            distance: d,
            direction: dirn,
        },
    }
}

/// A prismatic operand on a principal plane, on the 0.5 mm grid.
fn prism(rng: &mut Rng, feature: &str, shape: usize) -> Operand {
    // Operands straddle the origin region so that most pairs overlap.
    let pk = rng.below(3);
    let off = rng.grid(-3.0, 0.0, 0.5);
    let pl = if rng.below(4) == 0 {
        named(pk)
    } else {
        plane(pk, off)
    };
    let (x0, y0) = (rng.grid(-5.0, -1.0, 0.5), rng.grid(-5.0, -1.0, 0.5));
    let (w, h) = (rng.grid(3.0, 10.0, 0.5), rng.grid(3.0, 10.0, 0.5));
    let curves = match shape % 5 {
        0 => rect(x0, y0, w, h),
        1 => vec![circle(
            "c",
            [x0 + 0.5 * w, y0 + 0.5 * h],
            rng.grid(1.0, 5.0, 0.5),
        )],
        2 => slot(
            [x0 + 0.5 * w, y0 + 0.5 * h],
            rng.grid(1.0, 6.0, 0.5),
            rng.grid(1.0, 3.0, 0.5),
        ),
        3 => {
            let mut c = rect(x0, y0, w.max(4.0), h.max(4.0));
            let r = rng.grid(0.5, (w.max(4.0).min(h.max(4.0)) * 0.5 - 1.0).max(0.5), 0.5);
            c.push(circle(
                "h",
                [x0 + 0.5 * w.max(4.0), y0 + 0.5 * h.max(4.0)],
                r,
            ));
            c
        }
        _ => polygon(
            [x0 + 0.5 * w, y0 + 0.5 * h],
            rng.grid(1.5, 5.0, 0.5),
            3 + rng.below(4),
            [0.0, 0.25, 0.5][rng.below(3)],
        ),
    };
    extrude_op(feature, pl, curves, rng.grid(2.0, 10.0, 0.5), dir(rng))
}

/// A revolved operand about the sketch's y axis (profile at x > 0, or touching the axis).
fn revolved(rng: &mut Rng, feature: &str) -> Operand {
    let pk = rng.below(3);
    let pl = plane(pk, rng.grid(-2.0, 2.0, 0.5));
    let axis = SketchAxis {
        origin: [0.0, 0.0],
        direction: [0.0, 1.0],
    };
    let y0 = rng.grid(-5.0, 1.0, 0.5);
    let curves = match rng.below(5) {
        // Tube / disc: a rectangle off the axis.
        0 => rect(
            rng.grid(0.5, 3.0, 0.5),
            y0,
            rng.grid(1.0, 4.0, 0.5),
            rng.grid(1.0, 6.0, 0.5),
        ),
        // Solid cylinder: a rectangle on the axis.
        1 => rect(0.0, y0, rng.grid(1.0, 5.0, 0.5), rng.grid(1.0, 6.0, 0.5)),
        // Torus.
        2 => {
            let r = rng.grid(0.5, 2.0, 0.5);
            vec![circle("c", [r + rng.grid(1.0, 4.0, 0.5), y0 + 3.0], r)]
        }
        // Sphere: a half disc on the axis.
        3 => {
            let r = rng.grid(1.0, 5.0, 0.5);
            let c = y0 + 3.0;
            vec![
                line("a", [0.0, c - r], [0.0, c + r]),
                SketchCurve::Arc {
                    id: "s".into(),
                    start: [0.0, c + r],
                    end: [0.0, c - r],
                    center: [0.0, c],
                    ccw: false,
                },
            ]
        }
        // Cone: a right triangle on the axis.
        _ => {
            let (r, h) = (rng.grid(1.0, 5.0, 0.5), rng.grid(1.0, 6.0, 0.5));
            vec![
                line("a", [0.0, y0], [r, y0]),
                line("h", [r, y0], [0.0, y0 + h]),
                line("x", [0.0, y0 + h], [0.0, y0]),
            ]
        }
    };
    let angle = if rng.below(3) == 0 {
        rng.grid(60.0, 300.0, 15.0)
    } else {
        360.0
    };
    Operand {
        feature: feature.into(),
        sketch: sketch(feature, pl, curves),
        sweep: Sweep::Revolve {
            axis,
            angle,
            direction: if rng.below(2) == 0 {
                SweepDirection::Normal
            } else {
                SweepDirection::Symmetric
            },
        },
    }
}

/// Box `[x0, x0 + w] × [y0, y0 + h] × [z0, z0 + d]` as an extrude on XY.
fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Operand {
    extrude_op(
        feature,
        plane(0, lo[2]),
        rect(lo[0], lo[1], size[0], size[1]),
        size[2],
        SweepDirection::Normal,
    )
}

/// The deterministic corpus: `n` cases from `seed`.
pub fn cases(seed: u64, n: usize) -> Vec<Case> {
    const FAMILIES: [&str; 12] = [
        "box-box", "box-cyl", "cyl-cyl", "slot", "hole", "poly", "rotated", "revolve", "coplanar",
        "touching", "nested", "disjoint",
    ];
    let mut rng = Rng::new(seed);
    let mut out = Vec::with_capacity(n);
    for id in 0..n {
        let family = FAMILIES[id % FAMILIES.len()];
        let op = [BodyOp::Join, BodyOp::Cut, BodyOp::Intersect][(id / FAMILIES.len()) % 3];
        let (a, b) = match family {
            "box-box" => (prism(&mut rng, "a", 0), prism(&mut rng, "b", 0)),
            "box-cyl" => (prism(&mut rng, "a", 0), prism(&mut rng, "b", 1)),
            "cyl-cyl" => (prism(&mut rng, "a", 1), prism(&mut rng, "b", 1)),
            "slot" => {
                let k = rng.below(2);
                (prism(&mut rng, "a", k), prism(&mut rng, "b", 2))
            }
            "hole" => {
                let k = rng.below(3);
                (prism(&mut rng, "a", 3), prism(&mut rng, "b", k))
            }
            "poly" => {
                let k = rng.below(5);
                (prism(&mut rng, "a", 4), prism(&mut rng, "b", k))
            }
            "rotated" => {
                let (ka, kb) = (rng.below(5), rng.below(5));
                let mut a = prism(&mut rng, "a", ka);
                let mut b = prism(&mut rng, "b", kb);
                if rng.below(2) == 0 {
                    a.sketch.plane = rotated_plane(&mut rng);
                }
                b.sketch.plane = rotated_plane(&mut rng);
                (a, b)
            }
            "revolve" => {
                let a = if rng.below(2) == 0 {
                    let k = rng.below(5);
                    prism(&mut rng, "a", k)
                } else {
                    revolved(&mut rng, "a")
                };
                (a, revolved(&mut rng, "b"))
            }
            "coplanar" => {
                // Same z range bottom or top: a box and a box/cylinder sharing a face plane.
                let lo = [
                    rng.grid(-4.0, 0.0, 0.5),
                    rng.grid(-4.0, 0.0, 0.5),
                    rng.grid(-2.0, 0.0, 0.5),
                ];
                let size = [
                    rng.grid(3.0, 8.0, 0.5),
                    rng.grid(3.0, 8.0, 0.5),
                    rng.grid(2.0, 6.0, 0.5),
                ];
                let a = aabox("a", lo, size);
                let h = if rng.below(2) == 0 {
                    size[2]
                } else {
                    rng.grid(1.0, size[2] + 2.0, 0.5)
                };
                let blo = [
                    lo[0] + rng.grid(-2.0, size[0] - 1.0, 0.5),
                    lo[1] + rng.grid(-2.0, size[1] - 1.0, 0.5),
                    lo[2],
                ];
                let b = if rng.below(2) == 0 {
                    aabox(
                        "b",
                        blo,
                        [rng.grid(1.0, 6.0, 0.5), rng.grid(1.0, 6.0, 0.5), h],
                    )
                } else {
                    extrude_op(
                        "b",
                        plane(0, lo[2]),
                        vec![circle("c", [blo[0], blo[1]], rng.grid(1.0, 3.0, 0.5))],
                        h,
                        SweepDirection::Normal,
                    )
                };
                (a, b)
            }
            "touching" => {
                let lo = [
                    rng.grid(-4.0, 0.0, 0.5),
                    rng.grid(-4.0, 0.0, 0.5),
                    rng.grid(-2.0, 0.0, 0.5),
                ];
                let size = [
                    rng.grid(3.0, 8.0, 0.5),
                    rng.grid(3.0, 8.0, 0.5),
                    rng.grid(2.0, 6.0, 0.5),
                ];
                let a = aabox("a", lo, size);
                // On top of a, overlapping in x/y.
                let blo = [
                    lo[0] + rng.grid(-2.0, size[0] - 1.0, 0.5),
                    lo[1] + rng.grid(-2.0, size[1] - 1.0, 0.5),
                    lo[2] + size[2],
                ];
                let b = if rng.below(2) == 0 {
                    aabox(
                        "b",
                        blo,
                        [
                            rng.grid(1.0, 6.0, 0.5),
                            rng.grid(1.0, 6.0, 0.5),
                            rng.grid(1.0, 4.0, 0.5),
                        ],
                    )
                } else {
                    extrude_op(
                        "b",
                        plane(0, blo[2]),
                        vec![circle(
                            "c",
                            [blo[0] + 1.0, blo[1] + 1.0],
                            rng.grid(0.5, 2.0, 0.5),
                        )],
                        rng.grid(1.0, 4.0, 0.5),
                        SweepDirection::Normal,
                    )
                };
                (a, b)
            }
            "nested" => {
                let lo = [
                    rng.grid(-6.0, -2.0, 0.5),
                    rng.grid(-6.0, -2.0, 0.5),
                    rng.grid(-6.0, -2.0, 0.5),
                ];
                let size = [
                    rng.grid(6.0, 10.0, 0.5),
                    rng.grid(6.0, 10.0, 0.5),
                    rng.grid(6.0, 10.0, 0.5),
                ];
                let a = aabox("a", lo, size);
                let c = [lo[0] + 0.5 * size[0], lo[1] + 0.5 * size[1]];
                let b = if rng.below(2) == 0 {
                    aabox(
                        "b",
                        [c[0] - 1.0, c[1] - 1.5, lo[2] + 1.0],
                        [2.0, 3.0, size[2] - 2.0],
                    )
                } else {
                    extrude_op(
                        "b",
                        plane(0, lo[2] + 1.5),
                        vec![circle("c", c, rng.grid(1.0, 2.5, 0.5))],
                        size[2] - 3.0,
                        SweepDirection::Normal,
                    )
                };
                (a, b)
            }
            _ => {
                let lo = [rng.grid(-4.0, 0.0, 0.5), rng.grid(-4.0, 0.0, 0.5), 0.0];
                let size = [
                    rng.grid(2.0, 5.0, 0.5),
                    rng.grid(2.0, 5.0, 0.5),
                    rng.grid(2.0, 5.0, 0.5),
                ];
                let a = aabox("a", lo, size);
                let gap = rng.grid(0.5, 3.0, 0.5);
                let b = aabox("b", [lo[0] + size[0] + gap, lo[1], 0.0], [2.0, 2.0, 2.0]);
                (a, b)
            }
        };
        out.push(Case {
            id,
            family,
            a,
            b,
            op,
        });
    }
    out
}

// ---- chained operations ---------------------------------------------------------------

/// Sketch plane at `o` whose sketch `y` direction is world `+Y` (a revolve about the sketch
/// `y` axis has its poles on a line parallel to world Y): normal `+Z`, x `+X`.
fn frame_axis_y(o: [f64; 3]) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin: o,
        normal: [0.0, 0.0, 1.0],
        x_dir: [1.0, 0.0, 0.0],
    })
}

/// Sphere of radius `r` at `c`: a 360° revolve of a half disc about the sketch `y` axis,
/// with the revolve axis along world X, Y or Z (`axis` 0, 1, 2): the same solid, with its
/// poles and meridians in different places.
pub fn sphere_operand(feature: &str, c: [f64; 3], r: f64, axis: usize) -> Operand {
    let plane = match axis % 3 {
        // normal +Z, x +Y: sketch y = Z × Y = −X.
        0 => PlaneSpec::Frame(Frame {
            origin: c,
            normal: [0.0, 0.0, 1.0],
            x_dir: [0.0, 1.0, 0.0],
        }),
        1 => frame_axis_y(c),
        // normal +Y, x +X: sketch y = Y × X = −Z.
        _ => PlaneSpec::Frame(Frame {
            origin: c,
            normal: [0.0, 1.0, 0.0],
            x_dir: [1.0, 0.0, 0.0],
        }),
    };
    Operand {
        feature: feature.into(),
        sketch: sketch(
            feature,
            plane,
            vec![
                SketchCurve::Arc {
                    id: "a".into(),
                    start: [0.0, -r],
                    end: [0.0, r],
                    center: [0.0, 0.0],
                    ccw: true,
                },
                line("l", [0.0, r], [0.0, -r]),
            ],
        ),
        sweep: Sweep::Revolve {
            axis: SketchAxis {
                origin: [0.0, 0.0],
                direction: [0.0, 1.0],
            },
            angle: 360.0,
            direction: SweepDirection::Normal,
        },
    }
}

/// Cylinder of radius `r` along world axis `axis` (0 X, 1 Y, 2 Z) from `lo` (its lowest
/// coordinate along the axis) for `h`; `c` is the centre in the other two coordinates (in
/// increasing axis order: `(y, z)`, `(x, z)`, `(x, y)`).
pub fn cylinder_operand(
    feature: &str,
    axis: usize,
    c: [f64; 2],
    lo: f64,
    r: f64,
    h: f64,
) -> Operand {
    let (plane, centre) = match axis % 3 {
        // normal +X, x +Y: sketch (x, y) = (Y, Z).
        0 => (
            PlaneSpec::Frame(Frame {
                origin: [lo, 0.0, 0.0],
                normal: [1.0, 0.0, 0.0],
                x_dir: [0.0, 1.0, 0.0],
            }),
            c,
        ),
        // normal +Y, x +X: sketch y = Y × X = −Z, so (x, y) = (X, −Z).
        1 => (
            PlaneSpec::Frame(Frame {
                origin: [0.0, lo, 0.0],
                normal: [0.0, 1.0, 0.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            [c[0], -c[1]],
        ),
        _ => (plane(0, lo), c),
    };
    extrude_op(
        feature,
        plane,
        vec![circle("c", centre, r)],
        h,
        SweepDirection::Normal,
    )
}

/// The target every operation chain starts from: the box `[0, 4] × [0, 4] × [0, 2]`.
pub fn chain_base() -> Operand {
    aabox("t", [0.0, 0.0, 0.0], [4.0, 4.0, 2.0])
}

/// A random tool of an operation chain, on a 0.25 mm grid around the base box so that
/// faces coincide, circles touch edges, spheres touch faces at edges and poles lie on
/// faces exactly and often: boxes, cylinders along X, Y and Z, and spheres revolved about
/// X, Y or Z.
pub fn chain_tool(rng: &mut Rng, feature: &str) -> Operand {
    let g = 0.25;
    match rng.below(6) {
        0 | 1 => aabox(
            feature,
            [
                rng.grid(-1.0, 4.0, g),
                rng.grid(-1.0, 4.0, g),
                rng.grid(-1.0, 2.5, g),
            ],
            [
                rng.grid(0.25, 3.0, g),
                rng.grid(0.25, 3.0, g),
                rng.grid(0.25, 3.0, g),
            ],
        ),
        2 | 3 => {
            let axis = rng.below(3);
            // Extent of the base box along the axis and across it.
            let (along, across) = match axis {
                0 => (4.0, [4.0, 2.0]),
                1 => (4.0, [4.0, 2.0]),
                _ => (2.0, [4.0, 4.0]),
            };
            let c = [
                rng.grid(-0.5, across[0] + 0.5, g),
                rng.grid(-0.5, across[1] + 0.5, g),
            ];
            let r = rng.grid(0.25, 1.5, g);
            let lo = rng.grid(-1.0, along - 0.25, g);
            let h = rng.grid(0.25, along + 1.0 - lo, g).max(0.25);
            cylinder_operand(feature, axis, c, lo, r, h)
        }
        _ => {
            let c = [
                rng.grid(-0.5, 4.5, g),
                rng.grid(-0.5, 4.5, g),
                rng.grid(-0.5, 2.5, g),
            ];
            let r = rng.grid(0.25, 1.5, g);
            sphere_operand(feature, c, r, rng.below(3))
        }
    }
}

/// One step of an operation chain: the three operations of the current target `a` with a
/// new tool.
pub struct ChainStep<'a> {
    /// Chain index.
    pub chain: usize,
    /// Step index within the chain.
    pub step: usize,
    /// The current target (the base box, or a result of an earlier step).
    pub a: &'a Body,
    /// The tool's recipe and body.
    pub tool: &'a Operand,
    /// Its body.
    pub b: &'a Body,
    /// `A ∪ B`, `A − B`, `A ∩ B`.
    pub results: &'a [(BodyOp, Result<super::BodyOpResult, super::BooleanError>)],
}

/// Run `chains` operation chains of `steps` steps from `seed`: every step applies join, cut
/// and intersect to the current target and a random tool ([`chain_tool`]), shows them to
/// `visit`, then continues with the one-body result of the cut or the join (chosen at
/// random; the target stays when neither gave one body). Operands are chained **Forge
/// results**, so defects that only show on Forge's own output topology (a loop through a
/// vertex twice, a circle touching an edge, vertices at poles) are exercised.
pub fn run_chains(seed: u64, chains: usize, steps: usize, mut visit: impl FnMut(&ChainStep<'_>)) {
    use super::{OpBody, apply_body_op};
    use forge_ir::v1::metrics::Origin;
    let origin = |f: &str| Origin {
        feature: f.into(),
        member: "m".into(),
        instance: None,
    };
    let mut rng = Rng::new(seed);
    for chain in 0..chains {
        let Ok(mut a) = chain_base().build() else {
            return;
        };
        for step in 0..steps {
            let feature = format!("k{step}");
            let tool = chain_tool(&mut rng, &feature);
            let Ok(b) = tool.build() else {
                continue;
            };
            let results: Vec<(BodyOp, Result<super::BodyOpResult, super::BooleanError>)> =
                [BodyOp::Join, BodyOp::Cut, BodyOp::Intersect]
                    .into_iter()
                    .map(|op| {
                        let t = OpBody {
                            body: a.clone(),
                            origin: origin("t"),
                            timeline: 0,
                        };
                        let k = OpBody {
                            body: b.clone(),
                            origin: origin(&feature),
                            timeline: step + 1,
                        };
                        (op, apply_body_op(op, &[t], &[k], &format!("g{step}")))
                    })
                    .collect();
            visit(&ChainStep {
                chain,
                step,
                a: &a,
                tool: &tool,
                b: &b,
                results: &results,
            });
            let prefer = if rng.below(2) == 0 { [1, 0] } else { [0, 1] };
            if let Some(next) = prefer.into_iter().find_map(|i| match &results[i].1 {
                Ok(r) if r.bodies.len() == 1 => Some(r.bodies[0].body.clone()),
                _ => None,
            }) {
                a = next;
            }
        }
    }
}

/// Seed, chains and steps of the fixed chained determinism batch.
pub const CHAIN_FINGERPRINT: (u64, usize, usize) = (2026, 4, 5);
/// [`chain_fingerprint`] of [`CHAIN_FINGERPRINT`] recorded on the reference platform
/// (aarch64-apple-darwin, Rust 1.92). Update only for an intentional algorithm change.
/// Review round 4 (intentional change): tight quintic pcurves, sphere faces re-parametrized
/// by a 3D pole choice, near-coincident and near-tangent faces snapped (SPEC [R-3]), and
/// sliver results dropped (`docs/spikes/03-ssi.md`, "Review round 4").
/// IR v1 Phase C (intentional change, report fields only): SPEC [W0-39] — a join target whose
/// component holds a tool is `modified` even when the union is the target itself (a nested or
/// identical tool), so such steps list the target in `bodies` instead of `untouched`; no
/// geometry changed (the previous value, 0xa579_d6c1_ccb6_336a, is reproduced with the old
/// rule).
pub const GOLDEN_CHAIN_FINGERPRINT: u64 = 0x4c0c_2511_f302_5767;

/// Fingerprint of [`run_chains`] (every result body, report field and error code, as in
/// [`batch_fingerprint`]): the chained golden of `tests/boolean_golden.rs`.
pub fn chain_fingerprint(seed: u64, chains: usize, steps: usize) -> u64 {
    let mut fp = Fingerprint::new();
    run_chains(seed, chains, steps, |s| {
        fp.u(s.chain as u64);
        fp.u(s.step as u64);
        for (op, r) in s.results {
            fp.s(&format!("{op:?}"));
            fp.result(r);
        }
    });
    fp.0
}

/// FNV-1a over bit patterns and strings.
struct Fingerprint(u64);

impl Fingerprint {
    fn new() -> Self {
        Fingerprint(0xcbf2_9ce4_8422_2325)
    }
    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 ^= u64::from(x);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    fn u(&mut self, x: u64) {
        self.bytes(&x.to_le_bytes());
    }
    fn f(&mut self, x: f64) {
        self.u(x.to_bits());
    }
    fn p(&mut self, p: forge_core::linalg::Point3) {
        self.f(p.x);
        self.f(p.y);
        self.f(p.z);
    }
    fn s(&mut self, s: &str) {
        self.u(s.len() as u64);
        self.bytes(s.as_bytes());
    }

    /// Geometry and topology of a result body, in arena order: every vertex (point,
    /// tolerance), edge (curve kind, range, three curve points, tolerance, ends), face
    /// (surface kind, a surface point, sense) and coedge (direction, pcurve at the edge's
    /// ends and middle). Provenance keys are left out on purpose: they are pinned by the
    /// key tests, and the key grammar belongs to another workstream (W3); this guards the
    /// geometry against platform drift.
    fn body(&mut self, b: &Body) {
        let c = b.counts();
        for n in [c.shells, c.faces, c.loops, c.coedges, c.edges, c.vertices] {
            self.u(n as u64);
        }
        for (_, v) in b.vertices().iter() {
            self.p(v.point);
            self.f(v.tolerance);
        }
        for (_, e) in b.edges().iter() {
            self.s(e.curve.kind_name());
            let (t0, t1) = e.t_range;
            self.f(t0);
            self.f(t1);
            for t in [t0, 0.5 * (t0 + t1), t1] {
                self.p(e.curve.eval(t));
            }
            self.f(e.tolerance);
            self.u(u64::from(e.start.is_some()) + 2 * u64::from(e.end.is_some()));
        }
        for (_, f) in b.faces().iter() {
            self.s(f.surface.kind_name());
            self.p(f.surface.eval(0.3, 0.7));
            self.u(u64::from(f.sense));
            for &lid in &f.loops {
                let Some(l) = b.loop_(lid) else { continue };
                self.u(l.coedges.len() as u64);
                for &cid in &l.coedges {
                    let Some(co) = b.coedge(cid) else { continue };
                    self.u(u64::from(co.forward));
                    let (Some(e), Some(pc)) = (b.edge(co.edge), co.pcurve.as_ref()) else {
                        continue;
                    };
                    let (t0, t1) = e.t_range;
                    for t in [t0, 0.5 * (t0 + t1), t1] {
                        let q = pc.eval(t);
                        self.f(q.x);
                        self.f(q.y);
                    }
                }
            }
        }
    }

    /// A whole operation outcome: every result body ([`Fingerprint::body`]), the report
    /// fields (origins, change, untouched, merged, removed, splits, note codes, the number of
    /// aliases, `uncertified`) or, for a failure, its code and measured values (distance,
    /// probe point, offset) at full precision.
    fn result(&mut self, r: &Result<super::BodyOpResult, super::BooleanError>) {
        use super::{BodyOpResult, BooleanError};
        let hash_origin = |fp: &mut Fingerprint, o: &forge_ir::v1::metrics::Origin| {
            fp.s(&o.feature);
            fp.s(&o.member);
        };
        match r {
            Ok(r) => {
                let BodyOpResult {
                    bodies,
                    untouched,
                    // Indices of the `untouched` origins in the operands: not hashed (the
                    // origins are; hashing them too would change the pinned goldens).
                    untouched_targets: _,
                    merged_into,
                    removed,
                    splits,
                    notes,
                    aliases,
                    uncertified,
                } = r;
                self.u(bodies.len() as u64);
                for rb in bodies {
                    hash_origin(self, &rb.origin);
                    self.s(&format!("{:?}", rb.change));
                    self.body(&rb.body);
                }
                for o in untouched.iter().chain(removed) {
                    hash_origin(self, o);
                }
                for (x, y) in merged_into {
                    hash_origin(self, x);
                    hash_origin(self, y);
                }
                for (o, k) in splits {
                    hash_origin(self, o);
                    self.u(*k as u64);
                }
                for note in notes {
                    self.s(note.code());
                }
                self.u(aliases.len() as u64);
                self.u(u64::from(*uncertified));
            }
            Err(e) => {
                // The code and the measured values (entity names are keys: see above).
                self.s(e.code());
                match e {
                    BooleanError::NoIntersection { min_distance, .. } => self.f(*min_distance),
                    BooleanError::NonManifold { probe } => {
                        for x in probe.point {
                            self.f(x);
                        }
                    }
                    BooleanError::NearCoincident { offset, point, .. } => {
                        self.f(*offset);
                        for &x in point {
                            self.f(x);
                        }
                    }
                    BooleanError::Ssi { ssi_code, .. } => self.s(ssi_code),
                    _ => {}
                }
            }
        }
    }
}

/// Seed of the fixed determinism batch.
pub const FINGERPRINT_SEED: u64 = 2026;
/// Size of the fixed determinism batch (each case runs its own operation).
pub const FINGERPRINT_CASES: usize = 48;
/// [`batch_fingerprint`]`(FINGERPRINT_SEED, FINGERPRINT_CASES)` recorded on the reference
/// platform (aarch64-apple-darwin, Rust 1.92). Update only for an intentional algorithm
/// change, and say so in the commit message.
/// Review round 3 (intentional change): results are rebuilt with SPEC-key provenance
/// (`boolean::keys`), which reorders their arenas, and a sphere split at its poles, a closed
/// edge through one vertex and near-coincident faces are handled as described in
/// `docs/spikes/03-ssi.md` ("Review round 3").
/// Review round 4 (intentional change): see [`GOLDEN_CHAIN_FINGERPRINT`].
/// IR v1 Phase C (intentional change, report fields only): SPEC [W0-39], see
/// [`GOLDEN_CHAIN_FINGERPRINT`]; in this batch cases #10 and #46 (nested joins) now list the
/// target as a `modified` body instead of `untouched` (previous value 0xd494_c53b_c179_8632,
/// reproduced with the old rule; no other case changed).
pub const GOLDEN_FINGERPRINT: u64 = 0x7722_7ab7_0bbd_c917;

/// Fingerprint of running a fixed batch of `n` corpus cases (seed `seed`), each with its
/// operation: every result body's geometry and topology (see `Fingerprint::body`), the
/// report fields (origins, change, untouched, merged, removed, splits, note codes, the
/// number of aliases, `uncertified`) and, for failures, the code and its measured values
/// (distance, probe point, offset) at full precision. Identical on every target when the booleans are
/// deterministic (`tests/boolean_golden.rs`, also compiled for wasm32).
pub fn batch_fingerprint(seed: u64, n: usize) -> u64 {
    use super::{OpBody, apply_body_op};
    use forge_ir::v1::metrics::Origin;
    let mut fp = Fingerprint::new();
    let origin_of = |f: &str| Origin {
        feature: f.into(),
        member: "m".into(),
        instance: None,
    };
    for c in cases(seed, n) {
        fp.u(c.id as u64);
        fp.s(&format!("{:?}", c.op));
        let (a, b) = match (c.a.build(), c.b.build()) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(e), _) | (_, Err(e)) => {
                fp.s(e.code());
                continue;
            }
        };
        let t = OpBody {
            body: a,
            origin: origin_of("a"),
            timeline: 0,
        };
        let k = OpBody {
            body: b,
            origin: origin_of("b"),
            timeline: 1,
        };
        fp.result(&apply_body_op(c.op, &[t], &[k], "g"));
    }
    fp.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corpus_is_deterministic_and_buildable() {
        let a = cases(7, 60);
        let b = cases(7, 60);
        assert_eq!(a, b);
        for c in &a {
            c.a.build()
                .unwrap_or_else(|e| panic!("case {} a: {e}", c.id));
            c.b.build()
                .unwrap_or_else(|e| panic!("case {} b: {e}", c.id));
        }
    }
}
