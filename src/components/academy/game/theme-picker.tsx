"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, Eye, X } from "lucide-react";
import { ACADEMY_THEMES, type AcademyTheme } from "@/lib/academy/themes";
import { WORLDS, type WorldDef } from "./worlds/config";
import { roadLayers } from "./winding-road";
import { CircuitRegion } from "./worlds/circuit";
import { CosmosRegion } from "./worlds/cosmos";
import { ExpeditionRegion } from "./worlds/expedition";
import { MetropolisRegion } from "./worlds/metropolis";

const REGIONS = { metropolis: MetropolisRegion, cosmos: CosmosRegion, circuit: CircuitRegion, expedition: ExpeditionRegion } as const;
const NODES = [{ x: 70, y: 214 }, { x: 150, y: 168 }, { x: 236, y: 196 }];

/** A real miniature of a world: its first region's scenery, its road style and three stops. */
export function WorldPreview({ world, className }: { world: WorldDef; className?: string }) {
  const Region = REGIONS[world.id];
  const region = world.region(0);
  const second = world.region(1);
  const road = `M 10 250 C 40 230, 50 220, ${NODES[0].x} ${NODES[0].y} S 120 160, ${NODES[1].x} ${NODES[1].y} S 210 200, ${NODES[2].x} ${NODES[2].y} S 330 150, 400 130`;
  const { base, travelled } = roadLayers(world.road, false);
  return (
    <svg viewBox="0 0 400 250" className={className} role="img" aria-label={`${world.name} preview`} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={`preview-bg-${world.id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={region.ground[0]} />
          <stop offset="1" stopColor={second.ground[1]} />
        </linearGradient>
        <clipPath id={`preview-clip-${world.id}`}><rect width="400" height="250" /></clipPath>
      </defs>
      <g clipPath={`url(#preview-clip-${world.id})`}>
        <rect width="400" height="250" fill={`url(#preview-bg-${world.id})`} />
        <g transform="translate(0 -40)">
          <Region index={0} box={{ top: 0, height: 290, side: "right", nodes: [] }} width={400} wide={false} anchor={{ x: 318, y: 252, scale: 0.42 }} progress={0.6} complete={false} region={region} />
        </g>
        {base.map((layer, index) => <path key={index} d={road} fill="none" stroke={layer.stroke} strokeWidth={layer.width * 0.42} opacity={layer.opacity} strokeDasharray={layer.dash ? layer.dash.split(" ").map((part) => Number(part) * 0.5).join(" ") : undefined} strokeLinecap="round" />)}
        {travelled.slice(0, 1).map((layer, index) => <path key={index} d={`M 10 250 C 40 230, 50 220, ${NODES[0].x} ${NODES[0].y} S 120 160, ${NODES[1].x} ${NODES[1].y}`} fill="none" stroke={layer.stroke} strokeWidth={Math.max(3, layer.width * 0.42)} opacity={layer.opacity} strokeLinecap="round" />)}
        {NODES.map((node, index) => (
          <g key={index} transform={`translate(${node.x} ${node.y})`}>
            <ellipse cy="6" rx="17" ry="7" fill="#000" opacity="0.3" />
            <circle r="15" fill={index < 2 ? "#ffc83d" : region.face[1]} stroke={index < 2 ? "#9a6a00" : region.rim} strokeWidth="3" />
            {index === 2 ? <circle r="21" fill="none" stroke="#fff" strokeWidth="2" opacity="0.8" /> : <path d="M -6 0 L -2 4 L 6 -4" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * "Choose your market world": four worlds as large live previews. Pick one, preview the full map in
 * it, then confirm. The world is only a look: lessons, progress and rewards are the same in each.
 */
export function ThemePicker({ selected, saved, saving, error, onSelect, onPreview, onConfirm, onClose }: {
  selected: AcademyTheme;
  saved: AcademyTheme | null;
  saving: boolean;
  error: string;
  onSelect: (theme: AcademyTheme) => void;
  onPreview: (theme: AcademyTheme) => void;
  onConfirm: (theme: AcademyTheme) => void;
  onClose: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const world = WORLDS[selected];
  return createPortal(
    <div className="mq-picker" role="dialog" aria-modal="true" aria-labelledby="mq-picker-title">
      <div className="mq-picker-inner">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-extrabold uppercase tracking-[0.16em] text-[#38e1ff]">TradeD Academy</p>
            <h2 id="mq-picker-title" className="mt-1 text-[clamp(1.5rem,3.2vw,2.2rem)] font-black leading-tight tracking-tight text-white">Choose your market world</h2>
            <p className="mt-1 text-[14px] text-white/75">The same lessons, progress and rewards in every world. You can change it any time.</p>
          </div>
          <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/10 hover:bg-white/20" style={{ color: "#fff" }} aria-label={saved ? "Close" : "Decide later"} onClick={onClose}><X className="h-5 w-5" aria-hidden /></button>
        </div>
        <div className="mq-picker-grid" role="radiogroup" aria-label="Map worlds">
          {ACADEMY_THEMES.map((id) => {
            const item = WORLDS[id];
            const active = id === selected;
            return (
              <button key={id} ref={active ? first : undefined} type="button" role="radio" aria-checked={active} className="mq-world-card" data-active={active ? "true" : undefined} onClick={() => onSelect(id)}>
                <WorldPreview world={item} className="mq-world-card-art" />
                <span className="flex items-start gap-2 p-3.5 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-black text-white">{item.name}</span>
                    <span className="block text-[12px] font-bold text-[#38e1ff]">{item.tagline}</span>
                    <span className="mt-1 block text-[12.5px] leading-snug text-white/70">{item.description}</span>
                  </span>
                  <span className="mq-world-check" aria-hidden>{active ? <Check className="h-4 w-4" strokeWidth={3.5} /> : null}</span>
                </span>
                {saved === id ? <span className="mq-world-current">Current</span> : null}
              </button>
            );
          })}
        </div>
        {error ? <p className="text-center text-[13px] font-bold text-[#ff9a9a]" role="alert">{error}</p> : null}
        <div className="mq-picker-actions">
          <button type="button" className="ax-btn-ghost mq-ghost-dark" onClick={() => onPreview(selected)}><Eye className="h-5 w-5" aria-hidden />Preview map</button>
          <button type="button" className="ax-btn flex-1 sm:flex-none sm:min-w-64" data-tone="success" disabled={saving} onClick={() => onConfirm(selected)}>{saving ? <><span className="ax-spin" aria-hidden />Saving</> : saved === selected ? `Keep ${world.name}` : `Explore ${world.name}`}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
