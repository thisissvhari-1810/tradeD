/**
 * Mathi Strategy (+3%) backtest on FINNIFTY, MIDCPNIFTY and NIFTY NEXT 50 over one month, on each index's real
 * expired option contracts (Dhan v2 /charts/rollingoption, 1-minute). The strategy is the app's own: ALGO_DEFAULTS read
 * through readAlgoConfig with only the underlying changed, simulated with
 * simulateSession / createReplayAdapter, exactly like the in-app backtest. Paper only: no order is sent anywhere.
 *
 *   DHAN_CLIENT_ID=… DHAN_ACCESS_TOKEN=… npm run backtest:indices -- [--to 2026-10-27] [--from 2026-09-28] [--indices FINNIFTY,MIDCPNIFTY,NIFTYNXT50] [--export ../../backtests]
 *
 * Every Dhan response is cached under .backtest-cache/ (keyed by its request), so a repeated run reuses the same data and
 * needs no token. Results: .backtests/index-comparison/latest.json (read by the dashboard at /backtests) and an export
 * folder with the CSVs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readAlgoConfig } from "@/lib/algo/config";
import { ALGO_DEFAULTS, TICK, type AlgoConfig, type AlgoState } from "@/lib/algo/runner";
import { strategyLines, type Candle } from "@/lib/algo/lines";
import { createReplayAdapter, simulateSession } from "@/lib/algo/replay-adapter";
import { expiredChain, expiredTape, mergeRolling, rollingRequest, ROLLING_OFFSETS, type RollingSide } from "@/lib/algo/expired-options";
import { runStats, skippedSignals } from "@/lib/algo/chart-replay";
import {
  addDays, auditCsv, auditSession, dailyCsv, DEFINITIONS, INDEX_SPECS, INDEX_SYMBOLS, indexSessions, istDay, monthWindow, resolveExpiries, sessionQuality, statutoryCharges,
  summarize, verifyTrade, weekdays, type AuditTrade, type IndexBacktestReport, type IndexResult, type IndexSpec, type IndexSymbol, type SessionRecord,
} from "@/lib/algo/index-backtest";
import { csvCell } from "@/lib/algo/report";
import type { S1Data } from "@/lib/trading/s1";

const APP = path.resolve(__dirname, "..");
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[index + 1]?.startsWith("--") || process.argv[index + 1] == null ? "1" : process.argv[++index]);
}
const CAPITAL = 100_000;
const STRESS_SLIPPAGE_TICKS = 5;
const TOKEN = process.env.DHAN_ACCESS_TOKEN || process.env.DHAN_TOKEN || process.env.MARKET_DATA_API_KEY || "";
const CLIENT = process.env.DHAN_CLIENT_ID || process.env.DHAN_CLIENT || "";
const CACHE = path.resolve(APP, args.get("cache") ?? ".backtest-cache/dhan");
const RESULTS = path.resolve(APP, ".backtests/index-comparison");
const EXPORT_ROOT = path.resolve(APP, args.get("export") ?? "../../backtests");

const todayIst = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
// The last weekday before today: the latest session whose contracts can have expired-options history.
const defaultTo = (() => {
  let day = addDays(todayIst, -1);
  while ([0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) day = addDays(day, -1);
  return day;
})();
const TO = args.get("to") ?? defaultTo;
const FROM = args.get("from") ?? monthWindow(TO).from;
const SYMBOLS = (args.get("indices")?.split(",").map((item) => item.trim().toUpperCase()) ?? INDEX_SYMBOLS).filter((item): item is IndexSymbol => item in INDEX_SPECS);
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO) || FROM > TO || TO >= todayIst) throw new Error(`Invalid window ${FROM} → ${TO} (must be past dates).`);

/* ---------------- Dhan client with an on-disk cache ---------------- */

class Fatal extends Error {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequest = 0;
let requests = 0;
let cacheHits = 0;

/** A cached POST: the response for the same path and body is read from disk; `null` = Dhan has no data for it. */
async function dhan(pathname: string, body: Record<string, unknown>, label: string): Promise<unknown | null> {
  const key = createHash("sha256").update(`${pathname}|${JSON.stringify(body)}`).digest("hex").slice(0, 24);
  const file = path.join(CACHE, label.replace(/[^A-Za-z0-9_.-]+/g, "_"), `${key}.json`);
  if (existsSync(file)) {
    cacheHits += 1;
    return (JSON.parse(readFileSync(file, "utf8")) as { data: unknown }).data;
  }
  if (!TOKEN || !CLIENT) throw new Fatal("No Dhan credentials: set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN (the daily Data API token) in the environment, or run once with them to fill the cache.");
  for (let attempt = 0; ; attempt += 1) {
    const wait = lastRequest + 350 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    requests += 1;
    const response = await fetch(`https://api.dhan.co/v2${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "access-token": TOKEN, "client-id": CLIENT }, body: JSON.stringify(body) }).catch((error: unknown) => ({ ok: false, status: 599, text: async () => String(error) }) as const);
    const text = await response.text();
    if (response.ok) {
      const data = JSON.parse(text) as unknown;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ path: pathname, body, fetchedAt: new Date().toISOString(), data }));
      return data;
    }
    // DH-901 invalid token, DH-902 no Data API access, DH-903 account problem.
    if (response.status === 401 || response.status === 403 || /DH-90[123]/.test(text)) {
      throw new Fatal(`Dhan refused the request (${response.status}): the access token is invalid or expired, or the Data API is not enabled. ${text.slice(0, 160)}`);
    }
    // Only successful answers are cached: a refusal (DH-905 is "bad values for parameters", not "no data") is an error.
    if ((response.status === 429 || response.status >= 500) && attempt < 6) { await sleep(3_000 * (attempt + 1)); continue; }
    throw new Error(`${pathname} ${response.status} ${text.slice(0, 200)}`);
  }
}

type Arrays = { open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[]; timestamp?: number[] };
const toCandles = (data: unknown): Candle[] => {
  const series = (data ?? {}) as Arrays;
  return (series.timestamp ?? []).map((time, index) => ({ time, open: series.open![index], high: series.high![index], low: series.low![index], close: series.close![index], volume: series.volume?.[index] ?? 0 }));
};

/** Daily bars (for the previous session's levels) and 1-minute candles of the index. */
async function indexData(spec: IndexSpec) {
  const id = String(spec.dhanIndexId);
  const daily = toCandles(await dhan("/charts/historical", { securityId: id, exchangeSegment: "IDX_I", instrument: "INDEX", expiryCode: 0, oi: false, fromDate: addDays(FROM, -25), toDate: addDays(TO, 1) }, `${spec.symbol}/daily`));
  const minutes: Candle[] = [];
  for (let start = FROM; start <= TO; start = addDays(start, 5)) {
    const end = addDays(start, 5) > addDays(TO, 1) ? addDays(TO, 1) : addDays(start, 5);
    minutes.push(...toCandles(await dhan("/charts/intraday", { securityId: id, exchangeSegment: "IDX_I", instrument: "INDEX", interval: "1", oi: false, fromDate: `${start} 09:00:00`, toDate: `${end} 09:00:00` }, `${spec.symbol}/intraday`)));
  }
  return { daily, minutes };
}

const rowsOf = (data: unknown, side: RollingSide) => ((data as { data?: Record<string, { timestamp?: number[]; strike?: number[]; spot?: number[] } | null> } | null)?.data?.[side === "CALL" ? "ce" : "pe"]) ?? null;

/**
 * The expired-options history: every strike offset ATM−10 … ATM+10, CALL and PUT, nearest monthly expiry. The docs give
 * 30 days a request with toDate exclusive; this account (2026-10-28) is refused (DH-905) for any span over one day and
 * gets both dates back (toDate inclusive), so each request covers two calendar days: [day, day + 1].
 */
async function optionData(spec: IndexSpec, sessions: string[]) {
  const windows: Array<[string, string]> = [];
  for (let start = FROM; start <= TO; start = addDays(start, 2)) {
    const end = addDays(start, 1) > TO ? TO : addDays(start, 1);
    if (sessions.some((day) => day >= start && day <= end)) windows.push([start, end]);
  }
  const mode = "two days a request, both dates inclusive";
  const body = (offset: string, side: RollingSide, from: string, to: string) => rollingRequest({ underlyingSecurityId: spec.dhanIndexId, offset, side, from, to, cycle: spec.cycle });
  const responses: Array<{ side: RollingSide; data: unknown; offset: string }> = [];
  const failures: string[] = [];
  for (const [from, to] of windows) {
    for (const offset of ROLLING_OFFSETS) for (const side of ["CALL", "PUT"] as const) {
      try {
        const data = await dhan("/charts/rollingoption", body(offset, side, from, to), `${spec.symbol}/rolling`);
        if (data) responses.push({ side, data, offset });
      } catch (error) {
        if (error instanceof Fatal) throw error;
        failures.push(`${from}..${to} ${offset} ${side}: ${error instanceof Error ? error.message.slice(0, 140) : "failed"}`);
      }
    }
    process.stdout.write(`  ${spec.symbol} options ${from} → ${to} (${mode})\n`);
  }
  const offsetsWithData = [...new Set(responses.filter((item) => rowsOf(item.data, item.side)?.timestamp?.length).map((item) => item.offset))];
  return { tapes: mergeRolling(responses), responses, failures, offsetsWithData, mode };
}

/* ---------------- one index ---------------- */

function strategyConfig(symbol: string, slippageTicks?: number): AlgoConfig {
  const config = readAlgoConfig({ ...ALGO_DEFAULTS, underlying: symbol, mode: "REPLAY" });
  return slippageTicks == null ? config : { ...config, slippageTicks };
}

async function runIndex(spec: IndexSpec, report: { holidays: Set<string>; weekdays: string[] }): Promise<IndexResult> {
  const empty = (status: IndexResult["status"], reason: string, extra: Partial<IndexResult> = {}): IndexResult => ({
    symbol: spec.symbol, name: spec.name, status, reason, premiumSource: "none — no option premiums, so no trades were simulated", spec, sessions: [], trades: [], shadowTrades: [], summary: null, sensitivity: null,
    dataQuality: { duplicates: 0, outsideSession: 0, invalid: 0, incompleteSessions: [], offsetsWithData: [], requestFailures: [], verification: { checked: 0, problems: [] } }, ...extra,
  });
  let index: Awaited<ReturnType<typeof indexData>>;
  try {
    index = await indexData(spec);
  } catch (error) {
    if (error instanceof Fatal) throw error;
    return empty("NOT_BACKTESTED", `Index candles unavailable: ${error instanceof Error ? error.message : "request failed"}`);
  }
  const split = indexSessions(index.minutes);
  const sessions = [...split.byDay.keys()].filter((day) => day >= FROM && day <= TO).sort();
  for (const day of report.weekdays) if (!sessions.includes(day)) report.holidays.add(day);
  const quality = { duplicates: split.duplicates, outsideSession: split.outside, invalid: split.invalid };
  if (!sessions.length) return empty("NOT_BACKTESTED", "Dhan returned no 1-minute index candles for this window.", { dataQuality: { ...empty("NOT_BACKTESTED", "").dataQuality, ...quality } });
  let options: Awaited<ReturnType<typeof optionData>>;
  try {
    options = await optionData(spec, sessions);
  } catch (error) {
    if (error instanceof Fatal) throw error;
    return empty("NOT_BACKTESTED", `Expired-option history unavailable: ${error instanceof Error ? error.message : "request failed"}`, { dataQuality: { ...empty("NOT_BACKTESTED", "").dataQuality, ...quality } });
  }
  const { tapes } = options;
  if (!tapes.size && options.failures.length) {
    return empty("NOT_BACKTESTED", `All ${options.failures.length} option-history requests failed, e.g. ${options.failures[0]}`, { dataQuality: { ...empty("NOT_BACKTESTED", "").dataQuality, ...quality, requestFailures: options.failures } });
  }
  const level = sessions.length ? split.byDay.get(sessions[0])![0].close : 0;
  const expiries = resolveExpiries(tapes, spec.cycle, Math.max(5, level * 0.0002), new Set(sessions));
  const bars = index.daily.map((bar) => ({ ...bar, day: istDay(bar.time) })).sort((a, b) => a.time - b.time);
  const spotAt = new Map(index.minutes.map((candle) => [candle.time, candle.close]));
  const spotByDay = new Map<string, { checked: number; mismatched: number }>();
  for (const { side, data } of options.responses) {
    const rows = rowsOf(data, side);
    rows?.timestamp?.forEach((time, at) => {
      const close = spotAt.get(time);
      const spot = rows.spot?.[at];
      if (close == null || spot == null) return;
      const day = istDay(time);
      const tally = spotByDay.get(day) ?? { checked: 0, mismatched: 0 };
      tally.checked += 1;
      if (Math.abs(close - spot) > Math.max(1, close * 0.0002)) tally.mismatched += 1;
      spotByDay.set(day, tally);
    });
  }

  type Run = { trades: AuditTrade[]; shadow: AuditTrade[]; records: SessionRecord[] };
  async function run(config: AlgoConfig): Promise<Run> {
    let regime: AlgoState["regime"] | undefined;
    const out: Run = { trades: [], shadow: [], records: [] };
    for (const day of sessions) {
      const candles = split.byDay.get(day)!;
      const sq = sessionQuality(day, candles);
      const dayTapes = tapes.get(day) ?? new Map<string, Candle[]>();
      const expiry = expiries.get(day) ?? null;
      const base = { date: day, indexCandles: candles.length, missingMinutes: sq.missing, optionStrikes: dayTapes.size, expiry, spotChecked: spotByDay.get(day)?.checked ?? 0, spotMismatched: spotByDay.get(day)?.mismatched ?? 0 };
      const none = { detected: 0, confirmed: 0, falseBreakouts: 0, expired: 0, rejected: 0, entered: 0, shadow: 0 };
      const previous = bars.filter((bar) => bar.day < day).at(-1);
      if (!previous) { out.records.push({ ...base, status: "SKIPPED", reason: "No previous session's daily bar: the strategy lines cannot be drawn.", signals: none, rejections: [] }); continue; }
      if (!dayTapes.size) { out.records.push({ ...base, status: "SKIPPED", reason: "No expired-option history from Dhan for this session: option P&L cannot be computed (not traded, not counted as ₹0).", signals: none, rejections: [] }); continue; }
      const sessionOpen = Math.floor(Date.parse(`${day}T03:45:00Z`) / 1000);
      const first = candles.find((candle) => candle.time === sessionOpen) ?? null;
      const bar = bars.find((item) => item.day === day);
      const s1: S1Data = {
        symbol: spec.symbol, date: day, sessionOpen, sessionClose: sessionOpen + 22_500, status: "ready", message: "",
        previous: { date: previous.day, open: previous.open, high: previous.high, low: previous.low, close: previous.close },
        open: bar?.open ?? first?.open ?? null, firstMinute: first ? { time: first.time, open: first.open, high: first.high, low: first.low } : null,
      };
      const lines = strategyLines(s1, config.custom);
      const chain = expiredChain({ symbol: spec.symbol, date: day, expiry: expiry?.expiry ?? null, lotSize: spec.lotSize, tapes: dayTapes });
      const adapter = createReplayAdapter({ candles, chain, config, capital: CAPITAL, tapeOf: async (contract) => expiredTape(dayTapes, contract.securityId) });
      const { events, state } = await simulateSession({ sessionId: `idx-${spec.symbol}-${day}`, date: day, config, candles, lines, adapter, regime, startNote: `Backtest ${spec.symbol} ${day}: nearest monthly expiry ${expiry?.expiry ?? "unknown"}, expired-contract 1-minute premiums (Dhan).` });
      regime = state.regime;
      const audited = auditSession({ symbol: spec.symbol, date: day, events, tapes: dayTapes, expiry, slippageTicks: config.slippageTicks });
      const stats = runStats(events);
      out.trades.push(...audited.filter((trade) => !trade.shadow));
      out.shadow.push(...audited.filter((trade) => trade.shadow));
      out.records.push({
        ...base, status: "SIMULATED",
        ...(sq.complete ? {} : { reason: `${sq.missing.length} index minute(s) missing` }),
        signals: { detected: stats.detected ?? 0, confirmed: stats.signals, falseBreakouts: stats.falseBreakouts ?? 0, expired: stats.expired ?? 0, rejected: stats.rejected, entered: audited.filter((trade) => !trade.shadow).length, shadow: audited.filter((trade) => trade.shadow).length },
        rejections: skippedSignals(events).map((item) => `${new Date((item.time + 19_800) * 1000).toISOString().slice(11, 16)} ${item.side ?? ""}: ${item.reason}`.slice(0, 300)),
      });
    }
    return out;
  }

  const config = strategyConfig(spec.symbol);
  const base = await run(config);
  const simulated = base.records.filter((record) => record.status === "SIMULATED").map((record) => record.date);
  const summary = summarize(base.trades, simulated, CAPITAL);
  const closed = base.trades.filter((trade) => trade.net != null && trade.exitPremium != null);
  const statutory = closed.reduce((sum, trade) => sum + statutoryCharges("BUY", trade.entryPremium, trade.quantity) + statutoryCharges("SELL", trade.exitPremium!, trade.quantity), 0);
  const problems = [...base.trades, ...base.shadow].map((trade) => ({ id: trade.id, problems: verifyTrade(trade, tapes.get(trade.date)?.get(`${trade.right}:${trade.strike}`) ?? [], config.slippageTicks, config.target.value) })).filter((item) => item.problems.length);
  const skipped = base.records.filter((record) => record.status === "SKIPPED");
  // Premiums that were never traded cannot be filled: when most entries fall in minutes where the chosen option did not
  // trade (zero volume, the provider carrying the last price forward), the index is not backtested and its trades are kept
  // only as diagnostics, in no figure.
  const untradeable = summary.trades > 0 && summary.staleEntries / summary.trades > 0.5;
  const status: IndexResult["status"] = !simulated.length || untradeable ? "NOT_BACKTESTED" : skipped.length ? "INCOMPLETE" : "BACKTESTED";
  // The slippage stress keeps the same trades and adds the extra ticks to both fills (re-running the engine with other
  // prices changes its later decisions — loss lock, regime switch — and is no longer a cost test).
  const extraSlippage = closed.reduce((sum, trade) => sum + (STRESS_SLIPPAGE_TICKS - config.slippageTicks) * TICK * 2 * trade.quantity, 0);
  return {
    symbol: spec.symbol, name: spec.name, status,
    reason: untradeable
      ? `${summary.staleEntries} of ${summary.trades} entries fall in minutes where the chosen ATM option did not trade (zero volume): Dhan's rows there carry an earlier price forward, so no realistic fill can be simulated. Eligible contracts are listed (monthly, lot ${spec.lotSize}), but the options were too illiquid for this strategy's entries.`
      : status === "NOT_BACKTESTED" ? (skipped[0]?.reason ?? "No session could be simulated.") : status === "INCOMPLETE" ? `${skipped.length} of ${sessions.length} sessions could not be priced: ${skipped.map((record) => record.date).join(", ")}.` : null,
    premiumSource: untradeable ? "Historical rows exist, but at the entries they are zero-volume carried-forward prices, not traded premiums." : simulated.length ? "Actual historical premiums: 1-minute candles of the expired contracts (Dhan /v2/charts/rollingoption, nearest monthly expiry), regrouped by strike." : "none",
    spec, sessions: base.records, trades: untradeable ? [] : base.trades, shadowTrades: untradeable ? [] : base.shadow, summary: untradeable ? null : summary,
    ...(untradeable ? { untradeableTrades: [...base.trades, ...base.shadow] } : {}),
    sensitivity: untradeable ? null : { statutoryCharges: Math.round(statutory * 100) / 100, netAtStatutoryCharges: Math.round((summary.gross - statutory) * 100) / 100, stressSlippageTicks: STRESS_SLIPPAGE_TICKS, netAtStressSlippage: Math.round((summary.net - extraSlippage) * 100) / 100 },
    dataQuality: {
      ...quality, incompleteSessions: base.records.filter((record) => record.missingMinutes.length).map((record) => `${record.date} (${record.missingMinutes.length} min missing)`),
      offsetsWithData: options.offsetsWithData, requestFailures: options.failures, verification: { checked: base.trades.length + base.shadow.length, problems },
    },
  };
}

/* ---------------- the report ---------------- */

const config = strategyConfig("FINNIFTY");
const strategy = {
  name: "Mathi Strategy (+3%)", version: config.settingsVersion,
  rules: [
    "1-minute index candles; strategy lines from the previous session (box top / mid / bottom, high, low, close, mid-range) and today (open box, open, 09:15 high / low).",
    `Signal: ${config.crossPercent}% of a candle's body crosses an enabled line; confirmed by a retest within ${config.confirmation.retestWindowMinutes} minutes (tolerance ${config.confirmation.retestTolerancePercent}% of the line).`,
    "Contract: the ATM CE (up) or PE (down) of the nearest expiry, from the index close of the confirming minute; bought at that minute's option close + 1 tick slippage.",
    `Sizing: whole lots that ₹1,00,000 pays for (charges included), at most ${config.lots} lots. ${config.maxTrades} entries a session, one position at a time, ${config.cooldownMinutes}-minute cooldown.`,
    `Exit: +${config.target.value}% on the entry premium (resting target, filled less 1 tick); no stop-loss; at ${config.maxHoldMinutes} minutes kept only while ${config.exitManagement?.minScore} of 5 trend checks agree, always out by ${config.exitManagement?.maxHoldMinutes} minutes; square-off ${config.squareOff} IST.`,
    `Daily loss lock ₹${config.maxDailyLoss.toLocaleString("en-IN")}; regime switch: real entries only while the last ${config.regime?.lookback} trades made money (shadow trades otherwise), started fresh for each index.`,
  ],
  config: { ...config, underlying: "per index", custom: undefined } as Record<string, unknown>,
};

async function main() {
const holidays = new Set<string>();
const days = weekdays(FROM, TO);
const results: IndexResult[] = [];
let fatal: string | null = null;
console.log(`Mathi +3% index backtest ${FROM} → ${TO} (${days.length} weekdays). Cache: ${CACHE}`);
for (const symbol of SYMBOLS) {
  const spec = INDEX_SPECS[symbol];
  console.log(`${symbol} (Dhan IDX_I ${spec.dhanIndexId}, lot ${spec.lotSize}, ${spec.cycle.toLowerCase()}ly expiry)`);
  try {
    results.push(await runIndex(spec, { holidays, weekdays: days }));
  } catch (error) {
    if (!(error instanceof Fatal)) throw error;
    fatal = error.message;
    results.push({ symbol, name: spec.name, status: "NOT_BACKTESTED", reason: error.message, premiumSource: "none — no option premiums, so no trades were simulated", spec, sessions: [], trades: [], shadowTrades: [], summary: null, sensitivity: null, dataQuality: { duplicates: 0, outsideSession: 0, invalid: 0, incompleteSessions: [], offsetsWithData: [], requestFailures: [], verification: { checked: 0, problems: [] } } });
  }
  const last = results.at(-1)!;
  console.log(`  ${last.status}${last.reason ? ` — ${last.reason}` : ""}${last.summary ? ` | trades ${last.summary.trades} net ₹${last.summary.net}` : ""}`);
}
// A weekday is an exchange holiday only when no index has candles that day (one index missing it is a data gap).
const anyData = results.some((result) => result.sessions.length);
const sessionDays = new Set(results.flatMap((result) => result.sessions.map((record) => record.date)));
const report: IndexBacktestReport = {
  generatedAt: new Date().toISOString(),
  window: { from: FROM, to: TO, weekdays: days.length, holidays: anyData ? days.filter((day) => !sessionDays.has(day)) : [] },
  provider: "Dhan HQ v2 Data API: /charts/intraday + /charts/historical (IDX_I index candles), /charts/rollingoption (expired index options, 1-minute, nearest monthly expiry)",
  capital: CAPITAL, strategy, definitions: DEFINITIONS,
  limitations: [
    ...(fatal ? [`NOT RUN: ${fatal}`] : []),
    "Dhan's expired-options endpoint refused (DH-905) any request spanning more than one day on this account and returned both dates of a one-day span, unlike its documentation (30 days, toDate exclusive); the data was fetched two calendar days at a time.",
    "Lot sizes are today's (Dhan instrument master, 2026-10-28): FINNIFTY 60, MIDCPNIFTY 120, NIFTYNXT50 25. No NSE lot-size revision is known inside the window, but this was not verified against the expired contracts (Dhan's history has no lot size).",
    "Premiums are 1-minute trade candles (no bid / ask history): fills assume the minute's close plus 1 tick at entry and the target (or the minute's close) less 1 tick at exit. A 5-tick slippage stress test is shown separately.",
    "Charges use the app's charge model (an estimate); a statutory-rate check (exchange 0.03503%, SEBI ₹10 / crore, stamp 0.003%, STT 0.1% on sells, GST 18%) is shown alongside. Verify against a contract note; if STT on options is now higher, charges rise by the difference on sell turnover.",
    "Liquidity: there is no order-book history. Trades whose quantity exceeds the entry minute's traded contracts are flagged, not removed.",
    "A target that the option only touched (high below target + 1 tick) is counted as filled, as the engine does, and flagged TARGET_TOUCH_ONLY.",
    "With no stop-loss, one candle cannot hold both a stop and the target, and the target is checked before the minute-close time / trend exits, so no trade is ambiguous between the target and another exit within a candle.",
    "Strategy settings are the code defaults (settings version 18). Settings saved in your account (database) may differ and were not read.",
  ],
  indices: results,
};

mkdirSync(RESULTS, { recursive: true });
writeFileSync(path.join(RESULTS, `${FROM}_${TO}.json`), JSON.stringify(report));
writeFileSync(path.join(RESULTS, "latest.json"), JSON.stringify(report));
const folder = path.join(EXPORT_ROOT, `Mathi-3pct-Indices-${FROM}-to-${TO}`);
mkdirSync(folder, { recursive: true });
writeFileSync(path.join(folder, "results.json"), JSON.stringify(report, null, 1));
const row = (cells: unknown[]) => cells.map(csvCell).join(",");
const comparison = [row(["Index", "Status", "Data availability", "Trading sessions", "Total trades", "CE trades", "PE trades", "Target hits", "Win rate %", "Gross P&L", "Charges (est.)", "Net P&L", "Conservative net P&L (target-capped fills)", "Net return on deployed %", "Net return on ₹1,00,000 %", "Max drawdown", "Net at statutory charges", `Net at ${STRESS_SLIPPAGE_TICKS}-tick slippage`, "Reason"])];
for (const result of results) {
  const s = result.summary;
  comparison.push(row([result.symbol, result.status, result.premiumSource, s?.sessions ?? 0, s?.trades ?? "", s?.ce ?? "", s?.pe ?? "", s?.targetHits ?? "", s?.winRate ?? "", s?.gross ?? "", s?.charges ?? "", s?.net ?? "", s?.netConservative ?? "", s?.returnOnDeployed ?? "", s?.returnOnCapital ?? "", s?.maxDrawdown ?? "", result.sensitivity?.netAtStatutoryCharges ?? "", result.sensitivity?.netAtStressSlippage ?? "", result.reason ?? ""]));
}
writeFileSync(path.join(folder, "01-comparison.csv"), `﻿${comparison.join("\r\n")}\r\n`);
writeFileSync(path.join(folder, "02-trades-audit.csv"), auditCsv(results.flatMap((result) => result.trades)));
writeFileSync(path.join(folder, "03-daily-pnl.csv"), dailyCsv(results.map((result) => ({ symbol: result.symbol, daily: result.summary?.daily ?? [] }))));
const sessionRows = [row(["Index", "Date", "Status", "Reason", "Index candles", "Missing minutes", "Option strikes", "Expiry", "Expiry source", "Calendar expiry", "Spot rows checked", "Spot mismatches", "Detected", "Confirmed", "False breakouts", "Expired", "Rejected", "Entered", "Shadow"])];
for (const result of results) for (const s of result.sessions) sessionRows.push(row([result.symbol, s.date, s.status, s.reason ?? "", s.indexCandles, s.missingMinutes.join(" "), s.optionStrikes, s.expiry?.expiry ?? "", s.expiry?.source ?? "", s.expiry?.calendar ?? "", s.spotChecked, s.spotMismatched, s.signals.detected, s.signals.confirmed, s.signals.falseBreakouts, s.signals.expired, s.signals.rejected, s.signals.entered, s.signals.shadow]));
writeFileSync(path.join(folder, "04-sessions-data-quality.csv"), `﻿${sessionRows.join("\r\n")}\r\n`);
writeFileSync(path.join(folder, "05-shadow-trades.csv"), auditCsv(results.flatMap((result) => result.shadowTrades)));
writeFileSync(path.join(folder, "06-untradeable-diagnostics.csv"), auditCsv(results.flatMap((result) => result.untradeableTrades ?? [])));
writeFileSync(path.join(folder, "README.md"), [
  `# Mathi Strategy (+3%) — FINNIFTY, MIDCPNIFTY, NIFTY NEXT 50, ${FROM} to ${TO}`,
  "",
  `Generated ${report.generatedAt}. Paper backtest only; no orders were placed.`,
  "",
  ...results.map((result) => `- **${result.symbol}**: ${result.status}${result.reason ? ` — ${result.reason}` : ""}${result.summary ? ` (trades ${result.summary.trades}, net ₹${result.summary.net} after estimated charges)` : ""}`),
  "",
  "Files: `01-comparison.csv` (one row per index), `02-trades-audit.csv` (every real trade), `03-daily-pnl.csv`, `04-sessions-data-quality.csv`, `05-shadow-trades.csv` (regime switch off, no money), `results.json` (everything, read by the app's Backtests page).",
  "",
  "Reproduce (from TradeD/tradeD):",
  "",
  "```",
  `DHAN_CLIENT_ID=<id> DHAN_ACCESS_TOKEN=<daily Data API token> npm run backtest:indices -- --from ${FROM} --to ${TO}`,
  "```",
  "",
  "Downloaded data is cached in `.backtest-cache/dhan` (keyed by request), so a repeat run reads the same data and needs no token.",
  "",
  "## Limitations",
  "",
  ...report.limitations.map((item) => `- ${item}`),
  "",
].join("\n"));
console.log(`Dhan requests ${requests}, cache hits ${cacheHits}. Written: ${path.join(RESULTS, "latest.json")} and ${folder}`);
if (fatal) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
