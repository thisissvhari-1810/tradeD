import type { AnswerInput, Lesson, PublicQuestion, Question, Unit } from "@/lib/academy/types";

/**
 * TradeD Academy rules: XP amounts, levels, streaks, unlocking, grading and badges. Pure functions
 * (no database), so the server and the tests use exactly the same rules.
 */

/** XP for each kind of reward. Change here only. */
export const XP_RULES = {
  /** First time a lesson is completed. */
  lessonComplete: 10,
  /** Completing a lesson's questions (the quiz part), first time. */
  quizComplete: 5,
  /** First correct answer to a question (a question pays once, however often it is answered). */
  correctAnswer: 2,
} as const;

/** XP to earn per day for the daily goal. */
export const DAILY_GOAL_XP = 30;

/** Share of a lesson's questions (answered correctly at least once) needed to complete it. */
export const PASS_PERCENT = 70;

/** Levels: reach `xp` lifetime XP for the level. */
export const LEVELS = [
  { level: 1, xp: 0, title: "Rookie" },
  { level: 2, xp: 60, title: "Rookie" },
  { level: 3, xp: 150, title: "Learner" },
  { level: 4, xp: 280, title: "Learner" },
  { level: 5, xp: 450, title: "Analyst" },
  { level: 6, xp: 670, title: "Analyst" },
  { level: 7, xp: 950, title: "Strategist" },
  { level: 8, xp: 1300, title: "Strategist" },
  { level: 9, xp: 1750, title: "Market Scholar" },
  { level: 10, xp: 2300, title: "Market Scholar" },
] as const;

export function levelFor(xp: number) {
  const index = LEVELS.reduce((found, row, at) => (xp >= row.xp ? at : found), 0);
  const current = LEVELS[index];
  const next = LEVELS[index + 1] ?? null;
  return {
    level: current.level,
    title: current.title,
    floor: current.xp,
    next: next?.xp ?? null,
    /** 0–100 towards the next level (100 at the top level). */
    progress: next ? Math.round(((xp - current.xp) / (next.xp - current.xp)) * 100) : 100,
  };
}

/* ---------------- days and streaks (India Standard Time) ---------------- */

/** YYYY-MM-DD in India Standard Time. The Academy counts days in IST for every user. */
export function istDay(at: Date = new Date()): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

function shift(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Streaks from the set of active days. The current streak counts back from today, or from
 * yesterday when today has no activity yet (the streak is still alive until today ends).
 */
export function streakFrom(days: string[], today: string) {
  const set = new Set(days);
  let current = 0;
  let cursor = set.has(today) ? today : shift(today, -1);
  while (set.has(cursor)) {
    current += 1;
    cursor = shift(cursor, -1);
  }
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let previous = "";
  for (const day of sorted) {
    run = previous && shift(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { current, longest, activeDays: set.size, todayDone: set.has(today) };
}

/** The 7 days ending today (oldest first), each marked done or not. */
export function weekOf(days: string[], today: string) {
  const set = new Set(days);
  return Array.from({ length: 7 }, (_, index) => {
    const day = shift(today, index - 6);
    return { day, done: set.has(day), today: day === today };
  });
}

/* ---------------- unlocking ---------------- */

export type LessonState = "locked" | "available" | "in-progress" | "completed" | "mastered";

/**
 * A lesson opens when the lesson before it (in the same unit) is completed; a unit's first lesson
 * opens when every lesson of the previous unit is completed. The first lesson is always open.
 * XP never unlocks content.
 */
export function lessonStates(units: Unit[], progress: Map<string, { completed: boolean; bestScore: number; started: boolean }>) {
  const states = new Map<string, LessonState>();
  let previousUnitDone = true;
  for (const unit of units) {
    let previousDone = previousUnitDone;
    for (const lesson of unit.lessons) {
      const row = progress.get(lesson.slug);
      const state: LessonState = row?.completed
        ? (row.bestScore >= 100 ? "mastered" : "completed")
        : !previousDone ? "locked" : row?.started ? "in-progress" : "available";
      states.set(lesson.slug, state);
      previousDone = Boolean(row?.completed);
    }
    previousUnitDone = unit.lessons.every((lesson) => progress.get(lesson.slug)?.completed);
  }
  return states;
}

/* ---------------- questions ---------------- */

function normalise(text: string) {
  return text.toLowerCase().replace(/[\s.\-_]+/g, " ").trim();
}

/** Shuffles deterministically (same order for the same seed), so a reload shows the same layout. */
function seededShuffle<T>(items: T[], seed: string): T[] {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
    const pick = hash % (index + 1);
    [out[index], out[pick]] = [out[pick], out[index]];
  }
  return out;
}

/** What the browser sees before answering: never the answer. */
export function publicQuestion(question: Question): PublicQuestion {
  const base = { id: question.id, prompt: question.prompt, hint: question.hint, candles: question.candles, topic: question.topic, difficulty: question.difficulty };
  switch (question.kind) {
    case "choice": return { ...base, kind: "choice", options: question.options };
    case "truefalse": return { ...base, kind: "truefalse" };
    case "fill": return { ...base, kind: "fill" };
    case "numeric": return { ...base, kind: "numeric", unit: question.unit };
    case "match": return {
      ...base,
      kind: "match",
      left: question.pairs.map(([left]) => left),
      right: seededShuffle(question.pairs.map(([, right]) => right), question.id),
    };
    case "tapcandle": return { ...base, kind: "tapcandle", chart: question.chart };
    case "order": {
      // Never shown already in the right order (that would give the answer away).
      let items = seededShuffle(question.steps, question.id);
      if (items.every((step, index) => step === question.steps[index])) items = [...items.slice(1), items[0]];
      return { ...base, kind: "order", items };
    }
  }
}

/** Server-side grading. */
export function grade(question: Question, input: AnswerInput): boolean {
  if (question.kind !== input.kind) return false;
  switch (question.kind) {
    case "choice": return input.kind === "choice" && input.index === question.answer;
    case "truefalse": return input.kind === "truefalse" && input.value === question.answer;
    case "fill": return input.kind === "fill" && question.accepted.some((accepted) => normalise(accepted) === normalise(input.text));
    case "numeric": return input.kind === "numeric" && Number.isFinite(input.value) && Math.abs(input.value - question.answer) <= question.tolerance + 1e-9;
    case "match": {
      if (input.kind !== "match" || input.pairs.length !== question.pairs.length) return false;
      const want = new Map(question.pairs);
      return input.pairs.every(([left, right]) => want.get(left) === right);
    }
    case "tapcandle": return input.kind === "tapcandle" && input.index === question.answer;
    case "order": return input.kind === "order" && input.steps.length === question.steps.length && input.steps.every((step, index) => step === question.steps[index]);
  }
}

/** The correct answer, in words, for the feedback after answering. */
export function answerText(question: Question): string {
  switch (question.kind) {
    case "choice": return question.options[question.answer];
    case "truefalse": return question.answer ? "True" : "False";
    case "fill": return question.accepted[0];
    case "numeric": return `${question.answer}${question.unit ? ` ${question.unit}` : ""}`;
    case "match": return question.pairs.map(([left, right]) => `${left} → ${right}`).join("; ");
    case "tapcandle": return `Candle ${question.answer + 1}`;
    case "order": return question.steps.join(" → ");
  }
}

/** Lesson score: the share of its questions answered correctly at least once. */
export function lessonScore(lesson: Lesson, correctIds: Set<string>) {
  if (!lesson.questions.length) return 100;
  const right = lesson.questions.filter((question) => correctIds.has(question.id)).length;
  return Math.round((right / lesson.questions.length) * 100);
}

/* ---------------- badges ---------------- */

export type BadgeDef = { slug: string; name: string; description: string; icon: "book" | "flame" | "trophy" | "target" | "medal"; category: "Learning" | "Consistency" | "Mastery" };

export const BADGES: BadgeDef[] = [
  { slug: "academy-first-lesson", name: "First Lesson", description: "Complete your first lesson.", icon: "book", category: "Learning" },
  { slug: "academy-ten-lessons", name: "Ten Lessons", description: "Complete ten lessons.", icon: "book", category: "Learning" },
  { slug: "academy-candlestick-beginner", name: "Candlestick Beginner", description: "Complete the Candlestick Mastery unit.", icon: "target", category: "Learning" },
  { slug: "academy-chart-explorer", name: "Chart Analysis Explorer", description: "Complete the Charts and Price Action unit.", icon: "target", category: "Learning" },
  { slug: "academy-options-fundamentals", name: "Options Fundamentals", description: "Complete the Options Fundamentals unit.", icon: "target", category: "Learning" },
  { slug: "academy-unit-complete", name: "Unit Complete", description: "Complete every lesson in a unit.", icon: "medal", category: "Mastery" },
  { slug: "academy-perfect-lesson", name: "Perfect Lesson", description: "Answer every question in a lesson correctly.", icon: "trophy", category: "Mastery" },
  { slug: "academy-streak-3", name: "Three-Day Streak", description: "Learn on 3 days in a row.", icon: "flame", category: "Consistency" },
  { slug: "academy-streak-7", name: "Seven-Day Streak", description: "Learn on 7 days in a row.", icon: "flame", category: "Consistency" },
  { slug: "academy-streak-30", name: "Thirty-Day Streak", description: "Learn on 30 days in a row.", icon: "flame", category: "Consistency" },
  { slug: "academy-streak-100", name: "Century Streak", description: "Learn on 100 days in a row.", icon: "flame", category: "Consistency" },
  { slug: "academy-streak-365", name: "Year-Long Streak", description: "Learn on 365 days in a row.", icon: "flame", category: "Consistency" },
];

const UNIT_BADGE: Record<string, string> = { u2: "academy-candlestick-beginner", u3: "academy-chart-explorer", u6: "academy-options-fundamentals" };

/** Badges earned by the current state (the server awards any not yet held). */
export function earnedBadges(input: { completedSlugs: Set<string>; units: Unit[]; streakLongest: number; perfectLesson: boolean }) {
  const out: string[] = [];
  if (input.completedSlugs.size >= 1) out.push("academy-first-lesson");
  if (input.completedSlugs.size >= 10) out.push("academy-ten-lessons");
  for (const unit of input.units) {
    if (unit.lessons.length && unit.lessons.every((lesson) => input.completedSlugs.has(lesson.slug))) {
      out.push("academy-unit-complete");
      if (UNIT_BADGE[unit.id]) out.push(UNIT_BADGE[unit.id]);
    }
  }
  if (input.perfectLesson) out.push("academy-perfect-lesson");
  for (const [days, slug] of [[3, "academy-streak-3"], [7, "academy-streak-7"], [30, "academy-streak-30"], [100, "academy-streak-100"], [365, "academy-streak-365"]] as const) {
    if (input.streakLongest >= days) out.push(slug);
  }
  return [...new Set(out)];
}
