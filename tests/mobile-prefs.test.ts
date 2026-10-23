import { describe, expect, it } from "vitest";
import { MOBILE_DEFAULTS, parseMobilePrefs } from "@/components/mobile-prefs";
import { rankInstruments } from "@/components/symbol-search";

describe("mobile & compact mode preferences", () => {
  it("fall back to safe defaults for missing or broken saves", () => {
    expect(parseMobilePrefs(null)).toEqual(MOBILE_DEFAULTS);
    expect(parseMobilePrefs("not json")).toEqual(MOBILE_DEFAULTS);
    expect(parseMobilePrefs("42")).toEqual(MOBILE_DEFAULTS);
  });

  it("keep valid choices and drop unknown tools, duplicates and wrong types", () => {
    const prefs = parseMobilePrefs(JSON.stringify({ density: "comfortable", navLabels: false, quickTools: ["trend", "nope", "trend", "fib"], chartLegend: "yes" }));
    expect(prefs.density).toBe("comfortable");
    expect(prefs.navLabels).toBe(false);
    expect(prefs.quickTools).toEqual(["trend", "fib"]);
    expect(prefs.chartLegend).toBe(MOBILE_DEFAULTS.chartLegend);
  });

  it("allow at most 8 quick tools", () => {
    const many = ["trend", "hline", "hray", "ray", "vline", "rect", "fib", "channel", "long", "short"];
    expect(parseMobilePrefs(JSON.stringify({ quickTools: many })).quickTools).toHaveLength(8);
  });
});

describe("stock search ranking", () => {
  const row = (symbol: string, name: string, exchange = "NSE") => ({ symbol, name, exchange, sector: "EQ" });
  it("puts the exact symbol first, then symbols starting with the query, and removes duplicates", () => {
    const rows = [row("ATCSOFT", "A Tcs Soft"), row("TCSPLUS", "Tcs Plus"), row("TCS", "Tata Consultancy"), row("TCS", "Tata Consultancy")];
    expect(rankInstruments(rows, "tcs").map((item) => item.symbol)).toEqual(["TCS", "TCSPLUS", "ATCSOFT"]);
  });
});
