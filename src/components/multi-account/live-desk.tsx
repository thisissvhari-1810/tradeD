"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck, CircleX, Clock, KeyRound, LayoutGrid, Link2, Link2Off, Lock, Minus, Plus, RefreshCw, Rows3, ShieldAlert, TrendingDown, TrendingUp, Unplug } from "lucide-react";
import { istStamp } from "@/components/api";
import { ACCOUNT_GRID } from "@/components/multi-account/accounts";
import { contractLabel, expiryLabel, FIELD, inr, LABEL, pnl, pnlTone } from "@/components/multi-account/format";
import { ComplianceChecklist } from "@/components/multi-account/live-compliance";
import { useChain } from "@/components/multi-account/use-chain";
import { Badge, Button, cx, Drawer, EmptyState, Notice, Section, SegmentedControl, Skeleton, Tabs, TONE_TEXT, Tooltip, type Tone } from "@/components/ui";
import { FEATURED_INDICES } from "@/lib/market/indices";
import type { LiveGate } from "@/lib/multi-account/compliance";
import { combineLive, type ConnectionState, type LiveAccount, type LiveOrder, type LiveOrderStatus, type LiveView } from "@/lib/multi-account/live";
import type { Layout } from "@/components/multi-account/use-layout";

const CONNECTION: Record<ConnectionState, { label: string; tone: Tone; icon: typeof Link2 }> = {
  NOT_CONNECTED: { label: "Not connected", tone: "neutral", icon: Link2Off },
  AUTH_REQUIRED: { label: "Authentication required", tone: "warning", icon: KeyRound },
  EXPIRED: { label: "Authorization expired", tone: "loss", icon: Clock },
  CONNECTED: { label: "Connected", tone: "profit", icon: Link2 },
  DATA_UNAVAILABLE: { label: "Partly synced", tone: "warning", icon: CircleAlert },
  ERROR: { label: "Connection error", tone: "loss", icon: Unplug },
};

const ORDER_TONE: Record<LiveOrderStatus, Tone> = { PENDING: "info", PARTIAL: "warning", FILLED: "profit", REJECTED: "loss", CANCELLED: "neutral", EXPIRED: "neutral", UNKNOWN: "warning" };
const ORDER_LABEL: Record<LiveOrderStatus, string> = { PENDING: "Pending", PARTIAL: "Part filled", FILLED: "Filled", REJECTED: "Rejected", CANCELLED: "Cancelled", EXPIRED: "Expired", UNKNOWN: "Unknown" };

const UNDERLYINGS = [...new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", ...FEATURED_INDICES.map((item) => item.symbol)])];

function StateChip({ state, syncing }: { state: ConnectionState; syncing?: boolean }) {
  if (syncing && (state === "CONNECTED" || state === "DATA_UNAVAILABLE")) return <Badge tone="info"><RefreshCw className="h-3 w-3 animate-spin" aria-hidden />Synchronising</Badge>;
  const meta = CONNECTION[state];
  const Icon = meta.icon;
  return <Badge tone={meta.tone}><Icon className="h-3 w-3" aria-hidden />{meta.label}</Badge>;
}

function Money({ value, tone = false, broker = false }: { value: number | null | undefined; tone?: boolean; broker?: boolean }) {
  if (value == null) return <span className="text-muted">Unavailable</span>;
  return <span className={cx("num", tone && TONE_TEXT[pnlTone(value)])} title={broker ? "Reported by the broker" : undefined}>{tone ? pnl(value) : inr(value)}</span>;
}

function connected(account: LiveAccount) {
  return account.connection === "CONNECTED" || account.connection === "DATA_UNAVAILABLE";
}

export function LiveSummary({ view }: { view: LiveView }) {
  const combined = combineLive(view.accounts);
  const tone = pnlTone(combined.totalPaise);
  const TrendIcon = combined.totalPaise == null || combined.totalPaise === 0 ? Minus : combined.totalPaise > 0 ? TrendingUp : TrendingDown;
  const metric = (label: string, value: ReactNode, hint?: ReactNode) => (
    <div className="min-w-0 rounded-input border border-border-soft bg-panel px-3 py-2">
      <p className="whitespace-nowrap text-micro font-medium uppercase tracking-[0.05em] text-muted">{label}</p>
      <p className="num mt-0.5 whitespace-nowrap text-title font-semibold text-text">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-micro text-muted">{hint}</p> : null}
    </div>
  );
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
      <section aria-label="Portfolio P&L" className={cx("surface relative overflow-hidden px-4 py-3.5", tone === "profit" && "border-profit/30", tone === "loss" && "border-loss/30")}>
        <span className={cx("absolute inset-y-0 left-0 w-1", tone === "profit" ? "bg-profit" : tone === "loss" ? "bg-loss" : "bg-border")} aria-hidden />
        <p className="text-micro font-medium uppercase tracking-[0.05em] text-muted">Portfolio P&L · broker-reported</p>
        <div className="mt-1 flex items-center gap-2">
          <TrendIcon className={cx("h-5 w-5 shrink-0", TONE_TEXT[tone])} aria-hidden />
          <p className={cx("num text-hero font-semibold", combined.totalPaise == null ? "text-muted" : TONE_TEXT[tone])}>{combined.totalPaise == null ? "Unavailable" : pnl(combined.totalPaise)}</p>
        </div>
        {combined.connected === 0
          ? <p className="mt-0.5 text-micro text-muted">No connected account has synced.</p>
          : combined.incomplete
            ? <p className="mt-0.5 text-micro text-warning">Incomplete: {combined.synced} of {combined.connected} connected accounts fully synced.</p>
            : <p className="mt-0.5 text-micro text-muted">From today&apos;s positions feed · synced {istStamp(view.syncedAt)}</p>}
        <dl className="mt-2 grid grid-cols-2 gap-2 border-t border-border-soft pt-2 text-data">
          <div className="min-w-0"><dt className="text-micro text-muted">Realised (positions)</dt><dd className="truncate font-semibold"><Money value={combined.realizedPaise} tone broker /></dd></div>
          <div className="min-w-0"><dt className="text-micro text-muted">Unrealised (open)</dt><dd className="truncate font-semibold"><Money value={combined.unrealizedPaise} tone broker /></dd></div>
        </dl>
      </section>
      <div className="grid grid-cols-2 content-start gap-2 sm:grid-cols-4">
        {metric("Connected", `${combined.connected} / ${view.accounts.length}`, `${combined.authorized} authorized`)}
        {metric("Trading eligible", combined.eligible, "order placement locked")}
        {metric("Available funds", combined.availablePaise == null ? "Unavailable" : inr(combined.availablePaise), "broker-reported")}
        {metric("Used margin", combined.usedMarginPaise == null ? "Unavailable" : inr(combined.usedMarginPaise), "broker-reported")}
        {metric("Holdings at cost", combined.holdingsCostPaise == null ? "Unavailable" : inr(combined.holdingsCostPaise), "equity book, not P&L")}
        {metric("Open positions", combined.openPositions ?? "Unavailable")}
        {metric("Pending orders", combined.pendingOrders ?? "Unavailable")}
        {metric("Rejected orders", combined.rejectedOrders ?? "Unavailable", "today")}
        {metric("Last sync", combined.synced ? new Date(view.syncedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "—", "IST")}
      </div>
    </div>
  );
}

function latestOrder(account: LiveAccount): LiveOrder | null {
  if (!account.orders?.length) return null;
  return [...account.orders].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))[0] ?? null;
}

function AccountAction({ account, owner, onConnect }: { account: LiveAccount; owner: boolean; onConnect: () => void }) {
  if (account.connection === "NOT_CONNECTED") return <Button size="sm" variant="secondary" icon={<Link2 className="h-3.5 w-3.5" />} onClick={onConnect}>Connect broker account</Button>;
  if ((account.connection === "AUTH_REQUIRED" || account.connection === "EXPIRED" || account.connection === "ERROR") && owner) {
    return <Link href="/admin" className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-border bg-elevated px-2.5 text-data font-medium text-text hover:bg-hover"><KeyRound className="h-3.5 w-3.5" aria-hidden />Reconnect in Admin</Link>;
  }
  return null;
}

export function LiveAccountCard({ account, owner, syncing, onConnect }: { account: LiveAccount; owner: boolean; syncing: boolean; onConnect: () => void }) {
  const live = connected(account);
  const last = latestOrder(account);
  return (
    <article aria-label={account.nickname} className={cx("flex min-w-0 flex-col gap-2 rounded-md border p-2.5", live ? "border-border-soft bg-panel" : "border-dashed border-border bg-sunken")}>
      <div className="flex items-start gap-2">
        <Tooltip content={account.tradingReason}>
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" disabled checked={false} aria-label={`Select ${account.nickname}: not eligible. ${account.tradingReason}`} readOnly />
        </Tooltip>
        <div className="min-w-0 flex-1">
          <p className={cx("truncate text-dense font-semibold", live ? "text-text" : "text-text-2")}>{account.nickname}</p>
          <p className="num text-micro text-muted">{account.maskedId ?? "No account linked"}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        <StateChip state={account.connection} syncing={syncing} />
        {account.authorized ? <Badge tone="profit"><CircleCheck className="h-3 w-3" aria-hidden />Authorized</Badge> : null}
        {account.connection !== "NOT_CONNECTED" ? <Tooltip content={account.tradingReason}><span tabIndex={0}><Badge tone="warning"><Lock className="h-3 w-3" aria-hidden />Trading restricted</Badge></span></Tooltip> : null}
      </div>
      {live ? (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-border-soft bg-border-soft">
            <div className="bg-sunken px-2 py-1.5"><p className="text-micro text-muted">Realised</p><p className="truncate text-dense font-semibold"><Money value={account.totals.realizedPaise} tone broker /></p></div>
            <div className="bg-sunken px-2 py-1.5"><p className="text-micro text-muted">Unrealised</p><p className="truncate text-dense font-semibold"><Money value={account.totals.unrealizedPaise} tone broker /></p></div>
          </div>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-data">
            <div className="min-w-0"><dt className="text-micro text-muted">Available</dt><dd className="truncate"><Money value={account.funds?.availablePaise} broker /></dd></div>
            <div className="min-w-0 text-right"><dt className="text-micro text-muted">Used margin</dt><dd className="truncate"><Money value={account.funds?.usedMarginPaise} broker /></dd></div>
            <div className="min-w-0"><dt className="text-micro text-muted">Open positions</dt><dd className="num">{account.totals.openPositions ?? <span className="text-muted">Unavailable</span>}</dd></div>
            <div className="min-w-0 text-right"><dt className="text-micro text-muted">Last sync</dt><dd className="num">{account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "—"}</dd></div>
          </dl>
          {[account.funds?.error, account.positionsError, account.holdingsError, account.ordersError].filter(Boolean).map((error) => <p key={error} className="text-micro text-warning">{error}</p>)}
          <div className="flex min-h-5 items-center gap-1.5 border-t border-border-soft pt-2 text-micro text-muted">
            {last ? <><Badge tone={ORDER_TONE[last.status]}>{ORDER_LABEL[last.status]}</Badge><span className="truncate" title={`${last.symbol} ${last.reason}`}>{last.symbol}</span></> : <span>{account.orders ? "No orders today" : "Orders unavailable"}</span>}
          </div>
        </>
      ) : (
        <p className="text-data text-muted">{account.message}</p>
      )}
      <AccountAction account={account} owner={owner} onConnect={onConnect} />
    </article>
  );
}

function LiveAccountTable({ accounts, owner, onConnect }: { accounts: LiveAccount[]; owner: boolean; onConnect: () => void }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border-soft">
      <table className="ui-table dense w-full min-w-[900px] border-separate border-spacing-0 text-data" aria-label="Live accounts">
        <thead>
          <tr className="bg-sunken">
            {["Account", "Connection", "Available", "Used margin", "Open pos.", "Realised", "Unrealised", "Last sync", ""].map((header, index) => <th key={header || index} scope="col" className={cx("border-b border-border-soft", index >= 2 && index <= 6 ? "text-right" : "text-left")}>{header || <span className="sr-only">Actions</span>}</th>)}
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.id}>
              <td className="border-b border-border-soft"><span className="block font-semibold text-text">{account.nickname}</span><span className="num text-micro text-muted">{account.maskedId ?? "No account linked"}</span></td>
              <td className="border-b border-border-soft"><StateChip state={account.connection} /></td>
              <td className="border-b border-border-soft text-right">{connected(account) ? <Money value={account.funds?.availablePaise} broker /> : "—"}</td>
              <td className="border-b border-border-soft text-right">{connected(account) ? <Money value={account.funds?.usedMarginPaise} broker /> : "—"}</td>
              <td className="num border-b border-border-soft text-right">{connected(account) ? account.totals.openPositions ?? "Unavailable" : "—"}</td>
              <td className="border-b border-border-soft text-right">{connected(account) ? <Money value={account.totals.realizedPaise} tone broker /> : "—"}</td>
              <td className="border-b border-border-soft text-right">{connected(account) ? <Money value={account.totals.unrealizedPaise} tone broker /> : "—"}</td>
              <td className="num border-b border-border-soft">{account.lastSyncAt ? istStamp(account.lastSyncAt) : "—"}</td>
              <td className="border-b border-border-soft text-right"><AccountAction account={account} owner={owner} onConnect={onConnect} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LiveOrders({ accounts }: { accounts: LiveAccount[] }) {
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState("");
  const rows = accounts.flatMap((item) => (item.orders ?? []).map((order) => ({ account: item, order })));
  const shown = rows.filter((row) => (!account || row.account.id === account) && (!status || row.order.status === status));
  const failed = accounts.filter((item) => connected(item) && item.ordersError);
  if (!accounts.some(connected)) return <EmptyState icon={<Link2Off />} title="No connected accounts" body="Broker orders appear here once an account is connected and synced." />;
  return (
    <div className="flex flex-col gap-3">
      {failed.map((item) => <Notice key={item.id} tone="warning">{item.nickname}: {item.ordersError}</Notice>)}
      <div className="flex flex-wrap items-end gap-2">
        <label className={cx(LABEL, "w-48")}>Account
          <select className={FIELD} value={account} onChange={(event) => setAccount(event.target.value)}>
            <option value="">All accounts</option>
            {accounts.filter(connected).map((item) => <option key={item.id} value={item.id}>{item.nickname}</option>)}
          </select>
        </label>
        <label className={cx(LABEL, "w-40")}>Status
          <select className={FIELD} value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            {(Object.keys(ORDER_LABEL) as LiveOrderStatus[]).map((item) => <option key={item} value={item}>{ORDER_LABEL[item]}</option>)}
          </select>
        </label>
        <p className="flex-1 text-micro text-muted">Read from the broker. Cancel and modify need order access, which is locked.</p>
      </div>
      {shown.length === 0 ? <EmptyState icon={<Clock />} title={rows.length ? "No orders match these filters" : "No broker orders today"} /> : (
        <div className="max-h-[520px] overflow-auto rounded-md border border-border-soft">
          <table className="ui-table dense w-full min-w-[980px] border-separate border-spacing-0 text-data" aria-label="Broker orders">
            <thead><tr>{["Time", "Account", "Reference", "Contract", "Side", "Type", "Qty", "Filled", "Price", "Avg", "Status", "Reason"].map((header, index) => <th key={header} scope="col" className={cx("sticky top-0 border-b border-border-soft bg-panel", index >= 6 && index <= 9 ? "text-right" : "text-left")}>{header}</th>)}</tr></thead>
            <tbody>
              {shown.map(({ account: owner, order }) => (
                <tr key={`${owner.id}-${order.ref}`}>
                  <td className="num whitespace-nowrap border-b border-border-soft text-muted">{order.createdAt ?? "Not reported"}</td>
                  <td className="whitespace-nowrap border-b border-border-soft">{owner.nickname}</td>
                  <td className="num border-b border-border-soft text-muted">{order.ref}</td>
                  <td className="whitespace-nowrap border-b border-border-soft font-medium">{order.symbol}</td>
                  <td className={cx("border-b border-border-soft", order.side === "BUY" ? "text-profit" : order.side === "SELL" ? "text-loss" : "text-muted")}>{order.side ?? "—"}</td>
                  <td className="border-b border-border-soft">{order.orderType ?? "—"}{order.product ? <span className="text-muted"> · {order.product}</span> : null}</td>
                  <td className="num border-b border-border-soft text-right">{order.quantity ?? "—"}</td>
                  <td className="num border-b border-border-soft text-right">{order.filledQuantity ?? "—"}</td>
                  <td className="border-b border-border-soft text-right"><Money value={order.pricePaise} broker /></td>
                  <td className="border-b border-border-soft text-right"><Money value={order.avgPaise} broker /></td>
                  <td className="border-b border-border-soft"><span title={`Broker status: ${order.brokerStatus}`}><Badge tone={ORDER_TONE[order.status]}>{ORDER_LABEL[order.status]}</Badge></span></td>
                  <td className="max-w-[240px] border-b border-border-soft text-muted">{order.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LivePositions({ accounts }: { accounts: LiveAccount[] }) {
  const rows = accounts.flatMap((item) => (item.positions ?? []).map((position) => ({ account: item, position })));
  const failed = accounts.filter((item) => connected(item) && item.positionsError);
  const combined = useMemo(() => [...rows.reduce((map, { position }) => {
    const key = `${position.symbol}|${position.product ?? ""}`;
    const entry = map.get(key) ?? { key, symbol: position.symbol, product: position.product, accounts: 0, netQty: 0, realized: 0 as number | null, unrealized: 0 as number | null };
    entry.accounts += 1;
    entry.netQty += position.netQty;
    entry.realized = entry.realized == null || position.realizedPaise == null ? null : entry.realized + position.realizedPaise;
    entry.unrealized = entry.unrealized == null || position.unrealizedPaise == null ? null : entry.unrealized + position.unrealizedPaise;
    map.set(key, entry);
    return map;
  }, new Map<string, { key: string; symbol: string; product: string | null; accounts: number; netQty: number; realized: number | null; unrealized: number | null }>()).values()], [rows]);
  if (!accounts.some(connected)) return <EmptyState icon={<Link2Off />} title="No connected accounts" body="Broker positions appear here once an account is connected and synced." />;
  return (
    <div className="flex flex-col gap-3">
      {failed.map((item) => <Notice key={item.id} tone="warning">{item.nickname}: {item.positionsError}</Notice>)}
      <div className="flex flex-wrap items-center gap-2 rounded-input border border-border-soft bg-sunken px-3 py-1.5">
        <p className="flex-1 text-data text-text-2">{rows.length} {rows.length === 1 ? "position" : "positions"} from the broker. P&L values are broker-reported; the positions feed does not include a current price.</p>
        <Tooltip content="Closing a real position needs order placement, which is locked."><span tabIndex={0}><Button size="sm" variant="danger" disabled>Close selected (0)</Button></span></Tooltip>
      </div>
      {rows.length === 0 ? <EmptyState icon={<CircleCheck />} title="No broker positions today" /> : (
        <>
          <div className="max-h-[440px] overflow-auto rounded-md border border-border-soft">
            <table className="ui-table dense w-full min-w-[860px] border-separate border-spacing-0 text-data" aria-label="Broker positions per account">
              <thead><tr>{["", "Account", "Contract", "Product", "Status", "Net qty", "Avg price", "Realised", "Unrealised"].map((header, index) => <th key={header || index} scope="col" className={cx("sticky top-0 border-b border-border-soft bg-panel", index >= 5 ? "text-right" : "text-left")}>{header || <span className="sr-only">Select</span>}</th>)}</tr></thead>
              <tbody>
                {rows.map(({ account, position }) => (
                  <tr key={`${account.id}-${position.key}`}>
                    <td className="border-b border-border-soft"><input type="checkbox" disabled aria-label={`Select ${position.symbol}: closing is locked`} /></td>
                    <td className="whitespace-nowrap border-b border-border-soft">{account.nickname}</td>
                    <td className="border-b border-border-soft"><span className="block font-medium text-text">{position.symbol}</span>{position.strike != null && position.right ? <span className="text-micro text-muted">{position.strike} {position.right}{position.expiry ? ` · ${expiryLabel(position.expiry)}` : ""}</span> : null}</td>
                    <td className="border-b border-border-soft">{position.product ?? "—"}</td>
                    <td className="border-b border-border-soft"><Badge tone={position.side === "LONG" ? "profit" : position.side === "SHORT" ? "loss" : "neutral"}>{position.side === "CLOSED" ? "Closed" : position.side === "LONG" ? "Long" : "Short"}</Badge></td>
                    <td className="num border-b border-border-soft text-right">{position.netQty}</td>
                    <td className="border-b border-border-soft text-right"><Money value={position.avgPaise} broker /></td>
                    <td className="border-b border-border-soft text-right"><Money value={position.realizedPaise} tone broker /></td>
                    <td className="border-b border-border-soft text-right">{position.netQty === 0 ? <span className="text-muted">—</span> : <Money value={position.unrealizedPaise} tone broker />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="mb-2 text-dense font-semibold text-text">Combined <span className="font-normal text-muted">· same instrument and product only</span></h3>
            <div className="overflow-x-auto rounded-md border border-border-soft">
              <table className="ui-table dense w-full min-w-[620px] border-separate border-spacing-0 text-data" aria-label="Combined broker positions">
                <thead><tr>{["Instrument", "Product", "Accounts", "Net qty", "Realised", "Unrealised"].map((header, index) => <th key={header} scope="col" className={cx("border-b border-border-soft", index >= 2 ? "text-right" : "text-left")}>{header}</th>)}</tr></thead>
                <tbody>
                  {combined.map((row) => (
                    <tr key={row.key}>
                      <td className="border-b border-border-soft font-medium">{row.symbol}</td>
                      <td className="border-b border-border-soft">{row.product ?? "—"}</td>
                      <td className="num border-b border-border-soft text-right">{row.accounts}</td>
                      <td className="num border-b border-border-soft text-right">{row.netQty}</td>
                      <td className="border-b border-border-soft text-right"><Money value={row.realized} tone broker /></td>
                      <td className="border-b border-border-soft text-right"><Money value={row.unrealized} tone broker /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LiveHoldings({ accounts }: { accounts: LiveAccount[] }) {
  const rows = accounts.flatMap((item) => (item.holdings ?? []).map((holding) => ({ account: item, holding })));
  const failed = accounts.filter((item) => connected(item) && item.holdingsError);
  if (!accounts.some(connected)) return <EmptyState icon={<Link2Off />} title="No connected accounts" body="Equity holdings appear here once an account is connected and synced." />;
  return (
    <div className="flex flex-col gap-3">
      {failed.map((item) => <Notice key={item.id} tone="warning">{item.nickname}: {item.holdingsError}</Notice>)}
      <p className="text-data text-muted">Broker-reported delivery holdings. Average cost is from the broker; there is no current mark in this feed, so unrealised P&L is not calculated here.</p>
      {rows.length === 0 ? <EmptyState icon={<CircleCheck />} title="No equity holdings reported" /> : (
        <div className="max-h-[520px] overflow-auto rounded-md border border-border-soft">
          <table className="ui-table dense w-full min-w-[720px] border-separate border-spacing-0 text-data" aria-label="Broker holdings">
            <thead><tr>{["Account", "Symbol", "Quantity", "Available", "Avg cost", "Cost"].map((header, index) => <th key={header} scope="col" className={cx("sticky top-0 border-b border-border-soft bg-panel", index >= 2 ? "text-right" : "text-left")}>{header}</th>)}</tr></thead>
            <tbody>
              {rows.map(({ account, holding }) => (
                <tr key={`${account.id}-${holding.key}`}>
                  <td className="whitespace-nowrap border-b border-border-soft">{account.nickname}</td>
                  <td className="border-b border-border-soft font-medium">{holding.symbol}</td>
                  <td className="num border-b border-border-soft text-right">{holding.quantity}</td>
                  <td className="num border-b border-border-soft text-right">{holding.availableQty ?? <span className="text-muted">Unavailable</span>}</td>
                  <td className="border-b border-border-soft text-right"><Money value={holding.avgPaise} broker /></td>
                  <td className="border-b border-border-soft text-right"><Money value={holding.costPaise} broker /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function LiveOrderPanel({ accounts, reloadToken }: { accounts: LiveAccount[]; reloadToken: number }) {
  const { underlying, expiry, strike, setUnderlying, setExpiry, setStrike, chain, chainError, chainLoading } = useChain(reloadToken);
  const [right, setRight] = useState<"CE" | "PE">("CE");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [product, setProduct] = useState<"INTRADAY" | "MARGIN">("INTRADAY");
  const [limitText, setLimitText] = useState("");
  const [lots, setLots] = useState(1);
  const [reviewing, setReviewing] = useState(false);
  const lotSize = chain?.lotSize ?? null;
  const row = chain?.strikes.find((item) => item.strike === strike) ?? null;
  const ltp = chain?.available && chain.expiry === expiry ? (right === "CE" ? row?.ce?.ltp : row?.pe?.ltp) ?? null : null;
  const eligible = accounts.filter((account) => account.tradingReady);
  const quantity = lotSize ? lots * lotSize : null;
  const estimate = ltp != null && ltp > 0 && quantity ? Math.round(ltp * 100) * quantity * eligible.length : null;
  const ready = Boolean(chain?.available && expiry && strike != null && lotSize);
  const label = strike != null ? contractLabel({ underlying, expiry, strike, right }) : "Choose a contract";
  const confirmLabel = `Confirm ${side} ${label} · ${eligible.length} ${eligible.length === 1 ? "account" : "accounts"}`;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Notice tone="warning"><Lock className="mr-1 inline h-3.5 w-3.5" aria-hidden />Live order placement is locked. You can build and review an order, but it cannot be sent.</Notice>
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
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-input border border-border-soft bg-sunken px-3 py-2.5 text-data" aria-label="Order summary">
        <dt className="text-muted">Contract</dt><dd className="truncate text-right font-semibold">{label}</dd>
        <dt className="text-muted">Last price · chain</dt><dd className="num text-right">{ltp != null && ltp > 0 ? inr(Math.round(ltp * 100)) : <span className="text-muted">Unavailable</span>}</dd>
        <dt className="text-muted">Lot size</dt><dd className="num text-right">{lotSize ?? <span className="text-muted">Unavailable</span>}</dd>
        <dt className="text-muted">Eligible accounts</dt><dd className="num text-right">{eligible.length}</dd>
        <dt className="text-muted">Est. value</dt><dd className="num text-right">{estimate != null && estimate > 0 ? `≈ ${inr(estimate)}` : <span className="text-muted">Unavailable</span>}</dd>
      </dl>
      <Button size="lg" block variant={side === "BUY" ? "buy" : "sell"} disabled={!ready} onClick={() => setReviewing(true)}>{side === "BUY" ? "Review Buy Order" : "Review Sell Order"}</Button>

      <Drawer open={reviewing} onClose={() => setReviewing(false)} modal label="Review live order" title="Review Order" subtitle={`${label}${expiry ? ` · ${expiryLabel(expiry)}` : ""}`} width="w-[500px]" footer={
        <div className="flex flex-col gap-2">
          <p className="text-micro text-muted">{eligible.length === 0 ? "No account is eligible: live order placement is not available in TradeD." : confirmLabel}</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setReviewing(false)}>Close</Button>
            <Button className="flex-1" variant="danger" disabled icon={<Lock className="h-3.5 w-3.5" />}>Live order placement locked</Button>
          </div>
        </div>
      }>
        <div className="flex flex-col gap-3 text-dense">
          <div className="flex items-center gap-2 rounded-input border border-loss/40 bg-loss-soft px-3 py-2 text-data font-semibold text-loss"><ShieldAlert className="h-4 w-4" aria-hidden />LIVE · nothing will be sent from this review</div>
          <div className="flex flex-wrap gap-1.5"><Badge tone={side === "BUY" ? "profit" : "loss"}>{side}</Badge><Badge>{orderType === "LIMIT" ? `Limit ₹${limitText || "—"}` : "Market"}</Badge><Badge>{product === "INTRADAY" ? "Intraday" : "Carry"}</Badge><Badge>{lots} {lots === 1 ? "lot" : "lots"} · qty {quantity ?? "—"}</Badge></div>
          <table className="w-full text-data" aria-label="Per-account eligibility">
            <thead><tr className="text-micro text-muted"><th scope="col" className="py-1 text-left font-medium">Account</th><th scope="col" className="text-left font-medium">Connection</th><th scope="col" className="text-left font-medium">Eligibility</th></tr></thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-t border-border-soft align-top">
                  <td className="py-1.5">{account.nickname}<span className="num block text-micro text-muted">{account.maskedId ?? ""}</span></td>
                  <td className="py-1.5"><StateChip state={account.connection} /></td>
                  <td className="py-1.5 text-loss"><CircleX className="mr-1 inline h-3.5 w-3.5" aria-hidden />{account.tradingReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Drawer>
    </div>
  );
}

function ConnectDrawer({ open, onClose, view }: { open: boolean; onClose: () => void; view: LiveView }) {
  return (
    <Drawer open={open} onClose={onClose} modal label="Connect broker account" title="Connect broker account" width="w-[480px]" footer={<Button block variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-3 text-dense">
        <Notice tone="warning">Connecting additional broker accounts is not available yet. TradeD will never ask for a broker password, OTP or token in a form.</Notice>
        <p className="text-text-2">A genuine connection needs every item below. None of them exists in this application today:</p>
        <ul className="flex flex-col gap-2">
          {view.missing.map((item) => <li key={item} className="flex gap-2 rounded-input border border-border-soft bg-sunken p-2.5 text-data text-text-2"><CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-loss" aria-hidden />{item}</li>)}
        </ul>
        {view.viewerOwnsConnection ? <p className="text-data text-muted">The existing server connection is managed in <Link href="/admin" className="text-primary underline-offset-2 hover:underline">Admin</Link>, where the market-data token can be replaced when it expires.</p> : null}
      </div>
    </Drawer>
  );
}

export function LiveDesk({ view, error, syncing, layout, accountView, onAccountView, reloadToken, gate }: { view: LiveView | null; error: string; syncing: boolean; layout: Layout; accountView: "grid" | "table"; onAccountView: (next: "grid" | "table") => void; reloadToken: number; gate: LiveGate }) {
  const [tab, setTab] = useState<"orders" | "positions" | "holdings" | "rules">("orders");
  const [connectOpen, setConnectOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  if (!view && !error) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading live accounts">
        <div className="grid gap-3 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]"><Skeleton className="h-[132px] rounded-card" /><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-[62px]" />)}</div></div>
        <div className={ACCOUNT_GRID}>{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-[200px] rounded-md" />)}</div>
      </div>
    );
  }
  if (!view) return <Section><EmptyState icon={<Unplug />} title="Live accounts could not be loaded" body={error} /></Section>;
  const panel = <LiveOrderPanel accounts={view.accounts} reloadToken={reloadToken} />;
  return (
    <>
      {error ? <Notice tone="warning">Showing the last sync from {istStamp(view.syncedAt)}. {error}</Notice> : null}
      <Notice tone="neutral">{view.notice}</Notice>
      <LiveSummary view={view} />
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Broker accounts" description="Only verified broker connections show financial data. Empty slots stay empty." bodyClassName="flex flex-col gap-2.5" actions={
            <SegmentedControl label="Account layout" size="sm" value={accountView} onChange={onAccountView} options={[{ id: "grid", label: <span className="inline-flex items-center gap-1"><LayoutGrid className="h-3.5 w-3.5" aria-hidden />Grid</span> }, { id: "table", label: <span className="inline-flex items-center gap-1"><Rows3 className="h-3.5 w-3.5" aria-hidden />Table</span> }]} />
          }>
            {accountView === "table"
              ? <LiveAccountTable accounts={view.accounts} owner={view.viewerOwnsConnection} onConnect={() => setConnectOpen(true)} />
              : <div className={ACCOUNT_GRID}>{view.accounts.map((account) => <LiveAccountCard key={account.id} account={account} owner={view.viewerOwnsConnection} syncing={syncing} onConnect={() => setConnectOpen(true)} />)}</div>}
          </Section>
          {layout === "medium" ? <div id="ma-live-order" className="scroll-mt-20"><Section title="Order entry" description="Review only. Live placement is locked.">{panel}</Section></div> : null}
          <Section flush>
            <div className="border-b border-border-soft px-4 pt-2">
              <Tabs label="Live views" value={tab} onChange={setTab} items={[
                { id: "orders", label: "Orders", count: combineLive(view.accounts).pendingOrders ?? undefined },
                { id: "positions", label: "Positions", count: combineLive(view.accounts).openPositions ?? undefined },
                { id: "holdings", label: "Holdings", count: view.accounts.reduce((sum, account) => sum + (account.totals.holdingsCount ?? 0), 0) || undefined },
                { id: "rules", label: "Live trading rules" },
              ]} />
            </div>
            <div className="p-4">
              {tab === "orders" ? <LiveOrders accounts={view.accounts} /> : null}
              {tab === "positions" ? <LivePositions accounts={view.accounts} /> : null}
              {tab === "holdings" ? <LiveHoldings accounts={view.accounts} /> : null}
              {tab === "rules" ? (
                <div className="flex flex-col gap-4">
                  <div>
                    <h3 className="mb-1.5 text-dense font-semibold text-text">Integration status</h3>
                    <ul className="grid gap-1.5 text-data sm:grid-cols-2">
                      {([["Read funds", view.capabilities.readFunds], ["Read positions", view.capabilities.readPositions], ["Read holdings", view.capabilities.readHoldings], ["Read orders", view.capabilities.readOrders], ["Connect more accounts", view.capabilities.connectAccounts], ["Place orders", view.capabilities.placeOrders], ["Cancel orders", view.capabilities.cancelOrders]] as const).map(([label, on]) => (
                        <li key={label} className="flex items-center gap-2 rounded-input border border-border-soft bg-sunken px-2.5 py-1.5">{on ? <CircleCheck className="h-3.5 w-3.5 text-profit" aria-hidden /> : <CircleX className="h-3.5 w-3.5 text-loss" aria-hidden />}<span className="text-text">{label}</span><span className="ml-auto text-micro text-muted">{on ? "Available" : "Not available"}</span></li>
                      ))}
                    </ul>
                  </div>
                  <ComplianceChecklist gate={gate} />
                </div>
              ) : null}
            </div>
          </Section>
        </div>
        {layout === "wide" ? (
          <aside className="no-scrollbar sticky top-[68px] max-h-[calc(100dvh-var(--topbar)-84px)] overflow-y-auto rounded-card" aria-label="Order entry">
            <Section title="CE / PE order" description="Review only. Live placement is locked.">{panel}</Section>
          </aside>
        ) : null}
      </div>
      <ConnectDrawer open={connectOpen} onClose={() => setConnectOpen(false)} view={view} />
      {layout !== "wide" ? (
        <button type="button" onClick={() => (layout === "narrow" ? setSheetOpen(true) : document.getElementById("ma-live-order")?.scrollIntoView({ behavior: "smooth", block: "start" }))} className="fixed bottom-[calc(var(--tabbar)+env(safe-area-inset-bottom)+16px)] right-4 z-30 inline-flex h-11 items-center gap-2 rounded-pill bg-primary px-5 text-dense font-semibold text-on-primary shadow-e2 transition hover:bg-primary-hover lg:bottom-6">
          <Plus className="h-4 w-4" aria-hidden />New order
        </button>
      ) : null}
      {layout === "narrow" ? (
        <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} modal label="Review CE / PE order" title="Review CE / PE order" subtitle="Review only. Live placement is locked.">
          {panel}
        </Drawer>
      ) : null}
    </>
  );
}
