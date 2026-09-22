# AI-Native 3D CAD (working title)

An AI-native, cross-platform 3D CAD application. You chat with an in-app agent that builds sketches, parts, assemblies and drawings using the app's own tools, with professional engineering guidance. You can also model everything by hand or tweak whatever the agent made.

It is built on **Forge**, our own AI-native geometry kernel, written in Rust and compiled to native code and WebAssembly. Forge has these properties:

- **Persistent naming** is built into the kernel.
- **Every operation explains its failures**, including the feasible range of values.
- **Results are bit-identical** on every platform.
- **Analytic geometry is exact first.**
- **It is differentiable**, which is planned.

> **Status:** Phase 0 (foundations and spikes). Nothing here is usable yet. See [docs/ROADMAP.md](docs/ROADMAP.md).
>
> **Names are working codenames.** "Forge" (the kernel) and "aicad" (the CLI and package scope) are placeholders until a naming and trademark review.

## Repository map

| Path | What | Language | License |
|---|---|---|---|
| `forge/` | Forge engine: kernel, solvers, tessellation, regeneration, I/O, renderer, bindings | Rust | MPL-2.0 |
| `packages/` | App, UI, CadScript compiler, agent, LLM gateway, MCP server, evals | TypeScript | MPL-2.0; CadScript, format and SDK packages are Apache-2.0 |
| `oracle/` | Differential-testing oracle: evaluates the same IR with OCCT (build123d/OCP). **CI only, never shipped.** | Python | MPL-2.0 |
| `ml/` | Datasets, fine-tuning, RL | Python | MPL-2.0 |
| `skills/` | Part-family skills for the agent | TS + Markdown | Apache-2.0 |
| `corpus/` | Golden models and test programs | JSON/IR | Apache-2.0 |
| `docs/` | Vision, architecture, roadmap, ADRs, spike reports | Markdown | CC-BY-4.0 |

See [LICENSING.md](LICENSING.md) for details.

## Principles

1. **Own the core; use existing libraries only as oracles.** Every component that determines quality is ours. Mature libraries (OCCT, PlaneGCS, …) run only in CI as references for differential testing.
2. **Verification before features.** Oracle diffs, fuzzing, invariants and formal proofs. Forge fails loudly and never returns silently wrong geometry.
3. **Agent-first design.** One command API serves the UI, the agent, the CLI and MCP. Semantic references are used everywhere, and the agent never places anything by raw coordinates.
4. **Model-agnostic AI.** Every major LLM provider is a first-class target, tuned via our eval leaderboard.

## Docs

- [Vision](docs/VISION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Forge kernel](docs/FORGE.md)
- [Roadmap](docs/ROADMAP.md)
- [Research](docs/RESEARCH.md)
- [ADRs](docs/adr/)
- [Contributor and agent guide](CLAUDE.md)
