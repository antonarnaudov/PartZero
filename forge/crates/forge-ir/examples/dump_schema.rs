//! Writes the JSON Schemas for the IR and the metrics report into `schema/`.
//! Run: `cargo run -p forge-ir --example dump_schema`
fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("schema");
    std::fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, v: serde_json::Value| {
        let path = dir.join(name);
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
        println!("wrote {}", path.display());
    };
    write("ir-v0.schema.json", forge_ir::document_schema());
    write("metrics-v0.schema.json", forge_ir::report_schema());
}
