"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, Check, ChevronDown, Crown, GitBranch, History, LayoutGrid, LineChart, Minus, ShieldCheck, Sparkles, X } from "lucide-react";
import { cx } from "@/components/ui";
import { premiumOrigin } from "@/components/premium/premium-upgrade-button";
import { usePremium } from "@/components/premium/use-premium";
import { COMPARE_ROWS } from "@/lib/premium/compare";
import { PREMIUM_CAPABILITIES, type Premium, type PremiumCapability } from "@/lib/premium/entitlements";
import { DEFAULT_PLAN, PREMIUM_PLANS, perMonthPaise, planById, rupees, savings, type PremiumPlanId, type PremiumPlanInfo } from "@/lib/premium/plans";

/** Online payment is not connected yet: the page shows the plans, and purchase says so plainly. */
const PAYMENTS_ENABLED = false;

const istDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

/** The plan with the lowest price per month earns "Best value" (computed, not asserted). */
const BEST_VALUE = [...PREMIUM_PLANS].sort((a, b) => perMonthPaise(a) - perMonthPaise(b))[0].id;

const PLAN_NOTE: Record<PremiumPlanId, string> = {
  MONTHLY: "Try Premium for a month.",
  HALF_YEARLY: "A full half-year of practice.",
  YEARLY: "The lowest price per month.",
};

function ctaLabel(plan: PremiumPlanInfo) {
  return plan.id === "YEARLY" ? `Get ${plan.label} — ${rupees(plan.pricePaise)}` : `Continue with ${plan.label} — ${rupees(plan.pricePaise)}`;
}

function scrollToId(id: string) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

export function PremiumPage() {
  const params = useSearchParams();
  const router = useRouter();
  const asked = params.get("feature");
  const feature = asked && asked in PREMIUM_CAPABILITIES ? PREMIUM_CAPABILITIES[asked as PremiumCapability] : null;
  const { premium } = usePremium();
  const [selected, setSelected] = useState<PremiumPlanId>(DEFAULT_PLAN);
  const plan = planById(selected) ?? PREMIUM_PLANS[0];
  const active = premium.status === "active";

  return (
    <div className="h-full overflow-y-auto scroll-smooth bg-premium text-premium-text motion-reduce:scroll-auto">
      <div className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(55%_100%_at_50%_0%,color-mix(in_srgb,var(--gold-strong)_15%,transparent),transparent)]" />
        <div className="relative mx-auto flex max-w-6xl flex-col gap-12 px-4 pb-[calc(9rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:gap-16 lg:pb-16 lg:pt-8">
          <div className="flex justify-end">
            <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-premium-border px-3 text-data text-premium-muted hover:border-gold/60 hover:text-premium-text" onClick={() => router.push(premiumOrigin())}>
              <X className="h-4 w-4" aria-hidden />Close
            </button>
          </div>

          <Hero feature={feature?.label ?? null} active={active} />
          <MembershipStatus premium={premium} />
          <Showcase />

          <section id="td-plans" aria-labelledby="td-plans-title" className="anim-rise flex scroll-mt-4 flex-col gap-5">
            <SectionTitle id="td-plans-title" eyebrow="Plans" title={active ? "Extend or change your plan" : "Choose your plan"} sub="One payment for the whole period. Prices include everything listed; no hidden extras." />
            <div role="radiogroup" aria-label="Premium plans" className="grid gap-3 md:grid-cols-3 md:gap-4">
              {PREMIUM_PLANS.map((item) => <PlanCard key={item.id} plan={item} best={item.id === BEST_VALUE} selected={item.id === selected} onSelect={() => setSelected(item.id)} />)}
            </div>
            <div className="hidden flex-col items-center gap-2 lg:flex">
              <PurchaseButton plan={plan} className="w-full max-w-sm" />
              <BillingNote />
            </div>
          </section>

          <Comparison />
          <Benefits />
          <Faq />

          <section className="hidden flex-col items-center gap-3 rounded-sheet border border-premium-border bg-premium-raised/60 px-6 py-10 text-center lg:flex" aria-label="Get Premium">
            <Crown className="h-7 w-7 text-gold-strong" aria-hidden />
            <p className="text-section font-semibold">Ready when you are</p>
            <p className="max-w-lg text-dense text-premium-muted">{plan.label} selected · {rupees(plan.pricePaise)} for {plan.months === 1 ? "1 month" : `${plan.months} months`}.</p>
            <PurchaseButton plan={plan} className="w-full max-w-sm" />
            <BillingNote />
          </section>
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

function SectionTitle({ id, eyebrow, title, sub }: { id: string; eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1.5 text-center">
      <p className="text-micro font-semibold uppercase tracking-[0.18em] text-gold-strong">{eyebrow}</p>
      <h2 id={id} className="text-[clamp(1.25rem,3vw,1.75rem)] font-semibold tracking-[-0.02em]">{title}</h2>
      {sub ? <p className="mx-auto max-w-xl text-dense text-premium-muted">{sub}</p> : null}
    </div>
  );
}

function Hero({ feature, active }: { feature: string | null; active: boolean }) {
  return (
    <header className="anim-rise flex flex-col items-center text-center">
      <span className="inline-flex items-center gap-1.5 rounded-pill border border-premium-border bg-premium-raised px-3 py-1 text-micro font-semibold uppercase tracking-[0.16em] text-gold-strong">
        <Crown className="h-3.5 w-3.5" aria-hidden />TradeD Premium
      </span>
      <h1 className="mt-5 max-w-3xl text-[clamp(1.75rem,5.5vw,3.25rem)] font-semibold leading-[1.08] tracking-[-0.03em]">
        Trade smarter. Learn deeper. <span className="bg-gradient-to-r from-gold-strong to-gold bg-clip-text text-transparent">Unlock more.</span>
      </h1>
      <p className="mt-4 max-w-xl text-dense text-premium-muted sm:text-body">Unlock the tools, insights and practice features available with TradeD Premium: the automatic Strategy overlay on your charts and the Prediction screen.</p>
      {feature && !active ? <p className="mt-4 rounded-pill border border-gold/40 bg-premium-raised px-3 py-1.5 text-data">{feature} is part of Premium.</p> : null}
      <div className="mt-6 flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <button type="button" className="inline-flex h-12 items-center justify-center gap-2 rounded-input bg-gold-strong px-6 text-dense font-semibold shadow-e2 transition hover:brightness-105 active:scale-[0.98] motion-reduce:active:scale-100" style={{ color: "var(--on-gold)" }} onClick={() => scrollToId("td-plans")}>
          Explore Premium plans<ArrowDown className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className="inline-flex h-12 items-center justify-center gap-2 rounded-input border border-premium-border px-6 text-dense font-medium text-premium-text transition-colors hover:border-gold/60 hover:bg-premium-raised" onClick={() => scrollToId("td-benefits")}>
          See what’s included
        </button>
      </div>
      <p className="mt-4 text-micro text-premium-muted">Premium adds tools for study and practice. It does not promise profits or better returns.</p>
    </header>
  );
}

function MembershipStatus({ premium }: { premium: Premium }) {
  const label = premium.plan ? planById(premium.plan)?.label : null;
  const tone = premium.status === "active" ? "border-gold/50" : "border-premium-border";
  return (
    <div className={cx("anim-rise mx-auto flex w-full max-w-2xl flex-wrap items-center gap-x-3 gap-y-1 rounded-card border bg-premium-raised px-4 py-3", tone)} role="status">
      <ShieldCheck className={cx("h-5 w-5 shrink-0", premium.status === "active" ? "text-gold-strong" : "text-premium-muted")} aria-hidden />
      <span className={cx("rounded-pill px-2 py-0.5 text-micro font-semibold", premium.status === "active" ? "bg-gold-strong text-on-gold" : "bg-premium text-premium-muted")}>
        {premium.status === "active" ? "Premium active" : premium.status === "expired" ? "Premium ended" : "Free plan"}
      </span>
      <span className="min-w-0 flex-1 text-data text-premium-muted">
        {premium.status === "active"
          ? premium.via === "role" ? "Included with your Super Admin account." : `${label ?? "Premium"}${premium.endsAt ? ` · valid until ${istDate(premium.endsAt)}` : ""}.`
          : premium.status === "expired" ? `Ended${premium.endsAt ? ` on ${istDate(premium.endsAt)}` : ""}. Choose a plan to use Premium again.` : "Everything you use today stays free. Premium adds the tools below."}
      </span>
    </div>
  );
}

/* ---------- feature showcase (real features only; previews are decorative drawings) ---------- */

const CANDLES = [[14, 30, 22, 26], [26, 34, 20, 30], [30, 38, 28, 36], [36, 40, 30, 32], [32, 36, 24, 26], [26, 30, 18, 22], [22, 32, 20, 30], [30, 42, 28, 40], [40, 46, 36, 44], [44, 48, 38, 40]];

function MiniCandles({ x0 = 10, step = 14, flip = 60 }: { x0?: number; step?: number; flip?: number }) {
  return (
    <>
      {CANDLES.map(([open, high, low, close], index) => {
        const x = x0 + index * step;
        const up = close >= open;
        const y = (value: number) => flip - value;
        return (
          <g key={index} style={{ color: up ? "var(--profit)" : "var(--loss)" }}>
            <line x1={x} x2={x} y1={y(high)} y2={y(low)} stroke="currentColor" strokeWidth="1" />
            <rect x={x - 3.5} width="7" y={y(Math.max(open, close))} height={Math.max(1.5, Math.abs(close - open))} fill="currentColor" rx="1" />
          </g>
        );
      })}
    </>
  );
}

const PREVIEWS: Record<string, ReactNode> = {
  strategy: (
    <svg viewBox="0 0 160 64" className="h-full w-full" aria-hidden>
      <rect x="6" y="14" width="66" height="22" rx="2" fill="color-mix(in srgb, var(--demo) 22%, transparent)" stroke="var(--demo)" strokeWidth="0.8" />
      <rect x="78" y="8" width="74" height="22" rx="2" fill="color-mix(in srgb, var(--warning) 20%, transparent)" stroke="var(--warning)" strokeWidth="0.8" />
      <line x1="78" x2="156" y1="40" y2="40" stroke="var(--profit)" strokeWidth="1.2" />
      <line x1="78" x2="156" y1="50" y2="50" stroke="var(--profit)" strokeWidth="1.2" />
      <MiniCandles x0={14} step={14.5} flip={62} />
    </svg>
  ),
  analytics: (
    <svg viewBox="0 0 160 64" className="h-full w-full" aria-hidden>
      <polygon points="96,30 156,10 156,52" fill="color-mix(in srgb, var(--gold-strong) 16%, transparent)" />
      <polyline points="6,48 22,44 36,46 50,36 64,38 80,28 96,30" fill="none" stroke="var(--premium-text)" strokeWidth="1.6" strokeLinejoin="round" />
      <polyline points="96,30 116,26 136,24 156,20" fill="none" stroke="var(--gold-strong)" strokeWidth="1.6" strokeDasharray="4 3" />
      <line x1="96" x2="96" y1="6" y2="58" stroke="var(--premium-border)" strokeDasharray="2 2" />
    </svg>
  ),
  charting: (
    <svg viewBox="0 0 160 64" className="h-full w-full" aria-hidden>
      <MiniCandles x0={12} step={14} flip={60} />
      <line x1="12" x2="150" y1="44" y2="12" stroke="var(--loss)" strokeWidth="1.2" />
      <circle cx="12" cy="44" r="2.2" fill="var(--premium-surface)" stroke="var(--loss)" />
      <circle cx="150" cy="12" r="2.2" fill="var(--premium-surface)" stroke="var(--loss)" />
    </svg>
  ),
  replay: (
    <svg viewBox="0 0 160 64" className="h-full w-full" aria-hidden>
      <MiniCandles x0={12} step={9} flip={46} />
      <rect x="8" y="52" width="144" height="4" rx="2" fill="var(--premium-border)" />
      <rect x="8" y="52" width="86" height="4" rx="2" fill="var(--demo)" />
      <circle cx="94" cy="54" r="4" fill="var(--demo)" />
      <polygon points="120,10 120,26 133,18" fill="var(--premium-text)" opacity="0.7" />
    </svg>
  ),
  options: (
    <svg viewBox="0 0 160 64" className="h-full w-full" aria-hidden>
      {[0, 1, 2, 3].map((row) => (
        <g key={row}>
          <rect x="6" y={6 + row * 14} width={20 + row * 10} height="9" rx="1.5" fill="color-mix(in srgb, var(--loss) 30%, transparent)" />
          <rect x="66" y={5 + row * 14} width="28" height="11" rx="1.5" fill={row === 2 ? "color-mix(in srgb, var(--warning) 30%, transparent)" : "var(--premium-border)"} />
          <rect x={154 - (54 - row * 10)} y={6 + row * 14} width={54 - row * 10} height="9" rx="1.5" fill="color-mix(in srgb, var(--profit) 30%, transparent)" />
        </g>
      ))}
    </svg>
  ),
};

const SHOWCASE: Array<{ key: string; icon: ReactNode; title: string; body: string; premium: boolean }> = [
  { key: "strategy", icon: <LayoutGrid className="h-4 w-4" />, title: PREMIUM_CAPABILITIES.strategy.label, body: "Previous-day and 9:15 opening-range boxes and lines, drawn for you on every chart.", premium: true },
  { key: "analytics", icon: <LineChart className="h-4 w-4" />, title: PREMIUM_CAPABILITIES.analytics.label, body: "Forecast ranges and analytics for any stock or index, to study possible paths.", premium: true },
  { key: "charting", icon: <Sparkles className="h-4 w-4" />, title: "Advanced charting", body: "Timeframes from 1 minute to 5 years, indicators and 50+ drawing tools.", premium: false },
  { key: "replay", icon: <History className="h-4 w-4" />, title: "Historical replay", body: "Replay a past session minute by minute and practise trading it.", premium: false },
  { key: "options", icon: <GitBranch className="h-4 w-4" />, title: "Option chain", body: "Calls and puts side by side by strike and expiry, with paper orders.", premium: false },
];

function Showcase() {
  return (
    <section aria-labelledby="td-showcase" className="anim-rise flex flex-col gap-5">
      <SectionTitle id="td-showcase" eyebrow="Inside TradeD" title="Tools built for practice" sub="Premium adds the first two. The rest stay included on every account." />
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SHOWCASE.map((item, index) => (
          <li key={item.key} className={cx("group flex flex-col overflow-hidden rounded-card border bg-premium-raised/70 transition duration-200 motion-reduce:transition-none lg:hover:-translate-y-0.5 lg:hover:shadow-e3", item.premium ? "border-gold/45" : "border-premium-border", index < 2 && "lg:col-span-1")}>
            <div className="h-24 border-b border-premium-border bg-premium px-3 py-2">{PREVIEWS[item.key]}</div>
            <div className="flex flex-1 flex-col gap-1.5 p-4">
              <span className="flex items-center gap-2">
                <span className={cx("grid h-7 w-7 place-items-center rounded-input", item.premium ? "bg-gold/15 text-gold-strong" : "bg-premium text-premium-muted")} aria-hidden>{item.icon}</span>
                <span className="text-dense font-semibold">{item.title}</span>
                <span className={cx("ml-auto rounded-pill px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide", item.premium ? "bg-gold-strong text-on-gold" : "border border-premium-border text-premium-muted")}>{item.premium ? "Premium" : "Included free"}</span>
              </span>
              <span className="text-data text-premium-muted">{item.body}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- plans ---------- */

function PlanCard({ plan, best, selected, onSelect }: { plan: PremiumPlanInfo; best: boolean; selected: boolean; onSelect: () => void }) {
  const saved = savings(plan);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cx(
        "relative flex min-h-[9rem] flex-col rounded-card border p-4 text-left text-premium-text transition-[border-color,box-shadow,background-color,transform] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gold-strong)] active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 sm:p-5",
        best && "bg-[linear-gradient(160deg,color-mix(in_srgb,var(--gold-strong)_10%,var(--premium-raised)),var(--premium-raised))]",
        selected ? "border-gold-strong shadow-[0_0_0_1px_var(--gold-strong),0_0.75rem_2rem_color-mix(in_srgb,var(--gold-strong)_12%,transparent)]" : cx("hover:border-gold/60", best ? "border-gold/50" : "border-premium-border bg-premium-raised/60"),
        !best && selected && "bg-premium-raised",
      )}
    >
      {best ? <span className="absolute -top-2.5 left-4 inline-flex items-center gap-1 rounded-pill bg-gold-strong px-2.5 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide text-on-gold"><Crown className="h-3 w-3" aria-hidden />Best value</span> : null}
      <span className="flex items-center justify-between gap-3">
        <span className="text-title font-semibold">{plan.label}</span>
        <span aria-hidden className={cx("grid h-5 w-5 place-items-center rounded-full border-2 transition-colors motion-reduce:transition-none", selected ? "border-gold-strong bg-gold-strong text-on-gold" : "border-premium-muted/60")}>
          {selected ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
        </span>
      </span>
      <span className="mt-2 flex items-baseline gap-1.5">
        <span className="num text-[1.875rem] font-semibold leading-none tracking-[-0.02em]">{rupees(plan.pricePaise)}</span>
        <span className="text-data text-premium-muted">for {plan.months === 1 ? "1 month" : `${plan.months} months`}</span>
      </span>
      <span className="mt-1 text-data text-premium-muted">{PLAN_NOTE[plan.id]}</span>
      <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-3 text-data text-premium-muted">
        <span className="num">{plan.months > 1 ? `${rupees(perMonthPaise(plan))}/month` : `${rupees(plan.pricePaise)}/month`}</span>
        {saved ? <span className="num rounded-sm bg-profit/15 px-1.5 py-0.5 text-micro font-semibold text-profit">Save {saved.percent}% vs monthly ({rupees(saved.paise)})</span> : null}
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
      className={cx("h-12 rounded-input bg-gold-strong px-5 text-dense font-semibold shadow-e2 transition hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gold-strong)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 motion-reduce:transition-none", className)}
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

/* ---------- comparison, benefits, FAQ ---------- */

function Comparison() {
  return (
    <section aria-labelledby="td-compare" className="anim-rise flex flex-col gap-5">
      <SectionTitle id="td-compare" eyebrow="Free vs Premium" title="What you get" />
      {/* Divs with table roles: the app's global th / td styles (uppercase, light borders) do not apply here. */}
      <div role="table" aria-labelledby="td-compare" className="overflow-hidden rounded-card border border-premium-border text-data">
        <div role="row" className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] bg-premium-raised text-micro font-semibold uppercase tracking-wide text-premium-muted sm:grid-cols-[minmax(0,1fr)_7rem_7rem]">
          <span role="columnheader" className="px-4 py-3">Feature</span>
          <span role="columnheader" className="px-2 py-3 text-center">Free</span>
          <span role="columnheader" className="px-2 py-3 text-center text-gold-strong">Premium</span>
        </div>
        {COMPARE_ROWS.map((row) => (
          <div key={row.feature} role="row" className={cx("grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center border-t border-premium-border sm:grid-cols-[minmax(0,1fr)_7rem_7rem]", row.capability && "bg-gold/[0.05]")}>
            <span role="rowheader" className="min-w-0 px-4 py-3">
              <span className="flex items-center gap-1.5 text-dense font-medium text-premium-text">{row.capability ? <Crown className="h-3.5 w-3.5 shrink-0 text-gold-strong" aria-hidden /> : null}{row.feature}</span>
              <span className="block text-micro text-premium-muted">{row.detail}</span>
            </span>
            <span role="cell" className="px-2 py-3 text-center">{row.free ? <Check className="mx-auto h-4 w-4 text-profit" aria-label="Included" /> : <span className="text-micro text-premium-muted"><Minus className="mx-auto h-4 w-4" aria-hidden /><span className="sr-only">Not included</span></span>}</span>
            <span role="cell" className="px-2 py-3 text-center"><Check className="mx-auto h-4 w-4 text-gold-strong" aria-label="Included" /></span>
          </div>
        ))}
      </div>
      <p className="text-center text-micro text-premium-muted">Free features follow the permissions your administrator sets for your account.</p>
    </section>
  );
}

const BENEFITS: Array<{ icon: ReactNode; title: string; body: string; href: string; action: string }> = [
  { icon: <LayoutGrid className="h-5 w-5" />, title: "Opening-range levels, automatically", body: "Strategy draws the previous-day box and the 9:15 high and low the moment you open a chart, so you study the setup instead of drawing it.", href: "/chart", action: "Open a chart" },
  { icon: <LineChart className="h-5 w-5" />, title: "Forecasts to study, not signals", body: "Prediction shows possible price ranges across timeframes, so you can compare them with what actually happened.", href: "/prediction", action: "Open Prediction" },
  { icon: <ShieldCheck className="h-5 w-5" />, title: "Nothing you have today is taken away", body: "Charts, drawings, paper trading, replay, the option chain and your history stay available, Premium or not.", href: "/", action: "Back to Home" },
];

function Benefits() {
  return (
    <section id="td-benefits" aria-labelledby="td-benefits-title" className="anim-rise flex scroll-mt-4 flex-col gap-5">
      <SectionTitle id="td-benefits-title" eyebrow="Why Premium" title="What Premium includes" />
      <ul className="grid gap-3 md:grid-cols-3">
        {BENEFITS.map((item) => (
          <li key={item.title} className="flex flex-col gap-2 rounded-card border border-premium-border bg-premium-raised/60 p-5 transition-colors hover:border-gold/50 motion-reduce:transition-none">
            <span className="grid h-10 w-10 place-items-center rounded-input bg-gold/15 text-gold-strong" aria-hidden>{item.icon}</span>
            <span className="text-dense font-semibold">{item.title}</span>
            <span className="flex-1 text-data text-premium-muted">{item.body}</span>
            <Link href={item.href} className="mt-1 inline-flex items-center gap-1 self-start text-data font-medium text-gold-strong underline-offset-2 hover:underline">{item.action}<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FAQS: Array<{ q: string; a: ReactNode }> = [
  { q: "What is included in Premium?", a: "The Strategy overlay on the chart and the Prediction (analytics) screen. Everything else in TradeD stays available without Premium." },
  { q: "Is Premium useful for beginners?", a: "Yes, if you practise opening-range setups: the Strategy overlay draws the previous-day and 9:15 levels for you. Treat Prediction as a study aid, not a trading signal." },
  { q: "Which plan is the best value?", a: "1 Year: ₹83.25 a month, 44% less than paying monthly for 12 months. Monthly suits a short trial; 6 Months sits in between." },
  { q: "How does activation work?", a: "Online payment isn’t available yet. For now your TradeD administrator activates Premium on your account; it takes effect at once (refresh the page if a feature still shows a crown)." },
  { q: "What if I paid but Premium isn’t active?", a: "TradeD does not take payments yet, so no payment can be made through this page. If you arranged payment with your administrator, ask them to activate your plan." },
  { q: "Can I restore my subscription?", a: "Premium belongs to your TradeD account, not to a device. Sign in with the same account on any phone or computer and it is there." },
  { q: "Is payment recurring?", a: "No payment is taken today, so nothing renews. When online payment is added, this page will say exactly how billing works before you pay." },
  { q: "How do I contact support?", a: "Contact your TradeD administrator, the Super Admin who manages your account." },
];

function Faq() {
  return (
    <section aria-labelledby="td-faq" className="anim-rise flex flex-col gap-5">
      <SectionTitle id="td-faq" eyebrow="FAQ" title="Frequently asked questions" />
      <div className="mx-auto w-full max-w-3xl divide-y divide-premium-border rounded-card border border-premium-border bg-premium-raised/40">
        {FAQS.map((item) => <FaqItem key={item.q} question={item.q} answer={item.a} />)}
      </div>
    </section>
  );
}

function FaqItem({ question, answer }: { question: string; answer: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <h3>
        <button type="button" aria-expanded={open} aria-controls={id} className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left text-dense font-medium text-premium-text focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--gold-strong)]" onClick={() => setOpen((value) => !value)}>
          {question}
          <ChevronDown className={cx("h-4 w-4 shrink-0 text-premium-muted transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180 text-gold-strong")} aria-hidden />
        </button>
      </h3>
      <div id={id} role="region" aria-hidden={!open} className={cx("grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <p className="px-4 pb-4 text-data text-premium-muted">{answer}</p>
        </div>
      </div>
    </div>
  );
}
