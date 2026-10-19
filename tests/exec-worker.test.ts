import { describe, expect, it, vi } from "vitest";
import { createNonceStore, handle, loadConfig, placeOrder, validatePlace, verifyRequest } from "../exec-worker/lib.mjs";
import { signRequest } from "../src/server/execution-client";

const SECRET = "s".repeat(40);
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.c2ln";
const credentials = { clientId: "1114171746", accessToken: TOKEN };
const order = { correlationId: "td0123456789abcdef01234567", transactionType: "BUY", exchangeSegment: "NSE_FNO", productType: "INTRADAY", orderType: "MARKET", securityId: "49081", quantity: 75, price: 0 };

function config(fetchImpl: typeof fetch = vi.fn(), extra: Record<string, string> = {}) {
  return loadConfig({ EXECUTION_SERVICE_SECRET: SECRET, ALLOWED_CLIENT_IDS: "1114171746", ORDERS_ENABLED: "true", ...extra }, fetchImpl);
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function signed(path: string, payload: unknown, now = Date.now()) {
  const body = JSON.stringify(payload);
  return { method: "POST", path, body, headers: signRequest(SECRET, "POST", path, body, now) as Record<string, string> };
}

describe("worker request signing", () => {
  it("accepts TradeD's signature and rejects tampering, staleness and replay", () => {
    const nonces = createNonceStore();
    const now = Date.now();
    const request = signed("/v1/orders/place", { order }, now);
    expect(verifyRequest({ secret: SECRET, ...request, now, nonces })).toBeNull();
    expect(verifyRequest({ secret: SECRET, ...request, now, nonces })).toBe("replayed request");

    const fresh = signed("/v1/orders/place", { order }, now);
    expect(verifyRequest({ secret: SECRET, ...fresh, body: fresh.body.replace("75", "750"), now, nonces: createNonceStore() })).toBe("bad signature");
    expect(verifyRequest({ secret: SECRET, ...fresh, path: "/v1/orders/cancel", now, nonces: createNonceStore() })).toBe("bad signature");
    expect(verifyRequest({ secret: "x".repeat(40), ...fresh, now, nonces: createNonceStore() })).toBe("bad signature");
    expect(verifyRequest({ secret: SECRET, ...fresh, now: now + 31_000, nonces: createNonceStore() })).toBe("stale request");
    expect(verifyRequest({ secret: SECRET, ...fresh, headers: {}, now, nonces: createNonceStore() })).toBe("missing signature");
  });

  it("refuses unsigned requests and serves an unauthenticated health check", async () => {
    const cfg = config();
    expect((await handle({ method: "POST", path: "/v1/orders/place", headers: {}, body: "{}" }, cfg, createNonceStore())).status).toBe(401);
    const health = await handle({ method: "GET", path: "/health", headers: {}, body: "" }, cfg, createNonceStore());
    expect(health).toMatchObject({ status: 200, json: { ok: true, ordersEnabled: true } });
    expect(JSON.stringify(health.json)).not.toContain(SECRET);
  });

  it("refuses to start with a weak secret or no allowed client", () => {
    expect(() => loadConfig({ EXECUTION_SERVICE_SECRET: "short", ALLOWED_CLIENT_IDS: "1114171746" })).toThrow(/32-128 letters/);
    expect(() => loadConfig({ EXECUTION_SERVICE_SECRET: SECRET, ALLOWED_CLIENT_IDS: "" })).toThrow(/ALLOWED_CLIENT_IDS/);
  });

  it("returns 503 without contacting Dhan when orders are switched off", async () => {
    const fetchImpl = vi.fn();
    const result = await handle(signed("/v1/orders/place", { credentials, order }), config(fetchImpl, { ORDERS_ENABLED: "false" }), createNonceStore());
    expect(result.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("worker order validation", () => {
  const cfg = config();
  it("only trades the registered client", () => {
    expect(validatePlace({ credentials: { ...credentials, clientId: "9999999999" }, order }, cfg)).toMatch(/not registered/);
  });
  it("rejects malformed orders", () => {
    expect(validatePlace({ credentials, order: { ...order, price: 10 } }, cfg)).toMatch(/market order/);
    expect(validatePlace({ credentials, order: { ...order, orderType: "LIMIT", price: 0 } }, cfg)).toMatch(/limit order needs/);
    expect(validatePlace({ credentials, order: { ...order, productType: "CNC" } }, cfg)).toMatch(/equity only/);
    expect(validatePlace({ credentials, order: { ...order, quantity: 0 } }, cfg)).toMatch(/Quantity/);
    expect(validatePlace({ credentials, order: { ...order, quantity: 5000 } }, cfg)).toMatch(/Quantity/);
    expect(validatePlace({ credentials, order: { ...order, correlationId: "bad id!" } }, cfg)).toMatch(/correlation/);
    expect(validatePlace({ credentials, order: { ...order, exchangeSegment: "MCX_COMM" } }, cfg)).toMatch(/segment/);
    expect(validatePlace({ credentials, order }, cfg)).toBeNull();
  });
});

describe("worker placement", () => {
  it("sends the documented Dhan payload and reports the broker order id", async () => {
    const fetchImpl = vi.fn(async () => reply(200, { orderId: "112111182198", orderStatus: "TRANSIT" }));
    const result = await placeOrder({ credentials, order }, config(fetchImpl as unknown as typeof fetch));
    expect(result).toEqual({ outcome: "ACCEPTED", orderId: "112111182198", orderStatus: "TRANSIT" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.dhan.co/v2/orders");
    expect(JSON.parse(String(init.body))).toEqual({ dhanClientId: "1114171746", correlationId: order.correlationId, transactionType: "BUY", exchangeSegment: "NSE_FNO", productType: "INTRADAY", orderType: "MARKET", validity: "DAY", securityId: "49081", quantity: 75, price: 0, afterMarketOrder: false });
    expect((init.headers as Record<string, string>)["access-token"]).toBe(TOKEN);
  });

  it("reports a broker rejection without retrying", async () => {
    const fetchImpl = vi.fn(async () => reply(400, { errorCode: "DH-906", errorMessage: "Insufficient margin" }));
    const result = await placeOrder({ credentials, order }, config(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ outcome: "REJECTED", message: "Insufficient margin" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("after a timeout, recovers the order by correlation id instead of resending", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/orders")) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return reply(200, [{ orderId: "555", orderStatus: "PENDING", correlationId: order.correlationId }]);
    });
    const result = await placeOrder({ credentials, order }, config(fetchImpl as unknown as typeof fetch));
    expect(result).toMatchObject({ outcome: "ACCEPTED", orderId: "555", recovered: true });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/orders"))).toHaveLength(1);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`https://api.dhan.co/v2/orders/external/${order.correlationId}`);
  });

  it("reports UNKNOWN when Dhan cannot confirm either way", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("/orders") ? reply(502, {}) : reply(404, { errorCode: "DH-907" })));
    const result = await placeOrder({ credentials, order }, config(fetchImpl as unknown as typeof fetch));
    expect(result.outcome).toBe("UNKNOWN");
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/orders"))).toHaveLength(1);
  });

  it("never echoes the token in its responses", async () => {
    const fetchImpl = vi.fn(async () => reply(400, { errorMessage: `bad token ${TOKEN}` }));
    const result = await handle(signed("/v1/orders/place", { credentials, order }), config(fetchImpl as unknown as typeof fetch), createNonceStore());
    expect(JSON.stringify(result.json)).not.toContain("eyJ");
  });
});
