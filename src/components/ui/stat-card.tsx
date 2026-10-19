import type { ReactNode } from "react";
import { cx, TONE_TEXT, type Tone } from "@/components/ui/cx";

/** Financial metric: label, one prominent value, optional signed delta, trend slot and hint. */
export function StatCard({ label, value, tone = "neutral", delta, deltaTone, hint, size = "md", icon, trend, loading = false, className }: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  delta?: ReactNode;
  deltaTone?: Tone;
  hint?: ReactNode;
  size?: "sm" | "md";
  icon?: ReactNode;
  trend?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={cx("surface min-w-0", size === "sm" ? "px-3.5 py-3" : "px-4 py-3.5", className)}>
      <p className="flex items-center gap-1.5 truncate text-data font-medium text-muted">
        {icon ? <span className="shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5" aria-hidden>{icon}</span> : null}
        {label}
      </p>
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          {loading ? (
            <span aria-hidden className={cx("skel block rounded-sm", size === "sm" ? "h-[22px] w-24" : "h-8 w-32")} />
          ) : (
            <p className={cx("num truncate font-semibold", size === "sm" ? "text-title" : "text-hero", tone === "neutral" ? "text-text" : TONE_TEXT[tone])}>{value}</p>
          )}
          {delta != null && !loading ? <p className={cx("num mt-1 text-data font-medium", TONE_TEXT[deltaTone ?? "neutral"])}>{delta}</p> : null}
        </div>
        {trend ? <div className="shrink-0">{trend}</div> : null}
      </div>
      {hint ? <p className="mt-1.5 text-data text-muted">{hint}</p> : null}
    </div>
  );
}
