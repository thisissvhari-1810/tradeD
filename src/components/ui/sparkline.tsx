"use client";

import { useId } from "react";
import { cx, TONE_TEXT, type Tone } from "@/components/ui/cx";

/**
 * Axis-free trend line for real series only. Renders nothing for fewer than two finite points,
 * so callers decide what an unavailable series looks like.
 */
export function Sparkline({ values, tone = "neutral", width = 120, height = 36, area = true, baseline, className, label }: {
  values: number[];
  tone?: Tone;
  width?: number;
  height?: number;
  area?: boolean;
  baseline?: number | null;
  className?: string;
  label?: string;
}) {
  const id = useId().replace(/:/g, "");
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length < 2) return null;
  const pad = 2;
  const low = Math.min(...points, baseline ?? Infinity);
  const high = Math.max(...points, baseline ?? -Infinity);
  const span = high - low || 1;
  const x = (index: number) => pad + (index / (points.length - 1)) * (width - pad * 2);
  const y = (value: number) => pad + (1 - (value - low) / span) * (height - pad * 2);
  const line = points.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(" ");
  const fill = `${line} L${x(points.length - 1).toFixed(2)} ${height} L${x(0).toFixed(2)} ${height} Z`;
  const color = tone === "neutral" ? "text-text-2" : TONE_TEXT[tone];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("block overflow-visible", color, className)}
    >
      {area ? (
        <>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fill} fill={`url(#spark-${id})`} />
        </>
      ) : null}
      {baseline != null && Number.isFinite(baseline) ? (
        <line x1={pad} x2={width - pad} y1={y(baseline)} y2={y(baseline)} stroke="currentColor" strokeOpacity="0.28" strokeDasharray="2 3" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ) : null}
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
