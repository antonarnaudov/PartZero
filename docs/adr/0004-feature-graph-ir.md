# ADR 0004: A typed Feature-Graph IR is the source of truth

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** PLAN-2026-09-23 §2 D4, §3 "IR essentials"

## Context

- **Many writers, one document.** The GUI, the in-app agent, CadScript/CLI and external agents over MCP all edit the same document. Every edit must be diffable, undoable and eventually mergeable across collaborators (CRDT).
- **Two engines evaluate it.** Forge and the OCCT oracle both evaluate the document and must agree on its meaning.
- **Types must never drift across languages.** The TypeScript UI, agent tools and MCP schemas need exactly the types the Rust engine uses.

## Decision

**The single source of truth is a typed Feature-Graph IR:**
- an ordered feature timeline per Part Studio;
- a derived dependency graph;
- unit-aware expressions.

**Type pipeline:** Rust types in `forge-ir` (serde + schemars) → JSON Schema → TS types and zod schemas for the UI, agent tools and MCP. IR types are never hand-written outside `forge-ir`. A test fails when the checked-in schema is stale.

**Shapes:**
- `Document { schema, units, params, parts, assemblies, blobs }`
- `Feature { id (uuidv7), name (= CadScript const), type, v (pinned behavior version), suppressed?, note?, expect?, author, intent?, assumptions?, decision_ids?, …fields }`

**Edits.** GUI and agent edits are domain ops (`addFeature`, `setField`, `setParam`, `moveFeature`, `setRef`, …) inside transactions with inverses.

**References.** References are stored as queries (`Ref { kind, sel: QueryAST, card, fp? }`), never as kernel indices ([ADR 0006](0006-native-persistent-naming.md)).

**Failures.** A failed feature passes its input through, so one regeneration reports every error.

**Versioning.**
- The schema is versioned (`aicad.ir/0`).
- Each feature pins its behavior version `v`, so old files regenerate identically after kernel changes.
- The normative v0 semantics are in [SPEC.md](../../forge/crates/forge-ir/SPEC.md).

**File format:**
- a zip with `manifest.json`, a canonical `document.json`, `blobs/` and a Forge-build-keyed `cache/`;
- a plain `.json` export for git and agents.

## Consequences

**Positive:**
- **Uniform edits.** Every edit is a transaction: diffable, undoable, labelled ("Revert turn") and mergeable via Loro later.
- **The agent has no special path.** Its edits are ordinary transactions on a draft branch.
- **Git- and LLM-friendly.** The canonical JSON is readable and diffs structurally by feature name.
- **Deterministic caching.** Per-feature cache keys chain naturally: `k_i = H(k_{i-1}, type, v, evaluated fields, resolved refs, forgeBuild)`.

**Negative / costs:**
- **Behavior versions must be maintained.** Changing a feature's semantics means bumping `v` and keeping the old behavior evaluable.
- **Schema evolution needs migrations** between IR versions.
- **Both engines must track every IR change,** since the oracle implements the same spec.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Code as the source of truth (executed scripts, as in OpenSCAD/CadQuery) | Opening a file means running code, which is unsafe. GUI edits can't round-trip cleanly, and diffs and merges are textual, not semantic. |
| B-rep only (direct modeling, no history) | Loses parametric intent. Agents can't "change the width" safely. |
| A pure dependency graph with no ordered timeline | Harder for users and LLMs to reason about. An ordered timeline with a *derived* graph gives both. |
| Hand-maintained TS and Rust types | They drift. The generated schema makes the Rust types the single contract. |
| A binary schema (Protobuf/FlatBuffers) as the primary format | Less readable for LLMs and git reviews. JSON Schema also generates zod and MCP tool schemas directly. |
