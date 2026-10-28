"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/api";
import { useDesk } from "@/components/shell";
import { Confirm, Info, type AlgoData } from "@/components/algo/algo-panel";
import { MultiDayBacktest } from "@/components/algo/algo-backtest";
import { LiveSessionSwitch } from "@/components/algo/algo-live-session";
import { variantTicker } from "@/components/algo/algo-start-button";
import { STRATEGY_NAME, type VariantStrategy } from "@/lib/algo/exclusive";

/** A variant strategy's own view (settings, state, position, live session) from the Algo data. */
export const variantData = (data: AlgoData, strategy: VariantStrategy) => (strategy === "MATHI_BANK" ? data.mathiBank : data.mathi5);

const SUMMARY: Record<VariantStrategy, string> = {
  MATHI_5: "Same lines, entries, regime switch and exits as Mathi Strategy v18; only the target differs.",
  MATHI_BANK: "Mathi Strategy (+3% version) on BANKNIFTY: the same lines, 50% body break, retest and exits, on the ATM CE / PE of the nearest monthly BANKNIFTY expiry (BANKNIFTY has no weekly options). Its own settings, trades and results; Mathi Strategy is unchanged.",
};

/**
 * Mathi 5% and Mathi Bank Strategy: Mathi Strategy's engine with their own settings. Live mode runs one as live paper
 * trading (its own session, state and trades); Demo mode runs it on the chart replay. Every entry and exit is decided by
 * the server.
 */
export function VariantPanel({ data, onData, strategy }: { data: AlgoData; onData: (next: AlgoData) => void; strategy: VariantStrategy }) {
  const own = variantData(data, strategy);
  const config = own.config;
  const name = STRATEGY_NAME[strategy];
  const desk = useDesk();
  const live = desk.mode === "live";
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    variantTicker[strategy].mounted += 1;
    return () => { variantTicker[strategy].mounted -= 1; };
  }, [strategy]);

  const send = useCallback(async (label: string, op: "start" | "stop" | "exit") => {
    setBusy(label);
    setError("");
    try {
      onData(await api<AlgoData>("/api/algo", { action: "variant", strategy, op }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy("");
    }
  }, [onData, strategy]);

  // While a session runs (or a trade is open) the page also asks for a check every 15 seconds (the server's scheduler is the main monitor).
  const active = Boolean(own.state.running || own.state.position || own.state.pending);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      api<AlgoData>("/api/algo", { action: "variant", strategy, op: "tick" }).then(onData).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, onData, strategy]);

  // The switch shows this strategy's own session, state and position (never Mathi Strategy's).
  const view: AlgoData = { ...data, config, state: own.state, position: own.position, liveSession: own.liveSession, problems: own.problems };
  const hold = config.exitManagement?.mode === "trend" ? `exit at ${config.maxHoldMinutes} min unless the trend agrees (at most ${config.exitManagement.maxHoldMinutes} min)` : config.maxHoldMinutes > 0 ? `exit after ${config.maxHoldMinutes} min` : "none";

  return (
    <div className="space-y-3">
      {error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{error}</p> : null}
      {own.problems.length ? <p className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1.5 text-micro text-warning" role="alert">{own.problems.join(" ")}</p> : null}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2">
        <div className="col-span-2"><p className="eyebrow">{name} — rules</p></div>
        <Info label="Instrument" text={`${config.underlying} ATM CE / PE · ${strategy === "MATHI_BANK" ? "monthly expiry" : "nearest expiry"}`} />
        <Info label="Target" text={`+${config.target.value}% of the option premium`} tone="text-profit" />
        <Info label="Stop-loss" text={config.stopLoss === false ? "None" : `${config.stop.value}%`} />
        <Info label="Trades" text={`${config.maxTrades} per session`} />
        <Info label="Confirmation" text={config.confirmation?.mode === "retest" ? "Retest" : config.confirmation?.mode ?? "Single"} />
        <Info label="Square-off" text={config.squareOff ? `${config.squareOff} IST` : "Session close"} />
        <div className="col-span-2 min-w-0"><Info label="Time exit" text={hold} /></div>
        <p className="col-span-2 text-micro leading-snug text-muted">{SUMMARY[strategy]} Paper trading only — no real orders.</p>
      </dl>

      {live ? (
        <>
          <LiveSessionSwitch title={name} data={view} busy={Boolean(busy)} disabled={own.problems.length > 0} onStart={() => void send("start", "start")} onStop={() => void send("stop", "stop")} />
          {own.position ? <div className="flex flex-wrap gap-1.5"><Confirm label="Exit position" confirm="Confirm exit" disabled={Boolean(busy) || Boolean(own.position.exit)} onConfirm={() => void send("exit", "exit")} /></div> : null}
          <p className="text-micro leading-snug text-muted">{data.monitoring}</p>
        </>
      ) : (
        <p className="rounded-md border border-border-soft bg-sunken/50 p-2 text-micro text-muted">Demo mode: start {name} from the chart replay&apos;s Start Algo while it is selected here. It trades the replay of {config.underlying} on the demo wallet with these rules.</p>
      )}

      <MultiDayBacktest strategy={strategy} disabled={own.problems.length ? own.problems.join(" ") : null} />
    </div>
  );
}
