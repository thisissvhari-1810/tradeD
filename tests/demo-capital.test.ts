import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { can } from "@/lib/auth/permissions";

describe("demo capital permissions", () => {
  it("lets only an admin allocate or reset demo capital", () => {
    expect(can("STUDENT", "funds.adjust")).toBe(false);
    expect(can("STUDENT", "accounts.reset")).toBe(false);
    expect(can("INSTRUCTOR", "funds.adjust")).toBe(false);
    expect(can("INSTRUCTOR", "accounts.reset")).toBe(false);
    expect(can("SUPER_ADMIN", "funds.adjust")).toBe(true);
    expect(can("SUPER_ADMIN", "accounts.reset")).toBe(true);
  });

  it("prices replay orders from history and does not call a broker", () => {
    const route = readFileSync("src/app/api/demo/replay/route.ts", "utf8");
    const trading = readFileSync("src/server/trading.ts", "utf8");
    const start = trading.indexOf("export async function placeReplayOrder");
    const end = trading.indexOf("export async function settleReplayOrders");
    const order = trading.slice(start, end);
    expect(route).not.toMatch(/api\.dhan\.co/);
    expect(route).not.toMatch(/placeOrder\(/);
    expect(order).toMatch(/getReplay\(/);
    expect(order).toMatch(/HISTORICAL/);
    expect(order).not.toMatch(/api\.dhan\.co/);
    expect(order).not.toMatch(/getQuote\(/);
    expect(trading).not.toMatch(/cannot buy it as shares/);
    expect(trading).toMatch(/lotSize: 1/);
  });
});
