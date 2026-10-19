import { describe, expect, it } from "vitest";
import { findIndex, searchIndices } from "@/lib/market/indices";
import { parseOptionChain } from "@/server/option-chain";
import { lotsFromMaster } from "@/server/option-lots";

describe("index list and option chain", () => {
  it("finds Nifty 50 and Nifty 100 from the scrip ids", () => {
    expect(findIndex("NIFTY")).toMatchObject({ id: "13", name: "Nifty 50" });
    expect(findIndex("nifty 100")).toMatchObject({ id: "17", symbol: "NIFTY100" });
    expect(findIndex("BANKNIFTY")?.id).toBe("25");
  });

  it("puts the requested indices on an empty search and finds them by name", () => {
    expect(searchIndices("").map((row) => row.symbol)).toEqual(["NIFTY", "NIFTY100", "NIFTYNXT50", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "INDIAVIX"]);
    expect(searchIndices("nifty50").map((row) => row.symbol)).toContain("NIFTY");
    expect(searchIndices("index").length).toBeGreaterThan(20);
  });

  it("computes PCR, ATM, and open-interest change from the chain payload", () => {
    const parsed = parseOptionChain({
      data: {
        last_price: 100,
        oc: {
          "90.000000": {
            ce: { last_price: 12, oi: 100, previous_oi: 80, volume: 10, implied_volatility: 15 },
            pe: { last_price: 1, oi: 50, previous_oi: 40, volume: 4, implied_volatility: 16 },
          },
          "100.000000": {
            ce: { last_price: 5, oi: 200, previous_oi: 100, volume: 20, implied_volatility: 18, lot_size: 65, security_id: 49081 },
            pe: { last_price: 5, oi: 300, previous_oi: 150, volume: 30, implied_volatility: 19 },
          },
        },
      },
    }, "2026-10-30", null);
    expect(parsed.atmStrike).toBe(100);
    expect(parsed.atmIv).toBe(18);
    expect(parsed.lotSize).toBe(65);
    expect(parsed.pcr).toBeCloseTo(350 / 300);
    expect(parsed.strikes.find((row) => row.strike === 100)?.ce?.oiChangePct).toBe(100);
    expect(parsed.strikes.find((row) => row.strike === 100)?.ce?.securityId).toBe("49081");
    expect(parsed.strikes.find((row) => row.strike === 90)?.ce?.securityId).toBeNull();
  });

  it("reads an option lot from the contract master and ignores other instruments", () => {
    const lots = lotsFromMaster([
      "SEM_SMST_SECURITY_ID,SEM_LOT_UNITS,SEM_OPTION_TYPE",
      "13,1,XX",
      "49081,65.0,CE",
      "49082,65,PE",
    ].join("\n"));
    expect(lots.get("49081")).toBe(65);
    expect(lots.get("49082")).toBe(65);
    expect(lots.has("13")).toBe(false);
  });
});
