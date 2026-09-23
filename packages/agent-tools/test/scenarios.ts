/**
 * CadScript documents the tests evaluate. Their engine reports are recorded once with the OCCT
 * oracle (`pnpm --filter @aicad/agent-tools fixtures`) into `fixtures/engine-reports.json`, so the
 * suite runs offline with the evals FixtureEngine.
 */
const HEADER = `import { doc, part, sketch, line, arc, circle, extrude, revolve, XY, XZ } from "@aicad/std";`;

const plate = (top = "line([40, 25], [-40, 25])", extra = "", distance = 8) => `${HEADER}

doc({ name: "plate", description: "80 x 50 x 8 mm plate" });

part("plate");
// The outline, counter-clockwise from the bottom-left corner.
const base = sketch(XY, {
  bottom: line([-40, -25], [40, -25]),
  right: line([40, -25], [40, 25]),
  top: ${top},
  left: line([-40, 25], [-40, -25]),${extra}
});
const slab = extrude(base, { distance: ${distance} });
`;

export const SCENARIOS = {
  plate_ok: plate(),
  plate_thick: plate(undefined, "", 10),
  /** 'top' starts 1 mm above the corner: SKETCH_OPEN_LOOP. */
  plate_open: plate("line([40, 26], [-40, 25])"),
  plate_holes: plate(
    undefined,
    `
  h1: circle({ center: [35, 20], radius: 1.7 }),
  h2: circle({ center: [-35, 20], radius: 1.7 }),
  h3: circle({ center: [-35, -20], radius: 1.7 }),
  h4: circle({ center: [35, -20], radius: 1.7 }),`,
  ),
  /** A hole that pokes through the right edge: SKETCH_CURVES_CROSS. */
  plate_hole_cross: plate(undefined, `
  h1: circle({ center: [38, 0], radius: 3 }),`),
  /** A second line on top of 'bottom': SKETCH_BRANCHING. */
  plate_branch: plate(undefined, `
  dup: line([-40, -25], [0, -25]),`),
  rod_ok: `${HEADER}

part("rod");
const profile = sketch(XZ, {
  axis_side: line([0, 0], [10, 0]),
  outer: line([10, 0], [10, 30]),
  cap: line([10, 30], [0, 30]),
  on_axis: line([0, 30], [0, 0]),
});
const rod = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
`,
  /** The profile reaches 5 mm past the axis: REVOLVE_CROSSES_AXIS. */
  rod_cross: `${HEADER}

part("rod");
const profile = sketch(XZ, {
  axis_side: line([-5, 0], [10, 0]),
  outer: line([10, 0], [10, 30]),
  cap: line([10, 30], [-5, 30]),
  on_axis: line([-5, 30], [-5, 0]),
});
const rod = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 });
`,
  washer: `${HEADER}

doc({ name: "m3_washer", description: "M3 washer: 3.2 mm hole, 7 mm OD, 1 mm thick" });

part("washer");
const outline = sketch(XY, {
  rim: circle({ center: [0, 0], radius: 3.5 }),
  bore: circle({ center: [0, 0], radius: 1.6 }),
});
const washer = extrude(outline, { distance: 1 });
`,
} as const;

export type ScenarioName = keyof typeof SCENARIOS;
