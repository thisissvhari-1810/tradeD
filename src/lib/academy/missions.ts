import type { Candle } from "@/lib/academy/types";

/**
 * Story missions: Tiko's scenes for a lesson. The scenes drive the story; grading, XP and progress
 * still go through the lesson's questions on the server. Charts here are clearly labelled
 * educational examples (made-up candles), never presented as real market events.
 */

export type TikoMood = "idle" | "enter" | "walk" | "fly" | "point" | "explain" | "celebrate" | "confused" | "encourage" | "thinking" | "mission-complete";
export type Line = { mood: TikoMood; text: string; highlight?: "open" | "high" | "low" | "close" };

export type DecisionChoice = { id: "buy" | "sell" | "wait"; label: string; feedback: string; mood: TikoMood };

export type Scene =
  | { id: string; kind: "ticker"; title: string; lines: Line[]; questionId: string }
  /** `context` candles come before the featured one, so it is drawn at a normal size. */
  | { id: string; kind: "candle"; title: string; lines: Line[]; questionId: string; candle: Candle; context: Candle[] }
  | { id: string; kind: "decision"; title: string; lines: Line[]; planQuestionId: string; riskQuestionId: string; history: Candle[]; after: Candle[]; choices: DecisionChoice[] }
  | { id: string; kind: "review"; title: string; lines: Line[] };

export type Mission = {
  slug: string;
  chapter: string;
  title: string;
  objective: string;
  scenes: Scene[];
  /** What the learner should come away with (shown on the result). */
  skills: string[];
  correct: Line;
  wrong: Line;
};

/** A gentle uptrend that stalls under a ceiling near ₹120 (educational, deterministic). */
const HISTORY: Candle[] = [
  [100, 103, 99, 102], [102, 104, 101, 103], [103, 106, 102, 105], [105, 107, 103, 104], [104, 108, 103, 107],
  [107, 110, 106, 109], [109, 111, 107, 108], [108, 112, 107, 111], [111, 114, 110, 113], [113, 116, 112, 115],
  [115, 119, 114, 118], [118, 120, 115, 116], [116, 119, 115, 118], [118, 120.5, 116, 117], [117, 119.5, 115, 119],
].map(([open, high, low, close]) => ({ open, high, low, close }));

/** What happened next in the example: a rejection at the ceiling, then a pullback. */
const AFTER: Candle[] = [
  [119, 120.5, 116, 116.5], [116.5, 117, 112, 113], [113, 115, 111, 114], [114, 116, 112, 115],
].map(([open, high, low, close]) => ({ open, high, low, close }));

export const MISSIONS: Record<string, Mission> = {
  "m1-first-trading-day": {
    slug: "m1-first-trading-day",
    chapter: "Market City",
    title: "Your First Trading Day",
    objective: "Learn how prices move, read a candle, and plan before a decision.",
    skills: ["Prices are uncertain in the short term", "Reading open, high, low and close", "Deciding the stop-loss before entering", "Working out the money at risk"],
    correct: { mood: "celebrate", text: "Exactly! Let's keep going." },
    wrong: { mood: "confused", text: "Not quite. Want a hint before you try again?" },
    scenes: [
      {
        id: "market",
        kind: "ticker",
        title: "Enter the market",
        questionId: "m1-first-trading-day-q1",
        lines: [
          { mood: "enter", text: "Welcome to Market City! I'm Tiko, your market guide." },
          { mood: "explain", text: "This board shows index prices from TradeD's market feed. They change whenever buyers and sellers agree on a trade." },
          { mood: "thinking", text: "Quick question before we walk on." },
        ],
      },
      {
        id: "candle",
        kind: "candle",
        title: "Discover a candle",
        questionId: "m1-first-trading-day-q2",
        candle: { open: 100, high: 108, low: 98, close: 106 },
        context: [[99, 101, 97, 98], [98, 100, 96, 99.5], [99.5, 101.5, 98, 100.5], [100.5, 102, 99, 99.6], [99.6, 101, 98.4, 100]].map(([open, high, low, close]) => ({ open, high, low, close })),
        lines: [
          { mood: "point", text: "This is a candle. It sums up one period of trading with four prices." },
          { mood: "explain", text: "The open is where the period started: ₹100.", highlight: "open" },
          { mood: "explain", text: "The high is the most anyone paid: ₹108, the top of the wick.", highlight: "high" },
          { mood: "explain", text: "The low is the least: ₹98, the bottom of the wick.", highlight: "low" },
          { mood: "explain", text: "And the close is where it ended. It's green, so it closed above the open.", highlight: "close" },
          { mood: "thinking", text: "Your turn: which price is the close?" },
        ],
      },
      {
        id: "decision",
        kind: "decision",
        title: "Make a decision",
        planQuestionId: "m1-first-trading-day-q3",
        riskQuestionId: "m1-first-trading-day-q4",
        history: HISTORY,
        after: AFTER,
        choices: [
          { id: "buy", label: "Buy now", mood: "encourage", feedback: "Buying a strong trend can work, but right under a ceiling that held twice there is little room before it. If you buy, the stop-loss decides how much one wrong idea costs." },
          { id: "sell", label: "Sell now", mood: "thinking", feedback: "Selling against an uptrend is a contrarian bet. The ceiling might hold, but the trend is up, so the risk is that it breaks out against you." },
          { id: "wait", label: "Wait", mood: "celebrate", feedback: "Waiting is a real decision. Near a level that held twice, many traders wait for a clear breakout or a pullback before acting." },
        ],
        lines: [
          { mood: "point", text: "Here's an educational chart (made-up prices, not a real stock). The price climbed, then stalled twice near ₹120." },
          { mood: "explain", text: "Before you decide anything, let's plan like a professional." },
        ],
      },
      {
        id: "review",
        kind: "review",
        title: "Review",
        lines: [
          { mood: "mission-complete", text: "Mission complete! You read the market, a candle and a plan." },
        ],
      },
    ],
  },
};

export function missionFor(slug: string): Mission | null {
  return MISSIONS[slug] ?? null;
}
