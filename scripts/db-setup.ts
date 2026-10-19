/**
 * Runs during every build, after `prisma migrate deploy`. Idempotent:
 * 1. Seeds the NSE equity catalogue and default trading settings into an empty database.
 * 2. Creates the first account from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, only when the
 *    database has no super admin yet. The password is read from the environment and never printed;
 *    remove it from the environment after the first sign-in.
 */
import { PrismaClient } from "@prisma/client";
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

async function main() {
  await seedInstruments();
  await seedSettings();
  await bootstrapOwner();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
