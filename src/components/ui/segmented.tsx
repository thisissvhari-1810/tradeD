"use client";

import type { ReactNode } from "react";
import { cx, type Tone } from "@/components/ui/cx";

export type SegmentOption<T extends string> = { id: T; label: ReactNode; tone?: Tone; disabled?: boolean; title?: string };

const ACTIVE: Partial<Record<Tone, string>> = {
  profit: "bg-profit text-on-signal shadow-e1",
  loss: "bg-loss text-on-signal shadow-e1",
  primary: "bg-elevated text-text shadow-e2 ring-1 ring-border",
};

/** Single-choice control. Use tone="profit"/"loss" only for Buy/Sell. */
export function SegmentedControl<T extends string>({ options, value, onChange, label, block = false, size = "md" }: { options: SegmentOption<T>[]; value: T; onChange: (id: T) => void; label: string; block?: boolean; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("inline-flex gap-0.5 rounded-input border border-border-soft bg-sunken p-0.5", block && "flex w-full")}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
            className={cx(
              "inline-flex flex-1 items-center justify-center gap-1 rounded-sm font-semibold transition-[background-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-45",
              size === "sm" ? "h-6 px-2 text-data" : "h-[30px] px-3 text-dense",
              active ? ACTIVE[option.tone ?? "primary"] ?? "bg-elevated text-text shadow-e2 ring-1 ring-border" : "text-muted hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
