import type { AlgoEvent } from "./runner";

/**
 * The Algo inside the chart's replay: pure rules shared by the server (which executes) and the chart
 * (which asks for confirmation). The replay clock is the only clock: a minute is processed once its
 * candle has completed at the replay time, minutes are processed in order and never twice, and a replay
 * moved back before the last processed minute cannot reprocess (it needs a new, isolated session).
 */

export const MINUTE = 60;

/** Minute ends after `processedThrough` up to the replay cursor (and the session close), oldest first. */
export function minuteEnds(processedThrough: number, cursor: number, sessionOpen: number, sessionClose: number): number[] {
  const last = Math.min(Math.floor(cursor / MINUTE) * MINUTE, sessionClose);
  const first = Math.max(Math.floor(processedThrough / MINUTE) * MINUTE + MINUTE, sessionOpen + MINUTE);
  const ends: number[] = [];
  for (let end = first; end <= last; end += MINUTE) ends.push(end);
  return ends;
}

/**
 * A simulated fill must be a price the contract actually traded at in that minute: the requested price
 * (a stop or target level, or the close plus slippage) is kept inside the candle's low–high range and
 * rounded to the 0.05 tick.
 */
export function clampFill(price: number, candle: { low: number; high: number }) {
  const inside = Math.min(candle.high, Math.max(candle.low, price));
  return Math.round(Math.round(inside / 0.05) * 0.05 * 100) / 100;
}

export type PlayGate =
  /** The algo is off: ordinary chart replay, no confirmation. */
  | { kind: "free" }
  /** The algo is on: playback waits for an explicit "Start Algo & Replay". */
  | { kind: "confirm"; skippedMinutes: number }
  /** The replay sits before minutes the algo already processed: resume from there, reset, or cancel. */
  | { kind: "behind"; processedThrough: number };

/** What pressing Play needs, given the algo switch and the run's progress in this replay session. */
export function playGate(input: { algoEnabled: boolean; cursor: number; processedThrough: number | null }): PlayGate {
  if (!input.algoEnabled) return { kind: "free" };
  if (input.processedThrough != null && Math.floor(input.cursor / MINUTE) * MINUTE < input.processedThrough) return { kind: "behind", processedThrough: input.processedThrough };
  const skipped = input.processedThrough == null ? 0 : Math.max(0, Math.floor(input.cursor / MINUTE) - Math.floor(input.processedThrough / MINUTE) - 1);
  return { kind: "confirm", skippedMinutes: skipped };
}

export type RunStats = {
  signals: number;
  accepted: number;
  rejected: number;
  trades: number;
  wins: number;
  losses: number;
  realized: number;
  maxDrawdown: number;
  exits: Record<string, number>;
};

const EXIT_REASON = /^Exit \(([A-Z_]+)\)/;

/** Session figures from the run's own log (closed trades are counted once, by their exit events). */
export function runStats(events: AlgoEvent[]): RunStats {
  const stats: RunStats = { signals: 0, accepted: 0, rejected: 0, trades: 0, wins: 0, losses: 0, realized: 0, maxDrawdown: 0, exits: {} };
  let peak = 0;
  const byEntry = new Map<string, number>();
  const ordered = [...events].sort((a, b) => a.time - b.time);
  for (const event of ordered) {
    const decision = event.evaluation?.decision;
    if (decision === "CALL" || decision === "PUT") stats.signals += 1;
    if (event.kind === "ENTRY") stats.accepted += 1;
    if (event.kind === "REJECTED") stats.rejected += 1;
    if (event.kind === "EXIT" && event.pnl != null) {
      stats.realized = Math.round((stats.realized + event.pnl) * 100) / 100;
      peak = Math.max(peak, stats.realized);
      stats.maxDrawdown = Math.max(stats.maxDrawdown, Math.round((peak - stats.realized) * 100) / 100);
      const entry = event.order?.key.replace(/:exit:\d+$/, "") ?? event.key;
      byEntry.set(entry, (byEntry.get(entry) ?? 0) + event.pnl);
      const reason = EXIT_REASON.exec(event.message)?.[1] ?? "OTHER";
      stats.exits[reason] = (stats.exits[reason] ?? 0) + 1;
    }
  }
  for (const pnl of byEntry.values()) {
    stats.trades += 1;
    if (pnl > 0) stats.wins += 1;
    else if (pnl < 0) stats.losses += 1;
  }
  return stats;
}

/** Plain-language exit reasons. */
export const EXIT_LABEL: Record<string, string> = {
  STOP: "Stop-loss",
  TARGET: "Target",
  MANUAL: "Manual exit",
  EMERGENCY: "Emergency stop",
  SESSION_END: "Session end",
  OPPOSITE_SIGNAL: "Opposite signal",
  RISK: "Risk limit",
};

const exitReasonOf = (message: string) => EXIT_REASON.exec(message)?.[1] ?? "OTHER";
/** When an entry filled: at the close of its signal candle (a reconciled entry carries its own time). */
export const entryFillTime = (event: AlgoEvent) => (event.key.startsWith("entry:") ? event.time + MINUTE : event.time);

export type OrderRow = {
  id: string;
  time: number;
  contract: string;
  side: "CALL" | "PUT" | null;
  action: "BUY" | "SELL" | "—";
  quantity: number | null;
  premium: number | null;
  status: string;
  pnl: number | null;
  reason: string;
  group: "active" | "completed" | "rejected";
};

/**
 * The run's orders, newest first, from its own log: entries (BUY), exits (SELL), pending or unknown
 * orders, and rejected signals with their reasons. An entry is active while its position is open.
 */
export function algoOrders(events: AlgoEvent[], openEntryKey: string | null): OrderRow[] {
  const rows: OrderRow[] = [];
  const label = (event: AlgoEvent) => (event.contract ? `${event.contract.underlying} ${event.contract.strike} ${event.contract.right} · ${event.contract.expiry}` : "—");
  for (const event of events) {
    if (event.kind === "ENTRY" && event.order) {
      rows.push({ id: event.key, time: entryFillTime(event), contract: label(event), side: event.side ?? null, action: "BUY", quantity: event.order.quantity ?? null, premium: event.order.price ?? null, status: event.order.status, pnl: null, reason: event.message, group: event.order.key === openEntryKey ? "active" : "completed" });
    } else if (event.kind === "EXIT" && event.order) {
      rows.push({ id: event.key, time: event.time, contract: label(event), side: event.side ?? null, action: "SELL", quantity: event.order.quantity ?? null, premium: event.order.price ?? null, status: event.order.status, pnl: event.pnl ?? null, reason: EXIT_LABEL[exitReasonOf(event.message)] ?? "Exit", group: "completed" });
    } else if (event.kind === "REJECTED" && !event.key.startsWith("reject:")) {
      // One row per rejected signal: the candle's evaluation carries the outcome and every reason.
      const decision = event.evaluation?.decision;
      const side = event.side ?? (decision === "CALL" || decision === "PUT" ? decision : null);
      rows.push({ id: event.key, time: event.time + MINUTE, contract: event.contract ? label(event) : side ? `ATM ${side} (not placed)` : "—", side, action: event.key.includes(":exit:") ? "SELL" : "BUY", quantity: null, premium: null, status: "REJECTED", pnl: null, reason: (event.reasons ?? [event.message]).join(" "), group: "rejected" });
    } else if (event.order && (event.order.status === "PENDING" || event.order.status === "UNKNOWN" || event.order.status === "REJECTED")) {
      rows.push({ id: event.key, time: event.time, contract: label(event), side: event.side ?? null, action: event.order.key.includes(":exit:") ? "SELL" : "BUY", quantity: null, premium: null, status: event.order.status, pnl: null, reason: event.message, group: event.order.status === "REJECTED" ? "rejected" : "active" });
    }
  }
  return rows.sort((a, b) => b.time - a.time);
}

export type TradeMarker = {
  id: string;
  time: number;
  kind: "entry" | "exit";
  side: "CALL" | "PUT";
  text: string;
  /** Plain-language details for the marker's popover. */
  detail: string[];
  pnl: number | null;
};

const ist = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16);
const rupee = (value: number) => `₹${value.toFixed(2)}`;

/**
 * Entry and exit markers at their simulated fill times (never past the replay time). One marker per
 * event key, so a reprocessed candle never draws twice.
 */
export function tradeMarkers(events: AlgoEvent[], cursor: number | null): TradeMarker[] {
  const seen = new Set<string>();
  const entries = new Map(events.filter((event) => event.kind === "ENTRY" && event.order).map((event) => [event.order!.key, event]));
  const signalClose = (time: number) => events.find((event) => event.evaluation && event.evaluation.time === time)?.evaluation?.candle.close ?? null;
  const list: TradeMarker[] = [];
  for (const event of events) {
    if (seen.has(event.key)) continue;
    if (event.kind === "ENTRY" && event.order?.price != null && event.side) {
      seen.add(event.key);
      const time = entryFillTime(event);
      const contract = event.contract ? `${event.contract.underlying} ${event.contract.strike} ${event.contract.right} · ${event.contract.expiry}` : "";
      const underlying = signalClose(event.time);
      list.push({
        id: event.key, time, kind: "entry", side: event.side, pnl: null,
        text: `${event.side} BUY ${event.contract?.strike ?? ""}${event.contract?.right ?? ""} @${rupee(event.order.price)}`,
        detail: [`${event.side} BUY at ${ist(time)} IST`, contract, underlying != null ? `Underlying at the signal: ${underlying.toFixed(2)}` : "", `Entry premium ${rupee(event.order.price)} × ${event.order.quantity ?? "—"}`, event.stop != null && event.target != null ? `Stop-loss ${rupee(event.stop)} · Target ${rupee(event.target)} (option premium)` : ""].filter(Boolean),
      });
    }
    if (event.kind === "EXIT" && event.order?.price != null && event.pnl != null) {
      seen.add(event.key);
      const entry = entries.get(event.order.key.replace(/:exit:\d+$/, ""));
      const cost = entry?.order?.price != null && event.order.quantity ? entry.order.price * event.order.quantity : null;
      const percent = cost ? (event.pnl / cost) * 100 : null;
      const reason = EXIT_LABEL[exitReasonOf(event.message)] ?? "Exit";
      const signed = `${event.pnl >= 0 ? "+" : "−"}${rupee(Math.abs(event.pnl))}${percent == null ? "" : ` (${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%)`}`;
      list.push({
        id: event.key, time: event.time, kind: "exit", side: entry?.side ?? event.side ?? "CALL", pnl: event.pnl,
        text: `EXIT ${reason} ${signed}`,
        detail: [`Exit (${reason}) at ${ist(event.time)} IST`, event.contract ? `${event.contract.underlying} ${event.contract.strike} ${event.contract.right} · ${event.contract.expiry}` : "", `Exit premium ${rupee(event.order.price)} × ${event.order.quantity ?? "—"}`, `Realized ${signed} after charges`].filter(Boolean),
      });
    }
  }
  return cursor == null ? list : list.filter((marker) => marker.time <= cursor);
}

/**
 * Long-option valuation at a premium: entry cost = average × open quantity (the quantity already includes
 * the lot size), value = premium × quantity, unrealized = value − entry cost − the entry charges still
 * attributed to the open quantity, and its percentage of the entry cost.
 */
export function positionValuation(position: { avg: number; quantity: number; entryCharges: number }, premium: number | null) {
  const round = (value: number) => Math.round(value * 100) / 100;
  const invested = round(position.avg * position.quantity);
  if (premium == null) return { invested, value: null, unrealized: null, unrealizedPercent: null };
  const value = round(premium * position.quantity);
  const unrealized = round(value - invested - position.entryCharges);
  return { invested, value, unrealized, unrealizedPercent: invested ? round((unrealized / invested) * 100) : null };
}
