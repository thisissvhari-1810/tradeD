"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, Download } from "lucide-react";
import { api } from "@/components/api";
import { Badge, Drawer, Notice, PageHeader, Section, cx } from "@/components/ui";
import { auditCsv, dailyCsv, FLAG_TEXT, istClock, summarize, type AuditTrade, type IndexBacktestReport, type IndexResult, type IndexStatus, type IndexSummary } from "@/lib/algo/index-backtest";

const inr = (value: number | null | undefined) => (value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const plain = (value: number | null | undefined) => (value == null ? "—" : `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (value: number | null | undefined) => (value == null ? "—" : `${value}%`);
const tone = (value: number | null | undefined) => (value == null ? "text-muted" : value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-text");
/** Categorical slots in fixed order: each index keeps its colour whatever the filters show. */
const SERIES: Record<string, string> = { FINNIFTY: "var(--series-1)", MIDCPNIFTY: "var(--series-2)", NIFTYNXT50: "var(--series-3)" };
const seriesColor = (symbol: string) => SERIES[symbol] ?? "var(--muted)";

const STATUS: Record<IndexStatus, { label: string; tone: "profit" | "warning" | "loss"; icon: ReactNode }> = {
  BACKTESTED: { label: "Backtested", tone: "profit", icon: <CheckCircle2 aria-hidden /> },
  INCOMPLETE: { label: "Incomplete", tone: "warning", icon: <AlertTriangle aria-hidden /> },
  NOT_BACKTESTED: { label: "NOT BACKTESTED", tone: "loss", icon: <CircleSlash aria-hidden /> },
};

type Filters = { from: string; to: string; index: string; right: "ALL" | "CE" | "PE"; session: string; target: "ALL" | "HIT" | "MISSED" };

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Mathi Strategy (+3%) on FINNIFTY, MIDCPNIFTY and NIFTY NEXT 50: the stored backtest (npm run backtest:indices) with
 * one card per index, the comparison table, daily and cumulative net P&L, and every trade with its audit. Filters
 * recompute every figure from the trades themselves; nothing here is estimated beyond what the report labels.
 */
export function IndexComparison() {
  const [data, setData] = useState<{ report: IndexBacktestReport | null; reason: string | null } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ report: IndexBacktestReport | null; reason: string | null }>("/api/algo?indexBacktest=1")
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The backtest results could not be loaded."));
  }, []);

  if (error) return <Notice tone="loss">{error}</Notice>;
  if (!data) return <p className="text-data text-muted">Loading the backtest results…</p>;
  return <IndexComparisonView report={data.report} reason={data.reason} />;
}

/** The dashboard for one stored report (or the reason there is none). */
export function IndexComparisonView({ report, reason }: { report: IndexBacktestReport | null; reason: string | null }) {
  const [filters, setFilters] = useState<Filters | null>(() => (report ? { from: report.window.from, to: report.window.to, index: "ALL", right: "ALL", session: "ALL", target: "ALL" } : null));
  const [open, setOpen] = useState<AuditTrade | null>(null);
  const view = useMemo(() => (report && filters ? filtered(report, filters) : null), [report, filters]);

  if (!report || !filters || !view) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader eyebrow="Backtests" title="Mathi Strategy (+3%) — index comparison" />
        <Notice tone="warning">{reason}</Notice>
      </div>
    );
  }
  const notRun = report.limitations.find((item) => item.startsWith("NOT RUN"));
  const sessions = [...new Set(report.indices.flatMap((result) => result.sessions.filter((session) => session.status === "SIMULATED").map((session) => session.date)))].sort();
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Backtests · paper only, no orders"
        title="Mathi Strategy (+3%) — index comparison"
        description={`${report.window.from} → ${report.window.to}: ${sessions.length || "no"} NSE sessions simulated of ${report.window.weekdays} weekdays${report.window.holidays.length ? ` (exchange holidays: ${report.window.holidays.join(", ")})` : ""}. Data: ${report.provider}. ₹${report.capital.toLocaleString("en-IN")} virtual account per session.`}
        actions={
          <>
            <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-data hover:bg-hover disabled:opacity-50" disabled={!view.trades.length} onClick={() => download(`Mathi-3pct-indices-trades-${filters.from}-to-${filters.to}.csv`, auditCsv(view.trades))}><Download className="h-3.5 w-3.5" aria-hidden />Trades CSV</button>
            <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-data hover:bg-hover disabled:opacity-50" disabled={!view.results.some((item) => item.summary)} onClick={() => download(`Mathi-3pct-indices-daily-${filters.from}-to-${filters.to}.csv`, dailyCsv(view.results.map((item) => ({ symbol: item.result.symbol, daily: item.summary?.daily ?? [] }))))}><Download className="h-3.5 w-3.5" aria-hidden />Daily CSV</button>
          </>
        }
      />
      {notRun ? <Notice tone="warning">{notRun} Then reload this page. No trade, price or profit figure is shown for an index without its own option premiums.</Notice> : null}

      <div className="flex flex-wrap items-end gap-2 text-micro text-text-2" role="group" aria-label="Filters">
        <label className="flex flex-col gap-0.5">From<input type="date" className="compact-field" min={report.window.from} max={filters.to} value={filters.from} onChange={(event) => set({ from: event.target.value || report.window.from })} /></label>
        <label className="flex flex-col gap-0.5">To<input type="date" className="compact-field" min={filters.from} max={report.window.to} value={filters.to} onChange={(event) => set({ to: event.target.value || report.window.to })} /></label>
        <label className="flex flex-col gap-0.5">Index
          <select className="compact-field" value={filters.index} onChange={(event) => set({ index: event.target.value })}><option value="ALL">All three</option>{report.indices.map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}</select>
        </label>
        <label className="flex flex-col gap-0.5">CE / PE
          <select className="compact-field" value={filters.right} onChange={(event) => set({ right: event.target.value as Filters["right"] })}><option value="ALL">Both</option><option value="CE">CE only</option><option value="PE">PE only</option></select>
        </label>
        <label className="flex flex-col gap-0.5">Session
          <select className="compact-field" value={filters.session} onChange={(event) => set({ session: event.target.value })}><option value="ALL">Every session</option>{sessions.map((day) => <option key={day} value={day}>{day}</option>)}</select>
        </label>
        <label className="flex flex-col gap-0.5">Target
          <select className="compact-field" value={filters.target} onChange={(event) => set({ target: event.target.value as Filters["target"] })}><option value="ALL">Reached or not</option><option value="HIT">+3% reached</option><option value="MISSED">Not reached</option></select>
        </label>
        <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => setFilters({ from: report.window.from, to: report.window.to, index: "ALL", right: "ALL", session: "ALL", target: "ALL" })}>Reset</button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {view.results.map((item) => <IndexCard key={item.result.symbol} result={item.result} summary={item.summary} />)}
      </div>

      <Section title="Comparison" description="Net P&L includes every losing exit, the app's estimated charges and 1-tick slippage. Conservative net caps fills above the target at the target. Return % = net ÷ premium deployed." flush>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-micro">
            <thead className="bg-sunken text-left text-muted">
              <tr>{["Index", "Data availability", "Trading sessions", "Total trades", "CE trades", "PE trades", "Target-hit count", "Win rate", "Gross P&L", "Charges (est.)", "Net P&L", "Conservative net", "Net return %", "Maximum drawdown"].map((head, index) => <th key={head} className={cx("px-2 py-1.5", index > 1 && "text-right")}>{head}</th>)}</tr>
            </thead>
            <tbody>
              {view.results.map(({ result, summary }) => (
                <tr key={result.symbol} className="border-t border-border-soft">
                  <td className="px-2 py-1.5 font-semibold"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: seriesColor(result.symbol) }} aria-hidden />{result.symbol}</td>
                  <td className="px-2 py-1.5"><Badge tone={STATUS[result.status].tone}>{STATUS[result.status].icon}{STATUS[result.status].label}</Badge>{result.status !== "NOT_BACKTESTED" ? <span className="ml-1.5 text-muted">actual premiums</span> : null}</td>
                  <td className="num px-2 py-1.5 text-right">{summary?.sessions ?? "—"}</td>
                  <td className="num px-2 py-1.5 text-right">{summary?.trades ?? "—"}</td>
                  <td className="num px-2 py-1.5 text-right">{summary?.ce ?? "—"}</td>
                  <td className="num px-2 py-1.5 text-right">{summary?.pe ?? "—"}</td>
                  <td className="num px-2 py-1.5 text-right">{summary?.targetHits ?? "—"}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(summary?.winRate)}</td>
                  <td className={cx("num px-2 py-1.5 text-right", tone(summary?.gross))}>{summary ? inr(summary.gross) : "—"}</td>
                  <td className="num px-2 py-1.5 text-right">{summary ? plain(summary.charges) : "—"}</td>
                  <td className={cx("num px-2 py-1.5 text-right font-semibold", tone(summary?.net))}>{summary ? inr(summary.net) : "—"}</td>
                  <td className={cx("num px-2 py-1.5 text-right", tone(summary?.netConservative))} title="Fills above the +3% target capped at the target">{summary ? inr(summary.netConservative) : "—"}</td>
                  <td className={cx("num px-2 py-1.5 text-right", tone(summary?.returnOnDeployed))}>{pct(summary?.returnOnDeployed)}</td>
                  <td className="num px-2 py-1.5 text-right">{summary ? plain(summary.maxDrawdown) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section title="Daily net P&L" description={filters.index === "ALL" ? "All shown indices together, after charges." : `${filters.index}, after charges.`}>
          <DailyBars days={view.combinedDaily} />
        </Section>
        <Section title="Cumulative net P&L" description="Per index, trade results summed session by session.">
          <CumulativeLines series={view.results.filter((item) => item.summary?.daily.length).map((item) => ({ symbol: item.result.symbol, days: item.summary!.daily }))} />
        </Section>
      </div>

      <Section title="Daily P&L table" description="Every simulated session, including days without trades." flush>
        <div className="max-h-80 overflow-auto">
          <table className="w-full whitespace-nowrap text-micro">
            <thead className="sticky top-0 bg-sunken text-left text-muted"><tr><th className="px-2 py-1">Date</th>{view.results.filter((item) => item.summary).map((item) => <th key={item.result.symbol} className="px-2 py-1 text-right">{item.result.symbol} trades / net</th>)}<th className="px-2 py-1 text-right">Combined net</th></tr></thead>
            <tbody>
              {view.combinedDaily.map((day) => (
                <tr key={day.date} className="border-t border-border-soft">
                  <td className="num px-2 py-1">{day.date}</td>
                  {view.results.filter((item) => item.summary).map((item) => {
                    const row = item.summary!.daily.find((entry) => entry.date === day.date);
                    return <td key={item.result.symbol} className={cx("num px-2 py-1 text-right", row ? tone(row.net) : "text-muted")}>{row ? `${row.trades} / ${inr(row.net)}` : "not simulated"}</td>;
                  })}
                  <td className={cx("num px-2 py-1 text-right font-semibold", tone(day.net))}>{inr(day.net)}</td>
                </tr>
              ))}
              {!view.combinedDaily.length ? <tr><td className="px-2 py-3 text-muted" colSpan={5}>No simulated sessions.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`Trades (${view.trades.length})`} description="Real trades only (shadow trades of the regime switch are in the export folder). Select a trade for its entry and exit details." flush>
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full whitespace-nowrap text-micro">
            <thead className="sticky top-0 bg-sunken text-left text-muted">
              <tr>{["Date", "Index", "Contract", "Signal", "Entry", "Entry ₹", "Target ₹", "Exit", "Exit ₹", "Reason", "Qty", "Net P&L", "Return", "MAE %", "Flags"].map((head) => <th key={head} className="px-2 py-1">{head}</th>)}</tr>
            </thead>
            <tbody>
              {view.trades.map((trade) => (
                <tr key={trade.id} tabIndex={0} className="cursor-pointer border-t border-border-soft hover:bg-hover focus-visible:bg-hover" onClick={() => setOpen(trade)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(trade); } }}>
                  <td className="num px-2 py-1">{trade.date}</td>
                  <td className="px-2 py-1">{trade.index}</td>
                  <td className="px-2 py-1">{trade.strike} {trade.right}</td>
                  <td className="num px-2 py-1">{istClock(trade.signalTime)}</td>
                  <td className="num px-2 py-1">{istClock(trade.entryTime)}</td>
                  <td className="num px-2 py-1 text-right">{trade.entryPremium.toFixed(2)}</td>
                  <td className="num px-2 py-1 text-right">{trade.targetPremium?.toFixed(2) ?? "—"}</td>
                  <td className="num px-2 py-1">{istClock(trade.exitTime) || "OPEN"}</td>
                  <td className="num px-2 py-1 text-right">{trade.exitPremium?.toFixed(2) ?? "—"}</td>
                  <td className="px-2 py-1">{trade.exitReason ?? "Open"}</td>
                  <td className="num px-2 py-1 text-right">{trade.quantity}</td>
                  <td className={cx("num px-2 py-1 text-right font-semibold", tone(trade.net))}>{inr(trade.net)}</td>
                  <td className={cx("num px-2 py-1 text-right", tone(trade.returnPercent))}>{pct(trade.returnPercent)}</td>
                  <td className="num px-2 py-1 text-right">{pct(trade.maePercent)}</td>
                  <td className="px-2 py-1">{trade.flags.length ? <Badge tone="warning" title={trade.flags.map((flag) => FLAG_TEXT[flag]).join("\n")}>{trade.flags.length} flag{trade.flags.length === 1 ? "" : "s"}</Badge> : <span className="text-muted">OK</span>}</td>
                </tr>
              ))}
              {!view.trades.length ? <tr><td className="px-2 py-3 text-muted" colSpan={15}>{report.indices.some((item) => item.trades.length) ? "No trade matches the filters." : "No simulated trades: see each index's reason above."}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section title="Strategy (unchanged)">
          <ul className="list-disc space-y-1 pl-4 text-data text-text-2">{report.strategy.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
        </Section>
        <Section title="Definitions">
          <dl className="space-y-1.5 text-data">{Object.entries(report.definitions).map(([term, text]) => <div key={term}><dt className="font-semibold text-text">{term}</dt><dd className="text-text-2">{text}</dd></div>)}</dl>
        </Section>
      </div>
      <Section title="Data quality and limitations">
        <ul className="list-disc space-y-1 pl-4 text-data text-text-2">
          {report.limitations.map((item) => <li key={item}>{item}</li>)}
          {report.indices.map((result) => <li key={result.symbol}><span className="font-semibold text-text">{result.symbol}:</span> {qualityLine(result)}</li>)}
        </ul>
      </Section>
      <TradeDrawer trade={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function filtered(report: IndexBacktestReport, filters: Filters) {
  const inRange = (day: string) => day >= filters.from && day <= filters.to && (filters.session === "ALL" || day === filters.session);
  const results = report.indices.filter((result) => filters.index === "ALL" || result.symbol === filters.index).map((result) => {
    const sessions = result.sessions.filter((session) => session.status === "SIMULATED" && inRange(session.date)).map((session) => session.date);
    const trades = result.trades.filter((trade) => inRange(trade.date) && (filters.right === "ALL" || trade.right === filters.right) && (filters.target === "ALL" || (filters.target === "HIT") === trade.targetHit));
    return { result, trades, summary: result.summary ? summarize(trades, sessions, report.capital) : null };
  });
  const dates = [...new Set(results.flatMap((item) => item.summary?.daily.map((day) => day.date) ?? []))].sort();
  let cumulative = 0;
  const combinedDaily = dates.map((date) => {
    const rows = results.flatMap((item) => item.summary?.daily.filter((day) => day.date === date) ?? []);
    const net = Math.round(rows.reduce((sum, day) => sum + day.net, 0) * 100) / 100;
    cumulative = Math.round((cumulative + net) * 100) / 100;
    return { date, net, trades: rows.reduce((sum, day) => sum + day.trades, 0), cumulative };
  });
  return { results, combinedDaily, trades: results.flatMap((item) => item.trades).sort((a, b) => a.entryTime - b.entryTime) };
}

function qualityLine(result: IndexResult) {
  const q = result.dataQuality;
  const skipped = result.sessions.filter((session) => session.status === "SKIPPED");
  const spot = result.sessions.reduce((sum, session) => ({ checked: sum.checked + session.spotChecked, bad: sum.bad + session.spotMismatched }), { checked: 0, bad: 0 });
  const mismatch = result.sessions.filter((session) => session.expiry?.mismatch).length;
  if (result.status === "NOT_BACKTESTED") return `NOT BACKTESTED — ${result.reason}`;
  return [
    `premiums: ${result.premiumSource}`,
    `lot size ${result.spec.lotSize} (${result.spec.lotSizeSource})`,
    `${skipped.length} session(s) skipped${skipped.length ? ` (${skipped.map((session) => session.date).join(", ")})` : ""}`,
    `${q.incompleteSessions.length} with missing index minutes`,
    `${q.duplicates} duplicate and ${q.outsideSession} out-of-session index rows dropped`,
    `option spot vs index: ${spot.bad} of ${spot.checked} rows differ`,
    `offsets with data: ${q.offsetsWithData.length ? q.offsetsWithData.join(" ") : "none"}`,
    `${q.requestFailures.length} failed requests`,
    `${mismatch} session(s) whose expiry differs from the last-Tuesday rule`,
    `trades re-checked against their option candles: ${q.verification.checked}, mismatches ${q.verification.problems.length}`,
  ].join("; ");
}

function IndexCard({ result, summary }: { result: IndexResult; summary: IndexSummary | null }) {
  const status = STATUS[result.status];
  return (
    <section className="surface flex flex-col gap-2 p-4" aria-label={`${result.symbol} result`}>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: seriesColor(result.symbol) }} aria-hidden />
        <h2 className="flex-1 text-title font-semibold text-text">{result.symbol} <span className="text-data font-normal text-muted">{result.name}</span></h2>
        <Badge tone={status.tone}>{status.icon}{status.label}</Badge>
      </div>
      {summary && result.status !== "NOT_BACKTESTED" ? (
        <>
          <p className={cx("num text-xl font-semibold", tone(summary.net))}>{inr(summary.net)} <span className="text-micro font-normal text-muted">net after est. charges</span></p>
          <dl className="grid grid-cols-3 gap-x-2 gap-y-1.5 text-micro">
            <Cell label="Trades (CE/PE)" value={`${summary.trades} (${summary.ce}/${summary.pe})`} />
            <Cell label="Win rate" value={pct(summary.winRate)} />
            <Cell label="+3% hit" value={`${summary.targetHits} of ${summary.trades}`} />
            <Cell label="Avg win / loss" value={`${pct(summary.avgWinReturn)} / ${pct(summary.avgLossReturn)}`} />
            <Cell label="Largest loss" value={inr(summary.largestLoss)} />
            <Cell label="Max drawdown" value={`${plain(summary.maxDrawdown)} (${pct(summary.maxDrawdownPercent)})`} />
            <Cell label="Worst MAE" value={pct(summary.worstMaePercent)} />
            <Cell label="Losing streak" value={String(summary.maxConsecutiveLosses)} />
            <Cell label="Avg hold" value={summary.avgHoldingMinutes == null ? "—" : `${summary.avgHoldingMinutes} min`} />
          </dl>
          <p className="text-micro text-text-2">Conservative (target-capped fills): <span className={cx("num font-semibold", tone(summary.netConservative))}>{inr(summary.netConservative)}</span>{summary.staleEntries ? ` · ${summary.staleEntries} of ${summary.trades} entries in minutes without option trades` : ""}</p>
          {result.sensitivity ? <p className="text-micro text-muted">Estimates: net at statutory charges {inr(result.sensitivity.netAtStatutoryCharges)}; net with {result.sensitivity.stressSlippageTicks}-tick slippage {inr(result.sensitivity.netAtStressSlippage)}.</p> : null}
          {result.status === "INCOMPLETE" ? <p className="text-micro text-warning">{result.reason}</p> : null}
        </>
      ) : <p className="text-data text-text-2">{result.reason}</p>}
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-muted">{label}</dt><dd className="num truncate font-medium text-text">{value}</dd></div>;
}

/* ---------------- charts (SVG, one y-axis each, hover tooltips) ---------------- */

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

const HEIGHT = 220;
const PAD = { top: 12, right: 72, bottom: 24, left: 64 };

function scale(values: number[]) {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = 10 ** Math.floor(Math.log10(span / 4));
  const nice = [1, 2, 5, 10].map((m) => m * step).find((s) => span / s <= 5) ?? step * 10;
  const top = Math.ceil(max / nice) * nice;
  const bottom = Math.floor(min / nice) * nice;
  const ticks: number[] = [];
  for (let value = bottom; value <= top + nice / 2; value += nice) ticks.push(Math.round(value));
  return { top, bottom: bottom === top ? top - 1 : bottom, ticks };
}
const compact = (value: number) => `${value < 0 ? "−" : ""}₹${Math.abs(value) >= 1000 ? `${(Math.abs(value) / 1000).toFixed(Math.abs(value) >= 10_000 ? 0 : 1)}k` : Math.abs(value)}`;

function Axis({ y, ticks, width }: { y: (value: number) => number; ticks: number[]; width: number }) {
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} strokeOpacity={tick === 0 ? 0.5 : 1} />
          <text x={PAD.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted" fontSize={11}>{compact(tick)}</text>
        </g>
      ))}
    </g>
  );
}

function Empty() {
  return <p className="grid h-[220px] place-items-center text-data text-muted">No simulated sessions to chart.</p>;
}

function DailyBars({ days }: { days: Array<{ date: string; net: number; trades: number }> }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  if (!days.length) return <div ref={ref}><Empty /></div>;
  const s = scale(days.map((day) => day.net));
  const y = (value: number) => PAD.top + ((s.top - value) / (s.top - s.bottom)) * (HEIGHT - PAD.top - PAD.bottom);
  const band = (width - PAD.left - PAD.right) / days.length;
  const bar = Math.max(2, Math.min(24, band - 2));
  const point = hover == null ? null : days[hover];
  return (
    <div ref={ref} className="relative">
      <svg width={width} height={HEIGHT} role="img" aria-label="Daily net P&L bars">
        <Axis y={y} ticks={s.ticks} width={width} />
        {days.map((day, index) => {
          const x = PAD.left + index * band + (band - bar) / 2;
          const top = Math.min(y(day.net), y(0));
          const height = Math.max(day.net === 0 ? 0 : 1, Math.abs(y(day.net) - y(0)));
          const r = Math.min(4, height / 2, bar / 2);
          // Rounded on the data end only, square on the baseline.
          const path = day.net >= 0
            ? `M${x},${top + height} V${top + r} Q${x},${top} ${x + r},${top} H${x + bar - r} Q${x + bar},${top} ${x + bar},${top + r} V${top + height} Z`
            : `M${x},${top} V${top + height - r} Q${x},${top + height} ${x + r},${top + height} H${x + bar - r} Q${x + bar},${top + height} ${x + bar},${top + height - r} V${top} Z`;
          return (
            <g key={day.date}>
              <path d={path} fill={day.net >= 0 ? "var(--profit)" : "var(--loss)"} opacity={hover == null || hover === index ? 1 : 0.45} />
              <rect x={PAD.left + index * band} y={PAD.top} width={band} height={HEIGHT - PAD.top - PAD.bottom} fill="transparent" onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)} />
            </g>
          );
        })}
        <text x={PAD.left} y={HEIGHT - 6} className="fill-muted" fontSize={11}>{days[0].date}</text>
        <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end" className="fill-muted" fontSize={11}>{days.at(-1)!.date}</text>
      </svg>
      {point ? (
        <div className="pointer-events-none absolute top-1 rounded-md border border-border bg-panel px-2 py-1 text-micro shadow-md" style={{ left: Math.min(width - 170, Math.max(0, PAD.left + hover! * band)) }}>
          <p className="font-semibold text-text">{point.date}</p>
          <p className="num text-text-2">Net {inr(point.net)} · {point.trades} trade{point.trades === 1 ? "" : "s"}</p>
        </div>
      ) : null}
    </div>
  );
}

function CumulativeLines({ series }: { series: Array<{ symbol: string; days: Array<{ date: string; cumulative: number }> }> }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const dates = [...new Set(series.flatMap((item) => item.days.map((day) => day.date)))].sort();
  if (!dates.length) return <div ref={ref}><Empty /></div>;
  const s = scale(series.flatMap((item) => item.days.map((day) => day.cumulative)));
  const y = (value: number) => PAD.top + ((s.top - value) / (s.top - s.bottom)) * (HEIGHT - PAD.top - PAD.bottom);
  const x = (index: number) => PAD.left + (dates.length === 1 ? (width - PAD.left - PAD.right) / 2 : (index / (dates.length - 1)) * (width - PAD.left - PAD.right));
  const at = (item: (typeof series)[number], date: string) => item.days.find((day) => day.date === date) ?? null;
  return (
    <div ref={ref} className="relative">
      <div className="mb-1 flex flex-wrap gap-3 text-micro text-text-2" aria-label="Legend">
        {series.map((item) => <span key={item.symbol} className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full" style={{ background: seriesColor(item.symbol) }} aria-hidden />{item.symbol}</span>)}
      </div>
      <svg width={width} height={HEIGHT} role="img" aria-label="Cumulative net P&L by index" onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const left = event.currentTarget.getBoundingClientRect().left;
          const position = (event.clientX - left - PAD.left) / Math.max(1, width - PAD.left - PAD.right);
          setHover(Math.max(0, Math.min(dates.length - 1, Math.round(position * (dates.length - 1)))));
        }}>
        <Axis y={y} ticks={s.ticks} width={width} />
        {hover != null ? <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="var(--chart-crosshair)" strokeDasharray="3 3" /> : null}
        {series.map((item) => {
          const points = dates.map((date, index) => ({ index, day: at(item, date) })).filter((point) => point.day);
          const last = points.at(-1)!;
          return (
            <g key={item.symbol}>
              <polyline points={points.map((point) => `${x(point.index)},${y(point.day!.cumulative)}`).join(" ")} fill="none" stroke={seriesColor(item.symbol)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(last.index)} cy={y(last.day!.cumulative)} r={4} fill={seriesColor(item.symbol)} stroke="var(--panel)" strokeWidth={2} />
              <text x={x(last.index) + 8} y={y(last.day!.cumulative)} dy="0.32em" fontSize={11} className="fill-text">{item.symbol}</text>
              {hover != null && at(item, dates[hover]) ? <circle cx={x(hover)} cy={y(at(item, dates[hover])!.cumulative)} r={4} fill={seriesColor(item.symbol)} stroke="var(--panel)" strokeWidth={2} /> : null}
            </g>
          );
        })}
        <text x={PAD.left} y={HEIGHT - 6} className="fill-muted" fontSize={11}>{dates[0]}</text>
        <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end" className="fill-muted" fontSize={11}>{dates.at(-1)}</text>
      </svg>
      {hover != null ? (
        <div className="pointer-events-none absolute top-6 rounded-md border border-border bg-panel px-2 py-1 text-micro shadow-md" style={{ left: Math.min(width - 190, Math.max(0, x(hover) + 8)) }}>
          <p className="font-semibold text-text">{dates[hover]}</p>
          {series.map((item) => {
            const day = at(item, dates[hover]);
            return <p key={item.symbol} className="num flex items-center gap-1.5 text-text-2"><span className="h-2 w-2 rounded-full" style={{ background: seriesColor(item.symbol) }} aria-hidden />{item.symbol} {day ? inr(day.cumulative) : "not simulated"}</p>;
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- one trade ---------------- */

function TradeDrawer({ trade, onClose }: { trade: AuditTrade | null; onClose: () => void }) {
  return (
    <Drawer open={Boolean(trade)} onClose={onClose} label="Trade details" title={trade ? `${trade.index} ${trade.strike} ${trade.right}` : ""} subtitle={trade ? `${trade.date} · expiry ${trade.expiry ?? "unknown"} · ${trade.lots ?? "?"} lot(s) × ${trade.lotSize ?? "?"}` : undefined} width="w-[28rem]">
      {trade ? (
        <div className="flex flex-col gap-3 text-data">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-micro">
            <Cell label="Signal candle (crossing)" value={istClock(trade.signalTime)} />
            <Cell label="Entry (after the retest)" value={`${istClock(trade.entryTime)} @ ₹${trade.entryPremium.toFixed(2)}`} />
            <Cell label="Target (+3%)" value={trade.targetPremium == null ? "—" : `₹${trade.targetPremium.toFixed(2)}`} />
            <Cell label="Exit" value={trade.exitTime == null ? "OPEN" : `${istClock(trade.exitTime)} @ ₹${trade.exitPremium?.toFixed(2)}`} />
            <Cell label="Exit reason" value={trade.exitReason ?? "Open"} />
            <Cell label="Holding" value={trade.holdingMinutes == null ? "—" : `${trade.holdingMinutes} min`} />
            <Cell label="Quantity" value={String(trade.quantity)} />
            <Cell label="Deployed" value={plain(trade.deployed)} />
            <Cell label="Gross P&L" value={inr(trade.gross)} />
            <Cell label="Charges (est.)" value={plain(trade.charges)} />
            <Cell label="Net P&L" value={inr(trade.net)} />
            <Cell label="Return on premium" value={pct(trade.returnPercent)} />
            <Cell label="MFE (best)" value={trade.mfe == null ? "—" : `₹${trade.mfe} (${trade.mfePercent}%)`} />
            <Cell label="MAE (worst)" value={trade.mae == null ? "—" : `₹${trade.mae} (${trade.maePercent}%)`} />
            <Cell label="Slippage in prices" value={plain(trade.slippage)} />
            <Cell label="Lines" value={trade.lines.join(", ") || "—"} />
          </dl>
          <div>
            <p className="text-micro font-semibold text-text-2">Option candles used</p>
            <ul className="num text-micro text-text-2">
              <li>Signal minute: {trade.evidence.signalCandle ? `O ${trade.evidence.signalCandle.open} H ${trade.evidence.signalCandle.high} L ${trade.evidence.signalCandle.low} C ${trade.evidence.signalCandle.close} · vol ${trade.evidence.signalCandle.volume ?? "—"}` : "no trade in that minute (earlier premium used)"}</li>
              {trade.targetHit ? <li>Target minute: {trade.evidence.targetCandle ? `O ${trade.evidence.targetCandle.open} H ${trade.evidence.targetCandle.high} L ${trade.evidence.targetCandle.low} C ${trade.evidence.targetCandle.close}` : "—"}</li> : null}
              <li>Minutes held {trade.evidence.heldMinutes}, without option trades {trade.evidence.missingMinutes}</li>
            </ul>
          </div>
          <div>
            <p className="text-micro font-semibold text-text-2">Data quality</p>
            {trade.flags.length ? <ul className="list-disc pl-4 text-micro text-warning">{trade.flags.map((flag) => <li key={flag}><span className="font-semibold">{flag}</span>: {FLAG_TEXT[flag]}</li>)}</ul> : <p className="text-micro text-muted">No flags: the fills match whole option candles.</p>}
          </div>
          <div>
            <p className="text-micro font-semibold text-text-2">Engine log</p>
            <ol className="space-y-1 text-micro text-text-2">{trade.timeline.map((event, index) => <li key={index}><span className="num text-muted">{istClock(event.time)}</span> {event.text}</li>)}</ol>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
