import { formatInr, paiseToRupees, rupeesToPaise } from "@/lib/money";
import { calculateCharges } from "@/lib/trading/fees";
import { DEFAULT_CHARGES } from "@/lib/trading/settings";

/** Demo fills stay in the browser. This is not an order route. */
export const DEMO_ORDER_ROUTE: null = null;

export const DEMO_START_PAISE = 100_000_000;

export type DemoCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type ExitReason = "manual" | "stop" | "target" | "limit" | "stop-order";
export type DemoOrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";

export type DemoFill = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  pricePaise: number;
  time: number;
  chargesPaise: number;
  exitReason?: ExitReason;
  sessionDate?: string;
  timeframe?: string;
};

export type DemoPosition = {
  symbol: string;
  quantity: number;
  avgPaise: number;
  stopPaise?: number | null;
  targetPaise?: number | null;
  armedAt?: number;
  entryTime?: number;
  openChargesPaise?: number;
};

export type DemoOrder = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: DemoOrderType;
  quantity: number;
  limitPaise: number | null;
  stopPaise?: number | null;
  stopLossPaise?: number | null;
  takeProfitPaise?: number | null;
  status: "OPEN" | "FILLED" | "CANCELLED" | "REJECTED";
  reason: string;
  time: number;
  sessionDate?: string;
  timeframe?: string;
};

export type DemoTrade = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPaise: number;
  exitPaise: number;
  entryTime: number;
  exitTime: number;
  grossPaise: number;
  chargesPaise: number;
  netPaise: number;
  exitReason: ExitReason;
  sessionDate: string;
  timeframe: string;
};

export type DemoBook = {
  cashPaise: number;
  startPaise: number;
  realizedPaise: number;
  allowShort: boolean;
  positions: DemoPosition[];
  fills: DemoFill[];
  orders: DemoOrder[];
  trades: DemoTrade[];
};

export function emptyDemoBook(startPaise = DEMO_START_PAISE): DemoBook {
  const start = Number.isFinite(startPaise) && startPaise > 0 ? Math.round(startPaise) : DEMO_START_PAISE;
  return { cashPaise: start, startPaise: start, realizedPaise: 0, allowShort: false, positions: [], fills: [], orders: [], trades: [] };
}

const ORDER_TYPES = new Set<DemoOrderType>(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]);

export function loadDemoBook(raw: string | null): DemoBook {
  if (!raw) return emptyDemoBook();
  try {
    const parsed = JSON.parse(raw) as Partial<DemoBook>;
    if (!parsed || typeof parsed.cashPaise !== "number" || !Number.isFinite(parsed.cashPaise) || !Array.isArray(parsed.positions) || !Array.isArray(parsed.fills)) return emptyDemoBook();
    const start = typeof parsed.startPaise === "number" && parsed.startPaise > 0 ? Math.round(parsed.startPaise) : DEMO_START_PAISE;
    const fills = parsed.fills.filter((item) => item && (item.side === "BUY" || item.side === "SELL") && Number.isInteger(item.quantity) && item.quantity > 0 && Number.isFinite(item.pricePaise));
    const orders = Array.isArray(parsed.orders) ? parsed.orders.filter((item) => item && (item.side === "BUY" || item.side === "SELL") && ORDER_TYPES.has(item.type) && Number.isInteger(item.quantity) && item.quantity > 0) : [];
    const positions = parsed.positions.filter((item) => item && typeof item.symbol === "string" && Number.isInteger(item.quantity) && item.quantity !== 0 && Number.isFinite(item.avgPaise));
    const idle = fills.length === 0 && positions.length === 0 && !orders.some((order) => order.status === "OPEN");
    const cashPaise = idle ? start : fills.length === parsed.fills.length && fills.length > 0 ? cashFromFills(start, fills) : parsed.cashPaise;
    return {
      cashPaise,
      startPaise: start,
      realizedPaise: typeof parsed.realizedPaise === "number" && Number.isFinite(parsed.realizedPaise) ? parsed.realizedPaise : 0,
      allowShort: parsed.allowShort === true,
      positions,
      fills,
      orders,
      trades: Array.isArray(parsed.trades) ? parsed.trades.filter((item) => item && (item.side === "LONG" || item.side === "SHORT") && Number.isInteger(item.quantity) && item.quantity > 0 && Number.isFinite(item.netPaise)) : [],
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
  order: {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    candle: DemoCandle;
    playheadTime: number;
    revealTime: number;
    allowShort?: boolean;
    exitReason?: ExitReason;
    sessionDate?: string;
    timeframe?: string;
  },
): { ok: true; book: DemoBook } | { ok: false; error: string } {
  if (DEMO_ORDER_ROUTE !== null) return { ok: false, error: "Demo orders have no route." };
  const symbol = order.symbol.trim().toUpperCase();
  if (!symbol || !Number.isInteger(order.quantity) || order.quantity <= 0) return { ok: false, error: "Enter a whole number of shares." };
  const minuteEnd = order.candle.time + 60;
  if (order.playheadTime < order.candle.time || order.playheadTime > minuteEnd || order.playheadTime > order.revealTime) {
    return { ok: false, error: "Demo orders fill on the revealed price at the replay time. Later candles stay unused." };
  }
  if (!Number.isFinite(order.candle.close) || order.candle.close <= 0) return { ok: false, error: "This candle has no price." };
  const pricePaise = Number(rupeesToPaise(order.candle.close.toFixed(2)));
  return commitFill(readyBook(book), {
    id: order.id,
    symbol,
    side: order.side,
    quantity: order.quantity,
    pricePaise,
    time: order.playheadTime,
    allowShort: order.allowShort === true || book.allowShort === true,
    exitReason: order.exitReason ?? "manual",
    sessionDate: order.sessionDate || istDay(order.playheadTime),
    timeframe: order.timeframe ?? "",
  });
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

function readyBook(book: DemoBook): DemoBook {
  const start = book.startPaise > 0 ? book.startPaise : DEMO_START_PAISE;
  return {
    cashPaise: book.cashPaise,
    startPaise: start,
    realizedPaise: book.realizedPaise ?? 0,
    allowShort: book.allowShort === true,
    positions: book.positions ?? [],
    fills: book.fills ?? [],
    orders: book.orders ?? [],
    trades: book.trades ?? [],
  };
}

function chargePaise(side: "BUY" | "SELL", pricePaise: number, quantity: number): number {
  return Number(calculateCharges(side, BigInt(pricePaise) * BigInt(quantity), DEFAULT_CHARGES).total);
}

function openBuyReserve(book: DemoBook): number {
  return (book.orders ?? []).filter((order) => order.status === "OPEN" && order.side === "BUY" && (order.limitPaise != null || order.stopPaise != null)).reduce((sum, order) => {
    const unit = order.limitPaise ?? order.stopPaise ?? 0;
    if (unit <= 0) return sum;
    return sum + unit * order.quantity + chargePaise("BUY", unit, order.quantity);
  }, 0);
}

function openSellQty(book: DemoBook, symbol: string): number {
  return (book.orders ?? []).filter((order) => order.status === "OPEN" && order.side === "SELL" && order.symbol === symbol).reduce((sum, order) => sum + order.quantity, 0);
}

function shortMargin(book: DemoBook, marks: Record<string, number> = {}): number {
  return book.positions.reduce((sum, position) => {
    if (position.quantity >= 0) return sum;
    const mark = Number.isFinite(marks[position.symbol]) ? marks[position.symbol] : position.avgPaise;
    return sum + Math.max(position.avgPaise, mark) * Math.abs(position.quantity);
  }, 0);
}

export function reservedFunds(book: DemoBook, marks: Record<string, number> = {}): number {
  return openBuyReserve(readyBook(book)) + shortMargin(readyBook(book), marks);
}

export function buyingPower(book: DemoBook, marks: Record<string, number> = {}): number {
  return readyBook(book).cashPaise - reservedFunds(book, marks);
}

function cashFromFills(startPaise: number, fills: DemoFill[]): number {
  return fills.reduce((cash, fill) => {
    const gross = fill.pricePaise * fill.quantity;
    const fee = Number.isFinite(fill.chargesPaise) ? fill.chargesPaise : 0;
    return fill.side === "BUY" ? cash - gross - fee : cash + gross - fee;
  }, startPaise);
}

export function fundsForBuy(book: DemoBook, priceRupees: number, quantity: number, marks: Record<string, number> = {}, product: "equity" | "index" = "equity", symbol = ""): { ok: true; notionalPaise: number; chargesPaise: number; requiredPaise: number; buyingPowerPaise: number; reservedPaise: number } | { ok: false; error: string; notionalPaise: number; chargesPaise: number; requiredPaise: number; buyingPowerPaise: number; shortfallPaise: number; reservedPaise: number } {
  const pricePaise = Number(rupeesToPaise(priceRupees.toFixed(2)));
  const notionalPaise = pricePaise * quantity;
  const chargesPaise = chargePaise("BUY", pricePaise, quantity);
  const requiredPaise = notionalPaise + chargesPaise;
  const current = readyBook(book);
  const reservedPaise = reservedFunds(current, marks);
  const buyingPowerPaise = current.cashPaise - reservedPaise;
  if (requiredPaise <= buyingPowerPaise) return { ok: true, notionalPaise, chargesPaise, requiredPaise, buyingPowerPaise, reservedPaise };
  const shortfallPaise = requiredPaise - buyingPowerPaise;
  const indexNote = product === "index" ? ` ${symbol || "This symbol"} is an index. Each unit uses the index value. No futures lot is applied.` : "";
  const reservedNote = reservedPaise > 0 ? ` Reserved ₹${moneyLabel(reservedPaise)} is held for pending buy orders or short margin.` : "";
  return {
    ok: false,
    notionalPaise,
    chargesPaise,
    requiredPaise,
    buyingPowerPaise,
    shortfallPaise,
    reservedPaise,
    error: `Demo buying power cannot cover this order. Available buying power ${moneyLabel(buyingPowerPaise)}. Required funds ${moneyLabel(requiredPaise)}. Shortfall ${moneyLabel(shortfallPaise)}.${reservedNote}${indexNote} Reduce the quantity, close a position, or reset the paper book.`,
  };
}

export function maxBuyQuantity(book: DemoBook, priceRupees: number, marks: Record<string, number> = {}): number {
  if (!Number.isFinite(priceRupees) || priceRupees <= 0) return 0;
  const pricePaise = Number(rupeesToPaise(priceRupees.toFixed(2)));
  let quantity = Math.floor(Math.max(0, buyingPower(book, marks)) / pricePaise);
  while (quantity > 0 && !fundsForBuy(book, priceRupees, quantity, marks).ok) quantity -= 1;
  return quantity;
}

export function positionResult(position: DemoPosition, markPaise: number | null): { pnlPaise: number; percent: number | null; valuePaise: number; basisPaise: number } | null {
  if (markPaise == null || !Number.isFinite(markPaise) || markPaise <= 0) return null;
  const pnlPaise = (markPaise - position.avgPaise) * position.quantity;
  const basisPaise = position.avgPaise * Math.abs(position.quantity);
  return { pnlPaise, percent: basisPaise ? (pnlPaise / basisPaise) * 100 : null, valuePaise: markPaise * Math.abs(position.quantity), basisPaise };
}

function moneyLabel(paise: number): string {
  return formatInr(BigInt(Math.round(paise)));
}

function recordOrder(book: DemoBook, order: DemoOrder, next: DemoBook, reason = "Filled on the replay candle.", candleTime = order.time): DemoBook {
  const armed = next.positions.find((item) => item.symbol === order.symbol);
  const levels = armed ? saneProtection(armed.quantity, armed.avgPaise, order.stopLossPaise ?? null, order.takeProfitPaise ?? null) : null;
  const withProtection = armed && levels && (levels.stopPaise || levels.targetPaise)
    ? {
        ...next,
        positions: next.positions.map((item) => item.symbol === order.symbol ? { ...item, stopPaise: levels.stopPaise, targetPaise: levels.targetPaise, armedAt: candleTime + 60 } : item),
      }
    : next;
  return { ...withProtection, orders: [...book.orders.filter((item) => item.id !== order.id), { ...order, status: "FILLED", reason }] };
}

type FillRequest = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  pricePaise: number;
  time: number;
  allowShort: boolean;
  exitReason: ExitReason;
  sessionDate: string;
  timeframe: string;
};

function commitFill(book: DemoBook, fill: FillRequest): { ok: true; book: DemoBook } | { ok: false; error: string } {
  const position = book.positions.find((item) => item.symbol === fill.symbol) ?? null;
  const held = position?.quantity ?? 0;
  const delta = fill.side === "BUY" ? fill.quantity : -fill.quantity;
  const nextQty = held + delta;
  if (held >= 0 && nextQty < 0 && !fill.allowShort) return { ok: false, error: "Sell quantity is above the demo shares you hold." };
  if (held < 0 && nextQty < held && !fill.allowShort) return { ok: false, error: "Short selling is off. Cover the short, or turn short selling on." };
  const closing = held !== 0 && Math.sign(held) !== Math.sign(delta) ? Math.min(Math.abs(held), Math.abs(delta)) : 0;
  const opening = fill.quantity - closing;
  let cash = book.cashPaise;
  let realized = book.realizedPaise;
  let trades = book.trades;
  let avg = position?.avgPaise ?? 0;
  let openCharges = position?.openChargesPaise ?? 0;
  let entryTime = position?.entryTime ?? fill.time;
  let stop = position?.stopPaise ?? null;
  let target = position?.targetPaise ?? null;
  let armedAt = position?.armedAt ?? 0;
  let chargeTotal = 0;
  const spendable = () => cash - openBuyReserve(book) - shortMargin({ ...book, positions: book.positions.filter((item) => item.symbol !== fill.symbol) });

  if (closing > 0 && held > 0) {
    const closeCharge = chargePaise("SELL", fill.pricePaise, closing);
    const allocated = Math.round(openCharges * closing / held);
    const gross = (fill.pricePaise - avg) * closing;
    const net = gross - allocated - closeCharge;
    cash += fill.pricePaise * closing - closeCharge;
    realized += net;
    openCharges -= allocated;
    chargeTotal += closeCharge;
    trades = [...trades, tradeRow(fill, "LONG", closing, avg, entryTime, gross, allocated + closeCharge, net)];
  }
  if (closing > 0 && held < 0) {
    const closeCharge = chargePaise("BUY", fill.pricePaise, closing);
    const cost = fill.pricePaise * closing + closeCharge;
    if (cost > cash) return { ok: false, error: "Demo buying power cannot cover this cover." };
    const allocated = Math.round(openCharges * closing / Math.abs(held));
    const gross = (avg - fill.pricePaise) * closing;
    const net = gross - allocated - closeCharge;
    cash -= cost;
    realized += net;
    openCharges -= allocated;
    chargeTotal += closeCharge;
    trades = [...trades, tradeRow(fill, "SHORT", closing, avg, entryTime, gross, allocated + closeCharge, net)];
  }
  if (opening > 0 && fill.side === "BUY") {
    const openCharge = chargePaise("BUY", fill.pricePaise, opening);
    const cost = fill.pricePaise * opening + openCharge;
    if (cost > spendable()) return { ok: false, error: "Demo buying power cannot cover this fill." };
    cash -= cost;
    chargeTotal += openCharge;
    if (held > closing) {
      const remain = held - closing;
      avg = Math.round((avg * remain + fill.pricePaise * opening) / (remain + opening));
      openCharges += openCharge;
    } else {
      avg = fill.pricePaise;
      openCharges = openCharge;
      entryTime = fill.time;
      stop = null;
      target = null;
      armedAt = 0;
    }
  }
  if (opening > 0 && fill.side === "SELL") {
    const openCharge = chargePaise("SELL", fill.pricePaise, opening);
    if (openCharge > spendable()) return { ok: false, error: "Demo buying power cannot cover this short." };
    cash += fill.pricePaise * opening - openCharge;
    chargeTotal += openCharge;
    if (held < 0 && Math.abs(held) > closing) {
      const remain = Math.abs(held) - closing;
      avg = Math.round((avg * remain + fill.pricePaise * opening) / (remain + opening));
      openCharges += openCharge;
    } else {
      avg = fill.pricePaise;
      openCharges = openCharge;
      entryTime = fill.time;
      stop = null;
      target = null;
      armedAt = 0;
    }
  }
  const quantity = held + delta;
  const positions = quantity === 0
    ? book.positions.filter((item) => item.symbol !== fill.symbol)
    : book.positions.some((item) => item.symbol === fill.symbol)
      ? book.positions.map((item) => item.symbol === fill.symbol ? { symbol: fill.symbol, quantity, avgPaise: avg, stopPaise: quantity === 0 ? null : stop, targetPaise: quantity === 0 ? null : target, armedAt, entryTime, openChargesPaise: openCharges } : item)
      : [...book.positions, { symbol: fill.symbol, quantity, avgPaise: avg, stopPaise: stop, targetPaise: target, armedAt, entryTime, openChargesPaise: openCharges }];
  return {
    ok: true,
    book: {
      ...book,
      cashPaise: cash,
      realizedPaise: realized,
      positions,
      trades,
      fills: [...book.fills, { id: fill.id, symbol: fill.symbol, side: fill.side, quantity: fill.quantity, pricePaise: fill.pricePaise, time: fill.time, chargesPaise: chargeTotal, exitReason: fill.exitReason, sessionDate: fill.sessionDate, timeframe: fill.timeframe }],
    },
  };
}

function tradeRow(fill: FillRequest, side: "LONG" | "SHORT", quantity: number, entryPaise: number, entryTime: number, grossPaise: number, chargesPaise: number, netPaise: number): DemoTrade {
  return {
    id: `${fill.id}-${side.toLowerCase()}-${fill.time}`,
    symbol: fill.symbol,
    side,
    quantity,
    entryPaise,
    exitPaise: fill.pricePaise,
    entryTime,
    exitTime: fill.time,
    grossPaise,
    chargesPaise,
    netPaise,
    exitReason: fill.exitReason,
    sessionDate: fill.sessionDate,
    timeframe: fill.timeframe,
  };
}

function asPaise(price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  return Number(rupeesToPaise(price.toFixed(2)));
}

function saneProtection(quantity: number, basisPaise: number, stop: number | null, target: number | null): { stopPaise: number | null; targetPaise: number | null } {
  if (quantity > 0) return { stopPaise: stop != null && stop < basisPaise ? stop : null, targetPaise: target != null && target > basisPaise ? target : null };
  if (quantity < 0) return { stopPaise: stop != null && stop > basisPaise ? stop : null, targetPaise: target != null && target < basisPaise ? target : null };
  return { stopPaise: null, targetPaise: null };
}

export function placeDemoOrder(
  book: DemoBook,
  input: {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    type: DemoOrderType;
    quantity: number;
    limitPrice: number | null;
    stopPrice?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
    candle: DemoCandle | null;
    playheadTime: number | null;
    revealTime: number | null;
    paused: boolean;
    sessionDate?: string;
    timeframe?: string;
    product?: "equity" | "index";
    marks?: Record<string, number>;
  },
): { ok: true; book: DemoBook } | { ok: false; error: string } {
  if (DEMO_ORDER_ROUTE !== null) return { ok: false, error: "Demo orders have no route." };
  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol || !Number.isInteger(input.quantity) || input.quantity <= 0) return { ok: false, error: "Enter a whole number of shares." };
  const current = readyBook(book);
  const limitPaise = input.type === "LIMIT" || input.type === "STOP_LIMIT" ? asPaise(input.limitPrice) : null;
  const stopPaise = input.type === "STOP" || input.type === "STOP_LIMIT" ? asPaise(input.stopPrice) : null;
  if ((input.type === "LIMIT" || input.type === "STOP_LIMIT") && limitPaise == null) return { ok: false, error: "Enter a limit price in rupees." };
  if ((input.type === "STOP" || input.type === "STOP_LIMIT") && stopPaise == null) return { ok: false, error: "Enter a stop trigger in rupees." };
  const draft: DemoOrder = {
    id: input.id,
    symbol,
    side: input.side,
    type: input.type,
    quantity: input.quantity,
    limitPaise,
    stopPaise,
    stopLossPaise: asPaise(input.stopLoss),
    takeProfitPaise: asPaise(input.takeProfit),
    status: "OPEN",
    reason: "",
    time: input.playheadTime ?? 0,
    sessionDate: input.sessionDate,
    timeframe: input.timeframe,
  };
  const held = current.positions.find((item) => item.symbol === symbol)?.quantity ?? 0;
  if (input.side === "SELL" && input.quantity > Math.max(0, held) - openSellQty(current, symbol) && !current.allowShort) {
    return { ok: false, error: "Sell quantity is above the demo shares you hold. Turn short selling on to open a short." };
  }
  const revealedNow = input.candle != null && input.playheadTime != null && input.playheadTime >= input.candle.time && input.playheadTime <= input.candle.time + 60 && (input.revealTime == null || input.playheadTime <= input.revealTime);
  const quote = revealedNow ? executionPrice(input.type, input.side, input.candle, limitPaise, stopPaise) : null;
  if (input.side === "BUY") {
    const reserveRupees = quote?.price ?? (limitPaise != null ? limitPaise / 100 : stopPaise != null ? stopPaise / 100 : input.candle?.close ?? 0);
    if (reserveRupees > 0) {
      const funds = fundsForBuy(current, reserveRupees, input.quantity, input.marks ?? {}, input.product ?? "equity", symbol);
      if (!funds.ok) return { ok: false, error: funds.error };
    }
  }
  if (!quote) {
    const waiting = input.type === "MARKET" ? "Demo mode has no candle at the replay time." : input.paused ? "Waiting. Playback is paused." : "Waiting for the replay candle.";
    if (input.type === "MARKET" || !input.playheadTime) return { ok: false, error: "Demo mode has no candle at the replay time." };
    return { ok: true, book: { ...current, orders: [...current.orders, { ...draft, reason: waiting }] } };
  }
  const filled = applyDemoFill(current, {
    id: input.id,
    symbol,
    side: input.side,
    quantity: input.quantity,
    candle: { ...input.candle!, close: quote.price },
    playheadTime: input.playheadTime!,
    revealTime: input.revealTime ?? input.playheadTime!,
    allowShort: current.allowShort,
    exitReason: input.type === "LIMIT" ? "limit" : input.type === "STOP" || input.type === "STOP_LIMIT" ? "stop-order" : "manual",
    sessionDate: input.sessionDate,
    timeframe: input.timeframe,
  });
  if (!filled.ok) return filled;
  return { ok: true, book: recordOrder(current, draft, filled.book, quote.reason, input.candle!.time) };
}

function touches(candle: DemoCandle | null, side: "BUY" | "SELL", limitPaise: number): boolean {
  if (!candle || limitPaise <= 0) return false;
  const limit = limitPaise / 100;
  return side === "BUY" ? candle.low <= limit : candle.high >= limit;
}

function revealedRange(candle: DemoCandle, playheadTime: number, revealTime: number): { open: number; high: number; low: number } | null {
  if (playheadTime < candle.time || playheadTime > candle.time + 60 || playheadTime > revealTime) return null;
  return { open: candle.open, high: candle.high, low: candle.low };
}

function executionPrice(type: DemoOrderType, side: "BUY" | "SELL", candle: DemoCandle | null, limitPaise: number | null, stopPaise: number | null): { price: number; reason: string } | null {
  if (!candle) return null;
  if (type === "MARKET") return { price: candle.close, reason: "Filled at the revealed replay price." };
  if (type === "LIMIT" && limitPaise != null && touches(candle, side, limitPaise)) return { price: limitPaise / 100, reason: "Filled at the limit." };
  if ((type === "STOP" || type === "STOP_LIMIT") && stopPaise != null) {
    const trigger = stopPaise / 100;
    const crossed = side === "BUY" ? candle.high >= trigger : candle.low <= trigger;
    if (!crossed) return null;
    const gap = side === "BUY" ? candle.open >= trigger : candle.open <= trigger;
    if (type === "STOP") return { price: gap ? candle.open : trigger, reason: gap ? "Stop filled at the open after a gap." : "Stop filled at the trigger." };
    if (limitPaise == null) return null;
    const limit = limitPaise / 100;
    const openBeyond = side === "BUY" ? candle.open > limit : candle.open < limit;
    if (openBeyond) return null;
    const limitReached = candle.low <= limit && limit <= candle.high;
    if (!limitReached && !gap) return null;
    return { price: gap ? candle.open : limit, reason: gap ? "Stop-limit filled at the open." : "Stop-limit filled at the limit." };
  }
  return null;
}

export function settleDemoOrders(book: DemoBook, symbol: string, candle: DemoCandle, playheadTime: number, revealTime: number, sessionDate = ""): DemoBook {
  const range = revealedRange(candle, playheadTime, revealTime);
  if (!range) return book;
  const view: DemoCandle = { ...candle, open: range.open, high: range.high, low: range.low };
  let next = readyBook(book);
  let changed = false;
  for (const order of [...next.orders]) {
    if (order.status !== "OPEN" || order.symbol !== symbol) continue;
    if (sessionDate && order.sessionDate && order.sessionDate !== sessionDate) continue;
    const triggered = order.type === "STOP_LIMIT" && order.reason.startsWith("Stop triggered");
    const quote = executionPrice(triggered ? "LIMIT" : order.type, order.side, view, order.limitPaise ?? null, order.stopPaise ?? null);
    if (!quote && order.type === "STOP_LIMIT" && !triggered && order.stopPaise != null) {
      const trigger = order.stopPaise / 100;
      const crossed = order.side === "BUY" ? view.high >= trigger : view.low <= trigger;
      if (crossed) {
        next = { ...next, orders: next.orders.map((item) => item.id === order.id ? { ...item, reason: "Stop triggered. Waiting for the limit." } : item) };
        changed = true;
      }
      continue;
    }
    if (!quote) continue;
    const filled = applyDemoFill(next, fillFrom(order, quote.price, candle.time, playheadTime, revealTime, order.type === "LIMIT" ? "limit" : order.type === "MARKET" ? "manual" : "stop-order", next.allowShort));
    if (!filled.ok) {
      next = { ...next, orders: next.orders.map((item) => item.id === order.id ? { ...item, status: "REJECTED", reason: filled.error } : item) };
      changed = true;
      continue;
    }
    next = recordOrder(next, order, filled.book, quote.reason, candle.time);
    changed = true;
  }
  const protectedBook = applyProtection(next, symbol, view, playheadTime, revealTime, sessionDate);
  if (protectedBook !== next) {
    next = protectedBook;
    changed = true;
  }
  return changed ? next : book;
}

function fillFrom(order: DemoOrder, price: number, candleTime: number, playheadTime: number, revealTime: number, exitReason: ExitReason, allowShort: boolean) {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    candle: { time: candleTime, open: price, high: price, low: price, close: price, volume: 0 },
    playheadTime,
    revealTime,
    allowShort,
    exitReason,
    sessionDate: order.sessionDate,
    timeframe: order.timeframe,
  };
}

function applyProtection(book: DemoBook, symbol: string, candle: DemoCandle, playheadTime: number, revealTime: number, sessionDate: string): DemoBook {
  const position = book.positions.find((item) => item.symbol === symbol);
  if (!position || candle.time < (position.armedAt ?? 0)) return book;
  const exit = protectiveExit(position, candle);
  if (!exit) return book;
  const filled = commitFill(book, {
    id: `${position.symbol}-${exit.reason}-${candle.time}`,
    symbol,
    side: position.quantity > 0 ? "SELL" : "BUY",
    quantity: Math.abs(position.quantity),
    pricePaise: Number(rupeesToPaise(exit.price.toFixed(2))),
    time: playheadTime,
    allowShort: false,
    exitReason: exit.reason,
    sessionDate: sessionDate || istDay(playheadTime),
    timeframe: "",
  });
  if (!filled.ok) return book;
  return {
    ...filled.book,
    orders: [...filled.book.orders, {
      id: `${position.symbol}-${exit.reason}-${candle.time}`,
      symbol,
      side: position.quantity > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: Math.abs(position.quantity),
      limitPaise: null,
      status: "FILLED",
      reason: exit.reason === "stop" ? "Stop-loss filled. When a candle reaches both the stop and the target, the stop is used." : "Target filled.",
      time: playheadTime,
      sessionDate,
    }],
  };
}

function protectiveExit(position: DemoPosition, candle: DemoCandle): { reason: "stop" | "target"; price: number } | null {
  const short = position.quantity < 0;
  const stop = position.stopPaise != null ? position.stopPaise / 100 : null;
  const target = position.targetPaise != null ? position.targetPaise / 100 : null;
  const openThroughStop = stop != null && (short ? candle.open >= stop : candle.open <= stop);
  const openThroughTarget = target != null && (short ? candle.open <= target : candle.open >= target);
  if (openThroughStop && stop != null) return { reason: "stop", price: candle.open };
  if (openThroughTarget && target != null) return { reason: "target", price: candle.open };
  const stopIn = stop != null && candle.low <= stop && stop <= candle.high;
  const targetIn = target != null && candle.low <= target && target <= candle.high;
  if (stopIn && targetIn && stop != null) return { reason: "stop", price: stop };
  if (stopIn && stop != null) return { reason: "stop", price: stop };
  if (targetIn && target != null) return { reason: "target", price: target };
  return null;
}

export function setDemoProtection(book: DemoBook, symbol: string, stopPrice: number | null, targetPrice: number | null, mark: number, armAt: number): { ok: true; book: DemoBook } | { ok: false; error: string } {
  const current = readyBook(book);
  const position = current.positions.find((item) => item.symbol === symbol);
  if (!position) return { ok: false, error: "There is no open demo position for this symbol." };
  if (!Number.isFinite(mark) || mark <= 0) return { ok: false, error: "The replay price is not available." };
  const markPaise = Number(rupeesToPaise(mark.toFixed(2)));
  const stop = asPaise(stopPrice);
  const target = asPaise(targetPrice);
  if (stopPrice != null && stop == null) return { ok: false, error: "Enter a stop price in rupees." };
  if (targetPrice != null && target == null) return { ok: false, error: "Enter a target price in rupees." };
  const levels = saneProtection(position.quantity, markPaise, stop, target);
  if (stop != null && levels.stopPaise == null) return { ok: false, error: position.quantity > 0 ? "A long stop must be below the replay price." : "A short stop must be above the replay price." };
  if (target != null && levels.targetPaise == null) return { ok: false, error: position.quantity > 0 ? "A long target must be above the replay price." : "A short target must be below the replay price." };
  return {
    ok: true,
    book: {
      ...current,
      positions: current.positions.map((item) => item.symbol === symbol ? { ...item, stopPaise: levels.stopPaise, targetPaise: levels.targetPaise, armedAt: armAt } : item),
    },
  };
}

export function setAllowShort(book: DemoBook, allowShort: boolean): DemoBook {
  return { ...readyBook(book), allowShort };
}

export function demoAccount(book: DemoBook, marksPaise: Record<string, number>) {
  const current = readyBook(book);
  const marketValue = current.positions.reduce((sum, position) => sum + position.quantity * (Number.isFinite(marksPaise[position.symbol]) ? marksPaise[position.symbol] : position.avgPaise), 0);
  const unrealized = demoUnrealized(current, marksPaise);
  const reserved = reservedFunds(current, marksPaise);
  const charges = current.fills.reduce((sum, fill) => sum + (fill.chargesPaise || 0), 0);
  return {
    startPaise: current.startPaise,
    cashPaise: current.cashPaise,
    reservedPaise: reserved,
    marketValuePaise: marketValue,
    unrealizedPaise: unrealized,
    realizedPaise: current.realizedPaise,
    equityPaise: current.cashPaise + marketValue,
    buyingPowerPaise: current.cashPaise - reserved,
    chargesPaise: charges,
  };
}

export function practiceStats(trades: DemoTrade[], startPaise: number) {
  const wins = trades.filter((trade) => trade.netPaise > 0);
  const losses = trades.filter((trade) => trade.netPaise < 0);
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.grossPaise), 0);
  const grossLoss = trades.reduce((sum, trade) => sum + Math.min(0, trade.grossPaise), 0);
  const net = trades.reduce((sum, trade) => sum + trade.netPaise, 0);
  let equity = startPaise;
  let peak = startPaise;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPaise;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    grossProfit,
    grossLoss,
    net,
    largestWin: wins.reduce((best, trade) => Math.max(best, trade.netPaise), 0),
    largestLoss: losses.reduce((worst, trade) => Math.min(worst, trade.netPaise), 0),
    maxDrawdown,
    endingEquity: equity,
  };
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
