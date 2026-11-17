/**
 * First 1-Minute ATM CE + PE Premium Hedge — historical backtest on real NIFTY option premiums (paper only, no orders).
 *
 *   python scripts/export-atm-hedge-data.py --out ../../backtests/ATM-Hedge-NIFTY-5y/data
 *   npx tsx scripts/backtest-atm-hedge.ts --data ../../backtests/ATM-Hedge-NIFTY-5y/data
 *
 * Options: --from / --to YYYY-MM-DD · --capital 100000 · --slippage-ticks 2 · --series WEEK,MONTH · --out <folder>
 *
 * Every session is run for every target (+2/+3/+4/+5/+8/+10 points, +1/+1.5/+2/+3/+5 %) on the nearest weekly and the
 * nearest monthly expiry. Writes targets.csv, trades.csv, breakdown.csv, summary.json and report.html.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  clockOf, evaluateHedgeDay, HEDGE_DEFAULTS, hedgeLotSize, hhmm, r2,
  type ExpirySeries, type HedgeDayInput, type HedgeDayResult, type HedgeSettings, type HedgeTargetMode, type MinuteBar,
} from "@/lib/algo/atm-hedge";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] == null ? "1" : process.argv[++i]);
}
const DATA = path.resolve(args.get("data") ?? "../../backtests/ATM-Hedge-NIFTY-5y/data");
const OUT = path.resolve(args.get("out") ?? path.dirname(DATA));
const BASE: HedgeSettings = {
  ...HEDGE_DEFAULTS,
  ...(args.has("capital") ? { capital: Number(args.get("capital")) } : {}),
  ...(args.has("slippage-ticks") ? { slippageTicks: Number(args.get("slippage-ticks")) } : {}),
};
const SERIES = (args.get("series") ?? "WEEK,MONTH").split(",") as ExpirySeries[];
const TARGETS: [HedgeTargetMode, number][] = [
  ["POINTS", 2], ["POINTS", 3], ["POINTS", 4], ["POINTS", 5], ["POINTS", 8], ["POINTS", 10],
  ["PERCENT", 1], ["PERCENT", 1.5], ["PERCENT", 2], ["PERCENT", 3], ["PERCENT", 5],
];
const label = (mode: HedgeTargetMode, v: number) => (mode === "POINTS" ? `+${v} pts` : `+${v}%`);

/* ---------------- data ---------------- */

type SeriesInfo = { expiry: string | null; strike: number | null; strike_rule: string | null };
type Session = { date: string; session_type: string; first_close: number | null; atm50: number | null; vix_0915: number | null; series: Record<ExpirySeries, SeriesInfo> };
const windowInfo = JSON.parse(readFileSync(path.join(DATA, "00-window.json"), "utf8")) as { start: string; end: string; sessions: Session[]; expiry_calendar_check: unknown };
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
const spot = new Map<string, MinuteBar[]>();
rows("05-nifty-1min-candles.csv", ([date, time, open, high, low, close]) => {
  if (date < FROM || date > TO) return;
  (spot.get(date) ?? spot.set(date, []).get(date)!).push({ t: hhmm(time), open: +open, high: +high, low: +low, close: +close });
});
const tapes = new Map<string, MinuteBar[]>(); // `${date}|${series}|${right}`
rows("08-atm-options-1min.csv", ([date, series, time, , type, open, high, low, close, volume]) => {
  if (date < FROM || date > TO) return;
  const key = `${date}|${series}|${type}`;
  (tapes.get(key) ?? tapes.set(key, []).get(key)!).push({ t: hhmm(time), open: +open, high: +high, low: +low, close: +close, volume: +volume });
});
for (const t of tapes.values()) t.sort((a, b) => a.t - b.t);
for (const t of spot.values()) t.sort((a, b) => a.t - b.t);
const sessions = windowInfo.sessions.filter((s) => s.date >= FROM && s.date <= TO);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/* ---------------- regimes (descriptive labels, never used to trade) ---------------- */

const vixValues = sessions.map((s) => s.vix_0915).filter((v): v is number => v != null).sort((a, b) => a - b);
const q = (p: number) => vixValues[Math.floor(p * (vixValues.length - 1))];
const VIX_LO = q(1 / 3), VIX_HI = q(2 / 3);
type Regime = { trend: string; vol: string; weekday: string; year: string; dte: number | null; dteBucket: string; dayMovePct: number | null };
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function regime(s: Session, expiry: string | null): Regime {
  const bars = spot.get(s.date) ?? [];
  const open = bars.find((b) => b.t === hhmm("09:15"))?.open;
  const close = [...bars].reverse().find((b) => b.t <= hhmm("15:29"))?.close;
  const move = open && close ? ((close - open) / open) * 100 : null;
  const trend = move == null ? "unknown" : Math.abs(move) >= 0.6 ? "Trending (|day move| ≥ 0.6%)" : Math.abs(move) < 0.25 ? "Sideways (|day move| < 0.25%)" : "Mild (0.25–0.6%)";
  const vol = s.vix_0915 == null ? "unknown" : s.vix_0915 <= VIX_LO ? `Low VIX (≤ ${VIX_LO.toFixed(1)})` : s.vix_0915 >= VIX_HI ? `High VIX (≥ ${VIX_HI.toFixed(1)})` : "Mid VIX";
  const dte = expiry ? daysBetween(s.date, expiry) : null;
  const dteBucket = dte == null ? "unknown" : dte === 0 ? "Expiry day (0 DTE)" : dte === 1 ? "1 DTE" : dte <= 3 ? "2–3 DTE" : dte <= 7 ? "4–7 DTE" : "8+ DTE";
  return { trend, vol, weekday: WD[new Date(`${s.date}T00:00:00Z`).getUTCDay()], year: s.date.slice(0, 4), dte, dteBucket, dayMovePct: move == null ? null : r2(move) };
}

/* ---------------- run ---------------- */

type Row = { series: ExpirySeries; target: string; session: Session; reg: Regime; input: HedgeDayInput | null; result: HedgeDayResult | null; excluded: string | null; touchBound: boolean };

function inputFor(s: Session, series: ExpirySeries): { input: HedgeDayInput | null; excluded: string | null } {
  const info = s.series[series];
  if (s.first_close == null) return { input: null, excluded: `${s.session_type} session: no 09:15 NIFTY candle` };
  if (!info.strike || !info.expiry) return { input: null, excluded: "No CE+PE option candle at 09:16 in the data" };
  return {
    input: { date: s.date, expiry: info.expiry, firstClose: s.first_close, strike: info.strike, lotSize: hedgeLotSize(info.expiry), ce: tapes.get(`${s.date}|${series}|CE`) ?? [], pe: tapes.get(`${s.date}|${series}|PE`) ?? [] },
    excluded: null,
  };
}

/** Upper bound: could the target have been touched inside a minute (CE high + PE high, never simultaneous in reality)? */
function touchBound(input: HedgeDayInput, r: HedgeDayResult, settings: HedgeSettings) {
  if (r.status !== "CLOSED" || r.exitReason === "TARGET" || r.targetPremium == null) return false;
  const pe = new Map(input.pe.map((b) => [b.t, b]));
  return input.ce.some((c) => c.t >= r.entryTime! && c.t < settings.squareOffTime && pe.has(c.t) && c.high + pe.get(c.t)!.high >= r.targetPremium!);
}

function runAll(settings: HedgeSettings, withBound = false) {
  const out: Row[] = [];
  for (const series of SERIES) {
    for (const s of sessions) {
      const reg = regime(s, s.series[series].expiry);
      const { input, excluded } = inputFor(s, series);
      for (const [mode, value] of TARGETS) {
        const st = { ...settings, expirySeries: series, targetMode: mode, targetValue: value };
        const result = input ? evaluateHedgeDay(input, st) : null;
        out.push({ series, target: label(mode, value), session: s, reg, input, result, excluded, touchBound: withBound && input && result ? touchBound(input, result, st) : false });
      }
    }
  }
  return out;
}

function stats(list: Row[]) {
  const traded = list.filter((r) => r.result?.status === "CLOSED").map((r) => ({ ...r.result!, date: r.session.date }));
  traded.sort((a, b) => a.date.localeCompare(b.date));
  const hits = traded.filter((t) => t.exitReason === "TARGET");
  const wins = traded.filter((t) => t.net! > 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of traded) { eq += t.net!; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const sum = (k: "gross" | "net" | "charges" | "points" | "holdMinutes" | "invested") => traded.reduce((a, t) => a + (t[k] ?? 0), 0);
  const n = traded.length || 1;
  const winNet = wins.reduce((a, t) => a + t.net!, 0), lossNet = traded.filter((t) => t.net! <= 0).reduce((a, t) => a + t.net!, 0);
  return {
    sessions: list.length, entries: traded.length, notExecuted: list.filter((r) => !r.result || r.result.status !== "CLOSED").length,
    targetHits: hits.length, targetHitPct: traded.length ? r2((hits.length / traded.length) * 100) : 0, closedWithoutTarget: traded.length - hits.length,
    profitDays: wins.length, lossDays: traded.length - wins.length, accuracy: traded.length ? r2((wins.length / traded.length) * 100) : 0,
    avgHoldMin: r2(sum("holdMinutes") / n), avgHitHoldMin: hits.length ? r2(hits.reduce((a, t) => a + t.holdMinutes!, 0) / hits.length) : 0,
    avgPoints: r2(sum("points") / n), avgGross: r2(sum("gross") / n), avgNet: r2(sum("net") / n),
    maxProfit: traded.length ? r2(Math.max(...traded.map((t) => t.net!))) : 0, maxLoss: traded.length ? r2(Math.min(...traded.map((t) => t.net!))) : 0,
    maxDrawdown: r2(dd), totalCharges: r2(sum("charges")), totalGross: r2(sum("gross")), totalNet: r2(sum("net")),
    profitFactor: lossNet < 0 ? r2(winNet / -lossNet) : null, avgInvested: r2(sum("invested") / n),
    returnOnDeployedPct: sum("invested") > 0 ? r2((sum("net") / sum("invested")) * 100) : 0,
    avgWinNet: wins.length ? r2(winNet / wins.length) : 0, avgLossNet: traded.length - wins.length ? r2(lossNet / (traded.length - wins.length)) : 0,
    touchBoundExtraHits: list.filter((r) => r.touchBound).length,
  };
}
type Stats = ReturnType<typeof stats>;

const base = runAll(BASE, true);
const group = <K extends string>(rowsIn: Row[], key: (r: Row) => K) => {
  const m = new Map<K, Row[]>();
  for (const r of rowsIn) (m.get(key(r)) ?? m.set(key(r), []).get(key(r))!).push(r);
  return m;
};
const targetLabels = TARGETS.map(([m, v]) => label(m, v));
const comparison: { series: ExpirySeries; target: string; s: Stats }[] = [];
for (const series of SERIES) for (const t of targetLabels) comparison.push({ series, target: t, s: stats(base.filter((r) => r.series === series && r.target === t)) });

// Breakdowns per series × target × dimension
const DIMS: [string, (r: Row) => string][] = [
  ["Days to expiry", (r) => r.reg.dteBucket], ["Weekday", (r) => r.reg.weekday], ["Trend", (r) => r.reg.trend], ["Volatility (VIX 09:15)", (r) => r.reg.vol], ["Year", (r) => r.reg.year],
];
const breakdown: { series: string; target: string; dim: string; bucket: string; s: Stats }[] = [];
for (const series of SERIES) for (const t of targetLabels) {
  const sel = base.filter((r) => r.series === series && r.target === t);
  for (const [dim, key] of DIMS) for (const [bucket, list] of [...group(sel, key)].sort(([a], [b]) => a.localeCompare(b))) breakdown.push({ series, target: t, dim, bucket, s: stats(list) });
}

// Slippage sensitivity (net only)
const slipRuns = [0, 1, 4].map((ticks) => ({ ticks, rows: runAll({ ...BASE, slippageTicks: ticks }) }));
const sensitivity = comparison.map((c) => ({
  series: c.series, target: c.target,
  net: Object.fromEntries([[BASE.slippageTicks, c.s.totalNet], ...slipRuns.map((sr) => [sr.ticks, stats(sr.rows.filter((r) => r.series === c.series && r.target === c.target)).totalNet])]) as Record<number, number>,
}));

// Diagnostic: equal quantity on both legs (not the spec; shows the cost of unequal CE/PE quantities)
const equalRows = runAll({ ...BASE, sizing: "EQUAL_QTY" });
const equalQty = comparison.map((c) => ({ series: c.series, target: c.target, s: stats(equalRows.filter((r) => r.series === c.series && r.target === c.target)) }));
const hitButLoss = comparison.map((c) => ({ series: c.series, target: c.target, n: base.filter((r) => r.series === c.series && r.target === c.target && r.result?.exitReason === "TARGET" && r.result.net! <= 0).length }));

// Walk-forward: each year, trade the target with the best net over all PRIOR years (expanding); first year has no prior.
const years = [...new Set(sessions.map((s) => s.date.slice(0, 4)))].sort();
const walk: { series: string; year: string; chosen: string; s: Stats; bestInYear: string }[] = [];
for (const series of SERIES) for (let i = 1; i < years.length; i += 1) {
  const prior = base.filter((r) => r.series === series && r.session.date.slice(0, 4) < years[i]);
  const net = (t: string, list: Row[]) => stats(list.filter((r) => r.target === t)).totalNet;
  const chosen = targetLabels.reduce((a, b) => (net(b, prior) > net(a, prior) ? b : a));
  const yearRows = base.filter((r) => r.series === series && r.session.date.slice(0, 4) === years[i]);
  const bestInYear = targetLabels.reduce((a, b) => (net(b, yearRows) > net(a, yearRows) ? b : a));
  walk.push({ series, year: years[i], chosen, s: stats(yearRows.filter((r) => r.target === chosen)), bestInYear });
}
const walkTotal = (series: string) => r2(walk.filter((w) => w.series === series).reduce((a, w) => a + w.s.totalNet, 0));

/* ---------------- write ---------------- */

mkdirSync(OUT, { recursive: true });
const csv = (head: string[], data: (string | number | null | boolean)[][]) => [head.join(","), ...data.map((r) => r.map((v) => (v == null ? "" : typeof v === "string" && /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","))].join("\n");
const statCols: (keyof Stats)[] = ["sessions", "entries", "notExecuted", "targetHits", "targetHitPct", "closedWithoutTarget", "profitDays", "lossDays", "accuracy", "avgHoldMin", "avgHitHoldMin", "avgPoints", "avgGross", "avgNet", "maxProfit", "maxLoss", "maxDrawdown", "totalCharges", "totalGross", "totalNet", "profitFactor", "returnOnDeployedPct", "avgWinNet", "avgLossNet", "touchBoundExtraHits"];
writeFileSync(path.join(OUT, "targets.csv"), csv(["series", "target", ...statCols], comparison.map((c) => [c.series, c.target, ...statCols.map((k) => c.s[k])])));
writeFileSync(path.join(OUT, "breakdown.csv"), csv(["series", "target", "dimension", "bucket", ...statCols], breakdown.map((b) => [b.series, b.target, b.dim, b.bucket, ...statCols.map((k) => b.s[k])])));
writeFileSync(path.join(OUT, "trades.csv"), csv(
  ["series", "target", "date", "weekday", "expiry", "dte", "first_close", "strike", "status", "note", "entry_time", "ce_lots", "ce_qty", "ce_entry", "pe_lots", "pe_qty", "pe_entry", "combined_entry", "target_premium",
    "exit_time", "exit_reason", "ce_exit", "pe_exit", "combined_trigger", "combined_exit", "points", "max_points", "min_points", "hold_min", "invested", "ce_gross", "pe_gross", "gross", "charges", "net", "vix_0915", "day_move_pct", "trend", "touch_bound_hit"],
  base.map((r) => {
    const x = r.result;
    return [r.series, r.target, r.session.date, r.reg.weekday, r.session.series[r.series].expiry, r.reg.dte, r.session.first_close, r.session.series[r.series].strike, x?.status ?? "EXCLUDED", x?.note ?? r.excluded,
      x?.entryTime != null ? clockOf(x.entryTime) : null, x?.ce?.lots ?? null, x?.ce?.quantity ?? null, x?.ce?.entryPrice ?? null, x?.pe?.lots ?? null, x?.pe?.quantity ?? null, x?.pe?.entryPrice ?? null, x?.combinedEntry ?? null, x?.targetPremium ?? null,
      x?.exitTime != null ? clockOf(x.exitTime) : null, x?.exitReason ?? null, x?.ce?.exitPrice ?? null, x?.pe?.exitPrice ?? null, x?.combinedTrigger ?? null, x?.combinedExit ?? null, x?.points ?? null, x?.maxPoints ?? null, x?.minPoints ?? null,
      x?.holdMinutes ?? null, x?.invested ?? null, x?.ce?.gross ?? null, x?.pe?.gross ?? null, x?.gross ?? null, x?.charges ?? null, x?.net ?? null, r.session.vix_0915, r.reg.dayMovePct, r.reg.trend, r.touchBound];
  }),
));
const excludedDays = sessions.filter((s) => SERIES.some((series) => inputFor(s, series).excluded)).map((s) => ({ date: s.date, type: s.session_type, why: SERIES.map((series) => `${series}: ${inputFor(s, series).excluded ?? "ok"}`).join("; ") }));
const summary = {
  window: { from: FROM, to: TO, sessions: sessions.length }, settings: { ...BASE, charges: "HEDGE_CHARGES (dated statutory)" }, vixTerciles: [VIX_LO, VIX_HI],
  comparison, equalQty, hitButLoss, sensitivity, walkForward: walk, walkForwardTotal: Object.fromEntries(SERIES.map((s) => [s, walkTotal(s)])), excludedDays, expiryCalendarCheck: windowInfo.expiry_calendar_check,
};
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));

/* ---------------- report.html ---------------- */

const inr = (v: number | null) => (v == null ? "—" : `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
const cls = (v: number | null) => (v == null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");
const td = (v: string | number | null, c = "") => `<td class="${c}">${v ?? "—"}</td>`;
function compTable(series: ExpirySeries) {
  const list = comparison.filter((c) => c.series === series);
  const best = list.reduce((a, b) => (b.s.totalNet > a.s.totalNet ? b : a));
  return `<table><thead><tr><th>Target</th><th>Entries</th><th>Target hit</th><th>Hit %</th><th>No target</th><th>Profit days</th><th>Loss days</th><th>Accuracy</th><th>Avg hold</th><th>Avg pts</th><th>Avg gross</th><th>Avg net</th><th>Max profit</th><th>Max loss</th><th>Max DD</th><th>Charges</th><th>Net</th><th>PF</th></tr></thead><tbody>${list.map((c) => `<tr${c === best ? ' class="best"' : ""}>${td(c.target)}${td(c.s.entries)}${td(c.s.targetHits)}${td(`${c.s.targetHitPct}%`)}${td(c.s.closedWithoutTarget)}${td(c.s.profitDays)}${td(c.s.lossDays)}${td(`${c.s.accuracy}%`)}${td(`${c.s.avgHoldMin} min`)}${td(c.s.avgPoints, cls(c.s.avgPoints))}${td(inr(c.s.avgGross), cls(c.s.avgGross))}${td(inr(c.s.avgNet), cls(c.s.avgNet))}${td(inr(c.s.maxProfit))}${td(inr(c.s.maxLoss), "neg")}${td(inr(c.s.maxDrawdown), "neg")}${td(inr(c.s.totalCharges))}${td(inr(c.s.totalNet), cls(c.s.totalNet))}${td(c.s.profitFactor)}</tr>`).join("")}</tbody></table>`;
}
function dimTable(series: ExpirySeries, dim: string, targets: string[]) {
  const buckets = [...new Set(breakdown.filter((b) => b.series === series && b.dim === dim).map((b) => b.bucket))];
  const cell = (t: string, bucket: string) => breakdown.find((b) => b.series === series && b.dim === dim && b.target === t && b.bucket === bucket)!.s;
  return `<table><thead><tr><th>${dim}</th>${targets.map((t) => `<th colspan="3">${t}</th>`).join("")}</tr><tr><th></th>${targets.map(() => "<th>Hit %</th><th>Win/Loss</th><th>Net</th>").join("")}</tr></thead><tbody>${buckets.map((bk) => `<tr>${td(bk)}${targets.map((t) => { const s = cell(t, bk); return `${td(`${s.targetHitPct}%`)}${td(`${s.profitDays}/${s.lossDays}`)}${td(inr(s.totalNet), cls(s.totalNet))}`; }).join("")}</tr>`).join("")}</tbody></table>`;
}
const keyTargets = ["+2 pts", "+5 pts", "+10 pts", "+1%", "+3%"];
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATM Hedge Backtest</title><style>
:root{--bg:#fff;--fg:#1d2433;--mute:#667085;--line:#e4e7ec;--pos:#067647;--neg:#b42318;--hl:#fff7e0}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--fg:#e6e8ee;--mute:#98a2b3;--line:#2a2f3a;--pos:#47cd89;--neg:#f97066;--hl:#2d2a1a}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:1300px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p,li{color:var(--mute)}.wrap{overflow-x:auto}
table{border-collapse:collapse;font-size:12.5px;margin:6px 0 14px;white-space:nowrap}th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:right}th:first-child,td:first-child{text-align:left}
th{font-weight:600}.pos{color:var(--pos)}.neg{color:var(--neg)}tr.best td{background:var(--hl)}</style></head><body>
<h1>NIFTY First 1-Minute ATM CE + PE Hedge — backtest</h1>
<p>${FROM} → ${TO} · ${sessions.length} sessions · real 1-minute NIFTY option premiums (Dhan) · capital ${inr(BASE.capital)} split 50/50 · slippage ${BASE.slippageTicks} ticks per order · statutory charges by date + ₹${BASE.charges.brokeragePerOrder}/order · square-off ${clockOf(BASE.squareOffTime)}</p>
<p>Entry: both legs at the 09:16 candle open (+ slippage), strike = 09:15 close → nearest 50. Target on the combined premium only, checked at each minute's open and close (CE high + PE high is never used). Highlighted row = highest net.</p>
${SERIES.map((series) => `<h2>${series === "WEEK" ? "Nearest weekly expiry" : "Nearest monthly expiry"}</h2><div class="wrap">${compTable(series)}</div>`).join("")}
<h2>Why target hits can still lose money</h2><p>With 50/50 capital the cheaper leg gets more quantity, so a combined +points target can close at a rupee loss. Target-hit sessions that closed at a net loss: ${hitButLoss.map((h) => `${h.series} ${h.target}: ${h.n}`).join(" · ")}.</p>
<p>Diagnostic only (not the spec): the same lots on both legs.</p><div class="wrap"><table><thead><tr><th>Series</th><th>Target</th><th>Hit %</th><th>Win/Loss</th><th>Accuracy</th><th>Avg net</th><th>Net</th><th>Max DD</th><th>PF</th></tr></thead><tbody>${equalQty.map((e) => `<tr>${td(e.series)}${td(e.target)}${td(`${e.s.targetHitPct}%`)}${td(`${e.s.profitDays}/${e.s.lossDays}`)}${td(`${e.s.accuracy}%`)}${td(inr(e.s.avgNet), cls(e.s.avgNet))}${td(inr(e.s.totalNet), cls(e.s.totalNet))}${td(inr(e.s.maxDrawdown), "neg")}${td(e.s.profitFactor)}</tr>`).join("")}</tbody></table></div>
<h2>Slippage sensitivity — net</h2><div class="wrap"><table><thead><tr><th>Series</th><th>Target</th>${[0, 1, BASE.slippageTicks, 4].map((t) => `<th>${t} ticks</th>`).join("")}</tr></thead><tbody>${sensitivity.map((x) => `<tr>${td(x.series)}${td(x.target)}${[0, 1, BASE.slippageTicks, 4].map((t) => td(inr(x.net[t]), cls(x.net[t]))).join("")}</tr>`).join("")}</tbody></table></div>
<h2>Walk-forward target choice (best target on all prior years, traded next year)</h2><div class="wrap"><table><thead><tr><th>Series</th><th>Year</th><th>Chosen</th><th>Best in hindsight</th><th>Entries</th><th>Hit %</th><th>Win/Loss</th><th>Net</th></tr></thead><tbody>${walk.map((w) => `<tr>${td(w.series)}${td(w.year)}${td(w.chosen)}${td(w.bestInYear)}${td(w.s.entries)}${td(`${w.s.targetHitPct}%`)}${td(`${w.s.profitDays}/${w.s.lossDays}`)}${td(inr(w.s.totalNet), cls(w.s.totalNet))}</tr>`).join("")}</tbody></table></div>
${SERIES.map((series) => `<h2>${series} — by market condition</h2>${DIMS.map(([dim]) => `<div class="wrap">${dimTable(series, dim, keyTargets)}</div>`).join("")}`).join("")}
<h2>Data notes</h2><ul><li>Excluded sessions (${excludedDays.length}): ${excludedDays.map((d) => `${d.date} (${d.type})`).join(", ")}.</li>
<li>Upper bound for targets touched only inside a minute (not counted above): ${comparison.map((c) => `${c.series} ${c.target} +${c.s.touchBoundExtraHits}`).join(", ")} sessions.</li>
<li>Regime labels are descriptive (trend uses the whole day's move) and are never used to trade. VIX terciles: ${VIX_LO.toFixed(2)} / ${VIX_HI.toFixed(2)}.</li></ul>
</body></html>`;
writeFileSync(path.join(OUT, "report.html"), html);

/* ---------------- console ---------------- */
for (const series of SERIES) {
  console.log(`\n${series}  (${FROM} .. ${TO}, ${sessions.length} sessions)`);
  console.log("target    entries  hit  hit%   win/loss   acc%  avgHold  avgPts   avgNet     net        maxDD     PF");
  for (const c of comparison.filter((x) => x.series === series)) {
    const s = c.s;
    console.log(`${c.target.padEnd(9)} ${String(s.entries).padStart(6)} ${String(s.targetHits).padStart(5)} ${String(s.targetHitPct).padStart(6)} ${`${s.profitDays}/${s.lossDays}`.padStart(10)} ${String(s.accuracy).padStart(6)} ${String(s.avgHoldMin).padStart(7)} ${String(s.avgPoints).padStart(7)} ${String(s.avgNet).padStart(9)} ${String(s.totalNet).padStart(11)} ${String(s.maxDrawdown).padStart(10)} ${String(s.profitFactor).padStart(6)}`);
  }
  console.log(`walk-forward net: ${walkTotal(series)}  (${walk.filter((w) => w.series === series).map((w) => `${w.year}:${w.chosen}→${Math.round(w.s.totalNet)}`).join("  ")})`);
}
console.log("\nEQUAL_QTY diagnostic (series target hit% win/loss net PF):");
for (const e of equalQty) console.log(`${e.series} ${e.target.padEnd(8)} ${e.s.targetHitPct}% ${e.s.profitDays}/${e.s.lossDays} ${e.s.totalNet} ${e.s.profitFactor}`);
console.log("\nslippage net (0/1/2/4 ticks):");
for (const x of sensitivity) console.log(`${x.series} ${x.target.padEnd(8)} ${[0, 1, 2, 4].map((t) => Math.round(x.net[t])).join(" / ")}`);
console.log(`\nwrote ${OUT}`);
