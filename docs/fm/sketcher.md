# Sketcher (SKK + SKUI): what is built, and the integrator's wiring

- **Status:** built and tested on branch `worktree-wf_8ba17403-3c2-1` (2026-09-25), on top of `alpha0-preview`.
- **Plan:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md) §2.7 (sketch mode), §3.4 C5 (SketchSession), T0 rows 3–7.
- **Not merged yet with Phase C.** Nothing here edits Phase C's hot paths. The seams below are where the integrator connects it.

## What works

| Area | Where | Tested by |
|---|---|---|
| Sketch session (C5): load (with the document's parameters), atomic edit batches in the `sketchEdit` vocabulary, conflict/redundancy policy, write-back to a fixed point, welded coincidents dropped, point/curve/rim drags, undo/redo, expressions and new parameters, `finish` through `evaluate_sketch` + IR validation | `forge/crates/forge-sketch/src/session.rs`, `session_json.rs` | `forge-sketch/tests/session.rs` (17, incl. a fixed-point proptest), `session_json` unit test |
| `convertSketch`: an explicit sketch (compound curves, expressions) becomes a constrained sketch with the same geometry, 0 DOF, sizes as dimensions bound to the same parameters | `forge-sketch/src/convert.rs` | `forge-sketch/tests/convert.rs` (incl. a proptest over rect/slot/polygon sizes) |
| WASM bindings (UI thread, no wgpu, ~0.9 MB gzip) | `forge/crates/forge-sketch-wasm` → `packages/forge-web/pkg-sketch` (`scripts/build-sketch.mjs`) | `packages/forge-web/test/sketch.test.mjs` (drag p95 < 16 ms on 60 curves; measured ~0.3 ms/frame) |
| Typed JS API | `packages/forge-web/src/sketch.ts`, `src/types/sketch.ts` (`@aicad/forge-web/sketch`) | same |
| Sketch mode (framework-free): plane, tools, snapping/inference with auto-constraints, palette constraints, dimensions (number, expression, `name = value`, driven), typed values, drags, box select, trim/extend/offset/mirror/fillet/chamfer, finish into a sink | `packages/app/src/sketch/**`, `packages/app/src/tools/sketch/**` | `packages/app/test/sketch/*.test.ts` (24 cases; the controller tests run on the real WASM session) |
| UI: plane picker, SVG overlay (grid, axes, projected model edges, regions, DOF colours, glyphs, dimensions, rubber bands, snap markers), palette, constraint bar, inspector (status, conflicts with one-click repair, constraint list, driving/driven), inline dimension editor, typed-value box | `packages/app/src/ui/sketch/**` | `packages/desktop/e2e/sketch-mode.e2e.ts` (Playwright-Electron, real mouse and keys) |

Tools: line (chained, typed length), 2-point and centre rectangle, centre/2-point/3-point circle (typed diameter), 3-point/tangent/centre arc, slot, polygon (typed sides), point, construction toggle (X), dimension (D), trim (T), extend (E), offset (O), mirror (M), sketch fillet and chamfer. Constraints: coincident, horizontal (H), vertical (V), parallel, perpendicular, tangent, equal, concentric, midpoint, symmetric, fix, on-curve. Dimensions: aligned/linear (point–point, point–line, parallel lines), radius, diameter (Shift toggles), angle; driving or driven. Navigation (FD3): mouse wheel zooms, trackpad pinch zooms, two-finger scroll or Shift+scroll pans, middle/right/Space-drag pans.

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

`forge_sketch::session` is host-free, so **forge-commands' `sketchEdit` can be this code**: `SketchSession::load(sketch).apply(edits)` then `sketch()`.

## Integrator wiring (after Phase C is merged)

1. **Route Finish into the command layer** (bootstrap or `commands/sketch.ts`):
   ```ts
   import { sketchMode } from "./sketch/instance";
   import { sketchFinishToOps } from "./sketch/commit";
   sketchMode.setSink({
     async commit(f) {
       // f.mode "new": addParam…, addFeature(after f.after). "edit": addParam…, setField(/curves, /constraints).
       // f.conversion?.renames: rewrite later references to compound members (regions, side:<member> queries).
       const r = await services.ir.transact(sketchFinishToOps(f), { origin: "user", label: `Sketch ${f.feature.name}` });
       return r.ok ? { ok: true } : { ok: false, message: r.error.message };
     },
   });
   ```
   Adjust `sketchFinishToOps` (`packages/app/src/sketch/commit.ts`) to C1's final op shapes. Until then Finish keeps the result in memory and says so in a toast.
2. **Commands:** create `commands/sketch.ts` from `SKETCH_COMMANDS` (`sketch/integration.ts`: `sketch.new`, `sketch.finish`, `sketch.cancel`) and add its import line to the command index.
3. **Edit a sketch from the timeline** (double-click): `sketchMode.begin({ plane, sketch: feature, document: services.ir.document, part, after: previousFeatureId, context: contextFromBodies(bodiesThroughPrevious, plane.frame) })`. Agent-made explicit sketches convert on load (`f.conversion` on Finish).
4. **Faces:** the viewport/selection stream sets `faceSource.current = async () => ({ ref: { face: refFor(...) }, normal, point, label })` (`sketch/integration.ts`); the plane picker then offers "Selected face".
5. **Keys:** sketch mode captures keys on `window` (capture phase, installed on import, before `ui/keyboard.ts`) while active. With C10's input router, make it the router's sketch entry and delete `installSketchKeys`.
6. **3D context (optional, after C4):** implement `SketchView` (`sketch/view.ts`) over `camera().project/ray` to draw the overlay in 3D instead of the look-at view.
7. **Fold the WASM (optional):** add `forge-sketch` to forge-wasm's dependencies, move `forge-sketch-wasm/src/lib.rs`'s `web` module to `forge-wasm/src/sketch_session.rs` with `#[cfg(target_arch = "wasm32")] mod sketch_session;` in `lib.rs`, point `forge-web/src/sketch.ts` at `../pkg/forge_wasm.js`, then delete the crate, `build-sketch.mjs` and `vite-plugin-forge-web-sketch.ts`. The sketch crates are already a subset of forge-wasm's (tested), so the shipped notices are unchanged.

## Hot-file and shared-file edits

| File | Edit |
|---|---|
| `packages/app/src/ui/App.tsx` | import + `<SketchModeHost />` inside the viewport column |
| `packages/app/src/ui/Toolbar.tsx` | import + `<SketchButton />` |
| `packages/app/vite.config.ts` | import + `forgeWebSketchPlugin()` in `plugins` |
| `packages/forge-web/package.json` | `exports["./sketch"]`, `./forge_sketch_wasm_bg.wasm`, `files`, `build`/`build:sketch`/`dev` scripts |
| `packages/forge-web/.gitignore` | `pkg-sketch/` |
| `forge/crates/forge-sketch/Cargo.toml` | dependencies `forge-params`, `serde` (INT: lock) |
| `forge/Cargo.lock` | the new crate and those dependencies |
| `forge/crates/forge-sketch/src/lib.rs` | `evaluate_constrained_sketch` split into `solve_constrained` + regions (same checks, same order; every existing test passes); `mod session, session_json, convert` |

## Gaps and follow-ups

- **Horizontal/vertical point-to-point dimensions** need SPEC set C; until then a point–line or line-length dimension does it.
- **Dimension label positions** are UI state (set A adds the geometry-free field); they reset when the sketch is reopened.
- **Projected model edges** are drawn and snapped to (position only); binding a curve to them is set C.
- **Sketch view** is the 2D look-at view: no orbit inside sketch mode (see wiring 6).
- **Region picking** for extrude belongs to FEAT; the snapshot's `profile.regions` (loops of curve ids) is ready for it.
- **Convert renames:** a converted compound's members get new curve ids (`outline_bottom`); SPEC may prefer to allow member ids in constrained sketches so references need no rewrite.
- **Arc fix during conversion** pins the end by its chord (two mirror solutions; the solver keeps the stored one).
