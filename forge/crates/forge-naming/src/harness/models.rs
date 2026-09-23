//! The spike's model set: 20 IR v0 maker models, embedded at compile time.
//!
//! - 16 MakerBench references (`corpus/makerbench/*.cad.ts`, Apache-2.0, hand-written),
//!   compiled to IR with the CadScript compiler:
//!   `node packages/cadscript/dist/cli.js compile corpus/makerbench/<id>.cad.ts -o
//!   forge/crates/forge-naming/models/<id>.json`.
//! - 2 corpus programs copied from `corpus/programs/` (a partial revolve and a
//!   two-region extrude).
//! - 2 richer models written for this spike (`naming-*.json`): a plate with rounded
//!   corners, a D-shaft hole, two slots and six holes; and a 200° revolve of a filleted
//!   bowl wall plus a separate D-shaped bead (two bodies from one feature, `#index`
//!   families on both).

use forge_ir::Document;

/// A named model.
#[derive(Clone, Debug)]
pub struct Model {
    /// File stem.
    pub name: &'static str,
    /// Where it comes from.
    pub source: &'static str,
    /// The document.
    pub doc: Document,
}

macro_rules! model {
    ($name:literal, $source:literal) => {
        (
            $name,
            $source,
            include_str!(concat!("../../models/", $name, ".json")),
        )
    };
}

const MODELS: &[(&str, &str, &str)] = &[
    model!("t1-nema17-plate", "makerbench"),
    model!("t1-cable-clip", "makerbench"),
    model!("t1-knob", "makerbench"),
    model!("t1-v-pulley", "makerbench"),
    model!("t1-slotted-shim", "makerbench"),
    model!("t1-drawer-pull", "makerbench"),
    model!("t1-shelf-bracket", "makerbench"),
    model!("t1-2020-corner-plate", "makerbench"),
    model!("t1-tube-end-plug", "makerbench"),
    model!("t1-keychain-tag", "makerbench"),
    model!("t2-enclosure-with-lid", "makerbench"),
    model!("t2-parts-tray", "makerbench"),
    model!("t2-wall-hook", "makerbench"),
    model!("t2-spool-holder", "makerbench"),
    model!("t2-jar-with-lid", "makerbench"),
    model!("t5-pcb-spacers", "makerbench"),
    model!("revolve_partial_ring", "corpus/programs"),
    model!("extrude_two_regions", "corpus/programs"),
    model!("naming-d-coupler-plate", "spike 2"),
    model!("naming-revolve-bead-partial", "spike 2"),
];

/// All spike models, parsed and validated.
///
/// # Panics
/// If an embedded model does not parse (a build-time fixture error).
pub fn models() -> Vec<Model> {
    MODELS
        .iter()
        .map(|&(name, source, json)| Model {
            name,
            source,
            doc: forge_ir::from_json(json)
                .unwrap_or_else(|e| panic!("model {name} does not parse: {e:?}")),
        })
        .collect()
}
