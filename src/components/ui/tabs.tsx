"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "@/components/ui/cx";

export type TabItem<T extends string> = { id: T; label: ReactNode; count?: number; disabled?: boolean; title?: string };

/** Underlined tabs for switching panels. Arrow keys move between tabs. */
export function Tabs<T extends string>({ items, value, onChange, label, className, size = "md" }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void; label: string; className?: string; size?: "sm" | "md" }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (event: KeyboardEvent, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    for (let offset = 1; offset <= items.length; offset += 1) {
      const next = (index + step * offset + items.length) % items.length;
      if (!items[next].disabled) {
        refs.current[next]?.focus();
        onChange(items[next].id);
        return;
      }
    }
  };
  return (
    <div role="tablist" aria-label={label} className={cx("flex items-stretch gap-1 border-b border-border", className)}>
      {items.map((item, index) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            title={item.title}
            onKeyDown={(event) => onKey(event, index)}
            onClick={() => onChange(item.id)}
            className={cx(
              "relative -mb-px inline-flex items-center gap-1.5 font-medium transition-colors duration-150",
              "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:origin-center after:rounded-full after:bg-primary after:transition-transform after:duration-200 after:ease-[var(--ease-ui)]",
              size === "sm" ? "h-8 px-2.5 text-data" : "h-10 px-3 text-dense",
              active ? "text-text after:scale-x-100" : "text-muted after:scale-x-0 hover:text-text",
            )}
          >
            {item.label}
            {item.count != null ? <span className={cx("num rounded-sm px-1.5 text-micro", active ? "bg-primary-soft text-primary" : "bg-sunken text-muted")}>{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
