# Print quality and the design pass: what is built

- **Status:** built on branch `worktree-wf_c69c637e-016-9` on top of `fm-integration` (2026-09-25). Not pushed.
- **Asked for (the owner, 2026-09-25):** holes print round (≈0.01 mm chord, ≤5°), circles look round in the viewport, STEP as a choice in Open in Bambu Studio, and a pro-grade look: "not a chat window, a bunch of code and a few ugly presets".
- **Plan:** [FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md) §1.2 (#16, #19, #21, #22, #24), §2.5 "Layout", §5.6, §5.7.

## Print quality

| What | Where | Proof |
|---|---|---|
| Every mesh file (3MF, STL, OBJ) and the P2S handoff tessellate at 0.01 mm chordal and 5° | `PRINT_TESSELLATION` (`app/src/engine/types.ts`), the P2S profile's `printTessellation` (`desktop/src/profiles.ts`), both from `fm-integration` | `app/test/tessellation.test.ts`: a 5 mm through hole (a `hole` feature) exported as STL and 3MF has ≥ 72 rim segments at both ends, no gap over 5°, sagitta ≤ 0.01 mm. `desktop/test/print.test.ts`: the same hole in the P2S 3MF the real `aicad` writes for Bambu Studio, ≥ 72 segments, every rim vertex on the 2.5 mm circle |
| The viewport tessellates finely enough that circles look round | `app/src/viewport/display-tessellation.ts`, `DocStore.setDisplayTessellation`, `ViewportRuntime.adaptTessellation` | `tessellation.test.ts` (≥ 36 segments on the same hole, where Forge's default gives ~18; one re-evaluation per step change), `viewport-commands.test.ts` (the step follows the part's size) |

**Display tessellation.** At most 10° between facet normals (every full circle ≥ 36 segments) and half a device pixel of chordal error at 2× the fitted zoom, in fixed steps (0.05, 0.035, 0.025, 0.018, 0.0125, 0.01 mm) with 15 % hysteresis, from the part's bounding sphere and the viewport's short side. A step change re-evaluates the document once; tool previews and the proposal preview use the same step.

**Performance** (forge-web in Node on this Mac, median of 12; the edit budget is 150 ms, §5.6):

| Part | Forge default (0.05 mm, 20°) | Display (0.01–0.05 mm, 10°) | Print (0.01 mm, 5°) |
|---|---|---|---|
| R25 bench (25 features, spike 05) | 46 ms | 73–75 ms | 136 ms |
| Electronics box starter | 60 ms | 60–65 ms | 64 ms |
| Phone stand starter | 25 ms | 24 ms | 25 ms |

Not measured: an edit → screen trace in the app (the C7 marks are not in yet), R50, zoom-adaptive re-tessellation (the step follows the part and the window, not the zoom).

## STEP in Open in Bambu Studio

- **Does Bambu Studio import STEP?** Yes: Bambu Studio 02.06.00.51 (installed here) carries a STEP loader and a STEP mesh-precision dialog (its binary's `load_step_file`, `StepMeshDialog`, `linear_defletion`, `angle_defletion`; read, not run). Its `Info.plist` does not declare the STEP type, so how the open-document event treats a `.step` is **not seen on screen yet** (G2c hands-on).
- **Command:** `file.openInSlicer { format: "3mf" | "step" }` (⌘P, the palette, File ▸ Open in Bambu Studio and File ▸ Open in Bambu Studio as STEP). The toolbar's split button sends the last choice and its chevron offers "3MF · print-ready" and "STEP · exact geometry".
- **Handoff:** the same checks as 3MF on the print meshes (Forge's report, bed fit, watertight, stacked bodies), then `aicad export --format step` (AP214) saved as `<doc>-<hash8>.step` in `~/PartZero/Prints` with a receipt that says `format: "step"` and has no tessellation or placement (Bambu Studio tessellates and places it). Receipts now carry `format` for 3MF too.
- **Tests:** `desktop/test/print.test.ts` (the real `aicad`: ISO-10303-21, AP214, the 2.5 mm cylinder, opened with `open -a`; a part too big is still refused), `app/test/print.test.ts` (the command, its default, the agent's call, invalid formats).

## The design pass

### Layout (FULL-MODELING-PLAN §2.5)

- **Title bar:** brand, file, undo/redo, the **Solid / Sketch** workspace tabs, the document, command search, an Assistant toggle, theme, settings.
- **Ribbon, Solid tab:** the registry's groups in Fusion's order (Sketch, Create, Pattern, Modify, Construct, Inspect, Print) with 22 px icons, labels and captioned group menus; **Export** (the export dialog) and the **Open in Bambu Studio** split button at the right.
- **Ribbon, Sketch tab:** before a sketch, Create Sketch and the sketcher's tools (a click starts a sketch, then picks the tool). While a sketch is open the tab is forced on and the sketcher renders its palette (Select · Create · Dimension · Modify · Options), its constraints and Undo / Redo / Fit / Cancel / **Finish Sketch** into the ribbon (`ui/shell/ribbon.tsx`, `RibbonPortal`: one implementation, the same test ids). The viewport keeps only the sketch's name chip and the inspector.
- **Tool panels float** over the viewport's top left (Fusion, Shapr3D); the right dock no longer has a Properties tab.
- **Left dock:** Timeline, **Browser** (new: origin planes and axes, bodies with colour and show/hide, sketches, construction; every action a command) and **Parameters** (its own tab; the table is always open there).
- **Assistant:** a narrower column (348 px), suggestion chips before the first request, and a title-bar toggle to hide it.
- **Problems:** one row ("0 · No problems") until there is a problem.
- **No code** in the default UI (unchanged rule; checked on every screen of the design e2e).

### Tokens, type and icons

- `app/src/ui/styles/design.css`, loaded last: the tokens of both themes (surfaces, chrome, text, accent, status, AI, shadows, glass, icon and illustration colours), a 4 px grid, type 10.5–22 px, radii 4 / 6 / 10 / 14. `design.test.ts` checks both themes define the same colour tokens.
- **Icons:** our own set (`ui/shell/tool-icons.tsx`), 20 px grid, 1.5 px non-scaling strokes, two tones (the accent marks what the tool makes). It covers the op catalogue's features, construct and inspect tools, the sketcher's 20 tools and 12 constraints (which were letters and Unicode glyphs), and the browser's entities.
- **Starter thumbnails:** the welcome screen's five starters are cards with a picture: Forge's render of the ready-made examples (phone stand, electronics box; the document thumbnail's own rasteriser), and our isometric illustrations for the ones the agent designs (`starter-art.tsx`).

### Screens

`packages/desktop/e2e/design.e2e.ts` saves 14 screens (welcome, empty document, model, tool panel, browser, parameters, the Bambu choice, the Sketch tab, a sketch, the palette; dark and light) to `<worktree>/test-results/design/`.

## Not done

- **forge-render's background** is a fixed light gradient (Rust constants, `forge-render/src/viewport.rs`): a dark viewport for the dark theme needs `setColors` in forge-wasm (a WASM rebuild). `ForgeWebAdapter.setColors` is still a no-op.
- **Zoom-adaptive tessellation:** the step follows the part and the window, not the camera's zoom; a close zoom on a small hole in a big part can still show facets.
- **The view toolbar** (Iso, Top, …, Bodies) keeps its text buttons; an icon navigation bar was left to the viewport's owners.
- **Feature tools** other than Extrude still use the generic panel; the new icons are ready for them (`fillet`, `chamfer`, `shell`, `hole`, patterns, datums, `measure`, `section`, …).
- **The assistant's file commands:** `file.openInSlicer` is an app command; agent and MCP tools are generated from the op catalogue, not from app commands, so the agent cannot call it yet.

## Integrator notes

- **Hot files touched:** `ui/shell/ShellToolbar.tsx` (title bar and ribbon rewritten; `ToolButton`, `GroupMenu`, `ToolGroup` kept), `ui/shell/panel-catalog.tsx` (Properties removed from the right dock; Browser and Parameters added; `FloatingPropertyPanel`), `ui/shell/AppShell.tsx`, `ui/sketch/SketchModeHost.tsx` (palette, constraints and header actions wrapped in `RibbonPortal`), `ui/Timeline.tsx` (header, empty states, `ParametersPanel({ docked })`), `ui/ProblemsPanel.tsx`, `ui/StatusBar.tsx`, `ui/ChatPanel.tsx`, `ui/shell/Welcome.tsx`, `commands/commands.ts` (`file.openInSlicer`), `doc/doc-store.ts` (display tessellation), `viewport/runtime.ts`.
- **Test ids changed:** `dock-tab-properties` is gone (the panel floats: `floating-panel` holds `property-panel`); the ribbon's export button is `tb-export` (was `export-3mf`) and opens the export dialog when the document layer is installed. New: `ws-tab-solid`, `ws-tab-sketch`, `ribbon-create-sketch`, `ribbon-sketch-tools`, `ribbon-sketch-actions`, `open-in-slicer-menu`, `slicer-format-3mf|step`, `dock-tab-browser`, `dock-tab-parameters`, `browser-*`, `timeline-empty`, `chat-suggestions`, `starter-render`.
- **A stream that adds a tool** gets a crisp icon by naming one of the set's icons; a new glyph is one entry in `tool-icons.tsx`. A stream that adds a sketch tool adds it to `SKETCH_TOOLS` and the ribbon shows it.
- **Streams that assert on the right dock's Properties tab** need the floating panel instead.
