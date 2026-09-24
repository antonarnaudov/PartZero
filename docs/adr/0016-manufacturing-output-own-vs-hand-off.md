# ADR 0016: Manufacturing output: own vs hand off

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** owner (approved [docs/NORTH-STAR.md](../NORTH-STAR.md))
- **Plan reference:** [NORTH-STAR.md](../NORTH-STAR.md) §4 and §8 rows B8, B9 and B17.
- **Amends:** [ADR 0000](0000-own-the-core.md) (scope), [VISION.md](../VISION.md) non-goals, the phase lists in [ROADMAP.md](../ROADMAP.md), and F5 in [FORGE.md](../FORGE.md). The FORGE.md edit is deferred (see Follow-ups).

## Context

- **The promise ends at the machine.** "Part zero" is the machine's work origin. Today the chain ends at a checked handoff: a file plus its receipt. It reaches the work origin only for CNC, and only once our own CAM ships (NORTH-STAR §4).
- **ADR 0000 never drew the line at the machine.** It says we own "later, SubD, HLR, FEA and CAM". It says nothing about slicers, laser software, machine senders or fab services. Without a rule, an agent could bundle a slicer engine to "own printing", or count a slicer's warnings as our check.
- **The slicers we target are copyleft.** OrcaSlicer is AGPL-3.0 (its CLI page, checked 2026-09-24, NORTH-STAR §10). Bambu Studio and PrusaSlicer come from the same code family. We believe they are AGPL-3.0 too, but that is from memory and not re-checked.
- **Our licence rules forbid shipping them.** [ADR 0001](0001-open-core-licensing.md) and [LICENSING.md](../../LICENSING.md) allow no LGPL/GPL runtime dependency in anything we ship. CI's licence allow lists contain no GPL-family licence, so a linked slicer library would already fail the `licenses` job. A bundled slicer *binary* would not be caught.
- **Makers already have a slicer they trust.** They are used to local tools like slicers ([ADR 0010](0010-local-first.md)). Their slicer holds their printer, filament and process settings.
- **Where we are today** (NORTH-STAR §4 and §10):

  | Item | Status |
  |---|---|
  | 3MF export | Built, mesh only; volume within 0.04–0.3% of exact |
  | STEP export | Planned at F1; the writer is a placeholder today |
  | DFM checks in `forge-check` | None yet. FDM checks and printer profiles are Planned for Phase 1 |
  | MakerBench by process | 61 tasks: 45 FDM, 6 laser, 4 CNC, 6 any process |
  | Slicer handoff; laser DXF/SVG; CAM toolpaths | ROADMAP Phase 2; Phase 3; Phase 6+ (FORGE.md F5) |

- **CAM is not like slicing.** Toolpaths decide the quality of the cut. A wrong one can break a tool or hurt someone (NORTH-STAR §9). Kiri:Moto (MIT, github.com/GridSpace/grid-apps) can serve as an oracle.
- **The owner decided on 2026-09-24:** approve NORTH-STAR §8, including B8, B9 and B17. The Fit Lab runs on the owner's own 3D printer(s), with no hardware purchase now.

## Decision

We will own everything that decides manufacturing quality and hand files to the user's own slicers, laser software, senders and fab services, under the rules below.

### 1. The line: we own what decides quality, and hand files to the rest

| Ours ([ADR 0000](0000-own-the-core.md) applies) | Handed off (tools we give files to) |
|---|---|
| Per-process checks before export: FDM, resin, laser, CNC, sheet metal (in `forge-check`) | Slicers: Bambu Studio, OrcaSlicer, PrusaSlicer, any other |
| Engineering calculations and the sourced handbook (NORTH-STAR §3) | Laser and cutter software: LightBurn, the cutter vendor's own |
| Machine profiles (printer, laser, router), including measured clearance and kerf | Machine senders that stream G-code |
| Our file writers in `forge-io`: 3MF, STL, STEP, DXF, SVG | Online fab services (SendCutSend, OSHCut, JLC) and their checkers |
| Export receipts | Machine shops, which get the fab packet |
| From Phase 3: 2.5D CAM toolpaths, GRBL and LinuxCNC posts, stock-removal simulation, setup sheet | |

A handed-off tool receives our file the way a compiler receives source code. What it does next is its own. We make no claim about its output, and its output never decides ours.

### 2. Handoff rules

1. **Every handoff is an export.** It needs the user's approval (ARCHITECTURE §6: `export` needs approval). Forge has built and checked the file. It carries a **receipt**: checks passed against a named machine profile, validity, proven bounds where Forge has them (math, not an engineering certification), and a determinism hash.
2. **Downstream output is advisory.** We may run the user's own slicer headless on our export to show its time, material and warnings, labelled with the tool's name and version. That output is never a PartZero check, never appears in the receipt, and never blocks or unblocks an export. A fab service's checker is treated the same way.
3. **We launch tools carefully.** A launched tool gets its own process, a fresh temp directory and a timeout. Its output is size-capped, parsed defensively and never executed, as [ADR 0014](0014-cli-agents-as-providers.md) does for CLI agents.
4. **Nothing leaves the device by itself.** Uploading to a fab service is the user's action: manual upload from Phase 1, partnerships M15+ (unchanged). ADR 0010 holds.

### 3. The slicer rule

It applies to every slicer, whatever its licence. Today's targets are AGPL-3.0.

- **We launch the slicer the user installed.** We find it at its usual install path or a path the user sets. We start it as a separate process, through its documented command line or the OS "open with" mechanism, and exchange only files.
- **We never bundle, link or embed a slicer.** No slicer binary, library, WASM build or plugin ships in any PartZero artifact: desktop, web, CLI, iPad or a hosted worker. That includes libslic3r and every fork of it. We never download, install, update or patch a slicer for the user.
- **We never copy slicer code or data.** Our FDM checks, orientation and profiles are written from their definitions, not ported from slicer source. We don't vendor a slicer's bundled printer or filament profiles. We may read the user's own profile files at run time to prefill a printer profile.
- **No hosted slicing** with a copyleft slicer without a new ADR. Where we can't launch a local process (the web build), handoff is a file download.
- **No slicer installed** means export still works. The user opens the file by hand.

### 4. Schedule

| Row | What | From | To |
|---|---|---|---|
| B8 | Printer profiles gain a measured clearance from a fit coupon printed on the user's printer. Slicer handoff under §3: an oriented 3MF opened in the user's Bambu Studio, OrcaSlicer or PrusaSlicer | Printer profiles Phase 1; slicer handoff Phase 2 | Phase 1 alpha |
| B9 | Laser and sketch DXF/SVG (laser, waterjet, vinyl and drag-knife cutters, plotters) with flat-part detection, kerf compensation and simple nesting | Phase 3 | Phase 1 beta |
| B17 | Own 2.5D CAM for hobby routers: toolpaths, GRBL and LinuxCNC posts, stock-removal simulation, setup sheet | Phase 6+ (F5) | Phase 3 (M14–M19) |

- **Unchanged:** multi-material 3MF (later); plasma lead-ins (later); sheet-metal flat patterns (Phase 3); CNC lathe turning toolpaths (Phase 6+); fab-service partnerships (M15+); molding and casting (Phase 5+, not planned yet).
- **Owned by other rows:** the per-process laser and CNC checks that gate beta are row A2. Resin checks and the fab packet move to Phase 2 under row B15.
- **The first year stays CAM-free.** M14 is past year one, so VISION's "Not in the first year: … CAM toolpaths" still holds.

### 5. CAM rules (Phase 3)

- **CAM is ours, in Forge.** It is Rust ([ADR 0002](0002-languages-by-purpose.md)), in a new crate, provisionally `forge-cam`. Every Forge rule applies: determinism, named tolerances, structured errors, and tests plus an oracle case in the same PR.
- **Kiri:Moto is the oracle, in CI only.** Its MIT licence would allow shipping it, but ADR 0000 keeps oracles out of the product. It lives in `oracle/` or a `*/oracle/` directory.
- **No G-code leaves the app without simulation and the user's acknowledgment.** A toolpath whose simulation shows a gouge into the part, a rapid move through stock or a holder collision is an error, not a warning.
- **GRBL and LinuxCNC posts come first.** Each post has golden files. Every other dialect needs its own tests before it ships.
- **Start small.** 2.5D on hobby routers first. Turning and CAM beyond 2.5D stay Phase 6+.
- **Say only what we checked.** We never call a toolpath or part "CNC-safe", "safe" or "certified" (NORTH-STAR §3 and §9). The receipt lists what the simulation checked.
- **Gate.** 0 silent-wrong toolpaths on the CAM corpus: none reported as fine while the oracle or an independent check shows a gouge, a collision, or stock left beyond tolerance. The numbers (corpus size, agreement with Kiri:Moto, physical test cuts) are set before CAM work starts.

### 6. Amendments

ADRs are immutable once accepted ([ADR README](README.md)), so this ADR carries the changes. Each document below gets them. ADR 0000's status line points here, and its dated addendum summarizes the change; its original text stays as written.

| Document | Section | Change |
|---|---|---|
| ADR 0000 | Decision, what we own | Adds per-process checks, engineering calculations, machine profiles and receipts. CAM moves to Phase 3 |
| ADR 0000 | Oracle table | New row: Kiri:Moto (MIT), checks 2.5D CAM toolpaths |
| ADR 0000 | What we reuse | New item: tools the user already has (slicers, laser software, machine senders, fab services) receive our files. None is shipped |
| VISION.md | Non-goals | "Not in the first year: PDM/PLM, CAM toolpaths, iPad and real-time collaboration (Phase 6+)." becomes "Not in the first year: PDM/PLM, CAM toolpaths (Phase 3, from M14), iPad and real-time collaboration (Phase 6+)." |
| VISION.md | Non-goals | New item: "**Not a slicer or machine sender.** We hand files to the user's own slicer, laser software, sender or fab service, and never bundle a slicer (ADR 0016)." |
| ROADMAP.md | Overview | The Phase 6+ theme drops "CAM" |
| ROADMAP.md | Phase 1 | In scope: Export adds DXF/SVG (beta); Printing adds measured clearance, the fit coupon and slicer handoff (alpha). Deferred: "FEA and CAM." becomes "FEA (Phase 5) and CAM (Phase 3)." |
| ROADMAP.md | Phase 2 | Slicer handoff leaves "Output and publishing" (now Phase 1). Deferred: CAM moves to Phase 3 |
| ROADMAP.md | Phase 3 | Laser row: basic DXF/SVG moved to Phase 1 beta. CNC row adds own 2.5D CAM (toolpaths, GRBL and LinuxCNC posts, simulation, setup sheet; Kiri:Moto as CI oracle). Deferred: "CAM toolpaths (Phase 6+)" becomes "turning and CAM beyond 2.5D (Phase 6+)". Exit gates: a CAM row as in §5 |
| ROADMAP.md | Phase 5 | Deferred list drops "CAM toolpaths" |
| ROADMAP.md | Phase 6+ | "2.5D CAM and laser toolpaths" becomes "Turning and CAM beyond 2.5D, our own. Direct laser G-code only if the LightBurn handoff proves too weak." |
| ROADMAP.md | Explicitly reused | Adds "the user's installed slicers, laser software and machine senders, and fab services, as hand-off targets (ADR 0016)" |
| FORGE.md | Milestones F5; crate map | Deferred; see Follow-ups |

## Consequences

- **Positive:**
  - Agents get one line to check a change against: the table in §1.
  - The app stays MPL-2.0 and App Store-compatible, with no AGPL obligations.
  - Makers keep the slicer they have tuned. We don't compete with free, mature slicers.
  - A receipt means one thing: what Forge checked. It does not change with a slicer's version or settings.
  - Laser, vinyl and plotter users get output in Phase 1 instead of Phase 3.
  - CNC reaches part zero in Phase 3 instead of Phase 6+.
- **Negative / costs:**
  - B8 costs 2–4 AW, B9 3–4 AW, B17 12–20 AW plus a hobby CNC. The CNC is bought when CAM work starts. The owner's 2026-09-24 decision buys no hardware now.
  - Slicer CLIs change without notice (NORTH-STAR B8). Each supported slicer and version needs a check. A broken launch falls back to opening the file by hand.
  - We can't see inside the slice. A good 3MF can still slice badly with the user's settings. The receipt covers our checks only.
  - The web build can only download the file.
  - Physical proof stays thin for a while. Clearance values are validated in the Fit Lab on the owner's own printers. Kerf compensation is checked against geometry only until someone has laser access.
  - CAM carries safety risk. Simulation and acknowledgment reduce it; they do not remove it.
  - Phase 3 now holds drawings, sheet metal and CAM.
- **Follow-ups:**
  - Add this ADR to the [ADR README](README.md) index. Add "Amended by ADR 0016" to ADR 0000's status line, and apply §6 to ADR 0000, VISION.md and ROADMAP.md.
  - **Deferred FORGE.md edits** (Phase C is editing FORGE.md; this wording is recorded in [NORTH-STAR-DEFERRED.md](../NORTH-STAR-DEFERRED.md) until then):
    - Milestones table, F5 row, Scope: "GPU compute (tessellation, analysis, batch evaluation for agents); `forge-sim`, a differentiable FEA validated against CalculiX; CAM toolpaths" becomes "GPU compute (tessellation, analysis, batch evaluation for agents); `forge-sim`, a differentiable FEA validated against CalculiX. CAM toolpaths moved to Phase 3 (M14–M19) under ADR 0016."
    - Crate map, new row: `forge-cam` | 2.5D toolpaths, GRBL and LinuxCNC posts, stock-removal simulation; Kiri:Moto as CI oracle (ADR 0016) | Phase 3.
    - Crate map, `forge-io` row, "Lands in": "F0 (STL/3MF), F1 (STEP)" becomes "F0 (STL/3MF), F1 (STEP), Phase 1 beta (DXF/SVG, ADR 0016)".
  - ARCHITECTURE §6, Manufacturing tools: `slicer_handoff` follows §3 of this ADR. CAM tools are added when Phase 3 starts.
  - A handoff note listing each supported slicer: its licence (checked, with the date), CLI flags and tested versions. Bambu Studio's and PrusaSlicer's licences are recorded there before the handoff ships.
  - A licence check in `scripts/license-check/` that fails when a slicer binary, libslic3r source or a slicer's profile library enters the repo or a build.
  - Set CAM's gate numbers before CAM work starts (M14).

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Bundle or link an AGPL slicer engine (libslic3r, an OrcaSlicer build, a WASM port) | Linking puts the app under AGPL. Even a separate bundled binary makes us a distributor of AGPL code, with source obligations. Both break ADR 0001's licensing, the App Store path and the OEM option, and slicer bugs become ours. |
| Write our own slicer | Slicing doesn't decide the quality we claim: geometry, checks and fit. Mature free slicers exist and hold the user's settings. The scope is large (supports, infill, cooling, firmware dialects) and gives us no edge. A new ADR can revisit it. |
| Count a headless slice as a PartZero check | The result would depend on a third-party tool's version and the user's settings. We couldn't make it deterministic, reproduce it or explain it. ADR 0000 says checks are ours. |
| Ship a third-party CAM engine (Kiri:Moto is MIT) | Licence is not the blocker. Toolpaths decide the cut and its safety, so ADR 0000 makes them ours. Kiri:Moto stays the oracle. |
| Keep CAM at Phase 6+ | CNC users would stop at STEP and redo CAM in another tool. Part zero would stay out of reach until after M26 (Nov 2028). |
| Hand CNC to other CAM tools via STEP, for good | It is what we do until Phase 3. As a permanent choice it leaves no checked chain to the work origin. |
| Build our own machine sender | Machine control is real-time and safety-critical, and senders already exist. It doesn't decide design quality. |
| Slice on our servers | It ships the slicer in our service, raises AGPL network-use questions, costs compute, and sends designs off the device against ADR 0010. |
