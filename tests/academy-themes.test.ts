import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORLDS, worldOf } from "@/components/academy/game/worlds/config";
import { reactTo } from "@/components/academy/lesson/director";
import { UNITS } from "@/lib/academy/content";
import { ACADEMY_THEMES, DEFAULT_THEME } from "@/lib/academy/themes";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Academy map worlds", () => {
  it("offers four worlds, each a distinct look over the same seven chapters", () => {
    expect(ACADEMY_THEMES).toHaveLength(4);
    for (const id of ACADEMY_THEMES) {
      const world = WORLDS[id];
      expect(world.chapters, id).toHaveLength(UNITS.length);
      expect(new Set(world.chapters).size, id).toBe(UNITS.length);
      for (let index = 0; index < UNITS.length; index += 1) expect(world.region(index).ground, id).toHaveLength(2);
    }
    // Genuinely different: each world has its own road and transition style.
    expect(new Set(ACADEMY_THEMES.map((id) => WORLDS[id].road)).size).toBe(4);
    expect(new Set(ACADEMY_THEMES.map((id) => WORLDS[id].transition)).size).toBe(4);
  });

  it("falls back to a sensible default before a world is chosen", () => {
    expect(worldOf(null).id).toBe(DEFAULT_THEME);
  });

  it("uses one roadmap model: the map draws every world from the same journey and stops", () => {
    const map = read("src/components/academy/game/academy-game-map.tsx");
    // One journey and one geometry, whatever the world.
    expect(map.match(/journeyOf\(/g)?.length).toBeGreaterThan(0);
    expect(map).toMatch(/buildWorld\(layout,/);
    expect(map).not.toMatch(/if \(theme\.id === "(metropolis|cosmos|circuit|expedition)"\)/);
  });

  it("saves the world on the account through the authenticated Academy API, and only the world", () => {
    const route = read("src/app/api/academy/route.ts");
    expect(route).toMatch(/requireUser\(\)/);
    expect(route).toMatch(/z\.enum\(ACADEMY_THEMES\)/);
    const server = read("src/server/academy.ts");
    expect(server).toMatch(/data: \{ academyTheme: theme \}/);
    // Choosing a world never touches progress, answers or XP.
    const setter = server.slice(server.indexOf("export async function academySetTheme"), server.indexOf("}", server.indexOf("export async function academySetTheme")));
    expect(setter).not.toMatch(/academyProgress|academyAnswer|xpEvent/);
    expect(read("prisma/migrations/20261025120000_academy_theme/migration.sql")).toMatch(/ADD COLUMN\s+"academyTheme" TEXT/);
  });
});

describe("question transitions and Tiko", () => {
  it("Tiko takes off when Next is pressed, and a pause brings a gentle nudge (no sound)", () => {
    expect(reactTo({ type: "CONTINUE_PRESSED" })).toMatchObject({ mood: "fly", say: null, sound: "page" });
    const nudge = reactTo({ type: "IDLE_NUDGE", hasHint: true });
    expect(nudge.mood).toBe("curious");
    expect(nudge.sound).toBeUndefined();
    expect(nudge.say?.text).toMatch(/Hint/);
  });

  it("the cinematic is driven by timers (not animation events) and locks the lesson while it plays", () => {
    const player = read("src/components/academy/lesson-player.tsx");
    expect(player).toMatch(/later\(duration \* SWAP, go\)/);
    expect(player).toMatch(/later\(duration, \(\) => \{\s*setTransition\(null\)/);
    expect(player).toMatch(/inert=\{transition != null\}/);
    expect(player).toMatch(/if \(!lesson \|\| leaving \|\| transition\) return;/);
  });

  it("Tiko has no fake lip-sync (there is no voice)", () => {
    expect(read("src/components/academy/game/tiko.tsx")).not.toMatch(/talking/);
    expect(read("src/components/academy/game/academy-game.css")).not.toMatch(/data-talking/);
  });
});

describe("map stop colours", () => {
  it("never use gold for a playable stop (gold means completed)", () => {
    for (const id of ACADEMY_THEMES) {
      if (id === "expedition") continue;
      for (let index = 0; index < 7; index += 1) expect(WORLDS[id].region(index).accent, `${id} ${index}`).not.toMatch(/#ffc83d|#ffb547/i);
    }
  });
});
