"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "@/components/ui/cx";

/**
 * Right slide-over on desktop, bottom sheet below the sm breakpoint.
 * Non-modal by default so the chart stays usable; pass modal for a scrim.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  headerExtra,
  footer,
  children,
  width = "w-[23.75rem]",
  modal = false,
  label,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  headerExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  width?: string;
  modal?: boolean;
  label: string;
  className?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus], input, button:not([disabled])");
    first?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restore.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      {modal ? <button type="button" aria-label="Close" tabIndex={-1} className="anim-fade fixed inset-0 z-40 bg-[var(--scrim)]" onClick={onClose} /> : null}
      <aside
        ref={panel}
        role="dialog"
        aria-modal={modal || undefined}
        aria-label={label}
        className={cx(
          "surface-modal fixed z-50 flex flex-col text-text",
          "anim-panel inset-x-0 bottom-0 max-h-[88dvh] rounded-t-sheet border-t",
          "sm:inset-x-auto sm:bottom-2 sm:right-2 sm:top-[calc(var(--topbar)+0.5rem)] sm:max-h-none sm:max-w-[calc(100vw-1rem)] sm:rounded-xl sm:border",
          width,
          "max-sm:w-full",
          className,
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong sm:hidden" aria-hidden />
        <header className="flex items-start gap-3 border-b border-border-soft px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-title font-semibold">{title}</h2>
            {subtitle ? <div className="mt-0.5 text-data text-muted">{subtitle}</div> : null}
          </div>
          {headerExtra}
          <button type="button" aria-label="Close" title="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-input text-muted transition-colors hover:bg-hover hover:text-text" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <footer className="border-t border-border-soft bg-sunken/50 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-b-xl">{footer}</footer> : null}
      </aside>
    </>
  );
}
