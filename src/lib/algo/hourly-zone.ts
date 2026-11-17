import type { Candle } from "./lines";
import type { Direction, StrategySignal } from "./patterns";

/**
 * Mathi Hourly Zone Strategy — 5%: NIFTY ATM options on the first two 1-hour candles of the session (see
 * docs/mathi-hourly-zone-strategy.md). Hourly candles are built here from completed 1-minute NIFTY candles on the
 * 09:15 IST grid (09:15–10:15, 10:15–11:15, … 14:15–15:15; the 15:15–15:30 remainder is never a full hour), so a
 * provider's own hourly boundaries can never be used by mistake. Every decision uses completed candles only:
 * - the pair's first candle sets the direction (red → LONG / ATM CALL, green → SHORT / ATM PUT, doji → skipped) and
 *   the reference, fixed at its close;
 * - when the pair's second candle has closed, its close decides: inside the permitted zone (LONG: above the reference,
 *   SHORT: below it, by the configured minimum / maximum points) is the trade. An optional wick / body rule (off by
 *   default) can also skip a pair whose second candle traded across the reference;
 * - a skipped pair hands over to the next pair on the schedule ("next": 09:15+10:15 → 11:15+12:15 → 13:15+14:15;
 *   "sliding": every following hour starts a pair).
 * After the entry the trade is held while each completed hour closes beyond its own midpoint in the trade's
 * direction (hourlyMidpointDecision); the +5% option-premium target is the runner's.
 */

export type HourlySettings = {
  /** A first candle whose |close − open| is at most this many points is a doji (0 = only an exact equality). */
  dojiTolerance: number;
  /** Permitted zone: the second candle must close at least this many points beyond the reference (0 = any close beyond it). */
  zoneMinPoints: number;
  /** ...and at most this many points beyond it (0 = no limit). */
  zoneMaxPoints: number;
  /** The optional wick / body skip rule (off by default: only the second candle's close decides): which candle it reads... */
  skipCandle: "second" | "first";
  /** ...which part of it ("wick" = high / low, "body" = open / close; "off" = no skip rule)... */
  skipPart: "wick" | "body" | "off";
  /** ...and which crossing of the reference skips the setup: "against" — into the losing side (below a LONG
   * reference, above a SHORT one); "above" — above the reference for both (the rule as first written). */
  skipSide: "against" | "above";
  /** "wick" rule, "against" side: the body may never cross the reference; the wick may, until more than this share (%) of
   * it is past the reference (0 = any crossing skips). E.g. 80: a lower wick of 32.55 points with 30.05 below a LONG mid
   * (92%) skips; one with 10 of 32.55 below (31%) does not. */
  skipWickPercent: number;
  /** "wick" rule, "against" side: the body may never cross the reference; the wick may, by at most this many points
   * (0 = not used). Checked before `skipWickPercent`. E.g. 20: a wick 30.05 points past a LONG mid skips; 12 does not. */
  skipWickPoints: number;
  /** Which positions the wick limits apply to: both, or only SHORT (default: a LONG's lower wick may cross the mid by any
   * amount — only its body is checked). */
  skipWickFor: "both" | "short";
  /** "body" rule: the second candle's body may cross the mid by up to this many points (0 = not at all, the default). */
  bodyCrossPoints: number;
  /** The next pair after a skipped one: the next hour ("sliding": 10:15 + 11:15, decided at 12:15) or the next two hours ("next"). */
  pairStep: "next" | "sliding";
  /**
   * The position box's outer edges, the same distance above and below the reference (like a Long / Short position drawn
   * on the first candle's close): "off" — no edge; "range" — `boxSize` × the first candle's high − low; "points" —
   * `boxSize` NIFTY points; "wick" — the stop at the drawn candle's own extreme (its low for a LONG, its high for a SHORT)
   * and the target the same distance on the other side (1 : 1). With an edge, a second candle whose body or wick goes
   * beyond it is skipped (unless `boxSkip` is off).
   */
  boxMode: "off" | "range" | "points" | "wick";
  boxSize: number;
  /** Skip a pair whose second candle's body or wick goes out of the box (on by default; off = the box only sets the exits). */
  boxSkip: boolean;
  /** LONG: the second candle's lower wick may go below the box (only the box top is checked; used with `boxCheck` "wick"). */
  boxLongLowFree: boolean;
  /** LONG: the second candle's low may break the box bottom by at most this many points (default 10; a negative value
   * turns the check off). */
  longLowBelowBoxPoints: number;
  /** Rejection filter (0 = off): skip when the second candle's wick on the trade's profit side (a LONG's upper wick, a
   * SHORT's lower wick) is more than this share (%) of its whole range — price went that way and was pushed back. */
  maxRejectionWickPercent: number;
  /** Loss-side wick filter (0 = off): skip when the second candle's wick on the trade's losing side (a LONG's lower wick,
   * a SHORT's upper wick) is more than this share (%) of its whole range — price already pushed hard against the trade. */
  maxLossWickPercent: number;
  /** Strong-candle filter (0 = off): skip when the second candle's body is less than this share (%) of its whole range —
   * a small body with long wicks is indecision, not a move. */
  minSecondBodyPercent: number;
  /** When a pair fails, buy the opposite side instead of moving on: "wrongSide" — only when the second candle closed on
   * the other side of the mid (at least `zoneMinPoints` past it); "anyRule" — whenever any rule fails; "off" (default). */
  oppositeOnFail: "off" | "wrongSide" | "anyRule";
  /** What sets CALL or PUT: "color" (default) — a red drawn candle is LONG / CALL, a green one SHORT / PUT; "close" — the
   * drawn candle's colour is not used: the second candle closing above the mid is a CALL, below it a PUT, exactly on it
   * no trade; "position" (default) — the drawn candle sets the position tool (red: Long, green: Short) and its box, and
   * the second candle's side of the mid sets the trade: Long tool above → CALL, below → PUT; Short tool above → PUT,
   * below → CALL. */
  directionFrom: "color" | "close" | "position";
  /** 1-point difference rule (0 = off): the second candle's body edge nearest the mid must be at least this many points
   * from it — above the mid a green candle's open or a red one's close, below it a green candle's close or a red one's
   * open. */
  gapPoints: number;
  /** Daily trade (off by default): when no pair has traded by `fallbackTime` (IST "HH:MM", a pair's decision time), the
   * pair decided then is traded on its direction alone — its other checks are logged, not applied. The runner's one
   * trade a session still holds, so it never adds a second trade. */
  dailyFallback: boolean;
  /** Day-trend filter (off by default): a CALL only when the second candle closes above the session's 09:15 open, a PUT
   * only below it — the trade goes with the day's move. */
  trendFilter: boolean;
  /** Day-trend allowance (points, 0 = none): the second candle may be this far on the wrong side of the 09:15 open. */
  trendTolerance: number;
  /** Red–red cross rule (off by default): a red drawn candle and a red second candle that opens above the mid and closes
   * below it, with most of its body below, is traded as a CALL — "daily": only when the daily trade takes it; "all": at
   * its own decision time, whatever its other checks say. An open no more than `bodyCrossPoints` above the mid is not a
   * cross: the pair is decided by the normal rules. */
  crossFlip: "off" | "daily" | "all";
  /** Red–red allowance (points, 0 = off): for a red drawn candle and a red second candle closing below the mid, an open
   * up to this far above the mid is not a cross — the body rule lets it through and the pair is a normal PUT. Every
   * other setup keeps the strict body rule. */
  crossTolerance: number;
  /** Daily-trade red flip (0 = off): when the daily trade would buy a CALL on a red drawn candle whose green second
   * candle closed above the mid while NIFTY is below its 09:15 open, and that candle's body is more than this share (%)
   * of its range, it buys the PUT instead. Red drawn candles only. */
  redAgainstFlip: number;
  /** Daily red–red CALL (points, 0 = off): when the daily trade is a red drawn candle and a red second candle closing
   * below the mid that opened 0 to this many points above it, the daily trade buys the CALL instead of the PUT. */
  redRedDailyCall: number;
  /** Daily red–green PUT (points, 0 = off): when the daily trade is a red drawn candle and a green second candle closing
   * above the mid that opened 0 to this many points below it (its body crosses the mid), it buys the PUT, not the CALL. */
  redGreenDailyPut: number;
  /** Green–red PUT (points, 0 = off): a green drawn candle and a red second candle that closes below the mid but opened
   * at most this far above it is a PUT, not a CALL — "daily": when the daily trade takes it; "all": at its own decision
   * time (the body rule is not applied to it; the other checks are, for the PUT). */
  greenRedPut: number;
  /** Red–red bounce filter (points, 0 = off): a red drawn candle and a red second candle closing below the mid (a PUT)
   * is skipped when that candle's lower wick (close to low) is at least this long — buyers already pushed it back up. */
  redRedMaxLowerWick: number;
  /** Red–green wick CALL (%, 0 = off): a red drawn candle and a green second candle whose whole body is above the mid
   * while at least this share of its lower wick is below the mid is a CALL — buyers defended the mid. "override": the
   * 10-point and day-trend checks are not applied to it; "trend": the day-trend check still is. */
  wickCall: number;
  wickCallMode: "override" | "trend";
  /** With "trend": the IST weekdays (e.g. "Mon,Tue": NIFTY's weekly expiry and the day before) on which the wick CALL is
   * taken even against the day's move. Empty = none. */
  wickCallAnyTrendDays: string;
  /** The wick CALL is also taken against the day's move, on any weekday, when at least this % of the lower wick is
   * below the mid (a near-perfect rejection of the mid); such a CALL is not flipped by `redGreenOpenFlip` either. 0 = off. */
  wickCallAnyTrendShare: number;
  /** Red–green wick PUT (%, 0 = off): a red drawn candle and a green second candle closing above the mid with its whole
   * body above it, when at least this share of its lower wick is below the mid, is a PUT. Only that combination. */
  wickPutPercent: number;
  /** With the wick PUT: also require the day's move (NIFTY below its 09:15 open). */
  wickPutTrend: boolean;
  /** With the wick PUT (points, 0 = off): the green candle's open must touch the mid — within this many points of it,
   * above or below — instead of the whole body being above it. */
  wickPutTouch: number;
  /** Thin-wick PUT (points, 0 = off): a red drawn candle and a green second candle above the mid (a CALL) whose lower
   * wick (open to low) is this or less is traded as a PUT instead — normal or daily trade. */
  thinWickPut: number;
  /** Thin-wick CALL (points, 0 = off): a red drawn candle and a red second candle below the mid (a PUT) whose lower wick
   * (close to low) is less than this is traded as a CALL instead — normal or daily trade. */
  thinWickCall: number;
  /** Dear-option flip (₹, 0 = off): when the ATM option costs at least this and the drawn candle's body is at most
   * `dearFlipBody` % of its range (an indecisive drawn candle), the other side is bought instead. */
  dearFlipPremium: number;
  dearFlipBody: number;
  /** Shape rules on the side finally bought (after the dear-option flip), applied by the runner; 0 = off.
   * Green drawn + red second candle closing below the mid: the other side is bought when the second candle's high is
   * more than `greenRedHighGap` points below the drawn high, or the drawn candle's wick on the losing side (a CALL: its
   * lower wick; a PUT: its upper wick) is under `greenRedDrawnWick` points. */
  greenRedHighGap: number;
  greenRedDrawnWick: number;
  /** Red drawn + red second candle closing below the mid: wait one hour when the second candle's wick on the trade's
   * side (a PUT: its lower wick; a CALL: its upper wick) is over `redRedWaitWick` points (same side), or when its body is
   * under `redRedWaitBody` % of its range (the other side; this one wins when both apply). */
  redRedWaitWick: number;
  redRedWaitBody: number;
  /** Green drawn + green second candle closing above the mid: wait one hour (same side) when the second candle's wick
   * on the trade's side (a PUT: its lower wick; a CALL: its upper wick) is over this many points. 0 = off. */
  greenGreenWaitWick: number;
  /** The green–green wait applies only to pairs decided at or before this IST "HH:MM" ("" = any time). */
  greenGreenWaitBy: string;
  /** The green–green wait is not applied when the dear-option flip has already changed the side. */
  greenGreenWaitNoDearFlip: boolean;
  /** The daily trade's green–red PUT only with the day's move (the second candle closed below the 09:15 open); against
   * it the pair's normal side is kept. */
  greenRedDailyTrend: boolean;
  /** Shape rule 2 (`greenRedDrawnWick`) flips to the other side only with the day's move (a PUT: the second candle
   * closed below the 09:15 open; a CALL: above it). */
  greenRedDrawnWickTrend: boolean;
  /** With `greenRedDailyTrend` / `greenRedDrawnWickTrend`: applied only when the drawn candle's high–low range is under
   * this many points (a quiet pause in the day's move, not a reversal). 0 = any size. */
  greenRedTrendMaxRange: number;
  /** Early exit (0 = off): still more than `earlyExitPercent` % below the entry premium `earlyExitMinutes` minutes after
   * the entry (or any minute after that), the trade is sold at the premium. Cuts a losing trade before the hourly
   * midpoint exit; the +5% target is unchanged. */
  /** Red–green allowance (points, 0 = off): a red drawn candle and a green second candle closing above the mid whose
   * open is at most this far below the mid has not crossed it — the body rule holds and the CALL stands. */
  redGreenBodyTolerance: number;
  /** Red drawn + green second candle closing above the mid: wait one hour (same side) when the option to buy costs more
   * than this (₹, ask + slippage), a high-volatility setup that often swings back first. 0 = off. Applied after the
   * shape rules, only when none of them acted. */
  redGreenWaitPremium: number;
  earlyExitMinutes: number;
  earlyExitPercent: number;
  /** The early exit on the contract's expiry day, when its premium can fall to nearly nothing within an hour. 0 = the
   * normal early exit applies that day too. */
  expiryEarlyExitMinutes: number;
  expiryEarlyExitPercent: number;
  /** The early exit for a risky-time trade (taken with half the lots, `riskyAction` "half"), expiry day included: these
   * trades often dip first and then reach the target, so they get more time. 0 = the normal early exit applies. */
  riskyEarlyExitMinutes: number;
  riskyEarlyExitPercent: number;
  /** Protect the gain (0 = off): once the premium has traded `protectArmPercent` % above the entry, a fall back to
   * `protectLockPercent` % above it sells the option, so a trade that was nearly at the target does not turn into a loss.
   * The +5% target is unchanged. */
  protectArmPercent: number;
  protectLockPercent: number;
  /** Four-year correlation rules, applied last (only when no earlier rule acted); 0 = off.
   * A: green drawn + green second candle above the mid, with the 09:15 hour's range between `ggWaitFirstHourMin` and
   *    `ggWaitFirstHourMax` points → wait one hour (same side).
   * B: a CALL with NIFTY (the second candle's close) between `callWaitDayMoveMin` and `callWaitDayMoveMax` points above
   *    the 09:15 open → wait one hour.
   * C: 3 days to the contract's expiry and the second candle's wick on the trade's side at least `dte3OppWick` % of its
   *    range → the other side. */
  ggWaitFirstHourMin: number;
  ggWaitFirstHourMax: number;
  callWaitDayMoveMin: number;
  callWaitDayMoveMax: number;
  dte3OppWick: number;
  /** Market-condition filter (0 = off): no trade that day when the option to buy is dear — its premium as a % of NIFTY,
   * divided by √(days to expiry + 1), above this level (an active, expensive-option market). */
  maxOptionLevel: number;
  /** Weak-setup target (%, 0 = off): instead of the session target, this smaller target when the traded pair's second
   * candle body is under `weakBodyPoints` points, or the contract is `weakMinDaysToExpiry` or more days from expiry. */
  /** Skip risky times (off by default): no trade that session when, at the decision, NIFTY has moved only
   * 0–`riskyWeakMovePoints` points in the trade's direction since the 09:15 open, or the option level (premium as a % of
   * NIFTY ÷ √(days to expiry + 1)) is between `riskyOptionLevelMin` and `riskyOptionLevelMax`. */
  skipRiskyTimes: boolean;
  /** At a risky time: "skip" — no trade that session; "half" — the trade is still taken, with half the lots. */
  riskyAction: "skip" | "half";
  riskyWeakMovePoints: number;
  riskyOptionLevelMin: number;
  riskyOptionLevelMax: number;
  weakTargetPercent: number;
  weakBodyPoints: number;
  weakMinDaysToExpiry: number;
  /** Red drawn + green second candle closing above the mid, a CALL: the PUT instead when the second candle opened more
   * than this many points above the mid. 0 = off. */
  redGreenOpenFlip: number;
  /** Red drawn + red second candle below the mid, a PUT: wait one hour and buy the CALL when the second candle's lower
   * wick is over this % of its range. 0 = off. */
  redRedWaitOppWick: number;
  /** With `redRedWaitOppWick`: the lower wick must also be at least this many points. 0 = no minimum. */
  redRedWaitOppPoints: number;
  /** Red drawn + red second candle below the mid, a PUT: wait one hour (same side) when the drawn candle's lower wick
   * is over `redRedDrawnLowerWick` points and its upper wick over `redRedDrawnUpperWick` points — not when the second
   * candle's lower wick is over `redRedWaitOppWick` % of its range. 0 = off. */
  redRedDrawnLowerWick: number;
  redRedDrawnUpperWick: number;
  /** Day-trend exemption for a Short position whose second candle closes above the mid (a PUT): "check" (default) —
   * the day-trend filter applies; "first" — not on the 09:15 + 10:15 pair (at 11:15 that PUT is always above the day's
   * open, so the filter would block every one); "all" — never. */
  shortAboveTrend: "check" | "first" | "all";
  greenRedMode: "daily" | "all";
  /** Green–red allowance (points, 0 = off): for a green drawn candle and a red second candle closing below the mid, an
   * open up to this far above the mid is not a cross — the body rule lets it through and the normal decision (a CALL)
   * stands; the green–red PUT applies only above it. */
  greenRedTolerance: number;
  /** With the green–red allowance: a red second candle (closing below a green drawn candle's mid) that opened within
   * `greenRedTolerance` of the mid (above or below) is a CALL even against the day's move — this rule comes first. */
  greenRedTrendFree: boolean;
  /** The green–red pattern also when the red second candle opens exactly at the mid (open − mid = 0.00). */
  greenRedAtMid: boolean;
  /** Where the green–red allowance applies: "all" — any hour (the body rule lets it through); "daily" — only the daily
   * trade's direction (a CALL, not the green–red PUT); normal trades keep the strict body rule. */
  greenRedToleranceMode: "all" | "daily";
  fallbackTime: string;
  /** What of the second candle must stay inside the box: its body only (default — the wicks may go anywhere) or its body
   * and wicks. */
  boxCheck: "body" | "wick";
  /** "wick" box: never smaller than this many points (0 = the wick as it is). A candle with no wick on its stop side
   * uses its body (|open − close|) instead. */
  boxMinPoints: number;
  /** Optional (off by default): the box's losing (red) edge is a NIFTY stop, as on a TradingView position — the trade exits
   * once NIFTY trades at it (a 1-minute low at or below a LONG box's bottom, a high at or above a SHORT box's top). */
  boxStop: boolean;
  /** Optional (off by default): the box's winning (green) edge is a NIFTY target — the trade exits once NIFTY trades at it.
   * When a minute reaches both edges, the stop is taken (the order inside a minute is not known). */
  boxTarget: boolean;
  /** The hourly midpoint exit (on by default). */
  midpointExit: boolean;
  /** The position's entry (mid) on the drawn candle: "bodyLow" — the bottom of its body (a red candle's close,
   * a green candle's open), its close (default), or its open. */
  referencePrice: "open" | "close" | "bodyLow";
  /** Session-loss safety limit (₹, realized; 0 = off): no new entries once reached. */
  maxSessionLoss: number;
};

export const HOURLY_SETTINGS_DEFAULTS: HourlySettings = { dojiTolerance: 0, zoneMinPoints: 0, zoneMaxPoints: 0, skipCandle: "second", skipPart: "body", skipSide: "against", skipWickPercent: 0, skipWickPoints: 4, skipWickFor: "short", bodyCrossPoints: 0, pairStep: "sliding", boxMode: "off", boxSize: 0, boxSkip: true, boxLongLowFree: false, boxCheck: "wick", maxRejectionWickPercent: 0, maxLossWickPercent: 0, minSecondBodyPercent: 0, oppositeOnFail: "off", directionFrom: "position", gapPoints: 0, dailyFallback: true, trendFilter: false, trendTolerance: 0, crossFlip: "off", crossTolerance: 0, redAgainstFlip: 0, redRedDailyCall: 0, redGreenDailyPut: 0, greenRedPut: 0, greenRedMode: "daily", greenRedTolerance: 0, greenRedTrendFree: false, greenRedAtMid: false, greenRedToleranceMode: "all", redRedMaxLowerWick: 0, wickCall: 0, wickCallMode: "override", wickCallAnyTrendDays: "", wickCallAnyTrendShare: 0, wickPutPercent: 0, wickPutTrend: false, wickPutTouch: 0, shortAboveTrend: "check", thinWickPut: 0, thinWickCall: 0, dearFlipPremium: 0, dearFlipBody: 50, greenRedHighGap: 0, greenRedDrawnWick: 0, redRedWaitWick: 0, redRedWaitBody: 0, greenGreenWaitWick: 0, greenGreenWaitBy: "", greenGreenWaitNoDearFlip: false, greenRedDailyTrend: false, greenRedDrawnWickTrend: false, greenRedTrendMaxRange: 0, redGreenBodyTolerance: 0, redGreenWaitPremium: 0, earlyExitMinutes: 0, earlyExitPercent: 0, expiryEarlyExitMinutes: 0, expiryEarlyExitPercent: 0, riskyEarlyExitMinutes: 0, riskyEarlyExitPercent: 0, protectArmPercent: 0, protectLockPercent: 0, ggWaitFirstHourMin: 0, ggWaitFirstHourMax: 0, callWaitDayMoveMin: 0, callWaitDayMoveMax: 0, dte3OppWick: 0, maxOptionLevel: 0, skipRiskyTimes: false, riskyAction: "skip", riskyWeakMovePoints: 50, riskyOptionLevelMin: 0.215, riskyOptionLevelMax: 0.25, weakTargetPercent: 0, weakBodyPoints: 0, weakMinDaysToExpiry: 0, redGreenOpenFlip: 0, redRedWaitOppWick: 0, redRedWaitOppPoints: 0, redRedDrawnLowerWick: 0, redRedDrawnUpperWick: 0, fallbackTime: "13:15", longLowBelowBoxPoints: -1, boxMinPoints: 0, boxStop: false, boxTarget: false, midpointExit: true, referencePrice: "close", maxSessionLoss: 0 };

const HOUR = 3_600;
/** The cash session: 09:15–15:30 IST. */
const SESSION_SECONDS = 22_500;
/** A live feed may deliver an hour's last minute late: the hour is read without it only after this long. */
export const HOUR_GRACE_SECONDS = 120;

export type HourCandle = { start: number; end: number; open: number; high: number; low: number; close: number; minutes: number; complete: boolean };
export type CandleColor = "GREEN" | "RED" | "DOJI";
export type PairStatus = "WAITING" | "CONFIRMED" | "SKIPPED";

export type HourlyPair = {
  /** The time the decision is made (the second candle's close), unix seconds. */
  decisionTime: number;
  first: HourCandle;
  second: HourCandle | null;
  color: CandleColor;
  direction: "LONG" | "SHORT" | null;
  side: Direction | null;
  /** The position's entry (mid) on the first candle — its open or its close (`referencePrice`): fixed, never moved. */
  reference: number;
  /** The position box's outer edges (when set). */
  box?: { top: number; bottom: number } | null;
  status: PairStatus;
  /** The thin-wick pattern (`thinWickPut`): traded as a PUT. */
  thinWick?: boolean;
  /** The red–green wick pattern (`wickCall`): traded as a CALL. */
  wickCall?: boolean;
  /** The green–red pattern (`greenRedPut`): traded as a PUT. */
  greenRed?: boolean;
  /** The red–red cross pattern (`crossFlip`): traded as a CALL. */
  cross?: boolean;
  /** A failed pair traded anyway as the day's trade (`dailyFallback`). */
  fallback?: boolean;
  /** A failed pair traded the other way (`oppositeOnFail`). */
  opposite?: { direction: "LONG" | "SHORT"; side: Direction } | null;
  /** Every reason a SKIPPED pair failed (empty otherwise). */
  reasons: string[];
  /** Every condition checked, with the exact OHLC values. */
  checks: string[];
};

/** What happened to a trade taken on a pair (filled in by the runner). */
export type HourlyTradeStatus = "ENTERED" | "TARGET HIT" | "MIDPOINT EXIT" | "EARLY EXIT" | "GAIN PROTECTED" | "BOX STOP" | "BOX TARGET" | "SESSION CLOSED" | "EXITED";
export type HourlyMidpoint = { start: number; end: number; high: number; low: number; close: number; mid: number; keep: boolean };
export type HourlyTrade = {
  entryKey: string;
  decisionTime: number;
  side: Direction;
  reference: number;
  underlyingEntry: number;
  entryTime: number;
  premium: number;
  target: number;
  status: HourlyTradeStatus;
  shadow?: boolean;
  exitTime?: number;
  exitPremium?: number;
  exitReason?: string;
  pnl?: number;
  /** The largest fall of the premium below the entry while open, per unit. */
  adverse?: number;
  midpoints: HourlyMidpoint[];
};

export type HourlyState = {
  status: string;
  hours: HourCandle[];
  pairs: HourlyPair[];
  checks: string[];
  trades?: HourlyTrade[];
};

const fmt = (value: number) => value.toFixed(2);
const round = (value: number) => Math.round(value * 100) / 100;
export const istClock = (time: number) => new Date((time + 19_800) * 1000).toISOString().slice(11, 16);
const ohlc = (candle: { open: number; high: number; low: number; close: number }) => `O ${fmt(candle.open)} H ${fmt(candle.high)} L ${fmt(candle.low)} C ${fmt(candle.close)}`;
const span = (hour: { start: number; end: number }) => `${istClock(hour.start)}–${istClock(hour.end)}`;

/**
 * The session's hourly candles from its completed 1-minute candles, on the 09:15 grid. An hour is complete once
 * `now` is past its end and its last minute is in (or the grace period has passed). The 15:15–15:30 remainder
 * is returned too, but it is never a full hour.
 */
export function hourlyCandles(candles: Candle[], sessionOpen: number, now: number): HourCandle[] {
  const close = sessionOpen + SESSION_SECONDS;
  const buckets = new Map<number, HourCandle>();
  for (const candle of [...candles].sort((a, b) => a.time - b.time)) {
    if (candle.time < sessionOpen || candle.time >= close || candle.time + 60 > now) continue;
    const start = sessionOpen + Math.floor((candle.time - sessionOpen) / HOUR) * HOUR;
    const hour = buckets.get(start);
    if (!hour) buckets.set(start, { start, end: Math.min(start + HOUR, close), open: candle.open, high: candle.high, low: candle.low, close: candle.close, minutes: 1, complete: false });
    else Object.assign(hour, { high: Math.max(hour.high, candle.high), low: Math.min(hour.low, candle.low), close: candle.close, minutes: hour.minutes + 1 });
  }
  const lastMinute = new Set(candles.filter((candle) => candle.time + 60 <= now).map((candle) => candle.time));
  return [...buckets.values()].sort((a, b) => a.start - b.start).map((hour) => ({ ...hour, complete: now >= hour.end && (lastMinute.has(hour.end - 60) || now >= hour.end + HOUR_GRACE_SECONDS) }));
}

export const isFullHour = (hour: Pick<HourCandle, "start" | "end">) => hour.end - hour.start === HOUR;

/** Green: close above open; red: below; doji: within the tolerance. */
export function candleColor(candle: { open: number; close: number }, tolerance: number): CandleColor {
  const move = candle.close - candle.open;
  if (Math.abs(move) <= Math.max(0, tolerance)) return "DOJI";
  return move > 0 ? "GREEN" : "RED";
}

/** Red first candle → LONG (buy the ATM CALL); green → SHORT (buy the ATM PUT); doji → no direction. Options are only ever bought. */
export function directionOf(color: CandleColor): { direction: "LONG" | "SHORT"; side: Direction } | null {
  if (color === "RED") return { direction: "LONG", side: "CALL" };
  if (color === "GREEN") return { direction: "SHORT", side: "PUT" };
  return null;
}

/** Whether a close `beyond` points past the reference is far enough: at least `zoneMinPoints`, or any distance above 0 when it is 0. */
const farEnough = (beyond: number, min: number) => round(beyond) > 0 && round(beyond) >= min;

/** LONG zone: the close is at least `zoneMinPoints` above the reference (above it when 0) and (when set) at most `zoneMaxPoints` above it. */
export function longZone(close: number, reference: number, settings: Pick<HourlySettings, "zoneMinPoints" | "zoneMaxPoints">): { ok: boolean; text: string } {
  const beyond = close - reference;
  const max = settings.zoneMaxPoints > 0 ? settings.zoneMaxPoints : null;
  const ok = farEnough(beyond, settings.zoneMinPoints) && (max == null || beyond <= max);
  const zone = `the LONG zone is ${settings.zoneMinPoints > 0 ? `at or above ${fmt(reference + settings.zoneMinPoints)} (${fmt(settings.zoneMinPoints)} points)` : `above ${fmt(reference)}`}${max != null ? ` up to ${fmt(reference + max)}` : ""}`;
  return { ok, text: `close ${fmt(close)} is ${beyond >= 0 ? `${fmt(beyond)} points above` : `${fmt(-beyond)} points below`} the reference ${fmt(reference)}; ${zone}` };
}

/** SHORT zone: the mirror of the LONG zone, below the reference. */
export function shortZone(close: number, reference: number, settings: Pick<HourlySettings, "zoneMinPoints" | "zoneMaxPoints">): { ok: boolean; text: string } {
  const beyond = reference - close;
  const max = settings.zoneMaxPoints > 0 ? settings.zoneMaxPoints : null;
  const ok = farEnough(beyond, settings.zoneMinPoints) && (max == null || beyond <= max);
  const zone = `the SHORT zone is ${settings.zoneMinPoints > 0 ? `at or below ${fmt(reference - settings.zoneMinPoints)} (${fmt(settings.zoneMinPoints)} points)` : `below ${fmt(reference)}`}${max != null ? ` down to ${fmt(reference - max)}` : ""}`;
  return { ok, text: `close ${fmt(close)} is ${beyond >= 0 ? `${fmt(beyond)} points below` : `${fmt(-beyond)} points above`} the reference ${fmt(reference)}; ${zone}` };
}

/** The configured wick / body skip rule on one candle: the violation in words, or null when the rule holds (or is off). */
export function skipViolation(direction: "LONG" | "SHORT", candle: { open: number; high: number; low: number; close: number }, reference: number, settings: Pick<HourlySettings, "skipPart" | "skipSide"> & Partial<Pick<HourlySettings, "skipWickPercent" | "skipWickPoints" | "skipWickFor" | "bodyCrossPoints">>): string | null {
  if (settings.skipPart === "off") return null;
  // A LONG with the wick limits for SHORT only: its wick may cross by any amount; its body still may not.
  const wickFree = settings.skipPart === "wick" && settings.skipSide === "against" && settings.skipWickFor === "short" && direction === "LONG";
  const share = wickFree ? 0 : settings.skipWickPercent ?? 0;
  const points = wickFree ? Number.POSITIVE_INFINITY : settings.skipWickPoints ?? 0;
  if (settings.skipPart === "wick" && settings.skipSide === "against" && points > 0) {
    // The body may not cross; the wick may, by at most `points`.
    const long = direction === "LONG";
    const bodyEdge = long ? Math.min(candle.open, candle.close) : Math.max(candle.open, candle.close);
    if (long ? bodyEdge < reference : bodyEdge > reference) return `its body reaches ${fmt(bodyEdge)}, ${long ? "below" : "above"} the ${direction} reference ${fmt(reference)}`;
    const past = round(long ? reference - candle.low : candle.high - reference);
    return past > points ? `its wick reaches ${fmt(long ? candle.low : candle.high)}, ${fmt(past)} points ${long ? "below" : "above"} the ${direction} reference ${fmt(reference)} (more than ${fmt(points)})` : null;
  }
  if (settings.skipPart === "wick" && settings.skipSide === "against" && share > 0) {
    // The body may not cross; the wick may, up to `share` % of its length.
    const long = direction === "LONG";
    const bodyEdge = long ? Math.min(candle.open, candle.close) : Math.max(candle.open, candle.close);
    if (long ? bodyEdge < reference : bodyEdge > reference) return `its body reaches ${fmt(bodyEdge)}, ${long ? "below" : "above"} the ${direction} reference ${fmt(reference)}`;
    const length = long ? bodyEdge - candle.low : candle.high - bodyEdge;
    const past = long ? reference - candle.low : candle.high - reference;
    if (!(past > 0) || !(length > 0)) return null;
    const percent = Math.min(100, (past / length) * 100);
    return percent > share ? `${percent.toFixed(0)}% of its ${long ? "lower" : "upper"} wick (${fmt(past)} of ${fmt(length)} points, to ${fmt(long ? candle.low : candle.high)}) is ${long ? "below" : "above"} the ${direction} reference ${fmt(reference)}, more than ${share}%` : null;
  }
  const wick = settings.skipPart === "wick";
  const top = wick ? candle.high : Math.max(candle.open, candle.close);
  const bottom = wick ? candle.low : Math.min(candle.open, candle.close);
  const part = wick ? "wick" : "body";
  // The body may cross the mid by a few points (a candle opens where the drawn one closed, give or take a tick or two).
  const allowed = wick ? 0 : Math.max(0, settings.bodyCrossPoints ?? 0);
  const note = allowed > 0 ? ` (more than the ${fmt(allowed)} points allowed)` : "";
  if (settings.skipSide === "above" || direction === "SHORT") {
    return round(top - reference) > allowed ? `its ${part} reaches ${fmt(top)}, ${fmt(top - reference)} points above the ${direction} reference ${fmt(reference)}${note}` : null;
  }
  return round(reference - bottom) > allowed ? `its ${part} reaches ${fmt(bottom)}, ${fmt(reference - bottom)} points below the LONG reference ${fmt(reference)}${note}` : null;
}

/** The position box on the reference: its top and bottom edges, or null when the box has no edge. */
export function positionBox(first: { high: number; low: number; open?: number; close?: number }, reference: number, settings: Pick<HourlySettings, "boxMode" | "boxSize"> & Partial<Pick<HourlySettings, "boxMinPoints">>, direction: "LONG" | "SHORT" | null = null): { top: number; bottom: number; height: number } | null {
  if (settings.boxMode === "off") return null;
  if (settings.boxMode === "wick") {
    if (!direction) return null;
    const wick = round(direction === "LONG" ? reference - first.low : first.high - reference);
    // No wick on the stop side: the body (open to close) sets the box instead.
    const body = first.open != null && first.close != null ? Math.abs(first.open - first.close) : 0;
    const height = round(Math.max(wick > 0 ? wick : body, settings.boxMinPoints ?? 0));
    return height > 0 ? { top: round(reference + height), bottom: round(reference - height), height } : null;
  }
  if (!(settings.boxSize > 0)) return null;
  const height = round(settings.boxMode === "range" ? settings.boxSize * (first.high - first.low) : settings.boxSize);
  return height > 0 ? { top: round(reference + height), bottom: round(reference - height), height } : null;
}

/** A candle whose body or wick goes beyond the box's top or bottom edge: the violation in words, or null. */
export function boxViolation(candle: { high: number; low: number }, box: { top: number; bottom: number } | null): string | null {
  if (!box) return null;
  const out = [candle.high > box.top ? `its high ${fmt(candle.high)} is above the box top ${fmt(box.top)}` : "", candle.low < box.bottom ? `its low ${fmt(candle.low)} is below the box bottom ${fmt(box.bottom)}` : ""].filter(Boolean);
  return out.length ? out.join(" and ") : null;
}

/** The pairs of full hours, in decision order: [first, second] hour indexes. */
export function pairSchedule(step: HourlySettings["pairStep"], fullHours = 6): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let first = 0; first + 1 < fullHours; first += step === "next" ? 2 : 1) pairs.push([first, first + 1]);
  return pairs;
}

/** Evaluates one pair (its first candle complete; the second complete or not yet). */
export function evaluatePair(first: HourCandle, second: HourCandle | null, settings: HourlySettings, dayOpen: number | null = null): HourlyPair {
  const color = candleColor(first, settings.dojiTolerance);
  const reference = round(settings.referencePrice === "close" ? first.close : settings.referencePrice === "open" ? first.open : Math.min(first.open, first.close));
  // "close": the second candle's close against the mid sets the side (the drawn candle's colour is not used).
  // "position": the drawn candle's colour sets the position tool (and its box); the second candle's side of the mid and
  // the tool together set the trade.
  const fromClose = settings.directionFrom === "close";
  const fromPosition = settings.directionFrom === "position";
  const closed = second?.complete ? second : null;
  const tool = directionOf(color);
  const where = closed ? (round(closed.close - reference) > 0 ? "above" : round(closed.close - reference) < 0 ? "below" : null) : null;
  const CALL = { direction: "LONG" as const, side: "CALL" as const };
  const PUT = { direction: "SHORT" as const, side: "PUT" as const };
  const mapped = fromClose ? (where ? (where === "above" ? CALL : PUT) : null)
    : fromPosition ? (tool && where ? ((tool.direction === "LONG") === (where === "above") ? CALL : PUT) : null)
    : directionOf(color);
  // The second candle's own side of the mid (zone, body and difference rules), and the box's side.
  const sideOf = fromClose || fromPosition ? (where === "above" ? "LONG" as const : "SHORT" as const) : mapped?.direction ?? null;
  const boxSide = fromPosition ? tool?.direction ?? null : mapped?.direction ?? null;
  const decisionTime = first.end + HOUR;
  const drawn = fromClose ? `${color.toLowerCase()} (its colour is not used: the next candle's close against the mid sets CALL or PUT)`
    : color === "DOJI" ? `doji (|close − open| ≤ ${fmt(settings.dojiTolerance)})`
    : fromPosition ? `${color === "RED" ? "red → Long" : "green → Short"} position (${color === "RED" ? "above the mid → CALL, below → PUT" : "above the mid → PUT, below → CALL"})`
    : color === "RED" ? "red → LONG, ATM CALL" : "green → SHORT, ATM PUT";
  const checks = [`First candle ${span(first)}: ${ohlc(first)} — ${drawn}; reference ${fmt(reference)} (its ${settings.referencePrice === "close" ? "close" : settings.referencePrice === "open" ? "open" : `body bottom: its ${first.close <= first.open ? "close" : "open"}`}).`];
  const box = positionBox(first, reference, settings, boxSide);
  const base = { decisionTime, first, second, color, direction: mapped?.direction ?? null, side: mapped?.side ?? null, reference, box: box ? { top: box.top, bottom: box.bottom } : null };
  if (box) checks.push(`Position box ${fmt(box.bottom)}–${fmt(box.top)} (${fmt(box.height)} points each side of the reference).`);
  if (fromPosition && !tool) return { ...base, status: "SKIPPED", reasons: [`the first candle ${span(first)} is a doji (open ${fmt(first.open)}, close ${fmt(first.close)}): no position to draw`], checks };
  if ((fromClose || fromPosition) && !closed) return { ...base, status: "WAITING", reasons: [], checks };
  if ((fromClose || fromPosition) && !mapped) return { ...base, status: "SKIPPED", reasons: [`the second candle closed exactly on the mid ${fmt(reference)}: neither CALL nor PUT`], checks };
  if (!mapped) return { ...base, status: "SKIPPED", reasons: [`the first candle ${span(first)} is a doji (open ${fmt(first.open)}, close ${fmt(first.close)})`], checks };
  if (fromClose) checks.push(`Direction: the second candle closed at ${fmt(closed!.close)}, ${closed!.close > reference ? "above" : "below"} the mid ${fmt(reference)} → ${mapped.direction}, ATM ${mapped.side}.`);
  if (fromPosition) checks.push(`Direction: ${tool!.direction === "LONG" ? "Long" : "Short"} position; the second candle closed at ${fmt(closed!.close)}, ${where} the mid ${fmt(reference)} → ATM ${mapped.side}.`);
  const stopSide = boxSide ?? mapped.direction;
  if (settings.boxMode === "wick" && !box) return { ...base, status: "SKIPPED", reasons: [`the drawn candle ${span(first)} has no wick ${stopSide === "LONG" ? "below" : "above"} its close and no body (${stopSide === "LONG" ? `low ${fmt(first.low)}` : `high ${fmt(first.high)}`}, open ${fmt(first.open)}, close ${fmt(first.close)}): no stop level for the position`], checks };
  if (!second || !second.complete) return { ...base, status: "WAITING", reasons: [], checks };
  checks.push(`Second candle ${span(second)}: ${ohlc(second)}; body ${fmt(Math.min(second.open, second.close))}–${fmt(Math.max(second.open, second.close))}, upper wick ${fmt(second.high - Math.max(second.open, second.close))}, lower wick ${fmt(Math.min(second.open, second.close) - second.low)}.`);
  const reasons: string[] = [];
  const own = sideOf ?? mapped.direction;
  const zone = own === "LONG" ? longZone(second.close, reference, settings) : shortZone(second.close, reference, settings);
  checks.push(`${zone.ok ? "✓" : "✗"} Zone: ${zone.text}.`);
  if (!zone.ok) reasons.push(`the second candle closed outside the ${own} zone (${zone.text})`);
  const ruled = settings.skipCandle === "first" ? first : second;
  // 1-point difference rule: the measured price of the second candle against the mid.
  if (settings.gapPoints > 0) {
    const long = own === "LONG";
    const green = second.close > second.open;
    // The body edge nearest the mid.
    const useOpen = long ? second.open <= second.close : second.open >= second.close;
    const price = useOpen ? second.open : second.close;
    const gap = round(long ? price - reference : reference - price);
    const text = `the second candle's ${useOpen ? "open" : "close"} ${fmt(price)} is ${fmt(Math.abs(gap))} points ${price >= reference ? "above" : "below"} the mid ${fmt(reference)}`;
    checks.push(`${gap >= settings.gapPoints ? "✓" : "✗"} ${settings.gapPoints}-point rule (${long ? "above" : "below"} the mid, ${green ? "green" : "red"} second candle): ${text} (at least ${fmt(settings.gapPoints)} ${long ? "above" : "below"}).`);
    if (gap < settings.gapPoints) reasons.push(`${text}: less than the ${fmt(settings.gapPoints)}-point difference ${long ? "above" : "below"} it`);
  }
  // Red–red allowance: a red second candle closing below the mid that opened only a few points above it.
  const redDown = color === "RED" && second.close < second.open && second.close < reference;
  const nearOpen = redDown && settings.crossTolerance > 0 && second.open > reference && round(second.open - reference) <= settings.crossTolerance;
  // Green–red allowance: the same for a green drawn candle (a Short position) and a red second candle closing below.
  const greenRedDown = color === "GREEN" && second.close < second.open && second.close < reference && (second.open > reference || (settings.greenRedAtMid && round(second.open - reference) === 0));
  const greenNear = greenRedDown && settings.greenRedTolerance > 0 && round(second.open - reference) <= settings.greenRedTolerance;
  // Red–green allowance: a green second candle closing above the mid that opened only a few points below it.
  const redGreenNear = settings.redGreenBodyTolerance > 0 && color === "RED" && second.close > second.open && second.close > reference && second.open < reference && round(reference - second.open) <= settings.redGreenBodyTolerance;
  const allowance = nearOpen ? settings.crossTolerance : redGreenNear ? settings.redGreenBodyTolerance : greenNear && settings.greenRedToleranceMode === "all" ? settings.greenRedTolerance : 0;
  const violation = skipViolation(own, ruled, reference, allowance > 0 ? { ...settings, bodyCrossPoints: Math.max(settings.bodyCrossPoints, allowance) } : settings);
  if (redGreenNear) checks.push(`Red–green allowance: the second candle opened ${fmt(reference - second.open)} points below the mid (at most ${fmt(settings.redGreenBodyTolerance)}) — not a cross.`);
  if (nearOpen) checks.push(`Red–red allowance: the second candle opened ${fmt(second.open - reference)} points above the mid (at most ${fmt(settings.crossTolerance)}) — not a cross.`);
  if (greenNear) checks.push(`Green–red allowance: the second candle opened ${fmt(second.open - reference)} points above the mid (at most ${fmt(settings.greenRedTolerance)}) — not a cross; ${settings.greenRedToleranceMode === "daily" ? "the daily trade keeps the normal side" : "the normal decision stands"}.`);
  if (settings.skipPart !== "off") checks.push(`${violation ? "✗" : "✓"} ${settings.skipPart === "wick" ? "Wick" : "Body"} rule on the ${settings.skipCandle} candle (${settings.skipSide === "against" ? "no crossing into the losing side" : "no crossing above"} of the reference): ${violation ?? "holds"}.`);
  if (violation) reasons.push(`the ${settings.skipCandle} candle broke the ${settings.skipPart} rule: ${violation}`);
  // LONG: the low may break the box bottom by a few points only.
  if (box && mapped.direction === "LONG" && settings.longLowBelowBoxPoints >= 0) {
    const below = round(box.bottom - second.low);
    if (below > settings.longLowBelowBoxPoints) reasons.push(`the second candle's low ${fmt(second.low)} is ${fmt(below)} points below the box bottom ${fmt(box.bottom)} (more than ${fmt(settings.longLowBelowBoxPoints)})`);
    else checks.push(`✓ LONG: the low ${fmt(second.low)} is ${below > 0 ? `${fmt(below)} points below` : "inside"} the box bottom ${fmt(box.bottom)} (at most ${fmt(settings.longLowBelowBoxPoints)} allowed).`);
  }
  // Rejection filter: the profit-side wick as a share of the second candle's range.
  if (settings.maxRejectionWickPercent > 0) {
    const range = second.high - second.low;
    const wick = mapped.direction === "LONG" ? second.high - Math.max(second.open, second.close) : Math.min(second.open, second.close) - second.low;
    const percent = range > 0 ? (wick / range) * 100 : 0;
    checks.push(`${percent > settings.maxRejectionWickPercent ? "✗" : "✓"} Rejection: the ${mapped.direction === "LONG" ? "upper" : "lower"} wick is ${percent.toFixed(0)}% of the second candle (limit ${settings.maxRejectionWickPercent}%).`);
    if (percent > settings.maxRejectionWickPercent) reasons.push(`the second candle's ${mapped.direction === "LONG" ? "upper" : "lower"} wick (${fmt(wick)} of ${fmt(range)} points, ${percent.toFixed(0)}%) is a rejection: more than ${settings.maxRejectionWickPercent}% of the candle`);
  }
  // Loss-side wick filter: the losing-side wick as a share of the second candle's range.
  if (settings.maxLossWickPercent > 0) {
    const range = second.high - second.low;
    const wick = mapped.direction === "LONG" ? Math.min(second.open, second.close) - second.low : second.high - Math.max(second.open, second.close);
    const percent = range > 0 ? (wick / range) * 100 : 0;
    const side = mapped.direction === "LONG" ? "lower" : "upper";
    checks.push(`${percent > settings.maxLossWickPercent ? "✗" : "✓"} Loss-side wick: the ${side} wick is ${percent.toFixed(0)}% of the second candle (limit ${settings.maxLossWickPercent}%).`);
    if (percent > settings.maxLossWickPercent) reasons.push(`the second candle's ${side} wick (${fmt(wick)} of ${fmt(range)} points, ${percent.toFixed(0)}%) is more than ${settings.maxLossWickPercent}% of the candle: price already pushed against the trade`);
  }
  // Red–red bounce filter: a long lower wick under a red PUT candle.
  if (settings.redRedMaxLowerWick > 0 && color === "RED" && mapped.side === "PUT" && second.close < second.open && second.close < reference) {
    const lowerWick = round(second.close - second.low);
    const ok = lowerWick < settings.redRedMaxLowerWick;
    checks.push(`${ok ? "✓" : "✗"} Red–red bounce: the second candle's lower wick is ${fmt(lowerWick)} points (under ${fmt(settings.redRedMaxLowerWick)}).`);
    if (!ok) reasons.push(`the second candle's lower wick is ${fmt(lowerWick)} points (${fmt(settings.redRedMaxLowerWick)} or more): buyers pushed it back up from ${fmt(second.low)}`);
  }
  // Day-trend filter: the trade goes with the day's move since the 09:15 open.
  const shortAbove = color === "GREEN" && mapped.side === "PUT" && second.close > reference;
  const firstPair = dayOpen != null && first.open === dayOpen;
  // Green drawn, red second candle closing below the mid with its open within the green–red allowance: CALL first.
  const greenWithin = settings.greenRedTrendFree && settings.greenRedTolerance > 0 && color === "GREEN" && second.close < second.open && second.close < reference && Math.abs(round(second.open - reference)) <= settings.greenRedTolerance;
  const trendExempt = greenWithin || (shortAbove && (settings.shortAboveTrend === "all" || (settings.shortAboveTrend === "first" && firstPair)));
  if (trendExempt) checks.push(greenWithin ? `Day trend not applied: green drawn candle, red second candle opening within ${fmt(settings.greenRedTolerance)} of the mid → CALL first.` : `Day trend not applied: Short position, second candle above the mid → PUT${settings.shortAboveTrend === "first" ? " on the first pair" : ""}.`);
  if (settings.trendFilter && dayOpen != null && !trendExempt) {
    const up = second.close > dayOpen;
    const slack = Math.max(0, settings.trendTolerance);
    const diff = round(mapped.side === "CALL" ? second.close - dayOpen : dayOpen - second.close);
    // With an allowance, a miss up to and including it passes; without one the close must be on the right side.
    const ok = slack > 0 ? diff >= -slack : diff > 0;
    checks.push(`${ok ? "✓" : "✗"} Day trend: the second candle closed at ${fmt(second.close)}, ${up ? "above" : "below"} the day's open ${fmt(dayOpen)} — ${ok ? "with" : "against"} the ${mapped.side}.`);
    if (!ok) reasons.push(`the ${mapped.side} is against the day's move: the second candle closed at ${fmt(second.close)}, ${up ? "above" : "at or below"} the 09:15 open ${fmt(dayOpen)}`);
  }
  // Strong-candle filter: the second candle's body as a share of its range.
  if (settings.minSecondBodyPercent > 0) {
    const range = second.high - second.low;
    const body = Math.abs(second.close - second.open);
    const percent = range > 0 ? (body / range) * 100 : 0;
    checks.push(`${percent < settings.minSecondBodyPercent ? "✗" : "✓"} Strong candle: the second candle's body is ${percent.toFixed(0)}% of its range (at least ${settings.minSecondBodyPercent}%).`);
    if (percent < settings.minSecondBodyPercent) reasons.push(`the second candle's body (${fmt(body)} of ${fmt(range)} points, ${percent.toFixed(0)}%) is less than ${settings.minSecondBodyPercent}% of the candle: no strong move`);
  }
  // The body only (default): its top and bottom against the box; else the wicks too (a LONG's low may be free).
  const bodyOnly = settings.boxCheck !== "wick";
  const extent = bodyOnly ? { high: Math.max(second.open, second.close), low: Math.min(second.open, second.close) } : second;
  const checked = box && !bodyOnly && settings.boxLongLowFree && stopSide === "LONG" ? { top: box.top, bottom: Number.NEGATIVE_INFINITY } : box;
  const outside = settings.boxSkip ? boxViolation(extent, checked) : null;
  if (box && settings.boxSkip) checks.push(`${outside ? "✗" : "✓"} Box: the second candle's ${bodyOnly ? "body" : "body and wick"} ${outside ? `go${bodyOnly ? "es" : ""} out of the box — ${outside}` : `stay${bodyOnly ? "s" : ""} inside the box`}.`);
  if (outside) reasons.push(`the second candle's ${bodyOnly ? "body" : "candle"} went out of the position box: ${outside.replace("its high", bodyOnly ? "its body top" : "its high").replace("its low", bodyOnly ? "its body bottom" : "its low")}`);
  // Red–red cross: a red drawn candle, a red second candle opening above the mid and closing below it (most of its body
  // below) → CALL.
  // An open within `bodyCrossPoints` of the mid has not crossed it (the body rule allows it): our normal decision stands.
  const crossed = settings.crossFlip !== "off" && redDown && round(second.open - reference) > Math.max(0, settings.bodyCrossPoints, settings.crossTolerance) && reference - second.close > second.open - reference;
  // Thin-wick PUT: a red drawn candle, a green second candle above the mid with (almost) no lower wick → PUT.
  if (settings.thinWickPut > 0 && color === "RED" && mapped.side === "CALL" && second.close > second.open && second.close > reference && round(second.open - second.low) <= settings.thinWickPut) {
    checks.push(`Thin wick: the green second candle's lower wick is ${fmt(second.open - second.low)} points (at most ${fmt(settings.thinWickPut)}) → ATM PUT instead of the CALL.`);
    return { ...base, direction: "SHORT", side: "PUT", thinWick: true, status: reasons.length ? "SKIPPED" : "CONFIRMED", reasons, checks };
  }
  // Thin-wick CALL: a red drawn candle, a red second candle below the mid with (almost) no lower wick → CALL.
  if (settings.thinWickCall > 0 && color === "RED" && mapped.side === "PUT" && second.close < second.open && second.close < reference && round(second.close - second.low) < settings.thinWickCall) {
    checks.push(`Thin wick: the red second candle's lower wick is ${fmt(second.close - second.low)} points (under ${fmt(settings.thinWickCall)}) → ATM CALL instead of the PUT.`);
    return { ...base, direction: "LONG", side: "CALL", thinWick: true, status: reasons.length ? "SKIPPED" : "CONFIRMED", reasons, checks };
  }
  // Red–green wick CALL: the green second candle's body stays above the mid; only its lower wick dips below it.
  const wickLength = Math.min(second.open, second.close) - second.low;
  const wickBelow = reference - second.low;
  const wickShare = wickLength > 0 && wickBelow > 0 ? (Math.min(wickBelow, wickLength) / wickLength) * 100 : 0;
  // Red–green wick PUT: only a red drawn candle with a green second candle closing above the mid, its whole body above
  // the mid, and (nearly) all of its lower wick below the mid → PUT.
  const opensAtMid = settings.wickPutTouch > 0 ? Math.abs(round(second.open - reference)) <= settings.wickPutTouch : second.open > reference;
  if (settings.wickPutPercent > 0 && color === "RED" && second.close > second.open && opensAtMid && second.close > reference && wickShare >= settings.wickPutPercent) {
    checks.push(`Red–green wick PUT: the body ${fmt(second.open)}–${fmt(second.close)} is above the mid ${fmt(reference)}; ${wickShare.toFixed(0)}% of the lower wick (${fmt(wickLength)} points, low ${fmt(second.low)}) is below it (at least ${settings.wickPutPercent}%) → ATM PUT.`);
    const kept = settings.wickPutTrend && dayOpen != null && !(second.close < dayOpen) ? [`the PUT is against the day's move: the second candle closed at ${fmt(second.close)}, above the 09:15 open ${fmt(dayOpen)}`] : [];
    return { ...base, direction: "SHORT", side: "PUT", wickCall: true, status: kept.length ? "SKIPPED" : "CONFIRMED", reasons: kept, checks };
  }
  if (settings.wickCall > 0 && color === "RED" && second.close > second.open && second.open > reference && wickShare >= settings.wickCall) {
    checks.push(`Red–green wick: the body ${fmt(second.open)}–${fmt(second.close)} is above the mid ${fmt(reference)}; ${wickShare.toFixed(0)}% of the lower wick (${fmt(wickLength)} points, low ${fmt(second.low)}) is below it (at least ${settings.wickCall}%) → ATM CALL.`);
    const weekday = new Date((first.start + 19_800) * 1000).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    const anyDay = settings.wickCallAnyTrendDays.split(",").map((day) => day.trim()).includes(weekday);
    const anyShare = settings.wickCallAnyTrendShare > 0 && wickShare >= settings.wickCallAnyTrendShare;
    const anyTrend = anyDay || anyShare;
    if (anyDay) checks.push(`Red–green wick on a ${weekday}: taken even against the day's move.`);
    else if (anyShare) checks.push(`Red–green wick: ${wickShare.toFixed(0)}% of the lower wick is below the mid (at least ${settings.wickCallAnyTrendShare}%): taken even against the day's move.`);
    const kept = settings.wickCallMode === "override" ? [] : reasons.filter((reason) => !reason.includes("zone") && !(anyTrend && reason.includes("day's move")));
    return { ...base, direction: "LONG", side: "CALL", wickCall: true, status: kept.length ? "SKIPPED" : "CONFIRMED", reasons: kept, checks };
  }
  // Green–red PUT: a green drawn candle, a red second candle closing below the mid that opened only just above it.
  const greenDown = settings.greenRedPut > 0 && !greenNear && greenRedDown && round(second.open - reference) <= settings.greenRedPut;
  if (greenDown) {
    checks.push(`Green–red: the second candle opened ${fmt(second.open - reference)} points above the mid ${fmt(reference)} (at most ${fmt(settings.greenRedPut)}) and closed ${fmt(reference - second.close)} below it → ATM PUT${settings.greenRedMode === "daily" ? " (if it is the daily trade)" : ""}.`);
    if (settings.greenRedMode === "all") {
      const kept = reasons.filter((reason) => !reason.includes("body rule") && !reason.includes("day's move"));
      if (settings.trendFilter && dayOpen != null && !(second.close < dayOpen)) kept.push(`the PUT is against the day's move: the second candle closed at ${fmt(second.close)}, at or above the 09:15 open ${fmt(dayOpen)}`);
      return { ...base, direction: "SHORT", side: "PUT", greenRed: true, status: kept.length ? "SKIPPED" : "CONFIRMED", reasons: kept, checks };
    }
    return { ...base, greenRed: true, status: reasons.length ? "SKIPPED" : "CONFIRMED", reasons, checks };
  }
  if (crossed) {
    checks.push(`Red–red cross: the second candle opened ${fmt(second.open - reference)} points above the mid ${fmt(reference)} and closed ${fmt(reference - second.close)} below it → ATM CALL${settings.crossFlip === "daily" ? " (if it is the daily trade)" : ""}.`);
    if (settings.crossFlip === "all") return { ...base, direction: "LONG", side: "CALL", cross: true, status: "CONFIRMED", reasons: [], checks };
    return { ...base, cross: true, status: reasons.length ? "SKIPPED" : "CONFIRMED", reasons, checks };
  }
  return { ...base, status: reasons.length ? "SKIPPED" : "CONFIRMED", reasons, checks };
}

/** The opposite trade for a failed pair (`oppositeOnFail`), or null. */
export function oppositeOf(pair: HourlyPair, settings: Pick<HourlySettings, "oppositeOnFail" | "zoneMinPoints" | "zoneMaxPoints">): { direction: "LONG" | "SHORT"; side: Direction } | null {
  if (settings.oppositeOnFail === "off" || pair.status !== "SKIPPED" || !pair.direction || !pair.second?.complete) return null;
  const flipped = pair.direction === "LONG" ? { direction: "SHORT" as const, side: "PUT" as const } : { direction: "LONG" as const, side: "CALL" as const };
  if (settings.oppositeOnFail === "anyRule") return flipped;
  const wrongSide = flipped.direction === "LONG" ? longZone(pair.second.close, pair.reference, settings).ok : shortZone(pair.second.close, pair.reference, settings).ok;
  return wrongSide ? flipped : null;
}

/**
 * The strategy on the session's completed 1-minute candles (the last one is the candle being evaluated). A signal is
 * returned only on the candle whose close completes a confirmed pair's second hour, so the same pair can never signal
 * twice; every pair seen so far is in the state, with its checks.
 */
export function hourlySignal(candles: Candle[], sessionOpen: number, input: Partial<HourlySettings>): { signal: StrategySignal | null; decided: HourlyPair | null; state: HourlyState } {
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...input };
  const ordered = [...candles].sort((a, b) => a.time - b.time);
  const last = ordered.at(-1);
  if (!last) return { signal: null, decided: null, state: { status: "WAITING — waiting for the 09:15 open", hours: [], pairs: [], checks: [] } };
  const now = last.time + 60;
  const before = ordered.length > 1 ? ordered[ordered.length - 2].time + 60 : sessionOpen;
  const hours = hourlyCandles(ordered, sessionOpen, now);
  const full = Array.from({ length: 6 }, (_, index) => sessionOpen + index * HOUR);
  const hourAt = (index: number) => hours.find((hour) => hour.start === full[index] && isFullHour(hour)) ?? null;
  const pairs: HourlyPair[] = [];
  let signal: StrategySignal | null = null;
  let decided: HourlyPair | null = null;
  for (const [a, b] of pairSchedule(settings.pairStep)) {
    const first = hourAt(a);
    if (!first?.complete) break;
    const pair = evaluatePair(first, hourAt(b), settings, hourAt(0)?.open ?? null);
    pairs.push(pair);
    // Each pair is decided once, on the candle that completes its second hour (a doji: its first hour).
    const at = pair.color === "DOJI" && settings.directionFrom !== "close" ? first.end : pair.decisionTime;
    const deciding = pair.status !== "WAITING" && now >= at && before < at;
    if (!deciding) continue;
    decided = pair;
    if (pair.status === "CONFIRMED" && pair.side) {
      const reason = `Hourly zone ${pair.direction} → ATM ${pair.side}: ${pair.checks.join(" ")}`;
      signal = { id: `hourly:${pair.side}:${pair.decisionTime}`, strategy: "hourly", direction: pair.side, time: last.time, trigger: pair.second!.close, level: pair.reference, invalidation: pair.box ? (pair.side === "CALL" ? pair.box.bottom : pair.box.top) : pair.reference, reason, volume: "NOT_REQUIRED" };
    } else {
      const opposite = oppositeOf(pair, settings);
      if (opposite) {
        pair.opposite = opposite;
        const reason = `Opposite trade — the ${pair.direction} setup failed (${pair.reasons.join("; ")}) → ${opposite.direction}, ATM ${opposite.side}.`;
        signal = { id: `hourly:${opposite.side}:${pair.decisionTime}:opposite`, strategy: "hourly", direction: opposite.side, time: last.time, trigger: pair.second!.close, level: pair.reference, invalidation: pair.reference, reason, volume: "NOT_REQUIRED" };
      } else if (settings.dailyFallback && pair.status === "SKIPPED" && pair.side && pair.second?.complete && istClock(pair.decisionTime) === settings.fallbackTime) {
        // Daily trade: nothing traded yet today (the runner blocks a second trade), so this pair's direction is taken.
        pair.fallback = true;
        const second = pair.second;
        const dayOpen = hourAt(0)?.open ?? null;
        const bodyShare = second.high > second.low ? (Math.abs(second.close - second.open) / (second.high - second.low)) * 100 : 0;
        const redFlip = settings.redAgainstFlip > 0 && !pair.cross && pair.color === "RED" && pair.side === "CALL" && second.close > second.open && second.close > pair.reference && dayOpen != null && second.close < dayOpen && bodyShare > settings.redAgainstFlip;
        const openGap = round(second.open - pair.reference);
        const redRedCall = settings.redRedDailyCall > 0 && !pair.cross && pair.color === "RED" && second.close < second.open && second.close < pair.reference && openGap >= 0 && openGap <= settings.redRedDailyCall;
        const openBelow = round(pair.reference - second.open);
        const redGreenPut = settings.redGreenDailyPut > 0 && pair.color === "RED" && pair.side === "CALL" && second.close > second.open && second.close > pair.reference && openBelow >= 0 && openBelow <= settings.redGreenDailyPut;
        const quietDrawn = !(settings.greenRedTrendMaxRange > 0) || pair.first.high - pair.first.low < settings.greenRedTrendMaxRange;
        const greenRedPut = pair.greenRed && !(settings.greenRedDailyTrend && quietDrawn && dayOpen != null && !(second.close < dayOpen));
        const side = pair.cross || redRedCall ? "CALL" : redFlip || redGreenPut || greenRedPut ? "PUT" : pair.side;
        const reason = `Daily trade at ${settings.fallbackTime} — no setup passed today; the ${istClock(pair.first.start)} pair's ${pair.cross ? "red–red cross" : redGreenPut ? `red–green open ${fmt(openBelow)} below the mid` : redRedCall ? `red–red open ${fmt(openGap)} above the mid` : greenRedPut ? "green–red pattern" : redFlip ? `CALL against the day's move (NIFTY below the 09:15 open ${fmt(dayOpen!)}, body ${bodyShare.toFixed(0)}%) → flipped` : "direction"} → ATM ${side} (not applied: ${pair.reasons.join("; ")}).`;
        signal = { id: `hourly:${side}:${pair.decisionTime}:daily`, strategy: "hourly", direction: side, time: last.time, trigger: pair.second.close, level: pair.reference, invalidation: pair.reference, reason, volume: "NOT_REQUIRED" };
      }
    }
  }
  const latest = pairs.at(-1) ?? null;
  const nextPair = pairSchedule(settings.pairStep).find(([a]) => full[a] >= (latest ? latest.decisionTime : sessionOpen) && !pairs.some((pair) => pair.first.start === full[a]));
  const next = nextPair ? `${istClock(full[nextPair[0]])} + ${istClock(full[nextPair[1]])} candles (decision at ${istClock(full[nextPair[1]] + HOUR)})` : null;
  let status: string;
  if (!latest) status = `WAITING — the first hourly candle (${istClock(sessionOpen)}–${istClock(sessionOpen + HOUR)}) is forming`;
  else if (latest.status === "WAITING" && !latest.direction) status = `WAITING — reference ${fmt(latest.reference)} from the ${istClock(latest.first.start)} candle; the ${istClock(latest.first.end)}–${istClock(latest.decisionTime)} candle's close sets CALL (above) or PUT (below)`;
  else if (latest.status === "WAITING") status = `WAITING — ${latest.direction} reference ${fmt(latest.reference)} from the ${latest.color.toLowerCase()} ${istClock(latest.first.start)} candle; waiting for the ${istClock(latest.first.end)}–${istClock(latest.decisionTime)} candle to close`;
  else if (latest.status === "CONFIRMED") status = `CONFIRMED — ${latest.direction} (ATM ${latest.side}) at ${istClock(latest.decisionTime)}: the second candle closed at ${fmt(latest.second!.close)}, inside the zone of the reference ${fmt(latest.reference)}`;
  else if (latest.opposite) status = `OPPOSITE — the ${latest.direction} setup failed (${latest.reasons.join("; ")}): ${latest.opposite.direction} (ATM ${latest.opposite.side}) at ${istClock(latest.decisionTime)} instead`;
  else status = `SKIPPED — ${latest.reasons.join("; ")}. ${next ? `Next pair: ${next}.` : "No further pair today."}`;
  return { signal, decided, state: { status, hours, pairs, checks: latest?.checks ?? [] } };
}

/**
 * The hourly midpoint rule on one completed hour after the entry: a LONG (CALL) is kept only while the hour closes
 * above its midpoint, a SHORT (PUT) only while it closes below it; a close at the midpoint exits either.
 */
export function hourlyMidpointDecision(side: Direction, hour: { high: number; low: number; close: number }): { keep: boolean; mid: number; text: string } {
  const mid = round((hour.high + hour.low) / 2);
  const keep = side === "CALL" ? hour.close > mid : hour.close < mid;
  const where = hour.close > mid ? "above" : hour.close < mid ? "below" : "at";
  return { keep, mid, text: `closed at ${fmt(hour.close)}, ${where} its midpoint ${fmt(mid)} ((H ${fmt(hour.high)} + L ${fmt(hour.low)}) / 2)` };
}
