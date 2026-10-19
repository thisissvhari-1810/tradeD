export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;
  details?: Record<string, unknown>;

  constructor(message: string, status: number, code: string, field?: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("No connection to TradeD. Check your internet and retry.", 0, "NETWORK");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : `Request failed (HTTP ${response.status}).`;
    throw new ApiError(message, response.status, typeof data.code === "string" ? data.code : "UNKNOWN", typeof data.field === "string" ? data.field : undefined, data.details && typeof data.details === "object" ? data.details : undefined);
  }
  return data as T;
}

export type Quote = {
  symbol: string;
  last: string;
  bid: string;
  ask: string;
  open: string;
  high: string;
  low: string;
  previousClose: string;
  volume: string;
  asOf: string;
  mode: string;
  source: string;
  marketOpen: boolean;
  message: string;
};

export type Instrument = { symbol: string; name: string; exchange: string; sector: string; lotSize?: number; tickPaise?: number };

export function money(value: string | number | null | undefined, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function moveOf(last: string | undefined, previous: string | undefined) {
  const a = Number(last);
  const b = Number(previous);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const abs = a - b;
  const pct = b === 0 ? 0 : (abs / b) * 100;
  return { abs, pct };
}

export function tone(value: number | null | undefined) {
  if (value == null || value === 0 || !Number.isFinite(value)) return "flat";
  return value > 0 ? "up" : "down";
}

export function freshness(quote: Quote | null | undefined, online: boolean) {
  if (!online) return "disconnected";
  if (!quote) return "unavailable";
  if (quote.mode === "DEMO") return "demo";
  if (quote.mode === "UNAVAILABLE") return "unavailable";
  const age = Date.now() - new Date(quote.asOf).getTime();
  if (!Number.isFinite(age)) return "stale";
  if (quote.mode === "HISTORICAL") return "historical";
  if (quote.mode === "DELAYED" || age > 45_000) return quote.mode === "REALTIME" && age > 20_000 ? "stale" : "delayed";
  if (quote.mode === "REALTIME" && age > 20_000) return "stale";
  if (quote.mode === "REALTIME") return "live";
  return quote.mode.toLowerCase();
}

export function istTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short" });
}

export function istStamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const text = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
  return `${text} IST`;
}

export function key() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}
