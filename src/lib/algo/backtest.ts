import type { RunStats } from "./chart-replay";
import { csvCell } from "./report";

/**
 * Multi-day backtest arithmetic: the days to run and the totals across them. Each day's result comes from
 * the server's simulation of that day (real candles and premiums, virtual money). Days the server could
 * not simulate (a holiday, missing history) are counted as skipped, never as zero-P&L days.
 */

export type BacktestTrade = { number: number; side: "CALL" | "PUT"; strategy: string; entryTime: number; entryPremium: number; exitTime: number | null; exitPremium: number | null; exitReason: string | null; realized: number | null };
export type BacktestDay =
  | { date: string; variant: "saved" | "baseline"; ok: true; expiry: string | null; stats: RunStats; trades: BacktestTrade[]; rejected: number }
  | { date: string; variant: "saved" | "baseline"; ok: false; reason: string };

/** Weekdays from `from` to `to` (inclusive, YYYY-MM-DD), oldest first, at most `limit`. */
export function tradingDays(from: string, to: string, limit = 60): string[] {
  const days: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return days;
  for (let at = start; at <= end && days.length < limit; at += 86_400_000) {
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/** The last `count` weekdays before `today` (YYYY-MM-DD), oldest first. */
export function lastTradingDays(today: string, count: number): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${today}T00:00:00Z`) - 86_400_000; days.length < count; at -= 86_400_000) {
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.unshift(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

export type BacktestTotals = {
  days: number;
  daysTraded: number;
  daysSkipped: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  averagePerDay: number | null;
  /** Gross profit / gross loss over the closed trades (null without losses). */
  profitFactor: number | null;
  /** Largest fall of the running P&L across the days, in date order. */
  maxDrawdown: number;
  bestDay: { date: string; pnl: number } | null;
  worstDay: { date: string; pnl: number } | null;
};

const round = (value: number) => Math.round(value * 100) / 100;

export function backtestTotals(days: BacktestDay[]): BacktestTotals {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const ok = ordered.filter((day): day is Extract<BacktestDay, { ok: true }> => day.ok);
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let best: BacktestTotals["bestDay"] = null;
  let worst: BacktestTotals["worstDay"] = null;
  for (const day of ok) {
    running = round(running + day.stats.realized);
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, round(peak - running));
    for (const trade of day.trades) {
      if ((trade.realized ?? 0) > 0) grossWin += trade.realized ?? 0;
      else grossLoss -= trade.realized ?? 0;
    }
    if (day.trades.length) {
      if (!best || day.stats.realized > best.pnl) best = { date: day.date, pnl: day.stats.realized };
      if (!worst || day.stats.realized < worst.pnl) worst = { date: day.date, pnl: day.stats.realized };
    }
  }
  const trades = ok.reduce((sum, day) => sum + day.trades.length, 0);
  const wins = ok.reduce((sum, day) => sum + day.stats.wins, 0);
  const losses = ok.reduce((sum, day) => sum + day.stats.losses, 0);
  return {
    days: ordered.length,
    daysTraded: ok.filter((day) => day.trades.length).length,
    daysSkipped: ordered.length - ok.length,
    trades,
    wins,
    losses,
    winRate: wins + losses ? round((wins / (wins + losses)) * 100) : null,
    pnl: running,
    averagePerDay: ok.length ? round(running / ok.length) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    maxDrawdown,
    bestDay: best,
    worstDay: worst,
  };
}

/** The backtest as a CSV: one row per day (and per variant), then the totals. */
export function backtestCsv(days: BacktestDay[]): string {
  const row = (cells: unknown[]) => cells.map(csvCell).join(",");
  const lines = [row(["Date", "Variant", "Status", "Trades", "Wins", "Losses", "Realized P&L", "Rejected signals", "Note"])];
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date) || a.variant.localeCompare(b.variant))) {
    lines.push(day.ok
      ? row([day.date, day.variant === "saved" ? "With fixes" : "Without fixes", "Simulated", day.trades.length, day.stats.wins, day.stats.losses, day.stats.realized.toFixed(2), day.rejected, day.expiry ? `expiry ${day.expiry}` : ""])
      : row([day.date, day.variant === "saved" ? "With fixes" : "Without fixes", "Skipped", "", "", "", "", "", day.reason]));
  }
  lines.push("");
  for (const variant of ["saved", "baseline"] as const) {
    const set = days.filter((day) => day.variant === variant);
    if (!set.length) continue;
    const totals = backtestTotals(set);
    lines.push(row([variant === "saved" ? "TOTAL with fixes" : "TOTAL without fixes", "", `${totals.days} days (${totals.daysSkipped} skipped)`, totals.trades, totals.wins, totals.losses, totals.pnl.toFixed(2), "", `win rate ${totals.winRate ?? "—"}%; profit factor ${totals.profitFactor ?? "—"}; max drawdown ${totals.maxDrawdown.toFixed(2)}`]));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
