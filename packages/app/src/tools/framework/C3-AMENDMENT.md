# C3 amendment: the tool framework as built (for the owner and INT to approve)

**Status:** proposed on 2026-09-25 by TOOL. It needs the owner's and INT's approval before FEAT and SKUI build on it (FULL-MODELING-PLAN §3.4: a frozen contract changes only through a short PR its consumers review).

**Why:** FULL-MODELING-PLAN §2.5 sketches C3 as a declarative `ToolSpec<I>` with `inputs` generated from zod, `init`, `toOps`, `handles` and `fromFeature`. `types.ts` next to this file implements an imperative shape instead: `activate` returns a described panel. This note maps one onto the other. It lists what already matches the plan, what differs and why, and what is still missing.

## What matches the plan

| Plan (§2.5, §3.4) | `types.ts` | Notes |
|---|---|---|
| `toOps(i, ctx): IrOp[]` is the only way a tool changes the document | `PanelSpec.toOps(values): ToolOp[]` | The session applies the ops as **one** transaction through `OpsPort`, against the document **as it is at OK time**. An edit the user, undo or the agent makes while the panel is open is kept. |
| `fromFeature?(feature): I` | `ToolDefinition.fromFeature(feature, ctx): PanelSpec`, plus `features: string[]` (the feature types it re-edits) | `feature.edit { feature }` opens it. |
| `tool.start {id,args}`, `tool.commit`, `tool.cancel`, `feature.edit` | Same ids (`tools/commands.ts`) | `args` prefill inputs by field key. Unknown keys and values a field can't take are refused. |
| Groups `sketch \| create \| modify \| construct \| pattern \| inspect \| print` | Same seven ids | The toolbar order is the builder's (Sketch, Create, Modify, Pattern, Inspect, Construct, Print). Empty groups are hidden. |
| `ToolState` `collecting \| previewing \| invalid \| committing` | The same, plus `ready` and `closed` | |
| A newer preview cancels older ones; stale results are dropped | The same. Stale results never reach the viewport either, bodies included | Preview bodies are part of `PreviewOutcome`. There is no free `showPreview`. |
| OK is one transaction; Cancel leaves nothing behind | The same | OK also waits for the running check and commits only if it passes at the current document revision. |
| `accepts` for selection-first | `ToolDefinition.accepts: SelectionKind[]` | The plan has `SelectionKind[][]` (alternatives). **Decision needed:** widen when SEL's contextual toolbar lands. |
| Panel registry `ui/shell/panels.ts` | Same file | |

## Where it differs, and why

1. **Panels are described by hand, not generated from the v1 zod schemas (`inputs: ToolInputs<I>`).**
   - A v1 feature schema describes IR JSON, not an input form. It lacks units and expression parsing, the selection-to-`Ref` conversion (C1 `refFor`), fields that depend on other fields (`visibleWhen`), and the feasible-range hints.
   - The field specs carry exactly those things.
   - **Proposal:** keep the field specs as the contract. Add a helper, `fieldsFromSchema(FilletFeatureSchema, overrides)`, when FEAT starts, so simple tools don't hand-write their fields.
   - **Decision needed.**
2. **`init(ctx, sel)` is `activate(ctx)`.** Selection fields prefill from `ctx.selection` by themselves, and `tool.start` args override. There is one entry point instead of two.
3. **`commit(values)` is kept as an escape hatch beside `toOps`.**
   - It is for changes the op catalogue can't express yet, and for non-document actions.
   - A panel has one or the other, never both, and the session refuses a spec that has both.
   - **Proposal:** drop `commit` for feature tools once C1's catalogue is complete. The same-command test (§5.3) should flag any feature tool that still uses it.
4. **`ToolOp` is a stand-in for C1's `IrOp`.**
   - Today it has `setField`, `setSuppressed` and `addFeature`, with C1's names and arguments.
   - The shell's default `OpsPort` (`v0-ops.ts`) applies them to today's IR v0 document. It checks the result against the IR schema, splices it into the CadScript source, and refuses with `COMMAND_STALE` if the document changed meanwhile.
   - **INT:** bind `Shell.bindPorts({ ops })` to the IR v1 store's `transaction`, and widen `ToolOp` to `IrOp`.
5. **`ToolSession<I>` is `PanelSession`.** It has the same members (`set`, `commit`, `apply`, `cancel`, state, errors, summary), and its values are keyed by field.

## Still missing (not in this build)

- **`handles?(i, view): HandleSpec[]` (manipulators).** The plan freezes these in FM-W2 ("Handles: FM-W2"). They are not part of the FM-W0 core.
- **Rollback when re-editing a feature.** Plan step 1 of Edit feature is "the view rolls back to just before the feature" (`evaluateThrough`, C1 part 1, and the C6 marker). `feature.edit` opens the panel without it. **INT/ENG** should wire it into `Shell.editFeature` when the query lands.
- **The timeline's double-click → `feature.edit`.** The timeline belongs to HIST. `feature.edit` is a shell command until `SHELL_COMMANDS` is merged into `COMMANDS` (integrator follow-up 1).
- **The failure rule (C1)** is the store's job. A panel's own check is its preview. On IR v0 there is no newly-failing acknowledgement.
