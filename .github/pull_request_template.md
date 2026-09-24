<!--
Pull requests from outside contributors aren't accepted until the CLA bot is set up (CONTRIBUTING.md, LICENSING.md).
Until then, such PRs are closed without review.

Maintainers and coding agents: read CLAUDE.md first.
-->

## What and why

<!-- What this change does and why. Link the issue, backlog item, roadmap milestone or ADR it implements. -->

## How it was verified

<!-- The commands you ran and their results. Keep every box that applies, and explain any you left unchecked. -->

- [ ] `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` are clean (from `forge/`).
- [ ] `pnpm -r build && pnpm -r test` pass (if TypeScript changed).
- [ ] Geometry changes: `uv run oracle diff ../corpus/programs` was run (from `oracle/`). Every difference is explained or fixed, none is ignored.
- [ ] A new operation comes with its unit tests, property tests, invariant checks and an oracle comparison case, all in this PR.
- [ ] Determinism: no `HashMap`/`HashSet` iteration order reaches an output, no fast-math, and transcendentals go through `forge_core::math`.
- [ ] Errors are structured, with a machine-readable `code` and context. Nothing returns silently wrong geometry.

## Licensing and dependencies

- [ ] No new dependencies. Or: every new dependency's license is allowed by `LICENSING.md` ("Third-party code"), and nothing GPL or LGPL enters a shipped artifact.
- [ ] Oracle-only libraries (OCCT, PlaneGCS, SolveSpace…) are used only under `oracle/` or a `*/oracle/` directory.
- [ ] No secrets, `.env` files, generated corpora, large datasets or build artifacts are committed.

## Docs

- [ ] The docs or ADRs are updated if this changes a decision or a contract (IR, SPEC, CadScript, CLI output, error codes).
