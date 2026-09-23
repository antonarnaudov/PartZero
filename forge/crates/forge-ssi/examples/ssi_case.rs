//! Debug helper: run one case of the deterministic corpus and print the result.
//!
//! ```text
//! cargo run -p forge-ssi --example ssi_case -- <seed> <count> <id>
//! ```

use forge_ssi::corpus::random_pairs;
use forge_ssi::{SsiTolerance, intersect_surfaces};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u64 = args.get(1).map_or(17, |s| s.parse().expect("seed"));
    let count: usize = args.get(2).map_or(600, |s| s.parse().expect("count"));
    let id: usize = args.get(3).map_or(0, |s| s.parse().expect("id"));
    let cases = random_pairs(seed, count);
    let c = &cases[id];
    println!("case {} {}", c.id, c.family);
    println!("a = {:?}\n dom_a = {:?}", c.a, c.dom_a);
    println!("b = {:?}\n dom_b = {:?}", c.b, c.dom_b);
    let r = intersect_surfaces(&c.a, c.dom_a, &c.b, c.dom_b, &SsiTolerance::default());
    match r {
        Ok(g) => {
            println!(
                "method {:?}, {} branches, {} vertices, certified {} stats {:?}",
                g.method,
                g.branches.len(),
                g.vertices.len(),
                g.certified_complete,
                g.stats
            );
            for b in &g.branches {
                println!(
                    "  {} closed={} range={:?} bound={:e} contact={:?} sense={:?} start={:?} end={:?}",
                    b.curve.kind_name(),
                    b.closed,
                    b.range,
                    b.error_bound,
                    b.contact,
                    b.sense,
                    b.start,
                    b.end
                );
            }
            for v in &g.vertices {
                println!("  vertex {:?} {:?} {:?}", v.kind, v.point, v.contact);
            }
        }
        Err(e) => println!("error {}: {e}", e.code()),
    }
}
