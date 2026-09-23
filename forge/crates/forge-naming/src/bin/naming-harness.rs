//! `naming-harness`: run the spike-2 naming stability harness and print the Markdown
//! report. Exit code 0 when the spike's criteria are met, 1 otherwise.
//!
//! ```text
//! cargo run -p forge-naming --release --bin naming-harness [-- --out report.md]
//! cargo run -p forge-naming --release --bin naming-harness -- --dump <mutation-id part>
//! ```

use std::process::ExitCode;

use forge_naming::harness::{report, run};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
    let text = report::render(&rep);
    match args.iter().position(|a| a == "--out") {
        Some(i) => match args.get(i + 1) {
            Some(path) => {
                if let Err(e) = std::fs::write(path, &text) {
                    eprintln!("cannot write {path}: {e}");
                    return ExitCode::from(2);
                }
            }
            None => {
                eprintln!("--out needs a path");
                return ExitCode::from(2);
            }
        },
        None => print!("{text}"),
    }
    if report::criteria(&rep).go() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
