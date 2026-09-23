//! Bit-level determinism guard for IR v1 evaluation (SPEC-v1 §7.2, CLAUDE.md "bit-identical on
//! every target"), the v1 counterpart of `golden_hash.rs`.
//!
//! Hashes the `aicad.metrics/1` report JSON of every v1 program in `corpus/v1/programs` and of
//! the integration's oracle cases (`tests/v1_programs`: parameters, constrained sketches,
//! sketches on faces, datums, tags, references with probes, joins, cuts, intersects, splits,
//! consumed and merged targets, joins that change nothing or only some targets, an intersect
//! inside its tool, re-joined split pieces, seam cases, a sliver cut, spiric torus sections,
//! and the evaluation-time error
//! codes; `knob_queries`, `plate_features` and `shell_box` are hashed as rejected reports:
//! they use types Forge does not implement yet, SPEC-v1 §0.2 rule 3, and `shell_box` the
//! optional `draft`) and compares it with a constant recorded on the
//! reference platform (aarch64-apple-darwin). Reports print every `f64` in shortest round-trip form, so
//! a one-ulp difference in any metric, probe, frame or parameter changes the hash. The
//! documents are compiled in, so the test also runs on wasm32-wasip1 without a filesystem:
//!
//! ```text
//! cargo test -p forge-regen --release --target wasm32-wasip1 --test v1_golden_hash --no-run
//! node crates/forge-refs/wasm/run_wasi_test.mjs target/wasm32-wasip1/release/deps/v1_golden_hash-<hash>.wasm
//! ```
//!
//! **If this test fails on a new platform or toolchain, results are not bit-identical across
//! targets.** Update the constant only for an intentional change of an algorithm or of the
//! report format, and say so in the commit message.

macro_rules! programs {
    ($($dir:literal / $name:literal),* $(,)?) => {
        [$(($name, include_str!(concat!($dir, $name, ".json")))),*]
    };
}

const PROGRAMS: [(&str, &str); 32] = programs![
    "../../../../corpus/v1/programs/" / "constrained_plate",
    "../../../../corpus/v1/programs/" / "knob_queries",
    "../../../../corpus/v1/programs/" / "params_plate",
    "../../../../corpus/v1/programs/" / "plate_features",
    "../../../../corpus/v1/programs/" / "shell_box",
    "v1_programs/" / "boolean_intersect",
    "v1_programs/" / "boolean_keep_tools",
    "v1_programs/" / "boss_on_face",
    "v1_programs/" / "boxes_cut",
    "v1_programs/" / "boxes_intersect",
    "v1_programs/" / "boxes_join",
    "v1_programs/" / "consumed_target",
    "v1_programs/" / "datum_sketch_revolve_cut",
    "v1_programs/" / "errors_dependencies",
    "v1_programs/" / "errors_expressions",
    "v1_programs/" / "errors_geometry",
    "v1_programs/" / "errors_tag_dependencies",
    "v1_programs/" / "failures_pass_through",
    "v1_programs/" / "intersect_target_inside_tool",
    "v1_programs/" / "join_identical_tool",
    "v1_programs/" / "join_merges_targets",
    "v1_programs/" / "join_nested_tool",
    "v1_programs/" / "join_partial_targets",
    "v1_programs/" / "join_rejoins_split_pieces",
    "v1_programs/" / "seam_boss_over_hole",
    "v1_programs/" / "seam_edge_on_hole_seam",
    "v1_programs/" / "seam_notch_in_disk",
    "v1_programs/" / "seam_notch_in_hole_wall",
    "v1_programs/" / "seam_split_hole_wall_face",
    "v1_programs/" / "split_then_pocket",
    "v1_programs/" / "tiny_sliver_cut",
    "v1_programs/" / "torus_pocket_spiric_edges",
];

/// Programs this engine rejects (their rejected report is hashed): they use `hole`, `fillet`,
/// `chamfer`, `shell` or `pattern`, which Forge does not implement yet (SPEC-v1 §0.2 rule 3,
/// `UNSUPPORTED_FEATURE_VERSION`), and `shell_box` also the optional `draft` (§6.9,
/// `UNSUPPORTED_FEATURE`).
const REJECTED: [&str; 3] = ["knob_queries", "plate_features", "shell_box"];

/// FNV-1a over bytes.
fn fnv(h: &mut u64, b: &[u8]) {
    for &x in b {
        *h ^= u64::from(x);
        *h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
}

/// Recorded on aarch64-apple-darwin.
const PINNED: u64 = 0xb73a_7e16_b736_65da;

#[test]
fn v1_reports_are_bit_identical_to_the_recorded_hash() {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for (name, text) in PROGRAMS {
        let (r, ev) = forge_regen::v1::evaluate_text(text, "forge", name);
        assert_eq!(
            ev.is_none(),
            REJECTED.contains(&name),
            "{name}: rejected {:?}",
            r.error
        );
        let json = serde_json::to_string(&r).expect("json");
        let mut one: u64 = 0xcbf2_9ce4_8422_2325;
        fnv(&mut one, json.as_bytes());
        println!("{name}: {one:#018x}");
        fnv(&mut h, name.as_bytes());
        fnv(&mut h, json.as_bytes());
    }
    println!("total: {h:#018x}");
    assert_eq!(
        h, PINNED,
        "v1 report hash {h:#018x} differs from the recorded {PINNED:#018x}"
    );
}
