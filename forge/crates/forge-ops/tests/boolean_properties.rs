//! Property tests of the booleans on the deterministic corpus and on random boxes and
//! cylinders:
//! - `vol(A ∪ B) + vol(A ∩ B) = vol A + vol B` and `vol(A − B) + vol(A ∩ B) = vol A`
//!   (exact mass properties from forge-check) within **1e-9 relative** to `vol A + vol B`,
//!   the plan's bound, for every case: results with exact geometry only (lines, circles,
//!   ellipses, analytic surfaces, exact pcurves) and results with fitted intersection curves
//!   or pcurves alike (review round 4: pcurves are fitted within 1e-10 mm plus the curve's
//!   distance from the surface, so the faces meeting along an edge close up to ~1e-9 mm and
//!   the divergence-theorem volumes no longer depend on forge-check's reference point). Both
//!   populations are counted and their worst residuals reported;
//! - every result passes `forge_check::validate` (closed, oriented, Euler, geometry on
//!   surfaces, pcurves);
//! - semantic outcomes agree across the three operations (a join without intersection
//!   is an empty intersection);
//! - results are deterministic (bit-identical volumes on a rerun).

use forge_core::topo::{Body, Severity};
use forge_ir::v1::metrics::Origin;
use forge_ops::boolean::corpus::{Case, cases};
use forge_ops::boolean::{BodyOp, BooleanError, OpBody, apply_body_op};
use proptest::prelude::*;

fn ob(body: Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "m".into(),
            instance: None,
        },
        timeline,
    }
}

fn volume(b: &Body) -> f64 {
    forge_check::mass_properties(b).expect("mass").volume
}

fn check_valid(b: &Body, what: &str) {
    let issues = forge_check::validate(b);
    let errs: Vec<_> = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .collect();
    assert!(errs.is_empty(), "{what}: invalid result: {errs:?}");
}

thread_local! {
    /// Area of results with fitted (B-spline) edges or pcurves since the last reset.
    static FITTED_AREA: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    /// Largest closure defect seen (see [`closure_defect`]) relative to the body's area.
    static WORST_CLOSURE: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
}

/// Largest relative closure defect a result body may have: `|∬ n dA| / area`. A body whose
/// faces meet exactly has a zero vector area; the two faces of a fitted section edge both
/// lie on the true intersection within the pcurve fit (1e-10 mm; tangent sections and a
/// Newton that does not converge keep each surface's projection of the fitted curve), and
/// the corpus stays near 1e-9 (5e-8 with independent 5e-8 fits, review round 3).
const MAX_CLOSURE: f64 = 1e-8;

/// The closure defect `|(∬ n dA) · e|` of a body along the diagonal `e = (1, 1, 1)/√3`, from
/// the change of its forge-check volume when a far unit sphere moves the reference point
/// (the body's box centre) by ~1000 mm along `e`: `ΔV = −Δc · (∬ n dA) / 3`. Zero when the
/// faces close up exactly.
fn closure_defect(b: &Body) -> f64 {
    let v0 = volume(b);
    let ball = 4.0 / 3.0 * std::f64::consts::PI;
    let bb = forge_check::bbox(b).expect("bbox");
    let e = 1.0 / 3f64.sqrt();
    let far = with_far_sphere(
        b,
        [
            bb.1[0] + 2000.0 * e,
            bb.1[1] + 2000.0 * e,
            bb.1[2] + 2000.0 * e,
        ],
    );
    let (lo, hi) = forge_check::bbox(&far).expect("bbox");
    let dc: f64 = (0..3)
        .map(|k| (0.5 * (lo[k] + hi[k]) - 0.5 * (bb.0[k] + bb.1[k])) * e)
        .sum();
    (3.0 * (volume(&far) - ball - v0) / dc).abs()
}

/// Total volume of an operation's result, `Ok(0)` for the semantic "nothing" outcomes.
fn op_volume(op: BodyOp, a: &Body, b: &Body, what: &str) -> Result<f64, BooleanError> {
    match apply_body_op(op, &[ob(a.clone(), "a", 0)], &[ob(b.clone(), "b", 1)], "g") {
        Ok(r) => {
            let mut v = 0.0;
            for x in &r.bodies {
                check_valid(&x.body, what);
                let mp = forge_check::mass_properties(&x.body).expect("mass");
                v += mp.volume;
                // Fitted intersection curves and fitted pcurves (B-splines within 5e-8 mm)
                // bound the exactness of the boundary integrals.
                let fitted = x
                    .body
                    .edges()
                    .iter()
                    .any(|(_, e)| e.curve.kind_name() == "bspline")
                    || x.body.coedges().iter().any(|(_, c)| {
                        // Degree-1 B-spline pcurves are exact (affine images: lines on
                        // planes, cylinders and cones, parallels of surfaces of revolution).
                        matches!(&c.pcurve, Some(forge_core::geom::Curve2::BSpline(n)) if n.degree() > 1)
                    });
                if fitted {
                    FITTED_AREA.with(|c| c.set(c.get() + mp.area));
                }
                // The faces close up: the volume does not depend on the reference point
                // (checked where fitted boundaries could part; exact ones close by
                // construction).
                if fitted {
                    let closure = closure_defect(&x.body) / mp.area;
                    if closure > 0.5 * MAX_CLOSURE {
                        eprintln!("{what}: closure defect {closure:.2e} (half the bound)");
                    }
                    WORST_CLOSURE.with(|c| c.set(c.get().max(closure)));
                    assert!(
                        closure <= MAX_CLOSURE,
                        "{what}: the result's faces do not close up: |∬ n dA| / area = {closure:.2e}"
                    );
                }
            }
            // Untouched targets keep their volume. With one target this no longer happens:
            // a nested join tool acts on its target (SPEC [W0-39]: `modified`, listed in
            // `bodies`), an intersect never leaves a target untouched, and a cut or join
            // without effect is an error.
            if !r.untouched.is_empty() {
                assert!(
                    r.bodies.is_empty(),
                    "{what}: one target, untouched and modified"
                );
                v += volume(a);
            }
            Ok(v)
        }
        Err(e) => Err(e),
    }
}

#[derive(Default, Debug)]
struct Stats {
    cases: usize,
    all_ok: usize,
    /// All-ok cases with exact geometry only (checked at 1e-9 relative).
    exact: usize,
    /// All-ok cases with fitted curves (checked with the fit-based bound).
    fitted: usize,
    /// Largest `|identity residual| / (vA + vB)` among exact and among fitted cases.
    worst_exact: f64,
    worst_fitted: f64,
    /// The case of `worst_fitted`.
    worst_fitted_case: usize,
    semantic: usize,
    internal: Vec<String>,
}

fn run_case(c: &Case, stats: &mut Stats) {
    let (Ok(a), Ok(b)) = (c.a.build(), c.b.build()) else {
        panic!("case {}: operands must build", c.id);
    };
    stats.cases += 1;
    let (va, vb) = (volume(&a), volume(&b));
    FITTED_AREA.with(|c| c.set(0.0));
    let what = |op: BodyOp| format!("case {} ({}) {op:?}", c.id, c.family);
    let j = op_volume(BodyOp::Join, &a, &b, &what(BodyOp::Join));
    let k = op_volume(BodyOp::Cut, &a, &b, &what(BodyOp::Cut));
    let i = op_volume(BodyOp::Intersect, &a, &b, &what(BodyOp::Intersect));
    let mut internal = false;
    for (op, r) in [
        (BodyOp::Join, &j),
        (BodyOp::Cut, &k),
        (BodyOp::Intersect, &i),
    ] {
        if let Err(e) = r
            && !e.is_semantic()
        {
            internal = true;
            stats
                .internal
                .push(format!("{}: {} {e}", what(op), e.code()));
        }
    }
    if internal {
        return;
    }
    // The plan's bound, 1e-9 relative, for exact and fitted geometry alike.
    let fitted_area = FITTED_AREA.with(std::cell::Cell::get);
    let tol = 1e-9 * (va + vb);
    let code = |r: &Result<f64, BooleanError>| r.as_ref().err().map(|e| e.code());
    match (&j, &k, &i) {
        (Ok(vj), Ok(vk), Ok(vi)) => {
            stats.all_ok += 1;
            let rel = (vj + vi - va - vb).abs().max((vk + vi - va).abs()) / (va + vb);
            if fitted_area == 0.0 {
                stats.exact += 1;
                stats.worst_exact = stats.worst_exact.max(rel);
            } else {
                stats.fitted += 1;
                if rel > stats.worst_fitted {
                    stats.worst_fitted = rel;
                    stats.worst_fitted_case = c.id;
                }
            }
            assert!(
                (vj + vi - va - vb).abs() <= tol,
                "{}: join {vj} + int {vi} vs {va} + {vb}",
                what(BodyOp::Join)
            );
            assert!(
                (vk + vi - va).abs() <= tol,
                "{}: cut {vk} + int {vi} vs {va}",
                what(BodyOp::Cut)
            );
        }
        _ => {
            stats.semantic += 1;
            // Consistent outcomes.
            match code(&i) {
                Some("BOOLEAN_EMPTY_RESULT") => {
                    // Nothing in common: the cut changes nothing.
                    assert_eq!(
                        code(&k),
                        Some("BOOLEAN_NO_INTERSECTION"),
                        "{}",
                        what(BodyOp::Cut)
                    );
                    // A join is either detached or face-touching.
                    if let Ok(vj) = j {
                        assert!(
                            (vj - va - vb).abs() <= tol,
                            "{}: touching join",
                            what(BodyOp::Join)
                        );
                    }
                }
                Some("BOOLEAN_NON_MANIFOLD") | None => {}
                Some(x) => panic!("{}: unexpected {x}", what(BodyOp::Intersect)),
            }
            if code(&j) == Some("BOOLEAN_NO_INTERSECTION") {
                assert_eq!(
                    code(&i),
                    Some("BOOLEAN_EMPTY_RESULT"),
                    "{}",
                    what(BodyOp::Intersect)
                );
            }
        }
    }
}

fn run_corpus(seed: u64, n: usize, max_internal: f64) {
    let mut stats = Stats::default();
    for c in cases(seed, n) {
        run_case(&c, &mut stats);
    }
    eprintln!(
        "seed {seed}: worst closure defect |∬ n dA| / area {:.1e}",
        WORST_CLOSURE.with(std::cell::Cell::get)
    );
    eprintln!(
        "seed {seed}: {} cases, {} all ok ({} exact geometry, worst {:.1e} relative; {} fitted, \
         worst {:.1e} (case {})), {} semantic, {} internal errors",
        stats.cases,
        stats.all_ok,
        stats.exact,
        stats.worst_exact,
        stats.fitted,
        stats.worst_fitted,
        stats.worst_fitted_case,
        stats.semantic,
        stats.internal.len()
    );
    // Both populations are exercised.
    assert!(stats.exact > 0 && stats.fitted > 0, "{stats:?}");
    for s in &stats.internal {
        eprintln!("  {s}");
    }
    // Per operation (three per case).
    let rate = stats.internal.len() as f64 / (3 * stats.cases) as f64;
    assert!(
        rate <= max_internal,
        "internal error rate {rate} per operation"
    );
}

#[test]
fn corpus_volume_identities_hold() {
    let n = if cfg!(debug_assertions) { 36 } else { 240 };
    run_corpus(11, n, 0.01);
}

/// Extra seeds: `BOOLEAN_SEEDS=5,17 BOOLEAN_COUNT=500 cargo test --release ... -- --ignored`.
#[test]
#[ignore]
fn corpus_volume_identities_hold_on_more_seeds() {
    let seeds = std::env::var("BOOLEAN_SEEDS").unwrap_or_else(|_| "5,17,23".into());
    let n: usize = std::env::var("BOOLEAN_COUNT").map_or(240, |s| s.parse().expect("count"));
    for s in seeds.split(',') {
        run_corpus(s.parse().expect("seed"), n, 0.01);
    }
}

/// Corpus cases that once failed or were wrong, each with the defect it pinned down: all
/// three operations must satisfy the identities (or give consistent semantic outcomes)
/// with valid bodies and no internal error.
#[test]
fn regression_cases_hold() {
    let cases_of = [
        // Pcurve of a cone generator ending at the apex took the apex's arbitrary `u`
        // (the join volume was off by 0.14 mm³ while the area matched).
        (11, 283),
        // Chart queries exactly on the cut line of a periodic face.
        (17, 76),
        (17, 97),
        // An SSI loop touching the periodic window edge was traced twice around.
        (11, 460),
        // A tangent contact line inside a face (a slit) and across a cylinder band.
        (11, 532),
        (5, 536),
        (11, 565),
        // A cylinder through a cone apex: zero-length fit spans, the loop's pcurve at the
        // apex (u limit, side of the singular line).
        (23, 559),
        // Pcurves of a wrapped piece of a closed periodic branch were extrapolated.
        (23, 271),
        // Section crossings on the edge of a face's box (plane tangent to a torus's inner
        // equator): a vertex at the crossing, the edge split there.
        (17, 139),
        (23, 211),
        (23, 391),
        (17, 391),
        // A tangent contact of two cylinders outside one face's box.
        (17, 422),
        // Pieces of one intersection curve split at a degree-2 vertex (merged B-splines).
        (5, 175),
    ];
    // Debug builds skip the slow ones (more than 0.3 s each in release).
    let slow = [
        (23, 559),
        (23, 271),
        (17, 139),
        (23, 211),
        (17, 391),
        (5, 175),
    ];
    let mut stats = Stats::default();
    for (seed, id) in cases_of {
        if cfg!(debug_assertions) && slow.contains(&(seed, id)) {
            continue;
        }
        let c = cases(seed, id + 1).pop().expect("case");
        run_case(&c, &mut stats);
    }
    assert!(stats.internal.is_empty(), "{:#?}", stats.internal);
    // Result topology where it was wrong: B inside A touching A's face along a line gives
    // B's own three faces and two ring edges (no seam, no vertices).
    let c = cases(5, 537).pop().expect("case");
    let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
    let r = apply_body_op(BodyOp::Intersect, &[ob(a, "a", 0)], &[ob(b, "b", 1)], "g").expect("op");
    assert_eq!(r.bodies.len(), 1);
    let n = r.bodies[0].body.counts();
    assert_eq!((n.faces, n.edges, n.vertices), (3, 2, 0), "{n:?}");
    // A closed sphere–cylinder section cut into two pieces at its closure, one piece ending
    // an ulp off a knot of full multiplicity: the pieces did not concatenate and stayed two
    // edges (OCCT, normalized: 12 edges). Case 23:307.
    let c = cases(23, 308).pop().expect("case");
    let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
    let r = apply_body_op(BodyOp::Cut, &[ob(a, "a", 0)], &[ob(b, "b", 1)], "g").expect("op");
    let n = r.bodies[0].body.counts();
    assert_eq!((n.faces, n.edges), (6, 12), "{n:?}");
    if cfg!(debug_assertions) {
        return;
    }
    // A result used as an operand (chained operations): the intersection of case 23:559
    // has a closed section curve through a cone apex. Unify used to turn it into a ring
    // whose cone pcurve ends at two points of the apex line, which no chart can take as a
    // loop ("operand face domain" failed on every later boolean); the vertex at the apex now
    // stays. Cutting and intersecting the result with a box satisfy the identity.
    let c = cases(23, 560).pop().expect("case");
    let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
    let x = apply_body_op(BodyOp::Intersect, &[ob(a, "a", 0)], &[ob(b, "b", 1)], "g")
        .expect("intersect")
        .bodies
        .remove(0)
        .body;
    let k = aabox([-3.0, -3.0, -3.0], [6.0, 3.0, 6.0], "k");
    let vx = volume(&x);
    let vk = op_volume(BodyOp::Cut, &x, &k, "chained cut").expect("chained cut");
    let vi = op_volume(BodyOp::Intersect, &x, &k, "chained intersect").expect("chained int");
    assert!((vk + vi - vx).abs() <= 1e-7 * vx, "{vk} + {vi} vs {vx}");
    assert!(vk > 0.0 && vi > 0.0);
    // Case 11:379 (`cases(11, 380)` ends with it): a sphere face with one curved hole: the
    // pole moved to the hole's mean direction, which lay outside the hole (an inverted face
    // and a join of 107 mm³ from operands of 524 and 237 mm³). The torus's own cut and
    // intersect are unsupported (torus minus disks).
    let c = cases(11, 380).pop().expect("case");
    let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
    let (va, vb) = (volume(&a), volume(&b));
    let r = apply_body_op(BodyOp::Join, &[ob(a, "a", 0)], &[ob(b, "b", 1)], "g").expect("join");
    assert_eq!(r.bodies.len(), 1);
    check_valid(&r.bodies[0].body, "11:379 join");
    let vj = volume(&r.bodies[0].body);
    assert!(
        vj > va.max(vb) && vj < va + vb,
        "join {vj} of {va} and {vb}"
    );
}

/// Same-process rerun; the cross-run and cross-platform guard is the stored golden
/// fingerprint of `tests/boolean_golden.rs`.
#[test]
fn results_are_deterministic() {
    for c in cases(3, 12) {
        let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
        let v = |_: ()| op_volume(c.op, &a, &b, "det").map(f64::to_bits).ok();
        assert_eq!(v(()), v(()), "case {}", c.id);
    }
}

fn aabox(lo: [f64; 3], size: [f64; 3], feature: &str) -> Body {
    use forge_ir::{Frame, PlaneSpec, SketchCurve, SweepDirection};
    use forge_ops::boolean::corpus::{Operand, Sweep};
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    let (x0, y0, w, h) = (lo[0], lo[1], size[0], size[1]);
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: "s".into(),
            name: "s".into(),
            suppressed: false,
            plane: PlaneSpec::Frame(Frame {
                origin: [0.0, 0.0, lo[2]],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves: vec![
                l("b", [x0, y0], [x0 + w, y0]),
                l("r", [x0 + w, y0], [x0 + w, y0 + h]),
                l("t", [x0 + w, y0 + h], [x0, y0 + h]),
                l("l", [x0, y0 + h], [x0, y0]),
            ],
        },
        sweep: Sweep::Extrude {
            distance: size[2],
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("box")
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: if cfg!(debug_assertions) { 24 } else { 256 },
        .. ProptestConfig::default()
    })]

    /// Random boxes on a 0.25 grid (so faces often coincide exactly).
    #[test]
    fn random_boxes_satisfy_the_volume_identities(
        a in prop::array::uniform3(-8i32..4), sa in prop::array::uniform3(2i32..12),
        b in prop::array::uniform3(-8i32..4), sb in prop::array::uniform3(2i32..12),
    ) {
        let q = |x: i32| f64::from(x) * 0.25 * 2.0;
        let a = aabox([q(a[0]), q(a[1]), q(a[2])], [q(sa[0]), q(sa[1]), q(sa[2])], "a");
        let b = aabox([q(b[0]), q(b[1]), q(b[2])], [q(sb[0]), q(sb[1]), q(sb[2])], "b");
        let mut stats = Stats::default();
        let case = |_: ()| ();
        case(());
        let (va, vb) = (volume(&a), volume(&b));
        let j = op_volume(BodyOp::Join, &a, &b, "join");
        let k = op_volume(BodyOp::Cut, &a, &b, "cut");
        let i = op_volume(BodyOp::Intersect, &a, &b, "int");
        for r in [&j, &k, &i] {
            if let Err(e) = r {
                prop_assert!(e.is_semantic(), "{} {e}", e.code());
            }
        }
        if let (Ok(vj), Ok(vk), Ok(vi)) = (&j, &k, &i) {
            let tol = 1e-9 * (va + vb);
            prop_assert!((vj + vi - va - vb).abs() <= tol);
            prop_assert!((vk + vi - va).abs() <= tol);
        }
        stats.cases += 1;
    }
}

/// Debug helper: `BOOLEAN_CASE=<seed>:<id> cargo test -p forge-ops --test
/// boolean_properties one_case -- --ignored --nocapture`.
#[test]
#[ignore]
fn one_case() {
    let spec = std::env::var("BOOLEAN_CASE").unwrap_or_else(|_| "11:19".into());
    let (seed, id) = spec.split_once(':').expect("seed:id");
    let (seed, id): (u64, usize) = (seed.parse().expect("seed"), id.parse().expect("id"));
    let c = cases(seed, id + 1).pop().expect("case");
    eprintln!(
        "case {} {} {:?}\n a = {:#?}\n b = {:#?}",
        c.id, c.family, c.op, c.a, c.b
    );
    let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
    for op in [BodyOp::Join, BodyOp::Cut, BodyOp::Intersect] {
        match apply_body_op(op, &[ob(a.clone(), "a", 0)], &[ob(b.clone(), "b", 1)], "g") {
            Ok(r) => {
                for x in &r.bodies {
                    let mp = forge_check::mass_properties(&x.body);
                    eprintln!("{op:?}: counts {:?} mass {mp:?}", x.body.counts());
                }
            }
            Err(e) => eprintln!("{op:?}: {} {e}", e.code()),
        }
    }
}

/// Debug helper: print every face's coedges (pcurve ends in uv and 3D) of a case's result.
#[test]
#[ignore]
fn one_case_faces() {
    let spec = std::env::var("BOOLEAN_CASE").unwrap_or_else(|_| "11:195".into());
    let (seed, id) = spec.split_once(':').expect("seed:id");
    let (seed, id): (u64, usize) = (seed.parse().expect("seed"), id.parse().expect("id"));
    let c = cases(seed, id + 1).pop().expect("case");
    let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
    let op = match std::env::var("BOOLEAN_OP").as_deref() {
        Ok("join") => BodyOp::Join,
        Ok("intersect") => BodyOp::Intersect,
        _ => BodyOp::Cut,
    };
    let r = apply_body_op(op, &[ob(a, "a", 0)], &[ob(b, "b", 1)], "g").expect("op");
    for x in &r.bodies {
        for i in forge_check::validate(&x.body) {
            eprintln!("issue {i:?}");
        }
        for (_, f) in x.body.faces().iter() {
            eprintln!(
                "face {} {} sense {}",
                f.provenance.name(),
                f.surface.kind_name(),
                f.sense
            );
            for &l in &f.loops {
                eprintln!(" loop");
                for &cid in &x.body.loop_(l).expect("loop").coedges {
                    let co = x.body.coedge(cid).expect("coedge");
                    let e = x.body.edge(co.edge).expect("edge");
                    let (t0, t1) = if co.forward {
                        e.t_range
                    } else {
                        (e.t_range.1, e.t_range.0)
                    };
                    let pc = co.pcurve.as_ref().expect("pcurve");
                    eprintln!(
                        "  {} fwd {} t {:?} uv {:?} -> {:?}  p {:?} -> {:?}  {}",
                        e.curve.kind_name(),
                        co.forward,
                        (t0, t1),
                        pc.eval(t0),
                        pc.eval(t1),
                        e.curve.eval(t0),
                        e.curve.eval(t1),
                        pc.kind_name()
                    );
                    if std::env::var_os("BOOLEAN_PCURVE_SAMPLES").is_some() {
                        let q: Vec<_> = (1..8)
                            .map(|k| {
                                let t = t0 + (t1 - t0) * k as f64 / 8.0;
                                let uv = pc.eval(t);
                                let d = f.surface.eval(uv.x, uv.y).distance(e.curve.eval(t));
                                (uv.x, uv.y, d)
                            })
                            .collect();
                        eprintln!("    samples {q:?}");
                    }
                }
            }
        }
    }
}

/// Debug helper: the identity residuals of one corpus case, `BOOLEAN_CASE=<seed>:<id>`.
#[test]
#[ignore]
fn one_case_identity() {
    let spec = std::env::var("BOOLEAN_CASE").unwrap_or_else(|_| "17:379".into());
    for one in spec.split(',') {
        let (seed, id) = one.split_once(':').expect("seed:id");
        let (seed, id): (u64, usize) = (seed.parse().expect("seed"), id.parse().expect("id"));
        let c = cases(seed, id + 1).pop().expect("case");
        let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
        let (va, vb) = (volume(&a), volume(&b));
        let v = |op| op_volume(op, &a, &b, "one").ok();
        let (j, k, i) = (v(BodyOp::Join), v(BodyOp::Cut), v(BodyOp::Intersect));
        let area = |b: &Body| forge_check::mass_properties(b).expect("mass").area;
        let areas = |op| -> Option<f64> {
            let r =
                apply_body_op(op, &[ob(a.clone(), "a", 0)], &[ob(b.clone(), "b", 1)], "g").ok()?;
            Some(
                r.bodies.iter().map(|x| area(&x.body)).sum::<f64>()
                    + if r.untouched.is_empty() {
                        0.0
                    } else {
                        area(&a)
                    },
            )
        };
        if let (Some(j), Some(k), Some(i)) = (j, k, i) {
            let (aj, ai) = (
                areas(BodyOp::Join).unwrap_or(f64::NAN),
                areas(BodyOp::Intersect).unwrap_or(f64::NAN),
            );
            eprintln!(
                "{one}: join+int {:.2e}, cut+int {:.2e} (relative to vA + vB); areas join+int {:.2e} (relative)",
                (j + i - va - vb) / (va + vb),
                (k + i - va) / (va + vb),
                (aj + ai - area(&a) - area(&b)) / (area(&a) + area(&b))
            );
        } else {
            eprintln!("{one}: {j:?} {k:?} {i:?}");
        }
    }
}

/// `body` plus a unit sphere shell centred at `c` (far away: it moves forge-check's
/// reference point, the body's box centre, so that a body that is not exactly closed shows
/// a different volume).
fn with_far_sphere(body: &Body, c: [f64; 3]) -> Body {
    let mut bb =
        forge_core::topo::BodyBuilder::from_body(body.clone(), forge_core::Tolerance::IR_DEFAULT);
    let sh = bb.add_shell(true);
    let fr = forge_core::linalg::Frame::from_normal(
        forge_core::linalg::Point3::new(c[0], c[1], c[2]),
        forge_core::linalg::Vec3::new(0.0, 0.0, 1.0),
    )
    .expect("frame");
    let s: forge_core::geom::Surface = forge_core::geom::Sphere::new(fr, 1.0)
        .expect("sphere")
        .into();
    bb.add_face(
        sh,
        s,
        true,
        forge_core::topo::Provenance::new("far", forge_core::topo::Role::Side),
    )
    .expect("face");
    bb.finish()
}

/// Debug helper: volumes of each result with forge-check's reference point moved far away
/// along x, y, z: a change reveals boundaries that do not close exactly.
#[test]
#[ignore]
fn one_case_closure() {
    let spec = std::env::var("BOOLEAN_CASE").unwrap_or_else(|_| "23:163".into());
    let (seed, id) = spec.split_once(':').expect("seed:id");
    let (seed, id): (u64, usize) = (seed.parse().expect("seed"), id.parse().expect("id"));
    let c = cases(seed, id + 1).pop().expect("case");
    let (a, b) = (c.a.build().expect("a"), c.b.build().expect("b"));
    let ball = 4.0 / 3.0 * std::f64::consts::PI;
    let probe = |what: &str, body: &Body| {
        let v0 = volume(body);
        let d: Vec<String> = [[2000.0, 0.0, 0.0], [0.0, 2000.0, 0.0], [0.0, 0.0, 2000.0]]
            .iter()
            .map(|&p| format!("{:.2e}", volume(&with_far_sphere(body, p)) - ball - v0))
            .collect();
        eprintln!(
            "{what}: volume {v0:.12} change with the reference point moved ~1000 mm along x, y, z: {d:?}"
        );
    };
    probe("A", &a);
    probe("B", &b);
    for op in [BodyOp::Join, BodyOp::Cut, BodyOp::Intersect] {
        let Ok(r) = apply_body_op(op, &[ob(a.clone(), "a", 0)], &[ob(b.clone(), "b", 1)], "g")
        else {
            continue;
        };
        for x in &r.bodies {
            probe(&format!("{op:?}"), &x.body);
        }
    }
}
