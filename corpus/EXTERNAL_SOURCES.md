# External datasets

The license record that [LICENSING.md](../LICENSING.md) and [ADR 0001](../docs/adr/0001-open-core-licensing.md) require for every third-party dataset used in tests, evals or training.

**Rules.**
- A dataset is **recorded here before its first download** by any script, test or CI job, with its license checked from the source (not from a mirror or a paper).
- Datasets are downloaded at test time into `corpus/external/<dataset>/`, which is git-ignored. They are **never committed**, and nothing derived from them ships unless the license allows it and the row says so.
- A dataset whose license forbids our use (for example non-commercial terms for a model we ship) is not used, or is used only where the license allows it, and the row says where.
- When a dataset's license or terms change, update the row and the date.

| Dataset | Version / snapshot | Source | License (as published) | Allowed use here | Used by | Checked (date, by) |
|---|---|---|---|---|---|---|

No external dataset is used yet. Planned: ABC (STEP import tests, `forge/crates/forge-io/src/step.rs`), DeepCAD and Fusion 360 Gallery (evals and training, `docs/RESEARCH.md`). Each needs a row before its first use.
