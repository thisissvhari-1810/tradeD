import type { Candle } from "./lines";

/**
 * Price-action add-ons to the line-break strategy: swing points, the opening range, market structure,
 * automatic trendlines and W (double bottom) / M (double top) patterns, each turned into CALL / PUT
 * signals only on a completed candle's close.
 *
 * No look-ahead: everything is computed from the completed candles it is given (the caller passes only
 * what exists at the replay or live time). A swing point is a candle whose high (or low) is the extreme of
 * `pivotStrength` candles on each side, so it is only known — "confirmed" — once those later candles have
 * completed; every pivot carries that confirmation time and nothing uses a pivot before it. Anchors never
 * move: a confirmed pivot is a fixed candle's price.
 */

export type StrategyId = "line" | "trendline" | "w" | "m";
export const STRATEGY_IDS: StrategyId[] = ["line", "trendline", "w", "m"];
export const STRATEGY_LABEL: Record<StrategyId, string> = { line: "Line break", trendline: "Trendline breakout", w: "W pattern", m: "M pattern" };
export type Direction = "CALL" | "PUT";

export type PatternSettings = {
  /** Candles on each side that make a swing high / low (2 = a five-candle swing). */
  pivotStrength: number;
  /** Minimum candles between the two bottoms (W) or tops (M). */
  minSeparation: number;
  /** Maximum difference between the two lows / highs, % of their average. */
  tolerancePercent: number;
  /** A breakout must close at least this % beyond the level. */
  minBreakPercent: number;
  /** Wait for a retest of the broken level and a confirming candle before entering. */
  retest: boolean;
  /** A breakout not retested and confirmed within this many candles expires. */
  retestBars: number;
  /** Require breakout volume above its recent average (only where the feed has volume). */
  volume: boolean;
};

export const PATTERN_DEFAULTS: PatternSettings = { pivotStrength: 2, minSeparation: 4, tolerancePercent: 0.15, minBreakPercent: 0.02, retest: false, retestBars: 10, volume: false };

export type Pivot = { kind: "HIGH" | "LOW"; index: number; time: number; price: number; confirmedAt: number };

/** Confirmed swing highs and lows, oldest first. */
export function swingPivots(candles: Candle[], strength: number): Pivot[] {
  const k = Math.max(1, Math.floor(strength));
  const pivots: Pivot[] = [];
  for (let index = k; index + k < candles.length; index += 1) {
    const candle = candles[index];
    let high = true;
    let low = true;
    for (let offset = 1; offset <= k; offset += 1) {
      const before = candles[index - offset];
      const after = candles[index + offset];
      if (!(candle.high > before.high && candle.high >= after.high)) high = false;
      if (!(candle.low < before.low && candle.low <= after.low)) low = false;
    }
    const confirmedAt = candles[index + k].time + 60;
    if (high) pivots.push({ kind: "HIGH", index, time: candle.time, price: candle.high, confirmedAt });
    if (low) pivots.push({ kind: "LOW", index, time: candle.time, price: candle.low, confirmedAt });
  }
  return pivots;
}

export type Trendline = {
  kind: "RESISTANCE" | "SUPPORT";
  a: { index: number; time: number; price: number };
  b: { index: number; time: number; price: number };
  /** Price change per candle. */
  slope: number;
  confirmedAt: number;
};

/** The trendline's price on candle `index` (a straight line through its two fixed anchors). */
export const lineAt = (line: Trendline, index: number) => line.a.price + (index - line.a.index) * line.slope;

export type PatternStatus = "FORMING" | "READY" | "BROKEN" | "RETEST" | "TRIGGERED" | "INVALIDATED" | "EXPIRED";
export type PatternState = {
  kind: "W" | "M";
  status: PatternStatus;
  first: Pivot;
  middle: Pivot;
  second: Pivot | null;
  /** Neckline: the intermediate swing high (W) or low (M). */
  neckline: number;
  /** A close beyond this (the lower bottom / higher top) invalidates the pattern. */
  invalidation: number;
  breakoutTime: number | null;
  /** Whether the pattern is fully formed (both pivots confirmed) or still provisional. */
  confirmed: boolean;
};

export type StrategySignal = {
  /** Stable id: strategy, direction and signal candle. */
  id: string;
  strategy: StrategyId;
  direction: Direction;
  /** The signal candle (its opening time); it is acted on when it has closed. */
  time: number;
  /** The candle's close. */
  trigger: number;
  /** The broken level (trendline price, neckline or crossed line). */
  level: number;
  /** A close back beyond this invalidates the setup. */
  invalidation: number;
  reason: string;
  volume: "CONFIRMED" | "WEAK" | "UNAVAILABLE" | "NOT_REQUIRED";
};

export type StrategyStatus = { enabled: boolean; status: string; direction: Direction | null; trigger: number | null; waiting: boolean; lastSignal: { time: number; direction: Direction } | null };

export type MarketAnalysis = {
  /** Completed candles up to this time (unix seconds) were used. */
  asOf: number;
  sessionOpen: number;
  observationEnd: number;
  observationComplete: boolean;
  openingRange: { high: number; low: number } | null;
  trend: "BULLISH" | "BEARISH" | "SIDEWAYS" | "UNCONFIRMED";
  /** The latest confirmed swing points (at most 12). */
  pivots: Pivot[];
  resistance: (Trendline & { now: number }) | null;
  support: (Trendline & { now: number }) | null;
  w: PatternState | null;
  m: PatternState | null;
  /** Nearest level above / below the last close among the computed structure. */
  levels: { above: number | null; below: number | null };
  strategies: Record<StrategyId, StrategyStatus>;
};

const round = (value: number) => Math.round(value * 100) / 100;
const bodyRatio = (candle: Candle) => (candle.high > candle.low ? Math.abs(candle.close - candle.open) / (candle.high - candle.low) : 0);
/** A confirming candle: closes in the direction with a real body (at least half its range). */
export const strongCandle = (candle: Candle, direction: Direction) => (direction === "CALL" ? candle.close > candle.open : candle.close < candle.open) && bodyRatio(candle) >= 0.5;

/** Breakout volume against the 20-candle average, or UNAVAILABLE when the feed has no volume. */
export function volumeCheck(candles: Candle[], index: number): "CONFIRMED" | "WEAK" | "UNAVAILABLE" {
  const window = candles.slice(Math.max(0, index - 20), index);
  if (window.length < 5 || window.every((candle) => !candle.volume) || !candles[index].volume) return "UNAVAILABLE";
  const average = window.reduce((sum, candle) => sum + (candle.volume ?? 0), 0) / window.length;
  return (candles[index].volume ?? 0) >= average * 1.2 ? "CONFIRMED" : "WEAK";
}

/** Higher highs and higher lows (or the opposite) among the last two swing highs and lows. */
export function marketTrend(pivots: Pivot[]): MarketAnalysis["trend"] {
  const highs = pivots.filter((pivot) => pivot.kind === "HIGH").slice(-2);
  const lows = pivots.filter((pivot) => pivot.kind === "LOW").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "UNCONFIRMED";
  const up = highs[1].price > highs[0].price && lows[1].price > lows[0].price;
  const down = highs[1].price < highs[0].price && lows[1].price < lows[0].price;
  return up ? "BULLISH" : down ? "BEARISH" : "SIDEWAYS";
}

/** The latest descending resistance (two falling swing highs) and ascending support (two rising swing lows). */
export function trendlines(pivots: Pivot[]): { resistance: Trendline | null; support: Trendline | null } {
  const build = (kind: Trendline["kind"], points: Pivot[]): Trendline | null => {
    for (let at = points.length - 1; at > 0; at -= 1) {
      const b = points[at];
      const a = points[at - 1];
      const valid = kind === "RESISTANCE" ? b.price < a.price : b.price > a.price;
      if (!valid || b.index === a.index) continue;
      return { kind, a: { index: a.index, time: a.time, price: a.price }, b: { index: b.index, time: b.time, price: b.price }, slope: (b.price - a.price) / (b.index - a.index), confirmedAt: Math.max(a.confirmedAt, b.confirmedAt) };
    }
    return null;
  };
  return { resistance: build("RESISTANCE", pivots.filter((pivot) => pivot.kind === "HIGH")), support: build("SUPPORT", pivots.filter((pivot) => pivot.kind === "LOW")) };
}

/** The most recent W (double bottom, kind "W") or M (double top, kind "M") built from confirmed pivots. */
export function findPattern(kind: "W" | "M", pivots: Pivot[], settings: PatternSettings): PatternState | null {
  const extreme = kind === "W" ? "LOW" : "HIGH";
  const middleKind = kind === "W" ? "HIGH" : "LOW";
  const extremes = pivots.filter((pivot) => pivot.kind === extreme);
  if (!extremes.length) return null;
  // The newest extreme is the second bottom/top when an earlier one matches; else it may be the first.
  for (let at = extremes.length - 1; at >= 0; at -= 1) {
    const second = extremes[at];
    for (let back = at - 1; back >= 0; back -= 1) {
      const first = extremes[back];
      if (second.index - first.index < settings.minSeparation) continue;
      const between = pivots.filter((pivot) => pivot.kind === middleKind && pivot.index > first.index && pivot.index < second.index);
      if (!between.length) continue;
      const middle = between.reduce((best, pivot) => (kind === "W" ? (pivot.price > best.price ? pivot : best) : (pivot.price < best.price ? pivot : best)));
      const average = (first.price + second.price) / 2;
      const gap = (Math.abs(first.price - second.price) / average) * 100;
      const shaped = kind === "W" ? middle.price > Math.max(first.price, second.price) : middle.price < Math.min(first.price, second.price);
      if (gap > settings.tolerancePercent || !shaped) continue;
      return { kind, status: "READY", first, middle, second, neckline: middle.price, invalidation: kind === "W" ? Math.min(first.price, second.price) : Math.max(first.price, second.price), breakoutTime: null, confirmed: true };
    }
    if (at === extremes.length - 1) {
      // No match yet: a first bottom/top followed by a swing the other way is a pattern still forming.
      const after = pivots.filter((pivot) => pivot.kind === middleKind && pivot.index > second.index);
      if (after.length) {
        const middle = after.reduce((best, pivot) => (kind === "W" ? (pivot.price > best.price ? pivot : best) : (pivot.price < best.price ? pivot : best)));
        return { kind, status: "FORMING", first: second, middle, second: null, neckline: middle.price, invalidation: second.price, breakoutTime: null, confirmed: false };
      }
    }
    break;
  }
  return null;
}

type Breakout = { signal: boolean; state: "WAITING" | "BROKEN" | "RETEST" | "TRIGGERED" | "INVALIDATED" | "EXPIRED"; breakoutIndex: number | null };

/**
 * Walks the candles after `from` (the setup becoming known) up to the last one and decides whether the
 * last candle is the entry: the breakout close itself, or with retest mode the confirming candle after a
 * retest of the broken level. Earlier events (a breakout already traded, an invalidation, an expiry) make
 * later candles not signal again.
 */
function breakoutOn(candles: Candle[], from: number, direction: Direction, levelAt: (index: number) => number, invalidation: number, settings: PatternSettings): Breakout {
  const last = candles.length - 1;
  const beyond = (close: number, level: number) => (direction === "CALL" ? close > level * (1 + settings.minBreakPercent / 100) : close < level * (1 - settings.minBreakPercent / 100));
  const failed = (close: number) => (direction === "CALL" ? close < invalidation : close > invalidation);
  let broken: number | null = null;
  let retested = false;
  for (let index = Math.max(1, from); index <= last; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const level = levelAt(index);
    if (broken == null) {
      if (failed(candle.close)) return { signal: false, state: "INVALIDATED", breakoutIndex: null };
      // A body crossing: the previous close and this candle's open on the inside, its close beyond the level
      // (a wick through it, or a gap that opens beyond it, is not a breakout).
      const wasInside = direction === "CALL" ? previous.close <= levelAt(index - 1) && candle.open <= level : previous.close >= levelAt(index - 1) && candle.open >= level;
      if (wasInside && beyond(candle.close, level)) {
        broken = index;
        if (!settings.retest) return { signal: index === last, state: index === last ? "TRIGGERED" : "BROKEN", breakoutIndex: index };
      }
      continue;
    }
    // Retest mode: back to the level, then a confirming candle that closes beyond it again.
    if (index - broken > settings.retestBars) return { signal: false, state: "EXPIRED", breakoutIndex: broken };
    const backInside = direction === "CALL" ? candle.close < level * (1 - settings.tolerancePercent / 100) : candle.close > level * (1 + settings.tolerancePercent / 100);
    if (backInside) return { signal: false, state: "INVALIDATED", breakoutIndex: broken };
    const touched = direction === "CALL" ? candle.low <= level * (1 + settings.tolerancePercent / 100) : candle.high >= level * (1 - settings.tolerancePercent / 100);
    if (!retested && touched) {
      retested = true;
      if (index === last) return { signal: false, state: "RETEST", breakoutIndex: broken };
      continue;
    }
    if (retested && strongCandle(candle, direction) && beyond(candle.close, level)) return { signal: index === last, state: index === last ? "TRIGGERED" : "BROKEN", breakoutIndex: broken };
  }
  return { signal: false, state: broken == null ? "WAITING" : retested ? "RETEST" : "BROKEN", breakoutIndex: broken };
}

/**
 * Analyses the session's completed candles (the last one is the candle being evaluated) and returns the
 * market analysis and the pattern strategies' signals on that last candle. Deterministic; no look-ahead.
 */
export function analyzeMarket(input: { candles: Candle[]; sessionOpen: number; observationMinutes: number; settings: PatternSettings; enabled: Record<StrategyId, boolean>; lineDecision?: { direction: Direction | null; status: string; trigger: number | null; lastSignal: { time: number; direction: Direction } | null } }): { analysis: MarketAnalysis; signals: StrategySignal[] } {
  const { candles, sessionOpen, settings, enabled } = input;
  const observationEnd = sessionOpen + input.observationMinutes * 60;
  const last = candles.at(-1) ?? null;
  const asOf = last ? last.time + 60 : sessionOpen;
  const observationComplete = asOf >= observationEnd;
  const opening = candles.filter((candle) => candle.time < observationEnd);
  const openingRange = observationComplete && opening.length ? { high: Math.max(...opening.map((candle) => candle.high)), low: Math.min(...opening.map((candle) => candle.low)) } : null;
  // Only pivots already confirmed by the last candle's close.
  const pivots = swingPivots(candles, settings.pivotStrength).filter((pivot) => pivot.confirmedAt <= asOf);
  const trend = marketTrend(pivots);
  const lines = trendlines(pivots);
  const lastIndex = candles.length - 1;
  const signals: StrategySignal[] = [];
  const statuses = {} as Record<StrategyId, StrategyStatus>;
  const observing = !observationComplete;

  const signal = (strategy: StrategyId, direction: Direction, level: number, invalidation: number, reason: string): StrategySignal => {
    const volume = settings.volume ? volumeCheck(candles, lastIndex) : "NOT_REQUIRED";
    return { id: `${strategy}:${direction}:${last!.time}`, strategy, direction, time: last!.time, trigger: last!.close, level: round(level), invalidation: round(invalidation), reason, volume };
  };
  const volumeOk = (item: StrategySignal) => item.volume !== "WEAK";

  // Trendline breakout: above a descending resistance (CALL) or below an ascending support (PUT).
  let trendStatus: StrategyStatus = { enabled: enabled.trendline, status: "WAITING FOR VALID TRENDLINE", direction: null, trigger: null, waiting: true, lastSignal: null };
  if (last && lastIndex >= 1) {
    const checks: Array<[Trendline | null, Direction]> = [[lines.resistance, "CALL"], [lines.support, "PUT"]];
    const found: string[] = [];
    for (const [line, direction] of checks) {
      if (!line) continue;
      const from = candles.findIndex((candle) => candle.time + 60 > line.confirmedAt);
      if (from < 0) continue;
      const outcome = breakoutOn(candles, Math.max(from, line.b.index + 1), direction, (index) => lineAt(line, index), direction === "CALL" ? -Infinity : Infinity, settings);
      const now = round(lineAt(line, lastIndex));
      if (outcome.signal) {
        const item = signal("trendline", direction, now, now, `${direction === "CALL" ? "Breakout above the descending resistance" : "Breakdown below the ascending support"} trendline at ${now.toFixed(2)}${settings.retest ? " after a retest" : ""}.`);
        if (volumeOk(item)) signals.push(item);
        trendStatus = { ...trendStatus, status: "BREAKOUT CONFIRMED", direction, trigger: now, waiting: false, lastSignal: { time: last.time, direction } };
      } else if (trendStatus.status !== "BREAKOUT CONFIRMED") {
        found.push(outcome.state === "RETEST" ? "RETEST IN PROGRESS" : outcome.state === "BROKEN" && settings.retest ? "WAITING FOR RETEST" : `WAITING FOR ${direction === "CALL" ? "BREAKOUT" : "BREAKDOWN"}`);
        trendStatus = { ...trendStatus, status: found[0], trigger: trendStatus.trigger ?? now, waiting: true };
      }
    }
  }
  statuses.trendline = trendStatus;

  // W (CALL on a neckline breakout) and M (PUT on a neckline breakdown).
  const patternStatus = (kind: "W" | "M"): { state: PatternState | null; status: StrategyStatus } => {
    const id: StrategyId = kind === "W" ? "w" : "m";
    const direction: Direction = kind === "W" ? "CALL" : "PUT";
    const found = findPattern(kind, pivots, settings);
    const base: StrategyStatus = { enabled: enabled[id], status: "NO VALID SETUP", direction: null, trigger: null, waiting: true, lastSignal: null };
    if (!found) return { state: null, status: base };
    if (!found.confirmed || !found.second) return { state: found, status: { ...base, status: `${kind} PATTERN FORMING`, trigger: found.neckline } };
    const from = candles.findIndex((candle) => candle.time + 60 > found.second!.confirmedAt);
    if (from < 0) return { state: found, status: { ...base, status: `WAITING FOR NECKLINE ${kind === "W" ? "BREAKOUT" : "BREAKDOWN"}`, trigger: found.neckline } };
    const outcome = breakoutOn(candles, from, direction, () => found.neckline, found.invalidation, settings);
    const state: PatternState = { ...found, status: outcome.state === "TRIGGERED" ? "TRIGGERED" : outcome.state === "INVALIDATED" ? "INVALIDATED" : outcome.state === "EXPIRED" ? "EXPIRED" : outcome.state === "RETEST" ? "RETEST" : outcome.state === "BROKEN" ? "BROKEN" : "READY", breakoutTime: outcome.breakoutIndex != null ? candles[outcome.breakoutIndex].time : null };
    if (outcome.signal && last) {
      const item = signal(id, direction, found.neckline, found.invalidation, `${kind === "W" ? "Double bottom: close above the neckline" : "Double top: close below the neckline"} ${found.neckline.toFixed(2)}${settings.retest ? " after a retest" : ""}.`);
      if (volumeOk(item)) signals.push(item);
      return { state, status: { ...base, status: `NECKLINE ${kind === "W" ? "BREAKOUT" : "BREAKDOWN"} CONFIRMED`, direction, trigger: found.neckline, waiting: false, lastSignal: { time: last.time, direction } } };
    }
    const text = state.status === "INVALIDATED" ? "PATTERN INVALIDATED" : state.status === "EXPIRED" ? "RETEST EXPIRED" : state.status === "RETEST" ? "RETEST IN PROGRESS" : state.status === "BROKEN" ? (settings.retest ? "WAITING FOR RETEST" : "BREAKOUT ALREADY TAKEN") : `WAITING FOR NECKLINE ${kind === "W" ? "BREAKOUT" : "BREAKDOWN"}`;
    return { state, status: { ...base, status: text, trigger: found.neckline } };
  };
  const w = patternStatus("W");
  const m = patternStatus("M");
  statuses.w = w.status;
  statuses.m = m.status;
  statuses.line = { enabled: enabled.line, status: input.lineDecision?.status ?? "WAITING FOR LINE CROSSING", direction: input.lineDecision?.direction ?? null, trigger: input.lineDecision?.trigger ?? null, waiting: !input.lineDecision?.direction, lastSignal: input.lineDecision?.lastSignal ?? null };
  if (observing) for (const id of ["trendline", "w", "m"] as const) statuses[id] = { ...statuses[id], status: "ANALYZING OPENING MARKET", waiting: true };
  for (const id of ["trendline", "w", "m"] as const) if (!enabled[id]) statuses[id] = { ...statuses[id], status: "DISABLED", waiting: false };

  const close = last?.close ?? null;
  const structure = [lines.resistance ? lineAt(lines.resistance, lastIndex) : null, lines.support ? lineAt(lines.support, lastIndex) : null, w.state?.neckline ?? null, m.state?.neckline ?? null, openingRange?.high ?? null, openingRange?.low ?? null].filter((value): value is number => value != null);
  const analysis: MarketAnalysis = {
    asOf, sessionOpen, observationEnd, observationComplete, openingRange, trend,
    pivots: pivots.slice(-12),
    resistance: lines.resistance ? { ...lines.resistance, now: round(lineAt(lines.resistance, lastIndex)) } : null,
    support: lines.support ? { ...lines.support, now: round(lineAt(lines.support, lastIndex)) } : null,
    w: w.state, m: m.state,
    levels: close == null ? { above: null, below: null } : { above: structure.filter((value) => value > close).sort((a, b) => a - b)[0] ?? null, below: structure.filter((value) => value < close).sort((a, b) => b - a)[0] ?? null },
    strategies: statuses,
  };
  return { analysis, signals: observing ? [] : signals.filter((item) => enabled[item.strategy]) };
}
