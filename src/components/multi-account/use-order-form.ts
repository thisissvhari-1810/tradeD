"use client";

import { useCallback, useMemo, useState } from "react";
import { api, ApiError } from "@/components/api";
import { toPaise } from "@/components/multi-account/format";
import { useChain } from "@/components/multi-account/use-chain";
import type { ToastOptions } from "@/components/ui";
import { kolkataParts } from "@/lib/market/clock";
import { chargesFor, planLegs, type DemoDoc, type LegPlan, type OrderIntent, type OrderRequest, type OrderType, type PriceQuote, type PriceSource, type Product, type Right, type Side } from "@/lib/multi-account/engine";
import { DEFAULT_CHARGES } from "@/lib/trading/settings";

export type Review = { key: string; quote: PriceQuote; intent: OrderIntent; accountIds: string[]; product: Product; stopLossPaise: number | null; targetPaise: number | null };
export type FieldProblems = Partial<Record<"chain" | "expiry" | "strike" | "accounts" | "limit" | "stop" | "target", string>>;

/** Order-entry state lives here so the form can move between inline and sheet layouts without losing input. */
export function useOrderForm({ doc, source, selected, reloadToken, onPlaced, toast }: {
  doc: DemoDoc | null;
  source: PriceSource;
  selected: string[];
  reloadToken: number;
  onPlaced: () => void;
  toast: (message: string, options?: ToastOptions) => void;
}) {
  const { underlying, expiry, strike, setUnderlying, setExpiry, setStrike, chain, chainError, chainLoading } = useChain(reloadToken);
  const [right, setRight] = useState<Right>("CE");
  const [side, setSide] = useState<Side>("BUY");
  const [orderType, setOrderType] = useState<OrderType>("MARKET");
  const [limitText, setLimitText] = useState("");
  const [product, setProduct] = useState<Product>("INTRADAY");
  const [stopText, setStopText] = useState("");
  const [targetText, setTargetText] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [result, setResult] = useState<OrderRequest | null>(null);

  const limitPaise = orderType === "LIMIT" ? toPaise(limitText) : null;
  const stopLossPaise = toPaise(stopText);
  const targetPaise = toPaise(targetText);

  const problems: FieldProblems = {};
  if (!chain?.available) problems.chain = "The option chain is unavailable.";
  if (!expiry) problems.expiry = "Choose an expiry.";
  if (strike == null) problems.strike = "Choose a strike.";
  if (selected.length === 0) problems.accounts = "Select at least one account.";
  if (orderType === "LIMIT" && limitPaise == null) problems.limit = "Enter a limit price.";
  if (stopText.trim() && stopLossPaise == null) problems.stop = "Stop-loss must be a rupee amount.";
  if (targetText.trim() && targetPaise == null) problems.target = "Target must be a rupee amount.";
  const firstProblem = Object.values(problems)[0] ?? "";

  const row = chain?.strikes.find((item) => item.strike === strike) ?? null;
  const chainPremium = source.kind === "chain" && chain?.available && chain.expiry === expiry ? (right === "CE" ? row?.ce?.ltp : row?.pe?.ltp) ?? null : null;
  const eligible = useMemo(() => doc?.accounts.filter((account) => selected.includes(account.id) && account.tradingEnabled) ?? [], [doc, selected]);
  const totalLots = eligible.reduce((sum, account) => sum + account.lots, 0);
  const estimatePaise = chainPremium != null && chainPremium > 0 && chain?.lotSize ? Math.round(chainPremium * 100) * chain.lotSize * totalLots : null;

  const startReview = useCallback(async () => {
    if (strike == null || firstProblem) return false;
    setChecking(true);
    setSubmitError("");
    const contract = { underlying, expiry, strike, right };
    try {
      const { quote } = await api<{ quote: PriceQuote }>("/api/multi-account", { action: "quote", contract, source });
      setReview({ key: crypto.randomUUID(), quote, intent: { contract, side, orderType, limitPaise }, accountIds: [...selected], product, stopLossPaise, targetPaise });
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "No price is available for this contract.", { tone: "error" });
      return false;
    } finally {
      setChecking(false);
    }
  }, [strike, firstProblem, underlying, expiry, right, source, side, orderType, limitPaise, selected, product, stopLossPaise, targetPaise, toast]);

  const today = kolkataParts(new Date()).dateKey;
  const plans: LegPlan[] = review && doc ? planLegs(doc, review.accountIds, review.intent, review.quote, DEFAULT_CHARGES, today) : [];
  const legValue = (quantity: number) => (review ? review.quote.premiumPaise * quantity : 0);
  const accepted = plans.filter((plan) => !plan.reject);
  const totals = {
    accepted: accepted.length,
    rejected: plans.length - accepted.length,
    lots: accepted.reduce((sum, plan) => sum + plan.lots, 0),
    valuePaise: accepted.reduce((sum, plan) => sum + legValue(plan.quantity), 0),
    chargesPaise: review ? accepted.reduce((sum, plan) => sum + chargesFor(review.intent.side, legValue(plan.quantity), DEFAULT_CHARGES), 0) : 0,
  };

  const confirm = useCallback(async () => {
    if (!review || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const response = await api<{ request: OrderRequest; duplicate: boolean }>("/api/multi-account", {
        action: "submit",
        mode: "DEMO",
        key: review.key,
        contract: review.intent.contract,
        side: review.intent.side,
        orderType: review.intent.orderType,
        limitPaise: review.intent.limitPaise,
        product: review.product,
        stopLossPaise: review.stopLossPaise,
        targetPaise: review.targetPaise,
        accountIds: review.accountIds,
        source,
        confirmed: true,
      });
      setResult(response.request);
      setReview(null);
      onPlaced();
      toast(response.duplicate ? "This request was already placed. Showing the original result, nothing was sent twice." : `Demo request ${response.request.status.toLowerCase()}.`, { tone: response.request.status === "Failed" ? "error" : "success" });
    } catch (error) {
      const network = error instanceof ApiError && (error.code === "NETWORK" || error.status >= 500);
      setSubmitError(network ? `${error.message} Retrying uses the same request ID, so accounts that already filled will not fill twice.` : error instanceof Error ? error.message : "The request failed.");
    } finally {
      setSubmitting(false);
    }
  }, [review, submitting, source, onPlaced, toast]);

  const closeReview = useCallback(() => { if (!submitting) setReview(null); }, [submitting]);

  return {
    fields: { underlying, expiry, strike, right, side, orderType, limitText, product, stopText, targetText },
    set: { setUnderlying, setExpiry, setStrike, setRight, setSide, setOrderType, setLimitText, setProduct, setStopText, setTargetText },
    chain, chainError, chainLoading, chainPremium,
    problems, firstProblem,
    eligibleCount: eligible.length, totalLots, estimatePaise,
    stopLossPaise, targetPaise,
    review, plans, totals, legValue, checking, submitting, submitError, startReview, confirm, closeReview,
    result, dismissResult: () => setResult(null),
  };
}

export type OrderForm = ReturnType<typeof useOrderForm>;
