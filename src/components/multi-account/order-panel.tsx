"use client";

import { useMemo, type ReactNode } from "react";
import { ChevronDown, FlaskConical, ShieldCheck, X } from "lucide-react";
import { istStamp } from "@/components/api";
import { AccountSelector } from "@/components/multi-account/account-selector";
import { contractLabel, expiryLabel, FIELD, inr, LABEL } from "@/components/multi-account/format";
import { LegChip, OverallChip } from "@/components/multi-account/status";
import type { OrderForm } from "@/components/multi-account/use-order-form";
import { Badge, Button, cx, Drawer, Notice, SegmentedControl } from "@/components/ui";
import { FEATURED_INDICES } from "@/lib/market/indices";
import type { DemoDoc, OrderRequest, PriceSource } from "@/lib/multi-account/engine";

const UNDERLYINGS = [...new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", ...FEATURED_INDICES.map((item) => item.symbol)])];

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? <span id={id} className="text-micro font-normal text-loss">{text}</span> : null;
}

function BigToggle<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (next: T) => void; options: Array<{ id: T; label: ReactNode; active: string }> }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-1 rounded-input border border-border-soft bg-sunken p-1">
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button key={option.id} type="button" role="radio" aria-checked={on} onClick={() => onChange(option.id)}
            className={cx("h-9 rounded-sm text-dense font-bold tracking-[0.02em] transition-colors duration-150", on ? option.active : "text-muted hover:bg-hover hover:text-text")}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function OrderEntry({ form, doc, source, selected, onSelect, disabled, disabledReason, onReview }: {
  form: OrderForm;
  doc: DemoDoc;
  source: PriceSource;
  selected: string[];
  onSelect: (next: string[]) => void;
  disabled: boolean;
  disabledReason: string;
  onReview: () => void;
}) {
  const { fields, set, chain, chainLoading, problems } = form;
  const accounts = useMemo(() => doc.accounts.map((account) => ({ id: account.id, slot: account.slot, nickname: account.nickname, disabled: !account.tradingEnabled, note: account.tradingEnabled ? undefined : "Trading is turned off in this account's settings." })), [doc.accounts]);
  const advancedOpen = Boolean(fields.stopText || fields.targetText);
  const contractText = fields.strike != null && fields.expiry ? `${fields.underlying} ${fields.strike} ${fields.right}` : "Choose a contract";
  const premiumText = form.chainPremium != null && form.chainPremium > 0
    ? inr(Math.round(form.chainPremium * 100))
    : source.kind === "replay" ? "Unavailable until review" : "Unavailable";
  const buy = fields.side === "BUY";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {disabled ? <Notice tone="warning">{disabledReason}</Notice> : null}
      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
        <legend className="sr-only">Order details</legend>
        <div className="grid grid-cols-3 gap-2">
          <label className={LABEL}>Underlying
            <select className={FIELD} value={fields.underlying} onChange={(event) => set.setUnderlying(event.target.value)}>
              {UNDERLYINGS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
            </select>
          </label>
          <label className={LABEL}>Expiry
            <select className={FIELD} value={fields.expiry} onChange={(event) => set.setExpiry(event.target.value)} disabled={!chain?.expiries.length} aria-invalid={Boolean(problems.expiry) || undefined}>
              {!chain?.expiries.length ? <option value="">{chainLoading ? "Loading…" : "None listed"}</option> : null}
              {chain?.expiries.map((day) => <option key={day} value={day}>{expiryLabel(day)}</option>)}
            </select>
          </label>
          <label className={LABEL}>Strike
            <select className={FIELD} value={fields.strike ?? ""} onChange={(event) => set.setStrike(Number(event.target.value))} disabled={!chain?.strikes.length} aria-invalid={Boolean(problems.strike) || undefined}>
              {!chain?.strikes.length ? <option value="">{chainLoading ? "Loading…" : "None listed"}</option> : null}
              {chain?.strikes.map((row) => <option key={row.strike} value={row.strike}>{row.strike}{row.strike === chain.atmStrike ? " · ATM" : ""}</option>)}
            </select>
          </label>
        </div>
        {form.chainError ? <Notice tone="warning">{form.chainError}</Notice> : null}

        <div className="grid grid-cols-2 gap-2">
          <BigToggle label="Option type" value={fields.right} onChange={set.setRight} options={[{ id: "CE", label: "CE · Call", active: "bg-elevated text-text shadow-e1 ring-1 ring-border" }, { id: "PE", label: "PE · Put", active: "bg-elevated text-text shadow-e1 ring-1 ring-border" }]} />
          <BigToggle label="Side" value={fields.side} onChange={set.setSide} options={[{ id: "BUY", label: "BUY", active: "bg-profit text-on-signal shadow-e1" }, { id: "SELL", label: "SELL", active: "bg-loss text-on-signal shadow-e1" }]} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className={LABEL}>Order type
            <SegmentedControl label="Order type" block size="sm" value={fields.orderType} onChange={set.setOrderType} options={[{ id: "MARKET", label: "Market" }, { id: "LIMIT", label: "Limit" }]} />
          </div>
          <div className={LABEL}>Product
            <SegmentedControl label="Product" block size="sm" value={fields.product} onChange={set.setProduct} options={[{ id: "INTRADAY", label: "Intraday" }, { id: "MARGIN", label: "Carry" }]} />
          </div>
        </div>

        {fields.orderType === "LIMIT" ? (
          <label className={LABEL}>
            <span className="flex items-center justify-between gap-2">Limit price (₹ premium)<FieldError id="ma-limit-error" text={problems.limit} /></span>
            <input className={cx(FIELD, problems.limit && "border-loss")} inputMode="decimal" value={fields.limitText} onChange={(event) => set.setLimitText(event.target.value)} placeholder="e.g. 120.50" aria-invalid={Boolean(problems.limit) || undefined} aria-describedby={problems.limit ? "ma-limit-error" : undefined} />
          </label>
        ) : null}

        <details className="group rounded-input border border-border-soft bg-sunken/60 open:bg-sunken" open={advancedOpen || undefined}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-data font-medium text-text-2 [&::-webkit-details-marker]:hidden">
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden />
            Advanced
            <span className="text-micro font-normal text-muted">stop-loss · target</span>
          </summary>
          <div className="grid grid-cols-2 gap-2 px-3 pb-3">
            <label className={LABEL}>
              <span className="flex items-center justify-between gap-1">Stop-loss (₹)<FieldError id="ma-stop-error" text={problems.stop} /></span>
              <input className={cx(FIELD, problems.stop && "border-loss")} inputMode="decimal" value={fields.stopText} onChange={(event) => set.setStopText(event.target.value)} aria-invalid={Boolean(problems.stop) || undefined} aria-describedby={problems.stop ? "ma-stop-error" : undefined} />
            </label>
            <label className={LABEL}>
              <span className="flex items-center justify-between gap-1">Target (₹)<FieldError id="ma-target-error" text={problems.target} /></span>
              <input className={cx(FIELD, problems.target && "border-loss")} inputMode="decimal" value={fields.targetText} onChange={(event) => set.setTargetText(event.target.value)} aria-invalid={Boolean(problems.target) || undefined} aria-describedby={problems.target ? "ma-target-error" : undefined} />
            </label>
            <p className="col-span-2 text-micro text-muted">Saved with the request for reference. The demo desk does not trigger them automatically.</p>
          </div>
        </details>

        <div>
          <AccountSelector accounts={accounts} selected={selected} onChange={onSelect} label="Place for" disabled={disabled} />
          {problems.accounts ? <p className="mt-1 text-micro text-loss">{problems.accounts}</p> : null}
        </div>
      </fieldset>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-input border border-border-soft bg-sunken px-3 py-2.5 text-data" aria-label="Order summary">
        <dt className="text-muted">Contract</dt><dd className="truncate text-right font-semibold text-text">{contractText}</dd>
        <dt className="text-muted">Premium{source.kind === "chain" && form.chainPremium != null ? " · chain" : ""}</dt><dd className={cx("num text-right", form.chainPremium != null ? "text-text" : "text-muted")}>{premiumText}</dd>
        <dt className="text-muted">Lot size</dt><dd className="num text-right text-text">{chain?.lotSize ?? "Unavailable"}</dd>
        <dt className="text-muted">Eligible accounts</dt><dd className="num text-right text-text">{form.eligibleCount}</dd>
        <dt className="text-muted">Total lots</dt><dd className="num text-right text-text">{form.totalLots}</dd>
        <dt className="text-muted">Est. premium value</dt><dd className={cx("num text-right font-semibold", form.estimatePaise != null ? "text-text" : "text-muted")}>{form.estimatePaise != null ? `≈ ${inr(form.estimatePaise)}` : "Unavailable"}</dd>
      </dl>

      <div>
        <Button size="lg" block variant={buy ? "buy" : "sell"} loading={form.checking} disabled={disabled || Boolean(form.firstProblem)} onClick={onReview} aria-describedby={form.firstProblem ? "ma-review-hint" : undefined}>
          {buy ? "Review Buy Order" : "Review Sell Order"}
        </Button>
        <p id="ma-review-hint" className="mt-1.5 text-center text-micro text-muted">{form.firstProblem && !disabled ? form.firstProblem : "Estimate only. Nothing is placed until you confirm."}</p>
      </div>
    </div>
  );
}

export function OrderConfirmation({ form }: { form: OrderForm }) {
  const { review, plans, totals } = form;
  const accepted = plans.filter((plan) => !plan.reject);
  const rejected = plans.filter((plan) => plan.reject);
  const sideWord = review?.intent.side === "BUY" ? "Buy" : "Sell";
  const confirmLabel = review ? `Confirm ${sideWord} ${contractLabel(review.intent.contract)} · ${totals.accepted} ${totals.accepted === 1 ? "account" : "accounts"}` : "";
  return (
    <Drawer
      open={review != null}
      onClose={form.closeReview}
      modal
      label="Review multi-account order"
      title="Review Order"
      subtitle={review ? `${contractLabel(review.intent.contract)} · ${expiryLabel(review.intent.contract.expiry)}` : undefined}
      width="w-[31.25rem]"
      footer={review ? (
        <div className="flex flex-col gap-2.5">
          <dl className="grid grid-cols-4 gap-2 text-data">
            <div><dt className="text-micro text-muted">Eligible</dt><dd className="num font-semibold text-profit">{totals.accepted}</dd></div>
            <div><dt className="text-micro text-muted">Rejected</dt><dd className={cx("num font-semibold", totals.rejected ? "text-loss" : "text-text")}>{totals.rejected}</dd></div>
            <div><dt className="text-micro text-muted">Total lots</dt><dd className="num font-semibold text-text">{totals.lots}</dd></div>
            <div className="text-right"><dt className="text-micro text-muted">Est. value</dt><dd className="num font-semibold text-text">{inr(totals.valuePaise)}</dd></div>
          </dl>
          <p className="text-micro text-muted">Estimated charges {inr(totals.chargesPaise)}. Final checks run on the server right before each account fills.</p>
          {form.submitError ? <Notice tone="loss">{form.submitError}</Notice> : null}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={form.closeReview} disabled={form.submitting}>Cancel</Button>
            <Button className="flex-1" variant={review.intent.side === "BUY" ? "buy" : "sell"} loading={form.submitting} disabled={totals.accepted === 0} onClick={() => void form.confirm()}>
              {form.submitError ? "Retry same request" : totals.accepted === 0 ? "No eligible accounts" : confirmLabel}
            </Button>
          </div>
        </div>
      ) : null}
    >
      {review ? (
        <div className="flex flex-col gap-3.5 text-dense">
          <div className="flex items-center gap-2 rounded-input border border-demo/30 bg-demo-soft px-3 py-2 text-data font-semibold text-demo">
            <FlaskConical className="h-4 w-4" aria-hidden />DEMO · SIMULATED — never sent to a broker
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={review.intent.side === "BUY" ? "profit" : "loss"}>{review.intent.side}</Badge>
            <Badge>{review.intent.orderType === "LIMIT" ? `Limit ${inr(review.intent.limitPaise)}` : "Market"}</Badge>
            <Badge>{review.product === "INTRADAY" ? "Intraday" : "Carry"}</Badge>
            {review.stopLossPaise ? <Badge>SL {inr(review.stopLossPaise)}</Badge> : null}
            {review.targetPaise ? <Badge>Target {inr(review.targetPaise)}</Badge> : null}
          </div>
          <dl className="grid grid-cols-3 gap-2 rounded-input border border-border-soft bg-sunken px-3 py-2 text-data">
            <div><dt className="text-micro text-muted">Premium</dt><dd className="num font-semibold text-text">{inr(review.quote.premiumPaise)}</dd></div>
            <div><dt className="text-micro text-muted">Lot size</dt><dd className="num font-semibold text-text">{review.quote.lotSize}</dd></div>
            <div className="min-w-0"><dt className="text-micro text-muted">Source</dt><dd className="truncate text-text-2" title={review.quote.label}>{review.quote.label}</dd></div>
          </dl>

          <section aria-label="Accepted accounts">
            <h3 className="mb-1.5 flex items-center gap-2 text-data font-semibold text-text">Will be placed <span className="num rounded-sm bg-profit-soft px-1.5 text-profit">{accepted.length}</span></h3>
            {accepted.length ? (
              <table className="w-full text-data">
                <thead><tr className="text-micro text-muted"><th scope="col" className="py-1 text-left font-medium">Account</th><th scope="col" className="text-right font-medium">Lots</th><th scope="col" className="text-right font-medium">Qty</th><th scope="col" className="text-right font-medium">Est. value</th></tr></thead>
                <tbody>
                  {accepted.map((plan) => (
                    <tr key={plan.account.id} className="border-t border-border-soft">
                      <td className="py-1.5 text-text">{plan.account.nickname}</td>
                      <td className="num py-1.5 text-right">{plan.lots}</td>
                      <td className="num py-1.5 text-right">{plan.quantity}</td>
                      <td className="num py-1.5 text-right">{inr(form.legValue(plan.quantity))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-data text-muted">No selected account passes its checks for this order.</p>}
          </section>

          {rejected.length ? (
            <section aria-label="Rejected accounts">
              <h3 className="mb-1.5 flex items-center gap-2 text-data font-semibold text-text">Will be rejected <span className="num rounded-sm bg-loss-soft px-1.5 text-loss">{rejected.length}</span></h3>
              <ul className="flex flex-col gap-1">
                {rejected.map((plan) => (
                  <li key={plan.account.id} className="flex items-start gap-2 rounded-sm border border-loss/20 bg-loss-soft/40 px-2.5 py-1.5 text-data">
                    <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-loss" aria-hidden />
                    <span className="min-w-0"><span className="font-medium text-text">{plan.account.nickname}</span> <span className="num text-muted">· {plan.lots} {plan.lots === 1 ? "lot" : "lots"}</span><span className="block text-loss">{plan.reject}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="flex items-start gap-1.5 text-micro text-muted"><ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />Preview only. Limit orders that cannot fill at the current premium stay pending.</p>
        </div>
      ) : null}
    </Drawer>
  );
}

export function OrderResultPanel({ request, onDismiss }: { request: OrderRequest; onDismiss: () => void }) {
  const filled = request.legs.filter((leg) => leg.status === "FILLED").length;
  return (
    <section className="anim-rise surface overflow-hidden" aria-live="polite" aria-label="Latest order result">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-soft px-4 py-2.5">
        <OverallChip status={request.status} size="md" />
        <p className="min-w-0 flex-1 text-dense font-semibold text-text">
          {request.side === "BUY" ? "Buy" : "Sell"} {contractLabel(request.contract)} <span className="font-normal text-muted">· {filled} of {request.legs.length} filled</span>
        </p>
        <span className="num text-micro text-muted">#{request.id.slice(0, 8).toUpperCase()} · {istStamp(request.createdAt)}</span>
        <button type="button" onClick={onDismiss} aria-label="Dismiss result" className="grid h-7 w-7 place-items-center rounded-sm text-muted hover:bg-hover hover:text-text"><X className="h-4 w-4" aria-hidden /></button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[38.75rem] text-data" aria-label="Per-account results">
          <thead><tr className="text-micro text-muted"><th scope="col" className="px-4 py-1.5 text-left font-medium">Account</th><th scope="col" className="text-left font-medium">Status</th><th scope="col" className="text-right font-medium">Filled</th><th scope="col" className="text-right font-medium">Price</th><th scope="col" className="px-3 text-left font-medium">Reason</th><th scope="col" className="pr-4 text-right font-medium">Reference</th></tr></thead>
          <tbody>
            {request.legs.map((leg) => (
              <tr key={leg.id} className="border-t border-border-soft align-top">
                <td className="px-4 py-1.5 font-medium text-text">{leg.nickname}</td>
                <td className="py-1.5"><LegChip status={leg.status} /></td>
                <td className="num py-1.5 text-right">{leg.filledQuantity}/{leg.quantity}</td>
                <td className={cx("num py-1.5 text-right", leg.avgPaise == null && "text-muted")}>{leg.avgPaise == null ? "Unavailable" : inr(leg.avgPaise)}</td>
                <td className="max-w-[17.5rem] px-3 py-1.5 text-muted">{leg.reason}</td>
                <td className="num py-1.5 pr-4 text-right text-muted">{leg.ref}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border-soft px-4 py-1.5 text-micro text-muted">Dismissing hides this panel only. The request stays in the Orders tab.</p>
    </section>
  );
}
