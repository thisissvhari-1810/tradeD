"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/api";
import { useDesk } from "@/components/shell";
import { Confirm, type AlgoData } from "@/components/algo/algo-panel";
import { MultiDayBacktest } from "@/components/algo/algo-backtest";
import { LiveSessionSwitch } from "@/components/algo/algo-live-session";
import { HourlyRules } from "@/components/algo/algo-hourly";
import { variantData, variantTicker } from "@/components/algo/algo-start-button";
import { STRATEGY_NAME, type VariantStrategy } from "@/lib/algo/exclusive";

export { variantData };

/**
 * Mathi Hourly Zone Strategy: its own settings, sessions and trades. Live mode runs it as live paper
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

  return (
    <div className="space-y-3">
      {error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{error}</p> : null}
      {own.problems.length ? <p className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1.5 text-micro text-warning" role="alert">{own.problems.join(" ")}</p> : null}

      <HourlyRules data={data} onData={onData} />

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
