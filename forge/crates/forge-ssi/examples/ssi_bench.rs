//! Timing of forge-ssi on the deterministic corpus: every pair is intersected `--repeat`
//! times and its best time is kept (robust to machine load); per family the median, 90th
//! percentile and maximum of those best times are printed. Also times line/circle ×
//! surface queries per surface kind.
//!
//! ```text
//! cargo run --release -p forge-ssi --example ssi_bench -- [--seed 17] [--count 1200] [--repeat 5] [--family plane-sphere]
//! ```

use std::collections::BTreeMap;
use std::time::Instant;

use forge_core::geom::{Circle3, Curve3, Line3};
use forge_core::{Point3, math};
use forge_ssi::corpus::{Rng, random_pairs};
use forge_ssi::{SsiTolerance, intersect_curve_surface, intersect_surfaces};

fn stats(mut xs: Vec<f64>) -> (usize, f64, f64, f64) {
    xs.sort_by(f64::total_cmp);
    let n = xs.len();
    let at = |q: f64| xs[((n - 1) as f64 * q).round() as usize];
    (n, at(0.5), at(0.9), xs[n - 1])
}

fn best_of<F: FnMut()>(repeat: usize, mut f: F) -> f64 {
    (0..repeat)
        .map(|_| {
            let t0 = Instant::now();
            f();
            t0.elapsed().as_secs_f64() * 1e6
        })
        .fold(f64::INFINITY, f64::min)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str, default: u64| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(default)
    };
    let seed = arg("--seed", 17);
    let count = arg("--count", 1200) as usize;
    let repeat = arg("--repeat", 5).max(1) as usize;
    let tol = SsiTolerance::default();
    let only: Option<String> = args
        .iter()
        .position(|a| a == "--family")
        .and_then(|i| args.get(i + 1).cloned());
    let mut cases = random_pairs(seed, count);
    if let Some(f) = &only {
        cases.retain(|c| c.family.starts_with(f.as_str()));
    }
    let count = cases.len();

    let mut fam: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut total = 0.0;
    let mut slowest: Vec<(f64, usize)> = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let us = best_of(repeat, || {
            let _ = std::hint::black_box(intersect_surfaces(&c.a, c.dom_a, &c.b, c.dom_b, &tol));
        });
        total += us;
        slowest.push((us, i));
        fam.entry(c.family.clone()).or_default().push(us);
    }
    slowest.sort_by(|a, b| b.0.total_cmp(&a.0));
    println!("surface–surface: {count} pairs (seed {seed}), best of {repeat} runs per pair");
    println!(
        "{:<40} {:>5} {:>10} {:>10} {:>10}",
        "family", "n", "median µs", "p90 µs", "max µs"
    );
    for (f, xs) in fam {
        let (n, med, p90, max) = stats(xs);
        println!("{f:<40} {n:>5} {med:>10.0} {p90:>10.0} {max:>10.0}");
    }
    println!("mean over all pairs: {:.0} µs", total / count as f64);
    println!("slowest pairs:");
    for &(us, i) in slowest.iter().take(8) {
        let c = &cases[i];
        let stats = intersect_surfaces(&c.a, c.dom_a, &c.b, c.dom_b, &tol)
            .map(|g| format!("{} branches, {:?}", g.branches.len(), g.stats))
            .unwrap_or_else(|e| e.code().to_string());
        println!("  #{} {} {us:.0} µs: {stats}", c.id, c.family);
    }

    // Curve–surface: a random line and circle through the second surface of each pair.
    let mut rng = Rng::new(seed ^ 0xbe_c4);
    let mut cs: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for c in cases.iter().take(count.min(600)) {
        let o = Point3::new(
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
            rng.range(-2.0, 2.0),
        );
        let f = rng.frame(o);
        let curves: [(&str, Curve3, (f64, f64)); 2] = [
            (
                "line",
                Line3::new(o - f.z() * 10.0, f.z()).expect("line").into(),
                (0.0, 20.0),
            ),
            (
                "circle",
                Circle3::new(f, rng.range(0.5, 4.0)).expect("circle").into(),
                (0.0, math::TAU),
            ),
        ];
        for (name, curve, range) in &curves {
            let us = best_of(repeat, || {
                let _ = std::hint::black_box(intersect_curve_surface(
                    curve, *range, &c.b, c.dom_b, &tol,
                ));
            });
            let kind = c.family.split(['-', '/']).nth(1).unwrap_or("?");
            cs.entry(format!("{name} × {kind}")).or_default().push(us);
        }
    }
    println!("\ncurve–surface (best of {repeat})");
    println!(
        "{:<40} {:>5} {:>10} {:>10} {:>10}",
        "query", "n", "median µs", "p90 µs", "max µs"
    );
    for (f, xs) in cs {
        let (n, med, p90, max) = stats(xs);
        println!("{f:<40} {n:>5} {med:>10.1} {p90:>10.1} {max:>10.1}");
    }
}
