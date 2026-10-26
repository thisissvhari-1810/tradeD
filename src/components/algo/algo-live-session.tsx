"use client";

import { useState } from "react";
import { Play, Square } from "lucide-react";
import { cx } from "@/components/ui";
import { LIMIT_NOTICE, LIVE_STATUS_LABEL, type LiveStatus } from "@/lib/algo/live-session";
import type { AlgoData } from "@/components/algo/algo-panel";

const TONE: Record<LiveStatus, string> = {
  STOPPED: "bg-sunken text-muted",
  RUNNING: "bg-primary-soft text-primary",
  POSITION_OPEN: "bg-profit-soft text-profit",
  POSITION_OPEN_STOPPED: "bg-warning-soft text-warning",
  LIMIT_REACHED: "bg-warning-soft text-warning",
  WAITING_FOR_DATA: "bg-warning-soft text-warning",
  ERROR: "bg-loss-soft text-loss",
};

const inr = (value: number | null | undefined) => (value == null ? "—" : `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const clock = (seconds: number | null | undefined) => (seconds ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(seconds * 1000)) : "—");
const pnlTone = (value: number | null | undefined) => (value == null || value === 0 ? undefined : value > 0 ? "text-profit" : "text-loss");

/** The current signal: a breakout waiting for its confirming candle, the latest candle's CALL / PUT, or none. */
function currentSignal(data: AlgoData, running: boolean): string {
  const { state } = data;
  if (!running) return "—";
  if (state.awaiting) return `WAITING (${state.awaiting.direction} setup)`;
  const last = state.lastSignal;
  if (last && state.lastCandle != null && last.time >= state.lastCandle && (last.decision === "CALL" || last.decision === "PUT")) return last.decision;
  return "NO SIGNAL";
}

/**
 * Mathi Strategy in live demo mode: the ON / OFF switch, the activation session's summary, the open trade and
 * the completed trades. Every figure is the server's (its stored state and order events); this only shows them
 * and sends ON / OFF — it never decides an entry or counts trades itself.
 */
export function LiveMathiSession({ data, busy, disabled, now, onStart, onStop }: { data: AlgoData; busy: boolean; disabled: boolean; now: number | null; onStart: () => void; onStop: () => void }) {
  const live = data.liveSession;
  const { activation, summary, trades } = live;
  const running = Boolean(activation && activation.endedAt == null && data.state.running);
  const position = data.position;
  const openTrade = trades.find((trade) => trade.status !== "COMPLETED") ?? null;
  const completed = trades.filter((trade) => trade.status === "COMPLETED");
  const holdLimit = data.config.maxHoldMinutes;

  // The limit notice is shown once per activation (dismissed for that session only).
  const noticeKey = activation?.limitNotified ? `tradeD:mathi-limit:${activation.id}` : null;
  // Mounted only after the algo has loaded in the browser, so storage can be read when the notice first shows.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const stored = (key: string) => {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  const showNotice = Boolean(noticeKey && !dismissed.includes(noticeKey) && !stored(noticeKey));
  const dismiss = () => {
    if (!noticeKey) return;
    setDismissed((list) => [...list, noticeKey]);
    try {
      window.localStorage.setItem(noticeKey, "1");
    } catch {
      // Storage unavailable: closed for this view only.
    }
  };

  return (
    <div className="space-y-2" aria-label="Mathi Strategy live demo">
      <div className="flex items-center gap-2 rounded-md border border-border-soft bg-sunken/50 p-2">
        <div className="min-w-0">
          <p className="font-semibold">Mathi Strategy <span className="text-micro font-normal text-muted">(live demo · simulated orders)</span></p>
          <span className={cx("mt-0.5 inline-block whitespace-nowrap rounded-pill px-2 py-0.5 text-micro font-semibold", TONE[live.status])} role="status">{LIVE_STATUS_LABEL[live.status]}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={running}
          aria-label="Mathi Strategy on or off"
          disabled={busy || (!running && disabled)}
          onClick={running ? onStop : onStart}
          className={cx("ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-3 font-semibold disabled:opacity-50", running ? "border border-border hover:bg-hover" : "bg-primary text-on-primary hover:bg-primary-hover")}
        >
          {running ? <><Square className="h-3.5 w-3.5" aria-hidden />Stop Strategy</> : <><Play className="h-3.5 w-3.5" aria-hidden />Turn ON</>}
        </button>
      </div>

      {showNotice ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-2 py-1.5 text-micro text-warning" role="status">
          <p className="flex-1 font-semibold">{LIMIT_NOTICE(summary.max)}</p>
          <button type="button" className="font-semibold underline" onClick={dismiss}>Dismiss</button>
        </div>
      ) : null}
      {live.status === "POSITION_OPEN_STOPPED" ? <p className="rounded-md bg-warning-soft px-2 py-1.5 text-micro font-semibold text-warning" role="alert">POSITION OPEN — STRATEGY STOPPED. No new entries; the open position is still managed by its exit rules until it closes. Use Exit position to close it now.</p> : null}
      {live.status === "WAITING_FOR_DATA" ? <p className="rounded-md bg-warning-soft px-2 py-1.5 text-micro text-warning" role="status">Waiting for market data: no new completed 1-minute candle for over 3 minutes. No entry is made from stale data.</p> : null}
      {live.carriedPosition ? <p className="text-micro text-warning">A position from an earlier session is still open and managed. New entries wait until it is closed (one position at a time).</p> : null}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2" aria-label="Session summary">
        <Item label="Session" value={activation?.id ?? "—"} />
        <Item label="Started" value={activation ? clock(activation.startedAt) : "—"} />
        <Item label="Entries used" value={`${summary.entriesUsed} / ${summary.max}`} tone={summary.entriesUsed >= summary.max ? "text-warning" : undefined} />
        <Item label="Completed · open" value={`${summary.completed} · ${summary.open}`} />
        <Item label="Wins · losses" value={`${summary.wins} · ${summary.losses}`} />
        <Item label="Current signal" value={currentSignal(data, running)} />
        <Item label="Last signal" value={live.lastSignal ? `${clock(live.lastSignal.time)} · ${live.lastSignal.decision}` : "None yet"} />
        <Item label="Last candle" value={clock(live.lastCandle)} />
        <Item label="Realized P&L" value={inr(summary.realized)} tone={pnlTone(summary.realized)} />
        <Item label="Unrealized P&L" value={inr(summary.unrealized)} tone={pnlTone(summary.unrealized)} />
        <Item label="Session P&L" value={inr(summary.total)} tone={pnlTone(summary.total)} />
        {activation?.endedAt ? <Item label="Ended" value={`${clock(activation.endedAt)} · ${activation.end === "LIMIT" ? "limit reached" : activation.end === "DAY_END" ? "day ended" : "stopped"}`} /> : null}
      </dl>

      {position && openTrade ? (
        <div className="rounded-md border border-profit/30 bg-profit-soft/40 p-2" aria-label="Active trade">
          <p className="font-semibold">Trade {openTrade.number} of {summary.max} · <span className={openTrade.side === "CALL" ? "text-profit" : "text-loss"}>BUY {openTrade.side}</span></p>
          <p className="text-micro text-text-2">{openTrade.contract} <span className="text-muted">(simulated)</span></p>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            <Item label="Entry" value={`${inr(position.avg)} · ${clock(position.openedAt)}`} />
            <Item label="Latest price" value={inr(position.bid)} />
            <Item label="Quantity" value={`${position.quantity} (${position.lots} × ${position.lots ? position.quantity / position.lots : "—"})`} />
            <Item label="Holding" value={now != null ? `${Math.max(0, Math.floor((now - position.openedAt) / 60))} min` : "—"} />
            <Item label="Stop-loss" value={position.stop > 0 ? inr(position.stop) : "None"} />
            <Item label="Target" value={inr(position.target)} />
            <Item label="Unrealized P&L" value={inr(position.unrealized)} tone={pnlTone(position.unrealized)} />
            <Item label="Exit" value={position.exit ? `Exiting (${position.exit.reason})` : holdLimit > 0 ? `Target, or time limit at ${clock(position.openedAt + holdLimit * 60)}` : "At target or session end"} />
          </dl>
        </div>
      ) : running && !position ? (
        <p className="rounded-md border border-border-soft px-2 py-1.5 text-micro font-semibold text-text-2" role="status">{summary.entriesUsed >= summary.max ? "Entry limit reached: no new entries in this session." : "WAITING FOR VALID SIGNAL"}</p>
      ) : null}

      <div className="rounded-md border border-border-soft p-2" aria-label="Completed trades">
        <p className="eyebrow mb-1">Completed trades · this session</p>
        {completed.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-micro">
              <thead className="text-muted">
                <tr className="text-left">
                  <th className="pr-2 font-medium">#</th><th className="pr-2 font-medium">Side</th><th className="pr-2 font-medium">Entry</th><th className="pr-2 font-medium">Exit</th><th className="pr-2 font-medium">Qty</th><th className="pr-2 text-right font-medium">Gross</th><th className="pr-2 text-right font-medium">Costs</th><th className="pr-2 text-right font-medium">Net</th><th className="pr-2 font-medium">Reason</th><th className="font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {completed.map((trade) => {
                  const costs = trade.gross != null && trade.realized != null ? Math.round((trade.gross - trade.realized) * 100) / 100 : null;
                  const result = trade.realized == null ? "—" : trade.realized > 0 ? "WIN" : trade.realized < 0 ? "LOSS" : "BREAKEVEN";
                  return (
                    <tr key={trade.entryKey} className="border-t border-border-soft align-top">
                      <td className="pr-2">{trade.number}</td>
                      <td className={cx("pr-2 font-semibold", trade.side === "CALL" ? "text-profit" : "text-loss")}>{trade.side}</td>
                      <td className="whitespace-nowrap pr-2">{clock(trade.entryTime)} · {trade.entryPremium.toFixed(2)}</td>
                      <td className="whitespace-nowrap pr-2">{clock(trade.exitTime)} · {trade.exitPremium?.toFixed(2) ?? "—"}</td>
                      <td className="pr-2">{trade.quantity}</td>
                      <td className={cx("pr-2 text-right", pnlTone(trade.gross))}>{inr(trade.gross)}</td>
                      <td className="pr-2 text-right">{inr(costs)}</td>
                      <td className={cx("pr-2 text-right font-semibold", pnlTone(trade.realized))}>{inr(trade.realized)}</td>
                      <td className="pr-2">{trade.exitReason ?? "—"}</td>
                      <td className={cx("font-semibold", pnlTone(trade.realized))}>{result}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="text-micro text-muted">None yet.</p>}
      </div>

      {live.previous.length ? (
        <details className="rounded-md border border-border-soft text-micro">
          <summary className="cursor-pointer px-2 py-1.5 font-medium text-text-2">Earlier sessions ({live.previous.length})</summary>
          <ul className="space-y-1 border-t border-border-soft p-2">
            {live.previous.map(({ activation: item, summary: past }) => (
              <li key={item.id} className="flex flex-wrap justify-between gap-x-2">
                <span>{item.id} · {clock(item.startedAt)}–{clock(item.endedAt)}</span>
                <span>{past.entriesUsed}/{past.max} entries · <span className={pnlTone(past.realized)}>{inr(past.realized)}</span></span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Item({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className={cx("truncate text-data", tone ?? "text-text-2")} title={value}>{value}</dd>
    </div>
  );
}
