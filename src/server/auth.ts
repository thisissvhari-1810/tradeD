import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { premiumFrom, type Premium } from "@/lib/premium/entitlements";
import { cookies } from "next/headers";
import { hash, compare } from "bcryptjs";
import { Secret, TOTP } from "otpauth";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import type { AppRole } from "@/lib/auth/permissions";
import { featuresOf, type Features } from "@/lib/auth/features";

export const SESSION_COOKIE = "td_session";
const SESSION_DAYS = 7;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: AppRole;
  status: "ACTIVE" | "SUSPENDED" | "DISABLED";
  tradingEnabled: boolean;
  mfaEnabled: boolean;
  /** Super Admin controlled feature permissions, re-read on every request. */
  features: Features;
  /** TradeD Premium, from the user's subscription rows (re-read on every request). */
  premium: Premium;
};

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function passwordsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function assertPasswordPolicy(password: string) {
  if (password.length < 10 || password.length > 128) throw new AppError("Password must be 10 to 128 characters.");
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) throw new AppError("Password must include a letter and a number.");
  const banned = ["password123", "tradelab123", "changeme123", "1234567890"];
  if (banned.includes(password.toLowerCase())) throw new AppError("Choose a less common password.");
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return hash(password, 12);
}

let dummyHash: string | null = null;

async function dummyPasswordHash(): Promise<string> {
  dummyHash ??= await hash("tradelab-dummy-password", 12);
  return dummyHash;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { subscriptions: { where: { status: "ACTIVE" }, orderBy: { endsAt: "desc" }, take: 5 } } } },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  if (session.user.status === "DISABLED") return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    status: session.user.status,
    tradingEnabled: session.user.tradingEnabled,
    mfaEnabled: session.user.mfaEnabled,
    features: featuresOf(session.user),
    premium: premiumFrom(session.user.role, session.user.subscriptions ?? []),
  };
}

export async function requireUser(roles?: AppRole[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AppError("Sign in required.", 401);
  if (roles && !roles.includes(user.role)) throw new AppError("You do not have access to this action.", 403);
  return user;
}

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function createSession(userId: string, request: Request): Promise<string> {
  const token = newToken();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
    },
  });
  await setSessionCookie(token);
  return token;
}

export async function revokeCurrentSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }
  await clearSessionCookie();
}

const WINDOW_MS = 15 * 60 * 1000;

export async function assertLoginAllowed(email: string, ip: string) {
  const since = new Date(Date.now() - WINDOW_MS);
  const [emailFailures, ipFailures] = await Promise.all([
    prisma.loginAttempt.count({ where: { email, success: false, createdAt: { gte: since } } }),
    prisma.loginAttempt.count({ where: { ipAddress: ip, success: false, createdAt: { gte: since } } }),
  ]);
  if (emailFailures >= 8 || ipFailures >= 30) throw new AppError("Too many sign-in attempts. Try again in 15 minutes.", 429);
}

export async function recordLoginAttempt(email: string, ip: string, success: boolean) {
  await prisma.loginAttempt.create({ data: { email, ipAddress: ip, success } });
  if (Math.random() < 0.05) {
    await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } } });
  }
}

export async function verifyPassword(email: string, password: string): Promise<{ id: string; mfaEnabled: boolean; status: string; role: AppRole } | null> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  const passwordHash = user?.passwordHash ?? (await dummyPasswordHash());
  const match = await compare(password, passwordHash);
  if (!user || !match || user.status === "DISABLED") return null;
  return { id: user.id, mfaEnabled: user.mfaEnabled, status: user.status, role: user.role };
}

export function createTotp(email: string, secretBase32: string) {
  return new TOTP({ issuer: "TradeLab", label: email, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secretBase32) });
}

export function newMfaSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export async function instructorStudentIds(instructorId: string): Promise<string[]> {
  const classes = await prisma.class.findMany({
    where: { instructorId, archivedAt: null },
    select: { memberships: { select: { userId: true } } },
  });
  return [...new Set(classes.flatMap((item) => item.memberships.map((member) => member.userId)))];
}
