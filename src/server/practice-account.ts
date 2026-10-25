import type { PracticeMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { openStudentAccount } from "@/server/users";
import { getTradingSettings } from "@/server/settings";
import { ALGO_STARTING_CAPITAL_PAISE } from "@/lib/algo/capital";

export type { PracticeMode };

/**
 * Each user has up to three practice wallets: DEMO (demo screens and historical replay), LIVE (paper
 * trading at live prices in Live view) and ALGO (the Strategy Algo only). They never share cash,
 * positions or history.
 * The browser names the active view in the x-td-mode header; anything else means DEMO.
 */
export function practiceModeOf(request: Request): PracticeMode {
  return request.headers.get("x-td-mode") === "live" ? "LIVE" : "DEMO";
}

/**
 * The wallet a read-only view asks for: ?wallet=algo reads the Algo wallet. Orders never use this, so
 * no manual order can be placed with (or charged to) the Algo wallet.
 */
export function viewModeOf(request: Request): PracticeMode {
  return new URL(request.url).searchParams.get("wallet") === "algo" ? "ALGO" : practiceModeOf(request);
}

export function walletKey(userId: string, mode: PracticeMode) {
  return { userId_mode: { userId, mode } };
}

/**
 * The wallet for this view, opened on first use with the configured starting capital (₹1,00,000 by default),
 * or, for the Algo wallet, its own fixed starting capital. An existing wallet is never re-opened or reset.
 */
export async function ensurePracticeAccount(userId: string, mode: PracticeMode) {
  const found = await prisma.virtualAccount.findUnique({ where: walletKey(userId, mode) });
  if (found) return found;
  const startingCapitalPaise = mode === "ALGO" ? ALGO_STARTING_CAPITAL_PAISE : (await getTradingSettings()).startingCapitalPaise;
  try {
    return await prisma.$transaction((tx) => openStudentAccount(tx, userId, startingCapitalPaise, userId, mode));
  } catch (error) {
    // Another request opened it at the same moment.
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002") {
      return prisma.virtualAccount.findUniqueOrThrow({ where: walletKey(userId, mode) });
    }
    throw error;
  }
}
