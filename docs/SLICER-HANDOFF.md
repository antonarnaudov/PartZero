# Slicer handoff note

- **Status:** Living note, started 2026-09-25 for Alpha 0 drop 0.1 (ALPHA-0-PLAN W5).
- **Why it exists:** [ADR 0016](adr/0016-manufacturing-output-own-vs-hand-off.md) asks for one note that lists every slicer we hand files to: its licence (checked, with the date), how we launch it, the versions we tested, and what we saw. The handoff doesn't ship without it.
- **Code:** `packages/desktop/src/{slicer,print-handoff,profiles}.ts` (launcher, export and receipt, machine profiles), `forge/crates/forge-io/src/bed.rs` (centring and bed fit), `aicad export --bed` (`forge/crates/forge-cli/src/print.rs`).

## The rule

We launch the slicer the user installed, as a separate process, and exchange only files. We never bundle, link, embed, download, install or patch a slicer, and we copy none of its code or bundled profiles (ADR 0016 §3). Its output is never a PartZero check and never appears in a receipt (ADR 0016 §2).

## Supported slicers

| Slicer | Licence | Platforms | Tested version | Launch |
|---|---|---|---|---|
| Bambu Studio | AGPL-3.0 (checked 2026-09-24, Alpha 0 survey) | macOS only in Alpha 0 | 02.06.00.51 on macOS 27, arm64 | `/usr/bin/open -a <BambuStudio.app> <file.3mf>` |

OrcaSlicer and PrusaSlicer are not handed files in Alpha 0.

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
3. **No Bambu Studio, or the launch fails.** The export is kept. The toast gives the reason and the fix, with **Show in Finder**.

### The file we hand over

- **Location and name:** `~/PartZero/Prints/<doc>-<hash8>.3mf`. `hash8` is the start of the SHA-256 of the 3MF bytes, so the same design always gets the same name and a changed one never overwrites the last. `<doc>-<hash8>.receipt.json` sits beside it and lists what PartZero checked against which printer profile. It never includes slicer output.
- **Format:** core 3MF, millimetres, one object per body named `part/feature`, with `Title` (the document name) and `Application` (`PartZero <version>`) metadata.
- **Tessellation:** print tolerances from the profile: 0.01 mm chordal and 0.1 rad angular.
- **Placement:** each build item's `transform` is a pure translation. It centres the bounding box of all bodies on the bed centre, (128, 128) on the P2S, and puts the lowest point at z = 0. The vertices are exactly what Forge tessellated.
- **Before writing:** the design must pass `aicad eval` (report `ok`, every body valid). It must also fit the bed less 10 mm per side (236 × 236 × 256 mm on the P2S), or the export is refused with `EXPORT_BED_FIT`.

### Hands-on findings (2026-09-25, Bambu Studio 02.06.00.51, macOS 27 arm64)

| # | What | Result |
|---|---|---|
| 1 | Does Bambu Studio honour the build-item transform [as7]? | **Yes, in its loader.** We used its command line as test tooling only: `BambuStudio --arrange 0 --export-3mf out.3mf <ours>.3mf`. The two-body test part came back with its objects at X = 109 and X = 159, Y = 128, resting on z = 0, which is exactly where `place_on_bed` put them. `Title` and the object names were kept. |
| 2 | The same part without a transform | Bambu Studio kept the modelled X/Y, partly off the plate at the origin corner, and only dropped it to z = 0. Centring is ours to do. |
| 3 | Launching with Bambu Studio closed | `open -a` started it, and it stayed running with ~1 GB resident. The file arrived as an open-document event: the process had no file argument. **We have not seen it on screen.** Screen access to Bambu Studio was declined in the approval dialog, and its logs are encrypted. So these are still unknown: whether "load geometry only" is a modal dialog or a notice, and whether the chosen printer and filament presets survive. G2c step 4 checks them by hand. |
| 4 | A second file while Bambu Studio has the first open [as8] | **Bambu Studio started a second instance.** It was a child process of the first, with the file as its argument. So as8's "no second instance" is false once a part is open: each re-export while the last one is open gets a new window. A plain second window is harmless, but each instance uses ~0.9–1 GB. |
| 5 | Quitting | `NSRunningApplication.terminate` quit both instances within 10 s. No save prompt blocked it. |
| 6 | Headless slice with the P2S presets [as22, G1 #8] | **Not working as tried.** `--slice 0 --load-settings "<installed P2S 0.4 machine>;<installed 0.20mm Standard @BBL P2S>" --load-filaments "<installed Bambu PLA Basic @BBL P2S>"` crashed at start-up (SIGSEGV). The installed system presets inherit from base presets, which the command line apparently doesn't resolve. Next try: presets the user exports from their own Bambu Studio, used in place and never committed. Until then G1 #8 is skipped, and sizes come from G1 #6. |
Still to check by hand (G2c 4–5):
- Any privacy prompt when Bambu Studio reads from `~/PartZero/Prints` [as16]. The runs above used a temp folder and nobody watched the screen.
- Bambu Studio already running with an unsaved project.
- Whether the P2S and filament presets survive a geometry-only load.
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
