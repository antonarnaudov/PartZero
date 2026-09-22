//! The committed JSON Schemas are consumed by TS codegen and the oracle; they must match
//! the Rust types. Regenerate with `cargo run -p forge-ir --example dump_schema`.
#[test]
fn committed_schemas_match_types() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("schema");
    for (file, schema) in [
        ("ir-v0.schema.json", forge_ir::document_schema()),
        ("metrics-v0.schema.json", forge_ir::report_schema()),
    ] {
        let committed = std::fs::read_to_string(dir.join(file))
            .unwrap_or_else(|_| panic!("missing schema/{file}; run the dump_schema example"));
        let committed: serde_json::Value = serde_json::from_str(&committed).unwrap();
        assert_eq!(committed, schema, "schema/{file} is stale; run the dump_schema example");
    }
}
