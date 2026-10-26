import type { AlgoLine, Candle, CustomLevel, LineType } from "./lines";
import { candleExit, protectiveLevels, protectiveProblem, quoteExit, resolveAtm, type AtmContract, type ChainInput, type Protective, type Right } from "./options";
import { evaluateCandle, sameSession, type CandleEvaluation } from "./signals";
import { analyzeMarket, PATTERN_DEFAULTS, STRATEGY_IDS, STRATEGY_LABEL, type Direction, type ExistingStrategyId, type MarketAnalysis, type PatternSettings, type StrategySignal } from "./patterns";
import { PRIMARY_SETTINGS_DEFAULTS, primarySignal, type PrimarySettings } from "./primary";
import { changedConfirmations, tradeConfirmations, type Confirmation, type TradeSetup } from "./confirmations";
import { ema } from "@/lib/market/indicators";
import { allocateLots, ALLOCATION_DEFAULTS, planTrade, RISK_DEFAULTS, type AllocationSettings, type CapitalPlan, type RiskSettings, type TradePlan } from "./sizing";
import { volumeCheck } from "./patterns";

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
  /** "risk": lots sized from the index stop so one trade risks at most the risk per trade; "fixed": `lots`;
   * "capital" (Algo - Primary Strategy): the most whole lots the capital allocation and available cash buy. */
  sizing: "risk" | "fixed" | "capital";
  /** Capital-allocation sizing: share of the capital per trade, the capital it is taken from, and the policy. */
  allocation: AllocationSettings;
  /** Capital, risk per trade, daily target and minimum reward : risk (risk sizing). */
  risk: RiskSettings;
  /** Minimum setup-quality score (0–100) to enter (risk sizing). */
  minScore: number;
  /** Which strategies may signal: the line break and the price-action add-ons (the existing Algo Trade). */
  strategies: Record<ExistingStrategyId, boolean>;
  /** Which feature's signals these settings drive: the existing Algo Trade, or Algo - Primary Strategy. */
  engine: "existing" | "primary";
  /** Algo - Primary Strategy (NIFTY ORB + VWAP + trend) settings; used only when engine is "primary". */
  primary: PrimarySettings;
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
  };
  /** Exit when the index closes back through the broken level (the setup is wrong), besides the premium stop. */
  structureStop: boolean;
  /** Swing, pattern and breakout settings for the trendline, W and M strategies. */
  patterns: PatternSettings;
  /** Line crossings: "body" — the candle opens at or before the line and closes past it (Mathi Strategy); "classic" —
   * the previous close and this open on one side, this close on the other. */
  crossRule: "body" | "classic";
  /** "body" rule: the share of the candle's body that must be past the line, % (0 = any genuine crossing). */
  crossPercent: number;
  /** Automatic stop-loss exits. Mathi Strategy runs without one (shown clearly); Algo - Primary Strategy keeps its premium stop. */
  stopLoss: boolean;
  /** Live-price paper: also check the forming candle (at its current price) when the data feed provides it. */
  intrabar: boolean;
  /** Pause the replay once the session's entries are used up (otherwise it keeps playing; new entries stay blocked). */
  stopAtLimit: boolean;
};

export const ALGO_DEFAULTS: AlgoConfig = {
  underlying: "NIFTY",
  mode: "PAPER",
  timeframe: "1m",
  expiry: "nearest",
  // Mathi Strategy: a line breakout buys as many whole ATM lots as the ₹1,00,000 capital pays for (up to
  // 50 lots); +3% on the option premium; no stop-loss.
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
  sizing: "capital",
  allocation: ALLOCATION_DEFAULTS,
  risk: RISK_DEFAULTS,
  minScore: 60,
  // Only strategy-line crossings: W / M, bounce / rejection, trendline and opening-range signals are off.
  strategies: { line: true, trendline: false, w: false, m: false, orb: false, bounce: false, rejection: false },
  observationMinutes: 0,
  engine: "existing",
  primary: PRIMARY_SETTINGS_DEFAULTS,
  settingsVersion: 9,
  filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false },
  structureStop: false,
  patterns: PATTERN_DEFAULTS,
  // Any genuine body crossing of an enabled line (no minimum points, no share of the body).
  crossRule: "body",
  crossPercent: 0,
  stopLoss: false,
  intrabar: true,
  stopAtLimit: false,
};

/**
 * Algo - Primary Strategy's own default settings: the same account, sizing and risk rules, its own signal
 * engine (the opening range is its observation window), no existing-strategy filters, chart replay only.
 */
export const PRIMARY_DEFAULTS: AlgoConfig = {
  ...ALGO_DEFAULTS,
  engine: "primary",
  mode: "REPLAY",
  entryCutoff: "12:00",
  // Up to 100% of the ₹1,00,000 demo capital in whole lots; +3% / −3% on the executed option premium.
  sizing: "capital",
  lots: 50,
  stop: { mode: "percent", value: 3 },
  target: { mode: "percent", value: 3 },
  maxDailyLoss: 3_000,
  maxTrades: 2,
  stopLoss: true,
  stopAtLimit: true,
  crossRule: "classic",
  crossPercent: 0,
  intrabar: false,
  minScore: 0,
  filters: { levelBlockMinutes: 15, breakoutBufferPercent: 0, secondCandle: false, momentum: false },
  structureStop: false,
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
  lastSignal: { time: number; decision: string; explanation: string } | null;
  lastOrder: { time: number; status: string; message: string } | null;
  /** The latest market analysis (opening range, trend, trendlines, W / M, strategy statuses). */
  analysis?: MarketAnalysis | null;
  /** The open trade's latest intratrade confirmations. */
  confirmations?: Confirmation[] | null;
  /** A signal waiting for the next candle to confirm it (second-candle filter). */
  awaiting?: { direction: Direction; signals: StrategySignal[]; time: number } | null;
  /** Levels stopped out recently: not traded again until `until` (level-block filter). */
  blockedLevels?: Array<{ level: number; until: number }>;
  /** The engine's state on the latest evaluated candle. */
  engine?: EngineState | null;
  /** A candle already entered on while it was forming (live paper), so its completed evaluation does not enter again. */
  formingEntry?: number | null;
};

export function initialState(sessionDate: string): AlgoState {
  return { running: false, entries: false, status: "DISABLED", sessionDate, lastCandle: null, tradesToday: 0, realizedToday: 0, lastEntryAt: null, riskLocked: false, recovery: null, position: null, pending: null, lastSignal: null, lastOrder: null };
}

export type Fill =
  | { status: "FILLED" | "PARTIAL"; quantity: number; price: number; charges: number }
  | { status: "PENDING" }
  | { status: "REJECTED"; reason: string }
  | { status: "UNKNOWN"; reason: string };

export type Mark = { bid: number | null; ask: number | null; candle: { open: number; high: number; low: number; close: number } | null; asOf: number };

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
  reasons?: string[];
  /** On entries: the strategy and the broken level the trade was taken on. */
  setup?: TradeSetup;
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
    Object.assign(state, { sessionDate: input.sessionDate, lastCandle: null, tradesToday: 0, realizedToday: 0, riskLocked: false, lastEntryAt: null, awaiting: null, blockedLevels: [] });
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
      const lineEvaluation = evaluateCandle({ previous: index > 0 ? completed[index - 1] : null, candle, lines: input.lines, enabled: (line) => !config.disabledLines.includes(line.type), now, fraction: config.crossRule === "body" ? (config.crossPercent ?? 0) / 100 : undefined });
      const evaluation = coordinate(lineEvaluation, completed.slice(0, index + 1), input, state);
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
          if (evaluation.audit) evaluation.audit = { ...evaluation.audit, decision: "REJECT", reason: `REJECTED — ${reasons[0]}` };
          outcome = `${evaluation.explanation} Not traded: evaluated late.`;
        } else {
          const result = await tryEntry(state, input, evaluation, log);
          outcome = `${evaluation.explanation} ${result.message}`;
          reasons = result.reasons;
          plan = result.plan ?? null;
          capital = result.capital ?? null;
          entered = result.ok;
          if (!result.ok) kind = "REJECTED";
          if (evaluation.audit) evaluation.audit = { ...evaluation.audit, decision: result.ok ? "ENTER" : "REJECT", reason: result.ok ? `ORDER PLACED — ${evaluation.decision}` : `REJECTED — ${(result.reasons ?? [result.message]).join(" ")}` };
        }
      } else if (evaluation.decision === "CONFLICTING_SIGNAL") {
        state.lastSignal = { time: candle.time, decision: evaluation.decision, explanation: evaluation.explanation };
        reasons = ["Conflicting signals"];
      }
      log({ key: `eval:${candle.time}`, time: candle.time, kind, message: outcome, evaluation, reasons });
      state.engine = { ...engineState(state, config, candle.time, evaluation, { entered, reasons, plan }), capital };
    }
    if (latest && (state.lastCandle == null || latest.time > state.lastCandle)) state.lastCandle = latest.time;
    // Live paper with share-of-body crossings: the forming candle may enter as soon as its share is reached
    // (at its current price), once; its completed evaluation then does not enter again.
    const forming = input.candles.filter((candle) => candle.time + 60 > now && candle.time <= now && sameSession(candle.time, dayStart(input.sessionDate))).sort((a, b) => a.time - b.time).at(-1);
    if (config.intrabar && config.crossRule === "body" && adapter.kind === "paper" && forming && state.formingEntry !== forming.time && !(config.filters?.secondCandle) && (state.lastCandle == null || forming.time > state.lastCandle)) {
      const previous = completed.at(-1) ?? null;
      const lineEvaluation = evaluateCandle({ previous, candle: forming, lines: input.lines, enabled: (line) => !config.disabledLines.includes(line.type), now, fraction: (config.crossPercent ?? 0) / 100, forming: true });
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

  state.status = deriveStatus(state);
  return { state, events };
}

function dayStart(date: string) {
  return Math.floor(Date.parse(`${date}T03:45:00Z`) / 1000);
}

async function tryEntry(state: AlgoState, input: AdvanceInput, evaluation: CandleEvaluation, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void): Promise<{ ok: boolean; message: string; reasons?: string[]; plan?: TradePlan | null; capital?: CapitalPlan | null }> {
  const { config, adapter, now } = input;
  const side: Side = evaluation.decision === "CALL" ? "CALL" : "PUT";
  const right: Right = side === "CALL" ? "CE" : "PE";
  const key = entryKey(input.sessionId, evaluation.time, config.underlying, side);
  const reasons: string[] = [];

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
  if (state.realizedToday <= -config.maxDailyLoss) { state.riskLocked = true; reasons.push("Daily loss limit reached (risk lock)."); }
  if (state.lastEntryAt != null && config.cooldownMinutes > 0 && now - state.lastEntryAt < config.cooldownMinutes * 60) reasons.push(`Cooling down (${config.cooldownMinutes} min between entries).`);
  const clock = istClock(evaluation.time + 60);
  const observationEnd = dayStart(input.sessionDate) + config.observationMinutes * 60;
  const risk = { ...RISK_DEFAULTS, ...config.risk };
  const sizing = config.sizing ?? "fixed";
  if (evaluation.time + 60 < observationEnd) reasons.push(`Observation period: the first ${config.observationMinutes} minutes (to ${istClock(observationEnd)} IST) are analysis only; no new entries.`);
  else if (clock < (config.entryStart ?? "09:15")) reasons.push(`Before the entry window (${config.entryStart}–${config.entryCutoff} IST).`);
  else if (clock > config.entryCutoff) reasons.push(`Trading window closed at ${config.entryCutoff} IST: no new entries.`);
  if (risk.stopAtTarget && state.realizedToday >= risk.dailyTarget) reasons.push(`Daily target ₹${risk.dailyTarget} reached (realized ₹${state.realizedToday}): no new entries today.`);
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
  const atm = resolveAtm(chain, right, { rounding: config.rounding, maxQuoteAgeSeconds: config.maxQuoteAgeSeconds, maxSpreadPercent: config.maxSpreadPercent }, new Date(now * 1000));
  if (!atm.ok) return reject(state, evaluation.time, key, [atm.reason], log);
  const contract = atm.contract;
  const price = money(contract.ask + config.slippageTicks * TICK);
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
  let fill: Fill;
  try {
    fill = await adapter.enter({ key, contract: ref, quantity, price, now });
  } catch (error) {
    fill = { status: "UNKNOWN", reason: error instanceof Error ? error.message : "The order outcome is unknown." };
  }
  const label = `ATM ${side} ${contract.strike} ${contract.expiry}`;
  if (fill.status === "FILLED" || fill.status === "PARTIAL") {
    openPosition(state, { key, contract: ref, side, lots, quantity, signalTime: evaluation.time, lineIds, explanation: evaluation.explanation, uncertain: false, setup: setupOf(entryEvaluation, side, plan), plan }, fill, input);
    const position = state.position!;
    const capitalText = capital ? ` Capital: ₹${money(fill.price * fill.quantity + fill.charges).toFixed(2)} committed of ₹${capital.available.toFixed(2)} available (${capital.percent}% allocation of ₹${capital.allocation.toFixed(2)}; ${capital.note}) Option-premium target ₹${position.target} (+${config.target.value}${config.target.mode === "percent" ? "% on the premium" : " ₹ on the premium"} = ₹${money((position.target - fill.price) * fill.quantity).toFixed(2)} on this trade before charges, ${money(((position.target - fill.price) * fill.quantity / capital.allocation) * 100)}% of the allocated capital); premium stop ₹${position.stop}. Entry charges ₹${fill.charges}.` : "";
    const planned = plan ? ` Index stop ${plan.stopIndex.toFixed(2)}, index target ${plan.targetIndex.toFixed(2)} (reward : risk ${plan.rewardRisk}); ${lots} lot${lots === 1 ? "" : "s"} risking ₹${plan.risk.toFixed(2)} of ₹${plan.budget.toFixed(2)}; setup score ${plan.score.score}.` : "";
    const message = `${label} selected. Entry accepted: ${fill.quantity} @ ₹${fill.price}${fill.status === "PARTIAL" ? ` (partial fill of ${quantity})` : ""}. Stop ₹${position.stop}, target ₹${position.target}.${planned}${capitalText}`;
    state.lastOrder = { time: now, status: fill.status, message };
    log({ key: `entry:${key}`, time: evaluation.time, kind: "ENTRY", message, contract: { ...ref, bid: contract.bid, ask: contract.ask }, side, order: { key, status: fill.status, quantity: fill.quantity, price: fill.price, charges: fill.charges }, stop: position.stop, target: position.target, ...(position.setup ? { setup: position.setup } : {}) });
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

function openPosition(state: AlgoState, pending: PendingEntry, fill: Extract<Fill, { quantity: number }>, input: AdvanceInput) {
  const levels = protectiveLevels(fill.price, input.config.stop, input.config.target);
  // A fill whose levels would be invalid still opens (it is real), protected by the closest valid stop.
  // Risk sizing: the premium levels follow the index stop / target (moved with the actual fill price).
  const plan = pending.plan ?? null;
  const offset = plan ? fill.price - plan.entryPrice : 0;
  // Without a stop-loss (Mathi Strategy) the stop level is 0: no premium can reach it, so no stop exit.
  const stop = input.config.stopLoss === false && !plan ? 0 : plan ? money(Math.max(TICK, plan.premiumStop + offset)) : levels.ok ? levels.stop : money(fill.price * 0.5);
  // A trailing exit has no premium target (the trailing index stop closes it).
  const target = plan ? (plan.targetMode === "trail" ? money(fill.price * 100) : money(plan.premiumTarget + offset)) : levels.ok ? levels.target : money(fill.price * 1.5);
  state.position = {
    entryKey: pending.key, contract: pending.contract, side: pending.side, lots: pending.lots, quantity: fill.quantity, avg: fill.price,
    stop, target, entryCharges: fill.charges, openedAt: input.now, signalTime: pending.signalTime, lineIds: pending.lineIds, exit: null, exitAttempts: 0,
    ...(pending.wallet ? { wallet: pending.wallet } : {}),
    ...(pending.setup ? { setup: { ...pending.setup, entryTime: input.now } } : {}),
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
  if (!mark) {
    log({ key: `no-quote:${position.entryKey}:${Math.floor(input.now / 60)}`, kind: "ERROR", message: "No quote for the open option: the stop-loss and target could not be checked this minute." });
    return;
  }
  const trigger = mark.candle ? candleExit(mark.candle, position.stop, position.target) : mark.bid != null ? quoteExit(mark.bid, position.stop, position.target) : null;
  if (trigger) {
    await startExit(state, input, trigger.reason, trigger, log);
    return;
  }
  const setup = position.setup;
  // The end of the entry window with "close": the position is closed at the window's end.
  const cutoff = dayStart(input.sessionDate) + minutesOf(input.config.entryCutoff) - minutesOf("09:15");
  if (input.config.windowExit === "close" && input.now >= cutoff && mark.bid != null) {
    await startExit(state, input, "WINDOW_END", { price: mark.bid, note: `Entry window closed at ${input.config.entryCutoff} IST` }, log);
    return;
  }
  if (!setup || mark.bid == null) return;
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
    await startExit(state, input, "STOP", { price: mark.bid, note: `Index closed at ${last.close.toFixed(2)}, through the stop ${setup.stopIndex.toFixed(2)}` }, log);
    return;
  }
  if (!setup.trail && setup.targetIndex != null && (bull ? last.high >= setup.targetIndex : last.low <= setup.targetIndex)) {
    await startExit(state, input, "TARGET", { price: mark.bid, note: `Index reached the target ${setup.targetIndex.toFixed(2)}` }, log);
    return;
  }
  // Structure stop: the index closed back through the level the trade was entered on (the setup failed).
  if (!input.config.structureStop) return;
  const back = bull ? last.close < setup.level : last.close > setup.level;
  if (back) await startExit(state, input, "STRUCTURE", { price: mark.bid, note: `Index closed at ${last.close.toFixed(2)}, back ${bull ? "below" : "above"} the broken level ${setup.level.toFixed(2)}` }, log);
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
  const risk = { ...RISK_DEFAULTS, ...config.risk };
  const at = (status: EngineStatus, reason: string, plan: TradePlan | null = null): EngineState => ({ status, reason, time, plan });
  if (state.riskLocked || state.realizedToday <= -config.maxDailyLoss) return at("DAILY_RISK_LIMIT_REACHED", `Realized ₹${state.realizedToday} reached the daily loss limit of ₹${config.maxDailyLoss}: no new entries today.`);
  if (risk.stopAtTarget && state.realizedToday >= risk.dailyTarget) return at("TRADING_WINDOW_CLOSED", `Daily target ₹${risk.dailyTarget} reached (realized ₹${state.realizedToday}): no new entries today.`);
  if (clock > config.entryCutoff) return at("TRADING_WINDOW_CLOSED", `Entries closed at ${config.entryCutoff} IST.${state.position ? " The open position stays protected by its stop and target." : ""}`);
  if (result.entered && (evaluation.decision === "CALL" || evaluation.decision === "PUT")) return at(evaluation.decision === "CALL" ? "BUY_CANDIDATE" : "SELL_CANDIDATE", evaluation.explanation, result.plan);
  if (state.awaiting) return at("WAIT_FOR_CONFIRMATION", evaluation.explanation);
  if (result.reasons?.length) return at("NO_TRADE", result.reasons.join(" "), result.plan);
  return at("NO_TRADE", evaluation.decision === "NO_SIGNAL" || !evaluation.explanation ? `No valid setup on the ${istClock(candleTime)} candle.` : evaluation.explanation);
}

/** Exits the remaining open quantity (stop, target, a manual exit, an opposite signal or an emergency). */
export async function startExit(state: AlgoState, input: AdvanceInput, reason: string, trigger: { price: number; note: string } | null, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void) {
  const position = state.position;
  if (!position || position.exit) return;
  const { adapter, now, config } = input;
  position.exitAttempts += 1;
  const key = `${position.entryKey}:exit:${position.exitAttempts}`;
  const hint = trigger ? trigger.price : (await adapter.mark(position.contract, now).catch(() => null))?.bid ?? position.avg;
  const price = money(Math.max(TICK, hint - config.slippageTicks * TICK));
  let fill: Fill;
  try {
    fill = await adapter.exit({ key, contract: position.contract, quantity: position.quantity, price, reason, now });
  } catch (error) {
    fill = { status: "UNKNOWN", reason: error instanceof Error ? error.message : "The exit outcome is unknown." };
  }
  if (fill.status === "FILLED" || fill.status === "PARTIAL") {
    position.exit = { key, reason, attempt: position.exitAttempts, uncertain: false };
    settleExit(state, input, fill, reason, log, trigger?.note);
  } else if (fill.status === "PENDING" || fill.status === "UNKNOWN") {
    position.exit = { key, reason, attempt: position.exitAttempts, uncertain: fill.status === "UNKNOWN" };
    if (fill.status === "UNKNOWN") state.recovery = `The exit may or may not have been placed (${fill.reason}). It is being reconciled; it will not be re-sent.`;
    log({ key: `exit:${key}`, kind: fill.status === "UNKNOWN" ? "ERROR" : "INFO", message: fill.status === "UNKNOWN" ? `Exit (${reason}) outcome unknown: reconciling.` : `Exit (${reason}) pending.`, order: { key, status: fill.status } });
  } else {
    state.recovery = `The exit (${reason}) was rejected: ${fill.status === "REJECTED" ? fill.reason : "unknown reason"}. The position is still open.`;
    log({ key: `exit:${key}`, kind: "ERROR", message: state.recovery, order: { key, status: "REJECTED" } });
  }
}

function settleExit(state: AlgoState, input: AdvanceInput, fill: Extract<Fill, { quantity: number }>, reason: string, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void, note?: string) {
  const position = state.position!;
  const quantity = Math.min(fill.quantity, position.quantity);
  const share = position.quantity ? quantity / position.quantity : 1;
  const entryCharges = position.entryCharges * share;
  const gross = money((fill.price - position.avg) * quantity);
  const charges = money(entryCharges + fill.charges);
  const pnl = money(gross - charges);
  state.realizedToday = money(state.realizedToday + pnl);
  position.quantity -= quantity;
  position.entryCharges -= entryCharges;
  const key = position.exit?.key ?? `${position.entryKey}:exit:${position.exitAttempts}`;
  const message = `Exit (${reason}) ${quantity} @ ₹${fill.price}${note ? `: ${note.replace(/\.$/, "")}` : ""}. Realized ₹${pnl} (gross ₹${gross}, charges ₹${charges})${position.quantity > 0 ? `; ${position.quantity} still open` : ""}.`;
  log({ key: `exit:${key}`, kind: "EXIT", message, contract: position.contract, side: position.side, order: { key, status: fill.status, quantity, price: fill.price, charges: fill.charges }, pnl, gross, stop: position.stop, target: position.target });
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
  if (state.realizedToday <= -input.config.maxDailyLoss) state.riskLocked = true;
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
  if (config.engine === "primary") return primaryCoordinate(line, candles, input, state);
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
  if (filters.secondCandle) return secondCandle(line, all, directions, thinLine, input, state);
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
 * Algo - Primary Strategy's signal for one completed candle: its own ORB + VWAP + trend rules only (the
 * strategy lines and the existing setups do not signal). The market analysis (trendlines, zones, the
 * opening range) is still computed for the chart, the dashboard and the room-to-target check.
 */
function primaryCoordinate(line: CandleEvaluation, candles: Candle[], input: AdvanceInput, state: AlgoState): CandleEvaluation {
  const { config } = input;
  const settings = { ...PRIMARY_SETTINGS_DEFAULTS, ...config.primary };
  const sessionOpen = dayStart(input.sessionDate);
  const { analysis } = analyzeMarket({
    candles,
    sessionOpen,
    observationMinutes: 0,
    settings: { ...PATTERN_DEFAULTS, ...config.patterns, orbMinutes: settings.orMinutes },
    enabled: {},
    zones: input.lines.filter((item) => item.activeFrom <= line.time).map((item) => ({ price: item.price, label: item.label })),
  });
  const result = primarySignal(candles, sessionOpen, settings);
  const before = state.analysis?.strategies.primary?.lastSignal ?? null;
  analysis.primary = result.state;
  analysis.strategies.primary = { enabled: true, status: result.state.status, direction: result.signal?.direction ?? null, trigger: result.signal?.level ?? result.state.range?.high ?? null, waiting: !result.signal, lastSignal: result.signal ? { time: line.time, direction: result.signal.direction } : before };
  state.analysis = analysis;
  state.awaiting = null;
  const base = { ...line, events: [], notes: [] };
  const audit = result.state.audit ?? null;
  if (!result.signal) return { ...base, strategies: [], decision: "NO_SIGNAL", explanation: [result.state.status, ...result.state.checks].join(" "), audit };
  return { ...base, strategies: [result.signal], decision: result.signal.direction, explanation: result.signal.reason, audit };
}

/** The setup an entry is taken on: the first agreeing strategy's level and invalidation. */
function setupOf(evaluation: CandleEvaluation, side: Side, plan: TradePlan | null = null): TradeSetup | undefined {
  const agreeing = (evaluation.strategies ?? []).filter((item) => item.direction === side);
  const primary = agreeing[0];
  if (!primary) return undefined;
  return {
    strategy: primary.strategy, strategies: agreeing.map((item) => item.strategy), direction: side, level: primary.level, invalidation: primary.invalidation, underlyingEntry: evaluation.candle.close, entryTime: evaluation.time + 60,
    ...(plan ? { stopIndex: plan.stopIndex, targetIndex: plan.targetIndex, risk: plan.risk, score: plan.score.score, ...(plan.targetMode === "trail" ? { trail: true } : {}) } : {}),
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

/**
 * Second-candle filter: a signal does not enter on its own candle. It waits, and the next candle enters
 * only if it also closes beyond the signal's level (by the breakout buffer); otherwise it lapses. A signal
 * from the observation window never waits into the trading window.
 */
function secondCandle(line: CandleEvaluation, all: StrategySignal[], directions: Set<Direction>, thinLine: string, input: AdvanceInput, state: AlgoState): CandleEvaluation {
  const { config } = input;
  const filters = { ...ALGO_DEFAULTS.filters, ...config.filters };
  const waiting = state.awaiting ?? null;
  state.awaiting = null;
  const notes: string[] = [];
  if (waiting && line.time === waiting.time + 60) {
    const primary = waiting.signals[0];
    // The confirming candle's whole body (open and close) stays beyond the level, by the buffer at the close.
    const beyond = waiting.direction === "CALL"
      ? line.candle.close > primary.level * (1 + filters.breakoutBufferPercent / 100) && line.candle.open > primary.level
      : line.candle.close < primary.level * (1 - filters.breakoutBufferPercent / 100) && line.candle.open < primary.level;
    const opposite = directions.size === 1 && !directions.has(waiting.direction);
    if (beyond && !opposite) {
      const names = waiting.signals.map((item) => STRATEGY_LABEL[item.strategy]).join(" + ");
      return { ...line, strategies: waiting.signals, decision: waiting.direction, explanation: `Second candle confirmed: closed at ${line.candle.close.toFixed(2)}, still ${waiting.direction === "CALL" ? "above" : "below"} ${primary.level.toFixed(2)}. ${names}: ${waiting.direction === "CALL" ? "bullish" : "bearish"} signal from ${istClock(waiting.time)}.` };
    }
    notes.push(`The ${istClock(waiting.time)} ${waiting.direction} signal was not confirmed: this candle closed at ${line.candle.close.toFixed(2)}${opposite ? " with an opposite signal" : `, not beyond ${primary.level.toFixed(2)}`}.`);
  }
  if (directions.size > 1) return { ...line, strategies: all, decision: "CONFLICTING_SIGNAL", explanation: `${notes.join(" ")} Conflicting signals: ${all.map((item) => `${STRATEGY_LABEL[item.strategy]} ${item.direction}`).join(", ")}. Conflict policy: no entry.`.trim() };
  if (directions.size === 1) {
    const direction = all[0].direction;
    const names = all.map((item) => STRATEGY_LABEL[item.strategy]).join(" + ");
    const observing = line.time + 60 < dayStart(input.sessionDate) + config.observationMinutes * 60;
    if (!observing) state.awaiting = { direction, signals: all, time: line.time };
    return { ...line, strategies: all, decision: "NO_SIGNAL", explanation: `${notes.join(" ")} ${names}: ${direction === "CALL" ? "bullish" : "bearish"} signal at ${all[0].level.toFixed(2)}${observing ? " during the observation window: not carried forward." : " — waiting for the next candle to confirm it."}`.trim() };
  }
  return { ...line, strategies: all, decision: line.decision === "CALL" || line.decision === "PUT" ? "NO_SIGNAL" : line.decision, explanation: [...notes, thinLine, line.decision === "CALL" || line.decision === "PUT" ? "" : line.explanation].filter(Boolean).join(" ") || line.explanation };
}
