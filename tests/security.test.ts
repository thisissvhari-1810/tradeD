import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, encryptionConfigured, fingerprint } from "../src/lib/security/crypto";
import { maskTail, redact, redactString } from "../src/lib/security/redact";
import { liveOrdersStatus, marketDataEnabled } from "../src/lib/security/flags";
import { rateLimit, resetRateLimits } from "../src/lib/security/rate-limit";
import { assertMayManageBrokerAccounts, assertOwnsAccount } from "../src/lib/security/authorization";

const key = () => randomBytes(32).toString("base64");
const env = (extra: Record<string, string> = {}) => ({ ENCRYPTION_KEY: key(), ...extra }) as unknown as NodeJS.ProcessEnv;
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTk5OTk5OTl9.c2lnbmF0dXJl";

describe("credential encryption", () => {
  it("round-trips and never contains the plaintext", () => {
    const e = env();
    const { envelope } = encryptSecret(JWT, "broker-account:a1", e);
    expect(envelope).not.toContain(JWT);
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(decryptSecret(envelope, "broker-account:a1", e)).toBe(JWT);
  });

  it("uses a fresh IV every time", () => {
    const e = env();
    expect(encryptSecret("same", "ctx", e).envelope).not.toBe(encryptSecret("same", "ctx", e).envelope);
  });

  it("rejects a ciphertext moved to another account", () => {
    const e = env();
    const { envelope } = encryptSecret("secret", "broker-account:a1", e);
    expect(() => decryptSecret(envelope, "broker-account:a2", e)).toThrow(/integrity/);
  });

  it("rejects tampered ciphertext", () => {
    const e = env();
    const parts = encryptSecret("secret-value", "ctx", e).envelope.split(".");
    const body = Buffer.from(parts[4]!, "base64url");
    body[0] = body[0]! ^ 1;
    parts[4] = body.toString("base64url");
    expect(() => decryptSecret(parts.join("."), "ctx", e)).toThrow(/integrity/);
  });

  it("refuses to encrypt without a key and rejects short keys", () => {
    expect(() => encryptSecret("x", "ctx", {} as NodeJS.ProcessEnv)).toThrow(/not configured/);
    expect(() => encryptSecret("x", "ctx", { ENCRYPTION_KEY: "c2hvcnQ=" } as unknown as NodeJS.ProcessEnv)).toThrow(/32 random bytes/);
    expect(encryptionConfigured({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("decrypts with the previous key during rotation, and fails once it is gone", () => {
    const old = env();
    const { envelope } = encryptSecret("secret", "ctx", old);
    const rotated = env({ ENCRYPTION_KEY_PREVIOUS: old.ENCRYPTION_KEY! });
    expect(decryptSecret(envelope, "ctx", rotated)).toBe("secret");
    expect(() => decryptSecret(envelope, "ctx", env())).toThrow(/no longer has/);
  });

  it("fingerprints are stable per key and differ across keys", () => {
    const e = env();
    expect(fingerprint("1100012345", "p", e)).toBe(fingerprint(" 1100012345 ", "p", e));
    expect(fingerprint("1100012345", "p", e)).not.toBe(fingerprint("1100012345", "p", env()));
    expect(fingerprint("1100012345", "p", e)).not.toContain("1100012345");
  });
});

describe("redaction", () => {
  it("removes secrets by key and masks client ids", () => {
    const out = redact({ accessToken: JWT, "access-token": JWT, password: "p", headers: { authorization: "Bearer abc" }, clientId: "1100012345", tokenExpiresAt: "2026-10-20" }) as Record<string, unknown>;
    expect(out.accessToken).toBe("[redacted]");
    expect(out["access-token"]).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect((out.headers as Record<string, unknown>).authorization).toBe("[redacted]");
    expect(out.clientId).toBe("••••••2345");
    expect(out.tokenExpiresAt).toBe("2026-10-20");
  });

  it("scrubs JWTs, bearer values and token query strings inside free text and errors", () => {
    expect(redactString(`failed wss://api-feed.dhan.co?version=2&token=${JWT}&clientId=1100012345`)).not.toMatch(/eyJ|1100012345/);
    expect(redactString("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
    const err = redact(new Error(`bad token ${JWT}`)) as { message: string };
    expect(err.message).not.toContain("eyJ");
  });

  it("masks short values completely", () => {
    expect(maskTail("123")).toBe("••••");
  });
});

describe("feature flags", () => {
  it("market data defaults on and can be switched off", () => {
    expect(marketDataEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(marketDataEnabled({ MARKET_DATA_ENABLED: "false" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("live orders stay locked even with every switch on", () => {
    const status = liveOrdersStatus({ LIVE_ORDERS_ENABLED: "true", EXECUTION_SERVICE_URL: "https://exec.example.com", EXECUTION_SERVICE_SECRET: "x".repeat(40) } as unknown as NodeJS.ProcessEnv);
    expect(status.enabled).toBe(false);
    expect(status.reasons.length).toBeGreaterThan(0);
    expect(status.reasons).not.toContain("LIVE_ORDERS_ENABLED is off.");
  });

  it("live orders explain every missing prerequisite by default", () => {
    const status = liveOrdersStatus({} as NodeJS.ProcessEnv);
    expect(status.reasons).toContain("LIVE_ORDERS_ENABLED is off.");
    expect(status.reasons).toContain("No static-IP execution service is configured.");
  });
});

describe("authorization helpers", () => {
  it("treats a foreign account exactly like a missing one", () => {
    expect(() => assertOwnsAccount({ id: "u1" }, { ownerId: "u2" })).toThrow("Broker account not found.");
    expect(() => assertOwnsAccount({ id: "u1" }, null)).toThrow("Broker account not found.");
    expect(assertOwnsAccount({ id: "u1" }, { ownerId: "u1", x: 1 })).toEqual({ ownerId: "u1", x: 1 });
  });

  it("blocks suspended users from changing accounts", () => {
    expect(() => assertMayManageBrokerAccounts({ status: "SUSPENDED" })).toThrow(/not active/);
    expect(() => assertMayManageBrokerAccounts({ status: "ACTIVE" })).not.toThrow();
  });
});

describe("rate limit", () => {
  it("allows the limit then refuses until the window resets", () => {
    resetRateLimits();
    for (let i = 0; i < 3; i += 1) rateLimit("k", 3, 1000, 0);
    expect(() => rateLimit("k", 3, 1000, 10)).toThrow(/Too many requests/);
    expect(() => rateLimit("k", 3, 1000, 1000)).not.toThrow();
  });
});

describe("who may paper trade", () => {
  it("allows students and the trading-enabled super admin, never instructors", async () => {
    const { mayPractice } = await import("../src/lib/auth/permissions");
    expect(mayPractice({ role: "STUDENT", status: "ACTIVE", tradingEnabled: true })).toBe(true);
    expect(mayPractice({ role: "SUPER_ADMIN", status: "ACTIVE", tradingEnabled: true })).toBe(true);
    expect(mayPractice({ role: "SUPER_ADMIN", status: "ACTIVE", tradingEnabled: false })).toBe(false);
    expect(mayPractice({ role: "SUPER_ADMIN", status: "SUSPENDED", tradingEnabled: true })).toBe(false);
    expect(mayPractice({ role: "INSTRUCTOR", status: "ACTIVE", tradingEnabled: true })).toBe(false);
  });
});
