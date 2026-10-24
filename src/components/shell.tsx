"use client";

import { useHydrated } from "@/components/use-hydrated";
import type { FeatureKey, Features } from "@/lib/auth/features";
import type { Premium } from "@/lib/premium/entitlements";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Bell, CandlestickChart, ClipboardList, Crown, Eye, FlaskConical, GitBranch, GraduationCap, House, Layers, LineChart, LayoutGrid, Moon, PieChart, Search, Settings, ShieldCheck, Smartphone, Star, Sun, TrendingUp, UsersRound, Wallet, X, type LucideIcon } from "lucide-react";
import { api } from "@/components/api";
import { AppearancePanel } from "@/components/appearance-panel";
import { GlobalSearch } from "@/components/global-search";
import { SymbolSearch } from "@/components/symbol-search";
import { AccountPanel } from "@/components/account-panel";
import { MobileSettingsPanel } from "@/components/mobile-settings";
import { PremiumUpgradeButton, rememberPremiumOrigin } from "@/components/premium/premium-upgrade-button";
import { useMobilePrefs } from "@/components/mobile-prefs";
import { Button, cx, PriceCell, Tooltip, ToastStack, type ToastItem, type ToastOptions } from "@/components/ui";
import { appearanceKey, applyAppearance, emptyAppearance, loadAppearance, presetAppearance, saveAppearance, type Appearance } from "@/lib/color/appearance";

type User = { name: string; email: string; role: string; status: string; tradingEnabled: boolean; features?: Features; premium?: Premium; memberSince?: string | null };
type Health = {
  ok: boolean;
  database: string;
  provider: string;
  marketMode: string;
  marketMessage: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  token: { source: string; expiresAt: string | null; expired: boolean };
};

export type IndexQuote = { name: string; last: number; previous: number | null };

type Desk = {
  user: User | null;
  indices: IndexQuote[];
  indexNote: string;
  health: Health | null;
  mode: "demo" | "live";
  theme: "dark" | "light";
  requestMode: (next: "demo" | "live") => void;
  toast: (message: string, options?: ToastOptions) => void;
  symbol: string;
  chooseSymbol: (symbol: string) => void;
  openChart: (symbol: string) => void;
  online: boolean;
  appearance: Appearance;
  setAppearance: (next: Appearance) => void;
};

const DeskContext = createContext<Desk | null>(null);
/** Saves the current symbol and puts it first in the recent list (no duplicates, at most 8). */
function rememberRecent(symbol: string) {
  try {
    localStorage.setItem("td-symbol", symbol);
    const saved = JSON.parse(localStorage.getItem("td-recent") || "[]") as unknown;
    const recent = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
    localStorage.setItem("td-recent", JSON.stringify([symbol, ...recent.filter((item) => item !== symbol)].slice(0, 8)));
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

/** A localStorage value, or null when storage is unavailable. */
function readStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function useDesk() {
  const value = useContext(DeskContext);
  if (!value) throw new Error("Desk is unavailable.");
  return value;
}

type NavItem = { href: string; label: string; icon: LucideIcon; title?: string; accent?: boolean; feature?: FeatureKey; rail?: false };

const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/chart", label: "Chart", icon: CandlestickChart },
  { href: "/watchlist", label: "Watchlist", icon: Star, rail: false },
  { href: "/options", label: "Options", icon: GitBranch },
  { href: "/academy", label: "Academy", title: "TradeD Academy", icon: GraduationCap },
  { href: "/multi-account", label: "Accounts", title: "Multi-Account Trading", icon: UsersRound, feature: "multiAccount" },
  // rail: false — left out of the desktop sidebar; still in the phone menu, search and the chart's side panel.
  { href: "/positions", label: "Positions", icon: Layers, feature: "portfolio", rail: false },
  { href: "/orders", label: "Orders", icon: ClipboardList, feature: "orderHistory", rail: false },
  { href: "/holdings", label: "Portfolio", icon: PieChart, feature: "portfolio" },
  { href: "/funds", label: "Money", icon: Wallet, feature: "portfolio" },
  { href: "/markets", label: "Markets", icon: LineChart, rail: false },
  { href: "/alerts", label: "Alerts", icon: Bell, rail: false },
  { href: "/prediction", label: "Prediction", icon: TrendingUp, feature: "analytics" },
];

/** The phone's bottom bar: five destinations; everything else is in the header's menu. */
const TAB_BAR: Array<{ href: string; label: string; icon: LucideIcon; feature?: FeatureKey; match: string[] }> = [
  { href: "/", label: "Home", icon: House, match: ["/"] },
  { href: "/watchlist", label: "Watchlist", icon: Star, match: ["/watchlist", "/markets"] },
  { href: "/chart", label: "Trade", icon: CandlestickChart, match: ["/chart", "/terminal", "/options"] },
  { href: "/positions", label: "Positions", icon: Layers, feature: "portfolio", match: ["/positions", "/orders"] },
  { href: "/holdings", label: "Portfolio", icon: PieChart, feature: "portfolio", match: ["/holdings", "/funds"] },
];

const TICKER_LABEL: Record<string, string> = { "Nifty 50": "NIFTY", "Nifty Bank": "BANKNIFTY", "India VIX": "INDIA VIX" };

function inferTone(message: string): ToastOptions["tone"] {
  return /\b(failed|rejected|error|insufficient|cannot|could not|invalid)\b/i.test(message) ? "error" : "info";
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [online, setOnline] = useState(true);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [pendingMode, setPendingMode] = useState<"demo" | "live" | null>(null);
  const [symbol, setSymbol] = useState("RELIANCE");
  const [notes, setNotes] = useState<Array<{ id: string; title: string; body: string; read: boolean }>>([]);
  const [openUser, setOpenUser] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [appearance, setAppearanceState] = useState<Appearance>(() => emptyAppearance("classic"));
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  // The phone Home page's stock search (the same picker the chart opens from its symbol).
  const [homeSearch, setHomeSearch] = useState(false);
  const closeHomeSearch = useCallback(() => setHomeSearch(false), []);
  /** The bottom bar's five destinations show the stock search box in the phone header. */
  const searchTab = path === "/" || ["/watchlist", "/chart", "/positions", "/holdings"].some((href) => path.startsWith(href));
  const mobilePrefs = useMobilePrefs();
  useEffect(() => {
    document.documentElement.dataset.density = mobilePrefs.density;
    document.documentElement.dataset.chartLegend = mobilePrefs.chartLegend ? "on" : "off";
  }, [mobilePrefs.density, mobilePrefs.chartLegend]);
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [indexNote, setIndexNote] = useState("");

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), []);
  const toast = useCallback((message: string, options: ToastOptions = {}) => {
    const id = Date.now() + Math.random();
    const tone = options.tone ?? inferTone(message) ?? "info";
    setToasts((current) => [...current.slice(-3), { id, message, tone, action: options.action }]);
    window.setTimeout(() => dismiss(id), options.duration ?? (tone === "error" ? 7000 : 4500));
  }, [dismiss]);

  const chooseSymbol = useCallback((next: string) => {
    const symbol = next.toUpperCase();
    setSymbol(symbol);
    rememberRecent(symbol);
    if (path.startsWith("/terminal") || path.startsWith("/chart") || path.startsWith("/positions") || path.startsWith("/prediction")) return;
    router.push(`/chart?symbol=${encodeURIComponent(symbol)}`);
  }, [path, router]);

  const openChart = useCallback((next: string) => {
    const symbol = next.toUpperCase();
    setSymbol(symbol);
    // Search results open charts through here: record the pick so it leads the Recent list next time.
    rememberRecent(symbol);
    if (!path.startsWith("/chart")) router.push(`/chart?symbol=${encodeURIComponent(symbol)}`);
  }, [path, router]);

  // The saved symbol and view are restored once the page has hydrated (adjusted during render).
  const hydrated = useHydrated();
  const [restored, setRestored] = useState(false);
  if (hydrated && !restored) {
    setRestored(true);
    const saved = readStored("td-symbol");
    const savedMode = readStored("td-mode");
    if (saved) setSymbol(saved);
    if (savedMode === "live" || savedMode === "demo") setMode(savedMode);
  }

  useEffect(() => {
    api<{ user: User | null }>("/api/session").then((data) => setUser(data.user)).catch(() => setUser(null));
  }, []);

  const appearanceUser = user?.email ?? "";
  const setAppearance = useCallback((next: Appearance) => {
    const saved = saveAppearance(next, appearanceUser);
    applyAppearance(saved);
    localStorage.setItem("td-theme", saved.mode);
    setTheme(saved.mode);
    setAppearanceState(saved);
  }, [appearanceUser]);

  // Each signed-in user's saved appearance is loaded when the user changes (adjusted during render);
  // the effect below applies it to the page.
  const [appearanceFor, setAppearanceFor] = useState<string | null>(null);
  if (hydrated && appearanceFor !== appearanceUser) {
    setAppearanceFor(appearanceUser);
    const stored = readStored(appearanceKey(appearanceUser));
    const savedTheme = readStored("td-theme");
    const current = savedTheme === "light" || savedTheme === "dark" ? savedTheme : document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const next = stored ? loadAppearance(appearanceUser) : presetAppearance(current === "dark" ? "classic" : "light");
    setAppearanceState(next);
    setTheme(next.mode);
  }
  useEffect(() => {
    // Not before the stored appearance is known, so the server-chosen theme does not flash.
    if (appearanceFor !== null) applyAppearance(appearance);
  }, [appearance, appearanceFor]);

  useEffect(() => {
    let stop = false;
    const load = () => {
      api<Health>("/api/health")
        .then((data) => {
          if (stop) return;
          setHealth(data);
          setOnline(true);
        })
        .catch(() => {
          if (!stop) setOnline(false);
        });
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let stop = false;
    const load = () => {
      api<{ indices: IndexQuote[]; message: string }>("/api/market/indices")
        .then((data) => {
          if (stop) return;
          setIndices(data.indices);
          setIndexNote(data.message);
          setOnline(true);
        })
        .catch((error: unknown) => {
          if (!stop) setIndexNote(error instanceof Error ? error.message : "Index prices are unavailable.");
        });
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  // Unread count for the bell and the profile menu: on each page change, when the menu opens, and
  // when the Notifications page marks items read ("td-notes").
  const [notesTick, setNotesTick] = useState(0);
  useEffect(() => {
    const again = () => setNotesTick((value) => value + 1);
    window.addEventListener("td-notes", again);
    return () => window.removeEventListener("td-notes", again);
  }, []);
  useEffect(() => {
    api<{ notifications: Array<{ id: string; title: string; body: string; read: boolean }> }>("/api/alerts")
      .then((data) => setNotes(data.notifications))
      .catch(() => undefined);
  }, [path, openUser, notesTick]);
  const closeUser = useCallback(() => setOpenUser(false), []);

  const [shownPath, setShownPath] = useState(path);
  if (shownPath !== path) {
    setShownPath(path);
    setMenu(false);
    setOpenUser(false);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenUser(false);
        setAppearanceOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<Desk>(() => ({
    user,
    indices,
    indexNote,
    health,
    mode,
    theme,
    requestMode: setPendingMode,
    toast,
    symbol,
    chooseSymbol,
    openChart,
    online,
    appearance,
    setAppearance,
  }), [user, indices, indexNote, health, mode, theme, toast, symbol, chooseSymbol, openChart, online, appearance, setAppearance]);

  const feed = !online
    ? { label: "Disconnected", tone: "bg-loss" }
    : health?.token.expired
      ? { label: "Feed token expired", tone: "bg-warning" }
      : health?.marketMode === "REALTIME" && indices.length
        ? { label: "Live", tone: "bg-profit" }
        : health?.marketMode === "UNAVAILABLE"
          ? { label: "Market data unavailable", tone: "bg-loss" }
          : health?.marketMode === "DELAYED"
            ? { label: "Delayed", tone: "bg-warning" }
            : { label: health ? health.marketMode.toLowerCase() : "Connecting", tone: "bg-muted" };
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const toggleTheme = useCallback(() => setAppearance(presetAppearance(theme === "light" ? "classic" : "light", appearance)), [setAppearance, theme, appearance]);
  // Navigation follows the user's permissions; the server enforces the same rules on every request.
  const links = useMemo<NavItem[]>(() => {
    const allowed = NAV.filter((item) => !item.feature || !user?.features || user.features[item.feature]);
    return user?.role === "SUPER_ADMIN" ? [...allowed, { href: "/admin", label: "Admin", icon: Settings }, { href: "/super-admin", label: "Users", title: "Super Admin", icon: ShieldCheck }] : allowed;
  }, [user]);
  const goTo = useCallback((href: string) => router.push(href), [router]);
  const unreadCount = notes.filter((note) => !note.read).length;
  const unread = unreadCount > 0;

  return (
    <DeskContext.Provider value={value}>
      {/* While the Premium page is open the whole shell takes the Premium theme (tokens.css). */}
      <div className="flex h-dvh min-h-0 bg-background text-text" data-premium-shell={path.startsWith("/premium") ? "" : undefined}>
        <aside className="hidden w-[var(--rail)] shrink-0 flex-col border-r border-border-soft/60 bg-background lg:flex" aria-label="Primary">
          <div className="flex h-[var(--topbar)] shrink-0 items-center justify-center">
            <BrandMark />
          </div>
          <nav className="no-scrollbar flex min-h-0 flex-1 flex-col items-stretch gap-0.5 overflow-y-auto px-2 pb-3 pt-1" aria-label="Main">
            {links.filter((item) => item.rail !== false).map(({ href, label, icon: Icon, title }) => {
              const current = active(href);
              return (
                <Fragment key={href}>
                  {href === "/holdings" || href === "/prediction" || href === "/admin" ? <div className="mx-4 my-2 h-px bg-border-soft [@media(max-height:820px)]:my-1" aria-hidden /> : null}
                  <Link
                    href={href}
                    aria-current={current ? "page" : undefined}
                    aria-label={title}
                    title={title}
                    className={cx(
                      "group relative flex flex-col items-center gap-1 rounded-md px-1 py-2 text-micro font-medium transition-colors duration-150 [@media(max-height:820px)]:gap-0.5 [@media(max-height:820px)]:py-1",
                      current ? "text-text" : "text-muted hover:text-text",
                    )}
                  >
                    {current ? <span className="absolute -left-2 top-1/2 h-6 w-[0.1875rem] -translate-y-1/2 rounded-r-full bg-primary" aria-hidden /> : null}
                    <span className={cx(
                      "relative grid h-8 w-11 place-items-center rounded-input transition-colors duration-150 [@media(max-height:820px)]:h-7",
                      current ? "bg-primary-soft text-primary" : "group-hover:bg-hover",
                    )}>
                      <Icon className="h-5 w-5 shrink-0" aria-hidden />
                    </span>
                    <span className="max-w-full truncate">{label}</span>
                  </Link>
                </Fragment>
              );
            })}
          </nav>
          <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border-soft py-3 [@media(max-height:820px)]:py-1.5">
            <Tooltip side="right" content={theme === "light" ? "Dark theme" : "Light theme"}>
              <button type="button" className="grid h-9 w-9 place-items-center rounded-input text-muted transition-colors hover:bg-hover hover:text-text" aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"} onClick={toggleTheme}>
                {theme === "light" ? <Moon className="h-[1.125rem] w-[1.125rem]" aria-hidden /> : <Sun className="h-[1.125rem] w-[1.125rem]" aria-hidden />}
              </button>
            </Tooltip>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="relative z-30 flex h-[var(--topbar)] shrink-0 items-center gap-2 border-b border-border-soft/60 bg-background/72 px-2 backdrop-blur-xl backdrop-saturate-150 sm:gap-3 sm:px-4">
            <div className="lg:hidden"><BrandMark /></div>
            {/* Phones, on Home, Watchlist, Trade, Positions and Portfolio: one stock search box takes the ticker's place. */}
            {searchTab ? (
              <button
                type="button"
                className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-input border border-border bg-sunken px-3 text-left transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] md:hidden"
                aria-label="Search stocks, indices"
                aria-haspopup="dialog"
                aria-expanded={homeSearch}
                onClick={() => setHomeSearch(true)}
              >
                <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <span className="truncate text-data text-muted"><span className="min-[340px]:hidden">Search</span><span className="max-[339px]:hidden min-[420px]:hidden">Search stocks</span><span className="max-[419px]:hidden">Search stocks, indices…</span></span>
              </button>
            ) : null}
            <div className={cx("no-scrollbar relative flex min-w-0 flex-1 items-center gap-2 overflow-x-auto", searchTab && "max-md:hidden")} aria-label="Index prices">
              {indices.length === 0 ? (
                <span className="truncate text-data text-muted">{indexNote || "Loading index prices…"}</span>
              ) : (indices.some((item) => TICKER_LABEL[item.name]) ? indices.filter((item) => TICKER_LABEL[item.name]) : indices).map((item) => (
                <IndexChip key={item.name} label={TICKER_LABEL[item.name] ?? item.name} last={item.last} previous={item.previous} volatility={item.name === "India VIX"} />
              ))}
              <span className="ml-1 hidden shrink-0 items-center gap-1.5 rounded-pill border border-border-soft px-2.5 py-1 text-micro font-medium text-text-2 2xl:inline-flex" title={health?.marketMessage || feed.label}>
                <span className={cx("h-1.5 w-1.5 rounded-full", feed.tone, feed.label === "Live" && "live-dot text-profit")} aria-hidden />
                {feed.label}
              </span>
            </div>

            <div className={cx("contents", searchTab && "max-md:hidden")}><GlobalSearch pages={links} onSymbol={openChart} onPage={goTo} /></div>

            <PremiumUpgradeButton />

            <Tooltip content={mode === "demo" ? "Simulated orders on your practice account. Click to switch view." : "Read-only broker view. Click to switch back to demo."}>
              <button
                type="button"
                // The same flask mark on every screen size. Live adds a pulsing green "on air" dot.
                className="group relative grid h-9 w-9 shrink-0 place-items-center rounded-input border border-demo/25 bg-[linear-gradient(145deg,var(--demo-soft),color-mix(in_srgb,var(--demo)_16%,var(--demo-soft)))] shadow-e1 transition-[border-color,box-shadow,transform] hover:border-demo/50 hover:shadow-e2 active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100"
                style={{ color: "var(--demo)" }}
                onClick={() => setPendingMode(mode === "demo" ? "live" : "demo")}
                aria-label={mode === "demo" ? "Demo mode. Switch to live view" : "Live view. Switch to demo"}
              >
                <FlaskConical className="h-[1.125rem] w-[1.125rem] transition-transform duration-300 group-hover:-rotate-12 motion-reduce:transition-none motion-reduce:group-hover:transform-none" strokeWidth={2} aria-hidden />
                {mode === "live" ? <span className="live-dot absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-profit text-profit" aria-hidden /> : null}
              </button>
            </Tooltip>

            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip content={unreadCount ? `Notifications (${unreadCount} unread)` : "Notifications"}>
                <Link href="/notifications" aria-current={path.startsWith("/notifications") ? "page" : undefined} className={cx("relative grid h-9 w-9 place-items-center rounded-input transition-colors hover:bg-hover hover:text-text max-sm:hidden", path.startsWith("/notifications") ? "bg-primary-soft text-primary" : "text-muted")} aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}>
                  <Bell className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                  {unreadCount ? <span className="num absolute -right-0.5 -top-0.5 min-w-4 rounded-pill border-2 border-background bg-loss px-1 text-[0.625rem] font-bold leading-3 text-on-signal">{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
                </Link>
              </Tooltip>
              <Tooltip content={theme === "light" ? "Dark theme" : "Light theme"}>
                <button type="button" className="hidden h-9 w-9 place-items-center rounded-input text-muted transition-colors hover:bg-hover hover:text-text sm:grid lg:hidden" aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"} onClick={toggleTheme}>
                  {theme === "light" ? <Moon className="h-[1.125rem] w-[1.125rem]" aria-hidden /> : <Sun className="h-[1.125rem] w-[1.125rem]" aria-hidden />}
                </button>
              </Tooltip>
            </div>

            <button type="button" className="grid h-9 w-9 shrink-0 place-items-center rounded-input text-muted transition-colors hover:bg-hover hover:text-text lg:hidden" aria-label="All pages" aria-expanded={menu} onClick={() => { setMenu(true); setOpenUser(false); }}>
              <LayoutGrid className="h-[1.125rem] w-[1.125rem]" aria-hidden />
            </button>

            <div className="relative shrink-0">
              <button type="button" className="relative grid h-8 w-8 place-items-center rounded-full bg-primary-soft text-dense font-semibold text-primary ring-1 ring-primary/25 transition-shadow hover:ring-primary/50" onClick={() => setOpenUser((value) => !value)} title={user?.email || "Account"} aria-label={unread ? "Account and notifications, unread" : "Account and notifications"} aria-expanded={openUser}>
                {(user?.name || "T").slice(0, 1).toUpperCase()}
                {/* Phones have no bell in the header: unread notifications show on the avatar instead. */}
                {unread ? <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-loss sm:hidden" aria-hidden /> : null}
              </button>
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-hidden pb-[calc(var(--tabbar)+env(safe-area-inset-bottom))] lg:pb-0">{children}</main>
        </div>

        <nav className="fixed inset-x-0 bottom-0 z-30 flex h-[calc(var(--tabbar)+env(safe-area-inset-bottom))] border-t border-border-soft bg-panel/92 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden" aria-label="Main">
          {TAB_BAR.map((item) => {
            if (item.feature && user?.features && !user.features[item.feature]) return null;
            const Icon = item.icon;
            const current = item.match.some((href) => active(href));
            return (
              <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined} className={cx("relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-micro font-medium transition-colors", current ? "text-primary" : "text-muted active:text-text")}>
                {current ? <span className="absolute top-0 h-[0.1875rem] w-8 rounded-b-full bg-primary" aria-hidden /> : null}
                <Icon className="h-[1.375rem] w-[1.375rem]" strokeWidth={current ? 2.1 : 1.8} aria-hidden />
                <span className={cx("max-w-full truncate px-0.5", !mobilePrefs.navLabels && "sr-only")}>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {menu ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button type="button" className="anim-fade absolute inset-0 bg-[var(--scrim)]" aria-label="Close menu" onClick={() => setMenu(false)} />
            <div className="surface-modal anim-sheet absolute inset-x-0 bottom-0 rounded-t-sheet p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" role="dialog" aria-label="All pages">
              <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border-strong" aria-hidden />
              <Link href="/premium" onClick={() => { rememberPremiumOrigin(); setMenu(false); }} className="mb-3 flex items-center gap-3 rounded-card border border-gold/40 bg-gold-soft px-3 py-2.5 text-gold">
                <Crown className="h-5 w-5 shrink-0" aria-hidden />
                {user?.premium?.status === "active"
                  ? <span className="min-w-0 flex-1"><span className="block text-dense font-semibold">Premium</span><span className="block text-micro opacity-80">Active on this account · see plans and status</span></span>
                  : <span className="min-w-0 flex-1"><span className="block text-dense font-semibold">Go Premium</span><span className="block text-micro opacity-80">Strategy overlay and Prediction, from ₹83.25/month</span></span>}
              </Link>
              <p className="eyebrow mb-2 px-1">All pages</p>
              <div className="grid grid-cols-4 gap-1.5">
                {links.map(({ href, label, icon: Icon }) => (
                  <Link key={href} href={href} onClick={() => setMenu(false)} aria-current={active(href) ? "page" : undefined} className={cx("flex flex-col items-center gap-1.5 rounded-md px-1 py-3 text-data font-medium transition-colors", active(href) ? "bg-primary-soft text-primary" : "text-text-2 hover:bg-hover")}>
                    <Icon className="h-5 w-5" aria-hidden />
                    {label}
                  </Link>
                ))}
              </div>
              <div className="mt-4 flex gap-2 border-t border-border-soft pt-4">
                <Button block icon={theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} onClick={toggleTheme}>{theme === "light" ? "Dark theme" : "Light theme"}</Button>
                <Button block icon={<Smartphone className="h-4 w-4" />} onClick={() => { setMenu(false); setMobileSettingsOpen(true); }}>Mobile settings</Button>
                <Button block icon={<X className="h-4 w-4" />} onClick={() => setMenu(false)}>Close</Button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Rendered outside the header: its backdrop blur would trap a fixed panel inside the header bar. */}
        {openUser ? (
          <AccountPanel
            user={user}
            unreadCount={unreadCount}
            theme={theme}
            onToggleTheme={toggleTheme}
            onChartColours={() => { setAppearanceOpen(true); setOpenUser(false); }}
            onMobileSettings={() => { setMobileSettingsOpen(true); setOpenUser(false); }}
            onPremium={() => { setOpenUser(false); rememberPremiumOrigin(); router.push("/premium"); }}
            onSignOut={() => { void api("/api/auth/logout", {}).then(() => { window.location.href = "/login"; }); }}
            onClose={closeUser}
          />
        ) : null}

        <SymbolSearch open={homeSearch} current={{ symbol, exchange: "NSE" }} onSelect={openChart} onClose={closeHomeSearch} />

        <ToastStack items={toasts} onDismiss={dismiss} />


        {mobileSettingsOpen ? <MobileSettingsPanel onClose={() => setMobileSettingsOpen(false)} /> : null}
        {appearanceOpen ? <AppearancePanel appearance={appearance} onChange={setAppearance} onClose={() => setAppearanceOpen(false)} /> : null}

        {pendingMode ? (
          <div className="fixed inset-0 z-[80] grid place-items-center p-4">
            <button type="button" aria-label="Cancel" tabIndex={-1} className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={() => setPendingMode(null)} />
            <div role="dialog" aria-modal="true" aria-label="Switch view" className="surface-modal anim-rise relative w-full max-w-md rounded-sheet p-6">
              <span className={cx("mb-4 grid h-10 w-10 place-items-center rounded-md", pendingMode === "live" ? "bg-warning-soft text-warning" : "bg-demo-soft text-demo")} aria-hidden>
                {pendingMode === "live" ? <Eye className="h-5 w-5" /> : <FlaskConical className="h-5 w-5" />}
              </span>
              <h2 className="text-section font-semibold">Switch to {pendingMode === "live" ? "live view" : "demo"}?</h2>
              <p className="mt-2 text-[0.8125rem] text-text-2">Demo and Live view each have their own ₹1,00,000 practice wallet, with separate positions and history. Live view paper-trades at live prices; nothing is sent to Dhan. Real orders are placed only from Accounts.</p>
              <div className="mt-5 flex justify-end gap-2">
                <Button autoFocus onClick={() => setPendingMode(null)}>Stay</Button>
                <Button variant="primary" onClick={() => { localStorage.setItem("td-mode", pendingMode); setMode(pendingMode); setPendingMode(null); window.location.reload(); }}>Switch</Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </DeskContext.Provider>
  );
}

function BrandMark() {
  return (
    <Link href="/" className="group flex items-center gap-2 rounded-input" aria-label="TradeD home">
      <span className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-[0.6875rem] bg-primary text-on-primary shadow-e2 ring-1 ring-primary/40">
        <span className="absolute inset-0 bg-[linear-gradient(135deg,transparent_40%,var(--demo)_160%)] opacity-60" aria-hidden />
        <Activity className="relative h-[1.125rem] w-[1.125rem]" strokeWidth={2.4} aria-hidden />
      </span>
    </Link>
  );
}

/** Index summary. VIX measures volatility, so its direction is shown without profit or loss colour. */
function IndexChip({ label, last, previous, volatility }: { label: string; last: number; previous: number | null; volatility: boolean }) {
  const change = previous == null ? null : last - previous;
  const pct = previous ? (change! / previous) * 100 : null;
  const direction = change == null || change === 0 ? "flat" : change > 0 ? "up" : "down";
  const tone = volatility || direction === "flat" ? "bg-sunken text-text-2" : direction === "up" ? "bg-profit-soft text-profit" : "bg-loss-soft text-loss";
  const Arrow = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : null;
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 rounded-input bg-panel/70 pl-2.5 pr-1">
      <span className="text-micro font-semibold tracking-[0.04em] text-muted">{label}</span>
      <PriceCell value={last} className="text-dense font-semibold text-text" />
      {change != null && pct != null ? (
        <span className={cx("num inline-flex h-6 items-center gap-0.5 rounded-sm px-1.5 text-micro font-semibold", tone)} title={`${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)} points`}>
          {Arrow ? <Arrow className="h-3 w-3" aria-hidden /> : null}
          <span className="sr-only">{direction === "up" ? "Up" : direction === "down" ? "Down" : "Unchanged"}</span>
          {pct >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%
        </span>
      ) : <span className="px-1.5 text-micro text-muted" title="Change not available yet">–</span>}
    </div>
  );
}
