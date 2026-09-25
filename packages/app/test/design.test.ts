/**
 * The design layer's contracts (the owner's "pro-grade visual design"): one icon set covers every
 * tool the ribbon and the sketcher show, every constraint and every timeline feature type; each
 * starter part has its own thumbnail; and both themes define the same colour tokens.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CONSTRAINT_KINDS } from "../src/sketch/constraints";
import { SKETCH_TOOLS } from "../src/tools/sketch";
import { STARTERS } from "../src/tools/starters";
import { StarterArt } from "../src/ui/shell/starter-art";
import { hasToolIcon, ToolIcon, TOOL_ICON_NAMES } from "../src/ui/shell/tool-icons";
import { ConstraintIcon, ToolIcon as SketchToolIcon } from "../src/ui/sketch/tool-icons";

const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(p: URL, enc: "utf8"): string };

const markup = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);
const GENERIC = markup(createElement(ToolIcon, { name: "no-such-icon" }));

describe("the icon set", () => {
  it("draws every sketch tool and every constraint with its own icon (never the generic one)", () => {
    for (const t of SKETCH_TOOLS) expect(markup(createElement(SketchToolIcon, { id: t.id, size: 16 })), t.id).not.toBe(GENERIC);
    for (const c of CONSTRAINT_KINDS) expect(markup(createElement(ConstraintIcon, { kind: c.kind, size: 16 })), c.kind).not.toBe(GENERIC);
  });

  it("covers the op catalogue's features, the construct and inspect tools and the browser's entities", () => {
    const needed = [
      "sketch", "extrude", "revolve", "hole", "fillet", "chamfer", "shell", "draft", "combine", "subtract", "intersect",
      "linearPattern", "circularPattern", "mirror", "plane", "offsetPlane", "axis", "measure", "properties", "bedFit",
      "section", "move", "split", "pushPull", "body", "origin", "parameters", "datum_plane", "datum_axis", "boolean", "pattern",
    ];
    for (const n of needed) expect(hasToolIcon(n), n).toBe(true);
    expect(TOOL_ICON_NAMES.length).toBeGreaterThanOrEqual(needed.length);
  });

  it("draws with crisp, themed strokes: a 20 px grid, currentColor, the pz-icon class", () => {
    const svg = markup(createElement(ToolIcon, { name: "extrude", size: 22 }));
    expect(svg).toContain('class="pz-icon"');
    expect(svg).toContain('viewBox="0 0 20 20"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('width="22"');
    // The accent (what the tool makes) is a themed class, not a hard-coded colour.
    expect(svg).toMatch(/class="a"|class="af"/);
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("starter thumbnails", () => {
  it("draws each of the five starters (its own picture, labelled with its title)", () => {
    expect(STARTERS).toHaveLength(5);
    const pictures = new Set<string>();
    for (const s of STARTERS) {
      const svg = markup(createElement(StarterArt, { id: s.id }));
      expect(svg, s.id).toContain(`aria-label="${s.title}"`);
      expect(svg).toMatch(/viewBox="-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+"/);
      pictures.add(svg);
    }
    expect(pictures.size).toBe(5);
  });
});

describe("design tokens", () => {
  it("defines the same colour tokens in the dark and the light theme", () => {
    const css = fs.readFileSync(new URL("../src/ui/styles/design.css", import.meta.url), "utf8");
    const block = (selector: RegExp): Set<string> => {
      const m = selector.exec(css);
      if (!m) throw new Error(`no block ${String(selector)}`);
      const body = css.slice(m.index + m[0].length, css.indexOf("}", m.index));
      return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1]!));
    };
    const dark = block(/:root,\s*:root\[data-theme="dark"\]\s*\{/);
    const light = block(/:root\[data-theme="light"\]\s*\{/);
    expect(dark.size).toBeGreaterThan(40);
    const missing = [...dark].filter((v) => !light.has(v) && !["--shadow-pill", "--accent-contrast"].includes(v));
    expect(missing).toEqual([]);
  });
});
