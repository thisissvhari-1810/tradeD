/**
 * TradeD Premium plans. This is the one price list: the Premium page shows it, and a payment
 * integration must charge from it on the server (never from a price sent by the browser).
 */
export type PremiumPlanId = "MONTHLY" | "HALF_YEARLY" | "YEARLY";

export type PremiumPlanInfo = {
  id: PremiumPlanId;
  label: string;
  /** Length of access in calendar months. */
  months: number;
  /** Total payable, in paise (₹1 = 100 paise). */
  pricePaise: number;
  popular?: boolean;
};

export const PREMIUM_PLANS: readonly PremiumPlanInfo[] = [
  { id: "MONTHLY", label: "Monthly", months: 1, pricePaise: 14_900 },
  { id: "HALF_YEARLY", label: "6 Months", months: 6, pricePaise: 79_900 },
  { id: "YEARLY", label: "1 Year", months: 12, pricePaise: 99_900, popular: true },
];

export const DEFAULT_PLAN: PremiumPlanId = "YEARLY";

export function planById(id: string): PremiumPlanInfo | null {
  return PREMIUM_PLANS.find((plan) => plan.id === id) ?? null;
}

/** ₹ with Indian grouping; whole rupees drop the decimals (₹999, ₹133.17). */
export function rupees(paise: number): string {
  const value = paise / 100;
  const whole = Number.isInteger(value);
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Effective price per month, in paise, rounded to the nearest paisa. */
export function perMonthPaise(plan: PremiumPlanInfo): number {
  return Math.round(plan.pricePaise / plan.months);
}

/** What the plan saves against paying monthly for the same months (null for the monthly plan). */
export function savings(plan: PremiumPlanInfo): { paise: number; percent: number } | null {
  const monthly = PREMIUM_PLANS.find((item) => item.id === "MONTHLY")!;
  if (plan.id === "MONTHLY") return null;
  const full = monthly.pricePaise * plan.months;
  const paise = full - plan.pricePaise;
  return paise > 0 ? { paise, percent: Math.round((paise / full) * 100) } : null;
}

/** The access window a plan grants from `start`: the same day `months` calendar months later. */
export function planEnd(plan: PremiumPlanInfo, start: Date): Date {
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + plan.months);
  return end;
}
