"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Crosshair, LogIn, LogOut, Ruler } from "lucide-react";
import { cx } from "@/components/ui";
import { Drawer } from "@/components/ui/drawer";
import { algoTrades, tradeTimeline, type AlgoTrade, type TimelineEvent } from "@/lib/algo/chart-replay";
import type { ChartAlgo } from "@/components/algo/use-chart-algo";
import { ExitConfirm, PremiumBar, type LivePosition } from "@/components/algo/algo-replay-panel";
import { LiveMoney, money, toneOf } from "@/components/algo/live-value";

const ist = (seconds: number | null | undefined) => (seconds ? new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16) : "—");
const inr = (value: number | null | undefined, signed = false) => (value == null || !Number.isFinite(value) ? "—" : money(value, signed));

const TIMELINE_DOT: Record<TimelineEvent["kind"], string> = {
  signal: "bg-warning",
  order: "bg-info",
  opened: "bg-profit",
  exit: "bg-warning",
  closed: "bg-primary",
  rejected: "bg-loss",
  info: "bg-muted",
};

/** A plain-text summary of the trade's actual figures, for the clipboard. */
export function tradeSummary(trade: AlgoTrade, max: number, position: LivePosition | null) {
  const lines = [
    `Trade ${trade.number}/${max} · BUY ${trade.side} · ${trade.underlying} ${trade.strike ?? ""} ${trade.right} · exp ${trade.expiry}`,
    `Signal ${ist(trade.signalTime + 60)} IST${trade.lines.length ? ` · ${trade.lines.join(", ")}` : ""}${trade.underlyingAtSignal != null ? ` · underlying ${trade.underlyingAtSignal.toFixed(2)}` : ""}`,
    `Entry ${ist(trade.entryTime)} IST · ${trade.quantity} @ ${inr(trade.entryPremium)} · charges ${inr(trade.entryCharges)}`,
    trade.status === "COMPLETED"
      ? `Exit ${ist(trade.exitTime)} IST · ${inr(trade.exitPremium)} (${trade.exitReason ?? "Exit"}) · realized ${inr(trade.realized, true)}${trade.returnPercent == null ? "" : ` (${trade.returnPercent.toFixed(2)}%)`}`
      : `Open · premium ${inr(position?.premium)} · unrealized ${inr(position?.unrealized, true)}`,
    `Stop-loss ${inr(trade.stop)} · target ${inr(trade.target)} (option premium) · simulated replay trade`,
  ];
  return lines.join("\n");
}

/**
 * One trade in full: header, the large P&L, entry and exit, risk, and its own event timeline. It reads
 * the same run data as the panel (refreshed with each processed replay minute), so an open trade's
 * premium and P&L move live and a completed trade keeps its final result. Closing it changes nothing;
 * the replay keeps playing underneath.
 */
export function AlgoTradeDrawer({ algo, entryKey, cursor, onClose, onFocus, onShowLine, lineShown }: {
  algo: ChartAlgo;
  entryKey: string;
  cursor: number | null;
  onClose: () => void;
  /** Moves the chart to a time span (seconds). */
  onFocus: (from: number, to: number) => void;
  /** Highlights the trade's strategy line(s) on the chart, or clears them. */
  onShowLine: (prices: number[] | null, label: string) => void;
  lineShown: boolean;
}) {
  const [exitOpen, setExitOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const run = algo.run;
  const live = run?.position && run.position.entryKey === entryKey ? run.position : null;
  const trade = run ? algoTrades(run.events, run.position ? { entryKey: run.position.entryKey, exitPending: Boolean(run.position.exit) } : null).find((item) => item.entryKey === entryKey) ?? null : null;
  const max = run?.config.maxTrades ?? 3;
  if (!run || !trade) {
    return (
      <Drawer open onClose={onClose} label="Algo trade" title="Trade not found" width="w-[36rem]">
        <p className="text-muted">This trade is not part of the current replay session.</p>
      </Drawer>
    );
  }
  const completed = trade.status === "COMPLETED";
  const call = trade.side === "CALL";
  const status = completed ? "Completed" : trade.status === "EXIT_PENDING" ? "Exit pending" : "Open";
  const pnl = completed ? trade.realized : live?.unrealized ?? null;
  const percent = completed ? trade.returnPercent : live?.unrealizedPercent ?? null;
  const currentPremium = completed ? trade.exitPremium : live?.premium ?? null;
  const cost = Math.round(trade.entryPremium * trade.quantity * 100) / 100;
  const value = completed ? (trade.exitPremium != null ? Math.round(trade.exitPremium * trade.quantity * 100) / 100 : null) : live?.value ?? null;
  const stop = trade.stop;
  const target = trade.target;
  const toStop = currentPremium != null && stop != null ? currentPremium - stop : null;
  const toTarget = currentPremium != null && target != null ? target - currentPremium : null;
  const risk = !completed && toStop != null && toTarget != null && stop != null && target != null
    ? toStop <= 0 ? "Stop-loss reached: exit on the next processed minute" : toTarget <= 0 ? "Target reached: exit on the next processed minute"
      : toStop / Math.max(0.01, target - stop) < 0.2 ? "Approaching the stop-loss" : toTarget / Math.max(0.01, target - stop) < 0.2 ? "Approaching the target" : "Within range"
    : completed ? `Closed (${trade.exitReason ?? "exit"})` : "Premium unavailable";
  const reward = stop != null && target != null && trade.entryPremium > stop ? (target - trade.entryPremium) / (trade.entryPremium - stop) : null;
  const timeline = tradeTimeline(run.events, entryKey);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tradeSummary(trade, max, live));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      label={`Trade ${trade.number} details`}
      width="w-[36rem]"
      className="max-sm:h-[92dvh]"
      title={<span className="flex flex-wrap items-center gap-2"><span>Trade {trade.number}/{max}</span><span className={call ? "text-profit" : "text-loss"}>BUY {trade.side}</span><span className={cx("rounded-pill px-2 py-0.5 text-xs font-semibold", completed ? "bg-sunken text-text-2" : "bg-profit-soft text-profit")}>{status}</span></span>}
      subtitle={<span className="flex flex-wrap items-center gap-x-2">{trade.underlying} {trade.strike} {trade.right} · exp {trade.expiry}<span className="num text-muted">· replay {ist(cursor)} IST</span>{!completed ? <span className="inline-flex items-center gap-1 text-profit"><span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-profit" aria-hidden />Live</span> : null}</span>}
      footer={(
        <div className="flex flex-wrap gap-2">
          <Action icon={<Crosshair className="h-4 w-4" aria-hidden />} label="Focus on chart" onClick={() => onFocus(trade.signalTime, trade.exitTime ?? cursor ?? trade.entryTime)} />
          <Action icon={<LogIn className="h-4 w-4" aria-hidden />} label="Show entry" onClick={() => onFocus(trade.entryTime - 300, trade.entryTime + 300)} />
          {completed && trade.exitTime ? <Action icon={<LogOut className="h-4 w-4" aria-hidden />} label="Show exit" onClick={() => onFocus(trade.exitTime! - 300, trade.exitTime! + 300)} /> : null}
          {trade.linePrices.length ? <Action icon={<Ruler className="h-4 w-4" aria-hidden />} label={lineShown ? "Hide strategy line" : "View strategy line"} pressed={lineShown} onClick={() => onShowLine(lineShown ? null : trade.linePrices, trade.lines.join(", "))} /> : null}
          <Action icon={copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />} label={copied ? "Copied" : "Copy details"} onClick={() => void copy()} />
          {!completed && live ? <button type="button" className="ml-auto h-9 rounded-md bg-loss px-4 font-semibold text-on-signal hover:brightness-110 disabled:opacity-50" disabled={Boolean(live.exit) || Boolean(algo.busy) || cursor == null} onClick={() => setExitOpen(true)}>{live.exit ? "Exit pending…" : "Exit position"}</button> : null}
        </div>
      )}
    >
      <div className="space-y-4 text-[0.9375rem]">
        {/* Large P&L */}
        <section className={cx("rounded-xl bg-gradient-to-br p-4", call ? "from-profit-soft/40 to-elevated" : "from-loss-soft/40 to-elevated")}>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{completed ? "Realized P&L (final)" : "Unrealized P&L"}</p>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-[2.125rem] font-semibold leading-tight">{completed ? <span className={cx("num", toneOf(pnl))}>{inr(pnl, true)}</span> : <LiveMoney value={pnl} signed tone missing="Premium unavailable" />}</span>
            <span className={cx("num text-lg font-semibold", toneOf(percent))}>{percent == null ? "" : `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Big label="Entry premium">{inr(trade.entryPremium)}</Big>
            <Big label={completed ? "Exit premium" : `Current premium${live?.premiumAt ? ` · ${ist(live.premiumAt)}` : ""}`}>{completed ? inr(currentPremium) : <LiveMoney value={currentPremium} className="text-[1.625rem]" missing="Unavailable" />}</Big>
            <Big label="Quantity">{trade.quantity}{trade.lotSize ? <span className="text-sm text-muted"> ({Math.round(trade.quantity / trade.lotSize)} × {trade.lotSize})</span> : null}</Big>
            <Big label="Entry cost">{inr(cost)}</Big>
            <Big label={completed ? "Exit value" : "Position value"}>{completed ? inr(value) : <LiveMoney value={value} />}</Big>
            <Big label="Charges (simulated)">{inr(trade.entryCharges + trade.exitCharges)}</Big>
          </div>
        </section>

        <Section title="Entry and exit">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Row label="Strategy line">{trade.lines.join(", ") || "—"}</Row>
            <Row label="Crossing">{trade.direction === "DOWN" ? "Bearish (body crossed down)" : trade.direction === "UP" ? "Bullish (body crossed up)" : "—"}</Row>
            <Row label="Signal candle">{ist(trade.signalTime)} IST</Row>
            <Row label="Underlying at signal">{trade.underlyingAtSignal?.toFixed(2) ?? "—"} <span className="text-xs text-muted">(index)</span></Row>
            <Row label="Option">{trade.underlying} {trade.strike} {trade.right}</Row>
            <Row label="Entry fill">{inr(trade.entryPremium)} at {ist(trade.entryTime)} IST</Row>
            <Row label="Exit fill">{completed ? `${inr(trade.exitPremium)} at ${ist(trade.exitTime)} IST` : "Open"}</Row>
            <Row label="Exit reason">{completed ? trade.exitReason ?? "—" : "—"}</Row>
            <Row label="Duration">{completed ? `${trade.durationMinutes ?? "—"} min` : `${Math.max(0, Math.round(((run.processedThrough ?? trade.entryTime) - trade.entryTime) / 60))} min so far`}</Row>
            <Row label="Risk / reward">{reward == null ? "—" : `1 : ${reward.toFixed(2)}`}</Row>
          </dl>
        </Section>

        <Section title="Risk management (option premium)">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Row label="Stop-loss premium"><span className="text-loss">{inr(stop)}</span></Row>
            <Row label="Target premium"><span className="text-profit">{inr(target)}</span></Row>
            <Row label="Distance to stop-loss">{toStop == null ? "—" : inr(toStop)}</Row>
            <Row label="Distance to target">{toTarget == null ? "—" : inr(toTarget)}</Row>
            <Row label="Risk status"><span className={risk.startsWith("Within") ? "text-text" : risk.startsWith("Closed") ? "text-text-2" : "text-warning"}>{risk}</span></Row>
          </dl>
          {stop != null && target != null ? <PremiumBar stop={stop} entry={trade.entryPremium} target={target} current={currentPremium} /> : null}
          <p className="mt-1 text-xs text-muted">These are option premiums, not index prices. The chart&apos;s candles are the underlying index.</p>
        </Section>

        <Section title="Trade history">
          <ol className="space-y-2">
            {timeline.map((event) => (
              <li key={event.id} className="flex gap-2.5">
                <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", TIMELINE_DOT[event.kind])} aria-hidden />
                <span className="min-w-0 text-sm"><span className="num mr-1.5 text-muted">{ist(event.time)}</span>{event.text}</span>
              </li>
            ))}
            {!completed && live ? (
              <li className="flex gap-2.5">
                <span className="live-dot mt-1.5 h-2 w-2 shrink-0 rounded-full bg-profit" aria-hidden />
                <span className="text-sm"><span className="num mr-1.5 text-muted">{ist(live.premiumAt)}</span>Latest premium <LiveMoney value={live.premium} /> · unrealized <LiveMoney value={live.unrealized} signed tone /></span>
              </li>
            ) : null}
          </ol>
        </Section>
      </div>
      {exitOpen && live ? <ExitConfirm algo={algo} position={live} cursor={cursor} onClose={() => setExitOpen(false)} /> : null}
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details open className="rounded-lg border border-border-soft">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">{title}</summary>
      <div className="border-t border-border-soft px-3 py-2.5">{children}</div>
    </details>
  );
}

function Big({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <p className="num truncate text-lg font-semibold">{children}</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-[0.9375rem] font-medium">{children}</dd>
    </div>
  );
}

function Action({ icon, label, onClick, pressed }: { icon: ReactNode; label: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" aria-pressed={pressed} className={cx("inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-hover", pressed ? "border-primary text-primary" : "border-border")} onClick={onClick}>
      {icon}{label}
    </button>
  );
}
