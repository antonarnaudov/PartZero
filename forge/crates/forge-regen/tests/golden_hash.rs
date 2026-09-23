//! Bit-level determinism guard for regeneration (Phase 0 audit M5).
//!
//! Hashes the canonical `aicad.metrics/0` report JSON of every program in
//! `corpus/programs` (plus a few inline documents that exercise singular joins, spindle
//! and horn tori and cone apexes on the axis) and compares it with a constant recorded on
//! the reference platform (aarch64-apple-darwin). Reports print every `f64` in shortest
//! round-trip form, so a one-ulp difference anywhere in sketch regions, forge-ops
//! geometry or forge-check's mass properties and boxes changes the hash. The engine
//! string is fixed (`forge`) so a version bump does not change it.
//!
//! **If this test fails on a new platform or toolchain, results are not bit-identical
//! across targets.** Investigate (a platform intrinsic, FMA contraction, a HashMap
//! iteration, …) before touching the constant. Update the constant only for an
//! intentional change of an algorithm or of the report format, and say so in the commit
//! message.

use std::path::PathBuf;

use forge_regen::{evaluate, report};

/// FNV-1a over bytes.
struct Fnv(u64);

impl Fnv {
    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 ^= u64::from(x);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

fn canonical_report(text: &str, name: &str) -> String {
    let doc = forge_ir::from_json(text).expect("valid IR");
    let ev = evaluate(&doc);
    serde_json::to_string(&report(&doc, &ev, "forge", name)).expect("json")
}

fn corpus_programs() -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../corpus/programs");
    let mut v: Vec<(String, String)> = std::fs::read_dir(&dir)
        .expect("corpus/programs")
        .filter_map(|e| {
            let p = e.ok()?.path();
            if p.extension()? != "json" {
                return None;
            }
            let name = p.file_stem()?.to_string_lossy().into_owned();
            Some((name, std::fs::read_to_string(&p).expect("program")))
        })
        .collect();
    v.sort();
    assert!(
        v.len() >= 8,
        "corpus/programs has only {} programs",
        v.len()
    );
    v
}

/// Revolve documents from the Phase 0 audit repros (H1, H2, V1).
fn inline_programs() -> Vec<(String, String)> {
    let doc = |name: &str, plane: &str, curves: &str, angle: f64| {
        format!(
            r#"{{"schema":"aicad.ir/0","meta":{{"name":"{name}"}},"parts":[{{"id":"p1",
            "name":"part","features":[{{"type":"sketch","id":"s1","name":"profile",
            "plane":"{plane}","curves":{curves}}},{{"type":"revolve","id":"r1","name":"spinner",
            "sketch":"profile","axis":{{"origin":[0,0],"direction":[0,1]}},"angle":{angle:?}}}]}}]}}"#
        )
    };
    let pocket = |cx: f64| {
        format!(
            r#"[{{"kind":"arc","id":"pocket","start":[0,10],"end":[0,0],"center":[{cx:?},5],"ccw":false}},
            {{"kind":"line","id":"ax1","start":[0,0],"end":[0,-10]}},
            {{"kind":"line","id":"bot","start":[0,-10],"end":[9,-10]}},
            {{"kind":"line","id":"side","start":[9,-10],"end":[9,12]}},
            {{"kind":"line","id":"top","start":[9,12],"end":[0,12]}},
            {{"kind":"line","id":"ax2","start":[0,12],"end":[0,10]}}]"#
        )
    };
    let lemon = r#"[{"kind":"arc","id":"arc","start":[0,-6],"end":[2,0],"center":[-8,0],"ccw":true},
        {"kind":"line","id":"top","start":[2,0],"end":[0,0]},
        {"kind":"line","id":"ax","start":[0,0],"end":[0,-6]}]"#;
    let horn = r#"[{"kind":"arc","id":"arc","start":[0,0],"end":[4,-4],"center":[4,0],"ccw":true},
        {"kind":"line","id":"l","start":[4,-4],"end":[0,-4]},
        {"kind":"line","id":"ax","start":[0,-4],"end":[0,0]}]"#;
    let mut v = vec![
        (
            "h1_pocket".into(),
            doc("h1_pocket", "XZ", &pocket(0.0), 359.9999999),
        ),
        (
            "h1_lemon_pocket".into(),
            doc("h1_lemon_pocket", "XZ", &pocket(-2.0), 359.9999999),
        ),
        (
            "h1_apple_pocket".into(),
            doc("h1_apple_pocket", "XZ", &pocket(2.0), 359.9999999),
        ),
        (
            "h1_pocket_tiny".into(),
            doc("h1_pocket_tiny", "XZ", &pocket(0.0), 1e-7),
        ),
        ("h2_lemon".into(), doc("h2_lemon", "XY", lemon, 360.0)),
        ("h2_horn".into(), doc("h2_horn", "XZ", horn, 360.0)),
        (
            "h2_horn_partial".into(),
            doc("h2_horn_partial", "XZ", horn, 200.0),
        ),
    ];
    // V1: gen_s23_00159 (a cone whose apex is a profile vertex on the axis, in a tilted
    // frame; its export failed before the forge-mesh nappe fix).
    v.push((
        "v1_gen_s23_00159".into(),
        r#"{"schema":"aicad.ir/0","meta":{"name":"gen_s23_00159"},"parts":[{"id":"p1","name":"part_1","features":[{"type":"sketch","id":"s1","name":"sketch_1","plane":{"origin":[-18.94358160729014,45.741165330523216,-19.93867085978202],"normal":[-0.3503615961936677,0.44856023153206664,-0.8222168026746497],"x_dir":[0.8703197088720082,-0.16847870970821788,-0.46277265338824536]},"curves":[{"kind":"line","id":"l1","start":[17.449335313913032,28.018706582897217],"end":[7.402868190292725,28.018706582897217]},{"kind":"line","id":"l2","start":[7.402868190292725,7.834024312338311],"end":[17.449335313913032,28.018706582897217]},{"kind":"line","id":"line_03","start":[7.402868190292725,7.834024312338311],"end":[7.402868190292725,28.018706582897217]}]},{"type":"revolve","id":"r1","name":"revolve_1","sketch":"sketch_1","axis":{"origin":[30.504787779054546,28.018706582897217],"direction":[-0.39266677820044843,-0.0]},"angle":246.6483818548231}]}]}"#.into(),
    ));
    v
}

fn fingerprint() -> u64 {
    let mut h = Fnv(0xcbf2_9ce4_8422_2325);
    for (name, text) in corpus_programs().into_iter().chain(inline_programs()) {
        let r = canonical_report(&text, &name);
        assert!(r.contains(r#""status":"ok""#), "{name}: {r}");
        h.bytes(name.as_bytes());
        h.bytes(&[0]);
        h.bytes(r.as_bytes());
        h.bytes(b"\n");
    }
    h.0
}

/// Recorded on aarch64-apple-darwin (rustc 1.92.0) after the Phase 0 H1/H2 fixes.
const GOLDEN: u64 = 0x3afa_046f_1164_8c69;

#[test]
fn regen_reports_match_the_golden_hash() {
    let got = fingerprint();
    assert_eq!(
        got, GOLDEN,
        "regeneration fingerprint {got:#018x} != golden {GOLDEN:#018x}: reports are not \
         bit-identical to the reference platform (see the module docs before updating)"
    );
}

#[test]
fn the_fingerprint_is_stable_within_a_process() {
    assert_eq!(fingerprint(), fingerprint());
}
