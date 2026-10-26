import type { AlgoConfig, AlgoEvent, AlgoState } from "./runner";
import type { AlgoTrade } from "./chart-replay";

/**
 * Mathi Strategy in live demo (live-price paper) mode: each time the strategy is switched ON a new activation
 * session starts with its own allowance of entries (the strategy's trades-per-session limit, 3). The server's
 * stored state is the only source of truth: the entry count is the runner's own count of filled entries, so a
 * rejected or failed order, a repeated tick or a reconnect never uses a slot. Pure rules, shared by the server
 * (which executes) and the panel (which shows them).
 */

export type ActivationEnd = "STOPPED" | "LIMIT" | "DAY_END";

export type Activation = {
  id: string;
  /** Switched ON (unix seconds). */
  startedAt: number;
  /** Switched OFF, the limit reached with nothing open, or the market day over; null while it runs. */
  endedAt: number | null;
  end: ActivationEnd | null;
  /** Filled entries in this activation (a slot is used on the entry fill, never on a signal or a rejection). */
  entries: number;
  /** The "3 trades completed" notice was logged (once per activation). */
  limitNotified?: boolean;
};

export type LiveStatus = "STOPPED" | "RUNNING" | "POSITION_OPEN" | "POSITION_OPEN_STOPPED" | "LIMIT_REACHED" | "WAITING_FOR_DATA" | "ERROR";

export const LIVE_STATUS_LABEL: Record<LiveStatus, string> = {
  STOPPED: "STOPPED",
  RUNNING: "RUNNING",
  POSITION_OPEN: "POSITION OPEN",
  POSITION_OPEN_STOPPED: "POSITION OPEN — STRATEGY STOPPED",
  LIMIT_REACHED: "LIMIT REACHED",
  WAITING_FOR_DATA: "WAITING FOR DATA",
  ERROR: "ERROR",
};

export const LIMIT_NOTICE = (max: number) => `Mathi Strategy: ${max} trades completed. New entries stopped.`;

/** Earlier activations kept in the state (newest first); their orders and trades stay in the event log. */
const KEEP = 30;

const istDay = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(0, 10);

/** Switches the strategy ON: a new activation with no entries used. The daily loss lock and an open position stay. */
export function startActivation(state: AlgoState, now: number, id: string, sessionDate: string, max: number): AlgoEvent[] {
  const events = state.activation && state.activation.endedAt == null ? endActivation(state, now, "STOPPED") : [];
  state.activation = { id, startedAt: now, endedAt: null, end: null, entries: 0 };
  // Only the entry count is per activation; the realized loss (daily loss lock) is per day and is kept.
  Object.assign(state, { running: true, entries: true, sessionDate, tradesToday: 0, lastCandle: null, awaiting: null, formingEntry: null });
  events.push({ key: `activation:${id}`, time: now, kind: "INFO", message: `Mathi Strategy ON — session ${id} started. Entries used 0 / ${max}; evaluating completed 1-minute candles from now (no earlier candle is traded).` });
  return events;
}

/**
 * Ends the current activation: no new entries from now (a waiting breakout is dropped). An open position is not
 * closed: TradeD keeps managing it to its exit, and it stays on the panel.
 */
export function endActivation(state: AlgoState, now: number, end: ActivationEnd): AlgoEvent[] {
  const activation = state.activation;
  Object.assign(state, { running: false, entries: false, awaiting: null });
  if (!activation || activation.endedAt != null) return [];
  activation.endedAt = now;
  activation.end = end;
  state.activations = [{ ...activation }, ...(state.activations ?? [])].slice(0, KEEP);
  const why = end === "LIMIT" ? "the entry limit was reached" : end === "DAY_END" ? "the market day ended" : "it was switched off";
  return [{ key: `activation-end:${activation.id}`, time: now, kind: "INFO", message: `Mathi Strategy session ${activation.id} ended: ${why}. Entries used ${activation.entries}.${state.position ? " The open position stays managed by its exit rules until it closes." : ""}` }];
}

/**
 * After every live tick: the entry count follows the runner's filled entries; the entries limit stops new
 * entries at once (an open trade is still managed), and with nothing left open the activation ends as LIMIT
 * REACHED with its notice logged once.
 */
export function afterLiveTick(state: AlgoState, config: Pick<AlgoConfig, "maxTrades">, now: number): AlgoEvent[] {
  const activation = state.activation;
  if (!activation || activation.endedAt != null) return [];
  activation.entries = Math.max(activation.entries, state.tradesToday);
  if (activation.entries < config.maxTrades) return [];
  state.entries = false;
  if (state.position || state.pending) return [];
  const events: AlgoEvent[] = [];
  if (!activation.limitNotified) {
    activation.limitNotified = true;
    events.push({ key: `limit:${activation.id}`, time: now, kind: "INFO", message: LIMIT_NOTICE(config.maxTrades) });
  }
  return [...events, ...endActivation(state, now, "LIMIT")];
}

/**
 * Before a live tick: an activation from an earlier market day ends (its allowance is for one session; switch
 * the strategy ON again for a new one), so a new day never trades on yesterday's switch.
 */
export function beforeLiveTick(state: AlgoState, today: string, now: number): AlgoEvent[] {
  const activation = state.activation;
  if (!activation || activation.endedAt != null || istDay(activation.startedAt) === today) return [];
  return endActivation(state, now, "DAY_END");
}

/** The panel's status: the state machine, from the stored state and the feed. */
export function liveStatus(state: AlgoState, config: Pick<AlgoConfig, "maxTrades">, feedStale: boolean): LiveStatus {
  if (state.recovery) return "ERROR";
  const activation = state.activation ?? null;
  const running = Boolean(activation && activation.endedAt == null && state.running);
  const limit = Boolean(activation && (activation.end === "LIMIT" || activation.entries >= config.maxTrades));
  if (state.position || state.pending) return running ? "POSITION_OPEN" : limit ? "LIMIT_REACHED" : "POSITION_OPEN_STOPPED";
  if (limit && (activation?.end === "LIMIT" || running)) return "LIMIT_REACHED";
  if (!running) return "STOPPED";
  return feedStale ? "WAITING_FOR_DATA" : "RUNNING";
}

/**
 * The trades entered in an activation (the source of truth is the event log's filled entries), by when each
 * entry was recorded: an entry on the candle completed just before the switch-on is recorded after it.
 */
export function activationTrades(trades: AlgoTrade[], activation: Pick<Activation, "startedAt" | "endedAt">, recordedAt: ReadonlyMap<string, number> = new Map()): AlgoTrade[] {
  return trades
    .filter((trade) => {
      const at = recordedAt.get(trade.entryKey) ?? trade.entryTime;
      return at >= activation.startedAt && (activation.endedAt == null || at <= activation.endedAt);
    })
    .map((trade, index) => ({ ...trade, number: index + 1 }));
}

export type ActivationSummary = {
  entriesUsed: number;
  max: number;
  completed: number;
  open: number;
  wins: number;
  losses: number;
  breakeven: number;
  realized: number;
  unrealized: number | null;
  total: number;
};

export function activationSummary(trades: AlgoTrade[], max: number, unrealized: number | null): ActivationSummary {
  const done = trades.filter((trade) => trade.status === "COMPLETED" && trade.realized != null);
  const realized = Math.round(done.reduce((sum, trade) => sum + trade.realized!, 0) * 100) / 100;
  const open = trades.length - done.length;
  return {
    entriesUsed: trades.length,
    max,
    completed: done.length,
    open,
    wins: done.filter((trade) => trade.realized! > 0).length,
    losses: done.filter((trade) => trade.realized! < 0).length,
    breakeven: done.filter((trade) => trade.realized === 0).length,
    realized,
    unrealized: open ? unrealized : null,
    total: Math.round((realized + (open ? unrealized ?? 0 : 0)) * 100) / 100,
  };
}

/** During market hours a running session sees a new completed 1-minute candle every minute. */
export function feedIsStale(lastCandle: number | null, startedAt: number | null, now: number): boolean {
  const minute = Math.floor(((now + 19_800) % 86_400) / 60);
  if (minute < 9 * 60 + 17 || minute > 15 * 60 + 30) return false;
  const since = lastCandle != null ? lastCandle + 60 : startedAt;
  return since != null && now - since > 180;
}
