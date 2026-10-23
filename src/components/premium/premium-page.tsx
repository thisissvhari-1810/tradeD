"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { BarChart3, Check, ChevronDown, Crown, LayoutGrid, LineChart, ShieldCheck, Sparkles } from "lucide-react";
import { cx } from "@/components/ui";
import { usePremium } from "@/components/premium/use-premium";
import { PREMIUM_CAPABILITIES, type PremiumCapability } from "@/lib/premium/entitlements";
import { DEFAULT_PLAN, PREMIUM_PLANS, perMonthPaise, planById, rupees, savings, type PremiumPlanId, type PremiumPlanInfo } from "@/lib/premium/plans";

/** Online payment is not connected yet: the page shows the plans, and purchase says so plainly. */
const PAYMENTS_ENABLED = false;

const istDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

function ctaLabel(plan: PremiumPlanInfo) {
  return plan.id === "YEARLY" ? `Get ${plan.label} — ${rupees(plan.pricePaise)}` : `Continue with ${plan.label} — ${rupees(plan.pricePaise)}`;
}

export function PremiumPage() {
  const params = useSearchParams();
  const asked = params.get("feature");
  const feature = asked && asked in PREMIUM_CAPABILITIES ? PREMIUM_CAPABILITIES[asked as PremiumCapability] : null;
  const { premium } = usePremium();
  const [selected, setSelected] = useState<PremiumPlanId>(DEFAULT_PLAN);
  const plan = planById(selected) ?? PREMIUM_PLANS[0];
  const active = premium.status === "active";

  return (
    <div className="h-full overflow-y-auto bg-premium text-premium-text">
      <div className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,color-mix(in_srgb,var(--gold-strong)_16%,transparent),transparent)]" />
        <div className="relative mx-auto flex max-w-5xl flex-col gap-8 px-4 pb-[calc(8.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 lg:gap-10 lg:pb-12 lg:pt-10">
          <header className="flex flex-col items-center text-center">
            <span className="grid h-14 w-14 place-items-center rounded-card border border-premium-border bg-premium-raised text-gold-strong shadow-[0_0_2.5rem_color-mix(in_srgb,var(--gold-strong)_22%,transparent)]">
              <Crown className="h-7 w-7" strokeWidth={1.8} aria-hidden />
            </span>
            <p className="mt-4 text-micro font-semibold uppercase tracking-[0.18em] text-gold-strong">TradeD Premium</p>
            <h1 className="mt-2 text-[clamp(1.5rem,4.5vw,2.25rem)] font-semibold leading-tight tracking-[-0.02em]">Upgrade your trading experience</h1>
            <p className="mt-2 max-w-xl text-dense text-premium-muted">The Strategy overlay on every chart and the Prediction screen, on top of everything TradeD already gives you.</p>
            <p className="mt-1 text-data text-gold-strong/90">More tools. Better insights. Your learning, upgraded.</p>
            {feature && !active ? <p className="mt-4 rounded-pill border border-premium-border bg-premium-raised px-3 py-1.5 text-data">{feature.label} is part of Premium.</p> : null}
          </header>

          <StatusCard status={premium.status} plan={premium.plan} endsAt={premium.endsAt} via={premium.via} />

          <section aria-labelledby="td-plans" className="flex flex-col gap-4">
            <h2 id="td-plans" className="sr-only">Choose a plan</h2>
            <div role="radiogroup" aria-label="Premium plans" className="grid gap-3 md:grid-cols-3">
              {PREMIUM_PLANS.map((item) => <PlanCard key={item.id} plan={item} selected={item.id === selected} onSelect={() => setSelected(item.id)} />)}
            </div>
            {/* Laptop and desktop: the call to action sits under the plans. */}
            <div className="hidden flex-col items-center gap-2 lg:flex">
              <PurchaseButton plan={plan} className="w-full max-w-sm" />
              <BillingNote />
            </div>
          </section>

          <Benefits />
          <Faq />
        </div>
      </div>

      {/* Phones and tablets: the selected plan stays in reach while reading. */}
      <div className="sticky bottom-0 z-10 border-t border-premium-border bg-premium/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-xl flex-col items-center gap-1.5">
          <PurchaseButton plan={plan} className="w-full" />
          <BillingNote />
        </div>
      </div>
    </div>
  );
}

function StatusCard({ status, plan, endsAt, via }: { status: "free" | "active" | "expired"; plan: PremiumPlanId | null; endsAt: string | null; via: "subscription" | "role" | null }) {
  if (status === "free") return null;
  const label = plan ? planById(plan)?.label : null;
  return (
    <div className={cx("mx-auto flex w-full max-w-xl items-center gap-3 rounded-card border px-4 py-3", status === "active" ? "border-gold/50 bg-premium-raised" : "border-premium-border bg-premium-raised")} role="status">
      <ShieldCheck className={cx("h-5 w-5 shrink-0", status === "active" ? "text-gold-strong" : "text-premium-muted")} aria-hidden />
      <p className="text-dense">
        {status === "active"
          ? via === "role" ? "Premium is included with your Super Admin account." : `Premium is active${label ? ` (${label})` : ""}${endsAt ? ` until ${istDate(endsAt)}` : ""}.`
          : `Your Premium ended${endsAt ? ` on ${istDate(endsAt)}` : ""}. Renew to use the Premium features again.`}
      </p>
    </div>
  );
}

function PlanCard({ plan, selected, onSelect }: { plan: PremiumPlanInfo; selected: boolean; onSelect: () => void }) {
  const saved = savings(plan);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cx(
        "relative flex min-h-[7.5rem] flex-col rounded-card border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gold-strong)] motion-reduce:transition-none",
        selected ? "border-gold-strong bg-premium-raised shadow-[0_0_0_1px_var(--gold-strong),0_0.75rem_2rem_color-mix(in_srgb,var(--gold-strong)_12%,transparent)]" : "border-premium-border bg-premium-raised/60 hover:border-gold/60",
      )}
    >
      {plan.popular ? <span className="absolute -top-2.5 left-4 rounded-pill bg-gold-strong px-2.5 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide text-on-gold">Most popular</span> : null}
      <span className="flex items-center justify-between gap-3">
        <span className="text-title font-semibold">{plan.label}</span>
        <span aria-hidden className={cx("grid h-5 w-5 place-items-center rounded-full border-2", selected ? "border-gold-strong bg-gold-strong text-on-gold" : "border-premium-muted/60")}>
          {selected ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
        </span>
      </span>
      <span className="mt-2 flex items-baseline gap-1.5">
        <span className="num text-[1.75rem] font-semibold leading-none tracking-[-0.02em]">{rupees(plan.pricePaise)}</span>
        <span className="text-data text-premium-muted">for {plan.months === 1 ? "1 month" : `${plan.months} months`}</span>
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-3 text-data text-premium-muted">
        {plan.months > 1 ? <span className="num">{rupees(perMonthPaise(plan))}/month</span> : <span>Billed for one month</span>}
        {saved ? <span className="num rounded-sm bg-profit/15 px-1.5 py-0.5 text-micro font-semibold text-profit">Save {saved.percent}% ({rupees(saved.paise)})</span> : null}
      </span>
    </button>
  );
}

function PurchaseButton({ plan, className }: { plan: PremiumPlanInfo; className?: string }) {
  return (
    <button
      type="button"
      disabled={!PAYMENTS_ENABLED}
      aria-describedby="td-billing-note"
      className={cx("h-12 rounded-input bg-gold-strong px-5 text-dense font-semibold text-on-gold shadow-e2 transition hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gold-strong)] disabled:cursor-not-allowed disabled:opacity-60", className)}
      style={{ color: "var(--on-gold)" }}
    >
      {ctaLabel(plan)}
    </button>
  );
}

function BillingNote() {
  return (
    <p id="td-billing-note" className="text-center text-micro text-premium-muted">
      Online payment isn’t available yet, so nothing is charged. Your TradeD administrator can activate Premium for you.
    </p>
  );
}

const BENEFITS: Array<{ icon: ReactNode; title: string; body: string }> = [
  { icon: <LayoutGrid className="h-5 w-5" />, title: PREMIUM_CAPABILITIES.strategy.label, body: "Previous-day and 9:15 opening-range boxes and lines drawn on the chart automatically, with dates you choose." },
  { icon: <LineChart className="h-5 w-5" />, title: PREMIUM_CAPABILITIES.analytics.label, body: "The Prediction screen: forecasts and analytics for any stock or index, across timeframes." },
  { icon: <BarChart3 className="h-5 w-5" />, title: "Everything else stays included", body: "Charts, drawing tools, paper trading, historical replay, the option chain and your portfolio remain available on every account." },
];

function Benefits() {
  return (
    <section aria-labelledby="td-benefits" className="flex flex-col gap-4">
      <h2 id="td-benefits" className="flex items-center gap-2 text-title font-semibold"><Sparkles className="h-4 w-4 text-gold-strong" aria-hidden />What Premium includes</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {BENEFITS.map((item) => (
          <li key={item.title} className="flex gap-3 rounded-card border border-premium-border bg-premium-raised/60 p-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-input bg-gold/15 text-gold-strong" aria-hidden>{item.icon}</span>
            <span className="min-w-0">
              <span className="block text-dense font-semibold">{item.title}</span>
              <span className="mt-0.5 block text-data text-premium-muted">{item.body}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FAQS: Array<{ q: string; a: ReactNode }> = [
  { q: "What is included in TradeD Premium?", a: "The Strategy overlay on the chart and the Prediction (analytics) screen. Everything else in TradeD stays available without Premium." },
  { q: "Is Premium useful for beginners?", a: "Yes, if you practise opening-range setups: the Strategy overlay draws the previous-day and 9:15 levels for you, so you can focus on reading price action. Prediction is best treated as a study aid, not a trading signal." },
  { q: "Which plan should I choose?", a: "1 Year costs the least per month (₹83.25, 44% less than paying monthly). Monthly suits a short trial; 6 Months sits in between." },
  { q: "Is payment recurring?", a: "Online payment isn’t available yet, so nothing is charged and nothing renews. When payments are added, this page will state exactly how billing works before you pay." },
  { q: "How do I activate Premium?", a: "For now, your TradeD administrator activates it on your account. It takes effect immediately; refresh the page if a Premium feature still shows as locked." },
  { q: "What happens when Premium ends?", a: "The Strategy overlay and Prediction lock again. Your charts, drawings, paper trades and history are not affected." },
  { q: "How can I contact support?", a: "Contact your TradeD administrator, the Super Admin who manages your account." },
];

function Faq() {
  return (
    <section aria-labelledby="td-faq" className="flex flex-col gap-3">
      <h2 id="td-faq" className="text-title font-semibold">Frequently asked questions</h2>
      <div className="divide-y divide-premium-border rounded-card border border-premium-border bg-premium-raised/40">
        {FAQS.map((item) => <FaqItem key={item.q} question={item.q} answer={item.a} />)}
      </div>
      <p className="text-data text-premium-muted">Still have a question? <Link href="/" className="font-medium text-gold-strong underline-offset-2 hover:underline">Back to TradeD</Link> and ask your administrator.</p>
    </section>
  );
}

function FaqItem({ question, answer }: { question: string; answer: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <h3>
        <button type="button" aria-expanded={open} aria-controls={id} className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left text-dense font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--gold-strong)]" onClick={() => setOpen((value) => !value)}>
          {question}
          <ChevronDown className={cx("h-4 w-4 shrink-0 text-premium-muted transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
        </button>
      </h3>
      <div id={id} hidden={!open} className="px-4 pb-4 text-data text-premium-muted">{answer}</div>
    </div>
  );
}
