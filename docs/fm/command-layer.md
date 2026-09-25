# The one command layer (C1): what is built

- **Status:** built on branch `fm-integration` (2026-09-25).
- **Plan:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md) §2.1–§2.3, contract C1, §5.2–§5.3.
- **Where:** `packages/model-ops` (new), `packages/app/src/doc/v1/ir-doc-store.ts`, `packages/app/src/commands/ir-commands.ts`, `packages/agent-tools/src/ops.ts`, `packages/mcp-server/src/ops.ts`.

## One definition per op

`@aicad/model-ops` holds the op catalogue v2 (`OP_CATALOGUE`, `OP_SCHEMAS`): one zod schema, label, semantic inverse and tool metadata per op. Everything else is generated from it:

| Surface | Generated as | Where |
|---|---|---|
| App command registry (palette, menus, tools, timeline) | `ir.<op>` per op, typed per op, plus `ack` | `app/src/commands/ir-commands.ts` |
| Agent tools | one tool per op (JSON values as `*_json` text), plus `apply_ops` and four reading tools | `agent-tools/src/ops.ts` |
| MCP | scopes `ops` (the in-app agent), `ext-ops` (external clients), `ops-read` | `mcp-server/src/ops.ts`, `scopes.ts` |

## The ops

| Op | Command | Agent / MCP tool | Inverse |
|---|---|---|---|
| `addFeature` (any v1 type, sketches included) | `ir.addFeature` | `add_feature` | `deleteFeature` |
| `setField` (JSON pointer; `{ expr }`; `remove`) | `ir.setField` | `set_field` | `setField` back |
| `updateFeature` (merge patch) | `ir.updateFeature` | `update_feature` | `updateFeature` back |
| `deleteFeature` (`refuse` / `cascade` / `keep`) | `ir.deleteFeature` | `delete_feature` | `addFeature` per deleted feature |
| `moveFeature` | `ir.moveFeature` | `move_feature` | `moveFeature` back |
| `setSuppressed` | `ir.setSuppressed` | `set_suppressed` | the opposite |
| `renameFeature` | `ir.renameFeature` | `rename_feature` | `renameFeature` back |
| `addParam` | `ir.addParam` | `add_param` | `deleteParam` |
| `setParam` | `ir.setParam` | `set_param` | `setParam` back |
| `renameParam` (rewrites every use) | `ir.renameParam` | `rename_param` | `renameParam` back |
| `deleteParam` (`refuse` / `inline`) | `ir.deleteParam` | `delete_param` | `addParam` + the uses |
| `setRollback` (rollback marker) | `ir.setRollback` | `set_rollback` | `setRollback` back |
| `setAppearance` (body colour) | `ir.setAppearance` | `set_appearance` | `setAppearance` back |
| `setAuthor` ("Keep", ADR 0015) | `ir.setAuthor` (refuses agent and MCP callers) | none: host-only | `setField` of `/author` |
| `replaceDocument` (a code edit) | `ir.replaceDocument`; `doc.setSource` / `doc.applyIr` on a v1 model | none: host-only | `replaceDocument` back |
| `writeBackSolution`, `captureRef`, `acceptRefCandidate`, `acceptRefProposal`, `renameCurve`, `upgradeFeature` (Phase C) | `ir.<op>` | `write_back_solution`, `capture_ref`, `accept_ref_candidate`, `accept_ref_proposal`, `rename_curve`, `upgrade_feature` | as before |

Other commands: `ir.load`, `ir.state`, `ir.undo`, `ir.redo`, `ir.apply` (several ops, one transaction), `ir.listRefs`, `ir.dependents`, `ir.paramUses`, `ir.openGroup` / `ir.sealGroup` / `ir.abortGroup`. Reading tools: `get_model`, `get_feature`, `feature_dependents`, `param_uses`.

## Transactions

`OpTransaction` (model-ops) is the one transaction pipeline; the app's `IrDocStore` and model-ops' `MemoryOpsHost` both run it.

- **Verified by the engine.** Phase C's ops run in forge-wasm's command layer. The catalogue v2 ops edit the IR JSON, and the engine's full v1 rejection pipeline (`canonicalize`) decides: every problem comes back as the IR code at its path. Dependents, illegal orders and parameter uses are exactly the references the engine then refuses (`UNRESOLVED_*`, `EXPR_UNKNOWN_NAME`).
- **The failure rule.** A feature the transaction adds or edits must build (`COMMAND_FEATURE_FAILS`), a parameter it sets must evaluate (`COMMAND_PARAM_FAILS`). A feature that already failed may still fail. Newly failing features need `ack` listing exactly them (`COMMAND_NEW_FAILURES`); a user gesture asks "N features will newly fail… Apply anyway?".
- **Authorship (ADR 0015).** Agent and MCP origins mark their features `agent`; your features carry no mark (it reads as yours); your edit of an agent feature makes it yours; agents cannot write `author` (`COMMAND_AUTHOR_HOST_ONLY`). An agent, MCP or CLI transaction that changes your features or parameters without approval is refused (`unapproved_user_change`). Parameters a host session added itself are its own.
- **Undo.** Each transaction records the canonical document and the host state (rollback marker, appearance) before and after: undo is byte-exact. Groups (`openGroup` / `sealGroup` / `abortGroup`) make one undo step of an agent turn. `onDidChange` reports every commit, undo, redo, load and group step.

## The app on IR v1

- New documents are IR v1 models. `.partzero` and `.json` files of either IR version open as v1 (v0 is migrated); code-only documents compile as CadScript v0 (ids kept) or v1. A `.partzero` stores the canonical v1 document, `view.rollbackMarker` and `annotations/appearance.json`.
- `DocStore` mirrors `IrDocStore` (`format: "ir-v1"`): the timeline, viewport, files and export read it; undo/redo go to the store; the evaluation is cut at the rollback marker.
- Sketcher Finish commits `addParam` + `addFeature` (or `updateFeature`) through `ir.apply`; the timeline's double-click opens a sketch in sketch mode and any other feature in its property panel (Extrude has its own tool; other types a generic panel of name, numbers and choices).
- The code view is hidden by default (View ▸ Show Code, `view.toggleCode`); on a v1 model it shows the CadScript v1 print, read-only.
- Mesh exports (3MF, STL, OBJ) and the printer handoff tessellate at print quality: 0.01 mm chordal, at most 5°.

## Deviations and gaps

- **The structural ops are TypeScript, not Rust.** §2.1 rule 1 puts every op in `forge-commands` so the CLI shares it. Here they live in model-ops, verified by the same Rust engine, so the app, the agent's tools and MCP share one implementation without a WASM rebuild. `aicad op` (the CLI) is not built; moving the ops to Rust is the way to give it the same ops.
- **Appearance is host state, not IR.** FD4 wants a geometry-free IR field (SPEC set B). Until then the colours live beside the IR (undoable, saved in the `.partzero` annotations) and do not reach 3MF colours.
- **The in-app agent still writes CadScript.** Its proposal is applied as one `replaceDocument` code edit (a v0-expressible model is handed to it as its v0 CadScript). The live agent that operates the op tools on the document (`appOpsHost`, the `ops` MCP scope) is wired up to the host but not yet driven by the desktop runner.
- **Not in this build:** `sketchEdit`, `convertSketch`, `refFor`, `setRef` (C1 part 2), `feasibleRange`, preview through the store (`store.preview(ops)` exists for single ops only), external MCP clients on the app's live document (needs an IPC bridge to `appOpsHost`).
