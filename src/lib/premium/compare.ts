import { PREMIUM_CAPABILITIES, type PremiumCapability } from "@/lib/premium/entitlements";

/**
 * Free vs Premium, for the comparison table. Premium rows come from PREMIUM_CAPABILITIES (the same
 * list the server checks), so the table cannot disagree with what is actually locked.
 */
export type CompareRow = { feature: string; detail: string; free: boolean; premium: true; capability?: PremiumCapability };

const INCLUDED: Array<Omit<CompareRow, "free" | "premium">> = [
  { feature: "Charts and drawing tools", detail: "Candles, timeframes from 1 minute to 5 years, indicators and 50+ drawing tools." },
  { feature: "Paper trading", detail: "Practice orders on a virtual wallet, at demo or live prices." },
  { feature: "Historical replay", detail: "Replay a past session minute by minute and trade it." },
  { feature: "Option chain", detail: "Calls and puts by strike and expiry, with paper orders." },
  { feature: "Portfolio and trade history", detail: "Positions, orders, completed trades and P&L." },
];

export const COMPARE_ROWS: CompareRow[] = [
  ...INCLUDED.map((row) => ({ ...row, free: true, premium: true as const })),
  ...(Object.keys(PREMIUM_CAPABILITIES) as PremiumCapability[]).map((capability) => ({
    feature: PREMIUM_CAPABILITIES[capability].label,
    detail: PREMIUM_CAPABILITIES[capability].detail,
    free: false,
    premium: true as const,
    capability,
  })),
];
