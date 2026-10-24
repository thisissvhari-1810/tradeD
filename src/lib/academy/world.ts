import type { LessonState } from "@/lib/academy/rules";

/**
 * The Academy world: each curriculum unit is a themed chapter region on the roadmap. Only the look is
 * defined here; the lessons, their order and what is unlocked come from the content and the server's
 * progress records (journeyOf turns those into map state).
 */

export type ChapterTheme = "city" | "canyon" | "forest" | "observatory" | "fortress" | "harbor" | "summit";
export type ChapterDef = { unitId: string; name: string; subtitle: string; theme: ChapterTheme };

/** One region per unit, in curriculum order (unit ids are stable; see src/lib/academy/content). */
export const CHAPTERS: ChapterDef[] = [
  { unitId: "u1", name: "Market City", subtitle: "Stocks, exchanges and how orders meet", theme: "city" },
  { unitId: "u2", name: "Candlestick Canyon", subtitle: "Open, high, low, close and what candles show", theme: "canyon" },
  { unitId: "u3", name: "Trend Forest", subtitle: "Support, resistance, trends and breakouts", theme: "forest" },
  { unitId: "u4", name: "Indicators Observatory", subtitle: "Moving averages, RSI, MACD, VWAP and their limits", theme: "observatory" },
  { unitId: "u5", name: "Risk Fortress", subtitle: "Position size, stop-losses and protecting capital", theme: "fortress" },
  { unitId: "u6", name: "Options Harbor", subtitle: "Calls, puts, premiums, expiry and the Greeks", theme: "harbor" },
  { unitId: "u7", name: "Strategy Summit", subtitle: "Replay, planning, journals and honest review", theme: "summit" },
];

export function chapterFor(unitId: string, number: number): ChapterDef {
  return CHAPTERS.find((chapter) => chapter.unitId === unitId) ?? { unitId, name: `Chapter ${number}`, subtitle: "", theme: "city" };
}

export type StopState = "completed" | "current" | "open" | "locked";
export type JourneyLesson = { slug: string; title: string; summary: string; minutes: number; questions: number; state: LessonState; score: number; answered?: number };
export type JourneyUnit = { id: string; number: number; title: string; lessons: JourneyLesson[] };

export type JourneyStop = JourneyLesson & { stop: StopState; index: number; chapter: number };
export type JourneyChapter = {
  def: ChapterDef;
  unit: JourneyUnit;
  index: number;
  status: "complete" | "active" | "locked";
  done: number;
  total: number;
  /** Drawn with its stops (the chapters reached so far and the next one); later ones wait in the mist. */
  expanded: boolean;
  stops: JourneyStop[];
};

/**
 * Map state from the server's lesson states: which stop is next, which chapters are reached, and
 * how far each chapter is. Nothing here unlocks anything; it only reads what the server decided.
 */
export function journeyOf(units: JourneyUnit[]) {
  const lessons = units.flatMap((unit) => unit.lessons);
  const current = lessons.find((lesson) => lesson.state === "in-progress" || lesson.state === "available")?.slug ?? null;
  const currentChapter = current ? units.findIndex((unit) => unit.lessons.some((lesson) => lesson.slug === current)) : units.length - 1;
  let index = 0;
  const chapters: JourneyChapter[] = units.map((unit, chapterIndex) => {
    const stops = unit.lessons.map((lesson): JourneyStop => ({
      ...lesson,
      index: index++,
      chapter: chapterIndex,
      stop: lesson.state === "completed" || lesson.state === "mastered" ? "completed" : lesson.slug === current ? "current" : lesson.state === "locked" ? "locked" : "open",
    }));
    const done = stops.filter((stop) => stop.stop === "completed").length;
    return {
      def: chapterFor(unit.id, unit.number),
      unit,
      index: chapterIndex,
      status: done === stops.length && stops.length > 0 ? "complete" : stops.some((stop) => stop.stop !== "locked") ? "active" : "locked",
      done,
      total: stops.length,
      expanded: chapterIndex <= currentChapter + 1,
      stops,
    };
  });
  return { current, currentChapter, chapters, stops: chapters.flatMap((chapter) => chapter.stops) };
}

export type Journey = ReturnType<typeof journeyOf>;
