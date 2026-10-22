/**
 * Runs during every build, after `prisma migrate deploy`. Idempotent:
 * 1. Seeds the NSE equity catalogue and default trading settings into an empty database.
 * 2. Creates the first account from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, only when the
 *    database has no super admin yet. The password is read from the environment and never printed;
 *    remove it from the environment after the first sign-in.
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import scrips from "../src/lib/market/nse-eq.json";
import { DEMO_UNIVERSE } from "../src/lib/market/demo";
import { DEFAULT_CHARGES, DEFAULT_RISK, DEFAULT_STARTING_CAPITAL_PAISE } from "../src/lib/trading/settings";

if (process.env.POSTGRES_PRISMA_URL) process.env.DATABASE_URL = process.env.POSTGRES_PRISMA_URL;

const prisma = new PrismaClient();

async function seedInstruments() {
  const existing = await prisma.instrument.count();
  if (existing >= 100) {
    console.info(`db-setup: ${existing} instruments present, catalogue seed skipped.`);
    return;
  }
  const demo = new Map(DEMO_UNIVERSE.map((item) => [item.symbol, item]));
  const rows = Object.entries(scrips as Record<string, { id: string; name: string }>)
    .filter(([symbol, row]) => /^[A-Z0-9&-]{1,30}$/.test(symbol) && /^\d+$/.test(row.id) && !symbol.includes("NSETEST"))
    .map(([symbol, row]) => {
      const known = demo.get(symbol);
      return {
        symbol,
        name: (known?.name ?? row.name ?? symbol).slice(0, 160),
        exchange: "NSE",
        sector: known?.sector ?? "",
        tickPaise: known?.tickPaise ?? 5,
        basePaise: known?.basePaise ?? 100,
        dhanSecurityId: row.id,
        lotSize: 1,
        isActive: true,
      };
    });
  for (const item of DEMO_UNIVERSE) {
    if (!rows.some((row) => row.symbol === item.symbol)) rows.push({ symbol: item.symbol, name: item.name, exchange: item.exchange, sector: item.sector, tickPaise: item.tickPaise, basePaise: item.basePaise, dhanSecurityId: "", lotSize: 1, isActive: true });
  }
  for (let index = 0; index < rows.length; index += 500) {
    await prisma.instrument.createMany({ data: rows.slice(index, index + 500), skipDuplicates: true });
  }
  console.info(`db-setup: seeded ${rows.length} instruments.`);
}

async function seedSettings() {
  const defaults: Array<[string, unknown]> = [
    ["trading.startingCapitalPaise", DEFAULT_STARTING_CAPITAL_PAISE.toString()],
    ["trading.charges", DEFAULT_CHARGES],
    ["trading.risk", DEFAULT_RISK],
    ["market.holidays", []],
  ];
  for (const [key, value] of defaults) {
    await prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.parse(JSON.stringify(value)) }, update: {} });
  }
}

async function bootstrapOwner() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || process.env.DHAN_ACCOUNT_OWNER_EMAIL || "").trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  if (await prisma.user.count({ where: { role: "SUPER_ADMIN" } })) {
    if (password) console.warn("db-setup: an admin already exists. Remove BOOTSTRAP_ADMIN_PASSWORD from the environment.");
    return;
  }
  if (!email || !password) {
    console.warn("db-setup: no admin exists yet. Set BOOTSTRAP_ADMIN_PASSWORD (and BOOTSTRAP_ADMIN_EMAIL or DHAN_ACCOUNT_OWNER_EMAIL) and redeploy.");
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("db-setup: the bootstrap email is not valid.");
  if (password.length < 10 || password.length > 128 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new Error("db-setup: BOOTSTRAP_ADMIN_PASSWORD must be 10-128 characters with a letter and a number.");
  }
  const passwordHash = await hash(password, 12);
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || email.split("@")[0] || "Owner";
  await prisma.$transaction(async (tx) => {
    // tradingEnabled: the owner holds the live Dhan account and also uses the paper ledger.
    const user = await tx.user.create({ data: { email, name, passwordHash, role: "SUPER_ADMIN", tradingEnabled: true } });
    const account = await tx.virtualAccount.create({ data: { userId: user.id, currency: "INR", cashAvailable: 0n, cashReserved: 0n } });
    const period = await tx.practicePeriod.create({ data: { accountId: account.id, sequence: 1, label: "Practice period 1", startingCapital: DEFAULT_STARTING_CAPITAL_PAISE, createdById: user.id } });
    await tx.virtualAccount.update({ where: { id: account.id }, data: { currentPeriodId: period.id, cashAvailable: DEFAULT_STARTING_CAPITAL_PAISE } });
    await tx.ledgerEntry.create({
      data: { accountId: account.id, practicePeriodId: period.id, type: "OPENING_BALANCE", cashDelta: DEFAULT_STARTING_CAPITAL_PAISE, reservedDelta: 0n, cashAvailableAfter: DEFAULT_STARTING_CAPITAL_PAISE, cashReservedAfter: 0n, reason: "Starting virtual capital", actorId: user.id },
    });
    await tx.watchlist.create({ data: { userId: user.id, name: "Default" } });
    await tx.auditLog.create({ data: { actorId: user.id, action: "setup.bootstrap", targetType: "User", targetId: user.id, reason: "Build created the first admin from BOOTSTRAP_ADMIN_*." } });
  });
  console.info(`db-setup: created admin ${email}. Remove BOOTSTRAP_ADMIN_PASSWORD from Vercel now.`);
}

const SEED_FLAGS: Record<string, string> = {
  standardTrading: "tradingEnabled",
  demoTrading: "featDemoTrading",
  replay: "featReplay",
  multiAccount: "featMultiAccount",
  brokerConnection: "featBrokerConnection",
  portfolio: "featPortfolio",
  orderHistory: "featOrderHistory",
  analytics: "featAnalytics",
};

/**
 * SEED_USERS creates missing users on deploy, e.g.
 *   SEED_USERS="ashiq@gmail.com|Ashiq|STANDARD|multiAccount=off"
 * Entries are separated by ";". Existing users are never changed. New users get an unusable password:
 * the Super Admin sends a one-time setup link from /super-admin.
 */
async function seedUsers() {
  const raw = process.env.SEED_USERS?.trim();
  if (!raw) return;
  const admin = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" }, select: { id: true } });
  const { startingCapitalPaise } = { startingCapitalPaise: DEFAULT_STARTING_CAPITAL_PAISE, ...(await readStartingCapital()) };
  for (const entry of raw.split(";").map((item) => item.trim()).filter(Boolean)) {
    const [emailRaw, nameRaw, roleRaw, ...flags] = entry.split("|").map((item) => item.trim());
    const email = (emailRaw ?? "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.warn(`db-setup: skipped seed entry with an invalid email.`); continue; }
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) continue;
    const role = (roleRaw ?? "").toUpperCase() === "SUPER_ADMIN" ? "SUPER_ADMIN" : "STUDENT";
    // Standard users start without multi-account and broker connection unless the entry says otherwise.
    const columns: Record<string, boolean> = { featMultiAccount: role === "SUPER_ADMIN", featBrokerConnection: role === "SUPER_ADMIN" };
    for (const flag of flags) {
      const [key, value] = flag.split("=").map((item) => item.trim());
      const column = key ? SEED_FLAGS[key] : undefined;
      if (column) columns[column] = value !== "off" && value !== "false";
    }
    const passwordHash = await hash(randomBytes(32).toString("base64url"), 12);
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, name: nameRaw || email.split("@")[0] || email, passwordHash, role, status: "ACTIVE", createdById: admin?.id ?? null, ...columns } });
      await openDemoWallet(tx, user.id, startingCapitalPaise, admin?.id ?? user.id);
      await tx.auditLog.create({ data: { actorId: admin?.id ?? null, action: "user.seed", targetType: "User", targetId: user.id, reason: "Created from SEED_USERS during deploy.", after: { email, role, ...columns } } });
    });
    console.info(`db-setup: created ${email} (${role === "SUPER_ADMIN" ? "Super Admin" : "Standard User"}). Send a password link from /super-admin.`);
  }
}

async function readStartingCapital() {
  const row = await prisma.appSetting.findUnique({ where: { key: "trading.startingCapitalPaise" } });
  const value = typeof row?.value === "string" || typeof row?.value === "number" ? BigInt(row.value) : null;
  return value && value > 0n ? { startingCapitalPaise: value } : {};
}

async function openDemoWallet(tx: Prisma.TransactionClient, userId: string, startingCapital: bigint, actorId: string) {
  const account = await tx.virtualAccount.create({ data: { userId, mode: "DEMO", currency: "INR", cashAvailable: 0n, cashReserved: 0n } });
  const period = await tx.practicePeriod.create({ data: { accountId: account.id, sequence: 1, label: "Practice period 1", startingCapital, createdById: actorId } });
  await tx.virtualAccount.update({ where: { id: account.id }, data: { currentPeriodId: period.id, cashAvailable: startingCapital } });
  await tx.ledgerEntry.create({ data: { accountId: account.id, practicePeriodId: period.id, type: "OPENING_BALANCE", cashDelta: startingCapital, reservedDelta: 0n, cashAvailableAfter: startingCapital, cashReservedAfter: 0n, reason: "Starting virtual capital", actorId } });
  await tx.watchlist.create({ data: { userId, name: "Default" } });
}

async function main() {
  await seedInstruments();
  await seedSettings();
  await bootstrapOwner();
  await seedUsers();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
