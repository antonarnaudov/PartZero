# Viewport, selection and view tools: integrator follow-ups

Branch: the VIEW/SEL overnight stream (FULL-MODELING-PLAN §2.4, §2.6, T0 items 15–19, 24).
Everything below works on the branch as it is; these steps finish the wiring into files this
stream was not allowed to edit (Phase C's hot paths). Each step is small and independent.

**Do steps 1 and 2 in the same merge as this branch** — until then Hidden Line and X-ray are
shown as unavailable on WebGPU, and the native menu, `window.__aicad` and anything else on the
app registry cannot reach `view.*` / `selection.*` / `measure.*`. Both are in
[`view-sel-wiring.patch`](view-sel-wiring.patch) (`git apply -3 docs/fm/view-sel-wiring.patch`,
made against this branch): `mod view_ext;` in `web.rs`, and in `commands/commands.ts` the
`...VIEWPORT_COMMANDS` spread, the removal of the three superseded view commands and their
schemas, and `chipsFromSelection` delegating to `selectionChips` (step 3's second bullet).
Verified on this branch with the patch applied, then reverted: app typecheck and 172 unit tests;
`cargo clippy -p forge-wasm` (native and `--target wasm32-unknown-unknown`, `-D warnings`) and
`cargo fmt --check`; forge-web rebuilt (it then exports `setDisplayMode` / `displayModes` /
`setXrayOpacity`); the 24 viewport e2e specs and the smoke spec pass, with forge-render drawing
all five display modes natively; `window.__aicad.execute` runs `view.setDisplayMode` (hiddenLine)
and `measure.selection`. After Phase C's split, re-apply by hand where the patch does not apply
and re-run the same checks.

## 1. Display modes in forge-wasm (one line) — do this first

`forge/crates/forge-wasm/src/web/view_ext.rs` adds `setDisplayMode`, `displayMode`,
`displayModes` and `setXrayOpacity` to `RawViewport`. It is a child module of `web.rs`, so it is
compiled only when `web.rs` declares it. Add, right after `use crate::scopes::Scopes;`:

```rust
mod view_ext;
```

(After the planned split into `web/mod.rs`, the same line goes into `web/mod.rs`; the file is
already at `src/web/view_ext.rs`. It needs only `RawViewport` and its private
`inner: Rc<RefCell<Host>>` field with the `viewport: forge_render::Viewport` in it — keep those
in the parent module of `view_ext`, or give `RawViewport` a `pub(super)` accessor for the
viewport and use it there.) Checked on this branch: `cargo clippy -p forge-wasm --target
wasm32-unknown-unknown -- -D warnings` is clean with the line, and the viewport e2e specs pass
with it (hidden line and X-ray drawn by forge-render) and without it (those two modes are then
shown as unavailable and `view.setDisplayMode` refuses them). Rebuild `packages/forge-web`
(`pnpm --filter @aicad/forge-web build`) afterwards.

## 2. Merge the viewport commands into the app registry

`view.*`, `selection.*` and `measure.*` are ordinary `CommandSpec<…, AppServices>`s in
`packages/app/src/{viewport,selection,measure}/commands.ts`, collected as `VIEWPORT_COMMANDS` in
`packages/app/src/viewport/registry.ts`. Until they merge, a second `CommandRegistry` runs them
and `routedExecute` / `routedPaletteItems` route by id.

In `packages/app/src/commands/commands.ts` (or `commands/index.ts` after the split):

```ts
import { VIEWPORT_COMMANDS } from "../viewport/registry";
// …
export const COMMANDS = {
  // … the app's commands …
  ...VIEWPORT_COMMANDS, // last: its view.setView (7 views, animated), view.fit and view.setProjection replace the app's
};
```

then delete the app's own `view.fit`, `view.setView` and `view.setProjection` (superseded; TS
rejects the duplicate keys otherwise). The viewport's `view.setView` keeps the old contract of
working before the viewport is mounted (it applies the view when the renderer attaches), so
`test/commands.test.ts` passes unchanged. Optional clean-up afterwards (the routing works either
way, and the viewport keyboard already skips keys the app registry binds):
- `ui/keyboard.ts` now binds the viewport keys; drop `installViewportKeyboard` from
  `ui/Viewport.tsx` **but keep its canvas-only table** (`⌘A` = select all must not fire inside
  the code editor: register it only when the event target is not editable);
- `ui/CommandPalette.tsx`: back to `commands.paletteItems()` / `commands.executeUnknown`;
- `viewport/test-hook.ts` and `ui/Viewport.tsx`: `routedExecute` → `commands.executeUnknown`;
- `window.__aicad.execute` then reaches the viewport commands as well.

## 3. Agent and MCP

- Generate agent/MCP tools for the read-only commands `selection.get`, `measure.selection`,
  `measure.items`, `view.snapshot` (the agent never moves the camera, §2.1 rule 5), with an
  agent-tools test that the four are exposed and that no camera or display command is.
- `chipsFromSelection` in `commands/commands.ts` (used by `chat.send` / `agent.run` without
  explicit chips): return
  `selectionChips(viewportRuntime(ctx).selection.items, ctx.doc.getState().selection, ctx.doc.getState().model?.ir)`
  from `packages/app/src/selection/chips.ts` (the chat panel already does).
- `SelectionChip.kind` (`ui-store.ts`, agent protocol) has no `vertex`; add it so selected
  vertices can travel to the agent (today they are left out, never mislabelled).

## 4. Contracts to update (owners: ENG / VIEW)

- `packages/app/src/engine/forge-web-contract.ts`: `ForgeWebViewport` names only the first
  shell's subset. The adapter uses forge-web's public `Viewport` API beyond it
  (`cameraState`, `setCameraState`, `orbit`, `pan`, `zoomAt`, `setDisplayOptions`,
  `setSectionPlane`, `on`, `pick` with `kind`/`point`, and the feature-detected
  `displayModes` / `setDisplayMode`). `viewport/forge-web-adapter.ts` declares that shape as
  `ForgeWebViewportV2`; move it into the contract and `isForgeWebModule`.
- `ViewName` there has 4 views; the viewport uses all 7 (`viewport/view-camera.ts`
  `StandardView`), as forge-render does.
- C2 (selection) as built, `packages/app/src/selection/types.ts`: model entities are
  `{ kind: "face" | "edge" | "vertex", body, key, point? }` — `body` is the render body name
  (the plan's `part` + body origin once ENG-0 lands), `key` the provenance name, `point` the probe.
  When `packages/model-ops/src/selection.ts` is created (FM-W0), move these types there and keep
  `selection/types.ts` as a re-export.

## 5a. Native menu (desktop `menu.ts`, a shared hot file)

The View menu still lists the first shell's four views. Add entries for the new commands when
the menu is next touched: Display ▸ (the five `view.setDisplayMode` modes), Section ▸ (XY, XZ,
YZ, From Face, Remove), Show ▸ (`view.setToggle`: grid, origin, sketches, view cube, axes),
Measure (`measure.toggle`, I), Zoom to Selection (⇧Z), Look At (N). They run through the same
registry once step 2 is done.

## 5. Phase C (IR v1) notes

- The viewport takes `RenderBody[]` from the document store (or the proposal preview) through
  `viewportRuntime(services).setSceneBodies(...)`, called by `ui/Viewport.tsx`. When the v1
  store (`services.ir`) produces the bodies, keep passing them the same way; selection items are
  re-resolved by provenance name after every evaluation.
- Body names are `part/feature[#n]` today; when ENG-0 moves bodies to origin keys (`F/body:m`),
  selection, colours and visibility follow the new names with no code change (they key on
  `RenderBody.name`).
- Vertex keys are derived (`vertex:{edge|edge|…}` from incident edges) and always carry the exact
  point; a v1 query can resolve them by point (`V` members, SPEC §5.3) until the render mesh
  carries vertex provenance.
- Sketch display (`viewport/sketches.ts`) reads v0 sketches (named planes and explicit frames).
  A v1 sketch on a face or a datum is skipped (not drawn in the wrong place) until its frame is
  exposed; datum planes/axes are not drawn yet (origin planes, axes and point are).

## 6. Smaller follow-ups

- Esc layering (C10): during a handle drag, the app's `selection.clear` (Escape) still runs
  before the handle's cancel; the selection model ignores that clear while a drag is active,
  but the document selection is cleared. The C10 router should own Escape.
- Theme colours: forge-render draws a light background in both themes (`setColors` is a no-op);
  the overlay and the view cube switch to dark ink on forge-render for contrast
  (`data-renderer="forge-web"`). Wire theme colours into the Frame uniform when VIEW-2 does.
- `window.__pzView` is this stream's slice of C7's `__pzTest`; QA can fold it in.

## 7. Measure: curve and surface types from the kernel (ENG, forge-mesh / forge-wasm)

The Measure panel recovers geometry from the render mesh (`packages/app/src/measure/geometry.ts`)
and claims "exact" only where the mesh proves it: forge-web's per-face exact normals certify
planes, cylinders and two-point straight edges; circles need ≥ 5 points. Everything else is shown
with "≈" — including every low-sweep arc the tessellator draws as one chord (a 15° arc at r 3 is
one segment; its wall one flat quad), 3–4-point arcs, and **every** planar area, straight edge and
hole radius from the CLI engine's OBJ (vertices shared between faces, normals averaged).
`packages/app/test/fixtures/gen-forge-web-meshes.mjs` regenerates the real-kernel fixtures the
tests use (NEMA 17 plate, 15° and 45° wedges).

The complete fix is the plan's `measure(entities)` query in the kernel (forge-check, "with the
formula used"). A cheaper intermediate step:
- `forge_mesh::RenderMesh`: add the curve kind (+ parameters: line; circle centre/axis/radius) to
  each `EdgePolyline` and the surface kind (+ parameters: plane normal/offset; cylinder
  axis/radius) to each `FaceRange`;
- pass them through `forge-wasm` (`engine.rs`) and `@aicad/forge-web` (`types.ts`: optional
  `curve` / `surface` fields on the polyline and the face range), and write them into forge-io's
  OBJ as comments for the CLI engine;
- in `geometry.ts`, prefer the kernel's type and parameters when present (exact, any sampling),
  and keep today's mesh evidence as the fallback.

## 8. Navigation: check Auto on real hardware (owner / QA, 5 minutes)

FD3 needs a mouse wheel and a Mac trackpad to work at the same time, and a wheel event does not
say which device sent it. `viewport/navigation.ts` reads Chromium's legacy `wheelDelta` the way
Chromium builds Mac wheel events (a trackpad: whole pixels, `wheelDelta = −3 × delta`; a notched
wheel: `delta = lines × 40`, `wheelDelta = −120 × notches`, so a one-line notch has the −3× ratio
too and is treated as ambiguous). The unit fixtures (`test/fixtures/wheel-sequences.ts`) and the
e2e events are **modelled on Chromium's source, not recorded**. To check on real devices: open
Settings ▸ Navigation, scroll over the test pad with the mouse, then with the trackpad (and a
pinch); each event shows what it was read as and why. If Auto misreads a device, pick Mouse or
Trackpad there (persisted), and press "Copy events" to paste the recording into
`wheel-sequences.ts` as a regression fixture (name the machine and the device).
