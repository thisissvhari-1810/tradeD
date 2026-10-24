import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { earnedBadges, grade, istDay, lessonScore, lessonStates, levelFor, publicQuestion, streakFrom, weekOf } from "@/lib/academy/rules";
import type { Lesson, Question, Unit } from "@/lib/academy/types";

const q = (over: Partial<Question> & Pick<Question, "kind">): Question => ({ id: "q", prompt: "?", explanation: "", topic: "basics", difficulty: 1, ...over } as Question);
const lesson = (slug: string, questions: Question[] = []): Lesson => ({ slug, title: slug, summary: "", minutes: 5, topic: "basics", cards: [], questions });
const units: Unit[] = [
  { id: "u1", number: 1, title: "One", description: "", lessons: [lesson("a"), lesson("b")] },
  { id: "u2", number: 2, title: "Two", description: "", lessons: [lesson("c"), lesson("d")] },
];

describe("streaks (India Standard Time days)", () => {
  it("counts consecutive days ending today, or ending yesterday while today is still open", () => {
    expect(streakFrom(["2026-10-22", "2026-10-23", "2026-10-24"], "2026-10-24")).toMatchObject({ current: 3, longest: 3, todayDone: true });
    expect(streakFrom(["2026-10-22", "2026-10-23"], "2026-10-24")).toMatchObject({ current: 2, todayDone: false });
  });

  it("a missed day resets the current streak but not the longest", () => {
    expect(streakFrom(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-23"], "2026-10-24")).toMatchObject({ current: 1, longest: 3, activeDays: 4 });
    expect(streakFrom(["2026-10-20"], "2026-10-24").current).toBe(0);
  });

  it("several activities on one day count once; month and year boundaries join up", () => {
    expect(streakFrom(["2026-10-24", "2026-10-24", "2026-10-24"], "2026-10-24")).toMatchObject({ current: 1, activeDays: 1 });
    expect(streakFrom(["2026-12-31", "2027-01-01"], "2027-01-01").current).toBe(2);
    expect(streakFrom(["2028-02-28", "2028-02-29", "2028-03-01"], "2028-03-01").current).toBe(3);
  });

  it("uses India time for the day: 23:59 IST and 00:01 IST are different days", () => {
    expect(istDay(new Date("2026-10-24T18:29:00Z"))).toBe("2026-10-24");
    expect(istDay(new Date("2026-10-24T18:31:00Z"))).toBe("2026-10-25");
  });

  it("the week view covers the 7 days ending today", () => {
    const week = weekOf(["2026-10-24", "2026-10-20"], "2026-10-24");
    expect(week).toHaveLength(7);
    expect(week[6]).toEqual({ day: "2026-10-24", done: true, today: true });
    expect(week[2]).toMatchObject({ day: "2026-10-20", done: true });
  });
});

describe("levels", () => {
  it("map lifetime XP to a level, title and progress", () => {
    expect(levelFor(0)).toMatchObject({ level: 1, title: "Rookie", progress: 0 });
    expect(levelFor(150)).toMatchObject({ level: 3, title: "Learner" });
    expect(levelFor(1000)).toMatchObject({ level: 7, title: "Strategist" });
    expect(levelFor(99_999)).toMatchObject({ level: 10, title: "Market Scholar", progress: 100, next: null });
  });
});

describe("unlocking (by prerequisites, never by XP)", () => {
  const states = (done: string[], started: string[] = []) =>
    lessonStates(units, new Map<string, { completed: boolean; bestScore: number; started: boolean }>([
      ...done.map((slug) => [slug, { completed: true, bestScore: 80, started: true }] as [string, { completed: boolean; bestScore: number; started: boolean }]),
      ...started.map((slug) => [slug, { completed: false, bestScore: 0, started: true }] as [string, { completed: boolean; bestScore: number; started: boolean }]),
    ]));

  it("opens only the first lesson for a new learner", () => {
    expect([...states([]).values()]).toEqual(["available", "locked", "locked", "locked"]);
  });
  it("opens the next lesson after one is completed, and the next unit after the whole unit", () => {
    expect(states(["a"]).get("b")).toBe("available");
    expect(states(["a"]).get("c")).toBe("locked");
    expect(states(["a", "b"]).get("c")).toBe("available");
    expect(states(["a"], ["b"]).get("b")).toBe("in-progress");
  });
  it("a perfect score shows as mastered", () => {
    const map = lessonStates(units, new Map([["a", { completed: true, bestScore: 100, started: true }]]));
    expect(map.get("a")).toBe("mastered");
  });
});

describe("grading and the questions the browser sees", () => {
  it("grades every kind on the server", () => {
    expect(grade(q({ kind: "choice", options: ["x", "y"], answer: 1 }), { kind: "choice", index: 1 })).toBe(true);
    expect(grade(q({ kind: "choice", options: ["x", "y"], answer: 1 }), { kind: "choice", index: 0 })).toBe(false);
    expect(grade(q({ kind: "truefalse", answer: false }), { kind: "truefalse", value: false })).toBe(true);
    expect(grade(q({ kind: "fill", accepted: ["Support", "support level"] }), { kind: "fill", text: "  SUPPORT " })).toBe(true);
    expect(grade(q({ kind: "numeric", answer: 40, tolerance: 0 }), { kind: "numeric", value: 40 })).toBe(true);
    expect(grade(q({ kind: "numeric", answer: 2.5, tolerance: 0.01 }), { kind: "numeric", value: 2.51 })).toBe(true);
    expect(grade(q({ kind: "numeric", answer: 40, tolerance: 0 }), { kind: "numeric", value: 41 })).toBe(false);
    const match = q({ kind: "match", pairs: [["Call", "Right to buy"], ["Put", "Right to sell"]] });
    expect(grade(match, { kind: "match", pairs: [["Put", "Right to sell"], ["Call", "Right to buy"]] })).toBe(true);
    expect(grade(match, { kind: "match", pairs: [["Call", "Right to sell"], ["Put", "Right to buy"]] })).toBe(false);
    expect(grade(q({ kind: "choice", options: ["x"], answer: 0 }), { kind: "truefalse", value: true })).toBe(false);
    const chart = [{ open: 1, high: 2, low: 0.5, close: 1.5 }, { open: 1.5, high: 3, low: 1, close: 1.2 }];
    expect(grade(q({ kind: "tapcandle", chart, answer: 1 }), { kind: "tapcandle", index: 1 })).toBe(true);
    expect(grade(q({ kind: "tapcandle", chart, answer: 1 }), { kind: "tapcandle", index: 0 })).toBe(false);
    const order = q({ kind: "order", steps: ["a", "b", "c"] });
    expect(grade(order, { kind: "order", steps: ["a", "b", "c"] })).toBe(true);
    expect(grade(order, { kind: "order", steps: ["b", "a", "c"] })).toBe(false);
    expect(grade(order, { kind: "order", steps: ["a", "b"] })).toBe(false);
    const zone = q({ kind: "pricezone", chart, start: 2, step: 0.5, range: [0, 4], accept: [1, 1.5] });
    expect(grade(zone, { kind: "pricezone", price: 1.5 })).toBe(true);
    expect(grade(zone, { kind: "pricezone", price: 2 })).toBe(false);
    expect(JSON.stringify(publicQuestion(zone))).not.toMatch(/accept/);
  });

  it("never includes the answer in what is sent to the browser", () => {
    for (const question of [
      q({ kind: "choice", options: ["x", "y"], answer: 1 }),
      q({ kind: "truefalse", answer: true }),
      q({ kind: "fill", accepted: ["secret"] }),
      q({ kind: "numeric", answer: 123.45, tolerance: 0 }),
    ]) {
      const sent = JSON.stringify(publicQuestion(question));
      expect(sent).not.toMatch(/"answer"|"accepted"|"tolerance"|"explanation"|secret|123\.45/);
    }
    const tap = JSON.stringify(publicQuestion(q({ kind: "tapcandle", chart: [{ open: 1, high: 2, low: 0, close: 1 }], answer: 0 })));
    expect(tap).not.toMatch(/"answer"/);
    for (const id of ["o1", "o2", "o3", "o4", "o5"]) {
      const order = publicQuestion(q({ kind: "order", steps: ["first", "second", "third"], id }));
      expect(order.kind === "order" && order.items.join()).not.toBe("first,second,third");
      expect(order.kind === "order" && [...order.items].sort()).toEqual(["first", "second", "third"]);
    }
    const match = publicQuestion(q({ kind: "match", pairs: [["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]] }));
    expect(match.kind === "match" && [...match.right].sort()).toEqual(["1", "2", "3", "4"]);
  });

  it("scores a lesson by questions answered correctly at least once", () => {
    const item = lesson("x", [q({ kind: "truefalse", answer: true, id: "1" }), q({ kind: "truefalse", answer: true, id: "2" }), q({ kind: "truefalse", answer: true, id: "3" })]);
    expect(lessonScore(item, new Set(["1", "2"]))).toBe(67);
    expect(lessonScore(item, new Set(["1", "2", "3", "zzz"]))).toBe(100);
  });
});

describe("badges", () => {
  it("are earned from stored progress and streaks", () => {
    expect(earnedBadges({ completedSlugs: new Set(), units, streakLongest: 0, perfectLesson: false })).toEqual([]);
    const first = earnedBadges({ completedSlugs: new Set(["a"]), units, streakLongest: 3, perfectLesson: false });
    expect(first).toEqual(expect.arrayContaining(["academy-first-lesson", "academy-streak-3"]));
    expect(first).not.toContain("academy-streak-7");
    const unit = earnedBadges({ completedSlugs: new Set(["c", "d"]), units, streakLongest: 7, perfectLesson: true });
    expect(unit).toEqual(expect.arrayContaining(["academy-unit-complete", "academy-candlestick-beginner", "academy-streak-7", "academy-perfect-lesson"]));
  });
});

describe("integrity", () => {
  it("each XP reward is stored once per user, and active days once per date", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/model XpEvent[\s\S]*?@@unique\(\[userId, key\]\)/);
    expect(schema).toMatch(/model AcademyDay[\s\S]*?@@id\(\[userId, day\]\)/);
    const server = readFileSync(join(process.cwd(), "src/server/academy.ts"), "utf8");
    expect(server.match(/xpEvent\.createMany\([\s\S]*?skipDuplicates: true/g)?.length).toBeGreaterThanOrEqual(3);
    expect(server).not.toMatch(/virtualAccount|ledgerEntry|cashAvailable/);
  });
});

describe("the course content", async () => {
  const { UNITS } = await import("@/lib/academy/content");
  const all = UNITS.flatMap((unit) => unit.lessons.flatMap((item) => item.questions));
  const right = (question: Question) =>
    question.kind === "choice" ? { kind: "choice" as const, index: question.answer }
      : question.kind === "truefalse" ? { kind: "truefalse" as const, value: question.answer }
        : question.kind === "fill" ? { kind: "fill" as const, text: question.accepted[0] }
          : question.kind === "numeric" ? { kind: "numeric" as const, value: question.answer }
            : question.kind === "match" ? { kind: "match" as const, pairs: question.pairs }
              : question.kind === "tapcandle" ? { kind: "tapcandle" as const, index: question.answer }
                : question.kind === "order" ? { kind: "order" as const, steps: question.steps }
                  : { kind: "pricezone" as const, price: question.accept[0] };

  it("has 7 units with unique lesson slugs and question ids", () => {
    expect(UNITS.map((unit) => unit.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const slugs = UNITS.flatMap((unit) => unit.lessons.map((item) => item.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(all.map((question) => question.id)).size).toBe(all.length);
  });

  it("every question accepts its own answer, and none leaks it to the browser", () => {
    for (const question of all) {
      expect(grade(question, right(question)), question.id).toBe(true);
      const sent = JSON.stringify(publicQuestion(question));
      expect(sent, question.id).not.toMatch(/"answer"|"accepted"|"tolerance"|"explanation"|"mistake"/);
    }
  });
});
