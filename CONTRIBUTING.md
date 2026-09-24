# Contributing to PartZero

Thanks for your interest. PartZero is in **Phase 0** (foundations and spikes), and nothing here is usable yet. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Outside contributions are not accepted yet

**We do not accept pull requests or other code, documentation or data contributions from outside the project until the Contributor License Agreement (CLA) bot is set up.**

- The reason is in [LICENSING.md](LICENSING.md#contributions) and [ADR 0001](docs/adr/0001-open-core-licensing.md): every contribution must come in under a CLA, so that Forge can later be offered under a commercial license alongside MPL-2.0.
- Until the CLA bot is live, pull requests from outside contributors are closed without review, however small they are. Please don't open them. We can't merge them later either, because they weren't made under a CLA.
- When the CLA bot is live, this file will say so and describe the process.

## What you can do now

- **Report a bug** with the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include the exact inputs: the IR document or CadScript file, the command you ran and its full output.
- **Report a security problem privately.** Don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Follow along.** The plan is in [docs/VISION.md](docs/VISION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/FORGE.md](docs/FORGE.md) and [docs/ROADMAP.md](docs/ROADMAP.md). Decisions are in [docs/adr/](docs/adr/).

Issues don't transfer any code to the project, so they don't need a CLA. Please don't paste patches or code you'd like us to use into an issue.

## Coding agents and maintainers

Most of this repository is written by AI coding agents. **Agents and humans both start with [CLAUDE.md](CLAUDE.md)** ([AGENTS.md](AGENTS.md) points there too). It has the non-negotiable principles, the repo map, the conventions for Rust, TypeScript and Python, and how to verify a change.

In short, every change must meet these rules:

- **Own the core.** Don't add a runtime dependency on another CAD kernel, constraint solver, mesher or renderer. OCCT, PlaneGCS, SolveSpace and similar tools are allowed only under `oracle/` or a `*/oracle/` directory, as CI test tooling.
- **Never return silently wrong geometry.** A kernel operation returns a valid result or a structured, explainable error.
- **Verification comes first.** A new operation arrives in the same PR as its unit tests, property tests, invariant checks and an oracle comparison case.
- **No runtime GPL or LGPL.** Check the license of every new dependency against [LICENSING.md](LICENSING.md#third-party-code). CI enforces it (`cargo deny` and `scripts/license-check/`).
- **Update the docs.** If a change alters a decision or a contract, update the relevant doc or ADR in the same PR.
- **Keep commits small and focused,** with imperative subject lines.

## Building from source

You need Rust 1.92 (pinned in `forge/rust-toolchain.toml`), Node 22 or later with pnpm 10 (pinned in `package.json`), and [uv](https://docs.astral.sh/uv/) for the Python oracle (CPython 3.13, pinned in `oracle/.python-version`).

```bash
# Rust: Forge (run from forge/)
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

# TypeScript (repo root)
pnpm install && pnpm -r build && pnpm -r test
pnpm --filter @aicad/desktop dev        # the desktop app (Vite + Electron)

# Oracle: CI and dev tooling only, never shipped (run from oracle/)
uv run pytest
uv run oracle diff ../corpus/programs
```

[CLAUDE.md](CLAUDE.md#commands) has the full list.

## Licensing

Each path has its own license: MPL-2.0, Apache-2.0 or CC-BY-4.0. The table in [LICENSING.md](LICENSING.md) says which applies where.

## Code of conduct

Everyone who takes part in this project agrees to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
