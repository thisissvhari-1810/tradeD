import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canUse, FREE, premiumFrom } from "@/lib/premium/entitlements";
import { PREMIUM_PLANS, perMonthPaise, planById, planEnd, rupees, savings } from "@/lib/premium/plans";
import { requirePremium } from "@/server/premium";
import type { SessionUser } from "@/server/auth";

const now = new Date("2026-10-23T10:00:00Z");
const day = 86_400_000;
const row = (plan: "MONTHLY" | "HALF_YEARLY" | "YEARLY", startOffsetDays: number, endOffsetDays: number, status: "ACTIVE" | "CANCELLED" = "ACTIVE") => ({
  plan, status, startsAt: new Date(now.getTime() + startOffsetDays * day), endsAt: new Date(now.getTime() + endOffsetDays * day),
});

describe("premium plans", () => {
  it("price the plans as requested, with accurate per-month figures and savings", () => {
    expect(PREMIUM_PLANS.map((plan) => [plan.id, rupees(plan.pricePaise)])).toEqual([["MONTHLY", "₹149"], ["HALF_YEARLY", "₹799"], ["YEARLY", "₹999"]]);
    expect(rupees(perMonthPaise(planById("HALF_YEARLY")!))).toBe("₹133.17");
    expect(rupees(perMonthPaise(planById("YEARLY")!))).toBe("₹83.25");
    expect(savings(planById("MONTHLY")!)).toBeNull();
    expect(savings(planById("HALF_YEARLY")!)).toEqual({ paise: 9_500, percent: 11 });
    expect(savings(planById("YEARLY")!)).toEqual({ paise: 78_900, percent: 44 });
    expect(PREMIUM_PLANS.filter((plan) => plan.popular).map((plan) => plan.id)).toEqual(["YEARLY"]);
  });

  it("grant calendar months of access", () => {
    expect(planEnd(planById("YEARLY")!, new Date("2026-10-23T10:00:00Z")).toISOString()).toBe("2027-10-23T10:00:00.000Z");
    expect(planEnd(planById("MONTHLY")!, new Date("2026-10-23T10:00:00Z")).toISOString()).toBe("2026-11-23T10:00:00.000Z");
  });
});

describe("premium entitlement (from the subscription record only)", () => {
  it("free with no rows; active inside the window; expired after it", () => {
    expect(premiumFrom("STUDENT", [], now)).toEqual(FREE);
    expect(premiumFrom("STUDENT", [row("YEARLY", -10, 355)], now)).toMatchObject({ status: "active", plan: "YEARLY", via: "subscription" });
    expect(premiumFrom("STUDENT", [row("MONTHLY", -40, -10)], now)).toMatchObject({ status: "expired", plan: "MONTHLY" });
  });

  it("a cancelled row or one that has not started yet grants nothing", () => {
    expect(premiumFrom("STUDENT", [row("YEARLY", -10, 355, "CANCELLED")], now).status).toBe("free");
    expect(premiumFrom("STUDENT", [row("YEARLY", 5, 370)], now).status).toBe("free");
  });

  it("Super Admins always have Premium", () => {
    expect(premiumFrom("SUPER_ADMIN", [], now)).toMatchObject({ status: "active", via: "role" });
  });

  it("only active Premium unlocks capabilities", () => {
    expect(canUse(premiumFrom("STUDENT", [row("YEARLY", -1, 30)], now), "strategy")).toBe(true);
    expect(canUse(FREE, "strategy")).toBe(false);
    expect(canUse(premiumFrom("STUDENT", [row("MONTHLY", -40, -10)], now), "analytics")).toBe(false);
    expect(canUse(undefined, "analytics")).toBe(false);
  });
});

describe("server gates", () => {
  const user = (premium: SessionUser["premium"]): SessionUser => ({ id: "u1", email: "u@x.test", name: "U", role: "STUDENT", status: "ACTIVE", tradingEnabled: true, mfaEnabled: false, features: { standardTrading: true, demoTrading: true, replay: true, multiAccount: true, brokerConnection: true, portfolio: true, orderHistory: true, analytics: true }, premium });

  it("refuse a free account with 403 and allow an active one", () => {
    expect(() => requirePremium(user(FREE), "strategy")).toThrow(/Premium/);
    try { requirePremium(user(FREE), "analytics"); } catch (error) { expect((error as { status: number }).status).toBe(403); }
    expect(() => requirePremium(user({ status: "active", plan: "YEARLY", endsAt: null, via: "subscription" }), "strategy")).not.toThrow();
  });

  it("the Strategy and Prediction APIs and the Prediction page check Premium on the server", () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
    expect(read("src/app/api/market/s1/route.ts")).toMatch(/requirePremium\(await requireUser\(\), "strategy"\)/);
    expect(read("src/app/api/market/forecast/route.ts")).toMatch(/requirePremium\(user, "analytics"\)/);
    expect(read("src/app/(desk)/prediction/page.tsx")).toMatch(/canUse\(user\.premium, "analytics"\)/);
  });

  it("Premium can be granted only by a Super Admin route, never from the browser's own claim", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/super-admin/users/[id]/premium/route.ts"), "utf8");
    expect(route).toMatch(/requireUser\(\["SUPER_ADMIN"\]\)/g);
    const session = readFileSync(join(process.cwd(), "src/server/auth.ts"), "utf8");
    expect(session).toMatch(/premiumFrom\(session\.user\.role, session\.user\.subscriptions/);
  });
});

describe("crown toggle: where closing Premium returns to", async () => {
  const { premiumOrigin, rememberPremiumOrigin } = await import("@/components/premium/premium-upgrade-button");
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  const at = (pathname: string, search = "") => {
    Object.assign(globalThis, { sessionStorage: storage, window: { location: { pathname, search } } });
  };

  it("returns to the page Premium was opened from, query included", () => {
    store.clear();
    at("/chart", "?symbol=TCS");
    rememberPremiumOrigin();
    expect(premiumOrigin()).toBe("/chart?symbol=TCS");
    at("/holdings");
    rememberPremiumOrigin();
    expect(premiumOrigin()).toBe("/holdings");
  });

  it("never remembers the Premium page itself, and falls back to Home when opened directly", () => {
    store.clear();
    expect(premiumOrigin()).toBe("/");
    at("/premium", "?feature=strategy");
    rememberPremiumOrigin();
    expect(premiumOrigin()).toBe("/");
  });

  it("never returns to an outside site", () => {
    store.set("td-premium-from", "//evil.example/x");
    expect(premiumOrigin()).toBe("/");
    store.set("td-premium-from", "https://evil.example");
    expect(premiumOrigin()).toBe("/");
  });
});

describe("free vs premium comparison", async () => {
  const { COMPARE_ROWS } = await import("@/lib/premium/compare");
  const { PREMIUM_CAPABILITIES } = await import("@/lib/premium/entitlements");
  it("marks exactly the Premium capabilities as not free, and everything else as free", () => {
    const locked = COMPARE_ROWS.filter((row) => !row.free).map((row) => row.capability);
    expect(locked.sort()).toEqual(Object.keys(PREMIUM_CAPABILITIES).sort());
    expect(COMPARE_ROWS.filter((row) => row.free).every((row) => row.capability === undefined)).toBe(true);
  });
});
