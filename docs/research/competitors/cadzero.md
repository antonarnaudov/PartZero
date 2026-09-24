# CADZero: competitor evaluation

*As of 2026-09-24. Subject: [github.com/JBowen99/CADZero](https://github.com/JBowen99/CADZero) and [cadzero.dev](https://cadzero.dev/). Compared against PartZero at HEAD `831a995` and the Phase 1 plan in [ROADMAP.md](../../ROADMAP.md).*

**How this was checked.** CADZero was read through the GitHub API and its website only. Nothing was cloned, installed or run, so statements about its runtime behaviour come from reading the code. PartZero was checked against committed code, docs and CI at HEAD. Uncommitted Phase C work is not counted.

## Bottom line

CADZero is a competent two-week solo prototype. You type a request, an AI writes an OpenSCAD or build123d script, and the app turns that script into a part. It works end to end today, and PartZero does not, so today it is ahead on the thing a user feels first.

It is not a serious competitor:
- Nothing in it checks whether a part is correct, only whether the script ran.
- It has no license, 1 star and 2 downloads.
- It has been idle since 29 July 2026.

If PartZero passes its Phase 1 gates (open alpha around May 2027), PartZero should lead on precision, features, editing and measured accuracy. CADZero would keep two advantages: its files work outside the app, and AI models already know its languages.

The more important finding is about the category. An app like CADZero, built on OCCT and with exact-measurement checks added, could cover most maker needs within weeks. Our lead depends on shipping Forge F1/F2 (booleans, STEP, fillets) and publishing AI accuracy numbers before someone does that.

**Two corrections to the original description:**
- **It does have manual editing.** It has a code editor with saved manual revisions. Parameter sliders and a comment-driven "feature tree" exist only on unreleased master. What it lacks is direct geometric editing: no sketcher, no constraints and no drag handles.
- **It is not OpenSCAD-only.** It has a second backend, build123d, which runs on OCCT (the open-source B-rep kernel). That backend provides STEP export, fillets, picking and measuring.

The Cursor detail is partly confirmed. Three commits, all on 2026-07-18, carry a `Co-authored-by: Cursor` trailer. The rest of the repo shows typical signs of agent-driven development: a 101 KB `project-knowledge.md`, an `.agents/skills` folder, and "Phase 1/2/3" commit messages.

## 1. What CADZero is

| Item | Finding |
|---|---|
| Form | Electron desktop app for Linux and Windows. No macOS build. It is not web-based. |
| Built | By one developer (JBowen99, "CodeWithJoe"), 78 commits between Jul 15 and Jul 29, 2026. The repo was created 2026-07-16 and renamed from "ChatCAD". Nothing has been pushed since 2026-07-29. |
| Release | One release, v0.1.0 (2026-07-18): a Linux AppImage (488 MB) and a Windows installer (304 MB), each downloaded once, 2 downloads in total. Master is 37 commits ahead of the release. |
| Community | 1 star, 0 forks, 0 issues. All 8 PRs were self-merged. No third-party mentions were found (Hacker News, GitHub or web search). |
| License | None: no LICENSE file, the GitHub API returns `license: null`, and `package.json` has `"private": true`. Legally that means all rights reserved, even though the website says "Open-source". |
| Engines | OpenSCAD is the external command-line program on the user's PATH and is not bundled. build123d runs in a bundled Python runtime (standalone CPython 3.12, build123d, OCP/OpenCascade under LGPL, and ezdxf). CADZero has no geometry engine of its own. |
| AI | OpenRouter only, bring your own key, 22 allowed models (default `openai/gpt-5.4`). The key is stored with Electron's OS-level encryption. There are no accounts, billing or telemetry. |
| Storage | One `.cadz` SQLite file per part, holding revisions, chat and cached meshes. |
| Code size | About 18.3k lines, mostly TypeScript plus a 766-line Python worker. |

### How the AI loop works

1. Plan and Chat modes cannot change the model. In Build mode the model must call one tool, `update_model`, with the **complete** script every time.
2. The app renders the script. If rendering fails, or if the mesh exceeds 500,000 triangles, the error goes back to the model. The loop is capped at 4 steps, so a failure gets about 3 retries.
3. Nothing checks dimensions, bounding box, volume, watertightness or whether the result matches the request. No image of the result goes back to the model, and no benchmark scores the output. "Success" means the script produced a mesh.
4. Grounding:
   - The current script is pasted into every prompt.
   - On build123d parts, faces, edges and vertices the user picks are sent to the model as "ground-truth dimensions". So are measurements, but the measure tool is on master only.
   - Image attachments are sent when the chosen model supports vision.

### Problems found in the code (read, not run)

- **Wrong fillet in the OpenSCAD prompt.** The system prompt's OpenSCAD "Corner Fillets" example subtracts cylinders centred on the plate corners. That cuts concave notches instead of rounding the corners, so the model is taught a wrong fillet.
- **build123d fillet examples look wrong.** Line 37 uses `part.fillets(...)`, but build123d's method is `fillet`. Lines 143–165 make `with Build() as ctx:` "CRITICAL", and the worker defines no `Build`. If that API really does not exist, parametric build123d parts would fail until the repair loop swaps in the real one. This is inferred from reading the code.
- **Advertised but missing.** GLB export is advertised but has zero matches in the code. OBJ and 3MF export on build123d parts probably fails, because the worker has no branch for those formats.
- **Security:**
  - AI-written Python runs through `exec` with the user's full permissions and no sandbox.
  - The local API on `127.0.0.1:8787` (`POST /api/render`) has no authentication and will execute any build123d code posted to it.
  - A cross-origin POST from a web page *might* reach it, because the body is read as JSON without checking its content type. This was not tested, and browser rules on requests to local addresses may block it.
- **Engineering hygiene.** About 70 unit tests, all on helper functions. No CI, no linting, and a dead Dockerfile from a template.
- **On the plus side:** TypeScript strict mode is on, the Electron window is sandboxed (`contextIsolation`, `sandbox: true`), and temp files are cleaned up.

### Demo quality

These observations come from looking at the 7 static screenshots on the website by eye, so each one is a reading, not a measurement:
- The gear teeth appear to be rectangular blocks, not involute profiles.
- The planetary set's planets appear to pass through the ring and sun teeth.
- The history demo includes a chamfer that needed a corrective prompt ("Fixed the chamfer so it bevels inward…").

There is no video and there are no downloadable sample files.

## 2. Scorecard

Legend: **Yes** = works today. **Partial** = limited or unproven. **No** = absent. The "PartZero at MVP" column is planned scope from ROADMAP.md Phase 1. It is not working code, and it depends on passing the F2 maker release gate.

| Dimension | CADZero (v0.1.0 unless noted) | PartZero today (HEAD) | PartZero at MVP (planned) |
|---|---|---|---|
| **Can a person use it** | Yes. Linux and Windows installers. The OpenSCAD path needs a separate OpenSCAD install; the build123d path works from the installer. | No. README: "Nothing here is usable yet." Packaged builds cannot run the agent. No release pipeline or code signing. | Yes. Signed macOS and Windows builds with auto-update; Linux AppImage beta. Closed alpha ~Apr 2027, open alpha ~May 2027, beta ~Jul 2027. |
| **Geometry precision** | Partial. The build123d path gives exact B-rep geometry from borrowed OCCT. The OpenSCAD path uses faceted meshes: a Ø5 hole is about 0.02 mm undersize at the `$fn` the prompt asks for, and 0.38 mm if the AI leaves `$fn` out. | Partial. Our own exact kernel (Forge) is strongly tested (see §4), but the app runs IR v0, which has no booleans. The boolean engine has not passed its gate. | Yes, if gates pass: 0 silent-wrong results in the nightly differential suite, and validity at least equal to OCCT on the fillet/chamfer/shell corpus. |
| **Real-part features** | Partial. Fillet, chamfer, holes, patterns, shell and text are possible through build123d/OCCT and OpenSCAD. The prompt's fillet examples look wrong, and nothing was verified by running it. No sketches, constraints, assemblies, drawings or imports. | No. Sketch, extrude and revolve only. Hole, fillet, chamfer, pattern, shell and draft are rejected by the kernel. | Yes. Extrude, revolve, holes, fillet, chamfer, shell, draft, patterns, mirror, booleans, datums and text emboss. |
| **Manual editing** | Partial. Code editor with manual revisions. Sliders and the `@op` feature tree are on master only. No sketcher or constraints. | Partial. Monaco code editor, timeline with suppress, undo/redo, and per-feature accept of AI proposals. No sketcher UI. Parameters panel is a placeholder. | Yes. Constrained sketcher (line, arc, circle, slot, spline and more), parameters and equations, timeline, two-way code view. |
| **How AI edits land** | Rewrites the whole script on every build. | Patches individual features (`set_param`, `sketch_edit`, per-feature diffs). Supported by the code, not yet measured in live runs. | Draft-branch diffs, per-feature accept. |
| **Checks on AI output** | No. Only "did the script run", plus a triangle cap. At most 4 steps. | Partial. Checks at compile (L0), kernel evaluation (L1), per-step expectations (L2) and frozen spec tests (L3) are implemented but barely measured. The L3 editability probe, L4 manufacturability and L5 visual judge are not built. | Planned gates: T1 ≥85%, T2 ≥65%, T4 ≥80% hidden-test pass@1; validity ≥98%; editability ≥90%. |
| **Published AI accuracy** | No. None. | No. One smoke run on one provider: 2 of 3 tasks, 17/20 hidden tests. MakerBench reference solutions pass 61/61, but no live model has been scored. The provider bake-off is pending. | Required by the exit gates above. |
| **Export** | Partial. STL, OBJ, 3MF. STEP for build123d parts only. SVG/DXF of a single face on master. | Partial. STL, OBJ and 3MF only (mesh). Exported volume is within 0.04–0.3% of exact. STEP is a placeholder. | Yes. STL, 3MF and STEP export. Import of STEP as a solid and of STL/3MF as reference meshes. |
| **AI providers** | OpenRouter only (22 models), bring your own key. | Anthropic, OpenAI, Google, any OpenAI-compatible endpoint (including Ollama), CLI agents and an MCP server. Only Claude Code has been tested live. | Bring your own key for every provider at alpha; hosted credits at beta. |
| **Files usable elsewhere** | Yes. `.scad` runs in any OpenSCAD and can go to MakerWorld's Parametric Model Maker; build123d scripts run in any Python. | No. CadScript runs only in PartZero. The headless MCP server can edit files without the app, but still uses our toolchain. | Partial. STEP export makes geometry portable. The editable source still works only in PartZero. |
| **AI model familiarity** | High. OpenSCAD and build123d have years of public code. | Low. CadScript is new, and models learn it from the prompt. | Unknown until spike 7 compares CadScript with build123d. The pass bar is CadScript ≥ build123d minus 5 points. |
| **Safety of AI-written code** | No. AI Python runs unsandboxed through `exec`, and the local render API is unauthenticated. | Yes, apparently. CadScript is parsed and compiled with the TypeScript compiler API, and `packages/cadscript/src` contains no `eval`, `new Function` or `vm`. | Same design. |
| **Complex machinery** | No. Whole-script rewrites, face indices as references, no assemblies. | Partial. Foundations exist but are unproven at scale: typed Feature-Graph IR, persistent naming, and the constraint solver. | Partial. Single parts only. Assemblies are Phase 2 (Jul–Dec 2027). |
| **Engineering and tests** | Partial. About 70 helper unit tests, no CI. | Partial. About 1,050 Rust, 1,130 TypeScript and 291 oracle test functions (a static count, not a green run). CI on main is red. Windows has never been verified. | Planned gate: ≥99.5% crash-free sessions. |
| **License** | No license of its own. It bundles CPython, build123d and OCCT (LGPL). It does not bundle OpenSCAD, so the GPL does not attach. | MPL-2.0 repo; `cadscript` and `ir-types` are Apache-2.0. | Open-source public alpha. |
| **Momentum** | Idle about 8 weeks. The website is stale and matches v0.1.0. | Phase 0, about 29 hours of history, 58 commits. | Phase 1 runs Nov 2026 – Jul 2027. |

## 3. Where CADZero is ahead today

1. **It ships.** Prompt, part and export all work from an installer. PartZero cannot produce a part from a packaged build.
2. **STEP and fillets now.** It borrows both from OCCT through build123d. Forge gets STEP at F1 (M2–M5, roughly Nov 2026 – Feb 2027) and fillets at F2 (M4–M8, roughly Jan–May 2027).
3. **Faster to a first result.** Paste a key and type. There is less machinery, so there is less to break.
4. **Models already know its languages.** One vendor blog (GrandpaCAD, one model, 23 prompts) measured about 0.4 code errors per generation for OpenSCAD and 1.4–1.7 for build123d. That is a property of OpenSCAD, not of CADZero, and most of CADZero's own demos use build123d.
5. **Portable files and an ecosystem.** Its scripts run in OpenSCAD and Python, and the OpenSCAD path can use BOSL2 and publish to MakerWorld.
6. **Shipped UX we lack:**
   - Plan/Chat/Build modes
   - one-click revision restore
   - clicking a face or edge to give the AI context

   The per-build diff view, measure tool and sliders are on master only.

## 4. Why PartZero's approach wins for the long run

Each point is backed by the evidence gathered. Each also carries its caveat.

- **AI output that is checked, not hoped for.**
  - The accuracy gains in recent research come from feeding exact measurements back to the model. CADSmith fed OCCT bounding box, volume and validity back into the loop and cut mean Chamfer distance from 28.37 to 0.74 on 100 prompts.
  - PartZero has a four-level check ladder built. CADZero checks only that the script ran.
  - **Caveat:** CADZero could add exact-metric checks to its build123d path cheaply. This is a lead only once we measure and publish results.
- **Output a machine shop accepts.**
  - CNC services want STEP. Protolabs Network does not accept STL or OBJ for CNC machining.
  - OpenSCAD cannot export STEP at all; it has been requested since 2014 (openscad#893). CADZero gets STEP only on its build123d path.
  - At MVP, PartZero exports and imports STEP natively.
- **Edits that do not break.**
  - Persistent naming survived 99.98% of dimension edits and 100% of topology edits with 0 silent-wrong results.
  - Our AI edits one feature at a time, while CADZero's rewrites the whole script. Stable references are what "fillet this edge" and mixed hand-and-AI editing depend on.
  - The constraint solver's worst drag frame is 1.75 ms with 200 entities.
  - **Caveat:** naming was measured on simple v0 models and has not been re-run since booleans. Solver agreement (99–100%) covers degrees of freedom, redundancy and conflict detection, not solved positions.
- **A kernel we control.**
  - Forge matches OCCT on 6,008 of 6,008 test programs with 0 silent-wrong results, and outputs are bit-identical on macOS, Linux and WASM.
  - Its surface intersection got 0 of 4,800 synthetic stress cases wrong; OCCT got 3.6% wrong.
  - We do not depend on OpenSCAD, whose last stable release is 2021.01 and whose issue #6687 asks whether the project is alive.
  - **Caveats:**
    - The 4,800 cases are synthetic analytic pairs. Near-tangent cases still fail, explicitly. B-spline surfaces are unsupported.
    - Booleans have 85 unresolved POTENTIAL_SILENT_WRONG rows attributed to the oracle, and 82.1% literal oracle agreement pending normalisation.
    - Against CADZero's build123d path, which also produces exact B-rep, our precision edge is unproven outside these specific tests.
- **Where the professional value is.** Adam (CADAM) moved its professional product to a copilot inside Onshape and Fusion, which are exact B-rep tools.
  - **Honest limit:** that supports B-rep editing. It does not prove we need our *own* kernel. Adam borrowed Parasolid, and our roadmap accepts about 3 months of delay for building Forge first (ROADMAP.md, "Ground rules").

## 5. What to borrow

1. **Plan / Chat / Build modes.** Make it explicit when the AI may change the model. This fits our triage → spec → build flow.
2. **Picked geometry and measurements as AI context.** We already have pixel-exact picking. Send the selected face and edge names plus exact measurements to the agent. Our persistent names make this stronger than their face indices.
3. **A code diff for every AI build, plus one-click restore.** Pair it with our per-feature accept.
4. **Sliders generated from `param()` as soon as IR v1 reaches the app.** This is the cheapest "manual edit" users will notice.
5. **One-step onboarding:**
   - bring your own key, including OpenRouter through our OpenAI-compatible path
   - the key stored in the OS keychain
   - a working first-run template

   A self-contained document file (their `.cadz` holds revisions, chat and cached meshes) is also worth weighing for our document format.

**Lessons from their mistakes:**
- Test every example in the system prompt automatically (theirs teach wrong fillets).
- Never advertise features that do not exist (GLB, "open-source").
- Sandbox anything the AI writes.
- Never let "the script ran" be the only check.
- Keep CadScript's API small and forgiving.

## 6. Risks to us

- **Time is the threat, not CADZero.**
  - An app like CADZero on OCCT, with measurement checks added, could cover most maker value in weeks.
  - Our open alpha is ~May 2027, about 3 months later than an OCCT-based plan by our own roadmap.
  - Until F1/F2 ship, OCCT- and OpenSCAD-based tools can do things we cannot.
  - The first gap to close is time to first part.
- **The category is crowded and funded:**
  - **Adam/CADAM:** about 5.2k GitHub stars and a $4.1M seed. It claims over 1M models.
  - **Zoo:** its own cloud kernel, the KCL language, and Text-to-CAD that outputs B-rep/STEP. It is the closest to our thesis, not an OpenSCAD-style tool.
  - **GrandpaCAD and ModelRift:** both on OpenSCAD.
- **CadScript familiarity.** If the spike 7 bake-off shows models write build123d much more reliably than CadScript, a core bet is at risk. It has not run yet because there were no API keys.
- **Our evidence is thin too.**
  - AI accuracy has been measured on 3 tasks.
  - CI is red.
  - Booleans have not passed their gate.
  - PartZero is about 242k lines written almost entirely by AI agents in about 29 hours, with no outside users. The "built fast by AI with little review" critique applies to us at least as much as to CADZero.
- **Lock-in perception.** Makers may prefer `.scad` or Python files they can run anywhere. STEP export and the open-source license help, but the editable source is ours alone.
- **Benchmarks.** CADGenBench accepts STEP only, so OpenSCAD tools cannot enter natively. PartZero cannot enter either until F1 delivers STEP, while CADZero's build123d path could submit today.
- **Name similarity.**
  - "CADZero" and "PartZero" share the "-Zero" suffix and the same pitch, which could cause confusion in search and word of mouth.
  - A second, unrelated "CADZERO" also exists: a Fusion 360 AI copilot by xchrisbradley, with a Product Hunt listing from Nov 2025 and YouTube videos. Its site, www.cadzero.com, now shows "Site Not Found".
  - Both are small, so the risk is modest.
  - Before launch, run the formal trademark and domain check that README.md already calls for, and do not make "Zero" the distinctive part of our messaging.
  - This is not legal advice.

## Sources

**CADZero**
- Repository and API data: https://github.com/JBowen99/CADZero
  - `server/system-prompt.ts`
  - `server/app.ts`
  - `server/backends/openscad.ts`
  - `server/backends/build123d_worker.py`
  - `scripts/setup-python.mjs`
  - `package.json`
  - `README.md`
  - `app/lib/scad-meta.ts`
  - `electron/credentials.ts`
  - `server/storage/schema.ts`
- Release v0.1.0: https://github.com/JBowen99/CADZero/releases/tag/v0.1.0
- Website: https://cadzero.dev/ (landing repo https://github.com/JBowen99/CADZero-landing)

**Unrelated product with the same name**
- https://www.producthunt.com/products/cadzero
- https://www.youtube.com/watch?v=CptZop9xqHM
- https://github.com/xchrisbradley/cadzero_addin

**OpenSCAD, CAD kernels and AI CAD research**
- OpenSCAD manual on faceting: https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Other_Language_Features
- OpenSCAD STEP export request: https://github.com/openscad/openscad/issues/893
- OpenSCAD project status question: https://github.com/openscad/openscad/issues/6687
- Manifold as the default backend: https://lists.openscad.org/empathy/thread/TMJEJCZINIJNYJX2YF7IDNBAPQY66KIF
- build123d selectors: https://build123d.readthedocs.io/en/latest/tutorial_selectors.html
- CADSmith: https://arxiv.org/abs/2603.26512
- CADGenBench: https://github.com/huggingface/cadgenbench
- GrandpaCAD, OpenSCAD vs CadQuery vs build123d: https://grandpacad.com/en/blog/openscad-vs-cadquery-vs-build123d
- ModelRift, CadQuery vs OpenSCAD: https://modelrift.com/blog/cadquery-vs-openscad/
- CHI'24 study of OpenSCAD users: https://arxiv.org/pdf/2408.01796
- Protolabs Network file requirements: https://www.hubs.com/help-center/ordering-custom-parts/1-uploading-parts/uploading-cad-files/
- ISO 286 tolerances (for the faceting comparison): https://www.roymech.co.uk/Useful_Tables/ISO_Tolerances/ISO_286_2H.html

**Other AI CAD products**
- CADAM: https://github.com/Adam-CAD/CADAM
- Adam funding: https://aicurator.io/adam-funding/
- Adam in Onshape: https://www.onshape.com/en/blog/adam-ai-app-store-cad-co-pilot
- Zoo Text-to-CAD: https://zoo.dev/blog/introducing-text-to-cad
- Zoo Design Studio v1: https://zoo.dev/blog/zoo-design-studio-v1

**PartZero (this repo)**
- [README.md](../../../README.md)
- [docs/ROADMAP.md](../../ROADMAP.md): Phase 1 scope and exit gates, and the roughly 3-month cost of building Forge first
- [docs/FORGE.md](../../FORGE.md): milestones F0–F2
- [docs/BACKLOG.md](../../BACKLOG.md)
- [docs/spikes/](../../spikes/)
- [docs/RESEARCH.md](../../RESEARCH.md): Zoo's own cloud kernel
- [docs/CLI-PROVIDERS.md](../../CLI-PROVIDERS.md)
- [docs/audits/2026-09-23-phase0-audit.md](../../audits/2026-09-23-phase0-audit.md)
- `forge/crates/forge-regen/src/v1/mod.rs`
- `forge/crates/forge-io/src/step.rs`
- `packages/agent-tools/src/source.ts`
- `packages/cadscript/src/`
- CI run 35951584017 on main
