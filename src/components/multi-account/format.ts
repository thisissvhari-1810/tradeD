import { formatInr, formatPnl, rupeesToPaise } from "@/lib/money";
import type { LegStatus, OverallStatus } from "@/lib/multi-account/engine";
import type { Tone } from "@/components/ui";

export const FIELD = "h-8 w-full min-w-0 rounded-input border border-border bg-background px-2 text-dense text-text disabled:opacity-50";
export const LABEL = "flex min-w-0 flex-col gap-1 text-data font-medium text-muted";

export function inr(paise: number | null | undefined) {
  return paise == null || !Number.isFinite(paise) ? "—" : formatInr(BigInt(Math.round(paise)));
}

export function pnl(paise: number | null | undefined) {
  return paise == null || !Number.isFinite(paise) ? "Unavailable" : formatPnl(BigInt(Math.round(paise)));
}

export function pnlTone(paise: number | null | undefined): Tone {
  if (paise == null || paise === 0) return "neutral";
  return paise > 0 ? "profit" : "loss";
}

/** Rupee text to paise, or null when blank or invalid. */
export function toPaise(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const value = Number(rupeesToPaise(trimmed));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

export const LEG_TONE: Record<LegStatus, Tone> = { FILLED: "profit", PARTIAL: "warning", PENDING: "info", REJECTED: "loss", CANCELLED: "neutral", UNKNOWN: "warning" };
export const LEG_LABEL: Record<LegStatus, string> = { FILLED: "Filled", PARTIAL: "Partly filled", PENDING: "Pending", REJECTED: "Rejected", CANCELLED: "Cancelled", UNKNOWN: "Unconfirmed" };
export const OVERALL_TONE: Record<OverallStatus, Tone> = { Completed: "profit", "Partially Completed": "warning", Failed: "loss", Pending: "info" };

export function contractLabel(contract: { underlying: string; expiry: string; strike: number; right: string }) {
  return `${contract.underlying} ${contract.strike} ${contract.right}`;
}

export function expiryLabel(expiry: string) {
  const date = new Date(`${expiry}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? expiry : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
