"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/api";
import { useDesk } from "@/components/shell";
import { Confirm, Info, type AlgoData } from "@/components/algo/algo-panel";
import { MultiDayBacktest } from "@/components/algo/algo-backtest";
import { EngineCard, MathiStatus } from "@/components/algo/algo-engine";
import { LiveMathiSession } from "@/components/algo/algo-live-session";
import { mathi5Ticker } from "@/components/algo/algo-start-button";
import { STRATEGY_NAME } from "@/lib/algo/exclusive";

/**
 * Mathi 5%: a separate copy of Mathi Strategy v18 with a +5% target. Live mode runs it as live paper trading (its own
 * session, state and trades); Demo mode runs it on the chart replay. Every entry and exit is decided by the server.
 */
export function Mathi5Panel({ data, onData }: { data: AlgoData; onData: (next: AlgoData) => void }) {
  const m5 = data.mathi5;
  const config = m5.config;
  const desk = useDesk();
  const live = desk.mode === "live";
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    mathi5Ticker.mounted += 1;
    return () => { mathi5Ticker.mounted -= 1; };
  }, []);

  const send = useCallback(async (label: string, op: "start" | "stop" | "exit") => {
    setBusy(label);
    setError("");
    try {
      onData(await api<AlgoData>("/api/algo", { action: "mathi5", op }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy("");
    }
  }, [onData]);

  // While a session runs (or a trade is open) the server checks new candles every 15 seconds.
  const active = Boolean(m5.state.running || m5.state.position || m5.state.pending);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setCheckedAt(Math.floor(Date.now() / 1000));
      api<AlgoData>("/api/algo", { action: "mathi5", op: "tick" }).then(onData).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, onData]);

  // The live monitor shows Mathi 5%'s own session, state and position (never Mathi Strategy's).
  const view: AlgoData = { ...data, config, state: m5.state, position: m5.position, liveSession: m5.liveSession, problems: m5.problems };
  const state = m5.state;
  const hold = config.exitManagement?.mode === "trend" ? `exit at ${config.maxHoldMinutes} min unless the trend agrees (at most ${config.exitManagement.maxHoldMinutes} min)` : `exit after ${config.maxHoldMinutes} min`;

  return (
    <div className="space-y-3">
      {error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{error}</p> : null}
      {m5.problems.length ? <p className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1.5 text-micro text-warning" role="alert">{m5.problems.join(" ")}</p> : null}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2">
        <div className="col-span-2"><p className="eyebrow">{STRATEGY_NAME.MATHI_5} — rules</p></div>
        <Info label="Target" text={`+${config.target.value}% of the option premium`} tone="text-profit" />
        <Info label="Stop-loss" text={config.stopLoss === false ? "None" : `${config.stop.value}%`} />
        <Info label="Trades" text={`${config.maxTrades} per session`} />
        <Info label="Confirmation" text={config.confirmation?.mode === "retest" ? "Retest" : config.confirmation?.mode ?? "Single"} />
        <div className="col-span-2 min-w-0"><Info label="Time exit" text={hold} /></div>
        <p className="col-span-2 text-micro leading-snug text-muted">Same lines, entries, regime switch and exits as Mathi Strategy v18; only the target differs. Paper trading only — no real orders.</p>
      </dl>

      {live ? (
        <>
          <LiveMathiSession title={STRATEGY_NAME.MATHI_5} data={view} busy={Boolean(busy)} disabled={m5.problems.length > 0} now={checkedAt} onStart={() => void send("start", "start")} onStop={() => void send("stop", "stop")} />
          {m5.position ? <div className="flex flex-wrap gap-1.5"><Confirm label="Exit position" confirm="Confirm exit" disabled={Boolean(busy) || Boolean(m5.position.exit)} onConfirm={() => void send("exit", "exit")} /></div> : null}
          {state.running || state.analysis ? (
            <>
              <MathiStatus state={state} config={config} mode="Live-price paper trading" now={checkedAt ?? state.analysis?.asOf ?? null} />
              <EngineCard state={state} config={config} date={state.sessionDate} now={checkedAt ?? state.analysis?.asOf ?? null} unrealized={m5.position?.unrealized ?? null} />
            </>
          ) : null}
          <p className="text-micro leading-snug text-muted">{data.monitoring}</p>
        </>
      ) : (
        <p className="rounded-md border border-border-soft bg-sunken/50 p-2 text-micro text-muted">Demo mode: start {STRATEGY_NAME.MATHI_5} from the chart replay&apos;s Start Algo while it is selected here. It trades the replay on the demo wallet with these rules.</p>
      )}

      <MultiDayBacktest strategy="MATHI_5" disabled={m5.problems.length ? m5.problems.join(" ") : null} />
    </div>
  );
}
