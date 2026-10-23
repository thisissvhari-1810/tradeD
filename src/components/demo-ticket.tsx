"use client";

import { useRef, useState } from "react";
import { DemoModeBadge, StockLogo } from "@/components/stock-identity";
import { rupeesToPaise } from "@/lib/money";
import { calculateCharges } from "@/lib/trading/fees";
import { DEFAULT_CHARGES } from "@/lib/trading/settings";
import {
  buyingPower,
  demoAccount,
  demoUnrealized,
  formatDemoRupees,
  formatIst,
  practiceStats,
  type DemoBook,
  type DemoOrderType,
  type DemoTrade,
} from "@/lib/trading/demo-replay";
import type { ReplayStatus } from "@/lib/trading/replay-engine";
import { REPLAY_STATUS_LABEL } from "@/lib/trading/replay-engine";

export type DemoTicketInput = {
  side: "BUY" | "SELL";
  type: DemoOrderType;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
};

export function DemoTicket({
  symbol,
  date,
  cursor,
  status,
  price,
  timeframe,
  book,
  onSubmit,
  onCancel,
  onProtection,
  onAllowShort,
  onClose,
}: {
  symbol: string;
  date: string;
  cursor: number | null;
  status: ReplayStatus;
  price: number | null;
  timeframe: string;
  book: DemoBook;
  onSubmit: (input: DemoTicketInput) => { ok: true } | { ok: false; error: string };
  onCancel: (id: string) => void;
  onProtection: (stop: number | null, target: number | null) => { ok: true } | { ok: false; error: string };
  onAllowShort: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [type, setType] = useState<DemoOrderType>("MARKET");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [scope, setScope] = useState<"session" | "all">("session");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // A second tap within a moment of the first is ignored, so one tap places one order.
  const [sending, setSending] = useState(false);
  const lastSubmit = useRef(0);
  const position = book.positions.find((item) => item.symbol === symbol) ?? null;
  const markPaise = price != null ? Number(rupeesToPaise(price.toFixed(2))) : null;
  const marks = markPaise != null ? { [symbol]: markPaise } : {};
  const account = demoAccount(book, marks);
  const unrealized = position && markPaise != null ? demoUnrealized(book, marks) : null;
  const trades = (scope === "session" ? book.trades.filter((trade) => trade.sessionDate === date) : book.trades);
  const stats = practiceStats(trades, book.startPaise);
  const qty = Number(quantity);
  const workingPrice = type === "LIMIT" || type === "STOP_LIMIT" ? Number(limitPrice) : type === "STOP" ? Number(stopPrice) : price;
  const estimate = Number.isInteger(qty) && qty > 0 && workingPrice != null && Number.isFinite(workingPrice) && workingPrice > 0
    ? quoteEstimate(side, qty, workingPrice)
    : null;
  const risk = position && position.stopPaise ? Math.abs(position.avgPaise - position.stopPaise) * Math.abs(position.quantity) : null;
  const reward = position && position.targetPaise ? Math.abs(position.targetPaise - position.avgPaise) * Math.abs(position.quantity) : null;

  function submit() {
    const now = Date.now();
    if (now - lastSubmit.current < 800) return;
    lastSubmit.current = now;
    setSending(true);
    window.setTimeout(() => setSending(false), 800);
    const parsed = parseTicket(quantity, limitPrice, stopPrice, stopLoss, takeProfit, type);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const result = onSubmit({ side, type, ...parsed.value });
    if (!result.ok) {
      setError(result.error);
      setNotice("");
      return;
    }
    setError("");
    setNotice(resultText(side, type));
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-[var(--scrim)] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Paper trade ${symbol}`}>
      <div className="anim-sheet flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-sheet border border-border bg-panel text-text sm:rounded-2xl">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <StockLogo symbol={symbol} size={28} />
              <h2 className="text-sm font-semibold">{symbol}</h2>
              <DemoModeBadge>PAPER TRADING</DemoModeBadge>
            </div>
            <p className="mt-1 text-[0.6875rem] text-muted">{date || "No date"} · {cursor != null ? formatIst(cursor) : "Replay time unavailable"} · {timeframe} · {REPLAY_STATUS_LABEL[status]}</p>
          </div>
          <button type="button" className="h-10 rounded-lg px-3 text-xs text-muted active:bg-hover" aria-label="Close paper trade" onClick={onClose}>Close</button>
        </div>
        <p className="mt-2 text-[0.6875rem] text-info">Simulated price {price != null ? `₹${price.toFixed(2)}` : "—"}. A market order uses the open while the minute is forming, and the close after that minute ends. Stops and limits use only the revealed range.</p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <button type="button" className={`h-11 rounded-full font-semibold sm:h-9 ${side === "BUY" ? "bg-profit text-on-signal" : "border border-border text-muted"}`} onClick={() => setSide("BUY")}>Buy</button>
          <button type="button" className={`h-11 rounded-full font-semibold sm:h-9 ${side === "SELL" ? "bg-loss text-on-signal" : "border border-border text-muted"}`} onClick={() => setSide("SELL")}>Sell</button>
          <label className="text-[0.6875rem] text-muted">Quantity<input className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-8 text-text" value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="numeric" /></label>
          <label className="text-[0.6875rem] text-muted">Order<select className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-8" value={type} onChange={(event) => setType(event.target.value as DemoOrderType)}><option value="MARKET">Market</option><option value="LIMIT">Limit</option><option value="STOP">Stop</option><option value="STOP_LIMIT">Stop-limit</option></select></label>
          {type === "LIMIT" || type === "STOP_LIMIT" ? <label className="text-[0.6875rem] text-muted">Limit<input className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-8" value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} inputMode="decimal" /></label> : null}
          {type === "STOP" || type === "STOP_LIMIT" ? <label className="text-[0.6875rem] text-muted">Stop trigger<input className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-8" value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} inputMode="decimal" /></label> : null}
          <label className="text-[0.6875rem] text-muted">Stop-loss<input className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-8" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} inputMode="decimal" placeholder="Optional" /></label>
          <label className="text-[0.6875rem] text-muted">Target<input className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-8" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} inputMode="decimal" placeholder="Optional" /></label>
        </div>
        <label className="mt-2 flex items-center gap-2 text-[0.6875rem] text-muted"><input type="checkbox" checked={book.allowShort} onChange={(event) => onAllowShort(event.target.checked)} />Allow short selling. A sell above the long quantity opens a short.</label>
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[0.6875rem] text-muted">
          <span>Available <b className="num text-text">₹{formatDemoRupees(account.cashPaise)}</b></span>
          <span>Buying power <b className="num text-text">₹{formatDemoRupees(account.buyingPowerPaise)}</b></span>
          <span>Reserved <b className="num text-text">₹{formatDemoRupees(account.reservedPaise)}</b></span>
          <span>Equity <b className="num text-text">₹{formatDemoRupees(account.equityPaise)}</b></span>
          <span>Realized <b className={`num ${tone(account.realizedPaise)}`}>₹{formatDemoRupees(account.realizedPaise)}</b></span>
          <span>Charges <b className="num text-text">₹{formatDemoRupees(account.chargesPaise)}</b></span>
        </div>
        <p className="mt-2 text-[0.6875rem] text-muted">{estimate ? `Estimated value ₹${formatDemoRupees(estimate.notional)}. Fees ₹${formatDemoRupees(estimate.charges)}. Maximum trade value ₹${formatDemoRupees(Math.max(0, buyingPower(book, marks)))}.` : "Enter a quantity to estimate the order."} {side === "SELL" && position && position.quantity > 0 ? `You hold ${position.quantity}.` : ""} {side === "SELL" && (!position || position.quantity <= 0) && !book.allowShort ? "Sell closes a long. Short selling is off." : ""}</p>
        {position ? (
          <div className="mt-3 rounded-xl border border-border bg-elevated p-2 text-[0.6875rem]">
            <p className="text-muted">{position.quantity > 0 ? "Long" : "Short"} {Math.abs(position.quantity)} · Avg ₹{formatDemoRupees(position.avgPaise)} · Now {price != null ? `₹${price.toFixed(2)}` : "—"}</p>
            <p className={`num mt-1 font-semibold ${tone(unrealized)}`}>Unrealized {unrealized == null ? "—" : `₹${formatDemoRupees(unrealized)}`} {price != null && position.avgPaise ? `(${(((price * 100 - position.avgPaise) / position.avgPaise) * (position.quantity > 0 ? 1 : -1) * 100).toFixed(2)}%)` : ""}</p>
            <p className="mt-1 text-muted">Risk {risk == null ? "—" : `₹${formatDemoRupees(risk)}`} · Reward {reward == null ? "—" : `₹${formatDemoRupees(reward)}`}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="rounded-full border border-border px-2 py-1" onClick={() => {
                const result = onProtection(numberOrNull(stopLoss), numberOrNull(takeProfit));
                setError(result.ok ? "" : result.error);
                if (result.ok) setNotice("Stop and target updated.");
              }}>Update stop and target</button>
              <button type="button" className="rounded-full border border-border px-2 py-1" onClick={() => { const result = onProtection(null, null); setError(result.ok ? "" : result.error); }}>Remove levels</button>
            </div>
          </div>
        ) : <p className="mt-3 text-[0.6875rem] text-muted">No open paper position in {symbol}.</p>}
        {book.orders.filter((order) => order.status === "OPEN").map((order) => (
          <p key={order.id} className="mt-2 flex items-center justify-between gap-2 text-[0.6875rem] text-muted">
            <span>{order.status} · {order.side} {order.quantity} {order.symbol} {order.type} {order.sessionDate ?? ""} {order.reason}</span>
            <button type="button" className="text-loss" onClick={() => onCancel(order.id)}>Cancel</button>
          </p>
        ))}
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex items-center gap-2 text-[0.6875rem]">
            <span className="font-semibold">Trades</span>
            <button type="button" className={scope === "session" ? "text-primary" : "text-muted"} onClick={() => setScope("session")}>This date</button>
            <button type="button" className={scope === "all" ? "text-primary" : "text-muted"} onClick={() => setScope("all")}>All sessions</button>
          </div>
          <p className="mt-1 text-[0.6875rem] text-muted">{stats.trades} trades · Wins {stats.wins} · Losses {stats.losses} · Win rate {stats.winRate == null ? "—" : `${(stats.winRate * 100).toFixed(0)}%`} · Net <span className={tone(stats.net)}>₹{formatDemoRupees(stats.net)}</span> · Drawdown ₹{formatDemoRupees(stats.maxDrawdown)}</p>
          <div className="mt-2 space-y-1">
            {trades.length === 0 ? <p className="text-[0.6875rem] text-muted">No closed paper trades in this view.</p> : trades.slice().reverse().slice(0, 8).map((trade) => <TradeRow key={trade.id} trade={trade} />)}
          </div>
        </div>
        <p className="mt-3 text-[0.625rem] text-muted">This book stays in this browser. It is not sent to a broker or the practice ledger. Changing timeframe does not reset it.</p>
      </div>
      <div className="shrink-0 border-t border-border bg-panel px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        {error ? <p className="mb-2 text-[0.6875rem] text-warning" role="alert">{error}</p> : null}
        {notice ? <p className="mb-2 text-[0.6875rem] text-info" role="status">{notice}</p> : null}
        <button type="button" disabled={sending} className={`h-12 w-full rounded-full text-sm font-semibold disabled:opacity-60 sm:h-10 ${side === "BUY" ? "bg-profit text-on-signal" : "bg-loss text-on-signal"}`} onClick={submit}>{sending ? "Placing…" : side === "BUY" ? "Confirm buy" : "Confirm sell"}</button>
      </div>
      </div>
    </div>
  );
}

function TradeRow({ trade }: { trade: DemoTrade }) {
  const minutes = Math.max(0, Math.round((trade.exitTime - trade.entryTime) / 60));
  return (
    <p className="text-[0.6875rem] text-muted">
      {trade.symbol} {trade.side} {trade.quantity} · {formatIst(trade.entryTime)} ₹{formatDemoRupees(trade.entryPaise)} → {formatIst(trade.exitTime)} ₹{formatDemoRupees(trade.exitPaise)} · {minutes}m · {trade.exitReason} · <span className={tone(trade.netPaise)}>₹{formatDemoRupees(trade.netPaise)}</span>
    </p>
  );
}

function tone(value: number | null): string {
  if (value == null || value === 0) return "text-muted";
  return value > 0 ? "text-profit" : "text-loss";
}

function quoteEstimate(side: "BUY" | "SELL", quantity: number, price: number) {
  const paise = Number(rupeesToPaise(price.toFixed(2)));
  const notional = paise * quantity;
  const charges = Number(calculateCharges(side, BigInt(paise) * BigInt(quantity), DEFAULT_CHARGES).total);
  return { notional, charges };
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTicket(quantity: string, limit: string, stop: string, stopLoss: string, target: string, type: DemoOrderType): { ok: true; value: Omit<DemoTicketInput, "side" | "type"> } | { ok: false; error: string } {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Enter a whole number of shares." };
  const limitPrice = numberOrNull(limit);
  const stopPrice = numberOrNull(stop);
  if ((type === "LIMIT" || type === "STOP_LIMIT") && (limitPrice == null || limitPrice <= 0)) return { ok: false, error: "Enter a limit price in rupees." };
  if ((type === "STOP" || type === "STOP_LIMIT") && (stopPrice == null || stopPrice <= 0)) return { ok: false, error: "Enter a stop trigger in rupees." };
  return { ok: true, value: { quantity: qty, limitPrice, stopPrice, stopLoss: numberOrNull(stopLoss), takeProfit: numberOrNull(target) } };
}

function resultText(side: "BUY" | "SELL", type: DemoOrderType): string {
  if (type === "MARKET") return `${side === "BUY" ? "Buy" : "Sell"} filled at the revealed replay price.`;
  return `${side === "BUY" ? "Buy" : "Sell"} ${type.toLowerCase()} order accepted. It fills only when the revealed range reaches it.`;
}
