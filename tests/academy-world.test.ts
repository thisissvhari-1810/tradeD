import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UNITS } from "@/lib/academy/content";
import { lessonStates } from "@/lib/academy/rules";
import { CHAPTERS, journeyOf, type JourneyUnit } from "@/lib/academy/world";
import { buildWorld, pointAlong, travelledPath } from "@/components/academy/game/geometry";

/** The roadmap's input as the server sends it, for a learner who has completed `done` lessons. */
function unitsAfter(done: number): JourneyUnit[] {
  const slugs = UNITS.flatMap((unit) => unit.lessons.map((lesson) => lesson.slug));
  const progress = new Map(slugs.slice(0, done).map((slug) => [slug, { completed: true, bestScore: 90, started: true }]));
  const states = lessonStates(UNITS, progress);
  return UNITS.map((unit) => ({
    id: unit.id,
    number: unit.number,
    title: unit.title,
    lessons: unit.lessons.map((lesson) => ({ slug: lesson.slug, title: lesson.title, summary: lesson.summary, minutes: lesson.minutes, questions: lesson.questions.length, state: states.get(lesson.slug)!, score: progress.has(lesson.slug) ? 90 : 0 })),
  }));
}

describe("the Academy roadmap", () => {
  it("has one chapter region for each of the seven real units, in curriculum order", () => {
    expect(CHAPTERS.map((chapter) => chapter.unitId)).toEqual(UNITS.map((unit) => unit.id));
    expect(new Set(CHAPTERS.map((chapter) => chapter.theme)).size).toBe(7);
  });

  it("every stop is a real lesson, and every lesson is a stop", () => {
    const journey = journeyOf(unitsAfter(0));
    expect(journey.stops.map((stop) => stop.slug)).toEqual(UNITS.flatMap((unit) => unit.lessons.map((lesson) => lesson.slug)));
  });

  it("reads progress from the server's lesson states: completed, the one current stop, locked", () => {
    const journey = journeyOf(unitsAfter(3));
    expect(journey.stops.slice(0, 3).every((stop) => stop.stop === "completed")).toBe(true);
    expect(journey.stops[3].stop).toBe("current");
    expect(journey.stops.filter((stop) => stop.stop === "current")).toHaveLength(1);
    expect(journey.stops.slice(4).every((stop) => stop.stop === "locked")).toBe(true);
    expect(journey.chapters[0]).toMatchObject({ done: 3, status: "active" });
  });

  it("shows the reached chapters and the next one; later chapters wait in the mist", () => {
    expect(journeyOf(unitsAfter(0)).chapters.map((chapter) => chapter.expanded)).toEqual([true, true, false, false, false, false, false]);
    const unitOne = UNITS[0].lessons.length;
    const after = journeyOf(unitsAfter(unitOne));
    expect(after.chapters[0].status).toBe("complete");
    expect(after.chapters.map((chapter) => chapter.expanded)).toEqual([true, true, true, false, false, false, false]);
    const all = UNITS.reduce((sum, unit) => sum + unit.lessons.length, 0);
    const finished = journeyOf(unitsAfter(all));
    expect(finished.current).toBeNull();
    expect(finished.chapters.every((chapter) => chapter.expanded && chapter.status === "complete")).toBe(true);
  });

  it("places every stop on the road, inside the map, in both layouts", () => {
    for (const layout of ["wide", "tall"] as const) {
      const journey = journeyOf(unitsAfter(7));
      const shown = journey.chapters.filter((chapter) => chapter.expanded);
      const world = buildWorld(layout, shown.map((chapter) => chapter.total), journey.chapters.length - shown.length);
      expect(world.nodes).toHaveLength(shown.reduce((sum, chapter) => sum + chapter.total, 0));
      for (const node of world.nodes) {
        expect(node.x).toBeGreaterThan(60);
        expect(node.x).toBeLessThan(world.width - 60);
        expect(node.y).toBeLessThan(world.height);
      }
      // The road's own curve starts and ends exactly on the stops it connects.
      for (let index = 1; index < world.nodes.length; index += 1) {
        const start = pointAlong(world, index - 1, index, 0);
        const end = pointAlong(world, index - 1, index, 0.99999);
        expect(Math.hypot(start.x - world.nodes[index - 1].x, start.y - world.nodes[index - 1].y)).toBeLessThan(1);
        expect(Math.hypot(end.x - world.nodes[index].x, end.y - world.nodes[index].y)).toBeLessThan(2);
      }
      expect(travelledPath(world, -1)).toBe("");
      expect(travelledPath(world, 2)).toMatch(new RegExp(`${world.nodes[2].x} ${world.nodes[2].y}$`));
    }
  });
});

describe("the lesson player", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("never decides correctness or XP in the browser, and never touches orders", () => {
    const player = read("src/components/academy/lesson-player.tsx") + read("src/components/academy/lesson/exercise-view.tsx");
    expect(player).not.toMatch(/\/api\/orders|\/api\/demo|placeOrder|broker/i);
    // Correctness, XP and completion come from the server's answer and completion responses only.
    expect(player).toMatch(/action: "answer"/);
    expect(player).toMatch(/action: "complete"/);
    expect(player).not.toMatch(/correct:\s*true/);
  });

  it("keeps sound off until the learner turns it on", () => {
    const feedback = read("src/components/academy/academy-sound.ts");
    expect(feedback).toMatch(/DEFAULT: FeedbackPrefs = \{ sound: false/);
  });

  it("includes chart and sequencing exercises graded on the server", () => {
    const kinds = UNITS.flatMap((unit) => unit.lessons.flatMap((lesson) => lesson.questions.map((question) => question.kind)));
    expect(kinds).toContain("tapcandle");
    expect(kinds).toContain("order");
    expect(kinds).toContain("pricezone");
  });
});
