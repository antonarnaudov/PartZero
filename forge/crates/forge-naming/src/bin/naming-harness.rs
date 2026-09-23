//! `naming-harness`: run the spike-2 naming stability harness and print the Markdown
//! report. Exit code 0 when the spike's criteria are met, 1 otherwise.
//!
//! ```text
//! cargo run -p forge-naming --release --bin naming-harness [-- --out report.md]
//! cargo run -p forge-naming --release --bin naming-harness -- --dump <mutation-id part>
//! cargo run -p forge-naming --release --bin naming-harness -- --v1 [--out report.md]
//! ```
//!
//! `--v1` runs the v1 mode ([`forge_naming::harness::v1`]): every reference an IR v1 query
//! resolved by forge-refs, with the W3 gates (exit 1 on NO-GO).

use std::process::ExitCode;

use forge_naming::harness::{report, run, v1};

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
        let rep = v1::run_v1();
        if let Some(i) = args.iter().position(|a| a == "--dump") {
            let pat = args.get(i + 1).map_or("", String::as_str);
            for r in rep.refs.iter().filter(|r| r.mutation.contains(pat)) {
                println!(
                    "{} | {} | {} | {} | expected {} | {} | {}",
                    r.model,
                    r.mutation,
                    r.entity.as_str(),
                    r.key,
                    r.expected,
                    r.resolution,
                    r.outcome.as_str()
                );
            }
            return ExitCode::SUCCESS;
        }
        if let Err(code) = write_out(&args, &v1::render_v1(&rep)) {
            return code;
        }
        return if v1::criteria_v1(&rep).go() {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(1)
        };
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
