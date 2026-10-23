import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/http";
import { featureColumns, featuresOf, requireFeature, type Features } from "../src/lib/auth/features";
import type { SessionUser } from "../src/server/auth";

const ALL: Features = { standardTrading: true, demoTrading: true, replay: true, multiAccount: true, brokerConnection: true, portfolio: true, orderHistory: true, analytics: true };

const db = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const state = { users: [] as Row[], resets: [] as Row[], sessions: [] as Row[], audit: [] as Row[], seq: 0 };
  const id = () => `c${String((state.seq += 1)).padStart(24, "0")}`;
  const matchUser = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "not" in (value as object)) return row[key] !== (value as { not: unknown }).not;
    return row[key] === value;
  });
  const client = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => state.users.find((row) => (where.id ? row.id === where.id : row.email === where.email)) ?? null,
      count: async ({ where = {} }: { where?: Record<string, unknown> } = {}) => state.users.filter((row) => matchUser(row, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.users.some((row) => row.email === data.email)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row: Row = { id: id(), createdAt: new Date(), lastLoginAt: null, mfaEnabled: false, premium: { status: "free" as const, plan: null, endsAt: null, via: null }, notes: "", tradingEnabled: true, featDemoTrading: true, featReplay: true, featMultiAccount: true, featBrokerConnection: true, featPortfolio: true, featOrderHistory: true, featAnalytics: true, ...data };
        state.users.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.users.find((item) => item.id === where.id)!;
        for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === "object" && "increment" in (value as object) ? Number(row[key] ?? 0) + (value as { increment: number }).increment : value;
        return row;
      },
    },
    passwordReset: {
      updateMany: async ({ where, data }: { where: { userId: string; usedAt: null }; data: Record<string, unknown> }) => { for (const row of state.resets) if (row.userId === where.userId && row.usedAt == null) Object.assign(row, data); return { count: 0 }; },
      create: async ({ data }: { data: Record<string, unknown> }) => { const row: Row = { id: id(), usedAt: null, ...data }; state.resets.push(row); return row; },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const row = state.resets.find((item) => item.tokenHash === where.tokenHash);
        return row ? { ...row, user: state.users.find((user) => user.id === row.userId) } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(state.resets.find((row) => row.id === where.id)!, data),
    },
    session: { updateMany: async ({ where }: { where: { userId: string } }) => { const hit = state.sessions.filter((row) => row.userId === where.userId && !row.revokedAt); hit.forEach((row) => (row.revokedAt = new Date())); return { count: hit.length }; } },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.audit.push({ id: id(), ...data }); } },
    $transaction: async (work: unknown) => (typeof work === "function" ? (work as (tx: unknown) => Promise<unknown>)(client) : Promise.all(work as Promise<unknown>[])),
  };
  return { state, client };
});

const calls = vi.hoisted(() => ({ adjust: [] as unknown[][], opened: [] as unknown[][] }));

vi.mock("@/lib/prisma", () => ({ prisma: db.client }));
vi.mock("@/server/settings", () => ({ getTradingSettings: async () => ({ startingCapitalPaise: 1_00_000_00n }) }));
vi.mock("@/server/users", () => ({ openStudentAccount: async (...args: unknown[]) => { calls.opened.push(args); return {}; } }));
vi.mock("@/server/practice-account", () => ({ ensurePracticeAccount: async () => ({}) }));
vi.mock("@/server/trading", () => ({ adjustFunds: async (...args: unknown[]) => { calls.adjust.push(args); return { cashAvailable: 1_50_000_00n }; } }));

const admin = await import("../src/server/admin-users");
const { hashToken } = await import("../src/server/auth");

const actor = (over: Partial<SessionUser> = {}): SessionUser => ({ id: "c-admin-000000000000000000001", email: "owner@x.test", name: "Owner", role: "SUPER_ADMIN", status: "ACTIVE", tradingEnabled: true, mfaEnabled: false, premium: { status: "free" as const, plan: null, endsAt: null, via: null }, features: ALL, ...over });
const owner = actor();
const ctx = { ip: "127.0.0.1", origin: "https://traded.test" };
const standard: Features = { ...ALL, multiAccount: false, brokerConnection: false };

beforeEach(() => {
  db.state.users = [{ id: owner.id, email: owner.email, name: "Owner", role: "SUPER_ADMIN", status: "ACTIVE", createdAt: new Date(), notes: "", tradingEnabled: true, featMultiAccount: true }];
  db.state.resets = [];
  db.state.sessions = [];
  db.state.audit = [];
  calls.adjust = [];
  calls.opened = [];
});

describe("feature permissions", () => {
  it("maps rows to features and back, defaulting missing columns to on", () => {
    expect(featuresOf({ featMultiAccount: false, tradingEnabled: true })).toMatchObject({ multiAccount: false, standardTrading: true, demoTrading: true });
    expect(featureColumns({ multiAccount: false, standardTrading: false })).toEqual({ featMultiAccount: false, tradingEnabled: false });
  });

  it("refuses a disabled feature with a structured 403", () => {
    expect(() => requireFeature({ features: standard }, "multiAccount")).toThrow(AppError);
    expect(() => requireFeature({ features: standard }, "multiAccount")).toThrow(/Multi-Account Trading is not enabled/);
    expect(() => requireFeature({ features: standard }, "replay")).not.toThrow();
  });
});

describe("Super Admin user management", () => {
  it("lets only an active Super Admin create users", async () => {
    await expect(admin.createUser(actor({ role: "STUDENT" }), { name: "X", email: "x@x.test", role: "STUDENT", status: "ACTIVE", features: standard }, ctx)).rejects.toMatchObject({ status: 403 });
    await expect(admin.createUser(actor({ status: "SUSPENDED" }), { name: "X", email: "x@x.test", role: "STUDENT", status: "ACTIVE", features: standard }, ctx)).rejects.toMatchObject({ status: 403 });
  });

  it("creates a standard user without multi-account, opens the demo wallet and returns a one-time link", async () => {
    const result = await admin.createUser(owner, { name: "Ashiq", email: "Ashiq@Gmail.com", role: "STUDENT", status: "ACTIVE", features: standard }, ctx);
    const user = db.state.users.find((row) => row.email === "ashiq@gmail.com")!;
    expect(user).toMatchObject({ role: "STUDENT", featMultiAccount: false, featBrokerConnection: false, status: "ACTIVE" });
    expect(String(user.passwordHash)).toMatch(/^\$2[aby]\$12\$/);
    expect(calls.opened).toHaveLength(1);
    expect(calls.adjust).toHaveLength(0);
    const token = new URL(result.setupLink).searchParams.get("token")!;
    expect(db.state.resets[0]?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(db.state.resets)).not.toContain(token);
    expect(db.state.audit.some((row) => row.action === "user.create")).toBe(true);
  });

  it("rejects a duplicate email", async () => {
    await admin.createUser(owner, { name: "A", email: "a@x.test", role: "STUDENT", status: "ACTIVE", features: standard }, ctx);
    await expect(admin.createUser(owner, { name: "B", email: "A@X.test", role: "STUDENT", status: "ACTIVE", features: standard }, ctx)).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
  });

  it("posts an initial credit through the wallet ledger with an idempotency key", async () => {
    const result = await admin.createUser(owner, { name: "C", email: "c@x.test", role: "STUDENT", status: "ACTIVE", features: standard, initialCreditRupees: 2500 }, ctx);
    expect(calls.adjust[0]?.[2]).toBe(2_500_00n);
    expect(calls.adjust[0]?.[5]).toBe(`create-credit:${result.userId}`);
  });

  it("protects the last active Super Admin and the actor's own account", async () => {
    await expect(admin.updateUser(owner, owner.id, { role: "STUDENT" }, ctx)).rejects.toMatchObject({ code: "SELF_CHANGE" });
    const other = actor({ id: "c-admin-000000000000000000002", email: "two@x.test" });
    await expect(admin.updateUser(other, owner.id, { status: "SUSPENDED" }, ctx)).rejects.toMatchObject({ code: "LAST_SUPER_ADMIN" });
  });

  it("suspending a user ends their sessions and is audited", async () => {
    const { userId } = await admin.createUser(owner, { name: "D", email: "d@x.test", role: "STUDENT", status: "ACTIVE", features: standard }, ctx);
    db.state.sessions.push({ id: "s1", userId, revokedAt: null });
    await admin.updateUser(owner, userId, { status: "SUSPENDED" }, ctx);
    expect(db.state.sessions[0]?.revokedAt).toBeInstanceOf(Date);
    expect(db.state.audit.some((row) => row.action === "user.status.suspended")).toBe(true);
  });

  it("validates wallet adjustments and passes a stable idempotency key", async () => {
    const { userId } = await admin.createUser(owner, { name: "E", email: "e@x.test", role: "STUDENT", status: "ACTIVE", features: standard }, ctx);
    const base = { wallet: "DEMO" as const, direction: "credit" as const, reason: "Monthly top-up", key: "11111111-1111-4111-8111-111111111111" };
    await expect(admin.adjustWallet(owner, userId, { ...base, amountRupees: 0 }, ctx)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(admin.adjustWallet(owner, userId, { ...base, amountRupees: 2_00_00_000 }, ctx)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(admin.adjustWallet(owner, userId, { ...base, amountRupees: 100, reason: "x" }, ctx)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(admin.adjustWallet(actor({ role: "STUDENT" }), userId, { ...base, amountRupees: 100 }, ctx)).rejects.toMatchObject({ status: 403 });
    const result = await admin.adjustWallet(owner, userId, { ...base, direction: "debit", amountRupees: 50.25 }, ctx);
    expect(calls.adjust.at(-1)?.[2]).toBe(-5025n);
    expect(calls.adjust.at(-1)?.[5]).toBe("admin-wallet:11111111-1111-4111-8111-111111111111");
    expect(String(calls.adjust.at(-1)?.[3])).toMatch(/^Administrative debit: /);
    expect(result.balance).toBe("₹1,50,000.00");
  });
});

describe("password setup links", () => {
  it("sets the password once and then refuses the same link", async () => {
    const { userId, setupLink } = await admin.createUser(owner, { name: "F", email: "f@x.test", role: "STUDENT", status: "ACTIVE", features: standard }, ctx);
    const token = new URL(setupLink).searchParams.get("token")!;
    await expect(admin.completePasswordSetup(token, "short")).rejects.toThrow(/10 to 128/);
    await expect(admin.completePasswordSetup(token, "Strong-pass-123")).resolves.toEqual({ email: "f@x.test" });
    expect(String(db.state.users.find((row) => row.id === userId)?.passwordHash)).toMatch(/^\$2[aby]\$12\$/);
    await expect(admin.completePasswordSetup(token, "Another-pass-456")).rejects.toMatchObject({ code: "LINK_EXPIRED" });
  });

  it("invalidates older links when a new one is issued, and refuses expired or archived ones", async () => {
    const { userId, setupLink } = await admin.createUser(owner, { name: "G", email: "g@x.test", role: "STUDENT", status: "ACTIVE", features: standard }, ctx);
    const first = new URL(setupLink).searchParams.get("token")!;
    const { setupLink: second } = await admin.issuePasswordLink(owner, userId, ctx);
    await expect(admin.completePasswordSetup(first, "Strong-pass-123")).rejects.toMatchObject({ code: "LINK_EXPIRED" });
    const token = new URL(second).searchParams.get("token")!;
    db.state.resets.at(-1)!.expiresAt = new Date(Date.now() - 1000);
    await expect(admin.completePasswordSetup(token, "Strong-pass-123")).rejects.toMatchObject({ code: "LINK_EXPIRED" });
    db.state.users.find((row) => row.id === userId)!.status = "DISABLED";
    await expect(admin.issuePasswordLink(owner, userId, ctx)).rejects.toMatchObject({ status: 409 });
  });
});

describe("server-side enforcement is wired into every protected route", () => {
  const handlers = (source: string) => (source.match(/export const (GET|POST|PATCH|DELETE)\s*=/g) ?? []).length;
  it("checks Multi-Account Trading on every multi-account and broker route handler", () => {
    for (const file of ["multi-account/route.ts", "multi-account/live/route.ts", "broker-accounts/route.ts", "broker-accounts/[id]/route.ts", "broker-accounts/select/route.ts", "live-orders/route.ts"]) {
      const source = readFileSync(`src/app/api/${file}`, "utf8");
      expect((source.match(/requireFeature\(user, "multiAccount"\)/g) ?? []).length, file).toBe(handlers(source));
    }
  });

  it("checks the matching permission on practice routes and guards admin routes by role", () => {
    const expectations: Array<[string, string]> = [["portfolio/route.ts", "portfolio"], ["trades/route.ts", "orderHistory"], ["demo/option/route.ts", "demoTrading"], ["demo/option-replay/route.ts", "replay"], ["demo/replay/route.ts", "replay"], ["market/forecast/route.ts", "analytics"]];
    for (const [file, feature] of expectations) expect(readFileSync(`src/app/api/${file}`, "utf8"), file).toContain(`requireFeature(user, "${feature}")`);
    for (const file of ["super-admin/users/route.ts", "super-admin/users/[id]/route.ts", "super-admin/summary/route.ts", "super-admin/audit/route.ts"]) {
      const source = readFileSync(`src/app/api/${file}`, "utf8");
      expect((source.match(/requireUser\(\["SUPER_ADMIN"\]\)/g) ?? []).length, file).toBe(handlers(source));
    }
    expect(readFileSync("src/app/(desk)/super-admin/page.tsx", "utf8")).toContain('requirePageUser(["SUPER_ADMIN"])');
    expect(readFileSync("src/app/(desk)/multi-account/page.tsx", "utf8")).toContain('requirePageFeature("multiAccount")');
  });
});
