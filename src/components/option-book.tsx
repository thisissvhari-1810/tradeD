"use client";

import { useMemo, useState } from "react";
import { ArrowRight, Info, X } from "lucide-react";
import { istStamp } from "@/components/api";
import { cx } from "@/components/ui";
import { formatInr, formatPnl, formatSignedBps } from "@/lib/money";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import {
  OUTCOME_LABEL,
  entryNotice,
  holdingLabel,
  istShortStamp,
  missingPriceReason,
  parsePercentBps,
  parseRupees,
  pnlTone,
  positionStatus,
} from "@/lib/trading/position-view";
import { priceMove, realizedMetric, returnOnCostBps, tradeOutcome, type ReplaySessionSummary, type SessionTradeResult, type TradeOutcome } from "@/lib/trading/replay-summary";

export type BookPosition = {
  symbol: string;
  name: string;
  quantity: number;
  lotSize?: number | null;
  lots?: number | null;
  contract?: { underlying: string; expiry: string; strike: number; right: "CE" | "PE" } | null;
  averageCost: string;
  mark: string | null;
  marketValue: string | null;
  unrealized: string | null;
  realized: string;
  mode?: string;
  asOf?: string | null;
  status?: string;
  openedAt?: string | null;
  updatedAt?: string | null;
  replaySession?: string | null;
  /** Replay time is earlier than this position's entry fill. */
  beforeEntry?: boolean;
  /** The replay premium is still being fetched. */
  pending?: boolean;
  stale?: boolean;
  note?: string;
};

export type BookContext = { mode: "replay"; date: string; cursor: number | null; sessionOpen?: number | null } | { mode: "live" | "demo" };

export type BookOrder = {
  id: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  filledQuantity: number;
  status: string;
  avgFill: string | null;
  reason: string | null;
  submittedAt: string;
  filledAt?: string | null;
  executedAt?: string | null;
  priceSource?: string | null;
  dataMode?: string | null;
};

export type BookTrade = {
  id: string;
  symbol: string;
  name: string;
  direction: string;
  quantity: number;
  entryAt: string;
  exitAt: string;
  averageEntry: string;
  averageExit: string;
  net: string;
  ret: string;
  charges: string;
  gross?: string;
  holdingSeconds?: number;
  orderIds?: unknown;
};

type ResultRow = {
  id: string;
  symbol: string;
  direction: string;
  quantity: number;
  lotSize: number | null;
  entryAt: Date;
  exitAt: Date;
  avgEntryPaise: bigint | null;
  avgExitPaise: bigint | null;
  grossPaise: bigint | null;
  chargesPaise: bigint | null;
  netPaise: bigint;
  returnBps: number | null;
  holdingSeconds: number | null;
  outcome: TradeOutcome;
};

export function OptionBook({
  buyingPower,
  reserved,
  holdings,
  unrealized,
  realized,
  realizedToday,
  positions,
  orders,
  trades,
  error,
  onViewChart,
  onExit,
  context = { mode: "demo" },
  exitBlock,
  hiddenCount = 0,
  summary = null,
  highlightTradeId = null,
  onDismissHighlight,
}: {
  context?: BookContext;
  /** Reason the exit is unavailable for a row, or null when it can be closed now. */
  exitBlock?: (row: BookPosition) => string | null;
  /** Positions outside the current mode that are not listed. */
  hiddenCount?: number;
  /** Replay-session P&L from the ledger; the single source for the hero, metric and trade results in replay. */
  summary?: ReplaySessionSummary | null;
  /** A trade that was just closed, shown highlighted at the top of Positions. */
  highlightTradeId?: string | null;
  onDismissHighlight?: () => void;
  buyingPower: string;
  reserved: string;
  holdings: string;
  unrealized: string;
  realized: string;
  realizedToday: string;
  positions: BookPosition[];
  orders: BookOrder[];
  trades: BookTrade[];
  error: string;
  /** Kept for callers; the empty panel no longer shows an Open Option Chain button. */
  onOpenChain?: () => void;
  onViewChart: (symbol: string) => void;
  onExit: (row: BookPosition) => void;
}) {
  const [tab, setTab] = useState<"positions" | "orders" | "history">("positions");
  const [right, setRight] = useState<"all" | "CE" | "PE">("all");
  const [result, setResult] = useState<"all" | "win" | "loss">("all");
  const replay = context.mode === "replay" ? context : null;
  const options = positions.filter((row) => row.contract);
  const others = positions.filter((row) => !row.contract);
  const rows = useMemo<ResultRow[]>(() => (replay ? (summary?.trades ?? []).map(fromSession) : trades.flatMap((row) => fromBook(row) ?? [])).slice().reverse(), [replay, summary, trades]);
  const shownTrades = rows.filter((row) => {
    const parsed = parseOptionLedgerSymbol(row.symbol);
    if (right !== "all" && parsed?.right !== right) return false;
    if (result === "win" && row.outcome !== "WIN") return false;
    if (result === "loss" && row.outcome !== "LOSS") return false;
    return true;
  });
  const highlight = highlightTradeId ? rows.find((row) => row.id === highlightTradeId) ?? null : null;
  const empty = !replay && options.length === 0 && others.length === 0 && !highlight;
  const metric = replay ? realizedMetric({ replay: true, summary }) : realizedMetric({ replay: false, today: realizedToday });

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <p className={cx("flex items-center gap-2 border-b border-border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide", replay ? "bg-demo/10 text-demo" : context.mode === "live" ? "bg-profit/10 text-profit" : "bg-demo/10 text-demo")}>
        {replay ? "Historical replay" : context.mode === "live" ? "Paper trading · live prices" : "Demo paper trading"}
        {replay ? <span className="num font-normal normal-case tracking-normal">{replay.date}{replay.cursor == null ? "" : ` · ${clockOf(replay.cursor)} IST`}</span> : null}
      </p>
      {replay ? <SessionHero summary={summary} /> : null}
      {/* With nothing open (outside replay) the summary would be placeholders only, so it is not shown. */}
      {empty ? null : <>
      <div className="grid grid-cols-3 gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <Metric label="Open" value={String(options.length)} />
        <Metric label="Position value" value={holdings} />
        <Metric label={metric.label} value={metric.value} tone={metric.paise == null ? toneOfText(metric.value) : pnlTone(metric.paise)} />
        {replay ? null : <Metric label="Unrealized" value={unrealized} tone={toneOfText(unrealized)} />}
        <Metric label="Buying power" value={buyingPower} />
        <Metric label="Reserved" value={reserved} />
      </div>
      <details className="group border-b border-border px-3 py-1 text-[10px] text-muted">
        <summary className="flex cursor-pointer list-none items-center gap-1 rounded-xs py-0.5 hover:text-text focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
          <Info className="h-3 w-3" aria-hidden />How these numbers work
        </summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {replay ? <li>Replay session P&L counts only trades from this replay session. Charges are already included in realized and unrealized.</li> : <li>Realized today counts fills on today’s calendar date (IST).</li>}
          <li>Realized for all practice trades this period: <span className="num">{realized}</span>.</li>
          <li>{replay ? "Replay prices use the last completed 1-minute candle at the replay time and stay fixed while paused." : "Option prices use the chain snapshot."}</li>
          {hiddenCount ? <li>{hiddenCount} position{hiddenCount === 1 ? "" : "s"} from {replay ? "other sessions" : "replay sessions"} {hiddenCount === 1 ? "is" : "are"} not listed here; see Portfolio.</li> : null}
        </ul>
      </details>
      </>}
      <div className="flex h-9 shrink-0 gap-0.5 border-b border-border px-1.5" role="tablist">
        {(["positions", "orders", "history"] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={tab === item} className={cx("relative h-9 px-2.5 text-data font-medium focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]", tab === item ? "text-text after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary" : "text-muted hover:text-text")} onClick={() => setTab(item)}>
            {item === "positions" ? "Positions" : item === "orders" ? "Orders" : `Trade history${rows.length ? ` ${rows.length}` : ""}`}
          </button>
        ))}
      </div>
      {error ? <p className="px-3 py-2 text-loss" role="alert">{error}</p> : null}
      <div className="min-h-0 flex-1 overflow-auto" onWheel={(event) => event.stopPropagation()}>
        {tab === "positions" ? (
          <>
            {highlight ? <ResultCard row={highlight} highlighted onDismiss={onDismissHighlight} /> : null}
            {options.length === 0 ? (
              <p className="px-3 py-6 text-center text-data text-muted">No open positions</p>
            ) : options.map((row) => (
              <PositionCard key={row.symbol} row={row} replay={replay} block={exitBlock?.(row) ?? null} onView={replay ? null : () => onViewChart(row.symbol)} onExit={() => onExit(row)} />
            ))}
          </>
        ) : null}
        {tab === "orders" ? (
          orders.length === 0 ? <p className="p-3 text-muted">No demo orders yet.</p> : orders.map((order) => <OrderRow key={order.id} order={order} />)
        ) : null}
        {tab === "history" ? (
          <>
            <div className="flex gap-1 px-2 py-2">
              <select aria-label="Option type" className="py-1" value={right} onChange={(event) => setRight(event.target.value as "all" | "CE" | "PE")}><option value="all">CE and PE</option><option value="CE">CE</option><option value="PE">PE</option></select>
              <select aria-label="Result" className="py-1" value={result} onChange={(event) => setResult(event.target.value as "all" | "win" | "loss")}><option value="all">All results</option><option value="win">Wins</option><option value="loss">Losses</option></select>
            </div>
            {shownTrades.length === 0 ? <p className="px-3 pb-3 text-muted">{replay ? "No completed trades in this replay session yet." : "No closed trades in this view."}</p> : shownTrades.map((row) => <ResultCard key={row.id} row={row} highlighted={row.id === highlightTradeId} />)}
          </>
        ) : null}
        {tab === "positions" && others.length > 0 ? (
          <div className="border-t border-border p-3 text-muted">
            <p className="font-medium text-text">Other holdings</p>
            {others.map((row) => <p key={row.symbol} className="mt-1">{row.name} · {row.quantity} · {row.unrealized == null ? "Price unavailable" : formatMaybe(row.unrealized)}</p>)}
          </div>
        ) : null}
      </div>
      <p className="border-t border-border px-3 py-1 text-[10px] text-muted">Demo only. No broker order is sent.</p>
    </div>
  );
}

function SessionHero({ summary }: { summary: ReplaySessionSummary | null }) {
  if (!summary || (summary.trades.length === 0 && summary.openCount === 0 && summary.waitingCount === 0 && summary.realizedPaise === 0n)) {
    return (
      <section aria-label="Replay session P&L" className="border-b border-border px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Replay session P&L</p>
        <p className="num mt-0.5 text-title font-semibold text-text-2">{formatPnl(0n)}</p>
        <p className="mt-0.5 text-[11px] text-muted">No trades in this replay session yet. Buy from the Option Chain to start.</p>
      </section>
    );
  }
  const net = summary.netPaise;
  const headline = net ?? summary.realizedPaise;
  const decisive = summary.wins + summary.losses;
  const parts = [
    summary.returnBps == null ? (summary.investedPaise > 0n ? "Return unavailable while an open price is missing" : null) : `${formatSignedBps(summary.returnBps)} on ${formatInr(summary.investedPaise)} invested`,
    `${summary.trades.length} trade${summary.trades.length === 1 ? "" : "s"}`,
    summary.trades.length ? `${summary.wins} win${summary.wins === 1 ? "" : "s"} / ${summary.losses} loss${summary.losses === 1 ? "" : "es"}${summary.breakEven ? ` / ${summary.breakEven} flat` : ""}` : null,
  ].filter((part): part is string => Boolean(part));
  return (
    <section aria-label="Replay session P&L" className={cx("border-b border-border px-3 py-3 transition-colors motion-reduce:transition-none", headline > 0n ? "bg-profit-soft/50" : headline < 0n ? "bg-loss-soft/50" : "")}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{net == null ? "Replay session realized P&L" : "Replay session P&L"}</p>
      <p className={cx("num mt-1 text-2xl font-semibold leading-tight", pnlTone(headline))}>{formatPnl(headline)}</p>
      <p className="mt-0.5 text-[11px] text-text-2">{parts.join(" · ")}</p>
      {decisive && summary.winRateBps != null ? <p className="sr-only">Win rate {(summary.winRateBps / 100).toFixed(0)} percent.</p> : null}
      {net == null ? <p className="mt-1 text-[10px] text-warning">Open price unavailable for {summary.unpricedCount} position{summary.unpricedCount === 1 ? "" : "s"}, so unrealized and net are not shown.</p> : null}
      <dl className="mt-2 grid grid-cols-4 gap-1.5">
        <Breakdown label="Realized" value={formatPnl(summary.realizedPaise)} tone={pnlTone(summary.realizedPaise)} />
        <Breakdown label="Unrealized" value={summary.unrealizedPaise == null ? "Unavailable" : formatPnl(summary.unrealizedPaise)} tone={pnlTone(summary.unrealizedPaise)} />
        <Breakdown label="Charges" value={formatInr(summary.chargesPaise)} tone="text-text-2" title="Brokerage and fees on this session's fills. Already included in realized and unrealized." />
        <Breakdown label="Net" value={net == null ? "Unavailable" : formatPnl(net)} tone={pnlTone(net)} />
      </dl>
    </section>
  );
}

function Breakdown({ label, value, tone, title }: { label: string; value: string; tone: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-panel/70 px-1.5 py-1" title={title}>
      <dt className="text-[10px] text-muted">{label}</dt>
      <dd className={cx("num truncate text-[11px] font-semibold", tone)}>{value}</dd>
    </div>
  );
}

const STATUS_CHIP: Record<ReturnType<typeof positionStatus>, string> = {
  Open: "bg-primary-soft text-primary",
  "Waiting for entry time": "bg-warning-soft text-warning",
  Closed: "bg-elevated text-muted",
};

function PositionCard({ row, replay, block, onView, onExit }: { row: BookPosition; replay: Extract<BookContext, { mode: "replay" }> | null; block: string | null; onView: (() => void) | null; onExit: () => void }) {
  const contract = row.contract;
  if (!contract) return null;
  const status = positionStatus(row);
  const waiting = status === "Waiting for entry time";
  const avgPaise = parseRupees(row.averageCost);
  const markPaise = row.mark == null || row.mode === "UNAVAILABLE" || waiting ? null : parseRupees(row.mark);
  const costPaise = avgPaise == null ? null : avgPaise * BigInt(row.quantity);
  const unrealizedPaise = markPaise == null ? null : parseRupees(row.unrealized);
  const valuePaise = markPaise == null ? null : parseRupees(row.marketValue);
  const move = avgPaise != null && markPaise != null ? priceMove("LONG", avgPaise, markPaise) : null;
  const pnlBps = unrealizedPaise != null && costPaise != null ? returnOnCostBps(unrealizedPaise, costPaise) : null;
  const realizedPaise = parseRupees(row.realized);
  const reason = waiting || markPaise != null ? null : replay
    ? missingPriceReason({ cursor: replay.cursor, sessionOpen: replay.sessionOpen ?? null, loading: Boolean(row.pending), message: row.note })
    : "Current premium is unavailable from the chain snapshot.";
  const exitReason = block ?? (markPaise == null ? "Current premium is unavailable, so this exit cannot be priced." : !row.lots ? "Lot size is not stored, so this exit cannot be sized." : null);

  return (
    <article className={cx("border-b border-border px-3 py-2.5", waiting && "opacity-60")} aria-label={`${contract.underlying} ${contract.strike} ${contract.right}, ${status}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{contract.underlying} {contract.strike.toLocaleString("en-IN")} {contract.right} <span className="text-[10px] font-normal text-muted">{contract.right === "CE" ? "Call" : "Put"}</span></h3>
          <p className="text-[10px] text-muted">Expiry {contract.expiry}{row.replaySession ? ` · Replay ${row.replaySession.slice(0, 10)}` : ""}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <span className="rounded-full bg-profit-soft px-2 py-0.5 text-[10px] font-semibold text-profit">LONG</span>
          <span className={cx("rounded-full px-2 py-0.5 text-[10px] font-semibold", STATUS_CHIP[status])}>{status}</span>
        </div>
      </div>
      {waiting ? (
        <p className="mt-2 text-[11px] font-medium text-text-2">{entryNotice(row.openedAt)}</p>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-1.5 text-[11px]">
            <span className="text-muted">Entry</span><span className="num font-medium">{avgPaise == null ? "Unavailable" : formatInr(avgPaise)}</span>
            <ArrowRight className="h-3 w-3 text-muted" aria-label="to" />
            <span className="text-muted">{row.replaySession ? "Replay" : "Now"}</span><span className="num font-medium">{markPaise == null ? "—" : formatInr(markPaise)}</span>
            {move ? <span className={cx("num ml-auto", pnlTone(move.paise))}>{formatPnl(move.paise)}{move.bps == null ? "" : ` (${formatSignedBps(move.bps)})`}</span> : null}
          </div>
          {reason ? <p className="mt-1 text-[11px] text-muted">{reason}</p> : null}
          {unrealizedPaise != null ? (
            <p className={cx("num mt-1.5 text-lg font-semibold leading-tight", pnlTone(unrealizedPaise))}>
              {formatPnl(unrealizedPaise)}
              {pnlBps == null ? null : <span className="ml-1.5 text-[11px] font-medium">{formatSignedBps(pnlBps)} of cost</span>}
              <span className="ml-1.5 text-[10px] font-normal text-muted">unrealized</span>
            </p>
          ) : null}
        </>
      )}
      <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1">
        <Field label="Lots" value={row.lots == null ? "Not stored" : String(row.lots)} />
        <Field label="Quantity" value={String(row.quantity)} />
        <Field label="Invested" value={costPaise == null ? "Unavailable" : formatInr(costPaise)} />
        {waiting ? null : <Field label="Current value" value={valuePaise == null ? "—" : formatInr(valuePaise)} />}
        <Field label="Breakeven" value={avgPaise == null ? "Unavailable" : formatInr(avgPaise)} title="Average cost including entry charges. Exit charges are not included." />
        {realizedPaise ? <Field label="Realized earlier" value={formatPnl(realizedPaise)} tone={pnlTone(realizedPaise)} title="Already booked on this contract from earlier exits." /> : null}
      </dl>
      {row.stale && markPaise != null ? <p className="mt-1 text-[10px] text-warning">Thinly traded: the last trade is a few minutes old.</p> : null}
      {!waiting && row.asOf && markPaise != null ? <p className="mt-1 text-[10px] text-muted">{row.replaySession ? "Replay mark" : "Mark"} {istStamp(row.asOf)}</p> : null}
      {waiting ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onView ? <button type="button" className="h-8 rounded-full border border-border px-3 hover:bg-hover" onClick={onView}>View chart</button> : null}
          {exitReason ? <p className="text-[10px] text-muted">{exitReason}</p> : <button type="button" className="h-8 rounded-full bg-loss px-3 font-semibold text-on-signal hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]" title="Sell to close" onClick={onExit}>Exit position</button>}
        </div>
      )}
    </article>
  );
}

const OUTCOME_CHIP: Record<TradeOutcome, string> = {
  WIN: "bg-profit-soft text-profit",
  LOSS: "bg-loss-soft text-loss",
  BREAK_EVEN: "bg-elevated text-text-2",
};

function ResultCard({ row, highlighted = false, onDismiss }: { row: ResultRow; highlighted?: boolean; onDismiss?: () => void }) {
  const lots = row.lotSize && row.quantity % row.lotSize === 0 ? row.quantity / row.lotSize : null;
  return (
    <article className={cx("border-b border-border px-3 py-2.5", highlighted && "bg-primary-soft/40 ring-1 ring-inset ring-primary/40")}>
      <div className="flex items-start gap-2">
        <span className={cx("mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold", OUTCOME_CHIP[row.outcome])}>{OUTCOME_LABEL[row.outcome]}</span>
        <p className={cx("num min-w-0 flex-1 text-base font-semibold leading-tight", pnlTone(row.netPaise))}>
          {formatPnl(row.netPaise)}{row.returnBps == null ? "" : <span className="ml-1 text-xs font-medium">({formatSignedBps(row.returnBps)})</span>}
        </p>
        {highlighted && onDismiss ? (
          <button type="button" aria-label="Dismiss closed trade" className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-text" onClick={onDismiss}><X className="h-3.5 w-3.5" aria-hidden /></button>
        ) : null}
      </div>
      {highlighted ? <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">Trade closed</p> : null}
      <p className="mt-1 font-medium">{contractLabel(row.symbol)} · {row.direction}</p>
      <p className="num mt-0.5 text-[11px] text-text-2">
        {row.avgEntryPaise == null ? "Entry" : `Entry ${formatInr(row.avgEntryPaise)}`} at {istShortStamp(row.entryAt)}
        {" → "}
        {row.avgExitPaise == null ? "Exit" : `Exit ${formatInr(row.avgExitPaise)}`} at {istShortStamp(row.exitAt)}
      </p>
      <p className="num text-[10px] text-muted">
        Qty {row.quantity}{lots ? ` · ${lots} lot${lots === 1 ? "" : "s"}` : ""}{row.holdingSeconds == null ? "" : ` · held ${holdingLabel(row.holdingSeconds)}`}
      </p>
      <p className="num text-[10px] text-muted">
        {row.grossPaise == null ? "" : `Gross ${formatPnl(row.grossPaise)} · `}Charges {row.chargesPaise == null ? "unavailable" : formatInr(row.chargesPaise)} · Net <span className={pnlTone(row.netPaise)}>{formatPnl(row.netPaise)}</span>
      </p>
    </article>
  );
}

function fromSession(trade: SessionTradeResult): ResultRow {
  return { ...trade };
}

function fromBook(row: BookTrade): ResultRow | null {
  const netPaise = parseRupees(row.net);
  if (netPaise == null) return null;
  const entryAt = new Date(row.entryAt);
  const exitAt = new Date(row.exitAt);
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    quantity: row.quantity,
    lotSize: null,
    entryAt,
    exitAt,
    avgEntryPaise: parseRupees(row.averageEntry),
    avgExitPaise: parseRupees(row.averageExit),
    grossPaise: parseRupees(row.gross),
    chargesPaise: parseRupees(row.charges),
    netPaise,
    returnBps: parsePercentBps(row.ret),
    holdingSeconds: row.holdingSeconds ?? Math.max(0, Math.floor((exitAt.getTime() - entryAt.getTime()) / 1000)),
    outcome: tradeOutcome(netPaise),
  };
}

function OrderRow({ order }: { order: BookOrder }) {
  const label = useMemo(() => contractLabel(order.symbol), [order.symbol]);
  return (
    <article className="border-b border-border px-3 py-2">
      <p className="font-medium">{label}</p>
      <p className={order.side === "BUY" ? "text-profit" : "text-loss"}>{order.side} · {order.type} · {order.quantity} · {order.status}</p>
      <p className="text-muted">Fill {order.avgFill ? formatMaybe(order.avgFill, false) : "not filled"} · Filled qty {order.filledQuantity}</p>
      {order.dataMode === "HISTORICAL" && order.executedAt ? (
        <>
          <p className="text-[10px] text-info">Replay fill at {istStamp(order.executedAt)} (simulated market time)</p>
          <p className="text-[10px] text-muted">Submitted {istStamp(order.submittedAt)} (real time)</p>
          {order.priceSource ? <p className="truncate text-[10px] text-muted" title={order.priceSource}>{order.priceSource}</p> : null}
        </>
      ) : <p className="text-[10px] text-muted">Submitted {istStamp(order.submittedAt)}{order.filledAt ? ` · Executed ${istStamp(order.filledAt)}` : ""}</p>}
      <p className="truncate text-[10px] text-muted" title={order.id}>{order.id}</p>
      {order.reason ? <p className="text-loss">{order.reason}</p> : null}
    </article>
  );
}

function Metric({ label, value, tone = "text-text" }: { label: string; value: string; tone?: string }) {
  return <span className="min-w-0 text-[10px] text-muted">{label}<b className={cx("num mt-0.5 block truncate text-xs font-semibold", tone)}>{value || "Unavailable"}</b></span>;
}
function Field({ label, value, tone = "text-text", title }: { label: string; value: string; tone?: string; title?: string }) {
  return <div className="min-w-0" title={title}><dt className="text-[10px] text-muted">{label}</dt><dd className={cx("num truncate", tone)}>{value}</dd></div>;
}
function contractLabel(symbol: string) {
  const parsed = parseOptionLedgerSymbol(symbol);
  return parsed ? `${parsed.underlying} ${parsed.strike.toLocaleString("en-IN")} ${parsed.right} · ${parsed.expiry}` : symbol;
}
/** Formats ledger rupee text with ₹ and Indian grouping; signed when `signed` is true. */
function formatMaybe(text: string, signed = true) {
  const paise = parseRupees(text);
  if (paise == null) return text;
  return signed ? formatPnl(paise) : formatInr(paise);
}
function toneOfText(text: string) {
  return pnlTone(parseRupees(text));
}
function clockOf(seconds: number) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(seconds * 1000));
}
