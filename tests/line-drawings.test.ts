import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appliesTo,
  buildLineOverlays,
  dayRequest,
  defaultConfig,
  LINE_STRATEGIES,
  LINES_PREFIX,
  MAX_LINE_DRAWINGS,
  newLine,
  normalizeConfig,
  normalizeSymbol,
  normalizeTimeframe,
  resolveLevels,
  type LevelLine,
  type LineDay,
  type LineDrawing,
  type LineStrategyId,
} from "@/lib/chart/line-drawings";
import type { Candle } from "@/lib/algo/lines";
import { s1Levels, type S1Data } from "@/lib/trading/s1";

const OPEN = Date.UTC(2026, 10, 20, 3, 45) / 1000; // 09:15 IST
const CLOSE = OPEN + 375 * 60;
const data: S1Data = {
  symbol: "NIFTY",
  date: "2026-11-20",
  sessionOpen: OPEN,
  sessionClose: CLOSE,
  status: "ready",
  message: "",
  previous: { date: "2026-11-19", open: 24100, high: 24250, low: 24050, close: 24200 } as S1Data["previous"],
  open: 24180,
  firstMinute: { time: OPEN, open: 24180, high: 24210, low: 24160 },
  anchors: { before: OPEN - 2 * 86400, previous: OPEN - 86400, day: OPEN, after: OPEN + 86400 },
};
/** A full session of 1-minute candles: minute i trades around 24180 + i * 0.5 (high +2, low -2). */
const tape: Candle[] = Array.from({ length: 375 }, (_, i) => {
  const mid = 24180 + i * 0.5;
  return { time: OPEN + i * 60, open: mid, high: mid + 2, low: mid - 2, close: mid + 0.25 };
});
const day: LineDay = { data, tape };
const AFTER = CLOSE + 60;

let n = 0;
function drawing(strategy: LineStrategyId, lines?: LevelLine[], patch: Partial<LineDrawing> = {}): LineDrawing {
  n += 1;
  const config = defaultConfig(strategy);
  return { id: `d${n}`, name: `D${n}`, symbol: "*", timeframe: "all", enabled: true, config: lines ? { ...config, lines } : config, createdAt: "", updatedAt: "", ...patch };
}
const ctx = (cursor: number | null = null, now = AFTER, d: LineDay = day) => ({ symbol: "NIFTY", span: "5m", dayFor: () => ({ day: d, cursor, now }) });

describe("strategy catalogue", () => {
  it("lists our index strategies, each with its own default lines", () => {
    expect(LINE_STRATEGIES.map((item) => item.id)).toEqual(["mathi", "hourly_zone", "second_hour", "breakout_0915", "minute_1315", "trend_channel"]);
    for (const item of LINE_STRATEGIES) {
      const config = defaultConfig(item.id);
      expect(config).toMatchObject({ strategy: item.id, currentDay: "", previousDay: "" });
      expect(config.lines.some((line) => line.visible)).toBe(true);
      expect(new Set(config.lines.map((line) => line.id)).size).toBe(config.lines.length);
    }
  });
});

describe("levels", () => {
  it("uses the Strategy's own S1 box levels and the previous day", () => {
    const levels = s1Levels(data.previous, data.open, data.firstMinute)!;
    const out = resolveLevels(day, null, AFTER);
    expect(out.boxA_top?.value).toBe(levels.closeBox.top);
    expect(out.boxB_bottom?.value).toBe(levels.openBox!.bottom);
    expect([out.pdh?.value, out.pdl?.value, out.pdc?.value]).toEqual([24250, 24050, 24200]);
    expect([out.or_high?.value, out.or_low?.value]).toEqual([24210, 24160]);
  });

  it("reads the 09:15 and 10:15 hours and the 13:15 candle from the day's candles", () => {
    const out = resolveLevels(day, null, AFTER);
    // Hour 1 = minutes 0..59, hour 2 = 60..119.
    expect(out.h1_high?.value).toBe(24180 + 59 * 0.5 + 2);
    expect(out.h1_low?.value).toBe(24180 - 2);
    expect(out.h1_close?.value).toBe(24180 + 59 * 0.5 + 0.25);
    expect(out.h2_high?.value).toBe(24180 + 119 * 0.5 + 2);
    expect(out.h2_low?.value).toBe(24180 + 60 * 0.5 - 2);
    expect(out.m1315_high?.value).toBe(24180 + 240 * 0.5 + 2);
    expect(out.m1315_low?.start).toBe(OPEN + 240 * 60);
  });

  it("shows nothing before it existed (live clock or replay cursor)", () => {
    const early = resolveLevels(day, OPEN + 30 * 60, AFTER);
    expect(early.h1_high).toBeUndefined();
    expect(early.or_high).toBeDefined();
    const at1015 = resolveLevels(day, null, OPEN + 60 * 60);
    expect(at1015.h1_high).toBeDefined();
    expect(at1015.h2_high).toBeUndefined();
    expect(resolveLevels(day, OPEN + 240 * 60, AFTER).m1315_high).toBeUndefined();
    expect(resolveLevels(day, OPEN + 241 * 60, AFTER).m1315_high).toBeDefined();
    expect(resolveLevels({ data, tape: null }, null, AFTER).h1_high).toBeUndefined();
  });
});

describe("buildLineOverlays", () => {
  it("draws each enabled strategy's visible lines with stable ids", () => {
    const second = drawing("second_hour");
    const out = buildLineOverlays([second], ctx());
    expect(out.map((item) => item.points[0].price)).toEqual([24180 + 119 * 0.5 + 2, 24180 + 60 * 0.5 - 2]);
    expect(out.every((item) => item.id.startsWith(`${LINES_PREFIX}${second.id}:`) && item.locked)).toBe(true);
    expect(buildLineOverlays([second], ctx()).map((item) => item.id)).toEqual(out.map((item) => item.id));
  });

  it("skips disabled strategies, rows without a strategy, other symbols and hidden lines", () => {
    const on = drawing("breakout_0915");
    const off = drawing("mathi", undefined, { enabled: false });
    const legacy = { ...drawing("mathi"), config: { ...defaultConfig("mathi"), strategy: null } };
    const bank = drawing("minute_1315", undefined, { symbol: "BANKNIFTY" });
    const ids = new Set(buildLineOverlays([on, off, legacy, bank], ctx()).map((item) => item.id.split(":")[1]));
    expect([...ids]).toEqual([on.id]);
    expect(buildLineOverlays([on], { ...ctx(), symbol: "BANKNIFTY" })).toHaveLength(0); // the data is NIFTY's
    expect(appliesTo(bank, "BANKNIFTY", "1d")).toBe(true);
  });

  it("merges the same price with the same style into one line, keeping both names", () => {
    const a = drawing("mathi", [{ ...newLine("pdc"), color: "#2962FF" }]);
    const b = drawing("mathi", [{ ...newLine("boxA_mid"), color: "#2962FF", dash: "solid" }]); // box A mid = previous close
    const out = buildLineOverlays([a, b], ctx());
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("PDC");
    expect(out[0].text).toContain("A Mid");
  });

  it("draws the channel as a sloped segment to the close", () => {
    const zig: Candle[] = Array.from({ length: 375 }, (_, i) => {
      const mid = 24180 + 40 * Math.sin(i / 9) + i * 0.3;
      return { time: OPEN + i * 60, open: mid - 1, high: mid + 3, low: mid - 3, close: mid + 1 };
    });
    const out = buildLineOverlays([drawing("trend_channel", [newLine("ch_upper"), newLine("ch_lower")])], ctx(null, AFTER, { data, tape: zig }));
    expect(out).toHaveLength(2);
    for (const item of out) {
      expect(item.kind).toBe("trend");
      expect(item.points[1].time).toBe(CLOSE);
    }
  });

  it("applies label and extend settings", () => {
    const [out] = buildLineOverlays([drawing("mathi", [{ ...newLine("pdh"), showPrice: false, extend: "session" }])], ctx());
    expect(out.text).toBe("PDH");
    expect(out.kind).toBe("trend");
    expect(out.points.map((point) => point.time)).toEqual([data.sessionOpen, data.sessionClose]);
    const [full] = buildLineOverlays([drawing("mathi", [{ ...newLine("pdl"), extend: "full", showName: false }])], ctx());
    expect(full.kind).toBe("hline");
    expect(full.text).toBe("24,050.00");
  });
});

describe("dates", () => {
  it("uses the row's own days, else the replayed day, else live; same days share one request", () => {
    const auto = drawing("mathi");
    expect(dayRequest(auto, "nifty", null)).toMatchObject({ symbol: "NIFTY", date: null, previous: null, tape: false });
    expect(dayRequest(auto, "NIFTY", "2026-11-18").date).toBe("2026-11-18");
    const chosen = drawing("hourly_zone");
    chosen.config = { ...chosen.config, currentDay: "2026-11-20", previousDay: "2026-11-18" };
    expect(dayRequest(chosen, "NIFTY", "2026-11-10")).toMatchObject({ date: "2026-11-20", previous: "2026-11-18", tape: true });
    expect(dayRequest(drawing("mathi"), "NIFTY", null).key).toBe(dayRequest(auto, "NIFTY", null).key);
  });
});

describe("config validation", () => {
  it("drops unknown kinds and strategies, cleans colours, styles, ids and dates", () => {
    const config = normalizeConfig({
      strategy: "mathi",
      currentDay: "2026-11-20",
      previousDay: "2026-11-21",
      lines: [
        { kind: "pdh", id: "a", color: "red", width: 9, dash: "wavy", name: "  High  " },
        { kind: "bogus" },
        { kind: "h2_high", id: "a" },
      ],
    });
    expect(config.strategy).toBe("mathi");
    expect(config.currentDay).toBe("2026-11-20");
    expect(config.previousDay).toBe(""); // must be before the current day
    expect(config.lines.map((line) => line.kind)).toEqual(["pdh", "h2_high"]);
    expect(config.lines[0]).toMatchObject({ name: "High", color: "#089981", width: 1, dash: "solid" });
    expect(new Set(config.lines.map((line) => line.id)).size).toBe(2);
    expect(normalizeConfig({ strategy: "nope", currentDay: "20-11-2026" })).toEqual({ strategy: null, currentDay: "", previousDay: "", entry: true, lines: [] });
    expect(normalizeConfig(null)).toEqual({ strategy: null, currentDay: "", previousDay: "", entry: true, lines: [] });
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
    const config = defaultConfig("mathi");
    let { drawings } = await mutateLineDrawings("u1", { action: "create", name: "Previous Day Levels", symbol: "nifty", timeframe: "5m", config });
    await mutateLineDrawings("u1", { action: "create", name: "Custom", config: defaultConfig("minute_1315") });
    const [first, second] = await listLineDrawings("u1");
    expect(first).toMatchObject({ name: "Previous Day Levels", symbol: "NIFTY", timeframe: "5m", enabled: true });
    expect(first.config.lines).toHaveLength(defaultConfig("mathi").lines.length);
    expect(first.config.strategy).toBe("mathi");
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
