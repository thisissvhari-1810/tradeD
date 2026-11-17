/**
 * Mathi Trend Channel backtest on NIFTY with real weekly option premiums (1-minute), from exported CSVs: the NIFTY
 * 1-minute candles and the nearest weekly expiry's option candles of each session. The strategy is the app's own:
 * MATHI_CHANNEL_DEFAULTS read through readAlgoConfig (as the server reads a variant's settings), simulated with
 * simulateSession / createReplayAdapter exactly like the in-app backtest: the ATM contract from NIFTY's close at the
 * signal minute, fills at that contract's own premium plus slippage, statutory charges on both legs, ₹1,00,000 fresh
 * capital each session. Paper only: no order is sent anywhere.
 *
 *   npx tsx scripts/backtest-mathi-channel.ts --data <folder with 05-nifty-1min-candles.csv and 07-nifty-weekly-options-1min.csv> --export <folder> --variant default
 *   npx tsx scripts/backtest-mathi-channel.ts --data <…> --export <folder> --report
 *
 * Variants: default (both patterns, channel + horizontal level), pattern-a, pattern-b, channel-only. Each run writes
 * <export>/partial-<variant>.json; --report merges them into the CSVs and README (counts first).
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { readAlgoConfig } from "@/lib/algo/config";
import { MATHI_CHANNEL_DEFAULTS, type AlgoConfig } from "@/lib/algo/runner";
import type { Candle } from "@/lib/algo/lines";
import { createReplayAdapter, simulateSession, type ReplayChain } from "@/lib/algo/replay-adapter";
import { algoTrades } from "@/lib/algo/chart-replay";
import { CHANNEL_SETTINGS_DEFAULTS, channelSignal, istClock, type ChannelSettings } from "@/lib/algo/trend-channel";
import { csvCell } from "@/lib/algo/report";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[index + 1]?.startsWith("--") || process.argv[index + 1] == null ? "1" : process.argv[++index]);
}
const DATA = path.resolve(args.get("data") ?? "../../backtests/Mathi-NIFTY-v18-12-months-2025-10-27-to-2026-10-26");
const EXPORT = path.resolve(args.get("export") ?? "../../backtests/Mathi-Trend-Channel-NIFTY-12-months");
const CAPITAL = 100_000;

const VARIANTS: Record<string, { label: string; channel: Partial<ChannelSettings> }> = {
  default: { label: "Default — Pattern A + B, channel + horizontal level", channel: {} },
  "pattern-a": { label: "Pattern A only (2 deep highs + 1 deep low)", channel: { patterns: "A" } },
  "pattern-b": { label: "Pattern B only (2 deep lows + 1 deep high)", channel: { patterns: "B" } },
  "channel-only": { label: "Channel-only breakouts (no horizontal level), A + B", channel: { requireLevel: false } },
  "retest-after": { label: "Retest after the next-candle confirmation", channel: { retest: "after" } },
  "retest-instead": { label: "Retest instead of the next-candle confirmation", channel: { retest: "instead" } },
  "daily-daymove-1400": { label: "Every day: setups, else day's direction at 14:00", channel: { fallback: "daymove", fallbackTime: "14:00" } },
  "daily-channel-1300": { label: "Every day: setups, else price vs channel at 13:00", channel: { fallback: "channel", fallbackTime: "13:00" } },
  "gap-rule": { label: "Opening-gap rule on setups", channel: { gapRule: true } },
  "setups-only": { label: "Strategy setups only (no forced daily entry)", channel: { fallback: "off" } },
};

const unix = (date: string, time: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +time.slice(0, 2), +time.slice(3, 5)) / 1000 - 19_800;
const sessionOpen = (date: string) => unix(date, "09:15");
/** NIFTY weekly options expire on Tuesday: the next Tuesday on or after the session (used only where the export has no expiry). */
const nextTuesday = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + ((2 - day.getUTCDay() + 7) % 7));
  return day.toISOString().slice(0, 10);
};
/** NIFTY's exchange lot by contract expiry: 50, 25 from the late-April 2024 series, 75 from the late-December 2024 weeklies, 65 from January 2026. */
const lotSizeOf = (expiry: string) => (expiry <= "2024-04-25" ? 50 : expiry <= "2024-12-24" ? 25 : expiry <= "2025-12-30" ? 75 : 65);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

async function lines(file: string, each: (cells: string[]) => void) {
  const reader = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = true;
  for await (const line of reader) {
    if (header) { header = false; continue; }
    if (line) each(line.split(","));
  }
}

type Day = { date: string; candles: Candle[]; expiry: string; inferredExpiry: boolean; tapes: Map<string, Candle[]>; prevClose: number | null };

async function loadDays(): Promise<Day[]> {
  const nifty = new Map<string, Candle[]>();
  await lines(path.join(DATA, "05-nifty-1min-candles.csv"), ([date, time, open, high, low, close]) => {
    const list = nifty.get(date) ?? [];
    list.push({ time: unix(date, time), open: +open, high: +high, low: +low, close: +close });
    nifty.set(date, list);
  });
  const options = new Map<string, { expiry: string; inferred: boolean; tapes: Map<string, Candle[]> }>();
  await lines(path.join(DATA, "07-nifty-weekly-options-1min.csv"), ([date, time, expiry, strike, type, open, high, low, close, volume]) => {
    const day = options.get(date) ?? { expiry: expiry === "after range" ? nextTuesday(date) : expiry, inferred: expiry === "after range", tapes: new Map() };
    const key = `${+strike}|${type}`;
    const tape = day.tapes.get(key) ?? [];
    tape.push({ time: unix(date, time), open: +open, high: +high, low: +low, close: +close, volume: +volume });
    day.tapes.set(key, tape);
    options.set(date, day);
  });
  const days: Day[] = [];
  let prevClose: number | null = null;
  for (const [date, candles] of [...nifty.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const option = options.get(date);
    const previous = prevClose;
    prevClose = candles.reduce((last, candle) => (candle.time > last.time ? candle : last), candles[0]).close;
    // A session without its option premiums is not reported (results come from the traded contract's own tape).
    if (!option) continue;
    for (const tape of option.tapes.values()) tape.sort((a, b) => a.time - b.time);
    days.push({ date, candles: candles.sort((a, b) => a.time - b.time), expiry: option.expiry, inferredExpiry: option.inferred, tapes: option.tapes, prevClose: previous });
  }
  return days;
}

function configOf(variant: string): AlgoConfig {
  const raw = JSON.parse(JSON.stringify({ ...MATHI_CHANNEL_DEFAULTS, channel: { ...CHANNEL_SETTINGS_DEFAULTS, ...VARIANTS[variant].channel } }));
  return { ...readAlgoConfig(raw), engine: "channel", mode: "REPLAY" };
}

type TradeRow = {
  date: string; pattern: string; number: number; side: string; contract: string; expiry: string; daysToExpiry: number; breakout: string; confirm: string; entryTime: string; exitTime: string;
  entryPremium: number; target: number | null; exitPremium: number | null; exitReason: string; lots: number; quantity: number; charges: number; gross: number | null; net: number | null; returnPercent: number | null;
  minutes: number | null; adverse: number | null; favorable: number | null; outcome: "PROFIT" | "LOSS"; level: number | null; why: string;
};
type SetupRow = { date: string; pattern: string; status: string; direction: string; time: string; close: number; high: number; low: number; line: number; level: number | null; confirm: string; reason: string };
type DayRow = { date: string; pattern: string; patternAt: string; points: string; slope: number | null; width: number | null; watches: number; breakouts: number; confirmed: number; failed: number; trades: number; profit: number; loss: number; inferredExpiry: boolean };

async function runVariant(variant: string) {
  if (!VARIANTS[variant]) throw new Error(`Unknown variant ${variant}: ${Object.keys(VARIANTS).join(", ")}`);
  const limit = Number(args.get("days") ?? 0);
  const days = (await loadDays()).slice(0, limit > 0 ? limit : undefined);
  const config = configOf(variant);
  const settings = { ...CHANNEL_SETTINGS_DEFAULTS, ...config.channel };
  const trades: TradeRow[] = [];
  const setups: SetupRow[] = [];
  const daily: DayRow[] = [];
  const started = Date.now();
  for (const [index, day] of days.entries()) {
    const open = sessionOpen(day.date);
    // The channel as the engine saw it over the whole session (the same pure function; for the setup log only).
    const channel = channelSignal(day.candles, open, settings, undefined, day.prevClose).state;
    const lines = day.prevClose != null ? [{ id: `${day.date}:prev-close`, type: "prev-close" as const, label: "Previous-day close", price: day.prevClose, activeFrom: open, source: "strategy" as const }] : [];
    const pattern = channel.pattern?.kind ?? "-";
    for (const setup of channel.setups) {
      setups.push({ date: day.date, pattern, status: setup.status, direction: setup.direction, time: istClock(setup.time), close: setup.close, high: setup.high, low: setup.low, line: setup.line, level: setup.level, confirm: setup.confirm ? istClock(setup.confirm.time) : "", reason: setup.reasons.join(" ") });
    }
    const strikes = [...new Set([...day.tapes.keys()].map((key) => +key.split("|")[0]))].sort((a, b) => a - b);
    const lotSize = lotSizeOf(day.expiry);
    const chain: ReplayChain = { symbol: "NIFTY", expiry: day.expiry, kind: "index", lotSize, strikes: strikes.map((strike) => ({ strike, ce: { securityId: `CE:${strike}` }, pe: { securityId: `PE:${strike}` } })) };
    const adapter = createReplayAdapter({ candles: day.candles, chain, config, capital: CAPITAL, tapeOf: async (contract) => day.tapes.get(`${contract.strike}|${contract.right}`) ?? [] });
    const { events, state } = await simulateSession({ sessionId: `${day.date}.mc`, date: day.date, config, candles: day.candles, lines, adapter, startNote: `Mathi Trend Channel backtest (${variant}).` });
    const done = algoTrades(events, state.position ? { entryKey: state.position.entryKey, exitPending: Boolean(state.position.exit) } : null).filter((trade) => trade.status === "COMPLETED" && !trade.shadow);
    for (const trade of done) {
      const entry = events.find((event) => event.kind === "ENTRY" && event.order?.key === trade.entryKey);
      const setup = channel.setups.find((item) => (item.entry ?? item.confirm)?.end === trade.signalTime + 60);
      const net = trade.realized;
      trades.push({
        date: day.date, pattern, number: trade.number, side: trade.side, contract: trade.contract, expiry: trade.expiry, daysToExpiry: daysBetween(day.date, trade.expiry),
        breakout: setup ? istClock(setup.time) : "", confirm: setup?.confirm ? istClock(setup.confirm.time) : "", entryTime: istClock(trade.entryTime), exitTime: trade.exitTime ? istClock(trade.exitTime) : "",
        entryPremium: trade.entryPremium, target: trade.target, exitPremium: trade.exitPremium, exitReason: trade.exitReason ?? "", lots: trade.lotSize ? trade.quantity / trade.lotSize : 0, quantity: trade.quantity,
        charges: Math.round((trade.entryCharges + trade.exitCharges) * 100) / 100, gross: trade.gross, net, returnPercent: trade.returnPercent, minutes: trade.durationMinutes, adverse: trade.adverse, favorable: trade.favorable,
        outcome: (net ?? 0) > 0 ? "PROFIT" : "LOSS", level: entry?.setup?.level ?? null, why: entry?.message ?? "",
      });
    }
    const today = trades.filter((trade) => trade.date === day.date);
    const count = (status: string) => channel.setups.filter((item) => item.status === status).length;
    const primary = channel.pattern ? (channel.pattern.kind === "A" ? channel.upper : channel.lower) : null;
    daily.push({
      date: day.date, pattern, patternAt: channel.pattern ? istClock(channel.pattern.completedAt) : "", points: channel.pattern ? channel.pattern.points.map((point) => `${point.label} ${point.price} ${istClock(point.time)}`).join("; ") : "",
      slope: primary ? Math.round(primary.slope * 10_000) / 10_000 : null, width: channel.width, watches: count("WATCH"), breakouts: channel.setups.length - count("WATCH"), confirmed: count("CONFIRMED"), failed: count("FAILED"),
      trades: today.length, profit: today.filter((trade) => trade.outcome === "PROFIT").length, loss: today.filter((trade) => trade.outcome === "LOSS").length, inferredExpiry: day.inferredExpiry,
    });
    if ((index + 1) % 25 === 0) console.log(`${variant}: ${index + 1}/${days.length} sessions, ${trades.length} trades, ${Math.round((Date.now() - started) / 1000)} s`);
  }
  mkdirSync(EXPORT, { recursive: true });
  writeFileSync(path.join(EXPORT, `partial-${variant}.json`), JSON.stringify({ variant, label: VARIANTS[variant].label, config, from: days[0]?.date, to: days.at(-1)?.date, sessions: days.length, trades, setups, daily }));
  console.log(`${variant}: done — ${trades.length} trades in ${Math.round((Date.now() - started) / 1000)} s`);
}

/* ---------------- report ---------------- */

type VariantResult = { variant: string; label: string; config: AlgoConfig; from: string; to: string; sessions: number; trades: TradeRow[]; setups: SetupRow[]; daily: DayRow[] };
const csv = (rows: Array<Record<string, unknown>>) => (rows.length ? [Object.keys(rows[0]).map(csvCell).join(","), ...rows.map((row) => Object.values(row).map((value) => csvCell(value as string | number | null)).join(","))].join("\r\n") + "\r\n" : "");
const tally = (trades: TradeRow[]) => {
  const profit = trades.filter((trade) => trade.outcome === "PROFIT").length;
  return { Trades: trades.length, Profit: profit, Loss: trades.length - profit, "Accuracy %": trades.length ? Math.round((profit / trades.length) * 1000) / 10 : null };
};

function report() {
  const parts = Object.keys(VARIANTS).filter((variant) => existsSync(path.join(EXPORT, `partial-${variant}.json`))).map((variant) => JSON.parse(readFileSync(path.join(EXPORT, `partial-${variant}.json`), "utf8")) as VariantResult);
  if (!parts.length) throw new Error(`No partial results in ${EXPORT}: run the variants first.`);
  const base = parts.find((part) => part.variant === "default") ?? parts[0];
  const files: Record<string, string> = {};
  const summary = parts.map((part) => {
    const days = part.daily;
    const profitDays = days.filter((day) => day.trades && day.profit > 0 && day.loss === 0).length;
    const lossDays = days.filter((day) => day.loss > 0).length;
    return { Variant: part.label, Sessions: part.sessions, ...tally(part.trades), "CALL trades": part.trades.filter((t) => t.side === "CALL").length, "CALL accuracy %": tally(part.trades.filter((t) => t.side === "CALL"))["Accuracy %"], "PUT trades": part.trades.filter((t) => t.side === "PUT").length, "PUT accuracy %": tally(part.trades.filter((t) => t.side === "PUT"))["Accuracy %"], "Days with trades": days.filter((day) => day.trades).length, "All-profit days": profitDays, "Days with a loss": lossDays };
  });
  files["00-variants-compared.csv"] = csv(summary);
  // Pattern A vs B inside each variant (one pattern per session: the first valid combination).
  files["01-pattern-a-vs-b.csv"] = csv(parts.flatMap((part) => (["A", "B"] as const).map((kind) => ({ Variant: part.label, Pattern: kind, Sessions: part.daily.filter((day) => day.pattern === kind).length, ...tally(part.trades.filter((trade) => trade.pattern === kind)) }))));
  const funnel = (part: VariantResult) => ({ Variant: part.label, "Sessions with a channel": part.daily.filter((day) => day.pattern !== "-").length, "Pattern A sessions": part.daily.filter((day) => day.pattern === "A").length, "Pattern B sessions": part.daily.filter((day) => day.pattern === "B").length, "WATCH (channel only)": part.setups.filter((s) => s.status === "WATCH").length, Breakouts: part.setups.filter((s) => s.status !== "WATCH").length, Confirmed: part.setups.filter((s) => s.status === "CONFIRMED").length, "Not confirmed (skipped)": part.setups.filter((s) => s.status === "FAILED").length, "Trades taken": part.trades.length });
  files["02-signal-funnel.csv"] = csv(parts.map(funnel));
  for (const part of parts) files[`03-trades-${part.variant}.csv`] = csv(part.trades.map((trade) => ({
    Date: trade.date, Pattern: trade.pattern, Trade: trade.number, Direction: trade.side, Contract: trade.contract, Expiry: trade.expiry, "Days to expiry": trade.daysToExpiry, "Breakout candle (IST)": trade.breakout, "Confirm candle (IST)": trade.confirm, "Entry (IST)": trade.entryTime, "Exit (IST)": trade.exitTime,
    "Entry premium": trade.entryPremium, "Target premium": trade.target, "Exit premium": trade.exitPremium, "Exit reason": trade.exitReason, Lots: trade.lots, Quantity: trade.quantity, "Charges ₹": trade.charges, "Gross P&L ₹": trade.gross, "Net P&L ₹": trade.net, "Return on premium %": trade.returnPercent,
    "Holding (min)": trade.minutes, "Max adverse / unit": trade.adverse, "Max favourable / unit": trade.favorable, Outcome: trade.outcome, "Broken level": trade.level, "Why it entered": trade.why,
  })));
  files["04-setups-default.csv"] = csv(base.setups.map((setup) => ({ Date: setup.date, Pattern: setup.pattern, Status: setup.status, Direction: setup.direction, "Candle (IST)": setup.time, Close: setup.close, High: setup.high, Low: setup.low, "Channel line": setup.line, "Horizontal level": setup.level, "Next candle (IST)": setup.confirm, Reasons: setup.reason })));
  files["05-daily-default.csv"] = csv(base.daily.map((day) => ({ Date: day.date, Pattern: day.pattern, "Combination complete (IST)": day.patternAt, "Swing points": day.points, "Slope (pts / 3-min)": day.slope, "Channel width (pts)": day.width, WATCH: day.watches, Breakouts: day.breakouts, Confirmed: day.confirmed, "Not confirmed": day.failed, Trades: day.trades, Profit: day.profit, Loss: day.loss, "Expiry inferred": day.inferredExpiry ? "yes" : "" })));
  const months = [...new Set(base.trades.map((trade) => trade.date.slice(0, 7)))].sort();
  files["06-monthly-default.csv"] = csv(months.map((month) => ({ Month: month, ...tally(base.trades.filter((trade) => trade.date.startsWith(month))) })));
  const reasons = [...new Set(base.trades.map((trade) => trade.exitReason))].sort();
  files["07-exit-reasons-default.csv"] = csv(reasons.map((reason) => ({ "Exit reason": reason, ...tally(base.trades.filter((trade) => trade.exitReason === reason)) })));
  const buckets: Array<[string, (d: number) => boolean]> = [["0–1 days", (d) => d <= 1], ["2–3 days", (d) => d >= 2 && d <= 3], ["4–5 days", (d) => d >= 4 && d <= 5], ["6+ days", (d) => d >= 6]];
  files["08-days-to-expiry-default.csv"] = csv(buckets.map(([label, test]) => ({ "Days to expiry": label, ...tally(base.trades.filter((trade) => test(trade.daysToExpiry))) })));
  mkdirSync(EXPORT, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(EXPORT, name), `﻿${text}`);
  writeFileSync(path.join(EXPORT, "results.json"), JSON.stringify({ from: base.from, to: base.to, sessions: base.sessions, summary, funnel: parts.map(funnel), config: base.config }, null, 2));
  console.log(JSON.stringify({ summary, funnel: parts.map(funnel) }, null, 2));
}

if (args.has("report")) report();
else runVariant(args.get("variant") ?? "default").catch((error) => { console.error(error); process.exit(1); });
