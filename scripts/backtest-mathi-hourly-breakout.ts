/**
 * Mathi Hourly Breakout — 1% vs Mathi Hourly Zone Strategy — 5%, same sessions, NIFTY real weekly option premiums.
 *
 *   npx tsx scripts/backtest-mathi-hourly-breakout.ts --data <folder> --from 2026-08-01 --to 2026-09-30 --export <folder>
 *
 * <folder> holds 05-nifty-1min-candles.csv and 07-nifty-weekly-options-1min.csv (nearest weekly expiry of each session).
 *
 * 1% strategy (src/lib/algo/hourly-breakout.ts): signal on a completed 1-minute NIFTY candle; at that minute's close the
 * ATM strike (nearest 50 to NIFTY's close), the nearest weekly expiry, the contract's own premium at that minute (a
 * candle of that minute or the one before, as the app's 90-second quote-age limit) plus 1 tick slippage; whole lots
 * from ₹1,00,000 (max 50, app sizing); statutory charges on both legs (app ledger). Target = entry × 1.01, a resting
 * sell checked from the next minute: filled only when a premium candle WITH VOLUME trades at least one tick through
 * it (conservative; a bare touch is reported separately). Otherwise sold at 15:20 at the 15:19 premium minus 1 tick.
 * No stop-loss, no other exit. A missing premium never makes a trade.
 *
 * 5% strategy: MATHI_HOURLY_DEFAULTS exactly as deployed, through readAlgoConfig + simulateSession (the app's replay).
 * Paper only: no order is sent anywhere.
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { readAlgoConfig } from "@/lib/algo/config";
import { ALGO_DEFAULTS, MATHI_HOURLY_DEFAULTS, type AlgoConfig } from "@/lib/algo/runner";
import type { Candle } from "@/lib/algo/lines";
import { createReplayAdapter, simulateSession, type ReplayChain } from "@/lib/algo/replay-adapter";
import { algoTrades } from "@/lib/algo/chart-replay";
import { allocateLots, ALLOCATION_DEFAULTS } from "@/lib/algo/sizing";
import { optionCharges } from "@/lib/options/engine";
import { BREAKOUT_DEFAULTS, bodyBreakout, clockOf, firstBreakout, type BreakoutSettings } from "@/lib/algo/hourly-breakout";
import { csvCell } from "@/lib/algo/report";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[index + 1]?.startsWith("--") || process.argv[index + 1] == null ? "1" : process.argv[++index]);
}
const DATA = path.resolve(args.get("data") ?? "");
const FROM = args.get("from") ?? "2026-08-01";
const TO = args.get("to") ?? "2026-09-30";
const EXPORT = path.resolve(args.get("export") ?? `../../backtests/Mathi-Hourly-Breakout-1pct-NIFTY-${FROM}-to-${TO}`) + (args.get("levels") === "rolling" ? "-rolling-levels" : "") + (args.has("experiment") ? `-exp-${args.get("experiment")}` : "") + (args.has("body") ? `-body-${args.get("body")}` : "") + (Number(args.get("dip") ?? 0) > 0 ? `-dip-${args.get("dip")}` : "") + (args.has("stop") ? `-stop-${args.get("stop")}` : "") + (args.has("maxhold") ? `-hold-${args.get("maxhold")}` : "") + (args.get("intrabar-price") === "worst" ? "-worst-price" : "") + (args.has("skip-dte") ? `-skip-dte-${args.get("skip-dte")}` : "") + (args.has("opp-exit") ? "-opp-exit" : "") + (args.has("third-exit") ? "-third-exit" : "") + (args.has("skip-narrow") ? `-skip-narrow-${args.get("skip-narrow")}` : "") + (args.has("skip-chase") ? `-skip-chase-${args.get("skip-chase")}` : "") + (args.has("skip-past1") ? `-skip-past1-${args.get("skip-past1")}` : "") + (args.has("opp-past1") ? `-opp-past1-${args.get("opp-past1")}` : "") + (args.has("keep-trend") ? `-keep-trend-${args.get("keep-trend")}` : "") + (args.has("opp-rush") ? `-opp-rush-${args.get("opp-rush")}` : "") + (args.has("skip-rush") ? `-skip-rush-${args.get("skip-rush")}` : "") + (args.has("keep-expiry") ? "-keep-expiry" : "") + (args.has("keep-ext") ? `-keep-ext-${args.get("keep-ext")}` : "") + (args.has("keep-extreme") ? `-keep-extreme-${args.get("keep-extreme")}` : "") + (args.has("ce-to-pe") ? `-ce-to-pe-${args.get("ce-to-pe")}` : "") + (args.has("wild-keep-dte") ? `-wkd-${args.get("wild-keep-dte")}` : "") + (args.has("cheap-flip") ? `-cheap-${args.get("cheap-flip")}` : "") + (args.has("near-extreme") ? `-near-ext-${args.get("near-extreme")}` : "") + (args.has("flip-tiny") ? `-flip-tiny-${args.get("flip-tiny")}` : "") + (args.has("target") ? `-target-${args.get("target")}pct` : "") + (args.has("reverse") ? "-REVERSE-diagnostic" : "");
const CAPITAL = 100_000;
const TICK = 0.05;
const TARGET_PERCENT = Number(args.get("target") ?? 1);
const STRIKE_STEP = 50;
const SQUARE_OFF = "15:20";
const MAX_LOTS = ALGO_DEFAULTS.lots;
const SLIP_TICKS = ALGO_DEFAULTS.slippageTicks;
/** Diagnostic only (--reverse): buy the other side at the same minute, to see whether the direction matters. */
const REVERSE = args.has("reverse");
/** Experiments (13 Nov 2026): A = rolling 20% breakout, B = + retest, C = + EMA 20 (5-min), D = + late-entry protection (20 pts). */
const EXPERIMENTS: Record<string, Partial<BreakoutSettings>> = {
  A: { levels: "rolling" },
  B: { levels: "rolling", retest: true, retestMinutes: 15, retestTolerancePercent: 0.02 },
  C: { levels: "rolling", retest: true, retestMinutes: 15, retestTolerancePercent: 0.02, emaPeriod: 20 },
  D: { levels: "rolling", retest: true, retestMinutes: 15, retestTolerancePercent: 0.02, emaPeriod: 20, maxChasePoints: 20 },
  E: { levels: "rolling", continuation: true },
  I: { levels: "rolling", intrabar: true },
  ATR: { levels: "rolling", atrBuffer: 0.2, atrPeriod: 14 },
  F: { levels: "rolling", candidate: true },
  "F-near-watch": { levels: "rolling", candidate: true, nearExtremePct: 0.25 },
  "F-near-opp": { levels: "rolling", candidate: true, nearExtremePct: 0.25, farAction: "opposite" },
  "F-near-late": { levels: "rolling", candidate: true, nearExtremePct: 0.25, farAction: "late-opposite" },
  F2: { levels: "rolling", candidate: true, weakEnters: true },
  F3: { levels: "rolling", candidate: true, weakEnters: true, weakEntersMinBreak: 0.5 },
  G: { levels: "rolling", crossEntry: true },
  H: { levels: "rolling", candidate: true, immediateSides: ["CALL"] },
  "G-opp": { levels: "rolling", crossEntry: true, oppositeOnNoCross: true },
  "E-fixed": { levels: "fixed", continuation: true },
};
const EXPERIMENT = args.get("experiment");
const SETTINGS: BreakoutSettings = { ...BREAKOUT_DEFAULTS, levels: args.get("levels") === "rolling" ? "rolling" : "fixed", ...(EXPERIMENT ? EXPERIMENTS[EXPERIMENT] : {}), ...(args.has("body") ? { bodyShare: Number(args.get("body")) / 100 } : {}) };
const COMPARE = !args.has("no-compare");
/** Dip entry (13 Nov 2026, `--dip 3`): after the breakout, a resting buy at the breakout-minute premium − dip%; filled only
 * when a later premium candle with volume trades a tick through it, before the 14:15 entry cutoff. Not filled = missed. */
const DIP = Number(args.get("dip") ?? 0);
/** Loss controls (13 Nov 2026): `--stop 20` sells once the premium trades 20% below the entry (checked before the target
 * in the same minute: conservative); `--maxhold 30` sells at the close of the 30th minute when the target has not filled. */
const STOP = Number(args.get("stop") ?? 0);
const MAX_HOLD = Number(args.get("maxhold") ?? 0);
/** Intrabar entry price: "delta" = option open + 0.5 × NIFTY's move from the minute's open to the trigger (clipped to the
 * option minute's range); "worst" = the option minute's high. */
/** Loss experiments on F (13 Nov 2026): `--skip-dte 0` no entry on expiry day, `--skip-dte 1` none at 0–1 DTE;
 * `--opp-exit` sells when a completed NIFTY candle breaks the trade hour's OPPOSITE level with the 20% body rule. */
const SKIP_DTE = args.has("skip-dte") ? Number(args.get("skip-dte")) : -1;
const OPP_EXIT = args.has("opp-exit");
/** `--third-exit` (13 Nov 2026): sell when the first NIFTY candle after the entry (the 3rd candle) closes back inside the line. */
const THIRD_EXIT = args.has("third-exit");
/** Entry-time skips (13 Nov 2026): `--skip-narrow 50` no trade when the hour candle that set the line is ≤ 50 pts;
 * `--skip-chase 30` no trade when NIFTY moved > 30 pts in the trade's direction over the 15 minutes before the entry candle. */
const SKIP_NARROW = Number(args.get("skip-narrow") ?? 0);
const SKIP_CHASE = Number(args.get("skip-chase") ?? 0);
/** `--skip-past1 5`: no trade when the 20% breakout candle CLOSED more than 5 pts past the line (a late, stretched break). */
const SKIP_PAST1 = Number(args.get("skip-past1") ?? 0);
/** `--opp-past1 5`: when the breakout candle closed more than 5 pts past the line, buy the OPPOSITE option at F's entry. */
const OPP_PAST1 = Number(args.get("opp-past1") ?? 0);
/** `--keep-trend 100`: no opposite flip when NIFTY already moved > 100 pts from the 09:15 open in the breakout direction.
 * `--opp-rush 50`: a normal trade after a > 50-pt run in the 15 min before the entry candle is flipped to the opposite.
 * `--skip-rush 50`: such a normal trade is skipped instead. */
const KEEP_TREND = Number(args.get("keep-trend") ?? 0);
const OPP_RUSH = Number(args.get("opp-rush") ?? 0);
const SKIP_RUSH = Number(args.get("skip-rush") ?? 0);
/** Keep the normal side (no opposite flip) when: `--keep-expiry` it is expiry day; `--keep-ext 15` the 2nd candle closed
 * more than 15 pts further past the line than the 1st; `--keep-extreme 80` NIFTY already moved > 80 pts from the day's
 * high (PUT) / low (CALL) in the breakout direction. */
const KEEP_EXPIRY = args.has("keep-expiry");
const KEEP_EXT = Number(args.get("keep-ext") ?? 0);
const KEEP_EXTREME = Number(args.get("keep-extreme") ?? 0);
/** `--ce-to-pe 180` (Rule 2, 13 Nov 2026): when the final choice is a CE and NIFTY's day range (high − low up to the entry
 * candle) is more than 180 pts, buy the PE instead. */
const CE_TO_PE = Number(args.get("ce-to-pe") ?? 0);
/** `--wild-keep-dte 3`: Rule 2 is NOT applied when NIFTY is below the 09:15 open and the contract has ≥ 3 days to expiry.
 * `--cheap-flip 25`: when the option to buy costs less than ₹25, buy the other side instead (13 Nov 2026, user). */
const WILD_KEEP_DTE = Number(args.get("wild-keep-dte") ?? 0);
const CHEAP_FLIP = Number(args.get("cheap-flip") ?? 0);
/** `--near-extreme 0.25` (13 Nov 2026, 3-year rule): trade a CALL only when NIFTY at entry is within 0.25% of the day's
 * high so far, a PUT only within 0.25% of the day's low so far; otherwise no trade that day. */
const NEAR_EXTREME = Number(args.get("near-extreme") ?? 0);
/** `--flip-tiny 1.4` (13 Nov 2026): when the 20% breakout candle closed less than 1.4 pts past the line, buy the other option. */
const FLIP_TINY = Number(args.get("flip-tiny") ?? 0);
const INTRABAR_PRICE = args.get("intrabar-price") === "worst" ? "worst" : "delta";

const unix = (date: string, time: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +time.slice(0, 2), +time.slice(3, 5)) / 1000 - 19_800;
const lotSizeOf = (expiry: string) => (expiry <= "2024-04-25" ? 50 : expiry <= "2024-12-24" ? 25 : expiry <= "2025-12-30" ? 75 : 65);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const r2 = (value: number) => Math.round(value * 100) / 100;
const paise = (rupees: number) => BigInt(Math.round(rupees * 100));
const charge = (side: "BUY" | "SELL", premium: number, quantity: number) => Number(optionCharges(side, paise(premium), quantity).total) / 100;

async function lines(file: string, each: (cells: string[]) => void) {
  const reader = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = true;
  for await (const line of reader) {
    if (header) { header = false; continue; }
    if (line) each(line.split(","));
  }
}

type Day = { date: string; candles: Candle[]; expiry: string; tapes: Map<string, Candle[]> };

async function loadDays(): Promise<{ days: Day[]; noOptions: string[] }> {
  const nifty = new Map<string, Candle[]>();
  await lines(path.join(DATA, "05-nifty-1min-candles.csv"), ([raw, time, open, high, low, close]) => {
    const date = raw.replace(/^﻿/, "");
    if (date < FROM || date > TO) return;
    const list = nifty.get(date) ?? [];
    list.push({ time: unix(date, time), open: +open, high: +high, low: +low, close: +close });
    nifty.set(date, list);
  });
  const options = new Map<string, { expiry: string; tapes: Map<string, Candle[]> }>();
  await lines(path.join(DATA, "07-nifty-weekly-options-1min.csv"), ([raw, time, expiry, strike, type, open, high, low, close, volume]) => {
    const date = raw.replace(/^﻿/, "");
    if (date < FROM || date > TO || expiry === "after range") return;
    const day = options.get(date) ?? { expiry, tapes: new Map() };
    const key = `${+strike}|${type}`;
    const tape = day.tapes.get(key) ?? [];
    tape.push({ time: unix(date, time), open: +open, high: +high, low: +low, close: +close, volume: +volume });
    day.tapes.set(key, tape);
    options.set(date, day);
  });
  const days: Day[] = [];
  const noOptions: string[] = [];
  for (const [date, candles] of [...nifty.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const option = options.get(date);
    if (!option) { noOptions.push(date); continue; }
    for (const tape of option.tapes.values()) tape.sort((a, b) => a.time - b.time);
    days.push({ date, candles: candles.sort((a, b) => a.time - b.time), expiry: option.expiry, tapes: option.tapes });
  }
  return { days, noOptions };
}

/* ---------------- 1% breakout ---------------- */

type BreakoutRow = {
  date: string; expiry: string; dte: number; c2High: number | null; c2Low: number | null; direction: string; confirmTime: string; bucket: string;
  bOpen: number | null; bHigh: number | null; bLow: number | null; bClose: number | null; beyondPercent: number | null;
  spot: number | null; strike: number | null; type: string; entryPremium: number | null; targetPremium: number | null; exitTime: string; exitPremium: number | null; exitReason: string;
  lots: number; quantity: number; gross: number | null; charges: number | null; slippage: number | null; net: number | null; result: string;
  holdMinutes: number | null; maxFavPct: number | null; maxAdvPct: number | null; touchTime: string; reversed15: string; reversedBeforeExit: string; note: string;
};

const bucketOf = (clock: string) => (clock <= "12:00" ? "11:15–12:00" : clock <= "13:00" ? "12:00–13:00" : clock <= "14:00" ? "13:00–14:00" : "14:00–14:15");

function runBreakout(day: Day): BreakoutRow {
  const { levels, signal, reason } = firstBreakout(day.candles, SETTINGS);
  const row: BreakoutRow = {
    date: day.date, expiry: day.expiry, dte: daysBetween(day.date, day.expiry), c2High: levels?.high ?? null, c2Low: levels?.low ?? null, direction: signal?.side ?? "NONE", confirmTime: "", bucket: "",
    bOpen: null, bHigh: null, bLow: null, bClose: null, beyondPercent: null, spot: null, strike: null, type: "", entryPremium: null, targetPremium: null, exitTime: "", exitPremium: null, exitReason: "",
    lots: 0, quantity: 0, gross: null, charges: null, slippage: null, net: null, result: "NO TRADE", holdMinutes: null, maxFavPct: null, maxAdvPct: null, touchTime: "", reversed15: "", reversedBeforeExit: "", note: reason,
  };
  if (!signal) return row;
  if (SKIP_NARROW > 0 && levels && levels.high - levels.low <= SKIP_NARROW) { Object.assign(row, { result: "SKIPPED", confirmTime: clockOf(signal.candle.time + 60), note: `${reason} Skipped: line hour range ${(levels.high - levels.low).toFixed(2)} ≤ ${SKIP_NARROW}.` }); return row; }
  if (NEAR_EXTREME > 0) {
    const sofar = day.candles.filter((candle) => candle.time <= signal.candle.time);
    const dist = signal.side === "CALL" ? Math.max(...sofar.map((candle) => candle.high)) - signal.candle.close : signal.candle.close - Math.min(...sofar.map((candle) => candle.low));
    const pct = (dist / signal.candle.close) * 100;
    if (pct > NEAR_EXTREME) { Object.assign(row, { result: "SKIPPED", confirmTime: clockOf(signal.candle.time + 60), note: `${reason} Skipped: ${dist.toFixed(2)} pts (${pct.toFixed(3)}%) from the day's ${signal.side === "CALL" ? "high" : "low"} (> ${NEAR_EXTREME}%).` }); return row; }
  }
  if (SKIP_PAST1 > 0 && signal.first) {
    const past = signal.side === "CALL" ? signal.first.close - signal.level : signal.level - signal.first.close;
    if (past > SKIP_PAST1) { Object.assign(row, { result: "SKIPPED", confirmTime: clockOf(signal.candle.time + 60), note: `${reason} Skipped: breakout candle closed ${past.toFixed(2)} pts past the line (> ${SKIP_PAST1}).` }); return row; }
  }
  if (SKIP_CHASE > 0) {
    const from = day.candles.find((candle) => candle.time === signal.candle.time - 15 * 60);
    const run = from ? (signal.side === "CALL" ? signal.candle.close - from.open : from.open - signal.candle.close) : 0;
    if (run > SKIP_CHASE) { Object.assign(row, { result: "SKIPPED", confirmTime: clockOf(signal.candle.time + 60), note: `${reason} Skipped: NIFTY already ran ${run.toFixed(2)} pts our way in 15 min (> ${SKIP_CHASE}).` }); return row; }
  }
  if (row.dte <= SKIP_DTE) { Object.assign(row, { result: "SKIPPED", confirmTime: clockOf(signal.candle.time + 60), note: `${reason} Skipped: ${row.dte} day(s) to expiry (no entries at ≤ ${SKIP_DTE} DTE).` }); return row; }
  const intrabar = signal.trigger != null;
  // Closed-candle entry: at the candle's close. Intrabar: inside the candle (the target is checked from the next minute).
  const confirm = intrabar ? signal.candle.time : signal.candle.time + 60;
  Object.assign(row, { confirmTime: clockOf(confirm), bucket: bucketOf(clockOf(confirm)), bOpen: signal.candle.open, bHigh: signal.candle.high, bLow: signal.candle.low, bClose: signal.candle.close, beyondPercent: signal.beyondPercent });
  const spot = signal.trigger ?? signal.candle.close;
  const strike = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
  const past1 = signal.first ? (signal.side === "CALL" ? signal.first.close - signal.level : signal.level - signal.first.close) : 0;
  const dir = signal.side === "CALL" ? 1 : -1;
  const dayMove = dir * (signal.candle.close - day.candles[0].open);
  const rushFrom = day.candles.find((candle) => candle.time === signal.candle.time - 15 * 60);
  const rush = rushFrom ? dir * (signal.candle.close - rushFrom.open) : 0;
  const ext = signal.first ? dir * (signal.candle.close - signal.first.close) : 0;
  const before = day.candles.filter((candle) => candle.time <= signal.candle.time);
  const fromExtreme = dir > 0 ? signal.candle.close - Math.min(...before.map((candle) => candle.low)) : Math.max(...before.map((candle) => candle.high)) - signal.candle.close;
  const keepNormal = (KEEP_TREND > 0 && dayMove > KEEP_TREND) || (KEEP_EXPIRY && row.dte === 0) || (KEEP_EXT > 0 && ext > KEEP_EXT) || (KEEP_EXTREME > 0 && fromExtreme > KEEP_EXTREME);
  let flip = (OPP_PAST1 > 0 && past1 > OPP_PAST1 && !keepNormal) || (FLIP_TINY > 0 && signal.first != null && past1 < FLIP_TINY);
  const normal = !flip && !(OPP_PAST1 > 0 && past1 > OPP_PAST1);
  if (normal && SKIP_RUSH > 0 && rush > SKIP_RUSH) { Object.assign(row, { result: "SKIPPED", note: `${reason} Skipped: ${rush.toFixed(2)}-pt rush in 15 min before entry (> ${SKIP_RUSH}).` }); return row; }
  if (normal && OPP_RUSH > 0 && rush > OPP_RUSH) flip = true;
  const dayRange = Math.max(...before.map((candle) => candle.high)) - Math.min(...before.map((candle) => candle.low));
  const chosen = (signal.side === "CALL") !== (REVERSE || flip) ? "CE" : "PE";
  const belowOpen = signal.candle.close < day.candles[0].open;
  const wildSwitch = CE_TO_PE > 0 && chosen === "CE" && dayRange > CE_TO_PE && !(WILD_KEEP_DTE > 0 && belowOpen && row.dte >= WILD_KEEP_DTE);
  let type: "CE" | "PE" = wildSwitch ? "PE" : chosen;
  let cheapFlip = false;
  if (CHEAP_FLIP > 0) {
    const firstTape = day.tapes.get(`${strike}|${type}`) ?? [];
    const firstQuote = [...firstTape].reverse().find((candle) => candle.time <= signal.candle.time && signal.candle.time - candle.time <= 60);
    if (firstQuote && firstQuote.close < CHEAP_FLIP) { type = type === "CE" ? "PE" : "CE"; cheapFlip = true; }
  }
  Object.assign(row, { spot, strike, type });
  const tape = day.tapes.get(`${strike}|${type}`) ?? [];
  // The premium known at the confirmation: that minute's candle, or the one before (90-second quote-age limit).
  const quote = [...tape].reverse().find((candle) => candle.time <= signal.candle.time && signal.candle.time - candle.time <= 60) ?? null;
  if (!quote) { Object.assign(row, { result: "NO TRADE", note: `${reason} No fresh ${strike} ${type} premium at ${clockOf(confirm)} in the data: not traded.` }); return row; }
  let entry = r2(quote.close + SLIP_TICKS * TICK);
  let entryStart = confirm;
  if (intrabar) {
    const minute = tape.find((candle) => candle.time === signal.candle.time);
    if (!minute) { Object.assign(row, { result: "NO TRADE", note: `${reason} No ${strike} ${type} premium in the ${clockOf(signal.candle.time)} minute: not traded.` }); return row; }
    const move = Math.abs(signal.trigger! - signal.candle.open);
    const estimate = INTRABAR_PRICE === "worst" ? minute.high : Math.min(minute.high, Math.max(minute.low, minute.open + 0.5 * move));
    entry = r2(estimate + SLIP_TICKS * TICK);
    entryStart = signal.candle.time + 60;
  }
  let entrySlip = SLIP_TICKS;
  if (DIP > 0) {
    const limit = r2(Math.floor((quote.close * (1 - DIP / 100)) / TICK + 1e-9) * TICK);
    const cutoff = unix(day.date, SETTINGS.entryCutoff);
    const fill = tape.find((candle) => candle.time >= confirm && candle.time + 60 <= cutoff && (candle.volume ?? 0) > 0 && candle.low <= limit - TICK + 1e-9);
    if (!fill) { Object.assign(row, { result: "MISSED", entryPremium: limit, note: `${reason} Breakout premium ${quote.close}; the ${DIP}% dip to ${limit} never traded by ${SETTINGS.entryCutoff}: missed.` }); return row; }
    entry = limit;
    entryStart = fill.time + 60;
    entrySlip = 0;
  }
  const sized = allocateLots({ price: entry, lotSize: lotSizeOf(day.expiry), cash: CAPITAL, settings: ALLOCATION_DEFAULTS, maxLots: MAX_LOTS, charges: charge });
  if (!sized.ok) { Object.assign(row, { result: "NO TRADE", entryPremium: entry, note: `${reason} ${sized.reason}` }); return row; }
  const quantity = sized.plan.quantity;
  const target = r2(entry * (1 + TARGET_PERCENT / 100));
  const squareOff = unix(day.date, SQUARE_OFF);
  let exit: { time: number; price: number; reason: string } | null = null;
  let touch: number | null = null, maxHigh = entry, minLow = entry;
  // Opposite-breakout exit: the first completed NIFTY candle after the entry breaking the trade hour's opposite level.
  const oppLevel = signal.side === "CALL" ? levels!.low : levels!.high;
  const oppSide = signal.side === "CALL" ? "PUT" : "CALL";
  const third = THIRD_EXIT ? day.candles.find((candle) => candle.time === entryStart) ?? null : null;
  const thirdBack = third && (signal.side === "CALL" ? third.close < signal.level : third.close > signal.level) ? third : null;
  const oppCandle = OPP_EXIT ? day.candles.find((candle) => candle.time >= entryStart && candle.time + 60 <= squareOff && bodyBreakout(candle, oppSide, oppLevel, SETTINGS.bodyShare)) ?? null : thirdBack;
  const oppTime = oppCandle?.time ?? null;
  let lastOpt: Candle | null = null;
  const oppExit = (option: Candle | null) => {
    const fresh = option && oppTime! - option.time <= 600 ? option : null;
    if (!fresh) return null;
    return { time: oppTime! + 60, price: r2(Math.max(TICK, fresh.close - SLIP_TICKS * TICK)), reason: THIRD_EXIT ? `third-candle exit (NIFTY ${clockOf(oppTime!)} closed ${oppCandle!.close} back inside ${signal.level})` : `opposite-breakout exit (NIFTY ${clockOf(oppTime!)} closed ${oppCandle!.close} beyond ${oppLevel})` };
  };
  for (const candle of tape) {
    if (candle.time < entryStart || candle.time + 60 > squareOff) continue;
    if (oppTime != null && candle.time > oppTime) { exit = oppExit(lastOpt); if (exit) break; }
    maxHigh = Math.max(maxHigh, candle.high);
    minLow = Math.min(minLow, candle.low);
    if (touch == null && candle.high >= target) touch = candle.time;
    const stopPrice = STOP > 0 ? r2(entry * (1 - STOP / 100)) : 0;
    if (STOP > 0 && candle.low <= stopPrice) { exit = { time: candle.time + 60, price: r2(Math.max(TICK, Math.min(stopPrice, candle.open) - SLIP_TICKS * TICK)), reason: `stop-loss −${STOP}%` }; break; }
    if ((candle.volume ?? 0) > 0 && candle.high >= target + TICK - 1e-9) { exit = { time: candle.time + 60, price: target, reason: "1% target" }; break; }
    if (MAX_HOLD > 0 && candle.time + 60 >= entryStart + MAX_HOLD * 60) { exit = { time: candle.time + 60, price: r2(Math.max(TICK, candle.close - SLIP_TICKS * TICK)), reason: `time exit ${MAX_HOLD} min` }; break; }
    lastOpt = candle;
    if (oppTime != null && candle.time === oppTime) { exit = oppExit(candle); if (exit) break; }
  }
  if (!exit && oppTime != null) exit = oppExit(lastOpt);
  if (!exit) {
    const last = [...tape].reverse().find((candle) => candle.time + 60 <= squareOff);
    if (!last) { Object.assign(row, { result: "DATA GAP", note: `${reason} No premium after the entry: not counted.` }); return row; }
    const stale = squareOff - (last.time + 60) > 600;
    exit = { time: squareOff, price: r2(Math.max(TICK, last.close - SLIP_TICKS * TICK)), reason: stale ? "15:20 square-off (last premium older than 10 min)" : "15:20 square-off" };
  }
  const charges = r2(charge("BUY", entry, quantity) + charge("SELL", exit.price, quantity));
  const gross = r2((exit.price - entry) * quantity);
  const slippage = r2(TICK * quantity * (entrySlip + (exit.reason.startsWith("1%") ? 0 : SLIP_TICKS)));
  const net = r2(gross - charges);
  // Did NIFTY close back through the broken level (inside candle 2's range side) after the confirmation?
  const back = (candle: Candle) => (signal.side === "CALL" ? candle.close < signal.level : candle.close > signal.level);
  const after = day.candles.filter((candle) => candle.time >= confirm);
  const reversed15 = after.filter((candle) => candle.time < confirm + 15 * 60).some(back);
  const reversedBeforeExit = after.filter((candle) => candle.time + 60 <= exit!.time).some(back);
  Object.assign(row, {
    entryPremium: entry, targetPremium: target, exitTime: clockOf(exit.time), exitPremium: exit.price, exitReason: exit.reason, lots: sized.plan.lots, quantity, gross, charges, slippage, net,
    result: net > 0 ? "WIN" : "LOSS", holdMinutes: Math.round((exit.time - entryStart) / 60), maxFavPct: r2(((maxHigh - entry) / entry) * 100), maxAdvPct: r2(((minLow - entry) / entry) * 100),
    touchTime: touch != null ? clockOf(touch + 60) : "", reversed15: reversed15 ? "yes" : "no", reversedBeforeExit: reversedBeforeExit ? "yes" : "no",
    note: `${cheapFlip ? `CHEAP OPTION → OTHER SIDE ${type}. ` : ""}${wildSwitch ? `WILD DAY CE→PE (day range ${dayRange.toFixed(2)} > ${CE_TO_PE}). ` : ""}${flip ? `OPPOSITE ${type} (breakout candle ${past1.toFixed(2)} pts past the line, 15-min rush ${rush.toFixed(2)}). ` : (OPP_PAST1 > 0 && past1 > OPP_PAST1 ? `KEPT NORMAL (from open ${dayMove.toFixed(2)}, from day extreme ${fromExtreme.toFixed(2)}, 2nd-candle push ${ext.toFixed(2)}, DTE ${row.dte}). ` : "")}${reason}${DIP > 0 ? ` Breakout premium ${quote.close}; bought on the ${DIP}% dip at ${entry}, ${clockOf(entryStart)}.` : ""} ${sized.plan.note}`,
  });
  return row;
}

/* ---------------- existing 5% (unchanged) ---------------- */

type ZoneRow = { date: string; side: string; contract: string; entryTime: string; exitTime: string; entryPremium: number; exitPremium: number | null; exitReason: string; quantity: number; gross: number | null; charges: number; net: number | null; result: string; holdMinutes: number | null; committed: number };

async function runZone(day: Day, config: AlgoConfig): Promise<ZoneRow[]> {
  const strikes = [...new Set([...day.tapes.keys()].map((key) => +key.split("|")[0]))].sort((a, b) => a - b);
  const chain: ReplayChain = { symbol: "NIFTY", expiry: day.expiry, kind: "index", lotSize: lotSizeOf(day.expiry), strikes: strikes.map((strike) => ({ strike, ce: { securityId: `CE:${strike}` }, pe: { securityId: `PE:${strike}` } })) };
  const adapter = createReplayAdapter({ candles: day.candles, chain, config, capital: CAPITAL, tapeOf: async (contract) => day.tapes.get(`${contract.strike}|${contract.right}`) ?? [] });
  const { events, state } = await simulateSession({ sessionId: `${day.date}.mh`, date: day.date, config, candles: day.candles, lines: [], adapter, startNote: "Mathi Hourly Zone 5% comparison backtest." });
  return algoTrades(events, state.position ? { entryKey: state.position.entryKey, exitPending: Boolean(state.position.exit) } : null)
    .filter((trade) => trade.status === "COMPLETED" && !trade.shadow)
    .map((trade) => ({
      date: day.date, side: trade.side, contract: trade.contract, entryTime: clockOf(trade.entryTime), exitTime: trade.exitTime ? clockOf(trade.exitTime) : "", entryPremium: trade.entryPremium, exitPremium: trade.exitPremium,
      exitReason: trade.exitReason ?? "", quantity: trade.quantity, gross: trade.gross, charges: r2(trade.entryCharges + trade.exitCharges), net: trade.realized, result: (trade.realized ?? 0) > 0 ? "WIN" : "LOSS",
      holdMinutes: trade.durationMinutes, committed: r2(trade.entryPremium * trade.quantity + trade.entryCharges),
    }));
}

/* ---------------- report ---------------- */

const csv = (rows: Array<Record<string, unknown>>) => (rows.length ? [Object.keys(rows[0]).map(csvCell).join(","), ...rows.map((row) => Object.values(row).map((value) => csvCell(value as string | number | null)).join(","))].join("\r\n") + "\r\n" : "");
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const sum = (values: Array<number | null>) => r2(values.reduce<number>((total, value) => total + (value ?? 0), 0));
function drawdown(nets: number[]) {
  let equity = 0, peak = 0, worst = 0;
  for (const net of nets) { equity += net; peak = Math.max(peak, equity); worst = Math.min(worst, equity - peak); }
  return r2(worst);
}

async function main() {
  const log: string[] = [];
  const say = (text: string) => { console.log(text); log.push(`${new Date().toISOString()} ${text}`); };
  say(`Data ${DATA}, sessions ${FROM} → ${TO}`);
  const { days, noOptions } = await loadDays();
  say(`${days.length} sessions with NIFTY candles and option premiums; ${noOptions.length} without premiums (not reported): ${noOptions.join(" ") || "none"}`);
  const zoneConfig: AlgoConfig = { ...readAlgoConfig(JSON.parse(JSON.stringify(MATHI_HOURLY_DEFAULTS))), engine: "hourly", mode: "REPLAY" };
  const breakout: BreakoutRow[] = [];
  const zone: ZoneRow[] = [];
  for (const day of days) {
    if (day.candles.length < 375) say(`${day.date}: ${day.candles.length} NIFTY minutes (expected 375)`);
    const row = runBreakout(day);
    breakout.push(row);
    if (COMPARE) zone.push(...(await runZone(day, zoneConfig)));
    say(`${day.date} 1%: ${row.direction} ${row.confirmTime} ${row.result} ${row.net ?? ""} | 5%: ${zone.filter((t) => t.date === day.date).map((t) => `${t.side} ${t.exitReason} ${t.net}`).join("; ") || "no trade"}`);
  }
  const trades = breakout.filter((row) => row.result === "WIN" || row.result === "LOSS");
  const wins = trades.filter((row) => row.result === "WIN"), losses = trades.filter((row) => row.result === "LOSS");
  const hits = trades.filter((row) => row.exitReason === "1% target");
  const overall = {
    "Period": `${days[0]?.date} to ${days.at(-1)?.date}`, "Trading days": days.length, "Valid breakout signals": breakout.filter((row) => row.direction !== "NONE").length,
    "Trades": trades.length, "CALL trades": trades.filter((row) => row.direction === "CALL").length, "PUT trades": trades.filter((row) => row.direction === "PUT").length,
    "No-trade days": days.length - trades.length, "Wins": wins.length, "Losses": losses.length, "Win rate %": pct(wins.length, trades.length),
    "1% target hit": hits.length, "Target hit %": pct(hits.length, trades.length), "Touched target (no trade-through)": trades.filter((row) => row.touchTime && row.exitReason !== "1% target").length,
    "Gross profit ₹": sum(trades.filter((row) => (row.gross ?? 0) > 0).map((row) => row.gross)), "Gross loss ₹": sum(trades.filter((row) => (row.gross ?? 0) <= 0).map((row) => row.gross)),
    "Charges ₹": sum(trades.map((row) => row.charges)), "Slippage cost ₹": sum(trades.map((row) => row.slippage)), "Net P&L ₹": sum(trades.map((row) => row.net)),
    "Return % (on ₹1,00,000)": r2((sum(trades.map((row) => row.net)) / CAPITAL) * 100),
    "Avg win ₹": wins.length ? r2(sum(wins.map((row) => row.net)) / wins.length) : null, "Avg loss ₹": losses.length ? r2(sum(losses.map((row) => row.net)) / losses.length) : null,
    "Max drawdown ₹": drawdown(trades.map((row) => row.net ?? 0)),
    "Best trade": trades.length ? (() => { const t = trades.reduce((a, b) => ((b.net ?? 0) > (a.net ?? 0) ? b : a)); return `${t.date} ${t.direction} ${t.net}`; })() : "",
    "Worst trade": trades.length ? (() => { const t = trades.reduce((a, b) => ((b.net ?? 0) < (a.net ?? 0) ? b : a)); return `${t.date} ${t.direction} ${t.net}`; })() : "",
  };
  const sideStats = (side: string) => {
    const list = trades.filter((row) => row.direction === side);
    return { Side: side, Trades: list.length, Wins: list.filter((row) => row.result === "WIN").length, Losses: list.filter((row) => row.result === "LOSS").length, "Win rate %": pct(list.filter((row) => row.result === "WIN").length, list.length), "Target hit %": pct(list.filter((row) => row.exitReason === "1% target").length, list.length), "Net P&L ₹": sum(list.map((row) => row.net)), "Avg hold (min)": list.length ? Math.round(sum(list.map((row) => row.holdMinutes)) / list.length) : null };
  };
  const buckets = ["11:15–12:00", "12:00–13:00", "13:00–14:00", "14:00–14:15"].map((bucket) => {
    const list = trades.filter((row) => row.bucket === bucket);
    const hit = list.filter((row) => row.exitReason === "1% target").length;
    return { "Breakout time": bucket, Trades: list.length, Wins: list.filter((row) => row.result === "WIN").length, Losses: list.filter((row) => row.result === "LOSS").length, "Reached +1 % (%)": pct(hit, list.length), "Failed +1 % (%)": pct(list.length - hit, list.length), "Avg max favourable %": list.length ? r2(sum(list.map((row) => row.maxFavPct)) / list.length) : null, "Avg max adverse %": list.length ? r2(sum(list.map((row) => row.maxAdvPct)) / list.length) : null, "NIFTY back through level within 15 min": list.filter((row) => row.reversed15 === "yes").length, "Net P&L ₹": sum(list.map((row) => row.net)) };
  });
  const zoneWins = zone.filter((t) => t.result === "WIN");
  const compare = [
    { Strategy: "1% Hourly Breakout (new)", Sessions: days.length, Trades: trades.length, Wins: wins.length, Losses: losses.length, "Win rate %": pct(wins.length, trades.length), "Target hit %": pct(hits.length, trades.length), "Net P&L ₹": sum(trades.map((r) => r.net)), "Avg net / trade ₹": trades.length ? r2(sum(trades.map((r) => r.net)) / trades.length) : null, "Max drawdown ₹": drawdown(trades.map((r) => r.net ?? 0)), "CALL net ₹": sum(trades.filter((r) => r.direction === "CALL").map((r) => r.net)), "PUT net ₹": sum(trades.filter((r) => r.direction === "PUT").map((r) => r.net)), "Avg capital used %": trades.length ? r2(sum(trades.map((r) => (r.entryPremium ?? 0) * r.quantity)) / trades.length / CAPITAL * 100) : null },
    { Strategy: "Mathi Hourly Zone 5% (existing, unchanged)", Sessions: days.length, Trades: zone.length, Wins: zoneWins.length, Losses: zone.length - zoneWins.length, "Win rate %": pct(zoneWins.length, zone.length), "Target hit %": pct(zone.filter((t) => /target/i.test(t.exitReason)).length, zone.length), "Net P&L ₹": sum(zone.map((t) => t.net)), "Avg net / trade ₹": zone.length ? r2(sum(zone.map((t) => t.net)) / zone.length) : null, "Max drawdown ₹": drawdown(zone.map((t) => t.net ?? 0)), "CALL net ₹": sum(zone.filter((t) => t.side === "CALL").map((t) => t.net)), "PUT net ₹": sum(zone.filter((t) => t.side === "PUT").map((t) => t.net)), "Avg capital used %": zone.length ? r2(sum(zone.map((t) => t.committed)) / zone.length / CAPITAL * 100) : null },
  ];
  let equity = 0, peak = 0;
  const daily = breakout.map((row) => { equity = r2(equity + (row.net ?? 0)); peak = Math.max(peak, equity); return { Date: row.date, Direction: row.direction, Result: row.result, "Net P&L ₹": row.net ?? 0, "Cumulative ₹": equity, "Drawdown ₹": r2(equity - peak), "5% strategy net ₹": sum(zone.filter((t) => t.date === row.date).map((t) => t.net)) }; });
  const files: Record<string, string> = {
    "01-summary-1pct.csv": csv([overall]),
    "02-trades-1pct-all-days.csv": csv(breakout.map((row) => ({
      Date: row.date, Expiry: row.expiry, "Days to expiry": row.dte, "Candle 2 HIGH": row.c2High, "Candle 2 LOW": row.c2Low, "First breakout": row.direction, "Confirmed (IST)": row.confirmTime,
      "1m open": row.bOpen, "1m high": row.bHigh, "1m low": row.bLow, "1m close": row.bClose, "Body beyond level %": row.beyondPercent, "NIFTY at entry": row.spot, "ATM strike": row.strike, Type: row.type,
      "Entry premium": row.entryPremium, "Target premium": row.targetPremium, "Exit (IST)": row.exitTime, "Exit premium": row.exitPremium, "Exit reason": row.exitReason, Lots: row.lots, Quantity: row.quantity,
      "Gross P&L ₹": row.gross, "Charges ₹": row.charges, "Slippage ₹": row.slippage, "Net P&L ₹": row.net, Result: row.result, "Hold (min)": row.holdMinutes, "Max favourable %": row.maxFavPct, "Max adverse %": row.maxAdvPct,
      "First touch of target (IST)": row.touchTime, "NIFTY back through level ≤15 min": row.reversed15, "NIFTY back through level before exit": row.reversedBeforeExit, Notes: row.note,
    }))),
    "03-call-vs-put-1pct.csv": csv(["CALL", "PUT"].map(sideStats)),
    "04-breakout-time-1pct.csv": csv(buckets),
    "05-daily-equity-drawdown.csv": csv(daily),
    "06-compare-1pct-vs-5pct.csv": csv(compare),
    "07-trades-5pct-existing.csv": csv(zone.map((t) => ({ Date: t.date, Side: t.side, Contract: t.contract, "Entry (IST)": t.entryTime, "Exit (IST)": t.exitTime, "Entry premium": t.entryPremium, "Exit premium": t.exitPremium, "Exit reason": t.exitReason, Quantity: t.quantity, "Gross P&L ₹": t.gross, "Charges ₹": t.charges, "Net P&L ₹": t.net, Result: t.result, "Hold (min)": t.holdMinutes }))),
  };
  mkdirSync(EXPORT, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(EXPORT, name), `﻿${text}`);
  writeFileSync(path.join(EXPORT, "08-config.json"), JSON.stringify({
    run: new Date().toISOString(), command: `npx tsx scripts/backtest-mathi-hourly-breakout.ts --data "${DATA}" --from ${FROM} --to ${TO} --export "${EXPORT}"`,
    data: DATA, from: FROM, to: TO, sessions: days.length, sessionsWithoutPremiums: noOptions,
    breakout: { ...SETTINGS, candle2: "10:15–11:15 (all 60 minutes)", levels: "candle 2 HIGH (CALL) / LOW (PUT), fixed", watchFrom: "11:15 candle", oneTradePerDay: true, fallback: false },
    execution: { capital: CAPITAL, maxLots: MAX_LOTS, sizing: ALLOCATION_DEFAULTS, strikeStep: STRIKE_STEP, strike: "nearest 50 to NIFTY close at the breakout minute", expiry: "nearest weekly (export)", entry: "option close of the breakout minute (or the minute before) + 1 tick", targetPercent: TARGET_PERCENT, targetFill: "a later option candle with volume > 0 trading ≥ 1 tick through the target; filled at the target", stopLoss: false, squareOff: SQUARE_OFF, squareOffPrice: "15:19 premium close − 1 tick", charges: "app ledger optionCharges (brokerage, STT, exchange, SEBI, stamp, GST)" },
    existing5pct: zoneConfig,
  }, null, 2));
  writeFileSync(path.join(EXPORT, "09-run-log.txt"), log.join("\n") + "\n");
  console.log(JSON.stringify({ overall, sides: ["CALL", "PUT"].map(sideStats), buckets, compare }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
