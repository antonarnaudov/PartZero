# Licensing

This project is **open-core**. The rationale is in [ADR 0001](docs/adr/0001-open-core-licensing.md).

| Component | License | File |
|---|---|---|
| Forge engine (`forge/`) | Mozilla Public License 2.0 | [LICENSE-MPL-2.0](LICENSE-MPL-2.0) |
| Application and engine packages (`packages/*` unless noted) | MPL-2.0 | [LICENSE-MPL-2.0](LICENSE-MPL-2.0) |
| Oracle and ML tooling (`oracle/`, `ml/`) | MPL-2.0 | [LICENSE-MPL-2.0](LICENSE-MPL-2.0) |
| CadScript language, file format, SDK, MCP schemas (`packages/cadscript`, `packages/ir-types`, `packages/sdk`, `packages/mcp-schema`) | Apache License 2.0 | [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) |
| Skills (`skills/`) and corpus (`corpus/`) | Apache-2.0 | [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) |
| Documentation (`docs/`) | CC-BY-4.0 | — |

Every package or crate states its license in its manifest (`Cargo.toml` `license`, `package.json` `license`, `pyproject.toml` `license`).

## Contributions

Contributions are accepted under a Contributor License Agreement (CLA). A CLA bot will be set up before the public launch. The CLA keeps open the option to offer Forge under a commercial OEM license alongside MPL-2.0, as described in ADR 0001.

## Third-party code

- **Shipped artifacts have no LGPL or GPL runtime dependencies.** CI enforces this with a license-check job.
- **GPL and LGPL tools are used only as external test oracles in CI** and are never distributed with the product. Examples: OCCT via OCP/build123d, SolveSpace, CalculiX.
- **Test datasets** (DeepCAD, Fusion 360 Gallery, ABC) are downloaded at test time under their own licenses and are never committed. Each dataset's license must be checked and recorded in `corpus/external/SOURCES.md` before use.
