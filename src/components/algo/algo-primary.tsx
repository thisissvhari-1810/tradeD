"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { Field, Info, NumberInput, type AlgoData } from "@/components/algo/algo-panel";
import { MultiDayBacktest } from "@/components/algo/algo-backtest";
import { announceSaved } from "@/components/algo/algo-settings-sync";
import { ALGO_STRATEGIES, STRATEGY_DESCRIPTION, STRATEGY_NAME, type AlgoStrategy } from "@/lib/algo/exclusive";
import type { AlgoConfig } from "@/lib/algo/runner";

const inr = (value: number | null | undefined) => (value == null ? "—" : `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** What each feature is doing right now, from the server's lock and its runs / session. */
export function featureStatus(data: AlgoData, strategy: AlgoStrategy) {
  const owner = data.lock.owner;
  const activity = owner === strategy ? data.lock.activity : null;
  if (owner === strategy) {
    const extra = activity?.pending ? " · order pending" : activity?.position ? " · position open" : "";
    return { label: activity?.running ? `Running${extra}` : `Stopping${extra}`, tone: "bg-profit-soft text-profit", owns: true, blocked: false };
  }
  if (owner !== "NONE") return { label: `Blocked: ${STRATEGY_NAME[owner]} is running`, tone: "bg-sunken text-muted", owns: false, blocked: true };
  const problems = strategy === "PRIMARY_STRATEGY" ? data.primaryProblems : strategy === "MATHI_5" ? data.mathi5.problems : data.problems;
  return { label: problems.length ? "Settings need attention" : "Ready (stopped)", tone: problems.length ? "bg-warning-soft text-warning" : "bg-info-soft text-info", owns: false, blocked: false };
}

/**
 * The two algo features side by side. Selecting one only changes what the panels show and what the chart
 * starts; it never starts or stops anything. While the other feature holds the execution lock, a dialog
 * says what is running (and whether it has a position or order open) and how it is safely stopped.
 */
export function StrategySelector({ data, selected, onSelect, onData }: { data: AlgoData; selected: AlgoStrategy; onSelect: (next: AlgoStrategy) => void; onData: (next: AlgoData) => void }) {
  const [confirm, setConfirm] = useState<AlgoStrategy | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /** Stops the running feature (exiting its position first when asked), then selects the other one. */
  async function stopAndSwitch(next: AlgoStrategy, exit: boolean) {
    const owner = data.lock.owner;
    if (owner === "NONE") return;
    setBusy(exit ? "exit" : "stop");
    setError("");
    try {
      const view = await api<AlgoData>("/api/algo", { action: "stopStrategy", strategy: owner, exit });
      onData(view);
      announceSaved();
      if (view.lock.owner === "NONE" || view.lock.owner === next) {
        onSelect(next);
        setConfirm(null);
      } else setError(`${STRATEGY_NAME[owner]} still holds the lock.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "It could not be stopped.");
    } finally {
      setBusy("");
    }
  }
  const owner = data.lock.owner;
  const choose = (next: AlgoStrategy) => {
    if (next === selected) return;
    if (owner !== "NONE" && owner !== next) setConfirm(next);
    else onSelect(next);
  };
  const activity = data.lock.activity;
  return (
    <div className="space-y-1.5" role="radiogroup" aria-label="Algo strategy">
      {ALGO_STRATEGIES.map((strategy) => {
        const status = featureStatus(data, strategy);
        const active = strategy === selected;
        return (
          <button key={strategy} type="button" role="radio" aria-checked={active} className={cx("w-full rounded-md border px-2.5 py-2 text-left transition-colors", active ? "border-primary bg-primary-soft/30" : "border-border-soft hover:bg-hover")} onClick={() => choose(strategy)}>
            <span className="flex items-center gap-2">
              <span className={cx("h-3 w-3 shrink-0 rounded-full border-2", active ? "border-primary bg-primary" : "border-border-strong")} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-semibold text-text">{STRATEGY_NAME[strategy]}{strategy === "PRIMARY_STRATEGY" ? " — NIFTY ORB + VWAP" : strategy === "MATHI_5" ? " — Mathi v18 with +5% target" : " — Existing Strategy"}</span>
              {status.owns ? <Lock className="h-3.5 w-3.5 shrink-0 text-profit" aria-label="Holds the execution lock" /> : null}
            </span>
            <span className="mt-0.5 block pl-5 text-micro leading-snug text-muted">{STRATEGY_DESCRIPTION[strategy]}</span>
            <span className={cx("ml-5 mt-1 inline-block rounded-pill px-2 py-0.5 text-micro font-semibold", status.tone)}>{status.label}</span>
          </button>
        );
      })}
      <p className="text-micro text-muted">Execution lock: <strong className="text-text-2">{owner === "NONE" ? "free" : STRATEGY_NAME[owner]}</strong>. Only one feature can place orders at a time; both share the Algo account.</p>
      {confirm && owner !== "NONE" ? (
        <div className="rounded-md border border-warning/40 bg-warning-soft/40 p-2 text-micro" role="alertdialog" aria-label="Switch algo strategy">
          <p className="font-semibold text-text">{STRATEGY_NAME[owner]} is running{activity?.pending ? " with a pending order" : activity?.position ? " with an open position" : ""}.</p>
          <p className="mt-1 text-text-2">To use {STRATEGY_NAME[confirm]} for the next trade, {STRATEGY_NAME[owner]} must be stopped first{activity?.position ? " — and its open position exited" : ""}. Nothing is closed without your choice here.</p>
          {activity?.pending ? <p className="mt-1 text-warning">A pending order is still being reconciled: wait for it to settle, then stop.</p> : null}
          {error ? <p className="mt-1 text-loss" role="alert">{error}</p> : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="h-7 rounded-md border border-border px-2.5 hover:bg-hover" onClick={() => { setConfirm(null); setError(""); }}>Cancel</button>
            {activity?.position ? (
              <button type="button" className="h-7 rounded-md bg-loss px-2.5 font-semibold text-white disabled:opacity-50" disabled={Boolean(busy) || Boolean(activity?.pending)} onClick={() => void stopAndSwitch(confirm, true)}>{busy === "exit" ? "Exiting…" : `Exit position, stop and switch`}</button>
            ) : (
              <button type="button" className="h-7 rounded-md bg-primary px-2.5 font-semibold text-on-primary disabled:opacity-50" disabled={Boolean(busy) || Boolean(activity?.pending)} onClick={() => void stopAndSwitch(confirm, false)}>{busy === "stop" ? "Stopping…" : `Stop ${STRATEGY_NAME[owner]} and switch`}</button>
            )}
            <button type="button" className="h-7 rounded-md border border-border px-2.5 hover:bg-hover" onClick={() => { onSelect(confirm); setConfirm(null); setError(""); }}>Only view {STRATEGY_NAME[confirm]} settings</button>
          </div>
          {activity?.position ? <p className="mt-1 text-muted">The exit fills at the current replay premium (the last processed minute), with charges, on the Algo account.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Algo - Primary Strategy: its own settings (saved separately), its status under the execution lock, its
 * current replay run and its own multi-day backtest. It runs in chart replay on the shared Algo account.
 */
export function PrimaryPanel({ data, onData }: { data: AlgoData; onData: (next: AlgoData) => void }) {
  const [draft, setDraft] = useState<AlgoConfig>(data.primaryConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedFor, setSavedFor] = useState(data.primaryConfig);
  // A save elsewhere (or the first load) replaces an untouched draft.
  if (savedFor !== data.primaryConfig && JSON.stringify(savedFor) !== JSON.stringify(data.primaryConfig)) {
    setSavedFor(data.primaryConfig);
    if (JSON.stringify(draft) === JSON.stringify(savedFor)) setDraft(data.primaryConfig);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.primaryConfig);
  const set = (patch: Partial<AlgoConfig>) => setDraft({ ...draft, ...patch });
  const primary = (patch: Partial<AlgoConfig["primary"]>) => set({ primary: { ...draft.primary, ...patch } });
  const risk = (patch: Partial<AlgoConfig["risk"]>) => set({ risk: { ...draft.risk, ...patch } });
  async function save() {
    setBusy(true);
    setError("");
    try {
      const next = await api<AlgoData>("/api/algo", { action: "save", strategy: "PRIMARY_STRATEGY", config: draft });
      onData(next);
      setDraft(next.primaryConfig);
      setSavedFor(next.primaryConfig);
      announceSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  const status = featureStatus(data, "PRIMARY_STRATEGY");
  const run = data.chart && data.chart.strategy === "PRIMARY_STRATEGY" ? data.chart : null;
  const latest = data.runs.find((item) => item.strategy === "PRIMARY_STRATEGY") ?? null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={cx("shrink-0 rounded-pill px-2 py-0.5 text-micro font-semibold", status.tone)} role="status">{status.label}</span>
        <span className="min-w-0 truncate text-micro text-muted">NIFTY 50 options · 1m · Chart replay (demo)</span>
      </div>
      {error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{error}</p> : null}
      {data.primaryProblems.length ? <p className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1.5 text-micro text-warning">{data.primaryProblems.join(" ")}</p> : null}
      <p className="text-micro leading-snug text-muted">Runs in chart replay on the shared ₹1,00,000 Algo account: open <strong>Replay</strong> on the NIFTY chart, select this strategy, switch <strong>Enable Algo</strong> on and press Play. The opening range ({draft.primary.orMinutes} min from 09:15) is analysis only; a completed candle closing beyond it, on the right side of VWAP and with the trend, is the signal.</p>
      {run || latest ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2">
          <Info label="Replay session" text={(run ?? latest)!.date} />
          <Info label="Status" text={run ? (run.armed ? "Armed" : run.status === "ENDED" ? "Ended" : "Entries off") : latest!.status === "ENDED" ? "Ended" : "Active"} />
          <Info label="Trades (W/L)" text={`${(run ?? latest)!.stats.trades} (${(run ?? latest)!.stats.wins}/${(run ?? latest)!.stats.losses})`} />
          <Info label="Session P&L" text={inr((run ?? latest)!.stats.realized)} tone={(run ?? latest)!.stats.realized > 0 ? "text-profit" : (run ?? latest)!.stats.realized < 0 ? "text-loss" : undefined} />
        </dl>
      ) : null}

      <details className="rounded-md border border-border-soft" open>
        <summary className="cursor-pointer px-2 py-1.5 font-medium text-text-2">Primary Strategy settings</summary>
        <div className="space-y-1.5 border-t border-border-soft p-2">
          <p className="eyebrow">Opening range and confirmation</p>
          <Field label="Opening range (min from 09:15)"><NumberInput value={draft.primary.orMinutes} step={5} min={5} onChange={(orMinutes) => primary({ orMinutes })} /></Field>
          <Field label="Breakout buffer (%)"><NumberInput value={draft.primary.breakBufferPercent} step={0.01} min={0} onChange={(breakBufferPercent) => primary({ breakBufferPercent })} /></Field>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Price on the VWAP side</span><input type="checkbox" className="oc-check" aria-label="VWAP filter" checked={draft.primary.vwap} onChange={(event) => primary({ vwap: event.target.checked })} /></label>
          <Field label="Without index volume">
            <select className="compact-field w-[9.5rem]" aria-label="VWAP fallback" value={draft.primary.vwapFallback} onChange={(event) => primary({ vwapFallback: event.target.value === "reject" ? "reject" : "twap" })}>
              <option value="twap">Use TWAP (labelled)</option>
              <option value="reject">No trade</option>
            </select>
          </Field>
          <p className="text-micro text-muted">VWAP needs volume; NIFTY index candles usually have none. TWAP (the time-weighted average price) is then used and labelled as such, or the setup is refused.</p>
          <Field label="Trend filter">
            <select className="compact-field w-[9.5rem]" aria-label="Trend filter" value={draft.primary.trend} onChange={(event) => primary({ trend: event.target.value === "none" ? "none" : "ema" })}>
              <option value="ema">Fast / slow EMA</option>
              <option value="none">Off</option>
            </select>
          </Field>
          {draft.primary.trend === "ema" ? (
            <>
              <Field label="Fast EMA"><NumberInput value={draft.primary.trendFast} step={1} min={2} onChange={(trendFast) => primary({ trendFast })} /></Field>
              <Field label="Slow EMA"><NumberInput value={draft.primary.trendSlow} step={1} min={3} onChange={(trendSlow) => primary({ trendSlow })} /></Field>
            </>
          ) : null}
          <Field label="Confirmation window (candles)"><NumberInput value={draft.primary.confirmBars} step={1} min={0} onChange={(confirmBars) => primary({ confirmBars })} /></Field>
          <p className="text-micro text-muted">A break of the range waits this long for VWAP and the trend to agree (price must stay beyond the range); it enters once, on the first candle where they do.</p>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Pullback continuation (EMA re-cross)</span><input type="checkbox" className="oc-check" aria-label="Continuation entries" checked={draft.primary.continuation} onChange={(event) => primary({ continuation: event.target.checked })} /></label>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Support breakdown PUT (above the range low)</span><input type="checkbox" className="oc-check" aria-label="Support breakdown entries" checked={draft.primary.supportBreak} onChange={(event) => primary({ supportBreak: event.target.checked })} /></label>
          {draft.primary.supportBreak ? <p className="text-micro text-warning">Labelled SUPPORT BREAKDOWN, never an opening-range breakdown. It fires more often (each broken swing low), so more false signals.</p> : null}
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Also enter on a retest and reclaim</span><input type="checkbox" className="oc-check" aria-label="Retest confirmation" checked={draft.primary.retest} onChange={(event) => primary({ retest: event.target.checked })} /></label>
          {draft.primary.retest ? <Field label="Retest window (candles)"><NumberInput value={draft.primary.retestBars} step={1} min={1} onChange={(retestBars) => primary({ retestBars })} /></Field> : null}
          <Field label="Stop beyond">
            <select className="compact-field w-[9.5rem]" aria-label="Stop basis" value={draft.primary.stopBasis} onChange={(event) => primary({ stopBasis: event.target.value === "mid" ? "mid" : event.target.value === "range" ? "range" : "candle" })}>
              <option value="candle">Signal candle</option>
              <option value="mid">Range midpoint</option>
              <option value="range">Opposite range edge</option>
            </select>
          </Field>

          <p className="eyebrow pt-2">Capital and sizing</p>
          <Field label="Capital Allocation (%)"><NumberInput value={draft.allocation.percent} step={5} min={1} onChange={(percent) => set({ allocation: { ...draft.allocation, percent } })} /></Field>
          <Field label="Maximum Capital (₹)"><NumberInput value={draft.allocation.maxCapital} step={10_000} min={1_000} onChange={(maxCapital) => set({ allocation: { ...draft.allocation, maxCapital } })} /></Field>
          <Field label="If unaffordable">
            <select className="compact-field w-[9.5rem]" aria-label="Unaffordable order policy" value={draft.allocation.policy} onChange={(event) => set({ allocation: { ...draft.allocation, policy: event.target.value === "reject" ? "reject" : "reduce" } })}>
              <option value="reduce">Buy affordable lots</option>
              <option value="reject">Skip the trade</option>
            </select>
          </Field>
          <p className="text-micro text-muted">Each trade buys the most whole lots whose premium and entry charges fit {Number.isFinite(draft.allocation.percent) ? draft.allocation.percent : "—"}% of ₹{Number.isFinite(draft.allocation.maxCapital) ? draft.allocation.maxCapital.toLocaleString("en-IN") : "—"} and the cash actually available on the Algo account (rounded down; never a part lot). If less is available, it {draft.allocation.policy === "reject" ? "skips the trade" : "buys what is affordable"} and says why.</p>
          <Field label="Target (% of premium)"><NumberInput value={draft.target.value} step={0.5} min={0.5} onChange={(value) => set({ target: { mode: "percent", value } })} /></Field>
          <Field label="Stop-loss (% of premium)"><NumberInput value={draft.stop.value} step={0.5} min={0.5} onChange={(value) => set({ stop: { mode: "percent", value } })} /></Field>
          <p className="text-micro text-muted">The target and stop are measured on the <strong>option premium</strong> from the executed entry price: +{draft.target.value}% on a ₹100 premium is ₹{Number.isFinite(draft.target.value) ? (100 * (1 + draft.target.value / 100)).toFixed(2) : "—"}. On the account that is about {Number.isFinite(draft.target.value * draft.allocation.percent) ? Math.round(draft.target.value * draft.allocation.percent) / 100 : "—"}% of the capital before charges, only when {draft.allocation.percent}% is committed; charges reduce it.</p>

          <p className="eyebrow pt-2">Window, risk and exits</p>
          <Field label="No new entries after"><input type="time" className="compact-field w-[9.5rem]" aria-label="Primary entry cutoff" value={draft.entryCutoff} min="09:30" max="15:29" onChange={(event) => set({ entryCutoff: event.target.value || "12:00" })} /></Field>
          <Field label="Max trades / session"><NumberInput value={draft.maxTrades} step={1} min={1} onChange={(maxTrades) => set({ maxTrades })} /></Field>
          <Field label="Max lots per trade"><NumberInput value={draft.lots} step={1} min={1} onChange={(lots) => set({ lots })} /></Field>
          <Field label="Max session loss (₹)"><NumberInput value={draft.maxDailyLoss} step={500} min={1} onChange={(maxDailyLoss) => set({ maxDailyLoss })} /></Field>
          <Field label="Daily profit target (₹)"><NumberInput value={draft.risk.dailyTarget} step={500} min={1} onChange={(dailyTarget) => risk({ dailyTarget })} /></Field>
          <Field label="Paper slippage (ticks)"><NumberInput value={draft.slippageTicks} step={1} min={0} onChange={(slippageTicks) => set({ slippageTicks })} /></Field>
          <p className="text-micro text-muted">Charges and slippage are included in every fill and in the P&amp;L. A stop is never widened. Demo / replay only: no broker order is ever sent.</p>
          {dirty ? (
            <div className="flex gap-1.5 pt-1">
              <button type="button" className="h-8 flex-1 rounded-md bg-primary font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save Primary settings"}</button>
              <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => setDraft(data.primaryConfig)}>Undo</button>
            </div>
          ) : null}
        </div>
      </details>

      <MultiDayBacktest strategy="PRIMARY_STRATEGY" disabled={dirty ? "Save the Primary settings first: the backtest uses the saved settings." : data.primaryProblems.length ? data.primaryProblems.join(" ") : null} />
    </div>
  );
}
