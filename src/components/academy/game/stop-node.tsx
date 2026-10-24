"use client";

import { forwardRef, useState } from "react";
import { Check, Lock, Star } from "lucide-react";
import type { ChapterTheme, JourneyStop } from "@/lib/academy/world";
import { THEME } from "./world-art";

/**
 * A lesson stop on the road: a raised platform in the chapter's colours. Completed stops turn gold
 * with their stars, the current one breathes and invites play, locked ones explain themselves.
 */
export const StopNode = forwardRef<HTMLButtonElement, {
  stop: JourneyStop;
  theme: ChapterTheme;
  chapterName: string;
  position: { index: number; of: number };
  left: number;
  top: number;
  order: number;
  stars: number;
  story: boolean;
  launching: boolean;
  /** Just opened by a real completion: plays the unlock burst once. */
  unlocked?: boolean;
  onOpen: () => void;
  onLocked: () => void;
}>(function StopNode({ stop, theme, chapterName, position, left, top, order, stars, story, launching, unlocked = false, onOpen, onLocked }, ref) {
  // Short-lived flag restarts the wiggle without remounting (focus stays put).
  const [wiggle, setWiggle] = useState(false);
  const style = THEME[theme];
  const Glyph = style.glyph;
  const state = stop.stop;

  function click() {
    if (state === "locked") {
      setWiggle(true);
      window.setTimeout(() => setWiggle(false), 450);
      onLocked();
      return;
    }
    onOpen();
  }

  const status = state === "completed" ? `Completed, ${stars} of 3 stars` : state === "current" ? (stop.state === "in-progress" ? "Continue here" : "Next lesson") : state === "locked" ? "Locked" : "Open";
  return (
    <div
      className={`mq-stop-wrap${launching ? " mq-launch-target" : ""}`}
      data-state={state}
      style={{ left: `${left}%`, top: `${top}%`, animationDelay: `${Math.min(order, 8) * 45 + 120}ms` }}
    >
      {state === "current" ? <span className="mq-callout" aria-hidden>{stop.state === "in-progress" ? "CONTINUE" : "START"}</span> : null}
      <button
        ref={ref}
        type="button"
        className={`mq-stop${wiggle ? " mq-wiggle" : ""}`}
        data-state={state}
        // Completed (gold) and locked (slate) colours come from the stylesheet; playable stops wear the chapter's.
        style={{ ["--accent" as string]: style.accent, ...(state === "current" || state === "open" ? { ["--face-a" as string]: style.face[0], ["--face-b" as string]: style.face[1], ["--rim" as string]: style.rim } : {}) }}
        aria-label={`${chapterName}, lesson ${position.index} of ${position.of}: ${stop.title}. ${status}.`}
        aria-haspopup={state === "locked" ? undefined : "dialog"}
        onClick={click}
      >
        <span className="mq-stop-ring" aria-hidden />
        {unlocked ? <span className="mq-unlock" aria-hidden /> : null}
        <span className="mq-stop-face" aria-hidden>
          {state === "completed" ? <Check strokeWidth={3.5} /> : state === "locked" ? <Lock strokeWidth={2.6} /> : <Glyph strokeWidth={2.4} />}
        </span>
        {story ? <span className="mq-story" aria-hidden>STORY</span> : null}
      </button>
      {state === "completed" ? (
        <span className="mq-stars" aria-hidden>
          {[0, 1, 2].map((index) => <Star key={index} width={14} height={14} fill={index < stars ? "#ffc83d" : "rgba(255,255,255,.25)"} stroke={index < stars ? "#b77800" : "rgba(255,255,255,.5)"} strokeWidth={1.6} />)}
        </span>
      ) : null}
      <span className="mq-stop-tip" aria-hidden>{stop.title}{state === "locked" ? " · Locked" : ` · ${stop.minutes} min`}</span>
    </div>
  );
});
