"use client";

import type { ReactNode } from "react";
import { SPAN_LABEL, type ChartSpan } from "@/lib/market/spans";
import { REPLAY_SPEEDS, REPLAY_STATUS_LABEL, type ReplaySpeed, type ReplayStatus } from "@/lib/trading/replay-engine";
import { SessionDateField, SessionRuler, SessionTimeField } from "@/components/replay-pickers";
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";

export function ReplayBar({
  date,
  today,
  cursor,
  sessionOpen,
  sessionClose,
  status,
  speed,
  timeframe,
  message,
  onDate,
  onToggle,
  onStep,
  onSeek,
  onReset,
  onSpeed,
}: {
  date: string;
  today: string;
  cursor: number | null;
  sessionOpen: number | null;
  sessionClose: number | null;
  status: ReplayStatus;
  speed: ReplaySpeed;
  timeframe: ChartSpan;
  message: string;
  onDate: (date: string) => void;
  onToggle: () => void;
  onStep: (direction: -1 | 1) => void;
  onSeek: (cursor: number) => void;
  onReset: () => void;
  onSpeed: (speed: ReplaySpeed) => void;
}) {
  const busy = status === "loading";
  const blocked = busy || status === "error" || status === "idle" || cursor == null || sessionOpen == null || sessionClose == null;
  const playing = status === "playing";
  const atStart = cursor != null && sessionOpen != null && cursor <= sessionOpen;
  const atEnd = cursor != null && sessionClose != null && cursor >= sessionClose;
  const tone = status === "error" ? "text-warning" : status === "playing" ? "text-primary" : "text-muted";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border bg-panel px-3 py-1.5 text-text" role="group" aria-label="Replay controls">
      <div className="flex items-center gap-1">
        <Transport label="Step back one minute" disabled={blocked || atStart} onClick={() => onStep(-1)}><SkipBack className="h-3.5 w-3.5" /></Transport>
        <button type="button" aria-label={playing ? "Pause replay" : "Play replay"} title={playing ? "Pause replay" : "Play replay"} disabled={blocked || atEnd} className="grid h-8 w-8 place-items-center rounded-full bg-primary text-on-primary hover:bg-primary-hover" onClick={onToggle}>{playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}</button>
        <Transport label="Step forward one minute" disabled={blocked || atEnd} onClick={() => onStep(1)}><SkipForward className="h-3.5 w-3.5" /></Transport>
        <Transport label="Reset replay to the session open" disabled={busy || sessionOpen == null} onClick={onReset}><RotateCcw className="h-3.5 w-3.5" /></Transport>
      </div>
      <SessionDateField value={date} today={today} onChange={onDate} />
      <SessionTimeField date={date} cursor={cursor} sessionOpen={sessionOpen} sessionClose={sessionClose} disabled={blocked} onSeek={onSeek} />
      <div className="min-w-[200px] flex-1">
        <SessionRuler sessionOpen={sessionOpen} sessionClose={sessionClose} cursor={cursor} disabled={blocked} onSeek={onSeek} />
      </div>
      <div className="flex items-center rounded-input border border-border bg-elevated p-0.5" role="group" aria-label="Replay speed">
        {REPLAY_SPEEDS.map((item) => (
          <button key={item} type="button" aria-pressed={speed === item} disabled={busy} className={`h-6 rounded-xs px-2 text-[11px] ${speed === item ? "bg-panel font-semibold text-text shadow-e1" : "text-muted hover:text-text"}`} onClick={() => onSpeed(item)}>{item}x</button>
        ))}
      </div>
      <span className={`text-[11px] font-medium ${tone}`} title={message || undefined}>{REPLAY_STATUS_LABEL[status]} · {SPAN_LABEL[timeframe]}</span>
      {message && status === "error" ? <p className="w-full truncate text-[11px] text-warning" title={message}>{message}</p> : null}
    </div>
  );
}

function Transport({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} className="grid h-7 w-7 place-items-center rounded-full text-text-2 hover:bg-elevated hover:text-text" onClick={onClick}>{children}</button>
  );
}
