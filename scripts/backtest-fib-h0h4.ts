/**
 * 5-Minute H0–H4 Fibonacci Breakout (NIFTY ATM CE, CALL BUY only) — historical backtest on real weekly option premiums.
 * Same engine as paper trading (src/lib/algo/fib-h0h4.ts); nothing is optimised. Paper/backtest only: no orders.
 *
 *   python scripts/export-fib-breakout-data.py --from 2021-11-01 --to 2026-11-12 --expiry-rule --atm-only --atm-time 09:19 --out <folder>/data
 *   npx tsx scripts/backtest-fib-h0h4.ts --data <folder>/data [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--breakout-target cancel|allow] [--slippage-ticks 2] [--target-fill trade-through|touch] [--out <folder>]
 *
 * The exporter keeps each session's ATM strike (NIFTY 09:19 close = the close of the 09:15–09:20 candle, rounded half up to
 * 50) on the weekly expiry by the NSE rule. 5-minute candles are built from the exchange's 1-minute candles on the
 * 09:15 / 09:20 / … grid (exact OHLC aggregation, nothing filled in). Writes sessions.csv, trades.csv, summary.json,
 * year-wise.csv, month-wise.csv and RESULTS.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  advanceH0H4, contractSymbol, createH0H4Session, h0h4Report, H0H4_DEFAULTS, H0H4_V1_CLOSE_5M, niftyLotSize, selectContract, sessionRow,
  type Bar, type H0H4Settings, type H0H4State,
} from "@/lib/algo/fib-h0h4";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] == null ? "1" : process.argv[++i]);
}
const DATA = path.resolve(args.get("data") ?? "../../backtests/Fib-H0H4-5Min-NIFTY-CE-2021-11-01-to-2026-11-12/data");
const OUT = path.resolve(args.get("out") ?? path.dirname(DATA));
const BASE: H0H4Settings = {
  // Default = the current rules (1-minute, high breaks, buy on the H4 touch); --v1 = the original spec (5-minute, close breaks).
  ...(args.has("v1") ? H0H4_V1_CLOSE_5M : H0H4_DEFAULTS),
  ...(args.has("break") ? { breakMode: args.get("break") as H0H4Settings["breakMode"] } : {}),
  ...(args.has("slippage-ticks") ? { slippageTicks: Number(args.get("slippage-ticks")) } : {}),
  ...(args.has("target-fill") ? { targetFill: args.get("target-fill") as H0H4Settings["targetFill"] } : {}),
  // Candle size (5 = the spec; 1 / 3 = research). The export's --atm-time must match: 09:15 for 1, 09:17 for 3, 09:19 for 5.
  // Opening-candle colours that trade: green (spec) | both-ce | both-pe (red → ATM PE).
  ...(args.has("open-colour") ? { openColour: args.get("open-colour") as H0H4Settings["openColour"] } : {}),
  // Fib anchor: H3 (spec) | H2 (research: BUY on a close above Fib 0.5 = H2, SELL at 0.618; no H3/H4 step).
  ...(args.has("anchor") ? { anchor: args.get("anchor") as H0H4Settings["anchor"] } : {}),
  // Exit / entry research (user, "buy @100, sell @102"): fixed target % or points from the buy price; touch entry above H4.
  ...(args.has("target-pct") ? { targetPct: Number(args.get("target-pct")) } : {}),
  ...(args.has("target-points") ? { targetPoints: Number(args.get("target-points")) } : {}),
  ...(args.has("entry") ? { entryMode: args.get("entry") as H0H4Settings["entryMode"] } : {}),
  ...(args.has("candle-minutes") ? { candleMinutes: Number(args.get("candle-minutes")) as H0H4Settings["candleMinutes"] } : {}),
};
if (![1, 3, 5].includes(BASE.candleMinutes)) throw new Error("--candle-minutes must be 1, 3 or 5");
if (!["H3", "H2"].includes(BASE.anchor)) throw new Error("--anchor must be H3 or H2");
const H2V = BASE.anchor === "H2";
const hm = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

type Session = { date: string; session_type: string; expiry: string | null; expiry_source: string };
const windowInfo = JSON.parse(readFileSync(path.join(DATA, "00-window.json"), "utf8")) as { start: string; end: string; sessions: Session[] };
const FROM = args.get("from") ?? windowInfo.start;
const TO = args.get("to") ?? windowInfo.end;

function rows(file: string, each: (cells: string[]) => void) {
  const text = readFileSync(path.join(DATA, file), "utf8");
  let start = text.indexOf("\n") + 1;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    if (line) each(line.split(","));
    start = end + 1;
  }
}
const spot = new Map<string, Bar[]>();
rows("05-nifty-1min-candles.csv", ([date, time, open, high, low, close]) => {
  if (date < FROM || date > TO) return;
  (spot.get(date) ?? spot.set(date, []).get(date)!).push({ t: hm(time), open: +open, high: +high, low: +low, close: +close });
});
const ce = new Map<string, Bar[]>(); // `${date}|${strike}|${right}` → 1-minute bars
rows("07-nifty-weekly-options-1min.csv", ([date, time, , strike, type, open, high, low, close, volume]) => {
  if ((type !== "CE" && type !== "PE") || date < FROM || date > TO) return;
  const key = `${date}|${+strike}|${type}`;
  (ce.get(key) ?? ce.set(key, []).get(key)!).push({ t: hm(time), open: +open, high: +high, low: +low, close: +close, volume: +volume });
});

function runSession(session: Session, s: H0H4Settings): H0H4State {
  const spotBars = spot.get(session.date) ?? [];
  let state = advanceH0H4(createH0H4Session(session.date), { now: 24 * 60, spot: spotBars }, s);
  if (state.phase !== "SELECTING_ATM") return state;
  const strike = state.strike!;
  const right = state.right ?? "CE";
  const tape = ce.get(`${session.date}|${strike}|${right}`) ?? [];
  const at = s.sessionOpen + s.candleMinutes;
  if (!session.expiry) return selectContract(state, null, at, "expiry unknown");
  if (!tape.length) return selectContract(state, null, at, `no premium data for ${strike} ${right}`);
  state = selectContract(state, { underlying: "NIFTY", expiry: session.expiry, strike, right, symbol: contractSymbol("NIFTY", session.expiry, strike, right), lotSize: niftyLotSize(session.expiry) }, at);
  return advanceH0H4(state, { now: 24 * 60, spot: spotBars, ce: tape }, s);
}

const sessions = windowInfo.sessions.filter((x) => x.date >= FROM && x.date <= TO);
const csv = (list: Record<string, unknown>[]) => {
  if (!list.length) return "";
  const keys = Object.keys(list[0]);
  const cell = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [keys.join(","), ...list.map((row) => keys.map((k) => cell(row[k])).join(","))].join("\n") + "\n";
};

mkdirSync(OUT, { recursive: true });
const variants: [string, H0H4Settings][] = [
  ["baseline", { ...BASE, breakoutTargetCheck: (args.get("breakout-target") as H0H4Settings["breakoutTargetCheck"]) ?? "cancel" }],
  ...(args.has("breakout-target") ? [] : [["breakout-wick-allowed", { ...BASE, breakoutTargetCheck: "allow" }] as [string, H0H4Settings]]),
];
const summary: Record<string, unknown> = { strategy: "5-Minute H0–H4 Fibonacci Breakout (NIFTY ATM CE, BUY only)", from: FROM, to: TO, data: DATA, settings: BASE };
const md: string[] = [`# ${BASE.candleMinutes}-Minute H0–H4 Fibonacci Breakout${H2V ? " — H2 version (Fib 0.5 = H2, BUY on a close above it, SELL at 0.618)" : ""} — backtest ${FROM} → ${TO}`, "", `Real NIFTY weekly ATM CE premiums (1-minute exchange candles aggregated to exact ${BASE.candleMinutes}-minute candles).`+" 1 lot, ₹20/order + dated statutory charges, 2-tick slippage on market fills, target fills only when traded one tick through.", ""];
for (const [name, settings] of variants) {
  const states = sessions.map((session) => runSession(session, settings));
  const report = h0h4Report(states, settings);
  const table = states.map((state) => sessionRow(state, settings));
  const dir = variants.length > 1 && name !== "baseline" ? path.join(OUT, name) : OUT;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "sessions.csv"), csv(table));
  writeFileSync(path.join(dir, "trades.csv"), csv(table.filter((row) => row.entryPrice != null)));
  writeFileSync(path.join(dir, "year-wise.csv"), csv(report.years));
  writeFileSync(path.join(dir, "month-wise.csv"), csv(report.months));
  summary[name] = { settings: { breakoutTargetCheck: settings.breakoutTargetCheck }, ...report };
  const o = report.overall;
  md.push(`## ${name === "baseline" ? "Baseline (breakout candle whose high already reached Fib 0.618 → skipped)" : "Variant: breakout candle wick above the target allowed (spec ₹123-high example)"}`, "",
    "| Funnel | Sessions |", "|---|---:|",
    ...((H2V
      ? [["Sessions", o.sessions], ["Green opening", o.greenOpen], ["H0", o.h0], ["H1", o.h1], ["H2 (Fib set, 0.5 = H2)", o.h2], ["Close above 0.5 (BUY signal)", o.h4Breakout], ["Trades", o.trades]]
      : [["Sessions", o.sessions], ["Green opening", o.greenOpen], ["H0", o.h0], ["H1", o.h1], ["H2", o.h2], ["H3 (Fib set)", o.h3], ["H4 established", o.h4], ["Valid H4", o.validH4], ["H4 breakout", o.h4Breakout], ["Trades", o.trades]]) as [string, number][]).map(([k, v]) => `| ${k} | ${v} |`),
    "", `Trades ${o.trades} · profit ${o.wins} · loss ${o.losses} · accuracy ${o.winRate}% · target hits ${o.targetHits} · square-offs ${o.nonTargetExits} · no-trade sessions ${o.noEntrySessions}.`,
    `Gross ₹${o.grossProfit} · charges ₹${o.charges} · net ₹${o.netProfit} · avg/trade ₹${o.avgPerTrade} · max DD ₹${o.maxDrawdown} · max consecutive wins ${o.maxConsecutiveWins} / losses ${o.maxConsecutiveLosses}.`, "",
    "| Year | Trades | Profit | Loss | Accuracy | Gross ₹ | Net ₹ |", "|---|---:|---:|---:|---:|---:|---:|",
    ...report.years.map((y) => `| ${y.period} | ${y.trades} | ${y.wins} | ${y.losses} | ${y.winRate}% | ${y.gross} | ${y.net} |`), "",
    `Timing (min, averages): H0→H1 ${report.analysis.avgH0toH1}, H1→H2 ${report.analysis.avgH1toH2}, H2→H3 ${report.analysis.avgH2toH3}, H3→H4 ${report.analysis.avgH3toH4}, H4→entry ${report.analysis.avgH4toEntry}, entry→target ${report.analysis.avgEntryToTarget}.`,
    `H4 never broke ${report.analysis.h4NeverBroke} · target before entry ${report.analysis.targetBeforeEntry} · invalid H4 ${report.analysis.invalidH4}. Ambiguous intrabar trades: 0 (entry at a bar open, no stop-loss — no same-minute exit conflict exists).`, "",
    "Session end reasons: " + Object.entries(report.analysis.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "), "");
  console.log(`${name}: ${o.sessions} sessions, ${o.trades} trades, ${o.wins}/${o.losses} (${o.winRate}%), targets ${o.targetHits}, net ₹${o.netProfit}`);
}
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
// For the app's Backtest tab (read by h0h4Baseline; the index backtest uses the same .backtests folder).
const baselineReport = summary.baseline as ReturnType<typeof h0h4Report>;
const variant = summary["breakout-wick-allowed"] as ReturnType<typeof h0h4Report> | undefined;
if ((["candleMinutes", "breakMode", "entryMode", "openColour", "targetPct", "targetPoints", "anchor", "breakoutTargetCheck"] as const).every((k) => BASE[k] === H0H4_DEFAULTS[k])) {
mkdirSync(path.join(process.cwd(), ".backtests", "fib-h0h4"), { recursive: true });
writeFileSync(path.join(process.cwd(), ".backtests", "fib-h0h4", "latest.json"), JSON.stringify({ from: FROM, to: TO, generatedAt: new Date().toISOString(), report: { overall: baselineReport.overall, years: baselineReport.years, months: baselineReport.months, analysis: baselineReport.analysis }, ...(variant ? { variant: { name: "breakout candle wick above the target allowed", overall: variant.overall } } : {}) }));
}
writeFileSync(path.join(OUT, "RESULTS.md"), md.join("\n"));
console.log(`→ ${OUT}`);
