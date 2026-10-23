"use client";

import { cloneElement, isValidElement, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type Side = "top" | "bottom" | "left" | "right";

const PLACE: Record<Side, string> = {
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
  right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
};

/** Shows on hover after a short delay and immediately on keyboard focus. */
export function Tooltip({ content, side = "bottom", children, className }: { content: ReactNode; side?: Side; children: ReactElement<Record<string, unknown>>; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const show = (delay: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setOpen(false);
  };
  const child = isValidElement(children) ? cloneElement(children, { "aria-describedby": open ? id : undefined }) : children;
  return (
    <span className={cx("relative inline-flex", className)} onPointerEnter={() => show(350)} onPointerLeave={hide} onFocus={() => show(0)} onBlur={hide} onKeyDown={(event) => { if (event.key === "Escape") hide(); }}>
      {child}
      {open ? (
        <span id={id} role="tooltip" className={cx("surface-overlay anim-fade pointer-events-none absolute z-[60] flex w-max max-w-[17.5rem] items-center gap-2 whitespace-normal rounded-input px-2.5 py-1.5 text-data text-text", PLACE[side])}>
          {content}
        </span>
      ) : null}
    </span>
  );
}

export function TooltipLabel({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}
