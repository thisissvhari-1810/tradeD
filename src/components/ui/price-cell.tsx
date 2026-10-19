"use client";

import { memo, useEffect, useRef, useState } from "react";
import { cx, signed, TONE_TEXT, toneOf } from "@/components/ui/cx";

function format(value: number, digits: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Tabular price that flashes green or red when the value changes.
 * Pass mode="change" for a signed P&L or change value with an arrow.
 */
export const PriceCell = memo(function PriceCell({ value, digits = 2, mode = "price", prefix = "", flash = true, className, unavailable = "—" }: { value: number | null | undefined; digits?: number; mode?: "price" | "change"; prefix?: string; flash?: boolean; className?: string; unavailable?: string }) {
  const previous = useRef<number | null | undefined>(value);
  const [pulse, setPulse] = useState<"" | "flash-up" | "flash-down">("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (!flash || before == null || value == null || !Number.isFinite(before) || !Number.isFinite(value) || before === value) return;
    setPulse(value > before ? "flash-up" : "flash-down");
    setTick((count) => count + 1);
  }, [value, flash]);

  const valid = value != null && Number.isFinite(value);
  const text = !valid ? unavailable : mode === "change" ? signed(value, digits, prefix) : `${prefix}${format(value, digits)}`;
  const color = mode === "change" && valid ? TONE_TEXT[toneOf(value)] : "";
  return (
    <span key={tick} className={cx("num inline-block rounded-xs px-0.5 tabular-nums", pulse, color, !valid && "text-muted", className)}>
      {text}
    </span>
  );
});
