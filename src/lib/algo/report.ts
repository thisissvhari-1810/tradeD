import { algoTrades, confirmationEntryKey, entryFillTime, EXIT_LABEL, type RunStats } from "./chart-replay";
import { STRATEGY_IDS, STRATEGY_LABEL } from "./patterns";
import type { AlgoConfig, AlgoEvent } from "./runner";

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
  lines.push(row(["Strategies on", STRATEGY_IDS.filter((id) => settings.strategies?.[id]).map((id) => STRATEGY_LABEL[id]).join("; ")]));
  lines.push(row(["Settings", `${settings.lots} lot(s); stop ${settings.stop.value}${settings.stop.mode === "percent" ? "%" : " Rs"}; target ${settings.target.value}${settings.target.mode === "percent" ? "%" : " Rs"}; max daily loss ${settings.maxDailyLoss}; cooldown ${settings.cooldownMinutes} min; observation ${settings.observationMinutes} min; entries until ${settings.entryCutoff}`]));
  lines.push("");

  lines.push(row(["TRADES"]));
  lines.push(row(["Trade", "Side", "Strategy", "Trigger", "Option", "Expiry", "Lot size", "Quantity", "Signal time", "Underlying at signal", "Entry time", "Entry premium", "Stop-loss", "Target", "Exit time", "Exit premium", "Exit reason", "Charges", "Realized P&L", "Return %", "Duration (min)", "Status"]));
  for (const trade of trades) {
    lines.push(row([
      trade.number, `BUY ${trade.side}`, STRATEGY_LABEL[trade.strategy], trade.lines.join("; "), `${trade.underlying} ${trade.strike ?? ""} ${trade.right}`, trade.expiry, trade.lotSize ?? "", trade.quantity,
      ist(trade.signalTime + 60), num(trade.underlyingAtSignal), ist(trade.entryTime), num(trade.entryPremium), num(trade.stop), num(trade.target),
      trade.exitTime ? ist(trade.exitTime) : "", num(trade.exitPremium), trade.exitReason ?? "", num(trade.entryCharges + trade.exitCharges), num(trade.realized),
      trade.returnPercent == null ? "" : trade.returnPercent.toFixed(2), trade.durationMinutes ?? "", trade.status === "COMPLETED" ? "Completed" : "Open",
    ]));
  }
  if (!trades.length) lines.push(row(["No trades in this session."]));
  lines.push("");

  lines.push(row(["FULL FLOW"]));
  lines.push(row(["Time (IST)", "Event", "Trade", "Side", "Strategy", "Candle open", "Candle high", "Candle low", "Candle close", "Option", "Order", "Quantity", "Premium", "P&L", "Details"]));
  const ordered = [...report.events].sort((a, b) => a.time - b.time);
  for (const event of ordered) {
    const evaluation = event.evaluation;
    const time = event.kind === "ENTRY" ? entryFillTime(event) : event.key.startsWith("eval:") ? event.time + 60 : event.time;
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
