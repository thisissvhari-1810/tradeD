"use client";

import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { backtestCsv, backtestTotals, lastTradingDays, tradingDays, type BacktestDay, type BacktestTotals } from "@/lib/algo/backtest";

const inr = (value: number | null | undefined) => (value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const tone = (value: number | null | undefined) => (value == null ? "text-muted" : value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-text");
const todayIst = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);

/**
 * Multi-day backtest of the saved settings: each day is simulated on the server (real 1-minute candles and
 * option premiums, a virtual account, nothing stored, no orders), one day per request so a long range never
 * times out. Optionally the same days without the trade filters and structure stop, to compare.
 */
export function MultiDayBacktest({ disabled }: { disabled: string | null }) {
  const [range] = useState(() => lastTradingDays(todayIst(), 20));
  const [from, setFrom] = useState(range[0]);
  const [to, setTo] = useState(range.at(-1)!);
  const [compare, setCompare] = useState(true);
  const [days, setDays] = useState<BacktestDay[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const cancel = useRef(false);

  async function start() {
    const dates = tradingDays(from, to, 60).filter((date) => date < todayIst());
    if (!dates.length) {
      setError("Choose a range of past weekdays (up to 60).");
      return;
    }
    const variants = compare ? (["saved", "baseline"] as const) : (["saved"] as const);
    cancel.current = false;
    setError("");
    setDays([]);
    setProgress({ done: 0, total: dates.length * variants.length });
    const results: BacktestDay[] = [];
    for (const date of dates) {
      for (const variant of variants) {
        if (cancel.current) break;
        try {
          results.push(await api<BacktestDay>("/api/algo", { action: "backtestDay", date, variant }));
        } catch (caught) {
          results.push({ date, variant, ok: false, reason: caught instanceof Error ? caught.message : "The request failed." });
        }
        setDays([...results]);
        setProgress({ done: results.length, total: dates.length * variants.length });
      }
      if (cancel.current) break;
    }
    setProgress(null);
  }

  function download() {
    const blob = new Blob([backtestCsv(days)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `TradeD-Algo-backtest-${from}-to-${to}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  const saved = days.filter((day) => day.variant === "saved");
  const baseline = days.filter((day) => day.variant === "baseline");
  const dates = [...new Set(days.map((day) => day.date))].sort();
  return (
    <details className="rounded-md border border-border-soft">
      <summary className="cursor-pointer px-2 py-1.5 font-medium text-text-2">Multi-day backtest</summary>
      <div className="space-y-2 border-t border-border-soft p-2">
        <p className="text-micro leading-snug text-muted">Runs your <strong>saved</strong> settings over past days: real 1-minute candles and option premiums, a virtual account; nothing is stored or sent anywhere. Expired contracts cannot be looked up, so each day uses the nearest still-listed expiry; older days are less realistic.</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <input type="date" className="compact-field w-[8.5rem]" aria-label="From" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
          <span className="text-micro text-muted">to</span>
          <input type="date" className="compact-field w-[8.5rem]" aria-label="To" value={to} min={from} max={range.at(-1)} onChange={(event) => setTo(event.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-micro text-text-2"><input type="checkbox" className="oc-check" checked={compare} onChange={(event) => setCompare(event.target.checked)} />Also run without the trade filters and structure stop (to compare)</label>
        {disabled ? <p className="text-micro text-warning">{disabled}</p> : null}
        <div className="flex gap-1.5">
          {progress ? (
            <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => { cancel.current = true; }}>Cancel ({progress.done}/{progress.total})</button>
          ) : (
            <button type="button" className="h-8 rounded-md bg-primary px-3 font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={Boolean(disabled)} onClick={() => void start()}>Run multi-day backtest</button>
          )}
          {days.length && !progress ? <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 hover:bg-hover" onClick={download}><Download className="h-3.5 w-3.5" aria-hidden />CSV</button> : null}
        </div>
        {progress ? <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><div className="h-full bg-primary transition-[width]" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div> : null}
        {error ? <p className="text-micro text-loss" role="alert">{error}</p> : null}
        {saved.length ? (
          <div className="grid grid-cols-1 gap-2">
            <Totals title="With fixes (your saved settings)" totals={backtestTotals(saved)} />
            {baseline.length ? <Totals title="Without fixes (filters and structure stop off)" totals={backtestTotals(baseline)} /> : null}
          </div>
        ) : null}
        {dates.length ? (
          <div className="max-h-64 overflow-auto rounded-md border border-border-soft">
            <table className="w-full whitespace-nowrap text-micro">
              <thead className="sticky top-0 bg-sunken text-left text-muted"><tr><th className="px-1.5 py-1">Day</th><th className="px-1.5 py-1 text-right">Trades</th><th className="px-1.5 py-1 text-right">With fixes</th>{baseline.length ? <th className="px-1.5 py-1 text-right">Without</th> : null}</tr></thead>
              <tbody>
                {dates.map((date) => {
                  const a = saved.find((day) => day.date === date);
                  const b = baseline.find((day) => day.date === date);
                  return (
                    <tr key={date} className="border-t border-border-soft">
                      <td className="num px-1.5 py-1">{date}</td>
                      <td className="num px-1.5 py-1 text-right">{a?.ok ? `${a.trades.length} (${a.stats.wins}/${a.stats.losses})` : ""}</td>
                      <td className={cx("num px-1.5 py-1 text-right", a?.ok ? tone(a.stats.realized) : "text-muted")} title={a && !a.ok ? a.reason : undefined}>{a ? (a.ok ? inr(a.stats.realized) : "skipped") : "…"}</td>
                      {baseline.length ? <td className={cx("num px-1.5 py-1 text-right", b?.ok ? tone(b.stats.realized) : "text-muted")} title={b && !b.ok ? b.reason : undefined}>{b ? (b.ok ? inr(b.stats.realized) : "skipped") : "…"}</td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function Totals({ title, totals }: { title: string; totals: BacktestTotals }) {
  return (
    <div className="rounded-md border border-border-soft p-2">
      <p className="text-micro font-semibold text-text-2">{title}</p>
      <p className={cx("num text-lg font-semibold", tone(totals.pnl))}>{inr(totals.pnl)}</p>
      <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-micro">
        <Cell label="Trades (W/L)" value={`${totals.trades} (${totals.wins}/${totals.losses})`} />
        <Cell label="Win rate" value={totals.winRate == null ? "—" : `${totals.winRate}%`} />
        <Cell label="Profit factor" value={totals.profitFactor == null ? "—" : String(totals.profitFactor)} />
        <Cell label="Avg / day" value={inr(totals.averagePerDay)} />
        <Cell label="Max drawdown" value={`₹${totals.maxDrawdown.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`} />
        <Cell label="Days" value={`${totals.days - totals.daysSkipped} run · ${totals.daysSkipped} skipped`} />
      </dl>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-muted">{label}</dt><dd className="num truncate font-medium text-text">{value}</dd></div>;
}
