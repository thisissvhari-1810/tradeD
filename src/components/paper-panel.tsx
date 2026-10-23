"use client";

import { useState } from "react";
import { formatInr, rupeesToPaise } from "@/lib/money";
import {
  buyingPower,
  demoAccount,
  fundsForBuy,
  formatDemoRupees,
  formatIst,
  maxBuyQuantity,
  positionResult,
  practiceStats,
  type DemoBook,
  type DemoOrderType,
} from "@/lib/trading/demo-replay";
import { REPLAY_STATUS_LABEL, type ReplayStatus } from "@/lib/trading/replay-engine";

export type PaperOrderInput = {
  side: "BUY" | "SELL";
  type: DemoOrderType;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  idempotencyKey?: string;
};

export type LedgerSnapshot = {
  startingCapital: string;
  allocatedCapital?: string;
  cashAvailable: string;
  cashReserved: string;
  equity: string;
  realized: string;
  unrealized: string;
  holdingsValue: string;
  positions: Array<{ symbol: string; name: string; quantity: number; averageCost: string; mark: string | null; marketValue?: string | null; unrealized: string | null; realized: string }>;
};

const STARTS = ["100000", "500000", "1000000"] as const;

export function PaperPanel({
  symbol,
  name,
  product,
  date,
  cursor,
  status,
  price,
  previousClose,
  timeframe,
  book,
  ledger = null,
  accountMode = false,
  onSubmit,
  onCancel,
  onAllowShort,
  onWatchlist,
  onReset,
}: {
  symbol: string;
  name: string;
  product: "equity" | "index";
  date: string;
  cursor: number | null;
  status: ReplayStatus;
  price: number | null;
  previousClose: number | null;
  timeframe: string;
  book: DemoBook;
  ledger?: LedgerSnapshot | null;
  accountMode?: boolean;
  onSubmit: (input: PaperOrderInput) => Promise<{ ok: true } | { ok: false; error: string }>;
  onCancel: (id: string) => void;
  onAllowShort: (enabled: boolean) => void;
  onWatchlist: () => void;
  onReset: (rupees: string) => void;
}) {
  const [tab, setTab] = useState<"trade" | "positions" | "orders" | "history">("trade");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [type, setType] = useState<DemoOrderType>("MARKET");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<PaperOrderInput | null>(null);
  const [customStart, setCustomStart] = useState("1000000");
  const saved = accountMode || ledger != null;
  const ready = status === "ready" || status === "playing" || status === "paused" || status === "completed";
  const markPaise = price != null && price > 0 ? Number(rupeesToPaise(price.toFixed(2))) : null;
  const marks = markPaise != null ? { [symbol]: markPaise } : {};
  const account = demoAccount(book, marks);
  const position = book.positions.find((item) => item.symbol === symbol) ?? null;
  const held = position?.quantity ?? 0;
  const change = price != null && previousClose != null ? price - previousClose : null;
  const changePct = change != null && previousClose ? (change / previousClose) * 100 : null;
  const working = type === "LIMIT" || type === "STOP_LIMIT" ? Number(limitPrice) : type === "STOP" ? Number(stopPrice) : price;
  const qty = Number(quantity);
  const estimate = side === "BUY" && Number.isInteger(qty) && qty > 0 && working != null && Number.isFinite(working) && working > 0 ? fundsForBuy(book, working, qty, marks, product, symbol) : null;
  const affordable = price != null ? maxBuyQuantity(book, price, marks) : 0;
  const unrealized = book.positions.reduce((sum, item) => sum + (positionResult(item, item.symbol === symbol ? markPaise : null)?.pnlPaise ?? 0), 0);

  // A new symbol starts with no pending confirmation or message (adjusted during render, not in an effect).
  const [messagesFor, setMessagesFor] = useState(symbol);
  if (messagesFor !== symbol) {
    setMessagesFor(symbol);
    setConfirm(null);
    setError("");
    setNotice("");
  }

  function prepare(nextSide: "BUY" | "SELL") {
    setSide(nextSide);
    const parsed = parseOrder(quantity, limitPrice, stopPrice, stopLoss, takeProfit, type);
    if (!parsed.ok) {
      setError(parsed.error);
      setConfirm(null);
      return;
    }
    if (!ready || price == null || cursor == null) {
      setError("Turn Demo on and wait for this session’s candles. Orders use the replay price, not the live quote.");
      setConfirm(null);
      return;
    }
    const heldNow = saved ? (ledger?.positions.find((item) => item.symbol === symbol)?.quantity ?? 0) : held;
    if (nextSide === "SELL" && parsed.value.quantity > Math.max(0, heldNow) && (saved || !book.allowShort)) {
      setError(`You hold ${Math.max(0, heldNow)} ${product === "index" ? "units" : "shares"}. Selling more than that is not allowed on this account.`);
      setConfirm(null);
      return;
    }
    if (nextSide === "BUY" && !saved) {
      const preview = fundsForBuy(book, working != null && working > 0 ? working : price, parsed.value.quantity, marks, product, symbol);
      if (!preview.ok) {
        setError(preview.error);
        setConfirm(null);
        return;
      }
    }
    setError("");
    setConfirm({ side: nextSide, type, ...parsed.value, idempotencyKey: crypto.randomUUID() });
  }

  async function submitConfirmed() {
    if (!confirm) return;
    const result = await onSubmit(confirm);
    if (!result.ok) {
      setError(result.error);
      setNotice("");
      return;
    }
    setConfirm(null);
    setError("");
    setNotice(saved ? `${confirm.side === "BUY" ? "Buy" : "Sell"} was saved on the demo account. It was not sent to a broker.` : `${confirm.side === "BUY" ? "Buy" : "Sell"} accepted on the replay book. It was not sent to a broker.`);
    if (confirm.side === "BUY") setTab("positions");
  }

  async function closePosition(item: { symbol: string; quantity: number }) {
    if (price == null) {
      setError("The replay price is not available, so the position cannot be closed.");
      return;
    }
    const result = await onSubmit({ side: item.quantity > 0 ? "SELL" : "BUY", type: "MARKET", quantity: Math.abs(item.quantity), limitPrice: null, stopPrice: null, stopLoss: null, takeProfit: null, idempotencyKey: crypto.randomUUID() });
    if (!result.ok) setError(result.error);
    else {
      setError("");
      setNotice(saved ? `${item.symbol} close was saved on the demo account.` : `${item.symbol} close was filled on the replay book.`);
      setTab(saved ? "positions" : "history");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-text">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{name}</div>
            <div className="text-[0.6875rem] text-muted">{symbol} · {product === "index" ? "Index" : "NSE equity"}</div>
          </div>
          <button type="button" className="shrink-0 rounded border border-border px-2 py-1 text-[0.625rem] text-primary" onClick={onWatchlist}>Watchlist</button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="rounded bg-demo/15 px-1.5 py-0.5 text-[0.625rem] font-semibold text-demo">PAPER</span>
          <span className="text-[0.625rem] text-muted">{REPLAY_STATUS_LABEL[status]}</span>
          <span className="ml-auto text-[0.625rem] text-info">{cursor != null ? formatIst(cursor) : date || "No session"}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="num text-base font-semibold">{price != null ? inr(price) : "—"}</span>
          <span className={`num text-[0.6875rem] ${change == null ? "text-muted" : change > 0 ? "text-profit" : change < 0 ? "text-loss" : "text-muted"}`}>
            {change == null || changePct == null ? "Prev close —" : `${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`}
          </span>
        </div>
        <p className="text-[0.625rem] text-muted">{timeframe} · {date || "No replay date"} · prev close {previousClose != null ? previousClose.toFixed(2) : "—"}</p>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-b border-border bg-panel px-3 py-2 text-[0.625rem] text-muted">
        {saved ? (
          <>
            <Metric label="Allocated" value={ledger?.allocatedCapital ?? ledger?.startingCapital ?? "—"} />
            <Metric label="Buying power" value={ledger?.cashAvailable ?? "—"} />
            <Metric label="Reserved" value={ledger?.cashReserved ?? "—"} />
            <Metric label="Open value" value={ledger?.holdingsValue ?? "—"} />
            <Metric label="Realized" value={ledger?.realized ?? "—"} />
            <Metric label="Unrealized" value={ledger ? (selectedReplayPnl(ledger, symbol, price) ?? ledger.unrealized) : "—"} />
            <Metric label="Equity" value={ledger?.equity ?? "—"} />
            <Metric label="Positions" value={String(ledger?.positions.length ?? 0)} />
          </>
        ) : (
          <>
            <Metric label="Start" value={inrPaise(account.startPaise)} />
            <Metric label="Buying power" value={inrPaise(account.buyingPowerPaise)} />
            <Metric label="Reserved" value={inrPaise(account.reservedPaise)} />
            <Metric label="Open value" value={inrPaise(Math.abs(account.marketValuePaise))} />
            <Metric label="Realized" value={signed(account.realizedPaise)} tone={account.realizedPaise} />
            <Metric label="Unrealized" value={book.positions.length ? signed(unrealized) : "—"} tone={unrealized} />
            <Metric label="Equity" value={inrPaise(account.equityPaise)} />
            <Metric label="Positions" value={String(book.positions.length)} />
          </>
        )}
      </div>
      <div className="flex border-b border-border text-[0.6875rem]">
        {(["trade", "positions", "orders", "history"] as const).map((item) => (
          <button key={item} type="button" className={`flex-1 py-1.5 capitalize ${tab === item ? "text-primary" : "text-muted"}`} onClick={() => setTab(item)}>{item}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {status === "loading" ? <p className="text-[0.6875rem] text-info">Loading the selected session.</p> : null}
        {status === "error" ? <p className="text-[0.6875rem] text-warning">This session has no replay candles, so a paper order cannot be priced.</p> : null}
        {status === "completed" ? <p className="mb-2 text-[0.6875rem] text-demo">This session is complete. The paper book is unchanged until you place or close a trade.</p> : null}
        {tab === "trade" ? (
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={`rounded py-2 text-xs font-semibold ${side === "BUY" ? "bg-profit text-on-signal" : "border border-border text-muted"}`} onClick={() => prepare("BUY")}>Buy</button>
              <button type="button" className={`rounded py-2 text-xs font-semibold ${side === "SELL" ? "bg-loss text-on-signal" : "border border-border text-muted"}`} onClick={() => prepare("SELL")}>Sell</button>
            </div>
            <label className="text-[0.625rem] text-muted">{product === "index" ? "Units" : "Shares"}
              <input className="mt-1 w-full rounded border border-border bg-panel px-2 py-1 text-xs text-text" value={quantity} onChange={(event) => { setQuantity(event.target.value); setConfirm(null); }} inputMode="numeric" aria-label={product === "index" ? "Units" : "Shares"} />
            </label>
            <p className="text-[0.625rem] text-muted">{product === "index" ? "An index unit is priced at the index value. This is not a futures lot." : "Cash equity, one share per unit."} Held {Math.abs(saved ? (ledger?.positions.find((item) => item.symbol === symbol)?.quantity ?? 0) : held)}. {saved ? `Available ${ledger?.cashAvailable ?? "—"}.` : `Max buy ${affordable}.`}</p>
            <label className="text-[0.625rem] text-muted">Order
              <select className="mt-1 w-full rounded border border-border bg-panel px-2 py-1 text-xs" value={type} onChange={(event) => { setType(event.target.value as DemoOrderType); setConfirm(null); }}>
                <option value="MARKET">Market</option>
                <option value="LIMIT">Limit</option>
                <option value="STOP">Stop</option>
                <option value="STOP_LIMIT">Stop-limit</option>
              </select>
            </label>
            {type === "LIMIT" || type === "STOP_LIMIT" ? <Field label="Limit" value={limitPrice} onChange={setLimitPrice} /> : null}
            {type === "STOP" || type === "STOP_LIMIT" ? <Field label="Stop trigger" value={stopPrice} onChange={setStopPrice} /> : null}
            <Field label="Stop-loss" value={stopLoss} onChange={setStopLoss} />
            <Field label="Target" value={takeProfit} onChange={setTakeProfit} />
            <p className="text-[0.625rem] text-muted">{estimate && !saved ? `Value ${inrPaise(estimate.notionalPaise)}. Charges ${inrPaise(estimate.chargesPaise)}. Required ${inrPaise(estimate.requiredPaise)}. Buying power ${inrPaise(buyingPower(book, marks))}.` : saved ? `The account checks buying power on the server. Available ${ledger?.cashAvailable ?? "—"}.` : "Enter a quantity to estimate the order."}</p>
            {saved ? <p className="text-[0.625rem] text-muted">Short selling is off. Stop-loss and target levels are not stored on the account.</p> : <label className="flex items-center gap-2 text-[0.625rem] text-muted"><input type="checkbox" checked={book.allowShort} onChange={(event) => onAllowShort(event.target.checked)} />Allow short selling</label>}
            {confirm ? (
              <div className="rounded border border-border bg-elevated p-2 text-[0.6875rem]">
                <p>Confirm {confirm.side === "BUY" ? "buy" : "sell"} {confirm.quantity} {symbol} {confirm.type.toLowerCase()} at the revealed replay price.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className={`rounded px-2 py-1 font-semibold ${confirm.side === "BUY" ? "bg-profit text-on-signal" : "bg-loss text-on-signal"}`} onClick={submitConfirmed}>Confirm</button>
                  <button type="button" className="rounded border border-border px-2 py-1" onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              </div>
            ) : null}
            <button type="button" className="text-left text-[0.625rem] text-primary" onClick={() => setQuantity(String(Math.max(affordable, 0)))}>Use maximum affordable quantity</button>
          </div>
        ) : null}
        {tab === "positions" && saved ? (
          !ledger ? <p className="text-[0.6875rem] text-muted">Loading the demo account.</p> : ledger.positions.length === 0 ? <p className="text-[0.6875rem] text-muted">No open positions on this demo account.</p> : ledger.positions.map((item) => {
            const replay = item.symbol === symbol ? selectedReplayPnl(ledger, symbol, price) : null;
            return (
              <article key={item.symbol} className="mb-2 rounded border border-border bg-elevated p-2 text-[0.6875rem]">
                <div className="flex items-center justify-between"><span className="font-semibold">{item.symbol}</span><span className="text-profit">LONG</span></div>
                <p className="mt-1 text-muted">Entry {item.averageCost} · Current {item.symbol === symbol && price != null ? inr(price) : item.mark ?? "—"} · Qty {item.quantity}</p>
                <p className="text-muted">Unrealized {replay ?? item.unrealized ?? "—"} · Realized {item.realized}</p>
                <button type="button" className="mt-2 rounded border border-loss px-2 py-1 text-loss" onClick={() => void closePosition(item)}>Close position</button>
              </article>
            );
          })
        ) : null}
        {tab === "positions" && !ledger ? (
          book.positions.length === 0 ? <p className="text-[0.6875rem] text-muted">No open paper positions.</p> : book.positions.map((item) => {
            const result = positionResult(item, item.symbol === symbol ? markPaise : null);
            return (
              <article key={item.symbol} className="mb-2 rounded border border-border bg-elevated p-2 text-[0.6875rem]">
                <div className="flex items-center justify-between"><span className="font-semibold">{item.symbol}</span><span className={item.quantity > 0 ? "text-profit" : "text-loss"}>{item.quantity > 0 ? "LONG" : "SHORT"}</span></div>
                <p className="mt-1 text-muted">Entry {inrPaise(item.avgPaise)} · Current {item.symbol === symbol && price != null ? inr(price) : "—"} · Qty {Math.abs(item.quantity)}</p>
                <p className="text-muted">Value {result ? inrPaise(result.valuePaise) : "—"}</p>
                <p className={result == null ? "text-muted" : result.pnlPaise > 0 ? "text-profit" : result.pnlPaise < 0 ? "text-loss" : "text-muted"}>Unrealized {result ? signed(result.pnlPaise) : "—"} · Return on entry value {result?.percent == null ? "—" : `${result.percent >= 0 ? "+" : ""}${result.percent.toFixed(2)}%`}</p>
                <p className="text-muted">Stop {item.stopPaise ? inrPaise(item.stopPaise) : "—"} · Target {item.targetPaise ? inrPaise(item.targetPaise) : "—"}</p>
                <button type="button" className="mt-2 rounded border border-loss px-2 py-1 text-loss" onClick={() => closePosition(item)}>Close position</button>
              </article>
            );
          })
        ) : null}
        {tab === "orders" && saved ? <p className="text-[0.6875rem] text-muted">Resting replay orders stay on the account until the revealed range touches them. They are not filled from the live quote.</p> : null}
        {tab === "orders" && !ledger ? (
          book.orders.length === 0 ? <p className="text-[0.6875rem] text-muted">No paper orders.</p> : book.orders.slice().reverse().slice(0, 20).map((order) => (
            <p key={order.id} className="mb-2 flex items-center justify-between gap-2 text-[0.6875rem] text-muted">
              <span>{order.side} {order.quantity} {order.symbol} {order.type} · {order.status}{order.reason ? ` · ${order.reason}` : ""}</span>
              {order.status === "OPEN" ? <button type="button" className="text-loss" onClick={() => onCancel(order.id)}>Cancel</button> : null}
            </p>
          ))
        ) : null}
        {tab === "history" ? saved ? <p className="text-[0.6875rem] text-muted">Closed trades are stored on the demo account. Open Portfolio to see entry, exit, fees, and net P&amp;L. Older browser-only trades are not part of that account.</p> : <History book={book} date={date} /> : null}
        {error ? <p className="mt-2 text-[0.6875rem] text-warning" role="alert">{error}</p> : null}
        {notice ? <p className="mt-2 text-[0.6875rem] text-info">{notice}</p> : null}
        {error.includes("Shortfall") ? (
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" className="rounded border border-border px-2 py-1 text-[0.625rem]" onClick={() => { setQuantity(String(Math.max(affordable, 0))); setError(""); }}>Reduce quantity</button>
            <button type="button" className="rounded border border-border px-2 py-1 text-[0.625rem]" onClick={() => setTab("positions")}>Close a position</button>
          </div>
        ) : null}
      </div>
      <div className="border-t border-border px-3 py-2">
        {saved ? <p className="text-[0.625rem] text-muted">Demo capital is allocated by an admin. This panel cannot add or reset it.</p> : <>
        <p className="text-[0.625rem] text-muted">Starting balance. Reset asks before it replaces this book.</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {STARTS.map((amount) => <button key={amount} type="button" className="rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-muted" onClick={() => onReset(amount)}>₹{Number(amount).toLocaleString("en-IN")}</button>)}
        </div>
        <div className="mt-1 flex gap-1">
          <input className="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1 text-[0.6875rem]" value={customStart} onChange={(event) => setCustomStart(event.target.value)} aria-label="Custom starting rupees" inputMode="decimal" />
          <button type="button" className="rounded border border-border px-2 py-1 text-[0.625rem]" onClick={() => onReset(customStart)}>Reset</button>
        </div>
        </>}
      </div>
    </div>
  );
}

function History({ book, date }: { book: DemoBook; date: string }) {
  const [scope, setScope] = useState<"session" | "all">("session");
  const trades = scope === "session" ? book.trades.filter((trade) => trade.sessionDate === date) : book.trades;
  const stats = practiceStats(trades, book.startPaise);
  return (
    <div>
      <div className="mb-2 flex gap-2 text-[0.6875rem]">
        <button type="button" className={scope === "session" ? "text-primary" : "text-muted"} onClick={() => setScope("session")}>This date</button>
        <button type="button" className={scope === "all" ? "text-primary" : "text-muted"} onClick={() => setScope("all")}>All sessions</button>
      </div>
      <p className="text-[0.625rem] text-muted">{stats.trades} trades · Wins {stats.wins} · Losses {stats.losses} · Win rate {stats.winRate == null ? "—" : `${(stats.winRate * 100).toFixed(0)}%`} · Net <span className={stats.net > 0 ? "text-profit" : stats.net < 0 ? "text-loss" : ""}>{signed(stats.net)}</span></p>
      {trades.length === 0 ? <p className="mt-2 text-[0.6875rem] text-muted">No closed paper trades in this view.</p> : trades.slice().reverse().slice(0, 12).map((trade) => {
        const basis = trade.entryPaise * trade.quantity;
        const percent = basis ? (trade.netPaise / basis) * 100 : null;
        return (
          <p key={trade.id} className="mt-2 text-[0.625rem] text-muted">
            {trade.symbol} {trade.side} {trade.quantity} · {formatIst(trade.entryTime)} {inrPaise(trade.entryPaise)} → {formatIst(trade.exitTime)} {inrPaise(trade.exitPaise)} · {signed(trade.netPaise)} · {percent == null ? "—" : `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`} · fees {inrPaise(trade.chargesPaise)} · {trade.exitReason} · {trade.sessionDate}
          </p>
        );
      })}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="text-[0.625rem] text-muted">{label}
      <input className="mt-1 w-full rounded border border-border bg-panel px-2 py-1 text-xs text-text" value={value} onChange={(event) => onChange(event.target.value)} inputMode="decimal" />
    </label>
  );
}

function selectedReplayPnl(ledger: LedgerSnapshot, symbol: string, price: number | null): string | null {
  const position = ledger.positions.find((item) => item.symbol === symbol);
  if (!position || price == null) return null;
  const average = Number(position.averageCost);
  if (!Number.isFinite(average)) return null;
  const pnl = (price - average) * position.quantity;
  const text = Math.abs(pnl).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return pnl > 0 ? `+₹${text}` : pnl < 0 ? `-₹${text}` : `₹${text}`;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const color = tone == null || tone === 0 ? "text-text" : tone > 0 ? "text-profit" : "text-loss";
  return <span>{label} <b className={`num float-right ${color}`}>{value}</b></span>;
}

function inr(rupees: number): string {
  return formatInr(rupeesToPaise(rupees.toFixed(2)));
}

function inrPaise(paise: number): string {
  return formatInr(BigInt(Math.round(paise)));
}

function signed(paise: number): string {
  const text = formatDemoRupees(paise);
  if (paise > 0) return `+₹${text}`;
  if (paise < 0) return `-₹${text.replace("-", "")}`;
  return `₹${text}`;
}

function parseOrder(quantity: string, limit: string, stop: string, stopLoss: string, target: string, type: DemoOrderType): { ok: true; value: Omit<PaperOrderInput, "side" | "type"> } | { ok: false; error: string } {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Enter a whole number above zero." };
  const limitPrice = numberOrNull(limit);
  const stopPrice = numberOrNull(stop);
  if ((type === "LIMIT" || type === "STOP_LIMIT") && (limitPrice == null || limitPrice <= 0)) return { ok: false, error: "Enter a limit price in rupees." };
  if ((type === "STOP" || type === "STOP_LIMIT") && (stopPrice == null || stopPrice <= 0)) return { ok: false, error: "Enter a stop trigger in rupees." };
  return { ok: true, value: { quantity: qty, limitPrice, stopPrice, stopLoss: numberOrNull(stopLoss), takeProfit: numberOrNull(target) } };
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
