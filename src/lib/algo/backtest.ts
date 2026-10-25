import type { RunStats } from "./chart-replay";
import { csvCell } from "./report";

/**
 * Multi-day backtest arithmetic: the days to run, the totals across them and the chronological training /
 * validation / out-of-sample split. Each day's result comes from the server's simulation of that day (real
 * candles and premiums, virtual money, charges and slippage included). Days the server could not simulate
 * (a holiday, missing history) are counted as skipped, never as zero-P&L days.
 */

export type BacktestTrade = { number: number; side: "CALL" | "PUT"; strategy: string; entryTime: number; entryPremium: number; exitTime: number | null; exitPremium: number | null; exitReason: string | null; realized: number | null; risk?: number | null };
/** "saved", "baseline" (entry filters and structure stop off) or "score:NN" (another minimum score). */
export type BacktestVariant = string;
export type BacktestDay =
  | { date: string; variant: BacktestVariant; ok: true; expiry: string | null; stats: RunStats; trades: BacktestTrade[]; rejected: number; dailyTarget?: number }
  | { date: string; variant: BacktestVariant; ok: false; reason: string };

export function variantLabel(variant: BacktestVariant) {
  if (variant === "saved") return "Saved settings";
  if (variant === "baseline") return "Filters and structure stop off";
  const score = /^score:(\d+)$/.exec(variant);
  return score ? `Minimum score ${score[1]}` : variant;
}

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
  averageWin: number | null;
  averageLoss: number | null;
  /** Longest run of losing trades, in time order. */
  maxConsecutiveLosses: number;
  /** Share of simulated days with no trade (no valid setup), %. */
  noTradeDays: number | null;
  /** Share of simulated days whose realized P&L reached the daily target, %. */
  targetDays: number | null;
  /** Average result in multiples of the planned risk (risk-sized trades only). */
  averageR: number | null;
  tradesPerDay: number | null;
  /** Net P&L per trade. */
  averageTrade: number | null;
  /** Share of trades closed by the stop or because the setup was invalidated (the break did not hold), %. */
  falseBreakouts: number | null;
};

const round = (value: number) => Math.round(value * 100) / 100;
const percent = (part: number, whole: number) => (whole ? round((part / whole) * 100) : null);

export function backtestTotals(days: BacktestDay[]): BacktestTotals {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const ok = ordered.filter((day): day is Extract<BacktestDay, { ok: true }> => day.ok);
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let streak = 0;
  let maxConsecutiveLosses = 0;
  const winners: number[] = [];
  const losers: number[] = [];
  const multiples: number[] = [];
  let best: BacktestTotals["bestDay"] = null;
  let worst: BacktestTotals["worstDay"] = null;
  for (const day of ok) {
    running = round(running + day.stats.realized);
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, round(peak - running));
    for (const trade of [...day.trades].sort((a, b) => a.entryTime - b.entryTime)) {
      const result = trade.realized ?? 0;
      if (result > 0) {
        grossWin += result;
        winners.push(result);
        streak = 0;
      } else {
        grossLoss -= result;
        if (trade.realized != null) losers.push(result);
        streak += 1;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
      }
      if (trade.risk && trade.realized != null) multiples.push(trade.realized / trade.risk);
    }
    if (day.trades.length) {
      if (!best || day.stats.realized > best.pnl) best = { date: day.date, pnl: day.stats.realized };
      if (!worst || day.stats.realized < worst.pnl) worst = { date: day.date, pnl: day.stats.realized };
    }
  }
  const trades = ok.reduce((sum, day) => sum + day.trades.length, 0);
  const wins = ok.reduce((sum, day) => sum + day.stats.wins, 0);
  const losses = ok.reduce((sum, day) => sum + day.stats.losses, 0);
  const average = (values: number[]) => (values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);
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
    averageWin: average(winners),
    averageLoss: average(losers),
    maxConsecutiveLosses,
    noTradeDays: percent(ok.filter((day) => !day.trades.length).length, ok.length),
    targetDays: percent(ok.filter((day) => day.dailyTarget != null && day.stats.realized >= day.dailyTarget).length, ok.length),
    averageR: multiples.length ? round(multiples.reduce((sum, value) => sum + value, 0) / multiples.length) : null,
    tradesPerDay: ok.length ? round(trades / ok.length) : null,
    averageTrade: trades ? round(running / trades) : null,
    falseBreakouts: percent(ok.reduce((sum, day) => sum + day.trades.filter((trade) => trade.exitReason === "Stop-loss" || trade.exitReason === "Setup invalidated").length, 0), trades),
  };
}

export type SplitName = "training" | "validation" | "test";
export const SPLIT_LABEL: Record<SplitName, string> = { training: "Training (first 60%)", validation: "Validation (next 20%)", test: "Out-of-sample (last 20%)" };

/** The dates split in time order: the first 60% for choosing settings, the next 20% to check, the last 20% untouched. */
export function splitDates(dates: string[]): Record<SplitName, string[]> {
  const sorted = [...new Set(dates)].sort();
  const training = Math.round(sorted.length * 0.6);
  const validation = Math.round(sorted.length * 0.8);
  return { training: sorted.slice(0, training), validation: sorted.slice(training, validation), test: sorted.slice(validation) };
}

/**
 * The variant chosen on the training days only (best profit factor, then P&L; at least one trade), so the
 * validation and out-of-sample results are not the ones the choice was fitted to.
 */
export function chooseOnTraining(days: BacktestDay[], variants: BacktestVariant[]): BacktestVariant | null {
  const training = new Set(splitDates(days.map((day) => day.date)).training);
  const scored = variants
    .map((variant) => ({ variant, totals: backtestTotals(days.filter((day) => day.variant === variant && training.has(day.date))) }))
    .filter((item) => item.totals.trades > 0);
  scored.sort((a, b) => (b.totals.profitFactor ?? (b.totals.pnl > 0 ? Infinity : 0)) - (a.totals.profitFactor ?? (a.totals.pnl > 0 ? Infinity : 0)) || b.totals.pnl - a.totals.pnl);
  return scored[0]?.variant ?? null;
}

/** The backtest as a CSV: one row per day and variant, then the totals per variant and per split. */
export function backtestCsv(days: BacktestDay[]): string {
  const row = (cells: unknown[]) => cells.map(csvCell).join(",");
  const lines = [row(["Date", "Variant", "Status", "Trades", "Wins", "Losses", "Realized P&L (after charges)", "Rejected signals", "Note"])];
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date) || a.variant.localeCompare(b.variant))) {
    lines.push(day.ok
      ? row([day.date, variantLabel(day.variant), "Simulated", day.trades.length, day.stats.wins, day.stats.losses, day.stats.realized.toFixed(2), day.rejected, day.expiry ? `expiry ${day.expiry}` : ""])
      : row([day.date, variantLabel(day.variant), "Skipped", "", "", "", "", "", day.reason]));
  }
  lines.push("");
  lines.push(row(["Totals", "Variant", "Part", "Trades", "Wins", "Losses", "Net P&L", "Max drawdown", "Win rate % / profit factor / avg trade / avg win / avg loss / avg R / max losing streak / false breakouts % / no-trade days % / target days %"]));
  const split = splitDates(days.map((day) => day.date));
  for (const variant of [...new Set(days.map((day) => day.variant))]) {
    const set = days.filter((day) => day.variant === variant);
    const parts: Array<[string, BacktestDay[]]> = [["All days", set], ...(["training", "validation", "test"] as const).map((name): [string, BacktestDay[]] => [SPLIT_LABEL[name], set.filter((day) => split[name].includes(day.date))])];
    for (const [part, subset] of parts) {
      if (!subset.length) continue;
      const totals = backtestTotals(subset);
      lines.push(row(["TOTAL", variantLabel(variant), `${part}: ${totals.days} days (${totals.daysSkipped} skipped)`, totals.trades, totals.wins, totals.losses, totals.pnl.toFixed(2), totals.maxDrawdown.toFixed(2), [totals.winRate ?? "—", totals.profitFactor ?? "—", totals.averageTrade ?? "—", totals.averageWin ?? "—", totals.averageLoss ?? "—", totals.averageR ?? "—", totals.maxConsecutiveLosses, totals.falseBreakouts ?? "—", totals.noTradeDays ?? "—", totals.targetDays ?? "—"].join(" / ")]));
    }
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
