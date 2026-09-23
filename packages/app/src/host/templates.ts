/**
 * "New from template": the MakerBench reference solutions (`corpus/makerbench/*.cad.ts`), with
 * titles, prompts and tags from their `*.task.json`. Bundled at build time, so templates work the
 * same in the desktop app and on the web without file-system access.
 */
import { z } from "zod";

export interface TemplateInfo {
  id: string;
  title: string;
  description: string;
  tier: string | null;
  process: string | null;
  tags: string[];
  source: string;
}

const TaskSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  prompt: z.string().optional(),
  tier: z.string().optional(),
  process: z.string().optional(),
  tags: z.array(z.string()).optional(),
  reference: z.string().optional(),
});

const tasks = import.meta.glob("../../../../corpus/makerbench/*.task.json", { eager: true, import: "default" });
const sources = import.meta.glob("../../../../corpus/makerbench/*.cad.ts", { eager: true, query: "?raw", import: "default" });

export const BLANK_TEMPLATE_ID = "blank";

/** The document `file.new` creates. */
export const BLANK_SOURCE = `import { doc, part, sketch, line, circle, extrude, revolve, XY, XZ, YZ } from "@aicad/std";

doc({ name: "untitled", description: "" });

part("part");
const base = sketch(XY, {
  bottom: line([-20, -15], [20, -15]),
  right: line([20, -15], [20, 15]),
  top: line([20, 15], [-20, 15]),
  left: line([-20, 15], [-20, -15]),
});
const block = extrude(base, { distance: 10 });
`;

function fileStem(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.(task\.json|cad\.ts)$/, "");
}

function loadTemplates(): TemplateInfo[] {
  const byStem = new Map<string, string>();
  for (const [path, text] of Object.entries(sources)) if (typeof text === "string") byStem.set(fileStem(path), text);
  const out: TemplateInfo[] = [];
  for (const [path, json] of Object.entries(tasks)) {
    const task = TaskSchema.safeParse(json);
    if (!task.success) continue;
    const t = task.data;
    const stem = t.reference ? fileStem(t.reference) : fileStem(path);
    const source = byStem.get(stem);
    if (source === undefined) continue;
    out.push({
      id: t.id,
      title: t.title,
      description: t.prompt ?? "",
      tier: t.tier ?? null,
      process: t.process ?? null,
      tags: t.tags ?? [],
      source,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export const TEMPLATES: readonly TemplateInfo[] = loadTemplates();

export function findTemplate(id: string): TemplateInfo | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
