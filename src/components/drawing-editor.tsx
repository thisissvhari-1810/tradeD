"use client";

import { useEffect, useRef, useState } from "react";
import { CHART_SPANS, SPAN_LABEL, type ChartSpan } from "@/lib/market/spans";
import { ColorPicker } from "@/components/color-picker";
import { useDesk } from "@/components/shell";
import { rememberColor, toggleFavorite } from "@/lib/color/appearance";
import { FIB_CHANNEL_RATIOS, FIB_EXTENSION_RATIOS, FIB_FAN_RATIOS, FIB_RATIOS, FIB_TIME_RATIOS, fibLevelSet, GANN_RATIOS, RECTANGLE_CENTER, defaultTextStyle, duplicateDrawing, loadTemplates, moveDrawing, saveTemplates, type Drawing, type DrawingTemplate, type LineDash, type TextAlign, type TextValign } from "@/components/drawing-model";
import { toolLabel } from "@/components/drawing-tools";

const TABS = ["Style", "Text", "Coordinates", "Visibility"] as const;
const FILL_KINDS = new Set<Drawing["kind"]>(["rect", "ellipse", "circle"]);
const TEXT_KINDS = new Set<Drawing["kind"]>(["text", "note", "price", "callout", "marker"]);

export function DrawingProperties({ drawing, onChange, onClose }: { drawing: Drawing; onChange: (next: Drawing) => void; onClose: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Style");
  const [error, setError] = useState("");
  const text = drawing.textStyle ?? defaultTextStyle(drawing.color);
  const visibility = drawing.visibility ?? { mode: "all" as const, spans: [] };
  const hasFill = FILL_KINDS.has(drawing.kind);
  const textOnly = TEXT_KINDS.has(drawing.kind);
  const tabs = TABS;

  function patch(next: Partial<Drawing>) {
    setError("");
    onChange({ ...drawing, ...next, updatedAt: Date.now() });
  }

  function saveTemplate() {
    saveDrawingTemplate(drawing);
  }

  return (
    // Rendered inside the drawing overlay, which ignores the pointer outside drawing tools; the dialog must opt back in.
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" style={{ pointerEvents: "auto" }} onPointerDown={(event) => event.stopPropagation()}>
      <div className="surface-modal max-h-[86vh] w-full max-w-lg overflow-auto rounded-xl p-5" role="dialog" aria-modal="true" aria-label={`${labelFor(drawing.kind)} properties`}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-title font-semibold">{labelFor(drawing.kind)}</h2>
          <button type="button" className="h-8 rounded-md px-3 text-dense text-text-2 hover:bg-hover hover:text-text" onClick={onClose}>Close</button>
        </div>
        <div className="mt-3 flex gap-1 border-b border-border" role="tablist">
          {tabs.map((item) => (
            <button key={item} type="button" role="tab" aria-selected={tab === item} className={`-mb-px border-b-2 px-3 py-2 text-dense ${tab === item ? "border-primary font-semibold text-text" : "border-transparent text-muted hover:text-text"}`} onClick={() => setTab(item)}>{item}</button>
          ))}
        </div>
        {tab === "Style" ? (
          <div className="mt-3 grid gap-3 text-xs">
            <ColorField label={textOnly ? "Color" : hasFill ? "Border" : "Line"} value={drawing.color} opacity={textOnly ? undefined : drawing.borderOpacity ?? 1} onOpacity={textOnly ? undefined : (borderOpacity) => patch({ borderOpacity })} onChange={(color) => patch({ color })} />
            {hasFill ? (
              <>
                <ColorField label="Fill" value={drawing.fill || drawing.color} opacity={drawing.fillOpacity ?? 0.13} onOpacity={(fillOpacity) => patch({ fillOpacity })} onChange={(fill) => patch({ fill })} />
                <label className="grid gap-1">Fill transparency
                  <input type="range" min={0} max={100} value={Math.round((1 - (drawing.fillOpacity ?? 0.13)) * 100)} onChange={(event) => patch({ fillOpacity: 1 - Number(event.target.value) / 100 })} />
                </label>
              </>
            ) : null}
            {!textOnly ? (
              <>
                <label className="grid gap-1">{hasFill ? "Border opacity" : "Line opacity"}
                  <input type="range" min={0} max={100} value={Math.round((drawing.borderOpacity ?? 1) * 100)} onChange={(event) => patch({ borderOpacity: Number(event.target.value) / 100 })} />
                </label>
                <label className="flex items-center gap-2">Line thickness
                  <input className="w-20" type="number" min={1} max={8} step={1} value={drawing.width ?? 1.5} onChange={(event) => { const width = Number(event.target.value); if (Number.isFinite(width) && width >= 1 && width <= 8) patch({ width }); }} />
                </label>
                <label>Line style
                  <select className="ml-2 py-1" value={drawing.dash ?? "solid"} onChange={(event) => patch({ dash: event.target.value as LineDash })}>
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                    <option value="dotted">Dotted</option>
                  </select>
                </label>
              </>
            ) : null}
            {hasFill ? (
              <>
                <label className="flex items-center gap-2"><input type="checkbox" checked={drawing.borderVisible !== false} onChange={(event) => patch({ borderVisible: event.target.checked })} />Border visible</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={drawing.fillVisible !== false} onChange={(event) => patch({ fillVisible: event.target.checked })} />Fill visible</label>
              </>
            ) : null}
            {drawing.kind === "rect" ? (
              <fieldset className="grid gap-2 rounded-xl border border-border p-2">
                <legend>Center line</legend>
                <label className="flex items-center gap-2"><input type="checkbox" checked={(drawing.center ?? RECTANGLE_CENTER).visible} onChange={(event) => patch({ center: { ...(drawing.center ?? RECTANGLE_CENTER), visible: event.target.checked } })} />Show center line</label>
                <ColorField label="Center color" value={(drawing.center ?? RECTANGLE_CENTER).color} onChange={(color) => patch({ center: { ...(drawing.center ?? RECTANGLE_CENTER), color } })} />
                <label className="flex items-center gap-2">Thickness
                  <input className="w-20" type="number" min={1} max={6} value={(drawing.center ?? RECTANGLE_CENTER).width} onChange={(event) => patch({ center: { ...(drawing.center ?? RECTANGLE_CENTER), width: Number(event.target.value) } })} />
                </label>
                <label>Dash
                  <select className="ml-2 py-1" value={(drawing.center ?? RECTANGLE_CENTER).dash} onChange={(event) => patch({ center: { ...(drawing.center ?? RECTANGLE_CENTER), dash: event.target.value as LineDash } })}>
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                    <option value="dotted">Dotted</option>
                  </select>
                </label>
              </fieldset>
            ) : null}
            {drawing.kind === "fib" || drawing.kind === "fibext" ? (
              <FibLevelsEditor drawing={drawing} patch={patch} />
            ) : fibRatios(drawing.kind) ? (
              <fieldset className="grid gap-2 rounded-xl border border-border p-2">
                <legend>Level colours</legend>
                {fibRatios(drawing.kind)?.map((ratio, index) => (
                  <ColorField key={ratio} label={`${ratio}`} value={drawing.levelColors?.[index] || drawing.color} onChange={(color) => {
                    const ratios = fibRatios(drawing.kind) ?? [];
                    const levelColors = ratios.map((_, item) => drawing.levelColors?.[item] || drawing.color);
                    levelColors[index] = color;
                    patch({ levelColors });
                  }} />
                ))}
              </fieldset>
            ) : null}
            <button type="button" className="w-fit rounded-lg border border-border px-3 py-1.5" onClick={saveTemplate}>Save as default style</button>
          </div>
        ) : null}
        {tab === "Text" ? (
          <div className="mt-3 grid gap-3 text-xs">
            <label className="grid gap-1">Text
              <textarea className="min-h-16" value={drawing.text ?? ""} onChange={(event) => patch({ text: event.target.value })} />
            </label>
            <label className="flex items-center gap-2">Font size
              <input className="w-20" type="number" min={8} max={32} value={text.size} onChange={(event) => patch({ textStyle: { ...text, size: Number(event.target.value) } })} />
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={text.bold} onChange={(event) => patch({ textStyle: { ...text, bold: event.target.checked } })} />Bold</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={text.italic} onChange={(event) => patch({ textStyle: { ...text, italic: event.target.checked } })} />Italic</label>
            <ColorField label="Text color" value={textOnly ? drawing.color : text.color} onChange={(color) => patch(textOnly ? { color } : { textStyle: { ...text, color } })} />
            {!textOnly && (drawing.kind === "rect" || drawing.kind === "ellipse") ? (
              <>
                <label>Horizontal
                  <select className="ml-2 py-1" value={text.align} onChange={(event) => patch({ textStyle: { ...text, align: event.target.value as TextAlign } })}>
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </label>
                <label>Vertical
                  <select className="ml-2 py-1" value={text.valign} onChange={(event) => patch({ textStyle: { ...text, valign: event.target.value as TextValign } })}>
                    <option value="top">Top</option>
                    <option value="middle">Middle</option>
                    <option value="bottom">Bottom</option>
                  </select>
                </label>
              </>
            ) : null}
            {!textOnly ? <label className="flex items-center gap-2"><input type="checkbox" checked={text.visible} onChange={(event) => patch({ textStyle: { ...text, visible: event.target.checked } })} />Text visible</label> : null}
          </div>
        ) : null}
        {tab === "Coordinates" ? (
          <div className="mt-3 grid gap-3 text-xs">
            {drawing.points.map((point, index) => (
              <fieldset key={index} className="grid gap-2 rounded-xl border border-border p-2">
                <legend>{drawing.kind === "long" || drawing.kind === "short" ? (["Entry (left edge)", "Stop", "Target (right edge)"][index] ?? `Anchor ${index + 1}`) : `Anchor ${index + 1}`}</legend>
                <label className="grid gap-1">Time, exchange local
                  <input type="datetime-local" value={toDatetimeLocal(point.time)} onChange={(event) => {
                    const time = fromDatetimeLocal(event.target.value);
                    if (time == null) { setError("Enter a valid date and time."); return; }
                    const points = drawing.points.slice();
                    points[index] = { ...point, time };
                    patch({ points });
                  }} />
                </label>
                <label className="grid gap-1">Price
                  <input type="number" step="0.01" value={point.price} onChange={(event) => {
                    const price = Number(event.target.value);
                    if (!Number.isFinite(price)) { setError("Price must be a number."); return; }
                    const points = drawing.points.slice();
                    points[index] = { ...point, price };
                    patch({ points });
                  }} />
                </label>
              </fieldset>
            ))}
            {error ? <p className="text-loss">{error}</p> : null}
          </div>
        ) : null}
        {tab === "Visibility" ? (
          <div className="mt-3 grid gap-2 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={drawing.locked} onChange={(event) => patch({ locked: event.target.checked })} />Locked</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!drawing.hidden} onChange={(event) => patch({ hidden: !event.target.checked })} />Visible</label>
            <span aria-hidden className="my-1 h-px bg-border" />
            <label className="flex items-center gap-2"><input type="radio" name="visibility" checked={visibility.mode === "all"} onChange={() => patch({ visibility: { mode: "all", spans: visibility.spans } })} />Show on all timeframes</label>
            <label className="flex items-center gap-2"><input type="radio" name="visibility" checked={visibility.mode === "only"} onChange={() => patch({ visibility: { mode: "only", spans: visibility.spans } })} />Show only on selected timeframes</label>
            <label className="flex items-center gap-2"><input type="radio" name="visibility" checked={visibility.mode === "hide"} onChange={() => patch({ visibility: { mode: "hide", spans: visibility.spans } })} />Hide on selected timeframes</label>
            <div className="flex flex-wrap gap-2">
              {CHART_SPANS.map((span) => (
                <label key={span} className="flex items-center gap-1"><input type="checkbox" checked={visibility.spans.includes(span)} onChange={() => patch({ visibility: { ...visibility, spans: toggleSpan(visibility.spans, span) } })} />{SPAN_LABEL[span]}</label>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DrawingList({
  drawings,
  selectedId,
  onSelect,
  onChange,
  lockAll = false,
  onClearAll,
}: {
  drawings: Drawing[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: Drawing[], record?: boolean) => void;
  lockAll?: boolean;
  onClearAll?: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Keep the row of the drawing selected on the chart in view.
  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector(`[data-row="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);
  if (!drawings.length) return <p className="p-3 text-xs text-muted">No drawings on this chart.</p>;
  const update = (id: string, change: Partial<Drawing>) => onChange(drawings.map((item) => item.id === id ? { ...item, ...change, updatedAt: Date.now() } : item), true);
  return (
    <div className="text-xs">
      <ul ref={listRef} className="max-h-72 overflow-auto p-1">
        {drawings.map((drawing) => {
          const locked = drawing.locked || lockAll;
          return (
            <li key={drawing.id} data-row={drawing.id} className={`flex items-center gap-1 rounded-lg px-1 py-1 ${selectedId === drawing.id ? "bg-primary/15" : ""} ${drawing.hidden ? "opacity-60" : ""}`}>
              {renaming === drawing.id ? (
                <input
                  autoFocus
                  className="h-6 min-w-0 flex-1 px-1.5 py-0 text-xs"
                  defaultValue={drawing.name || labelFor(drawing.kind)}
                  aria-label="Drawing name"
                  maxLength={60}
                  onBlur={(event) => { update(drawing.id, { name: event.target.value.trim() || undefined }); setRenaming(null); }}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setRenaming(null); }}
                />
              ) : (
                <button type="button" className="min-w-0 flex-1 truncate text-left" title="Select. Double-click to rename." onClick={() => onSelect(drawing.hidden ? null : drawing.id)} onDoubleClick={() => setRenaming(drawing.id)}>{drawing.name || labelFor(drawing.kind)}</button>
              )}
              <button type="button" title={drawing.hidden ? "Show" : "Hide"} className="px-1 text-muted hover:text-text" onClick={() => update(drawing.id, { hidden: !drawing.hidden })}>{drawing.hidden ? "Show" : "Hide"}</button>
              <button type="button" title={lockAll ? "All drawings are locked" : drawing.locked ? "Unlock" : "Lock"} disabled={lockAll} className="px-1 text-muted hover:text-text disabled:opacity-40" onClick={() => update(drawing.id, { locked: !drawing.locked })}>{drawing.locked ? "Unlock" : "Lock"}</button>
              <button type="button" title="Duplicate" className="px-1 text-muted hover:text-text" onClick={() => onChange(applyListAction(drawings, drawing.id, "duplicate"), true)}>Copy</button>
              <button type="button" title={locked ? "Unlock to delete" : "Delete"} disabled={locked} className="px-1 text-loss disabled:opacity-40" onClick={() => onChange(drawings.filter((item) => item.id !== drawing.id), true)}>Delete</button>
            </li>
          );
        })}
      </ul>
      {onClearAll ? (
        <div className="flex justify-end border-t border-border px-2 py-1.5">
          <button type="button" className="rounded px-2 py-1 text-loss hover:bg-loss/10 disabled:opacity-40" disabled={lockAll} onClick={onClearAll}>Remove all…</button>
        </div>
      ) : null}
    </div>
  );
}

export function labelFor(kind: Drawing["kind"]) {
  return toolLabel(kind);
}

export function saveDrawingTemplate(drawing: Drawing) {
  const templates = loadTemplates().map((template) => template.kind === drawing.kind ? { ...template, preferred: false } : template);
  const saved: DrawingTemplate = {
    id: crypto.randomUUID(),
    name: `${labelFor(drawing.kind)} default`,
    kind: drawing.kind,
    preferred: true,
    color: drawing.color,
    fill: drawing.fill || drawing.color,
    fillOpacity: drawing.fillOpacity ?? 0.13,
    width: drawing.width ?? 1.5,
    dash: drawing.dash ?? "solid",
    borderVisible: drawing.borderVisible !== false,
    fillVisible: drawing.fillVisible !== false,
    center: drawing.kind === "rect" ? (drawing.center ?? RECTANGLE_CENTER) : undefined,
  };
  saveTemplates([...templates, saved]);
}

export function applyListAction(drawings: Drawing[], id: string, action: "duplicate" | "forward" | "backward" | "hide" | "lock") {
  const drawing = drawings.find((item) => item.id === id);
  if (!drawing) return drawings;
  if (action === "duplicate") return [...drawings, duplicateDrawing(drawing, crypto.randomUUID())];
  if (action === "forward" || action === "backward") return moveDrawing(drawings, id, action);
  if (action === "hide") return drawings.map((item) => item.id === id ? { ...item, hidden: !item.hidden } : item);
  return drawings.map((item) => item.id === id ? { ...item, locked: !item.locked } : item);
}

function ColorField({ label, value, onChange, opacity, onOpacity }: { label: string; value: string; onChange: (color: string) => void; opacity?: number; onOpacity?: (value: number) => void }) {
  const desk = useDesk();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <div className="relative">
      <button type="button" className="flex items-center gap-2" onClick={() => { setDraft(value); setOpen((current) => !current); }}>
        <span className="h-4 w-4 rounded border border-border" style={{ background: value }} />
        {label}
        <span className="font-mono text-[10px] text-muted">{value}</span>
      </button>
      {open ? (
        <div className="relative z-10 mt-1">
          <ColorPicker value={draft} recent={desk.appearance.recent} favorites={desk.appearance.favorites} opacity={opacity} onOpacity={onOpacity} onPreview={setDraft} onApply={(hex) => { onChange(hex); desk.setAppearance(rememberColor(desk.appearance, hex)); setOpen(false); }} onCancel={() => setOpen(false)} onReset={() => { setDraft(value); onChange(value); }} onToggleFavorite={(hex) => desk.setAppearance(toggleFavorite(desk.appearance, hex))} />
        </div>
      ) : null}
    </div>
  );
}

/** Show / hide, edit, add and remove Fibonacci levels. Colours stay paired with their row. */
function FibLevelsEditor({ drawing, patch }: { drawing: Drawing; patch: (next: Partial<Drawing>) => void }) {
  const levels = fibLevelSet(drawing);
  const colors = levels.map((_, index) => drawing.levelColors?.[index] || drawing.color);
  const save = (next: typeof levels, nextColors = colors) => patch({ levels: next, levelColors: nextColors });
  return (
    <fieldset className="grid gap-1.5 rounded-xl border border-border p-2">
      <legend>Levels</legend>
      {levels.map((level, index) => (
        <div key={index} className="flex items-center gap-2">
          <input type="checkbox" className="oc-check" checked={level.visible} aria-label={`Show level ${level.ratio}`} onChange={(event) => save(levels.map((item, at) => at === index ? { ...item, visible: event.target.checked } : item))} />
          <input type="number" step="0.001" min={-10} max={10} className="w-24 py-1" value={level.ratio} aria-label="Level value" onChange={(event) => {
            const ratio = Number(event.target.value);
            if (Number.isFinite(ratio)) save(levels.map((item, at) => at === index ? { ...item, ratio: Math.max(-10, Math.min(10, ratio)) } : item));
          }} />
          <span className="min-w-0 flex-1"><ColorField label="" value={colors[index]} onChange={(color) => save(levels, colors.map((item, at) => at === index ? color : item))} /></span>
          <button type="button" className="rounded px-1.5 text-muted hover:text-loss disabled:opacity-40" disabled={levels.length <= 1} aria-label={`Remove level ${level.ratio}`} onClick={() => save(levels.filter((_, at) => at !== index), colors.filter((_, at) => at !== index))}>✕</button>
        </div>
      ))}
      <div className="mt-1 flex gap-2">
        <button type="button" className="rounded-lg border border-border px-2.5 py-1 disabled:opacity-40" disabled={levels.length >= 16} onClick={() => save([...levels, { ratio: 1.618, visible: true }], [...colors, drawing.color])}>Add level</button>
        <button type="button" className="rounded-lg border border-border px-2.5 py-1" onClick={() => patch({ levels: undefined, levelColors: undefined })}>Reset to defaults</button>
      </div>
    </fieldset>
  );
}

function fibRatios(kind: Drawing["kind"]) {
  if (kind === "fib") return FIB_RATIOS;
  if (kind === "fibext") return FIB_EXTENSION_RATIOS;
  if (kind === "fibtime") return FIB_TIME_RATIOS;
  if (kind === "fibfan") return FIB_FAN_RATIOS;
  if (kind === "fibchannel") return FIB_CHANNEL_RATIOS;
  if (kind === "gannbox") return GANN_RATIOS;
  return null;
}

function toggleSpan(spans: string[], span: ChartSpan) {
  return spans.includes(span) ? spans.filter((item) => item !== span) : [...spans, span];
}

function toDatetimeLocal(unix: number) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(unix * 1000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function fromDatetimeLocal(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) - 19_800_000;
  return Math.floor(utc / 1000);
}
