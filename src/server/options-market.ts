import { aggregateMinutes } from "@/lib/market/spans";
import { nseCashSession } from "@/lib/market/clock";
import { getDhanAccessToken, getDhanClientId } from "@/server/settings";
import { dropFormingBar, modelChain, sampleBreakoutBars, type Bar, type OptionContract } from "@/lib/options/engine";

export type OptionsSnapshot = {
  indexSource: "dhan" | "sample";
  premiumSource: "dhan" | "modelled";
  message: string;
  asOf: string;
  stale: boolean;
  spot: number;
  candles5: Bar[];
  candles15: Bar[];
  chain: OptionContract[];
  lotSize: number;
  lotSizeNote: string;
};

const SAMPLE_LOT = 75;

export async function loadOptionsSnapshot(now = new Date()): Promise<OptionsSnapshot> {
  const sample = sampleSnapshot(now);
  try {
    const token = await getDhanAccessToken();
    const candles5 = dropFormingBar(await dhanIndex(token, "5", now), Math.floor(now.getTime() / 1000), 300);
    if (candles5.length < 20) return sample;
    let candles15: Bar[] = [];
    try {
      candles15 = dropFormingBar(await dhanIndex(token, "15", now), Math.floor(now.getTime() / 1000), 900);
    } catch {
      candles15 = dropFormingBar(aggregateMinutes(candles5, 15), Math.floor(now.getTime() / 1000), 900);
    }
    const spot = candles5[candles5.length - 1].close;
    const session = nseCashSession(now);
    const age = now.getTime() / 1000 - candles5[candles5.length - 1].time;
    const stale = session.open && age > 180;
    const chain = await dhanChain(token, spot, now).catch(() => null);
    if (!chain) {
      return {
        indexSource: "dhan",
        premiumSource: "modelled",
        message: "Index candles were loaded. The option chain did not return, so premiums are modelled and are not exchange quotes. Orders stay simulated.",
        asOf: new Date(candles5[candles5.length - 1].time * 1000).toISOString(),
        stale,
        spot,
        candles5,
        candles15,
        chain: modelChain(spot, istDay(now), SAMPLE_LOT),
        lotSize: SAMPLE_LOT,
        lotSizeNote: "Illustrative sample lot of 75. Confirm the live NSE lot before treating a contract as real.",
      };
    }
    return {
      indexSource: "dhan",
      premiumSource: "dhan",
      message: stale
        ? "Option data is older than three minutes during the session. New entries are blocked."
        : "Index and option chain are from the live feed. Orders stay simulated and are not sent to the exchange.",
      asOf: new Date().toISOString(),
      stale,
      spot: chain.spot || spot,
      candles5,
      candles15,
      chain: chain.contracts,
      lotSize: chain.lotSize,
      lotSizeNote: chain.lotNote,
    };
  } catch {
    return sample;
  }
}

function sampleSnapshot(now: Date): OptionsSnapshot {
  const candles5 = sampleBreakoutBars();
  const spot = candles5[candles5.length - 1].close;
  const day = istDay(now);
  return {
    indexSource: "sample",
    premiumSource: "modelled",
    message: "Simulated sample. These are not live prices. No option chain was available, and no order can leave this application.",
    asOf: now.toISOString(),
    stale: false,
    spot,
    candles5,
    candles15: aggregateMinutes(candles5, 15),
    chain: modelChain(spot, day, SAMPLE_LOT),
    lotSize: SAMPLE_LOT,
    lotSizeNote: "Illustrative sample lot of 75. This is not the live NSE contract specification.",
  };
}

async function dhanIndex(token: string, interval: "5" | "15", now: Date) {
  const id = process.env.NIFTY_DHAN_SECURITY_ID?.trim() || "13";
  const from = new Date(now.getTime() - 10 * 86_400_000);
  const payload = await dhanPost(token, "/charts/intraday", {
    securityId: id,
    exchangeSegment: "IDX_I",
    instrument: "INDEX",
    interval,
    oi: false,
    fromDate: `${istDay(from)} 09:15:00`,
    toDate: istStamp(now),
  });
  return candlesFrom(payload);
}

async function dhanChain(token: string, fallbackSpot: number, now: Date) {
  const id = Number(process.env.NIFTY_DHAN_SECURITY_ID?.trim() || "13");
  const expiryPayload = await dhanPost(token, "/optionchain/expirylist", { UnderlyingScrip: id, UnderlyingSeg: "IDX_I" });
  const expiries = collectStrings(expiryPayload).filter((item) => item >= istDay(now)).sort();
  const expiry = expiries[0];
  if (!expiry) return null;
  const payload = await dhanPost(token, "/optionchain", { UnderlyingScrip: id, UnderlyingSeg: "IDX_I", Expiry: expiry });
  const parsed = parseChain(payload, expiry, fallbackSpot);
  if (!parsed) return null;
  const envLot = Number(process.env.NIFTY_OPTION_LOT_SIZE);
  const lotSize = Number.isInteger(envLot) && envLot > 0 ? envLot : parsed.lotSize;
  if (!lotSize) return null;
  return {
    spot: parsed.spot,
    contracts: parsed.contracts.map((contract) => ({ ...contract, lotSize })),
    lotSize,
    lotNote: Number.isInteger(envLot) && envLot > 0 ? "Lot size from NIFTY_OPTION_LOT_SIZE." : "Lot size from the option-chain payload.",
  };
}

function parseChain(payload: unknown, expiry: string, fallbackSpot: number) {
  const root = asRecord(payload);
  const data = asRecord(root.data ?? root);
  const spot = numberAt(data, ["last_price", "lastPrice", "underlyingValue"]) ?? fallbackSpot;
  const oc = asRecord(data.oc ?? data.optionChain ?? data.chain);
  const contracts: OptionContract[] = [];
  let lotSize: number | null = null;
  for (const [strikeKey, row] of Object.entries(oc)) {
    const strike = Number(strikeKey);
    if (!Number.isFinite(strike)) continue;
    const record = asRecord(row);
    for (const side of ["CE", "PE"] as const) {
      const quote = asRecord(record[side.toLowerCase()] ?? record[side]);
      if (!Object.keys(quote).length) continue;
      const foundLot = numberAt(quote, ["lot_size", "lotSize"]);
      if (foundLot && foundLot > 0) lotSize = foundLot;
      contracts.push({
        side,
        strike,
        expiry,
        lotSize: foundLot && foundLot > 0 ? foundLot : 0,
        ltp: numberAt(quote, ["last_price", "lastPrice", "ltp"]),
        bid: numberAt(quote, ["top_bid_price", "bid", "bestBid"]),
        ask: numberAt(quote, ["top_ask_price", "ask", "bestAsk"]),
        volume: numberAt(quote, ["volume"]),
        oi: numberAt(quote, ["oi", "openInterest"]),
        iv: numberAt(quote, ["implied_volatility", "iv"]),
      });
    }
  }
  if (!contracts.length) return null;
  return { spot, contracts, lotSize };
}

async function dhanPost(token: string, path: string, body: unknown) {
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json", "access-token": token };
  const clientId = await getDhanClientId();
  if (clientId) headers["client-id"] = clientId;
  const response = await fetch(`https://api.dhan.co/v2${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Option market data was not available.");
  return payload;
}

function candlesFrom(payload: unknown): Bar[] {
  const series = asRecord(payload);
  const times = Array.isArray(series.timestamp) ? series.timestamp : [];
  const bars: Bar[] = [];
  times.forEach((time, index) => {
    const open = num(series.open, index);
    const high = num(series.high, index);
    const low = num(series.low, index);
    const close = num(series.close, index);
    const stamp = Number(time);
    if (![stamp, open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) return;
    bars.push({ time: stamp, open, high, low, close, volume: Math.max(0, num(series.volume, index) || 0) });
  });
  return bars.sort((a, b) => a.time - b.time);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberAt(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function num(value: unknown, index: number) {
  return Array.isArray(value) ? Number(value[index]) : Number.NaN;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}

function istDay(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function istStamp(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}:${read("second")}`;
}
