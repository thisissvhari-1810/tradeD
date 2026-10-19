"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, CircleCheck, CircleX, Clock, KeyRound, LayoutGrid, Link2, Link2Off, Minus, Pencil, Plus, Rows3, TrendingDown, TrendingUp, Unplug } from "lucide-react";
import { api, istStamp } from "@/components/api";
import { ACCOUNT_GRID } from "@/components/multi-account/accounts";
import { expiryLabel, FIELD, inr, LABEL, pnl, pnlTone } from "@/components/multi-account/format";
import { ComplianceChecklist } from "@/components/multi-account/live-compliance";
import { LiveOrderPanel, StateChip } from "@/components/multi-account/live-order-panel";
import { FamilyAccountDrawer } from "@/components/multi-account/family-account-drawer";
import { Badge, Button, cx, Drawer, EmptyState, Notice, Section, SegmentedControl, Skeleton, Tabs, TONE_TEXT, Tooltip, type Tone } from "@/components/ui";
import type { LiveGate } from "@/lib/multi-account/compliance";
import { combineLive, type LiveAccount, type LiveOrder, type LiveOrderStatus, type LiveView } from "@/lib/multi-account/live";
import type { Layout } from "@/components/multi-account/use-layout";

const ORDER_TONE: Record<LiveOrderStatus, Tone> = { PENDING: "info", PARTIAL: "warning", FILLED: "profit", REJECTED: "loss", CANCELLED: "neutral", EXPIRED: "neutral", UNKNOWN: "warning" };
const ORDER_LABEL: Record<LiveOrderStatus, string> = { PENDING: "Pending", PARTIAL: "Part filled", FILLED: "Filled", REJECTED: "Rejected", CANCELLED: "Cancelled", EXPIRED: "Expired", UNKNOWN: "Unknown" };

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
        {metric("Trading eligible", combined.eligible, view.gate.enabled ? "live orders on" : "order placement locked")}
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

type Manage = (account: LiveAccount | null) => void;
type Toggle = (account: LiveAccount, enabled: boolean) => void;
type Rename = (account: LiveAccount, nickname: string) => Promise<void>;

/** Account name with an inline rename for linked accounts. */
function AccountName({ account, onRename, className }: { account: LiveAccount; onRename: Rename; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(account.nickname);
  const [saving, setSaving] = useState(false);
  if (!account.target) return <p className={cx("truncate", className)}>{account.nickname}</p>;
  if (!editing) {
    return (
      <p className={cx("flex min-w-0 items-center gap-1", className)}>
        <span className="truncate">{account.nickname}</span>
        <button type="button" className="shrink-0 rounded-sm p-0.5 text-muted hover:bg-hover hover:text-text" aria-label={`Rename ${account.nickname}`} title="Rename" onClick={() => { setValue(account.nickname); setEditing(true); }}><Pencil className="h-3 w-3" aria-hidden /></button>
      </p>
    );
  }
  const save = async () => {
    const name = value.trim();
    if (!name || name === account.nickname) return setEditing(false);
    setSaving(true);
    try {
      await onRename(account, name);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input autoFocus maxLength={40} className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-sunken px-1.5 text-data text-text" value={value} disabled={saving} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }} aria-label="Account name" />
      <button type="submit" className="rounded-sm p-0.5 text-profit hover:bg-hover" disabled={saving} aria-label="Save name"><Check className="h-3.5 w-3.5" aria-hidden /></button>
    </form>
  );
}

/** The owner's switch for one account: included in orders or not. Saved on the server. */
function EnableSwitch({ account, onToggle }: { account: LiveAccount; onToggle: Toggle }) {
  if (!account.target) return <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" disabled checked={false} readOnly aria-label={`${account.nickname}: no account linked`} />;
  return (
    <Tooltip content={account.enabled ? "Included in orders. Untick to switch this account off." : "Switched off: left out of orders. Tick to include it."}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-primary,currentColor)]" checked={account.enabled} onChange={(event) => onToggle(account, event.target.checked)} aria-label={`Include ${account.nickname} in orders`} />
    </Tooltip>
  );
}

function AccountAction({ account, owner, onManage, canConnect }: { account: LiveAccount; owner: boolean; onManage: Manage; canConnect: boolean }) {
  if (!account.target) {
    return canConnect ? <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onManage(null)}>Add family account</Button> : null;
  }
  if (account.family) {
    const needsSignIn = account.connection === "AUTH_REQUIRED" || account.connection === "EXPIRED" || account.connection === "ERROR";
    const self = Boolean(account.family.self);
    const label = !account.family.configured ? (self ? "Set up Dhan sign-in" : "Finish setup") : needsSignIn ? "Sign in with Dhan" : "Manage";
    return <Button size="sm" variant={needsSignIn || !account.family.configured ? "primary" : "secondary"} icon={needsSignIn ? <KeyRound className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />} onClick={() => onManage(account)}>{label}</Button>;
  }
  if ((account.connection === "AUTH_REQUIRED" || account.connection === "EXPIRED" || account.connection === "ERROR") && owner) {
    return <Link href="/admin" className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-border bg-elevated px-2.5 text-data font-medium text-text hover:bg-hover"><KeyRound className="h-3.5 w-3.5" aria-hidden />Reconnect in Admin</Link>;
  }
  return null;
}

const DOT_TONE: Record<Tone, string> = { neutral: "bg-muted", primary: "bg-primary", profit: "bg-profit", loss: "bg-loss", warning: "bg-warning", info: "bg-info", demo: "bg-demo" };

/** One calm status line per account instead of a stack of badges. */
function accountStatus(account: LiveAccount, syncing: boolean): { tone: Tone; text: string; tip?: string } {
  if (!account.target) return { tone: "neutral", text: "Empty slot" };
  if (!account.enabled) return { tone: "neutral", text: "Switched off", tip: "Left out of orders. Tick the box to include it." };
  if (account.connection === "NOT_CONNECTED") return { tone: "neutral", text: "Not connected" };
  if (account.connection === "AUTH_REQUIRED") return { tone: "warning", text: "Sign-in needed", tip: account.message || undefined };
  if (account.connection === "EXPIRED") return { tone: "loss", text: "Sign-in expired", tip: account.message || undefined };
  if (account.connection === "ERROR") return { tone: "loss", text: "Connection error", tip: account.message || undefined };
  if (syncing) return { tone: "info", text: "Syncing…" };
  if (account.tradingReady) return { tone: "profit", text: "Ready to trade", tip: account.tradingReason };
  return { tone: "warning", text: "Connected · trading locked", tip: account.tradingReason };
}

function StatusLine({ account, syncing }: { account: LiveAccount; syncing: boolean }) {
  const status = accountStatus(account, syncing);
  const line = (
    <span className="inline-flex items-center gap-1.5 text-data font-medium text-text-2" tabIndex={status.tip ? 0 : undefined}>
      <span className={cx("h-2 w-2 shrink-0 rounded-full", DOT_TONE[status.tone], status.tone === "profit" && "shadow-[0_0_0_3px_var(--profit-soft)]")} aria-hidden />
      {status.text}
    </span>
  );
  return status.tip ? <Tooltip content={status.tip}>{line}</Tooltip> : line;
}

export function LiveAccountCard({ account, owner, syncing, onManage, canConnect, onToggle, onRename }: { account: LiveAccount; owner: boolean; syncing: boolean; onManage: Manage; canConnect: boolean; onToggle: Toggle; onRename: Rename }) {
  const live = connected(account);
  const last = latestOrder(account);
  const synced = account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <article aria-label={account.nickname} className={cx("flex min-w-0 flex-col gap-3 rounded-card p-3.5 transition-[box-shadow,opacity] duration-200", live ? "bg-panel shadow-e1 hover:shadow-e2" : "border border-dashed border-border bg-transparent", account.target && !account.enabled && "opacity-70")}>
      <div className="flex items-start gap-2.5">
        <EnableSwitch account={account} onToggle={onToggle} />
        <div className="min-w-0 flex-1">
          <AccountName account={account} onRename={onRename} className={cx("text-body font-semibold tracking-[-0.01em]", account.target ? "text-text" : "text-muted")} />
          {account.holderName && account.holderName !== account.nickname ? <p className="truncate text-micro text-text-2" title="Holder name from Dhan">{account.holderName}</p> : null}
          <p className="num truncate text-micro text-muted">{account.clientId ? <>Client ID {account.clientId}</> : account.maskedId ?? "No account linked"}</p>
        </div>
      </div>
      <StatusLine account={account} syncing={syncing} />
      {live ? (
        <>
          <div>
            <p className="text-micro text-muted">Available</p>
            <p className="truncate text-section font-semibold tracking-[-0.02em] text-text"><Money value={account.funds?.availablePaise} broker /></p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md bg-sunken px-2.5 py-2"><p className="text-micro text-muted">Realised</p><p className="truncate text-dense font-semibold"><Money value={account.totals.realizedPaise} tone broker /></p></div>
            <div className="rounded-md bg-sunken px-2.5 py-2"><p className="text-micro text-muted">Unrealised</p><p className="truncate text-dense font-semibold"><Money value={account.totals.unrealizedPaise} tone broker /></p></div>
          </div>
          <p className="num flex flex-wrap gap-x-2 gap-y-0.5 text-micro text-muted">
            <span>Margin <span className="text-text-2"><Money value={account.funds?.usedMarginPaise} broker /></span></span>
            <span aria-hidden>·</span>
            <span><span className="text-text-2">{account.totals.openPositions ?? "–"}</span> open</span>
            {synced ? <><span aria-hidden>·</span><span>Synced {synced}</span></> : null}
          </p>
          {[account.funds?.error, account.positionsError, account.holdingsError, account.ordersError].filter(Boolean).map((error) => <p key={error} className="text-micro text-warning">{error}</p>)}
          <div className="flex min-h-5 items-center gap-1.5 text-micro text-muted">
            {last ? <><Badge tone={ORDER_TONE[last.status]}>{ORDER_LABEL[last.status]}</Badge><span className="truncate" title={`${last.symbol} ${last.reason}`}>{last.symbol}</span></> : <span>{account.orders ? "No orders today" : "Orders unavailable"}</span>}
          </div>
        </>
      ) : (
        account.message ? <p className="text-data text-muted">{account.message}</p> : null
      )}
      <AccountAction account={account} owner={owner} onManage={onManage} canConnect={canConnect} />
    </article>
  );
}

function LiveAccountTable({ accounts, owner, onManage, canConnect, onToggle, onRename }: { accounts: LiveAccount[]; owner: boolean; onManage: Manage; canConnect: boolean; onToggle: Toggle; onRename: Rename }) {
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
              <td className="border-b border-border-soft"><span className="flex items-center gap-2"><EnableSwitch account={account} onToggle={onToggle} /><AccountName account={account} onRename={onRename} className="font-semibold text-text" /></span><span className="num text-micro text-muted">{account.clientId ?? account.maskedId ?? "No account linked"}{account.holderName ? ` · ${account.holderName}` : ""}</span></td>
              <td className="border-b border-border-soft"><StateChip state={account.connection} /></td>
              <td className="border-b border-border-soft text-right">{connected(account) ? <Money value={account.funds?.availablePaise} broker /> : "—"}</td>
              <td className="border-b border-border-soft text-right">{connected(account) ? <Money value={account.funds?.usedMarginPaise} broker /> : "—"}</td>
              <td className="num border-b border-border-soft text-right">{connected(account) ? account.totals.openPositions ?? "Unavailable" : "—"}</td>
              <td className="border-b border-border-soft text-right">{connected(account) ? <Money value={account.totals.realizedPaise} tone broker /> : "—"}</td>
              <td className="border-b border-border-soft text-right">{connected(account) ? <Money value={account.totals.unrealizedPaise} tone broker /> : "—"}</td>
              <td className="num border-b border-border-soft">{account.lastSyncAt ? istStamp(account.lastSyncAt) : "—"}</td>
              <td className="border-b border-border-soft text-right"><AccountAction account={account} owner={owner} onManage={onManage} canConnect={canConnect} /></td>
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

export function LiveDesk({ view, error, syncing, layout, accountView, onAccountView, reloadToken, gate, onReload }: { view: LiveView | null; error: string; syncing: boolean; layout: Layout; accountView: "grid" | "table"; onAccountView: (next: "grid" | "table") => void; reloadToken: number; gate: LiveGate; onReload: () => void }) {
  const [tab, setTab] = useState<"orders" | "positions" | "holdings" | "rules">("orders");
  const [manage, setManage] = useState<{ open: boolean; account: LiveAccount | null; nonce: number }>({ open: false, account: null, nonce: 0 });
  const [banner, setBanner] = useState<{ tone: "info" | "loss"; text: string } | null>(null);
  useEffect(() => {
    // Dhan's consent login redirects back here with the outcome in the query string.
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const failed = params.get("connectError");
    if (!connected && !failed) return;
    window.history.replaceState(null, "", window.location.pathname);
    const timer = window.setTimeout(() => setBanner(failed ? { tone: "loss", text: failed } : { tone: "info", text: `${connected} signed in through Dhan${params.get("state") === "CONNECTED" ? " and is connected." : ". Checking the connection…"}` }), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const onManage: Manage = (account) => setManage((current) => ({ open: true, account, nonce: current.nonce + 1 }));
  const [switches, setSwitches] = useState<Record<string, boolean>>({});
  const onRename: Rename = async (account, nickname) => {
    if (!account.target) return;
    try {
      await api("/api/broker-accounts/select", { target: account.target, nickname });
      onReload();
    } catch (caught) {
      setBanner({ tone: "loss", text: caught instanceof Error ? caught.message : "The name was not saved." });
      throw caught;
    }
  };
  const onToggle: Toggle = (account, enabled) => {
    const target = account.target;
    if (!target) return;
    setSwitches((current) => ({ ...current, [target]: enabled }));
    api("/api/broker-accounts/select", { target, enabled })
      .then(() => onReload())
      .catch((caught: unknown) => {
        setSwitches((current) => ({ ...current, [target]: !enabled }));
        setBanner({ tone: "loss", text: caught instanceof Error ? caught.message : "The switch was not saved." });
      });
  };
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
  const accounts = view.accounts.map((account) => (account.target && account.target in switches ? { ...account, enabled: switches[account.target]! } : account));
  const panel = <LiveOrderPanel accounts={accounts} reloadToken={reloadToken} gate={view.gate} />;
  const panelNote = view.gate.enabled ? "Live: confirmed orders go to Dhan." : "Review only. Live placement is locked.";
  return (
    <>
      {banner ? <Notice tone={banner.tone}>{banner.text}</Notice> : null}
      {error ? <Notice tone="warning">Showing the last sync from {istStamp(view.syncedAt)}. {error}</Notice> : null}
      <Notice tone="neutral">{view.notice}</Notice>
      <LiveSummary view={view} />
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Broker accounts" description="Only verified broker connections show financial data. Empty slots stay empty." bodyClassName="flex flex-col gap-2.5" actions={
            <SegmentedControl label="Account layout" size="sm" value={accountView} onChange={onAccountView} options={[{ id: "grid", label: <span className="inline-flex items-center gap-1"><LayoutGrid className="h-3.5 w-3.5" aria-hidden />Grid</span> }, { id: "table", label: <span className="inline-flex items-center gap-1"><Rows3 className="h-3.5 w-3.5" aria-hidden />Table</span> }]} />
          }>
            {accountView === "table"
              ? <LiveAccountTable accounts={accounts} owner={view.viewerOwnsConnection} onManage={onManage} canConnect={view.capabilities.connectAccounts} onToggle={onToggle} onRename={onRename} />
              : <div className={ACCOUNT_GRID}>{accounts.map((account) => <LiveAccountCard key={account.id} account={account} owner={view.viewerOwnsConnection} syncing={syncing} onManage={onManage} canConnect={view.capabilities.connectAccounts} onToggle={onToggle} onRename={onRename} />)}</div>}
          </Section>
          {layout === "medium" ? <div id="ma-live-order" className="scroll-mt-20"><Section title="Order entry" description={panelNote}>{panel}</Section></div> : null}
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
                  <ComplianceChecklist gate={view.gate ?? gate} />
                </div>
              ) : null}
            </div>
          </Section>
        </div>
        {layout === "wide" ? (
          <aside className="no-scrollbar sticky top-[68px] max-h-[calc(100dvh-var(--topbar)-84px)] overflow-y-auto rounded-card" aria-label="Order entry">
            <Section title="CE / PE order" description={panelNote}>{panel}</Section>
          </aside>
        ) : null}
      </div>
      <FamilyAccountDrawer key={manage.nonce} open={manage.open} account={manage.account} requirements={view.missing} onClose={() => setManage((current) => ({ ...current, open: false }))} onChanged={onReload} />
      {layout !== "wide" ? (
        <button type="button" onClick={() => (layout === "narrow" ? setSheetOpen(true) : document.getElementById("ma-live-order")?.scrollIntoView({ behavior: "smooth", block: "start" }))} className="fixed bottom-[calc(var(--tabbar)+env(safe-area-inset-bottom)+16px)] right-4 z-30 inline-flex h-11 items-center gap-2 rounded-pill bg-primary px-5 text-dense font-semibold text-on-primary shadow-e2 transition hover:bg-primary-hover lg:bottom-6">
          <Plus className="h-4 w-4" aria-hidden />New order
        </button>
      ) : null}
      {layout === "narrow" ? (
        <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} modal label="Review CE / PE order" title="CE / PE order" subtitle={panelNote}>
          {panel}
        </Drawer>
      ) : null}
    </>
  );
}
