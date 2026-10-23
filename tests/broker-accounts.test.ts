import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/http";
import type { SessionUser } from "../src/server/auth";

/** In-memory stand-in for the four broker tables, enforcing the same unique constraints as Postgres. */
const db = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const state = { accounts: [] as Row[], credentials: [] as Array<Record<string, unknown>>, orders: [] as Array<Record<string, unknown>>, audit: [] as Array<Record<string, unknown>>, consents: [] as Array<Record<string, unknown>>, settings: [] as Array<Record<string, unknown>>, ownerMulti: true, seq: 0, failAudit: false };
  const unique = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  const withCredential = (row: Row, include?: unknown) => {
    const copy = { ...row };
    if (include) copy.credential = state.credentials.some((item) => item.accountId === row.id) ? { accountId: row.id } : null;
    return copy;
  };
  const checkUnique = (row: Row) => {
    if (state.accounts.some((item) => item.id !== row.id && item.ownerId === row.ownerId && item.slot === row.slot)) throw unique();
    if (row.clientFingerprint && state.accounts.some((item) => item.id !== row.id && item.clientFingerprint === row.clientFingerprint)) throw unique();
  };
  const client = {
    brokerAccount: {
      findUnique: async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        const row = state.accounts.find((item) => item.id === where.id);
        return row ? withCredential(row, include) : null;
      },
      findMany: async ({ where, include }: { where: { ownerId: string }; include?: unknown }) =>
        state.accounts.filter((item) => item.ownerId === where.ownerId).sort((a, b) => Number(a.slot) - Number(b.slot)).map((row) => withCredential(row, include)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.seq += 1;
        const row: Row = { id: `cacct${String(state.seq).padStart(20, "0")}`, broker: "DHAN", maskedClientId: "", clientFingerprint: null, connection: "NOT_CONNECTED", authorizedAt: null, tokenExpiresAt: null, lastConnectedAt: null, lastSyncAt: null, lastError: "", lastErrorAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        checkUnique(row);
        state.accounts.push(row);
        return { ...row };
      },
      update: async ({ where, data, include }: { where: { id: string }; data: Record<string, unknown>; include?: unknown }) => {
        const row = state.accounts.find((item) => item.id === where.id);
        if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
        const next = { ...row, ...data } as Row;
        checkUnique(next);
        Object.assign(row, data);
        return withCredential(row, include);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        state.accounts = state.accounts.filter((item) => item.id !== where.id);
        state.credentials = state.credentials.filter((item) => item.accountId !== where.id);
      },
    },
    brokerCredential: {
      findUnique: async ({ where }: { where: { accountId: string } }) => state.credentials.find((item) => item.accountId === where.accountId) ?? null,
      upsert: async ({ where, create, update }: { where: { accountId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const row = state.credentials.find((item) => item.accountId === where.accountId);
        if (row) Object.assign(row, update);
        else state.credentials.push({ ...create });
      },
      deleteMany: async ({ where }: { where: { accountId: string } }) => {
        state.credentials = state.credentials.filter((item) => item.accountId !== where.accountId);
      },
    },
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => state.settings.find((item) => item.key === where.key) ?? null,
      upsert: async ({ where, create, update }: { where: { key: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const row = state.settings.find((item) => item.key === where.key);
        if (row) Object.assign(row, update);
        else state.settings.push({ ...create, updatedAt: new Date() });
      },
      deleteMany: async () => ({ count: 0 }),
    },
    user: {
      findUnique: async () => ({ status: "ACTIVE", featMultiAccount: state.ownerMulti, featBrokerConnection: true }),
    },
    brokerConsent: {
      create: async ({ data }: { data: Record<string, unknown> }) => void state.consents.push({ usedAt: null, createdAt: new Date(), ...data }),
      findMany: async ({ where }: { where: { usedAt: null; expiresAt: { gt: Date }; accountId?: string } }) =>
        state.consents
          .filter((item) => item.usedAt === null && (item.expiresAt as Date) > where.expiresAt.gt && (!where.accountId || item.accountId === where.accountId))
          .reverse(),
      updateMany: async ({ where, data }: { where: { id: string; usedAt: null }; data: Record<string, unknown> }) => {
        const row = state.consents.find((item) => item.id === where.id && item.usedAt === null);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    brokerOrder: {
      count: async ({ where }: { where: { accountId: string; mode: string; status: { in: string[] } } }) =>
        state.orders.filter((item) => item.accountId === where.accountId && item.mode === where.mode && where.status.in.includes(String(item.status))).length,
    },
    tradingAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.failAudit) throw new Error("db down");
        state.audit.push(data);
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  return { state, client };
});

const auth = vi.hoisted(() => ({ user: null as SessionUser | null }));

vi.mock("@/lib/prisma", () => ({ prisma: db.client }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/server/auth", () => ({
  requireUser: async () => {
    if (!auth.user) throw new AppError("Sign in required.", 401);
    return auth.user;
  },
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const service = await import("../src/server/broker-accounts");
const listRoute = await import("../src/app/api/broker-accounts/route");
const itemRoute = await import("../src/app/api/broker-accounts/[id]/route");
const { resetRateLimits } = await import("../src/lib/security/rate-limit");

const user = (id: string, status: SessionUser["status"] = "ACTIVE"): SessionUser => ({ id, email: `${id}@x.test`, name: id, role: "STUDENT", status, tradingEnabled: true, mfaEnabled: false, premium: { status: "free" as const, plan: null, endsAt: null, via: null }, features: { standardTrading: true, demoTrading: true, replay: true, multiAccount: true, brokerConnection: true, portfolio: true, orderHistory: true, analytics: true } });
const alice = user("alice");
const bob = user("bob");
const ctx = { ip: "127.0.0.1" };
const FUTURE = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.c2ln"; // exp 2100-01-01
const PAST = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE2MDAwMDAwMDB9.c2ln"; // exp 2020-09-13

const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

function req(method: string, body?: unknown, headers: Record<string, string> = { origin: "https://traded.test", host: "traded.test" }) {
  return new Request("https://traded.test/api/broker-accounts", { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  db.state.accounts = [];
  db.state.credentials = [];
  db.state.orders = [];
  db.state.audit = [];
  db.state.consents = [];
  db.state.settings = [];
  db.state.ownerMulti = true;
  db.state.failAudit = false;
  auth.user = null;
  resetRateLimits();
});

describe("broker account service", () => {
  it("creates accounts in free slots up to the limit of eight", async () => {
    for (let i = 0; i < 8; i += 1) await service.createBrokerAccount(alice, { nickname: `A${i}`, relationship: "SELF" }, ctx);
    const list = await service.listBrokerAccounts(alice);
    expect(list.map((item) => item.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(service.createBrokerAccount(alice, { nickname: "ninth", relationship: "SELF" }, ctx)).rejects.toMatchObject({ code: "ACCOUNT_LIMIT" });
  });

  it("isolates owners: another user's account is invisible and untouchable", async () => {
    const mine = await service.createBrokerAccount(alice, { nickname: "Mine", relationship: "SELF" }, ctx);
    expect(await service.listBrokerAccounts(bob)).toEqual([]);
    for (const attempt of [
      () => service.getBrokerAccount(bob, mine.id),
      () => service.updateBrokerAccount(bob, mine.id, { nickname: "stolen" }, ctx),
      () => service.disconnectBrokerAccount(bob, mine.id, ctx),
      () => service.removeBrokerAccount(bob, mine.id, ctx),
      () => service.validateBrokerConnection(bob, mine.id, ctx),
      () => service.brokerClientFor(bob, mine.id),
      () => service.storeCredential(bob, mine.id, { clientId: "1100012345", accessToken: FUTURE }, ctx),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ status: 404, code: "ACCOUNT_NOT_FOUND" });
    }
    expect((await service.getBrokerAccount(alice, mine.id)).nickname).toBe("Mine");
  });

  it("stores credentials encrypted and never exposes them in views", async () => {
    const account = await service.createBrokerAccount(alice, { nickname: "Mine", relationship: "SELF" }, ctx);
    await service.storeCredential(alice, account.id, { clientId: "1100012345", accessToken: FUTURE }, ctx);
    const stored = db.state.credentials[0]!;
    expect(String(stored.ciphertext)).not.toContain(FUTURE);
    expect(String(stored.ciphertext)).not.toContain("1100012345");
    const view = await service.getBrokerAccount(alice, account.id);
    expect(view.connection).toBe("AUTH_REQUIRED");
    expect(view.maskedClientId).toBe("••••••2345");
    expect(JSON.stringify(view)).not.toMatch(/eyJ|1100012345/);
    expect(JSON.stringify(db.state.audit)).not.toMatch(/eyJ|1100012345/);
  });

  it("refuses to link one broker account to two TradeD accounts", async () => {
    const a = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    const b = await service.createBrokerAccount(bob, { nickname: "B", relationship: "SELF" }, ctx);
    await service.storeCredential(alice, a.id, { clientId: "1100012345", accessToken: FUTURE }, ctx);
    await expect(service.storeCredential(bob, b.id, { clientId: "1100012345", accessToken: FUTURE }, ctx)).rejects.toMatchObject({ code: "BROKER_ALREADY_LINKED" });
  });

  it("marks CONNECTED only after the broker confirms the same client", async () => {
    const account = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    await service.storeCredential(alice, account.id, { clientId: "1100012345", accessToken: FUTURE }, ctx);
    const mismatch = await service.validateBrokerConnection(alice, account.id, ctx, { fetch: ok({ dhanClientId: "9999999999" }) });
    expect(mismatch.connection).toBe("ERROR");
    const fine = await service.validateBrokerConnection(alice, account.id, ctx, { fetch: ok({ dhanClientId: "1100012345" }) });
    expect(fine.connection).toBe("CONNECTED");
    expect(fine.lastSyncAt).not.toBeNull();
  });

  it("reports missing credentials, expired tokens and broker auth failures honestly", async () => {
    const account = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    expect((await service.validateBrokerConnection(alice, account.id, ctx)).connection).toBe("NOT_CONNECTED");
    await expect(service.brokerClientFor(alice, account.id)).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });

    await service.storeCredential(alice, account.id, { clientId: "1100012345", accessToken: PAST }, ctx);
    const fetch = vi.fn();
    expect((await service.validateBrokerConnection(alice, account.id, ctx, { fetch })).connection).toBe("EXPIRED");
    expect(fetch).not.toHaveBeenCalled();
    await expect(service.brokerClientFor(alice, account.id)).rejects.toMatchObject({ code: "ACCOUNT_EXPIRED" });

    await service.storeCredential(alice, account.id, { clientId: "1100012345", accessToken: FUTURE }, ctx);
    const rejected = vi.fn(async () => new Response(JSON.stringify({ errorCode: "DH-901", errorMessage: "Invalid token" }), { status: 401 }));
    const view = await service.validateBrokerConnection(alice, account.id, ctx, { fetch: rejected });
    expect(view.connection).toBe("EXPIRED");
    expect(view.lastError).toMatch(/Reconnect/);
  });

  it("never shows a stored CONNECTED after the token expiry passes", async () => {
    const account = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    await service.storeCredential(alice, account.id, { clientId: "1100012345", accessToken: FUTURE }, ctx);
    await service.validateBrokerConnection(alice, account.id, ctx, { fetch: ok({}) });
    const later = await service.getBrokerAccount(alice, account.id, new Date("2100-01-02T00:00:00Z"));
    expect(later.connection).toBe("EXPIRED");
    expect(later.tokenExpired).toBe(true);
  });

  it("disconnect deletes the credential and frees the client for relinking", async () => {
    const account = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    await service.storeCredential(alice, account.id, { clientId: "1100012345", accessToken: FUTURE }, ctx);
    const view = await service.disconnectBrokerAccount(alice, account.id, ctx);
    expect(view.connection).toBe("NOT_CONNECTED");
    expect(view.hasCredential).toBe(false);
    expect(db.state.credentials).toHaveLength(0);
    const other = await service.createBrokerAccount(alice, { nickname: "B", relationship: "SPOUSE" }, ctx);
    await expect(service.storeCredential(alice, other.id, { clientId: "1100012345", accessToken: FUTURE }, ctx)).resolves.toBeUndefined();
  });

  it("fails closed when the audit trail cannot be written for a sensitive action", async () => {
    const account = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    await service.storeCredential(alice, account.id, { clientId: "1100012345", accessToken: FUTURE }, ctx);
    db.state.failAudit = true;
    await expect(service.disconnectBrokerAccount(alice, account.id, ctx)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(db.state.credentials).toHaveLength(1);
  });

  it("will not remove an account with open or unconfirmed live orders", async () => {
    const account = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    db.state.orders.push({ accountId: account.id, mode: "LIVE", status: "UNKNOWN" });
    await expect(service.removeBrokerAccount(alice, account.id, ctx)).rejects.toMatchObject({ code: "ACCOUNT_HAS_OPEN_ORDERS" });
    db.state.orders = [{ accountId: account.id, mode: "PAPER", status: "PENDING" }];
    await expect(service.removeBrokerAccount(alice, account.id, ctx)).resolves.toEqual({ removed: true });
  });

  it("suspended users can read but not change accounts", async () => {
    const account = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    const suspended = user("alice", "SUSPENDED");
    await expect(service.listBrokerAccounts(suspended)).resolves.toHaveLength(1);
    await expect(service.updateBrokerAccount(suspended, account.id, { nickname: "x" }, ctx)).rejects.toMatchObject({ code: "USER_INACTIVE" });
  });
});

describe("broker account routes", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await listRoute.GET(req("GET"), undefined);
    expect(res.status).toBe(401);
  });

  it("rejects cross-origin mutations before doing anything", async () => {
    auth.user = alice;
    const res = await listRoute.POST(req("POST", { nickname: "A", relationship: "SELF" }, { origin: "https://evil.test", host: "traded.test" }), undefined);
    expect(res.status).toBe(403);
    expect(db.state.accounts).toHaveLength(0);
  });

  it("only accepts family relationships and refuses extra fields such as tokens", async () => {
    auth.user = alice;
    const friend = await listRoute.POST(req("POST", { nickname: "Pal", relationship: "FRIEND" }), undefined);
    expect(friend.status).toBe(400);
    expect((await friend.json()).message).toMatch(/spouse, a dependent child or a dependent parent/);
    const smuggled = await listRoute.POST(req("POST", { nickname: "A", relationship: "SELF", accessToken: FUTURE }), undefined);
    expect(smuggled.status).toBe(400);
    expect((await listRoute.POST(req("POST", { nickname: "A", relationship: "SELF" }), undefined)).status).toBe(201);
  });

  it("lists only the caller's accounts and reports live orders as blocked", async () => {
    await service.createBrokerAccount(bob, { nickname: "Bob's", relationship: "SELF" }, ctx);
    auth.user = alice;
    const body = await (await listRoute.GET(req("GET"), undefined)).json();
    expect(body.accounts).toEqual([]);
    expect(body.capabilities).toMatchObject({ connect: false, liveOrders: false, credentialStorage: true });
    expect(body.liveOrdersBlockedBy.length).toBeGreaterThan(0);
  });

  it("returns 404 for another user's account and for malformed ids", async () => {
    const theirs = await service.createBrokerAccount(bob, { nickname: "Bob's", relationship: "SELF" }, ctx);
    auth.user = alice;
    expect((await itemRoute.GET(req("GET"), params(theirs.id))).status).toBe(404);
    expect((await itemRoute.DELETE(req("DELETE"), params(theirs.id))).status).toBe(404);
    expect((await itemRoute.GET(req("GET"), params("../../etc"))).status).toBe(404);
  });

  it("connect asks for the API key before starting Dhan's login", async () => {
    auth.user = alice;
    const mine = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SPOUSE" }, ctx);
    const res = await itemRoute.POST(req("POST", { action: "connect" }), params(mine.id));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ACCOUNT_NOT_CONFIGURED");
  });

  it("rate limits repeated refreshes", async () => {
    auth.user = alice;
    const mine = await service.createBrokerAccount(alice, { nickname: "A", relationship: "SELF" }, ctx);
    for (let i = 0; i < 6; i += 1) expect((await itemRoute.POST(req("POST", { action: "refresh" }), params(mine.id))).status).toBe(200);
    expect((await itemRoute.POST(req("POST", { action: "refresh" }), params(mine.id))).status).toBe(429);
  });
});

describe("family account consent flow", () => {
  const configure = { clientId: "1100012345", appId: "app-key-123", appSecret: "app-secret-xyz", staticIp: "13.50.1.2", ipConfirmed: true };
  const family = () => service.createBrokerAccount(alice, { nickname: "Amma", relationship: "DEPENDENT_PARENT" }, ctx);
  function dhan(routes: { consent?: string; token?: string; clientId?: string; profileClient?: string }) {
    return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (url.includes("/app/generate-consent")) {
        expect(init.method).toBe("POST");
        expect(headers.app_id).toBe("app-key-123");
        expect(headers.app_secret).toBe("app-secret-xyz");
        expect(url).toContain("client_id=1100012345");
        return new Response(JSON.stringify({ consentAppId: routes.consent ?? "consent-abc-123", status: "success" }), { status: 200 });
      }
      if (url.includes("/app/consumeApp-consent")) {
        expect(init.method).toBe("GET");
        return new Response(JSON.stringify({ dhanClientId: routes.clientId ?? "1100012345", accessToken: routes.token ?? FUTURE, expiryTime: "2100-01-01T00:00:00" }), { status: 200 });
      }
      if (url.endsWith("/profile")) return new Response(JSON.stringify({ dhanClientId: routes.profileClient ?? "1100012345" }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
  }

  it("stores the API secret encrypted and refuses an IP Dhan would reject", async () => {
    const account = await family();
    const view = await service.configureBrokerAccount(alice, account.id, configure, ctx, { ...process.env, DHAN_STATIC_IP: "13.49.97.101" });
    expect(view).toMatchObject({ connection: "AUTH_REQUIRED", staticIp: "13.50.1.2", ipConfirmed: true, maskedClientId: "••••••2345" });
    expect(String(db.state.credentials[0]?.ciphertext)).not.toMatch(/app-secret-xyz|app-key-123|1100012345/);
    expect(JSON.stringify(db.state.audit)).not.toMatch(/app-secret-xyz/);

    const other = await service.createBrokerAccount(alice, { nickname: "Appa", relationship: "DEPENDENT_PARENT" }, ctx);
    await expect(service.configureBrokerAccount(alice, other.id, { ...configure, clientId: "1100099999" }, ctx)).rejects.toMatchObject({ code: "STATIC_IP_IN_USE" });
    await expect(service.configureBrokerAccount(alice, other.id, { ...configure, clientId: "1100099999", staticIp: "13.49.97.101" }, ctx, { ...process.env, DHAN_STATIC_IP: "13.49.97.101" })).rejects.toMatchObject({ code: "STATIC_IP_IN_USE" });
    await expect(service.configureBrokerAccount(alice, other.id, { ...configure, clientId: "1100099999", staticIp: "999.1.1.1" }, ctx)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.configureBrokerAccount(bob, account.id, configure, ctx)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the saved secret when it is left blank on a later edit", async () => {
    const account = await family();
    await service.configureBrokerAccount(alice, account.id, configure, ctx);
    await expect(service.configureBrokerAccount(alice, account.id, { ...configure, appSecret: "" }, ctx)).resolves.toMatchObject({ staticIp: "13.50.1.2" });
    const fetch = dhan({});
    await service.startBrokerConsent(alice, account.id, ctx, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("connects only after the holder signs in on Dhan, and each link works once", async () => {
    const account = await family();
    await service.configureBrokerAccount(alice, account.id, configure, ctx);
    const fetch = dhan({});
    const started = await service.startBrokerConsent(alice, account.id, ctx, { fetch });
    expect(started.url).toBe("https://auth.dhan.co/login/consentApp-login?consentAppId=consent-abc-123");

    const done = await service.completeBrokerConsent("token-id-0001", account.id, ctx, { fetch });
    expect(done).toEqual({ nickname: "Amma", connection: "CONNECTED" });
    const view = await service.getBrokerAccount(alice, account.id);
    expect(view.connection).toBe("CONNECTED");
    expect(String(db.state.credentials[0]?.ciphertext)).not.toContain(FUTURE);

    await expect(service.completeBrokerConsent("token-id-0001", account.id, ctx, { fetch })).rejects.toMatchObject({ code: "CONSENT_EXPIRED" });
  });

  it("refuses to finish a sign-in when the owner's Multi-Account permission was switched off", async () => {
    const account = await family();
    await service.configureBrokerAccount(alice, account.id, configure, ctx);
    await service.startBrokerConsent(alice, account.id, ctx, { fetch: dhan({ consent: "consent-perm-001" }) });
    db.state.ownerMulti = false;
    await expect(service.completeBrokerConsent("token-id-0009", account.id, ctx, { fetch: dhan({}) })).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
  });

  it("rejects an expired consent and a sign-in to a different Dhan account", async () => {
    const account = await family();
    await service.configureBrokerAccount(alice, account.id, configure, ctx);
    await service.startBrokerConsent(alice, account.id, ctx, { fetch: dhan({}) });
    const later = { ...ctx, now: new Date(Date.now() + 11 * 60_000) };
    await expect(service.completeBrokerConsent("token-id-0002", account.id, later, { fetch: dhan({}) })).rejects.toMatchObject({ code: "CONSENT_EXPIRED" });

    await service.startBrokerConsent(alice, account.id, ctx, { fetch: dhan({ consent: "consent-second-1" }) });
    await expect(service.completeBrokerConsent("token-id-0003", account.id, ctx, { fetch: dhan({ clientId: "1999999999" }) })).rejects.toMatchObject({ code: "CONSENT_CLIENT_MISMATCH" });
    expect((await service.getBrokerAccount(alice, account.id)).connection).toBe("ERROR");
  });

  it("refuses malformed callback tokens without touching the database", async () => {
    await expect(service.completeBrokerConsent("x", null, ctx)).rejects.toMatchObject({ code: "CONSENT_INVALID" });
    await expect(service.completeBrokerConsent("token-id-0004", null, ctx)).rejects.toMatchObject({ code: "CONSENT_EXPIRED" });
  });
});

describe("owner's own account through Dhan sign-in", () => {
  it("keeps the server client id and primary IP, and refreshes the market-data token with the holder name", async () => {
    const { fingerprint } = await import("../src/lib/security/crypto");
    process.env.DHAN_CLIENT_ID = "1114171746";
    const env = { ...process.env, DHAN_STATIC_IP: "13.49.97.101" };
    const own = await service.createBrokerAccount(alice, { nickname: "My Dhan account", relationship: "SELF" }, ctx);
    Object.assign(db.state.accounts.find((row) => row.id === own.id)!, { clientFingerprint: fingerprint("1114171746", "broker-client-id") });

    const view = await service.configureBrokerAccount(alice, own.id, { clientId: "9999999999", appId: "app-key-123", appSecret: "app-secret-xyz", staticIp: "1.2.3.4", ipConfirmed: false }, ctx, env);
    expect(view).toMatchObject({ staticIp: "13.49.97.101", ipConfirmed: true, maskedClientId: "••••••1746" });

    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/app/generate-consent")) return new Response(JSON.stringify({ consentAppId: "consent-own-0001" }), { status: 200 });
      if (url.includes("/app/consumeApp-consent")) return new Response(JSON.stringify({ dhanClientId: "1114171746", dhanClientName: "HARIHARAN S V", accessToken: FUTURE }), { status: 200 });
      return new Response(JSON.stringify({ dhanClientId: "1114171746" }), { status: 200 });
    });
    await service.startBrokerConsent(alice, own.id, ctx, { fetch });
    await expect(service.completeBrokerConsent("token-own-0001", own.id, ctx, { fetch })).resolves.toEqual({ nickname: "My Dhan account", connection: "CONNECTED" });
    expect(db.state.accounts.find((row) => row.id === own.id)?.holderName).toBe("HARIHARAN S V");
    expect(db.state.settings.find((row) => row.key === "market.dhanAccessToken")?.value).toBe(FUTURE);
    delete process.env.DHAN_CLIENT_ID;
  });
});
