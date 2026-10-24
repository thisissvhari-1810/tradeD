import type { Lesson } from "@/lib/academy/types";

/**
 * Market City, Mission 1: "Your First Trading Day". A story lesson: Tiko's scenes live in
 * src/lib/academy/missions.ts; the decisions below are its graded questions (graded on the server
 * like any lesson, so XP and progress use the same once-only rules).
 */
export const mission1: Lesson = {
  slug: "m1-first-trading-day",
  title: "Your First Trading Day",
  summary: "Meet the market, read your first candle and make a plan before a decision.",
  minutes: 6,
  topic: "basics",
  cards: [
    { title: "Prices move", body: "A stock's price changes all day as buyers and sellers agree on trades. Short-term moves are uncertain: nobody knows the next tick for sure." },
    { title: "One candle, four prices", body: "A candle shows a period's open, high, low and close. A green body means it closed above where it opened; red means below." },
    { title: "Plan before you act", body: "Before any trade, decide where your idea is wrong (your stop-loss) and how much you can afford to lose. Protecting capital comes first." },
  ],
  questions: [
    {
      id: "m1-first-trading-day-q1",
      kind: "choice",
      prompt: "The price on the ticker just changed. Where will it be five minutes from now?",
      options: ["Higher, prices rise during the day", "Lower, prices fall after a rise", "Nobody knows for sure; short-term moves are uncertain"],
      answer: 2,
      explanation: "Short-term price moves are uncertain. Traders work with probabilities and plans, not certainties.",
      mistake: "Assuming the next move can be known from the last one.",
      hint: "Could anyone, even a professional, be certain?",
      topic: "basics",
      difficulty: 1,
    },
    {
      id: "m1-first-trading-day-q2",
      kind: "choice",
      prompt: "This green candle opened at ₹100, rose to ₹108, dipped to ₹98 and ended at ₹106. What is its close?",
      options: ["₹100", "₹108", "₹98", "₹106"],
      answer: 3,
      explanation: "The close is the last price of the period: ₹106. On a green candle it is the top of the body.",
      mistake: "Picking the high (the top of the wick) instead of the close (the top of the body).",
      hint: "Look at where the green body ends, not where the wick ends.",
      topic: "candlesticks",
      difficulty: 1,
      candles: [{ open: 100, high: 108, low: 98, close: 106 }],
    },
    {
      id: "m1-first-trading-day-q3",
      kind: "choice",
      prompt: "You like the idea of buying. What should you decide before entering?",
      options: ["How much profit to celebrate", "The price where your idea is wrong (stop-loss) and how much you can lose", "Nothing, decide after the trade moves"],
      answer: 1,
      explanation: "Deciding the stop-loss and the amount at risk before entering keeps one bad trade from hurting your capital.",
      mistake: "Planning only the profit, or deciding the exit after the price has already moved against you.",
      topic: "risk",
      difficulty: 1,
    },
    {
      id: "m1-first-trading-day-q4",
      kind: "numeric",
      prompt: "You buy 5 shares at ₹106 with a stop-loss at ₹96. How much do you lose if the stop is hit (ignore costs)?",
      answer: 50,
      tolerance: 0,
      unit: "₹",
      explanation: "Risk per share is ₹106 − ₹96 = ₹10. Five shares × ₹10 = ₹50.",
      mistake: "Multiplying the entry price by the quantity instead of the distance to the stop.",
      hint: "First find the gap between entry and stop, then multiply by the shares.",
      topic: "risk",
      difficulty: 2,
    },
  ],
};
