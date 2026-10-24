import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMBO, instructionFor, reactTo, type LessonEvent } from "@/components/academy/lesson/director";
import { UNITS } from "@/lib/academy/content";
import { publicQuestion } from "@/lib/academy/rules";

const question = publicQuestion(UNITS[1].lessons[0].questions[0]);
const events: LessonEvent[] = [
  { type: "LESSON_ENTER" },
  { type: "TIP_ENTER", index: 0, first: true },
  { type: "QUESTION_ENTER", question, index: 1, afterTips: true, retry: false },
  { type: "ANSWER_SELECTED" },
  { type: "CHECK_STARTED" },
  { type: "ANSWER_CORRECT", combo: 1, index: 1 },
  { type: "ANSWER_INCORRECT", hint: "Look at the close.", index: 2 },
  { type: "CHECK_FAILED" },
  { type: "HINT_OPENED", hint: "Look at the close." },
  { type: "HINT_CLOSED" },
  { type: "CONTINUE_PRESSED" },
  { type: "LESSON_COMPLETED", perfect: true, firstTime: true },
];

describe("the lesson director", () => {
  it("gives every event at most one sound (never two for one action)", () => {
    for (const event of events) {
      const reaction = reactTo(event);
      expect(typeof reaction.sound === "string" || reaction.sound === undefined, event.type).toBe(true);
    }
  });

  it("answers Tiko's pose to what really happened, and celebrates only after a correct verdict", () => {
    expect(reactTo({ type: "CHECK_STARTED" }).mood).toBe("thinking");
    expect(reactTo({ type: "ANSWER_CORRECT", combo: 1, index: 0 })).toMatchObject({ mood: "celebrate", sound: "correct", burst: "good" });
    const wrong = reactTo({ type: "ANSWER_INCORRECT", hint: null, index: 0 });
    expect(wrong.mood).not.toMatch(/celebrate|streak/);
    expect(wrong.burst).toBeUndefined();
    expect(wrong.sound).toBe("wrong");
    expect(reactTo({ type: "CHECK_FAILED" }).sound).toBeUndefined();
    for (const event of events.filter((item) => item.type !== "ANSWER_CORRECT" && item.type !== "LESSON_COMPLETED")) {
      expect(reactTo(event).burst, event.type).toBeUndefined();
    }
  });

  it("does not interrupt a pick with words, and closes the bubble on continue and hint dismissal", () => {
    expect(reactTo({ type: "ANSWER_SELECTED" }).say).toBeUndefined();
    expect(reactTo({ type: "CONTINUE_PRESSED" }).say).toBeNull();
    expect(reactTo({ type: "HINT_CLOSED" }).say).toBeNull();
    expect(reactTo({ type: "HINT_OPENED", hint: "Look at the close." }).say).toEqual({ text: "Look at the close.", tone: "hint" });
  });

  it("marks combo milestones with a bigger moment, at the configured thresholds", () => {
    expect(reactTo({ type: "ANSWER_CORRECT", combo: COMBO.cheer, index: 0 })).toMatchObject({ mood: "streak", sound: "combo" });
    expect(reactTo({ type: "ANSWER_CORRECT", combo: COMBO.milestone, index: 0 }).burst).toBe("big");
    expect(reactTo({ type: "ANSWER_CORRECT", combo: COMBO.cheer + 1, index: 0 }).sound).toBe("correct");
  });

  it("varies what Tiko says between questions and has an instruction for every exercise kind", () => {
    const lines = new Set([0, 1, 2, 3].map((index) => reactTo({ type: "QUESTION_ENTER", question, index, afterTips: false, retry: false }).say?.text));
    expect(lines.size).toBeGreaterThan(1);
    const kinds = new Set(UNITS.flatMap((unit) => unit.lessons.flatMap((lesson) => lesson.questions.map((item) => publicQuestion(item)))).map((item) => instructionFor(item)));
    expect([...kinds].every((text) => typeof text === "string" && text.length > 5)).toBe(true);
  });
});

describe("Academy question screens", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  it("have no Undo / replay icon", () => {
    for (const file of ["src/components/academy/lesson-player.tsx", "src/components/academy/lesson/exercise-view.tsx", "src/components/academy/lesson/feedback-tray.tsx", "src/components/academy/lesson/tutor-stage.tsx", "src/components/academy/game/tutor-dialogue.tsx", "src/components/academy/game/mission-player.tsx"]) {
      expect(read(file), file).not.toMatch(/RotateCcw|RotateCw|Undo2?\b|Redo\b/);
    }
  });
});
