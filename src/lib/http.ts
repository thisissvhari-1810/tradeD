import { ZodError, type ZodType } from "zod";
import { logEvent } from "@/lib/audit/logger";

export type ErrorBody = { error: string; code: string; message: string; field?: string; details?: Record<string, unknown> };

export class AppError extends Error {
  status: number;
  code: string;
  field?: string;
  details?: Record<string, unknown>;

  constructor(message: string, status = 400, code?: string, extra?: { field?: string; details?: Record<string, unknown> }) {
    super(message);
    this.status = status;
    this.code = code ?? (status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 503 ? "UNAVAILABLE" : "BAD_REQUEST");
    this.field = extra?.field;
    this.details = extra?.details;
  }
}

export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(issue?.message ?? "Invalid input.", 400, "INVALID_INPUT", { field: issue?.path.join(".") || undefined });
  }
  return parsed.data;
}

function body(code: string, message: string, extra?: { field?: string; details?: Record<string, unknown> }): ErrorBody {
  return { error: message, code, message, ...(extra?.field ? { field: extra.field } : {}), ...(extra?.details ? { details: extra.details } : {}) };
}

/** Known database failures that are safe to retry and must not surface as a raw 500. */
function databaseError(error: unknown): { status: number; code: string; message: string } | null {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "P2028" || code === "P2034") return { status: 503, code: "LEDGER_BUSY", message: "The demo ledger took too long to confirm this order. Nothing was charged. Please retry." };
  if (code === "P1001" || code === "P1002" || code === "P1008" || code === "P1017" || code === "P2024") return { status: 503, code: "DATABASE_UNAVAILABLE", message: "The account database is not responding. Nothing was charged. Please retry in a moment." };
  return null;
}

export function jsonError(error: unknown): Response {
  if (error instanceof AppError) return Response.json(body(error.code, error.message, { field: error.field, details: error.details }), { status: error.status });
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return Response.json(body("INVALID_INPUT", issue?.message ?? "Invalid input.", { field: issue?.path.join(".") || undefined }), { status: 400 });
  }
  logEvent("error", "request.failed", { error });
  const known = databaseError(error);
  if (known) return Response.json(body(known.code, known.message), { status: known.status });
  return Response.json(body("INTERNAL", "Something went wrong on the server. Nothing was charged. Please retry."), { status: 500 });
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) throw new AppError("This request was blocked because it did not come from TradeD. Reload the page and try again.", 403, "BAD_ORIGIN");
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError("This request was blocked because it did not come from TradeD. Reload the page and try again.", 403, "BAD_ORIGIN");
  }
  if (originHost !== host) throw new AppError("This request was blocked because it did not come from TradeD. Reload the page and try again.", 403, "BAD_ORIGIN");
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return "unknown";
}
