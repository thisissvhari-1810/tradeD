import { describe, expect, it, vi } from "vitest";
import scrips from "@/lib/market/nse-eq.json";

/** Company names as the instrument master stores them, for the stocks the search must cover. */
const NAMES: Record<string, string> = {
  RELIANCE: "RELIANCE INDUSTRIES LTD", HDFCBANK: "HDFC BANK LTD", ICICIBANK: "ICICI BANK LTD.", INFY: "INFOSYS LIMITED", TCS: "TATA CONSULTANCY SERV LT",
  SBIN: "STATE BANK OF INDIA", BHARTIARTL: "BHARTI AIRTEL LIMITED", LT: "LARSEN & TOUBRO LTD.", ITC: "ITC LTD", AXISBANK: "AXIS BANK LIMITED",
  KOTAKBANK: "KOTAK MAHINDRA BANK LTD", TMPV: "TATA MOTORS PASS VEH LTD", TMCV: "TATA MOTORS LIMITED", "M&M": "MAHINDRA & MAHINDRA LTD", TATASTEEL: "TATA STEEL LIMITED",
  HINDUNILVR: "HINDUSTAN UNILEVER LTD.", WIPRO: "WIPRO LTD", HCLTECH: "HCL TECHNOLOGIES LTD", BAJFINANCE: "BAJAJ FINANCE LIMITED", BAJAJFINSV: "BAJAJ FINSERV LTD.",
  MARUTI: "MARUTI SUZUKI INDIA LTD.", SUNPHARMA: "SUN PHARMACEUTICAL IND L", NTPC: "NTPC LTD", POWERGRID: "POWER GRID CORP. LTD.", ONGC: "OIL AND NATURAL GAS CORP.",
  COALINDIA: "COAL INDIA LTD", TITAN: "TITAN COMPANY LIMITED", ULTRACEMCO: "ULTRATECH CEMENT LIMITED", ADANIPORTS: "ADANI PORT & SEZ LTD", ASIANPAINT: "ASIAN PAINTS LIMITED",
  ETERNAL: "ETERNAL LIMITED", HDFCAMC: "HDFC AMC LIMITED", HDFCLIFE: "HDFC LIFE INS CO LTD",
};
const CATALOGUE = Object.entries(NAMES).map(([symbol, name]) => ({ symbol, name, exchange: "NSE", sector: "", lotSize: 1, tickPaise: 5, isActive: true }));

type Where = { isActive?: boolean; symbol?: { in?: string[]; startsWith?: string }; OR?: Array<{ symbol?: { contains: string }; name?: { contains: string } }>; sector?: string };
function matches(row: (typeof CATALOGUE)[number], where: Where) {
  const has = (value: string, part: string) => value.toUpperCase().includes(part.toUpperCase());
  if (where.symbol?.in) return where.symbol.in.includes(row.symbol);
  if (where.symbol?.startsWith) return row.symbol.toUpperCase().startsWith(where.symbol.startsWith.toUpperCase());
  if (where.OR) return where.OR.some((part) => (part.symbol && has(row.symbol, part.symbol.contains)) || (part.name && has(row.name, part.name.contains)));
  return true;
}
vi.mock("@/lib/prisma", () => ({
  prisma: {
    instrument: {
      findMany: async ({ where, take = 1000, skip = 0 }: { where: Where; take?: number; skip?: number }) =>
        CATALOGUE.filter((row) => matches(row, where)).sort((a, b) => a.name.localeCompare(b.name)).slice(skip, skip + take),
    },
  },
}));

const { searchInstruments } = await import("@/server/market");

const REQUIRED = ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "BHARTIARTL", "LT", "ITC", "AXISBANK", "KOTAKBANK", "TMPV", "M&M", "TATASTEEL", "HINDUNILVR", "WIPRO", "HCLTECH", "BAJFINANCE", "BAJAJFINSV", "MARUTI", "SUNPHARMA", "NTPC", "POWERGRID", "ONGC", "COALINDIA", "TITAN", "ULTRACEMCO", "ADANIPORTS", "ASIANPAINT", "ETERNAL"];

describe("stock and index search", () => {
  it("covers the 30 required NSE stocks in the real instrument master (current symbols: ETERNAL for Zomato, TMPV / TMCV for Tata Motors)", () => {
    const master = new Set(Object.keys(scrips as Record<string, unknown>));
    expect(REQUIRED.filter((symbol) => !master.has(symbol))).toEqual([]);
    expect(master.has("TMCV")).toBe(true);
  });

  it("finds every required stock by its symbol, ranked first", async () => {
    for (const symbol of REQUIRED) {
      const rows = await searchInstruments(symbol);
      expect(rows[0]?.symbol, symbol).toBe(symbol);
    }
  });

  it("finds stocks by full or partial company name, and by partial symbol", async () => {
    expect((await searchInstruments("Reliance Industries")).map((row) => row.symbol)).toContain("RELIANCE");
    expect((await searchInstruments("reliance")).map((row) => row.symbol)).toContain("RELIANCE");
    expect((await searchInstruments("asian paints")).map((row) => row.symbol)).toContain("ASIANPAINT");
    const hdfc = (await searchInstruments("HDFC")).map((row) => row.symbol);
    expect(hdfc.slice(0, 3)).toContain("HDFCBANK");
  });

  it("old names still find renamed companies", async () => {
    expect((await searchInstruments("Zomato")).map((row) => row.symbol)).toContain("ETERNAL");
    expect((await searchInstruments("tata motors")).map((row) => row.symbol)).toEqual(expect.arrayContaining(["TMPV", "TMCV"]));
  });

  it("lists supported indices: NIFTY 50, NIFTY BANK, financial services, IT", async () => {
    expect((await searchInstruments("nifty 50"))[0]?.symbol).toBe("NIFTY");
    expect((await searchInstruments("nifty bank")).map((row) => row.symbol)).toContain("BANKNIFTY");
    expect((await searchInstruments("finnifty")).map((row) => row.symbol)).toContain("FINNIFTY");
    expect((await searchInstruments("nifty it")).map((row) => row.symbol)).toContain("NIFTYIT");
  });
});
