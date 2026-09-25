//! Deterministic generators of surface pairs and result fingerprints.
//!
//! Used by the property/completeness tests, the OCCT differential oracle
//! (`examples/ssi_oracle_batch.rs`), the benchmarks and the cross-target determinism
//! check (`examples/ssi_fingerprint.rs`, also run as wasm32 under Node). Everything here
//! is a pure function of the seed: a portable SplitMix64 generator, no platform RNG.

use forge_core::geom::{Cone, Cylinder, Plane, Sphere, Surface, Torus};
use forge_core::math;
use forge_core::{Frame, Point3, Vec3};

use crate::error::SsiError;
use crate::types::{IntersectionGraph, UvBox};

/// SplitMix64: a tiny portable PRNG (bit-identical on every target).
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    /// Seeded generator.
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9e37_79b9_7f4a_7c15)
    }
    /// Next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, 1)`.
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
    /// Uniform in `[a, b)`.
    pub fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.f64()
    }
    /// Uniform integer in `0..n`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    /// A random unit vector (rejection sampling in the cube).
    pub fn unit(&mut self) -> Vec3 {
        loop {
            let v = Vec3::new(
                self.range(-1.0, 1.0),
                self.range(-1.0, 1.0),
                self.range(-1.0, 1.0),
            );
            let n = v.norm();
            if n > 0.1 && n <= 1.0 {
                return v / n;
            }
        }
    }
    /// A random right-handed frame at `origin` with random axes.
    pub fn frame(&mut self, origin: Point3) -> Frame {
        loop {
            let z = self.unit();
            let x = self.unit();
            if let Some(f) = Frame::from_normal_x(origin, z, x) {
                return f;
            }
        }
    }
    /// A random frame at `origin` with the given `z` axis.
    pub fn frame_z(&mut self, origin: Point3, z: Vec3) -> Frame {
        loop {
            if let Some(f) = Frame::from_normal_x(origin, z, self.unit()) {
                return f;
            }
        }
    }
}

/// Surface kinds of the corpus.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    /// Plane.
    Plane,
    /// Cylinder.
    Cylinder,
    /// Cone.
    Cone,
    /// Sphere.
    Sphere,
    /// Ring torus.
    Torus,
}

impl Kind {
    /// All kinds in canonical order.
    pub const ALL: [Kind; 5] = [
        Kind::Plane,
        Kind::Cylinder,
        Kind::Cone,
        Kind::Sphere,
        Kind::Torus,
    ];
    /// Lower-case name.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Plane => "plane",
            Kind::Cylinder => "cylinder",
            Kind::Cone => "cone",
            Kind::Sphere => "sphere",
            Kind::Torus => "torus",
        }
    }
}

/// One generated surface pair.
#[derive(Clone, Debug)]
pub struct PairCase {
    /// Index in the batch.
    pub id: usize,
    /// `"<kind a>-<kind b>/<configuration>"`.
    pub family: String,
    /// First surface.
    pub a: Surface,
    /// Its parameter box.
    pub dom_a: UvBox,
    /// Second surface.
    pub b: Surface,
    /// Its parameter box.
    pub dom_b: UvBox,
}

/// Half-size of plane boxes and cylinder/cone heights.
pub const EXTENT: f64 = 8.0;

fn domain(s: &Surface) -> UvBox {
    match s {
        Surface::Cone(c) => {
            let va = c.apex_v();
            UvBox::new(0.0, math::TAU, va + 0.05, va + 2.0 * EXTENT)
        }
        _ => UvBox::natural(s, EXTENT),
    }
}

fn make(rng: &mut Rng, k: Kind, f: Frame) -> Surface {
    match k {
        Kind::Plane => Plane::new(f).into(),
        Kind::Cylinder => Cylinder::new(f, rng.range(0.5, 3.0)).expect("cyl").into(),
        Kind::Cone => Cone::new(f, rng.range(0.0, 2.0), rng.range(0.25, 1.1))
            .expect("cone")
            .into(),
        Kind::Sphere => Sphere::new(f, rng.range(0.5, 3.5)).expect("sphere").into(),
        Kind::Torus => {
            let big = rng.range(2.0, 5.0);
            Torus::new(f, big, rng.range(0.3, 0.6 * big))
                .expect("torus")
                .into()
        }
    }
}

fn axis(s: &Surface) -> (Point3, Vec3) {
    let f = match s {
        Surface::Plane(p) => p.frame(),
        Surface::Cylinder(c) => c.frame(),
        Surface::Cone(c) => c.frame(),
        Surface::Sphere(c) => c.frame(),
        Surface::Torus(c) => c.frame(),
        Surface::Helicoid(c) => c.frame(),
        Surface::BSpline(_) => return (Point3::zero(), Vec3::unit_z()),
    };
    (f.origin(), f.z())
}

/// A deterministic batch of `n` pairs: the 15 unordered kind pairs in turn, about a
/// quarter of them in a structured configuration (coaxial, parallel, tangent, through
/// the apex, Villarceau, …) and the rest in general position with overlapping boxes.
pub fn random_pairs(seed: u64, n: usize) -> Vec<PairCase> {
    let mut rng = Rng::new(seed);
    let mut pairs = Vec::new();
    for (i, &ka) in Kind::ALL.iter().enumerate() {
        for &kb in &Kind::ALL[i..] {
            pairs.push((ka, kb));
        }
    }
    (0..n)
        .map(|id| {
            let (ka, kb) = pairs[id % pairs.len()];
            let special = rng.f64() < 0.28;
            let (a, b, config) = if special {
                structured(&mut rng, ka, kb)
            } else {
                general(&mut rng, ka, kb)
            };
            PairCase {
                id,
                family: format!("{}-{}/{}", ka.name(), kb.name(), config),
                dom_a: domain(&a),
                dom_b: domain(&b),
                a,
                b,
            }
        })
        .collect()
}

fn general(rng: &mut Rng, ka: Kind, kb: Kind) -> (Surface, Surface, &'static str) {
    let o = Point3::new(
        rng.range(-1.0, 1.0),
        rng.range(-1.0, 1.0),
        rng.range(-1.0, 1.0),
    );
    let fa = rng.frame(o);
    let a = make(rng, ka, fa);
    let off = rng.unit() * rng.range(0.0, 3.0);
    let fb = rng.frame(fa.origin() + off);
    let b = make(rng, kb, fb);
    (a, b, "general")
}

/// Structured configurations per pair (falls back to general position).
fn structured(rng: &mut Rng, ka: Kind, kb: Kind) -> (Surface, Surface, &'static str) {
    let o = Point3::new(
        rng.range(-1.0, 1.0),
        rng.range(-1.0, 1.0),
        rng.range(-1.0, 1.0),
    );
    let fa = rng.frame(o);
    let a = make(rng, ka, fa);
    let (ao, az) = axis(&a);
    let perp = az.any_perpendicular().expect("perp");
    let mode = rng.below(3);
    let tilt = |t: f64| {
        (az * math::cos(t) + perp * math::sin(t))
            .normalize()
            .expect("unit")
    };
    match (ka, kb) {
        (Kind::Plane, Kind::Plane) => {
            let d = if mode == 0 { 0.0 } else { rng.range(-2.0, 2.0) };
            let z = if rng.f64() < 0.5 { az } else { -az };
            let q = ao + az * d + perp * rng.range(-1.0, 1.0);
            let fb = rng.frame_z(q, z);
            (
                a,
                Plane::new(fb).into(),
                if mode == 0 { "coincident" } else { "parallel" },
            )
        }
        (Kind::Plane, Kind::Cylinder) => {
            let r = rng.range(0.5, 3.0);
            if mode == 2 {
                let q = ao + perp * rng.range(-1.0, 1.0);
                let fb = rng.frame_z(q, az);
                return (a, Cylinder::new(fb, r).expect("c").into(), "perpendicular");
            }
            let d = if mode == 1 {
                r
            } else {
                rng.range(0.0, 1.2 * r)
            };
            let fb = rng.frame_z(ao + az * d, perp);
            let name = if mode == 1 {
                "tangent-line"
            } else {
                "parallel"
            };
            (a, Cylinder::new(fb, r).expect("c").into(), name)
        }
        (Kind::Plane, Kind::Cone) => {
            let alpha = rng.range(0.25, 1.1);
            let r0 = rng.range(0.0, 2.0);
            let z = match mode {
                0 => az,
                1 => tilt(rng.range(0.1, 1.4)),
                // A generator parallel to the plane: axis at angle α from the plane.
                _ => tilt(math::FRAC_PI_2 - alpha),
            };
            let f = rng.frame_z(ao, z);
            let cone = Cone::new(f, r0, alpha).expect("k");
            let shift = if mode == 1 {
                ao - cone.apex()
            } else {
                az * rng.range(-1.0, 1.0)
            };
            let f2 = Frame::from_normal_x(f.origin() + shift, f.z(), f.x()).expect("f");
            let name = ["perpendicular", "through-apex", "parabola"][mode];
            (a, Cone::new(f2, r0, alpha).expect("k").into(), name)
        }
        (Kind::Plane, Kind::Sphere) => {
            let r = rng.range(0.5, 3.5);
            let d = if mode == 0 {
                r
            } else {
                rng.range(-1.2 * r, 1.2 * r)
            };
            let q = ao + az * d + perp * rng.range(-1.0, 1.0);
            let fb = rng.frame(q);
            let name = if mode == 0 { "tangent" } else { "offset" };
            (a, Sphere::new(fb, r).expect("s").into(), name)
        }
        (Kind::Plane, Kind::Torus) => {
            let big = rng.range(2.0, 5.0);
            let small = rng.range(0.3, 0.6 * big);
            match mode {
                0 => {
                    let h = if rng.f64() < 0.4 {
                        small
                    } else {
                        rng.range(-1.2 * small, 1.2 * small)
                    };
                    let fb = rng.frame_z(ao - az * h, az);
                    (
                        a,
                        Torus::new(fb, big, small).expect("t").into(),
                        "perpendicular",
                    )
                }
                1 => {
                    let fb = rng.frame_z(ao, perp);
                    (a, Torus::new(fb, big, small).expect("t").into(), "meridian")
                }
                _ => {
                    // Villarceau: the plane through the centre at angle asin(r/R) to the
                    // equatorial plane.
                    let fb = rng.frame_z(ao, tilt(math::asin(small / big)));
                    (
                        a,
                        Torus::new(fb, big, small).expect("t").into(),
                        "villarceau",
                    )
                }
            }
        }
        (Kind::Cylinder, Kind::Cylinder) => {
            let r = match &a {
                Surface::Cylinder(c) => c.radius(),
                _ => 1.0,
            };
            match mode {
                0 => {
                    let r2 = if rng.f64() < 0.3 {
                        r
                    } else {
                        rng.range(0.5, 3.0)
                    };
                    let q = ao + az * rng.range(-2.0, 2.0);
                    let fb = rng.frame_z(q, az);
                    (a, Cylinder::new(fb, r2).expect("c").into(), "coaxial")
                }
                1 => {
                    let r2 = rng.range(0.5, 3.0);
                    let d = if rng.f64() < 0.4 {
                        r + r2
                    } else {
                        rng.range(0.0, r + r2 + 0.5)
                    };
                    let fb = rng.frame_z(ao + perp * d, az);
                    (a, Cylinder::new(fb, r2).expect("c").into(), "parallel")
                }
                _ => {
                    let z = tilt(rng.range(0.3, 1.5));
                    let q = ao + az * rng.range(-1.0, 1.0);
                    let fb = rng.frame_z(q, z);
                    (
                        a,
                        Cylinder::new(fb, r).expect("c").into(),
                        "equal-radius-cross",
                    )
                }
            }
        }
        (Kind::Sphere, Kind::Sphere) => {
            let r1 = match &a {
                Surface::Sphere(s) => s.radius(),
                _ => 1.0,
            };
            let r2 = rng.range(0.5, 3.5);
            let d = match mode {
                0 => r1 + r2,
                1 => (r1 - r2).abs(),
                _ => 0.0,
            };
            let q = ao + rng.unit() * d;
            let fb = rng.frame(q);
            let name = ["tangent-external", "tangent-internal", "concentric"][mode];
            (a, Sphere::new(fb, r2).expect("s").into(), name)
        }
        (_, _) if mode < 2 => {
            // Coaxial surfaces of revolution (a sphere's axis is its frame z).
            let z = if rng.f64() < 0.5 { az } else { -az };
            let q = ao + az * rng.range(-2.0, 2.0);
            let fb = rng.frame_z(q, z);
            (a, make(rng, kb, fb), "coaxial")
        }
        (_, Kind::Sphere) => {
            // A small sphere touching `a` from outside at a random point.
            let (u, v) = (rng.range(0.0, math::TAU), rng.range(-1.0, 1.0));
            let p = a.eval(u, v);
            let n = a.normal(u, v).unwrap_or(Vec3::unit_z());
            let rb = rng.range(0.3, 1.5);
            (
                a,
                Sphere::new(rng.frame(p + n * rb), rb).expect("s").into(),
                "tangent-point",
            )
        }
        _ => general(rng, ka, kb),
    }
}

/// FNV-1a hasher over `f64` bit patterns.
#[derive(Clone, Debug)]
pub struct Fingerprint(pub u64);

impl Default for Fingerprint {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

impl Fingerprint {
    /// Mix a 64-bit word.
    pub fn u(&mut self, x: u64) {
        for b in x.to_le_bytes() {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    /// Mix an `f64` bit pattern.
    pub fn f(&mut self, x: f64) {
        self.u(x.to_bits());
    }
    /// Mix a point.
    pub fn p(&mut self, p: Point3) {
        self.f(p.x);
        self.f(p.y);
        self.f(p.z);
    }
    /// Mix a string.
    pub fn s(&mut self, s: &str) {
        for b in s.bytes() {
            self.u(u64::from(b));
        }
    }
    /// Mix one intersection result: every branch (kind, range, 17 samples of the curve
    /// and both pcurves, bounds, flags), every vertex, the method and error codes.
    pub fn result(&mut self, r: &Result<IntersectionGraph, SsiError>) {
        match r {
            Err(e) => self.s(e.code()),
            Ok(g) => {
                self.s(&format!("{:?}", g.method));
                self.u(g.branches.len() as u64);
                for b in &g.branches {
                    self.s(b.curve.kind_name());
                    self.f(b.range.0);
                    self.f(b.range.1);
                    self.f(b.error_bound);
                    self.u(u64::from(b.closed));
                    for i in 0..=16 {
                        let t = b.range.0 + (b.range.1 - b.range.0) * i as f64 / 16.0;
                        self.p(b.curve.eval(t));
                        let (pa, pb) = (b.pcurve_a.eval(t), b.pcurve_b.eval(t));
                        self.f(pa.x);
                        self.f(pa.y);
                        self.f(pb.x);
                        self.f(pb.y);
                    }
                }
                self.u(g.vertices.len() as u64);
                for v in &g.vertices {
                    self.p(v.point);
                    self.s(&format!("{:?}", v.kind));
                }
                self.u(u64::from(g.coincidence.is_some()));
            }
        }
    }
}

/// Seed of the fixed determinism batch.
pub const FINGERPRINT_SEED: u64 = 2026;
/// Size of the fixed determinism batch.
pub const FINGERPRINT_PAIRS: usize = 150;
/// [`batch_fingerprint`]`(FINGERPRINT_SEED, FINGERPRINT_PAIRS)` recorded on the reference
/// platform (aarch64-apple-darwin, Rust 1.92). Update only for an intentional algorithm
/// change, and say so in the commit message.
pub const GOLDEN_FINGERPRINT: u64 = 0x25d3_1489_fbd5_d1e6;

/// Fingerprint of intersecting a fixed batch of `n` pairs (seed `seed`) plus a fixed set
/// of curve–surface queries: the bit patterns of every returned curve sample, pcurve
/// sample, bound, vertex and error code. Identical on every target when Forge is
/// deterministic.
pub fn batch_fingerprint(seed: u64, n: usize) -> u64 {
    use crate::{SsiTolerance, intersect_curve_surface, intersect_surfaces};
    use forge_core::geom::{Circle3, Curve3, Line3};
    let tol = SsiTolerance::default();
    let mut fp = Fingerprint::default();
    let cases = random_pairs(seed, n);
    for c in &cases {
        fp.result(&intersect_surfaces(&c.a, c.dom_a, &c.b, c.dom_b, &tol));
    }
    // Curve–surface: a line and a circle through every surface of the batch.
    let mut rng = Rng::new(seed ^ 0x5eed);
    for c in cases.iter().take(60) {
        let o = Point3::new(
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
        );
        let f = rng.frame(o);
        let curves: [(Curve3, (f64, f64)); 2] = [
            (
                Line3::new(o - f.z() * 10.0, f.z()).expect("line").into(),
                (0.0, 20.0),
            ),
            (
                Circle3::new(f, rng.range(0.5, 4.0)).expect("circle").into(),
                (0.0, math::TAU),
            ),
        ];
        for (curve, range) in &curves {
            match intersect_curve_surface(curve, *range, &c.b, c.dom_b, &tol) {
                Ok(h) => {
                    fp.u(h.points.len() as u64);
                    for p in &h.points {
                        fp.f(p.t);
                        fp.p(p.point);
                        fp.f(p.uv.x);
                        fp.f(p.uv.y);
                        fp.f(p.certificate.t_enclosure.0);
                        fp.f(p.certificate.t_enclosure.1);
                    }
                    for o in &h.overlaps {
                        fp.f(o.t_range.0);
                        fp.f(o.t_range.1);
                    }
                }
                Err(e) => fp.s(e.code()),
            }
        }
    }
    fp.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_is_deterministic_and_uniformish() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        let xs: Vec<u64> = (0..8).map(|_| a.next_u64()).collect();
        let ys: Vec<u64> = (0..8).map(|_| b.next_u64()).collect();
        assert_eq!(xs, ys);
        let mut r = Rng::new(1);
        let mean = (0..10_000).map(|_| r.f64()).sum::<f64>() / 10_000.0;
        assert!((mean - 0.5).abs() < 0.02);
    }

    #[test]
    fn batch_covers_all_pairs_and_is_valid() {
        let cases = random_pairs(3, 300);
        assert_eq!(cases.len(), 300);
        let mut fams: Vec<&str> = cases
            .iter()
            .map(|c| c.family.split('/').next().expect("pair"))
            .collect();
        fams.sort_unstable();
        fams.dedup();
        assert_eq!(fams.len(), 15);
        for c in &cases {
            c.dom_a
                .validate(&c.a, crate::error::Operand::A)
                .expect("dom a");
            c.dom_b
                .validate(&c.b, crate::error::Operand::B)
                .expect("dom b");
        }
    }
}
