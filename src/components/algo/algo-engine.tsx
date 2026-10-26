"use client";

import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { api } from "@/components/api";
import { ENGINE_LABEL, type AlgoConfig, type AlgoState, type EngineStatus } from "@/lib/algo/runner";
import { RISK_DEFAULTS } from "@/lib/algo/sizing";
import type { MarketPlan } from "@/lib/algo/plan";

const TONE: Record<EngineStatus, string> = {
  BUY_CANDIDATE: "bg-profit-soft text-profit",
  SELL_CANDIDATE: "bg-loss-soft text-loss",
  WAIT_FOR_CONFIRMATION: "bg-warning-soft text-warning",
  NO_TRADE: "bg-sunken text-text-2",
  DAILY_RISK_LIMIT_REACHED: "bg-loss-soft text-loss",
  TRADING_WINDOW_CLOSED: "bg-sunken text-muted",
};
const inr = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? "—" : `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const ist = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16);
const sessionSeconds = (date: string, hhmm: string) => Math.floor(Date.parse(`${date}T${hhmm}:00+05:30`) / 1000);

/**
 * The early-session engine at a glance: its state on the latest candle and why, the trade plan (index stop
 * and target, lots, rupee risk, reward : risk, setup score with each part), the day's P&L against the
 * target and the loss allowance, and the time left in the entry window. `now` is the replay clock in
 * replay and the wall clock live.
 */
export function EngineCard({ state, config, date, now, unrealized, available = null, position = null }: {
  state: AlgoState | null | undefined;
  config: AlgoConfig;
  date: string;
  now: number | null;
  unrealized: number | null;
  /** Cash available on the Algo account (from the ledger, after every order and exit). */
  available?: string | null;
  /** The open position, valued at its latest replay premium. */
  position?: { quantity: number; lots: number; avg: number; stop: number; target: number; entryCharges: number; premium?: number | null; unrealized?: number | null } | null;
}) {
  const engine = state?.engine ?? null;
  const risk = { ...RISK_DEFAULTS, ...config.risk };
  const realized = state?.realizedToday ?? 0;
  const net = realized + (unrealized ?? 0);
  const allowance = Math.max(0, config.maxDailyLoss + Math.min(0, realized));
  const start = sessionSeconds(date, config.entryStart);
  const end = sessionSeconds(date, config.entryCutoff);
  const left = now == null ? null : now < start ? null : Math.max(0, end - now);
  const windowText = now == null ? `${config.entryStart}–${config.entryCutoff} IST` : now < start ? `Opens at ${config.entryStart} IST` : left ? `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, "0")}s left (to ${config.entryCutoff})` : `Closed at ${config.entryCutoff} IST`;
  const plan = engine?.plan ?? null;
  const progress = risk.dailyTarget > 0 ? Math.max(0, Math.min(1, net / risk.dailyTarget)) : 0;
  return (
    <section className="rounded-lg border border-border-soft" aria-label="Strategy engine">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Engine</span>
        {state?.position ? (
          <span className="rounded-pill bg-profit-soft px-2 py-0.5 text-xs font-semibold text-profit" role="status">POSITION OPEN — Managing stop and target</span>
        ) : (
          <span className={cx("rounded-pill px-2 py-0.5 text-xs font-semibold", engine ? TONE[engine.status] : "bg-sunken text-muted")} role="status">{engine ? ENGINE_LABEL[engine.status] : "WAITING FOR DATA"}</span>
        )}
        <span className="num ml-auto text-xs text-muted">{engine ? `${ist(engine.time)} IST` : ""}</span>
      </div>
      <div className="space-y-2 border-t border-border-soft px-3 py-2 text-xs">
        {engine ? <p className="leading-snug text-text-2">{engine.reason}</p> : <p className="text-muted">No completed candle evaluated yet.</p>}
        {plan ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md bg-sunken/50 p-2">
            <Cell label="Index stop / target" value={`${plan.stopIndex.toFixed(2)} / ${plan.targetIndex.toFixed(2)}`} />
            <Cell label="Reward : risk" value={`${plan.rewardRisk} : 1${plan.room ? ` (room ${plan.room.ratio})` : ""}`} />
            <Cell label="Position size" value={plan.lots ? `${plan.lots} lot${plan.lots === 1 ? "" : "s"} · ${plan.quantity} qty` : "None (1 lot over budget)"} tone={plan.lots ? undefined : "text-loss"} />
            <Cell label={plan.lots ? "Risk at the stop" : "1 lot would risk"} value={`${inr(plan.risk)} of ${inr(plan.budget)}`} tone={plan.risk > plan.budget ? "text-loss" : undefined} />
            <Cell label="Premium stop / target" value={`${inr(plan.premiumStop)} / ${inr(plan.premiumTarget)}`} />
            <Cell label="Setup score" value={`${plan.score.score} / 100 (min ${config.minScore})`} tone={plan.score.score >= config.minScore ? "text-profit" : "text-loss"} />
            <details className="col-span-2">
              <summary className="cursor-pointer text-muted hover:text-text">How the score was measured</summary>
              <ul className="mt-1 space-y-0.5">
                {plan.score.parts.map((part) => <li key={part.label} className="flex gap-2"><span className="num w-12 shrink-0 text-right text-text">{part.points}/{part.max}</span><span className="text-text-2"><strong className="font-medium">{part.label}:</strong> {part.why}</span></li>)}
              </ul>
              <p className="mt-1 text-muted">A score is a checklist, not a probability. Calibrate the minimum with the backtest.</p>
            </details>
          </dl>
        ) : null}
        {config.sizing === "capital" ? <CapitalBlock capital={engine?.capital ?? null} available={available} position={position} config={config} /> : null}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Cell label="Net P&L today" value={inr(net)} tone={net > 0 ? "text-profit" : net < 0 ? "text-loss" : undefined} />
          <Cell label={`Target ${inr(risk.dailyTarget)} (goal)`} value={net >= risk.dailyTarget ? "Reached" : `${inr(risk.dailyTarget - net)} to go`} />
          <Cell label="Loss allowance left" value={`${inr(allowance)} of ${inr(config.maxDailyLoss)}`} tone={allowance <= 0 ? "text-loss" : undefined} />
          <Cell label="Entry window" value={windowText} />
        </dl>
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label="Progress to the daily target" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><div className="h-full bg-profit" style={{ width: `${progress * 100}%` }} /></div>
        <p className="text-muted">The target is a goal, not an expected result. No setup means no trade; risk is never raised to reach it.</p>
      </div>
    </section>
  );
}

/**
 * Capital sizing at a glance: before a trade, the latest plan (what the allocation and the available cash
 * buy); with a position, what it commits, its premium levels, charges and net P&L. Figures come from the
 * ledger and the replay premium; nothing is estimated except the exit charges, which are labelled.
 */
function CapitalBlock({ capital, available, position, config }: { capital: NonNullable<AlgoState["engine"]>["capital"] | null; available: string | null; position: { quantity: number; lots: number; avg: number; stop: number; target: number; entryCharges: number; premium?: number | null; unrealized?: number | null } | null; config: AlgoConfig }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md bg-sunken/50 p-2" aria-label="Capital">
      <Cell label="Available funds" value={available ?? "—"} />
      <Cell label="Allocation" value={`${config.allocation.percent}% of ${inr(config.allocation.maxCapital)}`} />
      {position ? (
        <>
          <Cell label="Committed capital" value={inr(position.avg * position.quantity + position.entryCharges)} />
          <Cell label="Quantity" value={`${position.lots} lot${position.lots === 1 ? "" : "s"} · ${position.quantity}`} />
          <Cell label="Entry premium" value={inr(position.avg)} />
          <Cell label="Target / stop premium" value={`${inr(position.target)} / ${inr(position.stop)}`} />
          <Cell label="Charges (entry; exit est.)" value={`${inr(position.entryCharges)}; ≈${inr(position.entryCharges)}`} />
          <Cell label="Net P&L now" value={position.unrealized == null ? "—" : inr(position.unrealized)} tone={(position.unrealized ?? 0) > 0 ? "text-profit" : (position.unrealized ?? 0) < 0 ? "text-loss" : undefined} />
          <p className="col-span-2 text-muted">Net P&amp;L is after the entry charges; the exit&apos;s charges are deducted when it fills. Target and stop are on the option premium, not the account.</p>
        </>
      ) : capital ? (
        <>
          <Cell label="Planned quantity" value={capital.lots ? `${capital.lots} lot${capital.lots === 1 ? "" : "s"} · ${capital.quantity}` : "None"} tone={capital.lots ? undefined : "text-loss"} />
          <Cell label="Premium · lot size" value={`${inr(capital.price)} · ${capital.lotSize}`} />
          <Cell label="Would commit" value={capital.lots ? `${inr(capital.committed)} (charges ${inr(capital.entryCharges)})` : "—"} />
          <Cell label="Cash at the signal" value={inr(capital.available)} />
          {capital.note ? <p className="col-span-2 text-muted">{capital.note}</p> : null}
        </>
      ) : <p className="col-span-2 text-muted">No signal yet: the quantity is planned from the actual premium and lot size when one appears.</p>}
    </dl>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className={cx("num break-words font-medium", tone ?? "text-text")}>{value}</dd>
    </div>
  );
}

/** The provisional pre-market plan for a session (fetched once per date). */
export function MarketPlanSection({ date }: { date: string | null }) {
  const [result, setResult] = useState<{ date: string; plan: MarketPlan | null; reason: string } | null>(null);
  useEffect(() => {
    if (!date) return;
    let live = true;
    api<{ ok: true; plan: MarketPlan } | { ok: false; reason: string }>(`/api/algo?plan=${date}`)
      .then((answer) => { if (live) setResult({ date, plan: answer.ok ? answer.plan : null, reason: answer.ok ? "" : answer.reason }); })
      .catch((caught: unknown) => { if (live) setResult({ date, plan: null, reason: caught instanceof Error ? caught.message : "The plan could not be loaded." }); });
    return () => { live = false; };
  }, [date]);
  const current = result && result.date === date ? result : null;
  const plan = current?.plan ?? null;
  return (
    <details className="rounded-lg border border-border-soft" aria-label="Pre-market plan">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Pre-market plan</span>
        <span className="rounded-pill bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning">PROVISIONAL</span>
        <span className="num ml-auto text-xs text-muted">{date ?? ""}</span>
      </summary>
      <div className="space-y-2 border-t border-border-soft px-3 py-2 text-xs">
        {!date ? <p className="text-muted">No session selected.</p> : !current ? <p className="text-muted">Loading…</p> : !plan ? <p className="text-warning">{current.reason}</p> : (
          <>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <Cell label={`Previous day ${plan.previous.date}`} value={`H ${plan.previous.high.toFixed(2)} · L ${plan.previous.low.toFixed(2)}`} />
              <Cell label="Close · range" value={`${plan.previous.close.toFixed(2)} · ${plan.previous.range.toFixed(2)}`} />
              <Cell label="Opening gap" value={plan.gap ? `${plan.gap.points >= 0 ? "+" : ""}${plan.gap.points.toFixed(2)} (${plan.gap.percent}%)` : "Before the open"} />
              <Cell label="Daily structure" value={plan.dailyStructure} />
              <Cell label="Daily ATR (14)" value={plan.volatility.atr == null ? "—" : plan.volatility.atr.toFixed(2)} />
              <Cell label={`Gaps (last ${Math.max(0, plan.volatility.days - 1)})`} value={`${plan.volatility.gapsUp} up · ${plan.volatility.gapsDown} down · avg ${plan.volatility.averageGapPercent ?? "—"}%`} />
              <Cell label="Risk per trade" value={`₹${plan.risk.perTrade}${plan.risk.maxIndexStop != null ? ` (1 lot: stop ≤ ${plan.risk.maxIndexStop} pts)` : ""}`} />
              <Cell label="Daily loss · target" value={`₹${plan.risk.dailyLoss} · ₹${plan.risk.dailyTarget}`} />
            </dl>
            <div>
              <p className="mb-1 font-medium text-text-2">Key levels</p>
              <ul className="space-y-0.5">{plan.levels.map((level) => <li key={level.label} className="flex justify-between gap-2"><span className={level.kind === "RESISTANCE" ? "text-loss" : level.kind === "SUPPORT" ? "text-profit" : "text-text-2"}>{level.label}</span><span className="num">{level.price.toFixed(2)}</span></li>)}</ul>
            </div>
            {([["Bullish scenarios", plan.bullish, "text-profit"], ["Bearish scenarios", plan.bearish, "text-loss"]] as const).map(([title, list, tone]) => (
              <div key={title}>
                <p className={cx("mb-1 font-medium", tone)}>{title}</p>
                <ul className="space-y-1.5">{list.map((item) => <li key={item.title} className="rounded-md bg-sunken/50 p-1.5"><p className="font-medium text-text">{item.title}</p><p className="text-text-2">Trigger: {item.trigger}</p><p className="text-text-2">Invalidated by: {item.invalidation}</p><p className="text-muted">Entry zone: {item.entryZone}</p></li>)}</ul>
              </div>
            ))}
            <ul className="list-disc space-y-0.5 pl-4 text-muted">{plan.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          </>
        )}
      </div>
    </details>
  );
}
