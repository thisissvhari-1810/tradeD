"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Bell, ChevronRight, Crown, LogOut, Moon, Palette, Smartphone, Sun, UserRound, X } from "lucide-react";
import { cx } from "@/components/ui";
import type { Premium } from "@/lib/premium/entitlements";

export type PanelUser = { name: string; email: string; role: string; status: string; premium?: Premium };
export type PanelNote = { id: string; title: string; body: string; read: boolean };

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
 * The account panel behind the avatar: notifications first, then the signed-in user's profile and
 * account actions. On phones it slides in from the right (the header has no bell there); on larger
 * screens it drops down under the avatar.
 */
export function AccountPanel({
  user,
  notes,
  onMarkRead,
  theme,
  onToggleTheme,
  onChartColours,
  onMobileSettings,
  onPremium,
  onSignOut,
  onClose,
}: {
  user: PanelUser | null;
  notes: PanelNote[] | null;
  onMarkRead: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onChartColours: () => void;
  onMobileSettings: () => void;
  onPremium: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const unread = notes?.filter((note) => !note.read).length ?? 0;
  const shown = all ? notes ?? [] : (notes ?? []).slice(0, 3);
  const premium = user?.premium;

  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close account panel" className="anim-fade fixed inset-0 z-40 bg-[var(--scrim)] sm:bg-transparent" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Account"
        className="surface-overlay fixed inset-y-0 right-0 z-50 flex w-[min(22rem,calc(100vw-2.5rem))] flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] anim-fade sm:inset-y-auto sm:right-3 sm:top-[calc(var(--topbar)+0.25rem)] sm:max-h-[calc(100dvh-var(--topbar)-1rem)] sm:w-80 sm:rounded-card sm:pb-0 sm:pt-0"
      >
        <div className="flex items-center justify-between border-b border-border-soft px-4 py-2.5 sm:hidden">
          <span className="text-title font-semibold">Account</span>
          <button type="button" className="grid h-10 w-10 place-items-center rounded-input text-muted hover:bg-hover" aria-label="Close" onClick={onClose}><X className="h-5 w-5" aria-hidden /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* 1. Notifications */}
          <section aria-labelledby="td-panel-notes" className="border-b border-border-soft p-3">
            <div className="flex items-center gap-2 px-1">
              <Bell className="h-4 w-4 text-muted" aria-hidden />
              <h2 id="td-panel-notes" className="flex-1 text-dense font-semibold">Notifications</h2>
              {unread > 0 ? <span className="num rounded-pill bg-loss px-1.5 text-micro font-bold leading-5 text-on-signal" aria-label={`${unread} unread`}>{unread > 9 ? "9+" : unread}</span> : null}
              {unread > 0 ? <button type="button" style={{ color: "var(--primary)" }} className="h-8 rounded-input px-2 text-micro font-medium text-primary hover:bg-hover" onClick={onMarkRead}>Mark all read</button> : null}
            </div>
            {notes === null ? <p className="px-1 pt-2 text-data text-muted">Loading…</p> : null}
            {notes && notes.length === 0 ? <p className="px-1 pt-2 text-data text-muted">You’re all caught up. Price alerts and order updates appear here.</p> : null}
            {shown.length ? (
              <ul className="mt-1.5 space-y-0.5">
                {shown.map((note) => (
                  <li key={note.id} className="flex gap-2 rounded-md px-1.5 py-1.5">
                    <span className={cx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", note.read ? "bg-transparent" : "bg-primary")} aria-hidden />
                    <span className="min-w-0">
                      <span className={cx("block truncate text-data", note.read ? "text-text-2" : "font-semibold text-text")}>{note.title}{note.read ? "" : <span className="sr-only"> (unread)</span>}</span>
                      <span className="line-clamp-2 block text-micro text-muted">{note.body}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {notes && notes.length > 3 ? (
              <button type="button" style={{ color: "var(--primary)" }} className="mt-1 h-9 w-full rounded-input text-data font-medium text-primary hover:bg-hover" aria-expanded={all} onClick={() => setAll((value) => !value)}>{all ? "Show fewer" : `View all ${notes.length}`}</button>
            ) : null}
          </section>

          {/* 2. Profile */}
          <section aria-labelledby="td-panel-profile" className="border-b border-border-soft p-3">
            <h2 id="td-panel-profile" className="sr-only">Profile</h2>
            {user ? (
              <div className="flex items-center gap-3 px-1">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary-soft text-title font-semibold text-primary ring-1 ring-primary/25" aria-hidden>{initials(user.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-dense font-semibold">{user.name || "Signed in"}</span>
                  {user.email ? <span className="block truncate text-data text-muted">{user.email}</span> : null}
                  <span className="mt-1 flex flex-wrap gap-1">
                    <span className="rounded-pill bg-sunken px-2 py-0.5 text-micro font-medium text-text-2">{ROLE_LABEL[user.role] ?? user.role.replace("_", " ").toLowerCase()}</span>
                    {user.status !== "ACTIVE" ? <span className="rounded-pill bg-warning-soft px-2 py-0.5 text-micro font-medium text-warning">{user.status.toLowerCase()}</span> : null}
                    <span className={cx("inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-micro font-medium", premium?.status === "active" ? "bg-gold-soft text-gold" : "bg-sunken text-muted")}>
                      <Crown className="h-3 w-3" aria-hidden />{premiumLabel(premium)}
                    </span>
                  </span>
                </span>
              </div>
            ) : <p className="px-1 text-data text-muted">Loading your profile…</p>}
          </section>

          {/* 3. Account actions */}
          <nav aria-label="Account" className="p-1.5">
            <Row icon={<UserRound className="h-4 w-4" />} label="View profile" href="/profile" onClick={onClose} />
            <Row icon={<Crown className="h-4 w-4 text-gold" />} label={premium?.status === "active" ? "Premium" : "Go Premium"} hint={premiumLabel(premium)} onClick={onPremium} />
            <Row icon={theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} label={theme === "light" ? "Dark theme" : "Light theme"} onClick={onToggleTheme} />
            <Row icon={<Palette className="h-4 w-4" />} label="Chart colours" onClick={onChartColours} />
            <Row icon={<Smartphone className="h-4 w-4" />} label="Mobile & compact mode" onClick={onMobileSettings} />
            <div className="my-1 h-px bg-border-soft" />
            <Row icon={<LogOut className="h-4 w-4" />} label="Sign out" danger onClick={onSignOut} />
          </nav>
        </div>
      </div>
    </>
  );
}

function Row({ icon, label, hint, href, danger, onClick }: { icon: ReactNode; label: string; hint?: string; href?: string; danger?: boolean; onClick: () => void }) {
  const body = (
    <>
      <span className={cx("grid h-5 w-5 place-items-center", danger ? "text-loss" : "text-muted")} aria-hidden>{icon}</span>
      <span className={cx("flex-1 text-left text-dense", danger ? "text-loss" : "text-text-2")}>{label}</span>
      {hint ? <span className="text-micro text-muted">{hint}</span> : null}
      {href ? <ChevronRight className="h-4 w-4 text-muted" aria-hidden /> : null}
    </>
  );
  const className = "flex min-h-11 w-full items-center gap-2.5 rounded-input px-2.5 transition-colors hover:bg-hover sm:min-h-9";
  return href ? <Link href={href} className={className} onClick={onClick}>{body}</Link> : <button type="button" className={className} onClick={onClick}>{body}</button>;
}
