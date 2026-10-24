import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Academy full-screen mode and navigation", () => {
  const shell = read("src/components/shell.tsx");

  it("is decided by the route, so back and forward restore the normal app", () => {
    expect(shell).toMatch(/const immersive = path === "\/academy" \|\| path\.startsWith\("\/academy\/"\)/);
    // The trading sidebar, header and phone tab bar are not rendered on Academy routes.
    expect(shell).toMatch(/\{immersive \? null : <aside/);
    expect(shell).toMatch(/\{immersive \? null : <header/);
    expect(shell).toMatch(/\{immersive \? null : <nav className="fixed/);
  });

  it("puts Academy in the phone tab bar instead of Positions, and keeps Positions reachable", () => {
    const tabBar = shell.slice(shell.indexOf("const TAB_BAR"), shell.indexOf("];", shell.indexOf("const TAB_BAR")));
    expect(tabBar).toMatch(/href: "\/academy", label: "Academy"/);
    expect(tabBar).not.toMatch(/href: "\/positions"/);
    // Still in the full menu and search, and linked from the Portfolio page.
    expect(shell).toMatch(/\{ href: "\/positions", label: "Positions"/);
    expect(read("src/components/screens.tsx")).toMatch(/href="\/positions"/);
  });

  it("does not let the Academy stylesheet switch off the map's and story mission's scrolling", () => {
    const css = read("src/components/academy/game/academy-game.css");
    const world = css.slice(css.indexOf(".mq-world {"), css.indexOf("}", css.indexOf(".mq-world {")));
    expect(world).not.toMatch(/(^|\s)overflow:\s*hidden/);
  });
});
