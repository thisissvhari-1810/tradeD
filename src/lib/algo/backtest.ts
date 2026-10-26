import { algoTrades, skippedSignals, type RunStats } from "./chart-replay";
import { csvCell } from "./report";
import type { AlgoEvent } from "./runner";
import type { Candle } from "./lines";

/**
 * Multi-day backtest arithmetic: the days to run, the totals across them and the chronological training /
 * validation / out-of-sample split. Each day's result comes from the server's simulation of that day (real
 * candles and premiums, virtual money, charges and slippage included). Days the server could not simulate
 * (a holiday, missing history) are counted as skipped, never as zero-P&L days.
 */

export type BacktestTrade = {
  number: number; side: "CALL" | "PUT"; strategy: string; entryTime: number; entryPremium: number; exitTime: number | null; exitPremium: number | null; exitReason: string | null; realized: number | null;
  risk?: number | null; gross?: number | null; adverse?: number | null;
  /** Largest rise of the premium above the entry while open, per unit. */
  favorable?: number | null;
  contract?: string; expiry?: string | null; lotSize?: number | null; quantity?: number; target?: number | null; stop?: number | null;
  /** Entry and exit charges, ₹. */
  charges?: number;
  /** The lines crossed and the candle that signalled (its open time), and the reason logged at the entry. */
  lines?: string[]; signalTime?: number; reason?: string;
};
/** A signal that did not become a trade, and how the underlying moved in the window after it. */
export type MissedSignal = { time: number; side: "CALL" | "PUT" | null; reason: string; lines: string[]; close: number | null; move: number | null; windowMinutes: number };
/** "saved", "baseline" (entry filters and structure stop off), "score:NN" or "confirm:MODE". */
export type BacktestVariant = string;
export type BacktestDay =
  | {
    date: string; variant: BacktestVariant; ok: true; expiry: string | null; stats: RunStats; trades: BacktestTrade[]; rejected: number; dailyTarget?: number;
    /** The starting capital of the day's virtual account (₹). */
    capital?: number;
    /** Where the premiums came from: the expired weekly contracts' history, or a still-listed contract's. */
    source?: "expired" | "listed";
    missed?: MissedSignal[];
    notes?: string[];
    /** For the day view (not stored): the underlying's candles and the strategy lines. */
    session?: { candles: Candle[]; lines: Array<{ label: string; price: number }> };
  }
  | { date: string; variant: BacktestVariant; ok: false; reason: string };

/** One backtested session's trades, with everything about each one (from the run's own log). */
export function backtestTrades(events: AlgoEvent[], expiry: string | null): BacktestTrade[] {
  const risks = events.filter((event) => event.kind === "ENTRY").map((event) => event.setup?.risk ?? null);
  return algoTrades(events, null).map((trade, index) => {
    const entry = events.find((event) => event.kind === "ENTRY" && event.order?.key === trade.entryKey);
    const decided = entry ? events.find((event) => event.key === `eval:${entry.time}`)?.message ?? "" : "";
    return {
      number: trade.number, side: trade.side, strategy: trade.strategy, entryTime: trade.entryTime, entryPremium: trade.entryPremium, exitTime: trade.exitTime, exitPremium: trade.exitPremium,
      exitReason: trade.exitReason, realized: trade.realized, gross: trade.gross, adverse: trade.adverse, favorable: trade.favorable, risk: risks[index] ?? null,
      contract: `${trade.underlying} ${trade.strike ?? ""} ${trade.right}`.trim(), expiry, lotSize: trade.lotSize, quantity: trade.quantity, target: trade.target, stop: trade.stop,
      charges: Math.round((trade.entryCharges + trade.exitCharges) * 100) / 100, lines: trade.lines, signalTime: trade.signalTime, reason: decided,
    };
  });
}

/** Signals that were not traded, with the underlying's move over the next `windowMinutes` (from completed candles). */
export function missedSignals(events: AlgoEvent[], candles: Candle[], windowMinutes = 15): MissedSignal[] {
  return skippedSignals(events).map((item) => {
    const at = candles.find((candle) => candle.time + 60 === item.time) ?? null;
    const later = candles.find((candle) => candle.time + 60 === item.time + windowMinutes * 60) ?? candles.at(-1) ?? null;
    return { time: item.time, side: item.side, reason: item.reason, lines: item.lines, close: at?.close ?? null, move: at && later && later.time > at.time ? Math.round((later.close - at.close) * 100) / 100 : null, windowMinutes };
  }).sort((a, b) => a.time - b.time);
}

export type DaySummary = {
  date: string; capital: number; trades: number; calls: number; puts: number; wins: number; losses: number; winRate: number | null;
  grossProfit: number; grossLoss: number; charges: number; net: number; returnPercent: number; endCapital: number;
  best: number | null; worst: number | null; drawdown: number; missed: number; falseBreakouts: number;
};

/** One day's figures from its trades (win rate over closed trades; return against the day's starting capital). */
export function daySummary(day: Extract<BacktestDay, { ok: true }>, fallbackCapital: number): DaySummary {
  const capital = day.capital ?? fallbackCapital;
  const closed = day.trades.filter((trade) => trade.realized != null);
  const wins = closed.filter((trade) => trade.realized! > 0);
  const losses = closed.filter((trade) => trade.realized! < 0);
  let running = 0;
  let peak = 0;
  let drawdown = 0;
  for (const trade of [...closed].sort((a, b) => a.entryTime - b.entryTime)) {
    running += trade.realized!;
    peak = Math.max(peak, running);
    drawdown = Math.max(drawdown, peak - running);
  }
  const net = round(closed.reduce((sum, trade) => sum + trade.realized!, 0));
  return {
    date: day.date, capital, trades: day.trades.length, calls: day.trades.filter((trade) => trade.side === "CALL").length, puts: day.trades.filter((trade) => trade.side === "PUT").length,
    wins: wins.length, losses: losses.length, winRate: closed.length ? round((wins.length / closed.length) * 100) : null,
    grossProfit: round(wins.reduce((sum, trade) => sum + trade.realized!, 0)), grossLoss: round(losses.reduce((sum, trade) => sum + trade.realized!, 0)),
    charges: round(day.trades.reduce((sum, trade) => sum + (trade.charges ?? 0), 0)), net, returnPercent: capital ? round((net / capital) * 100) : 0, endCapital: round(capital + net),
    best: closed.length ? Math.max(...closed.map((trade) => trade.realized!)) : null, worst: closed.length ? Math.min(...closed.map((trade) => trade.realized!)) : null,
    drawdown: round(drawdown), missed: day.missed?.length ?? day.rejected, falseBreakouts: day.stats.falseBreakouts ?? 0,
  };
}

export const CONFIRMATION_SHORT = { single: "single candle", hold: "breakout hold", retest: "retest" } as const;

export function variantLabel(variant: BacktestVariant) {
  if (variant === "saved") return "Saved settings";
  if (variant === "baseline") return "Filters and structure stop off";
  const score = /^score:(\d+)$/.exec(variant);
  if (score) return `Minimum score ${score[1]}`;
  const confirm = /^confirm:(single|hold|retest)$/.exec(variant);
  return confirm ? `Confirmation: ${CONFIRMATION_SHORT[confirm[1] as keyof typeof CONFIRMATION_SHORT]}` : variant;
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
  /** Breakout confirmation: crossings detected, setups cancelled as false breakouts, and expired. */
  detected: number;
  filtered: number;
  expired: number;
  /** Trades closed at their premium target, and trades still open at the session's end (closed there). */
  targetHits: number;
  openAtEnd: number;
  /** Gross P&L (before charges) of the closed trades; `pnl` is net. */
  gross: number;
  /** Largest adverse premium move of any trade, per unit, and the average across trades. */
  worstAdverse: number | null;
  averageAdverse: number | null;
  /** Longest run of winning trades, in time order. */
  maxConsecutiveWins: number;
  /** Sum of the winning trades and of the losing trades (net of charges), ₹. */
  grossProfit: number;
  grossLossTotal: number;
  /** Entry and exit charges of every trade, ₹. */
  charges: number;
  /** CALL and PUT trades separately. */
  sides: Record<"CALL" | "PUT", { trades: number; wins: number; losses: number; pnl: number }>;
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
  let winStreak = 0;
  let maxConsecutiveWins = 0;
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
        winStreak += 1;
        maxConsecutiveWins = Math.max(maxConsecutiveWins, winStreak);
      } else {
        winStreak = 0;
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
  const all = ok.flatMap((day) => day.trades);
  const adverse = all.map((trade) => trade.adverse).filter((value): value is number => value != null);
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
    detected: ok.reduce((sum, day) => sum + (day.stats.detected ?? 0), 0),
    filtered: ok.reduce((sum, day) => sum + (day.stats.falseBreakouts ?? 0), 0),
    expired: ok.reduce((sum, day) => sum + (day.stats.expired ?? 0), 0),
    targetHits: all.filter((trade) => trade.exitReason === "Target").length,
    openAtEnd: all.filter((trade) => trade.exitReason === "Session end" || trade.exitReason === "Replay session closed" || trade.exitTime == null).length,
    gross: round(all.reduce((sum, trade) => sum + (trade.gross ?? 0), 0)),
    worstAdverse: adverse.length ? Math.max(...adverse) : null,
    averageAdverse: average(adverse),
    maxConsecutiveWins,
    grossProfit: round(grossWin),
    grossLossTotal: round(-grossLoss),
    charges: round(all.reduce((sum, trade) => sum + (trade.charges ?? 0), 0)),
    sides: Object.fromEntries((["CALL", "PUT"] as const).map((side) => {
      const list = all.filter((trade) => trade.side === side);
      return [side, { trades: list.length, wins: list.filter((trade) => (trade.realized ?? 0) > 0).length, losses: list.filter((trade) => (trade.realized ?? 0) < 0).length, pnl: round(list.reduce((sum, trade) => sum + (trade.realized ?? 0), 0)) }];
    })) as BacktestTotals["sides"],
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
  lines.push(row(["Totals", "Variant", "Part", "Trades", "Wins", "Losses", "Net P&L", "Max drawdown", "Win rate % / profit factor / avg trade / avg win / avg loss / avg R / max losing streak / false breakouts % / no-trade days % / target days %", "Breakouts detected", "False breakouts filtered", "Expired", "Target hits", "Open at session end", "Gross P&L", "Worst adverse move / unit", "Avg adverse move / unit"]));
  const split = splitDates(days.map((day) => day.date));
  for (const variant of [...new Set(days.map((day) => day.variant))]) {
    const set = days.filter((day) => day.variant === variant);
    const parts: Array<[string, BacktestDay[]]> = [["All days", set], ...(["training", "validation", "test"] as const).map((name): [string, BacktestDay[]] => [SPLIT_LABEL[name], set.filter((day) => split[name].includes(day.date))])];
    for (const [part, subset] of parts) {
      if (!subset.length) continue;
      const totals = backtestTotals(subset);
      lines.push(row(["TOTAL", variantLabel(variant), `${part}: ${totals.days} days (${totals.daysSkipped} skipped)`, totals.trades, totals.wins, totals.losses, totals.pnl.toFixed(2), totals.maxDrawdown.toFixed(2), [totals.winRate ?? "—", totals.profitFactor ?? "—", totals.averageTrade ?? "—", totals.averageWin ?? "—", totals.averageLoss ?? "—", totals.averageR ?? "—", totals.maxConsecutiveLosses, totals.falseBreakouts ?? "—", totals.noTradeDays ?? "—", totals.targetDays ?? "—"].join(" / "), totals.detected, totals.filtered, totals.expired, totals.targetHits, totals.openAtEnd, totals.gross.toFixed(2), totals.worstAdverse ?? "", totals.averageAdverse ?? ""]));
    }
  }
  lines.push("");
  lines.push(row(["Trades", "Variant", "Trade", "Side", "Entry time (IST)", "Entry premium", "Exit time (IST)", "Exit premium", "Exit reason", "Gross P&L", "Net P&L", "Max adverse move / unit"]));
  const ist = (seconds: number | null) => (seconds == null ? "" : new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16));
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date) || a.variant.localeCompare(b.variant))) {
    if (!day.ok) continue;
    for (const trade of day.trades) lines.push(row([day.date, variantLabel(day.variant), trade.number, trade.side, ist(trade.entryTime), trade.entryPremium.toFixed(2), ist(trade.exitTime), trade.exitPremium?.toFixed(2) ?? "", trade.exitReason ?? "Open", trade.gross?.toFixed(2) ?? "", trade.realized?.toFixed(2) ?? "", trade.adverse?.toFixed(2) ?? ""]));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
