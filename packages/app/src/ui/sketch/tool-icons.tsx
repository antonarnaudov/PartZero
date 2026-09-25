/**
 * The sketcher's icons: its tools, constraints and options, drawn from PartZero's one icon set
 * (`ui/shell/tool-icons.tsx`: 20 px grid, crisp 1.5 px strokes, the accent on what the tool makes).
 */
import type { ReactElement } from "react";
import type { ConstraintKind } from "../../sketch/constraints";
import type { ToolId } from "../../tools/sketch";
import { ToolIcon as Icon } from "../shell/tool-icons";

/** Sketch tool id → icon name (the rest share their name). */
const NAME: Partial<Record<ToolId, string>> = {
  rect2: "rectangle",
  circleCenter: "circle",
  arc3: "arc",
  fillet: "sketchFillet",
  chamfer: "sketchChamfer",
};

export function ToolIcon({ id, size = 18 }: { id: ToolId; size?: number }): ReactElement {
  return <Icon name={NAME[id] ?? id} size={size} />;
}

export function ConstraintIcon({ kind, size = 18 }: { kind: ConstraintKind; size?: number }): ReactElement {
  return <Icon name={`c-${kind}`} size={size} />;
}

export function ConstructionIcon({ size = 18 }: { size?: number }): ReactElement {
  return <Icon name="construction" size={size} />;
}

export function GridIcon({ size = 18 }: { size?: number }): ReactElement {
  return <Icon name="gridSnap" size={size} />;
}
