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
  SESSION_CLOSED: "Replay session closed",
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
  /** The trade the marker belongs to (its entry order key), to highlight both of its markers. */
  entryKey: string;
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
const signedRupee = (value: number) => `${value >= 0 ? "+" : "−"}${rupee(Math.abs(value))}`;

/**
 * Entry and exit markers at their simulated fill times (never past the replay time), one per trade
 * event, so a reprocessed candle never draws twice. Each carries its trade number out of the session
 * limit, the signal line, the contract, premiums, status and P&L (running while open).
 */
export function tradeMarkers(events: AlgoEvent[], cursor: number | null, options: { max?: number; open?: { entryKey: string; exitPending: boolean; unrealized: number | null } | null } = {}): TradeMarker[] {
  const max = options.max ?? 3;
  const open = options.open ?? null;
  const list: TradeMarker[] = [];
  for (const trade of algoTrades(events, open)) {
    const label = `T${trade.number}/${max}`;
    const contract = `${trade.underlying} ${trade.strike ?? ""} ${trade.right} · ${trade.expiry}`;
    const status = trade.status === "OPEN" ? `Open · running P&L ${open?.unrealized == null ? "—" : signedRupee(open.unrealized)}` : trade.status === "EXIT_PENDING" ? "Exit pending" : `Completed · realized ${trade.realized == null ? "—" : signedRupee(trade.realized)}`;
    list.push({
      id: `marker:${trade.entryKey}:entry`, entryKey: trade.entryKey, time: trade.entryTime, kind: "entry", side: trade.side, pnl: null,
      text: `${label} ${trade.side} BUY ${trade.strike ?? ""}${trade.right} @${rupee(trade.entryPremium)}`,
      detail: [
        `Trade ${trade.number}/${max} · BUY ${trade.side}`,
        `Signal ${ist(trade.signalTime + MINUTE)} IST${trade.lines.length ? ` · ${trade.lines.join(", ")}` : ""}`,
        trade.underlyingAtSignal != null ? `Underlying at the signal: ${trade.underlyingAtSignal.toFixed(2)}` : "",
        contract,
        `Entry ${ist(trade.entryTime)} IST · premium ${rupee(trade.entryPremium)} × ${trade.quantity}`,
        trade.stop != null && trade.target != null ? `Stop-loss ${rupee(trade.stop)} · Target ${rupee(trade.target)} (option premium)` : "",
        status,
      ].filter(Boolean),
    });
    if (trade.exitTime != null && trade.realized != null) {
      list.push({
        id: `marker:${trade.entryKey}:exit`, entryKey: trade.entryKey, time: trade.exitTime, kind: "exit", side: trade.side, pnl: trade.realized,
        text: `${label} EXIT ${trade.exitReason ?? ""} ${signedRupee(trade.realized)}${trade.returnPercent == null ? "" : ` (${trade.returnPercent >= 0 ? "+" : ""}${trade.returnPercent.toFixed(1)}%)`}`,
        detail: [
          `Trade ${trade.number}/${max} · exit (${trade.exitReason ?? "Exit"})`,
          `Exit ${ist(trade.exitTime)} IST · premium ${trade.exitPremium == null ? "—" : rupee(trade.exitPremium)} × ${trade.quantity}`,
          contract,
          `Realized ${signedRupee(trade.realized)}${trade.returnPercent == null ? "" : ` (${trade.returnPercent.toFixed(2)}%)`} after charges · ${trade.durationMinutes ?? "—"} min`,
        ],
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

export type RunDiagnostics = {
  /** The last candle the algo evaluated (its open time) and what happened on it. */
  lastCandle: number | null;
  lastOutcome: string;
  enabledLines: number;
  /** Lines compared on the last evaluated candle. */
  linesEvaluated: number;
  candlesEvaluated: number;
  crossings: number;
  signals: number;
  accepted: number;
  rejected: number;
  lastRejection: { time: number; reason: string } | null;
};

/** What the algo has processed so far, from its own log (shown so a quiet replay is never a mystery). */
export function runDiagnostics(events: AlgoEvent[], enabledLines: number): RunDiagnostics {
  const evaluations = events.filter((event) => event.evaluation && event.key.startsWith("eval:"));
  const last = evaluations.at(-1) ?? null;
  const rejections = events.filter((event) => event.kind === "REJECTED" && event.key.startsWith("eval:"));
  const latestRejection = rejections.at(-1) ?? null;
  return {
    lastCandle: last?.evaluation?.time ?? null,
    lastOutcome: last ? last.message : "Waiting for the first completed candle.",
    enabledLines,
    linesEvaluated: last?.evaluation?.evaluated ?? 0,
    candlesEvaluated: evaluations.length,
    crossings: evaluations.reduce((sum, event) => sum + (event.evaluation?.events.length ?? 0), 0),
    signals: evaluations.filter((event) => event.evaluation?.decision === "CALL" || event.evaluation?.decision === "PUT").length,
    accepted: events.filter((event) => event.kind === "ENTRY").length,
    rejected: rejections.length,
    lastRejection: latestRejection ? { time: latestRejection.time + MINUTE, reason: (latestRejection.reasons ?? [latestRejection.message]).join(" ") } : null,
  };
}

export type AlgoTrade = {
  /** 1-based entry number in the session (only filled entries count toward the limit). */
  number: number;
  entryKey: string;
  side: "CALL" | "PUT";
  contract: string;
  underlying: string;
  strike: number | null;
  right: string;
  expiry: string;
  lines: string[];
  signalTime: number;
  underlyingAtSignal: number | null;
  entryTime: number;
  entryPremium: number;
  quantity: number;
  lotSize: number | null;
  stop: number | null;
  target: number | null;
  status: "OPEN" | "EXIT_PENDING" | "COMPLETED";
  exitTime: number | null;
  exitPremium: number | null;
  exitReason: string | null;
  realized: number | null;
  returnPercent: number | null;
  durationMinutes: number | null;
  /** Simulated charges of the entry fill and of the exit fills (₹). */
  entryCharges: number;
  exitCharges: number;
  /** The crossed lines' prices (underlying), for highlighting them on the chart. */
  linePrices: number[];
  direction: "UP" | "DOWN" | null;
};

/**
 * The session's trades, in entry order: each filled entry is one trade (rejected signals never take a
 * slot), with its exit fills added up (a partial exit leaves it open).
 */
export function algoTrades(events: AlgoEvent[], open: { entryKey: string; exitPending: boolean } | null): AlgoTrade[] {
  const signal = (time: number) => events.find((event) => event.evaluation && event.evaluation.time === time && event.key.startsWith("eval:"))?.evaluation ?? null;
  const trades: AlgoTrade[] = [];
  for (const event of events) {
    if (event.kind !== "ENTRY" || !event.order || event.order.price == null || !event.side) continue;
    if (trades.some((trade) => trade.entryKey === event.order!.key)) continue;
    const evaluation = event.key.startsWith("entry:") ? signal(event.time) : null;
    const contract = event.contract;
    trades.push({
      number: trades.length + 1,
      entryKey: event.order.key,
      side: event.side,
      contract: contract ? `${contract.underlying} ${contract.strike} ${contract.right} · ${contract.expiry}` : "—",
      underlying: contract?.underlying ?? "",
      strike: contract?.strike ?? null,
      right: contract?.right ?? "",
      expiry: contract?.expiry ?? "",
      lines: evaluation?.events.map((cross) => cross.label) ?? [],
      linePrices: evaluation?.events.map((cross) => cross.price) ?? [],
      direction: evaluation?.events[0]?.direction ?? null,
      entryCharges: event.order.charges ?? 0,
      exitCharges: 0,
      signalTime: evaluation?.time ?? event.time,
      underlyingAtSignal: evaluation?.candle.close ?? null,
      entryTime: entryFillTime(event),
      entryPremium: event.order.price,
      quantity: event.order.quantity ?? 0,
      lotSize: contract?.lotSize ?? null,
      stop: event.stop ?? null,
      target: event.target ?? null,
      status: "COMPLETED",
      exitTime: null,
      exitPremium: null,
      exitReason: null,
      realized: null,
      returnPercent: null,
      durationMinutes: null,
    });
  }
  for (const trade of trades) {
    const exits = events.filter((event) => event.kind === "EXIT" && event.order?.key.startsWith(`${trade.entryKey}:exit`) && event.pnl != null);
    if (exits.length) {
      const last = exits.at(-1)!;
      const sold = exits.reduce((sum, event) => sum + (event.order?.quantity ?? 0), 0);
      trade.exitTime = last.time;
      trade.exitPremium = sold ? Math.round((exits.reduce((sum, event) => sum + (event.order?.price ?? 0) * (event.order?.quantity ?? 0), 0) / sold) * 100) / 100 : last.order?.price ?? null;
      trade.exitReason = EXIT_LABEL[exitReasonOf(last.message)] ?? "Exit";
      trade.realized = Math.round(exits.reduce((sum, event) => sum + (event.pnl ?? 0), 0) * 100) / 100;
      const cost = trade.entryPremium * trade.quantity;
      trade.returnPercent = cost ? Math.round((trade.realized / cost) * 10_000) / 100 : null;
      trade.durationMinutes = Math.round((last.time - trade.entryTime) / MINUTE);
      trade.exitCharges = Math.round(exits.reduce((sum, event) => sum + (event.order?.charges ?? 0), 0) * 100) / 100;
    }
    if (open && open.entryKey === trade.entryKey) trade.status = open.exitPending ? "EXIT_PENDING" : "OPEN";
  }
  return trades;
}

export type SkippedSignal = { id: string; time: number; side: "CALL" | "PUT" | null; reason: string; lines: string[] };

/** Signals that did not become trades (rejected or conflicting), newest first, with their reasons. */
export function skippedSignals(events: AlgoEvent[]): SkippedSignal[] {
  const list: SkippedSignal[] = [];
  for (const event of events) {
    if (!event.key.startsWith("eval:") || !event.evaluation) continue;
    const decision = event.evaluation.decision;
    const side = decision === "CALL" || decision === "PUT" ? decision : null;
    const lines = event.evaluation.events.map((cross) => `${cross.label} ${cross.direction === "DOWN" ? "↓" : "↑"}`);
    if (event.kind === "REJECTED") list.push({ id: event.key, time: event.time + MINUTE, side, reason: (event.reasons ?? [event.message]).join(" "), lines });
    else if (decision === "CONFLICTING_SIGNAL") list.push({ id: event.key, time: event.time + MINUTE, side: null, reason: event.evaluation.explanation, lines });
    else if (side && event.reasons?.length) list.push({ id: event.key, time: event.time + MINUTE, side, reason: event.reasons.join(" "), lines });
  }
  return list.sort((a, b) => b.time - a.time);
}

export type TimelineEvent = { id: string; time: number; kind: "signal" | "order" | "opened" | "exit" | "closed" | "rejected" | "info"; text: string };

/** One trade's recorded events, oldest first: its signal, the order and fill, exit attempts and fills. */
export function tradeTimeline(events: AlgoEvent[], entryKey: string): TimelineEvent[] {
  const list: TimelineEvent[] = [];
  const entry = events.find((event) => event.kind === "ENTRY" && event.order?.key === entryKey);
  if (!entry) return list;
  const evaluation = entry.key.startsWith("entry:") ? events.find((event) => event.key === `eval:${entry.time}`)?.evaluation : null;
  if (evaluation) {
    list.push({ id: `signal:${entryKey}`, time: evaluation.time + MINUTE, kind: "signal", text: `${evaluation.decision} signal on the ${ist(evaluation.time)} candle: ${evaluation.explanation}` });
  }
  const fillTime = entryFillTime(entry);
  list.push({ id: `order:${entryKey}`, time: fillTime, kind: "order", text: `BUY order ${entry.order?.status ?? "FILLED"} (simulated): ${entry.order?.quantity ?? "—"} @ ${entry.order?.price != null ? rupee(entry.order.price) : "—"}${entry.order?.charges != null ? `, charges ${rupee(entry.order.charges)}` : ""}.` });
  list.push({ id: `opened:${entryKey}`, time: fillTime, kind: "opened", text: `Position opened. Stop-loss ${entry.stop != null ? rupee(entry.stop) : "—"}, target ${entry.target != null ? rupee(entry.target) : "—"} (option premium).` });
  for (const event of events) {
    if (!event.order?.key.startsWith(`${entryKey}:exit`)) continue;
    if (event.kind === "EXIT") {
      list.push({ id: `exit:${event.key}`, time: event.time, kind: "exit", text: event.message.replace(/ Realized .*$/, "") });
      list.push({ id: `closed:${event.key}`, time: event.time, kind: "closed", text: `SELL ${event.order.quantity ?? ""} @ ${event.order.price != null ? rupee(event.order.price) : "—"} (simulated). Realized ${event.pnl != null ? signedRupee(event.pnl) : "—"} after charges.` });
    } else {
      list.push({ id: `exit-attempt:${event.key}`, time: event.time, kind: event.kind === "ERROR" ? "rejected" : "info", text: event.message });
    }
  }
  return list.sort((a, b) => a.time - b.time);
}

export type SlotState = { number: number; state: "Waiting" | "Order pending" | "Open" | "Exit pending" | "Completed" | "Rejected"; trade: AlgoTrade | null; reason: string | null; time: number | null };

/**
 * The session's entry slots (the trade limit). Filled entries take slots in order; the next empty slot
 * shows a pending order, or the latest signal rejected after the last entry, with its reason.
 */
export function tradeSlots(trades: AlgoTrade[], skipped: SkippedSignal[], pending: boolean, max: number): SlotState[] {
  const lastEntry = trades.at(-1)?.entryTime ?? 0;
  const rejectedSince = skipped.filter((row) => row.time > lastEntry).sort((a, b) => b.time - a.time)[0] ?? null;
  return Array.from({ length: max }, (_, index): SlotState => {
    const trade = trades[index] ?? null;
    if (trade) return { number: index + 1, trade, reason: null, time: trade.entryTime, state: trade.status === "OPEN" ? "Open" : trade.status === "EXIT_PENDING" ? "Exit pending" : "Completed" };
    if (index === trades.length && pending) return { number: index + 1, trade: null, reason: null, time: null, state: "Order pending" };
    if (index === trades.length && rejectedSince) return { number: index + 1, trade: null, reason: rejectedSince.reason, time: rejectedSince.time, state: "Rejected" };
    return { number: index + 1, trade: null, reason: null, time: null, state: "Waiting" };
  });
}

export type ActivityItem = { id: string; time: number; kind: "signal" | "opened" | "closed" | "rejected" | "info"; side: "CALL" | "PUT" | null; trade: number | null; text: string; pnl: number | null };

/** Everything the algo did, newest first, each tagged with its trade number where it belongs to one. */
export function activityFeed(events: AlgoEvent[]): ActivityItem[] {
  const trades = algoTrades(events, null);
  const numberOf = (key: string | undefined) => (key ? trades.find((trade) => key === trade.entryKey || key.startsWith(`${trade.entryKey}:exit`))?.number ?? null : null);
  const list: ActivityItem[] = [];
  for (const event of events) {
    const decision = event.evaluation?.decision;
    const signalSide = decision === "CALL" || decision === "PUT" ? decision : null;
    if (event.key.startsWith("eval:") && event.kind === "EVALUATION" && signalSide) {
      list.push({ id: event.key, time: event.time + MINUTE, kind: "signal", side: signalSide, trade: null, text: event.evaluation?.explanation ?? event.message, pnl: null });
    } else if (event.key.startsWith("eval:") && event.kind === "REJECTED") {
      list.push({ id: event.key, time: event.time + MINUTE, kind: "rejected", side: signalSide, trade: null, text: `Signal not traded: ${(event.reasons ?? [event.message]).join(" ")}`, pnl: null });
    } else if (event.kind === "ENTRY" && event.order) {
      list.push({ id: event.key, time: entryFillTime(event), kind: "opened", side: event.side ?? null, trade: numberOf(event.order.key), text: `BUY ${event.side ?? ""} ${event.contract ? `${event.contract.strike} ${event.contract.right}` : ""} × ${event.order.quantity ?? "—"} @ ${event.order.price != null ? rupee(event.order.price) : "—"}: position opened`, pnl: null });
    } else if (event.kind === "EXIT" && event.order) {
      list.push({ id: event.key, time: event.time, kind: "closed", side: event.side ?? null, trade: numberOf(event.order.key), text: `${EXIT_LABEL[exitReasonOf(event.message)] ?? "Exit"}: SELL × ${event.order.quantity ?? "—"} @ ${event.order.price != null ? rupee(event.order.price) : "—"}, position closed`, pnl: event.pnl ?? null });
    } else if ((event.kind === "ERROR" || event.kind === "INFO") && !event.key.startsWith("eval:") && !event.key.startsWith("reject:")) {
      list.push({ id: event.key, time: event.time, kind: event.kind === "ERROR" ? "rejected" : "info", side: event.side ?? null, trade: numberOf(event.order?.key), text: event.message, pnl: null });
    }
  }
  // Newest first; within one minute the later step first (a fill above the signal that caused it).
  const rank: Record<ActivityItem["kind"], number> = { closed: 4, opened: 3, rejected: 2, signal: 1, info: 0 };
  return list.sort((a, b) => b.time - a.time || rank[b.kind] - rank[a.kind] || (a.id < b.id ? 1 : -1));
}
