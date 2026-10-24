"use client";

import { Tiko } from "@/components/academy/game/tiko";
import type { Stage } from "./director";

/**
 * Tiko's corner of the lesson: the character (with a soft halo while he speaks or celebrates, a
 * particle burst on real successes, a nod when the learner picks an answer) and his speech bubble.
 * The bubble opens out of Tiko — a typing indicator, then the words — and contracts back into him when
 * it closes. It keeps its space while closed, so the exercise below never jumps.
 */
export function TutorStage({ stage, nod, onDismiss, dismissLabel = "Got it", size = 76 }: {
  stage: Stage;
  /** Bumped on each pick (Tiko nods). */
  nod: number;
  /** Shown as a button in hint bubbles (closes the hint). */
  onDismiss?: () => void;
  dismissLabel?: string;
  size?: number;
}) {
  const { speech } = stage;
  const glow = speech?.open && speech.tone === "reward" ? "reward"
    : stage.mood === "celebrate" || stage.mood === "streak" || stage.mood === "mission-complete" ? "good"
    : speech?.open && (speech.tone === "soft" || speech.tone === "hint") ? "soft"
      : stage.talking ? "talk" : "none";
  return (
    <div className="ax-stage" data-glow={glow}>
      <div className="ax-tiko-wrap">
        <span className="ax-halo" aria-hidden />
        {stage.burst ? (
          <span key={stage.burst.key} className="ax-particles" data-size={stage.burst.size} aria-hidden>
            {Array.from({ length: stage.burst.size === "big" ? 14 : 8 }, (_, index) => <i key={index} style={{ ["--a" as string]: `${(index / (stage.burst?.size === "big" ? 14 : 8)) * 360}deg` }} />)}
          </span>
        ) : null}
        {/* Alternating the animation name replays the nod without re-creating Tiko (his pose carries on). */}
        <span className={nod ? `inline-flex ${nod % 2 ? "ax-nod" : "ax-nod-b"}` : "inline-flex"}>
          {/* No mouth movement: Tiko has no voice, so moving lips would be fake. */}
          <Tiko mood={stage.mood} size={size} className="ax-tiko" />
        </span>
      </div>
      <div className="ax-speech" data-open={speech?.open ? "true" : "false"} data-tone={speech?.tone} aria-hidden={!speech?.open}>
        {speech ? (
          <div key={speech.key} className="ax-speech-inner">
            <span className="ax-typing" aria-hidden><i /><i /><i /></span>
            <p className="ax-speech-text">{speech.text}</p>
            {speech.open && speech.tone === "hint" && onDismiss ? <button type="button" className="ax-speech-dismiss" onClick={onDismiss}>{dismissLabel}</button> : null}
          </div>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">{speech?.open ? `Tiko: ${speech.text}` : ""}</p>
    </div>
  );
}
