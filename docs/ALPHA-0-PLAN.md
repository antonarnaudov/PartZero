# Alpha 0 build plan

- **Status:** Plan, 2026-09-25, revised the same day after a review. Nothing in it is built yet.
- **For:** the owner, and the coding agents who build Alpha 0 once IR v1 Phase C lands.
- **Sources:** three read-only surveys from 2026-09-24 (the in-app golden path, packaging, and the printer, export and Bambu handoff), [ROADMAP.md](ROADMAP.md), [AGENT-IN-APP.md](AGENT-IN-APP.md), [BACKLOG.md](BACKLOG.md), [SPEC-v1-DRAFT.md](../forge/crates/forge-ir/SPEC-v1-DRAFT.md), and ADRs [0014](adr/0014-cli-agents-as-providers.md)–[0017](adr/0017-opt-in-product-counts-and-failure-reports.md).

**What Alpha 0 is.** A private **PartZero.app**, ad-hoc signed only (no Apple certificate), built on this Mac (macOS 27, arm64) for this Mac. It runs the design agent through the Claude Code you are already logged into. It builds parametric IR v1 parts that Forge checks, then hands a 3MF to your installed Bambu Studio for the P2S.

It's a hands-on build, not a release: no signing, no updates, no telemetry. The only data that leaves the Mac is what Claude Code sends to Anthropic under your plan (your prompts and the design).

It comes in **two drops** (§3.1). **0.1** gets you to a first print: the golden path, five starter parts, and Open in Bambu Studio. **0.2** adds the Fit Lab, the material library and Report Issue.

**How to read the tags**

| Tag | Meaning |
|---|---|
| **[C]** | Needs Phase C: holes, patterns, fillet, chamfer, shell, booleans in the command layer, v1 playbooks and `maxWallMs`. We assume it lands as scoped in [IR-V1-IMPLEMENTATION-PLAN.md](IR-V1-IMPLEMENTATION-PLAN.md) W5–W11 [as17]. Its limits are in §2.4. |
| **[asN]** | An assumption. §6 lists how we check each one and what happens if it's wrong. (They're named "as" so they don't clash with NORTH-STAR rows A1–A4.) |
| **(0.2)** | Arrives in drop 0.2. Everything else is in 0.1. |
| **S / M / L** | Size: S ≤ 1 agent-day, M = 2–4, L = 5–10 [as1]. |

---

## 1. What you get

### 1.1 The golden path, in your words

| # | I do | I see |
|---|---|---|
| 1 | Open PartZero from Applications. (First time only: see §4.2.) | An empty workspace and a welcome card. |
| 2 | Nothing. There's no setup. | The card says "Using Claude Code (your plan) · ready", with its version and model, "Printer: Bambu Lab P2S · 0.4 mm · PLA", and the PartZero version and commit. If Claude Code needs a login, the card shows the exact command to run and a **Re-check** button. |
| 3 | Click one of the 5 example chips, or type something like "a knob for a 6 mm D-shaft pot, 30 mm across". | The agent may ask 1–2 questions, each with a default. A checklist shows its progress, and the plan usage shows next to it. |
| 4 | Wait a few minutes. There's a hard stop at 6 minutes [as2]. | A proposal: the part in the viewport and a list of the features I asked for, each built and checked by Forge. If the agent stops early, it says why and offers its best checked state. |
| 5 | Click **Accept**. | The part lands as one undo step, and ⌘Z takes it back. |
| 6 | Open **Parameters** and change `diameter` from 30 to 35. Or edit the CadScript directly if I want. | It rebuilds in about a second, with no AI call. A value that won't build is refused, with the reason. |
| 7 | (0.2) Pick a material in the toolbar, e.g. PETG. | New runs and the export receipt use PETG and its clearances. The open part doesn't change: I edit its `clearance_*` values in Parameters if I want. |
| 8 | Click **Open in Bambu Studio**. | PartZero checks that the part fits the P2S bed with a 10 mm margin. It writes `~/PartZero/Prints/knob-1a2b3c4d.3mf` with a receipt next to it, and Bambu Studio opens with the part centred on the plate. |
| 9 | In Bambu Studio: accept "load geometry only" if it asks, pick the P2S and my filament, slice and print. | My normal Bambu workflow. PartZero is out of the loop from here. |
| 10 | (0.2) Once per material: print the Fit Lab coupon and tap three numbers. | From then on, new parts in that material use my measured clearances. |
| 11 | (0.2) If something goes wrong: **Help → Report Issue**. | A folder in `~/PartZero/Reports`, shown in Finder, with the design, the logs and a screenshot. Nothing is uploaded. |

### 1.2 Not in Alpha 0

| Not in Alpha 0 | What you get instead, or when it comes |
|---|---|
| A signed, notarized build; auto-update; Windows, Linux or Intel Macs; a DMG | A local arm64 build, ad-hoc signed only, installed by a script (§4.2). Signing needs an Apple Developer account (your decision, D5) and a native MCP relay (W1). |
| Any telemetry: ADR 0017 counts or failure reports | None ships. ADR 0017's opt-in arrives for the closed alpha. |
| API keys, Gemini, Codex or Ollama as tested paths | API-key entry is hidden in the alpha build. The other CLIs work as they do today, but acceptance tests Claude Code only. |
| v0 documents | Alpha 0 is v1-only. A v0 file is refused with a plain message. |
| Crash-recovery snapshots | BACKLOG. The existing "Discard unsaved changes?" prompt on close stays. |
| Picking faces in the viewport to reference them in chat | A stretch goal (W4d). The golden path doesn't need it. |
| The autonomy dial, checkpoints, the ghost overlay, ⌘K on the canvas, Tab, push/pull, a sketcher UI | Phase 1 alpha and beta ([ROADMAP](ROADMAP.md)). Today there's per-feature accept, and undo. |
| Engineering calculation tools (`fit`, `fastener`, `print_clearance`, …) | M3–M5 |
| FDM checks: overhangs, thin walls, orientation (row A2) | Beta. Alpha 0 has one check, bed fit, and one rule: parts are modelled in their print orientation (W4g). |
| The design-context block (IR v1.1) | Clearances are stored as ordinary parameters (`clearance_slip`, `clearance_press`, `clearance_press_metal`). |
| Draft angles, sweeps, lofts, text emboss, modelled threads | Later. `draft` is refused by Forge. |
| Assemblies; importing STL, 3MF or STEP; STEP export | Phase 1–2 |
| OrcaSlicer or PrusaSlicer handoff; slicing without the Bambu window; sending to the printer; AMS colours or multi-material | Bambu Studio only. You slice, assign filament and send from Bambu Studio. |
| A gallery beyond the 5 starters and the coupon; the 61 v0 MakerBench parts | Later. The MakerBench parts stay in the repo for evals, hidden in the app. |
| Fit Lab gates, break tests, strength badges, horizontal holes | Fit Lab v0 is one coupon for vertical holes. |
| Cloud, sharing, accounts | Phase 4 |

---

## 2. Acceptance test

Three gates. Each drop needs its G1 and G2 rows to pass on its hand-over commit. Every failure is either fixed or listed as a known issue that you accept.

| Gate | Who runs it | When | What it blocks |
|---|---|---|---|
| **G1 Automated** | A coding agent | Every Alpha 0 build | The drop |
| **G2a App, automated** | A coding agent: Playwright on the bundled main and worker from the build output, launched by the dev Electron with `AICAD_SIMULATE_PACKAGED=1` and `AICAD_ALLOW_DEBUGGER=1` (pattern: `e2e/packaged.e2e.ts`). Playwright can't attach to the packaged .app itself (`debug-switches.ts`). | Before each drop | The drop |
| **G2b App, from the shell** | A coding agent, Bash only, on the installed app | Before each drop | The drop |
| **G2c App, by hand** | You, about 15 minutes, from a written checklist. Computer use needs you to approve each app live, so an agent can't run this unattended. | At each drop | The drop |
| **G3 Prints** | You | Your first week | "Alpha 0 accepted" |

### 2.1 Preconditions

- **A fresh profile.** Move `~/Library/Application Support/PartZero` aside. Don't delete it.
- **Claude Code logged in.** `claude auth status` reports logged in. Record its version (2.1.260 today).
- **Bambu Studio installed** at `/Applications/BambuStudio.app`. 02.06.00.51 is the tested version.
- **A clean build.** `scripts/alpha0-mac.sh --install` from a clean checkout of the hand-over commit.

### 2.2 G1: automated checks

| # | Check | Passes when |
|---|---|---|
| 1 | The build script (W1) | `codesign --verify --deep --strict` passes; the fuses are exactly the ones the alpha config sets (cookie encryption off). |
| 2 | `PartZero --self-test` (W1) | Its JSON reports: the app version and commit; the `aicad` version; the worker is ready; the forge-web WASM loads; the prompts are found; a v1 engine is available; the MCP shim answers through the broker (the path runtime mode uses); the renderer evaluates the starting document, whatever it is; Claude Code is found, logged in, with its lockdown level; Bambu Studio is found, with its version. |
| 3 | Repo gates | `cargo test --workspace`, clippy and `pnpm -r test` are clean. |
| 4 | Reference solutions: the 5 starter parts and the coupon (`corpus/alpha0/`) [C] | Every model check in §2.4–2.5 passes on Forge, and `uv run oracle diff` shows no unexplained differences. |
| 5 | Live agent runs: the 5 starter prompts through `aicad-agent --ir v1` with Claude Code, twice each [C]. Run for each change to the agent or its prompts, not for each build, and outside the builder agents' 5-hour windows. This is also W4f. | **Floor:** each starter passes its model checks within 2 attempts, or it is swapped [as3]. **Recorded, not gated:** first-attempt pass, time-to-proposal, notional cost, plan-window %, stop reason. P4's spec must include a blind-bore test in every run (W4h). |
| 6 | The 3MF of each part | Centred on (128, 128) with z-min = 0, inside the bed less 10 mm per side; units mm; one object per body; `Application = PartZero <ver>`; on every hole wall the mesh vertices lie within 1e-6 mm of the exact radius, and every chord's sagitta is ≤ the chordal tolerance (0.01 mm); file ≤ 20 MB [as15]. |
| 7 | (0.2) No telemetry (W9) | The static test passes. |
| 8 | Headless slice, test tooling only, if Bambu Studio's command line allows it [as22] | Each 3MF loads and slices with the P2S preset and has the expected object count. Advisory under ADR 0016 §2: never in the receipt, never shipped, never a PartZero check. |

### 2.3 G2: the packaged app

**G2a (agent, automated)**

| # | Do | Passes when |
|---|---|---|
| a1 | Launch with a fresh profile and wait 5 s; repeat with the fake `claude` in its log-in-needed and not-installed states. | The welcome card shows Claude Code as ready with its version and model, P2S · PLA, and the app version and commit. The document is empty, and 5 example chips are shown. Each not-ready state shows its exact fix and **Re-check**. |
| a2 | Open Settings (⌘,). | It says "Using Claude Code (detected)". There's no API-key entry, and no wording anywhere says a key is needed. |
| a3 | Live, with the real `claude`: P2 and P4 from their chips. For each: accept; change one parameter; **Open in Bambu Studio** (fake `open`). | A verified proposal within the cap. The parameter edit rebuilds with no AI call. `open` receives `~/PartZero/Prints/<doc>-<hash8>.3mf`, with the receipt beside it. |
| a4 | P1, P3 and P5: **Open** the reference solution; change one parameter (P1: `cells_x` = 3); **Open in Bambu Studio** (fake `open`). | As a3, without an agent run. |
| a5 | Start a run, then press Stop. | It says "Stopped" within 8 s and offers the best checked state. |
| a6 | Set "Stop a task after" to 1 minute and send a T2 prompt. | It stops with `wall_time`, a plain message and the best checked state. |
| a7 | In Settings, point Claude Code at a path that doesn't exist, then set it back. | A clear "not installed" message with its fix and **Open Settings**. After Re-check, it's ready again. |
| a8 | Point the slicer path at a path that doesn't exist, then click **Open in Bambu Studio**. | It falls back to a plain export with **Show in Finder**. |
| a9 | Undo and redo across an accept, a parameter edit and a code edit. | One stack, in order. |
| a10 | Save, quit and reopen. Then open a v0 `.cad.ts` file. | Parameters are kept. The v0 file is refused with a plain message. |
| a11 | (0.2) Enter Fit Lab readings (§2.5). | They're saved, and a new P4 run's `bore_clearance` default and machine line use the metal value, or the derived one when no metal reading was entered. |
| a12 | (0.2) **Help → Report Issue** (§5). | The folder holds the listed files and opens in Finder. |

**G2b (agent, Bash only)**
- `codesign -dv` and a fuse read of `/Applications/PartZero.app` match the alpha config. (`alpha0-mac.sh --install` runs this one and lists the rest; G2b stays open until an agent runs them on the installed app.)
- After a5's Stop, `ps` shows no `claude` process left from PartZero.
- Mid-run, `kill` the agent worker's process. The G2a run shows "The agent process stopped; your document is safe", and the next run works.
- `lsof -nP -i`, on the installed app while idle and on the G2a app during a live run: no outbound connection from PartZero's own processes (only the `claude` child connects out).

**G2c (you, about 15 minutes)**
1. Double-click PartZero in `/Applications` in Finder. It opens with no "damaged" dialog [as9, as19]. If Gatekeeper blocks it, use **Open Anyway** (§4.2). That's a security setting only you change.
2. Note any keychain or privacy prompt. None is expected [as10, as16]. One that names PartZero and a folder your shell's startup files touch would come from the login-shell lookup, which the Alpha 0 build runs for Claude Code only, and only when it is not in a known install folder.
3. The welcome card shows Claude Code as ready (Gemini may or may not show [as23]).
4. Open a starter, then **Open in Bambu Studio**. Write down each dialog Bambu Studio shows.
5. Pick the P2S and PLA and slice. Write down the time estimate. That sets your print budget (§4.2).

### 2.4 The five starter parts

Every part must be built as **one valid body per printed part**, fit the P2S bed with a 10 mm margin, and be **modelled as it prints**: Z is the build direction and the face on the bed is at z = 0 (W4g). "Closed form" means a volume the test script computes exactly from the dimensions. Before W6 writes the references, your day-0 measurements (§4.2) replace the P4 and P5 numbers where they differ.

**Phase C limits the starters respect** [as17] (SPEC-v1-DRAFT §5.5, §6.6–6.10):
- A pattern's feature seeds must be `extrude`, `revolve` or `hole` features (body seeds copy whole bodies). P1 patterns an extrude and P4 an extrude cut.
- Fillets and chamfers work only on edges between plane, cylinder, cone, sphere and torus faces.
- `draft` is refused.
- Edge references are queries with `card: some` (the default), never an integer: an integer raises `REF_CARDINALITY` when a parameter changes the edge count (SPEC §5.5). This goes in the reference solutions and the playbook.

**P1: Storage bin with dividers** [C] (shell, linear pattern of an extrude seed, join, chamfer)
- **Prompt:** "A desk storage bin with 2 compartments in a row, 40 mm per compartment: 80 × 40 mm outside and 30 mm tall, 4 mm rounded vertical corners, 1.2 mm walls and floor, open top. A 1.2 mm divider every 40 mm, 5 mm lower than the rim, and a 0.4 mm chamfer on the outside bottom edge. Make the compartment count a parameter."
- **Expected features:**
  - parameters `cells_x` (≥ 2), `pitch`, `height`, `wall`;
  - a rounded rectangle, extruded, then shelled with the top removed;
  - one divider, extruded and joined (overlapping the walls and floor, so the join has no coincident faces), then a linear pattern of it × (`cells_x` − 1) at `pitch`;
  - the chamfer, its edges from a query (`card: some`).
- **Orientation:** the bottom on the bed at z = 0, open top up.
- **Model pass:** valid; 1 body; bbox 80 × 40 × 30 ±0.1; volume = closed form ±1%. Setting `cells_x` = 3 rebuilds with no AI call: 120 mm long, 2 dividers.
- **Print check (PLA):** prints with no supports, and the dividers stand straight.

**P2: Phone stand** (a vague prompt: tests clarifying questions and assumptions)
- **Prompt:** "Make me a phone stand for my desk that holds my phone at about 65° so I can watch videos, with a gap for the charging cable."
- **Expected features:**
  - 0–2 clarifying questions, each with a default (e.g. phone thickness with case, 12 mm);
  - parameters `angle`, `slot`, `width`;
  - a side profile, extruded;
  - a cable notch cut through the lip;
  - fillets on the lip.
- **Orientation:** on its side: the profile is sketched on XY and extruded `width` along Z.
- **Model pass:**
  - valid; 1 body;
  - profile depth ≥ 70 mm along X, height 70–140 mm along Y, `width` ≥ 60 mm along Z;
  - `slot` ≥ 12 mm; `angle` 60–70°;
  - a notch ≥ 12 mm wide;
  - every stated assumption is a parameter.
- **Print check (PLA):** prints with no supports. It holds your phone, doesn't tip when tapped, and the cable fits the notch.

**P3: Screw-on cable clip** [C] (countersunk hole, cut)
- **Prompt:** "A screw-on cable clip for a 6 mm cable: a C-shaped ring with 6 mm inside diameter and 1.6 mm wall, centre 6 mm above the bottom, with a 4.5 mm gap at the top so the cable snaps in. It sits at one end of a 26 × 10 × 3 mm foot, flush with the end, and the other end has one countersunk hole for an M3 flat-head screw. 10 mm wide."
- **Expected features:**
  - parameters `cable_d`, `wall`, `gap`;
  - the ring and the foot as one extruded profile, with the gap cut;
  - a `hole` feature: through, M3, countersink `iso10642`.
- **Orientation:** upright: the profile is sketched on XZ and extruded 10 mm along Y; the foot's underside is at z = 0; the hole's axis is Z, with the countersink on top.
- **Model pass:**
  - valid; 1 body; bbox 26 (X) × 10 (Y) ±0.1 and 9.8–10.6 mm tall (the exact height depends on how the gap is cut);
  - one conical countersink face, seat Ø 6.94 ±0.05 at 90° (the `iso10642` preset: DIN 74 Form F, SPEC §6.5, `ir-v1.constants.json`);
  - an ISO 10642 M3 head (dk 5.54–6.72) placed in the seat has its top 0.1–0.7 mm below the surface;
  - the hole report lists one M3 countersink.
- **Print check (PETG recommended):** the cable snaps in and stays. An M3 flat-head screw sits just below the surface.

**P4: Knob with a D-shaft bore** [C] (cut, circular pattern, chamfer)
- **Prompt:** "A knob for a potentiometer with a 6 mm D-shaft, 4.5 mm across the flat: 30 mm diameter, 16 mm tall, a D-shaped bore 12 mm deep from the bottom that press-fits the metal shaft, with a 0.4 mm chamfer on the bore's bottom edge, 18 half-round grip grooves 1.5 mm wide around the side running from the bottom to 2 mm below the top, a 1 mm chamfer on the top edge, and a 0.6 mm deep pointer line on top that stops short of the chamfer."
- **Expected features:**
  - parameters `d`, `h`, `grooves`, and `bore_clearance`, which defaults to the material's metal press clearance (`clearance_press_metal`);
  - a cylinder;
  - the D-bore cut 12 mm deep, with a 0.4 mm chamfer on its bed-side edge (line and arc edges): the same elephant's-foot chamfer as the coupon's holes, so the Fit Lab reading carries over;
  - one groove cut, then a circular pattern × 18;
  - the chamfer on the top edge;
  - the pointer cut.
- **Orientation:** the bore opens on the bed at z = 0; the pointer is on top.
- **Model pass:**
  - valid; 1 body; bbox 30 × 30 × 16 ±0.1;
  - the bore is blind: a flat face 12 mm up;
  - bore Ø = 6 + clearance and flat = 4.5 + clearance, both ±0.02;
  - the bore's bed-side chamfer is present (0.4 ±0.02);
  - the top chamfer is one conical face;
  - volume = closed form ±1%.
- **Print check (PLA):** it presses onto your pot [as14] with thumb pressure, doesn't slip on the flat, and doesn't split. If the fit is off, change `bore_clearance` and reprint. That's the tweak-by-hand check.

**P5: Electronics box with a lid** [C] (shell, fillet, cut, two bodies)
- **Prompt:** "A small box with a lid for an ESP32 dev board: inside 60 × 32 mm and 22 mm deep, 2 mm walls and floor, 3 mm rounded vertical corners outside. The lid is a 2 mm plate with a 3 mm deep lip that slides inside the box using my slip clearance; round the lip's outside corners to 1 mm minus half the clearance, so they follow the box's inside corners. Cut a 12 × 7 mm slot for the USB cable in one short wall, 5 mm above the floor. Put the lid next to the box so both print flat."
- **Expected features:**
  - parameters for the inside size, `wall` and `clearance_slip`;
  - the box: extruded, shelled with the top open, the slot cut;
  - the lid: a plate plus the lip, joined, placed beside the box with the lip facing up.
- **Orientation:** the box's floor and the lid's plate on the bed at z = 0; the box opens up and the lip faces up.
- **Model pass:**
  - valid; 2 bodies, not overlapping, ≥ 5 mm apart;
  - box 64 × 36 × 24 ±0.1; lid 64 × 36 × 5 ±0.1;
  - lip outside = (60 − c) × (32 − c) ±0.02, and lip corner radius = 1 − c/2 ±0.02, where c = `clearance_slip`, diametral;
  - **closed-position interference:** the lid, flipped and set on the rim with its lip inside, intersected with the box has volume 0 (a generic check, W0);
  - the slot goes through the wall.
- **Print check (PLA):** the board fits [as13]. The lid slides on by hand and stays on when the box is turned over and shaken lightly. The USB cable plugs in through the slot.

### 2.5 Fit Lab v0 coupon (0.2)

**What it is:** one gallery item, `fitlab-coupon-v0`, parametric v1 [C]. The plate and the pin's flange sit on the bed at z = 0.

| Part | Spec |
|---|---|
| Plate | 96 × 16 × 5 mm, corner radius 3 |
| Holes | One row of 11 through-holes Ø(5.00 + 0.05·i + `offset`), i = 0..10 (clearance 0.00–0.50), 8 mm apart |
| Orientation | A 3 × 2 mm notch in the end next to hole 0. Count from the notch; there are no digits. |
| Elephant's foot | 0.4 mm chamfer on each hole's bed-side edge [C], the same as P4's bore |
| Pin | An extruded Ø10 × 2 mm flange and an extruded Ø5.00 × 10 mm shaft, joined, with a 0.5 mm chamfer on the shaft's top edge. It's not a revolve (BACKLOG P1: revolve profiles touching the axis can fail with `FORGE_UNBOUNDED_DOMAIN`). It sits beside the plate, so the 3MF has 2 objects. |
| Parameters | `pin_d`, `step`, `offset` (shifts the row for a second coupon), `plate_t` |
| Print settings | The filament's default Bambu 0.20 mm process, textured PEI, no supports |

**Reading it (about 3 minutes, in the Fit Lab panel):**
1. Confirm the material. It's prefilled from the last export receipt.
2. **Slip:** push the printed pin in from the top. Tap the lowest hole, counting from the notch, where it slides fully in and turns freely.
3. **Press:** tap the lowest hole where the printed pin seats with firm thumb pressure and stays in when the plate is turned upside down.
4. **Metal press (optional, never required):** if a 5 mm metal rod or drill shank happens to be at hand, repeat step 3 with it. Otherwise `press_metal` is derived from the printed press reading (below), and P4's `bore_clearance` stays an editable parameter you adjust after the first knob.
5. If no hole fits, or every hole does, the app offers a reprint with `offset` shifted by ±0.4.

**What the app computes:** slip = 0.05·iS + offset; press = 0.05·iP + offset; press_metal = 0.05·iM + offset if a metal reading was entered, else press + 0.05 (derived: a metal shaft doesn't compress like a printed pin); running = slip + 0.10, marked as derived. All are diametral and for vertical holes. Slip and press are for a printed pin in a printed hole; press_metal is for a metal shaft in a printed hole.

**Passes when:**
- **G1:** it builds valid as 2 bodies; the holes meet G1 #6; it fits the bed.
- **G2a:** entering readings saves `{v, source: "fitlab", coupon: "fitlab/coupon@0", measured_at, reading}` for each value. A new P4 run's `bore_clearance` defaults to press_metal, and a new P5 run's `clearance_slip` to slip, both in the parameters and in the agent's machine line.
- **G3:** Bambu Studio shows 2 objects. You print it in PLA and PETG and enter the three readings for each.

---

## 3. Workstreams

### 3.1 Overview and order

| ID | Workstream | Size | Needs Phase C? | Depends on |
|---|---|---|---|---|
| W0 | Acceptance harness and references | M | Partly | — |
| W1 | Packaging: PartZero.app | L | Partly (bundles Phase C code) | — |
| W2 | First run and CLI detection | M | No | W1 (naming) |
| W3 | Golden-path UX fixes | M | Partly | W2, W5, W8 |
| W4 | IR v1 in the app | L (×2 agents) | **Yes** | Phase C |
| W5 | Printer profile, materials, Bambu handoff | L | Partly | — |
| W6 | Starter gallery | S | Yes (v1 references) | W4, W5, researched part dimensions (as5, as13, as14) |
| W7 | Fit Lab v0 | M | Partly | W5, W6 |
| W8 | Reliability: wall-time cap, clear errors | M | Partly (`maxWallMs`) | — |
| W9 | No telemetry | S | No | W1 |
| W10 | Report Issue | S | No | W1 (log file) |

**Drops**
- **0.1, first print** (the critical path): W0; W1; W2's minimum (the empty document, the rename, the welcome card with provider status, build identity and the 5 chips, no API-key wording); W4 a, b, c, e, g and h, plus d's proposal diff and accept; W5's 3MF centring, bed fit and **Open in Bambu Studio**, with the built-in P2S profile and PLA defaults; W3's toolbar button; W6's five starters as chips and **Open**; W8. Gates: G1 #1–6 and #8, G2a a1–a10, G2b, G2c.
- **0.2:** W7 (the coupon and the Fit Lab panel), W5's material library and picker, W10, W9's test, and the rest of W2, W3 and W4d. Gates: G1 #7, G2a a11–a12, and G3 in your first week.

**Waves**
1. **Wave 1** starts the day Phase C is committed: W0, W1, W2, W5 (the non-v1 parts), W8, W9, W10.
   - It may start earlier, in separate worktrees, but only by staying out of the files Phase C has open. Those are `packages/app/src/{bootstrap,services,worker-rpc}.ts`, `packages/app/src/{commands,engine}/**`, `packages/agent/**`, `packages/agent-tools/**`, `packages/forge-web/**` and `forge/crates/forge-wasm/**`.
2. **Wave 2** builds on Phase C: W4, W6, W7, and W5's clearance parameters.
3. **Wave 3:** gates, fixes, then each drop.

**Critical path:** Phase C → W4 → W6's five starters → 0.1 → your first print. With 4–5 agents in parallel, 0.1 is about 2 calendar weeks after Phase C lands, and 0.2 about a week later [as18].

### 3.2 Workstream details

**W0: Acceptance harness and references** (M)
- **Do:**
  - Run the 5 starter prompts once in a dev build with Claude Code on v0 today, for the cap (W8) and D3. Record time-to-proposal, notional cost, plan-window %, stop reasons, and completion mode vs runtime mode [as12].
  - Write `corpus/alpha0/`: task JSON plus v1 reference CadScript for P1–P5 and the coupon, in their print orientation, using the evals check DSL.
  - New checks: parameter present; parameter-edit rebuild; closed-position interference (P5); hole-wall radius and sagitta (G1 #6).
  - Write `scripts/alpha0-accept.sh`, which runs G1.
- **Files:** `packages/desktop/e2e/`, `corpus/alpha0/`, `scripts/`, `packages/evals`.
- **Verify:** the baseline table goes into the acceptance report.

**W1: Packaging, PartZero.app for this Mac** (L)
- **Do:**
  - **Bundle** `main.ts` and `agent/worker.ts`: Vite SSR or esbuild, ESM for Node 22, `electron` kept external, all `@aicad/*` packages and the SDKs inlined, plus a `createRequire` banner for `typescript`. Move `@aicad/*` to devDependencies.
  - **Worker assets:** copy `forge_wasm_bg.wasm` next to the worker and replace `import.meta.resolve` (`agent/engine.ts`). Copy `packages/agent/prompts` and pass `promptsDir` explicitly.
  - **Optional modules:** replace the variable-specifier imports in `runner.ts` (the MCP server, `cli-runtime`) with static imports in an `optional-modules.ts`, keeping the test hooks.
  - **Alpha config:** a new `electron-builder.alpha-local.cjs` that spreads the base config: arm64 `dir` target only (no DMG), `identity: "-"`, `hardenedRuntime: false`, `resetAdHocDarwinSignature: true`, productName `PartZero`, and the `enableCookieEncryption` fuse **off** (the base config turns it on; it is the likely source of a "PartZero Safe Storage" keychain prompt). The tested base config stays as it is.
  - **No keychain prompt:** a build flag hides API-key entry, and the key store touches `safeStorage` only when a key file exists (`agent/keys.ts`) [as10]. The keychain prompt needs your login password, which an agent must never enter.
  - **Runtime mode (D1):** the alpha config keeps `runAsNode: true`, the MCP shim is bundled into one file and asar-unpacked, and `exePath` is enabled by a build flag baked into the asar.
  - **A native MCP relay** (`aicad mcp-shim`) is tracked for the first signed build. It's not needed for Alpha 0.
  - **`scripts/alpha0-mac.sh`:** pnpm install → cargo release build of `forge-cli` → package builds → bundle → notices → `electron-builder --dir` → `codesign --verify` → fuses read → `--self-test`. With `--install`, it then quits PartZero, moves `/Applications/PartZero.app` to `/Applications/.PartZero-builds/previous` (for rollback; not named `*.app`, so macOS never lists a second PartZero), `ditto`s the new app into `/Applications`, and reads the installed copy's signature and fuses.
  - **`--self-test`:** a read-only switch that prints JSON (including the app version and commit) and exits.
  - **Log file:** `~/Library/Logs/PartZero/main.log` and `agent.log`, rotated, scrubbed with `scrubKeyLike`.
  - **Third-party notices** for the worker bundle.
- **Files:** `packages/desktop/{package.json, electron-builder.alpha-local.cjs, scripts/bundle.mjs, src/main.ts, src/agent/{engine,runner,setup,keys,optional-modules}.ts}`, `packages/agent/src/prompts.ts`, `scripts/alpha0-mac.sh`.
- **Verify:** G1 #1–2; G2b. `test/hardening.test.ts` still pins the base config, and a new test pins the alpha config.

**W2: First run and CLI detection** (M)
- **Do:**
  - A new document starts **empty** (`BLANK_SOURCE` in `host/templates.ts` today makes a 40×30×10 block).
  - **Welcome card:** the detected provider, model, version and plan status; the printer and material; the 5 starter chips. The not-ready states each show their exact fix and **Re-check**. A version newer than verified shows the existing "static lockdown" note [as11].
  - **Build identity** in the welcome card and About: the app version and commit, the Claude Code version and the model, so reports and receipts map to a build.
  - A provider badge in the chat header (0.2).
  - Remove the wording that says the agent needs API keys (`agent-service.ts` `start()`; `ui-store.ts` `WELCOME_MESSAGE_WEB`).
  - **Rename to PartZero:** `productName`, `appId` (D2), `app.setName`, the window title and the menu. The userData folder becomes `~/Library/Application Support/PartZero`.
  - **Detection hardening:** fall back to `os.userInfo().shell` when `SHELL` is missing (`llm-gateway/src/cli/detect.ts`). Gemini, installed only under nvm, is found only by the login-shell lookup [as23].
- **Verify:** e2e with the fake Claude Code for the ready, log-in-needed and not-installed states (pattern: `providers.e2e.ts`); G2a a1–a2, a7.

**W3: Golden-path UX fixes** (M)
- **Do:**
  - An **Open in Bambu Studio** primary toolbar button, ⌘P [as20]; **Show in Finder** after every export.
  - After accept, open the Parameters panel when the part has parameters.
  - A stop-reason label for every reason, including `wall_time`.
  - Before export, a warning when bodies overlap [C].
  - The designer-model default for simple parts, and the plan-usage budget, set from W0 (D3).
  - Fix the out-of-date "no holes or fillets" texts (`packages/agent/src/cli-main.ts`, `packages/forge-web/src/types.ts`) [C].
- **Files:** `packages/app/src/ui/{Toolbar,ChatPanel,ProposalView}.tsx`, `packages/app/src/commands/commands.ts`.
- **Verify:** app unit tests; G2a a3–a4.

**W4: IR v1 in the app** [C] (L, split across 2 agents)
- **Do:**
  - **(a) Engine.** A forge-web `EngineV1` for Node (forge-web already evaluates v1 and returns `aicad.metrics/1`). `ForgeCliEngineV1` stays as the fallback, always given the packaged `bin`, never its repo-relative default.
  - **(b) Runner.** Pass `ir: "v1"`, `engineV1`, `promptsDir`, `limits`, `process` and `conventions` where the runner builds the Agent (`runner.ts`, around line 802).
  - **(c) Document pipeline, v1 only.** The document store compiles CadScript v1 (`packages/cadscript/src/v1`). A v0 file gets a plain refusal; there's no migration. **One** document store and **one** undo stack: retire the separate `ir.undo` stack.
  - **(d) UI on v1 reports.**
    - The proposal diff on v1 features; accept splices through v1 `applyIrEdit` (0.1).
    - Timeline icons for hole, pattern, fillet, chamfer, shell, boolean and datum.
    - The Problems panel shows v1 error codes with their playbook hints.
    - Monaco loads the v1 type declarations.
    - **Stretch:** selection-to-provenance in the viewport. If it isn't finished, selection chips are off on v1 documents, so the agent never gets a wrong reference.
  - **(e) Parameters panel.**
    - It lists v1 parameters (name, value, unit, expression).
    - An edit becomes `setParam`, spliced into the CadScript, and rebuilds with no LLM call.
    - When a value fails, the error shows the feasible range Forge returns.
    - Assumption chips become editable and bind to parameters.
  - **(f) v1 bench.** Lift the `--ir v1` refusal in `aicad-agent bench` and run P1–P5 twice. This is the same run as G1 #5 [as3]. Plan usage is shared with the builder agents.
  - **(g) Prompt rules.** Join into one body per printed part. Model in print orientation: Z is the build direction and the face on the bed is at z = 0. Reference edges through queries with `card: some`, never an integer count (§2.4).
  - **(h) Spec writer.** One spec test per requested feature (BACKLOG P1: in the knob task it never checked for the blind bore). A spec that leaves a requested feature untested is rewritten before BUILD, so a part can't show "verified" without it.
- **Files:** `packages/desktop/src/agent/{runner,engine}.ts`, `packages/app/src/{services,bootstrap}.ts`, `packages/app/src/doc/**`, `packages/app/src/ui/{Timeline,ProblemsPanel,ProposalView,CodeEditor}.tsx`, `packages/app/src/agent/agent-service.ts`, `packages/agent-tools/src/v1/engine.ts`, `packages/agent/src/cli-main.ts`, `packages/agent/prompts/designer.v2.md` and the spec writer's prompt and schema.
- **Verify:** app and desktop unit tests; an e2e with a scripted v1 transport; G1 #5; G2a a3–a4, a9–a10.

**W5: Printer profile, materials and the Bambu handoff** (L)
- **Do:**
  - **3MF (forge-io, Rust):**
    - a build-item `transform` that centres the bodies on the bed centre with z-min = 0, and error `EXPORT_BED_FIT` when they don't fit inside the bed less a 10 mm margin per side (room for a brim or skirt), or overlap a bed-exclusion zone if the hands-on check finds one;
    - metadata: Title, `Application = PartZero <ver>`, readable object names;
    - print tessellation from the profile (0.01 mm, 0.1 rad) passed through `exportMesh`, via forge-wasm, forge-web and `aicad export`.
    - If Bambu Studio ignores the transform, bake the offset into the vertices instead [as7].
  - **Profile library:** `<userData>/machine-profiles.json`, owned by the main process and written atomically. It holds a built-in `builtin:bambu-p2s-0.4` written from Bambu Lab's public P2S spec sheet [as5], and (0.2) 8 materials with default clearances [as6] (table below) and a printer and material picker in the toolbar. **Don't copy any value or file from Bambu Studio's bundled profiles** (ADR 0016 §3).
  - **Agent context:**
    - the `agent:start` request carries `process: "fdm"` (the field exists; the app never sets it today);
    - add a machine, material and clearance line through `conventions`;
    - designs carry `clearance_slip`, `clearance_press` and `clearance_press_metal` parameters [C];
    - a material change sets the default for new runs and the receipt. Open documents are never changed.
  - **Handoff (ADR 0016 §3):**
    - IPC `slicer:detect`: look in `/Applications`, then `~/Applications`, then by bundle id `com.bambulab.bambu-studio` through LaunchServices, then a path you set; read the version from Info.plist.
    - IPC `slicer:open`: `execFile("/usr/bin/open", ["-b", bundleId, file])` with `shell: false`, a 10 s timeout, and granted paths only [as8].
    - A command, `file.openInSlicer`.
    - Files go to `~/PartZero/Prints` (D4), created on first use, with no folder dialog. It's outside the folders macOS guards, so neither PartZero nor Bambu Studio should prompt [as16].
    - Files are named `<doc>-<hash8>.3mf`, with `<doc>-<hash8>.receipt.json` beside them: profile and version, material, the clearances used, validity, watertightness, body count, bbox, determinism hash, Forge and app versions.
    - No slicer found: a plain export.
  - **ADR 0016 follow-ups:** a handoff note (Bambu Studio: AGPL-3.0, checked 2026-09-24; tested 02.06.00.51; bundle id and `3mf` document type confirmed in its Info.plist; launch method), and a licence check in `scripts/license-check/` that fails if a slicer binary, libslic3r or a slicer's profile library enters the repo or a build.
  - **STL:** warn that multiple bodies merge into one object, and point to 3MF.
  - **Hands-on check, early** [as7, as8, as22]. Record in the handoff note:
    - one body, several bodies and an off-origin part, with Bambu Studio closed and already running;
    - Bambu Studio already running with an unsaved project: is there a save prompt, or is the project replaced?
    - re-exporting a tweaked part while the previous version is open;
    - whether "load geometry only" is a modal dialog or a notice;
    - whether the chosen printer and filament presets survive a geometry-only load;
    - any bed-exclusion zone for the P2S;
    - whether Bambu Studio's command line can load and slice our 3MF headless with the P2S presets (for G1 #8; test tooling only, using the installed app's presets in place).
- **Files:** `forge/crates/forge-io/src/threemf.rs`, `forge/crates/forge-wasm/src/engine.rs`, `forge/crates/forge-cli/src/main.rs`, `packages/forge-web/src/{engine,types}.ts`, `packages/desktop/src/{ipc,main,slicer}.ts` (slicer.ts is new), `packages/app/src/commands/commands.ts`, `scripts/license-check/`.
- **Verify:**
  - **Rust:** unit, golden and property tests (the transform leaves the mesh unchanged; the bytes are deterministic; `EXPORT_BED_FIT` triggers at the usable size + ε). Geometry is unchanged, so the oracle isn't affected.
  - **Desktop:** tests with a fake `open`.
  - G1 #6, #8; G2a a3, a8; G2c 4–5.

Default clearances, stored with `source: "default"`. They are diametral, for a printed pin in a printed hole, both vertical, at 0.20 mm layers [as6]. **Press on metal** (a metal shaft in a printed hole, which P4 uses) starts equal to Press until the Fit Lab measures it.

| Material | Press | Slip | Running | Min wall | Note for the agent |
|---|---|---|---|---|---|
| PLA | 0.05 | 0.20 | 0.30 | 0.8 | Baseline |
| PETG | 0.10 | 0.25 | 0.35 | 0.8 | Oozes; holes close up |
| PLA-CF | 0.05 | 0.25 | 0.35 | 1.0 | Brittle: no thin snap-fits |
| PETG-CF | 0.10 | 0.30 | 0.40 | 1.0 | Dry it before fit prints |
| PLA Glow | 0.05 | 0.25 | 0.35 | 1.2 | Abrasive; thicker walls glow brighter |
| Wood | 0.10 | 0.30 | 0.40 | 1.2 | Features ≥ 1 mm; weak |
| Silk | 0.10 | 0.30 | 0.40 | 0.8 | Not for loads or snap-fits |
| ABS | 0.05 | 0.25 | 0.35 | 1.0 | Warps: fillet large flat corners |

**W6: Starter gallery** [C] (S)
- **Do:**
  - `corpus/gallery/`: the 5 starter parts and (0.2) the Fit Lab coupon, as parametric v1, from `corpus/alpha0/` sized from researched part dimensions (as13, as14).
  - Each card offers **Open** (the finished, parametric part) or **Ask the agent** (sends its prompt).
  - The 5 starter prompts are the welcome chips.
  - The 61 v0 MakerBench references are hidden in the app.
- **Files:** `corpus/gallery/`, `packages/app/src/host/templates.ts` (or a new `gallery.ts`), `packages/app/src/ui/Dialogs.tsx`.
- **Verify:** evals on `corpus/gallery` with the Forge engine and the oracle; an app test that every item loads, builds and fits the P2S bed.

**W7: Fit Lab v0** (M, 0.2)
- **Do:**
  - The coupon as a gallery item (§2.5), v1 [C].
  - **Fit Lab panel:** the reading steps in §2.5; storage in the profile library (history kept, latest wins, the profile version bumps on every save). New runs use the new values. Open documents aren't offered an update: you edit their `clearance_*` in Parameters.
- **Files:** `packages/app/src/ui/FitLab.tsx` (new), `packages/desktop/src/profiles.ts` (new), `corpus/gallery/fitlab-coupon-v0.*`.
- **Verify:** unit tests of the arithmetic, of atomic writes and of the history; G2a a11; G3.

**W8: Reliability** (M)
- **Do:**
  - **Limits.** `maxWallMs` already exists in `packages/agent/src/agent.ts`, so the runner only passes `limits: { maxWallMs, maxFailedApplies: 6 }` through [C] (unverified until Phase C's final verification). `maxWallMs` defaults to 6 min [as2], adjustable in Settings from 1 to 20 min. Today it's unlimited in the app, and BUILD alone may take 20 min.
  - **`wall_time` result.** A `wall_time` stop gets a label plus "Here is the best checked state".
  - **Plain-language messages** for:
    - every stop reason and start code;
    - Forge error codes, reusing the playbook hints;
    - export errors.
  - **Export gate.** Export is refused when the report isn't `ok` or any body is invalid. Nothing unchecked is exported (NORTH-STAR §2).
  - **Verify what already exists:** the `quota_exhausted` message with its reset time, the `WORKER_EXITED` re-fork, the 8 s stop timeout, and the "Discard unsaved changes?" prompt on close (`packages/desktop/src/main.ts`).
  - Crash-recovery snapshots go to BACKLOG under "Alpha 0 follow-ups".
- **Files:** `packages/desktop/src/agent/runner.ts`, `packages/app/src/ui/ChatPanel.tsx`, `packages/app/src/commands/commands.ts`, `packages/desktop/src/agent/settings.ts`.
- **Verify:** unit tests; G2a a5–a8; G2b.

**W9: No telemetry** (S, the test is 0.2)
- **Do:**
  - Ship none of ADR 0017, and no consent screen.
  - **Hardening test:**
    - the bundles contain no `crashReporter.start`, `autoUpdater`, `electron-updater` or analytics SDK;
    - the main process makes no outbound request;
    - the renderer CSP stays `connect-src 'self'`.
  - **In Settings and the README:** the one thing that leaves the Mac is what Claude Code sends to Anthropic under your plan. Claude Code's own telemetry follows your Claude Code settings [as21].
- **Verify:** the test; G2b (`lsof`).

**W10: Report Issue** (S, 0.2): see §5.

---

## 4. Risks, and what you must do

### 4.1 Risks and how we de-risk them

| Risk | How we de-risk it |
|---|---|
| No packaged build has ever run end to end: pnpm symlinks, WASM and prompt paths, variable imports. | W1 goes first. `--self-test` and the build script run on the current app before v1 is wired in. G2a runs the bundled code itself. |
| The fuse flip breaks the ad-hoc signature, so macOS says "damaged" or kills the app. | The alpha config resets the ad-hoc signature, and `codesign --verify` runs in the build script (G1 #1). |
| The golden path has never run live in the app with Claude Code, and its speed is unknown. | The W0 baseline comes first. The cap (W8) stops the ~10-minute struggle, and D3 picks the model from real numbers. |
| v1 agent quality is unmeasured: the bench refuses v1, and MakerBench has no v1 tasks. | G1 #5 (= W4f) on P1–P5, twice each. A part that misses the floor is fixed in its playbook or replaced in the starter set. |
| The agent's spec misses a requested feature, so a part shows "verified" without it (the knob's bore, BACKLOG P1). | W4h: one spec test per requested feature; G1 #5 checks P4's bore test every run. |
| Phase C lands late or with gaps: an unsupported fillet edge type, boolean SSI errors, `draft` refused. | The starters respect the limits in §2.4: no `draft`, only supported blends, and P4's grooves stop below the chamfer. Every reference must pass on Forge. **Plan B:** an "Alpha 0-v0" preview with W1, W2, W5, W8, W9 and W10 on v0, 4 parts (a plain bin, the side-profile phone stand, the stick-on cable clip, and the MakerBench two-body box with lid) and a v0 coupon. No Parameters panel and no D-shaft knob. |
| Claude Code updates itself and its flags drift. | Newer versions still run at "static" lockdown, with tripwires, and the binary-change re-probe already exists (`cli-detect.ts`). `AICAD_LIVE_CLI=claude` smoke tests on every rebuild; Re-check in the app [as11]. |
| Runs share your Claude Code plan with development. | The run card shows the 5-hour and 7-day windows. G1 #5 runs only when the agent or prompts change, outside the builder agents' windows; G2a runs two live starters, not five. D3 considers Sonnet for simple parts. |
| Bambu Studio import details: placement, multi-object prompts, the "geometry only" dialog, a running Bambu Studio with an open project. | W5's early hands-on check [as7, as8]. Fallback: bake the placement into the vertices. |
| First prints don't fit: faceted holes, elephant's foot, default clearances. | Print tessellation, the same bed-side chamfers on the coupon and on P4's bore [C], the Fit Lab's metal reading for P4, and clearance parameters you can edit. |
| `runAsNode` stays on in the local build (D1), which weakens a protection meant for signed apps. | Alpha 0 stores no API keys and is local-only. The native relay (W1) lands before any signed or shared build. |
| Two undo stacks confuse undo. | W4c merges them into one; G2a a9 checks it. |
| Phase C is still editing files that Alpha 0 touches. | Wave 1 stays out of those files (§3.1) or waits until Phase C is committed. |
| Scope creep | §1.2 is the contract. Anything more goes to BACKLOG under "Alpha 0 follow-ups". |

### 4.2 What you must do

| When | What |
|---|---|
| **Nothing to measure** | The starter parts use researched dimensions of standard hardware (§6: as5 P2S, as13 ESP32 boards, as14 6 mm D-shaft pots), each exposed as a parameter. If your part differs, say so in chat ("my board is 69 mm long") and the agent changes the parameter. No calipers, drill bits or reference rods needed. |
| Install, and after each rebuild | Run `scripts/alpha0-mac.sh --install`, or have a coding agent run it. It quits PartZero, keeps the old app in `/Applications/.PartZero-builds` for `--rollback` (hidden, and not listed as an app), and copies the new one into `/Applications`. If macOS refuses to let it quit or move PartZero (Automation, App Management), it names the setting; only you change it. A build made on this Mac isn't quarantined, so it opens directly [as9]. If macOS blocks it anyway: **System Settings → Privacy & Security → Open Anyway**. Only you change that setting. |
| First launch | No keychain or privacy prompt is expected [as10, as16]. If one appears, note it in G2c. A keychain prompt asks for your login password: never give it to an agent. |
| Keep Claude Code logged in | If the card says "Log in needed", run `claude auth login` in Terminal and press **Re-check**. No API keys needed. |
| G2c, at each drop | The 15-minute checklist in §2.3. |
| First **Open in Bambu Studio** | Accept "not from Bambu Lab, load geometry only" if it asks, then pick the P2S and your filament. |
| (0.2) Calibrate fits | Print the Fit Lab coupon in PLA and PETG and enter the three readings for each. Do the other materials when you first use them. |
| G3 | Print P1–P5. Record pass or fail for each print in the checklist in the acceptance report, or tell a Claude Code session. Use **Report Issue** only for failures. |
| Budget your time | Roughly 6–8 h of printing in the first week: P1–P5, 2 coupons and one reprint. The real figures come from Bambu Studio's slice estimates at your first print [as18]. |

### 4.3 Decisions for you

| # | Decision | Recommendation |
|---|---|---|
| D1 | Agent-runtime mode in Alpha 0: keep `runAsNode` on in the local build, or completion mode only | Keep it on for Alpha 0. It's faster and uses less plan [as12]. The native relay comes before any signed build. |
| D2 | Name and bundle id | "PartZero", with `ai.partzero.desktop` as a provisional id. It can change freely until the first signed build, so the domain decision can wait for Alpha 0 feedback. |
| D3 | Designer model for simple parts (Opus or Sonnet), and the plan-usage budget per task (today $1 notional) | Decide from W0's numbers. |
| D4 | Where prints are saved | `~/PartZero/Prints`, outside the folders macOS guards, with no folder dialog. Reports go to `~/PartZero/Reports`. |
| D5 | Apple Developer Program (US$99 a year) | Not needed for Alpha 0. Needed before anyone else installs it. |

---

## 5. How you report bugs (0.2)

**Where you find it:** **Help → Report Issue…** and the command palette ("Report Issue").

**What happens:** PartZero writes a folder, e.g. `~/PartZero/Reports/2026-10-03T14-22-05-knob/`, and shows it in Finder. There's no dialog. To add a photo of a print, drop it into that folder in Finder. **Nothing is uploaded:** Report Issue has no network code (W9 tests this). Use it for failures only; G3 passes go in the acceptance-report checklist.

| File | Contents |
|---|---|
| `report.md` | "What I did / expected / got", prefilled with the time, the document name, the last stop reason and the material |
| `design.cad.ts`, `design.ir.json`, `metrics.json` | The CadScript, the canonical IR and the last Forge report |
| `agent-run.json` | The last run: prompt, phases, tool summaries, stop reason, notional cost, model ids and CLI version. It never contains keys or CLI credentials. |
| `logs/main.log`, `logs/agent.log` | The last 2,000 lines of each, scrubbed with `scrubKeyLike` |
| `screenshot.png` | The PartZero window only (`webContents.capturePage()`), so no screen-recording permission is needed |
| `env.json` | App version and commit, Forge version, macOS version, arch, CLI name, version, model and lockdown level, Bambu Studio version, printer profile and material |
| `print.3mf`, `receipt.json` | The last export, if there is one |

**How it reaches the coding agents:**
- **The easy way:** give the folder path to a Claude Code session in the repo, e.g. "look at ~/PartZero/Reports/…".
- **Through GitHub:** the repo is public, so its issues are public. Attach a design only if you're happy for it to be public.

**Triage (coding agents):**
1. Reproduce with `aicad eval design.ir.json`, or replay the run.
2. Shrink the failure to a minimal case and add it as a failing test or corpus case (the failure zoo).
3. Fix it, then log it in BACKLOG under "Alpha 0 follow-ups".

**Files:** `packages/desktop/src/report-issue.ts` (new), `packages/desktop/src/menu.ts`, `packages/app/src/commands/commands.ts`. **Size:** S. **Verify:** unit tests (file list, scrubbing, no network module imported); G2a a12.

---

## 6. Assumptions

| # | Assumption | How we check it | If it's wrong |
|---|---|---|---|
| as1 | The sizes are notional agent-days. | Track the actual days in W0–W10. | Re-plan the waves. |
| as2 | A 6-minute cap is enough for the starter parts on Claude Code. | W0 baseline. | Raise the cap, or use Sonnet for simple parts (D3). |
| as3 | The v1 agent passes each starter within 2 attempts. First-attempt rates are recorded, not gated: five samples are noise. | G1 #5 (= W4f) | Fix the playbooks and prompts, or swap the part. |
| as4 | Retired: P1 is no longer Gridfinity-style. | — | — |
| as5 | P2S: 256 × 256 × 256 mm build volume, 0.4 mm hardened-steel nozzle as standard, 300 °C nozzle, 110 °C bed. From Bambu Lab's P2S spec page and spec sheet ([specs](https://bambulab.com/en/p2s/specs), [spec sheet](https://store.bblcdn.com/s7/default/2d1a01cd2dca425eb071ccc28c26c9fa/spec.pdf), read 2026-09-25). | The first **Open in Bambu Studio** shows the P2S plate; a part that doesn't fit is flagged there. | Edit the built-in profile. |
| as6 | The default clearances, including press on metal, are starting values, not measurements. | Fit Lab v0 | That's what the Fit Lab is for. |
| as7 | Bambu Studio 02.06.00.51 loads our 3MF as geometry only, honours the build-item transform, imports one object per body, and keeps your printer and filament presets. Whether "load geometry only" is a modal dialog or a notice is unknown. | W5 hands-on check | Bake the placement into the vertices; document the dialogs. |
| as8 | `open -b com.bambulab.bambu-studio <file>` opens the file in a Bambu Studio that's already running, without a second instance. What happens with an unsaved project open, or with the previous version of the part open, is unknown. | W5 hands-on check | Use `-a <path>`, or tell you to save or close the project first. |
| as9 | A build made on this Mac and installed with `ditto` carries no quarantine flag and opens once it's ad-hoc signed. Control-click → Open no longer gets around Gatekeeper (true since macOS 15, assumed for 27). | G2c 1 | You use Open Anyway. |
| as10 | With the cookie-encryption fuse off, API-key entry hidden, and `safeStorage` untouched unless a key file exists, PartZero never asks for the keychain. An ad-hoc signature changes with every rebuild, so any keychain approval or privacy grant would be asked for again. | G2c 2 | You create a free self-signed code-signing identity in Keychain Access (no Apple account needed), and the build script signs with it. The signature then stays stable across rebuilds, and approvals persist. A paid certificate isn't needed for this. |
| as11 | Claude Code updates keep the flags our lockdown needs. A newer version runs at "static" lockdown, with tripwires. | Live smoke test on each rebuild | The app refuses that version and shows why; update the gateway's flags for it. |
| as12 | Runtime mode is faster and uses less plan than completion mode. | W0 | Ship completion mode only (D1). |
| as13 | ESP32 dev boards: the default is the Espressif ESP32-DevKitC V4 (38-pin), 54.4 × 27.9 mm, Micro-USB overhanging the short edge by about 1.2–1.5 mm; 30-pin DevKit-style boards are about 51 × 28 mm; headers add about 8.5 mm below and components about 11.5 mm above the PCB. The P5 cavity (60 × 32 mm inside) fits all of these. The ESP32-S3-DevKitC-1 (69 × 26 mm, USB-C) does not: P5 exposes `board_l`, `board_w`, `usb_w`, `usb_h`. Sources: [Espressif DevKitC V4 guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html), [ElectricalFlux ESP32 dimensions guide](https://electricalflux.com/mcu-general/esp32-dimensions-breadboard-enclosure-guide), read 2026-09-25. | The first P5 print. | Change the parameters in chat. |
| as14 | Pots and encoders with D-shafts: the most common is 6 mm diameter, 4.5 mm across the flat, 15–20 mm long; P4's bore is 12 mm deep, so any shaft ≥ 12 mm works. Sources: [Love My Switches knob guide](https://lovemyswitches.com/news/what-knob-will-fit-on-my-gear/), [Thonk 6 mm D-shaft knobs](https://www.thonk.co.uk/product-category/parts/knobs/6mm-d-shaft/), read 2026-09-25. | The first P4 print. | Change `shaft_d`, `shaft_flat` or `bore_clearance` in chat. |
| as15 | Print tessellation (0.01 mm, 0.1 rad) keeps a starter part's 3MF ≤ 20 MB. | G1 #6 | Scale the chordal tolerance with part size. |
| as16 | `~/PartZero` is outside the folders macOS guards, so neither PartZero writing there nor Bambu Studio reading from there triggers a privacy prompt. | G2c 2 | You allow it once; note it in the handoff note. |
| as17 | Phase C lands as scoped: holes, patterns, fillet, chamfer, shell (not draft), booleans in the command layer, v1 playbooks, `maxWallMs`, with the limits in §2.4. | Its final verification | Plan B (§4.1). |
| as18 | 0.1 about 2 calendar weeks after Phase C with 4–5 parallel agents, 0.2 about a week later; 6–8 h of printing for you in week 1. | W0 and W1 progress; Bambu Studio's slice estimates at your first print | Re-plan. |
| as19 | The packaged Electron app runs on macOS 27 as well as the dev build does today. | G2c 1 | Upgrade Electron. |
| as20 | ⌘P is free for **Open in Bambu Studio**. | Keymap test | Pick another shortcut. |
| as21 | Claude Code's own telemetry is Anthropic's, governed by your Claude Code settings; PartZero doesn't change it. | Documented in W9 | — |
| as22 | Bambu Studio 02.06's command line can load and slice our 3MF headless with the P2S presets. | W5 hands-on check | Skip G1 #8. Sizes come from G1 #6 on the 3MF bytes either way. |
| as23 | A Finder-launched PartZero finds Claude Code (a native binary) through its known install directories. Gemini, installed only under nvm, is found only by the login-shell lookup (`-ilc`, 5 s timeout, a `.zshrc` that loads nvm), so the welcome card may show it inconsistently. | G2c 3 | Claude Code: fix detection in W2, or set the path in Settings. Gemini isn't in acceptance. |
