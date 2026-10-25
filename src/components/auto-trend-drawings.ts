import type { Drawing } from "@/components/drawing-model";
import type { ChartMarker } from "@/components/chart-panel";
import { AUTO_TREND_DEFAULTS, readAutoTrendSettings, type AutoTrend, type AutoTrendSettings, type Swing } from "@/lib/chart/trend-engine";

/**
 * The auto trendline engine's result as chart overlays: read-only drawings in chart time / price
 * coordinates with stable ids (a redraw reconciles, never duplicates), so zooming, panning and timeframe
 * changes keep them on their candles. Active lines are rays (extended to the right); a broken line is drawn
 * dashed up to the candle that broke it; levels are horizontal rays from their first swing.
 */
export function autoTrendDrawings(trend: AutoTrend | null, settings: AutoTrendSettings): Drawing[] {
  if (!trend || trend.phase !== "ACTIVE") return [];
  const list: Drawing[] = [];
  const colorOf = (kind: "SUPPORT" | "RESISTANCE") => (kind === "SUPPORT" ? settings.colors.support : settings.colors.resistance);
  if (settings.trendlines) {
    for (const line of [trend.support, trend.resistance]) {
      if (!line) continue;
      list.push({ id: line.id, kind: "ray", points: [{ time: line.a.time, price: line.a.price }, { time: line.b.time, price: line.b.price }], color: colorOf(line.kind), width: 2, dash: "solid", locked: true });
    }
    for (const line of trend.brokenLines) {
      if (!line.broken) continue;
      list.push({ id: `${line.id}:broken`, kind: "trend", points: [{ time: line.a.time, price: line.a.price }, { time: line.broken.time, price: line.broken.price }], color: colorOf(line.kind), width: 1, dash: "dashed", locked: true });
    }
  }
  if (settings.levels) {
    for (const level of trend.levels) {
      list.push({ id: level.id, kind: "hray", points: [{ time: level.from, price: level.price }], color: level.kind === "SUPPORT" ? settings.colors.supportLevel : settings.colors.resistanceLevel, width: 1, dash: level.source === "OPENING_RANGE" ? "dotted" : "dashed", locked: true });
    }
  }
  return list;
}

/** Small dots on the swing points the drawn lines and levels use; a provisional swing in the muted color. */
export function autoTrendMarkers(trend: AutoTrend | null, settings: AutoTrendSettings, muted: string): ChartMarker[] {
  if (!trend || trend.phase !== "ACTIVE") return [];
  const markers = new Map<string, ChartMarker>();
  // Breakout / breakdown arrows at the candle whose close broke a line.
  if (settings.breaks && settings.trendlines) {
    for (const line of trend.brokenLines) {
      if (!line.broken) continue;
      const up = line.kind === "RESISTANCE";
      const id = `auto:break:${line.id}`;
      markers.set(id, { id, time: line.broken.time, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown", color: up ? settings.colors.support : settings.colors.resistance, text: "", size: 0.7 });
    }
  }
  if (!settings.markers) return [...markers.values()];
  const add = (swing: Swing, color: string, size = 0.5) => {
    const id = `auto:swing:${swing.kind}:${swing.time}`;
    if (!markers.has(id)) markers.set(id, { id, time: swing.time, position: swing.kind === "HIGH" ? "aboveBar" : "belowBar", shape: "circle", color, text: "", size });
  };
  if (settings.trendlines) {
    for (const line of [trend.support, trend.resistance, ...trend.brokenLines]) {
      if (!line) continue;
      const color = line.kind === "SUPPORT" ? settings.colors.support : settings.colors.resistance;
      add(line.a, color);
      add(line.b, color);
    }
  }
  if (settings.levels) {
    for (const level of trend.levels) for (const member of level.members) add(member, level.kind === "SUPPORT" ? settings.colors.supportLevel : settings.colors.resistanceLevel);
  }
  for (const swing of trend.provisional) add(swing, muted, 0.4);
  return [...markers.values()];
}

const KEY = "td-auto-trend";

export function loadAutoTrendSettings(): AutoTrendSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? readAutoTrendSettings(JSON.parse(raw)) : AUTO_TREND_DEFAULTS;
  } catch {
    return AUTO_TREND_DEFAULTS;
  }
}

export function saveAutoTrendSettings(settings: AutoTrendSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: settings last for this page only.
  }
}
