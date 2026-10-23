"use client";

import { Minus, Plus, Settings2, TriangleAlert } from "lucide-react";
import { inr, pnl, pnlTone } from "@/components/multi-account/format";
import { LegChip } from "@/components/multi-account/status";
import { Badge, Button, cx, Skeleton, TONE_TEXT, Tooltip } from "@/components/ui";
import type { AccountSummary, DemoAccount, Leg } from "@/lib/multi-account/engine";

export const ACCOUNT_GRID = "grid grid-cols-1 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))]";

export const DISABLED_REASON = "Trading is turned off in this account's settings.";

export function simId(account: Pick<DemoAccount, "slot">) {
  return `SIM-${String(account.slot).padStart(2, "0")}`;
}

export function lossLimitHit(account: DemoAccount, stats: AccountSummary | null) {
  return stats ? stats.dayRealizedPaise <= -account.risk.maxDailyLossPaise : false;
}

export function LotsControl({ account, onLots }: { account: DemoAccount; onLots: (lots: number) => void }) {
  const set = (next: number) => { if (next >= 1 && next <= account.risk.maxLots && next !== account.lots) onLots(next); };
  return (
    <div className="inline-flex h-7 items-stretch overflow-hidden rounded-sm border border-border bg-sunken" role="group" aria-label={`Lots per order for ${account.nickname}`}>
      <button type="button" aria-label={`Decrease lots for ${account.nickname}`} disabled={account.lots <= 1} onClick={() => set(account.lots - 1)} className="grid w-7 place-items-center text-text-2 transition-colors hover:bg-hover disabled:opacity-40"><Minus className="h-3.5 w-3.5" aria-hidden /></button>
      <span className="num grid min-w-8 place-items-center border-x border-border-soft px-1 text-dense font-semibold text-text" aria-live="polite">{account.lots}</span>
      <button type="button" aria-label={`Increase lots for ${account.nickname}`} disabled={account.lots >= account.risk.maxLots} onClick={() => set(account.lots + 1)} className="grid w-7 place-items-center text-text-2 transition-colors hover:bg-hover disabled:opacity-40"><Plus className="h-3.5 w-3.5" aria-hidden /></button>
    </div>
  );
}

function UsageBar({ used, max, label }: { used: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  return (
    <div className="flex items-center gap-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} aria-valuetext={`${used} of ${max} open positions used`}>
      <span className="h-1.5 flex-1 overflow-hidden rounded-pill bg-border-soft">
        <span className={cx("block h-full rounded-pill transition-[width] duration-200", ratio >= 1 ? "bg-loss" : ratio >= 0.8 ? "bg-warning" : "bg-primary")} style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="num shrink-0 text-micro text-text-2">{used}/{max}</span>
    </div>
  );
}

function SettingsButton({ account, onEdit }: { account: DemoAccount; onEdit: () => void }) {
  return (
    <Tooltip content="Account settings and risk limits">
      <button type="button" onClick={onEdit} aria-label={`Settings for ${account.nickname}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-text">
        <Settings2 className="h-4 w-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

function LastOrder({ latest }: { latest: Leg | null }) {
  if (!latest) return <span className="text-micro text-muted">No orders yet</span>;
  return (
    <Tooltip content={latest.reason}>
      <span className="flex min-w-0 items-center gap-1.5" tabIndex={0} aria-label={`Last order: ${latest.status}. ${latest.reason}`}>
        <LegChip status={latest.status} />
        <span className="truncate text-micro text-muted">{latest.reason}</span>
      </span>
    </Tooltip>
  );
}

export function AccountCard({ account, stats, latest, onToggle, onLots, onEdit }: { account: DemoAccount; stats: AccountSummary | null; latest: Leg | null; onToggle: () => void; onLots: (lots: number) => void; onEdit: () => void }) {
  const disabled = !account.tradingEnabled;
  const lossHit = lossLimitHit(account, stats);
  const realized = account.realizedPaise;
  const unrealized = stats?.unrealizedPaise ?? null;
  return (
    <article aria-label={account.nickname} className={cx(
      "group flex min-w-0 flex-col gap-2 rounded-md border p-2.5 transition-[background-color,border-color,box-shadow] duration-150",
      account.selected ? "border-primary bg-primary-soft/50 shadow-e1 ring-1 ring-primary/30" : "border-border-soft bg-panel hover:border-border",
      disabled && "border-dashed bg-sunken",
    )}>
      <div className="flex items-start gap-2">
        <label className={cx("flex min-w-0 flex-1 items-start gap-2", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]" checked={account.selected} disabled={disabled} onChange={onToggle} aria-describedby={disabled ? `${account.id}-off` : undefined} />
          <span className="min-w-0">
            <span className={cx("block truncate text-dense font-semibold", disabled ? "text-text-2" : "text-text")}>{account.nickname}</span>
            <span className="num block text-micro text-muted">{simId(account)} · virtual</span>
          </span>
        </label>
        <SettingsButton account={account} onEdit={onEdit} />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {disabled
          ? <Tooltip content={DISABLED_REASON}><span tabIndex={0}><Badge tone="neutral">Trading off</Badge></span></Tooltip>
          : <Badge tone="profit" dot>Ready</Badge>}
        <Badge tone="demo">Simulated</Badge>
        {lossHit ? <Tooltip content="Daily loss limit reached. New buys are blocked until tomorrow; closing is still allowed."><span tabIndex={0}><Badge tone="loss"><TriangleAlert className="h-3 w-3" aria-hidden />Loss limit</Badge></span></Tooltip> : null}
      </div>
      {disabled ? <p id={`${account.id}-off`} className="sr-only">{DISABLED_REASON}</p> : null}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-border-soft bg-border-soft">
        <div className="bg-sunken px-2 py-1.5">
          <p className="text-micro text-muted">Realised</p>
          <p className={cx("num truncate text-dense font-semibold", TONE_TEXT[pnlTone(realized)])}>{pnl(realized)}</p>
        </div>
        <div className="bg-sunken px-2 py-1.5">
          <p className="text-micro text-muted">Unrealised</p>
          <p className={cx("num truncate text-dense font-semibold", unrealized == null ? "text-muted" : TONE_TEXT[pnlTone(unrealized)])}>{pnl(unrealized)}</p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-2 text-data">
        <div className="min-w-0"><dt className="text-micro text-muted">Cash</dt><dd className="num truncate text-text">{inr(account.cashPaise)}</dd></div>
        <div className="min-w-0 text-right"><dt className="text-micro text-muted">In positions</dt><dd className="num truncate text-text">{inr(stats?.investedPaise ?? 0)}</dd></div>
      </dl>

      <div>
        <p className="mb-1 text-micro text-muted">Open positions</p>
        <UsageBar used={stats?.openPositions ?? 0} max={account.risk.maxOpenPositions} label={`Open positions for ${account.nickname}, limit ${account.risk.maxOpenPositions}`} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border-soft pt-2">
        <span className="text-micro text-muted">Lots / order</span>
        <LotsControl account={account} onLots={onLots} />
      </div>
      <div className="min-h-5"><LastOrder latest={latest} /></div>
    </article>
  );
}

export function AccountTable({ accounts, summaries, latest, onToggle, onLots, onEdit }: { accounts: DemoAccount[]; summaries: AccountSummary[]; latest: Map<string, Leg>; onToggle: (account: DemoAccount) => void; onLots: (account: DemoAccount, lots: number) => void; onEdit: (account: DemoAccount) => void }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border-soft">
      <table className="ui-table dense w-full min-w-[55rem] border-separate border-spacing-0 text-data" aria-label="Accounts">
        <thead>
          <tr className="bg-sunken">
            <th scope="col" className="w-8 border-b border-border-soft"><span className="sr-only">Select</span></th>
            <th scope="col" className="border-b border-border-soft text-left">Account</th>
            <th scope="col" className="border-b border-border-soft text-left">Status</th>
            <th scope="col" className="border-b border-border-soft text-right">Cash</th>
            <th scope="col" className="border-b border-border-soft text-right">Positions</th>
            <th scope="col" className="border-b border-border-soft text-right">Realised</th>
            <th scope="col" className="border-b border-border-soft text-right">Unrealised</th>
            <th scope="col" className="border-b border-border-soft text-center">Lots</th>
            <th scope="col" className="border-b border-border-soft text-left">Last order</th>
            <th scope="col" className="w-10 border-b border-border-soft"><span className="sr-only">Settings</span></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => {
            const stats = summaries.find((row) => row.accountId === account.id) ?? null;
            const disabled = !account.tradingEnabled;
            const unrealized = stats?.unrealizedPaise ?? null;
            return (
              <tr key={account.id} className={cx("transition-colors", account.selected && "bg-primary-soft/40", disabled && "text-text-2")}>
                <td className="border-b border-border-soft"><input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={account.selected} disabled={disabled} onChange={() => onToggle(account)} aria-label={`Select ${account.nickname}`} title={disabled ? DISABLED_REASON : undefined} /></td>
                <td className="border-b border-border-soft"><span className="block font-semibold text-text">{account.nickname}</span><span className="num text-micro text-muted">{simId(account)}</span></td>
                <td className="border-b border-border-soft">{disabled ? <span title={DISABLED_REASON}><Badge tone="neutral">Trading off</Badge></span> : <Badge tone="profit" dot>Ready</Badge>}{lossLimitHit(account, stats) ? <Badge tone="loss" className="ml-1">Loss limit</Badge> : null}</td>
                <td className="num border-b border-border-soft text-right">{inr(account.cashPaise)}</td>
                <td className="num border-b border-border-soft text-right">{stats?.openPositions ?? 0}/{account.risk.maxOpenPositions}</td>
                <td className={cx("num border-b border-border-soft text-right", TONE_TEXT[pnlTone(account.realizedPaise)])}>{pnl(account.realizedPaise)}</td>
                <td className={cx("num border-b border-border-soft text-right", unrealized == null ? "text-muted" : TONE_TEXT[pnlTone(unrealized)])}>{pnl(unrealized)}</td>
                <td className="border-b border-border-soft text-center"><LotsControl account={account} onLots={(lots) => onLots(account, lots)} /></td>
                <td className="max-w-[13.75rem] border-b border-border-soft"><LastOrder latest={latest.get(account.id) ?? null} /></td>
                <td className="border-b border-border-soft"><SettingsButton account={account} onEdit={() => onEdit(account)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BulkBar({ count, lots, canSelectMore, onSelectAll, onClear }: { count: number; lots: number; canSelectMore: boolean; onSelectAll: () => void; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="anim-fade flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-input border border-primary/30 bg-primary-soft/60 px-3 py-1.5" role="status" aria-live="polite">
      <p className="text-data text-text"><span className="num font-semibold">{count}</span> selected · <span className="num font-semibold">{lots}</span> {lots === 1 ? "lot" : "lots"} in total</p>
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={onSelectAll} disabled={!canSelectMore}>Select all enabled</Button>
      <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
    </div>
  );
}

export function AccountsSkeleton({ view }: { view: "grid" | "table" }) {
  if (view === "table") return <div className="flex flex-col gap-1.5" aria-hidden>{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-11" />)}</div>;
  return <div className={ACCOUNT_GRID} aria-hidden>{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-[15.625rem] rounded-md" />)}</div>;
}
