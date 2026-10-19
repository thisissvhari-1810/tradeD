import { createHash, createHmac, randomUUID } from "crypto";
import { AppError } from "@/lib/http";
import { executionServiceConfigured } from "@/lib/security/flags";

/**
 * Signed calls from TradeD to the static-IP execution worker. The signature covers timestamp, nonce,
 * method, path and body, so a captured request can be neither altered nor replayed.
 */

export type WorkerOutcome = { outcome: "ACCEPTED"; orderId: string; orderStatus: string; recovered?: boolean } | { outcome: "REJECTED"; message: string; brokerCode?: string | null } | { outcome: "UNKNOWN"; message: string };

/** The request may have reached the worker (and so Dhan): the caller must reconcile before any retry. */
export class ExecutionUncertainError extends AppError {
  constructor(message: string) {
    super(message, 504, "EXECUTION_UNCERTAIN");
  }
}

export function signRequest(secret: string, method: string, path: string, body: string, now = Date.now(), nonce = randomUUID()) {
  const timestamp = String(now);
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret).update([timestamp, nonce, method.toUpperCase(), path, digest].join("\n")).digest("hex");
  return { "x-traded-timestamp": timestamp, "x-traded-nonce": nonce, "x-traded-signature": signature };
}

export async function callWorker(path: "/v1/orders/place" | "/v1/orders/cancel", payload: unknown, options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): Promise<WorkerOutcome> {
  const env = options.env ?? process.env;
  if (!executionServiceConfigured(env)) throw new AppError("The execution server is not configured.", 503, "EXECUTION_NOT_CONFIGURED");
  const base = (env.EXECUTION_SERVICE_URL ?? "").replace(/\/+$/, "");
  const body = JSON.stringify(payload);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signRequest(env.EXECUTION_SERVICE_SECRET ?? "", "POST", path, body) },
      body,
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    throw new ExecutionUncertainError("The execution server did not answer. The order may or may not have reached Dhan; check its status before trying again.");
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  // 4xx from the worker means it refused the request before contacting Dhan.
  if (response.status >= 400 && response.status < 500) throw new AppError(`Not sent: ${typeof data?.error === "string" ? data.error : `execution server returned ${response.status}`}.`, 502, "EXECUTION_REFUSED");
  if (response.status === 503 && data?.code === "ORDERS_DISABLED") throw new AppError("Not sent: order placement is switched off on the execution server.", 503, "EXECUTION_REFUSED");
  if (!response.ok || !data || typeof data.outcome !== "string") throw new ExecutionUncertainError("The execution server failed while handling the order. Check its status before trying again.");
  return data as WorkerOutcome;
}
