"use client";

import { useState } from "react";
import { ColorPicker } from "@/components/color-picker";
import { emptyAppearance, normalizeAppearance, presetAppearance, rememberColor, THEME_PRESETS, toggleFavorite, type Appearance, type ChartPaint, type SavedTheme } from "@/lib/color/appearance";

const GROUPS: Array<{ id: string; label: string; fields: Array<{ key: string; label: string; group: "tokens" | "chart" }> }> = [
  { id: "theme", label: "Application", fields: [
    { key: "background", label: "Background", group: "tokens" },
    { key: "panel", label: "Panels", group: "tokens" },
    { key: "primary", label: "Buttons", group: "tokens" },
    { key: "text", label: "Text", group: "tokens" },
    { key: "muted", label: "Muted text", group: "tokens" },
    { key: "border", label: "Borders", group: "tokens" },
  ] },
  { id: "chart", label: "Chart", fields: [
    { key: "background", label: "Background", group: "chart" },
    { key: "grid", label: "Grid", group: "chart" },
    { key: "crosshair", label: "Crosshair", group: "chart" },
    { key: "text", label: "Price scale", group: "chart" },
    { key: "priceLine", label: "Price line", group: "chart" },
  ] },
  { id: "candles", label: "Candles", fields: [
    { key: "bullBody", label: "Bull body", group: "chart" },
    { key: "bearBody", label: "Bear body", group: "chart" },
    { key: "bullWick", label: "Bull wick", group: "chart" },
    { key: "bearWick", label: "Bear wick", group: "chart" },
    { key: "bullBorder", label: "Bull border", group: "chart" },
    { key: "bearBorder", label: "Bear border", group: "chart" },
    { key: "volumeUp", label: "Up volume", group: "chart" },
    { key: "volumeDown", label: "Down volume", group: "chart" },
  ] },
  { id: "indicators", label: "Indicators", fields: [
    { key: "smaFast", label: "SMA fast", group: "chart" },
    { key: "smaSlow", label: "SMA slow", group: "chart" },
    { key: "ema", label: "EMA", group: "chart" },
    { key: "vwap", label: "VWAP", group: "chart" },
    { key: "bands", label: "Bollinger", group: "chart" },
    { key: "rsi", label: "RSI", group: "chart" },
    { key: "macd", label: "MACD", group: "chart" },
    { key: "macdSignal", label: "MACD signal", group: "chart" },
  ] },
  { id: "trading", label: "Trading", fields: [
    { key: "profit", label: "Profit and buy", group: "tokens" },
    { key: "loss", label: "Loss and sell", group: "tokens" },
    { key: "warning", label: "Pending", group: "tokens" },
    { key: "info", label: "Entry and replay", group: "tokens" },
    { key: "demo", label: "Demo marker", group: "tokens" },
  ] },
];

export function AppearancePanel({ appearance, onChange, onClose }: { appearance: Appearance; onChange: (next: Appearance) => void; onClose: () => void }) {
  const [group, setGroup] = useState(GROUPS[0].id);
  const [openKey, setOpenKey] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const [name, setName] = useState("Custom theme");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const active = GROUPS.find((item) => item.id === group) ?? GROUPS[0];

  function patch(partial: Partial<Appearance>) {
    onChange({ ...appearance, presetId: "custom", ...partial });
  }

  function setField(kind: "tokens" | "chart", key: string, value: string) {
    if (kind === "tokens") patch({ tokens: { ...appearance.tokens, [key]: value } });
    else patch({ chart: { ...appearance.chart, [key]: value } });
  }

  function currentValue(kind: "tokens" | "chart", key: string) {
    return kind === "tokens" ? appearance.tokens[key as keyof Appearance["tokens"]] : appearance.chart[key as keyof ChartPaint] as string;
  }

  function saveCustom() {
    const theme: SavedTheme = { id: `custom-${Date.now()}`, name: name.trim() || "Custom theme", mode: appearance.mode, tokens: appearance.tokens, chart: appearance.chart };
    onChange({ ...appearance, presetId: theme.id, custom: [...appearance.custom, theme] });
    setMessage("Theme saved in this browser.");
  }

  return (
    <aside className="fixed right-3 top-14 z-50 flex max-h-[calc(100vh-4.5rem)] w-[min(23.75rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-panel text-text shadow-xl" aria-label="Appearance">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <div className="text-sm font-semibold">Appearance</div>
          <div className="text-[0.625rem] text-muted">Colour changes stay on this account in this browser.</div>
        </div>
        <button type="button" className="text-xs text-muted" onClick={onClose}>Close</button>
      </div>
      <div className="border-b border-border px-3 py-2">
        <div className="mb-1 h-8 rounded border border-border" style={{ background: appearance.chart.background }}>
          <div className="flex h-full items-end gap-1 px-2">
            <span className="mb-1 h-4 w-2 rounded-sm" style={{ background: appearance.chart.bullBody }} />
            <span className="mb-1 h-3 w-2 rounded-sm" style={{ background: appearance.chart.bearBody }} />
            <span className="mb-1 h-1 flex-1" style={{ background: appearance.chart.smaFast }} />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {THEME_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className={`rounded border px-1.5 py-0.5 text-[0.625rem] ${appearance.presetId === preset.id ? "border-primary text-primary" : "border-border text-muted"}`} onClick={() => onChange(presetAppearance(preset.id, appearance))}>{preset.name}</button>
          ))}
          {appearance.custom.map((preset) => (
            <button key={preset.id} type="button" className={`rounded border px-1.5 py-0.5 text-[0.625rem] ${appearance.presetId === preset.id ? "border-primary text-primary" : "border-border text-muted"}`} onClick={() => onChange({ ...appearance, presetId: preset.id, mode: preset.mode, tokens: preset.tokens, chart: preset.chart })}>{preset.name}</button>
          ))}
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-1">
        {GROUPS.map((item) => <button key={item.id} type="button" className={`shrink-0 rounded px-2 py-1 text-[0.6875rem] ${group === item.id ? "bg-elevated text-text" : "text-muted"}`} onClick={() => { setGroup(item.id); setOpenKey(""); }}>{item.label}</button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {active.fields.map((field) => {
          const value = String(currentValue(field.group, field.key));
          return (
            <div key={field.key} className="relative mb-1">
              <button type="button" className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-elevated" onClick={() => { if (openKey === field.key) setOpenKey(""); else { setSnapshot(value); setOpenKey(field.key); } }}>
                <span className="h-4 w-4 rounded border border-border" style={{ background: value }} />
                <span className="flex-1">{field.label}</span>
                <span className="font-mono text-[0.625rem] text-muted">{value}</span>
              </button>
              {openKey === field.key ? (
                <div className="relative z-10 mt-1">
                  <ColorPicker value={value} recent={appearance.recent} favorites={appearance.favorites} onPreview={(hex) => setField(field.group, field.key, hex)} onApply={(hex) => { onChange(rememberColor({ ...appearance, presetId: "custom", ...(field.group === "tokens" ? { tokens: { ...appearance.tokens, [field.key]: hex } } : { chart: { ...appearance.chart, [field.key]: hex } }) }, hex)); setOpenKey(""); }} onCancel={() => { setField(field.group, field.key, snapshot || value); setOpenKey(""); }} onReset={() => { const base = emptyAppearance(appearance.mode === "light" ? "light" : "classic"); setField(field.group, field.key, String(field.group === "tokens" ? base.tokens[field.key as keyof Appearance["tokens"]] : base.chart[field.key as keyof ChartPaint])); }} onToggleFavorite={(hex) => onChange(toggleFavorite(appearance, hex))} />
                </div>
              ) : null}
            </div>
          );
        })}
        {group === "indicators" ? (
          <div className="mt-2 grid grid-cols-2 gap-2 text-[0.6875rem]">
            <label>Line width
              <input className="mt-1 w-full rounded border border-border bg-elevated px-2 py-1" type="number" min={1} max={4} value={appearance.chart.indicatorWidth} onChange={(event) => patch({ chart: { ...appearance.chart, indicatorWidth: Number(event.target.value) } })} />
            </label>
            <label>Line opacity
              <input className="mt-1 w-full rounded border border-border bg-elevated px-2 py-1" type="number" min={10} max={100} value={Math.round(appearance.chart.indicatorOpacity * 100)} onChange={(event) => patch({ chart: { ...appearance.chart, indicatorOpacity: Number(event.target.value) / 100 } })} />
            </label>
            <label className="col-span-2">Line style
              <select className="mt-1 w-full rounded border border-border bg-elevated px-2 py-1" value={appearance.chart.indicatorStyle} onChange={(event) => patch({ chart: { ...appearance.chart, indicatorStyle: event.target.value === "dashed" || event.target.value === "dotted" ? event.target.value : "solid" } })}>
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
            </label>
          </div>
        ) : null}
        <div className="mt-3 border-t border-border pt-2">
          <label className="text-[0.6875rem] text-muted">Custom theme name
            <input className="mt-1 w-full rounded border border-border bg-elevated px-2 py-1 text-xs" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" className="rounded bg-primary px-2 py-1 text-[0.6875rem] text-on-primary" onClick={saveCustom}>Save theme</button>
            <button type="button" className="rounded border border-border px-2 py-1 text-[0.6875rem]" onClick={() => { const selected = appearance.custom.find((item) => item.id === appearance.presetId); if (!selected) return; onChange({ ...appearance, custom: appearance.custom.map((item) => item.id === selected.id ? { ...item, name: name.trim() || item.name } : item) }); }}>Rename</button>
            <button type="button" className="rounded border border-border px-2 py-1 text-[0.6875rem]" onClick={() => { const selected = [...THEME_PRESETS, ...appearance.custom].find((item) => item.id === appearance.presetId); if (!selected) return; const copy = { ...selected, id: `custom-${Date.now()}`, name: `${selected.name} copy`, tokens: { ...selected.tokens }, chart: { ...selected.chart } }; onChange({ ...appearance, presetId: copy.id, custom: [...appearance.custom, copy] }); }}>Duplicate</button>
            <button type="button" className="rounded border border-border px-2 py-1 text-[0.6875rem]" onClick={() => setConfirm("delete")}>Delete</button>
            <button type="button" className="rounded border border-border px-2 py-1 text-[0.6875rem]" onClick={() => setConfirm("reset")}>Reset</button>
            <button type="button" className="rounded border border-border px-2 py-1 text-[0.6875rem]" onClick={() => download(appearance)}>Export</button>
            <label className="rounded border border-border px-2 py-1 text-[0.6875rem]">Import
              <input className="hidden" type="file" accept="application/json" onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                file.text().then((text) => { const imported = normalizeAppearance(JSON.parse(text)); onChange({ ...imported, recent: appearance.recent, favorites: appearance.favorites }); setMessage("Theme imported."); }).catch(() => setMessage("That file is not a theme."));
              }} />
            </label>
          </div>
          {confirm === "delete" ? <Confirm label="Delete the selected custom theme?" onYes={() => { if (!appearance.custom.some((item) => item.id === appearance.presetId)) { setMessage("Built-in themes stay in the list."); setConfirm(""); return; } onChange({ ...appearance, presetId: "classic", custom: appearance.custom.filter((item) => item.id !== appearance.presetId) }); setConfirm(""); }} onNo={() => setConfirm("")} /> : null}
          {confirm === "reset" ? <Confirm label="Reset colours to Light Professional?" onYes={() => { onChange(emptyAppearance("light")); setConfirm(""); }} onNo={() => setConfirm("")} /> : null}
          {message ? <p className="mt-2 text-[0.625rem] text-muted">{message}</p> : null}
        </div>
      </div>
    </aside>
  );
}

function Confirm({ label, onYes, onNo }: { label: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="mt-2 rounded border border-border bg-elevated p-2 text-[0.6875rem]">
      <p>{label}</p>
      <div className="mt-1 flex gap-1">
        <button type="button" className="rounded bg-loss px-2 py-1 text-on-signal" onClick={onYes}>Confirm</button>
        <button type="button" className="rounded border border-border px-2 py-1" onClick={onNo}>Cancel</button>
      </div>
    </div>
  );
}

function download(appearance: Appearance) {
  const blob = new Blob([JSON.stringify({ presetId: appearance.presetId, mode: appearance.mode, tokens: appearance.tokens, chart: appearance.chart, custom: appearance.custom }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "traded-theme.json";
  link.click();
  URL.revokeObjectURL(url);
}
