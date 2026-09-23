# Spike 06: CadScript ⇄ IR round-trip

- **Owner / workstream:** CadScript agent (main branch)
- **Dates:** 2026-09-23
- **Commit(s):** 83086e0, 4d54427
- **Verdict:** **GO**

## Goal
Can a statically compiled TypeScript subset serve as a lossless, editable text form of the Feature-Graph IR, for both agents and humans?

GO criteria, verbatim:
- Lossless on 50 models.
- UI edits keep comments and formatting.

## Setup
- **Packages:** `@aicad/cadscript` (compiler, canonical printer, edit splicing, typecheck, CLI) and `@aicad/ir-types` (generated from the forge-ir JSON Schemas).
- **Tests:** 8 corpus programs, 40 MakerBench references (44 CadScript files), and fast-check property tests. The property tests generate random multi-part IR v0 documents with frames, lines, arcs, circles, quoted and unicode curve ids, suppressed flags and explicit defaults. They run 300 cases per property in CI and passed once at 5,000.
- **Reproduce:**
  ```bash
  pnpm --filter @aicad/cadscript test
  ```

## Results
| Criterion | Target | Measured | Pass? |
|---|---|---|---|
| Lossless round-trip | 50 models | 8 corpus + 44 MakerBench files + thousands of random documents: `compile(print(ir), {base: ir}).ir` deep-equals `ir`; the printer is a fixed point | **Yes** |
| UI edits keep comments and formatting | preserved | `applyIrEdit` re-prints only changed statements; untouched statements keep their exact text and comments (property-tested under random edits) | **Yes**, with one caveat |

**Caveat.** When a statement *itself* changes, comments inside it are lost. Comments above and after it are kept. This is tracked in BACKLOG.

**Also delivered:**
- Diagnostics with stable codes, spans and hints, mirroring forge-ir validation 1:1.
- A tsc-level typecheck against `@aicad/std`, which runs in the browser.
- Id stability across edits, including rename detection.

## Verdict
**GO.** CadScript v0 is the agent's editing surface. Its syntax is still validated against build123d in spike 07's bake-off.

## Follow-ups
- Keep comments inside changed statements.
- IR v1 syntax: `param()`, expressions, booleans, holes, fillets and chamfers, semantic face/edge queries, constraints.
