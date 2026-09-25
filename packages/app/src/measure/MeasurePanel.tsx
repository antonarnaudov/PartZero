/**
 * The Measure panel: measures whatever is selected, live. One entity: position, length,
 * radius/diameter, area, body volume; two: minimum distance, angle, centre/axis distance; more:
 * totals. Exact values are plain; approximate ones start with "≈".
 */
import type { ReactElement } from "react";
import { formatMeasurement, type MeasureResult } from "./measure";

export interface MeasurePanelProps {
  result: MeasureResult | null;
  count: number;
  onClose: () => void;
}

export function MeasurePanel({ result, count, onClose }: MeasurePanelProps): ReactElement {
  return (
    <div className="vp-panel vp-measure" data-testid="measure-panel" role="region" aria-label="Measure">
      <div className="vp-panel-head">
        <span className="vp-panel-title">Measure</span>
        {result && <span className="vp-panel-sub">{result.title}</span>}
        <span className="spacer" />
        <button type="button" className="vp-btn icon" title="Close (I)" aria-label="Close measure" onClick={onClose}>
          ✕
        </button>
      </div>
      {!result || result.rows.length === 0 ? (
        <div className="vp-measure-empty">{count === 0 ? "Select a vertex, edge, face or body — or two to measure between them (Shift-click)." : "Nothing measurable in the selection."}</div>
      ) : (
        <table className="vp-measure-table">
          <tbody>
            {result.rows.map((m) => (
              <tr key={m.id} data-measure={m.id} data-exact={m.exact ? "true" : "false"}>
                <th>{m.label}</th>
                <td className="mono" data-testid={`measure-${m.id}`} title={m.exact ? "Exact (from the B-rep)" : "Approximate (from the display mesh)"}>
                  {formatMeasurement(m)}
                </td>
                <td>
                  <button type="button" className="vp-copy" title="Copy value" aria-label={`Copy ${m.label}`} onClick={() => void navigator.clipboard?.writeText(String(Number(m.value.toFixed(6))))}>
                    ⧉
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
