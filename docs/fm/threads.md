# Modelled helical threads (FM9 stretch)

Real, printable screw threads: a hole's `thread.modeled: true` (SPEC-v1 §6.5) and the `thread`
feature (§6.13). The airgun-moderator showcase (`docs/benchmarks/SHOWCASE.md`) needs the rear
female thread (1/2-20 UNF by default) as a real helical thread, not a plain bore.

## What is built

The 60° basic profile of ISO 68-1 / ASME B1.1 (`H = P·√3/2`, `D1 = D − 1.25·H`), cut into a
cylindrical face as one groove per start:

- a **nut thread** in a bore (the bore is the crest, the root the major diameter `D`, root flat
  `P/8`), a **bolt thread** on a boss (the boss is the crest, the root `D1`, root flat `P/4`);
- flanks are **exact helicoids** `S(u, v) = o + v·e_r(u) + (p·u + k·v)·z` (`k = ±tan 30°`), the
  root and crest stay cylinders, edges are **exact helices** (and Archimedean spirals where a flank
  meets a plane across the axis, arcs elsewhere). No B-spline and no general surface–surface
  intersection is involved: `forge-ops::thread` writes the faces, edges and pcurves directly;
- ends: on a plane across the axis the plane gains or loses the groove sections; on a coaxial cone
  on the far side (a drill point, a countersink) or inside the face, each groove is closed by a
  planar end face; a thread must start on an end circle of its face.

Refusals are structured (`THREAD_*` codes with details: feasible diameters, lengths, the
interfering radius band), never a wrong body: a face that is not a two-circle cylinder band, a
bore or boss outside the form's crest range, a thread past its face, an end within 1e-3 mm of the
face's end, both ends inside the face, and any other face within the groove's annulus (a wall
thinner than the thread).

## Standards

`THREAD_STANDARDS` (`forge-ir/src/v1/threads.rs`, in `schema/ir-v1.constants.json`): ISO metric
coarse M1.6–M30 and fine (the pitches both source tables list), Unified coarse and fine #2–1"
(numbered sizes `0.060 + 0.013·N` in). Every row has two independent sources (Wikipedia ISO metric
screw thread and UTS, Modulus Metal ISO 261, Fuller Fasteners, AMESWeb UNC/UNF charts; URLs in the
constants file). 1/2-20 UNF: `D = 12.7`, `P = 1.27`, basic minor `11.325` mm. Nominal diameters
only: tolerance classes and FDM compensation are not in the IR.

## Using it

- IR: `{ "type": "thread", "face": <face ref>, "standard": "M8", "length": 12 }`, or a hole with
  `"thread": { "standard": "1/2-20 UNF", "modeled": true }` (without `size` or `d` the hole bores
  the standard's basic minor diameter).
- CadScript: `thread(boss.side("ring"), { standard: "M8", length: 12 })`,
  `hole(face, { at, depth: "through", thread: { standard: "1/2-20 UNF", modeled: true } })`.
- App: the **Thread** tool (`feature.thread`, Create group): pick a hole wall or a boss side, a
  standard, the length, modelled or cosmetic, the hand. The same tool is `tool.start
  { id: "feature.thread", args }` for the agent and MCP. Agent hints cover every `THREAD_*` code.
- Export: STL/3MF print meshes are watertight at print quality (0.01 mm chord, ≤ 5°). STEP (AP242
  has no helicoid or helix) carries certified B-spline approximations: quintic Hermite pieces with
  a proven error bound, within 1e-7 mm of the exact geometry, sharing its parametrization.

## Verification

- `forge-ops/tests/thread_build.rs`: volume and area against the closed forms (groove volume
  `L·(2π/P)·∫ r·w(r) dr`, flank area `(L/|p|)·∫ √(v²(1 + k²) + p²) dv`) to 1e-10 relative, for
  through holes, blind flat floors, drill points, countersinks, partial threads, bolts, both hands
  and several starts; watertight print tessellation; determinism; booleans elsewhere on a threaded
  body; property tests over random nut and bolt threads; every refusal.
- `forge-core`: helix/spiral/helicoid evaluation, projection, certified line–helicoid crossings,
  tight boxes through certified extremes, B-spline conversion bounds.
- `corpus/v1/programs/threads.json` (1/2-20 UNF through hole, M8 blind flat tapped hole, M8 bolt
  thread on a boss) against the OCCT oracle (`oracle/src/aicad_oracle/v1/threads.py`, a different
  construction: a Frenet sweep cut from B-spline-converted faces): counts, volume, area, box and
  centroid match (volume 2.8e-8 relative or better); types differ only as §8.3 rule 9 allows →
  `NORMALIZED`.
- `forge-io/tests/step_threads.rs`: threaded bodies export, read back, verify, and bound Forge's
  exact volume and area to 1e-7.

## Not done yet

- A boolean whose section would cross a thread flank is refused (`FORGE_BOOLEAN_UNSUPPORTED`,
  "helicoid"): add threads after the cuts and joins that touch the threaded face.
- A pattern seed hole with a modelled thread (`FORGE_PATTERN_MODELED_THREAD`) and mirrored threads
  are refused: put the positions into the hole itself.
- Both ends inside the face (a thread in the middle of a bore) is refused.
- Thread run-outs / chamfered thread starts and tolerance classes are not modelled.
- The oracle's own checks cover diameter, face and length; end-margin and interference refusals are
  Forge-only (no oracle program raises them).
