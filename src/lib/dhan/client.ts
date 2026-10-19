import { AppError } from "@/lib/http";
import { redactString } from "@/lib/security/redact";

/**
 * Minimal authenticated DhanHQ v2 REST client. One instance per broker credential, so no request
 * can borrow another account's token. Tokens go only into request headers and never into errors or logs.
 */

export const DHAN_API = "https://api.dhan.co/v2";

export type DhanCredentials = { clientId: string; accessToken: string };

export type BrokerFailure =
  | "AUTH_EXPIRED"
  | "NO_DATA_PLAN"
  | "RATE_LIMITED"
  | "INPUT"
  | "ORDER_REJECTED"
  | "BROKER"
  | "TIMEOUT"
  | "NETWORK";

/**
 * A broker call that failed. `uncertain` is true when a state-changing request may have reached the
 * broker (timeout or dropped connection): callers must reconcile before ever retrying it.
 */
export class BrokerError extends AppError {
  failure: BrokerFailure;
  brokerCode: string | null;
  uncertain: boolean;

  constructor(message: string, failure: BrokerFailure, options: { status?: number; brokerCode?: string | null; uncertain?: boolean } = {}) {
    super(message, options.status ?? (failure === "RATE_LIMITED" ? 429 : failure === "INPUT" ? 400 : failure === "TIMEOUT" ? 504 : 502), `BROKER_${failure}`);
    this.failure = failure;
    this.brokerCode = options.brokerCode ?? null;
    this.uncertain = options.uncertain ?? false;
  }
}

/** Dhan error codes from the v2 annexure, mapped to how TradeD must react. */
const CODE_FAILURE: Record<string, BrokerFailure> = {
  "DH-901": "AUTH_EXPIRED",
  "DH-902": "NO_DATA_PLAN",
  "DH-903": "BROKER",
  "DH-904": "RATE_LIMITED",
  "DH-905": "INPUT",
  "DH-906": "ORDER_REJECTED",
  "DH-907": "BROKER",
  "DH-908": "BROKER",
  "DH-909": "NETWORK",
  "DH-910": "BROKER",
};

type ErrorPayload = { errorCode?: unknown; errorMessage?: unknown; errorType?: unknown; remarks?: unknown };

export function classifyBrokerResponse(status: number, payload: unknown): BrokerError {
  const body = (payload && typeof payload === "object" ? payload : {}) as ErrorPayload;
  const code = typeof body.errorCode === "string" ? body.errorCode : null;
  const text = [body.errorMessage, body.remarks].find((item): item is string => typeof item === "string" && item.trim().length > 0);
  const failure = (code && CODE_FAILURE[code]) || (status === 401 || status === 403 ? "AUTH_EXPIRED" : status === 429 ? "RATE_LIMITED" : status === 400 ? "INPUT" : "BROKER");
  const message = failure === "AUTH_EXPIRED"
    ? "The broker rejected this account's authorization. Reconnect the account."
    : redactString(text?.slice(0, 300) ?? `Dhan returned ${status}.`);
  return new BrokerError(message, failure, { brokerCode: code });
}

/** Expiry from the JWT `exp` claim, or null when the token is not a readable JWT. */
export function tokenExpiry(token: string): Date | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

export type DhanClientOptions = { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number };

export function createDhanClient(credentials: DhanCredentials, options: DhanClientOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? DHAN_API;
  const timeoutMs = options.timeoutMs ?? 12_000;
  if (!/^\d{4,20}$/.test(credentials.clientId)) throw new BrokerError("The broker client id is not valid.", "AUTH_EXPIRED", { status: 503 });
  if (!credentials.accessToken.includes(".")) throw new BrokerError("The broker access token is missing.", "AUTH_EXPIRED", { status: 503 });

  async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const mutating = method !== "GET";
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "access-token": credentials.accessToken,
          "client-id": credentials.clientId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const outcome = mutating ? " The request may have reached the broker; check its status before retrying." : "";
      throw new BrokerError(
        timedOut ? `The broker did not respond in time.${outcome}` : `The broker could not be reached.${outcome}`,
        timedOut ? "TIMEOUT" : "NETWORK",
        { uncertain: mutating },
      );
    }
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const failure = classifyBrokerResponse(response.status, payload);
      // A 5xx on a write leaves the outcome unknown just like a timeout.
      if (mutating && response.status >= 500) failure.uncertain = true;
      throw failure;
    }
    return payload as T;
  }

  return {
    get: <T = unknown>(path: string) => request<T>("GET", path),
    post: <T = unknown>(path: string, body: unknown) => request<T>("POST", path, body),
    put: <T = unknown>(path: string, body: unknown) => request<T>("PUT", path, body),
    delete: <T = unknown>(path: string) => request<T>("DELETE", path),
  };
}

export type DhanClient = ReturnType<typeof createDhanClient>;
