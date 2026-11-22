import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextClose, renewDue, renewedToken, TOKEN_LIFETIME } from "@/lib/dhan/token-renewal";

const MIN = 60_000;
/** 2026-11-<day> hh:mm IST as epoch ms. */
const ist = (day: number, hh: number, mm: number) => Date.UTC(2026, 10, day, hh, mm) - 330 * MIN;

describe("renewDue (same schedule as Neural Core)", () => {
  it("renews after the market so the token covers the next session", () => {
    const generatedAt1444 = ist(6, 14, 44); // token made 5 Nov 14:44 -> expires 6 Nov 14:44
    expect(renewDue(generatedAt1444, ist(5, 15, 0))).toBeNull(); // market hours: never touched
    expect(renewDue(generatedAt1444, ist(5, 15, 45))).toBe("after-market renewal for the next session");
    expect(renewDue(ist(6, 15, 40), ist(5, 15, 50))).toBeNull(); // renewed 10 minutes ago
    expect(renewDue(ist(6, 15, 40), ist(5, 16, 0))).toBe("after-market renewal for the next session"); // second, to 16:00
    expect(renewDue(ist(6, 16, 0), ist(5, 20, 0))).toBeNull(); // lasts until 16:00 after the next close
    expect(renewDue(ist(6, 16, 0), ist(6, 15, 20))).toBeNull(); // in market, expires after it: wait for 15:40
    expect(renewDue(ist(6, 16, 0), ist(6, 15, 40))).toBe("after-market renewal for the next session");
    expect(renewDue(ist(6, 14, 44), ist(6, 8, 0))).toBe("pre-market renewal (evening renewal did not happen)");
    expect(renewDue(ist(6, 14, 44), ist(6, 10, 0))).toBeNull(); // in market: only the last resort
    expect(renewDue(ist(6, 14, 44), ist(6, 14, 30))).toBe("expires in less than 15 minutes");
    expect(renewDue(ist(6, 14, 44), ist(6, 14, 50))).toBeNull(); // already expired: Dhan cannot renew it
    expect(renewDue(null, ist(5, 16, 0))).toBeNull();
  });

  it("finds the next 15:30 IST close", () => {
    expect(nextClose(ist(5, 10, 0))).toBe(ist(5, 15, 30));
    expect(nextClose(ist(5, 15, 30))).toBe(ist(6, 15, 30));
  });

  /** Step through time; renew when due (new token = now + 24 h). Returns renewal times and dead-token times. */
  function simulate(on: (ms: number) => boolean, stepMin: number, startExpiry: number, days = 21) {
    let now = ist(5, 17, 0);
    let expires = startExpiry;
    const renewals: number[] = [];
    const dead: number[] = [];
    const end = now + days * 24 * 60 * MIN;
    for (; now < end; now += stepMin * MIN) {
      if (!on(now)) continue;
      if (expires <= now) dead.push(now);
      else if (renewDue(expires, now)) {
        renewals.push(now);
        expires = now + TOKEN_LIFETIME;
      }
    }
    return { renewals, dead };
  }
  const clock = (ms: number) => {
    const d = new Date(ms + 330 * MIN);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };
  const inMarket = (ms: number) => clock(ms) >= 9 * 60 && clock(ms) < 15 * 60 + 35;

  it.each([1, 5])("never drifts into market hours (scheduler every %i min)", (step) => {
    const { renewals, dead } = simulate(() => true, step, ist(6, 16, 58));
    expect(dead).toEqual([]);
    expect(renewals.some(inMarket)).toBe(false);
    const lastWeek = renewals.filter((ms) => ms >= ist(19, 0, 0)).map(clock);
    expect(new Set(lastWeek).size).toBeLessThanOrEqual(2); // the same two times every day
    expect(lastWeek.every((m) => m >= 15 * 60 + 40 && m <= 16 * 60 + 10)).toBe(true);
  });

  it("keeps the token alive when the scheduler is off on weekday evenings", () => {
    const on = (ms: number) => {
      const d = new Date(ms + 330 * MIN);
      const day = (d.getUTCDay() + 6) % 7; // Monday = 0
      const at = clock(ms);
      const offEvening = day <= 3 && at >= 17 * 60;
      const offMorning = day >= 1 && day <= 4 && at < 8 * 60 + 30;
      return !(offEvening || offMorning);
    };
    const { renewals, dead } = simulate(on, 5, ist(6, 16, 58));
    expect(dead).toEqual([]);
    expect(renewals.some(inMarket)).toBe(false);
  });
});

describe("renewedToken", () => {
  const jwt = "eyJhbGciOiJIUzUxMiJ9." + "a".repeat(60) + ".sig";
  it("reads the new token from Dhan's answer", () => {
    expect(renewedToken({ accessToken: jwt, expiryTime: "2026-11-07T15:45:00" })).toBe(jwt);
    expect(renewedToken({ data: { token: jwt } })).toBe(jwt);
    expect(renewedToken({ _raw: jwt })).toBe(jwt);
    expect(renewedToken({ status: "success" })).toBeNull();
  });
});

// ── server: renewMarketTokenIfDue with an in-memory settings table and a fake Dhan ──

const store = new Map<string, unknown>();
const audits: unknown[] = [];
const prismaMock = {
  appSetting: {
    findUnique: async ({ where }: { where: { key: string } }) => (store.has(where.key) ? { key: where.key, value: store.get(where.key), updatedAt: new Date() } : null),
    upsert: async ({ where, create, update }: { where: { key: string }; create: { value: unknown }; update: { value: unknown } }) => {
      store.set(where.key, store.has(where.key) ? update.value : create.value);
    },
    update: async ({ where, data }: { where: { key: string }; data: { value: unknown } }) => store.set(where.key, data.value),
    updateMany: async ({ where, data }: { where: { key: string; value: { equals: unknown } }; data: { value: unknown } }) => {
      if (store.get(where.key) !== where.value.equals) return { count: 0 };
      store.set(where.key, data.value);
      return { count: 1 };
    },
    create: async ({ data }: { data: { key: string; value: unknown } }) => store.set(data.key, data.value),
  },
  auditLog: { create: async ({ data }: { data: unknown }) => audits.push(data) },
};
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const { renewMarketTokenIfDue } = await import("../src/server/market-token-renewal");
const { saveMarketConnection, marketConnectionStatus } = await import("../src/server/settings");

const makeJwt = (expMs: number) =>
  `eyJhbGciOiJIUzUxMiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), dhanClientId: "1114171746" })).toString("base64url")}.signature`;
const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

describe("renewMarketTokenIfDue", () => {
  beforeEach(() => {
    store.clear();
    audits.length = 0;
    store.set("market.dhanClientId", "1114171746");
    delete process.env.DHAN_ACCESS_TOKEN;
  });

  it("does nothing during market hours and outside the renewal windows", async () => {
    store.set("market.dhanAccessToken", makeJwt(ist(6, 14, 44)));
    const fetchSpy = vi.fn(answer(200, {}));
    expect((await renewMarketTokenIfDue(new Date(ist(5, 11, 0)), fetchSpy)).status).toBe("not-due");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renews after 15:40, saves the new token and records only times", async () => {
    const old = makeJwt(ist(6, 14, 44));
    const fresh = makeJwt(ist(6, 15, 45));
    store.set("market.dhanAccessToken", old);
    const fetchSpy = vi.fn(answer(200, { accessToken: fresh, expiryTime: "2026-11-06T15:45:00" }));
    const out = await renewMarketTokenIfDue(new Date(ist(5, 15, 45)), fetchSpy);
    expect(out.status).toBe("renewed");
    expect(store.get("market.dhanAccessToken")).toBe(fresh);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.dhan.co/v2/RenewToken");
    expect((init.headers as Record<string, string>)["access-token"]).toBe(old);
    expect(JSON.stringify(store.get("market.dhanTokenRenewal"))).not.toContain(fresh.split(".")[1]);
    expect(audits).toHaveLength(1);
    const status = await marketConnectionStatus();
    expect(status.renewal.renewedAt).toBe(new Date(ist(5, 15, 45)).toISOString());
  });

  it("keeps a token pasted on the Admin page during the renewal", async () => {
    const old = makeJwt(ist(6, 14, 44));
    const pasted = makeJwt(ist(6, 15, 50));
    store.set("market.dhanAccessToken", old);
    const fetchSpy = vi.fn(async () => {
      store.set("market.dhanAccessToken", pasted); // admin saves a new token while Dhan answers
      return new Response(JSON.stringify({ accessToken: makeJwt(ist(6, 15, 45)) }), { status: 200 });
    });
    expect((await renewMarketTokenIfDue(new Date(ist(5, 15, 45)), fetchSpy)).status).toBe("superseded");
    expect(store.get("market.dhanAccessToken")).toBe(pasted);
  });

  it("never retries a token whose answer had no newer token, and a pasted token starts afresh", async () => {
    store.set("market.dhanAccessToken", makeJwt(ist(6, 14, 44)));
    const fetchSpy = vi.fn(answer(200, { status: "success" }));
    expect((await renewMarketTokenIfDue(new Date(ist(5, 15, 45)), fetchSpy)).status).toBe("failed");
    expect((await renewMarketTokenIfDue(new Date(ist(5, 16, 30)), fetchSpy)).status).toBe("stopped");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await marketConnectionStatus()).renewal.stopped).toBe(true);
    await saveMarketConnection("admin", { accessToken: makeJwt(ist(6, 15, 0)) });
    expect((await marketConnectionStatus()).renewal.stopped).toBe(false);
  });

  it("waits 10 minutes after a failed call before trying again", async () => {
    store.set("market.dhanAccessToken", makeJwt(ist(6, 14, 44)));
    const fetchSpy = vi.fn(answer(500, { errorMessage: "busy" }));
    expect((await renewMarketTokenIfDue(new Date(ist(5, 15, 45)), fetchSpy)).status).toBe("failed");
    expect((await renewMarketTokenIfDue(new Date(ist(5, 15, 50)), fetchSpy)).status).toBe("waiting");
    expect((await renewMarketTokenIfDue(new Date(ist(5, 15, 56)), fetchSpy)).status).toBe("failed");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("skips when no token or client id is set", async () => {
    expect((await renewMarketTokenIfDue(new Date(ist(5, 15, 45)), vi.fn())).status).toBe("skipped");
  });
});
