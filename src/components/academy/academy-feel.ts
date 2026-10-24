"use client";

import { useEffect, useState, type RefObject } from "react";
import { cue, feedbackPrefs, primeAudio } from "./academy-sound";
import { holdMusic, setMusicLevel, syncMusic } from "./academy-music";

const RIPPLE = ".ax-btn, .ax-btn-ghost, .ax-option, .mq-play, .mq-fog-card, .ax-hint-btn, .ax-menu-row";
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches || !feedbackPrefs().motion;

/**
 * The Academy's touch feel, for one screen root (map, lesson or mission): the first tap unlocks audio
 * and starts the music; every button and link answers a press with a spring (and the main buttons with
 * a ripple from the finger); a tap on a control without its own sound plays a soft click. Listeners
 * are attached once and removed on unmount.
 */
export function useAcademyFeel(root: RefObject<HTMLElement | null>, ready = true, musicLevel = 1) {
  useEffect(() => holdMusic(), []);
  // Lessons play the music a little quieter than the map; it fades between the two.
  useEffect(() => { setMusicLevel(musicLevel); }, [musicLevel]);
  useEffect(() => {
    const element = root.current;
    if (!element || !ready) return;
    const onDown = (event: PointerEvent) => {
      primeAudio();
      syncMusic();
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("button, a, [role='slider'], [role='switch']");
      if (!target || !element.contains(target) || target.matches(":disabled") || reduced()) return;
      // Restart the press animation on every press.
      target.classList.remove("ax-press");
      void target.offsetWidth;
      target.classList.add("ax-press");
      if (target.matches(RIPPLE)) {
        const box = target.getBoundingClientRect();
        const size = Math.max(box.width, box.height) * 2.2;
        const ripple = document.createElement("span");
        ripple.className = "ax-ripple";
        ripple.style.width = ripple.style.height = `${size}px`;
        ripple.style.left = `${event.clientX - box.left - size / 2}px`;
        ripple.style.top = `${event.clientY - box.top - size / 2}px`;
        target.appendChild(ripple);
        window.setTimeout(() => ripple.remove(), 650);
      }
    };
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("button, a");
      if (!target || !element.contains(target) || target.matches(":disabled")) return;
      // After the control's own handler: if it already made a sound, the tap stays silent.
      window.setTimeout(() => cue("tap"), 0);
    };
    element.addEventListener("pointerdown", onDown, { capture: true });
    element.addEventListener("click", onClick);
    return () => {
      element.removeEventListener("pointerdown", onDown, { capture: true });
      element.removeEventListener("click", onClick);
    };
  }, [root, ready]);
}

/**
 * Keeps something on screen while it animates out: `shown` is the value to render (the last one
 * during the exit), `closing` is true for those `ms` after it went away.
 */
export function usePresence<T>(value: T | null, ms = 200) {
  const [kept, setKept] = useState<T | null>(value);
  if (value !== null && value !== kept) setKept(value);
  const closing = value === null && kept !== null;
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setKept(null), reduced() ? 0 : ms);
    return () => window.clearTimeout(timer);
  }, [closing, ms]);
  return { shown: value ?? kept, closing };
}
