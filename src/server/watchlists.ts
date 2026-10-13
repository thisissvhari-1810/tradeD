import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";

const SEEDS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "ITC", "BHARTIARTL", "LT", "HINDUNILVR", "AXISBANK", "KOTAKBANK", "BAJFINANCE", "SUNPHARMA", "WIPRO", "NTPC"];

function present(list: {
  id: string;
  name: string;
  items: Array<{ instrument: { symbol: string; name: string; exchange: string } }>;
}) {
  return {
    id: list.id,
    name: list.name,
    items: list.items.map((item) => ({
      symbol: item.instrument.symbol,
      name: item.instrument.name,
      exchange: item.instrument.exchange,
    })),
  };
}

export async function listWatchlists(userId: string) {
  let lists = await prisma.watchlist.findMany({
    where: { userId },
    include: { items: { include: { instrument: true }, orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  if (!lists.length) {
    const seeds = await prisma.instrument.findMany({ where: { symbol: { in: SEEDS }, isActive: true } });
    const created = await prisma.watchlist.create({
      data: {
        userId,
        name: "Default",
        ...(seeds.length ? { items: { create: seeds.map((instrument) => ({ instrumentId: instrument.id })) } } : {}),
      },
      include: { items: { include: { instrument: true }, orderBy: { createdAt: "asc" } } },
    });
    lists = [created];
  }
  const empty = lists.filter((list) => list.items.length === 0 && (list.name === "Default" || lists.every((item) => item.items.length === 0)));
  if (empty.length) {
    const seeds = await prisma.instrument.findMany({ where: { symbol: { in: SEEDS }, isActive: true } });
    if (seeds.length) {
      await prisma.watchlistItem.createMany({
        data: empty.flatMap((list) => seeds.map((instrument) => ({ watchlistId: list.id, instrumentId: instrument.id }))),
        skipDuplicates: true,
      });
      lists = await prisma.watchlist.findMany({
        where: { userId },
        include: { items: { include: { instrument: true }, orderBy: { createdAt: "asc" } } },
        orderBy: { createdAt: "asc" },
      });
    }
  }
  return lists.map(present);
}

export async function mutateWatchlist(
  userId: string,
  body: { action?: string; id?: string; name?: string; symbol?: string },
) {
  const action = body.action ?? "";
  if (action === "create") {
    const name = cleanName(body.name);
    const count = await prisma.watchlist.count({ where: { userId } });
    if (count >= 12) throw new AppError("Twelve watchlists is the current limit.", 400);
    try {
      const created = await prisma.watchlist.create({
        data: { userId, name },
        include: { items: { include: { instrument: true } } },
      });
      return present(created);
    } catch (error) {
      duplicateName(error);
    }
  }
  const list = await owned(userId, body.id);
  if (action === "rename") {
    const name = cleanName(body.name);
    try {
      const updated = await prisma.watchlist.update({
        where: { id: list.id },
        data: { name },
        include: { items: { include: { instrument: true }, orderBy: { createdAt: "asc" } } },
      });
      return present(updated);
    } catch (error) {
      duplicateName(error);
    }
  }
  if (action === "delete") {
    const count = await prisma.watchlist.count({ where: { userId } });
    if (count <= 1) throw new AppError("Keep at least one watchlist.", 400);
    await prisma.watchlist.delete({ where: { id: list.id } });
    return { ok: true };
  }
  const symbol = (body.symbol ?? "").trim().toUpperCase();
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument?.isActive) throw new AppError("Instrument not found.", 404);
  if (action === "remove") {
    await prisma.watchlistItem.deleteMany({ where: { watchlistId: list.id, instrumentId: instrument.id } });
    return { ok: true };
  }
  if (action === "add") {
    const count = await prisma.watchlistItem.count({ where: { watchlistId: list.id } });
    if (count >= 50) throw new AppError("This watchlist already has 50 instruments.", 400);
    await prisma.watchlistItem.upsert({
      where: { watchlistId_instrumentId: { watchlistId: list.id, instrumentId: instrument.id } },
      create: { watchlistId: list.id, instrumentId: instrument.id },
      update: {},
    });
    return { ok: true };
  }
  throw new AppError("Unknown watchlist action.", 400);
}

function duplicateName(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new AppError("A watchlist with that name already exists.", 409);
  }
  throw error;
}

function cleanName(value: string | undefined) {
  const name = (value ?? "").trim();
  if (name.length < 1 || name.length > 40) throw new AppError("Name the watchlist with 1 to 40 characters.", 400);
  return name;
}

async function owned(userId: string, id: string | undefined) {
  if (!id) throw new AppError("Choose a watchlist.", 400);
  const list = await prisma.watchlist.findFirst({ where: { id, userId } });
  if (!list) throw new AppError("Watchlist not found.", 404);
  return list;
}
