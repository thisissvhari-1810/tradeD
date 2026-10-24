"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronRight, SkipForward } from "lucide-react";
import type { Line, TikoMood } from "@/lib/academy/missions";
import { Tiko } from "./tiko";

/**
 * Tiko speaks a short sequence of lines: each types out (a tap finishes it at once), Continue moves
 * on and Skip jumps to the end. Tiko's mood follows the current line.
 */
export function TutorDialogue({ lines, onDone, doneLabel = "Continue", mood: moodOverride, compact = false, onLine, avatar = true }: {
  lines: Line[];
  onDone?: () => void;
  doneLabel?: string;
  /** Overrides the line's mood (e.g. celebrate after a correct answer). */
  mood?: TikoMood;
  compact?: boolean;
  onLine?: (line: Line) => void;
  /** False when Tiko is already on screen elsewhere (the map), so he is not shown twice. */
  avatar?: boolean;
}) {
  const [index, setIndex] = useState(0);
  // Characters typed so far, for the line showing; another line starts at 0.
  const [typed, setTyped] = useState({ key: "", count: 0 });
  const reduce = useSyncExternalStore(
    (notify) => { const query = window.matchMedia("(prefers-reduced-motion: reduce)"); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
  const line = lines[Math.min(index, lines.length - 1)];
  const key = String(index);
  const length = line?.text.length ?? 0;
  const shown = reduce ? length : typed.key === key ? typed.count : 0;
  const typing = shown < length;

  useEffect(() => {
    if (line) onLine?.(line);
  }, [line, onLine]);
  useEffect(() => {
    if (reduce) return;
    const timer = window.setInterval(() => setTyped((current) => {
      const count = current.key === key ? current.count : 0;
      if (count >= length) { window.clearInterval(timer); return current; }
      return { key, count: Math.min(length, count + 2) };
    }), 18);
    return () => window.clearInterval(timer);
  }, [key, length, reduce]);
  const finish = () => setTyped({ key, count: length });

  if (!line) return null;
  const last = index >= lines.length - 1;

  function next() {
    if (typing) { finish(); return; }
    if (last) onDone?.();
    else setIndex((value) => value + 1);
  }

  return (
    <div className="flex items-end gap-2 sm:gap-3">
      {avatar ? <Tiko mood={moodOverride ?? line.mood} size={compact ? 70 : 96} /> : null}
      <div className="mq-bubble min-w-0 flex-1" role="group" aria-label="Tiko says">
        <p className="min-h-[2.75em] text-[15px] font-semibold leading-snug" onClick={finish}>
          <span aria-hidden>{line.text.slice(0, shown)}</span>{typing ? <span className="mq-caret" aria-hidden /> : null}
          <span className="sr-only" aria-live="polite">{line.text}</span>
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          {lines.length > 1 ? <span className="text-[11px] font-bold text-[#0d1726]/45">{index + 1}/{lines.length}</span> : null}
          <span className="flex-1" />
          {!last ? <button type="button" className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-[12px] font-bold text-[#0d1726]/60 hover:bg-black/5" onClick={() => setIndex(lines.length - 1)}><SkipForward className="h-4 w-4" aria-hidden />Skip</button> : null}
          {onDone || !last ? (
            <button type="button" className="inline-flex h-10 items-center gap-1 rounded-full bg-[#0d1726] px-4 text-[13px] font-extrabold" style={{ color: "#fffaf0" }} onClick={next} autoFocus>
              {last && !typing ? doneLabel : "Next"}<ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
