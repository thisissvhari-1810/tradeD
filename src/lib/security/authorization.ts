import { AppError } from "@/lib/http";
import type { SessionUser } from "@/server/auth";

/**
 * Broker-account access rules. Ownership is the only grant: role does not widen it, so an admin
 * cannot read or act on another user's broker account. A missing and a foreign account look the same.
 */

export const ACCOUNT_NOT_FOUND = "Broker account not found.";

export function assertMayManageBrokerAccounts(user: Pick<SessionUser, "status">) {
  if (user.status !== "ACTIVE") throw new AppError("Your TradeD user is not active, so broker accounts cannot be changed.", 403, "USER_INACTIVE");
}

export function assertOwnsAccount<T extends { ownerId: string }>(user: Pick<SessionUser, "id">, account: T | null | undefined): T {
  if (!account || account.ownerId !== user.id) throw new AppError(ACCOUNT_NOT_FOUND, 404, "ACCOUNT_NOT_FOUND");
  return account;
}
