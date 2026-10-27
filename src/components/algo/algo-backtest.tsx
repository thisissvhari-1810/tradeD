"use client";

import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { backtestCsv, backtestTotals, chooseOnTraining, CONFIRMATION_SHORT, lastTradingDays, SPLIT_LABEL, splitDates, tradingDays, variantLabel, type BacktestDay, type BacktestTotals, type BacktestVariant } from "@/lib/algo/backtest";

const inr = (value: number | null | undefined) => (value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const tone = (value: number | null | undefined) => (value == null ? "text-muted" : value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-text");
const todayIst = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
const short = (variant: BacktestVariant) => (variant === "saved" ? "Saved" : variant === "baseline" ? "No filters" : variant.startsWith("confirm:") ? CONFIRMATION_SHORT[variant.slice(8) as keyof typeof CONFIRMATION_SHORT] ?? variant : variant.replace("score:", "Score "));

/**
 * Multi-day backtest of the saved settings: each day is simulated on the server (real 1-minute candles and
 * option premiums, charges and slippage, a virtual account, nothing stored, no orders), one day per request
 * so a long range never times out. Optional comparisons: the filters off, and other minimum scores. The
 * days are split in time order into training / validation / out-of-sample parts; a variant is chosen on the
 * training days only and then reported on the other two.
 */
export function MultiDayBacktest({ disabled, strategy = "EXISTING_ALGO" }: { disabled: string | null; strategy?: "EXISTING_ALGO" | "PRIMARY_STRATEGY" | "MATHI_5" }) {
  const [range] = useState(() => lastTradingDays(todayIst(), 20));
  const [from, setFrom] = useState(range[0]);
  const [to, setTo] = useState(range.at(-1)!);
  const [compare, setCompare] = useState(false);
  const [confirmModes, setConfirmModes] = useState(false);
  const [scores, setScores] = useState("");
  const [days, setDays] = useState<BacktestDay[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const cancel = useRef(false);

  const scoreVariants = [...new Set(scores.split(/[\s,]+/).filter(Boolean).map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 100))].slice(0, 4).map((value) => `score:${value}`);
  const mathi = strategy === "EXISTING_ALGO" || strategy === "MATHI_5";
  // Mathi Strategy: the same saved settings with each breakout confirmation mode, side by side.
  const confirmVariants = mathi && confirmModes ? ["confirm:single", "confirm:hold", "confirm:retest"] : [];
  const planned: BacktestVariant[] = confirmVariants.length ? confirmVariants : ["saved", ...(compare ? ["baseline"] : []), ...scoreVariants];
  const plannedDates = tradingDays(from, to, 60).filter((date) => date < todayIst());

  async function start() {
    if (!plannedDates.length) {
      setError("Choose a range of past weekdays (up to 60).");
      return;
    }
    cancel.current = false;
    setError("");
    setDays([]);
    setProgress({ done: 0, total: plannedDates.length * planned.length });
    const results: BacktestDay[] = [];
    for (const date of plannedDates) {
      for (const variant of planned) {
        if (cancel.current) break;
        try {
          results.push(await api<BacktestDay>("/api/algo", { action: "backtestDay", date, variant, strategy }));
        } catch (caught) {
          results.push({ date, variant, ok: false, reason: caught instanceof Error ? caught.message : "The request failed." });
        }
        setDays([...results]);
        setProgress({ done: results.length, total: plannedDates.length * planned.length });
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

  const variants = [...new Set(days.map((day) => day.variant))];
  const dates = [...new Set(days.map((day) => day.date))].sort();
  const split = splitDates(dates);
  const chosen = !progress && variants.length > 1 ? chooseOnTraining(days, variants) : null;
  const reported = chosen ?? (variants.includes("saved") ? "saved" : variants[0]);
  return (
    <details className="rounded-md border border-border-soft">
      <summary className="cursor-pointer px-2 py-1.5 font-medium text-text-2">Multi-day backtest</summary>
      <div className="space-y-2 border-t border-border-soft p-2">
        <p className="text-micro leading-snug text-muted">Runs your <strong>saved</strong> settings over past days: real 1-minute candles and option premiums, charges and slippage, a virtual account; nothing is stored or sent anywhere. Expired contracts cannot be looked up, so each day uses the nearest still-listed expiry; older days are less realistic.</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <input type="date" className="compact-field w-[8.5rem]" aria-label="From" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
          <span className="text-micro text-muted">to</span>
          <input type="date" className="compact-field w-[8.5rem]" aria-label="To" value={to} min={from} max={range.at(-1)} onChange={(event) => setTo(event.target.value)} />
        </div>
        {mathi ? <label className="flex cursor-pointer items-center gap-1.5 text-micro text-text-2"><input type="checkbox" className="oc-check" checked={confirmModes} onChange={(event) => setConfirmModes(event.target.checked)} />Compare breakout confirmation: single candle / breakout hold / retest</label> : null}
        {confirmModes && mathi ? <p className="text-micro text-muted">Each mode runs on the same days with your other saved settings. Judge them on the later, untouched days, not on one session.</p> : null}
        <label className={cx("flex cursor-pointer items-center gap-1.5 text-micro text-text-2", confirmModes && mathi && "opacity-50")}><input type="checkbox" className="oc-check" disabled={confirmModes && mathi} checked={compare} onChange={(event) => setCompare(event.target.checked)} />Also run with the entry filters and structure stop off</label>
        <label className="flex items-center gap-1.5 text-micro text-text-2">Also compare minimum scores
          <input className="compact-field w-[7.5rem]" aria-label="Minimum scores to compare" placeholder="e.g. 50, 70" value={scores} onChange={(event) => setScores(event.target.value)} />
        </label>
        <p className="text-micro text-muted">{plannedDates.length} day{plannedDates.length === 1 ? "" : "s"} × {planned.length} variant{planned.length === 1 ? "" : "s"} = {plannedDates.length * planned.length} simulations.</p>
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
        {variants.length ? (
          <div className="grid grid-cols-1 gap-2">
            {variants.map((variant) => <Totals key={variant} title={`${variantLabel(variant)}${variant === chosen ? " · chosen on training days" : ""}`} totals={backtestTotals(days.filter((day) => day.variant === variant))} />)}
          </div>
        ) : null}
        {reported && dates.length >= 5 && !progress ? (
          <div className="rounded-md border border-border-soft p-2">
            <p className="text-micro font-semibold text-text-2">{variantLabel(reported)}: by period</p>
            <p className="text-micro text-muted">{chosen ? "Chosen on the training days only; validation and out-of-sample were not used for the choice." : "Days in time order: settings should be judged on the later, untouched days."}</p>
            <table className="mt-1 w-full whitespace-nowrap text-micro">
              <thead className="text-left text-muted"><tr><th className="py-0.5">Part</th><th className="py-0.5 text-right">Trades</th><th className="py-0.5 text-right">Win %</th><th className="py-0.5 text-right">PF</th><th className="py-0.5 text-right">Net P&amp;L</th></tr></thead>
              <tbody>
                {(["training", "validation", "test"] as const).map((name) => {
                  const totals = backtestTotals(days.filter((day) => day.variant === reported && split[name].includes(day.date)));
                  return <tr key={name} className="border-t border-border-soft"><td className="py-0.5">{SPLIT_LABEL[name]}</td><td className="num py-0.5 text-right">{totals.trades}</td><td className="num py-0.5 text-right">{totals.winRate ?? "—"}</td><td className="num py-0.5 text-right">{totals.profitFactor ?? "—"}</td><td className={cx("num py-0.5 text-right", tone(totals.pnl))}>{inr(totals.pnl)}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {dates.length ? (
          <div className="max-h-64 overflow-auto rounded-md border border-border-soft">
            <table className="w-full whitespace-nowrap text-micro">
              <thead className="sticky top-0 bg-sunken text-left text-muted"><tr><th className="px-1.5 py-1">Day</th>{variants.map((variant) => <th key={variant} className="px-1.5 py-1 text-right">{short(variant)}</th>)}</tr></thead>
              <tbody>
                {dates.map((date) => (
                  <tr key={date} className="border-t border-border-soft">
                    <td className="num px-1.5 py-1">{date}</td>
                    {variants.map((variant) => {
                      const day = days.find((item) => item.date === date && item.variant === variant);
                      return <td key={variant} className={cx("num px-1.5 py-1 text-right", day?.ok ? tone(day.stats.realized) : "text-muted")} title={day && !day.ok ? day.reason : day?.ok ? `${day.trades.length} trade${day.trades.length === 1 ? "" : "s"} (${day.stats.wins}/${day.stats.losses})` : undefined}>{day ? (day.ok ? (day.trades.length ? inr(day.stats.realized) : "no trade") : "skipped") : "…"}</td>;
                    })}
                  </tr>
                ))}
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
      <p className={cx("num text-lg font-semibold", tone(totals.pnl))}>{inr(totals.pnl)} <span className="text-micro font-normal text-muted">net, after charges</span></p>
      <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-micro">
        <Cell label="Trades (W/L)" value={`${totals.trades} (${totals.wins}/${totals.losses})`} />
        <Cell label="Win rate" value={totals.winRate == null ? "—" : `${totals.winRate}%`} />
        <Cell label="Profit factor" value={totals.profitFactor == null ? "—" : String(totals.profitFactor)} />
        <Cell label="Avg trade" value={inr(totals.averageTrade)} />
        <Cell label="Avg win" value={inr(totals.averageWin)} />
        <Cell label="Avg loss" value={inr(totals.averageLoss)} />
        <Cell label="Avg R" value={totals.averageR == null ? "—" : `${totals.averageR}R`} />
        <Cell label="Max drawdown" value={`₹${totals.maxDrawdown.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`} />
        <Cell label="Losing streak" value={String(totals.maxConsecutiveLosses)} />
        <Cell label="False breakouts" value={totals.falseBreakouts == null ? "—" : `${totals.falseBreakouts}%`} />
        <Cell label="Trades / day" value={totals.tradesPerDay == null ? "—" : String(totals.tradesPerDay)} />
        <Cell label="No-trade days" value={totals.noTradeDays == null ? "—" : `${totals.noTradeDays}%`} />
        <Cell label="Target days" value={totals.targetDays == null ? "—" : `${totals.targetDays}%`} />
        <Cell label="Days" value={`${totals.days - totals.daysSkipped} run · ${totals.daysSkipped} skipped`} />
        <Cell label="Breakouts detected" value={String(totals.detected)} />
        <Cell label="False breakouts filtered" value={String(totals.filtered)} />
        <Cell label="Expired" value={String(totals.expired)} />
        <Cell label="Target hits" value={String(totals.targetHits)} />
        <Cell label="Open at session end" value={String(totals.openAtEnd)} />
        <Cell label="Gross P&L" value={inr(totals.gross)} />
        <Cell label="Worst adverse / unit" value={totals.worstAdverse == null ? "—" : `₹${totals.worstAdverse}`} />
        <Cell label="Avg adverse / unit" value={totals.averageAdverse == null ? "—" : `₹${totals.averageAdverse}`} />
      </dl>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-muted">{label}</dt><dd className="num truncate font-medium text-text">{value}</dd></div>;
}
