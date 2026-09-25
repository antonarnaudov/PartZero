# Showcase benchmarks

These two parts are acceptance tests for the full modeling build ([FULL-MODELING-PLAN.md](../FULL-MODELING-PLAN.md)). Each part must be built twice:

1. **By hand.** Build it with the app's tools, driven by a Playwright-Electron script that clicks through the same tools a person uses: sketch, constrain, dimension, feature panels and handles.
2. **By the agent, live.** The agent builds it through the same commands. Every step appears in the viewport and timeline as it happens (see *Live editing* below).

Both versions must be valid solids with no silently wrong geometry. They must print on the Bambu Lab P2S (0.4 mm nozzle, PLA), and export to 3MF with print-quality tessellation (≈0.01 mm chord, ≤5°) and to STEP.

Dimensions of standard things (bottle size, pellet diameter, thread standard) are researched and cited, never asked of the owner. Each one is exposed as an editable parameter.

## 1. Coca-Cola contour bottle

- **Body:** the classic contour-bottle silhouette as a spline profile in a sketch on XZ, revolved 360°.
  - Use the 330 ml or 500 ml glass contour bottle as the reference. Research and cite the published dimensions: height, max diameter, neck and lip.
- **Details:**
  - fillets at the base and shoulder transitions;
  - a shell of about 1.6 mm with the top face open (the mouth);
  - the lip bead at the mouth;
  - a stable base (a flat or petaloid-free base is fine for print).
- **Optional:** vertical fluting on the lower body, as a circular pattern.
- **Pass criteria:**
  - Silhouette within 1 mm of the cited reference profile at 10 stations.
  - A single closed solid; wall thickness ≥ 1.5 mm everywhere (`min_wall`).
  - Height and max diameter match their parameters.
  - Editing the height parameter rebuilds without errors, with fillets kept.

## 2. .177 PCP airgun moderator (Tesla-valve baffles)

For air rifles only. Moderators are legal for airguns in many countries but regulated in some; in the US, a device that can fit a firearm is a regulated silencer regardless of intent. The owner is responsible for local law. The design is sized for .177 (4.5 mm) pellets and printed in plastic.

- **Outer body:** a tube.
  - Default length about 150 mm and outer diameter about 32 mm, as parameters. Research typical 3D-printed PCP moderator dimensions (for example MakerWorld and Printables listings) and cite them.
- **Rear end:** a **female screw thread** to fit the rifle's muzzle adapter.
  - The standard is a parameter. Research the common PCP moderator threads (for example 1/2"-20 UNF, M14×1) and cite the default choice.
  - Model the thread as a real helical thread, not a plain bore.
    - If the kernel can't yet do helical threads at the quality bar, fall back to an exact-minor-diameter bore plus a *cosmetic thread*.
    - Record that as not met for this criterion. Don't hide it.
- **Front end cap:** the **pellet exit hole** on the axis, clear of the pellet path (bore ≈ 6–7 mm, researched), plus **two vent holes**, one on each side of the exit hole.
- **Internals:** a **Tesla-valve** flow path.
  - Asymmetric loop channels that return gas against the flow direction, arranged along the tube around the clear central pellet path.
  - Build it with sketch profiles plus extrude/revolve cuts and patterns.
  - Research the Tesla-valve geometry: loop angle and channel width.
- **Exterior:** a **repeating cosmetic skin**, for example hex cells, grooves or knurl-like facets.
  - Build it with linear and circular patterns of cut or emboss features on the outer cylinder.
  - Keep walls ≥ 1.2 mm.
- **Compare:** research two or three comparable published models (MakerWorld/Printables pages: dimensions, thread, internal layout, photos) and compare ours against them in a short table.
  - Downloading any model file needs the owner's approval, and third-party files are never committed.
- **Pass criteria:**
  - A single closed solid, with the pellet path clear along the whole axis (clearance check).
  - The thread's major/minor diameters and pitch match the chosen standard.
  - Vent holes are present and symmetric.
  - The Tesla loops are present and connected to the main channel.
  - The skin pattern is complete.
  - Printable on the P2S without supports inside the thread, or with a documented orientation.
  - Editing the length re-patterns the internals.

## Live editing (applies to both)

When the agent builds either part:

- **Each command shows up as it's applied:** the sketch, then its constraints, then the extrude, and so on.
- **What the user sees for each step:**
  - the viewport updates;
  - a new timeline entry appears;
  - the chat shows a one-line narration.
- **Nothing waits for a final "proposal" to appear.** The user can press Stop at any step, and everything done so far is kept as normal, editable features.
- **The edits follow the autonomy dial (ADR 0015):** the agent's features are marked as the agent's, and one undo group per turn reverts the whole turn.
