import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UNITS } from "@/lib/academy/content";
import { MISSIONS } from "@/lib/academy/missions";
import { lessonStates } from "@/lib/academy/rules";
import { journeyOf } from "@/lib/academy/world";

describe("Market City mission", () => {
  const mission = MISSIONS["m1-first-trading-day"];
  const lesson = UNITS[0].lessons[0];

  it("is the first lesson of Unit 1, open to every new learner, and the roadmap's first stop", () => {
    expect(lesson.slug).toBe(mission.slug);
    const states = lessonStates(UNITS, new Map());
    const journey = journeyOf(UNITS.map((unit) => ({ id: unit.id, number: unit.number, title: unit.title, lessons: unit.lessons.map((item) => ({ slug: item.slug, title: item.title, summary: item.summary, minutes: item.minutes, questions: item.questions.length, state: states.get(item.slug)!, score: 0 })) })));
    expect(journey.stops[0].slug).toBe(mission.slug);
    expect(journey.current).toBe(mission.slug);
    expect(lessonStates(UNITS, new Map()).get(mission.slug)).toBe("available");
  });

  it("every scene asks a real, server-graded question of its lesson, and every question is asked", () => {
    const ids = new Set(lesson.questions.map((question) => question.id));
    const asked = mission.scenes.flatMap((scene) => scene.kind === "decision" ? [scene.planQuestionId, scene.riskQuestionId] : scene.kind === "review" ? [] : [scene.questionId]);
    for (const id of asked) expect(ids.has(id), id).toBe(true);
    expect(new Set(asked)).toEqual(ids);
  });

  it("its decision feedback never promises an outcome, and its charts are labelled as made-up prices", () => {
    const text = JSON.stringify(mission);
    expect(text).not.toMatch(/guarantee(s|d)? (a|the) (profit|move|win)|will definitely|always works/i);
    const chart = readFileSync(join(process.cwd(), "src/components/academy/game/edu-chart.tsx"), "utf8");
    expect(chart).toContain("Educational example · made-up prices");
    const player = readFileSync(join(process.cwd(), "src/components/academy/game/mission-player.tsx"), "utf8");
    expect(player).not.toMatch(/\/api\/orders|\/api\/demo|placeOrder/);
  });

  it("the intro-seen flag is stored on the account behind a sign-in", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/academy/route.ts"), "utf8");
    expect(route).toMatch(/requireUser\(\)[\s\S]*academyIntroSeen/);
    const server = readFileSync(join(process.cwd(), "src/server/academy.ts"), "utf8");
    expect(server).toMatch(/academyIntroAt: null \}, data: \{ academyIntroAt: new Date\(\) \}/);
  });
});
