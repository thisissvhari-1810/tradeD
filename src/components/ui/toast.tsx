"use client";

import { CheckCircle2, AlertTriangle, Info, X, XCircle } from "lucide-react";
import { cx } from "@/components/ui/cx";

export type ToastTone = "info" | "success" | "error" | "warning";
export type ToastAction = { label: string; onClick: () => void };
export type ToastItem = { id: number; message: string; tone: ToastTone; action?: ToastAction };
export type ToastOptions = { tone?: ToastTone; action?: ToastAction; duration?: number };

const ICON = { info: Info, success: CheckCircle2, error: XCircle, warning: AlertTriangle } as const;
const COLOR = { info: "text-info", success: "text-profit", error: "text-loss", warning: "text-warning" } as const;

export function ToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-[calc(var(--tabbar)+0.75rem)] z-[70] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[22.5rem] lg:bottom-4" aria-live="polite" aria-relevant="additions">
      {items.map((item) => {
        const Icon = ICON[item.tone];
        return (
          <div key={item.id} role={item.tone === "error" ? "alert" : "status"} className="surface-modal anim-rise pointer-events-auto flex w-full items-start gap-2.5 rounded-card px-3.5 py-3 text-dense text-text">
            <Icon className={cx("mt-0.5 h-4 w-4 shrink-0", COLOR[item.tone])} aria-hidden />
            <p className="min-w-0 flex-1 leading-5">{item.message}</p>
            {item.action ? (
              <button type="button" className="shrink-0 rounded-xs px-1.5 py-0.5 text-[0.8125rem] font-semibold text-primary hover:bg-primary/10" onClick={() => { item.action?.onClick(); onDismiss(item.id); }}>
                {item.action.label}
              </button>
            ) : null}
            <button type="button" aria-label="Dismiss" className="grid h-5 w-5 shrink-0 place-items-center rounded-xs text-muted hover:text-text" onClick={() => onDismiss(item.id)}>
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
