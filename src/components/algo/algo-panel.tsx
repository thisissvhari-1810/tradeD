"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, OctagonX, Play, Plus, Square, Trash2 } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { AlgoHistory } from "@/components/algo/algo-history";
import { AlgoAccountFigures } from "@/components/algo/algo-account";
import { ConfirmationList, MarketAnalysisSection, StrategyRows, waitingMessage } from "@/components/algo/algo-analysis";
import { MultiDayBacktest } from "@/components/algo/algo-backtest";
import { announceSaved, announceUnsaved } from "@/components/algo/algo-settings-sync";
import { STRATEGY_IDS, STRATEGY_LABEL } from "@/lib/algo/patterns";
import { LINE_TYPES, type LineType } from "@/lib/algo/lines";
import type { AlgoConfig, AlgoStatus } from "@/lib/algo/runner";
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
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [replayDate, setReplayDate] = useState("");
  // The time of the last tick (for the feed's staleness); set by the tick, never read from the clock while rendering.
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [yesterday] = useState(() => new Date(Date.now() + 19_800_000 - 86_400_000).toISOString().slice(0, 10));
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

  return (
    <div className="space-y-3">
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

      {/* Live paper: the same market analysis, strategies and confirmations as the replay dashboard. */}
      {paper && (state.running || state.analysis) ? (
        <>
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
            <Info label="Stop-loss" text={inr(position.stop)} />
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
          <Field label="Quantity (lots)"><NumberInput value={draft.lots} step={1} min={1} onChange={(lots) => set({ lots })} /></Field>
          <Protect label="Stop-loss" value={draft.stop} onChange={(stop) => set({ stop })} />
          <Protect label="Target" value={draft.target} onChange={(target) => set({ target })} />
          <Field label="Max daily loss (₹)"><NumberInput value={draft.maxDailyLoss} step={500} min={1} onChange={(maxDailyLoss) => set({ maxDailyLoss })} /></Field>
          <Field label="Max trades / session"><NumberInput value={draft.maxTrades} step={1} min={1} onChange={(maxTrades) => set({ maxTrades })} /></Field>
          <Field label="Max open positions"><span className="w-[9.5rem] text-right text-text-2">1 (one per underlying)</span></Field>
          <Field label="Cooldown (minutes)"><NumberInput value={draft.cooldownMinutes} step={1} min={0} onChange={(cooldownMinutes) => set({ cooldownMinutes })} /></Field>
          <Field label="Opposite signal">
            <select className="compact-field w-[9.5rem]" value={draft.opposingPolicy} onChange={(event) => set({ opposingPolicy: event.target.value === "exit-first" ? "exit-first" : "ignore" })}>
              <option value="ignore">Ignore while open</option>
              <option value="exit-first">Exit first, then wait</option>
            </select>
          </Field>
          <Field label="Conflicting signals"><span className="w-[9.5rem] text-right text-text-2">No entry</span></Field>
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
          <Field label="No entries after (IST)"><input type="time" className="compact-field w-[9.5rem]" value={draft.entryCutoff} min="09:16" max="15:29" onChange={(event) => set({ entryCutoff: event.target.value || "15:00" })} /></Field>
          <p className="eyebrow pt-2">Strategies</p>
          {STRATEGY_IDS.map((id) => (
            <label key={id} className="flex min-h-7 cursor-pointer items-center justify-between gap-2">
              <span className="text-muted">{STRATEGY_LABEL[id]}</span>
              <input type="checkbox" className="oc-check" aria-label={`${STRATEGY_LABEL[id]} strategy`} checked={draft.strategies[id]} onChange={(event) => set({ strategies: { ...draft.strategies, [id]: event.target.checked } })} />
            </label>
          ))}
          <Field label="Observation (minutes)"><NumberInput value={draft.observationMinutes} step={1} min={0} onChange={(observationMinutes) => set({ observationMinutes })} /></Field>
          <p className="text-micro text-muted">No new entries in the first {Number.isFinite(draft.observationMinutes) ? draft.observationMinutes : "—"} minutes after 09:15: the opening is analysed only.</p>
          <p className="eyebrow pt-2">Trade filters</p>
          <Field label="Breakout buffer (%)"><NumberInput value={draft.filters.breakoutBufferPercent} step={0.01} min={0} onChange={(breakoutBufferPercent) => set({ filters: { ...draft.filters, breakoutBufferPercent } })} /></Field>
          <p className="text-micro text-muted">A line break counts only when the candle body crosses the line and closes at least this far beyond it (0.03% ≈ 7 NIFTY points).</p>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Second-candle confirmation</span><input type="checkbox" className="oc-check" aria-label="Second-candle confirmation" checked={draft.filters.secondCandle} onChange={(event) => set({ filters: { ...draft.filters, secondCandle: event.target.checked } })} /></label>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Momentum must agree (9 / 21 EMA)</span><input type="checkbox" className="oc-check" aria-label="Momentum filter" checked={draft.filters.momentum} onChange={(event) => set({ filters: { ...draft.filters, momentum: event.target.checked } })} /></label>
          <Field label="Block a level after a stop (min)"><NumberInput value={draft.filters.levelBlockMinutes} step={5} min={0} onChange={(levelBlockMinutes) => set({ filters: { ...draft.filters, levelBlockMinutes } })} /></Field>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Structure stop (index back through the level)</span><input type="checkbox" className="oc-check" aria-label="Structure stop" checked={draft.structureStop} onChange={(event) => set({ structureStop: event.target.checked })} /></label>
          <p className="eyebrow pt-2">Trendline / W / M settings</p>
          <Field label="Swing sensitivity (candles)"><NumberInput value={draft.patterns.pivotStrength} step={1} min={1} onChange={(pivotStrength) => set({ patterns: { ...draft.patterns, pivotStrength } })} /></Field>
          <Field label="Min. bottoms / tops apart"><NumberInput value={draft.patterns.minSeparation} step={1} min={2} onChange={(minSeparation) => set({ patterns: { ...draft.patterns, minSeparation } })} /></Field>
          <Field label="Max. lows / highs gap (%)"><NumberInput value={draft.patterns.tolerancePercent} step={0.05} min={0.01} onChange={(tolerancePercent) => set({ patterns: { ...draft.patterns, tolerancePercent } })} /></Field>
          <Field label="Min. breakout beyond (%)"><NumberInput value={draft.patterns.minBreakPercent} step={0.01} min={0} onChange={(minBreakPercent) => set({ patterns: { ...draft.patterns, minBreakPercent } })} /></Field>
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Wait for a retest</span><input type="checkbox" className="oc-check" aria-label="Retest mode" checked={draft.patterns.retest} onChange={(event) => set({ patterns: { ...draft.patterns, retest: event.target.checked } })} /></label>
          {draft.patterns.retest ? <Field label="Retest window (candles)"><NumberInput value={draft.patterns.retestBars} step={1} min={1} onChange={(retestBars) => set({ patterns: { ...draft.patterns, retestBars } })} /></Field> : null}
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Require breakout volume</span><input type="checkbox" className="oc-check" aria-label="Volume confirmation" checked={draft.patterns.volume} onChange={(event) => set({ patterns: { ...draft.patterns, volume: event.target.checked } })} /></label>
          {draft.patterns.volume ? <p className="text-micro text-muted">Applied only when the feed has volume (index candles usually do not); otherwise shown as unavailable.</p> : null}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex min-h-7 items-center justify-between gap-2"><span className="min-w-0 truncate text-muted" title={label}>{label}</span>{children}</div>;
}

function NumberInput({ value, step, min, onChange }: { value: number; step: number; min: number; onChange: (value: number) => void }) {
  return <input type="number" className="compact-field w-[9.5rem] text-right" value={Number.isFinite(value) ? value : ""} step={step} min={min} onChange={(event) => onChange(event.target.value === "" ? NaN : Number(event.target.value))} />;
}

function Protect({ label, value, onChange }: { label: string; value: AlgoConfig["stop"]; onChange: (value: AlgoConfig["stop"]) => void }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <span className="min-w-0 truncate text-muted">{label}</span>
      <span className="flex w-[9.5rem] gap-1">
        <input type="number" className="compact-field min-w-0 flex-1 text-right" aria-label={`${label} value`} value={Number.isFinite(value.value) ? value.value : ""} step={value.mode === "percent" ? 1 : 0.5} min={0} onChange={(event) => onChange({ ...value, value: event.target.value === "" ? NaN : Number(event.target.value) })} />
        <select className="compact-field w-[4.25rem]" aria-label={`${label} unit`} value={value.mode} onChange={(event) => onChange({ ...value, mode: event.target.value === "points" ? "points" : "percent" })}>
          <option value="percent">% prem.</option>
          <option value="points">₹ prem.</option>
        </select>
      </span>
    </div>
  );
}

function Info({ label, text, tone }: { label: string; text: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className={cx("num truncate text-data font-medium text-text", tone)}>{text}</dd>
    </div>
  );
}
