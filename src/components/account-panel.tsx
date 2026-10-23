"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { Bell, ChevronRight, Crown, LogOut, Moon, Palette, Smartphone, Sun, UserRound } from "lucide-react";
import { cx } from "@/components/ui";
import type { Premium } from "@/lib/premium/entitlements";

export type PanelUser = { name: string; email: string; role: string; status: string; premium?: Premium };

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: "Super Admin", STUDENT: "Standard user", INSTRUCTOR: "Instructor" };

/** Two letters from the display name; "?" when there is none. */
export function initials(name: string | undefined) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : words[0].slice(0, 2)).toUpperCase();
}

export function premiumLabel(premium: Premium | undefined) {
  if (!premium || premium.status === "free") return "Free plan";
  if (premium.status === "expired") return "Premium ended";
  return premium.via === "role" ? "Premium (included)" : "Premium active";
}

/**
 * The profile menu behind the avatar: a compact rounded card anchored under the avatar on every
 * screen size. The user first, then View profile, Notifications (the full list is its own page),
 * Premium, theme, chart colours, mobile settings and Sign out.
 */
export function AccountPanel({
  user,
  unreadCount,
  theme,
  onToggleTheme,
  onChartColours,
  onMobileSettings,
  onPremium,
  onSignOut,
  onClose,
}: {
  user: PanelUser | null;
  unreadCount: number;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onChartColours: () => void;
  onMobileSettings: () => void;
  onPremium: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const premium = user?.premium;

  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close profile menu" className="fixed inset-0 z-40 cursor-default bg-transparent" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Profile menu"
        className="surface-overlay anim-rise fixed right-2 top-[calc(var(--topbar)+0.25rem+env(safe-area-inset-top))] z-50 flex max-h-[calc(100dvh-var(--topbar)-1rem)] w-[min(19.5rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-[1.375rem] border border-border-soft shadow-e3 sm:right-3"
      >
        <div className="overflow-y-auto overscroll-contain p-1.5">
          {/* 1. Who is signed in */}
          {user ? (
            <div className="flex items-center gap-3 px-2.5 pb-3 pt-2">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-soft text-dense font-semibold text-primary ring-1 ring-primary/25" aria-hidden>{initials(user.name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-dense font-semibold">{user.name || "Signed in"}</span>
                {user.email ? <span className="block truncate text-data text-muted">{user.email}</span> : null}
                <span className="mt-1 flex flex-wrap gap-1">
                  <span className="rounded-pill bg-sunken px-2 py-0.5 text-micro font-medium text-text-2">{ROLE_LABEL[user.role] ?? user.role.replace("_", " ").toLowerCase()}</span>
                  {user.status !== "ACTIVE" ? <span className="rounded-pill bg-warning-soft px-2 py-0.5 text-micro font-medium text-warning">{user.status.toLowerCase()}</span> : null}
                  {premium?.status === "active" ? <span className="inline-flex items-center gap-1 rounded-pill bg-gold-soft px-2 py-0.5 text-micro font-medium text-gold"><Crown className="h-3 w-3" aria-hidden />Premium</span> : null}
                </span>
              </span>
            </div>
          ) : <p className="px-3 py-3 text-data text-muted">Loading your profile…</p>}
          <div className="mx-2 h-px bg-border-soft" />

          {/* 2. Account */}
          <nav aria-label="Account" className="py-1">
            <Row icon={<UserRound className="h-4 w-4" />} label="View profile" href="/profile" chevron onClick={onClose} />
            <Row icon={<Bell className="h-4 w-4" />} label="Notifications" href="/notifications" onClick={onClose} end={unreadCount ? <span className="num rounded-pill bg-loss px-1.5 text-micro font-bold leading-5 text-on-signal" aria-label={`${unreadCount} unread`}>{unreadCount > 9 ? "9+" : unreadCount}</span> : undefined} />
            <Row icon={<Crown className="h-4 w-4 text-gold" />} label="Premium" onClick={onPremium} end={<span className={cx("text-micro", premium?.status === "active" ? "text-gold" : "text-muted")}>{premium?.status === "active" ? (premium.via === "role" ? "Included" : "Active") : premium?.status === "expired" ? "Ended" : "Upgrade"}</span>} />
            <Row icon={theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} label={theme === "light" ? "Dark theme" : "Light theme"} onClick={onToggleTheme} />
            <Row icon={<Palette className="h-4 w-4" />} label="Chart colours" onClick={onChartColours} />
            <Row icon={<Smartphone className="h-4 w-4" />} label="Mobile & compact mode" onClick={onMobileSettings} />
          </nav>
          <div className="mx-2 h-px bg-border-soft" />
          <div className="pt-1">
            <Row icon={<LogOut className="h-4 w-4" />} label="Sign out" danger onClick={onSignOut} />
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ icon, label, end, href, chevron, danger, onClick }: { icon: ReactNode; label: string; end?: ReactNode; href?: string; chevron?: boolean; danger?: boolean; onClick: () => void }) {
  const body = (
    <>
      <span className={cx("grid h-5 w-5 place-items-center", danger ? "text-loss" : "text-muted")} aria-hidden>{icon}</span>
      <span className={cx("flex-1 text-left text-dense", danger ? "text-loss" : "text-text")}>{label}</span>
      {end}
      {chevron ? <ChevronRight className="h-4 w-4 text-muted" aria-hidden /> : null}
    </>
  );
  const className = "flex min-h-11 w-full items-center gap-3 rounded-[0.875rem] px-2.5 transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)] sm:min-h-10";
  return href ? <Link href={href} className={className} onClick={onClick}>{body}</Link> : <button type="button" className={className} onClick={onClick}>{body}</button>;
}
