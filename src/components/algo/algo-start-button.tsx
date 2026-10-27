"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import type { AlgoData } from "@/components/algo/algo-panel";
import { useSelectedStrategy } from "@/components/algo/algo-settings-sync";

/** Every fresh algo view is broadcast, so the chart button and the Algo panel always show the same session. */
export const ALGO_VIEW_EVENT = "tradeD:algo-view";
export const broadcastAlgoView = (data: AlgoData) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<AlgoData>(ALGO_VIEW_EVENT, { detail: data }));
};

/** Algo panels on screen: while one is mounted it runs the 15-second server check, so the button does not repeat it. */
export const algoPanelTicker = { mounted: 0 };
/** Mathi 5% panels on screen: while one is mounted it runs Mathi 5%'s live check, so the button does not repeat it. */
export const mathi5Ticker = { mounted: 0 };

/**
 * Start Algo / Stop Algo on the live chart (paper trading only). Each Start begins a new session with its own
 * ₹1,00,000 virtual ledger and 0 / 3 completed trades; the server decides every entry and exit, this only sends
 * start / stop and keeps the 15-second server check running while the session is on.
 */
export function AlgoStartButton({ allowed, onUpgrade }: { allowed: boolean; onUpgrade: () => void }) {
  const [data, setData] = useState<AlgoData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const apply = useCallback((next: AlgoData) => {
    if (!mounted.current) return;
    setData(next);
    broadcastAlgoView(next);
  }, []);

  useEffect(() => {
    if (!allowed) return;
    api<AlgoData>("/api/algo").then(apply).catch(() => undefined);
    const onView = (event: Event) => { if (mounted.current) setData((event as CustomEvent<AlgoData>).detail); };
    window.addEventListener(ALGO_VIEW_EVENT, onView);
    return () => window.removeEventListener(ALGO_VIEW_EVENT, onView);
  }, [allowed, apply]);

  // Mathi Strategy's live check runs from here while no Algo panel is open.
  const mathiActive = Boolean(data?.state.running || data?.state.position || data?.state.pending);
  useEffect(() => {
    if (!mathiActive) return;
    const timer = window.setInterval(() => {
      if (!document.hidden && algoPanelTicker.mounted === 0) api<AlgoData>("/api/algo", { action: "tick" }).then(apply).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [mathiActive, apply]);

  // Mathi 5%'s live check also runs from here while no Mathi 5% panel is open.
  const m5Active = Boolean(data?.mathi5.state.running || data?.mathi5.state.position || data?.mathi5.state.pending);
  useEffect(() => {
    if (!m5Active) return;
    const timer = window.setInterval(() => {
      if (!document.hidden && mathi5Ticker.mounted === 0) api<AlgoData>("/api/algo", { action: "mathi5", op: "tick" }).then(apply).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [m5Active, apply]);

  // The button starts and stops the strategy selected in the Algo panel (Mathi Strategy or Mathi 5%).
  const [selected] = useSelectedStrategy();
  const m5 = selected === "MATHI_5";
  const view = m5 ? data?.mathi5 : data;
  const name = m5 ? "Mathi 5%" : "Algo";
  const activation = view?.liveSession.activation ?? null;
  const running = Boolean(view?.state.running && activation && activation.endedAt == null);

  if (data && data.config.mode !== "PAPER") return null;
  const summary = view?.liveSession.summary;
  const completedAll = activation?.end === "LIMIT";
  const label = running ? `Stop ${name}` : `Start ${name}`;
  const status = running ? "Running" : completedAll ? "Completed" : "Stopped";

  const toggle = async () => {
    if (!allowed) return onUpgrade();
    setBusy(true);
    setError("");
    try {
      const body = m5 ? { action: "mathi5", op: running ? "stop" : "start" } : { action: running ? "stop" : "start" };
      // A click that lands during the server's candle check is retried once.
      const next = await api<AlgoData>("/api/algo", body).catch(async (caught: unknown) => {
        if (!(caught instanceof Error && /busy/i.test(caught.message))) throw caught;
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        return api<AlgoData>("/api/algo", body);
      });
      apply(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The algo could not be switched.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        aria-pressed={running}
        aria-label="Start or stop the algo"
        title={error || (running ? `${name} running · session ${activation?.id} · ${summary?.completed ?? 0} / ${summary?.max ?? 3} trades completed` : `Start a new ${m5 ? "Mathi 5% " : ""}paper-trading algo session (fresh ₹1,00,000, up to 3 trades)`)}
        disabled={busy || !data}
        className={cx("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-input px-2.5 text-data font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-60", running ? "bg-loss text-on-signal hover:brightness-110" : "bg-profit text-on-signal hover:brightness-110")}
        onClick={() => void toggle()}
      >
        {running ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
        {busy ? "…" : label}
      </button>
      {data && activation ? (
        <span className="num hidden whitespace-nowrap rounded-full bg-sunken px-2 py-1 text-micro font-medium text-text-2 sm:inline" role="status" title={`Session ${activation.id}`}>
          {status} · {summary?.completed ?? 0}/{summary?.max ?? 3}
        </span>
      ) : null}
      {error ? <span className="max-w-[14rem] truncate text-micro text-loss" role="alert" title={error}>{error}</span> : null}
    </span>
  );
}
