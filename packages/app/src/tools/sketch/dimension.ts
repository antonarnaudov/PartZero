/**
 * The dimension tool (D): pick a line, a circle or arc, two points, a point and a line, or two
 * lines; move to place the label and click; type the value (a number, an expression over the
 * parameters, or `name = value` to make a parameter) and press Enter. See `sketch/dimension.ts`.
 */
import { proposeDimension, type DimPick, type DimProposal } from "../../sketch/dimension";
import type { P2 } from "../../sketch/geom";
import { EMPTY_PREVIEW, type PointerIn, type SketchTool, type ToolApi, type ToolPreview } from "./types";

export class DimensionTool implements SketchTool {
  readonly id = "dimension" as const;
  private picks: DimPick[] = [];
  private proposal: DimProposal | null = null;
  private cursor: P2 | null = null;
  private alt = false;

  hint(): string {
    if (this.proposal) return "Click to place the dimension (or pick another entity to combine)";
    if (this.picks.length) return "Pick the second point or line";
    return "Pick a line, circle, arc, or two points/lines";
  }

  /** The dimension being placed, for the overlay to draw at the cursor. */
  pending(): { proposal: DimProposal; at: P2 } | null {
    return this.proposal && this.cursor ? { proposal: this.proposal, at: this.cursor } : null;
  }

  private hit(p: P2, api: ToolApi): DimPick | null {
    const pt = api.hitPoint(p);
    if (pt) return { kind: "point", ref: pt.ref };
    const c = api.hitCurve(p);
    return c ? { kind: "curve", id: c.id } : null;
  }

  down(p: P2, e: PointerIn, api: ToolApi): void {
    if (e.button !== 0) return;
    this.alt = e.shift;
    const h = this.hit(p, api);
    if (this.proposal && !h) {
      api.openDimension(this.proposal, p);
      this.reset();
      return;
    }
    if (!h) return;
    const picks = [...this.picks, h];
    const combined = proposeDimension(picks, api.curves(), this.alt);
    if (combined || picks.length === 1) {
      this.picks = combined || picks.length === 1 ? picks : [h];
      this.proposal = combined;
      return;
    }
    // The pair does not make a dimension: start over from this pick.
    this.picks = [h];
    this.proposal = proposeDimension(this.picks, api.curves(), this.alt);
  }

  move(p: P2, e: PointerIn, api: ToolApi): void {
    this.cursor = p;
    if (this.proposal && e.shift !== this.alt && this.picks.length === 1) {
      this.alt = e.shift;
      this.proposal = proposeDimension(this.picks, api.curves(), this.alt) ?? this.proposal;
    }
  }

  up(): void {}

  private reset(): void {
    this.picks = [];
    this.proposal = null;
  }

  escape(): boolean {
    if (!this.picks.length) return false;
    this.reset();
    return true;
  }

  preview(): ToolPreview {
    const highlight = this.picks.filter((p): p is { kind: "curve"; id: string } => p.kind === "curve").map((p) => p.id);
    return { ...EMPTY_PREVIEW, highlight };
  }
}
