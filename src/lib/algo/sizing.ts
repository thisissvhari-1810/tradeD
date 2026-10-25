import type { Direction } from "./patterns";
import type { Zone } from "./setups";
import { setupScore, type ScoreInput, type SetupScore } from "./quality";

/**
 * Risk-based trade planning for an ATM option bought on an index setup. The stop is placed on the index,
 * just beyond the setup's invalidation (the broken level, or the rejection wick); the target is the minimum
 * reward : risk multiple of that distance. Both are translated to the option's premium with the ATM delta
 * (≈ 0.5: an ATM option moves about half as much as the index), and lots are sized so the loss at the
 * stop — premium, exit slippage and both legs' charges — stays within the risk per trade. If one lot
 * already risks more, the plan is NO TRADE rather than a bigger risk.
 */

export const ATM_DELTA = 0.5;
const TICK = 0.05;
const money = (value: number) => Math.round(value * 100) / 100;
const tick = (value: number) => Math.round(value / TICK) * TICK;

export type RiskSettings = {
  /** The capital the risk percentages refer to. */
  capital: number;
  /** Maximum loss per trade, % of capital (0.5 = ₹500 on ₹1,00,000). */
  perTradePercent: number;
  /** The day's profit goal; new entries stop once realized P&L reaches it (when stopAtTarget). */
  dailyTarget: number;
  stopAtTarget: boolean;
  /** Minimum reward : risk (2 = the target is twice the stop distance). */
  minRewardRisk: number;
  /** The index stop is at least this % away from the entry, and this far beyond the invalidation. */
  minStopPercent: number;
};

export const RISK_DEFAULTS: RiskSettings = { capital: 100_000, perTradePercent: 0.5, dailyTarget: 5_000, stopAtTarget: true, minRewardRisk: 2, minStopPercent: 0.03 };

export type TradePlan = {
  direction: Direction;
  entryIndex: number;
  /** The option price the plan was made for (the fill may differ; the levels move with it). */
  entryPrice: number;
  stopIndex: number;
  targetIndex: number;
  /** Index points from entry to stop. */
  stopDistance: number;
  premiumStop: number;
  premiumTarget: number;
  lots: number;
  quantity: number;
  /** Rupees lost at the stop (all lots, charges and exit slippage included). */
  risk: number;
  /** Rupees gained at the target, after charges. */
  reward: number;
  /** Planned reward : risk (the target multiple). */
  rewardRisk: number;
  /** The next opposing zone, its distance in index points and room : risk. */
  room: { label: string; price: number; points: number; ratio: number } | null;
  budget: number;
  score: SetupScore;
};

export type PlanInput = {
  direction: Direction;
  /** The signal candle's close on the index. */
  entryIndex: number;
  /** Where the setup is wrong (the broken level, or the rejection candle's extreme). */
  invalidation: number;
  zones: Zone[];
  /** The option's entry price (ask plus slippage) and lot size. */
  price: number;
  lotSize: number;
  slippageTicks: number;
  charges: (side: "BUY" | "SELL", premium: number, quantity: number) => number;
  cash: number;
  /** The most lots one trade may use. */
  maxLots: number;
  risk: RiskSettings;
  minScore: number;
  score: Omit<ScoreInput, "direction" | "rewardRisk" | "minRewardRisk" | "costShare">;
};

export function planTrade(input: PlanInput): { ok: true; plan: TradePlan } | { ok: false; plan: TradePlan; reasons: string[] } {
  const bull = input.direction === "CALL";
  const { risk } = input;
  const minimum = (input.entryIndex * risk.minStopPercent) / 100;
  let stopIndex = bull ? input.invalidation - minimum : input.invalidation + minimum;
  let stopDistance = bull ? input.entryIndex - stopIndex : stopIndex - input.entryIndex;
  if (!(stopDistance >= minimum)) {
    stopDistance = minimum;
    stopIndex = bull ? input.entryIndex - minimum : input.entryIndex + minimum;
  }
  const targetIndex = bull ? input.entryIndex + risk.minRewardRisk * stopDistance : input.entryIndex - risk.minRewardRisk * stopDistance;
  const opposing = input.zones
    .filter((zone) => (bull ? zone.price > input.entryIndex + minimum / 3 : zone.price < input.entryIndex - minimum / 3))
    .sort((a, b) => Math.abs(a.price - input.entryIndex) - Math.abs(b.price - input.entryIndex))[0];
  const room = opposing ? { label: opposing.label, price: opposing.price, points: money(Math.abs(opposing.price - input.entryIndex)), ratio: Math.abs(opposing.price - input.entryIndex) / stopDistance } : null;

  const premiumStop = money(Math.max(TICK, tick(input.price - ATM_DELTA * stopDistance)));
  const premiumTarget = money(tick(input.price + ATM_DELTA * risk.minRewardRisk * stopDistance));
  const lot = input.lotSize;
  const roundTrip = input.charges("BUY", input.price, lot) + input.charges("SELL", premiumStop, lot);
  const lotRisk = (input.price - premiumStop + input.slippageTicks * TICK) * lot + roundTrip;
  const lotReward = (premiumTarget - input.price) * lot - input.charges("BUY", input.price, lot) - input.charges("SELL", premiumTarget, lot);
  const budget = money((risk.capital * risk.perTradePercent) / 100);
  const byRisk = lotRisk > 0 ? Math.floor(budget / lotRisk) : 0;
  const byCash = Math.floor(input.cash / (input.price * lot + input.charges("BUY", input.price, lot)));
  const lots = Math.max(0, Math.min(input.maxLots, byRisk, byCash));
  const costShare = (premiumTarget - input.price) * lot > 0 ? roundTrip / ((premiumTarget - input.price) * lot) : 1;
  const score = setupScore({ ...input.score, direction: input.direction, rewardRisk: room ? room.ratio : Infinity, minRewardRisk: risk.minRewardRisk, costShare });
  const plan: TradePlan = {
    direction: input.direction,
    entryIndex: money(input.entryIndex),
    entryPrice: input.price,
    stopIndex: money(stopIndex),
    targetIndex: money(targetIndex),
    stopDistance: money(stopDistance),
    premiumStop,
    premiumTarget,
    lots,
    quantity: lots * lot,
    risk: money(lotRisk * Math.max(lots, 1)),
    reward: money(lotReward * Math.max(lots, 1)),
    rewardRisk: risk.minRewardRisk,
    room: room ? { ...room, ratio: Math.round(room.ratio * 10) / 10 } : null,
    budget,
    score,
  };
  const reasons: string[] = [];
  if (room && room.ratio < risk.minRewardRisk) reasons.push(`Not enough room: the ${room.label} at ${room.price.toFixed(2)} is ${room.points.toFixed(2)} points away, ${room.ratio.toFixed(1)}× the ${stopDistance.toFixed(2)}-point stop (minimum reward : risk ${risk.minRewardRisk}).`);
  if (byRisk < 1) reasons.push(`1 lot would risk ₹${money(lotRisk).toFixed(2)} (index stop ${plan.stopIndex.toFixed(2)}, ${plan.stopDistance.toFixed(2)} points away), above the ₹${budget.toFixed(2)} risk per trade: no trade.`);
  else if (byCash < 1) reasons.push(`Insufficient buying power for 1 lot (₹${money(input.price * lot).toFixed(2)} needed, ₹${money(input.cash).toFixed(2)} available).`);
  if (lotReward <= 0) reasons.push("The planned reward does not cover the charges.");
  if (score.score < input.minScore) reasons.push(`Setup score ${score.score} is below the minimum ${input.minScore} (${score.parts.filter((part) => part.points < part.max).map((part) => `${part.label} ${part.points}/${part.max}`).join(", ")}).`);
  return reasons.length ? { ok: false, plan, reasons } : { ok: true, plan };
}
