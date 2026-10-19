"use client";

import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleX, Clock, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { inr, pnl, pnlTone } from "@/components/multi-account/format";
import { cx, Skeleton, TONE_TEXT, Tooltip } from "@/components/ui";
import type { Summary } from "@/lib/multi-account/engine";

/** Combined P&L is only shown when every open position has a price; a missing price is never counted as zero. */
export function combinedPnl(summary: Summary): number | null {
  return summary.combined.unrealizedPaise == null ? null : summary.combined.realizedPaise + summary.combined.unrealizedPaise;
}

function Metric({ label, value, hint, tip }: { label: string; value: ReactNode; hint?: ReactNode; tip?: string }) {
  const body = (
    <div className="min-w-0 rounded-input border border-border-soft bg-panel px-3 py-2" tabIndex={tip ? 0 : undefined} aria-label={tip ? `${label}: ${tip}` : undefined}>
      <p className="whitespace-nowrap text-micro font-medium uppercase tracking-[0.05em] text-muted">{label}</p>
      <p className="num mt-0.5 whitespace-nowrap text-title font-semibold text-text">{value}</p>
      {hint ? <p className="mt-0.5 whitespace-nowrap text-micro text-muted">{hint}</p> : null}
    </div>
  );
  return tip ? <Tooltip content={tip}>{body}</Tooltip> : body;
}

function Counter({ icon: Icon, label, value, tone }: { icon: typeof Clock; label: string; value: number; tone: "profit" | "warning" | "loss" | "info" }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap text-data", value > 0 ? TONE_TEXT[tone] : "text-muted")}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="num font-semibold">{value}</span>
      <span>{label}</span>
    </span>
  );
}

export function SummaryStrip({ summary }: { summary: Summary }) {
  const total = combinedPnl(summary);
  const tone = pnlTone(total);
  const TrendIcon = total == null || total === 0 ? Minus : total > 0 ? TrendingUp : TrendingDown;
  const { combined, orderCounts } = summary;
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
      <section aria-label="Combined P&L" className={cx("surface relative overflow-hidden px-4 py-3.5", tone === "profit" && "border-profit/30", tone === "loss" && "border-loss/30")}>
        <span className={cx("absolute inset-y-0 left-0 w-1", tone === "profit" ? "bg-profit" : tone === "loss" ? "bg-loss" : "bg-border")} aria-hidden />
        <p className="text-micro font-medium uppercase tracking-[0.05em] text-muted">Combined P&L · all accounts</p>
        <div className="mt-1 flex items-center gap-2">
          <TrendIcon className={cx("h-5 w-5 shrink-0", TONE_TEXT[tone])} aria-hidden />
          <p className={cx("num text-hero font-semibold", total == null ? "text-muted" : TONE_TEXT[tone])}>{pnl(total)}</p>
        </div>
        {total == null ? <p className="mt-0.5 text-micro text-warning">{combined.marksMissing} {combined.marksMissing === 1 ? "position has" : "positions have"} no current price</p> : null}
        <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-border-soft pt-2 text-data">
          <div className="min-w-0"><dt className="text-micro text-muted">Realised</dt><dd className={cx("num truncate font-semibold", TONE_TEXT[pnlTone(combined.realizedPaise)])}>{pnl(combined.realizedPaise)}</dd></div>
          <div className="min-w-0"><dt className="text-micro text-muted">Unrealised</dt><dd className={cx("num truncate font-semibold", combined.unrealizedPaise == null ? "text-muted" : TONE_TEXT[pnlTone(combined.unrealizedPaise)])}>{pnl(combined.unrealizedPaise)}</dd></div>
          <div className="min-w-0"><dt className="text-micro text-muted">Today realised</dt><dd className={cx("num truncate font-semibold", TONE_TEXT[pnlTone(combined.dayRealizedPaise)])}>{pnl(combined.dayRealizedPaise)}</dd></div>
        </dl>
      </section>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          <Metric label="Selected" value={`${summary.selected} / 8`} hint="accounts in this order" />
          <Metric label="Enabled" value={`${summary.enabled} / 8`} hint="trading turned on" />
          <Metric label="Total demo cash" value={inr(combined.cashPaise)} hint="virtual, not real money" tip="Sum of available cash in all eight demo accounts." />
          <Metric label="In positions" value={inr(combined.investedPaise)} hint="at average cost" tip="Money currently held in open demo positions, at average cost including buy charges." />
          <Metric label="Open positions" value={combined.openPositions} hint={combined.marksMissing ? `${combined.marksMissing} unpriced` : "all priced"} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-input border border-border-soft bg-panel px-3 py-2" aria-label="Request status counts">
          <span className="text-micro font-medium uppercase tracking-[0.05em] text-muted">Requests</span>
          <Counter icon={CircleCheck} label="completed" value={orderCounts.Completed} tone="profit" />
          <Counter icon={CircleAlert} label="partial" value={orderCounts["Partially Completed"]} tone="warning" />
          <Counter icon={CircleX} label="failed" value={orderCounts.Failed} tone="loss" />
          <Counter icon={Clock} label="pending" value={orderCounts.Pending} tone="info" />
        </div>
      </div>
    </div>
  );
}

export function SummarySkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]" aria-hidden>
      <Skeleton className="h-[132px] rounded-card" />
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-[66px]" />)}</div>
        <Skeleton className="h-9" />
      </div>
    </div>
  );
}
