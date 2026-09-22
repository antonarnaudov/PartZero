# ADR 0005: CadScript, a statically compiled TypeScript subset

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D5, §3 "CadScript example"

## Context

- **Code is how agents build CAD.** Research shows code-as-CAD on a real kernel inside a verify loop is the approach that works. Frontier models write code far better than they manipulate GUIs or raw geometry.
- **Code must not replace the IR.** Executed scripts (OpenSCAD, CadQuery, build123d) lose parameter links once run, make opening a file equivalent to running code, and don't round-trip GUI edits.
- **Some code must be generated per user edit.** We need a textual form that agents and power users edit, and that the GUI can regenerate after every edit without destroying comments and formatting.

## Decision

**CadScript is a statically compiled subset of TypeScript:**
- **Compiled, not executed.** It is parsed (TS AST) into the IR ([ADR 0004](0004-feature-graph-ir.md)) and never executed.
- **Round-trips.** It passes through a canonical printer with source maps. UI edits keep comments and formatting.
- **Tooling for free.** The `.d.ts` standard library (`@aicad/std`) gives `tsc` type checking, Monaco completion and exact error locations. `tsc` plus compiler diagnostics are the first verifier (L0).
- **One binding per feature.** Each `const` is a feature, and the constant's name is the feature's `name`.
- **Structural edits.** A code edit compiles, is diffed against the IR by feature name, and is applied as granular ops.
- **Loops only in a sandbox.** Loops and general computation are allowed only inside a sandboxed `customFeature` (QuickJS-WASM).

**Validation.** A Phase 0 bake-off validates the choice against build123d-MCP: Anthropic, OpenAI and Google flagships on 30 T1 tasks.
- **Pass:** CadScript ≥ build123d's score minus 5 points, ≥50% of hidden tests passing, median cost ≤$1.
- **If it loses, we change the syntax, not the engine.**

## Consequences

**Positive:**
- **Parameter links stay intact.** Code and GUI are two views of the same IR.
- **Opening a file is safe,** because nothing executes outside the QuickJS sandbox.
- **Mainstream syntax.** LLMs already know TypeScript well, and diagnostics point at exact spans.
- **Git-friendly.** CadScript files work in git with the `aicad` CLI (`build | test | render | export`).

**Negative / costs:**
- **We maintain a compiler and printer,** and the round-trip must stay lossless (Phase 0 spike 6: lossless on 50 models).
- **The subset can surprise users.** It forbids things TypeScript users expect (loops, arbitrary calls), so the error messages must be excellent.
- **Early agent runs have a dependency gap.** They depend on the oracle backend until Forge covers the needed features.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| build123d / CadQuery (Python, executed) | The strongest current baseline for LLMs. But it executes code, loses parameter links, and ties us to OCCT semantics. It remains the bake-off baseline. |
| OpenSCAD | CSG on meshes, with no B-rep features, fillets or persistent references |
| A new custom DSL (e.g. like Onshape FeatureScript) | LLMs lack training data for it, and we'd have to build the tooling ourselves (types, editor, diagnostics) |
| JSON IR only, with no textual language | Verbose for LLMs and humans. No type checker or editor tooling. |
| Full TypeScript, executed | Unsafe to open, non-deterministic, and impossible to round-trip into a structured IR |
