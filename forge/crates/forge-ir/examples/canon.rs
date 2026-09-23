//! Validate IR documents (v0 or v1) and print them as canonical IR v1 JSON (v0 is migrated).
//!
//!   cargo run -p forge-ir --example canon -- file.json...            # print canonical v1 JSON
//!   cargo run -p forge-ir --example canon -- --write file.json...    # rewrite files in place
//!
//! Exit code 2 when a document is rejected (each problem is printed as `code path message`).
fn main() {
    let mut write = false;
    let mut failed = false;
    for arg in std::env::args().skip(1) {
        if arg == "--write" {
            write = true;
            continue;
        }
        let text = std::fs::read_to_string(&arg).unwrap_or_else(|e| panic!("{arg}: {e}"));
        match forge_ir::v1::from_json(&text) {
            Ok(doc) => {
                let out = forge_ir::v1::to_json(&doc) + "\n";
                if write {
                    std::fs::write(&arg, out).unwrap();
                    eprintln!("wrote {arg}");
                } else {
                    print!("{out}");
                }
            }
            Err(e) => {
                failed = true;
                eprintln!("{arg}: rejected");
                match &e {
                    forge_ir::v1::LoadError::Parse { .. } => eprintln!("  {e}"),
                    forge_ir::v1::LoadError::Invalid(errs) => {
                        for err in errs {
                            eprintln!("  {} {} {}", err.code, err.path, err.message);
                        }
                    }
                }
            }
        }
    }
    if failed {
        std::process::exit(2);
    }
}
