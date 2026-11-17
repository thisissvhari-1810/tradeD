import type { AlgoLine, Candle, CustomLevel, LineType } from "./lines";
import { candleExit, protectiveLevels, protectiveProblem, quoteExit, resolveAtm, type AtmContract, type ChainInput, type Protective, type Right } from "./options";
import { consolidate, evaluateCandle, sameSession, type CandleEvaluation } from "./signals";
import { analyzeMarket, PATTERN_DEFAULTS, STRATEGY_IDS, STRATEGY_LABEL, type Direction, type ExistingStrategyId, type MarketAnalysis, type PatternSettings, type StrategySignal } from "./patterns";
import { HOURLY_SETTINGS_DEFAULTS, hourlyCandles, hourlyMidpointDecision, hourlySignal, isFullHour, istClock as hourClock, type HourlySettings, type HourlyTrade, type HourlyTradeStatus } from "./hourly-zone";
import { CHANNEL_SETTINGS_DEFAULTS, channelSignal, istClock as barClock, type ChannelSettings } from "./trend-channel";
import { changedConfirmations, tradeConfirmations, type Confirmation, type TradeSetup } from "./confirmations";
import { ema } from "@/lib/market/indicators";
import { allocateLots, ALLOCATION_DEFAULTS, planTrade, RISK_DEFAULTS, type AllocationSettings, type CapitalPlan, type RiskSettings, type TradePlan } from "./sizing";
import { volumeCheck } from "./patterns";
import type { Activation } from "./live-session";
import { EXIT_MANAGEMENT_DEFAULTS, trendExitDecision, trendVerdict, type ExitManagement } from "./trend-exit";

/**
 * The Algo state machine. One execution interface (paper, replay or live adapters) does the trading;
 * this file decides when, from completed 1-minute candles, the strategy levels, risk limits and the
 * open position. It is deterministic for the same inputs, keeps no hidden state (everything is in
 * AlgoState, which the server stores) and never places the same order twice: every order has an
 * idempotency key, and an order whose outcome is unknown is only ever looked up, never re-sent.
 */

export type AlgoMode = "PAPER" | "REPLAY" | "LIVE";

export type AlgoConfig = {
  underlying: string;
  mode: AlgoMode;
  /** Signals always use completed 1-minute candles, whatever the chart shows. */
  timeframe: "1m";
  /** "nearest" or a specific YYYY-MM-DD expiry. */
  expiry: string;
  /** Fixed sizing: lots per trade. Risk sizing: the most lots one trade may use. */
  lots: number;
  stop: Protective;
  target: Protective;
  maxDailyLoss: number;
  maxTrades: number;
  /** One algo position per session and underlying. */
  maxOpenPositions: 1;
  cooldownMinutes: number;
  /** Line types that do not take part (all take part by default). */
  disabledLines: LineType[];
  /** Optional (research; off by default): a line that only counts one way, e.g. or-high only "UP", or-low only "DOWN". */
  lineDirections?: Partial<Record<LineType, "UP" | "DOWN">>;
  custom: CustomLevel[];
  /** Both directions on one candle: no entry (the only policy; it is shown in the log). */
  conflictPolicy: "block";
  /** A signal against the open position: ignore it, or exit first (no reversal until the exit is confirmed). */
  opposingPolicy: "ignore" | "exit-first";
  rounding: "nearest" | "down" | "up";
  maxQuoteAgeSeconds: number;
  maxSpreadPercent: number;
  /** Paper / replay fill model: buys pay the ask plus this many 0.05 ticks, sells get the bid minus them. */
  slippageTicks: number;
  /** New entries only from this IST time (HH:MM)... */
  entryStart: string;
  /** ...to this one: no new entries after it; open positions stay protected (or close, see windowExit). */
  entryCutoff: string;
  /** At the end of the entry window: keep an open position under its stop / target, or close it. */
  windowExit: "hold" | "close";
  /** Mandatory end-of-day square-off (IST HH:MM): an open position is closed and no new entry starts from this time. */
  squareOff?: string;
  /** "risk": lots sized from the index stop so one trade risks at most the risk per trade; "fixed": `lots`;
   * "capital": the most whole lots the capital allocation and available cash buy. */
  sizing: "risk" | "fixed" | "capital";
  /** Capital-allocation sizing: share of the capital per trade, the capital it is taken from, and the policy. */
  allocation: AllocationSettings;
  /** Capital, risk per trade, daily target and minimum reward : risk (risk sizing). */
  risk: RiskSettings;
  /** Minimum setup-quality score (0–100) to enter (risk sizing). */
  minScore: number;
  /** Which strategies may signal: the line break and the price-action add-ons (the existing Algo Trade). */
  strategies: Record<ExistingStrategyId, boolean>;
  /** Which feature's signals these settings drive: the existing Algo Trade, Mathi Hourly Zone Strategy or Mathi Trend Channel. */
  engine: "existing" | "hourly" | "channel";
  /** Mathi Hourly Zone Strategy settings (zone, skip rule, pair schedule, session-loss limit); used only when engine is "hourly". */
  hourly?: HourlySettings;
  /** Mathi Trend Channel settings (swing cutoff, horizontal zones, channel-only research mode); used only when engine is "channel". */
  channel?: ChannelSettings;
  /** Minutes after the session open that are analysis only: no new entries (30 = 09:15–09:45). */
  observationMinutes: number;
  /** Settings format: 4 = the early-session strategy (9:15–10:30, risk sizing); 3 = trade filters; 2 = observation. */
  settingsVersion: number;
  /** Entry filters against false breaks and whipsaws (each can be switched off). */
  filters: {
    /** After a stop-loss on a level, that level is not traded again for this many minutes (0 = off). */
    levelBlockMinutes: number;
    /** A line break needs the close at least this % beyond the line (0 = any close beyond it). */
    breakoutBufferPercent: number;
    /** Enter only when the next candle also closes beyond the level. */
    secondCandle: boolean;
    /** CALL only with the 9 EMA above the 21 EMA, PUT only below. */
    momentum: boolean;
    /** Do not buy an ATM option whose premium is above this (₹; 0 = off): a dear option needs a much bigger index move
     * to make the same % target, so those trades fail more often. */
    maxEntryPremium?: number;
    /** Do not buy an ATM option whose premium is below this (₹; 0 = off): a cheap option means a very large quantity,
     * and its premium can collapse to almost nothing near expiry. */
    minEntryPremium?: number;
    /** CALL only with the signal close above the session VWAP, PUT only below (VWAP from completed candles; time-weighted
     * if the index has no volume). Off unless true. */
    vwapAlign?: boolean;
    /** CALL only when the close is above the close 5 minutes earlier, PUT only below. Off unless true. */
    momentum5?: boolean;
    /** Skip while the 14-minute ATR of NIFTY at the signal is below this many points (0 or absent = off): a quiet market. */
    minAtrPoints?: number;
    /** Skip a line NIFTY has already closed across this many times today before the break (0 or absent = off): a choppy level. */
    maxLineCrossings?: number;
    /** Enter only while the 14-period ADX of NIFTY (1-minute) is at least this (0 or absent = off): a trending market. */
    minAdx?: number;
    /** CALL only while the Supertrend (10, 3) of NIFTY (1-minute) is up, PUT only while it is down. Off unless true. */
    supertrend?: boolean;
    /**
     * Trend channel, from the automatic trendline engine at the entry candle (confirmed swings only; off unless set).
     * "structure": no CALL while the swings make lower highs and lows, no PUT while they make higher highs and lows.
     * "channel": no CALL while the close is under a falling upper channel line, no PUT while it is over a rising lower one.
     */
    trendChannel?: "off" | "structure" | "channel";
    /** No-chase: skip a signal when the last this-many completed candles all moved in the trade's direction (a stretched
     * move usually pulls back first; 0 or absent = off). */
    noChaseCandles?: number;
    /** The breakout candle must close beyond the line by at least this many 14-minute ATRs of NIFTY (0 or absent = off). */
    breakoutAtrMultiple?: number;
    /** Skip an over-extended break: the breakout candle's range above this many 14-minute ATRs (0 or absent = off). */
    maxBreakoutCandleAtr?: number;
    /** Skip while the session VWAP has moved against the trade over the last 10 minutes by more than this many ATRs
     * (e.g. 0.45 skips a CALL when VWAP fell 0.45 × ATR or more; absent = off). */
    maxVwapSlopeAgainstAtr?: number;
    /** Skip while the 9 EMA is this many ATRs or more on the wrong side of the 21 EMA (absent = off). */
    maxEmaGapAgainstAtr?: number;
    /** Skip when the bought contract's expiry is more than this many calendar days away (0 or absent = off): far from
     * expiry the option is dear and +3% needs a bigger NIFTY move. */
    maxDaysToExpiry?: number;
    /** With farExpiryMinConfirmMinutes: on a contract this many calendar days or more from expiry (absent = off) ... */
    farExpiryDays?: number;
    /** ... the confirming candle must come at least this many minutes after the breakout candle (a quick retest far
     * from expiry is skipped; 0 or absent = off). */
    farExpiryMinConfirmMinutes?: number;
    /** Rules by the day's trade number: entry i is the most calendar days to expiry for trade i + 1 (null = no limit),
     * e.g. [null, 2, 1] keeps the 1st trade as it is, takes a 2nd only 0–2 days and a 3rd only 0–1 days from expiry. */
    maxDaysToExpiryByTrade?: Array<number | null>;
  };
  /** Strikes in the money from ATM for the bought option (0 or absent = ATM; 1 = one listed strike ITM). */
  itmSteps?: number;
  /** Line exit: how many consecutive completed closes back through the broken level close the trade (1 = the first one). */
  structureStopCloses?: number;
  /** NIFTY reversal stop: exit once a completed NIFTY close is this many points against the trade from its entry (0 or absent = off). */
  indexStopPoints?: number;
  /** Exit when the index closes back through the broken level (the setup is wrong), besides the premium stop. */
  structureStop: boolean;
  /** Swing, pattern and breakout settings for the trendline, W and M strategies. */
  patterns: PatternSettings;
  /** Line crossings: "body" — the candle opens at or before the line and closes past it (Mathi Strategy); "classic" —
   * the previous close and this open on one side, this close on the other. */
  crossRule: "body" | "classic";
  /** "body" rule: the share of the candle's body that must be past the line, % (0 = any genuine crossing). */
  crossPercent: number;
  /** Automatic stop-loss exits. Mathi Strategy runs without one (shown clearly). */
  stopLoss: boolean;
  /** Live-price paper: also check the forming candle (at its current price) when the data feed provides it. */
  intrabar: boolean;
  /** Pause the replay once the session's entries are used up (otherwise it keeps playing; new entries stay blocked). */
  stopAtLimit: boolean;
  /** Time limit: a trade still open this many minutes after its entry exits at the premium (0 = off). With trend exit
   * management it is the checkpoint instead, where the trade is kept only while the index trend still agrees. */
  maxHoldMinutes: number;
  /** Optional trend-aware exit management at the time checkpoint (off by default: "fixed"). */
  exitManagement?: ExitManagement;
  /** Regime switch: real (money) entries only while the strategy's own last `lookback` trades (real and shadow) made
   * money in total; otherwise each signal is followed as a SHADOW trade — the same rules and prices, no order, no money —
   * so the switch can turn back on. Past results only. */
  regime?: { enabled: boolean; lookback: number };
  /**
   * Breakout confirmation before an entry: "single" — enter on the crossing candle; "hold" — the next completed
   * candle must close beyond the line; "retest" — a retest of the line must hold and price move on.
   */
  confirmation: ConfirmationSettings;
};

export type ConfirmationMode = "single" | "hold" | "retest";
export type ConfirmationSettings = {
  mode: ConfirmationMode;
  /** Retest mode: how close (% of the level) a candle must come back to the line to count as its retest. */
  retestTolerancePercent: number;
  /** Retest mode: minutes after the break within which the retest must hold and move on, or the setup expires. */
  retestWindowMinutes: number;
  /** Hold mode: the confirming candle must also move with the breakout (bullish for a CALL, bearish for a PUT). */
  holdMustAgree: boolean;
  /** Retest mode: a second entry path for a break that continues strongly without a retest (off unless enabled). */
  strongBreakout?: StrongBreakoutSettings;
};

/**
 * Strong breakout entry (retest mode only): while a break waits for its retest, a completed candle that continues
 * beyond the breakout candle (a bearish close below its low for a PUT, a bullish close above its high for a CALL)
 * with a strong body confirms the setup without a retest. Optional guards: not too far past the broken level
 * (in 14-minute ATRs) and the trend agreeing (session VWAP side and / or the 9 / 21 EMA).
 */
export type StrongBreakoutSettings = {
  enabled: boolean;
  /** The continuation candle's body as a share of its range, % (0 = any bearish / bullish candle). */
  minBodyPercent: number;
  /** Skip when the close is more than this many 14-minute ATRs past the broken level (0 = no limit). */
  maxDistanceAtr: number;
  /** Trend that must agree: none, the session VWAP side, the 9 / 21 EMA, or both. */
  trend: "none" | "vwap" | "ema" | "both";
};

export const STRONG_BREAKOUT_DEFAULTS: StrongBreakoutSettings = { enabled: false, minBodyPercent: 50, maxDistanceAtr: 0, trend: "none" };

export const ALGO_DEFAULTS: AlgoConfig = {
  underlying: "NIFTY",
  mode: "PAPER",
  timeframe: "1m",
  expiry: "nearest",
  // Mathi Strategy: a line breakout buys as many whole ATM lots as the ₹1,00,000 capital pays for (up to
  // 50 lots); +3% on the option premium; no stop-loss — a trade that has not reached its target 30 minutes
  // after its entry exits at the premium (the month's winners all reached it within 15).
  lots: 50,
  stop: { mode: "percent", value: 3 },
  target: { mode: "percent", value: 3 },
  // 2% of the ₹1,00,000 capital (two full-risk losses).
  maxDailyLoss: 2_000,
  maxTrades: 3,
  maxOpenPositions: 1,
  cooldownMinutes: 5,
  disabledLines: [],
  custom: [],
  conflictPolicy: "block",
  opposingPolicy: "ignore",
  rounding: "nearest",
  maxQuoteAgeSeconds: 90,
  maxSpreadPercent: 5,
  slippageTicks: 1,
  // The session's first half: entries from 09:15 to 12:00 IST, as soon as a setup is confirmed (no waiting period).
  entryStart: "09:15",
  // Mathi Strategy: no entry cutoff — entries until the session's close (15:30).
  entryCutoff: "15:30",
  windowExit: "hold",
  squareOff: "15:20",
  sizing: "capital",
  allocation: ALLOCATION_DEFAULTS,
  risk: RISK_DEFAULTS,
  minScore: 60,
  // Only strategy-line crossings: W / M, bounce / rejection, trendline and opening-range signals are off.
  strategies: { line: true, trendline: false, w: false, m: false, orb: false, bounce: false, rejection: false },
  observationMinutes: 0,
  engine: "existing",
  settingsVersion: 18,
  // The ATM option is bought at any premium (an optional limit can skip dear ones: maxEntryPremium).
  filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false, maxEntryPremium: 0 },
  structureStop: false,
  patterns: PATTERN_DEFAULTS,
  // Enter once 50% of the candle's body is past an enabled line.
  crossRule: "body",
  crossPercent: 50,
  stopLoss: false,
  intrabar: true,
  stopAtLimit: false,
  maxHoldMinutes: 45,
  // At the 45-minute checkpoint a trade is kept only while 4 of 5 NIFTY trend checks agree, for at most 90 minutes.
  exitManagement: { ...EXIT_MANAGEMENT_DEFAULTS, mode: "trend" },
  // Real entries only while the last 30 trades made money in total (12-month backtest: every quarter profitable).
  regime: { enabled: true, lookback: 30 },
  // A crossing is only a detected signal: price must come back to the line within 15 minutes, hold it without
  // closing back through, and move on before an entry (retest) — a break that falls straight back is never traded.
  confirmation: { mode: "retest", retestTolerancePercent: 0.02, retestWindowMinutes: 15, holdMustAgree: true },
};

/**
 * Mathi Hourly Zone Strategy — 5%: its own engine (the first two 1-hour NIFTY candles; see hourly-zone.ts) on the ATM
 * CALL / PUT, +5% on the executed option premium, no stop-loss order, the hourly midpoint exit, entries from 11:15 IST,
 * one trade a session by default and the 15:20 square-off. No regime switch, no time limit, no strategy lines.
 */
export const MATHI_HOURLY_DEFAULTS: AlgoConfig = {
  ...ALGO_DEFAULTS,
  engine: "hourly",
  // F7, traded every day: the X30 direction rules with the 28/29 Oct 2026 fixes, an early exit (−5% after 30 minutes,
  // −3% after 15 on expiry day), the red–green premium wait and three four-year correlation rules. Four years of NIFTY
  // weekly options (Oct 2022 – Oct 2026, real premiums): 780 / 205, but 2022–23 and 2023–24 lose slightly; the
  // market filter (`maxOptionLevel`) and protect-the-gain stay off so that every session trades.
  hourly: {
    ...HOURLY_SETTINGS_DEFAULTS,
    referencePrice: "close", directionFrom: "position", zoneMinPoints: 10, skipPart: "body", skipCandle: "second", skipSide: "against", bodyCrossPoints: 0,
    trendFilter: true, trendTolerance: 0.5, crossFlip: "all", crossTolerance: 2, redAgainstFlip: 10, greenRedPut: 3, greenRedMode: "daily",
    wickCall: 60, wickCallMode: "trend", wickCallAnyTrendDays: "Mon,Tue", thinWickPut: 0.5, thinWickCall: 1.45,
    dearFlipPremium: 175, dearFlipBody: 50,
    greenRedHighGap: 20.73, greenRedDrawnWick: 6.12, redRedWaitWick: 22.25, redRedWaitBody: 15.95, greenGreenWaitWick: 13.15, greenGreenWaitBy: "12:15", greenGreenWaitNoDearFlip: true, greenRedDailyTrend: true, greenRedDrawnWickTrend: true, greenRedTrendMaxRange: 55,
    // Early exit: still more than 5% down 30 minutes after the entry (3% after 15 minutes on the contract's expiry day)
    // → sold. Shape rule 8 (two long drawn wicks) is off: a 41-variant sweep found both helped on both years.
    earlyExitMinutes: 30, earlyExitPercent: 5, expiryEarlyExitMinutes: 15, expiryEarlyExitPercent: 3,
    // Red drawn + green second candle above the mid with the option over ₹150: wait one hour. Chosen on 2025–26 and
    // checked on 2024–25. With the two changes above: 198 / 45 (+1.43% a trade) and 229 / 18 (+3.89%).
    redGreenWaitPremium: 150,
    // Four-year correlation rules (checked on Oct 2022 – Oct 2026 with real option premiums): 777 / 205 against 766 / 216.
    ggWaitFirstHourMin: 78.8, ggWaitFirstHourMax: 105.6, callWaitDayMoveMin: 25, callWaitDayMoveMax: 79.6, dte3OppWick: 34.8,
    // F10: a trade every market day at the 5% target; at risky times — NIFTY only 0–50 points in the trade's direction
    // since the 09:15 open, or a fairly dear option (level 0.215–0.25) — the trade is taken with half the lots.
    // ("skip" instead gave 500 / 100 on 600 of 987 days, every year profitable.)
    // F11: a risky-time trade's early exit waits 45 minutes (−5%, expiry day included): 800 / 185 against F10's 780 / 205,
    // better in three of the four years (60 minutes: 811 / 174, but 2022–23 worse).
    weakTargetPercent: 0, weakBodyPoints: 25.5, weakMinDaysToExpiry: 3,
    skipRiskyTimes: true, riskyAction: "half", riskyWeakMovePoints: 50, riskyOptionLevelMin: 0.215, riskyOptionLevelMax: 0.25,
    riskyEarlyExitMinutes: 45, riskyEarlyExitPercent: 5,
    redGreenOpenFlip: 1.9, redRedWaitOppWick: 30.4, redRedWaitOppPoints: 20,
    boxMode: "off", gapPoints: 0, dailyFallback: true, fallbackTime: "13:15",
  },
  target: { mode: "percent", value: 5 },
  stopLoss: false,
  maxTrades: 1,
  cooldownMinutes: 0,
  entryStart: "11:15",
  // The last entry is 14:15 (the 12:15 + 13:15 pair); the 13:15 + 14:15 pair, decided at 15:15, is not traded.
  entryCutoff: "14:15",
  squareOff: "15:20",
  maxHoldMinutes: 0,
  exitManagement: { ...EXIT_MANAGEMENT_DEFAULTS, mode: "fixed" },
  regime: { enabled: false, lookback: 30 },
  confirmation: { ...ALGO_DEFAULTS.confirmation, mode: "single" },
  intrabar: false,
};

/**
 * Mathi Trend Channel: its own engine (the first valid deep-swing combination on 3-minute NIFTY candles, a primary
 * trendline and its exact parallel clone, horizontal swing zones, a channel + level breakout and next-candle
 * confirmation; see trend-channel.ts) on the ATM CALL / PUT, +5% on the executed option premium and no stop-loss order.
 * one trade a session. The rest of execution and risk is Mathi Strategy's, unchanged: the 45-minute trend checkpoint,
 * capital sizing, the 15:20 square-off. Its own confirmation replaces the line retest; no regime switch, no forming-candle entries.
 */
export const MATHI_CHANNEL_DEFAULTS: AlgoConfig = {
  ...ALGO_DEFAULTS,
  engine: "channel",
  channel: CHANNEL_SETTINGS_DEFAULTS,
  // +3% on the executed option premium (1 Nov 2026; was +5%): 5 years 1,142 / 88 against 1,079 / 151.
  target: { mode: "percent", value: 3 },
  stopLoss: false,
  // One trade a session (31 Oct 2026).
  maxTrades: 1,
  // No time limit (1 Nov 2026): held until the +5% target or the 15:20 square-off; no 45-minute checkpoint.
  maxHoldMinutes: 0,
  exitManagement: { ...EXIT_MANAGEMENT_DEFAULTS, mode: "fixed" },
  regime: { enabled: false, lookback: 30 },
  confirmation: { ...ALGO_DEFAULTS.confirmation, mode: "single" },
  intrabar: false,
};

export const TICK = 0.05;

export type AlgoStatus =
  | "DISABLED" | "READY" | "MONITORING" | "SIGNAL_DETECTED" | "ORDER_PENDING" | "POSITION_OPEN" | "EXIT_PENDING" | "COMPLETED"
  | "ERROR" | "REJECTED" | "RECOVERY_REQUIRED" | "RISK_LOCKED";

export type ContractRef = Pick<AtmContract, "underlying" | "expiry" | "strike" | "right" | "securityId" | "lotSize">;
export type Side = "CALL" | "PUT";

export type OpenPosition = {
  entryKey: string;
  contract: ContractRef;
  side: Side;
  lots: number;
  /** Quantity still open (lots × lot size, less any partial exits). */
  quantity: number;
  avg: number;
  stop: number;
  target: number;
  /** Entry charges still attributed to the open quantity. */
  entryCharges: number;
  openedAt: number;
  signalTime: number;
  lineIds: string[];
  exit: { key: string; reason: string; attempt: number; uncertain: boolean } | null;
  exitAttempts: number;
  /** "ALGO" when held on the Algo wallet; absent on positions opened before it existed. */
  wallet?: "ALGO";
  /** The strategy and the broken level the trade was entered on (for its confirmations). */
  setup?: TradeSetup;
  /** The lowest option premium seen while open (completed candle lows, or quotes): the maximum adverse move. */
  lowest?: number;
  /** The highest option premium seen while open: the maximum favourable move. */
  highest?: number;
  /** Paper monitoring: the latest option candle (start time) already checked for the target / stop. */
  checkedThrough?: number | null;
  /** Mathi Hourly Zone Strategy: a risky-time trade, taken with half the lots (its own early exit). */
  riskyHalf?: boolean;
  /** Mathi Hourly Zone Strategy: the latest completed hour (its start) already checked by the midpoint rule. */
  hourChecked?: number | null;
  /** Mathi Hourly Zone Strategy: the latest NIFTY minute (its start) already checked against the box edges. */
  boxChecked?: number | null;
  /** Paper monitoring: the time of the latest quote used; an older quote arriving later is ignored. */
  lastQuoteAt?: number | null;
  /** Trend exit management: the highest premium since the time checkpoint (for the trailing stop). */
  checkpointHigh?: number | null;
  /** Trend exit management: the latest hold reason logged (logged again only when it changes). */
  holdNote?: string;
  /** A shadow trade (regime switch off): followed with the same rules and prices, but no order and no money. */
  shadow?: boolean;
};

export type PendingEntry = { key: string; contract: ContractRef; side: Side; lots: number; quantity: number; signalTime: number; lineIds: string[]; explanation: string; uncertain: boolean; wallet?: "ALGO"; setup?: TradeSetup; plan?: TradePlan | null };

/** What the engine says on the latest candle (one of six states), with the reason and any trade plan. */
export type EngineStatus = "BUY_CANDIDATE" | "SELL_CANDIDATE" | "WAIT_FOR_CONFIRMATION" | "NO_TRADE" | "DAILY_RISK_LIMIT_REACHED" | "TRADING_WINDOW_CLOSED";
export const ENGINE_LABEL: Record<EngineStatus, string> = {
  BUY_CANDIDATE: "BUY / LONG CANDIDATE",
  SELL_CANDIDATE: "SELL / SHORT CANDIDATE",
  WAIT_FOR_CONFIRMATION: "WAIT FOR CONFIRMATION",
  NO_TRADE: "NO TRADE",
  DAILY_RISK_LIMIT_REACHED: "DAILY RISK LIMIT REACHED",
  TRADING_WINDOW_CLOSED: "TRADING WINDOW CLOSED",
};
export type EngineState = { status: EngineStatus; reason: string; time: number; plan: TradePlan | null; capital?: CapitalPlan | null };

export type AlgoState = {
  /** The session is started (monitoring); false = stopped. */
  running: boolean;
  /** New entries allowed. Turning this off never abandons an open position: it stays protected. */
  entries: boolean;
  status: AlgoStatus;
  sessionDate: string;
  /** The latest completed candle already evaluated (unix seconds). */
  lastCandle: number | null;
  tradesToday: number;
  realizedToday: number;
  lastEntryAt: number | null;
  riskLocked: boolean;
  /** Set when something needs attention before trading continues (an unknown order, a failed exit). */
  recovery: string | null;
  position: OpenPosition | null;
  pending: PendingEntry | null;
  /** Hourly shape rule "wait one hour": the side bought at the next hourly decision (unix seconds) of this session. */
  hourlyWait?: { session: string; at: number; side: Side; level: number; note: string } | null;
  /** The session the market-condition filter (`maxOptionLevel`) closed to new hourly entries. */
  hourlyBlockedSession?: string | null;
  /** The session whose hourly trade is a risky-time trade taken with half the lots (`riskyAction` "half"). */
  hourlyHalfSession?: string | null;
  lastSignal: { time: number; decision: string; explanation: string } | null;
  lastOrder: { time: number; status: string; message: string } | null;
  /** The latest market analysis (opening range, trend, trendlines, W / M, strategy statuses). */
  analysis?: MarketAnalysis | null;
  /** The open trade's latest intratrade confirmations. */
  confirmations?: Confirmation[] | null;
  /** A signal waiting for the next candle to confirm it (second-candle filter). */
  /** A detected breakout waiting for its confirmation (hold / retest); its retest candle once one is seen. */
  awaiting?: { direction: Direction; signals: StrategySignal[]; time: number; mode?: "hold" | "retest"; retest?: { time: number; extreme: number } | null; candle?: Candle; events?: CandleEvaluation["events"] } | null;
  /** Levels stopped out recently: not traded again until `until` (level-block filter). */
  blockedLevels?: Array<{ level: number; until: number }>;
  /** The engine's state on the latest evaluated candle. */
  engine?: EngineState | null;
  /** A candle already entered on while it was forming (live paper), so its completed evaluation does not enter again. */
  formingEntry?: number | null;
  /** Live demo: the current Mathi Strategy activation session (switched ON) and the earlier ones, newest first. */
  activation?: Activation | null;
  activations?: Activation[];
  /** Regime switch: the net P&L of the latest trades, real and shadow (oldest first; kept across days). */
  regime?: { history: number[] };
  /** Today's realized P&L of shadow trades (no money; counted only toward the strategy's own daily loss limit). */
  shadowToday?: number;
  /** Monitoring status of the latest check (paper trading). */
  monitor?: MonitorStatus | null;
  /** Mathi Hourly Zone Strategy: today's trades with their reference, target, midpoint checks and outcome (for the chart). */
  hourly?: { trades: HourlyTrade[] } | null;
};

export function initialState(sessionDate: string): AlgoState {
  return { running: false, entries: false, status: "DISABLED", sessionDate, lastCandle: null, tradesToday: 0, realizedToday: 0, lastEntryAt: null, riskLocked: false, recovery: null, position: null, pending: null, lastSignal: null, lastOrder: null };
}

export type Fill =
  | { status: "FILLED" | "PARTIAL"; quantity: number; price: number; charges: number }
  | { status: "PENDING" }
  | { status: "REJECTED"; reason: string }
  | { status: "UNKNOWN"; reason: string };

export type Mark = {
  bid: number | null;
  ask: number | null;
  candle: { open: number; high: number; low: number; close: number } | null;
  asOf: number;
  /** Paper: the option's own 1-minute candles today, so a target or stop reached between two checks is still seen
   * (only completed candles after the entry minute and after the last checked one are used). */
  candles?: Candle[];
};

/** A resting target limit counts as filled only when the option traded at least this many ticks above it (a trade
 * above the limit means every sell at the limit was filled first; a touch of the limit alone does not prove a fill). */
export const TARGET_THROUGH_TICKS = 1;

/** What the server-side monitor last saw for the session and its open position. */
export type MonitorStatus = {
  /** When the session was last checked, and what triggered the check. */
  checkedAt: number;
  source?: "scheduler" | "browser" | "replay";
  /** The latest option quote used for the open position, and its own time. */
  quoteAt: number | null;
  bid: number | null;
  /** The open position's option candles are checked through this minute (candle start). */
  candlesThrough: number | null;
  /** The target check of the latest pass. */
  target: { level: number; best: number | null; hit: boolean } | null;
  /** Why the latest check could not use the market data (missing, stale, out of order), or null. */
  problem: string | null;
  /** Consecutive checks of an open position without usable market data. */
  failures: number;
};

/** One implementation each for paper trading, historical replay and live execution. */
export interface ExecutionAdapter {
  kind: "paper" | "replay" | "live";
  health(): Promise<{ ok: boolean; reason?: string }>;
  /** Buying power in rupees. */
  cash(): Promise<number>;
  charges(side: "BUY" | "SELL", premium: number, quantity: number): number;
  chain(right: Right, expiry: string): Promise<ChainInput>;
  mark(contract: ContractRef, now: number): Promise<Mark | null>;
  enter(order: { key: string; contract: ContractRef; quantity: number; price: number; now: number }): Promise<Fill>;
  exit(order: { key: string; contract: ContractRef; quantity: number; price: number; reason: string; now: number }): Promise<Fill>;
  /** Looks an earlier order up by its idempotency key (reconciliation); null if it never arrived. */
  lookup(key: string): Promise<Fill | null>;
}

export type EventKind = "EVALUATION" | "ENTRY" | "EXIT" | "REJECTED" | "ERROR" | "INFO";
export type AlgoEvent = {
  /** Unique per session: the store keeps one event per key. */
  key: string;
  time: number;
  kind: EventKind;
  message: string;
  evaluation?: CandleEvaluation;
  contract?: ContractRef & { bid?: number; ask?: number };
  side?: Side;
  order?: { key: string; status: string; quantity?: number; price?: number; charges?: number };
  stop?: number;
  target?: number;
  pnl?: number;
  /** On exits: (exit − entry) × quantity before charges; `pnl` is after both legs' charges. */
  gross?: number;
  /** On exits: the largest fall of the premium below the entry while open, per unit (maximum adverse move). */
  adverse?: number;
  /** On exits: the largest rise of the premium above the entry while open, per unit (maximum favourable move). */
  favorable?: number;
  reasons?: string[];
  /** On entries: the strategy and the broken level the trade was taken on. */
  setup?: TradeSetup;
  /** A shadow trade's entry or exit (regime switch off): no order, no money. */
  shadow?: boolean;
};

export type AdvanceInput = {
  sessionId: string;
  sessionDate: string;
  config: AlgoConfig;
  candles: Candle[];
  lines: AlgoLine[];
  /** Unix seconds (replay: the simulated clock). */
  now: number;
  adapter: ExecutionAdapter;
};

const money = (value: number) => Math.round(value * 100) / 100;
const istClock = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16);
/** A signal is traded only while fresh: within two minutes of its candle closing (not replay). */
const FRESH_SECONDS = 120;

export function entryKey(sessionId: string, candleTime: number, underlying: string, side: Side) {
  return `algo:${sessionId}:${candleTime}:${underlying}:${side}`;
}

/**
 * Advances the algo to `now`: reconciles pending orders, protects the open position (stop / target on
 * the option's own premium), then evaluates every new completed candle. At most one entry per candle;
 * only the latest candle may enter (an older one, evaluated late, is logged as missed).
 */
export async function advance(previous: AlgoState, input: AdvanceInput): Promise<{ state: AlgoState; events: AlgoEvent[] }> {
  const state: AlgoState = JSON.parse(JSON.stringify(previous)) as AlgoState;
  const events: AlgoEvent[] = [];
  const { adapter, config, now } = input;
  const log = (event: Omit<AlgoEvent, "time"> & { time?: number }) => events.push({ time: now, ...event });

  if (state.sessionDate !== input.sessionDate) {
    // A new trading day: daily counters reset; candles are only ever paired within one session.
    Object.assign(state, { sessionDate: input.sessionDate, lastCandle: null, tradesToday: 0, realizedToday: 0, shadowToday: 0, riskLocked: false, lastEntryAt: null, awaiting: null, blockedLevels: [], ...(config.engine === "hourly" ? { hourly: null } : {}) });
  }

  await reconcile(state, input, log);
  if (state.running || state.position) await protect(state, input, log);

  if (state.running) {
    const completed = input.candles.filter((candle) => candle.time + 60 <= now && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time);
    const latest = completed.at(-1) ?? null;
    // Starting mid-session evaluates from the latest completed candle (history is never traded).
    const fresh = state.lastCandle == null ? (latest ? [latest] : []) : completed.filter((candle) => candle.time > state.lastCandle!);
    for (const candle of fresh) {
      const index = completed.indexOf(candle);
      const lineEvaluation = directional(evaluateCandle({ previous: index > 0 ? completed[index - 1] : null, candle, lines: input.lines, enabled: (line) => !config.disabledLines.includes(line.type), now, fraction: config.crossRule === "body" ? (config.crossPercent ?? 0) / 100 : undefined }), config);
      let evaluation = coordinate(lineEvaluation, completed.slice(0, index + 1), input, state);
      // An hourly "wait one hour" rule: its side is bought at the next hourly decision, whatever that pair says.
      const wait = state.hourlyWait;
      if (wait && (wait.session !== input.sessionDate || candle.time + 60 > wait.at)) state.hourlyWait = null;
      const waited = !!wait && wait.session === input.sessionDate && candle.time + 60 === wait.at;
      if (wait && waited) {
        const explanation = `${wait.note} Now at ${istClock(wait.at)} → ATM ${wait.side}.`;
        evaluation = { ...evaluation, decision: wait.side, setupSide: wait.side, explanation, strategies: [{ id: `hourly:${wait.side}:${wait.at}:wait`, strategy: "hourly", direction: wait.side, time: candle.time, trigger: candle.close, level: wait.level, invalidation: wait.level, reason: explanation, volume: "NOT_REQUIRED" }] };
      }
      const signal = evaluation.decision === "CALL" || evaluation.decision === "PUT";
      const isLatest = candle === latest && (adapter.kind === "replay" || now - (candle.time + 60) <= FRESH_SECONDS);
      let outcome = evaluation.explanation;
      let kind: EventKind = "EVALUATION";
      let reasons: string[] | undefined;
      let plan: TradePlan | null = null;
      let capital: CapitalPlan | null = null;
      let entered = false;
      // Already entered on this candle while it was forming (live paper): the same signal is not traded twice.
      if (signal && state.formingEntry === candle.time) {
        state.lastSignal = { time: candle.time, decision: evaluation.decision, explanation: evaluation.explanation };
        log({ key: `eval:${candle.time}`, time: candle.time, kind, message: `${evaluation.explanation} Already entered on this candle while it was forming.`, evaluation });
        continue;
      }
      if (signal) {
        state.lastSignal = { time: candle.time, decision: evaluation.decision, explanation: evaluation.explanation };
        if (!isLatest) {
          reasons = ["Signal evaluated late (its candle closed more than two minutes ago); not traded."];
          outcome = `${evaluation.explanation} Not traded: evaluated late.`;
        } else {
          const result = await tryEntry(state, input, evaluation, log, waited);
          outcome = `${evaluation.explanation} ${result.message}`;
          reasons = result.reasons;
          plan = result.plan ?? null;
          capital = result.capital ?? null;
          entered = result.ok;
          if (!result.ok) kind = "REJECTED";
        }
      } else if (evaluation.decision === "CONFLICTING_SIGNAL") {
        state.lastSignal = { time: candle.time, decision: evaluation.decision, explanation: evaluation.explanation };
        reasons = ["Conflicting signals"];
      }
      // A pending setup cancelled (false breakout / expired): no order, shown with its reason.
      if (!signal && evaluation.cancelled) {
        kind = "REJECTED";
        reasons = [evaluation.cancelled];
      }
      log({ key: `eval:${candle.time}`, time: candle.time, kind, message: outcome, evaluation, reasons });
      state.engine = { ...engineState(state, config, candle.time, evaluation, { entered, reasons, plan }), capital };
    }
    if (latest && (state.lastCandle == null || latest.time > state.lastCandle)) state.lastCandle = latest.time;
    // Live paper with share-of-body crossings: the forming candle may enter as soon as its share is reached
    // (at its current price), once; its completed evaluation then does not enter again.
    const forming = input.candles.filter((candle) => candle.time + 60 > now && candle.time <= now && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time).at(-1);
    if (config.intrabar && config.crossRule === "body" && adapter.kind === "paper" && forming && state.formingEntry !== forming.time && confirmationMode(config) === "single" && (state.lastCandle == null || forming.time > state.lastCandle)) {
      const previous = completed.at(-1) ?? null;
      const lineEvaluation = directional(evaluateCandle({ previous, candle: forming, lines: input.lines, enabled: (line) => !config.disabledLines.includes(line.type), now, fraction: (config.crossPercent ?? 0) / 100, forming: true }), config);
      if (lineEvaluation.decision === "CALL" || lineEvaluation.decision === "PUT") {
        const evaluation = coordinate(lineEvaluation, [...completed, forming], input, state);
        if (evaluation.decision === "CALL" || evaluation.decision === "PUT") {
          const result = await tryEntry(state, input, evaluation, log);
          if (result.ok) state.formingEntry = forming.time;
          log({ key: `eval-forming:${forming.time}`, time: forming.time, kind: result.ok ? "EVALUATION" : "REJECTED", message: `${evaluation.explanation} (candle still forming, at its current price) ${result.message}`, evaluation, reasons: result.reasons });
          state.engine = { ...engineState(state, config, forming.time, evaluation, { entered: result.ok, reasons: result.reasons, plan: result.plan ?? null }), capital: result.capital ?? null };
        }
      }
    }
  }

  await confirm(state, input, log);
  if (config.engine === "hourly") trackHourly(state, events);

  state.status = deriveStatus(state);
  return { state, events };
}

function dayStart(date: string) {
  return Math.floor(Date.parse(`${date}T03:45:00Z`) / 1000);
}

/**
 * Hourly dear-option flip: when the ATM option is dear and the drawn candle was indecisive (a small body), the setup's
 * other side is bought. Null when the rule is off or does not apply.
 */
async function dearFlip(state: AlgoState, input: AdvanceInput, evaluation: CandleEvaluation): Promise<CandleEvaluation | null> {
  const { config, adapter, now } = input;
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...config.hourly };
  if (config.engine !== "hourly" || !(settings.dearFlipPremium > 0)) return null;
  const pair = state.analysis?.hourly?.pairs?.find((item) => item.decisionTime === evaluation.time + 60);
  if (!pair) return null;
  const range = pair.first.high - pair.first.low;
  const body = range > 0 ? (Math.abs(pair.first.close - pair.first.open) / range) * 100 : 0;
  if (body > settings.dearFlipBody) return null;
  const right: Right = evaluation.decision === "CALL" ? "CE" : "PE";
  let chain: ChainInput;
  try { chain = await adapter.chain(right, config.expiry); } catch { return null; }
  const atm = resolveAtm(chain, right, { rounding: config.rounding, maxQuoteAgeSeconds: config.maxQuoteAgeSeconds, maxSpreadPercent: config.maxSpreadPercent, itmSteps: config.itmSteps ?? 0 }, new Date(now * 1000));
  if (!atm.ok) return null;
  const price = money(atm.contract.ask + config.slippageTicks * TICK);
  if (price < settings.dearFlipPremium) return null;
  const other: Side = evaluation.decision === "CALL" ? "PUT" : "CALL";
  const note = `Dear-option flip: the ATM ${evaluation.decision} costs ₹${price} (at least ₹${settings.dearFlipPremium}) and the drawn candle's body is ${body.toFixed(0)}% of its range (at most ${settings.dearFlipBody}%) → ATM ${other}.`;
  return { ...evaluation, decision: other, setupSide: other, strategies: (evaluation.strategies ?? []).map((item) => ({ ...item, direction: other, reason: `${note} ${item.reason}` })), explanation: `${note} ${evaluation.explanation ?? ""}` };
}

/**
 * Hourly shape rules on the side about to be bought (see `greenRedHighGap`, `greenRedDrawnWick`, `redRedWaitWick`,
 * `redRedWaitBody`, `greenGreenWaitWick`, `redGreenOpenFlip`, `redRedWaitOppWick`, `redRedDrawnLowerWick`): the other
 * side now, or a side bought one hour later (never past the entry cutoff). Null when none applies.
 */
function shapeRule(state: AlgoState, input: AdvanceInput, evaluation: CandleEvaluation, dearFlipped = false): { evaluation?: CandleEvaluation; note?: string; wait?: NonNullable<AlgoState["hourlyWait"]> } | null {
  const { config } = input;
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...config.hourly };
  if (config.engine !== "hourly" || (evaluation.decision !== "CALL" && evaluation.decision !== "PUT")) return null;
  const pair = state.analysis?.hourly?.pairs?.find((item) => item.decisionTime === evaluation.time + 60);
  const a = pair?.first;
  const b = pair?.second;
  if (!pair || !a || !b) return null;
  const side: Side = evaluation.decision;
  const other: Side = side === "CALL" ? "PUT" : "CALL";
  const below = b.close < b.open && b.close < pair.reference;
  const above = b.close > b.open && b.close > pair.reference;
  const fmt = (value: number) => value.toFixed(2);
  const at = pair.decisionTime + 3600;
  const make = (wait: Side, note: string) => istClock(at) > config.entryCutoff ? null : ({ wait: { session: input.sessionDate, at, side: wait, level: pair.reference, note: `${note} → wait one hour: ATM ${wait} at ${istClock(at)}.` } });
  const flip = (note: string) => {
    const text = `${note} → ATM ${other} instead of the ${side}.`;
    return { note: text, evaluation: { ...evaluation, decision: other, setupSide: other, strategies: (evaluation.strategies ?? []).map((item) => ({ ...item, direction: other, reason: `${text} ${item.reason}` })), explanation: `${text} ${evaluation.explanation ?? ""}` } };
  };
  if (above && a.close > a.open && settings.greenGreenWaitWick > 0 && (!settings.greenGreenWaitBy || istClock(pair.decisionTime) <= settings.greenGreenWaitBy) && !(settings.greenGreenWaitNoDearFlip && dearFlipped)) {
    const wick = side === "PUT" ? Math.min(b.open, b.close) - b.low : b.high - Math.max(b.open, b.close);
    if (wick > settings.greenGreenWaitWick) return make(side, `Green–green shape: the second candle's ${side === "PUT" ? "lower" : "upper"} wick is ${fmt(wick)} points (over ${settings.greenGreenWaitWick})`);
  }
  if (above && a.close < a.open && side === "CALL" && settings.redGreenOpenFlip > 0) {
    const gap = b.open - pair.reference;
    // A near-perfect wick CALL (at least `wickCallAnyTrendShare` % of the lower wick below the mid) is not flipped.
    const wick = Math.min(b.open, b.close) - b.low;
    const share = wick > 0 && pair.reference > b.low ? (Math.min(pair.reference - b.low, wick) / wick) * 100 : 0;
    const clean = settings.wickCallAnyTrendShare > 0 && share >= settings.wickCallAnyTrendShare;
    if (gap > settings.redGreenOpenFlip && !clean) return flip(`Red–green shape: the second candle opened ${fmt(gap)} points above the mid ${fmt(pair.reference)} (over ${settings.redGreenOpenFlip})`);
  }
  // With the day's move for a side: NIFTY (the second candle's close) below the 09:15 open for a PUT, above it for a CALL.
  const dayOpen = state.analysis?.hourly?.pairs?.at(0)?.first.open ?? null;
  const withDay = (want: Side) => dayOpen != null && (want === "PUT" ? b.close < dayOpen : b.close > dayOpen);
  if (below && a.close > a.open) {
    const highGap = a.high - b.high;
    const drawnWick = side === "CALL" ? Math.min(a.open, a.close) - a.low : a.high - Math.max(a.open, a.close);
    const note = settings.greenRedHighGap > 0 && highGap > settings.greenRedHighGap ? `Green–red shape: the second candle's high ${fmt(b.high)} is ${fmt(highGap)} points below the drawn high ${fmt(a.high)} (over ${settings.greenRedHighGap})`
      : settings.greenRedDrawnWick > 0 && drawnWick < settings.greenRedDrawnWick && (!settings.greenRedDrawnWickTrend || withDay(other) || (settings.greenRedTrendMaxRange > 0 && a.high - a.low >= settings.greenRedTrendMaxRange)) ? `Green–red shape: the drawn candle's ${side === "CALL" ? "lower" : "upper"} wick is ${fmt(drawnWick)} points (under ${settings.greenRedDrawnWick})` : null;
    return note ? flip(note) : null;
  }
  if (below && a.close < a.open) {
    const range = b.high - b.low;
    const body = range > 0 ? (Math.abs(b.close - b.open) / range) * 100 : 0;
    const wick = side === "PUT" ? Math.min(b.open, b.close) - b.low : b.high - Math.max(b.open, b.close);
    if (settings.redRedWaitBody > 0 && body < settings.redRedWaitBody) return make(other, `Red–red shape: the second candle's body is ${body.toFixed(0)}% of its range (under ${settings.redRedWaitBody}%)`);
    if (settings.redRedWaitWick > 0 && wick > settings.redRedWaitWick) return make(side, `Red–red shape: the second candle's ${side === "PUT" ? "lower" : "upper"} wick is ${fmt(wick)} points (over ${settings.redRedWaitWick})`);
    if (side === "PUT") {
      const lower = Math.min(b.open, b.close) - b.low;
      const lowerShare = range > 0 ? (lower / range) * 100 : 0;
      if (settings.redRedWaitOppWick > 0 && lowerShare > settings.redRedWaitOppWick && lower >= settings.redRedWaitOppPoints) return make(other, `Red–red shape: the second candle's lower wick is ${fmt(lower)} points, ${lowerShare.toFixed(0)}% of its range (over ${settings.redRedWaitOppWick}%)`);
      const drawnLower = Math.min(a.open, a.close) - a.low;
      const drawnUpper = a.high - Math.max(a.open, a.close);
      // Not on rule 7's shape (a second candle whose lower wick is over its share), even when that one's point minimum is missed.
      const wickShape = settings.redRedWaitOppWick > 0 && lowerShare > settings.redRedWaitOppWick;
      if (settings.redRedDrawnLowerWick > 0 && !wickShape && drawnLower > settings.redRedDrawnLowerWick && drawnUpper > settings.redRedDrawnUpperWick) return make(side, `Red–red shape: the drawn candle has long wicks on both sides (lower ${fmt(drawnLower)}, upper ${fmt(drawnUpper)} points)`);
    }
  }
  return null;
}

/**
 * Red drawn + green second candle closing above the mid (`redGreenWaitPremium`): an option that costs more than that
 * is not bought now; the same side is bought one hour later. Null when it does not apply.
 */
async function redGreenWait(state: AlgoState, input: AdvanceInput, evaluation: CandleEvaluation): Promise<{ evaluation?: CandleEvaluation; note?: string; wait?: NonNullable<AlgoState["hourlyWait"]> } | null> {
  const { config, adapter, now } = input;
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...config.hourly };
  if (config.engine !== "hourly" || !(settings.redGreenWaitPremium > 0) || (evaluation.decision !== "CALL" && evaluation.decision !== "PUT")) return null;
  const pair = state.analysis?.hourly?.pairs?.find((item) => item.decisionTime === evaluation.time + 60);
  const a = pair?.first;
  const b = pair?.second;
  if (!pair || !a || !b || !(a.close < a.open && b.close > b.open && b.close > pair.reference)) return null;
  const at = pair.decisionTime + 3600;
  if (istClock(at) > config.entryCutoff) return null;
  const side: Side = evaluation.decision;
  const right: Right = side === "CALL" ? "CE" : "PE";
  let chain: ChainInput;
  try { chain = await adapter.chain(right, config.expiry); } catch { return null; }
  const atm = resolveAtm(chain, right, { rounding: config.rounding, maxQuoteAgeSeconds: config.maxQuoteAgeSeconds, maxSpreadPercent: config.maxSpreadPercent, itmSteps: config.itmSteps ?? 0 }, new Date(now * 1000));
  if (!atm.ok) return null;
  const price = money(atm.contract.ask + config.slippageTicks * TICK);
  if (price <= settings.redGreenWaitPremium) return null;
  return { wait: { session: input.sessionDate, at, side, level: pair.reference, note: `Red–green wait: the ATM ${side} costs ₹${price} (over ₹${settings.redGreenWaitPremium}) → wait one hour: ATM ${side} at ${istClock(at)}.` } };
}

/**
 * The four-year correlation rules (`ggWaitFirstHour…`, `callWaitDayMove…`, `dte3OppWick`): wait one hour or buy the
 * other side. Null when none applies.
 */
async function correlationRule(state: AlgoState, input: AdvanceInput, evaluation: CandleEvaluation): Promise<{ evaluation?: CandleEvaluation; note?: string; wait?: NonNullable<AlgoState["hourlyWait"]> } | null> {
  const { config, adapter, now } = input;
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...config.hourly };
  if (config.engine !== "hourly" || (evaluation.decision !== "CALL" && evaluation.decision !== "PUT")) return null;
  const pairs = state.analysis?.hourly?.pairs ?? [];
  const pair = pairs.find((item) => item.decisionTime === evaluation.time + 60);
  const a = pair?.first;
  const b = pair?.second;
  const opening = pairs.at(0)?.first;
  if (!pair || !a || !b || !opening) return null;
  const side: Side = evaluation.decision;
  const other: Side = side === "CALL" ? "PUT" : "CALL";
  const at = pair.decisionTime + 3600;
  const canWait = istClock(at) <= config.entryCutoff;
  const wait = (note: string) => ({ wait: { session: input.sessionDate, at, side, level: pair.reference, note: `${note} → wait one hour: ATM ${side} at ${istClock(at)}.` } });
  const fmt = (value: number) => value.toFixed(2);
  const firstHour = opening.high - opening.low;
  if (canWait && settings.ggWaitFirstHourMax > 0 && a.close > a.open && b.close > b.open && b.close > pair.reference && firstHour >= settings.ggWaitFirstHourMin && firstHour < settings.ggWaitFirstHourMax) {
    return wait(`Green–green with a ${fmt(firstHour)}-point 09:15 hour (${settings.ggWaitFirstHourMin}–${settings.ggWaitFirstHourMax})`);
  }
  const dayMove = b.close - opening.open;
  if (canWait && side === "CALL" && settings.callWaitDayMoveMax > 0 && dayMove >= settings.callWaitDayMoveMin && dayMove < settings.callWaitDayMoveMax) {
    return wait(`CALL with NIFTY ${fmt(dayMove)} points above the 09:15 open (${settings.callWaitDayMoveMin}–${settings.callWaitDayMoveMax})`);
  }
  if (settings.dte3OppWick > 0) {
    const range = b.high - b.low;
    const wick = side === "CALL" ? b.high - Math.max(b.open, b.close) : Math.min(b.open, b.close) - b.low;
    const share = range > 0 ? (wick / range) * 100 : 0;
    if (share < settings.dte3OppWick) return null;
    const right: Right = side === "CALL" ? "CE" : "PE";
    let chain: ChainInput;
    try { chain = await adapter.chain(right, config.expiry); } catch { return null; }
    const atm = resolveAtm(chain, right, { rounding: config.rounding, maxQuoteAgeSeconds: config.maxQuoteAgeSeconds, maxSpreadPercent: config.maxSpreadPercent, itmSteps: config.itmSteps ?? 0 }, new Date(now * 1000));
    const expiry = atm.ok ? atm.contract.expiry : chain.expiry;
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
    const days = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${input.sessionDate}T00:00:00Z`)) / 86_400_000);
    if (days !== 3) return null;
    const text = `3 days to expiry and the second candle's ${side === "CALL" ? "upper" : "lower"} wick is ${share.toFixed(0)}% of its range (at least ${settings.dte3OppWick}%) → ATM ${other} instead of the ${side}.`;
    return { note: text, evaluation: { ...evaluation, decision: other, setupSide: other, strategies: (evaluation.strategies ?? []).map((item) => ({ ...item, direction: other, reason: `${text} ${item.reason}` })), explanation: `${text} ${evaluation.explanation ?? ""}` } };
  }
  return null;
}

/**
 * The market-condition filter (`maxOptionLevel`): once the option to buy is too dear for the day, the session takes no
 * hourly trade. Returns the reason, or null when the entry may go on.
 */
async function optionLevelBlock(state: AlgoState, input: AdvanceInput, right: Right, evaluation: CandleEvaluation): Promise<string | null> {
  const { config, adapter, now } = input;
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...config.hourly };
  if (config.engine !== "hourly" || (!(settings.maxOptionLevel > 0) && !settings.skipRiskyTimes)) return null;
  if (state.hourlyBlockedSession === input.sessionDate) return "Market filter: no hourly trade this session (blocked earlier today).";
  if (state.position || state.tradesToday >= config.maxTrades) return null;
  let chain: ChainInput;
  try { chain = await adapter.chain(right, config.expiry); } catch { return null; }
  const atm = resolveAtm(chain, right, { rounding: config.rounding, maxQuoteAgeSeconds: config.maxQuoteAgeSeconds, maxSpreadPercent: config.maxSpreadPercent, itmSteps: config.itmSteps ?? 0 }, new Date(now * 1000));
  if (!atm.ok) return null;
  const spot = chain.spot ?? atm.contract.strike;
  const expiry = atm.contract.expiry;
  const days = expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? Math.max(0, Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${input.sessionDate}T00:00:00Z`)) / 86_400_000)) : 3;
  const price = money(atm.contract.ask + config.slippageTicks * TICK);
  const level = (100 * price) / spot / Math.sqrt(days + 1);
  const levelText = `option level ${level.toFixed(3)} (the ATM ${right} at ₹${price} is ${((100 * price) / spot).toFixed(2)}% of NIFTY ÷ √${days + 1} days)`;
  if (settings.maxOptionLevel > 0 && level > settings.maxOptionLevel) {
    state.hourlyBlockedSession = input.sessionDate;
    return `Market filter: ${levelText} is above ${settings.maxOptionLevel}: no hourly trade this session.`;
  }
  if (settings.skipRiskyTimes) {
    // Each decision is judged on its own: a half-size mark from an earlier, unfilled decision does not carry over.
    if (state.hourlyHalfSession === input.sessionDate) state.hourlyHalfSession = null;
    const pairs = state.analysis?.hourly?.pairs ?? [];
    const pair = pairs.find((item) => item.decisionTime === evaluation.time + 60);
    const opening = pairs.at(0)?.first;
    const move = pair?.second && opening ? (pair.second.close - opening.open) * (right === "CE" ? 1 : -1) : null;
    const weakMove = move != null && move >= 0 && move < settings.riskyWeakMovePoints;
    const fairlyDear = level > settings.riskyOptionLevelMin && level <= settings.riskyOptionLevelMax;
    if (weakMove || fairlyDear) {
      if (settings.riskyAction === "half") {
        state.hourlyHalfSession = input.sessionDate;
        return null;
      }
      state.hourlyBlockedSession = input.sessionDate;
      const why = weakMove ? `NIFTY is only ${move!.toFixed(1)} points in the trade's direction since the 09:15 open (under ${settings.riskyWeakMovePoints})` : `the ${levelText} is fairly dear (${settings.riskyOptionLevelMin}–${settings.riskyOptionLevelMax})`;
      return `Risky time: ${why} — no hourly trade this session.`;
    }
  }
  return null;
}

async function tryEntry(state: AlgoState, input: AdvanceInput, evaluation: CandleEvaluation, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void, flipped = false): Promise<{ ok: boolean; message: string; reasons?: string[]; plan?: TradePlan | null; capital?: CapitalPlan | null }> {
  // The side-changing hourly rules only matter while a trade can still be entered today.
  if (!flipped && (evaluation.decision === "CALL" || evaluation.decision === "PUT") && !state.position && state.tradesToday < input.config.maxTrades) {
    const other = await dearFlip(state, input, evaluation);
    const shape = shapeRule(state, input, other ?? evaluation, !!other) ?? (await redGreenWait(state, input, other ?? evaluation)) ?? (await correlationRule(state, input, other ?? evaluation));
    if (shape?.wait) {
      state.hourlyWait = shape.wait;
      return { ok: false, message: shape.wait.note, reasons: [shape.wait.note] };
    }
    if (shape?.evaluation || other) {
      const result = await tryEntry(state, input, shape?.evaluation ?? other!, log, true);
      const notes = [other ? other.explanation?.split(" → ATM ")[0] + ` → ATM ${other.decision}.` : null, shape?.note ?? null].filter(Boolean).join(" ");
      return { ...result, message: `${notes} ${result.message}` };
    }
  }
  const { config, adapter, now } = input;
  const side: Side = evaluation.decision === "CALL" ? "CALL" : "PUT";
  const right: Right = side === "CALL" ? "CE" : "PE";
  const key = entryKey(input.sessionId, evaluation.time, config.underlying, side);
  const reasons: string[] = [];
  const marketBlock = await optionLevelBlock(state, input, right, evaluation);
  if (marketBlock) return { ok: false, message: marketBlock, reasons: [marketBlock] };

  if (!state.entries) reasons.push("Algo is disabled for new entries.");
  if (state.riskLocked) reasons.push("Daily loss limit reached (risk lock).");
  if (state.recovery) reasons.push(`Recovery required: ${state.recovery}`);
  if (state.pending) reasons.push("An entry order is still pending.");
  if (state.position) {
    if (state.position.side === side) reasons.push("A position in this direction is already open.");
    else if (config.opposingPolicy === "exit-first") {
      if (!state.position.exit) await startExit(state, input, "OPPOSITE_SIGNAL", null, log);
      reasons.push("Opposing signal: exiting the open position first. A reversal needs a new signal after the exit is confirmed.");
    } else reasons.push("Opposing signal ignored while a position is open.");
  }
  if (state.tradesToday >= config.maxTrades) reasons.push(`DAILY TRADE LIMIT REACHED — ${state.tradesToday}/${config.maxTrades}: new entries are blocked until the next session.`);
  if (strategyToday(state) <= -lossLimit(config)) { state.riskLocked = true; reasons.push("Daily loss limit reached (risk lock)."); }
  if (state.lastEntryAt != null && config.cooldownMinutes > 0 && now - state.lastEntryAt < config.cooldownMinutes * 60) reasons.push(`Cooling down (${config.cooldownMinutes} min between entries).`);
  const clock = istClock(evaluation.time + 60);
  const observationEnd = dayStart(input.sessionDate) + config.observationMinutes * 60;
  const risk = { ...RISK_DEFAULTS, ...config.risk };
  const sizing = config.sizing ?? "fixed";
  if (evaluation.time + 60 < observationEnd) reasons.push(`Observation period: the first ${config.observationMinutes} minutes (to ${istClock(observationEnd)} IST) are analysis only; no new entries.`);
  else if (clock < (config.entryStart ?? "09:15")) reasons.push(`Before the entry window (${config.entryStart}–${config.entryCutoff} IST).`);
  else if (clock > config.entryCutoff) reasons.push(`Trading window closed at ${config.entryCutoff} IST: no new entries.`);
  else if (config.squareOff && clock >= config.squareOff) reasons.push(`End-of-day square-off at ${config.squareOff} IST: no new entries.`);
  if (sizing !== "risk") {
    const problem = protectiveProblem(config.stop, config.target);
    if (problem) reasons.push(problem);
  }
  const filters = { ...ALGO_DEFAULTS.filters, ...config.filters };
  // Momentum filter: the 9 / 21 EMA of the completed closes up to the signal candle must agree.
  if (filters.momentum) {
    const closes = input.candles.filter((candle) => candle.time <= evaluation.time && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time).map((candle) => candle.close);
    const fast = ema(closes, 9).at(-1);
    const slow = ema(closes, 21).at(-1);
    if (fast != null && slow != null && (side === "CALL" ? fast <= slow : fast >= slow)) reasons.push(`Momentum against the signal (9 EMA ${fast.toFixed(2)} ${side === "CALL" ? "≤" : "≥"} 21 EMA ${slow.toFixed(2)}).`);
  }
  // Trend channel: the market analysis of this candle (the chart's trendlines; confirmed swings only, nothing later).
  const channelMode = filters.trendChannel ?? "off";
  if (channelMode !== "off" && state.analysis) {
    const { trend, resistance, support } = state.analysis;
    const close = evaluation.candle.close;
    if (channelMode === "structure" && (side === "CALL" ? trend === "BEARISH" : trend === "BULLISH")) reasons.push(`TREND AGAINST — the swings make ${side === "CALL" ? "lower highs and lower lows" : "higher highs and higher lows"}: no ${side}.`);
    if (channelMode === "channel") {
      if (side === "CALL" && resistance && resistance.slope < 0 && close < resistance.now) reasons.push(`CHANNEL AGAINST — inside a falling channel: the close ${close.toFixed(2)} is under its upper line ${resistance.now.toFixed(2)}; a CALL needs a break above it.`);
      if (side === "PUT" && support && support.slope > 0 && close > support.now) reasons.push(`CHANNEL AGAINST — inside a rising channel: the close ${close.toFixed(2)} is over its lower line ${support.now.toFixed(2)}; a PUT needs a break below it.`);
    }
  }
  // Optional entry filters (each off unless set), from completed candles up to the signal candle only.
  if (filters.vwapAlign || filters.momentum5 || (filters.minAtrPoints ?? 0) > 0 || (filters.maxLineCrossings ?? 0) > 0 || (filters.minAdx ?? 0) > 0 || filters.supertrend || (filters.noChaseCandles ?? 0) > 0 || (filters.breakoutAtrMultiple ?? 0) > 0 || (filters.maxBreakoutCandleAtr ?? 0) > 0 || filters.maxVwapSlopeAgainstAtr != null || filters.maxEmaGapAgainstAtr != null) {
    const upTo = input.candles.filter((candle) => candle.time <= evaluation.time && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time);
    const last = upTo.at(-1);
    // Trend against the trade, in 14-minute ATRs of the completed candles: the VWAP's 10-minute slope and the 9 / 21 EMA gap.
    if ((filters.maxVwapSlopeAgainstAtr != null || filters.maxEmaGapAgainstAtr != null) && last && upTo.length >= 22) {
      const recent = upTo.slice(-15);
      const atr = recent.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - recent[i].close), Math.abs(c.low - recent[i].close))).reduce((a, b) => a + b, 0) / 14;
      const sign = side === "CALL" ? 1 : -1;
      const typical = (c: Candle) => (c.high + c.low + c.close) / 3;
      const vwapOf = (cs: Candle[]) => { const volume = cs.reduce((s, c) => s + (c.volume ?? 0), 0); return volume > 0 ? cs.reduce((s, c) => s + typical(c) * (c.volume ?? 0), 0) / volume : cs.reduce((s, c) => s + typical(c), 0) / cs.length; };
      if (atr > 0 && filters.maxVwapSlopeAgainstAtr != null) {
        const slope = ((vwapOf(upTo) - vwapOf(upTo.slice(0, -10))) * sign) / atr;
        if (slope < -filters.maxVwapSlopeAgainstAtr) reasons.push(`VWAP SLOPE AGAINST — VWAP moved ${(-slope).toFixed(2)} × ATR against the ${side} over 10 minutes (limit ${filters.maxVwapSlopeAgainstAtr}).`);
      }
      if (atr > 0 && filters.maxEmaGapAgainstAtr != null) {
        const closes = upTo.map((c) => c.close);
        const gap = (((ema(closes, 9).at(-1) ?? 0) - (ema(closes, 21).at(-1) ?? 0)) * sign) / atr;
        if (gap < -filters.maxEmaGapAgainstAtr) reasons.push(`EMA GAP AGAINST — 9 EMA is ${(-gap).toFixed(2)} × ATR on the wrong side of the 21 EMA for a ${side} (limit ${filters.maxEmaGapAgainstAtr}).`);
      }
    }
    // Breakout strength against volatility: the breakout candle (the crossing, before any retest) measured in 14-minute ATRs
    // of the completed candles before it.
    if (((filters.breakoutAtrMultiple ?? 0) > 0 || (filters.maxBreakoutCandleAtr ?? 0) > 0)) {
      const broke = evaluation.breakout?.candle ?? evaluation.candle;
      const before = upTo.filter((candle) => candle.time <= broke.time).slice(-15);
      const level = (evaluation.strategies ?? []).find((item) => item.direction === side)?.level ?? evaluation.events?.[0]?.price ?? null;
      if (before.length >= 15 && level != null) {
        const ranges = before.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - before[i].close), Math.abs(c.low - before[i].close)));
        const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
        const beyond = side === "CALL" ? broke.close - level : level - broke.close;
        if ((filters.breakoutAtrMultiple ?? 0) > 0 && beyond < filters.breakoutAtrMultiple! * atr) reasons.push(`Weak break: closed ${beyond.toFixed(1)} points beyond ${level.toFixed(2)}, under ${filters.breakoutAtrMultiple} × ATR (${(filters.breakoutAtrMultiple! * atr).toFixed(1)} points).`);
        if ((filters.maxBreakoutCandleAtr ?? 0) > 0 && broke.high - broke.low > filters.maxBreakoutCandleAtr! * atr) reasons.push(`Over-extended break: the breakout candle's range ${(broke.high - broke.low).toFixed(1)} points is above ${filters.maxBreakoutCandleAtr} × ATR (${(filters.maxBreakoutCandleAtr! * atr).toFixed(1)} points).`);
      }
    }
    if (last && filters.vwapAlign) {
      const volume = upTo.reduce((sum, c) => sum + (c.volume ?? 0), 0);
      const typical = (c: Candle) => (c.high + c.low + c.close) / 3;
      const vwap = volume > 0 ? upTo.reduce((sum, c) => sum + typical(c) * (c.volume ?? 0), 0) / volume : upTo.reduce((sum, c) => sum + typical(c), 0) / upTo.length;
      if (side === "CALL" ? last.close <= vwap : last.close >= vwap) reasons.push(`VWAP against the signal (close ${last.close.toFixed(2)} ${side === "CALL" ? "≤" : "≥"} VWAP ${vwap.toFixed(2)}).`);
    }
    if (last && filters.momentum5 && upTo.length >= 6) {
      const earlier = upTo[upTo.length - 6].close;
      if (side === "CALL" ? last.close <= earlier : last.close >= earlier) reasons.push(`5-minute momentum against the signal (close ${last.close.toFixed(2)} vs ${earlier.toFixed(2)} five minutes earlier).`);
    }
    if ((filters.minAtrPoints ?? 0) > 0 && upTo.length >= 15) {
      const recent = upTo.slice(-15);
      const ranges = recent.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - recent[i].close), Math.abs(c.low - recent[i].close)));
      const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
      if (atr < filters.minAtrPoints!) reasons.push(`Quiet market: 14-minute ATR ${atr.toFixed(1)} points, below ${filters.minAtrPoints}.`);
    }
    if ((filters.noChaseCandles ?? 0) > 0 && upTo.length >= filters.noChaseCandles!) {
      const recent = upTo.slice(-filters.noChaseCandles!);
      if (recent.every((c) => (side === "CALL" ? c.close > c.open : c.close < c.open))) reasons.push(`NO CHASE — the last ${recent.length} candles all moved ${side === "CALL" ? "up" : "down"} already: a stretched move usually pulls back first. Waiting for the next setup.`);
    }
    if ((filters.minAdx ?? 0) > 0 && upTo.length >= 30) {
      const value = adx(upTo, 14);
      if (value != null && value < filters.minAdx!) reasons.push(`Weak trend: ADX ${value.toFixed(1)}, below ${filters.minAdx}.`);
    }
    if (filters.supertrend && upTo.length >= 12) {
      const up = supertrendUp(upTo, 10, 3);
      if (up != null && (side === "CALL" ? !up : up)) reasons.push(`Supertrend against the signal (${up ? "up" : "down"}).`);
    }
    if ((filters.maxLineCrossings ?? 0) > 0) {
      const level = (evaluation.strategies ?? []).find((item) => item.direction === side)?.level ?? evaluation.events?.[0]?.price ?? null;
      const breakAt = evaluation.breakout?.time ?? evaluation.time;
      if (level != null) {
        let crossings = 0;
        let above: boolean | null = null;
        for (const candle of upTo.filter((c) => c.time < breakAt)) {
          const now = candle.close > level;
          if (above != null && now !== above) crossings += 1;
          above = now;
        }
        if (crossings >= filters.maxLineCrossings!) reasons.push(`Choppy line: NIFTY had closed across ${level.toFixed(2)} ${crossings} times today (limit ${filters.maxLineCrossings}).`);
      }
    }
  }
  // Level-block filter: a level stopped out recently is not traded again until its block ends.
  const blocked = (state.blockedLevels ?? []).filter((item) => now < item.until);
  const isBlocked = (level: number) => blocked.find((item) => Math.abs(item.level - level) <= level * 0.0002) ?? null;
  const agreeing = (evaluation.strategies ?? []).filter((item) => item.direction === side);
  const usable = agreeing.filter((item) => !isBlocked(item.level));
  if (agreeing.length && !usable.length) {
    const block = isBlocked(agreeing[0].level)!;
    reasons.push(`Level ${agreeing[0].level.toFixed(2)} was stopped out recently: not traded again until ${istClock(block.until)} IST.`);
  }
  const entryEvaluation: CandleEvaluation = usable.length && usable.length !== agreeing.length ? { ...evaluation, strategies: usable } : evaluation;
  if (!Number.isInteger(config.lots) || config.lots < 1) reasons.push(sizing === "risk" ? "Maximum lots must be a whole number, at least 1." : "Quantity must be a whole number of lots.");
  if (reasons.length) return reject(state, evaluation.time, key, reasons, log);

  const health = await adapter.health();
  if (!health.ok) return reject(state, evaluation.time, key, [health.reason ?? "The execution adapter is not available."], log);

  // Already processed (a repeated tick, a restart): never placed twice.
  const known = await adapter.lookup(key);
  if (known) return reject(state, evaluation.time, key, ["Order already processed."], log);

  let chain: ChainInput;
  try {
    chain = await adapter.chain(right, config.expiry);
  } catch (error) {
    return reject(state, evaluation.time, key, [`Option chain unavailable: ${error instanceof Error ? error.message : "unknown error"}.`], log);
  }
  const atm = resolveAtm(chain, right, { rounding: config.rounding, maxQuoteAgeSeconds: config.maxQuoteAgeSeconds, maxSpreadPercent: config.maxSpreadPercent, itmSteps: config.itmSteps ?? 0 }, new Date(now * 1000));
  if (!atm.ok) return reject(state, evaluation.time, key, [atm.reason], log);
  const contract = atm.contract;
  // Days to the contract's expiry: a far expiry is skipped, or needs a slower retest (each off unless set).
  const daysToExpiry = /^\d{4}-\d{2}-\d{2}$/.test(contract.expiry) ? Math.round((Date.parse(`${contract.expiry}T00:00:00Z`) - Date.parse(`${input.sessionDate}T00:00:00Z`)) / 86_400_000) : null;
  // Mathi Trend Channel: optionally no trade on the contract's expiry day (`skipExpiryDay`, off by default).
  if (config.engine === "channel" && daysToExpiry === 0 && { ...CHANNEL_SETTINGS_DEFAULTS, ...config.channel }.skipExpiryDay) {
    return reject(state, evaluation.time, key, [`EXPIRY DAY — ${right} ${contract.strike} expires today (${contract.expiry}): Mathi Trend Channel does not trade on expiry day.`], log);
  }
  if (daysToExpiry != null && (filters.maxDaysToExpiry ?? 0) > 0 && daysToExpiry > filters.maxDaysToExpiry!) {
    return reject(state, evaluation.time, key, [`FAR EXPIRY — ${right} ${contract.strike} expires ${contract.expiry}, ${daysToExpiry} days away (limit ${filters.maxDaysToExpiry}): the option is dear and needs a bigger NIFTY move for +${config.target.value}%. Not traded.`], log);
  }
  const tradeLimit = filters.maxDaysToExpiryByTrade?.[state.tradesToday];
  if (daysToExpiry != null && tradeLimit != null && daysToExpiry > tradeLimit) {
    return reject(state, evaluation.time, key, [`TRADE ${state.tradesToday + 1} RULE — expiry ${contract.expiry} is ${daysToExpiry} days away; trade ${state.tradesToday + 1} of the day is taken only ${tradeLimit} or fewer days from expiry. Not traded.`], log);
  }
  const confirmMinutes = evaluation.breakout ? (evaluation.time - evaluation.breakout.time) / 60 : null;
  if (daysToExpiry != null && confirmMinutes != null && (filters.farExpiryDays ?? 0) > 0 && (filters.farExpiryMinConfirmMinutes ?? 0) > 0 && daysToExpiry >= filters.farExpiryDays! && confirmMinutes < filters.farExpiryMinConfirmMinutes!) {
    return reject(state, evaluation.time, key, [`QUICK RETEST FAR FROM EXPIRY — confirmed ${confirmMinutes} minutes after the break, ${daysToExpiry} days to expiry (needs ${filters.farExpiryMinConfirmMinutes} minutes when ${filters.farExpiryDays}+ days away). Not traded.`], log);
  }
  const price = money(contract.ask + config.slippageTicks * TICK);
  // Premium limit: the ATM option is not bought above it (the signal is logged as not traded, with the reason).
  const maxPremium = { ...ALGO_DEFAULTS.filters, ...config.filters }.maxEntryPremium ?? 0;
  if (maxPremium > 0 && price > maxPremium) {
    return reject(state, evaluation.time, key, [`PREMIUM ABOVE LIMIT — ATM ${right} ${contract.strike} costs ₹${price}, above the ₹${maxPremium} limit: a dear option needs a bigger NIFTY move for the same +${config.target.value}% target. Not traded.`], log);
  }
  const minPremium = { ...ALGO_DEFAULTS.filters, ...config.filters }.minEntryPremium ?? 0;
  if (minPremium > 0 && price < minPremium) {
    return reject(state, evaluation.time, key, [`PREMIUM BELOW LIMIT — ATM ${right} ${contract.strike} costs ₹${price}, below the ₹${minPremium} floor: a cheap option means a very large quantity and its premium can collapse. Not traded.`], log);
  }
  const cash = await adapter.cash();
  // Risk sizing: the stop on the index (beyond the setup's invalidation) decides the lots, or no trade.
  let plan: TradePlan | null = null;
  let lots = config.lots;
  if (sizing === "risk") {
    const primary = (entryEvaluation.strategies ?? []).find((item) => item.direction === side);
    const session = input.candles.filter((candle) => candle.time <= evaluation.time && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time);
    const closes = session.map((candle) => candle.close);
    const fast = ema(closes, 9).at(-1);
    const slow = ema(closes, 21).at(-1);
    const result = planTrade({
      direction: side,
      entryIndex: evaluation.candle.close,
      invalidation: primary?.invalidation ?? primary?.level ?? evaluation.candle.close,
      zones: state.analysis?.zones ?? [],
      price,
      lotSize: contract.lotSize,
      slippageTicks: config.slippageTicks,
      charges: (orderSide, premium, quantity) => adapter.charges(orderSide, premium, quantity),
      cash,
      maxLots: config.lots,
      risk,
      minScore: config.minScore ?? 0,
      score: {
        structure: state.analysis?.trend ?? "UNCONFIRMED",
        momentum: closes.length >= 21 && fast != null && slow != null ? { fast, slow } : null,
        candle: evaluation.candle,
        agreeing: (entryEvaluation.strategies ?? []).filter((item) => item.direction === side).length,
        volume: session.length ? volumeCheck(session, session.length - 1) : "UNAVAILABLE",
      },
    });
    plan = result.plan;
    if (!result.ok) {
      const rejected = reject(state, evaluation.time, key, result.reasons, log);
      return { ...rejected, plan };
    }
    lots = plan.lots;
  }
  // Capital sizing: the most whole lots the allocation and the cash actually available pay for (charges included).
  let capital: CapitalPlan | null = null;
  if (sizing === "capital") {
    const allocated = allocateLots({ price, lotSize: contract.lotSize, cash, settings: { ...ALLOCATION_DEFAULTS, ...config.allocation }, maxLots: config.lots, charges: (orderSide, premium, quantity) => adapter.charges(orderSide, premium, quantity) });
    capital = allocated.plan;
    if (!allocated.ok) return { ...reject(state, evaluation.time, key, [allocated.reason], log), capital };
    lots = allocated.plan.lots;
  }
  // Mathi Hourly risky time with `riskyAction` "half": the trade is taken with half the lots (at least one).
  if (config.engine === "hourly" && state.hourlyHalfSession === input.sessionDate) lots = Math.max(1, Math.floor(lots / 2));
  const quantity = lots * contract.lotSize;
  const charges = adapter.charges("BUY", price, quantity);
  const cost = price * quantity + charges;
  if (cost > cash) return reject(state, evaluation.time, key, [`Insufficient buying power: needs ₹${money(cost)}, has ₹${money(cash)}.`], log);
  if (!plan) {
    const levels = protectiveLevels(price, config.stop, config.target);
    if (!levels.ok) return reject(state, evaluation.time, key, [levels.reason], log);
  }

  const ref: ContractRef = { underlying: contract.underlying, expiry: contract.expiry, strike: contract.strike, right: contract.right, securityId: contract.securityId, lotSize: contract.lotSize };
  const lineIds = evaluation.events.map((event) => event.lineId);
  // Regime switch off: the trade is followed as a shadow (same price and charges, no order, no money).
  const regime = regimeStatus(state, config);
  const shadow = !regime.on;
  let fill: Fill;
  if (shadow) {
    fill = { status: "FILLED", quantity, price, charges: adapter.charges("BUY", price, quantity) };
  } else {
    try {
      fill = await adapter.enter({ key, contract: ref, quantity, price, now });
    } catch (error) {
      fill = { status: "UNKNOWN", reason: error instanceof Error ? error.message : "The order outcome is unknown." };
    }
  }
  const label = `${shadow ? "SHADOW " : ""}ATM ${side} ${contract.strike} ${contract.expiry}`;
  if (fill.status === "FILLED" || fill.status === "PARTIAL") {
    openPosition(state, { key, contract: ref, side, lots, quantity, signalTime: evaluation.time, lineIds, explanation: evaluation.explanation, uncertain: false, setup: setupOf(entryEvaluation, side, plan), plan }, fill, input);
    const position = state.position!;
    if (shadow) position.shadow = true;
    const capitalText = capital ? ` Capital: ₹${money(fill.price * fill.quantity + fill.charges).toFixed(2)} committed of ₹${capital.available.toFixed(2)} available (${capital.percent}% allocation of ₹${capital.allocation.toFixed(2)}; ${capital.note}) Option-premium target ₹${position.target} (+${config.target.mode === "percent" ? `${money(((position.target - fill.price) / fill.price) * 100)}% on the premium` : `${config.target.value} ₹ on the premium`} = ₹${money((position.target - fill.price) * fill.quantity).toFixed(2)} on this trade before charges, ${money(((position.target - fill.price) * fill.quantity / capital.allocation) * 100)}% of the allocated capital); premium stop ₹${position.stop}. Entry charges ₹${fill.charges}.` : "";
    const planned = plan ? ` Index stop ${plan.stopIndex.toFixed(2)}, index target ${plan.targetIndex.toFixed(2)} (reward : risk ${plan.rewardRisk}); ${lots} lot${lots === 1 ? "" : "s"} risking ₹${plan.risk.toFixed(2)} of ₹${plan.budget.toFixed(2)}; setup score ${plan.score.score}.` : "";
    const message = `${shadow ? `REGIME SWITCH OFF — ${regime.reason} Shadow trade: no order, no money. ` : ""}${label} selected. Entry accepted: ${fill.quantity} @ ₹${fill.price}${fill.status === "PARTIAL" ? ` (partial fill of ${quantity})` : ""}. Stop ₹${position.stop}, target ₹${position.target}.${planned}${capitalText}`;
    state.lastOrder = { time: now, status: fill.status, message };
    log({ key: `entry:${key}`, time: evaluation.time, kind: "ENTRY", message, contract: { ...ref, bid: contract.bid, ask: contract.ask }, side, order: { key, status: fill.status, quantity: fill.quantity, price: fill.price, charges: fill.charges }, stop: position.stop, target: position.target, ...(position.setup ? { setup: position.setup } : {}), ...(shadow ? { shadow: true } : {}) });
    return { ok: true, message: `${label} selected. Entry accepted.`, plan, capital };
  }
  if (fill.status === "PENDING" || fill.status === "UNKNOWN") {
    state.pending = { key, contract: ref, side, lots, quantity, signalTime: evaluation.time, lineIds, explanation: evaluation.explanation, uncertain: fill.status === "UNKNOWN", setup: setupOf(entryEvaluation, side, plan), plan };
    if (fill.status === "UNKNOWN") state.recovery = `The ${label} entry may or may not have been placed (${fill.reason}). It is being reconciled; it will not be re-sent.`;
    const message = fill.status === "UNKNOWN" ? `${label}: order outcome unknown; reconciling before any retry.` : `${label}: order pending.`;
    state.lastOrder = { time: now, status: fill.status, message };
    log({ key: `entry:${key}`, time: evaluation.time, kind: fill.status === "UNKNOWN" ? "ERROR" : "INFO", message, contract: ref, side, order: { key, status: fill.status } });
    return { ok: true, message, plan, capital };
  }
  return reject(state, evaluation.time, key, [`Order rejected: ${fill.status === "REJECTED" ? fill.reason : "unknown reason"}`], log, { contract: ref, side });
}

function reject(state: AlgoState, time: number, key: string, reasons: string[], log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void, extra: Partial<AlgoEvent> = {}) {
  const message = `Entry rejected: ${reasons.join(" ")}`;
  state.lastOrder = { time, status: "REJECTED", message };
  log({ key: `reject:${key}`, time, kind: "REJECTED", message, reasons, ...extra });
  return { ok: false, message, reasons };
}

/** The weak-setup target (`weakTargetPercent`) for an hourly trade, or null when the session target applies. */
function weakSetupTarget(state: AlgoState, pending: PendingEntry, price: number, input: AdvanceInput): number | null {
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...input.config.hourly };
  if (input.config.engine !== "hourly" || !(settings.weakTargetPercent > 0)) return null;
  const pair = state.analysis?.hourly?.pairs?.find((item) => item.decisionTime === pending.signalTime + 60);
  const body = pair?.second ? Math.abs(pair.second.close - pair.second.open) : null;
  const expiry = pending.contract.expiry;
  const days = /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${input.sessionDate}T00:00:00Z`)) / 86_400_000) : null;
  const smallBody = settings.weakBodyPoints > 0 && body != null && body < settings.weakBodyPoints;
  const farExpiry = settings.weakMinDaysToExpiry > 0 && days != null && days >= settings.weakMinDaysToExpiry;
  return smallBody || farExpiry ? money(price * (1 + settings.weakTargetPercent / 100)) : null;
}

function openPosition(state: AlgoState, pending: PendingEntry, fill: Extract<Fill, { quantity: number }>, input: AdvanceInput) {
  const levels = protectiveLevels(fill.price, input.config.stop, input.config.target);
  // A fill whose levels would be invalid still opens (it is real), protected by the closest valid stop.
  // Risk sizing: the premium levels follow the index stop / target (moved with the actual fill price).
  const plan = pending.plan ?? null;
  const offset = plan ? fill.price - plan.entryPrice : 0;
  // Without a stop-loss (Mathi Strategy) the stop level is 0: no premium can reach it, so no stop exit.
  const stop = input.config.stopLoss === false && !plan ? 0 : plan ? money(Math.max(TICK, plan.premiumStop + offset)) : levels.ok ? levels.stop : money(fill.price * 0.5);
  // A trailing exit has no premium target (the trailing index stop closes it).
  let target = plan ? (plan.targetMode === "trail" ? money(fill.price * 100) : money(plan.premiumTarget + offset)) : levels.ok ? levels.target : money(fill.price * 1.5);
  // Mathi Hourly weak-setup target: a small second-candle body or a far expiry takes the smaller target.
  const weak = !plan ? weakSetupTarget(state, pending, fill.price, input) : null;
  if (weak) target = weak;
  state.position = {
    entryKey: pending.key, contract: pending.contract, side: pending.side, lots: pending.lots, quantity: fill.quantity, avg: fill.price,
    stop, target, entryCharges: fill.charges, openedAt: input.now, signalTime: pending.signalTime, lineIds: pending.lineIds, exit: null, exitAttempts: 0,
    ...(pending.wallet ? { wallet: pending.wallet } : {}),
    ...(pending.setup ? { setup: { ...pending.setup, entryTime: input.now } } : {}),
    ...(input.config.engine === "hourly" && state.hourlyHalfSession === input.sessionDate ? { riskyHalf: true } : {}),
  };
  state.pending = null;
  state.tradesToday += 1;
  state.lastEntryAt = input.now;
}

/** Pending entries and exits are looked up by key (never re-sent) until their outcome is known. */
async function reconcile(state: AlgoState, input: AdvanceInput, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void) {
  const { adapter, now } = input;
  if (state.pending) {
    const pending = state.pending;
    const found = await adapter.lookup(pending.key).catch(() => null);
    if (found && (found.status === "FILLED" || found.status === "PARTIAL")) {
      openPosition(state, pending, found, input);
      state.recovery = null;
      const message = `Reconciled: the entry was filled (${found.quantity} @ ₹${found.price}).`;
      state.lastOrder = { time: now, status: found.status, message };
      log({ key: `reconcile:${pending.key}`, kind: "ENTRY", message, contract: pending.contract, side: pending.side, order: { key: pending.key, status: found.status, quantity: found.quantity, price: found.price } });
    } else if (found && found.status === "REJECTED") {
      state.pending = null;
      state.recovery = null;
      log({ key: `reconcile:${pending.key}`, kind: "REJECTED", message: `Reconciled: the entry was rejected (${found.reason}).`, reasons: [found.reason] });
    } else if (!found && pending.uncertain) {
      // The order never arrived: it is safe to clear (it was not placed). It is still not re-sent.
      state.pending = null;
      state.recovery = null;
      log({ key: `reconcile:${pending.key}`, kind: "INFO", message: "Reconciled: the entry never reached the broker or simulator; it was not placed and will not be re-sent." });
    }
  }
  const position = state.position;
  if (position?.exit) {
    const found = await adapter.lookup(position.exit.key).catch(() => null);
    if (found && (found.status === "FILLED" || found.status === "PARTIAL")) settleExit(state, input, found, position.exit.reason, log);
    else if (found && found.status === "REJECTED") {
      position.exit = null;
      state.recovery = `The exit was rejected (${found.reason}). The position is still open.`;
      log({ key: `exit-rejected:${position.entryKey}:${position.exitAttempts}`, kind: "ERROR", message: state.recovery });
    } else if (!found && position.exit.uncertain) {
      position.exit = null;
      state.recovery = null;
      log({ key: `exit-lost:${position.entryKey}:${position.exitAttempts}`, kind: "INFO", message: "Reconciled: the exit never arrived; the position is still open and will be protected again." });
    }
  }
}

/** Checks the open option's own premium against its stop and target, and exits when one is reached. */
async function protect(state: AlgoState, input: AdvanceInput, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void) {
  const position = state.position;
  if (!position || position.exit) return;
  const mark = await input.adapter.mark(position.contract, input.now).catch(() => null);
  const monitor: MonitorStatus = { ...(state.monitor ?? { failures: 0 }), checkedAt: input.now, quoteAt: state.monitor?.quoteAt ?? null, bid: null, candlesThrough: position.checkedThrough ?? null, target: null, problem: null, failures: state.monitor?.failures ?? 0 };
  state.monitor = monitor;
  if (!mark) {
    monitor.failures += 1;
    monitor.problem = "No quote and no option candles: the target and stop could not be checked.";
    log({ key: `no-quote:${position.entryKey}:${Math.floor(input.now / 60)}`, kind: "ERROR", message: "No quote for the open option: the stop-loss and target could not be checked this minute." });
    return;
  }
  // Paper / live: a quote older than one already used (out of order) is never used for a decision. (A replay reuses the
  // last traded premium for a minute without trades, which is not an out-of-order quote.)
  let bid = mark.bid;
  if (input.adapter.kind === "replay") {
    // unchanged replay behaviour
  } else if (bid != null && position.lastQuoteAt != null && mark.asOf < position.lastQuoteAt) {
    monitor.problem = `Quote from ${istClock(mark.asOf)} arrived after a newer one (${istClock(position.lastQuoteAt)}): ignored.`;
    bid = null;
  } else if (bid != null) {
    position.lastQuoteAt = mark.asOf;
    monitor.quoteAt = mark.asOf;
    monitor.bid = bid;
  }
  // Paper: the option's completed 1-minute candles since the last check, in time order, so a target reached between
  // two checks is not missed. The entry minute is skipped (its high may come from before the fill) and the forming
  // minute is left to the quote. The target is a resting limit: it fills at the target once the option traded above it.
  if (mark.candles) {
    const entryMinute = Math.floor(position.openedAt / 60) * 60;
    const after = Math.max(entryMinute, position.checkedThrough ?? entryMinute);
    const fresh = mark.candles.filter((candle) => candle.time > after && candle.time + 60 <= input.now).sort((a, b) => a.time - b.time);
    if (fresh.length || bid != null) monitor.failures = 0;
    const through = money(position.target + TARGET_THROUGH_TICKS * TICK);
    for (const candle of fresh) {
      position.lowest = Math.min(position.lowest ?? position.avg, candle.low);
      position.highest = Math.max(position.highest ?? position.avg, candle.high);
      position.checkedThrough = candle.time;
      monitor.candlesThrough = candle.time;
      const hit = candleExit(candle, position.stop, through);
      if (hit) {
        monitor.target = { level: position.target, best: candle.high, hit: hit.reason === "TARGET" };
        const note = hit.reason === "TARGET"
          ? `Target reached between checks: the option traded up to ₹${candle.high} in the ${istClock(candle.time)} minute, above the ₹${position.target} target (simulated resting target order)`
          : `${hit.note} Option candle ${istClock(candle.time)}.`;
        await startExit(state, input, hit.reason, { price: hit.reason === "TARGET" ? position.target : hit.price, note, at: candle.time + 60 }, log);
        return;
      }
    }
    if (!fresh.length && bid == null) {
      monitor.failures += 1;
      monitor.problem ??= "No fresh quote or option candle since the last check.";
    }
  }
  if (bid != null || mark.candle) monitor.failures = 0;
  const seen = mark.candle ? mark.candle.low : bid;
  if (seen != null) position.lowest = Math.min(position.lowest ?? position.avg, seen);
  const best = mark.candle ? mark.candle.high : bid;
  if (best != null) position.highest = Math.max(position.highest ?? position.avg, best);
  const trigger = mark.candle ? candleExit(mark.candle, position.stop, position.target) : bid != null ? quoteExit(bid, position.stop, position.target) : null;
  monitor.target = { level: position.target, best: best ?? null, hit: trigger?.reason === "TARGET" };
  if (trigger) {
    await startExit(state, input, trigger.reason, trigger, log);
    return;
  }
  // Mathi Hourly early exit: still well below the entry this long after it, the trade is cut before it can fall further.
  if (input.config.engine === "hourly" && bid != null && (await hourlyEarlyExit(state, input, bid, log))) return;
  // Mandatory end-of-day square-off: nothing is carried past it.
  const squareOff = input.config.squareOff;
  if (squareOff && istClock(input.now) >= squareOff && bid != null) {
    await startExit(state, input, "SQUARE_OFF", { price: bid, note: `End-of-day square-off at ${squareOff} IST` }, log);
    return;
  }
  // Mathi Hourly Zone Strategy: each completed hour after the entry must close beyond its midpoint in the trade's direction.
  if (input.config.engine === "hourly" && bid != null && (await hourlyMidpointExit(state, input, bid, log))) return;
  // Time limit: still short of the target this long after the entry, the trade exits at the premium. With trend exit
  // management the limit is a checkpoint: the trade is kept only while the index trend still agrees, within the
  // maximum holding time and the loss cap; a confirmed reversal closes it. The stop-loss and target above come first.
  const hold = input.config.maxHoldMinutes ?? 0;
  const manage = { ...EXIT_MANAGEMENT_DEFAULTS, ...input.config.exitManagement };
  const elapsed = (input.now - position.openedAt) / 60;
  if (manage.mode === "trend" && hold > 0 && bid != null && (elapsed >= hold || manage.reversalBeforeCheckpoint)) {
    const open = dayStart(input.sessionDate);
    const completed = input.candles.filter((candle) => candle.time + 60 <= input.now && sameSession(candle.time, open));
    if (elapsed >= hold) position.checkpointHigh = Math.max(position.checkpointHigh ?? bid, mark.candle?.high ?? bid);
    const unrealized = (bid - position.avg) * position.quantity - position.entryCharges;
    const decision = trendExitDecision({
      settings: manage, side: position.side, elapsedMinutes: elapsed, checkpointMinutes: hold, verdict: trendVerdict(completed, position.side, open),
      premium: bid, entry: position.avg, chargesPerUnit: position.quantity ? (position.entryCharges * 2) / position.quantity : 0,
      highestSinceCheckpoint: position.checkpointHigh ?? null, dailyLossExceeded: manage.maxLossRupees > 0 && state.realizedToday + unrealized < -manage.maxLossRupees,
    });
    if (decision.action === "exit") {
      await startExit(state, input, decision.reason!, { price: bid, note: decision.note }, log);
      return;
    }
    // The hold is logged at the checkpoint and again only when the trend checks change (not every minute).
    if (elapsed >= hold && decision.note !== position.holdNote) {
      position.holdNote = decision.note;
      log({ key: `extend:${position.entryKey}:${Math.floor(input.now / 60)}`, kind: "INFO", message: decision.note });
    }
  } else if (hold > 0 && elapsed >= hold && bid != null) {
    await startExit(state, input, "TIME", { price: bid, note: `No target ${hold} minutes after the entry` }, log);
    return;
  }
  const setup = position.setup;
  // The end of the entry window with "close": the position is closed at the window's end.
  const cutoff = dayStart(input.sessionDate) + minutesOf(input.config.entryCutoff) - minutesOf("09:15");
  if (input.config.windowExit === "close" && input.now >= cutoff && bid != null) {
    await startExit(state, input, "WINDOW_END", { price: bid, note: `Entry window closed at ${input.config.entryCutoff} IST` }, log);
    return;
  }
  if (!setup || bid == null) return;
  const last = input.candles.filter((candle) => candle.time + 60 <= input.now && candle.time + 60 > setup.entryTime && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time).at(-1);
  if (!last) return;
  const bull = setup.direction === "CALL";
  // Trailing: the stop moves to each swing low (high) confirmed after the entry, beyond it by the minimum stop distance; never back.
  if (setup.trail && setup.stopIndex != null) {
    const buffer = (last.close * ({ ...RISK_DEFAULTS, ...input.config.risk }.minStopPercent)) / 100;
    const swing = (state.analysis?.pivots ?? []).filter((pivot) => pivot.kind === (bull ? "LOW" : "HIGH") && pivot.time >= setup.entryTime && pivot.confirmedAt <= input.now).at(-1);
    const next = swing ? money(bull ? swing.price - buffer : swing.price + buffer) : null;
    if (next != null && (bull ? next > setup.stopIndex : next < setup.stopIndex)) {
      log({ key: `trail:${position.entryKey}:${swing!.time}`, kind: "INFO", message: `Trailing stop moved from ${setup.stopIndex.toFixed(2)} to ${next.toFixed(2)} (beyond the swing ${bull ? "low" : "high"} ${swing!.price.toFixed(2)} confirmed after the entry).` });
      setup.stopIndex = next;
    }
  }
  // Risk sizing: the index stop (on a close through it) and the index target (on a touch).
  if (setup.stopIndex != null && (bull ? last.close <= setup.stopIndex : last.close >= setup.stopIndex)) {
    await startExit(state, input, "STOP", { price: bid, note: `Index closed at ${last.close.toFixed(2)}, through the stop ${setup.stopIndex.toFixed(2)}` }, log);
    return;
  }
  if (!setup.trail && setup.targetIndex != null && (bull ? last.high >= setup.targetIndex : last.low <= setup.targetIndex)) {
    await startExit(state, input, "TARGET", { price: bid, note: `Index reached the target ${setup.targetIndex.toFixed(2)}` }, log);
    return;
  }
  // NIFTY reversal stop: the index has closed this many points against the trade since the entry.
  const indexStop = input.config.indexStopPoints ?? 0;
  if (indexStop > 0) {
    const moved = bull ? setup.underlyingEntry - last.close : last.close - setup.underlyingEntry;
    if (moved >= indexStop) {
      await startExit(state, input, "INDEX_STOP", { price: bid, note: `NIFTY closed at ${last.close.toFixed(2)}, ${moved.toFixed(1)} points against the trade (limit ${indexStop})` }, log);
      return;
    }
  }
  // Structure stop: the index closed back through the level the trade was entered on (the setup failed).
  if (!input.config.structureStop) return;
  // N consecutive completed closes back through the level (1 = the first close back).
  const needed = Math.max(1, input.config.structureStopCloses ?? 1);
  const since = input.candles.filter((candle) => candle.time + 60 <= input.now && candle.time + 60 > setup.entryTime && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time).slice(-needed);
  const back = since.length === needed && since.every((candle) => (bull ? candle.close < setup.level : candle.close > setup.level));
  if (back) await startExit(state, input, "STRUCTURE", { price: bid, note: `Index closed at ${last.close.toFixed(2)}, back ${bull ? "below" : "above"} the broken level ${setup.level.toFixed(2)}` }, log);
}

/** Seconds since midnight for an HH:MM time. */
function minutesOf(hhmm: string) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return (hours * 60 + minutes) * 60;
}

/**
 * The engine's state on an evaluated candle: a risk lock or a closed window first, then the candidate
 * (entered), the setup waiting for its confirmation candle, or no trade (with the reason).
 */
function engineState(state: AlgoState, config: AlgoConfig, candleTime: number, evaluation: CandleEvaluation, result: { entered: boolean; reasons?: string[]; plan: TradePlan | null }): EngineState {
  const time = candleTime + 60;
  const clock = istClock(time);
  const at = (status: EngineStatus, reason: string, plan: TradePlan | null = null): EngineState => ({ status, reason, time, plan });
  if (state.riskLocked || strategyToday(state) <= -lossLimit(config)) return at("DAILY_RISK_LIMIT_REACHED", `Realized ₹${state.realizedToday} reached the daily loss limit of ₹${lossLimit(config)}: no new entries today.`);
  if (clock > config.entryCutoff) return at("TRADING_WINDOW_CLOSED", `Entries closed at ${config.entryCutoff} IST.${state.position ? " The open position stays protected by its stop and target." : ""}`);
  if (result.entered && (evaluation.decision === "CALL" || evaluation.decision === "PUT")) return at(evaluation.decision === "CALL" ? "BUY_CANDIDATE" : "SELL_CANDIDATE", evaluation.explanation, result.plan);
  if (state.awaiting) return at("WAIT_FOR_CONFIRMATION", evaluation.explanation);
  if (result.reasons?.length) return at("NO_TRADE", result.reasons.join(" "), result.plan);
  return at("NO_TRADE", evaluation.decision === "NO_SIGNAL" || !evaluation.explanation ? `No valid setup on the ${istClock(candleTime)} candle.` : evaluation.explanation);
}

/** A line that only counts one way (lineDirections): its crossings the other way are no signal. */
function directional(evaluation: CandleEvaluation, config: AlgoConfig): CandleEvaluation {
  const only = config.lineDirections;
  if (!only || !evaluation.events.length) return evaluation;
  const events = evaluation.events.filter((event) => !only[event.lineType] || only[event.lineType] === event.direction);
  if (events.length === evaluation.events.length) return evaluation;
  return { ...evaluation, events, ...consolidate(events, evaluation.notes) };
}

/** Exits the remaining open quantity (stop, target, a manual exit, an opposite signal or an emergency). */
export async function startExit(state: AlgoState, input: AdvanceInput, reason: string, trigger: { price: number; note: string; at?: number } | null, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void) {
  const position = state.position;
  if (!position || position.exit) return;
  const { adapter, now, config } = input;
  position.exitAttempts += 1;
  const key = `${position.entryKey}:exit:${position.exitAttempts}`;
  const hint = trigger ? trigger.price : (await adapter.mark(position.contract, now).catch(() => null))?.bid ?? position.avg;
  const price = money(Math.max(TICK, hint - config.slippageTicks * TICK));
  let fill: Fill;
  if (position.shadow) {
    fill = { status: "FILLED", quantity: position.quantity, price, charges: adapter.charges("SELL", price, position.quantity) };
  } else {
    try {
      fill = await adapter.exit({ key, contract: position.contract, quantity: position.quantity, price, reason, now });
    } catch (error) {
      fill = { status: "UNKNOWN", reason: error instanceof Error ? error.message : "The exit outcome is unknown." };
    }
  }
  if (fill.status === "FILLED" || fill.status === "PARTIAL") {
    position.exit = { key, reason, attempt: position.exitAttempts, uncertain: false };
    settleExit(state, input, fill, reason, log, trigger?.note, trigger?.at);
  } else if (fill.status === "PENDING" || fill.status === "UNKNOWN") {
    position.exit = { key, reason, attempt: position.exitAttempts, uncertain: fill.status === "UNKNOWN" };
    if (fill.status === "UNKNOWN") state.recovery = `The exit may or may not have been placed (${fill.reason}). It is being reconciled; it will not be re-sent.`;
    log({ key: `exit:${key}`, kind: fill.status === "UNKNOWN" ? "ERROR" : "INFO", message: fill.status === "UNKNOWN" ? `Exit (${reason}) outcome unknown: reconciling.` : `Exit (${reason}) pending.`, order: { key, status: fill.status } });
  } else {
    state.recovery = `The exit (${reason}) was rejected: ${fill.status === "REJECTED" ? fill.reason : "unknown reason"}. The position is still open.`;
    log({ key: `exit:${key}`, kind: "ERROR", message: state.recovery, order: { key, status: "REJECTED" } });
  }
}

/** `at`: when the exit actually happened, if earlier than this check (a resting target filled between checks). */
function settleExit(state: AlgoState, input: AdvanceInput, fill: Extract<Fill, { quantity: number }>, reason: string, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void, note?: string, at?: number) {
  const position = state.position!;
  const quantity = Math.min(fill.quantity, position.quantity);
  const share = position.quantity ? quantity / position.quantity : 1;
  const entryCharges = position.entryCharges * share;
  const gross = money((fill.price - position.avg) * quantity);
  const charges = money(entryCharges + fill.charges);
  const pnl = money(gross - charges);
  if (position.shadow) state.shadowToday = money((state.shadowToday ?? 0) + pnl);
  else state.realizedToday = money(state.realizedToday + pnl);
  // The regime switch's record: every trade, real or shadow (the last 100).
  state.regime = { history: [...(state.regime?.history ?? []), pnl].slice(-100) };
  position.quantity -= quantity;
  position.entryCharges -= entryCharges;
  const key = position.exit?.key ?? `${position.entryKey}:exit:${position.exitAttempts}`;
  const message = `${position.shadow ? "SHADOW " : ""}Exit (${reason}) ${quantity} @ ₹${fill.price}${note ? `: ${note.replace(/\.$/, "")}` : ""}. ${position.shadow ? "Shadow result (no money)" : "Realized"} ₹${pnl} (gross ₹${gross}, charges ₹${charges})${position.quantity > 0 ? `; ${position.quantity} still open` : ""}.`;
  log({ key: `exit:${key}`, ...(at != null ? { time: at } : {}), kind: "EXIT", message, contract: position.contract, side: position.side, ...(position.shadow ? { shadow: true } : {}), order: { key, status: fill.status, quantity, price: fill.price, charges: fill.charges }, pnl, gross, adverse: money(Math.max(0, position.avg - Math.min(position.lowest ?? position.avg, fill.price))), favorable: money(Math.max(0, Math.max(position.highest ?? position.avg, fill.price) - position.avg)), stop: position.stop, target: position.target });
  state.lastOrder = { time: input.now, status: position.quantity > 0 ? "PARTIAL" : "COMPLETED", message };
  if (position.quantity > 0) {
    // Partially closed: the rest is exited again on the next check (a new key: the first exit is known).
    position.exit = null;
  } else {
    // Level-block filter: a level that stopped a trade out is not traded again for a while.
    const minutes = { ...ALGO_DEFAULTS.filters, ...input.config.filters }.levelBlockMinutes;
    if ((reason === "STOP" || reason === "STRUCTURE") && position.setup && minutes > 0) {
      state.blockedLevels = [...(state.blockedLevels ?? []).filter((item) => input.now < item.until), { level: position.setup.level, until: input.now + minutes * 60 }].slice(-10);
    }
    state.position = null;
    state.recovery = null;
  }
  if (strategyToday(state) <= -lossLimit(input.config)) state.riskLocked = true;
}

/** Wilder's ADX of the candles (completed, oldest first), or null with too few. */
function adx(candles: Candle[], period: number): number | null {
  if (candles.length < period * 2 + 1) return null;
  const tr: number[] = [], plus: number[] = [], minus: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, down = p.low - c.low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const smooth = (xs: number[]) => {
    let value = xs.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [value];
    for (let i = period; i < xs.length; i += 1) { value = value - value / period + xs[i]; out.push(value); }
    return out;
  };
  const atr = smooth(tr), pdm = smooth(plus), mdm = smooth(minus);
  const dx = atr.map((a, i) => { const pdi = a ? (100 * pdm[i]) / a : 0, mdi = a ? (100 * mdm[i]) / a : 0; return pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0; });
  if (dx.length < period) return null;
  let value = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i += 1) value = (value * (period - 1) + dx[i]) / period;
  return value;
}

/** Supertrend direction (true = up) of the candles (completed, oldest first), or null with too few. */
function supertrendUp(candles: Candle[], period: number, multiplier: number): boolean | null {
  if (candles.length < period + 2) return null;
  let atr = 0;
  let upper = 0, lower = 0, up = true;
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atr = i <= period ? atr + tr / period : (atr * (period - 1) + tr) / period;
    if (i < period) continue;
    const mid = (c.high + c.low) / 2;
    const basicUpper = mid + multiplier * atr, basicLower = mid - multiplier * atr;
    upper = i === period || basicUpper < upper || p.close > upper ? basicUpper : upper;
    lower = i === period || basicLower > lower || p.close < lower ? basicLower : lower;
    up = i === period ? c.close >= mid : up ? c.close >= lower : c.close > upper;
  }
  return up;
}

/** The loss that stops new entries for the session: Mathi Hourly Zone Strategy's own limit is off (Infinity) unless set. */
export function lossLimit(config: AlgoConfig) {
  if (config.engine !== "hourly") return config.maxDailyLoss;
  const limit = { ...HOURLY_SETTINGS_DEFAULTS, ...config.hourly }.maxSessionLoss;
  return limit > 0 ? limit : Infinity;
}

/** The strategy's own result today (real and shadow trades): its daily loss limit acts on its signals either way. */
function strategyToday(state: AlgoState) {
  return state.realizedToday + (state.shadowToday ?? 0);
}

/** Regime switch: on (real entries) until the record has `lookback` trades, then only while their total is positive. */
export function regimeStatus(state: Pick<AlgoState, "regime">, config: Pick<AlgoConfig, "regime">): { on: boolean; total: number | null; count: number; reason: string } {
  const settings = config.regime;
  const history = state.regime?.history ?? [];
  if (!settings?.enabled) return { on: true, total: null, count: history.length, reason: "Regime switch off in settings." };
  if (history.length < settings.lookback) return { on: true, total: null, count: history.length, reason: `Only ${history.length} of ${settings.lookback} trades recorded yet: trading.` };
  const total = money(history.slice(-settings.lookback).reduce((sum, value) => sum + value, 0));
  return total > 0
    ? { on: true, total, count: history.length, reason: `The last ${settings.lookback} trades made ₹${total}: trading.` }
    : { on: false, total, count: history.length, reason: `The last ${settings.lookback} trades total ₹${total} (not positive): signals are followed as shadow trades until they recover.` };
}

function deriveStatus(state: AlgoState): AlgoStatus {
  if (state.recovery) return "RECOVERY_REQUIRED";
  if (state.position?.exit) return "EXIT_PENDING";
  if (state.pending) return "ORDER_PENDING";
  if (state.position) return "POSITION_OPEN";
  if (!state.running) return "DISABLED";
  if (state.riskLocked) return "RISK_LOCKED";
  return state.entries ? "MONITORING" : "READY";
}

/**
 * The shared signal coordinator for one completed candle: the line break (when enabled) and the
 * price-action strategies each give their signal; every one is kept on the evaluation, same-direction
 * signals are one entry decision, opposite ones are a conflict (no entry). The market analysis is updated
 * from the same completed candles. Entries then go through tryEntry (risk, limits, observation window).
 */
function coordinate(line: CandleEvaluation, candles: Candle[], input: AdvanceInput, state: AlgoState): CandleEvaluation {
  const { config } = input;
  if (config.engine === "hourly") return hourlyCoordinate(line, candles, input, state);
  if (config.engine === "channel") return channelCoordinate(line, candles, input, state);
  const enabled = { ...ALGO_DEFAULTS.strategies, ...config.strategies };
  const filters = { ...ALGO_DEFAULTS.filters, ...config.filters };
  // Breakout buffer: a line counts only when the close is clearly beyond it.
  const clearOf = (price: number) => (Math.abs(line.candle.close - price) / price) * 100 >= filters.breakoutBufferPercent;
  const rawLine: Direction | null = enabled.line && (line.decision === "CALL" || line.decision === "PUT") ? line.decision : null;
  const clearCrossings = rawLine ? line.events.filter((event) => (event.direction === "DOWN") === (rawLine === "PUT") && clearOf(event.price)) : [];
  const lineDirection: Direction | null = rawLine && clearCrossings.length ? rawLine : null;
  const thinLine = rawLine && !lineDirection ? `Line ${rawLine === "CALL" ? "crossed up" : "crossed down"} by less than the ${filters.breakoutBufferPercent}% breakout buffer: not counted.` : "";
  const previous = state.analysis?.strategies.line.lastSignal ?? null;
  const { analysis, signals } = analyzeMarket({
    candles,
    sessionOpen: dayStart(input.sessionDate),
    observationMinutes: config.observationMinutes,
    settings: { ...PATTERN_DEFAULTS, ...config.patterns },
    enabled,
    zones: input.lines.filter((item) => item.activeFrom <= line.time && !config.disabledLines.includes(item.type)).map((item) => ({ price: item.price, label: item.label })),
    lineDecision: {
      direction: lineDirection,
      status: !enabled.line ? "DISABLED" : lineDirection ? `LINE ${lineDirection === "CALL" ? "BREAK UP" : "BREAK DOWN"} CONFIRMED` : line.decision === "CONFLICTING_SIGNAL" ? "CONFLICTING LINE CROSSINGS" : "WAITING FOR LINE CROSSING",
      trigger: line.events[0]?.price ?? null,
      lastSignal: lineDirection ? { time: line.time, direction: lineDirection } : previous,
    },
  });
  // Keep each strategy's last signal across candles.
  for (const id of STRATEGY_IDS) {
    const before = state.analysis?.strategies[id]?.lastSignal ?? null;
    if (!analysis.strategies[id].lastSignal && before) analysis.strategies[id] = { ...analysis.strategies[id], lastSignal: before };
  }
  state.analysis = analysis;
  const all: StrategySignal[] = [...signals];
  if (lineDirection) {
    const level = clearCrossings[0]?.price ?? line.candle.close;
    all.unshift({ id: `line:${lineDirection}:${line.time}`, strategy: "line", direction: lineDirection, time: line.time, trigger: line.candle.close, level, invalidation: level, reason: line.explanation, volume: "NOT_REQUIRED" });
  }
  if (line.decision === "CONFLICTING_SIGNAL" && enabled.line) {
    state.awaiting = null;
    return { ...line, strategies: all };
  }
  const directions = new Set(all.map((item) => item.direction));
  const mode = confirmationMode(config);
  if (mode !== "single") return confirmBreakout(mode, line, all, directions, thinLine, input, state, candles);
  if (thinLine && !all.length) return { ...line, strategies: all, decision: "NO_SIGNAL", explanation: thinLine };
  if (directions.size > 1) {
    return { ...line, strategies: all, decision: "CONFLICTING_SIGNAL", explanation: `Conflicting signals: ${all.map((item) => `${STRATEGY_LABEL[item.strategy]} ${item.direction}`).join(", ")}. Conflict policy: no entry.` };
  }
  if (directions.size === 1) {
    const direction = all[0].direction;
    const names = all.map((item) => STRATEGY_LABEL[item.strategy]).join(" + ");
    const reasons = all.filter((item) => item.strategy !== "line").map((item) => item.reason).join(" ");
    return { ...line, strategies: all, decision: direction, explanation: `${names}: ${direction === "CALL" ? "bullish" : "bearish"} signal. ${lineDirection ? line.explanation : ""} ${reasons}`.replace(/\s+/g, " ").trim() };
  }
  if (!enabled.line && (line.decision === "CALL" || line.decision === "PUT")) return { ...line, strategies: all, decision: "NO_SIGNAL", explanation: "Line break is switched off; no other strategy signalled." };
  return { ...line, strategies: all };
}

/**
 * Mathi Hourly Zone Strategy's signal for one completed candle: its own hourly-pair rules only (the strategy lines
 * and the other setups never signal). A pair skipped on this candle is logged as REJECTED with every reason and the
 * exact OHLC values; the market analysis carries the pairs and today's trades for the chart.
 */
function hourlyCoordinate(line: CandleEvaluation, candles: Candle[], input: AdvanceInput, state: AlgoState): CandleEvaluation {
  const { config } = input;
  const sessionOpen = dayStart(input.sessionDate);
  const { analysis } = analyzeMarket({ candles, sessionOpen, observationMinutes: 0, settings: { ...PATTERN_DEFAULTS, ...config.patterns }, enabled: {} });
  const result = hourlySignal(candles, sessionOpen, { ...HOURLY_SETTINGS_DEFAULTS, ...config.hourly });
  const before = state.analysis?.strategies.hourly?.lastSignal ?? null;
  analysis.hourly = { ...result.state, trades: state.hourly?.trades ?? [] };
  analysis.strategies.hourly = { enabled: true, status: result.state.status, direction: result.signal?.direction ?? null, trigger: result.signal?.level ?? null, waiting: !result.signal, lastSignal: result.signal ? { time: line.time, direction: result.signal.direction } : before };
  state.analysis = analysis;
  state.awaiting = null;
  const base = { ...line, events: [], notes: [] };
  if (result.signal) return { ...base, strategies: [result.signal], decision: result.signal.direction, stage: "SETUP_CONFIRMED", setupSide: result.signal.direction, explanation: result.signal.reason };
  const skipped = result.decided?.status === "SKIPPED" ? result.decided : null;
  if (skipped) {
    const text = `SKIPPED — ${skipped.direction ?? "no direction"} pair ${hourClock(skipped.first.start)} + ${hourClock(skipped.first.end)}: ${skipped.reasons.join("; ")}. ${skipped.checks.join(" ")}`;
    return { ...base, strategies: [], decision: "NO_SIGNAL", ...(skipped.side ? { setupSide: skipped.side } : {}), cancelled: text, explanation: `${text} ${result.state.status}` };
  }
  return { ...base, strategies: [], decision: "NO_SIGNAL", explanation: result.state.status };
}

/**
 * Mathi Trend Channel's signal for one completed 1-minute candle: its own channel rules only (the strategy lines and the
 * other setups never signal). Decisions happen when a 3-minute candle completes: a breakout, a WATCH (channel only) and
 * a confirmation that failed are logged with their prices; a confirmed breakout is the entry signal.
 */
function channelCoordinate(line: CandleEvaluation, candles: Candle[], input: AdvanceInput, state: AlgoState): CandleEvaluation {
  const { config } = input;
  const sessionOpen = dayStart(input.sessionDate);
  const { analysis } = analyzeMarket({ candles, sessionOpen, observationMinutes: 0, settings: { ...PATTERN_DEFAULTS, ...config.patterns }, enabled: {} });
  const prevClose = input.lines.find((item) => item.type === "prev-close")?.price ?? null;
  const result = channelSignal(candles, sessionOpen, { ...CHANNEL_SETTINGS_DEFAULTS, ...config.channel }, line.time + 60, prevClose);
  const before = state.analysis?.strategies.channel?.lastSignal ?? null;
  analysis.channel = result.state;
  analysis.strategies.channel = { enabled: true, status: result.state.status, direction: result.signal?.direction ?? null, trigger: result.signal?.level ?? null, waiting: !result.signal, lastSignal: result.signal ? { time: line.time, direction: result.signal.direction } : before };
  state.analysis = analysis;
  state.awaiting = null;
  const base = { ...line, events: [], notes: [] };
  if (result.signal) return { ...base, strategies: [result.signal], decision: result.signal.direction, stage: "SETUP_CONFIRMED", setupSide: result.signal.direction, explanation: result.signal.reason };
  const notes = result.latest.map((setup) => setup.reasons.at(-1)).join(" ");
  const failed = result.decided?.status === "FAILED" ? result.decided : null;
  if (failed) {
    const text = `SKIPPED — ${failed.direction} breakout at ${barClock(failed.time)}: ${failed.reasons.at(-1)}`;
    return { ...base, strategies: [], decision: "NO_SIGNAL", setupSide: failed.direction, cancelled: text, explanation: `${notes} ${result.state.status}`.trim() };
  }
  return { ...base, strategies: [], decision: "NO_SIGNAL", explanation: `${notes} ${result.state.status}`.trim() };
}

/**
 * The hourly midpoint rule on the open trade: every full hour completed since the entry (the confirming hour's close),
 * in order and once each. A LONG is kept while the hour closes above its midpoint, a SHORT while it closes below; any
 * other close exits at the current premium. Returns whether an exit was started. Never a stop order: it acts only on
 * a completed hour.
 */
async function hourlyMidpointExit(state: AlgoState, input: AdvanceInput, bid: number, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void) {
  const position = state.position;
  if (!position || position.exit) return false;
  const open = dayStart(input.sessionDate);
  const from = position.signalTime + 60;
  const hours = hourlyCandles(input.candles.filter((candle) => sameSession(candle.time, open)), open, input.now)
    .filter((hour) => isFullHour(hour) && hour.complete && hour.start >= from && hour.start > (position.hourChecked ?? -Infinity));
  const trade = state.hourly?.trades.find((item) => item.entryKey === position.entryKey) ?? null;
  const name = position.side === "CALL" ? "LONG (CALL)" : "SHORT (PUT)";
  // Optional box exits, as on a TradingView position: NIFTY trading at the red edge (stop) or the green edge (target).
  // Every completed minute since the entry is checked once, in order; a minute reaching both edges takes the stop.
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...input.config.hourly };
  const setup = position.setup;
  if ((settings.boxStop || settings.boxTarget) && setup && setup.invalidation !== setup.level) {
    const call = position.side === "CALL";
    const stopEdge = setup.invalidation;
    const targetEdge = money(2 * setup.level - setup.invalidation);
    const minutes = input.candles.filter((candle) => candle.time >= from && candle.time + 60 <= input.now && candle.time > (position.boxChecked ?? -Infinity) && sameSession(candle.time, open)).sort((a, b) => a.time - b.time);
    for (const candle of minutes) {
      position.boxChecked = candle.time;
      const stopped = settings.boxStop && (call ? candle.low <= stopEdge : candle.high >= stopEdge);
      const reached = settings.boxTarget && (call ? candle.high >= targetEdge : candle.low <= targetEdge);
      if (stopped) {
        await startExit(state, input, "BOX_STOP", { price: bid, note: `Box stop — NIFTY traded at ${(call ? candle.low : candle.high).toFixed(2)} in the ${hourClock(candle.time)} minute, ${call ? "at or below the box bottom" : "at or above the box top"} ${stopEdge.toFixed(2)}${reached ? " (the same minute also reached the target: the stop is taken)" : ""}: the ${name} is closed` }, log);
        return true;
      }
      if (reached) {
        await startExit(state, input, "BOX_TARGET", { price: bid, note: `Box target — NIFTY traded at ${(call ? candle.high : candle.low).toFixed(2)} in the ${hourClock(candle.time)} minute, ${call ? "at or above the box top" : "at or below the box bottom"} ${targetEdge.toFixed(2)}: the ${name} is closed` }, log);
        return true;
      }
    }
  }
  if (!settings.midpointExit) return false;
  for (const hour of hours) {
    position.hourChecked = hour.start;
    const decision = hourlyMidpointDecision(position.side, hour);
    trade?.midpoints.push({ start: hour.start, end: hour.end, high: hour.high, low: hour.low, close: hour.close, mid: decision.mid, keep: decision.keep });
    const span = `${hourClock(hour.start)}–${hourClock(hour.end)}`;
    if (!decision.keep) {
      await startExit(state, input, "MIDPOINT", { price: bid, note: `Hourly midpoint exit — the ${span} hour ${decision.text}: the ${name} is closed` }, log);
      return true;
    }
    log({ key: `midpoint:${position.entryKey}:${hour.start}`, kind: "INFO", message: `Hourly midpoint: HOLD — the ${span} hour ${decision.text}; the ${name} stays open (target ₹${position.target} not reached yet).` });
  }
  return false;
}

/**
 * The hourly early exit (`earlyExitMinutes` / `earlyExitPercent`, on the contract's expiry day `expiryEarlyExit…`):
 * from that many minutes after the entry, a premium still more than that % below the entry price is sold. Returns
 * whether an exit was started.
 */
async function hourlyEarlyExit(state: AlgoState, input: AdvanceInput, bid: number, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void) {
  const position = state.position;
  if (!position || position.exit) return false;
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, ...input.config.hourly };
  // Protect the gain: the premium has already traded high enough above the entry; back near the entry, it is sold.
  if (settings.protectArmPercent > 0 && position.highest != null && position.highest >= money(position.avg * (1 + settings.protectArmPercent / 100))) {
    const lock = money(position.avg * (1 + settings.protectLockPercent / 100));
    if (bid <= lock) {
      const best = ((position.highest - position.avg) / position.avg) * 100;
      await startExit(state, input, "PROTECT", { price: bid, note: `Gain protected — the premium reached ₹${position.highest} (+${best.toFixed(1)}%, at least +${settings.protectArmPercent}%) and is back to ₹${bid} (at or below +${settings.protectLockPercent}%, ₹${lock})` }, log);
      return true;
    }
  }
  const risky = position.riskyHalf === true && settings.riskyEarlyExitMinutes > 0 && settings.riskyEarlyExitPercent > 0;
  const expiryDay = !risky && position.contract.expiry === input.sessionDate && settings.expiryEarlyExitMinutes > 0;
  const minutes = risky ? settings.riskyEarlyExitMinutes : expiryDay ? settings.expiryEarlyExitMinutes : settings.earlyExitMinutes;
  const percent = risky ? settings.riskyEarlyExitPercent : expiryDay ? settings.expiryEarlyExitPercent : settings.earlyExitPercent;
  if (!(minutes > 0) || !(percent > 0)) return false;
  const elapsed = (input.now - position.openedAt) / 60;
  const floor = money(position.avg * (1 - percent / 100));
  if (elapsed < minutes || bid >= floor) return false;
  const down = ((position.avg - bid) / position.avg) * 100;
  await startExit(state, input, "EARLY_EXIT", { price: bid, note: `Early exit — ${Math.round(elapsed)} minutes after the entry the premium ₹${bid} is ${down.toFixed(1)}% below the entry ₹${position.avg} (more than ${percent}% after ${minutes} minutes${risky ? ", risky-time trade" : expiryDay ? ", expiry day" : ""})` }, log);
  return true;
}

const HOURLY_EXIT: Record<string, HourlyTradeStatus> = { PROTECT: "GAIN PROTECTED", EARLY_EXIT: "EARLY EXIT", BOX_STOP: "BOX STOP", BOX_TARGET: "BOX TARGET", TARGET: "TARGET HIT", MIDPOINT: "MIDPOINT EXIT", SQUARE_OFF: "SESSION CLOSED", SESSION_END: "SESSION CLOSED", SESSION_CLOSED: "SESSION CLOSED" };

/** Keeps today's hourly trades (reference, target, outcome) from this check's entries and exits, for the chart and panel. */
function trackHourly(state: AlgoState, events: AlgoEvent[]) {
  const trades = [...(state.hourly?.trades ?? [])];
  for (const event of events) {
    const key = event.order?.key;
    if (!key || !event.order || (event.order.status !== "FILLED" && event.order.status !== "PARTIAL")) continue;
    if (event.kind === "ENTRY" && !trades.some((item) => item.entryKey === key)) {
      const position = state.position?.entryKey === key ? state.position : null;
      const setup = event.setup ?? position?.setup;
      if (!setup) continue;
      trades.push({
        entryKey: key, decisionTime: event.time + 60, side: setup.direction, reference: setup.level, underlyingEntry: setup.underlyingEntry, entryTime: setup.entryTime,
        premium: event.order.price ?? 0, target: event.target ?? position?.target ?? 0, status: "ENTERED", ...(event.shadow ? { shadow: true } : {}), midpoints: [],
      });
    }
    if (event.kind === "EXIT") {
      const trade = trades.find((item) => key.startsWith(`${item.entryKey}:exit:`));
      if (!trade) continue;
      const code = /Exit \(([A-Z_]+)\)/.exec(event.message)?.[1] ?? "";
      Object.assign(trade, { status: HOURLY_EXIT[code] ?? "EXITED", exitTime: event.time, exitPremium: event.order.price, exitReason: code, pnl: event.pnl, adverse: event.adverse });
    }
  }
  state.hourly = { trades };
  if (state.analysis?.hourly) state.analysis.hourly = { ...state.analysis.hourly, trades };
}

/** The setup an entry is taken on: the first agreeing strategy's level and invalidation. */
function setupOf(evaluation: CandleEvaluation, side: Side, plan: TradePlan | null = null): TradeSetup | undefined {
  const agreeing = (evaluation.strategies ?? []).filter((item) => item.direction === side);
  const primary = agreeing[0];
  if (!primary) return undefined;
  return {
    strategy: primary.strategy, strategies: agreeing.map((item) => item.strategy), direction: side, level: primary.level, invalidation: primary.invalidation, underlyingEntry: evaluation.candle.close, entryTime: evaluation.time + 60,
    ...(plan ? { stopIndex: plan.stopIndex, targetIndex: plan.targetIndex, risk: plan.risk, score: plan.score.score, ...(plan.targetMode === "trail" ? { trail: true } : {}) } : {}),
    ...(evaluation.entryType ? { entryType: evaluation.entryType } : {}),
  };
}

/**
 * The open trade's intratrade confirmations, from the session's completed candles and the option's
 * replay-time (or live) premium. Only a status that changed is logged, so a quiet trade adds no noise.
 */
async function confirm(state: AlgoState, input: AdvanceInput, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void) {
  const position = state.position;
  if (!position?.setup) {
    state.confirmations = null;
    return;
  }
  const candles = input.candles.filter((candle) => candle.time + 60 <= input.now && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time);
  const mark = await input.adapter.mark(position.contract, input.now).catch(() => null);
  const next = tradeConfirmations({
    setup: position.setup,
    candles,
    premium: mark?.bid != null ? { value: mark.bid, asOf: mark.asOf, stop: position.stop, target: position.target } : null,
    now: input.now,
  });
  for (const item of changedConfirmations(state.confirmations, next)) {
    log({ key: `confirm:${position.entryKey}:${item.category}:${item.status}:${input.now}`, kind: "INFO", message: `${item.label}: ${item.status}. ${item.why}` });
  }
  state.confirmations = next;
}

/** The crossing a confirmed setup started from (saved with the setup), for the trade's record. */
function breakoutOf(waiting: NonNullable<AlgoState["awaiting"]>): Pick<CandleEvaluation, "breakout"> {
  return waiting.candle ? { breakout: { time: waiting.time, candle: waiting.candle, events: waiting.events ?? [] } } : {};
}

/**
 * The strong-breakout entry check on one completed candle of a waiting setup (see StrongBreakoutSettings). `candles`
 * are the session's completed candles up to and including `candle`. Not a continuation (or too small a body): no entry,
 * nothing to report. A continuation that is too far from the level, or against the trend: skipped, with the reason.
 */
export function strongBreakoutCheck(input: { side: Direction; level: number; candle: Candle; breakout: Candle; candles: Candle[]; settings: StrongBreakoutSettings }): { ok: true; detail: string } | { ok: false; skip: string | null } {
  const { side, level, candle, breakout, candles, settings } = input;
  const put = side === "PUT";
  const continues = put ? candle.close < candle.open && candle.close < breakout.low : candle.close > candle.open && candle.close > breakout.high;
  if (!continues) return { ok: false, skip: null };
  const range = candle.high - candle.low;
  const bodyPercent = range > 0 ? (Math.abs(candle.close - candle.open) / range) * 100 : 0;
  if (bodyPercent < settings.minBodyPercent) return { ok: false, skip: null };
  const distance = put ? level - candle.close : candle.close - level;
  const upTo = candles.filter((item) => item.time <= candle.time);
  if (settings.maxDistanceAtr > 0 && upTo.length >= 15) {
    const recent = upTo.slice(-15);
    const atr = recent.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - recent[i].close), Math.abs(c.low - recent[i].close))).reduce((a, b) => a + b, 0) / 14;
    if (atr > 0 && distance > settings.maxDistanceAtr * atr) {
      return { ok: false, skip: `ENTRY SKIPPED — MOVE EXTENDED: the continuation closed ${distance.toFixed(2)} points past ${level.toFixed(2)}, more than ${settings.maxDistanceAtr} × ATR (${(settings.maxDistanceAtr * atr).toFixed(2)} points).` };
    }
  }
  const against: string[] = [];
  if ((settings.trend === "vwap" || settings.trend === "both") && upTo.length) {
    const typical = (c: Candle) => (c.high + c.low + c.close) / 3;
    const volume = upTo.reduce((sum, c) => sum + (c.volume ?? 0), 0);
    const vwap = volume > 0 ? upTo.reduce((sum, c) => sum + typical(c) * (c.volume ?? 0), 0) / volume : upTo.reduce((sum, c) => sum + typical(c), 0) / upTo.length;
    if (put ? candle.close >= vwap : candle.close <= vwap) against.push(`close ${candle.close.toFixed(2)} ${put ? "≥" : "≤"} VWAP ${vwap.toFixed(2)}`);
  }
  if ((settings.trend === "ema" || settings.trend === "both") && upTo.length >= 21) {
    const closes = upTo.map((c) => c.close);
    const fast = ema(closes, 9).at(-1);
    const slow = ema(closes, 21).at(-1);
    if (fast != null && slow != null && (put ? fast >= slow : fast <= slow)) against.push(`9 EMA ${fast.toFixed(2)} ${put ? "≥" : "≤"} 21 EMA ${slow.toFixed(2)}`);
  }
  if (against.length) return { ok: false, skip: `ENTRY SKIPPED — TREND AGAINST the strong breakout: ${against.join("; ")}.` };
  return { ok: true, detail: `this ${put ? "bearish" : "bullish"} candle (${candle.open.toFixed(2)} → ${candle.close.toFixed(2)}, body ${bodyPercent.toFixed(0)}% of its range) closed ${put ? "below the breakout candle's low" : "above the breakout candle's high"} ${(put ? breakout.low : breakout.high).toFixed(2)}, ${distance.toFixed(2)} points past ${level.toFixed(2)}.` };
}

/** The breakout confirmation mode in force ("single" when the legacy second-candle filter is off). */
export function confirmationMode(config: AlgoConfig): ConfirmationMode {
  const mode = config.confirmation?.mode ?? "single";
  return mode === "single" && config.filters?.secondCandle ? "hold" : mode;
}

/**
 * Breakout confirmation (hold / retest): the body crossing is only SIGNAL DETECTED; it is not traded on
 * its own candle. Hold — the next completed candle must close beyond the broken level (by the breakout
 * buffer), or the setup is cancelled as a FALSE BREAKOUT. Retest — after the break, a later candle must come
 * back to the level without closing back across it, and a following candle must move on (a bearish close
 * below the retest candle's low for a PUT, a bullish close above its high for a CALL); a close back across
 * the level cancels it, and no retest within the window lets it expire. Completed candles only. One setup
 * waits at a time (a same-direction crossing while it waits is not a second setup); an opposite signal
 * cancels it. A signal from the observation window never waits into the trading window.
 */
function confirmBreakout(mode: Exclude<ConfirmationMode, "single">, line: CandleEvaluation, all: StrategySignal[], directions: Set<Direction>, thinLine: string, input: AdvanceInput, state: AlgoState, candles: Candle[] = []): CandleEvaluation {
  const { config } = input;
  const filters = { ...ALGO_DEFAULTS.filters, ...config.filters };
  const settings = { ...ALGO_DEFAULTS.confirmation, ...config.confirmation };
  const waiting = state.awaiting ?? null;
  state.awaiting = null;
  const { open, high, low, close } = line.candle;
  const opposite = (side: Direction) => directions.size >= 1 && !directions.has(side);
  if (waiting) {
    const primary = waiting.signals[0];
    const level = primary.level;
    const put = waiting.direction === "PUT";
    const name = `${istClock(waiting.time)} ${waiting.direction} break of ${level.toFixed(2)}`;
    const back = put ? close > level : close < level;
    const cancel = (stage: "FALSE_BREAKOUT" | "EXPIRED", text: string): CandleEvaluation => ({ ...line, strategies: all, decision: "NO_SIGNAL", stage, setupSide: waiting.direction, cancelled: text, explanation: text });
    let ended: CandleEvaluation | null = null;
    if (mode === "hold") {
      if (line.time !== waiting.time + 60) {
        ended = cancel("EXPIRED", `SIGNAL EXPIRED — the ${name} was not confirmed: the next candle was not evaluated in time.`);
      } else {
        const beyond = put ? close < level * (1 - filters.breakoutBufferPercent / 100) : close > level * (1 + filters.breakoutBufferPercent / 100);
        // The confirming candle must not move against the breakout (no bearish candle after a CALL break, no
        // bullish one after a PUT break): a candle falling back toward the line, even closing just beyond it, is a rejection.
        const withBreak = settings.holdMustAgree === false || (put ? close <= open : close >= open);
        if (beyond && withBreak && !opposite(waiting.direction)) {
          const names = waiting.signals.map((item) => STRATEGY_LABEL[item.strategy]).join(" + ");
          return { ...line, strategies: waiting.signals, decision: waiting.direction, stage: "SETUP_CONFIRMED", setupSide: waiting.direction, entryType: "HOLD", ...breakoutOf(waiting), explanation: `SETUP CONFIRMED — breakout held: the next candle (${open.toFixed(2)} → ${close.toFixed(2)}) closed ${put ? "below" : "above"} ${level.toFixed(2)} without moving back toward it. ${names}: ${put ? "bearish" : "bullish"} signal from ${istClock(waiting.time)}.` };
        }
        const why = back ? `closed at ${close.toFixed(2)}, back ${put ? "above" : "below"} the line`
          : opposite(waiting.direction) ? `closed at ${close.toFixed(2)} with an opposite signal`
          : !beyond ? `closed at ${close.toFixed(2)}, not beyond it${filters.breakoutBufferPercent ? ` by the ${filters.breakoutBufferPercent}% buffer` : ""}`
          : `was ${put ? "bullish" : "bearish"} (${open.toFixed(2)} → ${close.toFixed(2)}), moving back toward the line: the breakout was rejected`;
        ended = cancel("FALSE_BREAKOUT", `FALSE BREAKOUT — ENTRY CANCELLED: the ${name} did not hold; the next candle ${why}. No order was sent.`);
      }
    } else if (back) {
      ended = cancel("FALSE_BREAKOUT", `FALSE BREAKOUT — ENTRY CANCELLED: the ${name} was reclaimed; this candle closed at ${close.toFixed(2)}, back ${put ? "above" : "below"} the line${waiting.retest ? " after the retest" : " before any retest"}. No order was sent.`);
    } else if (line.time - waiting.time > settings.retestWindowMinutes * 60) {
      ended = cancel("EXPIRED", `SIGNAL EXPIRED — no retest of ${level.toFixed(2)} that held and moved on within ${settings.retestWindowMinutes} minutes of the ${name}. No order was sent.`);
    } else if (opposite(waiting.direction)) {
      ended = cancel("FALSE_BREAKOUT", `FALSE BREAKOUT — ENTRY CANCELLED: an opposite signal on this candle cancelled the ${name}. No order was sent.`);
    } else {
      const moved = waiting.retest && (put ? close < open && close < waiting.retest.extreme : close > open && close > waiting.retest.extreme);
      if (moved) {
        const names = waiting.signals.map((item) => STRATEGY_LABEL[item.strategy]).join(" + ");
        return { ...line, strategies: waiting.signals, decision: waiting.direction, stage: "SETUP_CONFIRMED", setupSide: waiting.direction, entryType: "RETEST", ...breakoutOf(waiting), explanation: `SETUP CONFIRMED — retest held: price came back to ${level.toFixed(2)} at ${istClock(waiting.retest!.time)} without closing back across it, and this ${put ? "bearish" : "bullish"} candle closed at ${close.toFixed(2)}, ${put ? "below the retest low" : "above the retest high"} ${waiting.retest!.extreme.toFixed(2)}. ${names}: ${put ? "bearish" : "bullish"} signal from ${istClock(waiting.time)}.` };
      }
      // Strong breakout: before any retest, a strong continuation beyond the breakout candle confirms it (when enabled).
      const strong = { ...STRONG_BREAKOUT_DEFAULTS, ...settings.strongBreakout };
      let skipped = "";
      if (strong.enabled && !waiting.retest && waiting.candle) {
        const session = candles.filter((candle) => candle.time <= line.time && sameSession(candle.time, dayStart(input.sessionDate)));
        const verdict = strongBreakoutCheck({ side: waiting.direction, level, candle: line.candle, breakout: waiting.candle, candles: session, settings: strong });
        if (verdict.ok) {
          const names = waiting.signals.map((item) => STRATEGY_LABEL[item.strategy]).join(" + ");
          return { ...line, strategies: waiting.signals, decision: waiting.direction, stage: "SETUP_CONFIRMED", setupSide: waiting.direction, entryType: "STRONG_BREAKOUT", ...breakoutOf(waiting), explanation: `STRONG BREAKOUT CONFIRMED — no retest needed: ${verdict.detail} ${names}: ${put ? "bearish" : "bullish"} signal from ${istClock(waiting.time)}.` };
        }
        skipped = verdict.skip ?? "";
      }
      const tolerance = level * (settings.retestTolerancePercent / 100);
      const touched = put ? high >= level - tolerance : low <= level + tolerance;
      const retest = touched ? { time: line.time, extreme: put ? low : high } : waiting.retest ?? null;
      state.awaiting = { ...waiting, retest };
      const text = touched
        ? `RETEST IN PROGRESS — the ${name}: this candle came back to the level (${put ? `high ${high.toFixed(2)}` : `low ${low.toFixed(2)}`}) and closed ${put ? "below" : "above"} it at ${close.toFixed(2)}; waiting for a ${put ? "bearish close below" : "bullish close above"} ${retest!.extreme.toFixed(2)}.`
        : waiting.retest
          ? `WAITING — the ${name}: retested at ${istClock(waiting.retest.time)}; waiting for a ${put ? "bearish close below" : "bullish close above"} ${waiting.retest.extreme.toFixed(2)}.`
          : skipped
            ? `${skipped} The ${name} still waits for a retest of the line.`
            : `WAITING — the ${name}: holding beyond the line; waiting for a retest of it${strong.enabled ? " or a strong continuation" : ""}.`;
      return { ...line, strategies: all, decision: "NO_SIGNAL", stage: "WAITING", setupSide: waiting.direction, explanation: text };
    }
    // The setup ended: a new signal on this candle may start its own wait (logged with the cancellation).
    const fresh = detect();
    return fresh ? { ...fresh, stage: ended.stage, cancelled: ended.cancelled, setupSide: ended.setupSide, explanation: `${ended.explanation} ${fresh.explanation}` } : ended;
  }
  if (directions.size > 1) return { ...line, strategies: all, decision: "CONFLICTING_SIGNAL", explanation: `Conflicting signals: ${all.map((item) => `${STRATEGY_LABEL[item.strategy]} ${item.direction}`).join(", ")}. Conflict policy: no entry.` };
  const fresh = detect();
  if (fresh) return fresh;
  return { ...line, strategies: all, decision: line.decision === "CALL" || line.decision === "PUT" ? "NO_SIGNAL" : line.decision, explanation: [thinLine, line.decision === "CALL" || line.decision === "PUT" ? "" : line.explanation].filter(Boolean).join(" ") || line.explanation };

  function detect(): CandleEvaluation | null {
    if (directions.size !== 1) return null;
    const direction = all[0].direction;
    const names = all.map((item) => STRATEGY_LABEL[item.strategy]).join(" + ");
    const observing = line.time + 60 < dayStart(input.sessionDate) + config.observationMinutes * 60;
    if (!observing) state.awaiting = { direction, signals: all, time: line.time, mode, retest: null, candle: line.candle, events: line.events };
    const wait = mode === "hold" ? "waiting for the next completed candle to close beyond it" : `waiting for a retest of the level that holds (up to ${settings.retestWindowMinutes} minutes)`;
    return { ...line, strategies: all, decision: "NO_SIGNAL", stage: "SIGNAL_DETECTED", setupSide: direction, explanation: `SIGNAL DETECTED — ${names}: ${direction === "CALL" ? "bullish" : "bearish"} crossing at ${all[0].level.toFixed(2)}${observing ? " during the observation window: not carried forward." : `; not traded yet — ${wait}.`} ${line.explanation}`.replace(/\s+/g, " ").trim() };
  }
}
