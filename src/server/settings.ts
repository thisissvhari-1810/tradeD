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

export async function getDhanAccessToken() {
  const fromServer = serverDhanToken();
  if (fromServer) return fromServer;
  const row = await prisma.appSetting.findUnique({ where: { key: DHAN_TOKEN_KEY } });
  const saved = typeof row?.value === "string" ? row.value.trim() : "";
  const token = saved.includes(".") ? saved : (process.env.MARKET_DATA_API_KEY?.trim() ?? "");
  if (!token) throw new AppError("The market-data access token is not set.", 503);
  if (!token.includes(".")) throw new AppError("Charts need the market-data access token. The API key cannot request prices by itself.", 503);
  return token;
}

export async function dhanTokenStatus() {
  const fromServer = serverDhanToken();
  if (fromServer) {
    const expiresAt = jwtExpiryMs(fromServer);
    return {
      source: "server",
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      expired: expiresAt != null && expiresAt <= Date.now(),
      updatedAt: null,
    };
  }
  const row = await prisma.appSetting.findUnique({ where: { key: DHAN_TOKEN_KEY } });
  const saved = typeof row?.value === "string" ? row.value.trim() : "";
  const usingSaved = saved.includes(".");
  const token = usingSaved ? saved : (process.env.MARKET_DATA_API_KEY?.trim() ?? "");
  const expiresAt = token.includes(".") ? jwtExpiryMs(token) : null;
  return {
    source: usingSaved ? "saved" : token ? "server" : "missing",
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expired: expiresAt != null && expiresAt <= Date.now(),
    updatedAt: usingSaved ? row?.updatedAt.toISOString() ?? null : null,
  };
}
