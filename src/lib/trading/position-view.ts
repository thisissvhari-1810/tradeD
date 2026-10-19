import { rupeesToPaise } from "@/lib/money";
import type { TradeOutcome } from "@/lib/trading/replay-summary";

export type PositionStatus = "Open" | "Waiting for entry time" | "Closed";

export function positionStatus(row: { quantity: number; beforeEntry?: boolean }): PositionStatus {
  if (row.quantity === 0) return "Closed";
  return row.beforeEntry ? "Waiting for entry time" : "Open";
}

const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const STAMP = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

/** `09:42` in IST. */
export function istClock(at: Date | number): string {
  return CLOCK.format(typeof at === "number" ? new Date(at) : at);
}

/** `16 Oct, 09:42` in IST. */
export function istShortStamp(at: Date): string {
  return STAMP.format(at);
}

/** Header chip text, for example `Replay 16 Oct · 09:15`. */
export function replayChipLabel(date: string, cursor: number | null): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? DAY.format(new Date(`${date}T00:00:00Z`)) : date;
  return cursor == null ? `Replay ${day}` : `Replay ${day} · ${istClock(cursor * 1000)}`;
}

export function entryNotice(openedAt: string | null | undefined): string {
  const at = openedAt ? Date.parse(openedAt) : Number.NaN;
  return Number.isFinite(at) ? `Opens at ${istClock(at)} IST — move replay forward` : "Opens later in this session — move replay forward";
}

/** Why a replay premium is missing, based on the actual replay and pricing state. */
export function missingPriceReason(input: { cursor: number | null; sessionOpen: number | null; loading: boolean; message?: string | null }): string {
  if (input.cursor == null) return "Waiting for the first replay candle.";
  if (input.loading) return "Loading the replay premium…";
  if (input.sessionOpen != null && input.cursor < input.sessionOpen + 60) return `No trade at ${istClock(input.cursor * 1000)} — price becomes available after the first candle.`;
  return input.message?.trim() || "Price unavailable for this contract at the selected replay time.";
}

export function holdingLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Parses ledger rupee text such as `97.61`, `-12.30`, `+₹1,087.18` or `−₹45.00` into paise. */
export function parseRupees(text: string | null | undefined): bigint | null {
  if (text == null) return null;
  const cleaned = text.trim().replace(/−/g, "-").replace(/[₹,+\s]/g, "");
  if (!cleaned || cleaned === "-") return null;
  try {
    return rupeesToPaise(cleaned);
  } catch {
    return null;
  }
}

/** Parses `+11.80%` / `-4.25%` into basis points. */
export function parsePercentBps(text: string | null | undefined): number | null {
  if (!text) return null;
  const value = Number(text.trim().replace(/−/g, "-").replace(/[+%\s]/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export const OUTCOME_LABEL: Record<TradeOutcome, string> = { WIN: "WIN", LOSS: "LOSS", BREAK_EVEN: "BREAK-EVEN" };

export function pnlTone(paise: bigint | null | undefined): "text-profit" | "text-loss" | "text-text-2" {
  if (paise == null || paise === 0n) return "text-text-2";
  return paise > 0n ? "text-profit" : "text-loss";
}
