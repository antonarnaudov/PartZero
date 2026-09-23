/**
 * Model states the scripted designer passes through. Their engine reports are recorded once with
 * the OCCT oracle (`pnpm --filter @aicad/agent fixtures`) into `fixtures/engine-reports.json`.
 * MakerBench references come from the corpus, so a scripted designer that ends on the reference
 * scores exactly like the reference solver.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CORPUS_DIR = fileURLToPath(new URL("../../../corpus/makerbench/", import.meta.url));

export function reference(id: string): string {
  return readFileSync(`${CORPUS_DIR}${id}.cad.ts`, "utf8");
}

function replaced(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`scenario: "${from}" not found`);
  return source.replace(from, to);
}

export const WASHER = reference("t1-m3-washer");
export const GASKET = reference("t1-rect-gasket");
export const SPACER = reference("t1-m5-spacer");

/** Washer, first step: the rim only (no bore yet). */
export const WASHER_NO_BORE = replaced(WASHER, "  bore: circle({ center: [0, 0], radius: 1.6 }),\n", "");
/** The washer's outline statement as in the reference (the designer's second step patches it in). */
export const WASHER_OUTLINE = WASHER.slice(WASHER.indexOf("const outline"), WASHER.indexOf("});", WASHER.indexOf("const outline")) + 3);

/** Gasket with a typo: 'o_top' starts 1 mm above the corner → SKETCH_OPEN_LOOP. */
export const GASKET_OPEN = replaced(GASKET, "o_top: line([45, 35], [-45, 35])", "o_top: line([45, 36], [-45, 35])");
export const GASKET_OUTLINE_FIX = { feature: "outline", code: GASKET.slice(GASKET.indexOf("const outline"), GASKET.indexOf("});", GASKET.indexOf("const outline")) + 3) };

/** Spacer drawn with the bore on the wrong side of the axis → REVOLVE_CROSSES_AXIS. */
export const SPACER_CROSS = SPACER.replaceAll("2.65", "-2.65");
export const SPACER_PROFILE_FIX = { feature: "profile", code: SPACER.slice(SPACER.indexOf("const profile"), SPACER.indexOf("});", SPACER.indexOf("const profile")) + 3) };

const HEADER = `import { doc, part, sketch, line, circle, extrude, XY } from "@aicad/std";`;

const plate = (top = "line([40, 25], [-40, 25])", extra = "", distance = 8) => `${HEADER}

doc({ name: "plate", description: "80 x 50 x 8 mm plate" });

part("plate");
const base = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: ${top},
  left: line([-40, 25], [-40, -25]),${extra}
});
const slab = extrude(base, { distance: ${distance} });
`;

/** A plate and ways to break it (distinct errors, for the repair/replan/stop rules). */
export const PLATE_OK = plate();
export const PLATE_THICK = plate(undefined, "", 10);
export const PLATE_OPEN = plate("line([40, 26], [-40, 25])");
export const PLATE_HOLE_CROSS = plate(undefined, `
  h1: circle({ center: [38, 0], radius: 3 }),`);
export const PLATE_BRANCH = plate(undefined, `
  dup: line([-40, -25], [0, -25]),`);
export const SLAB_10 = { feature: "slab", code: "const slab = extrude(base, { distance: 10 });" };

export const AGENT_SCENARIOS: Record<string, string> = {
  plate_ok: PLATE_OK,
  plate_thick: PLATE_THICK,
  plate_open: PLATE_OPEN,
  plate_hole_cross: PLATE_HOLE_CROSS,
  plate_branch: PLATE_BRANCH,
  washer: WASHER,
  washer_no_bore: WASHER_NO_BORE,
  gasket: GASKET,
  gasket_open: GASKET_OPEN,
  spacer: SPACER,
  spacer_cross: SPACER_CROSS,
};
