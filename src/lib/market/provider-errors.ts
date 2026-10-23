/**
 * Dhan (market data provider) failures, classified once so every request handles them the same way:
 * what to tell the user, whether a retry can help, and whether a different date range might work.
 * Codes follow Dhan's annexure (DH-901 … DH-910).
 */

export type ProviderFailureKind = "credentials" | "subscription" | "rate-limit" | "bad-request" | "no-data" | "unavailable" | "other";

export type ProviderFailure = {
  kind: ProviderFailureKind;
  /** The provider's code (e.g. DH-905) or HTTP status. */
  code: string;
  /** HTTP status to answer the app's own client with. */
  status: number;
  /** A transient failure: the same request may succeed shortly (rate limit, server or network fault). */
  retryable: boolean;
  /** Shown to the user: what happened and what to do. Never contains tokens or raw request data. */
  userMessage: string;
};

const MESSAGES: Record<ProviderFailureKind, string> = {
  credentials: "Dhan did not accept the access token (it may have expired). Update the Dhan token in Admin, then retry.",
  subscription: "This Dhan account has no Data API access. Activate Data APIs in Dhan, then retry.",
  "rate-limit": "Dhan is limiting requests right now. Wait a few seconds and retry.",
  "bad-request": "Dhan did not accept the requested period for this chart.",
  "no-data": "Dhan returned no data for this period.",
  unavailable: "Dhan is temporarily unavailable. Retry in a moment.",
  other: "Dhan could not return market data.",
};

export function classifyProviderFailure(status: number, payload: { errorCode?: string; errorType?: string } | null): ProviderFailure {
  const code = payload?.errorCode?.trim() || `HTTP ${status}`;
  const kind: ProviderFailureKind =
    code === "DH-901" || status === 401 ? "credentials"
      : code === "DH-902" || code === "DH-903" || status === 403 ? "subscription"
        : code === "DH-904" || status === 429 ? "rate-limit"
          : code === "DH-905" || code === "DH-906" ? "bad-request"
            : code === "DH-907" ? "no-data"
              : code === "DH-908" || code === "DH-909" || status >= 500 ? "unavailable"
                : "other";
  return {
    kind,
    code,
    status: kind === "credentials" || kind === "subscription" ? 503 : kind === "rate-limit" ? 429 : kind === "unavailable" ? 503 : 502,
    retryable: kind === "rate-limit" || kind === "unavailable",
    userMessage: MESSAGES[kind],
  };
}

/** No answer in time, or the network failed: transient. */
export function timeoutFailure(): ProviderFailure {
  return { kind: "unavailable", code: "TIMEOUT", status: 504, retryable: true, userMessage: "Dhan did not respond in time. Retry in a moment." };
}

/**
 * Runs `task`, retrying transient failures after each delay (bounded: at most delays.length extra tries).
 * Anything not retryable is thrown at once.
 */
export async function withRetries<T>(task: () => Promise<T>, isRetryable: (error: unknown) => boolean, delays: number[] = [400, 1200]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= delays.length || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
