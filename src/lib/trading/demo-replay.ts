import { paiseToRupees, rupeesToPaise } from "@/lib/money";
import { calculateCharges } from "@/lib/trading/fees";
import { DEFAULT_CHARGES } from "@/lib/trading/settings";

/** Demo fills stay in the browser. This is not an order route. */
export const DEMO_ORDER_ROUTE: null = null;

export const DEMO_START_PAISE = 100_000_000;

export type DemoCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type DemoFill = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  pricePaise: number;
  time: number;
  chargesPaise: number;
};

export type DemoPosition = { symbol: string; quantity: number; avgPaise: number };

export type DemoOrder = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: number;
  limitPaise: number | null;
  status: "OPEN" | "FILLED" | "CANCELLED" | "REJECTED";
  reason: string;
  time: number;
};

export type DemoBook = {
  cashPaise: number;
  realizedPaise: number;
  positions: DemoPosition[];
  fills: DemoFill[];
  orders: DemoOrder[];
};

export function emptyDemoBook(): DemoBook {
  return { cashPaise: DEMO_START_PAISE, realizedPaise: 0, positions: [], fills: [], orders: [] };
}

export function loadDemoBook(raw: string | null): DemoBook {
  if (!raw) return emptyDemoBook();
  try {
    const parsed = JSON.parse(raw) as Partial<DemoBook>;
    if (!parsed || typeof parsed.cashPaise !== "number" || !Number.isFinite(parsed.cashPaise) || !Array.isArray(parsed.positions) || !Array.isArray(parsed.fills)) return emptyDemoBook();
    return {
      cashPaise: parsed.cashPaise,
      realizedPaise: typeof parsed.realizedPaise === "number" && Number.isFinite(parsed.realizedPaise) ? parsed.realizedPaise : 0,
      positions: parsed.positions.filter((item) => item && typeof item.symbol === "string" && Number.isInteger(item.quantity) && item.quantity > 0 && Number.isFinite(item.avgPaise)),
      fills: parsed.fills.filter((item) => item && (item.side === "BUY" || item.side === "SELL") && Number.isInteger(item.quantity) && item.quantity > 0),
      orders: Array.isArray(parsed.orders) ? parsed.orders.filter((item) => item && (item.side === "BUY" || item.side === "SELL") && (item.type === "MARKET" || item.type === "LIMIT") && Number.isInteger(item.quantity) && item.quantity > 0) : [],
    };
  } catch {
    return emptyDemoBook();
  }
}

/** Latest candle the replay is allowed to reveal. After the close, the loaded history is the tape. */
export function revealLimit(candles: DemoCandle[], nowSec: number, marketOpen: boolean, delaySec: number): number | null {
  if (!candles.length || !Number.isFinite(delaySec) || delaySec < 0 || !Number.isFinite(nowSec)) return null;
  const last = candles[candles.length - 1].time;
  const cutoff = marketOpen ? nowSec - delaySec : last;
  let found: number | null = null;
  for (const candle of candles) {
    if (candle.time <= cutoff) found = candle.time;
  }
  return found;
}

/** Where playback starts. While the session is open this is the delayed present. After the close it sits one delay before the last candle. */
export function initialPlayhead(candles: DemoCandle[], nowSec: number, marketOpen: boolean, delaySec: number): number | null {
  const limit = revealLimit(candles, nowSec, marketOpen, delaySec);
  if (limit == null) return null;
  if (marketOpen) return limit;
  const target = limit - delaySec;
  let found: number | null = null;
  for (const candle of candles) {
    if (candle.time <= target && candle.time <= limit) found = candle.time;
  }
  return found ?? (candles[0].time <= limit ? candles[0].time : null);
}

export function sliceTo(candles: DemoCandle[], until: number | null): DemoCandle[] {
  if (until == null) return candles;
  return candles.filter((candle) => candle.time <= until);
}

export function stepPlayhead(candles: DemoCandle[], playhead: number | null, direction: -1 | 1, limit: number | null): number | null {
  if (limit == null) return playhead;
  const tape = candles.filter((candle) => candle.time <= limit);
  if (!tape.length) return null;
  if (playhead == null) return direction < 0 ? tape[0].time : tape[tape.length - 1].time;
  const index = tape.findIndex((candle) => candle.time === playhead);
  const start = index >= 0 ? index : tape.findLastIndex((candle) => candle.time <= playhead);
  const next = (start < 0 ? 0 : start) + direction;
  if (next < 0 || next >= tape.length) return tape[start < 0 ? 0 : start].time;
  return tape[next].time;
}

export function candleChange(close: number, basis: number): { change: number; percent: number } {
  const change = close - basis;
  const percent = basis ? (change / basis) * 100 : 0;
  return { change, percent };
}

export function formatIst(unixSec: number): string {
  const label = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(unixSec * 1000));
  return `${label} IST`;
}

export function applyDemoFill(
  book: DemoBook,
  order: { id: string; symbol: string; side: "BUY" | "SELL"; quantity: number; candle: DemoCandle; playheadTime: number; revealTime: number },
): { ok: true; book: DemoBook } | { ok: false; error: string } {
  if (DEMO_ORDER_ROUTE !== null) return { ok: false, error: "Demo orders have no route." };
  const symbol = order.symbol.trim().toUpperCase();
  if (!symbol || !Number.isInteger(order.quantity) || order.quantity <= 0) return { ok: false, error: "Enter a whole number of shares." };
  if (order.candle.time !== order.playheadTime || order.candle.time > order.revealTime) {
    return { ok: false, error: "Demo orders fill on the candle at the replay time. Later candles stay unused." };
  }
  if (!Number.isFinite(order.candle.close) || order.candle.close <= 0) return { ok: false, error: "This candle has no price." };
  const pricePaise = Number(rupeesToPaise(order.candle.close.toFixed(2)));
  const notional = BigInt(pricePaise) * BigInt(order.quantity);
  const chargesPaise = Number(calculateCharges(order.side, notional, DEFAULT_CHARGES).total);
  const position = book.positions.find((item) => item.symbol === symbol) ?? null;
  if (order.side === "SELL") {
    if (!position || position.quantity < order.quantity) return { ok: false, error: "Sell quantity is above the demo shares you hold." };
    const proceeds = pricePaise * order.quantity - chargesPaise;
    const realized = (pricePaise - position.avgPaise) * order.quantity - chargesPaise;
    const nextQty = position.quantity - order.quantity;
    return {
      ok: true,
      book: {
        cashPaise: book.cashPaise + proceeds,
        realizedPaise: book.realizedPaise + realized,
        positions: nextQty > 0 ? book.positions.map((item) => item.symbol === symbol ? { ...item, quantity: nextQty } : item) : book.positions.filter((item) => item.symbol !== symbol),
        fills: [...book.fills, { id: order.id, symbol, side: "SELL", quantity: order.quantity, pricePaise, time: order.candle.time, chargesPaise }],
        orders: book.orders ?? [],
      },
    };
  }
  const cost = pricePaise * order.quantity + chargesPaise;
  if (cost > book.cashPaise) return { ok: false, error: "Demo buying power cannot cover this fill." };
  const nextQty = (position?.quantity ?? 0) + order.quantity;
  const nextAvg = Math.round((((position?.avgPaise ?? 0) * (position?.quantity ?? 0)) + pricePaise * order.quantity) / nextQty);
  const nextPosition = { symbol, quantity: nextQty, avgPaise: nextAvg };
  return {
    ok: true,
    book: {
      cashPaise: book.cashPaise - cost,
      realizedPaise: book.realizedPaise,
      positions: position ? book.positions.map((item) => item.symbol === symbol ? nextPosition : item) : [...book.positions, nextPosition],
      fills: [...book.fills, { id: order.id, symbol, side: "BUY", quantity: order.quantity, pricePaise, time: order.candle.time, chargesPaise }],
      orders: book.orders ?? [],
    },
  };
}

export function istDay(unixSec: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unixSec * 1000));
}

export function sessionDays(candles: DemoCandle[]): string[] {
  const days: string[] = [];
  for (const candle of candles) {
    const day = istDay(candle.time);
    if (!days.includes(day)) days.push(day);
  }
  return days;
}

export function firstCandleOn(candles: DemoCandle[], day: string): number | null {
  return candles.find((candle) => istDay(candle.time) === day)?.time ?? null;
}

function openBuyReserve(book: DemoBook): number {
  return (book.orders ?? []).filter((order) => order.status === "OPEN" && order.side === "BUY" && order.limitPaise != null).reduce((sum, order) => {
    const notional = BigInt(order.limitPaise ?? 0) * BigInt(order.quantity);
    return sum + order.limitPaise! * order.quantity + Number(calculateCharges("BUY", notional, DEFAULT_CHARGES).total);
  }, 0);
}

function openSellQty(book: DemoBook, symbol: string): number {
  return (book.orders ?? []).filter((order) => order.status === "OPEN" && order.side === "SELL" && order.symbol === symbol).reduce((sum, order) => sum + order.quantity, 0);
}

function recordOrder(book: DemoBook, order: DemoOrder, next: DemoBook): DemoBook {
  return { ...next, orders: [...(book.orders ?? []).filter((item) => item.id !== order.id), { ...order, status: "FILLED", reason: "Filled on the replay candle." }] };
}

export function placeDemoOrder(
  book: DemoBook,
  input: {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    quantity: number;
    limitPrice: number | null;
    candle: DemoCandle | null;
    playheadTime: number | null;
    revealTime: number | null;
    paused: boolean;
  },
): { ok: true; book: DemoBook } | { ok: false; error: string } {
  if (DEMO_ORDER_ROUTE !== null) return { ok: false, error: "Demo orders have no route." };
  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol || !Number.isInteger(input.quantity) || input.quantity <= 0) return { ok: false, error: "Enter a whole number of shares." };
  const current = { ...book, orders: book.orders ?? [] };
  const limitPaise = input.type === "LIMIT" ? Number(rupeesToPaise((input.limitPrice ?? 0).toFixed(2))) : null;
  if (input.type === "LIMIT" && (!limitPaise || !Number.isFinite(input.limitPrice) || (input.limitPrice ?? 0) <= 0)) {
    return { ok: false, error: "Enter a limit price in rupees." };
  }
  const draft: DemoOrder = {
    id: input.id,
    symbol,
    side: input.side,
    type: input.type,
    quantity: input.quantity,
    limitPaise,
    status: "OPEN",
    reason: "",
    time: input.playheadTime ?? 0,
  };
  if (input.side === "SELL") {
    const held = current.positions.find((item) => item.symbol === symbol)?.quantity ?? 0;
    if (held - openSellQty(current, symbol) < input.quantity) return { ok: false, error: "Sell quantity is above the demo shares you hold." };
  }
  if (input.side === "BUY") {
    const raw = input.type === "LIMIT" ? (limitPaise ?? 0) / 100 : input.candle?.close;
    if (raw && Number.isFinite(raw) && raw > 0) {
      const pricePaise = Number(rupeesToPaise(raw.toFixed(2)));
      const cost = pricePaise * input.quantity + Number(calculateCharges("BUY", BigInt(pricePaise) * BigInt(input.quantity), DEFAULT_CHARGES).total);
      if (openBuyReserve(current) + cost > current.cashPaise) return { ok: false, error: "Demo buying power cannot cover this order." };
    }
  }
  if (input.paused && input.type === "MARKET") {
    return { ok: false, error: "Playback is paused. A market demo order fills only on the current candle while replay is running. Place a limit order to leave it waiting, or resume playback." };
  }
  if (input.type === "LIMIT" && (input.paused || !touches(input.candle, input.side, limitPaise ?? 0) || input.candle?.time !== input.playheadTime || (input.revealTime != null && input.candle.time > input.revealTime))) {
    return { ok: true, book: { ...current, orders: [...current.orders, { ...draft, reason: input.paused ? "Waiting. Playback is paused." : "Waiting for the replay candle to trade at the limit." }] } };
  }
  if (!input.candle || input.playheadTime == null || input.revealTime == null) return { ok: false, error: "Demo mode has no candle at the replay time." };
  const price = input.type === "LIMIT" ? (limitPaise ?? 0) / 100 : input.candle.close;
  const filled = applyDemoFill(current, {
    id: input.id,
    symbol,
    side: input.side,
    quantity: input.quantity,
    candle: { ...input.candle, close: price },
    playheadTime: input.playheadTime,
    revealTime: input.revealTime,
  });
  if (!filled.ok) return filled;
  return { ok: true, book: recordOrder(current, draft, filled.book) };
}

function touches(candle: DemoCandle | null, side: "BUY" | "SELL", limitPaise: number): boolean {
  if (!candle || limitPaise <= 0) return false;
  const limit = limitPaise / 100;
  return side === "BUY" ? candle.low <= limit : candle.high >= limit;
}

export function settleDemoOrders(book: DemoBook, symbol: string, candle: DemoCandle, playheadTime: number, revealTime: number): DemoBook {
  if (candle.time !== playheadTime || candle.time > revealTime) return book;
  let next = { ...book, orders: book.orders ?? [] };
  for (const order of next.orders) {
    if (order.status !== "OPEN" || order.type !== "LIMIT" || order.symbol !== symbol || order.limitPaise == null) continue;
    if (!touches(candle, order.side, order.limitPaise)) continue;
    const filled = applyDemoFill(next, {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      candle: { ...candle, close: order.limitPaise / 100 },
      playheadTime,
      revealTime,
    });
    if (!filled.ok) {
      next = { ...next, orders: next.orders.map((item) => item.id === order.id ? { ...item, status: "REJECTED", reason: filled.error } : item) };
      continue;
    }
    next = recordOrder(next, order, filled.book);
  }
  return next;
}

export function cancelDemoOrder(book: DemoBook, id: string): DemoBook {
  return {
    ...book,
    orders: (book.orders ?? []).map((order) => order.id === id && order.status === "OPEN" ? { ...order, status: "CANCELLED", reason: "Cancelled in the demo book." } : order),
  };
}

export function demoUnrealized(book: DemoBook, marksPaise: Record<string, number>): number {
  return book.positions.reduce((total, position) => {
    const mark = marksPaise[position.symbol];
    if (!Number.isFinite(mark)) return total;
    return total + (mark - position.avgPaise) * position.quantity;
  }, 0);
}

export function formatDemoRupees(paise: number): string {
  return paiseToRupees(BigInt(Math.round(paise)));
}
