"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export function IconButton({
  label,
  active,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-text active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-40 ${active ? "bg-elevated text-text" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
