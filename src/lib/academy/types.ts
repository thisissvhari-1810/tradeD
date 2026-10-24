/**
 * TradeD Academy content model. Lessons and questions live in code (src/lib/academy/content), are
 * graded on the server only, and are identified by stable string ids (progress and XP reference them,
 * so an id must never be reused for a different question).
 */

export type Topic = "basics" | "candlesticks" | "price-action" | "indicators" | "risk" | "options" | "psychology" | "practice";

export const TOPIC_LABEL: Record<Topic, string> = {
  basics: "Market basics",
  candlesticks: "Candlesticks",
  "price-action": "Price action",
  indicators: "Indicators",
  risk: "Risk management",
  options: "Options",
  psychology: "Trading psychology",
  practice: "Practice",
};

/** One candle for an illustration (prices only; drawn as a small chart, not market data). */
export type Candle = { open: number; high: number; low: number; close: number };

type QuestionBase = {
  /** Stable, unique across all content, e.g. "u2-l1-q3". */
  id: string;
  prompt: string;
  /** Why the right answer is right. */
  explanation: string;
  /** The usual wrong idea, shown when the answer is wrong. */
  mistake?: string;
  hint?: string;
  topic: Topic;
  difficulty: 1 | 2 | 3;
  /** Optional illustration drawn above the question. */
  candles?: Candle[];
};

export type Question =
  | (QuestionBase & { kind: "choice"; options: string[]; answer: number })
  | (QuestionBase & { kind: "truefalse"; answer: boolean })
  /** Prompt contains "___"; any accepted answer matches (case and spaces ignored). */
  | (QuestionBase & { kind: "fill"; accepted: string[] })
  /** A calculation; the answer is accepted within ± tolerance. */
  | (QuestionBase & { kind: "numeric"; answer: number; tolerance: number; unit?: string })
  /** Match each left item to its right item; pairs are listed in the correct order and shuffled on screen. */
  | (QuestionBase & { kind: "match"; pairs: Array<[string, string]> });

export type LessonCard = {
  title: string;
  /** Plain text; blank lines separate paragraphs; lines starting with "- " are bullets. */
  body: string;
  candles?: Candle[];
};

export type Lesson = {
  /** Stable, unique, e.g. "u1-what-is-a-stock". */
  slug: string;
  title: string;
  summary: string;
  minutes: number;
  topic: Topic;
  cards: LessonCard[];
  questions: Question[];
};

export type Unit = {
  id: string;
  number: number;
  title: string;
  description: string;
  lessons: Lesson[];
};

/** What the browser may see of a question before it is answered (never the answer). */
export type PublicQuestion =
  | { id: string; kind: "choice"; prompt: string; options: string[]; hint?: string; candles?: Candle[]; topic: Topic; difficulty: number }
  | { id: string; kind: "truefalse"; prompt: string; hint?: string; candles?: Candle[]; topic: Topic; difficulty: number }
  | { id: string; kind: "fill"; prompt: string; hint?: string; candles?: Candle[]; topic: Topic; difficulty: number }
  | { id: string; kind: "numeric"; prompt: string; unit?: string; hint?: string; candles?: Candle[]; topic: Topic; difficulty: number }
  | { id: string; kind: "match"; prompt: string; left: string[]; right: string[]; hint?: string; candles?: Candle[]; topic: Topic; difficulty: number };

/** An answer as the browser sends it. */
export type AnswerInput =
  | { kind: "choice"; index: number }
  | { kind: "truefalse"; value: boolean }
  | { kind: "fill"; text: string }
  | { kind: "numeric"; value: number }
  /** The [left, right] pairs the user made. */
  | { kind: "match"; pairs: Array<[string, string]> };
