import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { logEvent } from "@/lib/audit/logger";
import { redact } from "@/lib/security/redact";

export type AuditOutcome = "SUCCESS" | "FAILURE" | "DENIED";

export type AuditInput = {
  userId: string | null;
  accountId?: string | null;
  action: string;
  correlationId: string;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
  ip?: string | null;
};

export function newCorrelationId() {
  return randomUUID();
}

/**
 * Writes one trading audit event. Details are redacted first.
 * With `required`, a failed write throws so the calling action fails closed; otherwise it is logged.
 */
export async function recordAudit(input: AuditInput, options: { required?: boolean } = {}) {
  const detail = input.detail ? (JSON.parse(JSON.stringify(redact(input.detail))) as Prisma.InputJsonValue) : undefined;
  try {
    await prisma.tradingAuditEvent.create({
      data: {
        userId: input.userId,
        accountId: input.accountId ?? null,
        action: input.action,
        correlationId: input.correlationId,
        outcome: input.outcome,
        detail,
        ipAddress: input.ip ?? null,
      },
    });
  } catch (error) {
    logEvent("error", "audit.write_failed", { action: input.action, correlationId: input.correlationId, error });
    if (options.required) throw new AppError("The action was stopped because its audit record could not be saved. Nothing was changed at the broker.", 503, "AUDIT_UNAVAILABLE");
  }
}
