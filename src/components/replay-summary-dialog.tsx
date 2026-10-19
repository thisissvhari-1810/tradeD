"use client";

import { Button, cx } from "@/components/ui";
import { Drawer } from "@/components/ui/drawer";
import { formatInr, formatPnl, formatSignedBps } from "@/lib/money";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import { OUTCOME_LABEL, istShortStamp, pnlTone } from "@/lib/trading/position-view";
import type { ReplaySessionSummary, SessionTradeResult } from "@/lib/trading/replay-summary";

export function ReplaySummaryDialog({
  open,
  reason,
  date,
  summary,
  onKeepReviewing,
  onRestart,
  onBackToLive,
}: {
  open: boolean;
  reason: "exit" | "completed";
  date: string;
  summary: ReplaySessionSummary;
  onKeepReviewing: () => void;
  onRestart: () => void;
  onBackToLive: () => void;
}) {
  const net = summary.netPaise;
  const headline = net ?? summary.realizedPaise;
  const stillOpen = summary.openCount + summary.waitingCount;
  return (
    <Drawer
      open={open}
      modal
      onClose={onKeepReviewing}
      label="Replay session summary"
      title="Replay session summary"
      subtitle={`${date} · ${reason === "completed" ? "Replay reached the session close" : "Before you leave replay"}`}
      width="w-[420px]"
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onKeepReviewing}>Keep reviewing</Button>
          <Button variant="secondary" onClick={onRestart}>Restart this day</Button>
          <Button variant="primary" onClick={onBackToLive}>Back to live</Button>
        </div>
      )}
    >
      <section aria-label="Session result" className={cx("rounded-card px-4 py-3", headline > 0n ? "bg-profit-soft" : headline < 0n ? "bg-loss-soft" : "bg-elevated")}>
        <p className="text-micro font-semibold uppercase tracking-wide text-muted">{net == null ? "Realized P&L" : "Net P&L"}</p>
        <p className={cx("num mt-1 text-3xl font-semibold leading-tight", pnlTone(headline))}>{formatPnl(headline)}</p>
        <p className="mt-1 text-data text-text-2">
          {summary.returnBps == null ? "Return unavailable" : `${formatSignedBps(summary.returnBps)} on ${formatInr(summary.investedPaise)} invested`}
        </p>
      </section>

      <dl className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="Realized" value={formatPnl(summary.realizedPaise)} tone={pnlTone(summary.realizedPaise)} />
        <Stat label={stillOpen ? "Unrealized (open)" : "Unrealized"} value={summary.unrealizedPaise == null ? "Unavailable" : formatPnl(summary.unrealizedPaise)} tone={pnlTone(summary.unrealizedPaise)} />
        <Stat label="Charges" value={formatInr(summary.chargesPaise)} hint="Included above" />
        <Stat label="Completed trades" value={String(summary.trades.length)} />
        <Stat label="Win rate" value={summary.winRateBps == null ? "No decided trades" : `${(summary.winRateBps / 100).toFixed(1)}%`} hint={summary.breakEven ? `${summary.breakEven} break-even not counted` : undefined} />
        <Stat label="Wins / losses" value={`${summary.wins} / ${summary.losses}`} />
        <Stat label="Best trade" value={summary.best ? formatPnl(summary.best.netPaise) : "None"} tone={pnlTone(summary.best?.netPaise)} />
        <Stat label="Worst trade" value={summary.worst ? formatPnl(summary.worst.netPaise) : "None"} tone={pnlTone(summary.worst?.netPaise)} />
        <Stat label="Avg win / loss" value={`${summary.averageWinPaise == null ? "—" : formatPnl(summary.averageWinPaise)} / ${summary.averageLossPaise == null ? "—" : formatPnl(summary.averageLossPaise)}`} />
      </dl>

      {stillOpen ? (
        <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-data text-warning">
          {stillOpen} position{stillOpen === 1 ? " is" : "s are"} still open. {stillOpen === 1 ? "Its" : "Their"} unrealized P&L is not counted as realized. Open positions stay on the practice ledger at the last replay price; come back to this day to close them.
        </p>
      ) : null}

      <h3 className="mt-4 text-dense font-semibold">Completed trades</h3>
      {summary.trades.length === 0 ? (
        <p className="mt-1 text-data text-muted">No trades were completed in this session.</p>
      ) : (
        <ul className="mt-1 divide-y divide-border-soft">
          {summary.trades.map((trade) => <TradeLine key={trade.id} trade={trade} />)}
        </ul>
      )}
    </Drawer>
  );
}

function Stat({ label, value, tone = "text-text", hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border-soft px-2 py-1.5">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className={cx("num truncate text-dense font-semibold", tone)}>{value}</dd>
      {hint ? <dd className="text-micro text-muted">{hint}</dd> : null}
    </div>
  );
}

function TradeLine({ trade }: { trade: SessionTradeResult }) {
  const contract = parseOptionLedgerSymbol(trade.symbol);
  const chip = trade.outcome === "WIN" ? "bg-profit-soft text-profit" : trade.outcome === "LOSS" ? "bg-loss-soft text-loss" : "bg-elevated text-text-2";
  return (
    <li className="flex items-center gap-2 py-2">
      <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-micro font-bold", chip)}>{OUTCOME_LABEL[trade.outcome]}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-data font-medium">{contract ? `${contract.underlying} ${contract.strike.toLocaleString("en-IN")} ${contract.right}` : trade.symbol}</span>
        <span className="num block text-micro text-muted">{istShortStamp(trade.entryAt)} → {istShortStamp(trade.exitAt)} · Qty {trade.quantity}</span>
      </span>
      <span className={cx("num shrink-0 text-right text-data font-semibold", pnlTone(trade.netPaise))}>
        {formatPnl(trade.netPaise)}
        <span className="block text-micro font-medium">{formatSignedBps(trade.returnBps)}</span>
      </span>
    </li>
  );
}
