import { s1Levels, type S1Data } from "@/lib/trading/s1";

/**
 * The price levels the Algo monitors, taken from the Strategy section's own calculation (s1Levels, the
 * same one the chart draws) — never from screen positions. Each level has a stable id for the session,
 * its price, the moment it became known (so it is never "crossed" before it existed) and its type.
 */

/** A 1-minute candle (`volume` when the feed provides it; index candles often have none). */
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume?: number };

export type LineType =
  | "prev-box-top" | "prev-box-mid" | "prev-box-bottom"
  | "today-box-top" | "today-box-mid" | "today-box-bottom"
  | "prev-high" | "prev-low" | "prev-close" | "prev-mid"
  | "today-open" | "or-high" | "or-low"
  | "custom";

export type AlgoLine = {
  /** Stable for the session: `<date>:<type>` (custom levels: `<date>:custom:<id>`). */
  id: string;
  type: LineType;
  label: string;
  price: number;
  /** Unix seconds from which the level is known; candles before it are never compared with it. */
  activeFrom: number;
  source: "strategy" | "custom";
};

export type CustomLevel = { id: string; label: string; price: number };

/** Every strategy line type, in the order the panel lists them. All take part by default. */
export const LINE_TYPES: Array<{ type: Exclude<LineType, "custom">; label: string; group: string }> = [
  { type: "prev-box-top", label: "Previous-day box top", group: "Previous-day box (A)" },
  { type: "prev-box-mid", label: "Previous-day box midpoint (previous close)", group: "Previous-day box (A)" },
  { type: "prev-box-bottom", label: "Previous-day box bottom", group: "Previous-day box (A)" },
  { type: "today-box-top", label: "Today's box top", group: "Today's box (B)" },
  { type: "today-box-mid", label: "Today's box midpoint (today's open)", group: "Today's box (B)" },
  { type: "today-box-bottom", label: "Today's box bottom", group: "Today's box (B)" },
  { type: "prev-high", label: "Previous-day high", group: "Previous day" },
  { type: "prev-low", label: "Previous-day low", group: "Previous day" },
  { type: "prev-close", label: "Previous-day close", group: "Previous day" },
  { type: "prev-mid", label: "Previous-day mid-range ((high + low) / 2)", group: "Previous day" },
  { type: "today-open", label: "Today's open", group: "Today" },
  { type: "or-high", label: "Today's 9:15 high", group: "Today" },
  { type: "or-low", label: "Today's 9:15 low", group: "Today" },
];

export const ALL_LINE_TYPES = LINE_TYPES.map((item) => item.type);

const LABEL = Object.fromEntries(LINE_TYPES.map((item) => [item.type, item.label])) as Record<Exclude<LineType, "custom">, string>;

/**
 * The session's levels from its S1 data (previous session, open and 09:15 candle). Levels that depend on
 * today are only present once known: the open from 09:15:00, the 9:15 high and low once that minute has
 * finished. Custom levels are the learner's extra horizontal lines for the Algo.
 */
export function strategyLines(data: S1Data, custom: CustomLevel[] = []): AlgoLine[] {
  const levels = s1Levels(data.previous, data.open, data.firstMinute);
  const lines: AlgoLine[] = [];
  const add = (type: Exclude<LineType, "custom">, price: number | null | undefined, activeFrom: number) => {
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    lines.push({ id: `${data.date}:${type}`, type, label: LABEL[type], price: round2(price), activeFrom, source: "strategy" });
  };
  if (levels && data.previous) {
    const all = data.sessionOpen;
    add("prev-box-top", levels.closeBox.top, all);
    add("prev-box-mid", levels.closeBox.mid, all);
    add("prev-box-bottom", levels.closeBox.bottom, all);
    add("prev-high", data.previous.high, all);
    add("prev-low", data.previous.low, all);
    add("prev-close", data.previous.close, all);
    add("prev-mid", levels.rawBox.mid, all);
    if (levels.openBox) {
      add("today-box-top", levels.openBox.top, data.sessionOpen);
      add("today-box-mid", levels.openBox.mid, data.sessionOpen);
      add("today-box-bottom", levels.openBox.bottom, data.sessionOpen);
    }
    add("today-open", data.open, data.sessionOpen);
    if (levels.openingRange) {
      // Known only when the 09:15 candle has finished.
      add("or-high", levels.openingRange.high, levels.openingRange.time + 60);
      add("or-low", levels.openingRange.low, levels.openingRange.time + 60);
    }
  }
  for (const level of custom) {
    if (!Number.isFinite(level.price) || level.price <= 0) continue;
    lines.push({ id: `${data.date}:custom:${level.id}`, type: "custom", label: level.label || `Level ${round2(level.price)}`, price: round2(level.price), activeFrom: data.sessionOpen, source: "custom" });
  }
  return lines;
}

export function round2(value: number) {
  return Math.round(value * 100) / 100;
}
