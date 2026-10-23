import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readableTitle } from "@/components/notifications-screen";

describe("notifications", () => {
  it("shows an option contract in a readable form and leaves other text alone", () => {
    expect(readableTitle("NIFTY|2026-10-27|22700|CE position closed")).toBe("NIFTY 22,700 CE · 27 Oct position closed");
    expect(readableTitle("BANKNIFTY|2026-11-03|51500|PE order filled")).toBe("BANKNIFTY 51,500 PE · 3 Nov order filled");
    expect(readableTitle("RELIANCE crossed ₹1,500")).toBe("RELIANCE crossed ₹1,500");
  });

  it("passes on only in-app notification links", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/alerts/route.ts"), "utf8");
    expect(route).toContain('note.href.startsWith("/") && !note.href.startsWith("//")');
  });

  it("the header bell and the profile menu both go to the Notifications page, which needs a sign-in", () => {
    const shell = readFileSync(join(process.cwd(), "src/components/shell.tsx"), "utf8");
    const menu = readFileSync(join(process.cwd(), "src/components/account-panel.tsx"), "utf8");
    const proxy = readFileSync(join(process.cwd(), "src/proxy.ts"), "utf8");
    expect(shell).toContain('<Link href="/notifications"');
    expect(menu).toContain('label="Notifications" href="/notifications"');
    expect(menu.indexOf('label="View profile"')).toBeLessThan(menu.indexOf('label="Notifications"'));
    expect(proxy).toContain('"/notifications"');
  });
});
