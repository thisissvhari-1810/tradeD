import type { ReactNode } from "react";
import { cx, type Tone } from "@/components/ui/cx";

const TONE: Record<Tone, string> = {
  neutral: "bg-sunken text-text-2 border-border",
  primary: "bg-primary-soft text-primary border-primary/25",
  profit: "bg-profit-soft text-profit border-profit/25",
  loss: "bg-loss-soft text-loss border-loss/25",
  warning: "bg-warning-soft text-warning border-warning/30",
  info: "bg-info-soft text-info border-info/25",
  demo: "bg-demo-soft text-demo border-demo/30",
};

const DOT: Record<Tone, string> = {
  neutral: "bg-muted",
  primary: "bg-primary",
  profit: "bg-profit",
  loss: "bg-loss",
  warning: "bg-warning",
  info: "bg-info",
  demo: "bg-demo",
};

export function Badge({ tone = "neutral", children, className, title, dot = false }: { tone?: Tone; children: ReactNode; className?: string; title?: string; dot?: boolean }) {
  return (
    <span title={title} className={cx("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border px-1.5 text-micro font-semibold uppercase leading-none tracking-[0.04em]", TONE[tone], className)}>
      {dot ? <span className={cx("h-1.5 w-1.5 rounded-full", DOT[tone])} aria-hidden /> : null}
      {children}
    </span>
  );
}
