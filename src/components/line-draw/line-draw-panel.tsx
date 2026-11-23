"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cx } from "@/components/ui";
import { Color, DateRow, Dash, dayBefore, Row, Switch, Width } from "@/components/strategy-panel";
import {
  appliesTo,
  defaultConfig,
  formatLevel,
  LEVELS,
  LINE_STRATEGIES,
  marksEntry,
  resolveLevels,
  type LevelLine,
  type LineDay,
  type LineDrawing,
  type LineDrawingConfig,
  type LineExtend,
  type LineStrategyId,
} from "@/lib/chart/line-drawings";
import { entryAt, entryText, sessionEntry } from "@/lib/chart/line-entries";
import type { LineDrawingAction } from "@/server/chart-lines";

const EXTENDS: Array<{ id: LineExtend; label: string }> = [
  { id: "right", label: "Extend right" },
  { id: "session", label: "Session only" },
  { id: "full", label: "Across chart" },
];

export type DayInfo = { day: LineDay | null; cursor: number | null; now: number; error: string };

/**
 * Line Strategy Draw panel: every one of our strategies with its own on / off switch. A strategy that is on asks for
 * its current day and previous day (or Auto) and lists its lines. Changes are saved for the user (debounced while
 * editing). It only draws lines: it never turns the Strategy, an algo or any order on or off.
 */
export function LineDrawPanel({ drawings, run, patch, busy, error, onClose, left = null, symbol, span, dataNote, today, replayDate, dayInfo }: {
  drawings: LineDrawing[];
  run: (action: LineDrawingAction) => Promise<boolean>;
  patch: (id: string, change: Partial<LineDrawing>) => void;
  busy: boolean;
  error: string;
  onClose: () => void;
  /** Left edge within the chart area, to sit below the button (null = top right). */
  left?: number | null;
  symbol: string;
  span: string;
  dataNote: string;
  /** Today (IST) and the replayed date, for the date pickers' Auto values and limits. */
  today: string;
  replayDate: string | null;
  dayInfo: (drawing: LineDrawing) => DayInfo;
}) {
  const timers = useRef(new Map<string, { timer: number; save: () => void }>());
  const [open, setOpen] = useState<LineStrategyId | null>(null);

  // Saves anything still waiting when the panel closes.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const item of pending.values()) {
        window.clearTimeout(item.timer);
        item.save();
      }
      pending.clear();
    };
  }, []);

  const rowFor = (id: LineStrategyId) => drawings.find((item) => item.config.strategy === id) ?? null;

  function toggle(id: LineStrategyId, name: string, on: boolean) {
    const row = rowFor(id);
    if (on) setOpen(id);
    if (row) void run({ action: "update", id: row.id, enabled: on });
    else if (on) void run({ action: "create", name, symbol: "*", timeframe: "all", enabled: true, config: defaultConfig(id) });
  }

  function change(row: LineDrawing, config: LineDrawingConfig) {
    patch(row.id, { config });
    const pending = timers.current.get(row.id);
    if (pending) window.clearTimeout(pending.timer);
    const save = () => {
      timers.current.delete(row.id);
      void run({ action: "update", id: row.id, config });
    };
    timers.current.set(row.id, { timer: window.setTimeout(save, 600), save });
  }

  const onChart = drawings.filter((item) => item.config.strategy && item.enabled && appliesTo(item, symbol, span)).length;

  return (
    <section
      style={left != null ? { left } : undefined}
      className={cx("surface-overlay absolute top-2 z-40 flex max-h-[calc(100%-1rem)] w-[min(22.5rem,calc(100%-1rem))] flex-col overflow-hidden rounded-lg text-data", left == null && "right-2")}
      aria-label="Line Strategy Draw"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 truncate text-dense font-semibold">Line Strategy Draw</h2>
        <span className="num text-micro text-muted" title="Strategies drawn on this chart">{onChart} on chart</span>
        <button type="button" aria-label="Close Line Strategy Draw" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text" onClick={onClose}><X className="h-4 w-4" aria-hidden /></button>
      </header>

      {error ? <p className="border-b border-loss/25 bg-loss-soft px-3 py-1.5 text-micro text-loss" role="alert">{error}</p> : null}
      {dataNote ? <p className="border-b border-border px-3 py-1.5 text-micro text-muted">{dataNote}</p> : null}

      <ul className="min-h-0 flex-1 divide-y divide-border-soft overflow-y-auto overflow-x-hidden">
        {LINE_STRATEGIES.map((def) => {
          const row = rowFor(def.id);
          const on = Boolean(row?.enabled);
          const expanded = on && open === def.id;
          return (
            <li key={def.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <Switch label={`Show ${def.name}`} checked={on} disabled={busy && !row} onChange={(value) => toggle(def.id, def.name, value)} />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                  disabled={!on}
                  aria-expanded={on ? expanded : undefined}
                  onClick={() => setOpen(expanded ? null : def.id)}
                  title={on ? "Dates and lines" : undefined}
                >
                  <span className={cx("block truncate font-semibold", on ? "text-text" : "text-text-2")}>{def.name}</span>
                  <span className="block truncate text-micro text-muted">{def.about}</span>
                </button>
                {on ? <span className="text-micro text-muted" aria-hidden>{expanded ? "▾" : "▸"}</span> : null}
              </div>
              {expanded && row ? <StrategyBody row={row} info={dayInfo(row)} today={today} replayDate={replayDate} onChange={(config) => change(row, config)} /> : null}
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-3 py-1.5 text-micro text-muted">Lines and entry points only: switching a strategy here never starts or stops its algo or places an order.</p>
    </section>
  );
}

function StrategyBody({ row, info, today, replayDate, onChange }: { row: LineDrawing; info: DayInfo; today: string; replayDate: string | null; onChange: (config: LineDrawingConfig) => void }) {
  const config = row.config;
  const set = (patch: Partial<LineDrawingConfig>) => onChange({ ...config, ...patch });
  const setLine = (index: number, patch: Partial<LevelLine>) => set({ lines: config.lines.map((line, at) => (at === index ? { ...line, ...patch } : line)) });
  const data = info.day?.data ?? null;
  const autoCurrent = replayDate || data?.date || today;
  const values = resolveLevels(info.day, info.cursor, info.now);
  const note = info.error || (data && data.status !== "ready" && data.message ? data.message : "");
  const waiting = (line: LevelLine) => (info.day ? (LEVELS[line.kind].needs === "tape" ? "not yet" : "waiting") : "loading");

  return (
    <div className="mt-2 space-y-2">
      <div>
        <p className="eyebrow mb-1">Dates</p>
        <div className="grid gap-1.5 rounded-md border border-border-soft bg-sunken/50 p-2">
          <DateRow
            label="Current day"
            hint="Open, 9:15 and intraday candles"
            value={config.currentDay}
            auto={autoCurrent}
            max={today}
            onChange={(currentDay) => set({ currentDay, previousDay: config.previousDay && currentDay && config.previousDay >= currentDay ? "" : config.previousDay })}
          />
          <DateRow
            label="Previous day"
            hint="Previous high, low and close"
            value={config.previousDay}
            auto={data?.previous?.date ?? ""}
            max={dayBefore(config.currentDay || autoCurrent)}
            onChange={(previousDay) => set({ previousDay })}
          />
        </div>
      </div>
      {data?.previous ? (
        <p className="num text-micro text-muted">
          Previous {data.previous.date}: H {formatLevel(data.previous.high)} L {formatLevel(data.previous.low)} C {formatLevel(data.previous.close)}
          {data.open != null ? ` · ${data.date} open ${formatLevel(data.open)}` : ""}
        </p>
      ) : null}
      {note ? <p className="text-micro text-warning">{note}</p> : null}

      <EntrySection row={row} info={info} onShow={(entry) => set({ entry })} />

      <div>
        <p className="eyebrow mb-1">Lines</p>
        <div className="divide-y divide-border-soft rounded-md border border-border">
          {config.lines.map((line, index) => {
            const value = values[line.kind];
            return (
              <details key={line.id} className="px-2 py-1.5">
                <summary className="flex cursor-pointer list-none items-center gap-2">
                  <input type="checkbox" className="oc-check" aria-label={`Show ${line.name}`} checked={line.visible} onChange={(event) => setLine(index, { visible: event.target.checked })} onClick={(event) => event.stopPropagation()} />
                  <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: line.color }} aria-hidden />
                  <span className={cx("min-w-0 flex-1 truncate font-medium", line.visible ? "text-text-2" : "text-muted")} title={LEVELS[line.kind].label}>{line.name}</span>
                  <span className="num shrink-0 text-micro text-muted">{value ? (value.end ? `${formatLevel(value.value)} → ${formatLevel(value.end.price)}` : formatLevel(value.value)) : waiting(line)}</span>
                </summary>
                <div className="mt-2 grid gap-1.5">
                  <Row label="Name"><input className="compact-field w-[9.5rem] shrink-0" maxLength={40} aria-label="Line name" value={line.name} onChange={(event) => setLine(index, { name: event.target.value })} /></Row>
                  <Row label="Colour"><Color label={`${line.name} colour`} value={line.color} onChange={(color) => setLine(index, { color })} /></Row>
                  <Row label="Thickness"><Width label={`${line.name} thickness`} value={line.width} onChange={(width) => setLine(index, { width })} /></Row>
                  <Row label="Style"><Dash label={`${line.name} style`} value={line.dash} onChange={(dash) => setLine(index, { dash })} /></Row>
                  <Row label="Show name"><Switch label={`${line.name} name label`} checked={line.showName} onChange={(showName) => setLine(index, { showName })} /></Row>
                  <Row label="Show price"><Switch label={`${line.name} price label`} checked={line.showPrice} onChange={(showPrice) => setLine(index, { showPrice })} /></Row>
                  {line.kind === "ch_upper" || line.kind === "ch_lower" ? null : (
                    <Row label="Extend">
                      <select className="compact-field w-[9.5rem] shrink-0" aria-label={`${line.name} extension`} value={line.extend} onChange={(event) => setLine(index, { extend: event.target.value as LineExtend })}>
                        {EXTENDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                      </select>
                    </Row>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The strategy's entry point (trade 1) for the chosen day, as known at the replay clock / now, and its chart switch. */
function EntrySection({ row, info, onShow }: { row: LineDrawing; info: DayInfo; onShow: (entry: boolean) => void }) {
  const strategy = row.config.strategy;
  if (!strategy) return null;
  const result = entryAt(sessionEntry(strategy, info.day), info.cursor ?? info.now);
  const entry = result.entry;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <p className="eyebrow flex-1">Entry point</p>
        {marksEntry(strategy) ? <Switch label="Show the entry point on the chart" checked={row.config.entry} onChange={onShow} /> : null}
      </div>
      <div className="rounded-md border border-border-soft bg-sunken/50 px-2 py-1.5 text-micro">
        {entry ? (
          <>
            <p className={cx("num font-semibold", entry.option === "CE" ? "text-profit" : "text-loss")}>{entry.option === "CE" ? "▲" : "▼"} {entryText(entry)}</p>
            <p className="mt-0.5 text-muted">{entry.note}</p>
          </>
        ) : (
          <p className="text-muted">{result.status || result.watching || (info.day ? "No entry yet." : "Loading…")}</p>
        )}
        {marksEntry(strategy) ? <p className="mt-1 text-muted">Trade 1 only. A second trade depends on when trade 1 exits on the option.</p> : null}
      </div>
    </div>
  );
}
