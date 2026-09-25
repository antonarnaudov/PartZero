# Timeline, Browser, Parameters, Undo and Problems: what is built

- **Status:** built on a stream branch off `fm-integration` (2026-09-25).
- **Plan:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md) T0 #13 (timeline), #14 (parameters), #19 (browser), #22 (undo/redo); §2.3 (undo, groups), §2.5 (layout).
- **Where:** `packages/app/src/ui/model/` (new), `packages/app/src/doc/v1/feature-order.ts`, `packages/app/src/doc/v1/model-values.ts`, `packages/app/src/doc/undo-scope.ts`, `packages/app/src/doc/problems.ts`, `packages/app/src/ui/ProblemsPanel.tsx`.

## Layout

The layout is Fusion's. The history is a strip under the viewport, and the left dock holds the Browser and Parameters:

```
┌ title bar: … Undo · Redo · History ▾ … ─────────────────────────────────────────────────┐
├ tool ribbon ──────────────────────────────────────────────────────────────────────────────┤
│ Browser | Parameters │ viewport                                          │ right dock      │
│                      ├───────────────────────────────────────────────────┤                 │
│                      │ ⏮ ◀ ▶ ⏭  ✎ ⬡ ⬒ ✎ ⬡ ▼ ⬡   [Rolled back] [1 by AI · Keep all]      │
├ Problems ──────────────────────────────────────────────────────────────────────────────────┤
```

- The left dock is `browser` (default) and `params` in the panel registry. The vertical timeline tab is gone.
- The strip is `ui/model/TimelineBar.tsx`, mounted by `AppShell` under the viewport in `.center-stage`.
- Two toggles: View ▸ Toggle Browser (⌘B, `view.toggleBrowser`) and View ▸ Toggle Timeline (`view.toggleTimeline`, new panel id `timeline`).

## What each surface does, and the command behind it

Every change below is a command of the one command layer: the same op the assistant and MCP call, with one undo step and the failure rule applied.

| Surface | Gesture | Command |
|---|---|---|
| Timeline | click, arrows | `selection.selectFeature` |
| | double-click, Enter | a sketch opens in sketch mode (`editSketchFeature`); other features use `feature.edit` |
| | drag a chip | `ir.moveFeature`. The drop line is green where the feature may go and red, with the reason, where it may not |
| | drag the marker, ⏮ ◀ ▶ ⏭ | `ir.setRollback` |
| | menu: Rename (F2) | `ir.renameFeature` |
| | menu: Suppress | `ir.setSuppressed` |
| | menu: Roll Back to Here / Roll to End | `ir.setRollback` |
| | menu: Move Earlier / Later | `ir.moveFeature`. Disabled with the reason where the move is illegal |
| | menu: Keep; the Keep all pill | `ir.setAuthor` (host-only) |
| | menu: Delete (⌫) | `ir.dependents`, then `ir.deleteFeature`. Nothing built on it: deleted at once, with an Undo toast. Otherwise a dialog lists the dependents, which go too (`dependents: cascade`) |
| Browser | eye on a body or the Bodies folder | `view.setBodyVisible` (view state, not undoable) |
| | eye on a sketch or the Sketches folder | `view.setSketchVisible` (new) / `view.setToggle sketches` |
| | eye on Origin | `view.setToggle origin` |
| | isolate | `view.isolate` / `view.showAll` |
| | colour swatch | `ir.setAppearance` on the body's origin feature: one undo step, saved in the `.partzero`. Swatches are Bambu Lab PLA Basic's 30 published colours (`ui/model/filaments.ts`); Custom… takes any colour. A CadScript v0 document falls back to `view.setBodyColor` |
| | click a row | `selection.set` for a body, sketch or origin item; `selection.selectFeature` for a datum |
| | double-click, menu | Edit, Rename, Suppress, Delete, as in the timeline |
| Parameters | edit a user parameter (Enter or blur) | `ir.setParam` (literal, `12 mm`, `1 in`, or an expression) |
| | + Parameter | `ir.addParam` (name, value or expression, unit) |
| | rename (double-click or menu) | `ir.renameParam` (every use is rewritten) |
| | Delete / Delete and keep its value | `ir.deleteParam` (`refuse` / `inline`) |
| | edit a model value | `ir.setField` (number, or `{ expr }`) |
| | Make parameter (↑) | `ir.apply [addParam, setField { expr }]`, one step. The rename editor opens on the new name |
| Problems | click | selects the feature (the timeline and browser follow); a parameter's problem opens Parameters |
| | Edit | the feature's panel or sketch |
| | filter chips | severity filter (view only) |
| Title bar | Undo, Redo, ⌘Z, ⇧⌘Z, Edit menu, palette | `edit.undo` / `edit.redo`. While sketch mode is open they step the sketch's own history (`doc/undo-scope.ts`) |
| | History ▾ | the list of steps (newest first, AI-marked); a click hops with `edit.undo` / `edit.redo` |

### Model values

`doc/v1/model-values.ts` lists each feature's dimensions. It follows the SPEC-v1 §6 field tables:

- the extrude distance;
- the revolve angle;
- fillet r, chamfer d/d2/angle, shell thickness, draft angle;
- a hole's d, blind depth, tip, and its grid and bolt-circle placements;
- a pattern's count, spacing and angle;
- a datum plane's distance and angle;
- a sketch's compound sizes (rect w/h/r, circle radius, slot w, polygon sizes) and its driving dimensions.

It leaves out coordinates and references. The engine evaluates each expression value exactly as the model does: the panel adds scratch parameters to the value's part and calls `engine.params`. A test proves that each listed pointer is a `setField` the engine accepts.

### Reorder validity

`doc/v1/feature-order.ts` reads a feature's references by id: `sketch`, `datum`, the query `feature` fields, and the pattern `features` seed (SPEC-v1 §5.3). A feature must stay after what it uses and before what uses it directly.

- This is only a preview. The engine's `moveFeature` decides on drop.
- A test drives every feature of the corpus plate to every position, 306 moves, and the preview agrees with the engine on each one.

### Problems

Problems now lists more than failed features:

- report warnings (§7.3) as warnings, except `SKETCH_UNDER_CONSTRAINED`;
- `info` items as notes, which never get the "engine-internal failure" hint and do not mark the timeline;
- parameters that do not evaluate.

### Live agent turns

- While an agent or MCP group is open, the strip shows **Assistant editing**, and its steps land at once with the AI tag.
- Your edits are refused until the turn ends (`IR_GROUP_OPEN`, backbone behaviour), with a toast that says so.
- The sealed turn is one step in the history list, marked AI.
- The unpackaged test hook `__aicad.ops` gained `execute(cmd)` with the agent's source, so e2e can drive a turn.

### Timeline during sketch mode

The strip is locked, dimmed and `aria-disabled`, until the sketch is finished or cancelled.

## Tests

| Suite | What it proves |
|---|---|
| `packages/app/test/feature-order.test.ts` | Reference scan; slots and reasons; agreement with the engine on all 306 moves of `corpus/v1/programs/plate_features.json` |
| `packages/app/test/model-values.test.ts` | Which fields are values, with units and labels; every listed pointer round-trips through `setField`; engine evaluation of expressions; promote names |
| `packages/app/test/model-panels.test.ts` | Browser tree and body-name parsing; warnings, notes and parameter failures in Problems; the filament palette; the undo scope; the history entries; readable labels |
| `packages/desktop/e2e/model-panels.e2e.ts` (9 tests, real mouse and keys) | See the list below |

The e2e tests cover:

- the strip under the viewport, and the hover card;
- drag-reorder, valid and refused with its reason;
- marker drag, step and jump;
- rename, suppress, and delete with dependents plus undo;
- the strip's keys;
- Browser eye, isolate, colour (undoable), sketch eye, origin, and selection;
- Parameters: add, use, edit, units, promote plus rename, delete refused, inline;
- Problems: failure, select, filter, undo;
- one Undo across the timeline, browser and parameters (⌘Z, ⇧⌘Z, the title bar, the history list) and inside sketch mode;
- a live agent turn as one AI-marked step.

The existing suites run unchanged: 110 passed, 1 skipped (the live agent), before the last three commits. After them, the model-panels, sketch-mode, v1-model and shell suites were re-run and pass.

## Deviations and gaps

- **The marker cannot go before the first feature.** `setRollback.after` is a feature id or null, so the leftmost position is "after the first feature". An `after: "^"` (or a `before`) needs a catalogue change (C1), so the agent tools and MCP would change too.
- **Colours stay in the document, not the print.** They are the document appearance (host state, FD4). They are not written to the 3MF, so Bambu Studio does not map them to AMS slots yet. That is the print handoff's work: `basematerials`/`displaycolor` per object, or Bambu's per-object extruder metadata, from `v1.host.appearance`.
- **Some body kinds are missing from the Browser.** There are no per-body rename, delete or "remove body" entries, because the IR has no body-level ops. Bodies are named after their origin feature (SPEC §5.2).
- **Sketch eyes do not draw every sketch.** They work for sketches that `viewport/sketches.ts` can draw: lines, arcs and circles on named or explicit planes. v1 compound curves (rect, slot, polygon) and face or datum planes are not drawn yet (viewport follow-up §5).
- **Model values are curated, not generated.** The table is hand-made from SPEC-v1 §6, not from the JSON Schema. A new feature type or field needs a row there, or it won't show in Parameters.
- **Your edits are refused during an agent turn** rather than queued (backbone rule, ADR 0015 §4 option). The pill says the turn is running.

## Integrator notes

1. **Hot files touched (small edits):**
   - `ui/shell/AppShell.tsx`: `.center-stage` wrapper, `TimelineBar`, `ModelDialogs`, `SketchUndoScope`.
   - `ui/shell/panel-catalog.tsx`: `browser` and `params` replace `timeline`.
   - `ui/shell/ShellToolbar.tsx`: undo scope and the History button.
   - `ui/shell/install.ts` and `shortcut-docs.ts`: the Timeline section.
   - `tools/shell.ts`: the default left tab is `browser`.
   - `commands/commands.ts`:
     - `edit.undo` / `edit.redo` go through the undo scope;
     - `view.toggleBrowser` is new; `view.toggleTimeline` now toggles the strip;
     - the `timeline` panel id.
   - `ui-store.ts`: panel id `timeline` and dialog id `model`.
   - `desktop/src/menu.ts`: Toggle Browser and Toggle Timeline.
   - `viewport/view-store.ts`, `viewport/commands.ts`, `ui/Viewport.tsx`: per-sketch visibility.
   - `bootstrap.ts`: `__aicad.ops.execute`.
   - `doc/history.ts`, `doc/doc-store.ts`, `doc/v1/ir-doc-store.ts`: `historyEntries()`.
2. **Test ids kept:** `timeline-feature` with `data-feature`, `data-type`, `data-status`, `data-author`, `data-draft`, `aria-selected`; `.tl-summary` (screen-reader only now); `timeline-agent-badge`; `timeline-keep-all`; `timeline-proposed`; `timeline-stale`; `problem`; `problems-count`; `params-panel`; `params-add`.
3. **Dead code:** `ui/App.tsx` (the pre-shell layout) and `ui/Timeline.tsx` are no longer mounted. Delete both at integration, together with their `.tl-*` / `.params-*` rules in `styles.css`.
4. **For the tool stream:** `feature.edit` failures, such as a type with no tool, show as a toast from the timeline and the browser. When a generic panel covers every type, nothing changes here.
5. **For the agent stream:** an agent can call every model change here as an op tool: `move_feature`, `set_rollback`, `rename_feature`, `set_suppressed`, `delete_feature`, `set_appearance`, `add_param`, `set_param`, `rename_param`, `delete_param`, `set_field`, and `apply_ops` for promote. Visibility and isolate stay app UI state (§2.1 rule 5).
