import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { rupeesToPaise } from "@/lib/money";
import { kolkataParts } from "@/lib/market/clock";
import { sessionBounds } from "@/lib/options/replay-premium";
import {
  ACCOUNT_SLOTS,
  MAX_REQUESTS_KEPT,
  applyFill,
  defaultAccount,
  defaultDoc,
  marketablePrice,
  overallStatus,
  planLegs,
  riskCheck,
  summarize,
  type Contract,
  type DemoDoc,
  type Leg,
  type OrderIntent,
  type OrderRequest,
  type OrderType,
  type PriceQuote,
  type PriceSource,
  type Product,
  type RiskLimits,
  type Side,
} from "@/lib/multi-account/engine";
import { executeLegs, ORDER_RATE } from "@/lib/multi-account/executor";
import { liveGate } from "@/lib/multi-account/compliance";
import type { MultiAccountView } from "@/lib/multi-account/view";
import type { SessionUser } from "@/server/auth";
import { loadOptionChain } from "@/server/option-chain";
import { replayQuote } from "@/server/option-replay";
import { configuredProvider, getTradingSettings } from "@/server/settings";

/**
 * Multi-account demo desk. Each user owns one document of eight simulated accounts in AppSetting.
 * Writes use a revision check so concurrent requests never overwrite each other.
 * Nothing here can reach a broker: there is no order endpoint and live mode is refused by the gate.
 */

const DEMO_KEY_PREFIX = "multi.demo.v1:";
const REPLAY_SESSION_SUFFIX = "multiacct";
const MAX_CAS_ATTEMPTS = 6;

export type Stored = { rev: number; doc: DemoDoc };

export function demoKey(userId: string) {
  return `${DEMO_KEY_PREFIX}${userId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a stored document. A malformed document is reported, never silently reset. */
export function parseStored(raw: unknown): Stored {
  if (!isRecord(raw) || typeof raw.rev !== "number" || !isRecord(raw.doc)) throw new AppError("Saved multi-account data could not be read.", 500, "MULTI_DATA_INVALID");
  const doc = raw.doc;
  if (doc.v !== 1 || !Array.isArray(doc.accounts) || !Array.isArray(doc.positions) || !Array.isArray(doc.requests)) throw new AppError("Saved multi-account data could not be read.", 500, "MULTI_DATA_INVALID");
  const parsed = doc as unknown as DemoDoc;
  const accounts = Array.from({ length: ACCOUNT_SLOTS }, (_, index) => parsed.accounts.find((account) => account.slot === index + 1) ?? defaultAccount(index + 1));
  return { rev: raw.rev, doc: { ...parsed, accounts } };
}

async function readStored(userId: string): Promise<Stored | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: demoKey(userId) } });
  return row ? parseStored(row.value) : null;
}

function toJson(stored: Stored): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(stored)) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown) {
  return isRecord(error) && error.code === "P2002";
}

/** Compare-and-swap update: re-reads and re-applies the change if another request wrote first. */
export async function mutateDoc<T>(userId: string, change: (doc: DemoDoc) => Promise<T> | T): Promise<{ doc: DemoDoc; result: T }> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await readStored(userId);
    const doc: DemoDoc = structuredClone(current?.doc ?? defaultDoc());
    const result = await change(doc);
    const next: Stored = { rev: (current?.rev ?? 0) + 1, doc };
    if (!current) {
      try {
        await prisma.appSetting.create({ data: { key: demoKey(userId), value: toJson(next), updatedById: userId } });
        return { doc, result };
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }
    const written = await prisma.appSetting.updateMany({
      where: { key: demoKey(userId), value: { path: ["rev"], equals: current.rev } },
      data: { value: toJson(next), updatedById: userId },
    });
    if (written.count === 1) return { doc, result };
  }
  throw new AppError("Another change to these accounts was saved at the same time. Nothing was placed twice. Refresh and try again.", 409, "MULTI_BUSY");
}

function todayKey(now: Date) {
  return kolkataParts(now).dateKey;
}

function replayCursor(date: string, time: string) {
  const bounds = sessionBounds(date);
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!bounds || !match) throw new AppError("Choose a valid replay date and time.", 400, "INVALID_REPLAY_TIME");
  return Date.parse(`${date}T${match[1]}:${match[2]}:00+05:30`) / 1000;
}

/** One real price for the whole request. Refuses when the chain or history has no usable price or lot size. */
export async function demoQuote(contract: Contract, source: PriceSource, stored?: { securityId: string; lotSize: number }, now = new Date()): Promise<PriceQuote> {
  if (source.kind === "replay") {
    const cursor = replayCursor(source.date, source.time);
    const { quote, contract: resolved } = await replayQuote({ ...contract, session: `${source.date}.${REPLAY_SESSION_SUFFIX}`, cursor }, stored, now);
    if (!quote.available || quote.premium == null || quote.premium <= 0) throw new AppError(quote.reason || quote.message, 409, "PRICE_UNAVAILABLE");
    const lotSize = quote.lotSize ?? resolved?.lotSize ?? null;
    if (!lotSize || lotSize <= 0) throw new AppError("The lot size for this contract is not available, so the order was not placed.", 409, "LOT_SIZE_UNAVAILABLE");
    return {
      premiumPaise: Number(rupeesToPaise(quote.premium.toFixed(2))),
      lotSize,
      asOf: new Date(cursor * 1000).toISOString(),
      source: "replay",
      label: `Replay ${source.date} ${source.time} IST · 1-minute history`,
      securityId: resolved?.securityId ?? null,
    };
  }
  const chain = await loadOptionChain(contract.underlying, contract.expiry, now);
  if (!chain.available) throw new AppError(chain.message || "The option chain is unavailable, so the order was not placed.", 409, "PRICE_UNAVAILABLE");
  if (chain.expiry !== contract.expiry) throw new AppError("This expiry is not on the current contract list.", 409, "EXPIRY_NOT_LISTED", { field: "expiry" });
  if (!chain.lotSize || chain.lotSize <= 0) throw new AppError("The lot size for this contract is not available, so the order was not placed.", 409, "LOT_SIZE_UNAVAILABLE");
  const row = chain.strikes.find((item) => item.strike === contract.strike);
  const side = contract.right === "CE" ? row?.ce : row?.pe;
  if (!row || !side) throw new AppError("This strike is not listed for the selected expiry.", 409, "STRIKE_NOT_LISTED", { field: "strike" });
  if (side.ltp == null || side.ltp <= 0) throw new AppError("This contract has no traded price yet, so the order was not placed.", 409, "PRICE_UNAVAILABLE");
  return {
    premiumPaise: Number(rupeesToPaise(side.ltp.toFixed(2))),
    lotSize: chain.lotSize,
    asOf: chain.asOf,
    source: "chain",
    label: `Option chain last price · ${chain.asOf}`,
    securityId: side.securityId,
  };
}

async function audit(user: SessionUser, ip: string | null, rows: Array<{ action: string; targetId: string; reason?: string; after: Record<string, unknown> }>) {
  if (rows.length === 0) return;
  try {
    await prisma.auditLog.createMany({
      data: rows.map((row) => ({ actorId: user.id, action: row.action, targetType: "MultiAccountDemo", targetId: row.targetId, reason: row.reason ?? "", after: JSON.parse(JSON.stringify(row.after)) as Prisma.InputJsonValue, ipAddress: ip })),
    });
  } catch (error) {
    console.error("multi-account audit write failed", error instanceof Error ? error.message : "unknown error");
  }
}

function legAudit(request: OrderRequest) {
  return [
    { action: "multi.request", targetId: request.id, after: { key: request.key, contract: request.contract, side: request.side, orderType: request.orderType, limitPaise: request.limitPaise, quote: request.quote, status: request.status, closing: request.closing } },
    ...request.legs.map((leg) => ({ action: `multi.leg.${leg.status.toLowerCase()}`, targetId: leg.id, reason: leg.reason, after: { requestId: request.id, accountId: leg.accountId, lots: leg.lots, quantity: leg.quantity, filledQuantity: leg.filledQuantity, avgPaise: leg.avgPaise, chargesPaise: leg.chargesPaise, ref: leg.ref } })),
  ];
}

export type SubmitInput = {
  key: string;
  contract: Contract;
  side: Side;
  orderType: OrderType;
  limitPaise: number | null;
  product: Product;
  stopLossPaise: number | null;
  targetPaise: number | null;
  accountIds: string[];
  lots?: Record<string, number>;
  source: PriceSource;
  closing?: boolean;
};

export type DemoLegOutcome = Pick<Leg, "status" | "filledQuantity" | "avgPaise" | "chargesPaise" | "realizedPaise" | "reason">;

/** Simulated execution of one leg against its own account only. */
export type DemoLegRunner = (doc: DemoDoc, accountId: string, intent: OrderIntent, quote: PriceQuote, quantity: number, today: string, at: string) => Promise<DemoLegOutcome>;

export function demoRunner(settings: Awaited<ReturnType<typeof getTradingSettings>>): DemoLegRunner {
  return async (doc, accountId, intent, quote, quantity, today, at) => {
    const price = marketablePrice(intent, quote);
    if (price == null) return { status: "PENDING", filledQuantity: 0, avgPaise: null, chargesPaise: 0, realizedPaise: null, reason: "Limit price not reached at the current premium. Waiting; reconcile to re-check." };
    const fill = applyFill(doc, accountId, intent, quote, quantity, price, settings.charges, today, at);
    return { status: "FILLED", filledQuantity: quantity, avgPaise: price, chargesPaise: fill.chargesPaise, realizedPaise: fill.realizedPaise, reason: "Simulated fill at the quoted premium." };
  };
}

function trimRequests(doc: DemoDoc) {
  if (doc.requests.length <= MAX_REQUESTS_KEPT) return;
  const open = doc.requests.filter((request) => request.status === "Pending");
  const done = doc.requests.filter((request) => request.status !== "Pending").slice(0, Math.max(0, MAX_REQUESTS_KEPT - open.length));
  doc.requests = [...open, ...done].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function submitDemoOrder(user: SessionUser, input: SubmitInput, options: { ip?: string | null; now?: Date; runner?: DemoLegRunner; quote?: PriceQuote } = {}): Promise<{ request: OrderRequest; duplicate: boolean }> {
  const now = options.now ?? new Date();
  const existing = (await readStored(user.id))?.doc;
  const prior = existing?.requests.find((request) => request.key === input.key);
  if (prior) return { request: prior, duplicate: true };
  if (existing?.halted && !input.closing) throw new AppError("Emergency stop is on. Turn it off before placing new orders.", 409, "HALTED");
  const accountIds = [...new Set(input.accountIds)];
  if (accountIds.length === 0) throw new AppError("Select at least one account.", 400, "NO_ACCOUNTS", { field: "accountIds" });
  if (input.orderType === "LIMIT" && (input.limitPaise == null || input.limitPaise <= 0)) throw new AppError("Enter a limit price above zero.", 400, "INVALID_LIMIT", { field: "limitPaise" });
  const quote = options.quote ?? (await demoQuote(input.contract, input.source, undefined, now));
  const settings = await getTradingSettings();
  const runner = options.runner ?? demoRunner(settings);
  const intent: OrderIntent = { contract: { ...input.contract, underlying: input.contract.underlying.toUpperCase() }, side: input.side, orderType: input.orderType, limitPaise: input.orderType === "LIMIT" ? input.limitPaise : null, lots: input.lots, closing: input.closing };
  const { result } = await mutateDoc(user.id, async (doc) => {
    const again = doc.requests.find((request) => request.key === input.key);
    if (again) return { request: again, duplicate: true };
    const today = todayKey(now);
    const at = now.toISOString();
    const requestId = randomUUID();
    const plans = planLegs(doc, accountIds, intent, quote, settings.charges, today);
    if (plans.length === 0) throw new AppError("None of the selected accounts exist.", 400, "NO_ACCOUNTS", { field: "accountIds" });
    const settled = await executeLegs(plans, async (plan) => {
      if (plan.reject) return { status: "REJECTED", filledQuantity: 0, avgPaise: null, chargesPaise: 0, realizedPaise: null, reason: plan.reject } satisfies DemoLegOutcome;
      return runner(doc, plan.account.id, intent, quote, plan.quantity, today, at);
    }, ORDER_RATE);
    const legs: Leg[] = plans.map((plan, index) => {
      const outcome = settled[index];
      const base = { id: randomUUID(), accountId: plan.account.id, nickname: plan.account.nickname, lots: plan.lots, quantity: plan.quantity, ref: `SIM-${requestId.slice(0, 8).toUpperCase()}-${plan.account.slot}`, updatedAt: at };
      if (outcome?.status === "fulfilled") return { ...base, ...outcome.value };
      return { ...base, status: "UNKNOWN", filledQuantity: 0, avgPaise: null, chargesPaise: 0, realizedPaise: null, reason: "The outcome of this leg was not confirmed. It was not resubmitted; reconcile to resolve it." };
    });
    const request: OrderRequest = {
      id: requestId,
      key: input.key,
      createdAt: at,
      mode: "DEMO",
      contract: intent.contract,
      side: input.side,
      orderType: input.orderType,
      limitPaise: intent.limitPaise,
      product: input.product,
      stopLossPaise: input.stopLossPaise,
      targetPaise: input.targetPaise,
      closing: input.closing === true,
      quote,
      legs,
      status: overallStatus(legs),
    };
    doc.requests.unshift(request);
    trimRequests(doc);
    return { request, duplicate: false };
  });
  if (!result.duplicate) await audit(user, options.ip ?? null, legAudit(result.request));
  return result;
}

/** Re-checks pending legs against a fresh price and settles unconfirmed demo legs from the ledger. Never resubmits a filled leg. */
export async function reconcileDemoRequest(user: SessionUser, requestId: string, source: PriceSource, options: { ip?: string | null; now?: Date; quote?: PriceQuote } = {}) {
  const now = options.now ?? new Date();
  const stored = await readStored(user.id);
  const found = stored?.doc.requests.find((request) => request.id === requestId);
  if (!found) throw new AppError("This request was not found.", 404, "REQUEST_NOT_FOUND");
  const needsPrice = found.legs.some((leg) => leg.status === "PENDING");
  let quote: PriceQuote | null = options.quote ?? null;
  let priceNote = "";
  if (needsPrice && !quote) {
    try {
      quote = await demoQuote(found.contract, source, found.quote.securityId ? { securityId: found.quote.securityId, lotSize: found.quote.lotSize } : undefined, now);
    } catch (error) {
      priceNote = error instanceof Error ? error.message : "No current price.";
    }
  }
  const settings = await getTradingSettings();
  const { result } = await mutateDoc(user.id, (doc) => {
    const request = doc.requests.find((item) => item.id === requestId);
    if (!request) throw new AppError("This request was not found.", 404, "REQUEST_NOT_FOUND");
    const today = todayKey(now);
    const at = now.toISOString();
    const changed: Leg[] = [];
    for (const leg of request.legs) {
      if (leg.status === "UNKNOWN") {
        Object.assign(leg, { status: "REJECTED", reason: "Reconciled: the demo ledger has no fill for this leg.", updatedAt: at });
        changed.push(leg);
      }
      if (leg.status !== "PENDING" || !quote) continue;
      const intent: OrderIntent = { contract: request.contract, side: request.side, orderType: request.orderType, limitPaise: request.limitPaise, lots: { [leg.accountId]: leg.lots }, closing: request.closing };
      const legQuote: PriceQuote = { ...quote, lotSize: leg.quantity / leg.lots };
      const account = doc.accounts.find((item) => item.id === leg.accountId);
      const price = marketablePrice(intent, legQuote);
      if (!account || price == null) continue;
      const reject = riskCheck(doc, account, intent, leg.lots, legQuote, settings.charges, today);
      if (reject) {
        Object.assign(leg, { status: "REJECTED", reason: reject, updatedAt: at });
      } else {
        const fill = applyFill(doc, leg.accountId, intent, legQuote, leg.quantity, price, settings.charges, today, at);
        Object.assign(leg, { status: "FILLED", filledQuantity: leg.quantity, avgPaise: price, chargesPaise: fill.chargesPaise, realizedPaise: fill.realizedPaise, reason: "Limit reached on reconcile. Simulated fill.", updatedAt: at });
      }
      changed.push(leg);
    }
    request.status = overallStatus(request.legs);
    return { request, changed };
  });
  await audit(user, options.ip ?? null, result.changed.map((leg) => ({ action: `multi.reconcile.${leg.status.toLowerCase()}`, targetId: leg.id, reason: leg.reason, after: { requestId, accountId: leg.accountId, filledQuantity: leg.filledQuantity, avgPaise: leg.avgPaise } })));
  return { request: result.request, changed: result.changed.length, priceNote };
}

export async function cancelDemoPending(user: SessionUser, requestId: string, ip: string | null = null) {
  const { result } = await mutateDoc(user.id, (doc) => {
    const request = doc.requests.find((item) => item.id === requestId);
    if (!request) throw new AppError("This request was not found.", 404, "REQUEST_NOT_FOUND");
    const at = new Date().toISOString();
    const cancelled = request.legs.filter((leg) => leg.status === "PENDING");
    for (const leg of cancelled) Object.assign(leg, { status: "CANCELLED", reason: "Cancelled before it filled.", updatedAt: at });
    request.status = overallStatus(request.legs);
    return { request, cancelled: cancelled.length };
  });
  await audit(user, ip, [{ action: "multi.cancel", targetId: requestId, after: { cancelled: result.cancelled } }]);
  return result;
}

export async function setDemoHalt(user: SessionUser, halted: boolean, ip: string | null = null) {
  const { doc } = await mutateDoc(user.id, (draft) => {
    draft.halted = halted;
    draft.haltedAt = halted ? new Date().toISOString() : null;
  });
  await audit(user, ip, [{ action: halted ? "multi.halt.on" : "multi.halt.off", targetId: user.id, after: { halted } }]);
  return { halted: doc.halted, haltedAt: doc.haltedAt };
}

export type AccountPatch = {
  id: string;
  nickname?: string;
  selected?: boolean;
  lots?: number;
  tradingEnabled?: boolean;
  risk?: Partial<RiskLimits>;
};

export async function updateDemoAccounts(user: SessionUser, patches: AccountPatch[], ip: string | null = null) {
  const { doc } = await mutateDoc(user.id, (draft) => {
    for (const patch of patches) {
      const account = draft.accounts.find((item) => item.id === patch.id);
      if (!account) throw new AppError("This account was not found.", 404, "ACCOUNT_NOT_FOUND");
      if (patch.nickname !== undefined) account.nickname = patch.nickname.trim() || `Demo account ${account.slot}`;
      if (patch.selected !== undefined) account.selected = patch.selected;
      if (patch.lots !== undefined) account.lots = patch.lots;
      if (patch.tradingEnabled !== undefined) account.tradingEnabled = patch.tradingEnabled;
      if (patch.risk) account.risk = { ...account.risk, ...patch.risk, underlyings: (patch.risk.underlyings ?? account.risk.underlyings).map((item) => item.trim().toUpperCase()).filter(Boolean) };
    }
  });
  const settingsChanged = patches.filter((patch) => patch.nickname !== undefined || patch.lots !== undefined || patch.tradingEnabled !== undefined || patch.risk);
  await audit(user, ip, settingsChanged.map((patch) => ({ action: "multi.account.update", targetId: patch.id, after: { ...patch } })));
  return doc.accounts;
}

/** Restarts one demo account with new virtual capital. Blocked while it has open positions or pending legs. */
export async function resetDemoAccount(user: SessionUser, accountId: string, startingPaise: number, ip: string | null = null) {
  const { result } = await mutateDoc(user.id, (doc) => {
    const account = doc.accounts.find((item) => item.id === accountId);
    if (!account) throw new AppError("This account was not found.", 404, "ACCOUNT_NOT_FOUND");
    if (doc.positions.some((position) => position.accountId === accountId && position.quantity > 0)) throw new AppError("Close this account's open positions before resetting it.", 409, "HAS_POSITIONS");
    if (doc.requests.some((request) => request.legs.some((leg) => leg.accountId === accountId && (leg.status === "PENDING" || leg.status === "UNKNOWN")))) throw new AppError("Resolve this account's pending orders before resetting it.", 409, "HAS_PENDING");
    Object.assign(account, { startingPaise, cashPaise: startingPaise, realizedPaise: 0, dayRealizedPaise: 0, dayKey: "" });
    return { ...account };
  });
  await audit(user, ip, [{ action: "multi.account.reset", targetId: accountId, after: { startingPaise } }]);
  return result;
}

/** Close-position workflow: one SELL request per contract for the chosen accounts' full open quantity. */
export async function closeDemoPositions(user: SessionUser, input: { key: string; positions: Array<{ accountId: string; symbol: string }>; source: PriceSource }, ip: string | null = null) {
  const stored = await readStored(user.id);
  if (!stored) throw new AppError("There are no open demo positions.", 409, "NO_POSITIONS");
  const groups = new Map<string, { contract: Contract; securityId: string | null; lotSize: number; lots: Record<string, number> }>();
  for (const pick of input.positions) {
    const position = stored.doc.positions.find((item) => item.accountId === pick.accountId && item.symbol === pick.symbol && item.quantity > 0);
    if (!position) continue;
    const group = groups.get(position.symbol) ?? { contract: position.contract, securityId: position.securityId, lotSize: position.lotSize, lots: {} };
    group.lots[position.accountId] = Math.round(position.quantity / position.lotSize);
    groups.set(position.symbol, group);
  }
  if (groups.size === 0) throw new AppError("None of the chosen positions are open.", 409, "NO_POSITIONS");
  const results: Array<{ symbol: string; request: OrderRequest | null; error: string | null }> = [];
  for (const [symbol, group] of groups) {
    try {
      const quote = await demoQuote(group.contract, input.source, group.securityId ? { securityId: group.securityId, lotSize: group.lotSize } : undefined);
      const { request } = await submitDemoOrder(user, {
        key: `${input.key}:${symbol}`,
        contract: group.contract,
        side: "SELL",
        orderType: "MARKET",
        limitPaise: null,
        product: "INTRADAY",
        stopLossPaise: null,
        targetPaise: null,
        accountIds: Object.keys(group.lots),
        lots: group.lots,
        source: input.source,
        closing: true,
      }, { ip, quote: { ...quote, lotSize: group.lotSize } });
      results.push({ symbol, request, error: null });
    } catch (error) {
      results.push({ symbol, request: null, error: error instanceof Error ? error.message : "Could not close this position." });
    }
  }
  return results;
}

async function marksFor(doc: DemoDoc, source: PriceSource, now: Date) {
  const marks = new Map<string, number | null>();
  const symbols = [...new Map(doc.positions.filter((position) => position.quantity > 0).map((position) => [position.symbol, position])).values()];
  await Promise.all(symbols.map(async (position) => {
    try {
      const quote = await demoQuote(position.contract, source, position.securityId ? { securityId: position.securityId, lotSize: position.lotSize } : undefined, now);
      marks.set(position.symbol, quote.premiumPaise);
    } catch {
      marks.set(position.symbol, null);
    }
  }));
  return marks;
}

export async function multiAccountView(user: SessionUser, source: PriceSource, now = new Date()): Promise<MultiAccountView> {
  const stored = await readStored(user.id);
  const doc = stored?.doc ?? defaultDoc();
  const marks = await marksFor(doc, source, now);
  const provider = configuredProvider();
  return {
    mode: "DEMO",
    doc,
    summary: summarize(doc, marks, todayKey(now)),
    marks: Object.fromEntries(marks),
    priceSource: source,
    marketData: {
      provider,
      pricesAvailable: provider === "dhan",
      message: provider === "dhan" ? "Demo fills use real option-chain or 1-minute history premiums from the read-only market-data connection." : "No option market data is connected, so demo orders cannot be priced. Orders are refused rather than filled at an invented price.",
    },
    live: liveGate(),
    saved: stored != null,
  };
}

export function assertLiveAllowed(): never {
  const gate = liveGate();
  throw new AppError(gate.message, 403, "LIVE_LOCKED", { details: { requirements: gate.requirements.filter((item) => !item.met).map((item) => item.label) } });
}
