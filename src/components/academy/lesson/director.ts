"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cue, type Cue } from "@/components/academy/academy-sound";
import type { TikoMood } from "@/lib/academy/missions";
import type { PublicQuestion } from "@/lib/academy/types";

/**
 * The lesson's interaction director: every learner action becomes one event, and each event decides
 * Tiko's pose, what his speech bubble says (or that it closes), at most one sound, and whether a glow
 * burst plays. Effects run once per event (from the handler that dispatches it), never from render or
 * an effect, so nothing doubles under React's development re-runs.
 */

/** Correct-in-a-row thresholds for this lesson (not the daily streak): a note, a cheer, a big moment. */
export const COMBO = { notice: 3, cheer: 5, milestone: 10 } as const;

export type LessonEvent =
  | { type: "LESSON_ENTER" }
  | { type: "TIP_ENTER"; index: number; first: boolean }
  | { type: "QUESTION_ENTER"; question: PublicQuestion; index: number; afterTips: boolean; retry: boolean }
  | { type: "ANSWER_SELECTED" }
  | { type: "CHECK_STARTED" }
  | { type: "ANSWER_CORRECT"; combo: number; index: number }
  | { type: "ANSWER_INCORRECT"; hint: string | null; index: number }
  | { type: "CHECK_FAILED" }
  | { type: "HINT_OPENED"; hint: string }
  | { type: "HINT_CLOSED" }
  | { type: "CONTINUE_PRESSED" }
  /** The learner has paused on a question for a while (no pick yet). */
  | { type: "IDLE_NUDGE"; hasHint: boolean }
  | { type: "LESSON_COMPLETED"; perfect: boolean; firstTime: boolean };

export type SpeechTone = "info" | "good" | "soft" | "hint" | "reward";
export type Reaction = {
  mood: TikoMood;
  /** What Tiko says (a new bubble), null to close the bubble, undefined to leave it as it is. */
  say?: { text: string; tone: SpeechTone } | null;
  /** A pose to settle into once the first reaction has played. */
  settle?: { mood: TikoMood; after: number };
  sound?: Cue;
  burst?: "good" | "big";
};

const OPENERS = ["Ready?", "Next one.", "Here's one for you.", "Let's try this.", "Your turn."];
const RIGHT = ["Exactly!", "Yes, that's it!", "Sharp eye!", "Great thinking!", "Nailed it!", "Spot on!"];
const ALMOST = ["Almost!", "Not quite, but close.", "Good try!", "Nearly there."];

/** A short instruction for what to do with this kind of exercise. */
export function instructionFor(question: PublicQuestion) {
  switch (question.kind) {
    case "choice": return "Pick the best answer, then press Check.";
    case "truefalse": return "Is it true or false?";
    case "fill": return "Type the missing word.";
    case "numeric": return question.unit ? `Work it out and type the answer in ${question.unit}.` : "Work it out and type the number.";
    case "match": return "Tap an item, then its partner.";
    case "tapcandle": return "Look at the chart and tap the right candle.";
    case "order": return "Tap the steps in the right order.";
    case "pricezone": return "Drag the line on the chart to the right price.";
  }
}

const pick = <T,>(items: readonly T[], seed: number) => items[Math.abs(seed) % items.length];

/** What an event means for Tiko, his bubble and the sound (pure: the same event, the same reaction). */
export function reactTo(event: LessonEvent): Reaction {
  switch (event.type) {
    case "LESSON_ENTER":
      return { mood: "enter", settle: { mood: "idle", after: 900 } };
    case "TIP_ENTER":
      return { mood: "explain", say: { text: event.first ? "Welcome! Here's the idea first, then you'll practise it." : "One more idea before we practise.", tone: "info" }, sound: event.first ? "dialogue" : undefined };
    case "QUESTION_ENTER":
      return {
        mood: "look",
        say: { text: event.retry ? `Let's try this one again. ${instructionFor(event.question)}` : `${event.afterTips ? "Ready? " : `${pick(OPENERS, event.index)} `}${instructionFor(event.question)}`, tone: "info" },
        settle: { mood: "thinking", after: 1400 },
        // A cue for the first exercise only: every question chiming would get tiring.
        sound: event.afterTips ? "dialogue" : undefined,
      };
    case "ANSWER_SELECTED":
      // A pick changes Tiko's pose (and a nod), not his words: no interrupting every tap.
      return { mood: "listening", sound: "select" };
    case "CHECK_STARTED":
      return { mood: "thinking", sound: "check" };
    case "ANSWER_CORRECT": {
      const { combo } = event;
      const milestone = combo === COMBO.notice || combo === COMBO.cheer || combo === COMBO.milestone;
      const text = combo === COMBO.milestone ? `${combo} in a row! Incredible!` : combo === COMBO.cheer ? `${combo} in a row! You're on fire!` : combo === COMBO.notice ? `${pick(RIGHT, event.index)} That's ${combo} in a row.` : pick(RIGHT, event.index);
      return {
        mood: combo >= COMBO.cheer && milestone ? "streak" : "celebrate",
        say: { text, tone: milestone ? "reward" : "good" },
        settle: { mood: "idle", after: combo >= COMBO.cheer && milestone ? 2600 : 1500 },
        sound: combo >= COMBO.cheer && milestone ? "combo" : "correct",
        burst: combo === COMBO.milestone ? "big" : "good",
      };
    }
    case "ANSWER_INCORRECT":
      return {
        mood: "surprised",
        say: { text: event.hint ? `${pick(ALMOST, event.index)} Hint: ${event.hint}` : `${pick(ALMOST, event.index)} Read why below. This one comes back later.`, tone: event.hint ? "hint" : "soft" },
        settle: { mood: event.hint ? "hint" : "encourage", after: 520 },
        sound: "wrong",
      };
    case "CHECK_FAILED":
      return { mood: "surprised", say: { text: "Hmm, I couldn't reach the server. Nothing was marked. Try again.", tone: "soft" }, settle: { mood: "idle", after: 600 } };
    case "HINT_OPENED":
      return { mood: "hint", say: { text: event.hint, tone: "hint" }, sound: "hint" };
    case "HINT_CLOSED":
      return { mood: "thinking", say: null };
    case "CONTINUE_PRESSED":
      // Tiko takes off with the transition; he lands for the next screen.
      return { mood: "fly", say: null, sound: "page" };
    case "IDLE_NUDGE":
      return { mood: "curious", say: { text: event.hasHint ? "Stuck? Tap Hint and I'll give you a clue." : "Take your time. Read each option once more.", tone: "info" }, settle: { mood: "thinking", after: 1600 } };
    case "LESSON_COMPLETED":
      return {
        mood: event.perfect ? "streak" : "mission-complete",
        say: { text: event.perfect ? "A perfect lesson! Not a single mistake." : event.firstTime ? "Lesson complete! Your progress is saved." : "Lesson reviewed. Nicely done.", tone: "reward" },
        sound: "complete",
        burst: "big",
      };
  }
}

export type Speech = { key: number; text: string; tone: SpeechTone; open: boolean };
export type Stage = { mood: TikoMood; speech: Speech | null; talking: boolean; burst: { key: number; size: "good" | "big" } | null };

/** Runs the director: `dispatch` applies an event's reaction and plays its one sound. */
export function useLessonDirector() {
  const [stage, setStage] = useState<Stage>({ mood: "idle", speech: null, talking: false, burst: null });
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  const dispatch = useCallback((event: LessonEvent) => {
    const reaction = reactTo(event);
    // A new event replaces the previous one's pending settle and mouth movement.
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    if (reaction.sound) cue(reaction.sound);
    const speaks = Boolean(reaction.say);
    setStage((current) => ({
      mood: reaction.mood,
      talking: speaks,
      speech: reaction.say === undefined ? current.speech
        : reaction.say === null ? (current.speech ? { ...current.speech, open: false } : null)
          : { key: (current.speech?.key ?? 0) + 1, text: reaction.say.text, tone: reaction.say.tone, open: true },
      burst: reaction.burst ? { key: (current.burst?.key ?? 0) + 1, size: reaction.burst } : current.burst,
    }));
    if (speaks) timers.current.push(window.setTimeout(() => setStage((current) => ({ ...current, talking: false })), 1100));
    if (reaction.settle) {
      const { mood, after } = reaction.settle;
      timers.current.push(window.setTimeout(() => setStage((current) => ({ ...current, mood })), after));
    }
  }, []);

  return { stage, dispatch };
}
