import { positionPoints, type Drawing } from "@/components/drawing-model";
import type { ChartMarker } from "@/components/chart-panel";
import type { MarketAnalysis, PatternState } from "@/lib/algo/patterns";
import type { HourlyState } from "@/lib/algo/hourly-zone";
import type { ChannelState } from "@/lib/algo/trend-channel";

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
  const list: Drawing[] = [...hourlyDrawings(analysis.hourly, lastCandle, colors), ...channelDrawings(analysis.channel, lastCandle, colors)];
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

/** Tiny squares on the W / M pattern pivots (no text); Mathi Trend Channel's breakout and confirmation candles. */
export function algoPivotMarkers(analysis: MarketAnalysis | null | undefined, color: string, tones?: { profit: string; loss: string; warning: string }): ChartMarker[] {
  if (!analysis || !analysis.observationComplete) return [];
  const list: ChartMarker[] = channelMarkers(analysis.channel, color, tones ?? { profit: color, loss: color, warning: color });
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

/**
 * Mathi Trend Channel on the chart: the primary trendline (solid) through its two swings and the clone (dashed) through
 * the third, both rays to the right. The clone's second point is its anchor moved by the primary's own time and price
 * step, so the two lines are drawn with one slope at any zoom or scale. The swing points are labelled (H1, L1, H2 / L1,
 * H1, L2); every horizontal zone is a full-width line with its price on the axis (dotted once broken); each breakout
 * candle's high and low are short lines across it and the next candle.
 */
export function channelDrawings(channel: ChannelState | null | undefined, lastCandle: number, colors: { neckline: string; resistance?: string; support?: string }): Drawing[] {
  if (!channel) return [];
  const list: Drawing[] = [];
  const resistance = colors.resistance ?? colors.neckline;
  const support = colors.support ?? colors.neckline;
  const pattern = channel.pattern;
  if (pattern && channel.upper && channel.lower) {
    const primary = pattern.kind === "A" ? channel.upper : channel.lower;
    const clone = pattern.kind === "A" ? channel.lower : channel.upper;
    const [a, b] = primary.through;
    const [c] = clone.through;
    const color = pattern.kind === "A" ? resistance : support;
    const other = pattern.kind === "A" ? support : resistance;
    list.push({ id: `algo:channel:primary:${a.time}:${b.time}`, kind: "ray", points: [{ time: a.time, price: a.price }, { time: b.time, price: b.price }], color, width: 2, dash: "solid", locked: true });
    list.push({ id: `algo:channel:clone:${c.time}`, kind: "ray", points: [{ time: c.time, price: c.price }, { time: c.time + (b.time - a.time), price: c.price + clone.slope * (b.x - a.x) }], color: other, width: 2, dash: "dashed", locked: true });
    list.push({ id: `algo:channel:label:primary`, kind: "text", points: [{ time: b.time, price: b.price }], text: `Primary (${pattern.kind === "A" ? "H1–H2" : "L1–L2"})`, color, locked: true });
    list.push({ id: `algo:channel:label:clone`, kind: "text", points: [{ time: c.time, price: c.price }], text: `Parallel clone (${c.label})`, color: other, locked: true });
    for (const point of pattern.points) {
      list.push({ id: `algo:channel:swing:${point.label}:${point.time}`, kind: "text", points: [{ time: point.time, price: point.price }], text: `${point.label} ${price(point.price)}`, color: point.kind === "HIGH" ? resistance : support, locked: true });
    }
  }
  for (const zone of channel.zones) {
    const top = zone.kind === "RESISTANCE";
    list.push({ id: `algo:channel:zone:${zone.kind}:${zone.members[0].time}`, kind: "hline", points: [{ time: zone.members[0].time, price: top ? zone.high : zone.low }], color: top ? resistance : support, width: 1, dash: zone.brokenAt != null ? "dotted" : "dashed", locked: true });
  }
  for (const setup of channel.setups) {
    if (setup.status === "WATCH") continue;
    const right = Math.min(setup.confirm ? setup.confirm.end - 60 : setup.end - 60, lastCandle);
    for (const [side, value] of [["high", setup.high], ["low", setup.low]] as const) {
      list.push({ id: `algo:channel:bo:${setup.id}:${side}`, kind: "trend", points: [{ time: setup.time, price: value }, { time: Math.max(setup.time + 60, right), price: value }], color: colors.neckline, width: 1, dash: "dotted", locked: true });
    }
  }
  return list;
}

/** Mathi Trend Channel's candles: a WATCH (circle), a breakout / breakdown (arrow) and its next candle (square: confirmed or not). */
export function channelMarkers(channel: ChannelState | null | undefined, muted: string, tones: { profit: string; loss: string; warning: string }): ChartMarker[] {
  if (!channel) return [];
  const list: ChartMarker[] = [];
  for (const setup of channel.setups) {
    const call = setup.direction === "CALL";
    if (setup.status === "WATCH") {
      list.push({ id: `algo:channel:watch:${setup.id}`, time: setup.time, position: call ? "aboveBar" : "belowBar", shape: "circle", color: tones.warning, text: "", size: 0.5 });
      continue;
    }
    list.push({ id: `algo:channel:break:${setup.id}`, time: setup.time, position: call ? "belowBar" : "aboveBar", shape: call ? "arrowUp" : "arrowDown", color: call ? tones.profit : tones.loss, text: call ? "BO" : "BD", size: 0.7 });
    if (setup.confirm) list.push({ id: `algo:channel:confirm:${setup.id}`, time: setup.confirm.time, position: call ? "belowBar" : "aboveBar", shape: "square", color: setup.status === "CONFIRMED" ? (call ? tones.profit : tones.loss) : muted, text: setup.status === "CONFIRMED" ? (call ? "CALL" : "PUT") : "skip", size: 0.6 });
  }
  return list;
}
