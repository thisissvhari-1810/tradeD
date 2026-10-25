import type { Candle } from "@/lib/market/demo";

/**
 * The chart's automatic trendline engine: reads completed candles of the chart's own timeframe and finds
 * the significant swing highs and lows, the support and resistance trendlines through them, equal-high /
 * equal-low horizontal levels and the session's opening range.
 *
 * Everything is a pure function of the completed candles passed in, so nothing is drawn from the future:
 * a swing exists only once `right` later candles have closed, and its time and price never move after
 * that. A line is chosen from what was known at the latest confirmed swing (its score never changes with
 * later candles), so the active line changes only when a new swing is confirmed or the line breaks — never
 * on every tick.
 */

export type AutoTrendSettings = {
  /** Draw the support / resistance trendlines. */
  trendlines: boolean;
  /** Draw horizontal levels (equal highs / lows and the opening range). */
  levels: boolean;
  /** Small markers on the swing points the lines and levels use. */
  markers: boolean;
  /** An arrow where a trendline broke (up for a breakout, down for a breakdown). */
  breaks: boolean;
  /** Candles on each side that a swing must stand above (high) or below (low). */
  left: number;
  right: number;
  /** A swing must move at least this many average candle ranges away from the previous opposite swing. */
  minSwingAtr: number;
  /** Candles analysed (intraday 1–5 minute charts use only the current session). */
  lookback: number;
  /** Price tolerance (% of price) for touches and for grouping equal highs / lows. */
  tolerancePercent: number;
  /** A close this far (% of price) beyond a line or level breaks it. */
  breakPercent: number;
  /** Intraday: the first minutes of each session are observed before lines are drawn. */
  observationMinutes: number;
  colors: { support: string; resistance: string; supportLevel: string; resistanceLevel: string };
};

export const AUTO_TREND_DEFAULTS: AutoTrendSettings = {
  trendlines: true,
  levels: true,
  markers: true,
  breaks: true,
  left: 3,
  right: 3,
  minSwingAtr: 1,
  lookback: 150,
  tolerancePercent: 0.05,
  breakPercent: 0.03,
  observationMinutes: 30,
  colors: { support: "#22AB94", resistance: "#F23645", supportLevel: "#2962FF", resistanceLevel: "#FF9800" },
};

export const AUTO_TREND_LIMITS = {
  left: [1, 10],
  right: [1, 10],
  minSwingAtr: [0, 10],
  lookback: [30, 1000],
  tolerancePercent: [0, 1],
  breakPercent: [0, 1],
  observationMinutes: [0, 120],
} as const;

export type Swing = {
  kind: "HIGH" | "LOW";
  index: number;
  time: number;
  price: number;
  /** When the swing was confirmed (close of its `right`-th later candle); null while still provisional. */
  confirmedAt: number | null;
};

export type AutoLine = {
  id: string;
  kind: "SUPPORT" | "RESISTANCE";
  a: Swing;
  b: Swing;
  /** Price change per candle. */
  slope: number;
  status: "ACTIVE" | "BROKEN";
  /** The candle whose close broke the line, and the line's price there. */
  broken: { index: number; time: number; close: number; price: number } | null;
  /** Other swing points within tolerance of the line (anchors excluded). */
  touches: number;
  /** The line's price on the last completed candle. */
  now: number;
};

export type AutoLevel = {
  id: string;
  kind: "SUPPORT" | "RESISTANCE";
  price: number;
  /** The first swing (or the session open) the level starts from. */
  from: number;
  source: "EQUAL_SWINGS" | "OPENING_RANGE";
  members: Swing[];
};

export type Structure = "BULLISH" | "BEARISH" | "SIDEWAYS" | "UNCONFIRMED";
export type Sequence = "HIGHER" | "LOWER" | "EQUAL" | null;

export type AutoTrend = {
  phase: "NO_DATA" | "OBSERVING" | "ACTIVE";
  intraday: boolean;
  /** Close time of the last completed candle used. */
  asOf: number;
  candles: number;
  /** Close time of the candle that confirmed the latest swing: the analysis (window, swings, scores) is as of then. */
  confirmedThrough: number;
  /** The current session (intraday only): its range so far, reset every trading day. */
  session: { date: string; open: number; high: number; highTime: number; low: number; lowTime: number; close: number } | null;
  /** The opening observation (intraday only). */
  observation: { end: number; complete: boolean; high: number; low: number; structure: Structure } | null;
  /** Significant confirmed swings in the analysed window, oldest first (at most 24). */
  swings: Swing[];
  /** The latest still-unconfirmed swing high / low (marked provisional, never used for a line). */
  provisional: Swing[];
  highs: Sequence;
  lows: Sequence;
  structure: Structure;
  /** A change in the swing sequence at the latest confirmation (e.g. higher lows turning into a lower low). */
  change: string | null;
  support: AutoLine | null;
  resistance: AutoLine | null;
  /** The most recent broken line on each side (drawn dashed up to the break). */
  brokenLines: AutoLine[];
  levels: AutoLevel[];
  message: string;
};

const IST = 19_800;
const OPEN_MINUTES = 9 * 60 + 15;
const dayOf = (time: number) => Math.floor((time + IST) / 86_400);
const sessionOpenOf = (time: number) => dayOf(time) * 86_400 - IST + OPEN_MINUTES * 60;
const dateOf = (time: number) => new Date(dayOf(time) * 86_400_000).toISOString().slice(0, 10);
const round = (value: number) => Math.round(value * 100) / 100;

const clampInt = (value: number, [min, max]: readonly [number, number], fallback: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);
const clampNum = (value: number, [min, max]: readonly [number, number], fallback: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

/** Saved settings merged over the defaults, every number inside its limits. */
export function readAutoTrendSettings(raw: unknown): AutoTrendSettings {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (key: string) => (typeof row[key] === "number" ? (row[key] as number) : NaN);
  const flag = (key: "trendlines" | "levels" | "markers" | "breaks") => (typeof row[key] === "boolean" ? (row[key] as boolean) : AUTO_TREND_DEFAULTS[key]);
  const colors = (row.colors && typeof row.colors === "object" ? row.colors : {}) as Record<string, unknown>;
  const color = (key: keyof AutoTrendSettings["colors"]) => (typeof colors[key] === "string" && /^#[0-9a-f]{6}$/i.test(colors[key] as string) ? (colors[key] as string) : AUTO_TREND_DEFAULTS.colors[key]);
  const d = AUTO_TREND_DEFAULTS;
  const l = AUTO_TREND_LIMITS;
  return {
    trendlines: flag("trendlines"),
    levels: flag("levels"),
    markers: flag("markers"),
    breaks: flag("breaks"),
    left: clampInt(num("left"), l.left, d.left),
    right: clampInt(num("right"), l.right, d.right),
    minSwingAtr: clampNum(num("minSwingAtr"), l.minSwingAtr, d.minSwingAtr),
    lookback: clampInt(num("lookback"), l.lookback, d.lookback),
    tolerancePercent: clampNum(num("tolerancePercent"), l.tolerancePercent, d.tolerancePercent),
    breakPercent: clampNum(num("breakPercent"), l.breakPercent, d.breakPercent),
    observationMinutes: clampInt(num("observationMinutes"), l.observationMinutes, d.observationMinutes),
    colors: { support: color("support"), resistance: color("resistance"), supportLevel: color("supportLevel"), resistanceLevel: color("resistanceLevel") },
  };
}

/** Average true range of the candles (a timeframe-independent unit for "a significant move"). */
export function averageRange(candles: Array<Pick<Candle, "open" | "high" | "low" | "close">>): number {
  if (!candles.length) return 0;
  let sum = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = index > 0 ? candles[index - 1].close : candle.open;
    sum += Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
  }
  return sum / candles.length;
}

/**
 * Swing highs and lows: a high above the `left` candles before it and not exceeded by the `right` candles
 * after it (lows mirrored). Confirmed once all `right` candles have closed; a candidate with fewer later
 * candles so far is provisional. Candles before `leftFrom` are not used (a session starts fresh).
 */
export function findSwings(candles: Candle[], from: number, leftFrom: number, left: number, right: number, spanSeconds: number): Swing[] {
  const swings: Swing[] = [];
  for (let index = from; index < candles.length; index += 1) {
    const firstLeft = Math.max(leftFrom, index - left);
    if (firstLeft === index && index !== leftFrom) continue;
    if (leftFrom === 0 && index - left < 0) continue;
    const available = Math.min(right, candles.length - 1 - index);
    const candle = candles[index];
    let high = true;
    let low = true;
    for (let at = firstLeft; at < index; at += 1) {
      if (candles[at].high >= candle.high) high = false;
      if (candles[at].low <= candle.low) low = false;
    }
    for (let at = index + 1; at <= index + available; at += 1) {
      if (candles[at].high > candle.high) high = false;
      if (candles[at].low < candle.low) low = false;
    }
    const confirmedAt = available === right ? candles[index + right].time + spanSeconds : null;
    if (high) swings.push({ kind: "HIGH", index, time: candle.time, price: candle.high, confirmedAt });
    if (low) swings.push({ kind: "LOW", index, time: candle.time, price: candle.low, confirmedAt });
  }
  return swings;
}

/**
 * Keeps only significant swings: highs and lows alternate, two of the same kind in a row keep the more
 * extreme one, and a swing that moved less than `minMove` from the previous opposite swing is noise.
 */
export function significantSwings(swings: Swing[], minMove: number): Swing[] {
  const kept: Swing[] = [];
  for (const swing of swings) {
    const last = kept.at(-1);
    if (!last) {
      kept.push(swing);
    } else if (last.kind === swing.kind) {
      const more = swing.kind === "HIGH" ? swing.price > last.price : swing.price < last.price;
      if (more) kept[kept.length - 1] = swing;
    } else if (Math.abs(swing.price - last.price) >= minMove) {
      kept.push(swing);
    }
  }
  return kept;
}

const lineAt = (a: Swing, slope: number, index: number) => a.price + (index - a.index) * slope;

/** A line's price on candle `index` (also past the last candle, to project it forward). */
export const linePrice = (line: AutoLine, index: number) => lineAt(line.a, line.slope, index);

type Candidate = AutoLine & { score: number };

/**
 * Every valid line through two significant swings of one kind (the second among the latest three):
 * no candle between the anchors pierces it beyond the tolerance, and it did not break before it could be
 * known. Scored on what was known at `frozen` (the latest confirmed swing): touches (any confirmed swing of
 * the kind within tolerance), an anchor on the
 * deepest low / highest high, how recent the second anchor is and how long the line is.
 */
function candidateLines(kind: AutoLine["kind"], candles: Candle[], swings: Swing[], touchPoints: Swing[], start: number, frozen: number, settings: AutoTrendSettings, atr: number, spanSeconds: number): Candidate[] {
  const want = kind === "SUPPORT" ? "LOW" : "HIGH";
  const points = swings.filter((swing) => swing.kind === want);
  if (points.length < 2) return [];
  const extreme = kind === "SUPPORT" ? Math.min(...points.map((point) => point.price)) : Math.max(...points.map((point) => point.price));
  const last = candles.length - 1;
  // Relative to the latest confirmed swing, not the last candle: scores stay fixed between confirmations.
  const width = Math.max(1, frozen - start);
  const list: Candidate[] = [];
  for (const b of points.slice(-3)) {
    for (const a of points) {
      if (a.index >= b.index || b.index - a.index < 2) continue;
      const slope = (b.price - a.price) / (b.index - a.index);
      if (Math.abs(slope) > atr * 1.5) continue;
      // At least 0.15 average ranges, so wide-candle instruments are not held to a hairline.
      const tolerance = Math.max((a.price * settings.tolerancePercent) / 100, atr * 0.15);
      let valid = true;
      for (let index = a.index + 1; index < b.index && valid; index += 1) {
        const price = lineAt(a, slope, index);
        if (kind === "SUPPORT" ? candles[index].low < price - tolerance : candles[index].high > price + tolerance) valid = false;
      }
      if (!valid) continue;
      const breakBy = (a.price * settings.breakPercent) / 100;
      let broken: AutoLine["broken"] = null;
      for (let index = b.index + 1; index <= last; index += 1) {
        const price = lineAt(a, slope, index);
        if (kind === "SUPPORT" ? candles[index].close < price - breakBy : candles[index].close > price + breakBy) {
          broken = { index, time: candles[index].time, close: candles[index].close, price: round(price) };
          break;
        }
      }
      // Broken before the second anchor was even confirmed: never a usable line.
      if (broken && b.confirmedAt != null && broken.time + spanSeconds < b.confirmedAt) continue;
      const until = Math.min(frozen, broken ? broken.index : last);
      let touches = 0;
      for (const point of touchPoints) {
        if (point.kind !== want || point.index === a.index || point.index === b.index || point.index < a.index || point.index > until) continue;
        if (Math.abs(point.price - lineAt(a, slope, point.index)) <= tolerance * 2) touches += 1;
      }
      const anchoredOnExtreme = a.price === extreme || b.price === extreme;
      const score = touches * 2 + (anchoredOnExtreme ? 1.5 : 0) + (2 * (b.index - start)) / width + Math.min(1, (b.index - a.index) / width);
      list.push({ id: `auto:line:${kind.toLowerCase()}:${a.time}:${b.time}`, kind, a, b, slope, status: broken ? "BROKEN" : "ACTIVE", broken, touches, now: round(lineAt(a, slope, last)), score });
    }
  }
  return list;
}

function sequence(points: Swing[], tolerance: (price: number) => number): Sequence {
  if (points.length < 2) return null;
  const [previous, latest] = points.slice(-2);
  if (Math.abs(latest.price - previous.price) <= tolerance(previous.price)) return "EQUAL";
  return latest.price > previous.price ? "HIGHER" : "LOWER";
}

function structureOf(highs: Sequence, lows: Sequence): Structure {
  if (!highs || !lows) return "UNCONFIRMED";
  if (highs === "HIGHER" && lows !== "LOWER") return "BULLISH";
  if (lows === "LOWER" && highs !== "HIGHER") return "BEARISH";
  return "SIDEWAYS";
}

/** The opening observation's character from its own candles (no swings needed yet). */
export function openingStructure(candles: Candle[]): Structure {
  if (candles.length < 3) return "UNCONFIRMED";
  const open = candles[0].open;
  const close = candles.at(-1)!.close;
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  if (high <= low) return "SIDEWAYS";
  const third = Math.max(1, Math.floor(candles.length / 3));
  const early = candles.slice(0, third);
  const late = candles.slice(-third);
  const move = (close - open) / (high - low);
  if (move >= 0.4 && Math.min(...late.map((candle) => candle.low)) >= Math.min(...early.map((candle) => candle.low))) return "BULLISH";
  if (move <= -0.4 && Math.max(...late.map((candle) => candle.high)) <= Math.max(...early.map((candle) => candle.high))) return "BEARISH";
  return "SIDEWAYS";
}

/**
 * Analyses completed candles of one timeframe. `spanSeconds` is the candle length for intraday charts and
 * null for daily and longer (no session observation there).
 */
export function analyzeTrend(candles: Candle[], spanSeconds: number | null, settings: AutoTrendSettings): AutoTrend {
  const empty: AutoTrend = { phase: "NO_DATA", intraday: spanSeconds != null, asOf: 0, candles: candles.length, confirmedThrough: 0, session: null, observation: null, swings: [], provisional: [], highs: null, lows: null, structure: "UNCONFIRMED", change: null, support: null, resistance: null, brokenLines: [], levels: [], message: "No completed candles yet." };
  const last = candles.at(-1);
  if (!last) return empty;
  const intraday = spanSeconds != null && spanSeconds < 86_400;
  const span = intraday ? spanSeconds : 0;
  const asOf = last.time + span;
  const lastIndex = candles.length - 1;

  // The current session (intraday): tracked from its first candle, reset every trading day.
  let sessionStart = 0;
  let session: AutoTrend["session"] = null;
  let observation: AutoTrend["observation"] = null;
  if (intraday) {
    const day = dayOf(last.time);
    sessionStart = lastIndex;
    while (sessionStart > 0 && dayOf(candles[sessionStart - 1].time) === day) sessionStart -= 1;
    const today = candles.slice(sessionStart);
    const highest = today.reduce((best, candle) => (candle.high > best.high ? candle : best), today[0]);
    const lowest = today.reduce((best, candle) => (candle.low < best.low ? candle : best), today[0]);
    session = { date: dateOf(last.time), open: today[0].open, high: highest.high, highTime: highest.time, low: lowest.low, lowTime: lowest.time, close: last.close };
    const end = sessionOpenOf(last.time) + settings.observationMinutes * 60;
    const opening = today.filter((candle) => candle.time < end);
    observation = {
      end,
      complete: asOf >= end,
      high: opening.length ? Math.max(...opening.map((candle) => candle.high)) : session.high,
      low: opening.length ? Math.min(...opening.map((candle) => candle.low)) : session.low,
      structure: openingStructure(opening),
    };
    if (!observation.complete) {
      return { ...empty, phase: "OBSERVING", intraday, asOf, session, observation, message: `Observing the opening until ${new Date((end + IST) * 1000).toISOString().slice(11, 16)} IST: no lines are drawn before enough price action.` };
    }
  }

  // 1–5 minute charts read today's session only; longer timeframes read the lookback window.
  const sessionScoped = intraday && span <= 300;
  const scopeFrom = sessionScoped ? sessionStart : 0;
  // The window and the average range are taken as of the latest swing confirmation (the closing candle
  // that confirmed it), so nothing the engine selects shifts between confirmations.
  const scoped = findSwings(candles, scopeFrom, scopeFrom, settings.left, settings.right, span);
  const confirmations = scoped.filter((swing) => swing.confirmedAt != null).map((swing) => swing.index + settings.right);
  const through = confirmations.length ? Math.max(...confirmations) : lastIndex;
  const start = Math.max(scopeFrom, through + 1 - settings.lookback);
  const atr = averageRange(candles.slice(start, through + 1));
  const all = scoped.filter((swing) => swing.index >= start);
  const raw = all.filter((swing) => swing.confirmedAt != null);
  const confirmed = significantSwings(raw, settings.minSwingAtr * atr);
  const provisional = (["HIGH", "LOW"] as const)
    .map((kind) => all.filter((swing) => swing.kind === kind && swing.confirmedAt == null).at(-1))
    .filter((swing): swing is Swing => Boolean(swing))
    .filter((swing) => !confirmed.some((item) => item.index >= swing.index));
  const tolerance = (price: number) => (price * settings.tolerancePercent) / 100;
  const highPoints = confirmed.filter((swing) => swing.kind === "HIGH");
  const lowPoints = confirmed.filter((swing) => swing.kind === "LOW");
  const highs = sequence(highPoints, tolerance);
  const lows = sequence(lowPoints, tolerance);
  const structure = structureOf(highs, lows);
  // The swing sequence before the latest confirmed swing, to report a change of structure.
  const latest = confirmed.at(-1);
  let change: string | null = null;
  if (latest) {
    const before = confirmed.slice(0, -1);
    const was = latest.kind === "HIGH" ? sequence(before.filter((swing) => swing.kind === "HIGH"), tolerance) : sequence(before.filter((swing) => swing.kind === "LOW"), tolerance);
    const now = latest.kind === "HIGH" ? highs : lows;
    const word = latest.kind === "HIGH" ? "highs" : "lows";
    if (was && now && was !== now && now !== "EQUAL" && was !== "EQUAL") change = `${was === "HIGHER" ? "Higher" : "Lower"} ${word} turned into a ${now.toLowerCase()} ${word.slice(0, -1)} at ${latest.price.toFixed(2)}.`;
  }

  // Lines are scored on what was known at the latest confirmed swing (stable between confirmations).
  const frozen = latest?.index ?? start;
  const pick = (kind: AutoLine["kind"]) => {
    const list = candidateLines(kind, candles, confirmed, raw, start, frozen, settings, atr, span);
    const best = (items: Candidate[]) => items.reduce<Candidate | null>((top, item) => (!top || item.score > top.score || (item.score === top.score && item.b.index > top.b.index) ? item : top), null);
    const active = best(list.filter((item) => item.status === "ACTIVE"));
    // The latest break shown dashed (until the break candle): recent, and not older than the active line.
    const recent = Math.max(10, Math.floor(settings.lookback / 5));
    const broken = best(list.filter((item) => item.broken && lastIndex - item.broken.index <= recent && (!active || item.broken.index >= active.a.index)));
    const strip = (item: Candidate | null): AutoLine | null => (item ? { id: item.id, kind: item.kind, a: item.a, b: item.b, slope: item.slope, status: item.status, broken: item.broken, touches: item.touches, now: item.now } : null);
    return { active: strip(active), broken: strip(broken) };
  };
  const support = pick("SUPPORT");
  const resistance = pick("RESISTANCE");

  // Horizontal levels: equal highs / lows (two or more swings within tolerance) and the opening range,
  // while unbroken; at most the three nearest on each side of the last close.
  const breakBy = (price: number) => (price * settings.breakPercent) / 100;
  const unbrokenAfter = (kind: AutoLevel["kind"], price: number, from: number) => {
    for (let index = from + 1; index <= lastIndex; index += 1) {
      if (kind === "RESISTANCE" ? candles[index].close > price + breakBy(price) : candles[index].close < price - breakBy(price)) return false;
    }
    return true;
  };
  const levels: AutoLevel[] = [];
  for (const [kind, points] of [["RESISTANCE", highPoints], ["SUPPORT", lowPoints]] as const) {
    const sorted = [...points].sort((x, y) => x.price - y.price);
    let group: Swing[] = [];
    const flush = () => {
      if (group.length >= 2) {
        const price = round(group.reduce((sum, item) => sum + item.price, 0) / group.length);
        const lastMember = Math.max(...group.map((item) => item.index));
        const first = group.reduce((x, y) => (x.index < y.index ? x : y));
        if (unbrokenAfter(kind, price, lastMember)) levels.push({ id: `auto:level:${kind.toLowerCase()}:${first.time}`, kind, price, from: first.time, source: "EQUAL_SWINGS", members: [...group].sort((x, y) => x.index - y.index) });
      }
      group = [];
    };
    for (const point of sorted) {
      if (group.length && point.price - group[0].price > tolerance(group[0].price) * 2) flush();
      group.push(point);
    }
    flush();
  }
  if (observation && session) {
    const openIndex = sessionStart;
    const end = candles.findIndex((candle, index) => index >= sessionStart && candle.time >= observation!.end);
    const after = end < 0 ? lastIndex : end - 1;
    for (const [kind, price] of [["RESISTANCE", observation.high], ["SUPPORT", observation.low]] as const) {
      const near = levels.some((level) => Math.abs(level.price - price) <= tolerance(price) * 2);
      if (!near && unbrokenAfter(kind, price, after)) levels.push({ id: `auto:level:opening:${kind.toLowerCase()}:${candles[openIndex].time}`, kind, price: round(price), from: candles[openIndex].time, source: "OPENING_RANGE", members: [] });
    }
  }
  const close = last.close;
  const above = levels.filter((level) => level.price >= close).sort((x, y) => x.price - y.price).slice(0, 3);
  const below = levels.filter((level) => level.price < close).sort((x, y) => y.price - x.price).slice(0, 3);

  const lines = [support.active, resistance.active].filter(Boolean).length;
  const message = confirmed.length < 2
    ? "Waiting for confirmed swing highs and lows."
    : lines === 0
      ? "No valid trendline: the confirmed swings do not form an unbroken support or resistance yet."
      : `${lines === 2 ? "Support and resistance" : support.active ? "Support" : "Resistance"} drawn through confirmed swings.`;
  return {
    phase: "ACTIVE",
    intraday,
    asOf,
    candles: candles.length,
    confirmedThrough: candles[through].time + span,
    session,
    observation,
    swings: confirmed.slice(-24),
    provisional,
    highs,
    lows,
    structure,
    change,
    support: support.active,
    resistance: resistance.active,
    brokenLines: [support.broken, resistance.broken].filter((line): line is AutoLine => Boolean(line)),
    levels: [...above, ...below],
    message,
  };
}

/** The candles a chart may analyse: the last one is dropped while it is still forming. */
export function completedCandles(candles: Candle[], forming: boolean): Candle[] {
  return forming && candles.length ? candles.slice(0, -1) : candles;
}
