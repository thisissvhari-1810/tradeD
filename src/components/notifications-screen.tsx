"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bell, CheckCheck, ChevronRight, RefreshCw } from "lucide-react";
import { api } from "@/components/api";
import { Button, cx, Skeleton } from "@/components/ui";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";

type Note = { id: string; title: string; body: string; read: boolean; createdAt: string; href: string | null };

/** "NIFTY|2026-10-27|22700|CE position closed" → "NIFTY 22,700 CE · 27 Oct position closed" (other text unchanged). */
export function readableTitle(title: string) {
  return title.replace(/[A-Z0-9&-]+\|\d{4}-\d{2}-\d{2}\|\d+(?:\.\d+)?\|(?:CE|PE)/g, (symbol) => {
    const contract = parseOptionLedgerSymbol(symbol);
    if (!contract) return symbol;
    const expiry = new Date(`${contract.expiry}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
    return `${contract.underlying} ${contract.strike.toLocaleString("en-IN")} ${contract.right} · ${expiry}`;
  });
}

function when(iso: string) {
  const date = new Date(iso);
  const zone = { timeZone: "Asia/Kolkata" } as const;
  const today = new Date().toLocaleDateString("en-CA", zone) === date.toLocaleDateString("en-CA", zone);
  return today
    ? `Today, ${date.toLocaleTimeString("en-IN", { ...zone, hour: "2-digit", minute: "2-digit", hour12: false })}`
    : date.toLocaleString("en-IN", { ...zone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Every notification for the signed-in account (latest 100), from /api/alerts. */
export function NotificationsScreen() {
  const router = useRouter();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const load = useCallback(() => {
    api<{ notifications: Note[] }>("/api/alerts")
      .then((data) => { setNotes(data.notifications); setError(""); })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Notifications could not be loaded."));
  }, []);
  useEffect(() => { load(); }, [load]);

  const unread = notes?.filter((note) => !note.read).length ?? 0;
  const shown = (notes ?? []).filter((note) => filter === "all" || !note.read);

  function markAll() {
    void api("/api/alerts", { action: "notification-read" }).then(() => {
      setNotes((current) => current?.map((note) => ({ ...note, read: true })) ?? null);
      window.dispatchEvent(new Event("td-notes"));
    });
  }
  function open(note: Note) {
    if (!note.read) {
      setNotes((current) => current?.map((item) => (item.id === note.id ? { ...item, read: true } : item)) ?? null);
      void api("/api/alerts", { action: "notification-read", id: note.id }).then(() => window.dispatchEvent(new Event("td-notes")));
    }
    if (note.href) router.push(note.href);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-3 p-3 sm:p-6">
        <header className="flex items-center gap-2">
          <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-input text-muted hover:bg-hover hover:text-text" aria-label="Back" onClick={() => (window.history.length > 1 ? router.back() : router.push("/"))}>
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
          <Bell className="h-5 w-5 text-text-2" aria-hidden />
          <h1 className="flex-1 text-section font-semibold">Notifications</h1>
          {unread > 0 ? <span className="num rounded-pill bg-loss px-2 text-data font-bold leading-6 text-on-signal">{unread > 9 ? "9+" : unread} new</span> : null}
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-input bg-sunken p-1" role="tablist" aria-label="Show">
            {(["all", "unread"] as const).map((item) => (
              <button key={item} type="button" role="tab" aria-selected={filter === item} className={cx("h-9 rounded-sm px-3.5 text-data font-medium", filter === item ? "bg-panel text-text shadow-e1" : "text-muted")} onClick={() => setFilter(item)}>
                {item === "all" ? "All" : `Unread${unread ? ` (${unread})` : ""}`}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={load}>Refresh</Button>
          <Button size="sm" variant="ghost" icon={<CheckCheck className="h-4 w-4" />} disabled={!unread} onClick={markAll}>Mark all read</Button>
        </div>

        {error ? <p className="rounded-card border border-loss/30 bg-loss-soft p-3 text-data text-loss" role="alert">{error}</p> : null}
        {notes === null && !error ? <div className="space-y-2">{[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-16 w-full rounded-card" />)}</div> : null}
        {notes && shown.length === 0 ? (
          <div className="surface flex flex-col items-center px-6 py-12 text-center">
            <Bell className="h-6 w-6 text-muted" aria-hidden />
            <p className="mt-2 text-dense font-semibold">{filter === "unread" ? "No unread notifications" : "You are all caught up"}</p>
            <p className="mt-1 text-data text-muted">Price alerts, closed positions and order updates appear here.</p>
          </div>
        ) : null}
        {shown.length ? (
          <ul className="surface divide-y divide-border-soft overflow-hidden">
            {shown.map((note) => <NoteRow key={note.id} note={note} onOpen={() => open(note)} />)}
          </ul>
        ) : null}
        {notes && notes.length >= 100 ? <p className="text-center text-micro text-muted">Showing the latest 100 notifications.</p> : null}
      </div>
    </div>
  );
}

function NoteRow({ note, onOpen }: { note: Note; onOpen: () => void }) {
  // A "Net +₹96.04" amount in the message is coloured by its sign (it comes from the stored text).
  const net = /Net ([+−-]?₹[\d,]+(?:\.\d+)?)/.exec(note.body)?.[1];
  const tone = net ? (net.startsWith("+") ? "text-profit" : "text-loss") : "";
  const at = net ? note.body.indexOf(net) : -1;
  const content = (
    <>
      <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", note.read ? "bg-transparent" : "bg-primary")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className={cx("block text-dense", note.read ? "font-medium text-text-2" : "font-semibold text-text")}>{readableTitle(note.title)}{note.read ? null : <span className="sr-only"> (unread)</span>}</span>
        <span className="mt-0.5 block text-data text-muted">
          {net && at >= 0 ? <>{note.body.slice(0, at)}<span className={cx("num font-semibold", tone)}>{net}</span>{note.body.slice(at + net.length)}</> : note.body}
        </span>
        <span className="mt-1 block text-micro text-muted">{when(note.createdAt)}</span>
      </span>
      {note.href ? <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted" aria-hidden /> : null}
    </>
  );
  const className = cx("flex w-full gap-3 px-4 py-3 text-left", !note.read && "bg-primary/[0.04]");
  return (
    <li>
      {note.href || !note.read
        ? <button type="button" className={cx(className, "hover:bg-hover")} onClick={onOpen}>{content}</button>
        : <div className={className}>{content}</div>}
    </li>
  );
}
