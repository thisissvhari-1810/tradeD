import type { AlgoLine, Candle, CustomLevel, LineType } from "./lines";
import { candleExit, protectiveLevels, protectiveProblem, quoteExit, resolveAtm, type AtmContract, type ChainInput, type Protective, type Right } from "./options";
import { evaluateCandle, sameSession, type CandleEvaluation } from "./signals";
import { analyzeMarket, PATTERN_DEFAULTS, STRATEGY_IDS, STRATEGY_LABEL, type Direction, type MarketAnalysis, type PatternSettings, type StrategyId, type StrategySignal } from "./patterns";
import { changedConfirmations, tradeConfirmations, type Confirmation, type TradeSetup } from "./confirmations";

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
  /** No new entries after this IST time (HH:MM). */
  entryCutoff: string;
  /** Which strategies may signal: the line break and the price-action add-ons. */
  strategies: Record<StrategyId, boolean>;
  /** Minutes after the session open that are analysis only: no new entries (30 = 09:15–09:45). */
  observationMinutes: number;
  /** Settings format: 2 = the 30-minute observation default (older saved settings had 15). */
  settingsVersion: number;
  /** Swing, pattern and breakout settings for the trendline, W and M strategies. */
  patterns: PatternSettings;
};

export const ALGO_DEFAULTS: AlgoConfig = {
  underlying: "NIFTY",
  mode: "PAPER",
  timeframe: "1m",
  expiry: "nearest",
  lots: 1,
  stop: { mode: "percent", value: 20 },
  target: { mode: "percent", value: 40 },
  maxDailyLoss: 5_000,
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
  entryCutoff: "15:00",
  strategies: { line: true, trendline: true, w: true, m: true },
  // The first 30 minutes read the opening structure and trendlines before any trade.
  observationMinutes: 30,
  settingsVersion: 2,
  patterns: PATTERN_DEFAULTS,
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

export type PendingEntry = { key: string; contract: ContractRef; side: Side; lots: number; quantity: number; signalTime: number; lineIds: string[]; explanation: string; uncertain: boolean; wallet?: "ALGO"; setup?: TradeSetup };

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
    Object.assign(state, { sessionDate: input.sessionDate, lastCandle: null, tradesToday: 0, realizedToday: 0, riskLocked: false, lastEntryAt: null });
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
      const lineEvaluation = evaluateCandle({ previous: index > 0 ? completed[index - 1] : null, candle, lines: input.lines, enabled: (line) => !config.disabledLines.includes(line.type), now });
      const evaluation = coordinate(lineEvaluation, completed.slice(0, index + 1), input, state);
      const signal = evaluation.decision === "CALL" || evaluation.decision === "PUT";
      const isLatest = candle === latest && (adapter.kind === "replay" || now - (candle.time + 60) <= FRESH_SECONDS);
      let outcome = evaluation.explanation;
      let kind: EventKind = "EVALUATION";
      let reasons: string[] | undefined;
      if (signal) {
        state.lastSignal = { time: candle.time, decision: evaluation.decision, explanation: evaluation.explanation };
        if (!isLatest) {
          reasons = ["Signal evaluated late (its candle closed more than two minutes ago); not traded."];
          outcome = `${evaluation.explanation} Not traded: evaluated late.`;
        } else {
          const result = await tryEntry(state, input, evaluation, log);
          outcome = `${evaluation.explanation} ${result.message}`;
          reasons = result.reasons;
          if (!result.ok) kind = "REJECTED";
        }
      } else if (evaluation.decision === "CONFLICTING_SIGNAL") {
        state.lastSignal = { time: candle.time, decision: evaluation.decision, explanation: evaluation.explanation };
        reasons = ["Conflicting signals"];
      }
      log({ key: `eval:${candle.time}`, time: candle.time, kind, message: outcome, evaluation, reasons });
    }
    if (latest && (state.lastCandle == null || latest.time > state.lastCandle)) state.lastCandle = latest.time;
  }

  await confirm(state, input, log);

  state.status = deriveStatus(state);
  return { state, events };
}

function dayStart(date: string) {
  return Math.floor(Date.parse(`${date}T03:45:00Z`) / 1000);
}

async function tryEntry(state: AlgoState, input: AdvanceInput, evaluation: CandleEvaluation, log: (event: Omit<AlgoEvent, "time"> & { time?: number }) => void): Promise<{ ok: boolean; message: string; reasons?: string[] }> {
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
  if (state.tradesToday >= config.maxTrades) reasons.push(`Daily trade limit reached (${config.maxTrades}).`);
  if (state.realizedToday <= -config.maxDailyLoss) { state.riskLocked = true; reasons.push("Daily loss limit reached (risk lock)."); }
  if (state.lastEntryAt != null && config.cooldownMinutes > 0 && now - state.lastEntryAt < config.cooldownMinutes * 60) reasons.push(`Cooling down (${config.cooldownMinutes} min between entries).`);
  const clock = istClock(evaluation.time + 60);
  const observationEnd = dayStart(input.sessionDate) + config.observationMinutes * 60;
  if (evaluation.time + 60 < observationEnd) reasons.push(`Observation period: the first ${config.observationMinutes} minutes (to ${istClock(observationEnd)} IST) are analysis only; no new entries.`);
  else if (clock > config.entryCutoff) reasons.push(`Outside the entry window (${istClock(observationEnd)}–${config.entryCutoff} IST).`);
  const problem = protectiveProblem(config.stop, config.target);
  if (problem) reasons.push(problem);
  if (!Number.isInteger(config.lots) || config.lots < 1) reasons.push("Quantity must be a whole number of lots.");
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
  const quantity = config.lots * contract.lotSize;
  const price = money(contract.ask + config.slippageTicks * TICK);
  const charges = adapter.charges("BUY", price, quantity);
  const cost = price * quantity + charges;
  const cash = await adapter.cash();
  if (cost > cash) return reject(state, evaluation.time, key, [`Insufficient buying power: needs ₹${money(cost)}, has ₹${money(cash)}.`], log);
  const levels = protectiveLevels(price, config.stop, config.target);
  if (!levels.ok) return reject(state, evaluation.time, key, [levels.reason], log);

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
    openPosition(state, { key, contract: ref, side, lots: config.lots, quantity, signalTime: evaluation.time, lineIds, explanation: evaluation.explanation, uncertain: false, setup: setupOf(evaluation, side) }, fill, input);
    const position = state.position!;
    const message = `${label} selected. Entry accepted: ${fill.quantity} @ ₹${fill.price}${fill.status === "PARTIAL" ? ` (partial fill of ${quantity})` : ""}. Stop ₹${position.stop}, target ₹${position.target}.`;
    state.lastOrder = { time: now, status: fill.status, message };
    log({ key: `entry:${key}`, time: evaluation.time, kind: "ENTRY", message, contract: { ...ref, bid: contract.bid, ask: contract.ask }, side, order: { key, status: fill.status, quantity: fill.quantity, price: fill.price, charges: fill.charges }, stop: position.stop, target: position.target, ...(position.setup ? { setup: position.setup } : {}) });
    return { ok: true, message: `${label} selected. Entry accepted.` };
  }
  if (fill.status === "PENDING" || fill.status === "UNKNOWN") {
    state.pending = { key, contract: ref, side, lots: config.lots, quantity, signalTime: evaluation.time, lineIds, explanation: evaluation.explanation, uncertain: fill.status === "UNKNOWN", setup: setupOf(evaluation, side) };
    if (fill.status === "UNKNOWN") state.recovery = `The ${label} entry may or may not have been placed (${fill.reason}). It is being reconciled; it will not be re-sent.`;
    const message = fill.status === "UNKNOWN" ? `${label}: order outcome unknown; reconciling before any retry.` : `${label}: order pending.`;
    state.lastOrder = { time: now, status: fill.status, message };
    log({ key: `entry:${key}`, time: evaluation.time, kind: fill.status === "UNKNOWN" ? "ERROR" : "INFO", message, contract: ref, side, order: { key, status: fill.status } });
    return { ok: true, message };
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
  const stop = levels.ok ? levels.stop : money(fill.price * 0.5);
  const target = levels.ok ? levels.target : money(fill.price * 1.5);
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
  if (trigger) await startExit(state, input, trigger.reason, trigger, log);
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
  const pnl = money((fill.price - position.avg) * quantity - entryCharges - fill.charges);
  state.realizedToday = money(state.realizedToday + pnl);
  position.quantity -= quantity;
  position.entryCharges -= entryCharges;
  const key = position.exit?.key ?? `${position.entryKey}:exit:${position.exitAttempts}`;
  const message = `Exit (${reason}) ${quantity} @ ₹${fill.price}${note ? `: ${note}` : ""}. Realized ₹${pnl}${position.quantity > 0 ? `; ${position.quantity} still open` : ""}.`;
  log({ key: `exit:${key}`, kind: "EXIT", message, contract: position.contract, side: position.side, order: { key, status: fill.status, quantity, price: fill.price, charges: fill.charges }, pnl, stop: position.stop, target: position.target });
  state.lastOrder = { time: input.now, status: position.quantity > 0 ? "PARTIAL" : "COMPLETED", message };
  if (position.quantity > 0) {
    // Partially closed: the rest is exited again on the next check (a new key: the first exit is known).
    position.exit = null;
  } else {
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
  const enabled = { ...ALGO_DEFAULTS.strategies, ...config.strategies };
  const lineDirection: Direction | null = enabled.line && (line.decision === "CALL" || line.decision === "PUT") ? line.decision : null;
  const previous = state.analysis?.strategies.line.lastSignal ?? null;
  const { analysis, signals } = analyzeMarket({
    candles,
    sessionOpen: dayStart(input.sessionDate),
    observationMinutes: config.observationMinutes,
    settings: { ...PATTERN_DEFAULTS, ...config.patterns },
    enabled,
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
    const crossed = line.events.filter((event) => (event.direction === "DOWN") === (lineDirection === "PUT"));
    const level = crossed[0]?.price ?? line.candle.close;
    all.unshift({ id: `line:${lineDirection}:${line.time}`, strategy: "line", direction: lineDirection, time: line.time, trigger: line.candle.close, level, invalidation: level, reason: line.explanation, volume: "NOT_REQUIRED" });
  }
  if (line.decision === "CONFLICTING_SIGNAL" && enabled.line) return { ...line, strategies: all };
  const directions = new Set(all.map((item) => item.direction));
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

/** The setup an entry is taken on: the first agreeing strategy's level and invalidation. */
function setupOf(evaluation: CandleEvaluation, side: Side): TradeSetup | undefined {
  const agreeing = (evaluation.strategies ?? []).filter((item) => item.direction === side);
  const primary = agreeing[0];
  if (!primary) return undefined;
  return { strategy: primary.strategy, strategies: agreeing.map((item) => item.strategy), direction: side, level: primary.level, invalidation: primary.invalidation, underlyingEntry: evaluation.candle.close, entryTime: evaluation.time + 60 };
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
