"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, OctagonX, Play, Plus, Square, Trash2 } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { AlgoHistory } from "@/components/algo/algo-history";
import { AlgoAccountFigures } from "@/components/algo/algo-account";
import { ConfirmationList, MarketAnalysisSection, StrategyRows, waitingMessage } from "@/components/algo/algo-analysis";
import { MultiDayBacktest } from "@/components/algo/algo-backtest";
import { EngineCard, MarketPlanSection, MathiStatus } from "@/components/algo/algo-engine";
import { announceSaved, announceUnsaved, useSelectedStrategy } from "@/components/algo/algo-settings-sync";
import { PrimaryPanel, StrategySelector } from "@/components/algo/algo-primary";
import { LINE_TYPES, type LineType } from "@/lib/algo/lines";
import { confirmationMode, type AlgoConfig, type AlgoStatus, type ConfirmationMode } from "@/lib/algo/runner";
import type { algoView } from "@/server/algo";

export type AlgoData = Awaited<ReturnType<typeof algoView>>;

const STATUS: Record<AlgoStatus, { label: string; tone: string }> = {
  DISABLED: { label: "Disabled", tone: "bg-sunken text-muted" },
  READY: { label: "Ready (entries off)", tone: "bg-info-soft text-info" },
  MONITORING: { label: "Monitoring", tone: "bg-primary-soft text-primary" },
  SIGNAL_DETECTED: { label: "Signal detected", tone: "bg-warning-soft text-warning" },
  ORDER_PENDING: { label: "Order pending", tone: "bg-warning-soft text-warning" },
  POSITION_OPEN: { label: "Position open", tone: "bg-profit-soft text-profit" },
  EXIT_PENDING: { label: "Exit pending", tone: "bg-warning-soft text-warning" },
  COMPLETED: { label: "Completed", tone: "bg-profit-soft text-profit" },
  ERROR: { label: "Error", tone: "bg-loss-soft text-loss" },
  REJECTED: { label: "Rejected", tone: "bg-loss-soft text-loss" },
  RECOVERY_REQUIRED: { label: "Recovery required", tone: "bg-loss-soft text-loss" },
  RISK_LOCKED: { label: "Risk lock", tone: "bg-loss-soft text-loss" },
};

const CONFIRMATION_TEXT: Record<ConfirmationMode, string> = { single: "Single candle", hold: "Breakout hold (next candle)", retest: "Retest of the line" };
const CONFIRMATION_HELP: Record<ConfirmationMode, string> = {
  hold: "The crossing candle is only a detected signal. The next completed candle must close beyond the line and move with the break (a bearish candle closing below it for a PUT, a bullish one closing above it for a CALL). A candle that closes back, or falls back toward the line, cancels it as FALSE BREAKOUT — ENTRY CANCELLED; no order is sent.",
  retest: "After the break, price must come back to the line without closing back across it, then a candle must move on (a bearish close below the retest candle's low for a PUT, a bullish close above its high for a CALL). A close back across the line cancels it; no retest in the window lets it expire. Fewer, later entries.",
  single: "Enters on the crossing candle itself (no confirmation): fastest, but a break that reverses the next minute is still traded.",
};
const inr = (value: number | null | undefined) => (value == null ? "—" : `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const clock = (seconds: number | null | undefined) => (seconds ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(seconds * 1000)) : "—");

/**
 * The Algo Trade tab of the Strategy panel: it turns the strategy's lines into ATM CALL / PUT entries.
 * Every control calls the server (settings, session, exits and replays are checked there); while the
 * session runs this tab asks the server to check new candles every 15 seconds.
 */
export function AlgoPanel({ chartSymbol }: { chartSymbol: string }) {
  const [data, setData] = useState<AlgoData | null>(null);
  const [draft, setDraft] = useState<AlgoConfig | null>(null);
  const [selected, select] = useSelectedStrategy();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [replayDate, setReplayDate] = useState("");
  // The time of the last tick (for the feed's staleness); set by the tick, never read from the clock while rendering.
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [yesterday] = useState(() => new Date(Date.now() + 19_800_000 - 86_400_000).toISOString().slice(0, 10));
  const [today] = useState(() => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10));
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const apply = useCallback((next: AlgoData) => {
    if (!live.current) return;
    setData(next);
    setDraft((current) => current ?? next.config);
  }, []);

  const run = useCallback(async (label: string, body: unknown) => {
    setBusy(label);
    setError("");
    try {
      const next = await api<AlgoData>("/api/algo", body);
      apply(next);
      if (label === "save") {
        setDraft(next.config);
        announceSaved();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy("");
    }
  }, [apply]);

  useEffect(() => {
    api<AlgoData>("/api/algo").then(apply).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The algo could not be loaded."));
  }, [apply]);

  // While a session runs (or a position is open) the server checks new candles every 15 seconds.
  const active = Boolean(data?.state.running || data?.state.position || data?.state.pending);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setCheckedAt(Math.floor(Date.now() / 1000));
      api<AlgoData>("/api/algo", { action: "tick" }).then(apply).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, apply]);

  const unsaved = Boolean(data && draft && JSON.stringify(draft) !== JSON.stringify(data.config));
  useEffect(() => {
    announceUnsaved(unsaved);
  }, [unsaved]);
  useEffect(() => () => announceUnsaved(false), []);

  if (!data || !draft) return <p className="text-micro text-muted" role="status">{error || "Loading the algo…"}</p>;

  const { state } = data;
  const status = STATUS[state.status] ?? STATUS.DISABLED;
  const set = (patch: Partial<AlgoConfig>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);
  const position = data.position;
  const paper = draft.mode === "PAPER";
  // During market hours a running session should see a new completed candle every minute.
  const istMinute = checkedAt == null ? null : Math.floor(((checkedAt + 19_800) % 86_400) / 60);
  const marketHours = istMinute != null && istMinute >= 9 * 60 + 16 && istMinute <= 15 * 60 + 30;
  const feedStale = Boolean(checkedAt != null && marketHours && state.running && state.lastCandle != null && checkedAt - (state.lastCandle + 60) > 180);

  if (selected === "PRIMARY_STRATEGY") {
    return (
      <div className="space-y-3">
        <StrategySelector data={data} selected={selected} onSelect={select} onData={apply} />
        <PrimaryPanel data={data} onData={apply} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <StrategySelector data={data} selected={selected} onSelect={select} onData={apply} />
      <div className="flex items-center gap-2">
        <span className={cx("shrink-0 whitespace-nowrap rounded-pill px-2 py-0.5 text-micro font-semibold", status.tone)} role="status">{status.label}</span>
        <span className="min-w-0 truncate text-micro text-muted">{data.config.underlying} · 1m · {data.config.mode === "PAPER" ? "Paper" : data.config.mode === "REPLAY" ? "Chart replay" : "Live"}</span>
        <button type="button" className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted hover:bg-hover hover:text-text" onClick={() => setHistoryOpen(true)}><History className="h-3.5 w-3.5" aria-hidden />Log</button>
      </div>
      {error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{error}</p> : null}
      {state.recovery ? (
        <div className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">
          <p>{state.recovery}</p>
          {!state.pending && !position?.exit ? <button type="button" className="mt-1 font-semibold underline" onClick={() => void run("ack", { action: "acknowledge" })}>Acknowledge</button> : null}
        </div>
      ) : null}
      {state.riskLocked ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss">Daily loss limit reached: new entries are blocked for today.</p> : null}

      {/* Mode and session controls */}
      <div className="grid gap-1.5 rounded-md border border-border-soft bg-sunken/50 p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted">Execution mode</span>
          <select className="compact-field w-[9.5rem]" aria-label="Execution mode" value={draft.mode} disabled={state.running} onChange={(event) => set({ mode: event.target.value as AlgoConfig["mode"] })}>
            <option value="PAPER">Paper trading</option>
            <option value="REPLAY">Chart replay (demo wallet)</option>
            <option value="LIVE" disabled>Live trading (unavailable)</option>
          </select>
        </div>
        <details className="text-micro text-muted">
          <summary className="cursor-pointer">Why is live trading unavailable?</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{data.live.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </details>
        {paper ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {!state.running ? (
              <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={Boolean(busy) || dirty || data.problems.length > 0} onClick={() => void run("start", { action: "start" })}><Play className="h-3.5 w-3.5" aria-hidden />Start session</button>
            ) : (
              <>
                <button type="button" className="h-8 rounded-md border border-border px-2.5 font-medium hover:bg-hover disabled:opacity-50" disabled={Boolean(busy)} onClick={() => void run("entries", { action: "entries", enabled: !state.entries })}>{state.entries ? "Disable new entries" : "Enable new entries"}</button>
                <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 font-medium hover:bg-hover disabled:opacity-50" disabled={Boolean(busy) || Boolean(position)} title={position ? "Exit the open position first" : undefined} onClick={() => void run("stop", { action: "stop" })}><Square className="h-3.5 w-3.5" aria-hidden />Stop session</button>
              </>
            )}
            {position ? <Confirm label="Exit position" confirm="Confirm exit" disabled={Boolean(busy) || Boolean(position.exit)} onConfirm={() => void run("exit", { action: "exit" })} /> : null}
            {state.running || position ? <Confirm label={<><OctagonX className="h-3.5 w-3.5" aria-hidden />Emergency stop</>} confirm="Confirm emergency stop" danger disabled={Boolean(busy)} onConfirm={() => void run("emergency", { action: "emergency" })} /> : null}
          </div>
        ) : null}
        {dirty && paper && !state.running ? <p className="text-micro text-warning">Save the settings before starting.</p> : null}
        {paper ? <p className="text-micro leading-snug text-muted">{data.monitoring}</p> : null}
      </div>

      {/* Live readouts */}
      <div className="rounded-md border border-border-soft bg-sunken/50 p-2">
        <p className="eyebrow mb-1">Algo account</p>
        <AlgoAccountFigures account={data.account} compact extra={[["Entries today", `${state.tradesToday} / ${data.config.maxTrades}`]]} />
        {data.account.legacyPosition ? <p className="mt-1 text-micro text-warning">An earlier algo position is still on the options paper account. It is protected and closed there; new entries start on this account once it is flat.</p> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2">
        <Info label="Last candle" text={clock(state.lastCandle)} />
        {paper && state.running ? <Info label="Feed" text={feedStale ? "Stale: no new candle" : "Updating"} tone={feedStale ? "text-warning" : "text-profit"} /> : null}
        <div className="col-span-2 min-w-0">
          <dt className="text-micro text-muted">Last signal</dt>
          <dd className="text-data leading-snug text-text-2">{state.lastSignal ? `${clock(state.lastSignal.time)} · ${state.lastSignal.explanation}` : "None yet"}</dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-micro text-muted">Last order</dt>
          <dd className="text-data leading-snug text-text-2">{state.lastOrder ? state.lastOrder.message : "None yet"}</dd>
        </div>
      </dl>

      {paper ? <MarketPlanSection date={today} /> : null}

      {/* Live paper: the same market analysis, strategies and confirmations as the replay dashboard. */}
      {paper && (state.running || state.analysis) ? (
        <>
          <MathiStatus state={state} config={data.config} mode="Live-price paper trading" now={checkedAt ?? state.analysis?.asOf ?? null} />
          <EngineCard state={state} config={data.config} date={state.sessionDate} now={checkedAt ?? state.analysis?.asOf ?? null} unrealized={data.position?.unrealized ?? null} />
          <MarketAnalysisSection analysis={state.analysis} symbol={data.config.underlying} time={state.analysis?.asOf ?? null} />
          <StrategyRows analysis={state.analysis} />
          {!position ? <p className="text-micro font-semibold text-text-2" role="status">{waitingMessage(state.analysis, state.tradesToday, data.config.maxTrades)}</p> : null}
        </>
      ) : null}

      {position ? (
        <div className="rounded-md border border-profit/30 bg-profit-soft/40 p-2">
          <p className="font-semibold">ATM {position.side} {position.contract.strike} · {position.contract.expiry} <span className="text-micro font-normal text-muted">(simulated)</span></p>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            <Info label="Quantity" text={`${position.quantity} (${position.lots} lot${position.lots === 1 ? "" : "s"})`} />
            <Info label="Average entry" text={inr(position.avg)} />
            <Info label="Current bid" text={inr(position.bid)} />
            <Info label="Unrealized" text={inr(position.unrealized)} tone={(position.unrealized ?? 0) >= 0 ? "text-profit" : "text-loss"} />
            <Info label="Stop-loss" text={position.stop > 0 ? inr(position.stop) : "None"} />
            <Info label="Target" text={inr(position.target)} />
            <Info label="Exit status" text={position.exit ? `Exiting (${position.exit.reason})` : "Protected by TradeD checks"} />
          </dl>
          <p className="eyebrow mb-1 mt-2">Intratrade confirmations</p>
          <ConfirmationList confirmations={state.confirmations ?? null} />
        </div>
      ) : null}

      {/* Settings */}
      <details className="rounded-md border border-border-soft" open={!state.running}>
        <summary className="cursor-pointer px-2 py-1.5 font-medium text-text-2">Settings</summary>
        <div className="space-y-1.5 border-t border-border-soft p-2">
          <Field label="Underlying">
            <input className="compact-field w-[9.5rem] uppercase" list="algo-underlyings" value={draft.underlying} disabled={state.running} onChange={(event) => set({ underlying: event.target.value.toUpperCase().replace(/[^A-Z0-9&_-]/g, "") })} />
            <datalist id="algo-underlyings">{["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", chartSymbol].filter((item, index, list) => item && list.indexOf(item) === index).map((item) => <option key={item} value={item} />)}</datalist>
          </Field>
          <Field label="Signal timeframe"><span className="w-[9.5rem] text-right text-text-2">1 minute (completed)</span></Field>
          <Field label="Expiry">
            <input type="date" className="compact-field w-[9.5rem]" aria-label="Expiry (empty = nearest)" value={draft.expiry === "nearest" ? "" : draft.expiry} onChange={(event) => set({ expiry: event.target.value || "nearest" })} />
          </Field>
          <p className="text-right text-micro text-muted">{draft.expiry === "nearest" ? "Nearest valid expiry" : "Fixed expiry"}</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2" aria-label="Mathi Strategy summary">
            <Info label="Strategy" text="Mathi Strategy" />
            <Info label="Entry signals" text="Enabled line breakouts / breakdowns" />
            <Info label="Body confirmation" text={draft.crossPercent ? `${draft.crossPercent}% of the body` : "Any body crossing"} />
            <Info label="Breakout confirmation" text={CONFIRMATION_TEXT[confirmationMode(draft)]} />
            <Info label="Entry cutoff" text={draft.entryCutoff >= "15:30" ? "None" : `${draft.entryCutoff} IST`} />
            <Info label="Stop-loss" text={draft.stopLoss === false ? "Disabled" : "On"} />
            <Info label="Profit target" text={`${draft.target.value}% of option premium`} />
            <Info label="Maximum trades" text={`${draft.maxTrades} per session`} />
            <Info label="Underlying · timeframe" text={`${draft.underlying} · 1 minute`} />
            <Info label="Trading mode" text={draft.mode === "REPLAY" ? "Chart replay" : draft.mode === "PAPER" ? "Live-price paper trading" : "Live"} />
          </dl>
          <p className="eyebrow pt-2">Trading window (IST)</p>
          <Field label="Entries from"><input type="time" className="compact-field w-[9.5rem]" aria-label="Entries from" value={draft.entryStart} min="09:15" max="15:29" onChange={(event) => set({ entryStart: event.target.value || "09:15" })} /></Field>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Entry cutoff</span><input type="checkbox" className="oc-check" aria-label="Use an entry cutoff" checked={draft.entryCutoff < "15:30"} onChange={(event) => set({ entryCutoff: event.target.checked ? "14:30" : "15:30" })} /></label>
          {draft.entryCutoff < "15:30" ? <Field label="No new entries after"><input type="time" className="compact-field w-[9.5rem]" aria-label="No new entries after" value={draft.entryCutoff} min="09:16" max="15:29" onChange={(event) => set({ entryCutoff: event.target.value || "15:30" })} /></Field> : <p className="text-right text-micro text-muted">None: entries until the session closes</p>}
          <p className="text-micro text-muted">A line breakout is taken as soon as it is confirmed — at 09:17 if that is when it appears. No new entries after the window.</p>
          <p className="eyebrow pt-2">Entry: strategy-line breakouts</p>
          <p className="text-micro text-muted">Mathi Strategy trades only the enabled strategy lines (below): ATM CE when a bullish candle that opened at or below a line closes above it, ATM PE when a bearish candle that opened at or above a line closes below it. A wick never counts. W / M, bounce / rejection, trendline and opening-range signals are not used.</p>
          <Field label="Body past the line (%)"><NumberInput value={draft.crossPercent} step={5} min={0} onChange={(crossPercent) => set({ crossPercent })} /></Field>
          <p className="text-micro text-muted">{draft.crossPercent ? `At least ${draft.crossPercent}% of the candle's body must be past the line.` : "0 = any genuine crossing: the body opens at or before the line and closes past it, by any amount (e.g. 7 points). A wick alone never counts."}</p>
          <p className="eyebrow pt-2">Breakout confirmation (false-breakout filter)</p>
          <Field label="Confirmation">
            <select className="compact-field w-[9.5rem]" aria-label="Breakout confirmation" value={confirmationMode(draft)} onChange={(event) => set({ filters: { ...draft.filters, secondCandle: false }, confirmation: { ...draft.confirmation, mode: event.target.value as ConfirmationMode } })}>
              <option value="hold">Breakout hold</option>
              <option value="retest">Retest</option>
              <option value="single">Single candle</option>
            </select>
          </Field>
          <p className="text-micro text-muted">{CONFIRMATION_HELP[confirmationMode(draft)]}</p>
          {confirmationMode(draft) === "hold" ? (
            <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Confirming candle must move with the break</span><input type="checkbox" className="oc-check" aria-label="Confirming candle must move with the break" checked={draft.confirmation.holdMustAgree !== false} onChange={(event) => set({ confirmation: { ...draft.confirmation, holdMustAgree: event.target.checked } })} /></label>
          ) : null}
          {confirmationMode(draft) === "retest" ? (
            <>
              <Field label="Retest window (min)"><NumberInput value={draft.confirmation.retestWindowMinutes} step={1} min={2} onChange={(retestWindowMinutes) => set({ confirmation: { ...draft.confirmation, retestWindowMinutes } })} /></Field>
              <Field label="Retest tolerance (%)"><NumberInput value={draft.confirmation.retestTolerancePercent} step={0.01} min={0} onChange={(retestTolerancePercent) => set({ confirmation: { ...draft.confirmation, retestTolerancePercent } })} /></Field>
              <p className="text-micro text-muted">A candle within {draft.confirmation.retestTolerancePercent}% of the line (about {Math.round(22_500 * draft.confirmation.retestTolerancePercent) / 100} points on NIFTY 22,500) counts as its retest.</p>
            </>
          ) : null}
          <Field label="Breakout buffer (%)"><NumberInput value={draft.filters.breakoutBufferPercent} step={0.01} min={0} onChange={(breakoutBufferPercent) => set({ filters: { ...draft.filters, breakoutBufferPercent } })} /></Field>
          <p className="text-micro text-muted">{draft.filters.breakoutBufferPercent ? `The close must be at least ${draft.filters.breakoutBufferPercent}% beyond the line (the signal and the hold).` : "0 = off: any close beyond the line counts."}</p>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Momentum must agree (9 / 21 EMA)</span><input type="checkbox" className="oc-check" aria-label="Momentum filter" checked={draft.filters.momentum} onChange={(event) => set({ filters: { ...draft.filters, momentum: event.target.checked } })} /></label>
          <p className="text-micro text-muted">On by default. A CALL needs the 9 EMA above the 21 EMA and a PUT below; a rejection says so.</p>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Enter while the candle forms (live paper)</span><input type="checkbox" className="oc-check" aria-label="Enter while the candle forms" checked={draft.intrabar} disabled={confirmationMode(draft) !== "single"} onChange={(event) => set({ intrabar: event.target.checked })} /></label>
          <p className="text-micro text-muted">{confirmationMode(draft) === "single" ? "Live-price paper only, when the data feed provides the forming candle; once per candle. Replay uses 1-minute candles." : "Not used with breakout confirmation: a breakout is confirmed on completed candles only."}</p>

          <p className="eyebrow pt-2">Quantity, target and limits</p>
          <Field label="Position size">
            <select className="compact-field w-[9.5rem]" aria-label="Position size" value={draft.sizing === "capital" ? "capital" : "fixed"} onChange={(event) => set({ sizing: event.target.value === "capital" ? "capital" : "fixed", lots: event.target.value === "capital" ? 50 : 1 })}>
              <option value="capital">By capital</option>
              <option value="fixed">Fixed lots</option>
            </select>
          </Field>
          {draft.sizing === "capital" ? (
            <>
              <Field label="Capital Allocation (%)"><NumberInput value={draft.allocation.percent} step={5} min={1} onChange={(percent) => set({ allocation: { ...draft.allocation, percent } })} /></Field>
              <Field label="Maximum Capital (₹)"><NumberInput value={draft.allocation.maxCapital} step={10_000} min={1_000} onChange={(maxCapital) => set({ allocation: { ...draft.allocation, maxCapital } })} /></Field>
              <Field label="If unaffordable">
                <select className="compact-field w-[9.5rem]" aria-label="Unaffordable order policy" value={draft.allocation.policy} onChange={(event) => set({ allocation: { ...draft.allocation, policy: event.target.value === "reject" ? "reject" : "reduce" } })}>
                  <option value="reduce">Buy affordable lots</option>
                  <option value="reject">Skip the trade</option>
                </select>
              </Field>
              <Field label="Max lots per trade"><NumberInput value={draft.lots} step={1} min={1} onChange={(lots) => set({ lots })} /></Field>
              <p className="text-micro text-muted">Each trade buys the most whole lots whose premium and entry charges fit {draft.allocation.percent}% of ₹{Number.isFinite(draft.allocation.maxCapital) ? draft.allocation.maxCapital.toLocaleString("en-IN") : "—"} and the cash actually available (rounded down, never a part lot).</p>
            </>
          ) : (
            <Field label="Quantity (lots)"><NumberInput value={draft.lots} step={1} min={1} onChange={(lots) => set({ lots })} /></Field>
          )}
          <Field label="Target (% of premium)"><NumberInput value={draft.target.value} step={0.5} min={0.5} onChange={(value) => set({ target: { mode: "percent", value } })} /></Field>
          <p className="text-micro text-muted">Exit when the option&apos;s own premium reaches its entry price + {Number.isFinite(draft.target.value) ? draft.target.value : "—"}% (₹100 → ₹{Number.isFinite(draft.target.value) ? (100 * (1 + draft.target.value / 100)).toFixed(2) : "—"}). Net P&amp;L is lower after charges and slippage.</p>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Exit if NIFTY closes back through the line</span><input type="checkbox" className="oc-check" aria-label="Exit when the index closes back through the broken line" checked={draft.structureStop} onChange={(event) => set({ structureStop: event.target.checked })} /></label>
          <p className="text-micro text-muted"><strong className="text-text-2">No premium stop-loss.</strong> {draft.structureStop ? "A Mathi trade exits at its target, when a completed candle closes back through the line it broke (the setup failed), when you exit it, or at the session end." : "A Mathi trade exits only at its target, when you exit it, or at the session end."}</p>
          <Field label="Max trades / session"><NumberInput value={draft.maxTrades} step={1} min={1} onChange={(maxTrades) => set({ maxTrades })} /></Field>
          <p className="text-micro text-muted">Successful entries count (a closed trade still counts; a rejected order does not). At the limit new entries stop until the next session; an open trade is still managed to its target.</p>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Pause the replay at the limit</span><input type="checkbox" className="oc-check" aria-label="Pause the replay at the trade limit" checked={draft.stopAtLimit} onChange={(event) => set({ stopAtLimit: event.target.checked })} /></label>
          <Field label="Max daily loss (₹)"><NumberInput value={draft.maxDailyLoss} step={500} min={1} onChange={(maxDailyLoss) => set({ maxDailyLoss })} /></Field>
          <p className="text-micro text-muted">No daily profit target: each trade has its own +{draft.target.value}% target on its own entry premium, and up to {draft.maxTrades} entries are taken whatever the day&apos;s P&amp;L.</p>
          <Field label="Max open positions"><span className="w-[9.5rem] text-right text-text-2">1 (one per underlying)</span></Field>
          <Field label="Cooldown (minutes)"><NumberInput value={draft.cooldownMinutes} step={1} min={0} onChange={(cooldownMinutes) => set({ cooldownMinutes })} /></Field>
          <Field label="Opposite signal">
            <select className="compact-field w-[9.5rem]" value={draft.opposingPolicy} onChange={(event) => set({ opposingPolicy: event.target.value === "exit-first" ? "exit-first" : "ignore" })}>
              <option value="ignore">Ignore while open</option>
              <option value="exit-first">Exit first, then wait</option>
            </select>
          </Field>

          <p className="eyebrow pt-2">Execution safeguards</p>
          <Field label="ATM rounding">
            <select className="compact-field w-[9.5rem]" value={draft.rounding} onChange={(event) => set({ rounding: event.target.value as AlgoConfig["rounding"] })}>
              <option value="nearest">Nearest strike</option>
              <option value="down">At or below price</option>
              <option value="up">At or above price</option>
            </select>
          </Field>
          <Field label="Max bid/ask spread (%)"><NumberInput value={draft.maxSpreadPercent} step={0.5} min={0.5} onChange={(maxSpreadPercent) => set({ maxSpreadPercent })} /></Field>
          <Field label="Max quote age (s)"><NumberInput value={draft.maxQuoteAgeSeconds} step={5} min={5} onChange={(maxQuoteAgeSeconds) => set({ maxQuoteAgeSeconds })} /></Field>
          <Field label="Paper slippage (ticks)"><NumberInput value={draft.slippageTicks} step={1} min={0} onChange={(slippageTicks) => set({ slippageTicks })} /></Field>
          {dirty ? (
            <div className="flex gap-1.5 pt-1">
              <button type="button" className="h-8 flex-1 rounded-md bg-primary font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={Boolean(busy)} onClick={() => void run("save", { action: "save", config: draft })}>{busy === "save" ? "Saving…" : "Save settings"}</button>
              <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => setDraft(data.config)}>Undo changes</button>
            </div>
          ) : null}
        </div>
      </details>

      {/* Lines that take part in signals */}
      <details className="rounded-md border border-border-soft">
        <summary className="cursor-pointer px-2 py-1.5 font-medium text-text-2">Strategy lines ({LINE_TYPES.length - draft.disabledLines.filter((type) => type !== "custom").length}/{LINE_TYPES.length} on)</summary>
        <div className="space-y-1 border-t border-border-soft p-2">
          {data.levelsMessage ? <p className="text-micro text-muted">{data.levelsMessage}</p> : null}
          {LINE_TYPES.map((item) => {
            const line = data.lines.find((candidate) => candidate.type === item.type);
            const on = !draft.disabledLines.includes(item.type);
            return (
              <label key={item.type} className="flex cursor-pointer items-center gap-1.5 text-text-2">
                <input type="checkbox" className="oc-check" checked={on} onChange={(event) => set({ disabledLines: event.target.checked ? draft.disabledLines.filter((type) => type !== item.type) : [...draft.disabledLines, item.type as LineType] })} />
                <span className="min-w-0 flex-1 truncate" title={item.label}>{item.label}</span>
                <span className="num shrink-0 text-micro text-muted">{line ? inr(line.price) : "not yet known"}</span>
              </label>
            );
          })}
          <p className="eyebrow pt-1">Extra levels</p>
          {draft.custom.map((level, index) => (
            <div key={level.id} className="flex items-center gap-1.5">
              <input className="compact-field min-w-0 flex-1" placeholder="Label" value={level.label} onChange={(event) => set({ custom: draft.custom.map((item, at) => (at === index ? { ...item, label: event.target.value } : item)) })} />
              <input type="number" step="0.05" className="compact-field w-24" placeholder="Price" value={Number.isFinite(level.price) ? level.price : ""} onChange={(event) => set({ custom: draft.custom.map((item, at) => (at === index ? { ...item, price: Number(event.target.value) } : item)) })} />
              <button type="button" aria-label="Remove level" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-loss" onClick={() => set({ custom: draft.custom.filter((_, at) => at !== index) })}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
            </div>
          ))}
          {draft.custom.length < 12 ? <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-primary hover:bg-hover" style={{ color: "var(--primary)" }} onClick={() => set({ custom: [...draft.custom, { id: `level-${Date.now().toString(36)}`, label: "", price: NaN }] })}><Plus className="h-3.5 w-3.5" aria-hidden />Add level</button> : null}
          <p className="text-micro text-muted">Changes apply after Save settings.</p>
        </div>
      </details>

      <MultiDayBacktest disabled={dirty ? "Save the settings first: the backtest uses your saved settings." : data.problems.length ? data.problems.join(" ") : null} />

      {/* Historical replay */}
      {draft.mode === "REPLAY" ? (
        <div className="space-y-1.5 rounded-md border border-border-soft bg-sunken/50 p-2">
          <p className="text-micro leading-snug text-text-2">To trade a replay: open Replay on the chart, turn on <strong>Enable Algo</strong> in the Algo panel beside the chart and press Play. Each Play asks you to confirm. Orders use the ₹1,00,000 demo wallet, so they appear in Portfolio and Home.</p>
          <p className="eyebrow pt-1">Quick backtest</p>
          <p className="text-micro leading-snug text-muted">Runs a whole past session at once with the saved settings: the underlying&apos;s real 1-minute candles and each option&apos;s real 1-minute premiums. A separate virtual account is used; nothing is written to the demo wallet and no order is sent anywhere.</p>
          <div className="flex items-center gap-1.5">
            <input type="date" className="compact-field flex-1" aria-label="Replay date" value={replayDate} max={yesterday} onChange={(event) => setReplayDate(event.target.value)} />
            <button type="button" className="h-8 rounded-md bg-primary px-3 font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={!replayDate || Boolean(busy) || dirty} onClick={() => void run("replay", { action: "replay", date: replayDate })}>{busy === "replay" ? "Running…" : "Run backtest"}</button>
          </div>
          {data.replay ? <ReplaySummary events={data.replay.events} onOpen={() => setHistoryOpen(true)} /> : null}
        </div>
      ) : null}

      {historyOpen ? <AlgoHistory data={data} onClose={() => setHistoryOpen(false)} /> : null}
    </div>
  );
}

function ReplaySummary({ events, onOpen }: { events: AlgoData["events"]; onOpen: () => void }) {
  const exits = events.filter((event) => event.kind === "EXIT");
  const entries = events.filter((event) => event.kind === "ENTRY");
  const pnl = exits.reduce((sum, event) => sum + (event.pnl ?? 0), 0);
  const signals = events.filter((event) => event.evaluation?.decision === "CALL" || event.evaluation?.decision === "PUT").length;
  return (
    <div className="rounded-md border border-border-soft p-2">
      <p className="text-micro text-muted">{events[0]?.message}</p>
      <dl className="mt-1 grid grid-cols-3 gap-2">
        <Info label="Signals" text={String(signals)} />
        <Info label="Trades" text={String(entries.length)} />
        <Info label="Net P&L" text={inr(Math.round(pnl * 100) / 100)} tone={pnl >= 0 ? "text-profit" : "text-loss"} />
      </dl>
      <button type="button" className="mt-1 text-micro font-semibold" style={{ color: "var(--primary)" }} onClick={onOpen}>Open the backtest log</button>
    </div>
  );
}

/** A consequential action needs a second press within a few seconds. */
function Confirm({ label, confirm, onConfirm, disabled, danger }: { label: React.ReactNode; confirm: string; onConfirm: () => void; disabled?: boolean; danger?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={disabled}
      className={cx("inline-flex h-8 items-center gap-1 rounded-md border px-2.5 font-medium disabled:opacity-50", armed || danger ? "border-loss/50 text-loss hover:bg-loss-soft" : "border-border hover:bg-hover")}
      style={armed || danger ? { color: "var(--loss)" } : undefined}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
    >
      {armed ? confirm : label}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex min-h-7 items-center justify-between gap-2"><span className="min-w-0 truncate text-muted" title={label}>{label}</span>{children}</div>;
}

export function NumberInput({ value, step, min, onChange }: { value: number; step: number; min: number; onChange: (value: number) => void }) {
  return <input type="number" className="compact-field w-[9.5rem] text-right" value={Number.isFinite(value) ? value : ""} step={step} min={min} onChange={(event) => onChange(event.target.value === "" ? NaN : Number(event.target.value))} />;
}

export function Info({ label, text, tone }: { label: string; text: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className={cx("num truncate text-data font-medium text-text", tone)}>{text}</dd>
    </div>
  );
}
