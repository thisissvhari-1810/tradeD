"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/components/ui/cx";

type Variant = "primary" | "buy" | "sell" | "secondary" | "tertiary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-on-primary shadow-e1 hover:bg-primary-hover",
  buy: "bg-profit text-on-signal shadow-e1 hover:brightness-110",
  sell: "bg-loss text-on-signal shadow-e1 hover:brightness-110",
  secondary: "border border-border bg-elevated text-text shadow-e1 hover:border-border-strong hover:bg-hover",
  tertiary: "bg-primary-soft text-primary hover:brightness-110",
  ghost: "text-text-2 hover:bg-hover hover:text-text",
  danger: "border border-loss/35 bg-loss-soft/40 text-loss hover:bg-loss-soft",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 gap-1.5 rounded-sm px-2.5 text-data",
  md: "h-[2.125rem] gap-1.5 rounded-input px-3.5 text-dense",
  lg: "h-10 gap-2 rounded-md px-4 text-body",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, block = false, icon, className, children, disabled, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center font-semibold transition-[background-color,border-color,filter,color,transform,box-shadow] duration-150 ease-out active:scale-[0.97] active:duration-[var(--dur-press)] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none disabled:active:scale-100 [&_svg]:shrink-0",
        VARIANT[variant],
        SIZE[size],
        block && "w-full",
        className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cx("inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent", className)} />;
}
