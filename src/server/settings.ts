import { AppError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CHARGES, DEFAULT_RISK, DEFAULT_STARTING_CAPITAL_PAISE, type ChargeSettings, type RiskSettings, type TradingSettings } from "@/lib/trading/settings";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function getTradingSettings(): Promise<TradingSettings> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: ["trading.startingCapitalPaise", "trading.charges", "trading.risk", "market.holidays"] } },
  });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const startingRaw = map.get("trading.startingCapitalPaise");
  const startingCapitalPaise = typeof startingRaw === "string" || typeof startingRaw === "number" ? BigInt(startingRaw) : DEFAULT_STARTING_CAPITAL_PAISE;
  const charges = { ...DEFAULT_CHARGES, ...asRecord(map.get("trading.charges")) } as ChargeSettings;
  const riskInput = asRecord(map.get("trading.risk"));
  const risk = { ...DEFAULT_RISK, ...riskInput } as RiskSettings;
  if (Array.isArray(riskInput.allowedOrderTypes)) {
    risk.allowedOrderTypes = riskInput.allowedOrderTypes.filter((item): item is RiskSettings["allowedOrderTypes"][number] =>
      ["MARKET", "LIMIT", "STOP", "STOP_LIMIT", "TARGET"].includes(String(item)),
    );
  }
  return { startingCapitalPaise, charges, risk };
}

export async function getHolidays(): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: "market.holidays" } });
  return Array.isArray(row?.value) ? row.value.filter((item): item is string => typeof item === "string") : [];
}

export function configuredProvider(): "demo" | "twelvedata" | "alphavantage" | "dhan" {
  const raw = (process.env.MARKET_DATA_PROVIDER ?? "demo").toLowerCase();
  if (raw === "twelvedata" || raw === "alphavantage" || raw === "dhan") return raw;
  return "demo";
}

const DHAN_TOKEN_KEY = "market.dhanAccessToken";
const DHAN_CLIENT_KEY = "market.dhanClientId";

function jwtExpiryMs(token: string) {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function serverDhanToken() {
  const token = process.env.DHAN_ACCESS_TOKEN?.trim() ?? "";
  return token.includes(".") ? token : "";
}

async function savedDhanToken() {
  const row = await prisma.appSetting.findUnique({ where: { key: DHAN_TOKEN_KEY } });
  const saved = typeof row?.value === "string" ? row.value.trim() : "";
  return saved.includes(".") ? { token: saved, updatedAt: row?.updatedAt.toISOString() ?? null } : null;
}

export async function getDhanClientId() {
  const row = await prisma.appSetting.findUnique({ where: { key: DHAN_CLIENT_KEY } });
  const saved = typeof row?.value === "string" ? row.value.trim() : "";
  if (/^\d{4,20}$/.test(saved)) return saved;
  return process.env.DHAN_CLIENT_ID?.trim() ?? "";
}

export async function getDhanAccessToken() {
  const saved = await savedDhanToken();
  if (saved) return saved.token;
  const fromServer = serverDhanToken();
  if (fromServer) return fromServer;
  const fallback = process.env.MARKET_DATA_API_KEY?.trim() ?? "";
  if (!fallback) throw new AppError("The market-data access token is not set.", 503);
  if (!fallback.includes(".")) throw new AppError("Charts need the market-data access token. The API key cannot request prices by itself.", 503);
  return fallback;
}

export async function dhanTokenStatus() {
  const saved = await savedDhanToken();
  if (saved) {
    const expiresAt = jwtExpiryMs(saved.token);
    return {
      source: "saved" as const,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      expired: expiresAt != null && expiresAt <= Date.now(),
      updatedAt: saved.updatedAt,
    };
  }
  const fromServer = serverDhanToken() || (process.env.MARKET_DATA_API_KEY?.trim() ?? "");
  const expiresAt = fromServer.includes(".") ? jwtExpiryMs(fromServer) : null;
  return {
    source: fromServer ? "server" as const : "missing" as const,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expired: expiresAt != null && expiresAt <= Date.now(),
    updatedAt: null,
  };
}

export async function marketConnectionStatus() {
  const token = await dhanTokenStatus();
  const row = await prisma.appSetting.findUnique({ where: { key: DHAN_CLIENT_KEY } });
  const savedClient = typeof row?.value === "string" ? row.value.trim() : "";
  const clientId = /^\d{4,20}$/.test(savedClient) ? savedClient : (process.env.DHAN_CLIENT_ID?.trim() ?? "");
  return {
    clientSource: /^\d{4,20}$/.test(savedClient) ? "saved" : clientId ? "server" : "missing",
    clientTail: clientId ? clientId.slice(-4) : "",
    tokenSource: token.source,
    expiresAt: token.expiresAt,
    expired: token.expired,
    updatedAt: token.updatedAt,
  };
}

export async function saveMarketConnection(actorId: string, input: { clientId?: string; accessToken?: string; clearToken?: boolean }) {
  const clientId = input.clientId?.trim() ?? "";
  const accessToken = input.accessToken?.trim() ?? "";
  if (!clientId && !accessToken && !input.clearToken) throw new AppError("Enter a client id or an access token.");
  if (clientId && !/^\d{4,20}$/.test(clientId)) throw new AppError("Client id must be 4 to 20 digits.");
  if (accessToken && (!accessToken.includes(".") || accessToken.length < 20 || accessToken.length > 4000)) {
    throw new AppError("Paste the full access token.");
  }
  if (clientId) {
    await prisma.appSetting.upsert({
      where: { key: DHAN_CLIENT_KEY },
      create: { key: DHAN_CLIENT_KEY, value: clientId, updatedById: actorId },
      update: { value: clientId, updatedById: actorId },
    });
  }
  if (input.clearToken) {
    await prisma.appSetting.deleteMany({ where: { key: DHAN_TOKEN_KEY } });
  } else if (accessToken) {
    await prisma.appSetting.upsert({
      where: { key: DHAN_TOKEN_KEY },
      create: { key: DHAN_TOKEN_KEY, value: accessToken, updatedById: actorId },
      update: { value: accessToken, updatedById: actorId },
    });
  }
  return marketConnectionStatus();
}
