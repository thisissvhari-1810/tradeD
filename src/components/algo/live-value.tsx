"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui";

/** "+₹1,250.40" / "−₹12.00" / "₹90,934.75" → rupees (null when it is not a money value). */
export function rupeesOf(text: string | null | undefined): number | null {
  if (!text) return null;
  const negative = /^[-−]/.test(text.trim());
  const digits = text.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? (negative ? -value : value) : null;
}

/** ₹ with Indian grouping and two decimals; `signed` adds an explicit + or −. */
export function money(value: number, signed = false) {
  const text = `₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (signed) return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}`;
  return value < 0 ? `−${text}` : text;
}

export const toneOf = (value: number | null | undefined) => (value == null ? "text-muted" : value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-text");

/**
 * A live money figure. It only changes when the value it is given changes (a new replay premium or a
 * ledger update), and then tints green or red for about 200 ms. A missing value reads as unavailable;
 * nothing is ever estimated here.
 */
export function LiveMoney({ value, signed = false, tone = false, className, missing = "Unavailable", suffix }: { value: number | null | undefined; signed?: boolean; tone?: boolean; className?: string; missing?: string; suffix?: string }) {
  const previous = useRef<number | null | undefined>(value);
  const [flash, setFlash] = useState<{ key: number; up: boolean } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before == null || value == null || before === value) return;
    setFlash((current) => ({ key: (current?.key ?? 0) + 1, up: value > before }));
  }, [value]);
  if (value == null || !Number.isFinite(value)) return <span className={cx("text-muted", className)}>{missing}</span>;
  return (
    <span key={flash?.key ?? 0} className={cx("num rounded-sm px-0.5 -mx-0.5 tnum", tone && toneOf(value), flash && (flash.up ? "flash-up-fast" : "flash-down-fast"), className)}>
      {money(value, signed)}{suffix ?? ""}
    </span>
  );
}
