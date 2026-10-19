"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { clockLabel, cursorFromClock } from "@/lib/trading/replay-engine";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MARKS = ["09:15", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "15:30"];

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function weekdayIndex(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}

function monthCells(year: number, month: number) {
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = weekdayIndex(year, month, 1);
  const cells: Array<{ key: string; day: number | null; date: string | null }> = [];
  for (let index = 0; index < lead; index += 1) cells.push({ key: `pad-${index}`, day: null, date: null });
  for (let day = 1; day <= count; day += 1) cells.push({ key: dateKey(year, month, day), day, date: dateKey(year, month, day) });
  return cells;
}

function prettyDate(value: string) {
  const { year, month, day } = parseDate(value);
  if (!year || !month || !day) return "Choose date";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

function monthTitle(year: number, month: number) {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1, 12, 0, 0)));
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function SessionDateField({ value, today, onChange }: { value: string; today: string; onChange: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  const initial = parseDate(value || today);
  const [view, setView] = useState({ year: initial.year, month: initial.month });
  const close = () => setOpen(false);
  const ref = useDismiss(open, close);
  const cells = monthCells(view.year, view.month);

  function shift(delta: number) {
    const next = new Date(Date.UTC(view.year, view.month - 1 + delta, 1, 12, 0, 0));
    setView({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 });
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-label="Replay date" aria-expanded={open} className="flex items-center gap-2 rounded-input border border-border bg-elevated px-2.5 py-1.5 text-text" onClick={() => { setView({ year: initial.year, month: initial.month }); setOpen((current) => !current); }}>
        <span className="text-[10px] uppercase tracking-wide text-muted">Date</span>
        <span className="num text-xs">{value ? prettyDate(value) : "Choose"}</span>
      </button>
      {open ? (
        <div className="absolute left-0 bottom-[calc(100%+6px)] z-40 w-[280px] rounded-card border border-border bg-elevated p-3 shadow-e3">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" className="grid h-7 w-7 place-items-center rounded-input text-muted hover:bg-overlay hover:text-text" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft className="h-4 w-4" /></button>
            <p className="text-sm font-semibold text-text">{monthTitle(view.year, view.month)}</p>
            <button type="button" className="grid h-7 w-7 place-items-center rounded-input text-muted hover:bg-overlay hover:text-text" aria-label="Next month" onClick={() => shift(1)}><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted">
            {WEEKDAYS.map((day) => <span key={day} className="py-1">{day}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell) => {
              if (!cell.date || cell.day == null) return <span key={cell.key} />;
              const weekend = weekdayIndex(view.year, view.month, cell.day) === 0 || weekdayIndex(view.year, view.month, cell.day) === 6;
              const future = cell.date > today;
              const disabled = weekend || future;
              const selected = cell.date === value;
              return (
                <button
                  key={cell.key}
                  type="button"
                  disabled={disabled}
                  aria-label={cell.date}
                  className={`h-8 rounded-input text-xs ${selected ? "bg-primary font-semibold text-on-primary" : disabled ? "text-muted/40" : "text-text hover:bg-overlay"} ${cell.date === today && !selected ? "ring-1 ring-info" : ""}`}
                  onClick={() => { onChange(cell.date!); setOpen(false); }}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-muted">Weekends are closed. Future dates stay unavailable.</p>
        </div>
      ) : null}
    </div>
  );
}

export function SessionTimeField({
  date,
  cursor,
  sessionOpen,
  sessionClose,
  disabled,
  onSeek,
}: {
  date: string;
  cursor: number | null;
  sessionOpen: number | null;
  sessionClose: number | null;
  disabled: boolean;
  onSeek: (cursor: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useDismiss(open, close);
  const label = cursor != null ? clockLabel(cursor) : "09:15";
  const [hourText, minuteText] = label.split(":");
  const hour = Number(hourText);
  const hours = [9, 10, 11, 12, 13, 14, 15];

  function choose(nextHour: number, nextMinute: number) {
    if (sessionOpen == null || sessionClose == null) return;
    const clock = `${String(nextHour).padStart(2, "0")}:${String(nextMinute).padStart(2, "0")}`;
    const next = cursorFromClock(date, clock, sessionOpen, sessionClose);
    if (next != null) onSeek(next);
  }

  const minutes = hour === 9 ? Array.from({ length: 46 }, (_, index) => index + 15) : hour === 15 ? Array.from({ length: 31 }, (_, index) => index) : Array.from({ length: 60 }, (_, index) => index);

  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-label="Replay time" aria-expanded={open} disabled={disabled} className="flex items-center gap-2 rounded-input border border-border bg-elevated px-2.5 py-1.5 text-info disabled:opacity-40" onClick={() => setOpen((current) => !current)}>
        <span className="text-[10px] uppercase tracking-wide text-muted">Time</span>
        <span className="num text-xs">{label}</span>
      </button>
      {open && !disabled ? (
        <div className="absolute left-0 bottom-[calc(100%+6px)] z-40 w-[260px] rounded-card border border-border bg-elevated p-3 shadow-e3">
          <p className="text-[10px] uppercase tracking-wide text-muted">Session clock · IST</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {MARKS.map((mark) => (
              <button key={mark} type="button" className={`rounded-full px-2 py-1 text-[11px] ${label === mark ? "bg-primary text-on-primary" : "bg-overlay text-text hover:bg-border-strong"}`} onClick={() => {
                if (sessionOpen == null || sessionClose == null) return;
                const next = cursorFromClock(date, mark, sessionOpen, sessionClose);
                if (next != null) onSeek(next);
                setOpen(false);
              }}>{mark}</button>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <p className="mb-1 text-[10px] text-muted">Hour</p>
              <div className="max-h-36 overflow-auto rounded-input border border-border">
                {hours.map((item) => (
                  <button key={item} type="button" className={`block w-full px-2 py-1.5 text-left text-xs ${item === hour ? "bg-primary text-on-primary" : "text-text hover:bg-overlay"}`} onClick={() => choose(item, item === 9 ? Math.max(15, Number(minuteText)) : item === 15 ? Math.min(30, Number(minuteText)) : Number(minuteText))}>{String(item).padStart(2, "0")}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10px] text-muted">Minute</p>
              <div className="max-h-36 overflow-auto rounded-input border border-border">
                {minutes.map((item) => (
                  <button key={item} type="button" className={`block w-full px-2 py-1.5 text-left text-xs ${item === Number(minuteText) ? "bg-primary text-on-primary" : "text-text hover:bg-overlay"}`} onClick={() => { choose(hour, item); setOpen(false); }}>{String(item).padStart(2, "0")}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SessionRuler({
  sessionOpen,
  sessionClose,
  cursor,
  disabled,
  onSeek,
}: {
  sessionOpen: number | null;
  sessionClose: number | null;
  cursor: number | null;
  disabled: boolean;
  onSeek: (cursor: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const progress = cursor != null && sessionOpen != null && sessionClose != null && sessionClose > sessionOpen ? Math.min(1, Math.max(0, (cursor - sessionOpen) / (sessionClose - sessionOpen))) : 0;

  function seek(clientX: number) {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || sessionOpen == null || sessionClose == null || sessionClose <= sessionOpen) return;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const raw = sessionOpen + ratio * (sessionClose - sessionOpen);
    const snapped = sessionOpen + Math.round((raw - sessionOpen) / 60) * 60;
    onSeek(Math.min(sessionClose, Math.max(sessionOpen, snapped)));
  }

  return (
    <div className="flex items-center gap-2">
      <span className="num w-10 text-[10px] text-muted">09:15</span>
      <div
        ref={trackRef}
        role="slider"
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className={`relative h-6 flex-1 ${disabled ? "opacity-40" : "cursor-pointer"}`}
        onPointerDown={(event) => {
          if (disabled) return;
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          seek(event.clientX);
        }}
        onPointerMove={(event) => {
          if (dragging.current) seek(event.clientX);
        }}
        onPointerUp={() => { dragging.current = false; }}
        onKeyDown={(event) => {
          if (disabled || cursor == null) return;
          if (event.key === "ArrowRight") onSeek(cursor + 60);
          if (event.key === "ArrowLeft") onSeek(cursor - 60);
        }}
      >
        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-border-strong" />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary" style={{ width: `${progress * 100}%` }} />
        <div className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-text bg-primary" style={{ left: `calc(${progress * 100}% - 7px)` }} />
      </div>
      <span className="num w-10 text-right text-[10px] text-muted">15:30</span>
      <span className="num w-9 text-right text-[10px] text-text">{Math.round(progress * 100)}%</span>
    </div>
  );
}
