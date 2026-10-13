"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bell,
  CandlestickChart,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  GitBranch,
  House,
  Layers,
  LineChart,
  Menu,
  Moon,
  PieChart,
  Search,
  Sun,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { api, money, tone } from "@/components/api";

type User = { name: string; email: string; role: string; status: string; tradingEnabled: boolean };
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

type Desk = {
  user: User | null;
  health: Health | null;
  mode: "demo" | "live";
  theme: "dark" | "light";
  requestMode: (next: "demo" | "live") => void;
  toast: (message: string) => void;
  symbol: string;
  chooseSymbol: (symbol: string) => void;
  openChart: (symbol: string) => void;
  online: boolean;
};

const DeskContext = createContext<Desk | null>(null);
export function useDesk() {
  const value = useContext(DeskContext);
  if (!value) throw new Error("Desk is unavailable.");
  return value;
}

const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/holdings", label: "Portfolio", icon: PieChart },
  { href: "/positions", label: "Positions", icon: Layers },
  { href: "/orders", label: "Orders", icon: ClipboardList },
  { href: "/funds", label: "Money", icon: Wallet },
  { href: "/markets", label: "Markets", icon: LineChart },
  { href: "/options", label: "Options", icon: GitBranch },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/chart", label: "Chart", icon: CandlestickChart },
  { href: "/prediction", label: "Prediction", icon: TrendingUp },
] as const;

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
  const [openNotes, setOpenNotes] = useState(false);
  const [openUser, setOpenUser] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string }>>([]);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [indices, setIndices] = useState<Array<{ name: string; last: number; previous: number | null }>>([]);
  const [indexNote, setIndexNote] = useState("");

  const toast = useCallback((message: string) => {
    const id = Date.now();
    setToasts((current) => [...current.slice(-3), { id, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200);
  }, []);

  const chooseSymbol = useCallback((next: string) => {
    const symbol = next.toUpperCase();
    setSymbol(symbol);
    localStorage.setItem("td-symbol", symbol);
    const recent = JSON.parse(localStorage.getItem("td-recent") || "[]") as string[];
    localStorage.setItem("td-recent", JSON.stringify([symbol, ...recent.filter((item) => item !== symbol)].slice(0, 8)));
    if (path.startsWith("/terminal") || path.startsWith("/chart") || path.startsWith("/positions") || path.startsWith("/prediction")) return;
    router.push(`/terminal?symbol=${symbol}`);
  }, [path, router]);

  const openChart = useCallback((next: string) => {
    const symbol = next.toUpperCase();
    setSymbol(symbol);
    localStorage.setItem("td-symbol", symbol);
    if (!path.startsWith("/chart")) router.push(`/chart?symbol=${encodeURIComponent(symbol)}`);
  }, [path, router]);

  useEffect(() => {
    const saved = localStorage.getItem("td-symbol");
    const savedMode = localStorage.getItem("td-mode");
    if (saved) setSymbol(saved);
    if (savedMode === "live" || savedMode === "demo") setMode(savedMode);
    const savedTheme = localStorage.getItem("td-theme");
    if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
    else setTheme("light");
    if (localStorage.getItem("td-nav") === "collapsed") setCollapsed(true);
  }, []);

  useEffect(() => {
    api<{ user: User | null }>("/api/session").then((data) => setUser(data.user)).catch(() => setUser(null));
  }, []);

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
      api<{ indices: Array<{ name: string; last: number; previous: number | null }>; message: string }>("/api/market/indices")
        .then((data) => {
          if (stop) return;
          setIndices(data.indices);
          setIndexNote(data.message);
          setOnline(true);
        })
        .catch((error: unknown) => {
          if (!stop) setIndexNote(error instanceof Error ? error.message : "Index feed unavailable.");
        });
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    api<{ notifications: Array<{ id: string; title: string; body: string; read: boolean }> }>("/api/alerts")
      .then((data) => setNotes(data.notifications))
      .catch(() => undefined);
  }, [openNotes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.getElementById("td-search")?.focus();
      }
      if (typing) return;
      if (event.key.toLowerCase() === "b") window.dispatchEvent(new CustomEvent("td-ticket", { detail: "BUY" }));
      if (event.key.toLowerCase() === "s") window.dispatchEvent(new CustomEvent("td-ticket", { detail: "SELL" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<Desk>(() => ({
    user,
    health,
    mode,
    theme,
    requestMode: setPendingMode,
    toast,
    symbol,
    chooseSymbol,
    openChart,
    online,
  }), [user, health, mode, theme, toast, symbol, chooseSymbol, openChart, online]);

  const status = !online ? "disconnected" : health?.token.expired ? "token expired" : indices.length && health?.marketMode === "REALTIME" ? "live" : health?.marketMode === "DEMO" ? "demo data" : health?.marketMode === "UNAVAILABLE" ? "unavailable" : (health?.marketMode ?? "connecting").toLowerCase();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("td-theme", next);
    setTheme(next);
  };
  const toggleNav = () => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem("td-nav", next ? "collapsed" : "expanded");
      return next;
    });
  };
  const navLinks = (showLabel: boolean, onPick?: () => void) => NAV.map(({ href, label, icon: Icon }) => (
    <Link
      key={href}
      href={href}
      title={showLabel ? label : label}
      aria-label={label}
      aria-current={active(href) ? "page" : undefined}
      onClick={onPick}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition hover:bg-elevated active:scale-[0.99] ${active(href) ? "bg-primary/10 font-semibold text-primary" : "text-muted"} ${showLabel ? "" : "justify-center px-0"}`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${active(href) ? "text-primary" : ""}`} aria-hidden />
      {showLabel ? <span>{label}</span> : <span className="sr-only">{label}</span>}
    </Link>
  ));

  return (
    <DeskContext.Provider value={value}>
      <div className="flex h-dvh min-h-0 bg-background">
        <aside className={`hidden shrink-0 flex-col border-r border-border bg-panel transition-[width] duration-200 ease-out lg:flex ${collapsed ? "w-16" : "w-56"}`}>
          <Link href="/" className="m-3 grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-semibold text-white" title="TradeD" aria-label="TradeD home">T</Link>
          <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-2" aria-label="Main">
            {navLinks(!collapsed)}
          </nav>
          <button type="button" className="m-2 grid h-9 place-items-center rounded-xl text-muted hover:bg-elevated hover:text-text" onClick={toggleNav} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} title={collapsed ? "Expand navigation" : "Collapse navigation"}>
            {collapsed ? <ChevronRight className="h-4 w-4" aria-hidden /> : <ChevronLeft className="h-4 w-4" aria-hidden />}
          </button>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-border bg-panel">
          <div className="flex h-12 items-center gap-2 px-3">
            <button type="button" className="grid h-9 w-9 place-items-center rounded-xl text-muted hover:bg-elevated lg:hidden" onClick={() => setMenu(true)} aria-label="Open navigation" title="Open navigation">
              <Menu className="h-4 w-4" aria-hidden />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-6 overflow-x-auto text-[13px]">
              {indices.length === 0 ? <span className="text-xs text-muted">{indexNote || "Loading indices…"}</span> : indices.map((item) => {
                const change = item.previous == null ? null : item.last - item.previous;
                const pct = item.previous ? ((item.last - item.previous) / item.previous) * 100 : null;
                return (
                  <span key={item.name} className="flex shrink-0 items-center gap-2">
                    <span className="text-muted">{item.name}</span>
                    <span className={`num font-medium ${tone(change)}`}>{money(item.last)}</span>
                    {change != null && pct != null ? <span className={`num whitespace-nowrap text-xs ${tone(change)}`}>{change >= 0 ? "+" : ""}{change.toFixed(2)} ({pct.toFixed(2)}%)</span> : null}
                  </span>
                );
              })}
            </div>
            <button type="button" className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-elevated" title="Search instruments" aria-label="Search instruments" onClick={() => {
              const node = document.getElementById("td-search");
              if (node) node.focus();
              else router.push("/");
            }}>
              <Search className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className="relative grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-elevated" title="Notifications" aria-label="Notifications" onClick={() => setOpenNotes((value) => !value)}>
              <Bell className="h-4 w-4" aria-hidden />
              {notes.some((note) => !note.read) ? <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-loss" /> : null}
            </button>
            <button type="button" className={`rounded-full px-2 py-1 text-[10px] font-semibold ${mode === "demo" ? "bg-demo/15 text-demo" : "bg-loss/10 text-loss"}`} onClick={() => setPendingMode(mode === "demo" ? "live" : "demo")} aria-label={mode === "demo" ? "Switch to live view" : "Switch to demo"}>{mode === "demo" ? "DEMO" : "LIVE"}</button>
            <button type="button" className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-elevated" title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"} aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"} onClick={toggleTheme}>
              {theme === "light" ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
            </button>
            <div className="relative">
              <button type="button" className="grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-semibold text-white" onClick={() => setOpenUser((value) => !value)} title={user?.email || "Account"} aria-label="Account menu">{(user?.name || "T").slice(0, 1).toUpperCase()}</button>
              {openUser ? (
                <div className="absolute right-0 top-11 z-30 w-56 rounded-xl border border-border bg-panel p-3 text-xs shadow-lg">
                  <p className="font-medium">{user?.name}</p>
                  <p className="text-muted">{user?.email}</p>
                  <p className="mt-1 text-muted">{user?.role}</p>
                  <button className="mt-3 w-full rounded-lg border border-border py-1.5" onClick={() => { void api("/api/auth/logout", {}).then(() => { window.location.href = "/login"; }); }}>Sign out</button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
        </div>
        {menu ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close navigation" onClick={() => setMenu(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-panel shadow-xl">
              <div className="flex items-center justify-between px-3 py-3">
                <span className="text-sm font-semibold">TradeD</span>
                <button type="button" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-elevated" aria-label="Close navigation" title="Close" onClick={() => setMenu(false)}>
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <nav className="flex flex-col gap-1 px-2" aria-label="Main">
                {navLinks(true, () => setMenu(false))}
              </nav>
            </aside>
          </div>
        ) : null}
        <div className="pointer-events-none fixed bottom-3 right-3 z-40 flex w-72 flex-col gap-2">
          {toasts.map((item) => <div key={item.id} className="pointer-events-auto border border-border bg-panel px-3 py-2 text-xs shadow-lg">{item.message}</div>)}
        </div>
        {openNotes ? (
          <div className="fixed right-3 top-14 z-30 w-80 border border-border bg-panel p-2 shadow-lg">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium">Notifications</span>
              <span className="flex items-center gap-2">
                <button className="text-primary" onClick={() => { void api("/api/alerts", { action: "notification-read" }).then(() => setNotes((current) => current.map((note) => ({ ...note, read: true })))); }}>Mark read</button>
                <button type="button" className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-elevated" aria-label="Close notifications" title="Close" onClick={() => setOpenNotes(false)}><X className="h-4 w-4" aria-hidden /></button>
              </span>
            </div>
            {notes.length === 0 ? <p className="text-xs text-muted">No notifications.</p> : notes.slice(0, 8).map((note) => (
              <div key={note.id} className="border-t border-border py-2 text-xs">
                <p className="font-medium">{note.title}</p>
                <p className="text-muted">{note.body}</p>
              </div>
            ))}
          </div>
        ) : null}
        {pendingMode ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
            <div className="w-full max-w-md border border-border bg-panel p-4">
              <h2 className="text-sm font-semibold">Switch to {pendingMode === "live" ? "live view" : "demo"}?</h2>
              <p className="mt-2 text-xs text-muted">This does not move, cancel, or submit orders. Demo orders stay on the practice ledger. Live view only reads broker account data when the saved token allows it. TradeD does not send orders to the exchange.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button className="border border-border px-3 py-1 text-xs" onClick={() => setPendingMode(null)}>Stay</button>
                <button className="bg-primary px-3 py-1 text-xs text-on-primary" onClick={() => { setMode(pendingMode); localStorage.setItem("td-mode", pendingMode); setPendingMode(null); }}>Switch</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </DeskContext.Provider>
  );
}
