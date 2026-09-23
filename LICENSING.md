# Licensing

This project is **open-core**. The rationale is in [ADR 0001](docs/adr/0001-open-core-licensing.md).

| Component | License | File |
|---|---|---|
| Forge engine (`forge/`), except `forge-ir` | Mozilla Public License 2.0 | [LICENSE-MPL-2.0](LICENSE-MPL-2.0) |
| Application and engine packages (`packages/*` unless noted), including `@aicad/llm-gateway` | MPL-2.0 | [LICENSE-MPL-2.0](LICENSE-MPL-2.0) |
| Oracle and ML tooling (`oracle/`, every `*/oracle/` test-tooling directory, `ml/`) | MPL-2.0 | [LICENSE-MPL-2.0](LICENSE-MPL-2.0) |
| CadScript language, file format, SDK, MCP schemas (`packages/cadscript`, `packages/ir-types`, `forge/crates/forge-ir`, `packages/sdk`, `packages/mcp-schema`) | Apache License 2.0 | [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) |
| Skills (`skills/`) and corpus (`corpus/`) | Apache-2.0 | [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) |
| Documentation (`docs/`) | CC-BY-4.0 | — |

Every package or crate states its license in its manifest (`Cargo.toml` `license`, `package.json` `license`, `pyproject.toml` `license`), and it must be the license this table assigns to its path.

**Why the two exceptions.**
- `forge/crates/forge-ir` is Apache-2.0 although it lives in the MPL-2.0 `forge/` tree: it **is** the file-format contract (the IR types, the JSON Schemas and the normative `SPEC.md`) that `packages/ir-types`, the oracle and third-party tools implement.
- `@aicad/llm-gateway` is an application package like the others, so it is MPL-2.0. It is not part of the language, format or SDK contract.

## Contributions

Contributions are accepted under a Contributor License Agreement (CLA). A CLA bot will be set up before the public launch. The CLA keeps open the option to offer Forge under a commercial OEM license alongside MPL-2.0, as described in ADR 0001.

## Third-party code

- **Shipped artifacts have no LGPL or GPL runtime dependencies.** A dependency may be used under MIT, Apache-2.0 (also `WITH LLVM-exception`), BSD-2-Clause, BSD-3-Clause, ISC, Zlib, 0BSD, Unlicense, Unicode-3.0 or MPL-2.0; JavaScript packages may also use BlueOak-1.0.0, CC0-1.0 or Python-2.0. An `OR` expression passes when one side is allowed. Everything else, in particular every GPL, LGPL and AGPL version, is denied.
- **GPL and LGPL tools are used only as external test oracles in CI** and are never distributed with the product. Examples: OCCT via OCP/build123d, PlaneGCS, SolveSpace, CalculiX. They may appear only under `oracle/` or a `*/oracle/` directory (for example `forge/crates/forge-solve/oracle/`), which is never part of the Cargo or pnpm workspace, never lies inside a workspace package or a crate's sources, and is never imported by anything that ships ([ADR 0000](docs/adr/0000-own-the-core.md)).
- **CI enforces this** (`.github/workflows/ci.yml`, job `licenses`):
  - `cargo deny check licenses bans` with [`forge/deny.toml`](forge/deny.toml): the normal and build dependencies of every Forge crate, on every target, including `forge-wasm`, `forge-cli` and `forge-render`; dev-dependencies are excluded because they never ship;
  - [`scripts/license-check/js-licenses.mjs`](scripts/license-check/js-licenses.mjs): the production dependency closure of every workspace package, following workspace dependencies transitively, plus development dependencies that ship anyway (`@aicad/app` and Electron in the desktop app); an oracle library, or a package from an oracle directory, anywhere in that closure fails whatever its license;
  - [`scripts/license-check/own-licenses.mjs`](scripts/license-check/own-licenses.mjs): every manifest declares the license of the table above;
  - [`scripts/license-check/oracle-boundary.mjs`](scripts/license-check/oracle-boundary.mjs): oracle libraries are imported or declared only in oracle directories, no directory named `oracle` sits inside a workspace package or a crate's sources, and nothing outside an oracle directory imports from one;
  - [`scripts/license-check/dataset-record.mjs`](scripts/license-check/dataset-record.mjs): the dataset record is the tracked `corpus/EXTERNAL_SOURCES.md`, and no document still points to its old, git-ignored location inside `corpus/external/`.
  The allow lists live in `forge/deny.toml` and `scripts/license-check/policy.mjs`; a self-test keeps the two in step.
- **Test datasets** (DeepCAD, Fusion 360 Gallery, ABC) are downloaded at test time under their own licenses and are never committed. Each dataset's license must be checked and recorded in [`corpus/EXTERNAL_SOURCES.md`](corpus/EXTERNAL_SOURCES.md) before first use. The downloads themselves go to the git-ignored `corpus/external/`.
