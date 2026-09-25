# Viewport, selection and view tools: integrator follow-ups

Branch: the VIEW/SEL overnight stream (FULL-MODELING-PLAN §2.4, §2.6, T0 items 15–19, 24).
Everything below works on the branch as it is; these steps finish the wiring into files this
stream was not allowed to edit (Phase C's hot paths). Each step is small and independent.

## 1. Display modes in forge-wasm (one line) — do this first

`forge/crates/forge-wasm/src/web/view_ext.rs` adds `setDisplayMode`, `displayMode`,
`displayModes` and `setXrayOpacity` to `RawViewport`. It is a child module of `web.rs`, so it is
compiled only when `web.rs` declares it. Add, right after `use crate::scopes::Scopes;`:

```rust
mod view_ext;
```

(After the planned split into `web/mod.rs`, the same line goes into `web/mod.rs`; the file is
already at `src/web/view_ext.rs`.) Checked on this branch: `cargo clippy -p forge-wasm --target
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

then delete the app's own `view.fit`, `view.setView` and `view.setProjection` (superseded) and:
- `ui/keyboard.ts` now binds the viewport keys; drop `installViewportKeyboard` from
  `ui/Viewport.tsx` **but keep its canvas-only table** (`⌘A` = select all must not fire inside
  the code editor: register it only when the event target is not editable);
- `ui/CommandPalette.tsx`: back to `commands.paletteItems()` / `commands.executeUnknown`;
- `viewport/test-hook.ts` and `ui/Viewport.tsx`: `routedExecute` → `commands.executeUnknown`;
- `window.__aicad.execute` then reaches the viewport commands as well.

## 3. Agent and MCP

- Generate agent/MCP tools for the read-only commands `selection.get`, `measure.selection`,
  `measure.items`, `view.snapshot` (the agent never moves the camera, §2.1 rule 5).
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
