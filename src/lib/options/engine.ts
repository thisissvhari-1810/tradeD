import { vwap } from "@/lib/market/indicators";

/** No options order is ever sent to a broker. This stays null on purpose. */
export const LIVE_BROKER_ORDER_URL: null = null;

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type OptionRight = "CE" | "PE";

export type OptionContract = {
  side: OptionRight;
  strike: number;
  expiry: string;
  lotSize: number;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  oi: number | null;
  iv: number | null;
};

export type SignalConfig = {
  swingLookback: number;
  volumeMultiple: number;
  volumeLookback: number;
  trendPeriod: number;
  minRewardRisk: number;
  stopFraction: number;
  targetFraction: number;
  maxSpread: number;
  minVolume: number;
  minOi: number;
  minDaysToExpiry: number;
  maxDaysToExpiry: number;
  slippageBps: number;
};

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  swingLookback: 8,
  volumeMultiple: 1.2,
  volumeLookback: 10,
  trendPeriod: 8,
  minRewardRisk: 1.2,
  stopFraction: 0.7,
  targetFraction: 1.4,
  maxSpread: 0.08,
  minVolume: 1,
  minOi: 1,
  minDaysToExpiry: 1,
  maxDaysToExpiry: 14,
  slippageBps: 10,
};

export type Signal = {
  timestamp: string;
  dataTimestamp: string;
  underlying: number;
  direction: OptionRight | "NO TRADE";
  contractKey: string | null;
  contract: OptionContract | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskRupees: number | null;
  rewardRupees: number | null;
  maxPremiumRupees: number | null;
  ruleScore: number;
  scoreNote: string;
  reasons: string[];
  rejections: string[];
  quality: "exchange" | "modelled";
};

export type RiskInput = {
  equityPaise: bigint;
  dayEntries: number;
  openPositions: number;
  dayRealizedPaise: bigint;
  stale: boolean;
  minutesIst: number;
  premiumPaise: bigint;
  quantity: number;
  chargesPaise: bigint;
  sameContractOpen: boolean;
};

export type RiskDecision = {
  ok: boolean;
  reasons: string[];
  budgetPaise: bigint;
  dailyLossLimitPaise: bigint;
  remainingLossPaise: bigint;
};

export const RISK_LIMITS = {
  riskFraction: 0.005,
  maxEntriesPerDay: 3,
  maxOpenPositions: 1,
  dailyLossFraction: 0.01,
  entryStartMinute: 9 * 60 + 15,
  entryStopMinute: 15 * 60,
  flattenMinute: 15 * 60 + 15,
};

export function istDayKeyFromUnix(seconds: number) {
  return new Date((seconds + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
}

export function istMinutes(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return read("hour") * 60 + read("minute");
}

export function istDayKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function dropFormingBar(candles: Bar[], nowSec: number, barSec: number) {
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  if (nowSec < last.time + barSec) return candles.slice(0, -1);
  return candles;
}

export function sessionBars(bars: Bar[]) {
  if (!bars.length) return bars;
  const day = istDayKeyFromUnix(bars[bars.length - 1].time);
  return bars.filter((bar) => istDayKeyFromUnix(bar.time) === day);
}

export function contractKey(contract: Pick<OptionContract, "expiry" | "strike" | "side">) {
  return `NIFTY|${contract.expiry}|${contract.strike}|${contract.side}`;
}

export function modelledPremium(spot: number, strike: number, side: OptionRight, days: number, iv = 0.14) {
  const intrinsic = side === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const timeValue = spot * iv * Math.sqrt(Math.max(days, 0.25) / 365) * 0.4;
  const distance = Math.abs(spot - strike) / Math.max(spot, 1);
  return Math.max(0.05, intrinsic + timeValue * Math.exp(-distance * 8));
}

export function modelChain(spot: number, day: string, lotSize: number, days = 7): OptionContract[] {
  const expiryDate = new Date(`${day}T00:00:00Z`);
  expiryDate.setUTCDate(expiryDate.getUTCDate() + days);
  const expiry = expiryDate.toISOString().slice(0, 10);
  const step = 50;
  const center = Math.round(spot / step) * step;
  const contracts: OptionContract[] = [];
  for (let strike = center - step * 4; strike <= center + step * 4; strike += step) {
    for (const side of ["CE", "PE"] as const) {
      const mid = modelledPremium(spot, strike, side, days);
      const spread = mid * 0.02;
      contracts.push({
        side,
        strike,
        expiry,
        lotSize,
        ltp: roundRupee(mid),
        bid: roundRupee(mid - spread / 2),
        ask: roundRupee(mid + spread / 2),
        volume: 10_000,
        oi: 50_000,
        iv: 0.14,
      });
    }
  }
  return contracts;
}

export function sampleBreakoutBars(count = 40): Bar[] {
  const start = 1_700_000_000;
  const bars: Bar[] = [];
  let price = 24_400;
  for (let index = 0; index < count; index += 1) {
    const drift = index > count - 3 ? 18 : 2;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + 4;
    const low = Math.min(open, close) - 3;
    bars.push({ time: start + index * 300, open, high, low, close, volume: index === count - 1 ? 8_000 : 1_000 });
    price = close;
  }
  return bars;
}

export function evaluateSignal(input: {
  candles5: Bar[];
  candles15: Bar[];
  chain: OptionContract[];
  spot: number;
  timestamp: string;
  dataTimestamp: string;
  quality: "exchange" | "modelled";
  nowDay: string;
  config?: Partial<SignalConfig>;
}): Signal {
  const config = { ...DEFAULT_SIGNAL_CONFIG, ...input.config };
  const reasons: string[] = [];
  const rejections: string[] = [];
  const base = {
    timestamp: input.timestamp,
    dataTimestamp: input.dataTimestamp,
    underlying: input.spot,
    quality: input.quality,
    scoreNote: "Rule score only. It is not a calibrated probability and it does not predict the next price.",
  };
  if (input.quality === "modelled") reasons.push("Option premiums are modelled samples, not NSE quotes. A fill on this book is simulated.");
  const bars = input.candles5;
  if (bars.length < config.swingLookback + 1 || input.candles15.length < config.trendPeriod + 1) {
    rejections.push("Not enough closed candles for the swing and the 15-minute trend.");
    return finish(base, "NO TRADE", null, null, reasons, rejections, 0);
  }
  const bar = bars[bars.length - 1];
  const prior = bars.slice(bars.length - 1 - config.swingLookback, bars.length - 1);
  const swingHigh = Math.max(...prior.map((item) => item.high));
  const swingLow = Math.min(...prior.map((item) => item.low));
  const vwapLine = vwap(bars);
  const lastVwap = vwapLine[vwapLine.length - 1];
  const volumeBase = bars.slice(bars.length - 1 - config.volumeLookback, bars.length - 1);
  const averageVolume = volumeBase.reduce((sum, item) => sum + item.volume, 0) / Math.max(1, volumeBase.length);
  const closes15 = input.candles15.map((item) => item.close);
  const trendStart = closes15.length - config.trendPeriod;
  const trendAverage = closes15.slice(trendStart).reduce((sum, value) => sum + value, 0) / config.trendPeriod;
  const last15 = input.candles15[input.candles15.length - 1];
  const prev15 = input.candles15[input.candles15.length - 2];
  const bullish = bar.close > swingHigh && lastVwap != null && bar.close > lastVwap && last15.close > trendAverage && last15.close > prev15.close && bar.volume >= averageVolume * config.volumeMultiple;
  const bearish = bar.close < swingLow && lastVwap != null && bar.close < lastVwap && last15.close < trendAverage && last15.close < prev15.close && bar.volume >= averageVolume * config.volumeMultiple;
  let passed = 0;
  const checks = 5;
  if (bullish || bearish) passed += 1;
  if (lastVwap != null && ((bullish && bar.close > lastVwap) || (bearish && bar.close < lastVwap))) passed += 1;
  if ((bullish && last15.close > trendAverage) || (bearish && last15.close < trendAverage)) passed += 1;
  if (bar.volume >= averageVolume * config.volumeMultiple) passed += 1;
  const side: OptionRight | null = bullish ? "CE" : bearish ? "PE" : null;
  if (!side) {
    rejections.push("The closed 5-minute bar did not break the recent swing with VWAP, 15-minute trend, and volume all agreeing.");
    return finish(base, "NO TRADE", null, null, reasons, rejections, passed / checks);
  }
  reasons.push(side === "CE"
    ? `Closed 5-minute bar ${bar.close.toFixed(2)} broke the swing high ${swingHigh.toFixed(2)} above VWAP.`
    : `Closed 5-minute bar ${bar.close.toFixed(2)} broke the swing low ${swingLow.toFixed(2)} below VWAP.`);
  reasons.push(`15-minute close ${last15.close.toFixed(2)} confirms the ${side === "CE" ? "bullish" : "bearish"} side of its ${config.trendPeriod}-bar average.`);
  const contract = pickContract(input.chain, side, input.spot, input.nowDay, config, rejections);
  if (!contract || contract.ask == null || contract.bid == null) {
    rejections.push("No liquid contract had both a bid and an ask inside the expiry and spread limits.");
    return finish(base, "NO TRADE", contract, null, reasons, rejections, passed / checks);
  }
  passed += 1;
  const entry = contract.ask;
  const stop = roundRupee(entry * config.stopFraction);
  const target = roundRupee(entry * config.targetFraction);
  const quantity = contract.lotSize;
  const risk = (entry - stop) * quantity;
  const reward = (target - entry) * quantity;
  const entryCharges = Number(optionCharges("BUY", rupeePaise(entry), quantity).total) / 100;
  const exitCharges = Number(optionCharges("SELL", rupeePaise(target), quantity).total) / 100;
  const costs = entryCharges + exitCharges;
  const netReward = reward - costs;
  const netRisk = risk + costs;
  reasons.push(`Assumed entry is the ask ${entry.toFixed(2)}, not the last price. Stop ${stop.toFixed(2)} and target ${target.toFixed(2)} are premium levels. A stop is not guaranteed to fill.`);
  if (!(netRisk > 0) || netReward / netRisk < config.minRewardRisk) {
    rejections.push("After estimated costs, the reward does not cover the required multiple of the premium risk.");
    return finish(base, "NO TRADE", contract, { entry, stop, target, risk, reward, maxPremium: entry * quantity + costs }, reasons, rejections, passed / (checks + 1));
  }
  reasons.push(`Estimated premium risk ₹${risk.toFixed(2)} and reward ₹${reward.toFixed(2)} before the full-premium cap.`);
  return finish(base, side, contract, { entry, stop, target, risk, reward, maxPremium: entry * quantity + entryCharges }, reasons, rejections, passed / (checks + 1));
}

export function longOptionMaxLoss(premiumPaise: bigint, quantity: number, chargesPaise: bigint) {
  if (premiumPaise < 0n || chargesPaise < 0n || quantity < 1) throw new Error("Premium exposure must be positive.");
  return premiumPaise * BigInt(quantity) + chargesPaise;
}

export function evaluateRisk(input: RiskInput): RiskDecision {
  const budgetPaise = bigintPercent(input.equityPaise, RISK_LIMITS.riskFraction);
  const dailyLossLimitPaise = bigintPercent(input.equityPaise, RISK_LIMITS.dailyLossFraction);
  const lossSoFar = input.dayRealizedPaise < 0n ? -input.dayRealizedPaise : 0n;
  const remainingLossPaise = dailyLossLimitPaise > lossSoFar ? dailyLossLimitPaise - lossSoFar : 0n;
  const reasons: string[] = [];
  if (input.stale) reasons.push("Market data is stale. New options entries are blocked.");
  if (input.minutesIst < RISK_LIMITS.entryStartMinute || input.minutesIst >= RISK_LIMITS.entryStopMinute) reasons.push("New entries are allowed only from 09:15 to 15:00 IST.");
  if (input.dayEntries >= RISK_LIMITS.maxEntriesPerDay) reasons.push("The daily entry limit of 3 is already used.");
  if (input.openPositions >= RISK_LIMITS.maxOpenPositions) reasons.push("Only one simulated options position can be open.");
  if (input.sameContractOpen) reasons.push("Adding to an open option is not allowed.");
  if (lossSoFar >= dailyLossLimitPaise) reasons.push("The 1% daily loss limit is reached.");
  const exposure = longOptionMaxLoss(input.premiumPaise, input.quantity, input.chargesPaise);
  if (exposure > budgetPaise) reasons.push("The premium paid, plus charges, is larger than 0.5% of simulated options equity. The stop does not reduce this cap.");
  return { ok: reasons.length === 0, reasons, budgetPaise, dailyLossLimitPaise, remainingLossPaise };
}

export function optionCharges(side: "BUY" | "SELL", premiumPaise: bigint, quantity: number) {
  const turnover = premiumPaise * BigInt(quantity);
  const brokerage = 2_000n;
  const exchange = bps(turnover, 5);
  const sebi = bps(turnover, 1);
  const stamp = side === "BUY" ? bps(turnover, 3) : 0n;
  const stt = side === "SELL" ? bps(turnover, 6) : 0n;
  const gst = (brokerage + exchange) * 18n / 100n;
  const total = brokerage + exchange + sebi + stamp + stt + gst;
  return { brokerage, exchange, sebi, stamp, stt, gst, total, note: "Educational options charge estimate. It will not match a broker contract note." };
}

export function slippedPaise(rupees: number, bpsMove: number, side: "BUY" | "SELL") {
  const paise = rupeePaise(rupees);
  const bump = (paise * BigInt(bpsMove) + 5_000n) / 10_000n;
  const next = side === "BUY" ? paise + bump : paise - bump;
  return next > 0n ? next : 1n;
}

export function decideOptionOrder(input: {
  action: "BUY" | "CLOSE";
  signal: Signal | null;
  risk: RiskDecision | null;
  contract: OptionContract | null;
  cashPaise: bigint;
  openContractKey: string | null;
  lots: number;
  slippageBps: number;
}) {
  if (input.lots !== 1) return { ok: false as const, reason: "This practice book allows one lot at a time." };
  if (input.action === "CLOSE") {
    if (!input.openContractKey || !input.contract) return { ok: false as const, reason: "There is no open simulated option to close." };
    if (contractKey(input.contract) !== input.openContractKey) return { ok: false as const, reason: "The close does not match the open contract." };
    if (input.contract.bid == null) return { ok: false as const, reason: "No bid. The close is not filled at the last price." };
    const fill = slippedPaise(input.contract.bid, input.slippageBps, "SELL");
    const charges = optionCharges("SELL", fill, input.contract.lotSize).total;
    return { ok: true as const, fillPaise: fill, quantity: input.contract.lotSize, chargesPaise: charges, simulated: true as const };
  }
  if (!input.signal || input.signal.direction === "NO TRADE" || !input.signal.contract) return { ok: false as const, reason: "The rule engine did not accept a trade." };
  if (!input.risk?.ok) return { ok: false as const, reason: input.risk?.reasons[0] ?? "The risk engine blocked the entry." };
  if (!input.contract || contractKey(input.contract) !== input.signal.contractKey) return { ok: false as const, reason: "Only the contract selected by the signal can be bought." };
  if (input.contract.ask == null) return { ok: false as const, reason: "No ask. The entry is not filled at the last price." };
  const fill = slippedPaise(input.contract.ask, input.slippageBps, "BUY");
  const charges = optionCharges("BUY", fill, input.contract.lotSize).total;
  const debit = fill * BigInt(input.contract.lotSize) + charges;
  if (debit > input.cashPaise) return { ok: false as const, reason: "Simulated options cash cannot pay the premium and charges." };
  return { ok: true as const, fillPaise: fill, quantity: input.contract.lotSize, chargesPaise: charges, simulated: true as const };
}

export type BacktestTrade = { entryTime: number; exitTime: number; side: OptionRight; strike: number; net: number; regime: "quiet" | "active" };

export function backtestOptions(input: {
  candles5: Bar[];
  candles15: Bar[];
  lotSize: number;
  equityRupees: number;
  config?: Partial<SignalConfig>;
}) {
  const config = { ...DEFAULT_SIGNAL_CONFIG, ...input.config };
  const cut = Math.floor(input.candles5.length * 0.6);
  return {
    premiumSource: "modelled" as const,
    note: "Premiums in this test are modelled from the index. They are not historical NSE option trades. The test window is the later 40% of bars and was not used to choose the thresholds.",
    inSample: runBacktest(input.candles5.slice(0, Math.max(cut, 1)), input.candles15, input.lotSize, input.equityRupees, config, "in-sample"),
    test: runBacktest(input.candles5.slice(cut), input.candles15, input.lotSize, input.equityRupees, config, "test"),
  };
}

export function runBacktest(candles5: Bar[], candles15: Bar[], lotSize: number, equityRupees: number, config: SignalConfig, window: "in-sample" | "test") {
  const ranges = candles5.map((bar) => bar.high - bar.low).sort((a, b) => a - b);
  const medianRange = ranges[Math.floor(ranges.length / 2)] ?? 0;
  let equity = equityRupees;
  let peak = equity;
  let maxDrawdown = 0;
  let open: { side: OptionRight; strike: number; expiry: string; entry: number; stop: number; target: number; entryTime: number; charges: number } | null = null;
  const trades: BacktestTrade[] = [];
  let dayEntries = 0;
  let day = "";
  let dayRealized = 0;
  for (let index = 0; index < candles5.length; index += 1) {
    const past = candles5.slice(0, index + 1);
    const bar = past[past.length - 1];
    const barDay = istDayKeyFromUnix(bar.time);
    if (barDay !== day) {
      day = barDay;
      dayEntries = 0;
      dayRealized = 0;
    }
    const spot = bar.close;
    const chain = modelChain(spot, barDay, lotSize);
    if (open) {
      const marked = chain.find((item) => item.side === open?.side && item.strike === open.strike);
      const bid = marked?.bid ?? null;
      const flatten = istMinutes(new Date(bar.time * 1000)) >= RISK_LIMITS.flattenMinute;
      const hit = bid != null && (bid <= open.stop || bid >= open.target || flatten || index === candles5.length - 1);
      if (hit && bid != null) {
        const fill = Number(slippedPaise(bid, config.slippageBps, "SELL")) / 100;
        const exitCharges = Number(optionCharges("SELL", rupeePaise(fill), lotSize).total) / 100;
        const net = (fill - open.entry) * lotSize - open.charges - exitCharges;
        equity += net;
        dayRealized += net;
        trades.push({ entryTime: open.entryTime, exitTime: bar.time, side: open.side, strike: open.strike, net, regime: bar.high - bar.low >= medianRange ? "active" : "quiet" });
        open = null;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, peak - equity);
      }
    }
    if (open || dayEntries >= RISK_LIMITS.maxEntriesPerDay || dayRealized <= -equityRupees * RISK_LIMITS.dailyLossFraction) continue;
    const past15 = candles15.filter((item) => item.time + 900 <= bar.time + 300);
    const signal = evaluateSignal({
      candles5: sessionBars(past),
      candles15: past15,
      chain,
      spot,
      timestamp: new Date(bar.time * 1000).toISOString(),
      dataTimestamp: new Date(bar.time * 1000).toISOString(),
      quality: "modelled",
      nowDay: barDay,
      config,
    });
    if (signal.direction === "NO TRADE" || !signal.contract || signal.entry == null || signal.stop == null || signal.target == null) continue;
    const fill = Number(slippedPaise(signal.entry, config.slippageBps, "BUY")) / 100;
    const charges = Number(optionCharges("BUY", rupeePaise(fill), lotSize).total) / 100;
    const exposure = fill * lotSize + charges;
    if (exposure > equityRupees * RISK_LIMITS.riskFraction || exposure > equity) continue;
    open = { side: signal.direction, strike: signal.contract.strike, expiry: signal.contract.expiry, entry: fill, stop: signal.stop, target: signal.target, entryTime: bar.time, charges };
    dayEntries += 1;
  }
  return summarize(trades, maxDrawdown, window);
}

function summarize(trades: BacktestTrade[], maxDrawdown: number, window: "in-sample" | "test") {
  const wins = trades.filter((trade) => trade.net > 0);
  const losses = trades.filter((trade) => trade.net <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.net, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.net, 0));
  const net = trades.reduce((sum, trade) => sum + trade.net, 0);
  let streak = 0;
  let consecutiveLosses = 0;
  for (const trade of trades) {
    streak = trade.net <= 0 ? streak + 1 : 0;
    consecutiveLosses = Math.max(consecutiveLosses, streak);
  }
  const byMonth = new Map<string, number>();
  const byRegime = new Map<string, { trades: number; net: number }>();
  for (const trade of trades) {
    const month = istDayKeyFromUnix(trade.exitTime).slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + trade.net);
    const regime = byRegime.get(trade.regime) ?? { trades: 0, net: 0 };
    regime.trades += 1;
    regime.net += trade.net;
    byRegime.set(trade.regime, regime);
  }
  return {
    window,
    trades: trades.length,
    netPnl: roundRupee(net),
    winRate: trades.length ? wins.length / trades.length : 0,
    averageWin: wins.length ? roundRupee(grossProfit / wins.length) : 0,
    averageLoss: losses.length ? roundRupee(grossLoss / losses.length) : 0,
    expectancy: trades.length ? roundRupee(net / trades.length) : 0,
    profitFactor: grossLoss > 0 ? roundRupee(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    maxDrawdown: roundRupee(maxDrawdown),
    consecutiveLosses,
    costsNote: "Costs are included in net P&L. A profitable in-sample result is not evidence the test window will match it.",
    byMonth: [...byMonth.entries()].map(([month, value]) => ({ month, net: roundRupee(value) })),
    byRegime: [...byRegime.entries()].map(([regime, value]) => ({ regime, trades: value.trades, net: roundRupee(value.net) })),
  };
}

function pickContract(chain: OptionContract[], side: OptionRight, spot: number, day: string, config: SignalConfig, rejections: string[]) {
  const candidates = chain.filter((contract) => {
    if (contract.side !== side || contract.bid == null || contract.ask == null || contract.ask <= 0) return false;
    const days = daysUntil(contract.expiry, day);
    if (days < config.minDaysToExpiry || days > config.maxDaysToExpiry) return false;
    const mid = (contract.bid + contract.ask) / 2;
    if (mid <= 0 || (contract.ask - contract.bid) / mid > config.maxSpread) return false;
    if ((contract.volume ?? 0) < config.minVolume || (contract.oi ?? 0) < config.minOi) return false;
    return true;
  });
  if (!candidates.length) {
    rejections.push("Every contract failed the expiry, spread, volume, or open-interest check.");
    return null;
  }
  const directional = candidates.filter((contract) => (side === "CE" ? contract.strike >= spot : contract.strike <= spot));
  const pool = directional.length ? directional : candidates;
  return pool.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
}

function finish(
  base: Pick<Signal, "timestamp" | "dataTimestamp" | "underlying" | "quality" | "scoreNote">,
  direction: Signal["direction"],
  contract: OptionContract | null,
  levels: { entry: number; stop: number; target: number; risk: number; reward: number; maxPremium: number } | null,
  reasons: string[],
  rejections: string[],
  ruleScore: number,
): Signal {
  return {
    ...base,
    direction,
    contractKey: contract ? contractKey(contract) : null,
    contract,
    entry: levels?.entry ?? null,
    stop: levels?.stop ?? null,
    target: levels?.target ?? null,
    riskRupees: levels ? roundRupee(levels.risk) : null,
    rewardRupees: levels ? roundRupee(levels.reward) : null,
    maxPremiumRupees: levels ? roundRupee(levels.maxPremium) : null,
    ruleScore: Math.round(ruleScore * 100) / 100,
    reasons,
    rejections,
  };
}

function daysUntil(expiry: string, day: string) {
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return -1;
  return Math.round((end - start) / 86_400_000);
}

function roundRupee(value: number) {
  return Math.round(value * 100) / 100;
}

function rupeePaise(rupees: number) {
  return BigInt(Math.round(rupees * 100));
}

function bps(turnover: bigint, basisPoints: number) {
  return (turnover * BigInt(basisPoints) + 5_000n) / 10_000n;
}

function bigintPercent(value: bigint, fraction: number) {
  const units = BigInt(Math.round(fraction * 10_000));
  return (value * units + 5_000n) / 10_000n;
}
