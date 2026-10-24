"use client";

import { forwardRef, useState } from "react";
import { Check, Crown, Lock, Star } from "lucide-react";
import type { ChapterTheme, JourneyStop } from "@/lib/academy/world";
import { THEME } from "./world-art";
import type { WorldDef } from "./worlds/config";

/**
 * A lesson stop on the road: a raised platform in the chapter's colours. Completed stops turn gold
 * with their stars, the current one breathes and invites play, locked ones explain themselves.
 */
export const StopNode = forwardRef<HTMLButtonElement, {
  stop: JourneyStop;
  theme: ChapterTheme;
  /** The map world: the stop's shape and colours. */
  world: WorldDef;
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
}>(function StopNode({ stop, theme, world, chapterName, position, left, top, order, stars, story, launching, unlocked = false, onOpen, onLocked }, ref) {
  // Short-lived flag restarts the wiggle without remounting (focus stays put).
  const [wiggle, setWiggle] = useState(false);
  const Glyph = THEME[theme].glyph;
  const region = world.region(stop.chapter);
  const state = stop.stop;
  const perfect = stop.state === "mastered";
  // In progress: the share of its questions already answered correctly (from the server's records).
  const share = state !== "completed" && stop.answered && stop.questions ? Math.min(1, stop.answered / stop.questions) : 0;

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
      data-world={world.id}
      style={{ left: `${left}%`, top: `${top}%`, animationDelay: `${Math.min(order, 8) * 45 + 120}ms` }}
    >
      {state === "current" ? <span className="mq-callout" aria-hidden>{stop.state === "in-progress" ? "CONTINUE" : "START"}</span> : null}
      <button
        ref={ref}
        type="button"
        className={`mq-stop${wiggle ? " mq-wiggle" : ""}`}
        data-state={state}
        data-world={world.id}
        data-perfect={perfect ? "true" : undefined}
        // Completed (gold) and locked (slate) colours come from the stylesheet; playable stops wear the chapter's.
        style={{ ["--accent" as string]: region.accent, ...(state === "current" || state === "open" ? { ["--face-a" as string]: region.face[0], ["--face-b" as string]: region.face[1], ["--rim" as string]: region.rim } : {}) }}
        aria-label={`${chapterName}, lesson ${position.index} of ${position.of}: ${stop.title}. ${status}${perfect ? ", perfect score" : ""}${share ? `, ${Math.round(share * 100)}% answered` : ""}.`}
        aria-haspopup={state === "locked" ? undefined : "dialog"}
        onClick={click}
      >
        <span className="mq-stop-ring" aria-hidden />
        {share ? (
          <svg className="mq-progress-ring" viewBox="0 0 100 100" aria-hidden>
            <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="6" />
            <circle cx="50" cy="50" r="46" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" pathLength={100} strokeDasharray={`${share * 100} 100`} transform="rotate(-90 50 50)" />
          </svg>
        ) : null}
        {perfect ? <span className="mq-crown" aria-hidden><Crown className="h-4 w-4" fill="currentColor" strokeWidth={2} /></span> : null}
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
