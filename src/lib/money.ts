/** Paise integers. ₹1 = 100 paise. Display formatting is separate from ledger math. */

export function assertPaise(value: bigint): bigint {
  return value;
}

export function rupeesToPaise(input: string): bigint {
  const trimmed = input.trim().replace(/,/g, "").replace(/^₹/, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error("Enter an amount in rupees with at most 2 decimal places.");
  }
  const negative = trimmed.startsWith("-");
  const [whole, frac = ""] = trimmed.replace("-", "").split(".");
  const paise = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return negative ? -paise : paise;
}

export function paiseToRupees(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export function formatInr(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  const grouped = new Intl.NumberFormat("en-IN").format(whole);
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

export function formatSignedInr(paise: bigint): string {
  if (paise > 0n) return `+${formatInr(paise)}`;
  return formatInr(paise);
}

export function formatPercent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "—";
  const scaled = (part * 10000n) / whole;
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const units = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${units.toString()}.${frac}%`;
}

export function formatSignedPercent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "—";
  const text = formatPercent(part, whole);
  if (part > 0n) return `+${text}`;
  return text;
}

/** Half-up integer division. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Cannot divide by zero.");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const result = (a + b / 2n) / b;
  return negative ? -result : result;
}

export function percentOf(amount: bigint, percent: string): bigint {
  const [whole, frac = ""] = percent.split(".");
  const digits = (frac + "000000").slice(0, 6);
  const scale = 1_000_000n;
  const numerator = BigInt(whole) * scale + BigInt(digits);
  return divRound(amount * numerator, scale * 100n);
}

export function bpsOf(amount: bigint, bps: number): bigint {
  return divRound(amount * BigInt(bps), 10_000n);
}

export function roundToTick(price: bigint, tick: bigint, direction: "nearest" | "up" | "down"): bigint {
  if (tick <= 0n) throw new Error("Tick size must be positive.");
  if (price <= 0n) return 0n;
  const remainder = price % tick;
  if (remainder === 0n) return price;
  if (direction === "down") return price - remainder;
  if (direction === "up") return price - remainder + tick;
  return remainder * 2n >= tick ? price - remainder + tick : price - remainder;
}

export function applyAdverseSlippage(price: bigint, side: "BUY" | "SELL", bps: number, tick: bigint): bigint {
  if (price <= 0n) return 0n;
  const moved = side === "BUY" ? divRound(price * BigInt(10_000 + bps), 10_000n) : divRound(price * BigInt(10_000 - bps), 10_000n);
  return roundToTick(moved, tick, side === "BUY" ? "up" : "down");
}
