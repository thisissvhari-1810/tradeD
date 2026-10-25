import type { ChartMarker } from "@/components/chart-panel";
import type { TradeMarker } from "@/lib/algo/chart-replay";

/** Marker sizes: small by default, a little larger for the trade selected in the panel. */
export const MARKER_SIZE = 0.6;
export const SELECTED_MARKER_SIZE = 1;

/**
 * The Algo's trade markers as drawn on the chart: a small green up-triangle for a CALL entry, a small red
 * down-triangle for a PUT entry, and a small dot for each exit (green profit, red loss, grey break-even).
 * No text: details are in the hover tooltip and the Algo panel. One marker per trade event.
 */
export function algoChartMarkers(trades: TradeMarker[], tokens: { profit: string; loss: string; muted: string }, selected: string | null): ChartMarker[] {
  const seen = new Set<string>();
  const list: ChartMarker[] = [];
  for (const marker of trades) {
    if (seen.has(marker.id)) continue;
    seen.add(marker.id);
    const size = marker.entryKey === selected ? SELECTED_MARKER_SIZE : MARKER_SIZE;
    if (marker.kind === "entry") {
      const call = marker.side === "CALL";
      list.push({ id: marker.id, time: marker.time, position: call ? "belowBar" : "aboveBar", shape: call ? "arrowUp" : "arrowDown", color: call ? tokens.profit : tokens.loss, text: "", size });
    } else {
      const pnl = marker.pnl ?? 0;
      list.push({ id: marker.id, time: marker.time, position: marker.side === "CALL" ? "aboveBar" : "belowBar", shape: "circle", color: pnl > 0 ? tokens.profit : pnl < 0 ? tokens.loss : tokens.muted, text: "", size });
    }
  }
  return list;
}
