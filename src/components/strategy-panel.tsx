"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { RotateCcw, X } from "lucide-react";
import { cx } from "@/components/ui";
import { AlgoPanel } from "@/components/algo/algo-panel";
import type { LineDash } from "@/components/drawing-model";
import { STRATEGY_DEFAULTS, setAllVisible, type StrategyBox, type StrategyLevel, type StrategyLine, type StrategySettings } from "@/components/strategy-settings";
import { price, type StrategyView } from "@/components/strategy-overlay";
import type { S1Data } from "@/lib/trading/s1";

const WIDTHS = [1, 2, 3, 4] as const;
/** Gap kept between the panel and the chart edges while dragging. */
const EDGE = 8;
const DASHES: Array<{ id: LineDash; label: string }> = [{ id: "solid", label: "Solid" }, { id: "dashed", label: "Dashed" }, { id: "dotted", label: "Dotted" }];

/**
 * The Strategy panel: on / off, which drawings show, the prices used and every drawing's style.
 * Changes apply to the chart at once and are saved; they never change a calculated price.
 */
export function StrategyPanel({ settings, onChange, data, view, loading, error, disabledReason, onClose, dates, onDates, today, autoCurrent, manualRectangles = 0, left = null, symbol = "" }: {
  settings: StrategySettings;
  onChange: (next: StrategySettings) => void;
  data: S1Data | null;
  view: StrategyView | null;
  loading: boolean;
  error: string;
  disabledReason: string;
  onClose: () => void;
  /** Left edge within the chart area, to sit below the Strategy button (null = top right). */
  left?: number | null;
  /** Chosen current / previous day ("" = automatic). */
  dates: { current: string; previous: string };
  onDates: (next: { current: string; previous: string }) => void;
  /** Today in IST, the latest selectable day. */
  today: string;
  /** The automatic current day: the replay date in replay, else today. */
  autoCurrent: string;
  /** Rectangles the user drew on this chart (saved, not part of the strategy). */
  manualRectangles?: number;
  /** The chart's symbol (offered as an Algo underlying). */
  symbol?: string;
}) {
  const set = (patch: Partial<StrategySettings>) => onChange({ ...settings, ...patch });
  // Dragged by its header, like the option chain. Each opening starts below the Strategy button again.
  const panelRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const [moved, setMoved] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<"levels" | "algo">("levels");
  // The Algo tab stays mounted once opened, so its checks keep running while Levels is shown.
  const [algoSeen, setAlgoSeen] = useState(false);
  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    const node = panelRef.current;
    if (!node || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a, label")) return;
    drag.current = { id: event.pointerId, dx: event.clientX - node.offsetLeft, dy: event.clientY - node.offsetTop };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  }
  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current;
    const node = panelRef.current;
    if (!state || state.id !== event.pointerId || !node) return;
    const parent = node.offsetParent as HTMLElement | null;
    const width = parent?.clientWidth ?? window.innerWidth;
    const height = parent?.clientHeight ?? window.innerHeight;
    setMoved({
      x: Math.round(Math.min(Math.max(EDGE, event.clientX - state.dx), Math.max(EDGE, width - node.offsetWidth - EDGE))),
      y: Math.round(Math.min(Math.max(EDGE, event.clientY - state.dy), Math.max(EDGE, height - 120))),
    });
  }
  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  }
  const position = moved ? { left: moved.x, top: moved.y, maxHeight: `calc(100% - ${moved.y + EDGE}px)` } : left == null ? undefined : { left };
  const status = disabledReason
    || (!settings.enabled ? "Turn the strategy on to calculate and draw it." : loading ? "Loading market data…" : error || (view?.failures.length ? `Not drawn: ${view.failures.join(" ")}` : data?.message ?? ""));
  const tone = disabledReason || error || view?.failures.length || data?.status === "unavailable" ? "text-loss" : data?.status === "ready" ? "text-profit" : "text-warning";

  return (
    <section
      ref={panelRef}
      style={position}
      className={cx("surface-overlay absolute top-2 z-40 flex max-h-[calc(100%-1rem)] w-[min(21.25rem,calc(100%-1rem))] flex-col overflow-hidden rounded-lg text-data", !moved && left == null && "right-2", dragging && "shadow-e4")}
      aria-label="Strategy"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header
        className={cx("flex cursor-grab touch-none select-none items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing", dragging && "bg-elevated/60")}
        title="Drag to move. Double-click to put it back below the Strategy button."
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button, input, label")) setMoved(null); }}
      >
        <h2 className="flex-1 text-dense font-semibold">Strategy</h2>
        <Switch label="Enable strategy" checked={settings.enabled} disabled={Boolean(disabledReason)} onChange={(enabled) => set({ enabled })} />
        <button type="button" aria-label="Close strategy panel" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text" onClick={onClose}><X className="h-4 w-4" aria-hidden /></button>
      </header>

      <div className="flex gap-1 border-b border-border px-3 pt-1.5" role="tablist" aria-label="Strategy sections">
        {(["levels", "algo"] as const).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={cx("-mb-px border-b-2 px-2 pb-1.5 font-medium", tab === key ? "border-primary text-text" : "border-transparent text-muted hover:text-text")} onClick={() => { setTab(key); if (key === "algo") setAlgoSeen(true); }}>
            {key === "levels" ? "Levels" : "Algo trade"}
          </button>
        ))}
      </div>

      {algoSeen ? (
        <div className={cx("min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2.5", tab !== "algo" && "hidden")} role="tabpanel" aria-label="Algo trade">
          <AlgoPanel chartSymbol={symbol} />
        </div>
      ) : null}

      <div className={cx("min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-3 py-2.5", tab !== "levels" && "hidden")} role="tabpanel" aria-label="Levels">
        {status ? <p className={cx("text-micro leading-snug", settings.enabled || disabledReason ? tone : "text-muted")} role="status">{status}</p> : null}
        {settings.enabled && manualRectangles > 0 ? (
          <p className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1.5 text-micro leading-snug text-warning">
            This chart also has {manualRectangles} rectangle{manualRectangles === 1 ? "" : "s"} you drew yourself. {manualRectangles === 1 ? "It is" : "They are"} saved with the chart, not part of the Strategy (which draws only boxes A and B). Remove them from the object tree if they are old reference drawings.
          </p>
        ) : null}

        <div>
          <p className="eyebrow mb-1">Dates</p>
          <div className="grid gap-1.5 rounded-md border border-border-soft bg-sunken/50 p-2">
            <DateRow
              label="Current day"
              hint="Open and 9:15 candle"
              value={dates.current}
              auto={autoCurrent}
              max={today}
              onChange={(current) => onDates({ current, previous: dates.previous && current && dates.previous >= current ? "" : dates.previous })}
            />
            <DateRow
              label="Previous day"
              hint="Range and close"
              value={dates.previous}
              auto={data?.previous?.date ?? ""}
              max={dayBefore(dates.current || autoCurrent)}
              onChange={(previous) => onDates({ ...dates, previous })}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Toggle label="Previous-day box" checked={settings.closeBox.visible} onChange={(visible) => set({ closeBox: { ...settings.closeBox, visible } })} swatch={settings.closeBox.border} />
          <Toggle label="Today's-open box" checked={settings.openBox.visible} onChange={(visible) => set({ openBox: { ...settings.openBox, visible } })} swatch={settings.openBox.border} />
          <Toggle label="9:15 High" checked={settings.high.visible} onChange={(visible) => set({ high: { ...settings.high, visible } })} swatch={settings.high.color} />
          <Toggle label="9:15 Low" checked={settings.low.visible} onChange={(visible) => set({ low: { ...settings.low, visible } })} swatch={settings.low.color} />
        </div>

        <div>
          <p className="eyebrow mb-1">Price information</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2">
            <Info label="Previous high" value={data?.previous?.high} />
            <Info label="Previous low" value={data?.previous?.low} />
            <Info label="Previous close" value={data?.previous?.close} />
            <Info label="Candle range" value={view?.levels?.range} />
            <Info label={data?.openSource === "daily" ? "Today's open (daily)" : data?.openSource === "09:15" ? "Today's open (09:15)" : "Today's open"} value={data?.open} />
            <Info label="9:15 high" value={data?.firstMinute?.high} />
            <Info label="9:15 low" value={data?.firstMinute?.low} />
            <Info label="Session" text={data ? `${data.date}${data.previous ? ` · prev ${data.previous.date}` : ""}` : "—"} />
          </dl>
        </div>

        {view?.trace ? (
          <details className="rounded-md border border-border-soft bg-sunken/50 px-2 py-1.5">
            <summary className="cursor-pointer list-none font-medium text-text-2 hover:text-text">Calculation (read from the drawn boxes)</summary>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
              <Info label="Original top / bottom" text={`${price(view.trace.original.top)} / ${price(view.trace.original.bottom)}`} />
              <Info label="Original mid" value={view.trace.original.mid} />
              <Info label="Move A by" text={signed(view.trace.shiftA)} />
              <Info label="A mid (= prev close)" value={view.trace.boxA.mid} />
              <Info label="A top / bottom" text={`${price(view.trace.boxA.top)} / ${price(view.trace.boxA.bottom)}`} />
              <Info label="A height" value={view.trace.boxA.height} />
              <Info label="Clone mid before move" value={view.trace.cloneMidBefore} />
              <Info label="Move B by" text={view.trace.shiftB == null ? "—" : signed(view.trace.shiftB)} />
              <Info label="B mid (= open)" value={view.trace.boxB?.mid} />
              <Info label="B top / bottom" text={view.trace.boxB ? `${price(view.trace.boxB.top)} / ${price(view.trace.boxB.bottom)}` : "—"} />
              <Info label="B height" value={view.trace.boxB?.height} />
              <Info label="Strategy boxes on chart" text={String(view.trace.rectangles)} />
            </dl>
          </details>
        ) : null}

        <div>
          <p className="eyebrow mb-1">Drawing settings</p>
          <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-muted">Box width</span>
            <select className="compact-field w-[9.5rem] shrink-0" aria-label="Box width" value={settings.boxSpan} onChange={(event) => set({ boxSpan: event.target.value === "session" ? "session" : "candles" })}>
              <option value="candles">Daily candles</option>
              <option value="session">Today&apos;s session</option>
            </select>
          </div>
          {settings.boxSpan === "candles" ? (
            <>
              <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-muted" title="Width of the previous-day box; box B is its clone and always the same width">Box breadth</span>
                <select className="compact-field w-[9.5rem] shrink-0" aria-label="Box breadth" value={settings.boxBreadth} onChange={(event) => set({ boxBreadth: event.target.value === "1" ? 1 : event.target.value === "2" ? 2 : 1.5 })}>
                  <option value="1">Standard (±1 day)</option>
                  <option value="1.5">Wide (±1.5 days)</option>
                  <option value="2">Wider (±2 days)</option>
                </select>
              </div>
              <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-muted">Box B position</span>
                <select className="compact-field w-[9.5rem] shrink-0" aria-label="Box B position" value={settings.cloneShift} onChange={(event) => set({ cloneShift: event.target.value === "session" ? "session" : "none" })}>
                  <option value="session">Today&apos;s candles</option>
                  <option value="none">Same as A</option>
                </select>
              </div>
            </>
          ) : null}
          <div className="divide-y divide-border-soft rounded-md border border-border-soft">
            <BoxSection title="Previous-close box" value={settings.closeBox} onChange={(closeBox) => set({ closeBox })} />
            <BoxSection title="Today's-open box" value={settings.openBox} onChange={(openBox) => set({ openBox })} />
            <LevelSection title="9:15 High line" value={settings.high} onChange={(high) => set({ high })} />
            <LevelSection title="9:15 Low line" value={settings.low} onChange={(low) => set({ low })} />
          </div>
        </div>
      </div>

      <footer className={cx("flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2", tab !== "levels" && "hidden")}>
        <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted hover:bg-hover hover:text-text" onClick={() => onChange({ ...STRATEGY_DEFAULTS, enabled: settings.enabled })}><RotateCcw className="h-3.5 w-3.5" aria-hidden />Reset</button>
        <button type="button" className="h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-text" onClick={() => onChange(setAllVisible(settings, true))}>Show all</button>
        <button type="button" className="h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-text" onClick={() => onChange(setAllVisible(settings, false))}>Hide all</button>
        <button type="button" className="ml-auto h-7 rounded-md bg-primary px-3 font-semibold text-on-primary hover:bg-primary-hover" onClick={onClose}>Apply &amp; close</button>
      </footer>
    </section>
  );
}

function signed(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${price(Math.abs(value))}`;
}

/** A date picker with an Auto option: empty value means automatic. */
function DateRow({ label, hint, value, auto, max, onChange }: { label: string; hint: string; value: string; auto: string; max: string; onChange: (value: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-text-2">{label}</span>
        <span className="block text-micro text-muted">{value ? hint : `Auto${auto ? ` · ${auto}` : ""}`}</span>
      </span>
      <input
        type="date"
        aria-label={label}
        className="compact-field w-[8.75rem] shrink-0"
        value={value || auto}
        max={max}
        onChange={(event) => onChange(event.target.value && event.target.value <= max ? event.target.value : "")}
      />
      <button
        type="button"
        aria-pressed={!value}
        title={`Use the automatic ${label.toLowerCase()}`}
        className={cx("h-7 rounded-md px-2 text-micro font-semibold", !value ? "bg-primary-soft text-primary" : "text-muted hover:bg-hover hover:text-text")}
        onClick={() => onChange("")}
      >
        Auto
      </button>
    </div>
  );
}

/** The calendar day before a YYYY-MM-DD date. */
function dayBefore(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function BoxSection({ title, value, onChange }: { title: string; value: StrategyBox; onChange: (next: StrategyBox) => void }) {
  const set = (patch: Partial<StrategyBox>) => onChange({ ...value, ...patch });
  return (
    <details className="group px-2 py-1.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-text-2 hover:text-text">
        <span className="h-3 w-3 rounded-sm border" style={{ borderColor: value.border, background: `${value.fill}55` }} aria-hidden />
        {title}
      </summary>
      <div className="mt-2 grid gap-1.5">
        <Row label="Show box"><Switch label={`Show ${title}`} checked={value.visible} onChange={(visible) => set({ visible })} /></Row>
        <Row label="Border"><Color label={`${title} border colour`} value={value.border} onChange={(border) => set({ border })} /></Row>
        <Row label="Fill"><Color label={`${title} fill colour`} value={value.fill} onChange={(fill) => set({ fill })} /></Row>
        <Row label={`Fill opacity ${Math.round(value.opacity * 100)}%`}>
          <input type="range" min={0} max={50} value={Math.round(value.opacity * 100)} aria-label={`${title} fill opacity`} className="w-[9.5rem] shrink-0" onChange={(event) => set({ opacity: Number(event.target.value) / 100 })} />
        </Row>
        <Row label="Border width"><Width label={`${title} border width`} value={value.width} onChange={(width) => set({ width })} /></Row>
        <Row label="Border style"><Dash label={`${title} border style`} value={value.dash} onChange={(dash) => set({ dash })} /></Row>
        <p className="mt-1 text-micro font-semibold uppercase tracking-wide text-muted">Midpoint line</p>
        <LineRows title={`${title} midpoint`} value={value.mid} onChange={(mid) => set({ mid })} />
      </div>
    </details>
  );
}

function LevelSection({ title, value, onChange }: { title: string; value: StrategyLevel; onChange: (next: StrategyLevel) => void }) {
  return (
    <details className="group px-2 py-1.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-text-2 hover:text-text">
        <span className="h-0.5 w-3 rounded-full" style={{ background: value.color }} aria-hidden />
        {title}
      </summary>
      <div className="mt-2 grid gap-1.5">
        <LineRows title={title} value={value} onChange={(line) => onChange({ ...value, ...line })} />
        <Row label="Price label"><Switch label={`${title} price label`} checked={value.label} onChange={(label) => onChange({ ...value, label })} /></Row>
        <Row label="Extend">
          <select className="compact-field w-[9.5rem] shrink-0" aria-label={`${title} extension`} value={value.extend} onChange={(event) => onChange({ ...value, extend: event.target.value === "session" ? "session" : "right" })}>
            <option value="right">Extend right</option>
            <option value="session">Current session</option>
          </select>
        </Row>
      </div>
    </details>
  );
}

function LineRows({ title, value, onChange }: { title: string; value: StrategyLine; onChange: (next: StrategyLine) => void }) {
  const set = (patch: Partial<StrategyLine>) => onChange({ ...value, ...patch });
  return (
    <>
      <Row label="Show"><Switch label={`Show ${title}`} checked={value.visible} onChange={(visible) => set({ visible })} /></Row>
      <Row label="Colour"><Color label={`${title} colour`} value={value.color} onChange={(color) => set({ color })} /></Row>
      <Row label="Thickness"><Width label={`${title} thickness`} value={value.width} onChange={(width) => set({ width })} /></Row>
      <Row label="Style"><Dash label={`${title} style`} value={value.dash} onChange={(dash) => set({ dash })} /></Row>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-h-7 items-center justify-between gap-2"><span className="min-w-0 truncate text-muted" title={label}>{label}</span>{children}</div>;
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="num text-micro text-muted">{value.toUpperCase()}</span>
      <input type="color" aria-label={label} value={value} className="color-swatch shrink-0 border border-border" onChange={(event) => onChange(event.target.value)} />
    </span>
  );
}

function Width({ label, value, onChange }: { label: string; value: StrategyLine["width"]; onChange: (value: StrategyLine["width"]) => void }) {
  return (
    <select className="compact-field w-[9.5rem] shrink-0" aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value) as StrategyLine["width"])}>
      {WIDTHS.map((width) => <option key={width} value={width}>{width} px</option>)}
    </select>
  );
}

function Dash({ label, value, onChange }: { label: string; value: LineDash; onChange: (value: LineDash) => void }) {
  return (
    <select className="compact-field w-[9.5rem] shrink-0" aria-label={label} value={value} onChange={(event) => onChange(event.target.value as LineDash)}>
      {DASHES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select>
  );
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40", checked ? "bg-primary" : "bg-border-strong")}
      onClick={() => onChange(!checked)}
    >
      <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-e1 transition-[left]", checked ? "left-[1.125rem]" : "left-0.5")} aria-hidden />
    </button>
  );
}

function Toggle({ label, checked, swatch, onChange }: { label: string; checked: boolean; swatch: string; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-text-2">
      <input type="checkbox" className="oc-check" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: swatch }} aria-hidden />
      <span className="truncate">{label}</span>
    </label>
  );
}

function Info({ label, value, text }: { label: string; value?: number | null; text?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className="num truncate font-semibold text-text">{text ?? (value == null ? "—" : price(value))}</dd>
    </div>
  );
}
