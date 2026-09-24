# PartZero North Star

*Status: Approved by the owner on 2026-09-24; integrated into [ROADMAP.md](ROADMAP.md) and ADRs [0015](adr/0015-autonomy-dial.md)–[0020](adr/0020-funded-eval-keys-fallback.md) (the changes to [FORGE.md](FORGE.md), BACKLOG.md, CLAUDE.md, the IR v1 plan, ADR 0013 and the SPEC wait for Phase C, and one to CLI-PROVIDERS.md waits too; all are recorded in [NORTH-STAR-DEFERRED.md](NORTH-STAR-DEFERRED.md)). The text below is the proposal as approved: where it says "PROPOSED", "needs approval" or "changes nothing", read "approved on 2026-09-24". Labels: **Built**; **Planned** (already in ROADMAP or FORGE.md before this document); **PROPOSED** (added by this document; approved, not built). **Bet** tags a hypothesis with a stated proof; approval makes no bet a fact. Terms are in the glossary at the end of this preamble.*

**Cursor for CAD, from intent to the machine.** Cursor put agents inside the code editor: developers describe and review, and the agent writes. PartZero aims to do the same for 3D CAD. You say what the part must do. The agent drafts the sketches, features, dimensions and engineering numbers. Forge, our own kernel, builds and checks every step before you can accept it. You shape the result by hand whenever you want, and your moves and the agent's land in one parametric model, one timeline and one undo stack. Then you export a file your printer, laser or CNC accepts, tuned to your machine, with the evidence attached.

**PartZero is built never to lie.** Every result is checked by the kernel, every number cites its source, and every case where we got it wrong is published in the failure zoo. This is a design rule we measure, not a fact yet. Today: 0 silent-wrong results on the named generator corpus (6,008 extrude and revolve programs). The Phase 0 audit found 2 outside it (H1: a near-360° revolve reported +13.4% volume as ok; H2: bounding boxes up to 9× too large), now pinned by regression tests. The sourced handbook is not built yet.

> **Decisions the owner approved on 2026-09-24** (§8 has the detail)
> 1. **Keep the F2 gate exactly as FORGE.md defines it.** Phase C is working toward it now. New checks join the Phase 1 exit (beta) gate instead, and each can delay beta (§8 group A).
> 2. **Telemetry (ADR 0017).** Opt-in, anonymous product counts for BYO and CLI users, plus minimized kernel failure reports. Without it, or a consented alpha study, the north-star metric cannot be measured (§7).
> 3. **Money and time.** Fit Lab: the owner's own 3D printer(s) for now, with the owner printing the test parts (3–5 h/week); the ~$4–6k hardware purchase for §7's full setup is deferred. A compute line for the verification machine. An eval fallback: funded API keys at open alpha (ADR 0020) if CLI-plan runs cannot keep a weekly cadence.
> 4. **Dataset licences before first use:** ABC, DeepCAD, Fusion 360 Gallery. Check whether Onshape's terms allow competitive benchmarking.
> 5. **The new gates in §7,** including a head-to-head against Zoo, Adam and others.
> 6. **ADR 0015** autonomy dial. **ADR 0016** manufacturing output (slicer rule, CAM to Phase 3). **ADRs 0018–0019** design context and local face operations in the IR. Numbers are provisional.

> **Glossary.** **M1** = Oct 2026, so M4 = Jan 2027, M7 = Apr 2027 (closed alpha), M8 = May 2027 (open alpha), M10 = Jul 2027 (beta, Phase 1 exit), M15 = Dec 2027 (v1.0). **F0–F5** are Forge milestones: F1 booleans, holes and STEP (M2–M5); F2 fillets, shell and draft, the maker release gate (M4–M8); F3 surfacing and general blends (M8–M14); F4 gradients and SubD (M12–M18); F5 FEA and CAM (M18+). **T1–T4** are MakerBench tiers: simple parts, multi-feature parts, assemblies, edits. **IR** is the design's data model; **CadScript** is its code view. **B-rep** is an exact solid, not a mesh. The **oracle** is OCCT, run in CI only to cross-check Forge. **Silent-wrong** means a wrong result reported as fine. **pass@1** is success on the first try; **p95** is the 95th-percentile time. **AW** is agent-weeks; S/M/L are unsized. **DOF** counts a sketch's free motions (0 = fully constrained). **SF** is safety factor. **GD&T** is tolerance notation on drawings; **FEA** is stress simulation. A **post** translates toolpaths into one machine's G-code dialect; **2.5D CAM** cuts layer by layer. **Proven bounds** carry a mathematical error bound; they are not an engineering certification. **Phase C** is the IR v1 work running now; **W6** is its feasible-ranges step.

## 1. The promise

"Never" is a target for common parts, measured by the no-heavy-lifting rate (§7). It is not a claim yet.

| Persona | Never does again | Still does | Arrives |
|---|---|---|---|
| Maker, 3D printing | Draw or constrain sketches; look up screw or insert holes; guess tolerances or print orientation | Give or measure key sizes; drag to adjust; approve; print one fit coupon per printer | Phase 1 |
| Code-CAD power user (OpenSCAD, build123d, CadQuery) | Debug geometry by hand; hand-write every feature | Review diffs; own the CadScript in git; write the tricky parts | Phase 1 |
| Developer or external agent (Claude Code, Cursor) via our MCP server and CLI | Wire up a kernel or verify geometry themselves | Drive PartZero from their own agent; review its branch | Phase 1 (Planned) |
| Laser / hobby CNC | Kerf compensation; DXF cleanup; checking inner radii against the tool; later, writing toolpaths | Set sheet, stock and tool; fixture the part; run the machine | Laser: Phase 1 beta; CAM: Phase 3 (both PROPOSED) |
| Small shop / fab customer | Redraw customer sketches; chase missing dimensions | Quote; fixture; run machines; sign off | Phases 2–3 |
| Engineer, small mechanisms | Place parts by coordinates; look up fits and fasteners; build the BOM; hand-dimension drawings | Own requirements and loads; sign off on safety factors; review suggested GD&T and FEA | Phases 2–5 |
| Product designer | Rebuild organic shapes as CAD by hand | Direct the form | Phase 5+ |

## 2. How the agent and the hands-on UX blend

- **One model.** Every hand move becomes a parametric feature. Every agent move arrives as a diff. Both share one IR, one CadScript file and one undo stack.
- **Nothing unchecked is committed.** Forge builds and checks every proposal before you can accept it. Nothing is committed, accepted or exported that Forge has not built and checked. The one exception is on screen during a drag: live frames come from a fast preview path and are drawn in a distinct provisional style. On release, Forge builds and checks the value within 150 ms; if it fails, the preview snaps back to the feasible limit.
- **The agent never silently touches your features.** This VISION non-goal stays.
- **External agents** get the same checked tools through our MCP server and CLI, and always land on their own `mcp/<client>` branch.

### Ways to work with the agent

Cursor analogues are from memory.

| Surface | What it is | Status |
|---|---|---|
| Always-on checks (like linting) | Overhangs, thin walls, CNC inner corners, sketch DOF. No LLM | Planned |
| Tab (like Cursor Tab) | A checked ghost of the likely next feature: an extrude after a closed profile, a pattern after a second identical hole, "fillet 2 mm (max 3.41)" on picked edges, an M3 chip "clearance 3.4 / insert 4.0 / tap 2.5" with sources | PROPOSED |
| ⌘K on the canvas | A quick edit at the selection lands in place as a ghost | Built in the chat panel only; on-canvas PROPOSED |
| Agent | Plan checklist, step-by-step build, per-feature accept, one undo step | Built in dev builds; live accuracy measured on 3 tasks; spec card Planned; packaged builds pending |
| Background | Long jobs on their own branch: variants, part families, drawings | Hosted Planned for Phase 4; local PROPOSED for Phase 2 |

Tab proposers start deterministic: no LLM, 300 ms or less. A learned next-feature model is a **bet**. It needs licensed CAD sequences and consented accept logs (ADR 0017), and ARCHITECTURE §8 rules out fine-tuning before M13.

**The autonomy dial (PROPOSED, ADR 0015).** "Autonomy" means this dial only. Three settings: ask at each step; propose per feature (the default); auto-apply checked quick edits to agent-authored features. A feature counts as agent-authored until you accept it or edit it; from then on it is yours. After a clean record the app may *offer* a higher setting. It never raises the setting by itself and never auto-applies to your features.

| Surface | How the dial applies |
|---|---|
| Checks, Tab, ⌘K | Always propose; you accept |
| Agent | Follows the dial |
| Background | Always lands on a branch |
| External agents (MCP) | Never auto-apply; always the `mcp/<client>` branch |

ADR 0015 amends VISION "Humans stay in charge" (point 6), ARCHITECTURE §6 (loop: PROPOSE, then per-feature accept) and §7 (draft branch), ADR 0004 (agent edits on a draft branch) and the PROPOSE gate in ADR 0014's runtime mode.

**Hands-on, Shapr3D-grade.**
- **Push/pull drives parameters** (PROPOSED): pull a plate's top and `thickness` changes. A fillet drag stops at "max 3.41 mm: the wall would vanish" (on F2 feasible ranges).
- **Typed dimensions become parameters** (Planned, Phase 1), and sketches auto-constrain as you draw (deterministic version PROPOSED for Phase 1).
- **Picks reach the agent by persistent name** (Built). The agent pausing when you edit is Planned, not built.
- **Trust tools:** checkpoints with restore, "Why?" on any value, receipts measured by Forge.
- **Local face operations** (PROPOSED, needs F3) extend push/pull to any face, imported STEP included.

**Today** there is no sketcher UI or on-canvas handle, the ghost is a tinted toggle, and packaged builds cannot run the agent ([AGENT-IN-APP.md](AGENT-IN-APP.md)).

## 3. The engineering copilot

Every engineering number shows its formula, inputs and source, and lives in the model as an editable parameter, not as chat text. Handbook values are computed from formulas or cited facts, never copied tables (ISO tables are copyrighted). Each source is recorded with its terms, for example in an extended `corpus/EXTERNAL_SOURCES.md`.

| Capability | What the user gets | Status |
|---|---|---|
| Sourced handbook and 8 calculation tools (`fit` ISO 286, `fastener`, `print_clearance`, `snap_fit`, `gear`, `bearing_select`, `beam_plate`, `material`) | "M3 heat-set insert?" → "Ø4.0 × 6.7 mm deep (ruthex, CNC Kitchen; insert length + 1 mm)" as a chip on the boss | PROPOSED for Phase 1 (named in ARCHITECTURE §6, not built). Pattern proven: the IR v1 hole table cites two sources per value, with noted exceptions (no two sources agree on the M2 counterbore depth) |
| Design context in the model | Material, process, machine, loads and requirements become parameters. A load badge such as "5 kg: SF 1.8–3.4 (PLA, printed flat, 20% infill)" turns red when you thin a wall, with no LLM call | PROPOSED |
| Closed-form structural checks | "Will this hold 5 kg?" gets a margin range plus its simplifications and assumptions. If no formula fits, or the part is printed and outside validated cases: "can't verify", never a guess | PROPOSED. Printed-part badges ship only after Fit Lab break tests (§7). FEA and the Phase 5 advisor gate stay |
| Standard-part swaps | Bearing 608 → 6001 updates the seat and the bolt pattern | Planned |
| Feasible ranges, sensitivities, "make it 20% lighter" | Answers in numbers, and a lighter branch that passes every check | Ranges Planned in F2; sensitivities PROPOSED by M10; search optimizer PROPOSED for Phase 2 |

The advisor explains; a human signs off. We never say "certified" or "safe", and safety-critical parts still need an explicit acknowledgment.

## 4. From model to machine

"Part zero" is the machine's work origin. Today the chain ends at a checked handoff: a file plus its receipt. It reaches the work origin only for CNC, and only once our own CAM ships (PROPOSED). Checks, calculations and toolpaths decide quality, so they are ours ([ADR 0000](adr/0000-own-the-core.md)). Slicers, machine senders, LightBurn and fab services are tools we hand files to. A headless slice from the user's own slicer is advisory information. It is never a PartZero check and never appears in the receipt.

| Machine | Hand-over | Our checks before export | Current plan → PROPOSED |
|---|---|---|---|
| FDM printer | Oriented 3MF opened in the user's installed Bambu, Orca or Prusa slicer; later multi-material 3MF (parts and colors) | Overhang, walls vs perimeters, minimum feature, bed fit, clearance measured on the user's printer | Built: mesh-only 3MF (volume within 0.04–0.3% of exact). Planned Phase 1: FDM checks, printer profiles. Slicer handoff Phase 2 → Phase 1 alpha. Multi-material: later |
| Resin | Hollowed part with drain holes | Minimum wall, islands, suction cups | None → Phase 2 |
| SLS / MJF (through services) | STEP or 3MF to the service | Minimum wall, powder escape | Not planned; later |
| Laser, waterjet, plasma | SVG or DXF for LightBurn or the cutter's software | Flat-part detection, kerf compensation, simple nesting; plasma adds lead-ins and a bigger kerf | Laser Phase 3 → Phase 1 beta. Plasma: later |
| Sketch → DXF/SVG (vinyl and drag-knife cutters, plotters) | The sketch itself | Closed profiles, units, minimum feature vs blade | DXF/SVG Phase 3 → Phase 1 beta, with the laser row |
| CNC router | STEP; later G-code and a setup sheet | Inner radii vs tool; later stock-removal simulation | STEP Planned at F1 (the writer is a placeholder today). Own 2.5D CAM and GRBL/LinuxCNC posts: Phase 6+ → Phase 3 (Kiri:Moto, MIT, as oracle) |
| CNC lathe | STEP; later turning toolpaths | Turnable profile | Phase 6+, unchanged |
| Machine shop | Fab packet: STEP plus a PDF of critical dimensions, fits, material, quantity | Validity | Phase 3 (with drawings) → Phase 2 |
| Online fab service (SendCutSend, OSHCut, JLC) | STEP or DXF plus the fab packet, run through the service's own checker | Per-service process rules | Manual upload from Phase 1; partnerships M15+, unchanged |
| Sheet metal | Flat-pattern DXF | ±0.1 mm | Phase 3, unchanged |
| Molding or casting | STEP | Draft and wall checks | Phase 5+, not planned yet |

Every export carries a **receipt**: checks passed against a named machine profile, validity, proven bounds (math, not an engineering certification) where Forge has them, and a determinism hash (a fingerprint showing the file rebuilds identically). G-code never leaves the app without simulation and the user's acknowledgment.

## 5. Beyond Parasolid, Onshape, Zoo and Adam

We can't license or ship Parasolid, but we can measure against its recorded output. The ABC dataset ships Parasolid and STEP exports of about 1M Onshape models alongside their feature files, and, where terms allow, the Onshape API runs Parasolid on our test parts. Every better-than-Parasolid claim names that corpus. Risk: ABC is under Onshape's terms, and those may restrict competitive benchmarking. We turn "decades ahead" into dated, public targets (§7), and we claim a lead only where a published head-to-head number shows it.

### Better by design

We infer these are hard to bolt onto a decades-old kernel or reach through a host app's API.

| Edge | Evidence today | Caveat |
|---|---|---|
| Native persistent naming | 18,997 references, 456 edits, 20 maker models: 100% correct or flagged, 0 silent re-binds. Resolved with no user action: 99.95% on dimension edits, 93% on topology edits, 90% overall ([spike 02](spikes/02-naming.md)) | Every flag is work for the user. GO only after one fix; simple models; not re-run since booleans |
| Bit-identical results | 828/828 files identical on macOS arm64 and Linux arm64/amd64 ([spike 01](spikes/01-forge-f0-oracle.md)) | amd64 emulated. wasm32 matched only locally, with a `Cargo.toml` change not in the tree; the wasm32 CI job fails. Windows never run |
| Proven intersections | 4,800 analytic pairs: Forge 0 wrong, OCCT 3.6% wrong; all interval-verified ([spike 03](spikes/03-ssi.md)) | Synthetic pairs; no B-spline intersections yet |
| Oracle agreement | Extrude/revolve 6,008/6,008, 0 silent-wrong. Booleans, 2,800 adjudicated cases: Forge 0 wrong and 12 explicit errors (0.43%); OCCT 96 wrong (11 invalid results, 85 metric errors); literal SPEC match 82.1%, pending the seam normalization | A later degenerate-loop regression is open. The real boolean gate (DeepCAD replays, the W7b corpus) has not run. Separately, BACKLOG's 85 potential silent-wrong rows on v1 seed 47, attributed to OCCT seam artifacts, are not closed |
| Explainable failures, checked agent loop | Error codes and checks L0–L3 built | Feasible ranges arrive with F2; barely measured live |
| Works offline | Kernel, modeling, checks, history and export run fully offline ([ADR 0010](adr/0010-local-first.md)), a real edge over Zoo's online kernel | The AI runs on the plan the user already pays for, at no cost to us ([ADR 0014](adr/0014-cli-agents-as-providers.md)); the vendor's servers, plan limits and terms apply. Offline AI needs a local model, and its accuracy is unmeasured. Only Claude Code has been tested live |

**Not moats:** on-device modeling (Shapr3D runs Parasolid locally), query-based references (Onshape FeatureScript stores picks as queries), exact solids and meshes in one model (Parasolid has it).

### Where we must earn it

- **The long tail.** Parasolid's robustness came from decades of customer models. Intelligence does not replace seeing cases. Variable blends, fillets meeting fillets and self-intersecting offsets are unstarted.
- **Shipping.** Zoo and Adam ship agents today; our open alpha is ~May 2027. CADZero works end to end today, and an OCCT-based rival with measurement checks could cover most maker needs within weeks ([cadzero.md](research/competitors/cadzero.md)).
- **Feel.** Shapr3D sets the bar and we have no manipulators yet.

**The verification machine at scale** is how we close the long tail:
- **Today:** 200 generated programs per push, Linux only. 1,000 a week on a weekly schedule, cut from nightly for private-repo cost; it has not run yet. The three-OS matrix runs only on demand.
- **PROPOSED growth:** the weekly suite green by M3, 10k cases a night by M4, 100k by M10. This needs the compute line in §8. Datasets (DeepCAD, Fusion 360 Gallery, ABC) come in only after their licences are recorded; none is used yet.
- **Definition-based oracles** check a fillet against the rolling ball that defines it, because OCCT is weakest on fillets, shells and offsets.
- **A sketch-and-extrude Parasolid proxy.** DeepCAD's parts come from Onshape via ABC, so Parasolid built them. "Rebuild" means Forge's result matches ABC's Parasolid geometry within SPEC tolerances. FORGE.md's F1 gate already requires ≥99.5% oracle agreement on DeepCAD replays; this adds the Parasolid comparison on the same parts. DeepCAD has no fillets, shells or offsets, so we make no parity claim there until a proxy for them exists (definition-based oracles, the defillet bet below, and fillet-bearing Onshape parts if terms allow).
- **The failure zoo.** Every failure shrinks to a minimal repro kept forever. Agents grind it on the development plan and the runner above; round-the-clock grinding needs the compute line and BACKLOG's wall-time cap first. Tolerances, SPEC and tests stay protected from agent edits.
- **Defillet-and-rebuild** on ABC parts is a **bet** that could turn real parts into fillet tests.

### Honest timeline

Gates and thresholds are in §7; this table says what each point proves.

| When | What we aim to prove | Proof |
|---|---|---|
| Closed alpha, ~M7 (Apr 2027) | Common maker parts without drawing | The F2 gate as FORGE.md defines it (Planned) |
| Open alpha, ~M8 (May 2027) | We publish our numbers first | Public MakerBench subset, kernel dashboard, first head-to-head table (PROPOSED) |
| Phase 1 exit, ~M10 (Jul 2027) | We lead on the maker loop, where the numbers show it | NHL, fit and bench gates, and a head-to-head margin (all PROPOSED) |
| v1.0, ~M15 (Dec 2027) | Assemblies; others implement our IR | Assemblies with mates and BOM (Planned, Phase 2). Conformance runner; one third-party implementation (**bet**); ≥5k failure-zoo cases |
| 2028 | Pro engineering and CNC | Drawings (Planned, Phase 3). Our own CAM under simulation gates (PROPOSED). NHL T2 ≥85% and T3 ≥60% (**bets**) |
| 2029–2031 (**bet**) | Parasolid-class robustness on blends, offsets and industrial STEP | F3 (M8–M14) ships general and variable blends and NURBS offsets for common cases. The bet is that cases at scale make them robust on real models. Proof: ≥99% match to Parasolid's recorded output on a blend and offset proxy of ≥10k real parts, and ≥99% of an industrial STEP corpus read, both with 0 silent-wrong |

### Competitor snapshot (as of 2026-09-24)

The drafting agents checked these sources on 2026-09-24; they are not re-checked here. "Unverified" means memory, a search snippet or a blocked page.

| Product | What it ships | Our edge | Source |
|---|---|---|---|
| Parasolid | The robustness benchmark; kernel of Onshape, Shapr3D, Plasticity | Openness, provenance, explanations | [RESEARCH.md](RESEARCH.md) |
| Onshape | AI Advisor, a help tool (Oct 2025). A FeatureScript MCP ([RESEARCH.md](RESEARCH.md)). Agents in Onshape Labs (2026, unverified) | Local kernel and checks; an agent whose every edit Forge checks | develop3d.com; ptc.com (403) |
| Shapr3D | Best push/pull; every direct move is a history step since v5.590. AI: help chatbot and renders; no modeling agent found | Their feel plus an agent | support.shapr3d.com |
| Fusion | AutoConstrain since Jan 2025; a Fusion MCP ([RESEARCH.md](RESEARCH.md)); agentic Assistant previewed 2026-09-15 for 2027 | Auto-constrain is table stakes | autodesk.com; adsknews.autodesk.com |
| Zoo | Own closed B-rep engine; internet needed to model; KCL. Zookeeper agent (Jan 2026, snippet) with design reviews; image/PDF/STEP input (Mar 2026); metered MCP/API | Offline kernel and checks, open kernel, checked ghosts. (Our AI still needs the vendor's servers unless you run a local model) | zoo.dev/docs/faq; zoo.dev/blog/whats-new-mar-2026 |
| Adam | Copilot in Onshape and Fusion: prompt edits, tree cleanup, BOM, RFQ. A launch dated 2026-07-01 (snippet; which product is unverified); $4.1M seed (third-party); SolidWorks (unverified) | Host APIs lack provenance, feasible ranges, proven checks | adam.new/copilot; onshape.com |
| CADAM | Adam's open-source tool: GPLv3, ~5.2k stars, OpenSCAD in WASM, no STEP, no documented verification | Exact B-rep and checks | github.com/Adam-CAD/CADAM |
| CADZero | Two-week solo prototype: AI writes OpenSCAD or build123d (OCCT); works end to end today; STEP via build123d; no published accuracy | Own exact kernel, naming and checks. It is ahead on usable-now | [cadzero.md](research/competitors/cadzero.md) |
| build123d-plus-checks rivals (a class) | Any team pairing an LLM with build123d/OCCT and measurement checks | Proven intersections, native naming, determinism, once published numbers show them | [cadzero.md](research/competitors/cadzero.md) |
| Plasticity | Fast Parasolid direct modeling; no AI known (unverified) | Speed bar for gestures | cgchannel.com (Apr 2026) |

## 6. What "the new ground truth" means

Others measure themselves against us:
1. **An open IR standard.** Forge and the OCCT oracle already implement its SPEC independently; `corpus/v1/conformance` becomes a public runner.
2. **MakerBench as a public benchmark** with a hidden held-out set. We publish our own failures first. Before we call it tool-neutral, we publish a subset scorable from any tool's STEP. 99 of today's 456 hidden tests depend on our IR or on seam conventions (55 face counts, 25 curve counts, 19 feature-history checks); Forge has no seam edges (ADR 0012) while OCCT and Parasolid split periodic faces. Those checks are seam-normalized or dropped, and each normalization is published.
3. **A public kernel dashboard and failure zoo.**
4. **Published physical results:** first-try fit rates from real prints, not renders; strength once tested.
5. **The Forge RL environment**, a training gym for AI models. If labs train on it, models learn CadScript. It helps rivals too; we accept that.
6. **A UX norm:** nothing is committed, accepted or exported that the kernel has not built and checked, and provisional previews look provisional.

## 7. North-star metrics and gates

**North-star metric: the no-heavy-lifting rate (NHL).**
- **Benchmark NHL:** the share of MakerBench tasks where a scripted user only chats (at most 3 messages), accepts and exports, with zero manual sketch, feature or code edits. The export must pass the hidden tests, its machine profile's process checks, and an independent reader: a model from a different family that reads the exported file against the prompt. NHL allows 3 messages, which is easier than single-shot pass@1, but adds the process checks, the reader and the no-edit rule, which is harder.
- **Product NHL:** the share of exported parts whose session had zero manual geometry operations. Today's policy logs nothing for BYO-key and CLI users (ARCHITECTURE §8, ADRs 0009 and 0010), and every alpha user is one. So it needs ADR 0017 or a recruited alpha study under study consent.

**Companion: first-try physical success (FTPS)**, the share of parts that fit and work on the first attempt. A **Fit Lab** measures it: 30 mating tasks (insert boss, bearing press fit, snap-fit lid, print-in-place hinge, finger-joint box, CNC bearing pocket) on 3 calibrated printers and a diode laser, judged with go/no-go gauges. Gates count prints, not task types: ≥100 prints (each task on several machines, repeated), which gives about ±9 points of 95% uncertainty at 70%. Strength badges need break tests too: at least 10 printed brackets per material, loaded to failure on a scale.

**Sample sizes.** MakerBench has 61 tasks today (34 T1, 14 T2, all IR v0), too few to gate on: with 14 tasks, a 65% result carries about ±25 points. A tier's gate applies only once it has ≥100 tasks (ARCHITECTURE plans 300 by beta), and every result is published with its 95% interval.

| Metric | Today | Gate (all PROPOSED unless noted) |
|---|---|---|
| Benchmark NHL, T1 / T2 | Not measured | T1 ≥50% at open alpha (published, not gating), ≥80% at Phase 1 exit, ≥85% at Phase 2 exit. T2 ≥60% at Phase 1 exit, ≥75% at Phase 2 exit. The existing pass@1 gates (T1 ≥85%, T2 ≥65%) still bind; NHL allows 5 points for its stricter checks. Long run (**bets**): T2 ≥85% and T3 ≥60% by end of 2028 |
| Head-to-head | Not run | At open alpha, run the STEP-scorable MakerBench subset and the Fit Lab on Zoo, Adam, Fusion's Assistant (once available), CADZero and a build123d-plus-checks baseline. Claim "lead" only where PartZero beats the best of them by ≥10 points with non-overlapping 95% intervals. Publish the table |
| Product NHL | Not measurable under current policy | ≥50% of accepted parts by beta, on ≥200 exported parts from ≥20 alpha makers (study consent or ADR 0017) |
| FTPS: Fit Lab / alpha users | Not measured | Fit Lab ≥70% at open alpha (published, not gating), ≥85% at Phase 1 exit (≥100 prints each). Alpha users ≥70% at Phase 1 exit, on ≥100 parts reported with a photo of the go/no-go coupon |
| Silent-wrong results | 0 on the generator corpus; the audit found 2 outside it, now pinned by tests | 0 every release on each named corpus (generator, error corpus, each licensed dataset), reported with corpus size next to the success rate, so failing more cannot game it (Planned) |
| Silent changes to user features | Policy | 0, detected two ways: every agent transaction is diffed against user-authored features at commit, and any change without an approval record fails; MakerBench T4 edit tasks assert unchanged features. Checkpoint restore 100% correct |
| Kernel cases; determinism | 200 per push (Linux); 1,000 a week, scheduled but not yet run. Determinism measured locally on macOS and Linux (amd64 emulated); wasm32 local only and failing in CI; Windows never run | Weekly suite green by M3; 10k a night by M4 and 100k by M10, if the compute line is approved. Per push: Linux and wasm32. macOS and Windows on demand; one full four-target CI run closes FORGE.md's existing F0 gate (all four targets bit-identical) before F1; all four per push once the repo is public or on self-hosted runners |
| Feasible range reported | Not built | By F2, ≥90% of single-parameter out-of-range errors (fillet radius, shell thickness, extrude depth, hole size) on the F2 corpus return a feasible interval |
| Sketch-and-extrude Parasolid proxy | Not measured; no dataset licensed | Reported at F1 next to FORGE.md's existing ≥99.5% DeepCAD oracle gate; not a new gate |
| F3 gate (set now) | "To be set" | On an F3 blend and offset corpus of ≥1,000 cases (definition-based oracles, plus defillet cases if that bet works): Forge's valid-result rate ≥ OCCT's, and 0 silent-wrong |
| Edit → screen, 25 features; sketch drag, 200 entities | 46.9 ms median ([spike 05](spikes/05-renderer.md)); 1.75 ms worst ([spike 04](spikes/04-sketch-solver.md)) | Provisional drag frame ≤16 ms p95; checked result on release ≤150 ms; sketch drag ≤4 ms |
| Tab latency / accepted / undone within 60 s | Not built | ≤300 ms / ≥30% / ≤5%, on ≥2,000 offers in the alpha study group; Tab stays off by default until met |
| Fully constrained sketches | Not measured | ≥70% at beta (deterministic auto-constrain). ROADMAP's ≥85% at Phase 3 stays |
| Calculation golden cases within 1% | None | 100% of ≥150 before the tools ship, ≥300 by beta. These check the arithmetic, not whether a part holds; the break tests above do that |
| Hands-on bench, 10 maker parts | None | Parts chosen by a third party. ≥5 novices on PartZero and ≥3 experts each on Fusion and Shapr3D. Time runs from blank to a checked export, agent latency included. Novice median time ≤ the expert median; novice success ≥80% |

Only the gates in §8 group A bind a phase or milestone; the rest gate their own feature. Every existing gate stays, including T1 ≥85% pass@1 and ≥60% of proposals accepted with at most 2 manual edits.

**How we measure the AI numbers.** Today, NHL runs use the owner's Claude Code plan, shared with development, weekly, on the public subset. A full run can take hours of plan time, since a struggling task burns about 10 minutes (BACKLOG). The model-agnostic leaderboard (ADR 0009) also needs non-Claude runs: Codex or Gemini CLI plans, or a local model. Fallback: if plan runs cannot keep a weekly cadence by open alpha, fund API keys from ARCHITECTURE §8's existing eval budget (about $1–2k a month). That needs ADR 0020, superseding ADR 0014's "no paid keys for now". The BACKLOG wall-time cap comes first either way.

## 8. Proposed roadmap changes

> **PROPOSED — needs owner approval.** Nothing here edits ROADMAP.md, FORGE.md or any ADR. No row may add scope to the F2 gate without the owner's approval, and this proposal adds none. "From" is the current plan; build status is in brackets.

**Group A: new gate items. Each can delay the gate it joins: beta (~M10) unless noted.**

| # | Change | From | To | Cost / risk |
|---|---|---|---|---|
| A1 | Fit Lab; NHL, FTPS and head-to-head gates; hands-on bench (§7) | None | Run and published at open alpha, which can delay it by the time the runs take; gating at Phase 1 exit | The owner's own printer(s) for now; ~$4–6k hardware purchase deferred; 3–5 h/week human printing (the owner); plan time or ADR 0020 |
| A2 | Per-process manufacturability checks in `forge-check`, with per-process MakerBench tests | FORGE.md F0 DFM analyses; ROADMAP Phase 1 FDM checks [not built] | Laser and CNC checks added; per-process tests gate beta | 6–10 AW / wall thickness on exact B-rep is hard |
| A3 | Definition-based fillet oracle: 0 silent-wrong on its corpus | None | Phase 1 exit | M / a new oracle to trust |
| A4 | F3 gate defined now (§7) | FORGE.md: "to be set before F3" | Set now; gates F3, not beta | S / may fail |

**Group B: ships when ready; gates nothing but its own feature.**

| # | Change | From | To | Cost / risk |
|---|---|---|---|---|
| B1 | Push/pull and dimension drag drive parameters, with feasible clamp and provisional preview | Not in ROADMAP | Phase 1 alpha | M / low |
| B2 | Deterministic auto-constrain | Phase 3 (learned model) | Phase 1; learned model stays Phase 3 | M / low |
| B3 | ⌘K on canvas; Tab (5 deterministic proposers) | Chat panel only; absent | Alpha; beta, off by default until its gate is met | M / annoyance |
| B4 | Translucent ghost overlay; checkpoints | BACKLOG P2; undo only | Phase 1 alpha | S / low |
| B5 | Autonomy dial, **ADR 0015** (amends the texts listed in §2) | Per-feature accept only | Phase 1 beta | S / policy |
| B6 | Handbook, 8 calculation tools, closed-form checks | Named in ARCHITECTURE §6, unscheduled [not built] | Phase 1, M3–M5; printed-part SF badges only after break tests | 4–6 AW / wrong data: two sources, golden tests; table copyright: formulas and cited facts only |
| B7 | Design context in the IR, **ADR 0018** (extends ADR 0004 and SPEC-v1) | None | IR v1.1, after Phase C. It has no geometry, so the oracle ignores it | 3–4 AW / schema change |
| B8 | Printer profiles gain measured clearance and a fit coupon; slicer handoff; **ADR 0016** licensing rule: launch user-installed AGPL slicers, never bundle or link them | ROADMAP Phase 1 printer profiles; slicer handoff Phase 2 | Phase 1 alpha | 2–4 AW / slicer CLIs change |
| B9 | Laser and sketch DXF/SVG with kerf and nesting (plasma later) | Phase 3 | Phase 1 beta | 3–4 AW / low |
| B10 | Verification machine as a staffed track, with a compute line: self-hosted runners or a monthly cloud budget, sized from the first runs' wall time | 200 per push; 1,000 a week, not yet run; no datasets | Weekly green by M3; 10k a night by M4; 100k by M10. Licences first | M + compute / licences |
| B11 | Sketch-and-extrude Parasolid proxy, reported | FORGE.md F1 DeepCAD oracle gate (exists) | Reported at F1 beside it | M / ABC and Onshape terms |
| B12 | **ADR 0017:** opt-in anonymous product counts for BYO and CLI users (accepted, exported, manual geometry ops yes/no; never design content) plus minimized kernel failure reports. Amends ADR 0009 and ADR 0010 (Consequences) and ARCHITECTURE §8 | Flywheel off for BYO | Closed alpha | S–M / privacy |
| B13 | Public MakerBench (STEP-scorable subset); IR conformance runner; RL environment | ARCHITECTURE §8: "Later" | M8; M15; M12 | M / may not lead every tier |
| B14 | Analytic sensitivities; search optimizer | F4: FORGE.md says M12–M18, ROADMAP says Phase 5 (M20–M26). The two disagree | Sensitivities by M10; search optimizer Phase 2 | 3–4 AW + M / few parameters only |
| B15 | Local background agents; fab packet; resin checks | Phase 4; Phase 3; none | Phase 2, after the BACKLOG wall-time cap | M + 4–5 AW / plan limits |
| B16 | Local face operations, **ADR 0019** (new feature types; extends ADRs 0004 and 0013; the OCCT oracle must implement them) | Absent | F3, OCCT as oracle | L / long tail |
| B17 | Own 2.5D CAM, posts, simulator, **ADR 0016** "Manufacturing output: own vs hand off". Amends ADR 0000's scope, VISION's "Not in the first year … (Phase 6+)", ROADMAP Phase 3, 5 and 6+ lists, FORGE.md F5 | Phase 6+ (F5) | Phase 3 (M14–M19); M14 is past year one, so "no CAM in the first year" holds | 12–20 AW + a hobby CNC / safety |
| B18 | Funded eval keys, **ADR 0020**, only if plan runs cannot keep a weekly cadence | No paid keys (ADR 0014) | Open alpha | ~$1–2k/month (ARCHITECTURE §8 budget) |

**Load.** Everything landing in Phase 1: A1–A4 and B1–B14 (their Phase 1 parts). Sized rows add 21–32 AW (A2, B6–B9, B14). Unsized rows add roughly 18–33 AW more, if S ≈ 1 AW and M ≈ 2–4 AW. Total: about 40–65 AW. Agents are plentiful. The bottlenecks are physical testing (3–5 h/week), plan or compute for evals, and the owner's review: 6 ADRs at about 2–3 hours each, plus the gates and rows, about 15–25 hours in all (notional).

## 9. Risks, bets and honest caveats

**Named bets**, each with its proof and fallback:
- **CadScript fluency.** The whole promise rests on LLMs writing CadScript precisely. Proof (spike 07): CadScript ≥ build123d minus 5 points, ≥50% of hidden tests, median cost ≤$1. It has not run. Fallback: change the syntax, not the engine (ROADMAP).
- **A learned Tab model:** a measurable lift over the deterministic proposers' accept rate.
- **Defillet-and-rebuild** turning ABC parts into fillet tests: yields a usable fillet corpus.
- **A third-party IR implementation by v1.0.** Likely implementer: the build123d or CadQuery community, as an exporter. Proof: it passes the conformance runner.
- **Long-run NHL and 2029–2031 robustness** (§5, §7).

**Caveats:**
- **Today's evidence is thin.** Live AI accuracy is one Claude Code smoke run: 2 of 3 tasks, 17 of 20 hidden tests. No live model has been scored on MakerBench's 61 tasks. CI on main is red. About 242k lines were agent-written in about 29 hours, with no outside users ([cadzero.md](research/competitors/cadzero.md)).
- **"0 silent-wrong" covers only what we sample.** The audit found H1 and H2, both missed by the sweep.
- **The Cursor analogy has limits.** CAD sequence data is far smaller than code. In 6-DoF placement, LLMs land within 10 mm only 27.9% of the time ([RESEARCH.md](RESEARCH.md); the primary paper is not named there), so solvers do the placing.
- **60 fps is unproven.** An edit takes about 47 ms, roughly 20 fps, hence the provisional drag path (§2).
- **Fits and strength vary by printer, material and slicer.** The claim is "fits on your calibrated printer". FDM strength can vary about 2× with print orientation (from memory, unsourced), hence ranges and break tests.
- **CAM can break tools and hurt people.** Simulation and acknowledgment are mandatory; start with 2.5D on hobby routers.
- **Plan limits.** The user's CLI plan is shared with their own use, and a struggling task burns about 10 minutes of it (BACKLOG).
- **Time.** An incumbent could ship a modeling agent at any time.
- **Overclaims we will not make:** "decades ahead"; "never lies" as a present fact; "we lead" without a published head-to-head table; "better than Parasolid" without a named corpus and number; "no CAD skills needed"; "engineering-certified"; "CNC-safe"; "works on any STEP"; "bit-identical everywhere"; "differentiable" (not built); "offline AI" unless the user runs a local model; "0 silent-wrong" without naming the corpus.

## 10. Evidence

**Repo (read 2026-09-24):**
- [VISION.md](VISION.md), [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md) §6–9, [AGENT-IN-APP.md](AGENT-IN-APP.md), [FORGE.md](FORGE.md) (milestones), [BACKLOG.md](BACKLOG.md), [RESEARCH.md](RESEARCH.md), [IR-V1-IMPLEMENTATION-PLAN.md](IR-V1-IMPLEMENTATION-PLAN.md) (W6 feasible ranges), [research/competitors/cadzero.md](research/competitors/cadzero.md)
- ADRs [0000](adr/0000-own-the-core.md), [0001](adr/0001-open-core-licensing.md), [0009](adr/0009-model-agnostic-llm-gateway.md), [0010](adr/0010-local-first.md), [0014](adr/0014-cli-agents-as-providers.md); also 0004, 0012, 0013 and the [ADR README](adr/README.md) rules
- Spikes [01](spikes/01-forge-f0-oracle.md) (wasm32 note), [02](spikes/02-naming.md), [03](spikes/03-ssi.md) (boolean differential), [04](spikes/04-sketch-solver.md), [05](spikes/05-renderer.md), [06](spikes/06-cadscript-roundtrip.md), [07](spikes/07-agent-vertical-slice.md) (bake-off pending), [08](spikes/08-eval-harness.md) (61 tasks, 456 hidden tests)
- [audits/2026-09-23-phase0-audit.md](audits/2026-09-23-phase0-audit.md) (H1, H2) and `forge/crates/forge-check/tests/singular_lines.rs`
- `forge/crates/forge-ir/src/v1/holes_table.rs` (with its noted exceptions); `forge/crates/forge-io/src/step.rs` (placeholder); `forge/crates/forge-check/src/` (no DFM yet)
- `corpus/makerbench/*.task.json` (45 FDM, 6 laser, 4 CNC, 6 any); `corpus/EXTERNAL_SOURCES.md` (no dataset yet)
- `.github/workflows/nightly.yml` (1,000 programs a week, weekly for cost; no run yet); `.github/workflows/ci.yml` (200 programs per push, Linux only; three-OS matrix on demand); CI run 35980456848 (wasm32 job failed)

**Web (accessed 2026-09-24 by the drafting agents):**
- support.shapr3d.com/hc/en-us/articles/13444210101788 and /20520096011164
- autodesk.com/products/fusion-360/blog/autoconstrain-for-fusion-is-here/; adsknews.autodesk.com/en/pressrelease/autodesk-advances-agentic-ai-in-its-three-industry-clouds
- develop3d.com/cad/onshape-release-ai-advisor-for-real-time-guidance/; ptc.com/en/news/2026/onshapelabs (403)
- zoo.dev/docs/faq; zoo.dev/blog/whats-new-mar-2026; zoo.dev/docs/zoo-design-studio/zookeeper
- adam.new/copilot; onshape.com/en/blog/adam-ai-app-store-cad-co-pilot; producthunt.com/products/adam-cad-copilot; thefuturismtoday.com (funding); github.com/Adam-CAD/CADAM
- cgchannel.com/2026/04/plasticity-2026-1-is-out/
- orcaslicer.com/wiki/cli/cli_mode (AGPL-3.0); github.com/GridSpace/grid-apps (Kiri:Moto, MIT)

## Appendix: how this draft came together

It merges three independent drafts (hands-on UX with the agent, intent to machine, beyond Parasolid) and one review round. Resolved: provisional ADR numbers (0015 dial, 0016 manufacturing output, 0017 telemetry and failure reports, 0018 design context, 0019 local face operations, 0020 funded eval keys); feasible ranges were already in F2 (Phase C W6), so only sensitivities move; search optimizer in Phase 2, replaced by gradients at F4; Adam on SolidWorks came from one draft only, so it stays unverified.
