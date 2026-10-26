"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Ban, Bot, ChevronDown, CircleDot, Download, History, LogIn, LogOut, OctagonX, Play, Radio, RotateCcw, ShieldCheck, Zap } from "lucide-react";
import { downloadAlgoReport } from "@/components/algo/algo-report";
import { cx } from "@/components/ui";
import { activityFeed, algoTrades, runDiagnostics, skippedSignals, tradeSlots, type ActivityItem, type AlgoTrade, type SlotState } from "@/lib/algo/chart-replay";
import { confirmationMode, type AlgoStatus } from "@/lib/algo/runner";
import type { ChartAlgo } from "@/components/algo/use-chart-algo";
import { AlgoAccountFigures } from "@/components/algo/algo-account";
import { LiveMoney, money, rupeesOf, toneOf } from "@/components/algo/live-value";
import { ConfirmationList, MarketAnalysisSection, StrategyRows, waitingMessage } from "@/components/algo/algo-analysis";
import { STRATEGY_LABEL } from "@/lib/algo/patterns";
import { EngineCard, MarketPlanSection, MathiStatus } from "@/components/algo/algo-engine";
import { useSelectedStrategy, useUnsavedSettings } from "@/components/algo/algo-settings-sync";
import { blockedMessage, STRATEGY_NAME } from "@/lib/algo/exclusive";
import type { Confirmation } from "@/lib/algo/confirmations";

const inr = (value: number | null | undefined, signed = false) => (value == null || !Number.isFinite(value) ? "—" : money(value, signed));
const ist = (seconds: number | null | undefined) => (seconds ? new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16) : "—");
const tone = toneOf;

const BADGE: Partial<Record<AlgoStatus, { label: string; tone: string }>> = {
  DISABLED: { label: "Off", tone: "bg-sunken text-muted" },
  READY: { label: "Entries off", tone: "bg-info-soft text-info" },
  MONITORING: { label: "Monitoring", tone: "bg-primary-soft text-primary" },
  SIGNAL_DETECTED: { label: "Signal", tone: "bg-warning-soft text-warning" },
  ORDER_PENDING: { label: "Order pending", tone: "bg-warning-soft text-warning" },
  POSITION_OPEN: { label: "Position open", tone: "bg-profit-soft text-profit" },
  EXIT_PENDING: { label: "Exit pending", tone: "bg-warning-soft text-warning" },
  COMPLETED: { label: "Completed", tone: "bg-sunken text-text-2" },
  ERROR: { label: "Error", tone: "bg-loss-soft text-loss" },
  REJECTED: { label: "Rejected", tone: "bg-loss-soft text-loss" },
  RECOVERY_REQUIRED: { label: "Recovery required", tone: "bg-loss-soft text-loss" },
  RISK_LOCKED: { label: "Risk lock", tone: "bg-loss-soft text-loss" },
};

const SLOT_TONE: Record<SlotState["state"], string> = {
  Waiting: "text-muted",
  "Order pending": "text-warning",
  Open: "text-profit",
  "Exit pending": "text-warning",
  Completed: "text-text-2",
  Rejected: "text-loss",
};

/** Live figures of the open position (from the server's replay-time mark), keyed to its trade. */
export type LivePosition = NonNullable<NonNullable<ChartAlgo["run"]>["position"]>;

/**
 * The Algo trading dashboard beside the replay chart. Every figure comes from the run's log and the
 * Algo account's ledger, both refreshed with each processed replay minute: the account, the three entry
 * slots, live trade cards (each opens its own detail view), the activity feed, completed trades and the
 * signals that were not traded. Phones show it folded under the chart.
 */
export function AlgoReplayPanel({ algo, cursor, chartSymbol, onHistory, selectedTrade, onOpenTrade, onRetrade }: {
  algo: ChartAlgo;
  cursor: number | null;
  chartSymbol: string;
  onHistory: () => void;
  /** The trade highlighted on the chart (its entry order key). */
  selectedTrade: string | null;
  /** Opens a trade's detail view (and selects it). */
  onOpenTrade: (entryKey: string) => void;
  /** Trade the same replay date again as a brand-new session. */
  onRetrade: () => void;
}) {
  // Phones start with the panel folded to its header (the chart keeps the screen); desktops show it open.
  const [open, setOpen] = useState(() => typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches);
  const [confirmExit, setConfirmExit] = useState(false);
  const [confirmEmergency, setConfirmEmergency] = useState(false);
  const data = algo.data;
  const run = algo.run;
  const position = run?.position ?? null;
  const replayMode = algo.replayReady;
  const [selected] = useSelectedStrategy();
  const feature = run?.strategy ?? selected;
  const enabled = algo.enabled && replayMode;
  const state = run?.state;
  const status: AlgoStatus = !enabled && !position ? "DISABLED" : state?.status ?? (enabled ? "READY" : "DISABLED");
  const badge = position?.exit ? BADGE.EXIT_PENDING! : BADGE[status] ?? BADGE.DISABLED!;
  const account = data?.account;
  const legacyRun = data?.runWallet === "DEMO" && run != null;
  const max = run?.config.maxTrades ?? data?.config.maxTrades ?? 3;
  const trades = run ? algoTrades(run.events, position ? { entryKey: position.entryKey, exitPending: Boolean(position.exit) } : null) : [];
  const completed = trades.filter((trade) => trade.status === "COMPLETED" && trade.realized != null).reverse();
  const openTrades = trades.filter((trade) => trade.status !== "COMPLETED");
  const skipped = run ? skippedSignals(run.events) : [];
  const slots = tradeSlots(trades, skipped, Boolean(state?.pending), max);
  const diagnostics = run ? run.diagnostics ?? runDiagnostics(run.events, run.enabledLines) : null;
  const netPnl = rupeesOf(account?.netPnl);
  const equity = rupeesOf(account?.equity);

  return (
    <aside className="flex min-h-0 shrink-0 flex-col border-border bg-panel text-[0.8125rem] max-lg:max-h-[50dvh] max-lg:border-t lg:w-[23rem] lg:border-l xl:w-[26rem]" aria-label="Algo trading">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Bot className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-base font-semibold">Algo</h2>
        <span className="min-w-0 truncate text-xs font-medium text-text-2" title={STRATEGY_NAME[feature]}>{feature === "PRIMARY_STRATEGY" ? "Primary" : "Mathi"}</span>
        <span className={cx("whitespace-nowrap rounded-pill px-2 py-0.5 text-xs font-semibold", badge.tone)} role="status">{badge.label}</span>
        <span className={cx("rounded-pill bg-demo-soft px-2 py-0.5 text-xs font-medium text-demo", position && !open && "max-lg:hidden")}>Simulated</span>
        {position && !open ? <LiveMoney value={position.unrealized} signed tone className="font-semibold lg:hidden" /> : null}
        <span className="num ml-auto hidden text-xs text-muted sm:inline">{ist(cursor)} IST</span>
        <button type="button" aria-label="Algo session history" title="Session history" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text max-sm:ml-auto" onClick={onHistory}><History className="h-4 w-4" aria-hidden /></button>
        <button type="button" aria-label={open ? "Collapse algo panel" : "Expand algo panel"} aria-expanded={open} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text lg:hidden" onClick={() => setOpen((value) => !value)}><ChevronDown className={cx("h-4 w-4 transition-transform", !open && "-rotate-90")} aria-hidden /></button>
      </header>

      <div className={cx("min-h-0 flex-1 space-y-3 overflow-y-auto p-3", !open && "max-lg:hidden")}>
        {algo.error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-xs text-loss" role="alert">{algo.error} <button type="button" className="ml-1 underline" onClick={algo.clearError}>Dismiss</button></p> : null}
        {!data ? <p className="text-muted">Loading the algo…</p> : null}

        {/* 1. Account overview */}
        {account ? (
          <section className="rounded-xl border border-border bg-gradient-to-br from-elevated to-panel p-3 shadow-e1" aria-label="Algo account overview">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Algo account · total P&amp;L</span>
              <span className="num rounded-pill bg-sunken px-2 py-0.5 text-xs text-text-2" title="Entries taken this session (filled entry orders), out of the configured maximum per session">Entries {trades.length} of {max} max</span>
            </div>
            <p className="mt-1 text-[2rem] font-semibold leading-tight"><LiveMoney value={netPnl} signed tone missing="—" /></p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-xs text-muted">Equity</span>
              <span className="text-xl font-semibold"><LiveMoney value={equity} missing="—" /></span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border-soft pt-2">
              <Metric label="Available cash"><LiveMoney value={rupeesOf(account.cashAvailable)} /></Metric>
              <Metric label="Open-position value"><LiveMoney value={rupeesOf(account.holdingsValue)} /></Metric>
              <Metric label="Unrealized P&L"><LiveMoney value={rupeesOf(account.unrealized)} signed tone /></Metric>
              <Metric label="Realized P&L"><LiveMoney value={rupeesOf(account.realized)} signed tone /></Metric>
            </dl>
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted hover:text-text">Account breakdown</summary>
              <div className="mt-2"><AlgoAccountFigures account={account} compact /></div>
              <p className="mt-1 text-muted">Equity = available cash + reserved funds + open-position value. Total P&amp;L = equity − initial capital, after charges (realized and unrealized are not added twice).</p>
              {legacyRun ? <p className="mt-1 text-warning">This replay session started before the Algo account existed, so its trades stay on your demo wallet until it ends.</p> : null}
            </details>
          </section>
        ) : null}

        {/* Algo switch and mode */}
        {data ? (
          <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-border-soft bg-sunken/50 px-3 py-2">
            <span className="min-w-0">
              <span className="block font-semibold">Enable Algo</span>
              <span className="block text-xs text-muted">{replayMode ? "Chart replay · historical paper · replay clock" : data.config.mode === "PAPER" ? "Paper at live prices. Enabling switches it to chart replay." : "Live (unavailable)"}</span>
              <span className="block text-xs text-muted">{enabled ? (run?.armed ? "Confirmed: trading this replay." : "Press Play to confirm and start.") : "Replay plays without trading."}</span>
            </span>
            <input type="checkbox" role="switch" className="oc-check" aria-label="Enable Algo for this replay" disabled={algo.busy === "mode"} checked={enabled} onChange={(event) => void algo.setEnabled(event.target.checked)} />
          </label>
        ) : null}
        {data ? (
          <p className="text-xs text-muted">
            Strategy: <strong className="text-text-2">{STRATEGY_NAME[feature]}</strong> · Execution lock: <strong className={data.lock.owner === feature ? "text-profit" : data.lock.owner === "NONE" ? "text-text-2" : "text-warning"}>{data.lock.owner === "NONE" ? "free" : STRATEGY_NAME[data.lock.owner]}</strong>
            {data.lock.owner !== "NONE" && data.lock.owner !== feature ? ` — ${STRATEGY_NAME[feature]} cannot start until it is stopped.` : ""}
          </p>
        ) : null}
        {data && data.config.underlying !== chartSymbol ? <p className="text-xs text-warning">The algo trades {data.config.underlying}; this chart shows {chartSymbol}. Its markers appear on the {data.config.underlying} chart.</p> : null}

        {/* Market analysis and the four strategies, from the run's stored analysis (the chart draws the same). */}
        {run && run.strategy !== "PRIMARY_STRATEGY" ? <MathiStatus state={state} config={run.config} mode="Chart replay" now={cursor} signal={latestSignal(run.events)} /> : null}
        {run ? <EngineCard state={state} config={run.config} date={run.date} now={cursor} unrealized={run.position?.unrealized ?? null} available={account?.cashAvailable ?? null} position={run.position ? { quantity: run.position.quantity, lots: run.position.lots, avg: run.position.avg, stop: run.position.stop, target: run.position.target, entryCharges: run.position.entryCharges, premium: run.position.premium, unrealized: run.position.unrealized } : null} /> : null}
        {run ? <ReportDownload runId={run.id} /> : null}
        {run?.strategy === "PRIMARY_STRATEGY" ? <SignalAudit events={run.events} /> : null}
        {data ? <MarketPlanSection date={run?.date ?? (cursor != null ? new Date((cursor + 19_800) * 1000).toISOString().slice(0, 10) : null)} /> : null}
        {run ? <MarketAnalysisSection analysis={state?.analysis} symbol={run.underlying} time={cursor} /> : null}
        {run ? <StrategyRows analysis={state?.analysis} positionOpen={Boolean(position)} /> : null}

        {/* 2. Strategy and replay status */}
        {run && diagnostics ? (
          <details className="rounded-lg border border-border-soft" aria-label="Algo processing">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
              <Radio className={cx("h-3.5 w-3.5", run.armed ? "text-profit live-dot rounded-full" : "text-muted")} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-text-2" role="status">{diagnostics.lastCandle != null ? `${ist(diagnostics.lastCandle)} · ` : ""}{diagnostics.lastOutcome}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden />
            </summary>
            <div className="border-t border-border-soft px-3 py-2 text-xs">
              <p className="num text-muted">Replay {ist(cursor)} IST · processed to {ist(run.processedThrough)} IST</p>
              <dl className="mt-1 grid grid-cols-4 gap-x-2 gap-y-1">
                <Item label="Lines on" value={`${diagnostics.enabledLines}/${run.lineCount}`} />
                <Item label="Checked" value={String(diagnostics.linesEvaluated)} />
                <Item label="Candles" value={String(diagnostics.candlesEvaluated)} />
                <Item label="Crossings" value={String(diagnostics.crossings)} />
                <Item label="Signals" value={String(diagnostics.signals)} />
                <Item label="Accepted" value={String(diagnostics.accepted)} />
                <Item label="Rejected" value={String(diagnostics.rejected)} />
                <Item label="Entries" value={`${trades.length}/${max}`} />
              </dl>
              {diagnostics.lastRejection ? <p className="mt-1 text-loss">Last rejection {ist(diagnostics.lastRejection.time)} IST: {diagnostics.lastRejection.reason}</p> : null}
            </div>
          </details>
        ) : null}

        {/* 3. Three entry slots */}
        {run ? (
          <ol className="grid grid-cols-3 gap-2" aria-label="Trade slots">
            {slots.map((slot) => {
              const trade = slot.trade;
              const open = trade && position && trade.entryKey === position.entryKey ? position : null;
              const live = open ? open.unrealized : null;
              const value = trade ? (trade.realized ?? live) : null;
              return (
                <li key={slot.number}>
                  <button
                    type="button"
                    disabled={!trade}
                    aria-pressed={trade ? selectedTrade === trade.entryKey : undefined}
                    title={slot.reason ?? undefined}
                    className={cx("w-full rounded-lg border px-2 py-1.5 text-left transition-colors disabled:cursor-default", trade && selectedTrade === trade.entryKey ? "border-primary ring-1 ring-primary" : "border-border-soft", trade && "hover:bg-hover", slot.state === "Open" && "bg-profit-soft/30")}
                    onClick={() => trade && onOpenTrade(trade.entryKey)}
                  >
                    <span className="flex items-baseline justify-between text-xs text-muted"><span>Trade {slot.number}/{max}</span>{slot.time ? <span className="num">{ist(slot.time)}</span> : null}</span>
                    <span className={cx("block text-sm font-semibold", trade ? (trade.side === "CALL" ? "text-profit" : "text-loss") : "text-muted")}>{trade ? `BUY ${trade.side}` : "—"}</span>
                    <span className={cx("block text-xs font-medium", SLOT_TONE[slot.state])}>{slot.state === "Waiting" ? "WAITING FOR SIGNAL" : slot.state === "Open" && open?.premium != null && open.premium >= open.target ? "TARGET REACHED" : slot.state.toUpperCase()}</span>
                    {trade ? <span className="block text-sm font-semibold"><LiveMoney value={value} signed tone missing={slot.state === "Open" ? "OPTION PRICE UNAVAILABLE" : "—"} /></span> : slot.reason ? <span className="line-clamp-2 block text-xs text-loss">{slot.reason}</span> : null}
                    {trade && trade.status === "COMPLETED" ? (
                      <span className="num block text-[0.6875rem] leading-snug text-muted">{inr(trade.entryPremium)} → {inr(trade.exitPremium)}<br />Gross {trade.gross == null ? "—" : money(trade.gross)} · Net {trade.realized == null ? "—" : money(trade.realized)}{trade.exitTime ? ` · ${ist(trade.exitTime)}` : ""}</span>
                    ) : trade ? (
                      <span className="num block text-[0.6875rem] leading-snug text-muted">{inr(trade.entryPremium)} → {open?.premium == null ? "—" : inr(open.premium)} · TGT {inr(trade.target)}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        ) : data ? (
          <p className="text-xs leading-snug text-muted">When enabled and confirmed, the algo checks each completed 1-minute candle of {data.config.underlying} against your enabled Strategy lines. A body crossing down buys the ATM PUT, up buys the ATM CALL, priced from that contract&apos;s real 1-minute premium history at the replay time.</p>
        ) : null}

        {/* 4. Active trades */}
        {openTrades.map((trade) => (
          <TradeCard key={trade.entryKey} trade={trade} max={max} position={position && position.entryKey === trade.entryKey ? position : null} confirmations={position && position.entryKey === trade.entryKey ? state?.confirmations ?? null : null} stale={Boolean(position && position.entryKey === trade.entryKey && cursor != null && position.premiumAt != null && cursor - position.premiumAt > 120)} selected={selectedTrade === trade.entryKey} onOpen={() => onOpenTrade(trade.entryKey)} onExit={() => setConfirmExit(true)} exiting={algo.busy === "exit"} />
        ))}
        {run && !openTrades.length ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs">
            <p className="font-semibold text-text-2" role="status">{waitingMessage(state?.analysis, trades.length, max)}</p>
            <p className="mt-0.5 text-muted">No open position. {state?.lastSignal ? `Last signal ${ist(state.lastSignal.time + 60)} IST: ${state.lastSignal.explanation}` : "No signal yet in this session."}</p>
            {state?.analysis && (state.analysis.levels.above != null || state.analysis.levels.below != null) ? <p className="num mt-0.5 text-muted">Next levels: above {state.analysis.levels.above?.toFixed(2) ?? "—"} · below {state.analysis.levels.below?.toFixed(2) ?? "—"}</p> : null}
          </div>
        ) : null}

        {/* 5. Activity */}
        {run ? <ActivityFeed items={activityFeed(run.events)} onOpenTrade={(number) => { const trade = trades.find((item) => item.number === number); if (trade) onOpenTrade(trade.entryKey); }} /> : null}

        {/* Session finished: download its full report, or trade the same day again as a new session. */}
        {run && run.status === "ENDED" ? <SessionFinished runId={run.id} completed={run.endReason === "COMPLETED"} trades={trades.length} max={max} onRetrade={onRetrade} /> : null}

        {/* 6. Completed trades */}
        {completed.length ? (
          <section aria-label="Completed trades">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Completed trades</p>
            <ol className="space-y-1.5">
              {completed.map((trade) => (
                <li key={trade.entryKey} data-trade={trade.entryKey}>
                  <button type="button" aria-pressed={selectedTrade === trade.entryKey} className={cx("w-full rounded-lg border px-3 py-2 text-left hover:bg-hover", selectedTrade === trade.entryKey ? "border-primary" : "border-border-soft")} onClick={() => onOpenTrade(trade.entryKey)}>
                    <span className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold text-muted">T{trade.number}</span>
                      <span className={cx("font-semibold", trade.side === "CALL" ? "text-profit" : "text-loss")}>BUY {trade.side}</span>
                      <span className="text-xs text-muted">{trade.strike} {trade.right}</span>
                      <span className={cx("num ml-auto text-base font-semibold", tone(trade.realized))}>{inr(trade.realized, true)}</span>
                    </span>
                    <span className="num block text-xs text-text-2">{ist(trade.entryTime)} {inr(trade.entryPremium)} → {ist(trade.exitTime)} {inr(trade.exitPremium)} · {trade.exitReason} · {trade.returnPercent == null ? "" : `${trade.returnPercent >= 0 ? "+" : ""}${trade.returnPercent.toFixed(2)}% · `}{trade.durationMinutes ?? "—"} min</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {/* 7. Rejected / skipped */}
        {run ? (
          <details className="rounded-lg border border-border-soft" aria-label="Rejected and skipped signals">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">Rejected / skipped ({skipped.length})</summary>
            <div className="border-t border-border-soft px-3 py-2">
              {skipped.length ? (
                <ol className="max-h-48 space-y-1.5 overflow-y-auto">
                  {skipped.slice(0, 30).map((row) => (
                    <li key={row.id} className="text-xs">
                      <span className="flex items-baseline gap-1.5"><span className="num text-muted">{ist(row.time)}</span><span className="font-semibold">{row.side ? `BUY ${row.side}` : "No entry"}</span>{row.lines.length ? <span className="truncate text-muted">{row.lines.join(", ")}</span> : null}</span>
                      <span className="block text-loss">{row.reason}</span>
                    </li>
                  ))}
                </ol>
              ) : <p className="text-xs text-muted">None. Candles without a qualifying line crossing are counted under the processing status.</p>}
            </div>
          </details>
        ) : null}

        {run && (run.armed || position) ? (
          <div className="flex flex-wrap gap-2">
            {run.armed ? <button type="button" className="h-9 rounded-md border border-border px-3 font-medium hover:bg-hover disabled:opacity-50" disabled={Boolean(algo.busy)} onClick={() => void algo.setEnabled(false)}>Stop new entries</button> : null}
            <button type="button" className="inline-flex h-9 items-center gap-1 rounded-md border border-loss/50 px-3 font-medium text-loss hover:bg-loss-soft disabled:opacity-50" style={{ color: "var(--loss)" }} disabled={Boolean(algo.busy) || cursor == null} onClick={() => setConfirmEmergency(true)}><OctagonX className="h-3.5 w-3.5" aria-hidden />Emergency stop</button>
          </div>
        ) : null}
        <p className="text-xs leading-snug text-muted">Algo account only (₹1,00,000 practice capital, separate from your demo funds). Fills come from historical 1-minute option data at the replay time; nothing is ever sent to a broker from replay.</p>
      </div>

      {confirmExit && position ? <ExitConfirm algo={algo} position={position} cursor={cursor} onClose={() => setConfirmExit(false)} /> : null}
      {confirmEmergency ? (
        <Dialog title="Emergency risk stop?" onClose={() => setConfirmEmergency(false)}>
          <p className="text-xs text-text-2">New algo entries stop immediately and {position ? "the open position is exited at the last completed premium at the replay time" : "no position is open"}. The replay itself keeps its place; you can turn the algo on again later.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => setConfirmEmergency(false)}>Cancel</button>
            <button type="button" className="h-8 rounded-md bg-loss px-3 font-semibold text-on-signal" onClick={() => { setConfirmEmergency(false); if (cursor != null) void algo.exit(cursor, true).then(() => algo.setEnabled(false)); }}>Stop now</button>
          </div>
        </Dialog>
      ) : null}
    </aside>
  );
}

/** The latest line signal of the run: the crossed line, its candle, the contract once bought, and what happened. */
function latestSignal(events: Array<{ key: string; time: number; kind: string; message: string; evaluation?: { decision: string; time: number; events: Array<{ label: string; price: number }>; stage?: string; setupSide?: "CALL" | "PUT"; cancelled?: string; explanation: string }; contract?: { underlying: string; strike: number; right: string; expiry: string }; reasons?: string[] }>) {
  const evaluation = [...events].reverse().find((event) => event.key.startsWith("eval") && (event.evaluation?.decision === "CALL" || event.evaluation?.decision === "PUT" || event.evaluation?.setupSide));
  if (!evaluation?.evaluation) return null;
  const time = evaluation.evaluation.time;
  const entry = events.find((event) => event.kind === "ENTRY" && event.time === time && event.contract);
  const cross = evaluation.evaluation.events[0];
  const stage = evaluation.evaluation.stage;
  // A detected breakout waiting for its confirmation, or cancelled (false breakout / expired): no order.
  if (!entry && (stage === "SIGNAL_DETECTED" || stage === "WAITING" || stage === "FALSE_BREAKOUT" || stage === "EXPIRED") && evaluation.evaluation.setupSide) {
    const text = evaluation.evaluation.explanation;
    const [head, ...rest] = text.split(" — ");
    return { side: evaluation.evaluation.setupSide, line: cross?.label ?? "Strategy line", price: cross?.price ?? null, time, contract: null, result: `${head} — ${rest.join(" — ")}` };
  }
  const rejected = evaluation.kind === "REJECTED" ? (evaluation.reasons?.join(" ") || evaluation.message) : null;
  return {
    side: (evaluation.evaluation.decision === "CALL" || evaluation.evaluation.decision === "PUT" ? evaluation.evaluation.decision : evaluation.evaluation.setupSide) as "CALL" | "PUT",
    line: cross?.label ?? "Strategy line",
    price: cross?.price ?? null,
    time,
    contract: entry?.contract ? `${entry.contract.underlying} ${entry.contract.strike} ${entry.contract.right} · ${entry.contract.expiry}` : null,
    result: entry ? "ORDER PLACED" : rejected ? `REJECTED — ${rejected}` : "SIGNAL DETECTED",
  };
}

/** One open trade, with its live premium and P&L (from the replay-time mark) and its detail view. */
function TradeCard({ trade, max, position, confirmations, stale, selected, onOpen, onExit, exiting }: { trade: AlgoTrade; max: number; position: LivePosition | null; confirmations: Confirmation[] | null; stale: boolean; selected: boolean; onOpen: () => void; onExit: () => void; exiting: boolean }) {
  const call = trade.side === "CALL";
  return (
    <section data-trade={trade.entryKey} className={cx("rounded-xl border-2 bg-gradient-to-br p-3 shadow-e1", call ? "from-profit-soft/30 to-panel" : "from-loss-soft/30 to-panel", selected ? "border-primary" : "border-border")} aria-label={`Trade ${trade.number} of ${max}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-semibold">T{trade.number} · <span className={call ? "text-profit" : "text-loss"}>BUY {trade.side}</span></p>
        <span className="inline-flex items-center gap-1 text-xs font-semibold"><CircleDot className={cx("h-3 w-3", trade.status === "OPEN" ? "text-profit" : "text-warning")} aria-hidden />{trade.status === "OPEN" ? "OPEN" : "EXIT PENDING"}</span>
      </div>
      {confirmations?.some((item) => item.status === "SETUP INVALIDATED") ? (
        <p className="mt-2 rounded-md bg-warning-soft px-2 py-1.5 text-xs font-semibold text-warning" role="alert">SETUP INVALIDATED — POSITION STILL OPEN. {confirmations.find((item) => item.status === "SETUP INVALIDATED")?.why} There is no stop-loss: the trade stays open for its +target until you exit it (or its time limit, when set).</p>
      ) : null}
      <p className="text-sm text-text-2">{trade.underlying} {trade.strike} {trade.right} · {trade.expiry}</p>
      <p className="text-xs text-muted">{STRATEGY_LABEL[trade.strategy]}{trade.strategies.length > 1 ? ` (+ ${trade.strategies.slice(1).map((id) => STRATEGY_LABEL[id]).join(", ")})` : ""}</p>
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted">Live P&amp;L</p>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[1.875rem] font-semibold leading-tight"><LiveMoney value={position?.unrealized} signed tone missing="Price unavailable" /></span>
        <span className={cx("num text-base font-semibold", tone(position?.unrealizedPercent))}>{position?.unrealizedPercent == null ? "" : `${position.unrealizedPercent > 0 ? "+" : ""}${position.unrealizedPercent.toFixed(2)}%`}</span>
      </div>
      {position && position.premium == null ? <p className="mt-1 rounded-md bg-warning-soft px-2 py-1 text-xs font-semibold text-warning">OPTION PRICE UNAVAILABLE at this replay time</p> : null}
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <Metric label="Status">{position?.premium != null && position.premium >= position.target ? <span className="font-semibold text-profit">TARGET REACHED</span> : <span className="font-semibold text-profit">OPEN</span>}</Metric>
        <Metric label="Target premium (+3%)">{inr(trade.target)}</Metric>
        <Metric label="Entry">{inr(trade.entryPremium)}</Metric>
        <Metric label={`${stale ? "Last valid" : "Live"}${position?.premiumAt ? ` · ${ist(position.premiumAt)}` : ""}`}><LiveMoney value={position?.premium} className="text-lg font-semibold" />{stale ? <span className="ml-1 rounded-pill bg-warning-soft px-1.5 text-xs font-semibold text-warning">STALE</span> : null}</Metric>
        <Metric label="Qty · lot">{trade.quantity}{trade.lotSize ? ` · ${trade.quantity / trade.lotSize} × ${trade.lotSize}` : ""}</Metric>
        <Metric label="Entry value">{inr(trade.entryPremium * trade.quantity)}</Metric>
        <Metric label="Unrealized gross">{position?.premium == null ? "—" : <LiveMoney value={Math.round((position.premium - trade.entryPremium) * trade.quantity * 100) / 100} signed tone />}</Metric>
        <Metric label="Est. charges (entry + exit)">{inr(trade.entryCharges * 2)}</Metric>
        <Metric label="Est. net">{position?.premium == null ? "—" : <LiveMoney value={Math.round(((position.premium - trade.entryPremium) * trade.quantity - trade.entryCharges * 2) * 100) / 100} signed tone />}</Metric>
        <Metric label="Entered">{ist(trade.entryTime)}</Metric>
      </dl>
      {position?.premium != null && trade.target ? (
        <div className="mt-2" aria-label="Progress to the target">
          <div className="flex justify-between text-xs text-muted"><span>Progress to +{Math.round(((trade.target / trade.entryPremium) - 1) * 100)}%</span><span className="num">{Math.round(Math.max(-100, Math.min(100, ((position.premium - trade.entryPremium) / (trade.target - trade.entryPremium)) * 100)))}%</span></div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-sunken"><div className={cx("h-full", position.premium >= trade.entryPremium ? "bg-profit" : "bg-loss")} style={{ width: `${Math.max(0, Math.min(100, ((position.premium - trade.entryPremium) / (trade.target - trade.entryPremium)) * 100))}%` }} /></div>
        </div>
      ) : null}
      {position ? <PremiumBar stop={position.stop} entry={position.avg} target={position.target} current={position.premium} /> : null}
      <details open className="mt-2 rounded-md border border-border-soft px-2 py-1.5">
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted">Intratrade confirmations</summary>
        <div className="mt-1.5"><ConfirmationList confirmations={confirmations} /></div>
      </details>
      <div className="mt-2 flex gap-2">
        <button type="button" className="inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-md border border-border font-semibold hover:bg-hover" onClick={onOpen}>View trade details <ArrowRight className="h-4 w-4" aria-hidden /></button>
        <button type="button" className="h-9 rounded-md bg-loss px-3 font-semibold text-on-signal hover:brightness-110 disabled:opacity-50" disabled={!position || Boolean(position.exit) || exiting} onClick={onExit}>{position?.exit ? "Exiting…" : "Exit"}</button>
      </div>
    </section>
  );
}

const FEED_ICON: Record<ActivityItem["kind"], ReactNode> = {
  signal: <Zap className="h-3.5 w-3.5 text-warning" aria-hidden />,
  opened: <LogIn className="h-3.5 w-3.5 text-profit" aria-hidden />,
  closed: <LogOut className="h-3.5 w-3.5 text-info" aria-hidden />,
  rejected: <Ban className="h-3.5 w-3.5 text-loss" aria-hidden />,
  confirm: <ShieldCheck className="h-3.5 w-3.5 text-info" aria-hidden />,
  info: <CircleDot className="h-3.5 w-3.5 text-muted" aria-hidden />,
};
type FeedFilter = "all" | "CALL" | "PUT" | "opened" | "closed" | "rejected";

/**
 * The algo's activity, newest first. New items arrive at the top; when the reader has scrolled down to
 * older items, the view keeps their place instead of jumping back to the top.
 */
function ActivityFeed({ items, onOpenTrade }: { items: ActivityItem[]; onOpenTrade: (number: number) => void }) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const list = items.filter((item) => filter === "all" || (filter === "CALL" || filter === "PUT" ? item.side === filter : item.kind === filter)).slice(0, 60);
  const box = useRef<HTMLOListElement>(null);
  const before = useRef<{ first: string | null; height: number }>({ first: null, height: 0 });
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const first = list[0]?.id ?? null;
    if (before.current.first && first !== before.current.first && node.scrollTop > 0) node.scrollTop += node.scrollHeight - before.current.height;
    before.current = { first, height: node.scrollHeight };
  });
  const filters: Array<[FeedFilter, string]> = [["all", "All"], ["CALL", "CALL"], ["PUT", "PUT"], ["opened", "Open"], ["closed", "Completed"], ["rejected", "Rejected"]];
  return (
    <section aria-label="Algo activity">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Activity</span>
        <div className="flex flex-wrap justify-end gap-0.5" role="group" aria-label="Filter activity">
          {filters.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={filter === key} className={cx("h-6 rounded px-1.5 text-xs", filter === key ? "bg-primary-soft font-semibold text-primary" : "text-muted hover:text-text")} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
      </div>
      {list.length ? (
        <ol ref={box} className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border-soft p-1.5">
          {list.map((item) => (
            <li key={item.id} className="anim-rise flex gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
              <span className="mt-0.5">{FEED_ICON[item.kind]}</span>
              <span className="min-w-0 flex-1 text-xs">
                <span className="flex items-baseline gap-1.5">
                  <span className="num text-muted">{ist(item.time)}</span>
                  {item.trade ? <button type="button" className="font-semibold text-primary underline-offset-2 hover:underline" onClick={() => onOpenTrade(item.trade!)}>T{item.trade}</button> : null}
                  {item.side ? <span className={cx("font-semibold", item.side === "CALL" ? "text-profit" : "text-loss")}>{item.side}</span> : null}
                  {item.pnl != null ? <span className={cx("num ml-auto font-semibold", tone(item.pnl))}>{inr(item.pnl, true)}</span> : null}
                </span>
                <span className="block text-text-2">{item.text}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">No activity{filter === "all" ? " yet" : " for this filter"}.</p>}
    </section>
  );
}

/** The manual exit's confirmation (shared by the trade card and the trade detail view). */
export function ExitConfirm({ algo, position, cursor, onClose }: { algo: ChartAlgo; position: LivePosition; cursor: number | null; onClose: () => void }) {
  return (
    <Dialog title="Exit this position?" onClose={onClose}>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Item label="Contract" value={`${position.contract.underlying} ${position.contract.strike} ${position.contract.right} · ${position.contract.expiry}`} />
        <Item label="Quantity to close" value={String(position.quantity)} />
        <Item label="Current premium" value={inr(position.premium)} />
        <Item label="Estimated exit value" value={inr(position.value)} />
        <Item label="Unrealized P&L" value={inr(position.unrealized, true)} tone={tone(position.unrealized)} />
        <Item label="Stop-loss / target" value={`${position.stop > 0 ? inr(position.stop) : "None"} / ${inr(position.target)}`} />
      </dl>
      <p className="mt-3 text-xs text-muted">The exit fills at the last completed 1-minute premium at the replay time ({ist(cursor)} IST), less one tick of slippage per your settings, whether the replay is playing or paused. Minutes up to the replay time are checked first, so a stop-loss or target already reached is applied instead. Final realized P&amp;L includes charges and can differ from the estimate.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={onClose}>Cancel</button>
        <button type="button" className="h-8 rounded-md bg-loss px-3 font-semibold text-on-signal disabled:opacity-50" disabled={Boolean(algo.busy) || cursor == null || Boolean(position.exit)} onClick={() => { onClose(); if (cursor != null) void algo.exit(cursor); }}>Confirm Exit</button>
      </div>
    </Dialog>
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

/** Stop — entry — target on the option premium, with the current premium marked. */
export function PremiumBar({ stop: stopLevel, entry, target, current }: { stop: number | null; entry: number; target: number; current: number | null }) {
  // Without a stop-loss the bar's left end is as far below the entry as the target is above it.
  const hasStop = stopLevel != null && stopLevel > 0;
  const stop = hasStop ? stopLevel : Math.min(entry - (target - entry), current ?? entry);
  const span = Math.max(0.01, target - stop);
  const at = (value: number) => `${Math.min(100, Math.max(0, ((value - stop) / span) * 100))}%`;
  return (
    <div className="mt-2" aria-label="Option premium against stop-loss and target">
      <div className="relative h-2 rounded-full bg-gradient-to-r from-loss/40 via-sunken to-profit/40">
        <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-text-2" style={{ left: at(entry) }} title={`Entry ₹${entry}`} />
        {current != null ? <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-primary" style={{ left: at(current) }} title={`Current ₹${current}`} /> : null}
      </div>
      <div className="mt-0.5 flex justify-between text-micro text-muted"><span>{hasStop ? `SL ${stop.toFixed(2)}` : "No SL"}</span><span>Entry {entry.toFixed(2)}</span><span>TGT {target.toFixed(2)}</span></div>
    </div>
  );
}

export function Item({ label, value, tone: color, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className={cx("num truncate font-medium text-text", color)} title={value}>{value}{hint ? <span className="ml-1 text-micro font-normal text-muted">{hint}</span> : null}</dd>
    </div>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    // Above the trade detail drawer (z-50): a confirmation asked from it, or from Play while it is open, must be on top.
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl border border-border bg-panel p-4 text-data shadow-e4" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <h2 className="text-dense font-semibold">{title}</h2>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * Pressing Play (or resuming) with the algo enabled: an explicit confirmation of what will run. A replay
 * moved back before the algo's processed minutes offers to resume from there or reset the session.
 */
export function AlgoStartDialog({ algo, date, cursor, speed, onCancel, onStart, onJump, onReset }: {
  algo: ChartAlgo;
  date: string;
  cursor: number;
  speed: number;
  onCancel: () => void;
  onStart: () => void;
  onJump: (to: number) => void;
  onReset: () => void;
}) {
  const data = algo.data;
  const gate = algo.gate;
  const [selected] = useSelectedStrategy();
  // The run's own feature (a resume), else the one selected for this new session.
  const strategy = algo.run?.strategy ?? selected;
  const config = strategy === "PRIMARY_STRATEGY" ? data?.primaryConfig : data?.config;
  const run = algo.run;
  const unsaved = useUnsavedSettings();
  // Always confirm with the settings saved right now (they may have been changed since the chart loaded them).
  const refresh = algo.refresh;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const position = run?.position ?? null;
  if (!data || !config || !gate) return null;
  if (gate.kind === "behind") {
    return (
      <Dialog title="Replay is behind the algo" onClose={onCancel}>
        <p className="text-micro text-text-2">The replay is at {ist(cursor)} IST, but the algo has already processed this session through {ist(gate.processedThrough)} IST. Recorded trades cannot be replayed again into the same demo ledger.</p>
        {position ? <p className="mt-2 text-micro text-warning">A position is open, so the session cannot be reset until it is exited.</p> : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={onCancel}>Cancel</button>
          <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover disabled:opacity-50" disabled={Boolean(position)} onClick={onReset}>Reset session</button>
          <button type="button" className="h-8 rounded-md bg-primary px-3 font-semibold text-on-primary" onClick={() => onJump(gate.processedThrough)}>Resume at {ist(gate.processedThrough)}</button>
        </div>
      </Dialog>
    );
  }
  const ended = run?.status === "ENDED";
  const mathi = strategy !== "PRIMARY_STRATEGY";
  const noCutoff = config.entryCutoff >= "15:30";
  const rows: Array<[string, string]> = [
    ["Underlying", config.underlying],
    ["Signal timeframe", "1 minute (completed candles)"],
    ["Replay", `${date} from ${ist(cursor)} IST`],
    ["Replay speed", `${speed}x`],
    ["Algo account cash", data.account.cashAvailable],
    ["Algo account equity", data.account.equity],
    ["Quantity", config.sizing === "capital" ? `Whole lots for up to ${config.allocation.percent}% of ₹${config.allocation.maxCapital.toLocaleString("en-IN")} (max ${config.lots})` : config.sizing === "risk" ? `Sized to ₹${Math.round(config.risk.capital * config.risk.perTradePercent) / 100} risk (max ${config.lots} lots)` : `${config.lots} lot${config.lots === 1 ? "" : "s"} (ATM CALL / PUT)`],
    ["Target", config.target.mode === "percent" ? `${config.target.value}% of the option premium` : `₹${config.target.value} above entry`],
    ["Stop-loss", config.stopLoss === false ? ["None", config.maxHoldMinutes > 0 ? `exit at the premium after ${config.maxHoldMinutes} min without the target` : "", config.structureStop ? "exit when NIFTY closes back through the line" : ""].filter(Boolean).join("; ") : config.stop.mode === "percent" ? `${config.stop.value}% of premium` : `₹${config.stop.value} below entry`],
    ["Max trades", `${config.maxTrades} per session`],
    ["Max daily loss", inr(config.maxDailyLoss)],
    ["Cooldown", `${config.cooldownMinutes} min`],
    ["Entry cutoff", noCutoff ? "None" : `${config.entryCutoff} IST`],
    // Optional Mathi confirmations are listed only when switched on.
    ...(mathi ? [["Breakout confirmation", { single: "Single candle (no confirmation)", hold: "Next candle must hold beyond the line", retest: `Retest must hold within ${config.confirmation.retestWindowMinutes} min` }[confirmationMode(config)]] as [string, string]] : []),
    ...(mathi && config.filters.momentum ? [["Momentum (9/21 EMA)", "Must agree"] as [string, string]] : []),
    ["Open position", position ? `${position.contract.strike} ${position.contract.right} × ${position.quantity}` : "None"],
  ];
  const strategies = strategy === "PRIMARY_STRATEGY"
    ? `Opening range ${config.primary.orMinutes} min + ${config.primary.vwap ? "VWAP side" : "no VWAP filter"} + ${config.primary.trend === "ema" ? `${config.primary.trendFast}/${config.primary.trendSlow} EMA trend` : "no trend filter"}${config.primary.continuation ? " + continuation" : ""}${config.primary.retest ? " + retest" : ""}${config.primary.supportBreak ? " + support breakdown" : ""}; a break waits ${config.primary.confirmBars} candles for confirmation`
    : config.crossPercent
      ? `Strategy-line breakouts: ATM CE when ${config.crossPercent}% of a bullish candle's body is above an enabled line, ATM PE when that share of a bearish body is below it`
      : "Strategy-line breakouts: ATM CE when a bullish candle's body crosses up through an enabled line, ATM PE when a bearish body crosses down (any amount; a wick alone never counts)";
  const lock = data.lock;
  const blocked = lock.owner !== "NONE" && lock.owner !== strategy && lock.activity && (lock.activity.running || lock.activity.position || lock.activity.pending) ? blockedMessage(lock.owner, strategy, lock.activity) : null;
  return (
    <Dialog title="Start Algo Trading Replay?" onClose={onCancel}>
      <p className="text-micro text-text-2">The strategy will monitor completed 1-minute candles and may automatically open ATM CALL or PUT demo positions when valid signals occur. {config.stopLoss === false ? `The +${config.target.value}% premium target is monitored throughout the replay; there is no stop-loss${config.maxHoldMinutes > 0 ? `; a trade still short of its target ${config.maxHoldMinutes} minutes after its entry exits at the premium` : ""}${config.structureStop ? "; a trade exits if NIFTY closes back through the broken line" : ""}.` : "Stop-loss and target rules will be monitored throughout the replay."}</p>
      <p className="mt-2 text-xs font-semibold text-text">{STRATEGY_NAME[strategy]}</p>
      {blocked ? <p className="mt-2 rounded-md bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{blocked}</p> : null}
      {unsaved ? <p className="mt-2 rounded-md bg-warning-soft px-2 py-1.5 text-micro text-warning">The Algo settings in the Strategy panel have unsaved changes. The replay uses the saved settings shown below: press Save settings there first to use your changes.</p> : null}
      {ended ? <p className="mt-2 rounded-md bg-warning-soft px-2 py-1.5 text-micro text-warning">This replay session&apos;s algo run has ended ({run?.endReason === "SESSION_END" ? "session close" : "reset"}). Reset the replay to start a new isolated session.</p> : null}
      {gate.kind === "confirm" && gate.skippedMinutes > 0 ? <p className="mt-2 rounded-md bg-info-soft px-2 py-1.5 text-micro text-info">The replay moved forward {gate.skippedMinutes} minute{gate.skippedMinutes === 1 ? "" : "s"} since the algo last ran. Those minutes are processed in order first (signals, stop-loss and target), exactly as if the replay had played through them.</p> : null}
      <div className="mt-3">
        <p className="text-micro text-muted">{strategy === "PRIMARY_STRATEGY" ? "Rules" : "Entry rule"}</p>
        <p className="font-medium text-text">{strategies}</p>
      </div>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {rows.map(([label, value]) => <Item key={label} label={label} value={value} />)}
      </dl>
      <p className="mt-3 rounded-md bg-demo-soft px-2 py-1.5 text-micro text-demo">Simulated trading on the Algo account (its own practice capital). Fills use historical 1-minute option premiums; nothing is sent to a broker.</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={onCancel}>Cancel</button>
        {ended ? <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={onReset}>Reset session</button> : null}
        <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 font-semibold text-on-primary disabled:opacity-50" disabled={Boolean(algo.busy) || ended || Boolean(blocked)} onClick={onStart}><Play className="h-3.5 w-3.5" aria-hidden />{algo.busy === "arm" ? "Starting…" : "Start Algo & Replay"}</button>
      </div>
    </Dialog>
  );
}

/**
 * Exit Replay (or a new date) with an Algo session: says what will be archived and what happens to an open
 * position, then archives it. The session stays on screen until the archive has succeeded; a failure
 * keeps everything and can be retried.
 */
export function AlgoEndDialog({ algo, cursor, onCancel, onConfirm, action }: { algo: ChartAlgo; cursor: number | null; onCancel: () => void; onConfirm: () => void; action: "exit" | "date" }) {
  const run = algo.run;
  const position = run?.position ?? null;
  const trades = run ? algoTrades(run.events, position ? { entryKey: position.entryKey, exitPending: Boolean(position.exit) } : null) : [];
  const saving = algo.busy === "finalize";
  return (
    <Dialog title="End this replay session?" onClose={saving ? () => undefined : onCancel}>
      <p className="text-sm text-text-2">{action === "exit" ? "Exiting replay" : "Changing the replay date"} ends this Algo session and saves it to <strong>Home → Algo History</strong>. The next replay starts a fresh session: ₹1,00,000, no trades, 0/{run?.config.maxTrades ?? 3} entries.</p>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        <Item label="Trades" value={`${trades.length}/${run?.config.maxTrades ?? 3}`} />
        <Item label="Realized" value={inr(run?.stats.realized ?? 0, true)} tone={tone(run?.stats.realized)} />
        <Item label="Processed to" value={`${ist(run?.processedThrough)} IST`} />
      </dl>
      {position ? (
        <p className="mt-3 rounded-md bg-warning-soft px-2 py-1.5 text-xs text-warning">
          The open {position.side} {position.contract.strike} {position.contract.right} × {position.quantity} (unrealized {inr(position.unrealized, true)}) will be closed at the last processed replay premium ({ist(run?.processedThrough)} IST) with the exit reason &quot;Replay session closed&quot;. If no premium is available it is not filled: it stays on the Algo ledger and is archived as unresolved.
        </p>
      ) : null}
      {algo.error ? <p className="mt-3 rounded-md bg-loss-soft px-2 py-1.5 text-xs text-loss" role="alert">Saving failed: {algo.error}. Nothing was cleared; try again.</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover disabled:opacity-50" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="h-8 rounded-md bg-primary px-3 font-semibold text-on-primary disabled:opacity-60" disabled={saving || cursor == null} onClick={onConfirm}>{saving ? "Saving session history…" : algo.error ? "Retry" : action === "exit" ? "Save & exit replay" : "Save & change date"}</button>
      </div>
    </Dialog>
  );
}

/**
 * The session's trades are all done: the replay is paused and this summary (the server's archived
 * figures for the session, not a separate calculation) is shown once.
 */
export function AlgoCompleteDialog({ run, onClose, onHistory, onNewReplay }: { run: NonNullable<ChartAlgo["run"]>; onClose: () => void; onHistory: () => void; onNewReplay: () => void }) {
  const report = useReportDownload(run.id);
  const summary = run.summary;
  const stats = summary?.stats ?? run.stats;
  const max = summary?.maxTrades ?? run.config.maxTrades;
  const completed = summary?.completed ?? stats.trades;
  const equity = summary?.account?.equity ?? null;
  return (
    <Dialog title="Algo Session Completed" onClose={onClose}>
      <p className="text-sm text-text-2">All {max} trades are completed. Replay has been paused.</p>
      <div className="mt-3 rounded-xl bg-elevated p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Total realized P&amp;L</p>
        <p className={cx("num text-[1.75rem] font-semibold leading-tight", tone(stats.realized))}>{inr(stats.realized, true)}</p>
        <dl className="mt-2 grid grid-cols-3 gap-2">
          <Item label="Completed trades" value={`${completed}/${max}`} />
          <Item label="Winning" value={String(stats.wins)} tone="text-profit" />
          <Item label="Losing" value={String(stats.losses)} tone="text-loss" />
          <Item label="Starting capital" value={inr(summary?.startCapital ?? null)} />
          <Item label="Final equity" value={equity ?? "—"} />
          <Item label="Replay date" value={run.date} />
        </dl>
        <p className="num mt-2 text-xs text-muted">Completed at {ist(run.processedThrough)} IST (replay time)</p>
      </div>
      <p className="mt-2 text-xs text-muted">Saved to Home → Algo History. No further signals or entries are processed in this session.</p>
      {report.error ? <p className="mt-1 text-xs text-loss" role="alert">{report.error}</p> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={onClose}>Close</button>
        <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={onHistory}>View Trade History</button>
        <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 hover:bg-hover disabled:opacity-50" disabled={report.busy} onClick={report.download}><Download className="h-3.5 w-3.5" aria-hidden />{report.busy ? "Preparing…" : "Download report"}</button>
        <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 font-semibold text-on-primary" onClick={onNewReplay}><Play className="h-3.5 w-3.5" aria-hidden />Start New Replay</button>
      </div>
    </Dialog>
  );
}

/** Downloads a session's report, with its busy and error state. */
function useReportDownload(runId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const download = () => {
    setBusy(true);
    setError("");
    downloadAlgoReport(runId)
      .catch((caught: unknown) => setError(caught instanceof Error ? `The report could not be downloaded: ${caught.message}` : "The report could not be downloaded."))
      .finally(() => setBusy(false));
  };
  return { busy, error, download };
}

/**
 * Algo - Primary Strategy's signal audit: every candle on which a setup was armed, confirmed, waited or was
 * rejected — with the values and conditions it was decided on and the order result — newest first. Plain
 * "inside the range" candles are left out unless asked for. It tells an invalid setup from a software fault.
 */
function SignalAudit({ events }: { events: Array<{ key: string; time: number; kind: string; evaluation?: { audit?: import("@/lib/algo/primary").PrimaryAudit | null } }> }) {
  const [all, setAll] = useState(false);
  const rows = events
    .filter((event) => event.evaluation?.audit && (all || event.evaluation.audit.setup || event.evaluation.audit.crossing || event.evaluation.audit.decision !== "WAIT"))
    .map((event) => ({ key: event.key, audit: event.evaluation!.audit! }))
    .reverse()
    .slice(0, 60);
  const tone = (decision: string) => (decision === "ENTER" ? "text-profit" : decision === "REJECT" ? "text-loss" : "text-warning");
  return (
    <details className="rounded-lg border border-border-soft" aria-label="Signal audit">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Signal audit</span>
        <span className="num ml-auto text-xs text-muted">{rows.length} candle{rows.length === 1 ? "" : "s"}</span>
      </summary>
      <div className="space-y-1.5 border-t border-border-soft px-3 py-2 text-xs">
        <label className="flex cursor-pointer items-center gap-1.5 text-muted"><input type="checkbox" className="oc-check" checked={all} onChange={(event) => setAll(event.target.checked)} />Show every evaluated candle</label>
        {rows.length ? rows.map(({ key, audit }) => (
          <div key={key} className="rounded-md bg-sunken/50 p-1.5">
            <p className="flex flex-wrap items-center gap-x-2">
              <span className="num font-semibold text-text">{ist(audit.time + 60)}</span>
              {audit.setup ? <span className="font-medium text-text-2">{audit.setup.type} {audit.setup.direction}</span> : null}
              <span className={cx("ml-auto font-semibold", tone(audit.decision))}>{audit.decision}</span>
            </p>
            <p className="num text-muted">O {audit.candle.open.toFixed(2)} H {audit.candle.high.toFixed(2)} L {audit.candle.low.toFixed(2)} C {audit.candle.close.toFixed(2)}{audit.range ? ` · range ${audit.range.low.toFixed(2)}–${audit.range.high.toFixed(2)}` : ""}{audit.vwap ? ` · ${audit.vwap.source} ${audit.vwap.value.toFixed(2)}` : ""}{audit.ema ? ` · EMA ${audit.ema.fast.toFixed(2)} / ${audit.ema.slow.toFixed(2)}` : ""}</p>
            {audit.crossing ? <p className="text-text-2">{audit.crossing}</p> : null}
            {audit.passed.map((item) => <p key={item} className="text-profit">✓ {item}</p>)}
            {audit.failed.map((item) => <p key={item} className="text-loss">✗ {item}</p>)}
            <p className="text-text-2">{audit.reason}</p>
          </div>
        )) : <p className="text-muted">No setups yet{all ? "" : " (switch on “every evaluated candle” to see each WAITING candle)"}.</p>}
      </div>
    </details>
  );
}

/** The session's trades so far (and every signal with its reason), downloadable at any time. */
function ReportDownload({ runId }: { runId: string }) {
  const report = useReportDownload(runId);
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border-soft px-3 py-2">
      <span className="min-w-0 text-xs text-muted">Trades, signals and the reason for every skipped signal</span>
      <button type="button" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-semibold hover:bg-hover disabled:opacity-50" disabled={report.busy} onClick={report.download}><Download className="h-3.5 w-3.5" aria-hidden />{report.busy ? "Preparing…" : "Download CSV"}</button>
      {report.error ? <p className="text-xs text-loss" role="alert">{report.error}</p> : null}
    </div>
  );
}

/** A finished session in the panel: its full report as a download, and a retrade of the same day. */
function SessionFinished({ runId, completed, trades, max, onRetrade }: { runId: string; completed: boolean; trades: number; max: number; onRetrade: () => void }) {
  const report = useReportDownload(runId);
  return (
    <section className="rounded-xl border border-primary/40 bg-primary-soft/20 p-3" aria-label="Session finished">
      <p className="text-sm font-semibold">{completed ? `All ${max} trades completed` : `Session ended · ${trades}/${max} trades`}</p>
      <p className="mt-0.5 text-xs text-muted">Download the full trade flow (summary, every trade and every processed candle, signal, order, confirmation and exit), or trade this day again as a new session.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={report.busy} onClick={report.download}><Download className="h-4 w-4" aria-hidden />{report.busy ? "Preparing…" : "Download trade report"}</button>
        <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 font-semibold hover:bg-hover" onClick={onRetrade}><RotateCcw className="h-4 w-4" aria-hidden />Retrade this day</button>
      </div>
      {report.error ? <p className="mt-1.5 text-xs text-loss" role="alert">{report.error}</p> : null}
    </section>
  );
}
