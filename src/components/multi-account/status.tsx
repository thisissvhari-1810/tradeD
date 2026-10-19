import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleMinus, CircleX, Clock, type LucideIcon } from "lucide-react";
import { LEG_LABEL, LEG_TONE, OVERALL_TONE } from "@/components/multi-account/format";
import { cx } from "@/components/ui";
import type { LegStatus, OverallStatus } from "@/lib/multi-account/engine";

const TONE_CHIP = {
  profit: "border-profit/30 bg-profit-soft text-profit",
  loss: "border-loss/30 bg-loss-soft text-loss",
  warning: "border-warning/30 bg-warning-soft text-warning",
  info: "border-info/30 bg-info-soft text-info",
  neutral: "border-border-soft bg-sunken text-text-2",
  primary: "border-primary/30 bg-primary-soft text-primary",
  demo: "border-demo/30 bg-demo-soft text-demo",
} as const;

const LEG_ICON: Record<LegStatus, LucideIcon> = { FILLED: CircleCheck, PARTIAL: CircleDashed, PENDING: Clock, REJECTED: CircleX, CANCELLED: CircleMinus, UNKNOWN: CircleHelp };
const OVERALL_ICON: Record<OverallStatus, LucideIcon> = { Completed: CircleCheck, "Partially Completed": CircleAlert, Failed: CircleX, Pending: Clock };
const OVERALL_SHORT: Record<OverallStatus, string> = { Completed: "Completed", "Partially Completed": "Partial", Failed: "Failed", Pending: "Pending" };

function Chip({ tone, icon: Icon, label, size = "sm" }: { tone: keyof typeof TONE_CHIP; icon: LucideIcon; label: string; size?: "sm" | "md" }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border font-semibold leading-none", size === "md" ? "h-6 px-2 text-data" : "h-5 px-1.5 text-micro", TONE_CHIP[tone])}>
      <Icon className={size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden />
      {label}
    </span>
  );
}

export function LegChip({ status }: { status: LegStatus }) {
  return <Chip tone={LEG_TONE[status]} icon={LEG_ICON[status]} label={LEG_LABEL[status]} />;
}

export function OverallChip({ status, size = "sm" }: { status: OverallStatus; size?: "sm" | "md" }) {
  return <Chip tone={OVERALL_TONE[status]} icon={OVERALL_ICON[status]} label={OVERALL_SHORT[status]} size={size} />;
}

export { OVERALL_SHORT };
