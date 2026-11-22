import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appliesTo,
  buildLineOverlays,
  LINES_PREFIX,
  MAX_LINE_DRAWINGS,
  needsMarketData,
  newLine,
  normalizeConfig,
  normalizeSymbol,
  normalizeTimeframe,
  type LevelLine,
  type LineDrawing,
} from "@/lib/chart/line-drawings";
import { s1Levels, type S1Data } from "@/lib/trading/s1";

const OPEN = Date.UTC(2026, 10, 20, 3, 45) / 1000; // 09:15 IST
const data: S1Data = {
  symbol: "NIFTY",
  date: "2026-11-20",
  sessionOpen: OPEN,
  sessionClose: OPEN + 375 * 60,
  status: "ready",
  message: "",
  previous: { date: "2026-11-19", open: 24100, high: 24250, low: 24050, close: 24200 } as S1Data["previous"],
  open: 24180,
  firstMinute: { time: OPEN, open: 24180, high: 24210, low: 24160 },
  anchors: { before: OPEN - 2 * 86400, previous: OPEN - 86400, day: OPEN, after: OPEN + 86400 },
};

let n = 0;
function drawing(lines: LevelLine[], patch: Partial<LineDrawing> = {}): LineDrawing {
  n += 1;
  return { id: `d${n}`, name: `D${n}`, symbol: "NIFTY", timeframe: "all", enabled: true, config: { lines }, createdAt: "", updatedAt: "", ...patch };
}
const ctx = { symbol: "NIFTY", span: "5m", data, cursor: null };

describe("buildLineOverlays", () => {
  it("draws previous-day, open and 09:15 levels from the session data", () => {
    const d = drawing(["pdh", "pdl", "pdc", "pdm", "open", "or_high", "or_low"].map((kind) => newLine(kind as LevelLine["kind"])));
    const out = buildLineOverlays([d], ctx);
    const prices = out.map((item) => item.points[0].price).sort((a, b) => a - b);
    expect(prices).toEqual([24050, 24150, 24160, 24180, 24200, 24210, 24250]);
    expect(out.every((item) => item.id.startsWith(`${LINES_PREFIX}${d.id}:`) && item.locked)).toBe(true);
  });

  it("uses the Strategy's own S1 box levels for strategy lines (no new calculation)", () => {
    const levels = s1Levels(data.previous, data.open, data.firstMinute)!;
    const d = drawing([newLine("boxA_top"), newLine("boxA_mid"), newLine("boxB_bottom")]);
    const prices = buildLineOverlays([d], ctx).map((item) => item.points[0].price);
    expect(prices).toEqual([levels.closeBox.top, levels.closeBox.mid, levels.openBox!.bottom]);
  });

  it("shows only enabled drawings for this symbol and timeframe, and only visible lines", () => {
    const on = drawing([newLine("pdh")]);
    const off = drawing([newLine("pdl")], { enabled: false });
    const bank = drawing([newLine("pdc")], { symbol: "BANKNIFTY" });
    const daily = drawing([newLine("pdm")], { timeframe: "1d" });
    const every = drawing([newLine("open")], { symbol: "*" });
    const hidden = drawing([{ ...newLine("or_high"), visible: false }]);
    const ids = buildLineOverlays([on, off, bank, daily, every, hidden], ctx).map((item) => item.id.split(":")[1]);
    expect(ids.sort()).toEqual([on.id, every.id].sort());
    expect(appliesTo(daily, "NIFTY", "1d")).toBe(true);
  });

  it("gives every object a stable id, so re-rendering or toggling another drawing never duplicates lines", () => {
    const a = drawing([newLine("pdh"), newLine("pdl")]);
    const b = drawing([newLine("open")]);
    const first = buildLineOverlays([a, b], ctx).map((item) => item.id);
    const again = buildLineOverlays([a, b], ctx).map((item) => item.id);
    const withoutB = buildLineOverlays([a, { ...b, enabled: false }], ctx).map((item) => item.id);
    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(withoutB).toEqual(first.filter((id) => !id.includes(`:${b.id}:`)));
  });

  it("merges the same price with the same style into one line, keeping both names", () => {
    const one = drawing([{ ...newLine("pdc"), color: "#2962FF" }]);
    const two = drawing([{ ...newLine("boxA_mid"), color: "#2962FF", dash: "solid" }]); // box A mid = previous close
    const out = buildLineOverlays([one, two], ctx);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("PDC");
    expect(out[0].text).toContain("A Mid");
    const styled = drawing([{ ...newLine("pdc"), color: "#F23645" }]); // different style: its own line
    expect(buildLineOverlays([one, styled], ctx)).toHaveLength(2);
  });

  it("hides the open and 09:15 levels in replay until they were known", () => {
    const d = drawing([newLine("pdh"), newLine("open"), newLine("or_high")]);
    expect(buildLineOverlays([d], { ...ctx, cursor: OPEN - 60 })).toHaveLength(1);
    expect(buildLineOverlays([d], { ...ctx, cursor: OPEN })).toHaveLength(2);
    expect(buildLineOverlays([d], { ...ctx, cursor: OPEN + 60 })).toHaveLength(3);
  });

  it("draws custom prices without market data, and never another symbol's data", () => {
    const d = drawing([newLine("custom", 24500), newLine("pdh")]);
    const noData = buildLineOverlays([d], { ...ctx, data: null });
    expect(noData.map((item) => item.points[0].price)).toEqual([24500]);
    expect(buildLineOverlays([d], { ...ctx, data: { ...data, symbol: "BANKNIFTY" } })).toHaveLength(1);
    expect(needsMarketData([drawing([newLine("custom", 1)])])).toBe(false);
    expect(needsMarketData([d])).toBe(true);
  });

  it("applies label and extend settings", () => {
    const line = { ...newLine("pdh"), showPrice: false, extend: "session" as const };
    const [out] = buildLineOverlays([drawing([line])], ctx);
    expect(out.text).toBe("PDH");
    expect(out.kind).toBe("trend");
    expect(out.points.map((point) => point.time)).toEqual([data.sessionOpen, data.sessionClose]);
    const [full] = buildLineOverlays([drawing([{ ...newLine("pdl"), extend: "full", showName: false }])], ctx);
    expect(full.kind).toBe("hline");
    expect(full.text).toBe("24,050.00");
  });
});

describe("config validation", () => {
  it("drops unknown kinds and bad prices, cleans colours, styles and ids", () => {
    const config = normalizeConfig({
      lines: [
        { kind: "pdh", id: "a", color: "red", width: 9, dash: "wavy", name: "  High  " },
        { kind: "bogus" },
        { kind: "custom", price: -5 },
        { kind: "custom", price: "24500.123", id: "a" },
      ],
    });
    expect(config.lines.map((line) => line.kind)).toEqual(["pdh", "custom"]);
    expect(config.lines[0]).toMatchObject({ name: "High", color: "#089981", width: 1, dash: "solid" });
    expect(config.lines[1].price).toBe(24500.12);
    expect(new Set(config.lines.map((line) => line.id)).size).toBe(2);
    expect(normalizeConfig(null)).toEqual({ lines: [] });
    expect(normalizeTimeframe("5m")).toBe("5m");
    expect(normalizeTimeframe("7m")).toBe("all");
    expect(normalizeSymbol(" banknifty ")).toBe("BANKNIFTY");
    expect(normalizeSymbol("")).toBe("*");
  });
});

// ── server: persistence scoped to the signed-in user ──

type Row = { id: string; userId: string; name: string; symbol: string; timeframe: string; enabled: boolean; position: number; config: unknown; createdAt: Date; updatedAt: Date };
const rows: Row[] = [];
const match = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => {
  if (value && typeof value === "object" && "in" in (value as object)) return ((value as { in: unknown[] }).in).includes(row[key as keyof Row]);
  return row[key as keyof Row] === value;
});
let idSeq = 0;
const prismaMock = {
  chartLineDrawing: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => match(row, where)).sort((a, b) => a.position - b.position),
    findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: { position: "desc" } }) => {
      const found = rows.filter((row) => match(row, where));
      if (orderBy) found.sort((a, b) => b.position - a.position);
      return found[0] ?? null;
    },
    count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => match(row, where)).length,
    create: async ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt"> }) => {
      const row = { ...data, id: `c${(idSeq += 1)}`, createdAt: new Date(), updatedAt: new Date() } as Row;
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((row) => row.id === where.id)!, data),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((row) => match(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) if (match(rows[index], where)) rows.splice(index, 1);
      return { count: before - rows.length };
    },
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
const { listLineDrawings, mutateLineDrawings } = await import("../src/server/chart-lines");

describe("chart-lines persistence", () => {
  beforeEach(() => { rows.length = 0; });

  it("creates, edits one drawing without touching another, duplicates and deletes", async () => {
    const config = { lines: [newLine("pdh"), newLine("custom", 24500)] };
    let { drawings } = await mutateLineDrawings("u1", { action: "create", name: "Previous Day Levels", symbol: "nifty", timeframe: "5m", config });
    await mutateLineDrawings("u1", { action: "create", name: "Custom", config: { lines: [newLine("custom", 100)] } });
    const [first, second] = await listLineDrawings("u1");
    expect(first).toMatchObject({ name: "Previous Day Levels", symbol: "NIFTY", timeframe: "5m", enabled: true });
    expect(first.config.lines).toHaveLength(2);
    ({ drawings } = await mutateLineDrawings("u1", { action: "update", id: first.id, name: "PD Levels", enabled: false }));
    expect(drawings.find((item) => item.id === first.id)).toMatchObject({ name: "PD Levels", enabled: false });
    expect(drawings.find((item) => item.id === second.id)).toEqual(second);
    ({ drawings } = await mutateLineDrawings("u1", { action: "duplicate", id: first.id }));
    expect(drawings.map((item) => item.name)).toEqual(["PD Levels", "Custom", "PD Levels (copy)"]);
    ({ drawings } = await mutateLineDrawings("u1", { action: "delete", id: second.id }));
    expect(drawings.map((item) => item.name)).toEqual(["PD Levels", "PD Levels (copy)"]);
    ({ drawings } = await mutateLineDrawings("u1", { action: "set-all", enabled: true }));
    expect(drawings.every((item) => item.enabled)).toBe(true);
  });

  it("never lets one user see or change another user's drawing", async () => {
    await mutateLineDrawings("u1", { action: "create", name: "Mine", config: { lines: [] } });
    const [mine] = await listLineDrawings("u1");
    expect(await listLineDrawings("u2")).toEqual([]);
    await expect(mutateLineDrawings("u2", { action: "update", id: mine.id, name: "Stolen" })).rejects.toThrow(/no longer exists/);
    await expect(mutateLineDrawings("u2", { action: "delete", id: mine.id })).rejects.toThrow(/no longer exists/);
    await mutateLineDrawings("u2", { action: "set-all", enabled: false });
    expect((await listLineDrawings("u1"))[0]).toMatchObject({ name: "Mine", enabled: true });
  });

  it("requires a name and caps the number of drawings", async () => {
    await expect(mutateLineDrawings("u1", { action: "create", name: "   " })).rejects.toThrow(/name/);
    for (let index = 0; index < MAX_LINE_DRAWINGS; index += 1) await mutateLineDrawings("u1", { action: "create", name: `D${index}` });
    await expect(mutateLineDrawings("u1", { action: "create", name: "One more" })).rejects.toThrow(/up to/);
  });
});
