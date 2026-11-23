/**
 * Line Strategy Draw: each of our strategies' price lines, switched on per strategy, for a chosen current day and
 * previous day (or Auto).
 *
 * This module is pure (no React, no database): the strategy catalogue, the saved config and its validation (shared by
 * the API and the panel), and buildLineOverlays(), which turns the enabled strategies plus each one's session data
 * into read-only chart drawings. It never changes how any strategy computes or trades: every level comes from the same
 * helpers the strategies use (S1 boxes from s1Levels, hourly candles from hourlyCandles, the channel from
 * channelSignal).
 *
 * Every chart object it makes has an id `lines:<drawingId>:<lineId>`, so:
 *  - the chart draws it read-only and never saves it with the user's own drawings (like `strategy:` overlays);
 *  - the same id is produced on every render, so switching one strategy on or off changes only its own objects.
 */
import type { Drawing, DrawingTextStyle, LineDash } from "@/components/drawing-model";
import { CHART_SPANS, type ChartSpan } from "@/lib/market/spans";
import { s1Levels, s1Reveal, type S1Data } from "@/lib/trading/s1";
import type { Candle } from "@/lib/algo/lines";
import { hourlyCandles } from "@/lib/algo/hourly-zone";
import { CHANNEL_SETTINGS_DEFAULTS, channelPriceAt, channelSignal } from "@/lib/algo/trend-channel";

export const LINES_PREFIX = "lines:";
export const MAX_LINE_DRAWINGS = 50;
export const MAX_LINES_PER_DRAWING = 24;

export type LevelKind =
  | "pdh" | "pdl" | "pdc" | "pdm"
  | "open"
  | "or_high" | "or_low"
  | "boxA_top" | "boxA_mid" | "boxA_bottom"
  | "boxB_top" | "boxB_mid" | "boxB_bottom"
  | "h1_high" | "h1_low" | "h1_close" | "h1_mid"
  | "h2_high" | "h2_low"
  | "m1315_high" | "m1315_low"
  | "ch_upper" | "ch_lower";

export type LineExtend = "right" | "session" | "full";

export type LevelLine = {
  /** Stable id within its drawing (part of the chart object id). */
  id: string;
  kind: LevelKind;
  name: string;
  visible: boolean;
  color: string;
  width: 1 | 2 | 3 | 4;
  dash: LineDash;
  /** Show the price in the line's label. */
  showPrice: boolean;
  /** Show the level's name in the line's label. */
  showName: boolean;
  extend: LineExtend;
};

export type LineStrategyId = "mathi" | "hourly_zone" | "second_hour" | "breakout_0915" | "minute_1315" | "trend_channel";

/** `currentDay` / `previousDay`: YYYY-MM-DD, or "" for Auto. `entry`: mark the strategy's entry point on the chart. */
export type LineDrawingConfig = { strategy: LineStrategyId | null; currentDay: string; previousDay: string; entry: boolean; lines: LevelLine[] };

/** A saved strategy row as the API returns it. `symbol` "*" = every symbol; `timeframe` "all" = every timeframe. */
export type LineDrawing = {
  id: string;
  name: string;
  symbol: string;
  timeframe: ChartSpan | "all";
  enabled: boolean;
  config: LineDrawingConfig;
  createdAt: string;
  updatedAt: string;
};

/** Where a level's price comes from: the session levels (S1 data) or the day's 1-minute candles ("tape"). */
type Needs = "previous" | "open" | "opening" | "boxA" | "boxB" | "tape";

export const LEVELS: Record<LevelKind, { label: string; needs: Needs }> = {
  pdh: { label: "Previous day high", needs: "previous" },
  pdl: { label: "Previous day low", needs: "previous" },
  pdc: { label: "Previous day close", needs: "previous" },
  pdm: { label: "Previous day midpoint", needs: "previous" },
  open: { label: "Today's open", needs: "open" },
  or_high: { label: "09:15 candle high", needs: "opening" },
  or_low: { label: "09:15 candle low", needs: "opening" },
  boxA_top: { label: "Previous-day box top", needs: "boxA" },
  boxA_mid: { label: "Previous-day box mid (prev close)", needs: "boxA" },
  boxA_bottom: { label: "Previous-day box bottom", needs: "boxA" },
  boxB_top: { label: "Today's-open box top", needs: "boxB" },
  boxB_mid: { label: "Today's-open box mid (open)", needs: "boxB" },
  boxB_bottom: { label: "Today's-open box bottom", needs: "boxB" },
  h1_high: { label: "09:15 hour high", needs: "tape" },
  h1_low: { label: "09:15 hour low", needs: "tape" },
  h1_close: { label: "09:15 hour close", needs: "tape" },
  h1_mid: { label: "09:15 hour midpoint", needs: "tape" },
  h2_high: { label: "10:15 hour high", needs: "tape" },
  h2_low: { label: "10:15 hour low", needs: "tape" },
  m1315_high: { label: "13:15 candle high", needs: "tape" },
  m1315_low: { label: "13:15 candle low", needs: "tape" },
  ch_upper: { label: "Channel upper line", needs: "tape" },
  ch_lower: { label: "Channel lower line", needs: "tape" },
};
export const LEVEL_KINDS = Object.keys(LEVELS) as LevelKind[];

const HEX = /^#[0-9a-fA-F]{6}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_COLORS: Record<LevelKind, string> = {
  pdh: "#089981", pdl: "#F23645", pdc: "#2962FF", pdm: "#787B86", open: "#F0B90B", or_high: "#15803D", or_low: "#15803D",
  boxA_top: "#7E22CE", boxA_mid: "#7E22CE", boxA_bottom: "#7E22CE", boxB_top: "#C2410C", boxB_mid: "#C2410C", boxB_bottom: "#C2410C",
  h1_high: "#089981", h1_low: "#F23645", h1_close: "#2962FF", h1_mid: "#787B86", h2_high: "#15803D", h2_low: "#DC2626",
  m1315_high: "#15803D", m1315_low: "#DC2626", ch_upper: "#0EA5E9", ch_lower: "#0EA5E9",
};
const SHORT_NAMES: Record<LevelKind, string> = {
  pdh: "PDH", pdl: "PDL", pdc: "PDC", pdm: "PD Mid", open: "Open", or_high: "9:15 High", or_low: "9:15 Low",
  boxA_top: "A Top", boxA_mid: "A Mid", boxA_bottom: "A Bottom", boxB_top: "B Top", boxB_mid: "B Mid", boxB_bottom: "B Bottom",
  h1_high: "H1 High", h1_low: "H1 Low", h1_close: "H1 Close", h1_mid: "H1 Mid", h2_high: "H2 High", h2_low: "H2 Low",
  m1315_high: "13:15 High", m1315_low: "13:15 Low", ch_upper: "Channel Upper", ch_lower: "Channel Lower",
};

/** Previous-day lines every strategy offers (off unless the strategy itself uses them). */
const PREVIOUS: Array<{ kind: LevelKind; on?: boolean; name?: string }> = [{ kind: "pdh" }, { kind: "pdl" }, { kind: "pdc" }];

/** Our strategies whose levels sit on the index chart, with the lines each one draws (`on` = shown by default). */
export const LINE_STRATEGIES: Array<{ id: LineStrategyId; name: string; short: string; about: string; lines: Array<{ kind: LevelKind; on?: boolean; name?: string }> }> = [
  {
    id: "mathi",
    short: "Mathi",
    name: "Mathi Strategy",
    about: "Previous-day box (A), today's-open box (B), 09:15 high / low",
    lines: [
      { kind: "boxA_top", on: true }, { kind: "boxA_mid", on: true }, { kind: "boxA_bottom", on: true },
      { kind: "boxB_top", on: true }, { kind: "boxB_mid", on: true }, { kind: "boxB_bottom", on: true },
      { kind: "or_high", on: true }, { kind: "or_low", on: true }, { kind: "open" }, ...PREVIOUS,
    ],
  },
  {
    id: "hourly_zone",
    short: "Zone",
    name: "Mathi Hourly Zone Strategy — 5%",
    about: "09:15 hour reference (its close), high / low and the 10:15 hour",
    lines: [
      { kind: "h1_close", on: true, name: "Reference (H1 close)" }, { kind: "h1_high", on: true }, { kind: "h1_low", on: true }, { kind: "h1_mid" },
      { kind: "h2_high", on: true }, { kind: "h2_low", on: true }, ...PREVIOUS,
    ],
  },
  {
    id: "second_hour",
    short: "2nd Hr",
    name: "Mathi Second Hour (Hourly Breakout)",
    about: "10:15–11:15 candle: high = CALL level, low = PUT level",
    lines: [{ kind: "h2_high", on: true, name: "CALL level (H2 high)" }, { kind: "h2_low", on: true, name: "PUT level (H2 low)" }, ...PREVIOUS],
  },
  {
    id: "breakout_0915",
    short: "9:15",
    name: "Mathi Breakout – 9:15",
    about: "09:15 1-minute candle high / low",
    lines: [{ kind: "or_high", on: true, name: "CALL above 9:15 High" }, { kind: "or_low", on: true, name: "PUT below 9:15 Low" }, { kind: "open" }, ...PREVIOUS],
  },
  {
    id: "minute_1315",
    short: "13:15",
    name: "Mathi 13:15 Minute",
    about: "13:15 1-minute candle high / low",
    lines: [{ kind: "m1315_high", on: true, name: "CALL above 13:15 High" }, { kind: "m1315_low", on: true, name: "PUT below 13:15 Low" }, ...PREVIOUS],
  },
  {
    id: "trend_channel",
    short: "Channel",
    name: "Mathi Trend Channel",
    about: "3-minute channel: primary trendline and its parallel clone",
    lines: [{ kind: "ch_upper", on: true }, { kind: "ch_lower", on: true }, ...PREVIOUS],
  },
];
export const LINE_STRATEGY_IDS = LINE_STRATEGIES.map((item) => item.id);
export const strategyDef = (id: LineStrategyId | null) => LINE_STRATEGIES.find((item) => item.id === id) ?? null;

/** A new line of a kind with that kind's default name, colour and style. */
export function newLine(kind: LevelKind, patch: Partial<LevelLine> = {}): LevelLine {
  return {
    id: kind, kind, name: SHORT_NAMES[kind], visible: true, color: DEFAULT_COLORS[kind], width: 1,
    dash: kind === "pdm" || kind === "h1_mid" || kind.endsWith("_mid") ? "dashed" : "solid", showPrice: true, showName: true, extend: "right", ...patch,
  };
}

/** A strategy's starting config: its lines with their defaults, both days on Auto. */
export function defaultConfig(id: LineStrategyId): LineDrawingConfig {
  const def = strategyDef(id)!;
  return { strategy: id, currentDay: "", previousDay: "", entry: true, lines: def.lines.map((item) => newLine(item.kind, { visible: Boolean(item.on), ...(item.name ? { name: item.name } : {}) })) };
}

function cleanLine(value: unknown, index: number, seen: Set<string>): LevelLine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<LevelLine>;
  const kind = LEVEL_KINDS.includes(row.kind as LevelKind) ? (row.kind as LevelKind) : null;
  if (!kind) return null;
  let id = typeof row.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(row.id) ? row.id : `l${index}`;
  while (seen.has(id)) id = `${id}_${index}`;
  seen.add(id);
  const name = typeof row.name === "string" ? row.name.trim().slice(0, 40) : "";
  return {
    id, kind, name: name || SHORT_NAMES[kind],
    visible: row.visible !== false,
    color: typeof row.color === "string" && HEX.test(row.color) ? row.color : DEFAULT_COLORS[kind],
    width: row.width === 2 || row.width === 3 || row.width === 4 ? row.width : 1,
    dash: row.dash === "dashed" || row.dash === "dotted" ? row.dash : "solid",
    showPrice: row.showPrice !== false,
    showName: row.showName !== false,
    extend: row.extend === "session" || row.extend === "full" ? row.extend : "right",
  };
}

/** Validates a config from the client or the database; unknown kinds, bad colours or dates are dropped / defaulted. */
export function normalizeConfig(value: unknown): LineDrawingConfig {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof LineDrawingConfig, unknown>>;
  const strategy = LINE_STRATEGY_IDS.includes(raw.strategy as LineStrategyId) ? (raw.strategy as LineStrategyId) : null;
  const currentDay = typeof raw.currentDay === "string" && DAY.test(raw.currentDay) ? raw.currentDay : "";
  let previousDay = typeof raw.previousDay === "string" && DAY.test(raw.previousDay) ? raw.previousDay : "";
  if (previousDay && currentDay && previousDay >= currentDay) previousDay = "";
  const rows = Array.isArray(raw.lines) ? raw.lines : [];
  const seen = new Set<string>();
  const lines = rows.slice(0, MAX_LINES_PER_DRAWING).map((row, index) => cleanLine(row, index, seen)).filter((row): row is LevelLine => row != null);
  return { strategy, currentDay, previousDay, entry: raw.entry !== false, lines };
}

export function normalizeTimeframe(value: unknown): ChartSpan | "all" {
  return typeof value === "string" && (CHART_SPANS as readonly string[]).includes(value) ? (value as ChartSpan) : "all";
}

export function normalizeSymbol(value: unknown) {
  const symbol = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9&._-]{1,40}$/.test(symbol) ? symbol : "*";
}

/** Whether a drawing belongs on a chart of `symbol` at `span`. */
export function appliesTo(drawing: Pick<LineDrawing, "symbol" | "timeframe">, symbol: string, span: string) {
  return (drawing.symbol === "*" || drawing.symbol === symbol.toUpperCase()) && (drawing.timeframe === "all" || drawing.timeframe === span);
}

/** Strategies whose entry point is computed from the day's candles (Mathi Strategy's entries come from the Algo). */
export const marksEntry = (strategy: LineStrategyId | null) => strategy != null && strategy !== "mathi";

/** True when any visible line, or the entry point, needs the day's 1-minute candles. */
export function needsTape(drawing: Pick<LineDrawing, "config">) {
  return (drawing.config.entry && marksEntry(drawing.config.strategy)) || drawing.config.lines.some((line) => line.visible && LEVELS[line.kind].needs === "tape");
}

/**
 * The session data one strategy row needs: its current day (its own date, else the replayed date, else live / Auto),
 * its previous day (its own, else Auto), and whether the day's candles are needed. Rows asking for the same thing
 * share one request (`key`).
 */
export function dayRequest(drawing: LineDrawing, symbol: string, replayDate: string | null) {
  const date = drawing.config.currentDay || replayDate || null;
  const previous = drawing.config.previousDay && (!date || drawing.config.previousDay < date) ? drawing.config.previousDay : null;
  const tape = needsTape(drawing);
  // India VIX candles: only the 13:15 Minute entry rules use them.
  const vix = tape && drawing.config.entry && drawing.config.strategy === "minute_1315";
  return { key: `${symbol.toUpperCase()}|${date ?? "live"}|${previous ?? "auto"}|${tape ? 1 : 0}${vix ? "v" : ""}`, symbol: symbol.toUpperCase(), date, previous, tape, vix };
}

export function formatLevel(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** One session's data: the levels (S1Data, same as the Strategy) and, when asked for, its 1-minute candles. */
export type LineDay = { data: S1Data | null; tape: Candle[] | null; vix?: Candle[] | null };

/** A resolved level: flat from `start` at `value`, or a sloped segment to `end` (the channel). */
export type Resolved = { value: number; start: number | null; end?: { time: number; price: number } };

/**
 * Every level of one session, as known at `cursor` (replay clock) or `now` (live): nothing is shown before it existed.
 * Hours are complete hours only (hourlyCandles), the 13:15 candle once it has closed, the channel once it has formed.
 */
export function resolveLevels(day: LineDay | null, cursor: number | null, now: number): Partial<Record<LevelKind, Resolved>> {
  const out: Partial<Record<LevelKind, Resolved>> = {};
  const data = day?.data;
  if (!data) return out;
  const clock = cursor ?? now;
  const p = data.previous;
  const prevStart = data.anchors?.previous ?? data.sessionOpen;
  if (p) {
    out.pdh = { value: p.high, start: prevStart };
    out.pdl = { value: p.low, start: prevStart };
    out.pdc = { value: p.close, start: prevStart };
    out.pdm = { value: (p.high + p.low) / 2, start: prevStart };
    const levels = s1Levels(p, data.open, data.firstMinute);
    if (levels) {
      const show = s1Reveal(data, levels, cursor);
      if (data.open != null && show.openBox) out.open = { value: data.open, start: data.sessionOpen };
      if (levels.openingRange && show.openingRange) {
        out.or_high = { value: levels.openingRange.high, start: levels.openingRange.time };
        out.or_low = { value: levels.openingRange.low, start: levels.openingRange.time };
      }
      out.boxA_top = { value: levels.closeBox.top, start: prevStart };
      out.boxA_mid = { value: levels.closeBox.mid, start: prevStart };
      out.boxA_bottom = { value: levels.closeBox.bottom, start: prevStart };
      if (levels.openBox && show.openBox) {
        out.boxB_top = { value: levels.openBox.top, start: data.sessionOpen };
        out.boxB_mid = { value: levels.openBox.mid, start: data.sessionOpen };
        out.boxB_bottom = { value: levels.openBox.bottom, start: data.sessionOpen };
      }
    }
  } else if (data.firstMinute && (cursor == null || cursor >= data.firstMinute.time + 60)) {
    // No previous session: the 09:15 candle is still known.
    out.or_high = { value: data.firstMinute.high, start: data.firstMinute.time };
    out.or_low = { value: data.firstMinute.low, start: data.firstMinute.time };
  }
  const open = data.sessionOpen;
  const tape = (day.tape ?? []).filter((bar) => bar.time >= open && bar.time < data.sessionClose && bar.time + 60 <= clock);
  if (!tape.length) return out;
  const hours = hourlyCandles(tape, open, clock).filter((hour) => hour.complete && hour.end - hour.start === 3_600);
  const h1 = hours.find((hour) => hour.start === open);
  const h2 = hours.find((hour) => hour.start === open + 3_600);
  if (h1) {
    out.h1_high = { value: h1.high, start: h1.start };
    out.h1_low = { value: h1.low, start: h1.start };
    out.h1_close = { value: h1.close, start: h1.start };
    out.h1_mid = { value: (h1.high + h1.low) / 2, start: h1.start };
  }
  if (h2) {
    out.h2_high = { value: h2.high, start: h2.start };
    out.h2_low = { value: h2.low, start: h2.start };
  }
  const m1315 = tape.find((bar) => bar.time === open + 4 * 3_600);
  if (m1315) {
    out.m1315_high = { value: m1315.high, start: m1315.time };
    out.m1315_low = { value: m1315.low, start: m1315.time };
  }
  const { state } = channelSignal(tape, open, CHANNEL_SETTINGS_DEFAULTS, Math.min(clock, data.sessionClose));
  const from = state.pattern?.points[0]?.time;
  if (from != null && state.upper && state.lower) {
    const to = data.sessionClose;
    for (const [kind, line] of [["ch_upper", state.upper], ["ch_lower", state.lower]] as const) {
      out[kind] = { value: round(channelPriceAt(line, from, open)), start: from, end: { time: to, price: round(channelPriceAt(line, to, open)) } };
    }
  }
  return out;
}

const round = (value: number) => Math.round(value * 100) / 100;

function caption(color: string): DrawingTextStyle {
  return { size: 11, bold: true, italic: false, color, align: "left", valign: "top", visible: true };
}

/** How the chart finds each strategy row's session data, replay clock and "now" (seconds). */
export type DayLookup = (drawing: LineDrawing) => { day: LineDay | null; cursor: number | null; now: number };

/**
 * The chart objects for every enabled strategy that applies to this chart. Lines with the same price (to the paisa)
 * and the same style become one object whose label lists every level's name, so nothing is drawn twice. A level whose
 * data is missing (or not reached yet, live or in replay) is skipped.
 */
export function buildLineOverlays(drawings: LineDrawing[], ctx: { symbol: string; span: string; dayFor: DayLookup }): Drawing[] {
  type Item = { id: string; line: LevelLine; resolved: Resolved; label: string; sessionClose: number | null; sessionOpen: number | null };
  const items: Item[] = [];
  for (const drawing of drawings) {
    if (!drawing.enabled || !drawing.config.strategy || !appliesTo(drawing, ctx.symbol, ctx.span)) continue;
    const { day, cursor, now } = ctx.dayFor(drawing);
    const data = day?.data && day.data.symbol.toUpperCase() === ctx.symbol.toUpperCase() ? day.data : null;
    const levels = resolveLevels(data ? { data, tape: day?.tape ?? null } : null, cursor, now);
    for (const line of drawing.config.lines) {
      if (!line.visible) continue;
      const resolved = levels[line.kind];
      if (!resolved || !Number.isFinite(resolved.value) || resolved.value <= 0) continue;
      const label = [line.showName ? line.name : "", line.showPrice && !resolved.end ? formatLevel(resolved.value) : ""].filter(Boolean).join(" ");
      items.push({ id: `${LINES_PREFIX}${drawing.id}:${line.id}`, line, resolved, label, sessionClose: data?.sessionClose ?? null, sessionOpen: data?.sessionOpen ?? null });
    }
  }
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const { resolved, line } = item;
    const where = resolved.end ? `${resolved.start}:${Math.round(resolved.value * 100)}>${resolved.end.time}:${Math.round(resolved.end.price * 100)}` : `${Math.round(resolved.value * 100)}`;
    const key = `${where}|${line.color}|${line.width}|${line.dash}|${resolved.end ? "slope" : line.extend}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const out: Drawing[] = [];
  for (const group of groups.values()) {
    const head = group[0];
    const { resolved, line } = head;
    const labels = [...new Set(group.map((item) => item.label).filter(Boolean))];
    const text = labels.join(" · ") || undefined;
    const base = { id: head.id, color: line.color, width: line.width, dash: line.dash, text, textStyle: caption(line.color), locked: true } as const;
    if (resolved.end && resolved.start != null) {
      out.push({ ...base, kind: "trend", points: [{ time: resolved.start, price: resolved.value }, { time: resolved.end.time, price: resolved.end.price }] });
    } else if (line.extend === "full" || resolved.start == null) {
      out.push({ ...base, kind: "hline", points: [{ time: resolved.start ?? head.sessionOpen ?? 0, price: resolved.value }] });
    } else if (line.extend === "session" && head.sessionOpen != null && head.sessionClose != null) {
      out.push({ ...base, kind: "trend", points: [{ time: Math.max(resolved.start, head.sessionOpen), price: resolved.value }, { time: head.sessionClose, price: resolved.value }] });
    } else {
      out.push({ ...base, kind: "hray", points: [{ time: resolved.start, price: resolved.value }] });
    }
  }
  return out;
}
