//! `naming-harness`: run the spike-2 naming stability harness and print the Markdown
//! report. Exit code 0 when the spike's criteria are met, 1 otherwise.
//!
//! ```text
//! cargo run -p forge-naming --release --bin naming-harness [-- --out report.md]
//! cargo run -p forge-naming --release --bin naming-harness -- --dump <mutation-id part>
//! cargo run -p forge-naming --release --bin naming-harness -- --v1 [--out report.md]
//! cargo run -p forge-naming --release --bin naming-harness -- --v1 --ops-only [--out report.md]
//! ```
//!
//! `--v1` runs the v1 mode ([`forge_naming::harness::v1`]): every reference an IR v1 query
//! resolved by forge-refs, with the W3 gates, then the Phase C operation families on IR v1
//! models ([`forge_naming::harness::ops`]: booleans, holes, fillets, patterns) with theirs (exit 1
//! on NO-GO). `--ops-only` runs just the Phase C families. The v1 gate never passes vacuously:
//! a skipped Phase C mutation, a family below its coverage minimums, or (without
//! `--ops-only`) a run with no spike model is NO-GO ([`v1::coverage_problems`]). `--dump`
//! prints the matching records and exits with the same verdict.

use std::process::ExitCode;

use forge_naming::harness::{ops, report, run, v1};

fn verdict(go: bool) -> ExitCode {
    if go {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn write_out(args: &[String], text: &str) -> Result<(), ExitCode> {
    match args.iter().position(|a| a == "--out") {
        Some(i) => match args.get(i + 1) {
            Some(path) => std::fs::write(path, text).map_err(|e| {
                eprintln!("cannot write {path}: {e}");
                ExitCode::from(2)
            }),
            None => {
                eprintln!("--out needs a path");
                Err(ExitCode::from(2))
            }
        },
        None => {
            print!("{text}");
            Ok(())
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--v1") {
        let ops_only = args.iter().any(|a| a == "--ops-only");
        let rep = if ops_only {
            let mut rep = v1::V1Report::default();
            rep.ops = ops::run_ops(&mut rep);
            rep
        } else {
            v1::run_v1()
        };
        let go = v1::criteria_v1(&rep).go() && (ops_only || rep.models > 0);
        if !ops_only && rep.models == 0 {
            eprintln!("NO-GO: the spike families ran on no model");
        }
        if let Some(i) = args.iter().position(|a| a == "--dump") {
            let pat = args.get(i + 1).map_or("", String::as_str);
            for r in rep.refs.iter().filter(|r| r.mutation.contains(pat)) {
                println!(
                    "{} | {} | {} | {} | {} | expected {} | {} | {}",
                    r.model,
                    r.mutation,
                    r.entity.as_str(),
                    r.key,
                    r.query,
                    r.expected,
                    r.resolution,
                    r.outcome.as_str()
                );
            }
            return verdict(go);
        }
        if let Err(code) = write_out(&args, &v1::render_v1(&rep)) {
            return code;
        }
        return verdict(go);
    }
    let rep = run();
    if let Some(i) = args.iter().position(|a| a == "--dump") {
        // `--dump <mutation-id substring>`: every scored reference of matching mutations.
        let pat = args.get(i + 1).map_or("", String::as_str);
        for r in rep.refs.iter().filter(|r| r.mutation.contains(pat)) {
            println!(
                "{} | {} | {} | {} | expected {} | {} | {}",
                r.model,
                r.mutation,
                r.entity.as_str(),
                r.name,
                r.expected,
                r.resolution,
                r.outcome.as_str()
            );
        }
        return ExitCode::SUCCESS;
    }
    if let Err(code) = write_out(&args, &report::render(&rep)) {
        return code;
    }
    if report::criteria(&rep).go() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
