import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import {
  MAX_LINE_DRAWINGS,
  normalizeConfig,
  normalizeSymbol,
  normalizeTimeframe,
  type LineDrawing,
} from "@/lib/chart/line-drawings";

/**
 * Line Strategy Draw persistence: each user's saved chart line drawings in the database (ChartLineDrawing), so they
 * survive refreshes, other browsers and new logins. Every query is scoped to the signed-in user; a drawing id from
 * another user is treated as not found. Drawing only: nothing here touches strategies, algos or orders.
 */

type Row = { id: string; name: string; symbol: string; timeframe: string; enabled: boolean; config: unknown; createdAt: Date; updatedAt: Date };

function present(row: Row): LineDrawing {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    timeframe: normalizeTimeframe(row.timeframe),
    enabled: row.enabled,
    config: normalizeConfig(row.config),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cleanName(value: unknown) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  if (!name) throw new AppError("Give the drawing a name.", 400, "NAME_REQUIRED", { field: "name" });
  return name;
}

export async function listLineDrawings(userId: string): Promise<LineDrawing[]> {
  const rows = await prisma.chartLineDrawing.findMany({ where: { userId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  return rows.map(present);
}

async function own(userId: string, id: unknown) {
  if (typeof id !== "string" || !id) throw new AppError("Choose a drawing.", 400);
  const row = await prisma.chartLineDrawing.findFirst({ where: { id, userId } });
  if (!row) throw new AppError("That drawing no longer exists.", 404, "NOT_FOUND");
  return row;
}

async function nextPosition(userId: string) {
  const count = await prisma.chartLineDrawing.count({ where: { userId } });
  if (count >= MAX_LINE_DRAWINGS) throw new AppError(`You can keep up to ${MAX_LINE_DRAWINGS} line drawings. Delete one first.`, 400, "LIMIT");
  const last = await prisma.chartLineDrawing.findFirst({ where: { userId }, orderBy: { position: "desc" }, select: { position: true } });
  return (last?.position ?? -1) + 1;
}

export type LineDrawingAction =
  | { action: "create"; name: string; symbol?: string; timeframe?: string; enabled?: boolean; config?: unknown }
  | { action: "update"; id: string; name?: string; symbol?: string; timeframe?: string; enabled?: boolean; config?: unknown }
  | { action: "duplicate"; id: string }
  | { action: "delete"; id: string }
  | { action: "set-all"; enabled: boolean; symbol?: string };

/** Applies one change and returns the user's full, updated list. */
export async function mutateLineDrawings(userId: string, body: LineDrawingAction): Promise<{ drawings: LineDrawing[] }> {
  switch (body.action) {
    case "create": {
      const position = await nextPosition(userId);
      await prisma.chartLineDrawing.create({
        data: {
          userId, position, name: cleanName(body.name), symbol: normalizeSymbol(body.symbol), timeframe: normalizeTimeframe(body.timeframe),
          enabled: body.enabled !== false, config: normalizeConfig(body.config),
        },
      });
      break;
    }
    case "update": {
      await own(userId, body.id);
      await prisma.chartLineDrawing.update({
        where: { id: body.id },
        data: {
          ...(body.name !== undefined ? { name: cleanName(body.name) } : {}),
          ...(body.symbol !== undefined ? { symbol: normalizeSymbol(body.symbol) } : {}),
          ...(body.timeframe !== undefined ? { timeframe: normalizeTimeframe(body.timeframe) } : {}),
          ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
          ...(body.config !== undefined ? { config: normalizeConfig(body.config) } : {}),
        },
      });
      break;
    }
    case "duplicate": {
      const row = await own(userId, body.id);
      const position = await nextPosition(userId);
      await prisma.chartLineDrawing.create({
        data: { userId, position, name: `${row.name} (copy)`.slice(0, 60), symbol: row.symbol, timeframe: row.timeframe, enabled: row.enabled, config: normalizeConfig(row.config) },
      });
      break;
    }
    case "delete": {
      await own(userId, body.id);
      await prisma.chartLineDrawing.deleteMany({ where: { id: body.id, userId } });
      break;
    }
    case "set-all": {
      const symbol = body.symbol ? normalizeSymbol(body.symbol) : null;
      await prisma.chartLineDrawing.updateMany({
        where: { userId, ...(symbol && symbol !== "*" ? { symbol: { in: [symbol, "*"] } } : {}) },
        data: { enabled: Boolean(body.enabled) },
      });
      break;
    }
    default:
      throw new AppError("Unknown action.", 400);
  }
  return { drawings: await listLineDrawings(userId) };
}
