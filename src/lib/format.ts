/** Display-only formatters. Missing values render as "—", never as zero. */

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function inr(value: unknown): string {
  const number = finite(value);
  return number == null ? "—" : INR.format(number);
}

/** Reads a server-formatted rupee string such as "-₹1,00,000.00" or "+₹12.50". */
export function parseInr(value: string | null | undefined): number | null {
  if (!value || value === "—") return null;
  const cleaned = value.replace(/[₹,\s+]/g, "").replace("−", "-");
  return finite(cleaned);
}

/** Splits "-₹1,00,000.00" into a sign/currency prefix and the digits for typographic emphasis. */
export function splitInr(value: string): { prefix: string; body: string } {
  const at = value.indexOf("₹");
  if (at < 0) return { prefix: "", body: value };
  return { prefix: value.slice(0, at + 1), body: value.slice(at + 1) };
}

export function signedPercent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
}

export function signedNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const body = Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${body}`;
}

/** Indian compact volume: thousand, lakh, crore. */
export function compactVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)} K`;
  return value.toLocaleString("en-IN");
}

/** "Positive", "negative" or "neutral" from a server-formatted signed string. */
export function signOf(value: string | null | undefined): "profit" | "loss" | "neutral" {
  const number = parseInr(value ?? null) ?? finite((value ?? "").replace(/[%+\s]/g, "").replace("−", "-"));
  if (number == null || number === 0) return "neutral";
  return number > 0 ? "profit" : "loss";
}
