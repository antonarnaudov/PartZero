# Slicer handoff note

- **Status:** Living note, started 2026-09-25 for Alpha 0 drop 0.1 (ALPHA-0-PLAN W5).
- **Why it exists:** [ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md) asks for one note that lists every slicer we hand files to: its licence (checked, with the date), how we launch it, the versions we tested, and what we saw. The handoff doesn't ship without it.
- **Code:** `packages/desktop/src/{slicer,print-handoff,profiles}.ts` (launcher, export and receipt, machine profiles), `forge/crates/forge-io/src/bed.rs` (centring and bed fit), `aicad export --bed` (`forge/crates/forge-cli/src/print.rs`).

## The rule

We launch the slicer the user installed, as a separate process, and exchange only files. We never bundle, link, embed, download, install or patch a slicer, and we copy none of its code or bundled profiles (ADR 0016 §3). Its output is never a PartZero check and never appears in a receipt (ADR 0016 §2).

## Supported slicers

| Slicer | Licence | Platforms | Tested version | Launch |
|---|---|---|---|---|
| Bambu Studio | AGPL-3.0 (checked 2026-09-24, Alpha 0 survey; again 2026-09-25 in `bambulab/BambuStudio` `LICENSE`) | macOS only in Alpha 0 | 02.06.00.51 on macOS 27, arm64 | `/usr/bin/open -a <BambuStudio.app> <file.3mf>` |
| PrusaSlicer | AGPL-3.0 (checked 2026-09-25 in `prusa3d/PrusaSlicer` `LICENSE`) | not handed files in Alpha 0 | — | — |
| OrcaSlicer | AGPL-3.0 (checked 2026-09-25 in `SoftFever/OrcaSlicer` `LICENSE.txt`) | not handed files in Alpha 0 | — | — |

PrusaSlicer and OrcaSlicer are listed so the licence is on record before a handoff to them is built (ADR 0016 follow-ups). Adding one means a launch section and hands-on findings here, like Bambu Studio's.

## Bambu Studio

### What we checked in the installed app (2026-09-25)

Read from `/Applications/BambuStudio.app/Contents/Info.plist`:

- `CFBundleIdentifier` = `com.bambulab.bambu-studio`; `CFBundleShortVersionString` = `02.06.00.51`.
- `CFBundleDocumentTypes` declares `3mf`/`3MF` (role Viewer, rank Alternate), as well as STL, OBJ, AMF and G-code.

### How PartZero finds and launches it

1. **Detection** (`slicer:detect`). A path set in Settings wins and is the only place looked at: a wrong path shows up as "not found" instead of silently falling back (G2a a8). Otherwise PartZero looks in `/Applications`, then `~/Applications`, then asks Spotlight's LaunchServices index by bundle id (`mdfind "kMDItemCFBundleIdentifier == 'com.bambulab.bambu-studio'"`). A candidate counts only if its `Info.plist` has Bambu Studio's bundle id, so a path set from the UI can't launch another app. The version comes from `CFBundleShortVersionString`.
   - This differs from the plan's order, which put the Settings path last. With that order, a8 (a wrong path falls back to a plain export) couldn't pass while Bambu Studio is in `/Applications`.
2. **Launch** (`slicer:open`). `execFile("/usr/bin/open", ["-a", <detected app>, <file>])` runs with no shell, a 10 s timeout and capped output. It only opens a `.3mf` inside the prints folder, after resolving symlinks.
   - We use `-a <path>` rather than the plan's `-b <bundle id>`: it opens exactly the copy we detected and whose version we report.
   - Just before, `/usr/bin/pgrep -x -U <uid> <CFBundleExecutable>` (`BambuStudio`) tells whether it is already running. If it is, the toast says it may open the file in a new window and to close the previous one when you're done (finding 4). Test profiles never ask about the real Bambu Studio.
   - `open` exiting 0 means macOS handed the file over; nothing in PartZero can see Bambu Studio's window. So the toast says **"Sent <file> to Bambu Studio"**, not "Opened".
3. **No Bambu Studio, or the launch fails.** The export is kept. The toast gives the reason and the fix, with **Show in Finder**.

### The file we hand over

- **Location and name:** `~/PartZero/Prints/<doc>-<hash8>.3mf`. `hash8` is the start of the SHA-256 of the 3MF bytes. The bytes include the `Title` (document name) and `Application` (`PartZero <version>`) metadata, so the same design, document name and app version give the same file and name; a changed design never overwrites the last, and an app upgrade writes a new file even for the same geometry. `<doc>-<hash8>.receipt.json` sits beside it and lists what PartZero checked against which printer profile. It never includes slicer output.
- **Hashes in the receipt:** `sha256` is the file's hash (integrity). `geometryHash` (`fnv1a64:<16 hex>`, from `aicad export --summary`) is the determinism hash: FNV-1a over body names, vertex coordinates, triangles and the build translation, **without** the metadata, so it stays the same across a rename or an app upgrade and changes with any geometry or placement change. It identifies a result; it is not cryptographic.
- **Format:** core 3MF, millimetres, one object per body named `part/feature`, with `Title` (the document name) and `Application` (`PartZero <version>`) metadata.
- **Tessellation:** print tolerances from the profile: 0.01 mm chordal and 5° (π/36 rad) angular, so holes print round (the owner's rule, 2026-09-25; it was 0.1 rad).
- **Placement:** each build item's `transform` is a pure translation. It centres the bounding box of all bodies on the bed centre, (128, 128) on the P2S, and puts the lowest point at z = 0. The vertices are exactly what Forge tessellated.
- **Before writing:** the design must pass `aicad eval` (report `ok`, every body valid). It must also fit the bed less 10 mm per side (236 × 236 × 256 mm on the P2S), or the export is refused with `EXPORT_BED_FIT`.
- **After exporting, before saving:** the export summary must confirm what the receipt will claim, or nothing is saved:
  - as many bodies as `aicad eval` checked, and a recorded placement (`EXPORT_FAILED` otherwise, also when the summary is missing);
  - every body's print mesh watertight (`EXPORT_NOT_WATERTIGHT`, naming the body: a Forge problem, not the design's);
  - no bodies stacked above each other (`EXPORT_BODIES_OVERLAP`). Bambu Studio drops each object of a plain 3MF onto the plate (finding 2), while the placement moves all bodies together, so a lid modelled on its box would land inside it. The message asks for the bodies side by side in print orientation; plain **Export 3MF** still writes the file as modelled.
  - A body that starts above the bed but overlaps nothing is only a warning (`EXPORT_BODY_FLOATING`: the slicer drops it onto the plate). The toast shows it, and the receipt keeps it in `checks.layoutWarnings`.
  - A body counts as on the bed when its lowest point is within the chordal tolerance (0.01 mm): a curved underside's mesh sits up to that far above the exact surface.
- **An `aicad` older than the app** (built before `--bed`) is refused with `FORGE_OUTDATED` and the rebuild command, `cargo build -p forge-cli` (with `--release` for a packaged build), instead of clap's last line. `forgePrintCapability` (`packages/desktop/src/forge-cli.ts`) checks that `aicad export --help` lists every flag the handoff needs, for the self-test.

### Hands-on findings (2026-09-25, Bambu Studio 02.06.00.51, macOS 27 arm64)

| # | What | Result |
|---|---|---|
| 1 | Does Bambu Studio honour the build-item transform [as7]? | **Yes, in its loader.** We used its command line as test tooling only: `BambuStudio --arrange 0 --export-3mf out.3mf <ours>.3mf`. The two-body test part came back with its objects at X = 109 and X = 159, Y = 128, resting on z = 0, which is exactly where `place_on_bed` put them. `Title` and the object names were kept. |
| 2 | The same part without a transform | Bambu Studio kept the modelled X/Y, partly off the plate at the origin corner, and only dropped it to z = 0. Centring is ours to do. |
| 3 | Launching with Bambu Studio closed | `open -a` started it, and it stayed running with ~1 GB resident. The file arrived as an open-document event: the process had no file argument. **We have not seen it on screen.** Screen access to Bambu Studio was declined in the approval dialog, and its logs are encrypted. So these are still unknown: whether "load geometry only" is a modal dialog or a notice, and whether the chosen printer and filament presets survive. G2c step 4 checks them by hand. |
| 4 | A second file while Bambu Studio has the first open [as8] | **Bambu Studio started a second instance.** It was a child process of the first, with the file as its argument. So as8's "no second instance" is false once a part is open: each re-export while the last one is open gets a new window. A plain second window is harmless, but each instance uses ~0.9–1 GB. PartZero now checks whether it is running before the launch and says a new window may open (see "How PartZero finds and launches it"). |
| 5 | Quitting | `NSRunningApplication.terminate` quit both instances within 10 s. No save prompt blocked it. |
| 6 | Headless slice with the P2S presets [as22, G1 #8] | **Not working as tried.** `--slice 0 --load-settings "<installed P2S 0.4 machine>;<installed 0.20mm Standard @BBL P2S>" --load-filaments "<installed Bambu PLA Basic @BBL P2S>"` crashed at start-up (SIGSEGV). The installed system presets inherit from base presets, which the command line apparently doesn't resolve. Next try: presets the user exports from their own Bambu Studio, used in place and never committed. Until then G1 #8 is skipped, and sizes come from G1 #6. |
| 7 | The Alpha 0 preview's live golden path (2026-09-25, `alpha0-preview`), Bambu Studio closed | Open in Bambu Studio started it with the part: a screenshot of Bambu Studio's own window (only that window) showed its "Loading…" window and, over it, **a modal dialog**: "Load 3mf: The 3mf is not from Bambu Lab, load geometry data and color data only", with "Don't show again" and OK. That answers as7's modal-or-notice question. Its selected printer was the Bambu Lab P2S with a **0.2 mm nozzle** and the "0.10mm Standard @BBL P2S 0.2 nozzle" process, not the 0.4 mm nozzle our profile assumes (it may have been left there by the runs above). The dialog was not clicked, so the part on the plate was not seen; `NSRunningApplication.terminate` quit Bambu Studio within 1 s. |

Still to check by hand (G2c 4–5):
- **Before G2c, check Bambu Studio's own state.** The runs above used your real Bambu Studio and its data folder (`~/Library/Application Support/BambuStudio`): `BambuStudio.conf` was rewritten at 01:19 on 2026-09-25, when they ran. Its recent-files list may now include the temp test 3MFs, and any first-run or preset prompt went unseen. Look at File → Recent projects and at the selected printer and filament presets, and fix them if they changed.
- **Future hands-on runs:** back up `~/Library/Application Support/BambuStudio/BambuStudio.conf` first, or give the command line a separate data folder if it has an option for one (not confirmed for 02.06; its `--help` was not run), and restore it afterwards.
- Any privacy prompt when Bambu Studio reads from `~/PartZero/Prints` [as16]. The runs above used a temp folder and nobody watched the screen.
- Bambu Studio already running with an unsaved project.
- Whether the P2S and filament presets survive a geometry-only load, and which nozzle is selected: finding 7 saw the 0.2 mm one.
- Any bed exclusion zone on the P2S. The built-in profile has none and lists the zones as unverified.

### Printer data we use

The built-in `builtin:bambu-p2s-0.4` profile (`packages/desktop/src/profiles.ts`) comes from Bambu Lab's public P2S spec sheet, read 2026-09-24:
- bed 256 × 256 × 256 mm;
- 0.4 mm hardened-steel nozzle;
- no chamber heater.

None of it comes from Bambu Studio's bundled profiles. Everything the owner hasn't checked on the printer yet is in the profile's `unverified` list: bed, nozzle, nozzle material, chamber heater, exclusion zones. The day-0 check (ALPHA-0-PLAN §4.2) clears it.

## Licence gate

`scripts/license-check/slicer-boundary.mjs` fails CI when a slicer enters the repository or a build tree. It looks for:
- slicer app bundles and executables;
- libslic3r sources or libraries;
- a slicer's profile library.

Where it runs:
- **The repository:** CI's `licenses` job, on every push.
- **Every packed app:** electron-builder's `afterPack` hook (`packages/desktop/scripts/slicer-gate-after-pack.cjs`, set in `electron-builder.config.cjs`) scans `appOutDir` before signing or the DMG, for every platform and for `--dir` builds, and fails the build on a violation. Any other packaging config, the Alpha 0 build script's included, must keep this hook. A manual run on a build: `node scripts/license-check/slicer-boundary.mjs --build packages/desktop/release/mac-arm64`.
