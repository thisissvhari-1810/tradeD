"use client";

import { Minus, Plus } from "lucide-react";
import { cx } from "@/components/ui/cx";

/** Integer stepper. Keeps the raw text so a user can clear and retype. */
export function Stepper({ value, onChange, min = 1, max = Number.MAX_SAFE_INTEGER, label, invalid, className }: { value: string; onChange: (next: string) => void; min?: number; max?: number; label: string; invalid?: boolean; className?: string }) {
  const parsed = Number(value);
  const current = Number.isInteger(parsed) ? parsed : min;
  const step = (delta: number) => onChange(String(Math.min(max, Math.max(min, current + delta))));
  return (
    <div className={cx("inline-flex h-10 items-stretch overflow-hidden rounded-input border bg-sunken transition-colors focus-within:border-focus-ring", invalid ? "border-loss" : "border-border", className)}>
      <button type="button" aria-label={`Decrease ${label}`} disabled={current <= min} className="grid w-10 place-items-center text-text-2 transition-colors hover:bg-hover hover:text-text disabled:opacity-40" onClick={() => step(-1)}>
        <Minus className="h-4 w-4" aria-hidden />
      </button>
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ""))}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") { event.preventDefault(); step(1); }
          if (event.key === "ArrowDown") { event.preventDefault(); step(-1); }
        }}
        className="stepper-input num w-16 text-center text-title font-semibold"
      />
      <button type="button" aria-label={`Increase ${label}`} disabled={current >= max} className="grid w-10 place-items-center text-text-2 transition-colors hover:bg-hover hover:text-text disabled:opacity-40" onClick={() => step(1)}>
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
