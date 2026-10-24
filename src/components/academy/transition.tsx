"use client";

import type { TransitionStyle } from "@/components/academy/game/worlds/config";

export type TransitionRun = { key: number; style: TransitionStyle; intensity: "soft" | "full" | "grand" };

/** How long each strength lasts (ms); the content swaps at `SWAP` of the way through, behind the peak. */
export const TRANSITION_MS: Record<TransitionRun["intensity"], number> = { soft: 680, full: 820, grand: 1100 };
export const SWAP = 0.46;

/**
 * The cinematic between two screens: a layer of the world's weather (clouds, city mist, nebula or a
 * digital scan) sweeps in, covers the change, and parts to reveal the next screen. Purely visual: it
 * never takes pointer events (the lesson locks its own content while it plays) and the parent removes
 * it on a timer, so a failed animation can never block anything.
 */
export function AcademyTransition({ run }: { run: TransitionRun | null }) {
  if (!run) return null;
  const many = run.intensity === "grand" ? 1.6 : run.intensity === "full" ? 1.25 : 1;
  return (
    <div key={run.key} className="ax-xfade" data-style={run.style} data-intensity={run.intensity} style={{ ["--dur" as string]: `${TRANSITION_MS[run.intensity]}ms` }} aria-hidden>
      <div className="ax-xfade-haze" />
      {run.style === "clouds" ? Array.from({ length: Math.round(6 * many) }, (_, index) => (
        <span key={index} className="ax-cloud" style={{ top: `${(index * 37) % 90 - 10}%`, ["--s" as string]: `${0.8 + ((index * 13) % 7) / 10}`, animationDelay: `${(index % 4) * 30}ms` }} />
      )) : null}
      {run.style === "clouds" ? Array.from({ length: Math.round(14 * many) }, (_, index) => <i key={`d${index}`} className="ax-dust" style={{ left: `${(index * 53) % 100}%`, top: `${(index * 29) % 100}%`, animationDelay: `${(index % 5) * 40}ms` }} />) : null}
      {run.style === "mist" ? Array.from({ length: Math.round(16 * many) }, (_, index) => (
        <i key={index} className="ax-bokeh" style={{ left: `${(index * 61) % 100}%`, top: `${(index * 37) % 100}%`, ["--c" as string]: index % 3 === 0 ? "#ffd27a" : index % 3 === 1 ? "#38e1ff" : "#3fe08d", ["--r" as string]: `${18 + (index * 7) % 30}px`, animationDelay: `${(index % 6) * 35}ms` }} />
      )) : null}
      {run.style === "nebula" ? Array.from({ length: Math.round(22 * many) }, (_, index) => (
        <i key={index} className="ax-warp" style={{ ["--a" as string]: `${(index * 360) / Math.round(22 * many)}deg`, animationDelay: `${(index % 5) * 30}ms` }} />
      )) : null}
      {run.style === "scan" ? (
        <>
          <div className="ax-scan-grid" />
          <div className="ax-scan-line" />
          {Array.from({ length: Math.round(8 * many) }, (_, index) => <i key={index} className="ax-data" style={{ top: `${8 + (index * 23) % 84}%`, animationDelay: `${(index % 4) * 45}ms` }} />)}
        </>
      ) : null}
      {run.intensity === "grand" ? <div className="ax-xfade-flare" /> : null}
    </div>
  );
}
