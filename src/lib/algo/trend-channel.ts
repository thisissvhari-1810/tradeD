import { findSwings } from "@/lib/chart/trend-engine";
import type { Candle } from "./lines";
import type { Direction, StrategySignal } from "./patterns";

/**
 * Mathi Trend Channel: NIFTY ATM options from a parallel price channel on 3-minute candles (see
 * docs/mathi-trend-channel-strategy.md). 3-minute candles are built here from completed 1-minute NIFTY candles on the
 * 09:15 IST grid. Every decision uses completed candles only, and every step is decided with what was known at its
 * own time, so a result never changes when later candles arrive:
 * - C1: the 09:15–09:18 candle is never a swing, never compared against and never traded on;
 * - C2: swings are the chart trendline engine's (a high not exceeded by `left` candles before / `right` after; lows
 *   mirrored), kept only when they move `minSwingAtr` × the average range (as of their confirmation) away from the
 *   previous opposite swing in their own direction (a low below the high before it, a high above the low). The first
 *   three alternate: H1 L1 H2 (Pattern A) or L1 H1 L2 (Pattern B), and are locked;
 * - C3: the primary line through the two same-kind points; its clone keeps the primary's slope (the same number,
 *   never recomputed) and only moves its intercept to the third point;
 * - horizontal zones: significant swing highs (resistance) and lows (support), nearby ones merged;
 * - C4: a candle closing beyond a channel line and the relevant horizontal level is a breakout (beyond the line only:
 *   WATCH, no entry);
 * - C5: the next candle must trade beyond the breakout candle's high (low) and close beyond the level, or the setup is
 *   skipped;
 * - optional retest (`retest`, off by default): after the confirmation ("after") or in its place ("instead"), price must
 *   come back to the broken level without closing back through it, and a later candle must close beyond the retest
 *   candle's high (low), within `retestCandles` candles;
 * - optional daily trade (`fallback`, off by default): at `fallbackTime` a CALL / PUT from the day's direction (or the
 *   price against the channel); the runner's one-trade limit drops it when a setup already traded today;
 * - C6: the runner buys the ATM CALL / PUT.
 */

export type ChannelSettings = {
  /** Candle size in seconds. Unset = 180 (3-minute, the strategy and its algo). 60 = 1-minute: Line Strategy Draw only;
   * never saved with the algo's settings (config.ts does not read it). Swing, retest and momentum counts stay in candles. */
  barSeconds?: number;
  /** Candles before a swing that it must stand above (high) or below (low): the chart trendline engine's default. */
  left: number;
  /** Candles after a swing that may not exceed it; the swing is confirmed when the last of them closes. */
  right: number;
  /** The deep-swing cutoff: a swing must move this many average candle ranges from the previous opposite swing. */
  minSwingAtr: number;
  /** Horizontal swing levels within this % of each other are one zone. */
  zonePercent: number;
  /** A breakout needs the horizontal level too (true); false = channel-only breakouts (research comparison). */
  requireLevel: boolean;
  /** Which pattern may trade: both, or only Pattern A (2 highs + 1 low) / Pattern B (2 lows + 1 high). */
  patterns: "both" | "A" | "B";
  /** Strong-candle rule: the breakout candle's body must be at least this % of its high − low range (0 = off). */
  minBreakoutBody: number;
  /** Momentum rule: at the confirming candle's close NIFTY must have moved at least this % in the trade's direction over
   * the last 5 three-minute candles (15 minutes; 0 = off). */
  minMomentumPercent: number;
  /** Retest of the broken level before the entry: off, after the next-candle confirmation, or instead of it. */
  retest: "off" | "after" | "instead";
  /** Retest: the candles (3-minute) within which the retest and the move on must both happen. */
  retestCandles: number;
  /** Retest: how close (% of the level) a candle's low (CALL) / high (PUT) must come back to the broken level. */
  retestTolerancePercent: number;
  /** Daily trade when nothing has traded yet: off; "daymove" — CALL when NIFTY is above the 09:15 open at
   * `fallbackTime`, PUT below; "channel" — CALL above the channel, PUT below, inside: the channel's slope. */
  fallback: "off" | "daymove" | "channel";
  /** IST HH:MM: the 3-minute candle ending at this time decides the daily trade. */
  fallbackTime: string;
  /** Opening-gap rule for setups: a CALL only when NIFTY opened at or below the previous close, a PUT only at or above it. */
  gapRule: boolean;
  /** No trade on the bought contract's expiry day (the runner checks the contract's expiry against the session date). */
  skipExpiryDay: boolean;
};

/**
 * The two loss-avoiding rules (31 Oct 2026) were chosen on 2022–24 only and checked on 2024–26 with real option
 * premiums: on the unseen years they lifted the first trade of the day from 75.0% to about 80% and made it profitable.
 * A trade every day (user's choice): with no setup by 11:00, the daily trade follows the day's direction (NIFTY against
 * the 09:15 open; 1 Nov 2026). With no time limit, 4 years: 862 / 122 (87.6%), still a net loss — a loss held to 15:20
 * costs several +5% wins. Direction / waiting / strike rules tested on top did not hold on the unseen years.
 */
export const CHANNEL_SETTINGS_DEFAULTS: ChannelSettings = { left: 3, right: 3, minSwingAtr: 1, zonePercent: 0.05, requireLevel: true, patterns: "both", minBreakoutBody: 75, minMomentumPercent: 0.11, retest: "off", retestCandles: 10, retestTolerancePercent: 0.03, fallback: "daymove", fallbackTime: "11:00", gapRule: false, skipExpiryDay: false };

export const CHANNEL_LIMITS = { left: [1, 10], right: [1, 10], minSwingAtr: [0, 10], zonePercent: [0, 1], minBreakoutBody: [0, 100], minMomentumPercent: [0, 2], retestCandles: [1, 40], retestTolerancePercent: [0, 1] } as const;

export const BAR_SECONDS = 180;
const SESSION_MINUTES = 375;

export type ChannelBar = Candle & {
  volume: number;
  /** The candle's position from the session open (09:15 = 0): the channel's x coordinate. */
  x: number;
  end: number;
  /** When the candle was known complete: the close of its last minute (or of the first later minute, if it is missing). */
  completedAt: number;
};

export type ChannelSwing = { kind: "HIGH" | "LOW"; label: string; time: number; x: number; price: number; confirmedAt: number };

/** A channel boundary: price = intercept + slope × x, x in 3-minute candles from 09:15. */
export type ChannelLine = { role: "PRIMARY" | "CLONE"; side: "UPPER" | "LOWER"; slope: number; intercept: number; through: ChannelSwing[] };

export type ChannelPattern = { kind: "A" | "B"; points: [ChannelSwing, ChannelSwing, ChannelSwing]; completedAt: number; x: number };

export type ChannelZone = { kind: "SUPPORT" | "RESISTANCE"; low: number; high: number; members: ChannelSwing[]; from: number; brokenAt: number | null };

export type ChannelSetupStatus = "WATCH" | "AWAITING" | "RETEST" | "CONFIRMED" | "FAILED";

export type ChannelSetup = {
  id: string;
  direction: Direction;
  status: ChannelSetupStatus;
  /** The breakout (or watch) candle. */
  time: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** The channel line's price on that candle. */
  line: number;
  /** The horizontal level it had to close beyond (zone edge), or null when none applied. */
  level: number | null;
  /** The next candle, once it has closed. */
  confirm: { time: number; end: number; high: number; low: number; close: number } | null;
  /** Retest: the first candle that may retest (its time), and the latest retest candle. */
  retestFrom?: number | null;
  retest?: { time: number; end: number; high: number; low: number; close: number } | null;
  /** The candle the entry is taken on (the confirmation, or the move on after a retest) once CONFIRMED. */
  entry?: { time: number; end: number; close: number } | null;
  /** The candle that confirmed or skipped the setup. */
  decidedAt?: number | null;
  reasons: string[];
};

export type ChannelState = {
  asOf: number;
  bars: number;
  /** The ignored first candle. */
  c1: { time: number; open: number; high: number; low: number; close: number } | null;
  swings: ChannelSwing[];
  pattern: ChannelPattern | null;
  upper: ChannelLine | null;
  lower: ChannelLine | null;
  /** Vertical distance between the lines (points; the same everywhere: the lines are parallel). */
  width: number | null;
  zones: ChannelZone[];
  setups: ChannelSetup[];
  /** Where the last completed candle closed against the channel. */
  position: "INSIDE" | "ABOVE" | "BELOW" | null;
  /** The last completed candle's channel prices. */
  now: { time: number; close: number; upper: number; lower: number } | null;
  status: string;
};

const round = (value: number) => Math.round(value * 100) / 100;
export const istClock = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16);
const fmt = (value: number) => value.toFixed(2);

/** A channel line's price at x (3-minute candles from 09:15), or at a time. */
export const channelPrice = (line: Pick<ChannelLine, "slope" | "intercept">, x: number) => line.intercept + line.slope * x;
export const channelPriceAt = (line: Pick<ChannelLine, "slope" | "intercept">, time: number, sessionOpen: number, barSeconds = BAR_SECONDS) => channelPrice(line, (time - sessionOpen) / barSeconds);

/**
 * 3-minute candles of one session from its 1-minute candles (09:15, 09:18, … 15:27). A candle is complete once its last
 * minute has closed, or a later minute has (a minute missing from the feed). The forming candle is returned last with
 * completedAt 0.
 */
export function threeMinuteBars(candles: Candle[], sessionOpen: number, barSeconds = BAR_SECONDS): ChannelBar[] {
  const groups = new Map<number, Candle[]>();
  const sorted = [...candles].filter((candle) => candle.time >= sessionOpen && candle.time < sessionOpen + SESSION_MINUTES * 60).sort((a, b) => a.time - b.time);
  for (const candle of sorted) {
    const x = Math.floor((candle.time - sessionOpen) / barSeconds);
    const list = groups.get(x) ?? [];
    list.push(candle);
    groups.set(x, list);
  }
  const bars: ChannelBar[] = [];
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  for (const [at, [x, minutes]] of ordered.entries()) {
    const time = sessionOpen + x * barSeconds;
    const end = time + barSeconds;
    // Its own last minute, or (that minute missing) the next minute the feed has.
    const own = minutes.at(-1)!;
    const closing = own.time >= end - 60 ? own : ordered[at + 1]?.[1][0];
    bars.push({
      x, time, end,
      open: minutes[0].open,
      high: Math.max(...minutes.map((candle) => candle.high)),
      low: Math.min(...minutes.map((candle) => candle.low)),
      close: minutes.at(-1)!.close,
      volume: minutes.reduce((sum, candle) => sum + (candle.volume ?? 0), 0),
      completedAt: closing ? closing.time + 60 : 0,
    });
  }
  return bars;
}

/** The two channel lines from the locked pattern: the clone copies the primary's slope and moves only its intercept. */
export function channelLines(pattern: ChannelPattern): { upper: ChannelLine; lower: ChannelLine } {
  const [p1, p3, p2] = [pattern.points[0], pattern.points[1], pattern.points[2]];
  const slope = (p2.price - p1.price) / (p2.x - p1.x);
  const primary: ChannelLine = { role: "PRIMARY", side: pattern.kind === "A" ? "UPPER" : "LOWER", slope, intercept: p1.price - slope * p1.x, through: [p1, p2] };
  // The clone: the primary's own slope value, shifted parallel until it passes through the opposite swing.
  const clone: ChannelLine = { role: "CLONE", side: pattern.kind === "A" ? "LOWER" : "UPPER", slope: primary.slope, intercept: p3.price - primary.slope * p3.x, through: [p3] };
  return pattern.kind === "A" ? { upper: primary, lower: clone } : { upper: clone, lower: primary };
}

/** Swing levels merged into zones: sorted by price, a level within `percent` % of the zone's first joins it. */
export function horizontalZones(swings: ChannelSwing[], percent: number): Array<Omit<ChannelZone, "brokenAt">> {
  const zones: Array<Omit<ChannelZone, "brokenAt">> = [];
  for (const [kind, want] of [["RESISTANCE", "HIGH"], ["SUPPORT", "LOW"]] as const) {
    const sorted = swings.filter((swing) => swing.kind === want).sort((a, b) => a.price - b.price);
    let group: ChannelSwing[] = [];
    const flush = () => {
      if (group.length) zones.push({ kind, low: Math.min(...group.map((item) => item.price)), high: Math.max(...group.map((item) => item.price)), members: [...group].sort((a, b) => a.time - b.time), from: Math.min(...group.map((item) => item.confirmedAt)) });
      group = [];
    };
    for (const swing of sorted) {
      if (group.length && swing.price - group[0].price > (group[0].price * percent) / 100) flush();
      group.push(swing);
    }
    flush();
  }
  return zones;
}

/**
 * Mathi Trend Channel on the session's completed 1-minute candles up to `asOf` (unix seconds; default: the last one's
 * close). Returns the state for the chart and panel, the setup decided on the latest completed 3-minute candle, and
 * the CALL / PUT signal when that candle confirmed a breakout and completed exactly at `asOf` (`latest`: the setups that
 * candle started, confirmed or skipped).
 */
export function channelSignal(candles: Candle[], sessionOpen: number, settings: ChannelSettings, asOf?: number, prevClose: number | null = null): { state: ChannelState; signal: StrategySignal | null; decided: ChannelSetup | null; latest: ChannelSetup[] } {
  const s = { ...CHANNEL_SETTINGS_DEFAULTS, ...settings };
  const until = asOf ?? (candles.length ? Math.max(...candles.map((candle) => candle.time)) + 60 : 0);
  const size = s.barSeconds === 60 ? 60 : BAR_SECONDS;
  const all = threeMinuteBars(candles.filter((candle) => candle.time + 60 <= until), sessionOpen, size).filter((bar) => bar.completedAt > 0);
  const c1 = all[0]?.x === 0 ? all[0] : null;
  const empty: ChannelState = { asOf: until, bars: all.length, c1: c1 ? { time: c1.time, open: c1.open, high: c1.high, low: c1.low, close: c1.close } : null, swings: [], pattern: null, upper: null, lower: null, width: null, zones: [], setups: [], position: null, now: null, status: "" };
  // C1 is skipped: never a swing, never a candle the others are compared with.
  const first = c1 ? 1 : 0;
  const raw = all.length > first ? findSwings(all, first, first, s.left, s.right, size).filter((swing) => swing.confirmedAt != null) : [];
  // The average range of the candles after C1 up to each one (the cutoff as known at a swing's confirmation).
  const ranges: number[] = [];
  let sum = 0;
  for (let index = first; index < all.length; index += 1) {
    const bar = all[index];
    const previous = index > first ? all[index - 1].close : bar.open;
    sum += Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
    ranges[index] = sum / (index - first + 1);
  }

  const kept: ChannelSwing[] = [];
  let pattern: ChannelPattern | null = null;
  let patternIndex = -1;
  let lines: { upper: ChannelLine; lower: ChannelLine } | null = null;
  const setups: ChannelSetup[] = [];
  let zones: ChannelZone[] = [];
  let previous: { bull: boolean; bear: boolean; bullLine: boolean; bearLine: boolean } = { bull: false, bear: false, bullLine: false, bearLine: false };

  // A zone breaks on the first close beyond it after its latest member was confirmed. Scans are remembered per zone,
  // so each candle is read once per zone however often the zones are rebuilt.
  const scans = new Map<string, { through: number; brokenAt: number | null }>();
  const startOf = new Map(all.map((bar, at) => [bar.end, at + 1]));
  const zonesAt = (index: number): ChannelZone[] => {
    const points = [...kept, ...(pattern?.points ?? []).filter((point) => !kept.some((item) => item.kind === point.kind && item.time === point.time))];
    return horizontalZones(points, s.zonePercent).map((zone) => {
      const latest = Math.max(...zone.members.map((item) => item.confirmedAt));
      const key = `${zone.kind}:${zone.low}:${zone.high}:${latest}`;
      const scan = scans.get(key) ?? { through: Math.max(first, startOf.get(latest) ?? first) - 1, brokenAt: null };
      for (let at = scan.through + 1; at <= index && scan.brokenAt == null; at += 1) {
        const bar = all[at];
        if (zone.kind === "RESISTANCE" ? bar.close > zone.high : bar.close < zone.low) scan.brokenAt = bar.end;
        scan.through = at;
      }
      scans.set(key, scan);
      return { ...zone, brokenAt: scan.brokenAt };
    });
  };

  for (let index = first; index < all.length; index += 1) {
    const bar = all[index];
    // C2: swings confirmed by this candle, each tested against the cutoff known now.
    for (const swing of raw.filter((item) => item.index + s.right === index)) {
      const point: ChannelSwing = { kind: swing.kind, label: "", time: swing.time, x: all[swing.index].x, price: swing.price, confirmedAt: swing.confirmedAt! };
      const last = kept.at(-1);
      if (!last) kept.push(point);
      else if (last.kind === point.kind) {
        if (point.kind === "HIGH" ? point.price > last.price : point.price < last.price) kept[kept.length - 1] = point;
      } else if (point.time > last.time && (point.kind === "LOW" ? last.price - point.price : point.price - last.price) >= s.minSwingAtr * ranges[index]) kept.push(point);
    }
    if (!pattern && kept.length >= 3) {
      const [a, b, c] = kept;
      const names = a.kind === "HIGH" ? ["H1", "L1", "H2"] : ["L1", "H1", "L2"];
      const points = [a, b, c].map((point, at) => ({ ...point, label: names[at] })) as [ChannelSwing, ChannelSwing, ChannelSwing];
      pattern = { kind: a.kind === "HIGH" ? "A" : "B", points, completedAt: bar.end, x: bar.x };
      patternIndex = index;
      lines = channelLines(pattern);
      continue;
    }
    if (!pattern || !lines || index <= patternIndex) continue;

    // C4 / C5 on this completed candle, with the zones known when it closed (their breaks up to the candle before).
    zones = zonesAt(index - 1);
    const upper = channelPrice(lines.upper, bar.x);
    const lower = channelPrice(lines.lower, bar.x);
    const unbroken = (kind: ChannelZone["kind"]) => zones.filter((zone) => zone.kind === kind && zone.brokenAt == null);
    const resistance = unbroken("RESISTANCE").sort((a, b) => a.high - b.high)[0] ?? zones.filter((zone) => zone.kind === "RESISTANCE").sort((a, b) => b.high - a.high)[0] ?? null;
    const support = unbroken("SUPPORT").sort((a, b) => b.low - a.low)[0] ?? zones.filter((zone) => zone.kind === "SUPPORT").sort((a, b) => a.low - b.low)[0] ?? null;

    const candle = { time: bar.time, end: bar.end, high: bar.high, low: bar.low, close: bar.close };
    // The loss-avoiding rules on a setup about to enter on this candle: a strong breakout candle, momentum into the entry.
    const ruleCheck = (setup: ChannelSetup) => {
      const call = setup.direction === "CALL";
      const rules: string[] = [];
      const range = setup.high - setup.low;
      const body = range > 0 ? (Math.abs(setup.close - setup.open) / range) * 100 : 0;
      if (s.minBreakoutBody > 0 && body < s.minBreakoutBody) rules.push(`the breakout candle's body is ${body.toFixed(0)}% of its range (needs ${s.minBreakoutBody}%)`);
      if (s.minMomentumPercent > 0) {
        const earlier = all[index - 5];
        const move = earlier ? ((bar.close - earlier.close) / earlier.close) * 100 * (call ? 1 : -1) : 0;
        if (move < s.minMomentumPercent) rules.push(`NIFTY moved ${move >= 0 ? "" : "−"}${Math.abs(move).toFixed(3)}% ${call ? "up" : "down"} in the last 15 minutes (needs ${s.minMomentumPercent}%)`);
      }
      if (s.gapRule && prevClose != null && all.length) {
        const dayOpen = all[0].open;
        if (call ? dayOpen > prevClose : dayOpen < prevClose) rules.push(`NIFTY opened ${fmt(dayOpen)}, ${call ? "above" : "below"} the previous close ${fmt(prevClose)} — no ${call ? "CALL on a gap-up" : "PUT on a gap-down"} day`);
      }
      if (rules.length) {
        setup.status = "FAILED";
        setup.reasons.push(`RULE — skipped: ${rules.join("; ")}.`);
      } else setup.entry = { time: bar.time, end: bar.end, close: bar.close };
      setup.decidedAt = bar.time;
    };
    // Retest: back to the broken level without closing through it, then a close beyond the retest candle (move on).
    const retestStep = (setup: ChannelSetup) => {
      const call = setup.direction === "CALL";
      const hold = setup.level ?? (call ? upper : lower);
      const near = (hold * s.retestTolerancePercent) / 100;
      const used = all.filter((item) => item.time >= setup.retestFrom! && item.time <= bar.time).length;
      if (call ? bar.close <= hold : bar.close >= hold) {
        setup.status = "FAILED";
        setup.decidedAt = bar.time;
        setup.reasons.push(`NO RETEST HOLD — skipped: the ${istClock(bar.time)} candle closed ${fmt(bar.close)}, back ${call ? "at or below" : "at or above"} the broken level ${fmt(hold)}.`);
        return;
      }
      const moved = setup.retest && (call ? bar.close > setup.retest.high : bar.close < setup.retest.low);
      if (moved) {
        setup.status = "CONFIRMED";
        setup.reasons.push(`RETEST HELD — price came back to ${fmt(call ? setup.retest!.low : setup.retest!.high)} at ${istClock(setup.retest!.time)} (level ${fmt(hold)}) and the ${istClock(bar.time)} candle closed ${fmt(bar.close)}, ${call ? "above the retest high" : "below the retest low"} ${fmt(call ? setup.retest!.high : setup.retest!.low)}.`);
        ruleCheck(setup);
        return;
      }
      if (call ? bar.low <= hold + near : bar.high >= hold - near) setup.retest = candle;
      if (used >= s.retestCandles) {
        setup.status = "FAILED";
        setup.decidedAt = bar.time;
        setup.reasons.push(`NO RETEST — skipped: ${setup.retest ? "no close beyond the retest candle" : `no retest of ${fmt(hold)}`} within ${s.retestCandles} candles.`);
      }
    };
    for (const pending of setups.filter((item) => item.status === "AWAITING" || item.status === "RETEST")) {
      if (pending.status === "RETEST") {
        retestStep(pending);
        continue;
      }
      if (s.retest === "instead") {
        pending.status = "RETEST";
        pending.retestFrom = bar.time;
        pending.reasons.push(`Waiting for a retest of ${fmt(pending.level ?? (pending.direction === "CALL" ? upper : lower))} within ${s.retestCandles} candles.`);
        retestStep(pending);
        continue;
      }
      const call = pending.direction === "CALL";
      const hold = pending.level ?? (call ? upper : lower);
      const crossed = call ? bar.high > pending.high : bar.low < pending.low;
      const held = call ? bar.close > hold : bar.close < hold;
      pending.confirm = { time: bar.time, end: bar.end, high: bar.high, low: bar.low, close: bar.close };
      const holdName = pending.level != null ? (call ? "resistance" : "support") : (call ? "the upper line" : "the lower line");
      const text = [
        call ? `${istClock(bar.time)} candle high ${fmt(bar.high)} ${crossed ? "crossed above" : "did not cross above"} the breakout high ${fmt(pending.high)}` : `${istClock(bar.time)} candle low ${fmt(bar.low)} ${crossed ? "crossed below" : "did not cross below"} the breakdown low ${fmt(pending.low)}`,
        `it closed ${fmt(bar.close)}, ${held ? (call ? "above" : "below") : (call ? "not above" : "not below")} ${holdName} ${fmt(hold)}`,
      ];
      pending.status = crossed && held ? "CONFIRMED" : "FAILED";
      pending.reasons.push(`${pending.status === "CONFIRMED" ? "CONFIRMED" : "NOT CONFIRMED — skipped"}: ${text.join("; ")}.`);
      if (pending.status === "FAILED") pending.decidedAt = bar.time;
      else if (s.retest === "after") {
        pending.status = "RETEST";
        pending.retestFrom = all[index + 1]?.time ?? bar.end;
        pending.reasons.push(`Waiting for a retest of ${fmt(hold)} within ${s.retestCandles} candles.`);
      } else ruleCheck(pending);
    }

    const bullLine = bar.close > upper;
    const bearLine = bar.close < lower;
    const bullLevel = resistance ? bar.close > resistance.high : false;
    const bearLevel = support ? bar.close < support.low : false;
    const bull = bullLine && (!s.requireLevel || bullLevel);
    const bear = bearLine && (!s.requireLevel || bearLevel);
    const record = (direction: Direction, status: ChannelSetupStatus, line: number, level: number | null, reason: string) => setups.push({ id: `channel:${direction}:${bar.time}`, direction, status, time: bar.time, end: bar.end, open: bar.open, high: bar.high, low: bar.low, close: bar.close, line: round(line), level: level == null ? null : round(level), confirm: null, ...(s.retest !== "off" ? { retestFrom: null, retest: null } : {}), entry: null, decidedAt: null, reasons: [reason] });
    const where = (call: boolean, line: number) => `${istClock(bar.time)} candle closed ${fmt(bar.close)} ${call ? "above the upper" : "below the lower"} channel line ${fmt(line)}`;
    if (bull && !previous.bull) {
      const level = s.requireLevel ? resistance!.high : null;
      record("CALL", "AWAITING", upper, level, `BULLISH BREAKOUT — ${where(true, upper)}${level != null ? ` and above resistance ${fmt(level)}` : " (channel only)"}; high ${fmt(bar.high)}, low ${fmt(bar.low)}. Next candle must cross above ${fmt(bar.high)}${level != null ? ` and stay above ${fmt(level)}` : ""}.`);
    } else if (bear && !previous.bear) {
      const level = s.requireLevel ? support!.low : null;
      record("PUT", "AWAITING", lower, level, `BEARISH BREAKDOWN — ${where(false, lower)}${level != null ? ` and below support ${fmt(level)}` : " (channel only)"}; high ${fmt(bar.high)}, low ${fmt(bar.low)}. Next candle must cross below ${fmt(bar.low)}${level != null ? ` and stay below ${fmt(level)}` : ""}.`);
    } else if (s.requireLevel && bullLine && !bullLevel && !previous.bullLine) {
      record("CALL", "WATCH", upper, resistance?.high ?? null, `WATCH — ${where(true, upper)} but not above resistance ${resistance ? fmt(resistance.high) : "(none)"}: channel-only break, no entry.`);
    } else if (s.requireLevel && bearLine && !bearLevel && !previous.bearLine) {
      record("PUT", "WATCH", lower, support?.low ?? null, `WATCH — ${where(false, lower)} but not below support ${support ? fmt(support.low) : "(none)"}: channel-only break, no entry.`);
    }
    previous = { bull, bear, bullLine, bearLine };
  }

  const last = all.at(-1) ?? null;
  zones = last && kept.length ? zonesAt(all.length - 1) : [];
  const labelled = kept.map((swing) => pattern?.points.find((point) => point.kind === swing.kind && point.time === swing.time) ?? swing);
  const upperNow = lines && last ? channelPrice(lines.upper, last.x) : null;
  const lowerNow = lines && last ? channelPrice(lines.lower, last.x) : null;
  const position = upperNow != null && lowerNow != null && last ? (last.close > upperNow ? "ABOVE" : last.close < lowerNow ? "BELOW" : "INSIDE") : null;

  // The setup confirmed or skipped on the latest completed candle, those it started, and the signal when it completed now.
  const decidedSetup = last ? setups.find((setup) => setup.decidedAt === last.time) ?? null : null;
  const fresh = last != null && last.completedAt === until;
  const latest = fresh && last ? setups.filter((setup) => setup.time === last.time || setup.confirm?.time === last.time || setup.decidedAt === last.time) : [];
  const allowed = !pattern || s.patterns === "both" || s.patterns === pattern.kind;
  let signal: StrategySignal | null = null;
  if (fresh && allowed && pattern && decidedSetup?.status === "CONFIRMED" && decidedSetup.entry) {
    const level = decidedSetup.level ?? decidedSetup.line;
    const p = pattern.points;
    const reason = `Mathi Trend Channel — Pattern ${pattern.kind} (${p.map((point) => `${point.label} ${fmt(point.price)} ${istClock(point.time)}`).join(", ")}). ${decidedSetup.reasons.join(" ")} → ATM ${decidedSetup.direction}.`;
    signal = { id: `channel:${decidedSetup.direction}:${decidedSetup.time}`, strategy: "channel", direction: decidedSetup.direction, time: decidedSetup.entry.time, trigger: decidedSetup.entry.close, level: round(level), invalidation: round(level), reason, volume: "NOT_REQUIRED" };
  }

  // The daily trade: on the candle ending at the fallback time, when no setup signals on it.
  const fallbackEnd = sessionOpen + (Number(s.fallbackTime.slice(0, 2)) * 60 + Number(s.fallbackTime.slice(3, 5)) - 555) * 60;
  if (fresh && !signal && s.fallback !== "off" && last && last.end === fallbackEnd) {
    const dayOpen = all[0]?.open ?? last.close;
    let call = last.close >= dayOpen;
    let why = `NIFTY ${fmt(last.close)} is ${call ? "at or above" : "below"} the 09:15 open ${fmt(dayOpen)}`;
    if (s.fallback === "channel" && position && lines) {
      call = position === "ABOVE" ? true : position === "BELOW" ? false : lines.upper.slope > 0;
      why = position === "INSIDE" ? `NIFTY ${fmt(last.close)} is inside the channel, which is ${call ? "rising" : "falling"}` : `NIFTY ${fmt(last.close)} is ${position === "ABOVE" ? "above" : "below"} the channel`;
    }
    const direction: Direction = call ? "CALL" : "PUT";
    signal = { id: `channel:fallback:${direction}:${last.time}`, strategy: "channel", direction, time: last.time, trigger: last.close, level: round(dayOpen), invalidation: round(dayOpen), reason: `DAILY TRADE at ${s.fallbackTime} (no setup traded yet today): ${why} → ATM ${direction}.`, volume: "NOT_REQUIRED" };
  }

  const pending = [...setups].reverse().find((setup) => setup.status === "AWAITING" || setup.status === "RETEST") ?? null;
  const status = !last
    ? "Waiting for the first completed 3-minute candle."
    : !pattern
      ? `C1 (09:15) ignored. Waiting for the first valid swing combination: ${kept.length ? kept.map((swing) => `${swing.kind === "HIGH" ? "high" : "low"} ${fmt(swing.price)} at ${istClock(swing.time)}`).join(", ") : "no deep swing confirmed yet"}.`
      : !allowed
        ? `Pattern ${pattern.kind} selected — not traded (settings: Pattern ${s.patterns} only).`
        : pending
          ? pending.status === "RETEST"
            ? `${pending.direction === "CALL" ? "Bullish breakout" : "Bearish breakdown"} at ${istClock(pending.time)}: waiting for a retest of ${fmt(pending.level ?? pending.line)}${pending.retest ? ` (retest at ${istClock(pending.retest.time)}; entry on a close ${pending.direction === "CALL" ? `above ${fmt(pending.retest.high)}` : `below ${fmt(pending.retest.low)}`})` : ""}.`
            : `${pending.direction === "CALL" ? "Bullish breakout" : "Bearish breakdown"} at ${istClock(pending.time)}: waiting for the next candle to cross ${pending.direction === "CALL" ? `above ${fmt(pending.high)}` : `below ${fmt(pending.low)}`}.`
          : `Pattern ${pattern.kind} channel: close ${fmt(last.close)} ${position === "ABOVE" ? "above the channel" : position === "BELOW" ? "below the channel" : "inside the channel"} (upper ${fmt(upperNow!)}, lower ${fmt(lowerNow!)}).`;

  return {
    state: {
      ...empty,
      swings: labelled,
      pattern,
      upper: lines?.upper ?? null,
      lower: lines?.lower ?? null,
      width: lines ? round(lines.upper.intercept - lines.lower.intercept) : null,
      zones,
      setups,
      position,
      now: last && upperNow != null && lowerNow != null ? { time: last.time, close: last.close, upper: round(upperNow), lower: round(lowerNow) } : null,
      status,
    },
    signal,
    decided: decidedSetup,
    latest,
  };
}
