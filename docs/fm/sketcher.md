# Sketcher (SKK + SKUI): what is built, and the integrator's wiring

- **Status:** built and tested on branch `worktree-wf_8ba17403-3c2-1` (2026-09-25), on top of `alpha0-preview`.
- **Plan:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md) §2.7 (sketch mode), §3.4 C5 (SketchSession), T0 rows 3–7.
- **Where a finished sketch goes today:** into the open **CadScript (IR v0) document**, through the command layer's `doc.applyIr` (the CadScript bridge, below). It shows in the timeline, extrudes, saves, undoes with ⌘Z, and reopens from the timeline. The IR v1 model cannot take it yet: that needs contract **C1 part 1** (`addParam`, `addFeature`, `setField`), which Phase C does not have and no stream builds tonight. **C1 is the critical path** for sketches in the v1 model.
- Nothing here edits Phase C's hot paths. The seams below are where the integrator connects it.
- **Integration status (branch `fm-integration`, 2026-09-25):** merged with Phase C and the other
  streams. In the PartZero shell (`ui/shell/AppShell.tsx`) `SketchModeHost` is mounted in the
  viewport column, the welcome makes way while sketch mode is open, and the old toolbar button is the
  ribbon's **Sketch** tool (`tools/builtin/sketch.ts`, id `sketch.new`, ⇧S; e2e clicks
  `tool-sketch.new`).
- **IR v1 wiring (C1, 2026-09-25):** done in `sketch/v1-app.ts` (see [command-layer.md](command-layer.md)).
  On an IR v1 model (the app's document model) Finish commits `addParam` + `addFeature` (new) or
  `updateFeature` of the curves and constraints (edit) as one `ir.apply` transaction, so the model
  keeps constraints, dimensions, construction geometry and parameters; new sketches see the model's
  parameters and rollback marker; the timeline's double-click reopens a sketch with its constraints;
  the Finish extrude offer is `ir.addFeature`. The CadScript bridge stays for IR v0 documents (hosts
  without the IR v1 engine). Not done: `commands/sketch.ts`, the convert renames of wiring 1, faces
  as planes (wiring 6), one wheel classifier (wiring 8).

## What works

| Area | Where | Tested by |
|---|---|---|
| Sketch session (C5): load (with the document's parameters), atomic edit batches in the `sketchEdit` vocabulary, conflict/redundancy policy, write-back to a fixed point, welded coincidents dropped, point/curve/rim drags, undo/redo, expressions and new parameters (a name already used by a parameter or a feature is refused), `finish` through `evaluate_sketch` + IR validation | `forge/crates/forge-sketch/src/session.rs`, `session_json.rs` | `forge-sketch/tests/session.rs` (18, incl. a fixed-point proptest), `session_json` unit test |
| `convertSketch`: an explicit sketch (compound curves, expressions) becomes a constrained sketch with the same geometry, 0 DOF, sizes as dimensions bound to the same parameters | `forge-sketch/src/convert.rs` | `forge-sketch/tests/convert.rs` (incl. a proptest over rect/slot/polygon sizes) |
| WASM bindings (UI thread, no wgpu, ~0.9 MB gzip) | `forge/crates/forge-sketch-wasm` → `packages/forge-web/pkg-sketch` (`scripts/build-sketch.mjs`) | `packages/forge-web/test/sketch.test.mjs` (drag p95 < 16 ms on 60 curves; measured ~0.3 ms/frame) |
| Typed JS API | `packages/forge-web/src/sketch.ts`, `src/types/sketch.ts` (`@aicad/forge-web/sketch`) | same |
| Sketch mode (framework-free): plane, tools, snapping/inference with auto-constraints, palette constraints, dimensions (number, expression, `name = value`, driven), typed values, drags, box select, trim/extend/offset/mirror/fillet/chamfer, finish into a sink | `packages/app/src/sketch/**`, `packages/app/src/tools/sketch/**` | `packages/app/test/sketch/controller.test.ts` (the controller on the real WASM session) |
| Modify ops with geometric checks: fillet tangency and radius, chamfer legs, offset distance and corner joins, mirrored coordinates, which constraints each op keeps, moves or drops. **Fillet and chamfer keep the design intent**: the corner's constraints and dimensions (with their ids and parameter bindings) move to a construction point at the virtual sharp, held on both lines, so a fully constrained sketch stays fully constrained | `packages/app/src/sketch/ops.ts` | `packages/app/test/sketch/ops.test.ts` (11) |
| New sketches see the document: its parameters in dimensions, and a free id and name (`sketch<n>` against every feature, part and parameter name) | `sketch/names.ts`, `documentSource` in `sketch/integration.ts` | `packages/app/test/sketch/document.test.ts` |
| FD3 navigation: mouse wheel and pinch zoom, trackpad two-finger (with or without Shift) pans. The wheel device is told apart by Chromium's wheel grid (a macOS notched wheel steps in 4.000244140625 px), not by integer-ness | `sketch/wheel.ts` | `packages/app/test/sketch/wheel.test.ts` (traces in the shape Chromium produces on macOS, Windows and Firefox) |
| **The CadScript bridge**: Finish → the sketch's solved profile curves as a `sketch(…)` statement (one undoable `doc.applyIr` transaction), the document's own evaluation compared with the sketcher's regions, timeline double-click reopens it (with its constraints while the window is open), and the Finish offer extrudes it | `sketch/v0-bridge.ts`, `sketch/v0-app.ts` | `packages/app/test/sketch/v0-bridge.test.ts` (real session + CadScript splicer + Forge `evaluate`: volumes checked) |
| UI: plane picker, SVG overlay (grid, axes, projected model edges, regions, DOF colours, glyphs, dimensions, rubber bands, snap markers), palette, constraint bar, inspector (status, conflicts with one-click repair, constraint list, driving/driven), inline dimension editor, typed-value box, the extrude offer | `packages/app/src/ui/sketch/**` | `packages/desktop/e2e/sketch-mode.e2e.ts` (10, Playwright-Electron, real mouse and keys): XY rectangle to fully constrained, circle drag, conflict made driven, wheel/trackpad/pinch, **Finish → timeline row → extrude → body (model box) → app undo/redo**, reopen from the timeline with its parameter-bound dimension, Cancel, XZ with undo/redo, trim, Esc unwinding, the conflict panel's one-click repair |

Tools: line (chained, typed length), 2-point and centre rectangle, centre/2-point/3-point circle (typed diameter), 3-point/tangent/centre arc, slot, polygon (typed sides), point, construction toggle (X), dimension (D), trim (T), extend (E), offset (O), mirror (M), sketch fillet and chamfer. Constraints: coincident, horizontal (H), vertical (V), parallel, perpendicular, tangent, equal, concentric, midpoint, symmetric, fix, on-curve. Dimensions: aligned/linear (point–point, point–line, parallel lines), radius, diameter (Shift toggles), angle; driving or driven. Navigation (FD3): mouse wheel zooms (15 % per notch), trackpad pinch zooms, two-finger scroll (with or without Shift) pans, middle/right/Space-drag pans; the flat sketch view has no orbit.

## The CadScript bridge (what works tonight)

`sketch/v0-bridge.ts`, installed by `SketchModeHost` through `installCadScriptBridge` (`sketch/v0-app.ts`):

- **Finish** lowers the IR v1 sketch to IR v0: the profile curves (lines, arcs, circles) with their solved geometry written to the nanometre (1e-9 mm, a thousandth of the kernel's tolerance, so the file reads `radius: 8`), on XY/XZ/YZ or an explicit frame. It places the feature at the end of the part (or replaces the edited one) and runs `doc.applyIr`: the CadScript splice, one transaction in the document history. After the edit it compares the document's own evaluation of the sketch (region count and areas) with the sketcher's; a difference, or a sketch the document fails, is a warning toast.
- **What a v0 file cannot hold** is said in the Finish toast: constraints, dimensions, parameters, construction curves and points. `SketchIntentMemory` keeps them for the window's lifetime: reopening a sketch whose geometry in the document is unchanged restores them. A sketch written elsewhere (code, the agent) or reopened after a restart opens as its plain geometry, with a notice.
- **Refusals** (never a wrong write): code that does not compile, a face or datum plane, expression coordinates, compound curves. The sketch stays open with the reason.
- **Timeline double-click** on a sketch row opens it in sketch mode (`editSketchFeature`, one line in `Timeline.tsx`).
- **The extrude offer** after Finish (distance, direction) adds `extrude(<sketch>, { distance })` the same way. It stands in for the feature tools' extrude (FEAT) until that exists.

When the IR v1 command layer lands, the integrator replaces `installCadScriptBridge` with the v1 wiring below and deletes `v0-bridge.ts`, `v0-app.ts` and the offer.

## Contract C5 as implemented

`SketchSession.load({ sketch, document?, part?, convert? })` rather than `load(doc, sketchId)`: a new sketch is not in the document yet, and an edited one may be the command layer's candidate. The rest follows C5:

| C5 | Implemented as |
|---|---|
| `solve()` | `snapshot()` (every commit solves) |
| `dragBegin/dragTo/dragEnd` | same; `dragBegin({ target, grab, mode? })`, target = point ref or curve id, `mode: "rim"` for a circle's radius |
| `apply(edits)` (tentative), `toEdits()` | `preview(edits)` (tentative), `apply(edits, options)` (commits to the session), `edits()` |
| `frame()` | the app computes frames (`sketch/frames.ts`, SPEC §3.1 face rule, tested against the SPEC table) |
| per-entity DOF, free directions, constraint states, conflicts with suggested removals | `snapshot().entities / constraints / conflicts / redundant` |
| set A's implicit origin and axes | not in the IR yet: an origin snap writes `fix(p, x: 0, y: 0)`; axis snaps are position-only |

`forge_sketch::session` is host-free, so **forge-commands' `sketchEdit` can be this code**: `SketchSession::load(sketch).apply(edits)` then `sketch()`. Its edit vocabulary has `replaceCurve` (trim, extend, fillet and chamfer use it), which the plan's `sketchEdit` list (§2.2) does not: add it to C1 part 2, or the sink uses `setField` (below).

## Integrator wiring for the IR v1 model (needs C1 part 1)

**Dependency.** Phase C's `IrDocStore` (`packages/app/src/doc/v1/ir-doc-store.ts`) takes ops through `apply(op, options)` and `transaction(label, fn, options)`; its `IrOpSchema` has only `setParam`, `writeBackSolution`, `captureRef`, `acceptRefCandidate`, `acceptRefProposal`, `renameCurve`, `renameFeature` and `upgradeFeature`. A finished sketch needs **`addParam` and `addFeature` (new) or `setField` (edit)**: C1 part 1 (plan §2.2, OPS-2), in `@aicad/model-ops` and `forge-commands`. `sketchEdit` / `convertSketch` (C1 part 2) are only needed to record edits semantically instead of replacing the curves and constraints.

1. **Route Finish into the v1 store** (bootstrap or `commands/sketch.ts`), replacing the `installCadScriptBridge` effect in `SketchModeHost`:
   ```ts
   import { sketchMode } from "./sketch/instance";
   import { sketchFinishToOps } from "./sketch/commit";
   sketchMode.setSink({
     async commit(f) {
       try {
         const out = await services.ir.transaction(
           `${f.mode === "new" ? "Add" : "Edit"} sketch ${f.feature.name}`,
           async (tx) => {
             for (const op of sketchFinishToOps(f)) await tx.apply(op as IrOp); // IrOp once C1 part 1 is in IrOpSchema
           },
           { origin: "user" },
         );
         return { ok: true, ...(out.writeBackWithheld?.length ? { warning: `Write-back withheld for ${out.writeBackWithheld.map((w) => w.sketch).join(", ")}` } : {}) };
       } catch (e) {
         // A refused op rejects the whole transaction (CommandEngineError: code, message, details); nothing is recorded.
         return { ok: false, message: e instanceof Error ? e.message : String(e) };
       }
     },
   });
   ```
   `sketchFinishToOps` (`packages/app/src/sketch/commit.ts`) emits the plan's §2.2 shapes: `addParam { name, unit, value }` for each parameter defined in the session, then `addFeature { part, after, feature }` (new) or `setField { feature, path: "/curves" | "/constraints", value }` (edit). Check them against C1's final zod schemas. For an edited sketch that was converted (`f.conversion`), later references to the compound members (`regions`, `side:<member>` queries) must be rewritten in the same transaction using `f.conversion.renames`.
2. **Document context:** set `documentSource.current = () => ({ document: parsed services.ir.document, part: <selected part>, after: <rollback marker>, taken: [] })` so new sketches see the v1 parameters and get free names.
3. **Commands:** create `commands/sketch.ts` from `SKETCH_COMMANDS` (`sketch/integration.ts`: `sketch.new`, `sketch.finish`, `sketch.cancel`) and add its import line to the command index.
4. **Edit from the timeline:** set `editSketchSource.current = (id) => { … sketchMode.begin({ plane, sketch: feature, document, part, after: previousFeatureId, context: contextFromBodies(bodiesThroughPrevious, plane.frame) }); return true; }`. Agent-made explicit sketches convert on load (`f.conversion` on Finish).
5. **Extrude:** point `quickExtrudeSource.current` at FEAT's extrude (or set it to null to drop the offer).
6. **Faces:** the viewport/selection stream sets `faceSource.current = async () => ({ ref: { face: refFor(...) }, normal, point, label })`; the plane picker then offers "Selected face".
7. **Keys:** sketch mode captures keys on `window` (capture phase, installed on import, before `ui/keyboard.ts`) while active. With C10's input router, make it the router's sketch entry and delete `installSketchKeys`.
8. **One wheel classifier (C10):** `sketch/wheel.ts` and the viewport stream's `viewport/navigation.ts` `wheelSignal` have the same shape but different rules. The viewport's treats `|wheelDelta| = 3|delta|` and fractional deltas as a trackpad, but on macOS Chromium a notched mouse wheel has both (`deltaY` = lines × 40, `wheelDeltaY` = lines × 120, accelerated ticks 4.000244140625 px), so the owner's mouse wheel would orbit instead of zoom in the 3D view. Keep one classifier with `wheel.ts`'s rules (and its per-notch zoom step) for both views.
9. **3D context (optional, after C4):** implement `SketchView` (`sketch/view.ts`) over `camera().project/ray` to draw the overlay in 3D instead of the look-at view.
10. **Fold the WASM (optional):** add `forge-sketch` to forge-wasm's dependencies, move `forge-sketch-wasm/src/lib.rs`'s `web` module to `forge-wasm/src/sketch_session.rs` with `#[cfg(target_arch = "wasm32")] mod sketch_session;` in `lib.rs`, point `forge-web/src/sketch.ts` at `../pkg/forge_wasm.js`, then delete the crate, `build-sketch.mjs` and `vite-plugin-forge-web-sketch.ts`. The sketch crates are already a subset of forge-wasm's (tested), so the shipped notices are unchanged.

**Acceptance after the merge:** `packages/desktop/e2e/sketch-mode.e2e.ts` must still pass: Sketch → Finish → timeline row → extrude → body → reopen. With the v1 sink, adapt its document checks (the timeline and `window.__aicad` summary) to the v1 store.

## Hot-file and shared-file edits

| File | Edit |
|---|---|
| `packages/app/src/ui/App.tsx` | import + `<SketchModeHost />` inside the viewport column |
| `packages/app/src/ui/Toolbar.tsx` | import + `<SketchButton />` |
| `packages/app/src/ui/Timeline.tsx` | import `editSketchFeature` + `onDoubleClick` on sketch rows |
| `packages/app/vite.config.ts` | import + `forgeWebSketchPlugin()` in `plugins` |
| `packages/forge-web/package.json` | `exports["./sketch"]`, `./forge_sketch_wasm_bg.wasm`, `files`, `build`/`build:sketch`/`dev` scripts |
| `packages/forge-web/.gitignore` | `pkg-sketch/` |
| `forge/crates/forge-sketch/Cargo.toml` | dependencies `forge-params`, `serde` (INT: lock) |
| `forge/Cargo.lock` | the new crate and those dependencies |
| `forge/crates/forge-sketch/src/lib.rs` | `evaluate_constrained_sketch` split into `solve_constrained` + regions (same checks, same order; every existing test passes); `mod session, session_json, convert` |

## Gaps and follow-ups

- **Sketches in the v1 model** need C1 part 1 (above). Until then the CadScript file stores a sketch's geometry only; its constraints survive while the window is open.
- **Horizontal/vertical point-to-point dimensions** need SPEC set C; until then a point–line or line-length dimension does it.
- **Dimension label positions** are UI state (set A adds the geometry-free field); they reset when the sketch is reopened.
- **Projected model edges** are drawn and snapped to (position only); binding a curve to them is set C.
- **Sketch view** is the 2D look-at view: no orbit inside sketch mode (see wiring 9).
- **Region picking** for extrude belongs to FEAT; the snapshot's `profile.regions` (loops of curve ids) is ready for it. The extrude offer extrudes all regions (v0 `regions: "all"`).
- **Wheel:** the first event of a fast trackpad flick with a round, large delta can read as one wheel notch (a small zoom) before the gesture's next events prove it a trackpad.
- **Convert renames:** a converted compound's members get new curve ids (`outline_bottom`); SPEC may prefer to allow member ids in constrained sketches so references need no rewrite.
- **Arc fix during conversion** pins the end by its chord (two mirror solutions; the solver keeps the stored one).
