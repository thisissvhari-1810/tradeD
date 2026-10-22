import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(join(process.cwd(), "src/components/option-chain-panel.tsx"), "utf8");
const table = readFileSync(join(process.cwd(), "src/components/option-chain-table.tsx"), "utf8");

describe("draggable option chain", () => {
  it("drags from the header with pointer capture and cleans up", () => {
    expect(panel).toContain("onPointerDown={startDrag}");
    expect(panel).toContain("setPointerCapture(event.pointerId)");
    expect(panel).toContain("onPointerCancel={endDrag}");
    expect(panel).toContain('document.body.style.userSelect = ""');
  });

  it("never starts a drag from a control inside the header", () => {
    expect(panel).toContain('closest("button, input, select, textarea, a, [data-no-drag]")');
  });

  it("keeps the panel inside the chart area and remembers it for the session", () => {
    expect(panel).toContain("function fitInside(");
    expect(panel).toContain("width - node.offsetWidth - EDGE");
    expect(panel).toContain("height - MIN_HEIGHT - EDGE");
    expect(panel).toContain("sessionStorage.setItem(PLACE_KEY");
  });

  it("moves with left/top, not CSS transforms, and offers maximize / restore", () => {
    expect(panel).toContain("node.style.left = `${next.x}px`");
    expect(panel).not.toMatch(/style\.transform/);
    expect(panel).toContain('"Maximize option chain"');
  });

  it("clears the selected contract when the underlying or expiry changes", () => {
    expect(panel).toContain("setExpiry(\"\"); setSelected(null);");
    expect(panel).toContain("setExpiry(event.target.value); setSelected(null);");
  });
});

describe("call / put row actions", () => {
  it("highlights each side on its own, not the whole strike row", () => {
    expect(table).toContain('atm && "bg-warning/10"');
    expect(table).toContain("hover:bg-primary/[0.07] focus-within:bg-primary/[0.07]");
  });

  it("labels the actions Buy and Sell", () => {
    expect(table).toMatch(/>Buy<\/button>/);
    expect(table).toMatch(/>Sell<\/button>/);
  });
});
