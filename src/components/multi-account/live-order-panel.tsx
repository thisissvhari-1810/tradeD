"use client";

import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, Clock, KeyRound, Link2, Link2Off, Lock, Minus, Plus, RefreshCw, ShieldAlert, Unplug } from "lucide-react";
import { api, istStamp } from "@/components/api";
import { contractLabel, expiryLabel, FIELD, inr, LABEL } from "@/components/multi-account/format";
import { useChain } from "@/components/multi-account/use-chain";
import { Badge, Button, cx, Drawer, Notice, SegmentedControl, type Tone } from "@/components/ui";
import { FEATURED_INDICES } from "@/lib/market/indices";
import type { LiveGate } from "@/lib/multi-account/compliance";
import type { ConnectionState, LiveAccount } from "@/lib/multi-account/live";

const CONNECTION: Record<ConnectionState, { label: string; tone: Tone; icon: typeof Link2 }> = {
  NOT_CONNECTED: { label: "Not connected", tone: "neutral", icon: Link2Off },
  AUTH_REQUIRED: { label: "Authentication required", tone: "warning", icon: KeyRound },
  EXPIRED: { label: "Authorization expired", tone: "loss", icon: Clock },
  CONNECTED: { label: "Connected", tone: "profit", icon: Link2 },
  DATA_UNAVAILABLE: { label: "Partly synced", tone: "warning", icon: CircleAlert },
  ERROR: { label: "Connection error", tone: "loss", icon: Unplug },
};

export function StateChip({ state, syncing }: { state: ConnectionState; syncing?: boolean }) {
  if (syncing && (state === "CONNECTED" || state === "DATA_UNAVAILABLE")) return <Badge tone="info"><RefreshCw className="h-3 w-3 animate-spin" aria-hidden />Synchronising</Badge>;
  const meta = CONNECTION[state];
  const Icon = meta.icon;
  return <Badge tone={meta.tone}><Icon className="h-3 w-3" aria-hidden />{meta.label}</Badge>;
}

const UNDERLYINGS = [...new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", ...FEATURED_INDICES.map((item) => item.symbol)])];

type LiveOrderRow = { id: string; symbol: string; side: "BUY" | "SELL"; quantity: number; orderType: string; pricePaise: number | null; status: string; brokerStatus: string; filledQuantity: number; avgPricePaise: number | null; reason: string; createdAt: string; final: boolean; brokerOrderId: string | null };
type LegResult = { accountId: string; ok: boolean; order?: LiveOrderRow; duplicate?: boolean; error?: { message: string; code: string } };

const STATUS_TONE: Record<string, Tone> = { SUBMITTING: "info", PENDING: "info", PARTIAL: "warning", FILLED: "profit", REJECTED: "loss", CANCELLED: "neutral", EXPIRED: "neutral", UNKNOWN: "warning" };
const STATUS_LABEL: Record<string, string> = { SUBMITTING: "Sending", PENDING: "Open", PARTIAL: "Part filled", FILLED: "Filled", REJECTED: "Rejected", CANCELLED: "Cancelled", EXPIRED: "Expired", UNKNOWN: "Unconfirmed" };

function segmentFor(underlying: string) {
  return underlying === "SENSEX" || underlying === "BANKEX" ? "BSE_FNO" : "NSE_FNO";
}

function rupeesToPaise(text: string) {
  const value = Number(text.replace(/,/g, "").trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
}

function LiveOrdersList({ reloadToken, enabled }: { reloadToken: number; enabled: boolean }) {
  const [orders, setOrders] = useState<LiveOrderRow[] | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [cancelId, setCancelId] = useState("");
  useEffect(() => {
    let stop = false;
    api<{ orders: LiveOrderRow[] }>("/api/live-orders")
      .then((data) => { if (!stop) setOrders(data.orders); })
      .catch((caught: unknown) => { if (!stop) setNote(caught instanceof Error ? caught.message : "Orders could not be loaded."); });
    return () => { stop = true; };
  }, [reloadToken]);
  const act = async (id: string, action: "reconcile" | "cancel") => {
    setBusy(id);
    setNote("");
    try {
      const result = await api<{ order: LiveOrderRow; message?: string }>("/api/live-orders", action === "cancel" ? { action, orderId: id, confirmed: true } : { action, orderId: id });
      setOrders((current) => current?.map((item) => (item.id === id ? result.order : item)) ?? null);
      if (result.message) setNote(result.message);
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy("");
      setCancelId("");
    }
  };
  if (!orders?.length) return note ? <p className="text-micro text-warning">{note}</p> : null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-dense font-semibold text-text">Orders sent from TradeD</h3>
      {note ? <p className="text-micro text-warning">{note}</p> : null}
      <ul className="flex flex-col gap-1.5">
        {orders.slice(0, 8).map((order) => (
          <li key={order.id} className="rounded-input border border-border-soft bg-sunken px-2.5 py-2 text-data">
            <div className="flex items-center gap-1.5">
              <Badge tone={STATUS_TONE[order.status] ?? "neutral"}>{STATUS_LABEL[order.status] ?? order.status}</Badge>
              <span className={cx("font-semibold", order.side === "BUY" ? "text-profit" : "text-loss")}>{order.side}</span>
              <span className="min-w-0 flex-1 truncate" title={order.symbol}>{order.symbol}</span>
              <span className="num text-muted" title="Filled / ordered">{order.filledQuantity}/{order.quantity}</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-micro text-muted">
              <span className="num">{istStamp(order.createdAt)}</span>
              {order.avgPricePaise != null ? <span className="num">· avg {inr(order.avgPricePaise)}</span> : null}
              <span className="ml-auto flex gap-1">
                {!order.final ? <Button size="sm" variant="ghost" disabled={busy === order.id} onClick={() => void act(order.id, "reconcile")} icon={<RefreshCw className={cx("h-3 w-3", busy === order.id && "animate-spin")} />}>Status</Button> : null}
                {enabled && order.brokerOrderId && (order.status === "PENDING" || order.status === "PARTIAL")
                  ? cancelId === order.id
                    ? <Button size="sm" variant="danger" disabled={busy === order.id} onClick={() => void act(order.id, "cancel")}>Confirm cancel</Button>
                    : <Button size="sm" variant="secondary" onClick={() => setCancelId(order.id)}>Cancel</Button>
                  : null}
              </span>
            </div>
            {order.reason ? <p className={cx("mt-1 text-micro", order.status === "REJECTED" ? "text-loss" : "text-warning")}>{order.reason}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LiveOrderPanel({ accounts, reloadToken, gate }: { accounts: LiveAccount[]; reloadToken: number; gate: LiveGate }) {
  const { underlying, expiry, strike, setUnderlying, setExpiry, setStrike, chain, chainError, chainLoading } = useChain(reloadToken);
  const [right, setRight] = useState<"CE" | "PE">("CE");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [product, setProduct] = useState<"INTRADAY" | "MARGIN">("INTRADAY");
  const [limitText, setLimitText] = useState("");
  const [lots, setLots] = useState(1);
  const [reviewing, setReviewing] = useState(false);
  const [requestKey, setRequestKey] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [results, setResults] = useState<LegResult[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [accountLots, setAccountLots] = useState<Record<string, number>>({});
  const [ordersReload, setOrdersReload] = useState(0);
  const lotSize = chain?.lotSize ?? null;
  const row = chain?.strikes.find((item) => item.strike === strike) ?? null;
  const leg = chain?.available && chain.expiry === expiry ? (right === "CE" ? row?.ce : row?.pe) ?? null : null;
  const ltpPaise = leg?.ltp != null && leg.ltp > 0 ? Math.round(leg.ltp * 100) : null;
  const eligible = accounts.filter((account) => account.tradingReady && account.target);
  const legs = eligible.filter((account) => picked[account.target!] !== false).map((account) => ({ account, lots: accountLots[account.target!] ?? lots }));
  const quantity = lotSize ? lots * lotSize : null;
  const totalQuantity = lotSize ? legs.reduce((sum, item) => sum + item.lots * lotSize, 0) : null;
  const limitPaise = orderType === "LIMIT" ? rupeesToPaise(limitText) : null;
  const unitPaise = limitPaise ?? ltpPaise;
  const estimate = totalQuantity && unitPaise ? unitPaise * totalQuantity : null;
  const ready = Boolean(chain?.available && expiry && strike != null && lotSize && leg?.securityId && (orderType === "MARKET" || limitPaise));
  const label = strike != null ? contractLabel({ underlying, expiry, strike, right }) : "Choose a contract";
  const live = gate.enabled && eligible.length > 0;
  const summary = `${side} ${label}${orderType === "LIMIT" ? ` @ ₹${limitText || "—"}` : " at market"} · ${legs.length} ${legs.length === 1 ? "account" : "accounts"}`;
  const nameOf = (target: string) => accounts.find((account) => account.target === target)?.nickname ?? target;

  const openReview = () => {
    // One key per review: a double click or a retry after a lost response cannot create a second order.
    setRequestKey(crypto.randomUUID());
    setUnderstood(false);
    setSendError("");
    setResults(null);
    setReviewing(true);
  };

  const send = async () => {
    if (!leg?.securityId || !lotSize || legs.length === 0) return;
    setSending(true);
    setSendError("");
    try {
      const placed = await api<{ results: LegResult[] }>("/api/live-orders", {
        action: "placeMany",
        key: requestKey,
        confirmed: true,
        intent: {
          exchangeSegment: segmentFor(underlying),
          securityId: leg.securityId,
          symbol: `${label}${expiry ? ` ${expiryLabel(expiry)}` : ""}`.slice(0, 80),
          side,
          productType: product,
          orderType,
          lotSize,
          pricePaise: orderType === "LIMIT" ? limitPaise : null,
          referencePaise: ltpPaise,
        },
        legs: legs.map((item) => ({ accountId: item.account.target!, quantity: item.lots * lotSize })),
      });
      setResults(placed.results);
      setOrdersReload((value) => value + 1);
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : "The order could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {live
        ? <Notice tone="warning"><ShieldAlert className="mr-1 inline h-3.5 w-3.5" aria-hidden />LIVE: orders placed here are real and use real money in your Dhan account.</Notice>
        : <Notice tone="warning"><Lock className="mr-1 inline h-3.5 w-3.5" aria-hidden />Live order placement is locked. You can build and review an order, but it cannot be sent.</Notice>}
      <div className="grid grid-cols-3 gap-2">
        <label className={LABEL}>Underlying
          <select className={FIELD} value={underlying} onChange={(event) => setUnderlying(event.target.value)}>{UNDERLYINGS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}</select>
        </label>
        <label className={LABEL}>Expiry
          <select className={FIELD} value={expiry} onChange={(event) => setExpiry(event.target.value)} disabled={!chain?.expiries.length}>
            {!chain?.expiries.length ? <option value="">{chainLoading ? "Loading…" : "None listed"}</option> : null}
            {chain?.expiries.map((day) => <option key={day} value={day}>{expiryLabel(day)}</option>)}
          </select>
        </label>
        <label className={LABEL}>Strike
          <select className={FIELD} value={strike ?? ""} onChange={(event) => setStrike(Number(event.target.value))} disabled={!chain?.strikes.length}>
            {!chain?.strikes.length ? <option value="">{chainLoading ? "Loading…" : "None listed"}</option> : null}
            {chain?.strikes.map((item) => <option key={item.strike} value={item.strike}>{item.strike}{item.strike === chain.atmStrike ? " · ATM" : ""}</option>)}
          </select>
        </label>
      </div>
      {chainError ? <Notice tone="warning">{chainError}</Notice> : null}
      <div className="grid grid-cols-2 gap-2">
        <SegmentedControl label="Option type" block value={right} onChange={setRight} options={[{ id: "CE", label: "CE · Call" }, { id: "PE", label: "PE · Put" }]} />
        <SegmentedControl label="Side" block value={side} onChange={setSide} options={[{ id: "BUY", label: "BUY", tone: "profit" }, { id: "SELL", label: "SELL", tone: "loss" }]} />
        <SegmentedControl label="Order type" block size="sm" value={orderType} onChange={setOrderType} options={[{ id: "MARKET", label: "Market" }, { id: "LIMIT", label: "Limit" }]} />
        <SegmentedControl label="Product" block size="sm" value={product} onChange={setProduct} options={[{ id: "INTRADAY", label: "Intraday" }, { id: "MARGIN", label: "Carry" }]} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className={LABEL}>Lots
          <div className="inline-flex h-8 items-stretch overflow-hidden rounded-input border border-border bg-sunken">
            <button type="button" aria-label="Decrease lots" disabled={lots <= 1} onClick={() => setLots(lots - 1)} className="grid w-8 place-items-center hover:bg-hover disabled:opacity-40"><Minus className="h-3.5 w-3.5" aria-hidden /></button>
            <span className="num grid flex-1 place-items-center border-x border-border-soft text-dense font-semibold text-text" aria-live="polite">{lots}</span>
            <button type="button" aria-label="Increase lots" onClick={() => setLots(lots + 1)} className="grid w-8 place-items-center hover:bg-hover"><Plus className="h-3.5 w-3.5" aria-hidden /></button>
          </div>
        </div>
        {orderType === "LIMIT" ? <label className={LABEL}>Limit (₹)<input className={FIELD} inputMode="decimal" value={limitText} onChange={(event) => setLimitText(event.target.value)} /></label> : <div className={LABEL}>Quantity<p className="num flex h-8 items-center text-dense text-text">{quantity ?? "Unavailable"}</p></div>}
      </div>
      {eligible.length > 0 ? (
        <fieldset className="flex flex-col gap-1.5 rounded-input border border-border-soft p-2.5">
          <legend className="px-1 text-micro font-medium uppercase tracking-[0.05em] text-muted">Accounts · lots each</legend>
          {eligible.map((account) => {
            const id = account.target!;
            const on = picked[id] !== false;
            return (
              <div key={id} className="flex items-center gap-2 text-data">
                <input type="checkbox" className="h-4 w-4" checked={on} onChange={(event) => setPicked((current) => ({ ...current, [id]: event.target.checked }))} aria-label={`Include ${account.nickname}`} />
                <span className="min-w-0 flex-1 truncate">{account.nickname}<span className="num ml-1 text-micro text-muted">{account.maskedId ?? ""}</span></span>
                <input type="number" min={1} max={100} className={cx(FIELD, "h-7 w-16 text-right")} disabled={!on} value={accountLots[id] ?? lots} onChange={(event) => setAccountLots((current) => ({ ...current, [id]: Math.max(1, Math.min(100, Math.floor(Number(event.target.value) || 1))) }))} aria-label={`Lots for ${account.nickname}`} />
              </div>
            );
          })}
        </fieldset>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-input border border-border-soft bg-sunken px-3 py-2.5 text-data" aria-label="Order summary">
        <dt className="text-muted">Contract</dt><dd className="truncate text-right font-semibold">{label}</dd>
        <dt className="text-muted">Last price · chain</dt><dd className="num text-right">{ltpPaise != null ? inr(ltpPaise) : <span className="text-muted">Unavailable</span>}</dd>
        <dt className="text-muted">Lot size · qty</dt><dd className="num text-right">{lotSize ?? <span className="text-muted">Unavailable</span>}{quantity ? ` · ${quantity}` : ""}</dd>
        <dt className="text-muted">Accounts · total qty</dt><dd className="num text-right">{legs.length} · {totalQuantity ?? "—"}</dd>
        <dt className="text-muted">Est. value</dt><dd className="num text-right">{estimate != null ? `≈ ${inr(estimate)}` : <span className="text-muted">Unavailable</span>}</dd>
      </dl>
      <Button size="lg" block variant={side === "BUY" ? "buy" : "sell"} disabled={!ready || (live && legs.length === 0)} onClick={openReview}>{side === "BUY" ? "Review Buy Order" : "Review Sell Order"}</Button>
      <LiveOrdersList reloadToken={reloadToken + ordersReload} enabled={live} />

      <Drawer open={reviewing} onClose={() => setReviewing(false)} modal label="Review live order" title="Review Order" subtitle={`${label}${expiry ? ` · ${expiryLabel(expiry)}` : ""}`} width="w-[500px]" footer={
        <div className="flex flex-col gap-2">
          {results ? (
            <Button block variant="secondary" onClick={() => setReviewing(false)}>Done</Button>
          ) : live ? (
            <>
              <label className="flex items-start gap-2 text-data text-text">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
                <span>I understand this places <strong>real orders with real money</strong> in {legs.length === 1 ? "this Dhan account" : `these ${legs.length} Dhan accounts`}, each settling separately.</span>
              </label>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setReviewing(false)} disabled={sending}>Back</Button>
                <Button className="flex-1" variant={side === "BUY" ? "buy" : "sell"} disabled={!understood || sending || !ready || legs.length === 0} onClick={() => void send()}>{sending ? "Sending…" : `Place ${summary}`}</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-micro text-muted">No account is eligible: live order placement is locked.</p>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setReviewing(false)}>Close</Button>
                <Button className="flex-1" variant="danger" disabled icon={<Lock className="h-3.5 w-3.5" />}>Live order placement locked</Button>
              </div>
            </>
          )}
        </div>
      }>
        <div className="flex flex-col gap-3 text-dense">
          <div className="flex items-center gap-2 rounded-input border border-loss/40 bg-loss-soft px-3 py-2 text-data font-semibold text-loss"><ShieldAlert className="h-4 w-4" aria-hidden />{live ? "LIVE · this order goes to Dhan when you confirm" : "LIVE · nothing will be sent from this review"}</div>
          <div className="flex flex-wrap gap-1.5"><Badge tone={side === "BUY" ? "profit" : "loss"}>{side}</Badge><Badge>{orderType === "LIMIT" ? `Limit ₹${limitText || "—"}` : "Market"}</Badge><Badge>{product === "INTRADAY" ? "Intraday" : "Carry"}</Badge><Badge>{lots} {lots === 1 ? "lot" : "lots"} · qty {quantity ?? "—"}</Badge></div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-data">
            <dt className="text-muted">Contract</dt><dd className="text-right font-semibold">{label}</dd>
            <dt className="text-muted">Est. value</dt><dd className="num text-right">{estimate != null ? `≈ ${inr(estimate)}` : "Unavailable"}</dd>
          </dl>
          <table className="w-full text-data" aria-label="Per-account eligibility">
            <thead><tr className="text-micro text-muted"><th scope="col" className="py-1 text-left font-medium">Account</th><th scope="col" className="text-left font-medium">Connection</th><th scope="col" className="text-left font-medium">Eligibility</th></tr></thead>
            <tbody>
              {accounts.filter((account) => account.connection !== "NOT_CONNECTED" || account.slot === 1).map((account) => (
                <tr key={account.id} className="border-t border-border-soft align-top">
                  <td className="py-1.5">{account.nickname}<span className="num block text-micro text-muted">{account.maskedId ?? ""}</span></td>
                  <td className="py-1.5"><StateChip state={account.connection} /></td>
                  <td className={cx("py-1.5", account.tradingReady ? "text-profit" : "text-loss")}>{account.tradingReady ? <CircleCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden /> : <CircleX className="mr-1 inline h-3.5 w-3.5" aria-hidden />}{account.tradingReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sendError ? <Notice tone="loss">{sendError}</Notice> : null}
          {results ? (
            <ul className="flex flex-col gap-1.5" role="status" aria-label="Results per account">
              {results.map((item) => {
                const status = item.order?.status;
                const tone = !item.ok || status === "REJECTED" ? "border-loss/40 bg-loss-soft" : status === "UNKNOWN" ? "border-warning/40 bg-warning-soft" : "border-profit/40 bg-profit-soft";
                return (
                  <li key={item.accountId} className={cx("rounded-input border px-3 py-2 text-data", tone)}>
                    <p className="font-semibold text-text">{nameOf(item.accountId)} · {item.order ? `${item.duplicate ? "Already sent · " : ""}${STATUS_LABEL[item.order.status] ?? item.order.status}${item.order.brokerOrderId ? ` · Dhan ${item.order.brokerOrderId}` : ""}` : "Not placed"}</p>
                    {item.error ? <p className="mt-0.5 text-text-2">{item.error.message}</p> : item.order?.reason ? <p className="mt-0.5 text-text-2">{item.order.reason}</p> : null}
                    {status === "UNKNOWN" ? <p className="mt-0.5 text-text-2">Do not place it again. Use Status under the ticket to check with Dhan.</p> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </Drawer>
    </div>
  );
}
