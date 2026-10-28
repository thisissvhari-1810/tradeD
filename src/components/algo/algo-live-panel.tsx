"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, ChevronDown, OctagonX } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { AlgoAccountFigures } from "@/components/algo/algo-account";
import { ConfirmationList, MarketAnalysisSection, StrategyRows, waitingMessage } from "@/components/algo/algo-analysis";
import { EngineCard, MarketPlanSection, MathiStatus } from "@/components/algo/algo-engine";
import { LIVE_TONE, LiveMathiSession, liveRunning } from "@/components/algo/algo-live-session";
import { Confirm, type AlgoData } from "@/components/algo/algo-panel";
import { ALGO_VIEW_EVENT, algoLivePanel, broadcastAlgoView } from "@/components/algo/algo-start-button";
import { useSelectedStrategy } from "@/components/algo/algo-settings-sync";
import { variantData } from "@/components/algo/algo-variant";
import { LiveMoney, rupeesOf } from "@/components/algo/live-value";
import { isVariantStrategy, STRATEGY_NAME } from "@/lib/algo/exclusive";
import { LIVE_STATUS_LABEL } from "@/lib/algo/live-session";

const clock = (seconds: number | null | undefined) => (seconds ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(seconds * 1000)) : "—");
const istDate = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(0, 10);

/**
 * The live paper-trading dashboard beside the live chart (the counterpart of the replay's Algo panel): the account,
 * the current session's signal, open trade and completed trades, and the market analysis. It shows the strategy
 * selected in the Strategy panel, while its session runs or a trade is open, and today's last session after it
 * stops. Every figure is the server's; the 15-second check runs from the Algo panel or the chart's Start button.
 */
export function AlgoLivePanel() {
  const [data, setData] = useState<AlgoData | null>(null);
  // When the latest view arrived (for the holding time); set on arrival, never read from the clock while rendering.
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Phones start with the panel folded to its header (the chart keeps the screen); desktops show it open.
  const [open, setOpen] = useState(() => typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches);
  const [selected] = useSelectedStrategy();
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const apply = useCallback((next: AlgoData, broadcast = true) => {
    if (!mounted.current) return;
    setData(next);
    setNow(Math.floor(Date.now() / 1000));
    if (broadcast) broadcastAlgoView(next);
  }, []);

  useEffect(() => {
    algoLivePanel.mounted += 1;
    api<AlgoData>("/api/algo").then((next) => apply(next)).catch(() => undefined);
    const onView = (event: Event) => apply((event as CustomEvent<AlgoData>).detail, false);
    window.addEventListener(ALGO_VIEW_EVENT, onView);
    return () => {
      algoLivePanel.mounted -= 1;
      window.removeEventListener(ALGO_VIEW_EVENT, onView);
    };
  }, [apply]);

  const variant = isVariantStrategy(selected) ? selected : null;
  const own = data && variant ? variantData(data, variant) : null;
  // The selected strategy's own session, state and position (a variant never shows Mathi Strategy's).
  const view: AlgoData | null = data && own ? { ...data, config: own.config, state: own.state, position: own.position, liveSession: own.liveSession, problems: own.problems } : data;

  // While a trade is open its latest premium and P&L are read every 5 seconds (orders and exits are decided by the
  // 15-second server check).
  const holding = Boolean(view?.position);
  useEffect(() => {
    if (!holding) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) api<AlgoData>("/api/algo").then((next) => apply(next)).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [holding, apply]);

  const send = async (label: string, body: unknown) => {
    setBusy(label);
    setError("");
    try {
      apply(await api<AlgoData>("/api/algo", body));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy("");
    }
  };

  // Live paper only (the execution mode follows the app mode, as the chart's Start button does).
  if (!data || !view || data.config.mode !== "PAPER") return null;
  const { state, liveSession, position } = view;
  const activation = liveSession.activation;
  const running = liveRunning(view);
  // Shown while the session runs or a trade is open, and for today's last session once it has stopped.
  const today = now != null && activation != null && istDate(activation.startedAt) === istDate(now);
  if (!running && !position && !state.pending && !today) return null;

  const name = variant ? STRATEGY_NAME[variant] : "Mathi";
  const account = view.account;
  const netPnl = rupeesOf(account.netPnl);
  const equity = rupeesOf(account.equity);
  const max = liveSession.summary.max;
  const analysisTime = state.analysis?.asOf ?? null;

  return (
    <aside className="flex min-h-0 shrink-0 flex-col border-border bg-panel text-[0.8125rem] max-lg:max-h-[50dvh] max-lg:border-t lg:w-[23rem] lg:border-l xl:w-[26rem]" aria-label="Algo live trading">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Bot className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-base font-semibold">Algo</h2>
        <span className="min-w-0 truncate text-xs font-medium text-text-2" title={variant ? STRATEGY_NAME[variant] : "Mathi Strategy"}>{name}</span>
        <span className={cx("whitespace-nowrap rounded-pill px-2 py-0.5 text-xs font-semibold", LIVE_TONE[liveSession.status])} role="status">{LIVE_STATUS_LABEL[liveSession.status]}</span>
        <span className={cx("rounded-pill bg-demo-soft px-2 py-0.5 text-xs font-medium text-demo", position && !open && "max-lg:hidden")}>Paper</span>
        {position && !open ? <LiveMoney value={position.unrealized} signed tone className="font-semibold lg:hidden" /> : null}
        <span className="num ml-auto hidden text-xs text-muted sm:inline" title="Last completed candle">{clock(state.lastCandle)} IST</span>
        <button type="button" aria-label={open ? "Collapse algo panel" : "Expand algo panel"} aria-expanded={open} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text max-sm:ml-auto lg:hidden" onClick={() => setOpen((value) => !value)}><ChevronDown className={cx("h-4 w-4 transition-transform", !open && "-rotate-90")} aria-hidden /></button>
      </header>

      <div className={cx("min-h-0 flex-1 space-y-3 overflow-y-auto p-3", !open && "max-lg:hidden")}>
        {error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-xs text-loss" role="alert">{error} <button type="button" className="ml-1 underline" onClick={() => setError("")}>Dismiss</button></p> : null}
        {state.recovery ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-xs text-loss" role="alert">{state.recovery}</p> : null}
        {state.riskLocked ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-xs text-loss">Daily loss limit reached: new entries are blocked for today.</p> : null}

        {/* 1. This session's account */}
        <section className="rounded-xl border border-border bg-gradient-to-br from-elevated to-panel p-3 shadow-e1" aria-label="Algo account overview">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Session P&amp;L</span>
            <span className="num rounded-pill bg-sunken px-2 py-0.5 text-xs text-text-2" title="Entries taken this session, out of the maximum per session">Entries {liveSession.summary.entriesUsed} of {max} max</span>
          </div>
          <p className="mt-1 text-[2rem] font-semibold leading-tight"><LiveMoney value={netPnl} signed tone missing="—" /></p>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted">Equity</span>
            <span className="text-xl font-semibold"><LiveMoney value={equity} missing="—" /></span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border-soft pt-2">
            <Metric label="Initial capital">{activation?.capital != null ? <LiveMoney value={activation.capital} /> : account.startingCapital}</Metric>
            <Metric label="Available cash"><LiveMoney value={rupeesOf(account.cashAvailable)} /></Metric>
            <Metric label="Open-position value"><LiveMoney value={rupeesOf(account.holdingsValue)} /></Metric>
            <Metric label="Unrealized P&L"><LiveMoney value={rupeesOf(account.unrealized)} signed tone /></Metric>
            <Metric label="Realized P&L"><LiveMoney value={rupeesOf(account.realized)} signed tone /></Metric>
            <Metric label="Reserved funds"><LiveMoney value={rupeesOf(account.cashReserved)} /></Metric>
          </dl>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted hover:text-text">Account breakdown</summary>
            <div className="mt-2"><AlgoAccountFigures account={account} compact /></div>
            <p className="mt-1 text-muted">Each Start Algo opens a fresh ₹1,00,000 virtual ledger. Equity = available cash + reserved funds + open-position value; P&amp;L is after charges.</p>
          </details>
        </section>

        {/* 2. The session: notices, summary, the open trade and its completed trades */}
        <LiveMathiSession data={view} now={now} />
        {position ? (
          <div className="rounded-md border border-border-soft p-2">
            <p className="eyebrow mb-1">Intratrade confirmations</p>
            <ConfirmationList confirmations={state.confirmations ?? null} />
          </div>
        ) : null}
        {running || position ? (
          <div className="flex flex-wrap gap-2">
            {position ? <Confirm label="Exit position" confirm="Confirm exit" disabled={Boolean(busy) || Boolean(position.exit)} onConfirm={() => void send("exit", variant ? { action: "variant", strategy: variant, op: "exit" } : { action: "exit" })} /> : null}
            {!variant ? <Confirm label={<><OctagonX className="h-3.5 w-3.5" aria-hidden />Emergency stop</>} confirm="Confirm emergency stop" danger disabled={Boolean(busy)} onConfirm={() => void send("emergency", { action: "emergency" })} /> : null}
          </div>
        ) : null}

        {/* 3. This session's latest signal and order (a new session starts with none) */}
        <dl className="grid gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2">
          <div className="min-w-0">
            <dt className="text-micro text-muted">Last signal</dt>
            <dd className="text-data leading-snug text-text-2">{state.lastSignal ? `${clock(state.lastSignal.time)} · ${state.lastSignal.explanation}` : "None yet in this session"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-micro text-muted">Last order</dt>
            <dd className="text-data leading-snug text-text-2">{state.lastOrder ? state.lastOrder.message : "None yet in this session"}</dd>
          </div>
        </dl>

        {/* 4. The engine and the market, as the replay dashboard shows them */}
        {state.running || state.analysis ? (
          <>
            <MathiStatus state={state} config={view.config} mode="Live-price paper trading" now={now ?? analysisTime} />
            <EngineCard state={state} config={view.config} date={state.sessionDate} now={now ?? analysisTime} unrealized={position?.unrealized ?? null} />
            <MarketAnalysisSection analysis={state.analysis} symbol={view.config.underlying} time={analysisTime} />
            <StrategyRows analysis={state.analysis} positionOpen={Boolean(position)} />
            {!position && running ? <p className="text-micro font-semibold text-text-2" role="status">{waitingMessage(state.analysis, state.tradesToday, view.config.maxTrades)}</p> : null}
          </>
        ) : null}
        {!variant ? <MarketPlanSection date={state.sessionDate} /> : null}

        <p className="text-xs leading-snug text-muted">{view.monitoring}</p>
      </div>
    </aside>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate text-[0.9375rem] font-medium">{children}</dd>
    </div>
  );
}
