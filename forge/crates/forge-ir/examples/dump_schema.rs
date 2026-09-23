//! Writes the JSON Schemas for the IR and the metrics report into `schema/`, for both IR
//! versions: `ir-v0.*`, `metrics-v0.*` (frozen) and `ir-v1.*`, `metrics-v1.*` (SPEC-v1).
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
    write(
        "ir-v0.constants.json",
        serde_json::json!({
            "IR_SCHEMA": forge_ir::IR_SCHEMA,
            "METRICS_SCHEMA": forge_ir::METRICS_SCHEMA,
            "LINEAR_TOLERANCE": forge_ir::LINEAR_TOLERANCE,
            "RESERVED_NAMES": forge_ir::RESERVED_NAMES,
        }),
    );
    write("ir-v1.schema.json", forge_ir::v1::document_schema());
    write("metrics-v1.schema.json", forge_ir::v1::report_schema());
    write("ir-v1.constants.json", forge_ir::v1::constants_json());
}
