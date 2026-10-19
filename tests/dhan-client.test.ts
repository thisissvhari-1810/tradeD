import { describe, expect, it, vi } from "vitest";
import { BrokerError, classifyBrokerResponse, createDhanClient, tokenExpiry } from "../src/lib/dhan/client";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTk5OTk5OTl9.c2lnbmF0dXJl";
const creds = { clientId: "1100012345", accessToken: TOKEN };

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

async function failure(promise: Promise<unknown>): Promise<BrokerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrokerError) return error;
    throw error;
  }
  throw new Error("expected a broker error");
}

describe("Dhan client", () => {
  it("sends credentials only as headers and returns the payload", async () => {
    const fetch = reply(200, { availabelBalance: 10 });
    const client = createDhanClient(creds, { fetch, baseUrl: "https://broker.test" });
    await expect(client.get("/fundlimit")).resolves.toEqual({ availabelBalance: 10 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://broker.test/fundlimit");
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["access-token"]).toBe(TOKEN);
    expect((init.headers as Record<string, string>)["client-id"]).toBe("1100012345");
  });

  it("maps an expired token to AUTH_EXPIRED without echoing the token", async () => {
    const error = await failure(createDhanClient(creds, { fetch: reply(401, { errorCode: "DH-901", errorMessage: `Invalid token ${TOKEN}` }) }).get("/profile"));
    expect(error.failure).toBe("AUTH_EXPIRED");
    expect(error.message).not.toContain("eyJ");
    expect(error.uncertain).toBe(false);
  });

  it("maps missing data plan, rate limits and bad input", () => {
    expect(classifyBrokerResponse(400, { errorCode: "DH-902" }).failure).toBe("NO_DATA_PLAN");
    expect(classifyBrokerResponse(429, {}).failure).toBe("RATE_LIMITED");
    expect(classifyBrokerResponse(400, { errorCode: "DH-905", errorMessage: "Missing field" }).message).toBe("Missing field");
    expect(classifyBrokerResponse(400, { errorCode: "DH-906", errorMessage: "Insufficient funds" }).failure).toBe("ORDER_REJECTED");
  });

  it("marks a timed-out read as failed but a timed-out write as uncertain", async () => {
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const read = await failure(createDhanClient(creds, { fetch: timeout }).get("/orders"));
    expect(read.failure).toBe("TIMEOUT");
    expect(read.uncertain).toBe(false);
    const write = await failure(createDhanClient(creds, { fetch: timeout }).post("/orders", { quantity: 1 }));
    expect(write.uncertain).toBe(true);
    expect(write.message).toMatch(/check its status before retrying/);
  });

  it("treats a 5xx on a write as uncertain", async () => {
    const error = await failure(createDhanClient(creds, { fetch: reply(502, {}) }).post("/orders", {}));
    expect(error.uncertain).toBe(true);
  });

  it("refuses to build a client from missing or malformed credentials", () => {
    expect(() => createDhanClient({ clientId: "abc", accessToken: TOKEN })).toThrow(BrokerError);
    expect(() => createDhanClient({ clientId: "1100012345", accessToken: "" })).toThrow(BrokerError);
  });

  it("reads JWT expiry", () => {
    expect(tokenExpiry(TOKEN)?.getTime()).toBe(1_799_999_999_000);
    expect(tokenExpiry("not-a-jwt")).toBeNull();
  });
});
