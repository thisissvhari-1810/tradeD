import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ticketMath } from "@/components/option-order-ticket";

const read = (path: string) => readFileSync(path, "utf8");

describe("order ticket maths", () => {
  it("prices NIFTY 23150 CE, 10 lots of 65 at ₹62.80 against ₹2,00,000", () => {
    const result = ticketMath({ action: "BUY", lots: "10", lotSize: 65, heldLots: 0, premium: 62.8, buyingPower: 200000 });
    expect(result.quantity).toBe(650);
    expect(result.total).toBe(40820);
    expect(result.after).toBe(159180);
    expect(result.short).toBe(false);
  });

  it("flags insufficient buying power before the server is called", () => {
    const result = ticketMath({ action: "BUY", lots: "50", lotSize: 65, heldLots: 0, premium: 62.8, buyingPower: 200000 });
    expect(result.total).toBe(204100);
    expect(result.short).toBe(true);
  });

  it("caps a sell at the held lots and credits buying power", () => {
    expect(ticketMath({ action: "SELL", lots: "11", lotSize: 65, heldLots: 10, premium: 62.8, buyingPower: 0 }).validLots).toBe(false);
    const sell = ticketMath({ action: "SELL", lots: "4", lotSize: 65, heldLots: 10, premium: 62.8, buyingPower: 1000 });
    expect(sell.quantity).toBe(260);
    expect(sell.after).toBe(1000 + 16328);
  });

  it("shows nothing when the premium or lot size is unknown", () => {
    expect(ticketMath({ action: "BUY", lots: "1", lotSize: null, heldLots: 0, premium: 62.8, buyingPower: 1 }).total).toBeNull();
    expect(ticketMath({ action: "BUY", lots: "1", lotSize: 65, heldLots: 0, premium: null, buyingPower: 1 }).total).toBeNull();
    expect(ticketMath({ action: "BUY", lots: "", lotSize: 65, heldLots: 0, premium: 62.8, buyingPower: 1 }).validLots).toBe(false);
  });
});

describe("order ticket layout", () => {
  const ticket = read("src/components/option-order-ticket.tsx");

  it("has the header chips, demo badge and segmented buy / sell", () => {
    expect(ticket).toContain('<Badge tone="demo">Demo</Badge>');
    expect(ticket).toContain('draft.right === "CE" ? "Call" : "Put"');
    expect(ticket).toContain("Exp {shortDate(draft.expiry)}");
    expect(ticket).toMatch(/id: "BUY", label: "Buy", tone: "profit"/);
    expect(ticket).toMatch(/id: "SELL", label: "Sell", tone: "loss"/);
    expect(ticket).toContain("const LOT_CHIPS = [1, 5, 10, 20]");
  });

  it("keeps Limit and Intraday visible but disabled", () => {
    expect(ticket).toMatch(/id: "LIMIT", label: "Limit", disabled: true, title: "Not available in demo"/);
    expect(ticket).toMatch(/id: "INTRADAY", label: "Intraday", disabled: true, title: "Not available in demo"/);
  });

  it("drops the acknowledgement checkbox and only warns when the snapshot is stale", () => {
    expect(ticket).not.toMatch(/type="checkbox"/);
    expect(ticket).toContain("Demo order · uses chain snapshot price");
    expect(ticket).toMatch(/\{stale \? \(/);
    expect(ticket).toContain("Refresh price");
  });

  it("is docked on large screens instead of floating over the chain", () => {
    expect(ticket).toContain("lg:static");
    expect(ticket).toContain("sm:w-[380px]");
  });
});

describe("option chain grid", () => {
  const table = read("src/components/option-chain-table.tsx");

  it("windows rows, keeps the header sticky and centres ATM", () => {
    expect(table).toMatch(/const ROW = 36/);
    expect(table).toMatch(/strikes\.slice\(first, last\)/);
    expect(table).toContain("sticky top-0");
    expect(table).toMatch(/node\.scrollTop = Math\.max\(0, index \* ROW/);
  });

  it("shows Buy / Sell only on hover or focus and draws OI bars", () => {
    expect(table).toContain("group-hover/half:flex");
    expect(table).toContain("linear-gradient(to ${call ? \"left\" : \"right\"}");
  });
});

describe("shell and positions", () => {
  it("shows DEMO once in the chart header and docks replay at the bottom", () => {
    const desk = read("src/components/chart-desk.tsx");
    expect(desk).not.toMatch(/>DEMO</);
    expect(desk).not.toContain("DemoModeBadge");
    expect(desk.indexOf("<ReplayBar")).toBeGreaterThan(desk.indexOf("<ChartPanel"));
    expect(read("src/components/replay-bar.tsx")).toContain("border-t border-border");
  });

  it("uses the shared table for positions and orders", () => {
    expect(read("src/components/chart-desk.tsx")).toMatch(/<Table label="Open positions"/);
    expect(read("src/components/screens.tsx")).toMatch(/<Table\s+label="Orders"/);
  });
});
