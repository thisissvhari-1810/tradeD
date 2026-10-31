"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import type { AlgoData } from "@/components/algo/algo-panel";
import { announceSaved } from "@/components/algo/algo-settings-sync";
import { ALGO_STRATEGIES, STRATEGY_DESCRIPTION, STRATEGY_NAME, STRATEGY_TAGLINE, type AlgoStrategy } from "@/lib/algo/exclusive";

/** What each feature is doing right now, from the server's lock and its runs / session. */
export function featureStatus(data: AlgoData, strategy: AlgoStrategy) {
  const owner = data.lock.owner;
  const activity = owner === strategy ? data.lock.activity : null;
  if (owner === strategy) {
    const extra = activity?.pending ? " · order pending" : activity?.position ? " · position open" : "";
    return { label: activity?.running ? `Running${extra}` : `Stopping${extra}`, tone: "bg-profit-soft text-profit", owns: true, blocked: false };
  }
  if (owner !== "NONE") return { label: `Blocked: ${STRATEGY_NAME[owner]} is running`, tone: "bg-sunken text-muted", owns: false, blocked: true };
  const problems = strategy === "MATHI_HOURLY" ? data.mathiHourly.problems : data.problems;
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
              <span className="min-w-0 flex-1 truncate font-semibold text-text">{STRATEGY_NAME[strategy]} — {STRATEGY_TAGLINE[strategy]}</span>
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
