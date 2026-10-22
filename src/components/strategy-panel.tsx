"use client";

import type { ReactNode } from "react";
import { RotateCcw, X } from "lucide-react";
import { cx } from "@/components/ui";
import type { LineDash } from "@/components/drawing-model";
import { STRATEGY_DEFAULTS, setAllVisible, type StrategyBox, type StrategyLevel, type StrategyLine, type StrategySettings } from "@/components/strategy-settings";
import { price, type StrategyView } from "@/components/strategy-overlay";
import type { S1Data } from "@/lib/trading/s1";

const WIDTHS = [1, 2, 3, 4] as const;
const DASHES: Array<{ id: LineDash; label: string }> = [{ id: "solid", label: "Solid" }, { id: "dashed", label: "Dashed" }, { id: "dotted", label: "Dotted" }];

/**
 * The Strategy panel: on / off, which drawings show, the prices used and every drawing's style.
 * Changes apply to the chart at once and are saved; they never change a calculated price.
 */
export function StrategyPanel({ settings, onChange, data, view, loading, error, disabledReason, onClose }: {
  settings: StrategySettings;
  onChange: (next: StrategySettings) => void;
  data: S1Data | null;
  view: StrategyView | null;
  loading: boolean;
  error: string;
  disabledReason: string;
  onClose: () => void;
}) {
  const set = (patch: Partial<StrategySettings>) => onChange({ ...settings, ...patch });
  const levels = view?.levels ?? null;
  const status = disabledReason
    || (!settings.enabled ? "Turn the strategy on to calculate and draw it." : loading ? "Loading market data…" : error || (view?.failures.length ? `Not drawn: ${view.failures.join(" ")}` : data?.message ?? ""));
  const tone = disabledReason || error || view?.failures.length || data?.status === "unavailable" ? "text-loss" : data?.status === "ready" ? "text-profit" : "text-warning";

  return (
    <section
      className="surface-overlay absolute right-2 top-2 z-40 flex max-h-[calc(100%-1rem)] w-[300px] flex-col overflow-hidden rounded-lg text-data"
      aria-label="Strategy"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 text-dense font-semibold">Strategy</h2>
        <Switch label="Enable strategy" checked={settings.enabled} disabled={Boolean(disabledReason)} onChange={(enabled) => set({ enabled })} />
        <button type="button" aria-label="Close strategy panel" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text" onClick={onClose}><X className="h-4 w-4" aria-hidden /></button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        {status ? <p className={cx("text-micro leading-snug", settings.enabled || disabledReason ? tone : "text-muted")} role="status">{status}</p> : null}

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
            <Info label="Candle range" value={levels?.range} />
            <Info label="Today's open" value={data?.open} />
            <Info label="9:15 high" value={data?.firstMinute?.high} />
            <Info label="9:15 low" value={data?.firstMinute?.low} />
            <Info label="Session" text={data ? `${data.date}${data.previous ? ` · prev ${data.previous.date}` : ""}` : "—"} />
          </dl>
        </div>

        <div>
          <p className="eyebrow mb-1">Drawing settings</p>
          <div className="divide-y divide-border-soft rounded-md border border-border-soft">
            <BoxSection title="Previous-close box" value={settings.closeBox} onChange={(closeBox) => set({ closeBox })} />
            <BoxSection title="Today's-open box" value={settings.openBox} onChange={(openBox) => set({ openBox })} />
            <LevelSection title="9:15 High line" value={settings.high} onChange={(high) => set({ high })} />
            <LevelSection title="9:15 Low line" value={settings.low} onChange={(low) => set({ low })} />
          </div>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
        <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted hover:bg-hover hover:text-text" onClick={() => onChange({ ...STRATEGY_DEFAULTS, enabled: settings.enabled })}><RotateCcw className="h-3.5 w-3.5" aria-hidden />Reset</button>
        <button type="button" className="h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-text" onClick={() => onChange(setAllVisible(settings, true))}>Show all</button>
        <button type="button" className="h-7 rounded-md px-2 text-muted hover:bg-hover hover:text-text" onClick={() => onChange(setAllVisible(settings, false))}>Hide all</button>
        <button type="button" className="ml-auto h-7 rounded-md bg-primary px-3 font-semibold text-on-primary hover:bg-primary-hover" onClick={onClose}>Apply &amp; close</button>
      </footer>
    </section>
  );
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
          <input type="range" min={0} max={50} value={Math.round(value.opacity * 100)} aria-label={`${title} fill opacity`} className="w-28" onChange={(event) => set({ opacity: Number(event.target.value) / 100 })} />
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
          <select className="h-7 py-0 pl-2 pr-6 text-data" aria-label={`${title} extension`} value={value.extend} onChange={(event) => onChange({ ...value, extend: event.target.value === "session" ? "session" : "right" })}>
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
  return <div className="flex items-center justify-between gap-2"><span className="text-muted">{label}</span>{children}</div>;
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="num text-micro text-muted">{value.toUpperCase()}</span>
      <input type="color" aria-label={label} value={value} className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0" onChange={(event) => onChange(event.target.value)} />
    </span>
  );
}

function Width({ label, value, onChange }: { label: string; value: StrategyLine["width"]; onChange: (value: StrategyLine["width"]) => void }) {
  return (
    <select className="h-7 py-0 pl-2 pr-6 text-data" aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value) as StrategyLine["width"])}>
      {WIDTHS.map((width) => <option key={width} value={width}>{width} px</option>)}
    </select>
  );
}

function Dash({ label, value, onChange }: { label: string; value: LineDash; onChange: (value: LineDash) => void }) {
  return (
    <select className="h-7 py-0 pl-2 pr-6 text-data" aria-label={label} value={value} onChange={(event) => onChange(event.target.value as LineDash)}>
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
      <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-e1 transition-[left]", checked ? "left-[18px]" : "left-0.5")} aria-hidden />
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
