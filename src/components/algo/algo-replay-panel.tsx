"use client";

import { useState, type ReactNode } from "react";
import { Bot, ChevronDown, History, OctagonX, Play } from "lucide-react";
import { cx } from "@/components/ui";
import { EXIT_LABEL } from "@/lib/algo/chart-replay";
import type { AlgoStatus } from "@/lib/algo/runner";
import type { ChartAlgo } from "@/components/algo/use-chart-algo";

const inr = (value: number | null | undefined, signed = false) => {
  if (value == null || !Number.isFinite(value)) return "—";
  const text = `₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return signed ? `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}` : value < 0 ? `−${text}` : text;
};
const ist = (seconds: number | null | undefined) => (seconds ? new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16) : "—");
const tone = (value: number | null | undefined) => (value == null ? "text-muted" : value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-text");

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

/**
 * The running algo order panel beside the replay chart: the switch, the open position with its live
 * replay P&L, stop-loss and target on the option's own premium, and the manual exit. Phones show it as a
 * collapsible section under the chart.
 */
export function AlgoReplayPanel({ algo, cursor, chartSymbol, onHistory }: { algo: ChartAlgo; cursor: number | null; chartSymbol: string; onHistory: () => void }) {
  // Phones start with the panel folded to its header (the chart keeps the screen); desktops show it open.
  const [open, setOpen] = useState(() => typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches);
  const [confirmExit, setConfirmExit] = useState(false);
  const [confirmEmergency, setConfirmEmergency] = useState(false);
  const data = algo.data;
  const run = algo.run;
  const position = run?.position ?? null;
  const replayMode = data?.config.mode === "REPLAY";
  const state = run?.state;
  const status: AlgoStatus = !algo.enabled && !position ? "DISABLED" : state?.status ?? (algo.enabled ? "READY" : "DISABLED");
  const badge = position?.exit ? BADGE.EXIT_PENDING! : BADGE[status] ?? BADGE.DISABLED!;
  const lastExit = [...(run?.events ?? [])].reverse().find((event) => event.kind === "EXIT");
  const wallet = data?.wallet;

  return (
    <aside className="flex min-h-0 shrink-0 flex-col border-border bg-panel text-data max-lg:max-h-[45dvh] max-lg:border-t lg:w-[19rem] lg:border-l" aria-label="Algo trading">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Bot className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="font-semibold">Algo</h2>
        <span className={cx("whitespace-nowrap rounded-pill px-2 py-0.5 text-micro font-semibold", badge.tone)} role="status">{badge.label}</span>
        <span className={cx("rounded-pill bg-demo-soft px-2 py-0.5 text-micro font-medium text-demo", position && !open && "max-lg:hidden")}>Simulated</span>
        {position && !open ? <span className={cx("num whitespace-nowrap font-semibold lg:hidden", tone(position.unrealized))}>{inr(position.unrealized, true)}</span> : null}
        <button type="button" aria-label="Algo session history" title="Session history" className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text" onClick={onHistory}><History className="h-4 w-4" aria-hidden /></button>
        <button type="button" aria-label={open ? "Collapse algo panel" : "Expand algo panel"} aria-expanded={open} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text lg:hidden" onClick={() => setOpen((value) => !value)}><ChevronDown className={cx("h-4 w-4 transition-transform", !open && "-rotate-90")} aria-hidden /></button>
      </header>
      <div className={cx("min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3", !open && "max-lg:hidden")}>
        {algo.error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{algo.error} <button type="button" className="ml-1 underline" onClick={algo.clearError}>Dismiss</button></p> : null}
        {!data ? <p className="text-micro text-muted">Loading the algo…</p> : null}

        {data && !replayMode ? (
          <div className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1.5 text-micro text-warning">
            <p>The Algo is set to {data.config.mode === "PAPER" ? "paper trading at live prices" : "live"}. Switch it to chart replay to trade this replay with the demo wallet.</p>
            <button type="button" className="mt-1 font-semibold underline" disabled={Boolean(algo.busy)} onClick={() => void algo.useReplayMode()}>Use chart replay mode</button>
          </div>
        ) : null}

        {data && replayMode ? (
          <label className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border-soft bg-sunken/50 px-2 py-1.5">
            <span>
              <span className="block font-medium">Enable Algo</span>
              <span className="block text-micro text-muted">{algo.enabled ? (run?.armed ? "Confirmed: trading this replay." : "Press Play to confirm and start.") : "Replay plays without trading."}</span>
            </span>
            <input type="checkbox" role="switch" className="oc-check" aria-label="Enable Algo for this replay" checked={algo.enabled} onChange={(event) => algo.setEnabled(event.target.checked)} />
          </label>
        ) : null}

        {data && replayMode && data.config.underlying !== chartSymbol ? (
          <p className="text-micro text-warning">The algo trades {data.config.underlying}; this chart shows {chartSymbol}. Its markers appear on the {data.config.underlying} chart.</p>
        ) : null}

        {position ? (
          <section className="rounded-md border border-border-soft p-2" aria-label="Open algo position">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-semibold">{position.side === "CALL" ? "CALL" : "PUT"} BUY · {position.contract.underlying} {position.contract.strike} {position.contract.right}</p>
              <span className="text-micro text-muted">exp {position.contract.expiry}</span>
            </div>
            <p className={cx("num mt-1 text-xl font-semibold leading-tight", tone(position.unrealized))}>{inr(position.unrealized, true)} <span className="text-data font-medium">{position.unrealizedPercent == null ? "" : `(${position.unrealizedPercent > 0 ? "+" : ""}${position.unrealizedPercent.toFixed(2)}%)`}</span></p>
            <p className="text-micro text-muted">Unrealized, after entry charges · premium as of {ist(position.premiumAt)} IST</p>
            <PremiumBar stop={position.stop} entry={position.avg} target={position.target} current={position.premium} />
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              <Item label="Entry premium" value={inr(position.avg)} />
              <Item label="Current premium" value={inr(position.premium)} />
              <Item label="Quantity" value={`${position.quantity} (${position.lots} × ${position.contract.lotSize})`} />
              <Item label="Entry time" value={`${ist(position.openedAt)} IST`} />
              <Item label="Invested" value={inr(position.invested)} />
              <Item label="Market value" value={inr(position.value)} />
              <Item label="Stop-loss" value={inr(position.stop)} tone="text-loss" hint={position.premium != null ? (position.premium <= position.stop ? "reached" : `${inr(position.premium - position.stop)} away`) : undefined} />
              <Item label="Target" value={inr(position.target)} tone="text-profit" hint={position.premium != null ? (position.premium >= position.target ? "reached" : `${inr(position.target - position.premium)} away`) : undefined} />
              <Item label="Time in trade" value={run ? `${Math.max(0, Math.round((run.processedThrough - position.openedAt) / 60))} min` : "—"} />
              <Item label="Replay time" value={`${ist(cursor)} IST`} />
            </dl>
            <button type="button" className="mt-2 h-9 w-full rounded-md bg-loss font-semibold text-on-signal hover:brightness-110 disabled:opacity-50" disabled={Boolean(algo.busy) || Boolean(position.exit) || cursor == null} onClick={() => setConfirmExit(true)}>
              {position.exit ? "Exit pending…" : algo.busy === "exit" ? "Exiting…" : "Exit Position"}
            </button>
          </section>
        ) : run ? (
          <section className="rounded-md border border-border-soft p-2 text-micro" aria-label="Latest algo activity">
            <p className="font-medium text-text-2">No open position</p>
            <p className="mt-1 text-muted">Last signal: {state?.lastSignal ? `${ist(state.lastSignal.time + 60)} · ${state.lastSignal.explanation}` : "none yet"}</p>
            <p className="mt-1 text-muted">Last order: {state?.lastOrder ? `${state.lastOrder.status} · ${state.lastOrder.message}` : "none yet"}</p>
            {lastExit ? <p className={cx("mt-1 font-medium", tone(lastExit.pnl))}>Last trade: {EXIT_LABEL[/^Exit \(([A-Z_]+)\)/.exec(lastExit.message)?.[1] ?? ""] ?? "Exit"} · {inr(lastExit.pnl, true)}</p> : null}
          </section>
        ) : data && replayMode ? (
          <p className="text-micro leading-snug text-muted">When enabled and confirmed, the algo checks each completed 1-minute candle of {data.config.underlying} against your Strategy lines. A body crossing down buys the ATM PUT, up buys the ATM CALL, priced from that contract&apos;s real 1-minute premium history at the replay time.</p>
        ) : null}

        {run ? (
          <dl className="grid grid-cols-3 gap-2 rounded-md border border-border-soft bg-sunken/50 p-2">
            <Item label="Trades" value={`${run.stats.trades} / ${run.config.maxTrades}`} />
            <Item label="Win / loss" value={`${run.stats.wins} / ${run.stats.losses}`} />
            <Item label="Realized" value={inr(run.stats.realized, true)} tone={tone(run.stats.realized)} />
          </dl>
        ) : null}

        {wallet ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft p-2">
            <Item label="Demo cash" value={inr(wallet.cash)} />
            <Item label="Starting capital" value={inr(wallet.startingCapital)} />
            {wallet.reserved ? <Item label="Reserved" value={inr(wallet.reserved)} /> : null}
          </dl>
        ) : null}

        {run && (run.armed || position) ? (
          <div className="flex flex-wrap gap-1.5">
            {run.armed ? <button type="button" className="h-8 rounded-md border border-border px-2.5 font-medium hover:bg-hover disabled:opacity-50" disabled={Boolean(algo.busy)} onClick={() => algo.setEnabled(false)}>Stop new entries</button> : null}
            <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-loss/50 px-2.5 font-medium text-loss hover:bg-loss-soft disabled:opacity-50" style={{ color: "var(--loss)" }} disabled={Boolean(algo.busy) || cursor == null} onClick={() => setConfirmEmergency(true)}><OctagonX className="h-3.5 w-3.5" aria-hidden />Emergency stop</button>
          </div>
        ) : null}
        <p className="text-micro leading-snug text-muted">Demo wallet only: fills come from historical 1-minute option data at the replay time and update Portfolio and Home. No broker order is ever sent from replay.</p>
      </div>

      {confirmExit && position ? (
        <Dialog title="Exit this position?" onClose={() => setConfirmExit(false)}>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <Item label="Contract" value={`${position.contract.underlying} ${position.contract.strike} ${position.contract.right} · ${position.contract.expiry}`} />
            <Item label="Quantity to close" value={String(position.quantity)} />
            <Item label="Current premium" value={inr(position.premium)} />
            <Item label="Estimated exit value" value={inr(position.value)} />
            <Item label="Unrealized P&L" value={inr(position.unrealized, true)} tone={tone(position.unrealized)} />
            <Item label="Stop-loss / target" value={`${inr(position.stop)} / ${inr(position.target)}`} />
          </dl>
          <p className="mt-3 text-micro text-muted">The exit fills at the last completed 1-minute premium at the replay time ({ist(cursor)} IST), less one tick of slippage per your settings, whether the replay is playing or paused. Minutes up to the replay time are checked first, so a stop-loss or target already reached is applied instead. Final realized P&amp;L includes charges and can differ from the estimate.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => setConfirmExit(false)}>Cancel</button>
            <button type="button" className="h-8 rounded-md bg-loss px-3 font-semibold text-on-signal disabled:opacity-50" disabled={Boolean(algo.busy) || cursor == null} onClick={() => { setConfirmExit(false); if (cursor != null) void algo.exit(cursor); }}>Confirm Exit</button>
          </div>
        </Dialog>
      ) : null}
      {confirmEmergency ? (
        <Dialog title="Emergency risk stop?" onClose={() => setConfirmEmergency(false)}>
          <p className="text-micro text-text-2">New algo entries stop immediately and {position ? "the open position is exited at the last completed premium at the replay time" : "no position is open"}. The replay itself keeps its place; you can turn the algo on again later.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => setConfirmEmergency(false)}>Cancel</button>
            <button type="button" className="h-8 rounded-md bg-loss px-3 font-semibold text-on-signal" onClick={() => { setConfirmEmergency(false); if (cursor != null) void algo.exit(cursor, true).then(() => algo.setEnabled(false)); }}>Stop now</button>
          </div>
        </Dialog>
      ) : null}
    </aside>
  );
}

/** Stop — entry — target on the option premium, with the current premium marked. */
function PremiumBar({ stop, entry, target, current }: { stop: number; entry: number; target: number; current: number | null }) {
  const span = target - stop;
  const at = (value: number) => `${Math.min(100, Math.max(0, ((value - stop) / span) * 100))}%`;
  return (
    <div className="mt-2" aria-label="Option premium against stop-loss and target">
      <div className="relative h-2 rounded-full bg-gradient-to-r from-loss/40 via-sunken to-profit/40">
        <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-text-2" style={{ left: at(entry) }} title={`Entry ₹${entry}`} />
        {current != null ? <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-primary" style={{ left: at(current) }} title={`Current ₹${current}`} /> : null}
      </div>
      <div className="mt-0.5 flex justify-between text-micro text-muted"><span>SL {stop.toFixed(2)}</span><span>Entry {entry.toFixed(2)}</span><span>TGT {target.toFixed(2)}</span></div>
    </div>
  );
}

function Item({ label, value, tone: color, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className={cx("num truncate font-medium text-text", color)} title={value}>{value}{hint ? <span className="ml-1 text-micro font-normal text-muted">{hint}</span> : null}</dd>
    </div>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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
  const config = data?.config;
  const run = algo.run;
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
  const rows: Array<[string, string]> = [
    ["Strategy", "Line body-cross"],
    ["Underlying", config.underlying],
    ["Signal timeframe", "1 minute (completed candles)"],
    ["Replay", `${date} from ${ist(cursor)} IST`],
    ["Replay speed", `${speed}x`],
    ["Demo cash", inr(data.wallet?.cash)],
    ["Quantity", `${config.lots} lot${config.lots === 1 ? "" : "s"} (ATM CALL / PUT)`],
    ["Stop-loss", config.stop.mode === "percent" ? `${config.stop.value}% of premium` : `₹${config.stop.value} below entry`],
    ["Target", config.target.mode === "percent" ? `${config.target.value}% of premium` : `₹${config.target.value} above entry`],
    ["Max daily loss", inr(config.maxDailyLoss)],
    ["Max trades", String(config.maxTrades)],
    ["Open position", position ? `${position.contract.strike} ${position.contract.right} × ${position.quantity}` : "None"],
  ];
  return (
    <Dialog title="Start Algo Trading Replay?" onClose={onCancel}>
      <p className="text-micro text-text-2">The strategy will monitor completed 1-minute candles and may automatically open ATM CALL or PUT demo positions when valid signals occur. Stop-loss and target rules will be monitored throughout the replay.</p>
      {ended ? <p className="mt-2 rounded-md bg-warning-soft px-2 py-1.5 text-micro text-warning">This replay session&apos;s algo run has ended ({run?.endReason === "SESSION_END" ? "session close" : "reset"}). Reset the replay to start a new isolated session.</p> : null}
      {gate.kind === "confirm" && gate.skippedMinutes > 0 ? <p className="mt-2 rounded-md bg-info-soft px-2 py-1.5 text-micro text-info">The replay moved forward {gate.skippedMinutes} minute{gate.skippedMinutes === 1 ? "" : "s"} since the algo last ran. Those minutes are processed in order first (signals, stop-loss and target), exactly as if the replay had played through them.</p> : null}
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {rows.map(([label, value]) => <Item key={label} label={label} value={value} />)}
      </dl>
      <p className="mt-3 rounded-md bg-demo-soft px-2 py-1.5 text-micro text-demo">Simulated trading on the demo wallet. Fills use historical 1-minute option premiums; nothing is sent to a broker.</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={onCancel}>Cancel</button>
        {ended ? <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={onReset}>Reset session</button> : null}
        <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 font-semibold text-on-primary disabled:opacity-50" disabled={Boolean(algo.busy) || ended} onClick={onStart}><Play className="h-3.5 w-3.5" aria-hidden />{algo.busy === "arm" ? "Starting…" : "Start Algo & Replay"}</button>
      </div>
    </Dialog>
  );
}
