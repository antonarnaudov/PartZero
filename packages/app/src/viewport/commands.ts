/**
 * `view.*` commands: standard views, fit, zoom to selection, look-at, projection, display modes,
 * grid/axes/origin, per-body visibility and colour, and the section plane. They are ordinary
 * `CommandSpec<…, AppServices>`s, so they merge into the app registry with one spread line
 * (docs/fm/view-sel-followups.md); until then `viewport/registry.ts` runs them.
 *
 * The agent never moves the user's camera (FULL-MODELING-PLAN §2.1 rule 5): it gets the read-only
 * `view.snapshot`; camera commands are UI commands.
 */
import { z } from "zod";
import { defineCommand } from "../commands/registry";
import type { AppServices } from "../services";
import { BODY_SWATCHES, DISPLAY_MODE_LABELS, DISPLAY_MODES, hexToRgb, modeAvailable, rgbToHex } from "./display";
import { viewportRuntime } from "./runtime";
import { NAV_PRESETS } from "./navigation";
import { STANDARD_VIEWS, standardViewOf } from "./view-camera";

const command = defineCommand<AppServices>();
const NoArgs = z.strictObject({});
const ViewSchema = z.enum(STANDARD_VIEWS);
const ProjectionSchema = z.enum(["perspective", "orthographic"]);
const DisplayModeSchema = z.enum(DISPLAY_MODES);
const ToggleSchema = z.enum(["grid", "axes", "origin", "viewCube", "sketches"]);
const SectionBaseSchema = z.enum(["XY", "XZ", "YZ", "face"]);
const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb colour");
const NavPresetSchema = z.enum(NAV_PRESETS);

const VIEW_TITLES: Record<(typeof STANDARD_VIEWS)[number], string> = {
  iso: "Isometric",
  top: "Top",
  front: "Front",
  right: "Right",
  bottom: "Bottom",
  back: "Back",
  left: "Left",
};

/** Onshape's Shift+1…7 order. */
const VIEW_KEYS: Record<(typeof STANDARD_VIEWS)[number], string> = {
  front: "Shift+1",
  back: "Shift+2",
  left: "Shift+3",
  right: "Shift+4",
  top: "Shift+5",
  bottom: "Shift+6",
  iso: "Shift+7",
};

function rt(ctx: AppServices) {
  return viewportRuntime(ctx);
}

function knownBody(ctx: AppServices, body: string): void {
  if (!rt(ctx).topo.bodies.has(body)) throw new Error(`no body ${body} (bodies: ${[...rt(ctx).topo.bodies.keys()].join(", ") || "none"})`);
}

export const VIEW_COMMANDS = {
  "view.setView": command({
    id: "view.setView",
    title: "Standard View",
    category: "View",
    description: "Turn the camera to a standard view (front, back, left, right, top, bottom, isometric) and fit the model.",
    args: z.strictObject({ view: ViewSchema }),
    palette: STANDARD_VIEWS.map((v) => ({ title: `View: ${VIEW_TITLES[v]}`, args: { view: v } })),
    async run({ view }, ctx) {
      await rt(ctx).setStandardView(view);
      ctx.ui.setViewport({ view: view === "iso" || view === "top" || view === "front" || view === "right" ? view : null });
      return { view };
    },
  }),

  "view.front": command({ id: "view.front", title: "View: Front", category: "View", args: NoArgs, keys: [VIEW_KEYS.front], palette: false, run: (_a, ctx) => rt(ctx).setStandardView("front").then(() => ({ view: "front" })) }),
  "view.back": command({ id: "view.back", title: "View: Back", category: "View", args: NoArgs, keys: [VIEW_KEYS.back], palette: false, run: (_a, ctx) => rt(ctx).setStandardView("back").then(() => ({ view: "back" })) }),
  "view.left": command({ id: "view.left", title: "View: Left", category: "View", args: NoArgs, keys: [VIEW_KEYS.left], palette: false, run: (_a, ctx) => rt(ctx).setStandardView("left").then(() => ({ view: "left" })) }),
  "view.right": command({ id: "view.right", title: "View: Right", category: "View", args: NoArgs, keys: [VIEW_KEYS.right], palette: false, run: (_a, ctx) => rt(ctx).setStandardView("right").then(() => ({ view: "right" })) }),
  "view.top": command({ id: "view.top", title: "View: Top", category: "View", args: NoArgs, keys: [VIEW_KEYS.top], palette: false, run: (_a, ctx) => rt(ctx).setStandardView("top").then(() => ({ view: "top" })) }),
  "view.bottom": command({ id: "view.bottom", title: "View: Bottom", category: "View", args: NoArgs, keys: [VIEW_KEYS.bottom], palette: false, run: (_a, ctx) => rt(ctx).setStandardView("bottom").then(() => ({ view: "bottom" })) }),
  "view.iso": command({ id: "view.iso", title: "View: Isometric", category: "View", args: NoArgs, keys: [VIEW_KEYS.iso], palette: false, run: (_a, ctx) => rt(ctx).setStandardView("iso").then(() => ({ view: "iso" })) }),

  "view.home": command({
    id: "view.home",
    title: "Home View",
    category: "View",
    description: "Isometric view, fitted to the model (the view cube's home button).",
    args: NoArgs,
    keys: ["Home"],
    async run(_args, ctx) {
      await rt(ctx).setStandardView("iso");
      ctx.ui.setViewport({ view: "iso" });
      return { view: "iso" as const };
    },
  }),

  "view.lookAlong": command({
    id: "view.lookAlong",
    title: "Look Along Direction",
    category: "View",
    description: "Orient the camera to look along a world direction (view cube edges and corners), fitted.",
    args: z.strictObject({ dir: z.tuple([z.number(), z.number(), z.number()]).refine((d) => Math.hypot(d[0], d[1], d[2]) > 1e-9, "a non-zero direction") }),
    palette: false,
    async run({ dir }, ctx) {
      await rt(ctx).lookAlong(dir);
      const v = standardViewOf(rt(ctx).adapter?.camera() ?? { yaw: NaN, pitch: NaN }, 1e-6);
      return { view: v };
    },
  }),

  "view.fit": command({
    id: "view.fit",
    title: "Zoom to Fit",
    category: "View",
    args: NoArgs,
    keys: ["F"],
    async run(_args, ctx) {
      await rt(ctx).fit();
      return { fitted: true };
    },
  }),

  "view.zoomToSelection": command({
    id: "view.zoomToSelection",
    title: "Zoom to Selection",
    category: "View",
    description: "Frame the selected entities (everything when nothing is selected).",
    args: NoArgs,
    keys: ["Shift+Z"],
    async run(_args, ctx) {
      await rt(ctx).zoomToSelection();
      return { items: rt(ctx).selection.items.length };
    },
  }),

  "view.normalTo": command({
    id: "view.normalTo",
    title: "Look At (Normal To)",
    category: "View",
    description: "Look straight at the selected planar face (or along a cylindrical face's axis).",
    args: NoArgs,
    keys: ["N"],
    async run(_args, ctx) {
      await rt(ctx).normalTo();
      return { lookedAt: rt(ctx).selection.primary };
    },
  }),

  "view.setProjection": command({
    id: "view.setProjection",
    title: "Projection",
    category: "View",
    args: z.strictObject({ projection: ProjectionSchema }),
    palette: [
      { title: "View: Perspective Projection", args: { projection: "perspective" } },
      { title: "View: Orthographic Projection", args: { projection: "orthographic" } },
    ],
    run({ projection }, ctx) {
      rt(ctx).setProjection(projection);
      ctx.ui.setViewport({ projection });
      return { projection };
    },
  }),

  "view.toggleProjection": command({
    id: "view.toggleProjection",
    title: "Toggle Perspective / Orthographic",
    category: "View",
    args: NoArgs,
    keys: ["P"],
    // The palette has "View: Perspective / Orthographic Projection"; a second entry would only
    // crowd searches like "view top".
    palette: false,
    run(_args, ctx) {
      const projection = rt(ctx).view.getState().projection === "perspective" ? "orthographic" : "perspective";
      rt(ctx).setProjection(projection);
      ctx.ui.setViewport({ projection });
      return { projection };
    },
  }),

  "view.setDisplayMode": command({
    id: "view.setDisplayMode",
    title: "Display Mode",
    category: "View",
    description: "Shaded, shaded with edges, wireframe, hidden line or X-ray.",
    args: z.strictObject({ mode: DisplayModeSchema }),
    palette: DISPLAY_MODES.map((m) => ({ title: `Display: ${DISPLAY_MODE_LABELS[m]}`, args: { mode: m } })),
    run({ mode }, ctx) {
      const r = rt(ctx);
      const native = r.adapter?.capabilities().nativeModes;
      if (native && !modeAvailable(mode, native)) {
        throw new Error(`${DISPLAY_MODE_LABELS[mode]} needs forge-render's display modes, which this build's renderer does not include`);
      }
      r.view.setDisplay(mode);
      return { mode, drawn: r.effectiveDisplay() };
    },
  }),

  "view.setNavigation": command({
    id: "view.setNavigation",
    title: "Navigation Device",
    category: "View",
    description:
      "How the scroll wheel and two-finger scroll move the camera: auto (detect per gesture: a mouse wheel zooms, a trackpad scroll orbits, Shift+scroll pans), mouse (every scroll zooms) or trackpad (every scroll orbits). Pinch always zooms.",
    args: z.strictObject({ device: NavPresetSchema }),
    palette: [
      { title: "Navigation: Detect Mouse or Trackpad", args: { device: "auto" } },
      { title: "Navigation: Mouse (Scroll Zooms)", args: { device: "mouse" } },
      { title: "Navigation: Trackpad (Scroll Orbits)", args: { device: "trackpad" } },
    ],
    run({ device }, ctx) {
      rt(ctx).view.setNavigation(device);
      return { device };
    },
  }),

  "view.setToggle": command({
    id: "view.setToggle",
    title: "Show / Hide",
    category: "View",
    description: "Show or hide the ground grid, the axes gizmo, the origin planes and axes, the view cube, or every sketch's curves.",
    args: z.strictObject({ toggle: ToggleSchema, on: z.boolean().optional() }),
    palette: [
      { title: "View: Toggle Grid", args: { toggle: "grid" } },
      { title: "View: Toggle Origin Planes and Axes", args: { toggle: "origin" } },
      { title: "View: Toggle Axes Gizmo", args: { toggle: "axes" } },
      { title: "View: Toggle View Cube", args: { toggle: "viewCube" } },
      { title: "View: Toggle Sketches", args: { toggle: "sketches" } },
    ],
    run({ toggle, on }, ctx) {
      const v = rt(ctx).view;
      const next = on ?? !v.getState()[toggle];
      v.setToggle(toggle, next);
      return { toggle, on: next };
    },
  }),

  "view.setBodyVisible": command({
    id: "view.setBodyVisible",
    title: "Show / Hide Body",
    category: "View",
    args: z.strictObject({ body: z.string().min(1), visible: z.boolean().optional() }),
    palette: false,
    run({ body, visible }, ctx) {
      knownBody(ctx, body);
      const r = rt(ctx);
      const next = visible ?? !r.view.body(body).visible;
      r.view.setBody(body, { visible: next });
      if (!next) r.selection.set(r.selection.items.filter((it) => !("body" in it) || it.body !== body));
      return { body, visible: next };
    },
  }),

  "view.hideSelected": command({
    id: "view.hideSelected",
    title: "Hide Selected Bodies",
    category: "View",
    description: "Hide the bodies of the selected entities.",
    args: NoArgs,
    keys: ["V"],
    run(_args, ctx) {
      const r = rt(ctx);
      const bodies = [...new Set(r.selection.items.flatMap((it) => ("body" in it ? [it.body] : [])))];
      if (bodies.length === 0) throw new Error("select a body, face, edge or vertex first");
      for (const b of bodies) r.view.setBody(b, { visible: false });
      r.selectItems([]);
      return { hidden: bodies };
    },
  }),

  "view.isolate": command({
    id: "view.isolate",
    title: "Isolate",
    category: "View",
    description: "Show only the given bodies (default: the bodies of the selection); hide the rest.",
    args: z.strictObject({ bodies: z.array(z.string().min(1)).optional() }),
    keys: ["Shift+I"],
    run({ bodies }, ctx) {
      const r = rt(ctx);
      const keep = bodies ?? [...new Set(r.selection.items.flatMap((it) => ("body" in it ? [it.body] : [])))];
      if (keep.length === 0) throw new Error("select what to isolate first");
      for (const b of keep) knownBody(ctx, b);
      r.view.isolate(keep, [...r.topo.bodies.keys()]);
      return { shown: keep };
    },
  }),

  "view.showAll": command({
    id: "view.showAll",
    title: "Show All Bodies",
    category: "View",
    args: NoArgs,
    keys: ["Shift+V"],
    run(_args, ctx) {
      rt(ctx).view.showAll();
      return { shown: [...rt(ctx).topo.bodies.keys()] };
    },
  }),

  "view.setBodyColor": command({
    id: "view.setBodyColor",
    title: "Body Colour",
    category: "View",
    description: `Display colour of a body (#rrggbb), or null for the default. Swatches: ${BODY_SWATCHES.filter((s) => s.hex)
      .map((s) => `${s.name} ${s.hex}`)
      .join(", ")}.`,
    args: z.strictObject({ body: z.string().min(1), color: ColorSchema.nullable() }),
    palette: false,
    run({ body, color }, ctx) {
      knownBody(ctx, body);
      const rgb = color === null ? null : hexToRgb(color);
      rt(ctx).view.setBodyColor(body, rgb);
      return { body, color: rgb ? rgbToHex(rgb) : null };
    },
  }),

  "view.section": command({
    id: "view.section",
    title: "Section View",
    category: "View",
    description: "Cut the model with a plane: a principal plane through the model's centre, or the selected planar face. `offset` moves it along its normal (mm); `flipped` keeps the other half.",
    args: z.strictObject({ base: SectionBaseSchema, offset: z.number().optional(), flipped: z.boolean().optional() }),
    palette: [
      { title: "Section: XY plane", args: { base: "XY" } },
      { title: "Section: XZ plane", args: { base: "XZ" } },
      { title: "Section: YZ plane", args: { base: "YZ" } },
      { title: "Section: from the selected face", args: { base: "face" } },
    ],
    run({ base, offset, flipped }, ctx) {
      const r = rt(ctx);
      r.sectionFrom(base);
      const patch: { offset?: number; flipped?: boolean } = {};
      if (offset !== undefined) patch.offset = offset;
      if (flipped !== undefined) patch.flipped = flipped;
      const s = Object.keys(patch).length ? r.view.patchSection(patch) : r.view.getState().section;
      return { section: s };
    },
  }),

  "view.setSectionOffset": command({
    id: "view.setSectionOffset",
    title: "Section Offset",
    category: "View",
    args: z.strictObject({ offset: z.number() }),
    palette: false,
    enabled: (ctx) => rt(ctx).view.getState().section !== null,
    run({ offset }, ctx) {
      return { section: rt(ctx).view.patchSection({ offset }) };
    },
  }),

  "view.flipSection": command({
    id: "view.flipSection",
    title: "Flip Section",
    category: "View",
    args: NoArgs,
    enabled: (ctx) => rt(ctx).view.getState().section !== null,
    run(_args, ctx) {
      const s = rt(ctx).view.getState().section!;
      return { section: rt(ctx).view.patchSection({ flipped: !s.flipped }) };
    },
  }),

  "view.clearSection": command({
    id: "view.clearSection",
    title: "Remove Section",
    category: "View",
    args: NoArgs,
    run(_args, ctx) {
      rt(ctx).view.setSection(null);
      return { section: null };
    },
  }),

  "view.snapshot": command({
    id: "view.snapshot",
    title: "View State",
    category: "View",
    description: "Read-only: the camera, display mode, section and hidden bodies (what the user is looking at).",
    args: NoArgs,
    palette: false,
    run(_args, ctx) {
      const r = rt(ctx);
      const v = r.view.getState();
      return {
        camera: r.adapter?.camera() ?? null,
        view: v.view,
        projection: v.projection,
        display: v.display,
        drawn: r.effectiveDisplay(),
        grid: v.grid,
        origin: v.origin,
        section: v.section,
        hidden: [...r.view.hiddenBodies()],
        colors: Object.fromEntries(Object.entries(v.bodies).filter(([, b]) => b.color).map(([n, b]) => [n, rgbToHex(b.color!)])),
        renderer: r.adapter ? { kind: r.adapter.kind, backend: r.adapter.backend(), nativeModes: r.adapter.capabilities().nativeModes } : null,
      };
    },
  }),
};
