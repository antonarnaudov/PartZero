//! Bit-level determinism guard for IR v1 evaluation (SPEC-v1 §7.2, CLAUDE.md "bit-identical on
//! every target"), the v1 counterpart of `golden_hash.rs`.
//!
//! Hashes the `aicad.metrics/1` report JSON of every v1 program in `corpus/v1/programs` and of
//! the integration's oracle cases (`tests/v1_programs`: parameters, constrained sketches,
//! sketches on faces, datums, tags, references with probes, joins, cuts, intersects, splits,
//! consumed and merged targets, joins whose tools lie inside a target, joins that leave some
//! targets, an intersect inside its tool, re-joined split pieces, seam cases, a sliver cut,
//! spiric torus sections, the evaluation-time error codes, and since Phase C every hole kind
//! and placement, linear / circular / mirror / body-seed patterns, fillets, chamfers and
//! shells, and since the FM feature tools drafts (`draft_walls`; `shell_box`'s draft of a rounded
//! box fails with `DRAFT_FACE_UNSUPPORTED`, SPEC-v1 §6.9)) and compares it with a constant
//! recorded on the
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

const PROGRAMS: [(&str, &str); 37] = programs![
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
    "v1_programs/" / "blends_box",
    "v1_programs/" / "consumed_target",
    "v1_programs/" / "datum_sketch_revolve_cut",
    "v1_programs/" / "draft_walls",
    "v1_programs/" / "errors_dependencies",
    "v1_programs/" / "errors_expressions",
    "v1_programs/" / "errors_geometry",
    "v1_programs/" / "errors_tag_dependencies",
    "v1_programs/" / "failures_pass_through",
    "v1_programs/" / "fillet_then_chamfer_keys",
    "v1_programs/" / "holes_kinds",
    "v1_programs/" / "intersect_target_inside_tool",
    "v1_programs/" / "join_identical_tool",
    "v1_programs/" / "join_merges_targets",
    "v1_programs/" / "join_nested_tool",
    "v1_programs/" / "join_partial_targets",
    "v1_programs/" / "join_rejoins_split_pieces",
    "v1_programs/" / "patterns_mixed",
    "v1_programs/" / "seam_boss_over_hole",
    "v1_programs/" / "seam_edge_on_hole_seam",
    "v1_programs/" / "seam_notch_in_disk",
    "v1_programs/" / "seam_notch_in_hole_wall",
    "v1_programs/" / "seam_split_hole_wall_face",
    "v1_programs/" / "split_then_pocket",
    "v1_programs/" / "tiny_sliver_cut",
    "v1_programs/" / "torus_pocket_spiric_edges",
];

/// Programs this engine rejects (their rejected report is hashed): none since the draft
/// (§6.9) is evaluated. Until then `shell_box` was rejected for its optional `draft`
/// (`UNSUPPORTED_FEATURE`), and until Phase C `knob_queries` and `plate_features` too (`hole`,
/// `fillet`, `chamfer`, `shell`, `pattern`: `UNSUPPORTED_FEATURE_VERSION`).
const REJECTED: [&str; 0] = [];

/// FNV-1a over bytes.
fn fnv(h: &mut u64, b: &[u8]) {
    for &x in b {
        *h ^= u64::from(x);
        *h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
}

/// Recorded on aarch64-apple-darwin.
///
/// History (per-program hashes printed by `--nocapture`):
/// - `0xb73a_7e16_b736_65da` → `0xda8f_b68c_1363_96f9`: W4's [W0-39] alignment — a join whose
///   tools lie inside or equal its target now lists the target as `modified`
///   (`join_nested_tool` 0x12fa835dec9d998b, `join_identical_tool` 0x219ce5e4607071e1; no
///   other program moved).
/// - → `0xaf34_a471_1876_8a6f` (Phase C integration, 2026-09-24): holes, patterns, fillets,
///   chamfers and shells evaluate — `knob_queries` (0xef604b78a23398f8) and `plate_features`
///   (0x744b511a86be14af) are evaluated instead of rejected, `shell_box`'s rejected report
///   lists only its `draft` (0x1bd5ead80d8fca3e), and four oracle cases were added
///   (`blends_box`, `fillet_then_chamfer_keys`, `holes_kinds`, `patterns_mixed`). Every other
///   program's hash is unchanged (the [W0-40] `removed` fix of forge-regen changes none of
///   them).
/// - → `0x48c0_7ec4_5636_0ea3` (FM feature tools, 2026-09-25): the optional `draft` evaluates
///   (planar walls between planar faces) — `shell_box` is evaluated instead of rejected
///   (0x5225a661e8497b88; its draft of a rounded box fails with `DRAFT_FACE_UNSUPPORTED`) and
///   the oracle case `draft_walls` was added (0x9d98ab9a05e3dbd4). The draft code path is new
///   and only draft features reach it; the per-program hashes recorded above (`knob_queries`,
///   `plate_features`, `join_nested_tool`, `join_identical_tool`) are unchanged.
const PINNED: u64 = 0x48c0_7ec4_5636_0ea3;

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
