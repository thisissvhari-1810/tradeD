import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

/** Consistent route heading: context, title, optional description, actions on the right, controls below. */
export function PageHeader({ eyebrow, title, description, actions, children, className }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          {eyebrow ? <div className="eyebrow mb-1.5 flex items-center gap-2">{eyebrow}</div> : null}
          <h1 className="text-page font-semibold text-text">{title}</h1>
          {description ? <p className="mt-1.5 max-w-3xl text-dense text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** Titled section inside a page. */
export function Section({ title, description, actions, children, className, bodyClassName, flush = false }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
}) {
  return (
    <section className={cx("surface flex min-w-0 flex-col overflow-hidden", className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-border-soft px-4 py-3">
          <div className="min-w-0 flex-1">
            {title ? <h2 className="text-title font-semibold text-text">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-data text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cx(flush ? "" : "p-4", "min-h-0", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Inline message banner for warnings, errors and context. */
export function Notice({ tone = "info", children, className }: { tone?: "info" | "warning" | "loss" | "neutral"; children: ReactNode; className?: string }) {
  const style = {
    info: "border-info/25 bg-info-soft text-info",
    warning: "border-warning/30 bg-warning-soft text-warning",
    loss: "border-loss/30 bg-loss-soft text-loss",
    neutral: "border-border-soft bg-sunken text-text-2",
  }[tone];
  return <p role={tone === "loss" ? "alert" : undefined} className={cx("rounded-input border px-3 py-2 text-data", style, className)}>{children}</p>;
}
