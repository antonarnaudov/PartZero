//! Curve–surface intersection.
//!
//! # Method
//! Let `d_S` be the surface's distance form (`|d_S(p)| >= dist(p, S)`, equal near `S`;
//! see `forge_core::geom::surface::implicit`) and `g(t) = d_S(C(t))`.
//!
//! 1. **Closed-form candidates.** For a line, `q_S(C(t))` (the algebraic form) is a
//!    polynomial of degree 1 (plane), 2 (quadrics) or 4 (torus); for a circle or an
//!    ellipse it is a trigonometric polynomial of that degree. Candidates come from the
//!    stable quadratic formula / recursive-derivative isolation of the quartic
//!    ([`crate::poly`]); circles and ellipses use the half-angle substitution on two
//!    bounded charts. B-spline curves have no closed form and skip this step.
//! 2. **Certification.** Each candidate is polished by Newton on `g` and certified by
//!    interval Newton (a unique root in a tiny enclosure whose residual contains 0).
//! 3. **Completeness.** The rest of the parameter range is handed to the certified root
//!    finder ([`crate::roots1d`]), which proves it root-free or finds what the closed
//!    form missed (tangential double roots, rounding victims). So the hit list is
//!    certified complete.
//! 4. **Tangency.** Two roots whose connecting arc stays within `fit` of the surface are
//!    one tangential contact (a curve grazing the surface by less than the tolerance);
//!    roots that interval Newton cannot isolate are tangential (multiplicity ≥ 2, odd if
//!    `g` changes sign).
//! 5. **Overlap.** Ranges where `|g| <= fit` over an extent (certified by interval
//!    enclosures) are overlaps: the curve lies in the surface.
//! 6. **Domain.** Hits outside the surface's parameter box are dropped; overlaps are
//!    clipped to it.

use forge_core::geom::{Curve3, Surface};
use forge_core::math;
use forge_core::scalar::{Dual, Interval};
use forge_core::{Point2, Vec3};

use crate::clip::{Patch, clip_to_patches, knot_breaks, split_range};
use crate::error::{Operand, SsiError};
use crate::func::{CurveDist, Fn1, dist, enclose1, param_slack, uv_near};
use crate::poly;
use crate::roots1d::{Root1, RootOpts, find_roots, interval_newton, polish_extremum};
use crate::tolerance::SsiTolerance;
use crate::types::{
    Contact, CurveSurfaceHit, CurveSurfaceHits, CurveSurfaceOverlap, RootCertificate, UvBox,
};

/// Intersect a curve (restricted to `t_range`) with a surface (restricted to `domain`).
///
/// See the crate docs ("Curve–surface") for the method and guarantees. Errors:
/// `SSI_UNSUPPORTED` for B-spline surfaces (and curves other than lines against helicoids,
/// which are intersected by `Helicoid::line_hits`), `SSI_INVALID_DOMAIN` for bad ranges,
/// `SSI_TANGENT_UNRESOLVED` if a near-tangency cannot be classified.
pub fn intersect_curve_surface(
    curve: &Curve3,
    t_range: (f64, f64),
    surface: &Surface,
    domain: UvBox,
    tol: &SsiTolerance,
) -> Result<CurveSurfaceHits, SsiError> {
    tol.validate()?;
    if matches!(surface, Surface::BSpline(_)) {
        return Err(SsiError::Unsupported {
            operand: Operand::Surface,
            what: "B-spline surfaces (no implicit form yet)",
        });
    }
    domain.validate(surface, Operand::Surface)?;
    if let Surface::Helicoid(h) = surface {
        return helicoid_hits(curve, t_range, h, domain, tol);
    }
    let (t0, t1) = t_range;
    let bad = |reason| SsiError::InvalidDomain {
        operand: Operand::Curve,
        param: "t",
        lo: t0,
        hi: t1,
        reason,
    };
    if !(t0.is_finite() && t1.is_finite()) {
        return Err(bad("bounds must be finite"));
    }
    if t1 < t0 {
        return Err(bad("inverted range"));
    }
    if let Some(p) = curve.period()
        && t1 - t0 > p * (1.0 + 1e-12)
    {
        return Err(bad("wider than the curve's period"));
    }
    let (d0, d1) = curve.domain();
    if t0 < d0 - 1e-12 * d0.abs().max(1.0) && curve.period().is_none() && d0.is_finite() {
        return Err(bad("outside the curve's domain"));
    }
    if t1 > d1 + 1e-12 * d1.abs().max(1.0) && curve.period().is_none() && d1.is_finite() {
        return Err(bad("outside the curve's domain"));
    }

    let g = CurveDist {
        curve,
        surf: surface,
    };
    let width = t1 - t0;
    let speed = curve_speed_bound(curve, t0, t1);
    let opts = RootOpts {
        zero_tol: tol.fit,
        min_width: (1e-13 * width)
            .max(1e-15 * (t0.abs() + t1.abs()))
            .max(f64::MIN_POSITIVE),
        // An overlap must extend over at least ~1e-3 of the range (and 1e-3 mm).
        flat_width: (1e-3 * width)
            .max(1e-3 / speed.max(1e-300))
            .min(0.5 * width),
        max_pieces: 1_000_000,
    };

    // 1–2. Closed-form candidates, certified individually.
    let mut roots: Vec<Root1> = Vec::new();
    if width > 0.0 {
        for t in closed_form_candidates(curve, surface, t0, t1) {
            // The certificate window must stay inside one knot span (B-splines).
            let br = knot_breaks(curve, t0, t1);
            let lo = br.iter().copied().filter(|&k| k <= t).fold(t0, f64::max);
            let hi = br.iter().copied().filter(|&k| k > t).fold(t1, f64::min);
            if let Some(r) = certify_candidate(&g, t, lo, hi, width) {
                roots.push(r);
            }
        }
    }
    roots.sort_by(|a, b| a.t.total_cmp(&b.t));
    roots.dedup_by(|b, a| b.lo <= a.hi);

    // 3. Everything else: certified search on the gaps between candidate enclosures.
    let mut flats: Vec<(f64, f64)> = Vec::new();
    let mut gaps = Vec::new();
    let mut cursor = t0;
    for r in &roots {
        if r.lo > cursor {
            gaps.push((cursor, r.lo));
        }
        cursor = cursor.max(r.hi);
    }
    if t1 > cursor || (width == 0.0 && roots.is_empty()) {
        gaps.push((cursor, t1));
    }
    for (a, b) in gaps {
        // Interval evaluation of a B-spline is valid within one knot span only.
        for (pa, pb) in split_range(a, b, &knot_breaks(curve, a, b)) {
            let found = find_roots(&g, pa, pb, &opts)?;
            roots.extend(found.roots);
            flats.extend(found.flats);
        }
    }
    roots.sort_by(|a, b| a.t.total_cmp(&b.t));
    roots.dedup_by(|b, a| b.t - a.t <= opts.min_width.max(1e-14 * a.t.abs()));
    flats.sort_by(|a, b| a.0.total_cmp(&b.0));
    let flats = merge_ranges(flats);
    // Roots inside an overlap are part of it.
    roots.retain(|r| !flats.iter().any(|&(a, b)| r.t >= a && r.t <= b));

    // 4. Merge root pairs whose connecting arc stays within fit (grazing contact).
    let roots = merge_grazing(&g, roots, tol.fit);

    // 6. Domain filtering and output.
    let patch = Patch {
        surf: surface,
        dom: domain,
    };
    let (ur, vr) = patch.refs();
    let mut hits = Vec::new();
    for r in &roots {
        let p = curve.eval(r.t);
        let uv = uv_near(surface, p, ur, vr);
        let slack = param_slack(surface, uv, tol.fit);
        if !domain.contains(surface, uv, slack) {
            continue;
        }
        hits.push(make_hit(curve, surface, &g, r, uv, tol));
    }
    // A full period: a hit at t1 repeats the one at t0.
    if let Some(p) = curve.period()
        && width >= p * (1.0 - 1e-12)
        && hits.len() >= 2
        && let Some(last) = hits.last()
        && (last.t - hits[0].t - width).abs() <= 1e-9
    {
        hits.pop();
    }

    // 5. Overlaps (clipped to the domain).
    let mut overlaps = Vec::new();
    for (a, b) in flats {
        let (pieces, _) = clip_to_patches(curve, a, b, &[patch], false)?;
        for (pa, pb) in pieces {
            let bound = split_range(pa, pb, &knot_breaks(curve, pa, pb))
                .into_iter()
                .map(|(x, y)| certify_flat(&g, x, y, tol.fit))
                .fold(0.0, f64::max);
            overlaps.push(CurveSurfaceOverlap {
                t_range: (pa, pb),
                uv_start: uv_near(surface, curve.eval(pa), ur, vr),
                uv_end: uv_near(surface, curve.eval(pb), ur, vr),
                distance_bound: bound,
            });
        }
    }
    Ok(CurveSurfaceHits {
        points: hits,
        overlaps,
        certified_complete: true,
    })
}

/// Line × helicoid (a ray of the boolean's point classification meeting a modelled
/// thread flank): [`Helicoid::line_hits`], certified complete. Any other curve is
/// `SSI_UNSUPPORTED` (a helicoid has no implicit form for the general method).
fn helicoid_hits(
    curve: &Curve3,
    t_range: (f64, f64),
    h: &forge_core::geom::Helicoid,
    domain: UvBox,
    tol: &SsiTolerance,
) -> Result<CurveSurfaceHits, SsiError> {
    let Curve3::Line(l) = curve else {
        return Err(SsiError::Unsupported {
            operand: Operand::Curve,
            what: "curves other than lines against helicoid surfaces",
        });
    };
    let (t0, t1) = t_range;
    if !(t0.is_finite() && t1.is_finite()) || t1 < t0 {
        return Err(SsiError::InvalidDomain {
            operand: Operand::Curve,
            param: "t",
            lo: t0,
            hi: t1,
            reason: "bounds must be finite and ordered",
        });
    }
    let hits = h
        .line_hits(l.origin(), l.dir(), t_range, domain.u, domain.v)
        .map_err(|e| match e {
            forge_core::geom::HelicoidLineHitsError::PatchAtAxis => SsiError::Unsupported {
                operand: Operand::Surface,
                what: "helicoid patches reaching the axis",
            },
            forge_core::geom::HelicoidLineHitsError::Budget => SsiError::BudgetExceeded {
                what: "line × helicoid subdivision",
                limit: forge_core::geom::LINE_HITS_BUDGET,
            },
        })?;
    let width = (t1 - t0).max(1.0);
    let enc = 1e-13 * width;
    let points = hits
        .into_iter()
        .map(|x| {
            let point = curve.eval(x.t);
            let gap = h.eval(x.u, x.v).distance(point);
            CurveSurfaceHit {
                t: x.t,
                uv: Point2::new(x.u, x.v),
                point,
                contact: if x.tangent {
                    Contact::Tangent {
                        gap: gap.min(tol.fit),
                    }
                } else {
                    Contact::Transversal
                },
                multiplicity: if x.tangent { 2 } else { 1 },
                certificate: RootCertificate {
                    t_enclosure: (x.t - enc, x.t + enc),
                    residual: (-gap, gap),
                    unique: !x.tangent,
                    distance_bound: gap,
                },
            }
        })
        .collect();
    Ok(CurveSurfaceHits {
        points,
        overlaps: Vec::new(),
        certified_complete: true,
    })
}

/// An upper bound of `|C'|` over the range (for converting lengths to parameters).
fn curve_speed_bound(curve: &Curve3, t0: f64, t1: f64) -> f64 {
    let mut s: f64 = 0.0;
    for i in 0..=16 {
        let t = t0 + (t1 - t0) * i as f64 / 16.0;
        s = s.max(curve.d1(t).norm());
    }
    s.max(1e-300)
}

fn merge_ranges(r: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b) in r {
        if let Some(l) = out.last_mut()
            && a <= l.1
        {
            l.1 = l.1.max(b);
            continue;
        }
        out.push((a, b));
    }
    out
}

/// Closed-form candidate parameters (unfiltered by the domain) for analytic curves.
fn closed_form_candidates(curve: &Curve3, surface: &Surface, t0: f64, t1: f64) -> Vec<f64> {
    let Some(deg) = surface.algebraic_degree() else {
        return Vec::new();
    };
    let q = |t: f64| surface.algebraic_form(curve.eval(t)).unwrap_or(f64::NAN);
    match curve {
        Curve3::Line(_) => {
            // Evaluate the polynomial on a range padded a little so roots at the ends are
            // interior to the interpolation interval.
            let pad = 1e-9 * (t1 - t0).max(1e-300);
            poly::poly_fn_roots(q, deg as usize, t0 - pad, t1 + pad)
        }
        Curve3::Circle(_) | Curve3::Ellipse(_) => {
            let w = t1 - t0;
            poly::trig_fn_roots(q, deg as usize)
                .into_iter()
                .map(|t| t0 + math::wrap_angle(t - t0, 0.0))
                .flat_map(|t| [t, t - math::TAU, t + math::TAU])
                .filter(|&t| t >= t0 - 1e-12 && t <= t0 + w + 1e-12)
                .collect()
        }
        Curve3::Helix(_) | Curve3::BSpline(_) => Vec::new(),
    }
}

/// Polish a candidate by Newton on `g` and certify it with interval Newton.
fn certify_candidate<F: Fn1>(g: &F, t: f64, t0: f64, t1: f64, width: f64) -> Option<Root1> {
    let t = t.clamp(t0, t1);
    // Newton polish (a few steps; stays near the candidate).
    let mut x = t;
    for _ in 0..8 {
        let d = g.eval(Dual::variable(x));
        if d.d == 0.0 || !d.d.is_finite() {
            break;
        }
        let n = (x - d.v / d.d).clamp(t0, t1);
        if (n - x).abs() > 1e-6 * width.max(1e-300) {
            break;
        }
        if crate::clip::same(n, x) {
            break;
        }
        x = n;
    }
    let win = (1e-7 * width).max(1e-12);
    let (lo, hi, res) = interval_newton(g, x, (x - win).max(t0), (x + win).min(t1))?;
    Some(Root1 {
        t: x,
        lo,
        hi,
        unique: true,
        residual: res,
        sign_change: true,
        abs_value: g.eval(x).abs(),
    })
}

/// Merge consecutive roots whose connecting arc stays within `fit` into one tangential
/// root at the extremum between them.
fn merge_grazing<F: Fn1>(g: &F, roots: Vec<Root1>, fit: f64) -> Vec<Root1> {
    let mut out: Vec<Root1> = Vec::new();
    for r in roots {
        if let Some(prev) = out.last().copied() {
            let (a, b) = (prev.t, r.t);
            if b > a {
                let tc = polish_extremum(g, 0.5 * a + 0.5 * b, a, b);
                let vc = g.eval(tc).abs();
                let within = (0..=16).all(|i| g.eval(a + (b - a) * i as f64 / 16.0).abs() <= fit)
                    && vc <= fit;
                if within {
                    let (v, _) = enclose1(g, prev.lo.min(r.lo), prev.hi.max(r.hi));
                    let merged = Root1 {
                        t: tc,
                        lo: prev.lo.min(r.lo),
                        hi: prev.hi.max(r.hi),
                        unique: false,
                        residual: v,
                        // Two crossings: the sign returns.
                        sign_change: false,
                        abs_value: vc,
                    };
                    *out.last_mut().expect("non-empty") = merged;
                    continue;
                }
            }
        }
        out.push(r);
    }
    out
}

fn make_hit<F: Fn1>(
    curve: &Curve3,
    surface: &Surface,
    g: &F,
    r: &Root1,
    uv: Point2,
    _tol: &SsiTolerance,
) -> CurveSurfaceHit {
    let p = curve.eval(r.t);
    let pi: Vec3<Interval> = p.lift();
    let distance_bound = dist(surface, pi).mag();
    let (contact, multiplicity) = if r.unique {
        // A certified simple root is a crossing, unless the crossing is so shallow that
        // the curve stays within `fit` of the surface over a visible extent: that is
        // handled by `merge_grazing` / overlaps. Report tangency from the derivative.
        let d = g.eval(Dual::variable(r.t)).d;
        let speed = curve.d1(r.t).norm().max(1e-300);
        // |g'| / |C'| is the sine of the angle between curve and surface.
        if (d / speed).abs() <= 1e-12 {
            (Contact::Tangent { gap: r.abs_value }, 3)
        } else {
            (Contact::Transversal, 1)
        }
    } else {
        let m = if r.sign_change { 3 } else { 2 };
        (Contact::Tangent { gap: r.abs_value }, m)
    };
    CurveSurfaceHit {
        t: r.t,
        uv,
        point: p,
        contact,
        multiplicity,
        certificate: RootCertificate {
            t_enclosure: (r.lo, r.hi),
            residual: (r.residual.lo(), r.residual.hi()),
            unique: r.unique,
            distance_bound,
        },
    }
}

/// Certified bound of `|g|` over `[a, b]` (interval enclosures on a partition).
fn certify_flat<F: Fn1>(g: &F, a: f64, b: f64, fit: f64) -> f64 {
    let mut n = 16usize;
    loop {
        let mut worst: f64 = 0.0;
        for i in 0..n {
            let x0 = a + (b - a) * i as f64 / n as f64;
            let x1 = if i + 1 == n {
                b
            } else {
                a + (b - a) * (i + 1) as f64 / n as f64
            };
            let (v, _) = enclose1(g, x0, x1);
            worst = worst.max(v.mag());
        }
        if worst <= fit || n >= 1 << 14 {
            return worst;
        }
        n *= 4;
    }
}
