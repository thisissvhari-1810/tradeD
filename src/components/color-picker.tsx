"use client";

import { useMemo, useState } from "react";
import { COLOR_FAMILIES, parseColor, parseHex, rgbToHsl, toHex } from "@/lib/color/palette";
import { OPACITY_STOPS } from "@/lib/color/appearance";

type Props = {
  value: string;
  recent?: string[];
  favorites?: string[];
  opacity?: number;
  onPreview: (hex: string) => void;
  onApply: (hex: string) => void;
  onCancel: () => void;
  onReset: () => void;
  onOpacity?: (value: number) => void;
  onToggleFavorite?: (hex: string) => void;
};

export function ColorPicker({ value, recent = [], favorites = [], opacity, onPreview, onApply, onCancel, onReset, onOpacity, onToggleFavorite }: Props) {
  const start = parseColor(value).ok ? parseColor(value) : { ok: true as const, hex: "#4C8DFF" };
  const initial = start.ok ? start.hex : "#4C8DFF";
  const [draft, setDraft] = useState(initial);
  const [hex, setHex] = useState(initial);
  const [error, setError] = useState("");
  const [family, setFamily] = useState(COLOR_FAMILIES[10].id);
  const rgb = parseHex(draft) ?? { r: 76, g: 141, b: 255 };
  const hsl = rgbToHsl(rgb);
  const shades = useMemo(() => COLOR_FAMILIES.find((item) => item.id === family)?.shades ?? [], [family]);

  function choose(next: string) {
    const parsed = parseColor(next);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError("");
    setDraft(parsed.hex);
    setHex(parsed.hex);
    onPreview(parsed.hex);
  }

  return (
    <div className="w-[17.5rem] rounded-md border border-border bg-panel p-2 text-text shadow-lg" role="dialog" aria-label="Colour picker">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-7 w-7 rounded border border-border" style={{ background: draft }} title={draft} />
        <div className="min-w-0 flex-1">
          <div className="text-[0.6875rem] font-semibold">Selected</div>
          <div className="font-mono text-[0.625rem] text-muted">{draft}</div>
        </div>
        {onToggleFavorite ? <button type="button" className="text-[0.625rem] text-primary" onClick={() => onToggleFavorite(draft)}>{favorites.includes(draft) ? "Saved" : "Favourite"}</button> : null}
      </div>
      <div className="mb-2 flex gap-1 overflow-x-auto">
        {COLOR_FAMILIES.map((item) => (
          <button key={item.id} type="button" title={item.name} aria-label={item.name} className={`h-4 w-4 shrink-0 rounded-sm border ${family === item.id ? "border-primary" : "border-transparent"}`} style={{ background: item.shades[4]?.hex }} onClick={() => setFamily(item.id)} />
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1">
        {shades.map((shade) => (
          <button key={shade.hex} type="button" title={`${shade.name} ${shade.hex}`} aria-label={`${shade.name} ${shade.hex}`} className={`h-5 rounded-sm border ${draft === shade.hex ? "border-primary" : "border-border"}`} style={{ background: shade.hex }} onClick={() => choose(shade.hex)} />
        ))}
      </div>
      {favorites.length ? <SwatchRow label="Favourites" colors={favorites} selected={draft} onChoose={choose} /> : null}
      {recent.length ? <SwatchRow label="Recent" colors={recent} selected={draft} onChoose={choose} /> : null}
      <label className="mt-2 block text-[0.625rem] text-muted">HEX
        <input className="mt-1 w-full rounded border border-border bg-elevated px-2 py-1 font-mono text-xs" value={hex} aria-invalid={Boolean(error)} onChange={(event) => { setHex(event.target.value); const parsed = parseColor(event.target.value); if (parsed.ok) choose(parsed.hex); else setError(parsed.error); }} />
      </label>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {(["r", "g", "b"] as const).map((channel) => (
          <label key={channel} className="text-[0.625rem] uppercase text-muted">{channel}
            <input className="mt-1 w-full rounded border border-border bg-elevated px-1 py-1 text-xs" inputMode="numeric" value={rgb[channel]} onChange={(event) => {
              const next = { ...rgb, [channel]: Number(event.target.value) };
              if ([next.r, next.g, next.b].some((item) => !Number.isFinite(item) || item < 0 || item > 255)) setError("RGB channels must be from 0 to 255.");
              else choose(toHex(next));
            }} />
          </label>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {(["h", "s", "l"] as const).map((channel) => (
          <label key={channel} className="text-[0.625rem] uppercase text-muted">{channel}
            <input className="mt-1 w-full rounded border border-border bg-elevated px-1 py-1 text-xs" inputMode="numeric" value={hsl[channel]} onChange={(event) => {
              const next = { ...hsl, [channel]: Number(event.target.value) };
              if (!Number.isFinite(next.h) || next.s < 0 || next.s > 100 || next.l < 0 || next.l > 100) setError("HSL saturation and lightness must be from 0 to 100.");
              else choose(`hsl(${next.h}, ${next.s}%, ${next.l}%)`);
            }} />
          </label>
        ))}
      </div>
      {onOpacity ? (
        <div className="mt-2">
          <div className="mb-1 text-[0.625rem] text-muted">Opacity {Math.round((opacity ?? 1) * 100)}%</div>
          <div className="flex gap-1">
            {OPACITY_STOPS.map((stop) => (
              <button key={stop} type="button" className={`rounded border px-1.5 py-0.5 text-[0.625rem] ${opacity === stop ? "border-primary text-primary" : "border-border text-muted"}`} onClick={() => onOpacity(stop)}>{Math.round(stop * 100)}%</button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-[0.625rem] text-loss" role="alert">{error}</p> : null}
      <div className="mt-2 flex justify-end gap-1">
        <button type="button" className="rounded px-2 py-1 text-[0.6875rem] text-muted" onClick={onReset}>Reset</button>
        <button type="button" className="rounded px-2 py-1 text-[0.6875rem] text-muted" onClick={onCancel}>Cancel</button>
        <button type="button" className="rounded bg-primary px-2 py-1 text-[0.6875rem] text-on-primary" onClick={() => { const parsed = parseColor(draft); if (!parsed.ok) { setError(parsed.error); return; } onApply(parsed.hex); }}>Apply</button>
      </div>
    </div>
  );
}

function SwatchRow({ label, colors, selected, onChoose }: { label: string; colors: string[]; selected: string; onChoose: (hex: string) => void }) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-[0.625rem] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1">
        {colors.map((color) => <button key={color} type="button" title={color} aria-label={color} className={`h-4 w-4 rounded-sm border ${selected === color ? "border-primary" : "border-border"}`} style={{ background: color }} onClick={() => onChoose(color)} />)}
      </div>
    </div>
  );
}
