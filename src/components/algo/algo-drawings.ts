import { positionPoints, type Drawing } from "@/components/drawing-model";
import type { ChartMarker } from "@/components/chart-panel";
import type { MarketAnalysis, PatternState } from "@/lib/algo/patterns";
import type { HourlyState } from "@/lib/algo/hourly-zone";

/**
 * The Algo's market analysis drawn on the chart from the same stored analysis the dashboard reads.
 * Nothing is drawn while the opening is still being observed (09:15–09:45 by default): the algo first
 * reads the market. From then on: the auto trendlines as rays through their two fixed swing points
 * (extended to the right, so the level a breakout must clear is visible ahead), W / M necklines (dashed
 * while the pattern is still forming, solid once confirmed; not drawn once invalidated or expired) and
 * tiny squares on the pattern's pivots. Read-only, with stable ids, so a redraw never duplicates anything.
 */
export function algoAnalysisDrawings(analysis: MarketAnalysis | null | undefined, colors: { trendline: string; neckline: string; resistance?: string; support?: string }): Drawing[] {
  if (!analysis || !analysis.observationComplete) return [];
  const lastCandle = analysis.asOf - 60;
  const list: Drawing[] = hourlyDrawings(analysis.hourly, lastCandle, colors);
  // Only what the switched-on strategies use is drawn.
  const on = (id: "trendline" | "w" | "m" | "orb") => analysis.strategies[id]?.enabled !== false;
  for (const line of on("trendline") ? [analysis.resistance, analysis.support] : []) {
    if (!line) continue;
    list.push({
      id: `algo:trendline:${line.kind.toLowerCase()}`,
      kind: "ray",
      points: [{ time: line.a.time, price: line.a.price }, { time: line.b.time, price: line.b.price }],
      color: (line.kind === "RESISTANCE" ? colors.resistance : colors.support) ?? colors.trendline,
      width: 1,
      dash: "solid",
      locked: true,
    });
  }
  // Broken lines: dashed, up to the candle that broke them.
  for (const line of on("trendline") ? analysis.brokenLines ?? [] : []) {
    list.push({ id: `algo:trendline:broken:${line.kind.toLowerCase()}:${line.a.time}:${line.b.time}`, kind: "trend", points: [{ time: line.a.time, price: line.a.price }, { time: line.brokenAt.time, price: line.brokenAt.price }], color: (line.kind === "RESISTANCE" ? colors.resistance : colors.support) ?? colors.trendline, width: 1, dash: "dashed", locked: true });
  }
  // The opening range of the opening-range breakout, once complete (dotted, from the open to the latest candle).
  if (on("orb") && analysis.orb?.complete) {
    for (const [side, price] of [["high", analysis.orb.high], ["low", analysis.orb.low]] as const) {
      list.push({ id: `algo:orb:${side}`, kind: "trend", points: [{ time: analysis.sessionOpen, price }, { time: lastCandle, price }], color: colors.neckline, width: 1, dash: "dotted", locked: true });
    }
  }
  for (const pattern of [on("w") ? analysis.w : null, on("m") ? analysis.m : null]) {
    if (!pattern || pattern.status === "INVALIDATED" || pattern.status === "EXPIRED") continue;
    list.push({
      id: `algo:neckline:${pattern.kind}`,
      kind: "trend",
      points: [{ time: pattern.first.time, price: pattern.neckline }, { time: lastCandle, price: pattern.neckline }],
      color: colors.neckline,
      width: 1,
      dash: pattern.confirmed ? "solid" : "dashed",
      locked: true,
    });
  }
  return list;
}

/** Tiny squares on the W / M pattern pivots (no text). */
export function algoPivotMarkers(analysis: MarketAnalysis | null | undefined, color: string): ChartMarker[] {
  if (!analysis || !analysis.observationComplete) return [];
  const list: ChartMarker[] = [];
  const add = (pattern: PatternState | null) => {
    if (!pattern || pattern.status === "INVALIDATED" || pattern.status === "EXPIRED") return;
    for (const pivot of [pattern.first, pattern.middle, pattern.second]) {
      if (!pivot) continue;
      list.push({ id: `algo:pivot:${pattern.kind}:${pivot.kind}:${pivot.time}`, time: pivot.time, position: pivot.kind === "HIGH" ? "aboveBar" : "belowBar", shape: "square", color, text: "", size: 0.4 });
    }
  };
  // A breakout (up arrow under the candle) or breakdown (down arrow above it) where a trendline broke.
  if (analysis.strategies.trendline?.enabled !== false) {
    for (const line of analysis.brokenLines ?? []) {
      const up = line.kind === "RESISTANCE";
      list.push({ id: `algo:break:${line.kind}:${line.brokenAt.time}`, time: line.brokenAt.time, position: up ? "belowBar" : "aboveBar", shape: up ? "arrowUp" : "arrowDown", color, text: "", size: 0.6 });
    }
  }
  if (analysis.strategies.w?.enabled !== false) add(analysis.w);
  if (analysis.strategies.m?.enabled !== false) add(analysis.m);
  return list;
}

const price = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Mathi Hourly Zone Strategy on the chart: each pair's reference as a Long / Short position zone (the same boxes as the
 * drawing tool: the permitted side in green over a LONG reference / under a SHORT one, the losing side in red), fixed at
 * the first candle's close, spanning the two hours it reads and, once traded, the trade to its exit. Its one label
 * says the direction, reference, status and the option's entry and +5% target (an option price, not an index level).
 * Each midpoint the trade was checked against is a short dashed line across its hour. A doji is a dotted line only.
 */
export function hourlyDrawings(hourly: HourlyState | null | undefined, lastCandle: number, colors: { neckline: string; resistance?: string; support?: string }): Drawing[] {
  if (!hourly) return [];
  const list: Drawing[] = [];
  const trades = hourly.trades ?? [];
  for (const pair of hourly.pairs) {
    const id = `algo:hourly:${pair.decisionTime}`;
    if (!pair.direction) {
      list.push({ id: `${id}:doji`, kind: "trend", points: [{ time: pair.first.start, price: pair.reference }, { time: Math.min(pair.decisionTime, lastCandle), price: pair.reference }], color: colors.neckline, width: 1, dash: "dotted", locked: true });
      list.push({ id: `${id}:doji-label`, kind: "text", points: [{ time: pair.first.start, price: pair.reference }], text: `Doji ref ${price(pair.reference)} · SKIPPED`, color: colors.neckline, locked: true });
      continue;
    }
    const trade = trades.find((item) => item.decisionTime === pair.decisionTime) ?? null;
    const status = trade ? trade.status : pair.status;
    const right = Math.max(pair.first.start + 60, Math.min(trade ? trade.exitTime ?? lastCandle : pair.second?.complete ? pair.decisionTime - 60 : lastCandle, lastCandle));
    // The box as the strategy reads it (its edges when set), else the first candle's range.
    const height = pair.box ? pair.box.top - pair.reference : Math.max(pair.first.high - pair.first.low, pair.reference * 0.0005);
    const long = pair.direction === "LONG";
    const option = trade ? ` · ${trade.side} ₹${price(trade.premium)} → ₹${price(trade.target)} (+${Math.round((trade.target / trade.premium - 1) * 1000) / 10}%)${trade.exitPremium != null ? ` · exit ₹${price(trade.exitPremium)}` : ""}` : "";
    list.push({
      id,
      kind: long ? "long" : "short",
      points: positionPoints({ left: pair.first.start, right, entry: pair.reference, stop: long ? pair.reference - height : pair.reference + height, target: long ? pair.reference + height : pair.reference - height }),
      text: `${pair.direction} ref ${price(pair.reference)} · ${status}${trade?.shadow ? " (shadow)" : ""}${option}`,
      color: long ? colors.support ?? colors.neckline : colors.resistance ?? colors.neckline,
      width: 1,
      locked: true,
    });
    for (const check of trade?.midpoints ?? []) {
      if (check.end - 60 > lastCandle) continue;
      list.push({ id: `${id}:mid:${check.start}`, kind: "trend", points: [{ time: check.start, price: check.mid }, { time: check.end - 60, price: check.mid }], color: check.keep ? colors.neckline : colors.resistance ?? colors.neckline, width: 1, dash: "dashed", locked: true });
    }
  }
  return list;
}
