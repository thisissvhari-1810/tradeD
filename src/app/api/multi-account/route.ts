import { z } from "zod";
import { clientIp, readJson } from "@/lib/http";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import {
  assertLiveAllowed,
  cancelDemoPending,
  closeDemoPositions,
  demoQuote,
  multiAccountView,
  reconcileDemoRequest,
  resetDemoAccount,
  setDemoHalt,
  submitDemoOrder,
  updateDemoAccounts,
} from "@/server/multi-account";
import type { PriceSource } from "@/lib/multi-account/engine";

export const maxDuration = 30;

const paise = z.number().int().positive().max(1_000_000_000_00);
const source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chain") }),
  z.object({ kind: z.literal("replay"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) }),
]);
const accountId = z.string().regex(/^demo-[1-8]$/);
const contract = z.object({
  underlying: z.string().trim().min(1).max(30),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose an expiry from the option chain."),
  strike: z.number().positive(),
  right: z.enum(["CE", "PE"]),
});
const key = z.string().uuid("Missing request key.");
const mode = z.enum(["DEMO", "LIVE"]);

const body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("submit"),
    mode,
    key,
    contract,
    side: z.enum(["BUY", "SELL"]),
    orderType: z.enum(["MARKET", "LIMIT"]),
    limitPaise: paise.nullable(),
    product: z.enum(["INTRADAY", "MARGIN"]),
    stopLossPaise: paise.nullable(),
    targetPaise: paise.nullable(),
    accountIds: z.array(accountId).min(1, "Select at least one account.").max(8),
    lots: z.record(accountId, z.number().int().min(1).max(1000)).optional(),
    source,
    confirmed: z.literal(true, { message: "Confirm the order summary first." }),
  }),
  z.object({ action: z.literal("quote"), contract, source }),
  z.object({ action: z.literal("reconcile"), requestId: z.string().uuid(), source }),
  z.object({ action: z.literal("cancel"), requestId: z.string().uuid() }),
  z.object({ action: z.literal("halt"), halted: z.boolean() }),
  z.object({
    action: z.literal("accounts"),
    patches: z.array(z.object({
      id: accountId,
      nickname: z.string().max(40).optional(),
      selected: z.boolean().optional(),
      lots: z.number().int().min(1).max(1000).optional(),
      tradingEnabled: z.boolean().optional(),
      risk: z.object({
        maxLots: z.number().int().min(1).max(1000).optional(),
        maxCapitalPaise: paise.optional(),
        maxDailyLossPaise: paise.optional(),
        maxOpenPositions: z.number().int().min(1).max(50).optional(),
        underlyings: z.array(z.string().max(30)).max(50).optional(),
        sides: z.array(z.enum(["BUY", "SELL"])).min(1, "Allow at least one side.").optional(),
      }).optional(),
    })).min(1).max(8),
  }),
  z.object({ action: z.literal("reset"), accountId, startingPaise: paise.min(1_000_00) }),
  z.object({
    action: z.literal("close"),
    mode,
    key,
    positions: z.array(z.object({ accountId, symbol: z.string().min(1).max(80) })).min(1).max(200),
    source,
    confirmed: z.literal(true, { message: "Confirm closing these positions first." }),
  }),
]);

function sourceFrom(url: URL): PriceSource {
  const date = url.searchParams.get("date") ?? "";
  const time = url.searchParams.get("time") ?? "";
  if (url.searchParams.get("source") === "replay" && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)) return { kind: "replay", date, time };
  return { kind: "chain" };
}

export const GET = query(async (request) => {
  const user = await requireUser();
  return Response.json(await multiAccountView(user, sourceFrom(new URL(request.url))));
});

export const POST = mutation(async (request) => {
  const user = await requireUser();
  const input = await readJson(request, body);
  const ip = clientIp(request);
  switch (input.action) {
    case "submit": {
      if (input.mode === "LIVE") assertLiveAllowed();
      return Response.json(await submitDemoOrder(user, {
        key: input.key,
        contract: input.contract,
        side: input.side,
        orderType: input.orderType,
        limitPaise: input.limitPaise,
        product: input.product,
        stopLossPaise: input.stopLossPaise,
        targetPaise: input.targetPaise,
        accountIds: input.accountIds,
        lots: input.lots,
        source: input.source,
      }, { ip }));
    }
    case "quote":
      return Response.json({ quote: await demoQuote(input.contract, input.source) });
    case "reconcile":
      return Response.json(await reconcileDemoRequest(user, input.requestId, input.source, { ip }));
    case "cancel":
      return Response.json(await cancelDemoPending(user, input.requestId, ip));
    case "halt":
      return Response.json(await setDemoHalt(user, input.halted, ip));
    case "accounts":
      return Response.json({ accounts: await updateDemoAccounts(user, input.patches, ip) });
    case "reset":
      return Response.json({ account: await resetDemoAccount(user, input.accountId, input.startingPaise, ip) });
    case "close": {
      if (input.mode === "LIVE") assertLiveAllowed();
      return Response.json({ results: await closeDemoPositions(user, { key: input.key, positions: input.positions, source: input.source }, ip) });
    }
  }
});
