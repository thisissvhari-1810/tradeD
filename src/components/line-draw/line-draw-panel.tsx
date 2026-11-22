"use client";

import { useState } from "react";
import { ArrowLeft, Copy, Plus, Trash2, X } from "lucide-react";
import { cx } from "@/components/ui";
import { Color, Dash, Row, Switch, Width } from "@/components/strategy-panel";
import {
  appliesTo,
  formatLevel,
  LEVEL_KINDS,
  LEVELS,
  levelValue,
  MAX_LINE_DRAWINGS,
  MAX_LINES_PER_DRAWING,
  newLine,
  TEMPLATES,
  type LevelKind,
  type LevelLine,
  type LineDrawing,
  type LineExtend,
} from "@/lib/chart/line-drawings";
import { CHART_SPANS, SPAN_LABEL } from "@/lib/market/spans";
import type { LineDrawingAction } from "@/server/chart-lines";
import type { S1Data } from "@/lib/trading/s1";

const EXTENDS: Array<{ id: LineExtend; label: string }> = [
  { id: "right", label: "Extend right" },
  { id: "session", label: "Session only" },
  { id: "full", label: "Across chart" },
];
const COMMON_SYMBOLS = ["NIFTY", "BANKNIFTY"];

/**
 * Line Strategy Draw panel: the list of saved drawings (each with its own visibility switch) and an editor for one
 * drawing at a time. It only manages drawings; it never turns the Strategy or any algo on or off.
 */
export function LineDrawPanel({ drawings, run, busy, error, onClose, left = null, symbol, span, data, cursor, dataNote, onPreview }: {
  drawings: LineDrawing[];
  run: (action: LineDrawingAction) => Promise<boolean>;
  busy: boolean;
  error: string;
  onClose: () => void;
  /** Left edge within the chart area, to sit below the button (null = top right). */
  left?: number | null;
  /** The chart's symbol and timeframe (defaults for a new drawing; which drawings are shown here). */
  symbol: string;
  span: string;
  /** The session's levels (for the price shown beside each line), and the replay clock. */
  data: S1Data | null;
  cursor: number | null;
  dataNote: string;
  /** The drawing being edited (shown on the chart as a preview) or null. */
  onPreview: (draft: LineDrawing | null) => void;
}) {
  const [draft, setDraft] = useState<LineDrawing | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [localError, setLocalError] = useState("");

  function edit(next: LineDrawing | null) {
    setDraft(next);
    setLocalError("");
    onPreview(next);
  }

  function startNew(templateId: string) {
    const template = TEMPLATES.find((item) => item.id === templateId) ?? TEMPLATES[0];
    const now = new Date().toISOString();
    edit({ id: "new", name: template.name, symbol: symbol || "*", timeframe: "all", enabled: true, config: { lines: template.kinds.map((kind) => newLine(kind)) }, createdAt: now, updatedAt: now });
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { setLocalError("Give the drawing a name."); return; }
    const bad = draft.config.lines.find((line) => line.kind === "custom" && !(line.price && line.price > 0));
    if (bad) { setLocalError(`Enter a price for "${bad.name}".`); return; }
    const body = { name: draft.name, symbol: draft.symbol, timeframe: draft.timeframe, enabled: draft.enabled, config: draft.config };
    const ok = await run(draft.id === "new" ? { action: "create", ...body } : { action: "update", id: draft.id, ...body });
    if (ok) edit(null);
  }

  const shown = drawings;
  const onChart = drawings.filter((item) => item.enabled && appliesTo(item, symbol, span)).length;

  return (
    <section
      style={left != null ? { left } : undefined}
      className={cx("surface-overlay absolute top-2 z-40 flex max-h-[calc(100%-1rem)] w-[min(21.25rem,calc(100%-1rem))] flex-col overflow-hidden rounded-lg text-data", left == null && "right-2")}
      aria-label="Line Strategy Draw"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        {draft ? (
          <button type="button" aria-label="Back to the list" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text" onClick={() => edit(null)}><ArrowLeft className="h-4 w-4" aria-hidden /></button>
        ) : null}
        <h2 className="flex-1 truncate text-dense font-semibold">{draft ? (draft.id === "new" ? "New drawing" : "Edit drawing") : "Line Strategy Draw"}</h2>
        {!draft ? <span className="num text-micro text-muted" title="Drawings shown on this chart">{onChart} on chart</span> : null}
        <button type="button" aria-label="Close Line Strategy Draw" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text" onClick={() => { edit(null); onClose(); }}><X className="h-4 w-4" aria-hidden /></button>
      </header>

      {error || localError ? <p className="border-b border-loss/25 bg-loss-soft px-3 py-1.5 text-micro text-loss" role="alert">{localError || error}</p> : null}

      {draft ? (
        <Editor draft={draft} onChange={(next) => { setDraft(next); onPreview(next); }} symbol={symbol} data={data} cursor={cursor} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            <label className="relative inline-flex">
              <span className="sr-only">Create a new drawing</span>
              <select
                className="compact-field h-7 pr-6 font-semibold"
                value=""
                disabled={drawings.length >= MAX_LINE_DRAWINGS}
                onChange={(event) => { if (event.target.value) startNew(event.target.value); }}
                aria-label="Create a new drawing"
              >
                <option value="">+ New drawing…</option>
                {TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <button type="button" className="h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-text disabled:opacity-40" disabled={busy || !drawings.length} onClick={() => void run({ action: "set-all", enabled: true })}>Show all</button>
            <button type="button" className="h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-text disabled:opacity-40" disabled={busy || !drawings.length} onClick={() => void run({ action: "set-all", enabled: false })}>Hide all</button>
          </div>
          {dataNote ? <p className="border-b border-border px-3 py-1.5 text-micro text-muted">{dataNote}</p> : null}
          {shown.length === 0 ? (
            <p className="px-3 py-6 text-center text-muted">No saved drawings yet. Use <span className="font-semibold text-text-2">+ New drawing</span> to save a set of levels for this chart.</p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {shown.map((item) => {
                const here = appliesTo(item, symbol, span);
                return (
                  <li key={item.id} className="flex items-center gap-2 px-3 py-2">
                    <Switch label={`Show ${item.name}`} checked={item.enabled} disabled={busy} onChange={(enabled) => void run({ action: "update", id: item.id, enabled })} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => edit(structuredClone(item))} title="Edit this drawing">
                      <span className="flex items-center gap-1.5">
                        <span className="flex shrink-0 gap-0.5" aria-hidden>{item.config.lines.slice(0, 4).map((line) => <span key={line.id} className="h-2.5 w-1 rounded-full" style={{ background: line.color }} />)}</span>
                        <span className={cx("truncate font-medium", item.enabled ? "text-text" : "text-muted")}>{item.name}</span>
                      </span>
                      <span className="block truncate text-micro text-muted">
                        {item.symbol === "*" ? "All symbols" : item.symbol} · {item.timeframe === "all" ? "All timeframes" : SPAN_LABEL[item.timeframe]} · {item.config.lines.length} line{item.config.lines.length === 1 ? "" : "s"}
                        {item.enabled && !here ? " · not on this chart" : ""}
                      </span>
                    </button>
                    {confirmDelete === item.id ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <button type="button" className="h-7 rounded-md bg-loss px-2 text-micro font-semibold text-white disabled:opacity-40" disabled={busy} onClick={() => { setConfirmDelete(null); void run({ action: "delete", id: item.id }); }}>Delete</button>
                        <button type="button" className="h-7 rounded-md px-2 text-micro text-muted hover:bg-hover" onClick={() => setConfirmDelete(null)}>Keep</button>
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center">
                        <button type="button" aria-label={`Duplicate ${item.name}`} title="Duplicate" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text disabled:opacity-40" disabled={busy || drawings.length >= MAX_LINE_DRAWINGS} onClick={() => void run({ action: "duplicate", id: item.id })}><Copy className="h-3.5 w-3.5" aria-hidden /></button>
                        <button type="button" aria-label={`Delete ${item.name}`} title="Delete" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-loss" onClick={() => setConfirmDelete(item.id)}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {draft ? (
        <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="text-micro text-muted">Preview on the chart</span>
          <button type="button" className="ml-auto h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-text" onClick={() => edit(null)}>Cancel</button>
          <button type="button" className="h-7 rounded-md bg-primary px-3 font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </footer>
      ) : null}
    </section>
  );
}

function Editor({ draft, onChange, symbol, data, cursor }: { draft: LineDrawing; onChange: (next: LineDrawing) => void; symbol: string; data: S1Data | null; cursor: number | null }) {
  const set = (patch: Partial<LineDrawing>) => onChange({ ...draft, ...patch });
  const setLines = (lines: LevelLine[]) => set({ config: { lines } });
  const symbols = [...new Set(["*", symbol.toUpperCase(), ...COMMON_SYMBOLS, draft.symbol].filter(Boolean))];
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-3 py-2.5">
      <label className="flex flex-col gap-1 font-medium text-text-2">Name
        <input className="compact-field h-8" maxLength={60} value={draft.name} onChange={(event) => set({ name: event.target.value })} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 font-medium text-text-2">Instrument
          <select className="compact-field h-8" value={draft.symbol} onChange={(event) => set({ symbol: event.target.value })}>
            {symbols.map((item) => <option key={item} value={item}>{item === "*" ? "All symbols" : item}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium text-text-2">Timeframe
          <select className="compact-field h-8" value={draft.timeframe} onChange={(event) => set({ timeframe: event.target.value as LineDrawing["timeframe"] })}>
            <option value="all">All timeframes</option>
            {CHART_SPANS.map((item) => <option key={item} value={item}>{SPAN_LABEL[item]}</option>)}
          </select>
        </label>
      </div>
      <Row label="Show on chart"><Switch label={`Show ${draft.name}`} checked={draft.enabled} onChange={(enabled) => set({ enabled })} /></Row>

      <p className="pt-1 text-micro font-semibold uppercase tracking-wide text-muted">Lines</p>
      {draft.config.lines.length === 0 ? <p className="text-micro text-muted">No lines yet. Add a level below.</p> : null}
      <div className="divide-y divide-border-soft rounded-md border border-border">
        {draft.config.lines.map((line, index) => {
          const value = levelValue(line, data, cursor);
          const update = (patch: Partial<LevelLine>) => setLines(draft.config.lines.map((item, at) => (at === index ? { ...item, ...patch } : item)));
          return (
            <details key={line.id} className="px-2 py-1.5">
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <input type="checkbox" className="oc-check" aria-label={`Show ${line.name}`} checked={line.visible} onChange={(event) => update({ visible: event.target.checked })} onClick={(event) => event.stopPropagation()} />
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: line.color }} aria-hidden />
                <span className={cx("min-w-0 flex-1 truncate font-medium", line.visible ? "text-text-2" : "text-muted")}>{line.name}</span>
                <span className="num shrink-0 text-micro text-muted">{value ? formatLevel(value.value) : line.kind === "custom" ? "—" : "waiting"}</span>
              </summary>
              <div className="mt-2 grid gap-1.5">
                <Row label="Level">
                  <select className="compact-field w-[9.5rem] shrink-0" aria-label={`${line.name} level`} value={line.kind} onChange={(event) => { const kind = event.target.value as LevelKind; update({ kind, ...(kind === "custom" ? { price: value?.value ?? line.price ?? 0 } : { price: undefined }) }); }}>
                    {LEVEL_KINDS.map((kind) => <option key={kind} value={kind}>{LEVELS[kind].label}</option>)}
                  </select>
                </Row>
                <Row label="Name"><input className="compact-field w-[9.5rem] shrink-0" maxLength={40} aria-label="Line name" value={line.name} onChange={(event) => update({ name: event.target.value })} /></Row>
                {line.kind === "custom" ? (
                  <Row label="Price"><input className="compact-field num w-[9.5rem] shrink-0" type="number" inputMode="decimal" step="0.05" min="0" aria-label={`${line.name} price`} value={line.price || ""} onChange={(event) => update({ price: Number(event.target.value) })} /></Row>
                ) : null}
                <Row label="Colour"><Color label={`${line.name} colour`} value={line.color} onChange={(color) => update({ color })} /></Row>
                <Row label="Thickness"><Width label={`${line.name} thickness`} value={line.width} onChange={(width) => update({ width })} /></Row>
                <Row label="Style"><Dash label={`${line.name} style`} value={line.dash} onChange={(dash) => update({ dash })} /></Row>
                <Row label="Show name"><Switch label={`${line.name} name label`} checked={line.showName} onChange={(showName) => update({ showName })} /></Row>
                <Row label="Show price"><Switch label={`${line.name} price label`} checked={line.showPrice} onChange={(showPrice) => update({ showPrice })} /></Row>
                <Row label="Extend">
                  <select className="compact-field w-[9.5rem] shrink-0" aria-label={`${line.name} extension`} value={line.extend} onChange={(event) => update({ extend: event.target.value as LineExtend })}>
                    {EXTENDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </Row>
                <button type="button" className="mt-1 inline-flex h-7 items-center gap-1 self-start rounded-md px-2 text-micro text-muted hover:bg-hover hover:text-loss" onClick={() => setLines(draft.config.lines.filter((_, at) => at !== index))}><Trash2 className="h-3.5 w-3.5" aria-hidden />Remove line</button>
              </div>
            </details>
          );
        })}
      </div>
      <label className="flex items-center gap-2 text-text-2">
        <Plus className="h-3.5 w-3.5 text-muted" aria-hidden />
        <select
          className="compact-field h-8 flex-1"
          value=""
          disabled={draft.config.lines.length >= MAX_LINES_PER_DRAWING}
          aria-label="Add a line"
          onChange={(event) => { const kind = event.target.value as LevelKind; if (kind) setLines([...draft.config.lines, newLine(kind, kind === "custom" ? data?.previous?.close : undefined)]); }}
        >
          <option value="">Add a line…</option>
          {LEVEL_KINDS.map((kind) => <option key={kind} value={kind}>{LEVELS[kind].group} · {LEVELS[kind].label}</option>)}
        </select>
      </label>
    </div>
  );
}
