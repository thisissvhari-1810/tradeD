import type { ReactNode } from "react";
import { cx, type Tone } from "@/components/ui/cx";

const TONE: Record<Tone, string> = {
  neutral: "bg-sunken text-text-2",
  primary: "bg-primary-soft text-primary",
  profit: "bg-profit-soft text-profit",
  loss: "bg-loss-soft text-loss",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
  demo: "bg-demo-soft text-demo",
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
    <span title={title} className={cx("inline-flex h-[1.375rem] shrink-0 items-center gap-1.5 rounded-pill px-2 text-micro font-medium leading-none [&_svg]:h-3 [&_svg]:w-3", TONE[tone], className)}>
      {dot ? <span className={cx("h-1.5 w-1.5 rounded-full", DOT[tone])} aria-hidden /> : null}
      {children}
    </span>
  );
}
