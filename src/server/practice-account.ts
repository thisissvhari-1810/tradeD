import type { PracticeMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { openStudentAccount } from "@/server/users";
import { getTradingSettings } from "@/server/settings";

export type { PracticeMode };

/**
 * Each user has up to two practice wallets: DEMO (demo screens and historical replay) and LIVE
 * (paper trading at live prices in Live view). They never share cash, positions or history.
 * The browser names the active view in the x-td-mode header; anything else means DEMO.
 */
export function practiceModeOf(request: Request): PracticeMode {
  return request.headers.get("x-td-mode") === "live" ? "LIVE" : "DEMO";
}

export function walletKey(userId: string, mode: PracticeMode) {
  return { userId_mode: { userId, mode } };
}

/** The wallet for this view, opened with the configured starting capital (₹1,00,000 by default) on first use. */
export async function ensurePracticeAccount(userId: string, mode: PracticeMode) {
  const found = await prisma.virtualAccount.findUnique({ where: walletKey(userId, mode) });
  if (found) return found;
  const { startingCapitalPaise } = await getTradingSettings();
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
