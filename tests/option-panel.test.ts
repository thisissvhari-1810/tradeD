import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { optionLedgerSymbol, parseOptionLedgerSymbol, premiumValuePaise } from "@/lib/options/contract";

describe("option chain orders", () => {
  it("keeps a contract identity separate from another strike or expiry", () => {
    const first = optionLedgerSymbol("NIFTY", "2026-10-30", 25000, "CE");
    const second = optionLedgerSymbol("NIFTY", "2026-11-27", 25000, "CE");
    const third = optionLedgerSymbol("NIFTY", "2026-10-30", 25100, "PE");
    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
    expect(parseOptionLedgerSymbol(first)).toEqual({ underlying: "NIFTY", expiry: "2026-10-30", strike: 25000, right: "CE" });
  });

  it("prices a long option as premium times lots times the chain lot size", () => {
    expect(premiumValuePaise(10_000n, 1, 65)).toBe(650_000n);
    expect(premiumValuePaise(10_000n, 2, 65)).toBe(1_300_000n);
    expect(premiumValuePaise(10_000n, 0, 65)).toBeNull();
  });

  it("does not send the option demo route to a broker", () => {
    const route = readFileSync("src/app/api/demo/option/route.ts", "utf8");
    const trading = readFileSync("src/server/trading.ts", "utf8");
    const start = trading.indexOf("export async function placeOptionDemo");
    const end = trading.indexOf("export async function adjustFunds");
    const order = trading.slice(start, end);
    expect(route).not.toMatch(/api\.dhan\.co/);
    expect(order).toMatch(/loadOptionChain\(/);
    expect(order).toMatch(/Short options are not available/);
    expect(order).not.toMatch(/api\.dhan\.co/);
  });

  it("asks for the option contract's own candles and does not invent them from the index", () => {
    const route = readFileSync("src/app/api/options/candles/route.ts", "utf8");
    const market = readFileSync("src/server/dhan-market.ts", "utf8");
    const start = market.indexOf("export async function dhanOptionCandles");
    const end = market.indexOf("export async function dhanCandles");
    const option = market.slice(start, end);
    expect(route).toMatch(/loadOptionCandles/);
    expect(route).not.toMatch(/api\.dhan\.co/);
    expect(option).toMatch(/NSE_FNO/);
    expect(option).toMatch(/OPTIDX/);
    expect(option).toMatch(/OPTSTK/);
    expect(option).toMatch(/Historical candles were not returned for this option contract/);
    expect(option).not.toMatch(/dhanCandles\(/);
  });

  it("keeps the selected symbol out of the search field and reads lot size from the contract master", () => {
    const panel = readFileSync("src/components/option-chain-panel.tsx", "utf8");
    const lots = readFileSync("src/server/option-lots.ts", "utf8");
    expect(panel).toMatch(/placeholder="Search underlying"/);
    expect(panel).toMatch(/oc-search/);
    expect(panel).not.toMatch(/placeholder=\{chain\?\.name/);
    const book = readFileSync("src/components/option-book.tsx", "utf8");
    const ticket = readFileSync("src/components/option-order-ticket.tsx", "utf8");
    expect(book).toMatch(/Exit position/);
    expect(panel).not.toMatch(/\/api\/demo\/option/);
    expect(ticket).toMatch(/\$\{buy \? "Buy" : "Sell"\} \$\{validLots \? parsed : "—"\} lot/);
    expect(ticket).toMatch(/\/api\/demo\/option/);
    expect(ticket).not.toMatch(/api\.dhan\.co/);
    expect(lots).toMatch(/SEM_LOT_UNITS/);
    expect(lots).not.toMatch(/SAMPLE_LOT/);
  });
});
