import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (store.has(where.key) ? { key: where.key, value: store.get(where.key), updatedAt: new Date() } : null),
      upsert: async ({ where, create, update }: { where: { key: string }; create: { value: unknown }; update: { value: unknown } }) => {
        store.set(where.key, store.has(where.key) ? update.value : create.value);
      },
    },
    auditLog: { create: async () => undefined },
  },
}));

const { neuralToken, resetNeuralTokenCache, signNeuralRequest } = await import("../src/server/neural-token");
const { getDhanAccessToken, getDhanClientId, marketConnectionStatus } = await import("../src/server/settings");
const { renewMarketTokenIfDue } = await import("../src/server/market-token-renewal");

const SECRET = "x".repeat(40);
const jwt = (expMs: number) => `eyJhbGciOiJIUzUxMiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url")}.sig`;
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  store.clear();
  resetNeuralTokenCache();
  process.env.NEURAL_TOKEN_URL = "https://52-87-230-150.sslip.io/integrations/traded/market-token";
  process.env.NEURAL_TOKEN_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.NEURAL_TOKEN_URL;
  delete process.env.NEURAL_TOKEN_SECRET;
  vi.unstubAllGlobals();
});

describe("Neural Core market token", () => {
  it("signs exactly like Neural Core's backend (cross-checked against neural_backend.secure.sign)", () => {
    expect(signNeuralRequest("s".repeat(40), "1795000000000", "abcdefghijklmnopqrstuvwx", "/integrations/traded/market-token"))
      .toBe("fa1831badd3b4dd8bc1ac7cad3f4b13b9cb940eb3bf7f996ea994eb402fbd92a");
  });

  it("fetches the token with a signed request and caches it", async () => {
    const token = jwt(Date.now() + 6 * 3600_000);
    const fetchSpy = answer(200, { account: "Hariharan", clientId: "1114171746", accessToken: token, expiresAt: null });
    const first = await neuralToken(fetchSpy);
    expect(first).toMatchObject({ clientId: "1114171746", accessToken: token, account: "Hariharan" });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-NC-Signature"]).toBe(signNeuralRequest(SECRET, headers["X-NC-Timestamp"], headers["X-NC-Nonce"], "/integrations/traded/market-token"));
    await neuralToken(fetchSpy);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // cached
    await neuralToken(fetchSpy, Date.now() + 6 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // refreshed after 5 minutes
  });

  it("is off unless both the URL and a long secret are set, and reports Neural Core's refusal", async () => {
    delete process.env.NEURAL_TOKEN_SECRET;
    expect(await neuralToken(answer(200, {}))).toBeNull();
    process.env.NEURAL_TOKEN_SECRET = SECRET;
    const refused = answer(409, { message: "Hariharan's Dhan token has expired" });
    vi.stubGlobal("fetch", refused);
    expect(await neuralToken(refused)).toBeNull();
    store.set("market.dhanAccessToken", jwt(Date.now() + 3600_000));
    const status = await marketConnectionStatus();
    expect(status.neural.error).toContain("expired");
  });

  it("uses Neural Core's client id and token together for the charts", async () => {
    const token = jwt(Date.now() + 3600_000);
    vi.stubGlobal("fetch", answer(200, { account: "Hariharan", clientId: "1114171746", accessToken: token }));
    store.set("market.dhanClientId", "9999");
    store.set("market.dhanAccessToken", jwt(Date.now() + 3600_000) + "x");
    expect(await getDhanAccessToken()).toBe(token);
    expect(await getDhanClientId()).toBe("1114171746");
    const status = await marketConnectionStatus();
    expect(status).toMatchObject({ tokenSource: "neural", clientSource: "neural", clientTail: "1746", neural: { configured: true, account: "Hariharan" } });
  });

  it("never renews a token Neural Core owns (a renewal would expire Neural Core's copy)", async () => {
    store.set("market.dhanClientId", "1114171746");
    store.set("market.dhanAccessToken", jwt(Date.UTC(2026, 10, 6, 9, 14)));
    const fetchSpy = vi.fn();
    const out = await renewMarketTokenIfDue(new Date(Date.UTC(2026, 10, 5, 10, 15)), fetchSpy); // 15:45 IST, normally due
    expect(out.status).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Neural Core unavailable", () => {
  it("backs off for a minute after a failure instead of asking on every chart request", async () => {
    const down = vi.fn(async () => { throw new Error("connect timeout"); });
    const now = Date.now();
    expect(await neuralToken(down as unknown as typeof fetch, now)).toBeNull();
    expect(await neuralToken(down as unknown as typeof fetch, now + 30_000)).toBeNull();
    expect(down).toHaveBeenCalledTimes(1);
    await neuralToken(down as unknown as typeof fetch, now + 61_000);
    expect(down).toHaveBeenCalledTimes(2);
  });
});
