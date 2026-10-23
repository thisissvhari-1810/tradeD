import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyProviderFailure, withRetries } from "@/lib/market/provider-errors";

// The Dhan module reads its token and client id from settings (database); the tests supply them.
vi.mock("@/server/settings", () => ({
  getDhanAccessToken: async () => "test-token",
  getDhanClientId: async () => "1000000001",
}));

const { dhanCandles } = await import("@/server/dhan-market");

/** UTC seconds for an IST wall-clock time. */
const ist = (day: string, hour: number, minute: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hour, minute) / 1000) - 19_800;
};
const istDay = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

type Request = { path: string; body: Record<string, unknown> };
type Answer = { status: number; json: unknown };

/**
 * A simulated Dhan, behaving as production did: an end time on a day that has not opened yet is
 * refused (DH-905), as is a 2005 start for daily history. Bars exist only on trading days.
 */
function simulatedDhan(now: number, options: { holidays?: string[]; override?: (request: Request, call: number) => Answer | null } = {}) {
  const calls: Request[] = [];
  const holidays = new Set(options.holidays ?? []);
  const today = istDay(now);
  const trading = (day: string) => weekday(day) !== 0 && weekday(day) !== 6 && !holidays.has(day);
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  };
  const refused = { status: 400, json: { errorType: "Input_Exception", errorCode: "DH-905", errorMessage: "Missing required fields, bad values for parameters etc." } };
  const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const path = url.replace("https://api.dhan.co/v2", "");
    const body = JSON.parse(init.body) as Record<string, string>;
    const request = { path, body };
    calls.push(request);
    const special = options.override?.(request, calls.length);
    const answer: Answer = special ?? (() => {
      const toDay = body.toDate.slice(0, 10);
      if (path === "/charts/intraday") {
        // An end on today before the 09:15 open (or in the future) is refused.
        if (toDay > today || (toDay === today && now < ist(today, 9, 15))) return refused;
        const end = toDay === today ? Math.min(now, ist(today, 15, 30)) : ist(toDay, 15, 30);
        const series = { open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[], timestamp: [] as number[] };
        for (const day of days(body.fromDate.slice(0, 10), toDay).filter(trading)) {
          for (const [hour, minute] of [[9, 15], [12, 0], [15, 29]] as const) {
            const time = ist(day, hour, minute);
            if (time + 60 > end) continue;
            const base = 22_000 + Number(day.slice(8, 10));
            series.open.push(base); series.high.push(base + 5); series.low.push(base - 5); series.close.push(base + 1); series.volume.push(100); series.timestamp.push(time);
          }
        }
        return { status: 200, json: series };
      }
      // Daily: refused for a 2005 start or an end after tomorrow; the end date is exclusive.
      if (body.fromDate < "2006-01-01") return refused;
      const series = { open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[], timestamp: [] as number[] };
      for (const day of days(body.fromDate, toDay).filter((day) => trading(day) && day < toDay && day < today)) {
        series.open.push(21_000); series.high.push(21_100); series.low.push(20_900); series.close.push(21_050); series.volume.push(1_000); series.timestamp.push(ist(day, 0, 0));
      }
      return { status: 200, json: series };
    })();
    return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function at(day: string, hour: number, minute: number) {
  const seconds = ist(day, hour, minute);
  vi.setSystemTime(new Date(seconds * 1000));
  return seconds;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chart data around the trading session (simulated Dhan)", () => {
  it("before the 09:15 open: steps back to the last close and returns only real bars", async () => {
    const now = at("2026-10-23", 9, 13);
    const dhan = simulatedDhan(now);
    const result = await dhanCandles("NIFTY", "", "1m", new Date(now * 1000));
    expect(dhan.calls[0].body.toDate).toBe("2026-10-23 09:13:00");
    expect(dhan.calls.some((call) => call.body.toDate === "2026-10-22 15:30:00")).toBe(true);
    expect(result.candles.length).toBeGreaterThan(0);
    expect(istDay(result.candles[result.candles.length - 1].time)).toBe("2026-10-22");
    expect(result.candles.every((candle) => istDay(candle.time) <= "2026-10-22")).toBe(true);
  });

  it("during the session: the first request is accepted and includes today's bars so far", async () => {
    const now = at("2026-10-23", 12, 30);
    const dhan = simulatedDhan(now);
    const result = await dhanCandles("NIFTY", "", "1m", new Date(now * 1000));
    expect(dhan.calls).toHaveLength(1);
    expect(result.candles.some((candle) => candle.time === ist("2026-10-23", 12, 0))).toBe(true);
    expect(result.candles.every((candle) => candle.time + 60 <= now)).toBe(true);
  });

  it("after the close: today's full session including 15:29", async () => {
    const now = at("2026-10-23", 16, 30);
    simulatedDhan(now);
    const result = await dhanCandles("NIFTY", "", "5m", new Date(now * 1000));
    expect(result.candles.length).toBeGreaterThan(0);
    expect(istDay(result.candles[result.candles.length - 1].time)).toBe("2026-10-23");
  });

  it("with yesterday a holiday: falls back past it to the last trading day, inventing nothing", async () => {
    const now = at("2026-10-23", 9, 0);
    simulatedDhan(now, { holidays: ["2026-10-22"] });
    const result = await dhanCandles("NIFTY", "", "1m", new Date(now * 1000));
    const days = new Set(result.candles.map((candle) => istDay(candle.time)));
    expect(days.has("2026-10-22")).toBe(false);
    expect(istDay(result.candles[result.candles.length - 1].time)).toBe("2026-10-21");
  });

  it("daily history: a refused 2005 start is retried with a 5-year start", async () => {
    const now = at("2026-10-23", 11, 0);
    const dhan = simulatedDhan(now);
    const result = await dhanCandles("NIFTY", "", "1d", new Date(now * 1000));
    const daily = dhan.calls.filter((call) => call.path === "/charts/historical");
    expect(daily[0].body.fromDate).toBe("2005-01-01");
    expect(daily.some((call) => String(call.body.fromDate) >= "2021-01-01")).toBe(true);
    expect(result.candles.length).toBeGreaterThan(1000);
  });
});

describe("provider failures (simulated Dhan)", () => {
  it("an expired token fails fast with a clear message and no range retries", async () => {
    const now = at("2026-10-23", 11, 0);
    const dhan = simulatedDhan(now, { override: () => ({ status: 401, json: { errorCode: "DH-901", errorMessage: "Invalid token" } }) });
    await expect(dhanCandles("NIFTY", "", "1m", new Date(now * 1000))).rejects.toThrow(/access token/);
    expect(dhan.calls).toHaveLength(1);
  });

  it("a rate limit is retried and then succeeds", async () => {
    const now = at("2026-10-23", 11, 0);
    const dhan = simulatedDhan(now, { override: (_request, call) => (call === 1 ? { status: 429, json: { errorCode: "DH-904", errorMessage: "Too many requests" } } : null) });
    const result = await dhanCandles("NIFTY", "", "1m", new Date(now * 1000));
    expect(dhan.calls).toHaveLength(2);
    expect(result.candles.length).toBeGreaterThan(0);
  });

  it("a lasting server fault is retried twice, then reported as temporarily unavailable", async () => {
    const now = at("2026-10-23", 11, 0);
    const dhan = simulatedDhan(now, { override: () => ({ status: 500, json: { errorCode: "DH-908", errorMessage: "Internal error" } }) });
    await expect(dhanCandles("NIFTY", "", "1m", new Date(now * 1000))).rejects.toThrow(/temporarily unavailable/);
    expect(dhan.calls).toHaveLength(3);
  });

  it("no answer in time is reported clearly and not retried", async () => {
    const now = at("2026-10-23", 11, 0);
    const fetchMock = vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(dhanCandles("NIFTY", "", "1m", new Date(now * 1000))).rejects.toThrow(/did not respond in time/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an empty answer is an error, never an invented candle", async () => {
    const now = at("2026-10-23", 11, 0);
    simulatedDhan(now, { override: () => ({ status: 200, json: { open: [], high: [], low: [], close: [], volume: [], timestamp: [] } }) });
    await expect(dhanCandles("NIFTY", "", "1m", new Date(now * 1000))).rejects.toThrow(/not returned/);
  });

  it("the user never sees raw provider text or the request", async () => {
    const now = at("2026-10-23", 11, 0);
    simulatedDhan(now, { override: () => ({ status: 401, json: { errorCode: "DH-901", errorMessage: "Invalid token xyz" } }) });
    const error = await dhanCandles("NIFTY", "", "1m", new Date(now * 1000)).catch((reason: unknown) => reason as Error);
    expect(error.message).not.toMatch(/xyz|securityId|test-token/);
    expect(error.message).toMatch(/\(DH-901\)$/);
  });
});

describe("provider error classification and retries", () => {
  it("maps Dhan codes to kinds, statuses and retryability", () => {
    expect(classifyProviderFailure(401, { errorCode: "DH-901" })).toMatchObject({ kind: "credentials", retryable: false });
    expect(classifyProviderFailure(403, { errorCode: "DH-902" })).toMatchObject({ kind: "subscription", retryable: false });
    expect(classifyProviderFailure(429, null)).toMatchObject({ kind: "rate-limit", retryable: true, status: 429 });
    expect(classifyProviderFailure(400, { errorCode: "DH-905" })).toMatchObject({ kind: "bad-request", retryable: false });
    expect(classifyProviderFailure(400, { errorCode: "DH-907" })).toMatchObject({ kind: "no-data" });
    expect(classifyProviderFailure(502, null)).toMatchObject({ kind: "unavailable", retryable: true, code: "HTTP 502" });
  });

  it("retries are bounded and skip non-retryable errors", async () => {
    let calls = 0;
    await expect(withRetries(async () => { calls += 1; throw new Error("x"); }, () => true, [1, 1])).rejects.toThrow("x");
    expect(calls).toBe(3);
    calls = 0;
    await expect(withRetries(async () => { calls += 1; throw new Error("y"); }, () => false, [1, 1])).rejects.toThrow("y");
    expect(calls).toBe(1);
  });
});
