import { algoTrades, confirmationEntryKey, entryFillTime, EXIT_LABEL, type AlgoTrade, type RunStats } from "./chart-replay";
import { STRATEGY_IDS, STRATEGY_LABEL } from "./patterns";
import { confirmationMode, type AlgoConfig, type AlgoEvent } from "./runner";

/**
 * The downloadable Algo trade report for one replay session: a CSV (opens in Excel / Sheets) with three
 * sections — the session summary, the trades, and the full flow (every candle evaluated, signal, order,
 * rejection, confirmation and exit, oldest first). Built only from the session's stored record.
 */

export type AlgoReportInput = {
  sessionId: string;
  underlying: string;
  date: string;
  status: string;
  endReason: string;
  startedAt: string;
  endedAt: string | null;
  startCapital: number;
  endCash: number | null;
  summary: { account?: { equity?: string; realized?: string; cashAvailable?: string } | null } | null;
  settings: AlgoConfig;
  stats: RunStats;
  events: AlgoEvent[];
};

const ist = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(11, 19);
const istDateTime = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 19_800_000).toISOString().replace("T", " ").slice(0, 19) : "");
const num = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? "" : value.toFixed(2));

/** One CSV cell: quoted when it contains a comma, quote or line break (quotes doubled). */
export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const row = (cells: unknown[]) => cells.map(csvCell).join(",");

/** The kind of a flow row, in plain words. */
function flowKind(event: AlgoEvent) {
  if (event.key.startsWith("confirm:")) return "Confirmation";
  if (event.kind === "EVALUATION") {
    const decision = event.evaluation?.decision;
    return decision === "CALL" || decision === "PUT" ? `${decision} signal` : decision === "CONFLICTING_SIGNAL" ? "Conflicting signals" : "Candle checked";
  }
  if (event.kind === "REJECTED") return "Signal rejected";
  if (event.kind === "ENTRY") return "Entry (BUY)";
  if (event.kind === "EXIT") return "Exit (SELL)";
  if (event.kind === "ERROR") return "Error";
  return "Info";
}

/** How a trade was bought: its signal candle, the line crossed and how much of the body went past it. */
function signalOf(trade: AlgoTrade, events: AlgoEvent[]) {
  const find = (time: number) => events.find((event) => event.evaluation && event.evaluation.time === time && (event.key.startsWith("eval:") || event.key.startsWith("eval-forming:")))?.evaluation ?? null;
  const confirming = trade.confirmedAt != null ? find(trade.confirmedAt) : null;
  const evaluation = find(trade.signalTime) ?? (confirming?.breakout ? { ...confirming, candle: confirming.breakout.candle } : null);
  const candle = confirming?.breakout?.candle ?? evaluation?.candle ?? null;
  const line = trade.linePrices[0] ?? null;
  const body = candle ? Math.abs(candle.close - candle.open) : 0;
  const past = candle && line != null ? (trade.side === "CALL" ? candle.close - line : line - candle.close) : null;
  return {
    evaluation,
    candle,
    line,
    pastPoints: past,
    bodyShare: past != null && body > 0 ? Math.round((past / body) * 1000) / 10 : null,
    reason: [confirming && evaluation !== confirming ? evaluation?.explanation : null, confirming?.explanation ?? evaluation?.explanation].filter(Boolean).join(" Then: ") || "",
    confirming,
  };
}

/** Gross P&L (premium gain × quantity, before charges) from the trade's exit fills. */
function grossOf(trade: AlgoTrade, events: AlgoEvent[]) {
  const exits = events.filter((event) => event.kind === "EXIT" && event.order?.key.startsWith(`${trade.entryKey}:exit`) && event.pnl != null);
  if (!exits.length) return null;
  return Math.round(exits.reduce((sum, event) => sum + (event.gross ?? ((event.order?.price ?? 0) - trade.entryPremium) * (event.order?.quantity ?? 0)), 0) * 100) / 100;
}

/** A trade's status: completed only with its exit fills; still open when the session ended is said so. */
export function tradeStatusLabel(trade: AlgoTrade, ended: boolean) {
  if (trade.status === "COMPLETED") return "Completed";
  if (trade.status === "EXIT_PENDING") return "Exit pending";
  return ended ? "OPEN AT REPLAY END" : "Open";
}

const CONFIRMATION_LABEL = { single: "Single candle (enter on the crossing candle)", hold: "Breakout hold (the next candle must close beyond the line)", retest: "Retest (a retest of the line must hold, then price moves on)" } as const;

/** Everything about one trade, as label / value rows (where and how it was bought, and how it ended). */
export function tradeRecord(trade: AlgoTrade, events: AlgoEvent[], settings: AlgoConfig, ended = false): Array<[string, string]> {
  const signal = signalOf(trade, events);
  const gross = grossOf(trade, events);
  const lots = trade.lotSize ? trade.quantity / trade.lotSize : null;
  const committed = trade.entryPremium * trade.quantity + trade.entryCharges;
  return [
    ["Trade", String(trade.number)],
    ["Direction", trade.side === "CALL" ? "BUY ATM CALL (CE) — line breakout" : "BUY ATM PUT (PE) — line breakdown"],
    ["Strategy", STRATEGY_LABEL[trade.strategy]],
    ["Line crossed", trade.lines.join("; ")],
    ["Line price", num(signal.line)],
    ["Signal candle (IST)", `${ist(trade.signalTime)}–${ist(trade.signalTime + 60)}`],
    ["Signal candle open", num(signal.candle?.open)],
    ["Signal candle high", num(signal.candle?.high)],
    ["Signal candle low", num(signal.candle?.low)],
    ["Signal candle close", num(signal.candle?.close)],
    ["Points past the line", num(signal.pastPoints)],
    ["Share of the body past the line (%)", signal.bodyShare == null ? "" : signal.bodyShare.toFixed(1)],
    ["Required share (%)", settings.crossRule === "body" ? String(settings.crossPercent || "any crossing") : "classic body crossing"],
    ["Breakout confirmation", CONFIRMATION_LABEL[confirmationMode(settings)]],
    ["Confirmation candle (IST)", trade.confirmedAt == null ? "None (entered on the signal candle)" : `${ist(trade.confirmedAt)}–${ist(trade.confirmedAt + 60)}`],
    ["Confirmation candle open / close", signal.confirming ? `${num(signal.confirming.candle.open)} / ${num(signal.confirming.candle.close)}` : ""],
    ["Why it entered", signal.reason],
    ["Underlying at signal", num(trade.underlyingAtSignal)],
    ["Option contract", `${trade.underlying} ${trade.strike ?? ""} ${trade.right}`],
    ["Expiry", trade.expiry],
    ["Lot size", trade.lotSize == null ? "" : String(trade.lotSize)],
    ["Lots", lots == null ? "" : String(lots)],
    ["Quantity (units)", String(trade.quantity)],
    ["Entry time (IST)", ist(trade.entryTime)],
    ["Entry premium per unit", num(trade.entryPremium)],
    ["Entry value (premium × quantity)", num(trade.entryPremium * trade.quantity)],
    ["Entry charges", num(trade.entryCharges)],
    ["Capital committed (value + charges)", num(committed)],
    ["Target premium per unit", num(trade.target)],
    ["Target rule", `${settings.target.value}${settings.target.mode === "percent" ? "% of the entry premium" : " Rs above the entry premium"}`],
    ["Stop-loss premium", trade.stop ? num(trade.stop) : "None (no stop-loss)"],
    ["Exit time (IST)", trade.exitTime ? ist(trade.exitTime) : ""],
    ["Exit premium per unit", num(trade.exitPremium)],
    ["Exit reason", trade.exitReason ?? (ended ? "Still open when the replay ended" : "Still open")],
    ["Exit charges", num(trade.exitCharges)],
    ["Gross P&L (before charges)", num(gross)],
    ["Total charges", num(trade.entryCharges + trade.exitCharges)],
    ["Net realized P&L (after charges)", num(trade.realized)],
    ["Return on the premium paid (%)", trade.returnPercent == null ? "" : trade.returnPercent.toFixed(2)],
    ["Duration (minutes)", trade.durationMinutes == null ? "" : String(trade.durationMinutes)],
    ["Max adverse premium move per unit", trade.adverse == null ? "" : num(trade.adverse)],
    ["Max adverse premium move (% of entry)", trade.adverse == null || !trade.entryPremium ? "" : ((trade.adverse / trade.entryPremium) * 100).toFixed(2)],
    ["Status", tradeStatusLabel(trade, ended)],
  ];
}

/** One trade's own download: the session, the full trade record, then every event of that trade. */
export function algoTradeCsv(report: AlgoReportInput, entryKey: string): string {
  const trades = algoTrades(report.events, null);
  const trade = trades.find((item) => item.entryKey === entryKey);
  if (!trade) return `﻿${row(["Trade not found in this session."])}\r\n`;
  const lines: string[] = [];
  lines.push(row(["TradeD Algo trade", "Simulated replay trading (no broker orders)"]));
  lines.push(row(["Session", report.sessionId]));
  lines.push(row(["Underlying", report.underlying]));
  lines.push(row(["Replay date", report.date]));
  lines.push("");
  lines.push(row(["TRADE DETAILS"]));
  for (const [label, value] of tradeRecord(trade, report.events, report.settings, report.status === "ENDED")) lines.push(row([label, value]));
  lines.push("");
  lines.push(row(["TRADE EVENTS"]));
  lines.push(row(["Time (IST)", "Event", "Option", "Order", "Quantity", "Premium", "Charges", "P&L", "Details"]));
  const mine = report.events.filter((event) => event.order?.key === entryKey || event.order?.key?.startsWith(`${entryKey}:exit`) || confirmationEntryKey(event.key) === entryKey || (event.key.startsWith("eval") && event.evaluation?.time === trade.signalTime));
  for (const event of mine.sort((a, b) => a.time - b.time)) {
    lines.push(row([
      ist(event.kind === "ENTRY" ? entryFillTime(event) : event.key.startsWith("eval") ? event.time + 60 : event.time), flowKind(event),
      event.contract ? `${event.contract.underlying} ${event.contract.strike} ${event.contract.right} ${event.contract.expiry}` : "",
      event.order ? `${event.kind === "EXIT" ? "SELL" : event.kind === "ENTRY" ? "BUY" : ""} ${event.order.status}`.trim() : "",
      event.order?.quantity ?? "", num(event.order?.price), num(event.order?.charges), num(event.pnl), event.message,
    ]));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** A safe file name for one trade's download. */
export function algoTradeName(report: Pick<AlgoReportInput, "underlying" | "date" | "sessionId">, number: number) {
  return algoReportName(report).replace(/\.csv$/, `-trade-${number}.csv`);
}

export function algoReportCsv(report: AlgoReportInput): string {
  const trades = algoTrades(report.events, null);
  const numberOf = (key: string | null | undefined) => (key ? trades.find((trade) => key === trade.entryKey || key.startsWith(`${trade.entryKey}:exit`))?.number ?? "" : "");
  const settings = report.settings;
  const lines: string[] = [];

  lines.push(row(["TradeD Algo trade report", "Simulated replay trading (no broker orders)"]));
  lines.push(row(["Session", report.sessionId]));
  lines.push(row(["Underlying", report.underlying]));
  lines.push(row(["Replay date", report.date]));
  lines.push(row(["Started (IST)", istDateTime(report.startedAt)]));
  lines.push(row(["Ended (IST)", istDateTime(report.endedAt)]));
  lines.push(row(["Status", report.status === "ENDED" ? `Ended (${report.endReason || "—"})` : "In progress"]));
  lines.push(row(["Starting capital", num(report.startCapital)]));
  lines.push(row(["End cash", num(report.endCash)]));
  lines.push(row(["Final equity", report.summary?.account?.equity ?? ""]));
  lines.push(row(["Realized P&L", num(report.stats.realized)]));
  lines.push(row(["Trades", `${trades.length}/${settings.maxTrades}`]));
  lines.push(row(["Wins / losses", `${report.stats.wins} / ${report.stats.losses}`]));
  lines.push(row(["Max drawdown", num(report.stats.maxDrawdown)]));
  lines.push(row(["Signals / accepted / rejected", `${report.stats.signals} / ${report.stats.accepted} / ${report.stats.rejected}`]));
  lines.push(row(["Breakouts detected / false breakouts cancelled / expired", `${report.stats.detected ?? 0} / ${report.stats.falseBreakouts ?? 0} / ${report.stats.expired ?? 0}`]));
  lines.push(row(["Breakout confirmation", CONFIRMATION_LABEL[confirmationMode(settings)]]));
  lines.push(row(["Strategies on", STRATEGY_IDS.filter((id) => settings.strategies?.[id]).map((id) => STRATEGY_LABEL[id]).join("; ")]));
  lines.push(row(["Settings", `${settings.lots} lot(s); stop ${settings.stop.value}${settings.stop.mode === "percent" ? "%" : " Rs"}; target ${settings.target.value}${settings.target.mode === "percent" ? "%" : " Rs"}; max daily loss ${settings.maxDailyLoss}; cooldown ${settings.cooldownMinutes} min; observation ${settings.observationMinutes} min; entries until ${settings.entryCutoff}`]));
  lines.push("");

  lines.push(row(["TRADES"]));
  lines.push(row(["Trade", "Side", "Strategy", "Trigger", "Line price", "Signal candle open", "Signal candle high", "Signal candle low", "Signal candle close", "Points past the line", "Body past the line %", "Option", "Expiry", "Lot size", "Lots", "Quantity", "Signal time", "Underlying at signal", "Entry time", "Entry premium", "Entry value", "Entry charges", "Capital committed", "Stop-loss", "Target", "Exit time", "Exit premium", "Exit reason", "Exit charges", "Gross P&L", "Total charges", "Net realized P&L", "Return %", "Duration (min)", "Max adverse move / unit", "Status"]));
  for (const trade of trades) {
    const signal = signalOf(trade, report.events);
    lines.push(row([
      trade.number, `BUY ${trade.side}`, STRATEGY_LABEL[trade.strategy], trade.lines.join("; "), num(signal.line), num(signal.candle?.open), num(signal.candle?.high), num(signal.candle?.low), num(signal.candle?.close), num(signal.pastPoints), signal.bodyShare == null ? "" : signal.bodyShare.toFixed(1),
      `${trade.underlying} ${trade.strike ?? ""} ${trade.right}`, trade.expiry, trade.lotSize ?? "", trade.lotSize ? trade.quantity / trade.lotSize : "", trade.quantity,
      ist(trade.signalTime + 60), num(trade.underlyingAtSignal), ist(trade.entryTime), num(trade.entryPremium), num(trade.entryPremium * trade.quantity), num(trade.entryCharges), num(trade.entryPremium * trade.quantity + trade.entryCharges), trade.stop ? num(trade.stop) : "None", num(trade.target),
      trade.exitTime ? ist(trade.exitTime) : "", num(trade.exitPremium), trade.exitReason ?? "", num(trade.exitCharges), num(grossOf(trade, report.events)), num(trade.entryCharges + trade.exitCharges), num(trade.realized),
      trade.returnPercent == null ? "" : trade.returnPercent.toFixed(2), trade.durationMinutes ?? "", trade.adverse == null ? "" : num(trade.adverse), tradeStatusLabel(trade, report.status === "ENDED"),
    ]));
  }
  if (!trades.length) lines.push(row(["No trades in this session."]));
  lines.push("");

  lines.push(row(["FULL FLOW"]));
  lines.push(row(["Time (IST)", "Event", "Trade", "Side", "Strategy", "Candle open", "Candle high", "Candle low", "Candle close", "Option", "Order", "Quantity", "Premium", "P&L", "Details"]));
  // In the order things happened: by the time shown (a candle's check at its close, an entry at its fill),
  // and within one minute: the candle's check, then the order, the exit and the confirmations.
  const shownTime = (event: AlgoEvent) => (event.kind === "ENTRY" ? entryFillTime(event) : event.key.startsWith("eval:") ? event.time + 60 : event.time);
  const step = (event: AlgoEvent) => (event.key.startsWith("eval:") ? 0 : event.kind === "ENTRY" ? 1 : event.kind === "EXIT" ? 2 : event.key.startsWith("confirm:") ? 3 : 4);
  // A rejected signal is one row (its candle's evaluation carries every reason).
  const ordered = report.events.filter((event) => !event.key.startsWith("reject:")).map((event, index) => ({ event, index })).sort((a, b) => shownTime(a.event) - shownTime(b.event) || step(a.event) - step(b.event) || a.index - b.index).map((item) => item.event);
  for (const event of ordered) {
    const evaluation = event.evaluation;
    const time = shownTime(event);
    const strategies = evaluation?.strategies?.map((item) => STRATEGY_LABEL[item.strategy]).join("; ") ?? (event.setup ? STRATEGY_LABEL[event.setup.strategy] : "");
    const side = event.side ?? (evaluation?.decision === "CALL" || evaluation?.decision === "PUT" ? evaluation.decision : "");
    const trade = numberOf(event.order?.key ?? confirmationEntryKey(event.key));
    const details = [event.message, ...(event.reasons?.length ? [`Reasons: ${event.reasons.join(" ")}`] : []), ...(event.kind === "EXIT" ? [EXIT_LABEL[/^Exit \(([A-Z_]+)\)/.exec(event.message)?.[1] ?? ""] ?? ""] : [])].filter(Boolean).join(" | ");
    lines.push(row([
      ist(time), flowKind(event), trade, side, strategies,
      num(evaluation?.candle.open), num(evaluation?.candle.high), num(evaluation?.candle.low), num(evaluation?.candle.close),
      event.contract ? `${event.contract.underlying} ${event.contract.strike} ${event.contract.right} ${event.contract.expiry}` : "",
      event.order ? `${event.kind === "EXIT" ? "SELL" : event.kind === "ENTRY" ? "BUY" : ""} ${event.order.status}`.trim() : "",
      event.order?.quantity ?? "", num(event.order?.price), num(event.pnl), details,
    ]));
  }
  // A byte-order mark so Excel reads ₹ and other characters as UTF-8.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** A safe file name for the report. */
export function algoReportName(report: Pick<AlgoReportInput, "underlying" | "date" | "sessionId">) {
  const suffix = report.sessionId.split(".").at(-1) ?? "session";
  return `TradeD-Algo-${report.underlying}-${report.date}-${suffix}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
}
